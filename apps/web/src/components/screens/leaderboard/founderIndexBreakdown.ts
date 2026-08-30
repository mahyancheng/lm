/**
 * Taking the composite apart, exactly the way the engine put it together.
 *
 * The Founder Index consumes eight percentiles. Six are published on boards of
 * their own and are read from there; two — financial resilience and session
 * objectives — have no board, so they are recomputed with the same
 * `percentileRanks` the engine uses, over the same populations, in the same
 * order-independent way.
 *
 * The breakdown carries its own reconciliation: the weighted sum computed here
 * against the composite the engine published. A screen that shows the working
 * has to be willing to show a disagreement.
 */

import type { LeaderboardBoard, LeaderboardEntry, SessionState } from '@frontier/contracts';
import { FOUNDER_INDEX_WEIGHTS, founderIndex, type FounderIndexComponent, type FounderIndexInputs } from '@frontier/contracts';
import { percentileRanks } from '@frontier/shared';

/** How the engine caps runway for a cash-generative company. */
const RUNWAY_CAP_QUARTERS = 200;

/** Tolerance below which the recomputed composite is treated as identical. */
export const RECONCILE_TOLERANCE = 0.0005;

export interface FounderIndexComponentRow {
  readonly key: FounderIndexComponent;
  readonly weight: number;
  readonly percentile: number;
  readonly contribution: number;
  /** Where the percentile came from, stated on the surface. */
  readonly source: 'board' | 'recomputed';
}

export interface FounderIndexBreakdown {
  readonly published: LeaderboardEntry;
  readonly inputs: FounderIndexInputs;
  readonly components: readonly FounderIndexComponentRow[];
  readonly computed: number;
  readonly reconciles: boolean;
  /** The lowest-percentile component: the cheapest point on the index to move. */
  readonly weakest: FounderIndexComponentRow | null;
}

const SOURCES: Readonly<Record<FounderIndexComponent, 'board' | 'recomputed'>> = {
  wealth: 'board',
  enterprise: 'board',
  innovation: 'board',
  reputation: 'board',
  network: 'board',
  government: 'board',
  financialResilience: 'recomputed',
  sessionObjectives: 'recomputed',
};

function boardPercentile(session: SessionState, board: LeaderboardBoard, subjectId: string): number | null {
  const entry = session.leaderboards.find((item) => item.board === board)?.entries.find((row) => row.subjectId === subjectId);
  return entry?.percentile ?? null;
}

/** The engine's founder population: active players and founder chief executives, ordered by id. */
export function foundersOf(session: SessionState) {
  return session.characters
    .filter((character) => character.isActive && (character.isPlayer || character.role === 'founder_ceo'))
    .slice()
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Weighted objective progress for one character, mirroring the engine. */
export function objectiveProgressOf(session: SessionState, characterId: string): number {
  const seat = session.players.find((player) => player.characterId === characterId) ?? null;
  const relevant = session.objectives.filter(
    (objective) => objective.playerId === null || (seat !== null && objective.playerId === seat.playerId),
  );
  if (relevant.length === 0) return 0;
  const weight = relevant.reduce((total, objective) => total + objective.weight, 0);
  if (weight <= 0) return relevant.reduce((total, objective) => total + objective.progress, 0) / relevant.length;
  return relevant.reduce((total, objective) => total + objective.progress * objective.weight, 0) / weight;
}

/** Quarters of cash at the current burn, as the engine measures resilience. */
function resilienceOf(session: SessionState, companyId: string): number {
  const metrics = session.companyMetrics.find((entry) => entry.companyId === companyId) ?? null;
  if (metrics !== null) return metrics.runwayQuarters;
  const company = session.companies.find((entry) => entry.id === companyId) ?? null;
  if (company === null) return 0;
  const burn = Math.max(0, -company.financials.quarterlyBurn);
  return burn <= 0 ? RUNWAY_CAP_QUARTERS : Math.min(RUNWAY_CAP_QUARTERS, company.financials.cash / burn);
}

/**
 * Break the composite into its eight inputs for one founder.
 *
 * Returns null before the first resolution, when no composite exists to
 * decompose — never a fabricated one.
 */
export function founderIndexBreakdown(session: SessionState, founderId: string, companyId: string): FounderIndexBreakdown | null {
  const published = session.leaderboards.find((entry) => entry.board === 'founder_index')?.entries.find((row) => row.subjectId === founderId) ?? null;
  if (published === undefined || published === null) return null;

  const companies = session.companies
    .filter((company) => company.isActive)
    .slice()
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const runwayRanks = percentileRanks(companies.map((company) => resilienceOf(session, company.id)));
  const companyPosition = companies.findIndex((company) => company.id === companyId);

  const founders = foundersOf(session);
  const objectiveRanks = percentileRanks(founders.map((character) => objectiveProgressOf(session, character.id)));
  const founderPosition = founders.findIndex((character) => character.id === founderId);

  const inputs: FounderIndexInputs = {
    wealth: boardPercentile(session, 'founder_wealth', founderId) ?? 0,
    enterprise: boardPercentile(session, 'company_value', companyId) ?? 0,
    innovation: boardPercentile(session, 'innovation', companyId) ?? 0,
    reputation: boardPercentile(session, 'reputation', companyId) ?? 0,
    network: boardPercentile(session, 'network', founderId) ?? 0,
    government: boardPercentile(session, 'government', companyId) ?? 0,
    financialResilience: companyPosition < 0 ? 0 : runwayRanks[companyPosition] ?? 0.5,
    sessionObjectives: founderPosition < 0 ? 0 : objectiveRanks[founderPosition] ?? 0.5,
  };

  const components: FounderIndexComponentRow[] = (Object.keys(FOUNDER_INDEX_WEIGHTS) as FounderIndexComponent[])
    .map((key) => ({
      key,
      weight: FOUNDER_INDEX_WEIGHTS[key],
      percentile: inputs[key],
      contribution: FOUNDER_INDEX_WEIGHTS[key] * inputs[key],
      source: SOURCES[key],
    }))
    .sort((a, b) => b.contribution - a.contribution);

  let weakest: FounderIndexComponentRow | null = null;
  for (const component of components) {
    if (weakest === null || component.percentile < weakest.percentile) weakest = component;
  }

  const computed = founderIndex(inputs);

  return {
    published,
    inputs,
    components,
    computed,
    reconciles: Math.abs(computed - published.value) <= RECONCILE_TOLERANCE,
    weakest,
  };
}
