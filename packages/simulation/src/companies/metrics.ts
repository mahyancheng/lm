/**
 * @frontier/simulation — companies/metrics.ts
 *
 * Derived per-quarter company metrics: the numbers the Command Centre, the
 * leaderboards and the valuation anchors read.
 *
 * Nothing here mutates an economic fact. Metrics are a projection of state that
 * other phases already committed, which is why this function emits no ledger
 * rows: there is no mutation to audit.
 *
 * Trailing revenue is kept as a rolling estimate rather than by storing four
 * quarters of history in live state (`SessionState` keeps bounded history on
 * purpose — the full series lives in snapshots and the ledger):
 *
 * ```text
 * ttm_t = ttm_{t-1} + revenue_t - ttm_{t-1} / 4
 * ```
 *
 * which is exact for a company with flat revenue and converges quickly for one
 * that is growing.
 */

import type { CompanyQuarterMetrics, ResolverContext, SessionState } from '@frontier/contracts';
import { RUNWAY_CAP_QUARTERS } from './balance';
import { activeCompanies, activeProducts, clamp, money, ratio, totalHeadcount, unit } from './util';

/** Recompute the derived metrics for every active company. */
export function recomputeMetrics(draft: SessionState, ctx: ResolverContext): void {
  const previous = new Map<string, CompanyQuarterMetrics>();
  for (const metric of draft.companyMetrics) previous.set(metric.companyId, metric);

  const next: CompanyQuarterMetrics[] = [];

  for (const company of activeCompanies(draft)) {
    const financials = company.financials;
    const prior = previous.get(company.id);
    const revenue = financials.revenueQuarterly;
    const priorTtm = prior?.revenueTtm ?? revenue * 4;
    const revenueTtm = money(Math.max(0, priorTtm + revenue - priorTtm / 4));
    const revenueGrowthYoY = clamp(ratio(revenueTtm - priorTtm, priorTtm, 0), -1, 10);

    const grossProfit = revenue - financials.cogs;
    const operatingIncome = grossProfit - (financials.payroll + financials.marketing + financials.rdSpend);

    const burn = financials.quarterlyBurn;
    const runway = burn < 0 ? clamp(ratio(financials.cash, -burn, RUNWAY_CAP_QUARTERS), 0, RUNWAY_CAP_QUARTERS) : RUNWAY_CAP_QUARTERS;

    const anchor = draft.valuationAnchors.find((a) => a.companyId === company.id);
    const instrument = company.instrumentId === null ? undefined : draft.marketInstruments.find((i) => i.id === company.instrumentId);
    let marketCap = 0;
    if (instrument !== undefined) {
      let latest: { quarter: number; marketCapUsd: number } | undefined;
      for (const quote of draft.quotes) {
        if (quote.instrumentId !== instrument.id) continue;
        if (latest === undefined || quote.quarter > latest.quarter) latest = { quarter: quote.quarter, marketCapUsd: quote.marketCapUsd };
      }
      marketCap = latest?.marketCapUsd ?? 0;
    }
    if (marketCap <= 0) {
      // Unlisted: the last private round's post-money, then the anchor, then a
      // revenue multiple, in that order of preference.
      let lastRound = 0;
      for (const round of draft.fundingRounds) {
        if (round.companyId !== company.id || round.status !== 'closed') continue;
        lastRound = Math.max(lastRound, round.postMoney);
      }
      marketCap = lastRound > 0 ? lastRound : (anchor?.anchorValueUsd ?? revenueTtm * 4);
    }
    const enterpriseValue = money(Math.max(0, (anchor?.anchorValueUsd ?? marketCap) + financials.debt - financials.cash));

    const computeCostShare = unit(ratio(financials.cogs, Math.max(1, financials.cogs + financials.payroll + financials.marketing + financials.rdSpend)));

    let governmentRevenue = 0;
    for (const contract of draft.governmentContracts) {
      if (contract.primeCompanyId !== company.id) continue;
      for (const milestone of contract.milestones) {
        if (milestone.completedQuarter === ctx.quarter && milestone.status !== 'failed') governmentRevenue += milestone.valueUsd;
      }
    }
    for (const product of activeProducts(company)) {
      if (product.segment === 'government') governmentRevenue += product.activeCustomers * product.pricePerSeat;
    }

    next.push({
      companyId: company.id,
      quarter: ctx.quarter,
      revenueTtm,
      revenueGrowthYoY,
      grossMarginPct: unit(revenue <= 0 ? 0 : grossProfit / revenue),
      operatingMarginPct: clamp(revenue <= 0 ? 0 : operatingIncome / revenue, -10, 1),
      headcount: totalHeadcount(company),
      runwayQuarters: runway,
      enterpriseValueUsd: enterpriseValue,
      marketCapUsd: money(marketCap),
      computeCostShare,
      governmentRevenueShare: unit(revenue <= 0 ? 0 : governmentRevenue / revenue),
    });
  }

  draft.companyMetrics = next;
}
