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
