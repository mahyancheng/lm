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
 *       × dataFactor(petabytes held in the node's sector vs what it asks for)
 *       × noise
 * ```
 *
 * The data factor is exactly 1 below world version 3, where no node asks for
 * data and nothing collects any, so both frozen worlds run at the pace they
 * always have.
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
  WORLD2_PROJECT_COMPUTE_UNITS,
  WORLD2_PROJECT_RESEARCHERS,
} from './balance';
import { economicNodeById } from '@frontier/contracts';
import { isMultiSectorWorld, isNodeEconomyWorld } from '../economy/sectors';
import { dataAdequacy, dataPetabytesOf } from '../graph/data';
import { pauseIfUnheld } from './ownership';
import { BOTTLENECK_NOUN, bottleneckOf, quartersAtPace } from './reading';
import { capabilityCoverage, clamp, emitEvent, findCompany, findNode, money, projectVisibility, ratio, unit, usdLabel } from './util';

/** What a programme against one node wants each quarter to run at full speed. */
export interface ProjectRequirements {
  readonly computeUnits: number;
  readonly researchers: number;
}

/**
 * The compute and researchers a node wants, at this world's scale.
 *
 * World 1 reads the original bases so its pinned hash is untouched; world 2
 * reads the smaller ones. Exported because the Frontier Map's start form seeds
 * its sliders from it: a programme should open resourced to run, not at zero.
 */
export function projectRequirements(draft: SessionState, node: TechNode): ProjectRequirements {
  const multiSector = isMultiSectorWorld(draft);
  const computeBase = multiSector ? WORLD2_PROJECT_COMPUTE_UNITS : BASE_PROJECT_COMPUTE_UNITS;
  const researcherBase = multiSector ? WORLD2_PROJECT_RESEARCHERS : BASE_PROJECT_RESEARCHERS;
  return {
    computeUnits: Math.max(1, Math.round(computeBase * Math.max(0.05, node.computeIntensity))),
    researchers: Math.max(1, Math.round(researcherBase * (0.5 + node.computeIntensity))),
  };
}

/** The resourcing a programme received this quarter, each expressed 0..~1.2. */
export interface ResourcingFactors {
  readonly funding: number;
  readonly compute: number;
  readonly talent: number;
  /**
   * How well supplied with relevant customer data the programme is.
   *
   * Exactly 1 below world version 3, where no node asks for data and nothing
   * collects any — so the pace a world-1 or world-2 programme runs at is the
   * product it has always been.
   */
  readonly data: number;
  readonly coverage: number;
  readonly expectedQuarterlyCostUsd: number;
  readonly requiredComputeUnits: number;
  readonly requiredResearchers: number;
  /** Petabytes the node asks for. Zero below world 3, and for a node that needs none. */
  readonly requiredDataPb: number;
  /** Petabytes the company holds in this node's sector. */
  readonly availableDataPb: number;
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
  // World 1 keeps the unrounded figures its pinned hash was struck on; world 2
  // reads the scaled, whole-number requirements the start form shows.
  const multiSector = isMultiSectorWorld(draft);
  const scaled = projectRequirements(draft, node);
  const requiredCompute = multiSector ? scaled.computeUnits : Math.max(1, BASE_PROJECT_COMPUTE_UNITS * Math.max(0.05, node.computeIntensity));
  const requiredResearchers = multiSector ? scaled.researchers : Math.max(1, BASE_PROJECT_RESEARCHERS * (0.5 + node.computeIntensity));

  // Rising training efficiency means a unit of compute buys more capability.
  const efficiency = 0.55 + 0.9 * draft.world.aiFrontier.trainingEfficiency;
  const effectiveCompute = project.computeAllocated * efficiency;

  const coverage = company === undefined ? 0 : capabilityCoverage(company, node.talentRequirements);
  const headcountAdequacy = adequacy(project.talentAllocated, requiredResearchers, TALENT_FLOOR);

  // The fourth factor, world 3 only. A programme against a node that asks for
  // data is hostage to the data its company has actually collected, exactly as
  // it is hostage to the compute it can get hold of. Below world 3 no node asks
  // for any, so `requiredDataPb` is zero and the factor is exactly 1.
  const economicNode = isNodeEconomyWorld(draft) ? economicNodeById(node.id) : undefined;
  const requiredDataPb = economicNode?.dataRequiredPb ?? 0;
  const availableDataPb = company === undefined || economicNode === undefined ? 0 : dataPetabytesOf(company, economicNode.sector);

  return {
    funding: adequacy(project.budgetQuarterly, expectedQuarterlyCost, FUNDING_FLOOR),
    compute: adequacy(effectiveCompute, requiredCompute, COMPUTE_FLOOR),
    talent: headcountAdequacy * ((1 - CAPABILITY_COVERAGE_WEIGHT) + CAPABILITY_COVERAGE_WEIGHT * coverage),
    data: dataAdequacy(availableDataPb, requiredDataPb),
    coverage,
    expectedQuarterlyCostUsd: expectedQuarterlyCost,
    requiredComputeUnits: requiredCompute,
    requiredResearchers,
    requiredDataPb,
    availableDataPb,
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

    // World 3: a programme whose requirements the company no longer holds is
    // paused before a penny of this quarter's budget is spent, rather than
    // pinned at ninety-eight percent for ever. Draws no random number, so the
    // call sequence of every other programme is untouched.
    if (isNodeEconomyWorld(draft) && pauseIfUnheld(draft, ctx, project, node)) continue;

    const factors = resourcingFactors(draft, project, node);
    const plannedRate = 1 / Math.max(1, project.expectedQuarters);
    const noise = rng.range(PROGRESS_NOISE_BAND.min, PROGRESS_NOISE_BAND.max);
    const delta = plannedRate * factors.funding * factors.compute * factors.talent * factors.data * noise;

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
        // Plain words: what was lost, and the one thing that made it likelier.
        const lostPct = Math.round((before - project.progress) * 100);
        const short = bottleneckOf(factors);
        ctx.log({
          phase: 'research_resolution',
          text: `Setback on ${node.title}: ${lostPct}% of the progress so far was lost and the programme slipped a quarter${
            short === null ? '' : `; it was short of ${BOTTLENECK_NOUN[short]}`
          }.`,
          deltaLabel: `-${lostPct}%`,
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
        // What it is now, how long the rest takes at this pace, and the one
        // thing slowing it — the same three figures the Frontier Map shows.
        const donePct = Math.round(project.progress * 100);
        const left = quartersAtPace(1 - project.progress, plannedRate, factors.funding * factors.compute * factors.talent * factors.data);
        const short = bottleneckOf(factors);
        ctx.log({
          phase: 'research_resolution',
          text: `${node.title} is ${donePct}% done, about ${left} quarter${left === 1 ? '' : 's'} left at this pace${
            short === null ? '' : `; it is short of ${BOTTLENECK_NOUN[short]}`
          }.`,
          deltaLabel: `+${Math.round((project.progress - before) * 100)}%`,
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
          text: `${node.title} has cost ${usdLabel(project.cumulativeSpendUsd)} so far, ${Math.round(overrun * 100)}% more than the highest estimate for it.`,
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
          text: `The programme against ${node.title} was given up after ${project.setbacks} failed runs.`,
          deltaLabel: 'abandoned',
          refEventIds: [eventId],
          tone: 'negative',
          subjectId: project.companyId,
        });
      }
    }
  }
}
