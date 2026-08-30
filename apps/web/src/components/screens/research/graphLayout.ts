/**
 * Deterministic layout for the Frontier Map.
 *
 * No physics, no randomness, no clock. Nodes are placed in dependency layers by
 * longest-path depth and ordered inside a layer by public confidence, so the
 * same graph always lays out the same way and a player's spatial memory of it
 * survives a reload. When the graph version changes the arrangement moves —
 * that movement is the point, and it is a consequence of the data, never of a
 * simulation running in the browser.
 *
 * `UI_SYSTEM.md` §4 is the contract this file implements: fill encodes the
 * epistemic state, opacity encodes public confidence, the border encodes
 * visibility, size encodes compute intensity, and a secondary bar carries this
 * company's own confidence when it differs from the public figure.
 */

import type { TechEdge, TechEpistemicState, TechGraph, TechNode, TechVisibility } from '@frontier/contracts';
import type { Tone } from '@/components/ui';

/* -------------------------------------------------------------------------- */
/*  Geometry                                                                   */
/* -------------------------------------------------------------------------- */

export const NODE_WIDTH = 156;
export const MIN_NODE_HEIGHT = 46;
export const MAX_NODE_HEIGHT = 66;
export const COLUMN_GAP = 76;
export const ROW_GAP = 22;
export const MARGIN = 24;

export interface LaidOutNode {
  readonly node: TechNode;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly layer: number;
}

export interface LaidOutEdge {
  readonly edge: TechEdge;
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
  return Math.round(MIN_NODE_HEIGHT + (MAX_NODE_HEIGHT - MIN_NODE_HEIGHT) * Math.max(0, Math.min(1, node.computeIntensity)));
}

/** Lay the whole graph out. Pure, and stable for a given graph. */
export function layoutGraph(graph: TechGraph): GraphLayout {
  const nodes = [...graph.nodes];
  const depth = depthsOf(nodes, graph.edges);

  const byLayer = new Map<number, TechNode[]>();
  for (const node of nodes) {
    const layer = depth.get(node.id) ?? 0;
    const bucket = byLayer.get(layer);
    if (bucket === undefined) byLayer.set(layer, [node]);
    else bucket.push(node);
  }

  const layers = [...byLayer.keys()].sort((a, b) => a - b);
  const placed = new Map<string, LaidOutNode>();

  let tallest = 0;
  for (const layer of layers) {
    const bucket = byLayer.get(layer) ?? [];
    bucket.sort((a, b) => (b.publicConfidence - a.publicConfidence) || a.id.localeCompare(b.id));
    const stackHeight = bucket.reduce((total, node) => total + heightOf(node) + ROW_GAP, -ROW_GAP);
    tallest = Math.max(tallest, stackHeight);
  }

  for (const layer of layers) {
    const bucket = byLayer.get(layer) ?? [];
    const stackHeight = bucket.reduce((total, node) => total + heightOf(node) + ROW_GAP, -ROW_GAP);
    let cursor = MARGIN + (tallest - stackHeight) / 2;
    const x = MARGIN + layer * (NODE_WIDTH + COLUMN_GAP);
    for (const node of bucket) {
      const height = heightOf(node);
      placed.set(node.id, { node, x, y: cursor, width: NODE_WIDTH, height, layer });
      cursor += height + ROW_GAP;
    }
  }

  const laidOutEdges: LaidOutEdge[] = [];
  for (const edge of graph.edges) {
    const from = placed.get(edge.from);
    const to = placed.get(edge.to);
    if (from === undefined || to === undefined) continue;

    const forward = to.x >= from.x;
    const fromX = forward ? from.x + from.width : from.x;
    const toX = forward ? to.x : to.x + to.width;
    const fromY = from.y + from.height / 2;
    const toY = to.y + to.height / 2;
    const curve = Math.max(28, Math.abs(toX - fromX) * 0.45) * (forward ? 1 : -1);

    laidOutEdges.push({
      edge,
      fromX,
      fromY,
      toX,
      toY,
      path: `M ${fromX} ${fromY} C ${fromX + curve} ${fromY}, ${toX - curve} ${toY}, ${toX} ${toY}`,
    });
  }

  const width = MARGIN * 2 + Math.max(1, layers.length) * NODE_WIDTH + Math.max(0, layers.length - 1) * COLUMN_GAP;
  const height = MARGIN * 2 + Math.max(tallest, MIN_NODE_HEIGHT);

  return {
    nodes: [...placed.values()],
    edges: laidOutEdges,
    width,
    height,
    layerCount: layers.length,
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
}

/** The nine epistemic states, each with a distinct treatment. */
export const STATE_STYLE: Readonly<Record<TechEpistemicState, StateStyle>> = {
  achieved: { tone: 'gain', label: 'Achieved', blurb: 'Demonstrated in this session.', dashed: false, struck: false, locked: false },
  established: { tone: 'info', label: 'Established', blurb: 'Widely known and deployed.', dashed: false, struck: false, locked: false },
  emerging: { tone: 'brand', label: 'Emerging', blurb: 'Technically credible and actively developing.', dashed: false, struck: false, locked: false },
  forecast: { tone: 'neutral', label: 'Forecast', blurb: 'Broadly considered plausible.', dashed: false, struck: false, locked: false },
  speculative: { tone: 'warn', label: 'Speculative', blurb: 'Weak or contested evidence.', dashed: false, struck: false, locked: false },
  company_thesis: { tone: 'brand', label: 'Company thesis', blurb: 'Believed mainly by one company.', dashed: true, struck: false, locked: false },
  secret: { tone: 'warn', label: 'Secret', blurb: 'Known only inside one organisation. Yours.', dashed: true, struck: false, locked: true },
  discredited: { tone: 'loss', label: 'Discredited', blurb: 'Previously expected, now considered unlikely.', dashed: true, struck: false, locked: false },
  dead_end: { tone: 'loss', label: 'Dead end', blurb: 'Session evidence has strongly undermined the path.', dashed: false, struck: true, locked: false },
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

export const EDGE_STYLE: Readonly<Record<TechEdge['kind'], EdgeStyle>> = {
  depends: { label: 'Depends', dash: undefined, opacity: 0.85, arrow: true, blurb: 'The target needs the source first.' },
  unlocks: { label: 'Unlocks', dash: '6 4', opacity: 0.55, arrow: true, blurb: 'The source makes the target credible.' },
  informs: { label: 'Informs', dash: '2 4', opacity: 0.4, arrow: false, blurb: 'Evidence about the source updates belief in the target.' },
};

/**
 * Fill opacity from public confidence: the world's conviction, made visible.
 *
 * The range is tuned for the light theme — a tint over white, never a slab of
 * saturated colour — so the slate title on top of a fully-believed node still
 * clears 5:1. Confidence is still the only thing the opacity encodes.
 */
export function fillOpacityOf(node: TechNode): number {
  return 0.12 + 0.4 * Math.max(0, Math.min(1, node.publicConfidence));
}

/** Two lines of title, broken on words, so a box never overflows. */
export function wrapTitle(title: string, perLine = 22): string[] {
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
