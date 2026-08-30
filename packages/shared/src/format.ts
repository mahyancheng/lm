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
 */

import { quarterLabel } from '@frontier/contracts';

/* -------------------------------------------------------------------------- */
/*  Money                                                                      */
/* -------------------------------------------------------------------------- */

const MONEY_UNITS: readonly { readonly threshold: number; readonly suffix: string }[] = [
  { threshold: 1e12, suffix: 'T' },
  { threshold: 1e9, suffix: 'B' },
  { threshold: 1e6, suffix: 'M' },
  { threshold: 1e3, suffix: 'K' },
];

/** How `formatMoney` renders: `compact` is "$1.2B", `full` is "$1,240,000,000". */
export type MoneyStyle = 'compact' | 'full';

/**
 * Format a dollar amount.
 *
 * ```ts
 * formatMoney(1_240_000_000)          // "$1.24B"
 * formatMoney(-8_400_000)             // "-$8.4M"
 * formatMoney(1_240_000_000, 'full')  // "$1,240,000,000"
 * formatMoney(0)                      // "$0"
 * ```
 */
export function formatMoney(value: number, style: MoneyStyle = 'compact'): string {
  if (!Number.isFinite(value)) return '—';
  const sign = value < 0 ? '-' : '';
  const abs = Math.abs(value);

  if (style === 'full') return `${sign}$${groupDigits(Math.round(abs))}`;

  for (const unit of MONEY_UNITS) {
    if (abs >= unit.threshold) {
      const scaled = abs / unit.threshold;
      return `${sign}$${trimNumber(scaled, scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2)}${unit.suffix}`;
    }
  }
  return `${sign}$${trimNumber(abs, abs >= 100 || Number.isInteger(abs) ? 0 : 2)}`;
}

/** Always the long form, e.g. "$1,240,000,000". */
export function formatMoneyFull(value: number): string {
  return formatMoney(value, 'full');
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

/** Fixed decimals with trailing zeros removed: 1.20 -> "1.2", 3.00 -> "3". */
function trimNumber(value: number, decimals: number): string {
  const fixed = value.toFixed(Math.max(0, Math.min(20, decimals)));
  if (!fixed.includes('.')) return fixed;
  return fixed.replace(/0+$/, '').replace(/\.$/, '');
}

/* -------------------------------------------------------------------------- */
/*  Percentages                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Format a fraction as a percentage: `0.0473` becomes `"4.7%"`.
 * Percentage *points* (a difference between two percentages) use `formatDelta`
 * with the `points` format so the report can distinguish "+13%" from "+2.1pp".
 */
export function formatPct(fraction: number, decimals = 1): string {
  if (!Number.isFinite(fraction)) return '—';
  return `${trimNumber(fraction * 100, decimals)}%`;
}

/** `0.6123` becomes `"61.2 points"`-style scores on the 0..100 scale. */
export function formatScore(value: number, decimals = 0): string {
  if (!Number.isFinite(value)) return '—';
  return trimNumber(value, decimals);
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
 * formatDelta(-0.021, 'points')       // "-2.1pp"
 * formatDelta(-8_400_000, 'money')    // "-$8.4M"
 * formatDelta(2, 'rank')              // "+2"
 * ```
 *
 * Exactly zero renders without a sign, because "+0%" reads as a rounding
 * artefact rather than as "nothing happened".
 */
export function formatDelta(value: number, format: DeltaFormat = 'number', decimals?: number): string {
  if (!Number.isFinite(value)) return '—';
  const sign = value > 0 ? '+' : value < 0 ? '-' : '';
  const abs = Math.abs(value);
  switch (format) {
    case 'money':
      return `${sign}${formatMoney(abs)}`;
    case 'percent':
      return `${sign}${trimNumber(abs * 100, decimals ?? 1)}%`;
    case 'points':
      return `${sign}${trimNumber(abs * 100, decimals ?? 1)}pp`;
    case 'rank':
      return `${sign}${trimNumber(abs, decimals ?? 0)}`;
    case 'number':
    default:
      return `${sign}${trimNumber(abs, decimals ?? 2)}`;
  }
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

/** "4 quarters" / "1 quarter", for runway and contract terms. */
export function formatQuarterCount(quarters: number): string {
  const rounded = Math.round(quarters * 10) / 10;
  return `${trimNumber(rounded, 1)} ${rounded === 1 ? 'quarter' : 'quarters'}`;
}
