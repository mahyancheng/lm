'use client';

/**
 * The dilution calculator.
 *
 * Pure client arithmetic and nothing else: it submits no intent, queues no
 * action and touches no state. It exists so a founder can see what a round
 * would do to their stake before they decide to attempt one — which is a
 * different question from whether the market would clear it.
 */

import { useState } from 'react';
import { formatMoney, formatPct } from '@frontier/shared';
import { KeyValueGrid, SectionHeading } from '@/components/ui';
import { formatCount } from '../reporting/util';

export interface DilutionCalculatorProps {
  /** Current fully diluted count. */
  readonly fullyDilutedShares: number;
  /** The founder's current share count. */
  readonly founderShares: number;
  /** Current per-share mark, used to seed the pre-money default. */
  readonly pricePerShare: number;
}

function numberOf(value: string): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

export function DilutionCalculator({
  fullyDilutedShares,
  founderShares,
  pricePerShare,
}: DilutionCalculatorProps): React.JSX.Element {
  const [amount, setAmount] = useState('6000000');
  const [preMoney, setPreMoney] = useState(() => {
    const seeded = Math.round(fullyDilutedShares * Math.max(pricePerShare, 0));
    return seeded > 0 ? String(seeded) : '24000000';
  });
  const [poolIncrease, setPoolIncrease] = useState('0');

  const raise = numberOf(amount);
  const pre = numberOf(preMoney);
  const poolPct = Math.min(0.5, Math.max(0, numberOf(poolIncrease) / 100));

  const post = pre + raise;
  const dilution = post > 0 ? raise / post : 0;
  const newInvestorShares = dilution > 0 && dilution < 1 ? (fullyDilutedShares * dilution) / (1 - dilution) : 0;
  const poolShares = fullyDilutedShares * poolPct;
  const dilutedTotal = fullyDilutedShares + newInvestorShares + poolShares;

  const founderBefore = fullyDilutedShares === 0 ? 0 : founderShares / fullyDilutedShares;
  const founderAfter = dilutedTotal === 0 ? 0 : founderShares / dilutedTotal;
  const pricePerNewShare = newInvestorShares > 0 ? raise / newInvestorShares : 0;

  return (
    <div className="flex flex-col gap-3">
      <SectionHeading>Dilution calculator</SectionHeading>

      <div className="grid gap-3 sm:grid-cols-3">
        <label className="block">
          <span className="label-caps-faint">Raise (USD)</span>
          <input className="field tap-target mt-1 sm:min-h-0" inputMode="numeric" value={amount} onChange={(event) => setAmount(event.target.value)} />
          <span className="mt-1 block text-[10px] text-ink-faint">{formatMoney(raise)}</span>
        </label>
        <label className="block">
          <span className="label-caps-faint">Pre-money (USD)</span>
          <input className="field tap-target mt-1 sm:min-h-0" inputMode="numeric" value={preMoney} onChange={(event) => setPreMoney(event.target.value)} />
          <span className="mt-1 block text-[10px] text-ink-faint">{formatMoney(pre)}</span>
        </label>
        <label className="block">
          <span className="label-caps-faint">Pool top-up (%)</span>
          <input className="field tap-target mt-1 sm:min-h-0" inputMode="decimal" value={poolIncrease} onChange={(event) => setPoolIncrease(event.target.value)} />
          <span className="mt-1 block text-[10px] text-ink-faint">{formatCount(poolShares)} shares</span>
        </label>
      </div>

      {/* Two columns, not three: this panel is half a row on a desktop, and a
          third track leaves a nine-character label beside a nine-character
          figure with nowhere to go. */}
      <KeyValueGrid
        columns={2}
        items={[
          { label: 'Post-money', value: formatMoney(post) },
          { label: 'Round dilution', value: formatPct(dilution, 2) },
          { label: 'Price per new share', value: pricePerNewShare > 0 ? formatMoney(pricePerNewShare) : '—' },
          { label: 'New investor shares', value: formatCount(newInvestorShares) },
          { label: 'Fully diluted after', value: formatCount(dilutedTotal) },
          {
            label: 'Founder stake',
            value: `${formatPct(founderBefore, 2)} → ${formatPct(founderAfter, 2)}`,
            tone: founderAfter < founderBefore ? 'warn' : undefined,
          },
        ]}
      />

      <p className="text-[11px] leading-relaxed text-ink-faint">
        Preview only. Nothing here is submitted, and the terms a round actually clears at are decided by the engine against venture
        liquidity, your metrics and what the market believes.
      </p>
    </div>
  );
}
