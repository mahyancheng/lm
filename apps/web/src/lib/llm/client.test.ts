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
import type { ChiefOfStaffInterpretation } from '@frontier/contracts';
import { ChiefOfStaffInterpretationSchema } from '@frontier/contracts';
import {
  type LlmHealth,
  llmHealth,
  requestChiefOfStaff,
  requestChiefOfStaffQuick,
  resetLlmHealth,
} from './client';

const LIVE: LlmHealth = { available: true, transportKind: 'claude-session', model: 'sonnet', queueDepth: 0, runningRole: null };
const OFFLINE: LlmHealth = { available: false, transportKind: 'none', model: null, queueDepth: 0, runningRole: null };

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

/* -------------------------------------------------------------------------- */
/*  requestChiefOfStaff — timeouts, retry, and honest failure reasons          */
/* -------------------------------------------------------------------------- */

const INPUT = {
  sessionId: 'demo-session',
  quarter: 3,
  playerId: 'player-1',
  companyId: 'cmp_demo',
  playerMessage: 'How much runway have we got?',
  companyBriefing: 'Cash 4,000,000. Burn 200,000 a quarter.',
  worldBriefing: 'Stable conditions.',
  currentBudgets: [],
  openDecisions: [],
  conversationHistory: [],
  autoExecuteEnabled: false,
};

const CONVERSATION = { sessionId: 'demo-session', playerId: 'player-1', conversationId: 'main' as const };

const ANSWER: ChiefOfStaffInterpretation = ChiefOfStaffInterpretationSchema.parse({
  mode: 'answer',
  reply: 'Eleven months of runway at the current burn.',
  interpretedInstructions: [],
  summary: 'Read from the dossier.',
  questions: [],
  requiresConfirmation: true,
  confidence: 0.7,
  unsupportedRequests: [],
  lookups: [],
});

function okResponse(body: unknown): Response {
  return { ok: true, status: 200, json: () => Promise.resolve(body) } as Response;
}

function errorResponse(status: number): Response {
  return { ok: false, status, json: () => Promise.resolve({}) } as Response;
}

describe('requestChiefOfStaff', () => {
  beforeEach(() => {
    vi.stubGlobal('window', globalThis);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('retries exactly once on a 5xx, and returns the answer the retry gets', async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return calls.length === 1 ? errorResponse(503) : okResponse({ output: ANSWER, fallback: false });
    });
    vi.stubGlobal('fetch', fetchMock);

    const attempt = await requestChiefOfStaff(INPUT, CONVERSATION);

    expect(calls).toEqual(['/api/llm/chief-of-staff', '/api/llm/chief-of-staff']);
    expect(attempt).toEqual({ output: ANSWER, failure: null, fallback: false });
  });

  it('does not retry a definitive 4xx — one attempt, still reported to the caller', async () => {
    const fetchMock = vi.fn(async () => errorResponse(429));
    vi.stubGlobal('fetch', fetchMock);

    const attempt = await requestChiefOfStaff(INPUT, CONVERSATION);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(attempt).toEqual({ output: null, failure: 'network_error', fallback: false });
  });

  it('retries exactly once on a network error, and reports network_error when both attempts fail', async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    vi.stubGlobal('fetch', fetchMock);

    const attempt = await requestChiefOfStaff(INPUT, CONVERSATION);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(attempt).toEqual({ output: null, failure: 'network_error', fallback: false });
  });

  it('does not retry a timeout — one attempt, reported as timeout', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const attemptPromise = requestChiefOfStaff(INPUT, CONVERSATION);
    // The ceiling is 150s; nothing short of it may fire this early.
    await vi.advanceTimersByTimeAsync(149_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2_000);

    await expect(attemptPromise).resolves.toEqual({ output: null, failure: 'timeout', fallback: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('reports a founder-initiated cancel as aborted, not as a failure to retry', async () => {
    const fetchMock = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const controller = new AbortController();
    const attemptPromise = requestChiefOfStaff(INPUT, CONVERSATION, { signal: controller.signal });
    controller.abort();

    await expect(attemptPromise).resolves.toEqual({ output: null, failure: 'aborted', fallback: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('surfaces a clean server-side fallback as an answer, not a failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => okResponse({ output: ANSWER, fallback: true, reason: 'transport_none' })),
    );

    const attempt = await requestChiefOfStaff(INPUT, CONVERSATION);
    expect(attempt).toEqual({ output: ANSWER, failure: null, fallback: true });
  });
});

describe('requestChiefOfStaffQuick', () => {
  beforeEach(() => {
    vi.stubGlobal('window', globalThis);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('hits the dedicated quick route and returns its output', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe('/api/llm/chief-of-staff/quick');
      return okResponse({ output: ANSWER, fallback: true, reason: 'quick_answer' });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(requestChiefOfStaffQuick(INPUT, CONVERSATION)).resolves.toEqual(ANSWER);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('resolves to null, never throws, when the quick route is unreachable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('network down');
      }),
    );
    await expect(requestChiefOfStaffQuick(INPUT, CONVERSATION)).resolves.toBeNull();
  });
});
