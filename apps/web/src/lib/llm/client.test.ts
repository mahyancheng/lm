/**
 * The health memo, and the race it used to lose.
 *
 * Only the health half of `client.ts` is tested here, because it is the only
 * part that holds state: the role fetchers are one `fetch` each and resolve to
 * `null` on anything at all, which the routes' own tests cover.
 *
 * What must never regress:
 *
 * 1. **A stale answer never overwrites a fresh one.** `resetLlmHealth()` used
 *    to drop the cache and leave the in-flight request alone, so a check
 *    started *before* the player pasted a token would land after it and write
 *    its `offline` into the cache with a brand-new timestamp. Every settings
 *    mutation resets health, so this was not an exotic interleaving — it was
 *    the ordinary sequence of clicking Connect while the status bar polled, and
 *    the dot stayed wrong for the whole TTL.
 * 2. **`force` means ask again now**, not "join whatever is already in the
 *    air", which is the same stale answer under a different name.
 * 3. The ordinary path still memoises: a store may poll freely.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type LlmHealth, llmHealth, resetLlmHealth } from './client';

const LIVE: LlmHealth = { available: true, transportKind: 'claude-session', model: 'sonnet' };
const OFFLINE: LlmHealth = { available: false, transportKind: 'none', model: null };

/** A `fetch` that answers only when the test says so, one deferred per call. */
function stubHealthFetch(): { resolve: (body: LlmHealth) => void }[] {
  const pending: { resolve: (body: LlmHealth) => void }[] = [];
  vi.stubGlobal('window', globalThis);
  vi.stubGlobal('fetch', () => {
    return new Promise<Response>((settle) => {
      pending.push({
        resolve: (body) => settle({ ok: true, status: 200, json: () => Promise.resolve(body) } as Response),
      });
    });
  });
  return pending;
}

beforeEach(() => {
  resetLlmHealth();
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetLlmHealth();
});

/* -------------------------------------------------------------------------- */

describe('the health memo', () => {
  it('memoises, so a polling store costs one request', async () => {
    const pending = stubHealthFetch();
    const first = llmHealth();
    const second = llmHealth();
    expect(pending).toHaveLength(1);

    pending[0]?.resolve(LIVE);
    await expect(first).resolves.toEqual(LIVE);
    await expect(second).resolves.toEqual(LIVE);
    await expect(llmHealth()).resolves.toEqual(LIVE);
    expect(pending).toHaveLength(1);
  });

  it('is offline on the server, where there is no window to fetch from', async () => {
    vi.stubGlobal('window', undefined);
    await expect(llmHealth()).resolves.toEqual(OFFLINE);
  });
});

describe('the generation guard', () => {
  it('will not let an older answer overwrite the one taken after a reset', async () => {
    const pending = stubHealthFetch();

    // The status bar polls: request A goes out while no credential is set.
    const stale = llmHealth();
    expect(pending).toHaveLength(1);

    // The player pastes a token. Every mutation resets health.
    resetLlmHealth();
    const fresh = llmHealth();
    expect(pending).toHaveLength(2);

    // B answers first, with the truth.
    pending[1]?.resolve(LIVE);
    await expect(fresh).resolves.toEqual(LIVE);

    // A lands afterwards, still describing the world before the paste. It may
    // return its own answer to its own caller; it may not speak for the module.
    pending[0]?.resolve(OFFLINE);
    await expect(stale).resolves.toEqual(OFFLINE);

    // The memo — and therefore the status dot — still holds the fresh answer,
    // and answers it without another request.
    await expect(llmHealth()).resolves.toEqual(LIVE);
    expect(pending).toHaveLength(2);
  });

  it('drops the in-flight request as well as the cache', async () => {
    const pending = stubHealthFetch();
    const abandoned = llmHealth();
    resetLlmHealth();

    // Nothing may join the pre-reset request, force or not.
    void llmHealth();
    expect(pending).toHaveLength(2);

    pending[0]?.resolve(LIVE);
    await abandoned;
    // ...and its answer did not become the cache, so the next read is a fresh
    // request rather than a value from before the configuration changed.
    pending[1]?.resolve(OFFLINE);
    await expect(llmHealth()).resolves.toEqual(OFFLINE);
    expect(pending).toHaveLength(2);
  });

  it('starts a new request for force, rather than joining one already in the air', async () => {
    const pending = stubHealthFetch();
    const polled = llmHealth();
    const forced = llmHealth(true);
    expect(pending).toHaveLength(2);

    pending[0]?.resolve(OFFLINE);
    await expect(polled).resolves.toEqual(OFFLINE);
    pending[1]?.resolve(LIVE);
    await expect(forced).resolves.toEqual(LIVE);
    await expect(llmHealth()).resolves.toEqual(LIVE);
  });

  it('skips the memo for force even when the cache is warm', async () => {
    const pending = stubHealthFetch();
    const first = llmHealth();
    pending[0]?.resolve(OFFLINE);
    await first;

    const forced = llmHealth(true);
    expect(pending).toHaveLength(2);
    pending[1]?.resolve(LIVE);
    await expect(forced).resolves.toEqual(LIVE);
  });
});
