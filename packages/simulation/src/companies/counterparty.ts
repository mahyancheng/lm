/**
 * @frontier/simulation — companies/counterparty.ts
 *
 * The other side of every compute bill.
 *
 * `computeCost` charges a company for the capacity it holds. That charge used to
 * disappear: money left the buyer and arrived nowhere, because compute was
 * bought from a price index rather than from a company. From world version 2 it
 * is bought from a named seller, and this module is what turns the buyer's cost
 * into that seller's revenue **in the same quarter, for exactly the same
 * figure**.
 *
 * The rule that keeps it honest: *nothing here re-charges the buyer.* Each leg
 * restates a charge `computeCost` has already made — reserved units at the
 * reserved index times the provider's factor, cloud spend at the spot index —
 * and each accelerator purchase restates what the compute phase staged. The
 * seller books it as revenue; the buyer's own books are untouched by this file.
 *
 * A seller that has since been wound up is skipped rather than credited: a
 * balance sheet that no longer exists cannot recognise revenue, and the buyer's
 * cost stands either way, exactly as a prepayment to a failed supplier does.
 *
 * World version 1 has no counterparties, so this returns an empty map for one
 * and the frozen world's books are byte-identical.
 */

import type { Company, SessionState } from '@frontier/contracts';
import { CLOUD_UNIT_COST_USD_PER_QUARTER } from './balance';
import { reservedRentUsd } from '../graph/lines';
import { isMultiSectorWorld } from '../economy/sectors';
import { activeCompanies, money } from './util';

/** One leg of what a buyer owes one seller this quarter. */
export interface CounterpartyCharge {
  readonly buyerCompanyId: string;
  readonly sellerCompanyId: string;
  readonly kind: 'reservation' | 'cloud' | 'accelerators';
  readonly amountUsd: number;
}

/** What this company is paying its reservation provider this quarter, at the world's index. */
export function reservationChargeUsd(draft: SessionState, company: Company): number {
  const compute = company.compute;
  const factor = Math.max(0.1, compute.reservationProviderFactor ?? 1);
  return money(compute.reservedAccelerators * reservedRentUsd(draft) * factor);
}

/** What this company is paying its cloud provider this quarter. */
export function cloudChargeUsd(draft: SessionState, company: Company): number {
  return money(company.compute.cloudSpendQuarterly * draft.world.compute.spotPrice);
}

/**
 * Every compute payment passing between two companies this quarter, in company
 * order and then in leg order — reservation, cloud, then purchases.
 *
 * Exported so a test, a screen or the Chief of Staff's own sourcing can show who
 * is paying whom without re-deriving a figure the financial phase will use.
 */
export function counterpartyCharges(draft: SessionState): CounterpartyCharge[] {
  if (!isMultiSectorWorld(draft)) return [];
  const live = new Set(draft.companies.filter((company) => company.isActive).map((company) => company.id));
  const out: CounterpartyCharge[] = [];
  const push = (buyer: Company, sellerId: string | null | undefined, kind: CounterpartyCharge['kind'], amountUsd: number): void => {
    if (typeof sellerId !== 'string' || sellerId.length === 0) return;
    if (sellerId === buyer.id || !live.has(sellerId) || amountUsd <= 0) return;
    out.push({ buyerCompanyId: buyer.id, sellerCompanyId: sellerId, kind, amountUsd: money(amountUsd) });
  };

  for (const buyer of activeCompanies(draft)) {
    push(buyer, buyer.compute.reservationProviderCompanyId, 'reservation', reservationChargeUsd(draft, buyer));
    push(buyer, buyer.compute.cloudProviderCompanyId, 'cloud', cloudChargeUsd(draft, buyer));
    for (const purchase of buyer.compute.pendingAcceleratorPurchases ?? []) {
      push(buyer, purchase.sellerCompanyId, 'accelerators', purchase.totalUsd);
    }
  }
  return out;
}

/**
 * The same charges summed by seller: what the financial phase adds to each
 * company's revenue this quarter. Empty in world version 1.
 */
export function counterpartyRevenueByCompany(draft: SessionState): Map<string, number> {
  const out = new Map<string, number>();
  for (const charge of counterpartyCharges(draft)) {
    out.set(charge.sellerCompanyId, money((out.get(charge.sellerCompanyId) ?? 0) + charge.amountUsd));
  }
  return out;
}

/** Cloud unit cost at the world index, restated so callers need not import the constant. */
export const CLOUD_INDEX_UNIT_COST_USD_PER_QUARTER = CLOUD_UNIT_COST_USD_PER_QUARTER;
