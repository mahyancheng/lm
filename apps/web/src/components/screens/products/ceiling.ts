/**
 * The achievable ceiling, read off the engine's own curve.
 *
 * §4 P0-4 refuses to add a monopoly price cap — the payoff is emergent, because
 * `segmentReferencePrice` is customer-weighted and a dominant seller drags the
 * reference with it — but it insists the ceiling be **stated** anyway, because
 * "the mechanics that land are the ones with a number a player can quote"
 * (§1.13).
 *
 * There is such a number and it is already in the engine: `relativePrice`
 * saturates at `PRICE_DEVIATION_BOUNDS.max`, and above that price the
 * elasticity term stops responding at all — the product is no longer competing
 * on price, and only the churn shock is left. That saturation price is the
 * ceiling worth drawing.
 *
 * It is found by walking the engine's own `relativePrice`, not by restating its
 * arithmetic here. If the bounds are ever retuned, this follows.
 */

import type { ProductSegment } from '@frontier/contracts';
import { PRICE_DEVIATION_BOUNDS, PRICE_MOVE_BAND, relativePrice } from '@frontier/simulation';

/** Bisection depth. Forty halvings of an eightfold range settles to the cent. */
const STEPS = 40;

/**
 * The highest price at which the segment's elasticity still responds, in whole
 * dollars. Zero when there is no reference to be judged against.
 */
export function achievableCeilingUsd(segment: ProductSegment, referenceUsd: number): number {
  if (!(referenceUsd > 0)) return 0;
  const saturated = (price: number): boolean => relativePrice(price, referenceUsd) >= PRICE_DEVIATION_BOUNDS.max;

  let low = referenceUsd;
  let high = referenceUsd * 8;
  if (!saturated(high)) return Math.round(high);

  for (let step = 0; step < STEPS; step += 1) {
    const mid = (low + high) / 2;
    if (saturated(mid)) high = mid;
    else low = mid;
  }
  return Math.round(high);
}

/**
 * The most a price may move upward in one quarter, in whole dollars.
 *
 * `PRICE_MOVE_BAND` is the validator's own clamp, so this is what would clear
 * rather than what is desirable. The ladder draws whichever of the two ceilings
 * binds first.
 */
export function repriceCeilingUsd(currentUsd: number): number {
  return Math.round(Math.max(0, currentUsd) * PRICE_MOVE_BAND.max);
}
