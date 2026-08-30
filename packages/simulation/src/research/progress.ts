/**
 * @frontier/simulation — research/progress.ts
 *
 * The first half of the research phase (`research_resolution`, phase 9):
 * advancing every live programme by what it was actually given.
 *
 * ```text
 * delta = (1 / expectedQuarters)
 *       × fundingFactor(budget vs the node's cost estimate)
 *       × computeFactor(allocated compute vs the node's intensity, scaled by
 *                       world.aiFrontier.trainingEfficiency)
 *       × talentFactor(researchers assigned × capability coverage)
 *       × noise
 * ```
 *
 * Progress is not linear and can go backwards: a failed run destroys part of the
 * accumulated progress, adds a quarter to the internal estimate and takes a bite
 * out of the team's own confidence.
 *
 * **Visibility discipline.** A secret programme's setbacks and progress are
 * written to the ledger at `private` visibility and produce no line in the
 * quarter report at all. `docs/SIMULATION.md` §5: a secret setback damages
 * internal research and does not move the share price — unless it leaks.
 */

import type { ResearchProject, ResolverContext, SessionState, TechNode } from '@frontier/contracts';
import {
  BASE_PROJECT_COMPUTE_UNITS,
  BASE_PROJECT_RESEARCHERS,
  CAPABILITY_COVERAGE_WEIGHT,
  COMPUTE_FLOOR,
  FUNDING_FLOOR,
  IMPUTED_COMPUTE_COST_USD_PER_UNIT,
  INTERNAL_CONFIDENCE_DRIFT,
  MAX_SETBACKS,
  OVERSUPPLY_BONUS,
  PROGRESS_NOISE_BAND,
  SETBACK_BASE_PROBABILITY,
  SETBACK_COMPUTE_WEIGHT,
  SETBACK_CONFIDENCE_FACTOR,
  SETBACK_NOVELTY_WEIGHT,
  SETBACK_PROBABILITY_BOUNDS,
  SETBACK_PROGRESS_FLOOR_LOSS,
  SETBACK_PROGRESS_LOSS,
  SETBACK_TALENT_WEIGHT,
  TALENT_FLOOR,
} from './balance';
import { capabilityCoverage, clamp, emitEvent, findCompany, findNode, money, projectVisibility, ratio, unit, usdLabel } from './util';

/** The resourcing a programme received this quarter, each expressed 0..~1.2. */
export interface ResourcingFactors {
  readonly funding: number;
  readonly compute: number;
  readonly talent: number;
  readonly coverage: number;
  readonly expectedQuarterlyCostUsd: number;
  readonly requiredComputeUnits: number;
  readonly requiredResearchers: number;
}

/** A saturating adequacy curve: full marks at the required level, a little more above it. */
function adequacy(supplied: number, required: number, floor: number): number {
  const r = ratio(supplied, Math.max(1e-6, required), 0);
  return floor + (1 - floor) * Math.min(1, r) + OVERSUPPLY_BONUS * clamp(r - 1, 0, 1);
}

/**
 * How well resourced a programme is, given the node it is chasing and the state
 * of the world. Exported because the tests pin down that better resourcing moves
 * a programme faster.
 */
export function resourcingFactors(draft: SessionState, project: ResearchProject, node: TechNode): ResourcingFactors {
  const company = findCompany(draft, project.companyId);
  const [low, high] = node.researchCostRange;
  const expectedQuarterlyCost = Math.max(1, (low + high) / 2 / Math.max(1, project.expectedQuarters));
  const requiredCompute = Math.max(1, BASE_PROJECT_COMPUTE_UNITS * Math.max(0.05, node.computeIntensity));
  const requiredResearchers = Math.max(1, BASE_PROJECT_RESEARCHERS * (0.5 + node.computeIntensity));

  // Rising training efficiency means a unit of compute buys more capability.
  const efficiency = 0.55 + 0.9 * draft.world.aiFrontier.trainingEfficiency;
  const effectiveCompute = project.computeAllocated * efficiency;

  const coverage = company === undefined ? 0 : capabilityCoverage(company, node.talentRequirements);
  const headcountAdequacy = adequacy(project.talentAllocated, requiredResearchers, TALENT_FLOOR);

  return {
    funding: adequacy(project.budgetQuarterly, expectedQuarterlyCost, FUNDING_FLOOR),
    compute: adequacy(effectiveCompute, requiredCompute, COMPUTE_FLOOR),
    talent: headcountAdequacy * ((1 - CAPABILITY_COVERAGE_WEIGHT) + CAPABILITY_COVERAGE_WEIGHT * coverage),
    coverage,
    expectedQuarterlyCostUsd: expectedQuarterlyCost,
    requiredComputeUnits: requiredCompute,
    requiredResearchers,
  };
}

/** Probability that this quarter's run disappoints. */
export function setbackProbability(node: TechNode, factors: ResourcingFactors): number {
  const raw =
    SETBACK_BASE_PROBABILITY +
    SETBACK_TALENT_WEIGHT * (1 - unit(factors.talent)) +
    SETBACK_COMPUTE_WEIGHT * (1 - unit(factors.compute)) +
    SETBACK_NOVELTY_WEIGHT * node.novelty * (1 - node.plausibility);
  return clamp(raw, SETBACK_PROBABILITY_BOUNDS.min, SETBACK_PROBABILITY_BOUNDS.max);
}

/** Advance every active research programme. */
export function advanceProjects(draft: SessionState, ctx: ResolverContext): void {
  const rng = ctx.rng;

  for (const project of draft.researchProjects) {
    if (project.status !== 'active') continue;
    const node = findNode(draft, project.targetNodeId);
    if (node === undefined) continue;

    const factors = resourcingFactors(draft, project, node);
    const plannedRate = 1 / Math.max(1, project.expectedQuarters);
    const noise = rng.range(PROGRESS_NOISE_BAND.min, PROGRESS_NOISE_BAND.max);
    const delta = plannedRate * factors.funding * factors.compute * factors.talent * noise;

    const setbackOdds = setbackProbability(node, factors);
    const setback = rng.next() < setbackOdds;

    const before = project.progress;
    const visibility = projectVisibility(project);

    // The quarter's spend, cash plus an imputed charge for the compute the
    // programme consumed, so cost overruns read against the node's estimate.
    const imputedCompute = project.computeAllocated * IMPUTED_COMPUTE_COST_USD_PER_UNIT * draft.world.compute.reservedPrice;
    project.cumulativeSpendUsd = money(project.cumulativeSpendUsd + project.budgetQuarterly + imputedCompute);
    project.quartersElapsed = Math.min(200, project.quartersElapsed + 1);

    if (setback) {
      project.progress = unit(before - (before * SETBACK_PROGRESS_LOSS + SETBACK_PROGRESS_FLOOR_LOSS));
      project.setbacks += 1;
      project.expectedQuarters = Math.min(200, project.expectedQuarters + 1);
      project.internalConfidence = unit(project.internalConfidence * SETBACK_CONFIDENCE_FACTOR);
      const eventId = emitEvent(
        draft,
        ctx,
        'research_setback',
        project.companyId,
        project.targetNodeId,
        {
          projectId: project.id,
          nodeId: node.id,
          probability: setbackOdds,
          progressBefore: before,
          progressAfter: project.progress,
          setbacks: project.setbacks,
          expectedQuarters: project.expectedQuarters,
          internalConfidence: project.internalConfidence,
          isSecret: project.isSecret,
        },
        visibility,
      );
      if (!project.isSecret) {
        ctx.log({
          phase: 'research_resolution',
          text: `A run against ${node.title} disappointed; the programme slipped a quarter and internal confidence fell to ${(project.internalConfidence * 100).toFixed(0)}%.`,
          deltaLabel: `${((project.progress - before) * 100).toFixed(1)}pp`,
          refEventIds: [eventId],
          tone: 'negative',
          subjectId: project.companyId,
        });
      }
    } else {
      project.progress = unit(before + delta);
      const eventId = emitEvent(
        draft,
        ctx,
        'research_progress',
        project.companyId,
        project.targetNodeId,
        {
          projectId: project.id,
          nodeId: node.id,
          progressBefore: before,
          progressAfter: project.progress,
          delta: project.progress - before,
          fundingFactor: factors.funding,
          computeFactor: factors.compute,
          talentFactor: factors.talent,
          capabilityCoverage: factors.coverage,
          cumulativeSpendUsd: project.cumulativeSpendUsd,
          isSecret: project.isSecret,
        },
        visibility,
      );
      if (!project.isSecret && project.progress - before >= 0.01) {
        ctx.log({
          phase: 'research_resolution',
          text: `${node.title} advanced to ${(project.progress * 100).toFixed(0)}% on ${usdLabel(project.budgetQuarterly)} and ${project.talentAllocated} researchers.`,
          deltaLabel: `+${((project.progress - before) * 100).toFixed(1)}pp`,
          refEventIds: [eventId],
          tone: 'positive',
          subjectId: project.companyId,
        });
      }

      // Cost overrun is measured against the node's own high estimate, which is
      // an estimate and not the truth.
      const [, high] = node.researchCostRange;
      if (high > 0 && project.cumulativeSpendUsd > high && !project.isSecret) {
        const overrun = ratio(project.cumulativeSpendUsd - high, high);
        ctx.log({
          phase: 'research_resolution',
          text: `${node.title} has now consumed ${usdLabel(project.cumulativeSpendUsd)}, ${(overrun * 100).toFixed(0)}% above the high estimate for the programme.`,
          deltaLabel: `+${(overrun * 100).toFixed(0)}%`,
          refEventIds: [eventId],
          tone: 'warning',
          subjectId: project.companyId,
        });
      }
    }

    // Internal confidence follows the evidence, not the guidance. It is the
    // number that diverges from what the company says in public.
    const pace = clamp(ratio(project.progress - before, Math.max(1e-6, plannedRate), 0), -2, 2);
    const target = unit(
      0.12 +
        0.5 * project.progress +
        0.18 * unit((pace + 1) / 3) +
        0.15 * node.plausibility -
        0.04 * project.setbacks,
    );
    project.internalConfidence = unit(project.internalConfidence + (target - project.internalConfidence) * INTERNAL_CONFIDENCE_DRIFT);

    if (project.setbacks >= MAX_SETBACKS && project.progress < 0.5) {
      project.status = 'failed';
      const eventId = emitEvent(
        draft,
        ctx,
        'research_setback',
        project.companyId,
        project.targetNodeId,
        { projectId: project.id, nodeId: node.id, abandoned: true, setbacks: project.setbacks, progress: project.progress },
        visibility,
      );
      if (!project.isSecret) {
        ctx.log({
          phase: 'research_resolution',
          text: `The programme against ${node.title} was abandoned after ${project.setbacks} failed runs.`,
          deltaLabel: 'abandoned',
          refEventIds: [eventId],
          tone: 'negative',
          subjectId: project.companyId,
        });
      }
    }
  }
}
