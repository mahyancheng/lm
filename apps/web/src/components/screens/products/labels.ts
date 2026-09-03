/**
 * Display vocabulary and small pure derivations for the Products screen.
 *
 * The derivations here restate arithmetic the engine documents — quarterly
 * revenue is price times seats, gross profit is revenue times the gross margin,
 * serving units come from `customersPerUnit`. Nothing is estimated.
 */

import type { CapacityKind, Company, Product, ProductSegment, Sector, SessionState } from '@frontier/contracts';
import { categoryOf, customersPerUnit } from '@frontier/simulation';

/** What a launch card calls the capacity a line is served from. */
export const CAPACITY_KIND_LABEL: Readonly<Record<CapacityKind, string>> = {
  compute: 'Compute',
  plant: 'Plant capacity',
  fleet: 'Fleet capacity',
  grid: 'Grid capacity',
  none: 'No capacity limit',
};

export const SEGMENT_LABEL: Readonly<Record<ProductSegment, string>> = {
  consumer: 'Consumer',
  enterprise: 'Enterprise',
  developer_api: 'Developer API',
  government: 'Government',
};

export const SEGMENT_UNIT: Readonly<Record<ProductSegment, string>> = {
  consumer: 'per seat / quarter',
  enterprise: 'per seat / quarter',
  developer_api: 'per million units',
  government: 'per seat / quarter',
};

export const SEGMENT_BLURB: Readonly<Record<ProductSegment, string>> = {
  consumer: 'Price-sensitive and quick to leave. Elasticity 1.6.',
  enterprise: 'Slow to move, expensive to win, sticky once won. Elasticity 0.7.',
  developer_api: 'Watches price per token and switches on documentation. Elasticity 1.2.',
  government: 'Barely notices price; notices reliability and audit. Elasticity 0.4.',
};

/** Quarterly revenue this product books at its current price and seat count. */
export function productRevenue(product: Product): number {
  return product.pricePerSeat * product.activeCustomers;
}

/** Gross profit after inference compute and support cost. */
export function productGrossProfit(product: Product): number {
  return productRevenue(product) * product.grossMarginPct;
}

/** Accelerator-equivalents this product's installed base consumes to be served. */
export function productServingUnits(session: SessionState, product: Product): number {
  const perUnit = customersPerUnit(session, product.computeIntensity);
  return perUnit <= 0 ? 0 : product.activeCustomers / perUnit;
}

export interface ProductIndustryGroup {
  readonly sector: Sector;
  readonly industryLine: string;
  readonly products: readonly Product[];
}

/**
 * `products` grouped by their category's `industryLine` (`categoryOf`), the
 * finer-grained lane a launch actually happened into — e.g. a single AI
 * company might carry both "Frontier models / LLM" and "Agents" lines.
 * Sorted by line name for a stable order. Only meaningful in world version 2;
 * callers gate this behind `isMultiSectorWorld` and fall back to an ungrouped
 * list in world 1, whose products have no real industry line to group by.
 */
export function productsByIndustryLine(company: Company, products: readonly Product[]): readonly ProductIndustryGroup[] {
  const groups = new Map<string, { sector: Sector; industryLine: string; products: Product[] }>();
  for (const product of products) {
    const category = categoryOf(company, product);
    const bucket = groups.get(category.industryLine) ?? { sector: category.sector, industryLine: category.industryLine, products: [] };
    bucket.products.push(product);
    groups.set(category.industryLine, bucket);
  }
  return [...groups.values()].sort((a, b) => a.industryLine.localeCompare(b.industryLine));
}

/**
 * Seat count `quarters` ahead if gross additions and churn both held exactly
 * where they are. A projection, and labelled as one wherever it renders: the
 * engine recomputes both rates every quarter from demand, price, quality,
 * reputation and serving capacity.
 */
export function projectCustomers(product: Product, quarters: number): number[] {
  const out: number[] = [product.activeCustomers];
  let running = product.activeCustomers;
  for (let index = 0; index < quarters; index += 1) {
    running = running * (1 + product.growthQuarterly) * (1 - product.churnQuarterly);
    out.push(Math.max(0, running));
  }
  return out;
}
