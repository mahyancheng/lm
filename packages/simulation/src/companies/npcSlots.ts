/**
 * @frontier/simulation — companies/npcSlots.ts
 *
 * How a company nobody is directing composes its lines and publishes them.
 *
 * The owner's third north star only works if rivals take part in it: a public
 * API nobody builds on is a price list, and a slot nobody ever refills is a
 * recipe. So every quarter, for every node line a company runs and nobody has
 * told it about, two deterministic policies run here and queue ordinary
 * actions with origin `npc_default`, validated and resolved exactly as a
 * player's would be.
 *
 * ## Filling a slot
 *
 * Per slot, every admissible node is scored by every source it could come
 * from — the company's own line at its roll-up cost and its own quality, each
 * seller whose published terms are open to this buyer at the ask the roll-up
 * would actually charge and the seller line's quality, and the open market at
 * the spot premium and `MARKET_QUALITY` — on **quality per dollar**. The best
 * wins. Ties go to the company's own line, then to the lower company id, then
 * to table order, so two runs of the same state name the same fill.
 *
 * Sticky at `NPC_SLOT_SWITCH_THRESHOLD`: the current composition is kept
 * unless something is materially better, because a switch costs the quarter it
 * lands in and a background economy that reshuffles itself every quarter is
 * noise, not competition. A fill this company moved fewer than
 * `NPC_SLOT_SETTLE_QUARTERS` quarters ago is kept whatever the alternatives
 * score: the switch cost itself depresses a seller's stamped quality for the
 * quarter it switched in, and a buyer that reads that dip as a signal moves
 * off the seller and back again two quarters running — six seeded API buyers
 * did exactly that before the settle window existed. A direct rival — a
 * company selling the same node this company publishes — is excluded unless
 * nothing else is on offer, and a fill already standing on one is not sticky
 * once something else is, settle window or not. A slot the line leaves empty
 * is left alone: filling it would add a cost nobody asked for. A `fill_slot`
 * is emitted only when the winner differs from what the line runs on today.
 *
 * ## Publishing
 *
 * Every node line without terms publishes open to all at its own list price,
 * and reprices when the list has moved more than `NPC_SUPPLY_REPRICE_THRESHOLD`
 * from what it published. Blocked and exclusive lists are kept as they are.
 *
 * No RNG anywhere here: both policies are pure functions of the draft.
 */

import type { ActionIntent, Company, EconomicNode, NodeCostCache, NodeSlot, Product, SessionState } from '@frontier/contracts';
import { admissibleNodesFor } from '@frontier/contracts';
import { namedSupplierPriceUsd, openMarketPriceUsd, unitCostOf } from '../graph/cost';
import { lineOf, ownedNodeIdsOf, producersOf } from '../graph/lines';
import { MARKET_QUALITY, nodeSellersFor } from '../graph/options';
import { fillFor, fillsOf, resolveFill, type ResolvedFill } from '../graph/slots';
import { money } from './util';

/* -------------------------------------------------------------------------- */
/*  Constants                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * How much better, on quality per dollar, an alternative has to be before a
 * background company moves a slot off what it runs on today. Fifteen percent,
 * the same figure `chooseSupplierDefault` used for a world-2 supplier.
 */
export const NPC_SLOT_SWITCH_THRESHOLD = 1.15;

/**
 * How many quarters a background company leaves a slot it has just moved
 * before it will judge the fill again. A year: long enough for the switch
 * cost's one-quarter dip to have passed through both the buyer's own line and
 * any seller that switched behind it, so a move is judged on what it delivers
 * and not on the quarter it bedded in. A fill standing on a direct rival is
 * exempt: leaving a rival is the reason to move, not a judgement of the fill.
 */
export const NPC_SLOT_SETTLE_QUARTERS = 4;

/** How far a line's list price may drift from its published ask before the ask follows it. */
export const NPC_SUPPLY_REPRICE_THRESHOLD = 0.05;

/* -------------------------------------------------------------------------- */
/*  Scoring                                                                    */
/* -------------------------------------------------------------------------- */

/** One way of filling one slot, priced as the roll-up would price it. */
export interface ScoredSlotOption {
  readonly nodeId: string;
  readonly route: 'make' | 'buy' | 'market';
  readonly supplierCompanyId: string | null;
  readonly supplierProductId: string | null;
  readonly unitPriceUsd: number;
  readonly qualityScore: number;
  /** Quality per dollar: `qualityScore / max(1, unitPriceUsd)`. */
  readonly score: number;
  /** True when the seller sells the node this company itself publishes. */
  readonly isDirectRival: boolean;
  /** The candidate node's position among the slot's admissible nodes, for the last tie-break. */
  readonly tableIndex: number;
}

const ROUTE_RANK: Readonly<Record<ScoredSlotOption['route'], number>> = { make: 0, buy: 1, market: 2 };

/** Best first: score, then own line, then company id ascending, then table order. */
function compareOptions(a: ScoredSlotOption, b: ScoredSlotOption): number {
  if (a.score !== b.score) return b.score - a.score;
  if (ROUTE_RANK[a.route] !== ROUTE_RANK[b.route]) return ROUTE_RANK[a.route] - ROUTE_RANK[b.route];
  const idA = a.supplierCompanyId ?? '';
  const idB = b.supplierCompanyId ?? '';
  if (idA !== idB) return idA < idB ? -1 : 1;
  return a.tableIndex - b.tableIndex;
}

/**
 * Every way `company` could fill `slot` on `node`, best first.
 *
 * A candidate nobody in the world can make — a blocking slot, no line, no
 * owner, no licence — has no market route: the open market cannot sell what
 * nobody makes, and offering it would be `resolveFill`'s `blocked` under a
 * friendlier name.
 */
export function scoredSlotOptions(state: SessionState, company: Company, node: EconomicNode, slot: NodeSlot, cache?: NodeCostCache): readonly ScoredSlotOption[] {
  const owned = cache?.ownedNodeIds ?? ownedNodeIdsOf(state);
  const out: ScoredSlotOption[] = [];
  const admissible = admissibleNodesFor(node.id, slot.id);
  for (let tableIndex = 0; tableIndex < admissible.length; tableIndex += 1) {
    const candidate = admissible[tableIndex];
    if (candidate === undefined) continue;
    const scored = (route: ScoredSlotOption['route'], supplierCompanyId: string | null, supplierProductId: string | null, unitPriceUsd: number, qualityScore: number, isDirectRival: boolean): ScoredSlotOption => ({
      nodeId: candidate.id,
      route,
      supplierCompanyId,
      supplierProductId,
      unitPriceUsd,
      qualityScore,
      score: qualityScore / Math.max(1, unitPriceUsd),
      isDirectRival,
      tableIndex,
    });

    const ownLine = lineOf(state, company.id, candidate.id, cache);
    if (ownLine !== undefined) {
      const ownQuality = company.products.find((product) => product.id === ownLine.productId)?.qualityScore ?? MARKET_QUALITY;
      out.push(scored('make', company.id, ownLine.productId, unitCostOf(state, company, candidate.id, cache).unitCostUsd, ownQuality, false));
    }
    for (const seller of nodeSellersFor(state, company.id, candidate.id)) {
      const priceUsd = namedSupplierPriceUsd(state, seller.company, seller.askUsd, candidate.id);
      out.push(scored('buy', seller.company.id, seller.productId, priceUsd, seller.qualityScore, seller.isDirectRival));
    }
    const blocked = slot.blocking && ownLine === undefined && producersOf(state, candidate.id, cache).length === 0 && !owned.has(candidate.id);
    if (!blocked) out.push(scored('market', null, null, openMarketPriceUsd(state, candidate.id), MARKET_QUALITY, false));
  }
  out.sort(compareOptions);
  return out;
}

/** True when the option is exactly what the slot resolves to today. */
function matches(option: ScoredSlotOption, fill: ResolvedFill): boolean {
  if (option.nodeId !== fill.nodeId || option.route !== fill.route) return false;
  if (option.route === 'market') return true;
  return option.supplierCompanyId === fill.supplierCompanyId && option.supplierProductId === fill.supplierProductId;
}

/* -------------------------------------------------------------------------- */
/*  The two policies                                                           */
/* -------------------------------------------------------------------------- */

/**
 * The `fill_slot` a background company would issue for one slot of one line,
 * or null when it keeps what it has: the slot is left empty on purpose, nothing
 * is on offer, the current fill is within the threshold of the best, or the
 * best is what it already runs on.
 */
export function npcFillFor(state: SessionState, company: Company, product: Product, node: EconomicNode, slot: NodeSlot, cache?: NodeCostCache): ActionIntent | null {
  const current = resolveFill(state, company, product, node, slot, cache);
  if (current.route === 'empty') return null;

  const options = scoredSlotOptions(state, company, node, slot, cache);
  if (options.length === 0) return null;
  const nonRival = options.filter((option) => !option.isDirectRival);
  const pool = nonRival.length > 0 ? nonRival : options;
  const best = pool[0];
  if (best === undefined) return null;

  // Sticky only inside the pool: a fill standing on a direct rival is not
  // kept once a non-rival source exists, because the rivalry is the reason to
  // move — and a fill that is no longer offered at all has nothing to be
  // sticky against.
  const standing = pool.find((option) => matches(option, current));
  if (standing !== undefined) {
    if (matches(best, current)) return null;
    // A fill this company moved inside the settle window is not judged again:
    // the stamped qualities it would be judged on still carry the switch dip.
    const written = fillFor(fillsOf(product), slot.id);
    if (written !== null && written.changedQuarter !== null && state.quarter - written.changedQuarter < NPC_SLOT_SETTLE_QUARTERS) return null;
    if (best.score <= standing.score * NPC_SLOT_SWITCH_THRESHOLD) return null;
  }

  return {
    type: 'fill_slot',
    productId: product.id,
    slotId: slot.id,
    nodeId: best.nodeId,
    supplierCompanyId: best.supplierCompanyId,
    supplierProductId: best.supplierProductId,
  };
}

/** Every `fill_slot` a background company would issue for one line, in slot order. */
export function npcFillsFor(state: SessionState, company: Company, product: Product, node: EconomicNode, cache?: NodeCostCache): ActionIntent[] {
  const out: ActionIntent[] = [];
  for (const slot of node.slots) {
    const intent = npcFillFor(state, company, product, node, slot, cache);
    if (intent !== null) out.push(intent);
  }
  return out;
}

/**
 * The `set_supply_terms` a background company would issue for one node line:
 * publish open at list price when it has never published, reprice to list when
 * the list has drifted past the threshold, otherwise nothing.
 */
export function npcSupplyTermsFor(product: Product): ActionIntent | null {
  const listUsd = money(Math.max(0, product.pricePerSeat));
  const terms = product.supplyTerms ?? null;
  if (terms === null) {
    return { type: 'set_supply_terms', productId: product.id, terms: { openToAll: true, pricePerUnitUsd: listUsd, exclusiveCustomerIds: [], blockedCustomerIds: [] } };
  }
  if (Math.abs(listUsd - terms.pricePerUnitUsd) <= Math.max(1, terms.pricePerUnitUsd) * NPC_SUPPLY_REPRICE_THRESHOLD) return null;
  return {
    type: 'set_supply_terms',
    productId: product.id,
    terms: {
      openToAll: terms.openToAll,
      pricePerUnitUsd: listUsd,
      exclusiveCustomerIds: [...terms.exclusiveCustomerIds],
      blockedCustomerIds: [...terms.blockedCustomerIds],
    },
  };
}
