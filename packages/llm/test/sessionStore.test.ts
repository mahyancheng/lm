/**
 * Session store tests.
 *
 * The store is the whole of "conversations are persistent sessions, resumed by
 * id". Its contract is deliberately forgiving — a miss is null, never an error
 * — because losing continuity should degrade a conversation and never fail a
 * quarter.
 */

import { describe, expect, it } from 'vitest';
import { createInMemorySessionStore, createNullSessionStore } from '../src/sessionStore';
import { createClaudeSessionTransport } from '../src/transport/claudeSession';
import { z } from 'zod';
import { stubQuery } from './fixtures';

const TinySchema = z.object({ a: z.number() });

describe('in-memory session store', () => {
  it('returns null for an unknown key rather than throwing', async () => {
    const store = createInMemorySessionStore();
    expect(await store.get('never-seen')).toBeNull();
    expect(store.peek('never-seen')).toBeNull();
    expect(store.size).toBe(0);
  });

  it('is last-write-wins, because a resume can hand back a new id', async () => {
    const store = createInMemorySessionStore();
    await store.set('cos:1', 'session-a');
    await store.set('cos:1', 'session-b');
    expect(await store.get('cos:1')).toBe('session-b');
    expect(store.size).toBe(1);
  });

  it('seeds from a plain object and clears', async () => {
    const store = createInMemorySessionStore({ 'chr:9': 'session-z' });
    expect(await store.get('chr:9')).toBe('session-z');
    expect(store.entries()).toEqual([['chr:9', 'session-z']]);
    store.clear();
    expect(store.size).toBe(0);
  });
});

describe('null session store', () => {
  it('remembers nothing, so every turn opens a fresh session', async () => {
    const store = createNullSessionStore();
    await store.set('cos:1', 'session-a');
    expect(await store.get('cos:1')).toBeNull();
  });
});

describe('store failures never fail a call', () => {
  it('survives a store that throws on read and on write', async () => {
    const broken = {
      async get(): Promise<string | null> {
        throw new Error('supabase unreachable');
      },
      async set(): Promise<void> {
        throw new Error('supabase unreachable');
      },
    };
    const stub = stubQuery([{ text: '{"a":1}', sessionId: 'session-new' }]);
    const transport = createClaudeSessionTransport({ queryFn: stub.fn, sessionStore: broken, env: {} });

    const completion = await transport.complete({
      role: 'chief_of_staff',
      system: 's',
      prompt: 'p',
      schema: TinySchema,
      schemaName: 'TinySchema',
      sessionKey: 'cos:demo',
    });

    expect(completion.output).toEqual({ a: 1 });
    expect(stub.calls[0]?.options?.resume).toBeUndefined();
    expect(completion.claudeSessionId).toBe('session-new');
  });

  it('forgets a rejected resume id so the next turn starts fresh', async () => {
    const store = createInMemorySessionStore({ 'npc:stable': 'session-gone' });
    async function* rejected() {
      throw new Error('resume session not found');
    }
    const transport = createClaudeSessionTransport({ queryFn: rejected, sessionStore: store, env: {} });

    const completion = await transport.complete({
      role: 'npc_strategist', system: 's', prompt: 'p', schema: TinySchema, schemaName: 'TinySchema', sessionKey: 'npc:stable',
    });

    expect(completion.output).toBeNull();
    expect(store.peek('npc:stable')).toBeNull();
  });
});

describe('same-key Claude session serialization', () => {
  it('waits for one turn to record its new SDK id before resuming the next', async () => {
    const values = new Map<string, string>();
    let unlockFirstWrite: (() => void) | undefined;
    const firstWrite = new Promise<void>((resolve) => {
      unlockFirstWrite = resolve;
    });
    let writes = 0;
    const store = {
      async get(key: string): Promise<string | null> {
        return values.get(key) ?? null;
      },
      async set(key: string, value: string): Promise<void> {
        values.set(key, value);
        writes += 1;
        if (writes === 1) await firstWrite;
      },
    };
    const stub = stubQuery([
      { text: '{"a":1}', sessionId: 'sdk-first' },
      { text: '{"a":2}', sessionId: 'sdk-second' },
    ]);
    const transport = createClaudeSessionTransport({ queryFn: stub.fn, sessionStore: store, env: {} });
    const request = (prompt: string) => ({ role: 'npc_strategist' as const, system: 's', prompt, schema: TinySchema, schemaName: 'TinySchema', sessionKey: 'npc:company-seat' });

    const first = transport.complete(request('first'));
    for (let i = 0; i < 4; i += 1) await Promise.resolve();
    const second = transport.complete(request('second'));
    for (let i = 0; i < 4; i += 1) await Promise.resolve();
    expect(stub.calls).toHaveLength(1);

    unlockFirstWrite?.();
    await Promise.all([first, second]);
    expect(stub.calls).toHaveLength(2);
    expect(stub.calls[1]?.options?.resume).toBe('sdk-first');
  });

  it('does not block independent company keys behind a slow write', async () => {
    let unlockWrite: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      unlockWrite = resolve;
    });
    const store = {
      async get(): Promise<string | null> {
        return null;
      },
      async set(): Promise<void> {
        await blocked;
      },
    };
    const stub = stubQuery([
      { text: '{"a":1}', sessionId: 'sdk-a' },
      { text: '{"a":2}', sessionId: 'sdk-b' },
    ]);
    const transport = createClaudeSessionTransport({ queryFn: stub.fn, sessionStore: store, env: {} });
    const request = (key: string) => ({ role: 'npc_strategist' as const, system: 's', prompt: key, schema: TinySchema, schemaName: 'TinySchema', sessionKey: key });

    const a = transport.complete(request('npc:a'));
    const b = transport.complete(request('npc:b'));
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
    expect(stub.calls).toHaveLength(2);
    unlockWrite?.();
    await Promise.all([a, b]);
  });

  it('releases the key after a failed turn so a later turn can start fresh', async () => {
    const store = createInMemorySessionStore({ 'npc:failed': 'sdk-gone' });
    const stub = stubQuery([
      { text: '', sessionId: 'sdk-gone', throws: new Error('resume missing') },
      { text: '{"a":3}', sessionId: 'sdk-fresh' },
    ]);
    const transport = createClaudeSessionTransport({ queryFn: stub.fn, sessionStore: store, env: {} });
    const request = (prompt: string) => ({ role: 'npc_strategist' as const, system: 's', prompt, schema: TinySchema, schemaName: 'TinySchema', sessionKey: 'npc:failed' });

    const [failed, fresh] = await Promise.all([transport.complete(request('first')), transport.complete(request('second'))]);
    expect(failed.output).toBeNull();
    expect(fresh.output).toEqual({ a: 3 });
    expect(stub.calls[1]?.options?.resume).toBeUndefined();
  });
});
