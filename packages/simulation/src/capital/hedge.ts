/**
 * @frontier/simulation — capital/hedge.ts
 *
 * The hedge desk: conviction, sizing, activism and the short report.
 *
 * Two things make this desk different from the other two. It trades **both
 * sides** of the quoted market, which is the one genuinely new mechanic in the
 * subsystem; and it agitates from a **minority** stake, which turns the player's
 * board relationships from decoration into the thing that decides whether a
 * campaign ends in a negotiated seat or a proxy fight.
 *
 * Sizing is three hard caps, and every one of them is a test:
 *
 * ```
 * notional = min( dry powder x POSITION_SIZE_PCT,
 *                 float x price x FLOAT_SIZE_PCT,
 *                 last quarter's traded volume x price )
 * ```
 *
 * A fund cannot spend money it does not have, cannot own more of a company than
 * exists, and cannot move more than the market took last quarter.
 */

import type { ActivistCampaign, CapitalEntity, CapitalOrder, Company, SessionState } from '@frontier/contracts';
import {
  ACTIVIST_CAMPAIGN_STAGES,
  ACTIVIST_CONVICTION_FLOOR,
  ACTIVIST_DEMAND_PROPOSAL_KIND,
  ACTIVIST_OPEN_STAKE_PCT,
  ACTIVIST_PROXY_STAKE_PCT,
  ARB_SIZE_PCT,
  EVENT_TRADES_PER_QUARTER,
  FLOAT_SIZE_PCT,
  LONG_CONVICTION_FLOOR,
  POSITION_SIZE_PCT,
  SHORT_CONVICTION_FLOOR,
  SHORT_INTEREST_CAP_PCT,
  SHORT_MARGIN_PCT,
  SHORT_REPORT_CONVICTION_FLOOR,
  SHORT_REPORT_COOLDOWN_QUARTERS,
  activistStakeGatePct,
  makeId,
  shortHeadroomShares,
  type ActivistDemand,
  type ActivistCampaignStage,
} from '@frontier/contracts';
import { clampInt, deployableUsd, floatSharesOf, onCooldown, stakeFractionOf, type DeskContext } from './context';
import { convictionFor, reportTopicFor } from './scores';
import { buyoutOf } from './pe';

/* -------------------------------------------------------------------------- */
/*  Sizing                                                                     */
/* -------------------------------------------------------------------------- */

/** The three caps, in dollars of notional. Never a fourth, and never a draw. */
export function positionNotionalUsd(desk: DeskContext, entity: CapitalEntity, company: Company, sizePct: number): number {
  const quote = desk.lastQuoteOf(company);
  const table = desk.capTableOf(company.id);
  const security = desk.primarySecurityOf(company.id);
  if (quote === null || quote.price <= 0 || table === null || security === null) return 0;

  const byPowder = Math.round((deployableUsd(entity) * sizePct) / 100);
  const byFloat = Math.round((floatSharesOf(table, security.id) * quote.price * FLOAT_SIZE_PCT) / 100);
  const byVolume = Math.round(quote.volume * quote.price);
  return Math.max(0, Math.min(byPowder, byFloat, byVolume));
}

/** Shares the notional buys at the quote, scaled by how strongly the desk believes it. */
export function sharesFor(desk: DeskContext, company: Company, notionalUsd: number, convictionPct: number): number {
  const quote = desk.lastQuoteOf(company);
  if (quote === null || quote.price <= 0) return 0;
  return Math.max(0, Math.floor((notionalUsd * Math.abs(convictionPct)) / 100 / quote.price));
}

/* -------------------------------------------------------------------------- */
/*  The desk                                                                   */
/* -------------------------------------------------------------------------- */

/** Companies a hedge desk can trade: listed, active, and actually quoted. */
function tradable(desk: DeskContext, company: Company): boolean {
  if (!company.isActive || !company.isPublic || company.instrumentId === null) return false;
  const quote = desk.lastQuoteOf(company);
  return quote !== null && quote.price > 0;
}

/**
 * Run one hedge fund's quarter.
 *
 * Longs and shorts from the conviction signal, one merger-arbitrage leg per open
 * public approach, a short report where the thesis is strong enough to publish,
 * and one rung of any campaign the stake now supports.
 */
export function runHedgeDesk(desk: DeskContext, entity: CapitalEntity): number {
  const { draft, quarter } = desk;
  let used = 0;
  const orders: CapitalOrder[] = [];

  const scored: { company: Company; conviction: number }[] = [];
  for (const company of draft.companies) {
    if (!tradable(desk, company)) continue;
    scored.push({ company, conviction: convictionFor(desk, company) });
  }
  // Strongest conviction either way first; ties by company id.
  scored.sort((a, b) => (Math.abs(b.conviction) !== Math.abs(a.conviction) ? Math.abs(b.conviction) - Math.abs(a.conviction) : a.company.id < b.company.id ? -1 : 1));

  for (const { company, conviction } of scored) {
    if (used >= 4) break; // per-fund ceiling before the session budget even applies
    const security = desk.primarySecurityOf(company.id);
    const table = desk.capTableOf(company.id);
    if (security === null || table === null || company.instrumentId === null) continue;

    if (conviction >= LONG_CONVICTION_FLOOR) {
      const shares = sharesFor(desk, company, positionNotionalUsd(desk, entity, company, POSITION_SIZE_PCT), conviction);
      if (shares <= 0) continue;
      if (!desk.budget.take()) return used;
      used += 1;
      const quote = desk.lastQuoteOf(company);
      orders.push({
        id: makeId('cord', entity.id, company.id, quarter, 'long'),
        entityId: entity.id,
        quarter,
        kind: 'buy',
        securityId: security.id,
        companyId: company.id,
        shares,
        limitPriceUsd: quote === null ? null : Math.round(quote.price * 1.05 * 100) / 100,
        reason: 'conviction',
      });
      continue;
    }

    if (conviction <= SHORT_CONVICTION_FLOOR && entity.kind === 'hedge_fund') {
      const floatShares = floatSharesOf(table, security.id);
      const alreadyShort = sharesShortIn(draft, company.instrumentId);
      const headroom = shortHeadroomShares(alreadyShort, floatShares);
      if (headroom <= 0) continue;
      const wanted = Math.min(headroom, sharesFor(desk, company, positionNotionalUsd(desk, entity, company, POSITION_SIZE_PCT), conviction));
      if (wanted <= 0) continue;
      const quote = desk.lastQuoteOf(company);
      if (quote === null) continue;
      const marginUsd = Math.round((wanted * quote.price * SHORT_MARGIN_PCT) / 100);
      if (marginUsd <= 0 || marginUsd > deployableUsd(entity)) continue;
      if (!desk.budget.take()) return used;
      used += 1;
      orders.push({
        id: makeId('cord', entity.id, company.id, quarter, 'short'),
        entityId: entity.id,
        quarter,
        kind: 'short_open',
        securityId: security.id,
        instrumentId: company.instrumentId,
        companyId: company.id,
        shares: wanted,
        marginUsd,
      });
    }
  }

  used += publishReports(desk, entity, scored, orders);

  used += eventDrivenOrders(desk, entity, orders);
  if (orders.length > 0) draft.capitalOrders = [...(draft.capitalOrders ?? []), ...orders];
  return used;
}

/**
 * Publish where the thesis is strong enough to argue in public.
 *
 * The condition is **being short**, not adding to a short. A desk whose position
 * is already at the per-instrument cap is the desk with the most conviction in
 * the name and the most reason to publish; gating the report on opening more
 * shares would silence exactly the fund that meant it most, and would make the
 * whole reputation loop unreachable in any name the market was already crowded
 * into.
 *
 * Judged four quarters later against the target's anchor, asymmetrically, so a
 * fund that cries wolf becomes a fund nobody believes.
 */
function publishReports(desk: DeskContext, entity: CapitalEntity, scored: readonly { company: Company; conviction: number }[], sink: CapitalOrder[]): number {
  const { draft, quarter } = desk;
  if (entity.kind !== 'hedge_fund') return 0;
  let published = 0;

  for (const { company, conviction } of scored) {
    if (published >= 1) break; // one argument a quarter; a desk that publishes on everything argues nothing
    if (conviction > SHORT_REPORT_CONVICTION_FLOOR) continue;
    if (onCooldown(entity, company.id, 'short_report_published', SHORT_REPORT_COOLDOWN_QUARTERS, quarter)) continue;
    const isShort =
      (draft.shortPositions ?? []).some((position) => position.entityId === entity.id && position.companyId === company.id) ||
      sink.some((order) => order.kind === 'short_open' && order.companyId === company.id);
    if (!isShort) continue;
    if (!desk.budget.take()) break;
    published += 1;
    sink.push({
      id: makeId('cord', entity.id, company.id, quarter, 'report'),
      entityId: entity.id,
      quarter,
      kind: 'publish_report',
      companyId: company.id,
      beliefTopic: reportTopicFor(desk, company),
      credibilityPct: reportCredibilityPct(entity),
    });
  }
  return published;
}

/** Shares short in one instrument, across every entity. */
export function sharesShortIn(draft: SessionState, instrumentId: string): number {
  let shares = 0;
  for (const position of draft.shortPositions ?? []) {
    if (position.instrumentId === instrumentId) shares += position.shares;
  }
  return shares;
}

/**
 * A report's credibility, engine-computed from the fund's track record.
 *
 * The engine owns the belief delta; a model owns only the prose. That is the
 * rule this number exists to enforce.
 */
export function reportCredibilityPct(entity: CapitalEntity): number {
  return clampInt(70 * (entity.trackRecord / 100) + 30 * (entity.trackRecord / 100), 0, 100);
}

/**
 * Merger arbitrage: the mechanism that makes the public record tradeable.
 *
 * On any live public approach, go long the target — the offer puts a floor under
 * it — at a bounded fraction of dry powder, capped at two legs a quarter.
 */
function eventDrivenOrders(desk: DeskContext, entity: CapitalEntity, sink: CapitalOrder[]): number {
  const { draft, quarter } = desk;
  let placed = 0;

  const approaches = draft.deals
    .filter((deal) => deal.status === 'proposed' && deal.confidentiality === 'public')
    .slice()
    .sort((a, b) => (a.id < b.id ? -1 : 1));

  for (const deal of approaches) {
    if (placed >= EVENT_TRADES_PER_QUARTER) break;
    const offer = buyoutOf(deal);
    if (offer === null || offer.entityId === entity.id) continue;
    const company = desk.companyOf(offer.targetCompanyId);
    if (company === null || !tradable(desk, company)) continue;
    const security = desk.primarySecurityOf(company.id);
    if (security === null) continue;
    const shares = sharesFor(desk, company, positionNotionalUsd(desk, entity, company, ARB_SIZE_PCT), 100);
    if (shares <= 0) continue;
    if (!desk.budget.take()) break;
    const quote = desk.lastQuoteOf(company);
    sink.push({
      id: makeId('cord', entity.id, company.id, quarter, 'arb'),
      entityId: entity.id,
      quarter,
      kind: 'buy',
      securityId: security.id,
      companyId: company.id,
      shares,
      limitPriceUsd: quote === null ? null : Math.round(quote.price * (100 + offer.premiumPct)) / 100,
      reason: 'arbitrage',
    });
    placed += 1;
  }
  return placed;
}

/* -------------------------------------------------------------------------- */
/*  Activism                                                                   */
/* -------------------------------------------------------------------------- */

/** What this fund would demand of this company, from the five the board already resolves. */
export function demandsFor(desk: DeskContext, company: Company): ActivistDemand[] {
  const metrics = desk.metricsOf(company.id);
  const demands: ActivistDemand[] = [];
  if ((metrics?.operatingMarginPct ?? 0) < 0.1) demands.push('cut_costs');
  if ((metrics?.revenueGrowthYoY ?? 0) < 0 && demands.length < 2) demands.push('replace_ceo');
  if (company.financials.cash > Math.max(1, metrics?.revenueTtm ?? 0) && demands.length < 2) demands.push('return_capital');
  if (demands.length === 0) demands.push('sell_the_company');
  return demands.slice(0, 3);
}

/** The rung above `stage`, or null at the top of the ladder. */
export function nextStage(stage: ActivistCampaignStage): ActivistCampaignStage | null {
  const index = ACTIVIST_CAMPAIGN_STAGES.indexOf(stage);
  return ACTIVIST_CAMPAIGN_STAGES[index + 1] ?? null;
}

/**
 * Open or escalate this fund's campaigns.
 *
 * A campaign opens on a stake at or above ten per cent held for at least two
 * quarters with conviction at or above the floor — the "held for two consecutive
 * quarters" of the design, read off the holding's own `acquiredQuarter` rather
 * than from a second history nobody else needs.
 */
export function runActivism(desk: DeskContext, entity: CapitalEntity): number {
  const { draft, ctx, quarter } = desk;
  if (entity.kind !== 'hedge_fund') return 0;
  let used = 0;
  const campaigns = draft.activistCampaigns ?? [];

  for (const company of draft.companies) {
    if (!company.isActive || !company.isPublic) continue;
    const stakePct = clampInt(stakeFractionOf(draft, company.id, entity.id) * 100, 0, 100);
    const open = campaigns.find((campaign) => campaign.entityId === entity.id && campaign.targetCompanyId === company.id && campaign.outcome === null);

    if (open === undefined) {
      if (stakePct < ACTIVIST_OPEN_STAKE_PCT) continue;
      const conviction = convictionFor(desk, company);
      if (conviction < ACTIVIST_CONVICTION_FLOOR) continue;
      if (!heldForTwoQuarters(desk, entity, company)) continue;
      if (!desk.budget.take()) return used;
      used += 1;

      const campaign: ActivistCampaign = {
        id: makeId('cmp', entity.id, company.id, quarter),
        entityId: entity.id,
        targetCompanyId: company.id,
        stage: 'private_letter',
        demands: demandsFor(desk, company),
        openedQuarter: quarter,
        lastEscalatedQuarter: quarter,
        stakePct,
        convictionPct: conviction,
        seatsGranted: 0,
        outcome: null,
        closedQuarter: null,
      };
      draft.activistCampaigns = [...campaigns, campaign];

      const eventId = ctx.emit({
        sessionId: draft.sessionId,
        quarter,
        type: 'activist_campaign_opened',
        actorId: entity.id,
        targetId: company.id,
        payload: { entityId: entity.id, targetCompanyId: company.id, stakePct, demands: campaign.demands, convictionPct: conviction, campaignId: campaign.id },
        // A private letter is exactly that: the company knows, the market does not.
        visibility: 'company',
      });
      ctx.log({
        phase: 'action_collection',
        text: `${entity.name} wrote to ${company.name} privately from a ${stakePct}% stake, demanding ${campaign.demands.join(' and ').replace(/_/g, ' ')}.`,
        deltaLabel: `${stakePct}%`,
        refEventIds: [eventId],
        tone: 'warning',
        subjectId: company.id,
      });
      continue;
    }

    // Never twice in one quarter, and never a rung the stake does not carry.
    if (open.lastEscalatedQuarter >= quarter) continue;
    const to = nextStage(open.stage);
    if (to === null) continue;
    if (stakePct < activistStakeGatePct(to)) continue;
    if (!desk.budget.take()) return used;
    used += 1;

    const from = open.stage;
    open.stage = to;
    open.stakePct = stakePct;
    open.lastEscalatedQuarter = quarter;

    const eventId = ctx.emit({
      sessionId: draft.sessionId,
      quarter,
      type: 'activist_campaign_escalated',
      actorId: entity.id,
      targetId: company.id,
      payload: { entityId: entity.id, targetCompanyId: company.id, fromStage: from, toStage: to, stakePct, campaignId: open.id },
      visibility: 'public',
    });
    ctx.log({
      phase: 'action_collection',
      text: `${entity.name} escalated its campaign at ${company.name} from a ${from.replace(/_/g, ' ')} to a ${to.replace(/_/g, ' ')} on a ${stakePct}% stake.`,
      deltaLabel: to.replace(/_/g, ' '),
      refEventIds: [eventId],
      tone: 'negative',
      subjectId: company.id,
    });
  }

  return used;
}

/** True when the fund has held this name for at least two quarters. */
function heldForTwoQuarters(desk: DeskContext, entity: CapitalEntity, company: Company): boolean {
  const table = desk.capTableOf(company.id);
  if (table === null) return false;
  for (const holding of table.holdings) {
    if (holding.holderId !== entity.id || holding.shares <= 0) continue;
    if (desk.quarter - holding.acquiredQuarter >= 2) return true;
  }
  return false;
}

/** The board proposal kind a demand maps to. Five demands, no new governance verb. */
export function proposalKindForDemand(demand: ActivistDemand): ReturnType<() => (typeof ACTIVIST_DEMAND_PROPOSAL_KIND)[ActivistDemand]> {
  return ACTIVIST_DEMAND_PROPOSAL_KIND[demand];
}

/** The stake at which a target settles rather than fights, whatever the tally says. */
export const SETTLE_OUTRIGHT_STAKE_PCT = ACTIVIST_PROXY_STAKE_PCT;

/** Short interest cap, restated where the desk reads it, so the bound is visible at the call site. */
export const SHORT_CAP_PCT = SHORT_INTEREST_CAP_PCT;
