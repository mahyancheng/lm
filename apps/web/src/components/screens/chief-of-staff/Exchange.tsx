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
 * on the thirteen and the mandatory line all behave exactly as they do
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

export function Exchange({ entry, founder, startYear }: ExchangeProps): React.JSX.Element {
  return (
    <div className="flex flex-col gap-3">
      {/* --- what you said -------------------------------------------------- */}
      <div className="flex min-w-0 items-start justify-end gap-2.5">
        {/* `min-w-0` is load-bearing: without it a long instruction pushes the
            row past the column and the whole page scrolls sideways at 390px. */}
        <SpeechCard side="right" className="min-w-0 max-w-[85%]" bodyClassName="px-3 py-2">
          <p className="text-[12.5px] leading-relaxed whitespace-pre-wrap text-ink">{entry.message}</p>
        </SpeechCard>
        <Portrait characterId={founder.id} role={founder.role} size="md" isPlayer decorative className="mt-1" />
      </div>

      {/* --- what came back ------------------------------------------------- */}
      <div className="flex items-start gap-2.5">
        <Portrait
          characterId={CHIEF_OF_STAFF.id}
          name={CHIEF_OF_STAFF.name}
          role={CHIEF_OF_STAFF.role}
          size="lg"
          idle
          className="mt-1"
          mood={chiefMood(entry.interpretation.confidence, entry.fallback)}
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
              {entry.fallback ? <Tag tone="loss">No model reached</Tag> : null}
            </>
          }
        >
          <InterpretationCard entry={entry} startYear={startYear} variant="speech" />
        </SpeechCard>
      </div>
    </div>
  );
}
