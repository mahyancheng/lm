/**
 * The Chief of Staff dossier: `SessionState` → `ChiefOfStaffDossier`.
 *
 * The role used to be handed two paragraphs of prose and asked to translate an
 * instruction. It is now handed the company, typed — finances with the last
 * eight filed quarters, product lines, people, board and ownership, markets,
 * capital, research, government, the public record that names it, what is
 * waiting on the founder, and the one section that changes what the role can
 * honestly say: **the actions available to this company right now**.
 *
 * That last section is not written here. `availableActionsFor` in
 * `@frontier/simulation` produces it by probing the engine's own validator, so
 * a bound the validator would refuse can never appear as available. This module
 * only assembles; it decides nothing.
 *
 * The information boundary is the same one every briefing keeps: the player's
 * own company in full, and rivals reduced to what the public record shows.
 * Nothing here reaches for another company's cash, research or undisclosed
 * holdings.
 */

import type {
  ChiefOfStaffDossier,
  Company,
  CosApproach,
  CosAvailableAction,
  CosFeedItem,
  CosNewEntrant,
  CosPerson,
  CosProductLine,
  CosRival,
  CosThreshold,
  SessionState,
  SimEvent,
} from '@frontier/contracts';
import { OWNERSHIP_THRESHOLDS, quarterLabel } from '@frontier/contracts';
import {
  availableActionsFor,
  categoryOf,
  consolidatedEnterpriseValueOf,
  controlledCompaniesOf,
  groupStatementOf,
  projectPublicRecord,
  recentFinancialQuarters,
} from '@frontier/simulation';
import { PLAYER_ID, playerCharacterOf, playerCompanyOf, playerSeat } from './engine';
import { latestQuote, marketCapOf, metricsFor } from './playerView';
import { openDecisions, worldBriefing } from './briefings';

/** How many quarters of filed accounts the role is given. Stage one files forty; eight is a conversation. */
export const DOSSIER_HISTORY_QUARTERS = 8;

/** How many public-record items the role is given, newest first. */
export const DOSSIER_FEED_ITEMS = 10;

/* -------------------------------------------------------------------------- */
/*  Sections                                                                   */
/* -------------------------------------------------------------------------- */

function productLinesOf(company: Company): CosProductLine[] {
  return company.products.slice(0, 24).map((product) => ({
    productId: product.id,
    name: product.name,
    segment: product.segment,
    categoryId: categoryOf(company, product).id,
    unitLabel: categoryOf(company, product).unitLabel,
    pricePerSeatUsd: product.pricePerSeat,
    activeCustomers: product.activeCustomers,
    grossMarginPct: product.grossMarginPct,
    churnQuarterly: product.churnQuarterly,
    qualityScore: product.qualityScore,
    // Price times seats, which is what the founder means by "what does that
    // line bring in". The engine's own recognised revenue is on the filed
    // statement; this is the run rate they can reason about.
    revenueQuarterlyUsd: product.pricePerSeat * product.activeCustomers,
    isActive: product.isActive,
  }));
}

function keyPeopleOf(session: SessionState, company: Company): CosPerson[] {
  return session.characters
    .filter((character) => character.isActive && character.companyId === company.id)
    .slice(0, 12)
    .map((character) => ({
      characterId: character.id,
      name: character.name,
      role: character.role,
      title: character.title,
      isCeo: character.id === company.ceoCharacterId,
    }));
}

/** The founder's own fraction of their company, from the cap table. */
function founderOwnershipOf(session: SessionState, company: Company): number {
  const table = session.capTables.find((entry) => entry.companyId === company.id) ?? null;
  if (table === null) return 0;
  const character = playerCharacterOf(session);
  const issued = table.shareClasses.reduce((sum, shareClass) => sum + shareClass.issuedShares, 0);
  if (issued <= 0) return 0;
  const held = table.holdings
    .filter((holding) => holding.holderId === character.id || holding.holderId === PLAYER_ID)
    .reduce((sum, holding) => sum + holding.shares, 0);
  return held / issued;
}

function thresholdsFor(ownership: number): CosThreshold[] {
  return OWNERSHIP_THRESHOLDS.map((threshold) => ({
    label: threshold.label.replace(/_/g, ' '),
    fraction: threshold.pct,
    reached: ownership >= threshold.pct,
  }));
}

/** Rivals, as the public record shows them. A private rival discloses nothing. */
function rivalsOf(session: SessionState, company: Company): CosRival[] {
  return session.companies
    .filter((entry) => entry.isActive && entry.id !== company.id)
    .slice(0, 24)
    .map((rival) => ({
      companyId: rival.id,
      name: rival.name,
      ticker: rival.ticker,
      sectorId: rival.sectorId,
      isPublic: rival.isPublic,
      // Absent means withheld, never zero: a private company's revenue is not
      // nought, it is undisclosed, and a null says so.
      revenueQuarterlyUsd: rival.isPublic ? rival.financials.revenueQuarterly : null,
      marketCapUsd: rival.isPublic ? marketCapOf(session, rival.id) : null,
      enterpriseReputation: rival.reputation.enterprise,
    }));
}

/**
 * Companies founded since last quarter.
 *
 * Market entry replaces a wound-up company with a new one in the same sector,
 * and a founder who does not hear about it finds out when the newcomer takes a
 * customer. Everything here is public: a founding is announced, and the cheque
 * is stated in the announcement.
 */
function newEntrantsOf(session: SessionState, company: Company): CosNewEntrant[] {
  const since = session.quarter - 1;
  return session.companies
    .filter((entry) => entry.isActive && entry.id !== company.id && entry.foundedQuarter >= since && entry.foundedQuarter > 0)
    .slice(0, 4)
    .map((entrant) => {
      const round = session.fundingRounds.find((entry) => entry.companyId === entrant.id && entry.stage === 'seed');
      const disclosure = session.disclosures.find((entry) => entry.companyId === entrant.id && typeof entry.metrics['seedCapital'] === 'number');
      return {
        companyId: entrant.id,
        name: entrant.name,
        sectorId: entrant.sectorId,
        region: entrant.region,
        foundedQuarter: entrant.foundedQuarter,
        seedCapitalUsd: round?.amount ?? (disclosure?.metrics['seedCapital'] ?? 0),
        inYourRegion: entrant.region === company.region && entrant.sector === company.sector,
        replacesName: null,
      };
    });
}

/** Open approaches: term sheets and deals awaiting an answer, and activist letters. */
function approachesOf(session: SessionState, company: Company): CosApproach[] {
  const named = (id: string): string => session.companies.find((entry) => entry.id === id)?.name ?? session.capitalEntities?.find((entry) => entry.id === id)?.name ?? id;

  const deals: CosApproach[] = session.deals
    .filter((deal) => deal.status === 'proposed' && deal.counterpartyId === company.id)
    .map((deal) => ({
      id: deal.id,
      kind: deal.proposerKind === 'company' ? ('deal' as const) : ('term_sheet' as const),
      fromName: named(deal.proposerId),
      summary: deal.summary.slice(0, 300),
      quarter: deal.createdQuarter,
    }));

  const campaigns: CosApproach[] = (session.activistCampaigns ?? [])
    .filter((campaign) => campaign.targetCompanyId === company.id && campaign.outcome === null)
    .map((campaign) => ({
      id: campaign.id,
      kind: 'activist_letter' as const,
      fromName: named(campaign.entityId),
      summary: `${campaign.stage.replace(/_/g, ' ')} at a ${campaign.stakePct}% stake, demanding ${campaign.demands.join(', ').replace(/_/g, ' ')}`.slice(0, 300),
      quarter: campaign.openedQuarter,
    }));

  return [...deals, ...campaigns].slice(0, 16);
}

/**
 * Debt headroom: what the balance sheet would still support.
 *
 * A heuristic for conversation, deliberately conservative, and labelled as one
 * in the contract. The engine decides what actually clears — this is only here
 * so "could we borrow?" gets an order of magnitude rather than a shrug.
 */
function debtHeadroomOf(session: SessionState, company: Company): number {
  const annualRevenue = Math.max(0, company.financials.revenueQuarterly) * 4;
  const availability = session.world.capitalMarkets.debtAvailability;
  return Math.max(0, annualRevenue * availability - company.financials.debt);
}

/**
 * STAGE 5 — the group, consolidated, for whichever seat this dossier is for.
 *
 * Deliberately independent of which company the dossier is otherwise built
 * for: "how is the group doing" means the same thing whether the founder is
 * currently looking at the founding company or a subsidiary. `groupStatementOf`
 * and `consolidatedEnterpriseValueOf` are the same functions the Group screen
 * itself reads — nothing here is a second answer to a question those already
 * answer.
 */
function groupSectionOf(session: SessionState): ChiefOfStaffDossier['group'] {
  const companies = controlledCompaniesOf(session, PLAYER_ID);
  const founding = companies[0] ?? null;
  const statement = groupStatementOf(session, PLAYER_ID);
  const headcount = companies.reduce((sum, company) => {
    const staff = company.employees;
    return sum + staff.engineers + staff.researchers + staff.sales + staff.ops + staff.execs;
  }, 0);
  return {
    companyCount: Math.max(1, companies.length),
    revenueUsd: statement.income.revenueUsd,
    netIncomeUsd: statement.income.netIncomeUsd,
    cashUsd: statement.balance.cashUsd,
    debtUsd: statement.balance.debtUsd,
    headcount,
    marketValueUsd: founding === null ? 0 : Math.max(0, consolidatedEnterpriseValueOf(session, founding)),
  };
}

function feedFor(session: SessionState, company: Company, ledger: readonly SimEvent[]): CosFeedItem[] {
  return projectPublicRecord(session, PLAYER_ID, { ledger: [...ledger] })
    .filter((item) => item.companyIds.length === 0 || item.companyIds.includes(company.id))
    .slice(0, DOSSIER_FEED_ITEMS)
    .map((item) => ({
      itemId: item.id,
      quarter: item.quarter,
      kind: item.kind,
      headline: item.headline,
      whyItMatters: item.whyItMatters,
    }));
}

/** The world conditions that bear on this company, one note per line. */
function worldNotesOf(session: SessionState): string[] {
  return worldBriefing(session)
    .split('\n')
    .map((line) => line.trim().slice(0, 300))
    .filter((line) => line.length > 0)
    .slice(0, 12);
}

/* -------------------------------------------------------------------------- */
/*  The dossier                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Build the whole dossier for one company this seat directs.
 *
 * `company` defaults to the founding one — every caller from before STAGE 5's
 * switcher existed still gets exactly the dossier it always did. A caller that
 * follows the active company passes it explicitly, and everything below reads
 * from it rather than re-deriving the founding company, so a founder directing
 * a subsidiary gets that subsidiary's own finances, products, people, board
 * and available actions — never the founding company's by mistake.
 *
 * `ledger` is the seat's own projected rows from the last resolution, which
 * only fills in *why* a public-record item mattered; it can never add an item
 * the projection withheld.
 */
export function buildChiefOfStaffDossier(
  session: SessionState,
  ledger: readonly SimEvent[] = [],
  company: Company = playerCompanyOf(session),
): ChiefOfStaffDossier {
  const founder = playerCharacterOf(session);
  const metrics = metricsFor(session, company.id);
  const staff = company.employees;
  const board = session.boards.find((entry) => entry.id === company.boardId) ?? null;
  const quote = company.instrumentId === null ? null : latestQuote(session, company.instrumentId);
  const sector = session.sectors[company.sectorId] ?? null;
  const ownership = founderOwnershipOf(session, company);
  const table = session.capTables.find((entry) => entry.companyId === company.id) ?? null;

  const availableActions: CosAvailableAction[] = availableActionsForSession(session, company.id);

  return {
    companyName: company.name,
    founderName: founder.name,
    quarterLabel: quarterLabel(session.startYear, session.quarter),
    posture: company.posture,

    finances: {
      cashUsd: company.financials.cash,
      debtUsd: company.financials.debt,
      revenueQuarterlyUsd: company.financials.revenueQuarterly,
      quarterlyBurnUsd: company.financials.quarterlyBurn,
      // Before the first resolve there are no derived metrics. Zero runway
      // would read as "we are out of money"; a full window reads as "unknown",
      // which is what it is, and the history below is empty to match.
      runwayQuarters: metrics?.runwayQuarters ?? 200,
      grossMarginPct: metrics?.grossMarginPct ?? 0,
      operatingMarginPct: metrics?.operatingMarginPct ?? 0,
      history: [...recentFinancialQuarters(company, DOSSIER_HISTORY_QUARTERS)],
    },

    group: groupSectionOf(session),

    products: {
      lines: productLinesOf(company),
      computeOwned: company.compute.ownedAccelerators,
      computeReserved: company.compute.reservedAccelerators,
      computeUtilisationPct: company.compute.computeUtilisation,
      trainingAllocationPct: company.compute.trainingAllocation,
      reservationExpiryQuarter: company.compute.reservationExpiryQuarter,
      cloudSpendQuarterlyUsd: company.compute.cloudSpendQuarterly,
    },

    people: {
      engineers: staff.engineers,
      researchers: staff.researchers,
      sales: staff.sales,
      ops: staff.ops,
      execs: staff.execs,
      total: staff.engineers + staff.researchers + staff.sales + staff.ops + staff.execs,
      moralePct: staff.morale,
      attritionPct: staff.attrition,
      openRoles: staff.openRoles,
      payrollQuarterlyUsd: company.financials.payroll,
      keyCharacters: keyPeopleOf(session, company),
    },

    governance: {
      hasBoard: board !== null,
      seatsAuthorised: board?.seatsAuthorised ?? 0,
      seatsFilled: board?.directors.length ?? 0,
      founderSeats: board === null ? 0 : board.directors.filter((director) => director.characterId === founder.id).length,
      founderOwnershipPct: ownership,
      thresholds: thresholdsFor(ownership),
      openProposals: session.boardProposals
        .filter((proposal) => proposal.companyId === company.id && (proposal.status === 'tabled' || proposal.status === 'draft'))
        .slice(0, 12)
        .map((proposal) => ({
          proposalId: proposal.id,
          kind: proposal.kind,
          title: proposal.title,
          status: proposal.status,
          decisionQuarter: proposal.decisionQuarter,
          amountUsd: proposal.amountUsd,
        })),
      isCeo: company.ceoCharacterId === founder.id,
    },

    markets: {
      isPublic: company.isPublic,
      ticker: company.ticker,
      sharePriceUsd: quote?.price ?? null,
      marketCapUsd: company.isPublic ? marketCapOf(session, company.id) : null,
      sectorId: company.sectorId,
      sectorSentiment: sector?.sentiment ?? 0,
      sectorMultiple: sector?.multiple ?? 0,
      sectorDemand: sector?.demand ?? 0,
      sectorPriceIndex: session.sectorPrices?.[company.sector] ?? null,
      sectorShortage: session.sectorShortages?.[company.sector] ?? null,
      rivals: rivalsOf(session, company),
      newEntrants: newEntrantsOf(session, company),
    },

    capital: {
      funds: (session.capitalEntities ?? []).slice(0, 12).map((entity) => ({
        entityId: entity.id,
        name: entity.name,
        kind: entity.kind,
        dryPowderUsd: entity.dryPowderUsd,
        holdsStakePct: stakeOf(session, company.id, entity.id),
        thesis: entity.thesis,
      })),
      approaches: approachesOf(session, company),
      debtHeadroomUsd: debtHeadroomOf(session, company),
      dividendPayoutPct: company.dividendPolicyPct ?? 0,
      sharesOutstanding: table?.shareClasses.reduce((sum, shareClass) => sum + shareClass.issuedShares, 0) ?? 0,
      ipoWindow: session.world.capitalMarkets.ipoWindow,
      ventureLiquidity: session.world.capitalMarkets.ventureLiquidity,
      debtAvailability: session.world.capitalMarkets.debtAvailability,
    },

    research: {
      budgetQuarterlyUsd: company.financials.rdSpend,
      projects: session.researchProjects
        .filter((project) => project.companyId === company.id && (project.status === 'active' || project.status === 'paused'))
        .slice(0, 16)
        .map((project) => ({
          projectId: project.id,
          nodeId: project.targetNodeId,
          title: session.techGraph.nodes.find((node) => node.id === project.targetNodeId)?.title ?? project.targetNodeId,
          progressPct: project.progress,
          internalConfidencePct: project.internalConfidence,
          researchers: project.talentAllocated,
          computeUnits: project.computeAllocated,
          budgetQuarterlyUsd: project.budgetQuarterly,
          quartersRemaining: Math.max(0, project.expectedQuarters - project.quartersElapsed),
          isSecret: project.isSecret,
          status: project.status,
        })),
      availableNodes: session.techGraph.nodes
        .filter(
          (node) =>
            node.achievedByCompanyId !== company.id &&
            !session.researchProjects.some(
              (project) => project.companyId === company.id && project.targetNodeId === node.id && (project.status === 'active' || project.status === 'paused'),
            ),
        )
        .slice(0, 24)
        .map((node) => ({ nodeId: node.id, title: node.title })),
    },

    government: {
      openProgrammes: session.procurementOpportunities
        .filter(
          (opportunity) =>
            opportunity.status === 'open' && (opportunity.visibility === 'public' || opportunity.invitedCompanyIds.includes(company.id)),
        )
        .slice(0, 16)
        .map((opportunity) => ({
          opportunityId: opportunity.id,
          programme: opportunity.programme,
          agencyName: session.agencies.find((agency) => agency.id === opportunity.agencyId)?.name ?? '',
          maxValueUsd: opportunity.maxValue,
          closeQuarter: opportunity.closeQuarter,
          invited: opportunity.invitedCompanyIds.includes(company.id),
          alreadyBid: session.governmentBids.some(
            (bid) => bid.bidderCompanyId === company.id && bid.opportunityId === opportunity.id && bid.status !== 'withdrawn',
          ),
        })),
      liveContracts: session.governmentContracts
        .filter((contract) => contract.status === 'active' && (contract.primeCompanyId === company.id || contract.consortiumMemberIds.includes(company.id)))
        .slice(0, 16)
        .map((contract) => ({
          contractId: contract.id,
          programme: (session.procurementOpportunities.find((entry) => entry.id === contract.opportunityId)?.programme ?? contract.opportunityId).slice(0, 140),
          valueUsd: contract.totalValueUsd,
        })),
      pastPerformance: company.governmentPastPerformance,
    },

    feed: feedFor(session, company, ledger),
    openDecisions: openDecisions(session, company).map((decision) => decision.slice(0, 300)).slice(0, 20),
    availableActions,
    worldNotes: worldNotesOf(session),
  };
}

/* -------------------------------------------------------------------------- */
/*  Available actions, memoised                                                */
/* -------------------------------------------------------------------------- */

/**
 * One probe pass per (session, acting company).
 *
 * `availableActionsFor` runs the validator once per action type — thirty-nine
 * probes — which is cheap but not free, and several screens want the same
 * answer at once. The store replaces the session object whenever anything
 * changes, and STAGE 5 lets the acting company change independently of it (the
 * switcher), so both are the cache key: a stale entry is impossible for
 * either to produce, and a changed quarter or a changed active company both
 * recompute. `companyId` defaults to the founding company, so every caller
 * from before the switcher existed still gets exactly the answer it always
 * did.
 */
let probeCache: { readonly session: SessionState; readonly companyId: string; readonly actions: CosAvailableAction[] } | null = null;

export function availableActionsForSession(session: SessionState, companyId?: string): CosAvailableAction[] {
  const seat = playerSeat(session);
  const targetCompanyId = companyId ?? seat?.companyId ?? null;
  if (targetCompanyId === null) return [];
  if (probeCache !== null && probeCache.session === session && probeCache.companyId === targetCompanyId) return probeCache.actions;
  const actions =
    seat === null ? [] : availableActionsFor(session, { playerId: seat.playerId, companyId: targetCompanyId, characterId: seat.characterId });
  probeCache = { session, companyId: targetCompanyId, actions };
  return actions;
}

/** The entry for one action type on this session (for the named company, defaulting to the founding one), or null when there is no seat. */
export function availabilityOf(session: SessionState, type: CosAvailableAction['type'], companyId?: string): CosAvailableAction | null {
  return availableActionsForSession(session, companyId).find((entry) => entry.type === type) ?? null;
}

/** A holder's fraction of one company, from the cap table. Zero when they hold none. */
function stakeOf(session: SessionState, companyId: string, holderId: string): number {
  const table = session.capTables.find((entry) => entry.companyId === companyId) ?? null;
  if (table === null) return 0;
  const issued = table.shareClasses.reduce((sum, shareClass) => sum + shareClass.issuedShares, 0);
  if (issued <= 0) return 0;
  const held = table.holdings.filter((holding) => holding.holderId === holderId).reduce((sum, holding) => sum + holding.shares, 0);
  return held / issued;
}
