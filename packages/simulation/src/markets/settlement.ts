/**
 * @frontier/simulation — markets/settlement.ts
 *
 * Settling the quarter's share purchases and sales.
 *
 * Positions live in the cap table, not in the market: buying "3% of a public
 * rival" means acquiring shares of a `Security`, and the transfer is subject to
 * the reconciliation invariant. Nothing here issues or destroys shares — every
 * settlement moves shares between holders of the same security, so
 * `sum(holdings) === totalIssuedByClass` holds by construction.
 *
 * Three constraints bite, in this order:
 *
 * 1. **Lock-ups.** A sale inside `lockupUntilQuarter` is refused outright.
 * 2. **Absorption.** `Quote.volume` caps how much the market can take in one
 *    quarter. Buying fast crosses 5% before the target can react and pays for
 *    the privilege through `liquidityEffect`; buying slowly stays quiet longer.
 * 3. **Cash.** The buyer cannot spend money it does not have, whatever the
 *    interface allowed.
 *
 * Crossing a threshold upward emits `ownership_threshold_crossed`, and at 5% the
 * holding becomes disclosed — usually the moment the target's chief executive
 * notices who has been accumulating.
 */

import type { CapTable, SessionState, SubmittedAction } from '@frontier/contracts';
import {
  BLOCK_PREMIUM,
  CONTROL_DECISIVE_PCT,
  OWNERSHIP_THRESHOLDS,
  blockExecutionPriceUsd,
  makeId,
  sharesWithinLimit,
  stakeExecutionPriceUsd,
  stakeImpactPct,
} from '@frontier/contracts';
import { isMultiSectorWorld } from '../economy/sectors';
import { round } from '../economy/util';

/**
 * The share of a holding that becomes public knowledge. Below this line an
 * accumulation stays undisclosed, which is one of the game's sharpest weapons.
 */
export const DISCLOSURE_THRESHOLD_PCT = 0.05;

export interface TradeSettlement {
  readonly action: SubmittedAction;
  readonly securityId: string;
  readonly companyId: string;
  readonly side: 'buy' | 'sell';
  readonly requestedShares: number;
  readonly settledShares: number;
  /** Blended price actually paid per share: the quote in world 1, the execution price after. */
  readonly pricePerShare: number;
  /** The quote the trade was struck against, before any own-order impact. */
  readonly quotePriceUsd: number;
  /** What the float tranche executed at, after its own impact. Equals the quote in world 1. */
  readonly executionPriceUsd: number;
  /** Whole-percentage impact of this order's own size on its execution price. */
  readonly impactPct: number;
  /** Shares taken out of the public float. */
  readonly floatShares: number;
  /** Shares bought out of a named institutional block, at double the quote. */
  readonly blockShares: number;
  readonly considerationUsd: number;
  readonly ownershipPctBefore: number;
  readonly ownershipPctAfter: number;
  readonly crossedThresholds: readonly string[];
  readonly rejectionCode: string | null;
  readonly detail: string;
}

function issuedSharesFor(capTable: CapTable, shareClassId: string): number {
  const declared = capTable.totalIssuedByClass[shareClassId];
  if (declared !== undefined && declared > 0) return declared;
  const shareClass = capTable.shareClasses.find((candidate) => candidate.id === shareClassId);
  return shareClass?.issuedShares ?? 0;
}

function thresholdsCrossed(before: number, after: number): string[] {
  if (after <= before) return [];
  return OWNERSHIP_THRESHOLDS.filter((threshold) => before < threshold.pct && after >= threshold.pct).map((threshold) => threshold.label);
}

/** The last quote for an instrument at or before `quarter`. */
function latestPrice(state: SessionState, instrumentId: string | null, quarter: number): number | null {
  if (instrumentId === null) return null;
  let best: { quarter: number; price: number } | null = null;
  for (const quote of state.quotes) {
    if (quote.instrumentId !== instrumentId || quote.quarter > quarter) continue;
    if (best === null || quote.quarter > best.quarter) best = { quarter: quote.quarter, price: quote.price };
  }
  return best === null ? null : best.price;
}

function absorbableShares(state: SessionState, instrumentId: string | null, quarter: number, issued: number): number {
  let volume = 0;
  for (const quote of state.quotes) {
    if (quote.instrumentId === instrumentId && quote.quarter === quarter) volume = Math.max(volume, quote.volume);
  }
  // A quarter can absorb its own traded volume, and never less than 1% of the
  // issued base — otherwise a thin name would be untradeable forever.
  return Math.max(volume, issued * 0.01);
}

/**
 * Settle every share purchase and sale submitted for `quarter`.
 *
 * Mutates cap tables, holdings and the buyer's balance sheet. Returns one record
 * per attempted trade — settled, clamped or refused — so the caller can emit a
 * ledger row for each.
 */
export function runSettlement(state: SessionState, quarter: number): TradeSettlement[] {
  const settlements: TradeSettlement[] = [];

  const trades = state.pendingActions
    .filter((action) => action.quarter === quarter && (action.intent.type === 'buy_shares' || action.intent.type === 'sell_shares'))
    .slice()
    .sort((a, b) => (a.sequence !== b.sequence ? a.sequence - b.sequence : a.actionId < b.actionId ? -1 : 1));

  for (const action of trades) {
    const intent = action.intent;
    if (intent.type !== 'buy_shares' && intent.type !== 'sell_shares') continue;

    const security = state.securities.find((candidate) => candidate.id === intent.securityId);
    if (security === undefined) {
      settlements.push(rejectTrade(action, intent.securityId, '', 'unknown_target', 'No such security in this session.'));
      continue;
    }
    const capTable = state.capTables.find((table) => table.companyId === security.companyId);
    if (capTable === undefined) {
      settlements.push(rejectTrade(action, security.id, security.companyId, 'unknown_target', 'The issuer has no cap table.'));
      continue;
    }
    if (!security.isTradable) {
      settlements.push(rejectTrade(action, security.id, security.companyId, 'requirement_not_met', 'This security does not trade on the in-world exchange.'));
      continue;
    }

    const price = latestPrice(state, security.instrumentId, quarter);
    if (price === null || !(price > 0)) {
      settlements.push(rejectTrade(action, security.id, security.companyId, 'requirement_not_met', 'The security has no price this quarter.'));
      continue;
    }

    const issued = issuedSharesFor(capTable, security.shareClassId);
    if (issued <= 0) {
      settlements.push(rejectTrade(action, security.id, security.companyId, 'requirement_not_met', 'No shares are issued in this class.'));
      continue;
    }

    const holderId = action.actorCompanyId;
    const existing = capTable.holdings.find((holding) => holding.securityId === security.id && holding.holderId === holderId) ?? null;
    const heldBefore = existing?.shares ?? 0;
    const pctBefore = heldBefore / issued;

    if (intent.type === 'buy_shares') {
      if (price > intent.maxPricePerShareUsd) {
        settlements.push(rejectTrade(action, security.id, security.companyId, 'illegal_value', 'The market price is above the limit price.'));
        continue;
      }
      const targetShares = intent.shares ?? Math.round((intent.targetPct ?? 0) * issued);
      const requested = Math.max(0, intent.shares !== null ? targetShares : targetShares - heldBefore);
      if (requested <= 0) {
        settlements.push(rejectTrade(action, security.id, security.companyId, 'illegal_value', 'The requested position is already held.'));
        continue;
      }

      const float = capTable.holdings.filter((holding) => holding.securityId === security.id && holding.holderKind === 'public_float');
      const available = float.reduce((sum, holding) => sum + holding.shares, 0);
      const buyer = state.companies.find((company) => company.id === holderId) ?? null;
      const cash = buyer === null ? Number.POSITIVE_INFINITY : buyer.financials.cash;
      const absorbable = Math.floor(absorbableShares(state, security.instrumentId, quarter, issued));
      const convex = isMultiSectorWorld(state);

      // World 1 pays the quote flat. From world 2 the last shares of a float cost
      // more than the first — buying the whole of it costs twice the quote — and
      // the limit price therefore has to bind on the *execution* price, not on
      // the quote, or a raider would never feel the slippage they asked for.
      const byLimit = convex ? sharesWithinLimit(price, intent.maxPricePerShareUsd, available) : available;
      let floatShares = Math.max(0, Math.min(requested, available, absorbable, byLimit));
      if (convex) {
        // Cost rises faster than size, so shrink until it fits. Bounded, integer,
        // and monotone, so it terminates and it replays.
        for (let step = 0; step < 64 && floatShares > 0; step += 1) {
          const unitPrice = stakeExecutionPriceUsd(price, floatShares, available);
          if (floatShares * unitPrice <= cash) break;
          const next = Math.min(floatShares - 1, Math.floor(cash / Math.max(unitPrice, 1e-6)));
          floatShares = next >= floatShares ? floatShares - 1 : Math.max(0, next);
        }
      } else {
        floatShares = Math.max(0, Math.min(floatShares, Math.floor(cash / price)));
      }

      const executionPrice = convex ? stakeExecutionPriceUsd(price, floatShares, available) : price;
      const impactPct = convex ? stakeImpactPct(floatShares, available) : 0;
      let consideration = round(floatShares * executionPrice, 2);

      // The last tranche is a social problem, not a cash one — except from an
      // institutional bloc, which will always sell at a price. That price is flat
      // double the quote, which is what pushes a raider out of the anonymous
      // market and into a negotiation with the named holders who will not.
      const blockPrice = blockExecutionPriceUsd(price);
      let blockShares = 0;
      if (convex && floatShares < requested && blockPrice <= intent.maxPricePerShareUsd) {
        const blocks = capTable.holdings
          .filter(
            (holding) =>
              holding.securityId === security.id &&
              holding.holderKind === 'fund' &&
              holding.holderId !== holderId &&
              holding.shares > 0 &&
              (holding.lockupUntilQuarter === null || quarter >= holding.lockupUntilQuarter),
          )
          .slice()
          .sort((a, b) => (b.shares !== a.shares ? b.shares - a.shares : a.id < b.id ? -1 : 1));
        const blockSupply = blocks.reduce((sum, holding) => sum + holding.shares, 0);
        const cashLeft = cash === Number.POSITIVE_INFINITY ? Number.POSITIVE_INFINITY : Math.max(0, cash - consideration);
        const affordableBlocks = cashLeft === Number.POSITIVE_INFINITY ? blockSupply : Math.floor(cashLeft / Math.max(blockPrice, 1e-6));
        let wantBlocks = Math.max(0, Math.min(requested - floatShares, absorbable - floatShares, blockSupply, affordableBlocks));
        for (const holding of blocks) {
          if (wantBlocks <= 0) break;
          const taken = Math.min(holding.shares, wantBlocks);
          holding.shares -= taken;
          holding.costBasisUsd = round(Math.max(0, holding.costBasisUsd * (holding.shares + taken > 0 ? holding.shares / (holding.shares + taken) : 0)), 2);
          wantBlocks -= taken;
          blockShares += taken;
        }
        consideration = round(consideration + blockShares * blockPrice, 2);
      }

      const settled = floatShares + blockShares;
      if (settled <= 0) {
        settlements.push(
          rejectTrade(
            action,
            security.id,
            security.companyId,
            buyer !== null && cash < price ? 'insufficient_cash' : 'requirement_not_met',
            'Nothing could be bought: no float available, no absorbable volume, no cash, or the execution price would have passed the limit.',
          ),
        );
        continue;
      }

      // Take the float shares from the float, largest position first, deterministically.
      let remaining = floatShares;
      for (const holding of float.slice().sort((a, b) => (b.shares !== a.shares ? b.shares - a.shares : a.id < b.id ? -1 : 1))) {
        if (remaining <= 0) break;
        const taken = Math.min(holding.shares, remaining);
        holding.shares -= taken;
        holding.costBasisUsd = round(Math.max(0, holding.costBasisUsd * (holding.shares + taken > 0 ? holding.shares / (holding.shares + taken) : 0)), 2);
        remaining -= taken;
      }
      if (existing === null) {
        capTable.holdings = [
          ...capTable.holdings,
          {
            id: makeId('hld', security.id, holderId),
            holderId,
            holderKind: 'company',
            securityId: security.id,
            shares: settled,
            costBasisUsd: consideration,
            acquiredQuarter: quarter,
            lockupUntilQuarter: null,
            isDisclosed: (heldBefore + settled) / issued >= DISCLOSURE_THRESHOLD_PCT,
          },
        ];
      } else {
        existing.shares += settled;
        existing.costBasisUsd = round(existing.costBasisUsd + consideration, 2);
        existing.isDisclosed = existing.isDisclosed || existing.shares / issued >= DISCLOSURE_THRESHOLD_PCT;
      }

      if (buyer !== null) {
        buyer.financials.cash = round(Math.max(0, buyer.financials.cash - consideration), 2);
        buyer.balanceSheet.assets.cash = buyer.financials.cash;
        buyer.balanceSheet.assets.investments = round(buyer.balanceSheet.assets.investments + consideration, 2);
      }

      capTable.lastUpdatedQuarter = quarter;
      const pctAfter = (heldBefore + settled) / issued;
      settlements.push({
        action,
        securityId: security.id,
        companyId: security.companyId,
        side: 'buy',
        requestedShares: requested,
        settledShares: settled,
        pricePerShare: settled > 0 ? round(consideration / settled, 4) : price,
        quotePriceUsd: price,
        executionPriceUsd: executionPrice,
        impactPct,
        floatShares,
        blockShares,
        considerationUsd: consideration,
        ownershipPctBefore: round(pctBefore, 6),
        ownershipPctAfter: round(pctAfter, 6),
        crossedThresholds: thresholdsCrossed(pctBefore, pctAfter),
        rejectionCode: settled < requested ? 'requirement_not_met' : null,
        detail: settled < requested ? 'Position reduced to the shares the market could absorb.' : 'Settled in full.',
      });
      continue;
    }

    // --- sale ---
    if (existing === null || heldBefore <= 0) {
      settlements.push(rejectTrade(action, security.id, security.companyId, 'unknown_target', 'No position to sell.'));
      continue;
    }
    if (existing.lockupUntilQuarter !== null && quarter < existing.lockupUntilQuarter) {
      settlements.push(rejectTrade(action, security.id, security.companyId, 'lockup_active', `The position is locked up until quarter ${existing.lockupUntilQuarter}.`));
      continue;
    }
    if (price < intent.minPricePerShareUsd) {
      settlements.push(rejectTrade(action, security.id, security.companyId, 'illegal_value', 'The market price is below the limit price.'));
      continue;
    }

    const requested = Math.max(0, Math.trunc(intent.shares));
    const settled = Math.max(0, Math.min(requested, heldBefore, Math.floor(absorbableShares(state, security.instrumentId, quarter, issued))));
    if (settled <= 0) {
      settlements.push(rejectTrade(action, security.id, security.companyId, 'requirement_not_met', 'Nothing could be sold this quarter.'));
      continue;
    }

    const proceeds = round(settled * price, 2);
    const carrying = round(existing.shares > 0 ? existing.costBasisUsd * (settled / existing.shares) : 0, 2);
    existing.shares -= settled;
    existing.costBasisUsd = round(Math.max(0, existing.costBasisUsd - carrying), 2);
    existing.isDisclosed = existing.shares / issued >= DISCLOSURE_THRESHOLD_PCT;

    const floatHolding = capTable.holdings.find((holding) => holding.securityId === security.id && holding.holderKind === 'public_float');
    if (floatHolding === undefined) {
      capTable.holdings = [
        ...capTable.holdings,
        {
          id: makeId('hld', security.id, 'public_float'),
          holderId: 'public_float',
          holderKind: 'public_float',
          securityId: security.id,
          shares: settled,
          costBasisUsd: proceeds,
          acquiredQuarter: quarter,
          lockupUntilQuarter: null,
          isDisclosed: true,
        },
      ];
    } else {
      floatHolding.shares += settled;
      floatHolding.costBasisUsd = round(floatHolding.costBasisUsd + proceeds, 2);
    }

    const seller = state.companies.find((company) => company.id === holderId) ?? null;
    if (seller !== null) {
      seller.financials.cash = round(seller.financials.cash + proceeds, 2);
      seller.balanceSheet.assets.cash = seller.financials.cash;
      seller.balanceSheet.assets.investments = round(Math.max(0, seller.balanceSheet.assets.investments - carrying), 2);
      // The realised gain or loss lands in equity, so assets - liabilities still
      // equals equity after the trade.
      seller.balanceSheet.equity = round(seller.balanceSheet.equity + (proceeds - carrying), 2);
    }

    capTable.lastUpdatedQuarter = quarter;
    const pctAfter = existing.shares / issued;
    settlements.push({
      action,
      securityId: security.id,
      companyId: security.companyId,
      side: 'sell',
      requestedShares: requested,
      settledShares: settled,
      pricePerShare: price,
      quotePriceUsd: price,
      executionPriceUsd: price,
      impactPct: 0,
      floatShares: settled,
      blockShares: 0,
      considerationUsd: proceeds,
      ownershipPctBefore: round(pctBefore, 6),
      ownershipPctAfter: round(pctAfter, 6),
      crossedThresholds: [],
      rejectionCode: settled < requested ? 'requirement_not_met' : null,
      detail: settled < requested ? 'Sale reduced to the shares the market could absorb.' : 'Settled in full.',
    });
  }

  return settlements;
}

function rejectTrade(action: SubmittedAction, securityId: string, companyId: string, code: string, detail: string): TradeSettlement {
  const side = action.intent.type === 'sell_shares' ? 'sell' : 'buy';
  return {
    action,
    securityId,
    companyId,
    side,
    requestedShares: 0,
    settledShares: 0,
    pricePerShare: 0,
    quotePriceUsd: 0,
    executionPriceUsd: 0,
    impactPct: 0,
    floatShares: 0,
    blockShares: 0,
    considerationUsd: 0,
    ownershipPctBefore: 0,
    ownershipPctAfter: 0,
    crossedThresholds: [],
    rejectionCode: code,
    detail,
  };
}
