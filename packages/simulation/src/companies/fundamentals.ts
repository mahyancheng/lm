/**
 * @frontier/simulation — companies/fundamentals.ts
 *
 * The rolled-up figures a share price is anchored to.
 *
 * `CompanyFundamentals` exists because pricing needs *history* — trailing
 * revenue, last year's revenue, trailing earnings — and live `SessionState`
 * keeps bounded history on purpose. So the metrics phase (16) rolls the answer
 * up once a quarter and the market phase (13) of the **next** quarter reads it.
 * That one-phase lag is the point: a price is struck against the last reported
 * set of numbers, exactly as a real one is, rather than against figures the
 * quarter has not closed yet.
 *
 * Written for every world version. In world version 1 nothing reads it — the
 * pricing path there is unchanged — so this is a projection, like the metrics
 * beside it, and it moves no economic quantity.
 *
 * Two of the six fields cannot be read off live state and are kept as rolling
 * estimates, by the same estimator `metrics.ts` already uses for trailing
 * revenue:
 *
 * ```text
 * ttm_t          = ttm_{t-1} + x_t - ttm_{t-1} / 4
 * previousQuarter ≈ ttm_{t-1} / 4
 * ```
 *
 * exact for a flat company and convergent for a growing one.
 */

import type { Company, CompanyFundamentals, CompanyQuarterMetrics, SessionState } from '@frontier/contracts';
import { DEFAULT_SHARES_OUTSTANDING } from '@frontier/contracts';
import { clamp, money, ratio, signedMoney } from './util';

/** Net income for the quarter just resolved, from the figures the P&L left behind. */
export function quarterNetIncomeUsd(company: Company, taxRate: number): number {
  const f = company.financials;
  const operating = f.revenueQuarterly - f.cogs - f.payroll - f.marketing - f.rdSpend;
  const preTax = operating - f.interestExpense;
  return preTax > 0 ? preTax * (1 - taxRate) : preTax;
}

/**
 * The single authoritative share count.
 *
 * `MarketInstrument.sharesOutstanding` is the listing's own figure and wins when
 * it exists; the cap table's fully diluted count is the private-company answer;
 * the previous quarter's figure is the fallback so a company never silently
 * resets to the default float after it has been priced once.
 */
export function sharesOutstandingFor(state: SessionState, company: Company): number {
  const instrument =
    company.instrumentId === null ? undefined : state.marketInstruments.find((entry) => entry.id === company.instrumentId && !entry.isReference);
  if (instrument?.sharesOutstanding != null && instrument.sharesOutstanding > 0) return Math.round(instrument.sharesOutstanding);

  const capTable = state.capTables.find((table) => table.companyId === company.id);
  if (capTable !== undefined && capTable.fullyDilutedShares > 0) return Math.round(capTable.fullyDilutedShares);

  const carried = company.fundamentals.sharesOutstanding;
  return carried > 0 ? Math.round(carried) : DEFAULT_SHARES_OUTSTANDING;
}

/**
 * Roll one company's fundamentals forward.
 *
 * `metrics` is this quarter's freshly computed row, which already carries the
 * trailing revenue and year-on-year growth; `previousTtm` is last quarter's
 * trailing revenue, which is what makes the quarter-on-quarter estimate
 * possible. Pure: it returns the block rather than writing it.
 */
export function rollFundamentals(
  state: SessionState,
  company: Company,
  metrics: CompanyQuarterMetrics,
  previousTtmUsd: number,
  taxRate: number,
): CompanyFundamentals {
  const revenue = company.financials.revenueQuarterly;
  const previousQuarterRevenue = previousTtmUsd / 4;
  const growthQoQ = previousQuarterRevenue > 0 ? clamp(revenue / previousQuarterRevenue - 1, -1, 5) : 0;

  const priorNetIncomeTtm = company.fundamentals.netIncomeTtmUsd;
  const netIncome = quarterNetIncomeUsd(company, taxRate);
  const netIncomeTtm = signedMoney(priorNetIncomeTtm + netIncome - priorNetIncomeTtm / 4);

  return {
    revenueTtmUsd: money(Math.max(0, metrics.revenueTtm)),
    revenueGrowthQoQ: growthQoQ,
    revenueGrowthYoY: clamp(metrics.revenueGrowthYoY, -1, 10),
    grossMarginPct: clamp(metrics.grossMarginPct, 0, 1),
    netIncomeTtmUsd: netIncomeTtm,
    sharesOutstanding: sharesOutstandingFor(state, company),
  };
}

/** Trailing revenue as of the previous quarter, for the quarter-on-quarter estimate. */
export function previousTtmUsd(company: Company, priorMetrics: CompanyQuarterMetrics | undefined): number {
  const stored = company.fundamentals.revenueTtmUsd;
  if (stored > 0) return stored;
  if (priorMetrics !== undefined && priorMetrics.revenueTtm > 0) return priorMetrics.revenueTtm;
  return Math.max(0, company.financials.revenueQuarterly) * 4;
}

/** Blended gross margin implied by a company's live P&L, for callers without metrics. */
export function livedGrossMarginPct(company: Company): number {
  const revenue = company.financials.revenueQuarterly;
  return revenue <= 0 ? 0 : clamp(ratio(revenue - company.financials.cogs, revenue, 0), 0, 1);
}
