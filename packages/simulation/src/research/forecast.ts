/**
 * @frontier/simulation — research/forecast.ts
 *
 * What a research programme takes, how long it runs and why it is slow —
 * answered once, by the engine, in the same arithmetic the resolver uses.
 *
 * The Frontier Map used to ask a founder to set three sliders against three
 * hidden adequacy factors and an unseen setback probability. Nothing on the
 * screen answered "how long is this, and what is holding it up". This module is
 * that answer, and it is deliberately the *only* one: `programmeForecast` runs
 * `resourcingFactors` and `setbackProbability` exactly as `advanceProjects`
 * does, so a screen that renders the forecast is quoting the engine rather than
 * modelling it a second time.
 *
 * Two things are pinned here on purpose.
 *
 * 1. **`plannedProgrammeQuarters` is shared with the resolver.** The quarters a
 *    programme is opened with (`resolver/routing.ts`) and the quarters a
 *    forecast promises are one function, so a preview cannot disagree with the
 *    programme it creates.
 * 2. **Effort presets are engine-owned.** Light / Standard / All-in are a
 *    deterministic map from a node and the company's free capacity to a
 *    `start_research_project` intent. Standard is the node's own requirement
 *    capped by what is actually free, which is exactly the validator's bound —
 *    so the standard preset is never clamped.
 *
 * Nothing here reads a clock or a random source, and nothing mutates the draft.
 */

import type { Company, ResearchProject, SessionState, TechNode } from '@frontier/contracts';
import { projectRequirements, resourcingFactors, setbackProbability, type ResourcingFactors } from './progress';
import { researchComputeHeadroom } from '../validator/context';
import { bottleneckOf, quartersAtPace, type ForecastFactors, type ResearchBottleneck } from './reading';
import { ratio, unit } from './util';

export { BOTTLENECK_NOUN, BOTTLENECK_TOLERANCE, MAX_FORECAST_QUARTERS, SETBACK_RISK_BANDS, bottleneckOf, quartersAtPace, setbackRiskBand } from './reading';
export type { ForecastFactors, ResearchBottleneck } from './reading';

/* -------------------------------------------------------------------------- */
/*  Constants                                                                  */
/* -------------------------------------------------------------------------- */

/** Quarters the Standard preset plans for. The budget is the cost midpoint over this many quarters. */
export const STANDARD_PROGRAMME_QUARTERS = 8;

/** How each effort preset scales the node's own requirement and its quarterly cost. */
export const EFFORT_MULTIPLE = { light: 0.5, standard: 1, all_in: 1.5 } as const;

/** The three efforts, in the order the screen offers them. */
export const RESEARCH_EFFORTS = ['light', 'standard', 'all_in'] as const;
export type ResearchEffort = (typeof RESEARCH_EFFORTS)[number];

/* -------------------------------------------------------------------------- */
/*  Planned quarters                                                           */
/* -------------------------------------------------------------------------- */

/**
 * The schedule a programme is opened on: the node's mid cost estimate divided
 * by the cash committed each quarter, held between 2 and 24 quarters.
 *
 * `resolver/routing.ts` calls this when it creates the programme, so a preview
 * and the programme it becomes cannot disagree. World 1's pinned hash depends on
 * this arithmetic being unchanged.
 */
export function plannedProgrammeQuarters(node: TechNode, budgetUsd: number): number {
  const [lowCost, highCost] = node.researchCostRange;
  const expectedCost = (lowCost + highCost) / 2;
  const quarterlyDraw = Math.max(1, budgetUsd);
  return Math.max(2, Math.min(24, Math.round(expectedCost / quarterlyDraw)));
}

/* -------------------------------------------------------------------------- */
/*  Free capacity and effort presets                                           */
/* -------------------------------------------------------------------------- */

/** What a company could still put on a new programme this quarter. */
export interface ResearchCapacity {
  /** Accelerator-equivalents not already on a programme. The validator's own bound. */
  readonly computeUnits: number;
  /** Researchers not already assigned to a programme. */
  readonly researchers: number;
}

/** Researchers a company already has on active or paused programmes. */
export function researchersOnProgrammes(draft: SessionState, companyId: string, exceptProjectId: string | null = null): number {
  let total = 0;
  for (const project of draft.researchProjects) {
    if (project.companyId !== companyId) continue;
    if (project.id === exceptProjectId) continue;
    if (project.status !== 'active' && project.status !== 'paused') continue;
    total += project.talentAllocated;
  }
  return total;
}

/**
 * The compute and the researchers a company could still commit.
 *
 * Compute comes from `researchComputeHeadroom` — the validator's figure, cloud
 * included from world version 2 — so a preset built from it is never clamped.
 */
export function researchCapacity(draft: SessionState, company: Company): ResearchCapacity {
  return {
    computeUnits: Math.max(0, Math.floor(researchComputeHeadroom(draft, company))),
    researchers: Math.max(0, company.employees.researchers - researchersOnProgrammes(draft, company.id)),
  };
}

/** The shape of the intent an effort preset produces. */
export interface ProgrammePlan {
  readonly budgetUsd: number;
  readonly computeUnits: number;
  readonly researchersAssigned: number;
}

/**
 * One effort preset, as figures.
 *
 * Standard is the node's requirement and the cost midpoint spread over
 * `STANDARD_PROGRAMME_QUARTERS`; Light is half of it and All-in is one and a
 * half times it. Compute and researchers are capped by what is free, so the
 * preset is always inside the validator's bounds; the budget is not capped by
 * cash, because from world version 2 cash notes a commitment rather than
 * refusing it.
 */
export function effortPlan(draft: SessionState, node: TechNode, effort: ResearchEffort, capacity: ResearchCapacity): ProgrammePlan {
  const requirement = projectRequirements(draft, node);
  const multiple = EFFORT_MULTIPLE[effort];
  const [lowCost, highCost] = node.researchCostRange;
  const midpoint = (lowCost + highCost) / 2;
  return {
    budgetUsd: Math.max(1, Math.round((midpoint / STANDARD_PROGRAMME_QUARTERS) * multiple)),
    computeUnits: Math.max(0, Math.min(capacity.computeUnits, Math.round(requirement.computeUnits * multiple))),
    researchersAssigned: Math.max(0, Math.min(capacity.researchers, Math.round(requirement.researchers * multiple))),
  };
}

/** The same preset as a `start_research_project` intent, ready to validate or queue. */
export function effortIntent(
  draft: SessionState,
  node: TechNode,
  effort: ResearchEffort,
  capacity: ResearchCapacity,
  secret: boolean,
): {
  readonly type: 'start_research_project';
  readonly targetNodeId: string;
  readonly budgetUsd: number;
  readonly computeUnits: number;
  readonly researchersAssigned: number;
  readonly secret: boolean;
} {
  const plan = effortPlan(draft, node, effort, capacity);
  return {
    type: 'start_research_project',
    targetNodeId: node.id,
    budgetUsd: plan.budgetUsd,
    computeUnits: plan.computeUnits,
    researchersAssigned: plan.researchersAssigned,
    secret,
  };
}

/* -------------------------------------------------------------------------- */
/*  Forecast                                                                   */
/* -------------------------------------------------------------------------- */

/** How far a programme is from what the node asks for, in the units the player set. */
export interface ResearchShortfall {
  readonly kind: ResearchBottleneck;
  /** What the programme has: dollars per quarter, accelerator-equivalents, or researchers. */
  readonly have: number;
  /** What the node wants, in the same unit. */
  readonly want: number;
  /**
   * True when the headcount is met and the gap is capability rather than bodies.
   * Only ever set on a `talent` shortfall.
   */
  readonly capabilityGap: boolean;
}

/** Everything the Frontier Map needs to say about a programme that has not started. */
export interface ProgrammeForecast {
  /** Quarters to demonstration at this resourcing, ignoring setbacks. Whole. */
  readonly expectedQuarters: number;
  /** Quarters the schedule was drawn on, before resourcing slowed or hurried it. */
  readonly plannedQuarters: number;
  readonly quarterlyCostUsd: number;
  readonly totalCostUsd: number;
  /** Probability that any one quarter's run disappoints, 0..1. */
  readonly setbackRisk: number;
  readonly factors: ForecastFactors;
  readonly bottleneck: ResearchBottleneck | null;
  readonly shortfall: ResearchShortfall | null;
}

/** The gap behind a bottleneck, stated in the unit the player set. */
function shortfallOf(
  bottleneck: ResearchBottleneck | null,
  plan: ProgrammePlan,
  factors: ResourcingFactors,
): ResearchShortfall | null {
  if (bottleneck === null) return null;
  if (bottleneck === 'funding') {
    return { kind: 'funding', have: Math.round(plan.budgetUsd), want: Math.round(factors.expectedQuarterlyCostUsd), capabilityGap: false };
  }
  if (bottleneck === 'compute') {
    return { kind: 'compute', have: Math.round(plan.computeUnits), want: Math.round(factors.requiredComputeUnits), capabilityGap: false };
  }
  const want = Math.round(factors.requiredResearchers);
  const have = Math.round(plan.researchersAssigned);
  return { kind: 'talent', have, want, capabilityGap: have >= want };
}

/** A probe programme: never stored, never resolved, only measured. */
function probeProject(companyId: string, node: TechNode, plan: ProgrammePlan, expectedQuarters: number): ResearchProject {
  return {
    id: 'rsp_forecast_probe',
    companyId,
    targetNodeId: node.id,
    budgetQuarterly: plan.budgetUsd,
    computeAllocated: plan.computeUnits,
    talentAllocated: plan.researchersAssigned,
    progress: 0,
    internalConfidence: 0.5,
    quartersElapsed: 0,
    expectedQuarters,
    isSecret: true,
    status: 'active',
    cumulativeSpendUsd: 0,
    setbacks: 0,
    startedQuarter: 0,
  };
}

/**
 * What a programme against `node` would cost, take and risk if `company` opened
 * it on `plan` this quarter.
 *
 * The factors are `resourcingFactors` and the risk is `setbackProbability`,
 * called with a probe programme carrying exactly the figures the intent does —
 * so the forecast is the engine's own arithmetic, not a second model of it.
 */
export function programmeForecast(draft: SessionState, company: Company, node: TechNode, plan: ProgrammePlan): ProgrammeForecast {
  const planned = plannedProgrammeQuarters(node, plan.budgetUsd);
  const factors = resourcingFactors(draft, probeProject(company.id, node, plan, planned), node);
  const shape: ForecastFactors = { funding: factors.funding, compute: factors.compute, talent: factors.talent };
  const pace = factors.funding * factors.compute * factors.talent;
  const expectedQuarters = quartersAtPace(1, 1 / Math.max(1, planned), pace);
  const quarterlyCostUsd = Math.round(Math.max(0, plan.budgetUsd));
  const bottleneck = bottleneckOf(shape);
  return {
    expectedQuarters,
    plannedQuarters: planned,
    quarterlyCostUsd,
    totalCostUsd: quarterlyCostUsd * expectedQuarters,
    setbackRisk: setbackProbability(node, factors),
    factors: shape,
    bottleneck,
    shortfall: shortfallOf(bottleneck, plan, factors),
  };
}

/* -------------------------------------------------------------------------- */
/*  A programme already running                                                */
/* -------------------------------------------------------------------------- */

/** Everything the Frontier Map needs to say about a programme that is under way. */
export interface RunningForecast {
  /** Fraction of the way to demonstration, 0..1. */
  readonly progress: number;
  /** Quarters left at the current pace, ignoring setbacks. Whole. */
  readonly quartersLeft: number;
  readonly quartersElapsed: number;
  /** Cash and imputed compute charged to the programme so far. */
  readonly spentUsd: number;
  readonly quarterlyCostUsd: number;
  readonly setbackRisk: number;
  readonly setbacks: number;
  readonly factors: ForecastFactors;
  readonly bottleneck: ResearchBottleneck | null;
  readonly shortfall: ResearchShortfall | null;
}

/**
 * The same reading for a programme already running: how far it has come, how
 * long the rest takes at the pace it is actually being given, and what is
 * holding it up.
 */
export function runningForecast(draft: SessionState, project: ResearchProject, node: TechNode): RunningForecast {
  const factors = resourcingFactors(draft, project, node);
  const shape: ForecastFactors = { funding: factors.funding, compute: factors.compute, talent: factors.talent };
  const pace = factors.funding * factors.compute * factors.talent;
  const remaining = Math.max(0, 1 - unit(project.progress));
  const bottleneck = bottleneckOf(shape);
  const plan: ProgrammePlan = {
    budgetUsd: project.budgetQuarterly,
    computeUnits: project.computeAllocated,
    researchersAssigned: project.talentAllocated,
  };
  return {
    progress: unit(project.progress),
    quartersLeft: remaining <= 0 ? 0 : quartersAtPace(remaining, 1 / Math.max(1, project.expectedQuarters), pace),
    quartersElapsed: project.quartersElapsed,
    spentUsd: Math.round(Math.max(0, project.cumulativeSpendUsd)),
    quarterlyCostUsd: Math.round(Math.max(0, project.budgetQuarterly)),
    setbackRisk: setbackProbability(node, factors),
    setbacks: project.setbacks,
    factors: shape,
    bottleneck,
    shortfall: shortfallOf(bottleneck, plan, factors),
  };
}

/**
 * The allocation that would clear a running programme's bottleneck: the node's
 * own requirement, capped by what is free once this programme's own commitment
 * is handed back.
 *
 * This is what the Frontier Map's "Fix" button pre-fills. It is the Standard
 * preset by construction, so an adjustment built from it validates unclamped.
 */
export function repairPlan(draft: SessionState, company: Company, project: ResearchProject, node: TechNode): ProgrammePlan {
  const capacity: ResearchCapacity = {
    computeUnits: Math.max(0, Math.floor(researchComputeHeadroom(draft, company)) + project.computeAllocated),
    researchers: Math.max(0, company.employees.researchers - researchersOnProgrammes(draft, company.id, project.id)),
  };
  const standard = effortPlan(draft, node, 'standard', capacity);
  // Money already committed is never taken away by a repair: the founder asked
  // to clear a shortfall, not to cut the budget.
  return { ...standard, budgetUsd: Math.max(standard.budgetUsd, Math.round(project.budgetQuarterly)) };
}

/* -------------------------------------------------------------------------- */
/*  Rivals                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * How far along the world's published programmes against a node are, most
 * advanced first.
 *
 * Secret programmes are absent, not redacted — `publicResearchProjects` is the
 * boundary and this reads through it — so "who else is close" can only ever name
 * work the world can actually see.
 */
export function rivalProgress(
  draft: SessionState,
  nodeId: string,
  exceptCompanyId: string,
): readonly { readonly companyId: string; readonly progress: number }[] {
  return draft.researchProjects
    .filter(
      (project) =>
        !project.isSecret &&
        project.targetNodeId === nodeId &&
        project.companyId !== exceptCompanyId &&
        (project.status === 'active' || project.status === 'paused'),
    )
    .map((project) => ({ companyId: project.companyId, progress: unit(project.progress) }))
    .sort((a, b) => (b.progress !== a.progress ? b.progress - a.progress : a.companyId < b.companyId ? -1 : 1));
}

/**
 * The world's confidence in a node as three words rather than a number.
 *
 * The thresholds are the belief system's own: `EMERGING_THRESHOLD` is where the
 * world starts treating a path as real, and the forecast prior sits at 0.5.
 */
export function publicVerdict(publicConfidence: number): 'likely' | 'unclear' | 'doubtful' {
  const value = unit(publicConfidence);
  if (value >= 0.6) return 'likely';
  if (value >= 0.3) return 'unclear';
  return 'doubtful';
}

/** Share of the node's mid cost estimate a programme has already consumed, 0..1+. */
export function spendAgainstEstimate(project: ResearchProject, node: TechNode): number {
  const [low, high] = node.researchCostRange;
  return Math.max(0, ratio(project.cumulativeSpendUsd, (low + high) / 2, 0));
}
