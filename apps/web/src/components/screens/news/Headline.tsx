'use client';

/**
 * A headline that fits.
 *
 * Given a ladder of sizes and a line budget, the largest size at which the
 * text fits wins, and the block is narrowed to the width that balances its
 * lines — so the last line is never one orphaned word. The browser does the
 * final wrapping at that width with the same font, so what pretext measured is
 * what paints. Without a measurer (the server, the first client render) the
 * text is set at the largest size across the full width with CSS
 * `text-wrap: balance`, and re-fits once after mount.
 */

import { memo, type CSSProperties, type ElementType } from 'react';
import { cx } from '@/components/ui';
import { fitHeadline, type Measurer } from '@/lib/text/measure';

export interface FittedHeadlineProps {
  readonly text: string;
  /** Sizes to try, largest first. */
  readonly sizes: readonly number[];
  readonly maxLines: number;
  readonly widthPx: number;
  readonly measurer: Measurer | null;
  readonly serif: string;
  readonly leading?: number;
  readonly weight?: number;
  readonly as?: ElementType;
  readonly className?: string;
  readonly id?: string;
}

function FittedHeadlineInner({
  text,
  sizes,
  maxLines,
  widthPx,
  measurer,
  serif,
  leading = 1.1,
  weight = 700,
  as: Tag = 'h2',
  className,
  id,
}: FittedHeadlineProps): React.JSX.Element {
  const fitted = fitHeadline(text, { family: serif, weight, leading, sizes, maxLines, maxWidthPx: widthPx }, measurer);
  const style: CSSProperties = {
    fontSize: `${fitted.sizePx}px`,
    lineHeight: leading,
    // The balanced width. Left as the full column when unmeasured so the
    // browser's own balancing has the whole line to work with.
    maxWidth: fitted.widthPx < widthPx ? `${fitted.widthPx}px` : undefined,
  };
  return (
    <Tag id={id} className={cx('np-headline', className)} style={style} data-fitted-size={fitted.sizePx}>
      {text}
    </Tag>
  );
}

export const FittedHeadline = memo(FittedHeadlineInner);

/** The ladders the paper sets its tiers in, in px. */
export const LEAD_SIZES: readonly number[] = [30, 28, 26, 24, 22];
export const TIER_SIZES: readonly number[] = [20, 19, 18, 17];
export const SHEET_SIZES: readonly number[] = [26, 24, 22, 20];
