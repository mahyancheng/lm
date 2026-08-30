/**
 * @frontier/simulation — companies/compute.ts
 *
 * The compute orders a company placed this quarter: reservations, on-demand
 * cloud, and the split between training and serving.
 *
 * These three actions are the whole compute pillar, and they resolve at the top
 * of `product_demand_resolution` (phase 10) for one reason: capacity bought this
 * quarter is capacity that serves this quarter's demand, and the demand model
 * two functions later is the thing that reads it.
 *
 * ## Phase contract with `financial_resolution`
 *
 * Nothing here moves cash. Compute is charged by `computeCost` in phase eleven
 * out of `company.compute` — reserved units at the reserved index, cloud spend
 * at the spot index, energy on the lot — which is the same staging contract the
 * talent phase uses for payroll and this phase uses for marketing. Writing the
 * holdings here therefore bills them automatically, in the same quarter, at the
 * world's own prices.
 *
 * The validator has already reserved the first quarter's cash against the
 * company's balance and clamped the order to what the market could free
 * (`reservableUnits`), so the numbers arriving here are affordable and available.
 * The one thing it cannot check is the price limit, because that is a decision
 * rather than a constraint: a reservation whose clearing price is above the
 * bidder's limit fails, and says so, rather than clearing anyway.
 *
 * Determinism: no RNG, no clock. Every write is a function of the intent and the
 * world's compute prices.
 */

import type { ResolverContext, SessionState } from '@frontier/contracts';
import { RESERVED_UNIT_COST_USD_PER_QUARTER } from './balance';
import { activeCompanies, companyActions, count, emitEvent, intentsOfType, money, unit, usdLabel } from './util';

/** What one reserved accelerator-equivalent costs this quarter, at the world's index. */
export function reservedUnitPriceUsd(draft: SessionState): number {
  return money(RESERVED_UNIT_COST_USD_PER_QUARTER * draft.world.compute.reservedPrice);
}

/**
 * Apply every accepted compute instruction to the company's holdings, before
 * serving capacity is computed from them.
 */
export function resolveComputeOrders(draft: SessionState, ctx: ResolverContext): void {
  for (const company of activeCompanies(draft)) {
    const actions = companyActions(draft, ctx, company.id);

    /* --- reservations ------------------------------------------------------ */
    for (const { intent } of intentsOfType(actions, 'reserve_compute')) {
      const unitPrice = reservedUnitPriceUsd(draft);
      if (unitPrice > intent.maxPricePerUnitUsd) {
        const eventId = emitEvent(
          draft,
          ctx,
          'cost_recognised',
          company.id,
          null,
          {
            kind: 'compute_reservation_failed',
            units: intent.units,
            quarters: intent.quarters,
            clearingPriceUsd: unitPrice,
            maxPricePerUnitUsd: money(intent.maxPricePerUnitUsd),
          },
          'company',
        );
        ctx.log({
          phase: 'product_demand_resolution',
          text: `${company.name}'s reservation of ${intent.units} accelerators did not clear: capacity is going at ${usdLabel(unitPrice)} a unit per quarter against a limit of ${usdLabel(intent.maxPricePerUnitUsd)}.`,
          deltaLabel: 'no fill',
          refEventIds: [eventId],
          tone: 'warning',
          subjectId: company.id,
        });
        continue;
      }

      const before = company.compute.reservedAccelerators;
      company.compute.reservedAccelerators = count(before + intent.units);
      const expiry = ctx.quarter + intent.quarters;
      company.compute.reservationExpiryQuarter =
        company.compute.reservationExpiryQuarter === null ? expiry : Math.max(company.compute.reservationExpiryQuarter, expiry);

      const eventId = emitEvent(
        draft,
        ctx,
        'cost_recognised',
        company.id,
        null,
        {
          kind: 'compute_reserved',
          units: intent.units,
          quarters: intent.quarters,
          unitPriceUsd: unitPrice,
          quarterlyCostUsd: money(intent.units * unitPrice),
          reservedBefore: before,
          reservedAfter: company.compute.reservedAccelerators,
          expiryQuarter: company.compute.reservationExpiryQuarter,
        },
        'company',
      );
      ctx.log({
        phase: 'product_demand_resolution',
        text: `${company.name} reserved ${intent.units} accelerator-equivalents for ${intent.quarters} quarters at ${usdLabel(unitPrice)} each, taking held reserved capacity to ${company.compute.reservedAccelerators}.`,
        deltaLabel: `+${intent.units} units`,
        refEventIds: [eventId],
        tone: 'positive',
        subjectId: company.id,
      });
    }

    /* --- on-demand cloud ---------------------------------------------------- */
    for (const { intent } of intentsOfType(actions, 'buy_cloud_capacity')) {
      const before = company.compute.cloudSpendQuarterly;
      company.compute.cloudSpendQuarterly = money(intent.quarterlySpendUsd);
      const eventId = emitEvent(
        draft,
        ctx,
        'cost_recognised',
        company.id,
        null,
        {
          kind: 'compute_cloud',
          quarterlySpendUsd: company.compute.cloudSpendQuarterly,
          beforeUsd: money(before),
          providerCompanyId: intent.providerCompanyId,
          commitmentQuarters: intent.commitmentQuarters,
          spotPrice: draft.world.compute.spotPrice,
        },
        'company',
      );
      ctx.log({
        phase: 'product_demand_resolution',
        text: `${company.name} moved its on-demand cloud commitment from ${usdLabel(before)} to ${usdLabel(company.compute.cloudSpendQuarterly)} a quarter at a spot index of ${draft.world.compute.spotPrice.toFixed(2)}.`,
        deltaLabel: usdLabel(company.compute.cloudSpendQuarterly - before),
        refEventIds: [eventId],
        tone: 'neutral',
        subjectId: company.id,
      });
    }

    /* --- the training and serving split ------------------------------------- */
    for (const { intent } of intentsOfType(actions, 'allocate_compute')) {
      const before = company.compute.trainingAllocation;
      company.compute.trainingAllocation = unit(intent.trainingFraction);
      if (company.compute.trainingAllocation === before) continue;
      const eventId = emitEvent(
        draft,
        ctx,
        'cost_recognised',
        company.id,
        null,
        {
          kind: 'compute_allocated',
          trainingBefore: before,
          trainingAfter: company.compute.trainingAllocation,
          servingAfter: 1 - company.compute.trainingAllocation,
        },
        'company',
      );
      ctx.log({
        phase: 'product_demand_resolution',
        text: `${company.name} pointed ${(company.compute.trainingAllocation * 100).toFixed(0)}% of its capacity at training, leaving ${((1 - company.compute.trainingAllocation) * 100).toFixed(0)}% to serve customers.`,
        deltaLabel: `${((company.compute.trainingAllocation - before) * 100).toFixed(0)}pp training`,
        refEventIds: [eventId],
        tone: 'neutral',
        subjectId: company.id,
      });
    }
  }
}
