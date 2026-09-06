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

/**
 * Which dialog owns the keyboard.
 *
 * A tab is a page of cards, a card opens a sheet, and a sheet may open one
 * detail drawer over itself — so two dialogs are routinely up at once. Every
 * open dialog listens on `window`, so without an order Escape closed the
 * detail *and* the subject behind it in one press, and Tab wrapped against
 * whichever trap happened to be registered last. Only the topmost dialog
 * handles a key; the one beneath it is inert until it is topmost again.
 */
const dialogStack: object[] = [];

/** Register a dialog as the topmost one. Exported for the ordering test. */
export function pushDialog(token: object): () => void {
  dialogStack.push(token);
  return () => {
    const at = dialogStack.lastIndexOf(token);
    if (at >= 0) dialogStack.splice(at, 1);
  };
}

/** True while nothing sits above this dialog. Empty is true: nothing is above it. */
export function isTopDialog(token: object): boolean {
  return dialogStack.length === 0 || dialogStack[dialogStack.length - 1] === token;
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
  // One identity per mounted dialog, so its place in the stack survives every
  // re-render — the registration below depends on `open` alone.
  const token = useRef<object>({}).current;

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
    return pushDialog(token);
  }, [open, token]);

  useEffect(() => {
    if (!open) return;
    function onKey(event: KeyboardEvent): void {
      if (!isTopDialog(token)) return;
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
  }, [open, dismissible, onClose, focusable, token]);

  useEffect(() => {
    if (!open || !shouldLock) return;
    return lockScroll();
  }, [open, shouldLock]);

  return containerRef;
}
