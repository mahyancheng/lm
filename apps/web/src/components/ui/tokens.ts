/**
 * Shared vocabulary for the primitives.
 *
 * Colour carries meaning and nothing else: positive, negative, warning,
 * informational, neutral. The six tones below are the whole palette a screen
 * may reach for, and they map one-to-one onto `RESOLUTION_LINE_TONES` plus a
 * brand accent for interactive affordances.
 *
 * The values behind every class here live in `src/app/globals.css`, and
 * `apps/web/ART_DIRECTION.md` explains the light flat palette they belong to.
 * Never hardcode a colour in a component: reach for one of these maps.
 */

import type { ResolutionLineTone } from '@frontier/contracts';

export type Tone = 'neutral' | 'gain' | 'loss' | 'warn' | 'info' | 'brand';

/** Text colour for each tone. */
export const TONE_TEXT: Readonly<Record<Tone, string>> = {
  neutral: 'text-ink-dim',
  gain: 'text-gain',
  loss: 'text-loss',
  warn: 'text-warn',
  info: 'text-info',
  brand: 'text-brand',
};

/** Background wash + border + text, for chips and badges. */
export const TONE_CHIP: Readonly<Record<Tone, string>> = {
  neutral: 'bg-raised border-hair text-ink-dim',
  gain: 'bg-gain-wash border-gain/25 text-gain',
  loss: 'bg-loss-wash border-loss/25 text-loss',
  warn: 'bg-warn-wash border-warn/25 text-warn',
  info: 'bg-info-wash border-info/25 text-info',
  brand: 'bg-brand-wash border-brand/25 text-brand',
};

/** The pale tint alone, for a panel inset, an illustration ground, a highlight row. */
export const TONE_WASH: Readonly<Record<Tone, string>> = {
  neutral: 'bg-raised',
  gain: 'bg-gain-wash',
  loss: 'bg-loss-wash',
  warn: 'bg-warn-wash',
  info: 'bg-info-wash',
  brand: 'bg-brand-wash',
};

/**
 * A filled badge or control carrying WHITE text.
 *
 * The plain tone tokens are tuned to read as text on a light surface; these
 * `-strong` variants are the ones that clear 4.5:1 with white on top. Use
 * these, and only these, whenever white sits on the colour.
 */
export const TONE_SOLID: Readonly<Record<Tone, string>> = {
  neutral: 'bg-ink text-white',
  gain: 'bg-gain-strong text-white',
  loss: 'bg-loss-strong text-white',
  warn: 'bg-warn-strong text-white',
  info: 'bg-info-strong text-white',
  brand: 'bg-brand-strong text-white',
};

/** Solid fill, for bars and meters. */
export const TONE_FILL: Readonly<Record<Tone, string>> = {
  neutral: 'bg-ink-faint',
  gain: 'bg-gain',
  loss: 'bg-loss',
  warn: 'bg-warn',
  info: 'bg-info',
  brand: 'bg-brand',
};

/** The raw CSS variable for a tone, for inline SVG. */
export const TONE_VAR: Readonly<Record<Tone, string>> = {
  neutral: 'var(--color-ink-faint)',
  gain: 'var(--color-gain)',
  loss: 'var(--color-loss)',
  warn: 'var(--color-warn)',
  info: 'var(--color-info)',
  brand: 'var(--color-brand)',
};

/** Map an engine resolution-line tone onto a UI tone. */
export function toneOfLine(tone: ResolutionLineTone): Tone {
  switch (tone) {
    case 'positive':
      return 'gain';
    case 'negative':
      return 'loss';
    case 'warning':
      return 'warn';
    default:
      return 'neutral';
  }
}

/** The conventional tone for a signed number: up is green, down is red. */
export function toneOfDelta(value: number, invert = false): Tone {
  if (value === 0 || !Number.isFinite(value)) return 'neutral';
  const positive = invert ? value < 0 : value > 0;
  return positive ? 'gain' : 'loss';
}

/** Join class names, dropping falsy entries. */
export function cx(...parts: readonly (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

/* -------------------------------------------------------------------------- */
/*  Keyboard                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Does this key activate a control?
 *
 * A native button answers Enter and Space; anything given `role="button"` has to
 * answer them itself or it is unreachable without a pointer. `Spacebar` is the
 * legacy name older engines still send.
 */
export function isActivationKey(key: string): boolean {
  return key === 'Enter' || key === ' ' || key === 'Spacebar';
}

/**
 * The index Tab should move to inside a focus trap.
 *
 * Wrapping in both directions is what makes a dialog modal to the keyboard:
 * Tab past the last control returns to the first, Shift+Tab before the first
 * goes to the last, and focus never escapes into the `aria-hidden` background.
 * `current` of -1 means focus is outside the trap, where the next Tab belongs
 * at the start and the previous at the end.
 */
export function nextTrapIndex(count: number, current: number, backwards: boolean): number {
  if (count <= 0) return -1;
  if (current < 0) return backwards ? count - 1 : 0;
  return backwards ? (current - 1 + count) % count : (current + 1) % count;
}
