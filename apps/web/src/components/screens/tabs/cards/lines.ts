/**
 * The three lines the Company tab prints, chosen and priced.
 *
 * Pure: products in, rows out. It exists apart from the card so the choice —
 * *which* three, and what a line books — is testable against a real world-3
 * company rather than only against a fixture the card was handed.
 *
 * Nothing here computes an economic figure. The price is the price on the
 * product, the margin is the margin the engine wrote, and the revenue is the
 * same reading `NodeLineDrawer` prints — so a card and the drawer behind it can
 * never show two revenues for one line.
 */

import type { Product } from '@frontier/contracts';
import { economicNodeById } from '@frontier/contracts';
import { lineNodeIdOf } from '@frontier/simulation';
import type { LineRow } from './company-cards';

/** How many lines a card names before it stops and lets the sheet carry the rest. */
export const TOP_LINES = 3;

/**
 * What a line books this quarter.
 *
 * `unitsSoldQuarterly` where the node economy files one, the installed base
 * otherwise — exactly what the drawer prints.
 */
export function lineRevenueUsd(product: Product): number {
  return product.pricePerSeat * (product.unitsSoldQuarterly ?? product.activeCustomers);
}

/** Gross profit at the margin the engine wrote on the line. */
export function lineGrossProfitUsd(product: Product): number {
  return lineRevenueUsd(product) * product.grossMarginPct;
}

/**
 * The company's biggest lines, largest revenue first, at most `limit`.
 *
 * Ties break on the product id so the order never wobbles between renders — the
 * same rule the roster and the register orderings use.
 */
export function topLines(products: readonly Product[], limit: number = TOP_LINES): readonly LineRow[] {
  return products
    .filter((product) => product.isActive)
    .slice()
    .sort((a, b) => {
      const delta = lineRevenueUsd(b) - lineRevenueUsd(a);
      return delta !== 0 ? delta : a.id.localeCompare(b.id);
    })
    .slice(0, limit)
    .map((product) => {
      const nodeId = lineNodeIdOf(product);
      const node = nodeId === null ? undefined : economicNodeById(nodeId);
      return {
        productId: product.id,
        name: product.name,
        priceUsd: product.pricePerSeat,
        // Worlds 1 and 2 price a seat; world 3 prices the node's own unit.
        unitLabel: node?.unitLabel ?? 'seat',
        marginPct: product.grossMarginPct,
      };
    });
}
