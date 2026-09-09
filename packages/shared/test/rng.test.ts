import { describe, expect, it } from 'vitest';
import { createRng, rngPath } from '../src/rng';

const draws = (seed: number | string, count = 12): number[] => {
  const rng = createRng(seed);
  return Array.from({ length: count }, () => rng.next());
};

describe('createRng', () => {
  it('reproduces the identical sequence for the same seed', () => {
    expect(draws(424242)).toEqual(draws(424242));
    expect(draws('sess_demo/q0')).toEqual(draws('sess_demo/q0'));
  });

  it('normalises a numeric seed to its decimal string', () => {
    expect(draws(424242)).toEqual(draws('424242'));
    expect(rngPath(createRng(-0))).toBe('0');
  });

  it('produces different sequences for different seeds', () => {
    expect(draws(1)).not.toEqual(draws(2));
  });

  it('stays inside [0, 1)', () => {
    const rng = createRng('bounds');
    for (let i = 0; i < 5000; i += 1) {
      const value = rng.next();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it('is roughly uniform over ten buckets', () => {
    const rng = createRng('uniformity');
    const buckets = new Array<number>(10).fill(0);
    const n = 20000;
    for (let i = 0; i < n; i += 1) {
      const bucket = Math.min(9, Math.floor(rng.next() * 10));
      buckets[bucket] = (buckets[bucket] ?? 0) + 1;
    }
    for (const count of buckets) {
      expect(count).toBeGreaterThan(n / 10 - n / 50);
      expect(count).toBeLessThan(n / 10 + n / 50);
    }
  });

  it('range and int respect their bounds', () => {
    const rng = createRng('ranges');
    const seenInts = new Set<number>();
    for (let i = 0; i < 2000; i += 1) {
      const r = rng.range(-3, 7);
      expect(r).toBeGreaterThanOrEqual(-3);
      expect(r).toBeLessThan(7);
      const n = rng.int(2, 5);
      expect(Number.isInteger(n)).toBe(true);
      expect(n).toBeGreaterThanOrEqual(2);
      expect(n).toBeLessThanOrEqual(5);
      seenInts.add(n);
    }
    expect([...seenInts].sort()).toEqual([2, 3, 4, 5]);
    expect(rng.int(4, 4)).toBe(4);
    expect(rng.range(1, 1)).toBe(1);
  });

  it('pick throws on an empty array and shuffle does not mutate its input', () => {
    const rng = createRng('picks');
    expect(() => rng.pick([])).toThrow(/empty/);
    const source = Object.freeze([1, 2, 3, 4, 5, 6, 7, 8]);
    const shuffled = rng.shuffle(source);
    expect(source).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(shuffled.slice().sort((a, b) => a - b)).toEqual([...source]);
    expect(createRng('picks').shuffle(source)).toEqual(shuffled);
  });
});

describe('fork', () => {
  it('gives the same stream for the same label from the same seed', () => {
    const a = createRng(7).fork('phase:market_resolution');
    const b = createRng(7).fork('phase:market_resolution');
    expect(Array.from({ length: 8 }, () => a.next())).toEqual(Array.from({ length: 8 }, () => b.next()));
  });

  it('gives uncorrelated first draws for different labels', () => {
    const parent = createRng('session');
    const first: number[] = [];
    for (const label of ['economy', 'markets', 'companies', 'research', 'government', 'boards', 'social']) {
      first.push(parent.fork(label).next());
    }
    expect(new Set(first).size).toBe(first.length);
    // No two labels agree to three decimal places, i.e. the streams are not
    // near-copies of one another the way a naive additive seed would produce.
    for (let i = 0; i < first.length; i += 1) {
      for (let j = i + 1; j < first.length; j += 1) {
        expect(Math.abs((first[i] ?? 0) - (first[j] ?? 0))).toBeGreaterThan(1e-3);
      }
    }
  });

  it('is independent of how many draws the parent has taken', () => {
    const early = createRng('independence').fork('talent');
    const late = (() => {
      const parent = createRng('independence');
      for (let i = 0; i < 500; i += 1) parent.next();
      return parent.fork('talent');
    })();
    expect(Array.from({ length: 6 }, () => early.next())).toEqual(Array.from({ length: 6 }, () => late.next()));
  });

  it('gives independent streams when the same label is forked twice from one instance', () => {
    const parent = createRng('repeat');
    const one = parent.fork('company');
    const two = parent.fork('company');
    expect(one.next()).not.toBe(two.next());
    expect(rngPath(one)).toBe('repeat/company');
    expect(rngPath(two)).toBe('repeat/company~1');
  });

  it('nests: a grandchild depends on the whole path', () => {
    const a = createRng('root').fork('phase').fork('sub');
    const b = createRng('root/phase').fork('sub');
    expect(rngPath(a)).toBe('root/phase/sub');
    expect(a.next()).toBe(b.next());
  });

  it('does not disturb the parent stream when forking', () => {
    const withFork = createRng('sibling');
    const before = withFork.next();
    withFork.fork('noise');
    const after = withFork.next();

    const plain = createRng('sibling');
    expect(plain.next()).toBe(before);
    expect(plain.next()).toBe(after);
  });
});
