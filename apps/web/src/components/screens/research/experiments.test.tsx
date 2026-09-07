import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ResearchProject } from '@frontier/contracts';
import { InnovationInterpreterInputSchema, InnovationProposalSchema } from '@frontier/contracts';
import { createWorld3Session, techGraphForCompany } from '@frontier/simulation';
import { ExperimentsPanel } from './ExperimentsPanel';
import { experimentProposal, experimentReviewInput } from './experimentClient';

vi.mock('@/lib/game', () => ({
  useGameActions: () => ({ queueAction: vi.fn(), validateIntent: () => null }),
  useLlm: () => ({ available: false }),
  useSettings: () => ({ useLiveModel: false }),
  useResolving: () => ({ resolving: false }),
  useQueuedActions: () => [],
}));

function fixture() {
  const session = createWorld3Session();
  const company = session.companies.find((entry) => entry.id === session.players[0]!.companyId)!;
  const graph = techGraphForCompany(session.techGraph, company.id);
  const plan = { question: 'Can black-box agents evolve useful new behaviours?', method: 'Evolve candidate agents and evaluate generalisation on independent tasks.', budgetUsd: 10000, computeUnits: 100, researchersAssigned: 2, reviewAfterQuarters: 1 };
  const project: ResearchProject = { id: 'rsp_experiment', companyId: company.id, targetNodeId: graph.nodes[0]!.id, budgetQuarterly: 0, computeAllocated: 0, talentAllocated: 0, progress: 0, internalConfidence: 0.5, quartersElapsed: 1, expectedQuarters: 1, isSecret: true, status: 'paused', cumulativeSpendUsd: 10000, setbacks: 0, startedQuarter: 0,
    experiment: { mandate: plan, round: 1, roundQuarters: 1, awaitingReview: true, lastRunQuarter: 0, cashSpentLastRun: 10000, computeUsedLastRun: 100, computeUsed: 100, researcherQuarters: 2, findings: [] } };
  return { session, company, graph, plan, project };
}

describe('open-ended research interface', () => {
  it('offers experiments in the node economy and keeps a paused investigation usable offline', () => {
    const { session, company, graph, project } = fixture();
    session.researchProjects.push(project);
    const html = renderToStaticMarkup(<ExperimentsPanel {...{ session, company, graph }} onFollowUp={() => {}} />);
    expect(html).toContain('New experiment');
    expect(html).toContain('Ready for review');
    expect(html).toContain('Your experiment can wait without spending more.');
    expect(html).toContain('Close experiment');
    expect(html).not.toContain('Findings recorded');
  });

  it('does not render another company’s experiment even if canonical state holds it', () => {
    const { session, company, graph, project } = fixture();
    project.companyId = session.companies.find((entry) => entry.id !== company.id)!.id;
    project.experiment!.mandate.method = 'Rival secret: a unique undisclosed evaluation strategy.';
    session.researchProjects.push(project);
    const html = renderToStaticMarkup(<ExperimentsPanel {...{ session, company, graph }} onFollowUp={() => {}} />);
    expect(html).not.toContain('Rival secret');
    expect(html).toContain('No experiments yet');
  });

  it('makes the guided proposal valid without inventing findings', () => {
    const { plan } = fixture();
    const proposal = InnovationProposalSchema.parse(experimentProposal(plan));
    expect(proposal.experiment).toEqual(plan);
    expect(proposal.experimentReview).toBeUndefined();
    expect(proposal.initialVisibility).toBe('company_private');
  });

  it('asks the model to review recorded work with exact round identity', () => {
    const { session, company, graph, project } = fixture();
    const input = InnovationInterpreterInputSchema.parse(experimentReviewInput(session, company, graph, project));
    const context = JSON.parse(input.experimentContext!);
    expect(input.experimentMode).toBe('review');
    expect(context).toMatchObject({ projectId: project.id, round: 1, elapsedQuarters: 1, computeUnitQuartersThisRound: 100, researcherQuartersThisRound: 2 });
    expect(context.previousFindings).toEqual([]);
  });
});
