'use client';

/**
 * A financial statement rendered as rows.
 *
 * Not a `DataTable`: a statement is a fixed sequence of labelled lines with
 * subtotals and rules, and it reads better as one. Every figure is right
 * aligned in the tabular face so a column of dollars lines up on the decimal,
 * and any line can be made to open the ledger rows behind it.
 */

import type { ReactNode } from 'react';
import { cx, type Tone } from '@/components/ui';

export interface StatementRow {
  readonly key: string;
  readonly label: ReactNode;
  /** Already formatted through `@frontier/shared`. */
  readonly value: ReactNode;
  /** A second, narrower column: a margin, a share, a rate. */
  readonly secondary?: ReactNode;
  readonly tone?: Tone;
  /** Indent a component of the subtotal above or below it. */
  readonly indent?: boolean;
  /** Subtotals and totals: heavier weight and a rule above. */
  readonly emphasis?: boolean;
  /** Opens the ledger rows behind this line. */
  readonly onClick?: () => void;
  readonly hint?: ReactNode;
}

export interface StatementTableProps {
  readonly rows: readonly StatementRow[];
  /** Column heading above the figures, e.g. the quarter label. */
  readonly valueHeader?: ReactNode;
  readonly secondaryHeader?: ReactNode;
  readonly className?: string;
}

export function StatementTable({ rows, valueHeader, secondaryHeader, className }: StatementTableProps): React.JSX.Element {
  return (
    <div className={cx('min-w-0', className)}>
      {valueHeader !== undefined || secondaryHeader !== undefined ? (
        <div className="flex items-baseline justify-between gap-3 border-b border-hair pb-1.5">
          <span className="label-caps-faint">Line</span>
          <span className="flex items-baseline gap-4">
            {valueHeader !== undefined ? <span className="label-caps-faint w-24 text-right">{valueHeader}</span> : null}
            {secondaryHeader !== undefined ? <span className="label-caps-faint w-16 text-right">{secondaryHeader}</span> : null}
          </span>
        </div>
      ) : null}

      {rows.map((row) => {
        const body = (
          <>
            <span className="min-w-0 flex-1">
              <span
                className={cx(
                  'block sm:truncate',
                  row.emphasis === true ? 'text-[12px] font-semibold text-ink' : 'text-[12px] text-ink-dim',
                  row.indent === true ? 'pl-3' : '',
                )}
              >
                {row.label}
              </span>
              {row.hint !== undefined ? <span className="block truncate text-[10px] text-ink-faint">{row.hint}</span> : null}
            </span>
            <span className="flex shrink-0 items-baseline gap-4">
              <span
                className={cx(
                  'figure w-24 text-right text-[12px]',
                  row.tone === undefined ? (row.emphasis === true ? 'text-ink' : 'text-ink-dim') : `tone-${row.tone}`,
                  row.emphasis === true ? 'font-semibold' : '',
                )}
              >
                {row.value}
              </span>
              {row.secondary !== undefined ? (
                <span className="figure w-16 text-right text-[11px] text-ink-faint">{row.secondary}</span>
              ) : null}
            </span>
          </>
        );

        const rowClasses = cx(
          'flex w-full items-baseline justify-between gap-3 py-1.5 text-left max-sm:min-h-11 max-sm:items-center',
          row.emphasis === true ? 'border-t border-hair-strong' : 'border-t border-hair/50',
        );

        return row.onClick === undefined ? (
          <div key={row.key} className={rowClasses}>
            {body}
          </div>
        ) : (
          <button
            key={row.key}
            type="button"
            onClick={row.onClick}
            title="Open the ledger rows behind this line"
            className={cx(rowClasses, 'rounded-[3px] transition-colors hover:bg-raised')}
          >
            {body}
          </button>
        );
      })}
    </div>
  );
}
