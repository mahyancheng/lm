'use client';

/**
 * The World group's tab strip.
 *
 * Shared by the four screens of the World nav group — the map (`/news`),
 * Social, Network and Leaderboard — the way `screens/reporting/util` is shared
 * by the screens that report a quarter. Nothing here is world-specific; it is
 * simply the one place those four agree on what a tab looks like.
 *
 * Why it exists at all, when `TabBar` already does tabs: the phone. `TabBar`'s
 * underline row is 35px tall and labels a tab with words alone, which is fine
 * under a pointer and wrong under a thumb. This strip is
 *
 * - **44px tall**, always, so every tab clears the touch floor;
 * - **marked**, so a ten-board row is scannable at a glance rather than a wall
 *   of similar words — the mark carries the category and the word confirms it;
 * - **scrollable below `sm` and wrapped above it**, so a phone swipes through
 *   ten boards and a desktop simply sees all ten.
 *
 * The mark sits on a filled surface when the tab is selected, so the strip
 * knocks the accent out in the fill it is sitting on rather than letting a
 * second colour fight a 16px square (ART_DIRECTION §10.2).
 */

import { useEffect, useRef } from 'react';
import { Icon, cx, type IconName } from '@/components/ui';

export interface IconTabItem {
  readonly id: string;
  readonly label: string;
  /** The mark for this tab. Never a monogram. */
  readonly icon: IconName;
  /** A count after the label; omitted when there is nothing to count. */
  readonly badge?: number | string;
}

export interface IconTabsProps {
  readonly tabs: readonly IconTabItem[];
  readonly value: string;
  readonly onChange: (id: string) => void;
  readonly ariaLabel: string;
  /**
   * Let the strip wrap from `sm` up instead of scrolling at every width.
   * True for a long row (ten boards); false for a short one that fits.
   */
  readonly wrap?: boolean;
  readonly className?: string;
}

/** A row of marked tabs: scrollable on a phone, wrapped on a desktop. */
export function IconTabs({ tabs, value, onChange, ariaLabel, wrap = true, className }: IconTabsProps): React.JSX.Element {
  const strip = useRef<HTMLDivElement | null>(null);

  // A ten-tab strip on a phone can open with the selected tab off the right
  // edge — the Leaderboard opens on the Founder Index, which is the last of
  // them. Bring it into view without moving the page: `scrollLeft` on the strip
  // itself, never `scrollIntoView`, which would take the document with it. The
  // jump is instant rather than smooth, so it is nothing to reduce under
  // `prefers-reduced-motion`.
  useEffect(() => {
    const list = strip.current;
    if (list === null || list.scrollWidth <= list.clientWidth) return;
    const active = list.querySelector<HTMLElement>('[aria-selected="true"]');
    if (active === null) return;
    list.scrollLeft = Math.max(0, active.offsetLeft - (list.clientWidth - active.clientWidth) / 2);
  }, [value]);

  return (
    <div
      ref={strip}
      role="tablist"
      aria-label={ariaLabel}
      className={cx(
        'panel-surface no-scrollbar flex gap-1 overflow-x-auto p-1',
        wrap ? 'sm:flex-wrap sm:overflow-visible' : '',
        className,
      )}
    >
      {tabs.map((tab) => {
        const active = tab.id === value;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(tab.id)}
            className={cx(
              'press-pop tap-target flex shrink-0 items-center gap-1.5 rounded-chip px-3 text-[12px] font-semibold whitespace-nowrap transition-colors',
              active ? 'icon-knockout-wash bg-brand-wash text-brand' : 'icon-knockout-panel text-ink-dim hover:bg-raised',
            )}
          >
            <Icon name={tab.icon} size={16} accent="inherit" />
            {tab.label}
            {tab.badge === undefined ? null : <span className="figure text-[10px] opacity-70">{tab.badge}</span>}
          </button>
        );
      })}
    </div>
  );
}
