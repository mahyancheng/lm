/**
 * @frontier/simulation — lookups.ts
 *
 * The Chief of Staff going and looking.
 *
 * The dossier is a snapshot of the founder's own company, and "buy a small data
 * centre" is not a question a snapshot answers. It needs the market: who sells,
 * at what price, with how much to spare, and what the purchase does to the
 * balance. This module is the one place that question is answered, and it is
 * answered here — inside the engine — rather than by the model, because the
 * model is not allowed to read state and an answer computed anywhere else would
 * be a second copy of the validator's arithmetic.
 *
 * Three rules run through every kind:
 *
 * - **Reuse, never restate.** The compute rows come from `sellersFor`, the same
 *   function `resolveComputeSeller` picks a counterparty with; the hiring rows
 *   come from `quarterlyHireCostUsd`; the reservation ceiling comes from
 *   `reservableUnits`. A bound quoted here is a bound the validator enforces,
 *   because it is literally the same call.
 * - **Every row carries its ids, and most carry the action.** A row the model
 *   can quote is a row the founder can approve. Where a legal intent exists it
 *   is on the row, already in the shape `validateAction` accepts.
 * - **Affordability is never a gate.** Since the solvency stage cash notes an
 *   instruction, it does not refuse one, so rows say where the balance lands and
 *   what the solvency clock reads and let the founder decide.
 *
 * Pure: no RNG, no clock, no mutation. Same state, same requests, same answers.
 */

import type {
  AcquisitionTargetRow,
  ActionIntent,
  CapitalDeskRow,
  Company,
  ComputeSellerRow,
  HiringRow,
  LaunchableLineRow,
  LookupRequest,
  LookupResult,
  ProgrammeRow,
  SessionState,
  StaffRole,
  StatementRow,
  SupplierOfferRow,
  SupplyCustomerRow,
} from '@frontier/contracts';
import { COMP_BANDS, MAX_LOOKUPS_PER_TURN, MAX_LOOKUP_ROWS, STAFF_ROLES } from '@frontier/contracts';
import {
  ACCELERATOR_UNIT_PRICE_USD,
  CLOUD_UNIT_COST_USD_PER_QUARTER,
  ENERGY_USD_PER_ACCELERATOR_QUARTER,
  PPE_DEPRECIATION_PER_QUARTER,
  RESERVED_UNIT_COST_USD_PER_QUARTER,
  SOLVENCY_NEGATIVE_QUARTERS,
} from './companies/balance';
import { negativeCashQuarters, solvencyLine } from './companies/solvency';
import { recentFinancialQuarters } from './companies/history';
import { sellersFor, type ComputeSeller } from './companies/sellers';
import { heldComputeUnits } from './companies/products';
import { lastQuarterNetIncomeUsd } from './companies/financials';
import { fillRate } from './companies/hiring';
import { regionOf } from './economy/regions';
import { quarterlyHireCostUsd, reservableUnits } from './validator/rules';
import { companyEnergyCostFactor } from './economy/regions';
import { launchableLines } from './companies/categories';
import { customersFor, suppliersFor } from './companies/supply';
import { isMultiSectorWorld } from './economy/sectors';

/* -------------------------------------------------------------------------- */
/*  Small shared helpers                                                       */
/* -------------------------------------------------------------------------- */

const whole = (value: number): number => (Number.isFinite(value) ? Math.round(value) : 0);
const positive = (value: number): number => Math.max(0, whole(value));
const clip = (value: string): string => value.slice(0, 200);

/** How many people a headcount is, as the band the public record would report. */
function headcountBand(total: number): string {
  if (total < 10) return 'under 10';
  if (total < 50) return '10-50';
  if (total < 200) return '50-200';
  if (total < 1_000) return '200-1,000';
  if (total < 5_000) return '1,000-5,000';
  return 'over 5,000';
}

function totalHeadcountOf(company: Company): number {
  const staff = company.employees;
  return staff.engineers + staff.researchers + staff.sales + staff.ops + staff.execs;
}

/** The row a company's cash lands on after a commitment, with the clock if it is below zero. */
function cashAfter(company: Company, spendUsd: number): { afterUsd: number; line: string } {
  const afterUsd = whole(company.financials.cash - spendUsd);
  return { afterUsd, line: clip(solvencyLine(negativeCashQuarters(company), afterUsd) ?? '') };
}

/** What the market currently says a company is worth, from the quote or the anchor. */
function indicativeValueUsd(draft: SessionState, company: Company): number {
  const metrics = draft.companyMetrics.find((entry) => entry.companyId === company.id);
  if (metrics !== undefined && metrics.marketCapUsd > 0) return positive(metrics.marketCapUsd);
  const anchor = draft.valuationAnchors.find((entry) => entry.companyId === company.id);
  if (anchor !== undefined && anchor.anchorValueUsd > 0) return positive(anchor.anchorValueUsd);
  return positive(company.financials.revenueQuarterly * 4 * 3);
}

/** Last quarter's operating income, from the figures the company filed. */
function lastOperatingIncomeUsd(company: Company): number {
  const f = company.financials;
  return whole(f.revenueQuarterly - f.cogs - f.payroll - f.marketing - f.rdSpend);
}

/* -------------------------------------------------------------------------- */
/*  compute_market                                                             */
/* -------------------------------------------------------------------------- */

/**
 * One seller as the wire row, with the action that buys from it already built.
 *
 * A reservation row is capped a second time, at `reservableUnits` — the same
 * ceiling `reserveCompute` applies for the market as a whole. Without it the row
 * would quote a bound the validator immediately tightens, which is the one thing
 * a sourced figure may never do.
 */
function sellerRow(draft: SessionState, seller: ComputeSeller, units: number): ComputeSellerRow {
  const available =
    seller.offering === 'reservation' ? Math.min(seller.sellableUnits, reservableUnits(draft)) : seller.sellableUnits;
  const wanted = Math.min(Math.max(1, units), available);
  const intent: ActionIntent | null =
    seller.offering === 'accelerators'
      ? { type: 'buy_accelerators', units: wanted, maxPricePerUnitUsd: whole(seller.unitPriceUsd * 1.1), sellerCompanyId: seller.company.id }
      : seller.offering === 'reservation'
        ? {
            type: 'reserve_compute',
            units: wanted,
            quarters: 4,
            maxPricePerUnitUsd: whole(seller.unitPriceUsd * 1.1),
            providerCompanyId: seller.company.id,
          }
        : {
            type: 'buy_cloud_capacity',
            quarterlySpendUsd: whole(wanted * seller.unitPriceUsd),
            providerCompanyId: seller.company.id,
            commitmentQuarters: 0,
          };
  return {
    companyId: seller.company.id,
    name: clip(seller.company.name),
    offering: seller.offering,
    sectorId: clip(seller.company.sectorId),
    region: clip(regionOf(seller.company)),
    unitPriceUsd: positive(seller.unitPriceUsd),
    sellableUnits: positive(available),
    quarterlyCostPerUnitUsd: positive(seller.quarterlyCostPerUnitUsd),
    energyFactorPct: positive(seller.energyFactorPct),
    utilisationPct: positive(seller.utilisationPct),
    intent,
  };
}

/**
 * The compute market, three ways.
 *
 * The three quarterly costs are the whole point of the answer: owning is
 * depreciation plus energy, reserving is rent plus energy, cloud is rent plus
 * energy at a dearer rate. A founder who asks "should I buy a data centre" is
 * asking which of those three lines they would rather carry.
 */
function computeMarket(draft: SessionState, company: Company, askedUnits: number): LookupResult {
  const accelerators = sellersFor(draft, 'accelerators', company.id);
  const reservations = sellersFor(draft, 'reservation', company.id);
  const cloud = sellersFor(draft, 'cloud', company.id);

  const cheapestAccelerator = accelerators[0] ?? null;
  const buyPrice = cheapestAccelerator === null ? ACCELERATOR_UNIT_PRICE_USD : cheapestAccelerator.unitPriceUsd;
  // A size the founder did not name still needs a quote, and the honest default
  // is "as much again as you already hold", floored so a company with nothing
  // still gets a comparison it can read.
  const held = heldComputeUnits(draft, company);
  const units = askedUnits > 0 ? askedUnits : Math.max(10, Math.round(held));

  const energyPerUnit = ENERGY_USD_PER_ACCELERATOR_QUARTER * draft.world.energy.electricityPrice * companyEnergyCostFactor(draft, company);
  const ownedQuarterly = units * (buyPrice * PPE_DEPRECIATION_PER_QUARTER + energyPerUnit);
  const reservedQuarterly =
    units * ((reservations[0]?.unitPriceUsd ?? RESERVED_UNIT_COST_USD_PER_QUARTER * draft.world.compute.reservedPrice) + energyPerUnit);
  const cloudQuarterly = units * ((cloud[0]?.unitPriceUsd ?? CLOUD_UNIT_COST_USD_PER_QUARTER * draft.world.compute.spotPrice) + energyPerUnit);

  const purchaseCostUsd = positive(units * buyPrice);
  const after = cashAfter(company, purchaseCostUsd);

  // Cheapest of each market first, then the rest, so the twelve rows the model
  // is allowed are spent on the three real options rather than on one of them.
  const rows: ComputeSellerRow[] = [];
  const pools: readonly (readonly ComputeSeller[])[] = [accelerators, reservations, cloud];
  for (let index = 0; index < MAX_LOOKUP_ROWS; index += 1) {
    let added = false;
    for (const pool of pools) {
      const seller = pool[index];
      if (seller === undefined) continue;
      if (rows.length >= MAX_LOOKUP_ROWS) break;
      rows.push(sellerRow(draft, seller, units));
      added = true;
    }
    if (!added || rows.length >= MAX_LOOKUP_ROWS) break;
  }

  const cheapest = cheapestAccelerator === null ? null : cheapestAccelerator.company.name;
  return {
    kind: 'compute_market',
    summary: clip(
      cheapest === null
        ? `Nobody is selling accelerators outright this quarter; ${reservations.length} companies will reserve capacity and ${cloud.length} will rent it.`
        : `${units} accelerators cost ${whole(units * buyPrice)} dollars bought outright from ${cheapest}, against ${whole(reservedQuarterly)} a quarter reserved and ${whole(cloudQuarterly)} a quarter on cloud.`,
    ),
    units: positive(units),
    ownedUnits: positive(company.compute.ownedAccelerators),
    reservedUnits: positive(company.compute.reservedAccelerators),
    cloudUnits: positive(held - company.compute.ownedAccelerators - company.compute.reservedAccelerators),
    heldUnits: positive(held),
    ownedQuarterlyCostUsd: positive(ownedQuarterly),
    reservedQuarterlyCostUsd: positive(reservedQuarterly),
    cloudQuarterlyCostUsd: positive(cloudQuarterly),
    purchaseCostUsd,
    cashUsd: whole(company.financials.cash),
    cashAfterPurchaseUsd: after.afterUsd,
    solvencyLine: after.line,
    sellers: rows,
  };
}

/* -------------------------------------------------------------------------- */
/*  acquisition_targets                                                        */
/* -------------------------------------------------------------------------- */

function acquisitionTargets(
  draft: SessionState,
  company: Company,
  filter: { sector: string; region: string; maxValueUsd: number; keyword: string },
): LookupResult {
  const keyword = filter.keyword.trim().toLowerCase();
  const rows: AcquisitionTargetRow[] = [];
  for (const target of draft.companies) {
    if (!target.isActive || target.id === company.id) continue;
    if (filter.sector.length > 0 && target.sectorId !== filter.sector) continue;
    if (filter.region.length > 0 && regionOf(target) !== filter.region) continue;
    if (keyword.length > 0 && !target.name.toLowerCase().includes(keyword)) continue;
    const price = indicativeValueUsd(draft, target);
    if (filter.maxValueUsd > 0 && price > filter.maxValueUsd) continue;
    const after = cashAfter(company, price);
    rows.push({
      companyId: target.id,
      name: clip(target.name),
      sectorId: clip(target.sectorId),
      region: clip(regionOf(target)),
      listed: target.ticker !== null,
      ticker: clip(target.ticker ?? ''),
      // A private company discloses nothing, so nothing is stated for one.
      lastPublicRevenueUsd: target.ticker === null ? 0 : whole(target.financials.revenueQuarterly),
      headcountBand: headcountBand(totalHeadcountOf(target)),
      ownedAccelerators: positive(target.compute.ownedAccelerators),
      indicativePriceUsd: price,
      cashAfterUsd: after.afterUsd,
      solvencyLine: after.line,
      // All cash, because that is the shape of the question "can I buy this".
      // The founder may switch it to stock on the deal desk before approving.
      intent: { type: 'acquire_company', targetCompanyId: target.id, offerValueUsd: Math.max(1, price), cashPct: 1, stockPct: 0 },
    });
  }
  rows.sort((a, b) => a.indicativePriceUsd - b.indicativePriceUsd || (a.companyId < b.companyId ? -1 : 1));
  const shown = rows.slice(0, MAX_LOOKUP_ROWS);
  return {
    kind: 'acquisition_targets',
    summary: clip(
      shown.length === 0
        ? 'No active company matches that description.'
        : `${rows.length} companies match; the cheapest is ${shown[0]?.name ?? ''} at about ${shown[0]?.indicativePriceUsd ?? 0} dollars.`,
    ),
    cashUsd: whole(company.financials.cash),
    rows: shown,
  };
}

/* -------------------------------------------------------------------------- */
/*  debt_headroom                                                              */
/* -------------------------------------------------------------------------- */

function debtHeadroom(draft: SessionState, company: Company): LookupResult {
  // The same conservative rule the dossier states, kept in one place: a year of
  // revenue scaled by how open the debt market is, less what is already owed.
  const availability = draft.world.capitalMarkets.debtAvailability;
  const headroomUsd = positive(Math.max(0, company.financials.revenueQuarterly) * 4 * availability - company.financials.debt);
  const couponPct = positive((draft.world.macro.policyRate + draft.world.macro.creditSpreads + 0.03) * 100);
  const operating = lastOperatingIncomeUsd(company);
  const servisableUsd = couponPct <= 0 ? headroomUsd : positive((Math.max(0, operating) * 4) / (couponPct / 100));

  const desks: CapitalDeskRow[] = (draft.capitalEntities ?? []).slice(0, MAX_LOOKUP_ROWS).map((entity) => ({
    entityId: entity.id,
    name: clip(entity.name),
    kind: clip(entity.kind),
    dryPowderUsd: positive(entity.dryPowderUsd),
    holdsStakePct: 0,
    thesis: clip(entity.thesis),
  }));

  return {
    kind: 'debt_headroom',
    summary: clip(
      headroomUsd <= 0
        ? 'The balance sheet supports no further debt at the current revenue and what is already owed.'
        : `About ${headroomUsd} dollars of headroom at an indicative ${couponPct}% coupon.`,
    ),
    available: headroomUsd > 0,
    reason: clip(headroomUsd > 0 ? '' : 'Revenue times the debt market\'s appetite is already covered by the debt outstanding.'),
    headroomUsd,
    indicativeCouponPct: couponPct,
    servisableUsd,
    lastOperatingIncomeUsd: operating,
    desks,
    intent:
      headroomUsd > 0
        ? { type: 'issue_debt', amountUsd: headroomUsd, maxRatePct: Math.min(0.5, couponPct / 100 + 0.02), termQuarters: 12 }
        : null,
  };
}

/* -------------------------------------------------------------------------- */
/*  government_programmes                                                      */
/* -------------------------------------------------------------------------- */

function governmentProgrammes(draft: SessionState, company: Company): LookupResult {
  const rows: ProgrammeRow[] = [];
  for (const opportunity of draft.procurementOpportunities) {
    if (opportunity.status !== 'open' || draft.quarter > opportunity.closeQuarter) continue;
    if (opportunity.visibility !== 'public' && !opportunity.invitedCompanyIds.includes(company.id)) continue;
    const requirements = opportunity.requirements;
    const met: string[] = [];
    const unmet: string[] = [];
    (company.governmentPastPerformance >= requirements.minimumPastPerformance ? met : unmet).push(
      `past performance ${Math.round(company.governmentPastPerformance)} against ${Math.round(requirements.minimumPastPerformance)} required`,
    );
    (company.compute.ownedAccelerators + company.compute.reservedAccelerators > 0 ? met : unmet).push(
      requirements.domesticInference ? 'inference on infrastructure we control' : 'no infrastructure requirement',
    );
    if (requirements.modelAudit) unmet.push('an independent model audit');
    const agency = draft.agencies?.find((entry) => entry.id === opportunity.agencyId);
    rows.push({
      opportunityId: opportunity.id,
      programme: clip(opportunity.programme),
      agencyName: clip(agency?.name ?? ''),
      maxValueUsd: positive(opportunity.maxValue),
      closeQuarter: opportunity.closeQuarter,
      requirementsMet: met.slice(0, 8).map(clip),
      requirementsUnmet: unmet.slice(0, 8).map(clip),
      // The bid itself is a long form with its own screen; a lookup names the
      // opportunity and leaves the shape of the bid to the Government screen.
      intent: null,
    });
    if (rows.length >= MAX_LOOKUP_ROWS) break;
  }
  return {
    kind: 'government_programmes',
    summary: clip(
      rows.length === 0
        ? 'Nothing this company can see is still accepting bids.'
        : `${rows.length} programmes are open, the largest at ${Math.max(...rows.map((row) => row.maxValueUsd))} dollars.`,
    ),
    pastPerformance: positive(company.governmentPastPerformance),
    rows,
  };
}

/* -------------------------------------------------------------------------- */
/*  hiring_market                                                              */
/* -------------------------------------------------------------------------- */

function hiringMarket(draft: SessionState, company: Company, role: StaffRole | null): LookupResult {
  const roles: readonly StaffRole[] = role === null ? STAFF_ROLES : [role];
  const rows: HiringRow[] = [];
  for (const entry of roles) {
    for (const band of COMP_BANDS) {
      if (rows.length >= MAX_LOOKUP_ROWS) break;
      const quarterly = positive(quarterlyHireCostUsd(draft, entry, band));
      rows.push({
        role: entry,
        band,
        quarterlyCostUsd: quarterly,
        annualCostUsd: quarterly * 4,
        intent: { type: 'hire', role: entry, count: 1, compBand: band },
      });
    }
  }
  // The market's own fill rate at the middle band, which is what "how fast can
  // we hire" actually means. Read from the hiring phase, never restated.
  const fill = fillRate(draft, company, roles[0] ?? 'engineers', 'market');
  return {
    kind: 'hiring_market',
    summary: clip(`The market fills about ${Math.round(fill * 100)}% of an opened role a quarter at the market band.`),
    fillRatePct: positive(fill * 100),
    openRoles: positive(company.employees.openRoles),
    rows,
  };
}

/* -------------------------------------------------------------------------- */
/*  own_position                                                               */
/* -------------------------------------------------------------------------- */

function ownPosition(company: Company): LookupResult {
  const burn = whole(company.financials.quarterlyBurn);
  const runway = burn >= 0 ? 40 : Math.max(0, Math.floor(company.financials.cash / Math.abs(burn)));
  const statements: StatementRow[] = recentFinancialQuarters(company, 4).map((entry) => ({
    quarter: entry.quarter,
    revenueUsd: whole(entry.income.revenueUsd),
    netIncomeUsd: whole(entry.income.netIncomeUsd),
    cashUsd: whole(entry.balance.cashUsd),
    headcount: positive(entry.kpis.headcount),
  }));
  const quarters = negativeCashQuarters(company);
  return {
    kind: 'own_position',
    summary: clip(
      `${whole(company.financials.cash)} dollars of cash, moving ${burn} a quarter, ${runway} quarters of runway${
        quarters > 0 ? `, and ${quarters} quarter${quarters === 1 ? '' : 's'} already closed below zero` : ''
      }.`,
    ),
    cashUsd: whole(company.financials.cash),
    quarterlyBurnUsd: burn,
    runwayQuarters: positive(runway),
    negativeCashQuarters: positive(quarters),
    solvencyQuartersAllowed: SOLVENCY_NEGATIVE_QUARTERS,
    statements,
  };
}

/* -------------------------------------------------------------------------- */
/*  launchable_lines                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Every line in the company's own sector, open now or waiting on a node —
 * `launchableLines` runs the identical `dependencySatisfied` test the
 * validator's `launch_product` rule does, so a row marked open here is a row
 * the validator actually accepts. Absent (empty) in world version 1, which has
 * no catalogue at all.
 */
function launchableLinesLookup(draft: SessionState, company: Company): LookupResult {
  if (!isMultiSectorWorld(draft)) {
    return { kind: 'launchable_lines', summary: clip('This world has no industry catalogue; only the four legacy segments exist.'), rows: [] };
  }
  const lines = launchableLines(draft, company).slice(0, MAX_LOOKUP_ROWS);
  const rows: LaunchableLineRow[] = lines.map(({ category, locked, missingNodeIds }) => ({
    categoryId: category.id,
    label: clip(category.label),
    sectorId: clip(category.sector),
    unitLabel: clip(category.unitLabel),
    referencePriceUsd: positive(category.referencePriceUsd),
    locked,
    missingNodeTitles: missingNodeIds.slice(0, 4).map((nodeId) => clip(draft.techGraph.nodes.find((node) => node.id === nodeId)?.title ?? nodeId)),
    intent: locked
      ? null
      : {
          type: 'launch_product',
          name: `${category.label} line`,
          segment: category.buyerSegment,
          categoryId: category.id,
          pricePerSeatUsd: positive(category.referencePriceUsd),
          computeIntensity: category.computeIntensityBaseline,
          launchMarketingUsd: 0,
          targetQuality: 0.5,
          supply: [],
        },
  }));
  const open = rows.filter((row) => !row.locked).length;
  return {
    kind: 'launchable_lines',
    summary: clip(
      rows.length === 0
        ? 'No industry lines are catalogued for this sector.'
        : `${open} of ${rows.length} lines in ${company.sector ?? 'this sector'} are open to launch now.`,
    ),
    rows,
  };
}

/* -------------------------------------------------------------------------- */
/*  suppliers                                                                  */
/* -------------------------------------------------------------------------- */

/** Every company whose published terms would sell `company` this input right now, best quality per dollar first, from `suppliersFor`. */
function suppliersLookup(draft: SessionState, company: Company, inputCategoryId: string, productId: string | null): LookupResult {
  const offers = suppliersFor(draft, company.id, inputCategoryId).slice(0, MAX_LOOKUP_ROWS);
  const rows: SupplierOfferRow[] = offers.map((offer) => ({
    companyId: offer.company.id,
    name: clip(offer.company.name),
    productId: offer.product.id,
    productName: clip(offer.product.name),
    pricePerUnitUsd: positive(offer.pricePerUnitUsd),
    qualityScorePct: positive(offer.qualityScore * 100),
    isDirectRival: offer.isDirectRival,
    intent:
      productId === null
        ? null
        : { type: 'choose_supplier', productId, inputCategoryId, supplierCompanyId: offer.company.id, supplierProductId: offer.product.id },
  }));
  const label = inputCategoryId.replace(/_/g, ' ');
  return {
    kind: 'suppliers',
    summary: clip(
      rows.length === 0
        ? `Nobody currently publishes ${label} open to us.`
        : `${rows.length} compan${rows.length === 1 ? 'y' : 'ies'} would sell us ${label}; best on quality per dollar is ${rows[0]?.name ?? ''}.`,
    ),
    inputCategoryId,
    rows,
  };
}

/* -------------------------------------------------------------------------- */
/*  customers                                                                  */
/* -------------------------------------------------------------------------- */

/** Every company currently building on `productId`, our own published line, from `customersFor`. */
function customersLookup(draft: SessionState, company: Company, productId: string): LookupResult {
  const customers = customersFor(draft, company.id, productId).slice(0, MAX_LOOKUP_ROWS);
  const rows: SupplyCustomerRow[] = customers.map((entry) => ({
    buyerCompanyId: entry.buyerCompany.id,
    buyerName: clip(entry.buyerCompany.name),
    buyerProductName: clip(entry.buyerProduct.name),
    unitsFilled: positive(entry.unitsFilled),
    revenueUsd: positive(entry.revenueUsd),
  }));
  const revenue = rows.reduce((sum, row) => sum + row.revenueUsd, 0);
  return {
    kind: 'customers',
    summary: clip(rows.length === 0 ? 'Nobody is currently building on this line.' : `${rows.length} companies build on this line, worth ${revenue} dollars this quarter.`),
    productId,
    rows,
  };
}

/* -------------------------------------------------------------------------- */
/*  The entry point                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Run the lookups one turn asked for, against canonical state.
 *
 * At most `MAX_LOOKUPS_PER_TURN` are honoured and each kind is answered once:
 * a model that asks for the compute market four times gets it once, and the
 * bound is enforced here rather than trusted to the prompt. Results come back
 * in request order, so the interface can show them in the order they were asked
 * for.
 *
 * A request naming a company that does not exist returns an empty array rather
 * than throwing: a lookup is a question, and the answer to a question about
 * nothing is nothing.
 */
export function runLookups(draft: SessionState, companyId: string, requests: readonly LookupRequest[]): LookupResult[] {
  const company = draft.companies.find((entry) => entry.id === companyId) ?? null;
  if (company === null) return [];
  const seen = new Set<string>();
  const out: LookupResult[] = [];
  for (const request of requests) {
    if (out.length >= MAX_LOOKUPS_PER_TURN) break;
    if (seen.has(request.kind)) continue;
    seen.add(request.kind);
    switch (request.kind) {
      case 'compute_market':
        out.push(computeMarket(draft, company, Math.max(0, Math.round(request.units))));
        break;
      case 'acquisition_targets':
        out.push(
          acquisitionTargets(draft, company, {
            sector: request.sector,
            region: request.region,
            maxValueUsd: Math.max(0, request.maxValueUsd),
            keyword: request.keyword,
          }),
        );
        break;
      case 'debt_headroom':
        out.push(debtHeadroom(draft, company));
        break;
      case 'government_programmes':
        out.push(governmentProgrammes(draft, company));
        break;
      case 'hiring_market':
        out.push(hiringMarket(draft, company, request.role));
        break;
      case 'own_position':
        out.push(ownPosition(company));
        break;
      case 'launchable_lines':
        out.push(launchableLinesLookup(draft, company));
        break;
      case 'suppliers':
        out.push(suppliersLookup(draft, company, request.inputCategoryId, request.productId));
        break;
      case 'customers':
        out.push(customersLookup(draft, company, request.productId));
        break;
      default: {
        const exhaustive: never = request;
        throw new Error(`no lookup for ${String((exhaustive as { kind?: string }).kind)}`);
      }
    }
  }
  return out;
}

/**
 * The reservation ceiling the compute rows are capped at, for a caller that
 * wants to show it beside them. It is `reservableUnits` from the validator, not
 * a restatement of it.
 */
export function reservableUnitsFor(draft: SessionState): number {
  return reservableUnits(draft);
}
