/**
 * Research at world version 2's scale.
 *
 * Two defects this file pins shut:
 *
 * 1. A programme's requirement was sized to world 1's frontier labs (60,000
 *    accelerator-equivalents, 120 researchers). A world-2 founder holding a few
 *    hundred units and six researchers sat at the resourcing floors for the
 *    whole game, so nothing on the Frontier Map ever moved.
 * 2. The validator counted only owned and reserved units when a programme
 *    started, while the Frontier Map's form offered cloud capacity too. A
 *    company running on cloud had every programme clamped to zero compute.
 *
 * World 1 is untouched by both fixes; the pinned-hash test elsewhere proves it.
 */

import { describe, expect, it } from 'vitest';
import type { ActionIntent, ResearchProject, SessionState, SubmittedAction, TechNode } from '@frontier/contracts';
import {
  BASE_PROJECT_COMPUTE_UNITS,
  BASE_PROJECT_RESEARCHERS,
  COMPUTE_FLOOR,
  TALENT_FLOOR,
  WORLD2_PROJECT_COMPUTE_UNITS,
  WORLD2_PROJECT_RESEARCHERS,
} from '../src/research/balance';
import { projectRequirements, resourcingFactors } from '../src/research/progress';
import { researchComputeHeadroom } from '../src/validator/context';
import { createActionValidator } from '../src/validator';
import { expectedFill } from '../src/fills';
import { heldComputeUnits } from '../src/companies/products';
import { DEMO_CHARACTERS, DEMO_COMPANIES, DEMO_PLAYER_ID, createDemoSession, createWorld2Session } from '../src/scenario';

const validator = createActionValidator();

function playerCompany(state: SessionState) {
  const company = state.companies.find((entry) => entry.controllerPlayerId !== null);
  if (company === undefined) throw new Error('no player company');
  return company;
}

function playerSeat(state: SessionState) {
  const seat = state.players[0];
  if (seat === undefined) throw new Error('no player seat');
  return seat;
}

function someNode(state: SessionState): TechNode {
  const node = state.techGraph.nodes.find((entry) => entry.status !== 'achieved');
  if (node === undefined) throw new Error('no open node');
  return node;
}

let sequence = 0;
function submit(state: SessionState, intent: ActionIntent, companyId: string, playerId: string | null, characterId: string): SubmittedAction {
  sequence += 1;
  return {
    actionId: `act_scale_${sequence}`,
    sessionId: state.sessionId,
    quarter: state.quarter,
    sequence,
    actorPlayerId: playerId,
    actorCompanyId: companyId,
    actorCharacterId: characterId,
    origin: 'player_ui',
    intent,
    confirmedByHuman: true,
  };
}

function project(companyId: string, node: TechNode, computeAllocated: number, talentAllocated: number): ResearchProject {
  return {
    id: 'rsp_scale',
    companyId,
    targetNodeId: node.id,
    status: 'active',
    budgetQuarterly: (node.researchCostRange[0] + node.researchCostRange[1]) / 2 / 8,
    computeAllocated,
    talentAllocated,
    progress: 0,
    startedQuarter: 0,
    expectedQuarters: 8,
    quartersElapsed: 0,
    setbacks: 0,
    cumulativeSpendUsd: 0,
    isSecret: true,
    internalConfidence: 0.5,
  } as ResearchProject;
}

describe('programme requirements scale with the world', () => {
  it('world 1 keeps the original bases', () => {
    const state = createDemoSession();
    const node = someNode(state);
    const wanted = projectRequirements(state, node);
    expect(wanted.computeUnits).toBe(Math.max(1, Math.round(BASE_PROJECT_COMPUTE_UNITS * Math.max(0.05, node.computeIntensity))));
    expect(wanted.researchers).toBe(Math.max(1, Math.round(BASE_PROJECT_RESEARCHERS * (0.5 + node.computeIntensity))));
  });

  it('world 2 wants figures a small company can actually reach', () => {
    const state = createWorld2Session();
    const node = someNode(state);
    const wanted = projectRequirements(state, node);
    expect(wanted.computeUnits).toBe(Math.max(1, Math.round(WORLD2_PROJECT_COMPUTE_UNITS * Math.max(0.05, node.computeIntensity))));
    expect(wanted.researchers).toBe(Math.max(1, Math.round(WORLD2_PROJECT_RESEARCHERS * (0.5 + node.computeIntensity))));
    expect(wanted.computeUnits).toBeLessThanOrEqual(WORLD2_PROJECT_COMPUTE_UNITS);
    expect(wanted.researchers).toBeLessThanOrEqual(2 * WORLD2_PROJECT_RESEARCHERS);
  });

  it('a world-2 programme resourced to its requirement runs at full speed, not at the floors', () => {
    const state = createWorld2Session();
    const company = playerCompany(state);
    const node = someNode(state);
    const wanted = projectRequirements(state, node);
    const factors = resourcingFactors(state, project(company.id, node, wanted.computeUnits, wanted.researchers), node);
    expect(factors.requiredComputeUnits).toBe(wanted.computeUnits);
    expect(factors.requiredResearchers).toBe(wanted.researchers);
    expect(factors.compute).toBeGreaterThan(COMPUTE_FLOOR + 0.5);
    expect(factors.talent).toBeGreaterThan(TALENT_FLOOR);
  });

  it('the same programme in world 1 would have sat at the compute floor', () => {
    const state = createDemoSession();
    const node = someNode(state);
    const w2 = projectRequirements(createWorld2Session(), node);
    const factors = resourcingFactors(state, project(DEMO_COMPANIES.player, node, w2.computeUnits, w2.researchers), node);
    expect(factors.requiredComputeUnits).toBeGreaterThan(w2.computeUnits * 10);
  });
});

describe('research compute headroom', () => {
  it('world 1 counts owned and reserved units only', () => {
    const state = createDemoSession();
    const company = state.companies.find((entry) => entry.id === DEMO_COMPANIES.player);
    if (company === undefined) throw new Error('no demo player');
    expect(researchComputeHeadroom(state, company)).toBe(company.compute.ownedAccelerators + company.compute.reservedAccelerators);
  });

  it('world 2 counts cloud capacity at the spot index, rounded down', () => {
    const state = createWorld2Session();
    const company = playerCompany(state);
    company.compute.cloudSpendQuarterly = 1_000_000;
    expect(researchComputeHeadroom(state, company)).toBe(Math.floor(heldComputeUnits(state, company)));
    expect(researchComputeHeadroom(state, company)).toBeGreaterThan(company.compute.ownedAccelerators + company.compute.reservedAccelerators);
  });

  it('a cloud-only world-2 company can put its cloud capacity on a programme', () => {
    const state = createWorld2Session();
    const company = playerCompany(state);
    const seat = playerSeat(state);
    company.compute.ownedAccelerators = 0;
    company.compute.reservedAccelerators = 0;
    company.compute.cloudSpendQuarterly = 1_000_000;
    const headroom = researchComputeHeadroom(state, company);
    expect(headroom).toBeGreaterThan(0);

    const node = someNode(state);
    const intent: ActionIntent = {
      type: 'start_research_project',
      targetNodeId: node.id,
      budgetUsd: 100_000,
      computeUnits: headroom,
      researchersAssigned: 1,
      secret: true,
    };
    const [result] = validator.validateBatch(state, [submit(state, intent, company.id, seat.playerId, seat.characterId ?? company.ceoCharacterId ?? '')]);
    if (result === undefined) throw new Error('no result');
    expect(result.status).not.toBe('rejected');
    expect(result.codes).not.toContain('insufficient_compute');
  });

  it('asking for more than the headroom is accepted whole and advises what the first left the second', () => {
    const state = createWorld2Session();
    const company = playerCompany(state);
    const seat = playerSeat(state);
    company.compute.cloudSpendQuarterly = 1_000_000;
    const headroom = researchComputeHeadroom(state, company);
    const [first, second] = state.techGraph.nodes.filter((entry) => entry.status !== 'achieved');
    if (first === undefined || second === undefined) throw new Error('need two open nodes');
    const character = seat.characterId ?? company.ceoCharacterId ?? '';

    const over: ActionIntent = { type: 'start_research_project', targetNodeId: first.id, budgetUsd: 1, computeUnits: headroom + 50, researchersAssigned: 1, secret: true };
    // No researchers asked for: this programme exists only to read the compute
    // the first one left behind.
    const next: ActionIntent = { type: 'start_research_project', targetNodeId: second.id, budgetUsd: 1, computeUnits: 10, researchersAssigned: 0, secret: true };

    // world 2: availability is realised at resolution, not refused or clamped
    // at validation — `expectedFill` is the one place that expectation is
    // computed, and it is what the note on each verdict has to agree with.
    const overFill = expectedFill(state, company.id, over);
    expect(overFill.expected).toBe(headroom);
    expect(overFill.asked).toBe(headroom + 50);

    const [a, b] = validator.validateBatch(state, [
      submit(state, over, company.id, seat.playerId, character),
      submit(state, next, company.id, seat.playerId, character),
    ]);
    if (a === undefined || b === undefined) throw new Error('no results');
    expect(a.status).toBe('accepted');
    expect(a.codes).toContain('partial_fill_expected');
    expect(a.clampedAction).toBeNull();
    // The first programme is expected to take everything, so the second is
    // expected to be short too — noted, not clamped.
    expect(b.status).toBe('accepted');
    expect(b.codes).toContain('partial_fill_expected');
    expect(b.clampedAction).toBeNull();
  });

  it('world 1 still ignores cloud capacity when a programme starts', () => {
    const state = createDemoSession();
    const company = state.companies.find((entry) => entry.id === DEMO_COMPANIES.player);
    if (company === undefined) throw new Error('no demo player');
    company.compute.cloudSpendQuarterly = 50_000_000;
    const held = company.compute.ownedAccelerators + company.compute.reservedAccelerators;
    const node = someNode(state);
    const intent: ActionIntent = { type: 'start_research_project', targetNodeId: node.id, budgetUsd: 1, computeUnits: held + 1, researchersAssigned: 1, secret: true };
    const [result] = validator.validateBatch(state, [submit(state, intent, DEMO_COMPANIES.player, DEMO_PLAYER_ID, DEMO_CHARACTERS.player)]);
    if (result === undefined) throw new Error('no result');
    expect(result.codes).toContain('insufficient_compute');
  });
});
