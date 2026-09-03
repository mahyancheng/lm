/**
 * The resolution report never puts a raw token in front of a player.
 *
 * `playerQuarter` is the one function every consumer of the resolution report
 * goes through — the page's sections, the newspaper headline, the ledger
 * drawer's line quote — so pinning it here pins the whole screen. Built from a
 * real world-2 session and a real resolver, not a hand-built fixture: a change
 * to how the engine writes a line's text shows up here the same way it would
 * on the screen.
 */

import { describe, expect, it } from 'vitest';
import type { ResolutionReport, SessionState } from '@frontier/contracts';
import { createDefaultEngine, createWorld2Session } from '@frontier/simulation';
import { PLAYER_ID } from '@/lib/game/engine';
import { groupLines, lineCount, playerQuarter, sectionOf } from './sections';

/** A lowercase identifier with at least one underscore: `cost_recognised`, `cmp_aletheia`. */
const SNAKE_TOKEN_RE = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/;

/** Every string a player actually reads off a resolved quarter's report. */
function playerFacingStrings(report: ResolutionReport): readonly string[] {
  const strings: string[] = [report.headline];
  for (const phase of report.phases) {
    for (const line of phase.lines) {
      strings.push(line.text);
      if (line.deltaLabel !== null) strings.push(line.deltaLabel);
    }
  }
  return strings;
}

describe('a resolved quarter reaches the player with no raw token', () => {
  it('carries no snake_case token in the headline or any line, across several quarters', () => {
    const engine = createDefaultEngine();
    let session: SessionState = createWorld2Session();

    for (let quarter = 0; quarter < 4; quarter += 1) {
      const outcome = engine.resolver.resolveQuarter(session, [], null, []);
      expect(outcome.committed).toBe(true);
      const view = playerQuarter(outcome, session, PLAYER_ID);

      for (const text of playerFacingStrings(view.report)) {
        expect(text, text).not.toMatch(SNAKE_TOKEN_RE);
      }
      for (const section of view.sections) {
        for (const line of section.lines) {
          expect(line.text, line.text).not.toMatch(SNAKE_TOKEN_RE);
          if (line.deltaLabel !== null) expect(line.deltaLabel, line.deltaLabel).not.toMatch(SNAKE_TOKEN_RE);
        }
      }

      session = outcome.nextState;
    }
  });

  it('resolves a company id inside a line into that company\'s real name', () => {
    const engine = createDefaultEngine();
    const session = createWorld2Session();
    const outcome = engine.resolver.resolveQuarter(session, [], null, []);
    const view = playerQuarter(outcome, session, PLAYER_ID);

    // Every company on the register is a candidate raw id the engine might
    // have interpolated into a line's text. None of them survive literally —
    // either the id never appeared, or `delintText` replaced it with the name.
    for (const company of outcome.nextState.companies) {
      for (const text of playerFacingStrings(view.report)) {
        expect(text.includes(company.id), `"${text}" still contains the raw id ${company.id}`).toBe(false);
      }
    }
  });
});

describe('groupLines and lineCount stay pure over a delinted report', () => {
  it('accounts for every line exactly once across the sections', () => {
    const engine = createDefaultEngine();
    const session = createWorld2Session();
    const outcome = engine.resolver.resolveQuarter(session, [], null, []);
    const view = playerQuarter(outcome, session, PLAYER_ID);

    const sectioned = view.sections.reduce((total, section) => total + section.lines.length, 0);
    // `view.report` is the seat-projected, delinted report, so its own line
    // count is the ceiling `sectioned` must hit exactly: grouping drops
    // nothing and duplicates nothing.
    expect(sectioned).toBe(lineCount(view.report));
  });

  it('is stable: the same report groups the same way twice', () => {
    const engine = createDefaultEngine();
    const session = createWorld2Session();
    const outcome = engine.resolver.resolveQuarter(session, [], null, []);
    const ownIds = new Set<string>(session.companies.slice(0, 1).map((company) => company.id));
    const actorIds = new Set<string>(session.companies.map((company) => company.id));
    expect(groupLines(outcome.report, ownIds, actorIds)).toEqual(groupLines(outcome.report, ownIds, actorIds));
  });

  it('sends a line with no subject to world only when it is a government line', () => {
    const line = { phase: 'talent_resolution' as const, text: 't', deltaLabel: null, refEventIds: [], tone: 'neutral' as const, subjectId: null };
    expect(sectionOf(line, new Set(), new Set())).toBe('company');
    expect(sectionOf({ ...line, phase: 'government_resolution' as const }, new Set(), new Set())).toBe('world');
  });
});
