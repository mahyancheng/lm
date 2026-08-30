/**
 * @frontier/simulation — company subsystem tests.
 *
 * The fixture mirrors `supabase/seed.sql`: session seed 424242, start year 2027,
 * quarter 1, and the six seed companies — Nexus Intelligence (NXS), Orbit
 * Dynamics (ORB), Helix Systems (HLX), VectorWorks AI (VWA), Aurora Compute
 * (ARC) and Meridian Data (MRD) — with Maya Chen as chief executive of Nexus and
 * her seeded traits intact. Financial magnitudes are the same order as the seed
 * rather than copied from it row for row.
 *
 * The RNG here is a local deterministic stream, not `@frontier/shared`: these
 * tests must exercise the company subsystems and nothing else.
 */

import { describe, expect, it } from 'vitest';
import type {
  ResolutionLineDraft,
  SectorKey,
  ResolverContext,
  SeededRng,
  SessionState,
  SessionStateInput,
  SimEventDraft,
  SubmittedAction,
} from '@frontier/contracts';
import { SessionStateSchema, balanceSheetReconciles } from '@frontier/contracts';
import {
  applyNpcDefaults,
  CAPACITY_BASE_LOSS_CEILING,
  CHRONIC_DISTRESS_QUARTERS,
  poachProbability,
  priceFactor,
  recomputeMetrics,
  RESERVATION_RENEWAL_QUARTERS,
  resolveFinancials,
  resolveHiring,
  resolveProducts,
  SEGMENT_PRICE_ELASTICITY,
} from '../src/companies/index';
import { createDefaultEngine } from '../src/engine';
import { createDemoSession } from '../src/scenario/demo';

/* -------------------------------------------------------------------------- */
/*  Deterministic test RNG                                                     */
/* -------------------------------------------------------------------------- */

function hashSeed(seed: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

function createRng(seed: string): SeededRng {
  let state = hashSeed(seed) || 1;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const rng: SeededRng = {
    next,
    range: (min, max) => min + next() * (max - min),
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    pick: (arr) => {
      if (arr.length === 0) throw new Error('pick from empty array');
      const item = arr[Math.floor(next() * arr.length)];
      if (item === undefined) throw new Error('pick out of range');
      return item;
    },
    shuffle: (arr) => {
      const copy = [...arr];
      for (let i = copy.length - 1; i > 0; i -= 1) {
        const j = Math.floor(next() * (i + 1));
        const a = copy[i];
        const b = copy[j];
        if (a === undefined || b === undefined) continue;
        copy[i] = b;
        copy[j] = a;
      }
      return copy;
    },
    fork: (label) => createRng(`${seed}/${label}`),
  };
  return rng;
}

interface Harness {
  readonly ctx: ResolverContext;
  readonly events: (SimEventDraft & { eventId: string })[];
  readonly lines: ResolutionLineDraft[];
}

function harness(quarter: number, rng: SeededRng): Harness {
  const events: (SimEventDraft & { eventId: string })[] = [];
  const lines: ResolutionLineDraft[] = [];
  const ctx: ResolverContext = {
    quarter,
    rng,
    emit(draft) {
      const eventId = `evt_${quarter}_${events.length}`;
      events.push({ ...draft, eventId });
      return eventId;
    },
    log(line) {
      lines.push(line);
    },
  };
  return { ctx, events, lines };
}

/* -------------------------------------------------------------------------- */
/*  Fixture                                                                    */
/* -------------------------------------------------------------------------- */

const SESSION_ID = 'sess_frontier_demo';
const START_QUARTER = 1;

function sector(sectorId: SectorKey, sentiment: number, multiple: number, demand: number, volatility: number) {
  return { sectorId, sentiment, multiple, demand, volatility };
}

function reputation(pub: number, dev: number, ent: number, gov: number, inv: number) {
  return { public: pub, developer: dev, enterprise: ent, government: gov, investor: inv };
}

function sheet(cash: number, ppe: number, goodwill: number, investments: number, receivables: number, debt: number, payables: number, deferred: number) {
  const assets = cash + ppe + goodwill + investments + receivables;
  const liabilities = debt + payables + deferred;
  return {
    assets: { cash, ppe, goodwill, investments, receivables },
    liabilities: { debt, payables, deferredRevenue: deferred },
    equity: assets - liabilities,
  };
}

function financials(revenue: number, cash: number, debt: number, deferred: number) {
  return {
    revenueQuarterly: revenue,
    cogs: revenue * 0.35,
    payroll: revenue * 0.25,
    marketing: revenue * 0.08,
    rdSpend: revenue * 0.3,
    capex: 0,
    interestExpense: debt * 0.015,
    cash,
    debt,
    quarterlyBurn: -revenue * 0.1,
    deferredRevenue: deferred,
    backlogUsd: 0,
  };
}

const baseWorld = {
  macro: { gdpGrowth: 0.024, inflation: 0.031, policyRate: 0.0425, unemployment: 0.042, creditSpreads: 0.018, fxVolatility: 0.3, consumerDemand: 0.56 },
  capitalMarkets: { riskAppetite: 0.62, ipoWindow: 0.55, ventureLiquidity: 0.58, sectorMultiples: 1.35, volatility: 0.42, debtAvailability: 0.6 },
  compute: { acceleratorSupply: 0.48, cloudCapacity: 0.52, spotPrice: 1.24, reservedPrice: 1.05, fabCapacity: 0.46, energyDemand: 0.61 },
  energy: { electricityPrice: 1.18, datacentreAccess: 0.44, renewableCapacity: 0.38, gridConstraint: 0.57 },
  aiFrontier: { frontierCapability: 0.72, inferenceCost: 0.86, trainingEfficiency: 0.54, openSourceGap: 0.31, benchmarkSaturation: 0.68 },
  talent: { researcherSupply: 0.34, engineerSupply: 0.51, salaryPressure: 1.32, immigrationAccess: 0.47 },
  dataDomain: { dataAvailability: 0.49, licensingCost: 1.42, privacyRestriction: 0.53, syntheticDataMaturity: 0.44 },
  society: { aiTrust: 0.46, automationAnxiety: 0.62, consumerSentiment: 0.51, developerSentiment: 0.64 },
  regulation: { modelRules: 0.41, privacy: 0.55, antitrust: 0.38, copyright: 0.47, safetyObligations: 0.44, exportControls: 0.58 },
  government: { procurementBudget: 0.57, defenceUrgency: 0.63, digitalModernisation: 0.49, grantFunding: 0.41 },
  geopolitics: { tradeFriction: 0.54, conflictRisk: 0.37, sanctions: 0.44, techCompetition: 0.71 },
  media: { attentionLevel: 0.74, institutionalTrust: 0.39, controversyIntensity: 0.42, dominantNarrative: 'bubble_concern' as const },
};

function baseInput(): SessionStateInput {
  return {
    sessionId: SESSION_ID,
    seed: '424242',
    quarter: START_QUARTER,
    startYear: 2027,
    status: 'active',
    config: {
      playerCount: 1,
      difficulty: 'standard',
      majorRivalCount: 4,
      significantCompanyCount: 2,
      backgroundCompanyCount: 0,
      scenarioId: 'compute_crunch_2027',
      startYear: 2027,
      quarterLimit: null,
      enableReferenceMarket: true,
      allowPlayerInnovation: true,
      autoExecuteRoutineDefault: false,
    },
    ledgerSequence: 0,
    lastResolvedQuarter: null,
    world: baseWorld,
    sectors: {
      semiconductors: sector('semiconductors', 0.21, 1.5, 0.62, 0.44),
      cloud_infrastructure: sector('cloud_infrastructure', 0.14, 1.3, 0.66, 0.31),
      frontier_models: sector('frontier_models', 0.34, 2.1, 0.71, 0.58),
      enterprise_software: sector('enterprise_software', 0.08, 1.1, 0.58, 0.27),
      consumer_ai: sector('consumer_ai', -0.06, 0.9, 0.47, 0.49),
      data_services: sector('data_services', 0.02, 1.0, 0.51, 0.33),
      defence_tech: sector('defence_tech', 0.18, 1.2, 0.6, 0.29),
      energy_infrastructure: sector('energy_infrastructure', 0.11, 1.05, 0.55, 0.26),
    },
    eventHazards: {
      fam_compute_supply: {
        familyId: 'fam_compute_supply',
        baseHazard: 0.18,
        currentHazard: 0.18,
        cooldownRemaining: 0,
        lastFiredQuarter: null,
        pendingDeltas: [],
      },
    },
    techGraph: {
      version: 1,
      sessionId: SESSION_ID,
      updatedQuarter: START_QUARTER,
      nodes: [
        {
          id: 'tech_transformer_scaling',
          title: 'Transformer Scaling',
          summary: 'Predictable capability gains from scaling dense transformer pretraining, the assumption most of the industry is built on.',
          status: 'established',
          publicConfidence: 0.93,
          confidenceByCompany: { cmp_nexus: 0.95 },
          estimatedWindow: [2027, 2029],
          researchCostRange: [800_000_000, 4_000_000_000],
          computeIntensity: 0.92,
          talentRequirements: ['training_systems', 'infrastructure'],
          dependencies: [],
          possibleUnlocks: ['tech_sparse_expert_reasoning'],
          originalProposerId: null,
          visibility: 'public',
          achievedByCompanyId: null,
          achievedQuarter: null,
          createdQuarter: 0,
          novelty: 0.12,
          plausibility: 0.94,
        },
        {
          id: 'tech_sparse_expert_reasoning',
          title: 'Sparse Expert Reasoning',
          summary: 'Routing reasoning workloads through sparse expert mixtures to hold capability while cutting serving cost.',
          status: 'emerging',
          publicConfidence: 0.61,
          confidenceByCompany: { cmp_nexus: 0.72 },
          estimatedWindow: [2029, 2032],
          researchCostRange: [400_000_000, 1_800_000_000],
          computeIntensity: 0.74,
          talentRequirements: ['reasoning', 'efficiency'],
          dependencies: ['tech_transformer_scaling'],
          possibleUnlocks: [],
          originalProposerId: null,
          visibility: 'public',
          achievedByCompanyId: null,
          achievedQuarter: null,
          createdQuarter: 0,
          novelty: 0.44,
          plausibility: 0.78,
        },
      ],
      edges: [{ from: 'tech_transformer_scaling', to: 'tech_sparse_expert_reasoning', kind: 'depends', strength: 1 }],
    },
    companies: [
      {
        id: 'cmp_nexus',
        name: 'Nexus Intelligence',
        ticker: 'NXS',
        archetype: 'frontier_lab',
        tier: 'major',
        isPublic: true,
        controllerPlayerId: 'ply_01',
        sectorId: 'frontier_models',
        foundedQuarter: 0,
        headquartersCity: 'Bay Federal District',
        isActive: true,
        products: [
          {
            id: 'prd_nexus_api',
            name: 'Nexus Frontier API',
            segment: 'developer_api',
            pricePerSeat: 440,
            activeCustomers: 4_200_000,
            churnQuarterly: 0.07,
            growthQuarterly: 0.13,
            grossMarginPct: 0.62,
            computeIntensity: 0.9,
            qualityScore: 0.84,
            launchedQuarter: 0,
            isActive: true,
          },
        ],
        employees: { engineers: 1180, researchers: 740, sales: 310, ops: 780, execs: 60, avgComp: 430_000, morale: 66, attrition: 0.04, openRoles: 90 },
        compute: {
          ownedAccelerators: 40_000,
          reservedAccelerators: 140_000,
          reservationExpiryQuarter: 8,
          cloudSpendQuarterly: 90_000_000,
          computeUtilisation: 0.9,
          trainingAllocation: 0.45,
        },
        offices: [{ id: 'off_nexus_hq', city: 'Bay Federal District', headcountCapacity: 4000, quarterlyCostUsd: 42_000_000, openedQuarter: 0, isHeadquarters: true }],
        financials: financials(1_848_000_000, 6_000_000_000, 1_200_000_000, 200_000_000),
        balanceSheet: sheet(6_000_000_000, 9_000_000_000, 400_000_000, 600_000_000, 400_000_000, 1_200_000_000, 300_000_000, 200_000_000),
        posture: 'research_first',
        riskTolerance: 0.82,
        techCapabilities: { reasoning: 0.81, training_systems: 0.86, infrastructure: 0.68, efficiency: 0.44, evaluation: 0.57 },
        governmentPastPerformance: 54,
        reputation: reputation(58, 66, 61, 49, 71),
        boardId: 'brd_nexus',
        primarySecurityId: 'sec_nexus_common',
        instrumentId: 'ins_nexus_eq',
        ceoCharacterId: 'chr_maya_chen',
        parentCompanyId: null,
      },
      {
        id: 'cmp_orbit',
        name: 'Orbit Dynamics',
        ticker: 'ORB',
        archetype: 'enterprise_ai',
        tier: 'major',
        isPublic: true,
        controllerPlayerId: null,
        sectorId: 'enterprise_software',
        foundedQuarter: 0,
        headquartersCity: 'Lakeshore',
        isActive: true,
        products: [
          {
            id: 'prd_orbit_workbench',
            name: 'Orbit Workbench',
            segment: 'enterprise',
            pricePerSeat: 700,
            activeCustomers: 1_840_000,
            churnQuarterly: 0.04,
            growthQuarterly: 0.09,
            grossMarginPct: 0.71,
            computeIntensity: 0.45,
            qualityScore: 0.89,
            launchedQuarter: 0,
            isActive: true,
          },
        ],
        employees: { engineers: 1420, researchers: 270, sales: 1180, ops: 810, execs: 50, avgComp: 300_000, morale: 74, attrition: 0.03, openRoles: 120 },
        compute: {
          ownedAccelerators: 8_000,
          reservedAccelerators: 34_000,
          reservationExpiryQuarter: 5,
          cloudSpendQuarterly: 40_000_000,
          computeUtilisation: 0.81,
          trainingAllocation: 0.24,
        },
        offices: [{ id: 'off_orbit_hq', city: 'Lakeshore', headcountCapacity: 5000, quarterlyCostUsd: 31_000_000, openedQuarter: 0, isHeadquarters: true }],
        financials: financials(1_288_000_000, 3_100_000_000, 600_000_000, 140_000_000),
        balanceSheet: sheet(3_100_000_000, 4_000_000_000, 900_000_000, 300_000_000, 500_000_000, 600_000_000, 260_000_000, 140_000_000),
        posture: 'balanced',
        riskTolerance: 0.51,
        techCapabilities: { agents: 0.78, retrieval: 0.64, evaluation: 0.61, infrastructure: 0.58, efficiency: 0.52 },
        governmentPastPerformance: 66,
        reputation: reputation(70, 52, 78, 61, 68),
        boardId: 'brd_orbit',
        primarySecurityId: 'sec_orbit_common',
        instrumentId: 'ins_orbit_eq',
        ceoCharacterId: 'chr_daniel_okonkwo',
        parentCompanyId: null,
      },
      {
        id: 'cmp_helix',
        name: 'Helix Systems',
        ticker: 'HLX',
        archetype: 'infrastructure',
        tier: 'major',
        isPublic: true,
        controllerPlayerId: null,
        sectorId: 'cloud_infrastructure',
        foundedQuarter: 0,
        headquartersCity: 'Cascade Valley',
        isActive: true,
        products: [
          {
            id: 'prd_helix_capacity',
            name: 'Helix Reserved Capacity',
            segment: 'enterprise',
            pricePerSeat: 4_900_000,
            activeCustomers: 310,
            churnQuarterly: 0.02,
            growthQuarterly: 0.05,
            grossMarginPct: 0.38,
            computeIntensity: 0.85,
            qualityScore: 0.92,
            launchedQuarter: 0,
            isActive: true,
          },
        ],
        employees: { engineers: 1290, researchers: 60, sales: 160, ops: 520, execs: 40, avgComp: 265_000, morale: 77, attrition: 0.03, openRoles: 60 },
        compute: {
          ownedAccelerators: 220_000,
          reservedAccelerators: 0,
          reservationExpiryQuarter: null,
          cloudSpendQuarterly: 0,
          computeUtilisation: 0.91,
          trainingAllocation: 0.12,
        },
        offices: [{ id: 'off_helix_hq', city: 'Cascade Valley', headcountCapacity: 3000, quarterlyCostUsd: 26_000_000, openedQuarter: 0, isHeadquarters: true }],
        financials: financials(1_519_000_000, 2_400_000_000, 3_800_000_000, 400_000_000),
        balanceSheet: sheet(2_400_000_000, 12_000_000_000, 200_000_000, 100_000_000, 600_000_000, 3_800_000_000, 500_000_000, 400_000_000),
        posture: 'efficiency',
        riskTolerance: 0.36,
        techCapabilities: { infrastructure: 0.91, efficiency: 0.72, security: 0.63, hardware_design: 0.41 },
        governmentPastPerformance: 71,
        reputation: reputation(64, 44, 81, 66, 62),
        boardId: 'brd_helix',
        primarySecurityId: 'sec_helix_common',
        instrumentId: 'ins_helix_eq',
        ceoCharacterId: 'chr_priya_raghavan',
        parentCompanyId: null,
      },
      {
        id: 'cmp_vector',
        name: 'VectorWorks AI',
        ticker: 'VWA',
        archetype: 'enterprise_ai',
        tier: 'significant',
        isPublic: true,
        controllerPlayerId: null,
        sectorId: 'enterprise_software',
        foundedQuarter: 0,
        headquartersCity: 'Harbourgate',
        isActive: true,
        products: [
          {
            id: 'prd_vector_ledger',
            name: 'VectorWorks Ledger',
            segment: 'enterprise',
            pricePerSeat: 640,
            activeCustomers: 214_000,
            churnQuarterly: 0.14,
            growthQuarterly: 0.02,
            grossMarginPct: 0.66,
            computeIntensity: 0.5,
            qualityScore: 0.81,
            launchedQuarter: 0,
            isActive: true,
          },
        ],
        employees: { engineers: 520, researchers: 190, sales: 310, ops: 160, execs: 24, avgComp: 320_000, morale: 38, attrition: 0.11, openRoles: 6 },
        compute: {
          ownedAccelerators: 0,
          reservedAccelerators: 0,
          reservationExpiryQuarter: null,
          cloudSpendQuarterly: 18_000_000,
          computeUtilisation: 0.72,
          trainingAllocation: 0.2,
        },
        offices: [{ id: 'off_vector_hq', city: 'Harbourgate', headcountCapacity: 1500, quarterlyCostUsd: 9_000_000, openedQuarter: 0, isHeadquarters: true }],
        financials: financials(137_000_000, 240_000_000, 900_000_000, 20_000_000),
        balanceSheet: sheet(240_000_000, 300_000_000, 120_000_000, 40_000_000, 80_000_000, 900_000_000, 90_000_000, 20_000_000),
        posture: 'defensive',
        riskTolerance: 0.44,
        techCapabilities: { retrieval: 0.74, evaluation: 0.58, security: 0.55, agents: 0.36 },
        governmentPastPerformance: 48,
        reputation: reputation(49, 51, 44, 52, 33),
        boardId: 'brd_vector',
        primarySecurityId: 'sec_vector_common',
        instrumentId: 'ins_vector_eq',
        ceoCharacterId: 'chr_tomas_lindqvist',
        parentCompanyId: null,
      },
      {
        id: 'cmp_aurora',
        name: 'Aurora Compute',
        ticker: 'ARC',
        archetype: 'chip_maker',
        tier: 'major',
        isPublic: true,
        controllerPlayerId: null,
        sectorId: 'semiconductors',
        foundedQuarter: 0,
        headquartersCity: 'Meridian Bay',
        isActive: true,
        products: [
          {
            id: 'prd_aurora_ax7',
            name: 'Aurora AX-7 Accelerator',
            segment: 'enterprise',
            pricePerSeat: 28_500,
            activeCustomers: 92_000,
            churnQuarterly: 0.01,
            growthQuarterly: 0.07,
            grossMarginPct: 0.57,
            computeIntensity: 0.05,
            qualityScore: 0.94,
            launchedQuarter: 0,
            isActive: true,
          },
        ],
        employees: { engineers: 3100, researchers: 140, sales: 620, ops: 2140, execs: 70, avgComp: 285_000, morale: 79, attrition: 0.02, openRoles: 210 },
        compute: {
          ownedAccelerators: 30_000,
          reservedAccelerators: 0,
          reservationExpiryQuarter: null,
          cloudSpendQuarterly: 5_000_000,
          computeUtilisation: 0.68,
          trainingAllocation: 0.18,
        },
        offices: [{ id: 'off_aurora_hq', city: 'Meridian Bay', headcountCapacity: 9000, quarterlyCostUsd: 58_000_000, openedQuarter: 0, isHeadquarters: true }],
        financials: financials(2_622_000_000, 5_400_000_000, 2_200_000_000, 900_000_000),
        balanceSheet: sheet(5_400_000_000, 14_000_000_000, 300_000_000, 800_000_000, 1_400_000_000, 2_200_000_000, 1_100_000_000, 900_000_000),
        posture: 'balanced',
        riskTolerance: 0.47,
        techCapabilities: { hardware_design: 0.93, infrastructure: 0.71, efficiency: 0.66, security: 0.48 },
        governmentPastPerformance: 63,
        reputation: reputation(63, 47, 76, 69, 74),
        boardId: 'brd_aurora',
        primarySecurityId: 'sec_aurora_common',
        instrumentId: 'ins_aurora_eq',
        ceoCharacterId: 'chr_rebecca_aldana',
        parentCompanyId: null,
      },
      {
        id: 'cmp_meridian',
        name: 'Meridian Data',
        ticker: 'MRD',
        archetype: 'data',
        tier: 'significant',
        isPublic: true,
        controllerPlayerId: null,
        sectorId: 'data_services',
        foundedQuarter: 0,
        headquartersCity: 'Old Quarter',
        isActive: true,
        products: [
          {
            id: 'prd_meridian_synthesis',
            name: 'Meridian Synthesis',
            segment: 'developer_api',
            pricePerSeat: 146,
            activeCustomers: 1_400_000,
            churnQuarterly: 0.06,
            growthQuarterly: 0.11,
            grossMarginPct: 0.74,
            computeIntensity: 0.3,
            qualityScore: 0.86,
            launchedQuarter: 0,
            isActive: true,
          },
        ],
        employees: { engineers: 240, researchers: 280, sales: 60, ops: 90, execs: 18, avgComp: 395_000, morale: 84, attrition: 0.02, openRoles: 34 },
        // Deliberately short of serving capacity: Meridian is the company the
        // capacity-constraint test leans on.
        compute: {
          ownedAccelerators: 4_000,
          reservedAccelerators: 0,
          reservationExpiryQuarter: null,
          cloudSpendQuarterly: 6_000_000,
          computeUtilisation: 0.94,
          trainingAllocation: 0.34,
        },
        offices: [{ id: 'off_meridian_hq', city: 'Old Quarter', headcountCapacity: 900, quarterlyCostUsd: 7_000_000, openedQuarter: 0, isHeadquarters: true }],
        financials: financials(204_000_000, 620_000_000, 0, 60_000_000),
        balanceSheet: sheet(620_000_000, 400_000_000, 0, 90_000_000, 110_000_000, 0, 70_000_000, 60_000_000),
        posture: 'research_first',
        riskTolerance: 0.68,
        techCapabilities: { data_curation: 0.88, evaluation: 0.71, reasoning: 0.49, agents: 0.42 },
        governmentPastPerformance: 41,
        reputation: reputation(55, 69, 48, 44, 52),
        boardId: null,
        primarySecurityId: 'sec_meridian_common',
        instrumentId: 'ins_meridian_eq',
        ceoCharacterId: 'chr_kenji_watanabe',
        parentCompanyId: null,
      },
    ],
    characters: [
      {
        id: 'chr_maya_chen',
        name: 'Maya Chen',
        role: 'founder_ceo',
        companyId: 'cmp_nexus',
        title: 'CEO — Nexus Intelligence',
        stableTraits: { riskTolerance: 89, technicalOrientation: 96, financialConservatism: 27, aggressiveness: 83, statusSensitivity: 66 },
        beliefs: [{ topic: 'compute_scarcity', level: 'high' }],
        connectionLevel: 86,
        isPlayer: true,
        personalWealthUsd: 4_100_000_000,
        boardSeatCount: 2,
        publicFollowing: 2_400_000,
        isActive: true,
      },
      {
        id: 'chr_daniel_okonkwo',
        name: 'Daniel Okonkwo',
        role: 'founder_ceo',
        companyId: 'cmp_orbit',
        title: 'CEO — Orbit Dynamics',
        stableTraits: { riskTolerance: 48, technicalOrientation: 61, financialConservatism: 72, aggressiveness: 44, statusSensitivity: 51 },
        beliefs: [],
        connectionLevel: 74,
        isPlayer: false,
        personalWealthUsd: 890_000_000,
        boardSeatCount: 1,
        publicFollowing: 310_000,
        isActive: true,
      },
      {
        id: 'chr_priya_raghavan',
        name: 'Priya Raghavan',
        role: 'founder_ceo',
        companyId: 'cmp_helix',
        title: 'CEO — Helix Systems',
        stableTraits: { riskTolerance: 42, technicalOrientation: 68, financialConservatism: 80, aggressiveness: 39, statusSensitivity: 44 },
        beliefs: [],
        connectionLevel: 79,
        isPlayer: false,
        personalWealthUsd: 1_250_000_000,
        boardSeatCount: 2,
        publicFollowing: 120_000,
        isActive: true,
      },
      {
        id: 'chr_tomas_lindqvist',
        name: 'Tomas Lindqvist',
        role: 'founder_ceo',
        companyId: 'cmp_vector',
        title: 'CEO — VectorWorks AI',
        stableTraits: { riskTolerance: 55, technicalOrientation: 88, financialConservatism: 41, aggressiveness: 31, statusSensitivity: 58 },
        beliefs: [],
        connectionLevel: 51,
        isPlayer: false,
        personalWealthUsd: 96_000_000,
        boardSeatCount: 1,
        publicFollowing: 44_000,
        isActive: true,
      },
      {
        id: 'chr_rebecca_aldana',
        name: 'Rebecca Aldana',
        role: 'founder_ceo',
        companyId: 'cmp_aurora',
        title: 'CEO — Aurora Compute',
        stableTraits: { riskTolerance: 58, technicalOrientation: 74, financialConservatism: 63, aggressiveness: 66, statusSensitivity: 61 },
        beliefs: [],
        connectionLevel: 84,
        isPlayer: false,
        personalWealthUsd: 2_600_000_000,
        boardSeatCount: 3,
        publicFollowing: 190_000,
        isActive: true,
      },
      {
        id: 'chr_kenji_watanabe',
        name: 'Kenji Watanabe',
        role: 'founder_ceo',
        companyId: 'cmp_meridian',
        title: 'CEO — Meridian Data',
        stableTraits: { riskTolerance: 71, technicalOrientation: 91, financialConservatism: 38, aggressiveness: 29, statusSensitivity: 47 },
        beliefs: [],
        connectionLevel: 62,
        isPlayer: false,
        personalWealthUsd: 210_000_000,
        boardSeatCount: 0,
        publicFollowing: 380_000,
        isActive: true,
      },
      {
        id: 'chr_ines_ferreira',
        name: 'Inés Ferreira',
        role: 'executive',
        companyId: 'cmp_helix',
        title: 'Chief Infrastructure Officer — Helix Systems',
        stableTraits: { riskTolerance: 52, technicalOrientation: 87, financialConservatism: 49, aggressiveness: 35, statusSensitivity: 40 },
        beliefs: [],
        connectionLevel: 58,
        isPlayer: false,
        personalWealthUsd: 24_000_000,
        boardSeatCount: 0,
        publicFollowing: 18_000,
        isActive: true,
      },
    ],
    relationships: [
      {
        fromId: 'chr_ines_ferreira',
        toId: 'chr_maya_chen',
        trust: 44,
        respect: 71,
        hostility: 12,
        dependence: 20,
        lastInteractionQuarter: 0,
        interactionCount: 3,
      },
    ],
    players: [
      {
        playerId: 'ply_01',
        characterId: 'chr_maya_chen',
        companyId: 'cmp_nexus',
        isHuman: true,
        displayName: 'Maya Chen',
        joinedQuarter: 0,
        autoExecuteRoutine: false,
        hasSubmittedThisQuarter: true,
        isActive: true,
      },
    ],
  };
}

function makeState(): SessionState {
  return SessionStateSchema.parse(baseInput());
}

function action(
  state: SessionState,
  quarter: number,
  sequence: number,
  companyId: string,
  characterId: string,
  intent: SubmittedAction['intent'],
): SubmittedAction {
  return {
    actionId: `act_${quarter}_${sequence}`,
    sessionId: state.sessionId,
    quarter,
    sequence,
    actorPlayerId: companyId === 'cmp_nexus' ? 'ply_01' : null,
    actorCompanyId: companyId,
    actorCharacterId: characterId,
    origin: 'player_ui',
    intent,
    confirmedByHuman: true,
  };
}

function company(state: SessionState, id: string) {
  const found = state.companies.find((c) => c.id === id);
  if (found === undefined) throw new Error(`missing company ${id}`);
  return found;
}

/** Run one quarter of the company phases, in resolver order. */
function runQuarter(state: SessionState, quarter: number, seed: string) {
  const rng = createRng(`${seed}/q${quarter}`);
  const npc = harness(quarter, rng.fork('npc'));
  applyNpcDefaults(state, npc.ctx);
  const talent = harness(quarter, rng.fork('talent'));
  resolveHiring(state, talent.ctx);
  const product = harness(quarter, rng.fork('product'));
  resolveProducts(state, product.ctx);
  const finance = harness(quarter, rng.fork('finance'));
  const result = resolveFinancials(state, finance.ctx);
  const metrics = harness(quarter, rng.fork('metrics'));
  recomputeMetrics(state, metrics.ctx);
  return {
    result,
    events: [...npc.events, ...talent.events, ...product.events, ...finance.events],
    lines: [...npc.lines, ...talent.lines, ...product.lines, ...finance.lines],
  };
}

/* -------------------------------------------------------------------------- */
/*  Tests                                                                      */
/* -------------------------------------------------------------------------- */

describe('company subsystem determinism', () => {
  it('produces identical state and ledger for the same seed', () => {
    const a = makeState();
    const b = makeState();
    const ra = runQuarter(a, START_QUARTER, '424242');
    const rb = runQuarter(b, START_QUARTER, '424242');
    expect(JSON.stringify(b.companies)).toBe(JSON.stringify(a.companies));
    expect(JSON.stringify(rb.events)).toBe(JSON.stringify(ra.events));
    expect(JSON.stringify(rb.result)).toBe(JSON.stringify(ra.result));
  });

  it('produces different outcomes for a different seed', () => {
    const a = makeState();
    const b = makeState();
    runQuarter(a, START_QUARTER, '424242');
    runQuarter(b, START_QUARTER, '999999');
    expect(JSON.stringify(b.companies)).not.toBe(JSON.stringify(a.companies));
  });
});

describe('demand elasticity', () => {
  it('carries the documented sign and ordering per segment', () => {
    // A 20% price rise: consumers punish it hardest, governments least.
    const consumer = priceFactor('consumer', 120, 100);
    const developer = priceFactor('developer_api', 120, 100);
    const enterprise = priceFactor('enterprise', 120, 100);
    const government = priceFactor('government', 120, 100);
    expect(consumer).toBeLessThan(developer);
    expect(developer).toBeLessThan(enterprise);
    expect(enterprise).toBeLessThan(government);
    expect(government).toBeLessThan(1);
    expect(priceFactor('consumer', 80, 100)).toBeGreaterThan(1);
    expect(SEGMENT_PRICE_ELASTICITY).toEqual({ consumer: 1.6, enterprise: 0.7, developer_api: 1.2, government: 0.4 });
  });

  it('turns a price rise into fewer customers than the same company holding price', () => {
    const held = makeState();
    const raised = makeState();
    const target = company(raised, 'cmp_orbit');
    const product = target.products[0];
    if (product === undefined) throw new Error('fixture missing product');
    raised.pendingActions.push(
      action(raised, START_QUARTER, 0, 'cmp_orbit', 'chr_daniel_okonkwo', {
        type: 'set_product_price',
        productId: product.id,
        pricePerSeatUsd: product.pricePerSeat * 1.35,
      }),
    );
    runQuarter(held, START_QUARTER, '424242');
    runQuarter(raised, START_QUARTER, '424242');
    const heldCustomers = company(held, 'cmp_orbit').products[0]?.activeCustomers ?? 0;
    const raisedCustomers = company(raised, 'cmp_orbit').products[0]?.activeCustomers ?? 0;
    expect(raisedCustomers).toBeLessThan(heldCustomers);
  });
});

describe('serving capacity', () => {
  it('binds, loses the unservable demand and reports a capacity_constraint line', () => {
    const state = makeState();
    const result = runQuarter(state, START_QUARTER, '424242');
    const constrained = result.events.find(
      (e) => e.type === 'demand_resolved' && e.actorId === 'cmp_meridian' && e.payload['capacityConstrained'] === true,
    );
    expect(constrained).toBeDefined();
    expect(Number(constrained?.payload['customersLostToCapacity'])).toBeGreaterThan(0);
    const line = result.lines.find((l) => l.subjectId === 'cmp_meridian' && l.text.startsWith('capacity_constraint:'));
    expect(line).toBeDefined();
    expect(line?.refEventIds?.length ?? 0).toBeGreaterThan(0);

    // The unconstrained rival serves everything it sold.
    const orbit = result.events.find((e) => e.type === 'demand_resolved' && e.actorId === 'cmp_orbit');
    expect(orbit?.payload['capacityConstrained']).toBe(false);
  });

  it('drains rather than empties the base of a company with no serving compute at all', () => {
    // The capacity cap used to multiply the whole book, so a company at zero
    // serving compute lost every customer it had — retained accounts included —
    // in a single quarter. A shortage may now cost at most
    // `CAPACITY_BASE_LOSS_CEILING` of the retained base per quarter, on top of
    // ordinary churn, and takes every unit of new demand it cannot serve.
    const state = makeState();
    const target = company(state, 'cmp_orbit');
    const before = target.products[0]?.activeCustomers ?? 0;
    target.compute.ownedAccelerators = 0;
    target.compute.reservedAccelerators = 0;
    target.compute.reservationExpiryQuarter = null;
    target.compute.cloudSpendQuarterly = 0;

    const customers: number[] = [];
    for (let quarter = START_QUARTER; quarter < START_QUARTER + 4; quarter += 1) {
      runQuarter(state, quarter, '424242');
      const now = company(state, 'cmp_orbit');
      expect(now.compute.ownedAccelerators + now.compute.reservedAccelerators + now.compute.cloudSpendQuarterly).toBe(0);
      customers.push(now.products[0]?.activeCustomers ?? 0);
    }

    // One quarter of total capacity failure costs a bounded share of the base.
    const afterOne = customers[0] ?? 0;
    expect(afterOne / Math.max(1, before)).toBeGreaterThanOrEqual(1 - CAPACITY_BASE_LOSS_CEILING - 0.05);
    // But it is a collapse: every quarter is worse than the last, and the book
    // is a fraction of what it was inside a year.
    for (let i = 1; i < customers.length; i += 1) {
      expect(customers[i] ?? 0).toBeLessThan(customers[i - 1] ?? 0);
    }
    expect(customers[customers.length - 1] ?? 0).toBeLessThan(before * 0.25);
  });

  it('lifts served customers when the same company is given more compute', () => {
    const starved = makeState();
    const fed = makeState();
    company(fed, 'cmp_meridian').compute.ownedAccelerators = 40_000;
    runQuarter(starved, START_QUARTER, '424242');
    runQuarter(fed, START_QUARTER, '424242');
    const starvedCustomers = company(starved, 'cmp_meridian').products[0]?.activeCustomers ?? 0;
    const fedCustomers = company(fed, 'cmp_meridian').products[0]?.activeCustomers ?? 0;
    expect(fedCustomers).toBeGreaterThan(starvedCustomers);
  });
});

describe('financial resolution', () => {
  it('reconciles every balance sheet across twelve quarters of varied action', () => {
    const state = makeState();
    for (let i = 0; i < 12; i += 1) {
      const quarter = START_QUARTER + i;
      state.quarter = quarter;
      state.pendingActions = [];

      // Vary the quarter: hiring, repricing, marketing, a launch, a layoff and
      // an approach to a rival's executive.
      if (i % 3 === 0) {
        state.pendingActions.push(
          action(state, quarter, 0, 'cmp_nexus', 'chr_maya_chen', { type: 'hire', role: 'researchers', count: 40, compBand: 'top_of_market' }),
        );
      }
      // Every company keeps recruiting: without it the majors, which take their
      // instructions from a strategist rather than the archetype tables, would
      // simply shrink through attrition for twelve quarters.
      const recruiters: [string, string, 'engineers' | 'sales' | 'ops'][] = [
        ['cmp_orbit', 'chr_daniel_okonkwo', 'sales'],
        ['cmp_helix', 'chr_priya_raghavan', 'ops'],
        ['cmp_aurora', 'chr_rebecca_aldana', 'engineers'],
      ];
      for (let r = 0; r < recruiters.length; r += 1) {
        const entry = recruiters[r];
        if (entry === undefined) continue;
        const [companyId, characterId, role] = entry;
        state.pendingActions.push(
          action(state, quarter, 10 + r, companyId, characterId, { type: 'hire', role, count: 90, compBand: 'market' }),
        );
      }
      if (i % 4 === 1) {
        state.pendingActions.push(
          action(state, quarter, 1, 'cmp_nexus', 'chr_maya_chen', { type: 'layoff', role: 'sales', count: 25, severanceQuartersOfPay: 1 }),
        );
      }
      if (i % 2 === 0) {
        const product = company(state, 'cmp_orbit').products[0];
        if (product !== undefined) {
          state.pendingActions.push(
            action(state, quarter, 2, 'cmp_orbit', 'chr_daniel_okonkwo', {
              type: 'set_product_price',
              productId: product.id,
              pricePerSeatUsd: Math.round(product.pricePerSeat * (i % 4 === 0 ? 1.05 : 0.96)),
            }),
          );
        }
      }
      if (i === 2) {
        state.pendingActions.push(
          action(state, quarter, 3, 'cmp_nexus', 'chr_maya_chen', {
            type: 'launch_product',
            name: 'Nexus Studio',
            segment: 'consumer',
            pricePerSeatUsd: 90,
            computeIntensity: 0.4,
            launchMarketingUsd: 60_000_000,
            targetQuality: 0.8,
          }),
        );
      }
      if (i === 5) {
        state.pendingActions.push(
          action(state, quarter, 4, 'cmp_nexus', 'chr_maya_chen', {
            type: 'poach_executive',
            targetCharacterId: 'chr_ines_ferreira',
            compPremiumPct: 0.55,
            approach: 'private',
          }),
        );
      }
      if (i === 8) {
        state.pendingActions.push(
          action(state, quarter, 5, 'cmp_orbit', 'chr_daniel_okonkwo', {
            type: 'set_marketing_budget',
            allocations: [{ segment: 'enterprise', budgetUsd: 180_000_000 }],
          }),
        );
      }

      const { result } = runQuarter(state, quarter, '424242');
      for (const check of result.balanceChecks) {
        expect(`${check.companyId}:${check.reconciles}`).toBe(`${check.companyId}:true`);
        expect(Math.abs(check.discrepancyUsd)).toBeLessThanOrEqual(1);
      }
      for (const c of state.companies) {
        expect(balanceSheetReconciles(c.balanceSheet)).toBe(true);
      }
    }

    // Twelve quarters later the whole aggregate is still schema-valid: no
    // negative cash, no out-of-range morale, no impossible growth rate.
    expect(() => SessionStateSchema.parse(state)).not.toThrow();
  });

  it('books unfunded obligations into payables and forces a bridge round', () => {
    const state = makeState();
    const vector = company(state, 'cmp_vector');
    vector.financials.cash = 1_000_000;
    vector.balanceSheet.assets.cash = 1_000_000;
    vector.balanceSheet.equity =
      vector.balanceSheet.assets.cash +
      vector.balanceSheet.assets.ppe +
      vector.balanceSheet.assets.goodwill +
      vector.balanceSheet.assets.investments +
      vector.balanceSheet.assets.receivables -
      (vector.balanceSheet.liabilities.debt + vector.balanceSheet.liabilities.payables + vector.balanceSheet.liabilities.deferredRevenue);

    const { result, events } = runQuarter(state, START_QUARTER, '424242');
    const after = company(state, 'cmp_vector');
    expect(after.balanceSheet.assets.cash).toBe(0);
    expect(after.posture).toBe('survival');
    expect(balanceSheetReconciles(after.balanceSheet)).toBe(true);
    expect(result.balanceChecks.find((c) => c.companyId === 'cmp_vector')?.reconciles).toBe(true);

    const bridge = state.fundingRounds.find((r) => r.companyId === 'cmp_vector' && r.stage === 'bridge');
    expect(bridge?.status).toBe('open');
    expect(bridge?.amount ?? 0).toBeGreaterThan(0);
    expect(state.activeModifiers.some((m) => m.target === 'company.cmp_vector.valuationSentiment' && m.value < 0)).toBe(true);
    const cash = events.find((e) => e.type === 'cash_flow_resolved' && e.actorId === 'cmp_vector');
    expect(cash?.payload['insolvent']).toBe(true);
  });

  it('reports a broken opening balance sheet as a failing check that blocks the commit', () => {
    const state = makeState();
    // Corrupt the opening sheet by more than the tolerance: the check must fail
    // loudly through the returned BalanceSheetCheck, not silently reconcile.
    company(state, 'cmp_orbit').balanceSheet.equity += 5_000_000;
    const { result } = runQuarter(state, START_QUARTER, '424242');
    const check = result.balanceChecks.find((c) => c.companyId === 'cmp_orbit');
    expect(check?.reconciles).toBe(false);
    expect(Math.abs(check?.discrepancyUsd ?? 0)).toBeCloseTo(5_000_000, 0);
  });
});

describe('poaching', () => {
  it('is more likely at a higher compensation premium', () => {
    const state = makeState();
    const nexus = company(state, 'cmp_nexus');
    const low = poachProbability(state, nexus, 'chr_ines_ferreira', 'chr_maya_chen', 0.05, 'private');
    const mid = poachProbability(state, nexus, 'chr_ines_ferreira', 'chr_maya_chen', 0.3, 'private');
    const high = poachProbability(state, nexus, 'chr_ines_ferreira', 'chr_maya_chen', 0.9, 'private');
    expect(mid).toBeGreaterThan(low);
    expect(high).toBeGreaterThan(mid);
    expect(high).toBeLessThanOrEqual(0.95);
    expect(low).toBeGreaterThanOrEqual(0.02);
  });

  it('is harder against a company whose people are happy, and easier with standing', () => {
    const happy = makeState();
    const unhappy = makeState();
    company(unhappy, 'cmp_helix').employees.morale = 12;
    const nexusHappy = company(happy, 'cmp_nexus');
    const nexusUnhappy = company(unhappy, 'cmp_nexus');
    expect(poachProbability(unhappy, nexusUnhappy, 'chr_ines_ferreira', 'chr_maya_chen', 0.3, 'private')).toBeGreaterThan(
      poachProbability(happy, nexusHappy, 'chr_ines_ferreira', 'chr_maya_chen', 0.3, 'private'),
    );

    const strong = makeState();
    company(strong, 'cmp_nexus').reputation = reputation(95, 95, 95, 95, 95);
    expect(poachProbability(strong, company(strong, 'cmp_nexus'), 'chr_ines_ferreira', 'chr_maya_chen', 0.3, 'private')).toBeGreaterThan(
      poachProbability(happy, nexusHappy, 'chr_ines_ferreira', 'chr_maya_chen', 0.3, 'private'),
    );
  });

  it('moves the person, the headcount and the ledger when it succeeds', () => {
    const state = makeState();
    state.pendingActions.push(
      action(state, START_QUARTER, 0, 'cmp_nexus', 'chr_maya_chen', {
        type: 'poach_executive',
        targetCharacterId: 'chr_ines_ferreira',
        compPremiumPct: 2.5,
        approach: 'public',
      }),
    );
    const { events } = runQuarter(state, START_QUARTER, '424242');
    const attempt = events.find((e) => e.type === 'poach_attempted');
    expect(attempt).toBeDefined();
    expect(Number(attempt?.payload['probability'])).toBeGreaterThan(0.4);

    // Whichever way the draw went, the world has to agree with the ledger.
    const succeeded = attempt?.payload['succeeded'] === true;
    const employer = state.characters.find((c) => c.id === 'chr_ines_ferreira')?.companyId;
    expect(employer).toBe(succeeded ? 'cmp_nexus' : 'cmp_helix');
    expect(events.some((e) => e.type === 'departure' && e.targetId === 'chr_ines_ferreira')).toBe(succeeded);
    expect(events.some((e) => e.type === 'compensation_changed' && e.targetId === 'chr_ines_ferreira')).toBe(succeeded);
  });
});

describe('hiring and morale', () => {
  it('fills more roles at a richer band and charges for it', () => {
    const market = makeState();
    const top = makeState();
    market.pendingActions.push(
      action(market, START_QUARTER, 0, 'cmp_nexus', 'chr_maya_chen', { type: 'hire', role: 'engineers', count: 200, compBand: 'below_market' }),
    );
    top.pendingActions.push(
      action(top, START_QUARTER, 0, 'cmp_nexus', 'chr_maya_chen', { type: 'hire', role: 'engineers', count: 200, compBand: 'top_of_market' }),
    );
    const marketRun = runQuarter(market, START_QUARTER, '424242');
    const topRun = runQuarter(top, START_QUARTER, '424242');
    const marketHire = marketRun.events.find((e) => e.type === 'hire_completed');
    const topHire = topRun.events.find((e) => e.type === 'hire_completed');
    expect(Number(topHire?.payload['filled'])).toBeGreaterThan(Number(marketHire?.payload['filled']));
    expect(Number(topHire?.payload['offerCompUsd'])).toBeGreaterThan(Number(marketHire?.payload['offerCompUsd']));
  });

  it('damages morale on a layoff and less so with generous severance', () => {
    const harsh = makeState();
    const generous = makeState();
    harsh.pendingActions.push(
      action(harsh, START_QUARTER, 0, 'cmp_orbit', 'chr_daniel_okonkwo', { type: 'layoff', role: 'sales', count: 600, severanceQuartersOfPay: 0 }),
    );
    generous.pendingActions.push(
      action(generous, START_QUARTER, 0, 'cmp_orbit', 'chr_daniel_okonkwo', { type: 'layoff', role: 'sales', count: 600, severanceQuartersOfPay: 3 }),
    );
    const before = company(makeState(), 'cmp_orbit').employees.morale;
    runQuarter(harsh, START_QUARTER, '424242');
    runQuarter(generous, START_QUARTER, '424242');
    expect(company(harsh, 'cmp_orbit').employees.morale).toBeLessThan(before);
    expect(company(generous, 'cmp_orbit').employees.morale).toBeGreaterThan(company(harsh, 'cmp_orbit').employees.morale);
  });
});

describe('archetype defaults', () => {
  it('directs only undirected non-major companies, and does so from the policy tables', () => {
    const state = makeState();
    state.pendingActions.push(
      action(state, START_QUARTER, 0, 'cmp_vector', 'chr_tomas_lindqvist', { type: 'set_research_budget', budgetUsd: 10_000_000 }),
    );
    const rng = createRng('424242/npc');
    const { ctx, events } = harness(START_QUARTER, rng);
    applyNpcDefaults(state, ctx);

    const directed = new Set(state.pendingActions.filter((a) => a.origin === 'npc_default').map((a) => a.actorCompanyId));
    // Meridian is significant, NPC-run and undirected: it gets a playbook.
    expect(directed.has('cmp_meridian')).toBe(true);
    // VectorWorks already acted this quarter; Nexus is player-run; the rest are major.
    expect(directed.has('cmp_vector')).toBe(false);
    expect(directed.has('cmp_nexus')).toBe(false);
    expect(directed.has('cmp_orbit')).toBe(false);
    expect(events.every((e) => e.type === 'action_accepted')).toBe(true);

    const queued = state.pendingActions.filter((a) => a.actorCompanyId === 'cmp_meridian');
    expect(queued.every((a) => a.origin === 'npc_default' && a.confirmedByHuman === false)).toBe(true);
    expect(queued.some((a) => a.intent.type === 'set_research_budget')).toBe(true);
  });

  it('is deterministic across runs', () => {
    const a = makeState();
    const b = makeState();
    applyNpcDefaults(a, harness(START_QUARTER, createRng('424242/npc')).ctx);
    applyNpcDefaults(b, harness(START_QUARTER, createRng('424242/npc')).ctx);
    expect(JSON.stringify(b.pendingActions)).toBe(JSON.stringify(a.pendingActions));
  });
});

describe('derived metrics', () => {
  it('recomputes one entry per active company with a bounded runway', () => {
    const state = makeState();
    runQuarter(state, START_QUARTER, '424242');
    expect(state.companyMetrics).toHaveLength(state.companies.filter((c) => c.isActive).length);
    for (const metric of state.companyMetrics) {
      expect(metric.quarter).toBe(START_QUARTER);
      expect(metric.runwayQuarters).toBeGreaterThanOrEqual(0);
      expect(metric.runwayQuarters).toBeLessThanOrEqual(200);
      expect(metric.grossMarginPct).toBeGreaterThanOrEqual(0);
      expect(metric.grossMarginPct).toBeLessThanOrEqual(1);
    }
  });
});

describe('report discipline', () => {
  it('never emits a resolution line without a ledger reference', () => {
    const state = makeState();
    state.pendingActions.push(
      action(state, START_QUARTER, 0, 'cmp_nexus', 'chr_maya_chen', { type: 'hire', role: 'engineers', count: 60, compBand: 'above_market' }),
    );
    const { lines } = runQuarter(state, START_QUARTER, '424242');
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line.refEventIds ?? []).not.toHaveLength(0);
      expect(line.text.length).toBeGreaterThan(0);
      expect(line.text.length).toBeLessThanOrEqual(300);
    }
  });
});

/* -------------------------------------------------------------------------- */
/*  The revenue identity                                                       */
/* -------------------------------------------------------------------------- */

describe('the seeded world satisfies the engine own revenue identity', () => {
  it('seeds every company so customers times price reproduces its quarterly revenue', () => {
    // `resolveFinancials` recognises `activeCustomers * pricePerSeat`. A scenario
    // whose seeded revenue disagrees with that product is a world the first
    // resolved quarter destroys, however plausible each number looks alone.
    const state = createDemoSession();
    for (const target of state.companies) {
      const implied = target.products
        .filter((product) => product.isActive)
        .reduce((sum, product) => sum + product.activeCustomers * product.pricePerSeat, 0);
      const deviation = Math.abs(implied - target.financials.revenueQuarterly) / Math.max(1, target.financials.revenueQuarterly);
      expect(`${target.id}: ${(deviation * 100).toFixed(1)}% apart`).toBe(`${target.id}: 0.0% apart`);
    }
  });

  it('holds every seeded revenue within 35% through the first resolved quarter with no actions at all', () => {
    const state = createDemoSession();
    const seeded = new Map(state.companies.map((target) => [target.id, target.financials.revenueQuarterly]));
    const outcome = createDefaultEngine().resolver.resolveQuarter(state, [], null, []);

    expect(outcome.committed).toBe(true);
    for (const target of outcome.nextState.companies) {
      const before = seeded.get(target.id) ?? 0;
      const deviation = Math.abs(target.financials.revenueQuarterly - before) / Math.max(1, before);
      expect(`${target.id}: ${deviation <= 0.35 ? 'within' : `${(deviation * 100).toFixed(0)}% outside`} the band`).toBe(`${target.id}: within the band`);
    }
  });
});

/* -------------------------------------------------------------------------- */
/*  Compute orders                                                             */
/* -------------------------------------------------------------------------- */

describe('the compute pillar', () => {
  it('credits a reservation, sets its expiry and charges it in the same quarter', () => {
    const state = makeState();
    const before = { ...company(state, 'cmp_nexus').compute };
    const expiry = Math.max(before.reservationExpiryQuarter ?? 0, START_QUARTER + 6);
    state.pendingActions.push(
      action(state, START_QUARTER, 0, 'cmp_nexus', 'chr_maya_chen', {
        type: 'reserve_compute',
        units: 12_000,
        quarters: 6,
        maxPricePerUnitUsd: 10_000,
      }),
    );
    const { events } = runQuarter(state, START_QUARTER, '424242');
    const after = company(state, 'cmp_nexus').compute;

    expect(after.reservedAccelerators).toBe(before.reservedAccelerators + 12_000);
    expect(after.reservationExpiryQuarter).toBe(expiry);
    const cost = events.find((event) => event.type === 'cost_recognised' && event.payload['kind'] === 'compute_reserved');
    expect(cost?.payload['units']).toBe(12_000);
    // The financial phase charges reserved capacity out of `company.compute`, so
    // a reservation booked here is paid for here.
    expect(company(state, 'cmp_nexus').financials.cogs).toBeGreaterThan(0);
  });

  it('refuses a reservation whose clearing price is above the bidder limit', () => {
    const state = makeState();
    const before = company(state, 'cmp_nexus').compute.reservedAccelerators;
    state.pendingActions.push(
      action(state, START_QUARTER, 0, 'cmp_nexus', 'chr_maya_chen', {
        type: 'reserve_compute',
        units: 5_000,
        quarters: 4,
        maxPricePerUnitUsd: 1,
      }),
    );
    const { events } = runQuarter(state, START_QUARTER, '424242');
    expect(company(state, 'cmp_nexus').compute.reservedAccelerators).toBe(before);
    expect(events.some((event) => event.payload['kind'] === 'compute_reservation_failed')).toBe(true);
  });

  it('renews an NPC company reservation when its term runs out, holding its serving capacity', () => {
    // Orbit's seeded 34,000 units carry an expiry. Nothing used to read it, so
    // the block ran forever; a bare expiry rule would instead empty the
    // datacentre the quarter the seeded term ended. An NPC company that is still
    // serving customers out of the block re-signs it and its capacity holds.
    const state = makeState();
    const seeded = company(state, 'cmp_orbit').compute;
    const reserved = seeded.reservedAccelerators;
    const expiry = seeded.reservationExpiryQuarter;
    expect([reserved, expiry]).toEqual([34_000, 5]);

    const customers: number[] = [];
    let renewedAt: number | null = null;
    for (let quarter = START_QUARTER; quarter < START_QUARTER + 6; quarter += 1) {
      const { events } = runQuarter(state, quarter, '424242');
      if (events.some((event) => event.actorId === 'cmp_orbit' && event.payload['kind'] === 'compute_reservation_renewed')) {
        renewedAt = quarter;
      }
      const now = company(state, 'cmp_orbit');
      expect(now.compute.reservedAccelerators).toBe(reserved);
      customers.push(now.products[0]?.activeCustomers ?? 0);
    }

    expect(renewedAt).toBe(expiry);
    const after = company(state, 'cmp_orbit').compute;
    expect(after.reservationExpiryQuarter).toBe((expiry ?? 0) + RESERVATION_RENEWAL_QUARTERS);
    // Capacity held, so the book did not fall off the quarter the term ended.
    const atExpiry = customers[(expiry ?? 1) - START_QUARTER] ?? 0;
    const beforeExpiry = customers[(expiry ?? 1) - START_QUARTER - 1] ?? 0;
    expect(atExpiry).toBeGreaterThan(beforeExpiry * 0.9);
  });

  it('releases the reservation of a company that cannot cover the renewal, and its capacity falls', () => {
    const state = makeState();
    const target = company(state, 'cmp_orbit');
    target.compute.reservationExpiryQuarter = START_QUARTER;
    starve(state, 'cmp_orbit');

    const { events, lines } = runQuarter(state, START_QUARTER, '424242');
    const after = company(state, 'cmp_orbit').compute;
    expect(after.reservedAccelerators).toBe(0);
    expect(after.reservationExpiryQuarter).toBeNull();

    const expired = events.find((event) => event.actorId === 'cmp_orbit' && event.payload['kind'] === 'compute_reservation_expired');
    expect(expired?.payload['reason']).toBe('insufficient_cash');
    expect(expired?.payload['units']).toBe(34_000);
    const line = lines.find((candidate) => candidate.subjectId === 'cmp_orbit' && candidate.text.includes('expired'));
    expect(line?.refEventIds ?? []).toContain(expired?.eventId);
    // Losing the block is a capacity event, not an accounting one: the quarter
    // it lapses the company is short of serving capacity.
    expect(events.some((event) => event.actorId === 'cmp_orbit' && event.payload['capacityConstrained'] === true)).toBe(true);
  });

  it('warns a player the quarter before their reservation expires and leaves the renewal to them', () => {
    const lapsing = makeState();
    // Nexus is the player's company in this fixture: its reservation is a
    // decision, so it is told in time to make it rather than renewed for it.
    company(lapsing, 'cmp_nexus').compute.reservationExpiryQuarter = START_QUARTER + 1;
    const held = company(lapsing, 'cmp_nexus').compute.reservedAccelerators;

    const { events, lines } = runQuarter(lapsing, START_QUARTER, '424242');
    const warning = lines.find((line) => line.subjectId === 'cmp_nexus' && line.text.includes('expires next quarter'));
    expect(warning).toBeDefined();
    const ids = new Set(events.map((event) => event.eventId));
    expect(warning?.refEventIds ?? []).not.toHaveLength(0);
    for (const ref of warning?.refEventIds ?? []) expect(ids.has(ref)).toBe(true);
    expect(events.some((event) => event.actorId === 'cmp_nexus' && event.payload['kind'] === 'compute_reservation_expiring')).toBe(true);
    // Warned, not acted upon.
    expect(company(lapsing, 'cmp_nexus').compute.reservedAccelerators).toBe(held);

    // A player who does nothing loses the block the quarter it expires.
    const renewing = makeState();
    company(renewing, 'cmp_nexus').compute.reservationExpiryQuarter = START_QUARTER + 1;
    runQuarter(renewing, START_QUARTER, '424242');
    runQuarter(lapsing, START_QUARTER + 1, '424242');
    expect(company(lapsing, 'cmp_nexus').compute.reservedAccelerators).toBe(0);

    // A player who reserves again keeps it: renewal is an action, not a rule.
    renewing.pendingActions.push(
      action(renewing, START_QUARTER + 1, 0, 'cmp_nexus', 'chr_maya_chen', {
        type: 'reserve_compute',
        units: 10_000,
        quarters: 4,
        maxPricePerUnitUsd: 10_000,
      }),
    );
    runQuarter(renewing, START_QUARTER + 1, '424242');
    expect(company(renewing, 'cmp_nexus').compute.reservedAccelerators).toBe(held + 10_000);
    expect(company(renewing, 'cmp_nexus').compute.reservationExpiryQuarter).toBe(START_QUARTER + 5);
  });

  it('moves cloud spend and the training split, and the split changes what can be served', () => {
    const serving = makeState();
    const training = makeState();
    for (const [state, fraction] of [
      [serving, 0.05],
      [training, 0.95],
    ] as const) {
      state.pendingActions.push(
        action(state, START_QUARTER, 0, 'cmp_orbit', 'chr_daniel_okonkwo', {
          type: 'buy_cloud_capacity',
          quarterlySpendUsd: 90_000_000,
          providerCompanyId: null,
          commitmentQuarters: 2,
        }),
        action(state, START_QUARTER, 1, 'cmp_orbit', 'chr_daniel_okonkwo', { type: 'allocate_compute', trainingFraction: fraction }),
      );
      runQuarter(state, START_QUARTER, '424242');
    }

    expect(company(serving, 'cmp_orbit').compute.cloudSpendQuarterly).toBe(90_000_000);
    expect(company(serving, 'cmp_orbit').compute.trainingAllocation).toBeCloseTo(0.05, 6);
    expect(company(training, 'cmp_orbit').compute.trainingAllocation).toBeCloseTo(0.95, 6);
    // Serving capacity is the whole point of the split.
    expect(company(serving, 'cmp_orbit').products[0]?.activeCustomers ?? 0).toBeGreaterThan(
      company(training, 'cmp_orbit').products[0]?.activeCustomers ?? 0,
    );
  });
});

/* -------------------------------------------------------------------------- */
/*  Requisitions                                                               */
/* -------------------------------------------------------------------------- */

describe('the requisition backlog', () => {
  it('shrinks every quarter a company opens no new roles, and reaches zero', () => {
    const state = makeState();
    const target = company(state, 'cmp_aurora');
    target.employees.openRoles = 210;
    let previous = target.employees.openRoles;

    for (let quarter = START_QUARTER; quarter < START_QUARTER + 10; quarter += 1) {
      runQuarter(state, quarter, '424242');
      const now = company(state, 'cmp_aurora').employees.openRoles;
      expect(now).toBeLessThanOrEqual(previous);
      previous = now;
    }
    expect(company(state, 'cmp_aurora').employees.openRoles).toBe(0);
  });

  it('never carries more standing requisitions than a share of the workforce', () => {
    const state = makeState();
    const target = company(state, 'cmp_vector');
    target.employees.openRoles = 5_000;
    runQuarter(state, START_QUARTER, '424242');
    const after = company(state, 'cmp_vector');
    const headcount = after.employees.engineers + after.employees.researchers + after.employees.sales + after.employees.ops + after.employees.execs;
    expect(after.employees.openRoles).toBeLessThanOrEqual(Math.round(headcount * 0.35));
  });
});

/* -------------------------------------------------------------------------- */
/*  Distress                                                                   */
/* -------------------------------------------------------------------------- */

/** Strip a company down to a guaranteed cash shortfall, books intact. */
function starve(state: SessionState, companyId: string): void {
  const target = company(state, companyId);
  target.financials.cash = 0;
  target.balanceSheet.assets.cash = 0;
  target.balanceSheet.equity =
    target.balanceSheet.assets.cash +
    target.balanceSheet.assets.ppe +
    target.balanceSheet.assets.goodwill +
    target.balanceSheet.assets.investments +
    target.balanceSheet.assets.receivables -
    (target.balanceSheet.liabilities.debt + target.balanceSheet.liabilities.payables + target.balanceSheet.liabilities.deferredRevenue);
}

/**
 * Give a fixture company the ownership it needs to be financed: one common
 * class, one security and one founder position. The company fixture above is
 * about operations and carries no cap table of its own.
 */
function withCapTable(state: SessionState, companyId: string, issued: number, authorised: number): void {
  const shareClassId = `shc_${companyId}_common`;
  const securityId = `sec_${companyId}_common`;
  const target = company(state, companyId);
  target.primarySecurityId = securityId;
  state.securities.push({
    id: securityId,
    companyId,
    shareClassId,
    symbol: null,
    isTradable: false,
    instrumentId: null,
    parValueUsd: 0.0001,
  });
  state.capTables.push({
    companyId,
    shareClasses: [
      {
        id: shareClassId,
        companyId,
        kind: 'common',
        label: 'Common',
        votesPerShare: 1,
        liquidationPreferenceMultiple: 0,
        participating: false,
        authorisedShares: authorised,
        issuedShares: issued,
        createdQuarter: 0,
      },
    ],
    holdings: [
      {
        id: `hld_${companyId}_founder`,
        holderId: `chr_${companyId}_founder`,
        holderKind: 'character',
        securityId,
        shares: issued,
        costBasisUsd: 1_000,
        acquiredQuarter: 0,
        lockupUntilQuarter: null,
        isDisclosed: true,
      },
    ],
    totalIssuedByClass: { [shareClassId]: issued },
    fullyDilutedShares: issued,
    optionPoolShares: 0,
    lastUpdatedQuarter: 0,
  });
}

describe('forced bridge rounds', () => {
  it('funds the bridge the next quarter, taking cash in and issuing the shares that dilute the cap table', () => {
    const state = makeState();
    withCapTable(state, 'cmp_vector', 300_000_000, 900_000_000);
    starve(state, 'cmp_vector');
    runQuarter(state, START_QUARTER, '424242');

    const bridge = state.fundingRounds.find((round) => round.companyId === 'cmp_vector' && round.stage === 'bridge');
    expect(bridge?.status).toBe('open');
    const table = state.capTables.find((candidate) => candidate.companyId === 'cmp_vector');
    const sharesBefore = table?.fullyDilutedShares ?? 0;

    const { events } = runQuarter(state, START_QUARTER + 1, '424242');
    const settled = state.fundingRounds.find((round) => round.id === bridge?.id);
    expect(`${settled?.status}: ${String(events.find((event) => event.type === 'funding_round_failed')?.payload['reason'] ?? 'funded')}`).toBe(
      'closed: funded',
    );
    expect(settled?.dilution ?? 0).toBeGreaterThan(0);
    expect(table?.fullyDilutedShares ?? 0).toBeGreaterThan(sharesBefore);
    expect(events.some((event) => event.type === 'shares_issued' && event.payload['reason'] === 'forced_bridge')).toBe(true);
    // Issued shares still reconcile to the holdings that carry them.
    const issued = table?.shareClasses.reduce((sum, klass) => sum + klass.issuedShares, 0) ?? 0;
    const held = table?.holdings.reduce((sum, holding) => sum + holding.shares, 0) ?? 0;
    expect(held).toBe(issued);
  });

  it('never leaves a bridge open for two consecutive quarters', () => {
    const state = makeState();
    withCapTable(state, 'cmp_vector', 300_000_000, 900_000_000);
    starve(state, 'cmp_vector');
    for (let quarter = START_QUARTER; quarter < START_QUARTER + 6; quarter += 1) {
      runQuarter(state, quarter, '424242');
      const stale = state.fundingRounds.filter((round) => round.status === 'open' && round.closedQuarter < quarter);
      expect(stale).toEqual([]);
    }
  });
});

describe('insolvency', () => {
  it('winds a company up after three failed rescues, releasing its people and clearing its books', () => {
    const state = makeState();
    // Nobody is funding anything: every bridge this company forces will fail.
    state.world.capitalMarkets.ventureLiquidity = 0;
    state.world.capitalMarkets.riskAppetite = 0;
    withCapTable(state, 'cmp_vector', 300_000_000, 900_000_000);
    starve(state, 'cmp_vector');

    let administered = false;
    for (let quarter = START_QUARTER; quarter < START_QUARTER + 6 && !administered; quarter += 1) {
      const { events } = runQuarter(state, quarter, '424242');
      administered = events.some((event) => event.payload['kind'] === 'administration');
    }
    expect(administered).toBe(true);

    const wound = company(state, 'cmp_vector');
    expect(wound.products.every((product) => !product.isActive)).toBe(true);
    expect(wound.employees.engineers + wound.employees.researchers + wound.employees.sales + wound.employees.ops + wound.employees.execs).toBe(0);
    expect(wound.compute.ownedAccelerators).toBe(0);
    expect(wound.balanceSheet.liabilities.payables).toBe(0);
    expect(Math.abs(wound.balanceSheet.equity)).toBeLessThan(wound.financials.revenueQuarterly + 1);
    expect(balanceSheetReconciles(wound.balanceSheet)).toBe(true);
    // The husk stays acquirable — a distressed rival is the point of a failure.
    expect(wound.isActive).toBe(true);
    // Its people are on the market.
    expect(state.characters.some((character) => character.companyId === 'cmp_vector')).toBe(false);
  });

  it('winds up a company whose rescues all clear but which never becomes a business', () => {
    // The zombie the failed-bridge trigger cannot see. Every bridge this company
    // forces is funded, so it never takes a strike; without the chronic trigger
    // it runs on other people's money on zero revenue for ever.
    const state = makeState();
    // Authorised deep enough that no rescue can fail for want of shares: this
    // company must die of chronic distress, not of a bridge nobody could price.
    withCapTable(state, 'cmp_vector', 300_000_000, 400_000_000_000);
    const zombie = company(state, 'cmp_vector');
    for (const product of zombie.products) product.activeCustomers = 0;
    zombie.employees = { ...zombie.employees, engineers: 60, researchers: 0, sales: 0, ops: 0, execs: 4, openRoles: 0 };
    zombie.compute.cloudSpendQuarterly = 0;
    starve(state, 'cmp_vector');

    let woundAt: number | null = null;
    let cause: unknown = null;
    const rescueQuarters: number[] = [];
    for (let quarter = START_QUARTER; quarter < START_QUARTER + 8 && woundAt === null; quarter += 1) {
      const { events } = runQuarter(state, quarter, '424242');
      // Nobody ever refused it: the failed-bridge trigger never comes into it.
      expect(events.filter((event) => event.type === 'funding_round_failed' && event.actorId === 'cmp_vector')).toEqual([]);
      if (events.some((event) => event.type === 'funding_round_closed' && event.actorId === 'cmp_vector')) rescueQuarters.push(quarter);
      const administration = events.find((event) => event.actorId === 'cmp_vector' && event.payload['kind'] === 'administration');
      if (administration !== undefined) {
        woundAt = quarter;
        cause = administration.payload['cause'];
      }
    }

    expect(`wound up at ${String(woundAt)} because ${String(cause)}`).toBe(`wound up at ${String(woundAt)} because chronic_distress`);
    expect(woundAt).not.toBeNull();
    expect(rescueQuarters.length).toBeGreaterThanOrEqual(CHRONIC_DISTRESS_QUARTERS - 1);

    const wound = company(state, 'cmp_vector');
    expect(wound.products.every((product) => !product.isActive)).toBe(true);
    expect(wound.employees.engineers + wound.employees.execs).toBe(0);
    expect(wound.balanceSheet.liabilities.payables).toBe(0);
    expect(balanceSheetReconciles(wound.balanceSheet)).toBe(true);
  });

  it('leaves a rescued company alone', () => {
    const state = makeState();
    withCapTable(state, 'cmp_vector', 300_000_000, 900_000_000);
    starve(state, 'cmp_vector');
    for (let quarter = START_QUARTER; quarter < START_QUARTER + 6; quarter += 1) runQuarter(state, quarter, '424242');
    expect(company(state, 'cmp_vector').products.some((product) => product.isActive)).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/*  Repricing                                                                  */
/* -------------------------------------------------------------------------- */

describe('a price shock', () => {
  it('costs a company far more of its base than the segment churn band alone allows', () => {
    const held = makeState();
    const shocked = makeState();
    const target = company(shocked, 'cmp_orbit');
    const product = target.products[0];
    if (product === undefined) throw new Error('fixture has no product');
    shocked.pendingActions.push(
      action(shocked, START_QUARTER, 0, 'cmp_orbit', 'chr_daniel_okonkwo', {
        type: 'set_product_price',
        productId: product.id,
        pricePerSeatUsd: product.pricePerSeat * 4,
      }),
    );

    runQuarter(held, START_QUARTER, '424242');
    runQuarter(shocked, START_QUARTER, '424242');

    const after = company(shocked, 'cmp_orbit').products[0];
    const baseline = company(held, 'cmp_orbit').products[0];
    expect(after?.churnQuarterly ?? 0).toBeGreaterThan(0.5);
    expect(after?.activeCustomers ?? 0).toBeLessThan((baseline?.activeCustomers ?? 0) * 0.6);
    // The whole point: quadrupling the price does not quadruple revenue.
    expect(company(shocked, 'cmp_orbit').financials.revenueQuarterly).toBeLessThan(
      company(held, 'cmp_orbit').financials.revenueQuarterly * 2,
    );
  });
});
