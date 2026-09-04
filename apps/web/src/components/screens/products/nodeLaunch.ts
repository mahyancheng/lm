/**
 * The world-3 launch flow, as pure functions.
 *
 * The owner's order, and it is not negotiable: pick a node → **see what it
 * costs to make** → wire the inputs → set a price against the node's own market
 * price → launch. Cost comes before price because a founder who prices before
 * they have costed is guessing, and world 2 let them: it showed a reference
 * price on the launch form and a margin computed from compute alone.
 *
 * Nothing here computes an economic number. `costBreakdown`, `inputOptions`,
 * `nodeEntryRoutes` and `priceVerdict` are the engine's, and this module only
 * decides which of them a step needs and what the words around them are. A
 * screen that restated any of that arithmetic would be a second economy.
 */

import type { ActionIntent, Company, EconomicNode, SessionState, UnitCostResult } from '@frontier/contracts';
import { economicNodeById } from '@frontier/contracts';
import { launchableNodes, type LaunchableNode, type NodeEntryRoutes, type NodeInputOptions } from '@frontier/simulation';

/* -------------------------------------------------------------------------- */
/*  The four steps                                                             */
/* -------------------------------------------------------------------------- */

export const NODE_LAUNCH_STEPS = ['Line', 'Cost to make', 'Inputs', 'Price'] as const;
export type NodeLaunchStep = 0 | 1 | 2 | 3;

/* -------------------------------------------------------------------------- */
/*  Which node                                                                 */
/* -------------------------------------------------------------------------- */

/** A launchable node with its own name resolved, ready to list. */
export interface LaunchOption extends LaunchableNode {
  readonly label: string;
  readonly unitLabel: string;
  readonly tier: number;
}

/**
 * Every node this company could put on sale, open ones first, then by tier
 * descending — the most finished thing a founder can make is the thing they
 * most want to see, and a tier-0 commodity is the fallback rather than the
 * headline.
 *
 * A node already sold is kept in the list and marked, because "you already sell
 * this" is a useful answer to "can I sell this", and removing the row would
 * make the list change shape as the company grows.
 */
export function launchOptions(state: SessionState, company: Company): readonly LaunchOption[] {
  return [...launchableNodes(state, company)]
    .map((entry) => ({
      ...entry,
      label: entry.node.label,
      unitLabel: entry.node.unitLabel,
      tier: entry.node.tier,
    }))
    .sort((a, b) => {
      if (a.locked !== b.locked) return a.locked ? 1 : -1;
      if (a.alreadySold !== b.alreadySold) return a.alreadySold ? 1 : -1;
      if (b.tier !== a.tier) return b.tier - a.tier;
      return a.label.localeCompare(b.label);
    });
}

/* -------------------------------------------------------------------------- */
/*  Why a node is locked, and the three ways out                               */
/* -------------------------------------------------------------------------- */

/**
 * One sentence saying what stands in the way, naming the nodes rather than
 * saying "requirements not met".
 *
 * Empty string when nothing does, so a caller can render it or not without a
 * second condition.
 */
export function lockReason(routes: NodeEntryRoutes): string {
  if (routes.canProduce || routes.missing.length === 0) return '';
  const names = routes.missing.map((entry) => entry.label);
  const node = economicNodeById(routes.nodeId)?.label ?? routes.nodeId;
  if (names.length === 1 && routes.missing[0]?.nodeId === routes.nodeId) {
    return `You do not own ${node} yet.`;
  }
  return `${node} needs ${names.join(', ')}, and you own none of it yet.`;
}

/** The three ways into a node a company cannot make, in the order a founder should consider them. */
export type EntryRouteKind = 'research' | 'licence' | 'buy';

export interface EntryRouteOffer {
  readonly kind: EntryRouteKind;
  readonly headline: string;
  readonly detail: string;
  /** True when the world currently offers this route at all. */
  readonly available: boolean;
}

/**
 * "Research it, licence it, or buy the output instead", with the world's actual
 * answer to each rather than three generic buttons.
 *
 * A route that nobody offers still appears, greyed, and says why — a founder
 * who cannot licence a node needs to know that nobody is licensing it, not to
 * be shown two buttons and left to infer the third.
 */
export function entryRoutes(routes: NodeEntryRoutes, formatUsd: (value: number) => string): readonly EntryRouteOffer[] {
  const first = routes.missing[0] ?? null;
  const researchable = routes.missing.some((entry) => entry.researchable);
  const licensors = routes.missing.flatMap((entry) => entry.licensors);
  const cheapest = [...licensors].sort((a, b) => a.royaltyPct - b.royaltyPct)[0] ?? null;
  const seller = routes.buyInstead[0] ?? null;

  return [
    {
      kind: 'research',
      headline: 'Research it',
      detail:
        first === null
          ? 'Nothing left to research.'
          : researchable
            ? `A programme against ${first.label} costs ${formatUsd(first.researchCostRangeUsd[0])} to ${formatUsd(first.researchCostRangeUsd[1])} on the table's own estimate.`
            : `${first.label} cannot be reached by research — it has to be bought or licensed.`,
      available: researchable,
    },
    {
      kind: 'licence',
      headline: 'Licence it',
      detail:
        cheapest === null
          ? 'Nobody is currently licensing what you are missing.'
          : `${cheapest.name} licenses it at ${cheapest.royaltyPct}% of revenue, ${formatUsd(cheapest.upfrontUsd)} up front.`,
      available: cheapest !== null,
    },
    {
      kind: 'buy',
      headline: 'Buy the output instead',
      detail:
        seller === null
          ? 'Nobody publishes terms on this node, so there is nothing to buy.'
          : `${seller.name} will sell you the finished thing at ${formatUsd(seller.askUsd)}.`,
      available: seller !== null,
    },
  ];
}

/* -------------------------------------------------------------------------- */
/*  Wiring                                                                     */
/* -------------------------------------------------------------------------- */

/** One input's chosen route, as the launch form holds it before the action is built. */
export interface WiringChoice {
  readonly supplierCompanyId: string | null;
  readonly supplierProductId: string | null;
}

export type WiringMap = Readonly<Record<string, WiringChoice>>;

/**
 * The `supply` array `launch_product` takes.
 *
 * A choice with no supplier is dropped rather than sent as a pair of nulls: an
 * absent entry already means the open market, and a deliberate null means
 * *unsupplied*, which is a different and much worse thing.
 */
export function supplyFromWiring(wiring: WiringMap): { inputCategoryId: string; supplierCompanyId: string | null; supplierProductId: string | null }[] {
  return Object.entries(wiring)
    .filter(([, choice]) => choice.supplierCompanyId !== null && choice.supplierProductId !== null)
    .map(([inputCategoryId, choice]) => ({
      inputCategoryId,
      supplierCompanyId: choice.supplierCompanyId,
      supplierProductId: choice.supplierProductId,
    }));
}

/**
 * What the wiring step defaults to: whatever route the roll-up would take
 * anyway.
 *
 * A founder who changes nothing gets exactly the costing they were shown on the
 * previous step, which is the whole reason costing comes first.
 */
export function defaultWiring(options: readonly NodeInputOptions[]): WiringMap {
  const out: Record<string, WiringChoice> = {};
  for (const option of options) {
    const chosen = option.chosen;
    if (chosen === null || chosen.kind !== 'buy') continue;
    out[option.inputNodeId] = { supplierCompanyId: chosen.supplierCompanyId, supplierProductId: chosen.supplierProductId };
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/*  The ticket                                                                 */
/* -------------------------------------------------------------------------- */

export interface LaunchDraft {
  readonly node: EconomicNode;
  readonly name: string;
  readonly priceUsd: number;
  readonly marketingUsd: number;
  /** The quality tier the line aims at, 0..1. Buys quality and costs real capacity. */
  readonly quality: number;
  readonly wiring: WiringMap;
}

/**
 * The `launch_product` intent, or null when the form is not yet a legal ticket.
 *
 * `categoryId` carries the NODE id in world 3 — the two id spaces are disjoint,
 * every node id having a table prefix — and `segment` is the node's own buyer
 * segment rather than a founder's guess, because who buys a wafer is a fact
 * about wafers.
 */
export function launchIntent(draft: LaunchDraft): ActionIntent | null {
  const name = draft.name.trim();
  if (name.length === 0) return null;
  if (!Number.isFinite(draft.priceUsd) || draft.priceUsd < 0) return null;
  return {
    type: 'launch_product',
    name: name.slice(0, 80),
    segment: draft.node.buyerSegment ?? 'enterprise',
    categoryId: draft.node.id,
    pricePerSeatUsd: draft.priceUsd,
    // The node's own research intensity stands in for the world-2 compute
    // slider: a line's compute draw in world 3 is `capacityDrawPerUnit`, which
    // the table sets, so this field is no longer a lever a founder pulls.
    computeIntensity: draft.node.researchComputeIntensity,
    launchMarketingUsd: Number.isFinite(draft.marketingUsd) && draft.marketingUsd > 0 ? draft.marketingUsd : 0,
    targetQuality: draft.quality,
    supply: supplyFromWiring(draft.wiring),
  };
}

/* -------------------------------------------------------------------------- */
/*  Copy                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The line under the price control: where this price sits against the node's
 * own market price, and what margin it leaves after the roll-up.
 *
 * Whole percent both times, per the house rules, and it says "under cost" in
 * words rather than showing a negative margin and hoping.
 */
export function priceSentence(
  priceUsd: number,
  marketPriceUsd: number,
  unitCostUsd: number,
  formatUsd: (value: number) => string,
): string {
  const against =
    marketPriceUsd <= 0 ? '' : `${Math.abs(Math.round(((priceUsd - marketPriceUsd) / marketPriceUsd) * 100))}% ${priceUsd >= marketPriceUsd ? 'above' : 'below'} the market at ${formatUsd(marketPriceUsd)}`;
  if (priceUsd <= 0) return against === '' ? 'Free.' : `Free — ${against}.`;
  const margin = Math.round(((priceUsd - unitCostUsd) / priceUsd) * 100);
  const marginPart = margin < 0 ? `${Math.abs(margin)}% under cost` : `a ${margin}% gross margin`;
  return against === '' ? `${marginPart}.` : `${against}, ${marginPart}.`;
}

/** Whether the costing step has anything a founder must act on before pricing. */
export function costingBlockers(result: UnitCostResult): readonly string[] {
  return result.blockedInputNodeIds.map((nodeId) => economicNodeById(nodeId)?.label ?? nodeId);
}
