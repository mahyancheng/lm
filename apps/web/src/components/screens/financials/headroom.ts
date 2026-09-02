/**
 * V7 — the headroom figures, so the bankruptcy condition is always on screen.
 *
 * The engine has two ways to kill a company, and the second one is the one
 * players never see coming: cash falling below the quarter's debt service. So
 * the cash card states what next quarter costs before it arrives, and the debt
 * card is drawn as a bar of what is used against what is covered.
 *
 * Neither figure is invented. `DEBT_AMORTISATION_PER_QUARTER` is the engine's
 * own constant — the same one `resolveFinancials` repays against — and the
 * interest charge is the one already on the statement. Restating the rule here
 * rather than importing it would be exactly the drift §6.2 forbids.
 */

import { DEBT_AMORTISATION_PER_QUARTER } from '@frontier/simulation';

export interface DebtServiceView {
  /** Principal the engine will amortise next quarter, whole dollars. */
  readonly principalUsd: number;
  /** Interest charged this quarter, which is the run rate for the next. */
  readonly interestUsd: number;
  /** What leaves the account: principal plus interest. */
  readonly totalUsd: number;
  /** Cash left after it. Negative is the forced-bridge condition. */
  readonly headroomUsd: number;
  /** Quarters of service the cash balance covers, capped for display. */
  readonly coveredQuarters: number;
}

/** Display cap: past this the number stops being informative. */
const COVER_CAP = 40;

/**
 * What the company owes on its debt next quarter, and what that leaves.
 *
 * `interestExpense` is the charge the engine raised this quarter; with the
 * balance amortising, next quarter's is slightly lower, so this is the
 * conservative figure — which is the right direction for a warning.
 */
export function debtServiceView(cashUsd: number, debtUsd: number, interestUsd: number): DebtServiceView {
  const principalUsd = Math.round(Math.max(0, Math.min(debtUsd, debtUsd * DEBT_AMORTISATION_PER_QUARTER)));
  const interest = Math.round(Math.max(0, interestUsd));
  const totalUsd = principalUsd + interest;
  return {
    principalUsd,
    interestUsd: interest,
    totalUsd,
    headroomUsd: Math.round(cashUsd) - totalUsd,
    coveredQuarters: totalUsd <= 0 ? COVER_CAP : Math.max(0, Math.min(COVER_CAP, cashUsd / totalUsd)),
  };
}
