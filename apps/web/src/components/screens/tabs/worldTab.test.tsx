/**
 * The World tab: the paper first, and nothing about the world more than a tap
 * away.
 *
 * `apps/web` has no jsdom, so the page is written as six prop-driven cards and a
 * thin `WorldTab` that gathers the hooks and hands them down. The cards are
 * rendered to static markup over a **real world-3 session with two quarters
 * resolved** — the projection the News screen itself reads — and the order of
 * the cards is read off the tab's own source, with the TypeScript file as the
 * evidence.
 *
 * What is pinned:
 *
 * 1. **The order.** Paper, social, people, standing, the economy, the readings.
 *    The paper leads because burying the news is the complaint this whole
 *    redesign is written against.
 * 2. **The lead headline is on the page.** Not a link to the paper — the
 *    headline itself, from `projectPublicRecord`, plus three briefs.
 * 3. **Five section chips, each addressing its own section.**
 * 4. **No address here is an old route.** Every `href` is a tab, or a sheet over
 *    the tab that owns it.
 * 5. **The readings are folded.** Ten world dials are on World and nowhere else,
 *    and they are closed until asked for.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PlayerView, PublicRecordItem, SessionState } from '@frontier/contracts';
import { NewGameSetupSchema } from '@frontier/contracts';
import { projectPublicRecord } from '@frontier/simulation';
import { PLAYER_ID, createSession, getEngine } from '../../../lib/game/engine';
import { projectPlayerView } from '../../../lib/game/playerView';
import { LEGACY_ROUTES, SHEETS, firstSegmentOf, sheetFrom, sheetHref } from '../../../lib/sheets';
import { TABS } from '../../../lib/nav';
import { NEWS_SECTIONS, SECTION_LABEL } from '../news/layout';
import { buildDirectory } from '../network/directory';
import { groupByRing, type Ring } from '../network/rings';
import { WorldStrip } from '../command-centre/WorldStrip';
import { EconomyCard, PaperCard, PeopleCard, SocialCard, StandingCard, WorldReadingsCard } from './cards/world-cards';

const DIR = fileURLToPath(new URL('.', import.meta.url));
const SOURCE = readFileSync(`${DIR}WorldTab.tsx`, 'utf8');

const SETUP = NewGameSetupSchema.parse({
  companyName: 'Northwind AI',
  founderName: 'Rae Fontaine',
  backgroundId: 'consumer_ai',
  worldVersion: 3,
});

/** The demo world after two resolved quarters, offline (no model). */
function playedTwoQuarters(): { session: SessionState; view: PlayerView } {
  let session = createSession({ setup: SETUP });
  for (let quarter = 0; quarter < 2; quarter += 1) {
    session = getEngine().resolver.resolveQuarter(session, [], null, []).nextState;
  }
  return { session, view: projectPlayerView(session) };
}

const { session, view } = playedTwoQuarters();

const record: PublicRecordItem[] = projectPublicRecord(session, PLAYER_ID, {});
const edition = Math.max(...record.map((item) => item.quarter));
const frontPage = record.filter((item) => item.quarter === edition);

const TAB_PATHS = new Set(TABS.map((tab) => tab.href));

function hrefsIn(markup: string): string[] {
  return [...markup.matchAll(/href="([^"]*)"/g)].map((match) => (match[1] ?? '').replace(/&amp;/g, '&'));
}

/** A tab, or a sheet over the tab that owns it. Anything else escaped the registry. */
function isTabAddress(href: string): boolean {
  const segment = firstSegmentOf(href);
  if (!TAB_PATHS.has(segment)) return false;
  const queryAt = href.indexOf('?');
  if (queryAt < 0) return true;
  const sheet = sheetFrom(href.slice(queryAt + 1).split('#')[0] ?? '');
  return sheet !== null && `/${SHEETS[sheet].tab}` === segment;
}

/* -------------------------------------------------------------------------- */
/*  The page                                                                   */
/* -------------------------------------------------------------------------- */

const CARDS = ['PaperCard', 'SocialCard', 'PeopleCard', 'StandingCard', 'EconomyCard', 'WorldReadingsCard'] as const;

describe('the World tab is six cards in the plan’s order', () => {
  it('renders them in that order and mounts each exactly once', () => {
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

  it('writes no old route into the tab’s own source', () => {
    for (const route of Object.keys(LEGACY_ROUTES)) {
      if (TAB_PATHS.has(route)) continue;
      expect(SOURCE.includes(`'${route}'`), `${route} is written out in WorldTab.tsx`).toBe(false);
      expect(SOURCE.includes(`"${route}"`), `${route} is written out in WorldTab.tsx`).toBe(false);
    }
  });
});

/* -------------------------------------------------------------------------- */
/*  The paper                                                                  */
/* -------------------------------------------------------------------------- */

describe('the paper card', () => {
  const lead = frontPage[0] ?? null;
  const markup = renderToStaticMarkup(
    <PaperCard
      masthead="Q3 2027 · edition 3 · 3 on the record"
      lead={lead}
      briefs={frontPage.slice(1)}
      narrative={view.world.media.dominantNarrative}
      controversy={view.world.media.controversyIntensity}
    />,
  );

  it('prints a real lead headline from the projection, not a link to one', () => {
    expect(lead, 'two resolved quarters put nothing on the public record').not.toBeNull();
    if (lead === null) return;
    expect(markup).toContain(lead.headline);
    expect(markup).toContain(lead.who.name);
  });

  it('prints three briefs under it, and no more', () => {
    const shown = frontPage.slice(1, 4);
    for (const item of shown) expect(markup).toContain(item.headline);
    const fourth = frontPage[4];
    if (fourth !== undefined && !shown.some((item) => item.headline === fourth.headline)) {
      expect(markup).not.toContain(fourth.headline);
    }
  });

  it('offers the five sections, each opening the paper turned to it', () => {
    const hrefs = hrefsIn(markup);
    for (const section of NEWS_SECTIONS) {
      expect(markup).toContain(SECTION_LABEL[section]);
      const expected = section === 'front' ? sheetHref('news') : sheetHref('news', { section });
      expect(hrefs, `${section} does not address itself`).toContain(expected);
    }
    expect(sheetHref('news', { section: 'world' })).toBe('/world?sheet=news&section=world');
  });

  it('says so plainly when nothing has gone to press', () => {
    const empty = renderToStaticMarkup(
      <PaperCard masthead="no edition has printed" lead={null} briefs={[]} narrative="neutral" controversy={0} />,
    );
    expect(empty).toContain('No edition has gone to press');
  });
});

/* -------------------------------------------------------------------------- */
/*  Everything else on the page                                                */
/* -------------------------------------------------------------------------- */

const directory = buildDirectory(session, view, view.playerId);
const rings = groupByRing(directory);
const reach: Record<Ring, number> = { inner: 0, middle: 0, outer: 0 };
for (const group of rings) reach[group.ring] = group.entries.length;
const inner = rings.find((group) => group.ring === 'inner')?.entries ?? [];

const restOfPage = [
  renderToStaticMarkup(
    <SocialCard
      narrative={view.world.media.dominantNarrative}
      attention={view.world.media.attentionLevel}
      controversy={view.world.media.controversyIntensity}
      trending={[{ id: 'post_a', headline: 'A founder says the quiet part', author: 'Rae Fontaine', reach: 41_000, isAi: false }]}
      lastPost={{ text: 'We are hiring.', quarterLabel: 'Q2 2027' }}
      followers={12_400}
    />,
  ),
  renderToStaticMarkup(<PeopleCard connection={31} reach={reach} people={inner.slice(0, 3).map((entry) => entry.character)} />),
  renderToStaticMarkup(
    <StandingCard
      founderIndex={{ value: 0.41, rank: 6 }}
      companyValue={{ value: 310_000_000, rank: 4 }}
      wealth={{ value: 90_000_000, rank: 5 }}
      network={{ value: 31, rank: 9 }}
    />,
  ),
  renderToStaticMarkup(
    <EconomyCard
      sectorLabel="Consumer AI"
      regionLabel="North America"
      multiSector
      priceIndex={104}
      shortage={12}
      supplyUsd={4_200_000_000}
      tollPct={3}
      tollCaption="Harbourline holds 61% of the freight here and charges 3% of 12%."
    />,
  ),
  renderToStaticMarkup(<WorldReadingsCard world={session.world} previous={null} />),
].join('\n');

describe('the rest of the World page', () => {
  it('states the press cycle, the loudest post and what you last said', () => {
    expect(restOfPage).toContain('Press cycle');
    expect(restOfPage).toContain('A founder says the quiet part');
    expect(restOfPage).toContain('Your last post');
    expect(restOfPage).toContain('We are hiring.');
  });

  it('counts the three rings the network screen draws, from the same directory', () => {
    expect(reach.inner + reach.middle + reach.outer).toBe(directory.length);
    expect(restOfPage).toContain('Reachable now');
    expect(restOfPage).toContain('Needs an introduction');
    expect(restOfPage).toContain('Out of reach');
    for (const entry of inner.slice(0, 3)) expect(restOfPage).toContain(entry.character.name);
  });

  it('states the four standings with their ranks', () => {
    expect(restOfPage).toContain('Founder Index');
    expect(restOfPage).toContain('Rank #6');
    expect(restOfPage).toContain('Rank #4');
  });

  it('states your own sector price, shortage, supply and freight toll', () => {
    expect(restOfPage).toContain('Your sector price');
    expect(restOfPage).toContain('short -12%');
    expect(restOfPage).toContain('Sector supply');
    expect(restOfPage).toContain('Freight toll');
  });

  it('keeps the ten readings folded until they are asked for', () => {
    expect(restOfPage).toContain('World readings');
    expect(restOfPage).toContain('Show');
    // The strip really does carry that row, so its absence above is the fold
    // rather than the test passing for the wrong reason.
    expect(renderToStaticMarkup(<WorldStrip world={session.world} previous={null} />)).toContain('Dominant narrative');
    expect(restOfPage).not.toContain('Dominant narrative');
  });

  it('says a single-sector session is one, rather than printing a zero', () => {
    const single = renderToStaticMarkup(
      <EconomyCard
        sectorLabel="Frontier AI"
        regionLabel="North America"
        multiSector={false}
        priceIndex={null}
        shortage={null}
        supplyUsd={null}
        tollPct={null}
        tollCaption={null}
      />,
    );
    expect(single).toContain('This session runs a single sector');
  });

  it('does not call a six-sector world single-sector because no quarter has resolved', () => {
    // `priceIndex` is null until the first resolution files a sector row. Reading
    // that as "one industry, one price" told a six-sector session the opposite of
    // what its own Sector sheet says one tap later.
    const unresolved = renderToStaticMarkup(
      <EconomyCard
        sectorLabel="Consumer AI"
        regionLabel="North America"
        multiSector
        priceIndex={null}
        shortage={null}
        supplyUsd={null}
        tollPct={null}
        tollCaption={null}
      />,
    );
    expect(unresolved).not.toContain('This session runs a single sector');
    expect(unresolved).toContain('Your sector price');
    // The Sector sheet's own words for the same missing row.
    expect(unresolved).toContain('Set when the first quarter resolves');
    expect(readFileSync(`${DIR}../sector/SectorScreen.tsx`, 'utf8')).toContain('Set when the first quarter resolves');
    // The tab asks the sheet's question, not the price row's.
    expect(SOURCE).toContain('sectorsPresent([company, ...view.visibleCompanies]).length > 1');
  });

  it('never writes an old route into an address', () => {
    const hrefs = hrefsIn(restOfPage);
    expect(hrefs.length).toBeGreaterThan(2);
    for (const href of hrefs) expect(isTabAddress(href), `${href} is not a tab address`).toBe(true);
  });
});
