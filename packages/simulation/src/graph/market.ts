/**
 * @frontier/simulation — graph/market.ts
 *
 * The node market: one price per node per quarter, for every node in the table.
 *
 * `node_market_resolution` is its own phase and runs immediately before product
 * demand, so every price is settled before any company sells a single unit
 * against it. It is world-level, it writes to the ledger, and burying it inside
 * the product phase is exactly how world 2 came to run three price systems —
 * the category supply graph, the compute market and the demand model — that
 * never reconciled with one another.
 *
 * ## The rule, in one block
 *
 * ```text
 * supply[n]        = Σ over live lines on n of producible units
 * w(n,i,c)         = market.industries[i] × market.customers[c]      (consumer collapses to one cell)
 * cell(n,i,c)      = endDemandBaseUnits[n] × w(n,i,c) × appetite(c) × sectorDemandCycle(i) × sizeFactor(i,c)
 *                  + Σ over every live line of a company in industry i of lastQuarterUnits × qtyPerUnit
 *                      for each RESOLVED fill into n, landing in (n, i, enterprise)
 *                  + Σ over every live line of a company in industry i of lastQuarterUnits × energyMwhPerUnit,
 *                      for n = res_grid_power, landing in (n, i, enterprise)
 *                  + one lifetime's worth of every durable line aimed at (n, i, c)
 * demand[n]        = Σ over cells of cell(n,i,c)
 * imbalance[n]     = clamp((demand − supply) / max(1, min(demand, supply)), −1, +1)
 * target[n]    = 100 × (1 + 0.6 × imbalance[n]) × worldShifter(n)
 * index[n]    += round(0.35 × (target[n] − index[n]))                      // 30 … 250
 * price[n]     = round(basePriceUsd[n] × index[n] / 100)
 * ```
 *
 * ## Cells: the industry sold into and the customer type
 *
 * A node's price is one number, but who buys it is a grid: the industry the
 * buyer is in and the kind of customer they are. A line is aimed at exactly one
 * cell — its `targetIndustry` and its `segment` — and draws its orders from
 * that cell's pool. **B2B buyers are the industry**: the demand a logistics
 * company's slot fills create for an inference API lands in the cell (API,
 * logistics, enterprise), so "AI software aimed at logistics enterprises" grows
 * with the logistics sector. Selling to the public has no industry, so a
 * consumer customer collapses to the single cell (n, consumer, consumer).
 *
 * `sizeFactor` scales enterprise and developer cells with how large the buying
 * industry has become against its size at seed (`industryBaselineUsd`), clamped
 * to `[0.5, 2]`; a save with no baseline reads exactly neutral.
 *
 * ## Derived demand reads *last* quarter's output
 *
 * Deliberately. It removes the fixed point — a price that depended on this
 * quarter's output, which depends on this quarter's price, would need to be
 * solved rather than computed — and makes the whole market one linear pass over
 * the lines, which is what keeps a quarter well under a second on a Raspberry
 * Pi. It is also how ordering actually works: a buyer places this quarter's
 * orders against the run rate it can see, not the one it will discover. Surface
 * it to a player as lead time, never as a lag to be fixed.
 *
 * ## World variables are shifters, not prices
 *
 * `NODE_WORLD_SHIFTER` is the only place a world variable may touch a price.
 * The World Director still moves those variables through `WORLD_TARGET_PATHS`
 * and events still land on them; what they no longer do is set a price
 * directly beside the market that is already setting it.
 *
 * Everything here is a pure function of the draft. No RNG, no clock: adding
 * this phase cannot shift any other phase's random sequence.
 */

import type { CapacityKind, Company, NodeCostCache, NodeLineRef, ResolverContext, SessionState } from '@frontier/contracts';
import {
  ECONOMIC_NODES,
  GRID_POWER_NODE_ID,
  NODE_PRICE_BASELINE,
  PRODUCT_SEGMENTS,
  SECTORS,
  economicNodeById,
  nextNodePriceIndex,
  nodeImbalance,
  nodePriceIndex,
  nodePriceUsd,
  nodeTargetIndex,
  type EconomicNode,
  type ProductSegment,
  type Sector,
  type WorldState,
} from '@frontier/contracts';
import { formatMoney } from '@frontier/shared';
import { isNodeEconomyWorld, sectorDemandCycle, sectorOf, supplyBySector } from '../economy/sectors';
import { capacityStockOf, createNodeCostCache, drawPerUnitAtTier, drawPerUnitOf } from './lines';
import { cellKey, cellOf, resolveFills } from './slots';
import { clamp, clamp01 } from '../economy/util';

/* -------------------------------------------------------------------------- */
/*  End demand                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The appetite reading a neutral world produces. `segmentAppetite` returns 0..1
 * the way `segmentDemand` does, so dividing by this turns it into a multiplier
 * around 1 without changing what any of the underlying variables mean.
 */
export const NEUTRAL_SEGMENT_APPETITE = 0.5;

/**
 * How much a buyer segment wants to buy this quarter, 0..1 with 0.5 neutral.
 *
 * The same world variables `segmentDemand` blends for a product, with its
 * sector term left out: a node's sector is one of the six real sectors, while
 * `draft.sectors` is keyed by world 2's eight market sectors, and the six-sector
 * demand cycle carries that signal instead (applied by the caller). The weights
 * are `segmentDemand`'s own weights renormalised over the terms that remain, so
 * the two readings cannot drift apart in spirit.
 */
export function segmentAppetite(world: WorldState, segment: ProductSegment): number {
  if (segment === 'consumer') return clamp01(0.55 * world.macro.consumerDemand + 0.45 * world.society.consumerSentiment);
  if (segment === 'enterprise') return clamp01(0.56 * clamp01(0.5 + world.macro.gdpGrowth * 6) + 0.44 * world.society.aiTrust);
  if (segment === 'developer_api') return clamp01(0.6 * world.society.developerSentiment + 0.4 * world.aiFrontier.frontierCapability);
  return clamp01(0.58 * world.government.procurementBudget + 0.42 * world.government.digitalModernisation);
}

/** The bounds the size factor is held inside: an industry may at most halve or double a cell. */
export const SIZE_FACTOR_BOUNDS = { min: 0.5, max: 2 } as const;

/** The bounds the recurring model's demand level is held inside, the same as the world-2 sector cycle's. */
export const DEMAND_LEVEL_BOUNDS = { min: 0.35, max: 2 } as const;

/** The customer types whose demand scales with the size of the industry they are in: companies, not the public or the state. */
export const SIZED_CUSTOMERS: readonly ProductSegment[] = ['enterprise', 'developer_api'];

/**
 * The weight of one cell in a node's market, 0..1.
 *
 * `industries[i] × customers[c]` for a business customer. A consumer customer
 * has no industry, so the whole consumer weight sits in the one cell
 * (consumer, consumer) and every other industry reads zero for it; the cells
 * of a node still sum to one.
 */
export function marketCellWeight(node: EconomicNode, industry: Sector, customer: ProductSegment): number {
  const customerWeight = node.market.customers[customer] ?? 0;
  if (customerWeight <= 0) return 0;
  if (customer === 'consumer') return industry === 'consumer' ? customerWeight : 0;
  return customerWeight * (node.market.industries[industry] ?? 0);
}

/** One cell of a node's market with its weight. */
export interface WeightedCell {
  readonly industry: Sector;
  readonly customer: ProductSegment;
  readonly weight: number;
}

/** Every cell of a node's market carrying weight, in `PRODUCT_SEGMENTS` then `SECTORS` order. */
export function marketCellsOf(node: EconomicNode): readonly WeightedCell[] {
  const out: WeightedCell[] = [];
  for (const customer of PRODUCT_SEGMENTS) {
    if (customer === 'consumer') {
      const weight = marketCellWeight(node, 'consumer', customer);
      if (weight > 0) out.push({ industry: 'consumer', customer, weight });
      continue;
    }
    for (const industry of SECTORS) {
      const weight = marketCellWeight(node, industry, customer);
      if (weight > 0) out.push({ industry, customer, weight });
    }
  }
  return out;
}

/**
 * How large each industry has become against its size at seed, clamped.
 *
 * One walk of the company list, so call it once per phase and pass the result
 * down. A save with no baseline — worlds 1 and 2, and a world-3 save from
 * before the field existed — reads exactly 1 everywhere.
 */
export function industrySizeFactors(state: SessionState): Readonly<Record<Sector, number>> {
  const factors = {} as Record<Sector, number>;
  const baseline = state.industryBaselineUsd;
  const supply = baseline === undefined ? null : supplyBySector(state);
  for (const sector of SECTORS) {
    const base = baseline?.[sector];
    factors[sector] = supply === null || base === undefined || !(base > 0) ? 1 : clamp(supply[sector] / base, SIZE_FACTOR_BOUNDS.min, SIZE_FACTOR_BOUNDS.max);
  }
  return factors;
}

/** The size factor for one cell: the industry's, for a business customer; exactly 1 for the public and the state. */
export function sizeFactorFor(factors: Readonly<Record<Sector, number>>, industry: Sector, customer: ProductSegment): number {
  return SIZED_CUSTOMERS.includes(customer) ? factors[industry] : 1;
}

/**
 * The appetite, cycle and size of one cell as a multiplier around 1, before the
 * cell's weight and the node's base are applied. Zero for a cell the node's
 * market gives no weight, which is what makes aiming at nobody sell nothing.
 */
function cellMultiplier(state: SessionState, node: EconomicNode, industry: Sector, customer: ProductSegment, factors: Readonly<Record<Sector, number>>): number {
  if (marketCellWeight(node, industry, customer) <= 0) return 0;
  const appetite = segmentAppetite(state.world, customer) / NEUTRAL_SEGMENT_APPETITE;
  return Math.max(0, appetite * sectorDemandCycle(industry, state.quarter) * sizeFactorFor(factors, industry, customer));
}

/**
 * End-customer demand in one cell this quarter, in units.
 *
 * `endDemandBaseUnits × w(n,i,c) × appetite(c) × sectorDemandCycle(i) × sizeFactor(i,c)`.
 * The node's own market is what kills world 2's segment-mean absurdity, where a
 * wafer fab was judged against the mean price of every enterprise product in
 * all six sectors and lost 85% of its gross additions to saturation decay.
 */
export function cellEndDemandUnits(
  state: SessionState,
  node: EconomicNode,
  industry: Sector,
  customer: ProductSegment,
  factors: Readonly<Record<Sector, number>> = industrySizeFactors(state),
): number {
  if (node.endDemandBaseUnits <= 0) return 0;
  const weight = marketCellWeight(node, industry, customer);
  if (weight <= 0) return 0;
  return node.endDemandBaseUnits * weight * cellMultiplier(state, node, industry, customer, factors);
}

/**
 * The world's appetite for one cell as a multiplier around 1, the reading the
 * recurring model applies to gross additions: the same terms `cellEndDemandUnits`
 * carries with the base and the weight divided back out, so the two cannot
 * drift. Zero for a cell the node does not sell into; otherwise held inside
 * `DEMAND_LEVEL_BOUNDS`.
 */
export function cellDemandLevel(
  state: SessionState,
  node: EconomicNode,
  industry: Sector,
  customer: ProductSegment,
  factors: Readonly<Record<Sector, number>> = industrySizeFactors(state),
): number {
  const multiplier = cellMultiplier(state, node, industry, customer, factors);
  if (multiplier <= 0) return 0;
  return clamp(multiplier, DEMAND_LEVEL_BOUNDS.min, DEMAND_LEVEL_BOUNDS.max);
}

/** End-customer demand for one node this quarter: the sum of its cells. The shape the price index reads. */
export function endDemandUnits(state: SessionState, node: EconomicNode, factors: Readonly<Record<Sector, number>> = industrySizeFactors(state)): number {
  let total = 0;
  for (const cell of marketCellsOf(node)) total += cellEndDemandUnits(state, node, cell.industry, cell.customer, factors);
  return total;
}

/* -------------------------------------------------------------------------- */
/*  Supply                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The share of every bucket held back and split equally among the lines that
 * draw on it, whatever each of them drew last quarter. The rest follows the
 * draw.
 *
 * Without it a line that drew nothing last quarter — every line the quarter it
 * launches — had a share of exactly zero, could therefore make nothing, drew
 * nothing again, and never sold a unit: a vertical app opened beside a suite
 * sat at zero for seven quarters, and a robotics founder's new arm did the
 * same. A quarter of the bucket, split equally, is the foothold that breaks
 * the circle; a single line still holds the whole bucket, and two lines that
 * both want everything converge on an even split rather than freezing wherever
 * they happened to start.
 */
export const CAPACITY_FOOTHOLD_SHARE = 0.25;

/**
 * One line's share of a bucket `sharers` lines draw on: the foothold split
 * equally, plus the remainder in proportion to last quarter's draw — equally
 * again when nobody drew anything. Exactly 1 for a line alone on its bucket.
 * The one formula `producibleUnits` and the launch preview both read.
 */
export function bucketShare(ownDraw: number, totalDraw: number, sharers: number): number {
  const count = Math.max(1, sharers);
  const proportional = totalDraw > 0 ? Math.max(0, ownDraw) / totalDraw : 1 / count;
  return CAPACITY_FOOTHOLD_SHARE / count + (1 - CAPACITY_FOOTHOLD_SHARE) * proportional;
}

/**
 * How many units one line could produce this quarter.
 *
 * One binding constraint, and it is capacity: a bucket the company has actually
 * paid for, divided by the draw one unit makes on it. Where a company runs
 * several lines out of the same bucket they share it by `bucketShare` — one fab
 * does not make five different things at full rate at once — which is
 * deterministic and is the whole of the rationing rule.
 *
 * A node with no capacity kind is not capacity-constrained at all (the four
 * data nodes: data is gathered, not manufactured). Those lines answer
 * `Infinity` here and are handled as the never-short side by `nodeBalances`.
 */
export function producibleUnits(
  state: SessionState,
  line: NodeLineRef,
  linesByCompany: ReadonlyMap<string, readonly NodeLineRef[]>,
  companiesById?: ReadonlyMap<string, Company>,
): number {
  const node = economicNodeById(line.nodeId);
  if (node === undefined) return 0;
  if (node.capacityKind === 'none' || node.capacityDrawPerUnit <= 0) return Number.POSITIVE_INFINITY;

  // The lookup table is passed in by `nodeBalances`, which builds it once: a
  // scan of the company list per line is a loop inside a loop, and this pass
  // runs over every line in the world every quarter.
  const company = companiesById === undefined ? state.companies.find((candidate) => candidate.id === line.companyId) : companiesById.get(line.companyId);
  if (company === undefined || !company.isActive) return 0;

  // Lines out of one bucket share it by `bucketShare`: a foothold split
  // equally, the rest in proportion to what each actually drew on it last
  // quarter. One fab does not make five different things at full rate at once,
  // and it does not hand a line that sold nothing last quarter exactly nothing
  // to sell with either. Both readings are pure functions of last quarter, so
  // the split is deterministic and needs no allocation pass.
  const { ownDraw, totalDraw, sharers } = bucketDrawsOf(company, linesByCompany, node.capacityKind, line.productId);
  const share = bucketShare(ownDraw, totalDraw, sharers);
  const stock = capacityStockOf(state, company, node.capacityKind) * share;
  // The draw is the node's, scaled by this line's own quality tier: a line
  // built to a higher tier takes more of the bucket per unit, which is the
  // cost side of the one lever that also buys it quality.
  const draw = drawPerUnitOf(node, company.products.find((candidate) => candidate.id === line.productId));
  return Math.floor(stock / Math.max(1e-9, draw));
}

/**
 * What this company's lines drew on one bucket last quarter: the draw of the
 * line named by `ownProductId` (zero for a line that is not there yet), the
 * total over every line on the bucket, and how many lines that is.
 */
function bucketDrawsOf(
  company: Company,
  linesByCompany: ReadonlyMap<string, readonly NodeLineRef[]>,
  capacityKind: CapacityKind,
  ownProductId: string | null,
): { readonly ownDraw: number; readonly totalDraw: number; readonly sharers: number } {
  let sharers = 0;
  let ownDraw = 0;
  let totalDraw = 0;
  for (const sibling of linesByCompany.get(company.id) ?? []) {
    const siblingNode = economicNodeById(sibling.nodeId);
    if (siblingNode === undefined || siblingNode.capacityKind !== capacityKind) continue;
    sharers += 1;
    const siblingProduct = company.products.find((candidate) => candidate.id === sibling.productId);
    const drew = sibling.unitsSoldLastQuarter * drawPerUnitOf(siblingNode, siblingProduct);
    totalDraw += drew;
    if (sibling.productId === ownProductId) ownDraw = drew;
  }
  return { ownDraw, totalDraw, sharers };
}

/** What a line not yet launched would get of its company's bucket in its first quarter. */
export interface LaunchCapacityPreview {
  readonly capacityKind: CapacityKind;
  /** Lines of this company already drawing on the same bucket. */
  readonly sharers: number;
  /** The share of the bucket the new line opens with, 0..1. Exactly 1 when nothing else draws on it. */
  readonly share: number;
  /** Units a quarter that share makes at the tier previewed. */
  readonly unitsPerQuarter: number;
}

/**
 * The capacity a launch would open with: `bucketShare` with a draw of nothing
 * beside the company's existing lines, read by the launch flow so the founder
 * is told before launching how much of their own plant or fleet the new line
 * starts with. Null for a node no bucket constrains.
 *
 * The same formula `producibleUnits` applies the quarter the line lands, so
 * the number quoted is the number the production pass will use.
 */
export function launchCapacityPreview(
  state: SessionState,
  company: Company,
  nodeId: string,
  qualityTier: number,
  cache: NodeCostCache = createNodeCostCache(state),
): LaunchCapacityPreview | null {
  const node = economicNodeById(nodeId);
  if (node === undefined || node.capacityKind === 'none' || node.capacityDrawPerUnit <= 0) return null;
  const { totalDraw, sharers } = bucketDrawsOf(company, cache.linesByCompany, node.capacityKind, null);
  const share = bucketShare(0, totalDraw, sharers + 1);
  const stock = capacityStockOf(state, company, node.capacityKind) * share;
  return {
    capacityKind: node.capacityKind,
    sharers,
    share,
    unitsPerQuarter: Math.floor(stock / Math.max(1e-9, drawPerUnitAtTier(node, qualityTier))),
  };
}

/* -------------------------------------------------------------------------- */
/*  World shifters                                                             */
/* -------------------------------------------------------------------------- */

/**
 * The only place a world variable may touch a node price, and the whole of it.
 *
 * Five nodes, one variable each. Every other node in the table answers exactly
 * 1 and is priced by supply and demand alone. A shifter multiplies the *target*
 * index, so it is felt through the same inertia everything else is: a shock to
 * electricity prices in through the grid, out through everything that draws
 * power, over about three quarters.
 */
export const NODE_WORLD_SHIFTER: Readonly<Record<string, (world: WorldState) => number>> = {
  // Rented capacity is what the spot market is a price for.
  svc_datacentre_capacity: (world) => world.compute.spotPrice,
  // A block of training compute sold as a service is bought the way reserved
  // capacity is bought, and is priced off the same index.
  svc_training_run: (world) => world.compute.reservedPrice,
  // Accelerators: scarce silicon and scarce leading-edge fab both bid the price
  // up. At full supply and full fab capacity this is exactly 1.
  sys_ai_accelerator: (world) => 1 + 0.5 * (1 - clamp01(world.compute.acceleratorSupply)) + 0.3 * (1 - clamp01(world.compute.fabCapacity)),
  // Power is the one input whose world price is genuinely a world price.
  res_grid_power: (world) => world.energy.electricityPrice,
  // What a rights-cleared corpus costs to license is a policy variable, not a
  // production one.
  dat_web_corpus: (world) => world.dataDomain.licensingCost,
};

/** The shifter in force for one node. Exactly 1 for everything not in the table above. */
export function worldShifterFor(world: WorldState, nodeId: string): number {
  const shifter = NODE_WORLD_SHIFTER[nodeId];
  if (shifter === undefined) return 1;
  return clamp(shifter(world), 0.2, 5);
}

/* -------------------------------------------------------------------------- */
/*  The balance                                                                */
/* -------------------------------------------------------------------------- */

/** One node's supply, demand and price for the quarter being opened. */
export interface NodeBalance {
  readonly nodeId: string;
  readonly sector: Sector;
  readonly supplyUnits: number;
  readonly endDemandUnits: number;
  readonly derivedDemandUnits: number;
  /**
   * What retired out of the installed base this quarter and has to be bought
   * again: one lifetime's worth of every durable line on this node. Zero for
   * every node nobody holds a durable base of.
   */
  readonly replacementDemandUnits: number;
  readonly demandUnits: number;
  /**
   * Demand per market cell, keyed `${industry}|${customer}` (see `cellKey`):
   * the cell's own end demand, the derived demand of buyers in that industry,
   * and the replacement demand of lines aimed at it. Sums to `demandUnits`. A
   * line draws its orders from its own cell and no other.
   */
  readonly cells: Readonly<Record<string, number>>;
  /**
   * How much of this node's demand its producers can actually cover, 0..1.
   *
   * The buyer's side of the same imbalance the price is set from: a line whose
   * blocking input is only two-thirds supplied ships two-thirds of
   * what it otherwise could, and says so in a partial-fill row.
   */
  readonly fillRatio: number;
  readonly imbalance: number;
  readonly worldShifter: number;
  readonly indexBefore: number;
  readonly index: number;
  readonly priceUsd: number;
  /** How many live lines produce this node. Zero means nobody in the world makes it. */
  readonly producerCount: number;
}

/**
 * Every node's balance and price. One linear pass over the lines and one over
 * the table; no node is priced inside another node's loop.
 *
 * `cache` carries the line index and the owned-node set the fills are resolved
 * against; absent, one is built for the call.
 */
export function nodeBalances(state: SessionState, cache: NodeCostCache = createNodeCostCache(state)): Readonly<Record<string, NodeBalance>> {
  const linesByCompany = cache.linesByCompany;
  const linesByNode = cache.linesByNode;
  const companiesById = new Map(state.companies.map((company) => [company.id, company]));
  const factors = industrySizeFactors(state);

  const supply = new Map<string, number>();
  const elastic = new Set<string>();
  // Demand landing in a cell of a node other than its own end demand, keyed by
  // node then by cell. Derived demand lands in the buyer's industry as an
  // enterprise; replacement demand lands in the line's own cell.
  const derived = new Map<string, Map<string, number>>();
  const replacement = new Map<string, Map<string, number>>();
  const derivedTotal = new Map<string, number>();
  const replacementTotal = new Map<string, number>();
  const land = (bucket: Map<string, Map<string, number>>, totals: Map<string, number>, nodeId: string, key: string, units: number): void => {
    if (units <= 0) return;
    const cells = bucket.get(nodeId) ?? new Map<string, number>();
    cells.set(key, (cells.get(key) ?? 0) + units);
    bucket.set(nodeId, cells);
    totals.set(nodeId, (totals.get(nodeId) ?? 0) + units);
  };

  for (const [companyId, companyLines] of linesByCompany) {
    const company = companiesById.get(companyId);
    if (company === undefined || !company.isActive) continue;
    // Whatever this company buys, it buys as an enterprise in its own industry.
    const buyerCell = cellKey(sectorOf(company), 'enterprise');

    for (const line of companyLines) {
      const node = economicNodeById(line.nodeId);
      if (node === undefined) continue;
      const product = company.products.find((candidate) => candidate.id === line.productId);

      // Supply: what this line could make.
      const units = producibleUnits(state, line, linesByCompany, companiesById);
      if (!Number.isFinite(units)) elastic.add(line.nodeId);
      else supply.set(line.nodeId, (supply.get(line.nodeId) ?? 0) + units);

      // A durable base retires one lifetime's worth a quarter, and that is next
      // quarter's demand — in the cell the line sells into: an ageing robot
      // fleet creates its own repeat business with the customers who bought it.
      const installed = line.installedBase ?? 0;
      if (installed > 0 && node.saleKind === 'unit' && (node.lifetimeQuarters ?? 0) > 0) {
        const own = product === undefined ? null : cellOf(product, node);
        const ownKey = own === null ? cellKey('consumer', 'consumer') : cellKey(own.industry, own.customer);
        land(replacement, replacementTotal, node.id, ownKey, installed / Math.max(1, node.lifetimeQuarters ?? 1));
      }

      // Derived demand: what this line's own run rate calls on upstream, through
      // the fills it actually runs on rather than the table's default. Last
      // quarter's units, which is what removes the fixed point.
      const sold = line.unitsSoldLastQuarter;
      if (sold <= 0) continue;
      for (const fill of resolveFills(state, company, product ?? null, node, cache)) {
        if (fill.nodeId === null) continue;
        const slot = node.slots.find((candidate) => candidate.id === fill.slotId);
        if (slot === undefined) continue;
        land(derived, derivedTotal, fill.nodeId, buyerCell, sold * slot.qtyPerUnit);
      }
      if (node.energyMwhPerUnit > 0) land(derived, derivedTotal, GRID_POWER_NODE_ID, buyerCell, sold * node.energyMwhPerUnit);
    }
  }

  const out: Record<string, NodeBalance> = {};
  for (const node of ECONOMIC_NODES) {
    // The cells: end demand where the market gives weight, plus whatever landed.
    const cells: Record<string, number> = {};
    let end = 0;
    for (const cell of marketCellsOf(node)) {
      const units = cellEndDemandUnits(state, node, cell.industry, cell.customer, factors);
      end += units;
      cells[cellKey(cell.industry, cell.customer)] = units;
    }
    for (const bucket of [derived.get(node.id), replacement.get(node.id)]) {
      if (bucket === undefined) continue;
      for (const [key, units] of bucket) cells[key] = (cells[key] ?? 0) + units;
    }
    const derivedUnits = derivedTotal.get(node.id) ?? 0;
    const replacementUnits = replacementTotal.get(node.id) ?? 0;
    const demand = end + derivedUnits + replacementUnits;
    // Two lines are never the short side, and both supply exactly what is asked
    // of them so the price holds:
    //
    // 1. A line nothing constrains can always make one more.
    // 2. A node **no company in this world produces at all** is bought from
    //    outside it. Twenty-five companies are not the whole economy: a robot
    //    maker in a world where nobody has an actuator line still buys
    //    actuators, at the open market's price. Pricing it as a total shortage
    //    would run every unmodelled input to the top of its band and make
    //    every finished good in the world unprofitable on turn one, which is a
    //    statement about the size of the cast, not about the economy.
    const producerCount = (linesByNode.get(node.id) ?? []).length;
    const imported = producerCount === 0;
    const supplied = elastic.has(node.id) || imported ? Math.max(demand, supply.get(node.id) ?? 0) : (supply.get(node.id) ?? 0);
    const imbalance = nodeImbalance(demand, supplied);
    const shifter = worldShifterFor(state.world, node.id);
    const before = nodePriceIndex(state, node.id);
    const index = nextNodePriceIndex(before, nodeTargetIndex(imbalance, shifter));

    out[node.id] = {
      nodeId: node.id,
      sector: node.sector,
      supplyUnits: supplied,
      endDemandUnits: end,
      derivedDemandUnits: derivedUnits,
      replacementDemandUnits: replacementUnits,
      demandUnits: demand,
      cells,
      // Elastic nodes and nodes nobody is asking for both read as fully
      // supplied: the first can always make one more, the second is short of
      // nothing.
      fillRatio: demand <= 0 ? 1 : Math.min(1, supplied / demand),
      imbalance,
      worldShifter: shifter,
      indexBefore: before,
      index,
      priceUsd: nodePriceUsd(node, index),
      producerCount,
    };
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/*  The phase                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * How far an index has to move before the quarter report says so. Below five
 * points is noise on a phone; the ledger row is written either way.
 */
export const NODE_PRICE_REPORT_THRESHOLD = 5;

/** How many priced nodes may write a report line in one quarter. The ledger keeps the rest. */
export const NODE_PRICE_REPORT_LIMIT = 6;

/**
 * Price every node for the quarter being opened.
 *
 * A no-op below world version 3, so a world-1 or world-2 save never grows a
 * `nodePrices` key and both frozen worlds keep hashing to what they always
 * hashed to.
 */
export function priceNodes(draft: SessionState, ctx: ResolverContext): void {
  if (!isNodeEconomyWorld(draft)) return;

  const balances = nodeBalances(draft);
  const prices: Record<string, number> = {};
  for (const node of ECONOMIC_NODES) prices[node.id] = balances[node.id]?.index ?? NODE_PRICE_BASELINE;
  draft.nodePrices = prices;

  // Ledger first, report second: the lines the screen shows are chosen from
  // rows that already exist, never the other way round.
  const moved: { balance: NodeBalance; eventId: string }[] = [];
  for (const node of ECONOMIC_NODES) {
    const balance = balances[node.id];
    if (balance === undefined) continue;
    if (balance.index === balance.indexBefore) continue;

    const eventId = ctx.emit({
      sessionId: draft.sessionId,
      quarter: ctx.quarter,
      type: 'node_price_set',
      actorId: null,
      targetId: node.id,
      payload: {
        nodeId: node.id,
        sector: node.sector,
        priceIndex: balance.index,
        priceIndexBefore: balance.indexBefore,
        priceUsd: balance.priceUsd,
        supplyUnits: Math.round(balance.supplyUnits),
        demandUnits: Math.round(balance.demandUnits),
        endDemandUnits: Math.round(balance.endDemandUnits),
        derivedDemandUnits: Math.round(balance.derivedDemandUnits),
        imbalancePct: Math.round(balance.imbalance * 100),
        worldShifterPct: Math.round(balance.worldShifter * 100),
        producerCount: balance.producerCount,
      },
      visibility: 'public',
    });
    moved.push({ balance, eventId });
  }

  // The biggest movers, then table order, so the same quarter always reports
  // the same nodes on every machine.
  const reportable = moved
    .filter((entry) => Math.abs(entry.balance.index - entry.balance.indexBefore) >= NODE_PRICE_REPORT_THRESHOLD)
    .sort((a, b) => {
      const byMove = Math.abs(b.balance.index - b.balance.indexBefore) - Math.abs(a.balance.index - a.balance.indexBefore);
      return byMove !== 0 ? byMove : a.balance.nodeId.localeCompare(b.balance.nodeId);
    })
    .slice(0, NODE_PRICE_REPORT_LIMIT);

  for (const { balance, eventId } of reportable) {
    const node = economicNodeById(balance.nodeId);
    if (node === undefined) continue;
    const up = balance.index > balance.indexBefore;
    const shortOfMakers = balance.producerCount === 0;
    ctx.log({
      phase: 'node_market_resolution',
      text: shortOfMakers
        ? `${node.label} has no producer in the world: buyers are bidding for units nobody makes.`
        : `${node.label} settled at ${formatMoney(balance.priceUsd)} a ${node.unitLabel}.`,
      deltaLabel: `${up ? '+' : ''}${balance.index - balance.indexBefore}`,
      refEventIds: [eventId],
      tone: shortOfMakers ? 'warning' : up ? 'negative' : 'positive',
      subjectId: null,
    });
  }
}
