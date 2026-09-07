/**
 * `strategistPrefetch.ts` — cache hit, miss and invalidation.
 *
 * `requestNpcBundle` is mocked so these tests exercise the cache's own
 * bookkeeping — key derivation, reuse, abort-on-replace — without a network
 * call or a Claude Code subprocess.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NpcActionBundle, SessionState } from '@frontier/contracts';
import { createDemoSession } from '@frontier/simulation';

const requestNpcBundle = vi.fn();
vi.mock('@/lib/llm/client', () => ({
  requestNpcBundle: (...args: unknown[]) => requestNpcBundle(...args),
  LLM_QUARTER_BUDGET_MS: Number.POSITIVE_INFINITY,
}));

const { clearStrategistPrefetch, hasStrategistPrefetch, startStrategistPrefetch, strategistStateHash, takeStrategistPrefetch } = await import(
  './strategistPrefetch'
);

function session(): SessionState {
  return createDemoSession();
}

function bundle(companyId: string): NpcActionBundle {
  return {
    companyId,
    strategySummary: 'A fixture strategy summary, well past the minimum length.',
    posture: 'balanced',
    actions: [],
    rationale: 'A fixture rationale, also well past the minimum length required by the schema.',
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason?: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const controlled = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise: controlled, resolve, reject };
}

beforeEach(() => {
  requestNpcBundle.mockReset();
});

afterEach(() => {
  clearStrategistPrefetch();
});

describe('startStrategistPrefetch / takeStrategistPrefetch', () => {
  it('has no entry before anything is prefetched (miss)', async () => {
    const state = session();
    expect(hasStrategistPrefetch(state, 'cmp_orbit')).toBe(false);
    await expect(takeStrategistPrefetch(state, 'cmp_orbit')).resolves.toBeNull();
    expect(requestNpcBundle).not.toHaveBeenCalled();
  });

  it('fires exactly one request per company and caches the result (hit)', async () => {
    const state = session();
    requestNpcBundle.mockResolvedValue(bundle('cmp_orbit'));

    startStrategistPrefetch(state, ['cmp_orbit']);
    expect(hasStrategistPrefetch(state, 'cmp_orbit')).toBe(true);
    expect(requestNpcBundle).toHaveBeenCalledTimes(1);

    const result = await takeStrategistPrefetch(state, 'cmp_orbit');
    expect(result).toEqual(bundle('cmp_orbit'));

    // A second read of the same (state, company) does not fire a second call.
    await takeStrategistPrefetch(state, 'cmp_orbit');
    expect(requestNpcBundle).toHaveBeenCalledTimes(1);
  });

  it('calling startStrategistPrefetch again for the same (state, company) reuses the in-flight entry rather than firing twice', async () => {
    const state = session();
    const first = deferred<NpcActionBundle | null>();
    requestNpcBundle.mockReturnValueOnce(first.promise);

    startStrategistPrefetch(state, ['cmp_orbit']);
    startStrategistPrefetch(state, ['cmp_orbit']);
    expect(requestNpcBundle).toHaveBeenCalledTimes(1);

    first.resolve(bundle('cmp_orbit'));
    await expect(takeStrategistPrefetch(state, 'cmp_orbit')).resolves.toEqual(bundle('cmp_orbit'));
  });

  it('a request that resolves null is cached as a miss, not retried', async () => {
    const state = session();
    requestNpcBundle.mockResolvedValue(null);

    startStrategistPrefetch(state, ['cmp_orbit']);
    await expect(takeStrategistPrefetch(state, 'cmp_orbit')).resolves.toBeNull();
    await takeStrategistPrefetch(state, 'cmp_orbit');
    expect(requestNpcBundle).toHaveBeenCalledTimes(1);
  });

  it('a rejected request resolves to null rather than throwing', async () => {
    const state = session();
    requestNpcBundle.mockRejectedValue(new Error('network'));

    startStrategistPrefetch(state, ['cmp_orbit']);
    await expect(takeStrategistPrefetch(state, 'cmp_orbit')).resolves.toBeNull();
  });

  it('is keyed on the state hash: a different session state never hits an old entry', async () => {
    const before = session();
    requestNpcBundle.mockResolvedValue(bundle('cmp_orbit'));
    startStrategistPrefetch(before, ['cmp_orbit']);
    await takeStrategistPrefetch(before, 'cmp_orbit');

    // A structurally different session (a different quarter) is a different key.
    const after: SessionState = { ...before, quarter: before.quarter + 1 };
    expect(hasStrategistPrefetch(after, 'cmp_orbit')).toBe(false);
  });

  it('dispatches the tail only after the prior result, preserving the requested order', async () => {
    const state = session();
    const first = deferred<NpcActionBundle | null>();
    requestNpcBundle.mockReturnValueOnce(first.promise).mockResolvedValueOnce(bundle('cmp_helix'));

    startStrategistPrefetch(state, ['cmp_orbit', 'cmp_helix']);
    expect(requestNpcBundle).toHaveBeenCalledTimes(1);
    expect(requestNpcBundle.mock.calls[0]?.[0]).toMatchObject({ companyId: 'cmp_orbit' });

    first.resolve(bundle('cmp_orbit'));
    await expect(takeStrategistPrefetch(state, 'cmp_helix')).resolves.toEqual(bundle('cmp_helix'));
    expect(requestNpcBundle).toHaveBeenCalledTimes(2);
    expect(requestNpcBundle.mock.calls[1]?.[0]).toMatchObject({ companyId: 'cmp_helix' });
  });

  it('dispatches the tail after a prior request fails', async () => {
    const state = session();
    const first = deferred<NpcActionBundle | null>();
    requestNpcBundle.mockReturnValueOnce(first.promise).mockResolvedValueOnce(bundle('cmp_helix'));

    startStrategistPrefetch(state, ['cmp_orbit', 'cmp_helix']);
    first.reject(new Error('network'));
    await expect(takeStrategistPrefetch(state, 'cmp_helix')).resolves.toEqual(bundle('cmp_helix'));
    expect(requestNpcBundle).toHaveBeenCalledTimes(2);
  });

  it('replacing the prefetch set aborts entries that are no longer wanted', async () => {
    const state = session();
    const controllerSignals: AbortSignal[] = [];
    requestNpcBundle.mockImplementation((_input: unknown, _evidence: unknown, signal?: AbortSignal) => {
      if (signal !== undefined) controllerSignals.push(signal);
      return new Promise<NpcActionBundle | null>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    });

    startStrategistPrefetch(state, ['cmp_orbit', 'cmp_helix']);
    expect(controllerSignals).toHaveLength(1);

    // Drop queued cmp_helix before it reaches the client: no stale HTTP POST.
    startStrategistPrefetch(state, ['cmp_orbit']);
    expect(controllerSignals[0]?.aborted).toBe(false);
    expect(hasStrategistPrefetch(state, 'cmp_helix')).toBe(false);
    expect(hasStrategistPrefetch(state, 'cmp_orbit')).toBe(true);
    clearStrategistPrefetch();
  });

  it('clearStrategistPrefetch aborts everything in flight and empties the cache', async () => {
    const state = session();
    let signal: AbortSignal | undefined;
    requestNpcBundle.mockImplementation((_input: unknown, _evidence: unknown, s?: AbortSignal) => {
      signal = s;
      return new Promise<NpcActionBundle | null>((_resolve, reject) => s?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    });

    startStrategistPrefetch(state, ['cmp_orbit']);
    expect(hasStrategistPrefetch(state, 'cmp_orbit')).toBe(true);

    clearStrategistPrefetch();
    expect(signal?.aborted).toBe(true);
    expect(hasStrategistPrefetch(state, 'cmp_orbit')).toBe(false);
  });

  it('an empty company list prefetches nothing', () => {
    const state = session();
    startStrategistPrefetch(state, []);
    expect(requestNpcBundle).not.toHaveBeenCalled();
  });

  it('never posts a queued job after its cache entry was invalidated', async () => {
    const state = session();
    const first = deferred<NpcActionBundle | null>();
    requestNpcBundle.mockReturnValueOnce(first.promise).mockResolvedValueOnce(bundle('cmp_vectorworks'));
    startStrategistPrefetch(state, ['cmp_orbit', 'cmp_helix']);
    startStrategistPrefetch(state, ['cmp_orbit', 'cmp_vectorworks']);

    first.resolve(bundle('cmp_orbit'));
    await expect(takeStrategistPrefetch(state, 'cmp_vectorworks')).resolves.toEqual(bundle('cmp_vectorworks'));
    expect(requestNpcBundle.mock.calls.map(([input]) => (input as { companyId: string }).companyId)).toEqual(['cmp_orbit', 'cmp_vectorworks']);
  });

  it('settles an invalidated queued entry without posting it, then waits for the active abort before a replacement starts', async () => {
    const state = session();
    const active = deferred<NpcActionBundle | null>();
    requestNpcBundle.mockReturnValueOnce(active.promise).mockResolvedValueOnce(bundle('cmp_vectorworks'));
    startStrategistPrefetch(state, ['cmp_orbit', 'cmp_helix']);
    const queued = takeStrategistPrefetch(state, 'cmp_helix');
    clearStrategistPrefetch();
    await expect(queued).resolves.toBeNull();
    startStrategistPrefetch(state, ['cmp_vectorworks']);
    expect(requestNpcBundle).toHaveBeenCalledTimes(1);
    active.resolve(null);
    await expect(takeStrategistPrefetch(state, 'cmp_vectorworks')).resolves.toEqual(bundle('cmp_vectorworks'));
    expect(requestNpcBundle.mock.calls.map(([input]) => (input as { companyId: string }).companyId)).toEqual(['cmp_orbit', 'cmp_vectorworks']);
  });
});

describe('strategistStateHash', () => {
  it('keeps opening and engine memories in the strategist fingerprint while ignoring a current dialogue write', () => {
    const before = session();
    const seedMemory = { ...before.memories[0]!, id: 'mem_seed_fact', quarter: before.quarter };
    const dialogueMemory = { ...seedMemory, id: 'mem:npc:session:company:player:target:2' };
    expect(strategistStateHash({ ...before, memories: [...before.memories, dialogueMemory] })).toBe(strategistStateHash(before));
    expect(strategistStateHash({ ...before, memories: [...before.memories, seedMemory] })).not.toBe(strategistStateHash(before));
  });

  it('does not invalidate a quarter plan when only player dialogue transcript changes', async () => {
    const before = session();
    requestNpcBundle.mockResolvedValue(bundle('cmp_orbit'));
    startStrategistPrefetch(before, ['cmp_orbit']);

    const after: SessionState = {
      ...before,
      conversationThreads: [{
        id: 'thread_1', sessionId: before.sessionId, playerCompanyId: 'cmp_player', playerCharacterId: 'chr_player', targetCharacterId: 'chr_target', targetCompanyId: null,
        turns: [{ speakerId: 'chr_player', text: 'Can we talk terms?', quarter: before.quarter }], nextTurnSequence: 1, lastMessageQuarter: before.quarter,
      }],
    };
    expect(hasStrategistPrefetch(after, 'cmp_orbit')).toBe(true);
    await expect(takeStrategistPrefetch(after, 'cmp_orbit')).resolves.toEqual(bundle('cmp_orbit'));
    expect(requestNpcBundle).toHaveBeenCalledTimes(1);
  });
});
