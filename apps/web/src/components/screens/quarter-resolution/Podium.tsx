'use client';

/**
 * Rank movement, as podium steps.
 *
 * The three boards this quarter left you highest on, drawn as a podium: the
 * best in the middle and tallest, the next two either side. The rank figure
 * *counts from where you were to where you are*, which is the movement itself —
 * `previousRank` to `rank`, both from the leaderboard the engine recomputed.
 *
 * A board with no previous rank is new, and counts from nothing; it simply
 * arrives. The full table under this panel remains the record — the podium is
 * the three lines of it that are worth a drum roll.
 */

import Link from 'next/link';
import { formatPct, formatRankMove } from '@frontier/shared';
import { Tag, cx } from '@/components/ui';
import { CountUp } from './CountUp';
import { PodiumFigure } from './Art';
import { PODIUM_HEIGHTS, podiumOrder } from './theatre';

export interface RankRow {
  readonly board: string;
  readonly label: string;
  readonly rank: number;
  readonly previousRank: number | null;
  readonly value: number;
  readonly percentile: number;
}

export interface RankPodiumProps {
  readonly rows: readonly RankRow[];
  /** False when the player has asked to skip the reveal: figures land settled. */
  readonly reveal?: boolean;
}

export function RankPodium({ rows, reveal = true }: RankPodiumProps): React.JSX.Element | null {
  if (rows.length === 0) return null;

  const steps = podiumOrder(rows, (row) => row.percentile);
  const top = steps.filter((row): row is RankRow => row !== null);

  return (
    <div className="flex flex-col">
      <div className="grid grid-cols-3 items-end gap-2">
        {steps.map((row, index) => {
          if (row === null) return <div key={`empty-${index}`} aria-hidden="true" />;
          const move = formatRankMove(row.previousRank, row.rank);
          const improved = row.previousRank !== null && row.rank < row.previousRank;
          const best = index === 1;
          const tone = move === null ? 'neutral' : move === 'new' ? 'info' : improved ? 'gain' : 'loss';
          return (
            <Link
              key={row.board}
              href="/leaderboard"
              className="animate-pop-in press-pop flex min-w-0 flex-col items-center gap-1.5 rounded-card focus-visible:outline-2"
              style={reveal ? { animationDelay: `${index * 110}ms` } : undefined}
              title={`${row.board.replace(/_/g, ' ')} — rank ${row.rank}`}
            >
              {best ? <PodiumFigure className="animate-bob h-8 w-6" /> : <span className="h-8" aria-hidden="true" />}

              <CountUp
                value={row.rank}
                from={row.previousRank ?? row.rank}
                enabled={reveal}
                delayMs={index * 110}
                format={(value) => `#${Math.max(1, Math.round(value))}`}
                className={cx('figure leading-none font-semibold', best ? 'text-[24px] text-ink' : 'text-[18px] text-ink-dim')}
              />

              <Tag tone={tone} size="sm">
                {move === null ? 'held' : move === 'new' ? 'new' : move}
              </Tag>

              <div
                className={cx(
                  'flex w-full min-w-0 items-start justify-center rounded-t-card border border-b-0 px-1.5 pt-2',
                  best ? 'border-brand/40 bg-brand-wash' : 'border-hair bg-raised',
                )}
                style={{ height: PODIUM_HEIGHTS[index] }}
              >
                <span
                  className={cx(
                    'w-full text-center text-[10px] leading-tight font-semibold break-words',
                    best ? 'text-brand' : 'text-ink-dim',
                  )}
                >
                  {row.board.replace(/_/g, ' ')}
                </span>
              </div>
            </Link>
          );
        })}
      </div>

      <div className="h-1.5 rounded-pill bg-hair-strong" aria-hidden="true" />

      <p className="mt-2 text-center text-[10px] leading-relaxed text-ink-faint">
        The {top.length === 1 ? 'board' : 'boards'} you sit highest on by percentile, counted from where you were to where you are. Every
        figure is the leaderboard the ledger recomputed —{' '}
        {top.map((row) => `${row.board.replace(/_/g, ' ')} ${formatPct(row.percentile, 0)}`).join(' · ')}.
      </p>
    </div>
  );
}
