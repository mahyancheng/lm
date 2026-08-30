'use client';

/**
 * The tape: your own company first, then the largest listed names.
 *
 * Player Ventures is private at the start of a session, so the first row shows
 * a fundamental anchor rather than a price and says so. That is the starting
 * condition of the game, not an edge case, and the strip is built around it.
 */

import Link from 'next/link';
import type { PlayerView, SessionState } from '@frontier/contracts';
import { formatMoney, formatPct } from '@frontier/shared';
import { DeltaBadge, Sparkline, Tag, cx } from '@/components/ui';
import { anchorOf, instrumentRows } from '../reporting/util';

export interface TapeStripProps {
  readonly session: SessionState;
  readonly view: PlayerView;
  /** How many listed names to show alongside your own. */
  readonly limit?: number;
}

export function TapeStrip({ session, view, limit = 5 }: TapeStripProps): React.JSX.Element {
  const own = view.ownCompany;
  const rows = instrumentRows(session, view).filter((row) => row.instrument.kind === 'in_world_equity');
  const ownRow = rows.find((row) => row.instrument.companyId === own.id) ?? null;
  const rivals = rows.filter((row) => row.instrument.companyId !== own.id).slice(0, limit);
  const anchor = anchorOf(session, own.id);

  return (
    <div className="flex flex-col">
      {ownRow === null ? (
        <Link
          href="/capital"
          className="flex items-center justify-between gap-3 border-b border-hair px-1 py-2 transition-colors hover:bg-raised"
        >
          <span className="flex min-w-0 items-center gap-2">
            <span className="figure flex h-5 min-w-11 items-center justify-center rounded-[3px] border border-brand/40 bg-brand-wash px-1 text-[9px] text-brand">
              PRIV
            </span>
            <span className="truncate text-[12px] font-medium text-ink">{own.name}</span>
          </span>
          <span className="flex shrink-0 items-center gap-3">
            <span className="figure text-[12px] text-ink">{formatMoney(anchor?.anchorValueUsd ?? 0)}</span>
            <Tag tone="neutral">unlisted</Tag>
          </span>
        </Link>
      ) : null}

      {(ownRow === null ? rivals : [ownRow, ...rivals]).map((row) => {
        const isOwn = row.instrument.companyId === own.id;
        const quote = row.quote;
        return (
          <Link
            key={row.instrument.id}
            href="/markets"
            className={cx(
              'flex items-center justify-between gap-3 border-b border-hair px-1 py-2 transition-colors last:border-b-0 hover:bg-raised',
              isOwn ? 'bg-brand-wash/40' : '',
            )}
          >
            <span className="flex min-w-0 items-center gap-2">
              <span
                className={cx(
                  'figure flex h-5 min-w-11 items-center justify-center rounded-[3px] border px-1 text-[9px]',
                  isOwn ? 'border-brand/40 bg-brand-wash text-brand' : 'border-hair bg-raised text-ink-dim',
                )}
              >
                {row.instrument.symbol}
              </span>
              <span className="truncate text-[12px] text-ink-dim">{row.companyName}</span>
            </span>

            <span className="flex shrink-0 items-center gap-3">
              <Sparkline values={row.history} width={64} height={20} ariaLabel={`${row.instrument.symbol} price history`} />
              <span className="figure w-16 text-right text-[12px] text-ink">
                {quote === null ? '—' : formatMoney(quote.price)}
              </span>
              <span className="w-14 text-right">
                {quote === null ? (
                  <span className="figure text-[11px] text-ink-faint">—</span>
                ) : (
                  <DeltaBadge value={quote.return} format="percent" bare />
                )}
              </span>
            </span>
          </Link>
        );
      })}

      <p className="mt-2 text-[10px] text-ink-faint">
        Quarterly closes on the in-world exchange.
        {anchor === null ? null : ` Your anchor is ${formatMoney(anchor.anchorValueUsd)} at ${formatPct(anchor.confidence)} confidence.`}
      </p>
    </div>
  );
}
