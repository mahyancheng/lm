/**
 * @frontier/simulation — economy/scope.ts
 *
 * Projecting a `SessionState` into the `TargetPathScope` the modifier machinery
 * operates on, and folding the result back into canonical state.
 *
 * Two kinds of company metric live in that projection and they behave
 * differently on purpose:
 *
 * - **Persistent** — the five reputations and the attrition rate. These are real
 *   company state; a modifier that moves them moves the company, and the change
 *   is written back by `commitCompanyMetrics`.
 * - **Transient** — `demandMultiplier`, `costMultiplier` and `valuationSentiment`.
 *   These have no home on `Company`: they are neutral (1, 1, 0) at the start of
 *   every quarter and exist only for the quarter in which their modifiers are in
 *   force. Any subsystem that needs them recomputes them from the active
 *   modifier set with `companyTransientMetrics`, which is a pure function of
 *   state and quarter.
 */

import type { SessionState, TargetPathScope } from '@frontier/contracts';
import { clamp } from './util';
import { decayFactor, effectiveOperand } from './decay';
import { applyToTargetPath } from '../targetPaths';

/** The three per-quarter metrics that reset to neutral each quarter. */
export const TRANSIENT_COMPANY_METRICS = ['demandMultiplier', 'costMultiplier', 'valuationSentiment'] as const;
export type TransientCompanyMetric = (typeof TRANSIENT_COMPANY_METRICS)[number];

/** Neutral starting values for the transient metrics. */
export const NEUTRAL_TRANSIENT: Readonly<Record<TransientCompanyMetric, number>> = {
  demandMultiplier: 1,
  costMultiplier: 1,
  valuationSentiment: 0,
};

/** A scope whose company projection is writable by the modifier machinery. */
export interface MutableTargetPathScope extends TargetPathScope {
  readonly companyMetrics: Record<string, Record<string, number>>;
}

/**
 * Build the scope for one quarter.
 *
 * `world` and `sectors` are the draft's own objects, so a modifier writes
 * straight into canonical state. Only `companyMetrics` is a projection, and it
 * is folded back by `commitCompanyMetrics`.
 */
export function buildTargetPathScope(state: SessionState): MutableTargetPathScope {
  const companyMetrics: Record<string, Record<string, number>> = {};
  for (const company of state.companies) {
    companyMetrics[company.id] = {
      reputationPublic: company.reputation.public,
      reputationDeveloper: company.reputation.developer,
      reputationEnterprise: company.reputation.enterprise,
      reputationGovernment: company.reputation.government,
      reputationInvestor: company.reputation.investor,
      attritionRate: company.employees.attrition,
      demandMultiplier: NEUTRAL_TRANSIENT.demandMultiplier,
      costMultiplier: NEUTRAL_TRANSIENT.costMultiplier,
      valuationSentiment: NEUTRAL_TRANSIENT.valuationSentiment,
    };
  }
  return { world: state.world, sectors: state.sectors, companyMetrics };
}

/** Fold the persistent half of the projection back into the companies. */
export function commitCompanyMetrics(state: SessionState, scope: MutableTargetPathScope): void {
  for (const company of state.companies) {
    const metrics = scope.companyMetrics[company.id];
    if (metrics === undefined) continue;
    company.reputation.public = clamp(metrics['reputationPublic'] ?? company.reputation.public, 0, 100);
    company.reputation.developer = clamp(metrics['reputationDeveloper'] ?? company.reputation.developer, 0, 100);
    company.reputation.enterprise = clamp(metrics['reputationEnterprise'] ?? company.reputation.enterprise, 0, 100);
    company.reputation.government = clamp(metrics['reputationGovernment'] ?? company.reputation.government, 0, 100);
    company.reputation.investor = clamp(metrics['reputationInvestor'] ?? company.reputation.investor, 0, 100);
    company.employees.attrition = clamp(metrics['attritionRate'] ?? company.employees.attrition, 0, 1);
  }
}

/**
 * The transient per-company metrics implied by the active modifier set.
 *
 * Pure: it neither reads nor writes anything persistent, and it never touches
 * `world` or `sectors` because it only ever applies `company.*` paths. Returns
 * every company in the session, so a caller can index it without a fallback.
 */
export function companyTransientMetrics(state: SessionState, quarter: number): Record<string, Record<TransientCompanyMetric, number>> {
  const projection: Record<string, Record<string, number>> = {};
  for (const company of state.companies) {
    projection[company.id] = { ...NEUTRAL_TRANSIENT };
  }
  const scope: MutableTargetPathScope = { world: state.world, sectors: state.sectors, companyMetrics: projection };

  const transient = new Set<string>(TRANSIENT_COMPANY_METRICS);
  const relevant = state.activeModifiers
    .filter((mod) => {
      if (!mod.target.startsWith('company.')) return false;
      const metric = mod.target.slice(mod.target.lastIndexOf('.') + 1);
      return transient.has(metric) && mod.remainingQuarters > 0;
    })
    .slice()
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  for (const mod of relevant) {
    const elapsed = Math.max(0, quarter - mod.appliedAtQuarter);
    const operand = effectiveOperand(mod.operation, mod.value, decayFactor(mod.decay, elapsed, mod.durationQuarters));
    applyToTargetPath(scope, mod.target, mod.operation, operand);
  }

  const out: Record<string, Record<TransientCompanyMetric, number>> = {};
  for (const company of state.companies) {
    const metrics = projection[company.id] ?? {};
    out[company.id] = {
      demandMultiplier: metrics['demandMultiplier'] ?? NEUTRAL_TRANSIENT.demandMultiplier,
      costMultiplier: metrics['costMultiplier'] ?? NEUTRAL_TRANSIENT.costMultiplier,
      valuationSentiment: metrics['valuationSentiment'] ?? NEUTRAL_TRANSIENT.valuationSentiment,
    };
  }
  return out;
}
