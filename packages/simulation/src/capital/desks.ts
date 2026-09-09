/**
 * @frontier/simulation — capital/desks.ts
 *
 * The `CapitalDesksSubsystem`: eleven institutions, five hooks, no new phase.
 *
 * No new phase for the desks. Every behaviour here fits inside the phases that
 * already exist, and hooking into them rather than adding a phase is what keeps
 * a fund's whole behaviour on the stream of the phase it acts in:
 *
 * | phase | hook | what it does |
 * |---|---|---|
 * | `action_collection` | `runCapitalDesks` | scores, writes term sheets, approaches, orders and sponsor actions — **after** NPC defaults, on a **forked** stream |
 * | `capital_resolution` | `resolveSponsorCapital` | closes accepted sheets, answers offers for rivals, completes buyouts, raises defences |
 * | `disclosure_resolution` | `publishSponsorDisclosures` | short reports and public letters become ordinary disclosures with an engine-computed credibility |
 * | `market_resolution` | `settleShorts` | fund longs settle; shorts open, mark, accrue, squeeze and cover — **after** the market prices |
 * | `leaderboard_update` | `recomputeCapitalEntities` | fees, LP pressure, the report rows and the mark |
 *
 * Two ordering notes that must survive a future reader:
 *
 * - the desk runs **after** `applyNpcDefaults` so it sees what the world already
 *   decided this quarter, and takes a **forked** stream so it cannot move that
 *   phase's hiring jitter;
 * - a term sheet offered in quarter *t* is answerable only in *t+1*. A fund's
 *   offer is never resolved in the quarter it is made.
 */

import type {
  ActivistCampaign,
  ActionIntent,
  CapitalDesksSubsystem,
  CapitalEntity,
  CapitalEntityRow,
  CapitalOrder,
  CapitalPositionRow,
  Company,
  DealProposal,
  PublicDisclosure,
  ResolverContext,
  SessionState,
} from '@frontier/contracts';
import {
  ACTIVIST_CAMPAIGN_PRUNE_QUARTERS,
  ACTIVIST_DEMAND_PROPOSAL_KIND,
  ACTIVIST_PROXY_STAKE_PCT,
  ACTIVIST_SETTLEMENT_SUPPORT_PCT,
  CAPITAL_ENTITY_MEMORY_LIMIT,
  CAPITAL_PARTNER_UTTERANCES_PER_QUARTER,
  CONTROL_DECISIVE_PCT,
  EXIT_TRANCHE_PCT,
  LP_PRESSURE_FORCED_FLOOR,
  LP_PRESSURE_SELLING_FLOOR,
  POISON_PILL_DILUTION_PCT,
  SHORT_REPORT_HIT_TRACK_RECORD,
  SHORT_REPORT_JUDGEMENT_MOVE_PCT,
  SHORT_REPORT_JUDGEMENT_QUARTERS,
  SHORT_REPORT_MISS_TRACK_RECORD,
  SOVEREIGN_CHARTER_CAP_PCT,
  SOVEREIGN_COUNTERCYCLICAL_RISK_APPETITE,
  STAGGERED_DELAY_QUARTERS,
  TAKEOVER_DEFENCE_REPUTATION_COST,
  WHITE_KNIGHT_BUMP_PCT,
  dpiPct,
  emptyEconomyReport,
  lpPressureBand,
  lpPressureFor,
  makeId,
  managementFeeUsd,
  targetMultipleFor,
} from '@frontier/contracts';
import { tallyProposal } from '../boards/tally';
import { offeredDebtRate } from '../resolver/capital';
import {
  capitalDesksEnabled,
  clampInt,
  compactUsd,
  creditRealised,
  deployableUsd,
  deskContext,
  estimatedValuationUsd,
  holdingsOf,
  issuedSharesFor,
  markValueUsd,
  moveDryPowder,
  navUsd,
  remember,
  stakeFractionOf,
  type DeskContext,
} from './context';
import { closeSponsorRound, grantInvestorSeat } from './rounds';
import { partnerGoalFor, rivalAcceptsTermSheet, termSheetOf, runVentureDesk } from './vc';
import { buyoutOf, controlledCompanies, lboFinancing, lboRateFor, liveApproaches, offerReferenceUsd, offerValueAt, rollUpAction, runBuyoutDesk, sponsorAction, sponsorPortfolioActions, tenderOrders, whiteKnightAccepts } from './pe';
import { demandsFor, runActivism, runHedgeDesk, sharesShortIn } from './hedge';
import { settleCapitalOrders } from './orders';
import { settleShortBook } from './shorts';
import { partnerNameOf, renderPartnerRemark } from './voice';

/** Build the capital-desks subsystem. Stateless: everything lives on the draft. */
export function createCapitalDesksSubsystem(): CapitalDesksSubsystem {
  return { runCapitalDesks, resolveSponsorCapital, publishSponsorDisclosures, settleShorts, recomputeCapitalEntities };
}

/* -------------------------------------------------------------------------- */
/*  Phase 4 — action_collection                                                */
/* -------------------------------------------------------------------------- */

function runCapitalDesks(draft: SessionState, ctx: ResolverContext): void {
  if (!capitalDesksEnabled(draft)) return;
  // Orders are this quarter's working set, exactly like pendingActions. They are
  // rewritten here and cleared at ledger_commit.
  draft.capitalOrders = [];
  const desk = deskContext(draft, ctx, 'capital_desks');

  const orders: CapitalOrder[] = [];
  for (const entity of desk.entities) {
    switch (entity.kind) {
      case 'vc':
        runVentureDesk(desk, entity);
        break;
      case 'pe':
        runBuyoutDesk(desk, entity);
        orders.push(...tenderOrders(desk, entity));
        break;
      case 'hedge_fund':
        runHedgeDesk(desk, entity);
        runActivism(desk, entity);
        break;
      case 'sovereign':
        orders.push(...sovereignOrders(desk, entity));
        break;
    }
    orders.push(...exitOrders(desk, entity));
  }
  if (orders.length > 0) draft.capitalOrders = [...(draft.capitalOrders ?? []), ...orders];

  resolveCampaigns(desk);
  writeSponsorActions(desk);
  speakTwice(desk);
}

/**
 * The sovereign: patient, long-only, never hostile, and bound by a charter cap
 * of a quarter of any company — which is exactly the information-rights line, so
 * it takes a seat at the table and never takes control.
 *
 * It is the buyer of last resort. When the world's risk appetite collapses and
 * every other fund is under LP pressure and selling, this desk is bidding, which
 * gives the world a stabiliser with a face.
 */
function sovereignOrders(desk: DeskContext, entity: CapitalEntity): CapitalOrder[] {
  const { draft, quarter } = desk;
  const out: CapitalOrder[] = [];
  const countercyclical = draft.world.capitalMarkets.riskAppetite < SOVEREIGN_COUNTERCYCLICAL_RISK_APPETITE;
  const sizePct = countercyclical ? 10 : 5;

  const candidates = draft.companies
    .filter((company) => company.isActive && company.isPublic && company.instrumentId !== null)
    .filter((company) => (entity.sectorAffinity[company.sectorId] ?? 0) >= 60)
    .slice()
    .sort((a, b) => (a.id < b.id ? -1 : 1));

  for (const company of candidates) {
    if (out.length >= 2) break;
    const stakePct = stakeFractionOf(draft, company.id, entity.id) * 100;
    if (stakePct >= SOVEREIGN_CHARTER_CAP_PCT) continue;
    const quote = desk.lastQuoteOf(company);
    const security = desk.primarySecurityOf(company.id);
    const table = desk.capTableOf(company.id);
    if (quote === null || quote.price <= 0 || security === null || table === null) continue;

    const budget = Math.round((deployableUsd(entity) * sizePct) / 100);
    const shares = Math.floor(Math.min(budget / quote.price, quote.volume));
    if (shares <= 0) continue;
    // Never past the charter, whatever the budget says.
    const issued = issuedSharesFor(draft, table, security.id);
    const headroom = Math.max(0, Math.floor((issued * SOVEREIGN_CHARTER_CAP_PCT) / 100) - Math.round((stakePct / 100) * issued));
    const wanted = Math.min(shares, headroom);
    if (wanted <= 0) continue;
    if (!desk.budget.take()) break;

    out.push({
      id: makeId('cord', entity.id, company.id, quarter, 'charter'),
      entityId: entity.id,
      quarter,
      kind: 'buy',
      securityId: security.id,
      companyId: company.id,
      shares: wanted,
      limitPriceUsd: null,
      reason: 'charter',
    });
  }
  return out;
}

/**
 * Selling down, which is what makes a fund's clock visible.
 *
 * A position sells when it has hit the target multiple, when it has been held
 * past the exit horizon, or when LP pressure says the fund is out of time. Past
 * `LP_PRESSURE_FORCED_FLOOR` the tranche goes **regardless of the limit price** —
 * blocks come loose and cheap, and a player watching The Street can see it
 * coming four quarters out.
 */
function exitOrders(desk: DeskContext, entity: CapitalEntity): CapitalOrder[] {
  const { draft, quarter } = desk;
  const lpPressure = lpPressureFor(entity, quarter);
  const target = targetMultipleFor(lpPressure);
  const out: CapitalOrder[] = [];

  for (const { table, holding } of holdingsOf(draft, entity.id)) {
    const company = desk.companyOf(table.companyId);
    if (company === null || !company.isActive || !company.isPublic) continue;
    if (holding.lockupUntilQuarter !== null && quarter < holding.lockupUntilQuarter) continue;
    const security = desk.primarySecurityOf(company.id);
    if (security === null || security.id !== holding.securityId) continue;

    const value = markValueUsd(desk, table, holding);
    const multiple = holding.costBasisUsd > 0 ? value / holding.costBasisUsd : 0;
    const held = quarter - holding.acquiredQuarter;
    const wantsOut = multiple >= target || held >= entity.exitHorizonQuarters || lpPressure >= LP_PRESSURE_SELLING_FLOOR;
    if (!wantsOut) continue;

    const shares = Math.max(1, Math.floor((holding.shares * EXIT_TRANCHE_PCT) / 100));
    if (shares <= 0) continue;
    if (!desk.budget.take()) break;

    const forced = lpPressure >= LP_PRESSURE_FORCED_FLOOR;
    const quote = desk.lastQuoteOf(company);
    out.push({
      id: makeId('cord', entity.id, company.id, quarter, 'exit'),
      entityId: entity.id,
      quarter,
      kind: 'sell',
      securityId: holding.securityId,
      companyId: company.id,
      shares,
      // A forced seller sets no limit and means it.
      limitPriceUsd: forced || quote === null ? null : Math.round(quote.price * 0.9 * 100) / 100,
      reason: lpPressure >= LP_PRESSURE_SELLING_FLOOR ? 'lp_pressure' : 'exit',
      isForced: forced,
    });
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/*  Campaign outcomes                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Settle, win, lose or withdraw every campaign that has reached a decision.
 *
 * Settlement is the common outcome by design: most real campaigns end in a
 * negotiated seat rather than at a ballot, and here that is decided by the board
 * tally and the size of the stake — the player's own board relationships — never
 * by a draw.
 */
function resolveCampaigns(desk: DeskContext): void {
  const { draft, ctx, quarter } = desk;
  const campaigns = draft.activistCampaigns ?? [];
  if (campaigns.length === 0) return;

  for (const campaign of campaigns) {
    if (campaign.outcome !== null) continue;
    if (campaign.stage !== 'board_demand' && campaign.stage !== 'proxy_fight') continue;
    const entity = desk.entities.find((candidate) => candidate.id === campaign.entityId);
    const company = desk.companyOf(campaign.targetCompanyId);
    if (entity === undefined || company === null) continue;

    const stakePct = clampInt(stakeFractionOf(draft, company.id, entity.id) * 100, 0, 100);
    const proposal = draft.boardProposals.find(
      (candidate) => candidate.companyId === company.id && candidate.proposedByCharacterId === (entity.partnerCharacterIds[0] ?? entity.id) && candidate.quarterProposed < quarter,
    );

    let outcome: ActivistCampaign['outcome'] = null;
    if (stakePct >= ACTIVIST_PROXY_STAKE_PCT) outcome = 'settled';
    else if (proposal !== undefined && proposal.status === 'passed') outcome = 'won';
    else if (proposal !== undefined) {
      const tally = tallyProposal(draft, proposal.id);
      const cast = tally.support + tally.against;
      const supportShare = cast > 0 ? (100 * tally.support) / cast : 0;
      outcome = supportShare >= ACTIVIST_SETTLEMENT_SUPPORT_PCT ? 'settled' : 'defeated';
    } else if (quarter - campaign.openedQuarter >= 6) {
      outcome = 'withdrawn';
    }
    if (outcome === null) continue;

    campaign.outcome = outcome;
    campaign.closedQuarter = quarter;
    if (outcome === 'settled' || outcome === 'won') {
      // A negotiated seat, conceded rather than won at a ballot, which is what
      // ninety per cent of real campaigns end in.
      if (grantInvestorSeat(draft, company, entity)) campaign.seatsGranted += 1;
    }

    const eventId = ctx.emit({
      sessionId: draft.sessionId,
      quarter,
      type: 'activist_campaign_closed',
      actorId: entity.id,
      targetId: company.id,
      payload: {
        entityId: entity.id,
        targetCompanyId: company.id,
        campaignId: campaign.id,
        outcome,
        quartersRun: quarter - campaign.openedQuarter,
        seatsGranted: campaign.seatsGranted,
        demands: campaign.demands,
      },
      visibility: 'public',
    });
    ctx.log({
      phase: 'action_collection',
      text: `${entity.name}'s campaign at ${company.name} closed ${outcome}, after ${quarter - campaign.openedQuarter} quarters and ${campaign.seatsGranted} seat(s).`,
      deltaLabel: outcome,
      refEventIds: [eventId],
      tone: outcome === 'defeated' ? 'positive' : 'warning',
      subjectId: company.id,
    });
    remember(entity, { companyId: company.id, kind: 'campaign_closed', quarter, outcome: outcome === 'defeated' ? 'rejected' : 'accepted', note: outcome }, CAPITAL_ENTITY_MEMORY_LIMIT);
  }
}

/* -------------------------------------------------------------------------- */
/*  Sponsor actions                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Write the ordinary actions a controlling sponsor, and an activist at the
 * board-demand rung, put in front of a company.
 *
 * They go into `pendingActions` with origin `'sponsor'` and are resolved by
 * exactly the same code that resolves a player's actions. A fund gets no private
 * mechanics, no free money and no hidden information — the same rule
 * `applyNpcDefaults` follows for background companies.
 */
function writeSponsorActions(desk: DeskContext): void {
  const { draft, ctx, quarter } = desk;
  let sequence = draft.pendingActions.length;
  const queued: ReturnType<typeof sponsorAction>[] = [];

  for (const entity of desk.entities) {
    if (entity.kind === 'pe') {
      for (const company of controlledCompanies(desk, entity)) {
        // The player runs their own company; a sponsor that controls it takes
        // the board, not the keyboard.
        if (company.controllerPlayerId !== null) continue;
        if (draft.pendingActions.some((action) => action.quarter === quarter && action.actorCompanyId === company.id)) continue;
        const intents = sponsorPortfolioActions(desk, entity, company);
        for (let index = 0; index < intents.length; index += 1) {
          const intent = intents[index];
          if (intent === undefined) continue;
          if (!desk.budget.take()) break;
          queued.push(sponsorAction(draft, quarter, sequence++, company, entity, index, intent));
        }
      }
      const rollUp = rollUpAction(desk, entity);
      if (rollUp !== null && desk.budget.take()) {
        queued.push(sponsorAction(draft, quarter, sequence++, rollUp.acquirer, entity, 90, rollUp.intent));
      }
    }

    // An activist at the board-demand rung tables the proposal its demand maps
    // to. Five demands, five existing proposal kinds, no new governance verb.
    for (const campaign of draft.activistCampaigns ?? []) {
      if (campaign.entityId !== entity.id || campaign.outcome !== null) continue;
      if (campaign.stage !== 'board_demand' && campaign.stage !== 'proxy_fight') continue;
      if (campaign.lastEscalatedQuarter !== quarter) continue;
      const company = desk.companyOf(campaign.targetCompanyId);
      const demand = campaign.demands[0];
      if (company === null || demand === undefined) continue;
      if (!desk.budget.take()) break;
      const intent: ActionIntent = {
        type: 'submit_board_proposal',
        kind: ACTIVIST_DEMAND_PROPOSAL_KIND[demand],
        title: `${entity.name}: ${demand.replace(/_/g, ' ')}`,
        summary: `${entity.name} holds ${campaign.stakePct}% of ${company.name} and asks the board to ${demand.replace(/_/g, ' ')}.`,
        amountUsd: null,
        stockComponentPct: null,
        targetCompanyId: null,
      };
      const action = sponsorAction(draft, quarter, sequence++, company, entity, 80, intent);
      queued.push({ ...action, actorCharacterId: entity.partnerCharacterIds[0] ?? action.actorCharacterId });
    }
  }

  if (queued.length === 0) return;
  draft.pendingActions.push(...queued);
  const eventId = ctx.emit({
    sessionId: draft.sessionId,
    quarter,
    type: 'action_accepted',
    actorId: null,
    targetId: null,
    payload: { origin: 'sponsor', actions: queued.length, actionTypes: queued.map((action) => action.intent.type) },
    visibility: 'company',
  });
  ctx.log({
    phase: 'action_collection',
    text: `Sponsors wrote ${queued.length} action(s) into the companies they control.`,
    deltaLabel: `${queued.length} actions`,
    refEventIds: [eventId],
    tone: 'neutral',
    subjectId: null,
  });
}

/* -------------------------------------------------------------------------- */
/*  Two utterances                                                             */
/* -------------------------------------------------------------------------- */

/**
 * The partners' words, capped at two a quarter and chosen by salience.
 *
 * The limiter is FIFO at concurrency one on a four-gigabyte machine, and the
 * quarter already spends its model budget on the World Director and the rival
 * strategists. So two, and everything else uses the deterministic template
 * renderer — which is what makes the game read correctly with the model switched
 * off entirely.
 */
function speakTwice(desk: DeskContext): void {
  const { draft, ctx, quarter } = desk;
  const rng = desk.rng.fork('partner_voice');

  interface Utterance {
    readonly entity: CapitalEntity;
    readonly companyId: string;
    readonly salience: number;
    readonly kind: 'term_sheet' | 'approach' | 'campaign';
    readonly figure: string;
  }
  const candidates: Utterance[] = [];

  for (const deal of draft.deals) {
    if (deal.createdQuarter !== quarter) continue;
    const sheet = termSheetOf(deal);
    if (sheet !== null) {
      const entity = desk.entities.find((candidate) => candidate.id === sheet.entityId);
      if (entity !== undefined) {
        candidates.push({ entity, companyId: sheet.companyId, salience: sheet.amountUsd, kind: 'term_sheet', figure: `${compactUsd(sheet.amountUsd)} at ${compactUsd(sheet.preMoneyUsd)} pre` });
      }
      continue;
    }
    const offer = buyoutOf(deal);
    if (offer !== null) {
      const entity = desk.entities.find((candidate) => candidate.id === offer.entityId);
      if (entity !== undefined) {
        // An approach outweighs a term sheet of the same size: it is the thing
        // that most concerns whoever is being approached.
        candidates.push({ entity, companyId: offer.targetCompanyId, salience: offer.offerValueUsd * 2, kind: 'approach', figure: `${compactUsd(offer.offerValueUsd)} at a ${offer.premiumPct}% premium` });
      }
    }
  }
  for (const campaign of draft.activistCampaigns ?? []) {
    if (campaign.openedQuarter !== quarter && campaign.lastEscalatedQuarter !== quarter) continue;
    const entity = desk.entities.find((candidate) => candidate.id === campaign.entityId);
    if (entity === undefined) continue;
    candidates.push({ entity, companyId: campaign.targetCompanyId, salience: entity.committedCapitalUsd / 4, kind: 'campaign', figure: `${campaign.stakePct}%` });
  }

  candidates.sort((a, b) => (b.salience !== a.salience ? b.salience - a.salience : a.entity.id < b.entity.id ? -1 : 1));

  for (const utterance of candidates.slice(0, CAPITAL_PARTNER_UTTERANCES_PER_QUARTER)) {
    const company = desk.companyOf(utterance.companyId);
    if (company === null) continue;
    const words = renderPartnerRemark(
      draft,
      utterance.entity,
      utterance.kind,
      { entityName: utterance.entity.name, companyName: company.name, figure: utterance.figure },
      rng,
    );
    const eventId = ctx.emit({
      sessionId: draft.sessionId,
      quarter,
      type: 'llm_call_logged',
      actorId: utterance.entity.partnerCharacterIds[0] ?? utterance.entity.id,
      targetId: company.id,
      payload: {
        agentRole: 'character_dialogue',
        // The engine computed every number in `figure`; the role supplied only
        // the sentence around them, and the fallback renderer supplied this one.
        strategy: 'templated_partner_remark',
        kind: utterance.kind,
        entityId: utterance.entity.id,
        words,
      },
      visibility: 'company',
    });
    ctx.log({
      phase: 'action_collection',
      text: `${partnerNameOf(draft, utterance.entity)}: "${words}"`,
      deltaLabel: null,
      refEventIds: [eventId],
      tone: 'neutral',
      subjectId: company.id,
    });
  }
}

/* -------------------------------------------------------------------------- */
/*  Phase 6 — capital_resolution                                               */
/* -------------------------------------------------------------------------- */

function resolveSponsorCapital(draft: SessionState, ctx: ResolverContext): void {
  if (!capitalDesksEnabled(draft)) return;
  const desk = deskContext(draft, ctx, 'sponsor_capital');

  answerOffers(desk);
  closeAcceptedTermSheets(desk);
  completeBuyouts(desk);
  raiseDefences(desk);
  expireOffers(desk);
}

/**
 * How a company nobody is playing answers a standing offer.
 *
 * Deterministic, from the company's own posture and runway. A player-controlled
 * company is never answered for: their offer stays in the inbox until they
 * accept it, reject it, or let it lapse.
 */
function answerOffers(desk: DeskContext): void {
  const { draft, ctx, quarter } = desk;

  for (const deal of draft.deals) {
    if (deal.status !== 'proposed' || deal.createdQuarter >= quarter) continue;
    const sheet = termSheetOf(deal);
    if (sheet === null) continue;
    const company = desk.companyOf(sheet.companyId);
    if (company === null || !company.isActive) continue;
    if (company.controllerPlayerId !== null) continue;

    const accepts = rivalAcceptsTermSheet(desk, company, sheet.dilutionPct);
    deal.status = accepts ? 'accepted' : 'rejected';
    deal.respondedQuarter = quarter;
    ctx.emit({
      sessionId: draft.sessionId,
      quarter,
      type: accepts ? 'deal_accepted' : 'deal_rejected',
      actorId: company.id,
      targetId: deal.id,
      payload: { dealKind: 'term_sheet', entityId: sheet.entityId, dilutionPct: sheet.dilutionPct, amountUsd: sheet.amountUsd },
      visibility: 'company',
    });
  }
}

/** Close every term sheet accepted this quarter as an ordinary priced round. */
function closeAcceptedTermSheets(desk: DeskContext): void {
  const { draft, quarter } = desk;

  for (const deal of draft.deals) {
    if (deal.status !== 'accepted' || deal.respondedQuarter !== quarter) continue;
    const sheet = termSheetOf(deal);
    if (sheet === null) continue;
    const entity = desk.entities.find((candidate) => candidate.id === sheet.entityId);
    const company = desk.companyOf(sheet.companyId);
    if (entity === undefined || company === null || !company.isActive) continue;

    const closed = closeSponsorRound(draft, desk.ctx, entity, company, deal, {
      stage: sheet.stage,
      amountUsd: sheet.amountUsd,
      preMoneyUsd: sheet.preMoneyUsd,
      boardSeats: sheet.boardSeats,
    });
    if (closed === null) continue;
    deal.status = 'executed';
    remember(entity, { companyId: company.id, kind: 'term_sheet_offered', quarter, outcome: 'accepted', note: `closed ${compactUsd(sheet.amountUsd)}` }, CAPITAL_ENTITY_MEMORY_LIMIT);
  }
}

/**
 * Complete a buyout the moment the sponsor is decisive.
 *
 * The bookkeeping, spelled out because this is where a reviewer will worry:
 *
 * - the stake was accumulated in the open market, one `shares_traded` row at a
 *   time, out of the sponsor's own dry powder — so no company's equity moved;
 * - the LBO debt lands as `debt_issued`, which moves assets and liabilities
 *   together and therefore needs no equity row at all;
 * - `acquisition_completed` records the change of control and states its own
 *   figures, and carries `dryPowderDeltaUsd: 0` because the money already went
 *   out through the trades.
 *
 * Every one of those is a row the equity reconstruction already reads, which is
 * the design rule of the whole subsystem rather than a coincidence.
 */
function completeBuyouts(desk: DeskContext): void {
  const { draft, ctx, quarter } = desk;

  for (const { deal, offer } of liveApproaches(draft)) {
    if (offer.stage !== 'tender') continue;
    const entity = desk.entities.find((candidate) => candidate.id === offer.entityId);
    const company = desk.companyOf(offer.targetCompanyId);
    if (entity === undefined || company === null || !company.isActive) continue;
    const stake = stakeFractionOf(draft, company.id, entity.id);
    if (stake <= CONTROL_DECISIVE_PCT) continue;

    // A staggered board buys the incumbent two quarters: a holder that has
    // crossed control is not decisive until the delay has run.
    const board = company.boardId === null ? undefined : draft.boards.find((candidate) => candidate.id === company.boardId);
    if (board?.staggered === true && quarter - deal.createdQuarter < STAGGERED_DELAY_QUARTERS + 2) continue;

    const { debtUsd, equityUsd } = lboFinancing(desk, company, offer.offerValueUsd);
    if (debtUsd > 0) {
      const rate = lboRateFor(offeredDebtRate(draft, company));
      company.financials.cash += debtUsd;
      company.financials.debt += debtUsd;
      company.balanceSheet.assets.cash += debtUsd;
      company.balanceSheet.liabilities.debt += debtUsd;
      ctx.emit({
        sessionId: draft.sessionId,
        quarter,
        type: 'debt_issued',
        actorId: company.id,
        targetId: company.id,
        payload: {
          cleared: true,
          amountUsd: debtUsd,
          rate: Math.round(rate * 10_000) / 10_000,
          termQuarters: 20,
          debtAfter: Math.round(company.financials.debt * 100) / 100,
          kind: 'lbo',
          sponsorId: entity.id,
        },
        visibility: 'public',
      });
    }

    deal.status = 'executed';
    deal.respondedQuarter = quarter;
    const eventId = ctx.emit({
      sessionId: draft.sessionId,
      quarter,
      type: 'acquisition_completed',
      actorId: entity.id,
      targetId: company.id,
      payload: {
        acquirerKind: 'fund',
        sponsorId: entity.id,
        entityId: entity.id,
        lboDebtUsd: debtUsd,
        equityChequeUsd: equityUsd,
        offerValueUsd: offer.offerValueUsd,
        premiumPct: offer.premiumPct,
        stakePct: clampInt(stake * 100, 0, 100),
        // The consideration already left through the trades that built the
        // stake; nothing further moves here.
        dryPowderDeltaUsd: 0,
      },
      visibility: 'public',
    });
    ctx.log({
      phase: 'capital_resolution',
      text: `${entity.name} took control of ${company.name} at ${clampInt(stake * 100, 0, 100)}%, placing ${compactUsd(debtUsd)} of debt on the business.`,
      deltaLabel: `${clampInt(stake * 100, 0, 100)}%`,
      refEventIds: [eventId],
      tone: 'negative',
      subjectId: company.id,
    });
    remember(entity, { companyId: company.id, kind: 'approach_made', quarter, outcome: 'accepted', note: 'control' }, CAPITAL_ENTITY_MEMORY_LIMIT);
  }
}

/**
 * The three defences, each an existing structure and each with a price.
 *
 * All three are triggered by things the player already does — a board proposal
 * that passes while a public approach is live, or a deal offered to a rival
 * fund's partner — so no new verb is added to the action set.
 */
function raiseDefences(desk: DeskContext): void {
  const { draft, ctx, quarter } = desk;
  const approaches = liveApproaches(draft);
  if (approaches.length === 0) return;

  for (const { deal, offer } of approaches) {
    if (offer.stage === 'private_approach') continue;
    const company = desk.companyOf(offer.targetCompanyId);
    if (company === null || !company.isActive) continue;

    /* --- staggered board --------------------------------------------------- */
    const board = company.boardId === null ? null : draft.boards.find((candidate) => candidate.id === company.boardId) ?? null;
    const restructuring = draft.boardProposals.find(
      (proposal) => proposal.companyId === company.id && proposal.kind === 'restructuring' && proposal.status === 'passed' && proposal.quarterProposed === quarter,
    );
    if (board !== null && board.staggered !== true && restructuring !== undefined) {
      board.staggered = true;
      company.reputation.investor = clampInt(company.reputation.investor + TAKEOVER_DEFENCE_REPUTATION_COST.staggered_board, 0, 100);
      emitDefence(desk, company.id, 'staggered_board', offer.entityId, 0, TAKEOVER_DEFENCE_REPUTATION_COST.staggered_board, `A controlling holder is not decisive for ${STAGGERED_DELAY_QUARTERS} quarters.`);
    }

    /* --- poison pill ------------------------------------------------------- */
    const financing = draft.boardProposals.find(
      (proposal) => proposal.companyId === company.id && proposal.kind === 'financing' && proposal.status === 'passed' && proposal.quarterProposed === quarter,
    );
    if (financing !== undefined) raisePoisonPill(desk, company, offer.entityId);

    /* --- white knight ------------------------------------------------------ */
    inviteWhiteKnight(desk, company, deal, offer.entityId, offer.offerValueUsd);
  }
}

/**
 * Issue shares pro rata to every holder **except** the raider.
 *
 * The authorisation is raised in the same step or the pill is refused outright:
 * a company may not issue shares it did not authorise, and clamping rather than
 * refusing would be a quiet way of breaking that rule. The issue is booked at
 * zero proceeds, so equity is correctly unchanged and the reconstruction reads
 * it as the non-event it is.
 */
function raisePoisonPill(desk: DeskContext, company: Company, raiderId: string): void {
  const { draft, ctx, quarter } = desk;
  const table = desk.capTableOf(company.id);
  const security = desk.primarySecurityOf(company.id);
  const shareClass = table?.shareClasses.find((klass) => klass.id === security?.shareClassId) ?? null;
  if (table === null || security === null || shareClass === null) return;
  // Once per raider. A rights plan is a one-time defence, not a standing tax.
  if (draft.deals.some((deal) => deal.id === makeId('pill', company.id, raiderId))) return;

  const holders = table.holdings.filter((holding) => holding.securityId === security.id && holding.shares > 0 && holding.holderId !== raiderId);
  const base = holders.reduce((sum, holding) => sum + holding.shares, 0);
  if (base <= 0) return;
  const newShares = Math.floor((base * POISON_PILL_DILUTION_PCT) / 100);
  if (newShares <= 0) return;

  const authorisedAfter = shareClass.issuedShares + newShares;
  if (authorisedAfter > shareClass.authorisedShares) {
    // Refused, not clamped: the board did not authorise this many shares.
    ctx.emit({
      sessionId: draft.sessionId,
      quarter,
      type: 'action_rejected',
      actorId: company.id,
      targetId: security.id,
      payload: { kind: 'poison_pill', code: 'exceeds_authorised_shares', wanted: newShares, headroom: shareClass.authorisedShares - shareClass.issuedShares },
      visibility: 'company',
    });
    return;
  }

  let allocated = 0;
  const ordered = holders.slice().sort((a, b) => (b.shares !== a.shares ? b.shares - a.shares : a.id < b.id ? -1 : 1));
  for (let index = 0; index < ordered.length; index += 1) {
    const holding = ordered[index];
    if (holding === undefined) continue;
    const share = index === ordered.length - 1 ? newShares - allocated : Math.floor((newShares * holding.shares) / base);
    if (share <= 0) continue;
    holding.shares += share;
    allocated += share;
  }
  shareClass.issuedShares += allocated;
  table.totalIssuedByClass[shareClass.id] = shareClass.issuedShares;
  table.fullyDilutedShares = table.shareClasses.reduce((sum, klass) => sum + klass.issuedShares, 0) + table.optionPoolShares;
  table.lastUpdatedQuarter = quarter;

  company.reputation.investor = clampInt(company.reputation.investor + TAKEOVER_DEFENCE_REPUTATION_COST.poison_pill, 0, 100);
  ctx.emit({
    sessionId: draft.sessionId,
    quarter,
    type: 'shares_issued',
    actorId: company.id,
    targetId: security.id,
    payload: { shares: allocated, shareClassId: shareClass.id, reason: 'poison_pill', proceedsUsd: 0, excludedHolderId: raiderId },
    visibility: 'public',
  });
  emitDefence(desk, company.id, 'poison_pill', raiderId, 0, TAKEOVER_DEFENCE_REPUTATION_COST.poison_pill, `${allocated} shares issued to every holder but the raider.`);
  // A marker deal id, so the pill cannot be raised twice against the same raider.
  draft.deals.push({
    id: makeId('pill', company.id, raiderId),
    proposerId: company.id,
    proposerKind: 'company',
    counterpartyId: raiderId,
    counterpartyKind: 'company',
    gives: [],
    gets: [],
    confidentiality: 'public',
    expiresQuarter: quarter,
    binding: false,
    intentStatements: [],
    summary: `${company.name} adopted a rights plan against ${raiderId}.`,
    status: 'executed',
    createdQuarter: quarter,
    respondedQuarter: quarter,
    conversationId: null,
    breachedByPartyId: null,
  });
}

/**
 * A rival fund, invited by the target, counter-bids five per cent over the
 * standing offer. The player still loses the company — to somebody who will
 * treat them better.
 */
function inviteWhiteKnight(desk: DeskContext, company: Company, standingDeal: DealProposal, raiderId: string, standingOfferUsd: number): void {
  const { draft, ctx, quarter } = desk;
  const invitation = draft.deals.find(
    (deal) =>
      deal.status === 'proposed' &&
      deal.proposerId === company.id &&
      deal.createdQuarter < quarter &&
      deal.gives.some((obligation) => obligation.kind === 'buyout_offer' && obligation.targetCompanyId === company.id && obligation.entityId !== raiderId),
  );
  if (invitation === undefined) return;
  const invited = invitation.gives.find((obligation) => obligation.kind === 'buyout_offer');
  if (invited === undefined || invited.kind !== 'buyout_offer') return;
  const rescuer = desk.entities.find((candidate) => candidate.id === invited.entityId);
  if (rescuer === undefined || !whiteKnightAccepts(desk, rescuer, company, standingOfferUsd)) {
    invitation.status = 'rejected';
    invitation.respondedQuarter = quarter;
    return;
  }

  const counterUsd = Math.round((standingOfferUsd * (100 + WHITE_KNIGHT_BUMP_PCT)) / 100);
  const reference = offerReferenceUsd(desk, company);
  const premiumPct = clampInt((100 * (counterUsd - reference)) / Math.max(1, reference), 0, 100);
  const { debtUsd, equityUsd } = lboFinancing(desk, company, counterUsd);
  invitation.status = 'accepted';
  invitation.respondedQuarter = quarter;

  const id = makeId('deal', rescuer.id, company.id, quarter, 'knight');
  if (draft.deals.some((deal) => deal.id === id)) return;
  draft.deals.push({
    id,
    proposerId: rescuer.partnerCharacterIds[0] ?? rescuer.id,
    proposerKind: 'character',
    counterpartyId: company.id,
    counterpartyKind: 'company',
    gives: [
      {
        kind: 'buyout_offer',
        entityId: rescuer.id,
        targetCompanyId: company.id,
        offerValueUsd: counterUsd,
        premiumPct,
        stage: 'bear_hug',
        lboDebtUsd: debtUsd,
        equityChequeUsd: equityUsd,
      },
    ],
    gets: [],
    confidentiality: 'public',
    expiresQuarter: quarter + 3,
    binding: true,
    intentStatements: [`${rescuer.name} intends to keep the management team in place.`],
    summary: `${rescuer.name} counter-bids ${compactUsd(counterUsd)} for ${company.name}, ${WHITE_KNIGHT_BUMP_PCT}% over the standing offer.`,
    status: 'proposed',
    createdQuarter: quarter,
    respondedQuarter: null,
    conversationId: null,
    breachedByPartyId: null,
  });
  void standingDeal;
  emitDefence(desk, company.id, 'white_knight', raiderId, counterUsd, TAKEOVER_DEFENCE_REPUTATION_COST.white_knight, `${rescuer.name} counter-bid ${compactUsd(counterUsd)}.`);
}

function emitDefence(desk: DeskContext, companyId: string, defence: 'poison_pill' | 'staggered_board' | 'white_knight', raiderEntityId: string, costUsd: number, reputationDelta: number, effect: string): void {
  const { draft, ctx, quarter } = desk;
  const eventId = ctx.emit({
    sessionId: draft.sessionId,
    quarter,
    type: 'takeover_defence_raised',
    actorId: companyId,
    targetId: raiderEntityId,
    payload: { companyId, defence, raiderEntityId, costUsd, reputationDelta, effect },
    visibility: 'public',
  });
  ctx.log({
    phase: 'capital_resolution',
    text: `${companyId} raised a ${defence.replace(/_/g, ' ')} against ${raiderEntityId}: ${effect}`,
    deltaLabel: reputationDelta === 0 ? null : `${reputationDelta} investor rep`,
    refEventIds: [eventId],
    tone: 'warning',
    subjectId: companyId,
  });
}

/** An unanswered offer lapses rather than standing open for ever. */
function expireOffers(desk: DeskContext): void {
  const { draft, ctx, quarter } = desk;
  for (const deal of draft.deals) {
    if (deal.status !== 'proposed' || quarter <= deal.expiresQuarter) continue;
    const sheet = termSheetOf(deal);
    const offer = buyoutOf(deal);
    if (sheet === null && offer === null) continue;
    deal.status = 'expired';
    deal.respondedQuarter = quarter;
    ctx.emit({
      sessionId: draft.sessionId,
      quarter,
      type: 'deal_rejected',
      actorId: deal.counterpartyId,
      targetId: deal.id,
      payload: { reason: 'lapsed', dealKind: sheet !== null ? 'term_sheet' : 'buyout_approach', entityId: sheet?.entityId ?? offer?.entityId ?? null },
      visibility: 'company',
    });
  }
}

/* -------------------------------------------------------------------------- */
/*  Phase 12 — disclosure_resolution                                           */
/* -------------------------------------------------------------------------- */

function publishSponsorDisclosures(draft: SessionState, ctx: ResolverContext): void {
  if (!capitalDesksEnabled(draft)) return;
  const desk = deskContext(draft, ctx, 'sponsor_disclosures');
  const rng = desk.rng.fork('report_voice');

  /* --- short reports ------------------------------------------------------- */
  for (const order of draft.capitalOrders ?? []) {
    if (order.kind !== 'publish_report') continue;
    const entity = desk.entities.find((candidate) => candidate.id === order.entityId);
    const company = desk.companyOf(order.companyId);
    if (entity === undefined || company === null) continue;
    const id = makeId('dsc', entity.id, company.id, ctx.quarter, 'short_report');
    if (draft.disclosures.some((disclosure) => disclosure.id === id)) continue;

    const anchor = desk.anchorOf(company.id)?.anchorValueUsd ?? 0;
    const marketCap = desk.metricsOf(company.id)?.marketCapUsd ?? 0;
    const gapPct = marketCap > 0 ? clampInt((100 * (marketCap - anchor)) / marketCap, -100, 100) : 0;
    const words = renderPartnerRemark(
      draft,
      entity,
      'short_report',
      { entityName: entity.name, companyName: company.name, figure: `We make it ${Math.max(0, gapPct)}% overvalued against its own fundamentals` },
      rng,
    );

    const disclosure: PublicDisclosure = {
      id,
      companyId: company.id,
      quarter: ctx.quarter,
      kind: 'analyst_note',
      headline: `${entity.name} publishes a short thesis on ${company.name}`.slice(0, 160),
      body: words,
      metrics: { anchorValueUsd: Math.round(anchor), marketCapUsd: Math.round(marketCap), overvaluationPct: Math.max(0, gapPct) },
      // The engine owns the credibility; the partner owns only the prose.
      credibility: Math.max(0, Math.min(1, order.credibilityPct / 100)),
      sourceCharacterId: entity.partnerCharacterIds[0] ?? null,
      isTruthful: gapPct > 0,
      beliefTopic: order.beliefTopic as PublicDisclosure['beliefTopic'],
    };
    draft.disclosures.push(disclosure);

    const eventId = ctx.emit({
      sessionId: draft.sessionId,
      quarter: ctx.quarter,
      type: 'disclosure_published',
      actorId: company.id,
      targetId: disclosure.id,
      payload: { kind: 'analyst_note', entityId: entity.id, beliefTopic: order.beliefTopic, credibility: Math.round(order.credibilityPct) / 100, shortReport: true },
      visibility: 'public',
    });
    ctx.log({
      phase: 'disclosure_resolution',
      text: `${entity.name} published a short report on ${company.name}, arguing ${String(order.beliefTopic).replace(/_/g, ' ')}.`,
      deltaLabel: `${order.credibilityPct}% credible`,
      refEventIds: [eventId],
      tone: 'negative',
      subjectId: company.id,
    });
    remember(entity, { companyId: company.id, kind: 'short_report_published', quarter: ctx.quarter, outcome: 'pending', note: `anchor ${compactUsd(anchor)}` }, CAPITAL_ENTITY_MEMORY_LIMIT);
  }

  /* --- public activist letters --------------------------------------------- */
  for (const campaign of draft.activistCampaigns ?? []) {
    if (campaign.outcome !== null || campaign.stage !== 'public_letter' || campaign.lastEscalatedQuarter !== ctx.quarter) continue;
    const entity = desk.entities.find((candidate) => candidate.id === campaign.entityId);
    const company = desk.companyOf(campaign.targetCompanyId);
    if (entity === undefined || company === null) continue;
    const id = makeId('dsc', entity.id, company.id, ctx.quarter, 'letter');
    if (draft.disclosures.some((disclosure) => disclosure.id === id)) continue;

    const words = renderPartnerRemark(draft, entity, 'campaign', { entityName: entity.name, companyName: company.name, figure: `${campaign.stakePct}%` }, rng);
    draft.disclosures.push({
      id,
      companyId: company.id,
      quarter: ctx.quarter,
      kind: 'analyst_note',
      headline: `${entity.name} goes public with its demands at ${company.name}`.slice(0, 160),
      body: `${words} ${entity.name} asks the board to ${campaign.demands.join(' and ').replace(/_/g, ' ')}.`.slice(0, 1500),
      metrics: { stakePct: campaign.stakePct, convictionPct: campaign.convictionPct },
      credibility: Math.max(0, Math.min(1, entity.trackRecord / 100)),
      sourceCharacterId: entity.partnerCharacterIds[0] ?? null,
      isTruthful: true,
      beliefTopic: campaign.demands.includes('replace_ceo') ? 'leadership_change' : 'margin_pressure',
    });
    const eventId = ctx.emit({
      sessionId: draft.sessionId,
      quarter: ctx.quarter,
      type: 'disclosure_published',
      actorId: company.id,
      targetId: id,
      payload: { kind: 'analyst_note', entityId: entity.id, activistLetter: true, stakePct: campaign.stakePct, demands: campaign.demands },
      visibility: 'public',
    });
    ctx.log({
      phase: 'disclosure_resolution',
      text: `${entity.name} published its letter to ${company.name} from a ${campaign.stakePct}% stake.`,
      deltaLabel: `${campaign.stakePct}%`,
      refEventIds: [eventId],
      tone: 'warning',
      subjectId: company.id,
    });
  }

  judgeShortReports(desk);
}

/**
 * Score every report old enough to judge.
 *
 * Asymmetric on purpose — the same asymmetry the guidance-miss penalty already
 * uses against companies. A fund that cries wolf becomes a fund nobody believes,
 * and its next report moves the price less, which is the answer to "why can a
 * hedge fund not publish a report every quarter for ever?"
 */
function judgeShortReports(desk: DeskContext): void {
  const { draft, ctx, quarter } = desk;
  for (const entity of desk.entities) {
    for (const entry of entity.memory) {
      if (entry.kind !== 'short_report_published' || entry.outcome !== 'pending') continue;
      if (quarter - entry.quarter < SHORT_REPORT_JUDGEMENT_QUARTERS) continue;
      const then = Number(entry.note.replace(/[^0-9.]/g, '')) || 0;
      const now = desk.anchorOf(entry.companyId)?.anchorValueUsd ?? 0;
      const movePct = then > 0 ? (100 * (now - then)) / then : 0;

      let delta = 0;
      let verdict: 'right' | 'wrong' | 'lapsed' = 'lapsed';
      if (movePct <= -SHORT_REPORT_JUDGEMENT_MOVE_PCT) {
        delta = SHORT_REPORT_HIT_TRACK_RECORD;
        verdict = 'right';
      } else if (movePct >= SHORT_REPORT_JUDGEMENT_MOVE_PCT) {
        delta = SHORT_REPORT_MISS_TRACK_RECORD;
        verdict = 'wrong';
      }
      entity.trackRecord = clampInt(entity.trackRecord + delta, 0, 100);
      entity.memory = entity.memory.map((candidate) =>
        candidate === entry ? { ...candidate, outcome: verdict } : candidate,
      );
      if (delta !== 0) {
        ctx.emit({
          sessionId: draft.sessionId,
          quarter,
          type: 'guidance_evaluated',
          actorId: entity.id,
          targetId: entry.companyId,
          payload: { kind: 'short_report', entityId: entity.id, verdict, anchorMovePct: Math.round(movePct), trackRecordAfter: entity.trackRecord },
          visibility: 'public',
        });
      }
    }
  }
}

/* -------------------------------------------------------------------------- */
/*  Phase 13 — market_resolution                                               */
/* -------------------------------------------------------------------------- */

function settleShorts(draft: SessionState, ctx: ResolverContext): void {
  if (!capitalDesksEnabled(draft)) return;
  // Longs first: a fund's buys and sells settle against the same quote as
  // everybody else's, through the same convex float pricing and block premium.
  settleCapitalOrders(draft, ctx);
  const snapshots = settleShortBook(draft, ctx);

  const report = draft.economyReport ?? emptyEconomyReport(ctx.quarter);
  draft.economyReport = {
    ...report,
    shortInterest: snapshots.map((snapshot) => ({
      instrumentId: snapshot.instrumentId,
      companyId: snapshot.companyId,
      shortInterestPct: snapshot.shortInterestPct,
      borrowFeePctPerQuarter: snapshot.borrowFeePctPerQuarter,
      disclosedEntityIds: snapshot.disclosedEntityIds.slice(0, 12),
      squeezeFired: snapshot.squeezeFired,
      forcedCoverShares: snapshot.forcedCoverShares,
      causeEventId: snapshot.causeEventId,
    })),
  };
}

/* -------------------------------------------------------------------------- */
/*  Phase 16 — leaderboard_update                                              */
/* -------------------------------------------------------------------------- */

function recomputeCapitalEntities(draft: SessionState, ctx: ResolverContext): void {
  if (!capitalDesksEnabled(draft)) return;
  const desk = deskContext(draft, ctx, 'capital_mark');
  const entityRows: CapitalEntityRow[] = [];
  const positionRows: CapitalPositionRow[] = [];

  for (const entity of draft.capitalEntities ?? []) {
    /* --- the fee that makes the J-curve ----------------------------------- */
    const feeUsd = managementFeeUsd(entity);
    const feeDelta = moveDryPowder(entity, -feeUsd);
    entity.feesPaidUsd = Math.round(entity.feesPaidUsd + Math.abs(feeDelta));

    const lpPressure = lpPressureFor(entity, ctx.quarter);
    const nav = navUsd(desk, entity);
    let deployed = 0;
    let positions = 0;

    for (const { table, holding } of holdingsOf(draft, entity.id)) {
      deployed += holding.costBasisUsd;
      positions += 1;
      const issued = issuedSharesFor(draft, table, holding.securityId);
      const value = markValueUsd(desk, table, holding);
      positionRows.push({
        entityId: entity.id,
        companyId: table.companyId,
        securityId: holding.securityId,
        shares: Math.max(0, Math.round(holding.shares)),
        stakePct: issued > 0 ? clampInt((100 * holding.shares) / issued, 0, 100) : 0,
        sinceQuarter: Math.max(0, holding.acquiredQuarter),
        costBasisUsd: Math.round(holding.costBasisUsd),
        valueUsd: value,
        unrealisedMultiplePct: holding.costBasisUsd > 0 ? clampInt((100 * value) / holding.costBasisUsd, 0, 10_000) : 0,
        isDisclosed: holding.isDisclosed,
      });
    }

    const shortCount = (draft.shortPositions ?? []).filter((position) => position.entityId === entity.id).length;
    const eventId = ctx.emit({
      sessionId: draft.sessionId,
      quarter: ctx.quarter,
      type: 'capital_entity_marked',
      actorId: entity.id,
      targetId: null,
      payload: {
        entityId: entity.id,
        navUsd: nav,
        dryPowderUsd: entity.dryPowderUsd,
        deployedUsd: Math.round(deployed),
        realisedProceedsUsd: entity.realisedProceedsUsd,
        dpiPct: dpiPct(entity),
        lpPressure,
        trackRecord: entity.trackRecord,
        positions,
        managementFeeUsd: Math.abs(feeDelta),
        // The fee is the only dry-powder movement this row causes, and it is
        // declared here so `capital_integrity` can reconstruct it.
        dryPowderDeltaUsd: feeDelta,
      },
      visibility: 'public',
    });

    entityRows.push({
      entityId: entity.id,
      name: entity.name,
      kind: entity.kind,
      region: entity.region,
      thesis: entity.thesis,
      aumUsd: entity.committedCapitalUsd,
      dryPowderUsd: entity.dryPowderUsd,
      dryPowderPct: clampInt((100 * entity.dryPowderUsd) / Math.max(1, entity.committedCapitalUsd), 0, 100),
      deployedUsd: Math.round(deployed),
      navUsd: nav,
      realisedProceedsUsd: entity.realisedProceedsUsd,
      dpiPct: dpiPct(entity),
      lpPressure,
      lpBand: lpPressureBand(lpPressure),
      trackRecord: entity.trackRecord,
      stance: 'watching',
      partnerCharacterId: entity.partnerCharacterIds[0] ?? null,
      positionCount: positions,
      shortCount,
      lastMove: lastMoveOf(desk, entity),
      causeEventId: eventId,
    });
  }

  pruneCampaigns(draft, ctx.quarter);

  const report = draft.economyReport ?? emptyEconomyReport(ctx.quarter);
  draft.economyReport = { ...report, capitalEntities: entityRows.slice(0, 12), capitalPositions: positionRows };
}

/** The one line on the card: what this desk actually did this quarter. */
function lastMoveOf(desk: DeskContext, entity: CapitalEntity): string | null {
  const orders = (desk.draft.capitalOrders ?? []).filter((order) => order.entityId === entity.id);
  const first = orders[0];
  if (first === undefined) return null;
  switch (first.kind) {
    case 'buy':
      return `Bought into ${first.companyId}`.slice(0, 80);
    case 'sell':
      return `${first.isForced ? 'Force-sold' : 'Cut'} ${first.companyId}`.slice(0, 80);
    case 'short_open':
      return `Opened a short in ${first.companyId}`.slice(0, 80);
    case 'short_cover':
      return 'Covered a short'.slice(0, 80);
    case 'publish_report':
      return `Published on ${first.companyId}`.slice(0, 80);
    case 'campaign_step':
      return 'Escalated a campaign'.slice(0, 80);
  }
}

/** Closed campaigns are kept long enough to be read about, then dropped. */
function pruneCampaigns(draft: SessionState, quarter: number): void {
  const campaigns = draft.activistCampaigns;
  if (campaigns === undefined || campaigns.length === 0) return;
  draft.activistCampaigns = campaigns.filter(
    (campaign) => campaign.outcome === null || campaign.closedQuarter === null || quarter - campaign.closedQuarter < ACTIVIST_CAMPAIGN_PRUNE_QUARTERS,
  );
}

/* -------------------------------------------------------------------------- */
/*  Exports the tests and the surfaces read                                    */
/* -------------------------------------------------------------------------- */

export { exitOrders, sovereignOrders };
export { demandsFor, sharesShortIn } from './hedge';
export { partnerGoalFor } from './vc';
export { creditRealised, estimatedValuationUsd, deployableUsd } from './context';
export { LP_PRESSURE_SELLING_FLOOR };
