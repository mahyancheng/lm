/**
 * @frontier/simulation — companies/sellers.ts
 *
 * Every purchase has a counterparty.
 *
 * Compute used to be bought from a world index: a company paid the spot price
 * and the money left the economy. From world version 2 it is bought **from a
 * named company**, out of capacity that company actually holds, at a price its
 * own region and its own utilisation produce — and the money arrives in that
 * company's books in the same quarter it leaves the buyer's.
 *
 * Three markets, three kinds of seller:
 *
 * | Offering       | Sold by                                   | Bound on what they can sell |
 * |----------------|-------------------------------------------|-----------------------------|
 * | `cloud`        | infrastructure, cloud and chip companies  | capacity beyond their own use |
 * | `reservation`  | the same companies                        | the same capacity           |
 * | `accelerators` | manufacturers: chip makers, semiconductors| a quarter of fab output     |
 *
 * **World 3 answers the accelerator row differently, and that is the whole
 * redesign.** Who may sell an accelerator is not an archetype list and not a
 * sector list: it is *whoever owns `sys_ai_accelerator` and runs a line on it*.
 * What they may sell is what that line actually made last quarter, and what
 * they charge is the node's own market price — one price per node — times their
 * own region and load. `makesAccelerators`, `acceleratorOutputUnits` and the
 * three constants underneath them are therefore not on any world-3 path; they
 * stay for world 2, which is frozen and still runs on them.
 *
 * The seller list is **derived, never stored**: it is a function of who is
 * active, what they hold, and what they are using. Sorting is `price, then id`,
 * so "the cheapest seller with capacity" is one company and always the same one.
 *
 * World version 1 has no sellers at all. Nothing here is called from a world-1
 * path, and `sellersFor` returns an empty list for one, so the frozen world
 * keeps its index prices byte for byte.
 *
 * Determinism: no RNG, no clock, no mutation. Everything is a pure read of the
 * draft.
 */

import type { Company, ComputeOffering, SessionState } from '@frontier/contracts';
import { COMPUTE_CAPACITY_NODE_ID, holdsNode } from '@frontier/contracts';
import {
  ACCELERATOR_FAB_OUTPUT_SHARE,
  ACCELERATOR_SPOT_SHARE,
  ACCELERATOR_UNIT_PRICE_USD,
  CLOUD_UNIT_COST_USD_PER_QUARTER,
  MIN_ACCELERATOR_OUTPUT_UNITS,
  PPE_DEPRECIATION_PER_QUARTER,
  RESERVED_UNIT_COST_USD_PER_QUARTER,
} from './balance';
import { customersPerUnit, heldComputeUnits } from './products';
import { INFRASTRUCTURE_ARCHETYPES } from '../markets/valuation';
import { acceleratorListUsd, cloudRentUsd, lineNodeIdOf, reservedRentUsd } from '../graph/lines';
import { isMultiSectorWorld, isNodeEconomyWorld } from '../economy/sectors';
import { regionOf, regionalEnergyIndex } from '../economy/regions';
import { clamp, money, unit } from './util';

/* -------------------------------------------------------------------------- */
/*  Who sells what                                                             */
/* -------------------------------------------------------------------------- */

/** Sectors whose companies build hardware, whatever archetype they carry. */
export const MANUFACTURING_SECTORS: readonly string[] = ['semiconductors', 'manufacturing'];

/** Archetypes that make accelerators rather than merely running them. */
export const ACCELERATOR_SELLER_ARCHETYPES: readonly string[] = ['chip_maker'];

/**
 * True when this company builds accelerators somebody else could buy.
 *
 * WORLD 2 ONLY. An archetype is a label, not a capability, and asking a label
 * whether a company can make a chip is exactly the guesswork the node table
 * replaces. `sellsAcceleratorNode` is the world-3 answer.
 */
export function makesAccelerators(company: Company): boolean {
  return ACCELERATOR_SELLER_ARCHETYPES.includes(company.archetype) || MANUFACTURING_SECTORS.includes(company.sectorId);
}

/**
 * World 3: this company holds the accelerator node and is running a line on it.
 *
 * Both halves matter. Holding it without a line means it *could* build a fab
 * and has not; a line without holding it cannot exist, because the launch gate
 * asks `canProduce` — but a licence can lapse under a live line, and when it
 * does the company stops being a seller the same quarter.
 */
export function sellsAcceleratorNode(draft: SessionState, company: Company): boolean {
  if (!holdsNode(company, COMPUTE_CAPACITY_NODE_ID, draft.quarter)) return false;
  return company.products.some((product) => product.isActive && lineNodeIdOf(product) === COMPUTE_CAPACITY_NODE_ID);
}

/**
 * World 3: what that line actually shipped last quarter, which is the honest
 * statement of what it can ship this one. World 2 estimated output from a share
 * of plant valued at a designer list price (`acceleratorOutputUnits`); here the
 * line has a real run rate and there is nothing to estimate.
 */
export function acceleratorLineOutputUnits(company: Company): number {
  let units = 0;
  for (const product of company.products) {
    if (!product.isActive || lineNodeIdOf(product) !== COMPUTE_CAPACITY_NODE_ID) continue;
    units += Math.max(0, product.unitsSoldQuarterly ?? product.activeCustomers);
  }
  return Math.floor(units);
}

/** True when this company runs capacity somebody else could rent. */
export function rentsCapacity(company: Company): boolean {
  return INFRASTRUCTURE_ARCHETYPES.includes(company.archetype);
}

/* -------------------------------------------------------------------------- */
/*  What a seller is doing with its own fleet                                  */
/* -------------------------------------------------------------------------- */

/**
 * Accelerator-equivalents this company needs for itself: what its own live
 * products consume to serve their customers, plus whatever its split has
 * pointed at training.
 *
 * Uses `customersPerUnit` — the same helper the product phase serves demand
 * with — so a seller can never offer capacity the demand model is about to
 * claim back.
 */
export function ownComputeNeedUnits(draft: SessionState, company: Company): number {
  let serving = 0;
  for (const product of company.products) {
    if (!product.isActive || product.activeCustomers <= 0) continue;
    const per = customersPerUnit(draft, product.computeIntensity);
    if (per > 0) serving += product.activeCustomers / per;
  }
  const training = heldComputeUnits(draft, company) * unit(company.compute.trainingAllocation);
  return serving + training;
}

/** Capacity this company could rent out this quarter. Never negative. */
export function sellableCapacityUnits(draft: SessionState, company: Company): number {
  return Math.max(0, Math.floor(heldComputeUnits(draft, company) - ownComputeNeedUnits(draft, company)));
}

/**
 * Accelerators this manufacturer could ship this quarter. WORLD 2 ONLY.
 *
 * Bounded by its scale rather than by an inventory nobody models: a share of the
 * plant it carries, valued at list, scaled by the world's fabrication capacity.
 * A company with plant but no throughput can still ship the floor, so a small
 * fab is a slow seller rather than no seller at all.
 */
export function acceleratorOutputUnits(draft: SessionState, company: Company): number {
  const plant = Math.max(company.balanceSheet.assets.ppe, company.compute.ownedAccelerators * ACCELERATOR_UNIT_PRICE_USD);
  if (plant <= 0) return 0;
  const fab = clamp(draft.world.compute.fabCapacity, 0.1, 1);
  const units = Math.floor(((plant * ACCELERATOR_FAB_OUTPUT_SHARE) / ACCELERATOR_UNIT_PRICE_USD) * (0.5 + fab));
  return Math.max(MIN_ACCELERATOR_OUTPUT_UNITS, units);
}

/* -------------------------------------------------------------------------- */
/*  Price                                                                      */
/* -------------------------------------------------------------------------- */

/** How much of a seller's regional energy premium reaches its price. */
export const SELLER_ENERGY_WEIGHT = 0.5;
/** How much a seller's own utilisation reaches its price. A full fleet charges more. */
export const SELLER_UTILISATION_WEIGHT = 0.3;
/** Bounds on the per-seller factor, so no region and no load can double or halve a price. */
export const SELLER_FACTOR_BOUNDS = { min: 0.7, max: 1.5 } as const;

/**
 * The per-seller multiplier on every price this company quotes.
 *
 * ```text
 * factor = 1 + SELLER_ENERGY_WEIGHT      × (regionalEnergyIndex/100 - 1)
 *            + SELLER_UTILISATION_WEIGHT × (utilisation - 0.5)
 * ```
 *
 * Energy because a datacentre's marginal cost is electricity and electricity is
 * the one input priced locally; utilisation because a seller with a full fleet
 * is selling the last of it. Both are bounded, so sourcing is a comparison
 * between real differences rather than a search for one absurd outlier.
 */
export function sellerPriceFactor(draft: SessionState, seller: Company): number {
  const energy = regionalEnergyIndex(draft, regionOf(seller)) / 100;
  const load = unit(seller.compute.computeUtilisation);
  const raw = 1 + SELLER_ENERGY_WEIGHT * (energy - 1) + SELLER_UTILISATION_WEIGHT * (load - 0.5);
  return clamp(raw, SELLER_FACTOR_BOUNDS.min, SELLER_FACTOR_BOUNDS.max);
}

/**
 * Scarcity multiplier on a bought accelerator.
 *
 * Supply and fabrication capacity are both 0..1 with 0.5 neutral, and hardware
 * is the one purchase that waits on a fab, so both count equally:
 * `1.5 - mean(acceleratorSupply, fabCapacity)`, bounded to 0.6..1.5. A world in
 * shortage charges half as much again; an abundant one discounts to the floor.
 */
export function acceleratorSupplyFactor(draft: SessionState): number {
  const compute = draft.world.compute;
  const mean = (clamp(compute.acceleratorSupply, 0, 1) + clamp(compute.fabCapacity, 0, 1)) / 2;
  return clamp(1.5 - mean, 0.6, 1.5);
}

/**
 * What one accelerator costs from this seller, in whole dollars.
 *
 * ```text
 * price = ACCELERATOR_UNIT_PRICE_USD
 *       × (1 - ACCELERATOR_SPOT_SHARE + ACCELERATOR_SPOT_SHARE × world.compute.spotPrice)
 *       × acceleratorSupplyFactor(draft)
 *       × sellerPriceFactor(draft, seller)
 * ```
 *
 * Half the list price is contracted and half is this quarter's market; scarcity
 * multiplies the whole of it; and the seller's own region and load decide the
 * last few percent, which is what makes one manufacturer worth choosing over
 * another rather than all of them quoting the index.
 */
export function acceleratorUnitPriceUsd(draft: SessionState, seller: Company): number {
  // World 3: the node market has already priced this quarter's scarcity, once,
  // for everybody. Multiplying the spot index and the supply factor on top of
  // it would price the same shortage three times, so the only thing left to
  // apply is what makes one seller different from another.
  if (isNodeEconomyWorld(draft)) return money(acceleratorListUsd(draft) * sellerPriceFactor(draft, seller));
  const spot = 1 - ACCELERATOR_SPOT_SHARE + ACCELERATOR_SPOT_SHARE * draft.world.compute.spotPrice;
  return money(ACCELERATOR_UNIT_PRICE_USD * spot * acceleratorSupplyFactor(draft) * sellerPriceFactor(draft, seller));
}

/**
 * What one reserved accelerator-equivalent costs per quarter from this seller.
 * The rent is `reservedRentUsd` in every world — the node table's own answer in
 * world 3, the designer constant times the world index in worlds 1 and 2 — so
 * the price quoted here is always the price the buyer's books charge.
 */
export function reservationUnitPriceUsd(draft: SessionState, seller: Company): number {
  return money(reservedRentUsd(draft) * sellerPriceFactor(draft, seller));
}

/** What one accelerator-equivalent of on-demand cloud costs per quarter from this seller. */
export function cloudUnitPriceUsd(draft: SessionState, seller: Company): number {
  return money(cloudRentUsd(draft) * sellerPriceFactor(draft, seller));
}

/* -------------------------------------------------------------------------- */
/*  The market                                                                 */
/* -------------------------------------------------------------------------- */

/** One counterparty, priced, with what it could actually sell this quarter. */
export interface ComputeSeller {
  readonly company: Company;
  readonly offering: ComputeOffering;
  /** Purchase price for accelerators; price per unit per quarter for rent. */
  readonly unitPriceUsd: number;
  /** What the validator clamps an order to. */
  readonly sellableUnits: number;
  /** What one unit costs to hold for a quarter once bought: depreciation, or the rent itself. */
  readonly quarterlyCostPerUnitUsd: number;
  readonly energyFactorPct: number;
  readonly utilisationPct: number;
}

function sellerOf(draft: SessionState, company: Company, offering: ComputeOffering): ComputeSeller | null {
  const energyFactorPct = Math.round(regionalEnergyIndex(draft, regionOf(company)));
  const utilisationPct = Math.round(unit(company.compute.computeUtilisation) * 100);
  if (offering === 'accelerators') {
    const nodeEconomy = isNodeEconomyWorld(draft);
    if (!(nodeEconomy ? sellsAcceleratorNode(draft, company) : makesAccelerators(company))) return null;
    const price = acceleratorUnitPriceUsd(draft, company);
    return {
      company,
      offering,
      unitPriceUsd: price,
      sellableUnits: nodeEconomy ? acceleratorLineOutputUnits(company) : acceleratorOutputUnits(draft, company),
      quarterlyCostPerUnitUsd: money(price * PPE_DEPRECIATION_PER_QUARTER),
      energyFactorPct,
      utilisationPct,
    };
  }
  if (!rentsCapacity(company)) return null;
  const price = offering === 'cloud' ? cloudUnitPriceUsd(draft, company) : reservationUnitPriceUsd(draft, company);
  return {
    company,
    offering,
    unitPriceUsd: price,
    sellableUnits: sellableCapacityUnits(draft, company),
    quarterlyCostPerUnitUsd: price,
    energyFactorPct,
    utilisationPct,
  };
}

/**
 * Every company that could sell this offering this quarter, cheapest first,
 * ties broken by id.
 *
 * `exceptCompanyId` is the buyer: nobody sells to themselves, and a company that
 * did would book its own spend as its own revenue. Empty in world version 1.
 */
export function sellersFor(draft: SessionState, offering: ComputeOffering, exceptCompanyId: string | null): ComputeSeller[] {
  if (!isMultiSectorWorld(draft)) return [];
  const out: ComputeSeller[] = [];
  for (const company of draft.companies) {
    if (!company.isActive || company.id === exceptCompanyId) continue;
    const seller = sellerOf(draft, company, offering);
    if (seller === null || seller.sellableUnits <= 0) continue;
    out.push(seller);
  }
  out.sort((a, b) => a.unitPriceUsd - b.unitPriceUsd || (a.company.id < b.company.id ? -1 : a.company.id > b.company.id ? 1 : 0));
  return out;
}

/**
 * The largest seller in a market, for when nobody can fill the order whole.
 * Ties go to the cheaper, then to the lower id, so it is one company.
 */
function biggest(market: readonly ComputeSeller[]): ComputeSeller | null {
  let best: ComputeSeller | null = null;
  for (const seller of market) {
    if (best === null || seller.sellableUnits > best.sellableUnits) best = seller;
  }
  return best;
}

/**
 * Choose from a market that is already sorted cheapest-first.
 *
 * "Cheapest with capacity" means capacity *for this order*: a seller with two
 * units spare is not the cheapest supplier of a thousand, it is a seller who
 * cannot supply them. So the order goes to the cheapest company that could fill
 * it whole, and only when nobody can does it go to the largest, which the caller
 * then clamps down to. Both branches are total functions of the market, so the
 * validator and the resolver pick the same company.
 */
function chooseFrom(market: readonly ComputeSeller[], requestedId: string | null | undefined, neededUnits: number): ComputeSeller | null {
  if (market.length === 0) return null;
  if (typeof requestedId === 'string' && requestedId.length > 0) {
    const named = market.find((seller) => seller.company.id === requestedId);
    if (named !== undefined) return named;
  }
  if (neededUnits > 0) {
    const whole = market.find((seller) => seller.sellableUnits >= neededUnits);
    if (whole !== undefined) return whole;
    return biggest(market);
  }
  return market[0] ?? null;
}

/**
 * Resolve the counterparty for one units-denominated order.
 *
 * A named seller is honoured when it is still active, still in this market and
 * still has something to sell; anything else — a null, a wound-up company, a
 * consumer app that does not sell chips — falls through to the cheapest seller
 * that could fill the order. Deterministic in both directions, which is what
 * lets the validator, the resolver and the interface agree on who the money
 * went to.
 */
export function resolveComputeSeller(
  draft: SessionState,
  offering: ComputeOffering,
  requestedId: string | null | undefined,
  buyerCompanyId: string,
  neededUnits = 0,
): ComputeSeller | null {
  return chooseFrom(sellersFor(draft, offering, buyerCompanyId), requestedId, neededUnits);
}

/**
 * The same resolution for cloud, which is bought in dollars rather than units.
 *
 * How many units a spend buys depends on whose cloud it is, so the capacity test
 * has to be made per seller: a provider can fill the order when what it holds
 * spare, at its own price, is worth at least what is being spent.
 */
export function resolveCloudSeller(
  draft: SessionState,
  requestedId: string | null | undefined,
  buyerCompanyId: string,
  spendUsd: number,
): ComputeSeller | null {
  const market = sellersFor(draft, 'cloud', buyerCompanyId);
  if (market.length === 0) return null;
  if (typeof requestedId === 'string' && requestedId.length > 0) {
    const named = market.find((seller) => seller.company.id === requestedId);
    if (named !== undefined) return named;
  }
  if (spendUsd > 0) {
    const whole = market.find((seller) => seller.sellableUnits * seller.unitPriceUsd >= spendUsd);
    if (whole !== undefined) return whole;
    return biggest(market);
  }
  return market[0] ?? null;
}
