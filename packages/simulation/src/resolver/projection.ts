/**
 * @frontier/simulation — resolver/projection.ts
 *
 * The Quarter Resolution report, projected to one viewer.
 *
 * `resolveQuarter` returns the whole quarter: every row, every line, every
 * company. That is correct — the engine is the one thing that sees all of
 * canonical reality — and it is exactly what must never reach a client. The
 * report is a rendering of the ledger, so projecting the ledger projects the
 * report: a line survives only if a row it references survives, and a line whose
 * every reference is invisible is dropped rather than shown with a broken
 * citation. The invariant the whole screen rests on — *every line traces to a
 * committed row* — therefore survives projection too.
 *
 * The rule for a row, in one sentence: **public rows are everyone's; anything
 * else has to be about you.**
 *
 * - `public` — visible to every seat.
 * - `sector` — visible when the row is about a company in a sector the viewer
 *   competes in.
 * - `company` — visible when the row names a company the viewer controls (or one
 *   of their characters).
 * - `private` — the same, and nothing else: an engine row with no subject at all
 *   (a clamped World Director proposal, a failed invariant, an LLM call) belongs
 *   to the engine and reaches no seat.
 *
 * This is a projection, never a repair: it removes, and it never rewrites a
 * figure. What a player may not see is absent, not blurred.
 */

import type { ResolutionLine, ResolutionPhaseReport, ResolutionReport, SessionState, SimEvent } from '@frontier/contracts';

/** Everything the projection needs from a resolution outcome. */
export interface ProjectableOutcome {
  readonly report: ResolutionReport;
  readonly events: readonly SimEvent[];
}

/** One viewer's outcome: the same shapes, carrying less. */
export interface ProjectedOutcome {
  readonly report: ResolutionReport;
  readonly events: SimEvent[];
}

/** Who a viewer is, in the terms the ledger is written in. */
export interface PlayerAudience {
  readonly playerId: string;
  /** Companies the player controls, plus the one their seat directs. */
  readonly companyIds: ReadonlySet<string>;
  /** Characters the player is: their founder, and anyone they employ as one. */
  readonly characterIds: ReadonlySet<string>;
  /** Sectors those companies compete in. */
  readonly sectorIds: ReadonlySet<string>;
}

/**
 * Resolve what one seat is: the companies it controls, the characters it is and
 * the sectors it competes in.
 *
 * A player is their character, not their company — a dismissed chief executive
 * keeps their shares and their seat — so both sets matter and neither implies
 * the other.
 */
export function audienceFor(session: SessionState, playerId: string): PlayerAudience {
  const companyIds = new Set<string>();
  const characterIds = new Set<string>();

  for (const player of session.players) {
    if (player.playerId !== playerId) continue;
    companyIds.add(player.companyId);
    characterIds.add(player.characterId);
  }
  for (const company of session.companies) {
    if (company.controllerPlayerId === playerId) companyIds.add(company.id);
  }
  for (const character of session.characters) {
    if (character.companyId !== null && companyIds.has(character.companyId) && character.isPlayer) characterIds.add(character.id);
  }

  const sectorIds = new Set<string>();
  for (const company of session.companies) {
    if (companyIds.has(company.id)) sectorIds.add(company.sectorId);
  }

  return { playerId, companyIds, characterIds, sectorIds };
}

/** Whether one ledger row may be shown to this seat. */
export function isEventVisibleTo(event: SimEvent, session: SessionState, audience: PlayerAudience): boolean {
  if (event.visibility === 'public') return true;

  const subjects = [event.actorId, event.targetId];
  for (const subject of subjects) {
    if (subject === null) continue;
    if (audience.companyIds.has(subject) || audience.characterIds.has(subject)) return true;
  }
  if (event.visibility !== 'sector') return false;

  for (const subject of subjects) {
    if (subject === null) continue;
    const company = session.companies.find((candidate) => candidate.id === subject);
    if (company !== undefined && audience.sectorIds.has(company.sectorId)) return true;
  }
  return false;
}

/**
 * Project a resolution outcome to what one player may see.
 *
 * Returns the same `ResolutionReport` and `SimEvent[]` shapes — both still
 * satisfy their schemas — carrying only the rows this seat is entitled to and
 * only the lines those rows support.
 */
export function projectResolutionOutcomeForPlayer(
  outcome: ProjectableOutcome,
  session: SessionState,
  playerId: string,
): ProjectedOutcome {
  const audience = audienceFor(session, playerId);
  const events = outcome.events.filter((event) => isEventVisibleTo(event, session, audience));
  const visibleIds = new Set(events.map((event) => event.eventId));

  const phases: ResolutionPhaseReport[] = [];
  const keptLines: ResolutionLine[] = [];
  const droppedLines: ResolutionLine[] = [];

  for (const phase of outcome.report.phases) {
    const lines: ResolutionLine[] = [];
    for (const line of phase.lines) {
      const refs = line.refEventIds.filter((ref) => visibleIds.has(ref));
      // A line whose every citation is invisible is not a line this seat is
      // entitled to a redacted version of. It is a line about somebody else.
      if (refs.length === 0) {
        droppedLines.push(line);
        continue;
      }
      const kept: ResolutionLine = { ...line, refEventIds: refs };
      lines.push(kept);
      keptLines.push(kept);
    }
    if (lines.length > 0) phases.push({ ...phase, lines });
  }

  return {
    report: {
      ...outcome.report,
      headline: headlineFor(outcome.report, keptLines, droppedLines),
      phases,
    },
    events,
  };
}

/**
 * The headline is drawn from a line, so it inherits that line's audience.
 *
 * When the quarter's headline came from a line this seat cannot see, the most
 * notable surviving line takes its place rather than the screen opening on
 * somebody else's bad quarter.
 */
function headlineFor(report: ResolutionReport, kept: readonly ResolutionLine[], dropped: readonly ResolutionLine[]): string {
  const leaks = dropped.some((line) => clip(line.text, 200) === report.headline);
  if (!leaks) return report.headline;

  const notable =
    kept.find((line) => line.tone === 'negative') ?? kept.find((line) => line.tone === 'warning') ?? kept.find((line) => line.tone === 'positive') ?? kept[0];
  return notable === undefined ? `Quarter ${report.quarter} resolved.` : clip(notable.text, 200);
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
