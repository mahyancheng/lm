'use client';

/**
 * Financial history: every quarter the engine has closed.
 *
 * The engine files a complete statement each quarter and keeps a bounded window
 * of them on the company. This tab renders that window and nothing else — no
 * figure here is computed by the screen, and the only arithmetic it does is the
 * quarter-on-quarter change between two committed figures, which is done in
 * `history.ts` where it can be tested.
 *
 * The chart contract this screen is held to: one primary figure per card with
 * the chart second, line or bar only, whole-number axes through the shared
 * formatters, colours from the CSS tokens, and every chart legible full width
 * at 160px tall on a 390px phone.
 */

import { useMemo, useState } from 'react';
import type { FinancialQuarter } from '@frontier/contracts';
import { quarterLabel } from '@frontier/contracts';
import { formatCount, formatMoney, formatPct, formatQuarterCount } from '@frontier/shared';
import {
  BarSeries,
  DeltaBadge,
  EmptyState,
  Icon,
  LineChart,
  Panel,
  SectionHeading,
  StackedBars,
  TONE_SOLID,
  Tag,
  cx,
  type Tone,
} from '@/components/ui';
import { StatementTable, type StatementRow } from '@/components/screens/reporting/StatementTable';
import {
  historyCsv,
  latestOf,
  qoqDeltaPct,
  quarterLabels,
  revenueStacks,
  seriesOf,
  statementAt,
  wholeNumberTicks,
} from './history';

export interface FinancialHistoryProps {
  readonly history: readonly FinancialQuarter[];
  readonly startYear: number;
  readonly companyName: string;
}

/* -------------------------------------------------------------------------- */
/*  Trend card                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * One figure, then its shape.
 *
 * The primary figure is the latest committed value and the badge beside it is
 * the change against the previous quarter as a whole percent. The chart sits
 * under both, because the number is the answer and the chart is the argument.
 */
function TrendCard({
  label,
  figure,
  deltaPct,
  hint,
  tone,
  children,
}: {
  readonly label: string;
  readonly figure: string;
  readonly deltaPct: number | null;
  readonly hint?: string;
  readonly tone?: Tone;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="panel-surface flex flex-col gap-2 p-3">
      <div>
        <div className="label-caps-faint">{label}</div>
        <div className="mt-0.5 flex flex-wrap items-baseline gap-2">
          <span className={cx('figure text-[20px] leading-none', tone === undefined ? 'text-ink' : `tone-${tone}`)}>{figure}</span>
          {deltaPct === null ? null : <DeltaBadge value={deltaPct / 100} format="percent" />}
        </div>
        {hint === undefined ? null : <div className="mt-1 text-[11px] text-ink-faint">{hint}</div>}
      </div>
      {children}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  The tab                                                                    */
/* -------------------------------------------------------------------------- */

export function FinancialHistory({ history, startYear, companyName }: FinancialHistoryProps): React.JSX.Element {
  const [selectedQuarter, setSelectedQuarter] = useState<number | null>(null);
  const [showExport, setShowExport] = useState(false);
  const [copied, setCopied] = useState(false);

  const labels = useMemo(() => quarterLabels(history, startYear), [history, startYear]);
  const revenue = useMemo(() => seriesOf(history, (entry) => entry.income.revenueUsd), [history]);
  const netIncome = useMemo(() => seriesOf(history, (entry) => entry.income.netIncomeUsd), [history]);
  const cash = useMemo(() => seriesOf(history, (entry) => entry.balance.cashUsd), [history]);
  const runway = useMemo(() => seriesOf(history, (entry) => entry.kpis.runwayQuarters), [history]);
  const margin = useMemo(() => seriesOf(history, (entry) => entry.kpis.grossMarginPct), [history]);
  const headcount = useMemo(() => seriesOf(history, (entry) => entry.kpis.headcount), [history]);
  const listed = history.some((entry) => entry.kpis.sharePriceUsd !== null);
  const sharePrice = useMemo(() => seriesOf(history, (entry) => entry.kpis.sharePriceUsd), [history]);
  const stacks = useMemo(() => revenueStacks(history, startYear), [history, startYear]);

  const csv = useMemo(() => historyCsv(history, startYear), [history, startYear]);

  const selected = statementAt(history, selectedQuarter) ?? (history[history.length - 1] ?? null);

  if (history.length === 0) {
    return (
      <EmptyState
        icon="chart"
        title="No closed quarters yet"
        message="The engine files a full statement the first time a quarter resolves. Once one has, every quarter since appears here."
      />
    );
  }

  const resultCategories = history.map((entry, index) => ({
    label: labels[index] ?? String(entry.quarter),
    values: [revenue[index] ?? 0, netIncome[index] ?? 0],
  }));
  const headcountCategories = history.map((entry, index) => ({
    label: labels[index] ?? String(entry.quarter),
    values: [headcount[index] ?? 0],
  }));

  const resultTicks = wholeNumberTicks(Math.min(0, ...revenue, ...netIncome), Math.max(0, ...revenue, ...netIncome));
  const headcountTicks = wholeNumberTicks(0, Math.max(1, ...headcount));

  const onCopy = (): void => {
    // The export is text, so the clipboard is the whole mechanism. A browser
    // that refuses it still shows the text, which is why the panel opens first.
    try {
      void navigator.clipboard?.writeText(csv);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      {/* --- trends ------------------------------------------------------- */}
      <div className="grid gap-3 lg:grid-cols-2">
        <TrendCard
          label="Revenue and net income"
          figure={formatMoney(latestOf(revenue) ?? 0)}
          deltaPct={qoqDeltaPct(revenue)}
          hint={`Net income ${formatMoney(latestOf(netIncome) ?? 0)} in the latest quarter`}
        >
          <BarSeries
            categories={resultCategories}
            series={[
              { id: 'revenue', label: 'Revenue', tone: 'brand' },
              { id: 'net', label: 'Net income', tone: (latestOf(netIncome) ?? 0) >= 0 ? 'gain' : 'loss' },
            ]}
            ticks={resultTicks}
            formatValue={(value) => formatMoney(value)}
            height={150}
          />
        </TrendCard>

        <TrendCard
          label="Cash"
          figure={formatMoney(latestOf(cash) ?? 0)}
          deltaPct={qoqDeltaPct(cash)}
          hint={`Runway ${formatQuarterCount(latestOf(runway) ?? 0)} at the latest quarter's burn`}
        >
          <LineChart
            series={[{ id: 'cash', label: 'Cash', values: cash, tone: 'gain' }]}
            xLabels={labels}
            includeZero
            showLegend={false}
            formatValue={(value) => formatMoney(value)}
            height={150}
          />
        </TrendCard>

        <TrendCard
          label="Runway"
          figure={formatQuarterCount(latestOf(runway) ?? 0)}
          deltaPct={qoqDeltaPct(runway)}
          tone={(latestOf(runway) ?? 0) < 6 ? 'warn' : undefined}
          hint="Quarters of cash left at each quarter's own burn."
        >
          <LineChart
            series={[{ id: 'runway', label: 'Runway', values: runway, tone: 'info' }]}
            xLabels={labels}
            includeZero
            showLegend={false}
            formatValue={(value) => formatCount(value)}
            height={150}
          />
        </TrendCard>

        <TrendCard
          label="Gross margin"
          figure={formatPct(latestOf(margin) ?? 0)}
          deltaPct={qoqDeltaPct(margin)}
          hint="Gross profit over revenue, as the quarter closed."
        >
          <LineChart
            series={[{ id: 'margin', label: 'Gross margin', values: margin, tone: 'brand' }]}
            xLabels={labels}
            includeZero
            showLegend={false}
            formatValue={(value) => formatPct(value)}
            height={150}
          />
        </TrendCard>

        <TrendCard
          label="Headcount"
          figure={formatCount(latestOf(headcount) ?? 0)}
          deltaPct={qoqDeltaPct(headcount)}
          hint="Everyone on the payroll at the close of the quarter."
        >
          <BarSeries
            categories={headcountCategories}
            series={[{ id: 'headcount', label: 'Headcount', tone: 'info' }]}
            ticks={headcountTicks}
            formatValue={(value) => formatCount(value)}
            showLegend={false}
            height={150}
          />
        </TrendCard>

        {listed ? (
          <TrendCard
            label="Share price"
            figure={formatMoney(latestOf(sharePrice) ?? 0, 'full')}
            deltaPct={qoqDeltaPct(sharePrice)}
            hint="Closing price on the tape, from the same print the market capitalisation is read from."
          >
            <LineChart
              series={[{ id: 'price', label: 'Close', values: sharePrice, tone: 'brand' }]}
              xLabels={labels}
              showLegend={false}
              formatValue={(value) => formatMoney(value, 'full')}
              height={150}
            />
          </TrendCard>
        ) : null}
      </div>

      {/* --- by source ---------------------------------------------------- */}
      {stacks.length === 0 ? null : (
        <Panel
          title="By source"
          iconName="coins"
          subtitle="What each quarter's revenue was made of. A negative chain adjustment is carried in the total, not drawn as a part."
        >
          <StackedBars
            data={stacks.map((stack) => ({
              label: stack.label,
              segments: stack.segments.map((segment, index) => ({
                ...segment,
                tone: (['brand', 'info', 'warn'] as const)[index] ?? 'neutral',
              })),
            }))}
            formatValue={(value) => formatMoney(value)}
            height={150}
          />
        </Panel>
      )}

      {/* --- the quarter selector and its statements ---------------------- */}
      <Panel
        title="Quarter"
        iconName="ledger"
        subtitle="Tap a quarter to read the statements exactly as they were filed."
        actions={
          <button type="button" className="btn btn-ghost tap-target gap-1.5 px-2" onClick={() => setShowExport((open) => !open)}>
            <Icon name="ledger" size={15} accent="current" />
            {showExport ? 'Hide export' : 'Export CSV'}
          </button>
        }
      >
        <div className="no-scrollbar -mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1">
          {history.map((entry) => {
            const active = (selected?.quarter ?? null) === entry.quarter;
            return (
              <button
                key={entry.quarter}
                type="button"
                onClick={() => setSelectedQuarter(entry.quarter)}
                aria-pressed={active}
                className={cx(
                  'tap-target shrink-0 rounded-chip px-3 text-[11px] font-semibold whitespace-nowrap transition-colors',
                  active ? TONE_SOLID.brand : 'bg-raised text-ink-dim hover:text-ink',
                )}
              >
                {quarterLabel(startYear, entry.quarter)}
              </button>
            );
          })}
        </div>

        {showExport ? (
          <div className="mt-3 border-t border-hair pt-3">
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" className="btn tap-target gap-1.5" onClick={onCopy}>
                <Icon name="ledger" size={15} accent="current" />
                {copied ? 'Copied' : 'Copy to clipboard'}
              </button>
              <span className="text-[11px] text-ink-faint">
                {history.length} quarter{history.length === 1 ? '' : 's'} · whole dollars and whole percentages · a withheld figure is an
                empty cell
              </span>
            </div>
            <textarea
              readOnly
              value={csv}
              aria-label={`${companyName} financial history as CSV`}
              className="mt-2 h-40 w-full resize-y rounded-card border border-hair bg-raised p-2 font-mono text-[10px] text-ink-dim"
            />
          </div>
        ) : null}

        {selected === null ? null : <QuarterStatements entry={selected} startYear={startYear} />}
      </Panel>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  One quarter's statements                                                   */
/* -------------------------------------------------------------------------- */

function QuarterStatements({ entry, startYear }: { readonly entry: FinancialQuarter; readonly startYear: number }): React.JSX.Element {
  const income = entry.income;
  const balance = entry.balance;
  const cashFlow = entry.cashFlow;
  const kpis = entry.kpis;

  const incomeRows: StatementRow[] = [
    { key: 'revenue', label: 'Revenue', value: formatMoney(income.revenueUsd), emphasis: true },
    ...(income.revenueBySource === undefined
      ? []
      : [
          { key: 'rev-products', label: 'Product lines', value: formatMoney(income.revenueBySource.productsUsd), indent: true },
          { key: 'rev-contracts', label: 'Contracts', value: formatMoney(income.revenueBySource.contractsUsd), indent: true },
          { key: 'rev-other', label: 'Chain and accords', value: formatMoney(income.revenueBySource.otherUsd), indent: true },
        ]),
    { key: 'cogs', label: 'Cost of revenue', value: formatMoney(-income.cogsUsd), indent: true, tone: 'loss' as const },
    {
      key: 'gross',
      label: 'Gross profit',
      value: formatMoney(income.grossProfitUsd),
      secondary: formatPct(kpis.grossMarginPct),
      emphasis: true,
      tone: income.grossProfitUsd >= 0 ? ('gain' as const) : ('loss' as const),
    },
    ...(income.opexByLine === undefined
      ? []
      : [
          { key: 'payroll', label: 'Payroll', value: formatMoney(-income.opexByLine.payrollUsd), indent: true },
          { key: 'research', label: 'Research and development', value: formatMoney(-income.opexByLine.researchUsd), indent: true },
          { key: 'marketing', label: 'Marketing', value: formatMoney(-income.opexByLine.marketingUsd), indent: true },
          { key: 'compute', label: 'Training compute', value: formatMoney(-income.opexByLine.computeUsd), indent: true },
          { key: 'opex-other', label: 'Other operating', value: formatMoney(-income.opexByLine.otherUsd), indent: true },
        ]),
    { key: 'opex', label: 'Operating expenses', value: formatMoney(-income.opexUsd), emphasis: true },
    {
      key: 'ebitda',
      label: 'EBITDA',
      value: formatMoney(income.ebitdaUsd),
      emphasis: true,
      tone: income.ebitdaUsd >= 0 ? ('gain' as const) : ('loss' as const),
    },
    { key: 'depreciation', label: 'Depreciation', value: formatMoney(-income.depreciationUsd), indent: true },
    {
      key: 'ebit',
      label: 'Operating income',
      value: formatMoney(income.operatingIncomeUsd),
      emphasis: true,
      tone: income.operatingIncomeUsd >= 0 ? ('gain' as const) : ('loss' as const),
    },
    { key: 'interest', label: 'Interest', value: formatMoney(-income.interestUsd), indent: true },
    { key: 'tax', label: 'Tax', value: formatMoney(-income.taxUsd), indent: true },
    {
      key: 'net',
      label: 'Net income',
      value: formatMoney(income.netIncomeUsd),
      emphasis: true,
      tone: income.netIncomeUsd >= 0 ? ('gain' as const) : ('loss' as const),
    },
  ];

  const balanceRows: StatementRow[] = [
    { key: 'cash', label: 'Cash', value: formatMoney(balance.cashUsd), indent: true },
    { key: 'receivables', label: 'Receivables', value: formatMoney(balance.receivablesUsd), indent: true },
    { key: 'compute-assets', label: 'Compute and fixed assets', value: formatMoney(balance.computeAssetsUsd), indent: true },
    { key: 'other-assets', label: 'Goodwill and investments', value: formatMoney(balance.otherAssetsUsd), indent: true },
    { key: 'assets', label: 'Total assets', value: formatMoney(balance.totalAssetsUsd), emphasis: true },
    { key: 'debt', label: 'Debt', value: formatMoney(balance.debtUsd), indent: true },
    { key: 'deferred', label: 'Deferred revenue', value: formatMoney(balance.deferredRevenueUsd), indent: true },
    { key: 'other-liabilities', label: 'Other liabilities', value: formatMoney(balance.otherLiabilitiesUsd), indent: true },
    { key: 'liabilities', label: 'Total liabilities', value: formatMoney(balance.totalLiabilitiesUsd), emphasis: true },
    {
      key: 'equity',
      label: 'Equity',
      value: formatMoney(balance.equityUsd),
      emphasis: true,
      tone: balance.equityUsd >= 0 ? ('gain' as const) : ('loss' as const),
    },
  ];

  const cashRows: StatementRow[] = [
    { key: 'opening', label: 'Opening cash', value: formatMoney(cashFlow.openingCashUsd) },
    {
      key: 'operating',
      label: 'Operating',
      value: formatMoney(cashFlow.operatingUsd),
      indent: true,
      tone: cashFlow.operatingUsd >= 0 ? ('gain' as const) : ('loss' as const),
    },
    { key: 'investing', label: 'Investing', value: formatMoney(cashFlow.investingUsd), indent: true },
    { key: 'financing', label: 'Financing', value: formatMoney(cashFlow.financingUsd), indent: true },
    {
      key: 'net-change',
      label: 'Net change',
      value: formatMoney(cashFlow.netChangeUsd),
      emphasis: true,
      tone: cashFlow.netChangeUsd >= 0 ? ('gain' as const) : ('loss' as const),
    },
    { key: 'ending', label: 'Ending cash', value: formatMoney(cashFlow.endingCashUsd), emphasis: true },
  ];

  return (
    <div className="mt-4 flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Tag tone="brand" dot>
          {quarterLabel(startYear, entry.quarter)}
        </Tag>
        <Tag>{formatCount(kpis.headcount)} staff</Tag>
        <Tag>Run rate {formatMoney(kpis.runRateUsd)}</Tag>
        {kpis.marketCapUsd === null ? null : <Tag>Market cap {formatMoney(kpis.marketCapUsd)}</Tag>}
        {kpis.sharePriceUsd === null ? null : <Tag>Share {formatMoney(kpis.sharePriceUsd, 'full')}</Tag>}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div>
          <SectionHeading rule>Income statement</SectionHeading>
          <div className="mt-2 max-h-[460px] overflow-y-auto">
            <StatementTable rows={incomeRows} valueHeader="Amount" secondaryHeader="Margin" />
          </div>
        </div>
        <div className="flex flex-col gap-4">
          <div>
            <SectionHeading rule>Balance sheet</SectionHeading>
            <div className="mt-2 overflow-x-auto">
              <StatementTable rows={balanceRows} valueHeader="Amount" />
            </div>
          </div>
          <div>
            <SectionHeading rule>Cash flow</SectionHeading>
            <div className="mt-2 overflow-x-auto">
              <StatementTable rows={cashRows} valueHeader="Amount" />
            </div>
          </div>
        </div>
      </div>

      {entry.productLines === undefined || entry.productLines.length === 0 ? null : (
        <div>
          <SectionHeading rule>Product lines</SectionHeading>
          <div className="mt-2 overflow-x-auto">
            <table className="w-full min-w-[420px] text-[11px]">
              <thead>
                <tr className="text-ink-faint">
                  <th className="py-1 pr-2 text-left font-medium">Line</th>
                  <th className="py-1 px-2 text-right font-medium">Units</th>
                  <th className="py-1 px-2 text-right font-medium">Price</th>
                  <th className="py-1 px-2 text-right font-medium">Revenue</th>
                  <th className="py-1 pl-2 text-right font-medium">Margin</th>
                </tr>
              </thead>
              <tbody>
                {entry.productLines.map((line) => (
                  <tr key={line.productId} className="border-t border-hair">
                    <td className="py-1.5 pr-2 text-ink">{line.name}</td>
                    <td className="figure py-1.5 px-2 text-right text-ink-dim">{formatCount(line.units)}</td>
                    <td className="figure py-1.5 px-2 text-right text-ink-dim">{formatMoney(line.priceUsd, 'full')}</td>
                    <td className="figure py-1.5 px-2 text-right text-ink">{formatMoney(line.revenueUsd)}</td>
                    <td className="figure py-1.5 pl-2 text-right text-ink-dim">{formatPct(line.grossMarginPct)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
