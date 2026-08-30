/**
 * @frontier/simulation — companies/npc.ts
 *
 * Archetype behaviour for companies no model thought about this quarter.
 *
 * A `significant` or `background` company with no `NpcActionBundle` still has to
 * act, or the economy is a diorama. `applyNpcDefaults` reads the policy tables in
 * `archetypes.ts` and synthesises ordinary `SubmittedAction`s with origin
 * `npc_default`. They go into `pendingActions` and are resolved by exactly the
 * same code that resolves a player's actions — a background company gets no
 * private mechanics, no free money and no hidden information.
 *
 * A company is treated as "already thought about" when `pendingActions` already
 * carries something for it this quarter: a player submission, an NPC strategist
 * bundle folded in by the action-collection phase, or a board or deal execution.
 *
 * Determinism: the only RNG draw here is a small jitter on hiring size, taken
 * once per company in stable array order.
 */

import type { ActionIntent, Company, ResolverContext, SessionState, StaffRole, SubmittedAction } from '@frontier/contracts';
import { makeId } from '@frontier/contracts';
import {
  NPC_MAX_HIRE_COUNT,
  NPC_MAX_LAYOFF_FRACTION,
  NPC_MIN_HIRE_COUNT,
  NPC_MIN_PRICE_MOVE,
  NPC_SURVIVAL_RUNWAY_QUARTERS,
  effectivePolicy,
} from './archetypes';
import { RUNWAY_CAP_QUARTERS } from './balance';
import { activeCompanies, activeProducts, clamp, emitEvent, money, ratio, roleHeadcount, totalHeadcount } from './util';

/** True when some other source already queued an action for this company this quarter. */
function alreadyDirected(draft: SessionState, ctx: ResolverContext, companyId: string): boolean {
  return draft.pendingActions.some((a) => a.quarter === ctx.quarter && a.actorCompanyId === companyId);
}

/** Runway in quarters at the company's last recorded burn. */
function runwayQuarters(company: Company): number {
  const burn = company.financials.quarterlyBurn;
  if (burn >= 0) return RUNWAY_CAP_QUARTERS;
  return clamp(ratio(company.financials.cash, -burn, RUNWAY_CAP_QUARTERS), 0, RUNWAY_CAP_QUARTERS);
}

/**
 * Deterministic archetype behaviour for background and significant companies
 * that received no instructions this quarter.
 */
export function applyNpcDefaults(draft: SessionState, ctx: ResolverContext): void {
  const rng = ctx.rng;
  let sequence = draft.pendingActions.length;

  for (const company of activeCompanies(draft)) {
    if (company.tier === 'major') continue;
    if (company.controllerPlayerId !== null) continue;
    if (alreadyDirected(draft, ctx, company.id)) continue;

    // A company that cannot see four quarters of runway stops behaving like
    // whatever it wanted to be and starts behaving like a company in trouble.
    if (runwayQuarters(company) < NPC_SURVIVAL_RUNWAY_QUARTERS && company.posture !== 'survival') {
      company.posture = 'survival';
    }

    const policy = effectivePolicy(company.archetype, company.posture);
    const intents: ActionIntent[] = [];

    /* --- budgets ---------------------------------------------------------- */
    const revenue = company.financials.revenueQuarterly;
    const marketingBudget = money(revenue * policy.marketingRevenueShare);
    const products = activeProducts(company);
    if (products.length > 0 && marketingBudget > 0) {
      const bySegment = new Map<string, number>();
      let total = 0;
      for (const p of products) total += p.activeCustomers * p.pricePerSeat;
      for (const p of products) {
        const weight = total > 0 ? (p.activeCustomers * p.pricePerSeat) / total : 1 / products.length;
        bySegment.set(p.segment, (bySegment.get(p.segment) ?? 0) + marketingBudget * weight);
      }
      const allocations: { segment: 'consumer' | 'enterprise' | 'developer_api' | 'government'; budgetUsd: number }[] = [];
      for (const [segment, budgetUsd] of bySegment) {
        allocations.push({ segment: segment as 'consumer' | 'enterprise' | 'developer_api' | 'government', budgetUsd: money(budgetUsd) });
      }
      allocations.sort((a, b) => (a.segment < b.segment ? -1 : a.segment > b.segment ? 1 : 0));
      intents.push({ type: 'set_marketing_budget', allocations: allocations.slice(0, 4) });
    }

    const researchBudget = money(revenue * policy.rdRevenueShare);
    if (researchBudget > 0) {
      intents.push({ type: 'set_research_budget', budgetUsd: researchBudget });
    }

    /* --- compute allocation ----------------------------------------------- */
    if (Math.abs(company.compute.trainingAllocation - policy.trainingAllocation) > 0.02) {
      intents.push({ type: 'allocate_compute', trainingFraction: policy.trainingAllocation });
    }

    /* --- pricing nudge ---------------------------------------------------- */
    if (Math.abs(policy.pricingNudge) >= NPC_MIN_PRICE_MOVE) {
      for (const product of products) {
        const next = money(product.pricePerSeat * (1 + policy.pricingNudge));
        if (next === product.pricePerSeat) continue;
        intents.push({ type: 'set_product_price', productId: product.id, pricePerSeatUsd: next });
      }
    }

    /* --- hiring or cutting ------------------------------------------------ */
    const head = totalHeadcount(company);
    const growth = policy.headcountGrowthPerQuarter;
    const role: StaffRole = policy.hiringPriority[0] ?? 'engineers';
    if (growth > 0 && head > 0) {
      const jitter = rng.range(0.85, 1.15);
      const target = Math.round(head * growth * jitter);
      const count = clamp(target, 0, NPC_MAX_HIRE_COUNT);
      if (count >= NPC_MIN_HIRE_COUNT) {
        intents.push({ type: 'hire', role, count, compBand: policy.compBand });
      }
    } else if (growth < 0 && head > 0) {
      const available = roleHeadcount(company, role);
      const cut = Math.min(Math.round(available * Math.min(NPC_MAX_LAYOFF_FRACTION, -growth)), available);
      if (cut > 0) {
        // A company cutting to survive cannot afford generous severance.
        intents.push({ type: 'layoff', role, count: cut, severanceQuartersOfPay: company.posture === 'survival' ? 0.25 : 1 });
      }
    }

    if (intents.length === 0) continue;

    const actorCharacterId = company.ceoCharacterId ?? makeId('chr', company.id, 'leadership');
    const queued: SubmittedAction[] = [];
    for (let i = 0; i < intents.length; i += 1) {
      const intent = intents[i];
      if (intent === undefined) continue;
      queued.push({
        actionId: makeId('act', draft.sessionId, ctx.quarter, 'npc', company.id, i),
        sessionId: draft.sessionId,
        quarter: ctx.quarter,
        sequence: sequence++,
        actorPlayerId: null,
        actorCompanyId: company.id,
        actorCharacterId,
        origin: 'npc_default',
        intent,
        confirmedByHuman: false,
      });
    }
    draft.pendingActions.push(...queued);

    const eventId = emitEvent(
      draft,
      ctx,
      'action_accepted',
      company.id,
      null,
      {
        origin: 'npc_default',
        archetype: company.archetype,
        posture: company.posture,
        actionTypes: queued.map((a) => a.intent.type),
        marketingBudgetUsd: marketingBudget,
        researchBudgetUsd: researchBudget,
      },
      'company',
    );
    ctx.log({
      phase: 'action_collection',
      text: `${company.name} ran its ${company.archetype.replace(/_/g, ' ')} playbook on a ${company.posture.replace(/_/g, ' ')} posture: ${queued.length} actions.`,
      deltaLabel: `${queued.length} actions`,
      refEventIds: [eventId],
      tone: 'neutral',
      subjectId: company.id,
    });
  }
}
