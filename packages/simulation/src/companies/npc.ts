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
 * ## The executive, and the grudge
 *
 * Only a handful of rivals get a live model call in a quarter, so this file —
 * not the prompt — is where most rival behaviour comes from most of the time.
 * Two things therefore reach it:
 *
 * - **The chief executive's five stable traits**, through `executiveDialsFor`.
 *   They bend the archetype tables inside the bounds those tables already run
 *   through: an aggressive executive prices nearer the floor, hires ahead of
 *   demand and bids on more public work; a financially conservative one holds
 *   its cash, pays less and refuses to bid a programme thin; a status-sensitive
 *   one answers slights in public and publishes what it has proved; a
 *   technically oriented one funds the lab before the campaign.
 * - **The company's own engine-written grudges**, through `strategistMemory`.
 *   A rival carrying a real, recent injury undercuts the company that caused it,
 *   bids against it, and — if the person in the chair is the sort — raids its
 *   people and answers in public.
 *
 * Both are pure functions of committed state. Neither is model output, neither
 * adds an RNG draw, and both replay identically from a save.
 *
 * Determinism: the only RNG draw here is a small jitter on hiring size, taken
 * once per company in stable array order.
 */

import type {
  ActionIntent,
  Company,
  ProcurementOpportunity,
  ResolverContext,
  SessionState,
  StaffRole,
  StrategistGrudge,
  SubmittedAction,
} from '@frontier/contracts';
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
  NEUTRAL_EXECUTIVE_DIALS,
  effectivePolicy,
  personalisedPolicy,
  type EffectivePolicy,
  type ExecutiveDials,
} from './archetypes';
import { executiveDialsFor } from './policy';
import { PPE_DEPRECIATION_PER_QUARTER, RUNWAY_CAP_QUARTERS } from './balance';
import { categoryOf } from './categories';
import { chooseSupplierDefault, defaultSupplyTerms, resolveSupplyLine } from './supply';
import { isNodePublic } from '../research/projection';
import { isMultiSectorWorld, isNodeEconomyWorld } from '../economy/sectors';
import { CAPACITY_UNIT_USD, createNodeCostCache, drawPerUnitOf, lineNodeIdOf, lineNodeOf } from '../graph/lines';
import { unitCostOf } from '../graph/cost';
import { npcFillsFor, npcSupplyTermsFor } from './npcSlots';
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
/*  Grudges                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Below this a grudge is a note in the file rather than a change of plan.
 *
 * Thirty is what a single ordinary slight is worth on the day it happens
 * (`GRUDGE_BASE_INTENSITY`: a poaching approach, a board vote, an activist
 * letter). So the rule reads: one fresh slight is enough to change how this
 * company deals with you, and a slight already half forgotten is not.
 */
export const GRUDGE_ACTION_THRESHOLD = 30;

/**
 * Extra quarterly price cut aimed at a rival we hold a grudge against, at full
 * intensity. Three points a quarter is the width of a posture change, so being
 * hated is worth about as much price pressure as a rival switching to a land
 * grab — real, and not a death sentence.
 */
export const GRUDGE_UNDERCUT_MAX = 0.03;

/**
 * Grudge intensity at which an executive goes after the other side's people.
 *
 * Fifty-five: above what any single slight is worth, so a raid needs an injury
 * that was either severe (a betrayal at 45 with hostility behind it) or
 * repeated. Companies do not raid each other over one lost tender.
 */
export const GRUDGE_POACH_THRESHOLD = 55;

/** Aggression lean below which an executive does not raid, whatever the grudge. */
export const GRUDGE_POACH_AGGRESSION = 0.2;

/** What a raid offers over the market rate for the post. Generous, and not absurd. */
export const GRUDGE_POACH_PREMIUM_PCT = 0.35;

/**
 * Grudge intensity at which a status-sensitive executive answers in public.
 * Lower than a raid because a post costs nothing but standing, which is exactly
 * the currency a status-sensitive person is willing to spend.
 */
export const GRUDGE_POST_THRESHOLD = 45;

/** Publicity lean below which an executive lets a slight pass without comment. */
export const GRUDGE_POST_PUBLICITY = 0.2;

/** Publicity lean at or above which an executive publishes a result it has proved. */
export const PUBLISH_PUBLICITY_LEAN = 0.2;

/**
 * The grudges this company will actually act on, strongest first.
 *
 * A company with no memory yet — a world-1 or world-2 save, or a state in which
 * no quarter has resolved — carries none, which is the neutral reading and not a
 * missing key.
 */
export function actionableGrudges(company: Company): readonly StrategistGrudge[] {
  const held = company.strategistMemory?.grudges ?? [];
  return held
    .filter((grudge) => grudge.intensity >= GRUDGE_ACTION_THRESHOLD)
    .slice()
    .sort((a, b) => b.intensity - a.intensity || (a.companyId < b.companyId ? -1 : 1));
}

/**
 * A grudge is FRESH in the quarter after the one that last reinforced it.
 *
 * `strategistMemory` is written in phase 16 of quarter Q; this runs in phase 4
 * of quarter Q+1. So `grudge.quarter === ctx.quarter - 1` is "they did it to us
 * last quarter" — which is the only window in which the one-off retaliations
 * below fire. Without it a standing grudge would launch a raid every quarter for
 * as long as it lasted, and the answer to an injury would be a siege.
 */
function isFresh(grudge: StrategistGrudge, quarter: number): boolean {
  return grudge.quarter === quarter - 1;
}

/**
 * How hard this company wants to undercut somebody in one segment.
 *
 * Only a grudge against a company that actually sells into the segment counts:
 * cutting the price of a product a rival does not compete on is not revenge, it
 * is a gift to our own customers.
 */
function undercutIntensity(draft: SessionState, grudges: readonly StrategistGrudge[], segment: string): number {
  let worst = 0;
  for (const grudge of grudges) {
    const rival = draft.companies.find((candidate) => candidate.id === grudge.companyId);
    if (rival === undefined || !rival.isActive) continue;
    if (!rival.products.some((product) => product.isActive && product.segment === segment)) continue;
    if (grudge.intensity > worst) worst = grudge.intensity;
  }
  return worst;
}

/**
 * The raid a fresh, severe grudge provokes, or null.
 *
 * Deterministic in every part: the grudge list is already sorted strongest
 * first, and the person approached is the most connected active employee of the
 * offending company, ties broken by character id. One raid per company per
 * quarter, and only in the quarter after the injury.
 */
function raidIntent(draft: SessionState, ctx: ResolverContext, company: Company, grudges: readonly StrategistGrudge[], dials: ExecutiveDials): ActionIntent | null {
  if (dials.aggressionLean < GRUDGE_POACH_AGGRESSION) return null;
  for (const grudge of grudges) {
    if (grudge.intensity < GRUDGE_POACH_THRESHOLD || !isFresh(grudge, ctx.quarter)) continue;
    const rival = draft.companies.find((candidate) => candidate.id === grudge.companyId);
    if (rival === undefined || !rival.isActive || rival.id === company.id) continue;
    // Never the other side's sitting chief executive. Two reasons, and both are
    // constraints rather than taste: a founder in the chair is not for sale at a
    // recruiter's premium, and nothing in the engine refills a rival's empty
    // chair — only a board can appoint, and a background rival has no board — so
    // a successful decapitation would delete that company's personality from the
    // world permanently, which is the opposite of what this file is for.
    const people = draft.characters
      .filter((character) => character.isActive && character.companyId === rival.id && !character.isPlayer && character.id !== rival.ceoCharacterId)
      .slice()
      .sort((a, b) => b.connectionLevel - a.connectionLevel || (a.id < b.id ? -1 : 1));
    const target = people[0];
    if (target === undefined) continue;
    return {
      type: 'poach_executive',
      targetCharacterId: target.id,
      compPremiumPct: GRUDGE_POACH_PREMIUM_PCT,
      // Public, because the point of this approach is that the other side hears
      // about it. A private one would be a hiring decision, not an answer.
      approach: 'public',
    };
  }
  return null;
}

/** Characters cannot be quoted; the post is assembled from the grudge the engine wrote. */
const MAX_POST_CHARS = 560;

/**
 * Networks a public answer is preferred on, widest audience first. `fast_feed`
 * carries journalists, investors, founders and consumers, which is where a
 * company answering an injury wants to be heard.
 */
const POST_NETWORK_PREFERENCE = ['fast_feed', 'professional', 'community', 'video', 'technical_forum', 'finance'] as const;

/** The network this executive can actually post on, or null when they have no account anywhere. */
function postNetworkFor(draft: SessionState, company: Company, authorCharacterId: string): (typeof POST_NETWORK_PREFERENCE)[number] | null {
  const held = new Set(
    draft.socialAccounts
      .filter((account) => account.isActive && (account.ownerCharacterId === authorCharacterId || account.ownerCompanyId === company.id))
      .map((account) => account.network),
  );
  for (const network of POST_NETWORK_PREFERENCE) if (held.has(network)) return network;
  return null;
}

/**
 * The public answer a fresh grudge provokes in a status-sensitive executive, or
 * null. The text is the engine's own record of what happened — nothing here is
 * model output, and nothing is invented.
 */
function postIntent(draft: SessionState, ctx: ResolverContext, company: Company, grudges: readonly StrategistGrudge[], dials: ExecutiveDials): ActionIntent | null {
  if (dials.publicityLean < GRUDGE_POST_PUBLICITY) return null;
  const author = company.ceoCharacterId;
  if (author === null) return null;
  // Checked here rather than left to the validator, for the same reason
  // `bidTarget` restates the procurement gates: an executive with no account on
  // any network does not try to post and get a refusal in the report for
  // something they never meant to do.
  const network = postNetworkFor(draft, company, author);
  if (network === null) return null;
  for (const grudge of grudges) {
    if (grudge.intensity < GRUDGE_POST_THRESHOLD || !isFresh(grudge, ctx.quarter)) continue;
    const rival = draft.companies.find((candidate) => candidate.id === grudge.companyId);
    if (rival === undefined || !rival.isActive) continue;
    return {
      type: 'social_post',
      draft: {
        authorCharacterId: author,
        network,
        text: `${company.name} is not going to pretend this did not happen. ${grudge.reason}`.slice(0, MAX_POST_CHARS),
        intent: 'attack',
        targetCompanyId: rival.id,
      },
    };
  }
  return null;
}

/**
 * The result a status-sensitive executive publishes, or null.
 *
 * Bounded by the world rather than by a counter: only a node this company has
 * actually finished and that is still private can be published, and publishing
 * makes it public, so the same result is never published twice. A technical
 * executive writes the paper; a status-sensitive one who is not technical
 * demonstrates the product instead, which buys public and investor standing and
 * keeps the method.
 */
function publicationIntent(draft: SessionState, company: Company, dials: ExecutiveDials): ActionIntent | null {
  if (dials.publicityLean < PUBLISH_PUBLICITY_LEAN) return null;
  const finished = draft.researchProjects
    .filter((project) => project.companyId === company.id && project.status === 'succeeded')
    .map((project) => project.targetNodeId)
    .sort();
  for (const nodeId of finished) {
    const node = draft.techGraph.nodes.find((candidate) => candidate.id === nodeId);
    if (node === undefined || isNodePublic(node)) continue;
    return {
      type: 'publish_research',
      nodeId,
      mode: dials.technicalLean >= 0 ? 'paper' : 'product_demonstration',
      rationale: `${company.name} wants the credit for ${node.title} while it is still ours to claim.`,
    };
  }
  return null;
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
export function bidTarget(
  draft: SessionState,
  ctx: ResolverContext,
  company: Company,
  contestedIds: ReadonlySet<string> = EMPTY_ID_SET,
): ProcurementOpportunity | null {
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
  // A company we hold a grudge against, already bidding, moves its competition
  // to the front: bidding against them is the point, and the value of the
  // programme is the tie-break rather than the ranking. Then biggest first, then
  // by id: the same competition on every replay.
  const contested = (opportunity: ProcurementOpportunity): number =>
    contestedIds.size > 0 &&
    draft.governmentBids.some(
      (bid) => bid.opportunityId === opportunity.id && bid.status !== 'withdrawn' && contestedIds.has(bid.bidderCompanyId),
    )
      ? 1
      : 0;
  eligible.sort((a, b) => contested(b) - contested(a) || (b.maxValue !== a.maxValue ? b.maxValue - a.maxValue : a.id < b.id ? -1 : 1));
  return eligible[0] ?? null;
}

/** Shared empty set, so the default argument allocates nothing per company per quarter. */
const EMPTY_ID_SET: ReadonlySet<string> = new Set<string>();

/** The bid an archetype default submits on an opportunity it is eligible for. */
function bidIntent(
  draft: SessionState,
  company: Company,
  opportunity: ProcurementOpportunity,
  policy: EffectivePolicy,
  dials: ExecutiveDials = NEUTRAL_EXECUTIVE_DIALS,
): ActionIntent {
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
      // What this executive is willing to leave on the table. Bounded well inside
      // the ceiling either way, so an aggressive bid is still a priced bid.
      price: money(opportunity.maxValue * clamp(NPC_BID_PRICE_SHARE + dials.bidPriceShareDelta, 0.6, 0.98)),
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
export function capacityInvestmentsFor(draft: SessionState, company: Company, dials: ExecutiveDials = NEUTRAL_EXECUTIVE_DIALS): ActionIntent[] {
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
  // The one capital decision a company nobody is directing makes, and therefore
  // the only place "holds more cash" can mean anything: a conservative executive
  // commits less of the balance to plant, a risk-tolerant one more.
  const budget = Math.max(0, company.balanceSheet.assets.cash) * NPC_CAPACITY_CASH_SHARE * dials.capacityCashFactor;
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

    // Who is running this company, and what they are carrying. Both are
    // committed state: no RNG is drawn for either, and a replay reproduces them.
    const dials = executiveDialsFor(draft, company);
    const policy = personalisedPolicy(effectivePolicy(company.archetype, company.posture), dials);
    const grudges = actionableGrudges(company);
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
    // Priced per product rather than per company, because the grudge cut is
    // aimed at whoever we are actually fighting: a line a hated rival does not
    // sell into is priced exactly as the policy says. With no grudge in the
    // segment the nudge is the policy's own and the gate is unchanged.
    //
    // A node line is skipped here and priced once, by `applyNodeDefaults`, which
    // knows the line's cost floor and the price its node actually settled at.
    // Two price decisions on one line would mean the first one silently won —
    // whichever ran first — and world 3 would drift off its only anchor.
    for (const product of products) {
      if (lineNodeIdOf(product) !== null) continue;
      const undercut = (GRUDGE_UNDERCUT_MAX * undercutIntensity(draft, grudges, product.segment)) / 100;
      const nudge = policy.pricingNudge - undercut;
      if (Math.abs(nudge) < NPC_MIN_PRICE_MOVE) continue;
      const next = money(product.pricePerSeat * (1 + nudge));
      if (next === product.pricePerSeat) continue;
      intents.push({ type: 'set_product_price', productId: product.id, pricePerSeatUsd: next });
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
      const opportunity = bidTarget(draft, ctx, company, new Set(grudges.map((grudge) => grudge.companyId)));
      if (opportunity !== null) intents.push(bidIntent(draft, company, opportunity, policy, dials));
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

    /* --- answering an injury, and taking the credit ------------------------ */
    // Appended after the playbook so that a company with nothing to answer
    // queues exactly the actions it queued before any of this existed — same
    // order, same synthesised action ids.
    const raid = raidIntent(draft, ctx, company, grudges, dials);
    if (raid !== null) intents.push(raid);
    const post = postIntent(draft, ctx, company, grudges, dials);
    if (post !== null) intents.push(post);
    const publication = publicationIntent(draft, company, dials);
    if (publication !== null) intents.push(publication);

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
 * How far an executive may sit off the price its node settled at.
 *
 * Four percent. A node line has exactly one anchor — the market its own inputs
 * are rolled up at — so an executive's lean is a POSITION against that market
 * (a discounter sits under it, a premium seller over it), never a replacement
 * for it. Bounded tightly on purpose: at four percent the line still converges
 * on the market within a year, which is the world-3 repair this file exists to
 * keep, and a company that wants to be cheaper than that has to actually be
 * cheaper — the cost floor below is not negotiable.
 */
export const NODE_PRICE_LEAN_BOUND = 0.04;

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

    const dials = executiveDialsFor(draft, company);
    const grudges = actionableGrudges(company);
    const policy = personalisedPolicy(effectivePolicy(company.archetype, company.posture), dials);
    const intents: ActionIntent[] = told('invest_capacity') ? [] : [...capacityInvestmentsFor(draft, company, dials)];

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
      // Where this executive wants to sit relative to that market, and how much
      // of that lean is aimed at somebody in particular. Both bounded, and both
      // beneath the cost floor in priority: nobody sells at a loss out of spite.
      const undercut = (GRUDGE_UNDERCUT_MAX * undercutIntensity(draft, grudges, product.segment)) / 100;
      const lean = clamp(policy.pricingNudge - undercut, -NODE_PRICE_LEAN_BOUND, NODE_PRICE_LEAN_BOUND);
      const targetUsd = Math.max(floorUsd, marketUsd * (1 + lean));
      const before = product.pricePerSeat;
      if (!(targetUsd > 0) || !(before > 0)) continue;
      const nextUsd = Math.max(floorUsd, Math.round((before + (targetUsd - before) * NPC_PRICE_TRACKING) * 100) / 100);
      if (Math.abs(nextUsd - before) <= before * NPC_PRICE_MOVE_FLOOR) continue;
      intents.push({ type: 'set_product_price', productId: product.id, pricePerSeatUsd: nextUsd });
    }

    // The composed line: every node line publishes itself and refills its
    // slots by the policies in npcSlots.ts, each skipped where the company has
    // already been told this quarter.
    for (const product of activeProducts(company)) {
      const node = lineNodeOf(product);
      if (node === undefined) continue;
      if (!told('set_supply_terms', product.id)) {
        const terms = npcSupplyTermsFor(product);
        if (terms !== null) intents.push(terms);
      }
      if (!told('fill_slot', product.id)) intents.push(...npcFillsFor(draft, company, product, node, cache));
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
