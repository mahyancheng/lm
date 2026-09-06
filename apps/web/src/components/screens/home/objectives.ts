/**
 * An objective's standing, in the metric's own units.
 *
 * Moved verbatim out of the old Command Centre body when Home replaced it, so
 * that the reading is a pure function a test can call without a store: it is
 * the one piece of arithmetic on the Objectives card, and it is where a
 * dollar target and a count target stop looking alike.
 */

import type { ObjectiveMetric } from '@frontier/contracts';
import { formatMoney, formatPct, formatScore } from '@frontier/shared';

/** Objective metrics measured in units rather than dollars. */
export const COUNT_METRICS: readonly ObjectiveMetric[] = [
  'connection_level',
  'board_seats',
  'tech_nodes_achieved',
  'survive_quarters',
];

/** An objective's current standing against its target, in the metric's own units. */
export function objectiveReading(metric: ObjectiveMetric, current: number, target: number): string {
  if (metric === 'ownership_of_rival') return `${formatPct(current)} of ${formatPct(target)}`;
  if (COUNT_METRICS.includes(metric)) return `${formatScore(current)} of ${formatScore(target)}`;
  if (Math.abs(target) < 1000) return `${formatMoney(current)} · target ${formatMoney(target)}`;
  return `${formatMoney(current)} of ${formatMoney(target)}`;
}
