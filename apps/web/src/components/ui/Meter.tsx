'use client';

import type { ReactNode } from 'react';
import { TONE_VAR, cx, type Tone } from './tokens';

export interface MeterProps {
  /** A 0..100 score: morale, reputation, connection level, support. */
  readonly value: number;
  readonly label?: ReactNode;
  /** Force a tone; otherwise it is derived from the band the value falls in. */
  readonly tone?: Tone;
  /** Draw a marker at another value: the market, a rival, last quarter. */
  readonly benchmark?: number;
  readonly benchmarkLabel?: string;
  /** Show the number beside the bar. */
  readonly showValue?: boolean;
  readonly className?: string;
}

/** Low is a problem, high is not — the standard reading for a 0..100 score. */
function bandTone(value: number): Tone {
  if (value >= 70) return 'gain';
  if (value >= 45) return 'info';
  if (value >= 25) return 'warn';
  return 'loss';
}

/**
 * A 0..100 score with its band.
 *
 * Used for every score the engine keeps on that scale: morale, the five
 * reputation audiences, connection level, director support, contractor past
 * performance.
 */
export function Meter({ value, label, tone, benchmark, benchmarkLabel, showValue = true, className }: MeterProps): React.JSX.Element {
  const clamped = Math.max(0, Math.min(100, value));
  const resolved = tone ?? bandTone(clamped);

  return (
    <div className={cx('min-w-0', className)}>
      {label !== undefined || showValue ? (
        <div className="mb-1 flex items-baseline justify-between gap-2">
          {label !== undefined ? <span className="label-caps-faint truncate">{label}</span> : <span />}
          {showValue ? (
            <span className={cx('figure text-[11px] font-semibold', `tone-${resolved}`)}>{Math.round(clamped)}</span>
          ) : null}
        </div>
      ) : null}
      <div className="relative h-2.5 w-full overflow-hidden rounded-pill bg-raised">
        <div
          className="h-full rounded-pill transition-[width] duration-500 ease-out"
          style={{ width: `${clamped}%`, backgroundColor: TONE_VAR[resolved] }}
        />
        {benchmark !== undefined ? (
          <span
            title={benchmarkLabel ?? `Benchmark ${Math.round(benchmark)}`}
            className="absolute top-[-2px] h-[14px] w-[2px] rounded-pill bg-ink-dim"
            style={{ left: `${Math.max(0, Math.min(100, benchmark))}%` }}
          />
        ) : null}
      </div>
    </div>
  );
}
