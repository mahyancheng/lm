/**
 * The credential wire contract, from the browser's side.
 *
 * No network and no model: `fetch` is stubbed, so what is under test is how
 * this module reads an answer, not whether a server gives one.
 *
 * What must never regress:
 *
 * 1. **A refusal and an absent server are different answers.** The settings
 *    sheet renders a form for one and a single quiet line for the other, so
 *    collapsing them would put a paste field into the static artifact build.
 * 2. **A connection test classifies its own failure**, because "regenerate the
 *    token" and "leave the token alone" are opposite instructions.
 * 3. The credential travels out and never back.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type TokenStatus,
  type TokenStatusFull,
  type TokenStatusPublic,
  classifyCredential,
  classifyTestFailure,
  connectToken,
  disconnectToken,
  fetchTokenStatus,
  isFullStatus,
  maskCredential,
  testToken,
} from './token';

const STATUS: TokenStatusFull = {
  configured: true,
  available: true,
  source: 'runtime',
  transportKind: 'claude-session',
  model: 'sonnet',
  masked: '…wxyz',
  kind: 'oauth',
  setAt: '2027-01-01T00:00:00.000Z',
  authGate: 'open-local',
};

/** A `fetch` that answers once with this status and body, and records the call. */
function stubFetch(status: number, body: unknown): { calls: { url: string; init: RequestInit }[] } {
  const calls: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal('window', globalThis);
  vi.stubGlobal('fetch', (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(body),
    } as Response);
  });
  return { calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

/* -------------------------------------------------------------------------- */

describe('fetching the status', () => {
  it('returns the descriptor a server sent', async () => {
    stubFetch(200, STATUS);
    await expect(fetchTokenStatus()).resolves.toEqual({ kind: 'ok', value: STATUS });
  });

  it('reads a refusal as a refusal, with the reason', async () => {
    for (const status of [400, 401, 403, 429]) {
      stubFetch(status, { reason: 'admin_only' });
      await expect(fetchTokenStatus()).resolves.toEqual({ kind: 'refused', status, reason: 'admin_only' });
    }
  });

  it('reads a server error as unreachable rather than as a refusal', async () => {
    stubFetch(500, {});
    await expect(fetchTokenStatus()).resolves.toEqual({ kind: 'unreachable' });
  });

  it('reads a thrown fetch as unreachable — the static build has no backend at all', async () => {
    vi.stubGlobal('window', globalThis);
    vi.stubGlobal('fetch', () => Promise.reject(new Error('Failed to fetch')));
    await expect(fetchTokenStatus()).resolves.toEqual({ kind: 'unreachable' });
  });

  it('is unreachable on the server, where there is no browser to fetch from', async () => {
    vi.stubGlobal('window', undefined);
    await expect(fetchTokenStatus()).resolves.toEqual({ kind: 'unreachable' });
  });
});

describe('mutations', () => {
  it('sends the credential once, in the body, and gets back only a mask', async () => {
    const secret = 'sk-ant-oat01-SECRETSECRETSECRET-tail';
    const { calls } = stubFetch(200, { ok: true, source: 'runtime', transportKind: 'claude-session', masked: '…tail', kind: 'oauth' });
    const result = await connectToken(secret);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('/api/llm/token');
    expect(calls[0]?.init.method).toBe('POST');
    expect(calls[0]?.init.body).toBe(JSON.stringify({ token: secret }));
    expect(JSON.stringify(result)).not.toContain('SECRET');
  });

  it('clears with DELETE and no body', async () => {
    const { calls } = stubFetch(200, { ok: true, source: 'env', transportKind: 'claude-session', masked: '…envv', kind: 'oauth' });
    await disconnectToken();
    expect(calls[0]?.init.method).toBe('DELETE');
    expect(calls[0]?.init.body).toBeUndefined();
  });

  it('tests against the dedicated route, never the mutation one', async () => {
    const { calls } = stubFetch(200, { ok: true, modelId: 'sonnet', latencyMs: 800 });
    await testToken();
    expect(calls[0]?.url).toBe('/api/llm/token/test');
    expect(calls[0]?.init.method).toBe('POST');
  });

  it('declares JSON on every write, including the one with nothing to say', async () => {
    // The route refuses a body-carrying POST that does not declare JSON,
    // because a cross-site form can send everything *but* JSON without a
    // preflight. The connection test spends real money, so it is gated the same
    // way — which is why it carries a content type it has no need of.
    const { calls } = stubFetch(200, { ok: true, modelId: 'sonnet', latencyMs: 800 });
    await testToken();
    await connectToken('sk-ant-oat01-aaaaaaaaaaaaaaaaaaaaaaaa');
    for (const call of calls) {
      expect((call.init.headers as Record<string, string>)['content-type']).toBe('application/json');
    }
  });
});

describe('the two shapes of a status', () => {
  it('reads a descriptor when the server disclosed one', () => {
    expect(isFullStatus(STATUS)).toBe(true);
  });

  it('reads the reduced answer as reduced, even though it is a valid status', () => {
    // `source` is the discriminator rather than `masked` or `kind`, which are
    // null in a perfectly ordinary full answer — collapsing "unconfigured" into
    // "undisclosed" would send the settings sheet to the wrong phase.
    const reduced: TokenStatusPublic = { configured: true, available: true, transportKind: 'claude-session', authGate: 'admin' };
    expect(isFullStatus(reduced)).toBe(false);
    const unconfigured: TokenStatus = { ...STATUS, configured: false, source: 'none', masked: null, kind: null, setAt: null };
    expect(isFullStatus(unconfigured)).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */

describe('classifying a test failure', () => {
  it('calls a clean answer a success', () => {
    expect(classifyTestFailure(null)).toBeNull();
  });

  it('calls an unparseable answer a success, because something answered', () => {
    // The credential reached a model. Reporting this as a bad token would send
    // an operator to regenerate one that works.
    expect(classifyTestFailure('invalid_output')).toBeNull();
  });

  it('maps a disabled transport to a bad token', () => {
    expect(classifyTestFailure('disabled')).toBe('bad_token');
  });

  it('keeps a rate limit distinct from a bad token', () => {
    expect(classifyTestFailure('rate_limited')).toBe('rate_limited');
  });

  it('treats a timeout and an api error as the network', () => {
    expect(classifyTestFailure('timeout')).toBe('network');
    expect(classifyTestFailure('api_error')).toBe('network');
  });
});

describe('classification and masking, from the browser side', () => {
  it('agrees with the server about what an OAuth token is', () => {
    expect(classifyCredential('sk-ant-oat01-aaaaaaaaaaaaaaaaaaaaaa')).toBe('oauth');
    expect(classifyCredential('sk-ant-api03-aaaaaaaaaaaaaaaaaaaaaa')).toBe('api_key');
  });

  it('masks to four characters here too, so no path renders more', () => {
    expect(maskCredential('sk-ant-oat01-aaaaaaaaaaaaaaaaaawxyz')).toBe('…wxyz');
  });
});
