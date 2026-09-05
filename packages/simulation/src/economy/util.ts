/**
 * @frontier/simulation — economy/util.ts
 *
 * Small deterministic numeric helpers shared by the world-economy subsystems.
 *
 * Rules that apply to every function here:
 * - No `Math.random()`, no `Date.now()`, no ambient I/O. Randomness arrives as a
 *   `SeededRng` argument and nothing else.
 * - Nothing returns NaN or Infinity for finite inputs. Where a caller could
 *   supply a degenerate input (a zero denominator, a negative base for a log),
 *   the helper degrades to a defined value rather than propagating a NaN into
 *   world state.
 */

import type { SeededRng } from '@frontier/contracts';

/** Clamp into `[min, max]`. Non-finite input collapses to `min`. */
export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/** Clamp into `[0, 1]`. */
export function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

/** Linear interpolation. `t` is clamped to `[0, 1]`. */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * clamp01(t);
}

/** Where `value` sits inside `[min, max]`, as a 0..1 fraction. */
export function normaliseInto(value: number, min: number, max: number): number {
  if (!(max > min)) return 0;
  return clamp01((value - min) / (max - min));
}

/**
 * A standard normal draw, deterministic given the stream.
 *
 * Box-Muller, consuming exactly two uniforms so the draw count per call is
 * stable, with the tail clipped at four standard deviations. The clip matters:
 * an unclipped tail can move a world variable by more than the whole quarter's
 * event budget, which reads to a player as an unexplained shock.
 */
export function standardNormal(rng: SeededRng): number {
  const u1 = clamp(rng.next(), 1e-12, 1 - 1e-12);
  const u2 = rng.next();
  const radius = Math.sqrt(-2 * Math.log(u1));
  return clamp(radius * Math.cos(2 * Math.PI * u2), -4, 4);
}

/** Round to `places` decimals. Used to keep drift from accumulating float dust. */
export function round(value: number, places: number): number {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

/**
 * A weighted pick from `entries`, deterministic given the stream.
 * Returns `null` for an empty list or a non-positive total weight.
 */
export function weightedPick<T>(rng: SeededRng, entries: readonly { readonly item: T; readonly weight: number }[]): T | null {
  let total = 0;
  for (const entry of entries) {
    if (Number.isFinite(entry.weight) && entry.weight > 0) total += entry.weight;
  }
  if (total <= 0) return null;
  let roll = rng.next() * total;
  for (const entry of entries) {
    if (!Number.isFinite(entry.weight) || entry.weight <= 0) continue;
    roll -= entry.weight;
    if (roll <= 0) return entry.item;
  }
  const last = entries[entries.length - 1];
  return last === undefined ? null : last.item;
}

/** Percent-change label, e.g. `+11%` / `-4%`. Deterministic formatting. */
export function pctLabel(before: number, after: number): string {
  if (!Number.isFinite(before) || before === 0) return `${after >= 0 ? '+' : ''}${round(after, 3)}`;
  const pct = ((after - before) / Math.abs(before)) * 100;
  return `${pct >= 0 ? '+' : ''}${round(pct, 1)}%`;
}

/** Absolute-point label, e.g. `+0.08` — used for normalised 0..1 variables. */
export function pointLabel(before: number, after: number): string {
  const delta = after - before;
  return `${delta >= 0 ? '+' : ''}${round(delta, 3)}`;
}
