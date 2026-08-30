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

import type { Company, Product, ProductSegment, ResolverContext, SessionState } from '@frontier/contracts';
import { makeId } from '@frontier/contracts';
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
import { marketingPlan } from './policy';
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

/** Total accelerator-equivalents the company controls this quarter. */
export function heldComputeUnits(draft: SessionState, company: Company): number {
  const compute = company.compute;
  const spot = draft.world.compute.spotPrice;
  const cloudUnits = ratio(compute.cloudSpendQuarterly, CLOUD_UNIT_COST_USD_PER_QUARTER * Math.max(0.1, spot));
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

/** The price response multiplier for a segment: `1 - elasticity × (price/reference - 1)`. */
export function priceFactor(segment: ProductSegment, price: number, referencePrice: number): number {
  return clamp(
    1 - SEGMENT_PRICE_ELASTICITY[segment] * relativePrice(price, referencePrice),
    PRICE_FACTOR_BOUNDS.min,
    PRICE_FACTOR_BOUNDS.max,
  );
}

/**
 * How violent a repricing was, 0..1, where 1 is a move to the top of the band
 * the validator allows in one quarter. Price cuts are not a shock: nobody leaves
 * over a discount.
 */
export function priceShock(beforeUsd: number, afterUsd: number): number {
  if (!(beforeUsd > 0) || !(afterUsd > beforeUsd)) return 0;
  return unit(Math.log(afterUsd / beforeUsd) / Math.log(PRICE_MOVE_BAND.max));
}

/**
 * Churn for a product this quarter, inside the segment's design band — except
 * after a price rise, which is the one thing that moves customers faster than
 * the band allows.
 *
 * The elasticity term above saturates at `PRICE_DEVIATION_BOUNDS`, so without
 * this a company could raise its price to the top of the validator's band every
 * quarter and keep most of its customers, and revenue (`customers × price`)
 * would rise without limit. A shock big enough to leave the model's defined
 * range takes the base with it.
 */
export function productChurn(
  segment: ProductSegment,
  qualityEdge: number,
  priceEdge: number,
  reputation: number,
  capacityShortfall: number,
  shock = 0,
): number {
  const band = SEGMENT_CHURN_BAND[segment];
  const mid = (band.min + band.max) / 2;
  const bounded = unit(shock);
  const raw =
    mid -
    QUALITY_CHURN_SENSITIVITY * qualityEdge +
    PRICE_CHURN_SENSITIVITY * SEGMENT_PRICE_ELASTICITY[segment] * priceEdge -
    REPUTATION_CHURN_SENSITIVITY * (reputation / 100 - 0.5) * 2 +
    CAPACITY_SHORTFALL_CHURN * capacityShortfall +
    PRICE_SHOCK_CHURN * bounded;
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
  readonly unitsRequired: number;
  readonly marketingUsd: number;
}

/** Resolve capacity, pricing, demand and churn for every product of every company. */
export function resolveProducts(draft: SessionState, ctx: ResolverContext): void {
  const rng = ctx.rng;

  // Reservations, cloud commitments and the training split are applied before
  // anything reads serving capacity: capacity bought this quarter serves this
  // quarter's demand.
  resolveComputeOrders(draft, ctx);

  for (const company of activeCompanies(draft)) {
    const actions = companyActions(draft, ctx, company.id);

    /* --- repricing, launches and sunsets --------------------------------- */
    // How hard each product was repriced this quarter, for the churn model.
    const shockByProduct = new Map<string, number>();
    for (const { intent } of intentsOfType(actions, 'set_product_price')) {
      const product = company.products.find((p) => p.id === intent.productId);
      if (product === undefined) continue;
      const before = product.pricePerSeat;
      product.pricePerSeat = money(intent.pricePerSeatUsd);
      shockByProduct.set(product.id, priceShock(before, product.pricePerSeat));
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
      const product: Product = {
        id,
        name: intent.name,
        segment: intent.segment,
        pricePerSeat: money(intent.pricePerSeatUsd),
        activeCustomers: 0,
        churnQuarterly: SEGMENT_CHURN_BAND[intent.segment].max,
        growthQuarterly: 0,
        grossMarginPct: 0.5,
        computeIntensity: unit(intent.computeIntensity),
        qualityScore: delivered,
        launchedQuarter: ctx.quarter,
        isActive: true,
      };
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
          pricePerSeatUsd: product.pricePerSeat,
          targetQuality: intent.targetQuality,
          deliveredQuality: delivered,
          launchMarketingUsd: money(intent.launchMarketingUsd),
        },
        'public',
      );
      ctx.log({
        phase: 'product_demand_resolution',
        text: `${company.name} launched ${product.name} into ${product.segment.replace(/_/g, ' ')} at quality ${(delivered * 100).toFixed(0)}.`,
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
    const plan = marketingPlan(company, actions);
    company.financials.marketing = money(plan.recurringUsd + plan.oneOffUsd);

    const products = activeProducts(company);
    if (products.length === 0) continue;

    /* --- desired demand, before capacity ---------------------------------- */
    const segmentProductCount: Record<string, number> = {};
    for (const product of products) {
      segmentProductCount[product.segment] = (segmentProductCount[product.segment] ?? 0) + 1;
    }

    const drafts: DemandDraft[] = [];
    for (const product of products) {
      const segment = product.segment;
      const reference = segmentReferencePrice(draft, segment, SEGMENT_REFERENCE_PRICE_USD[segment]);
      const frontier = segmentFrontierQuality(draft, segment);
      const audience = SEGMENT_REPUTATION_AUDIENCE[segment];
      const reputation = segmentReputation(company, audience);

      const qualityEdge = product.qualityScore - frontier;
      const priceEdge = relativePrice(product.pricePerSeat, reference);
      const qualityFactor = clamp(
        1 + QUALITY_DEMAND_SENSITIVITY * qualityEdge,
        QUALITY_FACTOR_BOUNDS.min,
        QUALITY_FACTOR_BOUNDS.max,
      );
      const price = priceFactor(segment, product.pricePerSeat, reference);
      const reputationFactor = 0.5 + 0.7 * (reputation / 100);
      const demand = segmentDemand(draft, company.sectorId, segment);
      const share = (plan.bySegment[segment] ?? 0) / Math.max(1, segmentProductCount[segment] ?? 1);
      const lift = marketingLift(share, product.activeCustomers * product.pricePerSeat);
      const noise = rng.range(DEMAND_NOISE_BAND.min, DEMAND_NOISE_BAND.max);

      const base = (product.activeCustomers + SEGMENT_SEED_POOL[segment]) * SEGMENT_BASE_ADD_RATE[segment];
      const grossAdds = Math.max(0, base * (demand * 2) * qualityFactor * price * reputationFactor * lift * noise);

      const churn = productChurn(segment, qualityEdge, priceEdge, reputation, 0, shockByProduct.get(product.id) ?? 0);
      const retained = product.activeCustomers * (1 - churn);
      const desired = retained + grossAdds;
      drafts.push({
        product,
        desiredCustomers: desired,
        grossAdds,
        churn,
        retained,
        unitsRequired: desired / Math.max(1e-6, customersPerUnit(draft, product.computeIntensity)),
        marketingUsd: share,
      });
    }

    /* --- capacity constraint ---------------------------------------------- */
    const serving = servingComputeUnits(draft, company);
    let unitsRequired = 0;
    for (const d of drafts) unitsRequired += d.unitsRequired;
    const capacityRatio = unitsRequired <= 0 ? 1 : Math.min(1, ratio(serving, unitsRequired, 1));
    const constrained = capacityRatio < 0.999;
    // What is left of the retained base after a shortage. New demand is rationed
    // by the capacity ratio outright; the base only degrades, and never by more
    // than `CAPACITY_BASE_LOSS_CEILING` in one quarter, so losing the compute
    // starts a collapse instead of finishing one.
    const baseRetention = 1 - CAPACITY_BASE_LOSS_CEILING * (1 - capacityRatio);

    let servedCustomers = 0;
    let lostToCapacity = 0;

    for (const d of drafts) {
      const product = d.product;
      const before = product.activeCustomers;
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
        },
        'company',
      );

      const change = ratio(after - before, Math.max(1, before));
      if (shortfall > 0) {
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
    const held = heldComputeUnits(draft, company);
    if (held > 0) {
      let unitsUsed = 0;
      for (const product of activeProducts(company)) {
        unitsUsed += product.activeCustomers / Math.max(1e-6, customersPerUnit(draft, product.computeIntensity));
      }
      const training = held * unit(company.compute.trainingAllocation);
      company.compute.computeUtilisation = unit(ratio(unitsUsed + training, held));
    }

    if (constrained && lostToCapacity > 0) {
      emitEvent(
        draft,
        ctx,
        'cost_recognised',
        company.id,
        null,
        {
          kind: 'capacity_constraint',
          servingUnits: serving,
          unitsRequired,
          capacityRatio,
          customersLost: Math.round(lostToCapacity),
          customersServed: servedCustomers,
        },
        'company',
      );
    }
  }
}
