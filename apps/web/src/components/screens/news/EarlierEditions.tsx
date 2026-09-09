'use client';

/**
 * Earlier editions: one line per past quarter — its label, its item count, its
 * lead headline. Tapping one prints that quarter's paper. This is what replaces
 * two hundred mounted cards and a forty-thousand-pixel scroll: the front page
 * is one edition, and the rest are a tap away.
 */

import { memo } from 'react';
import type { EditionSummary } from '@frontier/simulation';
import { quarterLabel } from '@frontier/contracts';
import { Icon, cx } from '@/components/ui';
import { SectionRule } from './pieces';

export interface EarlierEditionsProps {
  readonly editions: readonly EditionSummary[];
  /** The edition on the page now. */
  readonly current: number | null;
  readonly startYear: number;
  readonly onOpen: (quarter: number | null) => void;
}

export const EarlierEditions = memo(function EarlierEditions({ editions, current, startYear, onOpen }: EarlierEditionsProps): React.JSX.Element | null {
  const newest = editions[0]?.quarter ?? null;
  const others = editions.filter((edition) => edition.quarter !== current);
  if (others.length === 0) return null;
  return (
    <section aria-label="Earlier editions" className="flex flex-col" data-testid="earlier-editions">
      <SectionRule right={`${others.length}`}>{current !== null && current !== newest ? 'Other editions' : 'Earlier editions'}</SectionRule>
      <ul className="flex flex-col">
        {others.map((edition) => (
          <li key={edition.quarter} className="np-rule">
            <button
              type="button"
              onClick={() => onOpen(edition.quarter === newest ? null : edition.quarter)}
              className="tap-target flex w-full items-center gap-3 py-2.5 text-left"
            >
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="flex items-baseline gap-2">
                  <span className={cx('np-kicker', edition.quarter === newest ? 'text-brand' : 'text-ink')}>
                    {quarterLabel(startYear, edition.quarter)}
                    {edition.quarter === newest ? ' · Latest' : ''}
                  </span>
                  <span className="figure text-[10px] text-ink-faint">
                    {edition.count} item{edition.count === 1 ? '' : 's'}
                  </span>
                </span>
                <span className="np-deck truncate text-[13px] text-ink">{edition.leadHeadline ?? 'Nothing reached the record'}</span>
              </span>
              <Icon name="chevronRight" size={14} accent="current" />
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
});
