/**
 * The Frontier Map layout is a drawing algorithm, so it is tested the way a
 * drawing is judged: by geometry, not by internals.
 *
 * Two properties carry the whole redesign and neither can be eyeballed
 * reliably at review time:
 *
 *  1. **No edge is drawn through a node.** Every path is sampled into a
 *     polyline and intersected against every node rectangle. Sugiyama dummy
 *     slots are what make this true — a long edge occupies a real, empty row
 *     in each column it crosses — so this test is the thing that would catch
 *     a regression in the dummy chain or in the port fan-out.
 *  2. **Crossings stay at or below a measured bound.** The number is pinned
 *     from the demo graph rather than derived, because barycenter ordering has
 *     no closed form; it is a ratchet, and it is allowed to move down.
 */

import { describe, expect, it } from 'vitest';
import { createDemoSession, techGraphForCompany } from '@frontier/simulation';
import type { TechGraph } from '@frontier/contracts';
import { ROW_PITCH, depthsOf, layoutGraph } from './graphLayout';

/* -------------------------------------------------------------------------- */
/*  A minimal path sampler — enough for the M / L / C / Q this file emits.     */
/* -------------------------------------------------------------------------- */

interface Point {
  readonly x: number;
  readonly y: number;
}

/** Sample an SVG path into a polyline. Curves become 24 chords each. */
export function samplePath(d: string, perCurve = 24): Point[] {
  const tokens = d.trim().split(/[\s,]+/);
  const points: Point[] = [];
  let cursor: Point = { x: 0, y: 0 };
  let i = 0;

  const num = (): number => {
    const value = Number.parseFloat(tokens[i] ?? '');
    i += 1;
    if (!Number.isFinite(value)) throw new Error(`bad path number in ${d}`);
    return value;
  };

  while (i < tokens.length) {
    const command = tokens[i];
    i += 1;
    if (command === 'M') {
      cursor = { x: num(), y: num() };
      points.push(cursor);
    } else if (command === 'L') {
      cursor = { x: num(), y: num() };
      points.push(cursor);
    } else if (command === 'C') {
      const c1 = { x: num(), y: num() };
      const c2 = { x: num(), y: num() };
      const end = { x: num(), y: num() };
      for (let step = 1; step <= perCurve; step += 1) {
        const t = step / perCurve;
        const u = 1 - t;
        points.push({
          x: u * u * u * cursor.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * end.x,
          y: u * u * u * cursor.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * end.y,
        });
      }
      cursor = end;
    } else if (command === 'Q') {
      const c1 = { x: num(), y: num() };
      const end = { x: num(), y: num() };
      for (let step = 1; step <= perCurve; step += 1) {
        const t = step / perCurve;
        const u = 1 - t;
        points.push({
          x: u * u * cursor.x + 2 * u * t * c1.x + t * t * end.x,
          y: u * u * cursor.y + 2 * u * t * c1.y + t * t * end.y,
        });
      }
      cursor = end;
    } else {
      throw new Error(`unsupported path command ${String(command)} in ${d}`);
    }
  }
  return points;
}

interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

function segmentHitsRect(a: Point, b: Point, rect: Rect): boolean {
  const inside = (p: Point): boolean =>
    p.x > rect.x && p.x < rect.x + rect.width && p.y > rect.y && p.y < rect.y + rect.height;
  if (inside(a) || inside(b)) return true;
  const edges: readonly (readonly [Point, Point])[] = [
    [{ x: rect.x, y: rect.y }, { x: rect.x + rect.width, y: rect.y }],
    [{ x: rect.x + rect.width, y: rect.y }, { x: rect.x + rect.width, y: rect.y + rect.height }],
    [{ x: rect.x + rect.width, y: rect.y + rect.height }, { x: rect.x, y: rect.y + rect.height }],
    [{ x: rect.x, y: rect.y + rect.height }, { x: rect.x, y: rect.y }],
  ];
  return edges.some(([c, d]) => properIntersect(a, b, c, d));
}

function cross(o: Point, a: Point, b: Point): number {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

/** A strict crossing: the two open segments meet at a point interior to both. */
function properIntersect(a: Point, b: Point, c: Point, d: Point): boolean {
  const d1 = cross(a, b, c);
  const d2 = cross(a, b, d);
  const d3 = cross(c, d, a);
  const d4 = cross(c, d, b);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/**
 * Geometric crossings between drawn edges.
 *
 * Two edges that share an endpoint node touch at a port and are not counted;
 * everything else that meets is a crossing a reader has to untangle.
 */
export function countCrossings(layout: ReturnType<typeof layoutGraph>): number {
  const sampled = layout.edges.map((laid) => ({ laid, points: samplePath(laid.path) }));
  let total = 0;
  for (let a = 0; a < sampled.length; a += 1) {
    for (let b = a + 1; b < sampled.length; b += 1) {
      const one = sampled[a];
      const two = sampled[b];
      if (one === undefined || two === undefined) continue;
      const shared =
        one.laid.edge.from === two.laid.edge.from ||
        one.laid.edge.from === two.laid.edge.to ||
        one.laid.edge.to === two.laid.edge.from ||
        one.laid.edge.to === two.laid.edge.to;
      if (shared) continue;
      let hit = false;
      for (let p = 0; p + 1 < one.points.length && !hit; p += 1) {
        for (let q = 0; q + 1 < two.points.length && !hit; q += 1) {
          const a1 = one.points[p];
          const a2 = one.points[p + 1];
          const b1 = two.points[q];
          const b2 = two.points[q + 1];
          if (a1 && a2 && b1 && b2 && properIntersect(a1, a2, b1, b2)) hit = true;
        }
      }
      if (hit) total += 1;
    }
  }
  return total;
}

/** Edge samples that fall inside a node box other than their own endpoints. */
export function edgesThroughNodes(layout: ReturnType<typeof layoutGraph>): string[] {
  const offences: string[] = [];
  for (const laid of layout.edges) {
    const points = samplePath(laid.path);
    for (const placed of layout.nodes) {
      if (placed.node.id === laid.edge.from || placed.node.id === laid.edge.to) continue;
      // A 1px inset keeps a path that grazes a card's border from counting.
      const rect: Rect = {
        x: placed.x + 1,
        y: placed.y + 1,
        width: placed.width - 2,
        height: placed.height - 2,
      };
      for (let p = 0; p + 1 < points.length; p += 1) {
        const a = points[p];
        const b = points[p + 1];
        if (a && b && segmentHitsRect(a, b, rect)) {
          offences.push(`${laid.edge.from}->${laid.edge.to} crosses ${placed.node.id}`);
          break;
        }
      }
    }
  }
  return offences;
}

/* -------------------------------------------------------------------------- */

function demoGraph(): TechGraph {
  const session = createDemoSession();
  const company = session.companies.find((entry) => entry.controllerPlayerId === 'player_1');
  if (company === undefined) throw new Error('demo session has no player company');
  return techGraphForCompany(session.techGraph, company.id);
}

describe('frontier map layout', () => {
  const graph = demoGraph();
  const layout = layoutGraph(graph);

  it('places every visible node exactly once', () => {
    expect(layout.nodes.length).toBe(graph.nodes.length);
    expect(new Set(layout.nodes.map((placed) => placed.node.id)).size).toBe(graph.nodes.length);
  });

  it('is deterministic — the same graph lays out identically', () => {
    const again = layoutGraph(demoGraph());
    expect(again.nodes.map((n) => [n.node.id, n.x, n.y])).toEqual(layout.nodes.map((n) => [n.node.id, n.x, n.y]));
    expect(again.edges.map((e) => e.path)).toEqual(layout.edges.map((e) => e.path));
  });

  it('draws no edge through a node box', () => {
    expect(edgesThroughNodes(layout)).toEqual([]);
  });

  it('holds edge crossings at or below the measured bound', () => {
    const crossings = countCrossings(layout);
    // Measured, not derived: barycenter ordering has no closed form. This is a
    // ratchet — it may be lowered when the layout improves, never raised.
    // eslint-disable-next-line no-console
    console.log('demo graph crossings:', crossings);
    // Measured on the demo graph today: 0 (it was 9 before barycenter ordering).
    // One is allowed as slack for a demo-data tweak; anything above is a bug.
    expect(crossings).toBeLessThanOrEqual(1);
  });

  it('puts every node on the shared row grid', () => {
    const offsets = new Set(layout.nodes.map((placed) => (placed.y + placed.height / 2) % ROW_PITCH));
    expect(offsets.size).toBe(1);
  });

  it('lays layers out left to right by longest-path depth', () => {
    const depth = depthsOf(graph.nodes, graph.edges);
    for (const placed of layout.nodes) expect(placed.layer).toBe(depth.get(placed.node.id));
    const xs = new Map<number, number>();
    for (const placed of layout.nodes) {
      const seen = xs.get(placed.layer);
      if (seen === undefined) xs.set(placed.layer, placed.x);
      else expect(placed.x).toBe(seen);
    }
  });
});
