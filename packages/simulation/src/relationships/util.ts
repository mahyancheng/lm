/**
 * @frontier/simulation — relationships/util.ts
 *
 * Small deterministic helpers shared by the people subsystems.
 *
 * Nothing here reads a clock or a random source. Every function is pure except
 * `emitEvent`, which is a thin typed wrapper over `ResolverContext.emit`.
 */

import type { LedgerVisibility, ResolverContext, SessionState, SimEventType } from '@frontier/contracts';

/* -------------------------------------------------------------------------- */
/*  Numbers                                                                    */
/* -------------------------------------------------------------------------- */

/** Clamp `value` into `[min, max]`. Non-finite input collapses to `min`. */
export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/** Clamp into the 0..1 unit interval used by most contract scalars. */
export function unit(value: number): number {
  return clamp(value, 0, 1);
}

/** Clamp into the 0..100 score range used by reputations and connection levels. */
export function score(value: number): number {
  return clamp(value, 0, 100);
}

/** Clamp into the -100..100 range used by `Director.relationshipWithCeo`. */
export function signedScore(value: number): number {
  return clamp(value, -100, 100);
}

/** Clamp into the -1..1 range used by memory sentiment and story tone. */
export function bipolar(value: number): number {
  return clamp(value, -1, 1);
}

/** Round to `dp` decimal places. Deterministic across platforms for our ranges. */
export function round(value: number, dp = 4): number {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** dp;
  return Math.round(value * factor) / factor;
}

/**
 * Percentile of `value` within `values`, counting ties as half.
 *
 * Returns 0.5 for a single-element population, which is what we want: a lone
 * founder is neither top nor bottom of a session of one.
 */
export function percentileRank(values: readonly number[], value: number): number {
  if (values.length === 0) return 0.5;
  let below = 0;
  let equal = 0;
  for (const v of values) {
    if (v < value) below += 1;
    else if (v === value) equal += 1;
  }
  return unit((below + equal / 2) / values.length);
}

/** Safe division that returns `fallback` rather than infinity or NaN. */
export function ratio(numerator: number, denominator: number, fallback = 0): number {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return fallback;
  const r = numerator / denominator;
  return Number.isFinite(r) ? r : fallback;
}

/* -------------------------------------------------------------------------- */
/*  Ledger                                                                     */
/* -------------------------------------------------------------------------- */

/** Emit a ledger row and return its assigned id, so a report line can reference it. */
export function emitEvent(
  draft: SessionState,
  ctx: ResolverContext,
  type: SimEventType,
  actorId: string | null,
  targetId: string | null,
  payload: Record<string, unknown>,
  visibility: LedgerVisibility,
): string {
  return ctx.emit({ sessionId: draft.sessionId, quarter: ctx.quarter, type, actorId, targetId, payload, visibility });
}

/** Trim a report line to the contract's 300-character ceiling. */
export function line(text: string): string {
  return text.length <= 300 ? text : `${text.slice(0, 297)}...`;
}
