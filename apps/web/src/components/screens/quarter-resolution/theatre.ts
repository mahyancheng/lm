/**
 * The pure arithmetic behind the quarter-resolution theatre.
 *
 * Both functions here are deterministic and side-effect free, which is the
 * whole point: the payoff screen animates, and an animation that samples a
 * clock or a random number would draw a different quarter on two machines. A
 * count-up is a fixed list of frames, and a podium is a fixed ordering.
 *
 * No `@/` alias and no React, so this module is directly testable.
 */

/**
 * The frames a count-up draws, from just after `from` to exactly `to`.
 *
 * The curve is a cubic ease-out evaluated at `step / steps`, so frame *k* of a
 * given `(from, to, steps)` is the same number forever. **The last frame is
 * `to` itself**, never a sample of the curve: the number a player is left
 * looking at is the committed one, not a rounding of the animation.
 */
export function countUpFrames(from: number, to: number, steps: number): readonly number[] {
  const count = Math.max(1, Math.floor(steps));
  const frames: number[] = [];
  for (let step = 1; step <= count; step += 1) {
    if (step === count) {
      frames.push(to);
      continue;
    }
    const t = step / count;
    const eased = 1 - (1 - t) ** 3;
    frames.push(from + (to - from) * eased);
  }
  return frames;
}

/**
 * The three podium slots, left to right: runner-up, winner, third.
 *
 * `rank` orders the entries — a *lower* rank is better — and ties break on the
 * caller's original order, which is the leaderboard order the engine produced.
 * A short list leaves the outer slots empty rather than promoting anyone.
 */
export function podiumOrder<T>(rows: readonly T[], score: (row: T) => number): readonly (T | null)[] {
  const top = rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      const delta = score(b.row) - score(a.row);
      return delta !== 0 ? delta : a.index - b.index;
    })
    .slice(0, 3)
    .map((entry) => entry.row);

  const [first = null, second = null, third = null] = top;
  return [second, first, third];
}

/** Heights in px for the podium slots, in the order `podiumOrder` returns. */
export const PODIUM_HEIGHTS: readonly number[] = [66, 88, 52];
