/**
 * Display vocabulary and small pure derivations for the Products screen.
 *
 * The derivations here restate arithmetic the engine documents — quarterly
 * revenue is price times seats, gross profit is revenue times the gross margin,
 * serving units come from `customersPerUnit`. Nothing is estimated.
 */

import type { Product, ProductSegment, SessionState } from '@frontier/contracts';
import { customersPerUnit } from '@frontier/simulation';

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
