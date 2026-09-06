/**
 * @frontier/simulation — graph/projection.ts
 *
 * The node economy as one seat is entitled to see it.
 *
 * The Connections screen draws who owns a node, who runs a line on it and who
 * buys from whom out of this projection rather than out of `SessionState`. That
 * is not decoration. In demo mode the aggregate is in the browser tab, so the
 * only thing standing between a rival's unit cost and the screen is a
 * projection the screens are required to read instead, and a test that proves
 * nothing private is in it.
 *
 * ## What is public, and why
 *
 * **The node table** is public: it is the world's shared description of how
 * things are made, the way a bill of materials for a car is public.
 *
 * **One market price per node per quarter** is public. It is the market — the
 * settled price everybody trades around — not anybody's ask. Rule 9 says
 * markets price beliefs rather than the database, and this is the belief.
 *
 * **Relationships** are public: who owns a node, who runs a line on it, and who
 * fills which slot from whom — a rival's API running on another rival's model
 * included. A supply relationship between two companies is the kind of thing
 * trade press reports and competitors notice; it is also what makes the
 * Connections screen worth looking at, because a chain with names on it shows
 * where the leverage sits. What is *not* public is the composition's
 * economics: the relationship is a wire, never a price.
 *
 * **Prices, unit costs and margins that belong to a rival are not.** A rival's
 * list price, its published ask, its roll-up, its gross margin and its quality
 * score are absent from this projection — absent rather than blurred, the same
 * rule `playerView.ts` follows for a private company's statements. The viewer's
 * own economics are present in full, because they are the viewer's.
 *
 * Nothing here reads a random number or a clock.
 */

import type { SessionState, NodeSaleKind, Sector } from '@frontier/contracts';
import { ECONOMIC_NODES, canProduce, holdsNode, nodeMarketPriceUsd } from '@frontier/contracts';
import { createNodeCostCache, lineNodeIdOf, lineNodeOf, unitsSoldLastQuarterOf } from './lines';
import { resolveFills } from './slots';

/* -------------------------------------------------------------------------- */
/*  Shapes                                                                     */
/* -------------------------------------------------------------------------- */

/** One node, with every public fact about it and none of a rival's private ones. */
export interface NodeMapEntry {
  readonly nodeId: string;
  readonly label: string;
  readonly blurb: string;
  readonly sector: Sector;
  /** The table's own tier, 0..6. A number rather than `NodeTier` because that is what a parsed row carries. */
  readonly tier: number;
  readonly unitLabel: string;
  readonly saleKind: NodeSaleKind;
  /** The node's one settled price this quarter. Public: it is the market, not an ask. */
  readonly marketPriceUsd: number;
  /** True when the viewer owns or licences it. */
  readonly youOwn: boolean;
  /** True when the viewer may run a line on it: owns it and everything it requires. */
  readonly youCanProduce: boolean;
  /** The viewer's own line on it, or null. */
  readonly yourProductId: string | null;
  /** Companies that own or licence it. A relationship, so public. */
  readonly ownerCompanyIds: readonly string[];
  /** Companies currently running a line on it. Also a relationship, also public. */
  readonly producerCompanyIds: readonly string[];
  /** Whether a research programme can reach it at all. */
  readonly researchable: boolean;
}

/**
 * A commercial wire: one company's line runs one slot on a node from a named
 * source — a rival's published line, or a line of its own.
 *
 * The relationship, plus — when the viewer is one of the two parties on it —
 * their own order book: how many units actually crossed the wire. An order
 * book is the two parties' own, so a wire between two other companies carries
 * no units at all.
 *
 * There is still deliberately no price on this shape. A supplier's ask is that
 * supplier's business, and the only ask the viewer is entitled to is one
 * published to *them*, which `slotOptions` answers on the viewer's own lines.
 */
export interface NodeSupplyWire {
  readonly buyerCompanyId: string;
  readonly buyerProductId: string;
  readonly buyerNodeId: string;
  readonly slotId: string;
  readonly inputNodeId: string;
  /** The seller for a bought slot; the buyer itself for one it makes. */
  readonly supplierCompanyId: string;
  /**
   * Units this wire carried in the quarter that has closed: the buyer line's
   * `unitsSoldLastQuarter` times the slot's `qtyPerUnit` — the same arithmetic
   * `nodeBalances` lands as derived demand, so the figure on the wire and the
   * figure in the market are one number.
   *
   * Present only when the viewer is the buyer or the supplier. Null on a wire
   * between two other companies.
   */
  readonly unitsDrawnLastQuarter: number | null;
}

/** The whole projection: nodes, commerce and the names to render them with. */
export interface NodeMapView {
  readonly viewerCompanyId: string;
  readonly quarter: number;
  readonly nodes: readonly NodeMapEntry[];
  readonly supplyWires: readonly NodeSupplyWire[];
  /** Company id to name, for every company named anywhere above. */
  readonly companyNames: Readonly<Record<string, string>>;
}

/* -------------------------------------------------------------------------- */
/*  The projection                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Project the node economy down to what `viewerCompanyId` may see.
 *
 * One walk of the company list and one walk of the table. On a Pi with thirty
 * companies and ninety nodes that is a few thousand operations, which is what
 * lets a screen rebuild it on a filter change rather than caching a stale copy.
 */
export function nodeMapFor(state: SessionState, viewerCompanyId: string): NodeMapView {
  const viewer = state.companies.find((company) => company.id === viewerCompanyId) ?? null;
  const cache = createNodeCostCache(state);

  const owners = new Map<string, string[]>();
  const producers = new Map<string, string[]>();
  const names: Record<string, string> = {};
  const supplyWires: NodeSupplyWire[] = [];

  for (const company of state.companies) {
    if (!company.isActive) continue;
    names[company.id] = company.name;

    for (const nodeId of company.ownedNodes ?? []) push(owners, nodeId, company.id);
    for (const licence of company.licences ?? []) {
      if (licence.expiryQuarter > state.quarter) push(owners, licence.nodeId, company.id);
    }

    for (const product of company.products) {
      if (!product.isActive) continue;
      const nodeId = lineNodeIdOf(product);
      if (nodeId === null) continue;
      push(producers, nodeId, company.id);

      // Who runs what on whom. The fills are resolved rather than read raw, so a
      // named supplier whose notice has run out, or whose terms have closed, is
      // no longer a relationship — and a slot the company makes itself is one.
      const node = lineNodeOf(product);
      if (node === undefined) continue;
      const fills = resolveFills(state, company, product, node, cache);
      for (const fill of fills) {
        if (fill.nodeId === null || fill.supplierCompanyId === null) continue;
        if (fill.route !== 'buy' && fill.route !== 'make') continue;
        // The order book is the two parties' own: units only for a wire the
        // viewer is standing on, either end of it.
        const onIt = company.id === viewerCompanyId || fill.supplierCompanyId === viewerCompanyId;
        const slot = node.slots.find((candidate) => candidate.id === fill.slotId);
        supplyWires.push({
          buyerCompanyId: company.id,
          buyerProductId: product.id,
          buyerNodeId: nodeId,
          slotId: fill.slotId,
          inputNodeId: fill.nodeId,
          supplierCompanyId: fill.supplierCompanyId,
          unitsDrawnLastQuarter: onIt ? unitsSoldLastQuarterOf(product) * (slot?.qtyPerUnit ?? 0) : null,
        });
      }
    }
  }

  const yourLines = new Map<string, string>();
  for (const product of viewer?.products ?? []) {
    if (!product.isActive) continue;
    const nodeId = lineNodeIdOf(product);
    if (nodeId !== null && !yourLines.has(nodeId)) yourLines.set(nodeId, product.id);
  }

  const nodes: NodeMapEntry[] = ECONOMIC_NODES.map((node) => ({
    nodeId: node.id,
    label: node.label,
    blurb: node.blurb,
    sector: node.sector,
    tier: node.tier,
    unitLabel: node.unitLabel,
    saleKind: node.saleKind,
    marketPriceUsd: nodeMarketPriceUsd(state, node.id),
    youOwn: viewer !== null && holdsNode(viewer, node.id, state.quarter),
    youCanProduce: viewer !== null && canProduce(viewer, node.id, state.quarter),
    yourProductId: yourLines.get(node.id) ?? null,
    ownerCompanyIds: owners.get(node.id) ?? [],
    producerCompanyIds: producers.get(node.id) ?? [],
    researchable: node.researchable,
  }));

  return {
    viewerCompanyId,
    quarter: state.quarter,
    nodes,
    supplyWires,
    companyNames: names,
  };
}

/** Push `value` onto the bucket at `key`, creating it if needed. */
function push(map: Map<string, string[]>, key: string, value: string): void {
  const bucket = map.get(key);
  if (bucket === undefined) map.set(key, [value]);
  else bucket.push(value);
}
