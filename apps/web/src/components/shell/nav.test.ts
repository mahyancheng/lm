/**
 * The navigation data, and the one thing that can silently break it.
 *
 * Every screen and every group now names a *drawing* rather than two capital
 * letters, and the name is a string chosen in one file and drawn in another.
 * TypeScript catches a typo at build time; this catches the subtler case — a
 * mark that was renamed or removed from the set while `nav.ts` still asks for
 * it, which a `Record` lookup would answer with an empty `<svg>` rather than an
 * error.
 *
 * The icon module is a `.tsx`, and `apps/web` has no vitest config, so the file
 * is read as text (the same trick `interaction.test.ts` uses on `globals.css`)
 * rather than imported. Relative imports throughout: the `@/` alias is a
 * Next-only convenience and does not resolve here.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { HOME_ROUTE, NAV_GROUPS, NAV_ITEMS, navGroupFor, navItemFor, navSiblingsFor, primaryHrefOf } from '../../lib/nav';

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

describe('every navigation entry names a mark that exists', () => {
  const names = new Set(declaredNames());

  // Twenty-one: The Street added the institutional layer in Wave 4, and
  // Portfolio added the other side of the player's own register — what the
  // company owns outside itself. Both sit in Capital, beside the exchange and
  // the cap table they are the counterpart of.
  it('covers all twenty-one screens', () => {
    expect(NAV_ITEMS).toHaveLength(21);
    for (const item of NAV_ITEMS) {
      expect(names.has(item.icon), `${item.href} asks for the "${item.icon}" mark`).toBe(true);
    }
  });

  it('covers all five groups', () => {
    expect(NAV_GROUPS).toHaveLength(5);
    for (const group of NAV_GROUPS) {
      expect(names.has(group.icon), `the ${group.id} group asks for the "${group.icon}" mark`).toBe(true);
    }
  });

  it('gives each screen a distinct mark, so a tab bar is never ambiguous', () => {
    const perGroup = NAV_GROUPS.map((group) => new Set(group.items.map((item) => item.icon)));
    perGroup.forEach((set, index) => {
      expect(set.size).toBe(NAV_GROUPS[index]?.items.length);
    });
  });
});

describe('the phone tab bar', () => {
  it('lands every group on a real screen', () => {
    for (const group of NAV_GROUPS) {
      const href = primaryHrefOf(group);
      expect(navItemFor(href)).not.toBeNull();
      expect(navGroupFor(href)?.id).toBe(group.id);
    }
  });

  it('starts the session inside a group', () => {
    expect(navGroupFor(HOME_ROUTE)?.id).toBe('operate');
    expect(primaryHrefOf(NAV_GROUPS[0] as (typeof NAV_GROUPS)[number])).toBe(HOME_ROUTE);
  });
});

describe('the sub-tab strip', () => {
  it('offers the siblings of the screen you are on', () => {
    expect(navSiblingsFor('/markets').map((item) => item.href)).toEqual(['/markets', '/capital', '/portfolio', '/street', '/boardroom']);
    expect(navSiblingsFor('/company').map((item) => item.href)).toEqual([
      '/command-centre',
      '/company',
      '/products',
      '/sector',
      '/people',
      '/financials',
    ]);
  });

  it('follows a nested route back to its group', () => {
    expect(navSiblingsFor('/markets/ABC').map((item) => item.href)).toContain('/boardroom');
  });

  it('is empty off a game route', () => {
    expect(navSiblingsFor('/')).toEqual([]);
    expect(navSiblingsFor('/sign-in')).toEqual([]);
  });
});
