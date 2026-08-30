'use client';

/**
 * Quarterly history.
 *
 * Live state holds one quarter of accounts at a time — the history lives in
 * the ledger and in what the company has actually filed. So this panel is built
 * from two sources that genuinely carry a per-quarter series: the earnings
 * filings on the public record, and the rolling quote history for a listed
 * instrument.
 *
 * A private company files nothing, and the panel says so rather than drawing a
 * line through numbers that do not exist.
 */

import type { PlayerView, Quote } from '@frontier/contracts';
import { quarterLabel } from '@frontier/contracts';
import { formatMoney } from '@frontier/shared';
import { EmptyState, LineChart, SectionHeading, type LineSeries } from '@/components/ui';
import { disclosedMetric, earningsHistory } from '../reporting/util';

export interface HistoryPanelProps {
  readonly view: PlayerView;
  readonly companyId: string;
  readonly startYear: number;
  /** Rolling quotes for this company's instrument, oldest first. Empty when unlisted. */
  readonly quotes: readonly Quote[];
}

export function HistoryPanel({ view, companyId, startYear, quotes }: HistoryPanelProps): React.JSX.Element {
  const filings = earningsHistory(view, companyId);
  const labels = filings.map((filing) => quarterLabel(startYear, filing.quarter));

  const revenue = filings.map((filing) => disclosedMetric(filing, 'revenue') ?? 0);
  const operating = filings.map((filing) => disclosedMetric(filing, 'operatingIncome') ?? 0);
  const cash = filings.map((filing) => disclosedMetric(filing, 'cash') ?? 0);
  const debt = filings.map((filing) => disclosedMetric(filing, 'debt') ?? 0);

  const resultSeries: LineSeries[] = [
    { id: 'revenue', label: 'Revenue', values: revenue, tone: 'brand' },
    { id: 'operating', label: 'Operating income', values: operating, tone: 'warn' },
  ];
  const positionSeries: LineSeries[] = [
    { id: 'cash', label: 'Cash', values: cash, tone: 'gain' },
    { id: 'debt', label: 'Debt', values: debt, tone: 'loss' },
  ];

  const priceSeries: LineSeries[] = [
    { id: 'price', label: 'Close', values: quotes.map((quote) => quote.price), tone: 'brand' },
  ];

  if (filings.length === 0 && quotes.length === 0) {
    return (
      <EmptyState
        glyph="HST"
        title="No filed history yet"
        message="Live state carries one quarter of accounts. A per-quarter series appears once the company files earnings on the public record, which begins when it lists — or once its instrument has a rolling quote history."
      />
    );
  }

  return (
    <div className="flex flex-col gap-5">
      {filings.length >= 2 ? (
        <>
          <div>
            <SectionHeading rule>Reported result</SectionHeading>
            <LineChart
              className="mt-2"
              series={resultSeries}
              xLabels={labels}
              includeZero
              formatValue={(value) => formatMoney(value)}
              height={170}
            />
          </div>
          <div>
            <SectionHeading rule>Reported position</SectionHeading>
            <LineChart
              className="mt-2"
              series={positionSeries}
              xLabels={labels}
              includeZero
              formatValue={(value) => formatMoney(value)}
              height={170}
            />
          </div>
        </>
      ) : filings.length === 1 ? (
        <p className="text-[11px] text-ink-faint">
          One filing on the record so far ({labels[0]}). A second quarter draws the series.
        </p>
      ) : null}

      {quotes.length >= 2 ? (
        <div>
          <SectionHeading rule>Traded price</SectionHeading>
          <LineChart
            className="mt-2"
            series={priceSeries}
            xLabels={quotes.map((quote) => quarterLabel(startYear, quote.quarter))}
            formatValue={(value) => formatMoney(value)}
            showLegend={false}
            height={150}
          />
        </div>
      ) : null}

      <p className="text-[10px] text-ink-faint">
        Filed figures come from the company&apos;s own earnings disclosures on the public record; nothing here is restated by the
        interface.
      </p>
    </div>
  );
}
