/**
 * Durable mapping from opaque game conversation keys to Codex app-server thread ids.
 *
 * This is deliberately a small server-only file store instead of the
 * `conversation_llm_sessions` Supabase table. That table is correctly scoped
 * to a UUID social conversation, while company agents have no such row and
 * their HMAC-derived keys must remain opaque. On the Pi this file lives beside
 * the Agent SDK's persisted transcript directory, so both halves needed for a
 * resume survive an app-server restart. Claude session ids are intentionally
 * never read here: a Codex thread is a different provider object and must not
 * be offered to `thread/resume` during migration.
 */

import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInMemorySessionStore, type LlmSessionStore } from '@frontier/llm';
import { persistLocation, type PersistEnv } from './_persist';

export const SESSION_STORE_FILE_NAME = 'codex-thread-map.json';
const FILE_VERSION = 1;
const DEFAULT_TTL_MS = 1000 * 60 * 60 * 24 * 90;
const MAX_KEY_LENGTH = 256;
const MAX_SESSION_ID_LENGTH = 2048;
const MUTATION_QUEUES_KEY = Symbol.for('frontier.codexThreadStoreMutationQueues');

interface SessionRecord {
  /** A Codex `thread.id`, not a Claude session id. */
  readonly codexThreadId: string;
  readonly updatedAt: string;
}

interface SessionFile {
  readonly version: number;
  readonly records: Record<string, SessionRecord>;
}

function mutationQueues(): Map<string, Promise<void>> {
  const host = globalThis as unknown as Record<symbol, Map<string, Promise<void>> | undefined>;
  if (host[MUTATION_QUEUES_KEY] === undefined) host[MUTATION_QUEUES_KEY] = new Map();
  return host[MUTATION_QUEUES_KEY];
}

export interface DurableSessionStoreOptions {
  readonly file: string;
  readonly ttlMs?: number;
  readonly now?: () => Date;
}

/**
 * Keep provider mappings disjoint even when an in-memory store is used.
 *
 * Conversation keys are already derived from the game id and principal in the
 * admission layer. This additional provider prefix prevents a future
 * migration from accidentally treating a legacy Claude mapping as a Codex
 * thread when both providers are present in one process.
 */
export function createCodexThreadSessionStore(store: LlmSessionStore): LlmSessionStore {
  const keyFor = (key: string): string => `codex:${key}`;
  return {
    get: (key) => store.get(keyFor(key)),
    set: (key, threadId) => store.set(keyFor(key), threadId),
    invalidate: async (key) => {
      await store.invalidate?.(keyFor(key));
    },
  };
}

function validKey(value: string): boolean {
  return value.length > 0 && value.length <= MAX_KEY_LENGTH;
}

function validSessionId(value: string): boolean {
  return value.length > 0 && value.length <= MAX_SESSION_ID_LENGTH;
}

function readFile(file: string): SessionFile {
  let exists: boolean;
  try {
    exists = statSync(file).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: FILE_VERSION, records: {} };
    throw error;
  }
  if (!exists) throw new Error('Codex thread map path is not a file');
  let parsed: Partial<SessionFile>;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<SessionFile>;
  } catch (error) {
    throw new Error(`Codex thread map is unreadable: ${error instanceof Error ? error.message : 'unknown error'}`);
  }
  if (parsed.version !== FILE_VERSION || parsed.records === null || typeof parsed.records !== 'object') {
    throw new Error('Codex thread map has an unsupported schema');
  }
  if (Array.isArray(parsed.records)) throw new Error('Codex thread map records must be an object');
  const records: Record<string, SessionRecord> = {};
  for (const [key, value] of Object.entries(parsed.records)) {
    if (
      !validKey(key) || value === null || typeof value !== 'object' || Array.isArray(value) ||
      !validSessionId((value as Partial<SessionRecord>).codexThreadId ?? '') ||
      typeof (value as Partial<SessionRecord>).updatedAt !== 'string' ||
      !Number.isFinite(Date.parse((value as Partial<SessionRecord>).updatedAt ?? ''))
    ) {
      throw new Error('Codex thread map contains an invalid record');
    }
    records[key] = value as SessionRecord;
  }
  return { version: FILE_VERSION, records };
}

/** Atomic replacement ensures a restart never observes a partially written map. */
function writeFile(file: string, contents: SessionFile): void {
  const directory = join(file, '..');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `.${SESSION_STORE_FILE_NAME}.${process.pid}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, JSON.stringify(contents), { encoding: 'utf8', mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, file);
  } finally {
    try {
      rmSync(temporary, { force: true });
    } catch {
      // The successful rename has already removed the source path.
    }
  }
}

/**
 * A Pi/VPS-only, single-process store. Missing maps are empty; a corrupt or
 * unreadable map throws so the transport can report lost thread continuity
 * without overwriting the only durable mapping. Mutations are serialized because different conversation keys may
 * complete concurrently; multi-instance deployments need a shared store.
 */
export function createDurableSessionStore(options: DurableSessionStoreOptions): LlmSessionStore {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const now = options.now ?? (() => new Date());
  const queues = mutationQueues();
  const mutate = async (operation: () => void): Promise<void> => {
    const previous = queues.get(options.file) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    queues.set(options.file, next);
    await previous;
    try {
      operation();
    } finally {
      release();
      if (queues.get(options.file) === next) queues.delete(options.file);
    }
  };

  return {
    async get(sessionKey: string): Promise<string | null> {
      if (!validKey(sessionKey)) return null;
      const record = readFile(options.file).records[sessionKey];
        if (record === undefined) return null;
        if (ttlMs >= 0 && now().getTime() - Date.parse(record.updatedAt) > ttlMs) {
          const refreshed: { value: SessionRecord | null } = { value: null };
          await mutate(() => {
            const state = readFile(options.file);
            // A concurrent refresh may have happened while this get waited for
            // the file mutex. Delete only the record this read found stale.
            const current = state.records[sessionKey];
            if (current?.updatedAt !== record.updatedAt) {
              refreshed.value = current ?? null;
              return;
            }
            delete state.records[sessionKey];
            writeFile(options.file, state);
          });
          if (refreshed.value !== null && (ttlMs < 0 || now().getTime() - Date.parse(refreshed.value.updatedAt) <= ttlMs)) return refreshed.value.codexThreadId;
          return null;
        }
      return record.codexThreadId;
    },
    async set(sessionKey: string, codexThreadId: string): Promise<void> {
      if (!validKey(sessionKey) || !validSessionId(codexThreadId)) return;
      await mutate(() => {
        const state = readFile(options.file);
        state.records[sessionKey] = { codexThreadId, updatedAt: now().toISOString() };
        writeFile(options.file, state);
      });
    },
    async invalidate(sessionKey: string): Promise<void> {
      if (!validKey(sessionKey)) return;
      await mutate(() => {
        const state = readFile(options.file);
        if (state.records[sessionKey] === undefined) return;
        delete state.records[sessionKey];
        writeFile(options.file, state);
      });
    },
  };
}

/**
 * Select persistence only where the rest of the LLM runtime has durable,
 * secret-backed server storage. A process-local map keeps demo and serverless
 * behavior unchanged.
 */
export function createConfiguredSessionStore(env: PersistEnv = process.env): LlmSessionStore {
  const location = persistLocation(env);
  const store = location === null ? createInMemorySessionStore() : createDurableSessionStore({ file: join(location.dir, SESSION_STORE_FILE_NAME) });
  return createCodexThreadSessionStore(store);
}
