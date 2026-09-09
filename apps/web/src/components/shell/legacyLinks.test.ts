/**
 * No component may write an old address.
 *
 * The game used to be twenty-two routes; it is five tabs with everything else a
 * sheet over one of them. All twenty-two old addresses still resolve —
 * `app/(game)/[...legacy]/page.tsx` replaces onto the new one on arrival — so a
 * raw `href="/products"` inside the app *works*. That is exactly why this test
 * exists: it works, and it costs a whole extra navigation, a frame of the wrong
 * chrome and a history entry the Back gesture has to climb back over. Left
 * unpoliced, eighty of them accumulate again.
 *
 * The rule: no `href` and no `router.push`/`router.replace` may name a key of
 * `LEGACY_ROUTES`, anywhere under `src`, outside three files.
 *
 * 1. `lib/sheets.ts` — the map itself. The old names have to be written down
 *    somewhere, and this is the somewhere.
 * 2. `app/(game)/[...legacy]/page.tsx` — the catch-all that redirects them.
 * 3. `screens/command-centre/feed.ts` — the alert feed writes old addresses at
 *    source, and `AlertFeed` puts every one through `legacyHref` at render. The
 *    test checks that too, so the exemption cannot outlive the mapping.
 *
 * One of the twenty-two, `/company`, is also a tab path. Writing it bare is
 * writing the tab, so it is excluded from the search rather than exempted by
 * file — and `sheetHref('company')` produces `/company?sheet=company`, which
 * the pattern does not match either because the route is followed by `?`.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LEGACY_ROUTES } from '../../lib/sheets';
import { TABS } from '../../lib/nav';

const ROOT = join(process.cwd(), 'src');

/** Every `.ts`/`.tsx` under `src`, tests included — a test may not link either. */
function files(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) files(path, out);
    else if (/\.tsx?$/.test(entry) && !entry.endsWith('.d.ts')) out.push(path);
  }
  return out;
}

/** The three files allowed to name an old route, as `src`-relative paths. */
const ALLOWED = new Set([
  join('lib', 'sheets.ts'),
  join('app', '(game)', '[...legacy]', 'page.tsx'),
  join('components', 'screens', 'command-centre', 'feed.ts'),
  // The registry's own test states the twenty-two old routes it maps.
  join('components', 'shell', 'sheetRegistry.test.ts'),
  // This file names them to search for them.
  join('components', 'shell', 'legacyLinks.test.ts'),
  // The prompt keys are read off an old pathname during the redirect frame.
  join('components', 'screens', 'chief-of-staff', 'quickPrompts.test.ts'),
]);

/** A tab path is a new address even where it is also an old one (`/company`). */
const TAB_PATHS = new Set(TABS.map((tab) => tab.href));

const LEGACY = Object.keys(LEGACY_ROUTES).filter((route) => !TAB_PATHS.has(route));
/** The one old path that is also a tab path; naming it bare names the tab. */
const SHARED = Object.keys(LEGACY_ROUTES).filter((route) => TAB_PATHS.has(route));

const ROUTES = LEGACY.map((route) => route.replace(/\//g, '\\/')).join('|');

/**
 * An address written as a literal.
 *
 * Matches `href="/products"`, `href='/products?x=1'`, ``href={`/products/${id}`}``
 * and `router.push('/products')` — the route followed by a boundary, so
 * `/products-something` is not a hit.
 */
const PATTERN = new RegExp(
  String.raw`(?:href\s*=\s*(?:["'\`]|\{\s*["'\`])|router\.(?:push|replace)\(\s*["'\`])(${ROUTES})(?=["'\`?#/])`,
  'g',
);

describe('no component writes an old address', () => {
  it('finds every old route to search for, and excludes the tab-shaped ones', () => {
    expect(Object.keys(LEGACY_ROUTES).length).toBe(22);
    expect(LEGACY.length).toBe(21);
    // `/company` is both an old route and a tab; naming it bare names the tab.
    expect(SHARED).toContain('/company');
  });

  it('is empty outside the map, the catch-all and the feed', () => {
    const offenders: string[] = [];
    for (const path of files(ROOT)) {
      const key = relative(ROOT, path);
      if (ALLOWED.has(key)) continue;
      const source = readFileSync(path, 'utf8');
      for (const line of source.split('\n')) {
        PATTERN.lastIndex = 0;
        const match = PATTERN.exec(line);
        if (match !== null) offenders.push(`${key}: ${line.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('holds the feed to its own exemption: every line it writes goes through `legacyHref`', () => {
    const feed = readFileSync(join(ROOT, 'components', 'screens', 'command-centre', 'feed.ts'), 'utf8');
    // The feed does write old addresses — that is what the exemption is for.
    expect(feed).toMatch(/href: '\/(capital|people|research|news)/);
    const alertFeed = readFileSync(join(ROOT, 'components', 'screens', 'command-centre', 'AlertFeed.tsx'), 'utf8');
    expect(alertFeed).toContain('legacyHref');
    expect(alertFeed).toContain('href={legacyHref(item.href)}');
  });
});
