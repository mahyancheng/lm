/**
 * @frontier/simulation — companies/financials.ts
 *
 * The financial phase (`financial_resolution`, phase 11).
 *
 * Recognises revenue and cost, settles interest and cash flow, rolls the balance
 * sheet forward by double entry and runs the invariant from
 * `docs/ECONOMY.md` §5:
 *
 * ```text
 * assets      = cash + ppe + goodwill + investments + receivables
 * liabilities = debt + payables + deferredRevenue
 * INVARIANT:  | assets - liabilities - equity |  <=  $1
 * ```
 *
 * ## How the identity is kept
 *
 * Every movement below is a matched pair. Revenue raises receivables and cash
 * and raises equity by the same amount; a cost lowers cash (or raises payables)
 * and lowers equity; capital movements move an asset and a liability together
 * and leave equity alone. The closing equity is therefore *derived* from the
 * closing balance sheet, and separately *predicted* as `openingEquity +
 * netIncome`. The two must agree to within rounding. If they do not, the engine
 * has a double-entry defect and this module throws with a diagnostic rather than
 * committing a world whose books do not add up.
 *
 * An **opening** sheet that does not reconcile is a different thing: that is bad
 * upstream data, not a defect here. It is *carried*, never absorbed — closing
 * equity is opening equity plus net income, so an imbalance an earlier phase
 * created survives into the closing sheet, fails the `BalanceSheetCheck` and
 * fails `financial_integrity` at the gate. Deriving equity from the closing
 * assets instead would silently mint whatever equity the identity was short,
 * and the quarter would commit on books that do not add up.
 *
 * ## Phase contract with the earlier phases
 *
 * - `talent_resolution` has already written the full quarter payroll into
 *   `financials.payroll`.
 * - `product_demand_resolution` has already written the full quarter marketing
 *   spend into `financials.marketing`.
 * - `research_resolution` leaves the project budgets on the projects; this phase
 *   books them.
 * - Cash is moved **only here**. Government awards create backlog and deferred
 *   revenue earlier; they become cash in this phase.
 */

import type {
  BalanceSheetCheck,
  Company,
  FundingRound,
  ProductSegment,
  ProfitAndLoss,
  ResolverContext,
  SessionState,
  ActiveModifier,
} from '@frontier/contracts';
import { BALANCE_SHEET_TOLERANCE_USD, balanceSheetReconciles, makeId } from '@frontier/contracts';
import {
  BALANCE_ROUNDING_EPSILON_USD,
  BRIDGE_ROUND_COVER_MULTIPLE,
  BRIDGE_ROUND_PREMONEY_DISCOUNT,
  CLOUD_UNIT_COST_USD_PER_QUARTER,
  DEBT_AMORTISATION_PER_QUARTER,
  DEBT_RISK_PREMIUM,
  DISTRESS_HAIRCUT_QUARTERS,
  DISTRESS_VALUATION_HAIRCUT,
  ENERGY_USD_PER_ACCELERATOR_QUARTER,
  PAYABLE_SHARE,
  PPE_DEPRECIATION_PER_QUARTER,
  RECEIVABLE_SHARE,
  RESERVED_UNIT_COST_USD_PER_QUARTER,
  RUNWAY_CAP_QUARTERS,
  RUNWAY_WARNING_QUARTERS,
  SEGMENT_SUPPORT_COST_SHARE,
  TAX_RATE,
} from './balance';
import { resolveDistress } from './distress';
import { policyMarketingUsd, researchEnvelopeUsd } from './policy';
import { sectorEconomy, sectorOf, sustainingCapitalUsd } from '../economy/sectors';
import { companyEnergyCostFactor } from '../economy/regions';
import {
  activeCompanies,
  activeProducts,
  clamp,
  companyActions,
  emitEvent,
  money,
  ratio,
  signedMoney,
  totalHeadcount,
  unit,
  usdLabel,
} from './util';

/** Compute cost decomposition for one company for one quarter. */
export interface ComputeCostBreakdown {
  readonly ownedDepreciationUsd: number;
  readonly reservedUsd: number;
  readonly cloudUsd: number;
  readonly energyUsd: number;
  readonly totalUsd: number;
  readonly servingShare: number;
}

/**
 * `docs/ECONOMY.md` §4:
 *
 * ```text
 * computeCost = ownedAccelerators × depreciationPerQuarter
 *             + reservedAccelerators × reservedRate
 *             + cloudSpendQuarterly × world.compute.spotPrice
 *             + energyDraw × world.energy.electricityPrice
 * ```
 *
 * Depreciation is taken against property, plant and equipment rather than
 * against a unit count, so the non-cash charge always matches an asset the
 * balance sheet actually carries.
 */
export function computeCost(draft: SessionState, company: Company): ComputeCostBreakdown {
  const world = draft.world;
  const compute = company.compute;
  const ownedDepreciation = company.balanceSheet.assets.ppe * PPE_DEPRECIATION_PER_QUARTER;
  const reserved = compute.reservedAccelerators * RESERVED_UNIT_COST_USD_PER_QUARTER * world.compute.reservedPrice;
  const cloud = compute.cloudSpendQuarterly * world.compute.spotPrice;
  const cloudUnits = ratio(compute.cloudSpendQuarterly, CLOUD_UNIT_COST_USD_PER_QUARTER * Math.max(0.1, world.compute.spotPrice));
  const units = compute.ownedAccelerators + compute.reservedAccelerators + cloudUnits;
  // Electricity is the one input whose price is genuinely local: the world index
  // sets the trend, the company's region sets what it actually pays. The regional
  // factor is exactly 1 in world version 1.
  const energy = units * ENERGY_USD_PER_ACCELERATOR_QUARTER * world.energy.electricityPrice * companyEnergyCostFactor(draft, company);
  return {
    ownedDepreciationUsd: ownedDepreciation,
    reservedUsd: reserved,
    cloudUsd: cloud,
    energyUsd: energy,
    totalUsd: ownedDepreciation + reserved + cloud + energy,
    servingShare: 1 - unit(compute.trainingAllocation),
  };
}

/** Contract revenue recognised this quarter: milestones the government phase accepted. */
function contractRevenueUsd(draft: SessionState, ctx: ResolverContext, companyId: string): number {
  let total = 0;
  for (const contract of draft.governmentContracts) {
    if (contract.primeCompanyId !== companyId) continue;
    for (const milestone of contract.milestones) {
      if (milestone.completedQuarter === ctx.quarter && milestone.status !== 'failed') total += milestone.valueUsd;
    }
  }
  return total;
}

/** Standing compliance cost of every live government contract. */
function complianceCostUsd(draft: SessionState, companyId: string): number {
  let total = 0;
  for (const contract of draft.governmentContracts) {
    if (contract.primeCompanyId !== companyId || contract.status !== 'active') continue;
    total += contract.complianceBurdenQuarterlyUsd;
  }
  return total;
}

/** Research cash committed to active programmes this quarter. */
function projectBudgetUsd(draft: SessionState, companyId: string): number {
  let total = 0;
  for (const project of draft.researchProjects) {
    if (project.companyId !== companyId || project.status !== 'active') continue;
    total += project.budgetQuarterly;
  }
  return total;
}

/** Register the distress haircut the market phase will price next quarter. */
function registerDistressHaircut(draft: SessionState, ctx: ResolverContext, companyId: string): void {
  const id = makeId('mod', draft.sessionId, ctx.quarter, 'distress', companyId);
  if (draft.activeModifiers.some((m) => m.id === id)) return;
  const modifier: ActiveModifier = {
    id,
    source: 'system',
    target: `company.${companyId}.valuationSentiment`,
    operation: 'add',
    value: -DISTRESS_VALUATION_HAIRCUT,
    decay: 'linear',
    durationQuarters: DISTRESS_HAIRCUT_QUARTERS,
    remainingQuarters: DISTRESS_HAIRCUT_QUARTERS,
    appliedAtQuarter: ctx.quarter,
    originEventId: null,
    reason: 'The company could not settle its obligations in cash and is being financed by its suppliers.',
    elapsedQuarters: 0,
    effectiveValue: -DISTRESS_VALUATION_HAIRCUT,
    lastAppliedQuarter: null,
    exhausted: false,
  };
  draft.activeModifiers.push(modifier);
}

/**
 * Queue the emergency financing `resolveDistress` settles at the top of next
 * quarter's financial phase. The round is created `open`, not `closed`: this
 * phase does not decide that anybody funded it, only that the company now needs
 * somebody to.
 */
function queueBridgeRound(draft: SessionState, ctx: ResolverContext, company: Company, shortfallUsd: number): FundingRound | null {
  const existing = draft.fundingRounds.find((r) => r.companyId === company.id && r.stage === 'bridge' && r.status === 'open');
  if (existing !== undefined) return null;
  const capTable = draft.capTables.find((c) => c.companyId === company.id);
  const shareClassId = capTable?.shareClasses[0]?.id ?? makeId('shc', company.id, 'common');
  const shares = capTable?.fullyDilutedShares ?? 0;
  const metrics = draft.companyMetrics.find((m) => m.companyId === company.id);
  const marketCap = metrics?.marketCapUsd ?? 0;
  const enterprise = metrics?.enterpriseValueUsd ?? 0;
  const lastValuation = marketCap > 0 ? marketCap : enterprise > 0 ? enterprise : company.financials.revenueQuarterly * 8;
  const preMoney = money(Math.max(1, lastValuation * (1 - BRIDGE_ROUND_PREMONEY_DISCOUNT)));
  const amount = money(shortfallUsd * BRIDGE_ROUND_COVER_MULTIPLE);
  const round: FundingRound = {
    id: makeId('rnd', draft.sessionId, ctx.quarter, 'bridge', company.id),
    companyId: company.id,
    stage: 'bridge',
    amount,
    preMoney,
    postMoney: money(preMoney + amount),
    dilution: unit(ratio(amount, preMoney + amount)),
    pricePerShareUsd: shares > 0 ? money(preMoney / shares) : 0,
    shareClassId,
    leadInvestorCharacterId: null,
    participantHolderIds: [],
    boardSeatsGranted: 0,
    closedQuarter: ctx.quarter,
    status: 'open',
  };
  draft.fundingRounds.push(round);
  return round;
}

/**
 * Recognise revenue and cost, settle cash and debt, roll the balance sheet
 * forward and check the invariant for every active company.
 */
export function resolveFinancials(
  draft: SessionState,
  ctx: ResolverContext,
): { pnl: ProfitAndLoss[]; balanceChecks: BalanceSheetCheck[] } {
  const pnl: ProfitAndLoss[] = [];
  const balanceChecks: BalanceSheetCheck[] = [];

  // Last quarter's forced bridges are settled before this quarter's obligations
  // are, so rescue cash is on the balance sheet when the bills are paid.
  resolveDistress(draft, ctx);

  // Computed once, ahead of the loop: it walks every company. Neutral in v1.
  const economy = sectorEconomy(draft);

  for (const company of activeCompanies(draft)) {
    const actions = companyActions(draft, ctx, company.id);
    const sheet = company.balanceSheet;
    const openingAssets =
      sheet.assets.cash + sheet.assets.ppe + sheet.assets.goodwill + sheet.assets.investments + sheet.assets.receivables;
    const openingLiabilities = sheet.liabilities.debt + sheet.liabilities.payables + sheet.liabilities.deferredRevenue;
    const openingResidual = openingAssets - openingLiabilities - sheet.equity;
    const openingReconciles = Math.abs(openingResidual) <= BALANCE_SHEET_TOLERANCE_USD;

    /* --- revenue ---------------------------------------------------------- */
    const revenueBySegment = new Map<ProductSegment, number>();
    let productRevenue = 0;
    let supportCost = 0;
    for (const product of activeProducts(company)) {
      const revenue = product.activeCustomers * product.pricePerSeat;
      productRevenue += revenue;
      supportCost += revenue * SEGMENT_SUPPORT_COST_SHARE[product.segment];
      revenueBySegment.set(product.segment, (revenueBySegment.get(product.segment) ?? 0) + revenue);
    }
    const contractRevenue = contractRevenueUsd(draft, ctx, company.id);
    if (contractRevenue > 0) {
      revenueBySegment.set('government', (revenueBySegment.get('government') ?? 0) + contractRevenue);
      supportCost += contractRevenue * SEGMENT_SUPPORT_COST_SHARE.government;
    }
    const revenue = productRevenue + contractRevenue;

    /* --- cost ------------------------------------------------------------- */
    const compute = computeCost(draft, company);
    const servingCompute = compute.totalUsd * compute.servingShare;
    const trainingCompute = compute.totalUsd - servingCompute;
    const compliance = complianceCostUsd(draft, company.id);
    const depreciation = Math.min(sheet.assets.ppe, compute.ownedDepreciationUsd);

    // The sector's own cost weather: energy pass-through upward, AI productivity
    // downward, plus the sustaining capital a capital-intensive sector owes just
    // to stand still. Both are zero in world version 1.
    //
    // The adjustment is applied to the *cash* part of cost only. Depreciation is
    // a charge against an asset the balance sheet already carries; scaling it
    // would invent property, so it is excluded and the cash-flow split below
    // continues to subtract exactly the depreciation that was booked.
    const sector = economy[sectorOf(company)];
    const depreciationInCogs = depreciation * compute.servingShare;
    const cashCogsBeforeSector = Math.max(0, servingCompute - depreciationInCogs) + supportCost + compliance;
    const sectorCostAdjustment =
      (sector.inputCostMultiplier - 1) * cashCogsBeforeSector + sustainingCapitalUsd(sector, revenue);
    const cogs = servingCompute + supportCost + compliance + sectorCostAdjustment;

    // Payroll and marketing were staged by the talent and product phases. The
    // fallbacks below only bite when this phase is run in isolation.
    const payroll = Math.max(company.financials.payroll, (totalHeadcount(company) * company.employees.avgComp) / 4);
    const marketing = Math.max(company.financials.marketing, policyMarketingUsd(company));

    const envelope = researchEnvelopeUsd(company, actions);
    const projectBudgets = projectBudgetUsd(draft, company.id);
    const rdSpend = Math.max(projectBudgets, envelope) + trainingCompute;

    const debtRate = (draft.world.macro.policyRate + draft.world.macro.creditSpreads + DEBT_RISK_PREMIUM) / 4;
    const interestExpense = sheet.liabilities.debt * debtRate;

    const grossProfit = revenue - cogs;
    const operatingExpenses = payroll + marketing + rdSpend;
    const operatingIncome = grossProfit - operatingExpenses;
    const preTax = operatingIncome - interestExpense;
    const tax = preTax > 0 ? preTax * TAX_RATE : 0;
    const netIncome = preTax - tax;

    /* --- working capital and cash ----------------------------------------- */
    const openingReceivables = sheet.assets.receivables;
    const openingPayables = sheet.liabilities.payables;
    const openingDeferred = sheet.liabilities.deferredRevenue;
    const openingCash = sheet.assets.cash;

    // Contracted revenue billed in advance is released from deferred revenue and
    // brings no cash with it; everything else is billed this quarter.
    const deferredRelease = Math.min(openingDeferred, contractRevenue);
    const billed = revenue - deferredRelease;
    const closingReceivables = billed * RECEIVABLE_SHARE;
    const collections = openingReceivables + billed - closingReceivables;

    // Depreciation is the only non-cash charge, and it is split across the two
    // buckets the compute cost was split into. Both halves must be excluded from
    // the cash that actually leaves. `depreciationInCogs` was computed with the
    // sector adjustment above, which is deliberately cash-only for this reason.
    const depreciationInRd = depreciation - depreciationInCogs;
    const cogsCash = Math.max(0, cogs - depreciationInCogs);
    const rdCash = Math.max(0, rdSpend - depreciationInRd);
    const closingPayablesBase = cogsCash * PAYABLE_SHARE;
    const cogsCashPaid = openingPayables + cogsCash - closingPayablesBase;

    const debtRepayment = Math.min(sheet.liabilities.debt, sheet.liabilities.debt * DEBT_AMORTISATION_PER_QUARTER);
    const cashOut = cogsCashPaid + payroll + marketing + rdCash + interestExpense + tax + debtRepayment;
    const unfloored = openingCash + collections - cashOut;
    const shortfall = unfloored < 0 ? -unfloored : 0;
    const closingCash = Math.max(0, unfloored);
    const closingPayables = closingPayablesBase + shortfall;

    /* --- roll the balance sheet forward ----------------------------------- */
    sheet.assets.cash = money(closingCash);
    sheet.assets.receivables = money(closingReceivables);
    sheet.assets.ppe = money(Math.max(0, sheet.assets.ppe - depreciation));
    sheet.liabilities.payables = money(closingPayables);
    sheet.liabilities.deferredRevenue = money(Math.max(0, openingDeferred - deferredRelease));
    sheet.liabilities.debt = money(Math.max(0, sheet.liabilities.debt - debtRepayment));

    const closingAssets =
      sheet.assets.cash + sheet.assets.ppe + sheet.assets.goodwill + sheet.assets.investments + sheet.assets.receivables;
    const closingLiabilities = sheet.liabilities.debt + sheet.liabilities.payables + sheet.liabilities.deferredRevenue;
    const derivedEquity = signedMoney(closingAssets - closingLiabilities);
    const predictedEquity = signedMoney(sheet.equity + netIncome + openingResidual);
    const defect = derivedEquity - predictedEquity;
    if (Math.abs(defect) > BALANCE_ROUNDING_EPSILON_USD) {
      throw new Error(
        `financial_resolution double-entry defect for ${company.id} (${company.name}) in quarter ${ctx.quarter}: ` +
          `derived equity ${derivedEquity} but movements imply ${predictedEquity} ` +
          `(net income ${signedMoney(netIncome)}, opening residual ${signedMoney(openingResidual)}, defect ${signedMoney(defect)}). ` +
          `revenue=${money(revenue)} cogs=${money(cogs)} opex=${money(operatingExpenses)} interest=${money(interestExpense)} tax=${money(tax)} ` +
          `collections=${money(collections)} cashOut=${money(cashOut)} shortfall=${money(shortfall)}`,
      );
    }
    // Closing equity is opening equity plus net income, with sub-cent rounding
    // absorbed. When the opening sheet reconciled this is exactly the derived
    // equity; when it did not, the residual is carried rather than laundered, so
    // the closing sheet still fails to reconcile and the quarter cannot commit.
    sheet.equity = signedMoney(derivedEquity - openingResidual);

    /* --- financials record ------------------------------------------------- */
    const quarterlyBurn = signedMoney(sheet.assets.cash - openingCash);
    const workingCapitalMove =
      sheet.assets.receivables - openingReceivables - (sheet.liabilities.payables - openingPayables) - (sheet.liabilities.deferredRevenue - openingDeferred);
    // Capital expenditure is booked by the phase that incurs it, which moves
    // cash into property, plant and equipment directly; this phase adds none.
    const capex = 0;
    const freeCashFlow = signedMoney(netIncome + depreciation - capex - workingCapitalMove);

    let backlog = 0;
    for (const contract of draft.governmentContracts) {
      if (contract.primeCompanyId !== company.id || contract.status !== 'active') continue;
      backlog += Math.max(0, contract.totalValueUsd - contract.recognisedToDateUsd);
    }

    company.financials = {
      revenueQuarterly: money(revenue),
      cogs: money(cogs),
      payroll: money(payroll),
      marketing: money(marketing),
      rdSpend: money(rdSpend),
      capex,
      interestExpense: money(interestExpense),
      cash: sheet.assets.cash,
      debt: sheet.liabilities.debt,
      quarterlyBurn,
      deferredRevenue: sheet.liabilities.deferredRevenue,
      backlogUsd: money(backlog),
    };

    const segments: ProfitAndLoss['revenueBySegment'] = [];
    for (const [segment, value] of revenueBySegment) segments.push({ segment, revenue: money(value) });
    segments.sort((a, b) => (a.segment < b.segment ? -1 : a.segment > b.segment ? 1 : 0));

    pnl.push({
      companyId: company.id,
      quarter: ctx.quarter,
      revenue: money(revenue),
      grossProfit: signedMoney(grossProfit),
      operatingExpenses: money(operatingExpenses),
      operatingIncome: signedMoney(operatingIncome),
      netIncome: signedMoney(netIncome),
      freeCashFlow,
      revenueBySegment: segments,
    });

    /* --- ledger ------------------------------------------------------------ */
    const revenueEventId = emitEvent(
      draft,
      ctx,
      'revenue_recognised',
      company.id,
      null,
      {
        revenueUsd: money(revenue),
        productRevenueUsd: money(productRevenue),
        contractRevenueUsd: money(contractRevenue),
        deferredReleasedUsd: money(deferredRelease),
      },
      company.isPublic ? 'public' : 'company',
    );
    const costEventId = emitEvent(
      draft,
      ctx,
      'cost_recognised',
      company.id,
      null,
      {
        cogsUsd: money(cogs),
        computeUsd: money(compute.totalUsd),
        servingComputeUsd: money(servingCompute),
        trainingComputeUsd: money(trainingCompute),
        depreciationUsd: money(depreciation),
        payrollUsd: money(payroll),
        marketingUsd: money(marketing),
        rdSpendUsd: money(rdSpend),
        interestUsd: money(interestExpense),
        taxUsd: money(tax),
      },
      'company',
    );
    const runway = quarterlyBurn < 0 ? clamp(ratio(sheet.assets.cash, -quarterlyBurn, RUNWAY_CAP_QUARTERS), 0, RUNWAY_CAP_QUARTERS) : RUNWAY_CAP_QUARTERS;

    // Distress is decided before the cash event is written, so the ledger row
    // carries the consequence as well as the cause.
    let bridgeRound: FundingRound | null = null;
    if (shortfall > 0) {
      company.posture = 'survival';
      registerDistressHaircut(draft, ctx, company.id);
      bridgeRound = queueBridgeRound(draft, ctx, company, shortfall);
    }

    const cashEventId = emitEvent(
      draft,
      ctx,
      'cash_flow_resolved',
      company.id,
      null,
      {
        openingCashUsd: money(openingCash),
        closingCashUsd: sheet.assets.cash,
        quarterlyBurnUsd: quarterlyBurn,
        debtRepaidUsd: money(debtRepayment),
        runwayQuarters: runway,
        insolvent: shortfall > 0,
        unfundedShortfallUsd: money(shortfall),
        distressHaircut: shortfall > 0 ? DISTRESS_VALUATION_HAIRCUT : 0,
        forcedBridgeRoundId: bridgeRound === null ? null : bridgeRound.id,
        forcedBridgeAmountUsd: bridgeRound === null ? 0 : bridgeRound.amount,
      },
      company.isPublic ? 'public' : 'company',
    );

    ctx.log({
      phase: 'financial_resolution',
      text: `${company.name} recognised ${usdLabel(revenue)} of revenue at a ${(ratio(grossProfit, Math.max(1, revenue)) * 100).toFixed(0)}% gross margin and an operating result of ${usdLabel(operatingIncome)}.`,
      deltaLabel: usdLabel(operatingIncome),
      refEventIds: [revenueEventId, costEventId],
      tone: operatingIncome >= 0 ? 'positive' : 'neutral',
      subjectId: company.id,
    });

    /* --- distress and warnings --------------------------------------------- */
    if (shortfall > 0) {
      ctx.log({
        phase: 'financial_resolution',
        text: `${company.name} could not settle ${usdLabel(shortfall)} of obligations in cash; it is financed by its suppliers, its posture is now survival and a bridge round has been forced.`,
        deltaLabel: usdLabel(-shortfall),
        refEventIds: [cashEventId],
        tone: 'negative',
        subjectId: company.id,
      });
    } else if (runway < RUNWAY_WARNING_QUARTERS) {
      ctx.log({
        phase: 'financial_resolution',
        text: `${company.name} has ${runway.toFixed(1)} quarters of runway at the current burn of ${usdLabel(quarterlyBurn)} per quarter.`,
        deltaLabel: `${runway.toFixed(1)}q`,
        refEventIds: [cashEventId],
        tone: 'warning',
        subjectId: company.id,
      });
    }

    /* --- invariant --------------------------------------------------------- */
    const reconciles = balanceSheetReconciles(sheet) && openingReconciles;
    const discrepancy = signedMoney(closingAssets - closingLiabilities - sheet.equity);
    balanceChecks.push({ companyId: company.id, quarter: ctx.quarter, reconciles, discrepancyUsd: discrepancy });
    const checkEventId = emitEvent(
      draft,
      ctx,
      'balance_sheet_checked',
      company.id,
      null,
      {
        reconciles,
        discrepancyUsd: discrepancy,
        assetsUsd: money(closingAssets),
        liabilitiesUsd: money(closingLiabilities),
        equityUsd: sheet.equity,
        openingResidualUsd: signedMoney(openingResidual),
      },
      'company',
    );
    if (!reconciles) {
      ctx.log({
        phase: 'financial_resolution',
        text: `${company.name}'s balance sheet did not reconcile: assets less liabilities differ from equity by ${usdLabel(discrepancy)}. The quarter cannot commit.`,
        deltaLabel: usdLabel(discrepancy),
        refEventIds: [checkEventId],
        tone: 'negative',
        subjectId: company.id,
      });
    }
  }

  return { pnl, balanceChecks };
}
