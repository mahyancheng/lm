/**
 * @frontier/simulation — capital/scores.ts
 *
 * Every number a desk acts on, and not one of them is a draw.
 *
 * This is the file that decides whether a fund bids, agitates or sells short, so
 * it is the file that decides whether The Street reads as an economy or as a
 * slot machine with portraits. Each score is a weighted sum of terms that are
 * already state, each is a whole number 0..100 (conviction is signed, on the
 * same scale), and each is explicable in one line on the card the player reads.
 *
 * No `Math.random`, no clock, no RNG at all: the desks fork a stream only for a
 * tie-break of last resort, and none of these functions is given it.
 */

import type { CapitalEntity, Company, SessionState } from '@frontier/contracts';
import { FUNDING_STAGES, type FundingStage } from '@frontier/contracts';
import { clampInt, type DeskContext } from './context';

/* -------------------------------------------------------------------------- */
/*  Shared terms                                                               */
/* -------------------------------------------------------------------------- */

/** Appetite for the company's sector, 0..100. A missing key reads as no appetite. */
export function affinityFor(entity: CapitalEntity, company: Company): number {
  return clampInt(entity.sectorAffinity[company.sectorId] ?? 0, 0, 100);
}

/**
 * Trust from the fund's lead partner toward the company's chief executive.
 *
 * **No edge reads as neutral, not as distrust.** A partner who has never met a
 * founder is not maximally suspicious of them; they have no view. Scoring an
 * absent relationship as zero would make every first meeting in the world score
 * fifteen points below a bad one, which is not what the term is for — it exists
 * so that a founder who *burned* a partner is scored lower than one who did not.
 * The same neutral reading the introduction rule already uses for an unknown
 * intermediary.
 */
export const NEUTRAL_TRUST = 50;

export function partnerTrustIn(draft: SessionState, entity: CapitalEntity, company: Company): number {
  const partnerId = entity.partnerCharacterIds[0];
  if (partnerId === undefined || company.ceoCharacterId === null) return NEUTRAL_TRUST;
  const edge = draft.relationships.find((candidate) => candidate.fromId === partnerId && candidate.toId === company.ceoCharacterId);
  return edge === undefined ? NEUTRAL_TRUST : clampInt(edge.trust, 0, 100);
}

/** Hostility from the fund's lead partner toward the company's chief executive, 0..100. */
export function partnerHostilityIn(draft: SessionState, entity: CapitalEntity, company: Company): number {
  const partnerId = entity.partnerCharacterIds[0];
  if (partnerId === undefined || company.ceoCharacterId === null) return 0;
  const edge = draft.relationships.find((candidate) => candidate.fromId === partnerId && candidate.toId === company.ceoCharacterId);
  return edge === undefined ? 0 : clampInt(edge.hostility, 0, 100);
}

/** The chief executive's connection level, 0..100. Already state; never recomputed here. */
export function founderReachOf(draft: SessionState, company: Company): number {
  if (company.ceoCharacterId === null) return 0;
  const ceo = draft.characters.find((candidate) => candidate.id === company.ceoCharacterId);
  return ceo === undefined ? 0 : clampInt(ceo.connectionLevel, 0, 100);
}

/* -------------------------------------------------------------------------- */
/*  Venture: the sourcing score                                                */
/* -------------------------------------------------------------------------- */

const stageIndex = (stage: FundingStage): number => FUNDING_STAGES.indexOf(stage);

/**
 * The stage a company's next priced round would be.
 *
 * One past the last round it actually closed, floored at seed for a company that
 * has never raised. `bridge` is not a step on the ladder — it is an emergency —
 * so a company whose last round was a bridge is offered the stage before it.
 */
export function nextStageFor(draft: SessionState, company: Company): FundingStage {
  let latest: { quarter: number; stage: FundingStage } | null = null;
  for (const round of draft.fundingRounds) {
    if (round.companyId !== company.id || round.status !== 'closed') continue;
    if (latest === null || round.closedQuarter > latest.quarter) latest = { quarter: round.closedQuarter, stage: round.stage };
  }
  if (latest === null) return 'seed';
  if (latest.stage === 'bridge') return 'series_a';
  const next = FUNDING_STAGES[Math.min(stageIndex(latest.stage) + 1, stageIndex('growth'))];
  return next ?? 'growth';
}

/** 100 inside the fund's band, 50 one stage out, 0 beyond. */
export function stageFitFor(entity: CapitalEntity, stage: FundingStage): number {
  const [low, high] = entity.stageBand;
  const index = stageIndex(stage);
  const lowIndex = stageIndex(low);
  const highIndex = stageIndex(high);
  if (index >= lowIndex && index <= highIndex) return 100;
  const distance = index < lowIndex ? lowIndex - index : index - highIndex;
  return distance === 1 ? 50 : 0;
}

/**
 * How much a venture fund wants to write this cheque, 0..100.
 *
 * ```
 * 30 x growth + 20 x affinity + 20 x stageFit + 15 x founder reach + 15 x partner trust
 * ```
 *
 * `relation` is what makes the player's history matter: a founder who burned a
 * partner two years ago is scored fifteen points lower by that fund forever, and
 * the offer card says so.
 */
export function sourcingScore(desk: DeskContext, entity: CapitalEntity, company: Company, stage: FundingStage): number {
  const metrics = desk.metricsOf(company.id);
  // 60% year on year is full marks; a shrinking company scores nothing.
  const growth = clampInt((100 * (metrics?.revenueGrowthYoY ?? 0)) / 0.6, 0, 100);
  const affinity = affinityFor(entity, company);
  const stageFit = stageFitFor(entity, stage);
  const founder = founderReachOf(desk.draft, company);
  const relation = partnerTrustIn(desk.draft, entity, company);
  return clampInt((30 * growth + 20 * affinity + 20 * stageFit + 15 * founder + 15 * relation) / 100, 0, 100);
}

/* -------------------------------------------------------------------------- */
/*  Buyout: the targeting score                                                */
/* -------------------------------------------------------------------------- */

/**
 * How much a buyout fund wants control of this company, 0..100.
 *
 * ```
 * 25 x maturity + 25 x cashflow + 25 x cheapness + 15 x lever headroom + 10 x affinity
 * ```
 *
 * `cheapness` is the term that turns the player's own share price from a
 * scoreboard into a vulnerability: trade far enough below your fundamental
 * anchor for long enough and a sponsor arrives. That is the belief-versus-reality
 * rule working against the player for once, and it is the best argument the game
 * has for managing what the market thinks.
 */
export function targetScore(desk: DeskContext, entity: CapitalEntity, company: Company, minRevenueUsd: number): number {
  const metrics = desk.metricsOf(company.id);
  const revenueTtm = metrics?.revenueTtm ?? company.financials.revenueQuarterly * 4;
  const growth = metrics?.revenueGrowthYoY ?? 0;

  // A mature business: slow, and big enough to be worth the trouble.
  const scale = clampInt((100 * revenueTtm) / Math.max(1, minRevenueUsd), 0, 100);
  const settled = growth <= 0.12 ? 100 : clampInt(100 * (1 - (growth - 0.12) / 0.48), 0, 100);
  const maturity = clampInt((scale + settled) / 2, 0, 100);

  const cashflow = clampInt((100 * (metrics?.operatingMarginPct ?? 0)) / 0.25, 0, 100);

  const marketCap = Math.max(1, metrics?.marketCapUsd ?? 0);
  const anchor = desk.anchorOf(company.id)?.anchorValueUsd ?? marketCap;
  const cheapness = clampInt(100 * (1 - marketCap / Math.max(1, anchor)), 0, 100);

  const levercap = clampInt(100 * (1 - company.financials.debt / Math.max(1, revenueTtm)), 0, 100);
  const affinity = affinityFor(entity, company);

  return clampInt((25 * maturity + 25 * cashflow + 25 * cheapness + 15 * levercap + 10 * affinity) / 100, 0, 100);
}

/* -------------------------------------------------------------------------- */
/*  Hedge: conviction                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The fundamentals-versus-price gap, as a signed whole percentage, bounded.
 *
 * Positive means the anchor is above the quote — the company is cheap. This is
 * the same gap the return decomposition already explains its own moves with;
 * nothing here is invented.
 */
export function valuationGapPct(desk: DeskContext, company: Company): number {
  // Per share against the quote where the anchor carries it, because that is the
  // only apples-to-apples comparison available: `anchorValueUsd` is an
  // *enterprise* value and `marketCapUsd` is an *equity* value, so a levered
  // company reads as cheap by exactly its net debt when the two are divided.
  // `perShareValueUsd` is the anchor already reduced to the same basis as the
  // price, which is what it exists for.
  const anchor = desk.anchorOf(company.id);
  const quote = desk.lastQuoteOf(company);
  if (anchor !== null && anchor.perShareValueUsd !== null && anchor.perShareValueUsd > 0 && quote !== null && quote.price > 0) {
    return clampInt((100 * (anchor.perShareValueUsd - quote.price)) / quote.price, -100, 100);
  }

  const marketCap = desk.metricsOf(company.id)?.marketCapUsd ?? 0;
  const anchorValue = anchor?.anchorValueUsd ?? 0;
  if (marketCap <= 0 || anchorValue <= 0) return 0;
  return clampInt((100 * (anchorValue - marketCap)) / marketCap, -100, 100);
}

/** Belief topics that argue a company is worth less than the tape says. */
const BEARISH_TOPICS: ReadonlySet<string> = new Set(['revenue_miss', 'margin_pressure', 'accounting_concern', 'model_delay', 'safety_incident', 'regulatory_action', 'talent_exodus', 'contract_loss', 'fundraise_needed']);
const BULLISH_TOPICS: ReadonlySet<string> = new Set(['revenue_beat', 'model_success', 'contract_win', 'acquisition_target']);

/**
 * The public record, scored: a signed, credibility-weighted sum of **last**
 * quarter's disclosures about the company, bounded to ±40.
 *
 * Last quarter's, and the reason has to be stated or a future reader will
 * "correct" it: the desks run in phase four and disclosures are published in
 * phase twelve, so this quarter's public record does not exist yet when a desk
 * reads it. Scoring it against `desk.quarter` scores it against an empty set and
 * silently reduces conviction to the valuation gap alone.
 *
 * This is the term that makes reading the feed an edge rather than a chore, and
 * it reads only disclosures — public by construction — so a hedge fund never
 * trades on something the player could not also have read.
 */
export function newsScore(desk: DeskContext, company: Company): number {
  let score = 0;
  for (const disclosure of desk.draft.disclosures) {
    if (disclosure.companyId !== company.id || disclosure.quarter !== desk.quarter - 1) continue;
    const topic = disclosure.beliefTopic;
    if (topic === null) continue;
    const direction = BEARISH_TOPICS.has(topic) ? -1 : BULLISH_TOPICS.has(topic) ? 1 : 0;
    if (direction === 0) continue;
    score += direction * 40 * Math.max(0, Math.min(1, disclosure.credibility));
  }
  return clampInt(score, -40, 40);
}

/** Fundamentals seven parts to three parts the feed, signed, −100..+100. */
export function convictionFor(desk: DeskContext, company: Company): number {
  return clampInt(0.7 * valuationGapPct(desk, company) + 0.3 * newsScore(desk, company), -100, 100);
}

/**
 * The belief a short report argues for, chosen from the fundamental that drove
 * the gap rather than from anything a model said.
 */
export function reportTopicFor(desk: DeskContext, company: Company): 'accounting_concern' | 'revenue_miss' | 'margin_pressure' {
  const metrics = desk.metricsOf(company.id);
  if ((metrics?.operatingMarginPct ?? 0) < 0) return 'margin_pressure';
  if ((metrics?.revenueGrowthYoY ?? 0) < 0) return 'revenue_miss';
  return 'accounting_concern';
}
