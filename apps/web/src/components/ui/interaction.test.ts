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
