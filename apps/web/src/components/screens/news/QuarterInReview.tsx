'use client';

/**
 * Quarter in review.
 *
 * The narrator is optional colour over committed facts, and its only input is
 * the report the engine already produced. When no model is configured, or when
 * the call fails, or when it simply returns nothing, the strip renders the
 * committed lines directly — they are human-readable by construction, which is
 * why the narrator can be optional at all.
 *
 * `failure_mode` is an engine invariant: there is no spinner that never ends
 * and no state in which this component has nothing to show.
 */

import { useEffect, useState } from 'react';
import type { NarratorOutput, ResolutionReport } from '@frontier/contracts';
import { quarterLabel } from '@frontier/contracts';
import { EmptyState, Icon, Tag, cx, toneOfLine } from '@/components/ui';
import { requestNarrative } from '@/lib/llm/client';

const TONE_CHIP: Readonly<Record<NarratorOutput['tone'], 'gain' | 'neutral' | 'warn' | 'loss'>> = {
  triumphant: 'gain',
  steady: 'neutral',
  strained: 'warn',
  grim: 'loss',
};

export interface QuarterInReviewProps {
  readonly report: ResolutionReport | null;
  readonly startYear: number;
  readonly focusCompanyId: string;
  /** Whether a live model is configured. Decides whether to offer the narrator at all. */
  readonly modelAvailable: boolean;
}

export function QuarterInReview({ report, startYear, focusCompanyId, modelAvailable }: QuarterInReviewProps): React.JSX.Element {
  const [narrative, setNarrative] = useState<NarratorOutput | null>(null);
  const [asked, setAsked] = useState(false);

  useEffect(() => {
    setNarrative(null);
    setAsked(false);
    if (report === null || !modelAvailable) return;
    let cancelled = false;
    void requestNarrative(report, focusCompanyId).then((result) => {
      if (cancelled) return;
      setNarrative(result);
      setAsked(true);
    });
    return () => {
      cancelled = true;
    };
  }, [report, focusCompanyId, modelAvailable]);

  if (report === null) {
    return (
      <EmptyState
        icon="newspaper"
        compact
        title="No quarter has resolved in this tab"
        message="The review is written over the committed resolution report. End a quarter and it appears here."
      />
    );
  }

  /* --- the deterministic path: the committed lines themselves -------------- */
  const lines = report.phases
    .flatMap((phase) => phase.lines)
    .filter((line) => line.tone !== 'neutral' || line.deltaLabel !== null)
    .slice(0, 8);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="label-caps-faint">{quarterLabel(startYear, report.quarter)}</span>
        {narrative === null ? (
          <Tag tone="neutral">{modelAvailable && !asked ? 'Narrator working' : 'Committed lines'}</Tag>
        ) : (
          <Tag tone={TONE_CHIP[narrative.tone]} dot>
            {narrative.tone}
          </Tag>
        )}
      </div>

      <p className="text-[14px] leading-snug font-semibold text-ink">{narrative?.headline ?? report.headline}</p>

      {narrative === null ? null : (
        <div className="flex flex-col gap-2 border-l-2 border-brand/40 pl-3">
          {narrative.body
            .split(/\n{2,}/)
            .filter((paragraph) => paragraph.trim().length > 0)
            .map((paragraph, index) => (
              <p key={index} className="text-[13px] leading-relaxed text-ink-dim">
                {paragraph.trim()}
              </p>
            ))}
        </div>
      )}

      <ul className="flex flex-col">
        {lines.map((line, index) => {
          const tone = toneOfLine(line.tone);
          return (
            <li
              key={`${line.phase}_${index}`}
              className="flex items-start justify-between gap-3 border-b border-hair/50 py-2 last:border-b-0"
            >
              <span className="flex min-w-0 items-start gap-2">
                {/* A committed line either warns or it does not: the mark says
                    which, and the tone colours it. Never a typographic tick. */}
                <span className={cx('mt-px shrink-0', `tone-${tone}`)}>
                  <Icon name={line.tone === 'warning' ? 'warning' : 'check'} size={13} accent="current" />
                </span>
                <span className="text-[13px] leading-snug text-ink-dim">{line.text}</span>
              </span>
              {line.deltaLabel === null ? null : (
                <span className={cx('figure shrink-0 text-[11px]', `tone-${tone}`)}>{line.deltaLabel}</span>
              )}
            </li>
          );
        })}
      </ul>

      <p className="text-[10px] text-ink-faint">
        {narrative === null
          ? 'No narrator is configured, so the committed lines are shown directly. Every one of them references a ledger row.'
          : 'Narrated colour over committed facts. The lines below the paragraph are the facts themselves.'}
      </p>
    </div>
  );
}
