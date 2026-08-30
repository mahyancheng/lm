'use client';

import { formatDelta, type DeltaFormat } from '@frontier/shared';
import { TONE_CHIP, cx, toneOfDelta, type Tone } from './tokens';

export interface DeltaBadgeProps {
  /** The signed change, in the units `format` names. */
  readonly value: number;
  /** `percent` for a fractional change, `points` for a percentage-point change. */
  readonly format?: DeltaFormat;
  /** Decimal places; the formatter's default when omitted. */
  readonly decimals?: number;
  /** Flip the colour convention, for figures where down is good (churn, burn, attrition). */
  readonly invert?: boolean;
  /** Force a tone rather than deriving it from the sign. */
  readonly tone?: Tone;
  /** Show the ▲ / ▼ mark alongside the number. */
  readonly arrow?: boolean;
  /** Render as bare coloured text rather than a chip. */
  readonly bare?: boolean;
  readonly className?: string;
}

/**
 * A signed change label.
 *
 * Almost every figure in this game has a previous value; the whole loop is
 * quarter over quarter. Show the change and its direction.
 */
export function DeltaBadge({
  value,
  format = 'percent',
  decimals,
  invert = false,
  tone,
  arrow = true,
  bare = false,
  className,
}: DeltaBadgeProps): React.JSX.Element {
  const resolved = tone ?? toneOfDelta(value, invert);
  const label = formatDelta(value, format, decimals);
  const mark = !arrow || value === 0 ? '' : value > 0 ? '▲' : '▼';

  if (bare) {
    return (
      <span className={cx('figure text-[11px] font-semibold', `tone-${resolved}`, className)}>
        {mark === '' ? null : <span className="mr-0.5 text-[9px]">{mark}</span>}
        {label}
      </span>
    );
  }

  return (
    <span
      className={cx(
        'figure inline-flex items-center gap-0.5 rounded-pill border px-2 py-px text-[11px] leading-[17px] font-semibold',
        TONE_CHIP[resolved],
        className,
      )}
    >
      {mark === '' ? null : <span className="text-[8px]">{mark}</span>}
      {label}
    </span>
  );
}
