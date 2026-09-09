/**
 * @frontier/simulation — companies/archetypes.ts
 *
 * Deterministic archetype behaviour for companies nobody is thinking about.
 *
 * `docs/ECONOMY.md` §1: hundreds of background companies must live in the
 * economy without hundreds of model calls per quarter. A `background` company
 * and a `significant` company that received no `NpcActionBundle` this quarter
 * both fall back to the policy tables here: a spending posture, a pricing nudge
 * and a hiring stance, chosen by archetype and posture and applied identically
 * on every replay.
 *
 * Everything in this module is data. `applyNpcDefaults` reads it, synthesises
 * ordinary `ActionIntent`s from it and pushes them through exactly the same
 * validation and resolution path a player's actions take — a background company
 * has no private mechanics of its own.
 *
 * The last section is the second half of that answer: the chief executive's
 * five stable traits turn the dials of these same tables, so a rival that never
 * gets a model call this quarter still behaves like the person running it.
 */

import type { CompBand, CompanyArchetype, CompanyPosture, StableTraits, StaffRole } from '@frontier/contracts';

/** The spending and pricing policy one archetype runs by default. */
export interface ArchetypePolicy {
  /** Posture a company of this archetype falls back to when nothing else applies. */
  readonly defaultPosture: CompanyPosture;
  /** Marketing spend as a share of last quarter's revenue. */
  readonly marketingRevenueShare: number;
  /** Research and development envelope as a share of last quarter's revenue. */
  readonly rdRevenueShare: number;
  /** Headcount growth targeted per quarter, before posture adjustment. */
  readonly headcountGrowthPerQuarter: number;
  /** Which roles this archetype recruits into, in priority order. */
  readonly hiringPriority: readonly StaffRole[];
  /** Compensation band this archetype habitually offers. */
  readonly compBand: CompBand;
  /** Share of held compute this archetype points at training rather than serving. */
  readonly trainingAllocation: number;
  /** Quarterly price drift this archetype applies to its own products, as a fraction. */
  readonly pricingNudge: number;
  /**
   * How much this archetype wants public revenue, 0..1. A defence supplier bids
   * on everything it is allowed to; a consumer company barely notices that
   * procurement exists.
   */
  readonly governmentAppetite: number;
}

/**
 * Archetype policy table. The numbers describe how these companies *behave*,
 * not how well they do: an `enterprise_ai` company that spends 14% of revenue on
 * marketing can still lose to a better product.
 */
export const ARCHETYPE_POLICIES = {
  frontier_lab: {
    defaultPosture: 'research_first',
    marketingRevenueShare: 0.06,
    rdRevenueShare: 0.45,
    headcountGrowthPerQuarter: 0.05,
    hiringPriority: ['researchers', 'engineers', 'ops'],
    compBand: 'top_of_market',
    trainingAllocation: 0.62,
    pricingNudge: 0.01,
    governmentAppetite: 0.25,
  },
  enterprise_ai: {
    defaultPosture: 'balanced',
    marketingRevenueShare: 0.14,
    rdRevenueShare: 0.22,
    headcountGrowthPerQuarter: 0.04,
    hiringPriority: ['sales', 'engineers', 'ops'],
    compBand: 'market',
    trainingAllocation: 0.24,
    pricingNudge: 0.015,
    governmentAppetite: 0.5,
  },
  consumer_ai: {
    defaultPosture: 'aggressive_growth',
    marketingRevenueShare: 0.24,
    rdRevenueShare: 0.18,
    headcountGrowthPerQuarter: 0.045,
    hiringPriority: ['engineers', 'ops', 'sales'],
    compBand: 'market',
    trainingAllocation: 0.28,
    pricingNudge: -0.02,
    governmentAppetite: 0.05,
  },
  infrastructure: {
    defaultPosture: 'efficiency',
    marketingRevenueShare: 0.04,
    rdRevenueShare: 0.12,
    headcountGrowthPerQuarter: 0.02,
    hiringPriority: ['ops', 'engineers', 'sales'],
    compBand: 'market',
    trainingAllocation: 0.12,
    pricingNudge: 0.01,
    governmentAppetite: 0.45,
  },
  chip_maker: {
    defaultPosture: 'balanced',
    marketingRevenueShare: 0.03,
    rdRevenueShare: 0.28,
    headcountGrowthPerQuarter: 0.025,
    hiringPriority: ['engineers', 'ops', 'sales'],
    compBand: 'above_market',
    trainingAllocation: 0.18,
    pricingNudge: 0.02,
    governmentAppetite: 0.2,
  },
  cloud: {
    defaultPosture: 'land_grab',
    marketingRevenueShare: 0.07,
    rdRevenueShare: 0.14,
    headcountGrowthPerQuarter: 0.03,
    hiringPriority: ['ops', 'sales', 'engineers'],
    compBand: 'market',
    trainingAllocation: 0.1,
    pricingNudge: -0.015,
    governmentAppetite: 0.3,
  },
  data: {
    defaultPosture: 'research_first',
    marketingRevenueShare: 0.08,
    rdRevenueShare: 0.34,
    headcountGrowthPerQuarter: 0.035,
    hiringPriority: ['researchers', 'engineers', 'sales'],
    compBand: 'above_market',
    trainingAllocation: 0.34,
    pricingNudge: 0.005,
    governmentAppetite: 0.35,
  },
  defence_ai: {
    defaultPosture: 'defensive',
    marketingRevenueShare: 0.05,
    rdRevenueShare: 0.24,
    headcountGrowthPerQuarter: 0.02,
    hiringPriority: ['engineers', 'ops', 'sales'],
    compBand: 'above_market',
    trainingAllocation: 0.22,
    pricingNudge: 0.01,
    governmentAppetite: 0.9,
  },
} as const satisfies Record<CompanyArchetype, ArchetypePolicy>;

/** How a posture bends the archetype's default policy. */
export interface PostureAdjustment {
  /** Multiplier on the marketing share of revenue. */
  readonly marketingFactor: number;
  /** Multiplier on the research and development share of revenue. */
  readonly rdFactor: number;
  /** Multiplier on targeted headcount growth. Negative values mean redundancies. */
  readonly headcountFactor: number;
  /** Additional price drift on top of the archetype's own nudge. */
  readonly pricingNudge: number;
  /** Compensation band override, or null to keep the archetype's habit. */
  readonly compBand: CompBand | null;
}

/**
 * Posture table. `survival` is what a company that could not pay its bills is
 * moved to by the financial phase, which is why it cuts everything at once.
 */
export const POSTURE_ADJUSTMENTS = {
  aggressive_growth: { marketingFactor: 1.5, rdFactor: 1.2, headcountFactor: 1.8, pricingNudge: -0.01, compBand: 'above_market' },
  balanced: { marketingFactor: 1, rdFactor: 1, headcountFactor: 1, pricingNudge: 0, compBand: null },
  efficiency: { marketingFactor: 0.65, rdFactor: 0.8, headcountFactor: 0.3, pricingNudge: 0.02, compBand: 'market' },
  research_first: { marketingFactor: 0.7, rdFactor: 1.25, headcountFactor: 0.9, pricingNudge: 0.005, compBand: 'top_of_market' },
  land_grab: { marketingFactor: 1.75, rdFactor: 0.9, headcountFactor: 1.5, pricingNudge: -0.045, compBand: 'above_market' },
  consolidation: { marketingFactor: 0.9, rdFactor: 0.85, headcountFactor: 0.5, pricingNudge: 0.015, compBand: 'market' },
  defensive: { marketingFactor: 0.85, rdFactor: 0.95, headcountFactor: 0.2, pricingNudge: 0.005, compBand: 'market' },
  survival: { marketingFactor: 0.3, rdFactor: 0.45, headcountFactor: -0.6, pricingNudge: 0.035, compBand: 'below_market' },
} as const satisfies Record<CompanyPosture, PostureAdjustment>;

/** Below this headcount an archetype default will not bother opening a requisition. */
export const NPC_MIN_HIRE_COUNT = 1;
/** Largest number of roles a single archetype-default hire action will open. */
export const NPC_MAX_HIRE_COUNT = 400;
/** Largest fraction of a role an archetype default will cut in one quarter. */
export const NPC_MAX_LAYOFF_FRACTION = 0.18;
/** Price nudges smaller than this are not worth an action. */
export const NPC_MIN_PRICE_MOVE = 0.002;
/** Quarters of runway below which an archetype default switches to survival behaviour. */
export const NPC_SURVIVAL_RUNWAY_QUARTERS = 3;
/** Government appetite below which an archetype default does not bid on public work. */
export const NPC_BID_APPETITE_FLOOR = 0.3;
/** What an archetype default bids, as a share of the programme's ceiling value. */
export const NPC_BID_PRICE_SHARE = 0.85;
/**
 * Availability commitment an archetype default offers. Above the 0.75 that four
 * nines demands, so a default bid is never disqualified on reliability alone,
 * and low enough that the claim is not absurd.
 */
export const NPC_BID_RELIABILITY = 0.8;
/** Share of its uncommitted technical staff an archetype default puts on a bid. */
export const NPC_BID_STAFF_SHARE = 0.12;
/** Share of its held capacity an archetype default commits to a programme. */
export const NPC_BID_COMPUTE_SHARE = 0.1;

/** The effective policy for one company, after its posture is applied. */
export interface EffectivePolicy {
  readonly marketingRevenueShare: number;
  readonly rdRevenueShare: number;
  readonly headcountGrowthPerQuarter: number;
  readonly hiringPriority: readonly StaffRole[];
  readonly compBand: CompBand;
  readonly trainingAllocation: number;
  readonly pricingNudge: number;
  readonly governmentAppetite: number;
}

/**
 * Combine an archetype policy with a posture adjustment. Pure; the same
 * archetype and posture always produce the same policy.
 */
export function effectivePolicy(archetype: CompanyArchetype, posture: CompanyPosture): EffectivePolicy {
  const base = ARCHETYPE_POLICIES[archetype];
  const adj = POSTURE_ADJUSTMENTS[posture];
  return {
    marketingRevenueShare: base.marketingRevenueShare * adj.marketingFactor,
    rdRevenueShare: base.rdRevenueShare * adj.rdFactor,
    headcountGrowthPerQuarter: base.headcountGrowthPerQuarter * adj.headcountFactor,
    hiringPriority: base.hiringPriority,
    compBand: adj.compBand ?? base.compBand,
    trainingAllocation: base.trainingAllocation,
    pricingNudge: base.pricingNudge + adj.pricingNudge,
    governmentAppetite: base.governmentAppetite,
  };
}

/* -------------------------------------------------------------------------- */
/*  The executive behind the policy                                            */
/* -------------------------------------------------------------------------- */

/**
 * Why this exists.
 *
 * Only a handful of rivals get a live model call in a quarter — `strategists.ts`
 * caps it, and the per-quarter model-time budget usually cuts it further. Every
 * other rival, every quarter, runs the tables above. If personality lived only
 * in the prompt, then most rival behaviour most of the time would be
 * personality-free and twenty-four companies would still feel like one.
 *
 * So the same character the strategist prompt is written in the voice of also
 * turns the dials of the deterministic policy. The character is canonical state
 * that already exists (`Character.stableTraits`), the arithmetic below is pure,
 * and nothing here draws a random number: two runs of the same seed produce the
 * same dials and therefore the same actions.
 */

/**
 * A trait read as a signed lean, -1..1.
 *
 * The five stable traits run 0..100 with 50 as the middle of the cast, so a lean
 * is what the trait says ON TOP of an ordinary executive: 0 for somebody the
 * trait says nothing about, +1 for the most of it anybody has. Every coefficient
 * below multiplies a lean, which is what makes a median executive run the
 * archetype table exactly as it is written — the tables keep meaning what they
 * meant, and the executive bends them.
 */
export function traitLean(value: number): number {
  return Math.max(-1, Math.min(1, (value - 50) / 50));
}

/**
 * The widest a trait-driven multiplier may run.
 *
 * Half to one and three fifths. Deliberately narrower than the posture band the
 * same numbers already move through (headcount runs 0.2..1.8 across postures):
 * an executive shades a company's policy, a posture changes it. Nothing here can
 * zero a budget or double it, so no combination of traits produces behaviour the
 * archetype tables do not already permit.
 */
export const EXECUTIVE_FACTOR_BOUNDS = { min: 0.5, max: 1.6 } as const;

/** The dials one chief executive's traits turn on their company's policy. */
export interface ExecutiveDials {
  /** Multiplier on the marketing share of revenue. */
  readonly marketingFactor: number;
  /** Multiplier on the research and development share of revenue. */
  readonly rdFactor: number;
  /** Multiplier on targeted headcount growth. */
  readonly headcountFactor: number;
  /** Additional quarterly price drift, on top of archetype and posture. */
  readonly pricingNudge: number;
  /** Added to the share of compute pointed at training. */
  readonly trainingAllocationDelta: number;
  /** Added to the appetite for public work. */
  readonly governmentAppetiteDelta: number;
  /** Steps along the compensation ladder, -1, 0 or +1. */
  readonly compBandSteps: number;
  /** Multiplier on the share of cash this company will put into capacity. */
  readonly capacityCashFactor: number;
  /** Added to the share of a programme's ceiling this company bids. */
  readonly bidPriceShareDelta: number;
  /** How readily this executive answers a slight in public, -1..1. */
  readonly publicityLean: number;
  /** How readily this executive escalates against somebody, -1..1. */
  readonly aggressionLean: number;
  /** How far this executive argues from the technical merits, -1..1. */
  readonly technicalLean: number;
}

/** A median executive: every dial neutral, every table as written. */
export const NEUTRAL_EXECUTIVE_DIALS: ExecutiveDials = {
  marketingFactor: 1,
  rdFactor: 1,
  headcountFactor: 1,
  pricingNudge: 0,
  trainingAllocationDelta: 0,
  governmentAppetiteDelta: 0,
  compBandSteps: 0,
  capacityCashFactor: 1,
  bidPriceShareDelta: 0,
  publicityLean: 0,
  aggressionLean: 0,
  technicalLean: 0,
};

/**
 * What each trait is worth on each dial, per unit of lean.
 *
 * One line of justification each, because a coefficient nobody can argue with is
 * a coefficient nobody can tune:
 *
 * - **marketing** — a status-sensitive executive wants the company seen (+0.20);
 *   a technical one would rather the money went to the lab (-0.15); a
 *   financially conservative one would rather it stayed in the bank (-0.25).
 * - **research** — the technical executive funds it because they believe the
 *   result is the asset (+0.25); the risk-tolerant one can live with its
 *   variance (+0.10); the conservative one wants the money back inside the year
 *   (-0.20).
 * - **headcount** — aggression hires ahead of demand to hold the ground (+0.30);
 *   risk tolerance is willing to carry the bench (+0.15); conservatism holds the
 *   line on the wage bill, which is the largest cash commitment a company makes
 *   (-0.25).
 * - **capacity cash** — the same instinct pointed at plant rather than payroll:
 *   the risk-taker builds ahead of the backlog (+0.30), the conservative one
 *   keeps the cash where it can be counted (-0.40), which is what "holds more
 *   cash" means for a company whose only capital decision is this one.
 */
export const EXECUTIVE_COEFFICIENTS = {
  marketing: { statusSensitivity: 0.2, technicalOrientation: -0.15, financialConservatism: -0.25 },
  research: { technicalOrientation: 0.25, riskTolerance: 0.1, financialConservatism: -0.2 },
  headcount: { aggressiveness: 0.3, riskTolerance: 0.15, financialConservatism: -0.25 },
  capacityCash: { riskTolerance: 0.3, financialConservatism: -0.4 },
} as const;

/**
 * Quarterly price drift an executive adds at full lean.
 *
 * Two points of price a quarter for aggression, one for conservatism in the
 * other direction. Both sit inside the posture nudges already in the table
 * (-0.045 for a land grab, +0.035 for survival), so an executive can lean on
 * price without out-shouting the stance the company has taken.
 */
export const EXECUTIVE_PRICING_AGGRESSION = -0.02;
export const EXECUTIVE_PRICING_CONSERVATISM = 0.01;

/**
 * Public-work appetite an executive adds at full lean. Fifteen points of
 * appetite is enough to carry an enterprise company (0.5) or an infrastructure
 * one (0.45) over the 0.3 bidding floor, and not enough to carry a consumer
 * company (0.05) over it — an aggressive consumer executive is still not a
 * defence contractor.
 */
export const EXECUTIVE_GOVERNMENT_AGGRESSION = 0.15;
export const EXECUTIVE_GOVERNMENT_RISK = 0.05;

/**
 * Movement on what a default bid asks for, as a share of the programme ceiling.
 * An aggressive executive buys the win with margin; a conservative one refuses
 * to sign a contract it might deliver at a loss. Five points either way of the
 * 0.85 the table bids, so the range is 0.80..0.90 and no bid is ever free.
 */
export const EXECUTIVE_BID_PRICE_AGGRESSION = -0.05;
export const EXECUTIVE_BID_PRICE_CONSERVATISM = 0.05;

/** The compensation ladder, cheapest first. An executive moves one rung at most. */
export const COMP_BAND_LADDER = ['below_market', 'market', 'above_market', 'top_of_market'] as const satisfies readonly CompBand[];

function bounded(factor: number): number {
  return Math.max(EXECUTIVE_FACTOR_BOUNDS.min, Math.min(EXECUTIVE_FACTOR_BOUNDS.max, factor));
}

/**
 * The dials this chief executive turns, or the neutral set when a company has
 * nobody in the chair.
 *
 * Pure: the same traits always produce the same dials, so this is safe to call
 * from the resolver, from a test and from the client alike.
 */
export function executiveDials(traits: StableTraits | null): ExecutiveDials {
  if (traits === null) return NEUTRAL_EXECUTIVE_DIALS;
  const risk = traitLean(traits.riskTolerance);
  const technical = traitLean(traits.technicalOrientation);
  const conservative = traitLean(traits.financialConservatism);
  const aggressive = traitLean(traits.aggressiveness);
  const status = traitLean(traits.statusSensitivity);

  const marketing = EXECUTIVE_COEFFICIENTS.marketing;
  const research = EXECUTIVE_COEFFICIENTS.research;
  const headcount = EXECUTIVE_COEFFICIENTS.headcount;
  const capacity = EXECUTIVE_COEFFICIENTS.capacityCash;

  return {
    marketingFactor: bounded(
      1 + marketing.statusSensitivity * status + marketing.technicalOrientation * technical + marketing.financialConservatism * conservative,
    ),
    rdFactor: bounded(1 + research.technicalOrientation * technical + research.riskTolerance * risk + research.financialConservatism * conservative),
    headcountFactor: bounded(1 + headcount.aggressiveness * aggressive + headcount.riskTolerance * risk + headcount.financialConservatism * conservative),
    pricingNudge: EXECUTIVE_PRICING_AGGRESSION * aggressive + EXECUTIVE_PRICING_CONSERVATISM * conservative,
    // A technical executive points the fleet at the next model rather than at
    // this quarter's serving bill. Eight points is under a tenth of the fleet:
    // a preference, not a re-plan.
    trainingAllocationDelta: 0.08 * technical,
    governmentAppetiteDelta: EXECUTIVE_GOVERNMENT_AGGRESSION * aggressive + EXECUTIVE_GOVERNMENT_RISK * risk,
    // Pay follows the same instincts as hiring: somebody who wants the person
    // and wants to be seen to have got them pays up; somebody counting the cash
    // does not. Rounded to a rung, so the ladder stays a ladder.
    compBandSteps: Math.max(-1, Math.min(1, Math.round(0.6 * aggressive + 0.4 * status - 0.8 * conservative))),
    capacityCashFactor: bounded(1 + capacity.riskTolerance * risk + capacity.financialConservatism * conservative),
    bidPriceShareDelta: EXECUTIVE_BID_PRICE_AGGRESSION * aggressive + EXECUTIVE_BID_PRICE_CONSERVATISM * conservative,
    publicityLean: status,
    aggressionLean: aggressive,
    technicalLean: technical,
  };
}

/** Move a compensation band along the ladder, clamped at both ends. */
export function shiftCompBand(band: CompBand, steps: number): CompBand {
  const index = COMP_BAND_LADDER.indexOf(band);
  if (index === -1) return band;
  const next = Math.max(0, Math.min(COMP_BAND_LADDER.length - 1, index + steps));
  return COMP_BAND_LADDER[next] ?? band;
}

/**
 * The archetype-and-posture policy as this particular executive runs it.
 *
 * Every field is bounded to the range the tables already produce: shares stay
 * non-negative, the training split stays inside 0..1, appetite stays inside
 * 0..1, and the compensation band stays on the ladder. A neutral executive
 * returns the input unchanged, which is what keeps `effectivePolicy` the single
 * definition of what an archetype does.
 */
export function personalisedPolicy(policy: EffectivePolicy, dials: ExecutiveDials): EffectivePolicy {
  return {
    marketingRevenueShare: Math.max(0, policy.marketingRevenueShare * dials.marketingFactor),
    rdRevenueShare: Math.max(0, policy.rdRevenueShare * dials.rdFactor),
    headcountGrowthPerQuarter: policy.headcountGrowthPerQuarter * dials.headcountFactor,
    hiringPriority: policy.hiringPriority,
    compBand: shiftCompBand(policy.compBand, dials.compBandSteps),
    trainingAllocation: Math.max(0, Math.min(1, policy.trainingAllocation + dials.trainingAllocationDelta)),
    pricingNudge: policy.pricingNudge + dials.pricingNudge,
    governmentAppetite: Math.max(0, Math.min(1, policy.governmentAppetite + dials.governmentAppetiteDelta)),
  };
}
