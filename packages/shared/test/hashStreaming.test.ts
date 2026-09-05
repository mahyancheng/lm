/**
 * @frontier/shared — the streaming canonical hash.
 *
 * `hashCanonical` exists to hash a session without building the canonical
 * string first, because a quarter hashes the whole session once per ledger
 * phase. It is only allowed to exist if it is the SAME hash: every value below
 * is hashed both ways and the two have to agree, character for character of the
 * fold, or the ledger chain and both frozen worlds move.
 */

import { describe, expect, it } from 'vitest';
import { createStateHasher, fnv1a64, hashCanonical, hashState, stableStringify } from '../src/index';

const VALUES: readonly unknown[] = [
  null,
  0,
  -0,
  1,
  -1.5,
  1e21,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  '',
  'plain',
  'quotes " and \\ backslash',
  'newline\nand\ttab',
  'accented éàü',
  'cjk 東京証券取引所',
  'emoji 🏭🔋 with a surrogate pair',
  '\ud83d', // a lone high surrogate at the end of a string
  '\ud83dtail', // a lone high surrogate followed by an ordinary character
  true,
  false,
  [],
  {},
  [1, 'two', null, { b: 2, a: 1 }],
  { z: 1, a: { nested: [1, 2, 3] }, m: 'middle' },
  { keys: { b: 1, A: 2, a: 3, B: 4, _: 5, '0': 6 } },
  { money: 1234.5678, unit: 0.123456789, tiny: 1e-9 },
  { absent: undefined, present: 1 },
  [undefined, 1],
];

describe('the streaming canonical hash', () => {
  it('agrees with fnv1a64 over stableStringify for every shape', () => {
    for (const value of VALUES) {
      expect(hashCanonical(value), `no money precision: ${stableStringify(value)}`).toBe(fnv1a64(stableStringify(value)));
      expect(hashCanonical(value, { moneyPrecision: 2 }), `money precision 2: ${stableStringify(value)}`).toBe(
        fnv1a64(stableStringify(value, { moneyPrecision: 2 })),
      );
    }
  });

  it('is what hashState and createStateHasher use', () => {
    const deep = { companies: VALUES, world: { macro: { policyRate: 0.0425 } } };
    expect(hashState(deep)).toBe(fnv1a64(stableStringify(deep)));
    expect(createStateHasher(2)(deep)).toBe(fnv1a64(stableStringify(deep, { moneyPrecision: 2 })));
  });

  it('is a cycle-safe fixed point, exactly as the string form is', () => {
    const cyclic: Record<string, unknown> = { name: 'loop' };
    cyclic.self = cyclic;
    expect(hashCanonical(cyclic)).toBe(fnv1a64(stableStringify(cyclic)));
  });
});
