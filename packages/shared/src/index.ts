/**
 * @frontier/shared
 *
 * The deterministic primitives every other package builds on: the seeded random
 * number generator, canonical state hashing, formatting and small maths.
 *
 * The rule this package exists to enforce:
 *
 * > No `Math.random()`, no `Date.now()`, no `new Date()` anywhere in the
 * > simulation. All randomness comes from `createRng`, all timing is a
 * > `QuarterIndex`, and all state hashing goes through `hashState`.
 *
 * | Module    | Contains                                                     |
 * |-----------|--------------------------------------------------------------|
 * | `rng`     | `createRng`, the `SeededRng` implementation and its fork rules |
 * | `hash`    | `fnv1a64`, `stableStringify`, `hashState`, `createStateHasher` |
 * | `format`  | Money, percentage, delta and quarter labels                   |
 * | `math`    | Clamping, interpolation, percentile ranks, weighted selection |
 */

export { createRng, rngPath } from './rng';

export { fnv1a64, stableStringify, hashState, createStateHasher } from './hash';
export type { StableStringifyOptions } from './hash';

export {
  formatMoney,
  formatMoneyFull,
  formatPct,
  formatScore,
  formatDelta,
  formatRankMove,
  formatQuarter,
  formatQuarterCount,
} from './format';
export type { MoneyStyle, DeltaFormat } from './format';

export {
  clamp,
  clamp01,
  clampScore,
  lerp,
  remap,
  round,
  safeDiv,
  sum,
  mean,
  sortedAscending,
  percentileRanks,
  percentileRank,
  weightedPick,
} from './math';

/** Version of the shared primitives. Bumped when a hash or stream changes shape. */
export const SHARED_VERSION = '1.0.0';
