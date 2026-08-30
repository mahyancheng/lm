/**
 * @frontier/simulation — resolver/capital.ts
 *
 * The sixth phase: money and ownership.
 *
 * Boards have voted (phase five), so an acquisition that reaches this code has
 * been approved; the market has not yet priced (phase thirteen), so everything
 * that happens here is in the price by the end of the quarter rather than
 * arriving a quarter late. That ordering is the reason a board approval in one
 * phase can move a share price in another, and it is part of the contract.
 *
 * Six things settle here: private rounds, debt issues, primary share issues,
 * buybacks, listings and acquisitions — plus the bookkeeping of structured
 * deals. Secondary trading is *not* here: buying a rival's stock on the exchange
 * settles in `market_resolution`, against the price the market strikes, which is
 * where `MarketsSubsystem.settleTrades` owns it.
 *
 * ## Two invariants, maintained line by line
 *
 * Every mutation below moves assets, liabilities and equity together so that
 * `assets - liabilities === equity` survives each step, and every share that
 * appears or disappears is matched by a holding and by `totalIssuedByClass`.
 * The gate at `ledger_commit` re-checks both, but the intent here is that it
 * never has anything to catch: an acquisition that would break either is
 * refused at validation, not repaired afterwards.
 */

import type {
  CapTable,
  Company,
  FundingRound,
  Holding,
  MarketInstrument,
  ResolverContext,
  SeededRng,
  Security,
  SessionState,
  ShareClass,
} from '@frontier/contracts';
import { makeId, ownershipThresholdFor } from '@frontier/contracts';
import { pendingOfType } from './actions';
import { routeDeals } from './routing';

/* -------------------------------------------------------------------------- */
/*  Balancing constants                                                        */
/* -------------------------------------------------------------------------- */

/** Below this listing window an IPO does not get away. */
export const IPO_WINDOW_FLOOR = 0.3;
/** Discount a primary issue clears at, against the last traded price. */
export const PRIMARY_ISSUE_DISCOUNT = 0.03;
/** Lock-up applied to stock issued as acquisition consideration. */
export const ACQUISITION_LOCKUP_QUARTERS = 4;
/** Integration friction applied to capabilities absorbed in an acquisition. */
export const ACQUISITION_CAPABILITY_RETENTION = 0.8;
/** Attrition added to the acquired workforce in the quarter it is absorbed. */
export const ACQUISITION_ATTRITION_PENALTY = 0.06;

/* -------------------------------------------------------------------------- */
/*  Lookups and valuation                                                      */
/* -------------------------------------------------------------------------- */

const findCompany = (draft: SessionState, id: string): Company | null => draft.companies.find((c) => c.id === id) ?? null;
const findCapTable = (draft: SessionState, companyId: string): CapTable | null => draft.capTables.find((t) => t.companyId === companyId) ?? null;
const findSecurity = (draft: SessionState, id: string | null): Security | null =>
  id === null ? null : draft.securities.find((s) => s.id === id) ?? null;

/** The last price struck for a company's equity, or null when it has none. */
export function lastPrice(draft: SessionState, company: Company): number | null {
  if (company.instrumentId === null) return null;
  let best: { quarter: number; price: number } | null = null;
  for (const quote of draft.quotes) {
    if (quote.instrumentId !== company.instrumentId) continue;
    if (best === null || quote.quarter > best.quarter) best = { quarter: quote.quarter, price: quote.price };
  }
  return best === null ? null : best.price;
}

/**
 * What the company is worth for the purposes of pricing a financing.
 *
 * In order: the market's own answer, then the fundamental anchor, then a
 * revenue multiple scaled by the sector's multiple index. The fallback matters
 * — a private company with no anchor still has to be able to raise.
 */
export function estimateValuationUsd(draft: SessionState, company: Company): number {
  const metrics = draft.companyMetrics.find((m) => m.companyId === company.id);
  if (company.isPublic && metrics !== undefined && metrics.marketCapUsd > 0) return metrics.marketCapUsd;

  const anchor = draft.valuationAnchors.find((a) => a.companyId === company.id);
  if (anchor !== undefined && anchor.anchorValueUsd > 0) return anchor.anchorValueUsd;
  if (metrics !== undefined && metrics.enterpriseValueUsd > 0) return metrics.enterpriseValueUsd;

  const sector = draft.sectors[company.sectorId];
  const multiple = (sector?.multiple ?? 1) * draft.world.capitalMarkets.sectorMultiples;
  const revenueRun = company.financials.revenueQuarterly * 4;
  return Math.max(1_000_000, revenueRun * 6 * multiple + company.financials.cash);
}

/* -------------------------------------------------------------------------- */
/*  Cap-table primitives                                                       */
/* -------------------------------------------------------------------------- */

/** Shares issued in one class, read from the class row. */
const issuedIn = (table: CapTable, shareClassId: string): number =>
  table.shareClasses.find((c) => c.id === shareClassId)?.issuedShares ?? 0;

/** One holder's economic share of a class, 0..1. */
export function holderPct(table: CapTable, securityId: string, shareClassId: string, holderId: string): number {
  const issued = issuedIn(table, shareClassId);
  if (issued <= 0) return 0;
  let held = 0;
  for (const holding of table.holdings) {
    if (holding.securityId === securityId && holding.holderId === holderId) held += holding.shares;
  }
  return held / issued;
}

/** Add shares to a holder, merging into an existing position where one exists. */
export function addShares(
  table: CapTable,
  params: {
    securityId: string;
    holderId: string;
    holderKind: Holding['holderKind'];
    shares: number;
    costUsd: number;
    quarter: number;
    lockupUntilQuarter: number | null;
  },
): Holding {
  const existing = table.holdings.find(
    (holding) => holding.securityId === params.securityId && holding.holderId === params.holderId && holding.holderKind === params.holderKind,
  );
  if (existing !== undefined) {
    existing.shares += params.shares;
    existing.costBasisUsd += params.costUsd;
    if (params.lockupUntilQuarter !== null) {
      existing.lockupUntilQuarter =
        existing.lockupUntilQuarter === null ? params.lockupUntilQuarter : Math.max(existing.lockupUntilQuarter, params.lockupUntilQuarter);
    }
    return existing;
  }
  const holding: Holding = {
    id: makeId('hld', params.holderId, params.securityId, params.quarter),
    holderId: params.holderId,
    holderKind: params.holderKind,
    securityId: params.securityId,
    shares: params.shares,
    costBasisUsd: params.costUsd,
    acquiredQuarter: params.quarter,
    lockupUntilQuarter: params.lockupUntilQuarter,
    isDisclosed: false,
  };
  table.holdings.push(holding);
  return holding;
}

/** Remove shares from the public float, returning how many were actually found. */
export function takeFromFloat(table: CapTable, securityId: string, shares: number): number {
  let remaining = shares;
  for (const holding of table.holdings) {
    if (remaining <= 0) break;
    if (holding.securityId !== securityId || holding.holderKind !== 'public_float') continue;
    const taken = Math.min(holding.shares, remaining);
    holding.shares -= taken;
    holding.costBasisUsd = holding.shares === 0 ? 0 : holding.costBasisUsd * (holding.shares / (holding.shares + taken));
    remaining -= taken;
  }
  return shares - remaining;
}

/**
 * Record a change in issued shares and keep every derived total with it.
 *
 * `totalIssuedByClass` is the number the ownership invariant checks holdings
 * against, so it is written here and nowhere else.
 */
export function setIssued(table: CapTable, shareClass: ShareClass, issued: number, quarter: number): void {
  shareClass.issuedShares = Math.max(0, Math.round(issued));
  table.totalIssuedByClass[shareClass.id] = shareClass.issuedShares;
  table.fullyDilutedShares = table.shareClasses.reduce((sum, klass) => sum + klass.issuedShares, 0) + table.optionPoolShares;
  table.lastUpdatedQuarter = quarter;
}

/** Emit `ownership_threshold_crossed` when a holder crosses a line upward. */
function reportThreshold(
  draft: SessionState,
  ctx: ResolverContext,
  companyId: string,
  holderId: string,
  before: number,
  after: number,
): void {
  const crossed = ownershipThresholdFor(after);
  const previous = ownershipThresholdFor(before);
  if (crossed === null || (previous !== null && previous.pct >= crossed.pct)) return;

  const eventId = ctx.emit({
    sessionId: draft.sessionId,
    quarter: draft.quarter,
    type: 'ownership_threshold_crossed',
    actorId: holderId,
    targetId: companyId,
    payload: { threshold: crossed.label, pct: round(after, 4), previousPct: round(before, 4), effect: crossed.effect },
    // Crossing the disclosure line is exactly the moment a position stops
    // being private, which is why the visibility depends on the threshold.
    visibility: after >= 0.05 ? 'public' : 'company',
  });
  ctx.log({
    phase: 'capital_resolution',
    text: `${holderId} crossed ${Math.round(crossed.pct * 100)}% of ${companyId}: ${crossed.effect}`,
    deltaLabel: `${(after * 100).toFixed(1)}%`,
    refEventIds: [eventId],
    tone: 'warning',
    subjectId: companyId,
  });
}

/* -------------------------------------------------------------------------- */
/*  The phase                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Resolve the capital phase.
 *
 * Actions run in submission order within each kind, and the kinds run in a
 * fixed order: money in before money out, and ownership last, so an acquisition
 * settles against the cash the quarter's financing actually produced.
 */
export function resolveCapital(draft: SessionState, ctx: ResolverContext): void {
  const rng = ctx.rng.fork('capital');
  resolveFundingRounds(draft, ctx, rng);
  resolveDebtIssues(draft, ctx, rng);
  resolveShareIssues(draft, ctx);
  resolveListings(draft, ctx);
  resolveBuybacks(draft, ctx);
  resolveAcquisitions(draft, ctx);
  routeDeals(draft, ctx);
}

/* ------------------------------- financing -------------------------------- */

function resolveFundingRounds(draft: SessionState, ctx: ResolverContext, rng: SeededRng): void {
  for (const { action, intent } of pendingOfType(draft, 'raise_round')) {
    const company = findCompany(draft, action.actorCompanyId);
    if (company === null) continue;

    const preMoney = estimateValuationUsd(draft, company);
    const postMoney = preMoney + intent.targetAmountUsd;
    const dilution = postMoney <= 0 ? 1 : intent.targetAmountUsd / postMoney;

    const appetite =
      0.5 * draft.world.capitalMarkets.ventureLiquidity +
      0.3 * draft.world.capitalMarkets.riskAppetite +
      0.2 * (company.reputation.investor / 100);
    const strain = clamp01(intent.targetAmountUsd / Math.max(1, preMoney * 0.35));
    const clearChance = clamp01(appetite * 1.1 - 0.45 * strain);
    const draw = rng.next();

    const roundId = makeId('rnd', company.id, draft.quarter, intent.stage);
    const table = findCapTable(draft, company.id);
    const security = findSecurity(draft, company.primarySecurityId);
    const shareClass = table?.shareClasses.find((c) => c.id === security?.shareClassId) ?? table?.shareClasses[0] ?? null;

    const tooDilutive = dilution > intent.maxDilutionPct;
    const cleared = !tooDilutive && draw < clearChance && table !== null && security !== null && shareClass !== null;

    if (!cleared) {
      const failed: FundingRound = {
        id: roundId,
        companyId: company.id,
        stage: intent.stage,
        amount: 0,
        preMoney,
        postMoney: preMoney,
        dilution: 0,
        pricePerShareUsd: 0,
        shareClassId: shareClass?.id ?? makeId('shc', company.id, 'common'),
        leadInvestorCharacterId: null,
        participantHolderIds: [],
        boardSeatsGranted: 0,
        closedQuarter: draft.quarter,
        status: 'failed',
      };
      draft.fundingRounds.push(failed);

      const eventId = ctx.emit({
        sessionId: draft.sessionId,
        quarter: draft.quarter,
        type: 'funding_round_failed',
        actorId: company.id,
        targetId: roundId,
        payload: {
          stage: intent.stage,
          soughtUsd: intent.targetAmountUsd,
          preMoney: round(preMoney, 0),
          impliedDilution: round(dilution, 4),
          maxDilutionPct: intent.maxDilutionPct,
          clearChance: round(clearChance, 4),
          reason: tooDilutive ? 'dilution_ceiling' : 'no_clearing_bid',
        },
        // A failed raise is public information, and moves belief on its own.
        visibility: 'public',
      });
      ctx.log({
        phase: 'capital_resolution',
        text: tooDilutive
          ? `${company.name} pulled its ${intent.stage.replace(/_/g, ' ')}: ${compactUsd(intent.targetAmountUsd)} would have cost ${(dilution * 100).toFixed(
              1,
            )}% against a ceiling of ${(intent.maxDilutionPct * 100).toFixed(0)}%.`
          : `${company.name} failed to clear its ${intent.stage.replace(/_/g, ' ')} for ${compactUsd(intent.targetAmountUsd)}.`,
        deltaLabel: 'raise failed',
        refEventIds: [eventId],
        tone: 'negative',
        subjectId: company.id,
      });
      continue;
    }

    const pricePerShare = table.fullyDilutedShares > 0 ? preMoney / table.fullyDilutedShares : 1;
    const newShares = Math.max(1, Math.round(intent.targetAmountUsd / Math.max(pricePerShare, 1e-6)));
    const holderId = makeId('fund', 'venture', company.id);
    const before = holderPct(table, security.id, shareClass.id, holderId);

    addShares(table, {
      securityId: security.id,
      holderId,
      holderKind: 'fund',
      shares: newShares,
      costUsd: intent.targetAmountUsd,
      quarter: draft.quarter,
      lockupUntilQuarter: null,
    });
    setIssued(table, shareClass, shareClass.issuedShares + newShares, draft.quarter);

    company.financials.cash += intent.targetAmountUsd;
    company.balanceSheet.assets.cash += intent.targetAmountUsd;
    company.balanceSheet.equity += intent.targetAmountUsd;

    const closed: FundingRound = {
      id: roundId,
      companyId: company.id,
      stage: intent.stage,
      amount: intent.targetAmountUsd,
      preMoney,
      postMoney,
      dilution,
      pricePerShareUsd: pricePerShare,
      shareClassId: shareClass.id,
      leadInvestorCharacterId: null,
      participantHolderIds: [holderId],
      boardSeatsGranted: dilution >= 0.15 ? 1 : 0,
      closedQuarter: draft.quarter,
      status: 'closed',
    };
    draft.fundingRounds.push(closed);

    const eventId = ctx.emit({
      sessionId: draft.sessionId,
      quarter: draft.quarter,
      type: 'funding_round_closed',
      actorId: company.id,
      targetId: roundId,
      payload: {
        stage: intent.stage,
        amountUsd: intent.targetAmountUsd,
        preMoney: round(preMoney, 0),
        postMoney: round(postMoney, 0),
        dilution: round(dilution, 4),
        pricePerShareUsd: round(pricePerShare, 6),
        newShares,
      },
      visibility: 'public',
    });
    ctx.emit({
      sessionId: draft.sessionId,
      quarter: draft.quarter,
      type: 'shares_issued',
      actorId: company.id,
      targetId: security.id,
      payload: { shares: newShares, holderId, shareClassId: shareClass.id, reason: 'funding_round', roundId },
      visibility: 'public',
    });
    ctx.log({
      phase: 'capital_resolution',
      text: `${company.name} closed ${compactUsd(intent.targetAmountUsd)} at a ${compactUsd(postMoney)} post-money, selling ${(dilution * 100).toFixed(1)}%.`,
      deltaLabel: `-${(dilution * 100).toFixed(1)}% founder`,
      refEventIds: [eventId],
      tone: 'positive',
      subjectId: company.id,
    });

    reportThreshold(draft, ctx, company.id, holderId, before, holderPct(table, security.id, shareClass.id, holderId));
  }
}

/* --------------------------------- debt ----------------------------------- */

/** The coupon a lender offers this company this quarter. */
export function offeredDebtRate(draft: SessionState, company: Company): number {
  const annualRevenue = Math.max(1, company.financials.revenueQuarterly * 4);
  const leverage = company.financials.debt / annualRevenue;
  const burn = Math.max(0, -company.financials.quarterlyBurn);
  const runway = burn <= 0 ? 40 : company.financials.cash / burn;
  const riskPremium = 0.02 + 0.05 * clamp01(leverage / 3) + 0.03 * (1 - clamp01(runway / 8));
  const qualityDiscount = 0.02 * (company.reputation.investor / 100) + (company.financials.backlogUsd > 0 ? 0.01 : 0);
  return Math.max(0, draft.world.macro.policyRate + draft.world.macro.creditSpreads + riskPremium - qualityDiscount);
}

function resolveDebtIssues(draft: SessionState, ctx: ResolverContext, rng: SeededRng): void {
  for (const { action, intent } of pendingOfType(draft, 'issue_debt')) {
    const company = findCompany(draft, action.actorCompanyId);
    if (company === null) continue;

    const rate = offeredDebtRate(draft, company);
    const totalAssets =
      company.balanceSheet.assets.cash +
      company.balanceSheet.assets.ppe +
      company.balanceSheet.assets.goodwill +
      company.balanceSheet.assets.investments +
      company.balanceSheet.assets.receivables;
    const sizeThreshold = clamp01(0.2 + 0.5 * (intent.amountUsd / Math.max(1, totalAssets)));
    const marketOpen = draft.world.capitalMarkets.debtAvailability >= sizeThreshold;
    // A shade of noise so an issue that sits exactly on the line is not a
    // foregone conclusion; drawn from the phase stream, so it replays.
    const nudge = rng.range(-0.02, 0.02);
    const cleared = marketOpen && rate + nudge <= intent.maxRatePct;

    if (!cleared) {
      const eventId = ctx.emit({
        sessionId: draft.sessionId,
        quarter: draft.quarter,
        type: 'debt_issued',
        actorId: company.id,
        targetId: company.id,
        payload: {
          cleared: false,
          soughtUsd: intent.amountUsd,
          offeredRate: round(rate, 4),
          maxRatePct: intent.maxRatePct,
          debtAvailability: round(draft.world.capitalMarkets.debtAvailability, 3),
          sizeThreshold: round(sizeThreshold, 3),
        },
        visibility: 'public',
      });
      ctx.log({
        phase: 'capital_resolution',
        text: `${company.name} could not place ${compactUsd(intent.amountUsd)} of debt: lenders wanted ${(rate * 100).toFixed(1)}% against a ceiling of ${(
          intent.maxRatePct * 100
        ).toFixed(1)}%.`,
        deltaLabel: 'issue pulled',
        refEventIds: [eventId],
        tone: 'negative',
        subjectId: company.id,
      });
      continue;
    }

    company.financials.cash += intent.amountUsd;
    company.financials.debt += intent.amountUsd;
    company.balanceSheet.assets.cash += intent.amountUsd;
    company.balanceSheet.liabilities.debt += intent.amountUsd;

    const eventId = ctx.emit({
      sessionId: draft.sessionId,
      quarter: draft.quarter,
      type: 'debt_issued',
      actorId: company.id,
      targetId: company.id,
      payload: {
        cleared: true,
        amountUsd: intent.amountUsd,
        rate: round(rate, 4),
        termQuarters: intent.termQuarters,
        debtAfter: round(company.financials.debt, 2),
      },
      visibility: 'public',
    });
    ctx.log({
      phase: 'capital_resolution',
      text: `${company.name} issued ${compactUsd(intent.amountUsd)} of debt at ${(rate * 100).toFixed(1)}% over ${intent.termQuarters} quarters.`,
      deltaLabel: `+${compactUsd(intent.amountUsd)} cash`,
      refEventIds: [eventId],
      tone: 'neutral',
      subjectId: company.id,
    });
  }
}

/* ---------------------------- primary issuance ---------------------------- */

function resolveShareIssues(draft: SessionState, ctx: ResolverContext): void {
  for (const { action, intent } of pendingOfType(draft, 'issue_shares')) {
    const company = findCompany(draft, action.actorCompanyId);
    const table = company === null ? null : findCapTable(draft, company.id);
    const shareClass = table?.shareClasses.find((c) => c.id === intent.shareClassId) ?? null;
    const security = draft.securities.find((s) => s.companyId === company?.id && s.shareClassId === intent.shareClassId) ?? null;
    if (company === null || table === null || shareClass === null || security === null) continue;

    const market = lastPrice(draft, company);
    const price = Math.max(intent.minPricePerShareUsd, market === null ? intent.minPricePerShareUsd : market * (1 - PRIMARY_ISSUE_DISCOUNT));
    const proceeds = price * intent.shares;

    addShares(table, {
      securityId: security.id,
      holderId: makeId('float', security.id),
      holderKind: 'public_float',
      shares: intent.shares,
      costUsd: proceeds,
      quarter: draft.quarter,
      lockupUntilQuarter: null,
    });
    setIssued(table, shareClass, shareClass.issuedShares + intent.shares, draft.quarter);

    company.financials.cash += proceeds;
    company.balanceSheet.assets.cash += proceeds;
    company.balanceSheet.equity += proceeds;

    const eventId = ctx.emit({
      sessionId: draft.sessionId,
      quarter: draft.quarter,
      type: 'shares_issued',
      actorId: company.id,
      targetId: security.id,
      payload: { shares: intent.shares, pricePerShareUsd: round(price, 4), proceedsUsd: round(proceeds, 2), shareClassId: shareClass.id, reason: 'primary_issue' },
      visibility: 'public',
    });
    ctx.log({
      phase: 'capital_resolution',
      text: `${company.name} issued ${intent.shares.toString()} new shares at ${compactUsd(price)}, raising ${compactUsd(proceeds)}.`,
      deltaLabel: `+${compactUsd(proceeds)}`,
      refEventIds: [eventId],
      tone: 'neutral',
      subjectId: company.id,
    });
  }
}

/* -------------------------------- listings -------------------------------- */

function resolveListings(draft: SessionState, ctx: ResolverContext): void {
  for (const { action, intent } of pendingOfType(draft, 'ipo')) {
    const company = findCompany(draft, action.actorCompanyId);
    const table = company === null ? null : findCapTable(draft, company.id);
    if (company === null || table === null || company.isPublic) continue;

    const security = findSecurity(draft, company.primarySecurityId) ?? draft.securities.find((s) => s.companyId === company.id) ?? null;
    const shareClass = table.shareClasses.find((c) => c.id === security?.shareClassId) ?? table.shareClasses[0] ?? null;
    if (security === null || shareClass === null) continue;

    const window = draft.world.capitalMarkets.ipoWindow;
    const anchor = draft.valuationAnchors.find((a) => a.companyId === company.id);
    const impliedPerShare =
      anchor?.perShareValueUsd ?? (table.fullyDilutedShares > 0 ? estimateValuationUsd(draft, company) / table.fullyDilutedShares : intent.minPricePerShareUsd);
    const price = impliedPerShare * (0.75 + 0.5 * window);

    if (window < IPO_WINDOW_FLOOR || price < intent.minPricePerShareUsd) {
      const eventId = ctx.emit({
        sessionId: draft.sessionId,
        quarter: draft.quarter,
        type: 'funding_round_failed',
        actorId: company.id,
        targetId: company.id,
        payload: {
          kind: 'ipo',
          ipoWindow: round(window, 3),
          indicativePriceUsd: round(price, 4),
          minPricePerShareUsd: intent.minPricePerShareUsd,
          reason: window < IPO_WINDOW_FLOOR ? 'window_shut' : 'priced_below_floor',
        },
        visibility: 'public',
      });
      ctx.log({
        phase: 'capital_resolution',
        text: `${company.name} pulled its listing: the window stands at ${(window * 100).toFixed(0)}% and the book came in at ${compactUsd(price)} a share.`,
        deltaLabel: 'IPO pulled',
        refEventIds: [eventId],
        tone: 'negative',
        subjectId: company.id,
      });
      continue;
    }

    const existing = shareClass.issuedShares;
    const byFloat = Math.round((existing * intent.floatPct) / Math.max(0.01, 1 - intent.floatPct));
    const byRaise = Math.round(intent.targetRaiseUsd / Math.max(price, 1e-6));
    const newShares = Math.max(1, Math.min(byFloat, byRaise));
    const raised = newShares * price;

    addShares(table, {
      securityId: security.id,
      holderId: makeId('float', security.id),
      holderKind: 'public_float',
      shares: newShares,
      costUsd: raised,
      quarter: draft.quarter,
      lockupUntilQuarter: null,
    });
    setIssued(table, shareClass, existing + newShares, draft.quarter);

    company.financials.cash += raised;
    company.balanceSheet.assets.cash += raised;
    company.balanceSheet.equity += raised;
    company.isPublic = true;

    const ticker = company.ticker ?? tickerFor(company.name);
    company.ticker = ticker;
    security.symbol = ticker;
    security.isTradable = true;

    if (company.instrumentId === null) {
      const instrument: MarketInstrument = {
        id: makeId('ins', company.id, 'eq'),
        kind: 'in_world_equity',
        symbol: ticker,
        name: company.name,
        companyId: company.id,
        securityId: security.id,
        sectorId: company.sectorId,
        isReference: false,
        currency: 'USD',
        sharesOutstanding: shareClass.issuedShares,
        listedQuarter: draft.quarter,
        beta: 1.2,
      };
      draft.marketInstruments.push(instrument);
      company.instrumentId = instrument.id;
      security.instrumentId = instrument.id;
      // A listing price so the market has a prior close to move from. Stamped
      // on the quarter before the listing so it cannot collide with the quote
      // the market phase strikes for this quarter.
      draft.quotes.push({
        instrumentId: instrument.id,
        quarter: Math.max(0, draft.quarter - 1),
        price,
        return: 0,
        volume: newShares,
        marketCapUsd: price * shareClass.issuedShares,
      });
    }

    const eventId = ctx.emit({
      sessionId: draft.sessionId,
      quarter: draft.quarter,
      type: 'ipo_completed',
      actorId: company.id,
      targetId: security.id,
      payload: {
        ticker,
        pricePerShareUsd: round(price, 4),
        newShares,
        raisedUsd: round(raised, 2),
        floatPct: round(newShares / Math.max(1, shareClass.issuedShares), 4),
        ipoWindow: round(window, 3),
      },
      visibility: 'public',
    });
    ctx.log({
      phase: 'capital_resolution',
      text: `${company.name} listed as ${ticker} at ${compactUsd(price)} a share, raising ${compactUsd(raised)}.`,
      deltaLabel: `+${compactUsd(raised)}`,
      refEventIds: [eventId],
      tone: 'positive',
      subjectId: company.id,
    });
  }
}

/* -------------------------------- buybacks -------------------------------- */

function resolveBuybacks(draft: SessionState, ctx: ResolverContext): void {
  for (const { action, intent } of pendingOfType(draft, 'buyback')) {
    const company = findCompany(draft, action.actorCompanyId);
    const table = company === null ? null : findCapTable(draft, company.id);
    const security = findSecurity(draft, company?.primarySecurityId ?? null);
    const shareClass = table?.shareClasses.find((c) => c.id === security?.shareClassId) ?? null;
    if (company === null || table === null || security === null || shareClass === null) continue;

    const market = lastPrice(draft, company);
    const price = Math.min(intent.maxPricePerShareUsd, market ?? intent.maxPricePerShareUsd);
    if (price <= 0) continue;

    const wanted = Math.floor(intent.budgetUsd / price);
    const bought = takeFromFloat(table, security.id, wanted);
    if (bought <= 0) continue;

    const cost = bought * price;
    company.financials.cash -= cost;
    company.balanceSheet.assets.cash -= cost;
    company.balanceSheet.equity -= cost;
    setIssued(table, shareClass, shareClass.issuedShares - bought, draft.quarter);

    const eventId = ctx.emit({
      sessionId: draft.sessionId,
      quarter: draft.quarter,
      type: 'buyback_executed',
      actorId: company.id,
      targetId: security.id,
      payload: { shares: bought, pricePerShareUsd: round(price, 4), costUsd: round(cost, 2), issuedAfter: shareClass.issuedShares },
      visibility: 'public',
    });
    ctx.log({
      phase: 'capital_resolution',
      text: `${company.name} repurchased ${bought.toString()} shares for ${compactUsd(cost)}, retiring them.`,
      deltaLabel: `-${compactUsd(cost)}`,
      refEventIds: [eventId],
      tone: 'neutral',
      subjectId: company.id,
    });
  }
}

/* ------------------------------ acquisitions ------------------------------ */

function resolveAcquisitions(draft: SessionState, ctx: ResolverContext): void {
  for (const { action, intent } of pendingOfType(draft, 'acquire_company')) {
    const acquirer = findCompany(draft, action.actorCompanyId);
    const target = findCompany(draft, intent.targetCompanyId);
    if (acquirer === null || target === null || !target.isActive || acquirer.id === target.id) continue;

    const acquirerTable = findCapTable(draft, acquirer.id);
    const targetTable = findCapTable(draft, target.id);
    const acquirerSecurity = findSecurity(draft, acquirer.primarySecurityId);
    const acquirerClass = acquirerTable?.shareClasses.find((c) => c.id === acquirerSecurity?.shareClassId) ?? null;

    const cashComponent = intent.offerValueUsd * intent.cashPct;
    const stockComponent = intent.offerValueUsd - cashComponent;
    if (cashComponent > acquirer.financials.cash + 1) continue; // validation should have caught this

    const targetAssets =
      target.balanceSheet.assets.cash +
      target.balanceSheet.assets.ppe +
      target.balanceSheet.assets.goodwill +
      target.balanceSheet.assets.investments +
      target.balanceSheet.assets.receivables;
    const targetLiabilities =
      target.balanceSheet.liabilities.debt + target.balanceSheet.liabilities.payables + target.balanceSheet.liabilities.deferredRevenue;
    const netAssets = targetAssets - targetLiabilities;
    const goodwill = Math.max(0, intent.offerValueUsd - netAssets);

    /* --- consideration ---------------------------------------------------- */
    acquirer.financials.cash -= cashComponent;
    acquirer.balanceSheet.assets.cash -= cashComponent;

    let sharesIssued = 0;
    if (stockComponent > 0 && acquirerTable !== null && acquirerClass !== null && acquirerSecurity !== null) {
      const price = lastPrice(draft, acquirer) ?? (acquirerTable.fullyDilutedShares > 0 ? estimateValuationUsd(draft, acquirer) / acquirerTable.fullyDilutedShares : 1);
      sharesIssued = Math.max(1, Math.round(stockComponent / Math.max(price, 1e-6)));

      // The target's holders are paid in the acquirer's stock, pro rata.
      const targetIssued = targetTable === null ? 0 : targetTable.holdings.reduce((sum, holding) => sum + holding.shares, 0);
      const recipients =
        targetTable === null || targetIssued <= 0
          ? [{ holderId: makeId('fund', 'former', target.id), holderKind: 'fund' as const, share: 1 }]
          : targetTable.holdings
              .filter((holding) => holding.shares > 0)
              .map((holding) => ({ holderId: holding.holderId, holderKind: holding.holderKind, share: holding.shares / targetIssued }));

      let allocated = 0;
      for (let index = 0; index < recipients.length; index += 1) {
        const recipient = recipients[index];
        if (recipient === undefined) continue;
        const shares = index === recipients.length - 1 ? sharesIssued - allocated : Math.floor(sharesIssued * recipient.share);
        if (shares <= 0) continue;
        allocated += shares;
        const before = holderPct(acquirerTable, acquirerSecurity.id, acquirerClass.id, recipient.holderId);
        addShares(acquirerTable, {
          securityId: acquirerSecurity.id,
          holderId: recipient.holderId,
          holderKind: recipient.holderKind,
          shares,
          costUsd: shares * price,
          quarter: draft.quarter,
          lockupUntilQuarter: draft.quarter + ACQUISITION_LOCKUP_QUARTERS,
        });
        setIssued(acquirerTable, acquirerClass, acquirerClass.issuedShares + shares, draft.quarter);
        reportThreshold(
          draft,
          ctx,
          acquirer.id,
          recipient.holderId,
          before,
          holderPct(acquirerTable, acquirerSecurity.id, acquirerClass.id, recipient.holderId),
        );
      }
    }

    /* --- absorb the target ------------------------------------------------ */
    acquirer.balanceSheet.assets.cash += target.balanceSheet.assets.cash;
    acquirer.balanceSheet.assets.ppe += target.balanceSheet.assets.ppe;
    acquirer.balanceSheet.assets.investments += target.balanceSheet.assets.investments;
    acquirer.balanceSheet.assets.receivables += target.balanceSheet.assets.receivables;
    acquirer.balanceSheet.assets.goodwill += target.balanceSheet.assets.goodwill + goodwill;
    acquirer.balanceSheet.liabilities.debt += target.balanceSheet.liabilities.debt;
    acquirer.balanceSheet.liabilities.payables += target.balanceSheet.liabilities.payables;
    acquirer.balanceSheet.liabilities.deferredRevenue += target.balanceSheet.liabilities.deferredRevenue;
    // assets - liabilities moved by netAssets + goodwill - cash paid, which is
    // exactly the stock consideration; equity moves by the same amount.
    acquirer.balanceSheet.equity += stockComponent;

    acquirer.financials.cash += target.financials.cash;
    acquirer.financials.debt += target.financials.debt;
    acquirer.financials.revenueQuarterly += target.financials.revenueQuarterly;
    acquirer.financials.deferredRevenue += target.financials.deferredRevenue;
    acquirer.financials.backlogUsd += target.financials.backlogUsd;

    const totalStaffBefore = headcount(acquirer);
    acquirer.employees.engineers += target.employees.engineers;
    acquirer.employees.researchers += target.employees.researchers;
    acquirer.employees.sales += target.employees.sales;
    acquirer.employees.ops += target.employees.ops;
    acquirer.employees.execs += target.employees.execs;
    const totalStaffAfter = Math.max(1, headcount(acquirer));
    acquirer.employees.avgComp =
      (acquirer.employees.avgComp * totalStaffBefore + target.employees.avgComp * headcount(target)) / totalStaffAfter;
    acquirer.employees.attrition = clamp01(acquirer.employees.attrition + ACQUISITION_ATTRITION_PENALTY);
    acquirer.employees.morale = clamp(acquirer.employees.morale - 4, 0, 100);

    acquirer.compute.ownedAccelerators += target.compute.ownedAccelerators;
    acquirer.compute.reservedAccelerators += target.compute.reservedAccelerators;
    acquirer.compute.cloudSpendQuarterly += target.compute.cloudSpendQuarterly;
    for (const product of target.products) acquirer.products.push({ ...product });
    for (const [area, strength] of Object.entries(target.techCapabilities)) {
      const current = acquirer.techCapabilities[area] ?? 0;
      acquirer.techCapabilities[area] = clamp01(Math.max(current, strength * ACQUISITION_CAPABILITY_RETENTION));
    }

    /* --- extinguish the target -------------------------------------------- */
    target.isActive = false;
    target.parentCompanyId = acquirer.id;
    target.controllerPlayerId = null;
    target.financials.cash = 0;
    target.financials.debt = 0;
    target.financials.revenueQuarterly = 0;
    target.financials.deferredRevenue = 0;
    target.financials.backlogUsd = 0;
    target.balanceSheet.assets = { cash: 0, ppe: 0, goodwill: 0, investments: 0, receivables: 0 };
    target.balanceSheet.liabilities = { debt: 0, payables: 0, deferredRevenue: 0 };
    target.balanceSheet.equity = 0;
    target.employees = { ...target.employees, engineers: 0, researchers: 0, sales: 0, ops: 0, execs: 0, openRoles: 0 };
    target.compute = { ...target.compute, ownedAccelerators: 0, reservedAccelerators: 0, cloudSpendQuarterly: 0 };
    for (const product of target.products) product.isActive = false;

    if (targetTable !== null) {
      for (const holding of targetTable.holdings) holding.shares = 0;
      for (const klass of targetTable.shareClasses) setIssued(targetTable, klass, 0, draft.quarter);
    }
    for (const project of draft.researchProjects) {
      if (project.companyId === target.id && (project.status === 'active' || project.status === 'paused')) project.companyId = acquirer.id;
    }
    for (const character of draft.characters) {
      if (character.companyId === target.id) character.companyId = acquirer.id;
    }

    const eventId = ctx.emit({
      sessionId: draft.sessionId,
      quarter: draft.quarter,
      type: 'acquisition_completed',
      actorId: acquirer.id,
      targetId: target.id,
      payload: {
        offerValueUsd: round(intent.offerValueUsd, 2),
        cashUsd: round(cashComponent, 2),
        stockUsd: round(stockComponent, 2),
        sharesIssued,
        goodwillUsd: round(goodwill, 2),
        netAssetsUsd: round(netAssets, 2),
      },
      visibility: 'public',
    });
    ctx.log({
      phase: 'capital_resolution',
      text: `${acquirer.name} acquired ${target.name} for ${compactUsd(intent.offerValueUsd)}, recognising ${compactUsd(goodwill)} of goodwill.`,
      deltaLabel: `+${headcount(target)} staff`,
      refEventIds: [eventId],
      tone: 'positive',
      subjectId: acquirer.id,
    });
  }
}

/* -------------------------------------------------------------------------- */
/*  Local helpers                                                              */
/* -------------------------------------------------------------------------- */

const headcount = (company: Company): number =>
  company.employees.engineers + company.employees.researchers + company.employees.sales + company.employees.ops + company.employees.execs;

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return value < min ? min : value > max ? max : value;
}

function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

function round(value: number, decimals: number): number {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function tickerFor(name: string): string {
  const letters = name.replace(/[^A-Za-z]/g, '').toUpperCase();
  return (letters.slice(0, 3) || 'NEW').padEnd(3, 'X');
}

function compactUsd(value: number): string {
  if (!Number.isFinite(value)) return '$0';
  const abs = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  if (abs >= 1e9) return `${sign}$${strip((abs / 1e9).toFixed(2))}bn`;
  if (abs >= 1e6) return `${sign}$${strip((abs / 1e6).toFixed(1))}m`;
  if (abs >= 1e3) return `${sign}$${strip((abs / 1e3).toFixed(0))}k`;
  return `${sign}$${Math.round(abs)}`;
}

function strip(value: string): string {
  return value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value;
}
