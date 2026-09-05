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
 * ## How a slot is priced
 *
 * Every slot of the line's node is resolved through `resolveFill` in
 * `graph/slots.ts` — the fill on the product, or the table's default — and the
 * route it comes back with is priced here, in the roll-up's own order:
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
 * 3. **Market.** Nobody named, but somebody makes it or the slot never blocks:
 *    the node's market price times `OPEN_MARKET_PREMIUM`. Spot is dearer than a
 *    contract. That one number is what turns naming a supplier from a pure
 *    penalty — world 2 charged up to 65% of *revenue* for a named supplier and
 *    returned a hardcoded zero for the open market — into the obvious move.
 * 4. **Blocked.** A blocking slot whose resolved node nobody in the world owns
 *    or licences: recorded in `blockedInputNodeIds`, contributes nothing, and
 *    the line ships nothing — but now for a reason a player can read on the
 *    canvas and fix by buying, licensing, researching or refilling the slot.
 * 5. **Empty.** A slot the table does not require, left unfilled: a zero row
 *    with no node, so the screen still shows the port.
 *
 * MAKE is what the fill says, not automatic: a fill naming a rival prices as a
 * buy even when the company runs its own line on the node, and a missing fill
 * keeps the default — own line first — so a line that has never composed
 * anything costs exactly what it always cost.
 *
 * Rows are keyed `slot:${slotId}` rather than by input node, so a row keeps its
 * identity across a node switch and a screen can diff two compositions.
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
 * Every slot's role sits strictly below its owner and tiers are capped at
 * eight, so the recursion is provably at most eight deep and no visited set is
 * needed. The depth guard below is defensive only: a future bad row must not
 * hang the Pi, so beyond the guard an input answers its market price instead of
 * recursing.
 *
 * Memoisation lives on `ResolverContext.costCache`, one table per quarter
 * resolution. Never module-level: that would leak one save's prices into
 * another's and break replay.
 */

import type { Company, NodeCostCache, NodeSlot, SessionState, UnitCostLine, UnitCostResult } from '@frontier/contracts';
import { GRID_POWER_NODE_ID, NODE_TIERS, economicNodeById, nodeMarketPriceUsd, requiresClosure, type Product } from '@frontier/contracts';
import { companyEnergyCostFactor } from '../economy/regions';
import { sellerPriceFactor } from '../companies/sellers';
import { capacityRateUsd, drawPerUnitAtTier, drawPerUnitOf, lineNodeIdOf, lineOf, productOf } from './lines';
import { dataSelfSupplyShare } from './data';
import { resolveFill, type FillOverride, type ResolvedFill } from './slots';

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
 * How deep the roll-up may recurse. The tier invariant proves the tier count is
 * enough; this is the guard that keeps a corrupt table from becoming a hang.
 */
export const MAX_COST_DEPTH = NODE_TIERS.length;

/** Quarters in a year, for turning annual compensation into a quarter of labour. */
const QUARTERS_PER_YEAR = 4;

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
 * `override` is the launch preview's composition for a line that does not
 * exist yet; a result built on it is never memoised, because the memo is keyed
 * on the company's real line and a preview is not that.
 */
export function unitCostOf(state: SessionState, company: Company, nodeId: string, cache?: NodeCostCache, override?: FillOverride): UnitCostResult {
  return rollUp(state, company, nodeId, cache, 0, override);
}

function emptyResult(nodeId: string): UnitCostResult {
  return { nodeId, unitCostUsd: 0, lines: [], madeInHouseSharePct: 0, blockedInputNodeIds: [] };
}

/** A zero row for a slot that contributes nothing: left empty, or blocked. */
function zeroLine(slot: NodeSlot, fill: ResolvedFill): UnitCostLine {
  return {
    key: `slot:${slot.id}`,
    slotId: slot.id,
    nodeId: fill.nodeId,
    label: fill.nodeId === null ? `${slot.label}: none` : labelOf(fill.nodeId),
    unitsPerUnit: slot.qtyPerUnit,
    unitPriceUsd: 0,
    amountUsd: 0,
    sourceCompanyId: null,
    sourceKind: 'market',
  };
}

function rollUp(
  state: SessionState,
  company: Company,
  nodeId: string,
  cache: NodeCostCache | undefined,
  depth: number,
  override?: FillOverride,
): UnitCostResult {
  const node = economicNodeById(nodeId);
  if (node === undefined) return emptyResult(nodeId);

  const key = `${company.id}|${nodeId}`;
  const memo = override === undefined ? cache?.units.get(key) : undefined;
  if (memo !== undefined) return memo;

  const line = lineOf(state, company.id, nodeId, cache);
  const product = line === undefined ? null : (productOf(state, company.id, line.productId) ?? null);
  const lines: UnitCostLine[] = [];
  const blocked: string[] = [];
  let inputTotal = 0;
  let madeInHouse = 0;

  // How many units this line makes in a quarter, floored at one. Only the data
  // self-supply share reads it, and it reads LAST quarter's output — the same
  // reading the node market takes, so there is no fixed point here either.
  const unitsPerQuarter = Math.max(1, line?.unitsSoldLastQuarter ?? 0);

  for (const slot of node.slots) {
    const fill = resolveFill(state, company, product, node, slot, cache, override);
    if (fill.nodeId === null) {
      // An optional slot left empty: a zero row, so the port is still on the
      // screen and a founder can see there is something they could put there.
      lines.push(zeroLine(slot, fill));
      continue;
    }
    // A dataset input is fed from the company's OWN pool first, free. That is
    // the entire point of having collected it, and it is why an AI laboratory
    // wants customers as much as it wants accelerators. Only the shortfall goes
    // through the make/buy/market ladder below, and a line whose pool covers
    // the whole draw is never blocked: it already has the thing. Keyed on the
    // node actually in the slot, so a line that swaps one corpus for another
    // is judged on the pool it would really draw from.
    const selfShare = dataSelfSupplyShare(company, node, fill.nodeId, slot.qtyPerUnit, unitsPerQuarter);
    if (fill.route === 'blocked' && selfShare < 1) {
      // A blocked input still shows on screen, at zero, so the row a founder
      // has to act on is the row they are already looking at. It carries the
      // `market` kind because that is where it *would* come from; that it is
      // blocked is said by `blockedInputNodeIds`, which is what the product
      // phase reads before it ships anything.
      blocked.push(fill.nodeId);
      lines.push(zeroLine(slot, fill));
      continue;
    }
    if (selfShare >= 1) {
      lines.push({
        key: `slot:${slot.id}`,
        slotId: slot.id,
        nodeId: fill.nodeId,
        label: labelOf(fill.nodeId),
        unitsPerUnit: slot.qtyPerUnit,
        unitPriceUsd: 0,
        amountUsd: 0,
        sourceCompanyId: company.id,
        sourceKind: 'make',
      });
      continue;
    }

    const priced = priceResolved(state, company, fill, cache, depth);
    // The part of a dataset input the company's own pool already covers costs
    // nothing; the rest is bought at whatever the ladder found.
    const unitPriceUsd = priced.unitPriceUsd * (1 - selfShare);
    const amount = slot.qtyPerUnit * unitPriceUsd;
    inputTotal += amount;
    if (priced.sourceKind === 'make') madeInHouse += amount;
    lines.push({
      key: `slot:${slot.id}`,
      slotId: slot.id,
      nodeId: fill.nodeId,
      label: labelOf(fill.nodeId),
      unitsPerUnit: slot.qtyPerUnit,
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
  // and the capacity each of them is charged for are the same arithmetic. A
  // preview costs at the tier the founder is about to launch at.
  const draw = override?.qualityTier !== undefined ? drawPerUnitAtTier(node, override.qualityTier) : drawPerUnitOf(node, product ?? undefined);
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
  if (override === undefined) cache?.units.set(key, result);
  return result;
}

/** Licences this company holds over the node it is making, or over anything that node requires. */
function licencesInForce(company: Company, nodeId: string, quarter: number): readonly { nodeId: string; ownerCompanyId: string; royaltyPct: number }[] {
  const held = company.licences;
  if (held === undefined || held.length === 0) return [];
  const closure = new Set(requiresClosure(nodeId));
  return held.filter((licence) => licence.expiryQuarter > quarter && closure.has(licence.nodeId));
}

/** One priced input. */
interface PricedInput {
  readonly unitPriceUsd: number;
  readonly sourceCompanyId: string | null;
  readonly sourceKind: UnitCostLine['sourceKind'];
}

/**
 * Price a resolved fill by its route. The route was decided in `resolveFill`;
 * this only says what each route costs, through the three functions the launch
 * flow quotes with.
 */
function priceResolved(state: SessionState, company: Company, fill: ResolvedFill, cache: NodeCostCache | undefined, depth: number): PricedInput {
  const inputNodeId = fill.nodeId ?? '';
  // Defensive only: the tier invariant makes a chain deeper than the tier count
  // unrepresentable, so past the guard the market price is the honest answer
  // rather than a hang.
  if (depth >= MAX_COST_DEPTH) {
    return { unitPriceUsd: openMarketPriceUsd(state, inputNodeId), sourceCompanyId: null, sourceKind: 'market' };
  }

  // (1) Make. Transferred at this company's own cost, with no internal margin.
  if (fill.route === 'make') {
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
  if (fill.route === 'buy' && fill.supplierCompanyId !== null) {
    const seller = state.companies.find((candidate) => candidate.id === fill.supplierCompanyId);
    return {
      unitPriceUsd: namedSupplierPriceUsd(state, seller, fill.askUsd ?? 0, inputNodeId),
      sourceCompanyId: fill.supplierCompanyId,
      sourceKind: 'buy',
    };
  }

  // (3) Market.
  return { unitPriceUsd: openMarketPriceUsd(state, inputNodeId), sourceCompanyId: null, sourceKind: 'market' };
}

/* -------------------------------------------------------------------------- */
/*  Readers                                                                    */
/* -------------------------------------------------------------------------- */

/** Whether this line can ship at all: every blocking input has a source. */
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

