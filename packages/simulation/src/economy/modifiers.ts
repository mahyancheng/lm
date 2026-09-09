/**
 * @frontier/simulation — economy/modifiers.ts
 *
 * Registering, validating, applying and expiring world modifiers.
 *
 * A modifier is the only mechanism by which the World Director can change
 * reality, and this module is where its bounds are enforced:
 *
 * - the target must be a registered path and the entity behind a pattern path
 *   must exist (`unknown_target_path`, `unknown_entity`);
 * - the operation must be one the registry permits (`operation_not_permitted`);
 * - the operand is clamped to the impact budget (`magnitude_exceeds_budget`);
 * - the lifetime must be 1..12 quarters (`duration_out_of_range`);
 * - one event may carry only so many modifiers (`too_many_modifiers`);
 * - a modifier that directly contradicts one already in force this quarter is
 *   refused (`contradicts_active_modifier`);
 * - reference-market instruments are never targetable (`targets_reference_market`).
 *
 * Application order is by modifier id, always. Two modifiers touching the same
 * path must compose in one order, and it has to be an order that does not depend
 * on the order proposals happened to arrive in.
 */

import type {
  ActiveModifier,
  ImpactBudget,
  ModifierRejectionReason,
  ModifierValidationResult,
  SessionState,
  TargetApplication,
  WorldModifier,
  WorldModifierProposal,
} from '@frontier/contracts';
import { getTargetPathSpec, makeId, targetPathEntityId } from '@frontier/contracts';
import { applyToTargetPath } from '../targetPaths';
import { decayFactor, effectiveOperand } from './decay';
import { buildTargetPathScope, commitCompanyMetrics, type MutableTargetPathScope } from './scope';
import { clampOperandToBudget } from './hazards';
import { clamp, round } from './util';

/* -------------------------------------------------------------------------- */
/*  Registration                                                               */
/* -------------------------------------------------------------------------- */

/** Wrap a validated modifier as an active one, with decay resolved for its first quarter. */
export function toActiveModifier(modifier: WorldModifier, quarter: number): ActiveModifier {
  const elapsed = clamp(quarter - modifier.appliedAtQuarter, 0, 12);
  return {
    ...modifier,
    elapsedQuarters: elapsed,
    effectiveValue: effectiveOperand(modifier.operation, modifier.value, decayFactor(modifier.decay, elapsed, modifier.durationQuarters)),
    lastAppliedQuarter: null,
    exhausted: modifier.remainingQuarters <= 0,
  };
}

/** Stable application order: by id, always. */
export function sortModifiers<T extends { id: string }>(modifiers: readonly T[]): T[] {
  return modifiers.slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/* -------------------------------------------------------------------------- */
/*  Validation                                                                 */
/* -------------------------------------------------------------------------- */

const REJECTION_DETAIL: Record<ModifierRejectionReason, string> = {
  unknown_target_path: 'No registry entry for this path.',
  unknown_entity: 'The path is legal but the sector or company it names does not exist in this session.',
  operation_not_permitted: 'The registry does not permit this operation on this path.',
  magnitude_exceeds_budget: 'The operand exceeds the single-modifier magnitude cap.',
  duration_out_of_range: 'Lifetime must be between 1 and 12 quarters.',
  too_many_modifiers: 'This event already carries the maximum number of modifiers.',
  contradicts_active_modifier: 'A modifier in force this quarter moves the same path in the opposite direction.',
  targets_reference_market: 'Reference-market instruments are read-only and can never be targeted.',
};

/** True when two operands on the same path pull in opposite directions. */
function contradicts(a: { operation: string; value: number }, b: { operation: string; value: number }): boolean {
  if (a.operation !== b.operation) return false;
  if (a.operation === 'multiply') return (a.value - 1) * (b.value - 1) < 0;
  return a.value * b.value < 0;
}

/**
 * Validate a batch of proposed modifiers for one event.
 *
 * Nothing here throws and nothing here mutates: it returns the accepted set
 * (clamped and id-assigned) alongside every rejection, so the caller can write
 * both to the ledger.
 */
export function validateModifierProposals(
  draft: SessionState,
  proposals: readonly WorldModifierProposal[],
  options: {
    readonly budget: ImpactBudget;
    readonly quarter: number;
    readonly originEventId: string | null;
    readonly idPrefixParts: readonly (string | number)[];
    readonly source: WorldModifier['source'];
    readonly severityFraction: number;
  },
): ModifierValidationResult {
  const accepted: WorldModifier[] = [];
  const rejected: { proposal: WorldModifierProposal; reason: ModifierRejectionReason; detail: string }[] = [];
  let clampedCount = 0;

  const referenceNames = new Set<string>();
  for (const instrument of draft.marketInstruments) {
    if (!instrument.isReference) continue;
    referenceNames.add(instrument.id.toLowerCase());
    referenceNames.add(instrument.symbol.toLowerCase());
  }

  const reject = (proposal: WorldModifierProposal, reason: ModifierRejectionReason): void => {
    rejected.push({ proposal, reason, detail: REJECTION_DETAIL[reason] });
  };

  for (const proposal of proposals) {
    const spec = getTargetPathSpec(proposal.target);
    if (spec === null) {
      const lowered = proposal.target.toLowerCase();
      const namesReference = [...referenceNames].some((name) => name.length > 0 && lowered.includes(name));
      reject(proposal, namesReference ? 'targets_reference_market' : 'unknown_target_path');
      continue;
    }

    const entity = targetPathEntityId(proposal.target);
    if (entity !== null) {
      const exists =
        entity.entity === 'sector'
          ? draft.sectors[entity.id] !== undefined
          : draft.companies.some((company) => company.id === entity.id);
      if (!exists) {
        reject(proposal, 'unknown_entity');
        continue;
      }
    }

    if (!spec.operations.includes(proposal.operation)) {
      reject(proposal, 'operation_not_permitted');
      continue;
    }
    if (!Number.isInteger(proposal.durationQuarters) || proposal.durationQuarters < 1 || proposal.durationQuarters > 12) {
      reject(proposal, 'duration_out_of_range');
      continue;
    }
    if (accepted.length >= options.budget.maxModifiersPerEvent) {
      reject(proposal, 'too_many_modifiers');
      continue;
    }

    const opposing = draft.activeModifiers.some(
      (active) =>
        active.target === proposal.target &&
        active.remainingQuarters > 0 &&
        active.appliedAtQuarter === options.quarter &&
        contradicts(active, proposal),
    );
    if (opposing) {
      reject(proposal, 'contradicts_active_modifier');
      continue;
    }

    const { value, clamped } = clampOperandToBudget(proposal.target, proposal.operation, proposal.value, options.budget);
    if (clamped) clampedCount += 1;

    accepted.push({
      id: makeId('mod', ...options.idPrefixParts, accepted.length),
      source: options.source,
      target: proposal.target,
      operation: proposal.operation,
      value: round(value, 6),
      decay: proposal.decay,
      durationQuarters: proposal.durationQuarters,
      remainingQuarters: proposal.durationQuarters,
      appliedAtQuarter: options.quarter,
      originEventId: options.originEventId,
      reason: proposal.reason.slice(0, 240),
    });
  }

  return { accepted, rejected, clampedCount, severityUsed: clamp(options.severityFraction, 0, 1) };
}

/* -------------------------------------------------------------------------- */
/*  Application                                                                */
/* -------------------------------------------------------------------------- */

/** One modifier's effect on the world this quarter. */
export interface ModifierApplication {
  readonly modifier: ActiveModifier;
  readonly result: TargetApplication;
  readonly operand: number;
  readonly factor: number;
}

/**
 * Apply every active modifier to its target path, clamping to the registered
 * bounds. Mutates the draft; returns one record per attempted application so the
 * caller can emit a ledger row for each.
 */
export function applyActiveModifiers(draft: SessionState, quarter: number): ModifierApplication[] {
  const scope: MutableTargetPathScope = buildTargetPathScope(draft);
  const applications: ModifierApplication[] = [];

  for (const modifier of sortModifiers(draft.activeModifiers)) {
    if (modifier.remainingQuarters <= 0 || modifier.exhausted) continue;
    // Idempotency guard: a modifier applies at most once per quarter, however
    // many times the phase is run.
    if (modifier.lastAppliedQuarter === quarter) continue;

    const elapsed = clamp(quarter - modifier.appliedAtQuarter, 0, 12);
    const factor = decayFactor(modifier.decay, elapsed, modifier.durationQuarters);
    const operand = effectiveOperand(modifier.operation, modifier.value, factor);
    const result = applyToTargetPath(scope, modifier.target, modifier.operation, operand);

    modifier.elapsedQuarters = elapsed;
    modifier.effectiveValue = round(operand, 6);
    if (result.applied) modifier.lastAppliedQuarter = quarter;

    applications.push({ modifier, result, operand, factor });
  }

  commitCompanyMetrics(draft, scope);
  return applications;
}

/* -------------------------------------------------------------------------- */
/*  Decay and expiry                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Advance decay, decrement remaining quarters and remove exhausted modifiers.
 * Returns the modifiers that expired, so the caller can emit `modifier_expired`.
 */
export function decayActiveModifiers(draft: SessionState, quarter: number): ActiveModifier[] {
  const surviving: ActiveModifier[] = [];
  const expired: ActiveModifier[] = [];

  for (const modifier of sortModifiers(draft.activeModifiers)) {
    const remaining = modifier.remainingQuarters - 1;
    if (remaining <= 0) {
      modifier.remainingQuarters = 0;
      modifier.exhausted = true;
      expired.push(modifier);
      continue;
    }
    const elapsed = clamp(quarter - modifier.appliedAtQuarter + 1, 0, 12);
    modifier.remainingQuarters = remaining;
    modifier.elapsedQuarters = elapsed;
    modifier.effectiveValue = round(
      effectiveOperand(modifier.operation, modifier.value, decayFactor(modifier.decay, elapsed, modifier.durationQuarters)),
      6,
    );
    modifier.exhausted = false;
    surviving.push(modifier);
  }

  draft.activeModifiers = surviving;
  return expired;
}
