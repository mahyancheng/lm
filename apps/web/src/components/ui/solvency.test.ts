/**
 * The solvency line every cash preview prints.
 *
 * The screens compute no economics: `cashAfterOf` subtracts a commitment the
 * screen was already handed from the cash the engine recorded, and the sentence
 * under it is `solvencyLine` from `@frontier/simulation`. These tests pin that
 * seam — that the tone flips at zero, that the clock is read from the filed
 * statements rather than invented, and that an accepted-with-a-cash-note verdict
 * reads as a warning rather than an error.
 */

import { describe, expect, it } from 'vitest';
import type { ActionValidationResult, Company } from '@frontier/contracts';
import { SOLVENCY_NEGATIVE_QUARTERS } from '@frontier/simulation';
import { cashAfterOf } from './CashAfter';
import { hasAdvisory } from './ValidationBanner';

/** A company is only ever read here for its cash and its filed statements. */
function companyWith(cashUsd: number, closes: readonly number[]): Company {
  return {
    financials: { cash: cashUsd },
    financialHistory: closes.map((close, index) => ({ quarter: index, balance: { cashUsd: close } })),
  } as unknown as Company;
}

const verdict = (over: Partial<ActionValidationResult>): ActionValidationResult => ({
  actionId: 'act_test',
  status: 'accepted',
  reasons: [],
  codes: [],
  clampedAction: null,
  ...over,
});

describe('cashAfterOf', () => {
  it('lands the balance and says nothing while it stays above zero', () => {
    const preview = cashAfterOf(companyWith(10_000_000, [4_000_000, 10_000_000]), 4_000_000);
    expect(preview.afterUsd).toBe(6_000_000);
    expect(preview.quarters).toBe(0);
    expect(preview.line).toBeNull();
  });

  it('names the first quarter below zero when the clock has not started', () => {
    const preview = cashAfterOf(companyWith(1_000_000, [2_000_000, 1_000_000]), 3_000_000);
    expect(preview.afterUsd).toBe(-2_000_000);
    expect(preview.quarters).toBe(0);
    expect(preview.line).toContain('First quarter below zero');
  });

  it('counts the quarters already below zero, out of the two that end the company', () => {
    const preview = cashAfterOf(companyWith(-500_000, [3_000_000, -500_000]), 100_000);
    expect(preview.quarters).toBe(1);
    expect(preview.line).toBe(`1 of ${SOLVENCY_NEGATIVE_QUARTERS} quarters below zero — end this one below zero and the company is wound up.`);
  });

  it('reads the run from the tail of the statements, so a quarter back above zero resets it', () => {
    expect(cashAfterOf(companyWith(-100, [-1, -1, 5_000_000, -100]), 1).quarters).toBe(1);
    expect(cashAfterOf(companyWith(-100, [5_000_000, -1, -100]), 1).quarters).toBe(2);
  });

  it('reads zero for a world-1 company, which files no statements', () => {
    const preview = cashAfterOf({ financials: { cash: 1_000 } } as unknown as Company, 5_000);
    expect(preview.quarters).toBe(0);
    expect(preview.line).toContain('First quarter below zero');
  });
});

describe('hasAdvisory', () => {
  it('treats an accepted verdict carrying a cash note as a warning, not a failure', () => {
    expect(hasAdvisory(verdict({ status: 'accepted', codes: ['insufficient_cash'] }))).toBe(true);
    expect(hasAdvisory(verdict({ status: 'accepted', codes: [] }))).toBe(false);
    // A world-1 clamp is still a clamp: the banner has its own wording for that.
    expect(hasAdvisory(verdict({ status: 'clamped', codes: ['insufficient_cash'] }))).toBe(false);
    expect(hasAdvisory(verdict({ status: 'rejected', codes: ['insufficient_cash'] }))).toBe(false);
  });
});
