'use client';

import { useId, type ReactNode } from 'react';
import { useDialogFocus } from './focusTrap';
import { Icon } from './icons';
import { cx } from './tokens';

export interface DrawerProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly title: ReactNode;
  readonly subtitle?: ReactNode;
  readonly children: ReactNode;
  readonly footer?: ReactNode;
  /**
   * `right` for detail panes, `bottom` for sheets.
   *
   * Below `sm` a `right` drawer presents as a bottom sheet anyway: a full-height
   * pane sliding in from the side of a phone is a page, and a page should have
   * been a route. From `sm` up it is the side pane it says it is.
   */
  readonly side?: 'right' | 'bottom';
  readonly width?: number;
  readonly className?: string;
}

/**
 * A sheet for detail that should not take the player off the screen.
 *
 * The ledger rows behind a figure, a director's card, one node of the Frontier
 * Map: all read better beside — or, on a phone, under — the thing they explain
 * than on a route of their own.
 *
 * It declares `aria-modal`, so it keeps the keyboard as well: focus moves in on
 * open, Tab wraps inside, Escape closes and the trigger gets focus back. The
 * grip at the top of the phone presentation is an affordance, not a control:
 * the sheet is dismissed with its close button, Escape or the scrim.
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
      <div className="absolute inset-0 bg-ink/25" onClick={onClose} aria-hidden="true" />
      <aside
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={cx(
          'animate-rise absolute flex flex-col border-hair bg-panel shadow-sheet',
          side === 'right'
            ? // phone: a bottom sheet; `sm` and up: the side pane
              'inset-x-0 bottom-0 max-h-[85dvh] rounded-t-panel border-t sm:inset-y-0 sm:right-0 sm:left-auto sm:max-h-none sm:w-[var(--drawer-width)] sm:rounded-none sm:border-t-0 sm:border-l'
            : 'inset-x-0 bottom-0 max-h-[85dvh] rounded-t-panel border-t',
          className,
        )}
        style={side === 'right' ? ({ ['--drawer-width' as string]: `${width}px` } as React.CSSProperties) : undefined}
      >
        <div className={cx('flex shrink-0 justify-center pt-2', side === 'right' ? 'sm:hidden' : '')} aria-hidden="true">
          <span className="sheet-grip" />
        </div>
        <header className="flex shrink-0 items-start justify-between gap-4 border-b border-hair px-5 py-3">
          <div className="min-w-0">
            <h2 id={titleId} className="truncate text-[14px] font-bold text-ink">
              {title}
            </h2>
            {subtitle !== undefined ? <p className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-ink-dim">{subtitle}</p> : null}
          </div>
          <button type="button" onClick={onClose} className="btn btn-ghost tap-target -mr-1.5 shrink-0 px-0" aria-label="Close">
            <Icon name="close" size={15} accent="current" />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer !== undefined ? (
          <footer className="safe-pb-4 flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-hair bg-raised/60 px-5 pt-3.5">
            {footer}
          </footer>
        ) : null}
      </aside>
    </div>
  );
}
