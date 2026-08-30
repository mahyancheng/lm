/**
 * @frontier/simulation — research/balance.ts
 *
 * Balancing data for the Frontier Map: how fast a programme moves, how often a
 * run disappoints, how far belief drifts and what the engine will accept as a
 * player-invented technology.
 *
 * Defaults follow `docs/SIMULATION.md` §5 (truth versus belief) and
 * `docs/GAME_DESIGN.md` §7 (the Frontier Map is probabilistic, contested and
 * mutable). Everything here is a constant; nothing reads a clock or a random
 * source.
 */

import type { TechEpistemicState, WorldEventType } from '@frontier/contracts';

/* -------------------------------------------------------------------------- */
/*  Programme progress                                                         */
/* -------------------------------------------------------------------------- */

/** Accelerator-equivalents a programme of compute intensity 1.0 wants each quarter. */
export const BASE_PROJECT_COMPUTE_UNITS = 60_000;
/** Researchers a programme of compute intensity 1.0 wants. */
export const BASE_PROJECT_RESEARCHERS = 120;

/** Progress multiplier floor when a programme is entirely unfunded. */
export const FUNDING_FLOOR = 0.25;
/** Progress multiplier floor when a programme has no compute at all. */
export const COMPUTE_FLOOR = 0.2;
/** Progress multiplier floor when a programme has no researchers at all. */
export const TALENT_FLOOR = 0.15;
/** Extra progress available for over-resourcing, per input, above the required level. */
export const OVERSUPPLY_BONUS = 0.12;
/** How much of the talent factor comes from capability coverage rather than headcount. */
export const CAPABILITY_COVERAGE_WEIGHT = 0.6;

/** Random band applied to quarterly progress. Research is lumpy. */
export const PROGRESS_NOISE_BAND = { min: 0.78, max: 1.22 } as const;

/** Baseline probability that a quarter's run disappoints. */
export const SETBACK_BASE_PROBABILITY = 0.09;
/** Setback probability added by starving a programme of talent. */
export const SETBACK_TALENT_WEIGHT = 0.16;
/** Setback probability added by starving a programme of compute. */
export const SETBACK_COMPUTE_WEIGHT = 0.11;
/** Setback probability added by attempting something novel and poorly understood. */
export const SETBACK_NOVELTY_WEIGHT = 0.14;
/** Bounds on the per-quarter setback probability. */
export const SETBACK_PROBABILITY_BOUNDS = { min: 0.02, max: 0.5 } as const;
/** Share of accumulated progress a failed run destroys. */
export const SETBACK_PROGRESS_LOSS = 0.16;
/** Additional flat progress lost by a failed run. */
export const SETBACK_PROGRESS_FLOOR_LOSS = 0.015;
/** Multiplier applied to internal confidence after a failed run. */
export const SETBACK_CONFIDENCE_FACTOR = 0.84;
/** Setbacks after which a programme is abandoned as failed. */
export const MAX_SETBACKS = 6;

/** How fast internal confidence moves toward the evidence each quarter. */
export const INTERNAL_CONFIDENCE_DRIFT = 0.3;
/** Imputed dollar cost of one allocated accelerator-equivalent per quarter, for overrun reporting. */
export const IMPUTED_COMPUTE_COST_USD_PER_UNIT = 2_400;
/** Capability gained in each required area when a node is achieved, as a share of the gap to 1. */
export const CAPABILITY_GAIN_ON_ACHIEVEMENT = 0.22;
/** Confidence handed to a node this achievement unlocks, as a share of the gap to 1. */
export const UNLOCK_CONFIDENCE_GAIN = 0.25;
/** Hazard delta pushed into a matching event family when a node is achieved publicly. */
export const ACHIEVEMENT_HAZARD_DELTA = 0.06;
/** Quarters that hazard delta decays over. */
export const ACHIEVEMENT_HAZARD_DECAY_QUARTERS = 3;

/* -------------------------------------------------------------------------- */
/*  Belief                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Where public confidence in a node sits when nothing else is happening. Belief
 * drifts toward the prior for its epistemic state, which is what makes a
 * `speculative` node decay quietly if nobody produces evidence for it.
 */
export const STATUS_CONFIDENCE_PRIOR = {
  established: 0.95,
  emerging: 0.7,
  forecast: 0.5,
  speculative: 0.25,
  company_thesis: 0.3,
  secret: 0.3,
  discredited: 0.08,
  achieved: 1,
  dead_end: 0.03,
} as const satisfies Record<TechEpistemicState, number>;

/** How far confidence moves toward its status prior each quarter. */
export const CONFIDENCE_DRIFT = 0.06;
/** Seeded jitter applied to public confidence each quarter. */
export const CONFIDENCE_NOISE = 0.008;

/** Confidence at or below which a live node becomes discredited. */
export const DISCREDIT_THRESHOLD = 0.08;
/** Confidence at or below which a discredited node becomes a dead end. */
export const DEAD_END_THRESHOLD = 0.03;
/** Confidence at or above which a forecast or speculative node becomes emerging. */
export const EMERGING_THRESHOLD = 0.85;
/** Confidence at or above which an emerging node becomes established. */
export const ESTABLISHED_THRESHOLD = 0.95;
/** Confidence movement below which nothing is recorded. */
export const CONFIDENCE_REPORT_FLOOR = 0.005;
/** Confidence movement above which the movement earns a line in the quarter report. */
export const CONFIDENCE_LINE_FLOOR = 0.04;
/** Confidence movement above which the expected arrival window shifts by a year. */
export const WINDOW_SHIFT_THRESHOLD = 0.08;

/** How a world event moves belief in the nodes it touches. */
export interface EventBeliefEffect {
  /** Confidence delta at severity 1.0, before the compute-intensity weighting. */
  readonly delta: number;
  /**
   * How much the node's own compute intensity amplifies the effect. 0 means the
   * event moves every node equally; 1 means only compute-hungry programmes care.
   */
  readonly computeIntensityWeight: number;
}

/**
 * Event-to-belief table. A shock to the price of compute does not make sparse
 * inference less likely to work — it makes the expensive dense path less likely
 * to be taken, which is exactly what the compute-intensity weighting encodes.
 */
export const EVENT_BELIEF_EFFECTS: Partial<Record<WorldEventType, EventBeliefEffect>> = {
  model_breakthrough: { delta: 0.06, computeIntensityWeight: 0.2 },
  research_disappointment: { delta: -0.07, computeIntensityWeight: 0.2 },
  benchmark_result: { delta: 0.025, computeIntensityWeight: 0.1 },
  open_source_release: { delta: 0.03, computeIntensityWeight: 0 },
  compute_supply_shock: { delta: -0.045, computeIntensityWeight: 0.8 },
  compute_demand_shock: { delta: -0.03, computeIntensityWeight: 0.7 },
  energy_price_shock: { delta: -0.035, computeIntensityWeight: 0.9 },
  grid_constraint: { delta: -0.025, computeIntensityWeight: 0.9 },
  fab_disruption: { delta: -0.04, computeIntensityWeight: 0.85 },
  export_control: { delta: -0.03, computeIntensityWeight: 0.6 },
  regulatory_action: { delta: -0.025, computeIntensityWeight: 0.2 },
  safety_incident: { delta: -0.03, computeIntensityWeight: 0.1 },
  data_licensing_shift: { delta: -0.02, computeIntensityWeight: 0.15 },
  talent_shock: { delta: -0.02, computeIntensityWeight: 0.3 },
};

/* -------------------------------------------------------------------------- */
/*  Publication                                                                */
/* -------------------------------------------------------------------------- */

/** Reputation and belief consequences of each way of making a result public. */
export const PUBLICATION_EFFECTS = {
  paper: { developer: 6, public: 2, investor: 1, government: 0, revealsMethod: true, fullReveal: true },
  open_weights: { developer: 11, public: 4, investor: -2, government: -1, revealsMethod: true, fullReveal: true },
  product_demonstration: { developer: 3, public: 6, investor: 5, government: 2, revealsMethod: false, fullReveal: true },
  closed_briefing: { developer: 0, public: 0, investor: 3, government: 5, revealsMethod: false, fullReveal: false },
  leak: { developer: 1, public: -2, investor: -3, government: -2, revealsMethod: true, fullReveal: true },
} as const;

/** Public confidence a closed briefing buys, as a share of the gap to certainty. */
export const CLOSED_BRIEFING_CONFIDENCE_GAIN = 0.2;

/* -------------------------------------------------------------------------- */
/*  Innovation proposals                                                       */
/* -------------------------------------------------------------------------- */

/** Weight given to the proposer's own plausibility claim, against the engine's assessment. */
export const CLAIMED_PLAUSIBILITY_WEIGHT = 0.45;
/** Engine-assessed plausibility below which a proposal is refused outright. */
export const MIN_ACCEPTABLE_PLAUSIBILITY = 0.12;
/** Floor the engine puts under any programme's total cost, in dollars. */
export const INNOVATION_COST_FLOOR_USD = 25_000_000;
/** How much novelty multiplies the engine's cost floor. */
export const INNOVATION_NOVELTY_COST_MULTIPLE = 2.4;
/** Multiple of a company's reachable capital above which a proposal is refused as fantasy. */
export const INNOVATION_AFFORDABILITY_MULTIPLE = 25;
/** Quarters of revenue counted as reachable capital alongside cash. */
export const INNOVATION_REVENUE_REACH_QUARTERS = 4;
/** How much novelty stretches the proposer's own schedule estimate. */
export const INNOVATION_SCHEDULE_STRETCH = 1;
/** Confidence the proposing company starts with in its own thesis. */
export const INNOVATION_INTERNAL_CONFIDENCE = { base: 0.35, plausibilityWeight: 0.4 } as const;
/** Public confidence a publicly announced thesis starts with. */
export const INNOVATION_PUBLIC_CONFIDENCE = { base: 0.05, plausibilityWeight: 0.3, noveltyPenalty: 0.5 } as const;
/** Public confidence a private thesis carries: the world does not know it exists. */
export const INNOVATION_PRIVATE_PUBLIC_CONFIDENCE = 0.02;
/** Strength of the dependency edges a new node hangs from. */
export const INNOVATION_DEPENDENCY_EDGE_STRENGTH = 0.6;
/** Width of the cost range the engine puts around its own estimate. */
export const INNOVATION_COST_RANGE = { low: 0.7, high: 1.9 } as const;
