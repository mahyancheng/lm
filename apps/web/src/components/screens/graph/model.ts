/**
 * The canvas model: one renderer, two views.
 *
 * **My chain** is the lines this company runs, with a slot port along the
 * bottom for every slot the node declares, the node in each slot hanging under
 * its port on a dashed wire with the supplier's name beneath, a `+` on an empty
 * slot, and the output port on the right going to the market, to the company's
 * own downstream line — or, for a delivery slot, to the device the line ships
 * on, one column to the right, so the picture reads model → API → software →
 * device left to right, as the owner sketched it.
 *
 * **The map** is the whole node graph — what the viewer owns, what they could
 * research, what somebody else owns, and who supplies whom. The default recipe
 * is drawn solid; every other node a slot admits is a faint wire the renderer
 * shows only for the selected card, because ninety nodes with every admissible
 * harness drawn would be a hairball.
 *
 * Both are the same shape, because they are the same picture at two zooms, and
 * a second renderer would be a second set of bugs. What differs is which nodes
 * are in it and whether slot ports are drawn.
 *
 * Everything here is a pure function of `NodeMapView` — the engine's projection
 * — plus, for the viewer's own lines only, the viewer's own resolved fills and
 * target. There is no path from this module to a rival's price, cost or margin,
 * because there is no such field on the projection or on a resolved fill.
 */

import type { NodeMapEntry, NodeMapView, ResolvedFill } from '@frontier/simulation';
import type { IconName } from '@/components/ui';
import type { NodeRole, NodeSlotKind, ProductSegment, Sector } from '@frontier/contracts';
import { economicNodeById } from '@frontier/contracts';
import {
  CANVAS_COLUMN_GAP,
  CARD_H,
  CARD_W,
  HEAD_H,
  flowWire,
  inputPortOf,
  nodeBlockHeight,
  outputPortOf,
  shiftPathY,
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

/** The customer type of a target, as the card prints it after the industry. */
export const CUSTOMER_NOUN: Readonly<Record<ProductSegment, string>> = {
  consumer: 'the public',
  enterprise: 'enterprise',
  developer_api: 'developers',
  government: 'government',
};

/* -------------------------------------------------------------------------- */
/*  The shapes the renderer draws                                              */
/* -------------------------------------------------------------------------- */

/** The five things a slot can resolve to, as the engine names them. */
export type CanvasFillRoute = ResolvedFill['route'];

/** What sits in a slot: the node, where it comes from, and whether it can be had at all. */
export interface CanvasSlotFill {
  readonly nodeId: string;
  /** The node's own name; the hanging circle carries its initials. */
  readonly nodeLabel: string;
  readonly route: CanvasFillRoute;
  /** The counterparty: this company for `make`, the seller for `buy`, null for the open market. */
  readonly supplier: { readonly companyId: string; readonly name: string } | null;
  /** True when nobody in the world owns the node: it cannot be had at any price. */
  readonly blocked: boolean;
}

/** One slot of a node, as a port on the bottom edge of its card. */
export interface CanvasSlotPort {
  readonly slotId: string;
  readonly role: NodeRole;
  /** The slot's own label, under the port. */
  readonly label: string;
  /** True when the slot may not be left empty: the port carries a red asterisk. */
  readonly required: boolean;
  readonly kind: NodeSlotKind;
  /** The node in the slot and its source, or null for an empty slot with a `+` on it. */
  readonly fill: CanvasSlotFill | null;
  /**
   * True when the fill is drawn as a wire to a card on the canvas rather than
   * as a node hanging under the port — a delivery device one column right.
   */
  readonly viaWire: boolean;
}

/** Where a line is aimed: the industry it sells into and who signs. */
export interface CanvasTarget {
  readonly industry: Sector;
  readonly customer: ProductSegment;
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
  /** Drawn only in the chain view, where a founder is composing something. */
  readonly slots: readonly CanvasSlotPort[];
  /** Where the viewer's own line is aimed. Null on every other card. */
  readonly target: CanvasTarget | null;
  /** The viewer's own line in words, for the card's title. Null on every other card. */
  readonly description: string | null;
  readonly box: CardBox;
}

/** One wire between two cards. */
export interface CanvasWire {
  readonly key: string;
  readonly fromNodeId: string;
  readonly toNodeId: string;
  readonly path: string;
  /**
   * `slot`: an input going into the card whose slot it fills. `delivery`: out of
   * a terminal's output port into the device it ships on. `requires`: a
   * capability, not a material — drawn thinner and quieter.
   */
  readonly kind: 'slot' | 'delivery' | 'requires';
  /** True when the slot is blocking: nobody in the world making any admissible node means the line ships nothing. Read off the slot's `blocking` flag. */
  readonly blocking: boolean;
  /** True for the slot's default node. False on every other kind. */
  readonly isDefault: boolean;
  /**
   * `solid` wires are structure the picture is laid out by. `faint` wires are
   * every other node a slot admits; the renderer shows them only for the
   * selected card.
   */
  readonly emphasis: 'solid' | 'faint';
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

/** The target line under the subtitle: "→ Logistics · enterprise". */
export function targetLineOf(target: CanvasTarget, sectorLabel: (sector: Sector) => string): string {
  if (target.customer === 'consumer') return `→ ${CUSTOMER_NOUN.consumer}`;
  return `→ ${sectorLabel(target.industry)} · ${CUSTOMER_NOUN[target.customer]}`;
}

/* -------------------------------------------------------------------------- */
/*  Building the model                                                         */
/* -------------------------------------------------------------------------- */

/** One of the viewer's own lines, as the screen resolved it through the engine. */
export interface CanvasLine {
  readonly target: CanvasTarget;
  /** Every slot of the line's node resolved, in slot order: `slotOptions(...).fill`. */
  readonly fills: readonly ResolvedFill[];
  /**
   * The line in words — `describeLine`: what it is built on, from whom, aimed
   * where. The card's title carries it; the visible subtitle stays the unit.
   */
  readonly description: string;
}

export interface CanvasOptions {
  /** Which nodes to draw. Absent means every node in the projection. */
  readonly nodeIds?: readonly string[];
  /** Slot ports are drawn in the chain view, where a founder is composing something. */
  readonly view: CanvasView;
  /**
   * The viewer's own lines keyed by product id: how each slot resolved and
   * where the line is aimed. Built by the screen from `slotOptions`; a line
   * with no entry draws the table's defaults from the open market.
   */
  readonly lines?: ReadonlyMap<string, CanvasLine>;
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
  readonly kind: 'slot' | 'requires';
  readonly blocking: boolean;
  readonly isDefault: boolean;
}

/** A solid input wire the picture is laid out by, before its path exists. */
interface SolidWire {
  readonly from: string;
  readonly to: string;
  readonly kind: 'slot' | 'delivery';
  readonly blocking: boolean;
  readonly isDefault: boolean;
}

/**
 * Lay the selected nodes out and dress them as cards.
 *
 * Layering gates on the solid `slot` wires and `requires`, and takes the
 * node's own `tier` as a floor. The table guarantees a slot's role sits
 * strictly below its owner, so tier is a truthful column. A delivery wire is
 * the one exception: it does not gate, and the device it points at is hinted
 * one column right of the terminal that ships on it, because the owner reads
 * "software → computer" left to right even though the device is economically
 * an input. On the viewer's own lines the solid wires follow the resolved
 * fills — a suite composed on the copilot framework draws that wire, not the
 * default harness's — and every other card draws the table's default recipe.
 */
export function buildCanvas(view: NodeMapView, options: CanvasOptions): CanvasModel {
  const wanted = options.nodeIds === undefined ? null : new Set(options.nodeIds);
  const entries = view.nodes.filter((node) => wanted === null || wanted.has(node.nodeId));
  const present = new Set(entries.map((entry) => entry.nodeId));
  const chain = options.view === 'chain';

  /* --- slot ports, and the solid wires they imply --------------------------- */
  const portsByNode = new Map<string, readonly CanvasSlotPort[]>();
  const solid: SolidWire[] = [];
  // The default node of every slot, so a card without a resolved line draws
  // the table's recipe: `${toNodeId}.${slotId}` -> default input id.
  const defaultOf = new Map<string, string>();
  const blockingOf = new Map<string, boolean>();
  for (const wire of view.wires) {
    if (wire.kind !== 'slot' || wire.slotId === null) continue;
    blockingOf.set(`${wire.toNodeId}.${wire.slotId}`, wire.blocking);
    if (wire.isDefault) defaultOf.set(`${wire.toNodeId}.${wire.slotId}`, wire.fromNodeId);
  }

  for (const entry of entries) {
    const node = economicNodeById(entry.nodeId);
    if (node === undefined) continue;
    const line = entry.yourProductId === null ? undefined : options.lines?.get(entry.yourProductId);
    const standing = standingOf(entry);
    const ports: CanvasSlotPort[] = [];

    for (const slot of node.slots) {
      const key = `${entry.nodeId}.${slot.id}`;
      const resolved = line?.fills.find((fill) => fill.slotId === slot.id) ?? null;
      const nodeId = resolved === null ? (defaultOf.get(key) ?? null) : resolved.nodeId;
      const fill: CanvasSlotFill | null =
        nodeId === null
          ? null
          : {
              nodeId,
              nodeLabel: economicNodeById(nodeId)?.label ?? nodeId,
              route: resolved === null ? 'market' : resolved.route,
              supplier:
                resolved === null || resolved.supplierCompanyId === null
                  ? null
                  : { companyId: resolved.supplierCompanyId, name: view.companyNames[resolved.supplierCompanyId] ?? resolved.supplierCompanyId },
              blocked: resolved !== null && resolved.route === 'blocked',
            };
      const viaWire = slot.kind === 'delivery' && fill !== null && present.has(fill.nodeId);
      // Only the viewer's own lines and the cards they could open a line on
      // carry ports: a rival's composition is a wire on the map, not a claim
      // this card makes about who they buy from.
      if (chain && (standing === 'yours' || standing === 'ready')) {
        ports.push({ slotId: slot.id, role: slot.role, label: slot.label, required: slot.required, kind: slot.kind, fill, viaWire });
      }
      if (fill !== null && present.has(fill.nodeId)) {
        solid.push({
          from: fill.nodeId,
          to: entry.nodeId,
          kind: slot.kind === 'delivery' ? 'delivery' : 'slot',
          blocking: blockingOf.get(key) ?? slot.blocking,
          isDefault: fill.nodeId === slot.defaultNodeId,
        });
      }
    }
    portsByNode.set(entry.nodeId, ports);
  }

  /* --- layout: gated on solid inputs and requires; delivery hinted right ---- */
  const hints = new Map<string, number>();
  const tierOf = new Map(entries.map((entry) => [entry.nodeId, entry.tier] as const));
  for (const wire of solid) {
    if (wire.kind !== 'delivery') continue;
    const terminalTier = tierOf.get(wire.to) ?? 0;
    hints.set(wire.from, Math.max(hints.get(wire.from) ?? 0, terminalTier + 1));
  }

  const rows: LayoutRow[] = entries.map((entry) => ({ id: entry.nodeId, tier: entry.tier, entry }));
  const layoutWires: LayoutWire[] = [
    ...solid
      .filter((wire) => wire.kind === 'slot')
      .map((wire) => ({ from: wire.from, to: wire.to, kind: 'slot' as const, blocking: wire.blocking, isDefault: wire.isDefault })),
    ...view.wires
      .filter((wire) => wire.kind === 'requires' && present.has(wire.fromNodeId) && present.has(wire.toNodeId))
      .map((wire) => ({ from: wire.fromNodeId, to: wire.toNodeId, kind: 'requires' as const, blocking: false, isDefault: false })),
  ];

  const hasTarget = (entry: NodeMapEntry): boolean => entry.yourProductId !== null && options.lines?.has(entry.yourProductId) === true;
  const hanging = (entry: NodeMapEntry): number => (portsByNode.get(entry.nodeId) ?? []).filter((port) => !port.viaWire).length;
  const blockHeight = entries.reduce((tallest, entry) => Math.max(tallest, nodeBlockHeight(hanging(entry), hasTarget(entry))), HEAD_H);

  const laid = layoutNodes(rows, layoutWires, {
    gates: (wire) => wire.kind === 'slot' || wire.kind === 'requires',
    layerHint: (row) => Math.max(row.tier, hints.get(row.id) ?? 0),
    nodeWidth: CARD_W,
    nodeHeight: blockHeight,
    columnGap: CANVAS_COLUMN_GAP,
  });

  // The card sits at the top of its block; the layout put wire ends at the
  // block's centre, so every path moves up by half the difference.
  const dy = -(blockHeight - CARD_H) / 2;
  const boxes = new Map<string, CardBox>();
  for (const placed of laid.nodes) {
    boxes.set(placed.node.id, { x: placed.x, y: placed.y, width: CARD_W, height: CARD_H });
  }

  const nodes: CanvasNode[] = laid.nodes.map((placed) => {
    const entry = placed.node.entry;
    const box = boxes.get(entry.nodeId) ?? { x: placed.x, y: placed.y, width: CARD_W, height: CARD_H };
    const line = entry.yourProductId === null ? undefined : options.lines?.get(entry.yourProductId);
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
      slots: portsByNode.get(entry.nodeId) ?? [],
      target: line === undefined ? null : line.target,
      description: line === undefined || line.description.length === 0 ? null : line.description,
      box,
    };
  });

  /* --- wires: routed solids, delivery to the right, faint admissibles ------- */
  const wires: CanvasWire[] = laid.edges.map((laidEdge) => ({
    key: laidEdge.key,
    fromNodeId: laidEdge.edge.from,
    toNodeId: laidEdge.edge.to,
    path: shiftPathY(laidEdge.path, dy),
    kind: laidEdge.edge.kind,
    blocking: laidEdge.edge.blocking,
    isDefault: laidEdge.edge.isDefault,
    emphasis: 'solid',
  }));

  for (const wire of solid) {
    if (wire.kind !== 'delivery') continue;
    const from = boxes.get(wire.to);
    const to = boxes.get(wire.from);
    if (from === undefined || to === undefined) continue;
    wires.push({
      key: `delivery:${wire.to}>${wire.from}`,
      fromNodeId: wire.to,
      toNodeId: wire.from,
      path: flowWire(outputPortOf(from), inputPortOf(to)),
      kind: 'delivery',
      blocking: wire.blocking,
      isDefault: wire.isDefault,
      emphasis: 'solid',
    });
  }

  const drawn = new Set(solid.map((wire) => `${wire.from}>${wire.to}`));
  for (const wire of view.wires) {
    if (wire.kind !== 'slot' || !present.has(wire.fromNodeId) || !present.has(wire.toNodeId)) continue;
    if (drawn.has(`${wire.fromNodeId}>${wire.toNodeId}`)) continue;
    const from = boxes.get(wire.fromNodeId);
    const to = boxes.get(wire.toNodeId);
    if (from === undefined || to === undefined) continue;
    drawn.add(`${wire.fromNodeId}>${wire.toNodeId}`);
    wires.push({
      key: `faint:${wire.fromNodeId}>${wire.toNodeId}`,
      fromNodeId: wire.fromNodeId,
      toNodeId: wire.toNodeId,
      path: flowWire(outputPortOf(from), inputPortOf(to)),
      kind: 'slot',
      blocking: wire.blocking,
      isDefault: wire.isDefault,
      emphasis: 'faint',
    });
  }

  return { nodes, wires, width: laid.width, height: laid.height };
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
