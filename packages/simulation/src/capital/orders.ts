/**
 * @frontier/simulation — capital/orders.ts
 *
 * Settling a fund's long orders, through the same economics as everyone else.
 *
 * A fund is not a `Company`, so it cannot ride the ordinary trade settlement,
 * which keys everything off `actorCompanyId` and moves a corporate balance
 * sheet. What it *can* share — and does, line for line — is the economics:
 *
 * - **Absorption.** One quarter takes its own traded volume and never less than
 *   one per cent of the issued base.
 * - **Convex float pricing.** The last shares of a float cost more than the
 *   first; buying the whole of it costs twice the quote.
 * - **The block premium.** A named institutional bloc will always sell, at flat
 *   double the quote, which is what pushes a raider out of the anonymous market
 *   and into a negotiation with the holders who will not.
 * - **Lock-ups.** A position inside its lock-up does not sell.
 *
 * And two rules that are this file's own, both there to keep the invariants
 * intact rather than to model anything:
 *
 * 1. A fund buys only out of the **public float** and out of **other funds'
 *    blocks**. It never lifts shares from a company or a person, because that
 *    seller's proceeds would be a balance-sheet movement no ledger row this
 *    quarter declares, and `financial_integrity` would refuse the quarter.
 * 2. Every dollar of consideration is declared on the `shares_traded` row as
 *    `dryPowderDeltaUsd`, which is what `capital_integrity` reconstructs the
 *    entity's cash from.
 */

import type { CapTable, CapitalEntity, CapitalOrder, ResolverContext, SessionState } from '@frontier/contracts';
import { blockExecutionPriceUsd, makeId, stakeExecutionPriceUsd, stakeImpactPct } from '@frontier/contracts';
import { creditRealised, floatSharesOf, latestQuote, moveDryPowder } from './context';

const DISCLOSURE_THRESHOLD_PCT = 0.05;

/** What one settled fund order did, for the caller's report line. */
export interface SettledCapitalOrder {
  readonly order: CapitalOrder;
  readonly shares: number;
  readonly considerationUsd: number;
  readonly pricePerShareUsd: number;
  readonly stakePctAfter: number;
}

/** Shares one quarter can absorb in an instrument. */
function absorbableShares(draft: SessionState, instrumentId: string | null, quarter: number, issued: number): number {
  let volume = 0;
  for (const quote of draft.quotes) {
    if (quote.instrumentId === instrumentId && quote.quarter === quarter) volume = Math.max(volume, quote.volume);
  }
  return Math.max(volume, issued * 0.01);
}

function issuedIn(draft: SessionState, table: CapTable, securityId: string): number {
  const security = draft.securities.find((candidate) => candidate.id === securityId);
  if (security === undefined) return 0;
  const declared = table.totalIssuedByClass[security.shareClassId];
  if (declared !== undefined && declared > 0) return declared;
  return table.shareClasses.find((klass) => klass.id === security.shareClassId)?.issuedShares ?? 0;
}

/**
 * Settle every `buy` and `sell` order the desks wrote this quarter.
 *
 * Runs in `market_resolution` after the market has priced, so a fund pays this
 * quarter's quote exactly as an ordinary trade does.
 */
export function settleCapitalOrders(draft: SessionState, ctx: ResolverContext): SettledCapitalOrder[] {
  const settled: SettledCapitalOrder[] = [];
  const orders = (draft.capitalOrders ?? []).filter((order) => order.kind === 'buy' || order.kind === 'sell');
  if (orders.length === 0) return settled;
  const entities = new Map((draft.capitalEntities ?? []).map((entity) => [entity.id, entity] as const));

  for (const order of orders) {
    if (order.kind !== 'buy' && order.kind !== 'sell') continue;
    const entity = entities.get(order.entityId);
    const security = draft.securities.find((candidate) => candidate.id === order.securityId);
    const table = draft.capTables.find((candidate) => candidate.companyId === order.companyId);
    if (entity === undefined || security === undefined || table === undefined) continue;

    const quote = latestQuote(draft, security.instrumentId, ctx.quarter);
    if (quote === null || quote.price <= 0) continue;
    const issued = issuedIn(draft, table, security.id);
    if (issued <= 0) continue;
    const absorbable = Math.floor(absorbableShares(draft, security.instrumentId, ctx.quarter, issued));

    const existing = table.holdings.find((holding) => holding.securityId === security.id && holding.holderId === entity.id && holding.holderKind === 'fund') ?? null;
    const heldBefore = existing?.shares ?? 0;

    if (order.kind === 'buy') {
      const result = settleBuy(draft, ctx, entity, table, security.id, order, quote.price, absorbable);
      if (result !== null) settled.push(result);
      continue;
    }

    /* --- sell -------------------------------------------------------------- */
    if (existing === null || heldBefore <= 0) continue;
    if (existing.lockupUntilQuarter !== null && ctx.quarter < existing.lockupUntilQuarter) continue;
    if (order.limitPriceUsd !== null && quote.price < order.limitPriceUsd) continue;

    const shares = Math.max(0, Math.min(order.shares, heldBefore, absorbable));
    if (shares <= 0) continue;
    const proceeds = Math.round(shares * quote.price);
    const carrying = Math.round(existing.costBasisUsd * (shares / existing.shares));

    existing.shares -= shares;
    existing.costBasisUsd = Math.max(0, Math.round(existing.costBasisUsd - carrying));
    existing.isDisclosed = existing.shares / issued >= DISCLOSURE_THRESHOLD_PCT;

    // The shares go back into the anonymous remainder, which is where a sale into
    // the market always ends up: the register still reconciles to the share.
    const floatHolding = table.holdings.find((holding) => holding.securityId === security.id && holding.holderKind === 'public_float');
    if (floatHolding === undefined) {
      table.holdings.push({
        id: makeId('hld', security.id, 'public_float'),
        holderId: makeId('float', security.id),
        holderKind: 'public_float',
        securityId: security.id,
        shares,
        costBasisUsd: proceeds,
        acquiredQuarter: ctx.quarter,
        lockupUntilQuarter: null,
        isDisclosed: true,
      });
    } else {
      floatHolding.shares += shares;
      floatHolding.costBasisUsd = Math.round(floatHolding.costBasisUsd + proceeds);
    }
    table.lastUpdatedQuarter = ctx.quarter;

    // Cash back is a distribution, and a distribution is the numerator of DPI —
    // which is the only number the fund's own investors actually count.
    const dryPowderDeltaUsd = creditRealised(entity, proceeds);
    const stakePctAfter = existing.shares / issued;

    ctx.emit({
      sessionId: draft.sessionId,
      quarter: ctx.quarter,
      type: 'shares_traded',
      actorId: entity.id,
      targetId: security.id,
      payload: {
        side: 'sell',
        holderKind: 'fund',
        entityId: entity.id,
        shares,
        pricePerShare: Math.round(quote.price * 10_000) / 10_000,
        considerationUsd: proceeds,
        issuerCompanyId: order.companyId,
        ownershipPctBefore: Math.round((heldBefore / issued) * 1e6) / 1e6,
        ownershipPctAfter: Math.round(stakePctAfter * 1e6) / 1e6,
        reason: order.reason,
        forced: order.isForced,
        realisedUsd: proceeds - carrying,
        dryPowderDeltaUsd,
      },
      visibility: stakePctAfter >= DISCLOSURE_THRESHOLD_PCT || heldBefore / issued >= DISCLOSURE_THRESHOLD_PCT ? 'public' : 'company',
    });

    settled.push({ order, shares, considerationUsd: proceeds, pricePerShareUsd: quote.price, stakePctAfter });
  }

  return settled;
}

/** The buy half, kept separate because the float and the block price differently. */
function settleBuy(
  draft: SessionState,
  ctx: ResolverContext,
  entity: CapitalEntity,
  table: CapTable,
  securityId: string,
  order: Extract<CapitalOrder, { kind: 'buy' }>,
  quotePrice: number,
  absorbable: number,
): SettledCapitalOrder | null {
  const issued = issuedIn(draft, table, securityId);
  const limit = order.limitPriceUsd ?? Number.POSITIVE_INFINITY;
  const available = floatSharesOf(table, securityId);
  const cash = entity.dryPowderUsd;

  let floatShares = Math.max(0, Math.min(order.shares, available, absorbable));
  // Cost rises faster than size, so shrink until it fits both the limit and the
  // cash. Bounded, integer and monotone, so it terminates and it replays.
  for (let step = 0; step < 64 && floatShares > 0; step += 1) {
    const unitPrice = stakeExecutionPriceUsd(quotePrice, floatShares, available);
    if (unitPrice <= limit && floatShares * unitPrice <= cash) break;
    const affordable = unitPrice > limit ? floatShares - 1 : Math.floor(cash / Math.max(unitPrice, 1e-6));
    floatShares = affordable >= floatShares ? floatShares - 1 : Math.max(0, affordable);
  }

  const executionPrice = floatShares > 0 ? stakeExecutionPriceUsd(quotePrice, floatShares, available) : quotePrice;
  let consideration = Math.round(floatShares * executionPrice);
  let blockShares = 0;

  // The last tranche is a social problem, not a cash one — except from another
  // institution, which will always sell at a price. That price is flat double the
  // quote.
  const blockPrice = blockExecutionPriceUsd(quotePrice);
  if (floatShares < order.shares && blockPrice <= limit) {
    const blocks = table.holdings
      .filter(
        (holding) =>
          holding.securityId === securityId &&
          holding.holderKind === 'fund' &&
          holding.holderId !== entity.id &&
          holding.shares > 0 &&
          (holding.lockupUntilQuarter === null || ctx.quarter >= holding.lockupUntilQuarter),
      )
      .slice()
      .sort((a, b) => (b.shares !== a.shares ? b.shares - a.shares : a.id < b.id ? -1 : 1));
    const supply = blocks.reduce((sum, holding) => sum + holding.shares, 0);
    const cashLeft = Math.max(0, cash - consideration);
    // A block is bought from a named institution, not lifted off the tape, so it
    // is not bounded by what the market could absorb this quarter. That is the
    // whole reason a raider pays double for it: the premium buys speed, and
    // charging it while still metering the size would leave the block premium
    // costing something and buying nothing.
    let want = Math.max(0, Math.min(order.shares - floatShares, supply, Math.floor(cashLeft / Math.max(blockPrice, 1e-6))));

    for (const holding of blocks) {
      if (want <= 0) break;
      const taken = Math.min(holding.shares, want);
      holding.shares -= taken;
      holding.costBasisUsd = Math.max(0, Math.round(holding.costBasisUsd * (holding.shares + taken > 0 ? holding.shares / (holding.shares + taken) : 0)));
      // The seller is another fund, and it is paid: its dry powder rises by the
      // block price, which is the whole reason a block is worth holding.
      const seller = (draft.capitalEntities ?? []).find((candidate) => candidate.id === holding.holderId);
      if (seller !== undefined) {
        const credited = creditRealised(seller, Math.round(taken * blockPrice));
        ctx.emit({
          sessionId: draft.sessionId,
          quarter: ctx.quarter,
          type: 'shares_traded',
          actorId: seller.id,
          targetId: securityId,
          payload: {
            side: 'sell',
            holderKind: 'fund',
            entityId: seller.id,
            shares: taken,
            pricePerShare: Math.round(blockPrice * 10_000) / 10_000,
            considerationUsd: Math.round(taken * blockPrice),
            issuerCompanyId: order.companyId,
            reason: 'block_sale',
            blockPremiumApplied: true,
            dryPowderDeltaUsd: credited,
          },
          visibility: 'public',
        });
      }
      want -= taken;
      blockShares += taken;
    }
    consideration = Math.round(consideration + blockShares * blockPrice);
  }

  const shares = floatShares + blockShares;
  if (shares <= 0) return null;

  // Take the float half out of the float, largest position first, deterministically.
  let remaining = floatShares;
  for (const holding of table.holdings
    .filter((candidate) => candidate.securityId === securityId && candidate.holderKind === 'public_float')
    .slice()
    .sort((a, b) => (b.shares !== a.shares ? b.shares - a.shares : a.id < b.id ? -1 : 1))) {
    if (remaining <= 0) break;
    const taken = Math.min(holding.shares, remaining);
    holding.shares -= taken;
    holding.costBasisUsd = Math.max(0, Math.round(holding.costBasisUsd * (holding.shares + taken > 0 ? holding.shares / (holding.shares + taken) : 0)));
    remaining -= taken;
  }

  const existing = table.holdings.find((holding) => holding.securityId === securityId && holding.holderId === entity.id && holding.holderKind === 'fund') ?? null;
  const heldBefore = existing?.shares ?? 0;
  if (existing === null) {
    table.holdings.push({
      id: makeId('hld', securityId, entity.id),
      holderId: entity.id,
      holderKind: 'fund',
      securityId,
      shares,
      costBasisUsd: consideration,
      acquiredQuarter: ctx.quarter,
      lockupUntilQuarter: null,
      isDisclosed: issued > 0 && shares / issued >= DISCLOSURE_THRESHOLD_PCT,
    });
  } else {
    existing.shares += shares;
    existing.costBasisUsd = Math.round(existing.costBasisUsd + consideration);
    existing.isDisclosed = existing.isDisclosed || (issued > 0 && existing.shares / issued >= DISCLOSURE_THRESHOLD_PCT);
  }
  table.lastUpdatedQuarter = ctx.quarter;

  const dryPowderDeltaUsd = moveDryPowder(entity, -consideration);
  const stakePctAfter = issued > 0 ? (heldBefore + shares) / issued : 0;

  ctx.emit({
    sessionId: draft.sessionId,
    quarter: ctx.quarter,
    type: 'shares_traded',
    actorId: entity.id,
    targetId: securityId,
    payload: {
      side: 'buy',
      holderKind: 'fund',
      entityId: entity.id,
      shares,
      requestedShares: order.shares,
      pricePerShare: Math.round((consideration / shares) * 10_000) / 10_000,
      considerationUsd: consideration,
      issuerCompanyId: order.companyId,
      ownershipPctBefore: issued > 0 ? Math.round((heldBefore / issued) * 1e6) / 1e6 : 0,
      ownershipPctAfter: Math.round(stakePctAfter * 1e6) / 1e6,
      quotePriceUsd: quotePrice,
      executionPriceUsd: Math.round(executionPrice * 10_000) / 10_000,
      impactPct: stakeImpactPct(floatShares, available),
      floatShares,
      blockShares,
      blockPremiumApplied: blockShares > 0,
      reason: order.reason,
      dryPowderDeltaUsd,
    },
    visibility: stakePctAfter >= DISCLOSURE_THRESHOLD_PCT ? 'public' : 'company',
  });

  return { order, shares, considerationUsd: consideration, pricePerShareUsd: consideration / shares, stakePctAfter };
}
