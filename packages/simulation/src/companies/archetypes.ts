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
 */

import type { CompBand, CompanyArchetype, CompanyPosture, StaffRole } from '@frontier/contracts';

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
