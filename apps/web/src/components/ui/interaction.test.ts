/**
 * The parts of the interface a keyboard and a low-vision reader depend on.
 *
 * These are pure: the key predicate a `role="button"` row needs to be operable
 * at all, the wrap arithmetic that makes a dialog modal to Tab, and the contrast
 * of the token that carries the app's whole explanatory layer. The components
 * that use them are React, but the rules they encode are not, and a rule that
 * can be checked without a browser should be.
 *
 * Relative imports throughout: `apps/web` has no vitest config, so the `@/`
 * alias is a Next-only convenience and does not resolve here.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isTopDialog, pushDialog } from './focusTrap';
import { isActivationKey, nextTrapIndex } from './tokens';

/* -------------------------------------------------------------------------- */
/*  Keyboard                                                                   */
/* -------------------------------------------------------------------------- */

describe('activation keys', () => {
  it('answers Enter and Space, and nothing else', () => {
    for (const key of ['Enter', ' ', 'Spacebar']) expect(isActivationKey(key)).toBe(true);
    for (const key of ['Tab', 'Escape', 'a', 'ArrowDown', 'Shift']) expect(isActivationKey(key)).toBe(false);
  });
});

describe('only the topmost dialog owns the keyboard', () => {
  it('gives the keyboard to a detail drawer opened over a sheet', () => {
    const sheet = {};
    const detail = {};
    const closeSheet = pushDialog(sheet);
    expect(isTopDialog(sheet)).toBe(true);

    // A card's sheet, then that sheet's own detail drawer. One Escape must
    // close the detail and leave the subject behind it open.
    const closeDetail = pushDialog(detail);
    expect(isTopDialog(detail)).toBe(true);
    expect(isTopDialog(sheet)).toBe(false);

    closeDetail();
    expect(isTopDialog(sheet)).toBe(true);
    closeSheet();
  });

  it('hands the keyboard back when dialogs close out of order', () => {
    const outer = {};
    const inner = {};
    const closeOuter = pushDialog(outer);
    const closeInner = pushDialog(inner);
    closeOuter();
    expect(isTopDialog(inner)).toBe(true);
    closeInner();
  });

  it('is idempotent on release, so a double unmount cannot unseat the dialog above', () => {
    const first = {};
    const second = {};
    const release = pushDialog(first);
    const holdSecond = pushDialog(second);
    release();
    release();
    expect(isTopDialog(second)).toBe(true);
    holdSecond();
  });

  it('answers true with nothing registered, so a dialog is never made inert by an empty stack', () => {
    expect(isTopDialog({})).toBe(true);
  });
});

describe('the focus trap wraps in both directions', () => {
  it('moves forward and wraps past the last control', () => {
    expect(nextTrapIndex(3, 0, false)).toBe(1);
    expect(nextTrapIndex(3, 2, false)).toBe(0);
  });

  it('moves backward and wraps before the first', () => {
    expect(nextTrapIndex(3, 2, true)).toBe(1);
    expect(nextTrapIndex(3, 0, true)).toBe(2);
  });

  it('pulls focus in when it is outside the dialog', () => {
    expect(nextTrapIndex(3, -1, false)).toBe(0);
    expect(nextTrapIndex(3, -1, true)).toBe(2);
  });

  it('has nowhere to go in an empty dialog', () => {
    expect(nextTrapIndex(0, -1, false)).toBe(-1);
  });
});

/* -------------------------------------------------------------------------- */
/*  Contrast                                                                   */
/* -------------------------------------------------------------------------- */

function relativeLuminance(hex: string): number {
  const channels = [1, 3, 5]
    .map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255)
    .map((value) => (value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
  return 0.2126 * (channels[0] ?? 0) + 0.7152 * (channels[1] ?? 0) + 0.0722 * (channels[2] ?? 0);
}

function contrast(foreground: string, background: string): number {
  const a = relativeLuminance(foreground);
  const b = relativeLuminance(background);
  const [high, low] = a > b ? [a, b] : [b, a];
  return (high + 0.05) / (low + 0.05);
}

const css = readFileSync(fileURLToPath(new URL('../../app/globals.css', import.meta.url)), 'utf8');

function token(name: string): string {
  const match = new RegExp(`--color-${name}:\\s*(#[0-9a-fA-F]{6})`).exec(css);
  if (match === null) throw new Error(`--color-${name} is not defined in globals.css`);
  return match[1] ?? '';
}

/**
 * `text-ink-faint` is applied to 10px and 11px spans in nearly three hundred
 * places — ledger hashes, phase timings, provenance lines, the whole
 * explanatory layer — so it is held to the 4.5:1 body-text floor on every
 * surface it sits on, not the 3:1 large-text one it would not have met either.
 */
describe('text tokens meet WCAG AA on every surface', () => {
  const surfaces = ['base', 'panel', 'raised'] as const;

  for (const name of ['ink', 'ink-dim', 'ink-faint']) {
    it(`${name} reads at 4.5:1 or better`, () => {
      for (const surface of surfaces) {
        expect(contrast(token(name), token(surface))).toBeGreaterThanOrEqual(4.5);
      }
    });
  }

  it('keeps the faint tier visibly quieter than the dim one', () => {
    expect(contrast(token('ink-faint'), token('panel'))).toBeLessThan(contrast(token('ink-dim'), token('panel')));
  });

  it('does not leave the old hardcoded faint colour behind in a text class', () => {
    // `.label-caps-faint` and the field placeholder hardcoded the token's old
    // value; both would have kept the failing contrast when the token moved.
    const declarations = css.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(declarations).not.toContain('#566573');
  });
});

/* -------------------------------------------------------------------------- */
/*  Sentences finish                                                           */
/* -------------------------------------------------------------------------- */

/**
 * A phone is 390 points wide and the primitives were cutting their own prose.
 *
 * The critic counted 7 clipped elements on Home, 5 on Company, 7 on Market, 7 on
 * World and 4 on Play at 390: every card's one-line description, every objective
 * of the game, and the Market tab's first card *title* — "HARBOUR 390 · YOU…",
 * the card's own identity. All three came from the same habit of putting
 * `truncate` on a line of prose that shares its row with a tag and an "Open ›".
 *
 * The rule these pin: a **figure** may be clipped (it is beside its own label),
 * an **identity or a sentence** may not — it wraps, and clamps at two lines.
 */
describe('the primitives let a sentence finish', () => {
  const read = (path: string): string => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');

  it('gives a panel’s subtitle its own full-width line, clamped at two', () => {
    const panel = read('./Panel.tsx');
    // The subtitle is outside the row that carries the title and the actions.
    expect(panel.indexOf('{subtitle !== undefined')).toBeGreaterThan(panel.indexOf('{actions !== undefined'));
    expect(panel).toContain('<p className="line-clamp-2 text-[11px] leading-snug text-ink-faint">{subtitle}</p>');
    expect(panel).not.toContain('truncate text-[11px]');
  });

  it('lets a panel’s title wrap rather than stop mid-word', () => {
    expect(read('./Panel.tsx')).toContain('<h2 className="label-caps min-w-0">{title}</h2>');
  });

  it('clamps a stat card’s hint instead of cutting it', () => {
    expect(read('./StatCard.tsx')).toContain('className="mt-1.5 line-clamp-2 text-[10px] leading-snug text-ink-faint"');
  });

  it('prints a whole objective, which is the goal of the game', () => {
    expect(read('../screens/home/ObjectivesCard.tsx')).toContain(
      '<p className="mt-0.5 line-clamp-2 text-[11.5px] leading-snug text-ink-faint">{objective.description}</p>',
    );
  });

  it('gives a sheet the same gutter as the page it replaced', () => {
    // `main` is `px-3 sm:px-5` (AppShell); a `px-5` drawer made every one of the
    // twenty moved bodies lay out 16 points narrower than it did as a route.
    const drawer = read('./Drawer.tsx');
    expect(drawer).toContain('overflow-y-auto px-3 py-4 sm:px-5');
    expect(read('../shell/AppShell.tsx')).toContain('px-3 pt-4 sm:px-5');
    expect(drawer.match(/(?<!sm:)px-5/g)).toBeNull();
  });
});
