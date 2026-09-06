'use client';

/**
 * The six figures, two up.
 *
 * Cash, revenue, gross margin, runway, market cap, headcount — read in that
 * order, because that is the order a founder checks whether anything else this
 * quarter matters. Each card states the number on the page and opens the sheet
 * that decomposes it, so the figure is never a dead end.
 *
 * Pure in its props: the arithmetic is the engine's (`negativeCashQuarters`,
 * `CompanyQuarterMetrics`) and the formatting is `@frontier/shared`'s.
 */

import type { Company, CompanyQuarterMetrics, Quote } from '@frontier/contracts';
import { formatMoney, formatPct, formatQuarterCount, formatScore } from '@frontier/shared';
import { SOLVENCY_NEGATIVE_QUARTERS, negativeCashQuarters } from '@frontier/simulation';
import { StatCard } from '@/components/ui';
import { sheetHref } from '@/lib/sheets';
import { headcountOf } from '../reporting/util';

/**
 * `formatQuarterCount` writes "6 quarters"; a 2-up card wants the figure big
 * and the word small, or a long runway wraps onto a second line and every card
 * in the row grows with it. The split keeps the shared formatter authoritative
 * for both the digits and the plural.
 */
function runwayParts(quarters: number): { value: string; unit: string } {
  const text = formatQuarterCount(quarters);
  const at = text.lastIndexOf(' ');
  return at < 0 ? { value: text, unit: '' } : { value: text.slice(0, at), unit: text.slice(at + 1) };
}

export interface FiguresGridProps {
  readonly company: Company;
  /** Null until the first quarter resolves. */
  readonly metrics: CompanyQuarterMetrics | null;
  readonly marketCap: number;
  /** This company's own quotes, oldest first. Empty while private. */
  readonly quotes: readonly Quote[];
}

export function FiguresGrid({ company, metrics, marketCap, quotes }: FiguresGridProps): React.JSX.Element {
  const listed = company.instrumentId !== null && quotes.length > 0;
  const lastQuote = quotes.length === 0 ? null : (quotes[quotes.length - 1] ?? null);

  const openingCash = company.financials.cash - company.financials.quarterlyBurn;
  const cashDelta = openingCash > 0 ? company.financials.quarterlyBurn / openingCash : null;
  // Derived from the filed statements, never stored: consecutive closed
  // quarters that ended below zero. Two is the wind-up.
  const negativeQuarters = negativeCashQuarters(company);
  const runway = metrics?.runwayQuarters ?? null;
  const runwayFigure = runway === null ? null : runwayParts(runway);
  const headcount = headcountOf(company);

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
      <StatCard
        label="Cash"
        iconName="vault"
        value={formatMoney(company.financials.cash)}
        delta={cashDelta ?? undefined}
        tone={company.financials.cash <= 0 ? 'loss' : undefined}
        hint={`${negativeQuarters} of ${SOLVENCY_NEGATIVE_QUARTERS} quarters below zero`}
        href={sheetHref('financials')}
      />
      <StatCard
        label="Revenue"
        iconName="coins"
        value={formatMoney(company.financials.revenueQuarterly)}
        delta={metrics === null ? undefined : metrics.revenueGrowthYoY}
        hint={metrics === null ? 'This quarter' : `Year on year · ${formatMoney(metrics.revenueTtm)} trailing`}
        href={sheetHref('financials')}
      />
      <StatCard
        label="Gross margin"
        iconName="ledger"
        value={metrics === null ? '—' : formatPct(metrics.grossMarginPct)}
        hint={metrics === null ? 'Computed at the first resolution' : `Operating margin ${formatPct(metrics.operatingMarginPct)}`}
        href={sheetHref('financials')}
      />
      <StatCard
        label="Runway"
        iconName="gauge"
        value={runwayFigure === null ? '—' : runwayFigure.value}
        unit={runwayFigure?.unit}
        tone={runway === null ? undefined : runway < 3 ? 'loss' : runway < 6 ? 'warn' : undefined}
        hint={runway === null ? 'Computed at the first resolution' : 'At the current burn'}
        href={sheetHref('capital')}
      />
      <StatCard
        label="Market cap"
        iconName="chart"
        value={formatMoney(marketCap)}
        delta={listed && lastQuote !== null ? lastQuote.return : undefined}
        spark={listed ? quotes.map((quote) => quote.price) : undefined}
        hint={listed ? 'Last traded close' : 'Private — fundamental anchor'}
        href={sheetHref('exchange')}
      />
      <StatCard
        label="Headcount"
        iconName="people"
        value={formatScore(headcount)}
        hint={`${company.employees.openRoles} open roles · morale ${Math.round(company.employees.morale)}`}
        href={sheetHref('people')}
      />
    </div>
  );
}
