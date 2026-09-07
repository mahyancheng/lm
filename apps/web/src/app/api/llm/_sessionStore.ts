/**
 * Durable mapping from opaque game conversation keys to Claude SDK session ids.
 *
 * This is deliberately a small server-only file store instead of the
 * `conversation_llm_sessions` Supabase table. That table is correctly scoped
 * to a UUID social conversation, while company agents have no such row and
 * their HMAC-derived keys must remain opaque. On the Pi this file lives beside
 * the Agent SDK's persisted transcript directory, so both halves needed for a
 * resume survive an app-server restart.
 */

import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInMemorySessionStore, type LlmSessionStore } from '@frontier/llm';
import { persistLocation, type PersistEnv } from './_persist';

export const SESSION_STORE_FILE_NAME = 'claude-session-map.json';
const FILE_VERSION = 1;
const DEFAULT_TTL_MS = 1000 * 60 * 60 * 24 * 90;
const MAX_KEY_LENGTH = 256;
const MAX_SESSION_ID_LENGTH = 2048;

interface SessionRecord {
  readonly claudeSessionId: string;
  readonly updatedAt: string;
}

interface SessionFile {
  readonly version: number;
  readonly records: Record<string, SessionRecord>;
}

export interface DurableSessionStoreOptions {
  readonly file: string;
  readonly ttlMs?: number;
  readonly now?: () => Date;
}

function validKey(value: string): boolean {
  return value.length > 0 && value.length <= MAX_KEY_LENGTH;
}

function validSessionId(value: string): boolean {
  return value.length > 0 && value.length <= MAX_SESSION_ID_LENGTH;
}

function readFile(file: string): SessionFile {
  try {
    if (!statSync(file).isFile()) return { version: FILE_VERSION, records: {} };
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<SessionFile>;
    if (parsed.version !== FILE_VERSION || parsed.records === null || typeof parsed.records !== 'object') return { version: FILE_VERSION, records: {} };
    const records: Record<string, SessionRecord> = {};
    for (const [key, value] of Object.entries(parsed.records)) {
      if (
        validKey(key) &&
        value !== null &&
        typeof value === 'object' &&
        validSessionId((value as Partial<SessionRecord>).claudeSessionId ?? '') &&
        typeof (value as Partial<SessionRecord>).updatedAt === 'string' &&
        Number.isFinite(Date.parse((value as Partial<SessionRecord>).updatedAt ?? ''))
      ) {
        records[key] = value as SessionRecord;
      }
    }
    return { version: FILE_VERSION, records };
  } catch {
    return { version: FILE_VERSION, records: {} };
  }
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
 * A Pi/VPS-only store. Every backend failure is converted to a cache miss, so
 * a filesystem problem cannot block a quarter or dialogue response.
 */
export function createDurableSessionStore(options: DurableSessionStoreOptions): LlmSessionStore {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const now = options.now ?? (() => new Date());

  return {
    async get(sessionKey: string): Promise<string | null> {
      if (!validKey(sessionKey)) return null;
      try {
        const record = readFile(options.file).records[sessionKey];
        if (record === undefined) return null;
        if (ttlMs >= 0 && now().getTime() - Date.parse(record.updatedAt) > ttlMs) {
          const state = readFile(options.file);
          delete state.records[sessionKey];
          writeFile(options.file, state);
          return null;
        }
        return record.claudeSessionId;
      } catch {
        return null;
      }
    },
    async set(sessionKey: string, claudeSessionId: string): Promise<void> {
      if (!validKey(sessionKey) || !validSessionId(claudeSessionId)) return;
      try {
        const state = readFile(options.file);
        state.records[sessionKey] = { claudeSessionId, updatedAt: now().toISOString() };
        writeFile(options.file, state);
      } catch {
        // Resuming is an enhancement, never a reason to fail a game turn.
      }
    },
    async invalidate(sessionKey: string): Promise<void> {
      if (!validKey(sessionKey)) return;
      try {
        const state = readFile(options.file);
        if (state.records[sessionKey] === undefined) return;
        delete state.records[sessionKey];
        writeFile(options.file, state);
      } catch {
        // Best effort; an unreadable store is already a cache miss.
      }
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
  return location === null ? createInMemorySessionStore() : createDurableSessionStore({ file: join(location.dir, SESSION_STORE_FILE_NAME) });
}
