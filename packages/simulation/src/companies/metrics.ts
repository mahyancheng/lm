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

import type { CompanyExposure, CompanyQuarterMetrics, ControlStatus, HolderKind, ResolverContext, SessionState } from '@frontier/contracts';
import {
  ACQUISITION_EXPOSURE_WINDOW_QUARTERS,
  CONTROL_DECISIVE_PCT,
  CONTROL_INFORMATION_PCT,
  antitrustBand,
  antitrustExposure,
  grantsControl,
  grantsInformationRight,
} from '@frontier/contracts';
import { DISCLOSURE_THRESHOLD_PCT } from '../markets/settlement';
import { RUNWAY_CAP_QUARTERS, TAX_RATE } from './balance';
import { previousTtmUsd, rollFundamentals } from './fundamentals';
import { activeAccords, chargesTollPct, isAccordMember, regionLogistics } from '../economy/prices';
import { isMultiSectorWorld, sectorOf, supplyBySector } from '../economy/sectors';
import { activeCompanies, activeProducts, clamp, emitEvent, money, ratio, totalHeadcount, unit } from './util';

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

    const row: CompanyQuarterMetrics = {
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
    };
    next.push(row);

    // The pricing anchor's inputs, rolled forward from the row just built. The
    // market phase of the *next* quarter reads this, which is what makes a price
    // trace to reported fundamentals rather than to a fresh guess.
    company.fundamentals = rollFundamentals(draft, company, row, previousTtmUsd(company, prior), TAX_RATE);
  }

  draft.companyMetrics = next;
  recomputeAntitrustExposure(draft, ctx);
  recomputeControlStatus(draft, ctx);
}

/* -------------------------------------------------------------------------- */
/*  Control thresholds                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Where every disclosed holder stands against the two thresholds that mean
 * something: 25% for the information right and 50% + 1 share for control.
 *
 * Runs here rather than in the capital phase because the market settles trades
 * in phase thirteen and this is phase sixteen — so the row a player reads is the
 * position they finished the quarter with, not the one they started it with.
 *
 * Bounded on purpose: only holders at or above the disclosure line get a row,
 * because a register with two hundred names on it is not a phone screen.
 */
export function recomputeControlStatus(draft: SessionState, ctx: ResolverContext): void {
  if (!isMultiSectorWorld(draft)) return;
  const rows: ControlStatus[] = [];

  for (const company of activeCompanies(draft)) {
    const table = draft.capTables.find((candidate) => candidate.companyId === company.id);
    if (table === undefined) continue;
    const security =
      draft.securities.find((candidate) => candidate.id === company.primarySecurityId) ??
      draft.securities.find((candidate) => candidate.companyId === company.id) ??
      null;
    if (security === null) continue;
    const shareClass = table.shareClasses.find((klass) => klass.id === security.shareClassId) ?? table.shareClasses[0] ?? null;
    const issued = shareClass?.issuedShares ?? 0;
    if (issued <= 0) continue;

    const byHolder = new Map<string, { shares: number; kind: HolderKind }>();
    for (const holding of table.holdings) {
      if (holding.securityId !== security.id || holding.shares <= 0) continue;
      const existing = byHolder.get(holding.holderId);
      byHolder.set(holding.holderId, { shares: (existing?.shares ?? 0) + holding.shares, kind: holding.holderKind });
    }

    for (const holderId of [...byHolder.keys()].sort()) {
      const entry = byHolder.get(holderId);
      if (entry === undefined) continue;
      const stake = entry.shares / issued;
      if (stake < DISCLOSURE_THRESHOLD_PCT) continue;
      rows.push({
        companyId: company.id,
        holderId,
        holderKind: entry.kind,
        sharesHeld: entry.shares,
        issuedShares: issued,
        stakePct: Math.round(stake * 100),
        hasInformationRight: grantsInformationRight(entry.shares, issued),
        hasControl: grantsControl(entry.shares, issued),
        informationThresholdPct: Math.round(CONTROL_INFORMATION_PCT * 100),
        controlThresholdPct: Math.round(CONTROL_DECISIVE_PCT * 100),
      });
    }
  }

  rows.sort((a, b) => (a.companyId !== b.companyId ? (a.companyId < b.companyId ? -1 : 1) : b.stakePct - a.stakePct || (a.holderId < b.holderId ? -1 : 1)));
  if (draft.economyReport !== undefined && draft.economyReport !== null) {
    draft.economyReport = { ...draft.economyReport, control: rows };
  }
  void ctx;
}

/* -------------------------------------------------------------------------- */
/*  Antitrust exposure                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Recompute every company's antitrust exposure, with its named drivers.
 *
 * Runs here, in `leaderboard_update`, because this is where the engine already
 * walks every company once. It is a pure function of the draft — no RNG — and it
 * is the accelerator's brake: the score it writes is what `familyHazardFor`
 * reads next quarter when it decides how likely an investigation is.
 *
 * The 0.90 carry means a company that stops concentrating watches the number
 * fall by about a tenth a quarter until it is nothing. That is what makes it a
 * decision rather than a ratchet, and it is the reason there is a `carried` row
 * in the drill-down rather than a silent baseline.
 */
export function recomputeAntitrustExposure(draft: SessionState, ctx: ResolverContext): void {
  if (!isMultiSectorWorld(draft)) return;

  const supply = supplyBySector(draft);
  const accords = activeAccords(draft);
  const logistics = regionLogistics(draft);
  const rows: CompanyExposure[] = [];
  const oldest = ctx.quarter - ACQUISITION_EXPOSURE_WINDOW_QUARTERS + 1;

  for (const company of activeCompanies(draft)) {
    const trailing = company.fundamentals.revenueTtmUsd;
    const annualised = trailing > 0 ? trailing : Math.max(0, company.financials.revenueQuarterly) * 4;
    const sectorShare = annualised / Math.max(1, supply[sectorOf(company)]);

    // Bounded history: acquisitions outside the window are dropped here rather
    // than accumulating on the company forever. The full record is in the ledger.
    const recent = (company.recentAcquisitionQuarters ?? []).filter((quarter) => quarter >= oldest).slice(-8);
    if (recent.length > 0) company.recentAcquisitionQuarters = recent;
    else delete company.recentAcquisitionQuarters;

    const before = clamp(company.antitrustExposure ?? 0, 0, 100);
    const { score, contributions } = antitrustExposure({
      exposure: before,
      sectorShare,
      inAccord: isAccordMember(company.id, accords),
      recentAcquisitions: recent.length,
      tollChargedPct: chargesTollPct(draft, company, logistics),
      predatoryQuarters: company.predatoryQuarters ?? 0,
    });
    company.antitrustExposure = score;
    if (score === 0 && before === 0) continue;

    const eventId = emitEvent(
      draft,
      ctx,
      'antitrust_exposure_changed',
      company.id,
      company.id,
      {
        companyId: company.id,
        before,
        after: score,
        band: antitrustBand(score),
        drivers: {
          sectorShare: Math.round(sectorShare * 100),
          accord: isAccordMember(company.id, accords),
          acquisitions: recent.length,
          toll: chargesTollPct(draft, company, logistics),
          predation: company.predatoryQuarters ?? 0,
        },
      },
      // Your own compliance risk. A rival does not get to read your exact score:
      // rule 9 working for us rather than against us.
      'company',
    );

    rows.push({
      companyId: company.id,
      quarter: ctx.quarter,
      before,
      after: score,
      band: antitrustBand(score),
      drivers: contributions.map((entry) => ({ key: entry.key, label: entry.label, points: entry.points, detail: entry.detail.slice(0, 120) })),
      causeEventId: eventId,
    });
  }

  if (draft.economyReport !== undefined && draft.economyReport !== null) {
    draft.economyReport = { ...draft.economyReport, exposures: rows };
  }
}
