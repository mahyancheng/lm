/**
 * The research map: what a company holds, what one programme would reach and
 * what is a single requirement away.
 *
 * Every figure on it has to be the research subsystem's own — a forecast that
 * disagrees with the programme it becomes is the thing this module exists to
 * stop — so most of these tests are equalities against a direct call.
 */

import { describe, expect, it } from 'vitest';
import type { Company, ResearchProject } from '@frontier/contracts';
import { ECONOMIC_NODES, ECONOMIC_NODES_BY_ID, SECTORS, canProduce, holdsNode } from '@frontier/contracts';
import { createWorld3Session } from '../src/scenario/index';
import { researchMapFor } from '../src/graph/researchMap';
import { nodeEntryRoutes } from '../src/graph/options';
import { projectNode, unlockedByNode } from '../src/graph/techGraph';
import { effortPlan, programmeForecast, researchCapacity, runningForecast } from '../src/research/forecast';
import { sectorOf } from '../src/economy/sectors';
import { lineNodeIdOf } from '../src/graph/lines';

const PLAYER = 'cmp_player_ventures';

function playerOf(state: ReturnType<typeof createWorld3Session>): Company {
  const company = state.companies.find((candidate) => candidate.id === PLAYER);
  expect(company).toBeDefined();
  return company as Company;
}

/** The company's own sector plus everything a node it holds opens up. */
function scopeOf(state: ReturnType<typeof createWorld3Session>, company: Company): ReadonlySet<string> {
  const scope = new Set<string>();
  for (const node of ECONOMIC_NODES) if (node.sector === sectorOf(company)) scope.add(node.id);
  for (const node of ECONOMIC_NODES) {
    if (!holdsNode(company, node.id, state.quarter)) continue;
    for (const unlocked of unlockedByNode(node.id)) scope.add(unlocked);
  }
  return scope;
}

/** A programme against `nodeId`, as the resolver would have stored it. */
function programme(companyId: string, nodeId: string): ResearchProject {
  return {
    id: 'rsp_test_running',
    companyId,
    targetNodeId: nodeId,
    budgetQuarterly: 4_000_000,
    computeAllocated: 12,
    talentAllocated: 9,
    progress: 0.35,
    internalConfidence: 0.5,
    quartersElapsed: 3,
    expectedQuarters: 8,
    isSecret: false,
    status: 'active',
    cumulativeSpendUsd: 12_000_000,
    setbacks: 1,
    startedQuarter: 0,
  };
}

/* -------------------------------------------------------------------------- */

describe('what I hold', () => {
  it('groups by sector in the table\'s own order, hardest first, and marks the nodes I run a line on', () => {
    const state = createWorld3Session();
    const player = playerOf(state);
    const view = researchMapFor(state, player, state.researchProjects);

    expect(view.companyId).toBe(PLAYER);
    expect(view.held.length).toBeGreaterThan(0);

    // Sectors in SECTORS order, and none of them empty.
    const order = view.held.map((group) => SECTORS.indexOf(group.sector));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    for (const group of view.held) expect(group.nodes.length).toBeGreaterThan(0);

    const liveNodes = new Set(player.products.filter((product) => product.isActive).map((product) => lineNodeIdOf(product)));
    const held = view.held.flatMap((group) => group.nodes);
    for (const node of held) {
      expect(holdsNode(player, node.nodeId, state.quarter)).toBe(true);
      expect(node.sector).toBe(ECONOMIC_NODES_BY_ID[node.nodeId]?.sector);
      expect(node.producing).toBe(liveNodes.has(node.nodeId));
      if (node.producing) expect(node.productId).not.toBeNull();
      else expect(node.productId).toBeNull();
    }
    for (const group of view.held) {
      for (let index = 1; index < group.nodes.length; index += 1) {
        expect(group.nodes[index - 1]?.tier ?? 0).toBeGreaterThanOrEqual(group.nodes[index]?.tier ?? 0);
      }
    }

    // Everything held is in the list exactly once.
    const heldIds = ECONOMIC_NODES.filter((node) => holdsNode(player, node.id, state.quarter)).map((node) => node.id);
    expect(held.map((node) => node.nodeId).sort()).toEqual([...heldIds].sort());
  });
});

/* -------------------------------------------------------------------------- */

describe('what I could start', () => {
  it('offers only researchable nodes I do not hold whose requirements I do, inside my own scope', () => {
    const state = createWorld3Session();
    const player = playerOf(state);
    const scope = scopeOf(state, player);
    const view = researchMapFor(state, player, state.researchProjects);

    expect(view.options.length).toBeGreaterThan(0);
    for (const option of view.options) {
      const node = ECONOMIC_NODES_BY_ID[option.nodeId];
      expect(node).toBeDefined();
      expect(node?.researchable).toBe(true);
      expect(holdsNode(player, option.nodeId, state.quarter)).toBe(false);
      expect((node?.requires ?? []).every((id) => holdsNode(player, id, state.quarter))).toBe(true);
      expect(scope.has(option.nodeId)).toBe(true);
      expect(option.costRangeUsd).toEqual([node?.researchCostRangeUsd[0], node?.researchCostRangeUsd[1]]);
    }

    // Nothing outside the scope, and nothing already held, ever appears.
    const offered = new Set(view.options.map((option) => option.nodeId));
    for (const node of ECONOMIC_NODES) {
      if (offered.has(node.id)) continue;
      const eligible = node.researchable && !holdsNode(player, node.id, state.quarter) && node.requires.every((id) => holdsNode(player, id, state.quarter));
      if (eligible) expect(scope.has(node.id), `${node.id} is eligible and in scope but was not offered`).toBe(false);
    }
  });

  it('quotes the research subsystem\'s own standard-effort forecast, not a second model of it', () => {
    const state = createWorld3Session();
    const player = playerOf(state);
    const view = researchMapFor(state, player, state.researchProjects);
    const capacity = researchCapacity(state, player);

    for (const option of view.options) {
      const node = ECONOMIC_NODES_BY_ID[option.nodeId];
      expect(node).toBeDefined();
      if (node === undefined) continue;
      const tech = projectNode(node);
      const plan = effortPlan(state, tech, 'standard', capacity);
      const forecast = programmeForecast(state, player, tech, plan);
      expect(option.plan).toEqual(plan);
      expect(option.expectedQuarters).toBe(forecast.expectedQuarters);
      expect(option.totalCostUsd).toBe(forecast.totalCostUsd);
      expect(option.quarterlyCostUsd).toBe(forecast.quarterlyCostUsd);
      expect(option.bottleneck).toBe(forecast.bottleneck);
    }

    // Cheapest first, once the running programmes are out of the way.
    const idle = view.options.filter((option) => option.running === null);
    for (let index = 1; index < idle.length; index += 1) {
      expect(idle[index - 1]?.totalCostUsd ?? 0).toBeLessThanOrEqual(idle[index]?.totalCostUsd ?? 0);
    }
  });

  it('puts a programme already running first, with the figures runningForecast gives it', () => {
    const state = createWorld3Session();
    const player = playerOf(state);
    const target = researchMapFor(state, player, state.researchProjects).options[0]?.nodeId;
    expect(target).toBeDefined();

    const project = programme(PLAYER, target ?? '');
    state.researchProjects.push(project);
    const view = researchMapFor(state, player, state.researchProjects);

    expect(view.options[0]?.nodeId).toBe(target);
    const running = view.options[0]?.running;
    expect(running).not.toBeNull();
    const node = ECONOMIC_NODES_BY_ID[target ?? ''];
    expect(node).toBeDefined();
    const forecast = runningForecast(state, project, projectNode(node!));
    expect(running?.projectId).toBe(project.id);
    expect(running?.progress).toBe(forecast.progress);
    expect(running?.quartersLeft).toBe(forecast.quartersLeft);
    expect(running?.quarterlyCostUsd).toBe(forecast.quarterlyCostUsd);
    expect(running?.bottleneck).toBe(forecast.bottleneck);

    // Every other option is idle.
    expect(view.options.slice(1).every((option) => option.running === null)).toBe(true);
  });

  it('never draws another company\'s public programme as mine', () => {
    const state = createWorld3Session();
    const player = playerOf(state);
    const target = researchMapFor(state, player, state.researchProjects).options[0]?.nodeId ?? '';
    // The same node, the same quarter — but a rival's programme.
    const theirs = { ...programme('cmp_aletheia', target), id: 'rsp_rival' };
    const view = researchMapFor(state, player, [...state.researchProjects, theirs]);
    expect(view.options.find((option) => option.nodeId === target)?.running).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */

describe('what a programme would buy', () => {
  it('splits the unlocks into what I could then sell and what I could then research', () => {
    const state = createWorld3Session();
    const player = playerOf(state);
    const view = researchMapFor(state, player, state.researchProjects);

    for (const option of view.options) {
      const after = (id: string): boolean => id === option.nodeId || holdsNode(player, id, state.quarter);
      const producible = option.unlocks.filter((unlock) => unlock.kind === 'now_producible');
      const researchable = option.unlocks.filter((unlock) => unlock.kind === 'next_researchable');

      // The node itself is always something I could then make.
      expect(producible.map((unlock) => unlock.nodeId)).toContain(option.nodeId);
      for (const unlock of producible) {
        const node = ECONOMIC_NODES_BY_ID[unlock.nodeId];
        expect(after(unlock.nodeId)).toBe(true);
        expect((node?.requires ?? []).every(after)).toBe(true);
        expect(canProduce(player, unlock.nodeId, state.quarter)).toBe(false);
        expect(unlock.label).toBe(node?.label);
      }
      for (const unlock of researchable) {
        const node = ECONOMIC_NODES_BY_ID[unlock.nodeId];
        expect(node?.researchable).toBe(true);
        expect(after(unlock.nodeId)).toBe(false);
        expect(node?.requires).toContain(option.nodeId);
        expect((node?.requires ?? []).every(after)).toBe(true);
      }

      // Disjoint, and producible before researchable.
      const ids = option.unlocks.map((unlock) => unlock.nodeId);
      expect(new Set(ids).size).toBe(ids.length);
      expect(option.unlocks.map((unlock) => unlock.kind)).toEqual([
        ...producible.map(() => 'now_producible'),
        ...researchable.map(() => 'next_researchable'),
      ]);
    }
  });
});

/* -------------------------------------------------------------------------- */

describe('what is one step away', () => {
  it('lists nodes with exactly one thing missing, and the ways in', () => {
    const state = createWorld3Session();
    const player = playerOf(state);
    const scope = scopeOf(state, player);
    const view = researchMapFor(state, player, state.researchProjects);
    const offered = new Set(view.options.map((option) => option.nodeId));

    for (const locked of view.locked) {
      expect(scope.has(locked.nodeId)).toBe(true);
      expect(offered.has(locked.nodeId)).toBe(false);
      expect(canProduce(player, locked.nodeId, state.quarter)).toBe(false);
      const routes = nodeEntryRoutes(state, player, locked.nodeId);
      expect(routes.missing.length).toBe(1);
      expect(locked.missing).toEqual(routes.missing[0]);
      expect(locked.buyInstead).toEqual(routes.buyInstead);
      expect(locked.sector).toBe(ECONOMIC_NODES_BY_ID[locked.nodeId]?.sector);
    }

    // Nothing in scope that is one step away is left out.
    const listed = new Set(view.locked.map((entry) => entry.nodeId));
    for (const node of ECONOMIC_NODES) {
      if (!scope.has(node.id) || offered.has(node.id) || listed.has(node.id)) continue;
      if (canProduce(player, node.id, state.quarter)) continue;
      expect(nodeEntryRoutes(state, player, node.id).missing.length).not.toBe(1);
    }
  });
});

/* -------------------------------------------------------------------------- */

describe('determinism', () => {
  it('returns the same map twice', () => {
    const state = createWorld3Session();
    const player = playerOf(state);
    expect(JSON.stringify(researchMapFor(state, player, state.researchProjects))).toBe(
      JSON.stringify(researchMapFor(state, player, state.researchProjects)),
    );
  });
});
