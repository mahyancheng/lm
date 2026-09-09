import type { Company, ExperimentPlan, InnovationInterpreterInput, InnovationProposal, ResearchProject, SessionState, TechGraph } from '@frontier/contracts';
import { buildInnovationInput } from './innovationClient';

/** The guided path funds an investigation without pretending to know its findings. */
export function experimentProposal(plan: ExperimentPlan): InnovationProposal {
  return {
    nodeType: 'player_hypothesis', title: plan.question.slice(0, 120),
    summary: `Investigate: ${plan.question}`.slice(0, 1000), novelty: 0.5, plausibility: 0.5,
    requiredCapabilities: [], estimatedCost: plan.budgetUsd * plan.reviewAfterQuarters,
    estimatedQuarters: plan.reviewAfterQuarters, dependencies: [], initialVisibility: 'company_private',
    rationale: 'Run a bounded investigation, record what happened, then choose the next direction.', experiment: plan,
  };
}

export function experimentReviewInput(state: SessionState, company: Company, graph: TechGraph, project: ResearchProject): InnovationInterpreterInput {
  const experiment = project.experiment!;
  const node = graph.nodes.find((entry) => entry.id === project.targetNodeId);
  const input = buildInnovationInput(state, company, graph, experiment.mandate.question, experiment.mandate.budgetUsd, experiment.mandate.computeUnits);
  return {
    ...input, existingNodes: input.existingNodes.slice(-400), experimentMode: 'review',
    experimentContext: JSON.stringify({
      projectId: project.id, title: node?.title, round: experiment.round, elapsedQuarters: project.quartersElapsed,
      question: experiment.mandate.question, method: experiment.mandate.method,
      completedPeriods: experiment.roundQuarters, cumulativeCashSpentUsd: project.cumulativeSpendUsd,
      computeUnitQuartersThisRound: experiment.computeUsed, researcherQuartersThisRound: experiment.researcherQuarters,
      lastRunQuarter: experiment.lastRunQuarter,
      autonomous: experiment.mandate.autonomous ?? false,
      remainingCashCeilingUsd: experiment.mandate.spendingLimitUsd === undefined ? null : Math.max(0, experiment.mandate.spendingLimitUsd - project.cumulativeSpendUsd),
      existingResearchBranches: (experiment.generatedNodeIds ?? []).slice(-12).map((id) => graph.nodes.find((node) => node.id === id)).filter(Boolean).map((node) => ({ title: node!.title, status: node!.status })),
      previousFindings: experiment.findings.slice(-3).map((finding) => ({ round: finding.round, outcome: finding.outcome, observation: finding.observation.slice(0, 700), interpretation: finding.interpretation.slice(0, 500), nextDirections: finding.nextDirections })),
    }),
  };
}
