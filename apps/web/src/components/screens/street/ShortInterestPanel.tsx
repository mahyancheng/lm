'use client';

/**
 * What the smart money thinks, per instrument.
 *
 * Two additions to Markets and nothing more: short interest as one whole
 * percentage with a bar drawn against the cap rather than against 100, and the
 * 13F-style list of holders who have actually crossed the disclosure threshold.
 *
 * Below that threshold a holder is **absent** — not blurred, not summarised,
 * absent. An undisclosed accumulation is the game's sharpest weapon and a
 * softened row here would blunt it.
 */

import { SHORT_INTEREST_CAP_PCT } from '@frontier/contracts';
import { formatCount } from '@frontier/shared';
import { EmptyState, Icon, ProgressBar, Tag, cx } from '@/components/ui';
import type { CapitalPositionRow, ShortInterestRow } from '@frontier/contracts';
import { HOLDER_DISCLOSURE_PCT, SHORT_HOLDER_DISCLOSURE_PCT, shortInterestBadge, shortInterestFraction } from './model';

export interface ShortInterestCardProps {
  readonly row: ShortInterestRow;
  readonly companyName: string;
  readonly entityNameOf: (entityId: string) => string;
  readonly compact?: boolean;
}

export function ShortInterestCard({ row, companyName, entityNameOf, compact = false }: ShortInterestCardProps): React.JSX.Element {
  const badge = shortInterestBadge(row);
  return (
    <div className={cx('min-w-0', compact ? '' : 'raised-surface px-2.5 py-2')}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        {compact ? null : <span className="min-w-0 truncate text-[12.5px] text-ink">{companyName}</span>}
        <Tag tone={badge.tone} dot={badge.risk !== 'fired'}>
          {badge.label}
        </Tag>
      </div>

      <ProgressBar
        className="mt-1.5"
        value={shortInterestFraction(row)}
        max={1}
        tone={badge.risk === 'none' ? 'info' : badge.tone}
        label="Short interest"
        valueLabel={`${row.shortInterestPct}% of float · borrow ${row.borrowFeePctPerQuarter}%/qtr`}
      />
      <p className="mt-1 text-[10px] text-ink-faint">
        The bar is drawn against the {SHORT_INTEREST_CAP_PCT}% per-instrument cap, which is the only ceiling that exists.
      </p>

      {row.forcedCoverShares === 0 ? null : (
        <p className="mt-1 flex items-center gap-1 text-[10.5px] tone-loss">
          <Icon name="warning" size={12} accent="current" />
          {formatCount(row.forcedCoverShares)} shares force-covered — that volume lands on next quarter’s price.
        </p>
      )}

      {row.disclosedEntityIds.length === 0 ? (
        <p className="mt-1.5 text-[10.5px] text-ink-faint">
          No holder of this short book has crossed {SHORT_HOLDER_DISCLOSURE_PCT}%, so none is named. Nothing is being summarised.
        </p>
      ) : (
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {row.disclosedEntityIds.map((entityId) => (
            <Tag key={entityId} tone="warn">
              <Icon name="chart" size={11} accent="current" />
              {entityNameOf(entityId)}
            </Tag>
          ))}
        </div>
      )}
    </div>
  );
}

export interface HoldersPanelProps {
  readonly holders: readonly CapitalPositionRow[];
  readonly entityNameOf: (entityId: string) => string;
  /** The reader's own stake, so the register reads as a fight rather than a list. */
  readonly ownStakePct: number | null;
  readonly controlPct: number;
}

export function HoldersPanel({ holders, entityNameOf, ownStakePct, controlPct }: HoldersPanelProps): React.JSX.Element {
  if (holders.length === 0) {
    return (
      <EmptyState
        compact
        icon="vault"
        title="No disclosed institutional holder"
        message={`A position becomes public at ${HOLDER_DISCLOSURE_PCT}% of the issued class. Below it the row is absent from the record — which is what makes a quiet accumulation possible in the first place.`}
      />
    );
  }

  return (
    <ul className="flex flex-col gap-2">
      {ownStakePct === null ? null : (
        <li className="raised-surface px-2.5 py-2">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-[12.5px] font-semibold text-brand">Your stake</span>
            <span className="figure text-[12px] font-semibold text-brand">{Math.round(ownStakePct)}%</span>
          </div>
          <ProgressBar className="mt-1.5" value={ownStakePct} max={100} tone="brand" ghostValue={controlPct} />
          <p className="mt-1 text-[10px] text-ink-faint">Control at {Math.round(controlPct)}%.</p>
        </li>
      )}
      {holders.map((holder) => (
        <li key={`${holder.entityId}_${holder.securityId}`} className="raised-surface px-2.5 py-2">
          <div className="flex items-baseline justify-between gap-2">
            <span className="min-w-0 truncate text-[12.5px] text-ink">{entityNameOf(holder.entityId)}</span>
            <span className="figure shrink-0 text-[12px] font-semibold text-ink">{holder.stakePct}%</span>
          </div>
          <ProgressBar
            className="mt-1.5"
            value={holder.stakePct}
            max={100}
            tone={holder.stakePct >= controlPct ? 'loss' : 'info'}
            ghostValue={controlPct}
          />
        </li>
      ))}
    </ul>
  );
}
