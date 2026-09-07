/** Quarter orchestration only. Model reviews become recorded actions; this
 * module never mutates a session or asks a model inside deterministic replay. */
import { InnovationProposalSchema } from '@frontier/contracts';
import type { InnovationInterpreterInput, InnovationProposal, SessionState, SubmittedAction } from '@frontier/contracts';
import { controlledCompaniesOf, experimentReviewError, techGraphForCompany } from '@frontier/simulation';
import { experimentReviewInput } from '@/components/screens/research/experimentClient';

export function dueResearchReviews(session: SessionState, playerId: string, queued: readonly SubmittedAction[], cap = 2) {
  const controlled = new Set(controlledCompaniesOf(session, playerId).map((company) => company.id));
  const due = session.researchProjects.filter((project) => {
    const experiment = project.experiment;
    if (!controlled.has(project.companyId) || !experiment?.mandate.autonomous || project.status !== 'paused' || !experiment.awaitingReview || experiment.roundQuarters === 0) return false;
    if (experiment.findings.some((finding) => finding.round === experiment.round)) return false;
    return !queued.some(({ intent }) => (
      (intent.type === 'abandon_research_project' || intent.type === 'adjust_research_project') && intent.projectId === project.id
    ) || (intent.type === 'propose_innovation' && intent.proposal.experimentReview?.projectId === project.id));
  }).sort((a, b) => a.id.localeCompare(b.id));
  if (due.length === 0) return [];
  // Rotate requests so an unavailable/slow investigation cannot starve others.
  const offset = session.quarter % due.length;
  return [...due.slice(offset), ...due.slice(0, offset)].slice(0, cap);
}

export async function automaticResearchReview(
  session: SessionState,
  projectId: string,
  request: (input: InnovationInterpreterInput) => Promise<InnovationProposal | null>,
): Promise<InnovationProposal | null> {
  const project = session.researchProjects.find((entry) => entry.id === projectId);
  if (!project?.experiment?.mandate.autonomous) return null;
  const company = session.companies.find((entry) => entry.id === project.companyId);
  if (!company) return null;
  try {
    const raw = await request(experimentReviewInput(session, company, techGraphForCompany(session.techGraph, company.id), project));
    const parsed = InnovationProposalSchema.safeParse(raw);
    if (!parsed.success) return null;
    const output = parsed.data;
    if (!output?.experimentReview || experimentReviewError(session, company.id, output.experimentReview)) return null;
    if (output.experimentReview.projectId !== project.id) return null;
    if (!output.experimentReview.recommendation || (output.experimentReview.recommendation === 'continue' && !output.experimentReview.nextMethod)) return null;
    const { experiment: _unexpectedPlan, ...review } = output;
    return review;
  } catch { return null; }
}
