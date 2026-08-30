/**
 * @frontier/simulation — research subsystem tests.
 *
 * The fixture mirrors the Frontier Map in `supabase/seed.sql`: the same node
 * keys, the same three programmes (Programme Meridian-7 against sparse expert
 * reasoning, the secret Project Lattice against dense scaling saturation, and
 * Meridian Data's Agora against persistent agent economies), and the same
 * session seed 424242 at 2027 Q1.
 *
 * The invariant these tests exist to protect is `information_boundary`: a secret
 * programme must not appear in anything the world can see, and must not move the
 * public epistemic state of the node it is chasing.
 */

import { describe, expect, it } from 'vitest';
import type {
  InnovationProposal,
  ResolutionLineDraft,
  ResolverContext,
  SeededRng,
  SectorKey,
  SessionState,
  SessionStateInput,
  SimEventDraft,
  SubmittedAction,
} from '@frontier/contracts';
import { SessionStateSchema } from '@frontier/contracts';
import {
  achieveNodes,
  advanceProjects,
  integrateInnovationProposal,
  publicResearchProjects,
  publicTechGraph,
  resourcingFactors,
  techGraphForCompany,
  updateTechConfidence,
} from '../src/research/index';

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

function harness(quarter: number, seed: string): Harness {
  const events: (SimEventDraft & { eventId: string })[] = [];
  const lines: ResolutionLineDraft[] = [];
  const ctx: ResolverContext = {
    quarter,
    rng: createRng(seed),
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
const QUARTER = 1;

function sector(sectorId: SectorKey, demand: number) {
  return { sectorId, sentiment: 0.1, multiple: 1.2, demand, volatility: 0.35 };
}

function sheet(cash: number, ppe: number) {
  return {
    assets: { cash, ppe, goodwill: 0, investments: 0, receivables: 0 },
    liabilities: { debt: 0, payables: 0, deferredRevenue: 0 },
    equity: cash + ppe,
  };
}

function financials(revenue: number, cash: number) {
  return {
    revenueQuarterly: revenue,
    cogs: revenue * 0.3,
    payroll: revenue * 0.3,
    marketing: revenue * 0.05,
    rdSpend: revenue * 0.4,
    capex: 0,
    interestExpense: 0,
    cash,
    debt: 0,
    quarterlyBurn: -revenue * 0.1,
    deferredRevenue: 0,
    backlogUsd: 0,
  };
}

const world = {
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

function techCompany(
  id: string,
  name: string,
  ticker: string,
  archetype: 'frontier_lab' | 'data',
  sectorId: string,
  ceoCharacterId: string,
  capabilities: Record<string, number>,
  revenue: number,
  cash: number,
) {
  return {
    id,
    name,
    ticker,
    archetype,
    tier: 'major' as const,
    isPublic: true,
    controllerPlayerId: id === 'cmp_nexus' ? 'ply_01' : null,
    sectorId,
    foundedQuarter: 0,
    headquartersCity: 'Bay Federal District',
    isActive: true,
    products: [],
    employees: { engineers: 400, researchers: 300, sales: 60, ops: 120, execs: 20, avgComp: 460_000, morale: 68, attrition: 0.04, openRoles: 20 },
    compute: {
      ownedAccelerators: 40_000,
      reservedAccelerators: 60_000,
      reservationExpiryQuarter: 9,
      cloudSpendQuarterly: 20_000_000,
      computeUtilisation: 0.88,
      trainingAllocation: 0.6,
    },
    offices: [],
    financials: financials(revenue, cash),
    balanceSheet: sheet(cash, 2_000_000_000),
    posture: 'research_first' as const,
    riskTolerance: 0.8,
    techCapabilities: capabilities,
    governmentPastPerformance: 50,
    reputation: { public: 58, developer: 66, enterprise: 61, government: 49, investor: 71 },
    boardId: null,
    primarySecurityId: null,
    instrumentId: null,
    ceoCharacterId,
    parentCompanyId: null,
  };
}

function baseInput(): SessionStateInput {
  return {
    sessionId: SESSION_ID,
    seed: '424242',
    quarter: QUARTER,
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
    world,
    sectors: {
      frontier_models: sector('frontier_models', 0.71),
      data_services: sector('data_services', 0.51),
    },
    eventHazards: {
      fam_model_breakthrough: {
        familyId: 'fam_model_breakthrough',
        baseHazard: 0.12,
        currentHazard: 0.12,
        cooldownRemaining: 0,
        lastFiredQuarter: null,
        pendingDeltas: [],
      },
    },
    techGraph: {
      version: 4,
      sessionId: SESSION_ID,
      updatedQuarter: QUARTER,
      nodes: [
        {
          id: 'tech_transformer_scaling',
          title: 'Transformer Scaling',
          summary: 'Predictable capability gains from scaling dense transformer pretraining.',
          status: 'achieved',
          publicConfidence: 1,
          confidenceByCompany: { cmp_nexus: 1 },
          estimatedWindow: [2027, 2028],
          researchCostRange: [800_000_000, 4_000_000_000],
          computeIntensity: 0.92,
          talentRequirements: ['training_systems'],
          dependencies: [],
          possibleUnlocks: ['tech_sparse_expert_reasoning'],
          originalProposerId: null,
          visibility: 'public',
          achievedByCompanyId: 'cmp_nexus',
          achievedQuarter: 0,
          createdQuarter: 0,
          novelty: 0.12,
          plausibility: 0.94,
        },
        {
          id: 'tech_sparse_expert_reasoning',
          title: 'Sparse Expert Reasoning',
          summary: 'Routing reasoning through sparse expert mixtures to hold capability while halving serving cost.',
          status: 'emerging',
          publicConfidence: 0.61,
          confidenceByCompany: { cmp_nexus: 0.72 },
          estimatedWindow: [2029, 2032],
          researchCostRange: [400_000_000, 1_800_000_000],
          computeIntensity: 0.74,
          talentRequirements: ['reasoning', 'efficiency'],
          dependencies: ['tech_transformer_scaling'],
          possibleUnlocks: ['tech_efficient_sparse_inference'],
          originalProposerId: null,
          visibility: 'public',
          achievedByCompanyId: null,
          achievedQuarter: null,
          createdQuarter: 0,
          novelty: 0.44,
          plausibility: 0.78,
        },
        {
          id: 'tech_efficient_sparse_inference',
          title: 'Efficient Sparse Inference',
          summary: 'Serving sparse mixtures at a fraction of the cost of dense inference, on commodity accelerators.',
          status: 'forecast',
          publicConfidence: 0.42,
          confidenceByCompany: {},
          estimatedWindow: [2031, 2035],
          researchCostRange: [300_000_000, 1_200_000_000],
          computeIntensity: 0.55,
          talentRequirements: ['efficiency', 'infrastructure'],
          dependencies: ['tech_sparse_expert_reasoning'],
          possibleUnlocks: [],
          originalProposerId: null,
          visibility: 'public',
          achievedByCompanyId: null,
          achievedQuarter: null,
          createdQuarter: 0,
          novelty: 0.51,
          plausibility: 0.72,
        },
        {
          id: 'tech_autonomous_research',
          title: 'Autonomous Research Systems',
          summary: 'Systems that form hypotheses, run experiments and revise their own research programmes without supervision.',
          status: 'speculative',
          publicConfidence: 0.09,
          confidenceByCompany: {},
          estimatedWindow: [2036, 2044],
          researchCostRange: [4_000_000_000, 18_000_000_000],
          computeIntensity: 0.96,
          talentRequirements: ['reasoning', 'agents', 'evaluation'],
          dependencies: ['tech_sparse_expert_reasoning'],
          possibleUnlocks: [],
          originalProposerId: null,
          visibility: 'public',
          achievedByCompanyId: null,
          achievedQuarter: null,
          createdQuarter: 0,
          novelty: 0.88,
          plausibility: 0.36,
        },
        {
          id: 'tech_persistent_agent_economies',
          title: 'Persistent Agent Economies',
          summary: 'Millions of agents learning economic behaviour together in persistent simulated environments.',
          status: 'company_thesis',
          publicConfidence: 0.22,
          confidenceByCompany: { cmp_meridian: 0.71 },
          estimatedWindow: [2031, 2037],
          researchCostRange: [280_000_000, 1_600_000_000],
          computeIntensity: 0.79,
          talentRequirements: ['agents', 'data_curation'],
          dependencies: [],
          possibleUnlocks: ['tech_autonomous_research'],
          originalProposerId: 'chr_kenji_watanabe',
          visibility: 'public',
          achievedByCompanyId: null,
          achievedQuarter: null,
          createdQuarter: 0,
          novelty: 0.82,
          plausibility: 0.63,
        },
        {
          id: 'tech_neuromorphic_substrates',
          title: 'Neuromorphic Substrates',
          summary: 'Event-driven analogue hardware as a replacement for dense digital accelerators, twice failed commercially.',
          status: 'discredited',
          publicConfidence: 0.05,
          confidenceByCompany: {},
          estimatedWindow: [2035, 2045],
          researchCostRange: [2_000_000_000, 9_000_000_000],
          computeIntensity: 0.29,
          talentRequirements: ['hardware_design'],
          dependencies: [],
          possibleUnlocks: [],
          originalProposerId: null,
          visibility: 'public',
          achievedByCompanyId: null,
          achievedQuarter: null,
          createdQuarter: 0,
          novelty: 0.77,
          plausibility: 0.14,
        },
        {
          // Nexus believes a scaling wall exists and has not said so.
          id: 'tech_dense_scaling_saturation',
          title: 'Dense Scaling Saturation',
          summary: 'Internal evidence that dense pretraining returns fall off a cliff two generations ahead of the public curve.',
          status: 'secret',
          publicConfidence: 0.04,
          confidenceByCompany: { cmp_nexus: 0.79 },
          estimatedWindow: [2028, 2029],
          researchCostRange: [80_000_000, 260_000_000],
          computeIntensity: 0.3,
          talentRequirements: ['evaluation'],
          dependencies: [],
          possibleUnlocks: [],
          originalProposerId: null,
          visibility: 'company_private',
          achievedByCompanyId: null,
          achievedQuarter: null,
          createdQuarter: 0,
          novelty: 0.58,
          plausibility: 0.81,
        },
      ],
      edges: [
        { from: 'tech_transformer_scaling', to: 'tech_sparse_expert_reasoning', kind: 'depends', strength: 1 },
        { from: 'tech_sparse_expert_reasoning', to: 'tech_efficient_sparse_inference', kind: 'unlocks', strength: 0.9 },
        { from: 'tech_sparse_expert_reasoning', to: 'tech_autonomous_research', kind: 'depends', strength: 1 },
        { from: 'tech_persistent_agent_economies', to: 'tech_autonomous_research', kind: 'informs', strength: 0.6 },
      ],
    },
    companies: [
      techCompany(
        'cmp_nexus',
        'Nexus Intelligence',
        'NXS',
        'frontier_lab',
        'frontier_models',
        'chr_maya_chen',
        { reasoning: 0.81, training_systems: 0.86, infrastructure: 0.68, efficiency: 0.44, evaluation: 0.57, agents: 0.35 },
        1_848_000_000,
        6_000_000_000,
      ),
      techCompany(
        'cmp_meridian',
        'Meridian Data',
        'MRD',
        'data',
        'data_services',
        'chr_kenji_watanabe',
        { data_curation: 0.88, evaluation: 0.71, reasoning: 0.49, agents: 0.42 },
        204_000_000,
        620_000_000,
      ),
    ],
    researchProjects: [
      {
        id: 'rsp_meridian_7',
        companyId: 'cmp_nexus',
        targetNodeId: 'tech_sparse_expert_reasoning',
        budgetQuarterly: 210_000_000,
        computeAllocated: 96_000,
        talentAllocated: 210,
        progress: 0.08,
        internalConfidence: 0.62,
        quartersElapsed: 0,
        expectedQuarters: 5,
        isSecret: false,
        status: 'active',
        cumulativeSpendUsd: 61_000_000,
        setbacks: 0,
        startedQuarter: 0,
      },
      {
        id: 'rsp_lattice',
        companyId: 'cmp_nexus',
        targetNodeId: 'tech_dense_scaling_saturation',
        budgetQuarterly: 48_000_000,
        computeAllocated: 21_000,
        talentAllocated: 46,
        progress: 0.41,
        internalConfidence: 0.79,
        quartersElapsed: 2,
        expectedQuarters: 4,
        isSecret: true,
        status: 'active',
        cumulativeSpendUsd: 74_000_000,
        setbacks: 0,
        startedQuarter: 0,
      },
      {
        id: 'rsp_agora',
        companyId: 'cmp_meridian',
        targetNodeId: 'tech_persistent_agent_economies',
        budgetQuarterly: 31_000_000,
        computeAllocated: 12_000,
        talentAllocated: 88,
        progress: 0.12,
        internalConfidence: 0.71,
        quartersElapsed: 0,
        expectedQuarters: 9,
        isSecret: false,
        status: 'active',
        cumulativeSpendUsd: 34_000_000,
        setbacks: 0,
        startedQuarter: 0,
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
        beliefs: [{ topic: 'frontier_progress', level: 'high' }],
        connectionLevel: 86,
        isPlayer: true,
        personalWealthUsd: 4_100_000_000,
        boardSeatCount: 2,
        publicFollowing: 2_400_000,
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
    ],
  };
}

function makeState(): SessionState {
  return SessionStateSchema.parse(baseInput());
}

function project(state: SessionState, id: string) {
  const found = state.researchProjects.find((p) => p.id === id);
  if (found === undefined) throw new Error(`missing project ${id}`);
  return found;
}

function node(state: SessionState, id: string) {
  const found = state.techGraph.nodes.find((n) => n.id === id);
  if (found === undefined) throw new Error(`missing node ${id}`);
  return found;
}

function company(state: SessionState, id: string) {
  const found = state.companies.find((c) => c.id === id);
  if (found === undefined) throw new Error(`missing company ${id}`);
  return found;
}

function proposalAction(state: SessionState, sequence: number, companyId: string, characterId: string, proposal: InnovationProposal): SubmittedAction {
  return {
    actionId: `act_${QUARTER}_${sequence}`,
    sessionId: state.sessionId,
    quarter: QUARTER,
    sequence,
    actorPlayerId: companyId === 'cmp_nexus' ? 'ply_01' : null,
    actorCompanyId: companyId,
    actorCharacterId: characterId,
    origin: 'chief_of_staff',
    intent: { type: 'propose_innovation', proposal },
    confirmedByHuman: true,
  };
}

function baseProposal(overrides: Partial<InnovationProposal> = {}): InnovationProposal {
  return {
    nodeType: 'player_hypothesis',
    title: 'Mass Multi-Agent World Learning',
    summary:
      'Train reasoning policies inside persistent multi-agent economies rather than on static corpora, so planning behaviour emerges from competition rather than imitation.',
    novelty: 0.72,
    plausibility: 0.58,
    requiredCapabilities: ['agents', 'reasoning', 'training_systems'],
    estimatedCost: 480_000_000,
    estimatedQuarters: 10,
    dependencies: ['tech_persistent_agent_economies', 'tech_sparse_expert_reasoning'],
    initialVisibility: 'company_private',
    rationale: 'Nexus already holds the compute and the reasoning capability; the missing piece is an environment that rewards planning.',
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/*  Tests                                                                      */
/* -------------------------------------------------------------------------- */

describe('research determinism', () => {
  it('produces identical projects and ledger rows for the same seed', () => {
    const a = makeState();
    const b = makeState();
    const ha = harness(QUARTER, '424242/research');
    const hb = harness(QUARTER, '424242/research');
    advanceProjects(a, ha.ctx);
    advanceProjects(b, hb.ctx);
    expect(JSON.stringify(b.researchProjects)).toBe(JSON.stringify(a.researchProjects));
    expect(JSON.stringify(hb.events)).toBe(JSON.stringify(ha.events));

    const c = makeState();
    advanceProjects(c, harness(QUARTER, '999999/research').ctx);
    expect(JSON.stringify(c.researchProjects)).not.toBe(JSON.stringify(a.researchProjects));
  });
});

describe('programme progress', () => {
  it('advances faster with more money, more compute and more researchers', () => {
    const lean = makeState();
    const rich = makeState();
    const target = project(rich, 'rsp_agora');
    target.budgetQuarterly *= 6;
    target.computeAllocated *= 6;
    target.talentAllocated *= 4;

    advanceProjects(lean, harness(QUARTER, '424242/research').ctx);
    advanceProjects(rich, harness(QUARTER, '424242/research').ctx);
    expect(project(rich, 'rsp_agora').progress).toBeGreaterThan(project(lean, 'rsp_agora').progress);
  });

  it('scores every resourcing input against the node it is chasing', () => {
    const state = makeState();
    const factors = resourcingFactors(state, project(state, 'rsp_agora'), node(state, 'tech_persistent_agent_economies'));
    expect(factors.funding).toBeGreaterThan(0);
    expect(factors.compute).toBeGreaterThan(0);
    expect(factors.talent).toBeGreaterThan(0);
    expect(factors.coverage).toBeCloseTo((0.42 + 0.88) / 2, 5);

    // Starving the same programme of researchers cannot make it faster.
    const starved = makeState();
    project(starved, 'rsp_agora').talentAllocated = 1;
    const starvedFactors = resourcingFactors(starved, project(starved, 'rsp_agora'), node(starved, 'tech_persistent_agent_economies'));
    expect(starvedFactors.talent).toBeLessThan(factors.talent);
  });

  it('spends money and time every quarter, and records cost against the estimate', () => {
    const state = makeState();
    const before = project(state, 'rsp_agora').cumulativeSpendUsd;
    advanceProjects(state, harness(QUARTER, '424242/research').ctx);
    const after = project(state, 'rsp_agora');
    expect(after.cumulativeSpendUsd).toBeGreaterThan(before + 31_000_000 - 1);
    expect(after.quartersElapsed).toBe(1);
  });
});

describe('node achievement', () => {
  it('raises company capabilities, publishes the node and bumps the graph version', () => {
    const state = makeState();
    const before = { ...company(state, 'cmp_meridian').techCapabilities };
    const version = state.techGraph.version;
    project(state, 'rsp_agora').progress = 1;

    const { ctx, events, lines } = harness(QUARTER, '424242/nodes');
    achieveNodes(state, ctx);

    const achieved = node(state, 'tech_persistent_agent_economies');
    expect(achieved.status).toBe('achieved');
    expect(achieved.achievedByCompanyId).toBe('cmp_meridian');
    expect(achieved.achievedQuarter).toBe(QUARTER);
    expect(achieved.publicConfidence).toBe(1);
    expect(project(state, 'rsp_agora').status).toBe('succeeded');

    const after = company(state, 'cmp_meridian').techCapabilities;
    expect(after['agents'] ?? 0).toBeGreaterThan(before['agents'] ?? 0);
    expect(after['data_curation'] ?? 0).toBeGreaterThan(before['data_curation'] ?? 0);
    expect(after['reasoning']).toBe(before['reasoning']);
    expect(state.techGraph.version).toBe(version + 1);

    // What it unlocks becomes more credible, without becoming true.
    expect(node(state, 'tech_autonomous_research').publicConfidence).toBeGreaterThan(0.09);
    expect(node(state, 'tech_autonomous_research').status).not.toBe('achieved');

    const event = events.find((e) => e.type === 'tech_node_achieved');
    expect(event?.visibility).toBe('public');
    expect(event?.payload['secret']).toBe(false);
    expect(lines.some((l) => l.refEventIds?.includes(event?.eventId ?? ''))).toBe(true);

    // Achievement raises the hazard of the family it belongs to.
    expect(state.eventHazards['fam_model_breakthrough']?.pendingDeltas.length ?? 0).toBeGreaterThan(0);
  });

  it('holds a finished programme at the line until its dependencies are achieved', () => {
    const state = makeState();
    // Autonomous research depends on sparse expert reasoning, which nobody has.
    state.researchProjects.push({
      id: 'rsp_autonomy',
      companyId: 'cmp_nexus',
      targetNodeId: 'tech_autonomous_research',
      budgetQuarterly: 900_000_000,
      computeAllocated: 200_000,
      talentAllocated: 400,
      progress: 1,
      internalConfidence: 0.8,
      quartersElapsed: 12,
      expectedQuarters: 14,
      isSecret: false,
      status: 'active',
      cumulativeSpendUsd: 9_000_000_000,
      setbacks: 1,
      startedQuarter: 0,
    });
    const { ctx, events } = harness(QUARTER, '424242/nodes');
    achieveNodes(state, ctx);

    expect(node(state, 'tech_autonomous_research').status).toBe('speculative');
    expect(project(state, 'rsp_autonomy').status).toBe('active');
    expect(project(state, 'rsp_autonomy').progress).toBeCloseTo(0.98, 5);
    const blocked = events.find((e) => e.payload['blockedByDependencies'] !== undefined);
    expect(blocked?.payload['blockedByDependencies']).toEqual(['tech_sparse_expert_reasoning']);
  });
});

describe('secrecy', () => {
  it('keeps a secret programme out of every public projection, even once it succeeds', () => {
    const state = makeState();
    project(state, 'rsp_lattice').progress = 1;
    const { ctx, events, lines } = harness(QUARTER, '424242/nodes');
    achieveNodes(state, ctx);

    const secretNode = node(state, 'tech_dense_scaling_saturation');
    // The company knows. The world does not.
    expect(project(state, 'rsp_lattice').status).toBe('succeeded');
    expect(secretNode.confidenceByCompany['cmp_nexus']).toBe(1);
    expect(secretNode.status).toBe('secret');
    expect(secretNode.publicConfidence).toBe(0.04);
    expect(secretNode.achievedByCompanyId).toBeNull();
    expect(secretNode.visibility).toBe('company_private');
    expect(company(state, 'cmp_nexus').techCapabilities['evaluation'] ?? 0).toBeGreaterThan(0.57);

    // Nothing about it reaches the ledger above `private`, or the report at all.
    const secretEvents = events.filter((e) => e.targetId === 'tech_dense_scaling_saturation');
    expect(secretEvents.length).toBeGreaterThan(0);
    expect(secretEvents.every((e) => e.visibility === 'private')).toBe(true);
    expect(lines.some((l) => l.text.includes('Dense Scaling Saturation'))).toBe(false);

    // And it is absent from what the world can see.
    expect(publicResearchProjects(state).some((p) => p.id === 'rsp_lattice')).toBe(false);
    expect(publicTechGraph(state.techGraph).nodes.some((n) => n.id === 'tech_dense_scaling_saturation')).toBe(false);
    expect(publicTechGraph(state.techGraph).nodes.every((n) => Object.keys(n.confidenceByCompany).length === 0)).toBe(true);
    expect(techGraphForCompany(state.techGraph, 'cmp_nexus').nodes.some((n) => n.id === 'tech_dense_scaling_saturation')).toBe(true);
    expect(techGraphForCompany(state.techGraph, 'cmp_meridian').nodes.some((n) => n.id === 'tech_dense_scaling_saturation')).toBe(false);
  });

  it('writes secret progress to the ledger privately and says nothing in the report', () => {
    const state = makeState();
    const { ctx, events, lines } = harness(QUARTER, '424242/research');
    advanceProjects(state, ctx);
    const secret = events.filter((e) => e.payload['projectId'] === 'rsp_lattice');
    expect(secret.length).toBeGreaterThan(0);
    expect(secret.every((e) => e.visibility === 'private')).toBe(true);
    expect(lines.some((l) => l.text.includes('Dense Scaling Saturation'))).toBe(false);
    // The public programme does get a line.
    expect(lines.some((l) => l.text.includes('Sparse Expert Reasoning'))).toBe(true);
  });

  it('surfaces a secret result only when the company publishes it', () => {
    const state = makeState();
    project(state, 'rsp_lattice').progress = 1;
    achieveNodes(state, harness(QUARTER, '424242/nodes').ctx);
    expect(node(state, 'tech_dense_scaling_saturation').status).toBe('secret');

    state.pendingActions.push({
      actionId: 'act_publish',
      sessionId: state.sessionId,
      quarter: QUARTER,
      sequence: 0,
      actorPlayerId: 'ply_01',
      actorCompanyId: 'cmp_nexus',
      actorCharacterId: 'chr_maya_chen',
      origin: 'player_ui',
      intent: { type: 'publish_research', nodeId: 'tech_dense_scaling_saturation', mode: 'paper', rationale: 'The curve is public property now.' },
      confirmedByHuman: true,
    });

    const { ctx, events } = harness(QUARTER, '424242/confidence');
    const updates = updateTechConfidence(state, ctx);
    const published = node(state, 'tech_dense_scaling_saturation');
    expect(published.status).toBe('achieved');
    expect(published.publicConfidence).toBe(1);
    expect(published.visibility).toBe('public');
    expect(project(state, 'rsp_lattice').isSecret).toBe(false);
    expect(publicResearchProjects(state).some((p) => p.id === 'rsp_lattice')).toBe(true);
    expect(company(state, 'cmp_nexus').reputation.developer).toBeGreaterThan(66);
    expect(events.some((e) => e.type === 'research_published' && e.visibility === 'public')).toBe(true);
    expect(updates.some((u) => u.nodeId === 'tech_dense_scaling_saturation' && u.newConfidence === 1)).toBe(true);
  });
});

describe('belief movement', () => {
  it('drifts toward the prior for the epistemic state and records what moved', () => {
    const state = makeState();
    const { ctx, events } = harness(QUARTER, '424242/confidence');
    const updates = updateTechConfidence(state, ctx);
    expect(updates.length).toBeGreaterThan(0);
    for (const update of updates) {
      expect(update.quarter).toBe(QUARTER);
      expect(update.newConfidence).toBeGreaterThanOrEqual(0);
      expect(update.newConfidence).toBeLessThanOrEqual(1);
      expect(update.reason.length).toBeGreaterThan(0);
    }
    // A speculative node with almost no confidence left falls further, not further up.
    const speculative = updates.find((u) => u.nodeId === 'tech_autonomous_research');
    expect(speculative).toBeDefined();
    expect(events.some((e) => e.type === 'tech_confidence_shifted')).toBe(true);
  });

  it('discredits a path whose confidence collapses and writes off a dead end', () => {
    const state = makeState();
    node(state, 'tech_autonomous_research').publicConfidence = 0.06;
    const first = updateTechConfidence(state, harness(QUARTER, '424242/confidence').ctx);
    expect(first.find((u) => u.nodeId === 'tech_autonomous_research')?.newStatus).toBe('discredited');

    node(state, 'tech_autonomous_research').publicConfidence = 0.02;
    const second = updateTechConfidence(state, harness(QUARTER + 1, '424242/confidence2').ctx);
    expect(second.find((u) => u.nodeId === 'tech_autonomous_research')?.newStatus).toBe('dead_end');
    expect(node(state, 'tech_autonomous_research').status).toBe('dead_end');
  });

  it('moves compute-hungry paths hardest when compute becomes expensive', () => {
    const state = makeState();
    state.activeEvents.push({
      id: 'wev_packaging_disruption',
      familyId: 'fam_compute_supply',
      type: 'compute_supply_shock',
      titleKey: 'advanced_packaging_disruption',
      title: 'Advanced packaging capacity disrupted',
      description: 'A fire at the largest advanced packaging plant has removed a fifth of global capacity for at least two quarters.',
      severity: 0.8,
      visibility: 'public',
      durationQuarters: 3,
      causalParentId: null,
      quarter: QUARTER,
      affectedSectorIds: ['semiconductors'],
      affectedCompanyIds: [],
    });
    const updates = updateTechConfidence(state, harness(QUARTER, '424242/confidence').ctx);
    const hungry = updates.find((u) => u.nodeId === 'tech_autonomous_research');
    const light = updates.find((u) => u.nodeId === 'tech_neuromorphic_substrates');
    expect(hungry).toBeDefined();
    const hungryMove = (hungry?.newConfidence ?? 0) - (hungry?.previousConfidence ?? 0);
    const lightMove = (light?.newConfidence ?? 0) - (light?.previousConfidence ?? 0);
    expect(hungryMove).toBeLessThan(lightMove);
    expect(hungry?.causeEventId).toBe('wev_packaging_disruption');
  });
});

describe('innovation proposals', () => {
  it('accepts a coherent proposal and credits its inventor on the graph', () => {
    const state = makeState();
    const proposal = baseProposal();
    state.pendingActions.push(proposalAction(state, 0, 'cmp_nexus', 'chr_maya_chen', proposal));
    const version = state.techGraph.version;
    const nodeCount = state.techGraph.nodes.length;

    const { ctx, events, lines } = harness(QUARTER, '424242/innovation');
    const result = integrateInnovationProposal(state, proposal, ctx);

    expect(result.accepted).toBe(true);
    expect(result.nodeId).not.toBeNull();
    expect(result.reasons.length).toBeGreaterThan(0);
    expect(state.techGraph.nodes).toHaveLength(nodeCount + 1);
    expect(state.techGraph.version).toBe(version + 1);

    const created = node(state, result.nodeId ?? '');
    expect(created.status).toBe('company_thesis');
    expect(created.visibility).toBe('company_private');
    expect(created.originalProposerId).toBe('chr_maya_chen');
    expect(created.dependencies).toEqual(['tech_persistent_agent_economies', 'tech_sparse_expert_reasoning']);
    expect(created.confidenceByCompany['cmp_nexus'] ?? 0).toBeGreaterThan(0);
    expect(created.publicConfidence).toBeLessThan(0.1);
    expect(created.createdQuarter).toBe(QUARTER);
    expect(state.techGraph.edges.filter((e) => e.to === created.id)).toHaveLength(2);

    // The engine costs it for itself, and never below its own floor.
    expect(result.adjustedCostUsd).toBeGreaterThanOrEqual(proposal.estimatedCost);
    expect(result.adjustedQuarters).toBeGreaterThanOrEqual(proposal.estimatedQuarters);
    expect(events.some((e) => e.type === 'tech_node_added' && e.visibility === 'company')).toBe(true);
    expect(lines.every((l) => (l.refEventIds ?? []).length > 0)).toBe(true);
  });

  it('announces a public thesis to the world', () => {
    const state = makeState();
    const proposal = baseProposal({ initialVisibility: 'public' });
    state.pendingActions.push(proposalAction(state, 0, 'cmp_nexus', 'chr_maya_chen', proposal));
    const result = integrateInnovationProposal(state, proposal, harness(QUARTER, '424242/innovation').ctx);
    expect(result.accepted).toBe(true);
    const created = node(state, result.nodeId ?? '');
    expect(created.visibility).toBe('public');
    expect(created.publicConfidence).toBeGreaterThan(0.05);
    expect(publicTechGraph(state.techGraph).nodes.some((n) => n.id === created.id)).toBe(true);
  });

  it('refuses a proposal that rests on nothing in this world', () => {
    const state = makeState();
    const proposal = baseProposal({ dependencies: ['tech_that_does_not_exist'] });
    state.pendingActions.push(proposalAction(state, 0, 'cmp_nexus', 'chr_maya_chen', proposal));
    const { ctx, events } = harness(QUARTER, '424242/innovation');
    const result = integrateInnovationProposal(state, proposal, ctx);
    expect(result.accepted).toBe(false);
    expect(result.nodeId).toBeNull();
    expect(result.reasons.join(' ')).toContain('Frontier Map');
    expect(state.techGraph.nodes.some((n) => n.title === proposal.title)).toBe(false);
    expect(events.some((e) => e.type === 'action_rejected')).toBe(true);
  });

  it('refuses a duplicate of a node the map already carries', () => {
    const state = makeState();
    const proposal = baseProposal({ title: 'Efficient Sparse Inference', dependencies: [] });
    state.pendingActions.push(proposalAction(state, 0, 'cmp_nexus', 'chr_maya_chen', proposal));
    const result = integrateInnovationProposal(state, proposal, harness(QUARTER, '424242/innovation').ctx);
    expect(result.accepted).toBe(false);
    expect(result.reasons.join(' ')).toContain('already carries');
  });

  it('refuses a programme far beyond anything the company could reach', () => {
    const state = makeState();
    const proposal = baseProposal({ estimatedCost: 900_000_000_000, dependencies: ['tech_sparse_expert_reasoning'] });
    state.pendingActions.push(proposalAction(state, 0, 'cmp_meridian', 'chr_kenji_watanabe', proposal));
    const result = integrateInnovationProposal(state, proposal, harness(QUARTER, '424242/innovation').ctx);
    expect(result.accepted).toBe(false);
    expect(result.reasons.join(' ')).toContain('times everything');
  });

  it('refuses everything when the session does not allow player innovation', () => {
    const state = makeState();
    state.config.allowPlayerInnovation = false;
    const proposal = baseProposal();
    state.pendingActions.push(proposalAction(state, 0, 'cmp_nexus', 'chr_maya_chen', proposal));
    const result = integrateInnovationProposal(state, proposal, harness(QUARTER, '424242/innovation').ctx);
    expect(result.accepted).toBe(false);
    expect(result.reasons.join(' ')).toContain('does not allow');
  });

  it('is deterministic and leaves the aggregate schema-valid', () => {
    const a = makeState();
    const b = makeState();
    const proposal = baseProposal();
    a.pendingActions.push(proposalAction(a, 0, 'cmp_nexus', 'chr_maya_chen', proposal));
    b.pendingActions.push(proposalAction(b, 0, 'cmp_nexus', 'chr_maya_chen', proposal));
    integrateInnovationProposal(a, proposal, harness(QUARTER, '424242/innovation').ctx);
    integrateInnovationProposal(b, proposal, harness(QUARTER, '424242/innovation').ctx);
    expect(JSON.stringify(b.techGraph)).toBe(JSON.stringify(a.techGraph));
    expect(() => SessionStateSchema.parse(a)).not.toThrow();
  });
});

describe('full research phase', () => {
  it('runs advance, achieve and belief in order and stays schema-valid over eight quarters', () => {
    const state = makeState();
    for (let i = 0; i < 8; i += 1) {
      const quarter = QUARTER + i;
      state.quarter = quarter;
      advanceProjects(state, harness(quarter, `424242/q${quarter}/advance`).ctx);
      achieveNodes(state, harness(quarter, `424242/q${quarter}/achieve`).ctx);
      const updates = updateTechConfidence(state, harness(quarter, `424242/q${quarter}/belief`).ctx);
      for (const update of updates) {
        expect(update.newConfidence).toBeGreaterThanOrEqual(0);
        expect(update.newConfidence).toBeLessThanOrEqual(1);
      }
      for (const p of state.researchProjects) {
        expect(p.progress).toBeGreaterThanOrEqual(0);
        expect(p.progress).toBeLessThanOrEqual(1);
      }
    }
    expect(() => SessionStateSchema.parse(state)).not.toThrow();
    expect(state.techGraph.version).toBeGreaterThan(4);
  });
});
