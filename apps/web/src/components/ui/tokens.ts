/**
 * Shared vocabulary for the primitives.
 *
 * Colour carries meaning and nothing else: positive, negative, warning,
 * informational, neutral. The six tones below are the whole palette a screen
 * may reach for, and they map one-to-one onto `RESOLUTION_LINE_TONES` plus a
 * brand accent for interactive affordances.
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
  gain: 'bg-gain-wash border-gain/30 text-gain',
  loss: 'bg-loss-wash border-loss/30 text-loss',
  warn: 'bg-warn-wash border-warn/30 text-warn',
  info: 'bg-info-wash border-info/30 text-info',
  brand: 'bg-brand-wash border-brand/30 text-brand',
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
