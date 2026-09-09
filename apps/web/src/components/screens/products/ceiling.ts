/**
 * The achievable ceiling, read off the engine's own forecast.
 *
 * §4 P0-4 refuses to add a monopoly price cap — the payoff is emergent, because
 * `segmentReferencePrice` is customer-weighted and a dominant seller drags the
 * reference with it — but it insists the ceiling be **stated** anyway, because
 * "the mechanics that land are the ones with a number a player can quote"
 * (§1.13).
 *
 * From world version 2 there is no validator band to draw a ceiling from — "a
 * price cut is a price cut", and a rise is unbounded too. The number worth
 * drawing is where the engine's own forecast revenue *peaks*: below it, a
 * higher price still buys more revenue than it loses in churn and gross
 * additions; above it, the demand model's saturation decay and the churn shock
 * take more than the price gains. That peak is found by walking `repriceForecast`
 * — the same function the reprice control shows — over a wide range of
 * candidate prices, not by restating its arithmetic here. Guidance, never
 * enforced: nothing here clamps or refuses a price.
 */

import type { SessionState } from '@frontier/contracts';
import { repriceForecast } from '@frontier/simulation';

/** How many candidate prices the walk samples between zero and the top of the range. */
const SCAN_POINTS = 60;

/**
 * The price at which the engine's own forecast revenue peaks for this
 * product, in whole dollars — guidance for where the ladder draws its dashed
 * line, never a bound the reprice slider or the validator enforces.
 *
 * Zero when the product cannot be found, is no longer selling, or carries no
 * price to scan around.
 */
export function achievableCeilingUsd(session: SessionState, companyId: string, productId: string, referenceUsd: number, currentUsd: number): number {
  const top = Math.max(referenceUsd, currentUsd, 1) * 10;
  if (!(top > 0)) return 0;

  let bestPriceUsd = Math.max(0, currentUsd);
  let bestRevenueUsd = -Infinity;
  for (let step = 0; step <= SCAN_POINTS; step += 1) {
    const candidateUsd = (top * step) / SCAN_POINTS;
    const forecast = repriceForecast(session, companyId, productId, candidateUsd);
    if (forecast === null) return 0;
    if (forecast.revenueAfterUsd > bestRevenueUsd) {
      bestRevenueUsd = forecast.revenueAfterUsd;
      bestPriceUsd = candidateUsd;
    }
  }
  return Math.round(bestPriceUsd);
}
