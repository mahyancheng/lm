'use client';

/**
 * One exchange, face to face.
 *
 * The player's instruction is their own turn, right-aligned, in their own hand.
 * What comes back is delivered *by somebody* — a face, a name, an AI label, and
 * a speech card — because an interpretation of your intent is a thing a person
 * hands you, not a thing a form emits.
 *
 * The card inside the speech card is the unchanged `InterpretationCard`: the
 * validator's verdict on every row, the per-row queueing, the confirmation gate
 * on the fourteen and the mandatory line all behave exactly as they do
 * elsewhere. Only the frame is different. Nothing about the conversational
 * framing may make a binding action easier to reach than it was — and it does
 * not: the same three steps, interpret → propose → confirm, in the same order.
 */

import type { Character } from '@frontier/contracts';
import { AiLabel, Tag } from '@/components/ui';
import { CHIEF_OF_STAFF, Portrait, SpeechCard, type PortraitMood } from '@/components/scenes/people';
import { InterpretationCard } from './InterpretationCard';
import type { TranscriptEntry } from './transcript';

export interface ExchangeProps {
  readonly entry: TranscriptEntry;
  readonly founder: Character;
  readonly startYear: number;
  /** Compact framing for the drawer: smaller portraits, no repeated chrome. */
  readonly dense?: boolean;
}

/** How a reply is labelled: an answer, advice, or an instruction carried out. */
const MODE_LABEL: Readonly<Record<TranscriptEntry['interpretation']['mode'], string>> = {
  answer: 'Answer',
  plan: 'Advice',
  act: 'Instruction',
};

/**
 * Whether there is a diff worth showing under the reply.
 *
 * A pure answer — no actions, no questions, nothing unsupported — is words, and
 * wrapping words in a control surface with an "approve" button under them would
 * invite a founder to approve a sentence.
 */
export function hasProposal(entry: TranscriptEntry): boolean {
  const { interpretedInstructions, questions, unsupportedRequests } = entry.interpretation;
  return interpretedInstructions.length > 0 || questions.length > 0 || unsupportedRequests.length > 0;
}

/**
 * How the Chief of Staff looks while handing this over.
 *
 * It reads the confidence they themselves reported, so the face and the meter
 * agree. A face that beams while its own confidence meter reads 0.3 would be
 * lying in the only register a cartoon has.
 */
export function chiefMood(confidence: number, fallback: boolean): PortraitMood {
  if (fallback) return 'guarded';
  if (confidence >= 0.9) return 'delighted';
  if (confidence >= 0.7) return 'content';
  if (confidence >= 0.4) return 'neutral';
  return 'guarded';
}

export function Exchange({ entry, founder, startYear, dense = false }: ExchangeProps): React.JSX.Element {
  const { interpretation } = entry;
  return (
    <div className="flex flex-col gap-3">
      {/* --- what you said -------------------------------------------------- */}
      <div className="flex min-w-0 items-start justify-end gap-2.5">
        {/* `min-w-0` is load-bearing: without it a long instruction pushes the
            row past the column and the whole page scrolls sideways at 390px. */}
        <SpeechCard side="right" className="min-w-0 max-w-[85%]" bodyClassName="px-3 py-2">
          <p className="text-[12.5px] leading-relaxed whitespace-pre-wrap text-ink">{entry.message}</p>
        </SpeechCard>
        <Portrait characterId={founder.id} role={founder.role} size={dense ? 'sm' : 'md'} isPlayer decorative className="mt-1" />
      </div>

      {/* --- what came back ------------------------------------------------- */}
      <div className="flex items-start gap-2.5">
        <Portrait
          characterId={CHIEF_OF_STAFF.id}
          name={CHIEF_OF_STAFF.name}
          role={CHIEF_OF_STAFF.role}
          size={dense ? 'md' : 'lg'}
          idle
          className="mt-1"
          mood={chiefMood(interpretation.confidence, entry.fallback)}
          ring={entry.fallback ? 'warn' : 'brand'}
        />
        <SpeechCard
          className="min-w-0 flex-1"
          bodyClassName="px-3 py-2.5"
          speaker={
            <>
              <span className="text-[12px] font-semibold text-ink">{CHIEF_OF_STAFF.name}</span>
              <span className="text-[10px] text-ink-faint">{CHIEF_OF_STAFF.title}</span>
              <AiLabel />
              <Tag tone={interpretation.mode === 'act' ? 'brand' : 'neutral'}>{MODE_LABEL[interpretation.mode]}</Tag>
              {entry.fallback ? <Tag tone="loss">No model reached</Tag> : null}
            </>
          }
        >
          {/* The words come first and stand alone. The diff below them is the
              control surface; a reply with nothing to approve shows none. */}
          <p className="text-[13px] leading-relaxed whitespace-pre-wrap text-ink">{interpretation.reply}</p>
          {hasProposal(entry) ? (
            <div className="mt-2.5">
              <InterpretationCard entry={entry} startYear={startYear} variant="speech" />
            </div>
          ) : null}
        </SpeechCard>
      </div>
    </div>
  );
}
