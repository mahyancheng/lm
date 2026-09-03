/**
 * @frontier/simulation — research/reading.ts
 *
 * The plain readings taken off a programme's three resourcing factors: which
 * one is holding it up, how long the rest takes at this pace, and whether the
 * per-quarter setback probability counts as low, medium or high.
 *
 * A leaf module on purpose. `progress.ts` needs these to write a report line
 * that says *why* a run disappointed, and `forecast.ts` needs them to answer the
 * same question before a programme starts; neither may import the other, so the
 * shared arithmetic lives here and depends on nothing but numbers.
 */

/** Which of the three inputs is holding a programme back, or null when none is. */
export type ResearchBottleneck = 'funding' | 'compute' | 'talent';

/** The three adequacy factors, as the screen shows them. */
export interface ForecastFactors {
  readonly funding: number;
  readonly compute: number;
  readonly talent: number;
}

/**
 * A resourcing factor at or above this counts as adequate.
 *
 * `adequacy` returns exactly 1 when a programme has what the node asks for, and
 * floating-point arithmetic can land a hair under it. Anything below is short of
 * something, and the lowest of the three is what is holding the programme up.
 */
export const BOTTLENECK_TOLERANCE = 0.999;

/** Where a setback probability stops being low and stops being medium. */
export const SETBACK_RISK_BANDS = { low: 0.15, medium: 0.3 } as const;

/** Quarters a forecast will not look past. Beyond it the honest answer is "not on this resourcing". */
export const MAX_FORECAST_QUARTERS = 200;

/**
 * The lowest of the three factors, when one of them is short.
 *
 * Ties go to funding, then compute, then talent — a fixed order, so the same
 * state always names the same bottleneck.
 */
export function bottleneckOf(factors: ForecastFactors): ResearchBottleneck | null {
  const entries: readonly (readonly [ResearchBottleneck, number])[] = [
    ['funding', factors.funding],
    ['compute', factors.compute],
    ['talent', factors.talent],
  ];
  let worst: ResearchBottleneck | null = null;
  let lowest = BOTTLENECK_TOLERANCE;
  for (const [kind, value] of entries) {
    if (value < lowest) {
      lowest = value;
      worst = kind;
    }
  }
  return worst;
}

/** Low, medium or high, from a per-quarter setback probability. */
export function setbackRiskBand(probability: number): 'low' | 'medium' | 'high' {
  if (probability < SETBACK_RISK_BANDS.low) return 'low';
  if (probability < SETBACK_RISK_BANDS.medium) return 'medium';
  return 'high';
}

/**
 * Whole quarters to cover `remaining` progress at `plannedRate` per quarter
 * multiplied by `pace` (the product of the three factors).
 *
 * Whole, because a founder cannot buy a third of a quarter, and capped so a
 * stalled programme reports a ceiling rather than infinity.
 */
export function quartersAtPace(remaining: number, plannedRate: number, pace: number): number {
  const perQuarter = plannedRate * pace;
  if (!(perQuarter > 0) || !Number.isFinite(perQuarter)) return MAX_FORECAST_QUARTERS;
  const quarters = Math.ceil(remaining / perQuarter);
  if (!Number.isFinite(quarters)) return MAX_FORECAST_QUARTERS;
  return Math.max(1, Math.min(MAX_FORECAST_QUARTERS, quarters));
}

/** The one word a bottleneck is named by in a report line. */
export const BOTTLENECK_NOUN: Readonly<Record<ResearchBottleneck, string>> = {
  funding: 'money',
  compute: 'compute',
  talent: 'researchers',
};
