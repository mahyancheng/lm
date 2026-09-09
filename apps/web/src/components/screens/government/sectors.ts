/**
 * Which sector a government programme is aimed at.
 *
 * `ProcurementOpportunity` carries no sector — an agency buys a capability, not
 * an industry — so the only honest source is the scenario's own table of the
 * programmes it opened. `W2_OPPORTUNITY_SECTORS` is that table.
 *
 * An opportunity the engine generated later in the session is **not** in it, and
 * this returns `null` rather than guessing from the programme's name. The
 * Government screen then simply shows no badge for it, which is the truth: the
 * notice does not say.
 */

import type { ProcurementOpportunity, Sector } from '@frontier/contracts';
import { W2_OPPORTUNITY_SECTORS } from '@frontier/simulation';

/** The sector a programme is aimed at, or null where the notice does not say. */
export function opportunitySector(opportunity: Pick<ProcurementOpportunity, 'id'>): Sector | null {
  return W2_OPPORTUNITY_SECTORS[opportunity.id] ?? null;
}

/** How many open opportunities each sector has, for the filter's counts. */
export function opportunitySectorCounts(
  opportunities: readonly Pick<ProcurementOpportunity, 'id'>[],
): Readonly<Partial<Record<Sector, number>>> {
  const out: Partial<Record<Sector, number>> = {};
  for (const opportunity of opportunities) {
    const sector = opportunitySector(opportunity);
    if (sector === null) continue;
    out[sector] = (out[sector] ?? 0) + 1;
  }
  return out;
}
