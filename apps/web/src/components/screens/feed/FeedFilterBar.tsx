'use client';

/**
 * The one row of chrome above the feed.
 *
 * Everything a reader can do to the stream lives here and nowhere else: what
 * kind of thing, which industry, which company. It sticks under the shell's own
 * bars so a filter is still reachable four hundred items down, and it stays one
 * scrollable row per axis so the first card is still on screen on a 390px
 * phone.
 *
 * Every control clears the 44px touch floor. Chips derive their counts from the
 * feed itself, so a chip never offers a filter that would empty the screen.
 */

import type { Sector } from '@frontier/contracts';
import { SECTORS } from '@frontier/contracts';
import { Icon, SectorFilter, cx, type IconName } from '@/components/ui';
import { FEED_KIND_GROUPS, type FeedKindGroup } from './filters';

const GROUP_LABEL: Readonly<Record<FeedKindGroup, string>> = {
  events: 'Events',
  press: 'Press',
  leaks: 'Filings',
  posts: 'Posts',
};

const GROUP_ICON: Readonly<Record<FeedKindGroup, IconName>> = {
  events: 'warning',
  press: 'newspaper',
  leaks: 'stamp',
  posts: 'chat',
};

export interface FeedCompanyOption {
  readonly id: string;
  readonly name: string;
  readonly count: number;
}

export interface FeedFilterBarProps {
  /** Null is "All" — the state the feed opens in. */
  readonly group: FeedKindGroup | null;
  readonly onGroupChange: (group: FeedKindGroup | null) => void;
  readonly counts: Readonly<Record<FeedKindGroup, number>>;
  readonly total: number;
  /** Sectors the feed actually names. Fewer than two and the row is suppressed. */
  readonly sectors: readonly Sector[];
  readonly sectorCounts?: Readonly<Partial<Record<Sector, number>>>;
  readonly sector: Sector | null;
  readonly onSectorChange: (sector: Sector | null) => void;
  readonly companies: readonly FeedCompanyOption[];
  readonly companyId: string | null;
  readonly onCompanyChange: (companyId: string | null) => void;
  readonly className?: string;
}

export function FeedFilterBar({
  group,
  onGroupChange,
  counts,
  total,
  sectors,
  sectorCounts,
  sector,
  onSectorChange,
  companies,
  companyId,
  onCompanyChange,
  className,
}: FeedFilterBarProps): React.JSX.Element {
  return (
    <div
      className={cx(
        // Sticks below the status bar, and below the group's sub-tabs as well
        // on a phone, where both are present.
        'sticky z-10 -mx-3 flex flex-col gap-1.5 border-b border-hair bg-base/92 px-3 py-1.5 backdrop-blur sm:-mx-5 sm:px-5',
        'top-[calc(var(--statusbar-height)+var(--subtab-height))] lg:top-[var(--statusbar-height)]',
        className,
      )}
    >
      <div className="scroll-x no-scrollbar -mx-1 px-1" role="group" aria-label="Filter by kind">
        <div className="flex w-max items-center gap-1.5">
          <KindChip active={group === null} count={total} onClick={() => onGroupChange(null)}>
            All
          </KindChip>
          {FEED_KIND_GROUPS.map((entry) => (
            <KindChip
              key={entry}
              active={group === entry}
              count={counts[entry]}
              icon={GROUP_ICON[entry]}
              onClick={() => onGroupChange(group === entry ? null : entry)}
            >
              {GROUP_LABEL[entry]}
            </KindChip>
          ))}
        </div>
      </div>

      <SectorFilter sectors={sectors} value={sector} onChange={onSectorChange} counts={sectorCounts} totalLabel="All sectors" />

      {companies.length < 2 ? null : (
        <select
          aria-label="Filter by company"
          className="field tap-target w-full text-[12px] sm:w-64"
          value={companyId ?? 'all'}
          onChange={(event) => onCompanyChange(event.target.value === 'all' ? null : event.target.value)}
        >
          <option value="all">All companies</option>
          {companies.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.name} ({entry.count})
            </option>
          ))}
        </select>
      )}
    </div>
  );
}

function KindChip({
  active,
  count,
  icon,
  onClick,
  children,
}: {
  readonly active: boolean;
  readonly count: number;
  readonly icon?: IconName;
  readonly onClick: () => void;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cx(
        'press-pop tap-target flex shrink-0 items-center gap-1.5 rounded-pill border px-3 text-[12px] font-semibold whitespace-nowrap transition-colors',
        active ? 'icon-knockout-wash border-brand/30 bg-brand-wash text-brand' : 'icon-knockout-panel border-hair bg-panel text-ink-dim',
      )}
    >
      {icon === undefined ? null : <Icon name={icon} size={14} accent="inherit" />}
      {children}
      <span className="figure text-[10px] opacity-70">{count}</span>
    </button>
  );
}

/** The six sectors, in contract order, so every screen offers the same row. */
export const FEED_SECTOR_ORDER: readonly Sector[] = SECTORS;
