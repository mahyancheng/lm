/**
 * The runtime Claude credential.
 *
 * Nothing here touches a model, a request scope or a clock: the store is a
 * module-level value and every input to it is a parameter.
 *
 * What must never regress:
 *
 * 1. **Precedence.** The environment is the baseline, a pasted token overrides
 *    it, and clearing the paste falls back — never to nothing, and never to a
 *    half-applied mixture of the two.
 * 2. **The generation counter.** A credential change invalidates the cached
 *    gateway. A gateway built before a paste holds the old credential, so a
 *    cache that survives one is a silently broken Connect button.
 * 3. **Masking.** At most four characters of a secret ever leave this module,
 *    by any path, for any credential.
 * 4. **Authority.** The four rows of the matrix, in both postures.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  TOKEN_WRITE_RATE_LIMIT,
  authorizeTokenWrite,
  buildTokenStatus,
  clearRuntimeCredential,
  createGenerationCache,
  credentialStatus,
  resetRuntimeCredential,
  resolveLlmEnv,
  runtimeCredentialDescriptor,
  runtimeGeneration,
  setRuntimeCredential,
} from './_runtime';
import { TOKEN_MASK_TAIL, classifyCredential, maskCredential, tokenDraftIssue } from '../../../lib/llm/token';
import { type Principal, createRateLimiter } from './_identity';

const OAUTH = 'sk-ant-oat01-ABCDEFGHIJKLMNOPQRSTUVWXYZ-0123456789-wxyz';
const API_KEY = 'sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ-0123456789-4321';
/** A token with no recognisable prefix at all: still an OAuth token by default. */
const OPAQUE = 'abcdefghijklmnopqrstuvwxyz0123456789-TAIL';

const ENV_OAUTH = { LLM_TRANSPORT: 'claude-session', CLAUDE_CODE_OAUTH_TOKEN: 'env-token-0000000000-envv', LLM_MODEL: 'sonnet' } as const;

const at = (): string => '2027-01-01T00:00:00.000Z';

beforeEach(() => {
  resetRuntimeCredential();
});

/* -------------------------------------------------------------------------- */

describe('classification', () => {
  it('reads an sk-ant- prefix as a metered API key', () => {
    expect(classifyCredential(API_KEY)).toBe('api_key');
    expect(classifyCredential(`  ${API_KEY}  `)).toBe('api_key');
  });

  it('treats an sk-ant-oat OAuth token as OAuth, not as an API key', () => {
    // The defect this closes: `claude setup-token` output also begins `sk-ant-`,
    // so a naive prefix check on the whole family would route every
    // subscription token to the metered transport and demand an API key.
    expect(classifyCredential(OAUTH)).toBe('oauth');
  });

  it('treats anything else as a subscription OAuth token', () => {
    expect(classifyCredential(OPAQUE)).toBe('oauth');
  });
});

describe('masking', () => {
  const secrets = [OAUTH, API_KEY, OPAQUE, 'x'.repeat(4096)];

  it('never discloses more than the last four characters', () => {
    for (const secret of secrets) {
      const masked = maskCredential(secret);
      expect(masked).toBe(`…${secret.slice(-TOKEN_MASK_TAIL)}`);
      expect(masked.length).toBe(TOKEN_MASK_TAIL + 1);
      // The strongest form of the claim: no window of the secret longer than
      // the tail appears anywhere in the rendering.
      for (let start = 0; start + TOKEN_MASK_TAIL + 1 <= secret.length; start += 1) {
        expect(masked).not.toContain(secret.slice(start, start + TOKEN_MASK_TAIL + 1));
      }
    }
  });

  it('is the only rendering the descriptor carries', () => {
    const descriptor = setRuntimeCredential(OAUTH, { now: at });
    expect(JSON.stringify(descriptor)).not.toContain(OAUTH.slice(0, 20));
    expect(descriptor.masked).toBe(`…${OAUTH.slice(-4)}`);
    expect(descriptor.kind).toBe('oauth');
    expect(descriptor.setAt).toBe(at());
  });

  it('trims the paste before it is stored, so a trailing newline is not part of the secret', () => {
    setRuntimeCredential(`${OAUTH}\n`, { now: at });
    expect(runtimeCredentialDescriptor()?.masked).toBe(`…${OAUTH.slice(-4)}`);
    expect(resolveLlmEnv({})['CLAUDE_CODE_OAUTH_TOKEN']).toBe(OAUTH);
  });
});

describe('precedence', () => {
  it('leaves the environment untouched when nothing has been pasted', () => {
    expect(resolveLlmEnv(ENV_OAUTH)).toEqual(ENV_OAUTH);
  });

  it('overrides the environment credential and its transport', () => {
    setRuntimeCredential(API_KEY, { now: at });
    const resolved = resolveLlmEnv(ENV_OAUTH);
    expect(resolved['LLM_TRANSPORT']).toBe('api');
    expect(resolved['ANTHROPIC_API_KEY']).toBe(API_KEY);
    // Unrelated variables survive: the overlay is a credential, not a reset.
    expect(resolved['LLM_MODEL']).toBe('sonnet');
  });

  it('turns a disabled deployment back on, because pasting a token says so', () => {
    setRuntimeCredential(OAUTH, { now: at });
    const resolved = resolveLlmEnv({ LLM_TRANSPORT: 'none' });
    expect(resolved['LLM_TRANSPORT']).toBe('claude-session');
    expect(resolved['CLAUDE_CODE_OAUTH_TOKEN']).toBe(OAUTH);
  });

  it('falls back to the environment baseline when the paste is cleared', () => {
    setRuntimeCredential(API_KEY, { now: at });
    expect(clearRuntimeCredential()).toBe(true);
    expect(resolveLlmEnv(ENV_OAUTH)).toEqual(ENV_OAUTH);
    expect(runtimeCredentialDescriptor()).toBeNull();
  });

  it('falls back to nothing when there was no baseline', () => {
    setRuntimeCredential(OAUTH, { now: at });
    clearRuntimeCredential();
    expect(resolveLlmEnv({})).toEqual({});
  });

  it('reports clearing an empty store honestly', () => {
    expect(clearRuntimeCredential()).toBe(false);
  });
});

describe('credentialStatus', () => {
  it('says none when nothing is configured anywhere', () => {
    expect(credentialStatus({}, 'claude-session')).toEqual({
      configured: false,
      source: 'none',
      kind: null,
      masked: null,
      setAt: null,
    });
  });

  it('reports the environment baseline, masked', () => {
    const status = credentialStatus(ENV_OAUTH, 'claude-session');
    expect(status).toMatchObject({ configured: true, source: 'env', kind: 'oauth', setAt: null });
    expect(status.masked).toBe('…envv');
  });

  it('ignores a key the configured transport would not use', () => {
    // An ANTHROPIC_API_KEY left in a dotfile is not the live credential while
    // the process is running on claude-session, and saying it is would send an
    // operator to rotate the wrong secret.
    expect(credentialStatus({ ANTHROPIC_API_KEY: API_KEY }, 'claude-session').source).toBe('none');
    expect(credentialStatus({ ANTHROPIC_API_KEY: API_KEY }, 'api').source).toBe('env');
  });

  it('reports nothing configured on a disabled transport', () => {
    expect(credentialStatus(ENV_OAUTH, 'none').configured).toBe(false);
  });

  it('prefers the pasted credential over the environment', () => {
    setRuntimeCredential(OPAQUE, { now: at });
    const status = credentialStatus(ENV_OAUTH, 'claude-session');
    expect(status).toMatchObject({ configured: true, source: 'runtime', kind: 'oauth', setAt: at() });
    expect(status.masked).toBe('…TAIL');
  });
});

describe('the GET body', () => {
  const facts = {
    base: ENV_OAUTH as Record<string, string | undefined>,
    transport: 'claude-session' as const,
    model: 'sonnet',
    available: true,
    supabaseConfigured: false,
  };

  it('never carries the credential, from any source', () => {
    // Once for the environment baseline, once for a pasted token: the whole
    // serialised body must be free of both secrets, not merely missing a field
    // somebody remembered to omit.
    for (const secret of [ENV_OAUTH.CLAUDE_CODE_OAUTH_TOKEN, API_KEY, OAUTH, OPAQUE]) {
      resetRuntimeCredential();
      if (secret !== ENV_OAUTH.CLAUDE_CODE_OAUTH_TOKEN) setRuntimeCredential(secret, { now: at });
      const wire = JSON.stringify(buildTokenStatus(facts));
      expect(wire).not.toContain(secret);
      // Not even a long window of it.
      for (let start = 0; start + 8 <= secret.length; start += 1) {
        expect(wire).not.toContain(secret.slice(start, start + 8));
      }
    }
  });

  it('reports the gate the deployment is actually in', () => {
    expect(buildTokenStatus(facts).authGate).toBe('open-local');
    expect(buildTokenStatus({ ...facts, supabaseConfigured: true }).authGate).toBe('admin');
  });

  it('separates "a credential is configured" from "a model is reachable"', () => {
    // A machine logged into Claude Code: available, with nothing to mask.
    const ambient = buildTokenStatus({ ...facts, base: { LLM_TRANSPORT: 'claude-session' } });
    expect(ambient.available).toBe(true);
    expect(ambient.configured).toBe(false);
    expect(ambient.masked).toBeNull();
  });

  it('names the source and the kind a pasted token selected', () => {
    setRuntimeCredential(API_KEY, { now: at });
    const body = buildTokenStatus({ ...facts, transport: 'api', model: 'claude-sonnet-5' });
    expect(body).toMatchObject({ configured: true, source: 'runtime', kind: 'api_key', transportKind: 'api', setAt: at() });
    expect(body.masked).toBe(`…${API_KEY.slice(-4)}`);
  });
});

describe('the generation counter', () => {
  it('moves on every mutation and never backwards', () => {
    const seen = [runtimeGeneration()];
    setRuntimeCredential(OAUTH, { now: at });
    seen.push(runtimeGeneration());
    setRuntimeCredential(API_KEY, { now: at });
    seen.push(runtimeGeneration());
    clearRuntimeCredential();
    seen.push(runtimeGeneration());
    resetRuntimeCredential();
    seen.push(runtimeGeneration());

    for (let i = 1; i < seen.length; i += 1) expect(seen[i]).toBeGreaterThan(seen[i - 1] as number);
  });

  it('does not move when nothing is asked of it', () => {
    const before = runtimeGeneration();
    resolveLlmEnv(ENV_OAUTH);
    credentialStatus(ENV_OAUTH, 'claude-session');
    runtimeCredentialDescriptor();
    expect(runtimeGeneration()).toBe(before);
  });

  it('rebuilds a cached value exactly once per credential change', () => {
    let builds = 0;
    const cache = createGenerationCache(() => {
      builds += 1;
      return { credential: resolveLlmEnv({})['CLAUDE_CODE_OAUTH_TOKEN'] ?? null };
    });

    const first = cache();
    expect(builds).toBe(1);
    // Repeated reads reuse the value; building a gateway per request would
    // start a session store per request.
    expect(cache()).toBe(first);
    expect(builds).toBe(1);

    setRuntimeCredential(OAUTH, { now: at });
    const second = cache();
    expect(builds).toBe(2);
    expect(second).not.toBe(first);
    expect(second.credential).toBe(OAUTH);

    clearRuntimeCredential();
    expect(cache().credential).toBeNull();
    expect(builds).toBe(3);
  });
});

/* -------------------------------------------------------------------------- */

describe('authority', () => {
  const admin: Principal = { id: 'user-admin', kind: 'supabase' };
  const player: Principal = { id: 'user-player', kind: 'supabase' };
  const browser: Principal = { id: '11111111-1111-4111-8111-111111111111', kind: 'anonymous' };

  it('lets a verified admin write when Supabase is configured', () => {
    expect(authorizeTokenWrite({ supabaseConfigured: true, principal: admin, isAdmin: true })).toEqual({ ok: true, gate: 'admin' });
  });

  it('refuses a signed-in non-admin with 403, not with a fallback', () => {
    expect(authorizeTokenWrite({ supabaseConfigured: true, principal: player, isAdmin: false })).toEqual({
      ok: false,
      status: 403,
      reason: 'admin_only',
    });
  });

  it('refuses an unverifiable admin flag — no service client is not a grant', () => {
    expect(authorizeTokenWrite({ supabaseConfigured: true, principal: admin, isAdmin: false }).ok).toBe(false);
  });

  it('never accepts a cookie as an identity on a deployment that has real ones', () => {
    expect(authorizeTokenWrite({ supabaseConfigured: true, principal: browser, isAdmin: true })).toEqual({
      ok: false,
      status: 401,
      reason: 'unauthenticated',
    });
  });

  it('lets the browser principal write in demo mode, where there is nobody to be an admin', () => {
    expect(authorizeTokenWrite({ supabaseConfigured: false, principal: browser, isAdmin: false })).toEqual({
      ok: true,
      gate: 'open-local',
    });
  });

  it('refuses a caller with no principal at all, in either posture', () => {
    for (const supabaseConfigured of [true, false]) {
      expect(authorizeTokenWrite({ supabaseConfigured, principal: null, isAdmin: false })).toEqual({
        ok: false,
        status: 401,
        reason: 'unauthenticated',
      });
    }
  });
});

describe('the write budget', () => {
  it('is far stricter than the role window', () => {
    expect(TOKEN_WRITE_RATE_LIMIT).toBe(5);
  });

  it('stops the sixth write in a minute and releases it afterwards', () => {
    const limiter = createRateLimiter({ limit: TOKEN_WRITE_RATE_LIMIT });
    const start = 1_800_000_000_000;
    for (let i = 0; i < TOKEN_WRITE_RATE_LIMIT; i += 1) {
      expect(limiter.take('principal', start + i).allowed).toBe(true);
    }
    const refused = limiter.take('principal', start + TOKEN_WRITE_RATE_LIMIT);
    expect(refused.allowed).toBe(false);
    expect(refused.retryAfterSeconds).toBeGreaterThan(0);

    // A different principal is unaffected, and the window slides.
    expect(limiter.take('other', start + TOKEN_WRITE_RATE_LIMIT).allowed).toBe(true);
    expect(limiter.take('principal', start + 60_001).allowed).toBe(true);
  });
});

describe('the paste field bounds', () => {
  it('accepts a real credential and names what is wrong with anything else', () => {
    expect(tokenDraftIssue(OAUTH)).toBeNull();
    expect(tokenDraftIssue('')).toBeNull();
    expect(tokenDraftIssue('too-short')).toMatch(/too short/i);
    expect(tokenDraftIssue('x'.repeat(5000))).toMatch(/longer/i);
    expect(tokenDraftIssue(`${OAUTH.slice(0, 20)} ${OAUTH.slice(20)}`)).toMatch(/spaces/i);
  });
});
