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
 * supply[n]    = Σ over live lines on n of producible units
 * demand[n]    = endDemand[n]
 *              + Σ over every live line of lastQuarterUnits × qtyPerUnit for each consumes edge into n
 *              + Σ over every live line of lastQuarterUnits × energyMwhPerUnit, for n = res_grid_power
 * imbalance[n] = clamp((demand − supply) / max(1, min(demand, supply)), −1, +1)
 * target[n]    = 100 × (1 + 0.6 × imbalance[n]) × worldShifter(n)
 * index[n]    += round(0.35 × (target[n] − index[n]))                      // 30 … 250
 * price[n]     = round(basePriceUsd[n] × index[n] / 100)
 * ```
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

import type { Company, NodeLineRef, ResolverContext, SessionState } from '@frontier/contracts';
import {
  ECONOMIC_NODES,
  GRID_POWER_NODE_ID,
  NODE_PRICE_BASELINE,
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
import { isNodeEconomyWorld, sectorDemandCycle } from '../economy/sectors';
import { capacityStockOf, drawPerUnitOf, indexNodeLines, nodeLinesOf } from './lines';
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

/**
 * End-customer demand for one node this quarter, in units.
 *
 * Zero for a node nobody buys outside the supply chain — a wafer has no end
 * customers at all, and its only demand is other companies' `consumes` edges.
 * That one nullable field is what kills world 2's segment-mean absurdity, where
 * a wafer fab was judged against the mean price of every enterprise product in
 * all six sectors and lost 85% of its gross additions to saturation decay.
 */
export function endDemandUnits(state: SessionState, node: EconomicNode): number {
  if (node.buyerSegment === null || node.endDemandBaseUnits <= 0) return 0;
  const appetite = segmentAppetite(state.world, node.buyerSegment) / NEUTRAL_SEGMENT_APPETITE;
  return Math.max(0, node.endDemandBaseUnits * appetite * sectorDemandCycle(node.sector, state.quarter));
}

/* -------------------------------------------------------------------------- */
/*  Supply                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * How many units one line could produce this quarter.
 *
 * One binding constraint, and it is capacity: a bucket the company has actually
 * paid for, divided by the draw one unit makes on it. Where a company runs
 * several lines out of the same bucket they share it equally — one fab does not
 * make five different things at full rate at once — which is deterministic and
 * is the whole of the rationing rule.
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

  // Lines out of one bucket share it in proportion to what each of them
  // actually drew on it last quarter, and equally when none of them drew
  // anything: one fab does not make five different things at full rate at
  // once, and it does not split itself five ways when four of the five are
  // dormant either. Both readings are pure functions of last quarter, so the
  // split is deterministic and needs no allocation pass.
  let sharers = 0;
  let ownDraw = 0;
  let totalDraw = 0;
  for (const sibling of linesByCompany.get(line.companyId) ?? []) {
    const siblingNode = economicNodeById(sibling.nodeId);
    if (siblingNode === undefined || siblingNode.capacityKind !== node.capacityKind) continue;
    sharers += 1;
    const siblingProduct = company.products.find((candidate) => candidate.id === sibling.productId);
    const drew = sibling.unitsSoldLastQuarter * drawPerUnitOf(siblingNode, siblingProduct);
    totalDraw += drew;
    if (sibling.productId === line.productId) ownDraw = drew;
  }
  const share = totalDraw > 0 ? ownDraw / totalDraw : 1 / Math.max(1, sharers);
  const stock = capacityStockOf(state, company, node.capacityKind) * share;
  // The draw is the node's, scaled by this line's own quality tier: a line
  // built to a higher tier takes more of the bucket per unit, which is the
  // cost side of the one lever that also buys it quality.
  const draw = drawPerUnitOf(node, company.products.find((candidate) => candidate.id === line.productId));
  return Math.floor(stock / Math.max(1e-9, draw));
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
   * How much of this node's demand its producers can actually cover, 0..1.
   *
   * The buyer's side of the same imbalance the price is set from: a line whose
   * non-substitutable input is only two-thirds supplied ships two-thirds of
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
 */
export function nodeBalances(state: SessionState): Readonly<Record<string, NodeBalance>> {
  const lines = nodeLinesOf(state);
  const { linesByCompany, linesByNode } = indexNodeLines(lines);
  const companiesById = new Map(state.companies.map((company) => [company.id, company]));

  const supply = new Map<string, number>();
  const derived = new Map<string, number>();
  const replacement = new Map<string, number>();
  const elastic = new Set<string>();

  for (const line of lines) {
    const node = economicNodeById(line.nodeId);
    if (node === undefined) continue;

    // Supply: what this line could make.
    const units = producibleUnits(state, line, linesByCompany, companiesById);
    if (!Number.isFinite(units)) elastic.add(line.nodeId);
    else supply.set(line.nodeId, (supply.get(line.nodeId) ?? 0) + units);

    // Derived demand: what this line's own run rate calls on upstream. Last
    // quarter's units, which is what removes the fixed point.
    // A durable base retires one lifetime's worth a quarter, and that is next
    // quarter's demand: an ageing robot fleet creates its own repeat business.
    const installed = line.installedBase ?? 0;
    if (installed > 0 && node.saleKind === 'unit' && (node.lifetimeQuarters ?? 0) > 0) {
      replacement.set(node.id, (replacement.get(node.id) ?? 0) + installed / Math.max(1, node.lifetimeQuarters ?? 1));
    }

    const sold = line.unitsSoldLastQuarter;
    if (sold <= 0) continue;
    for (const input of node.consumes) {
      derived.set(input.nodeId, (derived.get(input.nodeId) ?? 0) + sold * input.qtyPerUnit);
    }
    if (node.energyMwhPerUnit > 0) {
      derived.set(GRID_POWER_NODE_ID, (derived.get(GRID_POWER_NODE_ID) ?? 0) + sold * node.energyMwhPerUnit);
    }
  }

  const out: Record<string, NodeBalance> = {};
  for (const node of ECONOMIC_NODES) {
    const end = endDemandUnits(state, node);
    const derivedUnits = derived.get(node.id) ?? 0;
    const replacementUnits = replacement.get(node.id) ?? 0;
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
