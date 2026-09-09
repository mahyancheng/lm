import { describe, expect, it } from 'vitest';
import type { ActionIntent, Company, ExperimentReview, InnovationProposal, SessionState, SubmittedAction } from '@frontier/contracts';
import { InnovationProposalSchema, SessionStateSchema } from '@frontier/contracts';
import { hashState } from '@frontier/shared';
import { createDefaultEngine } from '../src/engine';
import { createWorld3Session } from '../src/scenario/world3';
import { servingComputeUnits } from '../src/companies/products';
import { experimentResources, experimentReviewError } from '../src/research/experiments';
import { publicResearchProjects, researchProjectsForCompany, techGraphForCompany } from '../src/research/projection';

const engine = createDefaultEngine();
function fixture() {
  const state = createWorld3Session();
  const company = state.companies.find((entry) => entry.id === state.players[0]?.companyId)!;
  company.compute.ownedAccelerators = 1000;
  company.compute.reservedAccelerators = 0;
  company.compute.cloudSpendQuarterly = 0;
  company.employees.researchers = 20;
  company.products = [];
  state.researchProjects = state.researchProjects.filter((entry) => entry.companyId !== company.id);
  state.config.allowPlayerInnovation = true;
  return { state, company };
}
function action(state: SessionState, intent: ActionIntent, company?: Company, sequence = 1): SubmittedAction {
  const seat = state.players[0]!;
  return { actionId: `act_experiment_${state.quarter}_${sequence}`, sessionId: state.sessionId, quarter: state.quarter, sequence,
    actorPlayerId: seat.playerId, actorCompanyId: company?.id ?? seat.companyId!, actorCharacterId: seat.characterId ?? '', origin: 'player_ui', intent, confirmedByHuman: true };
}
function proposal(overrides: Partial<InnovationProposal> = {}): InnovationProposal {
  return { nodeType: 'player_hypothesis', title: 'Black-box agent evolution', summary: 'Investigate whether evolving populations of agents find useful new behaviours.', novelty: 0.8, plausibility: 0.5,
    requiredCapabilities: ['agents'], estimatedCost: 10000, estimatedQuarters: 1, dependencies: [], initialVisibility: 'company_private', rationale: 'Use spare compute for a bounded experiment without assuming a breakthrough.',
    experiment: { question: 'Can evolving black-box agents discover useful new behaviours?', method: 'Evolve candidate agents and evaluate generalisation against independent held-out tasks.', budgetUsd: 10000, computeUnits: 100, researchersAssigned: 2, reviewAfterQuarters: 1 }, ...overrides };
}
function resolve(state: SessionState, intents: ActionIntent[]) {
  const actions = intents.map((intent, index) => action(state, intent, undefined, index + 1));
  const outcome = engine.resolver.resolveQuarter(state, actions, null, []);
  expect(outcome.invariants.filter((entry) => !entry.passed)).toEqual([]);
  expect(outcome.committed).toBe(true);
  return outcome;
}
function started() {
  const { state, company } = fixture();
  const outcome = resolve(state, [{ type: 'propose_innovation', proposal: proposal() }]);
  const project = outcome.nextState.researchProjects.find((entry) => entry.companyId === company.id && entry.experiment)!;
  expect(project).toBeDefined();
  return { state: outcome.nextState, companyId: company.id, project, outcome };
}
function reviewFor(project: ReturnType<typeof started>['project']): ExperimentReview {
  return { projectId: project.id, round: project.experiment!.round, elapsedQuarters: project.quartersElapsed, outcome: 'unexpected',
    observation: 'The population discovered a compact task-routing method, but its advantage has only been observed on the first evaluation set.',
    interpretation: 'Investigate generalisation before treating this as a reusable capability.', nextDirections: ['Evaluate the routing method on an independently generated task set.'], capabilityGains: [{ area: 'agents', gain: 0.03 }, { area: 'agents', gain: 0.03 }] };
}
function reviewProposal(review: ExperimentReview): InnovationProposal { const p = proposal(); delete p.experiment; return { ...p, experimentReview: review }; }

describe('open-ended research', () => {
  it('opens an unknown investigation, pays for work, pauses and releases resources without granting a technology', () => {
    const { state, project, companyId, outcome } = started();
    expect(project).toMatchObject({ status: 'paused', progress: 0, cumulativeSpendUsd: 10000, quartersElapsed: 1, budgetQuarterly: 0, computeAllocated: 0, talentAllocated: 0 });
    expect(project.experiment).toMatchObject({ round: 1, roundQuarters: 1, awaitingReview: true, cashSpentLastRun: 10000, computeUsed: 100, researcherQuarters: 2, findings: [] });
    expect(state.companies.find((entry) => entry.id === companyId)!.ownedNodes).not.toContain(project.targetNodeId);
    expect(outcome.events.some((event) => event.payload.kind === 'experiment_work' && event.payload.cashSpentUsd === 10000)).toBe(true);
    expect(outcome.events.some((event) => event.type === 'node_owned' && event.targetId === project.targetNodeId)).toBe(false);
    const parsed = SessionStateSchema.parse(JSON.parse(JSON.stringify(state)));
    expect(parsed.researchProjects.find((entry) => entry.id === project.id)?.experiment).toEqual(project.experiment);
  });

  it('books the experimental cash in financials even though the completed round is paused', () => {
    const { state } = fixture();
    const baseline = resolve(state, [{ type: 'set_research_budget', budgetUsd: 0 }]);
    const p = proposal(); p.experiment!.budgetUsd = 1000000;
    const experiment = resolve(state, [{ type: 'set_research_budget', budgetUsd: 0 }, { type: 'propose_innovation', proposal: p }]);
    const companyId = state.players[0]!.companyId;
    const get = (s: SessionState) => s.companies.find((entry) => entry.id === companyId)!.financials;
    expect(get(experiment.nextState).rdSpend).toBeGreaterThan(get(baseline.nextState).rdSpend);
    expect(get(experiment.nextState).cash).toBeLessThan(get(baseline.nextState).cash);
  });

  it('waits offline without extra work or expense, and keeps the investigation private', () => {
    const { state, project, companyId } = started();
    const waited = resolve(state, []).nextState;
    const saved = waited.researchProjects.find((entry) => entry.id === project.id)!;
    expect(saved.cumulativeSpendUsd).toBe(project.cumulativeSpendUsd);
    expect(saved.experiment).toEqual(project.experiment);
    expect(publicResearchProjects(waited).some((entry) => entry.id === project.id)).toBe(false);
    const rival = waited.companies.find((entry) => entry.id !== companyId)!;
    saved.isSecret = false;
    expect(publicResearchProjects(waited).find((entry) => entry.id === project.id)?.experiment).toBeUndefined();
    expect(researchProjectsForCompany(waited, rival.id).find((entry) => entry.id === project.id)?.experiment).toBeUndefined();
    expect(researchProjectsForCompany(waited, companyId).find((entry) => entry.id === project.id)?.experiment).toBeDefined();
    expect(techGraphForCompany(waited.techGraph, rival.id).nodes.some((entry) => entry.id === project.targetNodeId)).toBe(false);
  });

  it('records bounded findings exactly once, persists them, and continues in a new direction', () => {
    const { state, project, companyId } = started();
    const reviewed = resolve(state, [{ type: 'propose_innovation', proposal: reviewProposal(reviewFor(project)) }]).nextState;
    const recorded = reviewed.researchProjects.find((entry) => entry.id === project.id)!;
    expect(recorded.experiment!.findings).toHaveLength(1);
    expect(recorded.experiment!.findings[0]!.capabilityGains.reduce((sum, gain) => sum + gain.gain, 0)).toBeLessThanOrEqual(0.02);
    expect(experimentReviewError(reviewed, companyId, reviewFor(project))).toMatch(/already recorded/);
    const clone = SessionStateSchema.parse(JSON.parse(JSON.stringify(reviewed)));
    expect(clone.researchProjects.find((entry) => entry.id === project.id)!.experiment!.findings).toEqual(recorded.experiment!.findings);
    const next = resolve(reviewed, [{ type: 'adjust_research_project', projectId: project.id, budgetUsd: 5000, computeUnits: 50, researchersAssigned: 1, experimentDirection: 'Replace the evaluation with independent tasks and investigate the routing method.' }]).nextState;
    const continued = next.researchProjects.find((entry) => entry.id === project.id)!;
    expect(continued.experiment).toMatchObject({ round: 2, roundQuarters: 1, awaitingReview: true });
    expect(continued.experiment!.mandate.method).toContain('independent tasks');
    expect(continued.cumulativeSpendUsd).toBe(15000);
    expect(continued.experiment!.findings).toHaveLength(1);
  });

  it('rejects a review from another company, an old round, or before any work', () => {
    const { state, project, companyId } = started();
    const review = reviewFor(project);
    expect(experimentReviewError(state, 'cmp_not_owner', review)).toMatch(/belong/);
    expect(experimentReviewError(state, companyId, { ...review, round: 2 })).toMatch(/older or different/);
    project.experiment!.roundQuarters = 0;
    expect(experimentReviewError(state, companyId, review)).toMatch(/No funded work/);
  });

  it('cannot skip review by adjusting the project through ordinary controls', () => {
    const { state, project } = started();
    const [verdict] = engine.validator.validateBatch(state, [action(state, { type: 'adjust_research_project', projectId: project.id, budgetUsd: 10000, computeUnits: 100, researchersAssigned: 2 })]);
    expect(verdict?.status).toBe('rejected');
  });

  it('does not give capability gains for evaluation failure or unknown capability names', () => {
    const { state, project } = started();
    const review = reviewFor(project); review.outcome = 'evaluation_failure'; review.capabilityGains.push({ area: 'invented_superpower', gain: 0.03 });
    const next = resolve(state, [{ type: 'propose_innovation', proposal: reviewProposal(review) }]).nextState;
    expect(next.researchProjects.find((entry) => entry.id === project.id)!.experiment!.findings[0]!.capabilityGains).toEqual([]);
  });

  it('reserves compute across proposals and rejects demands beyond spare capacity', () => {
    const { state, company } = fixture();
    const p = proposal(); p.experiment!.computeUnits = 800;
    const p2 = proposal({ title: 'Another evolving population' }); p2.experiment!.computeUnits = 800;
    const verdicts = engine.validator.validateBatch(state, [action(state, { type: 'propose_innovation', proposal: p }, company, 1), action(state, { type: 'propose_innovation', proposal: p2 }, company, 2)]);
    expect(verdicts[0]?.status).toBe('accepted'); expect(verdicts[1]?.status).toBe('rejected');
    company.compute.ownedAccelerators = 0;
    expect(experimentResources(state, company).computeUnits).toBe(0);
  });

  it('honours a multi-quarter checkpoint, and closing an experiment stops future spend', () => {
    const { state } = fixture(); const p = proposal(); p.experiment!.reviewAfterQuarters = 2;
    const first = resolve(state, [{ type: 'propose_innovation', proposal: p }]).nextState;
    const project = first.researchProjects.find((entry) => entry.experiment)!;
    expect(project.status).toBe('active');
    const second = resolve(first, []).nextState.researchProjects.find((entry) => entry.id === project.id)!;
    expect(second.status).toBe('paused'); expect(second.cumulativeSpendUsd).toBe(20000);
    const closed = resolve(first, [{ type: 'abandon_research_project', projectId: project.id }]).nextState.researchProjects.find((entry) => entry.id === project.id)!;
    expect(closed.status).toBe('abandoned'); expect(closed.cumulativeSpendUsd).toBe(10000);
  });


  it('does not reuse compute already spent at a checkpoint for production in that quarter', () => {
    const { state, company } = fixture();
    company.compute.trainingAllocation = 0;
    const p = proposal(); p.experiment!.computeUnits = 800;
    const next = resolve(state, [{ type: 'propose_innovation', proposal: p }]).nextState;
    const own = next.companies.find((entry) => entry.id === company.id)!;
    const project = next.researchProjects.find((entry) => entry.companyId === company.id && entry.experiment)!;
    expect(project.experiment!.computeUsedLastRun).toBe(800);
    // Resolver advances the saved quarter after production; inspect the work quarter.
    next.quarter = project.experiment!.lastRunQuarter!;
    expect(servingComputeUnits(next, own)).toBe(200);
    next.quarter += 1;
    expect(servingComputeUnits(next, own)).toBe(1000);
  });

  it('pauses early when resources disappear and records only work actually performed', () => {
    const { state } = fixture();
    const p = proposal(); p.experiment!.reviewAfterQuarters = 4;
    const first = resolve(state, [{ type: 'propose_innovation', proposal: p }]).nextState;
    const project = first.researchProjects.find((entry) => entry.experiment)!;
    first.companies.find((entry) => entry.id === project.companyId)!.employees.researchers = 0;
    const next = resolve(first, []).nextState.researchProjects.find((entry) => entry.id === project.id)!;
    expect(next.status).toBe('paused');
    expect(next.cumulativeSpendUsd).toBe(10000);
    expect(next.experiment).toMatchObject({ roundQuarters: 1, cashSpentLastRun: 0, computeUsedLastRun: 0, awaitingReview: true });
  });

  it('replays identically, and optional experiment fields do not alter legacy proposals', () => {
    const { state } = fixture(); const actions = [action(state, { type: 'propose_innovation', proposal: proposal() })];
    const first = engine.resolver.resolveQuarter(state, actions, null, []);
    const second = engine.resolver.resolveQuarter(state, actions, null, []);
    expect(hashState(first.nextState)).toBe(hashState(second.nextState));
    const legacy = proposal(); delete legacy.experiment;
    expect(InnovationProposalSchema.parse(legacy)).toEqual(legacy);
  });
});


describe('living investigations', () => {
  function living(limit = 25000) {
    const { state, company } = fixture();
    company.balanceSheet.equity += 1_000_000_000 - company.balanceSheet.assets.cash;
    company.balanceSheet.assets.cash = 1_000_000_000;
    company.financials.cash = 1_000_000_000;
    const p = proposal(); p.experiment = { ...p.experiment!, autonomous: true, spendingLimitUsd: limit };
    const next = resolve(state, [{ type: 'propose_innovation', proposal: p }]).nextState;
    const project = next.researchProjects.find((entry) => entry.companyId === company.id && entry.experiment)!;
    return { state: next, project, companyId: company.id };
  }
  function evolvingReview(project: ReturnType<typeof started>['project'], label: string): ExperimentReview {
    return { ...reviewFor(project), recommendation: 'continue', nextMethod: `Investigate ${label} on a newly held-out task distribution.`, hypotheses: [
      { title: `${label} routing hypothesis`, summary: 'A new routing mechanism suggested by the observed task specialisation.', requiredCapabilities: [], estimatedCost: 1000000, estimatedQuarters: 4, novelty: 0.6, plausibility: 0.7 },
      { title: `${label} evaluation hypothesis`, summary: 'An independent evaluation architecture to test the unexpected behaviours.', requiredCapabilities: [], estimatedCost: 1000000, estimatedQuarters: 4, novelty: 0.6, plausibility: 0.7 },
    ] };
  }

  it('turns one idea into multiple persistent branches and adapts across rounds without founder resubmission', () => {
    const first = living();
    const second = resolve(first.state, [{ type: 'propose_innovation', proposal: reviewProposal(evolvingReview(first.project, 'Specialist agents')) }]).nextState;
    const project = second.researchProjects.find((entry) => entry.id === first.project.id)!;
    expect(project.experiment!.round).toBe(2);
    expect(project.experiment!.mandate.method).toContain('Specialist agents');
    expect(project.experiment!.generatedNodeIds).toHaveLength(2);
    expect(project.cumulativeSpendUsd).toBe(20000);
    expect(second.techGraph.edges.filter((edge) => edge.from === project.targetNodeId && edge.kind === 'informs')).toHaveLength(2);
    const thirdOutcome = resolve(second, [{ type: 'propose_innovation', proposal: reviewProposal(evolvingReview(project, 'Cross-task transfer')) }]);
    const third = thirdOutcome.nextState;
    const evolved = third.researchProjects.find((entry) => entry.id === project.id)!;
    expect(evolved.experiment!.round).toBe(3);
    expect(evolved.experiment!.findings).toHaveLength(2);
    expect(evolved.experiment!.generatedNodeIds).toHaveLength(4);
    expect(evolved.experiment!.mandate.method).toContain('Cross-task transfer');
    expect(evolved.cumulativeSpendUsd).toBe(25000);
    const rival = third.companies.find((entry) => entry.id !== first.companyId)!;
    const privateIds = evolved.experiment!.generatedNodeIds!;
    expect(techGraphForCompany(third.techGraph, rival.id).nodes.some((node) => privateIds.includes(node.id))).toBe(false);
    expect(third.companies.find((entry) => entry.id === first.companyId)!.ownedNodes!.some((id) => privateIds.includes(id))).toBe(false);
    const restored = SessionStateSchema.parse(JSON.parse(JSON.stringify(third)));
    expect(restored.researchProjects.find((entry) => entry.id === project.id)!.experiment).toEqual(evolved.experiment);
    const final = resolve(restored, [{ type: 'propose_innovation', proposal: reviewProposal(evolvingReview(evolved, 'Final checks')) }]).nextState;
    const finished = final.researchProjects.find((entry) => entry.id === project.id)!;
    expect(finished.cumulativeSpendUsd).toBe(25000);
    expect(finished.experiment!.round).toBe(3);
    expect(finished.status).toBe('paused');
  });

  it.each(['ask_founder', 'stop'] as const)('honours %s instead of silently running another round', (recommendation) => {
    const { state, project } = living();
    const review = { ...evolvingReview(project, 'A disputed result'), recommendation };
    const next = resolve(state, [{ type: 'propose_innovation', proposal: reviewProposal(review) }]).nextState;
    const paused = next.researchProjects.find((entry) => entry.id === project.id)!;
    expect(paused.status).toBe('paused'); expect(paused.cumulativeSpendUsd).toBe(10000);
    expect(paused.experiment!.round).toBe(1);
  });

  it('does not duplicate branches or effects on replay or resubmission', () => {
    const { state, project } = living();
    const input = { type: 'propose_innovation' as const, proposal: reviewProposal(evolvingReview(project, 'Persistent discovery')) };
    const a = resolve(state, [input]); const b = resolve(state, [input]);
    expect(hashState(a.nextState)).toBe(hashState(b.nextState));
    const replayed = resolve(a.nextState, [input]).nextState;
    expect(replayed.researchProjects.find((entry) => entry.id === project.id)!.experiment!.generatedNodeIds).toHaveLength(2);
  });

  it('requires an explicit spending limit for automatic investigations', () => {
    const { state } = fixture(); const p = proposal(); p.experiment!.autonomous = true;
    expect(engine.validator.validateBatch(state, [action(state, { type: 'propose_innovation', proposal: p })])[0]!.status).toBe('rejected');
  });
});
