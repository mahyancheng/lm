/**
 * @frontier/simulation — `strategistPriority` (companies/strategists.ts)
 *
 * The ordering that lets `endQuarter` spend a fixed model-time budget on the
 * rivals whose plan actually bears on the player's next decision first, and
 * fall the rest back to the archetype policy in a deterministic, always-the-same
 * order rather than an arbitrary one.
 */

import { describe, expect, it } from 'vitest';
import type { DealProposal, SessionState, StoredGovernmentBid } from '@frontier/contracts';
import { createWorld2Session } from '../src/scenario/world2';
import { W2_COMPANIES } from '../src/scenario/world2/seeds';
import { MAX_LIVE_STRATEGISTS, strategistCompanyIds, strategistPriority } from '../src/companies/strategists';

/** The default world-2 session: player is enterprise_software / north_america. */
function session(): SessionState {
  return createWorld2Session();
}

function playerIdOf(state: SessionState): string {
  const player = state.companies.find((company) => company.controllerPlayerId !== null);
  if (player === undefined) throw new Error('fixture has no player-controlled company');
  return player.id;
}

/** A minimal, otherwise-valid deal between the two named parties. */
function dealBetween(proposerId: string, counterpartyId: string, id: string): DealProposal {
  return {
    id,
    proposerId,
    proposerKind: 'company',
    counterpartyId,
    counterpartyKind: 'company',
    gives: [],
    gets: [],
    confidentiality: 'public',
    expiresQuarter: 99,
    binding: false,
    intentStatements: [],
    summary: 'A test fixture deal, ten characters or more.',
    status: 'proposed',
    createdQuarter: 0,
    respondedQuarter: null,
    conversationId: null,
    breachedByPartyId: null,
  };
}

/** A minimal live bid on `opportunityId` by `bidderCompanyId`. */
function bidOn(opportunityId: string, bidderCompanyId: string, id: string): StoredGovernmentBid {
  return {
    id,
    bidderCompanyId,
    opportunityId,
    submittedQuarter: 0,
    status: 'submitted',
    disqualificationReason: null,
    price: 1,
    technicalScoreInputs: {
      modelCapability: 0.5,
      architectureQuality: 0.5,
      securityPosture: 0.5,
      reliabilityCommitment: 0.5,
      responsibleAiCommitment: 0.5,
    },
    computeCommitment: { acceleratorUnits: 0, quarters: 1 },
    staffCommitment: { engineers: 0, researchers: 0, clearedStaff: 0 },
    timeline: { deliveryQuarters: 1, milestoneCount: 1 },
    subcontractors: [],
    ipConcessions: 'government_use_rights',
    auditRights: 'annual',
    domesticSourcingPct: 0.5,
    consortiumMemberIds: [],
    narrative: 'Fixture bid.',
  };
}

describe('strategistPriority', () => {
  it('returns exactly the eligible set strategistCompanyIds would, only reordered', () => {
    const state = session();
    const eligible = new Set(strategistCompanyIds(state, Number.POSITIVE_INFINITY));
    const ranked = strategistPriority(state, playerIdOf(state), Number.POSITIVE_INFINITY);
    expect(new Set(ranked)).toEqual(eligible);
    expect(ranked).toHaveLength(eligible.size);
  });

  it('is capped at the given limit, defaulting to MAX_LIVE_STRATEGISTS', () => {
    const state = session();
    const playerId = playerIdOf(state);
    expect(strategistPriority(state, playerId).length).toBeLessThanOrEqual(MAX_LIVE_STRATEGISTS);
    expect(strategistPriority(state, playerId, 2)).toHaveLength(2);
    expect(strategistPriority(state, playerId, 0)).toHaveLength(0);
  });

  it('is pure and deterministic: two calls against the same state agree exactly', () => {
    const state = session();
    const playerId = playerIdOf(state);
    const a = strategistPriority(state, playerId, Number.POSITIVE_INFINITY);
    const b = strategistPriority(state, playerId, Number.POSITIVE_INFINITY);
    expect(a).toEqual(b);
  });

  it('ranks a same-sector rival above one that shares neither sector nor region', () => {
    const state = session();
    const playerId = playerIdOf(state);
    const player = state.companies.find((company) => company.id === playerId)!;
    const ranked = strategistPriority(state, playerId, Number.POSITIVE_INFINITY);

    const sameSector = state.companies.filter(
      (company) => company.sectorId === player.sectorId && company.id !== playerId && ranked.includes(company.id),
    );
    const neither = state.companies.filter(
      (company) => company.sectorId !== player.sectorId && company.region !== player.region && ranked.includes(company.id),
    );
    expect(sameSector.length).toBeGreaterThan(0);
    expect(neither.length).toBeGreaterThan(0);

    const bestSameSectorRank = Math.min(...sameSector.map((company) => ranked.indexOf(company.id)));
    const bestNeitherRank = Math.min(...neither.map((company) => ranked.indexOf(company.id)));
    expect(bestSameSectorRank).toBeLessThan(bestNeitherRank);
  });

  it('ranks a same-region rival above one that shares neither sector nor region', () => {
    const state = session();
    const playerId = playerIdOf(state);
    const player = state.companies.find((company) => company.id === playerId)!;
    const ranked = strategistPriority(state, playerId, Number.POSITIVE_INFINITY);

    const sameRegionOnly = state.companies.filter(
      (company) => company.region === player.region && company.sectorId !== player.sectorId && ranked.includes(company.id),
    );
    const neither = state.companies.filter(
      (company) => company.sectorId !== player.sectorId && company.region !== player.region && ranked.includes(company.id),
    );
    expect(sameRegionOnly.length).toBeGreaterThan(0);
    expect(neither.length).toBeGreaterThan(0);

    const bestRegionRank = Math.min(...sameRegionOnly.map((company) => ranked.indexOf(company.id)));
    const bestNeitherRank = Math.min(...neither.map((company) => ranked.indexOf(company.id)));
    expect(bestRegionRank).toBeLessThan(bestNeitherRank);
  });

  it('puts a rival with an open deal against the player first, ahead of same-sector rivals', () => {
    const state = session();
    const playerId = playerIdOf(state);
    const player = state.companies.find((company) => company.id === playerId)!;
    const withoutDeal = strategistPriority(state, playerId, Number.POSITIVE_INFINITY);

    // Pick a rival that shares neither sector nor region — the weakest ranking
    // possible on every other signal — and give it an open deal with the player.
    const outsider = state.companies.find(
      (company) => company.sectorId !== player.sectorId && company.region !== player.region && withoutDeal.includes(company.id),
    );
    expect(outsider).toBeDefined();

    const contested: SessionState = { ...state, deals: [...state.deals, dealBetween(outsider!.id, playerId, 'deal_fixture_1')] };
    const ranked = strategistPriority(contested, playerId, Number.POSITIVE_INFINITY);
    expect(ranked[0]).toBe(outsider!.id);
  });

  it('puts a rival competing on the same open bid against the player first', () => {
    const state = session();
    const playerId = playerIdOf(state);
    const player = state.companies.find((company) => company.id === playerId)!;
    const baseline = strategistPriority(state, playerId, Number.POSITIVE_INFINITY);

    const outsider = state.companies.find(
      (company) => company.sectorId !== player.sectorId && company.region !== player.region && baseline.includes(company.id),
    );
    expect(outsider).toBeDefined();

    const contested: SessionState = {
      ...state,
      governmentBids: [
        ...state.governmentBids,
        bidOn('opp_fixture', playerId, 'bid_fixture_player'),
        bidOn('opp_fixture', outsider!.id, 'bid_fixture_rival'),
      ],
    };
    const ranked = strategistPriority(contested, playerId, Number.POSITIVE_INFINITY);
    expect(ranked[0]).toBe(outsider!.id);
  });

  it('a withdrawn deal or bid confers no priority', () => {
    const state = session();
    const playerId = playerIdOf(state);
    const player = state.companies.find((company) => company.id === playerId)!;
    const baseline = strategistPriority(state, playerId, Number.POSITIVE_INFINITY);
    const outsider = state.companies.find(
      (company) => company.sectorId !== player.sectorId && company.region !== player.region && baseline.includes(company.id),
    );
    expect(outsider).toBeDefined();

    const rejected: SessionState = {
      ...state,
      deals: [...state.deals, { ...dealBetween(outsider!.id, playerId, 'deal_fixture_2'), status: 'rejected' }],
    };
    const ranked = strategistPriority(rejected, playerId, Number.POSITIVE_INFINITY);
    expect(ranked).toEqual(baseline);
  });

  it('never names a company outside the eligible set the ordinary strategist selector would allow', () => {
    const state = session();
    const playerId = playerIdOf(state);
    const ineligibleIds = new Set(
      state.companies
        .filter((company) => !company.isActive || company.controllerPlayerId !== null || company.tier !== 'major')
        .map((company) => company.id),
    );
    const ranked = strategistPriority(state, playerId, Number.POSITIVE_INFINITY);
    for (const id of ranked) expect(ineligibleIds.has(id)).toBe(false);
  });

  it('is a no-op distinguishing signal when the named player company does not exist', () => {
    const state = session();
    // A missing player id must not throw — it falls back to size ordering only,
    // exactly `strategistCompanyIds`'s own tie-break.
    expect(() => strategistPriority(state, 'cmp_does_not_exist', Number.POSITIVE_INFINITY)).not.toThrow();
  });
});

void W2_COMPANIES; // kept imported for readers who want to cross-reference ids while debugging a failure
