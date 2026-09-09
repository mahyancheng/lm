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
 *
 * The derivation is where a MAJOR rival's personality lands. `applyNpcDefaults`
 * skips major-tier companies — a major is meant to have a strategist — so a
 * major whose model call did not happen this quarter (the top-K cap, the
 * per-quarter time budget, an outage) states no budget at all, and this is the
 * only thing deciding what it spends. Reading the chief executive's dials here
 * is what stops that company from spending exactly what every other company of
 * its archetype spends.
 */

import type { Company, SessionState, StableTraits, SubmittedAction } from '@frontier/contracts';
import { NEUTRAL_EXECUTIVE_DIALS, effectivePolicy, executiveDials, personalisedPolicy, type ExecutiveDials } from './archetypes';
import { intentsOfType, money } from './util';
import { ceoOf } from '../relationships/relations';

/* -------------------------------------------------------------------------- */
/*  Who is running the company                                                 */
/* -------------------------------------------------------------------------- */

/** The stable traits of whoever is in the chair, or null when the chair is empty. */
export function executiveTraitsOf(draft: SessionState, company: Company): StableTraits | null {
  const characterId = ceoOf(draft, company.id);
  if (characterId === null) return null;
  const character = draft.characters.find((candidate) => candidate.id === characterId);
  if (character === undefined || !character.isActive) return null;
  return character.stableTraits;
}

/**
 * The dials this company's chief executive turns on the archetype tables.
 *
 * A company somebody is playing gets the neutral set deliberately: the player is
 * the executive, their instructions are the personality, and a derived fallback
 * budget that quietly moved with traits they picked at character creation would
 * be a number on their own screen that they did not choose and cannot see the
 * reason for. Every company nobody is playing gets its executive.
 */
export function executiveDialsFor(draft: SessionState, company: Company): ExecutiveDials {
  if (company.controllerPlayerId !== null) return NEUTRAL_EXECUTIVE_DIALS;
  return executiveDials(executiveTraitsOf(draft, company));
}

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
 * How much of last quarter's GROSS PROFIT a company nobody is directing will put
 * behind marketing and research together.
 *
 * The archetype shares are struck on revenue, which is the right shape for a
 * software business at an eighty percent margin and a nonsense for a contract
 * manufacturer at twenty-five: a twenty-two percent research share of revenue is
 * most of the gross profit of the thing it sells, and the two shares together
 * can exceed the margin outright, so no run rate at any scale would ever cover
 * the wage bill. Struck on gross profit instead, the same policy means the same
 * thing in every industry: a company spends a little over half of what it makes
 * on the goods, and the rest pays the people.
 *
 * World 3 only, and gated on the company's own lines rather than on the world
 * version, because only a node line has a cost of goods that is the roll-up of
 * what it is made of. A world-1 or world-2 company carries no `nodeId` on any
 * product, so neither frozen world can reach this and neither hash can move.
 */
export const NODE_DISCRETIONARY_GROSS_PROFIT_SHARE = 0.55;

/** Whether this company sells node lines, and so has a real cost of goods to strike a policy on. */
function sellsNodeLines(company: Company): boolean {
  return company.products.some((product) => product.isActive && (product.nodeId ?? null) !== null);
}

/**
 * The most a node-economy company will put behind marketing and research
 * together this quarter, or null when the gross-profit bound does not apply.
 *
 * Read off last quarter's own figures — the revenue and the cost of goods the
 * financial phase booked — so it is exactly as knowable to the company as the
 * revenue share it replaces.
 */
export function discretionaryCeilingUsd(company: Company): number | null {
  if (!sellsNodeLines(company)) return null;
  const grossProfit = company.financials.revenueQuarterly - company.financials.cogs;
  return Math.max(0, grossProfit) * NODE_DISCRETIONARY_GROSS_PROFIT_SHARE;
}

/**
 * This policy's share of the ceiling: the two budgets split it in the ratio the
 * archetype already declares, so neither depends on which is computed first and
 * the pair can never sum past the ceiling.
 */
function boundedPolicyUsd(company: Company, ownShare: number, otherShare: number): number {
  const derived = company.financials.revenueQuarterly * ownShare;
  const ceiling = discretionaryCeilingUsd(company);
  if (ceiling === null) return money(derived);
  const total = ownShare + otherShare;
  const slice = total <= 0 ? 0 : ceiling * (ownShare / total);
  return money(Math.min(derived, slice));
}

/**
 * Derive the archetype-policy marketing spend: a share of last quarter's
 * revenue, bent by posture, and in the node economy never more than the gross
 * profit behind it can carry. Used when no action stated a budget, and as the
 * floor the financial phase falls back to if the product phase did not run.
 */
export function policyMarketingUsd(company: Company, dials: ExecutiveDials = NEUTRAL_EXECUTIVE_DIALS): number {
  const policy = personalisedPolicy(effectivePolicy(company.archetype, company.posture), dials);
  return boundedPolicyUsd(company, policy.marketingRevenueShare, policy.rdRevenueShare);
}

/**
 * Derive the archetype-policy research envelope: a share of last quarter's
 * revenue, bent by posture, under the same gross-profit bound as marketing.
 */
export function policyResearchEnvelopeUsd(company: Company, dials: ExecutiveDials = NEUTRAL_EXECUTIVE_DIALS): number {
  const policy = personalisedPolicy(effectivePolicy(company.archetype, company.posture), dials);
  return boundedPolicyUsd(company, policy.rdRevenueShare, policy.marketingRevenueShare);
}

/**
 * Resolve this quarter's marketing plan from the company's actions, falling back
 * to archetype policy. `revenueQuarterly` is still last quarter's figure when
 * this runs, which is the point: budgets are set against the revenue the company
 * actually knows about.
 */
export function marketingPlan(company: Company, actions: readonly SubmittedAction[], dials: ExecutiveDials = NEUTRAL_EXECUTIVE_DIALS): MarketingPlan {
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
    const derived = policyMarketingUsd(company, dials);
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
export function researchEnvelopeUsd(company: Company, actions: readonly SubmittedAction[], dials: ExecutiveDials = NEUTRAL_EXECUTIVE_DIALS): number {
  const stated = intentsOfType(actions, 'set_research_budget');
  const last = stated[stated.length - 1];
  if (last !== undefined) return money(last.intent.budgetUsd);
  return policyResearchEnvelopeUsd(company, dials);
}
