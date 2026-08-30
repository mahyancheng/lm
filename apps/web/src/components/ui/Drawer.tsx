'use client';

import { useId, type ReactNode } from 'react';
import { useDialogFocus } from './focusTrap';
import { cx } from './tokens';

export interface DrawerProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly title: ReactNode;
  readonly subtitle?: ReactNode;
  readonly children: ReactNode;
  readonly footer?: ReactNode;
  /** `right` for detail panes, `bottom` for mobile sheets. */
  readonly side?: 'right' | 'bottom';
  readonly width?: number;
  readonly className?: string;
}

/**
 * A side sheet for detail that should not take the player off the screen.
 *
 * The ledger rows behind a figure, a director's card, one node of the Frontier
 * Map: all read better beside the thing they explain than on a route of their
 * own.
 *
 * It declares `aria-modal`, so it keeps the keyboard as well: focus moves in on
 * open, Tab wraps inside, Escape closes and the trigger gets focus back.
 */
export function Drawer({
  open,
  onClose,
  title,
  subtitle,
  children,
  footer,
  side = 'right',
  width = 460,
  className,
}: DrawerProps): React.JSX.Element | null {
  const titleId = useId();
  const dialogRef = useDialogFocus(open, { onClose });

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-40">
      <div className="absolute inset-0 bg-black/55" onClick={onClose} aria-hidden="true" />
      <aside
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={cx(
          'absolute flex flex-col border-hair-strong bg-panel shadow-2xl shadow-black/60',
          side === 'right'
            ? 'inset-y-0 right-0 w-full border-l sm:w-[var(--drawer-width)]'
            : 'inset-x-0 bottom-0 max-h-[80dvh] rounded-t-[10px] border-t',
          className,
        )}
        style={side === 'right' ? ({ ['--drawer-width' as string]: `${width}px` } as React.CSSProperties) : undefined}
      >
        <header className="flex shrink-0 items-start justify-between gap-4 border-b border-hair px-4 py-3">
          <div className="min-w-0">
            <h2 id={titleId} className="truncate text-[13px] font-semibold text-ink">
              {title}
            </h2>
            {subtitle !== undefined ? <p className="mt-0.5 truncate text-[11px] text-ink-dim">{subtitle}</p> : null}
          </div>
          <button type="button" onClick={onClose} className="btn btn-ghost btn-sm" aria-label="Close">
            ✕
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3.5">{children}</div>
        {footer !== undefined ? (
          <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-hair bg-base/40 px-4 py-3">{footer}</footer>
        ) : null}
      </aside>
    </div>
  );
}
