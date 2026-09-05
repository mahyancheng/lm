'use client';

import type { ReactNode } from 'react';
import { cx } from './tokens';

export interface SectionHeadingProps {
  readonly children: ReactNode;
  /** Right-aligned controls on the same baseline. */
  readonly actions?: ReactNode;
  /** Draw a hairline under the heading. */
  readonly rule?: boolean;
  readonly className?: string;
}

/** A small-caps divider inside a panel body. Never used as a panel title. */
export function SectionHeading({ children, actions, rule = false, className }: SectionHeadingProps): React.JSX.Element {
  return (
    <div
      className={cx(
        'flex items-center justify-between gap-3',
        rule ? 'border-b border-hair pb-2' : '',
        className,
      )}
    >
      <h3 className="label-caps">{children}</h3>
      {actions !== undefined ? <div className="flex items-center gap-1.5">{actions}</div> : null}
    </div>
  );
}

export interface PageHeaderProps {
  /** The screen name, e.g. "Command Centre". */
  readonly title: string;
  /** One line of orientation under the title. */
  readonly subtitle?: ReactNode;
  /** Eyebrow above the title: the group, the quarter, a company name. */
  readonly eyebrow?: ReactNode;
  /** Right-aligned page-level controls. */
  readonly actions?: ReactNode;
  readonly className?: string;
}

/**
 * The first row of every screen.
 *
 * The layout convention is: `PageHeader`, then a grid of `Panel`s. Screens do
 * not invent their own title treatment.
 */
export function PageHeader({ title, subtitle, eyebrow, actions, className }: PageHeaderProps): React.JSX.Element {
  return (
    <header className={cx('animate-pop-in flex flex-wrap items-end justify-between gap-3', className)}>
      <div className="min-w-0">
        {eyebrow !== undefined ? (
          <div className="label-caps mb-1.5 inline-flex items-center rounded-pill bg-brand-wash px-2.5 py-0.5 text-brand">
            {eyebrow}
          </div>
        ) : null}
        <h1 className="truncate text-[22px] leading-tight font-extrabold text-ink">{title}</h1>
        {subtitle !== undefined ? <p className="mt-1 max-w-3xl text-[12.5px] text-ink-dim">{subtitle}</p> : null}
      </div>
      {actions !== undefined ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}
