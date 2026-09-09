/**
 * @frontier/simulation — economy/decay.ts
 *
 * How a modifier fades, and what its operand is worth in a given quarter.
 *
 * Kept in its own module because both the modifier application path and the
 * read-only company-metric projection need it, and neither should have to import
 * the other.
 */

import type { DecayFactorFn, ModifierDecay, TargetOperation } from '@frontier/contracts';
import { clamp01 } from './util';

/**
 * Multiplier applied to a modifier's nominal value in a given quarter of its
 * life. Pure and deterministic; `elapsedQuarters` is 0 in the quarter the
 * modifier first applies.
 *
 * - `none` — full strength for the whole duration, then nothing. A new rule is a
 *   step change, not a shock that fades.
 * - `linear` — fades evenly to zero across `durationQuarters`. Supply shocks.
 * - `exponential` — hardest immediately, then decays quickly. Sentiment and panic.
 */
export const decayFactor: DecayFactorFn = (decay: ModifierDecay, elapsedQuarters: number, durationQuarters: number): number => {
  const duration = Number.isFinite(durationQuarters) ? Math.max(1, Math.trunc(durationQuarters)) : 1;
  const elapsed = Number.isFinite(elapsedQuarters) ? Math.max(0, Math.trunc(elapsedQuarters)) : 0;
  if (elapsed >= duration) return 0;
  switch (decay) {
    case 'none':
      return 1;
    case 'linear':
      return clamp01(1 - elapsed / duration);
    case 'exponential':
      return clamp01(Math.exp((-3 * elapsed) / duration));
    default: {
      const never: never = decay;
      return never;
    }
  }
};

/**
 * The operand to use this quarter, after decay.
 *
 * For `multiply` the decayed value tends toward 1.0 (no effect), not toward 0
 * (annihilation) — a decaying 1.30x supply shock becomes 1.15x, never 0.15x.
 * For `set` the decay factor is meaningless and the literal value stands.
 */
export function effectiveOperand(operation: TargetOperation, value: number, factor: number): number {
  if (!Number.isFinite(value)) return operation === 'multiply' ? 1 : 0;
  const f = Number.isFinite(factor) ? clamp01(factor) : 0;
  if (operation === 'multiply') return 1 + (value - 1) * f;
  if (operation === 'set') return value;
  return value * f;
}
