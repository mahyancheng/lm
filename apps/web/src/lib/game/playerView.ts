/**
 * `SessionState` → `PlayerView`.
 *
 * The information boundary, expressed as a pure function. In multiplayer this
 * projection runs on the server and the client never sees the aggregate; in
 * demo mode the aggregate is in the tab, so the projection is what screens are
 * required to read from instead.
 *
 * The rules, from UI_SYSTEM §7.3:
 *
 * - rival `confidenceByCompany` never leaves this file (`techGraphForCompany`);
 * - a rival's secret research programme is *absent*, not redacted
 *   (`researchProjectsForCompany`);
 * - a private rival discloses almost nothing; a listed one discloses what
 *   quarterly reporting would actually contain.
 *
 * Screens render `PlayerView` for anything about someone else. `SessionState`
 * is available for the player's own company, the world and the market tape —
 * all of which the player legitimately sees in full.
 */

import { filedFinancialQuarter } from '@frontier/contracts';
import type {
  CapTable,
  Company,
  ControlledCompanyView,
  Leaderboard,
  PlayerView,
  ProcurementOpportunity,
  Quote,
  SessionState,
  WorldEvent,
} from '@frontier/contracts';
import {
  SOLVENCY_NEGATIVE_QUARTERS,
  controlledCompaniesOf,
  founderPortfolioOf,
  negativeCashQuarters,
  projectEconomyReportForPlayer,
  researchProjectsForCompany,
  techGraphForCompany,
} from '@frontier/simulation';
import { formatMoney, formatQuarterCount } from '@frontier/shared';
import { PLAYER_ID, playerCharacterOf, playerCompanyOf } from './engine';

/* -------------------------------------------------------------------------- */
/*  Rival redaction                                                            */
/* -------------------------------------------------------------------------- */

/**
 * What one player may know about a company that is not theirs.
 *
 * Identity, listing status, sector, region, market linkage and multi-audience
 * reputation are public. Everything operational — headcount, compute, offices,
 * capability scores, product economics — is not. A listed company additionally
 * discloses its financial statements and the fundamentals derived from them,
 * because it files them; a private company's trailing revenue and margin are
 * exactly the kind of figure it keeps to itself.
 */
export function redactRival(company: Company): Partial<Company> {
  const base: Partial<Company> = {
    id: company.id,
    name: company.name,
    ticker: company.ticker,
    archetype: company.archetype,
    tier: company.tier,
    isPublic: company.isPublic,
    controllerPlayerId: company.controllerPlayerId,
    sectorId: company.sectorId,
    // What a company does and where it is based are on the public register in
    // every jurisdiction the game models; neither is a disclosure.
    sector: company.sector,
    region: company.region,
    foundedQuarter: company.foundedQuarter,
    headquartersCity: company.headquartersCity,
    isActive: company.isActive,
    reputation: company.reputation,
    primarySecurityId: company.primarySecurityId,
    instrumentId: company.instrumentId,
    ceoCharacterId: company.ceoCharacterId,
    boardId: company.boardId,
    parentCompanyId: company.parentCompanyId,
  };

  // A private company files nothing, so its statements are ABSENT rather than
  // blurred — the same rule the rest of this file follows.
  if (!company.isPublic) return base;

  return {
    ...base,
    financials: company.financials,
    balanceSheet: company.balanceSheet,
    fundamentals: company.fundamentals,
    governmentPastPerformance: company.governmentPastPerformance,
    posture: company.posture,
    // A listed company files its statements, at the grain a filing has:
    // `filedFinancialQuarter` drops the revenue split, the operating-expense
    // split and the product lines and rewrites nothing else. Absent entirely
    // when the world keeps no statements.
    financialHistory: company.financialHistory?.map(filedFinancialQuarter),
  };
}

/** World events whose visibility reaches this company. */
function visibleEvents(session: SessionState, companyId: string): WorldEvent[] {
  const company = session.companies.find((entry) => entry.id === companyId) ?? null;
  return session.activeEvents.filter((event) => {
    if (event.visibility === 'public') return true;
    if (event.affectedCompanyIds.includes(companyId)) return true;
    if (event.visibility === 'sector' && company !== null) return event.affectedSectorIds.includes(company.sectorId);
    return false;
  });
}

/** Opportunities this company can see: public ones, plus anything it was invited to. */
function visibleOpportunities(session: SessionState, companyId: string): ProcurementOpportunity[] {
  return session.procurementOpportunities.filter((opportunity) => {
    if (opportunity.visibility === 'public') return true;
    return opportunity.invitedCompanyIds.includes(companyId);
  });
}

/* -------------------------------------------------------------------------- */
/*  Alerts                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Command Centre alert lines for the open quarter.
 *
 * Every line is derived from committed state — no screen invents a number, and
 * neither does this. Order is stable so the feed does not reshuffle between
 * renders.
 */
export function buildAlerts(session: SessionState): string[] {
  const company = playerCompanyOf(session);
  const alerts: string[] = [];

  const metrics = session.companyMetrics.find((entry) => entry.companyId === company.id) ?? null;
  if (metrics !== null && metrics.runwayQuarters < 6) {
    alerts.push(`Runway is ${formatQuarterCount(metrics.runwayQuarters)} at the current burn.`);
  }
  // The solvency clock, in the words the previews and the Command Centre use.
  // Two quarter-ends below zero is the whole bankruptcy rule, so the count is
  // what the alert states — not a general warning that says nothing about how
  // much time is left.
  const negativeQuarters = negativeCashQuarters(company);
  if (company.financials.cash < 0) {
    alerts.push(
      negativeQuarters >= SOLVENCY_NEGATIVE_QUARTERS
        ? `Cash has been below zero for ${negativeQuarters} quarters; the company is being wound up.`
        : `Cash is ${formatMoney(company.financials.cash)} — ${negativeQuarters} of ${SOLVENCY_NEGATIVE_QUARTERS} quarters below zero. One more and the company is wound up.`,
    );
  }

  const proposals = session.boardProposals.filter((proposal) => proposal.companyId === company.id && proposal.status === 'tabled');
  if (proposals.length > 0) {
    alerts.push(`${proposals.length} board matter${proposals.length === 1 ? '' : 's'} awaiting a vote.`);
  }

  const inbound = session.deals.filter(
    (deal) => deal.counterpartyId === company.id && deal.status === 'proposed',
  );
  if (inbound.length > 0) {
    alerts.push(`${inbound.length} deal${inbound.length === 1 ? '' : 's'} awaiting your answer.`);
  }

  for (const opportunity of visibleOpportunities(session, company.id)) {
    if (opportunity.status !== 'open') continue;
    const remaining = opportunity.closeQuarter - session.quarter;
    if (remaining <= 1) {
      alerts.push(`${opportunity.programme} closes ${remaining <= 0 ? 'this quarter' : 'next quarter'} — ceiling ${formatMoney(opportunity.maxValue)}.`);
    }
  }

  if (company.compute.reservationExpiryQuarter !== null) {
    const remaining = company.compute.reservationExpiryQuarter - session.quarter;
    if (remaining <= 2) {
      alerts.push(`Compute reservation expires in ${Math.max(0, remaining)} quarter${remaining === 1 ? '' : 's'}.`);
    }
  }

  if (company.employees.morale < 45) {
    alerts.push(`Morale is ${Math.round(company.employees.morale)} and falling below the attrition threshold.`);
  }

  for (const event of visibleEvents(session, company.id)) {
    if (event.severity >= 0.5) alerts.push(event.title);
  }

  return alerts;
}

/* -------------------------------------------------------------------------- */
/*  The projection                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Project the aggregate down to what the player may see.
 *
 * Memoise this by session identity — it walks every collection once, which is
 * cheap, but not free on every render. `usePlayerView()` already does.
 */
function emptyCapTable(session: SessionState, companyId: string): CapTable {
  return {
    companyId,
    shareClasses: [],
    holdings: [],
    totalIssuedByClass: {},
    fullyDilutedShares: 0,
    optionPoolShares: 0,
    lastUpdatedQuarter: session.quarter,
  };
}

/**
 * Full detail for every company this seat directs, founding company first —
 * `controlledCompaniesOf`'s own order, carried straight through so a screen
 * that wants "just the group" never has to re-derive it.
 */
function controlledCompanyViewsOf(session: SessionState): ControlledCompanyView[] {
  return controlledCompaniesOf(session, PLAYER_ID).map((company) => ({
    company,
    capTable: session.capTables.find((entry) => entry.companyId === company.id) ?? emptyCapTable(session, company.id),
    researchProjects: session.researchProjects.filter((project) => project.companyId === company.id),
  }));
}

export function projectPlayerView(session: SessionState): PlayerView {
  const company = playerCompanyOf(session);
  const capTable = session.capTables.find((entry) => entry.companyId === company.id) ?? emptyCapTable(session, company.id);

  return {
    sessionId: session.sessionId,
    quarter: session.quarter,
    startYear: session.startYear,
    playerId: PLAYER_ID,
    // The quarter's itemised economic attribution, already redacted to this
    // seat by the engine. Null in a single-sector world, which has none.
    economyReport: projectEconomyReportForPlayer(session, PLAYER_ID),
    world: session.world,
    sectors: session.sectors,
    ownCompany: company,
    ownCapTable: capTable,
    ownResearchProjects: session.researchProjects.filter((project) => project.companyId === company.id),
    controlledCompanies: controlledCompanyViewsOf(session),
    visibleCompanies: session.companies.filter((rival) => rival.id !== company.id).map(redactRival),
    techGraph: techGraphForCompany(session.techGraph, company.id),
    quotes: session.quotes,
    disclosures: session.disclosures,
    activeEvents: visibleEvents(session, company.id),
    board: session.boards.find((board) => board.id === company.boardId) ?? null,
    boardProposals: session.boardProposals.filter((proposal) => proposal.companyId === company.id),
    opportunities: visibleOpportunities(session, company.id),
    contracts: session.governmentContracts.filter(
      (contract) =>
        contract.primeCompanyId === company.id ||
        contract.consortiumMemberIds.includes(company.id) ||
        contract.subcontractors.some((sub) => sub.companyId === company.id),
    ),
    deals: session.deals.filter((deal) => deal.proposerId === company.id || deal.counterpartyId === company.id),
    leaderboards: session.leaderboards,
    objectives: session.objectives.filter((objective) => objective.playerId === null || objective.playerId === PLAYER_ID),
    alerts: buildAlerts(session),
    // The one fact that changes what the shell renders rather than what a screen
    // says: a seat whose company was wound up sees the verdict, not the game.
    eliminatedQuarter: eliminatedQuarterOf(session),
  };
}

/**
 * The quarter this seat was wound up, or null while it is playing.
 *
 * Read off the seat rather than off the company: a husk is still `isActive` so
 * that somebody can buy it, and "the company has no staff" is not the same
 * statement as "this player is out of the game".
 */
export function eliminatedQuarterOf(session: SessionState): number | null {
  const seat = session.players.find((player) => player.playerId === PLAYER_ID) ?? null;
  return seat?.eliminatedQuarter ?? null;
}

/**
 * Research programmes visible to the player: their own, secret ones included,
 * plus every published rival programme. A rival's secret work is absent.
 */
export function visibleResearchProjects(session: SessionState) {
  return researchProjectsForCompany(session, playerCompanyOf(session).id);
}

/* -------------------------------------------------------------------------- */
/*  Small derived readings                                                     */
/* -------------------------------------------------------------------------- */

/** Quotes for one instrument, oldest first. */
export function quotesFor(session: SessionState, instrumentId: string): Quote[] {
  return session.quotes.filter((quote) => quote.instrumentId === instrumentId).sort((a, b) => a.quarter - b.quarter);
}

/** The most recent quote for an instrument, or null. */
export function latestQuote(session: SessionState, instrumentId: string): Quote | null {
  const quotes = quotesFor(session, instrumentId);
  return quotes.length === 0 ? null : (quotes[quotes.length - 1] ?? null);
}

/** Derived metrics for a company in the current quarter, or null before the first resolve. */
export function metricsFor(session: SessionState, companyId: string) {
  return session.companyMetrics.find((entry) => entry.companyId === companyId) ?? null;
}

/**
 * Market capitalisation of a company: the last quote when listed, the
 * fundamental anchor when private. Never invented — both come from state.
 */
export function marketCapOf(session: SessionState, companyId: string): number {
  const company = session.companies.find((entry) => entry.id === companyId) ?? null;
  if (company === null) return 0;
  if (company.instrumentId !== null) {
    const quote = latestQuote(session, company.instrumentId);
    if (quote !== null && quote.marketCapUsd > 0) return quote.marketCapUsd;
  }
  const metrics = metricsFor(session, companyId);
  if (metrics !== null && metrics.marketCapUsd > 0) return metrics.marketCapUsd;
  const anchor = session.valuationAnchors.find((entry) => entry.companyId === companyId);
  return anchor?.anchorValueUsd ?? 0;
}

/**
 * The founder's personal net worth, as the leaderboard measures it.
 *
 * The board is preferred where it exists because it is the figure the founder is
 * ranked on; `founderPortfolioOf` is the same arithmetic run over current state,
 * and it is what answers before the first quarter has resolved — where the old
 * fallback said "personal cash" and quietly omitted the founder's own equity.
 */
export function founderNetWorth(session: SessionState): number {
  const character = playerCharacterOf(session);
  const board = session.leaderboards.find((entry) => entry.board === 'founder_wealth');
  const row = board?.entries.find((entry) => entry.subjectId === character.id);
  return row?.value ?? founderPortfolioOf(session, PLAYER_ID).netWorthUsd;
}

/** One leaderboard by name, or null when the session has not resolved a quarter yet. */
export function leaderboardOf(session: SessionState, board: Leaderboard['board']): Leaderboard | null {
  return session.leaderboards.find((entry) => entry.board === board) ?? null;
}
