/**
 * STAGE 5 — the queue, grouped by the company it belongs to.
 *
 * A queued action's `actorCompanyId` already names who it is for — the
 * switcher decided that when it was queued (`queueAction`'s default), or a
 * screen said so explicitly. This is the one place that folds the flat queue
 * back into one group per acting company, each with its own commitment total
 * and its own solvency clock: two companies committing cash this quarter are
 * two different balance sheets, and End Quarter has to say so rather than
 * running one figure against whichever company happens to be active when the
 * screen renders.
 *
 * Pure and framework-free, like `intents.ts` beside it: no React, so it is as
 * cheap to unit test as any other selector.
 */

import type { Company, SessionState } from '@frontier/contracts';
import { controlledCompaniesOf, negativeCashQuarters, solvencyLine } from '@frontier/simulation';
import type { QueuedActionEntry } from '@/lib/game';
import { cashEffectOf } from './intents';

export interface CompanyQueueGroup {
  readonly company: Company;
  readonly entries: readonly QueuedActionEntry[];
  /** Cash the group's accepted or clamped entries commit this quarter — a rejected entry never runs, so it contributes nothing. */
  readonly outflowUsd: number;
  /** Cash the group's entries seek this quarter — an attempt, never a receipt. */
  readonly inflowUsd: number;
  readonly availableUsd: number;
  readonly afterUsd: number;
  /** This company's own solvency clock, exactly as `CashAfter` states it for one company — null when the projected balance stays at or above zero. */
  readonly solvencyLine: string | null;
}

/**
 * The queue folded into one row per company it was submitted for, in
 * `controlledCompaniesOf`'s own order — founding company first — with a
 * company that has nothing queued simply absent rather than shown empty.
 */
export function groupQueueByCompany(
  session: SessionState,
  queue: readonly QueuedActionEntry[],
  playerId: string,
): CompanyQueueGroup[] {
  const companies = controlledCompaniesOf(session, playerId);
  const grouped = new Map<string, QueuedActionEntry[]>();
  for (const entry of queue) {
    const companyId = entry.action.actorCompanyId;
    const list = grouped.get(companyId) ?? [];
    list.push(entry);
    grouped.set(companyId, list);
  }

  return companies
    .filter((company) => (grouped.get(company.id)?.length ?? 0) > 0)
    .map((company) => {
      const entries = grouped.get(company.id) ?? [];
      let outflowUsd = 0;
      let inflowUsd = 0;
      for (const entry of entries) {
        if (entry.validation.status === 'rejected') continue;
        const intent = entry.validation.clampedAction ?? entry.action.intent;
        const effect = cashEffectOf(session, intent);
        outflowUsd += effect.outflowUsd;
        inflowUsd += effect.inflowUsd;
      }
      const availableUsd = company.financials.cash;
      const afterUsd = availableUsd - (outflowUsd - inflowUsd);
      return {
        company,
        entries,
        outflowUsd,
        inflowUsd,
        availableUsd,
        afterUsd,
        solvencyLine: solvencyLine(negativeCashQuarters(company), afterUsd),
      };
    });
}
