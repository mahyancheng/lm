'use client';

import { useId, type ReactNode, type RefObject } from 'react';
import { useDialogFocus } from './focusTrap';
import { cx } from './tokens';

export interface ModalProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly title: ReactNode;
  readonly subtitle?: ReactNode;
  readonly children: ReactNode;
  /** Right-aligned controls in the footer. */
  readonly footer?: ReactNode;
  readonly width?: 'sm' | 'md' | 'lg';
  /** Prevent dismissal by backdrop click or Escape, for a flow that must be answered. */
  readonly dismissible?: boolean;
  /** Where focus lands when the dialog opens. Defaults to the first control in it. */
  readonly initialFocus?: RefObject<HTMLElement | null>;
  readonly className?: string;
}

const WIDTH: Readonly<Record<'sm' | 'md' | 'lg', string>> = {
  sm: 'max-w-md',
  md: 'max-w-2xl',
  lg: 'max-w-4xl',
};

/**
 * A centred dialog. Escape and backdrop close it unless `dismissible` is false.
 *
 * Focus is taken on open, trapped while open and given back on close — see
 * `useDialogFocus`. The heading is the accessible name.
 */
export function Modal({
  open,
  onClose,
  title,
  subtitle,
  children,
  footer,
  width = 'md',
  dismissible = true,
  initialFocus,
  className,
}: ModalProps): React.JSX.Element | null {
  const titleId = useId();
  const dialogRef = useDialogFocus(open, { dismissible, onClose, initialFocus });

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-ink/30 backdrop-blur-[2px]"
        onClick={dismissible ? onClose : undefined}
        aria-hidden="true"
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={cx(
          'animate-pop-in relative flex max-h-[85dvh] w-full flex-col overflow-hidden rounded-panel border border-hair bg-panel shadow-sheet',
          WIDTH[width],
          className,
        )}
      >
        <header className="flex shrink-0 items-start justify-between gap-4 border-b border-hair px-5 py-3.5">
          <div className="min-w-0">
            <h2 id={titleId} className="text-[15px] font-bold text-ink">
              {title}
            </h2>
            {subtitle !== undefined ? <p className="mt-0.5 text-[11px] text-ink-dim">{subtitle}</p> : null}
          </div>
          {dismissible ? (
            <button type="button" onClick={onClose} className="btn btn-ghost tap-target -mr-1.5 shrink-0" aria-label="Close">
              ✕
            </button>
          ) : null}
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer !== undefined ? (
          <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-hair bg-raised/60 px-5 py-3.5">{footer}</footer>
        ) : null}
      </div>
    </div>
  );
}
