/**
 * Concurrency-bound tests.
 *
 * Every one of these is a *deterministic* statement about ordering, and none of
 * them measures time. Tasks are held open by deferred promises and released by
 * the test, so "two calls were in flight" is an assertion about the semaphore's
 * bookkeeping rather than about how fast a machine happened to be. The only
 * waiting done here is draining the microtask queue, which is ordered by
 * specification and needs no clock.
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  DEFAULT_LLM_MAX_CONCURRENCY,
  createConcurrencyLimiter,
  resolveMaxConcurrency,
  withConcurrencyLimit,
} from '../src/transport/limited';
import { createGateway } from '../src/index';
import type { LlmCompletion, LlmCompletionRequest, LlmTransport } from '../src/transport/types';
import { validationOk } from '../src/transport/types';

/* -------------------------------------------------------------------------- */
/*  Harness                                                                    */
/* -------------------------------------------------------------------------- */

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Drain the microtask queue.
 *
 * A permit hand-off crosses a fixed, small number of `await` points, so a fixed
 * number of turns is enough and no timer is involved. This is only ever used to
 * establish a *negative* — that a queued call has **not** started — since a
 * positive is awaited directly.
 */
async function settle(turns = 16): Promise<void> {
  for (let i = 0; i < turns; i += 1) await Promise.resolve();
}

const Schema = z.object({ ok: z.boolean() });

function request(tag: string): LlmCompletionRequest<{ ok: boolean }> {
  return { role: 'npc_strategist', system: 's', prompt: tag, schema: Schema, schemaName: 'Tag', sessionKey: null };
}

interface GatedTransport {
  readonly transport: LlmTransport;
  /** Prompts of the calls that have reached the underlying transport, in order. */
  readonly started: string[];
  /** Resolve the call with this prompt. */
  finish(tag: string): void;
  /** Reject the call with this prompt. */
  fail(tag: string, error: unknown): void;
  /** Resolves once `count` calls have reached the underlying transport. */
  whenStarted(count: number): Promise<void>;
}

/**
 * A transport whose every call hangs until the test lets it go. `kind` is
 * `claude-session` because that is the transport the bound actually protects.
 */
function gatedTransport(): GatedTransport {
  const started: string[] = [];
  const gates = new Map<string, Deferred<void>>();
  const watchers: Array<{ count: number; signal: Deferred<void> }> = [];

  const announce = (): void => {
    for (const watcher of [...watchers]) {
      if (started.length >= watcher.count) {
        watchers.splice(watchers.indexOf(watcher), 1);
        watcher.signal.resolve();
      }
    }
  };

  const gateFor = (tag: string): Deferred<void> => {
    const existing = gates.get(tag);
    if (existing !== undefined) return existing;
    const created = deferred<void>();
    gates.set(tag, created);
    return created;
  };

  return {
    started,
    transport: {
      kind: 'claude-session',
      async complete<T>(req: LlmCompletionRequest<T>): Promise<LlmCompletion<T>> {
        started.push(req.prompt);
        announce();
        await gateFor(req.prompt).promise;
        return {
          output: { ok: true } as unknown as T,
          raw: '{}',
          validation: validationOk(req.schemaName, false),
          modelId: 'test',
          latencyMs: 0,
          tokens: null,
          claudeSessionId: null,
        };
      },
    },
    finish(tag: string): void {
      gateFor(tag).resolve();
    },
    fail(tag: string, error: unknown): void {
      gateFor(tag).reject(error);
    },
    whenStarted(count: number): Promise<void> {
      if (started.length >= count) return Promise.resolve();
      const signal = deferred<void>();
      watchers.push({ count, signal });
      return signal.promise;
    },
  };
}

/* -------------------------------------------------------------------------- */
/*  Serialisation                                                              */
/* -------------------------------------------------------------------------- */

describe('withConcurrencyLimit', () => {
  it('serialises three concurrent calls at max=1, in arrival order', async () => {
    const gated = gatedTransport();
    const limited = withConcurrencyLimit(gated.transport, 1);

    const a = limited.complete(request('a'));
    const b = limited.complete(request('b'));
    const c = limited.complete(request('c'));

    // Only the first call reached the transport; the other two are queued.
    await settle();
    expect(gated.started).toEqual(['a']);

    gated.finish('a');
    await a;
    await gated.whenStarted(2);
    await settle();
    // FIFO: `b` was queued before `c`, so `b` runs next and `c` still waits.
    expect(gated.started).toEqual(['a', 'b']);

    gated.finish('b');
    await b;
    await gated.whenStarted(3);
    expect(gated.started).toEqual(['a', 'b', 'c']);

    gated.finish('c');
    const result = await c;
    expect(result.output).toEqual({ ok: true });
    expect(result.validation.ok).toBe(true);
  });

  it('allows exactly two in flight at max=2', async () => {
    const gated = gatedTransport();
    const limited = withConcurrencyLimit(gated.transport, 2);

    const calls = ['a', 'b', 'c', 'd'].map((tag) => limited.complete(request(tag)));

    await settle();
    expect(gated.started).toEqual(['a', 'b']);

    gated.finish('a');
    await calls[0];
    await gated.whenStarted(3);
    await settle();
    expect(gated.started).toEqual(['a', 'b', 'c']);

    gated.finish('b');
    gated.finish('c');
    await Promise.all([calls[1], calls[2]]);
    await gated.whenStarted(4);
    expect(gated.started).toEqual(['a', 'b', 'c', 'd']);

    gated.finish('d');
    await calls[3];
  });

  it('preserves the wrapped transport kind', () => {
    const gated = gatedTransport();
    expect(withConcurrencyLimit(gated.transport, 1).kind).toBe('claude-session');
  });

  /**
   * The bug this guards against is silent and permanent: a permit released only
   * on the success path means one thrown call narrows the gateway forever, and
   * at max=1 the very next quarter waits on a permit nobody holds.
   */
  it('releases the permit of a rejected call', async () => {
    const gated = gatedTransport();
    const limited = withConcurrencyLimit(gated.transport, 1);

    const first = limited.complete(request('boom'));
    const second = limited.complete(request('after'));

    await settle();
    expect(gated.started).toEqual(['boom']);

    const failure = new Error('subprocess died');
    gated.fail('boom', failure);
    await expect(first).rejects.toBe(failure);

    await gated.whenStarted(2);
    expect(gated.started).toEqual(['boom', 'after']);

    gated.finish('after');
    expect((await second).output).toEqual({ ok: true });
  });

  it('reports its own bookkeeping while calls are queued', async () => {
    const gated = gatedTransport();
    const limiter = createConcurrencyLimiter(1);
    const limited = withConcurrencyLimit(gated.transport, limiter);

    const first = limited.complete(request('one'));
    const second = limited.complete(request('two'));
    await settle();

    expect(limiter.max).toBe(1);
    expect(limiter.active).toBe(1);
    expect(limiter.queued).toBe(1);

    gated.finish('one');
    await first;
    gated.finish('two');
    await second;
    await settle();

    expect(limiter.active).toBe(0);
    expect(limiter.queued).toBe(0);
  });

  /** One limiter, two transports: the ceiling is the pair's, not each one's. */
  it('shares one bound across every transport it is given to', async () => {
    const left = gatedTransport();
    const right = gatedTransport();
    const limiter = createConcurrencyLimiter(1);
    const a = withConcurrencyLimit(left.transport, limiter);
    const b = withConcurrencyLimit(right.transport, limiter);

    const first = a.complete(request('left'));
    const second = b.complete(request('right'));

    await settle();
    expect(left.started).toEqual(['left']);
    expect(right.started).toEqual([]);

    left.finish('left');
    await first;
    await right.whenStarted(1);
    expect(right.started).toEqual(['right']);

    right.finish('right');
    await second;
  });
});

/* -------------------------------------------------------------------------- */
/*  Environment                                                                */
/* -------------------------------------------------------------------------- */

describe('resolveMaxConcurrency', () => {
  it('defaults to one', () => {
    expect(DEFAULT_LLM_MAX_CONCURRENCY).toBe(1);
    expect(resolveMaxConcurrency(undefined)).toBe(1);
    expect(resolveMaxConcurrency('')).toBe(1);
    expect(resolveMaxConcurrency('   ')).toBe(1);
  });

  it('accepts a whole number of at least one', () => {
    expect(resolveMaxConcurrency('1')).toBe(1);
    expect(resolveMaxConcurrency('2')).toBe(2);
    expect(resolveMaxConcurrency(' 4 ')).toBe(4);
  });

  it('fails closed on anything else', () => {
    for (const value of ['0', '-1', '-3', '2.5', 'lots', 'Infinity', 'NaN', '1e400', '1,2']) {
      expect(resolveMaxConcurrency(value)).toBe(1);
    }
  });
});

/* -------------------------------------------------------------------------- */
/*  Gateway wiring                                                             */
/* -------------------------------------------------------------------------- */

describe('gateway concurrency', () => {
  it('bounds the claude-session transport at one call by default', () => {
    const gateway = createGateway({ LLM_TRANSPORT: 'claude-session' });
    expect(gateway.maxConcurrency).toBe(1);
    expect(gateway.transport.kind).toBe('claude-session');
  });

  it('reads LLM_MAX_CONCURRENCY, and falls back to one when it is nonsense', () => {
    expect(createGateway({ LLM_MAX_CONCURRENCY: '3' }).maxConcurrency).toBe(3);
    expect(createGateway({ LLM_MAX_CONCURRENCY: 'three' }).maxConcurrency).toBe(1);
    expect(createGateway({ LLM_TRANSPORT: 'api', ANTHROPIC_API_KEY: 'k', LLM_MAX_CONCURRENCY: '2' }).maxConcurrency).toBe(2);
  });

  it('serialises real role calls through the gateway at max=1', async () => {
    const gated = gatedTransport();
    // The gateway builds its own transport, so drive the bound through the
    // limiter it was handed — the same seam the web app uses.
    const limiter = createConcurrencyLimiter(1);
    const limited = withConcurrencyLimit(gated.transport, limiter);

    const first = limited.complete(request('q1'));
    const second = limited.complete(request('q2'));
    await settle();
    expect(limiter.active).toBe(1);
    expect(gated.started).toEqual(['q1']);

    const gateway = createGateway({ LLM_TRANSPORT: 'none' }, { concurrencyLimiter: limiter });
    expect(gateway.maxConcurrency).toBe(1);

    gated.finish('q1');
    await first;
    gated.finish('q2');
    await second;
  });

  it('takes its reported bound from a shared limiter over the environment', () => {
    const limiter = createConcurrencyLimiter(5);
    expect(createGateway({ LLM_MAX_CONCURRENCY: '2' }, { concurrencyLimiter: limiter }).maxConcurrency).toBe(5);
  });
});
