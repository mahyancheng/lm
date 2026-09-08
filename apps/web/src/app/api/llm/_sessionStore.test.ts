import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SESSION_STORE_FILE_NAME, createConfiguredSessionStore, createDurableSessionStore } from './_sessionStore';

const directories: string[] = [];

function directory(): string {
  const value = mkdtempSync(join(tmpdir(), 'frontier-llm-sessions-'));
  directories.push(value);
  return value;
}

afterEach(() => {
  for (const value of directories.splice(0)) rmSync(value, { recursive: true, force: true });
});

describe('durable Claude session store', () => {
  it('does not read a legacy Claude map and namespaces every Codex mapping', async () => {
    const dir = directory();
    writeFileSync(join(dir, 'claude-session-map.json'), JSON.stringify({ version: 1, records: { 'npc:old-game': { claudeSessionId: 'claude-session-id', updatedAt: new Date().toISOString() } } }));
    const store = createConfiguredSessionStore({ LLM_KEY_SECRET: 'test-secret', LLM_STATE_DIR: dir });
    expect(await store.get('npc:old-game')).toBeNull();
    await store.set('npc:new-game', 'thr_new');
    const persisted = JSON.parse(await import('node:fs/promises').then(({ readFile }) => readFile(join(dir, SESSION_STORE_FILE_NAME), 'utf8'))) as { records: Record<string, { codexThreadId: string }> };
    expect(persisted.records['codex:npc:new-game']?.codexThreadId).toBe('thr_new');
  });

  it('preserves concurrent writes from separate store instances and game ids', async () => {
    const file = join(directory(), SESSION_STORE_FILE_NAME);
    const first = createDurableSessionStore({ file });
    const second = createDurableSessionStore({ file });
    await Promise.all([
      first.set('codex:npc:game-one:principal-a', 'thr_one'),
      second.set('codex:npc:game-two:principal-a', 'thr_two'),
    ]);
    const restarted = createDurableSessionStore({ file });
    expect(await restarted.get('codex:npc:game-one:principal-a')).toBe('thr_one');
    expect(await restarted.get('codex:npc:game-two:principal-a')).toBe('thr_two');
  });
  it('survives a server restart and keeps opaque scopes separate', async () => {
    const file = join(directory(), SESSION_STORE_FILE_NAME);
    const first = createDurableSessionStore({ file });
    await first.set('npc:company-a-seat-1', 'sdk-a');
    await first.set('npc:company-a-seat-2', 'sdk-b');

    // A new instance models a Next server restart: only the disk map remains.
    const restarted = createDurableSessionStore({ file });
    expect(await restarted.get('npc:company-a-seat-1')).toBe('sdk-a');
    expect(await restarted.get('npc:company-a-seat-2')).toBe('sdk-b');
    expect(await restarted.get('npc:company-b-seat-1')).toBeNull();
  });

  it('expires stale ids and invalidates a rejected SDK resume id', async () => {
    const file = join(directory(), SESSION_STORE_FILE_NAME);
    let clock = new Date('2026-01-01T00:00:00.000Z');
    const store = createDurableSessionStore({ file, ttlMs: 1000, now: () => clock });
    await store.set('npc:seat-company', 'sdk-old');
    clock = new Date('2026-01-01T00:00:02.000Z');
    expect(await store.get('npc:seat-company')).toBeNull();

    await store.set('npc:seat-company', 'sdk-rejected');
    await store.invalidate?.('npc:seat-company');
    expect(await store.get('npc:seat-company')).toBeNull();
  });

  it('only enables disk persistence with the existing durable-runtime configuration', async () => {
    const dir = directory();
    const enabled = createConfiguredSessionStore({ LLM_KEY_SECRET: 'test-secret', LLM_STATE_DIR: dir });
    await enabled.set('npc:configured', 'sdk-configured');
    expect(await createDurableSessionStore({ file: join(dir, SESSION_STORE_FILE_NAME) }).get('codex:npc:configured')).toBe('sdk-configured');

    const disabled = createConfiguredSessionStore({});
    await disabled.set('npc:only-memory', 'sdk-memory');
    expect(await disabled.get('npc:only-memory')).toBe('sdk-memory');
  });
});
