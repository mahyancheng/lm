/**
 * @frontier/simulation — graph/options.ts
 *
 * What a founder is actually choosing between when they wire an input, and
 * what stands between them and a node they cannot make yet.
 *
 * The launch flow asks two questions in the owner's order — *what does this
 * cost me to make*, then *where does each input come from* — and both are
 * answered here rather than on the client. A screen renders three buttons per
 * input and never walks the graph: `inputOptions` hands it exactly the three
 * shapes the roll-up itself would price the input at, in the roll-up's own
 * order of preference.
 *
 *   MAKE    you already run a line on it — transferred at your own unit cost.
 *   BUY     a named seller with live terms, at their ask and their quality.
 *   MARKET  spot, at the node's settled price plus `OPEN_MARKET_PREMIUM`.
 *
 * Every price on a route comes from `cost.ts` — `unitCostOf`,
 * `openMarketPriceUsd`, `namedSupplierPriceUsd` — so the number a founder is
 * shown before launching is the number the profit and loss will book after it.
 * A route that quoted its own arithmetic would be world 2's per-product margin
 * all over again: a figure that agrees with the income statement until it
 * doesn't.
 *
 * Nothing here reads a random number or a clock, and nothing here is reached
 * below world version 3.
 */

import type { Company, EconomicNode, NodeCostCache, SessionState, UnitCostResult } from '@frontier/contracts';
import {
  ECONOMIC_NODES_BY_ID,
  canProduce,
  economicNodeById,
  holdsNode,
  nodeMarketPriceUsd,
} from '@frontier/contracts';
import { OPEN_MARKET_PREMIUM, namedSupplierPriceUsd, openMarketPriceUsd, supplierAskFor, unitCostOf } from './cost';
import { lineNodeIdOf, lineOf } from './lines';
import { dataSelfSupplyShare } from './data';
import { licenceOfferOf, licenceUpfrontUsd, ownsNodeOutright } from './licensing';

/* -------------------------------------------------------------------------- */
/*  Routes                                                                     */
/* -------------------------------------------------------------------------- */

/** The three shapes an input can be answered with, in the roll-up's own order. */
export type InputRouteKind = 'make' | 'buy' | 'market';

/** One way of getting one input, priced exactly as the roll-up would price it. */
export interface InputRoute {
  readonly kind: InputRouteKind;
  /** The counterparty: this company for `make`, the seller for `buy`, null for `market`. */
  readonly supplierCompanyId: string | null;
  /** The seller's own line, for the `choose_supplier` action. Null for `make` and `market`. */
  readonly supplierProductId: string | null;
  /** Who this route is with, in words: "Make it yourself", a seller's name, "Open market". */
  readonly label: string;
  /** What one unit of the input costs by this route. */
  readonly unitPriceUsd: number;
  /** The quality that flows through with it, 0..1. Market is the node's own baseline. */
  readonly qualityScore: number;
  /** Whole percent this route is above (positive) or below (negative) the node's market price. */
  readonly premiumPct: number;
  /** True when this is the route the roll-up would take right now. */
  readonly chosen: boolean;
}

/** One declared input of a node, with every route open to this company. */
export interface NodeInputOptions {
  readonly inputNodeId: string;
  readonly label: string;
  /** What one unit of the *input* is, e.g. "wafer", "MWh". */
  readonly unitLabel: string;
  /** How many of them one unit of the parent node consumes. */
  readonly qtyPerUnit: number;
  /** A substitutable input can always be had; a non-substitutable one can block the line. */
  readonly substitutable: boolean;
  /** The node's one settled market price this quarter. */
  readonly marketPriceUsd: number;
  /** Make first, then every open seller best-quality-per-dollar first, then market. */
  readonly routes: readonly InputRoute[];
  /** The route the roll-up takes today, or null when the input is blocked. */
  readonly chosen: InputRoute | null;
  /** True when nothing can fill it: non-substitutable, nobody named, nobody owns it. */
  readonly blocked: boolean;
  /** The share of this input the company's own data pool already covers, whole percent. */
  readonly selfSuppliedPct: number;
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
 * Every input of `nodeId`, with every route this company could fill it by.
 *
 * `productId` is the company's own line on the node when it already has one —
 * that is what makes a named supplier's choice visible. Pass null while the
 * line is still being launched: nothing is named yet, so the chosen route is
 * whatever the roll-up would fall through to, which is exactly what the launch
 * screen has to show before a wire is drawn.
 *
 * The quantities and the order are the node's own. A screen renders this list
 * top to bottom and is finished.
 */
export function inputOptions(
  state: SessionState,
  company: Company,
  nodeId: string,
  productId: string | null = null,
  cache?: NodeCostCache,
): readonly NodeInputOptions[] {
  const node = economicNodeById(nodeId);
  if (node === undefined) return [];

  const line = lineOf(state, company.id, nodeId, cache);
  const unitsPerQuarter = Math.max(1, line?.unitsSoldLastQuarter ?? 0);

  return node.consumes.map((input) => {
    const inputNode = ECONOMIC_NODES_BY_ID[input.nodeId];
    const marketPriceUsd = nodeMarketPriceUsd(state, input.nodeId);
    const routes: InputRoute[] = [];

    // The company's own pool answers a dataset input before any route does —
    // the same order `rollUp` reads it in, so a pool that covers the whole draw
    // shows as fully self-supplied rather than as a market purchase.
    const selfShare = dataSelfSupplyShare(company, node, input.nodeId, input.qtyPerUnit, unitsPerQuarter);

    /* --- make -------------------------------------------------------------- */
    const ownLine = lineOf(state, company.id, input.nodeId, cache);
    if (ownLine !== undefined) {
      const ownCost = unitCostOf(state, company, input.nodeId, cache);
      routes.push({
        kind: 'make',
        supplierCompanyId: company.id,
        supplierProductId: ownLine.productId,
        label: 'Make it yourself',
        unitPriceUsd: ownCost.unitCostUsd,
        qualityScore: qualityOfOwnLine(company, ownLine.productId),
        premiumPct: premiumPctOf(ownCost.unitCostUsd, marketPriceUsd),
        chosen: true,
      });
    }

    /* --- buy --------------------------------------------------------------- */
    const chosenSupplier = productId === null ? null : supplierAskFor(state, company, productId, input.nodeId);
    for (const seller of nodeSellersFor(state, company.id, input.nodeId)) {
      const priceUsd = namedSupplierPriceUsd(state, seller.company, seller.askUsd, input.nodeId);
      routes.push({
        kind: 'buy',
        supplierCompanyId: seller.company.id,
        supplierProductId: seller.productId,
        label: seller.company.name,
        unitPriceUsd: priceUsd,
        qualityScore: seller.qualityScore,
        premiumPct: premiumPctOf(priceUsd, marketPriceUsd),
        // A named supplier only wins when nothing is made in house: that is the
        // roll-up's order, not a preference expressed here.
        chosen: ownLine === undefined && chosenSupplier !== null && chosenSupplier.companyId === seller.company.id,
      });
    }

    /* --- market ------------------------------------------------------------ */
    const spotUsd = openMarketPriceUsd(state, input.nodeId);
    const blocked = isBlocked(state, company, input.nodeId, input.substitutable, selfShare, cache);
    routes.push({
      kind: 'market',
      supplierCompanyId: null,
      supplierProductId: null,
      label: 'Open market',
      unitPriceUsd: spotUsd,
      qualityScore: MARKET_QUALITY,
      premiumPct: Math.round((OPEN_MARKET_PREMIUM - 1) * 100),
      chosen: ownLine === undefined && chosenSupplier === null && !blocked,
    });

    return {
      inputNodeId: input.nodeId,
      label: inputNode?.label ?? input.nodeId,
      unitLabel: inputNode?.unitLabel ?? 'unit',
      qtyPerUnit: input.qtyPerUnit,
      substitutable: input.substitutable,
      marketPriceUsd,
      routes,
      chosen: routes.find((route) => route.chosen) ?? null,
      blocked,
      selfSuppliedPct: Math.round(Math.min(1, Math.max(0, selfShare)) * 100),
    };
  });
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

/**
 * Whether an input cannot be had at any price.
 *
 * The same strong test `priceInput` applies: substitutable never blocks, a pool
 * that covers the draw never blocks, and otherwise it blocks only when nobody
 * in the world owns or licences the node — not merely when nobody happens to be
 * running a line on it this quarter, which the market already prices.
 */
function isBlocked(
  state: SessionState,
  company: Company,
  inputNodeId: string,
  substitutable: boolean,
  selfShare: number,
  cache?: NodeCostCache,
): boolean {
  if (substitutable || selfShare >= 1) return false;
  if (lineOf(state, company.id, inputNodeId, cache) !== undefined) return false;
  const owned = cache?.ownedNodeIds;
  if (owned !== undefined) return !owned.has(inputNodeId);
  for (const candidate of state.companies) {
    if (!candidate.isActive) continue;
    if ((candidate.ownedNodes ?? []).includes(inputNodeId)) return false;
    if ((candidate.licences ?? []).some((licence) => licence.nodeId === inputNodeId)) return false;
  }
  return true;
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
