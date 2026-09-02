/**
 * The arithmetic behind `SliderField`, kept pure so it can be tested without a
 * browser.
 *
 * A slider is only honest when every position it can land on is a figure a
 * player would write down themselves: budgets snap to $250K, not $247,193.
 * These helpers produce that grid — a round step sized to the bound, values
 * snapped onto it with the bounds always reachable, the 25/50/75/Max stops the
 * quick-set chips offer against a cash or budget ceiling, and a ceiling for the
 * actions whose schema sets no maximum at all.
 */

/**
 * The steps a slider may use: 1/2.5/5 times a power of ten (2.5 only from the
 * thousands up, where it is still a round figure). Every entry is exact in
 * floating point, so snapped values never carry decimal noise.
 */
const STEP_LADDER: readonly number[] = [
  1, 5, 10, 25, 50, 100, 250, 500,
  1_000, 2_500, 5_000, 10_000, 25_000, 50_000, 100_000, 250_000, 500_000,
  1_000_000, 2_500_000, 5_000_000, 10_000_000, 25_000_000, 50_000_000,
  100_000_000, 250_000_000, 500_000_000,
  1_000_000_000, 2_500_000_000, 5_000_000_000, 10_000_000_000,
];

/**
 * The round step for a slider spanning `bound`: the smallest ladder entry that
 * keeps the whole range under `maxStops` positions, so a $20M budget moves in
 * $250K notches and a 40-quarter term moves one quarter at a time.
 */
export function roundStep(bound: number, maxStops = 100): number {
  const span = Math.abs(bound);
  for (const step of STEP_LADDER) {
    if (span / step <= maxStops) return step;
  }
  return STEP_LADDER[STEP_LADDER.length - 1] ?? 1;
}

/**
 * Clamp into `[min, max]`, then snap to the nearest multiple of `step` from
 * zero. Both bounds stay reachable even when they are not themselves on the
 * grid — a cash ceiling of $3,120,000 is a legal maximum however round the
 * step is.
 */
export function snapToStep(value: number, min: number, max: number, step: number): number {
  if (Number.isNaN(value)) return min;
  const clamped = Math.min(max, Math.max(min, value));
  if (step <= 0) return clamped;
  const snapped = Math.min(max, Math.max(min, quantise(Math.round(clamped / step) * step)));
  // The ceiling is a grid point of its own: a value nearer to it than to the
  // highest multiple below it snaps up, not down.
  return max - clamped < Math.abs(clamped - snapped) ? max : snapped;
}

/**
 * Strip binary-representation noise from a snapped value: seven steps of 0.05
 * is 0.35, not 0.35000000000000003. The submitted figure is the one the label
 * showed, and a fraction the player set to 35% is stored as 35%.
 */
function quantise(value: number): number {
  return Number(value.toFixed(10));
}

/**
 * The ceiling for a slider whose action carries no schema maximum — a raise, an
 * offer, a cash payment. `floor` keeps the track wide enough to drag when there
 * is no context yet, and the value already set is always inside the range, so
 * the thumb never sits pinned at a ceiling below the figure it represents. A
 * conviction beyond every candidate is typed through "Exact", which the
 * validator, not this range, adjudicates.
 */
export function openCeiling(floor: number, ...candidates: readonly number[]): number {
  let ceiling = floor;
  for (const candidate of candidates) {
    if (Number.isFinite(candidate) && candidate > ceiling) ceiling = candidate;
  }
  return ceiling > 0 ? ceiling : Math.max(floor, 1);
}

/** One quick-set chip: a label and the snapped value it jumps to. */
export interface ChipStop {
  readonly label: string;
  readonly value: number;
}

/**
 * The quick-set stops for a bounded quantity: quarter, half, three-quarter and
 * the bound itself. Stops that snap onto the same grid point collapse into one
 * chip carrying the later label — "Max" always survives a collision — and a
 * stop that collapses onto `min` is dropped, so a tiny range offers fewer
 * chips rather than duplicates.
 */
export function chipStops(min: number, max: number, step: number): readonly ChipStop[] {
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return [];
  const byValue = new Map<number, string>();
  for (const fraction of [0.25, 0.5, 0.75, 1]) {
    const value = fraction === 1 ? max : snapToStep(min + (max - min) * fraction, min, max, step);
    if (value <= min) continue;
    byValue.set(value, fraction === 1 ? 'Max' : `${Math.round(fraction * 100)}%`);
  }
  return [...byValue.entries()].sort((a, b) => a[0] - b[0]).map(([value, label]) => ({ label, value }));
}
