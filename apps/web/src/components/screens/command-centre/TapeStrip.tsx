'use client';

/**
 * The tape: your own company first, then the largest listed names.
 *
 * Player Ventures is private at the start of a session, so the first row shows
 * a fundamental anchor rather than a price and says so. That is the starting
 * condition of the game, not an edge case, and the strip is built around it.
 *
 * Each line is a **card row** sized for a thumb: the ticker badge, the name, the
 * shape of the last few closes and the price stacked over its change. The
 * unlisted row carries a drawn vault rather than an invented four-letter
 * monogram — there is no such ticker, and a mark says "not on the exchange"
 * faster than a word does.
 */

import Link from 'next/link';
import type { PlayerView, SessionState } from '@frontier/contracts';
import { formatMoney, formatPct } from '@frontier/shared';
import { DeltaBadge, Icon, Sparkline, Tag, cx } from '@/components/ui';
import { anchorOf, instrumentRows } from '../reporting/util';

export interface TapeStripProps {
  readonly session: SessionState;
  readonly view: PlayerView;
  /** How many listed names to show alongside your own. */
  readonly limit?: number;
}

const ROW = 'press-pop tap-target flex items-center gap-2.5 px-3 py-2 transition-colors hover:bg-raised';

export function TapeStrip({ session, view, limit = 5 }: TapeStripProps): React.JSX.Element {
  const own = view.ownCompany;
  const rows = instrumentRows(session, view).filter((row) => row.instrument.kind === 'in_world_equity');
  const ownRow = rows.find((row) => row.instrument.companyId === own.id) ?? null;
  const rivals = rows.filter((row) => row.instrument.companyId !== own.id).slice(0, limit);
  const anchor = anchorOf(session, own.id);

  return (
    <div className="flex flex-col">
      {ownRow === null ? (
        <Link href="/capital" className={cx(ROW, 'border-b border-hair bg-brand-wash/40')}>
          <span className="icon-knockout-wash flex size-8 shrink-0 items-center justify-center rounded-chip border border-brand/40 bg-brand-wash text-brand">
            <Icon name="vault" size={16} accent="inherit" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[12.5px] font-medium text-ink">{own.name}</span>
            <span className="block truncate text-[10.5px] text-ink-faint">Fundamental anchor</span>
          </span>
          <span className="flex shrink-0 flex-col items-end gap-0.5">
            <span className="figure text-[12.5px] text-ink">{formatMoney(anchor?.anchorValueUsd ?? 0)}</span>
            <Tag tone="neutral" size="sm">
              unlisted
            </Tag>
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
            className={cx(ROW, 'border-b border-hair last:border-b-0', isOwn ? 'bg-brand-wash/40' : '')}
          >
            <span
              className={cx(
                'figure flex h-8 min-w-12 shrink-0 items-center justify-center rounded-chip border px-1 text-[10px]',
                isOwn ? 'border-brand/40 bg-brand-wash text-brand' : 'border-hair bg-raised text-ink-dim',
              )}
            >
              {row.instrument.symbol}
            </span>
            <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink-dim">{row.companyName}</span>

            <Sparkline
              values={row.history}
              width={52}
              height={20}
              className="shrink-0"
              ariaLabel={`${row.instrument.symbol} price history`}
            />
            <span className="flex shrink-0 flex-col items-end gap-0.5">
              <span className="figure text-[12.5px] text-ink">{quote === null ? '—' : formatMoney(quote.price)}</span>
              {quote === null ? (
                <span className="figure text-[11px] text-ink-faint">—</span>
              ) : (
                <DeltaBadge value={quote.return} format="percent" bare />
              )}
            </span>
          </Link>
        );
      })}

      <p className="border-t border-hair px-3 py-2.5 text-[11px] text-ink-faint">
        Quarterly closes on the in-world exchange.
        {anchor === null ? null : ` Your anchor is ${formatMoney(anchor.anchorValueUsd)} at ${formatPct(anchor.confidence)} confidence.`}
      </p>
    </div>
  );
}
