/**
 * @frontier/simulation — companies/products.ts
 *
 * The product phase (`product_demand_resolution`, phase 10).
 *
 * Implements the demand model in `docs/ECONOMY.md` §2:
 *
 * ```text
 * grossAdds     = base × (1 + quality edge) × (1 - price effect) × reputation
 *                 × marketing lift
 * retained      = customers_t × (1 - churn)
 * customers_t+1 = min(retained + grossAdds,
 *                     grossAdds × capacityRatio
 *                       + retained × (1 - baseLossCeiling × (1 - capacityRatio)))
 * ```
 *
 * Two properties are load-bearing and are asserted by the tests:
 *
 * 1. **Capacity rations new demand outright and drains the base at a bounded
 *    rate.** A company that sells more inference than it can serve does not book
 *    the new demand; it books churn, and the quarter report carries a
 *    `capacity_constraint` line saying so. What it already has degrades instead
 *    of disappearing: a shortage costs at most `CAPACITY_BASE_LOSS_CEILING` of
 *    the retained base per quarter, so a company at zero serving compute falls
 *    steeply over a year rather than losing every customer in one quarter.
 * 2. **Elasticity is segment-shaped.** Consumers leave over a price rise
 *    (elasticity 1.6); governments barely react (0.4).
 *
 * ## Phase contract with `financial_resolution`
 *
 * This phase is the sole author of `company.financials.marketing` for the
 * quarter and writes it for every active company, launch spend included.
 */

import type { CapacityKind, Company, PredationRow, Product, ProductSegment, ProductSlotFill, ResolverContext, RivalPressureRow, SessionState } from '@frontier/contracts';
import {
  ANTITRUST_EXPOSURE_WEIGHTS,
  combinedPressure,
  isPredatoryPrice,
  makeId,
  nextPredatoryQuarters,
  predatorPressure,
  resolveCategory,
  undercutFraction,
  canProduce,
  economicNodeById,
  nodeMarketPriceUsd,
  primaryCustomerOf,
} from '@frontier/contracts';
import { isMultiSectorWorld, isNodeEconomyWorld } from '../economy/sectors';
import {
  BASELINE_COMPUTE_INTENSITY,
  CAPACITY_BASE_LOSS_CEILING,
  CAPACITY_SHORTFALL_CHURN,
  CLOUD_UNIT_COST_USD_PER_QUARTER,
  DEMAND_NOISE_BAND,
  MARKETING_HALF_SATURATION_FLOOR_USD,
  MARKETING_HALF_SATURATION_REVENUE_SHARE,
  MARKETING_MAX_LIFT,
  PRICE_CHURN_SENSITIVITY,
  PRICE_DEVIATION_BOUNDS,
  PRICE_FACTOR_BOUNDS,
  PRICE_MOVE_BAND,
  PRICE_SHOCK_CHURN,
  PRICE_SHOCK_CHURN_CEILING,
  QUALITY_CHURN_SENSITIVITY,
  QUALITY_DEMAND_SENSITIVITY,
  QUALITY_FACTOR_BOUNDS,
  REPUTATION_CHURN_SENSITIVITY,
  SEGMENT_BASE_ADD_RATE,
  SEGMENT_CHURN_BAND,
  SEGMENT_PRICE_ELASTICITY,
  SEGMENT_REFERENCE_PRICE_USD,
  SEGMENT_REPUTATION_AUDIENCE,
  SEGMENT_SEED_POOL,
  SERVE_CUSTOMERS_PER_ACCELERATOR,
} from './balance';
import { resolveComputeOrders } from './compute';
import { resolveCapacityOrders } from './capacity';
import { categoryEffectiveQuality, requiredInputUnsupplied, resolveSupplyOrders } from './supply';
import { categoryOf, capacityUsd } from './categories';
import { executiveDialsFor, marketingPlan } from './policy';
import { resolveNodeProduction, type StagedLineInputs } from '../graph/production';
import { cellOf, fillsOf, withFill } from '../graph/slots';
import { lineNodeIdOf, lineNodeOf } from '../graph/lines';
import { sectorEconomy, sectorOf } from '../economy/sectors';
import { companyRegionFitFactor } from '../economy/regions';
import {
  activeCompanies,
  activeProducts,
  capabilityIndex,
  clamp,
  companyActions,
  count,
  emitEvent,
  intentsOfType,
  money,
  pctLabel,
  ratio,
  score,
  sectorDemand,
  segmentFrontierQuality,
  segmentReferencePrice,
  segmentReputation,
  unit,
} from './util';

/* -------------------------------------------------------------------------- */
/*  Segment demand                                                             */
/* -------------------------------------------------------------------------- */

/**
 * How much appetite a segment has this quarter, 0..1 with 0.5 neutral. Blends
 * the company's sector demand with the world variables that segment actually
 * responds to.
 */
export function segmentDemand(draft: SessionState, sectorId: string, segment: ProductSegment): number {
  const world = draft.world;
  const sector = sectorDemand(draft, sectorId);
  if (segment === 'consumer') {
    return unit(0.45 * sector + 0.3 * world.macro.consumerDemand + 0.25 * world.society.consumerSentiment);
  }
  if (segment === 'enterprise') {
    return unit(0.5 * sector + 0.28 * unit(0.5 + world.macro.gdpGrowth * 6) + 0.22 * world.society.aiTrust);
  }
  if (segment === 'developer_api') {
    return unit(0.45 * sector + 0.33 * world.society.developerSentiment + 0.22 * world.aiFrontier.frontierCapability);
  }
  return unit(0.4 * sector + 0.35 * world.government.procurementBudget + 0.25 * world.government.digitalModernisation);
}

/* -------------------------------------------------------------------------- */
/*  Serving capacity                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Total accelerator-equivalents the company controls this quarter.
 *
 * A dollar of cloud spend buys fewer units from a dear provider than from a
 * cheap one, which is what makes choosing a counterparty worth doing: the
 * provider's own factor — its region's electricity and how hard its fleet is
 * already working — divides into the spend alongside the world's spot index.
 * Absent, as it always is in world version 1 and on capacity bought at the
 * index, the factor is exactly 1 and this is the arithmetic it always was.
 */
export function heldComputeUnits(draft: SessionState, company: Company): number {
  const compute = company.compute;
  const spot = draft.world.compute.spotPrice;
  const providerFactor = Math.max(0.1, compute.cloudProviderFactor ?? 1);
  const cloudUnits = ratio(compute.cloudSpendQuarterly, CLOUD_UNIT_COST_USD_PER_QUARTER * Math.max(0.1, spot) * providerFactor);
  return compute.ownedAccelerators + compute.reservedAccelerators + cloudUnits;
}

/**
 * Customers one accelerator-equivalent serves for a product of this compute
 * intensity, at the world's current serving cost index.
 */
export function customersPerUnit(draft: SessionState, computeIntensity: number): number {
  const inferenceCost = Math.max(0.1, draft.world.aiFrontier.inferenceCost);
  const intensity = Math.max(0.05, computeIntensity);
  return (SERVE_CUSTOMERS_PER_ACCELERATOR * (BASELINE_COMPUTE_INTENSITY / intensity)) / inferenceCost;
}

/** Accelerator-equivalents pointed at serving rather than training. */
export function servingComputeUnits(draft: SessionState, company: Company): number {
  return heldComputeUnits(draft, company) * (1 - unit(company.compute.trainingAllocation));
}

/* -------------------------------------------------------------------------- */
/*  Demand                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Marketing lift as a saturating function of spend behind one product, with the
 * saturation point scaled to the product's own revenue.
 */
export function marketingLift(spendUsd: number, productRevenueUsd: number): number {
  if (spendUsd <= 0) return 1;
  const half = Math.max(MARKETING_HALF_SATURATION_FLOOR_USD, productRevenueUsd * MARKETING_HALF_SATURATION_REVENUE_SHARE);
  return 1 + MARKETING_MAX_LIFT * (spendUsd / (spendUsd + half));
}

/**
 * How far a price sits from its segment reference, bounded. Beyond the bounds
 * the elasticity term stops responding: a product priced two orders of
 * magnitude away from its segment average is not competing on price, it is
 * selling something else.
 */
export function relativePrice(price: number, referencePrice: number): number {
  return clamp(ratio(price, referencePrice, 1) - 1, PRICE_DEVIATION_BOUNDS.min, PRICE_DEVIATION_BOUNDS.max);
}

/**
 * The price response multiplier for a segment: `1 - elasticity × (price/reference - 1)`.
 *
 * `elasticityOverride` lets world version 2 answer with a category's own
 * elasticity rather than its segment's — an accelerator line and a subscription
 * app can both sell into "enterprise" and still react to price completely
 * differently. Undefined falls back to the segment table, which is what world
 * version 1 always passes and is exactly the original arithmetic.
 */
export function priceFactor(segment: ProductSegment, price: number, referencePrice: number, elasticityOverride?: number): number {
  const elasticity = elasticityOverride ?? SEGMENT_PRICE_ELASTICITY[segment];
  return clamp(1 - elasticity * relativePrice(price, referencePrice), PRICE_FACTOR_BOUNDS.min, PRICE_FACTOR_BOUNDS.max);
}

/**
 * How violent a repricing was, measured in fourfoldings: 1 is a move to four
 * times the price, 2 is sixteen times. Unbounded above, because from world
 * version 2 nothing bounds the move itself — a price may go anywhere and the
 * consequence has to keep scaling with it. Price cuts are not a shock: nobody
 * leaves over a discount.
 */
export function priceMoveShock(beforeUsd: number, afterUsd: number): number {
  if (!(beforeUsd > 0) || !(afterUsd > beforeUsd)) return 0;
  return Math.log(afterUsd / beforeUsd) / Math.log(PRICE_MOVE_BAND.max);
}

/**
 * The same figure clamped to 0..1, which is what world version 1 measures: its
 * validator refuses any move past the top of the band, so a shock above 1 was
 * unreachable there and the clamp was free.
 */
export function priceShock(beforeUsd: number, afterUsd: number): number {
  return unit(priceMoveShock(beforeUsd, afterUsd));
}

/**
 * What is left of new demand at a price past the point the elasticity term
 * stops answering.
 *
 * `relativePrice` saturates at `PRICE_DEVIATION_BOUNDS.max`, so above that
 * price `priceFactor` is a constant and gross additions would not fall however
 * far the price rose — revenue (`customers x price`) would rise for nothing.
 * That was the reason for the validator's move band, and removing the band puts
 * the burden here instead.
 *
 * The decay is the *square* of how far past its onset the price sits, which is
 * the property that matters: new-customer revenue is `price x adds`, adds fall
 * as the square of the price, so revenue above the onset falls like `1/price`.
 * A founder who doubles an already-decaying price sells less, not more.
 * Exactly 1 at or below the onset, so a normally priced product is untouched.
 *
 * The onset is deliberately well past `PRICE_DEVIATION_BOUNDS.max`, the point
 * `priceFactor`'s own elasticity term goes flat — not the same point. A
 * product priced beyond that bound was already an ordinary, shipped shape of
 * this economy (a premium position `priceFactor` alone already prices in);
 * decaying it too would crush every quality-differentiated product's growth
 * every quarter it holds a stable premium, for no repricing at all. This is
 * the mechanism `set_product_price` needed once the validator stopped
 * refusing a move — a founder who walks a price to several times the
 * reference and holds it there, à la the owner's "a 6x price" example, not a
 * founder who has always sold at a defensible premium.
 */
const PRICE_SATURATION_DECAY_ONSET_MULTIPLE = 6;

export function priceSaturationDecay(priceUsd: number, referencePriceUsd: number): number {
  if (!(referencePriceUsd > 0) || !(priceUsd > 0)) return 1;
  const onset = PRICE_DEVIATION_BOUNDS.max * PRICE_SATURATION_DECAY_ONSET_MULTIPLE;
  const deviation = priceUsd / referencePriceUsd - 1;
  if (deviation <= onset) return 1;
  const ratio = onset / deviation;
  return ratio * ratio;
}

/**
 * The demand multiplier a quality edge earns, bounded.
 *
 * Extracted rather than inlined so the world-3 node pass runs the *same*
 * arithmetic on a node's own frontier instead of a second copy of it. World 1
 * and world 2 call it at exactly the inputs they always did.
 */
export function qualityFactorOf(qualityEdge: number): number {
  return clamp(1 + QUALITY_DEMAND_SENSITIVITY * qualityEdge, QUALITY_FACTOR_BOUNDS.min, QUALITY_FACTOR_BOUNDS.max);
}

/** The demand multiplier a reputation score earns, on the same contract. */
export function reputationFactorOf(reputation: number): number {
  return 0.5 + 0.7 * (reputation / 100);
}

/**
 * Churn for a product this quarter, inside the segment's design band — except
 * after a price rise, which is the one thing that moves customers faster than
 * the band allows.
 *
 * The elasticity term above saturates at `PRICE_DEVIATION_BOUNDS`, so without
 * this a company could raise its price every quarter and keep most of its
 * customers, and revenue (`customers × price`) would rise without limit. A
 * shock big enough to leave the model's defined range takes the base with it,
 * and from world version 2 the shock is unbounded, so there is no size of move
 * that escapes the consequence.
 */
export function productChurn(
  segment: ProductSegment,
  qualityEdge: number,
  priceEdge: number,
  reputation: number,
  capacityShortfall: number,
  shock = 0,
  churnBandOverride?: { readonly min: number; readonly max: number },
  elasticityOverride?: number,
): number {
  const band = churnBandOverride ?? SEGMENT_CHURN_BAND[segment];
  const elasticity = elasticityOverride ?? SEGMENT_PRICE_ELASTICITY[segment];
  const mid = (band.min + band.max) / 2;
  // The churn term scales with the whole size of the move; the ceiling term is
  // an interpolation and stays on 0..1. In world version 1 no shock above 1 is
  // reachable, so the two are the same number and nothing there moves.
  const scaled = Math.max(0, shock);
  const bounded = unit(shock);
  const raw =
    mid -
    QUALITY_CHURN_SENSITIVITY * qualityEdge +
    PRICE_CHURN_SENSITIVITY * elasticity * priceEdge -
    REPUTATION_CHURN_SENSITIVITY * (reputation / 100 - 0.5) * 2 +
    CAPACITY_SHORTFALL_CHURN * capacityShortfall +
    PRICE_SHOCK_CHURN * scaled;
  // The band is where a healthy or leaking product sits; a genuinely broken one
  // is allowed to run above it, but never below the segment floor. A repriced
  // one is allowed to run right up to a near-total walkout.
  const ordinaryCeiling = Math.max(band.max * 2, 0.6);
  const ceiling = ordinaryCeiling + (PRICE_SHOCK_CHURN_CEILING - ordinaryCeiling) * bounded;
  return clamp(raw, band.min * 0.5, ceiling);
}

/* -------------------------------------------------------------------------- */
/*  Phase                                                                      */
/* -------------------------------------------------------------------------- */

interface DemandDraft {
  readonly product: Product;
  readonly desiredCustomers: number;
  readonly grossAdds: number;
  readonly churn: number;
  readonly retained: number;
  /**
   * How much of this line's own capacity kind desired demand would consume:
   * accelerator-equivalents for "compute" (as it always was), otherwise
   * dollar-equivalents of the category's own capacityKind bucket — the same
   * unit `capacityUsd(company, kind) / 1_000_000` is expressed in, so the two
   * sides of the ratio always agree. Zero and unused for "none".
   */
  readonly unitsRequired: number;
  readonly capacityKind: CapacityKind;
  readonly marketingUsd: number;
  /** True when a required input has no live supplier: the product ships zero units this quarter. */
  readonly supplyBlocked: boolean;
}

const EMPTY_SWITCHED_LINES: ReadonlySet<string> = new Set();

/** What the action pass leaves behind for the demand pass. */
interface StagedProduct {
  readonly plan: ReturnType<typeof marketingPlan>;
  /** How hard each product was repriced this quarter, for the churn model. */
  readonly shockByProduct: ReadonlyMap<string, number>;
  /** `${productId}|${inputCategoryId}` keys that switched supplier this quarter, for the quality discount. */
  readonly switchedSupplierLines: ReadonlySet<string>;
}

/** Demand a company loses to rivals dumping in its segments, keyed `companyId|segment`. */
type PressureMap = ReadonlyMap<string, { readonly pct: number; readonly from: readonly string[] }>;

const NO_PRESSURE: PressureMap = new Map();

/** Everything about a quarter that is not the product itself. */
interface DemandInputs {
  /** The price the product is being demanded at — its own, or a candidate. */
  readonly priceUsd: number;
  /** Marketing dollars behind this product this quarter. */
  readonly marketingUsd: number;
  /** The sector cycle, upstream supply and regional fit, as one multiplier. */
  readonly sectorDemandFactor: number;
  /** The seeded demand draw, or 1 for a forecast, which has no RNG. */
  readonly noise: number;
  /** What rivals dumping in this segment leave of new demand, 0..1. */
  readonly squeeze: number;
  /** How hard the product was repriced this quarter, for the churn model. */
  readonly shock: number;
}

/**
 * One product's demand for one quarter, before capacity rations it.
 *
 * The single definition of the demand model. The phase calls it with the
 * quarter's RNG draw and the real pressure map; `repriceForecast` calls it with
 * the draw fixed at 1 and no pressure, so the number a founder is shown on the
 * Products screen is produced by the same arithmetic that will produce the
 * number in the report. A second copy of this for previews is exactly how a
 * preview starts lying.
 */
function productDemandDraft(
  draft: SessionState,
  company: Company,
  product: Product,
  inputs: DemandInputs,
  switchedSupplierLines: ReadonlySet<string> = EMPTY_SWITCHED_LINES,
): DemandDraft {
  const segment = product.segment;
  // World 1 never resolves a category (isMultiSectorWorld is false), so every
  // one of these falls straight back to its SEGMENT_* constant and the
  // arithmetic below is byte-for-byte what it always was. World 2 resolves a
  // real category — a product's own if it launched with one, else the
  // deterministic sector/segment default — and uses that line's own numbers.
  const category = isMultiSectorWorld(draft) ? categoryOf(company, product) : null;
  const reference = segmentReferencePrice(draft, segment, category?.referencePriceUsd ?? SEGMENT_REFERENCE_PRICE_USD[segment]);
  const frontier = segmentFrontierQuality(draft, segment);
  const reputation = segmentReputation(company, SEGMENT_REPUTATION_AUDIENCE[segment]);
  const elasticity = category?.elasticity;
  const churnBand = category?.churnBand;

  // What a product built on chosen suppliers actually sells at: its own
  // quality blended with each live supplier's quality by the input's share.
  // Exactly `product.qualityScore` in world 1 and for any product with no
  // resolved inputs, so nothing here moves a number the demand model did not
  // already produce before supply chains existed.
  const quality = isMultiSectorWorld(draft) ? categoryEffectiveQuality(draft, company, product, switchedSupplierLines) : product.qualityScore;
  // A required input nobody has filled means the product cannot ship at all
  // this quarter: booked as zero units, with its own report line, rather than
  // refused — "realise, not refuse" extends to a founder who launched ahead
  // of a supplier.
  const supplyBlocked = isMultiSectorWorld(draft) && requiredInputUnsupplied(draft, company, product);

  const qualityEdge = quality - frontier;
  const priceEdge = relativePrice(inputs.priceUsd, reference);
  const qualityFactor = qualityFactorOf(qualityEdge);
  const price = priceFactor(segment, inputs.priceUsd, reference, elasticity);
  const reputationFactor = reputationFactorOf(reputation);
  const demand = segmentDemand(draft, company.sectorId, segment);
  const lift = marketingLift(inputs.marketingUsd, product.activeCustomers * inputs.priceUsd);

  // Past the point elasticity stops answering, new demand decays instead of
  // sitting flat: without this a price above saturation would add customers at
  // the same rate as one at the reference and revenue would rise for nothing.
  // Exactly 1 at or below saturation, and exactly 1 in world version 1, which
  // has a validator band instead.
  const saturation = isMultiSectorWorld(draft) ? priceSaturationDecay(inputs.priceUsd, reference) : 1;

  const base = (product.activeCustomers + (category?.seedPool ?? SEGMENT_SEED_POOL[segment])) * (category?.baseAddRate ?? SEGMENT_BASE_ADD_RATE[segment]);
  const grossAddsRaw = Math.max(
    0,
    base *
      (demand * 2) *
      qualityFactor *
      price *
      reputationFactor *
      lift *
      inputs.noise *
      inputs.sectorDemandFactor *
      inputs.squeeze *
      saturation,
  );

  const churn = supplyBlocked ? 1 : productChurn(segment, qualityEdge, priceEdge, reputation, 0, inputs.shock, churnBand, elasticity);
  const grossAdds = supplyBlocked ? 0 : grossAddsRaw;
  const retained = supplyBlocked ? 0 : product.activeCustomers * (1 - churn);
  const desired = retained + grossAdds;
  // "compute" is the only kind world 1 ever sees (category is always null
  // there), and it keeps the exact original accelerator-equivalents formula.
  // The other kinds are expressed in the same dollar-equivalent unit
  // `capacityUsd` reads capacity in: desired customers divided by how many a
  // million dollars of that kind serves.
  const capacityKind: CapacityKind = category?.capacityKind ?? 'compute';
  const unitsRequired =
    capacityKind === 'compute'
      ? desired / Math.max(1e-6, customersPerUnit(draft, product.computeIntensity))
      : capacityKind === 'none'
        ? 0
        : desired / Math.max(1e-6, category?.capacityYieldPerUnit ?? 1);
  return {
    product,
    desiredCustomers: desired,
    grossAdds,
    churn,
    retained,
    unitsRequired,
    capacityKind,
    marketingUsd: inputs.marketingUsd,
    supplyBlocked,
  };
}

/**
 * Resolve capacity, pricing, demand and churn for every product of every company.
 *
 * ## Why there are two shapes of this loop
 *
 * A price cut is an attack from world version 2 on, and an attack has to be
 * order-independent: whether Helion's dumping squeezes you must not depend on
 * whether Helion happens to sit before or after you in the company array. So the
 * multi-sector path stages **every** company's repricing first, then computes
 * the segment-wide pressures once, then resolves demand.
 *
 * World version 1 keeps the original single merged loop, byte for byte. Splitting
 * it there would change the order ledger rows are written in and, because
 * `segmentReferencePrice` reads every company's *current* price, would change the
 * numbers a frozen save replays to. The two paths call exactly the same two
 * functions in exactly the same per-company order, so the RNG sequence is
 * identical either way.
 */
export function resolveProducts(draft: SessionState, ctx: ResolverContext): void {
  const rng = ctx.rng;

  // Reservations, cloud commitments and the training split are applied before
  // anything reads serving capacity: capacity bought this quarter serves this
  // quarter's demand.
  resolveComputeOrders(draft, ctx);
  // Plant, fleet and grid investments, staged the same way for the same
  // reason: capacity built this quarter serves this quarter's demand. A no-op
  // in world version 1, which has no capacity kind but compute.
  resolveCapacityOrders(draft, ctx);
  // Suppliers chosen and terms published this quarter, on the same contract:
  // an input built on this quarter is an input this quarter's quality and
  // cost reflect. A no-op in world version 1, which has no product categories.
  const switchedSupplierLines = resolveSupplyOrders(draft, ctx);
  // World 3: slots filled and lines aimed this quarter, on the same contract —
  // a composition changed this quarter is the composition this quarter's cost
  // and quality are read off. A no-op below world 3.
  resolveCompositionOrders(draft, ctx);

  // Sector conditions are read by every company, so they are computed once:
  // building them per company would walk the whole company list per company.
  // Every multiplier is exactly 1 in world version 1.
  const economy = sectorEconomy(draft);
  const companies = activeCompanies(draft);

  if (!isMultiSectorWorld(draft)) {
    for (const company of companies) {
      resolveCompanyDemand(draft, ctx, rng, economy, company, applyProductActions(draft, ctx, company, switchedSupplierLines), NO_PRESSURE);
    }
    return;
  }

  const staged = new Map<string, StagedProduct>();
  for (const company of companies) staged.set(company.id, applyProductActions(draft, ctx, company, switchedSupplierLines));
  const pressure = resolvePredation(draft, ctx);

  // World 3: node lines are produced and sold by the node pass, which allocates
  // each node's order pool across everybody competing for it and therefore
  // cannot be run one company at a time. The world-2 demand model is not run
  // beside it — running both would be world 2's original defect, two demand
  // systems that never reconcile — so a world-3 product with no node simply
  // bills what it billed, and the scenario gives every line a node.
  if (isNodeEconomyWorld(draft)) {
    resolveNodeProduction(draft, ctx, stagedLineInputs(companies, staged));
    for (const company of companies) {
      for (const product of activeProducts(company)) {
        if (lineNodeIdOf(product) !== null) continue;
        product.unitsSoldQuarterly = count(product.activeCustomers);
      }
    }
    return;
  }

  for (const company of companies) {
    const own = staged.get(company.id);
    if (own === undefined) continue;
    resolveCompanyDemand(draft, ctx, rng, economy, company, own, pressure);
  }
}

/**
 * Flatten the per-company staging into the two per-product maps the node pass
 * reads, using the same marketing split the world-2 pass uses: a segment's plan
 * divided evenly across the products in it.
 */
function stagedLineInputs(companies: readonly Company[], staged: ReadonlyMap<string, StagedProduct>): StagedLineInputs {
  const marketingByProduct = new Map<string, number>();
  const shockByProduct = new Map<string, number>();
  for (const company of companies) {
    const own = staged.get(company.id);
    if (own === undefined) continue;
    const products = activeProducts(company);
    const perSegment: Record<string, number> = {};
    for (const product of products) perSegment[product.segment] = (perSegment[product.segment] ?? 0) + 1;
    for (const product of products) {
      marketingByProduct.set(product.id, (own.plan.bySegment[product.segment] ?? 0) / Math.max(1, perSegment[product.segment] ?? 1));
      shockByProduct.set(product.id, own.shockByProduct.get(product.id) ?? 0);
    }
  }
  return { marketingByProduct, shockByProduct };
}

/** Reprice, launch, sunset and set the marketing plan for one company. */
function applyProductActions(draft: SessionState, ctx: ResolverContext, company: Company, switchedSupplierLines: ReadonlySet<string>): StagedProduct {
  {
    const actions = companyActions(draft, ctx, company.id);

    /* --- repricing, launches and sunsets --------------------------------- */
    // How hard each product was repriced this quarter, for the churn model.
    const shockByProduct = new Map<string, number>();
    for (const { intent } of intentsOfType(actions, 'set_product_price')) {
      const product = company.products.find((p) => p.id === intent.productId);
      if (product === undefined) continue;
      const before = product.pricePerSeat;
      product.pricePerSeat = money(intent.pricePerSeatUsd);
      // World 1 measures the shock on 0..1 because its validator refused any
      // move past the top of the band. World 2 has no band, so the shock is
      // the whole size of the move and the churn model answers all of it.
      shockByProduct.set(
        product.id,
        isMultiSectorWorld(draft) ? priceMoveShock(before, product.pricePerSeat) : priceShock(before, product.pricePerSeat),
      );
      const eventId = emitEvent(
        draft,
        ctx,
        'price_changed',
        company.id,
        product.id,
        { productId: product.id, beforeUsd: before, afterUsd: product.pricePerSeat, segment: product.segment },
        'public',
      );
      ctx.log({
        phase: 'product_demand_resolution',
        text: `${company.name} repriced ${product.name} from $${before.toFixed(2)} to $${product.pricePerSeat.toFixed(2)} per unit.`,
        deltaLabel: pctLabel(ratio(product.pricePerSeat - before, before)),
        refEventIds: [eventId],
        tone: 'neutral',
        subjectId: company.id,
      });
    }

    for (const { intent } of intentsOfType(actions, 'launch_product')) {
      const capability = capabilityIndex(company);
      // The engine delivers the quality the team aimed for, discounted by what
      // the company can actually build.
      const delivered = unit(intent.targetQuality * (0.55 + 0.45 * capability));
      const id = makeId('prd', company.id, intent.name, ctx.quarter);
      if (company.products.some((p) => p.id === id)) continue;
      // World 1: no catalogue, so categoryId stays entirely absent from the
      // product and the frozen world never grows the key. World 2: the
      // validator has already resolved a real category id onto the intent
      // (its own choice, or the sector/segment default), so this is never null
      // here.
      const multiSector = isMultiSectorWorld(draft);
      // World 3 keys a line on a node, never on a category: `categoryId` on the
      // intent is read as a node id, which is unambiguous because the two id
      // spaces are disjoint (every node carries a res_/mat_/cmp_/sys_/svc_/
      // app_/dat_ prefix).
      const nodeId = isNodeEconomyWorld(draft) ? launchNodeIdFor(company, intent.categoryId ?? null, intent.segment) : null;
      const node = nodeId === null ? undefined : economicNodeById(nodeId);
      const category = multiSector && nodeId === null ? resolveCategory(intent.categoryId, company.sector, intent.segment) : null;
      const product: Product = {
        id,
        name: intent.name,
        segment: intent.segment,
        pricePerSeat: money(intent.pricePerSeatUsd),
        activeCustomers: 0,
        churnQuarterly: node?.churnBand.max ?? category?.churnBand.max ?? SEGMENT_CHURN_BAND[intent.segment].max,
        growthQuarterly: 0,
        grossMarginPct: 0.5,
        computeIntensity: unit(intent.computeIntensity),
        qualityScore: delivered,
        launchedQuarter: ctx.quarter,
        isActive: true,
      };
      if (node !== undefined) {
        product.nodeId = node.id;
        // The world-3 readings of the two world-2 levers. `qualityTier` is one
        // lever with both consequences: it scales the capacity a unit draws and
        // the quality delivered by the same factor, so a higher tier costs real
        // unit cost rather than a phantom margin.
        product.craftQuality = delivered;
        product.qualityTier = unit(intent.computeIntensity);
        product.unitsSoldQuarterly = 0;
        product.installedBase = 0;
        product.backlogUnits = 0;
        product.unitCostUsd = 0;
        product.contractBilledUsd = 0;
        if (node.saleKind === 'contract') product.contractRemainingQuarters = 0;
        // The composition lives on the product's slots, exactly as the launch
        // named it — the validator has already bounds-checked every choice
        // against the table and the world, and dropped what it could not
        // repair. Nothing is stamped as changed: a line's opening composition
        // is not a switch. The target industry is written only when aimed;
        // unaimed, `targetOf` reads the node's heaviest industry.
        const fills: ProductSlotFill[] = [];
        for (const entry of intent.slots) {
          if (!node.slots.some((slot) => slot.id === entry.slotId) || fills.some((fill) => fill.slotId === entry.slotId)) continue;
          fills.push({
            slotId: entry.slotId,
            nodeId: entry.nodeId,
            supplierCompanyId: entry.supplierCompanyId,
            supplierProductId: entry.supplierCompanyId === null ? null : entry.supplierProductId,
            cutOffNoticeQuarter: null,
            changedQuarter: null,
          });
        }
        product.slots = fills;
        if (intent.targetIndustry !== null) product.targetIndustry = intent.targetIndustry;
        product.supplyTerms = null;
      }
      if (category !== null) {
        product.categoryId = category.id;
        // Only entries that name one of this category's own inputs survive —
        // the validator has already checked the ones that do (a live company,
        // a live product, a matching category, open terms), so this is a
        // defensive filter, not a second validation pass.
        product.supply = intent.supply
          .filter((entry) => category.inputs.some((input) => input.categoryId === entry.inputCategoryId))
          .map((entry) => ({
            inputCategoryId: entry.inputCategoryId,
            supplierCompanyId: entry.supplierCompanyId,
            supplierProductId: entry.supplierProductId,
            cutOffNoticeQuarter: null,
          }));
        product.supplyTerms = null;
      }
      company.products.push(product);
      const eventId = emitEvent(
        draft,
        ctx,
        'product_launched',
        company.id,
        product.id,
        {
          productId: product.id,
          name: product.name,
          segment: product.segment,
          categoryId: category?.id ?? null,
          nodeId: node?.id ?? null,
          pricePerSeatUsd: product.pricePerSeat,
          targetQuality: intent.targetQuality,
          deliveredQuality: delivered,
          launchMarketingUsd: money(intent.launchMarketingUsd),
        },
        'public',
      );
      ctx.log({
        phase: 'product_demand_resolution',
        text: `${company.name} launched ${product.name}${node !== undefined ? ` (${node.label})` : category === null ? '' : ` (${category.label})`} into ${product.segment.replace(/_/g, ' ')} at quality ${(delivered * 100).toFixed(0)}.`,
        deltaLabel: `q ${(delivered * 100).toFixed(0)}`,
        refEventIds: [eventId],
        tone: delivered >= intent.targetQuality * 0.9 ? 'positive' : 'warning',
        subjectId: company.id,
      });
    }

    for (const { intent } of intentsOfType(actions, 'sunset_product')) {
      const product = company.products.find((p) => p.id === intent.productId);
      if (product === undefined || !product.isActive) continue;
      const lostCustomers = product.activeCustomers;
      product.isActive = false;
      product.activeCustomers = 0;
      product.growthQuarterly = -1;
      product.churnQuarterly = 1;
      // A short wind-down saves cost and is remembered by the people it stranded.
      const abruptness = 1 / intent.windDownQuarters;
      company.reputation.enterprise = score(company.reputation.enterprise - 6 * abruptness);
      company.reputation.developer = score(company.reputation.developer - 5 * abruptness);
      const eventId = emitEvent(
        draft,
        ctx,
        'product_sunset',
        company.id,
        product.id,
        { productId: product.id, windDownQuarters: intent.windDownQuarters, customersLost: lostCustomers },
        'public',
      );
      ctx.log({
        phase: 'product_demand_resolution',
        text: `${company.name} retired ${product.name} over ${intent.windDownQuarters} quarters, releasing ${lostCustomers} customers.`,
        deltaLabel: `-${lostCustomers}`,
        refEventIds: [eventId],
        tone: 'warning',
        subjectId: company.id,
      });
    }

    /* --- marketing plan --------------------------------------------------- */
    const plan = marketingPlan(company, actions, executiveDialsFor(draft, company));
    company.financials.marketing = money(plan.recurringUsd + plan.oneOffUsd);
    return { plan, shockByProduct, switchedSupplierLines };
  }
}

/**
 * Apply this quarter's `fill_slot` and `set_target_market` actions.
 *
 * Both are the founder's own decisions about their own line, already
 * bounds-checked by the validator; here they are written and recorded. A fill
 * that re-states the current composition writes nothing and emits nothing, so
 * a re-issued choice never restarts the switch cost. World 3 only.
 */
export function resolveCompositionOrders(draft: SessionState, ctx: ResolverContext): void {
  if (!isNodeEconomyWorld(draft)) return;
  for (const company of activeCompanies(draft)) {
    const actions = companyActions(draft, ctx, company.id);

    for (const { intent } of intentsOfType(actions, 'fill_slot')) {
      const product = company.products.find((candidate) => candidate.id === intent.productId && candidate.isActive);
      const node = product === undefined ? undefined : lineNodeOf(product);
      const slot = node?.slots.find((entry) => entry.id === intent.slotId);
      if (product === undefined || node === undefined || slot === undefined) continue;
      const before = fillsOf(product).find((entry) => entry.slotId === slot.id) ?? null;
      const written = withFill(fillsOf(product), slot.id, intent.nodeId, intent.supplierCompanyId, intent.supplierProductId, ctx.quarter);
      if (!written.changed) continue;
      product.slots = [...written.fills];
      const sourceName =
        intent.supplierCompanyId === null
          ? 'the open market'
          : intent.supplierCompanyId === company.id
            ? 'its own line'
            : (draft.companies.find((candidate) => candidate.id === intent.supplierCompanyId)?.name ?? intent.supplierCompanyId);
      const inputLabel = intent.nodeId === null ? 'nothing' : (economicNodeById(intent.nodeId)?.label ?? intent.nodeId);
      const eventId = emitEvent(
        draft,
        ctx,
        'slot_filled',
        company.id,
        intent.supplierCompanyId,
        {
          productId: product.id,
          nodeId: node.id,
          slotId: slot.id,
          inputNodeId: intent.nodeId,
          fromInputNodeId: before === null ? slot.defaultNodeId : before.nodeId,
          fromSupplierCompanyId: before?.supplierCompanyId ?? null,
          toSupplierCompanyId: intent.supplierCompanyId,
        },
        'company',
      );
      ctx.log({
        phase: 'product_demand_resolution',
        text:
          intent.nodeId === null
            ? `${company.name} left ${product.name}'s ${slot.label.toLowerCase()} slot empty.`
            : `${company.name} put ${inputLabel} from ${sourceName} in ${product.name}'s ${slot.label.toLowerCase()} slot${before !== null && (before.nodeId !== intent.nodeId || before.supplierCompanyId !== null) ? ', switching away from what it ran on' : ''}.`,
        deltaLabel: 'slot filled',
        refEventIds: [eventId],
        tone: 'neutral',
        subjectId: company.id,
      });
    }

    for (const { intent } of intentsOfType(actions, 'set_target_market')) {
      const product = company.products.find((candidate) => candidate.id === intent.productId && candidate.isActive);
      const node = product === undefined ? undefined : lineNodeOf(product);
      if (product === undefined || node === undefined) continue;
      const before = cellOf(product, node);
      product.segment = intent.segment;
      product.targetIndustry = intent.targetIndustry;
      const after = cellOf(product, node);
      if (before.industry === after.industry && before.customer === after.customer) continue;
      const eventId = emitEvent(
        draft,
        ctx,
        'target_market_set',
        company.id,
        product.id,
        {
          productId: product.id,
          nodeId: node.id,
          fromIndustry: before.industry,
          fromSegment: before.customer,
          toIndustry: after.industry,
          toSegment: after.customer,
        },
        'company',
      );
      ctx.log({
        phase: 'product_demand_resolution',
        text: `${company.name} aimed ${product.name} at ${after.customer === 'consumer' ? 'the public' : `${after.industry.replace(/_/g, ' ')} ${after.customer.replace(/_/g, ' ')} customers`}.`,
        deltaLabel: 'target set',
        refEventIds: [eventId],
        tone: 'neutral',
        subjectId: company.id,
      });
    }
  }
}

/**
 * The node a world-3 launch produces.
 *
 * The founder's own choice when they can actually make it, and otherwise the
 * best node they own that sells into the segment they asked for — never a
 * refusal, because "realise, not refuse" applies here too: a launch aimed at a
 * node the company cannot produce lands on the nearest one it can, and the
 * report says which. Null only when the company owns nothing at all, which the
 * scenario rules out.
 */
export function launchNodeIdFor(company: Company, requestedId: string | null, segment: ProductSegment): string | null {
  if (requestedId !== null && economicNodeById(requestedId) !== undefined && canProduce(company, requestedId)) return requestedId;
  const owned = (company.ownedNodes ?? []).filter((id) => canProduce(company, id));
  let best: string | null = null;
  let bestTier = -1;
  for (const id of owned) {
    const node = economicNodeById(id);
    if (node === undefined) continue;
    if (primaryCustomerOf(node) !== segment) continue;
    if (node.tier > bestTier) {
      best = id;
      bestTier = node.tier;
    }
  }
  if (best !== null) return best;
  // Nothing sells into that segment: the highest-tier thing they can make.
  for (const id of owned) {
    const node = economicNodeById(id);
    if (node === undefined) continue;
    if (node.tier > bestTier) {
      best = id;
      bestTier = node.tier;
    }
  }
  return best;
}

/** How far one capacity kind's rationing goes for a company this quarter. */
interface KindRationing {
  readonly capacityRatio: number;
  readonly baseRetention: number;
  readonly availableUnits: number;
  readonly requiredUnits: number;
}

/**
 * Ration every capacity kind a company's staged demand touches, one bucket per
 * kind. World 1 (and any world-2 product with no category) only ever produces
 * the "compute" kind, so this reduces to exactly the single-bucket arithmetic
 * the phase always ran: same `serving`, same `unitsRequired`, same
 * `capacityRatio`, same `baseRetention`. `repriceForecast` calls this too, so
 * the ratio a forecast shows and the ratio the resolved quarter applies are
 * the same function at the same inputs.
 */
function rationCapacityByKind(draft: SessionState, company: Company, drafts: readonly DemandDraft[]): ReadonlyMap<CapacityKind, KindRationing> {
  const requiredByKind = new Map<CapacityKind, number>();
  for (const d of drafts) requiredByKind.set(d.capacityKind, (requiredByKind.get(d.capacityKind) ?? 0) + d.unitsRequired);

  const out = new Map<CapacityKind, KindRationing>();
  for (const [kind, requiredUnits] of requiredByKind) {
    if (kind === 'none') {
      out.set(kind, { capacityRatio: 1, baseRetention: 1, availableUnits: Number.POSITIVE_INFINITY, requiredUnits });
      continue;
    }
    // A company that has never recorded a plant/fleet/grid position — never
    // invested, and not seeded with one — is not tracked yet, not tracked at
    // zero. Rationing it to nothing the instant a category resolves onto an
    // untracked kind would crush every company this mechanic reaches before
    // it, the seeded rivals of a promoted save included; "absent means the
    // neutral value" is the same rule the rest of this priced-economy block
    // reads by. Once `company.capacity` exists — seeded, or from a first
    // invest_capacity — the real balance rations exactly as compute does.
    const availableUnits =
      kind === 'compute'
        ? servingComputeUnits(draft, company)
        : company.capacity === undefined
          ? Number.POSITIVE_INFINITY
          : capacityUsd(company, kind) / 1_000_000;
    const capacityRatio = requiredUnits <= 0 ? 1 : Math.min(1, ratio(availableUnits, requiredUnits, 1));
    out.set(kind, { capacityRatio, baseRetention: 1 - CAPACITY_BASE_LOSS_CEILING * (1 - capacityRatio), availableUnits, requiredUnits });
  }
  return out;
}

/** Resolve one company's demand, capacity rationing and churn. */
function resolveCompanyDemand(
  draft: SessionState,
  ctx: ResolverContext,
  rng: ResolverContext['rng'],
  economy: ReturnType<typeof sectorEconomy>,
  company: Company,
  staged: StagedProduct,
  pressureMap: PressureMap,
): void {
  {
    const { plan, shockByProduct, switchedSupplierLines } = staged;
    const products = activeProducts(company);
    if (products.length === 0) return;

    /* --- desired demand, before capacity ---------------------------------- */
    const segmentProductCount: Record<string, number> = {};
    for (const product of products) {
      segmentProductCount[product.segment] = (segmentProductCount[product.segment] ?? 0) + 1;
    }

    // What the company's sector cycle, its upstream supply and its region's fit
    // for that sector do to new demand. One multiplier, applied once, to gross
    // additions only: churn is about the product, not about the weather.
    const sectorDemandFactor = economy[sectorOf(company)].demandMultiplier * companyRegionFitFactor(draft, company);

    const drafts: DemandDraft[] = [];
    for (const product of products) {
      const segment = product.segment;
      const share = (plan.bySegment[segment] ?? 0) / Math.max(1, segmentProductCount[segment] ?? 1);
      // The only stateful term, drawn here so the RNG sequence stays exactly
      // where it was: one draw per product, in product order.
      const noise = rng.range(DEMAND_NOISE_BAND.min, DEMAND_NOISE_BAND.max);
      drafts.push(
        productDemandDraft(
          draft,
          company,
          product,
          {
            priceUsd: product.pricePerSeat,
            marketingUsd: share,
            sectorDemandFactor,
            noise,
            // What rivals dumping in this segment took off the top. Exactly zero
            // when nobody is, and bounded to a quarter of new demand however many
            // of them there are.
            squeeze: 1 - (pressureMap.get(`${company.id}|${segment}`)?.pct ?? 0),
            shock: shockByProduct.get(product.id) ?? 0,
          },
          switchedSupplierLines,
        ),
      );
    }

    /* --- capacity constraint, one bucket per capacity kind ------------------ */
    // World 1 (and any world-2 product with no category) only ever produces
    // the "compute" bucket, so this is exactly the original single-bucket
    // rationing, unchanged in every number it produces.
    const rationing = rationCapacityByKind(draft, company, drafts);
    const constrained = [...rationing.values()].some((bucket) => bucket.capacityRatio < 0.999);

    let servedCustomers = 0;
    let lostToCapacity = 0;

    for (const d of drafts) {
      const product = d.product;
      const before = product.activeCustomers;
      const bucket = rationing.get(d.capacityKind);
      const capacityRatio = bucket?.capacityRatio ?? 1;
      const baseRetention = bucket?.baseRetention ?? 1;
      const allowed = Math.min(d.desiredCustomers, d.grossAdds * capacityRatio + d.retained * baseRetention);
      const shortfall = unit(ratio(d.desiredCustomers - allowed, Math.max(1, d.desiredCustomers)));
      // Demand that cannot be served is not deferred, it is lost — and it makes
      // the customers who stayed more likely to leave next quarter.
      const churn = shortfall > 0 ? Math.min(0.95, d.churn + CAPACITY_SHORTFALL_CHURN * shortfall) : d.churn;
      const after = count(allowed);

      lostToCapacity += Math.max(0, d.desiredCustomers - allowed);
      servedCustomers += after;

      product.activeCustomers = after;
      product.churnQuarterly = unit(churn);
      product.growthQuarterly = clamp(ratio(d.grossAdds, Math.max(1, before)), -1, 5);

      const revenue = after * product.pricePerSeat;
      const unitsUsed = after / Math.max(1e-6, customersPerUnit(draft, product.computeIntensity));
      const servingCost =
        unitsUsed * CLOUD_UNIT_COST_USD_PER_QUARTER * Math.max(0.1, draft.world.compute.spotPrice) * 0.6 +
        revenue * 0.04;
      product.grossMarginPct = unit(revenue <= 0 ? 0 : 1 - servingCost / revenue);

      const eventId = emitEvent(
        draft,
        ctx,
        'demand_resolved',
        company.id,
        product.id,
        {
          productId: product.id,
          segment: product.segment,
          customersBefore: before,
          customersAfter: after,
          grossAdds: Math.round(d.grossAdds),
          churn: product.churnQuarterly,
          revenueUsd: money(revenue),
          marketingUsd: money(d.marketingUsd),
          capacityConstrained: shortfall > 0,
          customersLostToCapacity: Math.round(Math.max(0, d.desiredCustomers - allowed)),
          // So a squeezed rival can see who is squeezing them.
          rivalPricePressurePct: Math.round((pressureMap.get(`${company.id}|${product.segment}`)?.pct ?? 0) * 100),
          pressureFrom: [...(pressureMap.get(`${company.id}|${product.segment}`)?.from ?? [])],
          supplyBlocked: d.supplyBlocked,
        },
        'company',
      );

      const change = ratio(after - before, Math.max(1, before));
      if (d.supplyBlocked) {
        ctx.log({
          phase: 'product_demand_resolution',
          text: `${product.name} shipped nothing this quarter: a required input has no live supplier. Choose one with choose_supplier, or use the open market.`,
          deltaLabel: '0 units',
          refEventIds: [eventId],
          tone: 'negative',
          subjectId: company.id,
        });
      } else if (shortfall > 0) {
        ctx.log({
          phase: 'product_demand_resolution',
          text: `capacity_constraint: ${company.name} could not serve ${Math.round(d.desiredCustomers - allowed)} customers of ${product.name}; the demand was lost and churn rose to ${(product.churnQuarterly * 100).toFixed(1)}%.`,
          deltaLabel: pctLabel(-shortfall),
          refEventIds: [eventId],
          tone: 'warning',
          subjectId: company.id,
        });
      } else if (Math.abs(change) >= 0.02) {
        ctx.log({
          phase: 'product_demand_resolution',
          text: `${product.name} moved from ${before} to ${after} customers at ${(product.churnQuarterly * 100).toFixed(1)}% churn.`,
          deltaLabel: pctLabel(change),
          refEventIds: [eventId],
          tone: change >= 0 ? 'positive' : 'negative',
          subjectId: company.id,
        });
      }
    }

    /* --- compute utilisation follows what was actually served -------------- */
    // Only "compute"-kind products draw on held compute: a plant, fleet or
    // grid line's customers are served by that other capacity kind and would
    // otherwise inflate this company's compute utilisation for free.
    const held = heldComputeUnits(draft, company);
    if (held > 0) {
      let unitsUsed = 0;
      for (const d of drafts) {
        if (d.capacityKind !== 'compute') continue;
        unitsUsed += d.product.activeCustomers / Math.max(1e-6, customersPerUnit(draft, d.product.computeIntensity));
      }
      const training = held * unit(company.compute.trainingAllocation);
      company.compute.computeUtilisation = unit(ratio(unitsUsed + training, held));
    }

    // One summary row per constrained capacity kind — "the same words it uses
    // for compute", now for whichever kind actually bound. World 1 only ever
    // has the "compute" bucket, so this reduces to exactly the one row it
    // always emitted.
    if (constrained && lostToCapacity > 0) {
      for (const [kind, bucket] of rationing) {
        if (bucket.capacityRatio >= 0.999) continue;
        emitEvent(
          draft,
          ctx,
          'cost_recognised',
          company.id,
          null,
          {
            kind: 'capacity_constraint',
            capacityKind: kind,
            servingUnits: bucket.availableUnits,
            unitsRequired: bucket.requiredUnits,
            capacityRatio: bucket.capacityRatio,
            customersLost: Math.round(lostToCapacity),
            customersServed: servedCustomers,
          },
          'company',
        );
      }
    }
  }
}

/* -------------------------------------------------------------------------- */
/*  Dumping and price wars                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The unclamped gross margin a hypothetical `customers` × `priceUsd` would run
 * at, for `product`'s own serving cost (compute intensity only — the product
 * itself is read for nothing else, so a forecast can call this at a candidate
 * price nobody has set yet).
 *
 * The general form `unclampedGrossMargin` and `repriceForecast` both call, so
 * a margin read off a live product and a margin read off a forecast are the
 * same arithmetic at different inputs, never two copies of it.
 */
function grossMarginAt(draft: SessionState, product: Product, customers: number, priceUsd: number): number {
  const revenue = customers * priceUsd;
  if (!(revenue > 0)) return 0;
  const unitsUsed = customers / Math.max(1e-6, customersPerUnit(draft, product.computeIntensity));
  const servingCost = unitsUsed * CLOUD_UNIT_COST_USD_PER_QUARTER * Math.max(0.1, draft.world.compute.spotPrice) * 0.6 + revenue * 0.04;
  return 1 - servingCost / revenue;
}

/**
 * The unclamped gross margin a product is running at.
 *
 * `Product.grossMarginPct` is a unit interval and is floored at zero, so the
 * stored figure can never say "below cost" — which is exactly half of the
 * predation test. This restates the serving-cost arithmetic the demand pass
 * books at the end of the quarter, without the clamp, so a product genuinely
 * selling under cost reads as negative.
 */
export function unclampedGrossMargin(draft: SessionState, product: Product): number {
  // World 3 has one margin model and this is it: the unit cost the roll-up
  // produced and the profit and loss booked, against the price actually
  // charged. The compute-only formula below it survives only for worlds 1 and
  // 2, which are frozen and must keep hashing to what they always hashed to.
  if (isNodeEconomyWorld(draft) && lineNodeIdOf(product) !== null) {
    const unitCost = product.unitCostUsd ?? 0;
    if (!(product.pricePerSeat > 0)) return 0;
    return 1 - unitCost / product.pricePerSeat;
  }
  return grossMarginAt(draft, product, product.activeCustomers, product.pricePerSeat);
}

/**
 * Flag predatory prices, step every company's predatory counter, and compute the
 * demand pressure each squeezed rival is under.
 *
 * Order-independent by construction: every product's undercut and flag is
 * computed first, then pressures are combined multiplicatively, so shuffling the
 * company array cannot change a single number. Pure except for the ledger rows
 * and the counters it writes; draws no random numbers.
 */
function resolvePredation(draft: SessionState, ctx: ResolverContext): PressureMap {
  const pressureMap = new Map<string, { pct: number; from: string[] }>();
  const predationRows: PredationRow[] = [];
  const pressureRows: RivalPressureRow[] = [];

  interface Candidate {
    readonly company: Company;
    readonly product: Product;
    readonly segment: ProductSegment;
    readonly reference: number;
    readonly undercut: number;
    readonly margin: number;
    readonly predatory: boolean;
  }

  const candidates: Candidate[] = [];
  const segmentCustomers = new Map<ProductSegment, number>();
  const companySegmentCustomers = new Map<string, number>();
  const companiesInSegment = new Map<ProductSegment, Set<string>>();

  // One reference per segment, not one per product: the reference is a walk over
  // every company, so computing it per product would be quadratic.
  const referenceBySegment = new Map<ProductSegment, number>();
  const segmentOf = (segment: ProductSegment): number => {
    const cached = referenceBySegment.get(segment);
    if (cached !== undefined) return cached;
    const computed = segmentReferencePrice(draft, segment, SEGMENT_REFERENCE_PRICE_USD[segment]);
    referenceBySegment.set(segment, computed);
    return computed;
  };

  const nodeEconomy = isNodeEconomyWorld(draft);
  for (const company of activeCompanies(draft)) {
    for (const product of activeProducts(company)) {
      const segment = product.segment;
      // A price is judged against its own node's market price in world 3, and
      // against the segment mean only where there is no node. The segment mean
      // is the customer-weighted average of every product in that buyer segment
      // across all six sectors — about $21,000 for enterprise — so judging a
      // wafer fab's undercut against it was never a statement about the wafer
      // market.
      const nodeId = nodeEconomy ? lineNodeIdOf(product) : null;
      const reference = nodeId === null ? segmentOf(segment) : nodeMarketPriceUsd(draft, nodeId);
      const undercut = undercutFraction(product.pricePerSeat, reference);
      const margin = unclampedGrossMargin(draft, product);
      candidates.push({ company, product, segment, reference, undercut, margin, predatory: isPredatoryPrice(margin, undercut) });

      segmentCustomers.set(segment, (segmentCustomers.get(segment) ?? 0) + product.activeCustomers);
      const key = `${company.id}|${segment}`;
      companySegmentCustomers.set(key, (companySegmentCustomers.get(key) ?? 0) + product.activeCustomers);
      const set = companiesInSegment.get(segment) ?? new Set<string>();
      set.add(company.id);
      companiesInSegment.set(segment, set);
    }
  }

  // One pressure per predator per segment: a predator running three dumped
  // products in one segment is one attacker, not three.
  const predatorPressureBySegment = new Map<ProductSegment, Map<string, number>>();
  for (const candidate of candidates) {
    if (!candidate.predatory) continue;
    const total = segmentCustomers.get(candidate.segment) ?? 0;
    const share = total <= 0 ? 0 : (companySegmentCustomers.get(`${candidate.company.id}|${candidate.segment}`) ?? 0) / total;
    const pressure = predatorPressure(share, candidate.undercut);
    const bucket = predatorPressureBySegment.get(candidate.segment) ?? new Map<string, number>();
    bucket.set(candidate.company.id, Math.max(bucket.get(candidate.company.id) ?? 0, pressure));
    predatorPressureBySegment.set(candidate.segment, bucket);
  }

  for (const [segment, predators] of predatorPressureBySegment) {
    const members = companiesInSegment.get(segment) ?? new Set<string>();
    for (const companyId of [...members].sort()) {
      const pressures: number[] = [];
      const from: string[] = [];
      for (const predatorId of [...predators.keys()].sort()) {
        if (predatorId === companyId) continue;
        const pressure = predators.get(predatorId) ?? 0;
        if (pressure <= 0) continue;
        pressures.push(pressure);
        from.push(predatorId);
      }
      if (pressures.length === 0) continue;
      const combined = combinedPressure(pressures);
      pressureMap.set(`${companyId}|${segment}`, { pct: combined, from });
      pressureRows.push({ companyId, segment, pressurePct: Math.round(combined * 100), fromCompanyIds: from.slice(0, 8), causeEventId: null });
    }
  }

  // Counters step for every active company, predator or not, so a company that
  // stopped dumping visibly cools off.
  const predatorIds = new Set(candidates.filter((candidate) => candidate.predatory).map((candidate) => candidate.company.id));
  for (const company of activeCompanies(draft)) {
    company.predatoryQuarters = nextPredatoryQuarters(company.predatoryQuarters ?? 0, predatorIds.has(company.id));
  }

  for (const candidate of candidates) {
    if (!candidate.predatory) continue;
    const eventId = emitEvent(
      draft,
      ctx,
      'predatory_pricing_flagged',
      candidate.company.id,
      candidate.product.id,
      {
        companyId: candidate.company.id,
        productId: candidate.product.id,
        segment: candidate.segment,
        price: money(candidate.product.pricePerSeat),
        referencePrice: money(candidate.reference),
        undercutPct: Math.round(candidate.undercut * 100),
        grossMarginPct: Math.round(candidate.margin * 100),
        predatoryQuarters: candidate.company.predatoryQuarters ?? 0,
        exposurePoints: ANTITRUST_EXPOSURE_WEIGHTS.predation,
      },
      // A price war is public by nature, and it should move belief.
      'public',
    );
    predationRows.push({
      companyId: candidate.company.id,
      productId: candidate.product.id,
      segment: candidate.segment,
      priceUsd: money(candidate.product.pricePerSeat),
      referencePriceUsd: money(candidate.reference),
      undercutPct: Math.round(candidate.undercut * 100),
      grossMarginPct: Math.round(candidate.margin * 100),
      predatoryQuarters: candidate.company.predatoryQuarters ?? 0,
      exposurePoints: ANTITRUST_EXPOSURE_WEIGHTS.predation,
      causeEventId: eventId,
    });
    ctx.log({
      phase: 'product_demand_resolution',
      text: `${candidate.company.name} is selling ${candidate.product.name} at $${candidate.product.pricePerSeat.toFixed(0)} against a segment average of $${candidate.reference.toFixed(
        0,
      )} and below cost: ${Math.round(candidate.undercut * 100)}% under the market, and ${ANTITRUST_EXPOSURE_WEIGHTS.predation} points of antitrust exposure a quarter.`,
      deltaLabel: `-${Math.round(candidate.undercut * 100)}%`,
      refEventIds: [eventId],
      tone: 'warning',
      subjectId: candidate.company.id,
    });
  }

  // Name the attacker on the squeezed company's own screen. `PRESSURE_MAX` is
  // small enough that a line only appears when it is worth reading.
  const nameById = new Map(draft.companies.map((company) => [company.id, company.name]));
  for (const row of pressureRows) {
    const cause = predationRows.find((entry) => row.fromCompanyIds.includes(entry.companyId))?.causeEventId ?? null;
    if (cause === null || row.pressurePct < 1) continue;
    row.causeEventId = cause;
    const attackers = row.fromCompanyIds.map((id) => nameById.get(id) ?? id).join(', ');
    ctx.log({
      phase: 'product_demand_resolution',
      text: `${attackers} cut below cost in ${row.segment.replace(/_/g, ' ')} and took ${row.pressurePct}% of ${nameById.get(row.companyId) ?? row.companyId}'s gross additions.`,
      deltaLabel: `-${row.pressurePct}%`,
      refEventIds: [cause],
      tone: 'negative',
      subjectId: row.companyId,
    });
  }

  if (draft.economyReport !== undefined && draft.economyReport !== null) {
    draft.economyReport = { ...draft.economyReport, predation: predationRows, rivalPressure: pressureRows };
  }

  return pressureMap;
}

/* -------------------------------------------------------------------------- */
/*  Reprice forecast                                                           */
/* -------------------------------------------------------------------------- */

/** What the engine expects one product to do at a price, before and after. */
export interface RepriceForecast {
  readonly productId: string;
  /** The price the product carries today. */
  readonly priceNowUsd: number;
  /** The price being considered. */
  readonly priceAfterUsd: number;
  readonly customersNow: number;
  readonly customersAfter: number;
  readonly revenueNowUsd: number;
  readonly revenueAfterUsd: number;
  /** Share of the base expected to leave in the quarter the move lands, 0..1. */
  readonly churnAfter: number;
  /** New customers expected in that quarter at the new price. */
  readonly grossAddsAfter: number;
  /** True when serving capacity, not demand, is what bounds the result. */
  readonly capacityConstrained: boolean;
  /** Gross margin at today's price and customer count. Unclamped: can run negative. */
  readonly marginNowPct: number;
  /** Gross margin the candidate price and its forecast customer count would run at. Unclamped. */
  readonly marginAfterPct: number;
}

/**
 * What repricing one product to `priceUsd` is expected to do, next quarter.
 *
 * Runs the demand model — the same `productDemandDraft` the phase runs, with
 * the same capacity rationing — twice: once at the price the product carries
 * and once at the candidate. The RNG term is fixed at its midpoint of 1 and
 * rival price pressure is left out, because neither is knowable while the
 * founder is still deciding; everything else is the engine's own arithmetic.
 *
 * Pure and read-only. Returns null when the product is not this company's or is
 * no longer selling.
 */
export function repriceForecast(session: SessionState, companyId: string, productId: string, priceUsd: number): RepriceForecast | null {
  const company = session.companies.find((candidate) => candidate.id === companyId);
  if (company === undefined) return null;
  const product = company.products.find((candidate) => candidate.id === productId);
  if (product === undefined || !product.isActive) return null;

  const products = activeProducts(company);
  const economy = sectorEconomy(session);
  const sectorDemandFactor = economy[sectorOf(company)].demandMultiplier * companyRegionFitFactor(session, company);
  // Marketing is spread evenly over what the company sells: the plan for the
  // open quarter is not settled yet, and pretending it is zero would understate
  // every forecast on the screen.
  const marketingUsd = products.length === 0 ? 0 : company.financials.marketing / products.length;
  const candidate = Math.max(0, priceUsd);
  const shock = isMultiSectorWorld(session)
    ? priceMoveShock(product.pricePerSeat, candidate)
    : priceShock(product.pricePerSeat, candidate);

  /** The whole company's demand with one product held at `priceFor`. */
  const run = (priceFor: (candidateProduct: Product) => number, shockFor: (candidateProduct: Product) => number): DemandDraft[] =>
    products.map((entry) =>
      productDemandDraft(session, company, entry, {
        priceUsd: priceFor(entry),
        marketingUsd,
        sectorDemandFactor,
        noise: 1,
        squeeze: 1,
        shock: shockFor(entry),
      }),
    );

  /**
   * Apply the phase's own per-kind capacity rationing and read this product's
   * line off its own bucket — the same `rationCapacityByKind` the resolved
   * quarter runs, so a forecast and the quarter it forecasts never disagree
   * about which capacity a line is even rationed against.
   */
  const settle = (drafts: DemandDraft[]): { customers: number; constrained: boolean } => {
    const own = drafts.find((entry) => entry.product.id === product.id);
    if (own === undefined) return { customers: 0, constrained: false };
    const bucket = rationCapacityByKind(session, company, drafts).get(own.capacityKind);
    const capacityRatio = bucket?.capacityRatio ?? 1;
    const baseRetention = bucket?.baseRetention ?? 1;
    const allowed = Math.min(own.desiredCustomers, own.grossAdds * capacityRatio + own.retained * baseRetention);
    return { customers: count(allowed), constrained: capacityRatio < 0.999 };
  };

  const now = settle(run((entry) => entry.pricePerSeat, () => 0));
  const afterDrafts = run(
    (entry) => (entry.id === product.id ? candidate : entry.pricePerSeat),
    (entry) => (entry.id === product.id ? shock : 0),
  );
  const after = settle(afterDrafts);
  const own = afterDrafts.find((entry) => entry.product.id === product.id);

  return {
    productId: product.id,
    priceNowUsd: product.pricePerSeat,
    priceAfterUsd: candidate,
    customersNow: now.customers,
    customersAfter: after.customers,
    revenueNowUsd: money(now.customers * product.pricePerSeat),
    revenueAfterUsd: money(after.customers * candidate),
    churnAfter: unit(own?.churn ?? 0),
    grossAddsAfter: count(own?.grossAdds ?? 0),
    capacityConstrained: after.constrained,
    // Unclamped on purpose: "a price cut is a price cut" extends to the margin
    // it produces, and a deep cut or a demand-collapsing rise can genuinely run
    // negative. The solvency clock is the consequence, not a clamp here.
    marginNowPct: grossMarginAt(session, product, now.customers, product.pricePerSeat),
    marginAfterPct: grossMarginAt(session, product, after.customers, candidate),
  };
}
