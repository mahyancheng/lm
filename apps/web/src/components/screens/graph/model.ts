/**
 * The canvas model: one renderer, two views.
 *
 * **My chain** is the lines this company runs, with an input port along the
 * bottom for every input the node declares, the wired supplier hanging under
 * each on a dashed wire, a `+` on an empty port, and the output port on the
 * right going to the market or to the company's own downstream line.
 *
 * **The map** is the whole node graph — what the viewer owns, what they could
 * research, what somebody else owns, and who supplies whom.
 *
 * Both are the same shape, because they are the same picture at two zooms, and
 * a second renderer would be a second set of bugs. What differs is which nodes
 * are in it and whether sub-ports are drawn.
 *
 * Everything here is a pure function of `NodeMapView` — the engine's projection
 * — plus, for the viewer's own lines only, the viewer's own economics. There is
 * no path from this module to a rival's price, cost or margin, because there is
 * no such field on the projection to read.
 */

import type { NodeMapEntry, NodeMapView } from '@frontier/simulation';
import type { IconName } from '@/components/ui';
import type { Sector } from '@frontier/contracts';
import {
  CANVAS_COLUMN_GAP,
  CARD_H,
  CARD_W,
  type CardBox,
} from './geometry';
import { layoutNodes, type LayoutEdgeLike, type LayoutNodeLike } from '../research/graphLayout';

/* -------------------------------------------------------------------------- */
/*  Vocabulary                                                                 */
/* -------------------------------------------------------------------------- */

/** What a card says about the viewer's relationship to the node. One encoding, four states. */
export type NodeStanding = 'yours' | 'ready' | 'locked' | 'foreign';

export const STANDING_LABEL: Readonly<Record<NodeStanding, string>> = {
  yours: 'Your line',
  ready: 'Ready to launch',
  locked: 'Not yours yet',
  foreign: 'Somebody else makes this',
};

/** The tone each standing paints with, from the shared palette. */
export const STANDING_TONE: Readonly<Record<NodeStanding, 'brand' | 'gain' | 'neutral' | 'warn'>> = {
  yours: 'brand',
  ready: 'gain',
  locked: 'warn',
  foreign: 'neutral',
};

/** One icon per sector. Icons, never a monogram — a card is read at a glance. */
export const SECTOR_ICON: Readonly<Record<Sector, IconName>> = {
  ai: 'flask',
  robotics: 'settings',
  manufacturing: 'building',
  energy: 'live',
  logistics: 'box',
  consumer: 'people',
};

/** What one unit of a sale kind is, in the words a founder uses for it. */
export const SALE_KIND_NOUN: Readonly<Record<'unit' | 'recurring' | 'contract', string>> = {
  unit: 'sold outright',
  recurring: 'billed every quarter',
  contract: 'billed on a term contract',
};

/* -------------------------------------------------------------------------- */
/*  The shapes the renderer draws                                              */
/* -------------------------------------------------------------------------- */

/** One input of a node, as a sub-port on the bottom edge of its card. */
export interface CanvasSubPort {
  readonly inputNodeId: string;
  /** The input's own name, under the port. */
  readonly label: string;
  /** True when the input is non-substitutable: the port carries a red asterisk. */
  readonly required: boolean;
  /** How many of the input one unit consumes. */
  readonly qtyPerUnit: number;
  /** The supplier hanging under this port, or null for an empty port with a `+` on it. */
  readonly supplier: { readonly companyId: string; readonly name: string } | null;
  /** True when this company makes the input itself: the hanging node is its own. */
  readonly madeInHouse: boolean;
  /** True when nothing can fill it at any price. */
  readonly blocked: boolean;
}

/** One card on the canvas, with everything the renderer needs and nothing more. */
export interface CanvasNode {
  readonly nodeId: string;
  readonly label: string;
  /** The line under the name: what one unit is, and how it is sold. */
  readonly subtitle: string;
  readonly sector: Sector;
  readonly tier: number;
  readonly icon: IconName;
  readonly standing: NodeStanding;
  /** The node's one public market price. */
  readonly marketPriceUsd: number;
  readonly unitLabel: string;
  /** How many companies make it. A relationship, so public. */
  readonly producerCount: number;
  /** The viewer's own line on it, or null. */
  readonly yourProductId: string | null;
  readonly researchable: boolean;
  /** Drawn only in the chain view, where a founder is wiring something. */
  readonly subPorts: readonly CanvasSubPort[];
  readonly box: CardBox;
}

/** One solid wire: an output going into an input. */
export interface CanvasWire {
  readonly key: string;
  readonly fromNodeId: string;
  readonly toNodeId: string;
  readonly path: string;
  /** A `requires` edge is a capability, not a material: drawn thinner and quieter. */
  readonly kind: 'consumes' | 'requires';
  readonly substitutable: boolean;
}

export interface CanvasModel {
  readonly nodes: readonly CanvasNode[];
  readonly wires: readonly CanvasWire[];
  readonly width: number;
  readonly height: number;
}

export type CanvasView = 'chain' | 'map';

/* -------------------------------------------------------------------------- */
/*  Standing                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Which of the four states a node is in for this viewer.
 *
 * Ownership is per company — world 2's global `status === "achieved"` is gone —
 * so this is a question about one company and never about the world.
 */
export function standingOf(entry: NodeMapEntry): NodeStanding {
  if (entry.yourProductId !== null) return 'yours';
  if (entry.youCanProduce) return 'ready';
  if (entry.producerCompanyIds.length > 0 || entry.ownerCompanyIds.length > 0) return 'foreign';
  return 'locked';
}

/**
 * The line under a card's name.
 *
 * What one unit is and how it is sold, because those two facts are what a
 * founder needs to know before they look at a price at all — a megawatt-hour
 * billed on a twenty-quarter contract is a different business from a chip sold
 * outright, and world 2 called both of them "per seat / quarter".
 */
export function subtitleOf(entry: NodeMapEntry): string {
  return `${entry.unitLabel} · ${SALE_KIND_NOUN[entry.saleKind]}`;
}

/* -------------------------------------------------------------------------- */
/*  Building the model                                                         */
/* -------------------------------------------------------------------------- */

export interface CanvasOptions {
  /** Which nodes to draw. Absent means every node in the projection. */
  readonly nodeIds?: readonly string[];
  /** Sub-ports are drawn in the chain view, where a founder is wiring something. */
  readonly view: CanvasView;
  /**
   * Which supplier is wired to which input of which of the viewer's lines,
   * keyed `productId|inputNodeId`. Built from the viewer's own products by the
   * screen; absent entries are empty ports.
   */
  readonly wiring?: ReadonlyMap<string, { readonly companyId: string; readonly name: string; readonly madeInHouse: boolean }>;
  /** Inputs that cannot be filled at any price, keyed `productId|inputNodeId`. */
  readonly blocked?: ReadonlySet<string>;
}

/** A layout node: the pipeline only ever needed an id and a tier hint. */
interface LayoutRow extends LayoutNodeLike {
  readonly id: string;
  readonly tier: number;
  readonly entry: NodeMapEntry;
}

interface LayoutWire extends LayoutEdgeLike {
  readonly from: string;
  readonly to: string;
  readonly kind: 'consumes' | 'requires';
  readonly substitutable: boolean;
  readonly qtyPerUnit: number;
}

/**
 * Lay the selected nodes out and dress them as cards.
 *
 * Layering gates on `consumes` and `requires` only, and takes the node's own
 * `tier` as a floor. Both matter: the table guarantees `consumes` strictly
 * decreases tier, so tier is a truthful column, and gating keeps a card from
 * being pushed rightwards by an edge that is not actually gating it.
 */
export function buildCanvas(view: NodeMapView, options: CanvasOptions): CanvasModel {
  const wanted = options.nodeIds === undefined ? null : new Set(options.nodeIds);
  const entries = view.nodes.filter((node) => wanted === null || wanted.has(node.nodeId));
  const present = new Set(entries.map((entry) => entry.nodeId));

  const rows: LayoutRow[] = entries.map((entry) => ({ id: entry.nodeId, tier: entry.tier, entry }));
  const wires: LayoutWire[] = view.wires
    .filter((wire) => present.has(wire.fromNodeId) && present.has(wire.toNodeId))
    .map((wire) => ({
      from: wire.fromNodeId,
      to: wire.toNodeId,
      kind: wire.kind,
      substitutable: wire.substitutable,
      qtyPerUnit: wire.qtyPerUnit,
    }));

  const laid = layoutNodes(rows, wires, {
    // Both structural kinds gate; nothing else exists on this graph, so this is
    // an explicit statement rather than a filter that happens to pass everything.
    gates: (wire) => wire.kind === 'consumes' || wire.kind === 'requires',
    layerHint: (row) => row.tier,
    nodeWidth: CARD_W,
    nodeHeight: CARD_H,
    columnGap: CANVAS_COLUMN_GAP,
  });

  const boxes = new Map<string, CardBox>();
  for (const placed of laid.nodes) {
    boxes.set(placed.node.id, { x: placed.x, y: placed.y, width: placed.width, height: placed.height });
  }

  const nodes: CanvasNode[] = laid.nodes.map((placed) => {
    const entry = placed.node.entry;
    const box: CardBox = { x: placed.x, y: placed.y, width: placed.width, height: placed.height };
    return {
      nodeId: entry.nodeId,
      label: entry.label,
      subtitle: subtitleOf(entry),
      sector: entry.sector,
      tier: entry.tier,
      icon: SECTOR_ICON[entry.sector],
      standing: standingOf(entry),
      marketPriceUsd: entry.marketPriceUsd,
      unitLabel: entry.unitLabel,
      producerCount: entry.producerCompanyIds.length,
      yourProductId: entry.yourProductId,
      researchable: entry.researchable,
      subPorts: options.view === 'chain' ? subPortsFor(view, entry, options) : [],
      box,
    };
  });

  return {
    nodes,
    wires: laid.edges.map((laidEdge) => ({
      key: laidEdge.key,
      fromNodeId: laidEdge.edge.from,
      toNodeId: laidEdge.edge.to,
      path: laidEdge.path,
      kind: laidEdge.edge.kind,
      substitutable: laidEdge.edge.substitutable,
    })),
    width: laid.width,
    height: laid.height,
  };
}

/**
 * The sub-ports under one card: one per declared input, in the table's own
 * order, each carrying whoever is wired to it.
 *
 * A port with nobody on it is not an error — it is the open market, and the
 * renderer draws a `+` on it. A port that cannot be filled at any price is,
 * and it says so.
 */
function subPortsFor(view: NodeMapView, entry: NodeMapEntry, options: CanvasOptions): readonly CanvasSubPort[] {
  const structural = view.wires.filter((wire) => wire.toNodeId === entry.nodeId && wire.kind === 'consumes');
  const productId = entry.yourProductId;
  return structural.map((wire) => {
    const key = `${productId ?? ''}|${wire.fromNodeId}`;
    const wired = productId === null ? undefined : options.wiring?.get(key);
    const input = view.nodes.find((node) => node.nodeId === wire.fromNodeId);
    return {
      inputNodeId: wire.fromNodeId,
      label: input?.label ?? wire.fromNodeId,
      required: !wire.substitutable,
      qtyPerUnit: wire.qtyPerUnit,
      supplier: wired === undefined ? null : { companyId: wired.companyId, name: wired.name },
      madeInHouse: wired?.madeInHouse ?? false,
      blocked: options.blocked?.has(key) ?? false,
    };
  });
}

/* -------------------------------------------------------------------------- */
/*  Focus                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The boxes a view should open fitted to.
 *
 * A founder's own chain when they have one, the whole picture when they do not
 * — a company on its first quarter with no lines should see the map rather than
 * an empty canvas that gives it no way to start.
 */
export function focusBoxes(model: CanvasModel, nodeIds: readonly string[] | null): readonly CardBox[] {
  if (nodeIds === null || nodeIds.length === 0) return model.nodes.map((node) => node.box);
  const wanted = new Set(nodeIds);
  const boxes = model.nodes.filter((node) => wanted.has(node.nodeId)).map((node) => node.box);
  return boxes.length === 0 ? model.nodes.map((node) => node.box) : boxes;
}
