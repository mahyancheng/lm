/**
 * @frontier/simulation — graph/projection.ts
 *
 * The node economy as one seat is entitled to see it.
 *
 * The canvas draws two views out of one model — *my chain* and *the map* — and
 * both are built from this projection rather than from `SessionState`. That is
 * not decoration. In demo mode the aggregate is in the browser tab, so the only
 * thing standing between a rival's unit cost and the screen is a projection the
 * screens are required to read instead, and a test that proves nothing private
 * is in it.
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
 * trade press reports and competitors notice; it is also what makes the map
 * worth looking at, because a chain with names on it is a map of where the
 * leverage sits. What is *not* public is the composition's economics: the
 * relationship is a wire, never a price.
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
import { ECONOMIC_NODES, ECONOMIC_NODES_BY_ID, admissibleNodesFor, canProduce, holdsNode, nodeMarketPriceUsd } from '@frontier/contracts';
import { createNodeCostCache, lineNodeIdOf, lineNodeOf } from './lines';
import { resolveFills } from './slots';

/* -------------------------------------------------------------------------- */
/*  Shapes                                                                     */
/* -------------------------------------------------------------------------- */

/** One node on the canvas, with every public fact about it and none of a rival's private ones. */
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
  /**
   * The nodes the viewer's own line on this node actually runs on, slot by
   * slot, in slot order; an empty slot is skipped. Empty when the viewer has
   * no line here. What "my chain" is fitted to, and the viewer's own facts.
   */
  readonly yourInputNodeIds: readonly string[];
}

/**
 * A structural wire, straight off the table: one node may fill one slot of
 * another (`slot`), or must be owned before another may be produced
 * (`requires`). A slot draws one wire per admissible node, so the map shows
 * every harness an app could run on, and `isDefault` marks the one the table
 * runs on until a founder chooses.
 */
export interface NodeMapWire {
  readonly fromNodeId: string;
  readonly toNodeId: string;
  readonly kind: 'slot' | 'requires';
  /** The slot this wire fills, or null on a `requires` edge. */
  readonly slotId: string | null;
  /** How many of the input one unit of the target takes. Zero for a `requires` edge. */
  readonly qtyPerUnit: number;
  /** True when a slot nobody can fill stops the line; the canvas marks these with an asterisk. False on a `requires` edge. */
  readonly blocking: boolean;
  /** True when this is the slot's default node. False on a `requires` edge. */
  readonly isDefault: boolean;
}

/**
 * A commercial wire: one company's line runs one slot on a node from a named
 * source — a rival's published line, or a line of its own.
 *
 * The relationship and nothing else. There is deliberately no price on this
 * shape — a supplier's ask is that supplier's business, and the only ask the
 * viewer is entitled to is one published to *them*, which `slotOptions`
 * answers on the viewer's own lines.
 */
export interface NodeSupplyWire {
  readonly buyerCompanyId: string;
  readonly buyerProductId: string;
  readonly buyerNodeId: string;
  readonly slotId: string;
  readonly inputNodeId: string;
  /** The seller for a bought slot; the buyer itself for one it makes. */
  readonly supplierCompanyId: string;
}

/** The whole projection: nodes, structure, commerce and the names to render them with. */
export interface NodeMapView {
  readonly viewerCompanyId: string;
  readonly quarter: number;
  readonly nodes: readonly NodeMapEntry[];
  readonly wires: readonly NodeMapWire[];
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
  const yourInputs = new Map<string, readonly string[]>();

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
      if (company.id === viewerCompanyId) {
        yourInputs.set(nodeId, fills.filter((fill) => fill.nodeId !== null).map((fill) => fill.nodeId ?? ''));
      }
      for (const fill of fills) {
        if (fill.nodeId === null || fill.supplierCompanyId === null) continue;
        if (fill.route !== 'buy' && fill.route !== 'make') continue;
        supplyWires.push({
          buyerCompanyId: company.id,
          buyerProductId: product.id,
          buyerNodeId: nodeId,
          slotId: fill.slotId,
          inputNodeId: fill.nodeId,
          supplierCompanyId: fill.supplierCompanyId,
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
    yourInputNodeIds: yourLines.has(node.id) ? (yourInputs.get(node.id) ?? []) : [],
  }));

  return {
    viewerCompanyId,
    quarter: state.quarter,
    nodes,
    wires: structuralWires(),
    supplyWires,
    companyNames: names,
  };
}

/**
 * Every structural edge in the table: one `slot` wire per (slot, admissible
 * node) in slot order, then `requires`.
 *
 * A pure function of the table, so it is the same list in every save and could
 * be hoisted — it deliberately is not, because a module-level cache of anything
 * graph-shaped is how a save's state leaks into another's, and this walk is
 * ninety rows.
 */
export function structuralWires(): readonly NodeMapWire[] {
  const wires: NodeMapWire[] = [];
  for (const node of ECONOMIC_NODES) {
    for (const slot of node.slots) {
      for (const candidate of admissibleNodesFor(node.id, slot.id)) {
        wires.push({
          fromNodeId: candidate.id,
          toNodeId: node.id,
          kind: 'slot',
          slotId: slot.id,
          qtyPerUnit: slot.qtyPerUnit,
          blocking: slot.blocking,
          isDefault: candidate.id === slot.defaultNodeId,
        });
      }
    }
    for (const required of node.requires) {
      wires.push({ fromNodeId: required, toNodeId: node.id, kind: 'requires', slotId: null, qtyPerUnit: 0, blocking: false, isDefault: false });
    }
  }
  return wires;
}

/** Push `value` onto the bucket at `key`, creating it if needed. */
function push(map: Map<string, string[]>, key: string, value: string): void {
  const bucket = map.get(key);
  if (bucket === undefined) map.set(key, [value]);
  else bucket.push(value);
}

/* -------------------------------------------------------------------------- */
/*  Readers                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The nodes the viewer's own chain touches: every line they run, everything
 * those lines actually run on, transitively, and everything their lines feed
 * by default.
 *
 * This is what "open fitted to the player's own chain" means — a founder with
 * four lines in a ninety-node world should land on their four lines and what
 * feeds them, not on the whole economy at 12% zoom. Upstream follows the
 * viewer's **resolved fills** where they run the line and the table's defaults
 * beneath that, so a suite composed on a rival's API shows that API and not
 * the default one. Downstream is one step along default wires only: every
 * app a harness *could* run on is the map's business, not the chain's.
 */
export function chainNodeIds(view: NodeMapView): readonly string[] {
  const byId = new Map(view.nodes.map((entry) => [entry.nodeId, entry] as const));
  const seed = view.nodes.filter((entry) => entry.yourProductId !== null).map((entry) => entry.nodeId);
  const keep = new Set<string>(seed);

  const defaultInputs = new Map<string, string[]>();
  for (const wire of view.wires) {
    if (wire.kind !== 'slot' || !wire.isDefault) continue;
    const bucket = defaultInputs.get(wire.toNodeId);
    if (bucket === undefined) defaultInputs.set(wire.toNodeId, [wire.fromNodeId]);
    else bucket.push(wire.fromNodeId);
  }

  // Upstream: what the seeds run on, to the bottom of the chain. The tier
  // invariant makes this terminate — every slot points strictly downward.
  const frontier = [...seed];
  while (frontier.length > 0) {
    const current = frontier.pop();
    if (current === undefined) continue;
    const entry = byId.get(current);
    const inputs = entry !== undefined && entry.yourProductId !== null ? entry.yourInputNodeIds : (defaultInputs.get(current) ?? []);
    for (const inputId of inputs) {
      if (keep.has(inputId)) continue;
      keep.add(inputId);
      frontier.push(inputId);
    }
  }

  // Downstream: one step only. A founder cares who could buy from them; they do
  // not need the whole demand side of the economy on the same screen.
  for (const wire of view.wires) {
    if (wire.kind !== 'slot' || !wire.isDefault) continue;
    if (seed.includes(wire.fromNodeId)) keep.add(wire.toNodeId);
  }

  return view.nodes.filter((entry) => keep.has(entry.nodeId)).map((entry) => entry.nodeId);
}

/** One node and everything one wire away from it, for the focus control. */
export function neighbourhoodNodeIds(view: NodeMapView, nodeId: string): readonly string[] {
  const keep = new Set<string>([nodeId]);
  for (const wire of view.wires) {
    if (wire.toNodeId === nodeId) keep.add(wire.fromNodeId);
    if (wire.fromNodeId === nodeId) keep.add(wire.toNodeId);
  }
  return view.nodes.filter((entry) => keep.has(entry.nodeId)).map((entry) => entry.nodeId);
}
