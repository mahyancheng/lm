'use client';

/**
 * The measurer and the face, as React sees them.
 *
 * On the server and during hydration there is no canvas, so the measurer is
 * null and every newspaper component renders its unmeasured fallback. After
 * mount the pretext-backed measurer arrives in one state update and the page
 * re-lays out once. The serif family is read off the `--font-serif` token so
 * the measurement uses the same stack the CSS paints with.
 */

import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { canvasMeasurer, type Measurer } from '@/lib/text/measure';

/** The stack `globals.css` declares; the fallback when the token cannot be read. */
export const SERIF_STACK = '"Iowan Old Style", "Palatino Linotype", Palatino, "Book Antiqua", "Noto Serif", Georgia, "Times New Roman", serif';

export interface TypeMeasure {
  readonly measurer: Measurer | null;
  readonly serif: string;
}

const UNMEASURED: TypeMeasure = { measurer: null, serif: SERIF_STACK };

export function useTypeMeasure(): TypeMeasure {
  const [state, setState] = useState<TypeMeasure>(UNMEASURED);
  useEffect(() => {
    const measurer = canvasMeasurer();
    if (measurer === null) return;
    let serif = SERIF_STACK;
    try {
      const token = getComputedStyle(document.documentElement).getPropertyValue('--font-serif').trim();
      if (token.length > 0) serif = token;
    } catch {
      // Keep the declared stack.
    }
    setState({ measurer, serif });
  }, []);
  return state;
}

/** The phone column: 390px less the shell's 12px either side. The width before anything is measured. */
export const DEFAULT_COLUMN_WIDTH_PX = 366;

/**
 * The live width of an element, tracked through resize. Starts at the phone
 * column so the first measured layout is already right on the target device.
 */
export function useElementWidth<T extends HTMLElement>(fallback = DEFAULT_COLUMN_WIDTH_PX): [RefObject<T | null>, number] {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(fallback);
  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null) return;
    const read = (): void => {
      const next = Math.round(element.getBoundingClientRect().width);
      if (next > 0) setWidth((current) => (current === next ? current : next));
    };
    read();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(read);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}
