/**
 * @frontier/simulation — graph/licensing.ts
 *
 * The right to produce a node you do not own.
 *
 * The owner's sentence — *"I can purchase or invest but I don't start with
 * it"* — has two mechanical answers. Buying the company is one and lives in
 * `resolver/capital.ts`. This is the other: an AI laboratory that will never
 * learn to run a fab pays the company that can, every quarter, for the right to
 * make its own accelerators.
 *
 * ## Three prices, in order
 *
 * 1. **Research it.** The mid of the node's own research range, over several
 *    quarters, with the risk of overrun — and you own it for ever.
 * 2. **Licence it.** `LICENCE_UPFRONT_SHARE` of that mid, once, plus
 *    `royaltyPct` of the revenue of every line that needs it, every quarter,
 *    for `LICENCE_TERM_QUARTERS` — and then the owner decides whether you may
 *    carry on.
 * 3. **Do without.** The roll-up prices the input at market, or the line ships
 *    nothing when nobody makes it at all.
 *
 * Fifteen percent of the mid is about a sixth of what researching costs, which
 * is the shape this has to have: plainly cheaper than research, plainly worse
 * than owning. A licence does not make you the node's `pioneer`, it does not
 * let you sublicense, and it ends.
 *
 * ## Consent is not reinvented
 *
 * A request is an ordinary `DealProposal` carrying an ordinary obligation, so
 * it proposes, expires, is accepted or rejected and is audited by the machinery
 * that already does all of that for every other agreement in the game. What
 * this module adds is the arithmetic and the NPC's answer; `resolver/routing.ts`
 * does the routing, in the phase that owns deals.
 *
 * Determinism: no RNG, no clock. Every function is a pure read of the draft
 * except the two that grant and lapse, which are called from the resolver.
 */

import type { Company, DealProposal, EconomicNode, NodeLicence, NodeLicenceOffer, SessionState } from '@frontier/contracts';
import { economicNodeById } from '@frontier/contracts';
import { lineNodeIdOf } from './lines';

/* -------------------------------------------------------------------------- */
/*  The price of a licence                                                     */
/* -------------------------------------------------------------------------- */

/** How long a licence runs before the owner gets to say no. Three years. */
export const LICENCE_TERM_QUARTERS = 12;

/**
 * The signing fee, as a share of what researching the node would cost.
 *
 * Fifteen percent of the mid estimate. Against a mid of $6.5bn for an AI
 * accelerator that is a little under a billion up front and a royalty on every
 * board after — about a sixth of the programme, which is the ratio that makes
 * licensing the obvious move for a company outside the industry and a bad one
 * for a company that intends to stay in it.
 */
export const LICENCE_UPFRONT_SHARE = 0.15;

/**
 * The band a royalty is held inside.
 *
 * Below two percent a licence is a gift and the owner is better off refusing;
 * above fifteen the licensee is working for the owner, and at that point buying
 * the company is cheaper. The validator clamps into this band rather than
 * refusing, so a founder who asks for one percent is told what it became.
 */
export const LICENCE_ROYALTY_BOUNDS = { min: 2, max: 15 } as const;

/**
 * The royalty an NPC owner will not go below.
 *
 * Six percent: three times the floor of the band, so a licence is worth
 * granting, and well under the ceiling, so there is room to bid. A direct rival
 * has to clear twice this to be taken seriously — that is the "unless" below.
 */
export const NPC_LICENCE_ROYALTY_FLOOR_PCT = 6;

/** What the owner's own published terms are worth against a rival: nothing extra. */
export const NPC_RIVAL_ROYALTY_MULTIPLE = 2;

/** The mid of a node's research range: what owning it outright is expected to cost. */
export function nodeResearchMidUsd(node: EconomicNode): number {
  const [low, high] = node.researchCostRangeUsd;
  return (low + high) / 2;
}

/** The signing fee for one node, in whole dollars. */
export function licenceUpfrontUsd(node: EconomicNode): number {
  return Math.round(nodeResearchMidUsd(node) * LICENCE_UPFRONT_SHARE);
}

/** Hold a royalty inside the band. Non-finite collapses to the floor. */
export function boundedRoyaltyPct(royaltyPct: number): number {
  if (!Number.isFinite(royaltyPct)) return LICENCE_ROYALTY_BOUNDS.min;
  const rounded = Math.round(royaltyPct);
  return Math.min(LICENCE_ROYALTY_BOUNDS.max, Math.max(LICENCE_ROYALTY_BOUNDS.min, rounded));
}

/* -------------------------------------------------------------------------- */
/*  Who may grant what                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Whether this company owns the node OUTRIGHT, which is the only basis on which
 * it may licence it out. `holdsNode` is deliberately not used here: it is true
 * for a licensee too, and a licensee sublicensing is exactly what a licence
 * does not permit.
 */
export function ownsNodeOutright(company: Company, nodeId: string): boolean {
  return company.ownedNodes?.includes(nodeId) === true;
}

/** The licence this company holds over a node from a named owner, in force or not. */
export function licenceFrom(company: Company, nodeId: string, ownerCompanyId: string): NodeLicence | undefined {
  return (company.licences ?? []).find((licence) => licence.nodeId === nodeId && licence.ownerCompanyId === ownerCompanyId);
}

/** Licences whose term has run out as of `quarter`. `holdsNode` already treats them as gone. */
export function lapsedLicencesOf(company: Company, quarter: number): readonly NodeLicence[] {
  return (company.licences ?? []).filter((licence) => licence.expiryQuarter <= quarter);
}

/** The terms this company advertises for a node, or null when it has published none. */
export function licenceOfferOf(owner: Company, nodeId: string): NodeLicenceOffer | null {
  return (owner.licenceOffers ?? []).find((offer) => offer.nodeId === nodeId) ?? null;
}

/* -------------------------------------------------------------------------- */
/*  The NPC owner's answer                                                     */
/* -------------------------------------------------------------------------- */

/** Sectors this company actually sells into, read off its live lines. */
function sectorsSoldInto(company: Company): ReadonlySet<string> {
  const sectors = new Set<string>();
  for (const product of company.products) {
    if (!product.isActive) continue;
    const nodeId = lineNodeIdOf(product);
    if (nodeId === null) continue;
    const node = economicNodeById(nodeId);
    if (node !== undefined) sectors.add(node.sector);
  }
  return sectors;
}

/**
 * Whether the licensee competes with the owner in the industry the node sits
 * in: both of them sell something in that sector today.
 *
 * A sector rather than the node itself, because the thing an owner is actually
 * protecting is its position in an industry, and a licensee that is one tier
 * away from you in the same chain is as much a rival as one selling the same
 * unit.
 */
export function isDirectRivalOnNode(owner: Company, licensee: Company, node: EconomicNode): boolean {
  return sectorsSoldInto(owner).has(node.sector) && sectorsSoldInto(licensee).has(node.sector);
}

/** An NPC owner's verdict on one request, with the sentence it is explained by. */
export interface LicenceVerdict {
  readonly accepted: boolean;
  readonly reason: string;
}

/**
 * Whether an NPC-run owner grants this licence. Deterministic, and stated:
 *
 * - Terms it **published** are terms it honours: a request at or above the
 *   advertised royalty is accepted, and `openToAll` decides whether a direct
 *   rival may take them too.
 * - Otherwise it wants `NPC_LICENCE_ROYALTY_FLOOR_PCT`, and a direct rival in
 *   the node's own sector has to clear twice that — the only offer worth
 *   arming a competitor for is one that pays better than competing.
 *
 * No random number, no relationship roll: an owner's answer has to be a thing a
 * founder can reason about before spending a quarter on it.
 */
export function npcLicenceVerdict(owner: Company, licensee: Company, node: EconomicNode, royaltyPct: number): LicenceVerdict {
  const rival = isDirectRivalOnNode(owner, licensee, node);
  const offer = licenceOfferOf(owner, node.id);
  if (offer !== null && royaltyPct >= offer.royaltyPct) {
    if (offer.openToAll || !rival) {
      return { accepted: true, reason: `${owner.name} publishes ${node.label} at ${offer.royaltyPct}% and the offer meets it.` };
    }
    return {
      accepted: false,
      reason: `${owner.name} publishes ${node.label} but not to a rival in ${node.sector.replace(/_/g, ' ')}.`,
    };
  }

  const floor = rival ? NPC_LICENCE_ROYALTY_FLOOR_PCT * NPC_RIVAL_ROYALTY_MULTIPLE : NPC_LICENCE_ROYALTY_FLOOR_PCT;
  if (royaltyPct >= floor) {
    return {
      accepted: true,
      reason: rival
        ? `${owner.name} will arm a rival at ${royaltyPct}%, which pays better than keeping ${node.label} to itself.`
        : `${owner.name} licenses ${node.label} at ${royaltyPct}%: the royalty is worth more than the exclusivity.`,
    };
  }
  return {
    accepted: false,
    reason: rival
      ? `${owner.name} will not arm a rival in ${node.sector.replace(/_/g, ' ')} for ${royaltyPct}%; it wants ${floor}%.`
      : `${owner.name} wants ${floor}% for ${node.label}, not ${royaltyPct}%.`,
  };
}

/* -------------------------------------------------------------------------- */
/*  Reading a licence off a deal                                               */
/* -------------------------------------------------------------------------- */

/** The node-licence obligation a deal carries, or null when it carries none. */
export function nodeLicenceOf(deal: DealProposal): Extract<DealProposal['gives'][number], { kind: 'node_licence' }> | null {
  for (const obligation of [...deal.gives, ...deal.gets]) {
    if (obligation.kind === 'node_licence') return obligation;
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/*  Granting                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Write the licence onto the licensee, replacing any earlier licence over the
 * same node from the same owner — a renewal is one row with a later expiry, not
 * two rows racing each other through `holdsNode`.
 *
 * Returns false when the schema bound is already full, which is the one case
 * where a licence cannot be granted: twelve live licences is a company whose
 * business is other people's technology.
 */
export function grantLicence(licensee: Company, licence: NodeLicence): boolean {
  const held = licensee.licences ?? [];
  const existing = held.findIndex((entry) => entry.nodeId === licence.nodeId && entry.ownerCompanyId === licence.ownerCompanyId);
  if (existing >= 0) {
    licensee.licences = held.map((entry, index) => (index === existing ? licence : entry));
    return true;
  }
  if (held.length >= 12) return false;
  licensee.licences = [...held, licence];
  return true;
}

/** Drop every licence whose term has run out. Returns what was dropped, in state order. */
export function dropLapsedLicences(licensee: Company, quarter: number): readonly NodeLicence[] {
  const held = licensee.licences;
  if (held === undefined || held.length === 0) return [];
  const lapsed = held.filter((licence) => licence.expiryQuarter <= quarter);
  if (lapsed.length === 0) return [];
  licensee.licences = held.filter((licence) => licence.expiryQuarter > quarter);
  return lapsed;
}

/* -------------------------------------------------------------------------- */
/*  What a licence costs its licensee this quarter                             */
/* -------------------------------------------------------------------------- */

/**
 * Every company that is paying this company a royalty this quarter, with the
 * node each licence covers. A pure read, for the owner's own books and for a
 * screen that wants to say who is paying.
 */
export function licenseesOf(state: SessionState, ownerCompanyId: string): readonly { company: Company; licence: NodeLicence }[] {
  const out: { company: Company; licence: NodeLicence }[] = [];
  for (const company of state.companies) {
    if (!company.isActive || company.id === ownerCompanyId) continue;
    for (const licence of company.licences ?? []) {
      if (licence.ownerCompanyId !== ownerCompanyId) continue;
      if (licence.expiryQuarter <= state.quarter) continue;
      out.push({ company, licence });
    }
  }
  return out;
}
