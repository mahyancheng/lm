/**
 * @frontier/simulation — companies/policy.ts
 *
 * Spending policy: how much a company puts behind demand generation and
 * research in a quarter when nobody told it otherwise.
 *
 * A company's budgets are not stored as standing policy anywhere in
 * `SessionState`, and deliberately so — there is no hidden per-company config
 * for a model to reach. Instead a budget is either **stated this quarter** by an
 * action (`set_marketing_budget`, `marketing_campaign`, `set_research_budget`)
 * or **derived** from the archetype policy in `archetypes.ts` applied to last
 * quarter's revenue. Both paths are deterministic and both are visible in the
 * ledger.
 */

import type { Company, SubmittedAction } from '@frontier/contracts';
import { effectivePolicy } from './archetypes';
import { intentsOfType, money } from './util';

/** What a company will spend on demand generation this quarter, and where it came from. */
export interface MarketingPlan {
  /** Recurring segment spend for the quarter. */
  readonly recurringUsd: number;
  /** One-off spend attached to launches and campaigns starting this quarter. */
  readonly oneOffUsd: number;
  /** Per-segment split of the recurring spend, used to allocate lift across products. */
  readonly bySegment: Readonly<Record<string, number>>;
  /** True when an action stated the budget rather than the archetype policy deriving it. */
  readonly stated: boolean;
}

/**
 * Derive the archetype-policy marketing spend: a share of last quarter's
 * revenue, bent by posture. Used when no action stated a budget, and as the
 * floor the financial phase falls back to if the product phase did not run.
 */
export function policyMarketingUsd(company: Company): number {
  const policy = effectivePolicy(company.archetype, company.posture);
  return money(company.financials.revenueQuarterly * policy.marketingRevenueShare);
}

/**
 * Derive the archetype-policy research envelope: a share of last quarter's
 * revenue, bent by posture.
 */
export function policyResearchEnvelopeUsd(company: Company): number {
  const policy = effectivePolicy(company.archetype, company.posture);
  return money(company.financials.revenueQuarterly * policy.rdRevenueShare);
}

/**
 * Resolve this quarter's marketing plan from the company's actions, falling back
 * to archetype policy. `revenueQuarterly` is still last quarter's figure when
 * this runs, which is the point: budgets are set against the revenue the company
 * actually knows about.
 */
export function marketingPlan(company: Company, actions: readonly SubmittedAction[]): MarketingPlan {
  const bySegment: Record<string, number> = {};
  let recurring = 0;
  let stated = false;

  for (const { intent } of intentsOfType(actions, 'set_marketing_budget')) {
    stated = true;
    // A stated allocation replaces the previous one outright: segments the
    // player left out are set to zero, exactly as the action documents.
    for (const key of Object.keys(bySegment)) delete bySegment[key];
    recurring = 0;
    for (const allocation of intent.allocations) {
      bySegment[allocation.segment] = (bySegment[allocation.segment] ?? 0) + allocation.budgetUsd;
      recurring += allocation.budgetUsd;
    }
  }

  let oneOff = 0;
  for (const { intent } of intentsOfType(actions, 'marketing_campaign')) {
    // A campaign spends its budget evenly across its quarters; the first
    // instalment lands now.
    const instalment = intent.budgetUsd / intent.quarters;
    oneOff += instalment;
    bySegment[intent.segment] = (bySegment[intent.segment] ?? 0) + instalment;
  }
  for (const { intent } of intentsOfType(actions, 'launch_product')) {
    oneOff += intent.launchMarketingUsd;
    bySegment[intent.segment] = (bySegment[intent.segment] ?? 0) + intent.launchMarketingUsd;
  }

  if (!stated) {
    const derived = policyMarketingUsd(company);
    recurring = derived;
    const products = company.products.filter((p) => p.isActive);
    if (products.length === 0) {
      bySegment['enterprise'] = (bySegment['enterprise'] ?? 0) + derived;
    } else {
      // Split the derived budget across the segments the company actually sells
      // into, weighted by the revenue each contributes.
      let totalRevenue = 0;
      for (const p of products) totalRevenue += p.activeCustomers * p.pricePerSeat;
      for (const p of products) {
        const weight = totalRevenue > 0 ? (p.activeCustomers * p.pricePerSeat) / totalRevenue : 1 / products.length;
        bySegment[p.segment] = (bySegment[p.segment] ?? 0) + derived * weight;
      }
    }
  }

  return { recurringUsd: money(recurring), oneOffUsd: money(oneOff), bySegment, stated };
}

/**
 * This quarter's research envelope: the stated `set_research_budget` figure when
 * the company gave one, the archetype-policy share of revenue otherwise.
 */
export function researchEnvelopeUsd(company: Company, actions: readonly SubmittedAction[]): number {
  const stated = intentsOfType(actions, 'set_research_budget');
  const last = stated[stated.length - 1];
  if (last !== undefined) return money(last.intent.budgetUsd);
  return policyResearchEnvelopeUsd(company);
}
