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
import { KeyValueGrid, SectionHeading, SliderField, roundStep } from '@/components/ui';
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

  const mark = fullyDilutedShares * Math.max(pricePerShare, 0);
  const raiseMax = Math.max(mark, raise, 20_000_000);
  const preMoneyMax = Math.max(mark * 4, pre, 100_000_000);

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

      {/* Ranges follow the current mark: a round is argued inside what the
          company is worth today, and Exact covers ambition beyond it. */}
      <div className="grid gap-3 sm:grid-cols-3">
        <SliderField
          label="Raise (USD)"
          value={raise}
          onChange={(next) => setAmount(String(next))}
          min={0}
          max={raiseMax}
          step={roundStep(raiseMax)}
          format={formatMoney}
        />
        <SliderField
          label="Pre-money (USD)"
          value={pre}
          onChange={(next) => setPreMoney(String(next))}
          min={0}
          max={preMoneyMax}
          step={roundStep(preMoneyMax)}
          format={formatMoney}
        />
        <div>
          <SliderField
            label="Pool top-up"
            value={poolPct}
            onChange={(next) => setPoolIncrease(String(Math.round(next * 100)))}
            min={0}
            max={0.5}
            step={0.01}
            format={formatPct}
            exact={false}
          />
          <span className="mt-1 block text-[10px] text-ink-faint">{formatCount(poolShares)} shares</span>
        </div>
      </div>

      {/* Two columns, not three: this panel is half a row on a desktop, and a
          third track leaves a nine-character label beside a nine-character
          figure with nowhere to go. */}
      <KeyValueGrid
        columns={2}
        items={[
          { label: 'Post-money', value: formatMoney(post) },
          { label: 'Round dilution', value: formatPct(dilution) },
          { label: 'Price per new share', value: pricePerNewShare > 0 ? formatMoney(pricePerNewShare) : '—' },
          { label: 'New investor shares', value: formatCount(newInvestorShares) },
          { label: 'Fully diluted after', value: formatCount(dilutedTotal) },
          {
            label: 'Founder stake',
            value: `${formatPct(founderBefore)} → ${formatPct(founderAfter)}`,
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
