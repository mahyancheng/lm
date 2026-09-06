/**
 * The Play tab: the page *is* End Quarter.
 *
 * `apps/web` has no jsdom, so the desk is written as prop-driven cards and a
 * thin `PlayTab` that gathers the hooks and hands them down. The queue is
 * rendered over a **real queue of real `SubmittedAction`s validated by the real
 * engine**, because a queue card that agrees with a fixture and disagrees with
 * the validator is the exact failure this screen exists to prevent.
 *
 * What is pinned:
 *
 * 1. **The order**, read off the tab's own source: the quarter, the queue, the
 *    notes, the seal, the Chief of Staff, last quarter, the pipeline — and the
 *    phone's sticky Resolve bar last, so it comes to rest on the tab bar.
 * 2. **The queue is grouped by resolution phase**, in pipeline order, and a
 *    blocked row carries its own Confirm.
 * 3. **The gate is unchanged**: `ConfirmDialog` with `requireTyped="RESOLVE"`,
 *    and a blocked action still refuses the submission.
 * 4. **A committed quarter replaces onto the report sheet** rather than pushing
 *    the old `/quarter-resolution` route.
 * 5. **The eleven Chief-of-Staff-only instructions are named in English.** No
 *    action id ever reaches a founder.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ActionIntent, SessionState } from '@frontier/contracts';
import { RESOLUTION_PHASES } from '@frontier/contracts';
import { buildSubmittedAction, createSession, needsConfirmation, playerCompanyOf, validateSubmittedAction } from '../../../lib/game/engine';
import type { QueuedActionEntry } from '../../../lib/game/provider';
import { CHIEF_ONLY_ACTIONS, LEGACY_ROUTES, SHEETS, firstSegmentOf, sheetFrom, sheetHref } from '../../../lib/sheets';
import { TABS } from '../../../lib/nav';
import { quickPromptsFor } from '../chief-of-staff/quickPrompts';
import { titleise } from '../end-quarter/intents';
import { BeforeYouSubmitCard, LastQuarterCard, PipelineCard, QuarterCard, SealBar, SealCard } from './cards/play-cards';
import { QueueCard, groupQueueByPhase } from './cards/play-queue';
import { ChiefCard, chiefOnlyRows } from './cards/play-chief';

const DIR = fileURLToPath(new URL('.', import.meta.url));
const SOURCE = readFileSync(`${DIR}PlayTab.tsx`, 'utf8');

const TAB_PATHS = new Set(TABS.map((tab) => tab.href));

function hrefsIn(markup: string): string[] {
  return [...markup.matchAll(/href="([^"]*)"/g)].map((match) => (match[1] ?? '').replace(/&amp;/g, '&'));
}

function isTabAddress(href: string): boolean {
  const segment = firstSegmentOf(href);
  if (!TAB_PATHS.has(segment)) return false;
  const queryAt = href.indexOf('?');
  if (queryAt < 0) return true;
  const sheet = sheetFrom(href.slice(queryAt + 1).split('#')[0] ?? '');
  return sheet !== null && `/${SHEETS[sheet].tab}` === segment;
}

/* -------------------------------------------------------------------------- */
/*  A real two-item queue, one of them blocked                                 */
/* -------------------------------------------------------------------------- */

const session: SessionState = createSession();
const company = playerCompanyOf(session);

/** One queued instruction, validated by the engine exactly as the store does. */
function queued(intent: ActionIntent, sequence: number, confirmed: boolean): QueuedActionEntry {
  const action = buildSubmittedAction(session, intent, sequence, { confirmedByHuman: confirmed });
  return {
    action,
    validation: validateSubmittedAction(session, action),
    needsConfirmation: needsConfirmation(intent.type),
    blocked: needsConfirmation(intent.type) && !confirmed,
  };
}

// A cut is one of the always-confirm set and lands in talent resolution; a
// budget is not, and lands in research resolution — which comes later in the
// pipeline, so the grouping has an order to get right.
const cut = queued({ type: 'layoff', role: 'engineers', count: 1, severanceQuartersOfPay: 1 }, 1, false);
const budget = queued({ type: 'set_research_budget', budgetUsd: 1_000_000 }, 2, true);
const queue: readonly QueuedActionEntry[] = [budget, cut];

/* -------------------------------------------------------------------------- */
/*  The page                                                                   */
/* -------------------------------------------------------------------------- */

const CARDS = [
  'QuarterCard',
  'QueueCard',
  'BeforeYouSubmitCard',
  'SealCard',
  'ChiefCard',
  'LastQuarterCard',
  'PipelineCard',
  'SealBar',
] as const;

describe('the Play tab is the desk, in the plan’s order', () => {
  it('renders every card in that order and mounts each exactly once', () => {
    const positions = CARDS.map((name) => ({ name, at: SOURCE.indexOf(`<${name}`) }));
    for (const entry of positions) expect(entry.at, `${entry.name} is not mounted`).toBeGreaterThan(-1);
    for (let index = 1; index < positions.length; index += 1) {
      const previous = positions[index - 1];
      const current = positions[index];
      if (previous === undefined || current === undefined) throw new Error('card list is malformed');
      expect(current.at, `${current.name} must come after ${previous.name}`).toBeGreaterThan(previous.at);
    }
    for (const name of CARDS) expect(SOURCE.split(`<${name}`).length - 1, `${name} is mounted twice`).toBe(1);
  });

  it('keeps the gate: the typed word, and no submission while anything is blocked', () => {
    expect(SOURCE).toContain('requireTyped="RESOLVE"');
    expect(SOURCE).toContain('blocked.length === 0 && !resolving');
  });

  it('opens the report as a sheet over this tab instead of pushing the old route', () => {
    expect(SOURCE).toContain("router.replace(sheetHref('resolution'))");
    // The folder of that name is still imported for `lineCount`; what must be
    // gone is the *address*, as a quoted route literal.
    expect(SOURCE).not.toMatch(/['"]\/quarter-resolution['"]/);
    expect(sheetHref('resolution')).toBe('/play?sheet=resolution');
  });

  it('carries none of the tray’s spacing hack, and no old route in its source', () => {
    expect(SOURCE).not.toContain('trayLifted');
    for (const route of Object.keys(LEGACY_ROUTES)) {
      if (TAB_PATHS.has(route)) continue;
      expect(SOURCE.includes(`'${route}'`), `${route} is written out in PlayTab.tsx`).toBe(false);
      expect(SOURCE.includes(`"${route}"`), `${route} is written out in PlayTab.tsx`).toBe(false);
    }
  });
});

/* -------------------------------------------------------------------------- */
/*  The queue                                                                  */
/* -------------------------------------------------------------------------- */

describe('the queue card', () => {
  const groups = groupQueueByPhase(queue);
  const markup = renderToStaticMarkup(
    <QueueCard
      groups={groups}
      queued={queue.length}
      startYear={session.startYear}
      resolving={false}
      companyGroups={[]}
      companyNameOf={() => company.name}
      onConfirm={() => undefined}
      onRemove={() => undefined}
      onClear={() => undefined}
    />,
  );

  it('folds a two-item queue into its two phases, in pipeline order', () => {
    expect(groups).toHaveLength(2);
    expect(groups.map((group) => group.phase)).toEqual(['talent_resolution', 'research_resolution']);
    const order = groups.map((group) => RESOLUTION_PHASES.indexOf(group.phase));
    expect(order[1]).toBeGreaterThan(order[0] as number);
    expect(groups[0]?.entries).toHaveLength(1);
    expect(groups[1]?.entries).toHaveLength(1);
  });

  it('prints each phase heading in that order', () => {
    const talentAt = markup.indexOf(titleise('talent_resolution'));
    const researchAt = markup.indexOf(titleise('research_resolution'));
    expect(talentAt).toBeGreaterThan(-1);
    expect(researchAt).toBeGreaterThan(talentAt);
  });

  it('puts a Confirm on the blocked row, and only on that one', () => {
    expect(cut.blocked).toBe(true);
    expect(budget.blocked).toBe(false);
    expect(markup.split('>Confirm<').length - 1).toBe(1);
    expect(markup).toContain('always requires an explicit human confirmation');
  });

  it('offers Remove on every row, and one Clear all for the queue', () => {
    expect(markup.split('aria-label="Remove ').length - 1).toBe(queue.length);
    expect(markup).toContain('Clear all');
  });

  it('says a quarter with nothing queued is legal rather than showing an empty list', () => {
    const empty = renderToStaticMarkup(
      <QueueCard
        groups={[]}
        queued={0}
        startYear={session.startYear}
        resolving={false}
        companyGroups={[]}
        companyNameOf={() => company.name}
        onConfirm={() => undefined}
        onRemove={() => undefined}
        onClear={() => undefined}
      />,
    );
    expect(empty).toContain('Nothing queued for this quarter');
    expect(empty).not.toContain('Clear all');
  });
});

/* -------------------------------------------------------------------------- */
/*  The rest of the desk                                                       */
/* -------------------------------------------------------------------------- */

const restOfDesk = [
  renderToStaticMarkup(
    <QuarterCard quarter="Q3 2027" lastResolved="Q2 2027" queued={2} blocked={1} resolving={false} company={company} netSpendUsd={250_000} />,
  ),
  renderToStaticMarkup(
    <BeforeYouSubmitCard blocked={1} rejected={1} outflowUsd={9_000_000} availableUsd={4_000_000} afterUsd={-5_000_000} solvencyLine="One more quarter below zero winds the company up." />,
  ),
  renderToStaticMarkup(
    <SealCard
      quarter="Q3 2027"
      nextQuarter="Q4 2027"
      canSubmit
      resolving={false}
      status=""
      queued={2}
      blocked={0}
      outflowUsd={1_000_000}
      availableUsd={4_000_000}
      onArm={() => undefined}
    />,
  ),
  renderToStaticMarkup(
    <LastQuarterCard
      summary={{
        quarter: 'Q2 2027',
        headline: 'Export restriction announced; compute price up 11%.',
        lines: 42,
        ledgerRows: 118,
        phasesRun: 17,
        invariantsPassed: 9,
        invariantsFailed: 0,
        committed: true,
      }}
    />,
  ),
  renderToStaticMarkup(<PipelineCard modelLine="No model is configured." timings={[]} live={false} />),
  renderToStaticMarkup(<SealBar quarter="Q3 2027" canSubmit resolving={false} queued={2} blocked={0} onArm={() => undefined} />),
].join('\n');

describe('the rest of the desk', () => {
  it('states the quarter, its counts and where cash lands', () => {
    expect(restOfDesk).toContain('Q3 2027');
    expect(restOfDesk).toContain('Q2 2027 is committed.');
    expect(restOfDesk).toContain('Instructions');
    expect(restOfDesk).toContain('Cash at the close');
  });

  it('sticks the three notes to the desk when there is something to say', () => {
    expect(restOfDesk).toContain('Needs your hand');
    expect(restOfDesk).toContain('Will not run');
    expect(restOfDesk).toContain('More than you hold');
    expect(restOfDesk).toContain('One more quarter below zero winds the company up.');
  });

  it('says nothing at all when there is nothing to say', () => {
    const quiet = renderToStaticMarkup(
      <BeforeYouSubmitCard blocked={0} rejected={0} outflowUsd={10} availableUsd={4_000_000} afterUsd={3_999_990} solvencyLine={null} />,
    );
    expect(quiet).toBe('');
  });

  it('offers Resolve on the phone bar as well as the seal', () => {
    expect(restOfDesk.split('Resolve Q3 2027').length - 1).toBeGreaterThanOrEqual(1);
    expect(restOfDesk).toContain('you type the word to confirm');
  });

  it('reads last quarter off the report and opens the full one', () => {
    expect(restOfDesk).toContain('Export restriction announced');
    expect(restOfDesk).toContain('Read the full report');
    expect(hrefsIn(restOfDesk)).toContain(sheetHref('resolution'));
  });

  it('keeps the pipeline folded and never asserts a stale phase count', () => {
    expect(restOfDesk).toContain(`${RESOLUTION_PHASES.length} phases`);
    expect(restOfDesk).toContain('Show the pipeline');
    expect(restOfDesk).not.toContain(titleise('node_market_resolution'));
  });

  it('never writes an old route into an address', () => {
    for (const href of hrefsIn(restOfDesk)) expect(isTabAddress(href), `${href} is not a tab address`).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/*  The Chief of Staff as the shortcut                                         */
/* -------------------------------------------------------------------------- */

describe('things only the Chief of Staff can do', () => {
  const rows = chiefOnlyRows();
  const markup = renderToStaticMarkup(<ChiefCard prompts={quickPromptsFor('/play', null)} />);

  it('names every one of the eleven, and no others', () => {
    expect(rows).toHaveLength(11);
    expect(rows.map((row) => row.type).sort()).toEqual([...CHIEF_ONLY_ACTIONS].sort());
  });

  it('never shows a founder an action id', () => {
    for (const row of rows) {
      expect(row.label, row.type).not.toMatch(/_[a-z]+_/);
      expect(row.ask, row.type).not.toMatch(/_[a-z]+_/);
      expect(row.label.length, row.type).toBeGreaterThan(3);
    }
    expect(markup).not.toMatch(/_[a-z]+_/);
    expect(markup).toContain('Take the company public');
  });

  it('offers the four Play prompts and the full thread', () => {
    for (const prompt of quickPromptsFor('/play', null)) expect(markup).toContain(prompt.label);
    expect(markup).toContain('Open the full thread');
    expect(hrefsIn(markup)).toContain(sheetHref('chief-of-staff'));
  });
});
