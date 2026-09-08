/**
 * Gateway tests: transport selection from `LLM_TRANSPORT`, and the wiring of
 * the session store into the default transport.
 *
 * The `api` transport is constructed but never called against a real key.
 */

import { describe, expect, it } from 'vitest';
import { LLM_GATEWAY_VERSION, createGateway, resolveTransportKind } from '../src/index';
import { createInMemorySessionStore } from '../src/sessionStore';
import { createMemoryRunSink } from '../src/runSink';
import { SESSION_ID, narratorInput, stubQuery, VALID_NARRATION } from './fixtures';
import type { CodexAppServerProcess } from '../src/transport/codexProtocol';

function codexProcess(reply: unknown): CodexAppServerProcess {
  const queue: string[] = []; let wake: (() => void) | undefined;
  const push = (value: unknown) => { queue.push(`${JSON.stringify(value)}\n`); wake?.(); wake = undefined; };
  return { kill() {}, exited: new Promise(() => undefined), write(line) {
    const message = JSON.parse(line) as { id?: number; method?: string; params?: Record<string, unknown> };
    if (message.id === undefined) return;
    if (message.method === 'initialize') push({ id: message.id, result: {} });
    if (message.method === 'thread/start') push({ id: message.id, result: { model: 'test-codex', thread: { id: 'thread-1' } } });
    if (message.method === 'turn/start') { const threadId = message.params?.['threadId']; push({ id: message.id, result: { turn: { id: 'turn-1' } } }); queueMicrotask(() => {
      push({ method: 'item/completed', params: { threadId, turnId: 'turn-1', item: { type: 'agentMessage', text: JSON.stringify(reply) } } });
      push({ method: 'turn/completed', params: { threadId, turnId: 'turn-1', turn: { id: 'turn-1', status: 'completed' } } });
    }); }
  }, stdout: { async *[Symbol.asyncIterator]() { while (true) { if (queue.length === 0) await new Promise<void>((resolve) => { wake = resolve; }); const line = queue.shift(); if (line) yield line; } } } };
}

describe('transport selection', () => {
  it('defaults to Codex and migrates the legacy Claude spelling', () => {
    expect(resolveTransportKind(undefined)).toBe('codex-app-server');
    expect(resolveTransportKind('')).toBe('codex-app-server');
    expect(resolveTransportKind('claude-session')).toBe('codex-app-server');
    expect(resolveTransportKind('something-else')).toBe('codex-app-server');
    expect(createGateway({}, { codexSpawn: () => codexProcess({}) }).transportKind).toBe('codex-app-server');
    expect(createGateway({ LLM_TRANSPORT: 'claude-session' }, { codexSpawn: () => codexProcess({}) }).transport.kind).toBe('codex-app-server');
  });

  it('selects the api transport', () => {
    expect(resolveTransportKind('api')).toBe('api');
    expect(resolveTransportKind(' API ')).toBe('api');
    const gateway = createGateway({ LLM_TRANSPORT: 'api', ANTHROPIC_API_KEY: 'not-a-real-key', ANTHROPIC_MODEL: 'claude-sonnet-5' });
    expect(gateway.transportKind).toBe('api');
    expect(gateway.transport.kind).toBe('api');
  });

  it('selects the null transport, which needs no credentials at all', () => {
    expect(resolveTransportKind('none')).toBe('none');
    expect(resolveTransportKind('disabled')).toBe('none');
    const gateway = createGateway({ LLM_TRANSPORT: 'none' });
    expect(gateway.transportKind).toBe('none');
    expect(gateway.transport.kind).toBe('none');
  });
});

describe('gateway wiring', () => {
  it('runs a full role call through the default Codex transport with an injected subprocess', async () => {
    const store = createInMemorySessionStore();
    const sink = createMemoryRunSink();
    const gateway = createGateway(
      {},
      { sessionStore: store, runSink: sink, codexSpawn: () => codexProcess(VALID_NARRATION), roles: { sessionId: SESSION_ID, quarter: 1 } },
    );

    const result = await gateway.roles.narrator.narrate(narratorInput());

    expect(result.output?.headline).toBe(VALID_NARRATION.headline);
    expect(result.fallbackUsed).toBe(false);
    expect(sink.runs).toHaveLength(1);
    // A strategic call never records a session.
    expect(store.size).toBe(0);
  });

  it('shares one transport and session store across every role set it creates', async () => {
    const store = createInMemorySessionStore();
    const gateway = createGateway({ LLM_TRANSPORT: 'none' }, { sessionStore: store });
    const roles = gateway.createRoles({ sessionId: 'another-session', quarter: 4 });
    const result = await roles.narrator.narrate(narratorInput());
    expect(result.fallbackUsed).toBe(true);
    expect(gateway.sessionStore).toBe(store);
  });

  it('supplies a working default session store and role binding when none is given', async () => {
    const gateway = createGateway({ LLM_TRANSPORT: 'none' });
    expect(await gateway.sessionStore.get('anything')).toBeNull();
    const result = await gateway.roles.narrator.narrate(narratorInput());
    expect(result.run.sessionId).toBe(narratorInput().sessionId);
  });

  it('exports a version', () => {
    expect(LLM_GATEWAY_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
