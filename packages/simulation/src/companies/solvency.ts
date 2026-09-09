/**
 * @frontier/simulation — companies/solvency.ts
 *
 * The solvency clock, and the two derived figures every surface reads off it.
 *
 * World version 2 replaces "you cannot afford that" with "you can, and here is
 * what it costs you". Two rules, and nothing else:
 *
 * 1. Cash is never a reason to refuse or shrink an instruction. The validator
 *    still reserves what an action commits — the batch budget, the previews and
 *    the ledger all need to know what was promised — but it notes the landing
 *    balance instead of clamping to it.
 * 2. A company whose cash is below zero at `SOLVENCY_NEGATIVE_QUARTERS`
 *    consecutive quarter-ends is wound up. Player-controlled or bot: the same
 *    count, the same administration.
 *
 * ## Derived, never stored
 *
 * `negativeCashQuarters` counts backwards from the tail of `financialHistory`,
 * which the financial phase files one entry per closed quarter. There is no
 * counter on the company to drift out of step with the accounts, and a save
 * restored from any quarter recomputes the same clock from the same statements.
 *
 * A world-version-1 company files no statements, so the clock reads zero for it
 * and none of this reaches the frozen world.
 */

import type { Company } from '@frontier/contracts';
import { OVERDRAFT_SPREAD, SOLVENCY_NEGATIVE_QUARTERS } from './balance';

/**
 * Consecutive closed quarters this company ended below zero, counting back from
 * the most recent filed statement.
 *
 * The current `financials.cash` is the close of the latest filed quarter, so the
 * two always agree; the history is read rather than the live field because only
 * the history knows what the quarter *before* it did.
 */
export function negativeCashQuarters(company: Pick<Company, 'financialHistory'>): number {
  const history = company.financialHistory ?? [];
  let run = 0;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const entry = history[index];
    if (entry === undefined || entry.balance.cashUsd >= 0) break;
    run += 1;
  }
  return run;
}

/**
 * Interest owed this quarter on an overdrawn opening balance.
 *
 * Charged on the opening overdraft, not the closing one: the quarter's own
 * spending has not been financed yet when the charge is struck, and charging the
 * close would make the fee depend on the fee.
 */
export function overdraftChargeUsd(openingCashUsd: number, policyRate: number): number {
  const overdrawn = Math.max(0, -openingCashUsd);
  if (overdrawn <= 0) return 0;
  return (overdrawn * (policyRate + OVERDRAFT_SPREAD)) / 4;
}

/**
 * The validator's note when an instruction commits more cash than the company
 * holds. Never a rejection and never a clamp — the action runs as written.
 *
 * `format` is the caller's money formatter, so the note reads in the same
 * units as everything else on the surface that prints it.
 */
export function solvencyCommitmentNote(fromUsd: number, toUsd: number, format: (value: number) => string): string {
  return `Takes cash from ${format(fromUsd)} to ${format(toUsd)}; ${SOLVENCY_NEGATIVE_QUARTERS} quarters below zero and the company is wound up.`;
}

/**
 * The one line a cash preview puts under a balance that lands below zero.
 *
 * `negativeQuarters` is the clock as it stands — `negativeCashQuarters` of the
 * company — and `cashAfterUsd` is where this decision would leave the balance.
 * Null when the balance stays at or above zero: there is nothing to warn about,
 * and a preview that says so anyway teaches players to ignore it.
 */
export function solvencyLine(negativeQuarters: number, cashAfterUsd: number): string | null {
  if (cashAfterUsd >= 0) return null;
  const closed = Math.max(0, negativeQuarters);
  if (closed <= 0) return `First quarter below zero if you end the quarter like this — ${SOLVENCY_NEGATIVE_QUARTERS} in a row and the company is wound up.`;
  const next = closed + 1;
  if (next >= SOLVENCY_NEGATIVE_QUARTERS) {
    return `${closed} of ${SOLVENCY_NEGATIVE_QUARTERS} quarters below zero — end this one below zero and the company is wound up.`;
  }
  return `${closed} of ${SOLVENCY_NEGATIVE_QUARTERS} quarters below zero.`;
}

/** Whether the clock has run out: the company is wound up on this reading. */
export function isInsolvent(company: Pick<Company, 'financialHistory'>): boolean {
  return negativeCashQuarters(company) >= SOLVENCY_NEGATIVE_QUARTERS;
}
