'use client';

/**
 * The Frontier Times — the narrator's prose, set as a front page.
 *
 * The masthead is fictional and belongs to the game world. Everything under it
 * is the narrator's output and nothing else: its only input is the committed
 * lines below, it may not introduce a number it was not given, and it decides
 * nothing. When the model is unavailable or declines, the page still prints —
 * with the report's own headline and a plain note that there is no wire copy
 * this quarter. The lines beneath the card are the record either way.
 */

import type { NarratorOutput } from '@frontier/contracts';
import { AiLabel } from '@/components/ui';

export interface NewspaperProps {
  /** The quarter this edition covers, already formatted. */
  readonly edition: string;
  /** The report's own headline: the deterministic front page. */
  readonly reportHeadline: string;
  /** The narrator's copy, when there is any. */
  readonly narrative: NarratorOutput | null;
  /** True while the request is in flight. */
  readonly narrating: boolean;
  /** Ledger range the edition is drawn from. */
  readonly sequenceFrom: number;
  readonly sequenceTo: number;
}

export function Newspaper({
  edition,
  reportHeadline,
  narrative,
  narrating,
  sequenceFrom,
  sequenceTo,
}: NewspaperProps): React.JSX.Element {
  const headline = narrative?.headline ?? reportHeadline;

  return (
    <article className="panel-surface animate-pop-in overflow-hidden">
      {/* --- masthead ------------------------------------------------------ */}
      <header className="border-b-2 border-ink px-4 pt-4 pb-2 sm:px-6">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-b border-hair pb-1.5">
          <span className="label-caps-faint">{edition}</span>
          <span className="figure text-[10px] text-ink-faint">
            Ledger {sequenceFrom}–{sequenceTo}
          </span>
        </div>
        <h2 className="mt-2 text-center font-mono text-[clamp(18px,6.4vw,32px)] leading-none font-bold tracking-[0.14em] text-ink uppercase">
          The Frontier Times
        </h2>
        <p className="mt-1.5 text-center text-[9px] font-semibold tracking-[0.22em] text-ink-faint uppercase">
          Printed from the committed ledger · No number invented
        </p>
      </header>

      {/* --- the front page ------------------------------------------------ */}
      <div className="px-4 py-4 sm:px-6">
        <h3 className="text-[clamp(16px,4.6vw,22px)] leading-tight font-extrabold text-balance text-ink">{headline}</h3>

        <div className="mt-2 flex flex-wrap items-center gap-2 border-y border-hair py-1.5">
          <span className="label-caps-faint">
            {narrative === null ? 'Wire desk' : `Filed in a ${narrative.tone} register`}
          </span>
          {narrative === null ? null : <AiLabel />}
        </div>

        {narrative !== null ? (
          <p className="mt-3 text-[12.5px] leading-relaxed whitespace-pre-wrap text-ink-dim sm:columns-2 sm:gap-6">
            {narrative.body}
          </p>
        ) : narrating ? (
          <p className="animate-pulse-soft mt-3 text-[12px] text-ink-faint">The presses are running — asking for colour over the committed lines…</p>
        ) : (
          <p className="mt-3 text-[12px] leading-relaxed text-ink-dim">
            No wire copy this quarter. The headline above is the report's own, and the sections below are the record: every line opens the
            ledger rows behind it.
          </p>
        )}

        <p className="mt-3 border-t border-hair pt-2 text-[10px] leading-relaxed text-ink-faint">
          The narrator's only input is the committed lines below. It may not introduce a number that was not supplied, and it decides
          nothing. The Frontier Times is a fiction of this world.
        </p>
      </div>
    </article>
  );
}
