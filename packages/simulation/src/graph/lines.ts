/**
 * @frontier/simulation — graph/lines.ts
 *
 * A **line** is one company producing and selling one node. It is the unit of
 * production in world 3, and this module is the only place that knows how a
 * line is stored: everything else — the node market, the cost roll-up, and
 * later the product phase and the screens — walks `NodeLineRef`.
 *
 * Two things live here because both the market and the roll-up need them and
 * neither should own them:
 *
 * 1. **The line index.** Built once per quarter resolution and carried on the
 *    cost cache, so neither the market's supply pass nor a recursive roll-up
 *    walks the company list again.
 * 2. **Capacity.** What one company holds of each bucket, and what one unit of
 *    that bucket costs it for a quarter — the number the capacity line of a
 *    unit cost is struck at.
 *
 * Everything is a pure function of the draft. No RNG, no clock.
 */

import type { Company, NodeCostCache, NodeLineRef, SessionState } from '@frontier/contracts';
import {
  CAPACITY_KINDS,
  COMPUTE_CAPACITY_NODE_ID,
  ECONOMIC_NODES,
  ECONOMIC_NODES_BY_ID,
  canProduce,
  economicNodeById,
  holdsNode,
  nodeMarketPriceUsd,
  type CapacityKind,
  type EconomicNode,
  type Product,
} from '@frontier/contracts';
import {
  ACCELERATOR_UNIT_PRICE_USD,
  CLOUD_UNIT_COST_USD_PER_QUARTER,
  PPE_DEPRECIATION_PER_QUARTER,
  RESERVED_UNIT_COST_USD_PER_QUARTER,
} from '../companies/balance';
import { heldComputeUnits, servingComputeUnits } from '../companies/products';
import { isNodeEconomyWorld } from '../economy/sectors';

/* -------------------------------------------------------------------------- */
/*  Which node a line sells                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The node this product line produces, or null when it is not a node line.
 *
 * `Product.nodeId` is absent on every world-1 and world-2 product, and an id
 * that is not in the table is treated as absent rather than trusted: a save
 * written against an older table must not be able to invent a node.
 */
export function lineNodeIdOf(product: Product): string | null {
  const nodeId = product.nodeId;
  if (nodeId === undefined || nodeId === null) return null;
  return ECONOMIC_NODES_BY_ID[nodeId] === undefined ? null : nodeId;
}

/**
 * The neutral quality tier: a line at this tier draws exactly the node's own
 * `capacityDrawPerUnit` and delivers exactly its own `craftQuality`.
 */
export const QUALITY_TIER_BASELINE = 0.5;

/**
 * The one lever, and both of its consequences.
 *
 * `qualityTier` scales the capacity a unit draws *and* the quality delivered,
 * by the same factor: a higher tier buys quality and costs real unit cost,
 * rather than world 2's phantom margin. Exactly 1 at the baseline, so a line
 * that has never set a tier is the line it always was.
 */
export function qualityTierFactor(product: Product): number {
  return 0.5 + Math.max(0, product.qualityTier ?? QUALITY_TIER_BASELINE);
}

/** What one unit of this line actually draws on its capacity bucket. */
export function drawPerUnitOf(node: EconomicNode, product: Product | undefined): number {
  return node.capacityDrawPerUnit * (product === undefined ? 1 : qualityTierFactor(product));
}

/** The product behind a line, for the two readers that need its quality tier. */
export function productOf(state: SessionState, companyId: string, productId: string): Product | undefined {
  const company = state.companies.find((candidate) => candidate.id === companyId);
  return company?.products.find((candidate) => candidate.id === productId);
}

/** The node a line sells, or undefined. */
export function lineNodeOf(product: Product): EconomicNode | undefined {
  const nodeId = lineNodeIdOf(product);
  return nodeId === null ? undefined : economicNodeById(nodeId);
}

/**
 * Every live line in the world, in company order then product order.
 *
 * `unitsSoldLastQuarter` is the line's unit count at the close of the quarter
 * that has already resolved. The market phase runs before the product phase, so
 * at the moment anything reads this it is genuinely *last* quarter's number —
 * which is the whole point: derived demand that read this quarter's output
 * would be a fixed point, and this is one linear pass.
 */
export function nodeLinesOf(state: SessionState): readonly NodeLineRef[] {
  const lines: NodeLineRef[] = [];
  for (const company of state.companies) {
    if (!company.isActive) continue;
    for (const product of company.products) {
      if (!product.isActive) continue;
      const nodeId = lineNodeIdOf(product);
      if (nodeId === null) continue;
      lines.push({
        companyId: company.id,
        productId: product.id,
        nodeId,
        unitsSoldLastQuarter: Math.max(0, product.unitsSoldQuarterly ?? product.activeCustomers),
        listPriceUsd: Math.max(0, product.pricePerSeat),
        installedBase: Math.max(0, product.installedBase ?? 0),
      });
    }
  }
  return lines;
}

/** The two indexes over a set of lines. Built once; read everywhere. */
export interface NodeLineIndex {
  readonly linesByNode: Map<string, readonly NodeLineRef[]>;
  readonly linesByCompany: Map<string, readonly NodeLineRef[]>;
}

/** Index lines by the node they sell and by the company that runs them. */
export function indexNodeLines(lines: readonly NodeLineRef[]): NodeLineIndex {
  const linesByNode = new Map<string, NodeLineRef[]>();
  const linesByCompany = new Map<string, NodeLineRef[]>();
  for (const line of lines) {
    const byNode = linesByNode.get(line.nodeId);
    if (byNode === undefined) linesByNode.set(line.nodeId, [line]);
    else byNode.push(line);
    const byCompany = linesByCompany.get(line.companyId);
    if (byCompany === undefined) linesByCompany.set(line.companyId, [line]);
    else byCompany.push(line);
  }
  return { linesByNode, linesByCompany };
}

/**
 * A fresh memo table for one quarter's roll-up, with the line index already in
 * it.
 *
 * Per resolution, never module-level. The index is a snapshot of the lines that
 * existed when the cache was made; a caller that launches or closes a line and
 * then wants a cost for it makes a new cache, which costs one walk of the
 * company list.
 */
export function createNodeCostCache(state: SessionState): NodeCostCache {
  const index = indexNodeLines(nodeLinesOf(state));
  return {
    units: new Map(),
    capacityRates: new Map(),
    linesByNode: index.linesByNode,
    linesByCompany: index.linesByCompany,
    ownedNodeIds: ownedNodeIdsOf(state),
  };
}

/**
 * Every node a live company owns or holds a licence over.
 *
 * One walk of the company list. A node in here has somebody who *could* make
 * it, which is the difference between an input that is merely dear this
 * quarter and an input that cannot be had at any price.
 */
export function ownedNodeIdsOf(state: SessionState): ReadonlySet<string> {
  const out = new Set<string>();
  for (const company of state.companies) {
    if (!company.isActive) continue;
    for (const id of company.ownedNodes ?? []) out.add(id);
    for (const licence of company.licences ?? []) out.add(licence.nodeId);
  }
  return out;
}

/**
 * This company's line on this node, or undefined.
 *
 * With a cache the answer comes from its index and the company list is never
 * walked — including for a company with no lines at all, which is the common
 * case and would otherwise pay for a full scan on every input of every
 * roll-up.
 */
export function lineOf(state: SessionState, companyId: string, nodeId: string, cache?: NodeCostCache): NodeLineRef | undefined {
  if (cache !== undefined) return (cache.linesByCompany.get(companyId) ?? []).find((line) => line.nodeId === nodeId);
  const company = state.companies.find((candidate) => candidate.id === companyId);
  if (company === undefined || !company.isActive) return undefined;
  for (const product of company.products) {
    if (!product.isActive) continue;
    if (lineNodeIdOf(product) !== nodeId) continue;
    return {
      companyId,
      productId: product.id,
      nodeId,
      unitsSoldLastQuarter: Math.max(0, product.unitsSoldQuarterly ?? product.activeCustomers),
      listPriceUsd: Math.max(0, product.pricePerSeat),
      installedBase: Math.max(0, product.installedBase ?? 0),
    };
  }
  return undefined;
}

/** Every live line on one node, in company order. Uses the cache's index when there is one. */
export function producersOf(state: SessionState, nodeId: string, cache?: NodeCostCache): readonly NodeLineRef[] {
  const indexed = cache?.linesByNode.get(nodeId);
  if (indexed !== undefined) return indexed;
  if (cache !== undefined) return [];
  return nodeLinesOf(state).filter((line) => line.nodeId === nodeId);
}


/* -------------------------------------------------------------------------- */
/*  What a company could put on sale                                           */
/* -------------------------------------------------------------------------- */

/** One node a company could open a line on, and what stands in the way of it. */
export interface LaunchableNode {
  readonly node: EconomicNode;
  /** True when the company may not produce it yet. */
  readonly locked: boolean;
  /** Nodes it would have to own or licence first. Empty exactly when `locked` is false. */
  readonly missingNodeIds: readonly string[];
  /** True when the company already runs a line on this node. */
  readonly alreadySold: boolean;
}

/**
 * Every node this company could sell, open now or gated on ownership.
 *
 * The list is its own sector plus anything it already owns, which is exactly
 * the owner's sentence made visible: *"I'm an AI lab, I shouldn't start with
 * having techs of robotics. I can purchase or invest but I don't start with
 * it."* A robotics node is absent from an AI laboratory's list until the
 * laboratory owns one, and then it is there.
 *
 * `locked` runs the identical `canProduce` test the validator's world-3
 * `launch_product` rule does, so a row marked open here is a row the validator
 * actually accepts. Pure and total.
 */
export function launchableNodes(state: SessionState, company: Company): readonly LaunchableNode[] {
  const owned = new Set(company.ownedNodes ?? []);
  const sector = company.sector;
  const lineNodeIds = new Set<string>();
  for (const product of company.products) {
    if (!product.isActive) continue;
    const nodeId = lineNodeIdOf(product);
    if (nodeId !== null) lineNodeIds.add(nodeId);
  }
  return ECONOMIC_NODES.filter((node) => node.sector === sector || owned.has(node.id)).map((node) => {
    const missingNodeIds = [node.id, ...node.requires].filter((id) => !holdsNode(company, id, state.quarter));
    return {
      node,
      locked: !canProduce(company, node.id, state.quarter),
      missingNodeIds,
      alreadySold: lineNodeIds.has(node.id),
    };
  });
}

/* -------------------------------------------------------------------------- */
/*  Capacity                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * What a million dollars of installed plant, fleet or grid costs its owner for
 * one quarter: its depreciation, and nothing else.
 *
 * Capital already bought is a sunk cost to the cash flow but a real cost to a
 * unit, and depreciation is the honest quarterly rate — the same rate the
 * financial phase writes down property, plant and equipment at, so the unit
 * cost and the income statement charge the same number for the same asset.
 */
export const CAPACITY_RATE_USD_PER_MILLION = 1_000_000 * PPE_DEPRECIATION_PER_QUARTER;

/** Dollars of installed capital one unit of the plant, fleet and grid buckets stands for. */
export const CAPACITY_UNIT_USD = 1_000_000;

/**
 * How much of a bucket a company holds, in the bucket's own unit:
 * accelerator-equivalents for compute, millions of dollars of installed capital
 * for plant, fleet and grid.
 *
 * The unit is the same unit `capacityDrawPerUnit` is quoted in, by
 * construction. World 2 compared dollar-millions of plant against
 * reference-priced unit counts; that dimensional break is what this fixes.
 */
export function capacityStockOf(state: SessionState, company: Company, kind: CapacityKind): number {
  if (kind === 'none') return 0;
  // Serving units, not held units: capacity pointed at training is research,
  // is charged to research, and makes no product. Rationing against everything
  // held would let a company allocate the training half of its fleet to units
  // and then charge the same accelerators twice.
  if (kind === 'compute') return servingComputeUnits(state, company);
  const capacity = company.capacity;
  if (capacity === undefined) return 0;
  const usd = kind === 'plant' ? capacity.plantUsd : kind === 'fleet' ? capacity.fleetUsd : capacity.gridUsd;
  return Math.max(0, usd) / CAPACITY_UNIT_USD;
}

/**
 * What one unit of a bucket costs this company for one quarter.
 *
 * Compute is blended rather than assumed: a company that owns its accelerators
 * pays depreciation on what an accelerator is worth *this* quarter — the node
 * price of `sys_ai_accelerator`, not a constant that disagrees with the
 * catalogue — while a company renting pays the reserved and spot rates it
 * actually signed. Energy is deliberately not in here: a node's own
 * `energyMwhPerUnit` is its power line, and charging it twice is exactly the
 * kind of double count the roll-up exists to prevent.
 *
 * Computed once per company per quarter and memoised on the cache.
 */
/* -------------------------------------------------------------------------- */
/*  What renting an accelerator costs                                          */
/* -------------------------------------------------------------------------- */

/**
 * The node an accelerator physically sits in: a megawatt of powered, cooled
 * datacentre for a quarter.
 */
export const DATACENTRE_CAPACITY_NODE_ID = 'svc_datacentre_capacity';

/** Megawatts of that capacity one accelerator occupies: 1.2 kW of IT load. */
export const MW_PER_ACCELERATOR = 0.0012;

/**
 * What on-demand costs over a term commitment. A quarter more, which is the
 * whole difference between the two products: the same board in the same hall,
 * bought by the hour instead of by the year.
 */
export const ON_DEMAND_PREMIUM = 1.25;

/**
 * What one accelerator costs to buy outright.
 *
 * World 3 asks the node market, which is the only place an accelerator has a
 * price at all there; worlds 1 and 2 keep the designer constant. This is the
 * last reader of `ACCELERATOR_UNIT_PRICE_USD` outside the frozen worlds: who
 * *sells* accelerators in world 3 is "whoever owns the node and runs a line on
 * it", and what they charge is what the node is worth this quarter.
 */
export function acceleratorListUsd(state: SessionState): number {
  return isNodeEconomyWorld(state) ? nodeMarketPriceUsd(state, COMPUTE_CAPACITY_NODE_ID) : ACCELERATOR_UNIT_PRICE_USD;
}

/**
 * What one reserved accelerator-equivalent costs for a quarter.
 *
 * **World 3 derives it from the node table and from nothing else**: the board
 * ages at `PPE_DEPRECIATION_PER_QUARTER` of what a board costs *this quarter*
 * in the node market, and it occupies `MW_PER_ACCELERATOR` of datacentre
 * capacity at that node's own market price. Renting is therefore what owning
 * costs the owner, and both move when the market for accelerators or for
 * datacentre space moves — which is what "one market price per node" means when
 * it reaches the compute pillar. The world compute index is deliberately NOT
 * applied on top: the node market is the index, and multiplying by both would
 * price the same scarcity twice.
 *
 * Worlds 1 and 2 return exactly the expression they always returned, so both
 * frozen worlds keep hashing to what they have always hashed to.
 */
export function reservedRentUsd(state: SessionState): number {
  if (!isNodeEconomyWorld(state)) return RESERVED_UNIT_COST_USD_PER_QUARTER * state.world.compute.reservedPrice;
  return (
    nodeMarketPriceUsd(state, COMPUTE_CAPACITY_NODE_ID) * PPE_DEPRECIATION_PER_QUARTER +
    nodeMarketPriceUsd(state, DATACENTRE_CAPACITY_NODE_ID) * MW_PER_ACCELERATOR
  );
}

/**
 * The same for one accelerator-equivalent of on-demand cloud.
 *
 * `minIndex` floors the world spot index for the callers that always did — a
 * denominator cannot be allowed to reach zero — and is ignored in world 3,
 * which reads no index at all.
 */
export function cloudRentUsd(state: SessionState, minIndex = 0): number {
  if (!isNodeEconomyWorld(state)) return CLOUD_UNIT_COST_USD_PER_QUARTER * Math.max(minIndex, state.world.compute.spotPrice);
  return reservedRentUsd(state) * ON_DEMAND_PREMIUM;
}

export function capacityRateUsd(state: SessionState, company: Company, kind: CapacityKind, cache?: NodeCostCache): number {
  if (kind === 'none') return 0;
  if (kind !== 'compute') return CAPACITY_RATE_USD_PER_MILLION;

  const key = `${company.id}|${kind}`;
  const memo = cache?.capacityRates.get(key);
  if (memo !== undefined) return memo;

  const compute = company.compute;
  const acceleratorUsd = nodeMarketPriceUsd(state, COMPUTE_CAPACITY_NODE_ID);
  const ownedDepreciation = compute.ownedAccelerators * acceleratorUsd * PPE_DEPRECIATION_PER_QUARTER;
  const reservedFactor = Math.max(0.1, compute.reservationProviderFactor ?? 1);
  const reserved = compute.reservedAccelerators * reservedRentUsd(state) * reservedFactor;
  const cloud = Math.max(0, compute.cloudSpendQuarterly) * state.world.compute.spotPrice;
  const held = heldComputeUnits(state, company);
  // A company with no compute at all still has to price a compute line: it
  // would have to rent, so the fallback is what renting one unit costs at the
  // world's own reserved index rather than zero.
  const rate = held <= 0 ? reservedRentUsd(state) : (ownedDepreciation + reserved + cloud) / held;
  cache?.capacityRates.set(key, rate);
  return rate;
}

/** Every capacity bucket, for callers that walk them all. */
export const NODE_CAPACITY_KINDS = CAPACITY_KINDS;
