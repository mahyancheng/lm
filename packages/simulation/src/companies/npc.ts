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

import type { ActionIntent, Company, ProcurementOpportunity, ResolverContext, SessionState, StaffRole, SubmittedAction } from '@frontier/contracts';
import { makeId, nodeMarketPriceUsd } from '@frontier/contracts';
// The two procurement gates a default bid has to clear are restated by the
// government subsystem as data, so they are imported rather than duplicated
// here: a change to the clearance table must move NPC bidding with it.
import { CLEARANCE_STAFF_REQUIREMENT, requiredReliability } from '../government/programmes';
import {
  NPC_BID_APPETITE_FLOOR,
  NPC_BID_COMPUTE_SHARE,
  NPC_BID_PRICE_SHARE,
  NPC_BID_RELIABILITY,
  NPC_BID_STAFF_SHARE,
  NPC_MAX_HIRE_COUNT,
  NPC_MAX_LAYOFF_FRACTION,
  NPC_MIN_HIRE_COUNT,
  NPC_MIN_PRICE_MOVE,
  NPC_SURVIVAL_RUNWAY_QUARTERS,
  effectivePolicy,
  type EffectivePolicy,
} from './archetypes';
import { PPE_DEPRECIATION_PER_QUARTER, RUNWAY_CAP_QUARTERS } from './balance';
import { categoryOf } from './categories';
import { chooseSupplierDefault, defaultSupplyTerms, resolveSupplyLine } from './supply';
import { isMultiSectorWorld, isNodeEconomyWorld } from '../economy/sectors';
import { CAPACITY_UNIT_USD, createNodeCostCache, drawPerUnitOf, lineNodeIdOf, lineNodeOf } from '../graph/lines';
import { unitCostOf } from '../graph/cost';
import { activeCompanies, activeProducts, capabilityIndex, clamp, emitEvent, money, ratio, roleHeadcount, totalHeadcount, unit } from './util';

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

/* -------------------------------------------------------------------------- */
/*  Public work                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The open competition this company would most like to win, or null.
 *
 * Eligibility is checked here rather than left to the validator so that an
 * archetype default never produces a report line explaining why a company
 * nobody was thinking about could not do something it never meant to do. The
 * gates restated are exactly the ones `disqualificationReasons` applies: the
 * bid is either legal and scoreable or it is not made.
 */
export function bidTarget(draft: SessionState, ctx: ResolverContext, company: Company): ProcurementOpportunity | null {
  const technicalStaff = roleHeadcount(company, 'engineers') + roleHeadcount(company, 'researchers');
  const eligible = draft.procurementOpportunities.filter((opportunity) => {
    if (opportunity.status !== 'open' || ctx.quarter > opportunity.closeQuarter) return false;
    if (opportunity.visibility !== 'public' && !opportunity.invitedCompanyIds.includes(company.id)) return false;
    if (company.governmentPastPerformance < opportunity.requirements.minimumPastPerformance) return false;
    if (technicalStaff < CLEARANCE_STAFF_REQUIREMENT[opportunity.requirements.clearanceLevel]) return false;
    if (draft.governmentBids.some((bid) => bid.bidderCompanyId === company.id && bid.opportunityId === opportunity.id && bid.status !== 'withdrawn')) {
      return false;
    }
    return true;
  });
  if (eligible.length === 0) return null;
  // Biggest first, then by id: the same competition on every replay.
  eligible.sort((a, b) => (b.maxValue !== a.maxValue ? b.maxValue - a.maxValue : a.id < b.id ? -1 : 1));
  return eligible[0] ?? null;
}

/** The bid an archetype default submits on an opportunity it is eligible for. */
function bidIntent(draft: SessionState, company: Company, opportunity: ProcurementOpportunity, policy: EffectivePolicy): ActionIntent {
  const capability = capabilityIndex(company);
  const cleared = CLEARANCE_STAFF_REQUIREMENT[opportunity.requirements.clearanceLevel];
  const engineers = Math.max(1, Math.round(roleHeadcount(company, 'engineers') * NPC_BID_STAFF_SHARE));
  const researchers = Math.round(roleHeadcount(company, 'researchers') * NPC_BID_STAFF_SHARE);
  const held = company.compute.ownedAccelerators + company.compute.reservedAccelerators;
  const duration = clamp(opportunity.durationQuarters, 1, 40);

  return {
    type: 'bid_government',
    opportunityId: opportunity.id,
    bid: {
      opportunityId: opportunity.id,
      price: money(opportunity.maxValue * NPC_BID_PRICE_SHARE),
      technicalScoreInputs: {
        modelCapability: unit(capability),
        architectureQuality: unit(capability),
        securityPosture: unit(0.5 + 0.5 * (company.reputation.government / 100)),
        reliabilityCommitment: unit(Math.max(NPC_BID_RELIABILITY, requiredReliability(opportunity.requirements.uptimePct))),
        responsibleAiCommitment: unit(0.4 + 0.6 * policy.governmentAppetite),
      },
      computeCommitment: {
        acceleratorUnits: Math.max(0, Math.round(held * NPC_BID_COMPUTE_SHARE)),
        quarters: Math.round(duration),
      },
      staffCommitment: { engineers, researchers, clearedStaff: cleared },
      timeline: {
        deliveryQuarters: Math.max(1, Math.round(duration)),
        milestoneCount: clamp(Math.round(duration / 4), 1, 20),
      },
      subcontractors: [],
      ipConcessions: 'government_use_rights',
      auditRights: 'annual',
      // Comfortably above both the domestic-inference and data-sovereignty gates.
      domesticSourcingPct: 0.9,
      consortiumMemberIds: [],
      narrative: `${company.name} bids ${opportunity.programme} on its standing delivery model.`,
    },
  };
}

/**
 * Deterministic archetype behaviour for background and significant companies
 * that received no instructions this quarter.
 */
/**
 * How much of a shortfall a background company closes in one quarter. A third:
 * enough that a persistent backlog is answered inside a year, slow enough that
 * one noisy quarter does not build a plant nobody needs.
 */
export const NPC_CAPACITY_CATCH_UP = 1 / 3;

/** The most of its cash a background company will put into capacity in one quarter. */
export const NPC_CAPACITY_CASH_SHARE = 0.1;

/**
 * What one background company builds this quarter, per capacity bucket.
 *
 * Two claims on the bucket, in this order: the depreciation it just lost, which
 * it replaces so its own run rate holds, and a share of what its unfilled
 * orders would need, which is how a backlog turns into plant. Bounded by cash,
 * so a company in trouble builds nothing.
 */
export function capacityInvestmentsFor(draft: SessionState, company: Company): ActionIntent[] {
  const wanted = new Map<'plant' | 'fleet' | 'grid', number>();
  for (const product of activeProducts(company)) {
    const node = lineNodeOf(product);
    if (node === undefined) continue;
    const kind = node.capacityKind;
    if (kind !== 'plant' && kind !== 'fleet' && kind !== 'grid') continue;
    const draw = drawPerUnitOf(node, product);
    const units = Math.max(0, product.unitsSoldQuarterly ?? product.activeCustomers);
    const backlog = Math.max(0, product.backlogUnits ?? 0);
    const replaceUsd = units * draw * CAPACITY_UNIT_USD * PPE_DEPRECIATION_PER_QUARTER;
    const growUsd = backlog * draw * CAPACITY_UNIT_USD * NPC_CAPACITY_CATCH_UP;
    wanted.set(kind, (wanted.get(kind) ?? 0) + replaceUsd + growUsd);
  }
  const budget = Math.max(0, company.balanceSheet.assets.cash) * NPC_CAPACITY_CASH_SHARE;
  const total = [...wanted.values()].reduce((sum, value) => sum + value, 0);
  if (total <= 0 || budget <= 0) return [];
  const scale = Math.min(1, budget / total);
  const out: ActionIntent[] = [];
  for (const kind of ['plant', 'fleet', 'grid'] as const) {
    const amountUsd = money((wanted.get(kind) ?? 0) * scale);
    if (amountUsd <= 0) continue;
    out.push({ type: 'invest_capacity', kind, amountUsd });
  }
  return out;
}

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

    /* --- supply chain: publish an open API, build on the best supplier ---- */
    // The owner's second north star, run by policy rather than by a model
    // call for every one of hundreds of background companies: a canSupply
    // line publishes open terms the first quarter it exists, and a line with
    // a real input builds on the best quality-per-dollar offer that is not a
    // direct rival — sticky once chosen, so a background economy's supply
    // graph does not reshuffle itself for no reason every quarter.
    if (isMultiSectorWorld(draft) && !isNodeEconomyWorld(draft)) {
      for (const product of products) {
        const category = categoryOf(company, product);
        if (category.canSupply && (product.supplyTerms === null || product.supplyTerms === undefined)) {
          intents.push({ type: 'set_supply_terms', productId: product.id, terms: defaultSupplyTerms(category) });
        }
        for (const input of category.inputs) {
          const resolved = resolveSupplyLine(draft, company, product, input);
          if (resolved.status === 'supplied') continue; // sticky: already built on something live
          const choice = chooseSupplierDefault(draft, company, product, input);
          if (choice === null) continue;
          intents.push({
            type: 'choose_supplier',
            productId: product.id,
            inputCategoryId: input.categoryId,
            supplierCompanyId: choice.supplierCompanyId,
            supplierProductId: choice.supplierProductId,
          });
        }
      }
    }

    /* --- public work ------------------------------------------------------ */
    // Without this, an offline session opens competitions nobody ever bids on
    // and cancels every one of them for want of a qualified bid.
    if (policy.governmentAppetite >= NPC_BID_APPETITE_FLOOR) {
      const opportunity = bidTarget(draft, ctx, company);
      if (opportunity !== null) intents.push(bidIntent(draft, company, opportunity, policy));
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

  // Last, and for every company the playbook above skipped as well: capacity
  // maintenance is not strategy. A major with a live strategist still replaces
  // the plant that wore out this quarter, and so does one whose strategist did
  // not answer. Without it every rival's output falls by the depreciation rate
  // every quarter for the life of the game, and the world shrinks for no
  // decision anybody took.
  applyNodeDefaults(draft, ctx, sequence);
}

/**
 * The margin below which a background company will not sell.
 *
 * A rival whose inputs have grown dearer raises its price rather than shipping
 * at a loss quarter after quarter. Without this the node market can walk a
 * seeded line under its own cost and nobody in the world reacts — which is not
 * a market, it is a slow bankruptcy nobody chose.
 */
export const NPC_MIN_GROSS_MARGIN = 0.2;

/**
 * How much of the gap to its node's market price a company nobody is directing
 * closes in one quarter.
 *
 * A third: a rival answers the market inside a year rather than inside a
 * quarter, so a price is a decision with weather behind it rather than a
 * spreadsheet cell that snaps. Without any tracking at all a seeded line was
 * struck at launch and never moved again while the node market ran away from
 * it — enterprise software held at $1,500 against a node running $1,605,
 * $1,740, $1,845, $1,950 over four quarters — and since every input rolls up at
 * the market price, the whole world sold into a rising market at last year's
 * money and quietly went broke doing it.
 */
export const NPC_PRICE_TRACKING = 1 / 3;

/** A price move smaller than this is not worth a ledger line or a churn shock. */
export const NPC_PRICE_MOVE_FLOOR = 0.02;

/**
 * Queue the two decisions no company delegates: replacing the capacity that
 * wore out, and refusing to sell under cost.
 *
 * Runs for every company nobody is playing, majors included: neither is
 * strategy, and a major whose strategist did not answer still has to keep its
 * plant standing and its prices above its bill of materials. Skipped per action
 * where the company has already been told what to do this quarter, and skipped
 * entirely below world 3, which has no node lines to read a cost off. Draws no
 * random numbers, so adding it cannot move any other phase's sequence.
 */
export function applyNodeDefaults(draft: SessionState, ctx: ResolverContext, startSequence: number): void {
  if (!isNodeEconomyWorld(draft)) return;
  const cache = createNodeCostCache(draft);
  let sequence = startSequence;
  for (const company of activeCompanies(draft)) {
    if (company.controllerPlayerId !== null) continue;
    const told = (type: ActionIntent['type'], productId?: string): boolean =>
      draft.pendingActions.some(
        (action) =>
          action.quarter === ctx.quarter &&
          action.actorCompanyId === company.id &&
          action.intent.type === type &&
          (productId === undefined || (action.intent as { productId?: string }).productId === productId),
      );

    const intents: ActionIntent[] = told('invest_capacity') ? [] : [...capacityInvestmentsFor(draft, company)];

    // The cost is read at the prices the company can actually see — last
    // quarter's, because the node market prices this quarter after the actions
    // are collected. That is what a buyer knows when it sets a price.
    for (const product of activeProducts(company)) {
      const nodeId = lineNodeIdOf(product);
      if (nodeId === null || told('set_product_price', product.id)) continue;
      const unitCostUsd = unitCostOf(draft, company, nodeId, cache).unitCostUsd;
      if (!(unitCostUsd > 0)) continue;
      const floorUsd = Math.round((unitCostUsd / (1 - NPC_MIN_GROSS_MARGIN)) * 100) / 100;
      // Where the line wants to be: at the price its own node settled at, and
      // never under its own cost floor. The node price is the one anchor world 3
      // has — every input this line buys is rolled up at it — so a line that
      // ignores it is selling at a price from a world that no longer exists.
      const marketUsd = nodeMarketPriceUsd(draft, nodeId);
      const targetUsd = Math.max(floorUsd, marketUsd);
      const before = product.pricePerSeat;
      if (!(targetUsd > 0) || !(before > 0)) continue;
      const nextUsd = Math.max(floorUsd, Math.round((before + (targetUsd - before) * NPC_PRICE_TRACKING) * 100) / 100);
      if (Math.abs(nextUsd - before) <= before * NPC_PRICE_MOVE_FLOOR) continue;
      intents.push({ type: 'set_product_price', productId: product.id, pricePerSeatUsd: nextUsd });
    }

    if (intents.length === 0) continue;

    const actorCharacterId = company.ceoCharacterId ?? makeId('chr', company.id, 'leadership');
    for (let i = 0; i < intents.length; i += 1) {
      const intent = intents[i];
      if (intent === undefined) continue;
      draft.pendingActions.push({
        actionId: makeId('act', draft.sessionId, ctx.quarter, 'npc_capacity', company.id, i),
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
  }
}
