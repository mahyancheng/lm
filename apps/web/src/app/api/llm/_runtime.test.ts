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
 * 4. **Authority.** Every row of the matrix, in all three postures — including
 *    the ones added after a review found that a cross-site page could set the
 *    credential, that a cookieless caller was handed a fresh rate-limit bucket
 *    per request, and that "no Supabase" was being read as "the caller is
 *    sitting at this machine".
 * 5. **Survival.** The store outlives its own module, because under `next dev`
 *    the module does not outlive the process.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RUNTIME_STORE_KEY,
  TOKEN_WRITE_RATE_LIMIT,
  type TokenIntent,
  authorizeTokenWrite,
  buildTokenStatus,
  checkWriteRequest,
  clearRuntimeCredential,
  createGenerationCache,
  credentialStatus,
  isLocalConnection,
  processSingleton,
  publicTokenStatus,
  resetRuntimeCredential,
  resolveLlmEnv,
  runtimeCredentialDescriptor,
  runtimeGeneration,
  setRuntimeCredential,
  tokenAuthGate,
  tokenWriteBudgetKey,
  tokenWriteOriginKey,
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
    localConnection: true,
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
    // Not local and no accounts: nobody may write it, and the body says so
    // rather than offering a form the server will refuse.
    expect(buildTokenStatus({ ...facts, localConnection: false }).authGate).toBe('disabled');
    // Supabase decides its own posture; where the request came from is not a
    // way to escape the admin check, in either direction.
    expect(buildTokenStatus({ ...facts, supabaseConfigured: true, localConnection: false }).authGate).toBe('admin');
  });

  it('tells an unauthorised reader four public facts and nothing about the secret', () => {
    setRuntimeCredential(OAUTH, { now: at });
    const full = buildTokenStatus(facts);
    const reduced = publicTokenStatus(full);

    expect(reduced).toEqual({
      configured: true,
      available: true,
      transportKind: 'claude-session',
      authGate: 'open-local',
    });
    // The four that survive are the ones the caller can observe anyway; the
    // five that do not are the ones that describe a credential they may not
    // change — including the environment's.
    for (const withheld of ['source', 'model', 'masked', 'kind', 'setAt']) {
      expect(Object.keys(reduced)).not.toContain(withheld);
    }
    expect(JSON.stringify(reduced)).not.toContain('wxyz');
  });

  it('withholds the environment credential from an unauthorised reader too', () => {
    // The defect: `masked` and `setAt` describe whichever credential is in
    // force, so returning them to every admitted caller told each signed-in
    // player the last four characters of the operator's env token.
    const reduced = publicTokenStatus(buildTokenStatus({ ...facts, supabaseConfigured: true }));
    expect(JSON.stringify(reduced)).not.toContain('envv');
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

  /** An established local browser writing: the ordinary demo-mode caller. */
  const write = (overrides: Partial<Parameters<typeof authorizeTokenWrite>[0]> = {}): ReturnType<typeof authorizeTokenWrite> =>
    authorizeTokenWrite({
      supabaseConfigured: false,
      principal: browser,
      isAdmin: false,
      mintedPrincipal: false,
      localConnection: true,
      intent: 'write',
      ...overrides,
    });

  it('lets a verified admin write when Supabase is configured', () => {
    expect(write({ supabaseConfigured: true, principal: admin, isAdmin: true })).toEqual({ ok: true, gate: 'admin' });
  });

  it('refuses a signed-in non-admin with 403, not with a fallback', () => {
    expect(write({ supabaseConfigured: true, principal: player })).toEqual({ ok: false, status: 403, reason: 'admin_only' });
  });

  it('refuses an unverifiable admin flag — no service client is not a grant', () => {
    expect(write({ supabaseConfigured: true, principal: admin }).ok).toBe(false);
  });

  it('never accepts a cookie as an identity on a deployment that has real ones', () => {
    expect(write({ supabaseConfigured: true, isAdmin: true })).toEqual({ ok: false, status: 401, reason: 'unauthenticated' });
  });

  it('lets the browser principal write in demo mode, where there is nobody to be an admin', () => {
    expect(write()).toEqual({ ok: true, gate: 'open-local' });
  });

  it('refuses a caller with no principal at all, in either posture', () => {
    for (const supabaseConfigured of [true, false]) {
      expect(write({ supabaseConfigured, principal: null })).toEqual({ ok: false, status: 401, reason: 'unauthenticated' });
    }
  });

  it('refuses a write from a caller who presented no cookie, and mints nothing for it', () => {
    // The hole this closes: SameSite=Lax kept the cookie off a cross-site POST,
    // and the route answered by minting a principal for the cookieless caller
    // and letting it write — so the cookie's protection was undone by the thing
    // that was meant to identify the caller.
    expect(write({ mintedPrincipal: true })).toEqual({ ok: false, status: 401, reason: 'cookie_required' });
  });

  it('still discloses the descriptor to the browser it has just minted a cookie for', () => {
    // Only GET mints, and the settings sheet's first act is a GET. Withholding
    // there would mean the panel showed nothing on first open and everything on
    // second, while protecting nothing: that browser may write on its next call.
    expect(write({ mintedPrincipal: true, intent: 'read' })).toEqual({ ok: true, gate: 'open-local' });
  });

  it('refuses both read and write when the deployment is not local', () => {
    for (const intent of ['read', 'write'] as TokenIntent[]) {
      expect(write({ localConnection: false, intent })).toEqual({ ok: false, status: 403, reason: 'setup_disabled' });
    }
  });

  it('does not let locality stand in for the admin check, in either direction', () => {
    // A local connection is not an administrator...
    expect(write({ supabaseConfigured: true, principal: player, localConnection: true }).ok).toBe(false);
    // ...and an administrator does not have to be local.
    expect(write({ supabaseConfigured: true, principal: admin, isAdmin: true, localConnection: false })).toEqual({
      ok: true,
      gate: 'admin',
    });
  });

  it('names the same three postures the GET body reports', () => {
    expect(tokenAuthGate(true, false)).toBe('admin');
    expect(tokenAuthGate(false, true)).toBe('open-local');
    expect(tokenAuthGate(false, false)).toBe('disabled');
  });
});

/* -------------------------------------------------------------------------- */

describe('is the caller at this machine', () => {
  const facts = { optIn: undefined, host: 'localhost:3000', forwardedFor: null };

  it('accepts a browser pointed at loopback, in every spelling of it', () => {
    for (const host of ['localhost:3000', '127.0.0.1:3000', '127.9.9.9:3000', '[::1]:3000', 'localhost']) {
      expect(isLocalConnection({ ...facts, host })).toBe(true);
    }
  });

  it('refuses the LAN address the same dev server is also listening on', () => {
    // The finding: `next dev` binds every interface, so anyone on the network
    // could open Settings and overwrite the credential — then spend the
    // owner's subscription through the connection test.
    for (const host of ['192.168.1.10:3000', 'my-laptop.local:3000', 'game.example.com', null]) {
      expect(isLocalConnection({ ...facts, host })).toBe(false);
    }
  });

  it('reads a non-loopback forwarding hop as a connection from elsewhere', () => {
    // Next fills x-forwarded-for from the socket when the client sends none, so
    // a non-loopback hop is evidence even when the Host header says otherwise.
    expect(isLocalConnection({ ...facts, forwardedFor: '203.0.113.7' })).toBe(false);
    expect(isLocalConnection({ ...facts, forwardedFor: '203.0.113.7, 127.0.0.1' })).toBe(false);
    expect(isLocalConnection({ ...facts, forwardedFor: '127.0.0.1' })).toBe(true);
    expect(isLocalConnection({ ...facts, forwardedFor: '::1' })).toBe(true);
  });

  it('lets an operator state the posture instead of having it inferred', () => {
    expect(isLocalConnection({ optIn: 'local', host: '10.0.0.4:3000', forwardedFor: '10.0.0.9' })).toBe(true);
    expect(isLocalConnection({ optIn: ' LOCAL ', host: null, forwardedFor: null })).toBe(true);
    // Any other value is an operator saying no, and that also wins.
    for (const optIn of ['off', 'disabled', 'network', '0']) {
      expect(isLocalConnection({ ...facts, optIn })).toBe(false);
    }
    // An empty variable is not a statement.
    expect(isLocalConnection({ ...facts, optIn: '  ' })).toBe(true);
  });

  it('believes a real connection address over any header, when a platform supplies one', () => {
    expect(isLocalConnection({ ...facts, connectionAddress: '::ffff:127.0.0.1' })).toBe(true);
    expect(isLocalConnection({ ...facts, host: 'localhost:3000', connectionAddress: '192.168.1.22' })).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */

describe('the cross-site gate', () => {
  const sameOrigin = {
    secFetchSite: 'same-origin',
    origin: 'http://localhost:3000',
    host: 'localhost:3000',
    contentType: 'application/json',
    requiresJson: true,
  };

  it('lets this app’s own page through', () => {
    expect(checkWriteRequest(sameOrigin)).toEqual({ ok: true });
    // A charset parameter is still JSON.
    expect(checkWriteRequest({ ...sameOrigin, contentType: 'application/json; charset=utf-8' }).ok).toBe(true);
  });

  it('refuses every cross-site value the browser can report', () => {
    for (const secFetchSite of ['cross-site', 'same-site', 'none']) {
      expect(checkWriteRequest({ ...sameOrigin, secFetchSite })).toEqual({ ok: false, status: 403, reason: 'cross_site' });
    }
  });

  it('falls back to Origin against Host when the browser is too old to say', () => {
    const legacy = { ...sameOrigin, secFetchSite: null };
    expect(checkWriteRequest(legacy).ok).toBe(true);
    expect(checkWriteRequest({ ...legacy, origin: 'https://evil.example' })).toEqual({
      ok: false,
      status: 403,
      reason: 'cross_site',
    });
    // A port is part of an authority: :3001 is not :3000.
    expect(checkWriteRequest({ ...legacy, origin: 'http://localhost:3001' }).ok).toBe(false);
  });

  it('refuses a state-changing request that will say neither', () => {
    // This is the curl-shaped request the review used, and the one an old
    // browser cannot produce: no Sec-Fetch-Site and no Origin at all.
    expect(checkWriteRequest({ ...sameOrigin, secFetchSite: null, origin: null })).toEqual({
      ok: false,
      status: 403,
      reason: 'origin_unverified',
    });
    expect(checkWriteRequest({ ...sameOrigin, secFetchSite: null, origin: 'not a url' }).ok).toBe(false);
    expect(checkWriteRequest({ ...sameOrigin, secFetchSite: null, host: null }).ok).toBe(false);
  });

  it('demands JSON of a body-carrying write, and of nothing else', () => {
    // These three are exactly what a cross-site form can send without a
    // preflight, which is why none of them may write a credential.
    for (const contentType of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data', null]) {
      expect(checkWriteRequest({ ...sameOrigin, contentType })).toEqual({
        ok: false,
        status: 403,
        reason: 'unsupported_media_type',
      });
      // DELETE has no body to type, and the origin rules are what protect it.
      expect(checkWriteRequest({ ...sameOrigin, contentType, requiresJson: false }).ok).toBe(true);
    }
  });

  it('checks the origin before the media type, so a cross-site form is refused as cross-site', () => {
    expect(checkWriteRequest({ ...sameOrigin, secFetchSite: 'cross-site', contentType: 'text/plain' }).ok).toBe(false);
    expect(checkWriteRequest({ ...sameOrigin, secFetchSite: 'cross-site', contentType: 'text/plain' })).toMatchObject({
      reason: 'cross_site',
    });
  });
});

/* -------------------------------------------------------------------------- */

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

  it('cannot be given a fresh bucket by rotating a header', () => {
    // The finding: twelve consecutive writes succeeded against a 5/min limit,
    // because the caller was a new principal every time and, had it not been,
    // could have rotated `x-forwarded-for` to the same effect.
    const rotations = [
      new Headers(),
      new Headers({ 'x-forwarded-for': '203.0.113.1' }),
      new Headers({ 'x-forwarded-for': '203.0.113.2, 10.0.0.1' }),
      new Headers({ 'x-real-ip': '198.51.100.9', 'x-forwarded-for': '198.51.100.9' }),
      new Headers({ host: 'somewhere-else.example', origin: 'https://somewhere-else.example' }),
    ];
    const keys = new Set(rotations.map((headers) => tokenWriteBudgetKey('principal', tokenWriteOriginKey(headers))));
    expect(keys.size).toBe(1);
  });

  it('separates principals, and separates connections when a platform names one', () => {
    const headers = new Headers();
    expect(tokenWriteBudgetKey('a', tokenWriteOriginKey(headers))).not.toBe(tokenWriteBudgetKey('b', tokenWriteOriginKey(headers)));
    expect(tokenWriteOriginKey(headers, '10.0.0.5')).not.toBe(tokenWriteOriginKey(headers, '10.0.0.6'));
    expect(tokenWriteOriginKey(headers, '10.0.0.5')).toBe(tokenWriteOriginKey(new Headers({ 'x-forwarded-for': 'x' }), '10.0.0.5'));
  });

  it('binds a rotating caller once the composite is the key', () => {
    const limiter = createRateLimiter({ limit: TOKEN_WRITE_RATE_LIMIT });
    const start = 1_800_000_000_000;
    let allowed = 0;
    for (let i = 0; i < 12; i += 1) {
      // One established principal, a different forged forwarding header each time.
      const headers = new Headers({ 'x-forwarded-for': `203.0.113.${i}` });
      const key = tokenWriteBudgetKey('11111111-1111-4111-8111-111111111111', tokenWriteOriginKey(headers));
      if (limiter.take(key, start + i).allowed) allowed += 1;
    }
    expect(allowed).toBe(TOKEN_WRITE_RATE_LIMIT);
  });
});

/* -------------------------------------------------------------------------- */

describe('surviving a module reload', () => {
  it('keeps the credential and the counter on a process-wide slot', () => {
    // The failure this closes was silent and exact: paste a token under
    // `next dev`, visit a page whose route had not been compiled yet, and the
    // module registry was rebuilt with a fresh empty store — the credential
    // gone, the interface still saying "set in app".
    setRuntimeCredential(OAUTH, { now: at });
    const generation = runtimeGeneration();

    const slot = (globalThis as unknown as Record<symbol, { credential: unknown; generation: number } | undefined>)[
      Symbol.for(`frontier.${RUNTIME_STORE_KEY}`)
    ];
    expect(slot?.generation).toBe(generation);
    expect(slot?.credential).not.toBeNull();
  });

  it('finds the same store from a freshly evaluated copy of this module', async () => {
    setRuntimeCredential(API_KEY, { now: at });
    const before = runtimeGeneration();

    // The nearest thing a test has to `next dev` recompiling a route: throw the
    // module registry away and evaluate the module again.
    vi.resetModules();
    const reloaded = (await import('./_runtime')) as typeof import('./_runtime');

    expect(reloaded.runtimeCredentialDescriptor()?.masked).toBe(`…${API_KEY.slice(-4)}`);
    expect(reloaded.runtimeGeneration()).toBe(before);
    expect(reloaded.resolveLlmEnv({})['ANTHROPIC_API_KEY']).toBe(API_KEY);

    // And it is one store, not two: a clear through the new copy is visible
    // through the old one, so a gateway cached anywhere is invalidated.
    reloaded.clearRuntimeCredential();
    expect(runtimeCredentialDescriptor()).toBeNull();
    expect(runtimeGeneration()).toBeGreaterThan(before);
  });

  it('hides the slot from anything that walks the global object', () => {
    setRuntimeCredential(OAUTH, { now: at });
    const key = Symbol.for(`frontier.${RUNTIME_STORE_KEY}`);
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);

    expect(descriptor?.enumerable).toBe(false);
    expect(descriptor?.writable).toBe(false);
    expect(descriptor?.configurable).toBe(false);
    // A symbol key is skipped by JSON, and a non-enumerable one by a spread —
    // so no logger, serialiser or crash reporter reaches the secret by walking.
    const spread = { ...(globalThis as object) };
    expect(Object.getOwnPropertySymbols(spread)).not.toContain(key);
    expect(Object.keys(spread).some((name) => name.includes('runtimeCredential'))).toBe(false);
  });

  it('creates a singleton once and hands the same one back', () => {
    let built = 0;
    const build = (): { value: number } => {
      built += 1;
      return { value: built };
    };
    const first = processSingleton('test.singleton', build);
    expect(processSingleton('test.singleton', build)).toBe(first);
    expect(built).toBe(1);
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
