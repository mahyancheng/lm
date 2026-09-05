/**
 * @frontier/shared — rng.ts
 *
 * The only source of randomness permitted anywhere in the simulation.
 *
 * `Math.random()` is forbidden in `packages/simulation` and `packages/shared`.
 * Every stochastic decision in the engine comes from a `SeededRng` built here
 * from `SessionState.seed`, which is what makes
 * `S_{t+1} = F(S_t, actions, modifiers, seed)` replayable.
 *
 * ## The generator
 *
 * `sfc32` (Small Fast Counter, 32-bit) with a 128-bit state, seeded by expanding
 * the seed string through a `splitmix32` sequence. It uses only `Math.imul`,
 * `>>>` and `|0`, so every operation is exact 32-bit integer arithmetic and the
 * output is byte-identical on every JavaScript engine and every platform. There
 * is no floating-point accumulation anywhere in the state.
 *
 * ## Stream-stability guarantees
 *
 * These are the properties the resolver and its tests rely on. They are the
 * contract of this module, not incidental behaviour:
 *
 * 1. **Seed determinism.** `createRng(s)` produces the same sequence for the
 *    same `s`, forever, on every machine. Numeric and string seeds are
 *    normalised the same way: `createRng(424242)` === `createRng('424242')`.
 * 2. **Path derivation.** A forked stream is derived from the *path* of labels
 *    that produced it — `"424242/phase:market_resolution/pricing"` — and from
 *    nothing else. Two RNGs created from the same seed therefore have identical
 *    fork trees.
 * 3. **Draw independence.** `fork(label)` does **not** depend on how many times
 *    the parent has been drawn from. Forking a stream before or after taking a
 *    hundred draws yields the identical child. This is what stops a new draw in
 *    the market phase from shifting which candidates the talent phase picked.
 * 4. **Label independence.** Two forks with different labels are independent
 *    streams: their first draws are uncorrelated.
 * 5. **Repeat forks.** Forking the *same* label twice from the *same* instance
 *    yields two independent streams, because the second fork appends its
 *    occurrence counter to the path (`label`, then `label~1`, `label~2`, ...).
 *    A subsystem that wants the same stream twice should fork once and keep it;
 *    a subsystem that loops `fork(companyId)` gets one stream per company.
 *    Counters are per label and per instance, so guarantee 3 still holds.
 *
 * Mutating a stream (calling `next`) never affects its parent or its siblings.
 */

import type { SeededRng } from '@frontier/contracts';

/* -------------------------------------------------------------------------- */
/*  Seed expansion                                                             */
/* -------------------------------------------------------------------------- */

/** FNV-1a 32-bit over UTF-16 code units. Deterministic, exact 32-bit. */
function hash32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** One step of splitmix32. Used only to expand a seed into generator state. */
function splitmix32(state: number): { value: number; state: number } {
  let next = (state + 0x9e3779b9) >>> 0;
  let z = next;
  z = Math.imul(z ^ (z >>> 16), 0x21f0aaad);
  z = Math.imul(z ^ (z >>> 15), 0x735a2d97);
  z = (z ^ (z >>> 15)) >>> 0;
  return { value: z, state: next };
}

/** Expand a path string into the four 32-bit words sfc32 needs. */
function expandSeed(path: string): [number, number, number, number] {
  let state = hash32(path);
  const words: number[] = [];
  for (let i = 0; i < 4; i += 1) {
    const step = splitmix32(state);
    state = step.state;
    words.push(step.value);
  }
  const [a = 1, b = 1, c = 1, d = 1] = words;
  // sfc32 degenerates only on an all-zero state; nudge it rather than branch later.
  if ((a | b | c | d) === 0) return [1, 2, 3, 4];
  return [a, b, c, d];
}

/* -------------------------------------------------------------------------- */
/*  The generator                                                              */
/* -------------------------------------------------------------------------- */

class Sfc32Rng implements SeededRng {
  private a: number;
  private b: number;
  private c: number;
  private d: number;

  /** How many times each label has already been forked from this instance. */
  private readonly forkCounts = new Map<string, number>();

  constructor(readonly path: string) {
    const [a, b, c, d] = expandSeed(path);
    this.a = a;
    this.b = b;
    this.c = c;
    this.d = d;
    // Discard a short warm-up so that near-identical paths diverge immediately.
    for (let i = 0; i < 8; i += 1) this.step();
  }

  private step(): number {
    const t = (this.a + this.b) | 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) | 0;
    this.c = (this.c << 21) | (this.c >>> 11);
    this.d = (this.d + 1) | 0;
    const u = (t + this.d) | 0;
    this.c = (this.c + u) | 0;
    return u >>> 0;
  }

  /** Uniform in [0, 1). Exactly 32 bits of entropy per draw. */
  next(): number {
    return this.step() / 4294967296;
  }

  /** Uniform real in [min, max). Returns `min` when the range is empty or invalid. */
  range(min: number, max: number): number {
    if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return min;
    return min + this.next() * (max - min);
  }

  /** Uniform integer in [min, max] inclusive. */
  int(min: number, max: number): number {
    const lo = Math.ceil(min);
    const hi = Math.floor(max);
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) return lo;
    const span = hi - lo + 1;
    return lo + Math.min(span - 1, Math.floor(this.next() * span));
  }

  /** One element of a non-empty array. Throws on an empty array. */
  pick<T>(arr: readonly T[]): T {
    if (arr.length === 0) throw new Error('SeededRng.pick: cannot pick from an empty array');
    const index = this.int(0, arr.length - 1);
    const chosen = arr[index];
    if (chosen === undefined) {
      const first = arr[0];
      if (first === undefined) throw new Error('SeededRng.pick: cannot pick from an empty array');
      return first;
    }
    return chosen;
  }

  /** A new shuffled copy. Does not mutate the input. Fisher-Yates, descending. */
  shuffle<T>(arr: readonly T[]): T[] {
    const out = arr.slice();
    for (let i = out.length - 1; i > 0; i -= 1) {
      const j = this.int(0, i);
      const a = out[i];
      const b = out[j];
      if (a === undefined || b === undefined) continue;
      out[i] = b;
      out[j] = a;
    }
    return out;
  }

  /**
   * An independent stream derived from this one and `label`.
   *
   * Depends on this stream's path and the label only — never on how many draws
   * have been taken. See the stream-stability guarantees at the top of the file.
   */
  fork(label: string): SeededRng {
    const seen = this.forkCounts.get(label) ?? 0;
    this.forkCounts.set(label, seen + 1);
    const suffix = seen === 0 ? label : `${label}~${seen}`;
    return new Sfc32Rng(`${this.path}/${suffix}`);
  }
}

/* -------------------------------------------------------------------------- */
/*  Factory                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Build a seeded random stream.
 *
 * `createRng(424242)` and `createRng('424242')` are the same stream: numeric
 * seeds are normalised to their decimal string so a session seed can be stored
 * as either without changing a single outcome.
 */
export function createRng(seed: number | string): SeededRng {
  const path = typeof seed === 'number' ? normaliseNumericSeed(seed) : seed;
  return new Sfc32Rng(path);
}

/** Numeric seeds normalise to a plain decimal string, `-0` included. */
function normaliseNumericSeed(seed: number): string {
  if (!Number.isFinite(seed)) return 'seed_nonfinite';
  if (Object.is(seed, -0)) return '0';
  return String(seed);
}

/** The label path a stream was derived from. Diagnostics only. */
export function rngPath(rng: SeededRng): string {
  return rng instanceof Sfc32Rng ? rng.path : '<external>';
}
