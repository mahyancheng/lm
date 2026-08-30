'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import type { DeltaFormat } from '@frontier/shared';
import { DeltaBadge } from './DeltaBadge';
import { Sparkline } from './Charts';
import { IconChip, isIconName, type IconName } from './icons';
import { TONE_CHIP, cx, type Tone } from './tokens';

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
  /**
   * A flat vector glyph in a tinted rounded square, left of the label.
   * Optional and additive: a card without one keeps its old shape.
   */
  readonly icon?: ReactNode;
  /**
   * The usual way to give a card its mark: a name from the icon set. Takes
   * precedence over `icon` when both are given.
   */
  readonly iconName?: IconName;
  /** Tint for the icon chip. Defaults to the card's `tone`, then neutral. */
  readonly iconTone?: Tone;
  /** Makes the whole card a link to the screen that explains this number. */
  readonly href?: string;
  readonly onClick?: () => void;
  readonly className?: string;
}

/**
 * One figure with its change and, where it helps, its recent shape.
 *
 * Every derived number should be able to open its working: pass `href` to the
 * screen that decomposes it. The figure keeps the tabular monospace face —
 * money stays legible however friendly the card around it gets.
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
  icon,
  iconName,
  iconTone,
  href,
  onClick,
  className,
}: StatCardProps): React.JSX.Element {
  const interactive = href !== undefined || onClick !== undefined;
  // `icon` takes a node for the cards drawn before the set existed; a bare
  // name from the set is understood too.
  const mark = iconName ?? (isIconName(icon) ? icon : undefined);

  const body = (
    <>
      <div className="flex items-start justify-between gap-2">
        <span className="flex min-w-0 items-center gap-2">
          {mark !== undefined ? (
            <IconChip name={mark} tone={iconTone ?? tone ?? 'neutral'} size="sm" />
          ) : icon !== undefined ? (
            <span
              aria-hidden="true"
              className={cx(
                'flex size-6 shrink-0 items-center justify-center rounded-chip border text-[12px] leading-none',
                TONE_CHIP[iconTone ?? tone ?? 'neutral'],
              )}
            >
              {icon}
            </span>
          ) : null}
          <span className="label-caps sm:truncate">{label}</span>
        </span>
        {delta !== undefined ? <DeltaBadge value={delta} format={deltaFormat} invert={deltaInvert} bare /> : null}
      </div>
      <div className="mt-2 flex items-end justify-between gap-2">
        <div className="min-w-0">
          <span
            className={cx(
              'figure animate-count-up inline-block text-[21px] leading-none font-semibold',
              tone === undefined ? 'text-ink' : `tone-${tone}`,
            )}
          >
            {value}
          </span>
          {unit !== undefined ? <span className="ml-1 text-[11px] text-ink-faint">{unit}</span> : null}
        </div>
        {spark !== undefined && spark.length > 1 ? <Sparkline values={spark} width={72} height={24} /> : null}
      </div>
      {hint !== undefined ? <p className="mt-1.5 truncate text-[10px] text-ink-faint">{hint}</p> : null}
    </>
  );

  const classes = cx(
    'panel-surface animate-pop-in block min-w-0 px-3.5 py-3 text-left',
    interactive ? 'hover-lift press-pop hover:border-hair-strong' : '',
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
