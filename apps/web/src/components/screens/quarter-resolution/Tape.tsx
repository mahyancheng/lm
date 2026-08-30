'use client';

/**
 * The price tape.
 *
 * A flat paper strip with punched edges, one card per instrument, sorted by the
 * quarter's return so the winner and the loser are the two ends of the same
 * object. The percentage counts up from flat to what the market actually did;
 * the dot beside a real mover pulses. Both are presentation — the number, the
 * sort and the highlight all come from the quotes the engine committed.
 *
 * The strip scrolls inside itself, so a fifteen-instrument market never widens
 * the page on a phone.
 */

import Link from 'next/link';
import { formatMoney, formatPct } from '@frontier/shared';
import { cx } from '@/components/ui';
import { CountUp } from './CountUp';

export interface PriceRow {
  readonly instrumentId: string;
  readonly symbol: string;
  readonly name: string;
  readonly price: number;
  readonly quarterReturn: number;
  readonly marketCapUsd: number;
  readonly volume: number;
  readonly isOwn: boolean;
}

/** A move worth a pulse. Below this the dot is a quiet marker. */
const NOTABLE_MOVE = 0.05;

export interface PriceTapeProps {
  readonly rows: readonly PriceRow[];
  /** False when the player has asked to skip the reveal: figures land settled. */
  readonly reveal?: boolean;
}

export function PriceTape({ rows, reveal = true }: PriceTapeProps): React.JSX.Element {
  if (rows.length === 0) {
    return (
      <p className="px-4 py-3 text-[11px] text-ink-faint">
        No in-world instrument produced a quote this quarter. A private company has no instrument at all — that is the starting condition,
        not an error.
      </p>
    );
  }

  return (
    <div className="border-y border-dashed border-hair-strong bg-raised">
      {/* Thumb-sized cards that snap: a phone flicks along the tape one
          instrument at a time, and the strip scrolls inside its own box. */}
      <div className="scroll-x flex snap-x snap-mandatory items-stretch gap-2 px-3 py-2.5 sm:snap-none">
        {rows.map((row, index) => {
          const up = row.quarterReturn >= 0;
          const notable = Math.abs(row.quarterReturn) >= NOTABLE_MOVE;
          return (
            <Link
              key={row.instrumentId}
              href="/markets"
              className={cx(
                'animate-pop-in hover-lift press-pop flex min-h-[76px] w-[168px] shrink-0 snap-start flex-col justify-center rounded-card border bg-panel px-3 py-2.5',
                row.isOwn ? 'border-brand' : 'border-hair',
              )}
              style={reveal ? { animationDelay: `${Math.min(index * 45, 540)}ms` } : undefined}
              title={`${row.name} — ${formatPct(row.quarterReturn)} this quarter`}
            >
              <div className="flex items-center gap-1.5">
                <span
                  aria-hidden="true"
                  className={cx(
                    'inline-block size-1.5 shrink-0 rounded-pill',
                    up ? 'bg-gain' : 'bg-loss',
                    notable ? 'animate-pulse-soft' : '',
                  )}
                />
                <span className="figure min-w-0 flex-1 truncate text-[11.5px] font-semibold text-ink">{row.symbol}</span>
                {row.isOwn ? <span className="label-caps-faint shrink-0 text-brand">You</span> : null}
              </div>
              <div className="mt-1.5 flex items-baseline justify-between gap-2">
                <span className="figure text-[13.5px] leading-none text-ink">{formatMoney(row.price)}</span>
                <CountUp
                  value={row.quarterReturn}
                  from={0}
                  enabled={reveal}
                  delayMs={Math.min(index * 45, 540)}
                  format={(value) => `${value >= 0 ? '▲' : '▼'} ${formatPct(Math.abs(value))}`}
                  className={cx('figure shrink-0 text-[11px] leading-none font-semibold', up ? 'tone-gain' : 'tone-loss')}
                />
              </div>
              <span className="mt-1 truncate text-[10px] text-ink-faint">{row.name}</span>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
