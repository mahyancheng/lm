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
 */

import { useCallback, useEffect, useState } from 'react';
import type { SimEvent } from '@frontier/contracts';
import { requestChiefOfStaff } from '@/lib/llm/client';
import { PLAYER_ID, buildChiefOfStaffInput, useGame, useSession } from '@/lib/game';
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
  /** Ask. `screen` is the route the founder asked from, so "this screen" means something. */
  send(message: string, screen?: string): Promise<void>;
  clear(): void;
}

export function useChiefOfStaff(): ChiefOfStaffThread {
  const session = useSession();
  const { lastOutcome } = useGame();
  const [entries, setEntries] = useState<TranscriptEntry[]>([]);
  const [sending, setSending] = useState(false);

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

      let interpretation = null;
      try {
        // The key names the seat, not just the session: one shared key would
        // resume one Claude thread for every player in the session, and this
        // prompt carries the player's whole private company briefing.
        interpretation = await requestChiefOfStaff(input, {
          sessionId: session.sessionId,
          playerId: PLAYER_ID,
          conversationId: 'main',
        });
      } catch {
        interpretation = null;
      }

      const entry: TranscriptEntry = {
        id: `${session.sessionId}:q${session.quarter}:${current.length}`,
        quarter: session.quarter,
        message: text,
        interpretation: interpretation ?? echoFallback(text),
        fallback: interpretation === null,
      };
      // `appendTranscript` notifies every subscriber, so both surfaces update.
      appendTranscript(session.sessionId, entry);
      setSending(false);
    },
    [lastOutcome, sending, session],
  );

  const clear = useCallback(() => {
    clearTranscript(session.sessionId);
  }, [session.sessionId]);

  return { entries, sending, send, clear };
}
