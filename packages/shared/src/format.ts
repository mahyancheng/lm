/**
 * @frontier/shared — format.ts
 *
 * Presentation helpers shared by the engine's resolution report, the LLM
 * briefings and the web app, so a figure reads the same everywhere it appears.
 *
 * Every function here is pure and locale-independent: no `Intl`, no `toLocaleString`,
 * no ambient configuration. A resolution line rendered on a server in one region
 * and replayed on a machine in another must produce the identical string,
 * because those strings are part of a committed report.
 *
 * Players never see decimal digits. Money is whole dollars or whole compact
 * units, percentages are whole percents, multiples are "12x" or "+8%". State
 * keeps full precision; only these labels round.
 */

import { quarterLabel } from '@frontier/contracts';

/* -------------------------------------------------------------------------- */
/*  Money                                                                      */
/* -------------------------------------------------------------------------- */

/** Compact money switches from grouped dollars to whole units at $10M. */
const COMPACT_MONEY_THRESHOLD = 10_000_000;

/** How `formatMoney` renders: `compact` is "$42M", `full` is "$1,240,000,000". */
export type MoneyStyle = 'compact' | 'full';

/**
 * Format a dollar amount. No decimal digits, ever.
 *
 * ```ts
 * formatMoney(4_230_000)              // "$4,230,000"  (grouped below $10M)
 * formatMoney(42_400_000)             // "$42M"        (whole units above)
 * formatMoney(1_240_000_000)          // "$1B"
 * formatMoney(-8_400_000)             // "-$8,400,000"
 * formatMoney(1_240_000_000, 'full')  // "$1,240,000,000"
 * formatMoney(0.42)                   // "$1"          (nonzero floors at $1)
 * formatMoney(0)                      // "$0"
 * ```
 */
export function formatMoney(value: number, style: MoneyStyle = 'compact'): string {
  if (!Number.isFinite(value)) return '—';
  const sign = value < 0 ? '-' : '';
  const abs = Math.abs(value);

  if (style === 'full' || abs < COMPACT_MONEY_THRESHOLD) {
    return `${sign}$${groupDigits(wholeDollars(abs))}`;
  }

  // Whole compact units, with the rounding carry (999.6M reads "$1B", not "$1,000M").
  const millions = Math.round(abs / 1e6);
  if (millions < 1_000) return `${sign}$${millions}M`;
  const billions = Math.round(abs / 1e9);
  if (billions < 1_000) return `${sign}$${billions}B`;
  return `${sign}$${groupDigits(Math.round(abs / 1e12))}T`;
}

/** Always the long form, e.g. "$1,240,000,000". */
export function formatMoneyFull(value: number): string {
  return formatMoney(value, 'full');
}

/** Whole dollars; a nonzero amount never rounds down to a blank "$0". */
function wholeDollars(abs: number): number {
  const rounded = Math.round(abs);
  return rounded === 0 && abs > 0 ? 1 : rounded;
}

/** Thousands separators, ASCII commas, no locale involved. */
function groupDigits(value: number): string {
  const digits = String(Math.abs(value));
  let out = '';
  for (let i = 0; i < digits.length; i += 1) {
    const fromEnd = digits.length - i;
    out += digits[i] ?? '';
    if (fromEnd > 1 && (fromEnd - 1) % 3 === 0) out += ',';
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/*  Counts                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * A whole number with ASCII separators: shares, headcount, units, index levels.
 * `formatCount(12_500_000)` is `"12,500,000"`; `formatCount(-3.7)` is `"-4"`.
 */
export function formatCount(value: number): string {
  if (!Number.isFinite(value)) return '—';
  const sign = value < 0 ? '-' : '';
  return `${sign}${groupDigits(Math.round(Math.abs(value)))}`;
}

/* -------------------------------------------------------------------------- */
/*  Percentages                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Format a fraction as a whole percentage: `0.043` becomes `"4%"`, `-0.021`
 * becomes `"-2%"`. A nonzero fraction never rounds to a bare `"0%"` — it shows
 * `"<1%"` (or `"-<1%"`) so a small edge still reads as an edge.
 */
export function formatPercent(fraction: number): string {
  if (!Number.isFinite(fraction)) return '—';
  const pct = Math.round(fraction * 100);
  if (pct === 0 && fraction !== 0) return `${fraction < 0 ? '-' : ''}<1%`;
  return `${pct < 0 ? '-' : ''}${Math.abs(pct)}%`;
}

/** Alias kept for existing call sites; same whole-percent rendering. */
export function formatPct(fraction: number): string {
  return formatPercent(fraction);
}

/** `61.23` becomes `"61"` — scores on the 0..100 scale are whole points. */
export function formatScore(value: number): string {
  if (!Number.isFinite(value)) return '—';
  return formatCount(value);
}

/* -------------------------------------------------------------------------- */
/*  Multiples                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * A ratio players see: valuation multiples, betas, price indices, virality.
 *
 * ```ts
 * formatMultiple(12.4)    // "12x"
 * formatMultiple(1.08)    // "+8%"   (near parity, the deviation is the signal)
 * formatMultiple(0.92)    // "-8%"
 * formatMultiple(1.001)   // "1x"    (rounds to parity)
 * ```
 *
 * Below 2x a whole "1x" would erase the figure entirely, so the label switches
 * to the signed deviation from parity; at 2x and above whole units carry it.
 */
export function formatMultiple(value: number): string {
  if (!Number.isFinite(value)) return '—';
  if (value >= 2) return `${groupDigits(Math.round(value))}x`;
  if (value <= 0) return '0x';
  const deviation = Math.round((value - 1) * 100);
  if (deviation === 0) return '1x';
  return `${deviation > 0 ? '+' : '-'}${Math.abs(deviation)}%`;
}

/* -------------------------------------------------------------------------- */
/*  Deltas                                                                     */
/* -------------------------------------------------------------------------- */

/** Which units a delta label is expressed in. */
export type DeltaFormat = 'money' | 'percent' | 'points' | 'number' | 'rank';

/**
 * A signed change label of the kind `ResolutionLine.deltaLabel` carries.
 *
 * ```ts
 * formatDelta(0.13, 'percent')        // "+13%"
 * formatDelta(-0.021, 'points')       // "-2pp"
 * formatDelta(-8_400_000, 'money')    // "-$8,400,000"
 * formatDelta(2, 'rank')              // "+2"
 * formatDelta(0.004, 'percent')       // "+<1%"  (nonzero never reads as nothing)
 * ```
 *
 * Exactly zero renders without a sign, because "+0%" reads as a rounding
 * artefact rather than as "nothing happened".
 */
export function formatDelta(value: number, format: DeltaFormat = 'number'): string {
  if (!Number.isFinite(value)) return '—';
  const sign = value > 0 ? '+' : value < 0 ? '-' : '';
  const abs = Math.abs(value);
  switch (format) {
    case 'money':
      return `${sign}${formatMoney(abs)}`;
    case 'percent':
      return `${sign}${wholeOrFloor(abs * 100)}%`;
    case 'points':
      return `${sign}${wholeOrFloor(abs * 100)}pp`;
    case 'rank':
      return `${sign}${wholeOrFloor(abs)}`;
    case 'number':
    default:
      return `${sign}${wholeOrFloor(abs)}`;
  }
}

/** Whole magnitude; a nonzero one that rounds to 0 reads "<1", never "0". */
function wholeOrFloor(abs: number): string {
  const rounded = Math.round(abs);
  if (rounded === 0 && abs > 0) return '<1';
  return groupDigits(rounded);
}

/** "#3 to #1" — the movement label the leaderboards use. */
export function formatRankMove(previousRank: number | null, rank: number): string | null {
  if (previousRank === null) return 'new';
  if (previousRank === rank) return null;
  return `#${previousRank} to #${rank}`;
}

/* -------------------------------------------------------------------------- */
/*  Time                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Human label for a quarter index: `formatQuarter(2027, 5)` is `"2028 Q2"`.
 * Delegates to `quarterLabel` in `@frontier/contracts` so there is exactly one
 * definition of session time in the codebase.
 */
export function formatQuarter(startYear: number, quarter: number): string {
  return quarterLabel(startYear, quarter);
}

/** "4 quarters" / "1 quarter", for runway and contract terms. Whole quarters. */
export function formatQuarterCount(quarters: number): string {
  const rounded = Math.round(quarters);
  return `${rounded < 0 ? '-' : ''}${groupDigits(rounded)} ${Math.abs(rounded) === 1 ? 'quarter' : 'quarters'}`;
}
