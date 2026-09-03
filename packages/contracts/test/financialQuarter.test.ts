/**
 * `FinancialQuarter`: the shape, its defaults, its identities and the one
 * projection that is allowed to narrow it.
 *
 * The rule the redaction test exists to hold: a projection REMOVES and never
 * rewrites. A figure a listed rival files must survive `filedFinancialQuarter`
 * unchanged, and a figure nobody files must be absent rather than zeroed.
 */

import { describe, expect, it } from 'vitest';
import {
  CompanySchema,
  FINANCIAL_HISTORY_QUARTERS,
  FINANCIAL_STATEMENT_TOLERANCE_USD,
  FinancialQuarterSchema,
  filedFinancialQuarter,
  financialQuarterReconciles,
  type FinancialQuarter,
} from '../src';

/* -------------------------------------------------------------------------- */
/*  A statement that adds up                                                   */
/* -------------------------------------------------------------------------- */

function statement(overrides: Partial<FinancialQuarter> = {}): FinancialQuarter {
  const base: FinancialQuarter = {
    quarter: 4,
    income: {
      revenueUsd: 1_000_000,
      revenueBySource: { productsUsd: 800_000, contractsUsd: 250_000, otherUsd: -50_000 },
      cogsUsd: 400_000,
      grossProfitUsd: 600_000,
      opexUsd: 500_000,
      opexByLine: { payrollUsd: 300_000, researchUsd: 90_000, marketingUsd: 60_000, computeUsd: 50_000, otherUsd: 0 },
      ebitdaUsd: 140_000,
      depreciationUsd: 40_000,
      operatingIncomeUsd: 100_000,
      interestUsd: 20_000,
      taxUsd: 16_000,
      netIncomeUsd: 64_000,
    },
    balance: {
      cashUsd: 2_000_000,
      receivablesUsd: 300_000,
      computeAssetsUsd: 700_000,
      otherAssetsUsd: 100_000,
      totalAssetsUsd: 3_100_000,
      debtUsd: 900_000,
      deferredRevenueUsd: 100_000,
      otherLiabilitiesUsd: 200_000,
      totalLiabilitiesUsd: 1_200_000,
      equityUsd: 1_900_000,
    },
    cashFlow: {
      openingCashUsd: 1_800_000,
      operatingUsd: 260_000,
      investingUsd: -30_000,
      financingUsd: -30_000,
      netChangeUsd: 200_000,
      endingCashUsd: 2_000_000,
    },
    kpis: {
      headcount: 120,
      grossMarginPct: 0.6,
      revenueGrowthQoQ: 0.08,
      revenueGrowthYoY: 0.44,
      runwayQuarters: 12,
      runRateUsd: 4_000_000,
      marketCapUsd: 50_000_000,
      sharePriceUsd: 5,
    },
    productLines: [
      { productId: 'prd_a', name: 'Agent Platform', segment: 'enterprise', units: 400, priceUsd: 2_000, revenueUsd: 800_000, grossMarginPct: 0.62 },
    ],
  };
  return { ...base, ...overrides };
}

describe('FinancialQuarterSchema', () => {
  it('parses a complete statement and keeps every block', () => {
    const parsed = FinancialQuarterSchema.parse(statement());
    expect(parsed.income.revenueBySource).toBeDefined();
    expect(parsed.income.opexByLine).toBeDefined();
    expect(parsed.productLines).toHaveLength(1);
  });

  it('parses a filed statement whose optional blocks are absent, and never defaults them to zero', () => {
    const filed = filedFinancialQuarter(statement());
    const parsed = FinancialQuarterSchema.parse(filed);
    expect(parsed.income.revenueBySource).toBeUndefined();
    expect(parsed.income.opexByLine).toBeUndefined();
    expect(parsed.productLines).toBeUndefined();
    expect('revenueBySource' in parsed.income).toBe(false);
  });

  it('rejects a negative figure on a field that cannot be negative', () => {
    const bad = statement();
    expect(() => FinancialQuarterSchema.parse({ ...bad, balance: { ...bad.balance, cashUsd: -1 } })).toThrow();
    expect(() => FinancialQuarterSchema.parse({ ...bad, income: { ...bad.income, cogsUsd: -1 } })).toThrow();
  });

  it('allows a signed figure where a loss is real: equity, net income and the chain adjustment', () => {
    const loss = statement({
      income: {
        ...statement().income,
        grossProfitUsd: -100_000,
        ebitdaUsd: -560_000,
        operatingIncomeUsd: -600_000,
        interestUsd: 20_000,
        taxUsd: 0,
        netIncomeUsd: -620_000,
        revenueUsd: 300_000,
        cogsUsd: 400_000,
        opexUsd: 500_000,
        revenueBySource: { productsUsd: 200_000, contractsUsd: 150_000, otherUsd: -50_000 },
      },
      balance: { ...statement().balance, equityUsd: -1_000_000 },
    });
    const parsed = FinancialQuarterSchema.parse(loss);
    expect(parsed.income.netIncomeUsd).toBeLessThan(0);
    expect(parsed.balance.equityUsd).toBeLessThan(0);
  });

  it('keeps the market figures nullable, because an unlisted company has no price', () => {
    const unlisted = statement();
    const parsed = FinancialQuarterSchema.parse({
      ...unlisted,
      kpis: { ...unlisted.kpis, marketCapUsd: null, sharePriceUsd: null },
    });
    expect(parsed.kpis.sharePriceUsd).toBeNull();
    expect(parsed.kpis.marketCapUsd).toBeNull();
  });

  it('bounds the series on the company and leaves world-version-1 saves without the key', () => {
    expect(FINANCIAL_HISTORY_QUARTERS).toBe(40);
    const tooMany = Array.from({ length: FINANCIAL_HISTORY_QUARTERS + 1 }, (_, index) => statement({ quarter: index }));
    const company = CompanySchema.parse(minimalCompany());
    // A save written before this field existed parses with the key ABSENT, not
    // as an empty array: a defaulted array would change the frozen world's hash.
    expect(company.financialHistory).toBeUndefined();
    expect('financialHistory' in company).toBe(false);
    expect(() => CompanySchema.parse({ ...minimalCompany(), financialHistory: tooMany })).toThrow();
    expect(CompanySchema.parse({ ...minimalCompany(), financialHistory: tooMany.slice(1) }).financialHistory).toHaveLength(
      FINANCIAL_HISTORY_QUARTERS,
    );
  });
});

/* -------------------------------------------------------------------------- */
/*  Identities                                                                 */
/* -------------------------------------------------------------------------- */

describe('financialQuarterReconciles', () => {
  it('passes a statement whose identities all hold', () => {
    expect(financialQuarterReconciles(statement())).toBe(true);
  });

  it('still passes after the filing redaction, which removes rather than rewrites', () => {
    expect(financialQuarterReconciles(filedFinancialQuarter(statement()))).toBe(true);
  });

  it('fails when assets less liabilities no longer equals equity', () => {
    const broken = statement();
    expect(financialQuarterReconciles({ ...broken, balance: { ...broken.balance, equityUsd: 1_800_000 } })).toBe(false);
  });

  it('fails when the cash-flow net change is not the cash the quarter moved', () => {
    const broken = statement();
    expect(financialQuarterReconciles({ ...broken, cashFlow: { ...broken.cashFlow, netChangeUsd: 199_000 } })).toBe(false);
  });

  it('fails when the revenue split does not sum to revenue', () => {
    const broken = statement();
    expect(
      financialQuarterReconciles({
        ...broken,
        income: { ...broken.income, revenueBySource: { productsUsd: 800_000, contractsUsd: 250_000, otherUsd: 0 } },
      }),
    ).toBe(false);
  });

  it('tolerates rounding up to one dollar and no further', () => {
    const broken = statement();
    const within = { ...broken, balance: { ...broken.balance, equityUsd: 1_900_000 + FINANCIAL_STATEMENT_TOLERANCE_USD } };
    const beyond = { ...broken, balance: { ...broken.balance, equityUsd: 1_900_000 + FINANCIAL_STATEMENT_TOLERANCE_USD + 0.5 } };
    expect(financialQuarterReconciles(within)).toBe(true);
    expect(financialQuarterReconciles(beyond)).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/*  Redaction                                                                  */
/* -------------------------------------------------------------------------- */

describe('filedFinancialQuarter', () => {
  it('drops exactly the three internal blocks and rewrites nothing else', () => {
    const full = statement();
    const filed = filedFinancialQuarter(full);

    expect(filed.income.revenueBySource).toBeUndefined();
    expect(filed.income.opexByLine).toBeUndefined();
    expect(filed.productLines).toBeUndefined();

    expect(filed.quarter).toBe(full.quarter);
    expect(filed.balance).toEqual(full.balance);
    expect(filed.cashFlow).toEqual(full.cashFlow);
    expect(filed.kpis).toEqual(full.kpis);
    expect(filed.income.revenueUsd).toBe(full.income.revenueUsd);
    expect(filed.income.cogsUsd).toBe(full.income.cogsUsd);
    expect(filed.income.opexUsd).toBe(full.income.opexUsd);
    expect(filed.income.netIncomeUsd).toBe(full.income.netIncomeUsd);
  });

  it('is idempotent, so a twice-projected statement is the same statement', () => {
    const once = filedFinancialQuarter(statement());
    expect(filedFinancialQuarter(once)).toEqual(once);
  });

  it('does not mutate the statement it was given', () => {
    const full = statement();
    filedFinancialQuarter(full);
    expect(full.income.revenueBySource).toBeDefined();
    expect(full.productLines).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------- */
/*  Fixture                                                                    */
/* -------------------------------------------------------------------------- */

/** The smallest company `CompanySchema` accepts, for the parse tests above. */
function minimalCompany(): Record<string, unknown> {
  return {
    id: 'cmp_test',
    name: 'Test Company',
    ticker: null,
    archetype: 'enterprise_ai',
    tier: 'significant',
    isPublic: false,
    controllerPlayerId: null,
    sectorId: 'sec_ai',
    foundedQuarter: 0,
    headquartersCity: 'Zurich',
    isActive: true,
    products: [],
    employees: { engineers: 10, researchers: 2, sales: 3, ops: 2, execs: 1, avgComp: 200_000, morale: 60, attrition: 0.05, openRoles: 0 },
    compute: {
      ownedAccelerators: 0,
      reservedAccelerators: 0,
      reservationExpiryQuarter: null,
      cloudSpendQuarterly: 0,
      computeUtilisation: 0.5,
      trainingAllocation: 0.4,
    },
    offices: [],
    financials: {
      revenueQuarterly: 0,
      cogs: 0,
      payroll: 0,
      marketing: 0,
      rdSpend: 0,
      capex: 0,
      interestExpense: 0,
      cash: 0,
      debt: 0,
      quarterlyBurn: 0,
      deferredRevenue: 0,
      backlogUsd: 0,
    },
    balanceSheet: {
      assets: { cash: 0, ppe: 0, goodwill: 0, investments: 0, receivables: 0 },
      liabilities: { debt: 0, payables: 0, deferredRevenue: 0 },
      equity: 0,
    },
    posture: 'balanced',
    riskTolerance: 0.5,
    techCapabilities: {},
    governmentPastPerformance: 50,
    reputation: { public: 50, developer: 50, enterprise: 50, government: 50, investor: 50 },
    boardId: null,
    primarySecurityId: null,
    instrumentId: null,
    ceoCharacterId: null,
    parentCompanyId: null,
  };
}
