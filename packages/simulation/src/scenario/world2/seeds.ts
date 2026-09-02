/**
 * @frontier/simulation — scenario/world2/seeds.ts
 *
 * The twenty-four rival companies of world version 2, and the arithmetic that
 * turns each one into a `Company`, a cap table, a listing and an opening quote.
 *
 * ## Why so much is derived
 *
 * A seed row here declares only what a designer actually chooses: what the
 * company sells, how fast it is growing, the margin it earns and the balance
 * sheet behind it. Everything a player could check with a calculator — cost of
 * goods, average compensation, net income, the share count, the opening price —
 * is derived from those choices by `deriveCompany`. Hand-authoring both halves
 * is how a scenario ends up with a company whose payroll does not match its
 * headcount and whose market capitalisation does not match its own share count,
 * which the `market_integrity` gate would refuse.
 *
 * ## The opening price is not a guess
 *
 * Each company's opening value is the same calculation the market phase makes
 * every quarter afterwards: trailing revenue times a multiple drawn from its
 * sector's band by `qualityScore`, scaled by the market index, plus net cash.
 * The share count is then chosen so the price lands near a designed figure
 * inside `SHARE_PRICE_BAND_USD`, and the quoted capitalisation is *defined* as
 * price times that count, so the reconciliation is exact rather than close.
 *
 * A company therefore opens at roughly what its own numbers justify, and the
 * first quarter's anchor pull is a nudge rather than a repricing.
 */

import type { CapTable, Company, CompanyQuarterMetrics, MarketInstrument, Quote, Region, Sector, ValuationAnchor, ValuationMethod } from '@frontier/contracts';
import { SHARE_COUNT_LOT, makeId, sharesForMarketCap } from '@frontier/contracts';
import { sectorRevenueMultipleBand } from '../../economy/sectors';
import { clamp, clamp01, lerp } from '../../economy/util';
import { MULTIPLE_INDEX_BOUNDS, qualityScore } from '../../markets/fundamentalValue';

const M = 1_000_000;
const BN = 1_000_000_000;

/** Corporate tax applied to a profitable quarter when rolling trailing earnings. */
const TAX_RATE = 0.21;

/* -------------------------------------------------------------------------- */
/*  Market context the opening valuation is struck against                     */
/* -------------------------------------------------------------------------- */

/**
 * The market multiple index of each market bucket at quarter 0, and the
 * session-wide multiple they are scaled by. These are the same figures the
 * assembled session carries in `sectors` and `world.capitalMarkets`; they live
 * here as well because the opening price has to be computed before the state
 * that holds them exists. `world2.test.ts` asserts the two agree.
 */
export const OPENING_SECTOR_MULTIPLES: Readonly<Record<string, number>> = {
  semiconductors: 1.5,
  cloud_infrastructure: 1.3,
  frontier_models: 1.95,
  enterprise_software: 1.2,
  consumer_ai: 1,
  data_services: 1.1,
  defence_tech: 1.35,
  energy_infrastructure: 1.25,
};

/** Session-wide multiple index at quarter 0 (`world.capitalMarkets.sectorMultiples`). */
export const OPENING_MULTIPLE_INDEX = 1.3;

/** The market index one bucket's band is scaled by. Mirrors `multipleIndex`. */
function marketIndexFor(marketSectorId: string): number {
  const raw = OPENING_MULTIPLE_INDEX * (OPENING_SECTOR_MULTIPLES[marketSectorId] ?? 1);
  return clamp(Math.sqrt(Math.max(0.01, raw)), MULTIPLE_INDEX_BOUNDS.min, MULTIPLE_INDEX_BOUNDS.max);
}

/* -------------------------------------------------------------------------- */
/*  Per-sector shapes                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The capability profile of a company at the top of its sector. A seed's
 * `capabilityLevel` scales this, so one number places a company against its
 * peers instead of twelve.
 */
const SECTOR_CAPABILITIES: Readonly<Record<Sector, Readonly<Record<string, number>>>> = {
  ai: { reasoning: 0.94, agents: 0.82, multimodal: 0.8, training_systems: 0.9, evaluation: 0.74, efficiency: 0.62, safety_alignment: 0.6, infrastructure: 0.68 },
  robotics: { agents: 0.88, multimodal: 0.82, evaluation: 0.72, efficiency: 0.64, hardware_design: 0.76, infrastructure: 0.6, safety_alignment: 0.62 },
  manufacturing: { hardware_design: 0.95, efficiency: 0.88, infrastructure: 0.72, evaluation: 0.62, data_curation: 0.5, security: 0.54 },
  energy: { infrastructure: 0.93, efficiency: 0.8, hardware_design: 0.68, security: 0.62, evaluation: 0.54 },
  logistics: { infrastructure: 0.82, efficiency: 0.86, agents: 0.62, retrieval: 0.58, data_curation: 0.6, security: 0.52 },
  consumer: { multimodal: 0.8, agents: 0.72, retrieval: 0.7, efficiency: 0.62, evaluation: 0.58, data_curation: 0.62 },
};

/**
 * How a sector's audiences differ from its general standing. A grid developer
 * is known to procurement officers and unknown to developers; a consumer brand
 * is the other way round.
 */
const SECTOR_REPUTATION_TILT: Readonly<Record<Sector, Readonly<Record<keyof Company['reputation'], number>>>> = {
  ai: { public: 0, developer: 12, enterprise: -2, government: -8, investor: 8 },
  robotics: { public: -4, developer: 2, enterprise: 8, government: 6, investor: 2 },
  manufacturing: { public: -8, developer: -12, enterprise: 12, government: 8, investor: 0 },
  energy: { public: -2, developer: -16, enterprise: 6, government: 14, investor: 4 },
  logistics: { public: -6, developer: -14, enterprise: 10, government: 4, investor: -4 },
  consumer: { public: 14, developer: -8, enterprise: -6, government: -10, investor: 0 },
};

/** How hard a sector runs the accelerators it has, and how much of that is training. */
const SECTOR_COMPUTE_PROFILE: Readonly<Record<Sector, { readonly utilisation: number; readonly training: number }>> = {
  ai: { utilisation: 0.92, training: 0.7 },
  robotics: { utilisation: 0.78, training: 0.45 },
  manufacturing: { utilisation: 0.7, training: 0.2 },
  energy: { utilisation: 0.62, training: 0.1 },
  logistics: { utilisation: 0.68, training: 0.15 },
  consumer: { utilisation: 0.74, training: 0.25 },
};

/* -------------------------------------------------------------------------- */
/*  Seed shape                                                                 */
/* -------------------------------------------------------------------------- */

export interface V2ProductSeed {
  readonly name: string;
  readonly segment: Company['products'][number]['segment'];
  /** Price of one unit per quarter. Customer count is derived from revenue. */
  readonly price: number;
  readonly churn: number;
  readonly growth: number;
  readonly quality: number;
  readonly intensity: number;
}

export interface V2CompanySeed {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly ticker: string | null;
  readonly archetype: Company['archetype'];
  readonly tier: Company['tier'];
  readonly sector: Sector;
  readonly region: Region;
  /** Market bucket for beta, sentiment and the multiple index. Not the sector. */
  readonly sectorId: string;
  readonly city: string;
  readonly isPublic: boolean;
  /** Designed opening price for a listed name; the share count is chosen to hit it. */
  readonly listPriceUsd: number | null;
  readonly beta: number;
  readonly ceoCharacterId: string;
  readonly boardId: string | null;
  readonly posture: Company['posture'];
  readonly riskTolerance: number;
  /** General standing, 0-100. Audience reputations are tilted off this. */
  readonly standing: number;
  /** Where the company sits against the best in its sector, 0-1. */
  readonly capabilityLevel: number;
  readonly pastPerformance: number;

  // --- economics: what a designer chooses, not what a calculator derives ---
  readonly revenue: number;
  readonly margin: number;
  readonly growthYoY: number;
  readonly payroll: number;
  readonly marketing: number;
  readonly rd: number;
  readonly capex: number;
  readonly interest: number;
  readonly cash: number;
  readonly debt: number;
  readonly deferred: number;
  readonly backlog: number;
  readonly ppe: number;
  readonly goodwill: number;
  readonly investments: number;
  readonly receivables: number;
  readonly payables: number;

  /** engineers, researchers, sales, ops, execs. Average compensation is derived. */
  readonly staff: readonly [number, number, number, number, number];
  readonly morale: number;
  readonly attrition: number;
  /** owned accelerators, reserved accelerators, quarterly cloud spend. */
  readonly compute: readonly [number, number, number];
  readonly product: V2ProductSeed;
  readonly anchorMethod: ValuationMethod;
  readonly controllerPlayerId?: string | null;
  /** Set for the player company, whose valuation cannot be read off revenue alone. */
  readonly anchorFloorUsd?: number;
}

/* -------------------------------------------------------------------------- */
/*  Derivation                                                                 */
/* -------------------------------------------------------------------------- */

/** Whole lots, never zero, so a share count reads cleanly. */
function lotRound(shares: number): number {
  return Math.max(1, Math.round(shares / SHARE_COUNT_LOT)) * SHARE_COUNT_LOT;
}

export interface V2Derived {
  readonly cogs: number;
  readonly headcount: number;
  readonly avgComp: number;
  readonly openRoles: number;
  readonly burn: number;
  readonly revenueTtm: number;
  readonly netIncomeTtm: number;
  readonly quality: number;
  readonly multiple: number;
  /** Fundamental value at quarter 0: the anchor the first quarter pulls toward. */
  readonly valueUsd: number;
  readonly shares: number;
  readonly optionPool: number;
  /** Quoted price for a listed name, or null for a private company. */
  readonly priceUsd: number | null;
  /** Quoted capitalisation for a listed name; the anchor value for a private one. */
  readonly marketCapUsd: number;
}

/**
 * Everything about a company that follows from its seed. Pure and total: the
 * same seed always derives the same numbers, on any machine, in any order.
 */
export function deriveCompany(seed: V2CompanySeed): V2Derived {
  const cogs = Math.round(seed.revenue * (1 - seed.margin));
  const headcount = seed.staff.reduce((total, count) => total + count, 0);
  const avgComp = headcount > 0 ? Math.round((seed.payroll * 4) / headcount) : 0;
  const preTax = seed.revenue - cogs - seed.payroll - seed.marketing - seed.rd - seed.interest;
  const netIncomeTtm = Math.round(preTax > 0 ? preTax * 4 * (1 - TAX_RATE) : preTax * 4);
  const burn = Math.round(preTax - seed.capex);

  const revenueTtm = seed.revenue * 4;
  const quality = qualityScore(seed.growthYoY, seed.margin, seed.sector);
  const band = sectorRevenueMultipleBand(seed.sector);
  const multiple = clamp(lerp(band[0], band[1], quality) * marketIndexFor(seed.sectorId), band[0] * MULTIPLE_INDEX_BOUNDS.min, band[1] * MULTIPLE_INDEX_BOUNDS.max);
  const fundamental = Math.round(revenueTtm * multiple + Math.max(0, seed.cash - seed.debt));
  const valueUsd = Math.max(seed.anchorFloorUsd ?? 0, fundamental);

  const shares = seed.listPriceUsd === null ? sharesForMarketCap(valueUsd) : lotRound(valueUsd / seed.listPriceUsd);
  const optionPool = lotRound(shares * 0.07);
  // The capitalisation is *defined* as price times shares, so the reconciliation
  // the market-integrity gate performs is exact rather than merely close.
  const priceUsd = seed.listPriceUsd === null ? null : Math.round((valueUsd / shares) * 100) / 100;
  const marketCapUsd = priceUsd === null ? valueUsd : priceUsd * shares;

  return { cogs, headcount, avgComp, openRoles: Math.round(headcount * 0.05), burn, revenueTtm, netIncomeTtm, quality, multiple, valueUsd, shares, optionPool, priceUsd, marketCapUsd };
}

/* -------------------------------------------------------------------------- */
/*  Builders                                                                   */
/* -------------------------------------------------------------------------- */

export const SEC = (slug: string): string => `sec_${slug}_common`;
export const SHC = (slug: string): string => `shc_${slug}_common`;
export const INS = (slug: string): string => `ins_${slug}`;
export const FLOAT = (slug: string): string => `float_${slug}`;

function capabilitiesFor(seed: V2CompanySeed): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [area, peak] of Object.entries(SECTOR_CAPABILITIES[seed.sector])) {
    out[area] = Math.round(clamp01(peak * seed.capabilityLevel) * 100) / 100;
  }
  return out;
}

function reputationFor(seed: V2CompanySeed): Company['reputation'] {
  const tilt = SECTOR_REPUTATION_TILT[seed.sector];
  const at = (key: keyof Company['reputation']): number => Math.round(clamp(seed.standing + tilt[key], 0, 100));
  return { public: at('public'), developer: at('developer'), enterprise: at('enterprise'), government: at('government'), investor: at('investor') };
}

/** One company, with its balance sheet closed and its fundamentals seeded. */
export function buildV2Company(seed: V2CompanySeed): Company {
  const d = deriveCompany(seed);
  const profile = SECTOR_COMPUTE_PROFILE[seed.sector];
  const assets = { cash: seed.cash, ppe: seed.ppe, goodwill: seed.goodwill, investments: seed.investments, receivables: seed.receivables };
  const liabilities = { debt: seed.debt, payables: seed.payables, deferredRevenue: seed.deferred };
  const equity = assets.cash + assets.ppe + assets.goodwill + assets.investments + assets.receivables - (liabilities.debt + liabilities.payables + liabilities.deferredRevenue);

  return {
    id: seed.id,
    name: seed.name,
    ticker: seed.ticker,
    archetype: seed.archetype,
    tier: seed.tier,
    isPublic: seed.isPublic,
    controllerPlayerId: seed.controllerPlayerId ?? null,
    sectorId: seed.sectorId,
    sector: seed.sector,
    region: seed.region,
    foundedQuarter: 0,
    headquartersCity: seed.city,
    isActive: true,
    products: [
      {
        id: makeId('prd', seed.slug, 'core'),
        name: seed.product.name,
        segment: seed.product.segment,
        pricePerSeat: seed.product.price,
        // Units are read off revenue and price, so the product line and the
        // income statement can never disagree about how big the business is. A
        // pre-revenue company has no customers, not one rounding artefact.
        activeCustomers: seed.revenue > 0 ? Math.max(1, Math.round(seed.revenue / Math.max(1, seed.product.price))) : 0,
        churnQuarterly: seed.product.churn,
        growthQuarterly: seed.product.growth,
        grossMarginPct: seed.margin,
        computeIntensity: seed.product.intensity,
        qualityScore: seed.product.quality,
        launchedQuarter: 0,
        isActive: true,
      },
    ],
    employees: {
      engineers: seed.staff[0],
      researchers: seed.staff[1],
      sales: seed.staff[2],
      ops: seed.staff[3],
      execs: seed.staff[4],
      avgComp: d.avgComp,
      morale: seed.morale,
      attrition: seed.attrition,
      openRoles: d.openRoles,
    },
    compute: {
      ownedAccelerators: seed.compute[0],
      reservedAccelerators: seed.compute[1],
      reservationExpiryQuarter: seed.compute[1] > 0 ? 4 + (seed.slug.length % 8) : null,
      cloudSpendQuarterly: seed.compute[2],
      computeUtilisation: profile.utilisation,
      trainingAllocation: profile.training,
    },
    offices: [
      {
        id: makeId('off', seed.slug, 'hq'),
        city: seed.city,
        headcountCapacity: Math.max(16, Math.round(d.headcount * 1.2)),
        quarterlyCostUsd: Math.round(d.avgComp * 0.06 * d.headcount),
        openedQuarter: 0,
        isHeadquarters: true,
      },
    ],
    financials: {
      revenueQuarterly: seed.revenue,
      cogs: d.cogs,
      payroll: seed.payroll,
      marketing: seed.marketing,
      rdSpend: seed.rd,
      capex: seed.capex,
      interestExpense: seed.interest,
      cash: seed.cash,
      debt: seed.debt,
      quarterlyBurn: d.burn,
      deferredRevenue: seed.deferred,
      backlogUsd: seed.backlog,
    },
    balanceSheet: { assets, liabilities, equity },
    fundamentals: {
      revenueTtmUsd: d.revenueTtm,
      revenueGrowthQoQ: Math.round((seed.growthYoY / 4) * 100) / 100,
      revenueGrowthYoY: seed.growthYoY,
      grossMarginPct: seed.margin,
      netIncomeTtmUsd: d.netIncomeTtm,
      // Listed names carry the listing's count; private ones carry the register's.
      sharesOutstanding: seed.isPublic ? d.shares : d.shares + d.optionPool,
    },
    posture: seed.posture,
    riskTolerance: seed.riskTolerance,
    techCapabilities: capabilitiesFor(seed),
    governmentPastPerformance: seed.pastPerformance,
    reputation: reputationFor(seed),
    boardId: seed.boardId,
    primarySecurityId: SEC(seed.slug),
    instrumentId: seed.isPublic ? INS(seed.slug) : null,
    ceoCharacterId: seed.ceoCharacterId,
    parentCompanyId: null,
  };
}

/**
 * The institutional blocs. The first six appear on the opening registers, one
 * per region, and were seeded before capital entities existed.
 *
 * The last five are new institutions with no opening holdings whatsoever: they
 * arrive as cash looking for a home, which is both the right story — the
 * incumbents own the past, the newcomers have the dry powder — and the reason
 * every existing world-2 register is unchanged by one share.
 *
 * These ids are load-bearing: a `CapitalEntity.id` **is** the cap-table holder
 * id, so renaming one here would orphan every holding and every director's
 * `representedHolderId` that points at it.
 */
export const V2_FUNDS = {
  seawall: 'fund_seawall',
  tessera: 'fund_tessera',
  kaido: 'fund_kaido',
  indus: 'fund_indus',
  qadr: 'fund_qadr',
  altiplano: 'fund_altiplano',
  // New in the capital-entity roster. No opening holdings.
  ironwood: 'fund_ironwood',
  grantwood: 'fund_grantwood',
  straits: 'fund_straits',
  coldbrook: 'fund_coldbrook',
  perihelion: 'fund_perihelion',
} as const;

/** Which bloc backs a company, by where it is. Deterministic; no draw. */
const FUND_FOR_REGION: Readonly<Record<Region, string>> = {
  north_america: V2_FUNDS.seawall,
  europe: V2_FUNDS.tessera,
  east_asia: V2_FUNDS.kaido,
  south_asia: V2_FUNDS.indus,
  middle_east: V2_FUNDS.qadr,
  latin_america: V2_FUNDS.altiplano,
};

/**
 * The register for one company.
 *
 * Holdings are declared as fractions and the **last** holder takes the residual,
 * so the positions sum to the issued count exactly. Rounding a set of
 * percentages independently is how the ownership invariant gets broken by one
 * share, and it is not worth the risk.
 */
export function buildV2CapTable(seed: V2CompanySeed): CapTable {
  const d = deriveCompany(seed);
  const local = FUND_FOR_REGION[seed.region];
  const crossover = seed.region === 'north_america' ? V2_FUNDS.tessera : V2_FUNDS.seawall;

  const splits: readonly { readonly holderId: string; readonly kind: CapTable['holdings'][number]['holderKind']; readonly fraction: number; readonly costPerShare: number }[] =
    seed.isPublic
      ? [
          { holderId: seed.ceoCharacterId, kind: 'character', fraction: 0.05, costPerShare: 0.4 },
          { holderId: local, kind: 'fund', fraction: 0.11, costPerShare: (d.priceUsd ?? 50) * 0.42 },
          { holderId: crossover, kind: 'fund', fraction: 0.07, costPerShare: (d.priceUsd ?? 50) * 0.71 },
          { holderId: FLOAT(seed.slug), kind: 'public_float', fraction: 0.77, costPerShare: (d.priceUsd ?? 50) * 0.88 },
        ]
      : [
          { holderId: local, kind: 'fund', fraction: 0.24, costPerShare: 2.4 },
          { holderId: crossover, kind: 'fund', fraction: 0.14, costPerShare: 6.1 },
          { holderId: seed.ceoCharacterId, kind: 'character', fraction: 0.62, costPerShare: 0.05 },
        ];

  let assigned = 0;
  const holdings = splits.map((split, index) => {
    const last = index === splits.length - 1;
    const shares = last ? d.shares - assigned : Math.round(d.shares * split.fraction);
    assigned += shares;
    return {
      id: makeId('hld', seed.slug, String(index)),
      holderId: split.holderId,
      holderKind: split.kind,
      securityId: SEC(seed.slug),
      shares,
      costBasisUsd: Math.round(shares * split.costPerShare),
      acquiredQuarter: 0,
      lockupUntilQuarter: null,
      isDisclosed: shares / d.shares >= 0.05,
    };
  });

  return {
    companyId: seed.id,
    shareClasses: [
      {
        id: SHC(seed.slug),
        companyId: seed.id,
        kind: 'common',
        label: 'Common Stock',
        votesPerShare: 1,
        liquidationPreferenceMultiple: 0,
        participating: false,
        authorisedShares: lotRound(d.shares * 1.5) + d.optionPool,
        issuedShares: d.shares,
        createdQuarter: 0,
      },
    ],
    holdings,
    totalIssuedByClass: { [SHC(seed.slug)]: d.shares },
    fullyDilutedShares: d.shares + d.optionPool,
    optionPoolShares: d.optionPool,
    lastUpdatedQuarter: 0,
  };
}

/** The listing for a public company. Private companies have no instrument. */
export function buildV2Instrument(seed: V2CompanySeed): MarketInstrument | null {
  if (!seed.isPublic || seed.ticker === null) return null;
  const d = deriveCompany(seed);
  return {
    id: INS(seed.slug),
    kind: 'in_world_equity',
    symbol: seed.ticker,
    name: seed.name,
    companyId: seed.id,
    securityId: SEC(seed.slug),
    sectorId: seed.sectorId,
    isReference: false,
    currency: 'USD',
    sharesOutstanding: d.shares,
    listedQuarter: 0,
    beta: seed.beta,
  };
}

/**
 * The opening quote. The return is the quarter the company arrived on, not a
 * draw: it is what the tape already showed before the player opened it.
 */
export function buildV2Quote(seed: V2CompanySeed, openingReturn: number): Quote | null {
  if (!seed.isPublic) return null;
  const d = deriveCompany(seed);
  if (d.priceUsd === null) return null;
  return { instrumentId: INS(seed.slug), quarter: 0, price: d.priceUsd, return: openingReturn, volume: Math.round(d.shares * 0.06), marketCapUsd: d.marketCapUsd };
}

/** The quarter-0 metrics row. Trailing figures come from the seeded fundamentals. */
export function buildV2Metrics(seed: V2CompanySeed): CompanyQuarterMetrics {
  const d = deriveCompany(seed);
  const operating = seed.revenue - d.cogs - seed.payroll - seed.marketing - seed.rd;
  const burn = Math.max(0, -d.burn);
  const computeCost = seed.compute[2] + seed.compute[1] * 2_100 + seed.compute[0] * 420;
  const totalCost = d.cogs + seed.payroll + seed.marketing + seed.rd;
  return {
    companyId: seed.id,
    quarter: 0,
    revenueTtm: d.revenueTtm,
    revenueGrowthYoY: seed.growthYoY,
    grossMarginPct: seed.margin,
    operatingMarginPct: seed.revenue > 0 ? clamp(operating / seed.revenue, -10, 1) : 0,
    headcount: d.headcount,
    runwayQuarters: burn <= 0 ? 200 : Math.min(200, seed.cash / burn),
    enterpriseValueUsd: d.valueUsd,
    marketCapUsd: d.marketCapUsd,
    computeCostShare: totalCost > 0 ? clamp01(computeCost / totalCost) : 0,
    governmentRevenueShare: 0,
  };
}

/** The quarter-0 valuation anchor, showing the working the Markets screen prints. */
export function buildV2Anchor(seed: V2CompanySeed): ValuationAnchor {
  const d = deriveCompany(seed);
  return {
    companyId: seed.id,
    quarter: 0,
    method: seed.anchorMethod,
    inputs: {
      forwardRevenue: d.revenueTtm,
      grossMargin: seed.margin,
      cash: seed.cash,
      debt: seed.debt,
      fundamentalValueUsd: d.valueUsd,
      sectorRevenueMultiple: Math.round(d.multiple * 100) / 100,
      qualityScore: Math.round(d.quality * 100) / 100,
    },
    anchorValueUsd: d.valueUsd,
    perShareValueUsd: d.shares > 0 ? d.valueUsd / d.shares : null,
    confidence: seed.isPublic ? 0.66 : 0.44,
  };
}

/* -------------------------------------------------------------------------- */
/*  Identifiers                                                                */
/* -------------------------------------------------------------------------- */

/** Company ids, stable so fixtures, saves and screenshots agree. */
export const W2_COMPANIES = {
  aletheia: 'cmp_aletheia',
  sable: 'cmp_sable',
  basalt: 'cmp_basalt',
  kestrel: 'cmp_kestrel',
  ironvale: 'cmp_ironvale',
  wrenford: 'cmp_wrenford',
  sentinel: 'cmp_sentinel',
  palma: 'cmp_palma',
  tessellate: 'cmp_tessellate',
  halcyon: 'cmp_halcyon',
  cinder: 'cmp_cinder',
  rasan: 'cmp_rasan',
  qanat: 'cmp_qanat',
  volta: 'cmp_volta',
  grimsby: 'cmp_grimsby',
  suryan: 'cmp_suryan',
  harbourline: 'cmp_harbourline',
  overland: 'cmp_overland',
  ganga: 'cmp_ganga',
  dune: 'cmp_dune',
  lumen: 'cmp_lumen',
  tanto: 'cmp_tanto',
  copa: 'cmp_copa',
  vasant: 'cmp_vasant',
  /** The seat a human sits in. Shared with world 1 so the app's ids never move. */
  player: 'cmp_player_ventures',
} as const;

/** Founder ids, one per rival, plus the supporting cast in `people.ts`. */
export const W2_FOUNDERS = {
  aletheia: 'chr_rhea_valdes',
  sable: 'chr_johan_brecht',
  basalt: 'chr_layla_hadid',
  kestrel: 'chr_arjun_menon',
  ironvale: 'chr_hana_morioka',
  wrenford: 'chr_clara_wren',
  sentinel: 'chr_dominic_pryor',
  palma: 'chr_sofia_marchena',
  tessellate: 'chr_wei_lam',
  halcyon: 'chr_annika_stroh',
  cinder: 'chr_mateo_ruiz',
  rasan: 'chr_faisal_noury',
  qanat: 'chr_dana_almasri',
  volta: 'chr_camila_borges',
  grimsby: 'chr_owen_tallis',
  suryan: 'chr_meera_saxena',
  harbourline: 'chr_jun_park',
  overland: 'chr_bill_hargrove',
  ganga: 'chr_ravi_khatri',
  dune: 'chr_yusuf_barakat',
  lumen: 'chr_teresa_nunn',
  tanto: 'chr_akira_sonoda',
  copa: 'chr_lucia_prado',
  vasant: 'chr_neel_bhatia',
} as const;

/* -------------------------------------------------------------------------- */
/*  The twenty-four rivals                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Four companies in each of the six sectors, four in each of the six regions,
 * and eight of the twenty-four listed. Every sector therefore has a supply base
 * — a sector with no companies has supply zero and gates everything downstream
 * to `SUPPLY_GATE_FLOOR` — and every region has someone in it, so a player who
 * starts anywhere has a neighbour and a rival.
 */
export const V2_COMPANY_SEEDS: readonly V2CompanySeed[] = [
  /* --- AI ---------------------------------------------------------------- */
  {
    id: W2_COMPANIES.aletheia,
    slug: 'aletheia',
    name: 'Aletheia Labs',
    ticker: 'ALT',
    archetype: 'frontier_lab',
    tier: 'major',
    sector: 'ai',
    region: 'north_america',
    sectorId: 'frontier_models',
    city: 'Bay Federal District',
    isPublic: true,
    listPriceUsd: 184,
    beta: 1.42,
    ceoCharacterId: W2_FOUNDERS.aletheia,
    boardId: 'brd_aletheia',
    posture: 'research_first',
    riskTolerance: 0.86,
    standing: 62,
    capabilityLevel: 0.96,
    pastPerformance: 54,
    revenue: 1420 * M,
    margin: 0.66,
    growthYoY: 0.42,
    payroll: 260 * M,
    marketing: 150 * M,
    rd: 520 * M,
    capex: 340 * M,
    interest: 14 * M,
    cash: 7.2 * BN,
    debt: 900 * M,
    deferred: 520 * M,
    backlog: 380 * M,
    ppe: 5.4 * BN,
    goodwill: 260 * M,
    investments: 220 * M,
    receivables: 420 * M,
    payables: 1.5 * BN,
    staff: [1050, 690, 260, 640, 70],
    morale: 68,
    attrition: 0.05,
    compute: [36_000, 150_000, 110 * M],
    product: { name: 'Aletheia Reasoning API', segment: 'developer_api', price: 1_600, churn: 0.06, growth: 0.11, quality: 0.92, intensity: 0.88 },
    anchorMethod: 'technology_option_value',
  },
  {
    id: W2_COMPANIES.sable,
    slug: 'sable',
    name: 'Sable Reasoning',
    ticker: null,
    archetype: 'frontier_lab',
    tier: 'significant',
    sector: 'ai',
    region: 'europe',
    sectorId: 'frontier_models',
    city: 'Nordhavn',
    isPublic: false,
    listPriceUsd: null,
    beta: 1.55,
    ceoCharacterId: W2_FOUNDERS.sable,
    boardId: null,
    posture: 'research_first',
    riskTolerance: 0.79,
    standing: 44,
    capabilityLevel: 0.74,
    pastPerformance: 0,
    revenue: 190 * M,
    margin: 0.61,
    growthYoY: 0.55,
    payroll: 96 * M,
    marketing: 22 * M,
    rd: 150 * M,
    capex: 40 * M,
    interest: 3 * M,
    cash: 820 * M,
    debt: 120 * M,
    deferred: 60 * M,
    backlog: 90 * M,
    ppe: 460 * M,
    goodwill: 20 * M,
    investments: 30 * M,
    receivables: 70 * M,
    payables: 130 * M,
    staff: [210, 260, 60, 120, 18],
    morale: 79,
    attrition: 0.04,
    compute: [9_000, 42_000, 26 * M],
    product: { name: 'Sable Assurance Models', segment: 'enterprise', price: 4_200, churn: 0.05, growth: 0.14, quality: 0.84, intensity: 0.76 },
    anchorMethod: 'technology_option_value',
  },
  {
    id: W2_COMPANIES.basalt,
    slug: 'basalt',
    name: 'Basalt Compute',
    ticker: 'BSL',
    archetype: 'infrastructure',
    tier: 'major',
    sector: 'ai',
    region: 'middle_east',
    sectorId: 'cloud_infrastructure',
    city: 'Al-Khalij',
    isPublic: true,
    listPriceUsd: 47,
    beta: 0.95,
    ceoCharacterId: W2_FOUNDERS.basalt,
    boardId: null,
    posture: 'efficiency',
    riskTolerance: 0.52,
    standing: 58,
    capabilityLevel: 0.7,
    pastPerformance: 66,
    revenue: 940 * M,
    margin: 0.57,
    growthYoY: 0.31,
    payroll: 84 * M,
    marketing: 26 * M,
    rd: 44 * M,
    capex: 620 * M,
    interest: 96 * M,
    cash: 1.4 * BN,
    debt: 6.2 * BN,
    deferred: 380 * M,
    backlog: 3.1 * BN,
    ppe: 15.4 * BN,
    goodwill: 180 * M,
    investments: 260 * M,
    receivables: 520 * M,
    payables: 2.1 * BN,
    staff: [560, 30, 90, 420, 22],
    morale: 74,
    attrition: 0.03,
    compute: [420_000, 0, 0],
    product: { name: 'Basalt Reserved Capacity', segment: 'enterprise', price: 5_800, churn: 0.02, growth: 0.07, quality: 0.9, intensity: 0.95 },
    anchorMethod: 'asset_cashflow_utilisation',
  },
  {
    id: W2_COMPANIES.kestrel,
    slug: 'kestrel',
    name: 'Kestrel Data Foundry',
    ticker: null,
    archetype: 'data',
    tier: 'significant',
    sector: 'ai',
    region: 'south_asia',
    sectorId: 'data_services',
    city: 'Indus Gate',
    isPublic: false,
    listPriceUsd: null,
    beta: 1.2,
    ceoCharacterId: W2_FOUNDERS.kestrel,
    boardId: null,
    posture: 'balanced',
    riskTolerance: 0.6,
    standing: 41,
    capabilityLevel: 0.62,
    pastPerformance: 18,
    revenue: 88 * M,
    margin: 0.72,
    growthYoY: 0.38,
    payroll: 28 * M,
    marketing: 9 * M,
    rd: 30 * M,
    capex: 8 * M,
    interest: 1 * M,
    cash: 190 * M,
    debt: 30 * M,
    deferred: 18 * M,
    backlog: 44 * M,
    ppe: 120 * M,
    goodwill: 10 * M,
    investments: 8 * M,
    receivables: 60 * M,
    payables: 40 * M,
    staff: [190, 240, 40, 110, 12],
    morale: 81,
    attrition: 0.04,
    compute: [1_400, 6_000, 7 * M],
    product: { name: 'Kestrel Evaluation Corpora', segment: 'developer_api', price: 1_100, churn: 0.07, growth: 0.1, quality: 0.85, intensity: 0.4 },
    anchorMethod: 'revenue_multiple',
  },

  /* --- Robotics ---------------------------------------------------------- */
  {
    id: W2_COMPANIES.ironvale,
    slug: 'ironvale',
    name: 'Ironvale Robotics',
    ticker: 'IRV',
    archetype: 'enterprise_ai',
    tier: 'major',
    sector: 'robotics',
    region: 'east_asia',
    sectorId: 'enterprise_software',
    city: 'Port Tsurumi',
    isPublic: true,
    listPriceUsd: 63,
    beta: 1.18,
    ceoCharacterId: W2_FOUNDERS.ironvale,
    boardId: 'brd_ironvale',
    posture: 'aggressive_growth',
    riskTolerance: 0.64,
    standing: 57,
    capabilityLevel: 0.9,
    pastPerformance: 42,
    revenue: 610 * M,
    margin: 0.44,
    growthYoY: 0.34,
    payroll: 122 * M,
    marketing: 58 * M,
    rd: 130 * M,
    capex: 90 * M,
    interest: 12 * M,
    cash: 1.2 * BN,
    debt: 800 * M,
    deferred: 180 * M,
    backlog: 1.4 * BN,
    ppe: 2.1 * BN,
    goodwill: 140 * M,
    investments: 60 * M,
    receivables: 320 * M,
    payables: 640 * M,
    staff: [980, 210, 320, 720, 40],
    morale: 71,
    attrition: 0.05,
    compute: [6_400, 12_000, 22 * M],
    product: { name: 'Ironvale Fulfilment Fleet', segment: 'enterprise', price: 9_400, churn: 0.03, growth: 0.09, quality: 0.88, intensity: 0.52 },
    anchorMethod: 'forward_revenue_quality',
  },
  {
    id: W2_COMPANIES.wrenford,
    slug: 'wrenford',
    name: 'Wrenford Autonomy',
    ticker: null,
    archetype: 'enterprise_ai',
    tier: 'significant',
    sector: 'robotics',
    region: 'europe',
    sectorId: 'enterprise_software',
    city: 'Aldergate',
    isPublic: false,
    listPriceUsd: null,
    beta: 1.62,
    ceoCharacterId: W2_FOUNDERS.wrenford,
    boardId: null,
    posture: 'research_first',
    riskTolerance: 0.81,
    standing: 36,
    capabilityLevel: 0.68,
    pastPerformance: 0,
    revenue: 24 * M,
    margin: 0.38,
    growthYoY: 0.48,
    payroll: 44 * M,
    marketing: 6 * M,
    rd: 62 * M,
    capex: 18 * M,
    interest: 1 * M,
    cash: 260 * M,
    debt: 20 * M,
    deferred: 6 * M,
    backlog: 30 * M,
    ppe: 90 * M,
    goodwill: 0,
    investments: 0,
    receivables: 14 * M,
    payables: 22 * M,
    staff: [180, 220, 20, 90, 12],
    morale: 83,
    attrition: 0.03,
    compute: [2_600, 8_000, 9 * M],
    product: { name: 'Wrenford General Platform', segment: 'enterprise', price: 26_000, churn: 0.04, growth: 0.16, quality: 0.61, intensity: 0.74 },
    anchorMethod: 'technology_option_value',
  },
  {
    id: W2_COMPANIES.sentinel,
    slug: 'sentinel',
    name: 'Sentinel Field Systems',
    ticker: 'SNT',
    archetype: 'defence_ai',
    tier: 'major',
    sector: 'robotics',
    region: 'north_america',
    sectorId: 'defence_tech',
    city: 'Harbourgate',
    isPublic: true,
    listPriceUsd: 121,
    beta: 0.88,
    ceoCharacterId: W2_FOUNDERS.sentinel,
    boardId: null,
    posture: 'balanced',
    riskTolerance: 0.47,
    standing: 53,
    capabilityLevel: 0.82,
    pastPerformance: 78,
    revenue: 340 * M,
    margin: 0.41,
    growthYoY: 0.22,
    payroll: 78 * M,
    marketing: 18 * M,
    rd: 66 * M,
    capex: 44 * M,
    interest: 6 * M,
    cash: 520 * M,
    debt: 340 * M,
    deferred: 130 * M,
    backlog: 2.2 * BN,
    ppe: 900 * M,
    goodwill: 90 * M,
    investments: 20 * M,
    receivables: 260 * M,
    payables: 280 * M,
    staff: [520, 140, 90, 380, 30],
    morale: 66,
    attrition: 0.04,
    compute: [3_200, 4_000, 11 * M],
    product: { name: 'Sentinel Perimeter Autonomy', segment: 'government', price: 68_000, churn: 0.02, growth: 0.06, quality: 0.86, intensity: 0.58 },
    anchorMethod: 'forward_revenue_quality',
  },
  {
    id: W2_COMPANIES.palma,
    slug: 'palma',
    name: 'Palma Agritech Robotics',
    ticker: null,
    archetype: 'enterprise_ai',
    tier: 'significant',
    sector: 'robotics',
    region: 'latin_america',
    sectorId: 'enterprise_software',
    city: 'Bahia Verde',
    isPublic: false,
    listPriceUsd: null,
    beta: 1.34,
    ceoCharacterId: W2_FOUNDERS.palma,
    boardId: null,
    posture: 'balanced',
    riskTolerance: 0.55,
    standing: 33,
    capabilityLevel: 0.54,
    pastPerformance: 12,
    revenue: 46 * M,
    margin: 0.36,
    growthYoY: 0.29,
    payroll: 14 * M,
    marketing: 5 * M,
    rd: 11 * M,
    capex: 9 * M,
    interest: 1 * M,
    cash: 70 * M,
    debt: 40 * M,
    deferred: 8 * M,
    backlog: 60 * M,
    ppe: 120 * M,
    goodwill: 0,
    investments: 0,
    receivables: 30 * M,
    payables: 34 * M,
    staff: [120, 40, 50, 140, 8],
    morale: 76,
    attrition: 0.06,
    compute: [400, 0, 3 * M],
    product: { name: 'Palma Harvest Units', segment: 'enterprise', price: 5_200, churn: 0.06, growth: 0.08, quality: 0.7, intensity: 0.44 },
    anchorMethod: 'revenue_multiple',
  },

  /* --- Manufacturing ----------------------------------------------------- */
  {
    id: W2_COMPANIES.tessellate,
    slug: 'tessellate',
    name: 'Tessellate Fabrication',
    ticker: 'TSL',
    archetype: 'chip_maker',
    tier: 'major',
    sector: 'manufacturing',
    region: 'east_asia',
    sectorId: 'semiconductors',
    city: 'Meridian Bay',
    isPublic: true,
    listPriceUsd: 38,
    beta: 1.46,
    ceoCharacterId: W2_FOUNDERS.tessellate,
    boardId: null,
    posture: 'efficiency',
    riskTolerance: 0.58,
    standing: 64,
    capabilityLevel: 0.94,
    pastPerformance: 61,
    revenue: 2.1 * BN,
    margin: 0.33,
    growthYoY: 0.26,
    payroll: 240 * M,
    marketing: 60 * M,
    rd: 190 * M,
    capex: 940 * M,
    interest: 62 * M,
    cash: 4.2 * BN,
    debt: 5.4 * BN,
    deferred: 420 * M,
    backlog: 9.8 * BN,
    ppe: 18.6 * BN,
    goodwill: 400 * M,
    investments: 300 * M,
    receivables: 1.1 * BN,
    payables: 3.1 * BN,
    staff: [2600, 180, 420, 3100, 44],
    morale: 72,
    attrition: 0.03,
    compute: [7_000, 0, 14 * M],
    product: { name: 'Tessellate Wafer Programmes', segment: 'enterprise', price: 240_000, churn: 0.01, growth: 0.07, quality: 0.93, intensity: 0.24 },
    anchorMethod: 'earnings_fcf',
  },
  {
    id: W2_COMPANIES.halcyon,
    slug: 'halcyon',
    name: 'Halcyon Precision',
    ticker: null,
    archetype: 'chip_maker',
    tier: 'significant',
    sector: 'manufacturing',
    region: 'europe',
    sectorId: 'semiconductors',
    city: 'Rivermouth',
    isPublic: false,
    listPriceUsd: null,
    beta: 1.1,
    ceoCharacterId: W2_FOUNDERS.halcyon,
    boardId: null,
    posture: 'balanced',
    riskTolerance: 0.44,
    standing: 47,
    capabilityLevel: 0.78,
    pastPerformance: 34,
    revenue: 92 * M,
    margin: 0.35,
    growthYoY: 0.17,
    payroll: 22 * M,
    marketing: 4 * M,
    rd: 12 * M,
    capex: 22 * M,
    interest: 3 * M,
    cash: 140 * M,
    debt: 180 * M,
    deferred: 12 * M,
    backlog: 260 * M,
    ppe: 420 * M,
    goodwill: 10 * M,
    investments: 5 * M,
    receivables: 70 * M,
    payables: 90 * M,
    staff: [180, 40, 30, 260, 10],
    morale: 77,
    attrition: 0.02,
    compute: [200, 0, 2 * M],
    product: { name: 'Halcyon Tolerance Components', segment: 'enterprise', price: 34_000, churn: 0.02, growth: 0.04, quality: 0.91, intensity: 0.18 },
    anchorMethod: 'earnings_fcf',
  },
  {
    id: W2_COMPANIES.cinder,
    slug: 'cinder',
    name: 'Cinder Battery Works',
    ticker: null,
    archetype: 'chip_maker',
    tier: 'significant',
    sector: 'manufacturing',
    region: 'latin_america',
    sectorId: 'semiconductors',
    city: 'Puerto Lomas',
    isPublic: false,
    listPriceUsd: null,
    beta: 1.5,
    ceoCharacterId: W2_FOUNDERS.cinder,
    boardId: null,
    posture: 'aggressive_growth',
    riskTolerance: 0.68,
    standing: 39,
    capabilityLevel: 0.66,
    pastPerformance: 8,
    revenue: 260 * M,
    margin: 0.24,
    growthYoY: 0.51,
    payroll: 44 * M,
    marketing: 12 * M,
    rd: 26 * M,
    capex: 180 * M,
    interest: 22 * M,
    cash: 340 * M,
    debt: 1.4 * BN,
    deferred: 40 * M,
    backlog: 900 * M,
    ppe: 3.1 * BN,
    goodwill: 20 * M,
    investments: 10 * M,
    receivables: 190 * M,
    payables: 520 * M,
    staff: [420, 60, 90, 900, 16],
    morale: 69,
    attrition: 0.07,
    compute: [300, 0, 3 * M],
    product: { name: 'Cinder Cell Lines', segment: 'enterprise', price: 18_000, churn: 0.03, growth: 0.13, quality: 0.74, intensity: 0.3 },
    anchorMethod: 'asset_cashflow_utilisation',
  },
  {
    id: W2_COMPANIES.rasan,
    slug: 'rasan',
    name: 'Rasan Heavy Works',
    ticker: null,
    archetype: 'infrastructure',
    tier: 'significant',
    sector: 'manufacturing',
    region: 'middle_east',
    sectorId: 'energy_infrastructure',
    city: 'Sandport',
    isPublic: false,
    listPriceUsd: null,
    beta: 0.82,
    ceoCharacterId: W2_FOUNDERS.rasan,
    boardId: null,
    posture: 'efficiency',
    riskTolerance: 0.4,
    standing: 43,
    capabilityLevel: 0.6,
    pastPerformance: 56,
    revenue: 175 * M,
    margin: 0.27,
    growthYoY: 0.12,
    payroll: 26 * M,
    marketing: 5 * M,
    rd: 8 * M,
    capex: 60 * M,
    interest: 12 * M,
    cash: 210 * M,
    debt: 700 * M,
    deferred: 30 * M,
    backlog: 640 * M,
    ppe: 1.5 * BN,
    goodwill: 0,
    investments: 20 * M,
    receivables: 120 * M,
    payables: 300 * M,
    staff: [260, 20, 40, 640, 12],
    morale: 70,
    attrition: 0.04,
    compute: [0, 0, 1 * M],
    product: { name: 'Rasan Pressure Assemblies', segment: 'enterprise', price: 96_000, churn: 0.02, growth: 0.03, quality: 0.8, intensity: 0.12 },
    anchorMethod: 'earnings_fcf',
  },

  /* --- Energy ------------------------------------------------------------ */
  {
    id: W2_COMPANIES.qanat,
    slug: 'qanat',
    name: 'Qanat Power',
    ticker: 'QNT',
    archetype: 'infrastructure',
    tier: 'major',
    sector: 'energy',
    region: 'middle_east',
    sectorId: 'energy_infrastructure',
    city: 'Al-Khalij',
    isPublic: true,
    listPriceUsd: 26,
    beta: 0.74,
    ceoCharacterId: W2_FOUNDERS.qanat,
    boardId: 'brd_qanat',
    posture: 'balanced',
    riskTolerance: 0.44,
    standing: 60,
    capabilityLevel: 0.88,
    pastPerformance: 72,
    revenue: 1.18 * BN,
    margin: 0.46,
    growthYoY: 0.19,
    payroll: 92 * M,
    marketing: 14 * M,
    rd: 22 * M,
    capex: 780 * M,
    interest: 138 * M,
    cash: 1.9 * BN,
    debt: 8.4 * BN,
    deferred: 260 * M,
    backlog: 5.6 * BN,
    ppe: 21.4 * BN,
    goodwill: 120 * M,
    investments: 380 * M,
    receivables: 640 * M,
    payables: 2.4 * BN,
    staff: [640, 40, 80, 1400, 26],
    morale: 73,
    attrition: 0.03,
    compute: [0, 0, 4 * M],
    product: { name: 'Qanat Firm Supply', segment: 'enterprise', price: 42_000, churn: 0.01, growth: 0.05, quality: 0.89, intensity: 0.1 },
    anchorMethod: 'asset_cashflow_utilisation',
  },
  {
    id: W2_COMPANIES.volta,
    slug: 'volta',
    name: 'Volta Andes',
    ticker: null,
    archetype: 'infrastructure',
    tier: 'significant',
    sector: 'energy',
    region: 'latin_america',
    sectorId: 'energy_infrastructure',
    city: 'Cordillera',
    isPublic: false,
    listPriceUsd: null,
    beta: 0.8,
    ceoCharacterId: W2_FOUNDERS.volta,
    boardId: null,
    posture: 'balanced',
    riskTolerance: 0.42,
    standing: 38,
    capabilityLevel: 0.62,
    pastPerformance: 28,
    revenue: 140 * M,
    margin: 0.44,
    growthYoY: 0.24,
    payroll: 14 * M,
    marketing: 2 * M,
    rd: 3 * M,
    capex: 90 * M,
    interest: 26 * M,
    cash: 180 * M,
    debt: 1.5 * BN,
    deferred: 20 * M,
    backlog: 780 * M,
    ppe: 3.2 * BN,
    goodwill: 0,
    investments: 30 * M,
    receivables: 90 * M,
    payables: 240 * M,
    staff: [120, 10, 20, 340, 8],
    morale: 75,
    attrition: 0.03,
    compute: [0, 0, 1 * M],
    product: { name: 'Volta Contracted Generation', segment: 'enterprise', price: 26_000, churn: 0.01, growth: 0.06, quality: 0.82, intensity: 0.08 },
    anchorMethod: 'asset_cashflow_utilisation',
  },
  {
    id: W2_COMPANIES.grimsby,
    slug: 'grimsby',
    name: 'Grimsby Grid Partners',
    ticker: null,
    archetype: 'infrastructure',
    tier: 'significant',
    sector: 'energy',
    region: 'europe',
    sectorId: 'energy_infrastructure',
    city: 'Rivermouth',
    isPublic: false,
    listPriceUsd: null,
    beta: 0.9,
    ceoCharacterId: W2_FOUNDERS.grimsby,
    boardId: null,
    posture: 'aggressive_growth',
    riskTolerance: 0.57,
    standing: 42,
    capabilityLevel: 0.7,
    pastPerformance: 45,
    revenue: 96 * M,
    margin: 0.38,
    growthYoY: 0.36,
    payroll: 20 * M,
    marketing: 3 * M,
    rd: 5 * M,
    capex: 120 * M,
    interest: 18 * M,
    cash: 260 * M,
    debt: 1 * BN,
    deferred: 40 * M,
    backlog: 1.9 * BN,
    ppe: 2.4 * BN,
    goodwill: 0,
    investments: 20 * M,
    receivables: 80 * M,
    payables: 260 * M,
    staff: [140, 10, 30, 210, 10],
    morale: 74,
    attrition: 0.04,
    compute: [0, 0, 2 * M],
    product: { name: 'Grimsby Connection Programmes', segment: 'enterprise', price: 320_000, churn: 0.01, growth: 0.09, quality: 0.78, intensity: 0.1 },
    anchorMethod: 'asset_cashflow_utilisation',
  },
  {
    id: W2_COMPANIES.suryan,
    slug: 'suryan',
    name: 'Suryan Renewables',
    ticker: null,
    archetype: 'infrastructure',
    tier: 'significant',
    sector: 'energy',
    region: 'south_asia',
    sectorId: 'energy_infrastructure',
    city: 'Deccan Rise',
    isPublic: false,
    listPriceUsd: null,
    beta: 0.86,
    ceoCharacterId: W2_FOUNDERS.suryan,
    boardId: null,
    posture: 'efficiency',
    riskTolerance: 0.38,
    standing: 40,
    capabilityLevel: 0.64,
    pastPerformance: 38,
    revenue: 210 * M,
    margin: 0.41,
    growthYoY: 0.15,
    payroll: 16 * M,
    marketing: 3 * M,
    rd: 4 * M,
    capex: 130 * M,
    interest: 34 * M,
    cash: 240 * M,
    debt: 2.1 * BN,
    deferred: 30 * M,
    backlog: 1.2 * BN,
    ppe: 4.6 * BN,
    goodwill: 0,
    investments: 40 * M,
    receivables: 140 * M,
    payables: 360 * M,
    staff: [180, 10, 20, 420, 8],
    morale: 72,
    attrition: 0.05,
    compute: [0, 0, 1 * M],
    product: { name: 'Suryan Solar Estates', segment: 'enterprise', price: 30_000, churn: 0.01, growth: 0.04, quality: 0.8, intensity: 0.08 },
    anchorMethod: 'asset_cashflow_utilisation',
  },

  /* --- Logistics --------------------------------------------------------- */
  {
    id: W2_COMPANIES.harbourline,
    slug: 'harbourline',
    name: 'Harbourline Freight',
    ticker: 'HBL',
    archetype: 'infrastructure',
    tier: 'major',
    sector: 'logistics',
    region: 'east_asia',
    sectorId: 'data_services',
    city: 'Silverdock',
    isPublic: true,
    listPriceUsd: 19,
    beta: 1.06,
    ceoCharacterId: W2_FOUNDERS.harbourline,
    boardId: null,
    posture: 'efficiency',
    riskTolerance: 0.36,
    standing: 55,
    capabilityLevel: 0.86,
    pastPerformance: 64,
    revenue: 1.64 * BN,
    margin: 0.19,
    growthYoY: 0.11,
    payroll: 190 * M,
    marketing: 26 * M,
    rd: 18 * M,
    capex: 210 * M,
    interest: 44 * M,
    cash: 1.1 * BN,
    debt: 2.6 * BN,
    deferred: 120 * M,
    backlog: 1.8 * BN,
    ppe: 6.4 * BN,
    goodwill: 260 * M,
    investments: 60 * M,
    receivables: 900 * M,
    payables: 1.9 * BN,
    staff: [820, 40, 260, 5600, 40],
    morale: 64,
    attrition: 0.08,
    compute: [1_200, 0, 9 * M],
    product: { name: 'Harbourline Line Haul', segment: 'enterprise', price: 74_000, churn: 0.04, growth: 0.03, quality: 0.83, intensity: 0.22 },
    anchorMethod: 'earnings_fcf',
  },
  {
    id: W2_COMPANIES.overland,
    slug: 'overland',
    name: 'Overland Transit Group',
    ticker: null,
    archetype: 'infrastructure',
    tier: 'significant',
    sector: 'logistics',
    region: 'north_america',
    sectorId: 'data_services',
    city: 'Lakeshore',
    isPublic: false,
    listPriceUsd: null,
    beta: 0.98,
    ceoCharacterId: W2_FOUNDERS.overland,
    boardId: null,
    posture: 'defensive',
    riskTolerance: 0.31,
    standing: 36,
    capabilityLevel: 0.5,
    pastPerformance: 49,
    revenue: 420 * M,
    margin: 0.17,
    growthYoY: 0.04,
    payroll: 66 * M,
    marketing: 9 * M,
    rd: 5 * M,
    capex: 54 * M,
    interest: 16 * M,
    cash: 180 * M,
    debt: 900 * M,
    deferred: 30 * M,
    backlog: 400 * M,
    ppe: 1.6 * BN,
    goodwill: 40 * M,
    investments: 10 * M,
    receivables: 280 * M,
    payables: 520 * M,
    staff: [220, 10, 120, 2100, 18],
    morale: 55,
    attrition: 0.09,
    compute: [0, 0, 3 * M],
    product: { name: 'Overland Regional Freight', segment: 'enterprise', price: 46_000, churn: 0.07, growth: 0.01, quality: 0.66, intensity: 0.18 },
    anchorMethod: 'earnings_fcf',
  },
  {
    id: W2_COMPANIES.ganga,
    slug: 'ganga',
    name: 'Ganga Freightways',
    ticker: null,
    archetype: 'infrastructure',
    tier: 'significant',
    sector: 'logistics',
    region: 'south_asia',
    sectorId: 'data_services',
    city: 'Palm Reach',
    isPublic: false,
    listPriceUsd: null,
    beta: 1.24,
    ceoCharacterId: W2_FOUNDERS.ganga,
    boardId: null,
    posture: 'aggressive_growth',
    riskTolerance: 0.6,
    standing: 37,
    capabilityLevel: 0.56,
    pastPerformance: 22,
    revenue: 190 * M,
    margin: 0.22,
    growthYoY: 0.33,
    payroll: 20 * M,
    marketing: 8 * M,
    rd: 4 * M,
    capex: 30 * M,
    interest: 7 * M,
    cash: 120 * M,
    debt: 380 * M,
    deferred: 14 * M,
    backlog: 260 * M,
    ppe: 700 * M,
    goodwill: 0,
    investments: 0,
    receivables: 130 * M,
    payables: 240 * M,
    staff: [140, 10, 90, 1900, 12],
    morale: 68,
    attrition: 0.07,
    compute: [0, 0, 2 * M],
    product: { name: 'Ganga Corridor Freight', segment: 'enterprise', price: 21_000, churn: 0.05, growth: 0.08, quality: 0.69, intensity: 0.16 },
    anchorMethod: 'revenue_multiple',
  },
  {
    id: W2_COMPANIES.dune,
    slug: 'dune',
    name: 'Dune Logistics',
    ticker: null,
    archetype: 'enterprise_ai',
    tier: 'significant',
    sector: 'logistics',
    region: 'middle_east',
    sectorId: 'enterprise_software',
    city: 'Northreach',
    isPublic: false,
    listPriceUsd: null,
    beta: 1.4,
    ceoCharacterId: W2_FOUNDERS.dune,
    boardId: null,
    posture: 'land_grab',
    riskTolerance: 0.66,
    standing: 31,
    capabilityLevel: 0.52,
    pastPerformance: 0,
    revenue: 74 * M,
    margin: 0.16,
    growthYoY: 0.44,
    payroll: 16 * M,
    marketing: 14 * M,
    rd: 4 * M,
    capex: 12 * M,
    interest: 2 * M,
    cash: 160 * M,
    debt: 120 * M,
    deferred: 6 * M,
    backlog: 80 * M,
    ppe: 220 * M,
    goodwill: 0,
    investments: 0,
    receivables: 50 * M,
    payables: 110 * M,
    staff: [90, 10, 60, 940, 8],
    morale: 71,
    attrition: 0.09,
    compute: [0, 0, 2 * M],
    product: { name: 'Dune Same-Day Network', segment: 'consumer', price: 42, churn: 0.14, growth: 0.19, quality: 0.6, intensity: 0.26 },
    anchorMethod: 'revenue_multiple',
  },

  /* --- Consumer ---------------------------------------------------------- */
  {
    id: W2_COMPANIES.lumen,
    slug: 'lumen',
    name: 'Lumen Household',
    ticker: 'LMN',
    archetype: 'consumer_ai',
    tier: 'major',
    sector: 'consumer',
    region: 'north_america',
    sectorId: 'consumer_ai',
    city: 'Lakeshore',
    isPublic: true,
    listPriceUsd: 74,
    beta: 1.12,
    ceoCharacterId: W2_FOUNDERS.lumen,
    boardId: null,
    posture: 'balanced',
    riskTolerance: 0.5,
    standing: 58,
    capabilityLevel: 0.8,
    pastPerformance: 20,
    revenue: 880 * M,
    margin: 0.52,
    growthYoY: 0.14,
    payroll: 120 * M,
    marketing: 200 * M,
    rd: 60 * M,
    capex: 40 * M,
    interest: 9 * M,
    cash: 900 * M,
    debt: 500 * M,
    deferred: 90 * M,
    backlog: 60 * M,
    ppe: 700 * M,
    goodwill: 320 * M,
    investments: 40 * M,
    receivables: 260 * M,
    payables: 620 * M,
    staff: [620, 60, 340, 780, 34],
    morale: 67,
    attrition: 0.07,
    compute: [2_000, 6_000, 40 * M],
    product: { name: 'Lumen Everyday', segment: 'consumer', price: 22, churn: 0.11, growth: 0.05, quality: 0.79, intensity: 0.5 },
    anchorMethod: 'forward_revenue_quality',
  },
  {
    id: W2_COMPANIES.tanto,
    slug: 'tanto',
    name: 'Tanto Retail',
    ticker: null,
    archetype: 'consumer_ai',
    tier: 'significant',
    sector: 'consumer',
    region: 'east_asia',
    sectorId: 'consumer_ai',
    city: 'Kaifeng Sound',
    isPublic: false,
    listPriceUsd: null,
    beta: 0.94,
    ceoCharacterId: W2_FOUNDERS.tanto,
    boardId: null,
    posture: 'efficiency',
    riskTolerance: 0.34,
    standing: 45,
    capabilityLevel: 0.6,
    pastPerformance: 10,
    revenue: 360 * M,
    margin: 0.45,
    growthYoY: 0.07,
    payroll: 46 * M,
    marketing: 60 * M,
    rd: 12 * M,
    capex: 14 * M,
    interest: 4 * M,
    cash: 240 * M,
    debt: 220 * M,
    deferred: 26 * M,
    backlog: 20 * M,
    ppe: 300 * M,
    goodwill: 60 * M,
    investments: 10 * M,
    receivables: 120 * M,
    payables: 280 * M,
    staff: [220, 20, 180, 620, 16],
    morale: 70,
    attrition: 0.06,
    compute: [0, 0, 8 * M],
    product: { name: 'Tanto Marketplace', segment: 'consumer', price: 36, churn: 0.09, growth: 0.02, quality: 0.75, intensity: 0.34 },
    anchorMethod: 'forward_revenue_quality',
  },
  {
    id: W2_COMPANIES.copa,
    slug: 'copa',
    name: 'Copa Mercado',
    ticker: null,
    archetype: 'consumer_ai',
    tier: 'significant',
    sector: 'consumer',
    region: 'latin_america',
    sectorId: 'consumer_ai',
    city: 'Bahia Verde',
    isPublic: false,
    listPriceUsd: null,
    beta: 1.28,
    ceoCharacterId: W2_FOUNDERS.copa,
    boardId: null,
    posture: 'land_grab',
    riskTolerance: 0.7,
    standing: 40,
    capabilityLevel: 0.58,
    pastPerformance: 0,
    revenue: 210 * M,
    margin: 0.48,
    growthYoY: 0.46,
    payroll: 34 * M,
    marketing: 90 * M,
    rd: 14 * M,
    capex: 8 * M,
    interest: 2 * M,
    cash: 300 * M,
    debt: 90 * M,
    deferred: 18 * M,
    backlog: 12 * M,
    ppe: 120 * M,
    goodwill: 20 * M,
    investments: 0,
    receivables: 90 * M,
    payables: 180 * M,
    staff: [180, 20, 160, 420, 14],
    morale: 78,
    attrition: 0.08,
    compute: [0, 0, 6 * M],
    product: { name: 'Copa Mercado App', segment: 'consumer', price: 14, churn: 0.13, growth: 0.17, quality: 0.71, intensity: 0.38 },
    anchorMethod: 'revenue_multiple',
  },
  {
    id: W2_COMPANIES.vasant,
    slug: 'vasant',
    name: 'Vasant Direct',
    ticker: null,
    archetype: 'consumer_ai',
    tier: 'significant',
    sector: 'consumer',
    region: 'south_asia',
    sectorId: 'consumer_ai',
    city: 'Palm Reach',
    isPublic: false,
    listPriceUsd: null,
    beta: 1.2,
    ceoCharacterId: W2_FOUNDERS.vasant,
    boardId: null,
    posture: 'aggressive_growth',
    riskTolerance: 0.62,
    standing: 35,
    capabilityLevel: 0.54,
    pastPerformance: 0,
    revenue: 130 * M,
    margin: 0.44,
    growthYoY: 0.38,
    payroll: 16 * M,
    marketing: 44 * M,
    rd: 7 * M,
    capex: 5 * M,
    interest: 1 * M,
    cash: 150 * M,
    debt: 40 * M,
    deferred: 10 * M,
    backlog: 8 * M,
    ppe: 70 * M,
    goodwill: 0,
    investments: 0,
    receivables: 50 * M,
    payables: 90 * M,
    staff: [110, 10, 90, 260, 10],
    morale: 76,
    attrition: 0.08,
    compute: [0, 0, 4 * M],
    product: { name: 'Vasant Direct Store', segment: 'consumer', price: 9, churn: 0.15, growth: 0.15, quality: 0.68, intensity: 0.32 },
    anchorMethod: 'revenue_multiple',
  },
];
