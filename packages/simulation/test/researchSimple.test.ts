/**
 * Research, made answerable.
 *
 * The Frontier Map used to ask for three sliders against three hidden adequacy
 * factors and an unseen setback probability, and answered none of the four
 * questions a founder actually has: what does this get me, what does it take,
 * how long, and why is it slow. This file pins the engine half of the answer.
 *
 * - The **effort presets** are a deterministic map from a node and the company's
 *   free capacity to a `start_research_project` intent, and the Standard preset
 *   is built from the validator's own bounds — so it is never clamped.
 * - **`programmeForecast` is the engine's own arithmetic**, not a second model
 *   of it: its factors are `resourcingFactors` and its risk is
 *   `setbackProbability`, called on the figures the intent carries.
 * - **The schedule has one definition.** `plannedProgrammeQuarters` is what the
 *   forecast promises and what `ensureResearchProjects` opens the programme on.
 * - **`adjust_research_project`** lets a founder answer "short of compute: 300
 *   of 600 units", which was previously an observation with no instruction
 *   behind it. Its bounds hand the programme's own allocation back first.
 */

import { describe, expect, it } from 'vitest';
import type { ActionIntent, Company, ResearchProject, SessionState, SubmittedAction, TechNode } from '@frontier/contracts';
import { hashState } from '@frontier/shared';
import {
  EFFORT_MULTIPLE,
  RESEARCH_EFFORTS,
  STANDARD_PROGRAMME_QUARTERS,
  bottleneckOf,
  effortIntent,
  effortPlan,
  plannedProgrammeQuarters,
  programmeForecast,
  publicVerdict,
  repairPlan,
  researchCapacity,
  rivalProgress,
  runningForecast,
  setbackRiskBand,
} from '../src/research/forecast';
import { projectRequirements, resourcingFactors, setbackProbability } from '../src/research/progress';
import { createActionValidator } from '../src/validator';
import { createDefaultEngine } from '../src/engine';
import { createWorld2Session } from '../src/scenario';

const validator = createActionValidator();

function playerCompany(state: SessionState): Company {
  const company = state.companies.find((entry) => entry.controllerPlayerId !== null);
  if (company === undefined) throw new Error('no player company');
  return company;
}

function seatOf(state: SessionState): { playerId: string | null; characterId: string } {
  const seat = state.players[0];
  if (seat === undefined) throw new Error('no player seat');
  return { playerId: seat.playerId, characterId: seat.characterId ?? '' };
}

/** An open node whose requirement a well-funded world-2 player could actually meet. */
function openNode(state: SessionState, index = 0): TechNode {
  const nodes = state.techGraph.nodes.filter((entry) => entry.status !== 'achieved' && entry.achievedByCompanyId === null);
  const node = nodes[index];
  if (node === undefined) throw new Error('no open node');
  return node;
}

let sequence = 0;
function submit(state: SessionState, intent: ActionIntent, company: Company): SubmittedAction {
  const seat = seatOf(state);
  sequence += 1;
  return {
    actionId: `act_simple_${sequence}`,
    sessionId: state.sessionId,
    quarter: state.quarter,
    sequence,
    actorPlayerId: seat.playerId,
    actorCompanyId: company.id,
    actorCharacterId: seat.characterId === '' ? (company.ceoCharacterId ?? '') : seat.characterId,
    origin: 'player_ui',
    intent,
    confirmedByHuman: true,
  };
}

/** A world-2 session with the player given the compute and people a programme wants. */
function staged(): { state: SessionState; company: Company } {
  const state = createWorld2Session();
  const company = playerCompany(state);
  company.compute.ownedAccelerators = 4_000;
  company.employees.researchers = 40;
  company.financials.cash = 500_000_000;
  return { state, company };
}

/* -------------------------------------------------------------------------- */
/*  Effort presets                                                             */
/* -------------------------------------------------------------------------- */

describe('effort presets', () => {
  it('map deterministically: the same world and node give the same three plans', () => {
    const { state, company } = staged();
    const node = openNode(state);
    const capacity = researchCapacity(state, company);
    for (const effort of RESEARCH_EFFORTS) {
      expect(effortPlan(state, node, effort, capacity)).toEqual(effortPlan(state, node, effort, capacity));
    }
  });

  it('Standard asks for exactly what the node wants, Light for half and All-in for one and a half', () => {
    const { state, company } = staged();
    const node = openNode(state);
    const capacity = researchCapacity(state, company);
    const requirement = projectRequirements(state, node);
    // Capacity is deliberately staged above the requirement, so nothing is capped.
    expect(capacity.computeUnits).toBeGreaterThanOrEqual(Math.round(requirement.computeUnits * EFFORT_MULTIPLE.all_in));
    expect(capacity.researchers).toBeGreaterThanOrEqual(Math.round(requirement.researchers * EFFORT_MULTIPLE.all_in));

    const standard = effortPlan(state, node, 'standard', capacity);
    expect(standard.computeUnits).toBe(requirement.computeUnits);
    expect(standard.researchersAssigned).toBe(requirement.researchers);

    const light = effortPlan(state, node, 'light', capacity);
    expect(light.computeUnits).toBe(Math.round(requirement.computeUnits * 0.5));
    expect(light.researchersAssigned).toBe(Math.round(requirement.researchers * 0.5));

    const allIn = effortPlan(state, node, 'all_in', capacity);
    expect(allIn.computeUnits).toBe(Math.round(requirement.computeUnits * 1.5));
    expect(allIn.researchersAssigned).toBe(Math.round(requirement.researchers * 1.5));
  });

  it('the Standard budget is the cost midpoint over the standard schedule, and opens on that schedule', () => {
    const { state, company } = staged();
    const node = openNode(state);
    const standard = effortPlan(state, node, 'standard', researchCapacity(state, company));
    const [low, high] = node.researchCostRange;
    expect(standard.budgetUsd).toBe(Math.max(1, Math.round((low + high) / 2 / STANDARD_PROGRAMME_QUARTERS)));
    expect(plannedProgrammeQuarters(node, standard.budgetUsd)).toBe(STANDARD_PROGRAMME_QUARTERS);
  });

  it('never asks for more compute or more people than are free', () => {
    const { state, company } = staged();
    company.compute.ownedAccelerators = 30;
    company.compute.reservedAccelerators = 0;
    company.compute.cloudSpendQuarterly = 0;
    company.employees.researchers = 2;
    const node = openNode(state);
    const capacity = researchCapacity(state, company);
    for (const effort of RESEARCH_EFFORTS) {
      const plan = effortPlan(state, node, effort, capacity);
      expect(plan.computeUnits).toBeLessThanOrEqual(capacity.computeUnits);
      expect(plan.researchersAssigned).toBeLessThanOrEqual(capacity.researchers);
    }
  });

  it('the Standard preset passes validation unclamped on a world-2 fixture', () => {
    const { state, company } = staged();
    for (let index = 0; index < 4; index += 1) {
      const node = openNode(state, index);
      const intent = effortIntent(state, node, 'standard', researchCapacity(state, company), true);
      const [result] = validator.validateBatch(state, [submit(state, intent as ActionIntent, company)]);
      if (result === undefined) throw new Error('no result');
      expect(`${node.id}: ${result.status}`).toBe(`${node.id}: accepted`);
      expect(result.codes).not.toContain('insufficient_compute');
      expect(result.codes).not.toContain('insufficient_headcount');
    }
  });

  it('a Standard preset built against a starved company is still unclamped: it asks only for what is left', () => {
    const { state, company } = staged();
    company.compute.ownedAccelerators = 12;
    company.compute.reservedAccelerators = 0;
    company.compute.cloudSpendQuarterly = 0;
    company.employees.researchers = 1;
    const node = openNode(state);
    const intent = effortIntent(state, node, 'standard', researchCapacity(state, company), true);
    const [result] = validator.validateBatch(state, [submit(state, intent as ActionIntent, company)]);
    if (result === undefined) throw new Error('no result');
    expect(result.codes).not.toContain('insufficient_compute');
    expect(result.codes).not.toContain('insufficient_headcount');
  });
});

/* -------------------------------------------------------------------------- */
/*  The forecast                                                               */
/* -------------------------------------------------------------------------- */

describe('programmeForecast', () => {
  it('reports exactly the engine\'s own factors and setback probability', () => {
    const { state, company } = staged();
    const node = openNode(state);
    const plan = effortPlan(state, node, 'standard', researchCapacity(state, company));
    const forecast = programmeForecast(state, company, node, plan);

    const probe: ResearchProject = {
      id: 'rsp_probe',
      companyId: company.id,
      targetNodeId: node.id,
      budgetQuarterly: plan.budgetUsd,
      computeAllocated: plan.computeUnits,
      talentAllocated: plan.researchersAssigned,
      progress: 0,
      internalConfidence: 0.5,
      quartersElapsed: 0,
      expectedQuarters: plannedProgrammeQuarters(node, plan.budgetUsd),
      isSecret: true,
      status: 'active',
      cumulativeSpendUsd: 0,
      setbacks: 0,
      startedQuarter: 0,
    };
    const factors = resourcingFactors(state, probe, node);
    expect(forecast.factors.funding).toBe(factors.funding);
    expect(forecast.factors.compute).toBe(factors.compute);
    expect(forecast.factors.talent).toBe(factors.talent);
    expect(forecast.setbackRisk).toBe(setbackProbability(node, factors));
    expect(forecast.plannedQuarters).toBe(probe.expectedQuarters);
  });

  it('quotes whole quarters and a total that is the quarterly cost times them', () => {
    const { state, company } = staged();
    const node = openNode(state);
    const plan = effortPlan(state, node, 'standard', researchCapacity(state, company));
    const forecast = programmeForecast(state, company, node, plan);
    expect(Number.isInteger(forecast.expectedQuarters)).toBe(true);
    expect(forecast.expectedQuarters).toBeGreaterThan(0);
    expect(forecast.totalCostUsd).toBe(forecast.quarterlyCostUsd * forecast.expectedQuarters);
  });

  it('Light takes longer than All-in against the same node', () => {
    const { state, company } = staged();
    const node = openNode(state);
    const capacity = researchCapacity(state, company);
    const light = programmeForecast(state, company, node, effortPlan(state, node, 'light', capacity));
    const allIn = programmeForecast(state, company, node, effortPlan(state, node, 'all_in', capacity));
    expect(light.expectedQuarters).toBeGreaterThan(allIn.expectedQuarters);
  });

  it('a fully resourced Standard programme has no bottleneck', () => {
    const { state, company } = staged();
    // Capability coverage is part of the talent factor, so a company with no
    // strength in the node's areas is short of talent however many people it
    // assigns. Cover the areas the node names to isolate the resourcing.
    const node = openNode(state);
    for (const area of node.talentRequirements) company.techCapabilities[area] = 1;
    const forecast = programmeForecast(state, company, node, effortPlan(state, node, 'standard', researchCapacity(state, company)));
    expect(forecast.bottleneck).toBeNull();
    expect(forecast.shortfall).toBeNull();
  });

  it('names compute when compute is what is missing, and says how far short it is', () => {
    const { state, company } = staged();
    const node = openNode(state);
    for (const area of node.talentRequirements) company.techCapabilities[area] = 1;
    const standard = effortPlan(state, node, 'standard', researchCapacity(state, company));
    const starved = { ...standard, computeUnits: Math.max(0, Math.floor(standard.computeUnits / 4)) };
    const forecast = programmeForecast(state, company, node, starved);
    expect(forecast.bottleneck).toBe('compute');
    expect(forecast.shortfall?.kind).toBe('compute');
    expect(forecast.shortfall?.have).toBe(starved.computeUnits);
    expect(forecast.shortfall?.want).toBe(projectRequirements(state, node).computeUnits);
    expect(forecast.expectedQuarters).toBeGreaterThan(programmeForecast(state, company, node, standard).expectedQuarters);
  });

  it('names researchers when the headcount is short, and flags a capability gap when it is not', () => {
    const { state, company } = staged();
    const node = openNode(state);
    if (node.talentRequirements.length === 0) return;
    for (const area of node.talentRequirements) company.techCapabilities[area] = 1;
    const standard = effortPlan(state, node, 'standard', researchCapacity(state, company));

    const shortHanded = programmeForecast(state, company, node, { ...standard, researchersAssigned: 1 });
    expect(shortHanded.bottleneck).toBe('talent');
    expect(shortHanded.shortfall?.capabilityGap).toBe(false);
    expect(shortHanded.shortfall?.have).toBe(1);

    for (const area of node.talentRequirements) company.techCapabilities[area] = 0.1;
    const uncovered = programmeForecast(state, company, node, standard);
    expect(uncovered.bottleneck).toBe('talent');
    expect(uncovered.shortfall?.capabilityGap).toBe(true);
  });

  it('bottleneckOf takes the lowest factor and nothing when all three are met', () => {
    expect(bottleneckOf({ funding: 1, compute: 1, talent: 1 })).toBeNull();
    expect(bottleneckOf({ funding: 1.12, compute: 1, talent: 1 })).toBeNull();
    expect(bottleneckOf({ funding: 0.9, compute: 0.4, talent: 0.8 })).toBe('compute');
    expect(bottleneckOf({ funding: 0.3, compute: 0.4, talent: 0.8 })).toBe('funding');
    expect(bottleneckOf({ funding: 1, compute: 1, talent: 0.64 })).toBe('talent');
  });

  it('bands a setback probability into three plain words', () => {
    expect(setbackRiskBand(0.09)).toBe('low');
    expect(setbackRiskBand(0.2)).toBe('medium');
    expect(setbackRiskBand(0.44)).toBe('high');
  });

  it('says what the world thinks in three words rather than a number', () => {
    expect(publicVerdict(0.82)).toBe('likely');
    expect(publicVerdict(0.42)).toBe('unclear');
    expect(publicVerdict(0.1)).toBe('doubtful');
  });
});

/* -------------------------------------------------------------------------- */
/*  The schedule has one definition                                            */
/* -------------------------------------------------------------------------- */

describe('the forecast and the programme agree', () => {
  it('a programme opens on exactly the quarters the forecast promised', () => {
    const { state, company } = staged();
    const engine = createDefaultEngine();
    const node = openNode(state);
    const plan = effortPlan(state, node, 'standard', researchCapacity(state, company));
    const forecast = programmeForecast(state, company, node, plan);
    const intent = effortIntent(state, node, 'standard', researchCapacity(state, company), true);

    const outcome = engine.resolver.resolveQuarter(state, [submit(state, intent as ActionIntent, company)], null, []);
    expect(outcome.committed).toBe(true);
    const opened = outcome.nextState.researchProjects.find(
      (project) => project.companyId === company.id && project.targetNodeId === node.id,
    );
    if (opened === undefined) throw new Error('the programme did not open');
    // One quarter has already run by the time the outcome is read, so the
    // schedule is compared before any setback could have slipped it.
    expect(opened.expectedQuarters - opened.setbacks).toBe(forecast.plannedQuarters);
    expect(opened.budgetQuarterly).toBe(plan.budgetUsd);
    expect(opened.computeAllocated).toBe(plan.computeUnits);
    expect(opened.talentAllocated).toBe(plan.researchersAssigned);
  });
});

/* -------------------------------------------------------------------------- */
/*  A running programme                                                        */
/* -------------------------------------------------------------------------- */

describe('runningForecast', () => {
  it('reads progress, quarters left and the shortfall off the programme as it stands', () => {
    const { state, company } = staged();
    const node = openNode(state);
    for (const area of node.talentRequirements) company.techCapabilities[area] = 1;
    const requirement = projectRequirements(state, node);
    const project: ResearchProject = {
      id: 'rsp_running',
      companyId: company.id,
      targetNodeId: node.id,
      budgetQuarterly: Math.round((node.researchCostRange[0] + node.researchCostRange[1]) / 2 / 8),
      computeAllocated: Math.floor(requirement.computeUnits / 2),
      talentAllocated: requirement.researchers,
      progress: 0.4,
      internalConfidence: 0.5,
      quartersElapsed: 3,
      expectedQuarters: 8,
      isSecret: false,
      status: 'active',
      cumulativeSpendUsd: 12_000_000,
      setbacks: 0,
      startedQuarter: 0,
    };
    state.researchProjects.push(project);

    const reading = runningForecast(state, project, node);
    expect(reading.progress).toBe(0.4);
    expect(reading.spentUsd).toBe(12_000_000);
    expect(Number.isInteger(reading.quartersLeft)).toBe(true);
    expect(reading.quartersLeft).toBeGreaterThan(0);
    expect(reading.bottleneck).toBe('compute');
    expect(reading.shortfall?.have).toBe(project.computeAllocated);
    expect(reading.shortfall?.want).toBe(requirement.computeUnits);
  });

  it('a finished programme has nothing left to run', () => {
    const { state, company } = staged();
    const node = openNode(state);
    const project: ResearchProject = {
      id: 'rsp_done',
      companyId: company.id,
      targetNodeId: node.id,
      budgetQuarterly: 1_000_000,
      computeAllocated: 100,
      talentAllocated: 4,
      progress: 1,
      internalConfidence: 1,
      quartersElapsed: 8,
      expectedQuarters: 8,
      isSecret: false,
      status: 'active',
      cumulativeSpendUsd: 8_000_000,
      setbacks: 0,
      startedQuarter: 0,
    };
    state.researchProjects.push(project);
    expect(runningForecast(state, project, node).quartersLeft).toBe(0);
  });

  it('rivalProgress shows published programmes and never a secret one', () => {
    const { state, company } = staged();
    const node = openNode(state);
    const rival = state.companies.find((entry) => entry.id !== company.id);
    if (rival === undefined) throw new Error('no rival');
    state.researchProjects.push(
      {
        id: 'rsp_rival_open',
        companyId: rival.id,
        targetNodeId: node.id,
        budgetQuarterly: 1,
        computeAllocated: 1,
        talentAllocated: 1,
        progress: 0.5,
        internalConfidence: 0.5,
        quartersElapsed: 1,
        expectedQuarters: 8,
        isSecret: false,
        status: 'active',
        cumulativeSpendUsd: 0,
        setbacks: 0,
        startedQuarter: 0,
      },
      {
        id: 'rsp_rival_secret',
        companyId: rival.id,
        targetNodeId: node.id,
        budgetQuarterly: 1,
        computeAllocated: 1,
        talentAllocated: 1,
        progress: 0.9,
        internalConfidence: 0.9,
        quartersElapsed: 1,
        expectedQuarters: 8,
        isSecret: true,
        status: 'active',
        cumulativeSpendUsd: 0,
        setbacks: 0,
        startedQuarter: 0,
      },
    );
    const seen = rivalProgress(state, node.id, company.id);
    expect(seen.map((entry) => entry.progress)).toEqual([0.5]);
  });
});

/* -------------------------------------------------------------------------- */
/*  adjust_research_project                                                    */
/* -------------------------------------------------------------------------- */

function runningProject(state: SessionState, company: Company, node: TechNode, compute: number, researchers: number): ResearchProject {
  const project: ResearchProject = {
    id: 'rsp_adjust',
    companyId: company.id,
    targetNodeId: node.id,
    budgetQuarterly: 2_000_000,
    computeAllocated: compute,
    talentAllocated: researchers,
    progress: 0.3,
    internalConfidence: 0.5,
    quartersElapsed: 2,
    expectedQuarters: 8,
    isSecret: false,
    status: 'active',
    cumulativeSpendUsd: 5_000_000,
    setbacks: 0,
    startedQuarter: 0,
  };
  state.researchProjects.push(project);
  return project;
}

describe('adjust_research_project', () => {
  it('hands the programme its own allocation back before counting what is free', () => {
    const { state, company } = staged();
    const node = openNode(state);
    company.employees.researchers = 10;
    company.compute.ownedAccelerators = 1_000;
    company.compute.reservedAccelerators = 0;
    company.compute.cloudSpendQuarterly = 0;
    const project = runningProject(state, company, node, 1_000, 10);
    // Every researcher and every accelerator is on this programme, so without
    // the hand-back nothing could be moved at all.
    const intent: ActionIntent = {
      type: 'adjust_research_project',
      projectId: project.id,
      budgetUsd: project.budgetQuarterly,
      computeUnits: 1_000,
      researchersAssigned: 10,
    };
    const [result] = validator.validateBatch(state, [submit(state, intent, company)]);
    if (result === undefined) throw new Error('no result');
    expect(result.status).toBe('accepted');
    expect(result.codes).not.toContain('insufficient_headcount');
    expect(result.codes).not.toContain('insufficient_compute');
  });

  it('clamps to what genuinely exists', () => {
    const { state, company } = staged();
    const node = openNode(state);
    company.employees.researchers = 10;
    company.compute.ownedAccelerators = 1_000;
    company.compute.reservedAccelerators = 0;
    company.compute.cloudSpendQuarterly = 0;
    const project = runningProject(state, company, node, 400, 4);
    const intent: ActionIntent = {
      type: 'adjust_research_project',
      projectId: project.id,
      budgetUsd: project.budgetQuarterly,
      computeUnits: 5_000,
      researchersAssigned: 40,
    };
    const [result] = validator.validateBatch(state, [submit(state, intent, company)]);
    if (result === undefined) throw new Error('no result');
    expect(result.status).toBe('clamped');
    expect(result.codes).toContain('insufficient_headcount');
    expect(result.codes).toContain('insufficient_compute');
    const clamped = result.clampedAction;
    if (clamped?.type !== 'adjust_research_project') throw new Error('no clamped action');
    expect(clamped.researchersAssigned).toBe(10);
    expect(clamped.computeUnits).toBe(1_000);
  });

  it('refuses another company\'s programme and a programme that is over', () => {
    const { state, company } = staged();
    const node = openNode(state);
    const rival = state.companies.find((entry) => entry.id !== company.id);
    if (rival === undefined) throw new Error('no rival');
    const project = runningProject(state, company, node, 100, 2);
    project.companyId = rival.id;
    const stolen: ActionIntent = { type: 'adjust_research_project', projectId: project.id, budgetUsd: 1, computeUnits: 1, researchersAssigned: 1 };
    const [a] = validator.validateBatch(state, [submit(state, stolen, company)]);
    expect(a?.status).toBe('rejected');
    expect(a?.codes).toContain('not_controller_of_company');

    project.companyId = company.id;
    project.status = 'succeeded';
    const [b] = validator.validateBatch(state, [submit(state, stolen, company)]);
    expect(b?.status).toBe('rejected');
    expect(b?.codes).toContain('requirement_not_met');

    const missing: ActionIntent = { type: 'adjust_research_project', projectId: 'rsp_nothing', budgetUsd: 1, computeUnits: 1, researchersAssigned: 1 };
    const [c] = validator.validateBatch(state, [submit(state, missing, company)]);
    expect(c?.status).toBe('rejected');
    expect(c?.codes).toContain('unknown_target');
  });

  it('the resolver applies it before the quarter advances, and writes a ledger row', () => {
    const { state, company } = staged();
    const engine = createDefaultEngine();
    const node = openNode(state);
    company.employees.researchers = 20;
    company.compute.ownedAccelerators = 2_000;
    company.compute.reservedAccelerators = 0;
    company.compute.cloudSpendQuarterly = 0;
    const project = runningProject(state, company, node, 100, 2);

    const intent: ActionIntent = {
      type: 'adjust_research_project',
      projectId: project.id,
      budgetUsd: 3_000_000,
      computeUnits: 900,
      researchersAssigned: 9,
    };
    const outcome = engine.resolver.resolveQuarter(state, [submit(state, intent, company)], null, []);
    expect(outcome.committed).toBe(true);
    const after = outcome.nextState.researchProjects.find((entry) => entry.id === project.id);
    if (after === undefined) throw new Error('the programme vanished');
    expect(after.computeAllocated).toBe(900);
    expect(after.talentAllocated).toBe(9);
    expect(after.budgetQuarterly).toBe(3_000_000);
    expect(
      outcome.events.some((event) => event.type === 'research_progress' && event.payload['reallocated'] === true),
    ).toBe(true);
  });

  it('the quarter it lands in runs on the new resourcing, so the fix shows immediately', () => {
    const engine = createDefaultEngine();

    function resolveWith(adjust: boolean): number {
      const { state, company } = staged();
      const node = openNode(state);
      for (const area of node.talentRequirements) company.techCapabilities[area] = 1;
      company.employees.researchers = 20;
      company.compute.ownedAccelerators = 4_000;
      company.compute.reservedAccelerators = 0;
      company.compute.cloudSpendQuarterly = 0;
      const requirement = projectRequirements(state, node);
      const project = runningProject(state, company, node, 20, 1);
      const actions = adjust
        ? [
            submit(
              state,
              {
                type: 'adjust_research_project',
                projectId: project.id,
                budgetUsd: project.budgetQuarterly,
                computeUnits: requirement.computeUnits,
                researchersAssigned: requirement.researchers,
              },
              company,
            ),
          ]
        : [];
      const outcome = engine.resolver.resolveQuarter(state, actions, null, []);
      return outcome.nextState.researchProjects.find((entry) => entry.id === project.id)?.progress ?? 0;
    }

    expect(resolveWith(true)).toBeGreaterThan(resolveWith(false));
  });

  it('is deterministic: the same adjustment on the same seed gives the same world', () => {
    const engine = createDefaultEngine();

    function run(): string {
      const { state, company } = staged();
      const node = openNode(state);
      const project = runningProject(state, company, node, 50, 2);
      const intent: ActionIntent = {
        type: 'adjust_research_project',
        projectId: project.id,
        budgetUsd: 2_500_000,
        computeUnits: 600,
        researchersAssigned: 8,
      };
      // The action id is part of the ordering, so it is fixed across runs.
      const action = { ...submit(state, intent, company), actionId: 'act_fixed', sequence: 1 };
      return hashState(engine.resolver.resolveQuarter(state, [action], null, []).nextState);
    }

    expect(run()).toBe(run());
  });

  it('repairPlan asks for the node\'s requirement and never cuts the budget', () => {
    const { state, company } = staged();
    const node = openNode(state);
    company.employees.researchers = 20;
    company.compute.ownedAccelerators = 4_000;
    company.compute.reservedAccelerators = 0;
    company.compute.cloudSpendQuarterly = 0;
    const project = runningProject(state, company, node, 20, 1);
    project.budgetQuarterly = 99_000_000;
    const requirement = projectRequirements(state, node);
    const repair = repairPlan(state, company, project, node);
    expect(repair.computeUnits).toBe(requirement.computeUnits);
    expect(repair.researchersAssigned).toBe(requirement.researchers);
    expect(repair.budgetUsd).toBe(99_000_000);

    const intent: ActionIntent = {
      type: 'adjust_research_project',
      projectId: project.id,
      budgetUsd: repair.budgetUsd,
      computeUnits: repair.computeUnits,
      researchersAssigned: repair.researchersAssigned,
    };
    const [result] = validator.validateBatch(state, [submit(state, intent, company)]);
    expect(result?.codes).not.toContain('insufficient_compute');
    expect(result?.codes).not.toContain('insufficient_headcount');
  });
});
