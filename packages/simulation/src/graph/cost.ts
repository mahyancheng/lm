/**
 * @frontier/simulation — graph/cost.ts
 *
 * The cost roll-up: what one unit of one company's line costs to make this
 * quarter, and why.
 *
 * This is the number the profit and loss books as cost of goods sold — the same
 * number, not a cousin of it. World 2 computed a per-product margin from
 * compute cost alone and let it disagree with the income statement; here there
 * is one arithmetic, itemised, and `unitCostUsd` is the sum of the lines
 * exactly rather than a second calculation that happens to agree.
 *
 * ## How an input is priced, in order
 *
 * 1. **Make.** The company has its own line on that input, so it is transferred
 *    at *its* unit cost, with no internal margin. This is the whole payoff of
 *    vertical integration and the only rule that cannot double count: a group's
 *    profit on an internal sale is not a cost to the group.
 * 2. **Buy.** A named supplier with live published terms, at their ask times
 *    their own `sellerPriceFactor` — the energy where they operate and how
 *    loaded they already are, world 2's one good idea about the compute market,
 *    generalised to every node — and bounded to `[market × 0.5, market × 2.5]`
 *    so neither a gift nor a hostage price can leave the market's gravity.
 * 3. **Market.** Nobody named, but somebody makes it or it is substitutable:
 *    the node's market price times `OPEN_MARKET_PREMIUM`. Spot is dearer than a
 *    contract. That one number is what turns naming a supplier from a pure
 *    penalty — world 2 charged up to 65% of *revenue* for a named supplier and
 *    returned a hardcoded zero for the open market — into the obvious move.
 * 4. **Blocked.** Non-substitutable, nobody named and nobody in the world makes
 *    it: recorded in `blockedInputNodeIds`, contributes nothing, and the line
 *    ships nothing — but now for a reason a player can read on the canvas and
 *    fix by buying, licensing or researching.
 *
 * A **dataset** input is answered before any of the four: the company's own
 * pool feeds it free, because that is the point of having collected it, and
 * only the shortfall goes through the ladder. That is the input world 2's
 * `ai_frontier_models` never had — it declared none at all — and it needs no
 * special case anywhere else, because a corpus is an ordinary node.
 *
 * ## Conversion
 *
 * Four lines are always present — power, labour, capacity and support — and a
 * licence line joins them when the company produces under somebody else's
 * ownership. Support is charged on unit cost rather than on revenue, because
 * charging it on revenue would make unit cost depend on the price that is about
 * to be set from unit cost.
 *
 * ## Termination
 *
 * `consumes` strictly decreases tier and tiers are capped at seven, so the
 * recursion is provably at most seven deep and no visited set is needed. The
 * depth guard below is defensive only: a future bad row must not hang the Pi,
 * so beyond the guard an input answers its market price instead of recursing.
 *
 * Memoisation lives on `ResolverContext.costCache`, one table per quarter
 * resolution. Never module-level: that would leak one save's prices into
 * another's and break replay.
 */

import type { Company, NodeCostCache, SessionState, UnitCostLine, UnitCostResult } from '@frontier/contracts';
import {
  GRID_POWER_NODE_ID,
  NODE_TIERS,
  economicNodeById,
  nodeMarketPriceUsd,
  requiresClosure,
  type Product,
} from '@frontier/contracts';
import { companyEnergyCostFactor } from '../economy/regions';
import { sellerPriceFactor } from '../companies/sellers';
import { capacityRateUsd, drawPerUnitOf, lineNodeIdOf, lineOf, ownedNodeIdsOf, producersOf } from './lines';
import { dataSelfSupplyShare } from './data';

/* -------------------------------------------------------------------------- */
/*  Constants                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * What the open market charges over the settled price of a node.
 *
 * Eight percent: enough that a contract with a named supplier is plainly worth
 * having, small enough that being cut off is a setback rather than a death.
 * This single number replaces world 2's `openMarketSupplyCostUsd`, which
 * returned zero always and therefore made naming a supplier a pure penalty.
 */
export const OPEN_MARKET_PREMIUM = 1.08;

/** The bounds a named supplier's ask is held inside, as multiples of the market price. */
export const SUPPLIER_ASK_BOUNDS = { min: 0.5, max: 2.5 } as const;

/**
 * How deep the roll-up may recurse. The tier invariant proves seven is enough;
 * this is the guard that keeps a corrupt table from becoming a hang.
 */
export const MAX_COST_DEPTH = NODE_TIERS.length;

/** Quarters in a year, for turning annual compensation into a quarter of labour. */
const QUARTERS_PER_YEAR = 4;

/* -------------------------------------------------------------------------- */
/*  Supplier lookup                                                            */
/* -------------------------------------------------------------------------- */

/** A named supplier this company buys one input from, with the ask it publishes. */
export interface SupplierAsk {
  readonly companyId: string;
  readonly productId: string;
  readonly askUsd: number;
}

/**
 * The supplier a company has named for one input of one of its lines.
 *
 * The choice is stored on the buying product's `supply` array. In world 3 the
 * entry names an input *node*; in world 2 it named a product category. The two
 * id spaces are disjoint — every node id carries a `res_`, `mat_`, `cmp_`,
 * `sys_`, `svc_`, `app_` or `dat_` prefix — so reading the same field both ways
 * cannot confuse them.
 *
 * A supplier that has given notice stops supplying at the quarter on the
 * notice, and one that has not published terms, or has blocked this buyer, is
 * not a supplier at all: the input falls through to the open market.
 */
export function supplierAskFor(
  state: SessionState,
  buyer: Company,
  buyerProductId: string | null,
  inputNodeId: string,
): SupplierAsk | null {
  if (buyerProductId === null) return null;
  const product = buyer.products.find((candidate) => candidate.id === buyerProductId);
  if (product === undefined) return null;
  const choice = (product.supply ?? []).find((entry) => entry.inputCategoryId === inputNodeId);
  if (choice === undefined || choice.supplierCompanyId === null || choice.supplierProductId === null) return null;
  if (choice.cutOffNoticeQuarter !== null && state.quarter >= choice.cutOffNoticeQuarter) return null;

  const supplier = state.companies.find((candidate) => candidate.id === choice.supplierCompanyId);
  if (supplier === undefined || !supplier.isActive) return null;
  const line = supplier.products.find((candidate) => candidate.id === choice.supplierProductId);
  if (line === undefined || !line.isActive) return null;
  const terms = line.supplyTerms;
  if (terms === undefined || terms === null) return null;
  if (terms.blockedCustomerIds.includes(buyer.id)) return null;
  if (!terms.openToAll && !terms.exclusiveCustomerIds.includes(buyer.id)) return null;

  return { companyId: supplier.id, productId: line.id, askUsd: Math.max(0, terms.pricePerUnitUsd) };
}

/* -------------------------------------------------------------------------- */
/*  The roll-up                                                                */
/* -------------------------------------------------------------------------- */

/** Clamp into `[min, max]`; non-finite collapses to `min`. */
function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return value < min ? min : value > max ? max : value;
}

/* -------------------------------------------------------------------------- */
/*  The two prices that are not this company's own cost                        */
/* -------------------------------------------------------------------------- */

/**
 * What the open market charges for one unit of a node: its settled price plus
 * the spot premium.
 *
 * Exported because the launch flow quotes it before a line exists, and quoting
 * it there by restating `market x OPEN_MARKET_PREMIUM` is exactly the second
 * arithmetic this module exists to abolish. One function, two readers.
 */
export function openMarketPriceUsd(state: SessionState, inputNodeId: string): number {
  return nodeMarketPriceUsd(state, inputNodeId) * OPEN_MARKET_PREMIUM;
}

/**
 * What a named supplier's published ask actually costs the buyer: the ask at
 * that seller's own cost base, held inside the market's gravity.
 *
 * The bounds are not politeness. A supplier quoting a gift or a hostage price
 * still settles inside `[market x 0.5, market x 2.5]`, so a cartel cannot price
 * a rival out of existence and a parent cannot subsidise a subsidiary to zero.
 * A node with no market price at all — one the table no longer carries — is
 * charged the ask unmodified rather than clamped to zero.
 */
export function namedSupplierPriceUsd(state: SessionState, seller: Company | undefined, askUsd: number, inputNodeId: string): number {
  const marketPrice = nodeMarketPriceUsd(state, inputNodeId);
  const asked = Math.max(0, askUsd) * (seller === undefined ? 1 : sellerPriceFactor(state, seller));
  if (marketPrice <= 0) return asked;
  return clamp(asked, marketPrice * SUPPLIER_ASK_BOUNDS.min, marketPrice * SUPPLIER_ASK_BOUNDS.max);
}

/** The label a cost line carries on screen. Falls back to the id for an unknown node. */
function labelOf(nodeId: string): string {
  return economicNodeById(nodeId)?.label ?? nodeId;
}

/**
 * What one unit of `nodeId` costs `company` this quarter, itemised.
 *
 * `cache` is optional: absent means every call recomputes, which is correct and
 * merely slower — a screen explaining one cost does not need a memo table.
 */
export function unitCostOf(state: SessionState, company: Company, nodeId: string, cache?: NodeCostCache): UnitCostResult {
  return rollUp(state, company, nodeId, cache, 0);
}

function emptyResult(nodeId: string): UnitCostResult {
  return { nodeId, unitCostUsd: 0, lines: [], madeInHouseSharePct: 0, blockedInputNodeIds: [] };
}

function rollUp(state: SessionState, company: Company, nodeId: string, cache: NodeCostCache | undefined, depth: number): UnitCostResult {
  const node = economicNodeById(nodeId);
  if (node === undefined) return emptyResult(nodeId);

  const key = `${company.id}|${nodeId}`;
  const memo = cache?.units.get(key);
  if (memo !== undefined) return memo;

  const line = lineOf(state, company.id, nodeId, cache);
  const lines: UnitCostLine[] = [];
  const blocked: string[] = [];
  let inputTotal = 0;
  let madeInHouse = 0;

  // How many units this line makes in a quarter, floored at one. Only the data
  // self-supply share reads it, and it reads LAST quarter's output — the same
  // reading the node market takes, so there is no fixed point here either.
  const unitsPerQuarter = Math.max(1, line?.unitsSoldLastQuarter ?? 0);

  for (const input of node.consumes) {
    // A dataset input is fed from the company's OWN pool first, free. That is
    // the entire point of having collected it, and it is why an AI laboratory
    // wants customers as much as it wants accelerators. Only the shortfall goes
    // through the make/buy/market ladder below, and a line whose pool covers
    // the whole draw is never blocked: it already has the thing.
    const selfShare = dataSelfSupplyShare(company, node, input.nodeId, input.qtyPerUnit, unitsPerQuarter);
    if (selfShare >= 1) {
      lines.push({
        key: input.nodeId,
        label: labelOf(input.nodeId),
        unitsPerUnit: input.qtyPerUnit,
        unitPriceUsd: 0,
        amountUsd: 0,
        sourceCompanyId: company.id,
        sourceKind: 'make',
      });
      continue;
    }

    const priced = priceInput(state, company, line?.productId ?? null, input.nodeId, input.substitutable, cache, depth);
    if (priced === null) {
      // A blocked input still shows on screen, at zero, so the row a founder
      // has to act on is the row they are already looking at. It carries the
      // `market` kind because that is where it *would* come from; that it is
      // blocked is said by `blockedInputNodeIds`, which is what the product
      // phase reads before it ships anything.
      blocked.push(input.nodeId);
      lines.push({
        key: input.nodeId,
        label: labelOf(input.nodeId),
        unitsPerUnit: input.qtyPerUnit,
        unitPriceUsd: 0,
        amountUsd: 0,
        sourceCompanyId: null,
        sourceKind: 'market',
      });
      continue;
    }
    // The part of a dataset input the company's own pool already covers costs
    // nothing; the rest is bought at whatever the ladder found.
    const unitPriceUsd = priced.unitPriceUsd * (1 - selfShare);
    const amount = input.qtyPerUnit * unitPriceUsd;
    inputTotal += amount;
    if (priced.sourceKind === 'make') madeInHouse += amount;
    lines.push({
      key: input.nodeId,
      label: labelOf(input.nodeId),
      unitsPerUnit: input.qtyPerUnit,
      unitPriceUsd,
      amountUsd: amount,
      sourceCompanyId: priced.sourceCompanyId,
      sourceKind: priced.sourceKind,
    });
  }

  /* --- conversion: power, labour, capacity, support ---------------------- */
  const powerPrice = nodeMarketPriceUsd(state, GRID_POWER_NODE_ID) * companyEnergyCostFactor(state, company);
  const power = node.energyMwhPerUnit * powerPrice;
  lines.push({
    key: 'power',
    label: 'Power',
    unitsPerUnit: node.energyMwhPerUnit,
    unitPriceUsd: powerPrice,
    amountUsd: power,
    sourceCompanyId: null,
    sourceKind: 'conversion',
  });

  const labourRate = Math.max(0, company.employees.avgComp) / QUARTERS_PER_YEAR;
  const labour = node.labourPerUnit * labourRate;
  lines.push({
    key: 'labour',
    label: 'Labour',
    unitsPerUnit: node.labourPerUnit,
    unitPriceUsd: labourRate,
    amountUsd: labour,
    sourceCompanyId: null,
    sourceKind: 'conversion',
  });

  const capacityRate = capacityRateUsd(state, company, node.capacityKind, cache);
  // The draw is the node's own, scaled by this line's quality tier — exactly
  // the draw `producibleUnits` rations against, so the units a line may make
  // and the capacity each of them is charged for are the same arithmetic.
  const draw = drawPerUnitOf(node, line === undefined ? undefined : company.products.find((candidate) => candidate.id === line.productId));
  const capacity = draw * capacityRate;
  lines.push({
    key: 'capacity',
    label: 'Capacity',
    unitsPerUnit: draw,
    unitPriceUsd: capacityRate,
    amountUsd: capacity,
    sourceCompanyId: null,
    sourceKind: 'conversion',
  });

  const supportBase = inputTotal + power + labour + capacity;
  lines.push({
    key: 'support',
    label: 'Support and delivery',
    unitsPerUnit: node.supportCostShare,
    unitPriceUsd: supportBase,
    amountUsd: node.supportCostShare * supportBase,
    sourceCompanyId: null,
    sourceKind: 'conversion',
  });

  /* --- conversion: the licence royalty ----------------------------------- */
  //
  // A royalty is a share of what a unit earns, so it is struck on the node's
  // market price rather than on this company's own asking price. Striking it on
  // the ask would make unit cost depend on the price that is set from unit
  // cost, which is the circularity support cost is charged on cost to avoid.
  const marketPrice = nodeMarketPriceUsd(state, nodeId);
  for (const licence of licencesInForce(company, nodeId, state.quarter)) {
    const share = licence.royaltyPct / 100;
    lines.push({
      key: `licence:${licence.nodeId}`,
      label: `Licence — ${labelOf(licence.nodeId)}`,
      unitsPerUnit: share,
      unitPriceUsd: marketPrice,
      amountUsd: share * marketPrice,
      sourceCompanyId: licence.ownerCompanyId,
      sourceKind: 'conversion',
    });
  }

  // The total is the sum of the lines, in the order they were built, so the
  // column on screen adds up to the figure at the bottom of it exactly.
  const unitCostUsd = lines.reduce((total, entry) => total + entry.amountUsd, 0);
  const result: UnitCostResult = {
    nodeId,
    unitCostUsd,
    lines,
    madeInHouseSharePct: inputTotal <= 0 ? 0 : Math.round((madeInHouse / inputTotal) * 100),
    blockedInputNodeIds: blocked,
  };
  cache?.units.set(key, result);
  return result;
}

/** Licences this company holds over the node it is making, or over anything that node requires. */
function licencesInForce(company: Company, nodeId: string, quarter: number): readonly { nodeId: string; ownerCompanyId: string; royaltyPct: number }[] {
  const held = company.licences;
  if (held === undefined || held.length === 0) return [];
  const closure = new Set(requiresClosure(nodeId));
  return held.filter((licence) => licence.expiryQuarter > quarter && closure.has(licence.nodeId));
}

/** One priced input, or null when it is blocked. */
interface PricedInput {
  readonly unitPriceUsd: number;
  readonly sourceCompanyId: string | null;
  readonly sourceKind: UnitCostLine['sourceKind'];
}

function priceInput(
  state: SessionState,
  company: Company,
  buyerProductId: string | null,
  inputNodeId: string,
  substitutable: boolean,
  cache: NodeCostCache | undefined,
  depth: number,
): PricedInput | null {
  // Defensive only: the tier invariant makes a chain deeper than the tier count
  // unrepresentable, so past the guard the market price is the honest answer
  // rather than a hang.
  if (depth >= MAX_COST_DEPTH) {
    return { unitPriceUsd: openMarketPriceUsd(state, inputNodeId), sourceCompanyId: null, sourceKind: 'market' };
  }

  // (1) Make. Transferred at this company's own cost, with no internal margin.
  const own = lineOf(state, company.id, inputNodeId, cache);
  if (own !== undefined) {
    const upstream = rollUp(state, company, inputNodeId, cache, depth + 1);
    return { unitPriceUsd: upstream.unitCostUsd, sourceCompanyId: company.id, sourceKind: 'make' };
  }

  // (2) Buy. A named supplier's ask, at that seller's own cost base, held
  // inside the market's gravity.
  //
  // `sellerPriceFactor` is the one good idea world 2's compute market had —
  // a seller's price moves with the energy where it operates and with how
  // loaded it already is — and here it is generalised to every node in the
  // table. It is what keeps "who do I buy this from" a real question after
  // the published ask has been read: two suppliers quoting the same number
  // are not the same supplier.
  const supplier = supplierAskFor(state, company, buyerProductId, inputNodeId);
  if (supplier !== null) {
    const seller = state.companies.find((candidate) => candidate.id === supplier.companyId);
    return {
      unitPriceUsd: namedSupplierPriceUsd(state, seller, supplier.askUsd, inputNodeId),
      sourceCompanyId: supplier.companyId,
      sourceKind: 'buy',
    };
  }

  // (3) Market, or (4) blocked.
  //
  // Blocked is the strong claim and is held to the strong test: not "nobody is
  // running a line on it this quarter" — the market already prices that, at the
  // top of the node's band — but "nobody in the world owns or licences it, so
  // it cannot be had at any price". A world where every node has an owner
  // therefore never blocks, and a node the World Director has only just
  // proposed does, which is the distinction that makes the state worth having.
  if (!substitutable) {
    const somebodyMakesIt = producersOf(state, inputNodeId, cache).length > 0;
    const somebodyCouldMakeIt = somebodyMakesIt || (cache?.ownedNodeIds ?? ownedNodeIdsOf(state)).has(inputNodeId);
    if (!somebodyCouldMakeIt) return null;
  }
  return { unitPriceUsd: openMarketPriceUsd(state, inputNodeId), sourceCompanyId: null, sourceKind: 'market' };
}

/* -------------------------------------------------------------------------- */
/*  Readers                                                                    */
/* -------------------------------------------------------------------------- */

/** Whether this line can ship at all: every non-substitutable input has a source. */
export function lineIsBlocked(result: UnitCostResult): boolean {
  return result.blockedInputNodeIds.length > 0;
}

/** The unit cost of a stored line, for callers that hold the product rather than the node id. */
export function unitCostOfProduct(state: SessionState, company: Company, product: Product, cache?: NodeCostCache): UnitCostResult | null {
  const nodeId = lineNodeIdOf(product);
  return nodeId === null ? null : unitCostOf(state, company, nodeId, cache);
}

/** The lines of a roll-up that are real inputs rather than conversion. */
export function inputLinesOf(result: UnitCostResult): readonly UnitCostLine[] {
  return result.lines.filter((entry) => entry.sourceKind !== 'conversion');
}

