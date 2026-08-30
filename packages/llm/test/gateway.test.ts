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

describe('transport selection', () => {
  it('defaults to claude-session, including for an unknown value', () => {
    expect(resolveTransportKind(undefined)).toBe('claude-session');
    expect(resolveTransportKind('')).toBe('claude-session');
    expect(resolveTransportKind('claude-session')).toBe('claude-session');
    expect(resolveTransportKind('something-else')).toBe('claude-session');
    expect(createGateway({}).transportKind).toBe('claude-session');
    expect(createGateway({ LLM_TRANSPORT: 'claude-session' }).transport.kind).toBe('claude-session');
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
  it('runs a full role call through the default transport with an injected query()', async () => {
    const store = createInMemorySessionStore();
    const sink = createMemoryRunSink();
    const stub = stubQuery([{ text: JSON.stringify(VALID_NARRATION), sessionId: 'sess-1', model: 'claude-sonnet-5' }]);

    const gateway = createGateway(
      { LLM_TRANSPORT: 'claude-session', LLM_MODEL: 'sonnet', CLAUDE_CODE_OAUTH_TOKEN: 'oauth-token' },
      { sessionStore: store, runSink: sink, queryFn: stub.fn, roles: { sessionId: SESSION_ID, quarter: 1 } },
    );

    const result = await gateway.roles.narrator.narrate(narratorInput());

    expect(result.output?.headline).toBe(VALID_NARRATION.headline);
    expect(result.fallbackUsed).toBe(false);
    expect(sink.runs).toHaveLength(1);
    expect(stub.calls[0]?.options?.env?.['CLAUDE_CODE_OAUTH_TOKEN']).toBe('oauth-token');
    expect(stub.calls[0]?.options?.settingSources).toEqual([]);
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
