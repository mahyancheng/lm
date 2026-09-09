/**
 * @frontier/llm — compose/redaction.ts
 *
 * The information boundary, made mechanical.
 *
 * Composers are the only place in the system where canonical state becomes
 * prose a model reads, which makes them the only place a leak can happen. The
 * discipline is:
 *
 * 1. **Composers accept pre-redacted inputs.** They are handed a projection
 *    that already contains only what this actor may know. They never reach into
 *    `SessionState` themselves — that is why nothing in this directory imports
 *    the session aggregate.
 * 2. **Composers assert the obvious leaks anyway.** A projection builder is
 *    code, and code has bugs. If an NPC strategist is handed a rival's secret
 *    research programme, or a character is handed somebody else's memories, the
 *    composer throws rather than quietly writing it into a prompt. An NPC that
 *    "knows" a secret is a bug in the input builder, and a loud one is cheaper
 *    than a silent one.
 *
 * The checks here are structural first (ownership of typed records) and
 * textual second (field names that only ever appear in internal state). The
 * textual pass is a smoke alarm, not a firewall: it catches a briefing string
 * built by dumping an internal object, which is the realistic failure mode.
 */

/** Thrown when a composer is handed state the actor may not see. */
export class LlmContextLeakError extends Error {
  readonly field: string;
  readonly detail: string;

  constructor(field: string, detail: string) {
    super(`context leak in "${field}": ${detail}`);
    this.name = 'LlmContextLeakError';
    this.field = field;
    this.detail = detail;
  }
}

/**
 * Field names that exist only on internal state and must never reach a prompt.
 * A briefing that mentions any of them was built by serialising an engine
 * object rather than by projecting a view.
 */
export const INTERNAL_STATE_MARKERS: readonly RegExp[] = [
  /\bisSecret\b/,
  /\bconfidenceByCompany\b/,
  /\binternalConfidence\b/,
  /\bisTruthful\b/,
  /\bcompany_private\b/,
  /\bclassified\b/i,
];

/** Throw when a briefing string carries an internal-state field name. */
export function assertNoInternalMarkers(field: string, text: string): void {
  for (const marker of INTERNAL_STATE_MARKERS) {
    if (marker.test(text)) {
      throw new LlmContextLeakError(field, `text mentions the internal field ${String(marker)}; briefings must be projected, not serialised`);
    }
  }
}

/** Throw unless every record belongs to `ownerId`. */
export function assertOwnedBy<T>(field: string, items: readonly T[], ownerId: string, ownerOf: (item: T) => string): void {
  for (const item of items) {
    const owner = ownerOf(item);
    if (owner !== ownerId) {
      throw new LlmContextLeakError(field, `an entry belongs to "${owner}" but this context is scoped to "${ownerId}"`);
    }
  }
}

/** A record carrying a company-private research programme. */
export interface SecretBearingRecord {
  readonly companyId: string;
  readonly isSecret: boolean;
  readonly id?: string;
}

/**
 * Throw when any research programme belongs to another company, and throw
 * loudest when that programme is secret. This is the canonical example: a
 * rival's `isSecret` programme is the single most valuable thing an NPC could
 * illegitimately learn, because it is exactly the informational edge the
 * research bet was made on.
 */
export function assertNoForeignSecretResearch(field: string, ownCompanyId: string, projects: readonly SecretBearingRecord[]): void {
  for (const project of projects) {
    if (project.companyId === ownCompanyId) continue;
    const label = project.id === undefined ? 'a programme' : `programme "${project.id}"`;
    if (project.isSecret) {
      throw new LlmContextLeakError(field, `${label} is a secret programme belonging to "${project.companyId}", not to "${ownCompanyId}"`);
    }
    throw new LlmContextLeakError(field, `${label} belongs to "${project.companyId}", not to "${ownCompanyId}"`);
  }
}
