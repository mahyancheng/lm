'use client';

/**
 * The cap table, seen at a glance and then in full.
 *
 * Control is not percentage: the stacked bar shows economic ownership, the
 * table shows economic and voting side by side, and the two diverge wherever
 * super-voting stock exists. The unissued option pool is drawn as its own band
 * because it is dilution that has already been agreed.
 */

import type { CapTable, SessionState } from '@frontier/contracts';
import { formatMoney, formatPct } from '@frontier/shared';
import { DataTable, Tag, TONE_VAR, cx, type Column, type Tone } from '@/components/ui';
import { capTableRows, formatCount, humanise, issuedSharesOf, type OwnershipRow } from '../reporting/util';

const BAND_TONES: readonly Tone[] = ['brand', 'info', 'gain', 'warn', 'loss', 'neutral'];

export interface CapTableVisualProps {
  readonly session: SessionState;
  readonly table: CapTable;
  /** Price per share used to mark each position, or 0 when there is none. */
  readonly pricePerShare: number;
  readonly priceBasis: 'quote' | 'anchor' | 'none';
}

export function CapTableVisual({ session, table, pricePerShare, priceBasis }: CapTableVisualProps): React.JSX.Element {
  const rows = capTableRows(session, table);
  const issued = issuedSharesOf(table);
  const poolShares = Math.max(0, table.optionPoolShares);
  const fullyDiluted = Math.max(table.fullyDilutedShares, issued + poolShares);

  const bands = rows.map((row, index) => ({
    key: row.holdingId,
    label: row.label,
    pct: fullyDiluted === 0 ? 0 : row.shares / fullyDiluted,
    tone: BAND_TONES[index % BAND_TONES.length] ?? 'neutral',
  }));
  const poolPct = fullyDiluted === 0 ? 0 : poolShares / fullyDiluted;

  const columns: readonly Column<OwnershipRow>[] = [
    {
      key: 'holder',
      header: 'Holder',
      render: (row) => (
        <span className="min-w-0">
          <span className="block truncate text-[12px] text-ink">{row.label}</span>
          <span className="block truncate text-[10px] text-ink-faint">{humanise(row.holderKind)}</span>
        </span>
      ),
      sortable: true,
      sortValue: (row) => row.label,
    },
    { key: 'class', header: 'Class', render: (row) => <Tag>{row.shareClassLabel}</Tag>, hideOnMobile: true },
    { key: 'shares', header: 'Shares', align: 'right', render: (row) => formatCount(row.shares), sortable: true, sortValue: (row) => row.shares },
    { key: 'economic', header: 'Economic', align: 'right', render: (row) => formatPct(row.economicPct), sortable: true, sortValue: (row) => row.economicPct },
    {
      key: 'voting',
      header: 'Voting',
      align: 'right',
      render: (row) => (
        <span className={row.votingPct > row.economicPct + 0.001 ? 'tone-brand' : undefined}>{formatPct(row.votingPct)}</span>
      ),
      sortable: true,
      sortValue: (row) => row.votingPct,
    },
    {
      key: 'diluted',
      header: 'Fully diluted',
      align: 'right',
      hideOnMobile: true,
      cardHidden: true,
      render: (row) => formatPct(row.fullyDilutedPct),
      sortable: true,
      sortValue: (row) => row.fullyDilutedPct,
    },
    {
      key: 'value',
      header: 'Value',
      align: 'right',
      hideOnMobile: true,
      cardLabel: 'Marked value',
      render: (row) => (pricePerShare <= 0 ? '—' : formatMoney(row.shares * pricePerShare)),
      sortable: true,
      sortValue: (row) => row.shares * pricePerShare,
    },
    {
      key: 'threshold',
      header: 'Threshold',
      render: (row) =>
        row.threshold === null ? (
          <span className="text-[10px] text-ink-faint">—</span>
        ) : (
          <Tag tone={row.threshold.label === 'control' ? 'brand' : 'warn'} title={row.threshold.effect}>
            {humanise(row.threshold.label)}
          </Tag>
        ),
      hideOnMobile: true,
    },
  ];

  return (
    <div className="flex flex-col gap-3">
      {/* The ownership band scales to whatever width it is given — it is a
          percentage stack, so a phone gets the same picture as a desktop, just
          shorter. The legend below it is the readable half on a phone, so it
          stacks one band per line rather than wrapping mid-name. */}
      <div>
        <div className="flex h-8 w-full overflow-hidden rounded-pill border border-hair sm:h-7">
          {bands.map((band) => (
            <div
              key={band.key}
              title={`${band.label} — ${formatPct(band.pct)} fully diluted`}
              style={{ width: `${Math.max(0, band.pct * 100)}%`, backgroundColor: TONE_VAR[band.tone] }}
              className="h-full"
            />
          ))}
          {poolPct > 0 ? (
            <div
              title={`Option pool — ${formatPct(poolPct)} fully diluted`}
              style={{ width: `${poolPct * 100}%` }}
              className="h-full bg-raised"
            />
          ) : null}
        </div>
        <ul className="mt-2 flex flex-col gap-1 sm:flex-row sm:flex-wrap sm:gap-x-4 sm:gap-y-1">
          {bands.map((band) => (
            <li key={band.key} className="flex items-center gap-2 text-[12.5px] text-ink-dim sm:text-[11px]">
              <span className={cx('inline-block size-2.5 shrink-0 rounded-pill')} style={{ backgroundColor: TONE_VAR[band.tone] }} />
              <span className="min-w-0 flex-1 truncate sm:flex-none">{band.label}</span>
              <span className="figure shrink-0 text-ink-faint">{formatPct(band.pct)}</span>
            </li>
          ))}
          {poolPct > 0 ? (
            <li className="flex items-center gap-2 text-[12.5px] text-ink-dim sm:text-[11px]">
              <span className="inline-block size-2.5 shrink-0 rounded-pill border border-hair bg-raised" />
              <span className="min-w-0 flex-1 truncate sm:flex-none">Option pool</span>
              <span className="figure shrink-0 text-ink-faint">{formatPct(poolPct)}</span>
            </li>
          ) : null}
        </ul>
      </div>

      <div className="grid grid-cols-2 gap-x-5 gap-y-1.5 border-y border-hair py-2.5 sm:grid-cols-4">
        <div className="flex items-baseline justify-between gap-2">
          <span className="label-caps-faint">Issued</span>
          <span className="figure text-[12px] text-ink">{formatCount(issued)}</span>
        </div>
        <div className="flex items-baseline justify-between gap-2">
          <span className="label-caps-faint">Option pool</span>
          <span className="figure text-[12px] text-ink">{formatCount(poolShares)}</span>
        </div>
        <div className="flex items-baseline justify-between gap-2">
          <span className="label-caps-faint">Fully diluted</span>
          <span className="figure text-[12px] text-ink">{formatCount(fullyDiluted)}</span>
        </div>
        <div className="flex items-baseline justify-between gap-2">
          <span className="label-caps-faint">Per share</span>
          <span className="figure text-[12px] text-ink" title={priceBasis === 'anchor' ? 'Marked at the fundamental anchor' : 'Last traded close'}>
            {pricePerShare <= 0 ? '—' : formatMoney(pricePerShare)}
          </span>
        </div>
      </div>

      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(row) => row.holdingId}
        dense
        cardMode="auto"
        cardTitleKey="holder"
        initialSort={{ key: 'economic', direction: 'desc' }}
      />
    </div>
  );
}
