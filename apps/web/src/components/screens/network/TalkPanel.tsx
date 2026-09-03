'use client';

/**
 * A conversation with one character.
 *
 * The character-dialogue role already existed — `POST /api/llm/character`, a
 * `CharacterUtteranceContext` in, a zod-validated `CharacterReply` out — and no
 * screen had ever opened it. This is the client for it, and it is deliberately
 * small: a thread, a box, a send button.
 *
 * Two boundaries the panel keeps:
 *
 * - **A reply is not a state write.** `CharacterReply` carries relationship
 *   deltas, a memory draft and sometimes a `ConditionalCommitment`. None of it
 *   is applied here. Talking produces words; a commitment becomes real through
 *   the action the conversation was about, and the engine is the only thing
 *   that moves a number.
 * - **The model is never load-bearing.** `requestCharacterReply` resolves to
 *   null whenever no transport is configured or anything at all goes wrong, and
 *   the thread continues on `offlineReply` — in register, carrying no
 *   commitment. The panel says which of the two the player is reading.
 */

import { useEffect, useRef, useState } from 'react';
import type { Character, CharacterUtteranceContext, Memory, Relationship, SessionState } from '@frontier/contracts';
import { Icon, SectionHeading, Tag, cx } from '@/components/ui';
import { PLAYER_ID } from '@/lib/game';
import { requestCharacterReply } from '@/lib/llm/client';
import { offlineReply, publicFactsFor, type DialogueTurn } from './actions';

/** Turns kept on screen and sent as history. Enough for the thread to have a memory. */
export const MAX_TURNS = 12;

/** Openers, so a first tap is one tap rather than a blank box. */
const PROMPTS: readonly string[] = [
  'What would it take for you to back us?',
  'What do you make of where this market is going?',
  'Who else should I be talking to?',
];

export interface TalkPanelProps {
  readonly session: SessionState;
  readonly target: Character;
  readonly selfId: string;
  /** How the target regards the player. Their side of the relationship. */
  readonly inbound: Relationship | null;
  /** How the player regards the target. */
  readonly outbound: Relationship | null;
  /** What the target remembers about the player — their context, never rendered. */
  readonly theirMemories: readonly Memory[];
  /** Why this conversation is permitted at all, in the engine's own words. */
  readonly accessBasis: string;
}

export function TalkPanel({
  session,
  target,
  selfId,
  inbound,
  outbound,
  theirMemories,
  accessBasis,
}: TalkPanelProps): React.JSX.Element {
  const [turns, setTurns] = useState<readonly DialogueTurn[]>([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [offline, setOffline] = useState(false);
  const endRef = useRef<HTMLDivElement | null>(null);

  // A new person is a new thread. The drawer keys this panel on the character
  // id as well, so this only fires when the same mounted panel changes subject.
  useEffect(() => {
    setTurns([]);
    setDraft('');
    setOffline(false);
  }, [target.id]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'nearest' });
  }, [turns]);

  async function send(text: string): Promise<void> {
    const message = text.trim();
    if (message.length === 0 || sending) return;
    const asked: DialogueTurn = { speakerId: selfId, text: message };
    const history = [...turns, asked].slice(-MAX_TURNS);
    setTurns(history);
    setDraft('');
    setSending(true);

    const context: CharacterUtteranceContext = {
      character: target,
      relationship: inbound,
      counterpartRelationship: outbound,
      memories: theirMemories.slice(0, 6),
      topic: message.slice(0, 200),
      gameFacts: publicFactsFor(session, target),
      conversationHistory: history.map((turn) => ({ speakerId: turn.speakerId, text: turn.text.slice(0, 600) })),
      accessBasis,
      pendingProposalSummary: null,
    };

    let reply: string | null = null;
    try {
      const result = await requestCharacterReply(context, {
        sessionId: session.sessionId,
        playerId: PLAYER_ID,
        conversationId: target.id,
      });
      reply = result?.text ?? null;
    } catch {
      // The client never throws at a screen. A model failure is a degraded
      // conversation, not a broken one.
      reply = null;
    }

    const spoken = reply ?? offlineReply(target, inbound?.trust ?? null, inbound?.hostility ?? null, message.slice(0, 120));
    setOffline(reply === null);
    setTurns((current) => [...current, { speakerId: target.id, text: spoken }].slice(-MAX_TURNS));
    setSending(false);
  }

  return (
    <div>
      <SectionHeading rule>Conversation</SectionHeading>

      {turns.length === 0 ? (
        <p className="mt-2 text-[12.5px] leading-relaxed text-ink-dim">
          {target.name} answers from their traits, their standing and what they remember about you. Nothing said here moves a number: a
          conversation produces words, and sometimes a commitment you then act on.
        </p>
      ) : (
        <ul className="mt-2 flex max-h-72 flex-col gap-2 overflow-y-auto">
          {turns.map((turn, index) => (
            <li
              key={`${turn.speakerId}-${index}`}
              className={cx(
                'rounded-card px-3 py-2 text-[12.5px] leading-relaxed',
                turn.speakerId === selfId ? 'ml-6 bg-brand-wash text-ink' : 'mr-6 raised-surface text-ink-dim',
              )}
            >
              {turn.speakerId === selfId ? null : (
                <div className="label-caps-faint mb-1">{target.name}</div>
              )}
              {turn.text}
            </li>
          ))}
          <div ref={endRef} />
        </ul>
      )}

      {turns.length === 0 ? (
        <ul className="mt-2 flex flex-wrap gap-1.5">
          {PROMPTS.map((prompt) => (
            <li key={prompt}>
              <button
                type="button"
                className="btn tap-target text-[11px]"
                disabled={sending}
                onClick={() => {
                  void send(prompt);
                }}
              >
                {prompt}
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="mt-2 flex items-end gap-2">
        <label className="block flex-1">
          <span className="sr-only">Message {target.name}</span>
          <textarea
            className="field text-[13px]"
            rows={2}
            maxLength={600}
            value={draft}
            placeholder={`Say something to ${target.name.split(' ')[0] ?? target.name}…`}
            onChange={(event) => setDraft(event.target.value)}
          />
        </label>
        <button
          type="button"
          className="btn btn-primary tap-target icon-knockout-brand shrink-0"
          disabled={sending || draft.trim().length === 0}
          onClick={() => {
            void send(draft);
          }}
        >
          <Icon name="chat" size={15} accent="inherit" />
          {sending ? 'Waiting' : 'Send'}
        </button>
      </div>

      {offline && turns.length > 0 ? (
        <div className="mt-1.5">
          <Tag tone="neutral">Deterministic reply — no model available</Tag>
        </div>
      ) : null}
    </div>
  );
}
