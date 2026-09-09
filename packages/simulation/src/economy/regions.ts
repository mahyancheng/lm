/**
 * @frontier/simulation — economy/regions.ts
 *
 * Where a company is based, priced.
 *
 * `REGION_META` in `@frontier/contracts` states every regional difference as a
 * whole-number index around 100. This file is the only place those indices turn
 * into multipliers, and it applies each of them in exactly one place:
 *
 * | index                | multiplies                                          |
 * |----------------------|-----------------------------------------------------|
 * | `talentCostIndex`    | the compensation a role costs (`companies/hiring`) — and, from world version 3, the industry the company is in rides in through the same accessor rather than beside it |
 * | `energyCostIndex`    | the energy line of compute cost (`companies/financials`) — and, from world version 2, the energy sector's own goods price rides in through the same accessor rather than beside it |
 * | `procurementAppetite`| how often competitions open (`government`)           |
 * | `capitalDepth`       | how readily a round clears (`resolver/capital`)       |
 * | `sectorAffinities`   | new demand for a company in that sector (`companies/products`) |
 *
 * Applying an index twice would compound it, which is why each one has a single
 * named accessor and a single call site.
 *
 * Every function returns exactly `1` for a world-version-1 session, so a legacy
 * save replays byte-identically.
 */

import type { Company, SessionState } from '@frontier/contracts';
import { DEFAULT_REGION, REGION_INDEX_BASELINE, regionMeta, regionSectorAffinity, sectorPriceIndex, type Region } from '@frontier/contracts';
import { clamp } from './util';
import { isMultiSectorWorld, isNodeEconomyWorld, sectorOf } from './sectors';

/* -------------------------------------------------------------------------- */
/*  Bounds                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Hard bounds on any region multiplier. The table itself never reaches these —
 * the widest index in `REGION_META` is 150 — so they exist to contain a future
 * table entry rather than today's, and to make the clamp explicit at the point
 * of use.
 */
export const REGION_FACTOR_BOUNDS = { min: 0.4, max: 2 } as const;

/**
 * How much of a sector-affinity gap reaches demand. An affinity of 145 in East
 * Asian manufacturing is a real advantage, but not a 45% one: half of it lands,
 * so the best region for a sector sells about 22% more than the neutral one.
 */
export const AFFINITY_DEMAND_WEIGHT = 0.5;

/** An index around 100 as a plain multiplier around 1, bounded. */
function factor(index: number): number {
  return clamp(index / REGION_INDEX_BASELINE, REGION_FACTOR_BOUNDS.min, REGION_FACTOR_BOUNDS.max);
}

/** The region a company is based in, total even for a save that predates the field. */
export function regionOf(company: Company): Region {
  return company.region ?? DEFAULT_REGION;
}

/* -------------------------------------------------------------------------- */
/*  The five accessors                                                         */
/* -------------------------------------------------------------------------- */

/** What an engineer costs here relative to the session baseline. Higher is dearer. */
export function regionTalentCostFactor(region: Region): number {
  return factor(regionMeta(region).talentCostIndex);
}

/** What a megawatt-hour costs here relative to the session baseline. */
export function regionEnergyCostFactor(region: Region): number {
  return factor(regionMeta(region).energyCostIndex);
}

/** How much government work is on offer here relative to the session baseline. */
export function regionProcurementFactor(region: Region): number {
  return factor(regionMeta(region).procurementAppetite);
}

/** How deep local capital is relative to the session baseline. */
export function regionCapitalDepthFactor(region: Region): number {
  return factor(regionMeta(region).capitalDepth);
}

/** How well the region suits the sector, damped by `AFFINITY_DEMAND_WEIGHT`. */
export function regionSectorFitFactor(region: Region, sector: Parameters<typeof regionSectorAffinity>[1]): number {
  const raw = regionSectorAffinity(region, sector) / REGION_INDEX_BASELINE;
  return clamp(1 + AFFINITY_DEMAND_WEIGHT * (raw - 1), REGION_FACTOR_BOUNDS.min, REGION_FACTOR_BOUNDS.max);
}

/* -------------------------------------------------------------------------- */
/*  Company-scoped wrappers (the ones the phases call)                         */
/* -------------------------------------------------------------------------- */

/**
 * What a sector's payroll costs relative to the frontier AI labour market.
 *
 * `MARKET_BASE_COMP_USD` is an AI-laboratory salary band — $380,000 for an
 * engineer, $620,000 for a researcher — and until world 3 every company in the
 * world converged on it, because `requiredCompUsd` reads the role and the
 * region and nothing else. In world 2 that was survivable: payroll was a
 * standing charge and nothing else read it. In world 3 the roll-up prices the
 * LABOUR IN A UNIT off `employees.avgComp`, so the same number decides whether
 * a line is above or below its own cost — and the node table's `labourPerUnit`
 * figures are struck against what the industry in question actually pays.
 *
 * Left sector-blind the two disagreed by up to eight times, and the disagreement
 * killed companies: a line-haul network seeded at a $100,000 average was dragged
 * toward $637,000 at eighteen percent a quarter, its labour line went from
 * $0.50 of a $2.35 parcel to $2.10 of it, and the business was under water by
 * its fourth quarter with no decision taken and nothing on any screen naming
 * why. A courier does not pay frontier-laboratory salaries, and after this it
 * does not have to.
 *
 * The ratios are the ordinary ones: a frontier laboratory pays multiples of a
 * haulier for the same seniority. AI is the numeraire at exactly 1, so nothing
 * about the AI backgrounds moves.
 *
 * World 3 only. Worlds 1 and 2 return exactly what they always returned.
 */
export const SECTOR_TALENT_COST_FACTOR: Readonly<Record<ReturnType<typeof sectorOf>, number>> = {
  ai: 1,
  robotics: 0.65,
  consumer: 0.45,
  manufacturing: 0.4,
  energy: 0.35,
  logistics: 0.25,
};

/**
 * Compensation multiplier for this company's region, and from world version 3
 * for the industry it is in. Exactly 1 in world version 1.
 */
export function companyTalentCostFactor(state: SessionState, company: Company): number {
  if (!isMultiSectorWorld(state)) return 1;
  const regional = regionTalentCostFactor(regionOf(company));
  return isNodeEconomyWorld(state) ? regional * SECTOR_TALENT_COST_FACTOR[sectorOf(company)] : regional;
}

/**
 * The regional energy basis as a whole-number index around 100: the energy
 * sector's own goods price, scaled by what a megawatt-hour costs here.
 *
 * This is the *only* place the energy price and the regional factor meet, which
 * is what stops the two compounding. `companyEnergyCostFactor` still has exactly
 * one call site, in `companies/financials.ts`; the sector price arrives through
 * it rather than beside it.
 */
export function regionalEnergyIndex(state: SessionState, region: Region): number {
  return Math.round(sectorPriceIndex(state, 'energy') * regionEnergyCostFactor(region));
}

/** Energy-cost multiplier for this company's region. Exactly 1 in world version 1. */
export function companyEnergyCostFactor(state: SessionState, company: Company): number {
  if (!isMultiSectorWorld(state)) return 1;
  return clamp(regionalEnergyIndex(state, regionOf(company)) / REGION_INDEX_BASELINE, REGION_FACTOR_BOUNDS.min, REGION_FACTOR_BOUNDS.max);
}

/** Capital-depth multiplier for this company's region. Exactly 1 in world version 1. */
export function companyCapitalDepthFactor(state: SessionState, company: Company): number {
  return isMultiSectorWorld(state) ? regionCapitalDepthFactor(regionOf(company)) : 1;
}

/** Sector-fit demand multiplier for this company. Exactly 1 in world version 1. */
export function companyRegionFitFactor(state: SessionState, company: Company): number {
  return isMultiSectorWorld(state) ? regionSectorFitFactor(regionOf(company), sectorOf(company)) : 1;
}

/**
 * The session's procurement appetite: the mean of every active company's region,
 * so a world whose companies sit mostly in high-appetite regions sees more
 * competitions open. Exactly 1 in world version 1, and 1 when nobody is left.
 */
export function sessionProcurementFactor(state: SessionState): number {
  if (!isMultiSectorWorld(state)) return 1;
  let sum = 0;
  let n = 0;
  for (const company of state.companies) {
    if (!company.isActive) continue;
    sum += regionProcurementFactor(regionOf(company));
    n += 1;
  }
  return n === 0 ? 1 : clamp(sum / n, REGION_FACTOR_BOUNDS.min, REGION_FACTOR_BOUNDS.max);
}
