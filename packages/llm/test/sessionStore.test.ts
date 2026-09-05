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
});
