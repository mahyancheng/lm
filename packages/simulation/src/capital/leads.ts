/**
 * @frontier/simulation — capital/leads.ts
 *
 * Who actually led the round.
 *
 * Before capital entities existed, every round in the game closed into a holder
 * invented for it — `fund:venture:<company>` — with `leadInvestorCharacterId`
 * set to `null`. Every round was therefore led by nobody, on behalf of an
 * institution that existed for one company and never acted again.
 *
 * This module is the fix, and it is deliberately the *only* thing the capital
 * phase imports from this directory: given a company and a stage, it names the
 * fund whose cheque it is, its partner, and what the cheque costs that fund's
 * dry powder. Everything else about a fund's behaviour lives in the desks.
 *
 * Nothing here runs in world 1: with no roster, `pickLeadInvestor` returns null
 * and the capital phase falls back to the synthetic holder exactly as before, so
 * a frozen save replays byte for byte.
 */

import type { CapitalEntity, Company, FundingStage, SessionState } from '@frontier/contracts';
import { VC_CHEQUE_MAX_DRY_POWDER_PCT, VC_CHEQUE_PCT_OF_AUM } from '@frontier/contracts';
import { isMultiSectorWorld } from '../economy/sectors';
import { affinityFor, stageFitFor } from './scores';
import { clampInt, deployableUsd } from './context';

/** The fund taking a round, its partner, and the money it can put up. */
export interface LeadInvestor {
  readonly entity: CapitalEntity;
  readonly partnerCharacterId: string | null;
  /** The largest cheque this fund could write at this stage, in whole dollars. */
  readonly maxChequeUsd: number;
}

/** The largest cheque a fund writes at one stage: its stage share of AUM, capped by dry powder. */
export function maxChequeUsd(entity: CapitalEntity, stage: FundingStage): number {
  const byAum = Math.round((entity.committedCapitalUsd * (VC_CHEQUE_PCT_OF_AUM[stage] ?? 0)) / 100);
  const byPowder = Math.round((deployableUsd(entity) * VC_CHEQUE_MAX_DRY_POWDER_PCT) / 100);
  return Math.max(0, Math.min(byAum, byPowder));
}

/**
 * Choose the fund that leads a round this company is raising for itself.
 *
 * Scored on the three terms that do not need the desk's context — stage fit,
 * sector appetite and how much money is actually free — so this is cheap enough
 * to run inside the capital phase. Ties break by roster order, which is the
 * order `capitalEntities` declares, exactly as they do everywhere else.
 *
 * Returns null when there is no roster, when nobody writes at this stage, or
 * when nobody has the money: the caller then keeps its existing behaviour.
 */
export function pickLeadInvestor(draft: SessionState, company: Company, stage: FundingStage, amountUsd: number): LeadInvestor | null {
  if (!isMultiSectorWorld(draft)) return null;
  const roster = draft.capitalEntities ?? [];
  if (roster.length === 0) return null;

  let best: { entity: CapitalEntity; score: number; cheque: number } | null = null;
  for (const entity of roster) {
    // A buyout or sovereign desk does not lead a priced venture round; it buys
    // control or it buys in the market, which are different verbs entirely.
    if (!entity.isActive || (entity.kind !== 'vc' && entity.kind !== 'sovereign')) continue;
    const fit = entity.kind === 'sovereign' ? 50 : stageFitFor(entity, stage);
    if (fit <= 0) continue;
    const cheque = maxChequeUsd(entity, stage);
    if (cheque <= 0) continue;
    const score = clampInt((60 * fit + 40 * affinityFor(entity, company)) / 100, 0, 100);
    if (best === null || score > best.score) best = { entity, score, cheque };
  }
  if (best === null) return null;
  // A fund that cannot cover the round does not lead it: the company is better
  // served by the anonymous book than by a lead who cannot write the cheque.
  if (best.cheque < Math.round(amountUsd)) return null;

  return {
    entity: best.entity,
    partnerCharacterId: best.entity.partnerCharacterIds[0] ?? null,
    maxChequeUsd: best.cheque,
  };
}
