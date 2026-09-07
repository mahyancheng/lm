import { describe, expect, it } from 'vitest';
import type { InnovationProposal, ResearchProject, SubmittedAction } from '@frontier/contracts';
import { createWorld3Session } from '@frontier/simulation';
import { getEngine, resolveQuarterSafely, buildSubmittedActionForCompany } from './engine';
import { automaticResearchReview, dueResearchReviews } from './autonomousResearch';

function review(project: ResearchProject, round: number, nextMethod: string): InnovationProposal {
  return {
    nodeType: 'player_hypothesis', title: `Round ${round} findings`,
    summary: 'The research team found a measurable effect and proposes a bounded follow-up.', novelty: 0.5, plausibility: 0.7,
    requiredCapabilities: [], estimatedCost: 10_000, estimatedQuarters: 1, dependencies: [], initialVisibility: 'company_private',
    rationale: 'Continue from observed evidence with an independent evaluation.',
    experimentReview: {
      projectId: project.id, round, elapsedQuarters: round, outcome: 'unexpected',
      observation: `Round ${round} produced a measurable result in held-out evaluation.`,
      interpretation: 'The result supports a narrower follow-up experiment.',
      nextDirections: [`Test the round ${round} result under a changed evaluation condition.`],
      capabilityGains: [], hypotheses: [], recommendation: 'continue', nextMethod,
    },
  };
}

describe('autonomous research continuation lifecycle', () => {
  it('reviews, adapts, spends, and reaches a second checkpoint across committed quarters', async () => {
    const session = createWorld3Session();
    const seat = session.players[0]!;
    const company = session.companies.find((entry) => entry.id === seat.companyId)!;
    company.products.forEach((product) => { product.isActive = false; });
    company.compute.ownedAccelerators += 1000;
    company.employees.researchers += 10;
    const project: ResearchProject = {
      id: 'rsp_autonomous_lifecycle', companyId: company.id, targetNodeId: session.techGraph.nodes[0]!.id,
      budgetQuarterly: 0, computeAllocated: 0, talentAllocated: 0, progress: 0, internalConfidence: 0.5,
      quartersElapsed: 1, expectedQuarters: 1, isSecret: true, status: 'paused', cumulativeSpendUsd: 10_000,
      setbacks: 0, startedQuarter: 0,
      experiment: {
        mandate: { autonomous: true, spendingLimitUsd: 50_000, question: 'Can agents discover useful coordination?', method: 'Evaluate candidate behaviours independently.', budgetUsd: 10_000, computeUnits: 10, researchersAssigned: 1, reviewAfterQuarters: 1 },
        round: 1, roundQuarters: 1, awaitingReview: true, lastRunQuarter: 0, cashSpentLastRun: 10_000,
        computeUsedLastRun: 10, computeUsed: 10, researcherQuarters: 1, findings: [],
      },
    };
    session.researchProjects.push(project);

    expect(dueResearchReviews(session, seat.playerId, [])).toEqual([project]);
    const first = await automaticResearchReview(session, project.id, async () => review(project, 1, 'Change the population mix and repeat the held-out evaluation.'));
    expect(first?.experimentReview?.nextMethod).toContain('population mix');
    const firstAction = buildSubmittedActionForCompany(session, { type: 'propose_innovation', proposal: first! }, 0, company.id, { origin: 'research_agent', confirmedByHuman: false });
    const firstQuarter = resolveQuarterSafely(session, [firstAction], null, [], (state, actions, proposal, bundles) => getEngine().resolver.resolveQuarter(state, actions, proposal, bundles));
    expect(firstQuarter.outcome?.committed).toBe(true);
    const afterFirst = firstQuarter.outcome!.nextState;
    const persisted = afterFirst.researchProjects.find((entry) => entry.id === project.id)!;
    expect(persisted.experiment?.findings.length).toBeGreaterThan(0);
    expect(persisted.experiment?.mandate.spendingLimitUsd).toBe(50_000);
    const adaptedQuarter = resolveQuarterSafely(afterFirst, [], null, [], (state, actions, proposal, bundles) => getEngine().resolver.resolveQuarter(state, actions, proposal, bundles));
    expect(adaptedQuarter.outcome?.committed).toBe(true);
    const adaptedState = adaptedQuarter.outcome!.nextState;
    const adapted = adaptedState.researchProjects.find((entry) => entry.id === project.id)!;
    expect(adapted.experiment?.round).toBe(2);
    expect(adapted.experiment?.mandate.method).toContain('population mix');
    expect(adapted.status).toBe('paused');
    const checkpointState = adaptedState;
    const checkpoint = checkpointState.researchProjects.find((entry) => entry.id === project.id)!;
    expect(dueResearchReviews(checkpointState, seat.playerId, [])).toContainEqual(checkpoint);
    expect(dueResearchReviews(checkpointState, seat.playerId, [buildSubmittedActionForCompany(checkpointState, { type: 'propose_innovation', proposal: first! }, 0, company.id)])).toEqual([]);
    expect(await automaticResearchReview(checkpointState, project.id, async () => first)).toBeNull();

    const second = await automaticResearchReview(checkpointState, project.id, async () => review(checkpoint, 2, 'Test transfer to a new held-out task family.'));
    expect(second?.experimentReview?.nextMethod).not.toBe(first?.experimentReview?.nextMethod);
    const secondAction: SubmittedAction = buildSubmittedActionForCompany(checkpointState, { type: 'propose_innovation', proposal: second! }, 0, company.id, { origin: 'research_agent', confirmedByHuman: false });
    const secondQuarter = resolveQuarterSafely(checkpointState, [secondAction], null, [], (state, actions, proposal, bundles) => getEngine().resolver.resolveQuarter(state, actions, proposal, bundles));
    expect(secondQuarter.outcome?.committed).toBe(true);
    const finalProject = secondQuarter.outcome!.nextState.researchProjects.find((entry) => entry.id === project.id)!;
    expect(finalProject.experiment?.findings.length).toBeGreaterThan(persisted.experiment?.findings.length ?? 0);
    expect(finalProject.cumulativeSpendUsd).toBeGreaterThan(project.cumulativeSpendUsd);
    expect(finalProject.experiment?.mandate.method).toContain('held-out task family');
    expect(finalProject.cumulativeSpendUsd).toBeLessThanOrEqual(50_000);
  });
});
