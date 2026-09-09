'use client';

/**
 * Background NPC-strategist prefetch, started the moment a quarter opens.
 *
 * A strategist's plan depends only on state at the start of the quarter and
 * its own private information (`buildNpcStrategistInput` in `briefings.ts`
 * reads nothing else) — so there is no reason to wait until the player clicks
 * End Quarter to ask for it. This module starts those calls in the background
 * as soon as `provider.tsx` sees a quarter open, caches the in-flight promise
 * by `(state hash, quarter, companyId)`, and `endQuarter` reaches for the
 * cached answer instead of firing a fresh request — the resolving overlay then
 * only has to wait for whichever call is not back yet, not the whole batch.
 *
 * Bounded memory: `startStrategistPrefetch` replaces the whole cache on every
 * call, so it never holds more than one quarter's worth of entries. Anything
 * from an older quarter or an abandoned session that never got read is
 * aborted, not merely dropped — a `claude-session` call spawns a real
 * subprocess, and letting a stale one run unbounded in the background is the
 * same memory risk the concurrency limiter exists to prevent.
 *
 * Aborting is a courtesy, not a guarantee: per `packages/llm/transport/limited.ts`,
 * a client-side abort does not free the server's queue permit or stop a
 * subprocess already spawned. It does stop this module from waiting on it, and
 * — the case that matters here — a call still queued behind another one is
 * dropped from the queue before it ever starts.
 */

import { hashState } from '@frontier/shared';
import type { NpcActionBundle, SessionState } from '@frontier/contracts';
import { buildNpcStrategistInput, isCurrentQuarterDialogueMemory, type StrategistBriefingOptions } from './briefings';
import { requestNpcBundle } from '@/lib/llm/client';


/**
 * A strategist plans from the committed opening-of-quarter brief. Player
 * dialogue and its CEO memory are visible to the dialogue system immediately,
 * then enter the strategist dossier next quarter. Excluding current-quarter
 * thread/memory writes prevents a chat from aborting and re-running an
 * in-flight strategist call; company-agent inboxes remain in the fingerprint.
 */
export function strategistStateHash(session: SessionState): string {
  const { conversationThreads: _conversationThreads, ...withoutThreads } = session;
  const strategistState = { ...withoutThreads, memories: session.memories.filter((memory) => !isCurrentQuarterDialogueMemory(memory, session.quarter)) };
  return hashState(strategistState as SessionState);
}

interface PrefetchEntry {
  readonly controller: AbortController;
  readonly promise: Promise<NpcActionBundle | null>;
  /** Settles a job that never reached the client request. Safe after dispatch too. */
  readonly cancel: () => void;
}

/** Replaced wholesale on every `startStrategistPrefetch` call — never grows past one quarter. */
let cache = new Map<string, PrefetchEntry>();
let prefetchRunning = false;
const prefetchQueue: { readonly run: () => void; readonly cancel: () => void }[] = [];
function dispatchNextPrefetch(): void {
  if (prefetchRunning) return;
  const next = prefetchQueue.shift();
  if (next === undefined) return;
  prefetchRunning = true;
  next.run();
}

/*
 * The key is the state, the quarter and the company — not the briefing shape.
 * `previousWorld` decides only how much of that same state is sent (full
 * dossier or delta), so an entry started under either shape is a plan for
 * exactly this state and is safe to reuse.
 */
function keyOf(stateHash: string, quarter: number, companyId: string): string {
  return `${stateHash}:${quarter}:${companyId}`;
}

/**
 * Start (or continue) prefetching a live strategist call for each of
 * `companyIds`, in the order given.
 *
 * Idempotent per `(session, companyId)`: calling this again with the same
 * state and the same id — the ordinary case, since `provider.tsx` calls it
 * once per quarter-open and the id list does not otherwise change mid-quarter
 * — reuses the in-flight or settled entry rather than firing a second request.
 * A call whose key is *not* in the new set (a different quarter, a different
 * session, a rival that fell out of this quarter's priority order) is
 * aborted, and the cache is replaced with exactly the new set.
 */
export function startStrategistPrefetch(session: SessionState, companyIds: readonly string[], options: StrategistBriefingOptions = { previousWorld: null }): void {
  const stateHash = strategistStateHash(session);
  const next = new Map<string, PrefetchEntry>();

  for (const companyId of companyIds) {
    const key = keyOf(stateHash, session.quarter, companyId);
    const existing = cache.get(key);
    if (existing !== undefined) {
      next.set(key, existing);
      continue;
    }
    const input = buildNpcStrategistInput(session, companyId, options);
    if (input === null) continue;
    const controller = new AbortController();
    let cancel = (): void => undefined;
    const promise = new Promise<NpcActionBundle | null>((resolve) => {
      let settled = false;
      const settle = (value: NpcActionBundle | null): void => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      cancel = () => settle(null);
      prefetchQueue.push({ cancel, run: () => {
        if (controller.signal.aborted) { prefetchRunning = false; settle(null); dispatchNextPrefetch(); return; }
        void requestNpcBundle(input, undefined, controller.signal)
          .catch(() => null).then((value) => { prefetchRunning = false; settle(value); dispatchNextPrefetch(); });
      }});
      dispatchNextPrefetch();
    });
    next.set(key, { controller, promise, cancel });
  }

  for (const [key, entry] of cache) {
    if (!next.has(key)) { entry.controller.abort(); entry.cancel(); }
  }
  cache = next;
}

/** True when a prefetch — in flight or already settled — exists for this exact state and company. */
export function hasStrategistPrefetch(session: SessionState, companyId: string): boolean {
  return cache.has(keyOf(strategistStateHash(session), session.quarter, companyId));
}

/**
 * The prefetched bundle for this state and company, or null when there is no
 * entry (never prefetched, or the request itself came back empty).
 *
 * Callers that want to bound how long they wait for a not-yet-settled entry
 * should race this against their own deadline — this function itself never
 * times out, matching every other transport promise in the codebase.
 */
export function takeStrategistPrefetch(session: SessionState, companyId: string): Promise<NpcActionBundle | null> {
  const entry = cache.get(keyOf(strategistStateHash(session), session.quarter, companyId));
  return entry === undefined ? Promise.resolve(null) : entry.promise;
}

/**
 * Abandon every prefetch in flight and empty the cache.
 *
 * Called whenever the session a prefetch was started for stops being the live
 * one — a new game, a load, or the player turning the live model off — so a
 * background call for a session nobody is looking at any more does not keep a
 * subprocess alive or resolve into a cache nothing will ever read.
 */
export function clearStrategistPrefetch(): void {
  for (const entry of cache.values()) { entry.controller.abort(); entry.cancel(); }
  cache = new Map();
  for (const entry of prefetchQueue.splice(0)) entry.cancel();
}
