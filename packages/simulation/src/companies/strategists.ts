/**
 * @frontier/simulation — companies/strategists.ts
 *
 * Which NPC controlled companies get a live model this quarter.
 *
 * The ordinary live path plans every active company that is not directed by a
 * player, across all tiers. Callers may still pass a finite limit when an
 * operator explicitly enables a model budget.
 *
 * Deterministic: the ranking is by trailing revenue, then market capitalisation,
 * then company id, so the same state always names the same companies.
 */

import type { Company, SessionState } from '@frontier/contracts';

/** Legacy finite budget ceiling; normal selection uses an unlimited limit. */
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
 * The companies a live strategist should be run for, largest first.
 *
 * Eligible companies are active and not directed by a player: every NPC tier
 * receives the same live planning opportunity. A finite `limit` is an explicit
 * budget mode for hosts that need to bound model calls.
 */
export function strategistCompanyIds(state: SessionState, limit: number = Number.POSITIVE_INFINITY): readonly string[] {
  const eligible = state.companies.filter((company) => company.isActive && company.controllerPlayerId === null);
  return eligible
    .slice()
    .sort((a, b) => weightOf(state, b) - weightOf(state, a) || capOf(state, b) - capOf(state, a) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, Math.max(0, limit))
    .map((company) => company.id);
}

/* -------------------------------------------------------------------------- */
/*  Player-relevance ordering                                                 */
/* -------------------------------------------------------------------------- */

/** True when `company` has an open deal directly with `playerCompanyId`, either direction. */
function hasOpenDealWithPlayer(state: SessionState, company: Company, playerCompanyId: string): boolean {
  return state.deals.some((deal) => {
    if (deal.status !== 'proposed') return false;
    const parties = [deal.proposerId, deal.counterpartyId];
    return parties.includes(company.id) && parties.includes(playerCompanyId);
  });
}

/** True when `company` holds a live bid on a procurement opportunity the player company is also actively contesting. */
function hasOpenBidAgainstPlayer(state: SessionState, company: Company, playerCompanyId: string): boolean {
  const live = new Set(['submitted', 'shortlisted']);
  const playerOpportunityIds = new Set(
    state.governmentBids.filter((bid) => bid.bidderCompanyId === playerCompanyId && live.has(bid.status)).map((bid) => bid.opportunityId),
  );
  if (playerOpportunityIds.size === 0) return false;
  return state.governmentBids.some(
    (bid) => bid.bidderCompanyId === company.id && live.has(bid.status) && playerOpportunityIds.has(bid.opportunityId),
  );
}

/**
 * Rank the companies `strategistCompanyIds` selected by how much they matter to
 * the player *right now*.
 *
 * This is a second, independent ordering over the same eligible set. A finite
 * limit lets callers apply an explicit per-quarter model-time budget. A rival mid-negotiation with the
 * player, or one the player is head-to-head against for a contract, is the one
 * whose plan actually changes what the player should do next quarter; a distant
 * rival in another sector planning on its archetype policy costs the player
 * nothing to skip.
 *
 * Priority, highest first: an open deal or competing bid against the player
 * outranks everything (their move directly bears on a decision the player is
 * mid-way through), then the same sector, then the same region, then size
 * (`weightOf`/`capOf`, as `strategistCompanyIds` already breaks ties), then id —
 * so the ordering is total and two calls against the same state always agree.
 *
 * Pure: reads only committed `SessionState`, draws no RNG, and is safe to call
 * from the client as well as from a test.
 */
export function strategistPriority(state: SessionState, playerCompanyId: string, limit: number = Number.POSITIVE_INFINITY): readonly string[] {
  const player = state.companies.find((company) => company.id === playerCompanyId) ?? null;
  const eligible = strategistCompanyIds(state, Number.POSITIVE_INFINITY).map(
    (id) => state.companies.find((company) => company.id === id)!,
  );

  const scored = eligible.map((company) => ({
    company,
    contested: player !== null && (hasOpenDealWithPlayer(state, company, playerCompanyId) || hasOpenBidAgainstPlayer(state, company, playerCompanyId)),
    sameSector: player !== null && company.sectorId === player.sectorId,
    sameRegion: player !== null && company.region === player.region,
  }));

  scored.sort((a, b) => {
    if (a.contested !== b.contested) return a.contested ? -1 : 1;
    if (a.sameSector !== b.sameSector) return a.sameSector ? -1 : 1;
    if (a.sameRegion !== b.sameRegion) return a.sameRegion ? -1 : 1;
    const weightDelta = weightOf(state, b.company) - weightOf(state, a.company);
    if (weightDelta !== 0) return weightDelta;
    const capDelta = capOf(state, b.company) - capOf(state, a.company);
    if (capDelta !== 0) return capDelta;
    return a.company.id < b.company.id ? -1 : a.company.id > b.company.id ? 1 : 0;
  });

  return scored.slice(0, Math.max(0, limit)).map((entry) => entry.company.id);
}
