'use client';

/**
 * V2 — the market-share ladder for one sector.
 *
 * One full-width bar per company, largest first, yours in the brand colour,
 * accord members grouped under their own heading, and the 50% control line
 * drawn on the axis so "one more rival is a visible bump" and "half the sector"
 * are the same picture.
 *
 * Full-width bars and vertical scroll, never a table: twenty-five companies on
 * a 390px phone is a list you scroll, not a grid you pan.
 *
 * The information boundary is in `sectorLadderRows`, not here. A listed company
 * files its statements and appears with a figure; a private one does not, and
 * the remainder of the sector's committed supply is drawn as a single
 * "privately held" bar rather than guessed at company by company.
 */

import type { Sector } from '@frontier/contracts';
import { EmptyState, Icon, SECTOR_TINT, Tag, cx } from '@/components/ui';
import { revenueLabel, shareLabel, type LadderRow } from './model';

export interface SectorLadderProps {
  readonly sector: Sector;
  readonly rows: readonly LadderRow[];
  /** The sector's committed supply, so the axis says what 100% is worth. */
  readonly supplyUsd: number;
  readonly className?: string;
}

/** Where the control line falls on a share axis whose full width is the sector. */
const CONTROL_LINE_PCT = 50;

export function SectorLadder({ sector, rows, supplyUsd, className }: SectorLadderProps): React.JSX.Element {
  if (rows.length === 0) {
    return (
      <EmptyState
        compact
        icon="chart"
        title="Nobody stands in this sector"
        message="No active company in this session operates here, so there is no share to divide."
      />
    );
  }

  const accord = rows.filter((row) => row.inAccord);
  const rest = rows.filter((row) => !row.inAccord);

  return (
    <div className={cx('flex flex-col gap-2', className)}>
      {accord.length === 0 ? null : (
        <div className="rounded-card border border-warn/25 bg-warn-wash px-2.5 py-2">
          <p className="flex items-center gap-1.5 text-[11px] font-semibold text-warn">
            <Icon name="handshake" size={13} accent="current" />
            Price accord — {accord.length} member{accord.length === 1 ? '' : 's'} holding the price together
          </p>
          <div className="mt-1.5 flex flex-col gap-1.5">
            {accord.map((row) => (
              <LadderBar key={row.key} row={row} sector={sector} />
            ))}
          </div>
        </div>
      )}

      <div className="flex flex-col gap-1.5">
        {rest.map((row) => (
          <LadderBar key={row.key} row={row} sector={sector} />
        ))}
      </div>

      <p className="text-[10.5px] leading-relaxed text-ink-faint">
        The full width is this sector&apos;s committed supply of {revenueLabel(supplyUsd)} a year; the dashed line is
        50%. A listed company&apos;s revenue is on the public record, so it has a bar. A private one&apos;s is not, and
        it sits inside the last bar rather than being guessed at.
      </p>
    </div>
  );
}

function LadderBar({ row, sector }: { readonly row: LadderRow; readonly sector: Sector }): React.JSX.Element {
  const width = row.share === null ? 0 : Math.max(0, Math.min(100, row.share * 100));
  const fill = row.isPlayer
    ? 'var(--color-brand)'
    : row.isUndisclosed
      ? 'var(--color-ink-faint)'
      : `color-mix(in srgb, ${SECTOR_TINT[sector]} 72%, var(--color-ink))`;

  return (
    <div className="min-w-0">
      <div className="flex items-baseline justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className={cx('truncate text-[12px]', row.isPlayer ? 'font-semibold text-brand' : 'text-ink')}>{row.label}</span>
          {row.isPlayer ? <Tag tone="brand" size="sm">you</Tag> : null}
          {!row.isPlayer && !row.isUndisclosed && !row.isPublic ? <Tag size="sm">private</Tag> : null}
        </span>
        <span className="figure shrink-0 text-[11.5px] text-ink-dim">
          {shareLabel(row.share)}
          <span className="ml-1.5 text-ink-faint">{revenueLabel(row.revenueUsd)}</span>
        </span>
      </div>
      <div className="relative mt-0.5 h-3.5 w-full overflow-hidden rounded-pill bg-raised">
        <span className="absolute inset-y-0 left-0 rounded-pill" style={{ width: `${width}%`, backgroundColor: fill }} />
        {/* The one line every ownership bar in this game is read against. */}
        <span
          aria-hidden="true"
          className="absolute inset-y-0 w-px border-l border-dashed border-ink-faint"
          style={{ left: `${CONTROL_LINE_PCT}%` }}
        />
      </div>
    </div>
  );
}
