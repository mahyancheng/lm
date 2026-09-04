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
 * buys which input from whom. A supply relationship between two companies is
 * the kind of thing trade press reports and competitors notice; it is also what
 * makes the map worth looking at, because a chain with names on it is a map of
 * where the leverage sits.
 *
 * **Prices, unit costs and margins that belong to a rival are not.** A rival's
 * list price, its published ask, its roll-up, its gross margin and its quality
 * score are absent from this projection — absent rather than blurred, the same
 * rule `playerView.ts` follows for a private company's statements. The viewer's
 * own economics are present in full, because they are the viewer's.
 *
 * Nothing here reads a random number or a clock.
 */

import type { NodeSaleKind, SessionState, Sector } from '@frontier/contracts';
import { ECONOMIC_NODES, ECONOMIC_NODES_BY_ID, canProduce, holdsNode, nodeMarketPriceUsd } from '@frontier/contracts';
import { lineNodeIdOf } from './lines';

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
}

/** A structural wire: one node feeds another, straight off the table. */
export interface NodeMapWire {
  readonly fromNodeId: string;
  readonly toNodeId: string;
  readonly kind: 'consumes' | 'requires';
  /** How many of the input one unit of the target consumes. Zero for a `requires` edge. */
  readonly qtyPerUnit: number;
  /** A substitutable input can always be had somewhere; the canvas draws the required ones with an asterisk. */
  readonly substitutable: boolean;
}

/**
 * A commercial wire: one company buys one input from another.
 *
 * The relationship and nothing else. There is deliberately no price on this
 * shape — a supplier's ask is that supplier's business, and the only ask the
 * viewer is entitled to is one published to *them*, which `inputOptions`
 * answers on the viewer's own lines.
 */
export interface NodeSupplyWire {
  readonly buyerCompanyId: string;
  readonly buyerProductId: string;
  readonly buyerNodeId: string;
  readonly inputNodeId: string;
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

      // Who buys what from whom. The choice is on the buyer's product; a choice
      // whose notice has already run out is no longer a relationship.
      for (const choice of product.supply ?? []) {
        if (choice.supplierCompanyId === null) continue;
        if (choice.cutOffNoticeQuarter !== null && state.quarter >= choice.cutOffNoticeQuarter) continue;
        if (ECONOMIC_NODES_BY_ID[choice.inputCategoryId] === undefined) continue;
        supplyWires.push({
          buyerCompanyId: company.id,
          buyerProductId: product.id,
          buyerNodeId: nodeId,
          inputNodeId: choice.inputCategoryId,
          supplierCompanyId: choice.supplierCompanyId,
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
    wires: structuralWires(),
    supplyWires,
    companyNames: names,
  };
}

/**
 * Every structural edge in the table, `consumes` first then `requires`.
 *
 * A pure function of the table, so it is the same list in every save and could
 * be hoisted — it deliberately is not, because a module-level cache of anything
 * graph-shaped is how a save's state leaks into another's, and this walk is
 * ninety rows.
 */
export function structuralWires(): readonly NodeMapWire[] {
  const wires: NodeMapWire[] = [];
  for (const node of ECONOMIC_NODES) {
    for (const input of node.consumes) {
      wires.push({
        fromNodeId: input.nodeId,
        toNodeId: node.id,
        kind: 'consumes',
        qtyPerUnit: input.qtyPerUnit,
        substitutable: input.substitutable,
      });
    }
    for (const required of node.requires) {
      wires.push({ fromNodeId: required, toNodeId: node.id, kind: 'requires', qtyPerUnit: 0, substitutable: false });
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
 * those lines consume, transitively, and everything their lines feed.
 *
 * This is what "open fitted to the player's own chain" means — a founder with
 * four lines in a ninety-node world should land on their four lines and what
 * feeds them, not on the whole economy at 12% zoom.
 */
export function chainNodeIds(view: NodeMapView): readonly string[] {
  const seed = view.nodes.filter((entry) => entry.yourProductId !== null).map((entry) => entry.nodeId);
  const keep = new Set<string>(seed);

  // Upstream: everything the seeds consume, to the bottom of the chain. The
  // tier invariant makes this terminate — `consumes` strictly decreases tier.
  const frontier = [...seed];
  while (frontier.length > 0) {
    const current = frontier.pop();
    if (current === undefined) continue;
    const node = ECONOMIC_NODES_BY_ID[current];
    for (const input of node?.consumes ?? []) {
      if (keep.has(input.nodeId)) continue;
      keep.add(input.nodeId);
      frontier.push(input.nodeId);
    }
  }

  // Downstream: one step only. A founder cares who could buy from them; they do
  // not need the whole demand side of the economy on the same screen.
  for (const wire of view.wires) {
    if (wire.kind !== 'consumes') continue;
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
