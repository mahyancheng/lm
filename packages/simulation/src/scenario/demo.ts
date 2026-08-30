/**
 * @frontier/simulation — scenario/demo.ts
 *
 * The demo world: **2027 Q1, seed 424242**.
 *
 * This is the same world `supabase/seed.sql` loads, expressed as a
 * `SessionState` the engine can resolve without a database. Six rival companies
 * with the tickers, financials, cap tables and quotes the seed carries; fifteen
 * named people with the traits the seed gives them; a seventeen-node Frontier
 * Map spanning every epistemic state, including one secret programme only Nexus
 * knows about; three agencies with two open procurements; eight instruments on
 * the in-world exchange.
 *
 * Alongside them sits the seventh company: **Player Ventures**, eight people and
 * four million dollars, run by a founder on connection level 24 in a world where
 * the sovereign fund's chief investment officer sits on 93. Everything the game
 * is about is visible in that gap on the first screen.
 *
 * ## Determinism
 *
 * The scenario data is fixed. `seed` enters the world through
 * `SessionState.seed`, which is where every stochastic decision downstream comes
 * from, and through the session id so that two demo sessions on one machine do
 * not collide. Same seed, same starting state, byte for byte.
 *
 * ## Quarter zero
 *
 * `quarter` is 0 (2027 Q1) and `lastResolvedQuarter` is null: no world snapshot
 * exists yet. The resolver writes the first one.
 */

import type {
  Board,
  CapTable,
  Character,
  Company,
  CompanyQuarterMetrics,
  MarketInstrument,
  ProcurementOpportunity,
  Quote,
  ResearchProject,
  SessionState,
  SessionStateInput,
  SocialAccount,
  TechNode,
} from '@frontier/contracts';
import { DEFAULT_QUORUM_RULE, SessionStateSchema, makeId } from '@frontier/contracts';

/* -------------------------------------------------------------------------- */
/*  Identifiers                                                                */
/* -------------------------------------------------------------------------- */

/** Company ids, stable across resets so fixtures and screenshots agree. */
export const DEMO_COMPANIES = {
  nexus: 'cmp_nexus',
  orbit: 'cmp_orbit',
  helix: 'cmp_helix',
  vectorworks: 'cmp_vectorworks',
  aurora: 'cmp_aurora',
  meridian: 'cmp_meridian',
  player: 'cmp_player_ventures',
} as const;

/** Character ids. The first fifteen mirror `supabase/seed.sql` exactly. */
export const DEMO_CHARACTERS = {
  maya: 'chr_maya_chen',
  daniel: 'chr_daniel_okonkwo',
  priya: 'chr_priya_raghavan',
  tomas: 'chr_tomas_lindqvist',
  rebecca: 'chr_rebecca_aldana',
  kenji: 'chr_kenji_watanabe',
  eleanor: 'chr_eleanor_vance',
  marcus: 'chr_marcus_feld',
  nadia: 'chr_nadia_okafor',
  sarah: 'chr_sarah_zhou',
  idris: 'chr_idris_bello',
  grace: 'chr_grace_halloran',
  alan: 'chr_alan_prieto',
  ines: 'chr_ines_duarte',
  rowan: 'chr_rowan_ellis',
  /** The sixteenth: the seat a human sits in. */
  player: 'chr_avery_sinclair',
} as const;

export const DEMO_PLAYER_ID = 'player_1';
export const DEMO_SEED = 424242;

const SEC = (slug: string): string => `sec_${slug}_common`;
const SHC = (slug: string): string => `shc_${slug}_common`;
const FLOAT = (slug: string): string => `float_${slug}`;

/* -------------------------------------------------------------------------- */
/*  Companies                                                                  */
/* -------------------------------------------------------------------------- */

interface CompanySeed {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly ticker: string | null;
  readonly archetype: Company['archetype'];
  readonly tier: Company['tier'];
  readonly sectorId: string;
  readonly city: string;
  readonly isPublic: boolean;
  readonly controllerPlayerId: string | null;
  readonly ceoCharacterId: string;
  readonly boardId: string | null;
  readonly posture: Company['posture'];
  readonly riskTolerance: number;
  readonly instrumentId: string | null;
  readonly financials: {
    readonly revenue: number;
    readonly cogs: number;
    readonly payroll: number;
    readonly marketing: number;
    readonly rd: number;
    readonly capex: number;
    readonly interest: number;
    readonly cash: number;
    readonly debt: number;
    readonly burn: number;
    readonly deferred: number;
    readonly backlog: number;
  };
  readonly assets: { readonly ppe: number; readonly goodwill: number; readonly investments: number; readonly receivables: number };
  readonly liabilities: { readonly payables: number };
  readonly employees: {
    readonly engineers: number;
    readonly researchers: number;
    readonly sales: number;
    readonly ops: number;
    readonly execs: number;
    readonly avgComp: number;
    readonly morale: number;
    readonly attrition: number;
    readonly openRoles: number;
  };
  readonly compute: {
    readonly owned: number;
    readonly reserved: number;
    readonly expiry: number | null;
    readonly cloud: number;
    readonly utilisation: number;
    readonly training: number;
  };
  readonly product: {
    readonly id: string;
    readonly name: string;
    readonly segment: Company['products'][number]['segment'];
    readonly price: number;
    readonly customers: number;
    readonly churn: number;
    readonly growth: number;
    readonly margin: number;
    readonly intensity: number;
    readonly quality: number;
  };
  readonly capabilities: Readonly<Record<string, number>>;
  readonly reputation: { readonly pub: number; readonly dev: number; readonly ent: number; readonly gov: number; readonly inv: number };
  readonly pastPerformance: number;
}

const M = 1_000_000;
const BN = 1_000_000_000;

const COMPANY_SEEDS: readonly CompanySeed[] = [
  {
    id: DEMO_COMPANIES.nexus,
    slug: 'nexus',
    name: 'Nexus Intelligence',
    ticker: 'NXS',
    archetype: 'frontier_lab',
    tier: 'major',
    sectorId: 'frontier_models',
    city: 'Bay Federal District',
    isPublic: true,
    controllerPlayerId: null,
    ceoCharacterId: DEMO_CHARACTERS.maya,
    boardId: 'brd_nexus',
    posture: 'research_first',
    riskTolerance: 0.89,
    instrumentId: 'ins_nxs',
    financials: {
      revenue: 1850 * M,
      cogs: 703 * M,
      payroll: 333.25 * M,
      marketing: 260 * M,
      rd: 786.75 * M,
      capex: 410 * M,
      interest: 11 * M,
      cash: 9.4 * BN,
      debt: 500 * M,
      burn: -312 * M,
      deferred: 700 * M,
      backlog: 320 * M,
    },
    assets: { ppe: 6.2 * BN, goodwill: 400 * M, investments: 300 * M, receivables: 500 * M },
    liabilities: { payables: 1.9 * BN },
    employees: { engineers: 1180, researchers: 740, sales: 310, ops: 780, execs: 90, avgComp: 430_000, morale: 64, attrition: 0.04, openRoles: 361 },
    compute: { owned: 40_000, reserved: 180_000, expiry: 7, cloud: 120 * M, utilisation: 0.94, training: 0.72 },
    product: {
      id: 'prd_nexus_frontier_api',
      name: 'Nexus Frontier API',
      segment: 'developer_api',
      price: 1_760,
      customers: 1_051_136,
      churn: 0.07,
      growth: 0.14,
      margin: 0.62,
      intensity: 0.86,
      quality: 0.91,
    },
    capabilities: { reasoning: 0.92, agents: 0.71, multimodal: 0.78, efficiency: 0.44, evaluation: 0.66, safety_alignment: 0.51, training_systems: 0.9, infrastructure: 0.68 },
    reputation: { pub: 58, dev: 64, ent: 55, gov: 47, inv: 71 },
    pastPerformance: 58,
  },
  {
    id: DEMO_COMPANIES.orbit,
    slug: 'orbit',
    name: 'Orbit Dynamics',
    ticker: 'ORB',
    archetype: 'enterprise_ai',
    tier: 'major',
    sectorId: 'enterprise_software',
    city: 'Lakeshore',
    isPublic: true,
    controllerPlayerId: null,
    ceoCharacterId: DEMO_CHARACTERS.daniel,
    boardId: null,
    posture: 'balanced',
    riskTolerance: 0.41,
    instrumentId: 'ins_orb',
    financials: {
      revenue: 1225 * M,
      cogs: 355 * M,
      payroll: 267.6 * M,
      marketing: 200 * M,
      rd: 279.4 * M,
      capex: 96 * M,
      interest: 6 * M,
      cash: 3.9 * BN,
      debt: 300 * M,
      burn: 141 * M,
      deferred: 700 * M,
      backlog: 890 * M,
    },
    assets: { ppe: 1.9 * BN, goodwill: 600 * M, investments: 200 * M, receivables: 500 * M },
    liabilities: { payables: 900 * M },
    employees: { engineers: 1420, researchers: 270, sales: 1180, ops: 1330, execs: 81, avgComp: 250_000, morale: 72, attrition: 0.04, openRoles: 333 },
    compute: { owned: 6_000, reserved: 34_000, expiry: 4, cloud: 40 * M, utilisation: 0.81, training: 0.25 },
    product: {
      id: 'prd_orbit_workbench',
      name: 'Orbit Workbench',
      segment: 'enterprise',
      price: 350,
      customers: 3_500_000,
      churn: 0.04,
      growth: 0.09,
      margin: 0.71,
      intensity: 0.38,
      quality: 0.89,
    },
    capabilities: { reasoning: 0.62, agents: 0.84, multimodal: 0.51, efficiency: 0.58, evaluation: 0.7, safety_alignment: 0.62, retrieval: 0.66, security: 0.72 },
    reputation: { pub: 71, dev: 52, ent: 84, gov: 66, inv: 68 },
    pastPerformance: 81,
  },
  {
    id: DEMO_COMPANIES.helix,
    slug: 'helix',
    name: 'Helix Systems',
    ticker: 'HLX',
    archetype: 'infrastructure',
    tier: 'major',
    sectorId: 'cloud_infrastructure',
    city: 'Cascade Valley',
    isPublic: true,
    controllerPlayerId: null,
    ceoCharacterId: DEMO_CHARACTERS.priya,
    boardId: null,
    posture: 'efficiency',
    riskTolerance: 0.55,
    instrumentId: 'ins_hlx',
    financials: {
      revenue: 1525 * M,
      cogs: 945 * M,
      payroll: 128.4 * M,
      marketing: 40 * M,
      rd: 58.6 * M,
      capex: 880 * M,
      interest: 148 * M,
      cash: 1.8 * BN,
      debt: 8.6 * BN,
      burn: 96 * M,
      deferred: 600 * M,
      backlog: 4.1 * BN,
    },
    assets: { ppe: 21.2 * BN, goodwill: 300 * M, investments: 400 * M, receivables: 800 * M },
    liabilities: { payables: 2.9 * BN },
    employees: { engineers: 1290, researchers: 40, sales: 160, ops: 620, execs: 30, avgComp: 240_000, morale: 75, attrition: 0.03, openRoles: 124 },
    compute: { owned: 640_000, reserved: 0, expiry: null, cloud: 0, utilisation: 0.91, training: 0.05 },
    product: {
      id: 'prd_helix_reserved_capacity',
      name: 'Helix Reserved Capacity',
      segment: 'enterprise',
      price: 6_240,
      customers: 244_391,
      churn: 0.02,
      growth: 0.06,
      margin: 0.38,
      intensity: 0.95,
      quality: 0.92,
    },
    capabilities: { infrastructure: 0.95, efficiency: 0.72, security: 0.68, hardware_design: 0.44, training_systems: 0.61 },
    reputation: { pub: 66, dev: 48, ent: 79, gov: 71, inv: 74 },
    pastPerformance: 74,
  },
  {
    id: DEMO_COMPANIES.vectorworks,
    slug: 'vectorworks',
    name: 'VectorWorks AI',
    ticker: 'VWA',
    archetype: 'enterprise_ai',
    tier: 'significant',
    sectorId: 'enterprise_software',
    city: 'Harbourgate',
    isPublic: true,
    controllerPlayerId: null,
    ceoCharacterId: DEMO_CHARACTERS.tomas,
    boardId: null,
    posture: 'survival',
    riskTolerance: 0.34,
    instrumentId: 'ins_vwa',
    financials: {
      revenue: 172.5 * M,
      cogs: 58.6 * M,
      payroll: 88.5 * M,
      marketing: 60 * M,
      rd: 52.5 * M,
      capex: 18 * M,
      interest: 4 * M,
      cash: 640 * M,
      debt: 220 * M,
      burn: -104 * M,
      deferred: 100 * M,
      backlog: 140 * M,
    },
    assets: { ppe: 420 * M, goodwill: 90 * M, investments: 50 * M, receivables: 150 * M },
    liabilities: { payables: 160 * M },
    employees: { engineers: 520, researchers: 190, sales: 310, ops: 145, execs: 15, avgComp: 300_000, morale: 38, attrition: 0.11, openRoles: 22 },
    compute: { owned: 1_200, reserved: 0, expiry: null, cloud: 26 * M, utilisation: 0.72, training: 0.3 },
    product: {
      id: 'prd_vectorworks_ledger',
      name: 'VectorWorks Ledger',
      segment: 'enterprise',
      price: 375,
      customers: 460_000,
      churn: 0.14,
      growth: -0.03,
      margin: 0.66,
      intensity: 0.31,
      quality: 0.81,
    },
    capabilities: { retrieval: 0.88, evaluation: 0.74, reasoning: 0.58, security: 0.7, safety_alignment: 0.66, efficiency: 0.41 },
    reputation: { pub: 49, dev: 61, ent: 44, gov: 58, inv: 31 },
    pastPerformance: 46,
  },
  {
    id: DEMO_COMPANIES.aurora,
    slug: 'aurora',
    name: 'Aurora Compute',
    ticker: 'ARC',
    archetype: 'chip_maker',
    tier: 'major',
    sectorId: 'semiconductors',
    city: 'Meridian Bay',
    isPublic: true,
    controllerPlayerId: null,
    ceoCharacterId: DEMO_CHARACTERS.rebecca,
    boardId: null,
    posture: 'aggressive_growth',
    riskTolerance: 0.62,
    instrumentId: 'ins_arc',
    financials: {
      revenue: 3700 * M,
      cogs: 1591 * M,
      payroll: 417.3 * M,
      marketing: 180 * M,
      rd: 397.7 * M,
      capex: 1.4 * BN,
      interest: 39 * M,
      cash: 12.6 * BN,
      debt: 2.4 * BN,
      burn: 712 * M,
      deferred: 900 * M,
      backlog: 22 * BN,
    },
    assets: { ppe: 14.8 * BN, goodwill: 1.2 * BN, investments: 900 * M, receivables: 1.5 * BN },
    liabilities: { payables: 4.6 * BN },
    employees: { engineers: 3100, researchers: 120, sales: 620, ops: 2540, execs: 40, avgComp: 260_000, morale: 76, attrition: 0.03, openRoles: 410 },
    compute: { owned: 8_000, reserved: 0, expiry: null, cloud: 15 * M, utilisation: 0.6, training: 0.4 },
    product: {
      id: 'prd_aurora_ax7',
      name: 'Aurora AX-7 Accelerator',
      segment: 'enterprise',
      price: 28_500,
      customers: 129_824,
      churn: 0.01,
      growth: 0.18,
      margin: 0.57,
      intensity: 0.2,
      quality: 0.94,
    },
    capabilities: { hardware_design: 0.96, infrastructure: 0.74, efficiency: 0.81, training_systems: 0.55, security: 0.6 },
    reputation: { pub: 63, dev: 57, ent: 76, gov: 69, inv: 82 },
    pastPerformance: 62,
  },
  {
    id: DEMO_COMPANIES.meridian,
    slug: 'meridian',
    name: 'Meridian Data',
    ticker: 'MRD',
    archetype: 'data',
    tier: 'significant',
    sectorId: 'data_services',
    city: 'Old Quarter',
    isPublic: true,
    controllerPlayerId: null,
    ceoCharacterId: DEMO_CHARACTERS.kenji,
    boardId: null,
    posture: 'research_first',
    riskTolerance: 0.68,
    instrumentId: 'ins_mrd',
    financials: {
      revenue: 205 * M,
      cogs: 53.3 * M,
      payroll: 64 * M,
      marketing: 20 * M,
      rd: 74 * M,
      capex: 22 * M,
      interest: 1 * M,
      cash: 410 * M,
      debt: 60 * M,
      burn: 4 * M,
      deferred: 40 * M,
      backlog: 95 * M,
    },
    assets: { ppe: 290 * M, goodwill: 50 * M, investments: 30 * M, receivables: 200 * M },
    liabilities: { payables: 110 * M },
    employees: { engineers: 240, researchers: 280, sales: 40, ops: 70, execs: 10, avgComp: 400_000, morale: 82, attrition: 0.02, openRoles: 62 },
    compute: { owned: 2_000, reserved: 10_000, expiry: 11, cloud: 8 * M, utilisation: 0.7, training: 0.5 },
    product: {
      id: 'prd_meridian_synthesis',
      name: 'Meridian Synthesis',
      segment: 'developer_api',
      price: 1_460,
      customers: 140_410,
      churn: 0.06,
      growth: 0.11,
      margin: 0.74,
      intensity: 0.42,
      quality: 0.86,
    },
    capabilities: { data_curation: 0.94, evaluation: 0.83, reasoning: 0.55, agents: 0.62, training_systems: 0.58 },
    reputation: { pub: 55, dev: 78, ent: 46, gov: 44, inv: 49 },
    pastPerformance: 35,
  },
  {
    id: DEMO_COMPANIES.player,
    slug: 'player_ventures',
    name: 'Player Ventures',
    ticker: null,
    archetype: 'enterprise_ai',
    tier: 'major',
    sectorId: 'enterprise_software',
    city: 'Harbourgate',
    isPublic: false,
    controllerPlayerId: DEMO_PLAYER_ID,
    ceoCharacterId: DEMO_CHARACTERS.player,
    boardId: 'brd_player_ventures',
    posture: 'aggressive_growth',
    riskTolerance: 0.72,
    instrumentId: null,
    financials: {
      revenue: 0.32 * M,
      cogs: 0.11 * M,
      payroll: 0.6 * M,
      marketing: 0.05 * M,
      rd: 0.2 * M,
      capex: 0.04 * M,
      interest: 0,
      cash: 4 * M,
      debt: 0,
      burn: -0.64 * M,
      deferred: 0.02 * M,
      backlog: 0.18 * M,
    },
    assets: { ppe: 0.2 * M, goodwill: 0, investments: 0, receivables: 0.05 * M },
    liabilities: { payables: 0.03 * M },
    employees: { engineers: 4, researchers: 2, sales: 1, ops: 0, execs: 1, avgComp: 300_000, morale: 88, attrition: 0.02, openRoles: 3 },
    compute: { owned: 0, reserved: 0, expiry: null, cloud: 0.15 * M, utilisation: 0.4, training: 0.5 },
    product: {
      id: 'prd_player_assistant',
      name: 'Ventures Copilot',
      segment: 'enterprise',
      price: 200,
      customers: 1_600,
      churn: 0.08,
      growth: 0.31,
      margin: 0.64,
      intensity: 0.29,
      quality: 0.52,
    },
    capabilities: { reasoning: 0.41, agents: 0.46, retrieval: 0.52, evaluation: 0.38, efficiency: 0.35 },
    reputation: { pub: 22, dev: 34, ent: 27, gov: 12, inv: 30 },
    pastPerformance: 0,
  },
];

function buildCompany(seed: CompanySeed): Company {
  const f = seed.financials;
  const assets = { cash: f.cash, ppe: seed.assets.ppe, goodwill: seed.assets.goodwill, investments: seed.assets.investments, receivables: seed.assets.receivables };
  const liabilities = { debt: f.debt, payables: seed.liabilities.payables, deferredRevenue: f.deferred };
  const equity =
    assets.cash + assets.ppe + assets.goodwill + assets.investments + assets.receivables - (liabilities.debt + liabilities.payables + liabilities.deferredRevenue);

  return {
    id: seed.id,
    name: seed.name,
    ticker: seed.ticker,
    archetype: seed.archetype,
    tier: seed.tier,
    isPublic: seed.isPublic,
    controllerPlayerId: seed.controllerPlayerId,
    sectorId: seed.sectorId,
    foundedQuarter: 0,
    headquartersCity: seed.city,
    isActive: true,
    products: [
      {
        id: seed.product.id,
        name: seed.product.name,
        segment: seed.product.segment,
        pricePerSeat: seed.product.price,
        activeCustomers: seed.product.customers,
        churnQuarterly: seed.product.churn,
        growthQuarterly: seed.product.growth,
        grossMarginPct: seed.product.margin,
        computeIntensity: seed.product.intensity,
        qualityScore: seed.product.quality,
        launchedQuarter: 0,
        isActive: true,
      },
    ],
    employees: {
      engineers: seed.employees.engineers,
      researchers: seed.employees.researchers,
      sales: seed.employees.sales,
      ops: seed.employees.ops,
      execs: seed.employees.execs,
      avgComp: seed.employees.avgComp,
      morale: seed.employees.morale,
      attrition: seed.employees.attrition,
      openRoles: seed.employees.openRoles,
    },
    compute: {
      ownedAccelerators: seed.compute.owned,
      reservedAccelerators: seed.compute.reserved,
      reservationExpiryQuarter: seed.compute.expiry,
      cloudSpendQuarterly: seed.compute.cloud,
      computeUtilisation: seed.compute.utilisation,
      trainingAllocation: seed.compute.training,
    },
    offices: [
      {
        id: makeId('off', seed.slug, 'hq'),
        city: seed.city,
        headcountCapacity: Math.max(
          16,
          Math.round((seed.employees.engineers + seed.employees.researchers + seed.employees.sales + seed.employees.ops + seed.employees.execs) * 1.2),
        ),
        quarterlyCostUsd: Math.round(seed.employees.avgComp * 0.06 * (seed.employees.engineers + seed.employees.researchers + seed.employees.sales + seed.employees.ops + seed.employees.execs)),
        openedQuarter: 0,
        isHeadquarters: true,
      },
    ],
    financials: {
      revenueQuarterly: f.revenue,
      cogs: f.cogs,
      payroll: f.payroll,
      marketing: f.marketing,
      rdSpend: f.rd,
      capex: f.capex,
      interestExpense: f.interest,
      cash: f.cash,
      debt: f.debt,
      quarterlyBurn: f.burn,
      deferredRevenue: f.deferred,
      backlogUsd: f.backlog,
    },
    balanceSheet: { assets, liabilities, equity },
    posture: seed.posture,
    riskTolerance: seed.riskTolerance,
    techCapabilities: { ...seed.capabilities },
    governmentPastPerformance: seed.pastPerformance,
    reputation: {
      public: seed.reputation.pub,
      developer: seed.reputation.dev,
      enterprise: seed.reputation.ent,
      government: seed.reputation.gov,
      investor: seed.reputation.inv,
    },
    boardId: seed.boardId,
    primarySecurityId: SEC(seed.slug),
    instrumentId: seed.instrumentId,
    ceoCharacterId: seed.ceoCharacterId,
    parentCompanyId: null,
  };
}

/* -------------------------------------------------------------------------- */
/*  Cap tables                                                                 */
/* -------------------------------------------------------------------------- */

interface CapSeed {
  readonly slug: string;
  readonly companyId: string;
  readonly authorised: number;
  readonly issued: number;
  readonly optionPool: number;
  readonly holders: readonly { readonly holderId: string; readonly kind: CapTable['holdings'][number]['holderKind']; readonly shares: number; readonly costPerShare: number }[];
}

const CAP_SEEDS: readonly CapSeed[] = [
  {
    slug: 'nexus',
    companyId: DEMO_COMPANIES.nexus,
    authorised: 900_000_000,
    issued: 620_000_000,
    optionPool: 45_000_000,
    holders: [
      { holderId: DEMO_CHARACTERS.maya, kind: 'character', shares: 74_400_000, costPerShare: 0.4 },
      { holderId: 'fund_lattice', kind: 'fund', shares: 99_200_000, costPerShare: 6.1 },
      { holderId: 'fund_halberd', kind: 'fund', shares: 62_000_000, costPerShare: 21.4 },
      { holderId: FLOAT('nexus'), kind: 'public_float', shares: 384_400_000, costPerShare: 44.5 },
    ],
  },
  {
    slug: 'orbit',
    companyId: DEMO_COMPANIES.orbit,
    authorised: 800_000_000,
    issued: 540_000_000,
    optionPool: 30_000_000,
    holders: [
      { holderId: DEMO_CHARACTERS.daniel, kind: 'character', shares: 18_360_000, costPerShare: 1.1 },
      { holderId: 'fund_halberd', kind: 'fund', shares: 54_000_000, costPerShare: 12.8 },
      { holderId: FLOAT('orbit'), kind: 'public_float', shares: 467_640_000, costPerShare: 38.2 },
    ],
  },
  {
    slug: 'helix',
    companyId: DEMO_COMPANIES.helix,
    authorised: 600_000_000,
    issued: 410_000_000,
    optionPool: 18_000_000,
    holders: [
      { holderId: DEMO_CHARACTERS.priya, kind: 'character', shares: 23_780_000, costPerShare: 0.8 },
      { holderId: 'fund_lattice', kind: 'fund', shares: 41_000_000, costPerShare: 9.4 },
      { holderId: FLOAT('helix'), kind: 'public_float', shares: 345_220_000, costPerShare: 41.7 },
    ],
  },
  {
    slug: 'vectorworks',
    companyId: DEMO_COMPANIES.vectorworks,
    authorised: 500_000_000,
    issued: 300_000_000,
    optionPool: 22_000_000,
    holders: [
      { holderId: DEMO_CHARACTERS.tomas, kind: 'character', shares: 26_700_000, costPerShare: 0.3 },
      { holderId: 'fund_halberd', kind: 'fund', shares: 45_000_000, costPerShare: 28.6 },
      { holderId: FLOAT('vectorworks'), kind: 'public_float', shares: 228_300_000, costPerShare: 31.2 },
    ],
  },
  {
    slug: 'aurora',
    companyId: DEMO_COMPANIES.aurora,
    authorised: 1_000_000_000,
    issued: 780_000_000,
    optionPool: 40_000_000,
    holders: [
      { holderId: DEMO_CHARACTERS.rebecca, kind: 'character', shares: 21_060_000, costPerShare: 0.9 },
      { holderId: 'fund_albahr', kind: 'fund', shares: 78_000_000, costPerShare: 54.3 },
      { holderId: FLOAT('aurora'), kind: 'public_float', shares: 680_940_000, costPerShare: 88.1 },
    ],
  },
  {
    slug: 'meridian',
    companyId: DEMO_COMPANIES.meridian,
    authorised: 400_000_000,
    issued: 260_000_000,
    optionPool: 15_000_000,
    holders: [
      { holderId: DEMO_CHARACTERS.kenji, kind: 'character', shares: 48_620_000, costPerShare: 0.2 },
      { holderId: 'fund_lattice', kind: 'fund', shares: 26_000_000, costPerShare: 14.9 },
      { holderId: FLOAT('meridian'), kind: 'public_float', shares: 185_380_000, costPerShare: 24.8 },
    ],
  },
  {
    slug: 'player_ventures',
    companyId: DEMO_COMPANIES.player,
    authorised: 100_000_000,
    issued: 12_000_000,
    optionPool: 1_500_000,
    holders: [
      { holderId: DEMO_CHARACTERS.player, kind: 'character', shares: 10_000_000, costPerShare: 0.0001 },
      { holderId: 'fund_lattice', kind: 'fund', shares: 2_000_000, costPerShare: 2.0 },
    ],
  },
];

function buildCapTable(seed: CapSeed): CapTable {
  return {
    companyId: seed.companyId,
    shareClasses: [
      {
        id: SHC(seed.slug),
        companyId: seed.companyId,
        kind: 'common',
        label: 'Common Stock',
        votesPerShare: 1,
        liquidationPreferenceMultiple: 0,
        participating: false,
        authorisedShares: seed.authorised,
        issuedShares: seed.issued,
        createdQuarter: 0,
      },
    ],
    holdings: seed.holders.map((holder, index) => ({
      id: makeId('hld', seed.slug, String(index)),
      holderId: holder.holderId,
      holderKind: holder.kind,
      securityId: SEC(seed.slug),
      shares: holder.shares,
      costBasisUsd: Math.round(holder.shares * holder.costPerShare),
      acquiredQuarter: 0,
      lockupUntilQuarter: null,
      isDisclosed: holder.shares / seed.issued >= 0.05,
    })),
    totalIssuedByClass: { [SHC(seed.slug)]: seed.issued },
    fullyDilutedShares: seed.issued + seed.optionPool,
    optionPoolShares: seed.optionPool,
    lastUpdatedQuarter: 0,
  };
}

/* -------------------------------------------------------------------------- */
/*  Market                                                                     */
/* -------------------------------------------------------------------------- */

interface QuoteSeed {
  readonly instrumentId: string;
  readonly price: number;
  readonly ret: number;
  readonly volume: number;
  readonly shares: number | null;
}

const QUOTE_SEEDS: readonly QuoteSeed[] = [
  { instrumentId: 'ins_nxs', price: 83.2, ret: 0.0518, volume: 41_200_000, shares: 620_000_000 },
  { instrumentId: 'ins_orb', price: 41.72, ret: -0.0309, volume: 18_600_000, shares: 540_000_000 },
  { instrumentId: 'ins_hlx', price: 57.35, ret: 0.0862, volume: 12_400_000, shares: 410_000_000 },
  { instrumentId: 'ins_vwa', price: 18.91, ret: -0.1558, volume: 26_900_000, shares: 300_000_000 },
  { instrumentId: 'ins_arc', price: 129.4, ret: 0.0948, volume: 34_800_000, shares: 780_000_000 },
  { instrumentId: 'ins_mrd', price: 26.15, ret: 0.0215, volume: 4_100_000, shares: 260_000_000 },
  { instrumentId: 'ins_fcai', price: 1000, ret: 0.0391, volume: 0, shares: null },
  { instrumentId: 'ins_fcsc', price: 1000, ret: 0.0706, volume: 0, shares: null },
];

const INSTRUMENTS: readonly MarketInstrument[] = [
  instrument('ins_nxs', 'NXS', 'Nexus Intelligence', DEMO_COMPANIES.nexus, 'nexus', 'frontier_models', 1.34, 620_000_000),
  instrument('ins_orb', 'ORB', 'Orbit Dynamics', DEMO_COMPANIES.orbit, 'orbit', 'enterprise_software', 1.05, 540_000_000),
  instrument('ins_hlx', 'HLX', 'Helix Systems', DEMO_COMPANIES.helix, 'helix', 'cloud_infrastructure', 0.92, 410_000_000),
  instrument('ins_vwa', 'VWA', 'VectorWorks AI', DEMO_COMPANIES.vectorworks, 'vectorworks', 'enterprise_software', 1.42, 300_000_000),
  instrument('ins_arc', 'ARC', 'Aurora Compute', DEMO_COMPANIES.aurora, 'aurora', 'semiconductors', 1.51, 780_000_000),
  instrument('ins_mrd', 'MRD', 'Meridian Data', DEMO_COMPANIES.meridian, 'meridian', 'data_services', 1.18, 260_000_000),
  {
    id: 'ins_fcai',
    kind: 'in_world_index',
    symbol: 'FCAI',
    name: 'Frontier Capital AI 50',
    companyId: null,
    securityId: null,
    sectorId: null,
    isReference: false,
    currency: 'USD',
    sharesOutstanding: null,
    listedQuarter: 0,
    beta: 1,
  },
  {
    id: 'ins_fcsc',
    kind: 'in_world_index',
    symbol: 'FCSC',
    name: 'Frontier Semiconductor & Compute Index',
    companyId: null,
    securityId: null,
    sectorId: 'semiconductors',
    isReference: false,
    currency: 'USD',
    sharesOutstanding: null,
    listedQuarter: 0,
    beta: 1.21,
  },
];

function instrument(
  id: string,
  symbol: string,
  name: string,
  companyId: string,
  slug: string,
  sectorId: string,
  beta: number,
  shares: number,
): MarketInstrument {
  return {
    id,
    kind: 'in_world_equity',
    symbol,
    name,
    companyId,
    securityId: SEC(slug),
    sectorId,
    isReference: false,
    currency: 'USD',
    sharesOutstanding: shares,
    listedQuarter: 0,
    beta,
  };
}

function buildQuote(seed: QuoteSeed): Quote {
  return {
    instrumentId: seed.instrumentId,
    quarter: 0,
    price: seed.price,
    return: seed.ret,
    volume: seed.volume,
    marketCapUsd: seed.shares === null ? 0 : seed.price * seed.shares,
  };
}

/* -------------------------------------------------------------------------- */
/*  People                                                                     */
/* -------------------------------------------------------------------------- */

interface CharacterSeed {
  readonly id: string;
  readonly name: string;
  readonly role: Character['role'];
  readonly companyId: string | null;
  readonly title: string;
  readonly traits: readonly [number, number, number, number, number];
  readonly connection: number;
  readonly wealth: number;
  readonly boards: number;
  readonly following: number;
  readonly isPlayer: boolean;
  readonly beliefs: readonly { readonly topic: Character['beliefs'][number]['topic']; readonly level: Character['beliefs'][number]['level'] }[];
}

const CHARACTER_SEEDS: readonly CharacterSeed[] = [
  {
    id: DEMO_CHARACTERS.maya,
    name: 'Maya Chen',
    role: 'founder_ceo',
    companyId: DEMO_COMPANIES.nexus,
    title: 'CEO — Nexus Intelligence',
    // riskTolerance, technicalOrientation, financialConservatism, aggressiveness, statusSensitivity
    traits: [89, 96, 27, 83, 66],
    connection: 86,
    wealth: 4.1 * BN,
    boards: 2,
    following: 1_900_000,
    isPlayer: false,
    beliefs: [
      { topic: 'compute_scarcity', level: 'high' },
      { topic: 'ai_regulation_risk', level: 'medium' },
      { topic: 'frontier_progress', level: 'high' },
    ],
  },
  {
    id: DEMO_CHARACTERS.daniel,
    name: 'Daniel Okonkwo',
    role: 'founder_ceo',
    companyId: DEMO_COMPANIES.orbit,
    title: 'CEO — Orbit Dynamics',
    traits: [41, 58, 74, 39, 44],
    connection: 74,
    wealth: 890 * M,
    boards: 2,
    following: 320_000,
    isPlayer: false,
    beliefs: [
      { topic: 'consolidation_inevitable', level: 'medium' },
      { topic: 'government_demand', level: 'high' },
    ],
  },
  {
    id: DEMO_CHARACTERS.priya,
    name: 'Priya Raghavan',
    role: 'founder_ceo',
    companyId: DEMO_COMPANIES.helix,
    title: 'CEO — Helix Systems',
    traits: [55, 71, 69, 52, 38],
    connection: 79,
    wealth: 1.25 * BN,
    boards: 1,
    following: 140_000,
    isPlayer: false,
    beliefs: [
      { topic: 'compute_scarcity', level: 'high' },
      { topic: 'market_bubble', level: 'medium' },
    ],
  },
  {
    id: DEMO_CHARACTERS.tomas,
    name: 'Tomas Lindqvist',
    role: 'founder_ceo',
    companyId: DEMO_COMPANIES.vectorworks,
    title: 'CEO — VectorWorks AI',
    traits: [34, 91, 46, 29, 72],
    connection: 51,
    wealth: 96 * M,
    boards: 1,
    following: 88_000,
    isPlayer: false,
    beliefs: [
      { topic: 'safety_priority', level: 'high' },
      { topic: 'market_bubble', level: 'high' },
    ],
  },
  {
    id: DEMO_CHARACTERS.rebecca,
    name: 'Rebecca Aldana',
    role: 'founder_ceo',
    companyId: DEMO_COMPANIES.aurora,
    title: 'CEO — Aurora Compute',
    traits: [62, 79, 51, 77, 58],
    connection: 84,
    wealth: 2.6 * BN,
    boards: 3,
    following: 410_000,
    isPlayer: false,
    beliefs: [
      { topic: 'geopolitical_risk', level: 'high' },
      { topic: 'compute_scarcity', level: 'high' },
    ],
  },
  {
    id: DEMO_CHARACTERS.kenji,
    name: 'Kenji Watanabe',
    role: 'founder_ceo',
    companyId: DEMO_COMPANIES.meridian,
    title: 'CEO — Meridian Data',
    traits: [68, 89, 44, 31, 35],
    connection: 62,
    wealth: 210 * M,
    boards: 1,
    following: 260_000,
    isPlayer: false,
    beliefs: [
      { topic: 'open_source_threat', level: 'low' },
      { topic: 'frontier_progress', level: 'medium' },
    ],
  },
  {
    id: DEMO_CHARACTERS.eleanor,
    name: 'Eleanor Vance',
    role: 'investor',
    companyId: null,
    title: 'Managing Partner — Lattice Ventures',
    traits: [57, 62, 71, 48, 55],
    connection: 88,
    wealth: 780 * M,
    boards: 6,
    following: 96_000,
    isPlayer: false,
    beliefs: [
      { topic: 'player_trustworthiness', level: 'medium' },
      { topic: 'consolidation_inevitable', level: 'high' },
    ],
  },
  {
    id: DEMO_CHARACTERS.marcus,
    name: 'Marcus Feld',
    role: 'investor',
    companyId: null,
    title: 'Partner — Halberd Growth Partners',
    traits: [71, 44, 33, 62, 51],
    connection: 76,
    wealth: 410 * M,
    boards: 4,
    following: 41_000,
    isPlayer: false,
    beliefs: [
      { topic: 'market_bubble', level: 'low' },
      { topic: 'talent_war', level: 'medium' },
    ],
  },
  {
    id: DEMO_CHARACTERS.nadia,
    name: 'Nadia Okafor',
    role: 'investor',
    companyId: null,
    title: 'Chief Investment Officer — Al-Bahr Sovereign Fund',
    traits: [44, 66, 78, 35, 81],
    connection: 93,
    wealth: 0,
    boards: 2,
    following: 12_000,
    isPlayer: false,
    beliefs: [
      { topic: 'geopolitical_risk', level: 'high' },
      { topic: 'government_demand', level: 'high' },
    ],
  },
  {
    id: DEMO_CHARACTERS.sarah,
    name: 'Sarah Zhou',
    role: 'director',
    companyId: null,
    title: 'Independent Director',
    traits: [46, 61, 84, 44, 42],
    connection: 69,
    wealth: 145 * M,
    boards: 3,
    following: 28_000,
    isPlayer: false,
    beliefs: [{ topic: 'consolidation_inevitable', level: 'medium' }],
  },
  {
    id: DEMO_CHARACTERS.idris,
    name: 'Idris Bello',
    role: 'director',
    companyId: null,
    title: 'Independent Director',
    traits: [44, 95, 55, 26, 33],
    connection: 64,
    wealth: 12 * M,
    boards: 3,
    following: 71_000,
    isPlayer: false,
    beliefs: [
      { topic: 'safety_priority', level: 'high' },
      { topic: 'frontier_progress', level: 'medium' },
    ],
  },
  {
    id: DEMO_CHARACTERS.grace,
    name: 'Grace Halloran',
    role: 'director',
    companyId: null,
    title: 'Independent Director',
    traits: [28, 49, 96, 58, 47],
    connection: 71,
    wealth: 88 * M,
    boards: 4,
    following: 19_000,
    isPlayer: false,
    beliefs: [{ topic: 'market_bubble', level: 'high' }],
  },
  {
    id: DEMO_CHARACTERS.alan,
    name: 'Alan Prieto',
    role: 'regulator',
    companyId: null,
    title: 'Commissioner — Federal AI Oversight Bureau',
    traits: [31, 58, 72, 46, 63],
    connection: 81,
    wealth: 0,
    boards: 0,
    following: 34_000,
    isPlayer: false,
    beliefs: [
      { topic: 'ai_regulation_risk', level: 'high' },
      { topic: 'consolidation_inevitable', level: 'high' },
    ],
  },
  {
    id: DEMO_CHARACTERS.ines,
    name: 'Ines Duarte',
    role: 'journalist',
    companyId: null,
    title: 'Senior Correspondent — The Frontier Ledger',
    traits: [52, 66, 48, 67, 44],
    connection: 72,
    wealth: 3 * M,
    boards: 0,
    following: 640_000,
    isPlayer: false,
    beliefs: [{ topic: 'safety_priority', level: 'high' }],
  },
  {
    id: DEMO_CHARACTERS.rowan,
    name: 'Rowan Ellis',
    role: 'journalist',
    companyId: null,
    title: 'Markets Editor — Capital Wire',
    traits: [64, 41, 39, 58, 56],
    connection: 66,
    wealth: 1.8 * M,
    boards: 0,
    following: 480_000,
    isPlayer: false,
    beliefs: [{ topic: 'market_bubble', level: 'medium' }],
  },
  {
    id: DEMO_CHARACTERS.player,
    name: 'Avery Sinclair',
    role: 'founder_ceo',
    companyId: DEMO_COMPANIES.player,
    title: 'Founder and CEO — Player Ventures',
    traits: [66, 62, 48, 54, 50],
    connection: 24,
    wealth: 850_000,
    boards: 1,
    following: 4_200,
    isPlayer: true,
    beliefs: [
      { topic: 'compute_scarcity', level: 'high' },
      { topic: 'talent_war', level: 'medium' },
    ],
  },
];

function buildCharacter(seed: CharacterSeed): Character {
  const [riskTolerance, technicalOrientation, financialConservatism, aggressiveness, statusSensitivity] = seed.traits;
  return {
    id: seed.id,
    name: seed.name,
    role: seed.role,
    companyId: seed.companyId,
    title: seed.title,
    stableTraits: { riskTolerance, technicalOrientation, financialConservatism, aggressiveness, statusSensitivity },
    beliefs: seed.beliefs.map((belief) => ({ ...belief })),
    connectionLevel: seed.connection,
    isPlayer: seed.isPlayer,
    personalWealthUsd: seed.wealth,
    boardSeatCount: seed.boards,
    publicFollowing: seed.following,
    isActive: true,
  };
}

/* -------------------------------------------------------------------------- */
/*  The Frontier Map                                                           */
/* -------------------------------------------------------------------------- */

interface NodeSeed {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly status: TechNode['status'];
  readonly confidence: number;
  readonly window: readonly [number, number];
  readonly cost: readonly [number, number];
  readonly intensity: number;
  readonly talent: readonly string[];
  readonly novelty: number;
  readonly plausibility: number;
  readonly visibility?: TechNode['visibility'];
  readonly owner?: string;
  readonly achievedBy?: string;
  readonly companyConfidence?: Readonly<Record<string, number>>;
}

const NODE_SEEDS: readonly NodeSeed[] = [
  {
    id: 'tech_transformer_scaling',
    title: 'Transformer Scaling',
    summary: 'Predictable capability gains from scaling parameters, data and training compute. The industry’s load-bearing assumption, and demonstrated at frontier scale.',
    status: 'achieved',
    confidence: 0.95,
    window: [2021, 2027],
    cost: [200 * M, 4 * BN],
    intensity: 0.92,
    talent: ['training_systems', 'infrastructure', 'data_curation'],
    novelty: 0.1,
    plausibility: 0.98,
    achievedBy: DEMO_COMPANIES.nexus,
  },
  {
    id: 'tech_retrieval_grounding',
    title: 'Retrieval Grounding',
    summary: 'Anchoring generation in retrieved, attributable evidence. Table stakes for any regulated deployment, and the foundation VectorWorks was built on.',
    status: 'established',
    confidence: 0.9,
    window: [2022, 2026],
    cost: [20 * M, 180 * M],
    intensity: 0.24,
    talent: ['retrieval', 'evaluation'],
    novelty: 0.15,
    plausibility: 0.96,
  },
  {
    id: 'tech_tool_learning',
    title: 'Tool Learning',
    summary: 'Models that reliably call external tools and act on the results, rather than describing what a tool would return.',
    status: 'established',
    confidence: 0.86,
    window: [2023, 2027],
    cost: [40 * M, 320 * M],
    intensity: 0.38,
    talent: ['agents', 'evaluation'],
    novelty: 0.22,
    plausibility: 0.94,
  },
  {
    id: 'tech_synthetic_data_curricula',
    title: 'Synthetic Data Curricula',
    summary: 'Deliberately constructed training curricula that outperform scraped corpora at equal token budgets. Meridian has more evidence for this than it has published.',
    status: 'emerging',
    confidence: 0.72,
    window: [2027, 2029],
    cost: [90 * M, 600 * M],
    intensity: 0.61,
    talent: ['data_curation', 'evaluation', 'training_systems'],
    novelty: 0.44,
    plausibility: 0.78,
    companyConfidence: { [DEMO_COMPANIES.meridian]: 0.88 },
  },
  {
    id: 'tech_sparse_expert_reasoning',
    title: 'Sparse Expert Reasoning',
    summary: 'Conditional computation that routes reasoning through specialised experts, cutting inference cost at constant capability.',
    status: 'emerging',
    confidence: 0.68,
    window: [2027, 2030],
    cost: [150 * M, 900 * M],
    intensity: 0.71,
    talent: ['reasoning', 'training_systems', 'efficiency'],
    novelty: 0.51,
    plausibility: 0.74,
    companyConfidence: { [DEMO_COMPANIES.nexus]: 0.62 },
  },
  {
    id: 'tech_recursive_tool_learning',
    title: 'Recursive Tool Learning',
    summary: 'Systems that build, evaluate and reuse their own tools across tasks, compounding capability without new training runs.',
    status: 'emerging',
    confidence: 0.61,
    window: [2028, 2031],
    cost: [180 * M, 850 * M],
    intensity: 0.66,
    talent: ['agents', 'reasoning', 'evaluation'],
    novelty: 0.58,
    plausibility: 0.69,
  },
  {
    id: 'tech_long_horizon_planning',
    title: 'Long-Horizon Planning',
    summary: 'Reliable multi-week task decomposition and recovery without human checkpoints.',
    status: 'forecast',
    confidence: 0.54,
    window: [2029, 2032],
    cost: [240 * M, 1.1 * BN],
    intensity: 0.69,
    talent: ['reasoning', 'agents'],
    novelty: 0.62,
    plausibility: 0.61,
  },
  {
    id: 'tech_efficient_sparse_inference',
    title: 'Efficient Sparse Inference',
    summary: 'Order-of-magnitude reductions in serving cost through sparsity, quantisation and speculative decoding.',
    status: 'emerging',
    confidence: 0.47,
    window: [2028, 2030],
    cost: [60 * M, 420 * M],
    intensity: 0.44,
    talent: ['efficiency', 'infrastructure'],
    novelty: 0.39,
    plausibility: 0.81,
    companyConfidence: { [DEMO_COMPANIES.vectorworks]: 0.64 },
  },
  {
    id: 'tech_specialised_accelerator_design',
    title: 'Specialised Accelerator Design',
    summary: 'Silicon designed around one inference regime rather than general matrix throughput.',
    status: 'forecast',
    confidence: 0.58,
    window: [2029, 2032],
    cost: [900 * M, 4.2 * BN],
    intensity: 0.35,
    talent: ['hardware_design', 'infrastructure'],
    novelty: 0.47,
    plausibility: 0.72,
    companyConfidence: { [DEMO_COMPANIES.aurora]: 0.79 },
  },
  {
    id: 'tech_mechanistic_interpretability',
    title: 'Mechanistic Interpretability at Scale',
    summary: 'Reading the computation of frontier-scale models well enough to certify behaviour to a regulator.',
    status: 'emerging',
    confidence: 0.49,
    window: [2029, 2033],
    cost: [120 * M, 700 * M],
    intensity: 0.52,
    talent: ['evaluation', 'safety_alignment'],
    novelty: 0.55,
    plausibility: 0.63,
  },
  {
    id: 'tech_autonomous_research',
    title: 'Autonomous Research Systems',
    summary: 'Systems that formulate hypotheses, run experiments and revise their own research agenda.',
    status: 'forecast',
    confidence: 0.58,
    window: [2030, 2033],
    cost: [400 * M, 1.1 * BN],
    intensity: 0.74,
    talent: ['reasoning', 'agents', 'evaluation'],
    novelty: 0.71,
    plausibility: 0.58,
  },
  {
    id: 'tech_automated_engineering',
    title: 'Automated Engineering',
    summary: 'End-to-end delivery of production software and hardware designs without human implementation.',
    status: 'forecast',
    confidence: 0.44,
    window: [2031, 2035],
    cost: [500 * M, 1.8 * BN],
    intensity: 0.68,
    talent: ['agents', 'infrastructure', 'evaluation'],
    novelty: 0.66,
    plausibility: 0.52,
  },
  {
    id: 'tech_self_directed_science',
    title: 'Self-Directed Science',
    summary: 'Sustained, open-ended scientific programmes chosen and pursued by the system itself.',
    status: 'speculative',
    confidence: 0.27,
    window: [2033, 2040],
    cost: [1.2 * BN, 6 * BN],
    intensity: 0.88,
    talent: ['reasoning', 'agents', 'safety_alignment'],
    novelty: 0.84,
    plausibility: 0.34,
  },
  {
    id: 'tech_continual_online_learning',
    title: 'Continual Online Learning',
    summary: 'Models that update from deployment experience without catastrophic forgetting. Three published attempts drifted badly under evaluation, and the industry has stopped funding it.',
    status: 'dead_end',
    confidence: 0.11,
    window: [2030, 2036],
    cost: [200 * M, 1.4 * BN],
    intensity: 0.57,
    talent: ['training_systems', 'safety_alignment'],
    novelty: 0.69,
    plausibility: 0.19,
  },
  {
    id: 'tech_neuromorphic_substrates',
    title: 'Neuromorphic Substrates',
    summary: 'Event-driven analogue hardware as a replacement for dense digital accelerators. Two failed commercialisations have drained conviction without quite killing the idea.',
    status: 'discredited',
    confidence: 0.12,
    window: [2035, 2045],
    cost: [2 * BN, 9 * BN],
    intensity: 0.29,
    talent: ['hardware_design'],
    novelty: 0.77,
    plausibility: 0.14,
  },
  {
    id: 'tech_persistent_agent_economies',
    title: 'Persistent Agent Economies',
    summary: 'Millions of agents learning economic behaviour together in persistent simulated environments. Meridian Data’s house thesis; almost nobody else believes it.',
    status: 'company_thesis',
    confidence: 0.22,
    window: [2031, 2037],
    cost: [280 * M, 1.6 * BN],
    intensity: 0.79,
    talent: ['agents', 'training_systems', 'infrastructure'],
    novelty: 0.82,
    plausibility: 0.63,
    owner: DEMO_COMPANIES.meridian,
    companyConfidence: { [DEMO_COMPANIES.meridian]: 0.81 },
  },
  {
    id: 'tech_dense_scaling_saturation',
    title: 'Dense Scaling Saturation',
    summary: 'Internal evidence that dense pretraining returns fall off a cliff two generations ahead of the public consensus curve. Nexus has not said so, and its guidance does not reflect it.',
    status: 'secret',
    confidence: 0.04,
    window: [2028, 2029],
    cost: [0, 0],
    intensity: 0.05,
    talent: ['training_systems', 'evaluation'],
    novelty: 0.58,
    plausibility: 0.81,
    visibility: 'company_private',
    owner: DEMO_COMPANIES.nexus,
    companyConfidence: { [DEMO_COMPANIES.nexus]: 0.74 },
  },
];

const EDGE_SEEDS: readonly { from: string; to: string; kind: 'depends' | 'unlocks' | 'informs'; strength: number }[] = [
  { from: 'tech_transformer_scaling', to: 'tech_sparse_expert_reasoning', kind: 'depends', strength: 1 },
  { from: 'tech_transformer_scaling', to: 'tech_recursive_tool_learning', kind: 'depends', strength: 0.8 },
  { from: 'tech_tool_learning', to: 'tech_recursive_tool_learning', kind: 'depends', strength: 1 },
  { from: 'tech_retrieval_grounding', to: 'tech_tool_learning', kind: 'informs', strength: 0.7 },
  { from: 'tech_sparse_expert_reasoning', to: 'tech_efficient_sparse_inference', kind: 'unlocks', strength: 1 },
  { from: 'tech_efficient_sparse_inference', to: 'tech_specialised_accelerator_design', kind: 'informs', strength: 0.9 },
  { from: 'tech_synthetic_data_curricula', to: 'tech_autonomous_research', kind: 'depends', strength: 0.9 },
  { from: 'tech_recursive_tool_learning', to: 'tech_autonomous_research', kind: 'depends', strength: 1 },
  { from: 'tech_long_horizon_planning', to: 'tech_autonomous_research', kind: 'depends', strength: 1 },
  { from: 'tech_mechanistic_interpretability', to: 'tech_autonomous_research', kind: 'depends', strength: 0.5 },
  { from: 'tech_autonomous_research', to: 'tech_automated_engineering', kind: 'unlocks', strength: 1 },
  { from: 'tech_autonomous_research', to: 'tech_self_directed_science', kind: 'unlocks', strength: 1 },
  { from: 'tech_transformer_scaling', to: 'tech_continual_online_learning', kind: 'depends', strength: 0.6 },
  { from: 'tech_synthetic_data_curricula', to: 'tech_persistent_agent_economies', kind: 'depends', strength: 0.8 },
  { from: 'tech_persistent_agent_economies', to: 'tech_autonomous_research', kind: 'informs', strength: 0.6 },
  { from: 'tech_specialised_accelerator_design', to: 'tech_neuromorphic_substrates', kind: 'informs', strength: 0.7 },
  { from: 'tech_dense_scaling_saturation', to: 'tech_transformer_scaling', kind: 'informs', strength: 1 },
];

function buildNode(seed: NodeSeed): TechNode {
  const dependencies = EDGE_SEEDS.filter((edge) => edge.to === seed.id && edge.kind === 'depends').map((edge) => edge.from);
  const unlocks = EDGE_SEEDS.filter((edge) => edge.from === seed.id && edge.kind === 'unlocks').map((edge) => edge.to);
  return {
    id: seed.id,
    title: seed.title,
    summary: seed.summary,
    status: seed.status,
    publicConfidence: seed.confidence,
    confidenceByCompany: { ...(seed.companyConfidence ?? {}) },
    estimatedWindow: [seed.window[0], seed.window[1]],
    researchCostRange: [seed.cost[0], seed.cost[1]],
    computeIntensity: seed.intensity,
    talentRequirements: [...seed.talent],
    dependencies,
    possibleUnlocks: unlocks,
    originalProposerId: null,
    visibility: seed.visibility ?? 'public',
    achievedByCompanyId: seed.achievedBy ?? null,
    achievedQuarter: seed.achievedBy === undefined ? null : 0,
    createdQuarter: 0,
    novelty: seed.novelty,
    plausibility: seed.plausibility,
  };
}

/* -------------------------------------------------------------------------- */
/*  Government                                                                 */
/* -------------------------------------------------------------------------- */

const OPPORTUNITIES: readonly ProcurementOpportunity[] = [
  {
    id: 'opp_sovereign_platform',
    agencyId: 'agy_defence',
    programme: 'Sovereign Intelligence Platform',
    description:
      'A sovereign-controlled reasoning and analysis platform operated entirely on domestic infrastructure, with full model audit and assured availability.',
    maxValue: 2.4 * BN,
    contractForm: 'cost_plus',
    durationQuarters: 20,
    // The seven weights sum to exactly 1, as the schema requires.
    evaluationWeights: { technical: 0.3, security: 0.2, pastPerformance: 0.15, priceRealism: 0.15, schedule: 0.1, domesticSupply: 0.05, responsibleAi: 0.05 },
    requirements: {
      clearanceLevel: 'level_iv',
      domesticInference: true,
      modelAudit: true,
      uptimePct: 99.99,
      dataSovereignty: true,
      minimumPastPerformance: 55,
    },
    openQuarter: 0,
    closeQuarter: 2,
    visibility: 'public',
    invitedCompanyIds: [],
    allowsConsortium: true,
    status: 'open',
  },
  {
    id: 'opp_civic_modernisation',
    agencyId: 'agy_modernisation',
    programme: 'National Civic Services Modernisation',
    description:
      'Replace the legacy citizen benefits and licensing stack with an assisted-service platform. Heavily scrutinised on cost and accessibility, lightly scrutinised on capability.',
    maxValue: 780 * M,
    contractForm: 'fixed_price',
    durationQuarters: 12,
    evaluationWeights: { technical: 0.25, security: 0.1, pastPerformance: 0.2, priceRealism: 0.3, schedule: 0.1, domesticSupply: 0.03, responsibleAi: 0.02 },
    requirements: {
      clearanceLevel: 'level_ii',
      domesticInference: false,
      modelAudit: false,
      uptimePct: 99.9,
      dataSovereignty: false,
      minimumPastPerformance: 40,
    },
    openQuarter: 0,
    closeQuarter: 3,
    visibility: 'public',
    invitedCompanyIds: [],
    allowsConsortium: true,
    status: 'open',
  },
];

/* -------------------------------------------------------------------------- */
/*  Research programmes                                                        */
/* -------------------------------------------------------------------------- */

const RESEARCH_PROJECTS: readonly ResearchProject[] = [
  {
    id: 'rsp_nexus_sparse_expert',
    companyId: DEMO_COMPANIES.nexus,
    targetNodeId: 'tech_sparse_expert_reasoning',
    budgetQuarterly: 840 * M,
    computeAllocated: 96_000,
    talentAllocated: 210,
    progress: 0.08,
    internalConfidence: 0.62,
    quartersElapsed: 1,
    expectedQuarters: 5,
    isSecret: false,
    status: 'active',
    cumulativeSpendUsd: 61 * M,
    setbacks: 0,
    startedQuarter: 0,
  },
  {
    id: 'rsp_nexus_scaling_wall',
    companyId: DEMO_COMPANIES.nexus,
    targetNodeId: 'tech_dense_scaling_saturation',
    budgetQuarterly: 40 * M,
    computeAllocated: 6_000,
    talentAllocated: 24,
    progress: 0.34,
    internalConfidence: 0.74,
    quartersElapsed: 2,
    expectedQuarters: 4,
    // The programme nobody outside Nexus knows exists. Its setbacks stay out of
    // the share price; its conclusions contradict the company's own guidance.
    isSecret: true,
    status: 'active',
    cumulativeSpendUsd: 74 * M,
    setbacks: 1,
    startedQuarter: 0,
  },
  {
    id: 'rsp_meridian_agent_economies',
    companyId: DEMO_COMPANIES.meridian,
    targetNodeId: 'tech_persistent_agent_economies',
    budgetQuarterly: 46 * M,
    computeAllocated: 9_000,
    talentAllocated: 140,
    progress: 0.21,
    internalConfidence: 0.81,
    quartersElapsed: 3,
    expectedQuarters: 9,
    isSecret: false,
    status: 'active',
    cumulativeSpendUsd: 138 * M,
    setbacks: 1,
    startedQuarter: 0,
  },
  {
    id: 'rsp_vectorworks_sparse_inference',
    companyId: DEMO_COMPANIES.vectorworks,
    targetNodeId: 'tech_efficient_sparse_inference',
    budgetQuarterly: 34 * M,
    computeAllocated: 900,
    talentAllocated: 120,
    progress: 0.44,
    internalConfidence: 0.64,
    quartersElapsed: 4,
    expectedQuarters: 6,
    isSecret: false,
    status: 'active',
    cumulativeSpendUsd: 148 * M,
    setbacks: 0,
    startedQuarter: 0,
  },
];

/* -------------------------------------------------------------------------- */
/*  Boards                                                                     */
/* -------------------------------------------------------------------------- */

function director(
  characterId: string,
  seat: Board['directors'][number]['seat'],
  mandate: Board['directors'][number]['mandate'],
  scores: { independence: number; risk: number; growth: number; discipline: number; tech: number; safety: number; ceo: number },
  isChair = false,
  representedHolderId: string | null = null,
): Board['directors'][number] {
  return {
    characterId,
    seat,
    independence: scores.independence,
    riskTolerance: scores.risk,
    growthPreference: scores.growth,
    financialDiscipline: scores.discipline,
    techKnowledge: scores.tech,
    safetyOrientation: scores.safety,
    relationshipWithCeo: scores.ceo,
    mandate,
    votingWeight: 1,
    isChair,
    appointedQuarter: 0,
    representedHolderId,
    committees: seat === 'independent' ? ['audit', 'risk'] : [],
  };
}

const BOARDS: readonly Board[] = [
  {
    id: 'brd_nexus',
    companyId: DEMO_COMPANIES.nexus,
    directors: [
      director(DEMO_CHARACTERS.maya, 'founder', 'founder_vision', { independence: 5, risk: 89, growth: 94, discipline: 27, tech: 96, safety: 44, ceo: 100 }, true),
      director(DEMO_CHARACTERS.eleanor, 'investor', 'investor_return', { independence: 22, risk: 57, growth: 71, discipline: 74, tech: 62, safety: 58, ceo: 34 }, false, 'fund_lattice'),
      director(DEMO_CHARACTERS.marcus, 'investor', 'investor_return', { independence: 18, risk: 71, growth: 83, discipline: 33, tech: 41, safety: 24, ceo: 21 }, false, 'fund_halberd'),
      director(DEMO_CHARACTERS.idris, 'independent', 'independent_oversight', { independence: 92, risk: 44, growth: 38, discipline: 55, tech: 95, safety: 79, ceo: -12 }),
      director(DEMO_CHARACTERS.sarah, 'independent', 'independent_oversight', { independence: 88, risk: 36, growth: 46, discipline: 84, tech: 61, safety: 52, ceo: 8 }),
    ],
    quorumRule: DEFAULT_QUORUM_RULE,
    chairCharacterId: DEMO_CHARACTERS.maya,
    nextMeetingQuarter: 0,
    seatsAuthorised: 5,
  },
  {
    id: 'brd_player_ventures',
    companyId: DEMO_COMPANIES.player,
    directors: [
      director(DEMO_CHARACTERS.player, 'founder', 'founder_vision', { independence: 8, risk: 66, growth: 88, discipline: 48, tech: 62, safety: 50, ceo: 100 }, true),
      director(DEMO_CHARACTERS.eleanor, 'investor', 'investor_return', { independence: 24, risk: 57, growth: 68, discipline: 74, tech: 62, safety: 58, ceo: 46 }, false, 'fund_lattice'),
      director(DEMO_CHARACTERS.grace, 'independent', 'independent_oversight', { independence: 86, risk: 28, growth: 44, discipline: 96, tech: 49, safety: 55, ceo: 12 }),
      director(DEMO_CHARACTERS.sarah, 'independent', 'independent_oversight', { independence: 88, risk: 36, growth: 46, discipline: 84, tech: 61, safety: 52, ceo: 18 }),
      director(DEMO_CHARACTERS.idris, 'independent', 'independent_oversight', { independence: 92, risk: 44, growth: 38, discipline: 55, tech: 95, safety: 79, ceo: 22 }),
    ],
    quorumRule: DEFAULT_QUORUM_RULE,
    chairCharacterId: DEMO_CHARACTERS.player,
    nextMeetingQuarter: 0,
    seatsAuthorised: 7,
  },
];

/* -------------------------------------------------------------------------- */
/*  Metrics                                                                    */
/* -------------------------------------------------------------------------- */

function buildMetrics(seed: CompanySeed, marketCap: number, enterpriseValue: number): CompanyQuarterMetrics {
  const f = seed.financials;
  const headcount = seed.employees.engineers + seed.employees.researchers + seed.employees.sales + seed.employees.ops + seed.employees.execs;
  const operating = f.revenue - f.cogs - f.payroll - f.marketing - f.rd;
  const burn = Math.max(0, -f.burn);
  const computeCost = seed.compute.cloud + seed.compute.reserved * 2_100 + seed.compute.owned * 420;
  const totalCost = f.cogs + f.payroll + f.marketing + f.rd;
  return {
    companyId: seed.id,
    quarter: 0,
    revenueTtm: f.revenue * 4,
    revenueGrowthYoY: seed.product.growth * 3,
    grossMarginPct: f.revenue > 0 ? Math.max(0, Math.min(1, (f.revenue - f.cogs) / f.revenue)) : 0,
    operatingMarginPct: f.revenue > 0 ? Math.max(-10, Math.min(1, operating / f.revenue)) : 0,
    headcount,
    runwayQuarters: burn <= 0 ? 200 : Math.min(200, f.cash / burn),
    enterpriseValueUsd: enterpriseValue,
    marketCapUsd: marketCap,
    computeCostShare: totalCost > 0 ? Math.max(0, Math.min(1, computeCost / totalCost)) : 0,
    governmentRevenueShare: 0,
  };
}

/* -------------------------------------------------------------------------- */
/*  The scenario                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Build the 2027 Q1 demo world.
 *
 * `seed` sets `SessionState.seed` and the session id; the world data itself is
 * fixed, so the same seed always produces a byte-identical state.
 */
export function createDemoSession(seed: number = DEMO_SEED): SessionState {
  return SessionStateSchema.parse(demoSessionInput(seed));
}

/** The unparsed input, for fixtures that want to vary one field before parsing. */
export function demoSessionInput(seed: number = DEMO_SEED): SessionStateInput {
  const sessionId = makeId('sess', 'demo', String(seed));
  const anchors: Readonly<Record<string, { value: number; method: 'revenue_multiple' | 'forward_revenue_quality' | 'earnings_fcf' | 'asset_cashflow_utilisation' | 'technology_option_value' }>> = {
    [DEMO_COMPANIES.nexus]: { value: 44.1 * BN, method: 'technology_option_value' },
    [DEMO_COMPANIES.orbit]: { value: 24.3 * BN, method: 'forward_revenue_quality' },
    [DEMO_COMPANIES.helix]: { value: 26.8 * BN, method: 'asset_cashflow_utilisation' },
    [DEMO_COMPANIES.vectorworks]: { value: 7.35 * BN, method: 'forward_revenue_quality' },
    [DEMO_COMPANIES.aurora]: { value: 84 * BN, method: 'earnings_fcf' },
    [DEMO_COMPANIES.meridian]: { value: 7.9 * BN, method: 'revenue_multiple' },
    [DEMO_COMPANIES.player]: { value: 18 * M, method: 'revenue_multiple' },
  };
  const marketCaps = new Map(QUOTE_SEEDS.filter((q) => q.shares !== null).map((q) => [q.instrumentId, q.price * (q.shares ?? 0)]));

  return {
    sessionId,
    seed: String(seed),
    quarter: 0,
    startYear: 2027,
    status: 'active',
    config: {
      playerCount: 1,
      difficulty: 'standard',
      majorRivalCount: 4,
      significantCompanyCount: 2,
      backgroundCompanyCount: 0,
      scenarioId: 'frontier_2027',
      startYear: 2027,
      quarterLimit: null,
      enableReferenceMarket: false,
      allowPlayerInnovation: true,
      autoExecuteRoutineDefault: false,
    },
    ledgerSequence: 0,
    // No world snapshot exists at the opening quarter: the resolver writes the
    // first one when this quarter commits.
    lastResolvedQuarter: null,

    world: {
      macro: { gdpGrowth: 0.024, inflation: 0.031, policyRate: 0.0375, unemployment: 0.043, creditSpreads: 0.018, fxVolatility: 0.31, consumerDemand: 0.56 },
      capitalMarkets: { riskAppetite: 0.62, ipoWindow: 0.48, ventureLiquidity: 0.58, sectorMultiples: 1.35, volatility: 0.34, debtAvailability: 0.61 },
      compute: { acceleratorSupply: 0.41, cloudCapacity: 0.47, spotPrice: 1.62, reservedPrice: 1.24, fabCapacity: 0.38, energyDemand: 0.66 },
      energy: { electricityPrice: 1.28, datacentreAccess: 0.44, renewableCapacity: 0.39, gridConstraint: 0.58 },
      aiFrontier: { frontierCapability: 0.71, inferenceCost: 0.62, trainingEfficiency: 0.48, openSourceGap: 0.29, benchmarkSaturation: 0.68 },
      talent: { researcherSupply: 0.32, engineerSupply: 0.51, salaryPressure: 1.34, immigrationAccess: 0.47 },
      dataDomain: { dataAvailability: 0.44, licensingCost: 1.55, privacyRestriction: 0.52, syntheticDataMaturity: 0.46 },
      society: { aiTrust: 0.44, automationAnxiety: 0.61, consumerSentiment: 0.53, developerSentiment: 0.58 },
      regulation: { modelRules: 0.42, privacy: 0.55, antitrust: 0.48, copyright: 0.51, safetyObligations: 0.46, exportControls: 0.57 },
      government: { procurementBudget: 0.63, defenceUrgency: 0.71, digitalModernisation: 0.52, grantFunding: 0.41 },
      geopolitics: { tradeFriction: 0.54, conflictRisk: 0.38, sanctions: 0.46, techCompetition: 0.74 },
      media: { attentionLevel: 0.78, institutionalTrust: 0.41, controversyIntensity: 0.44, dominantNarrative: 'geopolitical_race' },
    },
    sectors: {
      semiconductors: { sectorId: 'semiconductors', sentiment: 0.42, multiple: 1.55, demand: 0.78, volatility: 0.42 },
      cloud_infrastructure: { sectorId: 'cloud_infrastructure', sentiment: 0.28, multiple: 1.25, demand: 0.72, volatility: 0.3 },
      frontier_models: { sectorId: 'frontier_models', sentiment: 0.51, multiple: 2.1, demand: 0.68, volatility: 0.55 },
      enterprise_software: { sectorId: 'enterprise_software', sentiment: 0.12, multiple: 1.15, demand: 0.61, volatility: 0.28 },
      consumer_ai: { sectorId: 'consumer_ai', sentiment: -0.08, multiple: 0.95, demand: 0.47, volatility: 0.36 },
      data_services: { sectorId: 'data_services', sentiment: 0.05, multiple: 1.1, demand: 0.52, volatility: 0.33 },
      defence_tech: { sectorId: 'defence_tech', sentiment: 0.33, multiple: 1.3, demand: 0.66, volatility: 0.31 },
      energy_infrastructure: { sectorId: 'energy_infrastructure', sentiment: 0.18, multiple: 1.2, demand: 0.74, volatility: 0.27 },
    },
    activeModifiers: [],
    activeEvents: [],
    // Left empty on purpose: the economy subsystem seeds hazard state for every
    // family it knows about on the first quarter it resolves.
    eventHazards: {},

    companies: COMPANY_SEEDS.map(buildCompany),
    companyMetrics: COMPANY_SEEDS.map((seed) => {
      const instrumentId = seed.instrumentId;
      const marketCap = instrumentId === null ? (anchors[seed.id]?.value ?? 0) : marketCaps.get(instrumentId) ?? 0;
      return buildMetrics(seed, marketCap, anchors[seed.id]?.value ?? marketCap);
    }),
    capTables: CAP_SEEDS.map(buildCapTable),
    securities: COMPANY_SEEDS.map((seed) => ({
      id: SEC(seed.slug),
      companyId: seed.id,
      shareClassId: SHC(seed.slug),
      symbol: seed.ticker,
      isTradable: seed.isPublic,
      instrumentId: seed.instrumentId,
      parValueUsd: 0.0001,
    })),
    fundingRounds: [
      {
        id: 'rnd_player_ventures_seed',
        companyId: DEMO_COMPANIES.player,
        stage: 'seed',
        amount: 4 * M,
        preMoney: 20 * M,
        postMoney: 24 * M,
        dilution: 4 / 24,
        pricePerShareUsd: 2,
        shareClassId: SHC('player_ventures'),
        leadInvestorCharacterId: DEMO_CHARACTERS.eleanor,
        participantHolderIds: ['fund_lattice'],
        boardSeatsGranted: 1,
        closedQuarter: 0,
        status: 'closed',
      },
    ],

    marketInstruments: INSTRUMENTS.map((entry) => ({ ...entry })),
    quotes: QUOTE_SEEDS.map(buildQuote),
    quoteHistoryQuarters: 24,
    valuationAnchors: COMPANY_SEEDS.map((seed) => {
      const anchor = anchors[seed.id];
      const cap = CAP_SEEDS.find((entry) => entry.companyId === seed.id);
      const issued = cap?.issued ?? 0;
      return {
        companyId: seed.id,
        quarter: 0,
        method: anchor?.method ?? 'revenue_multiple',
        inputs: {
          forwardRevenue: seed.financials.revenue * 4,
          grossMargin: seed.financials.revenue > 0 ? (seed.financials.revenue - seed.financials.cogs) / seed.financials.revenue : 0,
          cash: seed.financials.cash,
          debt: seed.financials.debt,
        },
        anchorValueUsd: anchor?.value ?? 0,
        perShareValueUsd: issued > 0 ? (anchor?.value ?? 0) / issued : null,
        confidence: seed.isPublic ? 0.62 : 0.41,
      };
    }),
    beliefs: [
      {
        id: 'blf_nexus_model_schedule',
        subjectId: DEMO_COMPANIES.nexus,
        subjectKind: 'company',
        topic: 'model_delay',
        probability: 0.39,
        priorProbability: 0.34,
        lastUpdatedQuarter: 0,
        evidenceDisclosureIds: ['dsc_nexus_guidance_q1'],
      },
      {
        id: 'blf_vectorworks_bridge',
        subjectId: DEMO_COMPANIES.vectorworks,
        subjectKind: 'company',
        topic: 'fundraise_needed',
        probability: 0.72,
        priorProbability: 0.61,
        lastUpdatedQuarter: 0,
        evidenceDisclosureIds: ['dsc_vectorworks_analyst_note'],
      },
      {
        id: 'blf_aurora_export_controls',
        subjectId: DEMO_COMPANIES.aurora,
        subjectKind: 'company',
        topic: 'regulatory_action',
        probability: 0.47,
        priorProbability: 0.44,
        lastUpdatedQuarter: 0,
        evidenceDisclosureIds: [],
      },
    ],
    disclosures: [
      {
        id: 'dsc_nexus_guidance_q1',
        companyId: DEMO_COMPANIES.nexus,
        quarter: 0,
        kind: 'guidance',
        headline: 'Nexus Intelligence guides revenue for quarter 1',
        body: 'Nexus told investors to expect $2.1bn of revenue in quarter 1, and reiterated that its next frontier model remains on schedule.',
        metrics: { revenue: 2.1 * BN, targetQuarter: 1 },
        credibility: 0.71,
        sourceCharacterId: DEMO_CHARACTERS.maya,
        // INTERNAL ONLY: the secret programme says the schedule will not hold.
        isTruthful: false,
        beliefTopic: 'revenue_beat',
      },
      {
        id: 'dsc_vectorworks_analyst_note',
        companyId: DEMO_COMPANIES.vectorworks,
        quarter: 0,
        kind: 'analyst_note',
        headline: 'VectorWorks burn leaves under seven quarters of runway',
        body: 'At $104m of quarterly burn against $640m of cash and deteriorating net retention, VectorWorks raises a dilutive bridge within three quarters on any reasonable projection.',
        metrics: { runwayQuarters: 6.2, netRevenueRetention: 0.88 },
        credibility: 0.58,
        sourceCharacterId: DEMO_CHARACTERS.rowan,
        isTruthful: true,
        beliefTopic: 'fundraise_needed',
      },
    ],

    techGraph: {
      version: 1,
      sessionId,
      nodes: NODE_SEEDS.map(buildNode),
      edges: EDGE_SEEDS.map((edge) => ({ from: edge.from, to: edge.to, kind: edge.kind, strength: edge.strength })),
      updatedQuarter: 0,
    },
    researchProjects: RESEARCH_PROJECTS.map((project) => ({ ...project })),

    characters: CHARACTER_SEEDS.map(buildCharacter),
    relationships: RELATIONSHIPS.map((relationship) => ({ ...relationship })),
    memories: MEMORIES.map((memory) => ({ ...memory })),
    accessOverrides: BOARDS.flatMap((board) =>
      board.directors
        .filter((seat) => seat.characterId !== board.chairCharacterId)
        .flatMap((seat) => {
          const chair = board.chairCharacterId;
          if (chair === null) return [];
          return [
            {
              id: makeId('ovr', board.id, chair, seat.characterId),
              kind: 'shared_board' as const,
              fromId: chair,
              toId: seat.characterId,
              grantedQuarter: 0,
              expiresQuarter: null,
              isPermanent: true,
              grantedByCharacterId: null,
              reason: 'They sit on the same board.',
            },
            {
              id: makeId('ovr', board.id, seat.characterId, chair),
              kind: 'shared_board' as const,
              fromId: seat.characterId,
              toId: chair,
              grantedQuarter: 0,
              expiresQuarter: null,
              isPermanent: true,
              grantedByCharacterId: null,
              reason: 'They sit on the same board.',
            },
          ];
        }),
    ),
    conversations: [],

    boards: BOARDS.map((board) => ({ ...board, directors: board.directors.map((seat) => ({ ...seat })) })),
    boardProposals: [],
    commitments: [],

    agencies: [
      {
        id: 'agy_defence',
        name: 'United Federation Department of Defence',
        shortName: 'UFDOD',
        jurisdiction: 'defence',
        mission: 'Sovereign capability, secure autonomy and assured access to frontier systems.',
        budgetQuarterlyUsd: 15.25 * BN,
        priorities: ['national_security', 'domestic_industry', 'data_sovereignty'],
        contactCharacterIds: [DEMO_CHARACTERS.alan],
        clearanceAuthority: true,
      },
      {
        id: 'agy_modernisation',
        name: 'Bureau of Digital Modernisation',
        shortName: 'UFBDM',
        jurisdiction: 'federal_civil',
        mission: 'Replace legacy citizen-service systems without losing public trust.',
        budgetQuarterlyUsd: 2.35 * BN,
        priorities: ['cost_efficiency', 'workforce_modernisation', 'vendor_diversity'],
        contactCharacterIds: [],
        clearanceAuthority: false,
      },
      {
        id: 'agy_oversight',
        name: 'Federal AI Oversight Bureau',
        shortName: 'FAIOB',
        jurisdiction: 'federal_civil',
        mission: 'Supervise frontier model deployment, incident reporting and concentration risk.',
        budgetQuarterlyUsd: 60 * M,
        priorities: ['responsible_ai', 'vendor_diversity'],
        contactCharacterIds: [DEMO_CHARACTERS.alan],
        clearanceAuthority: false,
      },
    ],
    procurementOpportunities: OPPORTUNITIES.map((opportunity) => ({ ...opportunity })),
    governmentBids: [],
    governmentContracts: [],
    contractorReputations: [
      reputationRow(DEMO_COMPANIES.nexus, 58, 0.72, 0.19, 2, 1),
      reputationRow(DEMO_COMPANIES.orbit, 81, 0.94, 0.04, 0, 4),
      reputationRow(DEMO_COMPANIES.helix, 74, 0.89, 0.07, 1, 3),
    ],

    socialAccounts: [
      account('soc_maya_fastfeed', 'fast_feed', '@maya_chen', DEMO_CHARACTERS.maya, null, 1_900_000, 0.72),
      account('soc_kenji_forum', 'technical_forum', '@kwatanabe', DEMO_CHARACTERS.kenji, null, 260_000, 0.81),
      account('soc_ines_fastfeed', 'fast_feed', '@ines_duarte', DEMO_CHARACTERS.ines, null, 640_000, 0.88),
      account('soc_rowan_finance', 'finance', '@rowanellis', DEMO_CHARACTERS.rowan, null, 480_000, 0.63),
      account('soc_player_fastfeed', 'fast_feed', '@avery_sinclair', DEMO_CHARACTERS.player, null, 4_200, 0.34),
      account('soc_player_corp', 'professional', '@playerventures', null, DEMO_COMPANIES.player, 1_100, 0.3),
      account('soc_nexus_corp', 'professional', '@nexusintelligence', null, DEMO_COMPANIES.nexus, 820_000, 0.66),
    ],
    socialPosts: [],
    mediaStories: [],

    deals: [],

    players: [
      {
        playerId: DEMO_PLAYER_ID,
        characterId: DEMO_CHARACTERS.player,
        companyId: DEMO_COMPANIES.player,
        isHuman: true,
        displayName: 'Avery Sinclair',
        joinedQuarter: 0,
        autoExecuteRoutine: false,
        hasSubmittedThisQuarter: false,
        isActive: true,
      },
    ],
    pendingActions: [],

    leaderboards: [],
    objectives: [
      {
        id: 'obj_player_profitability',
        playerId: DEMO_PLAYER_ID,
        label: 'Reach quarterly operating profit',
        description: 'Get Player Ventures to a positive operating income in any quarter, without selling the company to do it.',
        metric: 'operating_income',
        targetValue: 1,
        currentValue: -640_000,
        progress: 0,
        completedQuarter: null,
        weight: 0.4,
      },
      {
        id: 'obj_player_first_contract',
        playerId: DEMO_PLAYER_ID,
        label: 'Win public work',
        description: 'Hold at least $50m of awarded government contract value.',
        metric: 'government_contract_value',
        targetValue: 50 * M,
        currentValue: 0,
        progress: 0,
        completedQuarter: null,
        weight: 0.3,
      },
      {
        id: 'obj_player_network',
        playerId: DEMO_PLAYER_ID,
        label: 'Become someone worth calling',
        description: 'Reach a connection level of 60, which is roughly where a sovereign fund returns your messages.',
        metric: 'connection_level',
        targetValue: 60,
        currentValue: 24,
        progress: 0.4,
        completedQuarter: null,
        weight: 0.3,
      },
    ],
  };
}

/* -------------------------------------------------------------------------- */
/*  Relationships and memory                                                   */
/* -------------------------------------------------------------------------- */

interface RelationshipRow {
  fromId: string;
  toId: string;
  trust: number;
  respect: number;
  hostility: number;
  dependence: number;
  lastInteractionQuarter: number | null;
  interactionCount: number;
}

const RELATIONSHIPS: readonly RelationshipRow[] = [
  { fromId: DEMO_CHARACTERS.maya, toId: DEMO_CHARACTERS.eleanor, trust: 46, respect: 78, hostility: 34, dependence: 62, lastInteractionQuarter: 0, interactionCount: 44 },
  { fromId: DEMO_CHARACTERS.eleanor, toId: DEMO_CHARACTERS.maya, trust: 58, respect: 84, hostility: 21, dependence: 41, lastInteractionQuarter: 0, interactionCount: 44 },
  { fromId: DEMO_CHARACTERS.maya, toId: DEMO_CHARACTERS.sarah, trust: 39, respect: 71, hostility: 44, dependence: 28, lastInteractionQuarter: 0, interactionCount: 21 },
  { fromId: DEMO_CHARACTERS.sarah, toId: DEMO_CHARACTERS.maya, trust: 44, respect: 66, hostility: 31, dependence: 12, lastInteractionQuarter: 0, interactionCount: 21 },
  { fromId: DEMO_CHARACTERS.maya, toId: DEMO_CHARACTERS.rebecca, trust: 31, respect: 82, hostility: 52, dependence: 88, lastInteractionQuarter: 0, interactionCount: 18 },
  { fromId: DEMO_CHARACTERS.rebecca, toId: DEMO_CHARACTERS.maya, trust: 38, respect: 64, hostility: 41, dependence: 22, lastInteractionQuarter: 0, interactionCount: 18 },
  { fromId: DEMO_CHARACTERS.priya, toId: DEMO_CHARACTERS.maya, trust: 52, respect: 74, hostility: 18, dependence: 34, lastInteractionQuarter: 0, interactionCount: 26 },
  { fromId: DEMO_CHARACTERS.tomas, toId: DEMO_CHARACTERS.marcus, trust: 22, respect: 41, hostility: 61, dependence: 79, lastInteractionQuarter: 0, interactionCount: 14 },
  { fromId: DEMO_CHARACTERS.marcus, toId: DEMO_CHARACTERS.tomas, trust: 28, respect: 33, hostility: 44, dependence: 8, lastInteractionQuarter: 0, interactionCount: 14 },
  { fromId: DEMO_CHARACTERS.kenji, toId: DEMO_CHARACTERS.idris, trust: 71, respect: 88, hostility: 6, dependence: 21, lastInteractionQuarter: 0, interactionCount: 32 },
  { fromId: DEMO_CHARACTERS.eleanor, toId: DEMO_CHARACTERS.nadia, trust: 64, respect: 81, hostility: 9, dependence: 58, lastInteractionQuarter: 0, interactionCount: 12 },
  { fromId: DEMO_CHARACTERS.nadia, toId: DEMO_CHARACTERS.eleanor, trust: 61, respect: 68, hostility: 11, dependence: 14, lastInteractionQuarter: 0, interactionCount: 12 },
  // The player's own edges: an investor who backed them, a rival who has not
  // yet noticed them, and an intermediary worth cultivating.
  { fromId: DEMO_CHARACTERS.player, toId: DEMO_CHARACTERS.eleanor, trust: 58, respect: 74, hostility: 4, dependence: 71, lastInteractionQuarter: 0, interactionCount: 9 },
  { fromId: DEMO_CHARACTERS.eleanor, toId: DEMO_CHARACTERS.player, trust: 51, respect: 46, hostility: 3, dependence: 6, lastInteractionQuarter: 0, interactionCount: 9 },
  { fromId: DEMO_CHARACTERS.player, toId: DEMO_CHARACTERS.maya, trust: 18, respect: 81, hostility: 12, dependence: 22, lastInteractionQuarter: null, interactionCount: 0 },
  { fromId: DEMO_CHARACTERS.player, toId: DEMO_CHARACTERS.grace, trust: 44, respect: 62, hostility: 2, dependence: 31, lastInteractionQuarter: 0, interactionCount: 4 },
  { fromId: DEMO_CHARACTERS.grace, toId: DEMO_CHARACTERS.player, trust: 38, respect: 34, hostility: 5, dependence: 2, lastInteractionQuarter: 0, interactionCount: 4 },
];

interface MemoryRow {
  id: string;
  ownerCharacterId: string;
  aboutId: string;
  quarter: number;
  kind: 'betrayal' | 'favour' | 'poach' | 'negotiation' | 'board_vote' | 'media_moment';
  summary: string;
  sentiment: number;
  decayRate: number;
  strength: number;
}

const MEMORIES: readonly MemoryRow[] = [
  {
    id: 'mem_eleanor_series_b_terms',
    ownerCharacterId: DEMO_CHARACTERS.maya,
    aboutId: DEMO_CHARACTERS.eleanor,
    quarter: 0,
    kind: 'negotiation',
    summary: 'Eleanor took a full point more of the Series B than we had shaken hands on, and has never once let me forget the terms.',
    sentiment: -0.42,
    decayRate: 0.02,
    strength: 0.81,
  },
  {
    id: 'mem_tomas_poach',
    ownerCharacterId: DEMO_CHARACTERS.tomas,
    aboutId: DEMO_CHARACTERS.maya,
    quarter: 0,
    kind: 'poach',
    summary: 'Nexus took two of my best retrieval researchers during the worst quarter we have had.',
    sentiment: -0.78,
    decayRate: 0.01,
    strength: 0.92,
  },
  {
    id: 'mem_player_backed',
    ownerCharacterId: DEMO_CHARACTERS.player,
    aboutId: DEMO_CHARACTERS.eleanor,
    quarter: 0,
    kind: 'favour',
    summary: 'Eleanor wrote the first cheque when nobody else would take the meeting.',
    sentiment: 0.74,
    decayRate: 0.06,
    strength: 0.88,
  },
  {
    id: 'mem_kenji_idris_defence',
    ownerCharacterId: DEMO_CHARACTERS.kenji,
    aboutId: DEMO_CHARACTERS.idris,
    quarter: 0,
    kind: 'favour',
    summary: 'Idris defended the agent-economies work in public when the whole field was laughing at it.',
    sentiment: 0.81,
    decayRate: 0.04,
    strength: 0.86,
  },
];

/* -------------------------------------------------------------------------- */
/*  Small builders                                                             */
/* -------------------------------------------------------------------------- */

function reputationRow(companyId: string, score: number, onTime: number, overrun: number, incidents: number, won: number) {
  return {
    companyId,
    agencyId: null,
    pastPerformanceScore: score,
    onTimeDeliveryPct: onTime,
    costOverrunPct: overrun,
    securityIncidents: incidents,
    contractsWon: won,
    contractsLost: Math.max(0, 6 - won),
    terminationsForDefault: 0,
    lastUpdatedQuarter: 0,
  };
}

function account(
  id: string,
  network: SocialAccount['network'],
  handle: string,
  ownerCharacterId: string | null,
  ownerCompanyId: string | null,
  followers: number,
  credibility: number,
): SocialAccount {
  const mix: Record<string, number> =
    network === 'technical_forum'
      ? { developers: 0.62, talent: 0.18, media: 0.1, investors: 0.1 }
      : network === 'finance'
        ? { investors: 0.68, media: 0.18, enterprise: 0.14 }
        : network === 'professional'
          ? { enterprise: 0.52, talent: 0.24, investors: 0.14, media: 0.1 }
          : { consumers: 0.34, developers: 0.22, media: 0.22, investors: 0.12, talent: 0.1 };
  return {
    id,
    network,
    handle,
    ownerCharacterId,
    ownerCompanyId,
    followers,
    credibility,
    verified: followers > 10_000,
    audienceMix: mix,
    isActive: true,
  };
}
