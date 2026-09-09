'use client';

/**
 * V3 — your price against the market, on one axis.
 *
 * A single horizontal axis: the segment average as a tick, your price as the
 * labelled marker, the achievable ceiling as a dashed line, and a dot for every
 * **flagged** predatory price in the segment.
 *
 * Which dots may exist is decided by rule 9 and not by what would look best. A
 * rival's list price is private. A predatory price is not: P0-4 writes
 * `predatory_pricing_flagged` at `public` visibility precisely because a price
 * war is public by nature and *should* move belief. So the ladder shows the
 * average, you, the ceiling, and whoever is currently dumping — which is the
 * complete set of prices a player is entitled to see, and the set that makes
 * dumping self-explanatory.
 *
 * If somebody is squeezing you, the pressure row underneath names them. Naming
 * the attacker is what makes the economy feel populated rather than procedural.
 */

import type { PredationRow, RivalPressureRow } from '@frontier/contracts';
import { formatMoney } from '@frontier/shared';
import { Icon, TONE_VAR, Tag, cx } from '@/components/ui';
import { priceLadder, signedPct, type PriceLadderPoint } from '../sector/model';

export interface PriceLadderProps {
  readonly yourPriceUsd: number;
  readonly referenceUsd: number;
  readonly ceilingUsd: number;
  /** Flagged predatory prices in this segment, from the committed report. */
  readonly predators: readonly PredationRow[];
  /** Names for company ids, so a dot can be labelled. */
  readonly companyNames: ReadonlyMap<string, string>;
  /** The pressure your own product is under this quarter, or null. */
  readonly pressure: RivalPressureRow | null;
  /** Your own product's predation row, when the engine flagged you. */
  readonly ownPredation: PredationRow | null;
  readonly className?: string;
}

const KIND_TONE = {
  you: 'brand',
  reference: 'neutral',
  predator: 'loss',
  ceiling: 'warn',
} as const;

export function PriceLadder({
  yourPriceUsd,
  referenceUsd,
  ceilingUsd,
  predators,
  companyNames,
  pressure,
  ownPredation,
  className,
}: PriceLadderProps): React.JSX.Element {
  const ladder = priceLadder(
    yourPriceUsd,
    referenceUsd,
    ceilingUsd,
    predators.map((row) => ({
      companyId: row.companyId,
      label: companyNames.get(row.companyId) ?? row.companyId,
      priceUsd: row.priceUsd,
    })),
  );

  const you = ladder.points.find((point) => point.kind === 'you') as PriceLadderPoint;
  const reference = ladder.points.find((point) => point.kind === 'reference') as PriceLadderPoint;
  const ceiling = ladder.points.find((point) => point.kind === 'ceiling') as PriceLadderPoint;
  const dots = ladder.points.filter((point) => point.kind === 'predator');

  return (
    <div className={cx('min-w-0', className)}>
      {/* The axis itself. Everything is a percentage of a drawn width, which is
          geometry — no figure on it was computed by this component. */}
      <div className="relative h-14 w-full">
        <div className="absolute top-7 h-1.5 w-full rounded-pill bg-raised" />

        {/* The achievable ceiling, dashed, because it is a target rather than a
            fact — the price above which the elasticity model stops responding. */}
        <div
          className="absolute top-3 h-7 border-l border-dashed border-warn"
          style={{ left: `${ceiling.fraction * 100}%` }}
          title={`Achievable ceiling ${formatMoney(ceiling.priceUsd, 'full')}`}
        />

        {/* The segment average: the anchor every price in the game is judged
            against, so it is a tick on the axis rather than a dot on it. */}
        <div className="absolute top-4 h-5 w-px bg-ink-faint" style={{ left: `${reference.fraction * 100}%` }} />

        {dots.map((dot) => (
          <div
            key={dot.key}
            className="absolute top-[26px] size-2.5 -translate-x-1/2 rounded-pill bg-loss"
            style={{ left: `${dot.fraction * 100}%` }}
            title={`${dot.label} — ${formatMoney(dot.priceUsd, 'full')}`}
          />
        ))}

        <div
          className="absolute top-[22px] size-4 -translate-x-1/2 rounded-pill border-2 border-white bg-brand shadow-card"
          style={{ left: `${you.fraction * 100}%` }}
          title={`You — ${formatMoney(you.priceUsd, 'full')}`}
        />
        <span
          className="figure absolute top-9 -translate-x-1/2 text-[11px] font-semibold whitespace-nowrap text-brand"
          style={{ left: `${you.fraction * 100}%` }}
        >
          {formatMoney(you.priceUsd, 'full')}
        </span>
      </div>

      <ul className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
        {[reference, ceiling, you].map((point) => (
          <li key={point.key} className="flex items-center gap-1.5 text-[10.5px] text-ink-dim">
            <span
              className="inline-block size-2 shrink-0 rounded-pill"
              style={{ backgroundColor: TONE_VAR[KIND_TONE[point.kind]] }}
              aria-hidden="true"
            />
            {point.label} <span className="figure text-ink-faint">{formatMoney(point.priceUsd, 'full')}</span>
          </li>
        ))}
        {dots.length === 0 ? null : (
          <li className="flex items-center gap-1.5 text-[10.5px] text-loss">
            <span className="inline-block size-2 shrink-0 rounded-pill bg-loss" aria-hidden="true" />
            {dots.length} flagged below cost
          </li>
        )}
      </ul>

      {ownPredation === null ? null : (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <Tag tone="loss" dot>
            PREDATORY · {ownPredation.predatoryQuarters} quarter{ownPredation.predatoryQuarters === 1 ? '' : 's'}
          </Tag>
          <Tag tone="warn">+{ownPredation.exposurePoints} antitrust</Tag>
          <span className="text-[10.5px] text-ink-faint">
            {signedPct(-ownPredation.undercutPct)} under the segment average at a {ownPredation.grossMarginPct}% gross
            margin.
          </span>
        </div>
      )}

      {pressure === null ? null : (
        <p className="mt-2 flex items-start gap-1.5 rounded-card bg-loss-wash px-2 py-1.5 text-[11px] leading-snug font-semibold text-loss">
          <Icon name="warning" size={13} accent="current" className="mt-px shrink-0" />
          {pressure.fromCompanyIds.map((id) => companyNames.get(id) ?? id).join(', ')} cut below cost and took{' '}
          {pressure.pressurePct}% of your gross additions this quarter.
        </p>
      )}
    </div>
  );
}
