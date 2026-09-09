/**
 * The verdict: everything the elimination screen shows, selected from state.
 *
 * A player whose company was wound up is out. What they are owed at that point
 * is an account of the run — how long it lasted, why it ended, where they
 * finished, and what the last two years of the business actually looked like —
 * and every one of those figures is a number the engine already committed. This
 * module is the selection; `Verdict.tsx` is the rendering, and it computes
 * nothing.
 *
 * The cause line comes off the ledger when the quarter that ended the run is
 * still in hand, because the row is the authority on why a company died. A
 * reloaded save no longer holds that quarter's events, so the same sentence is
 * stated from `SOLVENCY_NEGATIVE_QUARTERS` instead — the constant the row was
 * written from. It is the same line either way, which is the point.
 */

import type { FinancialQuarter, LeaderboardBoard, SessionState, SimEvent } from '@frontier/contracts';
import { SOLVENCY_NEGATIVE_QUARTERS } from '@frontier/simulation';

/** Quarters of history the verdict charts. The same window the history tab uses. */
export const VERDICT_HISTORY_QUARTERS = 8;

/** Where the run finished on one board. */
export interface VerdictStanding {
  readonly board: LeaderboardBoard;
  readonly label: string;
  /** Position on the board, or null when the seat never entered it. */
  readonly rank: number | null;
  /** How many were ranked, so "8th" reads as "8th of 25". */
  readonly total: number;
}

/** Everything the screen renders, and nothing it has to work out. */
export interface Verdict {
  readonly companyName: string;
  readonly founderName: string;
  readonly eliminatedQuarter: number;
  /** Quarters the company existed, counting the one it died in. */
  readonly quartersSurvived: number;
  readonly causeLine: string;
  readonly founderNetWorthUsd: number;
  readonly standings: readonly VerdictStanding[];
  readonly history: readonly FinancialQuarter[];
}

/** Board names as the leaderboard screen spells them. */
const BOARD_LABEL: Readonly<Record<LeaderboardBoard, string>> = {
  company_value: 'Company value',
  founder_wealth: 'Founder wealth',
  revenue: 'Revenue',
  profit: 'Profit',
  innovation: 'Innovation',
  market_influence: 'Market influence',
  network: 'Network',
  government: 'Government',
  reputation: 'Reputation',
  founder_index: 'Founder Index',
  capital_returns: 'Capital returns',
  assets_under_management: 'Assets under management',
};

/** The boards a founder is ranked on, in the order the verdict lists them. */
const VERDICT_BOARDS: readonly LeaderboardBoard[] = [
  'founder_index',
  'company_value',
  'founder_wealth',
  'revenue',
  'innovation',
  'reputation',
];

/**
 * The plain-language cause the administration row stated, or null when the
 * quarter that wrote it is no longer in hand.
 */
export function causeDetailOf(events: readonly SimEvent[], companyId: string): string | null {
  for (const event of events) {
    if (event.type !== 'information_revealed') continue;
    if (event.payload['kind'] !== 'administration') continue;
    if (event.actorId !== companyId) continue;
    const detail = event.payload['causeDetail'];
    if (typeof detail === 'string' && detail.length > 0) return detail;
  }
  return null;
}

/** The sentence the screen prints, from the row when there is one. */
export function causeLineOf(events: readonly SimEvent[], companyId: string): string {
  return causeDetailOf(events, companyId) ?? `${SOLVENCY_NEGATIVE_QUARTERS} quarters of negative cash`;
}

/** Where this seat finished on the boards a founder is ranked on. */
export function standingsOf(session: SessionState, companyId: string, characterId: string): VerdictStanding[] {
  const standings: VerdictStanding[] = [];
  for (const board of VERDICT_BOARDS) {
    const table = session.leaderboards.find((entry) => entry.board === board);
    if (table === undefined) continue;
    const row = table.entries.find((entry) => entry.subjectId === companyId || entry.subjectId === characterId);
    standings.push({ board, label: BOARD_LABEL[board], rank: row?.rank ?? null, total: table.entries.length });
  }
  return standings;
}

/**
 * The whole verdict for the seat, or null while it is still playing.
 *
 * `events` is the quarter that ended the run when the client still holds it;
 * pass an empty list and the cause line falls back to the constant.
 */
export function verdictOf(
  session: SessionState,
  input: {
    readonly playerId: string;
    readonly events?: readonly SimEvent[];
    readonly founderNetWorthUsd: number;
  },
): Verdict | null {
  const seat = session.players.find((player) => player.playerId === input.playerId) ?? null;
  const eliminatedQuarter = seat?.eliminatedQuarter ?? null;
  if (seat === null || eliminatedQuarter === null || eliminatedQuarter === undefined) return null;

  const company = session.companies.find((entry) => entry.id === seat.companyId) ?? null;
  const founder = session.characters.find((entry) => entry.id === seat.characterId) ?? null;
  const history = company?.financialHistory ?? [];

  return {
    companyName: company?.name ?? seat.companyId,
    founderName: founder?.name ?? seat.displayName,
    eliminatedQuarter,
    // Inclusive of the quarter it died in: a company founded in quarter 0 and
    // wound up in quarter 6 survived seven quarters, which is what a player
    // counts.
    quartersSurvived: Math.max(1, eliminatedQuarter - (company?.foundedQuarter ?? 0) + 1),
    causeLine: causeLineOf(input.events ?? [], seat.companyId),
    founderNetWorthUsd: input.founderNetWorthUsd,
    standings: standingsOf(session, seat.companyId, seat.characterId),
    history: history.slice(-VERDICT_HISTORY_QUARTERS),
  };
}

/** "8th of 25", or the honest absence when the seat never entered the board. */
export function rankLabel(standing: VerdictStanding): string {
  if (standing.rank === null) return 'unranked';
  return `${ordinal(standing.rank)} of ${standing.total}`;
}

/** 1st, 2nd, 3rd, 4th … 11th, 12th, 13th, 21st. Whole numbers only. */
export function ordinal(value: number): string {
  const n = Math.round(value);
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}
