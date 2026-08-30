'use client';

/**
 * WORLD — the readings this company is actually exposed to.
 *
 * Twelve domains is too many for a landing screen, so this strip carries the
 * ones that price a quarter: what money costs, whether anyone wants risk, how
 * scarce compute is, how hard the rules are, and what the press is saying.
 *
 * Every reading shows its change against the world as it stood before the last
 * resolution — the store keeps that snapshot precisely so this strip can be
 * honest about direction rather than asserting one.
 */

import type { WorldState } from '@frontier/contracts';
import { formatPct } from '@frontier/shared';
import { DeltaBadge, Meter, cx } from '@/components/ui';
import { bandLabel, humanise } from '../reporting/util';

interface Reading {
  readonly key: string;
  readonly label: string;
  readonly value: string;
  /** 0..100 for the meter, or null for a reading that is not a share. */
  readonly meter: number | null;
  /** Signed change, in the units `format` names. */
  readonly delta: number | null;
  readonly format: 'points' | 'percent' | 'number';
  /** Down is good: rates, spreads, compute prices, salary pressure. */
  readonly invert: boolean;
}

const SUPPLY = ['Critical', 'Tight', 'Balanced', 'Ample', 'Abundant'] as const;
const TRUST = ['Hostile', 'Wary', 'Mixed', 'Positive', 'Bullish'] as const;
const APPETITE = ['Risk-off', 'Cautious', 'Neutral', 'Warm', 'Euphoric'] as const;
const RULES = ['Unregulated', 'Light', 'Moderate', 'Stringent', 'Licence-gated'] as const;
const WINDOW = ['Shut', 'Narrow', 'Open', 'Wide', 'Wide open'] as const;

function delta(current: number, previous: number | undefined): number | null {
  if (previous === undefined || !Number.isFinite(previous)) return null;
  const change = current - previous;
  return Math.abs(change) < 1e-9 ? 0 : change;
}

function readings(world: WorldState, previous: WorldState | null): Reading[] {
  const p = previous;
  return [
    {
      key: 'policyRate',
      label: 'Policy rate',
      value: formatPct(world.macro.policyRate, 2),
      meter: null,
      delta: delta(world.macro.policyRate, p?.macro.policyRate),
      format: 'points',
      invert: true,
    },
    {
      key: 'creditSpreads',
      label: 'Credit spreads',
      value: formatPct(world.macro.creditSpreads, 2),
      meter: null,
      delta: delta(world.macro.creditSpreads, p?.macro.creditSpreads),
      format: 'points',
      invert: true,
    },
    {
      key: 'riskAppetite',
      label: 'Risk appetite',
      value: bandLabel(world.capitalMarkets.riskAppetite, APPETITE),
      meter: world.capitalMarkets.riskAppetite * 100,
      delta: delta(world.capitalMarkets.riskAppetite, p?.capitalMarkets.riskAppetite),
      format: 'points',
      invert: false,
    },
    {
      key: 'ipoWindow',
      label: 'Listing window',
      value: bandLabel(world.capitalMarkets.ipoWindow, WINDOW),
      meter: world.capitalMarkets.ipoWindow * 100,
      delta: delta(world.capitalMarkets.ipoWindow, p?.capitalMarkets.ipoWindow),
      format: 'points',
      invert: false,
    },
    {
      key: 'aiTrust',
      label: 'AI sentiment',
      value: bandLabel(world.society.aiTrust, TRUST),
      meter: world.society.aiTrust * 100,
      delta: delta(world.society.aiTrust, p?.society.aiTrust),
      format: 'points',
      invert: false,
    },
    {
      key: 'acceleratorSupply',
      label: 'Compute supply',
      value: bandLabel(world.compute.acceleratorSupply, SUPPLY),
      meter: world.compute.acceleratorSupply * 100,
      delta: delta(world.compute.acceleratorSupply, p?.compute.acceleratorSupply),
      format: 'points',
      invert: false,
    },
    {
      key: 'spotPrice',
      label: 'Compute spot',
      value: `${world.compute.spotPrice.toFixed(2)}×`,
      meter: null,
      delta: delta(world.compute.spotPrice, p?.compute.spotPrice),
      format: 'number',
      invert: true,
    },
    {
      key: 'modelRules',
      label: 'Regulation',
      value: bandLabel(world.regulation.modelRules, RULES),
      meter: world.regulation.modelRules * 100,
      delta: delta(world.regulation.modelRules, p?.regulation.modelRules),
      format: 'points',
      invert: true,
    },
    {
      key: 'salaryPressure',
      label: 'Salary pressure',
      value: `${world.talent.salaryPressure.toFixed(2)}×`,
      meter: null,
      delta: delta(world.talent.salaryPressure, p?.talent.salaryPressure),
      format: 'number',
      invert: true,
    },
    {
      key: 'procurementBudget',
      label: 'Public budget',
      value: bandLabel(world.government.procurementBudget, ['Frozen', 'Tight', 'Steady', 'Expanding', 'Flush']),
      meter: world.government.procurementBudget * 100,
      delta: delta(world.government.procurementBudget, p?.government.procurementBudget),
      format: 'points',
      invert: false,
    },
  ];
}

export interface WorldStripProps {
  readonly world: WorldState;
  /** The world before the last resolution, or null before the first one. */
  readonly previous: WorldState | null;
  readonly className?: string;
}

export function WorldStrip({ world, previous, className }: WorldStripProps): React.JSX.Element {
  const rows = readings(world, previous);

  return (
    <div className={cx('flex flex-col gap-2', className)}>
      {rows.map((reading) => (
        <div key={reading.key} className="border-b border-hair/50 pb-2 last:border-b-0 last:pb-0">
          <div className="flex items-baseline justify-between gap-2">
            <span className="label-caps-faint truncate">{reading.label}</span>
            <span className="flex shrink-0 items-baseline gap-2">
              <span className="figure text-[12px] text-ink">{reading.value}</span>
              {reading.delta === null ? null : (
                <DeltaBadge value={reading.delta} format={reading.format} invert={reading.invert} bare />
              )}
            </span>
          </div>
          {reading.meter === null ? null : <Meter value={reading.meter} showValue={false} className="mt-1" />}
        </div>
      ))}

      <div className="mt-1 flex items-baseline justify-between gap-2 border-t border-hair pt-2">
        <span className="label-caps-faint">Dominant narrative</span>
        <span className="truncate text-[12px] text-ink">{humanise(world.media.dominantNarrative)}</span>
      </div>
      <p className="text-[10px] text-ink-faint">
        {previous === null
          ? 'Changes appear once a quarter has resolved in this tab.'
          : 'Change is measured against the world before the last resolution.'}
      </p>
    </div>
  );
}
