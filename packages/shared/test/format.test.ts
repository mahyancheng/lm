import { describe, expect, it } from 'vitest';
import {
  formatCount,
  formatDelta,
  formatMoney,
  formatMoneyFull,
  formatMultiple,
  formatPercent,
  formatPct,
  formatQuarter,
  formatQuarterCount,
  formatRankMove,
  formatScore,
} from '../src/format';

describe('formatMoney', () => {
  it('groups whole dollars below the $10M compact threshold', () => {
    expect(formatMoney(0)).toBe('$0');
    expect(formatMoney(940)).toBe('$940');
    expect(formatMoney(8_400)).toBe('$8,400');
    expect(formatMoney(1_240_000)).toBe('$1,240,000');
    expect(formatMoney(4_230_000)).toBe('$4,230,000');
    expect(formatMoney(9_999_999)).toBe('$9,999,999');
  });

  it('renders whole compact units from $10M up — never a decimal digit', () => {
    expect(formatMoney(10_000_000)).toBe('$10M');
    expect(formatMoney(42_400_000)).toBe('$42M');
    expect(formatMoney(910_000_000)).toBe('$910M');
    expect(formatMoney(1_240_000_000)).toBe('$1B');
    expect(formatMoney(3_000_000_000)).toBe('$3B');
    expect(formatMoney(51_584_000_000)).toBe('$52B');
    expect(formatMoney(2_400_000_000_000)).toBe('$2T');
  });

  it('carries a rounding overflow into the next unit', () => {
    expect(formatMoney(999_600_000)).toBe('$1B');
    expect(formatMoney(999_600_000_000)).toBe('$1T');
  });

  it('floors nonzero sub-dollar amounts at $1', () => {
    expect(formatMoney(0.42)).toBe('$1');
    expect(formatMoney(-0.42)).toBe('-$1');
    expect(formatMoney(0.42, 'full')).toBe('$1');
  });

  it('signs negatives outside the dollar sign', () => {
    expect(formatMoney(-8_400_000)).toBe('-$8,400,000');
    expect(formatMoney(-42_000_000)).toBe('-$42M');
  });

  it('renders the full scale with ASCII grouping', () => {
    expect(formatMoneyFull(1_240_000_000)).toBe('$1,240,000,000');
    expect(formatMoneyFull(-1_234)).toBe('-$1,234');
    expect(formatMoneyFull(0)).toBe('$0');
    expect(formatMoney(940, 'full')).toBe('$940');
  });

  it('degrades gracefully on non-finite input', () => {
    expect(formatMoney(Number.NaN)).toBe('—');
  });
});

describe('formatCount and formatScore', () => {
  it('groups whole counts', () => {
    expect(formatCount(0)).toBe('0');
    expect(formatCount(12_500_000)).toBe('12,500,000');
    expect(formatCount(-3.7)).toBe('-4');
    expect(formatCount(Number.NaN)).toBe('—');
  });

  it('renders scores as whole points', () => {
    expect(formatScore(61.23)).toBe('61');
    expect(formatScore(0.4)).toBe('0');
  });
});

describe('formatPercent', () => {
  it('formats fractions as whole percentages', () => {
    expect(formatPercent(0.043)).toBe('4%');
    expect(formatPercent(-0.021)).toBe('-2%');
    expect(formatPercent(0.61)).toBe('61%');
    expect(formatPercent(1)).toBe('100%');
    expect(formatPercent(0)).toBe('0%');
  });

  it('never lets a nonzero fraction read as 0%', () => {
    expect(formatPercent(0.004)).toBe('<1%');
    expect(formatPercent(-0.004)).toBe('-<1%');
  });

  it('keeps the formatPct alias in step', () => {
    expect(formatPct(0.043)).toBe('4%');
    expect(formatPct(0.004)).toBe('<1%');
  });
});

describe('formatMultiple', () => {
  it('renders whole multiples at 2x and above', () => {
    expect(formatMultiple(12.4)).toBe('12x');
    expect(formatMultiple(2)).toBe('2x');
    expect(formatMultiple(2.4)).toBe('2x');
  });

  it('renders near-parity ratios as signed deviation', () => {
    expect(formatMultiple(1.08)).toBe('+8%');
    expect(formatMultiple(0.92)).toBe('-8%');
    expect(formatMultiple(1.42)).toBe('+42%');
    expect(formatMultiple(1.001)).toBe('1x');
    expect(formatMultiple(1)).toBe('1x');
  });

  it('handles degenerate values', () => {
    expect(formatMultiple(0)).toBe('0x');
    expect(formatMultiple(-0.3)).toBe('0x');
    expect(formatMultiple(Number.NaN)).toBe('—');
  });
});

describe('formatDelta', () => {
  it('signs deltas and drops the sign at exactly zero', () => {
    expect(formatDelta(0.13, 'percent')).toBe('+13%');
    expect(formatDelta(-0.021, 'points')).toBe('-2pp');
    expect(formatDelta(-8_400_000, 'money')).toBe('-$8,400,000');
    expect(formatDelta(-42_000_000, 'money')).toBe('-$42M');
    expect(formatDelta(2, 'rank')).toBe('+2');
    expect(formatDelta(0, 'percent')).toBe('0%');
  });

  it('floors nonzero magnitudes that would round to zero', () => {
    expect(formatDelta(0.004, 'percent')).toBe('+<1%');
    expect(formatDelta(-0.003, 'points')).toBe('-<1pp');
    expect(formatDelta(0.4, 'number')).toBe('+<1');
  });

  it('fits inside the forty-character deltaLabel budget', () => {
    expect(formatDelta(-9.87e12, 'money').length).toBeLessThanOrEqual(40);
  });

  it('describes rank movement', () => {
    expect(formatRankMove(3, 1)).toBe('#3 to #1');
    expect(formatRankMove(null, 4)).toBe('new');
    expect(formatRankMove(2, 2)).toBeNull();
  });
});

describe('formatQuarter', () => {
  it('labels quarters from the session start year', () => {
    expect(formatQuarter(2027, 0)).toBe('2027 Q1');
    expect(formatQuarter(2027, 3)).toBe('2027 Q4');
    expect(formatQuarter(2027, 5)).toBe('2028 Q2');
  });

  it('pluralises whole quarter counts', () => {
    expect(formatQuarterCount(1)).toBe('1 quarter');
    expect(formatQuarterCount(6.25)).toBe('6 quarters');
    expect(formatQuarterCount(1.4)).toBe('1 quarter');
  });
});
