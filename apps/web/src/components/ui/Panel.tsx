'use client';

import type { ReactNode } from 'react';
import { cx } from './tokens';

export interface PanelProps {
  /** Small-caps heading. Omit for an unlabelled surface. */
  readonly title?: ReactNode;
  /** One line under the title. */
  readonly subtitle?: ReactNode;
  /** Right-aligned controls in the header row: buttons, tabs, a filter. */
  readonly actions?: ReactNode;
  /** Remove the body padding, e.g. when the body is a `DataTable`. */
  readonly flush?: boolean;
  /** Tighter padding for dense metric grids. */
  readonly dense?: boolean;
  /** Cap the body height and scroll inside it. */
  readonly maxBodyHeight?: number;
  readonly className?: string;
  readonly bodyClassName?: string;
  readonly children?: ReactNode;
}

/**
 * The unit every screen is built from: a bordered surface with an optional
 * header row.
 *
 * A page is a header row plus a grid of panels. Panels do not nest.
 */
export function Panel({
  title,
  subtitle,
  actions,
  flush = false,
  dense = false,
  maxBodyHeight,
  className,
  bodyClassName,
  children,
}: PanelProps): React.JSX.Element {
  const hasHeader = title !== undefined || actions !== undefined || subtitle !== undefined;
  return (
    <section className={cx('panel-surface flex min-w-0 flex-col', className)}>
      {hasHeader ? (
        <header className="flex min-h-[38px] shrink-0 items-center justify-between gap-3 border-b border-hair px-3 py-2">
          <div className="min-w-0">
            {title !== undefined ? <h2 className="label-caps truncate">{title}</h2> : null}
            {subtitle !== undefined ? <p className="mt-0.5 truncate text-[11px] text-ink-faint">{subtitle}</p> : null}
          </div>
          {actions !== undefined ? <div className="flex shrink-0 items-center gap-1.5">{actions}</div> : null}
        </header>
      ) : null}
      <div
        className={cx(
          'min-w-0 flex-1',
          flush ? '' : dense ? 'p-2.5' : 'p-3.5',
          maxBodyHeight !== undefined ? 'overflow-y-auto' : '',
          bodyClassName,
        )}
        style={maxBodyHeight !== undefined ? { maxHeight: maxBodyHeight } : undefined}
      >
        {children}
      </div>
    </section>
  );
}
