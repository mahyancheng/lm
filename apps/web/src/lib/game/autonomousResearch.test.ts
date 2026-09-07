import { describe, expect, it, vi } from 'vitest';
import type { InnovationProposal, ResearchProject, SubmittedAction } from '@frontier/contracts';
import { createWorld3Session } from '@frontier/simulation';
import { hashState } from '@frontier/shared';
import { dueResearchReviews, automaticResearchReview } from './autonomousResearch';
import { resolveQuarterSafely, buildSubmittedActionForCompany } from './engine';

function fixture() {
  const session = createWorld3Session();
  const seat = session.players[0]!;
  const company = session.companies.find((entry) => entry.id === seat.companyId)!;
  const plan = { autonomous: true, spendingLimitUsd: 100000, question: 'Can agents evolve useful cooperation?', method: 'Evolve candidate teams and test transfer on independent tasks.', budgetUsd: 10000, computeUnits: 100, researchersAssigned: 2, reviewAfterQuarters: 1 };
  const project: ResearchProject = { id: 'rsp_living', companyId: company.id, targetNodeId: session.techGraph.nodes[0]!.id, budgetQuarterly: 0, computeAllocated: 0, talentAllocated: 0, progress: 0, internalConfidence: 0.5, quartersElapsed: 1, expectedQuarters: 1, isSecret: true, status: 'paused', cumulativeSpendUsd: 10000, setbacks: 0, startedQuarter: 0,
    experiment: { mandate: plan, round: 1, roundQuarters: 1, awaitingReview: true, lastRunQuarter: 0, cashSpentLastRun: 10000, computeUsedLastRun: 100, computeUsed: 100, researcherQuarters: 2, findings: [] } };
  session.researchProjects.push(project);
  const review: InnovationProposal = { nodeType: 'player_hypothesis', title: 'Team cooperation findings', summary: 'The agent population developed task specialisation with uneven transfer.', novelty: 0.5, plausibility: 0.5, requiredCapabilities: [], estimatedCost: 10000, estimatedQuarters: 1, dependencies: [], initialVisibility: 'company_private', rationale: 'Review the observed work and investigate its unresolved behaviour.',
    experimentReview: { projectId: project.id, round: 1, elapsedQuarters: 1, outcome: 'unexpected', observation: 'Agent teams specialised on some task families but failed transfer tests.', interpretation: 'Test whether the division of labour generalises before building a product.', nextDirections: ['Evaluate different task families to test whether specialisation generalises.'], capabilityGains: [], hypotheses: [], recommendation: 'continue', nextMethod: 'Introduce new task families and independently evaluate generalisation.' } };
  return { session, company, project, review, playerId: seat.playerId };
}

describe('automatic research reviews', () => {
  it('selects only controlled ongoing investigations and respects queued founder decisions', () => {
    const { session, company, project, playerId } = fixture();
    expect(dueResearchReviews(session, playerId, []).map((entry) => entry.id)).toEqual([project.id]);
    const cancel = buildSubmittedActionForCompany(session, { type: 'abandon_research_project', projectId: project.id }, 1, company.id);
    expect(dueResearchReviews(session, playerId, [cancel])).toEqual([]);
    project.experiment!.mandate.autonomous = false;
    expect(dueResearchReviews(session, playerId, [])).toEqual([]);
    project.experiment!.mandate.autonomous = true;
    project.companyId = session.companies.find((entry) => entry.id !== company.id)!.id;
    expect(dueResearchReviews(session, playerId, [])).toEqual([]);
  });

  it('bounds requests and rotates through investigations', () => {
    const { session, project, playerId } = fixture();
    for (let index = 1; index < 4; index++) session.researchProjects.push({ ...structuredClone(project), id: `rsp_living_${index}` });
    const first = dueResearchReviews(session, playerId, []).map((entry) => entry.id);
    expect(first).toHaveLength(2);
    session.quarter += 1;
    expect(dueResearchReviews(session, playerId, []).map((entry) => entry.id)).not.toEqual(first);
  });

  it('carries recorded history and remaining budget into a new review without mutating state', async () => {
    const { session, project, review } = fixture();
    project.experiment!.findings.push({ ...review.experimentReview!, round: 1, quarter: 0, eventId: 'evt_prior' });
    project.experiment!.round = 2; project.quartersElapsed = 2;
    review.experimentReview!.round = 2; review.experimentReview!.elapsedQuarters = 2;
    const before = hashState(session);
    const request = vi.fn(async (input) => {
      const context = JSON.parse(input.experimentContext);
      expect(context.remainingCashCeilingUsd).toBe(90000);
      expect(context.previousFindings[0].observation).toContain('specialised');
      return review;
    });
    expect(await automaticResearchReview(session, project.id, request)).toEqual(review);
    expect(hashState(session)).toBe(before);
  });

  it('keeps waiting on outage, stale output, or a missing adaptation decision', async () => {
    const { session, project, review } = fixture();
    expect(await automaticResearchReview(session, project.id, async () => null)).toBeNull();
    review.experimentReview!.round = 9;
    expect(await automaticResearchReview(session, project.id, async () => review)).toBeNull();
    review.experimentReview!.round = 1;
    delete review.experimentReview!.recommendation;
    expect(await automaticResearchReview(session, project.id, async () => review)).toBeNull();
  });

  it('drops automatic reviews on offline retry and records only the surviving actions', () => {
    const { session, company, review } = fixture();
    const action = buildSubmittedActionForCompany(session, { type: 'set_research_budget', budgetUsd: 1000 }, 1, company.id);
    const automatic = buildSubmittedActionForCompany(session, { type: 'propose_innovation', proposal: review }, 2, company.id, { origin: 'research_agent', confirmedByHuman: false });
    const seen: SubmittedAction[][] = [];
    const result = resolveQuarterSafely(session, [action, automatic], null, [], (_state, actions) => {
      seen.push([...actions]);
      throw new Error('simulate a failed resolve');
    });
    expect(seen[0]).toHaveLength(2);
    expect(seen[1]).toEqual([action]);
    expect(result.submitted).toEqual([action]);
  });
});
