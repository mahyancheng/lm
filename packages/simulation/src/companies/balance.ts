/**
 * @frontier/simulation — companies/balance.ts
 *
 * Every balancing number the company subsystems use, in one place, as data.
 *
 * Design rule: no magic numbers inside the resolution code. A designer retuning
 * the economy edits this file and nothing else. The defaults come from
 * `docs/ECONOMY.md` §2 (demand and elasticity), §3 (people) and §4 (compute);
 * where the document gives a band rather than a number, the band is reproduced
 * here and the code interpolates inside it.
 *
 * Determinism note: everything here is a constant. Nothing in this module reads
 * a clock, a random source or the environment.
 */

import type { CompBand, ProductSegment, StaffRole } from '@frontier/contracts';

/* -------------------------------------------------------------------------- */
/*  Products and demand                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Price elasticity by segment — `docs/ECONOMY.md` §2, design defaults.
 *
 * Read as: a 10% price rise removes `elasticity × 10%` of the demand multiplier.
 * Consumers leave over price; governments barely notice it.
 */
export const SEGMENT_PRICE_ELASTICITY = {
  consumer: 1.6,
  enterprise: 0.7,
  developer_api: 1.2,
  government: 0.4,
} as const satisfies Record<ProductSegment, number>;

/** Typical quarterly churn band per segment (`docs/ECONOMY.md` §2). */
export const SEGMENT_CHURN_BAND = {
  consumer: { min: 0.12, max: 0.22 },
  enterprise: { min: 0.03, max: 0.08 },
  developer_api: { min: 0.06, max: 0.14 },
  government: { min: 0.01, max: 0.03 },
} as const satisfies Record<ProductSegment, { min: number; max: number }>;

/** Which reputation audience a segment's buyers belong to. */
export const SEGMENT_REPUTATION_AUDIENCE = {
  consumer: 'public',
  enterprise: 'enterprise',
  developer_api: 'developer',
  government: 'government',
} as const satisfies Record<ProductSegment, 'public' | 'developer' | 'enterprise' | 'government'>;

/**
 * Fallback reference price per segment, used only when the session contains no
 * other priced product in that segment. Normally the reference price is the
 * customer-weighted mean price of every active product in the segment, so
 * pricing is judged against the market rather than a designer's guess.
 */
export const SEGMENT_REFERENCE_PRICE_USD = {
  consumer: 60,
  enterprise: 38,
  developer_api: 12,
  government: 5_000,
} as const satisfies Record<ProductSegment, number>;

/** Gross additions per quarter as a fraction of the addressable base, at neutral conditions. */
export const SEGMENT_BASE_ADD_RATE = {
  consumer: 0.18,
  enterprise: 0.11,
  developer_api: 0.15,
  government: 0.06,
} as const satisfies Record<ProductSegment, number>;

/**
 * The "outside pool" a product can recruit from even at zero customers, so a
 * newly launched product is not permanently stuck at zero. Expressed in
 * customers/seats.
 */
export const SEGMENT_SEED_POOL = {
  consumer: 40_000,
  enterprise: 120,
  developer_api: 2_500,
  government: 6,
} as const satisfies Record<ProductSegment, number>;

/** Support and delivery cost as a share of segment revenue (part of COGS). */
export const SEGMENT_SUPPORT_COST_SHARE = {
  consumer: 0.08,
  enterprise: 0.12,
  developer_api: 0.05,
  government: 0.15,
} as const satisfies Record<ProductSegment, number>;

/** How hard quality relative to the segment frontier moves gross additions. */
export const QUALITY_DEMAND_SENSITIVITY = 0.9;
/** How hard quality relative to the frontier moves churn (negative = better quality retains). */
export const QUALITY_CHURN_SENSITIVITY = 0.09;
/** How hard price relative to the market moves churn, scaled by segment elasticity. */
export const PRICE_CHURN_SENSITIVITY = 0.06;
/** Reputation's effect on churn across the 0..100 range. */
export const REPUTATION_CHURN_SENSITIVITY = 0.05;
/** Extra churn suffered when demand had to be turned away for lack of capacity. */
export const CAPACITY_SHORTFALL_CHURN = 0.12;

/**
 * Most of the retained base a capacity shortage may take in a single quarter,
 * reached at zero serving capacity.
 *
 * Capacity still rations *new* demand exactly: what a company cannot serve it
 * does not sell. The installed base is not rationed the same way. Customers sit
 * behind contracts, integrations and habit; a supplier that runs short degrades
 * — rate limits, queues, brownouts — and loses the share of them that will not
 * put up with it, over quarters. Without this ceiling the capacity ratio
 * multiplies the whole book, so a company that lost its compute lost every
 * customer it had in one quarter, retained accounts included, and no business
 * behaves like that. At the value below a company at zero serving capacity
 * keeps roughly three fifths of its base each quarter: a collapse that empties
 * the book in about a year rather than an evaporation.
 */
export const CAPACITY_BASE_LOSS_CEILING = 0.4;

/** Largest multiplicative lift marketing can buy, at infinite spend. */
export const MARKETING_MAX_LIFT = 0.55;
/**
 * Spend at which half the maximum marketing lift is achieved, as a share of the
 * product's own quarterly revenue. Saturation has to scale with the business:
 * a fixed dollar figure would mean a large company buys the whole curve with a
 * rounding error and a small one can never reach it.
 */
export const MARKETING_HALF_SATURATION_REVENUE_SHARE = 0.25;
/** Floor under the half-saturation point, so a pre-revenue product can still market. */
export const MARKETING_HALF_SATURATION_FLOOR_USD = 2_000_000;

/**
 * How far a product's price may sit from its segment's reference before the
 * elasticity term stops responding. Bounds the damage a segment containing
 * genuinely incomparable products (a $700 seat and a $4.9m capacity contract)
 * can do to the demand model.
 */
export const PRICE_DEVIATION_BOUNDS = { min: -0.35, max: 0.6 } as const;

/**
 * How far a product's price may move in a single quarter, as a multiple of the
 * price it currently carries.
 *
 * This is the companion to `PRICE_DEVIATION_BOUNDS`. The elasticity term is only
 * defined near the segment's reference price, so an instruction that jumps two
 * orders of magnitude in one quarter lands in a region where demand no longer
 * responds and revenue — `customers × price` — rises with the price for free.
 * The validator clamps a repricing into this band, and `PRICE_SHOCK_CHURN` makes
 * a move to the edge of it expensive, so the model is never asked a question it
 * cannot answer. Restated in `validator/balance.ts`; change both together.
 */
export const PRICE_MOVE_BAND = { min: 0.25, max: 4 } as const;

/**
 * Extra churn caused by a price rise to the top of the move band, in the
 * quarter it lands. Set so that a move to the top of the band loses more of the
 * base than the price gains: repricing is a strategy with a cost, not a lever
 * that prints revenue.
 */
export const PRICE_SHOCK_CHURN = 0.75;

/**
 * Churn ceiling a full-band price rise lifts the segment cap to. A company that
 * quadruples its price does not lose the segment's usual maximum of customers;
 * it loses nearly all of them.
 */
export const PRICE_SHOCK_CHURN_CEILING = 0.95;

/** Demand noise band drawn from the seeded RNG, per product per quarter. */
export const DEMAND_NOISE_BAND = { min: 0.94, max: 1.06 } as const;

/** Bounds applied to the price response multiplier, so an extreme price cannot invert demand. */
export const PRICE_FACTOR_BOUNDS = { min: 0.05, max: 2.5 } as const;
/** Bounds applied to the quality response multiplier. */
export const QUALITY_FACTOR_BOUNDS = { min: 0.2, max: 2.0 } as const;

/* -------------------------------------------------------------------------- */
/*  Compute and serving capacity                                               */
/* -------------------------------------------------------------------------- */

/**
 * Customers one accelerator-equivalent can serve for a quarter at the archetype
 * baseline compute intensity of 0.5 and a serving cost index of 1.0.
 */
export const SERVE_CUSTOMERS_PER_ACCELERATOR = 90;
/** The archetype baseline compute intensity a product's own intensity is measured against. */
export const BASELINE_COMPUTE_INTENSITY = 0.5;
/** Dollar cost of one accelerator-equivalent of on-demand cloud for a quarter at spot index 1.0. */
export const CLOUD_UNIT_COST_USD_PER_QUARTER = 2_600;
/** Dollar cost of one reserved accelerator-equivalent for a quarter at reserved index 1.0. */
export const RESERVED_UNIT_COST_USD_PER_QUARTER = 2_100;
/**
 * How many quarters an automatically renewed compute reservation runs for.
 *
 * A reservation is a term contract and the term ends. Nothing used to release
 * one, so a seeded block was capacity a company held forever; expiring it
 * without a renewal path is the opposite error, and would empty every seeded
 * NPC datacentre the quarter its term ran out. So the term ends and an NPC-run
 * company that still depends on the block re-signs for this long at the
 * prevailing reserved price. A player decides for themselves, with a quarter's
 * notice, through `reserve_compute`.
 */
export const RESERVATION_RENEWAL_QUARTERS = 4;
/**
 * Quarters of the renewed block's cost a company must hold in cash before an
 * automatic renewal clears. Nobody re-signs a term contract with a counterparty
 * that cannot show it can pay for the term; a company that cannot loses the
 * capacity, and its serving falls with it.
 */
export const RESERVATION_RENEWAL_CASH_COVER_QUARTERS = 2;
/** Energy cost per accelerator-equivalent per quarter at electricity index 1.0. */
export const ENERGY_USD_PER_ACCELERATOR_QUARTER = 420;
/** Quarterly depreciation rate applied to property, plant and equipment. */
export const PPE_DEPRECIATION_PER_QUARTER = 0.055;

/* -------------------------------------------------------------------------- */
/*  People                                                                     */
/* -------------------------------------------------------------------------- */

/** Fully loaded annual market compensation per role at salaryPressure 1.0, in dollars. */
export const MARKET_BASE_COMP_USD = {
  engineers: 380_000,
  researchers: 620_000,
  sales: 270_000,
  ops: 175_000,
  execs: 850_000,
} as const satisfies Record<StaffRole, number>;

/** Offer multiple applied to market compensation by band. */
export const COMP_BAND_MULTIPLIER = {
  below_market: 0.85,
  market: 1.0,
  above_market: 1.18,
  top_of_market: 1.4,
} as const satisfies Record<CompBand, number>;

/** How much a band moves fill rate, independently of what it costs. */
export const COMP_BAND_FILL_FACTOR = {
  below_market: 0.55,
  market: 1.0,
  above_market: 1.25,
  top_of_market: 1.45,
} as const satisfies Record<CompBand, number>;

/** Retention benefit of the band, subtracted from attrition. */
export const COMP_BAND_RETENTION = {
  below_market: -0.03,
  market: 0.0,
  above_market: 0.02,
  top_of_market: 0.035,
} as const satisfies Record<CompBand, number>;

/** Share of an open requisition that fills in one quarter under neutral conditions. */
export const ROLE_BASE_FILL_RATE = {
  engineers: 0.62,
  researchers: 0.4,
  sales: 0.72,
  ops: 0.78,
  execs: 0.3,
} as const satisfies Record<StaffRole, number>;

/** Which world talent-supply variable gates each role. */
export const ROLE_SUPPLY_SOURCE = {
  engineers: 'engineer',
  researchers: 'researcher',
  sales: 'blend',
  ops: 'engineer',
  execs: 'blend',
} as const satisfies Record<StaffRole, 'engineer' | 'researcher' | 'blend'>;

/** Recruiting fee as a fraction of the first-year offer, paid on every filled role. */
export const RECRUITING_FEE_FRACTION = 0.22;
/** Loaded cost of an unfilled requisition, as a fraction of a filled seat's quarterly cost. */
export const OPEN_ROLE_LOADED_FACTOR = 0.14;
/**
 * Share of the requisitions that neither filled nor were re-opened this quarter
 * and are therefore withdrawn. A role nobody has filled in a year is not a role.
 */
export const OPEN_ROLE_EXPIRY_RATE = 0.35;
/**
 * Ceiling on the standing requisition backlog, as a share of headcount. Bounds
 * the morale and payroll drag a company can carry from recruiting it never did.
 */
export const OPEN_ROLE_BACKLOG_CAP_SHARE = 0.35;
/** Smallest backlog a company may carry regardless of size. */
export const OPEN_ROLE_BACKLOG_FLOOR = 4;
/** How far existing compensation drifts toward a richer offer in one quarter. */
export const COMP_EXPECTATION_DRIFT = 0.35;

/** The blend that produces a company's standing with the talent market. */
export const TALENT_REPUTATION_WEIGHTS = { developer: 0.45, public: 0.35, investor: 0.2 } as const;

/** Baseline quarterly attrition before morale, compensation and market effects. */
export const BASE_ATTRITION = 0.015;
/** Attrition added by fully collapsed morale. */
export const MORALE_ATTRITION_COEFFICIENT = 0.07;
/** Attrition added by paying a full multiple below the market rate. */
export const COMP_ATTRITION_COEFFICIENT = 0.08;
/** Attrition added when the talent market is fully starved of supply (everyone is poachable). */
export const SCARCITY_ATTRITION_COEFFICIENT = 0.02;
/** Hard bounds on the stored attrition rate. */
export const ATTRITION_BOUNDS = { min: 0.005, max: 0.5 } as const;
/** Random band applied to the number of leavers actually realised in a quarter. */
export const ATTRITION_REALISATION_BAND = { min: 0.85, max: 1.15 } as const;

/** Morale a company sits at when it pays the market rate and nothing is wrong. */
export const MORALE_BASELINE = 62;
/** How fast morale moves toward its target each quarter. */
export const MORALE_DRIFT = 0.35;
/** Morale points lost when the entire company is made redundant (scaled by the fraction cut). */
export const LAYOFF_MORALE_SHOCK = 60;
/** How much generous severance blunts the morale shock, at two quarters of pay or more. */
export const SEVERANCE_MORALE_RELIEF = 0.45;
/** Public reputation points lost per full-company-equivalent layoff. */
export const LAYOFF_PUBLIC_REPUTATION_SHOCK = 22;
/** Morale points lost by the losing side of a successful executive poach. */
export const POACH_MORALE_SHOCK = 3;

/* -------------------------------------------------------------------------- */
/*  Poaching                                                                   */
/* -------------------------------------------------------------------------- */

/** Base probability an approach succeeds before any premium, standing or relationship. */
export const POACH_BASE_PROBABILITY = 0.1;
/** Compensation premium at which the premium term is fully saturated. */
export const POACH_PREMIUM_SATURATION = 0.6;
/** Weight of the compensation premium term. */
export const POACH_PREMIUM_WEIGHT = 0.42;
/** Weight of the acquiring company's standing with technical talent. */
export const POACH_REPUTATION_WEIGHT = 0.2;
/** Weight of the target's existing relationship with the approaching character. */
export const POACH_RELATIONSHIP_WEIGHT = 0.16;
/** Weight of the target employer's ability to retain (morale). */
export const POACH_RETENTION_WEIGHT = 0.3;
/** Probability bonus for a public approach: faster, and it applies public pressure. */
export const POACH_PUBLIC_APPROACH_BONUS = 0.04;
/** Hard bounds on poach probability, so nothing is ever certain in either direction. */
export const POACH_PROBABILITY_BOUNDS = { min: 0.02, max: 0.95 } as const;

/* -------------------------------------------------------------------------- */
/*  Financials                                                                 */
/* -------------------------------------------------------------------------- */

/** Share of billed revenue that sits in receivables at quarter end. */
export const RECEIVABLE_SHARE = 0.22;
/** Share of cash cost of goods sold left unpaid in payables at quarter end. */
export const PAYABLE_SHARE = 0.18;
/** Corporate tax rate applied to positive pre-tax income. */
export const TAX_RATE = 0.21;
/** Risk premium added to the policy rate and credit spread to price outstanding debt. */
export const DEBT_RISK_PREMIUM = 0.028;
/** Fraction of outstanding principal amortised each quarter. */
export const DEBT_AMORTISATION_PER_QUARTER = 0.025;
/** Runway below which the resolution report raises a warning. */
export const RUNWAY_WARNING_QUARTERS = 4;
/** Cap applied to reported runway for a cash-generative company. */
export const RUNWAY_CAP_QUARTERS = 200;
/** Valuation sentiment haircut applied to a company that failed to pay its bills. */
export const DISTRESS_VALUATION_HAIRCUT = 0.28;
/** How long the distress haircut stays in force. */
export const DISTRESS_HAIRCUT_QUARTERS = 3;
/** Multiple of the funding shortfall a forced bridge round is sized at. */
export const BRIDGE_ROUND_COVER_MULTIPLE = 2.5;
/** Discount applied to the last valuation when pricing a forced bridge round. */
export const BRIDGE_ROUND_PREMONEY_DISCOUNT = 0.45;
/**
 * Investor appetite a forced bridge has to clear. Higher than an ordinary raise
 * needs: everybody in the room knows why this round exists.
 */
export const BRIDGE_APPETITE_FLOOR = 0.35;
/** Most of the company a single forced bridge may sell before nobody will price it. */
export const BRIDGE_MAX_DILUTION = 0.75;
/** Consecutive failed rescues after which a company is wound up. */
export const INSOLVENCY_FAILED_BRIDGES = 3;
/**
 * Consecutive quarters of rescue financing after which a company is wound up
 * even though every one of those rescues cleared.
 *
 * `INSOLVENCY_FAILED_BRIDGES` only fires when nobody will fund the company. A
 * zombie whose bridges keep clearing never trips it and lives forever on other
 * people's money, which made a business with no revenue immortal as long as
 * somebody kept writing cheques. Six quarters — a year and a half in which
 * every bill was met by a rescue rather than by trading — is where a company
 * stops being run and starts being financed.
 */
export const CHRONIC_DISTRESS_QUARTERS = 6;
/**
 * Revenue, as a share of the wage bill, below which a company under rescue
 * after rescue is not a business at all.
 *
 * A company earning less than roughly a third of its own payroll is not trading
 * its way anywhere: it is a payroll with a story attached. Both this and
 * `CHRONIC_DISTRESS_QUARTERS` must hold before administration, so a real
 * business having a bad year is financed rather than wound up.
 */
export const CHRONIC_DISTRESS_REVENUE_FLOOR = 0.35;
/** Share of book value the estate of a wound-up company realises. */
export const ADMINISTRATION_ASSET_RECOVERY = 0.35;
/**
 * Most a single wind-up may lift world talent supply, before scaling by the
 * released workforce as a share of the industry's.
 */
export const TALENT_RELEASE_SUPPLY_LIFT = 0.08;
/** Rounding precision for every stored monetary value, in decimal places. */
export const MONEY_PRECISION = 2;
/**
 * Largest balance-sheet residual attributable to rounding. Anything above this
 * is a double-entry defect in the engine, not a rounding artefact, and throws.
 */
export const BALANCE_ROUNDING_EPSILON_USD = 0.25;
