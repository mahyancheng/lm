'use client';

import type { ReactNode } from 'react';
import { cx, type Tone } from './tokens';

export interface KeyValueItem {
  readonly label: ReactNode;
  readonly value: ReactNode;
  /** Colour the value. Use only where the colour means something. */
  readonly tone?: Tone;
  /** Force the monospace tabular face. Defaults to true — most values are figures. */
  readonly mono?: boolean;
  /** A short explanation shown under the value. */
  readonly hint?: ReactNode;
  /** Span the full width of the grid. */
  readonly wide?: boolean;
}

export interface KeyValueGridProps {
  readonly items: readonly KeyValueItem[];
  /** Columns at the `md` breakpoint and above. One column below it, always. */
  readonly columns?: 1 | 2 | 3 | 4;
  /** Stack label above value rather than beside it. */
  readonly stacked?: boolean;
  readonly className?: string;
}

const COLUMN_CLASS: Readonly<Record<1 | 2 | 3 | 4, string>> = {
  1: 'grid-cols-1',
  2: 'grid-cols-1 sm:grid-cols-2',
  3: 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3',
  4: 'grid-cols-2 lg:grid-cols-4',
};

/** Label/value pairs: the anchor inputs, the terms of a contract, a filing header. */
export function KeyValueGrid({ items, columns = 2, stacked = false, className }: KeyValueGridProps): React.JSX.Element {
  return (
    <dl className={cx('grid gap-x-5 gap-y-2', COLUMN_CLASS[columns], className)}>
      {items.map((item, index) => (
        <div
          key={index}
          className={cx(
            stacked ? '' : 'flex items-baseline justify-between gap-3 border-b border-hair/60 pb-1.5',
            item.wide === true ? 'col-span-full' : '',
          )}
        >
          <dt className={cx('label-caps-faint', stacked ? 'mb-0.5' : 'shrink-0')}>{item.label}</dt>
          <dd className="min-w-0">
            <span
              className={cx(
                'text-[12px]',
                (item.mono ?? true) ? 'figure' : '',
                item.tone === undefined ? 'text-ink' : `tone-${item.tone}`,
              )}
            >
              {item.value}
            </span>
            {item.hint !== undefined ? <div className="mt-0.5 text-[10px] text-ink-faint">{item.hint}</div> : null}
          </dd>
        </div>
      ))}
    </dl>
  );
}
