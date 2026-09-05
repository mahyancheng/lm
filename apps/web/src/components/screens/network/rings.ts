/**
 * The people web, as geometry.
 *
 * The directory answers "who is out there"; the web answers the question a
 * founder actually has, which is **how far away is each of them**. So the layout
 * is not decorative: the ring a person sits in *is* their access state, read
 * straight off `checkAccess` through the directory entry, and the distance from
 * the middle is the distance in the game.
 *
 * - **Inner ring — reachable.** You can open a channel with them this quarter,
 *   directly or through a standing override.
 * - **Middle ring — needs an introduction.** The gap refuses direct contact, but
 *   somebody you *can* reach can reach them. That route is drawn as a dashed
 *   edge from the broker, because it is the move.
 * - **Outer ring — out of reach.** Nobody you can reach can reach them either.
 *   The way in is to build the middle ring first.
 *
 * Every position is derived and deterministic: people are ordered by connection
 * level (then by id, so ties never flicker), spaced evenly around their ring,
 * and given a few degrees of stable jitter from `fnv1a64` of their own id so the
 * web looks drawn rather than dialled. Two renders place everybody identically.
 */

// Imported by relative path rather than through the `@/` alias so this module
// stays loadable by its own unit test: the web app runs vitest with no
// path-alias plugin, and its configuration is not this screen's to change.
import { pickIndex } from '../../scenes/people/look';
import type { DirectoryEntry } from './directory';

export type Ring = 'inner' | 'middle' | 'outer';

export const RING_ORDER: readonly Ring[] = ['inner', 'middle', 'outer'];

export const RING_LABEL: Readonly<Record<Ring, string>> = {
  inner: 'Reachable now',
  middle: 'Needs an introduction',
  outer: 'Out of reach',
};

export const RING_TONE: Readonly<Record<Ring, 'gain' | 'info' | 'warn'>> = {
  inner: 'gain',
  middle: 'info',
  outer: 'warn',
};

/** Ellipse radii in stage percent, and where the ring starts its sweep. */
export const RING_GEOMETRY: Readonly<Record<Ring, { readonly rx: number; readonly ry: number; readonly start: number }>> = {
  inner: { rx: 20, ry: 22, start: -90 },
  middle: { rx: 32, ry: 32, start: -74 },
  outer: { rx: 44, ry: 41, start: -58 },
};

/** The ring a directory entry belongs in. */
export function ringOf(entry: DirectoryEntry): Ring {
  if (entry.state !== 'blocked') return 'inner';
  return entry.brokerIds.length > 0 ? 'middle' : 'outer';
}

export interface WebNode {
  readonly entry: DirectoryEntry;
  readonly ring: Ring;
  /** Percent of stage width and height, for the centre of the node. */
  readonly xPct: number;
  readonly yPct: number;
  /** 0…1: how strong the player's dealings with them are. 0 means none. */
  readonly strength: number;
  /** True when either direction of the relationship is actively hostile. */
  readonly hostile: boolean;
}

/**
 * How much of a relationship there is, in one number.
 *
 * Trust and respect in the two directions incident to the player, averaged over
 * whichever of them exist. It is a *thickness*, not a game statistic — the
 * drawer behind the node is where the four dimensions are read honestly, in both
 * directions, without being flattened.
 */
export function edgeStrength(entry: DirectoryEntry): number {
  const edges = [entry.outbound, entry.inbound].filter((edge): edge is NonNullable<typeof edge> => edge !== null);
  if (edges.length === 0) return 0;
  const total = edges.reduce((sum, edge) => sum + (edge.trust + edge.respect) / 2, 0);
  return Math.max(0, Math.min(1, total / (edges.length * 100)));
}

/** True when either direction carries real antagonism. */
export function isHostile(entry: DirectoryEntry): boolean {
  return (entry.outbound?.hostility ?? 0) >= 50 || (entry.inbound?.hostility ?? 0) >= 50;
}

/** The order people are read in, inside any ring: furthest up the ladder first. */
function byStanding(a: DirectoryEntry, b: DirectoryEntry): number {
  const byConnection = b.character.connectionLevel - a.character.connectionLevel;
  return byConnection !== 0 ? byConnection : a.character.id.localeCompare(b.character.id);
}

export interface RingGroup {
  readonly ring: Ring;
  readonly entries: readonly DirectoryEntry[];
}

/**
 * The same three rings, as three lists.
 *
 * A phone is 390px wide and the web is a picture whose whole meaning is the
 * distance between two faces; squeezed to that width the rings collapse into a
 * pile and read as nothing. The list says exactly what the picture says —
 * reachable, one introduction away, out of reach — in the order the picture
 * places them, so moving between the two never reshuffles anybody.
 *
 * Empty rings are kept: "nobody is out of your reach" is information.
 */
export function groupByRing(entries: readonly DirectoryEntry[]): RingGroup[] {
  const byRing = new Map<Ring, DirectoryEntry[]>(RING_ORDER.map((ring) => [ring, []]));
  for (const entry of entries) byRing.get(ringOf(entry))?.push(entry);
  return RING_ORDER.map((ring) => ({ ring, entries: (byRing.get(ring) ?? []).slice().sort(byStanding) }));
}

/**
 * Lay the whole directory out around the player.
 *
 * Ordering is by connection level descending and then by id, which is total and
 * stable: the same session lays out identically every time, and adding one
 * person shifts the ring they joined rather than reshuffling the web.
 */
export function layoutRings(entries: readonly DirectoryEntry[]): WebNode[] {
  const byRing = new Map<Ring, DirectoryEntry[]>(RING_ORDER.map((ring) => [ring, []]));
  for (const entry of entries) byRing.get(ringOf(entry))?.push(entry);

  const nodes: WebNode[] = [];
  for (const ring of RING_ORDER) {
    const members = (byRing.get(ring) ?? []).slice().sort(byStanding);
    const geometry = RING_GEOMETRY[ring];
    for (const [index, entry] of members.entries()) {
      const step = 360 / Math.max(1, members.length);
      // ±5 degrees and ±1.5 percent of stable wobble: enough that the ring reads
      // as a constellation rather than a clock face, small enough that the
      // ordering is still legible.
      const jitterAngle = (pickIndex(entry.character.id, 'weba', 11) - 5) * (members.length > 12 ? 0.4 : 1);
      const jitterRadius = (pickIndex(entry.character.id, 'webr', 7) - 3) * 0.5;
      const degrees = geometry.start + index * step + jitterAngle;
      const radians = (degrees * Math.PI) / 180;
      nodes.push({
        entry,
        ring,
        xPct: 50 + (geometry.rx + jitterRadius) * Math.cos(radians),
        yPct: 50 + (geometry.ry + jitterRadius) * Math.sin(radians),
        strength: edgeStrength(entry),
        hostile: isHostile(entry),
      });
    }
  }
  return nodes;
}
