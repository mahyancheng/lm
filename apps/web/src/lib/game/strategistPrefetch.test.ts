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
}));

const { clearStrategistPrefetch, hasStrategistPrefetch, startStrategistPrefetch, takeStrategistPrefetch } = await import(
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

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
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

  it('replacing the prefetch set aborts entries that are no longer wanted', async () => {
    const state = session();
    const controllerSignals: AbortSignal[] = [];
    requestNpcBundle.mockImplementation((_input: unknown, _evidence: unknown, signal?: AbortSignal) => {
      if (signal !== undefined) controllerSignals.push(signal);
      return new Promise(() => {
        /* never settles on its own — only an abort ends it */
      });
    });

    startStrategistPrefetch(state, ['cmp_orbit', 'cmp_helix']);
    expect(controllerSignals).toHaveLength(2);
    expect(controllerSignals.every((signal) => signal.aborted)).toBe(false);

    // Drop cmp_helix from the next call: its entry must be aborted, cmp_orbit's must not.
    startStrategistPrefetch(state, ['cmp_orbit']);
    expect(controllerSignals[0]?.aborted).toBe(false);
    expect(controllerSignals[1]?.aborted).toBe(true);
    expect(hasStrategistPrefetch(state, 'cmp_helix')).toBe(false);
    expect(hasStrategistPrefetch(state, 'cmp_orbit')).toBe(true);
  });

  it('clearStrategistPrefetch aborts everything in flight and empties the cache', async () => {
    const state = session();
    let signal: AbortSignal | undefined;
    requestNpcBundle.mockImplementation((_input: unknown, _evidence: unknown, s?: AbortSignal) => {
      signal = s;
      return new Promise(() => undefined);
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
});
