'use client';

/**
 * A figure that arrives by counting.
 *
 * Purely presentational, and deliberately small:
 *
 * - **The rendered value comes from state, never from the animation.** The
 *   first render — server and hydration alike — is the final value, the last
 *   tick assigns the target exactly rather than the last eased sample, and the
 *   accessible name is always `format(value)`. If the timer never runs, the
 *   right number is already on screen.
 * - **No `requestAnimationFrame`, no game loop.** A fixed number of `setInterval`
 *   steps, cleared on unmount and on every change of target.
 * - **Reduced motion skips it entirely**, matching the blanket rule in
 *   `globals.css` — a player who has asked for stillness gets the number.
 * - **Nothing here is gameplay-visible randomness**: the easing is a pure
 *   function of the step index, so two runs draw the same frames.
 */

import { useEffect, useLayoutEffect, useState } from 'react';

/** `useLayoutEffect` warns during SSR; the count-up only exists in a browser. */
const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

const STEPS = 14;
const STEP_MS = 34;

export interface CountUpOptions {
  /** Turn the animation off without changing the rendered number. */
  readonly enabled?: boolean;
  /** Where the count starts. Defaults to zero; a rank counts from its previous rank. */
  readonly from?: number;
  /** Hold before starting, so a staggered grid of figures does not all fire at once. */
  readonly delayMs?: number;
}

/**
 * The value to draw this frame. Settles on `target` and stays there.
 */
export function useCountUp(target: number, options: CountUpOptions = {}): number {
  const { enabled = true, from = 0, delayMs = 0 } = options;
  const [value, setValue] = useState<number>(target);

  useIsomorphicLayoutEffect(() => {
    if (!enabled || !Number.isFinite(target) || !Number.isFinite(from) || from === target) {
      setValue(target);
      return;
    }
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      setValue(target);
      return;
    }
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setValue(target);
      return;
    }

    setValue(from);
    let step = 0;
    let interval: ReturnType<typeof setInterval> | null = null;

    const timer = setTimeout(() => {
      interval = setInterval(() => {
        step += 1;
        if (step >= STEPS) {
          if (interval !== null) clearInterval(interval);
          interval = null;
          // The last frame is the state's number, not a sample of the curve.
          setValue(target);
          return;
        }
        const t = step / STEPS;
        const eased = 1 - (1 - t) ** 3;
        setValue(from + (target - from) * eased);
      }, STEP_MS);
    }, delayMs);

    return () => {
      clearTimeout(timer);
      if (interval !== null) clearInterval(interval);
    };
  }, [target, from, enabled, delayMs]);

  return value;
}

export interface CountUpProps extends CountUpOptions {
  /** The committed number. This, formatted, is what a screen reader is told. */
  readonly value: number;
  /** Formatter from `@frontier/shared` — never a hand-rolled `toFixed`. */
  readonly format: (value: number) => string;
  readonly className?: string;
}

/**
 * ```tsx
 * <CountUp value={report.lines} format={(v) => formatScore(v)} className="figure" />
 * ```
 */
export function CountUp({ value, format, className, enabled, from, delayMs }: CountUpProps): React.JSX.Element {
  const shown = useCountUp(value, { enabled, from, delayMs });
  return (
    <span className={className}>
      <span aria-hidden="true">{format(shown)}</span>
      <span className="sr-only">{format(value)}</span>
    </span>
  );
}
