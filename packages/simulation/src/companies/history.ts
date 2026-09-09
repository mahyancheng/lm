/**
 * @frontier/simulation — companies/history.ts
 *
 * The filed accounts of every closed quarter.
 *
 * `Financials` is one quarter, overwritten every quarter, which is why the
 * Financials screen could only ever show *this* quarter. This module keeps the
 * quarters that have closed as a bounded series on the company, so a trend is
 * read rather than re-derived.
 *
 * ## Where the numbers come from
 *
 * Nowhere new. `appendFinancialQuarter` is handed the figures the financial
 * phase has just computed and does no economics of its own: it restates them
 * flat, derives the three totals the identities require, and files them. Any
 * figure recomputed here instead of passed in would be a second opinion, and
 * two opinions on one quarter is exactly the defect the balance-sheet invariant
 * exists to catch.
 *
 * ## Two writes, one statement
 *
 * The financial phase is eleven and the market prices in thirteen, so at the
 * moment the statement is filed the closing share price does not exist yet.
 * `stampMarketKpis` runs in the metrics phase (sixteen) and sets the two market
 * figures on the statement this quarter already filed. It writes nothing else,
 * and it never creates a statement.
 *
 * ## Bounds and gating
 *
 * Written only in a multi-sector world (`isMultiSectorWorld`), because a
 * world-version-1 company that grew a `financialHistory` key would stop hashing
 * to the value the frozen world has always hashed to. The array is trimmed from
 * the front at `FINANCIAL_HISTORY_KEPT_QUARTERS`; the complete series lives in the
 * snapshots and the ledger.
 */

import type { Company, FinancialProductLine, FinancialQuarter } from '@frontier/contracts';
import { FINANCIAL_HISTORY_KEPT_QUARTERS } from '@frontier/contracts';
import { activeProducts, clamp, count, money, signedMoney, totalHeadcount, unit } from './util';
import { categoryOf } from './categories';
import { lineNodeOf } from '../graph/lines';

/**
 * Everything the financial phase already knows, handed over verbatim.
 *
 * Every field is a number that phase computed while resolving the quarter. The
 * statement is assembled from these and from the balance sheet the phase has
 * just rolled forward — nothing else is read, and nothing is recomputed.
 */
export interface FinancialQuarterInput {
  readonly revenueUsd: number;
  readonly productRevenueUsd: number;
  readonly contractRevenueUsd: number;
  readonly cogsUsd: number;
  readonly payrollUsd: number;
  readonly marketingUsd: number;
  readonly researchUsd: number;
  /**
   * World 3's idle-capacity charge: capacity the company owns and production
   * did not absorb. An operating expense with no line of its own, so it lands
   * in `opexByLine.otherUsd` — which is exactly what that remainder is for.
   * Absent (zero) in worlds 1 and 2.
   */
  readonly idleCapacityUsd?: number;
  /**
   * World 3's data-custody charge: what holding the customer data this company
   * has collected costs it this quarter. An operating expense with no line of
   * its own, so it lands in `opexByLine.otherUsd` beside the idle-capacity
   * charge. Absent (zero) in worlds 1 and 2, which collect no data.
   */
  readonly dataCustodyUsd?: number;
  /** Training compute charged to research. Serving compute is inside `cogsUsd`. */
  readonly trainingComputeUsd: number;
  readonly depreciationUsd: number;
  readonly interestUsd: number;
  readonly taxUsd: number;
  readonly netIncomeUsd: number;
  readonly openingCashUsd: number;
  readonly capexUsd: number;
  readonly debtRepaidUsd: number;
  readonly runwayQuarters: number;
}

/**
 * File one closed quarter's accounts on a company.
 *
 * Idempotent by quarter: resolving the same quarter twice replaces the entry
 * rather than filing it again, which is what keeps `resolveQuarter`'s own
 * idempotence intact.
 */
export function appendFinancialQuarter(company: Company, quarter: number, input: FinancialQuarterInput): FinancialQuarter {
  const sheet = company.balanceSheet;
  const history = company.financialHistory ?? [];

  /* --- income ----------------------------------------------------------- */
  const revenue = money(input.revenueUsd);
  const cogs = money(input.cogsUsd);
  const grossProfit = signedMoney(revenue - cogs);
  const payroll = money(input.payrollUsd);
  const marketing = money(input.marketingUsd);
  const research = money(input.researchUsd);
  const idleCapacity = money(input.idleCapacityUsd ?? 0);
  const dataCustody = money(input.dataCustodyUsd ?? 0);
  const opex = money(payroll + marketing + research + idleCapacity + dataCustody);
  const depreciation = money(input.depreciationUsd);
  const operatingIncome = signedMoney(grossProfit - opex);
  const interest = money(input.interestUsd);
  const tax = money(input.taxUsd);

  // The compute inside operating expense is the training half; the serving half
  // is a cost of revenue and is already inside `cogs`. Splitting it out of
  // research rather than adding it beside research is what keeps the five lines
  // summing to the total.
  const opexCompute = money(Math.min(research, input.trainingComputeUsd));
  const opexResearch = money(research - opexCompute);

  /* --- balance ------------------------------------------------------------ */
  // Signed: from world version 2 a company may close a quarter overdrawn, and a
  // statement that floored the balance at zero would report a solvency the
  // company does not have — and break the cash-flow identity below.
  const cash = signedMoney(sheet.assets.cash);
  const receivables = money(sheet.assets.receivables);
  const computeAssets = money(sheet.assets.ppe);
  const otherAssets = money(sheet.assets.goodwill + sheet.assets.investments);
  // The investments half of `otherAssets`, restated rather than added: the
  // portfolio screen needs a carrying value per quarter and goodwill is not one.
  const investments = money(sheet.assets.investments);
  const debt = money(sheet.liabilities.debt);
  const deferred = money(sheet.liabilities.deferredRevenue);
  const otherLiabilities = money(sheet.liabilities.payables);

  /* --- cash flow ---------------------------------------------------------- */
  // The identity, in the order it is asserted: net change is the cash the phase
  // actually moved; investing and financing are the two named outflows; and
  // operating is the remainder, so the three always sum to the movement rather
  // than to an estimate of it.
  const openingCash = signedMoney(input.openingCashUsd);
  const netChange = signedMoney(cash - openingCash);
  const investing = signedMoney(-money(input.capexUsd));
  const financing = signedMoney(-money(input.debtRepaidUsd));
  const operating = signedMoney(netChange - investing - financing);

  /* --- KPIs --------------------------------------------------------------- */
  // Growth is read off this series, not off a rolling estimate: the previous
  // filed quarter is the previous quarter, and four back is a year back.
  const previous = history[history.length - 1] ?? null;
  const yearAgo = history[history.length - 4] ?? null;
  const priorRevenue = previous?.income.revenueUsd ?? 0;
  const priorYearRevenue = yearAgo?.income.revenueUsd ?? 0;

  const lines: FinancialProductLine[] = activeProducts(company)
    .map((product) => {
      // World 3 states the node the line sells and its own unit; world 2 states
      // the category. The units are the ones the demand phase stamped, never a
      // second reading of the customer count — `activeCustomers x price`
      // appeared in six places in world 2 and disagreed with the income
      // statement in two of them.
      const node = lineNodeOf(product);
      const units = count(product.unitsSoldQuarterly ?? product.activeCustomers);
      const category = node === undefined ? categoryOf(company, product) : null;
      return {
        productId: product.id,
        name: product.name,
        segment: product.segment,
        units,
        priceUsd: money(product.pricePerSeat),
        revenueUsd: money(units * money(product.pricePerSeat)),
        grossMarginPct: unit(product.grossMarginPct),
        categoryId: category?.id ?? node?.id ?? '',
        unit: category?.unitLabel ?? node?.unitLabel ?? 'units',
      };
    })
    .sort((a, b) => (a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : 0))
    .slice(0, 64);

  const entry: FinancialQuarter = {
    quarter,
    income: {
      revenueUsd: revenue,
      revenueBySource: {
        productsUsd: money(input.productRevenueUsd),
        contractsUsd: money(input.contractRevenueUsd),
        // The remainder, so the three sources always sum to revenue: the
        // goods-chain uplift and any accord bonus, which may be negative.
        otherUsd: signedMoney(revenue - money(input.productRevenueUsd) - money(input.contractRevenueUsd)),
      },
      cogsUsd: cogs,
      grossProfitUsd: grossProfit,
      opexUsd: opex,
      opexByLine: {
        payrollUsd: payroll,
        researchUsd: opexResearch,
        marketingUsd: marketing,
        computeUsd: opexCompute,
        otherUsd: signedMoney(opex - payroll - opexResearch - marketing - opexCompute),
      },
      ebitdaUsd: signedMoney(operatingIncome + depreciation),
      depreciationUsd: depreciation,
      operatingIncomeUsd: operatingIncome,
      interestUsd: interest,
      taxUsd: tax,
      netIncomeUsd: signedMoney(input.netIncomeUsd),
    },
    balance: {
      cashUsd: cash,
      receivablesUsd: receivables,
      computeAssetsUsd: computeAssets,
      otherAssetsUsd: otherAssets,
      investmentsUsd: investments,
      totalAssetsUsd: signedMoney(cash + receivables + computeAssets + otherAssets),
      debtUsd: debt,
      deferredRevenueUsd: deferred,
      otherLiabilitiesUsd: otherLiabilities,
      totalLiabilitiesUsd: money(debt + deferred + otherLiabilities),
      // Carried from the sheet, never derived from the assets: an imbalance an
      // earlier phase created must survive into the statement and fail the
      // check, exactly as it does on the live sheet.
      equityUsd: signedMoney(sheet.equity),
    },
    cashFlow: {
      openingCashUsd: openingCash,
      operatingUsd: operating,
      investingUsd: investing,
      financingUsd: financing,
      netChangeUsd: netChange,
      endingCashUsd: cash,
    },
    kpis: {
      headcount: count(totalHeadcount(company)),
      grossMarginPct: unit(revenue <= 0 ? 0 : grossProfit / revenue),
      revenueGrowthQoQ: priorRevenue > 0 ? clamp(revenue / priorRevenue - 1, -1, 5) : 0,
      revenueGrowthYoY: priorYearRevenue > 0 ? clamp(revenue / priorYearRevenue - 1, -1, 10) : 0,
      runwayQuarters: clamp(input.runwayQuarters, 0, 200),
      runRateUsd: money(revenue * 4),
      // Stamped by the metrics phase, after the market has priced the quarter.
      marketCapUsd: null,
      sharePriceUsd: null,
    },
    productLines: lines,
  };

  const kept = history.filter((row) => row.quarter !== quarter);
  kept.push(entry);
  kept.sort((a, b) => a.quarter - b.quarter);
  // BOUND: oldest first out. The full series is in the snapshots and the ledger.
  // Trimmed to the KEPT window rather than to the schema's own bound: the schema
  // still accepts the longer series a save written before this may hold, and the
  // engine writes back the shorter one, which is what a quarter can afford to
  // hash eighteen times.
  company.financialHistory =
    kept.length > FINANCIAL_HISTORY_KEPT_QUARTERS ? kept.slice(kept.length - FINANCIAL_HISTORY_KEPT_QUARTERS) : kept;
  return entry;
}

/**
 * Set the two figures the market decides on the statement already filed for
 * this quarter. No-op when nothing was filed — a world that keeps no statements
 * has nothing to stamp.
 */
export function stampMarketKpis(company: Company, quarter: number, marketCapUsd: number, sharePriceUsd: number | null): void {
  const history = company.financialHistory;
  if (history === undefined) return;
  const index = history.findIndex((row) => row.quarter === quarter);
  if (index < 0) return;
  const entry = history[index];
  if (entry === undefined) return;
  history[index] = {
    ...entry,
    kpis: {
      ...entry.kpis,
      marketCapUsd: marketCapUsd > 0 ? money(marketCapUsd) : null,
      sharePriceUsd: sharePriceUsd !== null && sharePriceUsd > 0 ? money(sharePriceUsd) : null,
    },
  };
}

/** The statements a company has filed, oldest first. Empty when it keeps none. */
export function financialHistoryOf(company: Pick<Company, 'financialHistory'>): readonly FinancialQuarter[] {
  return company.financialHistory ?? [];
}

/**
 * The last `count` filed quarters, oldest first.
 *
 * The window a dossier is built from: eight quarters is two years, which is
 * enough to see a trend and short enough to fit in a prompt. Never longer than
 * what was filed, and never padded.
 */
export function recentFinancialQuarters(company: Pick<Company, 'financialHistory'>, count: number): readonly FinancialQuarter[] {
  const history = company.financialHistory ?? [];
  if (count <= 0) return [];
  return history.length <= count ? history : history.slice(history.length - count);
}

/** The statement for one quarter, or null. */
export function financialQuarterOf(company: Pick<Company, 'financialHistory'>, quarter: number): FinancialQuarter | null {
  return (company.financialHistory ?? []).find((row) => row.quarter === quarter) ?? null;
}
