/**
 * @frontier/simulation — graph/production.ts
 *
 * World 3's demand and production pass: how many units of its node each line
 * actually ships this quarter, at what unit cost, and what that leaves behind
 * as backlog, installed base and contracted book.
 *
 * It replaces the world-2 demand model for node lines and nothing else. World 1
 * and world 2 never reach this file — `isNodeEconomyWorld` is the single gate,
 * in `resolveProducts` — and a world-3 product that carries no `nodeId` is not a
 * node line and is resolved by the world-2 pass exactly as before.
 *
 * ## The three sale kinds
 *
 * | kind        | what a unit is                | how it is allocated                |
 * |-------------|-------------------------------|------------------------------------|
 * | `recurring` | a seat, served every quarter  | the world-2 gross-adds/churn model |
 * | `unit`      | a durable good, shipped once  | share of an order pool             |
 * | `contract`  | a term deal, part-paid up front| share of an order pool, bounded by the capacity that must serve the whole live book |
 *
 * `recurring` is deliberately the model it always was — the base persists,
 * churn applies, revenue is the base times the price — with two corrections:
 * the price is judged against **its own node's market price** rather than
 * against the customer-weighted mean of every product in its buyer segment
 * across all six sectors, and capacity rations it in units of the node rather
 * than in dollar-millions against reference-priced counts.
 *
 * `unit` and `contract` run on market share of an order pool, which is the
 * right shape for a durable good and for a term deal: attractiveness decides
 * who wins the orders, capacity decides how many of them can be filled, and the
 * rest becomes **visible backlog** — which is what makes building capacity
 * obviously worth doing.
 *
 * ## What is booked, and where
 *
 * Nothing here moves cash or touches a balance sheet. The pass *stamps* the
 * quarter onto each line — `unitsSoldQuarterly`, `unitCostUsd`,
 * `contractBilledUsd`, `installedBase`, `backlogUnits` — and the financial
 * phase books exactly those numbers. That is the whole of the fix for world 2,
 * where per-product margin was computed from compute cost alone and disagreed
 * with the income statement it sat beside.
 *
 * ## Determinism
 *
 * One RNG draw per node line, in company order then product order, taken in a
 * first pass before any allocation, so the sequence cannot depend on the
 * allocation it feeds. Everything else is a pure function of the draft.
 */

import type { Company, EconomicNode, NodeCostCache, Product, ProductSegment, ResolverContext, SessionState, UnitCostResult } from '@frontier/contracts';
import { economicNodeById } from '@frontier/contracts';
import { formatMoney } from '@frontier/shared';
import {
  CAPACITY_BASE_LOSS_CEILING,
  CAPACITY_SHORTFALL_CHURN,
  DEMAND_NOISE_BAND,
  SEGMENT_BASE_ADD_RATE,
  SEGMENT_REPUTATION_AUDIENCE,
  SEGMENT_SEED_POOL,
} from '../companies/balance';
import { emitPartialFill } from '../companies/partialFill';
import {
  heldComputeUnits,
  marketingLift,
  priceFactor,
  priceSaturationDecay,
  productChurn,
  qualityFactorOf,
  relativePrice,
  reputationFactorOf,
} from '../companies/products';
import { activeCompanies, activeProducts, clamp, count, emitEvent, money, pctLabel, ratio, segmentReputation, unit } from '../companies/util';
import { unitCostOf } from './cost';
import { dataPolicyOf, dataQualityUplift, resolveNodeData, sellableDataUnits, DATA_POLICY_CHURN } from './data';
import { createNodeCostCache, drawPerUnitOf, lineNodeIdOf, lineNodeOf, qualityTierFactor } from './lines';
import { endDemandUnits, nodeBalances, producibleUnits, type NodeBalance } from './market';

/* -------------------------------------------------------------------------- */
/*  Constants                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * How much of an unfilled order still wants to be filled next quarter.
 *
 * Half the disappointed buyers wait and half go elsewhere. Below one it is a
 * queue that drains; at one it would be a queue that never forgets, and a
 * single bad quarter would haunt a line forever.
 */
export const BACKLOG_CARRY = 0.5;

/** How many quarters a durable line's base is assumed to last when its node declares none. */
export const DEFAULT_LIFETIME_QUARTERS = 12;

/** Backlog past this many units is worth a report line of its own. */
export const BACKLOG_REPORT_UNITS = 1;

/**
 * How many quarters of its own output a line may take orders for.
 *
 * An order book is not the world's appetite. A buyer places an order with a
 * supplier who can plausibly deliver it, and waits a year at the outside; it
 * does not queue behind twenty-five billion parcels at a courier shipping a
 * quarter of a million a quarter. Without this bound `share x pool` had no
 * relation to what the company could ever build, the unfilled remainder was
 * recorded as backlog, half of it carried back into the pool the next quarter,
 * and the figure compounded to eleven digits on the screen the owner asked to
 * be easy to read.
 *
 * Four: this quarter's delivery plus a year of queue. Demand past it is not
 * lost to the world — it stays in the node's own pool for whoever builds the
 * capacity to take it — it is simply not on this line's books.
 */
export const ORDER_BOOK_QUARTERS = 4;

/**
 * How many quarters of a term contract the customer pays for on signature.
 *
 * A term contract really does bring cash forward — that is most of what makes
 * it a different instrument from a seat — but it does not bring the whole term
 * forward. Nobody pays five years of a power purchase agreement on the day it
 * is signed; a megawatt is billed as it is delivered, against at most a year
 * taken in advance.
 *
 * Billing the whole term was the single largest number in a sixteen-quarter
 * autopilot probe: a grid developer opened with twelve million dollars of cash
 * and closed its FIRST quarter with a hundred and eighty-nine million, because
 * a hundred and one megawatt-quarters at $118,000 were billed twenty times over
 * on the day they were signed. Every dollar of it was properly matched by
 * deferred revenue, so the double-entry gate had nothing to say — it was not a
 * torn transaction, it was a real liability for a prepayment no customer makes.
 *
 * The rest of the term is billed as it is delivered, by the same arithmetic:
 * `billed = revenue - deferredRelease + deferredAdd` charges whatever this
 * quarter recognised and did not take in advance.
 */
export const CONTRACT_ADVANCE_QUARTERS = 4;

/**
 * How much craft a line left alone loses every quarter.
 *
 * Two points, multiplicatively, so a line never goes negative and never
 * ratchets. World 2 set `qualityScore` at launch and never revisited it, so a
 * product could sit still for ten years and stay at the frontier; here standing
 * still is falling behind, and the way back is research — which is exactly the
 * lever `achieveOwnedNodes` moves.
 */
export const QUALITY_DECAY = 0.02;

/**
 * The least a line can be cut to by an input shortage.
 *
 * The same floor, and the same number, as world 2's sector supply gate
 * (`SUPPLY_GATE_FLOOR`), for the same reason it gives: contracts, inventory and
 * substitution all take time to fail, so a line whose inputs have collapsed
 * still ships three quarters of what its capacity allows — and pays the node
 * market's own price for the scarcity, which by then is near the top of the
 * input's band. Scarcity is expressed as price first and quantity second,
 * because twenty-five companies are not the whole economy and a buyer short of
 * a modelled supplier can still import, dearly.
 *
 * A line with an input *nobody in the world can make at all* is a different
 * thing and ships nothing; that is `blocked`, decided by the roll-up.
 */
export const INPUT_FILL_FLOOR = 0.75;

/**
 * How much of its customer base a line has to lose in one quarter before the
 * ledger says so out loud.
 *
 * Half. Below that it is a bad quarter and the demand row already carries the
 * numbers; at or beyond it the business has changed shape and the founder is
 * owed a sentence saying which of the three things went wrong — the inputs, the
 * capacity, or the customers.
 *
 * The case this exists for: a frontier laboratory ran one $39M licence a
 * quarter profitably for eleven quarters, its compute reservation lapsed at
 * quarter twelve, its only line could produce nothing ever again, and the
 * quarter report said NOTHING. Revenue went to zero, cash decayed for four
 * years, and no row in the ledger named the cause.
 */
export const LINE_COLLAPSE_FALL = 0.5;

/* -------------------------------------------------------------------------- */
/*  One line's draft                                                           */
/* -------------------------------------------------------------------------- */

/** Everything decided about one line before allocation, and after it. */
interface LineDraft {
  readonly company: Company;
  readonly product: Product;
  readonly node: EconomicNode;
  readonly segment: ProductSegment;
  readonly priceUsd: number;
  readonly marketPriceUsd: number;
  readonly cost: UnitCostResult;
  /** True when a non-substitutable input has no source at all: the line ships nothing. */
  readonly blocked: boolean;
  /** How much of this line's inputs the world can actually supply, 0..1. */
  readonly inputFill: number;
  /** Delivered quality: what it is built to, scaled by the one quality lever. */
  readonly quality: number;
  /** How far this line's quality sits from the best on offer for its own node. */
  readonly qualityEdge: number;
  /** Units capacity and inputs together allow. */
  readonly producible: number;
  /** What the world still wants of this node this quarter, in units. */
  readonly demandUnits: number;
  /** How this line competes for the pool. Zero for a blocked line. */
  readonly attractiveness: number;
  readonly marketingUsd: number;
  readonly shock: number;
  readonly noise: number;
}

/** What the action pass leaves for this one, flattened out of the world-2 staging. */
export interface StagedLineInputs {
  /** Marketing dollars behind each product this quarter, keyed by product id. */
  readonly marketingByProduct: ReadonlyMap<string, number>;
  /** How hard each product was repriced this quarter, keyed by product id. */
  readonly shockByProduct: ReadonlyMap<string, number>;
}

/** The quality this line actually delivers: what it is built to, through the one lever. */
export function deliveredQuality(product: Product): number {
  const craft = product.craftQuality ?? product.qualityScore;
  return unit(craft * qualityTierFactor(product));
}

/**
 * THE quality function, recomputed every quarter.
 *
 * Three terms, and every one of them can move between quarters, which is the
 * whole difference from world 2's `qualityScore` — set at launch and never
 * revisited, so a breakthrough never improved anything a company already sold:
 *
 * 1. **Craft through the tier lever.** What the line is built to, scaled by the
 *    one lever that also scales what a unit draws on capacity.
 * 2. **The data edge.** `DATA_QUALITY_MAX x pb/(pb + DATA_HALF_PB)` on the
 *    company's pool in this node's sector: what it has learned from its own
 *    customers, bounded and saturating.
 * 3. **What its suppliers ship.** Weighted by **bill-of-materials value share**
 *    — each input's share of the input cost of one unit — not by world 2's
 *    deleted `share`-of-revenue. A company whose die is nine tenths of its
 *    package's cost inherits nine tenths of that supplier's quality, which is
 *    what buying the cheap part actually means.
 */
export function effectiveQuality(state: SessionState, company: Company, product: Product, node: EconomicNode, cost: UnitCostResult): number {
  const base = unit(deliveredQuality(product) + dataQualityUplift(company, node.sector));

  const inputs = cost.lines.filter((line) => line.sourceKind === 'buy' && line.sourceCompanyId !== null);
  let inputValue = 0;
  for (const line of cost.lines) if (line.sourceKind !== 'conversion') inputValue += Math.max(0, line.amountUsd);
  if (inputs.length === 0 || inputValue <= 0) return base;

  let blended = base;
  for (const line of inputs) {
    const supplier = state.companies.find((candidate) => candidate.id === line.sourceCompanyId);
    if (supplier === undefined) continue;
    const supplierLine = supplier.products.find((candidate) => candidate.isActive && lineNodeIdOf(candidate) === line.key);
    if (supplierLine === undefined) continue;
    const weight = Math.max(0, line.amountUsd) / inputValue;
    blended += weight * (deliveredQuality(supplierLine) - base);
  }
  return unit(blended);
}

/**
 * How much of this line's inputs the world can supply, 0..1.
 *
 * The tightest non-substitutable input decides: a line whose die supply covers
 * two-thirds of what it wants ships two-thirds of what capacity would allow. A
 * substitutable input never binds, because that is what substitutable means,
 * and neither does an input no company in this world produces — that one is
 * imported and its balance reads as fully supplied.
 */
export function inputFillRatio(node: EconomicNode, balances: Readonly<Record<string, NodeBalance>>): number {
  let fill = 1;
  for (const input of node.consumes) {
    if (input.substitutable) continue;
    const balance = balances[input.nodeId];
    if (balance === undefined) continue;
    if (balance.fillRatio < fill) fill = balance.fillRatio;
  }
  return clamp(fill, INPUT_FILL_FLOOR, 1);
}

/* -------------------------------------------------------------------------- */
/*  The pass                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Resolve every node line in the world for one quarter.
 *
 * Three passes, and the split is load-bearing: the first draws the noise and
 * reads the world as it stands *before* anything is written, the second
 * allocates each node's order pool across the lines competing for it (which
 * cannot be done one company at a time and stay order-independent), and the
 * third writes the result back.
 */
export function resolveNodeProduction(draft: SessionState, ctx: ResolverContext, staged: StagedLineInputs): void {
  // Balances are read before a single line is written, so derived demand is
  // genuinely last quarter's output and this quarter's allocation cannot feed
  // back into the pool it is being allocated from.
  const balances = nodeBalances(draft);
  // A fresh cache: this phase has already launched and sunset lines, so the
  // snapshot the recorder built at the top of the resolution is stale by
  // exactly those lines.
  const cache: NodeCostCache = createNodeCostCache(draft);
  // The cache's own index and one company lookup, built once: `producibleUnits`
  // would otherwise scan the company list for every line in the world.
  const linesByCompany = cache.linesByCompany;
  const companiesById = new Map(draft.companies.map((company) => [company.id, company]));

  /* --- pass one: draft every line ---------------------------------------- */
  const drafts: LineDraft[] = [];
  const frontierByNode = new Map<string, number>();
  const staging: {
    company: Company;
    product: Product;
    node: EconomicNode;
    cost: UnitCostResult;
    quality: number;
    noise: number;
  }[] = [];

  for (const company of activeCompanies(draft)) {
    for (const product of activeProducts(company)) {
      const node = lineNodeOf(product);
      if (node === undefined) continue;
      // One draw per line, here, in company order then product order.
      const noise = ctx.rng.range(DEMAND_NOISE_BAND.min, DEMAND_NOISE_BAND.max);
      // Standing still is falling behind. The decay is struck before the
      // quarter's quality is read, so a line the founder has not touched is
      // measured at what it is now rather than at what it was when it launched.
      product.craftQuality = unit((product.craftQuality ?? product.qualityScore) * (1 - QUALITY_DECAY));
      // The roll-up is needed before quality, because quality blends what this
      // line's suppliers ship by bill-of-materials value share, and the value
      // shares come out of the roll-up.
      const cost = unitCostOf(draft, company, node.id, cache);
      const quality = effectiveQuality(draft, company, product, node, cost);
      const best = frontierByNode.get(node.id) ?? 0;
      if (quality > best) frontierByNode.set(node.id, quality);
      staging.push({ company, product, node, cost, quality, noise });
    }
  }

  for (const entry of staging) {
    const { company, product, node, cost, quality, noise } = entry;
    const segment = node.buyerSegment ?? product.segment;
    const priceUsd = Math.max(0, product.pricePerSeat);
    const marketPriceUsd = balances[node.id]?.priceUsd ?? 0;
    const blocked = cost.blockedInputNodeIds.length > 0;
    const inputFill = blocked ? 0 : inputFillRatio(node, balances);

    const lineRef = (linesByCompany.get(company.id) ?? []).find((candidate) => candidate.productId === product.id);
    const capacityUnits = lineRef === undefined ? 0 : producibleUnits(draft, lineRef, linesByCompany, companiesById);
    // A dataset line is capped by the pool it sells out of: a corpus you have
    // not collected is a corpus you cannot sell. That is the whole of "data is
    // a node you can sell" — no second lever anywhere.
    const stockUnits = sellableDataUnits(company, node);
    const producible = blocked ? 0 : Math.min(capacityUnits * inputFill, stockUnits);

    const marketingUsd = staged.marketingByProduct.get(product.id) ?? 0;
    const shock = staged.shockByProduct.get(product.id) ?? 0;

    const frontier = frontierByNode.get(node.id) ?? quality;
    const qualityEdge = quality - frontier;
    const qualityFactor = qualityFactorOf(qualityEdge);
    const price = priceFactor(segment, priceUsd, marketPriceUsd, node.elasticity);
    const reputation = segmentReputation(company, SEGMENT_REPUTATION_AUDIENCE[segment]);
    const reputationFactor = reputationFactorOf(reputation);
    const lift = marketingLift(marketingUsd, (product.unitsSoldQuarterly ?? product.activeCustomers) * priceUsd);
    const saturation = priceSaturationDecay(priceUsd, marketPriceUsd);
    const attractiveness = blocked ? 0 : Math.max(0, qualityFactor * price * reputationFactor * lift * noise * saturation);

    drafts.push({
      company,
      product,
      node,
      segment,
      priceUsd,
      marketPriceUsd,
      cost,
      blocked,
      inputFill,
      quality,
      qualityEdge,
      producible,
      demandUnits: Math.max(0, balances[node.id]?.demandUnits ?? 0),
      attractiveness,
      marketingUsd,
      shock,
      noise,
    });
  }

  /* --- pass two: allocate each node's order pool -------------------------- */
  // Only `unit` and `contract` lines share a pool; a recurring line keeps its
  // own base and is resolved line by line in pass three.
  const poolByNode = new Map<string, number>();
  const attractionByNode = new Map<string, number>();
  const countByNode = new Map<string, number>();
  const backlogByNode = new Map<string, number>();
  for (const entry of drafts) {
    if (entry.node.saleKind === 'recurring') continue;
    attractionByNode.set(entry.node.id, (attractionByNode.get(entry.node.id) ?? 0) + entry.attractiveness);
    countByNode.set(entry.node.id, (countByNode.get(entry.node.id) ?? 0) + 1);
    backlogByNode.set(entry.node.id, (backlogByNode.get(entry.node.id) ?? 0) + Math.max(0, entry.product.backlogUnits ?? 0));
  }
  for (const [nodeId, backlog] of backlogByNode) {
    const balance = balances[nodeId];
    poolByNode.set(nodeId, Math.max(0, (balance?.demandUnits ?? 0) + backlog * BACKLOG_CARRY));
  }

  /* --- pass three: settle, stamp and say so ------------------------------- */
  for (const entry of drafts) {
    if (entry.node.saleKind === 'recurring') settleRecurring(draft, ctx, entry);
    else settleOrders(draft, ctx, entry, poolByNode, attractionByNode, countByNode);
  }

  /* --- pass four: utilisation follows what was actually made -------------- */
  // Only compute-kind lines draw on held accelerators; a plant, fleet or grid
  // line is served by its own bucket and would otherwise inflate this figure
  // for free.
  for (const company of activeCompanies(draft)) {
    const held = heldComputeUnits(draft, company);
    if (held <= 0) continue;
    let used = 0;
    for (const product of activeProducts(company)) {
      const node = lineNodeOf(product);
      if (node === undefined || node.capacityKind !== 'compute') continue;
      used += Math.max(0, product.unitsSoldQuarterly ?? 0) * drawPerUnitOf(node, product);
    }
    const training = held * unit(company.compute.trainingAllocation);
    company.compute.computeUtilisation = unit(ratio(used + training, held));
  }

  /* --- pass five: what the quarter's customers left behind ---------------- */
  // Data accrues from what was actually served, so it runs after the lines are
  // stamped and inside the same phase. It draws no random number, so it cannot
  // move any other phase's call sequence.
  resolveNodeData(draft, ctx);
}

/* -------------------------------------------------------------------------- */
/*  Recurring: the world-2 model, against its own node's price                  */
/* -------------------------------------------------------------------------- */

function settleRecurring(draft: SessionState, ctx: ResolverContext, entry: LineDraft): void {
  const { company, product, node, segment } = entry;
  const before = product.activeCustomers;
  const priceEdge = relativePrice(entry.priceUsd, entry.marketPriceUsd);
  const reputation = segmentReputation(company, SEGMENT_REPUTATION_AUDIENCE[segment]);

  // What the company collects is felt by the people it collects from. Consumer
  // lines only: an enterprise buyer's contract already says what may be taken,
  // so the surprise, and the churn, is the consumer's. Applied here because
  // this is the only sale kind whose churn decides anything — a durable good's
  // stamped churn is a reading, not a lever.
  const policyChurn = segment === 'consumer' ? DATA_POLICY_CHURN[dataPolicyOf(company)] : 0;
  const churn = entry.blocked
    ? 1
    : clamp(productChurn(segment, entry.qualityEdge, priceEdge, reputation, 0, entry.shock, node.churnBand, node.elasticity) + policyChurn, 0, 1);
  const retained = entry.blocked ? 0 : before * (1 - churn);
  const seed = SEGMENT_SEED_POOL[segment];
  const addRate = SEGMENT_BASE_ADD_RATE[segment];
  const grossAdds = entry.blocked ? 0 : Math.max(0, (before + seed) * addRate * entry.attractiveness * 2 * demandLevel(draft, node));
  const desired = retained + grossAdds;

  // Capacity rations exactly as it always did, and now in units of the node:
  // new demand is refused outright and the base drains at a bounded rate.
  const capacityRatio = desired <= 0 ? 1 : Math.min(1, ratio(entry.producible, desired, 1));
  const baseRetention = 1 - CAPACITY_BASE_LOSS_CEILING * (1 - capacityRatio);
  const allowed = Math.min(desired, grossAdds * capacityRatio + retained * baseRetention);
  const shortfall = unit(ratio(desired - allowed, Math.max(1, desired)));
  const units = count(Math.max(0, allowed));

  stampLine(draft, ctx, entry, {
    units,
    ordersDesired: desired,
    backlogUnits: 0,
    installedBase: 0,
    contractBilledUsd: 0,
    contractRemainingQuarters: null,
    churn: unit(shortfall > 0 ? Math.min(0.95, churn + CAPACITY_SHORTFALL_CHURN * shortfall) : churn),
    growth: clamp(ratio(grossAdds, Math.max(1, before)), -1, 5),
    before,
  });
}

/**
 * The world's appetite for this node's segment and sector this quarter, as a
 * multiplier around 1. The same signal `endDemandUnits` applies to the pool,
 * applied here to the one kind that does not draw on a pool.
 */
function demandLevel(draft: SessionState, node: EconomicNode): number {
  const base = node.endDemandBaseUnits;
  if (base <= 0) return 1;
  // `endDemandUnits` already carries appetite and the sector cycle; dividing by
  // the node's own baseline turns it back into the multiplier around 1 that the
  // gross-adds model expects, so the two readings cannot drift.
  const balance = endDemandUnits(draft, node);
  return clamp(balance / base, 0.35, 2);
}

/* -------------------------------------------------------------------------- */
/*  Unit and contract: share of an order pool                                  */
/* -------------------------------------------------------------------------- */

/**
 * How much of a term line's book is still live: units the company has already
 * committed to deliver every quarter until their term runs out.
 *
 * Zero once the blended remaining term has run to nothing, which is how a book
 * with no new signings runs off.
 */
export function liveContractBookOf(product: Product): number {
  const remaining = Math.max(0, product.contractRemainingQuarters ?? 0);
  return remaining > 0 ? Math.max(0, product.activeCustomers) : 0;
}

function settleOrders(
  draft: SessionState,
  ctx: ResolverContext,
  entry: LineDraft,
  poolByNode: ReadonlyMap<string, number>,
  attractionByNode: ReadonlyMap<string, number>,
  countByNode: ReadonlyMap<string, number>,
): void {
  const { product, node } = entry;
  const before = product.activeCustomers;
  const pool = poolByNode.get(node.id) ?? 0;
  const attraction = attractionByNode.get(node.id) ?? 0;
  const producers = Math.max(1, countByNode.get(node.id) ?? 1);
  // A pool nobody attracts is split evenly rather than dropped: every line on
  // it is equally unappealing, which is not the same as nobody wanting any.
  const share = attraction > 0 ? entry.attractiveness / attraction : entry.blocked ? 0 : 1 / producers;
  // Bounded by what this line could actually build in a year, never by the
  // world's whole appetite: an order book a company can never work through is
  // not an order book. See `ORDER_BOOK_QUARTERS`.
  const orderBookCeiling = Math.max(0, entry.producible) * ORDER_BOOK_QUARTERS;
  const ordersDesired = Math.min(Math.max(0, share * pool), orderBookCeiling);
  // A durable good is built and shipped this quarter, so capacity bounds what
  // SHIPPED. A term contract is a standing commitment to deliver every quarter
  // of its term, so capacity bounds what may be COMMITTED — this quarter's
  // signings plus everything already on the book. Bounding only the signings,
  // as this did, let a grid developer with capacity for a hundred
  // megawatt-quarters sign a hundred every quarter and end up serving eleven
  // hundred out of a plant that was itself depreciating: revenue thirteen times
  // its opening run rate in four years, out of physical capacity that had
  // halved. `signable` is the whole of the correction and it is the same rule
  // the recurring path already applies to its base.
  const liveCommitment = node.saleKind === 'contract' ? liveContractBookOf(product) : 0;
  const signable = node.saleKind === 'contract' ? Math.max(0, entry.producible - liveCommitment) : Math.max(0, entry.producible);
  const units = count(Math.min(ordersDesired, signable));
  const unfilled = Math.max(0, ordersDesired - units);

  // A durable base grows by what shipped and retires one lifetime's worth a
  // quarter; that retirement is next quarter's replacement demand, read back by
  // `nodeBalances`.
  const lifetime = Math.max(1, node.lifetimeQuarters ?? DEFAULT_LIFETIME_QUARTERS);
  const openingBase = Math.max(0, product.installedBase ?? 0);
  const installedBase = node.saleKind === 'unit' ? Math.max(0, openingBase + units - openingBase / lifetime) : 0;

  // A contract is billed for its whole term the quarter it is signed and
  // recognised a quarter at a time. The book's remaining term is the
  // unit-weighted blend of what was already on it and what was signed today.
  let contractBilledUsd = 0;
  let contractRemaining: number | null = null;
  let servicedUnits = units;
  if (node.saleKind === 'contract') {
    const term = Math.max(1, node.contractQuarters ?? 1);
    const remainingBefore = Math.max(0, product.contractRemainingQuarters ?? 0);
    const liveBefore = liveCommitment;
    const book = liveBefore + units;
    // Signed today, paid a year in advance and delivered for the rest of the
    // term. See `CONTRACT_ADVANCE_QUARTERS`.
    contractBilledUsd = money(units * entry.priceUsd * Math.min(term, CONTRACT_ADVANCE_QUARTERS));
    const blended = book <= 0 ? 0 : (liveBefore * remainingBefore + units * term) / book;
    // This quarter is one of the term's quarters: the whole live book is
    // serviced and recognised, and the book ages by one.
    servicedUnits = count(book);
    contractRemaining = Math.max(0, blended - 1);
    if (contractRemaining <= 0) contractRemaining = 0;
  }

  stampLine(draft, ctx, entry, {
    units: servicedUnits,
    ordersDesired,
    backlogUnits: count(unfilled),
    installedBase: count(installedBase),
    contractBilledUsd,
    contractRemainingQuarters: contractRemaining,
    churn: unit(node.churnBand.min),
    growth: clamp(ratio(servicedUnits - before, Math.max(1, before)), -1, 5),
    before,
  });

  if (unfilled >= BACKLOG_REPORT_UNITS) {
    emitPartialFill(draft, ctx, entry.company.id, {
      actionType: 'produce_node_line',
      asked: ordersDesired,
      got: units,
      unit: node.unitLabel,
      reason: entry.blocked
        ? `A required input of ${node.label} has no source at all: nobody in the world makes it and it cannot be substituted.`
        : entry.inputFill < 0.999
          ? `${node.label} is short of inputs: the tightest one covers ${Math.round(entry.inputFill * 100)}% of what the line wanted.`
          : `${entry.company.name} has capacity for ${Math.round(units)} of ${node.unitLabel} a quarter.`,
      phase: 'product_demand_resolution',
      targetId: entry.product.id,
      line: `${entry.product.name} took orders for ${Math.round(ordersDesired)} ${node.unitLabel} and shipped ${Math.round(units)}; ${Math.round(unfilled)} are unfilled and carry into next quarter.`,
    });
  }
}

/* -------------------------------------------------------------------------- */
/*  Writing the quarter back                                                   */
/* -------------------------------------------------------------------------- */

interface Settlement {
  readonly units: number;
  readonly ordersDesired: number;
  readonly backlogUnits: number;
  readonly installedBase: number;
  readonly contractBilledUsd: number;
  readonly contractRemainingQuarters: number | null;
  readonly churn: number;
  readonly growth: number;
  readonly before: number;
}

/**
 * Stamp one line's quarter.
 *
 * `activeCustomers` and `unitsSoldQuarterly` are deliberately the same number
 * in world 3: every reader that multiplied `activeCustomers x pricePerSeat` in
 * world 2 stays right by construction, and the six places that were converted
 * to `unitsSoldQuarterly x pricePerSeat` read the field that says what it is.
 */
function stampLine(draft: SessionState, ctx: ResolverContext, entry: LineDraft, settled: Settlement): void {
  const { company, product, node } = entry;
  const unitCostUsd = money(entry.cost.unitCostUsd);

  product.unitsSoldQuarterly = settled.units;
  product.activeCustomers = settled.units;
  product.backlogUnits = settled.backlogUnits;
  product.installedBase = settled.installedBase;
  product.contractBilledUsd = settled.contractBilledUsd;
  if (settled.contractRemainingQuarters !== null) product.contractRemainingQuarters = settled.contractRemainingQuarters;
  product.unitCostUsd = unitCostUsd;
  // What the line is worth to a buyer NOW: craft after this quarter's decay,
  // what its suppliers ship, and the lift its own customer data bought it. The
  // same number demand was built from, written down so every read path — the
  // Products screen, the valuation, the Chief of Staff's dossier — sees the
  // line as it is rather than as it was the quarter it launched. World 2 set
  // this at launch and never revisited it, so a breakthrough never improved
  // anything the company already sold.
  //
  // It cannot ratchet: the decay above reads `craftQuality`, which this never
  // writes, so quality is stored twice on purpose — the craft the company has
  // built, and what that craft is worth this quarter with everything else
  // taken into account.
  product.qualityScore = unit(entry.quality);
  product.churnQuarterly = settled.churn;
  product.growthQuarterly = settled.growth;
  // The one margin model: 1 - unitCost/price, from the same roll-up the profit
  // and loss books. World 2 computed this from compute cost alone and let it
  // disagree with the income statement it sat beside.
  product.grossMarginPct = unit(entry.priceUsd <= 0 ? 0 : 1 - unitCostUsd / entry.priceUsd);

  const eventId = emitEvent(
    draft,
    ctx,
    'demand_resolved',
    company.id,
    product.id,
    {
      productId: product.id,
      nodeId: node.id,
      saleKind: node.saleKind,
      segment: entry.segment,
      customersBefore: settled.before,
      customersAfter: settled.units,
      unitsSold: settled.units,
      ordersDesired: Math.round(settled.ordersDesired),
      backlogUnits: settled.backlogUnits,
      installedBase: settled.installedBase,
      unitCostUsd,
      priceUsd: money(entry.priceUsd),
      marketPriceUsd: money(entry.marketPriceUsd),
      grossMarginPct: Math.round(product.grossMarginPct * 100),
      revenueUsd: money(settled.units * entry.priceUsd),
      contractBilledUsd: settled.contractBilledUsd,
      marketingUsd: money(entry.marketingUsd),
      churn: product.churnQuarterly,
      inputFillPct: Math.round(entry.inputFill * 100),
      producibleUnits: Math.round(entry.producible),
      supplyBlocked: entry.blocked,
      blockedInputNodeIds: [...entry.cost.blockedInputNodeIds],
    },
    'company',
  );

  /* --- a line that fell off a cliff says why -------------------------------- */
  //
  // Rule §6: an economic fact the founder can act on is a row, not an absence.
  // A base that halves or empties is one of exactly three things, and each has a
  // different lever behind it, so the row names which.
  const collapsed = settled.before > 0 && settled.units <= settled.before * (1 - LINE_COLLAPSE_FALL);
  if (collapsed) {
    const wanted = entry.demandUnits > 0;
    const cause = entry.blocked ? 'input_blocked' : entry.producible <= 0 ? 'no_capacity' : entry.inputFill < 0.999 ? 'input_shortage' : 'demand';
    const collapseEventId = emitEvent(
      draft,
      ctx,
      'information_revealed',
      company.id,
      product.id,
      {
        kind: 'line_collapsed',
        productId: product.id,
        nodeId: node.id,
        cause,
        customersBefore: settled.before,
        customersAfter: settled.units,
        revenueLostUsd: money((settled.before - settled.units) * entry.priceUsd),
        producibleUnits: Math.round(entry.producible),
        demandUnits: Math.round(entry.demandUnits),
        inputFillPct: Math.round(entry.inputFill * 100),
        // The two facts that decide whether this is recoverable, stated rather
        // than left to be inferred from a revenue line that is now zero.
        nodeStillWanted: wanted,
        canStillProduce: entry.producible > 0,
      },
      'company',
    );
    const why =
      cause === 'input_blocked'
        ? `nobody in the world makes ${entry.cost.blockedInputNodeIds.map((id) => economicNodeById(id)?.label ?? id).join(', ')}`
        : cause === 'no_capacity'
          ? `it has no ${node.capacityKind} capacity left to make them on`
          : cause === 'input_shortage'
            ? `its inputs covered only ${Math.round(entry.inputFill * 100)}% of what the line wanted`
            : 'its customers went elsewhere';
    ctx.log({
      phase: 'product_demand_resolution',
      text:
        `${product.name} fell from ${Math.round(settled.before)} to ${Math.round(settled.units)} ${node.unitLabel} because ${why}. ` +
        (wanted
          ? `The world still wants ${Math.round(entry.demandUnits)} ${node.unitLabel} a quarter, so the line can be won back.`
          : `There is no demand left for ${node.label} this quarter.`),
      deltaLabel: pctLabel(ratio(settled.units - settled.before, Math.max(1, settled.before))),
      refEventIds: [collapseEventId, eventId],
      tone: 'negative',
      subjectId: company.id,
    });
  }

  if (entry.blocked) {
    const missing = entry.cost.blockedInputNodeIds.map((id) => economicNodeById(id)?.label ?? id).join(', ');
    ctx.log({
      phase: 'product_demand_resolution',
      text: `${product.name} shipped nothing this quarter: nobody in the world makes ${missing}, and it cannot be substituted. Buy it, licence it or research it.`,
      deltaLabel: `0 ${node.unitLabel}`,
      refEventIds: [eventId],
      tone: 'negative',
      subjectId: company.id,
    });
    return;
  }

  const change = ratio(settled.units - settled.before, Math.max(1, settled.before));
  if (Math.abs(change) >= 0.02) {
    ctx.log({
      phase: 'product_demand_resolution',
      text: `${product.name} shipped ${Math.round(settled.units)} ${node.unitLabel} at ${formatMoney(entry.priceUsd)} against a unit cost of ${formatMoney(unitCostUsd)}.`,
      deltaLabel: pctLabel(change),
      refEventIds: [eventId],
      tone: change >= 0 ? 'positive' : 'negative',
      subjectId: company.id,
    });
  }
}
