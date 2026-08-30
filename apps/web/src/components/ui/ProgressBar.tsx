'use client';

import type { ReactNode } from 'react';
import { TONE_FILL, TONE_VAR, cx, type Tone } from './tokens';

export interface ProgressBarProps {
  readonly value: number;
  readonly max?: number;
  readonly tone?: Tone;
  /** Label above the bar. */
  readonly label?: ReactNode;
  /** Right-aligned figure above the bar. Pass a formatted string. */
  readonly valueLabel?: ReactNode;
  readonly height?: number;
  /** A second, fainter bar behind the first: last quarter, or a target. */
  readonly ghostValue?: number;
  readonly className?: string;
}

/** Linear progress: research completion, contract milestones, option pool use. */
export function ProgressBar({
  value,
  max = 1,
  tone = 'brand',
  label,
  valueLabel,
  height = 8,
  ghostValue,
  className,
}: ProgressBarProps): React.JSX.Element {
  const pct = max === 0 ? 0 : Math.max(0, Math.min(100, (value / max) * 100));
  const ghostPct = ghostValue === undefined || max === 0 ? null : Math.max(0, Math.min(100, (ghostValue / max) * 100));

  return (
    <div className={cx('min-w-0', className)}>
      {label !== undefined || valueLabel !== undefined ? (
        <div className="mb-1 flex items-baseline justify-between gap-2">
          {label !== undefined ? <span className="label-caps-faint truncate">{label}</span> : <span />}
          {valueLabel !== undefined ? <span className="figure text-[11px] text-ink-dim">{valueLabel}</span> : null}
        </div>
      ) : null}
      <div className="relative w-full overflow-hidden rounded-pill bg-raised" style={{ height }}>
        {ghostPct !== null ? (
          <div
            className="absolute inset-y-0 left-0 rounded-pill opacity-25"
            style={{ width: `${ghostPct}%`, backgroundColor: TONE_VAR[tone] }}
          />
        ) : null}
        <div
          className={cx('relative h-full rounded-pill transition-[width] duration-500 ease-out', TONE_FILL[tone])}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
