/** Open-ended, paid investigations. Recorded LLM findings are inputs to the
 * deterministic engine; no model is called here and no generated code executes. */
import type { Company, ExperimentReview, InnovationIntegrationResult, InnovationProposal, ResearchProject, ResolverContext, SessionState, TechNode } from '@frontier/contracts';
import { makeId, quarterToYear } from '@frontier/contracts';
import { integrateDiscoveredInnovation } from './innovation';
import { isNodeEconomyWorld } from '../economy/sectors';
import { heldComputeUnits } from '../companies/products';
import { drawPerUnitOf, lineNodeOf } from '../graph/lines';
import { computeCommitted, researchersCommitted } from '../validator/context';
import { bumpGraphVersion, emitEvent, isCapabilityArea, money, unit } from './util';

/** Spare compute excludes both other programmes and last quarter's production. */
export function experimentResources(state: SessionState, company: Company, excludeProjectId?: string) {
  const own = state.researchProjects.find((entry) => entry.id === excludeProjectId && entry.companyId === company.id);
  const held = Math.floor(heldComputeUnits(state, company));
  const serving = company.products.reduce((sum, product) => {
    const node = lineNodeOf(product);
    return !product.isActive || node?.capacityKind !== 'compute' ? sum : sum + (product.unitsSoldQuarterly ?? product.activeCustomers) * drawPerUnitOf(node, product);
  }, 0);
  return {
    computeUnits: Math.max(0, Math.floor(held - serving - computeCommitted(state, company.id) + (own?.computeAllocated ?? 0))),
    researchersAssigned: Math.max(0, company.employees.researchers - researchersCommitted(state, company.id) + (own?.talentAllocated ?? 0)),
  };
}

export function experimentReviewError(state: SessionState, companyId: string, review: ExperimentReview): string | null {
  const project = state.researchProjects.find((entry) => entry.id === review.projectId && entry.companyId === companyId);
  const experiment = project?.experiment;
  if (!project || !experiment) return 'This experiment does not belong to the acting company.';
  if (project.status !== 'paused' || !experiment.awaitingReview) return 'The experiment has not reached its review checkpoint.';
  if (experiment.roundQuarters === 0) return 'No funded work was performed in this round; close it and start a smaller investigation.';
  if (review.round !== experiment.round || review.elapsedQuarters !== project.quartersElapsed) return 'These findings refer to an older or different experiment round.';
  if (experiment.findings.some((finding) => finding.round === review.round)) return 'Findings for this round are already recorded.';
  return null;
}

export function integrateExperiment(state: SessionState, proposal: InnovationProposal, ctx: ResolverContext): InnovationIntegrationResult {
  const action = state.pendingActions.find((entry) => entry.quarter === ctx.quarter && entry.intent.type === 'propose_innovation' && entry.intent.proposal === proposal);
  // The resolver normally passes the exact proposal; structural lookup also supports recorded/reparsed actions.
  const submitted = action ?? state.pendingActions.find((entry) => entry.quarter === ctx.quarter && entry.intent.type === 'propose_innovation' && JSON.stringify(entry.intent.proposal) === JSON.stringify(proposal));
  const company = state.companies.find((entry) => entry.id === submitted?.actorCompanyId);
  const result = (accepted: boolean, nodeId: string | null, reasons: string[]): InnovationIntegrationResult => ({ accepted, nodeId, reasons, adjustedPlausibility: proposal.plausibility, adjustedCostUsd: proposal.experiment ? proposal.experiment.budgetUsd * proposal.experiment.reviewAfterQuarters : 0, adjustedQuarters: proposal.experiment?.reviewAfterQuarters ?? 1 });
  const reject = (reason: string) => {
    const eventId = emitEvent(state, ctx, 'action_rejected', company?.id ?? null, null, { kind: 'experiment', reason }, 'company');
    ctx.log({ phase: 'research_resolution', text: reason, deltaLabel: 'not started', refEventIds: [eventId], tone: 'warning', subjectId: company?.id ?? null });
    return result(false, null, [reason]);
  };
  if (!company || !company.isActive) return reject('The experiment needs an active, controlled company.');
  if (proposal.experiment && proposal.experimentReview) return reject('Start and review must be separate proposals.');

  if (proposal.experimentReview) {
    const review = proposal.experimentReview;
    const error = experimentReviewError(state, company.id, review);
    if (error) return reject(error);
    const project = state.researchProjects.find((entry) => entry.id === review.projectId)!;
    const experiment = project.experiment!;
    // Only promising findings from paid, staffed work can improve capabilities.
    // Deduplicate areas and cap the aggregate effect; a verbose model cannot stack grants.
    const positive = review.outcome === 'promising' || review.outcome === 'unexpected';
    let remaining = positive && experiment.computeUsed > 0 && experiment.researcherQuarters > 0 ? 0.02 : 0;
    const seen = new Set<string>();
    const gains: ExperimentReview['capabilityGains'] = [];
    for (const requested of review.capabilityGains) {
      if (seen.has(requested.area) || !isCapabilityArea(requested.area)) continue;
      seen.add(requested.area);
      const before = company.techCapabilities[requested.area] ?? 0;
      const gain = Math.min(remaining, requested.gain, 1 - before);
      if (gain <= 0) continue;
      company.techCapabilities[requested.area] = unit(before + gain);
      gains.push({ area: requested.area, gain });
      remaining -= gain;
    }
    const applied = { ...review, capabilityGains: gains };
    const eventId = emitEvent(state, ctx, 'research_progress', company.id, project.targetNodeId, { kind: 'experiment_findings', ...applied }, 'private');
    experiment.findings.push({ ...applied, quarter: ctx.quarter, eventId });
    const node = state.techGraph.nodes.find((entry) => entry.id === project.targetNodeId);
    if (node) node.confidenceByCompany[company.id] = unit((node.confidenceByCompany[company.id] ?? 0.5) + (positive ? 0.05 : review.outcome === 'negative' || review.outcome === 'evaluation_failure' ? -0.1 : 0));
    for (const hypothesis of review.hypotheses ?? []) {
      // A lead is a real, costed hypothesis, not a free demonstrated technology.
      const discovered = integrateDiscoveredInnovation(state, {
        ...hypothesis, nodeType: 'player_hypothesis', dependencies: [],
        initialVisibility: 'company_private', rationale: review.interpretation,
      }, ctx, company, submitted?.actorCharacterId ?? null);
      if (!discovered.accepted || !discovered.nodeId) continue;
      experiment.generatedNodeIds ??= [];
      experiment.generatedNodeIds.push(discovered.nodeId);
      state.techGraph.edges.push({ from: project.targetNodeId, to: discovered.nodeId, kind: 'informs', strength: 0.5 });
    }
    bumpGraphVersion(state, ctx);
    return result(true, project.targetNodeId, ['Findings and new hypotheses recorded. The standing mandate determines whether work continues.']);
  }

  const plan = proposal.experiment;
  if (!plan || !state.config.allowPlayerInnovation || !isNodeEconomyWorld(state)) return reject('Exploratory experiments require player innovation in a world-3 session.');
  if (state.techGraph.nodes.some((node) => node.title.toLowerCase() === proposal.title.toLowerCase())) return reject('An investigation or technology with this title already exists.');
  const free = experimentResources(state, company);
  if (plan.computeUnits > free.computeUnits || plan.researchersAssigned > free.researchersAssigned) return reject('The experiment no longer fits the company’s spare compute and researchers. Adjust its resources.');
  if (plan.budgetUsd <= 0 || plan.budgetUsd > Math.max(0, company.financials.cash)) return reject('The company cannot cover the first experiment period. Reduce its cash budget.');
  if (plan.autonomous && (plan.spendingLimitUsd === undefined || plan.spendingLimitUsd < plan.budgetUsd)) return reject('Automatic investigations need a funded standing cash limit.');
  const year = quarterToYear(state.startYear, ctx.quarter);
  const nodeId = makeId('tech', company.id, proposal.title, ctx.quarter);
  const node: TechNode = {
    id: nodeId, title: proposal.title, summary: proposal.summary, sector: company.sector ?? 'ai',
    status: 'company_thesis', publicConfidence: 0, confidenceByCompany: { [company.id]: 0.5 },
    estimatedWindow: [year, year + 1], researchCostRange: [plan.budgetUsd, plan.budgetUsd * plan.reviewAfterQuarters],
    computeIntensity: 0.5, talentRequirements: proposal.requiredCapabilities,
    // Exploration records its starting point, but does not require a known destination.
    dependencies: [], possibleUnlocks: [], originalProposerId: submitted?.actorCharacterId ?? null,
    visibility: 'company_private', achievedByCompanyId: null, achievedQuarter: null,
    createdQuarter: ctx.quarter, novelty: proposal.novelty, plausibility: proposal.plausibility,
  };
  const project: ResearchProject = {
    id: makeId('rsp', company.id, nodeId), companyId: company.id, targetNodeId: nodeId,
    budgetQuarterly: plan.budgetUsd, computeAllocated: plan.computeUnits, talentAllocated: plan.researchersAssigned,
    progress: 0, internalConfidence: 0.5, quartersElapsed: 0, expectedQuarters: plan.reviewAfterQuarters,
    isSecret: true, status: 'active', cumulativeSpendUsd: 0, setbacks: 0, startedQuarter: ctx.quarter,
    experiment: { mandate: { ...plan }, round: 1, roundQuarters: 0, awaitingReview: false, lastRunQuarter: null, cashSpentLastRun: 0, computeUsedLastRun: 0, computeUsed: 0, researcherQuarters: 0, findings: [] },
  };
  state.techGraph.nodes.push(node);
  state.researchProjects.push(project);
  emitEvent(state, ctx, 'tech_node_added', company.id, nodeId, { kind: 'experiment_started', projectId: project.id, mandate: plan }, 'private');
  bumpGraphVersion(state, ctx);
  return result(true, nodeId, ['Experiment opened. It pauses at the review checkpoint; no breakthrough is promised.']);
}

/** Record work, then release resources at the checkpoint. Findings require an LLM review. */
export function advanceExperiment(state: SessionState, ctx: ResolverContext, project: ResearchProject): void {
  const experiment = project.experiment!;
  if (experiment.awaitingReview || experiment.lastRunQuarter === ctx.quarter) return;
  const company = state.companies.find((entry) => entry.id === project.companyId);
  if (!company) return;
  const free = experimentResources(state, company, project.id);
  const compute = Math.min(project.computeAllocated, free.computeUnits);
  const researchers = Math.min(project.talentAllocated, free.researchersAssigned);
  const alreadySpent = state.researchProjects.reduce((sum, entry) => sum + (entry.companyId === company.id && entry.experiment?.lastRunQuarter === ctx.quarter ? entry.experiment.cashSpentLastRun : 0), 0);
  const cash = Math.min(project.budgetQuarterly, Math.max(0, company.financials.cash - alreadySpent), Math.max(0, (experiment.mandate.spendingLimitUsd ?? Infinity) - project.cumulativeSpendUsd));
  experiment.lastRunQuarter = ctx.quarter;
  experiment.cashSpentLastRun = researchers > 0 ? money(cash) : 0;
  experiment.computeUsedLastRun = cash > 0 && researchers > 0 ? compute : 0;
  if (cash > 0 && researchers > 0) {
    experiment.roundQuarters += 1;
    project.quartersElapsed += 1;
    project.cumulativeSpendUsd = money(project.cumulativeSpendUsd + cash);
    experiment.computeUsed += compute;
    experiment.researcherQuarters += researchers;
  }
  const reachedLimit = experiment.mandate.spendingLimitUsd !== undefined && project.cumulativeSpendUsd >= experiment.mandate.spendingLimitUsd;
  const checkpoint = reachedLimit || experiment.roundQuarters >= experiment.mandate.reviewAfterQuarters || cash < project.budgetQuarterly || researchers < project.talentAllocated || compute < project.computeAllocated;
  if (checkpoint) {
    experiment.awaitingReview = true;
    project.status = 'paused';
    project.budgetQuarterly = 0;
    project.computeAllocated = 0;
    project.talentAllocated = 0;
  }
  emitEvent(state, ctx, 'research_progress', company.id, project.targetNodeId, {
    kind: 'experiment_work', projectId: project.id, round: experiment.round,
    question: experiment.mandate.question, method: experiment.mandate.method,
    cashSpentUsd: experiment.cashSpentLastRun, computeUnits: experiment.computeUsedLastRun, researchers: cash > 0 ? researchers : 0,
    awaitingReview: experiment.awaitingReview,
  }, 'private');
  // Completion measures work performed, never progress toward an assumed scientific success.
  project.progress = 0;
}

/** Resume only after explicit manual starts/adjustments have claimed their
 * resources. The standing mandate authorises adaptation, never a larger spend. */
export function continueAutonomousExperiments(state: SessionState, ctx: ResolverContext): void {
  if (!state.config.allowPlayerInnovation) return;
  for (const project of state.researchProjects) {
    const experiment = project.experiment;
    if (!experiment?.mandate.autonomous || project.status !== 'paused' || !experiment.awaitingReview) continue;
    const finding = experiment.findings.find((entry) => entry.round === experiment.round);
    if (!finding || finding.recommendation !== 'continue' || !finding.nextMethod) continue;
    const company = state.companies.find((entry) => entry.id === project.companyId && entry.isActive);
    if (!company) continue;
    const remaining = (experiment.mandate.spendingLimitUsd ?? 0) - project.cumulativeSpendUsd;
    if (remaining < 1 || company.financials.cash < 1 || experiment.round >= 200 || project.quartersElapsed + experiment.mandate.reviewAfterQuarters > 200) continue;
    const free = experimentResources(state, company);
    if (free.computeUnits < experiment.mandate.computeUnits || free.researchersAssigned < experiment.mandate.researchersAssigned) continue;
    experiment.mandate.method = finding.nextMethod;
    experiment.round += 1;
    experiment.roundQuarters = 0;
    experiment.computeUsed = 0;
    experiment.researcherQuarters = 0;
    experiment.awaitingReview = false;
    project.status = 'active';
    project.budgetQuarterly = Math.min(experiment.mandate.budgetUsd, remaining);
    project.computeAllocated = experiment.mandate.computeUnits;
    project.talentAllocated = experiment.mandate.researchersAssigned;
    const eventId = emitEvent(state, ctx, 'research_progress', company.id, project.targetNodeId, {
      kind: 'experiment_adapted', projectId: project.id, round: experiment.round,
      method: experiment.mandate.method, remainingCashCeilingUsd: remaining,
    }, 'private');
    ctx.log({ phase: 'research_resolution', text: `The research team began round ${experiment.round}: ${finding.nextMethod}`, deltaLabel: 'Investigation adapted', refEventIds: [eventId], tone: 'neutral', subjectId: company.id });
  }
}
