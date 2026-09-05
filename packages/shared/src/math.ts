/**
 * @frontier/shared — math.ts
 *
 * Small numeric helpers the engine leans on constantly.
 *
 * Everything here is pure and deterministic. The only function that reads
 * randomness (`weightedPick`) takes the stream as an argument: nothing in this
 * package reaches for a global source of entropy.
 */

import type { SeededRng } from '@frontier/contracts';

/* -------------------------------------------------------------------------- */
/*  Ranges                                                                     */
/* -------------------------------------------------------------------------- */

/** Constrain `value` to `[min, max]`. Non-finite input collapses to `min`. */
export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  if (min > max) return min;
  return value < min ? min : value > max ? max : value;
}

/** Constrain to the unit interval, the engine's default normalised scale. */
export function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

/** Constrain to a 0..100 score. */
export function clampScore(value: number): number {
  return clamp(value, 0, 100);
}

/** Linear interpolation. `t` is clamped, so `lerp(a, b, 2)` is `b`, not overshoot. */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * clamp01(t);
}

/** Map `value` from `[inMin, inMax]` onto `[outMin, outMax]`, clamped at both ends. */
export function remap(value: number, inMin: number, inMax: number, outMin: number, outMax: number): number {
  if (inMax === inMin) return outMin;
  return lerp(outMin, outMax, (value - inMin) / (inMax - inMin));
}

/**
 * Round to `decimals` places, half away from the representation error.
 *
 * Shifts through the exponent rather than multiplying by a power of ten, so
 * `round(1.005, 2)` is `1.01` rather than the `1` that `Math.round(1.005 * 100)`
 * produces — `1.005 * 100` is `100.49999999999999` in binary floating point.
 * Deterministic on every engine: only string exponent arithmetic is involved.
 */
export function round(value: number, decimals = 0): number {
  if (!Number.isFinite(value)) return 0;
  if (decimals === 0) return Math.round(value);
  const shifted = shiftExponent(value, decimals);
  if (!Number.isFinite(shifted)) return value;
  return shiftExponent(Math.round(shifted), -decimals);
}

/** Multiply by `10 ** places` without touching the mantissa. */
function shiftExponent(value: number, places: number): number {
  if (value === 0) return 0;
  const [mantissa = '0', exponent = '0'] = value.toExponential().split('e');
  return Number(`${mantissa}e${Number(exponent) + places}`);
}

/** Division that yields `fallback` instead of `Infinity` or `NaN`. */
export function safeDiv(numerator: number, denominator: number, fallback = 0): number {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return fallback;
  const result = numerator / denominator;
  return Number.isFinite(result) ? result : fallback;
}

/* -------------------------------------------------------------------------- */
/*  Aggregates                                                                 */
/* -------------------------------------------------------------------------- */

export function sum(values: readonly number[]): number {
  let total = 0;
  for (const value of values) if (Number.isFinite(value)) total += value;
  return total;
}

export function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return sum(values) / values.length;
}

/** Sorted copy, ascending, ignoring non-finite entries. */
export function sortedAscending(values: readonly number[]): number[] {
  return values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
}

/* -------------------------------------------------------------------------- */
/*  Percentiles                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Mid-rank percentile of every value within its own set, in the input order.
 *
 * ```text
 * rank(v) = (count(x < v) + 0.5 * count(x === v)) / n
 * ```
 *
 * Chosen deliberately over "fraction strictly below" because the Founder Index
 * reads these directly:
 *
 * - a lone subject scores `0.5`, not `0` or `1` — with nobody to compare against,
 *   a percentile carries no information and should say so;
 * - a field where everyone is equal scores `0.5` across the board, so a tie does
 *   not silently crown whoever happens to sort first;
 * - the result is always inside `(0, 1)`, which is what `unitInterval` fields
 *   and the weighted composite expect.
 *
 * Non-finite values are treated as the lowest possible value rather than
 * poisoning the whole board.
 */
export function percentileRanks(values: readonly number[]): number[] {
  const n = values.length;
  if (n === 0) return [];
  const clean = values.map((v) => (Number.isFinite(v) ? v : Number.NEGATIVE_INFINITY));
  const sorted = clean.slice().sort((a, b) => a - b);

  return clean.map((value) => {
    const less = lowerBound(sorted, value);
    const upper = upperBound(sorted, value);
    const equal = upper - less;
    return (less + 0.5 * equal) / n;
  });
}

/** The mid-rank percentile of one value inside a population. */
export function percentileRank(values: readonly number[], value: number): number {
  if (values.length === 0) return 0.5;
  return percentileRanks([...values, value])[values.length] ?? 0.5;
}

/** First index where `sorted[i] >= value`. */
function lowerBound(sorted: readonly number[], value: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const item = sorted[mid];
    if (item !== undefined && item < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** First index where `sorted[i] > value`. */
function upperBound(sorted: readonly number[], value: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const item = sorted[mid];
    if (item !== undefined && item <= value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/* -------------------------------------------------------------------------- */
/*  Weighted selection                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Pick one item with probability proportional to its weight.
 *
 * Takes exactly one draw from `rng` whatever the input, so adding an item to the
 * candidate list cannot shift the rest of the caller's stream. Negative and
 * non-finite weights count as zero; when every weight is zero the selection
 * falls back to a uniform pick, because "nothing is eligible" is a decision the
 * caller should make before calling, not a crash here.
 *
 * Throws only on an empty array, which is a programming error.
 */
export function weightedPick<T>(rng: SeededRng, items: readonly T[], weightOf: (item: T) => number = defaultWeight): T {
  if (items.length === 0) throw new Error('weightedPick: cannot pick from an empty array');
  const first = items[0] as T;

  const weights = items.map((item) => {
    const w = weightOf(item);
    return Number.isFinite(w) && w > 0 ? w : 0;
  });
  const total = sum(weights);
  const draw = rng.next();
  if (total <= 0) return items[Math.min(items.length - 1, Math.floor(draw * items.length))] ?? first;

  let cursor = draw * total;
  for (let i = 0; i < items.length; i += 1) {
    cursor -= weights[i] ?? 0;
    if (cursor <= 0) return items[i] ?? first;
  }
  return items[items.length - 1] ?? first;
}

/** Reads a `weight` property when the caller does not supply an accessor. */
function defaultWeight(item: unknown): number {
  if (typeof item === 'object' && item !== null && 'weight' in item) {
    const weight = (item as { weight?: unknown }).weight;
    if (typeof weight === 'number') return weight;
  }
  return 1;
}
