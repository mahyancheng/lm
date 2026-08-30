/**
 * @frontier/simulation — validator/balance.ts
 *
 * The numbers the action validator uses to decide what a company can afford.
 *
 * These are *affordability heuristics*, not the economy. The validator's job is
 * to stop a company committing cash, compute or people it does not have; the
 * subsystem that resolves the action owns the real cost model and may charge
 * more or less than the figure estimated here. Where a figure has a counterpart
 * in `companies/balance.ts` the two are deliberately kept equal — the constants
 * are restated rather than imported so the validator's import closure stays
 * independent of any subsystem, which is what lets it be tested (and shipped)
 * on its own.
 *
 * If a balancing pass changes a shared figure, change it in both places.
 */

import type { CompBand, StaffRole } from '@frontier/contracts';

/* -------------------------------------------------------------------------- */
/*  People                                                                     */
/* -------------------------------------------------------------------------- */

/** Fully loaded annual market compensation per role at salaryPressure 1.0. */
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

/** Quarters of pay a company must have on hand before it may open a requisition. */
export const HIRING_CASH_COVER_QUARTERS = 1;

/* -------------------------------------------------------------------------- */
/*  Compute                                                                    */
/* -------------------------------------------------------------------------- */

/** Cost of one reserved accelerator-equivalent for a quarter at reserved index 1.0. */
export const RESERVED_UNIT_COST_USD_PER_QUARTER = 2_100;

/** Cost of one on-demand accelerator-equivalent for a quarter at spot index 1.0. */
export const CLOUD_UNIT_COST_USD_PER_QUARTER = 2_600;

/**
 * Share of the accelerators already held across the session that the spot market
 * could plausibly free up for one new reservation, at `acceleratorSupply` 1.0.
 * A shortage scales this down linearly, which is what makes a long reservation
 * signed before a shock look like foresight afterwards.
 */
export const RESERVABLE_SHARE_OF_INSTALLED_BASE = 0.2;

/** Floor on reservable capacity, so an empty session can still transact. */
export const MIN_RESERVABLE_UNITS = 1_000;

/* -------------------------------------------------------------------------- */
/*  Capital                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Most dilution a single private round may be committed to. A founder is free
 * to destroy their own position over several rounds; they may not do it in one
 * action by mistake.
 */
export const MAX_ROUND_DILUTION_PCT = 0.5;

/** Most of the company that may be floated in a single listing. */
export const MAX_IPO_FLOAT_PCT = 0.5;

/** Least of the company that can be floated and still constitute a listing. */
export const MIN_IPO_FLOAT_PCT = 0.05;

/**
 * A government bid becomes a board matter once its price passes this multiple of
 * the bidder's quarterly revenue, or the absolute floor below, whichever binds
 * first. A routine small award does not need the board's morning.
 */
export const BOARD_GOV_CONTRACT_REVENUE_MULTIPLE = 2;
export const BOARD_GOV_CONTRACT_FLOOR_USD = 250_000_000;

/* -------------------------------------------------------------------------- */
/*  Research                                                                   */
/* -------------------------------------------------------------------------- */

/** Shortest an introduction request may be and still count as a stated purpose. */
export const MIN_INTRODUCTION_PURPOSE_CHARS = 12;
