/**
 * @frontier/simulation — companies/capacity.ts
 *
 * `invest_capacity`'s resolution: the generalised capex action for every
 * capacity kind that is not accelerators — plant, fleet, grid.
 *
 * Same two-phase contract `buy_accelerators` uses for owned compute: this runs
 * in `product_demand_resolution` (phase 10, called from `resolveProducts`
 * alongside `resolveComputeOrders`) and only *stages* the investment on
 * `company.capacity.pendingInvestments`. `financial_resolution` (phase 11) is
 * the only phase that moves cash; it settles the pending investments into
 * `balanceSheet.assets.ppe`, into the matching capacity bucket, and
 * depreciates both from there on exactly as an owned accelerator does.
 *
 * World version 2 only: world 1 has no capacity kinds beyond compute, and this
 * action does not exist for it (rejected by the validator).
 */

import type { ResolverContext, SessionState } from '@frontier/contracts';
import { isMultiSectorWorld } from '../economy/sectors';
import { activeCompanies, companyActions, emitEvent, intentsOfType, money, usdLabel } from './util';

/** Stage this quarter's `invest_capacity` orders. Called from `resolveProducts`. */
export function resolveCapacityOrders(draft: SessionState, ctx: ResolverContext): void {
  if (!isMultiSectorWorld(draft)) return;

  for (const company of activeCompanies(draft)) {
    const actions = companyActions(draft, ctx, company.id);
    for (const { intent } of intentsOfType(actions, 'invest_capacity')) {
      const amountUsd = money(intent.amountUsd);
      if (amountUsd <= 0) continue;

      const capacity = company.capacity ?? { plantUsd: 0, fleetUsd: 0, gridUsd: 0 };
      capacity.pendingInvestments = [...(capacity.pendingInvestments ?? []), { kind: intent.kind, amountUsd }];
      company.capacity = capacity;

      const eventId = emitEvent(
        draft,
        ctx,
        'capacity_invested',
        company.id,
        null,
        { companyId: company.id, kind: intent.kind, amountUsd },
        'company',
      );
      ctx.log({
        phase: 'product_demand_resolution',
        text: `${company.name} committed ${usdLabel(amountUsd)} to ${intent.kind} capacity this quarter.`,
        deltaLabel: usdLabel(amountUsd),
        refEventIds: [eventId],
        tone: 'neutral',
        subjectId: company.id,
      });
    }
  }
}
