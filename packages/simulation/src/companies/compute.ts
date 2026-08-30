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
 * ## Reservations end
 *
 * `reservationExpiryQuarter` used to be written and never read, so every
 * reservation ran forever and seeded capacity was permanent. A term contract
 * ends, and this module ends it — but expiry alone would empty the seeded NPC
 * datacentres the quarter their terms ran out, so expiry comes with renewal:
 *
 * ```text
 * quarter expiry-1   a player-controlled company is warned, and may re-sign
 *                    with `reserve_compute` like any other reservation
 * quarter expiry     NPC-run and still serving on the block, with the cash to
 *                    cover it -> renewed for RESERVATION_RENEWAL_QUARTERS at
 *                    the prevailing reserved price
 *                    otherwise -> released, and serving capacity falls
 * ```
 *
 * A renewal moves no cash here either. The reserved units stay on
 * `company.compute`, so `computeCost` bills them next quarter at the world's
 * reserved index exactly as it billed them last quarter: the same staging
 * contract, and no second charging path to keep in step with the first.
 *
 * Determinism: no RNG, no clock. Every write is a function of the intent, the
 * company's own holdings and the world's compute prices.
 */

import type { Company, ResolverContext, SessionState } from '@frontier/contracts';
import {
  RESERVATION_RENEWAL_CASH_COVER_QUARTERS,
  RESERVATION_RENEWAL_QUARTERS,
  RESERVED_UNIT_COST_USD_PER_QUARTER,
} from './balance';
import { activeCompanies, companyActions, count, emitEvent, intentsOfType, money, unit, usdLabel } from './util';

/** What one reserved accelerator-equivalent costs this quarter, at the world's index. */
export function reservedUnitPriceUsd(draft: SessionState): number {
  return money(RESERVED_UNIT_COST_USD_PER_QUARTER * draft.world.compute.reservedPrice);
}

/**
 * Whether the reserved block is holding up something the company is actually
 * doing. A company with a live paying product is serving customers out of it and
 * re-signs; one with nothing live lets the term lapse and keeps the money.
 */
function reservationIsLoadBearing(company: Company): boolean {
  return company.products.some((product) => product.isActive && product.activeCustomers > 0);
}

/**
 * Renew or release a reservation whose term has run out, and warn a player one
 * quarter before theirs does.
 *
 * Runs after this quarter's `reserve_compute` orders, so a company that re-signed
 * itself has already pushed its own expiry out and is not touched here.
 */
function reviewReservation(draft: SessionState, ctx: ResolverContext, company: Company): void {
  const compute = company.compute;
  const expiry = compute.reservationExpiryQuarter;
  if (expiry === null) return;

  const units = compute.reservedAccelerators;
  if (units <= 0) {
    // An expiry date on nothing is a stale marker, not a holding: clear it
    // quietly, because no capacity and no money moved.
    compute.reservationExpiryQuarter = null;
    return;
  }

  const unitPrice = reservedUnitPriceUsd(draft);
  const quarterlyCostUsd = money(units * unitPrice);

  /* --- notice ------------------------------------------------------------- */
  if (expiry > ctx.quarter) {
    // Renewal is a player's decision, so a player is told in time to make it.
    // Nobody warns an NPC: it re-signs on the quarter, out of its own cash.
    if (expiry !== ctx.quarter + 1 || company.controllerPlayerId === null) return;
    const eventId = emitEvent(
      draft,
      ctx,
      'cost_recognised',
      company.id,
      null,
      {
        kind: 'compute_reservation_expiring',
        units,
        expiryQuarter: expiry,
        unitPriceUsd: unitPrice,
        quarterlyCostUsd,
      },
      'company',
    );
    ctx.log({
      phase: 'product_demand_resolution',
      text: `${company.name}'s reservation of ${units} accelerator-equivalents expires next quarter; reserve again to keep the capacity, or ${units} units of serving come off the books at ${usdLabel(quarterlyCostUsd)} a quarter saved.`,
      deltaLabel: `${units} units at risk`,
      refEventIds: [eventId],
      tone: 'warning',
      subjectId: company.id,
    });
    return;
  }

  /* --- the term is up ------------------------------------------------------ */
  const coverUsd = money(quarterlyCostUsd * RESERVATION_RENEWAL_CASH_COVER_QUARTERS);
  const renews =
    company.controllerPlayerId === null && reservationIsLoadBearing(company) && company.financials.cash >= coverUsd;

  if (renews) {
    compute.reservationExpiryQuarter = ctx.quarter + RESERVATION_RENEWAL_QUARTERS;
    const eventId = emitEvent(
      draft,
      ctx,
      'cost_recognised',
      company.id,
      null,
      {
        kind: 'compute_reservation_renewed',
        units,
        quarters: RESERVATION_RENEWAL_QUARTERS,
        unitPriceUsd: unitPrice,
        quarterlyCostUsd,
        expiryQuarter: compute.reservationExpiryQuarter,
      },
      'company',
    );
    ctx.log({
      phase: 'product_demand_resolution',
      text: `${company.name} re-signed its ${units} reserved accelerator-equivalents for ${RESERVATION_RENEWAL_QUARTERS} quarters at ${usdLabel(unitPrice)} each, holding serving capacity at ${usdLabel(quarterlyCostUsd)} a quarter.`,
      deltaLabel: `${units} units held`,
      refEventIds: [eventId],
      tone: 'neutral',
      subjectId: company.id,
    });
    return;
  }

  const reason =
    company.controllerPlayerId !== null
      ? 'not_renewed'
      : !reservationIsLoadBearing(company)
        ? 'nothing_to_serve'
        : 'insufficient_cash';
  compute.reservedAccelerators = 0;
  compute.reservationExpiryQuarter = null;
  const eventId = emitEvent(
    draft,
    ctx,
    'cost_recognised',
    company.id,
    null,
    {
      kind: 'compute_reservation_expired',
      units,
      reason,
      unitPriceUsd: unitPrice,
      quarterlyCostUsd,
      cashUsd: money(company.financials.cash),
      cashRequiredUsd: coverUsd,
    },
    'company',
  );
  ctx.log({
    phase: 'product_demand_resolution',
    text: `${company.name}'s reservation of ${units} accelerator-equivalents expired (${reason.replace(/_/g, ' ')}); the capacity went back to the market and its serving capacity fell with it.`,
    deltaLabel: `-${units} units`,
    refEventIds: [eventId],
    tone: 'warning',
    subjectId: company.id,
  });
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

    /* --- reservations that have run their term ------------------------------ */
    // Last, so a company that re-signed above is already renewed and the block
    // below sees nothing to do.
    reviewReservation(draft, ctx, company);
  }
}
