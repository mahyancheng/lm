/**
 * Test harness for the world-economy and market subsystems.
 *
 * Deliberately self-contained: it implements its own `SeededRng` and its own
 * `ResolverContext` rather than importing them from a sibling module, so these
 * suites run against `@frontier/contracts` and the economy/market sources alone.
 *
 * The fixture mirrors `supabase/seed.sql`: seed 424242, 2027 Q1, the six seeded
 * companies (Nexus Intelligence, Orbit Dynamics, Helix Systems, VectorWorks AI,
 * Aurora Compute, Meridian Data), eight sectors and eight market instruments.
 *
 * Not a test file itself — the leading underscore keeps it out of the suite glob.
 */

import type {
  Company,
  MarketInstrument,
  ResolutionLineDraft,
  SectorKey,
  ResolverContext,
  SeededRng,
  SessionState,
  SessionStateInput,
  SimEventDraft,
} from '@frontier/contracts';
import { SessionStateSchema } from '@frontier/contracts';

/* -------------------------------------------------------------------------- */
/*  Deterministic RNG                                                          */
/* -------------------------------------------------------------------------- */

function hashString(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

class TestRng implements SeededRng {
  private state: number;

  constructor(private readonly label: string) {
    this.state = hashString(label) || 1;
  }

  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  int(min: number, max: number): number {
    if (max <= min) return min;
    return Math.min(max, min + Math.floor(this.next() * (max - min + 1)));
  }

  pick<T>(arr: readonly T[]): T {
    const first = arr[0];
    if (first === undefined) throw new Error('pick from an empty array');
    return arr[this.int(0, arr.length - 1)] ?? first;
  }

  shuffle<T>(arr: readonly T[]): T[] {
    const out = [...arr];
    for (let i = out.length - 1; i > 0; i -= 1) {
      const j = this.int(0, i);
      const a = out[i];
      const b = out[j];
      if (a === undefined || b === undefined) continue;
      out[i] = b;
      out[j] = a;
    }
    return out;
  }

  fork(label: string): SeededRng {
    return new TestRng(`${this.label}#${label}`);
  }
}

export const makeRng = (seed: string): SeededRng => new TestRng(seed);

/* -------------------------------------------------------------------------- */
/*  Resolver context                                                           */
/* -------------------------------------------------------------------------- */

export interface HarnessContext {
  readonly ctx: ResolverContext;
  readonly events: (SimEventDraft & { eventId: string })[];
  readonly lines: ResolutionLineDraft[];
}

export function makeContext(quarter: number, seed: string): HarnessContext {
  const events: (SimEventDraft & { eventId: string })[] = [];
  const lines: ResolutionLineDraft[] = [];
  const ctx: ResolverContext = {
    quarter,
    rng: makeRng(seed),
    emit(draft: SimEventDraft): string {
      const eventId = `evt_${events.length}`;
      events.push({ ...draft, eventId });
      return eventId;
    },
    log(line: ResolutionLineDraft): void {
      lines.push(line);
    },
  };
  return { ctx, events, lines };
}

/* -------------------------------------------------------------------------- */
/*  Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

export const SESSION_ID = 'sess_demo_world';
export const SEED = '424242';
export const START_YEAR = 2027;
export const DEMO_QUARTER = 1;

type CompanyInput = SessionStateInput['companies'] extends (infer T)[] | undefined ? T : never;

export interface CompanySpec {
  readonly id: string;
  readonly name: string;
  readonly ticker: string;
  readonly archetype: Company['archetype'];
  readonly sectorId: string;
  readonly revenueQuarterly: number;
  readonly cogs: number;
  readonly cash: number;
  readonly ppe: number;
  readonly rdSpend: number;
  readonly isPublic: boolean;
}

/** A complete company, so a fixture only states what a test cares about. */
export function makeCompany(spec: CompanySpec): CompanyInput {
  const payroll = spec.revenueQuarterly * 0.3 + 5_000_000;
  const marketing = spec.revenueQuarterly * 0.08;
  const equity = spec.cash + spec.ppe;
  return {
    id: spec.id,
    name: spec.name,
    ticker: spec.ticker,
    archetype: spec.archetype,
    tier: 'major',
    isPublic: spec.isPublic,
    controllerPlayerId: null,
    sectorId: spec.sectorId,
    foundedQuarter: 0,
    headquartersCity: 'Bay Federal District',
    isActive: true,
    products: [
      {
        id: `prd_${spec.id}`,
        name: `${spec.name} Platform`,
        segment: 'enterprise',
        pricePerSeat: 4200,
        activeCustomers: 12_000,
        churnQuarterly: 0.05,
        growthQuarterly: 0.09,
        grossMarginPct: 0.62,
        computeIntensity: 0.5,
        qualityScore: 0.6,
        launchedQuarter: 0,
        isActive: true,
      },
    ],
    employees: {
      engineers: 900,
      researchers: 240,
      sales: 300,
      ops: 180,
      execs: 20,
      avgComp: 310_000,
      morale: 68,
      attrition: 0.06,
      openRoles: 40,
    },
    compute: {
      ownedAccelerators: 40_000,
      reservedAccelerators: 60_000,
      reservationExpiryQuarter: 9,
      cloudSpendQuarterly: 90_000_000,
      computeUtilisation: 0.78,
      trainingAllocation: 0.55,
    },
    offices: [],
    financials: {
      revenueQuarterly: spec.revenueQuarterly,
      cogs: spec.cogs,
      payroll,
      marketing,
      rdSpend: spec.rdSpend,
      capex: 40_000_000,
      interestExpense: 6_000_000,
      cash: spec.cash,
      debt: 0,
      quarterlyBurn: -30_000_000,
      deferredRevenue: 0,
      backlogUsd: 0,
    },
    balanceSheet: {
      assets: { cash: spec.cash, ppe: spec.ppe, goodwill: 0, investments: 0, receivables: 0 },
      liabilities: { debt: 0, payables: 0, deferredRevenue: 0 },
      equity,
    },
    posture: 'balanced',
    riskTolerance: 0.6,
    techCapabilities: { reasoning: 0.7, efficiency: 0.55, infrastructure: 0.6 },
    governmentPastPerformance: 62,
    reputation: { public: 60, developer: 58, enterprise: 64, government: 55, investor: 61 },
    boardId: null,
    primarySecurityId: `sec_${spec.id}`,
    instrumentId: `ins_${spec.id}`,
    ceoCharacterId: null,
    parentCompanyId: null,
  };
}

/** The six seeded companies, in seed order. */
export const DEMO_COMPANY_SPECS: readonly CompanySpec[] = [
  {
    id: 'cmp_nexus',
    name: 'Nexus Intelligence',
    ticker: 'NXS',
    archetype: 'frontier_lab',
    sectorId: 'frontier_models',
    revenueQuarterly: 1_400_000_000,
    cogs: 520_000_000,
    cash: 8_100_000_000,
    ppe: 6_400_000_000,
    rdSpend: 900_000_000,
    isPublic: true,
  },
  {
    id: 'cmp_orbit',
    name: 'Orbit Dynamics',
    ticker: 'ORB',
    archetype: 'enterprise_ai',
    sectorId: 'enterprise_software',
    revenueQuarterly: 900_000_000,
    cogs: 320_000_000,
    cash: 2_400_000_000,
    ppe: 700_000_000,
    rdSpend: 210_000_000,
    isPublic: true,
  },
  {
    id: 'cmp_helix',
    name: 'Helix Systems',
    ticker: 'HLX',
    archetype: 'infrastructure',
    sectorId: 'cloud_infrastructure',
    revenueQuarterly: 1_100_000_000,
    cogs: 640_000_000,
    cash: 1_200_000_000,
    ppe: 14_000_000_000,
    rdSpend: 90_000_000,
    isPublic: true,
  },
  {
    id: 'cmp_vector',
    name: 'VectorWorks AI',
    ticker: 'VWA',
    archetype: 'enterprise_ai',
    sectorId: 'enterprise_software',
    revenueQuarterly: 180_000_000,
    cogs: 96_000_000,
    cash: 640_000_000,
    ppe: 120_000_000,
    rdSpend: 130_000_000,
    isPublic: true,
  },
  {
    id: 'cmp_aurora',
    name: 'Aurora Compute',
    ticker: 'ARC',
    archetype: 'chip_maker',
    sectorId: 'semiconductors',
    revenueQuarterly: 2_600_000_000,
    cogs: 1_100_000_000,
    cash: 3_900_000_000,
    ppe: 9_800_000_000,
    rdSpend: 420_000_000,
    isPublic: true,
  },
  {
    id: 'cmp_meridian',
    name: 'Meridian Data',
    ticker: 'MRD',
    archetype: 'data',
    sectorId: 'data_services',
    revenueQuarterly: 140_000_000,
    cogs: 52_000_000,
    cash: 380_000_000,
    ppe: 90_000_000,
    rdSpend: 60_000_000,
    isPublic: true,
  },
];

const SHARES_OUTSTANDING: Record<string, number> = {
  cmp_nexus: 620_000_000,
  cmp_orbit: 540_000_000,
  cmp_helix: 410_000_000,
  cmp_vector: 300_000_000,
  cmp_aurora: 780_000_000,
  cmp_meridian: 260_000_000,
};

const BETA: Record<string, number> = {
  cmp_nexus: 1.34,
  cmp_orbit: 1.05,
  cmp_helix: 0.92,
  cmp_vector: 1.42,
  cmp_aurora: 1.51,
  cmp_meridian: 1.18,
};

const SEED_PRICE: Record<string, number> = {
  cmp_nexus: 83.2,
  cmp_orbit: 41.72,
  cmp_helix: 57.35,
  cmp_vector: 18.91,
  cmp_aurora: 129.4,
  cmp_meridian: 26.15,
};

function makeInstruments(): MarketInstrument[] {
  const equities: MarketInstrument[] = DEMO_COMPANY_SPECS.map((spec) => ({
    id: `ins_${spec.id}`,
    kind: 'in_world_equity',
    symbol: spec.ticker,
    name: spec.name,
    companyId: spec.id,
    securityId: `sec_${spec.id}`,
    sectorId: spec.sectorId,
    isReference: false,
    currency: 'USD',
    sharesOutstanding: SHARES_OUTSTANDING[spec.id] ?? 100_000_000,
    listedQuarter: 0,
    beta: BETA[spec.id] ?? 1,
  }));
  return [
    ...equities,
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
    {
      id: 'ins_reference_ndx',
      kind: 'reference_index',
      symbol: 'NDX',
      name: 'Reference technology index',
      companyId: null,
      securityId: null,
      sectorId: null,
      isReference: true,
      currency: 'USD',
      sharesOutstanding: null,
      listedQuarter: null,
      beta: 1,
    },
  ];
}

const SECTOR_DEFAULTS: readonly { id: SectorKey; sentiment: number; multiple: number; demand: number; volatility: number }[] = [
  { id: 'semiconductors', sentiment: 0.24, multiple: 1.35, demand: 0.72, volatility: 0.38 },
  { id: 'cloud_infrastructure', sentiment: 0.12, multiple: 1.18, demand: 0.66, volatility: 0.26 },
  { id: 'frontier_models', sentiment: 0.31, multiple: 1.62, demand: 0.61, volatility: 0.44 },
  { id: 'enterprise_software', sentiment: 0.04, multiple: 1.05, demand: 0.58, volatility: 0.22 },
  { id: 'consumer_ai', sentiment: -0.08, multiple: 0.92, demand: 0.49, volatility: 0.31 },
  { id: 'data_services', sentiment: 0.06, multiple: 1.1, demand: 0.54, volatility: 0.24 },
  { id: 'defence_tech', sentiment: 0.18, multiple: 1.22, demand: 0.63, volatility: 0.27 },
  { id: 'energy_infrastructure', sentiment: 0.09, multiple: 1.04, demand: 0.6, volatility: 0.19 },
];

/** The world as the demo scenario starts it. */
export function demoWorld(): SessionStateInput['world'] {
  return {
    macro: {
      gdpGrowth: 0.024,
      inflation: 0.031,
      policyRate: 0.0425,
      unemployment: 0.042,
      creditSpreads: 0.017,
      fxVolatility: 0.28,
      consumerDemand: 0.55,
    },
    capitalMarkets: {
      riskAppetite: 0.52,
      ipoWindow: 0.48,
      ventureLiquidity: 0.61,
      sectorMultiples: 1.22,
      volatility: 0.31,
      debtAvailability: 0.64,
    },
    compute: {
      acceleratorSupply: 0.61,
      cloudCapacity: 0.58,
      spotPrice: 1.24,
      reservedPrice: 1.06,
      fabCapacity: 0.52,
      energyDemand: 0.49,
    },
    energy: { electricityPrice: 1.12, datacentreAccess: 0.47, renewableCapacity: 0.41, gridConstraint: 0.44 },
    aiFrontier: {
      frontierCapability: 0.58,
      inferenceCost: 0.86,
      trainingEfficiency: 0.44,
      openSourceGap: 0.37,
      benchmarkSaturation: 0.62,
    },
    talent: { researcherSupply: 0.38, engineerSupply: 0.52, salaryPressure: 1.28, immigrationAccess: 0.51 },
    dataDomain: { dataAvailability: 0.49, licensingCost: 1.31, privacyRestriction: 0.42, syntheticDataMaturity: 0.36 },
    society: { aiTrust: 0.46, automationAnxiety: 0.57, consumerSentiment: 0.51, developerSentiment: 0.62 },
    regulation: {
      modelRules: 0.34,
      privacy: 0.41,
      antitrust: 0.29,
      copyright: 0.38,
      safetyObligations: 0.36,
      exportControls: 0.44,
    },
    government: { procurementBudget: 0.55, defenceUrgency: 0.48, digitalModernisation: 0.52, grantFunding: 0.44 },
    geopolitics: { tradeFriction: 0.39, conflictRisk: 0.31, sanctions: 0.28, techCompetition: 0.47 },
    media: { attentionLevel: 0.58, institutionalTrust: 0.44, controversyIntensity: 0.36, dominantNarrative: 'ai_optimism' },
  };
}

/** The demo session state, parsed through the schema so defaults are applied. */
export function demoSessionInput(): SessionStateInput {
  const sectors: SessionStateInput['sectors'] = {};
  for (const sector of SECTOR_DEFAULTS) {
    sectors[sector.id] = {
      sectorId: sector.id,
      sentiment: sector.sentiment,
      multiple: sector.multiple,
      demand: sector.demand,
      volatility: sector.volatility,
    };
  }

  return {
    sessionId: SESSION_ID,
    seed: SEED,
    quarter: DEMO_QUARTER,
    startYear: START_YEAR,
    status: 'active',
    config: {
      playerCount: 1,
      difficulty: 'standard',
      majorRivalCount: 6,
      significantCompanyCount: 24,
      backgroundCompanyCount: 180,
      scenarioId: 'demo_world_2027',
      startYear: START_YEAR,
      quarterLimit: null,
      enableReferenceMarket: false,
      allowPlayerInnovation: true,
      autoExecuteRoutineDefault: false,
    },
    world: demoWorld(),
    sectors,
    eventHazards: {},
    companies: DEMO_COMPANY_SPECS.map(makeCompany),
    companyMetrics: DEMO_COMPANY_SPECS.map((spec) => ({
      companyId: spec.id,
      quarter: DEMO_QUARTER,
      revenueTtm: spec.revenueQuarterly * 4,
      revenueGrowthYoY: 0.22,
      grossMarginPct: (spec.revenueQuarterly - spec.cogs) / spec.revenueQuarterly,
      operatingMarginPct: 0.08,
      headcount: 1640,
      runwayQuarters: 14,
      enterpriseValueUsd: (SEED_PRICE[spec.id] ?? 50) * (SHARES_OUTSTANDING[spec.id] ?? 1e8),
      marketCapUsd: (SEED_PRICE[spec.id] ?? 50) * (SHARES_OUTSTANDING[spec.id] ?? 1e8),
      computeCostShare: 0.41,
      governmentRevenueShare: 0.12,
    })),
    securities: DEMO_COMPANY_SPECS.map((spec) => ({
      id: `sec_${spec.id}`,
      companyId: spec.id,
      shareClassId: `shc_${spec.id}`,
      symbol: spec.ticker,
      isTradable: true,
      instrumentId: `ins_${spec.id}`,
      parValueUsd: 0.001,
    })),
    capTables: DEMO_COMPANY_SPECS.map((spec) => {
      const issued = SHARES_OUTSTANDING[spec.id] ?? 100_000_000;
      return {
        companyId: spec.id,
        shareClasses: [
          {
            id: `shc_${spec.id}`,
            companyId: spec.id,
            kind: 'common' as const,
            label: 'Common',
            votesPerShare: 1,
            liquidationPreferenceMultiple: 0,
            participating: false,
            authorisedShares: issued * 2,
            issuedShares: issued,
            createdQuarter: 0,
          },
        ],
        holdings: [
          {
            id: `hld_${spec.id}_float`,
            holderId: 'public_float',
            holderKind: 'public_float' as const,
            securityId: `sec_${spec.id}`,
            shares: issued,
            costBasisUsd: 0,
            acquiredQuarter: 0,
            lockupUntilQuarter: null,
            isDisclosed: true,
          },
        ],
        totalIssuedByClass: { [`shc_${spec.id}`]: issued },
        fullyDilutedShares: issued,
        optionPoolShares: 0,
        lastUpdatedQuarter: DEMO_QUARTER,
      };
    }),
    marketInstruments: makeInstruments(),
    quotes: DEMO_COMPANY_SPECS.map((spec) => ({
      instrumentId: `ins_${spec.id}`,
      quarter: DEMO_QUARTER - 1,
      price: SEED_PRICE[spec.id] ?? 50,
      return: 0.01,
      volume: 20_000_000,
      marketCapUsd: (SEED_PRICE[spec.id] ?? 50) * (SHARES_OUTSTANDING[spec.id] ?? 1e8),
    })),
    techGraph: { version: 1, sessionId: SESSION_ID, nodes: [], edges: [], updatedQuarter: DEMO_QUARTER },
    characters: [
      {
        id: 'chr_maya_chen',
        name: 'Maya Chen',
        role: 'founder_ceo',
        companyId: 'cmp_nexus',
        title: 'CEO — Nexus Intelligence',
        stableTraits: {
          riskTolerance: 89,
          technicalOrientation: 96,
          financialConservatism: 27,
          aggressiveness: 83,
          statusSensitivity: 66,
        },
        beliefs: [],
        connectionLevel: 88,
        isPlayer: false,
        personalWealthUsd: 3_400_000_000,
        boardSeatCount: 2,
        publicFollowing: 1_900_000,
        isActive: true,
      },
    ],
  };
}

/** Parse a fixture into canonical state, applying every schema default. */
export function makeState(overrides: Partial<SessionStateInput> = {}): SessionState {
  return SessionStateSchema.parse({ ...demoSessionInput(), ...overrides });
}

/** A deep structural clone, for "same input twice" determinism assertions. */
export function cloneState(state: SessionState): SessionState {
  return JSON.parse(JSON.stringify(state)) as SessionState;
}
