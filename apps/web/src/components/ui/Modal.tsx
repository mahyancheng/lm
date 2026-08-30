'use client';

import { useCallback, useEffect, useId, useRef, type ReactNode, type RefObject } from 'react';
import { cx, nextTrapIndex } from './tokens';

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

/** Everything the keyboard can reach, in document order. */
const FOCUSABLE =
  'a[href], area[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * The page does not scroll while any dialog is open.
 *
 * Reference-counted rather than saved-and-restored: two overlapping dialogs
 * closing out of order must not unlock the page while one is still up.
 */
let scrollLocks = 0;
let restoreOverflow = '';

function lockScroll(): () => void {
  if (typeof document === 'undefined') return () => undefined;
  if (scrollLocks === 0) {
    restoreOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
  }
  scrollLocks += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    scrollLocks = Math.max(0, scrollLocks - 1);
    if (scrollLocks === 0) document.body.style.overflow = restoreOverflow;
  };
}

/**
 * A centred dialog. Escape and backdrop close it unless `dismissible` is false.
 *
 * `aria-modal` hides the background from the accessibility tree, so the keyboard
 * must not be able to walk into it: focus moves into the dialog on open, Tab and
 * Shift+Tab wrap inside it, and the element that opened it gets focus back on
 * close. A dialog that announces itself as modal while focus sits on content a
 * screen reader will not read is worse than one that does not announce at all.
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
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const titleId = useId();

  const focusable = useCallback((): HTMLElement[] => {
    const container = dialogRef.current;
    if (container === null) return [];
    return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
      (element) => element.offsetParent !== null || element === document.activeElement,
    );
  }, []);

  /* --- focus: take it, keep it, give it back ------------------------------- */
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const target = initialFocus?.current ?? focusable()[0] ?? dialogRef.current;
    target?.focus();
    return () => {
      previous?.focus();
    };
  }, [open, initialFocus, focusable]);

  useEffect(() => {
    if (!open) return;
    function onKey(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        if (dismissible) onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const elements = focusable();
      if (elements.length === 0) {
        event.preventDefault();
        dialogRef.current?.focus();
        return;
      }
      const current = elements.findIndex((element) => element === document.activeElement);
      const next = nextTrapIndex(elements.length, current, event.shiftKey);
      // Wrapping is only needed at the ends; in the middle the browser does the
      // right thing already and intercepting would break composed widgets.
      const atEdge = current === -1 || (event.shiftKey ? current === 0 : current === elements.length - 1);
      if (!atEdge) return;
      event.preventDefault();
      elements[next]?.focus();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, dismissible, onClose, focusable]);

  useEffect(() => {
    if (!open) return;
    return lockScroll();
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
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={cx(
          'animate-rise relative flex max-h-[85dvh] w-full flex-col overflow-hidden rounded-[8px] border border-hair-strong bg-panel shadow-2xl shadow-black/60',
          WIDTH[width],
          className,
        )}
      >
        <header className="flex shrink-0 items-start justify-between gap-4 border-b border-hair px-4 py-3">
          <div className="min-w-0">
            <h2 id={titleId} className="text-[14px] font-semibold text-ink">
              {title}
            </h2>
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
