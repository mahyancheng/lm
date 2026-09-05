/**
 * @frontier/llm — transport/limited.ts
 *
 * A FIFO concurrency bound around any transport.
 *
 * ## Why this exists
 *
 * The `claude-session` transport is not a network call. Every `complete()`
 * spawns the Claude Code CLI — a single ~213 MB Bun-compiled executable — as a
 * child process. One quarter of Frontier Capital consults the World Director
 * and then *every* rival strategist, and the client fires those strategist
 * calls together (`Promise.all` over the strategist companies). On a laptop
 * that is four extra processes and nobody notices. On the 4 GB single-board
 * machine this game is actually deployed to, four simultaneous spawns is the
 * whole of free memory, and the kernel starts killing things that have nothing
 * to do with the game.
 *
 * So the bound lives **here**, in the gateway, and not in the client that
 * happens to fan out today: a limit a caller can forget to apply is not a
 * limit. Every route, every role and every future caller inherits it because
 * they all share one transport.
 *
 * ## Queue, never reject
 *
 * A permit is *waited for*, never refused. That distinction is the whole
 * design:
 *
 * - Refusing would hand the role layer a failed completion, and a failed
 *   completion means the deterministic fallback runs. Four rivals would quietly
 *   drop to archetype defaults on a machine that was merely being careful with
 *   memory — a silently worse game, which is exactly the outcome the fallback
 *   machinery exists to make *visible* rather than routine.
 * - Queueing costs wall-clock and nothing else. A four-rival quarter at
 *   `max = 1` resolves one strategist at a time and every rival still gets its
 *   own genuine plan.
 *
 * Order is first-in-first-out *within a priority lane* — see "Priority lanes"
 * below — so a call cannot be starved by a later arrival in the same lane.
 *
 * ## Priority lanes
 *
 * A quarter's own batch of calls (World Director, then up to six NPC
 * strategists, then up to three social-author posts) can hold the single
 * permit for minutes on the Pi. A founder who opens the Chief of Staff during
 * that window is not asking about the quarter that is resolving — they are
 * asking about the company they are looking at right now, and a queue that
 * made them wait behind someone else's rival strategists is indistinguishable
 * from "the model cannot be reached."
 *
 * So there are two waiting lines, not one: `interactive` (a founder is looking
 * directly at this call — Chief of Staff, character dialogue, the innovation
 * interpreter) and `batch` (fired unattended, in bulk, by the resolver). Both
 * still share the one `max` permits total — this is not a second concurrency
 * lane, only a second *queue* — but whenever a permit frees up, every waiting
 * `interactive` call is served before any waiting `batch` call, oldest first
 * within each line. A `batch` call already holding the permit is never
 * pre-empted mid-flight (there is no way to pre-empt a spawned subprocess);
 * only the *next* permit is affected. `batch` calls are never starved outright
 * — they resume the moment the interactive traffic clears — but they are
 * deliberately deprioritised while a person is waiting.
 *
 * ## Clock-free
 *
 * There is no timeout, no deadline and no `Date.now()` in this module. A permit
 * is released when the task settles — resolved *or* rejected — and never on a
 * timer. Callers that need a deadline own it themselves; a limiter that
 * abandoned a queued call would reintroduce the silent-fallback failure this
 * module exists to prevent.
 */

import type { AgentRole } from '@frontier/contracts';
import type { LlmCallClass, LlmCompletion, LlmCompletionRequest, LlmTransport } from './types';

/* -------------------------------------------------------------------------- */
/*  Configuration                                                              */
/* -------------------------------------------------------------------------- */

/**
 * One model call at a time.
 *
 * Chosen because it is the only value that is safe *everywhere*: the smallest
 * host this game runs on cannot afford two Claude Code subprocesses, and a
 * default that assumes otherwise fails as an outage rather than as slowness.
 * Hosts with headroom raise `LLM_MAX_CONCURRENCY`.
 */
export const DEFAULT_LLM_MAX_CONCURRENCY = 1;

/** The variable the gateway reads this bound from. */
export const MAX_CONCURRENCY_ENV = 'LLM_MAX_CONCURRENCY';

/**
 * Read `LLM_MAX_CONCURRENCY`.
 *
 * Anything that is not a whole number of at least one — empty, `0`, `-3`,
 * `2.5`, `lots`, `Infinity` — resolves to the default. Failing *closed* is the
 * point: a typo in a deployment variable must not silently unbound the number
 * of subprocesses a quarter may spawn.
 */
export function resolveMaxConcurrency(value: string | undefined): number {
  const trimmed = (value ?? '').trim();
  if (trimmed.length === 0) return DEFAULT_LLM_MAX_CONCURRENCY;
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed < 1) return DEFAULT_LLM_MAX_CONCURRENCY;
  return parsed;
}

/* -------------------------------------------------------------------------- */
/*  The semaphore                                                              */
/* -------------------------------------------------------------------------- */

/** Everything `run` accepts beyond the task itself. Every field is optional and defaults conservatively. */
export interface ConcurrencyRunOptions {
  /** Which queue this call waits in when no permit is free. Defaults to `'batch'`. See `LlmCallClass`. */
  readonly priority?: LlmCallClass;
  /** Which role is calling, recorded only for `snapshot()` — never read by the queue logic itself. */
  readonly role?: AgentRole;
}

/** A point-in-time read of the limiter's bookkeeping, for the health route. */
export interface LimiterSnapshot {
  readonly max: number;
  readonly active: number;
  /** Total waiting, both lanes. */
  readonly queued: number;
  readonly queuedInteractive: number;
  readonly queuedBatch: number;
  /** The role of the call currently holding the permit, or null when the limiter is idle. */
  readonly runningRole: AgentRole | null;
  /** The lane of the call currently holding the permit, or null when idle. */
  readonly runningPriority: LlmCallClass | null;
}

export interface ConcurrencyLimiter {
  /** How many tasks may run at once. Fixed for the life of the limiter. */
  readonly max: number;
  /** Tasks currently holding a permit. Diagnostics only. */
  readonly active: number;
  /** Tasks waiting for one, across both priority lanes. Diagnostics only. */
  readonly queued: number;
  /** Run `task` once a permit is free. Resolves or rejects exactly as `task` does. */
  run<T>(task: () => Promise<T>, options?: ConcurrencyRunOptions): Promise<T>;
  /** A snapshot of the queue right now — depth per lane and who holds the permit. */
  snapshot(): LimiterSnapshot;
}

/**
 * A priority-lane async semaphore.
 *
 * Three properties worth stating because tests depend on all three:
 *
 * 1. **An uncontended `run` starts its task synchronously.** The permit is
 *    taken in `run`'s synchronous prologue, so `limiter.run(t)` on a free
 *    limiter has already called `t()` by the time it returns its promise. No
 *    microtask hop stands between "a permit was free" and "the work began".
 * 2. **A permit is handed directly to the next waiter**, rather than being
 *    returned to a counter that the waiter then races for. `active` therefore
 *    never dips below `max` while anything is queued, and wake-up order is
 *    exactly the rule below — never a re-race.
 * 3. **`interactive` waiters are served before `batch` waiters, always** —
 *    oldest first within each lane, but every interactive arrival outranks
 *    every batch arrival regardless of who queued first. This is a priority
 *    order, not a plain FIFO, and it is the entire point of having two lanes:
 *    see "Priority lanes" above.
 */
export function createConcurrencyLimiter(max: number): ConcurrencyLimiter {
  const ceiling = Number.isInteger(max) && max >= 1 ? max : DEFAULT_LLM_MAX_CONCURRENCY;
  /** Resolvers of the waiting interactive calls, oldest first. Always drained before `batchWaiters`. */
  const interactiveWaiters: Array<() => void> = [];
  /** Resolvers of the waiting batch calls, oldest first. */
  const batchWaiters: Array<() => void> = [];
  let active = 0;
  let runningRole: AgentRole | null = null;
  let runningPriority: LlmCallClass | null = null;

  /** Take a permit now, or a promise that resolves when one is handed over. */
  function acquire(priority: LlmCallClass): Promise<void> | null {
    if (active < ceiling) {
      active += 1;
      return null;
    }
    const queue = priority === 'interactive' ? interactiveWaiters : batchWaiters;
    return new Promise<void>((resolve) => {
      queue.push(resolve);
    });
  }

  /** Give the permit to the oldest interactive waiter, else the oldest batch waiter, else put it back. */
  function release(): void {
    const next = interactiveWaiters.shift() ?? batchWaiters.shift();
    if (next === undefined) {
      active -= 1;
      runningRole = null;
      runningPriority = null;
      return;
    }
    // `active` is deliberately unchanged: the permit moves, it is not recycled.
    next();
  }

  return {
    max: ceiling,
    get active() {
      return active;
    },
    get queued() {
      return interactiveWaiters.length + batchWaiters.length;
    },
    async run<T>(task: () => Promise<T>, options?: ConcurrencyRunOptions): Promise<T> {
      const priority = options?.priority ?? 'batch';
      const wait = acquire(priority);
      if (wait !== null) await wait;
      // Recorded only once the permit is actually held, so `snapshot()` never
      // reports a "running" role that is really still queued.
      runningRole = options?.role ?? null;
      runningPriority = priority;
      try {
        return await task();
      } finally {
        // In `finally` on purpose: a throwing task must not leak its permit, or
        // one bad call permanently narrows the gateway and a later quarter
        // deadlocks waiting for a permit nobody holds.
        release();
      }
    },
    snapshot(): LimiterSnapshot {
      return {
        max: ceiling,
        active,
        queued: interactiveWaiters.length + batchWaiters.length,
        queuedInteractive: interactiveWaiters.length,
        queuedBatch: batchWaiters.length,
        runningRole,
        runningPriority,
      };
    },
  };
}

/* -------------------------------------------------------------------------- */
/*  The wrapper                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Wrap `transport` so at most `max` calls are in flight at once.
 *
 * `kind` is preserved, because the bound is an operational detail and not a
 * different transport: run records, `transportAvailable()` and the health
 * endpoint must all still see `claude-session` for what it is.
 *
 * Pass a `ConcurrencyLimiter` instead of a number to share one bound across
 * several transports — which is what the web app does, so that rebuilding the
 * gateway (as happens when the operator pastes a new credential) cannot let a
 * second wave of subprocesses in alongside the calls already running.
 */
export function withConcurrencyLimit(transport: LlmTransport, max: number | ConcurrencyLimiter): LlmTransport {
  const limiter = typeof max === 'number' ? createConcurrencyLimiter(max) : max;

  return {
    ...transport,
    complete<T>(req: LlmCompletionRequest<T>): Promise<LlmCompletion<T>> {
      return limiter.run(() => transport.complete(req), { priority: req.priority ?? 'batch', role: req.role });
    },
  };
}
