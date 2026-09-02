'use client';

/**
 * V6 — the Sector Flow chain.
 *
 * Six tiles, one per sector, each carrying the three things §4 P0-1 specified
 * as its mobile surface:
 *
 * - **one number** — the price index, printed bare against a baseline of 100;
 * - **twin bars** — demand over supply, Anno's blue-over-green, so the
 *   imbalance *is* the price and cause sits directly above effect;
 * - **one badge** — `SHORT -30%` while the stateful counter is live.
 *
 * The links between tiles are `SECTOR_META`'s declared supply graph, drawn as
 * labelled arrows: an input your own group produces reads as an internal link,
 * an input you buy reads at the market index. That gap is the pitch for the
 * next acquisition, which is exactly what V6 is for.
 *
 * There is no slider on this panel. It is a readout, and every figure on it was
 * committed by `priceSectors` in the world phase.
 */

import type { EconomyReport, Sector } from '@frontier/contracts';
import { SECTOR_PRICE_BASELINE } from '@frontier/contracts';
import { formatMoney } from '@frontier/shared';
import { EmptyState, Icon, SECTOR_TINT, TONE_FILL, Tag, cx, sectorLabel } from '@/components/ui';
import {
  PRICE_BASELINE_FRACTION,
  flowTiles,
  indexLabel,
  priceIndexFraction,
  priceIndexTone,
  shortageBadge,
  type FlowTile,
} from './model';

export interface SectorFlowProps {
  readonly report: EconomyReport | null;
  /** Sectors the player's own group produces in — the internal links. */
  readonly ownSectors: ReadonlySet<Sector>;
  /** Opens the committed `sector_price_set` row behind a tile. */
  readonly onOpenCause?: (eventId: string) => void;
  readonly className?: string;
}

export function SectorFlow({ report, ownSectors, onOpenCause, className }: SectorFlowProps): React.JSX.Element {
  const tiles = flowTiles(report, ownSectors);
  const priced = tiles.some((tile) => tile.row !== null);

  if (!priced) {
    return (
      <EmptyState
        icon="globe"
        title="The chain has no prices yet"
        message="Sector goods prices are set in the world phase of the first quarter this session resolves. Until then every sector sits at its baseline of 100 and nothing upstream can squeeze anything downstream."
      />
    );
  }

  return (
    <div className={cx('flex flex-col gap-2.5', className)}>
      {tiles.map((tile) => (
        <FlowRow key={tile.sector} tile={tile} tiles={tiles} onOpenCause={onOpenCause} />
      ))}
      <p className="text-[10.5px] leading-relaxed text-ink-faint">
        The index is a whole number against a baseline of {SECTOR_PRICE_BASELINE}, bounded to 25–175 and reachable at
        each end by a two-to-one imbalance. It is struck on last quarter&apos;s revenue, which is what makes it
        plannable.
      </p>
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function FlowRow({
  tile,
  tiles,
  onOpenCause,
}: {
  readonly tile: FlowTile;
  readonly tiles: readonly FlowTile[];
  readonly onOpenCause?: (eventId: string) => void;
}): React.JSX.Element {
  const row = tile.row;
  const index = row?.priceIndex ?? SECTOR_PRICE_BASELINE;
  const before = row?.priceIndexBefore ?? index;
  const tone = priceIndexTone(index);
  const badge = shortageBadge(row);
  const axis = Math.max(1, row?.demandUsd ?? 0, row?.supplyUsd ?? 0);
  const openable = onOpenCause !== undefined && row?.causeEventId != null;

  return (
    <section
      className={cx('panel-surface px-3 py-2.5', tile.isOwn && 'border-brand/40')}
      style={tile.isOwn ? { boxShadow: `inset 3px 0 0 0 ${SECTOR_TINT[tile.sector]}` } : undefined}
    >
      <header className="flex items-start justify-between gap-2">
        <span className="flex min-w-0 items-center gap-2">
          <span
            className="flex size-7 shrink-0 items-center justify-center rounded-chip"
            style={{ backgroundColor: `color-mix(in srgb, ${SECTOR_TINT[tile.sector]} 18%, var(--color-panel))` }}
          >
            <Icon name={tile.icon} size={15} accent="current" />
          </span>
          <span className="min-w-0">
            <span className="block truncate text-[13px] font-semibold text-ink">{tile.label}</span>
            <span className="block truncate text-[10px] text-ink-faint">
              {tile.isOwn ? 'Your group sells here' : 'You buy from here'}
            </span>
          </span>
        </span>
        <span className="flex shrink-0 items-baseline gap-1.5">
          {badge === null ? null : <Tag tone="warn" dot>{badge}</Tag>}
          <span className={cx('figure text-[22px] leading-none font-bold', `tone-${tone}`)}>{indexLabel(index)}</span>
        </span>
      </header>

      {/* The index on its own hard range: 25 at the left, 175 at the right, and
          the anchor of 100 marked, so "dear" and "cheap" are a position rather
          than a number to remember. */}
      {row === null ? null : (
        <div className="relative mt-2 h-2 w-full overflow-hidden rounded-pill bg-raised">
          <span
            className={cx('absolute inset-y-0 rounded-pill', TONE_FILL[tone])}
            style={{
              left: `${Math.min(PRICE_BASELINE_FRACTION, priceIndexFraction(index)) * 100}%`,
              width: `${Math.abs(priceIndexFraction(index) - PRICE_BASELINE_FRACTION) * 100}%`,
            }}
          />
          <span
            aria-hidden="true"
            className="absolute inset-y-0 w-px bg-ink-faint"
            style={{ left: `${PRICE_BASELINE_FRACTION * 100}%` }}
          />
        </div>
      )}

      {/* Twin bars: demand over supply. The imbalance between them is the whole
          explanation of the number above, so cause sits above effect. */}
      {row === null ? null : (
        <div className="mt-2 flex flex-col gap-1">
          <TwinBar label="Demand" valueUsd={row.demandUsd} axisUsd={axis} tone="info" />
          <TwinBar label="Supply" valueUsd={row.supplyUsd} axisUsd={axis} tone="gain" />
        </div>
      )}

      {row === null ? null : (
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-ink-faint">
          <span>
            Imbalance <span className={cx('figure', row.imbalancePct >= 0 ? 'tone-warn' : 'tone-info')}>{row.imbalancePct}%</span>
          </span>
          <span>
            Last quarter <span className="figure text-ink-dim">{indexLabel(before)}</span>
          </span>
          <span>
            Delivery gate <span className="figure text-ink-dim">{row.gatePct}%</span>
          </span>
          <span>
            Repriced share <span className="figure text-ink-dim">{row.tradeSharePct}%</span>
          </span>
        </div>
      )}

      {/* The links. An input the group already produces is drawn as internal;
          everything else is bought at the market index shown on its arrow. */}
      {tile.inputs.length === 0 ? (
        <p className="mt-2 text-[10.5px] leading-snug text-ink-faint">
          Buys nothing the chain tracks. Its costs are its own.
        </p>
      ) : (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <span className="label-caps-faint">Buys</span>
          {tile.inputs.map((input) => {
            const source = tiles.find((entry) => entry.sector === input) ?? null;
            const inputIndex = source?.row?.priceIndex ?? SECTOR_PRICE_BASELINE;
            const internal = tile.internalInputs.includes(input);
            const short = shortageBadge(source?.row ?? null);
            return (
              <span
                key={input}
                title={internal ? 'Your own group supplies this link' : 'Bought at the market index'}
                className={cx(
                  'inline-flex items-center gap-1 rounded-pill border px-2 py-px text-[10px] font-semibold',
                  internal ? 'border-brand/40 bg-brand-wash text-brand' : 'border-hair bg-raised text-ink-dim',
                )}
              >
                <Icon name={internal ? 'network' : 'chevronRight'} size={10} accent="current" />
                {sectorLabel(input)}
                <span className="figure">{indexLabel(inputIndex)}</span>
                {short === null ? null : <span className="tone-loss">{short}</span>}
              </span>
            );
          })}
        </div>
      )}

      {openable ? (
        <button
          type="button"
          className="btn btn-ghost btn-sm tap-target mt-2 gap-1.5 px-2 sm:min-h-0"
          onClick={() => onOpenCause?.(row?.causeEventId as string)}
        >
          <Icon name="ledger" size={14} accent="current" />
          Why this price
        </button>
      ) : null}
    </section>
  );
}

function TwinBar({
  label,
  valueUsd,
  axisUsd,
  tone,
}: {
  readonly label: string;
  readonly valueUsd: number;
  readonly axisUsd: number;
  readonly tone: 'info' | 'gain';
}): React.JSX.Element {
  const pct = Math.max(0, Math.min(100, (valueUsd / axisUsd) * 100));
  return (
    <div className="flex items-center gap-2">
      <span className="label-caps-faint w-[52px] shrink-0">{label}</span>
      <span className="relative h-3 min-w-0 flex-1 overflow-hidden rounded-pill bg-raised">
        <span
          className={cx('absolute inset-y-0 left-0 rounded-pill', tone === 'info' ? 'bg-info' : 'bg-gain')}
          style={{ width: `${pct}%` }}
        />
      </span>
      <span className="figure w-[64px] shrink-0 text-right text-[11px] text-ink-dim">{formatMoney(valueUsd)}</span>
    </div>
  );
}
