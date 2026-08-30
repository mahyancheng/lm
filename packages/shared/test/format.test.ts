import { describe, expect, it } from 'vitest';
import { formatDelta, formatMoney, formatMoneyFull, formatPct, formatQuarter, formatQuarterCount, formatRankMove } from '../src/format';

describe('formatMoney', () => {
  it('renders the compact scale', () => {
    expect(formatMoney(0)).toBe('$0');
    expect(formatMoney(940)).toBe('$940');
    expect(formatMoney(8_400)).toBe('$8.4K');
    expect(formatMoney(1_240_000)).toBe('$1.24M');
    expect(formatMoney(1_240_000_000)).toBe('$1.24B');
    expect(formatMoney(51_584_000_000)).toBe('$51.6B');
    expect(formatMoney(2_400_000_000_000)).toBe('$2.4T');
  });

  it('signs negatives outside the dollar sign', () => {
    expect(formatMoney(-8_400_000)).toBe('-$8.4M');
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

describe('formatPct and formatDelta', () => {
  it('formats fractions as percentages', () => {
    expect(formatPct(0.0473)).toBe('4.7%');
    expect(formatPct(0.61, 0)).toBe('61%');
    expect(formatPct(1)).toBe('100%');
  });

  it('signs deltas and drops the sign at exactly zero', () => {
    expect(formatDelta(0.13, 'percent')).toBe('+13%');
    expect(formatDelta(-0.021, 'points')).toBe('-2.1pp');
    expect(formatDelta(-8_400_000, 'money')).toBe('-$8.4M');
    expect(formatDelta(2, 'rank')).toBe('+2');
    expect(formatDelta(0, 'percent')).toBe('0%');
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

  it('pluralises quarter counts', () => {
    expect(formatQuarterCount(1)).toBe('1 quarter');
    expect(formatQuarterCount(6.25)).toBe('6.3 quarters');
  });
});
