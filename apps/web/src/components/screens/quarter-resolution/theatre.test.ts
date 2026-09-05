/**
 * The theatre is presentation, and presentation on this screen still has to be
 * deterministic: a count-up that ended on a sample of its own curve, or a
 * podium that ordered on a clock, would put a different number in front of two
 * players looking at the same committed quarter.
 *
 * Relative imports throughout: `apps/web` has no vitest config, so the `@/`
 * alias is a Next-only convenience and does not resolve here.
 */

import { describe, expect, it } from 'vitest';
import { PODIUM_HEIGHTS, countUpFrames, podiumOrder } from './theatre';

describe('count-up frames', () => {
  it('ends on the committed number exactly, never on the curve', () => {
    const frames = countUpFrames(0, 0.0473, 14);
    expect(frames).toHaveLength(14);
    expect(frames[frames.length - 1]).toBe(0.0473);
  });

  it('draws the same frames every time', () => {
    expect(countUpFrames(0, 1_240_000_000, 14)).toEqual(countUpFrames(0, 1_240_000_000, 14));
  });

  it('moves monotonically towards the target, in both directions', () => {
    const up = countUpFrames(0, 100, 14);
    for (let index = 1; index < up.length; index += 1) expect(up[index]).toBeGreaterThan(up[index - 1] ?? 0);

    // A rank counts down: #7 to #3 is an improvement, and the frames follow it.
    const down = countUpFrames(7, 3, 14);
    for (let index = 1; index < down.length; index += 1) expect(down[index]).toBeLessThan(down[index - 1] ?? 0);
    expect(down[down.length - 1]).toBe(3);
  });

  it('never leaves the interval it was given', () => {
    for (const value of countUpFrames(2, 9, 14)) {
      expect(value).toBeGreaterThanOrEqual(2);
      expect(value).toBeLessThanOrEqual(9);
    }
  });

  it('degrades to a single frame rather than dividing by zero', () => {
    expect(countUpFrames(0, 42, 0)).toEqual([42]);
    expect(countUpFrames(0, 42, -3)).toEqual([42]);
  });
});

describe('podium order', () => {
  const board = (id: string, percentile: number): { readonly id: string; readonly percentile: number } => ({ id, percentile });

  it('puts the winner in the middle and the runner-up on the left', () => {
    const rows = [board('a', 0.4), board('b', 0.9), board('c', 0.7), board('d', 0.1)];
    const order = podiumOrder(rows, (row) => row.percentile).map((row) => row?.id ?? null);
    expect(order).toEqual(['c', 'b', 'a']);
  });

  it('leaves the outer slots empty rather than promoting anyone', () => {
    expect(podiumOrder([board('only', 0.5)], (row) => row.percentile).map((row) => row?.id ?? null)).toEqual([null, 'only', null]);
    expect(podiumOrder([], (row: { readonly percentile: number }) => row.percentile)).toEqual([null, null, null]);
  });

  it('breaks a tie on the order the engine produced, not on chance', () => {
    const rows = [board('first', 0.5), board('second', 0.5), board('third', 0.5)];
    const once = podiumOrder(rows, (row) => row.percentile).map((row) => row?.id ?? null);
    const twice = podiumOrder(rows, (row) => row.percentile).map((row) => row?.id ?? null);
    expect(once).toEqual(['second', 'first', 'third']);
    expect(twice).toEqual(once);
  });

  it('does not mutate the rows it was handed', () => {
    const rows = [board('a', 0.1), board('b', 0.9)];
    podiumOrder(rows, (row) => row.percentile);
    expect(rows.map((row) => row.id)).toEqual(['a', 'b']);
  });

  it('makes the middle step the tallest', () => {
    expect(PODIUM_HEIGHTS[1]).toBeGreaterThan(PODIUM_HEIGHTS[0] ?? 0);
    expect(PODIUM_HEIGHTS[1]).toBeGreaterThan(PODIUM_HEIGHTS[2] ?? 0);
  });
});
