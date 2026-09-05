/**
 * @frontier/simulation — targetPaths.ts
 *
 * The implementation of `ResolveTargetPathFn` and `ApplyToTargetPathFn`.
 *
 * These two functions are the only door between a world modifier and canonical
 * state. Everything a World Director proposal, an event template or a system
 * correction wants to change goes through here, which is why the rules live in
 * exactly one place:
 *
 * - A path must be registered (`getTargetPathSpec`), fixed or pattern.
 * - The operation must be one the registry permits for that path.
 * - The referenced entity (sector, company) must exist in the scope.
 * - The result is clamped to the registered bounds. It is never NaN, never
 *   Infinity, and the function never throws: an illegal application comes back
 *   as `applied: false` with a reason the caller writes to the ledger.
 *
 * The registry helpers (`getTargetPathSpec`, `isLegalTargetPath`,
 * `clampToTargetBounds`, `targetPathEntityId`) live in `@frontier/contracts` and
 * are used as-is; none of that logic is reimplemented here.
 */

import type {
  ApplyToTargetPathFn,
  ResolveTargetPathFn,
  TargetApplication,
  TargetOperation,
  TargetPathScope,
  TargetPathSpec,
} from '@frontier/contracts';
import { clampToTargetBounds, getTargetPathSpec, isLegalTargetPath, targetPathEntityId } from '@frontier/contracts';

/* -------------------------------------------------------------------------- */
/*  Internal mutable views                                                     */
/* -------------------------------------------------------------------------- */

/**
 * `TargetPathScope` is declared readonly so no caller mutates it by accident.
 * Applying a modifier is precisely the sanctioned mutation, so this module —
 * and only this module — takes a mutable view of it.
 */
type NumberRecord = Record<string, number>;
type DomainRecord = Record<string, unknown>;

const worldDomains = (scope: TargetPathScope): Record<string, DomainRecord | undefined> =>
  scope.world as unknown as Record<string, DomainRecord | undefined>;

const sectorRecords = (scope: TargetPathScope): Record<string, DomainRecord | undefined> =>
  scope.sectors as unknown as Record<string, DomainRecord | undefined>;

const companyRecords = (scope: TargetPathScope): Record<string, NumberRecord | undefined> =>
  scope.companyMetrics as unknown as Record<string, NumberRecord | undefined>;

const finiteNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

/** Split `world.<domain>.<field>` into its two trailing segments. */
function splitWorldPath(path: string): { domain: string; field: string } | null {
  const parts = path.split('.');
  const domain = parts[1];
  const field = parts[2];
  if (parts.length !== 3 || parts[0] !== 'world' || domain === undefined || field === undefined) return null;
  return { domain, field };
}

/* -------------------------------------------------------------------------- */
/*  Reading                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Read the current numeric value at a target path.
 *
 * Returns `null` when the path is not registered, when the path is registered
 * but the referenced sector/company is not in the scope, or when the stored
 * value is not a finite number.
 */
export const resolveTargetPath: ResolveTargetPathFn = (scope, path) => {
  if (!isLegalTargetPath(path)) return null;

  const entity = targetPathEntityId(path);
  if (entity === null) {
    const parsed = splitWorldPath(path);
    if (parsed === null) return null;
    const domain = worldDomains(scope)[parsed.domain];
    if (domain === undefined) return null;
    return finiteNumber(domain[parsed.field]);
  }

  if (entity.entity === 'sector') {
    const sector = sectorRecords(scope)[entity.id];
    if (sector === undefined) return null;
    return finiteNumber(sector[entity.metric]);
  }

  const metrics = companyRecords(scope)[entity.id];
  if (metrics === undefined) return null;
  return finiteNumber(metrics[entity.metric]);
};

/* -------------------------------------------------------------------------- */
/*  Writing                                                                    */
/* -------------------------------------------------------------------------- */

/** Write a value back to the scope. Returns false when the slot does not exist. */
function writeTargetPath(scope: TargetPathScope, path: string, value: number): boolean {
  const entity = targetPathEntityId(path);
  if (entity === null) {
    const parsed = splitWorldPath(path);
    if (parsed === null) return false;
    const domain = worldDomains(scope)[parsed.domain];
    if (domain === undefined) return false;
    domain[parsed.field] = value;
    return true;
  }
  if (entity.entity === 'sector') {
    const sector = sectorRecords(scope)[entity.id];
    if (sector === undefined) return false;
    sector[entity.metric] = value;
    return true;
  }
  const metrics = companyRecords(scope)[entity.id];
  if (metrics === undefined) return false;
  metrics[entity.metric] = value;
  return true;
}

const rejected = (path: string, before: number, reason: string): TargetApplication => ({
  applied: false,
  path,
  before,
  after: before,
  clamped: false,
  reason,
});

/** Raw arithmetic for one operation. Pure; the caller clamps the result. */
function combine(operation: TargetOperation, before: number, value: number): number {
  switch (operation) {
    case 'add':
      return before + value;
    case 'multiply':
      return before * value;
    case 'set':
      return value;
    default: {
      // Exhaustive by construction; kept so an added operation fails loudly here
      // rather than silently doing nothing.
      const never: never = operation;
      return never;
    }
  }
}

/**
 * Apply an operation to a target path, mutating `scope` in place.
 *
 * Never throws. The result always reports the value before and after, whether
 * the registered bounds truncated it, and — when nothing was applied — why.
 */
export const applyToTargetPath: ApplyToTargetPathFn = (scope, path, operation, value) => {
  const spec: TargetPathSpec | null = getTargetPathSpec(path);
  if (spec === null) return rejected(path, 0, 'unknown_target_path: no registry entry for this path');

  const before = resolveTargetPath(scope, path);
  if (before === null) {
    return rejected(path, 0, 'unknown_entity: the path is legal but the referenced value is not present in this scope');
  }

  if (!spec.operations.includes(operation)) {
    return rejected(path, before, `operation_not_permitted: ${operation} is not allowed on ${spec.path} (permitted: ${spec.operations.join(', ')})`);
  }

  if (!Number.isFinite(value)) {
    return rejected(path, before, 'illegal_value: the operand must be a finite number');
  }

  const raw = combine(operation, before, value);
  const { value: after, clamped } = clampToTargetBounds(spec, raw);

  if (!writeTargetPath(scope, path, after)) {
    return rejected(path, before, 'unknown_entity: the referenced entity disappeared between read and write');
  }

  return {
    applied: true,
    path,
    before,
    after,
    clamped,
    reason: clamped ? `clamped to registry bounds [${spec.min}, ${spec.max}] (${spec.unit})` : null,
  };
};
