/**
 * Sector tracks on the Frontier Map.
 *
 * The lanes have to work in both worlds without the screen knowing which world
 * it is in, so what this file pins is the fallback and the boundary:
 *
 * 1. a world-version-2 graph declares its tracks and they are used verbatim;
 * 2. a world-version-1 graph declares none, and one implicit lane is derived
 *    from the node sectors instead — which for that world is a single AI lane,
 *    so the screen's sector controls stay switched off;
 * 3. a track never names a node the viewer cannot see. The graph handed in is
 *    already `techGraphForCompany`, so a rival's secret node is gone from it,
 *    and a track that referenced one must not render a dangling id.
 */

import { describe, expect, it } from 'vitest';
import type { NewGameSetupInput, SessionState, TechGraph } from '@frontier/contracts';
import { CURRENT_WORLD_VERSION, SECTORS } from '@frontier/contracts';
import { createDemoSession, techGraphForCompany } from '@frontier/simulation';
import { nodeIdsInSector, trackForNode, tracksOf } from './tracks';

const MULTI_SECTOR_SETUP: NewGameSetupInput = {
  companyName: 'Player Ventures',
  founderName: 'Avery Sinclair',
  backgroundId: 'frontier_lab',
  worldVersion: CURRENT_WORLD_VERSION,
};

function graphOf(state: SessionState): TechGraph {
  const company = state.companies.find((entry) => entry.controllerPlayerId !== null);
  if (company === undefined) throw new Error('no player company');
  return techGraphForCompany(state.techGraph, company.id);
}

describe('declared tracks', () => {
  const graph = graphOf(createDemoSession(undefined, MULTI_SECTOR_SETUP));
  const tracks = tracksOf(graph);

  it('gives the multi-sector world one lane per sector', () => {
    expect(tracks.length).toBe(SECTORS.length);
    expect(tracks.map((track) => track.sector).sort()).toEqual([...SECTORS].sort());
    for (const track of tracks) {
      expect(track.implicit, track.title).toBe(false);
      expect(track.title.length).toBeGreaterThan(2);
      expect(track.summary.length).toBeGreaterThan(0);
    }
  });

  it('only ever names nodes that are in the projection', () => {
    const visible = new Set(graph.nodes.map((node) => node.id));
    for (const track of tracks) {
      for (const node of track.nodes) expect(visible.has(node.id), `${track.title}/${node.id}`).toBe(true);
    }
  });

  it('places every visible node in exactly one lane', () => {
    const seen = tracks.flatMap((track) => track.nodes.map((node) => node.id));
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.length).toBe(graph.nodes.length);
  });

  it('answers which lane a node is in, and nothing for an id that is not there', () => {
    const first = graph.nodes[0];
    expect(first).toBeDefined();
    if (first === undefined) return;
    expect(trackForNode(tracks, first.id)?.sector).toBe(first.sector);
    expect(trackForNode(tracks, 'tech_does_not_exist')).toBeNull();
  });

  it('collects the node ids of one sector, which is what the map filter lights', () => {
    for (const sector of SECTORS) {
      const ids = nodeIdsInSector(tracks, sector);
      expect(ids.size, sector).toBeGreaterThan(0);
      for (const id of ids) {
        expect(graph.nodes.find((node) => node.id === id)?.sector, id).toBe(sector);
      }
    }
  });
});

describe('the world-version-1 fallback', () => {
  const graph = graphOf(createDemoSession());

  it('declares no tracks at all', () => {
    expect(graph.tracks).toEqual([]);
  });

  it('derives one implicit AI lane, which is what keeps the sector controls off', () => {
    const tracks = tracksOf(graph);
    expect(tracks).toHaveLength(1);
    expect(tracks[0]?.sector).toBe('ai');
    expect(tracks[0]?.implicit).toBe(true);
    expect(tracks[0]?.nodes.length).toBe(graph.nodes.length);
  });
});

describe('a declared track whose nodes are not all visible', () => {
  it('drops the missing ids and the lane itself when nothing is left', () => {
    const base = graphOf(createDemoSession(undefined, MULTI_SECTOR_SETUP));
    const survivor = base.nodes[0];
    expect(survivor).toBeDefined();
    if (survivor === undefined) return;

    const graph: TechGraph = {
      ...base,
      tracks: [
        { sector: 'ai', title: 'Half here', summary: 'One real node and one that is somebody else’s secret.', nodeIds: [survivor.id, 'tech_secret'] },
        { sector: 'energy', title: 'All secret', summary: 'Every node in this lane is invisible to the viewer.', nodeIds: ['tech_secret_a', 'tech_secret_b'] },
      ],
    };

    const tracks = tracksOf(graph);
    expect(tracks).toHaveLength(1);
    expect(tracks[0]?.title).toBe('Half here');
    expect(tracks[0]?.nodes.map((node) => node.id)).toEqual([survivor.id]);
  });
});
