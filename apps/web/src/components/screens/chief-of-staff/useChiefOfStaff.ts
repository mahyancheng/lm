'use client';

/**
 * One thread, two surfaces.
 *
 * The Chief of Staff now lives in a drawer reachable from every screen *and*
 * on its own full-height screen. Both are the same conversation, so both go
 * through this hook: it owns the transcript subscription, the send, and the
 * deterministic path when the route answers nothing.
 *
 * What it does **not** own is queueing. Approving an action is a per-row human
 * step on the interpretation card, and the confirmation gate on the fourteen is
 * enforced there and again by the engine. Nothing about being reachable from
 * everywhere makes a binding action easier to reach than it was.
 *
 * ## Progressive answer
 *
 * A message produces *two* requests, raced rather than chained: an instant
 * offline preview (`requestChiefOfStaffQuick`, pure arithmetic, no queue) and
 * the real model call (`requestChiefOfStaff`, up to `CHIEF_OF_STAFF_TIMEOUT_MS`
 * on the Pi). The preview lands first, almost always inside a couple of
 * hundred milliseconds, and is appended to the transcript immediately — marked
 * `quick: true` — so the founder is reading a real, arithmetic-grounded answer
 * before they would otherwise have seen the first frame of a spinner. When the
 * model call settles, the **same transcript entry** is updated in place
 * (`replaceTranscriptEntry`) rather than a second one appended: one exchange,
 * one row, upgraded once. If the model call fails outright, the preview simply
 * stays as the final answer, now labelled with why (`failureReason`).
 *
 * `sending` still gates the composer for the whole exchange — asking a second
 * question before the first has resolved would need a second Claude session
 * resume racing the first one on the *same* conversation key, which is not
 * safe to allow — but it is no longer a bare wait: `elapsedSeconds` ticks once
 * a second for a live "thinking · 37s" counter, and `cancel()` lets the founder
 * give up on the model call without losing the preview already on screen.
 *
 * ## Sourcing, in exactly two turns
 *
 * "Can I buy a small data centre" is not answerable from the dossier — the
 * dossier is one company and that is a question about the market. So a reply may
 * come back as `mode: 'research'` with a list of lookups, and this hook runs
 * them **here**, on the client, because in demo mode the client is where
 * canonical state lives: `runLookups` is a pure function of the session, exported
 * by the engine, and the route holds no game state to run it against.
 *
 * The findings then go back on a second POST under the same conversation key,
 * and that turn is the answer. Two turns, never three: a turn carrying findings
 * has research mode closed to it by the composer and by the gateway's policy,
 * and this hook does not loop either — if a second research reply somehow
 * arrives, it is shown as what it is rather than sent round again.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { LookupResult, SimEvent } from '@frontier/contracts';
import { runLookups } from '@frontier/simulation';
import { type ChiefOfStaffAttempt, requestChiefOfStaff, requestChiefOfStaffQuick } from '@/lib/llm/client';
import { PLAYER_ID, buildChiefOfStaffInput, useActiveCompany, useGame, useSession } from '@/lib/game';
import {
  appendTranscript,
  clearTranscript,
  echoFallback,
  historyOf,
  readTranscript,
  replaceTranscriptEntry,
  subscribeTranscript,
  type TranscriptEntry,
} from './transcript';

export interface ChiefOfStaffThread {
  readonly entries: readonly TranscriptEntry[];
  readonly sending: boolean;
  /**
   * The lookup kinds currently being run, or null when nothing is being sourced.
   * The drawer shows "Sourcing… (compute market, own position)" from this.
   */
  readonly sourcing: readonly string[] | null;
  /**
   * Seconds since the current send began, ticking once a second while
   * `sending` is true and reset to 0 once it settles. Drives the "thinking ·
   * 37s" counter — a live number in place of a spinner nobody can read.
   */
  readonly elapsedSeconds: number;
  /** True only once the model call is actually in flight and abortable — not during the near-instant quick preview. */
  readonly cancellable: boolean;
  /** Ask. `screen` is the route the founder asked from, so "this screen" means something. */
  send(message: string, screen?: string): Promise<void>;
  /** Give up on the in-flight model call. The quick preview already on screen stays put. */
  cancel(): void;
  clear(): void;
}

export function useChiefOfStaff(): ChiefOfStaffThread {
  const session = useSession();
  const activeCompany = useActiveCompany();
  const { lastOutcome } = useGame();
  const [entries, setEntries] = useState<TranscriptEntry[]>([]);
  const [sending, setSending] = useState(false);
  const [sourcing, setSourcing] = useState<readonly string[] | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [cancellable, setCancellable] = useState(false);
  const controllerRef = useRef<AbortController | null>(null);

  // STAGE 5: the thread is per company, not per session — the switcher can
  // point this hook at a subsidiary, and that conversation's memory (and the
  // Claude session behind it, via `conversationId` below) must not blur into
  // the founding company's. See `transcript.ts`'s own note on this key.
  const threadKey = `${session.sessionId}:${activeCompany.id}`;

  // The transcript lives in the tab, not in game state: hydrate after mount so
  // the server render and the first client render agree, then follow every
  // change — including ones the other surface made.
  useEffect(() => {
    const sync = (): void => setEntries(readTranscript(threadKey));
    sync();
    return subscribeTranscript(sync);
  }, [threadKey]);

  // The visible "thinking · Ns" counter. Wall-clock and UI-only — never an
  // input to anything the engine reads — so `Date.now()` here is fine even
  // though it would not be inside the simulation.
  useEffect(() => {
    if (!sending) {
      setElapsedSeconds(0);
      return;
    }
    const start = Date.now();
    const id = setInterval(() => setElapsedSeconds(Math.floor((Date.now() - start) / 1000)), 1000);
    return () => clearInterval(id);
  }, [sending]);

  const cancel = useCallback((): void => {
    controllerRef.current?.abort();
  }, []);

  const send = useCallback(
    async (message: string, screen?: string): Promise<void> => {
      const text = message.trim();
      if (text.length === 0 || sending) return;
      setSending(true);
      setCancellable(false);

      const current = readTranscript(threadKey);
      const ledger: readonly SimEvent[] = lastOutcome?.events ?? [];
      const input = buildChiefOfStaffInput(session, text, historyOf(current), { screen, ledger, companyId: activeCompany.id });
      const entryId = `${threadKey}:q${session.quarter}:${current.length}`;

      // The key names the seat *and* the company, not just the session: one
      // shared key would resume one Claude thread for every player in the
      // session, and STAGE 5's switcher means the same seat now has several
      // companies' worth of private briefings — a subsidiary's conversation
      // must not resume, or leak into, the founding company's.
      const conversation = { sessionId: session.sessionId, playerId: PLAYER_ID, conversationId: activeCompany.id };

      // --- the instant preview: pure arithmetic, no queue, no model ---------
      const quick = await requestChiefOfStaffQuick(input, conversation).catch(() => null);
      const quickInterpretation = quick ?? echoFallback(text);
      appendTranscript(threadKey, {
        id: entryId,
        quarter: session.quarter,
        message: text,
        interpretation: quickInterpretation,
        fallback: true,
        quick: true,
      });

      // --- the real answer, cancellable, retried once on a transient failure -
      const runLive = async (payload: typeof input): Promise<ChiefOfStaffAttempt> => {
        const controller = new AbortController();
        controllerRef.current = controller;
        setCancellable(true);
        try {
          return await requestChiefOfStaff(payload, conversation, { signal: controller.signal });
        } finally {
          controllerRef.current = null;
          setCancellable(false);
        }
      };

      let attempt = await runLive(input);
      let findings: LookupResult[] = [];

      // One round of sourcing, and only one. The second call carries the same
      // message and the findings; a research reply to *that* is not sent round
      // again, it is shown.
      const requested = attempt.output?.mode === 'research' ? (attempt.output.lookups ?? []) : [];
      if (requested.length > 0) {
        setSourcing(requested.map((request) => request.kind));
        findings = runLookups(session, activeCompany.id, requested);
        const second = await runLive(
          buildChiefOfStaffInput(session, text, historyOf(current), { screen, ledger, findings, companyId: activeCompany.id }),
        );
        setSourcing(null);
        // A second call that failed leaves the research reply standing — the
        // founder still sees what was looked up — but the failure is still
        // recorded, so the drawer can say the second turn did not land.
        attempt = second.output !== null ? second : { output: attempt.output, failure: second.failure, fallback: attempt.fallback };
      }

      // A live answer that failed outright leaves the quick preview as the
      // final answer: `entry.fallback` was already true and stays true, and
      // `failureReason` says specifically why the model never weighed in.
      replaceTranscriptEntry(threadKey, entryId, {
        interpretation: attempt.output ?? quickInterpretation,
        fallback: attempt.output === null ? true : attempt.fallback,
        quick: false,
        ...(attempt.output === null && attempt.failure !== null ? { failureReason: attempt.failure } : {}),
        ...(findings.length > 0 ? { findings } : {}),
      });

      setSending(false);
    },
    [activeCompany, lastOutcome, sending, session, threadKey],
  );

  const clear = useCallback(() => {
    clearTranscript(threadKey);
  }, [threadKey]);

  return { entries, sending, sourcing, elapsedSeconds, cancellable, send, cancel, clear };
}
