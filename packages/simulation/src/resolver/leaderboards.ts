/**
 * @frontier/simulation — resolver/leaderboards.ts
 *
 * The sixteenth phase: ten boards, recomputed from state every quarter.
 *
 * Success in this game is plural, and the leaderboards are where that is made
 * mechanical rather than rhetorical. A technically brilliant company can lose
 * financially; a rich founder can lose control; a small company can become
 * indispensable to governments. Ten independent rankings say so out loud, and
 * the composite that sits on top of them consumes **percentiles, never raw
 * dollars** — otherwise wealth eventually overwhelms every other dimension and
 * the composite stops saying anything.
 *
 * Nothing here is submitted by a client. Every figure is derived from state the
 * engine wrote, which is what makes `authoritative_backend` checkable.
 */

import type {
  Character,
  Company,
  Leaderboard,
  LeaderboardBoard,
  LeaderboardEntry,
  ResolverContext,
  SessionState,
} from '@frontier/contracts';
import { FOUNDER_INDEX_WEIGHTS, LEADERBOARD_BOARDS, founderIndex } from '@frontier/contracts';
import { percentileRanks } from '@frontier/shared';

/** One subject's raw value on one board, before ranking. */
interface Scored {
  readonly subjectId: string;
  readonly subjectKind: 'player' | 'company' | 'character';
  readonly label: string;
  readonly value: number;
}

/* -------------------------------------------------------------------------- */
/*  Component metrics                                                          */
/* -------------------------------------------------------------------------- */

const activeCompanies = (draft: SessionState): Company[] =>
  draft.companies.filter((company) => company.isActive).sort((a, b) => compare(a.id, b.id));

const founders = (draft: SessionState): Character[] =>
  draft.characters
    .filter((character) => character.isActive && (character.isPlayer || character.role === 'founder_ceo'))
    .sort((a, b) => compare(a.id, b.id));

const metricsFor = (draft: SessionState, companyId: string) => draft.companyMetrics.find((m) => m.companyId === companyId) ?? null;

/** Controlled enterprise value, from metrics where the phase before wrote them. */
export function enterpriseValueOf(draft: SessionState, company: Company): number {
  const metrics = metricsFor(draft, company.id);
  if (metrics !== null && metrics.enterpriseValueUsd > 0) return metrics.enterpriseValueUsd;
  return Math.max(0, company.financials.revenueQuarterly * 4 * 6 + company.financials.cash - company.financials.debt);
}

/** Trailing revenue where available, annualised current revenue otherwise. */
export function revenueOf(draft: SessionState, company: Company): number {
  const metrics = metricsFor(draft, company.id);
  if (metrics !== null && metrics.revenueTtm > 0) return metrics.revenueTtm;
  return company.financials.revenueQuarterly * 4;
}

export function operatingIncomeOf(company: Company): number {
  const f = company.financials;
  return f.revenueQuarterly - f.cogs - f.payroll - f.marketing - f.rdSpend;
}

/**
 * Contribution to the technological frontier.
 *
 * Nodes actually demonstrated dominate; capability breadth and live programmes
 * contribute, so a company two quarters from a demonstration is not scored as
 * though it had done nothing.
 */
export function innovationScoreOf(draft: SessionState, company: Company): number {
  let achieved = 0;
  for (const node of draft.techGraph.nodes) {
    if (node.achievedByCompanyId === company.id) achieved += 10 * (0.5 + node.novelty);
  }
  const capabilities = Object.values(company.techCapabilities);
  const breadth = capabilities.length === 0 ? 0 : capabilities.reduce((sum, value) => sum + value, 0) / capabilities.length;
  let programmes = 0;
  for (const project of draft.researchProjects) {
    if (project.companyId !== company.id || project.status !== 'active') continue;
    programmes += project.progress * 3;
  }
  return achieved + breadth * 5 + programmes;
}

/**
 * Ownership and control across the industry.
 *
 * Half of a company's own value, plus the full value of every stake it holds in
 * someone else — a founder who owns minority positions across the sector is
 * exercising influence disproportionate to the size of their own business, and
 * this board is where that shows up.
 */
export function marketInfluenceOf(draft: SessionState, company: Company): number {
  let influence = enterpriseValueOf(draft, company) * 0.5;
  for (const table of draft.capTables) {
    if (table.companyId === company.id) continue;
    const other = draft.companies.find((candidate) => candidate.id === table.companyId);
    if (other === undefined || !other.isActive) continue;
    const issued = table.shareClasses.reduce((sum, klass) => sum + klass.issuedShares, 0);
    if (issued <= 0) continue;
    let held = 0;
    for (const holding of table.holdings) if (holding.holderId === company.id) held += holding.shares;
    if (held <= 0) continue;
    influence += (held / issued) * enterpriseValueOf(draft, other);
  }
  return influence;
}

/** Procurement credibility: the formal score plus what is actually on contract. */
export function governmentStandingOf(draft: SessionState, company: Company): number {
  let backlog = 0;
  for (const contract of draft.governmentContracts) {
    if (contract.status !== 'active') continue;
    if (contract.primeCompanyId !== company.id && !contract.consortiumMemberIds.includes(company.id)) continue;
    backlog += contract.totalValueUsd - contract.recognisedToDateUsd;
  }
  return company.governmentPastPerformance + Math.min(50, backlog / 1e9);
}

/** Multi-audience trust, as the plain mean of the five reputations. */
export function reputationOf(company: Company): number {
  const r = company.reputation;
  return (r.public + r.developer + r.enterprise + r.government + r.investor) / 5;
}

/** Quarters of cash at the current burn; a cash-generative company scores the cap. */
export function financialResilienceOf(draft: SessionState, company: Company): number {
  const metrics = metricsFor(draft, company.id);
  if (metrics !== null) return metrics.runwayQuarters;
  const burn = Math.max(0, -company.financials.quarterlyBurn);
  return burn <= 0 ? 200 : Math.min(200, company.financials.cash / burn);
}

/** A founder's own money: personal wealth plus the value of what they hold. */
export function founderWealthOf(draft: SessionState, character: Character): number {
  let holdings = 0;
  for (const table of draft.capTables) {
    for (const holding of table.holdings) {
      if (holding.holderId !== character.id) continue;
      const security = draft.securities.find((candidate) => candidate.id === holding.securityId);
      const company = security === undefined ? undefined : draft.companies.find((candidate) => candidate.id === security.companyId);
      if (company === undefined) continue;
      const issued = table.shareClasses.reduce((sum, klass) => sum + klass.issuedShares, 0);
      const perShare = issued > 0 ? enterpriseValueOf(draft, company) / issued : 0;
      holdings += holding.shares * perShare;
    }
  }
  return character.personalWealthUsd + holdings;
}

/** Weighted progress against this character's session objectives, 0..1. */
export function objectiveProgressOf(draft: SessionState, character: Character): number {
  const player = draft.players.find((seat) => seat.characterId === character.id) ?? null;
  const relevant = draft.objectives.filter((objective) => objective.playerId === null || (player !== null && objective.playerId === player.playerId));
  if (relevant.length === 0) return 0;
  const weight = relevant.reduce((sum, objective) => sum + objective.weight, 0);
  if (weight <= 0) return relevant.reduce((sum, objective) => sum + objective.progress, 0) / relevant.length;
  return relevant.reduce((sum, objective) => sum + objective.progress * objective.weight, 0) / weight;
}

/** The company a founder's score is computed against. */
function companyOf(draft: SessionState, character: Character): Company | null {
  const player = draft.players.find((seat) => seat.characterId === character.id) ?? null;
  const bySeat = player === null ? null : draft.companies.find((company) => company.id === player.companyId) ?? null;
  if (bySeat !== null) return bySeat;
  if (character.companyId !== null) return draft.companies.find((company) => company.id === character.companyId) ?? null;
  return null;
}

/* -------------------------------------------------------------------------- */
/*  The phase                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Recompute all ten boards and write them into the draft.
 *
 * Returns the boards it built so the resolver can log the movement that matters.
 */
export function rebuildLeaderboards(draft: SessionState, ctx: ResolverContext): Leaderboard[] {
  const companies = activeCompanies(draft);
  const people = founders(draft);
  const previous = new Map<string, LeaderboardEntry>();
  for (const board of draft.leaderboards) {
    for (const entry of board.entries) previous.set(`${board.board}:${entry.subjectId}`, entry);
  }

  const companyScores = (value: (company: Company) => number): Scored[] =>
    companies.map((company) => ({ subjectId: company.id, subjectKind: 'company' as const, label: company.name, value: value(company) }));

  const characterScores = (value: (character: Character) => number): Scored[] =>
    people.map((character) => ({ subjectId: character.id, subjectKind: 'character' as const, label: character.name, value: value(character) }));

  const scoresByBoard = new Map<LeaderboardBoard, Scored[]>();
  scoresByBoard.set('company_value', companyScores((company) => enterpriseValueOf(draft, company)));
  scoresByBoard.set('revenue', companyScores((company) => revenueOf(draft, company)));
  scoresByBoard.set('profit', companyScores(operatingIncomeOf));
  scoresByBoard.set('innovation', companyScores((company) => innovationScoreOf(draft, company)));
  scoresByBoard.set('market_influence', companyScores((company) => marketInfluenceOf(draft, company)));
  scoresByBoard.set('government', companyScores((company) => governmentStandingOf(draft, company)));
  scoresByBoard.set('reputation', companyScores(reputationOf));
  scoresByBoard.set('founder_wealth', characterScores((character) => founderWealthOf(draft, character)));
  scoresByBoard.set('network', characterScores((character) => character.connectionLevel));

  /* --- the composite ------------------------------------------------------ */
  const companyPercentile = (value: (company: Company) => number): Map<string, number> => {
    const values = companies.map(value);
    const ranks = percentileRanks(values);
    const out = new Map<string, number>();
    companies.forEach((company, index) => out.set(company.id, ranks[index] ?? 0.5));
    return out;
  };

  const enterprisePct = companyPercentile((company) => enterpriseValueOf(draft, company));
  const innovationPct = companyPercentile((company) => innovationScoreOf(draft, company));
  const reputationPct = companyPercentile(reputationOf);
  const governmentPct = companyPercentile((company) => governmentStandingOf(draft, company));
  const resiliencePct = companyPercentile((company) => financialResilienceOf(draft, company));

  const wealthRanks = percentileRanks(people.map((character) => founderWealthOf(draft, character)));
  const networkRanks = percentileRanks(people.map((character) => character.connectionLevel));
  const objectiveRanks = percentileRanks(people.map((character) => objectiveProgressOf(draft, character)));

  const compositeScores: Scored[] = people.map((character, index) => {
    const company = companyOf(draft, character);
    const inputs = {
      wealth: wealthRanks[index] ?? 0.5,
      enterprise: company === null ? 0 : enterprisePct.get(company.id) ?? 0.5,
      innovation: company === null ? 0 : innovationPct.get(company.id) ?? 0.5,
      reputation: company === null ? 0 : reputationPct.get(company.id) ?? 0.5,
      network: networkRanks[index] ?? 0.5,
      government: company === null ? 0 : governmentPct.get(company.id) ?? 0.5,
      financialResilience: company === null ? 0 : resiliencePct.get(company.id) ?? 0.5,
      sessionObjectives: objectiveRanks[index] ?? 0.5,
    };
    return { subjectId: character.id, subjectKind: 'character' as const, label: character.name, value: founderIndex(inputs) };
  });
  scoresByBoard.set('founder_index', compositeScores);

  /* --- rank them ---------------------------------------------------------- */
  const boards: Leaderboard[] = [];
  for (const board of LEADERBOARD_BOARDS) {
    const scores = scoresByBoard.get(board) ?? [];
    boards.push({ board, quarter: draft.quarter, entries: rank(board, scores, previous) });
  }
  draft.leaderboards = boards;

  const eventId = ctx.emit({
    sessionId: draft.sessionId,
    quarter: draft.quarter,
    type: 'leaderboard_updated',
    actorId: null,
    targetId: null,
    payload: {
      boards: boards.map((board) => ({
        board: board.board,
        leader: board.entries[0]?.subjectId ?? null,
        leaderValue: board.entries[0] === undefined ? null : roundTo(board.entries[0].value, 4),
      })),
      founderIndexWeights: FOUNDER_INDEX_WEIGHTS,
    },
    visibility: 'public',
  });

  for (const board of boards) {
    const leader = board.entries[0];
    if (leader === undefined) continue;
    if (leader.previousRank === null || leader.previousRank === 1) continue;
    ctx.log({
      phase: 'leaderboard_update',
      text: `${leader.label} took the top of the ${board.board.replace(/_/g, ' ')} board.`,
      deltaLabel: `#${leader.previousRank} to #1`,
      refEventIds: [eventId],
      tone: 'positive',
      subjectId: leader.subjectId,
    });
  }

  return boards;
}

/** Sort, rank and attach movement against the previous quarter. */
function rank(board: LeaderboardBoard, scores: readonly Scored[], previous: Map<string, LeaderboardEntry>): LeaderboardEntry[] {
  const ranks = percentileRanks(scores.map((score) => score.value));
  const withPercentile = scores.map((score, index) => ({ score, percentile: ranks[index] ?? 0.5 }));

  withPercentile.sort((a, b) =>
    a.score.value !== b.score.value ? b.score.value - a.score.value : compare(a.score.subjectId, b.score.subjectId),
  );

  return withPercentile.map((entry, index) => {
    const before = previous.get(`${board}:${entry.score.subjectId}`) ?? null;
    return {
      rank: index + 1,
      previousRank: before?.rank ?? null,
      subjectId: entry.score.subjectId,
      subjectKind: entry.score.subjectKind,
      label: entry.score.label.slice(0, 80),
      value: roundTo(entry.score.value, 4),
      percentile: clamp01(entry.percentile),
      delta: roundTo(entry.score.value - (before?.value ?? entry.score.value), 4),
    };
  });
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

function roundTo(value: number, decimals: number): number {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
