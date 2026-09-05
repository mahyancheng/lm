/**
 * `admitQuick` spends a separate budget from `admit`.
 *
 * The bug this pins: `/chief-of-staff/quick` never reaches a model — no
 * transport, no concurrency-limiter permit, no subprocess — but it used to be
 * admitted through the same `admit()` as every model route, charging the one
 * shared `RATE_LIMIT_PER_WINDOW` bucket. `useChiefOfStaff.ts` fires the quick
 * and the real call together on every question, so that shared bucket meant
 * every Chief of Staff question spent *two* of its twenty slots on a call that
 * never needed rate-limiting protection at all — halving the real budget and,
 * combined with the strategist prefetch, was enough to 429 the model route
 * during perfectly ordinary play. `admitQuick` now charges a distinct,
 * separate bucket (`RATE_LIMIT_QUICK_PER_WINDOW`), so the two can never starve
 * each other.
 *
 * `next/headers`'s `cookies()` needs a request scope Next only provides inside
 * a real route handler, so it is mocked here — the standard way to unit test a
 * Next route module outside of `next start`. Each principal in this file is a
 * fresh random id: the per-principal rate limiters are process singletons
 * (`processSingleton`, `_runtime.ts`) that persist for the life of the test
 * worker, so a fresh, never-before-seen id is what keeps one test's exhausted
 * budget from bleeding into the next — the same technique a real deployment
 * relies on to keep two browsers apart.
 */

import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

let mockedAnonymousId: string | null = null;

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (name === 'fc_anon_id' && mockedAnonymousId !== null ? { name, value: mockedAnonymousId } : undefined),
    getAll: () => (mockedAnonymousId !== null ? [{ name: 'fc_anon_id', value: mockedAnonymousId }] : []),
    set: () => {
      /* no browser to persist a cookie into; every request below already carries one */
    },
  }),
}));

// Demo mode: no Supabase env configured in the test process, so `admit`/`admitQuick`
// resolve the anonymous principal from the mocked cookie above without ever
// reaching `getRouteClient`.
const { admit, admitQuick } = await import('./_gateway');
const { RATE_LIMIT_PER_WINDOW, RATE_LIMIT_QUICK_PER_WINDOW } = await import('./_identity');

function requestFor(principalId: string): Request {
  mockedAnonymousId = principalId;
  return new Request('http://localhost/api/llm/chief-of-staff', { method: 'POST', headers: { 'content-type': 'application/json' } });
}

beforeEach(() => {
  mockedAnonymousId = null;
});

describe('admitQuick keeps a separate budget from admit', () => {
  it('exhausting the model-call window does not block the quick route for the same principal', async () => {
    const principal = randomUUID();

    for (let i = 0; i < RATE_LIMIT_PER_WINDOW; i += 1) {
      const outcome = await admit(requestFor(principal));
      expect(outcome.ok).toBe(true);
    }
    const exhausted = await admit(requestFor(principal));
    expect(exhausted.ok).toBe(false);
    if (!exhausted.ok) expect(exhausted.response.status).toBe(429);

    // Same principal, same minute: the quick bucket has never been touched.
    const quick = await admitQuick(requestFor(principal));
    expect(quick.ok).toBe(true);
  });

  it('exhausting the quick window does not block the model routes for the same principal', async () => {
    const principal = randomUUID();

    // The quick bucket is far larger than the model bucket, so this drains it
    // without ever touching the model bucket's own ceiling.
    for (let i = 0; i < RATE_LIMIT_QUICK_PER_WINDOW; i += 1) {
      const outcome = await admitQuick(requestFor(principal));
      expect(outcome.ok).toBe(true);
    }
    const exhausted = await admitQuick(requestFor(principal));
    expect(exhausted.ok).toBe(false);

    // Same principal, same minute: the model bucket has never been touched.
    const model = await admit(requestFor(principal));
    expect(model.ok).toBe(true);
  });

  it('still bounds a caller: the quick route is rate-limited on its own terms', async () => {
    const principal = randomUUID();
    for (let i = 0; i < RATE_LIMIT_QUICK_PER_WINDOW; i += 1) {
      expect((await admitQuick(requestFor(principal))).ok).toBe(true);
    }
    expect((await admitQuick(requestFor(principal))).ok).toBe(false);
  });

  it('two different principals never share either bucket', async () => {
    const a = randomUUID();
    const b = randomUUID();
    for (let i = 0; i < RATE_LIMIT_PER_WINDOW; i += 1) expect((await admit(requestFor(a))).ok).toBe(true);
    expect((await admit(requestFor(a))).ok).toBe(false);
    expect((await admit(requestFor(b))).ok).toBe(true);
  });
});
