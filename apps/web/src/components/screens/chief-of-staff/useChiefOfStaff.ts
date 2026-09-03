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

import { useCallback, useEffect, useState } from 'react';
import type { ChiefOfStaffInterpretation, LookupResult, SimEvent } from '@frontier/contracts';
import { runLookups } from '@frontier/simulation';
import { requestChiefOfStaff } from '@/lib/llm/client';
import { PLAYER_ID, buildChiefOfStaffInput, usePlayerCompany, useGame, useSession } from '@/lib/game';
import {
  appendTranscript,
  clearTranscript,
  echoFallback,
  historyOf,
  readTranscript,
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
  /** Ask. `screen` is the route the founder asked from, so "this screen" means something. */
  send(message: string, screen?: string): Promise<void>;
  clear(): void;
}

export function useChiefOfStaff(): ChiefOfStaffThread {
  const session = useSession();
  const playerCompany = usePlayerCompany();
  const { lastOutcome } = useGame();
  const [entries, setEntries] = useState<TranscriptEntry[]>([]);
  const [sending, setSending] = useState(false);
  const [sourcing, setSourcing] = useState<readonly string[] | null>(null);

  // The transcript lives in the tab, not in game state: hydrate after mount so
  // the server render and the first client render agree, then follow every
  // change — including ones the other surface made.
  useEffect(() => {
    const sync = (): void => setEntries(readTranscript(session.sessionId));
    sync();
    return subscribeTranscript(sync);
  }, [session.sessionId]);

  const send = useCallback(
    async (message: string, screen?: string): Promise<void> => {
      const text = message.trim();
      if (text.length === 0 || sending) return;
      setSending(true);

      const current = readTranscript(session.sessionId);
      const ledger: readonly SimEvent[] = lastOutcome?.events ?? [];
      const input = buildChiefOfStaffInput(session, text, historyOf(current), { screen, ledger });

      // The key names the seat, not just the session: one shared key would
      // resume one Claude thread for every player in the session, and this
      // prompt carries the player's whole private company briefing.
      const conversation = { sessionId: session.sessionId, playerId: PLAYER_ID, conversationId: 'main' as const };
      const ask = async (payload: typeof input): Promise<ChiefOfStaffInterpretation | null> => {
        try {
          return await requestChiefOfStaff(payload, conversation);
        } catch {
          return null;
        }
      };

      let interpretation = await ask(input);
      let findings: LookupResult[] = [];

      // One round of sourcing, and only one. The second call carries the same
      // message and the findings; a research reply to *that* is not sent round
      // again, it is shown.
      const requested = interpretation?.mode === 'research' ? (interpretation.lookups ?? []) : [];
      if (requested.length > 0) {
        setSourcing(requested.map((request) => request.kind));
        findings = runLookups(session, playerCompany.id, requested);
        const second = await ask(
          buildChiefOfStaffInput(session, text, historyOf(current), { screen, ledger, findings }),
        );
        setSourcing(null);
        // A second call that failed leaves the first reply standing: the founder
        // still sees what was looked up, which is more than nothing.
        if (second !== null) interpretation = second;
      }

      const entry: TranscriptEntry = {
        id: `${session.sessionId}:q${session.quarter}:${current.length}`,
        quarter: session.quarter,
        message: text,
        interpretation: interpretation ?? echoFallback(text),
        fallback: interpretation === null,
        ...(findings.length > 0 ? { findings } : {}),
      };
      // `appendTranscript` notifies every subscriber, so both surfaces update.
      appendTranscript(session.sessionId, entry);
      setSending(false);
    },
    [lastOutcome, playerCompany, sending, session],
  );

  const clear = useCallback(() => {
    clearTranscript(session.sessionId);
  }, [session.sessionId]);

  return { entries, sending, sourcing, send, clear };
}
