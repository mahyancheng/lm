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
  NodeCostCache,
  UnitCostResult,
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
  economicNodeById,
} from '@frontier/contracts';
import { accordBonusPctFor, activeAccords, chargesTollPct, regionLogistics, tollPaidPct } from '../economy/prices';
import { isMultiSectorWorld, isNodeEconomyWorld } from '../economy/sectors';
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
import { cloudRentUsd, createNodeCostCache, lineNodeIdOf, reservedRentUsd } from '../graph/lines';
import { totalDataPetabytes } from '../graph/data';
import { unitCostOf } from '../graph/cost';
import { executiveDialsFor, policyMarketingUsd, researchEnvelopeUsd } from './policy';
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

/**
 * How much of a company's capacity charge has to go unabsorbed before the
 * quarter report says so. A fifth: below that it is the ordinary slack every
 * plant carries, and a phone has better things to print.
 */
export const IDLE_CAPACITY_REPORT_SHARE = 0.2;

/**
 * How much of a landed cost of goods is freight, and therefore tollable.
 *
 * Fifteen percent: high for a chip, low for a pallet of packaging, and the one
 * number that keeps a regional logistics toll a real cost without letting it
 * eat a fifth of every manufacturer's bill of materials.
 */
export const NODE_TOLL_FREIGHT_SHARE = 0.15;

/**
 * The most of the cash left after a quarter's bills that may go into holding
 * capacity flat.
 *
 * Half. Sustaining capital is real and a company that skips it shrinks, but no
 * board signs off maintenance that empties the account: without this bound a
 * capital-heavy business spent its closing balance down to exactly zero every
 * quarter for four years, which is arithmetic rather than a decision.
 */
export const SUSTAINING_CAPITAL_CASH_SHARE = 0.5;

/**
 * How little of the quarter's write-off a company has to replace before the
 * report says its capacity is shrinking.
 *
 * Four fifths. Holding capacity flat is the ordinary case and says nothing;
 * funding most of it is slippage; funding well under it is a business getting
 * smaller, which is a fact the founder is owed in words.
 */
export const MAINTENANCE_REPORT_SHARE = 0.8;

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
 *
 * ## The energy line, and why world 3 does not have one
 *
 * `capacityRateUsd` already says it: "a node's own `energyMwhPerUnit` is its
 * power line, and charging it twice is exactly the kind of double count the
 * roll-up exists to prevent". The line above is the second charge. In world 3
 * every node that draws power carries `energyMwhPerUnit`, priced at the grid
 * node's own market price through the company's own regional factor, and it is
 * allocated to the units that drew it; `$420 an accelerator a quarter` is world
 * 2's model of the same electricity, and it is allocated to nothing.
 *
 * It landed as **idle capacity** — a charge against no output, on a resource
 * the roll-up was already billing. On an AI infrastructure company holding
 * eleven thousand accelerators against a training-run line that itself declares
 * 330 MWh a run, it was four to seven million dollars a quarter of idle
 * capacity out of a twenty-million-dollar run rate: enough on its own to make
 * that background insolvent by its fifth quarter with no player input.
 *
 * Zero in world 3 and exactly what it always was in worlds 1 and 2, which have
 * no `energyMwhPerUnit` and would otherwise lose their only energy charge.
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
  // World 3 reads the rent off the node table (`reservedRentUsd`); worlds 1
  // and 2 get exactly the constant times the index they always got.
  const reserved = compute.reservedAccelerators * reservedRentUsd(draft) * reservedFactor;
  const cloud = compute.cloudSpendQuarterly * world.compute.spotPrice;
  const cloudUnits = ratio(compute.cloudSpendQuarterly, cloudRentUsd(draft, 0.1) * cloudFactor);
  const units = compute.ownedAccelerators + compute.reservedAccelerators + cloudUnits;
  // Electricity is the one input whose price is genuinely local: the world index
  // sets the trend, the company's region sets what it actually pays. The regional
  // factor is exactly 1 in world version 1.
  const energy = isNodeEconomyWorld(draft)
    ? 0
    : units * ENERGY_USD_PER_ACCELERATOR_QUARTER * world.energy.electricityPrice * companyEnergyCostFactor(draft, company);
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
  const operatingIncome = f.revenueQuarterly - f.cogs - f.payroll - f.marketing - f.rdSpend - (f.idleCapacityUsd ?? 0) - (f.dataCustodyUsd ?? 0);
  const preTax = operatingIncome - f.interestExpense;
  return signedMoney(preTax > 0 ? preTax * (1 - TAX_RATE) : preTax);
}

/**
 * One conversion line of a unit cost, by key.
 *
 * The roll-up's own itemisation is the single source: reading `labour` and
 * `capacity` back out of it is how the profit and loss nets them against the
 * payroll and depreciation it is already booking, without restating either
 * formula.
 */
function conversionLineUsd(cost: UnitCostResult, key: 'labour' | 'capacity'): number {
  return cost.lines.find((line) => line.key === key)?.amountUsd ?? 0;
}

/**
 * What this company's world-3 contract lines recognise this quarter: one
 * quarter of every live contract on the book, at the price it was signed at.
 * The advance for the whole term went into deferred revenue when it was signed.
 */
function contractRecognisedUsd(company: Company): number {
  let total = 0;
  for (const product of activeProducts(company)) {
    const nodeId = lineNodeIdOf(product);
    if (nodeId === null) continue;
    if (economicNodeById(nodeId)?.saleKind !== 'contract') continue;
    total += Math.max(0, product.unitsSoldQuarterly ?? product.activeCustomers) * product.pricePerSeat;
  }
  return total;
}

/**
 * Every royalty a licensed line owes its node's owner this quarter, keyed by
 * the OWNER.
 *
 * Built before the company loop for the reason the compute and supply ledgers
 * are: it is keyed by the company being paid, and a per-company loop would
 * reach half the owners before their licensees. The figure is read straight off
 * the licensee's own cost breakdown — the `licence:` lines of the roll-up — so
 * the dollars the owner books as revenue are exactly the dollars the licensee
 * booked as cost of goods, itemised in the breakdown the founder is already
 * reading. Empty below world version 3, which has no licences.
 */
function royaltyRevenueByCompany(draft: SessionState, cache: NodeCostCache | undefined): Map<string, number> {
  const out = new Map<string, number>();
  if (!isNodeEconomyWorld(draft)) return out;
  for (const company of activeCompanies(draft)) {
    if ((company.licences ?? []).length === 0) continue;
    for (const product of activeProducts(company)) {
      const nodeId = lineNodeIdOf(product);
      if (nodeId === null) continue;
      const units = Math.max(0, product.unitsSoldQuarterly ?? product.activeCustomers);
      if (units <= 0) continue;
      for (const line of unitCostOf(draft, company, nodeId, cache).lines) {
        if (!line.key.startsWith('licence:') || line.sourceCompanyId === null) continue;
        out.set(line.sourceCompanyId, money((out.get(line.sourceCompanyId) ?? 0) + units * line.amountUsd));
      }
    }
  }
  return out;
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

/**
 * What it costs to hold personal data lawfully, per petabyte per quarter, at
 * the tightest privacy regime.
 *
 * Forty thousand dollars: encryption at rest and in transit, access logging,
 * retention and deletion machinery, an audit somebody signs, and the standing
 * legal cost of being the custodian. Scaled by `world.regulation.privacy`, so a
 * permissive world charges almost nothing for the same hoard and a strict one
 * makes a large stock a liability as well as an asset — which is the cost side
 * of collecting everything.
 */
export const DATA_CUSTODY_USD_PER_PB_QUARTER = 40_000;

/** The standing cost of the data this company holds. Zero below world 3, which holds none. */
function dataCustodyCostUsd(draft: SessionState, company: Company): number {
  if (!isNodeEconomyWorld(draft)) return 0;
  const privacy = Math.max(0, Math.min(1, draft.world.regulation.privacy));
  return totalDataPetabytes(company) * DATA_CUSTODY_USD_PER_PB_QUARTER * privacy;
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
  // World 3 books cost of goods off the node roll-up. The cache is built here
  // and shared by every company in the loop: the roll-up is memoised per
  // company and node, never module-level, so it cannot leak between saves.
  const nodeEconomy = isNodeEconomyWorld(draft);
  const costCache = nodeEconomy ? createNodeCostCache(draft) : undefined;
  // What every company owes another company for compute this quarter, keyed by
  // the *seller*. Built before the loop because the loop is in company order and
  // a seller may be reached before its buyer: a credit computed inside the loop
  // would land on half the sellers and miss the rest. Empty in world version 1,
  // which has no counterparties.
  const counterparty = counterpartyRevenueByCompany(draft);
  // What every licensee owes the owner of the node it produces under, keyed by
  // the owner. World 3 only, and it shares the cost cache above.
  const royalties = royaltyRevenueByCompany(draft, costCache);
  // The supply-chain ledger, computed once for the whole quarter for the same
  // reason: it is keyed by seller, and a per-company loop would otherwise
  // reach half its sellers before their buyers. Empty in world version 1.
  // World 3 does not run the world-2 category supply ledger at all: the same
  // dollars are inside the node roll-up, and charging both would be exactly the
  // double count this stage exists to end.
  const supplyLedger = multiSector && !nodeEconomy ? resolveSupplyLedger(draft) : [];
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
    // World 3's four running totals: what the lines cost to make, and the two
    // conversion components that have to be netted against a charge the company
    // is already booking elsewhere — labour against payroll, capacity against
    // depreciation and rented compute. EVERY DOLLAR OF CONVERSION COST IS
    // BOOKED EXACTLY ONCE, AT THE POINT OF EXTERNAL SALE.
    let nodeCogs = 0;
    let labourAllocated = 0;
    let capacityAllocated = 0;
    let contractBilled = 0;
    for (const product of activeProducts(company)) {
      if (nodeEconomy) {
        const units = Math.max(0, product.unitsSoldQuarterly ?? product.activeCustomers);
        const revenue = units * product.pricePerSeat;
        productRevenue += revenue;
        revenueBySegment.set(product.segment, (revenueBySegment.get(product.segment) ?? 0) + revenue);
        const nodeId = lineNodeIdOf(product);
        if (nodeId === null) {
          // Not a node line: nothing was produced against the graph, so the
          // only cost of revenue is the segment's own support share.
          supportCost += revenue * SEGMENT_SUPPORT_COST_SHARE[product.segment];
          continue;
        }
        const cost = unitCostOf(draft, company, nodeId, costCache);
        // The number the Products screen shows is the number the profit and
        // loss books: stamped by the demand phase, read here, never recomputed
        // into a second opinion.
        const unitCost = product.unitCostUsd ?? cost.unitCostUsd;
        nodeCogs += units * unitCost;
        labourAllocated += units * conversionLineUsd(cost, 'labour');
        capacityAllocated += units * conversionLineUsd(cost, 'capacity');
        contractBilled += Math.max(0, product.contractBilledUsd ?? 0);
        continue;
      }
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
    // The third leg, world 3 only: a royalty on somebody else's line. It
    // arrives with no cost of goods behind it because there is none — the
    // owner is being paid for a thing it already owns — and `interCompanyCogs`
    // is zero in the node economy for the same reason.
    const interCompanyRevenue = (counterparty.get(company.id) ?? 0) + (supplyRevenue.get(company.id) ?? 0) + (royalties.get(company.id) ?? 0);
    // THE INTERCOMPANY FUDGE, deleted in world 3. `revenue × (1 -
    // counterpartyMargin)` existed only because compute revenue arrived with no
    // cost attached. In the node economy the seller's cost of goods is its own
    // unit cost times its own units and the buyer's contains the purchase: both
    // are real, in the same quarter, and no dollar is invented.
    const interCompanyCogs = nodeEconomy ? 0 : interCompanyRevenue * (1 - counterpartyMarginOf(company));

    /* --- the seller side of the goods chain -------------------------------- */
    // Only the part of a sector's output sold to the other five sectors is
    // repriced by the chain; what goes to end customers was already priced by
    // the product phase. The uplift is bounded to a quarter of revenue either
    // way, so an accord can raise it but can never break the P0-1 clamp.
    const sector = economy[sectorOf(company)];
    const ownSector = sectorOf(company);
    const tradeShare = multiSector ? sectorTradeShare(ownSector) : 0;
    // World 3 prices goods in the node market and nowhere else, so the world-2
    // sector goods index does not also lift revenue. The accord bonus below
    // survives: a price accord is an agreement between companies, not a second
    // opinion about what a sector's output is worth.
    const chainPriceFactor = multiSector && !nodeEconomy ? sectorPriceFactor(sector.priceIndex) : 1;
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
    // Payroll and marketing were staged by the talent and product phases. They
    // are read here, before cost, because world 3 allocates the labour a unit
    // consumed *out of* payroll rather than beside it. The fallbacks below only
    // bite when this phase is run in isolation.
    const payroll = Math.max(company.financials.payroll, (totalHeadcount(company) * company.employees.avgComp) / 4);
    const marketing = Math.max(company.financials.marketing, policyMarketingUsd(company, executiveDialsFor(draft, company)));

    const compute = computeCost(draft, company);
    const servingCompute = compute.totalUsd * compute.servingShare;
    const trainingCompute = compute.totalUsd - servingCompute;
    const compliance = complianceCostUsd(draft, company.id);
    // What it costs to be the custodian of the customer data this company holds.
    // An OPERATING expense, not a cost of goods: it is the price of keeping an
    // asset lawfully, not part of making a unit — and keeping it out of cost of
    // goods is what preserves world 3's one identity, that cost of goods is the
    // roll-up and nothing else.
    const dataCustodyUsd = dataCustodyCostUsd(draft, company);
    const depreciation = Math.min(sheet.assets.ppe, compute.ownedDepreciationUsd);

    /*
     * THE ONE IDENTITY, and the reason the double-entry gate accepts it.
     *
     * Cost of goods IS the roll-up: `nodeCogs`, the sum over the quarter's lines
     * of units times the same `unitCostUsd` the Products screen and the
     * `unit_cost` lookup print. Not a cousin of it, not a capped version of it.
     * Everything below decides where the company's OTHER charges go once the
     * roll-up has already claimed its share of them, and nothing below may
     * change the total.
     *
     * Two of the roll-up's conversion lines name a resource the company also
     * carries a standing bill for, so each would otherwise be charged twice:
     *
     * - **Capacity.** The capacity line allocates the depreciation and rent on
     *   plant, fleet, grid or accelerators to the units made on them; the
     *   balance sheet writes the same depreciation off property, plant and
     *   equipment.
     * - **Labour.** The labour line allocates the wage bill to the units it
     *   made; the talent phase already staged the whole of payroll.
     *
     * So each standing charge is booked only for the part production did NOT
     * consume: what plant nothing was made on cost is the named operating
     * expense "idle capacity", and what payroll production did not consume
     * stays on the payroll line. Each is a `max(0, charge - allocated)`, never
     * a `min`: an allocation LARGER than the standing charge is a line drawing
     * capacity or labour beyond what the company owns and employs — rented
     * plant, contract staff — and that excess is a real cash cost of making
     * the unit. Capping it at the standing charge, as this once did, silently
     * dropped every dollar of it and put the profit and loss into open
     * disagreement with the unit cost the same quarter stamped on the line.
     *
     * The non-cash pieces still sum to `depreciation` EXACTLY — training's
     * share, production's share and the idle share — which is the whole of
     * what the gate checks: total cash charges plus depreciation must equal
     * total booked charges.
     */
    const trainingShare = 1 - compute.servingShare;
    const depreciationInRdWorld3 = depreciation * trainingShare;
    const depreciationServing = depreciation - depreciationInRdWorld3;
    // What renting capacity costs in cash this quarter, serving half only.
    const computeCashServing = (compute.reservedUsd + compute.cloudUsd + compute.energyUsd) * compute.servingShare;
    const capacityChargeUsd = depreciationServing + computeCashServing;
    const capacityInCogs = nodeEconomy ? capacityAllocated : 0;
    const idleCapacityUsd = nodeEconomy ? Math.max(0, capacityChargeUsd - capacityAllocated) : 0;
    // World 2's sector cost weather — an energy pass-through and an AI
    // productivity term over the sector supply graph — is applied to the *cash*
    // part of cost only, for the same reason: scaling depreciation would invent
    // property. Both are zero in world 1 and, below, in world 3.
    //
    // The depreciation inside cost of goods is bounded by the depreciation that
    // actually ran this quarter: an allocation past it is rent, which is cash.
    const depreciationInCogs = nodeEconomy ? Math.min(capacityAllocated, depreciationServing) : depreciation * compute.servingShare;
    const idleDepreciation = nodeEconomy ? depreciationServing - depreciationInCogs : 0;
    // Labour is allocated out of payroll, never beside it: the roll-up says how
    // much of the quarter's wage bill a unit consumed, and what production did
    // not consume stays on the payroll line.
    const labourInCogs = nodeEconomy ? labourAllocated : 0;
    const payrollBooked = nodeEconomy ? Math.max(0, payroll - labourAllocated) : payroll - labourInCogs;
    // The identity, stated: in the node economy cost of goods is the roll-up.
    const nodeCogsBooked = nodeCogs;

    const cashCogsBeforeSector = nodeEconomy
      ? Math.max(0, nodeCogsBooked - depreciationInCogs) + supportCost + compliance
      : Math.max(0, servingCompute - depreciationInCogs) + supportCost + compliance + supplyCost;
    // World 3 prices every input through the node market and charges capital per
    // unit through the capacity line of the roll-up. World 2's sector cost
    // weather — an input-price multiplier over the sector supply graph, and
    // sustaining capital struck on revenue — would price the same inputs and
    // the same capital a second time, which is precisely the unreconciled
    // second economy the node table replaces. Both are zero in world 3; the
    // toll below survives, because a group's freight toll is a real charge
    // levied by another company rather than a second opinion about cost.
    const sustainingCapital = nodeEconomy ? 0 : sustainingCapitalUsd(sector, revenue);
    const sectorCostAdjustment = nodeEconomy ? 0 : (sector.inputCostMultiplier - 1) * cashCogsBeforeSector + sustainingCapital;
    // The Rockefeller squeeze: a group that dominates a region's freight charges
    // every rival in it a toll on the cash cost of goods, and its own companies
    // ride free. Cash-only, for the same reason the sector adjustment is:
    // scaling depreciation would invent property.
    const tollPct = logistics === null ? 0 : tollPaidPct(draft, company, logistics);
    // A toll is a charge on goods that MOVE. World 2's cash cost of goods was
    // serving compute and support — roughly the freight-shaped part of a
    // software business's cost — so charging the toll on all of it was fair
    // there. World 3's cash cost of goods is the whole bill of materials, and
    // charging a quarter of that as freight would be a tax rather than a toll:
    // a consumer-electronics line would hand a rival's logistics group a fifth
    // of its revenue every quarter. The base is the freight share of landed
    // cost instead, and the group's dial still decides what fraction of that it
    // takes.
    const tollBase = nodeEconomy ? cashCogsBeforeSector * NODE_TOLL_FREIGHT_SHARE : cashCogsBeforeSector;
    const tollAdjustment = (tollPct / 100) * tollBase;
    const cogs = nodeEconomy
      ? nodeCogsBooked + supportCost + compliance + sectorCostAdjustment + tollAdjustment
      : servingCompute + supportCost + compliance + supplyCost + sectorCostAdjustment + tollAdjustment + interCompanyCogs;

    const envelope = researchEnvelopeUsd(company, actions, executiveDialsFor(draft, company));
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
    const operatingExpenses = payrollBooked + marketing + rdSpend + idleCapacityUsd + dataCustodyUsd;
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
    // World 3's `contract` sale kind bills its whole term the quarter it is
    // signed and recognises a quarter at a time, through this same path — the
    // one the government contracts already run on, never a second one. The
    // advance is cash in and deferred revenue out; the release is revenue with
    // no cash behind it.
    const deferredAdd = nodeEconomy ? money(contractBilled) : 0;
    const contractRecognised = nodeEconomy ? contractRevenue + contractRecognisedUsd(company) : contractRevenue;
    const deferredRelease = Math.min(openingDeferred + deferredAdd, contractRecognised);
    const billed = revenue - deferredRelease + deferredAdd;
    const closingReceivables = billed * RECEIVABLE_SHARE;
    const collections = openingReceivables + billed - closingReceivables;

    // Depreciation is the only non-cash charge, and it is split across the two
    // buckets the compute cost was split into. Both halves must be excluded from
    // the cash that actually leaves. `depreciationInCogs` was computed with the
    // sector adjustment above, which is deliberately cash-only for this reason.
    // The three non-cash pieces sum to `depreciation` exactly, in both worlds:
    // world 2 splits it between cost of goods and research, world 3 splits it
    // between cost of goods, research and the idle line.
    const depreciationInRd = nodeEconomy ? depreciationInRdWorld3 : depreciation - depreciationInCogs;
    const cogsCash = Math.max(0, cogs - depreciationInCogs);
    const rdCash = Math.max(0, rdSpend - depreciationInRd);
    const idleCash = Math.max(0, idleCapacityUsd - idleDepreciation);
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
    const discretionaryCapex = money(purchases.reduce((total, purchase) => total + purchase.totalUsd, 0) + capacityCapexUsd);
    // Custody is entirely cash: there is no asset being written down, only a
    // bill for holding one.
    const cashOutBeforeMaintenance =
      cogsCashPaid + payrollBooked + marketing + rdCash + idleCash + dataCustodyUsd + interestExpense + tax + debtRepayment + discretionaryCapex;

    /*
     * SUSTAINING CAPITAL, world 3's own.
     *
     * A plant wears out. Property, plant and equipment is written down five
     * percent a quarter and the capacity buckets decay with it, and until this
     * existed NOTHING in world 3 ever put a dollar back: `sustainingCapitalUsd`
     * is a world-2 charge the node economy deliberately zeroed, on the grounds
     * that the roll-up's capacity line already prices capital per unit — which
     * it does, but pricing the use of an asset is not replacing it. Left alone,
     * every capacity-bound line in the world lost more than half its output in
     * sixteen quarters (0.95^16 = 0.44) while the talent market pushed its wage
     * bill up, so a founder who did nothing watched a solvent company become an
     * insolvent one for a reason nothing on any screen named. Four of fifteen
     * opening backgrounds died of exactly this.
     *
     * So a company that still has a line to make reinvests what the quarter
     * wrote off, and its capacity holds. It is capital, not cost: cash falls and
     * property rises by the same figure, equity does not move, and the gate
     * below sees the matched pair it sees for a purchased accelerator.
     *
     * Bounded by what is actually in the bank once every obligation is settled.
     * A company that cannot pay for maintenance does not do it, and its capacity
     * shrinks — which is a real consequence a player can see, act on and finance
     * their way out of, rather than a silent tax on doing nothing.
     */
    const maintainable = nodeEconomy && activeProducts(company).some((product) => lineNodeIdOf(product) !== null);
    const fundableMaintenanceUsd = Math.max(0, openingCash + collections - cashOutBeforeMaintenance) * SUSTAINING_CAPITAL_CASH_SHARE;
    const maintenanceCapexUsd = maintainable ? money(Math.min(depreciation, fundableMaintenanceUsd)) : 0;
    const maintenanceShare = depreciation > 0 ? maintenanceCapexUsd / depreciation : 0;
    const capex = money(discretionaryCapex + maintenanceCapexUsd);
    const cashOut = cashOutBeforeMaintenance + maintenanceCapexUsd;
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
      // Sustaining capital lands on the bucket it maintained, at the share of
      // the quarter's write-off the company could actually afford. A company
      // that paid for all of it holds its capacity exactly; one that paid for
      // none of it decays exactly as it always did.
      const held = PPE_DEPRECIATION_PER_QUARTER * maintenanceShare;
      company.capacity.plantUsd = money(Math.max(0, company.capacity.plantUsd * (decay + held)) + investedByKind.plant);
      company.capacity.fleetUsd = money(Math.max(0, company.capacity.fleetUsd * (decay + held)) + investedByKind.fleet);
      company.capacity.gridUsd = money(Math.max(0, company.capacity.gridUsd * (decay + held)) + investedByKind.grid);
      if (capacityInvestments.length > 0) company.capacity.pendingInvestments = [];
    }
    sheet.liabilities.payables = money(closingPayables);
    sheet.liabilities.deferredRevenue = money(Math.max(0, openingDeferred + deferredAdd - deferredRelease));
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
      payroll: money(payrollBooked),
      marketing: money(marketing),
      rdSpend: money(rdSpend),
      capex,
      interestExpense: money(interestExpense),
      cash: sheet.assets.cash,
      debt: sheet.liabilities.debt,
      quarterlyBurn,
      deferredRevenue: sheet.liabilities.deferredRevenue,
      backlogUsd: money(backlog),
      // Stated only in world 3, so a world-1 or world-2 company never grows the
      // key and both frozen worlds keep hashing to what they always hashed to.
      ...(nodeEconomy ? { idleCapacityUsd: money(idleCapacityUsd), dataCustodyUsd: money(dataCustodyUsd) } : {}),
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
        payrollUsd: money(payrollBooked),
        marketingUsd: money(marketing),
        rdSpendUsd: money(rdSpend),
        // World-3 keys only: the reconstruction in `resolver/invariants.ts`
        // reads `idleCapacityUsd` when it is there and adds nothing when it is
        // not, so a world-1 row is the row it has always been.
        ...(nodeEconomy
          ? {
              idleCapacityUsd: money(idleCapacityUsd),
              dataCustodyUsd: money(dataCustodyUsd),
              nodeCogsUsd: money(nodeCogs),
              labourInCogsUsd: money(labourInCogs),
              capacityInCogsUsd: money(capacityInCogs),
              capacityChargeUsd: money(capacityChargeUsd),
            }
          : {}),
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
    // Sustaining capital is a mutation of its own — cash out, property in — so
    // it gets its own row rather than hiding inside the cost row above, which
    // states charges against income and nothing else. `kind` marks it as the
    // staging row it is for the financial reconstruction: it moves no equity.
    if (maintenanceCapexUsd > 0) {
      const maintenanceEventId = emitEvent(
        draft,
        ctx,
        'capacity_invested',
        company.id,
        null,
        {
          companyId: company.id,
          kind: 'maintenance',
          amountUsd: maintenanceCapexUsd,
          writtenOffUsd: money(depreciation),
          heldSharePct: Math.round(maintenanceShare * 100),
        },
        'company',
      );
      // Only worth a line when the company is losing real capacity over it.
      // Holding capacity flat is the ordinary case, a few points of slippage is
      // noise, and a phone has better things to print.
      if (maintenanceShare < MAINTENANCE_REPORT_SHARE) {
        ctx.log({
          phase: 'financial_resolution',
          text: `${company.name} put ${usdLabel(maintenanceCapexUsd)} back into capacity against the ${usdLabel(depreciation)} it wrote off, so its plant, fleet and compute shrink by the difference.`,
          deltaLabel: `${Math.round(maintenanceShare * 100)}% held`,
          refEventIds: [maintenanceEventId],
          tone: 'warning',
          subjectId: company.id,
        });
      }
    }
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
      // What other companies paid this one is revenue like any other and has to
      // appear, or the rows would not sum to the total they sit under.
      if (nodeEconomy && Math.round(interCompanyRevenue) !== 0) {
        priceRows.push(stackRow('intercompany', 'Sold to other companies', 'network', interCompanyRevenue, grossRevenue, revenueEventId, 'price'));
      }
      priceStacks.push({
        companyId: company.id,
        quarter: ctx.quarter,
        kind: 'price',
        baseUsd: money(grossRevenue),
        totalUsd: money(revenue),
        netPct: pctOfBase(revenue - grossRevenue, grossRevenue),
        rows: priceRows,
      });

      // The energy line already sits inside the cash cost of goods, so the base
      // is stated at a neutral energy index and the deviation is its own row.
      // World 3's energy cost is the power line of each unit cost, struck on the
      // grid node's own market price, and its input prices are the node
      // market's. None of the three world-2 deviations below is in its cost of
      // goods, so none of them is claimed as a row: the stack states what the
      // engine actually multiplied, and nothing else.
      const energyInCogs = nodeEconomy ? 0 : compute.energyUsd * compute.servingShare;
      const energyPriceEffect = energyInCogs * (1 - SECTOR_PRICE_BASELINE / Math.max(1, economy.energy.priceIndex));
      const costBase = cashCogsBeforeSector - energyPriceEffect;
      const inputPriceUsd = nodeEconomy ? 0 : (sector.inputPriceFactor - 1) * cashCogsBeforeSector;
      const sectorConditionsUsd = nodeEconomy ? 0 : (sector.inputCostMultiplier - sector.inputPriceFactor) * cashCogsBeforeSector;
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
        payrollUsd: payrollBooked,
        marketingUsd: marketing,
        researchUsd: rdSpend,
        idleCapacityUsd,
        dataCustodyUsd,
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

    // Capacity the company owns and production did not absorb. Said out loud,
    // because it is the charge a founder can actually do something about:
    // sell more, or stop paying for a bucket nothing is drawing on.
    if (nodeEconomy && idleCapacityUsd >= 1 && idleCapacityUsd > capacityChargeUsd * IDLE_CAPACITY_REPORT_SHARE) {
      const idleEventId = emitEvent(
        draft,
        ctx,
        'cost_recognised',
        company.id,
        null,
        {
          kind: 'idle_capacity',
          idleCapacityUsd: money(idleCapacityUsd),
          capacityChargeUsd: money(capacityChargeUsd),
          absorbedUsd: money(capacityInCogs),
          utilisationPct: Math.round(ratio(capacityInCogs, Math.max(1, capacityChargeUsd)) * 100),
        },
        'company',
      );
      ctx.log({
        phase: 'financial_resolution',
        text: `${company.name} paid ${usdLabel(idleCapacityUsd)} for capacity nothing was made on: ${Math.round(ratio(capacityInCogs, Math.max(1, capacityChargeUsd)) * 100)}% of what it owns was used.`,
        deltaLabel: usdLabel(-idleCapacityUsd),
        refEventIds: [idleEventId],
        tone: 'warning',
        subjectId: company.id,
      });
    }

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
