/**
 * @frontier/simulation — companies/strategists.ts
 *
 * Which rivals get a live model this quarter.
 *
 * A world version 1 session has six rivals and could afford to plan all of them.
 * A world version 2 session has two dozen across six sectors, and "every
 * major-tier company gets a strategist" stops being a selection rule and becomes
 * a bill. This is the selector: rank the eligible companies by how much of the
 * economy they actually move, take the top `MAX_LIVE_STRATEGISTS`, and let the
 * rest run the archetype defaults in `companies/npc.ts` — which is what the
 * three-tier design in `CompanyTier` says should happen anyway.
 *
 * Deterministic: the ranking is by trailing revenue, then market capitalisation,
 * then company id, so the same state always names the same companies.
 */

import type { Company, SessionState } from '@frontier/contracts';

/**
 * Most companies that get a model call in one quarter. Six is the version-1
 * ceiling (`majorRivalCount` tops out at ten but the demo world ran four), and
 * it holds the per-quarter cost flat as the world grows from seven companies to
 * twenty-four.
 */
export const MAX_LIVE_STRATEGISTS = 6;

/** Trailing revenue if the metrics phase has written it, annualised revenue otherwise. */
function weightOf(state: SessionState, company: Company): number {
  const trailing = company.fundamentals.revenueTtmUsd;
  if (trailing > 0) return trailing;
  const metrics = state.companyMetrics.find((row) => row.companyId === company.id);
  if (metrics !== undefined && metrics.revenueTtm > 0) return metrics.revenueTtm;
  return Math.max(0, company.financials.revenueQuarterly) * 4;
}

/** Market capitalisation as the metrics phase last saw it, for the tie-break. */
function capOf(state: SessionState, company: Company): number {
  return state.companyMetrics.find((row) => row.companyId === company.id)?.marketCapUsd ?? 0;
}

/**
 * The companies a live strategist should be run for, largest first, capped.
 *
 * Eligible companies are active, major tier and not directed by a player: a
 * company somebody is playing does not need a model to decide what it wants.
 */
export function strategistCompanyIds(state: SessionState, limit: number = MAX_LIVE_STRATEGISTS): readonly string[] {
  const eligible = state.companies.filter((company) => company.isActive && company.controllerPlayerId === null && company.tier === 'major');
  return eligible
    .slice()
    .sort((a, b) => weightOf(state, b) - weightOf(state, a) || capOf(state, b) - capOf(state, a) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, Math.max(0, limit))
    .map((company) => company.id);
}
