/**
 * @frontier/simulation — capital/shorts.ts
 *
 * The short ledger: one array, cash-settled, never on the register.
 *
 * The design is decided by a single constraint. `checkOwnershipIntegrity` sums
 * `holdings.shares` per class against `totalIssuedByClass`; a negative holding
 * would either break that sum or force the invariant to special-case a sign, and
 * that invariant is the spine of the game. So **`Holding.shares` stays
 * non-negative and a short is never a holding**: it is a separate exposure that
 * never votes, never counts toward an ownership percentage, and never touches a
 * company's balance sheet.
 *
 * The honest note, stated once: a real short borrows a specific lender's shares
 * and sells them to a real buyer. We do not model the borrow leg — only the
 * *price* of borrowing and the *pressure* of covering, which is where all of the
 * gameplay is. The cost is that short interest never appears on the register;
 * the benefit is that the one invariant everything else rests on is untouched.
 *
 * The quarter runs in this order, and the order is the design:
 *
 * 1. open the quarter's new positions at **this quarter's quote**;
 * 2. mark every position and move the margin with it;
 * 3. charge borrow cost, which rises with utilisation;
 * 4. fire the squeeze — a consequence of a rising price and a crowded short,
 *    never an event draw;
 * 5. force-cover anything through maintenance;
 * 6. cover what the desk asked to cover;
 * 7. publish short interest per instrument.
 */

import type { CapitalEntity, ResolverContext, SessionState, ShortCoverReason, ShortPosition } from '@frontier/contracts';
import {
  SHORT_DISCLOSURE_PCT,
  SHORT_MAINTENANCE_PCT,
  SHORT_MARGIN_PCT,
  SQUEEZE_COVER_SHARE_PCT,
  borrowFeePctFor,
  makeId,
  shortBreachesMaintenance,
  shortHeadroomShares,
  shortInterestPctOf,
  squeezeTriggered,
} from '@frontier/contracts';
import { floatSharesOf, latestQuote, moveDryPowder } from './context';

/** One instrument's short book, as the Markets card and the invariant both read it. */
export interface ShortInterestSnapshot {
  readonly instrumentId: string;
  readonly companyId: string;
  readonly shortInterestPct: number;
  readonly borrowFeePctPerQuarter: number;
  readonly disclosedEntityIds: string[];
  readonly squeezeFired: boolean;
  readonly forcedCoverShares: number;
  readonly causeEventId: string | null;
}

/** Float shares behind one instrument, read off the register. */
function floatFor(draft: SessionState, instrumentId: string): number {
  let shares = 0;
  for (const security of draft.securities) {
    if (security.instrumentId !== instrumentId) continue;
    const table = draft.capTables.find((candidate) => candidate.companyId === security.companyId);
    if (table === undefined) continue;
    shares += floatSharesOf(table, security.id);
  }
  return shares;
}

/**
 * Run the whole short phase and return one snapshot per instrument with an open
 * or newly closed book.
 */
export function settleShortBook(draft: SessionState, ctx: ResolverContext): ShortInterestSnapshot[] {
  const entities = new Map((draft.capitalEntities ?? []).map((entity) => [entity.id, entity] as const));
  if (entities.size === 0) return [];

  openNewPositions(draft, ctx, entities);

  const positions = draft.shortPositions ?? [];
  if (positions.length === 0) return [];

  const instruments = [...new Set(positions.map((position) => position.instrumentId))].sort();
  const snapshots: ShortInterestSnapshot[] = [];

  for (const instrumentId of instruments) {
    const floatShares = floatFor(draft, instrumentId);
    const book = (draft.shortPositions ?? []).filter((position) => position.instrumentId === instrumentId);
    if (book.length === 0) continue;
    const companyId = book[0]?.companyId ?? '';
    const quote = latestQuote(draft, instrumentId, ctx.quarter);
    const price = quote?.price ?? book[0]?.markPriceUsd ?? 0;
    if (price <= 0) continue;

    const sharesShort = book.reduce((sum, position) => sum + position.shares, 0);
    const shortInterestPct = shortInterestPctOf(sharesShort, floatShares);
    const borrowFeePct = borrowFeePctFor(shortInterestPct);

    /* --- mark, and move the margin with the mark ------------------------- */
    for (const position of book) {
      const entity = entities.get(position.entityId);
      if (entity === undefined) continue;
      // A short gains when the price falls. The gain accrues to the margin, which
      // is what makes a position that is right able to survive a crowded borrow.
      const pnl = Math.round(position.shares * (position.markPriceUsd - price));
      position.marginPostedUsd = Math.max(0, position.marginPostedUsd + pnl);
      position.markPriceUsd = price;
      position.borrowFeePctPerQuarter = borrowFeePct;
      position.isDisclosed = position.isDisclosed || shortInterestPctOf(position.shares, floatShares) >= SHORT_DISCLOSURE_PCT;
    }

    /* --- borrow cost ------------------------------------------------------ */
    for (const position of book) {
      const entity = entities.get(position.entityId);
      if (entity === undefined) continue;
      const notional = Math.round(position.shares * price);
      const feeUsd = Math.round((notional * borrowFeePct) / 100);
      if (feeUsd <= 0) continue;
      const dryPowderDeltaUsd = moveDryPowder(entity, -feeUsd);
      entity.borrowFeesPaidUsd = Math.round(entity.borrowFeesPaidUsd + Math.abs(dryPowderDeltaUsd));
      ctx.emit({
        sessionId: draft.sessionId,
        quarter: ctx.quarter,
        type: 'borrow_cost_charged',
        actorId: entity.id,
        targetId: instrumentId,
        payload: { entityId: entity.id, instrumentId, notionalUsd: notional, feePct: borrowFeePct, feeUsd: Math.abs(dryPowderDeltaUsd), dryPowderDeltaUsd },
        // The entity's own books. Nobody else's business, and no company's sheet.
        visibility: 'private',
      });
    }

    /* --- the squeeze ------------------------------------------------------ */
    const quarterReturnPct = quote === null ? 0 : Math.round(quote.return * 100);
    const fired = squeezeTriggered(quarterReturnPct, shortInterestPct);
    let forcedCoverShares = 0;
    let squeezeEventId: string | null = null;

    if (fired) {
      const covered: string[] = [];
      for (const position of book.slice().sort((a, b) => (a.id < b.id ? -1 : 1))) {
        const entity = entities.get(position.entityId);
        if (entity === undefined) continue;
        const shares = Math.min(position.shares, Math.ceil((position.shares * SQUEEZE_COVER_SHARE_PCT) / 100));
        if (shares <= 0) continue;
        forcedCoverShares += shares;
        covered.push(entity.id);
        coverPosition(draft, ctx, entity, position, shares, price, 'squeeze', true);
      }
      squeezeEventId = ctx.emit({
        sessionId: draft.sessionId,
        quarter: ctx.quarter,
        type: 'short_squeeze_triggered',
        actorId: null,
        targetId: instrumentId,
        payload: { instrumentId, companyId, returnPct: quarterReturnPct, shortInterestPctBefore: shortInterestPct, forcedCoverShares, entityIds: [...new Set(covered)] },
        visibility: 'public',
      });
      ctx.log({
        phase: 'market_resolution',
        text: `A short squeeze fired in ${instrumentId}: the price ran ${quarterReturnPct}% against ${shortInterestPct}% short interest and ${forcedCoverShares} shares were force-covered.`,
        deltaLabel: `${SQUEEZE_COVER_SHARE_PCT}% covered`,
        refEventIds: [squeezeEventId],
        tone: 'warning',
        subjectId: companyId,
      });
    }

    /* --- maintenance ------------------------------------------------------- */
    for (const position of (draft.shortPositions ?? []).filter((candidate) => candidate.instrumentId === instrumentId)) {
      const entity = entities.get(position.entityId);
      if (entity === undefined) continue;
      if (!shortBreachesMaintenance(position, price)) continue;
      forcedCoverShares += position.shares;
      coverPosition(draft, ctx, entity, position, position.shares, price, 'margin', true);
    }

    /* --- publish ----------------------------------------------------------- */
    const after = (draft.shortPositions ?? []).filter((candidate) => candidate.instrumentId === instrumentId);
    const sharesAfter = after.reduce((sum, position) => sum + position.shares, 0);
    const pctAfter = shortInterestPctOf(sharesAfter, floatShares);
    const feeAfter = borrowFeePctFor(pctAfter);
    const disclosedEntityIds = [...new Set(after.filter((position) => position.isDisclosed).map((position) => position.entityId))].sort();

    const publishedId = ctx.emit({
      sessionId: draft.sessionId,
      quarter: ctx.quarter,
      type: 'short_interest_published',
      actorId: null,
      targetId: instrumentId,
      payload: { instrumentId, companyId, shortInterestPct: pctAfter, before: shortInterestPct, borrowFeePct: feeAfter, holders: disclosedEntityIds },
      visibility: 'public',
    });

    snapshots.push({
      instrumentId,
      companyId,
      shortInterestPct: pctAfter,
      borrowFeePctPerQuarter: feeAfter,
      disclosedEntityIds,
      squeezeFired: fired,
      forcedCoverShares,
      causeEventId: squeezeEventId ?? publishedId,
    });
  }

  // Voluntary covers last, so a desk closing a winner does not shrink the book
  // the squeeze and the borrow fee were struck against.
  applyCoverOrders(draft, ctx, entities);
  return snapshots;
}

/* -------------------------------------------------------------------------- */
/*  Opening                                                                    */
/* -------------------------------------------------------------------------- */

/** Turn this quarter's `short_open` orders into positions, inside the cap. */
function openNewPositions(draft: SessionState, ctx: ResolverContext, entities: ReadonlyMap<string, CapitalEntity>): void {
  for (const order of draft.capitalOrders ?? []) {
    if (order.kind !== 'short_open') continue;
    const entity = entities.get(order.entityId);
    if (entity === undefined) continue;
    const quote = latestQuote(draft, order.instrumentId, ctx.quarter);
    if (quote === null || quote.price <= 0) continue;

    // Re-check the cap against the book as it actually stands: the order was
    // written in phase four and three other desks may have filled it since.
    const floatShares = floatFor(draft, order.instrumentId);
    const alreadyShort = (draft.shortPositions ?? []).filter((position) => position.instrumentId === order.instrumentId).reduce((sum, position) => sum + position.shares, 0);
    const shares = Math.min(order.shares, shortHeadroomShares(alreadyShort, floatShares));
    if (shares <= 0) continue;

    const marginUsd = Math.round((shares * quote.price * SHORT_MARGIN_PCT) / 100);
    if (marginUsd <= 0 || marginUsd > entity.dryPowderUsd) continue;
    const dryPowderDeltaUsd = moveDryPowder(entity, -marginUsd);

    const position: ShortPosition = {
      id: makeId('sht', entity.id, order.instrumentId, ctx.quarter),
      entityId: entity.id,
      securityId: order.securityId,
      instrumentId: order.instrumentId,
      companyId: order.companyId,
      shares,
      openedQuarter: ctx.quarter,
      openPriceUsd: quote.price,
      markPriceUsd: quote.price,
      marginPostedUsd: Math.abs(dryPowderDeltaUsd),
      borrowFeePctPerQuarter: borrowFeePctFor(shortInterestPctOf(alreadyShort + shares, floatShares)),
      isDisclosed: shortInterestPctOf(shares, floatShares) >= SHORT_DISCLOSURE_PCT,
    };
    draft.shortPositions = [...(draft.shortPositions ?? []), position];

    const eventId = ctx.emit({
      sessionId: draft.sessionId,
      quarter: ctx.quarter,
      type: 'short_position_opened',
      actorId: entity.id,
      targetId: order.instrumentId,
      payload: {
        entityId: entity.id,
        instrumentId: order.instrumentId,
        securityId: order.securityId,
        companyId: order.companyId,
        shares,
        priceUsd: Math.round(quote.price * 10_000) / 10_000,
        notionalUsd: Math.round(shares * quote.price),
        shortInterestPctAfter: shortInterestPctOf(alreadyShort + shares, floatShares),
        borrowFeePct: position.borrowFeePctPerQuarter,
        marginPostedUsd: position.marginPostedUsd,
        dryPowderDeltaUsd,
      },
      // Below the disclosure line a short is absent from every projection, never
      // blurred and never summarised.
      visibility: position.isDisclosed ? 'public' : 'private',
    });
    if (position.isDisclosed) {
      ctx.log({
        phase: 'market_resolution',
        text: `${entity.name} disclosed a short of ${shares} shares in ${order.companyId} at ${Math.round(quote.price)} a share.`,
        deltaLabel: `${position.borrowFeePctPerQuarter}%/qtr borrow`,
        refEventIds: [eventId],
        tone: 'warning',
        subjectId: order.companyId,
      });
    }
  }
}

/* -------------------------------------------------------------------------- */
/*  Covering                                                                   */
/* -------------------------------------------------------------------------- */

/** Apply the desk's own `short_cover` orders. */
function applyCoverOrders(draft: SessionState, ctx: ResolverContext, entities: ReadonlyMap<string, CapitalEntity>): void {
  for (const order of draft.capitalOrders ?? []) {
    if (order.kind !== 'short_cover') continue;
    const entity = entities.get(order.entityId);
    const position = (draft.shortPositions ?? []).find((candidate) => candidate.id === order.positionId);
    if (entity === undefined || position === undefined) continue;
    const quote = latestQuote(draft, position.instrumentId, ctx.quarter);
    const price = quote?.price ?? position.markPriceUsd;
    if (price <= 0) continue;
    coverPosition(draft, ctx, entity, position, Math.min(order.shares, position.shares), price, order.reason, false);
  }
}

/**
 * Buy back `shares` of a position, in whole or in part.
 *
 * The realised profit is the fall in price times the shares, and the margin that
 * backed those shares comes home with it. Both go back into dry powder as one
 * declared movement, which is what `capital_integrity` reconstructs from.
 */
export function coverPosition(
  draft: SessionState,
  ctx: ResolverContext,
  entity: CapitalEntity,
  position: ShortPosition,
  shares: number,
  priceUsd: number,
  reason: ShortCoverReason,
  forced: boolean,
): void {
  const covered = Math.max(0, Math.min(shares, position.shares));
  if (covered <= 0) return;

  const share = covered / position.shares;
  const marginReturned = Math.round(position.marginPostedUsd * share);
  const realisedPnlUsd = Math.round(covered * (position.openPriceUsd - priceUsd));

  position.shares -= covered;
  position.marginPostedUsd = Math.max(0, position.marginPostedUsd - marginReturned);
  if (position.shares <= 0) {
    draft.shortPositions = (draft.shortPositions ?? []).filter((candidate) => candidate.id !== position.id);
  }

  // The margin is the fund's own money coming back; the profit is a realised
  // gain, which is DPI. A loss simply returns less than went out.
  const returned = Math.max(0, marginReturned + realisedPnlUsd);
  const dryPowderDeltaUsd = moveDryPowder(entity, returned);
  // Only the profit is a distribution; the margin was always the fund's own money.
  if (realisedPnlUsd > 0) entity.realisedProceedsUsd = Math.round(entity.realisedProceedsUsd + realisedPnlUsd);

  ctx.emit({
    sessionId: draft.sessionId,
    quarter: ctx.quarter,
    type: 'short_position_covered',
    actorId: entity.id,
    targetId: position.instrumentId,
    payload: {
      entityId: entity.id,
      instrumentId: position.instrumentId,
      companyId: position.companyId,
      shares: covered,
      priceUsd: Math.round(priceUsd * 10_000) / 10_000,
      realisedPnlUsd,
      marginReturnedUsd: marginReturned,
      forced,
      reason,
      dryPowderDeltaUsd,
    },
    visibility: position.isDisclosed ? 'public' : 'private',
  });
}

/** Restated at the call site so the maintenance bound is visible where it bites. */
export const MAINTENANCE_PCT = SHORT_MAINTENANCE_PCT;
