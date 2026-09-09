'use client';

/**
 * One institution, one card.
 *
 * Eleven columns of a holdings table is not a phone surface, so the roster is
 * eleven cards that scroll. The card carries exactly what §5.1 asks for and
 * nothing else: one bare number (AUM), one bar (dry powder — how much they can
 * still do to you), one line of thesis, one stance chip, one line of last move,
 * and one LP-pressure meter with the forced-seller horizon under it.
 *
 * Nothing here computes anything. Every figure arrives on the committed
 * `CapitalEntityRow` and every ordering arrives from `model.ts`.
 */

import { formatMoney } from '@frontier/shared';
import { Icon, IconChip, ProgressBar, RegionBadge, Tag, cx } from '@/components/ui';
import {
  CAPITAL_KIND_ICON,
  CAPITAL_KIND_LABEL,
  LP_BAND_LABEL,
  LP_BAND_TONE,
  STANCE_LABEL,
  STANCE_TONE,
  dryPowderLine,
  forcedSellerLine,
  trackRecordLine,
  type StreetCardRow,
} from './model';

export interface StreetCardProps {
  readonly card: StreetCardRow;
  readonly onOpen: (entityId: string) => void;
}

export function StreetCard({ card, onOpen }: StreetCardProps): React.JSX.Element {
  const { row } = card;
  const bandTone = LP_BAND_TONE[row.lpBand];

  return (
    <button
      type="button"
      onClick={() => onOpen(row.entityId)}
      className="panel-surface w-full min-w-0 px-3 py-3 text-left transition-colors hover:border-hair-strong"
      aria-label={`${row.name} — open the full book`}
    >
      <header className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <IconChip name={CAPITAL_KIND_ICON[row.kind]} tone={row.kind === 'sovereign' ? 'info' : 'brand'} />
          <div className="min-w-0">
            <p className="truncate text-[13.5px] font-semibold text-ink">{row.name}</p>
            <p className="truncate text-[10.5px] text-ink-faint">{CAPITAL_KIND_LABEL[row.kind]}</p>
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <span className="figure text-[17px] leading-none font-semibold text-ink">{formatMoney(row.aumUsd)}</span>
          <span className="label-caps-faint">AUM</span>
        </div>
      </header>

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <Tag tone={STANCE_TONE[card.stance]} dot>
          {STANCE_LABEL[card.stance]}
        </Tag>
        <RegionBadge region={row.region} />
        {card.ownPositions.length === 0 ? null : (
          <Tag tone="brand">
            <Icon name="building" size={11} accent="current" />
            on your register
          </Tag>
        )}
        {card.shorts.length === 0 ? null : (
          <Tag tone="warn">
            <Icon name="chart" size={11} accent="current" />
            {card.shorts.length} short{card.shorts.length === 1 ? '' : 's'}
          </Tag>
        )}
      </div>

      {/* V7: the headroom bar, beside the number it constrains. */}
      <ProgressBar
        className="mt-2.5"
        value={row.dryPowderPct}
        max={100}
        tone="brand"
        label="Dry powder"
        valueLabel={dryPowderLine(row)}
      />

      <p className="mt-2 text-[12px] leading-snug text-ink-dim">{row.thesis}</p>

      <div className="mt-2.5">
        <div className="mb-1 flex items-baseline justify-between gap-2">
          <span className="label-caps-faint">LP pressure</span>
          <span className={cx('figure text-[11px] font-semibold', `tone-${bandTone}`)}>
            {row.lpPressure} · {LP_BAND_LABEL[row.lpBand]}
          </span>
        </div>
        <ProgressBar value={row.lpPressure} max={100} tone={bandTone} height={8} />
        <p className={cx('mt-1 text-[10.5px]', card.forcedInQuarters === null ? 'text-ink-faint' : `tone-${bandTone}`)}>
          {forcedSellerLine(row)}
        </p>
      </div>

      <div className="mt-2.5 flex items-start justify-between gap-2 border-t border-hair pt-2">
        <span className="min-w-0 flex-1 truncate text-[11.5px] text-ink-dim">
          {row.lastMove ?? 'Quiet this quarter'}
        </span>
        <span className="figure shrink-0 text-[10px] text-ink-faint">{trackRecordLine(row)}</span>
      </div>
    </button>
  );
}
