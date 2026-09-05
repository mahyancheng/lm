'use client';

/**
 * The V5 surface: two columns, now on the left and after on the right.
 *
 * Plutocracy states the terms of a decision and never the counterfactual, so a
 * player learns what a payout costs by paying it. This is the fix, and it is
 * deliberately dumb: every figure handed to it is already a string, formatted
 * by the shared formatters at the call site from a **preview function the
 * engine exports**. Nothing here multiplies, divides or rounds anything.
 *
 * It is small enough to sit under a slider thumb on a 390px phone: two columns
 * of one label and one figure, with an optional footnote for the bound that is
 * actually binding ("capped at half of cash").
 */

import type { ReactNode } from 'react';
import { Icon } from './icons';
import { cx, type Tone } from './tokens';

export interface NowAfterRow {
  readonly key: string;
  readonly label: string;
  /** The figure as it stands. Already formatted. */
  readonly now: ReactNode;
  /** The figure this setting would produce. Already formatted. */
  readonly after: ReactNode;
  /** Colours the *after* figure only; the present is never an opinion. */
  readonly tone?: Tone;
}

export interface NowAfterProps {
  readonly rows: readonly NowAfterRow[];
  /** One line under the rows: the bound that bit, or the quarter it lands in. */
  readonly note?: ReactNode;
  /** Headings above the columns. Defaults to "Now" and "After". */
  readonly nowLabel?: string;
  readonly afterLabel?: string;
  readonly className?: string;
}

export function NowAfter({ rows, note, nowLabel = 'Now', afterLabel = 'After', className }: NowAfterProps): React.JSX.Element | null {
  if (rows.length === 0) return null;
  return (
    <div className={cx('raised-surface px-2.5 py-2', className)}>
      <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-baseline gap-x-2 gap-y-1">
        <span className="label-caps-faint">Change</span>
        <span className="label-caps-faint justify-self-end">{nowLabel}</span>
        <span className="label-caps-faint justify-self-end">{afterLabel}</span>

        {rows.map((row) => (
          <div key={row.key} className="contents">
            <span className="min-w-0 truncate text-[11.5px] text-ink-dim">{row.label}</span>
            <span className="figure justify-self-end text-[12px] whitespace-nowrap text-ink-faint">{row.now}</span>
            <span
              className={cx(
                'figure justify-self-end text-[12.5px] font-semibold whitespace-nowrap',
                row.tone === undefined ? 'text-ink' : `tone-${row.tone}`,
              )}
            >
              {row.after}
            </span>
          </div>
        ))}
      </div>
      {note === undefined ? null : (
        <p className="mt-1.5 flex items-start gap-1 text-[10.5px] leading-snug text-ink-faint">
          <Icon name="gauge" size={11} accent="current" className="mt-px shrink-0" />
          {note}
        </p>
      )}
    </div>
  );
}
