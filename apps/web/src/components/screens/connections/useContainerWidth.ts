'use client';

/**
 * The width of the element the picture is drawn into.
 *
 * The layout is arithmetic on one number, so the picture needs that number
 * before it can draw anything — and on the server, and in a static-markup
 * test, there is nothing to measure. `FALLBACK_WIDTH` is what those two get.
 *
 * It is 356 because that is what the panel's content box actually measures at
 * a 390-point viewport — not the 358 the body is wide, which was a guess two
 * paddings upstream of the element the picture lands in. Getting it wrong by
 * eighteen points cost nine points off every pill, and the layout tests all
 * passed at a width the screen never had. Anything that changes the panel's
 * padding has to change this number and `layout.test.ts`'s widths with it.
 */

import { useEffect, useRef, useState } from 'react';

/** The measured content box of the Connections panel on a 390-point phone. */
export const FALLBACK_WIDTH = 356;

export interface ContainerWidth {
  readonly ref: React.RefObject<HTMLDivElement | null>;
  readonly width: number;
}

export function useContainerWidth(fallback: number = FALLBACK_WIDTH): ContainerWidth {
  const ref = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(fallback);

  useEffect(() => {
    const element = ref.current;
    if (element === null) return;
    const measure = (): void => {
      const next = Math.round(element.clientWidth);
      if (next > 0) setWidth(next);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return { ref, width };
}
