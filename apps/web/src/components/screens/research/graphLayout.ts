/**
 * Deterministic layout for the Frontier Map.
 *
 * No physics, no randomness, no clock. This is a small, complete Sugiyama
 * pipeline — the layered-graph drawing algorithm every dataflow editor uses —
 * run to completion on every render, and it always produces the same picture
 * for the same graph, so a player's spatial memory of the map survives a
 * reload. When the graph version changes the arrangement moves; that movement
 * is a consequence of the data, never of a simulation running in the browser.
 *
 * The four stages, in order:
 *
 *  1. **Layering.** Longest-path depth over every edge kind, so a technology
 *     always sits to the right of everything it needs.
 *  2. **Dummy slots.** An edge that spans more than one layer is broken into a
 *     chain of one-layer segments through an invisible slot in each column it
 *     crosses. Those slots take a real row, which is precisely what stops a
 *     long edge from being drawn straight through a card in between.
 *  3. **Ordering.** Alternating down/up barycenter sweeps: each layer is
 *     reordered by the mean position of its neighbours in the layer just
 *     fixed, ties broken by slot id so the result is stable. The pass with the
 *     fewest crossings wins. Ordering by public confidence — what this file
 *     used to do — maximised crossings instead of minimising them.
 *  4. **Coordinates and routing.** Every layer is aligned to one shared row
 *     grid at a constant pitch and centred in it, and every edge leaves its
 *     source's right-centre port and enters its target's left-centre port as a
 *     cubic with horizontal tangents, running only through the node-free
 *     channels between columns and the node-free rows the dummy slots hold.
 *
 * `UI_SYSTEM.md` §4 remains the encoding contract, with one deliberate change:
 * the node fill no longer carries public confidence. Nine pastel fills plus
 * nine coloured borders was the noise the map was drowning in. The epistemic
 * state now rides a left accent bar and a state dot on a calm white card, and
 * confidence is the one bar along the bottom.
 */

import type { TechEdge, TechEpistemicState, TechGraph, TechNode, TechVisibility } from '@frontier/contracts';
import type { Tone } from '@/components/ui';

/* -------------------------------------------------------------------------- */
/*  Geometry                                                                   */
/* -------------------------------------------------------------------------- */

export const NODE_WIDTH = 172;
export const MIN_NODE_HEIGHT = 46;
export const MAX_NODE_HEIGHT = 60;
export const COLUMN_GAP = 80;
export const ROW_GAP = 16;
/** One shared vertical pitch for every column: the map's rhythm. */
export const ROW_PITCH = MAX_NODE_HEIGHT + ROW_GAP;
export const MARGIN = 24;

/** Vertical spacing between two edges leaving the same side of a node. */
const PORT_PITCH = 5;
/** Edges stop just short of the card so an arrowhead sits outside it. */
const ARROW_GAP = 3;
/** Alternating barycenter passes. Four is where the demo graph stops moving. */
const ORDERING_SWEEPS = 4;
/** A back edge — only possible if the graph gained a cycle — gets its own lane. */
const DETOUR_LANE_PITCH = 14;

export interface LaidOutNode {
  readonly node: TechNode;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly layer: number;
  /** Index on the shared row grid. Two nodes in the same row are level. */
  readonly row: number;
}

export interface LaidOutEdge {
  readonly edge: TechEdge;
  /** Stable identity for React keys and for hover/focus matching. */
  readonly key: string;
  readonly path: string;
  readonly fromX: number;
  readonly fromY: number;
  readonly toX: number;
  readonly toY: number;
}

export interface GraphLayout {
  readonly nodes: readonly LaidOutNode[];
  readonly edges: readonly LaidOutEdge[];
  readonly width: number;
  readonly height: number;
  readonly layerCount: number;
  readonly rowCount: number;
}

/**
 * Longest-path depth per node, over every edge kind.
 *
 * Relaxed iteratively with an iteration ceiling rather than a recursive walk:
 * a graph the interpreter has extended could in principle contain a cycle, and
 * a layout that hangs is worse than a layout that flattens one.
 */
export function depthsOf(nodes: readonly TechNode[], edges: readonly TechEdge[]): Map<string, number> {
  const ids = new Set(nodes.map((node) => node.id));
  const live = edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to) && edge.from !== edge.to);
  const depth = new Map<string, number>();
  for (const node of nodes) depth.set(node.id, 0);

  const ceiling = Math.max(1, Math.min(nodes.length, 64));
  for (let pass = 0; pass < ceiling; pass += 1) {
    let moved = false;
    for (const edge of live) {
      const from = depth.get(edge.from) ?? 0;
      const to = depth.get(edge.to) ?? 0;
      if (to < from + 1) {
        depth.set(edge.to, from + 1);
        moved = true;
      }
    }
    if (!moved) break;
  }
  return depth;
}

/** Node height from compute intensity: a hungry programme is a bigger box. */
export function heightOf(node: TechNode): number {
  return Math.round(
    MIN_NODE_HEIGHT + (MAX_NODE_HEIGHT - MIN_NODE_HEIGHT) * Math.max(0, Math.min(1, node.computeIntensity)),
  );
}

/* -------------------------------------------------------------------------- */
/*  The pipeline                                                               */
/* -------------------------------------------------------------------------- */

interface Slot {
  readonly id: string;
  readonly layer: number;
  /** Null for a dummy: an invisible slot a long edge passes through. */
  readonly node: TechNode | null;
  order: number;
  row: number;
  /** Vertical centre, on the shared row grid. */
  centreY: number;
}

interface Segment {
  readonly key: string;
  readonly a: string;
  readonly b: string;
  readonly channel: number;
}

interface Point {
  readonly x: number;
  readonly y: number;
}

/** Two decimals: enough for a crisp path, few enough for a stable string. */
function r(value: number): number {
  return Math.round(value * 100) / 100;
}

function push(map: Map<string, string[]>, key: string, value: string): void {
  const bucket = map.get(key);
  if (bucket === undefined) map.set(key, [value]);
  else bucket.push(value);
}

/**
 * A cubic from a to b with horizontal tangents — the dataflow-editor curve.
 *
 * Both control points sit at the horizontal midpoint, so x(t) is monotone and
 * y(t) never leaves [a.y, b.y]. That is the property the whole routing scheme
 * leans on: a segment drawn between two columns cannot wander out of its
 * channel, and a segment drawn across a column stays on its own empty row.
 */
function link(a: Point, b: Point): string {
  if (Math.abs(a.y - b.y) < 0.01) return `L ${r(b.x)} ${r(b.y)}`;
  const dx = (b.x - a.x) * 0.5;
  return `C ${r(a.x + dx)} ${r(a.y)}, ${r(b.x - dx)} ${r(b.y)}, ${r(b.x)} ${r(b.y)}`;
}

/** A polyline with quadratic corners, for the rare back edge. */
function roundedPolyline(points: readonly Point[], radius: number): string {
  const first = points[0];
  if (first === undefined) return '';
  let d = `M ${r(first.x)} ${r(first.y)}`;
  for (let i = 1; i < points.length; i += 1) {
    const corner = points[i];
    const previous = points[i - 1];
    const next = points[i + 1];
    if (corner === undefined || previous === undefined) continue;
    if (next === undefined) {
      d += ` L ${r(corner.x)} ${r(corner.y)}`;
      continue;
    }
    const inLength = Math.hypot(corner.x - previous.x, corner.y - previous.y);
    const outLength = Math.hypot(next.x - corner.x, next.y - corner.y);
    const cut = Math.min(radius, inLength / 2, outLength / 2);
    if (cut < 0.5) {
      d += ` L ${r(corner.x)} ${r(corner.y)}`;
      continue;
    }
    const enter = {
      x: corner.x - ((corner.x - previous.x) / inLength) * cut,
      y: corner.y - ((corner.y - previous.y) / inLength) * cut,
    };
    const leave = {
      x: corner.x + ((next.x - corner.x) / outLength) * cut,
      y: corner.y + ((next.y - corner.y) / outLength) * cut,
    };
    d += ` L ${r(enter.x)} ${r(enter.y)} Q ${r(corner.x)} ${r(corner.y)}, ${r(leave.x)} ${r(leave.y)}`;
  }
  return d;
}

/** Lay the whole graph out. Pure, and stable for a given graph. */
export function layoutGraph(graph: TechGraph): GraphLayout {
  const nodes = [...graph.nodes];
  const depth = depthsOf(nodes, graph.edges);

  /* --- 1. slots, one per node plus one dummy per crossed column ----------- */

  const slots = new Map<string, Slot>();
  for (const node of nodes) {
    slots.set(node.id, { id: node.id, layer: depth.get(node.id) ?? 0, node, order: 0, row: 0, centreY: 0 });
  }

  const segments: Segment[] = [];
  const chains = new Map<string, string[]>();
  const detours: { readonly key: string; readonly edge: TechEdge }[] = [];

  graph.edges.forEach((edge, index) => {
    const from = slots.get(edge.from);
    const to = slots.get(edge.to);
    // An edge whose endpoint the projection redacted is simply not drawn.
    if (from === undefined || to === undefined) return;
    const key = `${edge.from}>${edge.to}:${edge.kind}#${index}`;
    if (from.layer >= to.layer) {
      detours.push({ key, edge });
      return;
    }
    const chain: string[] = [from.id];
    for (let layer = from.layer + 1; layer < to.layer; layer += 1) {
      const id = `~${key}@${layer}`;
      slots.set(id, { id, layer, node: null, order: 0, row: 0, centreY: 0 });
      chain.push(id);
    }
    chain.push(to.id);
    chains.set(key, chain);
    for (let i = 0; i + 1 < chain.length; i += 1) {
      const a = chain[i];
      const b = chain[i + 1];
      if (a !== undefined && b !== undefined) segments.push({ key, a, b, channel: from.layer + i });
    }
  });

  /* --- 2. ordering: alternating barycenter sweeps -------------------------- */

  const layerCount = Math.max(1, ...[...slots.values()].map((slot) => slot.layer + 1));
  let layers: string[][] = Array.from({ length: layerCount }, () => []);
  for (const slot of slots.values()) layers[slot.layer]?.push(slot.id);
  for (const bucket of layers) bucket.sort((a, b) => a.localeCompare(b));

  const preds = new Map<string, string[]>();
  const succs = new Map<string, string[]>();
  for (const segment of segments) {
    push(succs, segment.a, segment.b);
    push(preds, segment.b, segment.a);
  }

  const byChannel = new Map<number, Segment[]>();
  for (const segment of segments) {
    const bucket = byChannel.get(segment.channel);
    if (bucket === undefined) byChannel.set(segment.channel, [segment]);
    else bucket.push(segment);
  }

  const applyOrders = (): void => {
    for (const bucket of layers) {
      bucket.forEach((id, index) => {
        const slot = slots.get(id);
        if (slot !== undefined) slot.order = index;
      });
    }
  };
  applyOrders();

  const orderOf = (id: string): number => slots.get(id)?.order ?? 0;

  /** Pairs of segments in one channel whose endpoints are in opposite order. */
  const crossingCount = (): number => {
    let total = 0;
    for (const bucket of byChannel.values()) {
      for (let i = 0; i < bucket.length; i += 1) {
        for (let j = i + 1; j < bucket.length; j += 1) {
          const one = bucket[i];
          const two = bucket[j];
          if (one === undefined || two === undefined) continue;
          const da = orderOf(one.a) - orderOf(two.a);
          const db = orderOf(one.b) - orderOf(two.b);
          if (da * db < 0) total += 1;
        }
      }
    }
    return total;
  };

  const sweep = (layer: number, side: Map<string, string[]>): void => {
    const bucket = layers[layer];
    if (bucket === undefined) return;
    const keyed = bucket.map((id, index) => {
      const neighbours = side.get(id);
      // No neighbour in the fixed layer: hold position. Ties break on id, so
      // two slots with the same barycenter never swap between renders.
      let barycentre = index;
      if (neighbours !== undefined && neighbours.length > 0) {
        let sum = 0;
        for (const other of neighbours) sum += orderOf(other);
        barycentre = sum / neighbours.length;
      }
      return { id, barycentre };
    });
    keyed.sort((a, b) => a.barycentre - b.barycentre || a.id.localeCompare(b.id));
    layers[layer] = keyed.map((entry) => entry.id);
    applyOrders();
  };

  let best = layers.map((bucket) => [...bucket]);
  let bestCrossings = crossingCount();
  for (let pass = 0; pass < ORDERING_SWEEPS; pass += 1) {
    if (pass % 2 === 0) for (let layer = 1; layer < layerCount; layer += 1) sweep(layer, preds);
    else for (let layer = layerCount - 2; layer >= 0; layer -= 1) sweep(layer, succs);
    const crossings = crossingCount();
    if (crossings < bestCrossings) {
      bestCrossings = crossings;
      best = layers.map((bucket) => [...bucket]);
    }
  }
  layers = best;
  applyOrders();

  /* --- 3. the shared row grid --------------------------------------------- */

  const rowCount = Math.max(1, ...layers.map((bucket) => bucket.length));
  for (const bucket of layers) {
    const start = Math.floor((rowCount - bucket.length) / 2);
    bucket.forEach((id, index) => {
      const slot = slots.get(id);
      if (slot === undefined) return;
      slot.row = start + index;
      slot.centreY = MARGIN + slot.row * ROW_PITCH + MAX_NODE_HEIGHT / 2;
    });
  }

  const columnX = (layer: number): number => MARGIN + layer * (NODE_WIDTH + COLUMN_GAP);

  const placed = new Map<string, LaidOutNode>();
  for (const node of nodes) {
    const slot = slots.get(node.id);
    if (slot === undefined) continue;
    const height = heightOf(node);
    placed.set(node.id, {
      node,
      x: columnX(slot.layer),
      y: slot.centreY - height / 2,
      width: NODE_WIDTH,
      height,
      layer: slot.layer,
      row: slot.row,
    });
  }

  /* --- 4. ports: one slot per incident edge, sorted by neighbour row ------- */

  interface PortEntry {
    readonly key: string;
    readonly row: number;
  }
  const outgoing = new Map<string, PortEntry[]>();
  const incoming = new Map<string, PortEntry[]>();
  const addPort = (map: Map<string, PortEntry[]>, nodeId: string, entry: PortEntry): void => {
    const bucket = map.get(nodeId);
    if (bucket === undefined) map.set(nodeId, [entry]);
    else bucket.push(entry);
  };

  for (const [key, chain] of chains) {
    const source = chain[0];
    const target = chain[chain.length - 1];
    const afterSource = chain[1];
    const beforeTarget = chain[chain.length - 2];
    if (source === undefined || target === undefined || afterSource === undefined || beforeTarget === undefined) continue;
    addPort(outgoing, source, { key, row: slots.get(afterSource)?.row ?? 0 });
    addPort(incoming, target, { key, row: slots.get(beforeTarget)?.row ?? 0 });
  }
  for (const detour of detours) {
    addPort(outgoing, detour.edge.from, { key: detour.key, row: slots.get(detour.edge.to)?.row ?? 0 });
    addPort(incoming, detour.edge.to, { key: detour.key, row: slots.get(detour.edge.from)?.row ?? 0 });
  }

  const portY = new Map<string, number>();
  const assignPorts = (map: Map<string, PortEntry[]>, side: 'out' | 'in'): void => {
    for (const [nodeId, entries] of map) {
      const box = placed.get(nodeId);
      if (box === undefined) continue;
      // Sorted by the neighbour's row: the fan out of a node never self-crosses.
      const sorted = [...entries].sort((a, b) => a.row - b.row || a.key.localeCompare(b.key));
      const centre = box.y + box.height / 2;
      const usable = Math.max(0, box.height - 18);
      const span = Math.min(PORT_PITCH * (sorted.length - 1), usable);
      const step = sorted.length > 1 ? span / (sorted.length - 1) : 0;
      sorted.forEach((entry, index) => {
        portY.set(`${side}:${entry.key}`, centre + (index - (sorted.length - 1) / 2) * step);
      });
    }
  };
  assignPorts(outgoing, 'out');
  assignPorts(incoming, 'in');

  /* --- 5. routing ---------------------------------------------------------- */

  const gridBottom = MARGIN + rowCount * ROW_PITCH - ROW_GAP;
  const laneOf = new Map<string, number>();
  [...detours].sort((a, b) => a.key.localeCompare(b.key)).forEach((detour, index) => laneOf.set(detour.key, index));

  const laidOutEdges: LaidOutEdge[] = [];

  graph.edges.forEach((edge, index) => {
    const key = `${edge.from}>${edge.to}:${edge.kind}#${index}`;
    const source = placed.get(edge.from);
    const target = placed.get(edge.to);
    if (source === undefined || target === undefined) return;

    const fromY = portY.get(`out:${key}`) ?? source.y + source.height / 2;
    const toY = portY.get(`in:${key}`) ?? target.y + target.height / 2;
    const chain = chains.get(key);

    if (chain === undefined) {
      // A back edge or a self edge: routed in a reserved lane under the grid,
      // out through the channel right of the source and in through the channel
      // left of the target. Both runs are node-free by construction.
      const lane = laneOf.get(key) ?? 0;
      const laneY = gridBottom + DETOUR_LANE_PITCH * (lane + 1);
      const fromX = source.x + source.width;
      const toX = target.x - ARROW_GAP;
      const path = roundedPolyline(
        [
          { x: fromX, y: fromY },
          { x: fromX + 18, y: fromY },
          { x: fromX + 18, y: laneY },
          { x: toX - 18, y: laneY },
          { x: toX - 18, y: toY },
          { x: toX, y: toY },
        ],
        10,
      );
      laidOutEdges.push({ edge, key, path, fromX, fromY, toX, toY });
      return;
    }

    const fromX = source.x + source.width;
    const toX = target.x - ARROW_GAP;
    const points: Point[] = [{ x: fromX, y: fromY }];
    for (let i = 1; i + 1 < chain.length; i += 1) {
      const id = chain[i];
      if (id === undefined) continue;
      const slot = slots.get(id);
      if (slot === undefined) continue;
      const x = columnX(slot.layer);
      // Straight across the column, on a row no card occupies.
      points.push({ x, y: slot.centreY }, { x: x + NODE_WIDTH, y: slot.centreY });
    }
    points.push({ x: toX, y: toY });

    const head = points[0];
    if (head === undefined) return;
    let path = `M ${r(head.x)} ${r(head.y)}`;
    for (let i = 1; i < points.length; i += 1) {
      const a = points[i - 1];
      const b = points[i];
      if (a !== undefined && b !== undefined) path += ` ${link(a, b)}`;
    }
    laidOutEdges.push({ edge, key, path, fromX, fromY, toX, toY });
  });

  const width = MARGIN * 2 + layerCount * NODE_WIDTH + Math.max(0, layerCount - 1) * COLUMN_GAP;
  const height = gridBottom + MARGIN + (detours.length === 0 ? 0 : DETOUR_LANE_PITCH * (detours.length + 1));

  return {
    nodes: [...placed.values()],
    edges: laidOutEdges,
    width,
    height,
    layerCount,
    rowCount,
  };
}

/* -------------------------------------------------------------------------- */
/*  Encoding                                                                   */
/* -------------------------------------------------------------------------- */

export interface StateStyle {
  readonly tone: Tone;
  readonly label: string;
  readonly blurb: string;
  /** A dashed outline: a belief held privately rather than by the world. */
  readonly dashed: boolean;
  /** Struck through: the session has closed this path off. */
  readonly struck: boolean;
  /** A padlock glyph: known inside one organisation only. */
  readonly locked: boolean;
  /** The one state allowed a fill: a demonstrated result reads as settled. */
  readonly wash: boolean;
}

/** The nine epistemic states, each with a distinct treatment. */
export const STATE_STYLE: Readonly<Record<TechEpistemicState, StateStyle>> = {
  achieved: { tone: 'gain', label: 'Achieved', blurb: 'Demonstrated in this session.', dashed: false, struck: false, locked: false, wash: true },
  established: { tone: 'info', label: 'Established', blurb: 'Widely known and deployed.', dashed: false, struck: false, locked: false, wash: false },
  emerging: { tone: 'brand', label: 'Emerging', blurb: 'Technically credible and actively developing.', dashed: false, struck: false, locked: false, wash: false },
  forecast: { tone: 'neutral', label: 'Forecast', blurb: 'Broadly considered plausible.', dashed: false, struck: false, locked: false, wash: false },
  speculative: { tone: 'warn', label: 'Speculative', blurb: 'Weak or contested evidence.', dashed: false, struck: false, locked: false, wash: false },
  company_thesis: { tone: 'brand', label: 'Company thesis', blurb: 'Believed mainly by one company.', dashed: true, struck: false, locked: false, wash: false },
  secret: { tone: 'warn', label: 'Secret', blurb: 'Known only inside one organisation. Yours.', dashed: true, struck: false, locked: true, wash: false },
  discredited: { tone: 'loss', label: 'Discredited', blurb: 'Previously expected, now considered unlikely.', dashed: true, struck: false, locked: false, wash: false },
  dead_end: { tone: 'loss', label: 'Dead end', blurb: 'Session evidence has strongly undermined the path.', dashed: false, struck: true, locked: false, wash: false },
};

export const VISIBILITY_LABEL: Readonly<Record<TechVisibility, string>> = {
  public: 'Public',
  sector: 'Sector',
  company_private: 'Company private',
  classified: 'Classified',
};

export interface EdgeStyle {
  readonly label: string;
  readonly dash: string | undefined;
  readonly opacity: number;
  readonly arrow: boolean;
  readonly blurb: string;
}

/**
 * Edge kinds are told apart by **form**, never by a loud colour: solid,
 * dashed, dotted. All three sit at a low opacity so a hundred edges read as a
 * quiet substrate under the cards, and the one thing that ever goes bright is
 * the set of edges touching the node under the pointer.
 */
export const EDGE_STYLE: Readonly<Record<TechEdge['kind'], EdgeStyle>> = {
  depends: { label: 'Depends', dash: undefined, opacity: 0.5, arrow: true, blurb: 'The target needs the source first.' },
  unlocks: { label: 'Unlocks', dash: '7 5', opacity: 0.42, arrow: true, blurb: 'The source makes the target credible.' },
  informs: { label: 'Informs', dash: '1.5 4', opacity: 0.38, arrow: false, blurb: 'Evidence about the source updates belief in the target.' },
};

/**
 * Two lines of title, broken on words, so a box never overflows.
 *
 * Twenty characters is not arbitrary: the widest twenty-character run in the
 * UI font at 10.5px semibold measures ~134px, and a card leaves 141px between
 * the text inset and the state dot. A third line is dropped with an ellipsis
 * rather than allowed to grow the card, because the row grid is shared.
 */
export function wrapTitle(title: string, perLine = 20): string[] {
  const words = title.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const candidate = current.length === 0 ? word : `${current} ${word}`;
    if (candidate.length > perLine && current.length > 0) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
    if (lines.length === 2) break;
  }
  if (lines.length < 2 && current.length > 0) lines.push(current);
  if (lines.length === 2 && words.join(' ').length > lines.join(' ').length) {
    const last = lines[1] ?? '';
    lines[1] = `${last.slice(0, Math.max(0, perLine - 1))}…`;
  }
  return lines;
}
