/**
 * @frontier/shared — hash.ts
 *
 * Canonical state hashing.
 *
 * Two runs of the same seed with the same recorded decisions must produce the
 * same `stateHashAfter`, on any machine, in any process, in any order of object
 * construction. That is only true if serialisation is canonical, so this module
 * owns the one serialisation the engine hashes:
 *
 * - object keys are sorted by UTF-16 code unit, never by insertion order;
 * - arrays keep their order, because `SessionState` collections are arrays
 *   precisely so that their order is part of the state;
 * - numbers are formatted canonically — `-0` is `0`, `NaN` and `±Infinity` are
 *   `null`, and every other value is rounded to 12 significant digits so that
 *   two arithmetically equivalent paths to the same figure do not disagree in
 *   the last bit;
 * - `undefined` disappears from objects (as `JSON.stringify` does) and becomes
 *   `null` inside arrays, so a missing optional and an absent one hash alike;
 * - cycles serialise as `"[cyclic]"` rather than throwing.
 *
 * No timestamps are involved anywhere: the engine never reads a clock, so a
 * state hash carries no wall-clock information by construction.
 */

/* -------------------------------------------------------------------------- */
/*  FNV-1a, 64-bit                                                             */
/* -------------------------------------------------------------------------- */

/**
 * FNV-1a over the UTF-8 bytes of `input`, as 16 lower-case hex characters.
 *
 * Implemented with four 16-bit lanes and `imul`-free integer arithmetic so the
 * 64-bit multiply is exact without `BigInt`: hashing a 100 kB state stays cheap
 * enough to run once per ledger row.
 */
export function fnv1a64(input: string): string {
  // 0xcbf29ce484222325, little-endian 16-bit lanes.
  let v0 = 0x2325;
  let v1 = 0x8422;
  let v2 = 0x9ce4;
  let v3 = 0xcbf2;

  const mix = (byte: number): void => {
    v0 ^= byte;
    // Multiply by the FNV prime 0x100000001b3 = 2^40 + 2^8 + 0xb3.
    // (2^8 + 0xb3) folds into the 0x1b3 multiplier; 2^40 shifts a lane by two
    // lanes plus eight bits, so it lands as `v0 << 8` in lane 2 and `v1 << 8`
    // in lane 3. Lane carries are resolved by the `>>> 16` terms below.
    const t0 = v0 * 0x1b3;
    const t1 = v1 * 0x1b3;
    const t2 = v2 * 0x1b3 + (v0 << 8);
    const t3 = v3 * 0x1b3 + (v1 << 8);
    v0 = t0 & 0xffff;
    v1 = (t1 + (t0 >>> 16)) & 0xffff;
    v2 = (t2 + (t1 >>> 16)) & 0xffff;
    v3 = (t3 + (t2 >>> 16)) & 0xffff;
  };

  for (let i = 0; i < input.length; i += 1) {
    const code = input.codePointAt(i) ?? 0;
    if (code > 0xffff) i += 1; // surrogate pair consumed
    if (code < 0x80) {
      mix(code);
    } else if (code < 0x800) {
      mix(0xc0 | (code >> 6));
      mix(0x80 | (code & 0x3f));
    } else if (code < 0x10000) {
      mix(0xe0 | (code >> 12));
      mix(0x80 | ((code >> 6) & 0x3f));
      mix(0x80 | (code & 0x3f));
    } else {
      mix(0xf0 | (code >> 18));
      mix(0x80 | ((code >> 12) & 0x3f));
      mix(0x80 | ((code >> 6) & 0x3f));
      mix(0x80 | (code & 0x3f));
    }
  }

  const hex = (lane: number): string => (lane & 0xffff).toString(16).padStart(4, '0');
  return `${hex(v3)}${hex(v2)}${hex(v1)}${hex(v0)}`;
}

/* -------------------------------------------------------------------------- */
/*  Canonical serialisation                                                    */
/* -------------------------------------------------------------------------- */

/** How `stableStringify` normalises numbers before writing them. */
export interface StableStringifyOptions {
  /**
   * Decimal places money-scale numbers (|value| >= 1) are rounded to before
   * hashing. Values below 1 in magnitude — probabilities, unit intervals, price
   * indices — keep their full canonical precision, because rounding a 0..1
   * variable to two decimals would erase most of the world state.
   */
  readonly moneyPrecision?: number;
}

/** Significant digits every non-integer keeps. Kills float drift, keeps meaning. */
const SIGNIFICANT_DIGITS = 12;

function canonicalNumber(value: number, moneyPrecision: number | undefined): string {
  if (!Number.isFinite(value)) return 'null';
  let v = value === 0 ? 0 : value; // collapses -0
  if (moneyPrecision !== undefined && Math.abs(v) >= 1) {
    const factor = 10 ** moneyPrecision;
    v = Math.round(v * factor) / factor;
    if (v === 0) v = 0;
  }
  if (Number.isInteger(v) && Math.abs(v) < 1e21) return String(v);
  const rounded = Number(v.toPrecision(SIGNIFICANT_DIGITS));
  return String(Number.isFinite(rounded) ? (rounded === 0 ? 0 : rounded) : 0);
}

/**
 * Deterministic JSON-shaped serialisation: sorted keys, stable array order,
 * canonical numbers, cycle-safe. Never throws.
 */
export function stableStringify(value: unknown, options: StableStringifyOptions = {}): string {
  const seen = new Set<object>();
  const { moneyPrecision } = options;

  const write = (node: unknown): string => {
    if (node === null) return 'null';
    switch (typeof node) {
      case 'number':
        return canonicalNumber(node, moneyPrecision);
      case 'string':
        return JSON.stringify(node);
      case 'boolean':
        return node ? 'true' : 'false';
      case 'bigint':
        return `"${node.toString()}n"`;
      case 'undefined':
      case 'function':
      case 'symbol':
        return 'null';
      default:
        break;
    }

    const obj = node as object;
    if (seen.has(obj)) return '"[cyclic]"';
    seen.add(obj);
    try {
      if (Array.isArray(obj)) {
        const parts: string[] = [];
        for (const item of obj) parts.push(write(item));
        return `[${parts.join(',')}]`;
      }
      const record = obj as Record<string, unknown>;
      const keys = Object.keys(record).sort(compareKeys);
      const parts: string[] = [];
      for (const key of keys) {
        const child = record[key];
        if (child === undefined || typeof child === 'function' || typeof child === 'symbol') continue;
        parts.push(`${JSON.stringify(key)}:${write(child)}`);
      }
      return `{${parts.join(',')}}`;
    } finally {
      seen.delete(obj);
    }
  };

  return write(value);
}

/** Sort by UTF-16 code unit. Locale-independent on purpose. */
function compareKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/* -------------------------------------------------------------------------- */
/*  State hashing                                                              */
/* -------------------------------------------------------------------------- */

/**
 * `fnv1a64 ∘ stableStringify`. The canonical hash of any engine value.
 *
 * Accepts `unknown` so it satisfies `StateHasher` from `@frontier/contracts`
 * while remaining usable for hashing an action batch or a GM proposal.
 */
export function hashState(value: unknown): string {
  return fnv1a64(stableStringify(value));
}

/**
 * A `StateHasher` that rounds money-scale numbers to `moneyPrecision` decimal
 * places first, so a cent of floating-point noise cannot break replay equality.
 */
export function createStateHasher(moneyPrecision: number): (value: unknown) => string {
  return (value: unknown) => fnv1a64(stableStringify(value, { moneyPrecision }));
}
