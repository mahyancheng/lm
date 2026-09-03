/**
 * Per-quarter financial statements.
 *
 * Four things are being proved here, and only these four:
 *
 * 1. **The statements reconcile.** Assets less liabilities equals equity, the
 *    cash-flow net change equals the cash the quarter actually moved, and the
 *    income lines add up to the bottom line — for every company, every quarter,
 *    across a long run.
 * 2. **The series is bounded.** Forty-five quarters leave forty statements, the
 *    oldest dropped, and the newest is the quarter that just closed.
 * 3. **World version 1 is frozen.** A version-1 company grows no
 *    `financialHistory` key and the version-1 run hashes exactly as it did.
 * 4. **It is deterministic.** The same seed produces the same statements, byte
 *    for byte.
 */

import { describe, expect, it } from 'vitest';
import type { SessionState } from '@frontier/contracts';
import { FINANCIAL_HISTORY_QUARTERS, FINANCIAL_STATEMENT_TOLERANCE_USD, SessionStateSchema, financialQuarterReconciles } from '@frontier/contracts';
import { hashState, stableStringify } from '@frontier/shared';
import { createDefaultEngine } from '../src/engine';
import { demoSessionInput } from '../src/scenario';

/* -------------------------------------------------------------------------- */
/*  Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

const SECTOR_BY_INDEX = ['ai', 'robotics', 'manufacturing', 'energy', 'logistics', 'consumer'] as const;
const REGION_BY_INDEX = ['north_america', 'east_asia', 'east_asia', 'middle_east', 'south_asia', 'europe'] as const;

/** The same multi-sector fixture `world2.test.ts` uses, so the two agree. */
function createWorld2Session(seed = 424242): SessionState {
  const input = demoSessionInput(seed);
  const companies = input.companies ?? [];
  return SessionStateSchema.parse({
    ...input,
    config: { ...input.config, worldVersion: 2 },
    companies: companies.map((company, index) => ({
      ...company,
      sector: SECTOR_BY_INDEX[index % SECTOR_BY_INDEX.length],
      region: REGION_BY_INDEX[index % REGION_BY_INDEX.length],
      fundamentals: {
        revenueTtmUsd: Math.max(0, company.financials.revenueQuarterly) * 4,
        revenueGrowthQoQ: 0.04,
        revenueGrowthYoY: 0.18,
        grossMarginPct: 0.55,
        netIncomeTtmUsd: 0,
        sharesOutstanding: 10_000_000,
      },
    })),
  });
}

/** Two dollar figures agree when they are within the statement tolerance. */
function expectNear(actual: number, expected: number): void {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(FINANCIAL_STATEMENT_TOLERANCE_USD);
}

/** Resolve `quarters` quarters with no player actions and return the end state. */
function run(state: SessionState, quarters: number): SessionState {
  const engine = createDefaultEngine();
  let current = state;
  for (let quarter = 0; quarter < quarters; quarter += 1) {
    const outcome = engine.resolver.resolveQuarter(current, [], null, []);
    expect(outcome.committed).toBe(true);
    current = outcome.nextState;
  }
  return current;
}

/* -------------------------------------------------------------------------- */
/*  Reconciliation and bounds                                                  */
/* -------------------------------------------------------------------------- */

describe('filed financial statements', () => {
  it(
    'files a reconciling statement for every company, every quarter, and bounds the series at forty',
    () => {
      const quarters = 45;
      const state = run(createWorld2Session(), quarters);

      expect(state.companies.length).toBeGreaterThan(0);
      for (const company of state.companies) {
        if (!company.isActive) continue;
        const history = company.financialHistory;
        expect(history, `${company.id} filed no statements`).toBeDefined();
        if (history === undefined) continue;

        // BOUND: forty-five quarters, forty statements, oldest dropped.
        expect(history.length).toBe(FINANCIAL_HISTORY_QUARTERS);
        expect(history[0]?.quarter).toBe(quarters - FINANCIAL_HISTORY_QUARTERS);
        expect(history[history.length - 1]?.quarter).toBe(quarters - 1);

        // Ascending, one per quarter, no duplicates.
        const quartersFiled = history.map((entry) => entry.quarter);
        expect([...quartersFiled].sort((a, b) => a - b)).toEqual(quartersFiled);
        expect(new Set(quartersFiled).size).toBe(quartersFiled.length);

        for (const entry of history) {
          expect(financialQuarterReconciles(entry), `${company.id} q${entry.quarter} does not reconcile`).toBe(true);
        }
      }
    },
    180_000,
  );

  it(
    'files a cash-flow net change equal to the cash the quarter moved, and a balance sheet that matches the live one',
    () => {
      const state = run(createWorld2Session(), 6);
      for (const company of state.companies) {
        const history = company.financialHistory ?? [];
        const latest = history[history.length - 1];
        expect(latest).toBeDefined();
        if (latest === undefined) continue;

        // The identity the cash-flow statement exists to satisfy.
        expectNear(latest.cashFlow.netChangeUsd, latest.cashFlow.endingCashUsd - latest.cashFlow.openingCashUsd);
        expectNear(latest.cashFlow.operatingUsd + latest.cashFlow.investingUsd + latest.cashFlow.financingUsd, latest.cashFlow.netChangeUsd);
        // The statement is the quarter the engine committed, not a restatement.
        expect(latest.balance.cashUsd).toBe(company.financials.cash);
        expect(latest.balance.debtUsd).toBe(company.financials.debt);
        expect(latest.income.revenueUsd).toBe(company.financials.revenueQuarterly);
        expectNear(latest.cashFlow.netChangeUsd, company.financials.quarterlyBurn);
      }
    },
    90_000,
  );

  it(
    'splits revenue and operating expense into lines that sum to their totals',
    () => {
      const state = run(createWorld2Session(), 4);
      for (const company of state.companies) {
        for (const entry of company.financialHistory ?? []) {
          const bySource = entry.income.revenueBySource;
          const byLine = entry.income.opexByLine;
          expect(bySource).toBeDefined();
          expect(byLine).toBeDefined();
          if (bySource !== undefined) {
            expectNear(bySource.productsUsd + bySource.contractsUsd + bySource.otherUsd, entry.income.revenueUsd);
          }
          if (byLine !== undefined) {
            expectNear(byLine.payrollUsd + byLine.researchUsd + byLine.marketingUsd + byLine.computeUsd + byLine.otherUsd, entry.income.opexUsd);
          }
          for (const line of entry.productLines ?? []) {
            expectNear(line.revenueUsd, line.units * line.priceUsd);
          }
        }
      }
    },
    90_000,
  );

  it(
    'reads growth off the filed series rather than off a rolling estimate',
    () => {
      const state = run(createWorld2Session(), 8);
      for (const company of state.companies) {
        const history = company.financialHistory ?? [];
        // The first filed quarter has no predecessor, so its growth is zero
        // rather than an invented number.
        expect(history[0]?.kpis.revenueGrowthQoQ).toBe(0);
        for (let index = 1; index < history.length; index += 1) {
          const entry = history[index];
          const previous = history[index - 1];
          if (entry === undefined || previous === undefined) continue;
          if (previous.income.revenueUsd <= 0) {
            expect(entry.kpis.revenueGrowthQoQ).toBe(0);
            continue;
          }
          const expected = entry.income.revenueUsd / previous.income.revenueUsd - 1;
          expect(entry.kpis.revenueGrowthQoQ).toBeCloseTo(Math.max(-1, Math.min(5, expected)), 9);
        }
      }
    },
    90_000,
  );

  it(
    'stamps the market figures from the quarter the market priced, and leaves an unlisted company without a price',
    () => {
      const state = run(createWorld2Session(), 5);
      for (const company of state.companies) {
        const latest = (company.financialHistory ?? []).at(-1);
        if (latest === undefined) continue;
        if (company.instrumentId === null) {
          expect(latest.kpis.sharePriceUsd).toBeNull();
        }
        if (latest.kpis.sharePriceUsd !== null) {
          expect(latest.kpis.sharePriceUsd).toBeGreaterThan(0);
          expect(latest.kpis.marketCapUsd).not.toBeNull();
        }
      }
    },
    90_000,
  );
});

/* -------------------------------------------------------------------------- */
/*  World version 1 stays frozen                                               */
/* -------------------------------------------------------------------------- */

describe('world version 1', () => {
  it(
    'files no statements and hashes exactly as it did',
    () => {
      const before = SessionStateSchema.parse(demoSessionInput());
      for (const company of before.companies) expect(company.financialHistory).toBeUndefined();

      const after = run(before, 6);
      for (const company of after.companies) {
        expect(company.financialHistory, `${company.id} grew a history key in world 1`).toBeUndefined();
      }
      // The frozen world is byte-identical run to run, which is the property the
      // pinned hash rests on.
      expect(hashState(run(SessionStateSchema.parse(demoSessionInput()), 6))).toBe(hashState(after));
      expect(stableStringify(after)).not.toContain('financialHistory');
    },
    120_000,
  );
});

/* -------------------------------------------------------------------------- */
/*  Determinism                                                                */
/* -------------------------------------------------------------------------- */

describe('statement determinism', () => {
  it(
    'produces the same statements from the same seed',
    () => {
      const first = run(createWorld2Session(), 6);
      const second = run(createWorld2Session(), 6);
      expect(hashState(second)).toBe(hashState(first));
      expect(stableStringify(second.companies.map((company) => company.financialHistory))).toBe(
        stableStringify(first.companies.map((company) => company.financialHistory)),
      );
    },
    120_000,
  );
});
