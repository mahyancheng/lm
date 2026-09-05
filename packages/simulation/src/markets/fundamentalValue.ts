/**
 * @frontier/simulation — markets/fundamentalValue.ts
 *
 * What a company is worth on its reported numbers, in world version 2.
 *
 * ```text
 * multiple = lerp(sectorBand.low, sectorBand.high, quality) x marketIndex
 * value    = trailingRevenue x multiple  +  max(0, netCash)
 * ```
 *
 * `quality` is the only judgement in it, and it is made of two things a player
 * can see on their own Financials screen: how fast revenue is growing and where
 * gross margin sits inside the band its sector supports. A logistics company at
 * 18% margin growing 4% a year prices near 1x sales; an AI company at 74% margin
 * growing 60% prices near 24x. That range is the whole point — it is why a
 * multi-sector world cannot be priced with one multiple.
 *
 * Three properties are load-bearing and are pinned by the tests:
 *
 * 1. **The multiple stays inside its sector's band**, widened only by the
 *    market index and never past `MULTIPLE_INDEX_BOUNDS`. A bubble lifts every
 *    multiple; it does not turn a freight network into a frontier laboratory.
 * 2. **A pre-revenue company returns `null`.** There is no trailing revenue to
 *    multiply, so the anchor falls back to the method the valuation module
 *    already chose for it — option value, usually — instead of pricing at zero.
 * 3. **The result is whole dollars.** Every figure the player reads is
 *    decimal-free, and a valuation that ends in 37 cents is noise pretending to
 *    be precision.
 */

import type { Company, SessionState } from '@frontier/contracts';
import { sectorMarginBand, sectorOf, sectorRevenueMultipleBand } from '../economy/sectors';
import { clamp, clamp01, lerp } from '../economy/util';

/* -------------------------------------------------------------------------- */
/*  Balancing constants                                                        */
/* -------------------------------------------------------------------------- */

/** Year-on-year growth that alone carries a company to the top of its band. */
export const GROWTH_AT_TOP_OF_BAND = 0.6;

/** Growth at or below which growth alone puts a company at the bottom of it. */
export const GROWTH_AT_BOTTOM_OF_BAND = -0.1;

/** How much of the quality score growth accounts for; margin carries the rest. */
export const GROWTH_QUALITY_WEIGHT = 0.65;

/**
 * Bounds on the market-index multiplier applied on top of the sector band. The
 * world's `sectorMultiples` runs 0.2..6 and a market sector's own multiple runs
 * 0.1..10; multiplying both unbounded would let a euphoric quarter price a
 * company at eighty times sales.
 */
export const MULTIPLE_INDEX_BOUNDS = { min: 0.55, max: 2.2 } as const;

/** Confidence the market places in an anchor built from reported fundamentals. */
export const FUNDAMENTAL_CONFIDENCE = { min: 0.45, max: 0.85 } as const;

/** Below this trailing revenue there is nothing to multiply. */
export const MIN_TRAILING_REVENUE_USD = 1_000_000;

/* -------------------------------------------------------------------------- */
/*  The model                                                                  */
/* -------------------------------------------------------------------------- */

/** Where a company sits between the bottom and the top of its sector band, 0..1. */
export function qualityScore(growthYoY: number, grossMarginPct: number, sector: Parameters<typeof sectorMarginBand>[0]): number {
  const growthSpan = GROWTH_AT_TOP_OF_BAND - GROWTH_AT_BOTTOM_OF_BAND;
  const growthPart = clamp01((clamp(growthYoY, -1, 5) - GROWTH_AT_BOTTOM_OF_BAND) / growthSpan);

  const band = sectorMarginBand(sector);
  const marginSpan = Math.max(1e-6, band.max - band.min);
  const marginPart = clamp01((clamp01(grossMarginPct) - band.min) / marginSpan);

  return clamp01(GROWTH_QUALITY_WEIGHT * growthPart + (1 - GROWTH_QUALITY_WEIGHT) * marginPart);
}

/** The market-wide and sector-specific index the band is scaled by. */
export function multipleIndex(state: SessionState, marketSectorId: string): number {
  const sector = state.sectors[marketSectorId];
  const raw = state.world.capitalMarkets.sectorMultiples * (sector?.multiple ?? 1);
  // Both inputs are indices around 1, so their product is too; a full pass
  // through would compound two bubbles into one absurd one.
  return clamp(Math.sqrt(Math.max(0.01, raw)), MULTIPLE_INDEX_BOUNDS.min, MULTIPLE_INDEX_BOUNDS.max);
}

/** The revenue multiple this company earns, inside its sector band and scaled by the market. */
export function sectorRevenueMultiple(state: SessionState, company: Company): number {
  const sector = sectorOf(company);
  const band = sectorRevenueMultipleBand(sector);
  const quality = qualityScore(company.fundamentals.revenueGrowthYoY, company.fundamentals.grossMarginPct, sector);
  const inBand = lerp(band[0], band[1], quality);
  return clamp(inBand * multipleIndex(state, company.sectorId), band[0] * MULTIPLE_INDEX_BOUNDS.min, band[1] * MULTIPLE_INDEX_BOUNDS.max);
}

/** A fundamentals-based valuation, or `null` when there is not enough revenue to build one. */
export interface FundamentalValue {
  readonly valueUsd: number;
  readonly multiple: number;
  readonly quality: number;
  readonly confidence: number;
  readonly trailingRevenueUsd: number;
  readonly netCashUsd: number;
}

/**
 * Value a company off its reported fundamentals. Returns `null` for a company
 * with no meaningful trailing revenue, which is the caller's signal to keep the
 * method-based anchor it already computed.
 */
export function fundamentalValueUsd(state: SessionState, company: Company): FundamentalValue | null {
  const trailing = company.fundamentals.revenueTtmUsd;
  if (!(trailing >= MIN_TRAILING_REVENUE_USD)) return null;

  const sector = sectorOf(company);
  const quality = qualityScore(company.fundamentals.revenueGrowthYoY, company.fundamentals.grossMarginPct, sector);
  const multiple = sectorRevenueMultiple(state, company);
  const netCash = company.financials.cash - company.financials.debt;

  // A listed company reports quarterly and a profitable one is easier to value,
  // so the market leans on the anchor harder in both cases.
  const confidence = clamp(
    FUNDAMENTAL_CONFIDENCE.min + 0.2 * quality + (company.isPublic ? 0.12 : 0) + (company.fundamentals.netIncomeTtmUsd > 0 ? 0.08 : 0),
    FUNDAMENTAL_CONFIDENCE.min,
    FUNDAMENTAL_CONFIDENCE.max,
  );

  return {
    valueUsd: Math.max(0, Math.round(trailing * multiple + Math.max(0, netCash))),
    multiple,
    quality,
    confidence,
    trailingRevenueUsd: trailing,
    netCashUsd: netCash,
  };
}
