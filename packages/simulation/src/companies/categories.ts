/**
 * @frontier/simulation — companies/categories.ts
 *
 * The engine-side bridge onto `@frontier/contracts`'s product category
 * catalogue: resolving a live product to its category, and reading a
 * company's non-compute capacity.
 *
 * Every function here is pure and total. `categoryOf` never returns
 * undefined — a product with no `categoryId` (every world-version-1 product,
 * and any product saved before this catalogue existed) derives one from its
 * company's sector and its own segment, and the derivation is never written
 * back onto the product: exactly the "derive on read" contract
 * `Product.categoryId`'s own doc comment promises.
 */

import type { CapacityKind, Company, Product, SessionState } from '@frontier/contracts';
import { DEFAULT_SECTOR, productCategoriesFor, resolveCategory, type ProductCategory } from '@frontier/contracts';
import { dependencySatisfied } from '../research/nodes';

/** The category a product resolves to. Total: always a real catalogue row. */
export function categoryOf(company: Company, product: Product): ProductCategory {
  return resolveCategory(product.categoryId ?? null, company.sector ?? DEFAULT_SECTOR, product.segment);
}

/** One line of `launchableLines`: a real catalogue row, and what stands in the way of it. */
export interface LaunchableLine {
  readonly category: ProductCategory;
  readonly locked: boolean;
  /** Frontier Map node ids still missing. Empty exactly when `locked` is false. */
  readonly missingNodeIds: readonly string[];
}

/**
 * Every product line in `company`'s own sector, open now or gated on
 * research — the same test `launchProduct`'s validator rule runs
 * (`dependencySatisfied` against `category.requiresNodeIds`), read here rather
 * than restated, so a line marked open here is a line the validator actually
 * accepts. Pure and total: an empty sector (none in the catalogue, which the
 * catalogue integrity test rules out) returns an empty list rather than
 * throwing.
 */
export function launchableLines(draft: SessionState, company: Company): readonly LaunchableLine[] {
  return productCategoriesFor(company.sector ?? DEFAULT_SECTOR).map((category) => {
    const missingNodeIds = category.requiresNodeIds.filter((nodeId) => !dependencySatisfied(draft, nodeId, company.id));
    return { category, locked: missingNodeIds.length > 0, missingNodeIds };
  });
}

/**
 * Cash invested in one non-compute capacity kind, in whole dollars. Zero for a
 * company that has never invested, and zero (never called) for "compute" and
 * "none", which are not built with `invest_capacity`.
 */
export function capacityUsd(company: Company, kind: Exclude<CapacityKind, 'compute' | 'none'>): number {
  const capacity = company.capacity;
  if (capacity === undefined) return 0;
  if (kind === 'plant') return capacity.plantUsd;
  if (kind === 'fleet') return capacity.fleetUsd;
  return capacity.gridUsd;
}
