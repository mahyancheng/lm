'use client';

/**
 * Quarter in review — the lead card of the feed.
 *
 * This used to be written over `lastOutcome.report`, the resolver's output for
 * the quarter that just resolved. `lastOutcome` is in-memory React state: it is
 * always null on a fresh page load, including an ordinary browser reload, so a
 * card built from it was genuinely gone every time a player reloaded the tab —
 * not flaky, just unconditionally absent whenever the resolver's own output was
 * not the thing sitting in memory a moment ago.
 *
 * The public record does not have that problem. `items` is projected fresh
 * from `SessionState` on every render — the same `projectPublicRecord` call the
 * feed itself uses — and `SessionState` is exactly what a reload restores. So
 * this card is built from `items` alone, never from `lastOutcome`: the same
 * quarter renders the same card whether it was resolved ten seconds ago or the
 * tab was just reloaded. That is the whole fix, not a workaround — there is no
 * second, richer path that only works before a reload.
 */

import type { PublicRecordItem } from '@frontier/contracts';
import { quarterLabel } from '@frontier/contracts';
import { EmptyState, Icon, Tag, cx } from '@/components/ui';
import { toneOfSentiment } from '@/components/screens/feed/FeedItem';

/** Cards worth a line in the review. The rest are still in the feed below it. */
const REVIEW_LINES = 8;

export interface QuarterInReviewProps {
  /** Every item the public record has for this seat, newest quarter first. */
  readonly items: readonly PublicRecordItem[];
  /** The quarter to review — the most recently resolved one, or null before any has. */
  readonly quarter: number | null;
  readonly startYear: number;
}

export function QuarterInReview({ items, quarter, startYear }: QuarterInReviewProps): React.JSX.Element {
  if (quarter === null) {
    return (
      <EmptyState
        icon="newspaper"
        compact
        title="No quarter has resolved yet"
        message="End a quarter from Command Centre and its review appears here."
      />
    );
  }

  // `items` is already sorted newest-quarter-first, then heaviest-first within
  // a quarter, so this slice is already in review order — nothing here re-sorts.
  const ofQuarter = items.filter((item) => item.quarter === quarter);

  if (ofQuarter.length === 0) {
    return (
      <EmptyState
        icon="newspaper"
        compact
        title="Nothing public that quarter"
        message={`${quarterLabel(startYear, quarter)} resolved with nothing that reached the public record — no event, no coverage, no filing, no post.`}
      />
    );
  }

  const lead = ofQuarter[0];
  const lines = ofQuarter.slice(0, REVIEW_LINES);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="label-caps-faint">{quarterLabel(startYear, quarter)}</span>
        <Tag tone="neutral">
          {ofQuarter.length} on the record
        </Tag>
      </div>

      {lead === undefined ? null : <p className="text-[14px] leading-snug font-semibold text-ink">{lead.headline}</p>}

      <ul className="flex flex-col">
        {lines.map((item) => {
          const tone = toneOfSentiment(item.tone);
          return (
            <li key={item.id} className="flex items-start justify-between gap-3 border-b border-hair/50 py-2 last:border-b-0">
              <span className="flex min-w-0 items-start gap-2">
                <span className={cx('mt-px shrink-0', `tone-${tone}`)}>
                  <Icon name={item.tone < 0 ? 'warning' : 'check'} size={13} accent="current" />
                </span>
                <span className="text-[13px] leading-snug text-ink-dim">{item.headline}</span>
              </span>
              {item.whyItMatters === null ? null : (
                <span className="figure shrink-0 text-[11px] font-semibold text-brand">{item.whyItMatters}</span>
              )}
            </li>
          );
        })}
      </ul>

      {ofQuarter.length <= REVIEW_LINES ? null : (
        <p className="text-[10px] text-ink-faint">
          {ofQuarter.length - REVIEW_LINES} more from this quarter in the feed below.
        </p>
      )}
    </div>
  );
}
