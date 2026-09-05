/**
 * @frontier/simulation — graph/options.ts
 *
 * What a founder is actually choosing between when they fill a slot, and what
 * stands between them and a node they cannot make yet.
 *
 * The launch flow asks, in the owner's order — *what to sell*, *what goes in
 * each slot and where it comes from*, *who it is aimed at*, *what it costs to
 * make*, then *the price* — and the second and fourth of those are answered
 * here rather than on the client. A screen renders one row per slot, a sheet
 * of candidate nodes under it and three kinds of route under each candidate,
 * and never walks the graph: `slotOptions` hands it exactly the shapes the
 * roll-up itself would price a slot at.
 *
 *   MAKE    you already run a line on the candidate — transferred at your own unit cost.
 *   BUY     a named seller with live terms on it, at their ask and their quality.
 *   MARKET  spot, at the candidate's settled price plus `OPEN_MARKET_PREMIUM`.
 *
 * Every price on a route comes from `cost.ts` — `unitCostOf`,
 * `openMarketPriceUsd`, `namedSupplierPriceUsd` — so the number a founder is
 * shown before launching is the number the profit and loss will book after it.
 * A route that quoted its own arithmetic would be world 2's per-product margin
 * all over again: a figure that agrees with the income statement until it
 * doesn't. None of the routes is ever disabled: declining to make a thing you
 * could make is a decision, and the fill records it.
 *
 * Nothing here reads a random number or a clock, and nothing here is reached
 * below world version 3.
 */

import type { Company, EconomicNode, NodeCostCache, NodeSlot, NodeSlotKind, NodeRole, SessionState, UnitCostResult } from '@frontier/contracts';
import { ECONOMIC_NODES_BY_ID, admissibleNodesFor, canProduce, economicNodeById, holdsNode, nodeMarketPriceUsd } from '@frontier/contracts';
import { OPEN_MARKET_PREMIUM, namedSupplierPriceUsd, openMarketPriceUsd, unitCostOf } from './cost';
import { lineNodeIdOf, lineOf, ownedNodeIdsOf, producersOf } from './lines';
import { dataSelfSupplyShare } from './data';
import { licenceOfferOf, licenceUpfrontUsd, ownsNodeOutright } from './licensing';
import { resolveFill, type ResolvedFill } from './slots';

/* -------------------------------------------------------------------------- */
/*  Routes                                                                     */
/* -------------------------------------------------------------------------- */

/** The three shapes an input can be answered with, in the roll-up's own order. */
export type InputRouteKind = 'make' | 'buy' | 'market';

/** One way of getting one candidate node, priced exactly as the roll-up would price it. */
export interface InputRoute {
  readonly kind: InputRouteKind;
  /** The counterparty: this company for `make`, the seller for `buy`, null for `market`. */
  readonly supplierCompanyId: string | null;
  /** The seller's own line for `buy`, the company's own for `make`. Null for `market`. */
  readonly supplierProductId: string | null;
  /** Who this route is with, in words: "Make it yourself", a seller's name, "Open market". */
  readonly label: string;
  /** What one unit of the candidate costs by this route: the number the roll-up books. */
  readonly unitPriceUsd: number;
  /**
   * What the counterparty itself states: a seller's published ask for `buy`,
   * before the seller's own energy and load factor and the market's bounds
   * turn it into `unitPriceUsd`. Equal to `unitPriceUsd` on `make` and `market`.
   */
  readonly askUsd: number;
  /** The quality that flows through with it, 0..1. Market is the node's own baseline. */
  readonly qualityScore: number;
  /** Whole percent this route is above (positive) or below (negative) the candidate's market price. */
  readonly premiumPct: number;
  /** True when this is the route the slot resolves to right now. */
  readonly chosen: boolean;
}

/** One node that could fill a slot, with every route this company could get it by. */
export interface SlotCandidate {
  readonly nodeId: string;
  readonly label: string;
  readonly tier: number;
  /** The candidate's one settled market price this quarter. */
  readonly marketPriceUsd: number;
  /** How many live lines make it. A relationship, so public. */
  readonly producerCount: number;
  /** True when putting this node in the slot would block the line: a blocking slot, and nobody in the world owns it. */
  readonly blocked: boolean;
  /** The share of a dataset candidate the company's own pool would cover, whole percent. Zero for anything else. */
  readonly selfSuppliedPct: number;
  /** Make first when the company runs a line on it, then every open seller best-quality-per-dollar first, then market. */
  readonly routes: readonly InputRoute[];
}

/** One slot of a node, with every node that could fill it and every route to each. */
export interface NodeSlotOptions {
  readonly slotId: string;
  readonly role: NodeRole;
  readonly label: string;
  readonly required: boolean;
  readonly blocking: boolean;
  readonly kind: NodeSlotKind;
  /** How many units of the filling node one unit of the parent takes. */
  readonly qtyPerUnit: number;
  /** What one unit of the filling node is, e.g. "wafer", "seat". Every admissible node shares it. */
  readonly unitLabel: string;
  /** How the slot resolves today: the node in it and the route. Null only for a slot the table no longer carries. */
  readonly fill: ResolvedFill | null;
  /** Every admissible node, in table order. */
  readonly candidates: readonly SlotCandidate[];
}

/**
 * A seller whose published terms would currently sell `buyerCompanyId` one
 * node, best quality per dollar first.
 *
 * World 3's answer to `suppliersFor`: a line is matched on the *node* it
 * produces rather than on a world-2 product category, and its ask is the price
 * on its published terms. Deterministic order — quality per dollar, ties by
 * company id — so the launch flow, the drawer and the Chief of Staff all read
 * the same list in the same order.
 */
export function nodeSellersFor(
  state: SessionState,
  buyerCompanyId: string,
  nodeId: string,
): readonly { readonly company: Company; readonly productId: string; readonly askUsd: number; readonly qualityScore: number; readonly isDirectRival: boolean }[] {
  const buyer = state.companies.find((candidate) => candidate.id === buyerCompanyId);
  const buyerSellsSameNode = new Set<string>();
  for (const product of buyer?.products ?? []) {
    if (!product.isActive || product.supplyTerms === null || product.supplyTerms === undefined) continue;
    const own = lineNodeIdOf(product);
    if (own !== null) buyerSellsSameNode.add(own);
  }

  const out: { company: Company; productId: string; askUsd: number; qualityScore: number; isDirectRival: boolean }[] = [];
  for (const company of state.companies) {
    if (!company.isActive || company.id === buyerCompanyId) continue;
    for (const product of company.products) {
      if (!product.isActive) continue;
      if (lineNodeIdOf(product) !== nodeId) continue;
      const terms = product.supplyTerms;
      if (terms === null || terms === undefined) continue;
      if (terms.blockedCustomerIds.includes(buyerCompanyId)) continue;
      if (!terms.openToAll && !terms.exclusiveCustomerIds.includes(buyerCompanyId)) continue;
      out.push({
        company,
        productId: product.id,
        askUsd: Math.max(0, terms.pricePerUnitUsd),
        qualityScore: product.qualityScore,
        isDirectRival: buyerSellsSameNode.has(nodeId),
      });
    }
  }
  out.sort((a, b) => {
    const scoreA = a.qualityScore / Math.max(1, a.askUsd);
    const scoreB = b.qualityScore / Math.max(1, b.askUsd);
    if (scoreB !== scoreA) return scoreB - scoreA;
    return a.company.id < b.company.id ? -1 : a.company.id > b.company.id ? 1 : 0;
  });
  return out;
}

/** Whole percent `priceUsd` sits above the market price. Zero when the market has no price. */
function premiumPctOf(priceUsd: number, marketPriceUsd: number): number {
  if (marketPriceUsd <= 0) return 0;
  return Math.round(((priceUsd - marketPriceUsd) / marketPriceUsd) * 100);
}

/**
 * Every slot of `nodeId`, with every node that could fill it and every route
 * this company could fill it by.
 *
 * `productId` is the company's own line on the node when it already has one —
 * that is what makes its fills visible. Pass null while the line is still being
 * launched: nothing is filled yet, so each slot resolves to the table's default
 * and the roll-up's own order, which is exactly what the launch screen has to
 * show before a founder has touched anything.
 *
 * The slots and the candidates come in the table's own order. A screen renders
 * this list top to bottom and is finished.
 */
export function slotOptions(
  state: SessionState,
  company: Company,
  nodeId: string,
  productId: string | null = null,
  cache?: NodeCostCache,
): readonly NodeSlotOptions[] {
  const node = economicNodeById(nodeId);
  if (node === undefined) return [];

  const product = productId === null ? null : (company.products.find((candidate) => candidate.id === productId) ?? null);
  const line = lineOf(state, company.id, nodeId, cache);
  const unitsPerQuarter = Math.max(1, line?.unitsSoldLastQuarter ?? 0);
  const owned = cache?.ownedNodeIds ?? ownedNodeIdsOf(state);

  return node.slots.map((slot) => {
    const fill = resolveFill(state, company, product, node, slot, cache);
    const admissible = admissibleNodesFor(node.id, slot.id);
    const candidates = admissible.map((candidate) => slotCandidate(state, company, node, slot, candidate, fill, unitsPerQuarter, owned, cache));
    return {
      slotId: slot.id,
      role: slot.role,
      label: slot.label,
      required: slot.required,
      blocking: slot.blocking,
      kind: slot.kind,
      qtyPerUnit: slot.qtyPerUnit,
      unitLabel: admissible[0]?.unitLabel ?? 'unit',
      fill,
      candidates,
    };
  });
}

/** One candidate node for one slot, with every route to it priced as the roll-up would. */
function slotCandidate(
  state: SessionState,
  company: Company,
  node: EconomicNode,
  slot: NodeSlot,
  candidate: EconomicNode,
  fill: ResolvedFill,
  unitsPerQuarter: number,
  owned: ReadonlySet<string>,
  cache?: NodeCostCache,
): SlotCandidate {
  const marketPriceUsd = nodeMarketPriceUsd(state, candidate.id);
  const inSlot = fill.nodeId === candidate.id;
  const routes: InputRoute[] = [];

  // The company's own pool answers a dataset candidate before any route does —
  // the same order `rollUp` reads it in, so a pool that covers the whole draw
  // shows as fully self-supplied rather than as a market purchase.
  const selfShare = dataSelfSupplyShare(company, node, candidate.id, slot.qtyPerUnit, unitsPerQuarter);

  /* --- make -------------------------------------------------------------- */
  const ownLine = lineOf(state, company.id, candidate.id, cache);
  if (ownLine !== undefined) {
    const ownCost = unitCostOf(state, company, candidate.id, cache);
    routes.push({
      kind: 'make',
      supplierCompanyId: company.id,
      supplierProductId: ownLine.productId,
      label: 'Make it yourself',
      unitPriceUsd: ownCost.unitCostUsd,
      askUsd: ownCost.unitCostUsd,
      qualityScore: qualityOfOwnLine(company, ownLine.productId),
      premiumPct: premiumPctOf(ownCost.unitCostUsd, marketPriceUsd),
      chosen: inSlot && fill.route === 'make',
    });
  }

  /* --- buy --------------------------------------------------------------- */
  for (const seller of nodeSellersFor(state, company.id, candidate.id)) {
    const priceUsd = namedSupplierPriceUsd(state, seller.company, seller.askUsd, candidate.id);
    routes.push({
      kind: 'buy',
      supplierCompanyId: seller.company.id,
      supplierProductId: seller.productId,
      label: seller.company.name,
      unitPriceUsd: priceUsd,
      askUsd: seller.askUsd,
      qualityScore: seller.qualityScore,
      premiumPct: premiumPctOf(priceUsd, marketPriceUsd),
      chosen: inSlot && fill.route === 'buy' && fill.supplierProductId === seller.productId,
    });
  }

  /* --- market ------------------------------------------------------------ */
  // Blocked is the strong claim `resolveFill` makes: a blocking slot whose node
  // nobody in the world owns or licences. A pool that covers the whole draw, or
  // a line of the company's own, never blocks.
  const blocked = slot.blocking && selfShare < 1 && ownLine === undefined && producersOf(state, candidate.id, cache).length === 0 && !owned.has(candidate.id);
  const spotUsd = openMarketPriceUsd(state, candidate.id);
  routes.push({
    kind: 'market',
    supplierCompanyId: null,
    supplierProductId: null,
    label: 'Open market',
    unitPriceUsd: spotUsd,
    askUsd: spotUsd,
    qualityScore: MARKET_QUALITY,
    premiumPct: Math.round((OPEN_MARKET_PREMIUM - 1) * 100),
    chosen: inSlot && fill.route === 'market',
  });

  return {
    nodeId: candidate.id,
    label: candidate.label,
    tier: candidate.tier,
    marketPriceUsd,
    producerCount: producersOf(state, candidate.id, cache).length,
    blocked,
    selfSuppliedPct: Math.round(Math.min(1, Math.max(0, selfShare)) * 100),
    routes,
  };
}

/**
 * What the open market delivers when nobody is named: the middle of the band.
 *
 * Spot is neither the best nor the worst a founder could do, and saying so with
 * a number is what makes naming a supplier a decision rather than a formality.
 */
export const MARKET_QUALITY = 0.5;

/** The quality one of this company's own lines delivers, for a `make` route. */
function qualityOfOwnLine(company: Company, productId: string): number {
  return company.products.find((product) => product.id === productId)?.qualityScore ?? MARKET_QUALITY;
}

/* -------------------------------------------------------------------------- */
/*  A node this company cannot make yet                                        */
/* -------------------------------------------------------------------------- */

/** One node still to be owned before a line is possible, and what it would take. */
export interface MissingNodeRoute {
  readonly nodeId: string;
  readonly label: string;
  /** True when a research programme can reach it at all. */
  readonly researchable: boolean;
  /** The table's own estimate, low and high. */
  readonly researchCostRangeUsd: readonly [number, number];
  /** Owners currently publishing a licence offer on it, cheapest royalty first. */
  readonly licensors: readonly { readonly companyId: string; readonly name: string; readonly royaltyPct: number; readonly upfrontUsd: number }[];
}

/**
 * Why a company may not run a line on a node, and the three ways out.
 *
 * The owner's third route — *buy the output instead* — is not a licence and not
 * a programme: it is the observation that a node you cannot make is a node you
 * can still purchase from somebody who can, which is what turns a locked card
 * from a dead end into a supplier list.
 */
export interface NodeEntryRoutes {
  readonly nodeId: string;
  readonly canProduce: boolean;
  /** Nodes this company would have to own or licence first, the node itself included. */
  readonly missing: readonly MissingNodeRoute[];
  /** Sellers of the node's own output, for a founder who wants the thing rather than the capability. */
  readonly buyInstead: readonly { readonly companyId: string; readonly name: string; readonly askUsd: number; readonly qualityScore: number }[];
}

/** What stands between `company` and a line on `nodeId`, with every way through it. */
export function nodeEntryRoutes(state: SessionState, company: Company, nodeId: string): NodeEntryRoutes {
  const node = economicNodeById(nodeId);
  if (node === undefined) return { nodeId, canProduce: false, missing: [], buyInstead: [] };

  const missingIds = [nodeId, ...node.requires].filter((id) => !holdsNode(company, id, state.quarter));
  const missing: MissingNodeRoute[] = missingIds.map((id) => {
    const missingNode = ECONOMIC_NODES_BY_ID[id];
    const licensors: { companyId: string; name: string; royaltyPct: number; upfrontUsd: number }[] = [];
    for (const owner of state.companies) {
      if (!owner.isActive || owner.id === company.id) continue;
      if (!ownsNodeOutright(owner, id)) continue;
      const offer = licenceOfferOf(owner, id);
      if (offer === null) continue;
      licensors.push({
        companyId: owner.id,
        name: owner.name,
        royaltyPct: offer.royaltyPct,
        upfrontUsd: missingNode === undefined ? 0 : licenceUpfrontUsd(missingNode),
      });
    }
    licensors.sort((a, b) => a.royaltyPct - b.royaltyPct || (a.companyId < b.companyId ? -1 : 1));
    return {
      nodeId: id,
      label: missingNode?.label ?? id,
      researchable: missingNode?.researchable ?? false,
      researchCostRangeUsd: missingNode?.researchCostRangeUsd ?? ([0, 0] as const),
      licensors,
    };
  });

  return {
    nodeId,
    canProduce: canProduce(company, nodeId, state.quarter),
    missing,
    buyInstead: nodeSellersFor(state, company.id, nodeId).map((seller) => ({
      companyId: seller.company.id,
      name: seller.company.name,
      askUsd: namedSupplierPriceUsd(state, seller.company, seller.askUsd, nodeId),
      qualityScore: seller.qualityScore,
    })),
  };
}

/* -------------------------------------------------------------------------- */
/*  The cost breakdown, in the order a founder reads it                        */
/* -------------------------------------------------------------------------- */

/** One row of the unit-cost breakdown, biggest first, with its share stated. */
export interface CostBreakdownRow {
  readonly key: string;
  readonly label: string;
  readonly amountUsd: number;
  /** Whole percent of the unit cost this row is. */
  readonly sharePct: number;
  /** The counterparty, when the row is bought from somebody. */
  readonly sourceCompanyId: string | null;
  readonly sourceKind: 'make' | 'buy' | 'market' | 'conversion';
}

/**
 * A roll-up sorted the way the owner asked for it: descending, so the line that
 * decides whether this business works is the first line on the screen.
 *
 * Zero-amount rows stay in — a blocked input at zero is the row a founder has
 * to act on, and dropping it would hide exactly the problem.
 */
export function costBreakdown(result: UnitCostResult): readonly CostBreakdownRow[] {
  const total = result.unitCostUsd;
  return [...result.lines]
    .map((line) => ({
      key: line.key,
      label: line.label,
      amountUsd: line.amountUsd,
      sharePct: total <= 0 ? 0 : Math.round((line.amountUsd / total) * 100),
      sourceCompanyId: line.sourceCompanyId,
      sourceKind: line.sourceKind,
    }))
    .sort((a, b) => b.amountUsd - a.amountUsd || a.key.localeCompare(b.key));
}

/**
 * The one sentence the launch screen leads with, in the owner's own words:
 * *"$18,400 of your $31,000 unit cost is Basalt's accelerators."*
 *
 * Names the counterparty when there is one, because a cost with a name on it is
 * a negotiation and a cost without one is weather. Empty string when the line
 * costs nothing at all, which is the honest thing to say about no cost.
 */
export function biggestCostSentence(
  result: UnitCostResult,
  rows: readonly CostBreakdownRow[],
  companyNames: ReadonlyMap<string, string>,
  formatUsd: (value: number) => string,
): string {
  const top = rows[0];
  if (top === undefined || result.unitCostUsd <= 0 || top.amountUsd <= 0) return '';
  const owner = top.sourceCompanyId === null ? null : (companyNames.get(top.sourceCompanyId) ?? null);
  const what = owner === null ? top.label.toLowerCase() : `${owner}'s ${top.label.toLowerCase()}`;
  return `${formatUsd(top.amountUsd)} of your ${formatUsd(result.unitCostUsd)} unit cost is ${what}.`;
}

/* -------------------------------------------------------------------------- */
/*  Pricing against the node's own market                                      */
/* -------------------------------------------------------------------------- */

/** A candidate price for a line, judged against the node's own market price. */
export interface PriceVerdict {
  readonly nodeId: string;
  readonly priceUsd: number;
  readonly marketPriceUsd: number;
  readonly unitCostUsd: number;
  /** Whole percent above (positive) or below (negative) the node's market price. */
  readonly againstMarketPct: number;
  /** Whole percent gross margin at this price. Negative when the price is under cost. */
  readonly grossMarginPct: number;
}

/**
 * What a price means, before it is committed.
 *
 * The reference is the node's *own* market price. World 2 judged every line
 * against `segmentReferencePrice` — the customer-weighted mean price of every
 * product in that buyer segment across all six sectors — which is why a wafer
 * fab priced at its own reference lost most of its gross additions. A price is
 * judged against the thing it is a price for.
 */
export function priceVerdict(state: SessionState, node: EconomicNode, priceUsd: number, unitCostUsd: number): PriceVerdict {
  const marketPriceUsd = nodeMarketPriceUsd(state, node.id);
  return {
    nodeId: node.id,
    priceUsd,
    marketPriceUsd,
    unitCostUsd,
    againstMarketPct: premiumPctOf(priceUsd, marketPriceUsd),
    grossMarginPct: priceUsd <= 0 ? 0 : Math.round(((priceUsd - unitCostUsd) / priceUsd) * 100),
  };
}
