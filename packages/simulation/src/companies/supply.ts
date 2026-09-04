/**
 * @frontier/simulation — companies/supply.ts
 *
 * The owner's second north star, made mechanical: "if any company publishes a
 * public API for its LLM, any other company with a harness can decide if they
 * want to put a product on the other company's LLM." Stage 2 gave every
 * product category its `inputs` (what it is built on) and its `canSupply`
 * (whether it can be somebody else's input). This module is what turns that
 * declared graph into real transactions between two named companies.
 *
 * ## The three questions
 *
 * 1. **What is this product built on, and how good is that?** `resolveSupplyLine`
 *    answers, for one input, whether the buyer has a live named supplier, is
 *    on the open market (no real counterparty — the category's own margin
 *    baseline already prices it, so this costs nothing extra), or has left a
 *    `required` input genuinely unfilled — which means the product cannot
 *    ship. `categoryEffectiveQuality` blends the answer into the product's own
 *    quality by the input's `share`.
 * 2. **What does it cost, and who gets paid?** `supplyInputCostUsd` (the
 *    buyer's bill) and `supplyChargesByCompany` (the seller's revenue) are two
 *    views of the same ledger, `resolveSupplyLedger`, so a buyer's spend and a
 *    seller's revenue can never disagree. A supplier's own published price,
 *    relative to its category's reference, is the leverage: price above
 *    reference and every customer's margin falls; price below and volume
 *    grows. A supplier whose own capacity is already spoken for rations
 *    external buyers exactly as it rations its own customers — proportionally,
 *    and it says so.
 * 3. **How exposed is a company to one supplier?** `dependenceOn` is derived,
 *    never stored: the share of a company's revenue riding on one supplier
 *    company, recomputed from the ledger every time it is asked.
 *
 * `resolveSupplyOrders` is the fourth piece: it applies this quarter's
 * `choose_supplier` and `set_supply_terms` actions (the same two-phase
 * contract `resolveComputeOrders` and `resolveCapacityOrders` use — called
 * from `resolveProducts`, before demand), and runs the one-quarter notice a
 * cut-off buyer is owed.
 *
 * World version 1 has no product categories, so every function here is a
 * no-op or an empty result for it — nothing here is ever called from a
 * world-1 path, and `isMultiSectorWorld` guards the few functions that are
 * reachable from generic code.
 *
 * Determinism: no RNG, no clock beyond `ctx.quarter`. Every price and every
 * ration is a pure function of the draft.
 */

import type { Company, Product, ProductCategory, ProductCategoryInput, ResolverContext, SessionState } from '@frontier/contracts';
import { customersPerUnit, servingComputeUnits } from './products';
import { categoryOf, capacityUsd } from './categories';
import { isMultiSectorWorld, isNodeEconomyWorld } from '../economy/sectors';
import { lineNodeIdOf } from '../graph/lines';
import { unitCostOf } from '../graph/cost';
import { nodeSellersFor } from '../graph/options';
import { activeCompanies, activeProducts, clamp, companyActions, emitEvent, intentsOfType, money, ratio, unit, usdLabel } from './util';

/* -------------------------------------------------------------------------- */
/*  Constants                                                                  */
/* -------------------------------------------------------------------------- */

/** How much of a switched input's quality shift lands the quarter it switches. The rest is the switching cost. */
export const SWITCH_QUALITY_FACTOR = 0.7;
/** Bounds on how far a supplier's own price can move the cost it charges, relative to its category's reference. */
export const SUPPLY_PRICE_FACTOR_BOUNDS = { min: 0.25, max: 4 } as const;
/** Quarters of notice a buyer gets before a cut-off actually drops it to unsupplied. */
export const SUPPLY_CUT_OFF_NOTICE_QUARTERS = 1;
/** Default margin an NPC default publishes its supply terms at, over its category's reference price. */
export const NPC_DEFAULT_SUPPLY_MARGIN = 1.1;

/* -------------------------------------------------------------------------- */
/*  Resolving one input                                                       */
/* -------------------------------------------------------------------------- */

export type SupplyStatus = 'supplied' | 'open_market' | 'unsupplied';

/** What one input of one product resolves to this quarter. */
export interface ResolvedSupplyLine {
  readonly status: SupplyStatus;
  readonly supplierCompany: Company | null;
  readonly supplierProduct: Product | null;
  readonly supplierCategory: ProductCategory | null;
}

const OPEN_MARKET: ResolvedSupplyLine = { status: 'open_market', supplierCompany: null, supplierProduct: null, supplierCategory: null };
const unsuppliedOrOpen = (required: boolean): ResolvedSupplyLine =>
  required ? { status: 'unsupplied', supplierCompany: null, supplierProduct: null, supplierCategory: null } : OPEN_MARKET;

/**
 * Resolve one category input of one product against the buyer's own choices
 * and the named supplier's current, live terms.
 *
 * No entry at all for this input — every product launched before supply
 * chains existed, and every input a founder has not touched — is the open
 * market: unsupplied only ever follows a *deliberate* null (a buyer's own
 * `choose_supplier`, or a supplier's cut-off) on a `required` input. That is
 * what keeps this additive: nothing already live is retroactively broken by
 * this module existing.
 */
export function resolveSupplyLine(draft: SessionState, buyer: Company, product: Product, input: ProductCategoryInput): ResolvedSupplyLine {
  const line = (product.supply ?? []).find((entry) => entry.inputCategoryId === input.categoryId) ?? null;
  if (line === null) return OPEN_MARKET;
  if (line.supplierCompanyId === null) return unsuppliedOrOpen(input.required);

  const supplierCompany = draft.companies.find((candidate) => candidate.id === line.supplierCompanyId && candidate.isActive) ?? null;
  const supplierProduct = supplierCompany?.products.find((candidate) => candidate.id === line.supplierProductId && candidate.isActive) ?? null;
  if (supplierCompany === null || supplierProduct === null) return unsuppliedOrOpen(input.required);

  const supplierCategory = categoryOf(supplierCompany, supplierProduct);
  if (supplierCategory.id !== input.categoryId || !supplierCategory.canSupply) return unsuppliedOrOpen(input.required);

  const terms = supplierProduct.supplyTerms ?? null;
  const blocked = terms !== null && terms.blockedCustomerIds.includes(buyer.id);
  const allowed = terms !== null && !blocked && (terms.openToAll || terms.exclusiveCustomerIds.includes(buyer.id));
  if (!allowed) return unsuppliedOrOpen(input.required);

  return { status: 'supplied', supplierCompany, supplierProduct, supplierCategory };
}

/** True when any `required` input of this product is deliberately unfilled. The product ships zero units. */
export function requiredInputUnsupplied(draft: SessionState, company: Company, product: Product): boolean {
  if (!isMultiSectorWorld(draft)) return false;
  const category = categoryOf(company, product);
  for (const input of category.inputs) {
    if (input.required && resolveSupplyLine(draft, company, product, input).status === 'unsupplied') return true;
  }
  return false;
}

/**
 * The blended quality a product sells at: its own quality, pulled toward each
 * live supplier's product quality by that input's `share`. An input on the
 * open market or genuinely unsupplied contributes nothing — there is no real
 * product to blend in.
 *
 * `switchedThisQuarter` carries `${product.id}|${inputCategoryId}` keys for
 * every line `resolveSupplyOrders` changed this quarter: that line's pull
 * toward the new supplier's quality is dampened to `SWITCH_QUALITY_FACTOR`
 * for the one quarter the switch lands in, which is the switching cost the
 * owner's second north star asks for ("switching costs one quarter of
 * degraded quality, stated").
 */
/**
 * Worlds 1 and 2 only, and named for what it actually reads: it blends supplier
 * quality over a **product category's** declared inputs, weighted by the
 * `share`-of-revenue world 3 deletes. World 3's one quality function is
 * `graph/production.ts`'s `effectiveQuality`, which weights by bill-of-materials
 * value share and adds the company's own data edge.
 */
export function categoryEffectiveQuality(
  draft: SessionState,
  company: Company,
  product: Product,
  switchedThisQuarter: ReadonlySet<string> = EMPTY_SWITCH_SET,
): number {
  if (!isMultiSectorWorld(draft)) return product.qualityScore;
  const category = categoryOf(company, product);
  if (category.inputs.length === 0) return product.qualityScore;

  let result = product.qualityScore;
  for (const input of category.inputs) {
    const resolved = resolveSupplyLine(draft, company, product, input);
    if (resolved.status !== 'supplied' || resolved.supplierProduct === null) continue;
    const supplierQuality = resolved.supplierProduct.qualityScore;
    const switched = switchedThisQuarter.has(`${product.id}|${input.categoryId}`);
    const realisedQuality = product.qualityScore + (supplierQuality - product.qualityScore) * (switched ? SWITCH_QUALITY_FACTOR : 1);
    result += input.share * (realisedQuality - product.qualityScore);
  }
  return unit(result);
}

const EMPTY_SWITCH_SET: ReadonlySet<string> = new Set();

/* -------------------------------------------------------------------------- */
/*  Price, cost and the reconciling ledger                                    */
/* -------------------------------------------------------------------------- */

/**
 * What a supplier actually charges per unit this quarter: its own published
 * price, bounded to `SUPPLY_PRICE_FACTOR_BOUNDS` times its category's
 * reference — real leverage in both directions, without letting one
 * mis-keyed price collapse or explode a buyer's whole cost base. Falls back
 * to the reference price itself when nothing is published (should not arise
 * once `resolveSupplyLine` has already required `supplyTerms` to be non-null
 * for a 'supplied' line, but a stale product is read defensively).
 */
function boundedSupplyPriceUsd(supplierProduct: Product, supplierCategory: ProductCategory): number {
  const reference = supplierCategory.referencePriceUsd;
  const published = supplierProduct.supplyTerms?.pricePerUnitUsd ?? reference;
  if (!(reference > 0)) return Math.max(0, published);
  return clamp(published, reference * SUPPLY_PRICE_FACTOR_BOUNDS.min, reference * SUPPLY_PRICE_FACTOR_BOUNDS.max);
}

/** Units of a supplier's capacity kind one of its own products is drawing this quarter, at its own yield. */
function ownUsageUnits(draft: SessionState, supplierCompany: Company, supplierProduct: Product, supplierCategory: ProductCategory): number {
  if (supplierCategory.capacityKind === 'none') return Number.POSITIVE_INFINITY;
  if (supplierCategory.capacityKind === 'compute') {
    return supplierProduct.activeCustomers / Math.max(1e-6, customersPerUnit(draft, supplierProduct.computeIntensity));
  }
  return supplierProduct.activeCustomers / Math.max(1e-6, supplierCategory.capacityYieldPerUnit);
}

/** Capacity of a supplier's kind available across the company, before its own usage is deducted. */
function availableUnits(draft: SessionState, supplierCompany: Company, supplierCategory: ProductCategory): number {
  if (supplierCategory.capacityKind === 'none') return Number.POSITIVE_INFINITY;
  if (supplierCategory.capacityKind === 'compute') return servingComputeUnits(draft, supplierCompany);
  if (supplierCompany.capacity === undefined) return Number.POSITIVE_INFINITY;
  return capacityUsd(supplierCompany, supplierCategory.capacityKind) / 1_000_000;
}

/** One buyer's draw on one named supplier this quarter, before capacity rations it. */
interface SupplyDraw {
  readonly buyerCompany: Company;
  readonly buyerProduct: Product;
  readonly inputCategoryId: string;
  readonly supplierCompany: Company;
  readonly supplierProduct: Product;
  readonly supplierCategory: ProductCategory;
  /** Reference-priced units this draw represents — the normalised quantity capacity is rationed in. */
  readonly unitsRequested: number;
}

/** Every live supply draw this quarter, buyer order then input order — deterministic and total. */
function collectSupplyDraws(draft: SessionState): SupplyDraw[] {
  const draws: SupplyDraw[] = [];
  if (!isMultiSectorWorld(draft)) return draws;
  for (const buyer of activeCompanies(draft)) {
    for (const product of activeProducts(buyer)) {
      const category = categoryOf(buyer, product);
      if (category.inputs.length === 0) continue;
      const revenue = product.activeCustomers * product.pricePerSeat;
      if (!(revenue > 0)) continue;
      for (const input of category.inputs) {
        const resolved = resolveSupplyLine(draft, buyer, product, input);
        if (resolved.status !== 'supplied' || resolved.supplierCompany === null || resolved.supplierProduct === null || resolved.supplierCategory === null) {
          continue;
        }
        const referenceCostUsd = revenue * input.share;
        const unitsRequested = ratio(referenceCostUsd, resolved.supplierCategory.referencePriceUsd, 0);
        if (unitsRequested <= 0) continue;
        draws.push({
          buyerCompany: buyer,
          buyerProduct: product,
          inputCategoryId: input.categoryId,
          supplierCompany: resolved.supplierCompany,
          supplierProduct: resolved.supplierProduct,
          supplierCategory: resolved.supplierCategory,
          unitsRequested,
        });
      }
    }
  }
  return draws;
}

/** One resolved line of the supply ledger: what a buyer actually paid and a supplier actually earned. */
export interface SupplyLedgerEntry extends SupplyDraw {
  /** Requested units filled, after the supplier's own spare capacity rations every buyer proportionally. */
  readonly unitsFilled: number;
  readonly costUsd: number;
  /** True when the supplier could not fill every buyer's draw whole. */
  readonly capacityShort: boolean;
}

/**
 * Every named-supplier draw this quarter, rationed against each supplier
 * product's own spare capacity — the same rule `sellableCapacityUnits` and
 * `rationCapacityByKind` apply to compute and to a product's own demand,
 * generalised to an external buyer's draw: a supplier at full capacity
 * degrades every buyer proportionally rather than favouring whoever happened
 * to be resolved first.
 *
 * The one function both `supplyInputCostUsd` (a buyer's bill) and
 * `supplyChargesByCompany` (a seller's revenue) read, so the two can never
 * disagree about what changed hands.
 */
export function resolveSupplyLedger(draft: SessionState): SupplyLedgerEntry[] {
  const draws = collectSupplyDraws(draft);
  if (draws.length === 0) return [];

  const bySupplierProduct = new Map<string, SupplyDraw[]>();
  for (const draw of draws) {
    const key = `${draw.supplierCompany.id}|${draw.supplierProduct.id}`;
    const bucket = bySupplierProduct.get(key) ?? [];
    bucket.push(draw);
    bySupplierProduct.set(key, bucket);
  }

  const out: SupplyLedgerEntry[] = [];
  for (const [, bucket] of bySupplierProduct) {
    const first = bucket[0];
    if (first === undefined) continue;
    const available = availableUnits(draft, first.supplierCompany, first.supplierCategory);
    const own = ownUsageUnits(draft, first.supplierCompany, first.supplierProduct, first.supplierCategory);
    const spare = Number.isFinite(available) ? Math.max(0, available - (Number.isFinite(own) ? own : 0)) : Number.POSITIVE_INFINITY;
    const totalRequested = bucket.reduce((sum, draw) => sum + draw.unitsRequested, 0);
    const fillRatio = !Number.isFinite(spare) || totalRequested <= 0 ? 1 : clamp(spare / totalRequested, 0, 1);
    const unitPriceUsd = boundedSupplyPriceUsd(first.supplierProduct, first.supplierCategory);
    for (const draw of bucket) {
      const unitsFilled = draw.unitsRequested * fillRatio;
      out.push({
        ...draw,
        unitsFilled,
        costUsd: money(unitsFilled * unitPriceUsd),
        capacityShort: fillRatio < 0.999,
      });
    }
  }
  return out;
}

/**
 * The open-market share of one buyer product's input cost: always zero.
 *
 * WORLD 2 ONLY, and world 3 does not call it at all: the node roll-up prices an
 * unnamed input at `market x OPEN_MARKET_PREMIUM` (graph/cost.ts), which is the
 * number that turns naming a supplier from a pure penalty into the obvious
 * move. What follows is why the world-2 answer is zero, kept because world 2
 * still runs on it.
 *
 * `category.grossMarginBaselinePct` already prices in whatever a healthy line
 * needs to build itself, inputs included — every product in the catalogue was
 * tuned against that baseline before this module existed. So "the open
 * market" is the model's existing, already-accounted-for cost, not a new one
 * on top of it: charging `share × revenue` here would tax every product that
 * has never touched `choose_supplier` a second time for the same input,
 * retroactively crushing an economy this stage is supposed to add real
 * transactions to, not real losses. Real money moves only once a company
 * makes an actual choice: `resolveSupplyLedger` prices every `supplied` line,
 * cheaper or dearer than baseline exactly as the chosen supplier's own price
 * says, which is where the owner's second north star — a real transaction
 * between two named companies, priced by the seller — actually lives.
 *
 * Kept as a named function rather than inlined so the decision has a place to
 * be found and revisited, not because there is anything left for it to do.
 */
export function openMarketSupplyCostUsd(_draft: SessionState, _buyer: Company, _product: Product): number {
  return 0;
}

/**
 * What one buyer product owes for its inputs this quarter: every named,
 * capacity-rationed supplier draw. A test or screen convenience —
 * `financial_resolution` itself computes the ledger once for the whole
 * quarter rather than re-walking it for every product.
 */
export function supplyInputCostUsd(draft: SessionState, buyer: Company, product: Product): number {
  if (!isMultiSectorWorld(draft)) return 0;
  let total = 0;
  for (const entry of resolveSupplyLedger(draft)) {
    if (entry.buyerCompany.id === buyer.id && entry.buyerProduct.id === product.id) total += entry.costUsd;
  }
  return money(total);
}

/**
 * What every named supplier earns this quarter, summed across every buyer
 * drawing on it — the figure `financial_resolution` adds into that seller's
 * revenue, through the same intercompany path `counterpartyRevenueByCompany`
 * uses for compute, at the seller's own realised margin.
 */
export function supplyChargesByCompany(draft: SessionState): Map<string, number> {
  const out = new Map<string, number>();
  for (const entry of resolveSupplyLedger(draft)) {
    if (entry.costUsd <= 0) continue;
    out.set(entry.supplierCompany.id, money((out.get(entry.supplierCompany.id) ?? 0) + entry.costUsd));
  }
  return out;
}

/**
 * The world-3 reading of dependence: the share of revenue whose unit cost is
 * bought from one named supplier, weighted by how much of each unit it is.
 */
function nodeDependenceOn(draft: SessionState, company: Company, supplierCompanyId: string): number {
  let totalRevenue = 0;
  let dependentRevenue = 0;
  for (const product of activeProducts(company)) {
    const units = Math.max(0, product.unitsSoldQuarterly ?? product.activeCustomers);
    const revenue = units * product.pricePerSeat;
    totalRevenue += revenue;
    if (revenue <= 0) continue;
    const nodeId = lineNodeIdOf(product);
    if (nodeId === null) continue;
    const cost = unitCostOf(draft, company, nodeId);
    if (!(cost.unitCostUsd > 0)) continue;
    let fromSupplier = 0;
    for (const line of cost.lines) if (line.sourceCompanyId === supplierCompanyId && line.sourceKind === 'buy') fromSupplier += line.amountUsd;
    dependentRevenue += revenue * clamp(fromSupplier / cost.unitCostUsd, 0, 1);
  }
  return totalRevenue <= 0 ? 0 : unit(ratio(dependentRevenue, totalRevenue));
}

/**
 * Share of `company`'s revenue riding on `supplierCompanyId` this quarter —
 * derived, never stored, so the dossier and the feed always read the current
 * position rather than a figure that can go stale.
 */
export function dependenceOn(draft: SessionState, company: Company, supplierCompanyId: string): number {
  if (!isMultiSectorWorld(draft)) return 0;
  let totalRevenue = 0;
  let dependentRevenue = 0;
  for (const product of activeProducts(company)) {
    const revenue = product.activeCustomers * product.pricePerSeat;
    totalRevenue += revenue;
    if (revenue <= 0) continue;
    const category = categoryOf(company, product);
    for (const input of category.inputs) {
      const resolved = resolveSupplyLine(draft, company, product, input);
      if (resolved.status === 'supplied' && resolved.supplierCompany?.id === supplierCompanyId) {
        dependentRevenue += revenue * input.share;
      }
    }
  }
  return unit(ratio(dependentRevenue, totalRevenue, 0));
}

/* -------------------------------------------------------------------------- */
/*  Lookups — every open supplier, and every customer of a supplying line     */
/* -------------------------------------------------------------------------- */

/** One company that could supply an input, priced and qualified, cheapest-quality-per-dollar first. */
export interface SupplyOffer {
  readonly company: Company;
  readonly product: Product;
  readonly pricePerUnitUsd: number;
  readonly qualityScore: number;
  /** True when this offer sells into the same category as one of the buyer's own supplying lines — a direct rival. */
  readonly isDirectRival: boolean;
}

/** Every company whose open supply terms would currently accept `buyerCompanyId` for `inputCategoryId`. */
export function suppliersFor(draft: SessionState, buyerCompanyId: string, inputCategoryId: string): SupplyOffer[] {
  if (!isMultiSectorWorld(draft)) return [];
  // World 3: the id is a NODE id and a line is matched on the node it produces,
  // not on a world-2 category. The two id spaces are disjoint — every node id
  // carries a table prefix — so this branch cannot capture a category lookup.
  if (isNodeEconomyWorld(draft)) {
    return nodeSellersFor(draft, buyerCompanyId, inputCategoryId).map((seller) => ({
      company: seller.company,
      product: seller.company.products.find((candidate) => candidate.id === seller.productId)!,
      pricePerUnitUsd: seller.askUsd,
      qualityScore: seller.qualityScore,
      isDirectRival: seller.isDirectRival,
    }));
  }
  const buyer = draft.companies.find((candidate) => candidate.id === buyerCompanyId) ?? null;
  const buyerSuppliesSameCategory = new Set(
    (buyer?.products ?? [])
      .filter((product) => product.isActive && product.supplyTerms !== null && product.supplyTerms !== undefined)
      .map((product) => categoryOf(buyer!, product).id),
  );

  const out: SupplyOffer[] = [];
  for (const company of activeCompanies(draft)) {
    if (company.id === buyerCompanyId) continue;
    for (const product of activeProducts(company)) {
      const terms = product.supplyTerms;
      if (terms === null || terms === undefined) continue;
      const category = categoryOf(company, product);
      if (category.id !== inputCategoryId || !category.canSupply) continue;
      if (terms.blockedCustomerIds.includes(buyerCompanyId)) continue;
      if (!terms.openToAll && !terms.exclusiveCustomerIds.includes(buyerCompanyId)) continue;
      out.push({
        company,
        product,
        pricePerUnitUsd: terms.pricePerUnitUsd,
        qualityScore: product.qualityScore,
        isDirectRival: buyerSuppliesSameCategory.has(category.id),
      });
    }
  }
  // Best quality per dollar first, ties by id: one deterministic order every
  // caller — the NPC policy and this lookup — reads the same way.
  out.sort((a, b) => {
    const scoreA = ratio(a.qualityScore, Math.max(1, a.pricePerUnitUsd));
    const scoreB = ratio(b.qualityScore, Math.max(1, b.pricePerUnitUsd));
    if (scoreB !== scoreA) return scoreB - scoreA;
    return a.company.id < b.company.id ? -1 : a.company.id > b.company.id ? 1 : 0;
  });
  return out;
}

/** One buyer drawing on a supplying line this quarter. */
export interface SupplyCustomer {
  readonly buyerCompany: Company;
  readonly buyerProduct: Product;
  readonly unitsFilled: number;
  readonly revenueUsd: number;
}

/** Every company currently building on `supplierProductId`, for the supplier's own "customers" lookup. */
export function customersFor(draft: SessionState, supplierCompanyId: string, supplierProductId: string): SupplyCustomer[] {
  const out: SupplyCustomer[] = [];
  for (const entry of resolveSupplyLedger(draft)) {
    if (entry.supplierCompany.id !== supplierCompanyId || entry.supplierProduct.id !== supplierProductId) continue;
    out.push({ buyerCompany: entry.buyerCompany, buyerProduct: entry.buyerProduct, unitsFilled: entry.unitsFilled, revenueUsd: entry.costUsd });
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/*  Applying this quarter's choose_supplier and set_supply_terms              */
/* -------------------------------------------------------------------------- */

function supplyLineOf(product: Product, inputCategoryId: string) {
  return (product.supply ?? []).find((entry) => entry.inputCategoryId === inputCategoryId) ?? null;
}

function setSupplyLine(
  product: Product,
  inputCategoryId: string,
  supplierCompanyId: string | null,
  supplierProductId: string | null,
  cutOffNoticeQuarter: number | null,
): void {
  const lines = product.supply ?? [];
  const existingIndex = lines.findIndex((entry) => entry.inputCategoryId === inputCategoryId);
  const line = { inputCategoryId, supplierCompanyId, supplierProductId, cutOffNoticeQuarter };
  if (existingIndex >= 0) lines[existingIndex] = line;
  else lines.push(line);
  product.supply = lines;
}

/**
 * Apply this quarter's `set_supply_terms` and `choose_supplier` actions, and
 * run the one-quarter notice a cut-off buyer is owed. Called from
 * `resolveProducts`, before demand — the same two-phase contract
 * `resolveComputeOrders` and `resolveCapacityOrders` use.
 *
 * Returns the `${productId}|${inputCategoryId}` keys of every line that
 * pointed at a different supplier before this quarter began, for
 * `categoryEffectiveQuality`'s switching-cost discount.
 */
export function resolveSupplyOrders(draft: SessionState, ctx: ResolverContext): ReadonlySet<string> {
  const switched = new Set<string>();
  if (!isMultiSectorWorld(draft)) return switched;

  /* --- notices that have run their term: drop to unsupplied ---------------- */
  for (const company of activeCompanies(draft)) {
    for (const product of activeProducts(company)) {
      for (const line of product.supply ?? []) {
        if (line.cutOffNoticeQuarter === null || line.cutOffNoticeQuarter > ctx.quarter) continue;
        const supplierId = line.supplierCompanyId;
        line.supplierCompanyId = null;
        line.supplierProductId = null;
        line.cutOffNoticeQuarter = null;
        const eventId = emitEvent(
          draft,
          ctx,
          'cost_recognised',
          company.id,
          supplierId,
          { kind: 'supply_cut_off', productId: product.id, inputCategoryId: line.inputCategoryId, formerSupplierCompanyId: supplierId },
          'company',
        );
        const supplierName = draft.companies.find((candidate) => candidate.id === supplierId)?.name ?? 'its supplier';
        ctx.log({
          phase: 'product_demand_resolution',
          text: `${company.name}'s ${product.name} lost ${supplierName} as its ${line.inputCategoryId.replace(/_/g, ' ')} supplier, as notified last quarter.`,
          deltaLabel: 'cut off',
          refEventIds: [eventId],
          tone: 'warning',
          subjectId: company.id,
        });
      }
    }
  }

  /* --- set_supply_terms: publish, reprice, close ---------------------------- */
  for (const company of activeCompanies(draft)) {
    const actions = companyActions(draft, ctx, company.id);
    for (const { intent } of intentsOfType(actions, 'set_supply_terms')) {
      const product = company.products.find((candidate) => candidate.id === intent.productId);
      if (product === undefined) continue;
      const category = categoryOf(company, product);
      if (!category.canSupply) continue; // structurally refused by the validator; belt and braces here
      const before = product.supplyTerms ?? null;
      const wasPublished = before !== null;
      product.supplyTerms = { ...intent.terms };

      // A customer this line already serves who is newly blocked, or newly
      // excluded by a narrowed exclusiveCustomerIds, gets one quarter of
      // notice rather than an instant cut — resolveSupplyLedger and every
      // demand this quarter still sees them as supplied.
      if (wasPublished) {
        for (const buyer of activeCompanies(draft)) {
          for (const buyerProduct of activeProducts(buyer)) {
            for (const line of buyerProduct.supply ?? []) {
              if (line.supplierCompanyId !== company.id || line.supplierProductId !== product.id || line.cutOffNoticeQuarter !== null) continue;
              const stillAllowed =
                !intent.terms.blockedCustomerIds.includes(buyer.id) &&
                (intent.terms.openToAll || intent.terms.exclusiveCustomerIds.includes(buyer.id));
              if (stillAllowed) continue;
              line.cutOffNoticeQuarter = ctx.quarter + SUPPLY_CUT_OFF_NOTICE_QUARTERS;
              const noticeId = emitEvent(
                draft,
                ctx,
                'cost_recognised',
                company.id,
                buyer.id,
                { kind: 'supply_terms_changed', productId: product.id, buyerCompanyId: buyer.id, buyerProductId: buyerProduct.id, noticeQuarter: line.cutOffNoticeQuarter },
                'company',
              );
              ctx.log({
                phase: 'product_demand_resolution',
                text: `${company.name} is closing ${product.name} to ${buyer.name}; the cut takes effect in ${SUPPLY_CUT_OFF_NOTICE_QUARTERS} quarter.`,
                deltaLabel: 'notice given',
                refEventIds: [noticeId],
                tone: 'warning',
                subjectId: buyer.id,
              });
            }
          }
        }
      }

      const eventId = emitEvent(
        draft,
        ctx,
        'cost_recognised',
        company.id,
        null,
        {
          kind: wasPublished ? 'supply_terms_changed' : 'supply_started',
          productId: product.id,
          openToAll: intent.terms.openToAll,
          pricePerUnitUsd: intent.terms.pricePerUnitUsd,
          beforePricePerUnitUsd: before?.pricePerUnitUsd ?? null,
        },
        // Publishing a public API is exactly the kind of move rivals and the
        // market should see happen.
        'public',
      );
      ctx.log({
        phase: 'product_demand_resolution',
        text: wasPublished
          ? `${company.name} repriced ${product.name} as a supply line to ${usdLabel(intent.terms.pricePerUnitUsd)} a unit.`
          : `${company.name} published ${product.name} as a supply line at ${usdLabel(intent.terms.pricePerUnitUsd)} a unit${intent.terms.openToAll ? ', open to all' : ''}.`,
        deltaLabel: intent.terms.openToAll ? 'open API' : 'private terms',
        refEventIds: [eventId],
        tone: 'neutral',
        subjectId: company.id,
      });
    }
  }

  /* --- choose_supplier: build on, or switch away from, an input ------------- */
  for (const company of activeCompanies(draft)) {
    const actions = companyActions(draft, ctx, company.id);
    for (const { intent } of intentsOfType(actions, 'choose_supplier')) {
      const product = company.products.find((candidate) => candidate.id === intent.productId);
      if (product === undefined) continue;
      const before = supplyLineOf(product, intent.inputCategoryId);
      const changed = before?.supplierCompanyId !== intent.supplierCompanyId || before?.supplierProductId !== intent.supplierProductId;
      if (!changed) continue;

      setSupplyLine(product, intent.inputCategoryId, intent.supplierCompanyId, intent.supplierProductId, null);
      if (before !== null && before.supplierCompanyId !== null) switched.add(`${product.id}|${intent.inputCategoryId}`);

      const supplierName =
        intent.supplierCompanyId === null ? 'the open market' : draft.companies.find((candidate) => candidate.id === intent.supplierCompanyId)?.name ?? intent.supplierCompanyId;
      const eventId = emitEvent(
        draft,
        ctx,
        'cost_recognised',
        company.id,
        intent.supplierCompanyId,
        {
          kind: before === null || before.supplierCompanyId === null ? 'supply_started' : 'supply_switched',
          productId: product.id,
          inputCategoryId: intent.inputCategoryId,
          fromSupplierCompanyId: before?.supplierCompanyId ?? null,
          toSupplierCompanyId: intent.supplierCompanyId,
        },
        'company',
      );
      ctx.log({
        phase: 'product_demand_resolution',
        text: `${company.name} built ${product.name}'s ${intent.inputCategoryId.replace(/_/g, ' ')} on ${supplierName}${before?.supplierCompanyId !== null && before?.supplierCompanyId !== undefined ? ', switching away from its previous supplier' : ''}.`,
        deltaLabel: 'supplier set',
        refEventIds: [eventId],
        tone: 'neutral',
        subjectId: company.id,
      });
    }
  }

  return switched;
}

/* -------------------------------------------------------------------------- */
/*  Deterministic NPC policy                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The supplier an archetype default would choose for one input: the best
 * quality-per-dollar offer that is not a direct rival in the same category
 * unless nothing else is on offer, sticky when the buyer's current choice is
 * still live and not materially worse than the best available.
 *
 * Pure and deterministic — the same state always names the same supplier.
 */
export function chooseSupplierDefault(
  draft: SessionState,
  buyer: Company,
  product: Product,
  input: ProductCategoryInput,
): { supplierCompanyId: string; supplierProductId: string } | null {
  const offers = suppliersFor(draft, buyer.id, input.categoryId);
  if (offers.length === 0) return null;

  const nonRival = offers.filter((offer) => !offer.isDirectRival);
  const pool = nonRival.length > 0 ? nonRival : offers;

  const current = resolveSupplyLine(draft, buyer, product, input);
  if (current.status === 'supplied' && current.supplierCompany !== null && current.supplierProduct !== null) {
    const stillOffered = pool.find((offer) => offer.company.id === current.supplierCompany?.id && offer.product.id === current.supplierProduct?.id);
    // Sticky: an existing choice is kept unless something in the pool is
    // meaningfully better on quality per dollar — "unless a materially
    // better option appears".
    if (stillOffered !== undefined) {
      const currentScore = ratio(stillOffered.qualityScore, Math.max(1, stillOffered.pricePerUnitUsd));
      const bestScore = ratio(pool[0]!.qualityScore, Math.max(1, pool[0]!.pricePerUnitUsd));
      if (bestScore <= currentScore * 1.15) return { supplierCompanyId: stillOffered.company.id, supplierProductId: stillOffered.product.id };
    }
  }

  const best = pool[0];
  return best === undefined ? null : { supplierCompanyId: best.company.id, supplierProductId: best.product.id };
}

/** The open supply terms an archetype default publishes for a canSupply line it has not published yet. */
export function defaultSupplyTerms(category: ProductCategory): { openToAll: boolean; pricePerUnitUsd: number; exclusiveCustomerIds: string[]; blockedCustomerIds: string[] } {
  return { openToAll: true, pricePerUnitUsd: money(category.referencePriceUsd * NPC_DEFAULT_SUPPLY_MARGIN), exclusiveCustomerIds: [], blockedCustomerIds: [] };
}
