/**
 * @frontier/simulation — capital/pe.ts
 *
 * The buyout desk: targeting, the approach ladder, leverage, the squeeze and the
 * roll-up.
 *
 * The important thing about this file is how little of it is new. Wave 3 built a
 * hostile-takeover system for other reasons and nobody had pointed a fund at it:
 * control already flips at 50% + 1 in the board tally, the last tranche of a
 * float already costs twice the quote, a named institutional block is already
 * reachable at a premium, and dividends, tolls and antitrust exposure already
 * exist. **No new takeover verb is added here.** What is added is somebody who
 * wants to use them.
 *
 * The ladder is three rungs and each is a quarter long, so the player watches it
 * happen rather than being told it happened:
 *
 * | rung | what it is | what the player sees |
 * |---|---|---|
 * | `private_approach` | a confidential deal proposal | an offer in the inbox |
 * | `bear_hug` | the same offer, made public, premium bumped | a headline, and a floor under the price |
 * | `tender` | accumulation toward 50% + 1 in the open market | a stake bar climbing, quarter by quarter |
 */

import type { ActionIntent, CapitalEntity, CapitalOrder, Company, DealObligation, DealProposal, SessionState, SubmittedAction } from '@frontier/contracts';
import {
  BEAR_HUG_BUMP_PCT,
  blockExecutionPriceUsd,
  CAPITAL_ENTITY_MEMORY_LIMIT,
  CONTROL_DECISIVE_PCT,
  LBO_DEBT_TO_REVENUE_PCT,
  LBO_SPREAD_PCT,
  PE_APPROACH_FLOOR,
  PE_CONTROL_PREMIUM_PCT,
  PE_MAX_PREMIUM_PCT,
  PE_MIN_REVENUE_USD,
  PE_REAPPROACH_COOLDOWN_QUARTERS,
  PE_SQUEEZE_LAYOFF_PCT,
  PE_SQUEEZE_QUARTERS,
  RECAP_DEBT_TO_REVENUE_PCT,
  RECAP_PAYOUT_PCT,
  SOVEREIGN_CHARTER_CAP_PCT,
  WHITE_KNIGHT_BUMP_PCT,
  makeId,
} from '@frontier/contracts';
import { clampInt, compactUsd, deployableUsd, lastActQuarter, onCooldown, remember, stakeFractionOf, type DeskContext } from './context';
import { targetScore } from './scores';

/** The buyout obligation on a deal, or null when it is not one. */
export function buyoutOf(deal: DealProposal): Extract<DealObligation, { kind: 'buyout_offer' }> | null {
  for (const obligation of [...deal.gives, ...deal.gets]) {
    if (obligation.kind === 'buyout_offer') return obligation;
  }
  return null;
}

/** Every live approach in the session, newest state first. */
export function liveApproaches(draft: SessionState): { deal: DealProposal; offer: Extract<DealObligation, { kind: 'buyout_offer' }> }[] {
  const out: { deal: DealProposal; offer: Extract<DealObligation, { kind: 'buyout_offer' }> }[] = [];
  for (const deal of draft.deals) {
    if (deal.status !== 'proposed' && deal.status !== 'accepted') continue;
    const offer = buyoutOf(deal);
    if (offer !== null) out.push({ deal, offer });
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/*  Pricing an offer                                                           */
/* -------------------------------------------------------------------------- */

/** The reference the premium is struck against: the higher of the tape and the anchor. */
export function offerReferenceUsd(desk: DeskContext, company: Company): number {
  const marketCap = desk.metricsOf(company.id)?.marketCapUsd ?? 0;
  const anchor = desk.anchorOf(company.id)?.anchorValueUsd ?? 0;
  return Math.max(1, Math.round(Math.max(marketCap, anchor)));
}

/** Offer value at a whole-percentage premium over the reference. */
export function offerValueAt(referenceUsd: number, premiumPct: number): number {
  return Math.round((referenceUsd * (100 + premiumPct)) / 100);
}

/**
 * How the deal is financed: debt on the target, equity from the sponsor.
 *
 * Two caps, and the second is the one that matters. Debt may not exceed the
 * borrower's trailing revenue — the mapping from the real world's roughly 5.5x
 * EBITDA at the margins world 2's mature companies carry — and it may never
 * exceed the borrower's own net assets, which is the ratio that turns leverage
 * from an exploit into a number the sponsor has to grow.
 */
export function lboFinancing(desk: DeskContext, company: Company, offerValueUsd: number): { debtUsd: number; equityUsd: number } {
  const revenueTtm = desk.metricsOf(company.id)?.revenueTtm ?? company.financials.revenueQuarterly * 4;
  const assets = company.balanceSheet.assets;
  const liabilities = company.balanceSheet.liabilities;
  const netAssets =
    assets.cash + assets.ppe + assets.goodwill + assets.investments + assets.receivables - liabilities.debt - liabilities.payables - liabilities.deferredRevenue;

  const byRevenue = Math.round((Math.max(0, revenueTtm) * LBO_DEBT_TO_REVENUE_PCT) / 100);
  const debtUsd = Math.max(0, Math.min(byRevenue, Math.round(Math.max(0, netAssets)), Math.round(offerValueUsd)));
  return { debtUsd, equityUsd: Math.max(0, Math.round(offerValueUsd) - debtUsd) };
}

/**
 * What the sponsor must actually spend to become decisive.
 *
 * A note on the difference between this and `equityChequeUsd`, because they are
 * both real and they are not the same number. The **offer** is quoted on the
 * whole company at a premium, and `offerValue - newDebt` is the equity value of
 * that offer: that is the figure the design specifies and the figure the offer
 * card shows, because it is what a board is being asked to accept.
 *
 * But nothing in this engine ever writes a cheque for a hundred per cent of a
 * company. A sponsor gets control the way Wave 3 built it — by accumulating
 * through the market toward 50% + 1, paying the convex float price and the block
 * premium as it goes — so what it must be *able to fund* is the stake it does
 * not already own. Gating the approach on the whole-company figure would mean no
 * sponsor in the roster could ever approach anybody, which would leave the
 * mechanism unreachable while looking as though it were implemented.
 */
export function controlCostUsd(desk: DeskContext, entity: CapitalEntity, company: Company): number {
  const quote = desk.lastQuoteOf(company);
  const table = desk.capTableOf(company.id);
  if (quote === null || quote.price <= 0 || table === null) return Number.POSITIVE_INFINITY;
  let issued = 0;
  for (const klass of table.shareClasses) issued += klass.issuedShares;
  if (issued <= 0) return Number.POSITIVE_INFINITY;
  const held = stakeFractionOf(desk.draft, company.id, entity.id);
  const needed = Math.max(0, (CONTROL_DECISIVE_PCT + 0.01 - held) * issued);
  // The last tranche costs more than the first, whether it comes out of the
  // float or out of somebody's block. `CONTROL_ACCUMULATION_PREMIUM` is the
  // blended multiple that accumulation actually pays, and it is deliberately
  // conservative: an approach the sponsor cannot finish is worse than none.
  return Math.round(needed * quote.price * CONTROL_ACCUMULATION_PREMIUM);
}

/** The blended multiple of the quote a run to control pays across float and blocks. */
export const CONTROL_ACCUMULATION_PREMIUM = 1.5;

/* -------------------------------------------------------------------------- */
/*  The desk                                                                   */
/* -------------------------------------------------------------------------- */

/** A company a sponsor could take control of: listed, active, and big enough to matter. */
function approachable(desk: DeskContext, company: Company): boolean {
  if (!company.isActive || !company.isPublic) return false;
  const revenueTtm = desk.metricsOf(company.id)?.revenueTtm ?? company.financials.revenueQuarterly * 4;
  return revenueTtm >= PE_MIN_REVENUE_USD;
}

/**
 * Run one buyout fund's quarter: escalate what is already running, then open at
 * most one new approach.
 *
 * Returns the number of budget rows consumed.
 */
export function runBuyoutDesk(desk: DeskContext, entity: CapitalEntity): number {
  let used = escalateApproaches(desk, entity);
  used += openApproach(desk, entity);
  return used;
}

/** Move every standing approach of this fund one rung up the ladder. */
function escalateApproaches(desk: DeskContext, entity: CapitalEntity): number {
  const { draft, ctx, quarter } = desk;
  let used = 0;

  for (const { deal, offer } of liveApproaches(draft)) {
    if (offer.entityId !== entity.id) continue;
    if (deal.createdQuarter >= quarter) continue; // opened this quarter; it answers next
    const company = desk.companyOf(offer.targetCompanyId);
    if (company === null || !company.isActive) continue;

    if (offer.stage === 'private_approach') {
      if (deal.status !== 'proposed') continue;
      if (!desk.budget.take()) return used;
      used += 1;
      // The same offer, made public and bumped. The share price gets a floor
      // under it and the board starts getting letters.
      const premiumPct = clampInt(offer.premiumPct + BEAR_HUG_BUMP_PCT, 0, PE_MAX_PREMIUM_PCT);
      const reference = offerReferenceUsd(desk, company);
      const offerValueUsd = offerValueAt(reference, premiumPct);
      const { debtUsd, equityUsd } = lboFinancing(desk, company, offerValueUsd);
      mutateOffer(deal, { ...offer, stage: 'bear_hug', premiumPct, offerValueUsd, lboDebtUsd: debtUsd, equityChequeUsd: equityUsd });
      deal.confidentiality = 'public';

      const eventId = ctx.emit({
        sessionId: draft.sessionId,
        quarter,
        type: 'deal_proposed',
        actorId: entity.partnerCharacterIds[0] ?? entity.id,
        targetId: company.id,
        payload: {
          dealId: deal.id,
          dealKind: 'buyout_approach',
          entityId: entity.id,
          stage: 'bear_hug',
          premiumPct,
          offerValueUsd,
          lboDebtUsd: debtUsd,
          equityChequeUsd: equityUsd,
        },
        visibility: 'public',
      });
      ctx.log({
        phase: 'action_collection',
        text: `${entity.name} took its offer for ${company.name} public at ${compactUsd(offerValueUsd)} — a ${premiumPct}% premium.`,
        deltaLabel: `+${premiumPct}%`,
        refEventIds: [eventId],
        tone: 'warning',
        subjectId: company.id,
      });
      continue;
    }

    if (offer.stage === 'bear_hug' && deal.status === 'proposed') {
      if (!desk.budget.take()) return used;
      used += 1;
      mutateOffer(deal, { ...offer, stage: 'tender' });
      // A tender is not an offer waiting for an answer; it is an accumulation
      // in the open market, and it needs quarters to run. Without extending the
      // window here the offer lapses one quarter after going hostile and the
      // stake bar the player is watching simply stops, which reads as a bug
      // rather than as a retreat. Bounded by the re-approach cooldown, so a
      // sponsor that cannot finish the run gives up rather than grinding on.
      deal.expiresQuarter = quarter + PE_REAPPROACH_COOLDOWN_QUARTERS;
      const eventId = ctx.emit({
        sessionId: draft.sessionId,
        quarter,
        type: 'deal_proposed',
        actorId: entity.partnerCharacterIds[0] ?? entity.id,
        targetId: company.id,
        payload: { dealId: deal.id, dealKind: 'buyout_approach', entityId: entity.id, stage: 'tender', premiumPct: offer.premiumPct, offerValueUsd: offer.offerValueUsd },
        visibility: 'public',
      });
      ctx.log({
        phase: 'action_collection',
        text: `${entity.name} went hostile on ${company.name}: the offer is now a tender in the open market.`,
        deltaLabel: 'tender',
        refEventIds: [eventId],
        tone: 'negative',
        subjectId: company.id,
      });
    }
  }

  return used;
}

/** Open at most one new approach, against the highest-scoring eligible target. */
function openApproach(desk: DeskContext, entity: CapitalEntity): number {
  const { draft, ctx, quarter } = desk;
  if (deployableUsd(entity) <= 0) return 0;
  // One live approach at a time. A sponsor running three hostile bids at once is
  // not a sponsor, it is a bug.
  if (liveApproaches(draft).some(({ offer }) => offer.entityId === entity.id)) return 0;

  let best: { company: Company; score: number } | null = null;
  for (const company of draft.companies) {
    if (!approachable(desk, company)) continue;
    if (onCooldown(entity, company.id, 'approach_made', PE_REAPPROACH_COOLDOWN_QUARTERS, quarter)) continue;
    const score = targetScore(desk, entity, company, PE_MIN_REVENUE_USD);
    if (score < PE_APPROACH_FLOOR) continue;
    if (best === null || score > best.score || (score === best.score && company.id < best.company.id)) best = { company, score };
  }
  if (best === null) return 0;

  const reference = offerReferenceUsd(desk, best.company);
  const offerValueUsd = offerValueAt(reference, PE_CONTROL_PREMIUM_PCT);
  const { debtUsd, equityUsd } = lboFinancing(desk, best.company, offerValueUsd);
  // The sponsor's own money has to be there for the stake it will actually buy.
  // Levering the target does not excuse a fund from funding that out of dry
  // powder, and a fund that cannot finish the run does not start it.
  if (controlCostUsd(desk, entity, best.company) > deployableUsd(entity)) return 0;
  if (!desk.budget.take()) return 0;

  const partnerId = entity.partnerCharacterIds[0] ?? entity.id;
  const id = makeId('deal', entity.id, best.company.id, quarter, 'buyout');
  if (draft.deals.some((deal) => deal.id === id)) return 0;

  const offer: DealObligation = {
    kind: 'buyout_offer',
    entityId: entity.id,
    targetCompanyId: best.company.id,
    offerValueUsd,
    premiumPct: PE_CONTROL_PREMIUM_PCT,
    stage: 'private_approach',
    lboDebtUsd: debtUsd,
    equityChequeUsd: equityUsd,
  };
  draft.deals.push({
    id,
    proposerId: partnerId,
    proposerKind: 'character',
    counterpartyId: best.company.id,
    counterpartyKind: 'company',
    gives: [offer],
    gets: [],
    confidentiality: 'private',
    expiresQuarter: quarter + 3,
    binding: true,
    intentStatements: [`${entity.name} would prefer to agree this privately and will not be deterred by a refusal.`],
    summary: `${entity.name} offers ${compactUsd(offerValueUsd)} for ${best.company.name}, a ${PE_CONTROL_PREMIUM_PCT}% premium, funded with ${compactUsd(
      debtUsd,
    )} of debt placed on the business and ${compactUsd(equityUsd)} of its own equity.`,
    status: 'proposed',
    createdQuarter: quarter,
    respondedQuarter: null,
    conversationId: null,
    breachedByPartyId: null,
  });

  const eventId = ctx.emit({
    sessionId: draft.sessionId,
    quarter,
    type: 'deal_proposed',
    actorId: partnerId,
    targetId: best.company.id,
    payload: {
      dealId: id,
      dealKind: 'buyout_approach',
      entityId: entity.id,
      stage: 'private_approach',
      premiumPct: PE_CONTROL_PREMIUM_PCT,
      offerValueUsd,
      lboDebtUsd: debtUsd,
      equityChequeUsd: equityUsd,
      targetScore: best.score,
      answerableFromQuarter: quarter + 1,
    },
    visibility: 'company',
  });
  ctx.log({
    phase: 'action_collection',
    text: `${entity.name} approached ${best.company.name} privately at ${compactUsd(offerValueUsd)}, a ${PE_CONTROL_PREMIUM_PCT}% premium.`,
    deltaLabel: `+${PE_CONTROL_PREMIUM_PCT}%`,
    refEventIds: [eventId],
    tone: 'warning',
    subjectId: best.company.id,
  });

  remember(entity, { companyId: best.company.id, kind: 'approach_made', quarter, outcome: 'pending', note: `${PE_CONTROL_PREMIUM_PCT}% premium approach` }, CAPITAL_ENTITY_MEMORY_LIMIT);
  return 1;
}

/** Replace the buyout obligation on a deal in place, keeping the deal's identity. */
function mutateOffer(deal: DealProposal, next: Extract<DealObligation, { kind: 'buyout_offer' }>): void {
  deal.gives = deal.gives.map((obligation) => (obligation.kind === 'buyout_offer' ? next : obligation));
  deal.gets = deal.gets.map((obligation) => (obligation.kind === 'buyout_offer' ? next : obligation));
}

/* -------------------------------------------------------------------------- */
/*  Accumulation toward control                                                */
/* -------------------------------------------------------------------------- */

/**
 * The buy orders a tender writes.
 *
 * Sizing is left to the order settlement, which applies the same three caps
 * every hedge position faces plus the convex float pricing and the block
 * premium — a raider pays for haste exactly as anyone else does.
 */
export function tenderOrders(desk: DeskContext, entity: CapitalEntity): CapitalOrder[] {
  const { draft, quarter } = desk;
  const orders: CapitalOrder[] = [];

  for (const { deal, offer } of liveApproaches(draft)) {
    if (offer.entityId !== entity.id || offer.stage !== 'tender') continue;
    const company = desk.companyOf(offer.targetCompanyId);
    if (company === null || !company.isActive) continue;
    const security = desk.primarySecurityOf(company.id);
    const table = desk.capTableOf(company.id);
    if (security === null || table === null) continue;

    const held = stakeFractionOf(draft, company.id, entity.id);
    if (held > CONTROL_DECISIVE_PCT) continue; // already decisive; nothing left to buy
    const quote = desk.lastQuoteOf(company);
    if (quote === null || quote.price <= 0) continue;

    let issued = 0;
    for (const klass of table.shareClasses) issued += klass.issuedShares;
    const wanted = Math.max(0, Math.ceil((CONTROL_DECISIVE_PCT + 0.01 - held) * issued));
    if (wanted <= 0) continue;

    // Progress keeps the tender alive. A run to control takes quarters — the
    // market absorbs what it absorbs — and a fixed clock would lapse the offer
    // one quarter short of the line with the stake bar still climbing, which
    // reads as the engine losing interest. A sponsor that can no longer buy
    // writes no order, is not extended, and lapses within the cooldown.
    deal.expiresQuarter = quarter + PE_REAPPROACH_COOLDOWN_QUARTERS;
    orders.push({
      id: makeId('cord', entity.id, company.id, quarter, 'tender'),
      entityId: entity.id,
      quarter,
      kind: 'buy',
      securityId: security.id,
      companyId: company.id,
      shares: wanted,
      // A tender is priced to reach the **named holders**, not just the float,
      // and a block costs flat double the quote. A limit struck at the offer
      // premium would put every institutional block permanently out of reach and
      // leave a raider grinding through the float for ever — which is precisely
      // the negotiation the block premium exists to force. So the limit is the
      // block price: the sponsor says out loud that it will pay double for a
      // decisive stake, and the convex float pricing stops it overpaying on a
      // thin register anyway.
      limitPriceUsd: blockExecutionPriceUsd(quote.price),
      reason: 'tender',
    });
  }

  return orders;
}

/* -------------------------------------------------------------------------- */
/*  What a sponsor does with a company it controls                             */
/* -------------------------------------------------------------------------- */

/** Companies this entity is decisive on. The order is cap-table order, which is stable. */
export function controlledCompanies(desk: DeskContext, entity: CapitalEntity): Company[] {
  const out: Company[] = [];
  for (const company of desk.draft.companies) {
    if (!company.isActive) continue;
    // The sovereign charter forbids control outright, so it never appears here
    // however large its stake grows.
    if (entity.kind === 'sovereign') continue;
    if (stakeFractionOf(desk.draft, company.id, entity.id) > CONTROL_DECISIVE_PCT) out.push(company);
  }
  return out;
}

/**
 * The ordinary actions a controlling sponsor writes into its portfolio company.
 *
 * Not one line of new economics: morale, attrition and the price-rise churn
 * penalty already punish a squeeze, so it is a real trade rather than free
 * margin — and a rival the player watches being squeezed is a rival whose
 * customers become available.
 */
export function sponsorPortfolioActions(desk: DeskContext, entity: CapitalEntity, company: Company): ActionIntent[] {
  const intents: ActionIntent[] = [];
  const controlSince = lastActQuarter(entity, company.id, 'approach_made');
  const squeezing = controlSince !== null && desk.quarter - controlSince <= PE_SQUEEZE_QUARTERS;
  const metrics = desk.metricsOf(company.id);
  const revenueTtm = metrics?.revenueTtm ?? company.financials.revenueQuarterly * 4;

  if (squeezing) {
    const engineers = company.employees.engineers;
    const cut = Math.floor((engineers * PE_SQUEEZE_LAYOFF_PCT) / 100);
    if (cut > 0) intents.push({ type: 'layoff', role: 'engineers', count: cut, severanceQuartersOfPay: 0.5 });
    const marketing = Math.round(company.financials.marketing * 0.6);
    if (marketing > 0) intents.push({ type: 'set_marketing_budget', allocations: [{ segment: 'enterprise', budgetUsd: marketing }] });
    const product = company.products.find((candidate) => candidate.isActive);
    if (product !== undefined) intents.push({ type: 'set_product_price', productId: product.id, pricePerSeatUsd: Math.round(product.pricePerSeat * 1.05) });
  }

  // The dividend recap: lever a business that is not levered, and pay the sponsor
  // back out of its own cash flow. Both halves are existing verbs, so both halves
  // land on rows the equity reconstruction already reads.
  if (company.financials.debt < revenueTtm && company.financials.revenueQuarterly > 0) {
    const newDebt = Math.round((revenueTtm * RECAP_DEBT_TO_REVENUE_PCT) / 100);
    if (newDebt > 0) {
      intents.push({ type: 'issue_debt', amountUsd: newDebt, maxRatePct: 0.25, termQuarters: 20 });
      intents.push({ type: 'set_dividend_policy', payoutPct: RECAP_PAYOUT_PCT });
    }
  }

  return intents;
}

/**
 * The roll-up: two companies in one sector under one sponsor become one.
 *
 * Through the existing acquisition path, so every completion appends to
 * `recentAcquisitionQuarters` and feeds `antitrustExposure`. The brake was wired
 * before this accelerator was built.
 */
export function rollUpAction(desk: DeskContext, entity: CapitalEntity): { acquirer: Company; intent: ActionIntent } | null {
  const controlled = controlledCompanies(desk, entity);
  if (controlled.length < 2) return null;

  const bySector = new Map<string, Company[]>();
  for (const company of controlled) {
    const bucket = bySector.get(company.sectorId);
    if (bucket === undefined) bySector.set(company.sectorId, [company]);
    else bucket.push(company);
  }

  for (const sectorId of [...bySector.keys()].sort()) {
    const group = (bySector.get(sectorId) ?? []).slice().sort((a, b) => {
      const av = desk.metricsOf(a.id)?.enterpriseValueUsd ?? 0;
      const bv = desk.metricsOf(b.id)?.enterpriseValueUsd ?? 0;
      return bv !== av ? bv - av : a.id < b.id ? -1 : 1;
    });
    const acquirer = group[0];
    const target = group[1];
    if (acquirer === undefined || target === undefined) continue;
    const offerValueUsd = Math.max(1, Math.round(desk.metricsOf(target.id)?.enterpriseValueUsd ?? 0));
    if (offerValueUsd <= 0 || acquirer.financials.cash < offerValueUsd) continue;
    return { acquirer, intent: { type: 'acquire_company', targetCompanyId: target.id, offerValueUsd, cashPct: 1, stockPct: 0 } };
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/*  Defences                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Whether a rival fund accepts an invitation to play white knight.
 *
 * Deterministic, and generous on purpose: the player still loses the company,
 * but to somebody who will treat them better, which is the only defence in the
 * set that leaves the business intact.
 */
export function whiteKnightAccepts(desk: DeskContext, rescuer: CapitalEntity, company: Company, standingOfferUsd: number): boolean {
  if (rescuer.kind !== 'pe' && rescuer.kind !== 'sovereign') return false;
  if (targetScore(desk, rescuer, company, PE_MIN_REVENUE_USD) < PE_APPROACH_FLOOR - 10) return false;
  const counterUsd = Math.round((standingOfferUsd * (100 + WHITE_KNIGHT_BUMP_PCT)) / 100);
  const { equityUsd } = lboFinancing(desk, company, counterUsd);
  // A sovereign may bid, but its charter stops it above a quarter of the
  // register, so it can only ever be a friendly minority — which is a defence in
  // its own right and is why it is allowed here.
  if (rescuer.kind === 'sovereign' && stakeFractionOf(desk.draft, company.id, rescuer.id) * 100 >= SOVEREIGN_CHARTER_CAP_PCT) return false;
  return equityUsd <= deployableUsd(rescuer);
}

/** The coupon an LBO's debt clears at: the borrower's own rate plus the sponsor spread. */
export function lboRateFor(baseRate: number): number {
  return baseRate + LBO_SPREAD_PCT / 100;
}

/** Sponsor actions are ordinary submitted actions with an origin that says who wrote them. */
export function sponsorAction(draft: SessionState, quarter: number, sequence: number, company: Company, entity: CapitalEntity, index: number, intent: ActionIntent): SubmittedAction {
  return {
    actionId: makeId('act', draft.sessionId, quarter, 'sponsor', entity.id, company.id, index),
    sessionId: draft.sessionId,
    quarter,
    sequence,
    actorPlayerId: null,
    actorCompanyId: company.id,
    actorCharacterId: company.ceoCharacterId ?? entity.partnerCharacterIds[0] ?? entity.id,
    origin: 'sponsor',
    intent,
    confirmedByHuman: false,
  };
}
