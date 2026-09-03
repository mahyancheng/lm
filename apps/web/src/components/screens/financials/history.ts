/**
 * Chart and table data for the Financials History tab.
 *
 * Pure and deterministic. Every function here reshapes statements the engine
 * filed — it selects, orders and labels, and it computes no economics. The one
 * arithmetic it does do is presentational: a quarter-on-quarter change between
 * two figures the engine already committed, and the whole-number tick ladder an
 * axis is drawn against.
 *
 * The information boundary is respected at the call site: a rival's statements
 * are read through `PlayerView`, which has already reduced them to what a
 * listed company files. This file never reaches into `SessionState`.
 */

import type { Company, FinancialQuarter, PlayerView } from '@frontier/contracts';
import { quarterLabel } from '@frontier/contracts';

/* -------------------------------------------------------------------------- */
/*  Selection                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Filed statements for one company, oldest first.
 *
 * Empty for a private rival (which files nothing), for a world that keeps no
 * statements, and for a company that has not closed a quarter yet. Empty is the
 * only "no data" state: nothing here substitutes a zero for a withheld figure.
 */
export function financialHistoryFor(view: PlayerView, companyId: string): readonly FinancialQuarter[] {
  const company: Partial<Company> | undefined =
    companyId === view.ownCompany.id ? view.ownCompany : view.visibleCompanies.find((entry) => entry.id === companyId);
  const history = company?.financialHistory;
  if (history === undefined) return [];
  return [...history].sort((a, b) => a.quarter - b.quarter);
}

/** One statement by quarter, or null. */
export function statementAt(history: readonly FinancialQuarter[], quarter: number | null): FinancialQuarter | null {
  if (quarter === null) return null;
  return history.find((entry) => entry.quarter === quarter) ?? null;
}

/** The most recent statement, or null on an empty series. */
export function latestStatement(history: readonly FinancialQuarter[]): FinancialQuarter | null {
  return history.length === 0 ? null : (history[history.length - 1] ?? null);
}

/** One figure per quarter, in quarter order. */
export function seriesOf(history: readonly FinancialQuarter[], pick: (entry: FinancialQuarter) => number | null): number[] {
  return history.map((entry) => {
    const value = pick(entry);
    return value === null || !Number.isFinite(value) ? 0 : value;
  });
}

/** Quarter labels for an x axis, in the same order as `seriesOf`. */
export function quarterLabels(history: readonly FinancialQuarter[], startYear: number): string[] {
  return history.map((entry) => quarterLabel(startYear, entry.quarter));
}

/* -------------------------------------------------------------------------- */
/*  The primary figure                                                         */
/* -------------------------------------------------------------------------- */

/** The latest value of a series, or null when the series is empty. */
export function latestOf(values: readonly number[]): number | null {
  return values.length === 0 ? null : (values[values.length - 1] ?? null);
}

/**
 * Quarter-on-quarter change as a whole percentage.
 *
 * Null when there is no previous quarter, and null rather than infinity when
 * the previous quarter was zero — a percentage change from nothing is not a
 * percentage, and printing one would be inventing a number.
 */
export function qoqDeltaPct(values: readonly number[]): number | null {
  if (values.length < 2) return null;
  const last = values[values.length - 1];
  const previous = values[values.length - 2];
  if (last === undefined || previous === undefined) return null;
  if (previous === 0) return null;
  const change = (last - previous) / Math.abs(previous);
  if (!Number.isFinite(change)) return null;
  return Math.round(change * 100);
}

/* -------------------------------------------------------------------------- */
/*  Axis ticks                                                                 */
/* -------------------------------------------------------------------------- */

/** The smallest 1/2/5 × 10ⁿ step at or above `raw`, floored at one whole unit. */
export function niceStep(raw: number): number {
  const target = Math.abs(raw);
  if (!Number.isFinite(target) || target <= 1) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(target));
  for (const factor of [1, 2, 5, 10]) {
    const step = factor * magnitude;
    if (step >= target) return step;
  }
  return 10 * magnitude;
}

/**
 * A whole-number tick ladder covering `[min, max]`.
 *
 * Whole numbers only: the axis is read at a glance on a 390px phone, and a tick
 * of `1,234,567.89` is not read at a glance. Always at least one tick, always
 * ascending, never duplicated.
 */
export function wholeNumberTicks(min: number, max: number, count = 3): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0];
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  if (lo === hi) return [Math.round(lo)];
  const slots = Math.max(2, Math.round(count));
  const step = niceStep((hi - lo) / (slots - 1));
  const start = Math.floor(lo / step) * step;
  const ticks: number[] = [];
  for (let value = start; value <= hi + step / 2; value += step) {
    const rounded = Math.round(value);
    if (ticks[ticks.length - 1] !== rounded) ticks.push(rounded);
  }
  if (ticks.length === 0) ticks.push(Math.round(lo));
  return ticks;
}

/* -------------------------------------------------------------------------- */
/*  Bars                                                                       */
/* -------------------------------------------------------------------------- */

export interface HistoryBar {
  readonly quarter: number;
  readonly label: string;
  readonly value: number;
  /** True when the figure is negative, so the bar is drawn on the loss side. */
  readonly negative: boolean;
}

/** A bar per quarter for one picked figure. */
export function barsOf(
  history: readonly FinancialQuarter[],
  startYear: number,
  pick: (entry: FinancialQuarter) => number | null,
): HistoryBar[] {
  return history.map((entry) => {
    const raw = pick(entry);
    const value = raw === null || !Number.isFinite(raw) ? 0 : raw;
    return { quarter: entry.quarter, label: quarterLabel(startYear, entry.quarter), value, negative: value < 0 };
  });
}

/* -------------------------------------------------------------------------- */
/*  Revenue by source                                                          */
/* -------------------------------------------------------------------------- */

/** One segment of a stacked bar. `key` is stable, so colours never reshuffle. */
export interface StackSegment {
  readonly key: 'products' | 'contracts' | 'other';
  readonly label: string;
  readonly value: number;
}

export interface StackedQuarter {
  readonly quarter: number;
  readonly label: string;
  readonly segments: readonly StackSegment[];
  /** Sum of the positive segments — the height the bar is drawn to. */
  readonly total: number;
}

const SOURCE_LABELS: Readonly<Record<StackSegment['key'], string>> = {
  products: 'Product lines',
  contracts: 'Contracts',
  other: 'Chain and accords',
};

/**
 * Revenue split per quarter, for the stacked bars.
 *
 * A quarter whose split was withheld (a listed rival files the total, not the
 * split) contributes no stack at all rather than a stack of zeroes: absent is
 * absent.
 */
export function revenueStacks(history: readonly FinancialQuarter[], startYear: number): StackedQuarter[] {
  const stacks: StackedQuarter[] = [];
  for (const entry of history) {
    const split = entry.income.revenueBySource;
    if (split === undefined) continue;
    const segments: StackSegment[] = [
      { key: 'products', label: SOURCE_LABELS.products, value: split.productsUsd },
      { key: 'contracts', label: SOURCE_LABELS.contracts, value: split.contractsUsd },
      { key: 'other', label: SOURCE_LABELS.other, value: split.otherUsd },
    ];
    stacks.push({
      quarter: entry.quarter,
      label: quarterLabel(startYear, entry.quarter),
      segments,
      total: segments.reduce((sum, segment) => sum + Math.max(0, segment.value), 0),
    });
  }
  return stacks;
}

/* -------------------------------------------------------------------------- */
/*  Export                                                                     */
/* -------------------------------------------------------------------------- */

/** Column order of the CSV export. Stable: a saved file keeps comparing. */
export const HISTORY_CSV_COLUMNS = [
  'quarter',
  'revenue',
  'revenue_products',
  'revenue_contracts',
  'revenue_other',
  'cogs',
  'gross_profit',
  'opex',
  'opex_payroll',
  'opex_research',
  'opex_marketing',
  'opex_compute',
  'opex_other',
  'ebitda',
  'depreciation',
  'operating_income',
  'interest',
  'tax',
  'net_income',
  'cash',
  'receivables',
  'compute_assets',
  'other_assets',
  'total_assets',
  'debt',
  'deferred_revenue',
  'other_liabilities',
  'total_liabilities',
  'equity',
  'cf_operating',
  'cf_investing',
  'cf_financing',
  'cf_net_change',
  'ending_cash',
  'headcount',
  'gross_margin_pct',
  'growth_qoq_pct',
  'growth_yoy_pct',
  'runway_quarters',
  'run_rate',
  'market_cap',
  'share_price',
] as const;

/** A number as whole units, or an empty cell where the figure was withheld. */
function cell(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '';
  return String(Math.round(value));
}

/**
 * The filed history as CSV text.
 *
 * Whole dollars and whole percentages, one row per quarter, oldest first. A
 * withheld figure is an EMPTY cell, never a zero: the export carries the same
 * absences the projection does.
 */
export function historyCsv(history: readonly FinancialQuarter[], startYear: number): string {
  const rows: string[] = [HISTORY_CSV_COLUMNS.join(',')];
  for (const entry of history) {
    const i = entry.income;
    const b = entry.balance;
    const c = entry.cashFlow;
    const k = entry.kpis;
    rows.push(
      [
        quarterLabel(startYear, entry.quarter),
        cell(i.revenueUsd),
        cell(i.revenueBySource?.productsUsd),
        cell(i.revenueBySource?.contractsUsd),
        cell(i.revenueBySource?.otherUsd),
        cell(i.cogsUsd),
        cell(i.grossProfitUsd),
        cell(i.opexUsd),
        cell(i.opexByLine?.payrollUsd),
        cell(i.opexByLine?.researchUsd),
        cell(i.opexByLine?.marketingUsd),
        cell(i.opexByLine?.computeUsd),
        cell(i.opexByLine?.otherUsd),
        cell(i.ebitdaUsd),
        cell(i.depreciationUsd),
        cell(i.operatingIncomeUsd),
        cell(i.interestUsd),
        cell(i.taxUsd),
        cell(i.netIncomeUsd),
        cell(b.cashUsd),
        cell(b.receivablesUsd),
        cell(b.computeAssetsUsd),
        cell(b.otherAssetsUsd),
        cell(b.totalAssetsUsd),
        cell(b.debtUsd),
        cell(b.deferredRevenueUsd),
        cell(b.otherLiabilitiesUsd),
        cell(b.totalLiabilitiesUsd),
        cell(b.equityUsd),
        cell(c.operatingUsd),
        cell(c.investingUsd),
        cell(c.financingUsd),
        cell(c.netChangeUsd),
        cell(c.endingCashUsd),
        cell(k.headcount),
        cell(k.grossMarginPct * 100),
        cell(k.revenueGrowthQoQ * 100),
        cell(k.revenueGrowthYoY * 100),
        cell(k.runwayQuarters),
        cell(k.runRateUsd),
        cell(k.marketCapUsd),
        cell(k.sharePriceUsd),
      ].join(','),
    );
  }
  return rows.join('\n');
}
