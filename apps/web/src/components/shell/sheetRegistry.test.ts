/**
 * The sheet registry: the one map every address in the game now goes through.
 *
 * Three things can break silently here and nothing else would catch them:
 * a sheet declared but never mounted (the drawer opens empty), an old route
 * dropped from `LEGACY_ROUTES` (a bookmark 404s), and an action type whose
 * by-hand link points at a screen that no longer exists. All three are string
 * lookups, so they are checked here rather than trusted.
 *
 * `SheetHost.tsx` is read as text: it is a `.tsx` full of client components and
 * importing it would drag the whole screen tree into this test for the sake of
 * a `switch` statement.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ACTION_TYPES } from '@frontier/contracts';
import { describe, expect, it } from 'vitest';
import {
  CHIEF_ONLY_ACTIONS,
  LEGACY_ROUTES,
  SHEETS,
  SHEET_OF_ACTION,
  allSheetIds,
  hrefOfAction,
  legacyHref,
  sheetFrom,
  sheetHref,
  sheetsOfTab,
  tabPath,
  type TabId,
} from '../../lib/sheets';

const TAB_IDS: readonly TabId[] = ['home', 'company', 'market', 'world', 'play'];

const iconSource = readFileSync(fileURLToPath(new URL('../ui/icons.tsx', import.meta.url)), 'utf8');
const hostSource = readFileSync(fileURLToPath(new URL('./SheetHost.tsx', import.meta.url)), 'utf8');

function declaredIcons(): ReadonlySet<string> {
  const block = /export const ICON_NAMES = \[([\s\S]*?)\] as const;/.exec(iconSource);
  if (block === null) throw new Error('ICON_NAMES is no longer a plain array literal in icons.tsx');
  return new Set([...(block[1] ?? '').matchAll(/'([A-Za-z]+)'/g)].map((match) => match[1] ?? ''));
}

describe('every sheet', () => {
  const icons = declaredIcons();

  it('has an entry naming a real tab and a real mark', () => {
    expect(allSheetIds().length).toBe(20);
    for (const id of allSheetIds()) {
      const meta = SHEETS[id];
      expect(TAB_IDS, `${id} sits on the "${meta.tab}" tab`).toContain(meta.tab);
      expect(icons.has(meta.icon), `${id} asks for the "${meta.icon}" mark`).toBe(true);
      expect(meta.title.length).toBeGreaterThan(0);
      expect(meta.blurb.length).toBeGreaterThan(0);
    }
  });

  it('is mounted by the host', () => {
    for (const id of allSheetIds()) {
      expect(hostSource.includes(`case '${id}':`), `SheetHost has no case for "${id}"`).toBe(true);
    }
  });

  it('round-trips through its own href', () => {
    for (const id of allSheetIds()) {
      const href = sheetHref(id);
      expect(href.startsWith(tabPath(SHEETS[id].tab))).toBe(true);
      expect(sheetFrom(href.slice(href.indexOf('?')))).toBe(id);
    }
  });

  it('belongs to exactly one tab, and every tab but Home owns some', () => {
    const counted = TAB_IDS.flatMap((tab) => sheetsOfTab(tab));
    expect([...counted].sort()).toEqual([...allSheetIds()].sort());
    // Home is the company at a glance: it states figures and opens other tabs'
    // sheets, so it owns none of its own.
    expect(sheetsOfTab('home')).toEqual([]);
    for (const tab of ['company', 'market', 'world', 'play'] as const) {
      expect(sheetsOfTab(tab).length, `${tab} owns no sheets`).toBeGreaterThan(0);
    }
  });
});

describe('every old address', () => {
  // The twenty-two routes the game had before the five tabs.
  const OLD = [
    '/command-centre',
    '/company',
    '/group',
    '/products',
    '/sector',
    '/people',
    '/financials',
    '/research',
    '/government',
    '/deal-room',
    '/markets',
    '/capital',
    '/portfolio',
    '/street',
    '/boardroom',
    '/news',
    '/social',
    '/network',
    '/leaderboard',
    '/chief-of-staff',
    '/end-quarter',
    '/quarter-resolution',
  ] as const;

  it('is covered, and lands on a sheet that exists', () => {
    expect(Object.keys(LEGACY_ROUTES).sort()).toEqual([...OLD].sort());
    for (const route of OLD) {
      const entry = LEGACY_ROUTES[route];
      expect(entry, `${route} is not in LEGACY_ROUTES`).toBeDefined();
      if (entry === undefined) continue;
      expect(TAB_IDS).toContain(entry.tab);
      if (entry.sheet === null) {
        // Only the two screens that became tabs in their own right.
        expect(['/command-centre', '/end-quarter']).toContain(route);
      } else {
        expect(SHEETS[entry.sheet]).toBeDefined();
        expect(SHEETS[entry.sheet].tab).toBe(entry.tab);
      }
    }
  });

  it('rewrites to the new one, keeping the query and the fragment', () => {
    expect(legacyHref('/news?section=world')).toBe('/world?sheet=news&section=world');
    expect(legacyHref('/people#headcount')).toBe('/company?sheet=people#headcount');
    expect(legacyHref('/command-centre')).toBe('/home');
    expect(legacyHref('/end-quarter')).toBe('/play');
    expect(legacyHref('/markets')).toBe('/market?sheet=exchange');
    expect(legacyHref('/quarter-resolution')).toBe('/play?sheet=resolution');
  });

  it('leaves everything else alone', () => {
    expect(legacyHref('/home')).toBe('/home');
    expect(legacyHref('/play?sheet=resolution')).toBe('/play?sheet=resolution');
    expect(legacyHref('/sign-in')).toBe('/sign-in');
    expect(legacyHref('https://example.com/news')).toBe('https://example.com/news');
  });
});

describe('every instruction', () => {
  it('says where it is done by hand, or that it cannot be', () => {
    for (const type of ACTION_TYPES) {
      expect(Object.prototype.hasOwnProperty.call(SHEET_OF_ACTION, type), `${type} has no entry`).toBe(true);
      const sheet = SHEET_OF_ACTION[type];
      if (sheet === null) expect(hrefOfAction(type)).toBeNull();
      else expect(hrefOfAction(type)).toBe(sheetHref(sheet));
    }
  });

  // Eleven of fifty-two have no panel anywhere. They are named on the Play tab
  // as things only the Chief of Staff can do, rather than given eleven new
  // surfaces nobody would find.
  it('with no by-hand surface is one of the eleven the Chief of Staff owns', () => {
    const nulls = ACTION_TYPES.filter((type) => SHEET_OF_ACTION[type] === null);
    expect(nulls.length).toBe(11);
    expect([...nulls].sort()).toEqual([...CHIEF_ONLY_ACTIONS].sort());
  });
});

describe('a sheet href', () => {
  it('leads with the sheet and sorts the rest, so the address is stable', () => {
    expect(sheetHref('products', { line: 'p-1' })).toBe('/company?sheet=products&line=p-1');
    expect(sheetHref('news', { section: 'world', edition: '7' })).toBe('/world?sheet=news&edition=7&section=world');
    expect(sheetHref('people', { hash: 'headcount' })).toBe('/company?sheet=people#headcount');
    expect(sheetHref('exchange', { item: 'A B' })).toBe('/market?sheet=exchange&item=A%20B');
  });

  it('reads back nothing for an address that names no sheet', () => {
    expect(sheetFrom('')).toBeNull();
    expect(sheetFrom('?sheet=nonsense')).toBeNull();
    expect(sheetFrom('?section=world')).toBeNull();
    expect(sheetFrom(new URLSearchParams('sheet=capital').toString())).toBe('capital');
  });
});
