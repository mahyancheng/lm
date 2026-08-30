/**
 * @frontier/simulation — government/programmes.ts
 *
 * The programme catalogue: the templates from which opportunities are drawn,
 * and the deterministic rules that turn a template plus an agency plus the
 * world into a concrete `ProcurementOpportunity`.
 *
 * Two design rules from `docs/GOVERNMENT.md` are mechanical here:
 *
 * 1. **Agency priorities bias the published evaluation weights.** Understanding
 *    an agency's priorities changes how you should bid, and understanding them
 *    is exactly what a well-connected founder gets from a meeting. The weights
 *    still sum to 1.0 within 1e-6, because `EvaluationWeightsSchema` refuses to
 *    parse otherwise.
 * 2. **Requirements are hard gates scaled to the programme.** A $2.4bn
 *    sovereign platform demands Level IV clearance, domestic inference, an
 *    independent audit, four nines of availability and a past-performance floor
 *    that genuinely locks new entrants out. A civic modernisation programme does
 *    not.
 */

import type {
  Agency,
  AgencyPriority,
  ClearanceLevel,
  ContractForm,
  EvaluationWeights,
  OpportunityRequirements,
  WorldState,
} from '@frontier/contracts';
import { DEFAULT_EVALUATION_WEIGHTS } from '@frontier/contracts';
import { clamp, round, unit } from './util';

/* -------------------------------------------------------------------------- */
/*  Templates                                                                  */
/* -------------------------------------------------------------------------- */

export const PROGRAMME_KINDS = [
  'sovereign_platform',
  'intelligence_analytics',
  'logistics_autonomy',
  'civil_modernisation',
  'secure_infrastructure',
  'research_partnership',
] as const;
export type ProgrammeKind = (typeof PROGRAMME_KINDS)[number];

/** Which world variable expresses appetite for this kind of programme. */
export type DemandSignal = 'defenceUrgency' | 'digitalModernisation' | 'grantFunding' | 'procurementBudget';

export type WeightAxis = keyof EvaluationWeights;

export interface ProgrammeTemplate {
  readonly id: string;
  readonly kind: ProgrammeKind;
  /** Programme name, used verbatim on the opportunity. */
  readonly label: string;
  readonly description: string;
  /** Agency jurisdictions that run this kind of programme. */
  readonly jurisdictions: readonly Agency['jurisdiction'][];
  readonly contractForm: ContractForm;
  /** Term of the resulting contract. */
  readonly durationQuarters: number;
  /** Quarters the competition stays open for bids. */
  readonly biddingQuarters: number;
  /** Ceiling value as a share of the agency's quarterly procurement budget. */
  readonly budgetShare: number;
  /** Per-quarter opening probability at full demand and an empty pipeline. */
  readonly openRate: number;
  readonly demandSignal: DemandSignal;
  /** Additive nudges to the published weights, before renormalisation. */
  readonly weightBias: Partial<Record<WeightAxis, number>>;
  readonly clearanceLevel: ClearanceLevel;
  /** Base past-performance floor before scaling by programme size. */
  readonly basePastPerformance: number;
  readonly uptimePct: number;
  readonly sovereign: boolean;
  readonly visibility: 'public' | 'invited' | 'classified';
  readonly allowsConsortium: boolean;
}

/**
 * Six programme families. Deliberately few and strongly differentiated: the
 * interesting variety comes from which agency runs one, what the world looks
 * like when it opens, and who bids.
 */
export const PROGRAMME_TEMPLATES: readonly ProgrammeTemplate[] = [
  {
    id: 'prg_sovereign_platform',
    kind: 'sovereign_platform',
    label: 'Sovereign Intelligence Platform',
    description:
      'A sovereign-controlled reasoning and analysis platform operated entirely on domestic infrastructure, with full model audit and assured availability.',
    jurisdictions: ['defence', 'intelligence'],
    contractForm: 'cost_plus',
    durationQuarters: 20,
    biddingQuarters: 2,
    budgetShare: 0.04,
    openRate: 0.34,
    demandSignal: 'defenceUrgency',
    weightBias: { technical: 0.04, security: 0.06, priceRealism: -0.04, domesticSupply: 0.02 },
    clearanceLevel: 'level_iv',
    basePastPerformance: 55,
    uptimePct: 99.99,
    sovereign: true,
    visibility: 'public',
    allowsConsortium: true,
  },
  {
    id: 'prg_intelligence_analytics',
    kind: 'intelligence_analytics',
    label: 'All-Source Analytic Augmentation',
    description:
      'Assisted analysis across classified all-source collection, with strict provenance, evaluation and incident reporting obligations.',
    jurisdictions: ['intelligence'],
    contractForm: 'cost_plus',
    durationQuarters: 16,
    biddingQuarters: 2,
    budgetShare: 0.025,
    openRate: 0.22,
    demandSignal: 'defenceUrgency',
    weightBias: { security: 0.08, responsibleAi: 0.03, schedule: -0.03, domesticSupply: 0.02 },
    clearanceLevel: 'level_iv',
    basePastPerformance: 60,
    uptimePct: 99.95,
    sovereign: true,
    visibility: 'classified',
    allowsConsortium: false,
  },
  {
    id: 'prg_logistics_autonomy',
    kind: 'logistics_autonomy',
    label: 'Contested Logistics Autonomy',
    description:
      'Autonomous planning and routing for contested logistics, delivered against a schedule the programme office regards as non-negotiable.',
    jurisdictions: ['defence', 'allied_foreign'],
    contractForm: 'fixed_price',
    durationQuarters: 12,
    biddingQuarters: 1,
    budgetShare: 0.018,
    openRate: 0.26,
    demandSignal: 'defenceUrgency',
    weightBias: { schedule: 0.07, technical: 0.02, pastPerformance: -0.02, security: 0.02 },
    clearanceLevel: 'level_ii',
    basePastPerformance: 45,
    uptimePct: 99.5,
    sovereign: false,
    visibility: 'public',
    allowsConsortium: true,
  },
  {
    id: 'prg_civil_modernisation',
    kind: 'civil_modernisation',
    label: 'National Civic Services Modernisation',
    description:
      'Replace the legacy citizen benefits and licensing stack with an assisted-service platform. Heavily scrutinised on cost and accessibility, lightly scrutinised on capability.',
    jurisdictions: ['federal_civil', 'state_regional', 'supranational'],
    contractForm: 'fixed_price',
    durationQuarters: 12,
    biddingQuarters: 3,
    budgetShare: 0.06,
    openRate: 0.4,
    demandSignal: 'digitalModernisation',
    weightBias: { priceRealism: 0.1, technical: -0.05, pastPerformance: 0.02, responsibleAi: 0.01 },
    clearanceLevel: 'level_ii',
    basePastPerformance: 40,
    uptimePct: 99.9,
    sovereign: false,
    visibility: 'public',
    allowsConsortium: true,
  },
  {
    id: 'prg_secure_infrastructure',
    kind: 'secure_infrastructure',
    label: 'Assured Compute Enclave',
    description: 'Segregated, domestically operated compute and serving capacity for classified and export-restricted workloads.',
    jurisdictions: ['defence', 'federal_civil', 'intelligence'],
    contractForm: 'cost_plus',
    durationQuarters: 16,
    biddingQuarters: 2,
    budgetShare: 0.03,
    openRate: 0.24,
    demandSignal: 'procurementBudget',
    weightBias: { security: 0.05, domesticSupply: 0.06, technical: -0.03, responsibleAi: -0.01 },
    clearanceLevel: 'level_iii',
    basePastPerformance: 50,
    uptimePct: 99.99,
    sovereign: true,
    visibility: 'invited',
    allowsConsortium: true,
  },
  {
    id: 'prg_research_partnership',
    kind: 'research_partnership',
    label: 'Public Frontier Research Partnership',
    description: 'Co-funded frontier research with publication obligations, shared evaluation infrastructure and government use rights.',
    jurisdictions: ['federal_civil', 'supranational'],
    contractForm: 'cost_plus',
    durationQuarters: 8,
    biddingQuarters: 2,
    budgetShare: 0.012,
    openRate: 0.3,
    demandSignal: 'grantFunding',
    weightBias: { technical: 0.08, responsibleAi: 0.05, pastPerformance: -0.06, security: -0.05 },
    clearanceLevel: 'none',
    basePastPerformance: 25,
    uptimePct: 99,
    sovereign: false,
    visibility: 'public',
    allowsConsortium: true,
  },
];

export function templateById(id: string): ProgrammeTemplate | null {
  return PROGRAMME_TEMPLATES.find((t) => t.id === id) ?? null;
}

/** Templates an agency could plausibly run, in catalogue order. */
export function templatesForAgency(agency: Agency): ProgrammeTemplate[] {
  return PROGRAMME_TEMPLATES.filter((t) => t.jurisdictions.includes(agency.jurisdiction));
}

/** How badly the world wants this kind of programme right now, 0..1. */
export function programmeDemand(template: ProgrammeTemplate, world: WorldState): number {
  const signal = world.government[template.demandSignal];
  const budget = world.government.procurementBudget;
  const competition = world.geopolitics.techCompetition;
  const sovereignPull = template.sovereign ? 0.25 * competition + 0.15 * world.regulation.exportControls : 0.05 * world.society.aiTrust;
  return unit(0.55 * signal + 0.25 * budget + sovereignPull);
}

/* -------------------------------------------------------------------------- */
/*  Evaluation weights                                                         */
/* -------------------------------------------------------------------------- */

/** How each standing agency priority tilts the published weights. */
export const PRIORITY_WEIGHT_BIAS: Record<AgencyPriority, Partial<Record<WeightAxis, number>>> = {
  national_security: { security: 0.07, domesticSupply: 0.02, priceRealism: -0.04 },
  cost_efficiency: { priceRealism: 0.1, technical: -0.04, schedule: 0.01 },
  domestic_industry: { domesticSupply: 0.09, priceRealism: -0.02 },
  responsible_ai: { responsibleAi: 0.09, technical: -0.02 },
  speed_of_delivery: { schedule: 0.08, pastPerformance: -0.02 },
  vendor_diversity: { pastPerformance: -0.07, technical: 0.03 },
  data_sovereignty: { security: 0.05, domesticSupply: 0.04, priceRealism: -0.02 },
  workforce_modernisation: { schedule: 0.03, technical: 0.02, responsibleAi: 0.01 },
};

const WEIGHT_AXES: readonly WeightAxis[] = ['technical', 'security', 'pastPerformance', 'priceRealism', 'schedule', 'domesticSupply', 'responsibleAi'];

/** No axis may be scored out of existence; every dimension keeps some weight. */
export const MIN_AXIS_WEIGHT = 0.02;

/**
 * Published evaluation weights for one opportunity: the default weighting,
 * tilted by the template and by the agency's priorities in order of importance,
 * then renormalised to sum to exactly 1.
 */
export function evaluationWeightsFor(template: ProgrammeTemplate, agency: Agency): EvaluationWeights {
  const raw: Record<WeightAxis, number> = { ...DEFAULT_EVALUATION_WEIGHTS };

  for (const axis of WEIGHT_AXES) {
    raw[axis] += template.weightBias[axis] ?? 0;
  }
  agency.priorities.forEach((priority, index) => {
    const bias = PRIORITY_WEIGHT_BIAS[priority];
    const attenuation = 1 / (1 + index);
    for (const axis of WEIGHT_AXES) {
      raw[axis] += (bias[axis] ?? 0) * attenuation;
    }
  });

  for (const axis of WEIGHT_AXES) {
    raw[axis] = Math.max(MIN_AXIS_WEIGHT, raw[axis]);
  }

  let total = 0;
  for (const axis of WEIGHT_AXES) total += raw[axis];

  const normalised: Record<WeightAxis, number> = { ...raw };
  let heaviest: WeightAxis = 'technical';
  let running = 0;
  for (const axis of WEIGHT_AXES) {
    normalised[axis] = round(raw[axis] / total, 4);
    if (normalised[axis] > normalised[heaviest]) heaviest = axis;
  }
  for (const axis of WEIGHT_AXES) {
    if (axis !== heaviest) running += normalised[axis];
  }
  // The heaviest axis absorbs the rounding residual, so the seven values sum to
  // exactly 1 and `EvaluationWeightsSchema` parses.
  normalised[heaviest] = round(1 - running, 6);

  return {
    technical: normalised.technical,
    security: normalised.security,
    pastPerformance: normalised.pastPerformance,
    priceRealism: normalised.priceRealism,
    schedule: normalised.schedule,
    domesticSupply: normalised.domesticSupply,
    responsibleAi: normalised.responsibleAi,
  };
}

/* -------------------------------------------------------------------------- */
/*  Requirements                                                               */
/* -------------------------------------------------------------------------- */

/** Cleared staff a programme at each clearance level demands before it will score a bid. */
export const CLEARANCE_STAFF_REQUIREMENT: Record<ClearanceLevel, number> = {
  none: 0,
  level_i: 4,
  level_ii: 12,
  level_iii: 35,
  level_iv: 80,
};

/** Relative cost and difficulty of holding each clearance level. */
export const CLEARANCE_BURDEN: Record<ClearanceLevel, number> = {
  none: 0,
  level_i: 0.15,
  level_ii: 0.3,
  level_iii: 0.6,
  level_iv: 1,
};

/**
 * Hard gates for one opportunity, scaled to the programme's kind and size.
 *
 * `sizeShare` is the ceiling value as a fraction of the agency's quarterly
 * budget: the larger the programme relative to what the agency buys, the higher
 * the past-performance floor, which is what keeps a first-quarter founder out of
 * a sovereign platform competition.
 */
export function requirementsFor(template: ProgrammeTemplate, agency: Agency, world: WorldState, sizeShare: number): OpportunityRequirements {
  const scrutiny = unit(0.5 * world.regulation.safetyObligations + 0.3 * world.regulation.modelRules + 0.2 * world.media.controversyIntensity);
  const sovereignty = template.sovereign || world.geopolitics.techCompetition > 0.6 || world.regulation.exportControls > 0.65;
  const minimumPastPerformance = clamp(
    template.basePastPerformance + 22 * clamp(sizeShare, 0, 1.5) + (agency.clearanceAuthority ? 4 : 0) - (agency.priorities.includes('vendor_diversity') ? 8 : 0),
    0,
    95,
  );

  return {
    clearanceLevel: template.clearanceLevel,
    domesticInference: sovereignty,
    modelAudit: template.sovereign || scrutiny > 0.35 || agency.priorities.includes('responsible_ai'),
    uptimePct: template.uptimePct,
    dataSovereignty: sovereignty || agency.priorities.includes('data_sovereignty'),
    minimumPastPerformance: round(minimumPastPerformance, 2),
  };
}

/**
 * The availability commitment an uptime target implies, expressed on the bid's
 * 0..1 `reliabilityCommitment` scale. 99.99% is four nines and demands 0.75;
 * 99% is two nines and demands 0.25.
 */
export function requiredReliability(uptimePct: number): number {
  const unavailable = Math.max(1e-6, 1 - clamp(uptimePct, 90, 99.9999) / 100);
  const nines = -Math.log10(unavailable);
  return unit((nines - 1) / 4);
}
