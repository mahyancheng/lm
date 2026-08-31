/**
 * The subscription-OAuth flow.
 *
 * No socket and no entropy: `fetch` is a stub and the byte source is injected,
 * so what is under test is the *shape* of the request and how each answer is
 * read — the two things that must match the installed CLI exactly or the token
 * never comes back.
 *
 * What must never regress:
 *
 * 1. **PKCE is real.** The challenge is the base64url SHA-256 of the verifier,
 *    the verifier never appears in the authorize URL, and both are unpadded
 *    base64url.
 * 2. **The exchange body is the CLI's body.** Endpoint, method, JSON content
 *    type, and every field — including the manual `redirect_uri`, the public
 *    `client_id` and the `code_verifier`.
 * 3. **Every failure is classified, never thrown.** A dead socket, a rejected
 *    code, an odd status and a 200 with no token are four different answers.
 */

import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  CLAUDE_OAUTH_CONFIG,
  base64Url,
  buildClaudeAuthorizeUrl,
  createOAuthState,
  createPkcePair,
  exchangeClaudeOAuthCode,
  type FetchLike,
} from '../src/oauth';

/** A deterministic byte source: byte i is i mod 256, so a test can predict the encoding. */
const fixedBytes = (size: number): Buffer => Buffer.from(Array.from({ length: size }, (_unused, i) => i % 256));

/* -------------------------------------------------------------------------- */

describe('PKCE', () => {
  it('derives the challenge as the base64url SHA-256 of the verifier', () => {
    const pair = createPkcePair(fixedBytes);
    const expectedVerifier = base64Url(fixedBytes(32));
    expect(pair.verifier).toBe(expectedVerifier);
    expect(pair.challenge).toBe(base64Url(createHash('sha256').update(expectedVerifier).digest()));
  });

  it('produces unpadded base64url, the only alphabet PKCE accepts', () => {
    const pair = createPkcePair(fixedBytes);
    for (const value of [pair.verifier, pair.challenge, createOAuthState(fixedBytes)]) {
      expect(value).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(value).not.toContain('=');
    }
    // 32 bytes → 43 base64url characters.
    expect(pair.verifier).toHaveLength(43);
  });

  it('changes the verifier when the entropy changes', () => {
    const a = createPkcePair((size) => Buffer.alloc(size, 1));
    const b = createPkcePair((size) => Buffer.alloc(size, 2));
    expect(a.verifier).not.toBe(b.verifier);
    expect(a.challenge).not.toBe(b.challenge);
  });
});

/* -------------------------------------------------------------------------- */

describe('the authorize URL', () => {
  const url = new URL(buildClaudeAuthorizeUrl({ challenge: 'CHAL', state: 'STATE' }));

  it('points at the subscription authorize endpoint', () => {
    expect(`${url.origin}${url.pathname}`).toBe(CLAUDE_OAUTH_CONFIG.authorizeUrl);
  });

  it('carries exactly the parameters the CLI sends', () => {
    expect(url.searchParams.get('code')).toBe('true');
    expect(url.searchParams.get('client_id')).toBe(CLAUDE_OAUTH_CONFIG.clientId);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('redirect_uri')).toBe(CLAUDE_OAUTH_CONFIG.redirectUri);
    expect(url.searchParams.get('scope')).toBe('user:inference');
    expect(url.searchParams.get('code_challenge')).toBe('CHAL');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('state')).toBe('STATE');
  });

  it('never leaks the verifier — only the challenge derived from it', () => {
    const pair = createPkcePair(fixedBytes);
    const link = buildClaudeAuthorizeUrl({ challenge: pair.challenge, state: 'S' });
    expect(link).toContain(encodeURIComponent(pair.challenge));
    expect(link).not.toContain(pair.verifier);
  });
});

/* -------------------------------------------------------------------------- */

describe('the token exchange', () => {
  /** A stub that records the one request and answers with a fixed status and body. */
  function stub(status: number, body: string): { fetchImpl: FetchLike; calls: { url: string; init: Parameters<FetchLike>[1] }[] } {
    const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
    const fetchImpl: FetchLike = (url, init) => {
      calls.push({ url, init });
      return Promise.resolve({ status, text: () => Promise.resolve(body) });
    };
    return { fetchImpl, calls };
  }

  it('POSTs the CLI body as JSON to the token endpoint', async () => {
    const { fetchImpl, calls } = stub(200, JSON.stringify({ access_token: 'sk-ant-oat01-XYZ', expires_in: 31_536_000 }));
    const result = await exchangeClaudeOAuthCode({ code: 'THE_CODE', verifier: 'THE_VERIFIER', state: 'THE_STATE', fetchImpl });

    expect(result).toEqual({ ok: true, token: 'sk-ant-oat01-XYZ', expiresIn: 31_536_000 });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(CLAUDE_OAUTH_CONFIG.tokenUrl);
    expect(calls[0]?.init.method).toBe('POST');
    expect(calls[0]?.init.headers['content-type']).toBe('application/json');

    const sent = JSON.parse(calls[0]?.init.body ?? '{}');
    expect(sent).toMatchObject({
      grant_type: 'authorization_code',
      code: 'THE_CODE',
      redirect_uri: CLAUDE_OAUTH_CONFIG.redirectUri,
      client_id: CLAUDE_OAUTH_CONFIG.clientId,
      code_verifier: 'THE_VERIFIER',
      state: 'THE_STATE',
      expires_in: CLAUDE_OAUTH_CONFIG.expiresIn,
    });
  });

  it('trims the returned token and tolerates a missing expiry', async () => {
    const { fetchImpl } = stub(200, JSON.stringify({ access_token: '  sk-ant-oat01-TRIMMED  ' }));
    const result = await exchangeClaudeOAuthCode({ code: 'c', verifier: 'v', state: 's', fetchImpl });
    expect(result).toEqual({ ok: true, token: 'sk-ant-oat01-TRIMMED', expiresIn: null });
  });

  it('reads a 401 as an expired or reused code', async () => {
    const { fetchImpl } = stub(401, '{"error":"invalid_grant"}');
    const result = await exchangeClaudeOAuthCode({ code: 'c', verifier: 'v', state: 's', fetchImpl });
    expect(result).toEqual({ ok: false, error: 'expired_code', detail: expect.stringContaining('401') });
  });

  it('reads any other non-200 as a generic exchange failure', async () => {
    const { fetchImpl } = stub(503, 'upstream down');
    const result = await exchangeClaudeOAuthCode({ code: 'c', verifier: 'v', state: 's', fetchImpl });
    expect(result).toMatchObject({ ok: false, error: 'exchange_failed' });
  });

  it('reads a 200 with no access_token as a bad response, not a success', async () => {
    const { fetchImpl } = stub(200, JSON.stringify({ token_type: 'Bearer' }));
    const result = await exchangeClaudeOAuthCode({ code: 'c', verifier: 'v', state: 's', fetchImpl });
    expect(result).toMatchObject({ ok: false, error: 'bad_response' });
  });

  it('reads a 200 that is not JSON as a bad response', async () => {
    const { fetchImpl } = stub(200, '<html>not json</html>');
    const result = await exchangeClaudeOAuthCode({ code: 'c', verifier: 'v', state: 's', fetchImpl });
    expect(result).toMatchObject({ ok: false, error: 'bad_response' });
  });

  it('turns a thrown fetch into a network answer rather than throwing', async () => {
    const fetchImpl: FetchLike = () => Promise.reject(new Error('ECONNRESET'));
    const result = await exchangeClaudeOAuthCode({ code: 'c', verifier: 'v', state: 's', fetchImpl });
    expect(result).toMatchObject({ ok: false, error: 'network', detail: expect.stringContaining('ECONNRESET') });
  });

  it('falls back to the global fetch when none is injected, and survives its absence', async () => {
    const original = globalThis.fetch;
    try {
      // No global fetch at all: the answer is a clean network failure, never a throw.
      (globalThis as { fetch?: unknown }).fetch = undefined;
      await expect(exchangeClaudeOAuthCode({ code: 'c', verifier: 'v', state: 's' })).resolves.toMatchObject({
        ok: false,
        error: 'network',
      });

      const spy = vi.fn(() => Promise.resolve({ status: 200, text: () => Promise.resolve('{"access_token":"sk-ant-oat01-G"}') }));
      (globalThis as { fetch?: unknown }).fetch = spy;
      await expect(exchangeClaudeOAuthCode({ code: 'c', verifier: 'v', state: 's' })).resolves.toMatchObject({ ok: true });
      expect(spy).toHaveBeenCalledOnce();
    } finally {
      globalThis.fetch = original;
    }
  });
});
