/**
 * @frontier/simulation — markets/valuation.ts
 *
 * Fundamental value: the five methods of `docs/ECONOMY.md` §6, chosen by company
 * maturity, plus the working that produced each number.
 *
 * | Maturity                 | Method                        |
 * |--------------------------|-------------------------------|
 * | Early startup            | `revenue_multiple`            |
 * | Growth company           | `forward_revenue_quality`     |
 * | Mature company           | `earnings_fcf`                |
 * | Infrastructure           | `asset_cashflow_utilisation`  |
 * | Pre-revenue frontier lab | `technology_option_value`     |
 *
 * The anchor is not the price. Prices are pulled toward it over several quarters
 * by the `fundamentalAlpha` term of the return model, and a company can trade at
 * $74 against a $52 anchor for a long time — the gap is what the decomposition
 * explains. `confidence` is how much weight the market puts on the anchor: low
 * confidence (a pre-revenue laboratory) widens the band in which sentiment
 * dominates, which is exactly right.
 *
 * Every method is pure with respect to the draft: it reads, it returns.
 */

import type { Company, CompanyQuarterMetrics, SessionState, ValuationAnchor, ValuationMethod } from '@frontier/contracts';
import { clamp, clamp01, round } from '../economy/util';
import { isMultiSectorWorld } from '../economy/sectors';
import { fundamentalValueUsd } from './fundamentalValue';

/**
 * How much of a world-version-2 anchor is the fundamentals model and how much is
 * the maturity method beside it. The method still carries the things revenue
 * cannot see — option value on the frontier, an infrastructure company's asset
 * base — so it keeps a quarter of the weight rather than being discarded.
 */
export const FUNDAMENTAL_ANCHOR_WEIGHT = 0.75;

/** Baseline revenue multiple by sector, before market and sector indices. */
const SECTOR_BASE_MULTIPLE: Record<string, number> = {
  semiconductors: 8,
  cloud_infrastructure: 7,
  frontier_models: 14,
  enterprise_software: 9,
  consumer_ai: 6,
  data_services: 7,
  defence_tech: 6,
  energy_infrastructure: 5,
};

const DEFAULT_BASE_MULTIPLE = 7;

/** Annual revenue below which a company is treated as pre-revenue. */
const PRE_REVENUE_ANNUAL_USD = 50_000_000;
/** Annual revenue below which a company is an early startup rather than a growth company. */
const EARLY_STAGE_ANNUAL_USD = 50_000_000;
/** Annual revenue above which a profitable, slow-growing company is valued on cash. */
const MATURE_ANNUAL_USD = 500_000_000;

const INFRASTRUCTURE_ARCHETYPES: readonly string[] = ['infrastructure', 'cloud', 'chip_maker'];

/** The named numbers behind a method, kept so the Markets screen can show the working. */
type AnchorInputs = Record<string, number>;

interface Derived {
  readonly annualRevenue: number;
  readonly growth: number;
  readonly grossMargin: number;
  readonly netRetention: number;
  readonly operatingIncome: number;
  readonly freeCashFlow: number;
  readonly netCash: number;
  readonly assetValue: number;
  readonly utilisation: number;
  readonly capability: number;
  readonly discountAdj: number;
  readonly marketMultiple: number;
  readonly baseMultiple: number;
  readonly runwayQuarters: number;
}

function metricsFor(state: SessionState, companyId: string): CompanyQuarterMetrics | null {
  let latest: CompanyQuarterMetrics | null = null;
  for (const metric of state.companyMetrics) {
    if (metric.companyId !== companyId) continue;
    if (latest === null || metric.quarter >= latest.quarter) latest = metric;
  }
  return latest;
}

function derive(state: SessionState, company: Company): Derived {
  const metrics = metricsFor(state, company.id);
  const financials = company.financials;
  const annualRevenue = Math.max(0, metrics?.revenueTtm ?? financials.revenueQuarterly * 4);
  const growth = clamp(metrics?.revenueGrowthYoY ?? 0, -0.9, 5);

  const grossMarginFromPnl = financials.revenueQuarterly > 0 ? (financials.revenueQuarterly - financials.cogs) / financials.revenueQuarterly : 0;
  const grossMargin = clamp01(metrics?.grossMarginPct ?? grossMarginFromPnl);

  const activeProducts = company.products.filter((product) => product.isActive);
  let retentionWeight = 0;
  let retentionSum = 0;
  for (const product of activeProducts) {
    const weight = Math.max(1, product.activeCustomers * product.pricePerSeat);
    retentionWeight += weight;
    retentionSum += weight * (1 + product.growthQuarterly - product.churnQuarterly);
  }
  const netRetention = clamp(retentionWeight > 0 ? retentionSum / retentionWeight : 1, 0.5, 1.6);

  const operatingIncome = financials.revenueQuarterly - financials.cogs - financials.payroll - financials.marketing - financials.rdSpend;
  const depreciation = 0.05 * company.balanceSheet.assets.ppe;
  const freeCashFlow = operatingIncome - financials.interestExpense + depreciation - financials.capex;
  const netCash = financials.cash - financials.debt;
  const assetValue = company.balanceSheet.assets.ppe + company.balanceSheet.assets.investments;

  const capabilityValues = Object.values(company.techCapabilities);
  const capability = capabilityValues.length > 0 ? clamp01(capabilityValues.reduce((a, b) => a + b, 0) / capabilityValues.length) : 0.3;

  const sector = state.sectors[company.sectorId];
  const marketMultiple = clamp(state.world.capitalMarkets.sectorMultiples * (sector?.multiple ?? 1), 0.1, 20);
  const baseMultiple = SECTOR_BASE_MULTIPLE[company.sectorId] ?? DEFAULT_BASE_MULTIPLE;

  // Higher rates and wider spreads discount every future dollar harder.
  const discountAdj = clamp(1 + 5 * (state.world.macro.policyRate + state.world.macro.creditSpreads - 0.05), 0.6, 2.5);

  return {
    annualRevenue,
    growth,
    grossMargin,
    netRetention,
    operatingIncome,
    freeCashFlow,
    netCash,
    assetValue,
    utilisation: clamp01(company.compute.computeUtilisation),
    capability,
    discountAdj,
    marketMultiple,
    baseMultiple,
    runwayQuarters: clamp(metrics?.runwayQuarters ?? 8, 0, 200),
  };
}

/** Which method a company's maturity and archetype call for. */
export function selectValuationMethod(state: SessionState, company: Company): ValuationMethod {
  const derived = derive(state, company);
  if (company.archetype === 'frontier_lab' && derived.annualRevenue < PRE_REVENUE_ANNUAL_USD) return 'technology_option_value';
  if (INFRASTRUCTURE_ARCHETYPES.includes(company.archetype) && company.balanceSheet.assets.ppe > 0) return 'asset_cashflow_utilisation';
  if (derived.operatingIncome > 0 && derived.annualRevenue >= MATURE_ANNUAL_USD && derived.growth < 0.3) return 'earnings_fcf';
  if (derived.annualRevenue >= EARLY_STAGE_ANNUAL_USD) return 'forward_revenue_quality';
  return 'revenue_multiple';
}

function sharesOutstandingFor(state: SessionState, company: Company): number | null {
  const instrument = state.marketInstruments.find((candidate) => candidate.id === company.instrumentId && !candidate.isReference);
  if (instrument?.sharesOutstanding != null && instrument.sharesOutstanding > 0) return instrument.sharesOutstanding;
  const capTable = state.capTables.find((table) => table.companyId === company.id);
  if (capTable !== undefined && capTable.fullyDilutedShares > 0) return capTable.fullyDilutedShares;
  // World version 2 keeps the authoritative total on the company itself, so an
  // unlisted company without a cap table still has a per-share figure.
  if (isMultiSectorWorld(state) && company.fundamentals.sharesOutstanding > 0) return company.fundamentals.sharesOutstanding;
  return null;
}

/**
 * Compute the fundamental anchor for one company.
 *
 * Falls back to a neutral, low-confidence anchor for an unknown company id
 * rather than throwing: the market phase must never take the resolver down.
 */
export function computeValuationAnchor(state: SessionState, companyId: string): ValuationAnchor {
  const company = state.companies.find((candidate) => candidate.id === companyId);
  if (company === undefined) {
    return {
      companyId,
      quarter: state.quarter,
      method: 'revenue_multiple',
      inputs: { unknownCompany: 1 },
      anchorValueUsd: 0,
      perShareValueUsd: null,
      confidence: 0,
    };
  }

  const d = derive(state, company);
  const method = selectValuationMethod(state, company);
  let anchor = 0;
  let confidence = 0.4;
  const inputs: AnchorInputs = {
    annualRevenue: round(d.annualRevenue, 2),
    growth: round(d.growth, 4),
    grossMargin: round(d.grossMargin, 4),
    netRetention: round(d.netRetention, 4),
    baseMultiple: d.baseMultiple,
    marketMultipleIndex: round(d.marketMultiple, 4),
    discountAdj: round(d.discountAdj, 4),
  };

  switch (method) {
    case 'revenue_multiple': {
      // Early startup: a revenue multiple plus probability-weighted growth, where
      // the probability is survival — a company with two quarters of runway does
      // not get to compound.
      const survival = clamp01(d.runwayQuarters / 8);
      const growthFactor = 1 + 0.8 * clamp(d.growth, -0.5, 2) * survival;
      anchor = (d.annualRevenue * d.baseMultiple * d.marketMultiple * growthFactor) / d.discountAdj + Math.max(0, d.netCash);
      confidence = 0.35;
      inputs['survivalProbability'] = round(survival, 4);
      inputs['growthFactor'] = round(growthFactor, 4);
      break;
    }
    case 'forward_revenue_quality': {
      const forwardRevenue = d.annualRevenue * (1 + clamp(d.growth, -0.6, 1.5));
      const qualityAdj = (0.5 + d.grossMargin) * (0.6 + 0.5 * d.netRetention) * (1 + 0.4 * clamp(d.growth, -0.5, 1.5));
      anchor = (forwardRevenue * d.baseMultiple * d.marketMultiple * qualityAdj) / d.discountAdj;
      confidence = 0.55;
      inputs['forwardRevenue'] = round(forwardRevenue, 2);
      inputs['qualityAdj'] = round(qualityAdj, 4);
      break;
    }
    case 'earnings_fcf': {
      const annualFcf = d.freeCashFlow * 4;
      const multiple = clamp(8 + 40 * d.growth, 5, 30);
      const cashValue = (Math.max(0, annualFcf) * multiple) / d.discountAdj;
      // A profitable company is never worth less than a modest multiple of sales.
      const floor = d.annualRevenue * 1.5;
      anchor = Math.max(cashValue, floor) + d.netCash;
      confidence = 0.75;
      inputs['annualFreeCashFlow'] = round(annualFcf, 2);
      inputs['fcfMultiple'] = round(multiple, 4);
      inputs['netCash'] = round(d.netCash, 2);
      break;
    }
    case 'asset_cashflow_utilisation': {
      const annualEbitda = (d.operatingIncome + 0.05 * company.balanceSheet.assets.ppe) * 4;
      const cashMultiple = 5 + 7 * d.utilisation;
      const marketAdj = clamp(0.4 + 0.6 * d.marketMultiple, 0.3, 3);
      const cashValue = (Math.max(0, annualEbitda) * cashMultiple * marketAdj) / d.discountAdj;
      const assetComponent = d.assetValue * (0.55 + 0.55 * d.utilisation);
      anchor = 0.6 * cashValue + 0.4 * assetComponent + d.netCash;
      confidence = 0.65;
      inputs['annualEbitda'] = round(annualEbitda, 2);
      inputs['utilisation'] = round(d.utilisation, 4);
      inputs['assetValue'] = round(d.assetValue, 2);
      break;
    }
    case 'technology_option_value': {
      // Pre-revenue: what the option on the frontier is worth, discounted by how
      // likely this laboratory is to be the one that gets there.
      const capitalRequirement = Math.max(company.financials.rdSpend * 8, Math.max(0, -company.financials.quarterlyBurn) * 8, 50_000_000);
      const strategicProbability = clamp01(
        0.08 + 0.5 * d.capability + 0.2 * (company.reputation.investor / 100) + 0.15 * state.world.capitalMarkets.riskAppetite,
      );
      const payoffMultiple = 4 + 8 * state.world.capitalMarkets.riskAppetite;
      anchor = (strategicProbability * capitalRequirement * payoffMultiple * d.marketMultiple) / d.discountAdj + Math.max(0, company.financials.cash);
      confidence = 0.25;
      inputs['capitalRequirement'] = round(capitalRequirement, 2);
      inputs['strategicProbability'] = round(strategicProbability, 4);
      inputs['payoffMultiple'] = round(payoffMultiple, 4);
      inputs['capability'] = round(d.capability, 4);
      break;
    }
    default: {
      const never: never = method;
      return never;
    }
  }

  // Listed companies disclose quarterly, so the market has more to work with.
  if (company.isPublic) confidence = clamp01(confidence + 0.1);

  // World version 2: the anchor is mostly the fundamentals model — trailing
  // revenue times a sector multiple earned by growth and margin — with the
  // maturity method keeping a quarter of the weight for what revenue cannot see.
  // A company with no trailing revenue keeps its method anchor untouched.
  if (isMultiSectorWorld(state)) {
    const fundamental = fundamentalValueUsd(state, company);
    if (fundamental !== null) {
      anchor = FUNDAMENTAL_ANCHOR_WEIGHT * fundamental.valueUsd + (1 - FUNDAMENTAL_ANCHOR_WEIGHT) * Math.max(0, anchor);
      confidence = clamp01(Math.max(confidence, fundamental.confidence));
      inputs['fundamentalValueUsd'] = fundamental.valueUsd;
      inputs['sectorRevenueMultiple'] = round(fundamental.multiple, 3);
      inputs['fundamentalQuality'] = round(fundamental.quality, 4);
      inputs['trailingRevenueUsd'] = round(fundamental.trailingRevenueUsd, 2);
    }
  }

  const safeAnchor = Number.isFinite(anchor) ? Math.max(0, anchor) : 0;
  const shares = sharesOutstandingFor(state, company);

  return {
    companyId,
    quarter: state.quarter,
    method,
    inputs,
    anchorValueUsd: round(safeAnchor, 2),
    perShareValueUsd: shares === null ? null : round(safeAnchor / shares, 6),
    confidence: round(clamp01(confidence), 4),
  };
}
