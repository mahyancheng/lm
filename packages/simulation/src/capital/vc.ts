/**
 * @frontier/simulation — capital/vc.ts
 *
 * The venture desk: sourcing, term sheets, follow-ons and exits.
 *
 * Four steps, and every one of them is pure:
 *
 * 1. **Score** every eligible company from state alone. No draw.
 * 2. **Threshold** — one whole number. Below it nothing happens at all.
 * 3. **Cap** — two sheets per fund per quarter, a cheque capped twice.
 * 4. **Order** — a `DealProposal`, which is a structure the deal path already
 *    proposes, accepts, rejects, expires and audits. Inventing a parallel offer
 *    pipeline would be the second-worst decision available here.
 *
 * The offer is made in quarter *t* and is answerable only by an action submitted
 * in *t+1*. A fund's offer is never resolved in the quarter it is made, and that
 * delay is exactly what makes the offers inbox a decision rather than a
 * notification.
 */

import type { CapitalEntity, Company, DealObligation, DealProposal, FundingStage, SessionState } from '@frontier/contracts';
import {
  CAPITAL_ENTITY_MEMORY_LIMIT,
  LP_PRESSURE_SELLING_FLOOR,
  VC_PRICE_STRETCH_PCT,
  VC_REOFFER_COOLDOWN_QUARTERS,
  VC_TERM_SHEETS_PER_QUARTER,
  VC_TERM_SHEET_FLOOR,
  lpPressureFor,
  makeId,
} from '@frontier/contracts';
import { clampInt, compactUsd, deployableUsd, estimatedValuationUsd, onCooldown, remember, stakeFractionOf, type DeskContext } from './context';
import { maxChequeUsd } from './leads';
import { nextStageFor, sourcingScore } from './scores';

/* -------------------------------------------------------------------------- */
/*  Terms                                                                      */
/* -------------------------------------------------------------------------- */

/** Everything on the offer card, every figure of it computed by the engine. */
export interface TermSheetTerms {
  readonly stage: FundingStage;
  readonly amountUsd: number;
  readonly preMoneyUsd: number;
  readonly dilutionPct: number;
  readonly boardSeats: number;
  readonly proRata: boolean;
  readonly protectiveProvisions: boolean;
  readonly score: number;
}

const PRO_RATA_FROM_STAGE: ReadonlySet<FundingStage> = new Set<FundingStage>(['series_a', 'series_b', 'series_c', 'series_d', 'series_e', 'growth']);

/**
 * Price the sheet.
 *
 * One economic dial — the price — and one control dial — the board seat. The
 * liquidation preference is held constant at 1x non-participating, which is the
 * ordinary outcome and is what leaves a phone-sized card with two numbers on it
 * instead of six.
 */
export function termSheetTerms(desk: DeskContext, entity: CapitalEntity, company: Company, stage: FundingStage, score: number): TermSheetTerms | null {
  const cheque = maxChequeUsd(entity, stage);
  if (cheque <= 0) return null;

  // 0.70x at the floor, 1.60x at a perfect score. A fund that loves the company
  // pays up for it, and the card shows the player why.
  const stretch = clampInt(((score - VC_TERM_SHEET_FLOOR) * VC_PRICE_STRETCH_PCT) / Math.max(1, 100 - VC_TERM_SHEET_FLOOR), -30, VC_PRICE_STRETCH_PCT);
  const multiplier = Math.min(1.6, Math.max(0.7, 1 + stretch / 100));
  const preMoney = Math.max(1_000_000, Math.round(estimatedValuationUsd(desk, company) * multiplier));
  const dilutionPct = clampInt((100 * cheque) / (preMoney + cheque), 0, 100);

  return {
    stage,
    amountUsd: cheque,
    preMoneyUsd: preMoney,
    dilutionPct,
    // Exactly the rule the capital phase already applies to a requested round.
    boardSeats: dilutionPct >= 15 ? 1 : 0,
    proRata: PRO_RATA_FROM_STAGE.has(stage),
    protectiveProvisions: dilutionPct >= 20,
    score,
  };
}

/** The obligation the deal carries. Read back verbatim when the sheet is accepted. */
export function termSheetObligation(entity: CapitalEntity, company: Company, terms: TermSheetTerms): DealObligation {
  return {
    kind: 'term_sheet',
    entityId: entity.id,
    companyId: company.id,
    stage: terms.stage,
    amountUsd: terms.amountUsd,
    preMoneyUsd: terms.preMoneyUsd,
    dilutionPct: terms.dilutionPct,
    boardSeats: terms.boardSeats,
    proRata: terms.proRata,
    protectiveProvisions: terms.protectiveProvisions,
    liquidationPreferenceMultiple: 1,
    participating: false,
  };
}

/** The term sheet obligation on a deal, or null when it is not one. */
export function termSheetOf(deal: DealProposal): Extract<DealObligation, { kind: 'term_sheet' }> | null {
  for (const obligation of [...deal.gives, ...deal.gets]) {
    if (obligation.kind === 'term_sheet') return obligation;
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/*  The desk                                                                   */
/* -------------------------------------------------------------------------- */

/** A company a venture fund may write a primary cheque into. */
function fundable(company: Company): boolean {
  return company.isActive && !company.isPublic;
}

/**
 * Run one venture fund's sourcing for the quarter.
 *
 * Returns the number of budget rows consumed. Nothing at all happens below the
 * threshold, and an exhausted budget stops the fund cleanly rather than
 * half-writing an offer.
 */
export function runVentureDesk(desk: DeskContext, entity: CapitalEntity): number {
  const { draft, ctx, quarter } = desk;
  const lpPressure = lpPressureFor(entity, quarter);
  // A fund past the selling floor is harvesting, not deploying. Its LPs are
  // counting cash, and a new position is the opposite of cash.
  if (lpPressure >= LP_PRESSURE_SELLING_FLOOR) return 0;
  if (deployableUsd(entity) <= 0) return 0;

  const scored: { company: Company; stage: FundingStage; score: number }[] = [];
  for (const company of draft.companies) {
    if (!fundable(company)) continue;
    if (onCooldown(entity, company.id, 'term_sheet_offered', VC_REOFFER_COOLDOWN_QUARTERS, quarter)) continue;
    // One live offer at a time. A second sheet into an unanswered one is not
    // eagerness, it is a bug the player would read as noise.
    if (hasLiveOffer(draft, entity, company)) continue;
    const stage = nextStageFor(draft, company);
    const score = sourcingScore(desk, entity, company, stage);
    if (score < VC_TERM_SHEET_FLOOR) continue;
    scored.push({ company, stage, score });
  }
  if (scored.length === 0) return 0;

  // Highest score first; ties by company id, which is the tie-break every other
  // ordering in this engine uses.
  scored.sort((a, b) => (b.score !== a.score ? b.score - a.score : a.company.id < b.company.id ? -1 : 1));

  let written = 0;
  for (const candidate of scored) {
    if (written >= VC_TERM_SHEETS_PER_QUARTER) break;
    const terms = termSheetTerms(desk, entity, candidate.company, candidate.stage, candidate.score);
    if (terms === null) continue;
    if (!desk.budget.take()) break;
    offerTermSheet(desk, entity, candidate.company, terms);
    written += 1;
  }

  // A follow-on is the same verb with a different reason: the fund already holds
  // and the company is still growing, so it takes its pro-rata rather than
  // letting the position be diluted by somebody else's money.
  return written;
}

/** True when this fund already has an unanswered sheet in front of this company. */
function hasLiveOffer(draft: SessionState, entity: CapitalEntity, company: Company): boolean {
  return draft.deals.some((deal) => {
    if (deal.status !== 'proposed' || deal.counterpartyId !== company.id) return false;
    const sheet = termSheetOf(deal);
    return sheet !== null && sheet.entityId === entity.id;
  });
}

/**
 * Write the sheet into `deals`.
 *
 * The proposer is the **partner**, not the institution: `DEAL_PARTY_KINDS` is
 * player, company and character, and the person is the right party anyway —
 * relationships, memory and every negotiation the player will have attach to
 * Helena Ward, not to a string beginning `fund_`. The institution is named on
 * the obligation, which is where the money actually is.
 */
function offerTermSheet(desk: DeskContext, entity: CapitalEntity, company: Company, terms: TermSheetTerms): void {
  const { draft, ctx, quarter } = desk;
  const partnerId = entity.partnerCharacterIds[0] ?? entity.id;
  const id = makeId('deal', entity.id, company.id, quarter, 'term_sheet');
  if (draft.deals.some((deal) => deal.id === id)) return;

  const proposal: DealProposal = {
    id,
    proposerId: partnerId,
    proposerKind: 'character',
    counterpartyId: company.id,
    counterpartyKind: 'company',
    gives: [termSheetObligation(entity, company, terms)],
    gets: [],
    confidentiality: 'private',
    // Offered in t, answerable in t+1, lapses at the end of t+1. The delay is
    // the design, not a limitation.
    expiresQuarter: quarter + 1,
    binding: true,
    intentStatements: [
      `${entity.name} intends to support the next round on its pro-rata, subject to the business performing.`,
    ],
    summary: `${entity.name} offers ${compactUsd(terms.amountUsd)} at a ${compactUsd(terms.preMoneyUsd)} pre-money for ${terms.dilutionPct}% of ${company.name}${
      terms.boardSeats > 0 ? `, taking ${terms.boardSeats} board seat` : ', taking no board seat'
    }. 1x non-participating preference${terms.proRata ? ', pro-rata rights' : ''}${terms.protectiveProvisions ? ', protective provisions' : ''}.`,
    status: 'proposed',
    createdQuarter: quarter,
    respondedQuarter: null,
    conversationId: null,
    breachedByPartyId: null,
  };
  draft.deals.push(proposal);

  const eventId = ctx.emit({
    sessionId: draft.sessionId,
    quarter,
    type: 'deal_proposed',
    actorId: partnerId,
    targetId: company.id,
    payload: {
      dealId: id,
      dealKind: 'term_sheet',
      entityId: entity.id,
      stage: terms.stage,
      amountUsd: terms.amountUsd,
      preMoneyUsd: terms.preMoneyUsd,
      dilutionPct: terms.dilutionPct,
      boardSeats: terms.boardSeats,
      sourcingScore: terms.score,
      answerableFromQuarter: quarter + 1,
    },
    // A term sheet is a private offer until it is accepted. The company sees it;
    // the market does not.
    visibility: 'company',
  });
  ctx.log({
    phase: 'action_collection',
    text: `${entity.name} put a ${terms.stage.replace(/_/g, ' ')} term sheet to ${company.name}: ${compactUsd(terms.amountUsd)} at ${compactUsd(
      terms.preMoneyUsd,
    )} pre, for ${terms.dilutionPct}%.`,
    deltaLabel: `${terms.dilutionPct}%`,
    refEventIds: [eventId],
    tone: 'positive',
    subjectId: company.id,
  });

  remember(entity, { companyId: company.id, kind: 'term_sheet_offered', quarter, outcome: 'pending', note: `${terms.dilutionPct}% at ${compactUsd(terms.preMoneyUsd)} pre` }, CAPITAL_ENTITY_MEMORY_LIMIT);
}

/* -------------------------------------------------------------------------- */
/*  How a rival answers                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Whether a company nobody is playing accepts the sheet.
 *
 * Deterministic, from the company's own posture and runway — the same inputs its
 * strategist would reason from. A company that cannot see two years of runway
 * takes the money; a growth posture takes money it does not strictly need; a
 * company in harvest turns down dilution it has no use for.
 */
export function rivalAcceptsTermSheet(desk: DeskContext, company: Company, dilutionPct: number): boolean {
  const metrics = desk.metricsOf(company.id);
  const runway = metrics?.runwayQuarters ?? 40;
  if (runway < 8) return true;
  if (dilutionPct > 30) return false;
  if (company.posture === 'survival') return true;
  if (company.posture === 'aggressive_growth' || company.posture === 'land_grab') return dilutionPct <= 22;
  return dilutionPct <= 12;
}

/**
 * The partner's standing goal for a company the fund holds.
 *
 * Derived every quarter and never stored, which is what makes it safe to hand to
 * a model: the words can never disagree with the vote, because the vote is
 * decided by the director's traits and the goal is decided by arithmetic.
 */
export function partnerGoalFor(desk: DeskContext, entity: CapitalEntity, company: Company): 'push_growth' | 'push_profitability' | 'push_exit' | 'defend_position' {
  const lpPressure = lpPressureFor(entity, desk.quarter);
  const metrics = desk.metricsOf(company.id);
  if (lpPressure >= 40) return 'push_exit';
  if ((metrics?.runwayQuarters ?? 40) < 6 || (metrics?.operatingMarginPct ?? 0) < 0) return 'push_profitability';
  // Somebody else is buying the same name: the fund stops talking about the exit
  // and starts talking about the register.
  const rivals = (desk.draft.capitalEntities ?? []).filter(
    (other) => other.id !== entity.id && stakeFractionOf(desk.draft, company.id, other.id) >= 0.05,
  );
  if (rivals.length > 0 && (metrics?.revenueGrowthYoY ?? 0) < 0.2) return 'defend_position';
  return 'push_growth';
}
