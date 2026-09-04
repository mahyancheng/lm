/**
 * Reading an `ActionIntent` back to a human.
 *
 * Three screens need the same three answers about a queued instruction:
 *
 * - **What is it?** — `describeIntent`, a label plus the terms a player is
 *   actually committing to, formatted through `@frontier/shared` so a figure
 *   reads the same here as it does on the screen that produced it.
 * - **When does it run?** — `phaseOfIntent`, the resolution phase that consumes
 *   it. UI_SYSTEM §17 groups End Quarter by exactly this.
 * - **What does it cost?** — `cashEffectOf`, an *estimate* built from the
 *   validator's own affordability model (`quarterlyHireCostUsd`) and from the
 *   figures on the intent itself. The subsystem that resolves the action owns
 *   the real cost model and may charge more or less; nothing here is presented
 *   as a settled number.
 *
 * Shared by End Quarter, Chief of Staff and the Deal Room, which are one
 * agent's screens. Nothing in this module reaches state it is not given.
 */

import type { ActionIntent, ActionType, ResolutionPhase, SessionState } from '@frontier/contracts';
import { categoryById, quarterLabel } from '@frontier/contracts';
import { formatMoney, formatPct } from '@frontier/shared';
import { quarterlyHireCostUsd } from '@frontier/simulation';

/** `set_research_budget` becomes `set research budget`. */
export function humanise(value: string): string {
  return value.replace(/_/g, ' ');
}

/** Sentence case for a snake-cased enum member. */
export function titleise(value: string): string {
  const spaced = humanise(value);
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/* -------------------------------------------------------------------------- */
/*  Description                                                                */
/* -------------------------------------------------------------------------- */

export interface IntentTerm {
  readonly label: string;
  readonly value: string;
}

export interface IntentDescription {
  /** One line naming the instruction. */
  readonly label: string;
  /** The terms being committed to, in the order a player would read them. */
  readonly terms: readonly IntentTerm[];
}

const term = (label: string, value: string): IntentTerm => ({ label, value });

/**
 * A player-readable rendering of one intent.
 *
 * Deliberately exhaustive over `ActionIntent`: the switch has no `default`, so
 * adding a member to the union without describing it is a compile error rather
 * than a row that silently reads "the instruction propose deal".
 */
export function describeIntent(intent: ActionIntent, startYear: number): IntentDescription {
  switch (intent.type) {
    case 'set_research_budget':
      return { label: 'Set the research budget', terms: [term('Budget', formatMoney(intent.budgetUsd))] };

    case 'abandon_research_project':
      return { label: 'Close a research programme', terms: [term('Programme', intent.projectId)] };

    case 'set_data_policy':
      return {
        label: `Collect customer data at the ${intent.collectionLevel} level`,
        terms: [term('Collection', intent.collectionLevel)],
      };

    case 'license_node':
      return {
        label: `Ask to licence ${intent.nodeId}`,
        terms: [term('Owner', intent.ownerCompanyId), term('Royalty', `${intent.royaltyPct}%`)],
      };

    case 'publish_licence_terms':
      return {
        label: `Offer ${intent.nodeId} to licence`,
        terms: [term('Royalty', `${intent.royaltyPct}%`), term('Open to', intent.openToAll ? 'anybody' : 'non-rivals')],
      };

    case 'start_research_project':
      return {
        label: `Start a programme against ${intent.targetNodeId}`,
        terms: [
          term('Budget a quarter', formatMoney(intent.budgetUsd)),
          term('Compute', `${intent.computeUnits} accelerators`),
          term('Researchers', String(intent.researchersAssigned)),
          term('Disclosure', intent.secret ? 'Secret programme' : 'Published'),
        ],
      };

    case 'adjust_research_project':
      return {
        label: 'Re-resource a running programme',
        terms: [
          term('Budget a quarter', formatMoney(intent.budgetUsd)),
          term('Compute', `${intent.computeUnits} accelerators`),
          term('Researchers', String(intent.researchersAssigned)),
        ],
      };

    case 'propose_innovation':
      return {
        label: `Propose a new node: ${intent.proposal.title}`,
        terms: [
          term('Estimated cost', formatMoney(intent.proposal.estimatedCost)),
          term('Estimated duration', `${intent.proposal.estimatedQuarters} quarters`),
          term('Depends on', intent.proposal.dependencies.join(', ') || 'nothing on the map'),
        ],
      };

    case 'publish_research':
      return {
        label: `Publish ${intent.nodeId}`,
        terms: [term('Mode', titleise(intent.mode)), term('Rationale', intent.rationale || '—')],
      };

    case 'set_product_price':
      return {
        label: `Reprice ${intent.productId}`,
        terms: [term('New list price', `${formatMoney(intent.pricePerSeatUsd)} per seat`)],
      };

    case 'launch_product':
      return {
        label: `Launch ${intent.name}`,
        terms: [
          term('Segment', titleise(intent.segment)),
          term('Category', intent.categoryId === null ? 'Engine default' : (categoryById(intent.categoryId)?.label ?? intent.categoryId)),
          term('Price', `${formatMoney(intent.pricePerSeatUsd)} per seat`),
          term('Launch marketing', formatMoney(intent.launchMarketingUsd)),
          term('Target quality', formatPct(intent.targetQuality)),
          term('Compute intensity', formatPct(intent.computeIntensity)),
        ],
      };

    case 'sunset_product':
      return {
        label: `Retire ${intent.productId}`,
        terms: [term('Wind-down', `${intent.windDownQuarters} quarters`)],
      };

    case 'set_supply_terms':
      return {
        label: `Publish ${intent.productId} as a supply line`,
        terms: [
          term('Open to all', intent.terms.openToAll ? 'Yes' : 'No'),
          term('Price per unit', formatMoney(intent.terms.pricePerUnitUsd)),
          term('Blocked customers', intent.terms.blockedCustomerIds.length > 0 ? intent.terms.blockedCustomerIds.join(', ') : 'None'),
        ],
      };

    case 'choose_supplier':
      return {
        label: `Choose a supplier for ${intent.productId}`,
        terms: [
          term('Input', humanise(intent.inputCategoryId)),
          term('Supplier', intent.supplierCompanyId ?? 'Open market'),
        ],
      };

    case 'set_marketing_budget':
      return {
        label: 'Reallocate marketing spend',
        terms: intent.allocations.map((allocation) => term(titleise(allocation.segment), formatMoney(allocation.budgetUsd))),
      };

    case 'marketing_campaign':
      return {
        label: `Run a ${humanise(intent.theme)} campaign`,
        terms: [
          term('Segment', titleise(intent.segment)),
          term('Budget', formatMoney(intent.budgetUsd)),
          term('Duration', `${intent.quarters} quarters`),
        ],
      };

    case 'hire':
      return {
        label: `Recruit ${intent.count} ${humanise(intent.role)}`,
        terms: [term('Compensation band', titleise(intent.compBand))],
      };

    case 'layoff':
      return {
        label: `Cut ${intent.count} ${humanise(intent.role)}`,
        terms: [term('Severance', `${intent.severanceQuartersOfPay} quarters of pay`)],
      };

    case 'poach_executive':
      return {
        label: `Approach ${intent.targetCharacterId}`,
        terms: [term('Premium offered', formatPct(intent.compPremiumPct)), term('Approach', titleise(intent.approach))],
      };

    case 'appoint_executive':
      return {
        label: `Appoint ${intent.characterId} as ${humanise(intent.executiveRole)}`,
        terms: [term('Annual compensation', formatMoney(intent.annualCompUsd))],
      };

    case 'reserve_compute':
      return {
        label: `Reserve ${intent.units} accelerators`,
        terms: [
          term('Term', `${intent.quarters} quarters`),
          term('Price ceiling', `${formatMoney(intent.maxPricePerUnitUsd)} a unit a quarter`),
        ],
      };

    case 'buy_cloud_capacity':
      return {
        label: 'Buy on-demand cloud capacity',
        terms: [
          term('Quarterly spend', formatMoney(intent.quarterlySpendUsd)),
          term('Provider', intent.providerCompanyId ?? 'At market'),
          term('Commitment', intent.commitmentQuarters === 0 ? 'Fully flexible' : `${intent.commitmentQuarters} quarters`),
        ],
      };

    case 'buy_accelerators':
      return {
        label: `Buy ${intent.units} accelerators`,
        terms: [
          term('Seller', intent.sellerCompanyId ?? 'Cheapest with capacity'),
          term('Price ceiling', `${formatMoney(intent.maxPricePerUnitUsd)} an accelerator'`.replace("'", '')),
        ],
      };

    case 'invest_capacity':
      return {
        label: `Invest in ${titleise(intent.kind)} capacity`,
        terms: [term('Amount', formatMoney(intent.amountUsd))],
      };

    case 'allocate_compute':
      return {
        label: 'Split held compute',
        terms: [
          term('Training', formatPct(intent.trainingFraction)),
          term('Serving', formatPct(1 - intent.trainingFraction)),
        ],
      };

    case 'raise_round':
      return {
        label: `Attempt a ${humanise(intent.stage)} raise`,
        terms: [term('Sought', formatMoney(intent.targetAmountUsd)), term('Dilution ceiling', formatPct(intent.maxDilutionPct))],
      };

    case 'issue_debt':
      return {
        label: 'Attempt a debt issue',
        terms: [
          term('Principal', formatMoney(intent.amountUsd)),
          term('Coupon ceiling', formatPct(intent.maxRatePct)),
          term('Term', `${intent.termQuarters} quarters`),
        ],
      };

    case 'buyback':
      return {
        label: 'Repurchase shares',
        terms: [term('Budget', formatMoney(intent.budgetUsd)), term('Price ceiling', formatMoney(intent.maxPricePerShareUsd))],
      };

    case 'issue_shares':
      return {
        label: `Issue ${intent.shares} shares`,
        terms: [term('Class', intent.shareClassId), term('Price floor', formatMoney(intent.minPricePerShareUsd))],
      };

    case 'ipo':
      return {
        label: 'Take the company public',
        terms: [
          term('Float', formatPct(intent.floatPct)),
          term('Primary raise', formatMoney(intent.targetRaiseUsd)),
          term('Price floor', formatMoney(intent.minPricePerShareUsd)),
        ],
      };

    case 'set_dividend_policy':
      return {
        label: 'Set the payout policy',
        terms: [
          term('Payout', `${intent.payoutPct}% of net income`),
          term('Struck on', "Last quarter's result"),
          term('Cap', 'Never more than half of cash'),
        ],
      };

    case 'set_logistics_toll':
      return {
        label: `Set the freight toll in ${intent.region.replace(/_/g, ' ')}`,
        terms: [
          term('Toll', `${intent.tollPct}% on rivals' inputs`),
          term('Your group', 'Exempt'),
          term('Ceiling', "What your group's regional share earns"),
        ],
      };

    case 'buy_shares':
      return {
        label: `Accumulate ${intent.securityId}`,
        terms: [
          term('Size', intent.shares !== null ? `${intent.shares} shares` : intent.targetPct !== null ? `to ${formatPct(intent.targetPct)}` : 'unspecified'),
          term('Price ceiling', formatMoney(intent.maxPricePerShareUsd)),
        ],
      };

    case 'sell_shares':
      return {
        label: `Sell ${intent.shares} of ${intent.securityId}`,
        terms: [term('Price floor', formatMoney(intent.minPricePerShareUsd))],
      };

    case 'acquire_company':
      return {
        label: `Offer for ${intent.targetCompanyId}`,
        terms: [
          term('Offer value', formatMoney(intent.offerValueUsd)),
          term('Cash', formatPct(intent.cashPct)),
          term('Stock', formatPct(intent.stockPct)),
        ],
      };

    case 'submit_board_proposal':
      return {
        label: `Table "${intent.title}"`,
        terms: [
          term('Kind', titleise(intent.kind)),
          term('Headline size', intent.amountUsd === null ? 'No price' : formatMoney(intent.amountUsd)),
          ...(intent.targetCompanyId === null ? [] : [term('Target', intent.targetCompanyId)]),
          ...(intent.stockComponentPct === null ? [] : [term('Stock component', formatPct(intent.stockComponentPct))]),
        ],
      };

    case 'lobby_director':
      return {
        label: `Speak to ${intent.directorCharacterId} before the vote`,
        terms: [
          term('Proposal', intent.proposalId),
          term('Concessions', intent.concessions.length === 0 ? 'None offered' : `${intent.concessions.length} offered`),
        ],
      };

    case 'bid_government':
      return {
        label: `Bid on ${intent.opportunityId}`,
        terms: [
          term('Price', formatMoney(intent.bid.price)),
          term('Delivery', `${intent.bid.timeline.deliveryQuarters} quarters`),
          term('Milestones', String(intent.bid.timeline.milestoneCount)),
          term('Domestic sourcing', formatPct(intent.bid.domesticSourcingPct)),
        ],
      };

    case 'decline_opportunity':
      return { label: `Decline ${intent.opportunityId}`, terms: [term('Reason', intent.reason || '—')] };

    case 'form_consortium':
      return {
        label: `Propose a consortium on ${intent.opportunityId}`,
        terms: [
          term('Prime', intent.leadCompanyId),
          term('Invitees', intent.inviteeCompanyIds.join(', ')),
          term('Your share', formatPct(intent.sharePct)),
        ],
      };

    case 'meet_regulator':
      return {
        label: `Meet ${intent.regulatorCharacterId}`,
        terms: [
          term('Topic', titleise(intent.topic)),
          term('Posture', titleise(intent.posture)),
          term('Concessions', intent.concessionsOffered.length === 0 ? 'None' : intent.concessionsOffered.join('; ')),
        ],
      };

    case 'social_post':
      return {
        label: `Post to ${humanise(intent.draft.network)}`,
        terms: [
          term('Intent', titleise(intent.draft.intent)),
          term('Target', intent.draft.targetCompanyId ?? 'No specific rival'),
          term('Text', intent.draft.text),
        ],
      };

    case 'give_guidance':
      return {
        label: `Guide ${humanise(intent.metric)}`,
        terms: [
          term('Value', intent.metric === 'gross_margin' ? formatPct(intent.value) : formatMoney(intent.value)),
          term('For', quarterLabel(startYear, intent.quarter)),
        ],
      };

    case 'respond_crisis':
      return {
        label: `Respond to ${intent.crisisEventId}`,
        terms: [term('Response', titleise(intent.responseKind)), term('Statement', intent.statement || '—')],
      };

    case 'propose_deal':
      return {
        label: `Propose a deal to ${intent.proposal.counterpartyId}`,
        terms: [
          term('Binding', intent.proposal.binding ? 'Yes — obligations are enforced' : 'No — a recorded statement of intent'),
          term('You give', intent.proposal.gives.map((obligation) => humanise(obligation.kind)).join(', ') || 'nothing'),
          term('You get', intent.proposal.gets.map((obligation) => humanise(obligation.kind)).join(', ') || 'nothing'),
          term('Confidentiality', titleise(intent.proposal.confidentiality)),
          term('Expires', quarterLabel(startYear, intent.proposal.expiresQuarter)),
        ],
      };

    case 'accept_deal':
      return { label: `Accept ${intent.dealId}`, terms: [] };

    case 'reject_deal':
      return { label: `Reject ${intent.dealId}`, terms: [term('Reason', intent.reason || '—')] };

    case 'request_introduction':
      return {
        label: `Ask ${intent.viaCharacterId} for an introduction`,
        terms: [term('To', intent.targetCharacterId), term('Purpose', intent.purpose || '—')],
      };

    case 'transfer_between_group':
      return {
        label: `Move ${intent.cashUsd !== null ? 'cash' : 'accelerators'} within the group`,
        terms: [
          term('From', intent.fromCompanyId),
          term('To', intent.toCompanyId),
          intent.cashUsd !== null ? term('Amount', formatMoney(intent.cashUsd)) : term('Units', `${intent.acceleratorUnits ?? 0} accelerators`),
        ],
      };

    case 'merge_subsidiary':
      return {
        label: `Fully absorb ${intent.subsidiaryCompanyId}`,
        terms: [term('Subsidiary', intent.subsidiaryCompanyId), term('Reversible', 'No')],
      };
  }
}

/* -------------------------------------------------------------------------- */
/*  Phase routing                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The resolution phase that consumes each action type.
 *
 * Mirrors the resolver's own routing: `RESOLUTION_PHASES` fixes the order, and
 * every action is read by exactly one phase after `action_collection` has
 * reduced the queue to what will actually run.
 */
export const PHASE_OF_ACTION: Readonly<Record<ActionType, ResolutionPhase>> = {
  submit_board_proposal: 'board_resolution',
  lobby_director: 'board_resolution',

  raise_round: 'capital_resolution',
  issue_debt: 'capital_resolution',
  buyback: 'capital_resolution',
  issue_shares: 'capital_resolution',
  ipo: 'capital_resolution',
  set_dividend_policy: 'capital_resolution',
  set_logistics_toll: 'capital_resolution',
  buy_shares: 'capital_resolution',
  sell_shares: 'capital_resolution',
  acquire_company: 'capital_resolution',
  transfer_between_group: 'capital_resolution',
  merge_subsidiary: 'capital_resolution',

  bid_government: 'government_resolution',
  decline_opportunity: 'government_resolution',
  form_consortium: 'government_resolution',
  meet_regulator: 'government_resolution',

  hire: 'talent_resolution',
  layoff: 'talent_resolution',
  poach_executive: 'talent_resolution',
  appoint_executive: 'talent_resolution',

  set_research_budget: 'research_resolution',
  start_research_project: 'research_resolution',
  adjust_research_project: 'research_resolution',
  // Both land in the research phase: closing a programme and changing the
  // collection level are applied before the quarter advances, so a decision
  // taken this quarter is the one this quarter runs on.
  abandon_research_project: 'research_resolution',
  set_data_policy: 'research_resolution',
  // Licensing is a bargain between two companies, so it lands where every other
  // deal does — and early enough that a licence granted this quarter is in
  // force for this quarter's production.
  license_node: 'capital_resolution',
  publish_licence_terms: 'capital_resolution',
  propose_innovation: 'research_resolution',
  publish_research: 'research_resolution',
  reserve_compute: 'research_resolution',
  buy_cloud_capacity: 'research_resolution',
  buy_accelerators: 'product_demand_resolution',
  invest_capacity: 'product_demand_resolution',
  allocate_compute: 'research_resolution',

  set_product_price: 'product_demand_resolution',
  launch_product: 'product_demand_resolution',
  sunset_product: 'product_demand_resolution',
  set_marketing_budget: 'product_demand_resolution',
  marketing_campaign: 'product_demand_resolution',
  set_supply_terms: 'product_demand_resolution',
  choose_supplier: 'product_demand_resolution',

  give_guidance: 'disclosure_resolution',
  respond_crisis: 'disclosure_resolution',

  social_post: 'social_resolution',

  propose_deal: 'relationship_update',
  accept_deal: 'relationship_update',
  reject_deal: 'relationship_update',
  request_introduction: 'relationship_update',
};

/** The phase that will consume this intent. */
export function phaseOfIntent(intent: ActionIntent): ResolutionPhase {
  return PHASE_OF_ACTION[intent.type];
}

/* -------------------------------------------------------------------------- */
/*  Cash estimate                                                              */
/* -------------------------------------------------------------------------- */

export interface CashEffect {
  /** Cash the instruction commits this quarter, at the ceilings the player set. */
  readonly outflowUsd: number;
  /** Cash the instruction *seeks*. An attempt, never a receipt. */
  readonly inflowUsd: number;
  /** Why the figure is what it is, or why there is none. */
  readonly note: string | null;
}

const NONE: CashEffect = { outflowUsd: 0, inflowUsd: 0, note: null };

/**
 * What one instruction does to cash this quarter, estimated.
 *
 * The validator's own comment on these figures applies here too: they are
 * affordability heuristics, not the economy. A player looking at End Quarter
 * needs to see they have committed 120% of their cash *before* the engine tells
 * them, and that is what this is for.
 */
export function cashEffectOf(session: SessionState, intent: ActionIntent): CashEffect {
  switch (intent.type) {
    case 'set_research_budget':
      return { outflowUsd: intent.budgetUsd, inflowUsd: 0, note: 'The quarter\'s research envelope.' };
    case 'start_research_project':
      return { outflowUsd: intent.budgetUsd, inflowUsd: 0, note: 'Cash a quarter, excluding compute.' };
    case 'launch_product':
      return { outflowUsd: intent.launchMarketingUsd, inflowUsd: 0, note: 'One-off launch marketing.' };
    case 'set_marketing_budget':
      return {
        outflowUsd: intent.allocations.reduce((total, allocation) => total + allocation.budgetUsd, 0),
        inflowUsd: 0,
        note: 'Across every named segment.',
      };
    case 'marketing_campaign':
      return { outflowUsd: intent.budgetUsd, inflowUsd: 0, note: `Spread over ${intent.quarters} quarters.` };
    case 'hire': {
      const perHead = quarterlyHireCostUsd(session, intent.role, intent.compBand);
      return {
        outflowUsd: perHead * intent.count,
        inflowUsd: 0,
        note: `${formatMoney(perHead)} a quarter each at ${humanise(intent.compBand)}, at the current salary pressure.`,
      };
    }
    case 'layoff': {
      const perHead = quarterlyHireCostUsd(session, intent.role, 'market');
      return {
        outflowUsd: perHead * intent.count * intent.severanceQuartersOfPay,
        inflowUsd: 0,
        note: 'Severance is paid now; the payroll saving arrives afterwards.',
      };
    }
    case 'reserve_compute':
      return {
        outflowUsd: intent.units * intent.maxPricePerUnitUsd,
        inflowUsd: 0,
        note: 'At your stated ceiling, for one quarter of the term.',
      };
    case 'buy_cloud_capacity':
      return { outflowUsd: intent.quarterlySpendUsd, inflowUsd: 0, note: 'On-demand, this quarter.' };
    case 'buy_accelerators':
      return {
        outflowUsd: intent.units * intent.maxPricePerUnitUsd,
        inflowUsd: 0,
        note: 'At your stated ceiling. Capital, paid in the quarter it clears; the seller books it as revenue.',
      };
    case 'invest_capacity':
      return { outflowUsd: intent.amountUsd, inflowUsd: 0, note: 'Capital, paid in the quarter it clears; it depreciates like any other property.' };
    case 'buyback':
      return { outflowUsd: intent.budgetUsd, inflowUsd: 0, note: 'Capital returned rather than invested.' };
    case 'acquire_company':
      return {
        outflowUsd: intent.offerValueUsd * intent.cashPct,
        inflowUsd: 0,
        note: 'The cash component only; the stock component dilutes instead.',
      };
    case 'set_dividend_policy':
      return { outflowUsd: 0, inflowUsd: 0, note: 'The payout is settled next quarter, on this quarter\u2019s net income.' };
    case 'set_logistics_toll':
      return { outflowUsd: 0, inflowUsd: 0, note: 'A toll costs you nothing; it costs everybody else in the region.' };
    case 'buy_shares':
      return {
        outflowUsd: intent.shares === null ? 0 : intent.shares * intent.maxPricePerShareUsd,
        inflowUsd: 0,
        note: intent.shares === null ? 'Sized as a target percentage; the cost depends on where the book clears.' : 'At your price ceiling.',
      };
    case 'sell_shares':
      return { outflowUsd: 0, inflowUsd: intent.shares * intent.minPricePerShareUsd, note: 'At your price floor, if it clears.' };
    case 'raise_round':
      return { outflowUsd: 0, inflowUsd: intent.targetAmountUsd, note: 'Sought, not received: the market decides.' };
    case 'issue_debt':
      return { outflowUsd: 0, inflowUsd: intent.amountUsd, note: 'Sought, not received: the book decides.' };
    case 'issue_shares':
      return { outflowUsd: 0, inflowUsd: intent.shares * intent.minPricePerShareUsd, note: 'At the price floor, if it clears.' };
    case 'ipo':
      return { outflowUsd: 0, inflowUsd: intent.targetRaiseUsd, note: 'Primary capital sought at listing.' };
    case 'bid_government':
      return { outflowUsd: 0, inflowUsd: 0, note: 'A bid commits capacity, not cash: revenue arrives on milestones.' };
    case 'propose_deal':
      return { outflowUsd: 0, inflowUsd: 0, note: 'Nothing moves until the counterparty accepts.' };
    case 'accept_deal':
      return { outflowUsd: 0, inflowUsd: 0, note: 'Obligations begin executing next quarter.' };
    case 'transfer_between_group':
      return intent.cashUsd !== null
        ? { outflowUsd: intent.cashUsd, inflowUsd: 0, note: 'Moves within the group; nothing leaves it.' }
        : { outflowUsd: 0, inflowUsd: 0, note: 'Compute, not cash, moves within the group.' };
    case 'merge_subsidiary':
      return { outflowUsd: 0, inflowUsd: 0, note: 'The stake was already paid for when it became a subsidiary.' };
    default:
      return NONE;
  }
}
