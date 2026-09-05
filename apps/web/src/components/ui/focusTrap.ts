'use client';

import { useCallback, useEffect, useRef, type RefObject } from 'react';
import { nextTrapIndex } from './tokens';

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

export interface DialogFocusOptions {
  /** Escape closes it. False for a flow that must be answered. */
  readonly dismissible?: boolean;
  readonly onClose: () => void;
  /** Where focus lands on open. Defaults to the first control inside. */
  readonly initialFocus?: RefObject<HTMLElement | null>;
  /** Lock page scroll while open. Default true. */
  readonly lockScroll?: boolean;
}

/**
 * Make a dialog modal to the keyboard, not only to the accessibility tree.
 *
 * `aria-modal` hides the background from a screen reader, so focus must not be
 * able to walk into it: focus moves inside on open, Tab and Shift+Tab wrap
 * within, Escape closes, and the element that opened the dialog gets focus back
 * when it closes. A dialog that announces itself as modal while the keyboard
 * sits on content the reader will not announce is worse than one that does not
 * announce at all.
 *
 * Returns the ref to put on the dialog container.
 */
export function useDialogFocus(open: boolean, options: DialogFocusOptions): RefObject<HTMLDivElement | null> {
  const { dismissible = true, onClose, initialFocus, lockScroll: shouldLock = true } = options;
  const containerRef = useRef<HTMLDivElement | null>(null);

  const focusable = useCallback((): HTMLElement[] => {
    const container = containerRef.current;
    if (container === null) return [];
    return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
      (element) => element.offsetParent !== null || element === document.activeElement,
    );
  }, []);

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const target = initialFocus?.current ?? focusable()[0] ?? containerRef.current;
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
        containerRef.current?.focus();
        return;
      }
      const current = elements.findIndex((element) => element === document.activeElement);
      // Wrapping is only needed at the ends; in the middle the browser already
      // does the right thing and intercepting would break composed widgets.
      const atEdge = current === -1 || (event.shiftKey ? current === 0 : current === elements.length - 1);
      if (!atEdge) return;
      event.preventDefault();
      elements[nextTrapIndex(elements.length, current, event.shiftKey)]?.focus();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, dismissible, onClose, focusable]);

  useEffect(() => {
    if (!open || !shouldLock) return;
    return lockScroll();
  }, [open, shouldLock]);

  return containerRef;
}
