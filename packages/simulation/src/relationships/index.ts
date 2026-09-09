/**
 * @frontier/simulation — relationships
 *
 * People: how they feel about each other, what they remember, how powerful they
 * are and who is allowed to open a conversation with whom.
 *
 * Two concepts are kept apart on purpose, exactly as `people.ts` states:
 *
 * - **Connection level** — how socially and institutionally powerful a person
 *   is. It gates who may open a channel (`checkAccess`).
 * - **Relationship** — how one specific actor feels about another, in four
 *   independent dimensions. It shapes how that conversation goes.
 *
 * The subsystem runs in phase 15, `relationship_update`, in this order:
 *
 * ```text
 * updateRelationships        actions and this quarter's memories become feelings
 * decayMemories              salience fades; betrayals barely move
 * recomputeConnectionLevels  ten percentile inputs, inertia, a step limit
 * ```
 *
 * `checkAccess` is not a phase: it is a pure query the resolver, the API route
 * and the interface all call.
 */

import type { RelationshipsSubsystem, ResolverContext, SessionState } from '@frontier/contracts';
import { updateRelationships } from './reactions';
import { decayMemories } from './memory';
import { recomputeConnectionLevels } from './connection';
import { checkAccess } from './access';

export { updateRelationships, INTRODUCTION_QUARTERS, INTRODUCTION_QUALITY_THRESHOLD } from './reactions';
export { decayMemories, recalled, MAX_MEMORIES_PER_CHARACTER } from './memory';
export type { MemoryDecayResult } from './memory';
export {
  recomputeConnectionLevels,
  connectionInputs,
  connectionContribution,
  CONNECTION_WEIGHTS,
  CONNECTION_INERTIA,
  MAX_CONNECTION_STEP,
  MUTUAL_RELATIONSHIP_DEPTH,
} from './connection';
export { checkAccess, storedOverride, structuralOverride, overrideIsLive } from './access';
export type { StructuralOverride } from './access';
export {
  MEMORY_DECAY_RATES,
  NEUTRAL_RELATIONSHIP,
  MAX_SINGLE_DELTA,
  MAX_QUARTER_DELTA,
  ZERO_DELTA,
  addDelta,
  applyRelationshipDelta,
  ceoOf,
  characterById,
  companyById,
  ensureRelationship,
  findRelationship,
  memoryEffect,
  rememberEvent,
  subjectCharacterId,
} from './relations';
export type { RelationshipDelta, RememberInput } from './relations';
export { clamp, unit, score, signedScore, bipolar, round, percentileRank, ratio, emitEvent, line } from './util';

/**
 * Build the relationships subsystem. Stateless: everything it needs comes from
 * the draft and the resolver context, so one instance serves every session.
 */
export function createRelationshipsSubsystem(): RelationshipsSubsystem {
  return {
    updateRelationships,
    decayMemories(draft: SessionState, ctx: ResolverContext): void {
      decayMemories(draft, ctx);
    },
    recomputeConnectionLevels,
    checkAccess,
  };
}
