'use client';

import { useEffect, type ReactNode } from 'react';
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
  readonly className?: string;
}

const WIDTH: Readonly<Record<'sm' | 'md' | 'lg', string>> = {
  sm: 'max-w-md',
  md: 'max-w-2xl',
  lg: 'max-w-4xl',
};

/** A centred dialog. Escape and backdrop close it unless `dismissible` is false. */
export function Modal({
  open,
  onClose,
  title,
  subtitle,
  children,
  footer,
  width = 'md',
  dismissible = true,
  className,
}: ModalProps): React.JSX.Element | null {
  useEffect(() => {
    if (!open || !dismissible) return;
    function onKey(event: KeyboardEvent): void {
      if (event.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, dismissible, onClose]);

  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-black/65 backdrop-blur-[1px]"
        onClick={dismissible ? onClose : undefined}
        aria-hidden="true"
      />
      <div
        role="dialog"
        aria-modal="true"
        className={cx(
          'animate-rise relative flex max-h-[85dvh] w-full flex-col overflow-hidden rounded-[8px] border border-hair-strong bg-panel shadow-2xl shadow-black/60',
          WIDTH[width],
          className,
        )}
      >
        <header className="flex shrink-0 items-start justify-between gap-4 border-b border-hair px-4 py-3">
          <div className="min-w-0">
            <h2 className="text-[14px] font-semibold text-ink">{title}</h2>
            {subtitle !== undefined ? <p className="mt-0.5 text-[11px] text-ink-dim">{subtitle}</p> : null}
          </div>
          {dismissible ? (
            <button type="button" onClick={onClose} className="btn btn-ghost btn-sm" aria-label="Close">
              ✕
            </button>
          ) : null}
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3.5">{children}</div>
        {footer !== undefined ? (
          <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-hair bg-base/40 px-4 py-3">{footer}</footer>
        ) : null}
      </div>
    </div>
  );
}
