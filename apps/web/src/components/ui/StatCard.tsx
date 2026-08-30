'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import type { DeltaFormat } from '@frontier/shared';
import { DeltaBadge } from './DeltaBadge';
import { Sparkline } from './Charts';
import { cx, type Tone } from './tokens';

export interface StatCardProps {
  /** Small-caps label, e.g. "Market Cap". */
  readonly label: string;
  /** The figure, already formatted with `@frontier/shared`. */
  readonly value: ReactNode;
  /** Unit or qualifier shown after the figure, e.g. "mo", "FTE". */
  readonly unit?: string;
  /** Signed change since last quarter. */
  readonly delta?: number;
  readonly deltaFormat?: DeltaFormat;
  /** Flip the colour convention for figures where down is good. */
  readonly deltaInvert?: boolean;
  /** A short trend series; rendered as a sparkline on the right. */
  readonly spark?: readonly number[];
  /** Colour the figure itself. Use sparingly — colour means something. */
  readonly tone?: Tone;
  /** One line under the figure: the working, the source, the caveat. */
  readonly hint?: ReactNode;
  /** Makes the whole card a link to the screen that explains this number. */
  readonly href?: string;
  readonly onClick?: () => void;
  readonly className?: string;
}

/**
 * One figure with its change and, where it helps, its recent shape.
 *
 * Every derived number should be able to open its working: pass `href` to the
 * screen that decomposes it.
 */
export function StatCard({
  label,
  value,
  unit,
  delta,
  deltaFormat = 'percent',
  deltaInvert = false,
  spark,
  tone,
  hint,
  href,
  onClick,
  className,
}: StatCardProps): React.JSX.Element {
  const interactive = href !== undefined || onClick !== undefined;

  const body = (
    <>
      <div className="flex items-start justify-between gap-2">
        <span className="label-caps truncate">{label}</span>
        {delta !== undefined ? <DeltaBadge value={delta} format={deltaFormat} invert={deltaInvert} bare /> : null}
      </div>
      <div className="mt-1.5 flex items-end justify-between gap-2">
        <div className="min-w-0">
          <span className={cx('figure text-[19px] leading-none font-medium', tone === undefined ? 'text-ink' : `tone-${tone}`)}>
            {value}
          </span>
          {unit !== undefined ? <span className="ml-1 text-[11px] text-ink-faint">{unit}</span> : null}
        </div>
        {spark !== undefined && spark.length > 1 ? <Sparkline values={spark} width={72} height={22} /> : null}
      </div>
      {hint !== undefined ? <p className="mt-1.5 truncate text-[10px] text-ink-faint">{hint}</p> : null}
    </>
  );

  const classes = cx(
    'panel-surface block min-w-0 px-3 py-2.5 text-left',
    interactive ? 'transition-colors hover:border-hair-strong hover:bg-raised' : '',
    className,
  );

  if (href !== undefined) {
    return (
      <Link href={href} className={classes}>
        {body}
      </Link>
    );
  }
  if (onClick !== undefined) {
    return (
      <button type="button" onClick={onClick} className={classes}>
        {body}
      </button>
    );
  }
  return <div className={classes}>{body}</div>;
}
