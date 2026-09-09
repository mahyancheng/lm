/**
 * @frontier/simulation — relationships/memory.ts
 *
 * Memory decay.
 *
 * `strength` is salience after decay; once it falls below
 * `MEMORY_RECALL_THRESHOLD` the memory stops being supplied to the dialogue
 * agent and is dropped from live state. Decay rates come from the memory's kind
 * (`MEMORY_DECAY_RATES`), which is why a favour is largely forgotten within a
 * year and a betrayal is still there four years later.
 *
 * Decay is bookkeeping, not an economic mutation: it moves no money, no shares
 * and no reputation, so it writes no ledger row. What a character remembers
 * became auditable when the memory was stored.
 */

import type { ResolverContext, SessionState } from '@frontier/contracts';
import { MEMORY_RECALL_THRESHOLD } from '@frontier/contracts';
import { unit } from './util';

/** Most memories one character keeps in live state; the weakest fall off first. */
export const MAX_MEMORIES_PER_CHARACTER = 60;

export interface MemoryDecayResult {
  readonly decayed: number;
  readonly forgotten: number;
  readonly trimmed: number;
}

/**
 * Decay salience and drop everything below the recall threshold.
 *
 * Memories stored in the quarter being resolved are left at full strength: an
 * event does not begin fading in the quarter it happens.
 */
export function decayMemories(draft: SessionState, ctx: ResolverContext): MemoryDecayResult {
  let decayed = 0;

  for (const memory of draft.memories) {
    if (memory.quarter >= ctx.quarter) continue;
    if (memory.decayRate <= 0) continue;
    const next = unit(memory.strength * (1 - memory.decayRate));
    if (next !== memory.strength) {
      memory.strength = next;
      decayed += 1;
    }
  }

  const before = draft.memories.length;
  const kept = draft.memories.filter((m) => m.strength >= MEMORY_RECALL_THRESHOLD);
  const forgotten = before - kept.length;

  // Cap per owner, keeping the most salient. Ties resolve by array order, which
  // is stable, so the trim is deterministic.
  const perOwner = new Map<string, number>();
  const ranked = [...kept]
    .map((memory, index) => ({ memory, index }))
    .sort((a, b) => (b.memory.strength - a.memory.strength) || (a.index - b.index));
  const survivors = new Set<string>();
  let trimmed = 0;
  for (const entry of ranked) {
    const owner = entry.memory.ownerCharacterId;
    const count = perOwner.get(owner) ?? 0;
    if (count >= MAX_MEMORIES_PER_CHARACTER) {
      trimmed += 1;
      continue;
    }
    perOwner.set(owner, count + 1);
    survivors.add(entry.memory.id);
  }

  draft.memories = kept.filter((m) => survivors.has(m.id));
  return { decayed, forgotten, trimmed };
}

/** Memories a character still recalls about a subject, strongest first. */
export function recalled(draft: SessionState, ownerCharacterId: string, aboutId: string | null = null): SessionState['memories'] {
  return draft.memories
    .filter((m) => m.ownerCharacterId === ownerCharacterId && (aboutId === null || m.aboutId === aboutId))
    .filter((m) => m.strength >= MEMORY_RECALL_THRESHOLD)
    .sort((a, b) => b.strength - a.strength || b.quarter - a.quarter);
}
