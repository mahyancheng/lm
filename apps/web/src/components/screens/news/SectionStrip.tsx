'use client';

/**
 * One row under the masthead: the five sections, "Mine", and "Filter".
 *
 * The sections are small caps on a hairline, the active one underlined in ink
 * — a newspaper's section strip, not a row of pills. It replaces the three
 * stacked filter rows: sector and company narrowing live behind the one
 * "Filter" word, in a sheet. Every control clears the 44px floor, and the
 * whole row is one fixed height so the layout budget holds.
 *
 * Five section words plus two controls run wider than a phone, so the tab list
 * scrolls inside itself — the page never does — with the active tab kept in
 * view and a fade at the edge to say there is more.
 */

import { memo, useEffect, useRef } from 'react';
import { Icon, cx } from '@/components/ui';
import { NEWS_SECTIONS, SECTION_LABEL, type NewsSection } from './layout';

/** The strip's height. With the masthead, under 120px. */
export const STRIP_HEIGHT_PX = 44;

/** The masthead and the strip together: the one budget the layout test checks. Must stay under this. */
export const NEWS_CHROME_BUDGET_PX = 120;

export interface SectionStripProps {
  readonly section: NewsSection;
  readonly onSection: (section: NewsSection) => void;
  readonly mine: boolean;
  readonly onMine: (mine: boolean) => void;
  /** How many narrowings are active behind the Filter word. */
  readonly filterCount: number;
  readonly onFilter: () => void;
  /** Offer the Filter control at all: a one-company, one-sector world has nothing to narrow by. */
  readonly filterable: boolean;
}

export const SectionStrip = memo(function SectionStrip({ section, onSection, mine, onMine, filterCount, onFilter, filterable }: SectionStripProps): React.JSX.Element {
  const listRef = useRef<HTMLDivElement | null>(null);

  // Keep the selected section in view when the list is wider than the row.
  useEffect(() => {
    const list = listRef.current;
    if (list === null) return;
    const active = list.querySelector<HTMLElement>('[aria-selected="true"]');
    if (active === null) return;
    const left = active.offsetLeft;
    const right = left + active.offsetWidth;
    if (left < list.scrollLeft) list.scrollTo({ left: Math.max(0, left - 8), behavior: 'smooth' });
    else if (right > list.scrollLeft + list.clientWidth) list.scrollTo({ left: right - list.clientWidth + 8, behavior: 'smooth' });
  }, [section]);

  return (
    <div className="np-rule flex items-stretch justify-between gap-1" style={{ height: STRIP_HEIGHT_PX }} data-testid="section-strip">
      <div
        ref={listRef}
        role="tablist"
        aria-label="Sections of the paper"
        className="scroll-x no-scrollbar flex min-w-0 items-stretch gap-0.5"
        style={{ maskImage: 'linear-gradient(to right, black calc(100% - 18px), transparent)', WebkitMaskImage: 'linear-gradient(to right, black calc(100% - 18px), transparent)' }}
      >
        {NEWS_SECTIONS.map((entry) => (
          <button
            key={entry}
            type="button"
            role="tab"
            aria-selected={section === entry}
            onClick={() => onSection(entry)}
            className="np-tab tap-target shrink-0 px-1.5 whitespace-nowrap"
          >
            {SECTION_LABEL[entry]}
          </button>
        ))}
        {/* Room for the fade, so the last word is never under it. */}
        <span aria-hidden="true" className="w-4 shrink-0" />
      </div>
      <div className="flex shrink-0 items-stretch">
        <button
          type="button"
          aria-pressed={mine}
          onClick={() => onMine(!mine)}
          className="np-tab tap-target flex items-center gap-1 px-1.5"
          style={mine ? { borderBottomColor: 'var(--color-brand)', color: 'var(--color-brand)' } : undefined}
        >
          <span aria-hidden="true" className={cx('inline-block size-1.5 rounded-full', mine ? 'bg-brand' : 'bg-rule')} />
          Mine
        </button>
        {filterable ? (
          <button type="button" onClick={onFilter} className="np-tab tap-target relative flex items-center px-1.5" aria-haspopup="dialog" aria-label="Filter by industry or company">
            <Icon name="filter" size={15} accent="current" />
            {filterCount > 0 ? (
              <span className="figure absolute top-1.5 right-0 rounded-pill bg-ink px-1 text-[9px] leading-[14px] font-bold text-white">{filterCount}</span>
            ) : null}
          </button>
        ) : null}
      </div>
    </div>
  );
});
