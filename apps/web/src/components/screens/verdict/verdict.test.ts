/**
 * The elimination verdict, and the badge the newcomer wears.
 *
 * Two rules, both of them "the screen computes nothing":
 *
 * 1. The verdict exists only when the engine says the seat is closed, and every
 *    figure on it — the cause, the standing, the statements — is a figure the
 *    engine committed. A seat that is still playing has no verdict at all.
 * 2. The "new" badge window belongs to the engine (`isNewEntrant`), not to the
 *    screen: the screen only spells it.
 *
 * Relative imports throughout: the `@/` alias is Next's, and test files keep to
 * relative paths (see `vitest.config.mts`).
 */

import { describe, expect, it } from 'vitest';
import type { SessionState, SimEvent } from '@frontier/contracts';
import { SessionStateSchema } from '@frontier/contracts';
import { createWorld2Session } from '@frontier/simulation';
import { newEntrantLabel } from '../reporting/util';
import { causeDetailOf, causeLineOf, ordinal, rankLabel, standingsOf, verdictOf } from './verdict';

const PLAYER = 'player_1';

/** The world-2 session with the seat closed in `quarter`. */
function eliminated(quarter: number): SessionState {
  const base = createWorld2Session();
  return SessionStateSchema.parse({
    ...base,
    quarter: quarter + 1,
    players: base.players.map((player) => ({ ...player, eliminatedQuarter: quarter })),
  });
}

const administrationRow = (companyId: string, causeDetail: string): SimEvent =>
  ({
    eventId: 'evt_admin',
    sessionId: 'sess',
    sequence: 1,
    quarter: 6,
    type: 'information_revealed',
    actorId: companyId,
    targetId: null,
    payload: { kind: 'administration', cause: 'insolvent', causeDetail },
    visibility: 'public',
  }) as unknown as SimEvent;

describe('the verdict exists only when the engine closed the seat', () => {
  it('is null while the seat is playing', () => {
    const session = createWorld2Session();
    expect(verdictOf(session, { playerId: PLAYER, founderNetWorthUsd: 1 })).toBeNull();
  });

  it('names the company, the quarter and how long the run lasted', () => {
    const session = eliminated(6);
    const verdict = verdictOf(session, { playerId: PLAYER, founderNetWorthUsd: 4_200_000 });
    expect(verdict).not.toBeNull();
    if (verdict === null) return;

    expect(verdict.eliminatedQuarter).toBe(6);
    // Founded in quarter 0, wound up in quarter 6: seven quarters, counting the
    // one it died in.
    expect(verdict.quartersSurvived).toBe(7);
    expect(verdict.founderNetWorthUsd).toBe(4_200_000);
    expect(verdict.companyName.length).toBeGreaterThan(0);
    expect(verdict.founderName.length).toBeGreaterThan(0);
    expect(verdict.history.length).toBeLessThanOrEqual(8);
  });
});

describe('the cause comes off the ledger', () => {
  it('reads the row the wind-up wrote', () => {
    const session = eliminated(6);
    const seat = session.players[0];
    if (seat === undefined) throw new Error('no seat');
    const events = [administrationRow(seat.companyId, '2 quarters of negative cash')];

    expect(causeDetailOf(events, seat.companyId)).toBe('2 quarters of negative cash');
    expect(verdictOf(session, { playerId: PLAYER, events, founderNetWorthUsd: 0 })?.causeLine).toBe('2 quarters of negative cash');
  });

  it('states the same sentence from the constant when the quarter is no longer in hand', () => {
    expect(causeLineOf([], 'cmp_anything')).toBe('2 quarters of negative cash');
  });

  it('ignores a row about somebody else', () => {
    expect(causeDetailOf([administrationRow('cmp_someone_else', 'whatever')], 'cmp_mine')).toBeNull();
  });
});

describe('the final standing', () => {
  it('reports every board as unranked before a quarter has resolved', () => {
    const session = eliminated(0);
    const seat = session.players[0];
    if (seat === undefined) throw new Error('no seat');
    // Quarter 0 has no leaderboards, so there is nothing to be ranked on and the
    // list is empty rather than a set of invented positions.
    expect(standingsOf(session, seat.companyId, seat.characterId)).toEqual([]);
  });

  it('spells a rank the way a reader says it', () => {
    expect(rankLabel({ board: 'revenue', label: 'Revenue', rank: 8, total: 25 })).toBe('8th of 25');
    expect(rankLabel({ board: 'revenue', label: 'Revenue', rank: null, total: 25 })).toBe('unranked');
    expect(ordinal(1)).toBe('1st');
    expect(ordinal(2)).toBe('2nd');
    expect(ordinal(3)).toBe('3rd');
    expect(ordinal(4)).toBe('4th');
    expect(ordinal(11)).toBe('11th');
    expect(ordinal(12)).toBe('12th');
    expect(ordinal(13)).toBe('13th');
    expect(ordinal(21)).toBe('21st');
  });
});

describe('the new-entrant badge', () => {
  it('runs for four quarters from the founding and no longer', () => {
    expect(newEntrantLabel({ foundedQuarter: 9 }, 9, 2027)).toBe('New · 2029 Q2');
    expect(newEntrantLabel({ foundedQuarter: 9 }, 12, 2027)).toBe('New · 2029 Q2');
    expect(newEntrantLabel({ foundedQuarter: 9 }, 13, 2027)).toBeNull();
  });

  it('is never worn by a company the scenario seeded, or by one whose founding is redacted', () => {
    expect(newEntrantLabel({ foundedQuarter: 0 }, 0, 2027)).toBeNull();
    expect(newEntrantLabel({}, 4, 2027)).toBeNull();
  });
});
