/**
 * @frontier/simulation — graph/researchMap.ts
 *
 * Research as the same three columns the Connections screen draws: what this
 * company already holds on the left, what it could reach next on the right, and
 * beneath each of those what holding it would let the company sell.
 *
 * The Frontier Map showed the whole ninety-row table laid out by sector and
 * asked a founder to find themselves in it. This answers the smaller question —
 * *from where I stand, what is one programme away, what would it cost, and what
 * does it get me* — which is the question a founder actually has.
 *
 * Every figure comes from the research subsystem's own arithmetic:
 * `effortPlan`, `programmeForecast` and `runningForecast`, called with the same
 * standard preset the drawer would queue. Nothing here models a second time
 * what `advanceProjects` does, so a forecast on the screen and the programme it
 * becomes cannot disagree.
 *
 * ## Scope
 *
 * A company sees its own sector plus everything unlocked by something it
 * already holds. That is the ownership rule made visible: an AI laboratory does
 * not browse robotics until it owns a robotics node, and the moment it does,
 * what that node unlocks appears.
 *
 * Pure and total. No random source, no clock, no module-level cache.
 */

import type { Company, EconomicNode, ResearchProject, SessionState, Sector } from '@frontier/contracts';
import { ECONOMIC_NODES, SECTORS, canProduce, holdsNode } from '@frontier/contracts';
import { sectorOf } from '../economy/sectors';
import {
  effortPlan,
  programmeForecast,
  researchCapacity,
  runningForecast,
  type ProgrammePlan,
  type ResearchBottleneck,
} from '../research/forecast';
import { lineNodeIdOf } from './lines';
import { nodeEntryRoutes, type MissingNodeRoute, type NodeEntryRoutes } from './options';
import { projectNode, unlockedByNode } from './techGraph';

/* -------------------------------------------------------------------------- */
/*  Shapes                                                                     */
/* -------------------------------------------------------------------------- */

/** One node the company owns or licences, and whether it is doing anything with it. */
export interface HeldNode {
  readonly nodeId: string;
  readonly label: string;
  readonly sector: Sector;
  readonly tier: number;
  /** True when the company runs a live line on it. */
  readonly producing: boolean;
  readonly productId: string | null;
}

/** One sector's worth of held nodes, hardest first. */
export interface HeldGroup {
  readonly sector: Sector;
  readonly nodes: readonly HeldNode[];
}

/** What holding a node would open: something to sell, or something further to reach for. */
export interface ResearchUnlock {
  readonly nodeId: string;
  readonly label: string;
  readonly kind: 'now_producible' | 'next_researchable';
}

/** A programme already under way against this node. */
export interface RunningProgramme {
  readonly projectId: string;
  readonly progress: number;
  readonly quartersLeft: number;
  readonly quarterlyCostUsd: number;
  readonly bottleneck: ResearchBottleneck | null;
}

/** One node the company could open a programme against right now. */
export interface ResearchOption {
  readonly nodeId: string;
  readonly label: string;
  readonly sector: Sector;
  readonly tier: number;
  /** The table's own estimate, low and high. */
  readonly costRangeUsd: readonly [number, number];
  /** The standard preset, as figures: what the drawer would queue. */
  readonly plan: ProgrammePlan;
  readonly expectedQuarters: number;
  readonly totalCostUsd: number;
  readonly quarterlyCostUsd: number;
  readonly bottleneck: ResearchBottleneck | null;
  readonly unlocks: readonly ResearchUnlock[];
  /** The company's own programme against this node, or null. */
  readonly running: RunningProgramme | null;
}

/** One node exactly one requirement away, and the ways in. */
export interface LockedOption {
  readonly nodeId: string;
  readonly label: string;
  readonly sector: Sector;
  /** The single thing standing in the way. */
  readonly missing: MissingNodeRoute;
  readonly buyInstead: NodeEntryRoutes['buyInstead'];
}

/** One company's research position: what it holds, what is open, what is one step away. */
export interface ResearchMapView {
  readonly companyId: string;
  readonly held: readonly HeldGroup[];
  readonly options: readonly ResearchOption[];
  readonly locked: readonly LockedOption[];
}

/* -------------------------------------------------------------------------- */
/*  The view                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * What `company` holds, what it could research now and what is one requirement
 * short.
 *
 * `ownProjects` is the caller's programme list — normally
 * `researchProjectsForCompany`, which also returns other companies' *public*
 * programmes — and is re-filtered here, so a rival's visible programme can
 * never be drawn as mine.
 */
export function researchMapFor(state: SessionState, company: Company, ownProjects: readonly ResearchProject[]): ResearchMapView {
  const quarter = state.quarter;
  const holds = (nodeId: string): boolean => holdsNode(company, nodeId, quarter);

  /* --- what I already have ----------------------------------------------- */
  const linesByNode = new Map<string, string>();
  for (const product of company.products) {
    if (!product.isActive) continue;
    const nodeId = lineNodeIdOf(product);
    if (nodeId !== null && !linesByNode.has(nodeId)) linesByNode.set(nodeId, product.id);
  }

  const heldNodes = ECONOMIC_NODES.filter((node) => holds(node.id));
  const held: HeldGroup[] = [];
  for (const sector of SECTORS) {
    const nodes = heldNodes
      .filter((node) => node.sector === sector)
      .map((node) => ({
        nodeId: node.id,
        label: node.label,
        sector: node.sector,
        tier: node.tier,
        producing: linesByNode.has(node.id),
        productId: linesByNode.get(node.id) ?? null,
      }))
      // Hardest first: the top of a company's chain is what it is known for.
      // Ties keep the table's order, which is stable on every machine.
      .sort((a, b) => b.tier - a.tier);
    if (nodes.length > 0) held.push({ sector, nodes });
  }

  /* --- what is even on the table for me ---------------------------------- */
  // The ownership rule, made visible: my own sector, plus whatever a node I
  // already hold opens up. Buying one robotics node is what puts robotics on
  // an AI laboratory's research screen, and nothing else does.
  const ownSector = sectorOf(company);
  const inScope = new Set<string>();
  for (const node of ECONOMIC_NODES) if (node.sector === ownSector) inScope.add(node.id);
  for (const node of heldNodes) for (const unlocked of unlockedByNode(node.id)) inScope.add(unlocked);

  /* --- what I could start this quarter ------------------------------------ */
  const capacity = researchCapacity(state, company);
  const mine = ownProjects.filter((project) => project.companyId === company.id);

  const options: ResearchOption[] = [];
  for (const node of ECONOMIC_NODES) {
    if (!node.researchable) continue;
    if (holds(node.id)) continue;
    if (!inScope.has(node.id)) continue;
    if (!node.requires.every(holds)) continue;

    const tech = projectNode(node);
    const plan = effortPlan(state, tech, 'standard', capacity);
    const forecast = programmeForecast(state, company, tech, plan);
    const project = mine.find(
      (candidate) => candidate.targetNodeId === node.id && (candidate.status === 'active' || candidate.status === 'paused'),
    );
    const live = project === undefined ? null : runningForecast(state, project, tech);

    options.push({
      nodeId: node.id,
      label: node.label,
      sector: node.sector,
      tier: node.tier,
      costRangeUsd: [node.researchCostRangeUsd[0], node.researchCostRangeUsd[1]],
      plan,
      expectedQuarters: forecast.expectedQuarters,
      totalCostUsd: forecast.totalCostUsd,
      quarterlyCostUsd: forecast.quarterlyCostUsd,
      bottleneck: forecast.bottleneck,
      unlocks: unlocksOf(company, node, quarter, holds),
      running:
        project === undefined || live === null
          ? null
          : {
              projectId: project.id,
              progress: live.progress,
              quartersLeft: live.quartersLeft,
              quarterlyCostUsd: live.quarterlyCostUsd,
              bottleneck: live.bottleneck,
            },
    });
  }
  // A programme already running is the first thing a founder wants to see;
  // after that, cheapest first, ties in the table's own order.
  options.sort((a, b) => Number(b.running !== null) - Number(a.running !== null) || a.totalCostUsd - b.totalCostUsd);

  /* --- what is one step away ---------------------------------------------- */
  const open = new Set(options.map((option) => option.nodeId));
  const locked: LockedOption[] = [];
  for (const node of ECONOMIC_NODES) {
    if (!inScope.has(node.id)) continue;
    if (open.has(node.id)) continue;
    if (canProduce(company, node.id, quarter)) continue;
    const routes = nodeEntryRoutes(state, company, node.id);
    if (routes.missing.length !== 1) continue;
    const missing = routes.missing[0];
    if (missing === undefined) continue;
    locked.push({ nodeId: node.id, label: node.label, sector: node.sector, missing, buyInstead: routes.buyInstead });
  }

  return { companyId: company.id, held, options, locked };
}

/* -------------------------------------------------------------------------- */
/*  What a programme would buy                                                 */
/* -------------------------------------------------------------------------- */

/**
 * What holding `node` would open up, in two kinds.
 *
 * `now_producible` is a line the company could open the quarter the programme
 * lands — the node itself always, and anything it already holds that was
 * waiting on this one. `next_researchable` is the programme after this one.
 * The two are disjoint by construction: a node is on one side or the other of
 * "would I hold it".
 */
function unlocksOf(company: Company, node: EconomicNode, quarter: number, holds: (nodeId: string) => boolean): readonly ResearchUnlock[] {
  const after = (nodeId: string): boolean => nodeId === node.id || holds(nodeId);
  const producible: ResearchUnlock[] = [];
  const researchable: ResearchUnlock[] = [];

  for (const candidate of ECONOMIC_NODES) {
    if (after(candidate.id)) {
      if (!candidate.requires.every(after)) continue;
      if (canProduce(company, candidate.id, quarter)) continue;
      producible.push({ nodeId: candidate.id, label: candidate.label, kind: 'now_producible' });
      continue;
    }
    if (!candidate.researchable) continue;
    if (!candidate.requires.includes(node.id)) continue;
    if (!candidate.requires.every(after)) continue;
    researchable.push({ nodeId: candidate.id, label: candidate.label, kind: 'next_researchable' });
  }
  return [...producible, ...researchable];
}
