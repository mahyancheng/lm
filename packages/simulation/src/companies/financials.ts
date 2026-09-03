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
 *
 * ## The filed statement
 *
 * In a multi-sector world this phase also FILES the quarter it just closed as a
 * `FinancialQuarter` on the company (`history.ts`), from these same figures and
 * no others. The two market fields on that statement are stamped later, in the
 * metrics phase, because the market has not priced the quarter yet at eleven.
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
import type { CompanyModifierStack, ModifierRow } from '@frontier/contracts';
import {
  BALANCE_SHEET_TOLERANCE_USD,
  SECTOR_META,
  SECTOR_PRICE_BASELINE,
  TRADE_UPLIFT_REVENUE_CAP,
  balanceSheetReconciles,
  makeId,
  sectorPriceFactor,
  sectorTradeShare,
} from '@frontier/contracts';
import { accordBonusPctFor, activeAccords, chargesTollPct, regionLogistics, tollPaidPct } from '../economy/prices';
import { isMultiSectorWorld } from '../economy/sectors';
import { regionOf, regionalEnergyIndex } from '../economy/regions';
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
  OVERDRAFT_SPREAD,
  RUNWAY_CAP_QUARTERS,
  RUNWAY_WARNING_QUARTERS,
  SEGMENT_SUPPORT_COST_SHARE,
  SOLVENCY_NEGATIVE_QUARTERS,
  TAX_RATE,
} from './balance';
import { enterAdministration, isWoundUp, resolveDistress } from './distress';
import { categoryOf } from './categories';
import { closeEliminatedSeats, resolveMarketEntry, type AdministrationRow } from './entrants';
import { counterpartyRevenueByCompany } from './counterparty';
import { openMarketSupplyCostUsd, resolveSupplyLedger } from './supply';
import { negativeCashQuarters, overdraftChargeUsd } from './solvency';
import { appendFinancialQuarter } from './history';
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
  // The counterparty's factor rides on top of the world index for capacity that
  // was reserved or rented from a named company. Absent — every world-1 company,
  // and anything bought at the index — it is exactly 1.
  const reservedFactor = Math.max(0.1, compute.reservationProviderFactor ?? 1);
  const cloudFactor = Math.max(0.1, compute.cloudProviderFactor ?? 1);
  const reserved = compute.reservedAccelerators * RESERVED_UNIT_COST_USD_PER_QUARTER * world.compute.reservedPrice * reservedFactor;
  const cloud = compute.cloudSpendQuarterly * world.compute.spotPrice;
  const cloudUnits = ratio(
    compute.cloudSpendQuarterly,
    CLOUD_UNIT_COST_USD_PER_QUARTER * Math.max(0.1, world.compute.spotPrice) * cloudFactor,
  );
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

/**
 * Last quarter's net income, reconstructed from the figures on the company.
 *
 * `Financials` holds the quarter that has already resolved, so at
 * `capital_resolution` (phase six) this is genuinely *last* quarter's result —
 * which is exactly what a dividend is struck on. The arithmetic is the same
 * arithmetic `resolveFinancials` uses, restated here so the payout and the
 * income statement can never disagree.
 *
 * This is the thing a future reader will "fix" into reading the current
 * quarter's revenue. Do not: the current quarter has not been earned yet at
 * phase six, and a dividend paid out of it would be paid out of a forecast.
 */
export function lastQuarterNetIncomeUsd(company: Company): number {
  const f = company.financials;
  const operatingIncome = f.revenueQuarterly - f.cogs - f.payroll - f.marketing - f.rdSpend;
  const preTax = operatingIncome - f.interestExpense;
  return signedMoney(preTax > 0 ? preTax * (1 - TAX_RATE) : preTax);
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

/**
 * The margin a company sells compute to another company at.
 *
 * Its own realised gross margin last quarter, which is the only honest answer:
 * an infrastructure operator running at 30% does not suddenly make 90% because
 * the customer is a rival. A company with no filed revenue yet falls back to
 * `COUNTERPARTY_DEFAULT_MARGIN`.
 */
export const COUNTERPARTY_DEFAULT_MARGIN = 0.45;

export function counterpartyMarginOf(company: Company): number {
  const f = company.financials;
  if (f.revenueQuarterly <= 0) return COUNTERPARTY_DEFAULT_MARGIN;
  return clamp((f.revenueQuarterly - f.cogs) / f.revenueQuarterly, 0, 0.95);
}

/** Register the distress haircut the market phase will price next quarter. */
function registerDistressHaircut(draft: SessionState, ctx: ResolverContext, companyId: string, reason: string): void {
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
    reason,
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

  // Computed once, ahead of the loop: each walks every company. All three are
  // neutral or empty in world version 1.
  const economy = sectorEconomy(draft);
  const multiSector = isMultiSectorWorld(draft);
  // What every company owes another company for compute this quarter, keyed by
  // the *seller*. Built before the loop because the loop is in company order and
  // a seller may be reached before its buyer: a credit computed inside the loop
  // would land on half the sellers and miss the rest. Empty in world version 1,
  // which has no counterparties.
  const counterparty = counterpartyRevenueByCompany(draft);
  // The supply-chain ledger, computed once for the whole quarter for the same
  // reason: it is keyed by seller, and a per-company loop would otherwise
  // reach half its sellers before their buyers. Empty in world version 1.
  const supplyLedger = multiSector ? resolveSupplyLedger(draft) : [];
  const supplyRevenue = new Map<string, number>();
  const supplyCostByProduct = new Map<string, number>();
  for (const entry of supplyLedger) {
    if (entry.costUsd <= 0) continue;
    supplyRevenue.set(entry.supplierCompany.id, money((supplyRevenue.get(entry.supplierCompany.id) ?? 0) + entry.costUsd));
    const productKey = `${entry.buyerCompany.id}|${entry.buyerProduct.id}`;
    supplyCostByProduct.set(productKey, money((supplyCostByProduct.get(productKey) ?? 0) + entry.costUsd));
    if (entry.capacityShort) {
      const eventId = emitEvent(
        draft,
        ctx,
        'information_revealed',
        entry.buyerCompany.id,
        entry.supplierCompany.id,
        {
          kind: 'supply_capacity_short',
          buyerProductId: entry.buyerProduct.id,
          supplierProductId: entry.supplierProduct.id,
          unitsRequested: Math.round(entry.unitsRequested),
          unitsFilled: Math.round(entry.unitsFilled),
        },
        'company',
      );
      ctx.log({
        phase: 'financial_resolution',
        text: `${entry.supplierCompany.name} could fill ${Math.round(entry.unitsFilled)} of ${Math.round(entry.unitsRequested)} units of ${entry.buyerCompany.name}'s draw on ${entry.supplierProduct.name}; the rest was not on offer this quarter.`,
        deltaLabel: `${Math.round(entry.unitsFilled)}/${Math.round(entry.unitsRequested)}`,
        refEventIds: [eventId],
        tone: 'warning',
        subjectId: entry.buyerCompany.id,
      });
    }
  }
  const logistics = multiSector ? regionLogistics(draft) : null;
  const accords = activeAccords(draft);
  const priceStacks: CompanyModifierStack[] = [];
  const costStacks: CompanyModifierStack[] = [];
  // Companies wound up by the solvency clock inside this loop, in company order.
  const windUps: AdministrationRow[] = [];

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
    let supplyCost = 0;
    for (const product of activeProducts(company)) {
      const revenue = product.activeCustomers * product.pricePerSeat;
      productRevenue += revenue;
      // World 1: category is never resolved here (multiSector gates it), so
      // this is exactly the original SEGMENT_SUPPORT_COST_SHARE lookup. World
      // 2: a fabs line and a subscription app both selling into "enterprise"
      // no longer share one support-cost assumption.
      const supportCostShare = multiSector ? categoryOf(company, product).supportCostShare : SEGMENT_SUPPORT_COST_SHARE[product.segment];
      supportCost += revenue * supportCostShare;
      revenueBySegment.set(product.segment, (revenueBySegment.get(product.segment) ?? 0) + revenue);
      // What this product owes its own suppliers this quarter: every named,
      // capacity-rationed draw from the ledger above, plus the open-market
      // share of any input nobody named a supplier for.
      if (multiSector) supplyCost += (supplyCostByProduct.get(`${company.id}|${product.id}`) ?? 0) + openMarketSupplyCostUsd(draft, company, product);
    }
    const contractRevenue = contractRevenueUsd(draft, ctx, company.id);
    if (contractRevenue > 0) {
      revenueBySegment.set('government', (revenueBySegment.get('government') ?? 0) + contractRevenue);
      supportCost += contractRevenue * SEGMENT_SUPPORT_COST_SHARE.government;
    }
    const grossRevenue = productRevenue + contractRevenue;

    /* --- what other companies paid us for compute -------------------------- */
    // The buyer's side of this is already billed by `computeCost` out of its own
    // holdings, so nothing is charged twice: this is only the seller's half of
    // the same dollar arriving. It is recognised at the seller's own realised
    // margin, taken from the quarter it last filed, so a thin-margin operator
    // does not book infrastructure revenue as pure profit.
    // The supply-chain leg reads the same way: a buyer's spend on a named
    // product-category supplier is that supplier's revenue in the same
    // quarter, recognised at the supplier's own realised margin — one
    // intercompany figure, whether it came from renting compute or from
    // building on somebody else's published API.
    const interCompanyRevenue = (counterparty.get(company.id) ?? 0) + (supplyRevenue.get(company.id) ?? 0);
    const interCompanyCogs = interCompanyRevenue * (1 - counterpartyMarginOf(company));

    /* --- the seller side of the goods chain -------------------------------- */
    // Only the part of a sector's output sold to the other five sectors is
    // repriced by the chain; what goes to end customers was already priced by
    // the product phase. The uplift is bounded to a quarter of revenue either
    // way, so an accord can raise it but can never break the P0-1 clamp.
    const sector = economy[sectorOf(company)];
    const ownSector = sectorOf(company);
    const tradeShare = multiSector ? sectorTradeShare(ownSector) : 0;
    const chainPriceFactor = multiSector ? sectorPriceFactor(sector.priceIndex) : 1;
    const accordBonusPct = multiSector ? accordBonusPctFor(company.id, accords) : 0;
    const rawSectorUplift = grossRevenue * tradeShare * (chainPriceFactor - 1);
    const rawTotalUplift = grossRevenue * tradeShare * (chainPriceFactor * (1 + accordBonusPct / 100) - 1);
    const upliftCap = grossRevenue * TRADE_UPLIFT_REVENUE_CAP;
    const tradeUplift = signedMoney(clamp(rawTotalUplift, -upliftCap, upliftCap));
    const upliftScale = rawTotalUplift === 0 ? 0 : tradeUplift / rawTotalUplift;
    const sectorUpliftUsd = signedMoney(rawSectorUplift * upliftScale);
    const accordUpliftUsd = signedMoney(tradeUplift - sectorUpliftUsd);
    const revenue = grossRevenue + tradeUplift + interCompanyRevenue;

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
    const depreciationInCogs = depreciation * compute.servingShare;
    const cashCogsBeforeSector = Math.max(0, servingCompute - depreciationInCogs) + supportCost + compliance + supplyCost;
    const sustainingCapital = sustainingCapitalUsd(sector, revenue);
    const sectorCostAdjustment = (sector.inputCostMultiplier - 1) * cashCogsBeforeSector + sustainingCapital;
    // The Rockefeller squeeze: a group that dominates a region's freight charges
    // every rival in it a toll on the cash cost of goods, and its own companies
    // ride free. Cash-only, for the same reason the sector adjustment is:
    // scaling depreciation would invent property.
    const tollPct = logistics === null ? 0 : tollPaidPct(draft, company, logistics);
    const tollAdjustment = (tollPct / 100) * cashCogsBeforeSector;
    const cogs = servingCompute + supportCost + compliance + supplyCost + sectorCostAdjustment + tollAdjustment + interCompanyCogs;

    // Payroll and marketing were staged by the talent and product phases. The
    // fallbacks below only bite when this phase is run in isolation.
    const payroll = Math.max(company.financials.payroll, (totalHeadcount(company) * company.employees.avgComp) / 4);
    const marketing = Math.max(company.financials.marketing, policyMarketingUsd(company));

    const envelope = researchEnvelopeUsd(company, actions);
    const projectBudgets = projectBudgetUsd(draft, company.id);
    const rdSpend = Math.max(projectBudgets, envelope) + trainingCompute;

    const debtRate = (draft.world.macro.policyRate + draft.world.macro.creditSpreads + DEBT_RISK_PREMIUM) / 4;
    // An overdrawn balance is an unsecured loan nobody agreed to make. It is
    // priced off the opening overdraft — the quarter's own spending has not been
    // financed yet when the charge is struck — and booked as interest, so it
    // flows through net income and is explained to the double-entry gate by the
    // `interestUsd` figure the cost row already carries. Zero in world 1, where
    // cash never closes below zero.
    const overdraftCharge = multiSector ? overdraftChargeUsd(sheet.assets.cash, draft.world.macro.policyRate) : 0;
    const interestExpense = sheet.liabilities.debt * debtRate + overdraftCharge;

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
    // Accelerators bought outright: staged by the compute phase, settled here,
    // because this is the only phase that moves cash. Cash falls and property,
    // plant and equipment rises by the same figure, so equity does not move and
    // the double-entry gate below sees a matched pair.
    const purchases = company.compute.pendingAcceleratorPurchases ?? [];
    // Plant, fleet and grid: staged by `resolveCapacityOrders` in the product
    // phase, settled here on exactly the same contract. Undefined on every
    // world-1 company forever, since invest_capacity is refused there.
    const capacityInvestments = company.capacity?.pendingInvestments ?? [];
    const capacityCapexUsd = money(capacityInvestments.reduce((total, investment) => total + investment.amountUsd, 0));
    const capex = money(purchases.reduce((total, purchase) => total + purchase.totalUsd, 0) + capacityCapexUsd);
    const cashOut = cogsCashPaid + payroll + marketing + rdCash + interestExpense + tax + debtRepayment + capex;
    const unfloored = openingCash + collections - cashOut;
    // World 1 floors cash at zero and finances the gap through its suppliers.
    // World 2 does not: the balance goes where the arithmetic puts it, the
    // overdraft above is what it costs, and two consecutive quarters below zero
    // is what ends the company. Nothing is dumped into payables, so the payables
    // line means trade credit again rather than "the shortfall".
    const shortfall = multiSector ? 0 : unfloored < 0 ? -unfloored : 0;
    const closingCash = multiSector ? signedMoney(unfloored) : Math.max(0, unfloored);
    const closingPayables = closingPayablesBase + shortfall;

    /* --- roll the balance sheet forward ----------------------------------- */
    sheet.assets.cash = multiSector ? signedMoney(closingCash) : money(closingCash);
    sheet.assets.receivables = money(closingReceivables);
    sheet.assets.ppe = money(Math.max(0, sheet.assets.ppe - depreciation) + capex);
    if (purchases.length > 0) company.compute.pendingAcceleratorPurchases = [];
    // Depreciate the capacity buckets at the same rate ppe as a whole
    // depreciates at, then land this quarter's investments — the same
    // "decay then add" `sheet.assets.ppe` just did, kept as separate buckets
    // only so `capacityUsd` can read one kind's balance without walking the
    // ledger. A company that has never invested never grows this key.
    if (company.capacity !== undefined) {
      const decay = 1 - PPE_DEPRECIATION_PER_QUARTER;
      const investedByKind = { plant: 0, fleet: 0, grid: 0 } as Record<'plant' | 'fleet' | 'grid', number>;
      for (const investment of capacityInvestments) investedByKind[investment.kind] += investment.amountUsd;
      company.capacity.plantUsd = money(Math.max(0, company.capacity.plantUsd * decay) + investedByKind.plant);
      company.capacity.fleetUsd = money(Math.max(0, company.capacity.fleetUsd * decay) + investedByKind.fleet);
      company.capacity.gridUsd = money(Math.max(0, company.capacity.gridUsd * decay) + investedByKind.grid);
      if (capacityInvestments.length > 0) company.capacity.pendingInvestments = [];
    }
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
        tradeUpliftUsd: tradeUplift,
        sectorPriceIndex: sector.priceIndex,
        tradeSharePct: Math.round(tradeShare * 100),
        accordBonusPct,
        upliftCapUsd: money(upliftCap),
        // Stated only when it happened, so a world-1 payload is the payload it
        // has always been and its ledger hashes are unchanged.
        ...(interCompanyRevenue > 0 ? { interCompanyRevenueUsd: money(interCompanyRevenue), interCompanyCogsUsd: money(interCompanyCogs) } : {}),
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
        // P0-2 attribution: the number the Financials screen prints traces to
        // this row, and only to this row.
        logisticsTollPct: tollPct,
        tollExempt: multiSector && tollPct === 0,
        logisticsTollUsd: money(tollAdjustment),
        regionalEnergyIndex: multiSector ? regionalEnergyIndex(draft, regionOf(company)) : SECTOR_PRICE_BASELINE,
        inputPriceIndex: Math.round(sector.inputPriceFactor * SECTOR_PRICE_BASELINE),
        sectorCostAdjustmentUsd: signedMoney(sectorCostAdjustment),
        sustainingCapitalUsd: money(sustainingCapital),
      },
      'company',
    );
    /* --- attribution: the rows the interface renders ------------------------ */
    // Rule §6.2: if the engine multiplied it, the screen names it and signs it.
    // Every row below carries the committed ledger row it came from, and the
    // rows sum exactly to `totalUsd - baseUsd`, so no screen has to add anything
    // up itself. Nothing is written in a single-sector world.
    if (multiSector) {
      const chainRow = draft.economyReport?.sectorPrices.find((row) => row.sector === ownSector) ?? null;
      const priceRows: ModifierRow[] = [];
      if (sectorUpliftUsd !== 0) {
        priceRows.push(
          stackRow(
            'sector_price',
            `${SECTOR_META[ownSector].label} goods price ${sector.priceIndex}`,
            SECTOR_META[ownSector].icon,
            sectorUpliftUsd,
            grossRevenue,
            chainRow?.causeEventId ?? revenueEventId,
            'price',
          ),
        );
      }
      if (accordUpliftUsd !== 0) {
        priceRows.push(stackRow('price_accord', `Price accord +${accordBonusPct}%`, 'network', accordUpliftUsd, grossRevenue, revenueEventId, 'price'));
      }
      priceStacks.push({
        companyId: company.id,
        quarter: ctx.quarter,
        kind: 'price',
        baseUsd: money(grossRevenue),
        totalUsd: money(revenue),
        netPct: pctOfBase(tradeUplift, grossRevenue),
        rows: priceRows,
      });

      // The energy line already sits inside the cash cost of goods, so the base
      // is stated at a neutral energy index and the deviation is its own row.
      const energyInCogs = compute.energyUsd * compute.servingShare;
      const energyPriceEffect = energyInCogs * (1 - SECTOR_PRICE_BASELINE / Math.max(1, economy.energy.priceIndex));
      const costBase = cashCogsBeforeSector - energyPriceEffect;
      const inputPriceUsd = (sector.inputPriceFactor - 1) * cashCogsBeforeSector;
      const sectorConditionsUsd = (sector.inputCostMultiplier - sector.inputPriceFactor) * cashCogsBeforeSector;
      const energyRow = draft.economyReport?.sectorPrices.find((row) => row.sector === 'energy') ?? null;
      const tollRow = draft.economyReport?.regionTolls.find((row) => row.region === regionOf(company)) ?? null;

      const costRows: ModifierRow[] = [];
      if (Math.round(energyPriceEffect) !== 0) {
        costRows.push(
          stackRow('energy_basis', `Energy basis ${regionalEnergyIndex(draft, regionOf(company))}`, 'live', energyPriceEffect, costBase, energyRow?.causeEventId ?? costEventId, 'cost'),
        );
      }
      if (Math.round(inputPriceUsd) !== 0) {
        costRows.push(
          stackRow('input_price', `Input goods price ${Math.round(sector.inputPriceFactor * SECTOR_PRICE_BASELINE)}`, 'box', inputPriceUsd, costBase, chainRow?.causeEventId ?? costEventId, 'cost'),
        );
      }
      if (Math.round(sectorConditionsUsd) !== 0) {
        costRows.push(stackRow('sector_conditions', 'Energy pass-through and AI productivity', 'settings', sectorConditionsUsd, costBase, costEventId, 'cost'));
      }
      if (Math.round(sustainingCapital) !== 0) {
        costRows.push(stackRow('sustaining_capital', 'Sustaining capital', 'building', sustainingCapital, costBase, costEventId, 'cost'));
      }
      if (Math.round(tollAdjustment) !== 0) {
        costRows.push(stackRow('logistics_toll', `Logistics toll ${tollPct}%`, 'network', tollAdjustment, costBase, tollRow?.causeEventId ?? costEventId, 'cost'));
      } else if (logistics !== null && chargesTollPct(draft, company, logistics) > 0) {
        costRows.push({
          key: 'logistics_toll',
          label: `Logistics toll — exempt (your group charges ${chargesTollPct(draft, company, logistics)}%)`,
          icon: 'network',
          pct: 0,
          amountUsd: 0,
          tone: 'positive',
          causeEventId: tollRow?.causeEventId ?? costEventId,
        });
      }

      const costTotal = cashCogsBeforeSector + sectorCostAdjustment + tollAdjustment;
      costStacks.push({
        companyId: company.id,
        quarter: ctx.quarter,
        kind: 'cost',
        baseUsd: money(costBase),
        totalUsd: money(costTotal),
        netPct: pctOfBase(costTotal - costBase, costBase),
        rows: costRows,
      });
    }

    const runway = quarterlyBurn < 0 ? clamp(ratio(sheet.assets.cash, -quarterlyBurn, RUNWAY_CAP_QUARTERS), 0, RUNWAY_CAP_QUARTERS) : RUNWAY_CAP_QUARTERS;

    /* --- the filed statement ----------------------------------------------- */
    // Every figure below is one this phase has already computed; `history.ts`
    // restates them and does no economics of its own. Gated on the multi-sector
    // world so a world-version-1 company never grows the key and the frozen
    // world keeps hashing to the value it has always hashed to.
    if (multiSector) {
      appendFinancialQuarter(company, ctx.quarter, {
        revenueUsd: revenue,
        productRevenueUsd: productRevenue,
        contractRevenueUsd: contractRevenue,
        cogsUsd: cogs,
        payrollUsd: payroll,
        marketingUsd: marketing,
        researchUsd: rdSpend,
        trainingComputeUsd: trainingCompute,
        depreciationUsd: depreciation,
        interestUsd: interestExpense,
        taxUsd: tax,
        netIncomeUsd: netIncome,
        openingCashUsd: openingCash,
        capexUsd: capex,
        debtRepaidUsd: debtRepayment,
        runwayQuarters: runway,
      });
    }

    // Distress is decided before the cash event is written, so the ledger row
    // carries the consequence as well as the cause.
    //
    // World 2 counts the clock instead: the statement for this quarter has just
    // been filed, so `negativeCashQuarters` already includes the close below.
    const overdrawn = multiSector && sheet.assets.cash < 0;
    const negativeQuarters = multiSector ? negativeCashQuarters(company) : 0;
    let bridgeRound: FundingRound | null = null;
    if (shortfall > 0) {
      company.posture = 'survival';
      registerDistressHaircut(draft, ctx, company.id, 'The company could not settle its obligations in cash and is being financed by its suppliers.');
      bridgeRound = queueBridgeRound(draft, ctx, company, shortfall);
    } else if (overdrawn) {
      company.posture = 'survival';
      registerDistressHaircut(draft, ctx, company.id, 'The company closed the quarter with a negative cash balance.');
      // ASYMMETRY, deliberate: a player-controlled company is never bridged. The
      // founder raises, borrows, sells or cuts — or the clock runs out. A bot has
      // nobody to make that call, so its own raise is queued for it, and it can
      // still fail on appetite like any other round.
      if (company.controllerPlayerId === null) bridgeRound = queueBridgeRound(draft, ctx, company, -sheet.assets.cash);
    }

    if (overdraftCharge > 0) {
      // A staging row: `kind` keeps it out of the gate's reconstruction, which
      // already has this charge inside the profit and loss's `interestUsd`.
      emitEvent(
        draft,
        ctx,
        'cost_recognised',
        company.id,
        null,
        {
          kind: 'overdraft_interest',
          chargeUsd: money(overdraftCharge),
          overdraftUsd: money(Math.max(0, -openingCash)),
          annualRatePct: Math.round((draft.world.macro.policyRate + OVERDRAFT_SPREAD) * 10_000) / 100,
        },
        'company',
      );
    }

    const cashEventId = emitEvent(
      draft,
      ctx,
      'cash_flow_resolved',
      company.id,
      null,
      {
        openingCashUsd: multiSector ? signedMoney(openingCash) : money(openingCash),
        closingCashUsd: sheet.assets.cash,
        quarterlyBurnUsd: quarterlyBurn,
        debtRepaidUsd: money(debtRepayment),
        runwayQuarters: runway,
        insolvent: shortfall > 0,
        unfundedShortfallUsd: money(shortfall),
        distressHaircut: shortfall > 0 || overdrawn ? DISTRESS_VALUATION_HAIRCUT : 0,
        forcedBridgeRoundId: bridgeRound === null ? null : bridgeRound.id,
        forcedBridgeAmountUsd: bridgeRound === null ? 0 : bridgeRound.amount,
        // World-2 keys only: a version-1 row must hash to what it always did.
        ...(multiSector
          ? {
              overdrawn,
              negativeCashQuarters: negativeQuarters,
              overdraftChargeUsd: money(overdraftCharge),
              solvencyQuartersAllowed: SOLVENCY_NEGATIVE_QUARTERS,
            }
          : {}),
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
    if (overdrawn && negativeQuarters < SOLVENCY_NEGATIVE_QUARTERS) {
      // One quarter below zero is a warning, not a verdict. The row is what the
      // projection's alerts and the Command Centre's solvency figure read.
      const warningEventId = emitEvent(
        draft,
        ctx,
        'information_revealed',
        company.id,
        null,
        {
          kind: 'solvency_warning',
          closingCashUsd: sheet.assets.cash,
          negativeCashQuarters: negativeQuarters,
          solvencyQuartersAllowed: SOLVENCY_NEGATIVE_QUARTERS,
          overdraftChargeUsd: money(overdraftCharge),
        },
        company.isPublic ? 'public' : 'company',
      );
      ctx.log({
        phase: 'financial_resolution',
        text: `${company.name} closed the quarter ${usdLabel(sheet.assets.cash)} in cash; one more quarter below zero and ${company.name} is wound up.`,
        deltaLabel: `${negativeQuarters}/${SOLVENCY_NEGATIVE_QUARTERS}`,
        refEventIds: [warningEventId, cashEventId],
        tone: 'warning',
        subjectId: company.id,
      });
    }

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

    // THE world-2 bankruptcy rule, and the only one: two consecutive quarter-ends
    // below zero, for a player-controlled company and a bot alike. The wind-up
    // happens in the quarter the second close lands, so the report that tells the
    // player they went under is the report for the quarter they went under in.
    if (multiSector && negativeQuarters >= SOLVENCY_NEGATIVE_QUARTERS && !isWoundUp(company)) {
      // The row the wind-up wrote, kept for the two things that follow the
      // quarter's deaths: a new company founded into the gap, and a player's
      // seat closed. Both are facts about this quarter, so neither is a flag on
      // `Company` that would have to be cleared next quarter.
      windUps.push({ companyId: company.id, eventId: enterAdministration(draft, ctx, company, 'insolvent') });
    }

    /* --- invariant --------------------------------------------------------- */
    // Recomputed off the sheet rather than reused from the roll-forward above: a
    // wind-up between the two rewrites every line, and a check that reported the
    // pre-administration figures would be checking a sheet that no longer exists.
    const finalAssets =
      sheet.assets.cash + sheet.assets.ppe + sheet.assets.goodwill + sheet.assets.investments + sheet.assets.receivables;
    const finalLiabilities = sheet.liabilities.debt + sheet.liabilities.payables + sheet.liabilities.deferredRevenue;
    const reconciles = balanceSheetReconciles(sheet) && openingReconciles;
    const discrepancy = signedMoney(finalAssets - finalLiabilities - sheet.equity);
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
        assetsUsd: multiSector ? signedMoney(finalAssets) : money(closingAssets),
        liabilitiesUsd: multiSector ? money(finalLiabilities) : money(closingLiabilities),
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

  // After the distress step has run for the quarter, and after the loop rather
  // than inside it: `activeCompanies` was read once at the top, so a company
  // founded here is not walked by the loop that founded it, and its first
  // resolved quarter is the next one.
  closeEliminatedSeats(draft, ctx, windUps);
  resolveMarketEntry(draft, ctx, windUps);

  if (multiSector && draft.economyReport !== undefined && draft.economyReport !== null) {
    draft.economyReport = { ...draft.economyReport, priceStacks, costStacks };
  }

  return { pnl, balanceChecks };
}

/* -------------------------------------------------------------------------- */
/*  Attribution rows                                                           */
/* -------------------------------------------------------------------------- */

/** A signed whole percentage of a base. Zero base reads as zero rather than infinity. */
function pctOfBase(amountUsd: number, baseUsd: number): number {
  const base = Math.abs(baseUsd);
  if (!(base > 1)) return 0;
  return Math.round((amountUsd / base) * 100);
}

/**
 * One row of an itemised stack.
 *
 * Tone is read from the reader's point of view, not the arithmetic's: money onto
 * the revenue line is positive, money onto the cost line is negative, and a row
 * that moved nothing is neutral.
 */
function stackRow(
  key: string,
  label: string,
  icon: string,
  amountUsd: number,
  baseUsd: number,
  causeEventId: string | null,
  kind: 'price' | 'cost',
): ModifierRow {
  const amount = Math.round(amountUsd);
  const good = kind === 'price' ? amount > 0 : amount < 0;
  const bad = kind === 'price' ? amount < 0 : amount > 0;
  return {
    key,
    label: label.slice(0, 80),
    icon,
    pct: pctOfBase(amount, baseUsd),
    amountUsd: amount,
    tone: good ? 'positive' : bad ? 'negative' : 'neutral',
    causeEventId,
  };
}
