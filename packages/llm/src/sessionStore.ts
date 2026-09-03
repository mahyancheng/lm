/**
 * @frontier/llm — sessionStore.ts
 *
 * The mapping from a *game* conversation to a *Claude Code* session.
 *
 * Frontier Capital has two interaction shapes and they get their context in
 * opposite ways (see docs/LLM_CONTRACTS.md §11):
 *
 * - **Strategic calls are fresh sessions.** The World Director's quarterly
 *   proposal and every NPC strategist plan open a new session with a dossier
 *   composed from canonical state. Rebuilding context per call is what
 *   *enforces* the information boundary — nothing an NPC saw in a previous life
 *   can leak past the composer — and it keeps 40-quarter campaigns inside any
 *   context window. These calls pass `sessionKey: null` and never touch this
 *   store.
 * - **Conversations are persistent sessions.** A Chief of Staff thread or a
 *   negotiation with a director maps 1:1 to one Claude Code session, resumed by
 *   id on every message so dialogue has genuine multi-turn memory. Those calls
 *   pass a stable `sessionKey` and this store holds the mapping.
 *
 * ## Contract for implementors
 *
 * - `sessionKey` is an opaque server-derived digest: the API layer computes an
 *   HMAC over (role, principal, game session, seat, thread) under
 *   `LLM_KEY_SECRET`, so a key is stable for the life of the conversation and
 *   is never composed from anything a client controls directly. Implementors
 *   should treat keys as opaque strings and impose no format.
 * - `get` returns the last Claude session id stored for that key, or null. A
 *   null is never an error: the transport simply opens a fresh session.
 * - `set` is last-write-wins. The Agent SDK may hand back a *new* session id
 *   after a resume (a fork, a compaction), so the value is expected to change.
 * - Neither method may throw. A store that cannot reach its backend returns
 *   null from `get` and swallows `set`; losing continuity degrades a
 *   conversation, it must never fail a quarter.
 *
 * The web app supplies a Supabase-backed implementation over the
 * service-role-only `conversation_llm_sessions` table (migration 0017).
 * Clients never see that table: a Claude session id is a credential-shaped
 * handle to a transcript, and transcripts are disposable while the database is
 * the long-term memory.
 */

import type { ChiefOfStaffMemory } from '@frontier/contracts';
import { EMPTY_CHIEF_OF_STAFF_MEMORY } from '@frontier/contracts';
import { readMemory } from './chiefOfStaffMemory';

export interface LlmSessionStore {
  /** The Claude Code session id last recorded for this conversation, or null. Never throws. */
  get(sessionKey: string): Promise<string | null>;
  /** Record the Claude Code session id for this conversation. Last write wins. Never throws. */
  set(sessionKey: string, claudeSessionId: string): Promise<void>;
}

/** An in-memory store with inspection helpers, for demo mode and tests. */
export interface InMemoryLlmSessionStore extends LlmSessionStore {
  readonly size: number;
  /** Synchronous peek, for assertions. */
  peek(sessionKey: string): string | null;
  clear(): void;
  entries(): [string, string][];
}

/**
 * Process-local session store.
 *
 * Correct for demo mode and for tests; wrong for a serverless deployment,
 * where two requests land in different instances and continuity would be lost
 * silently. Production uses the Supabase-backed implementation.
 */
export function createInMemorySessionStore(initial: Readonly<Record<string, string>> = {}): InMemoryLlmSessionStore {
  const map = new Map<string, string>(Object.entries(initial));

  return {
    get size() {
      return map.size;
    },
    async get(sessionKey: string): Promise<string | null> {
      return map.get(sessionKey) ?? null;
    },
    async set(sessionKey: string, claudeSessionId: string): Promise<void> {
      map.set(sessionKey, claudeSessionId);
    },
    peek(sessionKey: string): string | null {
      return map.get(sessionKey) ?? null;
    },
    clear(): void {
      map.clear();
    },
    entries(): [string, string][] {
      return [...map.entries()];
    },
  };
}

/** A store that remembers nothing. Every dialogue turn opens a fresh session. */
export function createNullSessionStore(): LlmSessionStore {
  return {
    async get(): Promise<string | null> {
      return null;
    },
    async set(): Promise<void> {
      /* intentionally empty */
    },
  };
}

/* -------------------------------------------------------------------------- */
/*  Conversation memory                                                        */
/* -------------------------------------------------------------------------- */

/**
 * The durable half of a Chief of Staff thread, keyed by the same opaque
 * conversation key the session store uses.
 *
 * Separate interface, same key space, and deliberately so. A Claude session id
 * is a credential-shaped handle to a transcript that any restart may
 * invalidate; a memory is the founder's own standing preferences and the last
 * few exchanges, and it has to survive exactly the events that take the
 * transcript. Storing both under one method would make the shorter-lived one
 * the lifetime of the pair.
 *
 * The same contract applies: neither method may throw, and a store that cannot
 * reach its backend returns the empty memory and swallows the write. Losing
 * continuity degrades a conversation; it must never fail a quarter.
 */
export interface LlmMemoryStore {
  /** The memory recorded for this conversation, or the empty memory. Never throws. */
  get(sessionKey: string): Promise<ChiefOfStaffMemory>;
  /** Record the memory for this conversation. Last write wins. Never throws. */
  set(sessionKey: string, memory: ChiefOfStaffMemory): Promise<void>;
}

/** An in-memory memory store with inspection helpers, for demo mode and tests. */
export interface InMemoryLlmMemoryStore extends LlmMemoryStore {
  readonly size: number;
  /** Synchronous peek, for assertions. */
  peek(sessionKey: string): ChiefOfStaffMemory;
  clear(): void;
}

/**
 * Process-local memory store.
 *
 * Correct for demo mode — which is what the Pi runs — and for tests. Everything
 * written here is re-parsed on read, so a corrupted or stale entry degrades to
 * the empty memory rather than reaching a prompt unvalidated.
 */
export function createInMemoryMemoryStore(initial: Readonly<Record<string, ChiefOfStaffMemory>> = {}): InMemoryLlmMemoryStore {
  const map = new Map<string, ChiefOfStaffMemory>(Object.entries(initial));

  return {
    get size() {
      return map.size;
    },
    async get(sessionKey: string): Promise<ChiefOfStaffMemory> {
      return readMemory(map.get(sessionKey));
    },
    async set(sessionKey: string, memory: ChiefOfStaffMemory): Promise<void> {
      map.set(sessionKey, readMemory(memory));
    },
    peek(sessionKey: string): ChiefOfStaffMemory {
      return readMemory(map.get(sessionKey));
    },
    clear(): void {
      map.clear();
    },
  };
}

/** A store that remembers nothing. Every turn starts from the empty memory. */
export function createNullMemoryStore(): LlmMemoryStore {
  return {
    async get(): Promise<ChiefOfStaffMemory> {
      return EMPTY_CHIEF_OF_STAFF_MEMORY;
    },
    async set(): Promise<void> {
      /* intentionally empty */
    },
  };
}
