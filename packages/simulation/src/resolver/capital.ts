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
import type { DividendPreview } from '@frontier/contracts';
import {
  CONTROL_DECISIVE_PCT,
  CONTROL_INFORMATION_PCT,
  DIVIDEND_CASH_CAP_SHARE,
  DIVIDEND_MAX_PAYOUT_PCT,
  dividendReputationBonus,
  dividendUsd,
  grantsControl,
  makeId,
  ownershipThresholdFor,
  priceWithinBand,
  sharesForMarketCap,
} from '@frontier/contracts';
import { moveDryPowder } from '../capital/context';
import { pickLeadInvestor } from '../capital/leads';
import { companyCapitalDepthFactor } from '../economy/regions';
import { isMultiSectorWorld } from '../economy/sectors';
import { maxTollForCompany } from '../economy/prices';
import { lastQuarterNetIncomeUsd } from '../companies/financials';
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

/**
 * Re-denominate every share class in a cap table so the company's shares total
 * `targetFullyDiluted`. A stock split, in other words, and the mechanism behind
 * the readable-price rule in `@frontier/contracts/markets`: capitalisation is
 * the real quantity, and the share count is what gets chosen so a price reads
 * like a price.
 *
 * Ownership is preserved exactly, not approximately. Every holding is scaled and
 * rounded, and the whole rounding residual for a class is settled against its
 * largest holding, so `sum(holdings) === issuedShares === totalIssuedByClass`
 * still holds to the share — which is what the ownership invariant checks.
 *
 * Returns the resulting fully diluted count, which is the incoming one when the
 * split was refused (no shares, a degenerate ratio, or a residual that would
 * drive a holding negative).
 */
export function normaliseShareCount(draft: SessionState, table: CapTable, targetFullyDiluted: number, quarter: number): number {
  const current = table.fullyDilutedShares;
  const target = Math.round(targetFullyDiluted);
  if (!(current > 0) || !(target > 0)) return current;
  const ratio = target / current;
  // A split of less than a tenth of a percent is not worth the rounding it costs.
  if (Math.abs(ratio - 1) < 0.001) return current;

  const classOfSecurity = new Map<string, string>();
  for (const security of draft.securities) {
    if (security.companyId === table.companyId) classOfSecurity.set(security.id, security.shareClassId);
  }

  // Scale each class independently so the per-class invariant survives, then
  // recompute the total rather than trusting the target to be exactly divisible.
  const scaledByClass = new Map<string, Holding[]>();
  for (const holding of table.holdings) {
    const classId = classOfSecurity.get(holding.securityId);
    if (classId === undefined) continue;
    const bucket = scaledByClass.get(classId);
    if (bucket === undefined) scaledByClass.set(classId, [holding]);
    else bucket.push(holding);
  }

  for (const shareClass of table.shareClasses) {
    const wanted = Math.max(0, Math.round(shareClass.issuedShares * ratio));
    const holdings = (scaledByClass.get(shareClass.id) ?? []).slice().sort((a, b) => b.shares - a.shares || (a.id < b.id ? -1 : 1));
    if (holdings.length === 0) {
      shareClass.issuedShares = wanted;
      table.totalIssuedByClass[shareClass.id] = wanted;
      continue;
    }
    let sum = 0;
    for (const holding of holdings) {
      holding.shares = Math.max(0, Math.round(holding.shares * ratio));
      sum += holding.shares;
    }
    const residual = wanted - sum;
    const largest = holdings[0];
    if (largest !== undefined && largest.shares + residual >= 0) {
      largest.shares += residual;
      sum = wanted;
    }
    shareClass.issuedShares = sum;
    table.totalIssuedByClass[shareClass.id] = sum;
    shareClass.authorisedShares = Math.max(shareClass.authorisedShares, Math.round(shareClass.authorisedShares * ratio), sum);
  }

  table.optionPoolShares = Math.max(0, Math.round(table.optionPoolShares * ratio));
  table.fullyDilutedShares = table.shareClasses.reduce((sum, klass) => sum + klass.issuedShares, 0) + table.optionPoolShares;
  table.lastUpdatedQuarter = quarter;
  return table.fullyDilutedShares;
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
    payload: {
      threshold: crossed.label,
      pct: round(after, 4),
      previousPct: round(before, 4),
      effect: crossed.effect,
      // 50% + 1 share is the only threshold that flips anything in the engine.
      grantsControl: after > CONTROL_DECISIVE_PCT,
      grantsInformationRight: after >= CONTROL_INFORMATION_PCT,
    },
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
  resolvePolicies(draft, ctx);
  resolveFundingRounds(draft, ctx, rng);
  resolveDebtIssues(draft, ctx, rng);
  resolveShareIssues(draft, ctx);
  resolveListings(draft, ctx);
  resolveBuybacks(draft, ctx);
  // Dividends settle after buybacks and before acquisitions, so a company cannot
  // pay a dividend with money it needs for a deal it has already agreed.
  resolveDividends(draft, ctx);
  resolveAcquisitions(draft, ctx);
  routeDeals(draft, ctx);
}

/* ------------------------------- policies --------------------------------- */

/**
 * Record the standing policies this quarter's actions set.
 *
 * Neither is an economic mutation on its own — no money moves — so neither
 * writes its own ledger row: the `action_accepted` row the collection phase
 * already wrote is the record, and the quarter the policy actually costs
 * something is the quarter that emits `dividend_paid` or carries
 * `logisticsTollPct` on a `cost_recognised` row.
 */
function resolvePolicies(draft: SessionState, ctx: ResolverContext): void {
  for (const { action, intent } of pendingOfType(draft, 'set_dividend_policy')) {
    const company = findCompany(draft, action.actorCompanyId);
    if (company === null) continue;
    const before = company.dividendPolicyPct ?? 0;
    company.dividendPolicyPct = clamp(Math.round(intent.payoutPct), 0, DIVIDEND_MAX_PAYOUT_PCT);
    if (company.dividendPolicyPct === before) continue;
    ctx.log({
      phase: 'capital_resolution',
      text: `${company.name} set its payout policy to ${company.dividendPolicyPct}% of net income, from ${before}%.`,
      deltaLabel: `${company.dividendPolicyPct >= before ? '+' : ''}${company.dividendPolicyPct - before}pp`,
      refEventIds: [],
      tone: 'neutral',
      subjectId: company.id,
    });
  }

  for (const { action, intent } of pendingOfType(draft, 'set_logistics_toll')) {
    const company = findCompany(draft, action.actorCompanyId);
    if (company === null) continue;
    // A dial, not a right: the ceiling is what the group's regional share has
    // actually earned, and it is recomputed here rather than trusted from the
    // validator, because the world moved between submission and resolution.
    const ceiling = maxTollForCompany(draft, company, intent.region);
    company.logisticsTollPct = clamp(Math.round(intent.tollPct), 0, ceiling);
  }
}

/* ------------------------------- dividends -------------------------------- */

/**
 * Pay dividends on **last** quarter's net income.
 *
 * Last quarter's, because `financial_resolution` is phase eleven and this is
 * phase six: at this point in the quarter the current period has not been earned
 * yet, and a payout struck on it would be a payout from a forecast. Saying so
 * here is what stops a future reader "fixing" it.
 *
 * Cash and equity fall together, so the balance-sheet identity survives. Holders
 * are paid pro rata: a corporate holder books cash and the matching equity, a
 * person books it as personal wealth, and the public float is money that has
 * left the session's companies.
 */
function resolveDividends(draft: SessionState, ctx: ResolverContext): void {
  if (!isMultiSectorWorld(draft)) return;
  const rows: DividendPreview[] = [];

  for (const company of draft.companies) {
    if (!company.isActive) continue;
    const payoutPct = clamp(Math.round(company.dividendPolicyPct ?? 0), 0, DIVIDEND_MAX_PAYOUT_PCT);
    const basis = lastQuarterNetIncomeUsd(company);
    const cash = company.balanceSheet.assets.cash;
    const payable = Math.max(0, (Math.max(0, basis) * payoutPct) / 100);
    const dividend = dividendUsd(basis, payoutPct, cash);
    if (payoutPct <= 0 || dividend <= 0) continue;

    const table = findCapTable(draft, company.id);
    const security = findSecurity(draft, company.primarySecurityId) ?? draft.securities.find((s) => s.companyId === company.id) ?? null;
    const shareClass = table?.shareClasses.find((klass) => klass.id === security?.shareClassId) ?? table?.shareClasses[0] ?? null;
    const issued = shareClass?.issuedShares ?? 0;
    if (table === null || security === null || issued <= 0) continue;

    company.balanceSheet.assets.cash = round(Math.max(0, cash - dividend), 2);
    company.financials.cash = company.balanceSheet.assets.cash;
    company.balanceSheet.equity = round(company.balanceSheet.equity - dividend, 2);
    company.reputation.investor = clamp(company.reputation.investor + dividendReputationBonus(payoutPct), 0, 100);

    const perShare = dividend / issued;
    const corporateRecipients: { holderId: string; amountUsd: number }[] = [];
    // A fund holder is paid too, and the payment is cash back to its investors.
    // It is named on the row for the same reason corporate recipients are: so
    // the gate can reconstruct every book the payout moved.
    const fundRecipients: { holderId: string; amountUsd: number; dryPowderDeltaUsd: number }[] = [];
    const entitiesById = new Map((draft.capitalEntities ?? []).map((entity) => [entity.id, entity] as const));
    let distributed = 0;
    const holders = table.holdings
      .filter((holding) => holding.securityId === security.id && holding.shares > 0)
      .slice()
      .sort((a, b) => (b.shares !== a.shares ? b.shares - a.shares : a.id < b.id ? -1 : 1));

    for (const holding of holders) {
      const amount = round(holding.shares * perShare, 2);
      if (amount <= 0) continue;
      distributed += amount;
      if (holding.holderKind === 'company') {
        const holder = findCompany(draft, holding.holderId);
        if (holder === null) continue;
        holder.balanceSheet.assets.cash = round(holder.balanceSheet.assets.cash + amount, 2);
        holder.financials.cash = holder.balanceSheet.assets.cash;
        // Dividend income is income: assets up, equity up, identity intact.
        holder.balanceSheet.equity = round(holder.balanceSheet.equity + amount, 2);
        corporateRecipients.push({ holderId: holder.id, amountUsd: amount });
        continue;
      }
      if (holding.holderKind === 'fund') {
        const entity = entitiesById.get(holding.holderId);
        if (entity === undefined) continue;
        // The whole payment counts toward DPI — it is cash returned to the
        // fund's own investors — but only the part inside the committed size
        // becomes spendable dry powder again; the rest has left for the LPs.
        // Going through the shared mover is what keeps that ceiling in one
        // place and keeps the row's stated delta equal to the movement.
        const credited = moveDryPowder(entity, Math.round(amount));
        entity.realisedProceedsUsd = Math.round(entity.realisedProceedsUsd + Math.round(amount));
        fundRecipients.push({ holderId: entity.id, amountUsd: amount, dryPowderDeltaUsd: credited });
        continue;
      }
      if (holding.holderKind === 'player' || holding.holderKind === 'character') {
        const character = draft.characters.find((candidate) => candidate.id === holding.holderId);
        if (character !== undefined) character.personalWealthUsd = round(character.personalWealthUsd + amount, 2);
      }
    }

    const eventId = ctx.emit({
      sessionId: draft.sessionId,
      quarter: draft.quarter,
      type: 'dividend_paid',
      actorId: company.id,
      targetId: security.id,
      payload: {
        companyId: company.id,
        payoutPct,
        netIncomeBasisUsd: round(basis, 2),
        dividendUsd: dividend,
        perShareUsd: round(perShare, 4),
        cashAfterUsd: company.balanceSheet.assets.cash,
        sharesOutstanding: issued,
        distributedUsd: round(distributed, 2),
        cappedByCash: payable > dividend + 0.5,
        // Named so the invariant gate can reconstruct every balance sheet the
        // payout moved, not just the one it left.
        corporateRecipients: corporateRecipients.slice(0, 24),
        fundRecipients: fundRecipients.slice(0, 12),
      },
      visibility: 'public',
    });
    ctx.log({
      phase: 'capital_resolution',
      text: `${company.name} paid ${compactUsd(dividend)} to shareholders at a ${payoutPct}% payout, keeping ${compactUsd(Math.max(0, basis) - dividend)} in the business.`,
      deltaLabel: `-${compactUsd(dividend)}`,
      refEventIds: [eventId],
      tone: 'neutral',
      subjectId: company.id,
    });

    rows.push({
      companyId: company.id,
      quarter: draft.quarter,
      payoutPct,
      netIncomeBasisUsd: round(basis, 0),
      cashUsd: Math.round(cash),
      payableUsd: Math.round(payable),
      dividendUsd: dividend,
      retainedUsd: Math.round(Math.max(0, basis) - dividend),
      perShareUsd: round(perShare, 4),
      sharesOutstanding: issued,
      cappedByCash: payable > dividend + 0.5,
      causeEventId: eventId,
    });
  }

  if (rows.length > 0 && draft.economyReport !== undefined && draft.economyReport !== null) {
    draft.economyReport = { ...draft.economyReport, dividends: rows };
  }
}

/** The share of cash a payout may never exceed. Re-exported for the interface preview. */
export { DIVIDEND_CASH_CAP_SHARE, grantsControl };

/* ------------------------------- financing -------------------------------- */

function resolveFundingRounds(draft: SessionState, ctx: ResolverContext, rng: SeededRng): void {
  for (const { action, intent } of pendingOfType(draft, 'raise_round')) {
    const company = findCompany(draft, action.actorCompanyId);
    if (company === null) continue;

    const preMoney = estimateValuationUsd(draft, company);
    const postMoney = preMoney + intent.targetAmountUsd;
    const dilution = postMoney <= 0 ? 1 : intent.targetAmountUsd / postMoney;

    // Where the company is decides how deep the local book is: the same round in
    // North America clears more readily than in Latin America. Exactly 1 in
    // world version 1, so a legacy save is unaffected.
    const capitalDepth = companyCapitalDepthFactor(draft, company);
    const appetite =
      (0.5 * draft.world.capitalMarkets.ventureLiquidity +
        0.3 * draft.world.capitalMarkets.riskAppetite +
        0.2 * (company.reputation.investor / 100)) *
      capitalDepth;
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

    // Who actually led it. Before capital entities existed this was a holder
    // invented for the round — `fund:venture:<company>` — with no lead investor
    // at all, so every round in the game was led by nobody on behalf of an
    // institution that existed for one company and never acted again. Where a
    // roster exists, a real fund writes the cheque out of real dry powder and
    // its partner's name goes on the round. World 1 has no roster, so it keeps
    // the synthetic holder and replays byte for byte.
    const lead = pickLeadInvestor(draft, company, intent.stage, intent.targetAmountUsd);
    const holderId = lead === null ? makeId('fund', 'venture', company.id) : lead.entity.id;
    // The lead's cash falls by exactly what it wrote, and the movement is stated
    // on the round row below rather than inferred from the balance.
    let leadDryPowderDeltaUsd = 0;
    if (lead !== null) {
      const before = lead.entity.dryPowderUsd;
      lead.entity.dryPowderUsd = Math.max(0, Math.round(before - intent.targetAmountUsd));
      leadDryPowderDeltaUsd = lead.entity.dryPowderUsd - before;
    }
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
    // A priced round amends the charter as part of closing it. Without this a
    // company that raised enough times would hit its own authorisation and the
    // quarter would fail `authoritative_backend` for doing exactly what a round
    // is supposed to do.
    shareClass.authorisedShares = Math.max(shareClass.authorisedShares, shareClass.issuedShares + newShares);
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
      leadInvestorCharacterId: lead?.partnerCharacterId ?? null,
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
        entityId: lead === null ? null : lead.entity.id,
        leadInvestorCharacterId: lead?.partnerCharacterId ?? null,
        // Declared for `capital_integrity`: the fund's cash moved by exactly the
        // cheque it wrote, and no other row explains it.
        dryPowderDeltaUsd: leadDryPowderDeltaUsd,
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
    let price = impliedPerShare * (0.75 + 0.5 * window);

    // A listing is the one moment the share count is ours to choose, so world
    // version 2 chooses it: split or consolidate the register until the offer
    // prices inside SHARE_PRICE_BAND_USD. The capitalisation is unchanged — only
    // the denomination is — which is why this happens before the price floor is
    // tested against the player's own minimum.
    if (isMultiSectorWorld(draft) && table.fullyDilutedShares > 0 && !priceWithinBand(price)) {
      const impliedCapUsd = price * table.fullyDilutedShares;
      const applied = normaliseShareCount(draft, table, sharesForMarketCap(impliedCapUsd), draft.quarter);
      if (applied > 0) price = impliedCapUsd / applied;
    }

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
    // Pay more than the net assets are worth and the excess is goodwill — an
    // asset, and the usual case. Pay *less* and the difference is a bargain
    // purchase: the acquirer really is better off by it, and the standards
    // (IFRS 3, ASC 805) recognise it immediately as a gain rather than parking
    // negative goodwill on the balance sheet. Booking neither, as this once did,
    // left assets exceeding liabilities plus equity by the whole discount, which
    // the financial phase then absorbed into equity — equity nobody issued.
    const goodwill = Math.max(0, intent.offerValueUsd - netAssets);
    const bargainGain = Math.max(0, netAssets - intent.offerValueUsd);

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
    // Assets less liabilities moved by netAssets + goodwill - cash paid. With
    // goodwill floored at zero that is the stock consideration plus any bargain
    // gain, so equity moves by exactly the same amount and the identity holds on
    // both sides of net asset value.
    acquirer.balanceSheet.equity += stockComponent + bargainGain;

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

    // Bounded history: what the antitrust score reads to know this group has
    // been consolidating. Pruned back to the window every quarter by the metrics
    // phase, and never written at all in a single-sector world.
    if (isMultiSectorWorld(draft)) {
      acquirer.recentAcquisitionQuarters = [...(acquirer.recentAcquisitionQuarters ?? []), draft.quarter].slice(-8);
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
        bargainGainUsd: round(bargainGain, 2),
        netAssetsUsd: round(netAssets, 2),
      },
      visibility: 'public',
    });
    ctx.log({
      phase: 'capital_resolution',
      text:
        bargainGain > 0
          ? `${acquirer.name} acquired ${target.name} for ${compactUsd(intent.offerValueUsd)}, ${compactUsd(
              bargainGain,
            )} below the net assets it took on — a bargain purchase, recognised as a gain.`
          : `${acquirer.name} acquired ${target.name} for ${compactUsd(intent.offerValueUsd)}, recognising ${compactUsd(goodwill)} of goodwill.`,
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
