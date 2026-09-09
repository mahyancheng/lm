'use client';

/**
 * "Out of the game."
 *
 * The full-screen verdict a player sees once their company has been wound up.
 * It replaces the game rather than sitting inside it: there is nothing left to
 * decide, so a rail full of screens that no longer accept an instruction would
 * be a lie. One button leaves, and it goes to the start page.
 *
 * Every figure here was selected in `verdict.ts` from committed state. This file
 * lays them out and formats them; it computes nothing.
 */

import Link from 'next/link';
import { quarterLabel } from '@frontier/contracts';
import { formatMoney, formatQuarterCount } from '@frontier/shared';
import { BarSeries, Icon, LineChart, Panel, Tag } from '@/components/ui';
import { rankLabel, type Verdict } from './verdict';

export interface VerdictScreenProps {
  readonly verdict: Verdict;
  readonly startYear: number;
  /** Where "Found a new company" goes. The start page, always. */
  readonly startHref: string;
}

export function VerdictScreen({ verdict, startYear, startHref }: VerdictScreenProps): React.JSX.Element {
  const labels = verdict.history.map((entry) => quarterLabel(startYear, entry.quarter));
  const revenue = verdict.history.map((entry) => entry.income.revenueUsd);
  const cash = verdict.history.map((entry) => entry.balance.cashUsd);

  return (
    <main className="min-h-dvh bg-base px-3 py-8 sm:px-5">
      <div className="mx-auto flex w-full max-w-[640px] flex-col gap-4">
        {/* --- the verdict ------------------------------------------------- */}
        <Panel>
          <div className="flex flex-col items-center gap-3 py-4 text-center">
            <span className="icon-knockout-wash flex size-14 items-center justify-center rounded-panel bg-loss-wash text-loss">
              <Icon name="warning" size={30} accent="inherit" />
            </span>
            <h1 className="text-[22px] leading-tight font-bold tracking-tight text-ink">Out of the game</h1>
            <p className="max-w-[46ch] text-[13px] leading-relaxed text-ink-dim">
              {verdict.companyName} went into administration in {quarterLabel(startYear, verdict.eliminatedQuarter)} after{' '}
              {verdict.causeLine}. The seat is closed: what is left of the company stays on the register and can be bought
              by somebody else.
            </p>
            <div className="flex flex-wrap items-center justify-center gap-1.5">
              <Tag tone="loss">Administration</Tag>
              <Tag>{formatQuarterCount(verdict.quartersSurvived)} survived</Tag>
              <Tag tone="info">{verdict.founderName}</Tag>
            </div>
          </div>
        </Panel>

        {/* --- the run ------------------------------------------------------ */}
        <Panel title="The run" subtitle="What the company managed before it ran out of money." iconName="chart">
          <dl className="grid grid-cols-2 gap-2">
            <Figure label="Quarters survived" value={formatQuarterCount(verdict.quartersSurvived)} />
            <Figure label="Wound up" value={quarterLabel(startYear, verdict.eliminatedQuarter)} />
            <Figure label="Founder net worth" value={formatMoney(verdict.founderNetWorthUsd)} />
            <Figure label="Cause" value={verdict.causeLine} />
          </dl>
        </Panel>

        {/* --- where it finished -------------------------------------------- */}
        <Panel title="Final standing" subtitle="Where the seat finished on each board." iconName="trophy">
          {verdict.standings.length === 0 ? (
            <p className="text-[12px] text-ink-faint">No quarter resolved, so no board ever ranked this seat.</p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {verdict.standings.map((standing) => (
                <li key={standing.board} className="flex items-center justify-between gap-3 rounded-chip bg-wash px-3 py-2">
                  <span className="text-[12.5px] font-semibold text-ink">{standing.label}</span>
                  <span className="figure text-[12.5px] font-bold text-ink-dim">{rankLabel(standing)}</span>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        {/* --- the last two years ------------------------------------------- */}
        <Panel
          title="The last eight quarters"
          subtitle="Revenue the company recognised, and the cash it closed each quarter on."
          iconName="ledger"
        >
          {verdict.history.length === 0 ? (
            <p className="text-[12px] text-ink-faint">The company filed no statements before it was wound up.</p>
          ) : (
            <div className="flex flex-col gap-4">
              <BarSeries
                categories={verdict.history.map((entry, index) => ({ label: labels[index] ?? '', values: [revenue[index] ?? 0] }))}
                series={[{ id: 'revenue', label: 'Revenue', tone: 'brand' }]}
                formatValue={formatMoney}
                height={150}
                ariaLabel="Quarterly revenue over the last eight quarters"
              />
              <LineChart
                series={[{ id: 'cash', label: 'Closing cash', values: cash, tone: 'info' }]}
                xLabels={labels}
                formatValue={formatMoney}
                includeZero
                height={150}
              />
            </div>
          )}
        </Panel>

        {/* --- the way out --------------------------------------------------- */}
        <Link
          href={startHref}
          className="press-pop tap-target flex items-center justify-center gap-2 rounded-panel bg-brand-strong px-4 text-[14px] font-bold text-white shadow-card"
          style={{ minHeight: '52px' }}
        >
          <Icon name="plus" size={18} accent="current" />
          Found a new company
        </Link>
        <p className="text-center text-[11.5px] text-ink-faint">
          Your saves are untouched. This one is marked ended and can still be loaded to read the verdict.
        </p>
      </div>
    </main>
  );
}

function Figure({ label, value }: { readonly label: string; readonly value: string }): React.JSX.Element {
  return (
    <div className="rounded-chip bg-wash px-3 py-2">
      <dt className="text-[10.5px] font-semibold tracking-wide text-ink-faint uppercase">{label}</dt>
      <dd className="figure mt-0.5 text-[14px] font-bold text-ink">{value}</dd>
    </div>
  );
}
