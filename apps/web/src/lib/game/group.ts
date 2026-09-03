/**
 * STAGE 5 — the group, read for the screens.
 *
 * `controlledCompaniesOf` (from `@frontier/simulation`) is the raw list —
 * every active company this seat directs, founding company first. Both the
 * switcher and the Group screen want the same handful of figures alongside
 * each one, so this is the one place that assembles them, rather than each
 * surface reaching into cap tables and financial history on its own.
 *
 * Nothing here computes an economic number that is not already sitting on
 * `Company` or produced by an existing, tested projection
 * (`portfolioOf`, `negativeCashQuarters`) — this only shapes rows.
 */

import type { Company, SessionState } from '@frontier/contracts';
import { controlledCompaniesOf, negativeCashQuarters, portfolioOf } from '@frontier/simulation';

export interface ControlledCompanyRow {
  readonly company: Company;
  /** The company `SessionPlayer.companyId` names — always first in the list. */
  readonly isFounding: boolean;
  /**
   * Fraction of this company's issued shares the founding company itself
   * holds, from `portfolioOf`'s own subsidiary accounting — 1 for the
   * founding company, and 1 for a company this seat controls some other way
   * `portfolioOf` does not attribute to a single parent (a majority stake
   * built up by a subsidiary rather than the founding company, or the rare
   * save where the founding company itself is inactive): "directed" beats an
   * invented fraction.
   */
  readonly controlPct: number;
  readonly headcount: number;
  /** How many of the last `SOLVENCY_NEGATIVE_QUARTERS` closed below zero. 0 is healthy. */
  readonly negativeCashQuarters: number;
}

/** Every company this seat directs, in the switcher's own order, with the figures a row needs. */
export function controlledCompanyRows(session: SessionState, playerId: string): ControlledCompanyRow[] {
  const companies = controlledCompaniesOf(session, playerId);
  const founding = companies[0] ?? null;
  const stakes = new Map(
    founding === null ? [] : portfolioOf(session, founding.id).subsidiaries.map((row) => [row.companyId, row.controlPct] as const),
  );
  return companies.map((company) => {
    const staff = company.employees;
    return {
      company,
      isFounding: company.id === founding?.id,
      controlPct: company.id === founding?.id ? 1 : (stakes.get(company.id) ?? 1),
      headcount: staff.engineers + staff.researchers + staff.sales + staff.ops + staff.execs,
      negativeCashQuarters: negativeCashQuarters(company),
    };
  });
}

/** True once a seat directs more than its own founding company — the switcher and the Group nav entry both gate on this. */
export function hasGroup(session: SessionState, playerId: string): boolean {
  return controlledCompaniesOf(session, playerId).length > 1;
}
