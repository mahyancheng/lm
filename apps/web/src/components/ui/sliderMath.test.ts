/**
 * The grid every action-form slider moves on.
 *
 * Pure arithmetic, tested without a browser: the step must be a figure a
 * player would write down, the bounds must always be reachable however round
 * the step is, and the quick-set chips must land on the grid — because a chip
 * that produces $247,193 defeats the point of having chips at all.
 */

import { describe, expect, it } from 'vitest';
import { chipStops, roundStep, snapToStep } from './sliderMath';

describe('roundStep picks a round figure sized to the bound', () => {
  it('keeps small integer ranges at whole units', () => {
    expect(roundStep(8)).toBe(1);
    expect(roundStep(40)).toBe(1);
    expect(roundStep(100)).toBe(1);
  });

  it('moves a $20M budget in $250K notches', () => {
    expect(roundStep(20_000_000)).toBe(250_000);
  });

  it('scales through money magnitudes without leaving the ladder', () => {
    expect(roundStep(1_000_000)).toBe(10_000);
    expect(roundStep(100_000_000)).toBe(1_000_000);
    expect(roundStep(3_000_000_000)).toBe(50_000_000);
  });

  it('never returns more positions than asked for', () => {
    for (const bound of [7, 1_234, 999_999, 42_000_000, 5_500_000_000]) {
      expect(bound / roundStep(bound)).toBeLessThanOrEqual(100);
    }
  });

  it('honours a tighter stop budget', () => {
    expect(roundStep(20_000_000, 40)).toBe(500_000);
  });
});

describe('snapToStep clamps and snaps', () => {
  it('rounds to the nearest multiple of the step', () => {
    expect(snapToStep(247_193, 0, 20_000_000, 250_000)).toBe(250_000);
    expect(snapToStep(1_100_000, 0, 20_000_000, 250_000)).toBe(1_000_000);
  });

  it('keeps an off-grid ceiling reachable', () => {
    // A cash bound of $3,120,000 is a legal maximum whatever the step is.
    expect(snapToStep(3_119_000, 0, 3_120_000, 250_000)).toBe(3_120_000);
    expect(snapToStep(99, 0, 3_120_000, 250_000)).toBe(0);
  });

  it('clamps below the floor and above the ceiling', () => {
    expect(snapToStep(-5, 0, 100, 1)).toBe(0);
    expect(snapToStep(500, 1, 40, 1)).toBe(40);
  });

  it('treats a non-finite value as the floor', () => {
    expect(snapToStep(Number.NaN, 2, 40, 1)).toBe(2);
    expect(snapToStep(Number.POSITIVE_INFINITY, 0, 40, 1)).toBe(40);
  });
});

describe('chipStops offers 25/50/75/Max on the grid', () => {
  it('lands every fractional stop on a step multiple', () => {
    const stops = chipStops(0, 20_000_000, 250_000);
    expect(stops.map((stop) => stop.label)).toEqual(['25%', '50%', '75%', 'Max']);
    for (const stop of stops.slice(0, -1)) {
      expect(stop.value % 250_000).toBe(0);
    }
  });

  it('keeps Max at the exact bound even off-grid', () => {
    const stops = chipStops(0, 3_120_000, 250_000);
    expect(stops[stops.length - 1]).toEqual({ label: 'Max', value: 3_120_000 });
  });

  it('collapses duplicates on a tiny range rather than rendering them twice', () => {
    const stops = chipStops(0, 2, 1);
    expect(stops).toEqual([
      { label: '50%', value: 1 },
      { label: 'Max', value: 2 },
    ]);
  });

  it('offers nothing for an empty or inverted range', () => {
    expect(chipStops(0, 0, 1)).toEqual([]);
    expect(chipStops(10, 5, 1)).toEqual([]);
  });
});
