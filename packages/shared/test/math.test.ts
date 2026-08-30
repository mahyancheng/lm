import { describe, expect, it } from 'vitest';
import { createRng } from '../src/rng';
import {
  clamp,
  clamp01,
  clampScore,
  lerp,
  mean,
  percentileRank,
  percentileRanks,
  remap,
  round,
  safeDiv,
  sum,
  weightedPick,
} from '../src/math';

describe('ranges', () => {
  it('clamps, including non-finite input', () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(11, 0, 10)).toBe(10);
    expect(clamp(Number.NaN, 2, 10)).toBe(2);
    expect(clamp(Number.POSITIVE_INFINITY, 2, 10)).toBe(2);
    expect(clamp01(1.4)).toBe(1);
    expect(clampScore(140)).toBe(100);
  });

  it('interpolates and remaps with clamped parameters', () => {
    expect(lerp(0, 10, 0.25)).toBe(2.5);
    expect(lerp(0, 10, 2)).toBe(10);
    expect(lerp(0, 10, -1)).toBe(0);
    expect(remap(5, 0, 10, 100, 200)).toBe(150);
    expect(remap(5, 4, 4, 100, 200)).toBe(100);
  });

  it('rounds and divides safely', () => {
    expect(round(1.2345, 2)).toBe(1.23);
    expect(round(1.005, 2)).toBe(1.01);
    expect(round(Number.NaN)).toBe(0);
    expect(safeDiv(10, 4)).toBe(2.5);
    expect(safeDiv(10, 0)).toBe(0);
    expect(safeDiv(10, 0, -1)).toBe(-1);
  });

  it('aggregates while ignoring non-finite entries', () => {
    expect(sum([1, 2, Number.NaN, 3])).toBe(6);
    expect(mean([2, 4])).toBe(3);
    expect(mean([])).toBe(0);
  });
});

describe('percentileRanks', () => {
  it('returns an empty array for an empty population', () => {
    expect(percentileRanks([])).toEqual([]);
  });

  it('scores a lone subject at the midpoint', () => {
    expect(percentileRanks([42])).toEqual([0.5]);
  });

  it('scores an all-equal field at the midpoint rather than crowning the first', () => {
    expect(percentileRanks([7, 7, 7, 7])).toEqual([0.5, 0.5, 0.5, 0.5]);
  });

  it('orders a distinct field and preserves input order', () => {
    expect(percentileRanks([10, 30, 20])).toEqual([1 / 6, 5 / 6, 0.5]);
  });

  it('splits ties by mid-rank', () => {
    // Two at the bottom, one clear top: the tied pair share the lower half.
    expect(percentileRanks([1, 1, 9])).toEqual([1 / 3, 1 / 3, 5 / 6]);
  });

  it('always lands strictly inside the unit interval', () => {
    for (const ranks of [percentileRanks([1, 2, 3, 4, 5]), percentileRanks([0, 0, 0, 1])]) {
      for (const rank of ranks) {
        expect(rank).toBeGreaterThan(0);
        expect(rank).toBeLessThan(1);
      }
    }
  });

  it('treats non-finite values as the lowest rank without poisoning the board', () => {
    const ranks = percentileRanks([Number.NaN, 5, 10]);
    expect(ranks[0]).toBeLessThan(ranks[1] ?? 0);
    for (const rank of ranks) expect(Number.isFinite(rank)).toBe(true);
  });

  it('percentileRank places one value inside a population', () => {
    expect(percentileRank([1, 2, 3], 4)).toBeGreaterThan(0.8);
    expect(percentileRank([1, 2, 3], 0)).toBeLessThan(0.2);
    expect(percentileRank([], 3)).toBe(0.5);
  });
});

describe('weightedPick', () => {
  it('throws only on an empty array', () => {
    expect(() => weightedPick(createRng('x'), [])).toThrow(/empty/);
  });

  it('takes exactly one draw whatever the input size', () => {
    const shortRng = createRng('draws');
    weightedPick(shortRng, ['a', 'b'], () => 1);
    const longRng = createRng('draws');
    weightedPick(longRng, ['a', 'b', 'c', 'd', 'e', 'f'], () => 1);
    expect(shortRng.next()).toBe(longRng.next());
  });

  it('respects the weights', () => {
    const rng = createRng('weights');
    const items = [
      { id: 'rare', weight: 1 },
      { id: 'common', weight: 19 },
    ];
    let common = 0;
    for (let i = 0; i < 4000; i += 1) if (weightedPick(rng, items).id === 'common') common += 1;
    expect(common / 4000).toBeGreaterThan(0.9);
    expect(common / 4000).toBeLessThan(0.99);
  });

  it('never returns a zero-weighted item while a positive one exists', () => {
    const rng = createRng('zero-weights');
    const items = [
      { id: 'ineligible', weight: 0 },
      { id: 'negative', weight: -4 },
      { id: 'eligible', weight: 2 },
    ];
    for (let i = 0; i < 500; i += 1) expect(weightedPick(rng, items).id).toBe('eligible');
  });

  it('falls back to a uniform pick when every weight is zero', () => {
    const rng = createRng('all-zero');
    const seen = new Set<string>();
    for (let i = 0; i < 200; i += 1) seen.add(weightedPick(rng, [{ id: 'a', weight: 0 }, { id: 'b', weight: 0 }]).id);
    expect(seen).toEqual(new Set(['a', 'b']));
  });

  it('is deterministic for a given seed', () => {
    const pickAll = () => {
      const rng = createRng('pick-determinism');
      return Array.from({ length: 20 }, () => weightedPick(rng, [1, 2, 3, 4], (n) => n));
    };
    expect(pickAll()).toEqual(pickAll());
  });
});
