/**
 * @frontier/simulation — graph/techGraph.ts
 *
 * The one graph, seen from the research subsystem.
 *
 * World 3 has a single table of things — `ECONOMIC_NODES` — and research aims
 * at a row of it. The research subsystem, however, reads `SessionState.techGraph`
 * and stores `ResearchProject.targetNodeId` against a node in it, and that
 * subsystem is worth keeping exactly as it is: `effortPlan`,
 * `programmeForecast`, `resourcingFactors`, `adjust_research_project` and every
 * screen built on them are the part of the game the owner likes.
 *
 * So this module *projects* the node table into the shape the research
 * subsystem already speaks, id for id. A world-3 `TechNode` is not a second
 * catalogue that can drift from the first: every field is read off the
 * `EconomicNode` of the same id, and there is nowhere for a second opinion to
 * live.
 *
 * | tech node field       | comes from                       |
 * |-----------------------|----------------------------------|
 * | `id`, `sector`        | the node itself, unchanged       |
 * | `dependencies`        | `requires`                       |
 * | `possibleUnlocks`     | reverse `requires`               |
 * | `researchCostRange`   | `researchCostRangeUsd`           |
 * | `computeIntensity`    | `researchComputeIntensity`       |
 * | `talentRequirements`  | `talentAreas`                    |
 * | `status`              | `maturity`                       |
 *
 * Only `researchable` nodes are projected. A raw resource is not a programme
 * anybody runs, and world 2's map was ninety rows for exactly that reason.
 *
 * `status` is a statement about the WORLD, never about a company: it never
 * becomes `achieved`, because in world 3 whether a thing is achieved is a
 * question about a company and is answered by `Company.ownedNodes`. What a
 * public first achievement moves instead is the node's state one rung along
 * `STATE_LADDER`, in session state, which is how the world learns that
 * something is possible.
 *
 * Pure. No RNG, no clock, no module-level cache.
 */

import type { TechEpistemicState, TechGraph, TechNode, TechTrack } from '@frontier/contracts';
import { ECONOMIC_NODES, SECTORS, economicNodeById, type EconomicNode, type NodeMaturity, type Sector } from '@frontier/contracts';

/* -------------------------------------------------------------------------- */
/*  Maturity                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * How a node's maturity reads as an epistemic state.
 *
 * Deliberately total and deliberately missing `achieved`: the world knowing a
 * thing is possible and one company being able to make it are different facts,
 * and conflating them is what locked every line on turn one in world 2.
 */
export const MATURITY_STATE: Readonly<Record<NodeMaturity, TechEpistemicState>> = {
  commodity: 'established',
  established: 'established',
  emerging: 'emerging',
  frontier: 'forecast',
  speculative: 'speculative',
  discredited: 'discredited',
};

/**
 * The epistemic ladder, hardest first, and the one direction it moves.
 *
 * A public first achievement steps a node one rung toward "everybody does
 * this", which is how the world learns that a thing is possible. It moves the
 * node's state in SESSION STATE, never the node table: `ECONOMIC_NODES` is a
 * module-level constant and writing to it would leak one save into the next
 * and break replay outright.
 *
 * `discredited` is off the ladder: a path the world had written off and
 * somebody then demonstrated re-enters at `forecast`, which is what being
 * proved wrong looks like.
 */
export const STATE_LADDER: readonly TechEpistemicState[] = ['speculative', 'forecast', 'emerging', 'established'];

/** One rung toward routine, or the same state when it is already there. */
export function stateAfterFirstAchievement(status: TechEpistemicState): TechEpistemicState {
  if (status === 'discredited' || status === 'dead_end') return 'forecast';
  const index = STATE_LADDER.indexOf(status);
  if (index < 0) return status;
  return STATE_LADDER[Math.min(STATE_LADDER.length - 1, index + 1)] ?? status;
}

/* -------------------------------------------------------------------------- */
/*  Projection                                                                 */
/* -------------------------------------------------------------------------- */

/** Every node that names `nodeId` in its own `requires`, in table order. */
export function unlockedByNode(nodeId: string): readonly string[] {
  return ECONOMIC_NODES.filter((entry) => entry.requires.includes(nodeId)).map((entry) => entry.id);
}

/** One economic node as the research subsystem sees it. */
export function projectNode(node: EconomicNode): TechNode {
  return {
    id: node.id,
    title: node.label,
    summary: node.blurb,
    sector: node.sector,
    status: MATURITY_STATE[node.maturity],
    publicConfidence: node.publicConfidence,
    // A fresh object per node: the research phase writes company confidence
    // into it, and a shared reference would let one node's belief become
    // another's.
    confidenceByCompany: {},
    estimatedWindow: [node.estimatedWindow[0], node.estimatedWindow[1]],
    researchCostRange: [node.researchCostRangeUsd[0], node.researchCostRangeUsd[1]],
    computeIntensity: node.researchComputeIntensity,
    talentRequirements: [...node.talentAreas],
    dependencies: [...node.requires],
    possibleUnlocks: [...unlockedByNode(node.id)],
    originalProposerId: node.originalProposerId,
    visibility: node.visibility,
    // In world 3 these two record the PIONEER — who produced this first, and
    // when — and gate nothing at all. Ownership is per company and lives on
    // the company, which is the whole of the fix for world 2's turn-one
    // lockout.
    achievedByCompanyId: null,
    achievedQuarter: null,
    createdQuarter: node.createdQuarter,
    novelty: node.novelty,
    plausibility: node.plausibility,
  };
}

/** Every researchable node, projected, in the node table's own order. */
export function nodeTechNodes(): readonly TechNode[] {
  return ECONOMIC_NODES.filter((entry) => entry.researchable).map((entry) => projectNode(entry));
}

/** One lane per sector, in `SECTORS` order, holding that sector's projected nodes. */
export function nodeTechTracks(nodes: readonly TechNode[]): readonly TechTrack[] {
  const tracks: TechTrack[] = [];
  for (const sector of SECTORS) {
    const nodeIds = nodes.filter((node) => node.sector === sector).map((node) => node.id);
    if (nodeIds.length === 0) continue;
    tracks.push({
      sector: sector as Sector,
      title: SECTOR_TRACK_TITLE[sector as Sector],
      summary: SECTOR_TRACK_SUMMARY[sector as Sector],
      nodeIds,
    });
  }
  return tracks;
}

/** What each lane is called above its column on the map. Whole words, no jargon. */
export const SECTOR_TRACK_TITLE: Readonly<Record<Sector, string>> = {
  ai: 'Models and inference',
  robotics: 'Machines that act',
  manufacturing: 'Silicon and structure',
  energy: 'Power and storage',
  logistics: 'Moving things',
  consumer: 'What people buy',
};

/** One sentence on what each lane is currently trying to reach. */
export const SECTOR_TRACK_SUMMARY: Readonly<Record<Sector, string>> = {
  ai: 'Training, evaluating and serving models, and the datasets that make them worth serving.',
  robotics: 'Actuators, perception and the policies that turn them into work somebody pays for.',
  manufacturing: 'Wafers, dies, packages and the plant that turns them into hardware.',
  energy: 'Generation, storage and the interconnects that let a datacentre switch on.',
  logistics: 'Line haul, last mile and the routing that decides what either of them costs.',
  consumer: 'Devices, brands and the marketplaces people buy them through.',
};

/**
 * The world-3 Frontier Map: every researchable node, wired by `requires`.
 *
 * `edges` is deliberately empty. A second edge list that can disagree with
 * `requires` is exactly the drift that made world 2's `unlocksCategoryIds` dead
 * weight; belief propagates along reverse-`requires`, which `possibleUnlocks`
 * already carries.
 */
export function nodeTechGraph(sessionId: string, quarter = 0): TechGraph {
  const nodes = nodeTechNodes();
  return {
    version: 1,
    sessionId,
    nodes: [...nodes],
    edges: [],
    tracks: [...nodeTechTracks(nodes)],
    updatedQuarter: quarter,
  };
}

/** True when this tech node id is a row of the one node table. */
export function isEconomicTechNode(nodeId: string): boolean {
  return economicNodeById(nodeId) !== undefined;
}
