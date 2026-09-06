/**
 * The navigation data, and the one thing that can silently break it.
 *
 * Every tab names a *drawing* rather than two capital letters, and the name is
 * a string chosen in one file and drawn in another. TypeScript catches a typo
 * at build time; this catches the subtler case — a mark that was renamed or
 * removed from the set while `nav.ts` still asks for it, which a `Record`
 * lookup would answer with an empty `<svg>` rather than an error.
 *
 * The icon module is a `.tsx`, so the file is read as text (the same trick
 * `interaction.test.ts` uses on `globals.css`) rather than imported. Relative
 * imports throughout: the `@/` alias is a Next-only convenience and does not
 * resolve here.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { HOME_ROUTE, TABS, isGamePath, tabFor } from '../../lib/nav';

const iconSource = readFileSync(fileURLToPath(new URL('../ui/icons.tsx', import.meta.url)), 'utf8');

/** The names the set advertises. */
function declaredNames(): readonly string[] {
  const block = /export const ICON_NAMES = \[([\s\S]*?)\] as const;/.exec(iconSource);
  if (block === null) throw new Error('ICON_NAMES is no longer a plain array literal in icons.tsx');
  return [...(block[1] ?? '').matchAll(/'([A-Za-z]+)'/g)].map((match) => match[1] ?? '');
}

/** The names that actually have a drawing. */
function drawnNames(): readonly string[] {
  const start = iconSource.indexOf('const SHAPES');
  if (start < 0) throw new Error('the SHAPES registry is gone from icons.tsx');
  const block = iconSource.slice(start, iconSource.indexOf('\n};', start));
  return [...block.matchAll(/^ {2}([A-Za-z]+): \(/gm)].map((match) => match[1] ?? '');
}

describe('the icon set', () => {
  it('draws every name it declares, and declares every name it draws', () => {
    expect([...drawnNames()].sort()).toEqual([...declaredNames()].sort());
  });

  it('is big enough to name every screen without repeating itself much', () => {
    expect(declaredNames().length).toBeGreaterThanOrEqual(30);
    expect(new Set(declaredNames()).size).toBe(declaredNames().length);
  });
});

describe('the tab bar', () => {
  const names = new Set(declaredNames());

  // Five, and no more: the bar is the whole navigation now — no sub-tab strip
  // and no hamburger — and a sixth 78px target on a 390px phone is the point
  // at which a thumb starts missing.
  it('is exactly five tabs, each naming a mark that exists', () => {
    expect(TABS).toHaveLength(5);
    for (const tab of TABS) {
      expect(names.has(tab.icon), `${tab.href} asks for the "${tab.icon}" mark`).toBe(true);
    }
  });

  it('gives each tab a distinct mark, so the bar is never ambiguous', () => {
    expect(new Set(TABS.map((tab) => tab.icon)).size).toBe(TABS.length);
  });

  it('starts the session on Home', () => {
    expect(HOME_ROUTE).toBe('/home');
    expect(tabFor(HOME_ROUTE)?.id).toBe('home');
  });

  it('is null off the five', () => {
    expect(tabFor('/sign-in')).toBeNull();
    expect(tabFor('/')).toBeNull();
  });
});

describe('the shell chrome', () => {
  it('wraps the tabs', () => {
    for (const tab of TABS) expect(isGamePath(tab.href)).toBe(true);
  });

  // An old address renders inside the shell for the one frame it takes the
  // catch-all to replace onto the new one: a bare page flashing between the two
  // would be worse than the redirect it is hiding.
  it('still wraps a legacy address while it redirects', () => {
    expect(isGamePath('/financials')).toBe(true);
    expect(isGamePath('/news')).toBe(true);
    expect(isGamePath('/markets/ABC')).toBe(true);
  });

  it('leaves the landing and auth pages bare', () => {
    expect(isGamePath('/')).toBe(false);
    expect(isGamePath('/sign-in')).toBe(false);
  });
});
