/**
 * Sector tracks on the Frontier Map.
 *
 * A track is a lane: the nodes one sector is currently trying to reach, with a
 * name and a sentence. `TechGraph.tracks` carries them from world version 2 on
 * and is **empty** for a world-version-1 graph, which is one implicit AI lane —
 * so this file derives the lanes from the nodes themselves in that case, and
 * the Research screen never has to branch on a world version.
 *
 * Two things it is careful about.
 *
 * 1. **The graph handed in is already the projection.** `techGraphForCompany`
 *    drops a rival's secret nodes, so a track may name nodes that are not
 *    present. They are filtered out rather than rendered as a broken id, and a
 *    track left with nothing visible is dropped entirely — the player is not
 *    shown a lane whose whole contents are somebody else's secret.
 * 2. **Nothing is invented.** Titles and summaries come from the track when
 *    there is one and from `SECTOR_META` when there is not.
 */

import type { Sector, TechGraph, TechNode } from '@frontier/contracts';
import { SECTORS, SECTOR_META } from '@frontier/contracts';

export interface TrackView {
  readonly sector: Sector;
  readonly title: string;
  readonly summary: string;
  /** The nodes of this track that are actually in the projection. */
  readonly nodes: readonly TechNode[];
  /** True when the lane was derived from node sectors rather than declared. */
  readonly implicit: boolean;
}

/**
 * The lanes of a graph, in `SECTORS` order.
 *
 * Declared tracks win; where there are none, one lane per sector present among
 * the nodes. Either way a lane with no visible node does not appear.
 */
export function tracksOf(graph: TechGraph): readonly TrackView[] {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));

  if (graph.tracks.length > 0) {
    return graph.tracks
      .map((track) => {
        const nodes = track.nodeIds
          .map((id) => byId.get(id))
          .filter((node): node is TechNode => node !== undefined);
        return { sector: track.sector, title: track.title, summary: track.summary, nodes, implicit: false } satisfies TrackView;
      })
      .filter((track) => track.nodes.length > 0);
  }

  return SECTORS.map((sector) => {
    const nodes = graph.nodes.filter((node) => node.sector === sector);
    return {
      sector,
      title: SECTOR_META[sector].label,
      summary: SECTOR_META[sector].tagline,
      nodes,
      implicit: true,
    } satisfies TrackView;
  }).filter((track) => track.nodes.length > 0);
}

/** The lane a node sits in, or null when nothing claims it. */
export function trackForNode(tracks: readonly TrackView[], nodeId: string): TrackView | null {
  return tracks.find((track) => track.nodes.some((node) => node.id === nodeId)) ?? null;
}

/** The node ids of one sector's lane — what the map filter highlights. */
export function nodeIdsInSector(tracks: readonly TrackView[], sector: Sector): ReadonlySet<string> {
  const out = new Set<string>();
  for (const track of tracks) {
    if (track.sector !== sector) continue;
    for (const node of track.nodes) out.add(node.id);
  }
  return out;
}
