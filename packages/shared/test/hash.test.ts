import { describe, expect, it } from 'vitest';
import { createStateHasher, fnv1a64, hashState, stableStringify } from '../src/hash';

describe('fnv1a64', () => {
  it('returns sixteen lower-case hex characters', () => {
    expect(fnv1a64('')).toMatch(/^[0-9a-f]{16}$/);
    expect(fnv1a64('frontier')).toMatch(/^[0-9a-f]{16}$/);
  });

  it('matches the published FNV-1a 64 offset basis for the empty string', () => {
    expect(fnv1a64('')).toBe('cbf29ce484222325');
  });

  it('matches published FNV-1a 64 vectors', () => {
    expect(fnv1a64('a')).toBe('af63dc4c8601ec8c');
    expect(fnv1a64('foobar')).toBe('85944171f73967e8');
  });

  it('is stable and collision-free across near-identical inputs', () => {
    expect(fnv1a64('quarter:7')).toBe(fnv1a64('quarter:7'));
    expect(fnv1a64('quarter:7')).not.toBe(fnv1a64('quarter:8'));
    expect(fnv1a64('ab')).not.toBe(fnv1a64('ba'));
  });

  it('handles non-ASCII input deterministically', () => {
    expect(fnv1a64('Zürich')).toBe(fnv1a64('Zürich'));
    expect(fnv1a64('Zürich')).not.toBe(fnv1a64('Zurich'));
    expect(fnv1a64('🛰')).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('stableStringify', () => {
  it('is invariant to key insertion order', () => {
    const a = { alpha: 1, beta: { gamma: 2, delta: [3, 4] } };
    const b = { beta: { delta: [3, 4], gamma: 2 }, alpha: 1 };
    expect(stableStringify(a)).toBe(stableStringify(b));
    expect(hashState(a)).toBe(hashState(b));
  });

  it('preserves array order, because array order is part of the state', () => {
    expect(stableStringify([1, 2, 3])).not.toBe(stableStringify([3, 2, 1]));
  });

  it('sorts keys by code unit, not by locale', () => {
    expect(stableStringify({ b: 1, A: 2, a: 3 })).toBe('{"A":2,"a":3,"b":1}');
  });

  it('normalises numbers canonically', () => {
    expect(stableStringify(-0)).toBe('0');
    expect(stableStringify(Number.NaN)).toBe('null');
    expect(stableStringify(Number.POSITIVE_INFINITY)).toBe('null');
    expect(stableStringify(1e21)).toBe('1e+21');
    // 0.1 + 0.2 and 0.3 must not disagree in the last bit.
    expect(stableStringify(0.1 + 0.2)).toBe(stableStringify(0.3));
  });

  it('treats absent and undefined object fields alike, and undefined in arrays as null', () => {
    expect(stableStringify({ a: 1, b: undefined })).toBe('{"a":1}');
    expect(stableStringify({ a: 1 })).toBe(stableStringify({ a: 1, b: undefined }));
    expect(stableStringify([1, undefined, 2])).toBe('[1,null,2]');
  });

  it('serialises nested null without confusing it with undefined', () => {
    expect(stableStringify({ a: null })).toBe('{"a":null}');
    expect(stableStringify({ a: null })).not.toBe(stableStringify({}));
  });

  it('does not throw on cycles', () => {
    const node: Record<string, unknown> = { id: 'a' };
    node.self = node;
    expect(() => stableStringify(node)).not.toThrow();
    expect(stableStringify(node)).toBe('{"id":"a","self":"[cyclic]"}');
  });

  it('serialises a repeated (but acyclic) reference twice', () => {
    const shared = { v: 1 };
    expect(stableStringify({ a: shared, b: shared })).toBe('{"a":{"v":1},"b":{"v":1}}');
  });
});

describe('hashState / createStateHasher', () => {
  it('hashes structurally equal states identically', () => {
    const left = { companies: [{ id: 'a', cash: 1000 }], quarter: 3 };
    const right = { quarter: 3, companies: [{ cash: 1000, id: 'a' }] };
    expect(hashState(left)).toBe(hashState(right));
  });

  it('detects any change', () => {
    const base = { companies: [{ id: 'a', cash: 1000 }] };
    expect(hashState(base)).not.toBe(hashState({ companies: [{ id: 'a', cash: 1000.5 }] }));
  });

  it('rounds money-scale values at the configured precision but keeps unit intervals intact', () => {
    const hasher = createStateHasher(2);
    expect(hasher({ cash: 1_000_000.004 })).toBe(hasher({ cash: 1_000_000.001 }));
    expect(hasher({ cash: 1_000_000.004 })).not.toBe(hasher({ cash: 1_000_000.02 }));
    expect(hasher({ confidence: 0.6231 })).not.toBe(hasher({ confidence: 0.6232 }));
  });
});
