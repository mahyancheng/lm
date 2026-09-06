/**
 * Home — my company at a glance, checked without a browser.
 *
 * `apps/web` has no jsdom, so the page is written as five prop-driven cards and
 * a thin `HomeTab` that gathers the hooks and hands them down. That split is
 * what makes this test possible: every card below is rendered to static markup
 * over a **real world-3 session with two quarters resolved** — the state the
 * acceptance is written against — rather than over a fixture that could drift
 * from what the engine actually produces.
 *
 * Four things are pinned:
 *
 * 1. **The six figures, in reading order.** Cash, revenue, gross margin,
 *    runway, market cap, headcount. The order is the order a founder checks
 *    whether anything else this quarter matters, so it is an assertion rather
 *    than a layout accident.
 * 2. **No address on this page is an old route.** Every `href` the cards
 *    render is one of the five tabs, or a sheet over the tab that owns it —
 *    including the feed lines, which are *built* with old addresses
 *    (`/capital`, `/news?section=world`) and must be rewritten by `AlertFeed`
 *    through `legacyHref` before they reach the DOM. The feed is checked to
 *    still carry legacy addresses at source, or the test would pass for the
 *    wrong reason.
 * 3. **The offers card exists only when there is an offer.** A heading over an
 *    empty inbox is worse than no heading.
 * 4. **The queue is stated on Home.** The first row of "Needs deciding" says
 *    how many instructions are queued and how many are unconfirmed, and opens
 *    the Play desk — the always-visible way to advance time, from Home.
 *
 * `HomeTab` itself reads the store and cannot be rendered here; it is checked
 * by source, which is also how the raw-legacy-href rule is enforced on it.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Company, DealProposal, PlayerView, SessionState } from '@frontier/contracts';
import { DealProposalSchema, NewGameSetupSchema, quarterLabel } from '@frontier/contracts';
import type { FrontierResolutionOutcome } from '@frontier/simulation';
import { createSession, getEngine } from '../../../lib/game/engine';
import { marketCapOf, metricsFor, projectPlayerView, quotesFor } from '../../../lib/game/playerView';
import { LEGACY_ROUTES, SHEETS, firstSegmentOf, sheetFrom, sheetHref, tabPath } from '../../../lib/sheets';
import { buildFeed, type FeedItem } from '../command-centre/feed';
import { offerInbox } from '../street/model';
import { FiguresGrid } from './FiguresGrid';
import { FloorCard } from './FloorCard';
import { FEED_LIMIT, NeedsDeciding } from './NeedsDeciding';
import { ObjectivesCard } from './ObjectivesCard';
import { OffersCard } from './OffersCard';

/* -------------------------------------------------------------------------- */
/*  The world Home is read against                                             */
/* -------------------------------------------------------------------------- */

const SETUP = NewGameSetupSchema.parse({
  companyName: 'Northwind AI',
  founderName: 'Rae Fontaine',
  backgroundId: 'consumer_ai',
  worldVersion: 3,
});

/** The demo company after two resolved quarters, offline (no model). */
function playedTwoQuarters(): { session: SessionState; view: PlayerView; company: Company; outcome: FrontierResolutionOutcome } {
  let session = createSession({ setup: SETUP });
  let outcome: FrontierResolutionOutcome | null = null;
  for (let quarter = 0; quarter < 2; quarter += 1) {
    outcome = getEngine().resolver.resolveQuarter(session, [], null, []);
    session = outcome.nextState;
  }
  if (outcome === null) throw new Error('nothing resolved');
  const view = projectPlayerView(session);
  return { session, view, company: view.ownCompany, outcome };
}

const { session, view, company, outcome } = playedTwoQuarters();
const feed: FeedItem[] = buildFeed(session, view, outcome, 1);

const TAB_PATHS: readonly string[] = ['home', 'company', 'market', 'world', 'play'].map((tab) => `/${tab}`);

/** Every `href` in a rendered fragment. */
function hrefsIn(markup: string): string[] {
  return [...markup.matchAll(/href="([^"]*)"/g)].map((match) => match[1] ?? '');
}

/**
 * Is this address one of the five tabs, or a sheet over the tab that owns it?
 *
 * Anything else — `/financials`, `/news?section=world`, a sheet asked for over
 * the wrong tab — is an old route that escaped `legacyHref`/`sheetHref`.
 */
function isTabAddress(href: string): boolean {
  const segment = firstSegmentOf(href);
  if (!TAB_PATHS.includes(segment)) return false;
  const queryAt = href.indexOf('?');
  if (queryAt < 0) return true;
  const search = href.slice(queryAt + 1).split('#')[0] ?? '';
  const sheet = sheetFrom(search);
  return sheet !== null && `/${SHEETS[sheet].tab}` === segment;
}

/** A term sheet offered to this company, on the engine's own answerability clock. */
function termSheetDeal(quarter: number): DealProposal {
  return DealProposalSchema.parse({
    id: 'deal_home_test',
    proposerId: 'chr_capital',
    proposerKind: 'character',
    counterpartyId: company.id,
    counterpartyKind: 'company',
    status: 'proposed',
    createdQuarter: Math.max(0, quarter - 1),
    respondedQuarter: null,
    conversationId: null,
    breachedByPartyId: null,
    confidentiality: 'private',
    expiresQuarter: quarter + 2,
    binding: true,
    intentStatements: [],
    summary: 'A venture desk offers primary capital at a priced round.',
    gets: [],
    gives: [
      {
        kind: 'term_sheet',
        entityId: 'fund_seawall',
        companyId: company.id,
        stage: 'series_b',
        amountUsd: 60_000_000,
        preMoneyUsd: 340_000_000,
        dilutionPct: 15,
        boardSeats: 1,
        proRata: true,
        protectiveProvisions: false,
        liquidationPreferenceMultiple: 1,
        participating: false,
      },
    ],
  });
}

const figures = renderToStaticMarkup(
  <FiguresGrid
    company={company}
    metrics={metricsFor(session, company.id)}
    marketCap={marketCapOf(session, company.id)}
    quotes={company.instrumentId === null ? [] : quotesFor(session, company.instrumentId)}
  />,
);

/* -------------------------------------------------------------------------- */
/*  1. The six figures                                                         */
/* -------------------------------------------------------------------------- */

describe('the six figures', () => {
  it('are stated in reading order, each opening the sheet that decomposes it', () => {
    const labels = ['Cash', 'Revenue', 'Gross margin', 'Runway', 'Market cap', 'Headcount'];
    const positions = labels.map((label) => figures.indexOf(`>${label}<`));
    for (const [index, position] of positions.entries()) {
      expect(position, `${labels[index] ?? ''} is missing from Home`).toBeGreaterThan(-1);
      if (index > 0) expect(position, `${labels[index] ?? ''} is out of order`).toBeGreaterThan(positions[index - 1] ?? -1);
    }
    expect(hrefsIn(figures)).toEqual([
      sheetHref('financials'),
      sheetHref('financials'),
      sheetHref('financials'),
      sheetHref('capital'),
      sheetHref('exchange'),
      sheetHref('people'),
    ]);
  });

  it('carries the solvency reading on cash and the open roles on headcount', () => {
    // The wind-up clock is derived from the filed statements; Home says where
    // this company stands on it rather than making the founder open a sheet.
    expect(figures).toContain('quarters below zero');
    expect(figures).toContain(`${company.employees.openRoles} open roles`);
  });
});

/* -------------------------------------------------------------------------- */
/*  2. No old address survives to the DOM                                      */
/* -------------------------------------------------------------------------- */

describe('every address on Home', () => {
  const page = [
    renderToStaticMarkup(<FloorCard company={company} quarter={quarterLabel(session.startYear, session.quarter)} />),
    figures,
    renderToStaticMarkup(<NeedsDeciding items={feed} queued={3} unconfirmed={1} />),
    renderToStaticMarkup(<OffersCard offers={offerInbox({ deals: [termSheetDeal(session.quarter)], campaigns: [], companyIds: new Set([company.id]), quarter: session.quarter })} startYear={session.startYear} />),
    renderToStaticMarkup(<ObjectivesCard objectives={view.objectives} />),
  ].join('');

  it('is a tab path, and none of them is one of the twenty-two old routes', () => {
    const hrefs = hrefsIn(page);
    expect(hrefs.length).toBeGreaterThan(6);
    for (const href of hrefs) expect(isTabAddress(href), `${href} is not a tab or a sheet over one`).toBe(true);
  });

  it('rewrites the feed, which is built with old addresses', () => {
    // Guard against passing for the wrong reason: if the feed ever stops
    // emitting old routes, the check above proves nothing about `legacyHref`.
    expect(feed.some((item) => LEGACY_ROUTES[firstSegmentOf(item.href)] !== undefined)).toBe(true);
    const rendered = renderToStaticMarkup(<NeedsDeciding items={feed} queued={0} unconfirmed={0} />);
    const hrefs = hrefsIn(rendered);
    expect(hrefs.length).toBeGreaterThan(1);
    for (const href of hrefs) expect(isTabAddress(href), `${href} reached the DOM unrewritten`).toBe(true);
  });

  it('keeps HomeTab itself off the old routes', () => {
    const dir = fileURLToPath(new URL('.', import.meta.url));
    const source = readFileSync(`${dir}../tabs/HomeTab.tsx`, 'utf8');
    for (const route of Object.keys(LEGACY_ROUTES)) {
      expect(source, `HomeTab links at ${route} directly`).not.toContain(`"${route}"`);
      expect(source, `HomeTab pushes ${route} directly`).not.toContain(`'${route}'`);
    }
    // And it mounts the five cards, so the page is the page the plan describes.
    for (const card of ['FloorCard', 'FiguresGrid', 'NeedsDeciding', 'OffersCard', 'ObjectivesCard', 'TapeStrip']) {
      expect(source).toContain(`<${card}`);
    }
  });
});

/* -------------------------------------------------------------------------- */
/*  3. Offers                                                                  */
/* -------------------------------------------------------------------------- */

describe('the offers card', () => {
  it('is absent when nothing has been offered', () => {
    expect(renderToStaticMarkup(<OffersCard offers={[]} startYear={session.startYear} />)).toBe('');
  });

  it('states the offer, counts what is answerable, and opens The Street', () => {
    const offers = offerInbox({
      deals: [termSheetDeal(session.quarter)],
      campaigns: [],
      companyIds: new Set([company.id]),
      quarter: session.quarter,
    });
    expect(offers).toHaveLength(1);
    const markup = renderToStaticMarkup(<OffersCard offers={offers} startYear={session.startYear} />);
    expect(markup).toContain('Offers');
    // The engine's own figures, formatted once: the cheque, the pre-money, the
    // percentage sold.
    expect(markup).toContain('pre-money for 15%');
    expect(markup).toContain('1 to answer');
    expect(hrefsIn(markup).every((href) => href === sheetHref('street'))).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/*  4. The queue, on Home                                                      */
/* -------------------------------------------------------------------------- */

describe('needs deciding', () => {
  it('leads with the queue and opens the desk', () => {
    const markup = renderToStaticMarkup(<NeedsDeciding items={feed} queued={4} unconfirmed={2} />);
    expect(markup).toContain('>4</span> queued');
    expect(markup).toContain('>2</span> unconfirmed');
    expect(markup).toContain(`href="${tabPath('play')}"`);
    // The row is a thumb target, not a line of text.
    expect(markup).toContain('tap-target');
  });

  it('caps the feed and counts the rest', () => {
    expect(feed.length).toBeGreaterThan(FEED_LIMIT);
    const markup = renderToStaticMarkup(<NeedsDeciding items={feed} queued={0} unconfirmed={0} />);
    const beyond = feed[FEED_LIMIT];
    if (beyond === undefined) throw new Error('the feed shrank below the cap');
    expect(markup).not.toContain(beyond.text);
    expect(markup).toContain(`${feed.length - FEED_LIMIT} more`);
  });

  it('says so when nothing is asking for an answer', () => {
    const markup = renderToStaticMarkup(<NeedsDeciding items={[]} queued={0} unconfirmed={0} />);
    expect(markup).toContain('Nothing is asking for you');
    expect(markup).not.toContain('more · open the desk');
  });
});
