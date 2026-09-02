'use client';

/**
 * Founding a company, as a conversation.
 *
 * The old New Game panel was a form: two text fields, five background cards, a
 * seed and a difficulty. It could not ask a sixth question, and world 2 has
 * two more — which sector, and which region — with six answers each. Thirty-six
 * combinations do not fit in a grid on a 390px phone, and they do not need to:
 * a founder can say "a robotics startup in East Asia, call it Kestrel
 * Dynamics" in one breath.
 *
 * So the Chief of Staff asks, and the founder answers **either way**:
 *
 * - **Tapping** a chip. Every chip is a full-width row with an icon, a label
 *   and a one-line pitch, and clears 44px. This is the whole flow on a phone,
 *   and it needs no model at all.
 * - **Typing** anything. Every message is read by the deterministic parser in
 *   `lib/game/setupChat.ts`, and additionally by the setup-interpreter role
 *   when a live model is configured — merged *underneath* the parser, so a slot
 *   the founder stated in so many words is never reinterpreted.
 *
 * What it understood is on screen the whole time as editable chips: tap one to
 * take it back and be asked again. Nothing is founded until the founder taps
 * the button that names their own company, and what that button hands over has
 * been through `NewGameSetupSchema` — the same validation the engine would do
 * to it anyway.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { NewGameSetup, SetupProposal } from '@frontier/contracts';
import { AiLabel, Icon, Tag } from '@/components/ui';
import { isIconName } from '@/components/ui/icons';
import { CHIEF_OF_STAFF, Portrait, SpeechCard } from '@/components/scenes/people';
import { requestSetupProposal } from '@/lib/llm/client';
import {
  EMPTY_SETUP_PROPOSAL,
  SETUP_CONFIRM_BELOW,
  SETUP_EXAMPLES,
  SETUP_NAME_MAX,
  SETUP_OPENING,
  applySetupChoice,
  clearSetupSlot,
  mergeSetupProposals,
  nextSetupSlot,
  parseSetupMessage,
  setupAcknowledgement,
  setupFromProposal,
  setupQuestion,
  setupQuickReplies,
  setupSummaryLine,
  setupUnderstood,
  type SetupQuickReply,
} from '@/lib/game';

/** One turn of the founding conversation. Ids are positional, never a clock. */
interface SetupMessage {
  readonly id: string;
  readonly speaker: 'chief_of_staff' | 'player';
  readonly text: string;
}

export interface SetupChatProps {
  /** True while a replay or a slot load is in flight: founding would race it. */
  readonly busy: boolean;
  readonly llmAvailable: boolean;
  /** Called with a setup that has already been through `NewGameSetupSchema`. */
  readonly onFound: (setup: NewGameSetup) => void;
  /** The advanced fold — seed and difficulty — rendered under the composer. */
  readonly advanced?: ReactNode;
}

const OPENING: SetupMessage = { id: 'm0', speaker: 'chief_of_staff', text: SETUP_OPENING };

export function SetupChat({ busy, llmAvailable, onFound, advanced }: SetupChatProps): React.JSX.Element {
  const [messages, setMessages] = useState<readonly SetupMessage[]>([OPENING]);
  const [proposal, setProposal] = useState<SetupProposal>(EMPTY_SETUP_PROPOSAL);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const transcript = useRef<HTMLDivElement | null>(null);

  const slot = nextSetupSlot(proposal);
  const chips = slot === null ? [] : setupQuickReplies(slot, proposal);
  const understood = setupUnderstood(proposal);
  const setup = useMemo(() => setupFromProposal(proposal), [proposal]);
  const uncertain = setup !== null && proposal.confidence < SETUP_CONFIRM_BELOW;

  // The newest turn, not the whole panel: scrolling the page on a phone every
  // time a chip is tapped would take the chips themselves off screen.
  useEffect(() => {
    const node = transcript.current;
    if (node !== null) node.scrollTop = node.scrollHeight;
  }, [messages.length, sending]);

  /** Append the founder's turn and the Chief of Staff's answer to it. */
  function respond(said: string, before: SetupProposal, after: SetupProposal): void {
    const learned = setupAcknowledgement(before, after);
    const asking = nextSetupSlot(after);
    const reply =
      asking === null
        ? `${learned === null ? '' : `${learned} `}${setupSummaryLine(after)} Say the word and I will open the doors.`
        : learned === null
          ? `I did not catch that. ${setupQuestion(asking)}`
          : `${learned} ${setupQuestion(asking)}`;

    setMessages((current) => [
      ...current,
      { id: `m${current.length}`, speaker: 'player', text: said },
      { id: `m${current.length + 1}`, speaker: 'chief_of_staff', text: reply },
    ]);
    setProposal(after);
  }

  /** A tap needs no interpretation, so it never reaches a model. */
  function tap(chip: SetupQuickReply): void {
    if (busy || sending) return;
    respond(chip.says, proposal, applySetupChoice(proposal, chip.slot, chip.value));
  }

  /**
   * A typed message, read twice.
   *
   * The deterministic parse happens first and unconditionally; the model's
   * reading is merged underneath it and only when one is configured. A model
   * that answers null — no transport, a refusal, a timeout — costs the founder
   * one more direct question and nothing else.
   */
  async function send(): Promise<void> {
    const text = draft.trim();
    if (text.length === 0 || sending || busy) return;
    setSending(true);
    setDraft('');

    const before = proposal;
    const deterministic = parseSetupMessage(text, before);
    let after = deterministic;

    if (llmAvailable) {
      try {
        const history = messages.map((message) => ({
          role: message.speaker === 'player' ? ('player' as const) : ('chief_of_staff' as const),
          text: message.text,
        }));
        const read = await requestSetupProposal(text, history, before);
        if (read !== null) after = mergeSetupProposals(deterministic, read);
      } catch {
        // An outage is not an error condition here: the deterministic reading
        // already stands, and the conversation carries on with it.
        after = deterministic;
      }
    }

    respond(text, before, after);
    setSending(false);
  }

  function found(): void {
    if (setup === null || busy) return;
    onFound(setup);
  }

  const chiefSpeaker = (
    <>
      <span className="text-[12px] font-semibold text-ink">{CHIEF_OF_STAFF.name}</span>
      <span className="text-[10px] text-ink-faint">{CHIEF_OF_STAFF.title}</span>
      {llmAvailable ? <AiLabel /> : null}
    </>
  );

  return (
    <div className="flex min-w-0 flex-col gap-3">
      {/* --- the conversation --------------------------------------------- */}
      <div ref={transcript} className="flex max-h-[46dvh] min-w-0 flex-col gap-3 overflow-y-auto pr-0.5">
        {messages.map((message) =>
          message.speaker === 'player' ? (
            <div key={message.id} className="flex min-w-0 items-start justify-end gap-2.5">
              <SpeechCard side="right" className="min-w-0 max-w-[85%]" bodyClassName="px-3 py-2">
                <p className="text-[12.5px] leading-relaxed whitespace-pre-wrap text-ink">{message.text}</p>
              </SpeechCard>
            </div>
          ) : (
            <div key={message.id} className="flex min-w-0 items-start gap-2.5">
              <Portrait
                characterId={CHIEF_OF_STAFF.id}
                name={CHIEF_OF_STAFF.name}
                role={CHIEF_OF_STAFF.role}
                size="md"
                idle
                mood="content"
                ring="brand"
                className="mt-1"
                decorative
              />
              <SpeechCard className="min-w-0 flex-1" bodyClassName="px-3 py-2.5" speaker={chiefSpeaker}>
                <p className="text-[12.5px] leading-relaxed text-ink-dim">{message.text}</p>
              </SpeechCard>
            </div>
          ),
        )}

        {sending ? (
          <div className="flex items-center gap-2 pl-11">
            <span className="animate-pulse-soft size-1.5 rounded-pill bg-brand" />
            <span className="animate-pulse-soft stagger-2 size-1.5 rounded-pill bg-brand" />
            <span className="animate-pulse-soft stagger-4 size-1.5 rounded-pill bg-brand" />
            <span className="text-[11px] text-ink-faint">Reading that back…</span>
          </div>
        ) : null}
      </div>

      {/* --- what it understood, editable ---------------------------------- */}
      {understood.length > 0 ? (
        <div className="flex flex-col gap-1.5 border-t border-hair pt-3">
          <span className="label-caps-faint">What I have so far — tap to change</span>
          <ul className="flex flex-wrap gap-1.5">
            {understood.map((row) => (
              <li key={row.slot}>
                <button
                  type="button"
                  className="icon-knockout-wash press-pop tap-target flex items-center gap-1.5 rounded-pill border border-brand bg-brand-wash px-2.5 text-[11.5px] font-semibold text-ink"
                  onClick={() => setProposal(clearSetupSlot(proposal, row.slot))}
                  disabled={busy || sending}
                  aria-label={`Change ${row.label}: ${row.value}`}
                >
                  <Icon name={isIconName(row.icon) ? row.icon : 'check'} size={14} accent="brand" />
                  <span className="min-w-0 truncate">{row.value}</span>
                  <Icon name="close" size={12} accent="current" className="text-ink-faint" />
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* --- the chips for the open question -------------------------------- */}
      {chips.length > 0 ? (
        <ul className="grid gap-2 sm:grid-cols-2">
          {chips.map((chip) => (
            <li key={chip.value}>
              <button
                type="button"
                className="icon-knockout-panel press-pop flex min-h-11 w-full items-center gap-2.5 rounded-card border border-hair bg-raised p-2.5 text-left hover:border-brand"
                onClick={() => tap(chip)}
                disabled={busy || sending}
              >
                <Icon name={isIconName(chip.icon) ? chip.icon : 'building'} size={18} accent="brand" className="shrink-0" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12.5px] font-bold text-ink">{chip.label}</span>
                  <span className="block truncate text-[10.5px] text-ink-faint">{chip.hint}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {/* --- ready to found -------------------------------------------------- */}
      {setup !== null ? (
        <div className="animate-rise rounded-card border border-brand bg-brand-wash p-3">
          <p className="text-[12.5px] leading-relaxed text-ink">{setupSummaryLine(proposal)}</p>
          {uncertain ? (
            <p className="mt-1.5 text-[11px] leading-relaxed text-ink-dim">
              I am not certain I read all of that correctly — check the chips above before we open the doors.
            </p>
          ) : null}
          <button
            type="button"
            className="icon-knockout-brand btn btn-primary tap-target press-pop mt-2.5 w-full"
            onClick={found}
            disabled={busy}
          >
            <Icon name="plus" size={16} accent="inherit" />
            {`Found ${setup.companyName} — 2027 Q1`}
          </button>
        </div>
      ) : null}

      {/* --- the composer ---------------------------------------------------- */}
      <div className="flex flex-col gap-2 border-t border-hair pt-3">
        <div className="flex items-end gap-2">
          <textarea
            className="field min-w-0 flex-1"
            rows={2}
            maxLength={400}
            value={draft}
            placeholder={slot === null ? 'Change anything you like — "actually, call it Vantage Labs".' : 'A robotics startup in East Asia, call it Kestrel Dynamics.'}
            aria-label="Tell the Chief of Staff what you want to build"
            disabled={busy || sending}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                void send();
              }
            }}
          />
          <button
            type="button"
            className="btn tap-target press-pop shrink-0"
            disabled={busy || sending || draft.trim().length === 0}
            onClick={() => void send()}
          >
            <Icon name="chevronRight" size={16} accent="brand" />
            {sending ? 'Reading…' : 'Say it'}
          </button>
        </div>

        {messages.length === 1 ? (
          <ul className="flex flex-col gap-1.5">
            {SETUP_EXAMPLES.map((example) => (
              <li key={example}>
                <button
                  type="button"
                  className="icon-knockout-panel press-pop flex min-h-11 w-full items-center gap-2 rounded-chip border border-hair bg-panel px-3 py-2 text-left text-[11.5px] leading-snug text-ink-dim hover:border-hair-strong hover:text-ink"
                  onClick={() => setDraft(example)}
                  disabled={busy || sending}
                >
                  <Icon name="chat" size={15} accent="inherit" className="text-ink-faint" />
                  <span className="min-w-0 flex-1">{example}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          {llmAvailable ? (
            <Tag tone="gain" dot>
              Read by a model
            </Tag>
          ) : (
            <Tag tone="neutral" dot>
              Read by keyword
            </Tag>
          )}
          <span className="min-w-0 flex-1 text-[10.5px] leading-relaxed text-ink-faint">
            {llmAvailable
              ? `Anything you tap is taken exactly as tapped; anything you type is read by the model and by the keyword parser, and the parser wins. Names are capped at ${SETUP_NAME_MAX} characters.`
              : 'No model configured, so I read what you type by keyword — tapping is exact either way, and the whole game plays in full.'}
          </span>
        </div>
      </div>

      {advanced === undefined ? null : <div className="border-t border-hair pt-3">{advanced}</div>}
    </div>
  );
}
