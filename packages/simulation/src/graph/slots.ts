/**
 * @frontier/simulation — graph/slots.ts
 *
 * Where a line's composition becomes a route: the one place a `ProductSlotFill`
 * is read and turned into "make this node yourself", "buy it from that
 * company", "take the open market", "leave it empty" or "nothing in the world
 * can fill it". Every reader of a line's inputs — the roll-up, the market's
 * derived demand, the production pass, the data pass, the launch flow and the
 * canvas — resolves a slot through `resolveFill` and nowhere else, so what a
 * founder is shown before launching is what the profit and loss books after.
 *
 * ## The six steps, in order
 *
 * 1. **The fill.** The product's own entry for the slot, or the launch
 *    preview's override. No entry means the table's default.
 * 2. **The node.** The fill's node, or the slot's default when the fill names
 *    none. A null node on a slot that is not required is a deliberate `empty`.
 * 3. **Admissibility.** A node the slot does not admit — a stale fill after a
 *    table change — falls back to the default rather than being trusted. The
 *    engine bounds-checks; it never takes a fill's word for it.
 * 4. **Make.** A fill naming this company, or no fill at all while the company
 *    runs a line on the node: transferred at the company's own cost. A fill
 *    naming a rival while the company runs its own line is honoured as a buy —
 *    declining MAKE is now allowed, and it is the fill that says so.
 * 5. **Buy.** A fill naming another company, held to the checks a named
 *    supplier has always been held to: a live company, a live line on that
 *    node, published terms open to this buyer, no cut-off notice in force.
 *    Anything that fails falls to the open market rather than being refused.
 * 6. **Market, or blocked.** The open market always has some of a
 *    non-blocking slot. A blocking slot whose resolved node nobody in the world
 *    owns or licences cannot be had at any price, and that is the only thing
 *    that blocks.
 *
 * ## Switch cost
 *
 * A fill whose `changedQuarter` is this quarter contributes at
 * `SWITCH_QUALITY_FACTOR` in `effectiveQuality`. There is no cross-phase set:
 * replay reconstructs the switch from state.
 *
 * Everything here is a pure function of the draft. No RNG, no clock.
 */

import type { Company, EconomicNode, NodeCostCache, NodeSlot, Product, ProductSegment, ProductSlotFill, SessionState } from '@frontier/contracts';
import { ECONOMIC_NODES_BY_ID, SECTORS, admissibleNodesFor, type Sector } from '@frontier/contracts';
import { lineOf, ownedNodeIdsOf, producersOf } from './lines';

/* -------------------------------------------------------------------------- */
/*  Constants                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * How much of a freshly switched input's quality lands the quarter it is
 * switched. The rest is the switching cost: integration, retraining, the
 * first quarter on a new supplier. Seven tenths, the number world 2 used for
 * the same idea on categories.
 */
export const SWITCH_QUALITY_FACTOR = 0.7;

/* -------------------------------------------------------------------------- */
/*  Shapes                                                                     */
/* -------------------------------------------------------------------------- */

/** The five things a slot can resolve to. `conversion` is not one of them: a slot is always an input. */
export type FillRoute = 'make' | 'buy' | 'market' | 'empty' | 'blocked';

/** One slot of one line, resolved to the node in it and where that node comes from. */
export interface ResolvedFill {
  readonly slotId: string;
  /** The node in the slot, or null when the slot is left empty. */
  readonly nodeId: string | null;
  readonly route: FillRoute;
  /** This company for `make`, the seller for `buy`, null otherwise. */
  readonly supplierCompanyId: string | null;
  /** The company's own line for `make`, the seller's line for `buy`, null otherwise. */
  readonly supplierProductId: string | null;
  /** The seller's published ask per unit for `buy`; null on every other route. */
  readonly askUsd: number | null;
  /** True when the fill changed node or source this quarter: it delivers at the switch-cost factor. */
  readonly changedThisQuarter: boolean;
}

/** What the launch preview overrides before a product exists. Never memoised. */
export interface FillOverride {
  readonly fills: readonly ProductSlotFill[];
  /** The quality tier the preview is costing at, 0..1. Absent means the node's own draw. */
  readonly qualityTier?: number;
}

/* -------------------------------------------------------------------------- */
/*  Reading a product                                                          */
/* -------------------------------------------------------------------------- */

/** The fills a line carries. Empty for a line that has never composed anything, and for every world-2 product. */
export function fillsOf(product: Product | null | undefined): readonly ProductSlotFill[] {
  return product?.slots ?? [];
}

/** One fill by slot id, or null. */
export function fillFor(fills: readonly ProductSlotFill[], slotId: string): ProductSlotFill | null {
  return fills.find((entry) => entry.slotId === slotId) ?? null;
}

/**
 * The industry carrying the most weight in a node's market; ties break in
 * `SECTORS` order. Where a line lands when its owner has not aimed it.
 */
export function defaultIndustryFor(node: EconomicNode): Sector {
  let best: Sector = SECTORS[0];
  let bestWeight = -1;
  for (const sector of SECTORS) {
    const weight = node.market.industries[sector] ?? 0;
    if (weight > bestWeight) {
      best = sector;
      bestWeight = weight;
    }
  }
  return best;
}

/**
 * The industry a line sells into. Selling to the public has no industry, so a
 * consumer line always lands in the consumer sector whatever it was aimed at.
 */
export function targetOf(product: Product, node: EconomicNode): Sector {
  if (product.segment === 'consumer') return 'consumer';
  return product.targetIndustry ?? defaultIndustryFor(node);
}

/** One market cell: an industry and the customer type inside it. */
export interface MarketCell {
  readonly industry: Sector;
  readonly customer: ProductSegment;
}

/** The cell a line sells into: its customer type, and the industry `targetOf` resolves. */
export function cellOf(product: Product, node: EconomicNode): MarketCell {
  return { industry: targetOf(product, node), customer: product.segment };
}

/** The key a cell is pooled under. One string, so a map can hold it. */
export function cellKey(industry: Sector, customer: ProductSegment): string {
  return `${industry}|${customer}`;
}

/* -------------------------------------------------------------------------- */
/*  Resolution                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Admissible node ids per slot, keyed `${nodeId}.${slotId}`. A pure function
 * of the constant node table — never of a session — so holding it at module
 * level cannot leak one save into another; it exists because the resolution
 * runs for every slot of every line every quarter and the table is ninety
 * rows deep.
 */
const ADMISSIBLE_MEMO = new Map<string, ReadonlySet<string>>();

/** The set of node ids a slot admits. */
export function admissibleSetFor(node: EconomicNode, slot: NodeSlot): ReadonlySet<string> {
  const key = `${node.id}.${slot.id}`;
  const memo = ADMISSIBLE_MEMO.get(key);
  if (memo !== undefined) return memo;
  const built = new Set(admissibleNodesFor(node.id, slot.id).map((candidate) => candidate.id));
  ADMISSIBLE_MEMO.set(key, built);
  return built;
}

/** Whether `nodeId` may fill `slot` on `node`: every node of the role, or the narrower `accepts`. */
export function slotAdmits(node: EconomicNode, slot: NodeSlot, nodeId: string): boolean {
  return admissibleSetFor(node, slot).has(nodeId);
}

/**
 * The slot an input node fills on a line: the slot whose current fill or
 * default already resolves to it, otherwise the first slot that admits it.
 * Null when no slot on the node can take it. What `choose_supplier` and a
 * `launch_product.supply` entry, both of which name a node rather than a slot,
 * are translated through.
 */
export function slotForInput(node: EconomicNode, fills: readonly ProductSlotFill[], inputNodeId: string): NodeSlot | null {
  for (const slot of node.slots) {
    const fill = fillFor(fills, slot.id);
    const current = fill === null ? slot.defaultNodeId : fill.nodeId;
    if (current === inputNodeId) return slot;
  }
  for (const slot of node.slots) if (slotAdmits(node, slot, inputNodeId)) return slot;
  return null;
}

/**
 * Resolve one slot of one line to a route.
 *
 * `product` is null while a line is still being launched; `override` carries
 * the preview's fills and is never memoised. With a cache the line index and
 * the owned-node set come from it and the company list is never walked.
 */
export function resolveFill(
  state: SessionState,
  company: Company,
  product: Product | null,
  node: EconomicNode,
  slot: NodeSlot,
  cache?: NodeCostCache,
  override?: FillOverride,
): ResolvedFill {
  const fills = override === undefined ? fillsOf(product) : override.fills;
  const fill = fillFor(fills, slot.id);
  const changedThisQuarter = fill !== null && fill.changedQuarter !== null && fill.changedQuarter === state.quarter;
  const empty = (): ResolvedFill => ({
    slotId: slot.id,
    nodeId: null,
    route: 'empty',
    supplierCompanyId: null,
    supplierProductId: null,
    askUsd: null,
    changedThisQuarter,
  });

  /* --- 2 and 3: the node, bounds-checked against the table ----------------- */
  let nodeId: string | null = fill === null ? slot.defaultNodeId : fill.nodeId;
  if (nodeId !== null && (ECONOMIC_NODES_BY_ID[nodeId] === undefined || !slotAdmits(node, slot, nodeId))) nodeId = slot.defaultNodeId;
  // A required slot cannot be left empty: a null fill on one reads as the default.
  if (nodeId === null && slot.required) nodeId = slot.defaultNodeId;
  if (nodeId === null) return empty();

  /* --- 4: make ------------------------------------------------------------- */
  const ownLine = lineOf(state, company.id, nodeId, cache);
  const namesSelf = fill !== null && fill.supplierCompanyId === company.id;
  const namesNobody = fill === null || fill.supplierCompanyId === null;
  if (ownLine !== undefined && (namesSelf || fill === null)) {
    return {
      slotId: slot.id,
      nodeId,
      route: 'make',
      supplierCompanyId: company.id,
      supplierProductId: ownLine.productId,
      askUsd: null,
      changedThisQuarter,
    };
  }

  /* --- 5: buy -------------------------------------------------------------- */
  if (fill !== null && !namesSelf && !namesNobody) {
    const ask = supplierAskFor(state, company, fill, nodeId);
    if (ask !== null) {
      return {
        slotId: slot.id,
        nodeId,
        route: 'buy',
        supplierCompanyId: ask.companyId,
        supplierProductId: ask.productId,
        askUsd: ask.askUsd,
        changedThisQuarter,
      };
    }
  }

  /* --- 6: market, or blocked ----------------------------------------------- */
  //
  // Blocked is the strong claim and is held to the strong test: not "nobody is
  // running a line on it this quarter" — the market already prices that, at
  // the top of the node's band — but "nobody in the world owns or licences it,
  // so it cannot be had at any price". The resolved node is what is judged: a
  // slot filled with a node nobody can make is blocked even when another node
  // of the role is owned, because the fill is the founder's to change.
  if (slot.blocking) {
    const somebodyMakesIt = producersOf(state, nodeId, cache).length > 0;
    const somebodyCouldMakeIt = somebodyMakesIt || (cache?.ownedNodeIds ?? ownedNodeIdsOf(state)).has(nodeId);
    if (!somebodyCouldMakeIt) {
      return { slotId: slot.id, nodeId, route: 'blocked', supplierCompanyId: null, supplierProductId: null, askUsd: null, changedThisQuarter };
    }
  }
  return { slotId: slot.id, nodeId, route: 'market', supplierCompanyId: null, supplierProductId: null, askUsd: null, changedThisQuarter };
}

/** Every slot of a line's node resolved, in slot order. */
export function resolveFills(
  state: SessionState,
  company: Company,
  product: Product | null,
  node: EconomicNode,
  cache?: NodeCostCache,
  override?: FillOverride,
): readonly ResolvedFill[] {
  return node.slots.map((slot) => resolveFill(state, company, product, node, slot, cache, override));
}

/* -------------------------------------------------------------------------- */
/*  The named-supplier checks                                                  */
/* -------------------------------------------------------------------------- */

/** A seller a fill names, with the ask it publishes. */
export interface SupplierAsk {
  readonly companyId: string;
  readonly productId: string;
  readonly askUsd: number;
}

/**
 * The checks a named supplier has always been held to, applied to one fill.
 *
 * A supplier that has given notice stops supplying at the quarter on the
 * notice; one that has stopped trading, closed the line, sells a different node
 * on that line, has not published terms, or has blocked this buyer is not a
 * supplier at all. Null means the fill falls through to the open market.
 */
export function supplierAskFor(state: SessionState, buyer: Company, fill: ProductSlotFill, inputNodeId: string): SupplierAsk | null {
  if (fill.supplierCompanyId === null || fill.supplierProductId === null) return null;
  if (fill.cutOffNoticeQuarter !== null && state.quarter >= fill.cutOffNoticeQuarter) return null;

  const supplier = state.companies.find((candidate) => candidate.id === fill.supplierCompanyId);
  if (supplier === undefined || !supplier.isActive) return null;
  const line = supplier.products.find((candidate) => candidate.id === fill.supplierProductId);
  if (line === undefined || !line.isActive) return null;
  if ((line.nodeId ?? null) !== inputNodeId) return null;
  const terms = line.supplyTerms;
  if (terms === undefined || terms === null) return null;
  if (terms.blockedCustomerIds.includes(buyer.id)) return null;
  if (!terms.openToAll && !terms.exclusiveCustomerIds.includes(buyer.id)) return null;

  return { companyId: supplier.id, productId: line.id, askUsd: Math.max(0, terms.pricePerUnitUsd) };
}

/* -------------------------------------------------------------------------- */
/*  Writing a fill                                                             */
/* -------------------------------------------------------------------------- */

/**
 * The product's fills with one slot set, `changedQuarter` stamped when the
 * node or the source actually moved. Returns the same array untouched when
 * nothing changed, so a re-issued identical choice never restarts the switch
 * cost. The caller writes the result back to `product.slots`.
 */
export function withFill(
  fills: readonly ProductSlotFill[],
  slotId: string,
  nodeId: string | null,
  supplierCompanyId: string | null,
  supplierProductId: string | null,
  quarter: number,
): { readonly fills: readonly ProductSlotFill[]; readonly changed: boolean } {
  const before = fillFor(fills, slotId);
  const changed =
    before === null || before.nodeId !== nodeId || before.supplierCompanyId !== supplierCompanyId || before.supplierProductId !== supplierProductId;
  if (!changed) return { fills, changed: false };
  const next: ProductSlotFill = {
    slotId,
    nodeId,
    supplierCompanyId,
    supplierProductId: supplierCompanyId === null ? null : supplierProductId,
    cutOffNoticeQuarter: null,
    changedQuarter: quarter,
  };
  const out = fills.filter((entry) => entry.slotId !== slotId);
  out.push(next);
  return { fills: out, changed: true };
}
