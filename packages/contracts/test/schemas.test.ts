import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  CharacterReplySchema,
  ChiefOfStaffInterpretationSchema,
  DealExtractionSchema,
  DealProposalDraftSchema,
  GmProposalBatchSchema,
  GovernmentBidSchema,
  MemoryDraftSchema,
  NarratorOutputSchema,
  SocialPostDraftSchema,
  WorldModifierProposalSchema,
} from '../src/index';

import {
  ACTION_TYPES,
  ActionIntentSchema,
  BALANCE_SHEET_TOLERANCE_USD,
  CONFIRMATION_REQUIRED_ACTIONS,
  requiresExplicitConfirmation,
  CONNECTION_GAP_RULE,
  CONTRACTS_VERSION,
  CapTableSchema,
  CompanySchema,
  ConditionalCommitmentSchema,
  DEFAULT_EVALUATION_WEIGHTS,
  DEFAULT_IMPACT_BUDGET,
  DealObligationSchema,
  EvaluationWeightsSchema,
  FOUNDER_INDEX_WEIGHTS,
  GmEventProposalSchema,
  InnovationProposalSchema,
  NpcActionBundleSchema,
  OWNERSHIP_THRESHOLDS,
  PATTERN_TARGET_PATHS,
  RESOLUTION_PHASES,
  SessionStateSchema,
  TECH_EPISTEMIC_STATES,
  WORLD_TARGET_PATHS,
  WORLD_DOMAIN_KEYS,
  WorldStateSchema,
  balanceSheetReconciles,
  canInitiateContact,
  commitmentConditionsHold,
  founderIndex,
  getTargetPathSpec,
  isLegalTargetPath,
  makeId,
  ownershipThresholdFor,
  quarterLabel,
  returnDecompositionSums,
  targetPathEntityId,
  type ActionIntent,
  type BalanceSheet,
  type Company,
  type SessionStateInput,
  type WorldState,
} from '../src/index';

/* -------------------------------------------------------------------------- */
/*  Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

const world: WorldState = {
  macro: {
    gdpGrowth: 0.024,
    inflation: 0.031,
    policyRate: 0.0525,
    unemployment: 0.042,
    creditSpreads: 0.018,
    fxVolatility: 0.28,
    consumerDemand: 0.55,
  },
  capitalMarkets: {
    riskAppetite: 0.62,
    ipoWindow: 0.48,
    ventureLiquidity: 0.57,
    sectorMultiples: 1.35,
    volatility: 0.36,
    debtAvailability: 0.61,
  },
  compute: {
    acceleratorSupply: 0.44,
    cloudCapacity: 0.51,
    spotPrice: 1.24,
    reservedPrice: 1.08,
    fabCapacity: 0.47,
    energyDemand: 0.63,
  },
  energy: {
    electricityPrice: 1.12,
    datacentreAccess: 0.42,
    renewableCapacity: 0.38,
    gridConstraint: 0.66,
  },
  aiFrontier: {
    frontierCapability: 0.61,
    inferenceCost: 0.72,
    trainingEfficiency: 0.55,
    openSourceGap: 0.31,
    benchmarkSaturation: 0.74,
  },
  talent: {
    researcherSupply: 0.29,
    engineerSupply: 0.48,
    salaryPressure: 1.4,
    immigrationAccess: 0.53,
  },
  dataDomain: {
    dataAvailability: 0.49,
    licensingCost: 1.6,
    privacyRestriction: 0.58,
    syntheticDataMaturity: 0.44,
  },
  society: {
    aiTrust: 0.41,
    automationAnxiety: 0.67,
    consumerSentiment: 0.52,
    developerSentiment: 0.64,
  },
  regulation: {
    modelRules: 0.46,
    privacy: 0.6,
    antitrust: 0.39,
    copyright: 0.52,
    safetyObligations: 0.44,
    exportControls: 0.71,
  },
  government: {
    procurementBudget: 0.58,
    defenceUrgency: 0.69,
    digitalModernisation: 0.47,
    grantFunding: 0.36,
  },
  geopolitics: {
    tradeFriction: 0.62,
    conflictRisk: 0.34,
    sanctions: 0.48,
    techCompetition: 0.78,
  },
  media: {
    attentionLevel: 0.72,
    institutionalTrust: 0.38,
    controversyIntensity: 0.55,
    dominantNarrative: 'geopolitical_race',
  },
};

const balanceSheet: BalanceSheet = {
  assets: { cash: 6_100_000_000, ppe: 2_400_000_000, goodwill: 300_000_000, investments: 450_000_000, receivables: 250_000_000 },
  liabilities: { debt: 1_800_000_000, payables: 220_000_000, deferredRevenue: 180_000_000 },
  equity: 7_300_000_000,
};

const company: Company = {
  id: 'cmp_orbit',
  name: 'Orbit Intelligence',
  ticker: 'ORBT',
  archetype: 'frontier_lab',
  tier: 'major',
  isPublic: true,
  controllerPlayerId: 'ply_01',
  sectorId: 'frontier_models',
  foundedQuarter: 0,
  headquartersCity: 'Zurich',
  isActive: true,
  products: [
    {
      id: 'prd_enterprise_agent',
      name: 'Orbit Enterprise Agent',
      segment: 'enterprise',
      pricePerSeat: 38,
      activeCustomers: 412_000,
      churnQuarterly: 0.045,
      growthQuarterly: 0.13,
      grossMarginPct: 0.61,
      computeIntensity: 0.54,
      qualityScore: 0.72,
      launchedQuarter: 3,
      isActive: true,
    },
  ],
  employees: {
    engineers: 2_100,
    researchers: 640,
    sales: 880,
    ops: 540,
    execs: 21,
    avgComp: 285_000,
    morale: 68,
    attrition: 0.06,
    openRoles: 140,
  },
  compute: {
    ownedAccelerators: 48_000,
    reservedAccelerators: 12_000,
    reservationExpiryQuarter: 12,
    cloudSpendQuarterly: 220_000_000,
    computeUtilisation: 0.86,
    trainingAllocation: 0.55,
  },
  offices: [{ id: 'off_zrh', city: 'Zurich', headcountCapacity: 3_000, quarterlyCostUsd: 24_000_000, openedQuarter: 0, isHeadquarters: true }],
  financials: {
    revenueQuarterly: 2_800_000_000,
    cogs: 1_090_000_000,
    payroll: 780_000_000,
    marketing: 210_000_000,
    rdSpend: 640_000_000,
    capex: 900_000_000,
    interestExpense: 46_000_000,
    cash: 6_100_000_000,
    debt: 1_800_000_000,
    quarterlyBurn: -180_000_000,
    deferredRevenue: 180_000_000,
    backlogUsd: 3_400_000_000,
  },
  balanceSheet,
  posture: 'balanced',
  riskTolerance: 0.58,
  techCapabilities: { reasoning: 0.78, agents: 0.66, efficiency: 0.71, evaluation: 0.6 },
  governmentPastPerformance: 74,
  reputation: { public: 61, developer: 77, enterprise: 69, government: 72, investor: 65 },
  boardId: 'brd_orbit',
  primarySecurityId: 'sec_orbit_common',
  instrumentId: 'ins_orbit_eq',
  ceoCharacterId: 'chr_player_founder',
  parentCompanyId: null,
};

const minimalSessionState: SessionStateInput = {
  sessionId: 'sess_001',
  seed: 'seed_frontier_001',
  quarter: 7,
  startYear: 2029,
  status: 'active',
  config: {
    playerCount: 1,
    difficulty: 'standard',
    majorRivalCount: 5,
    significantCompanyCount: 24,
    backgroundCompanyCount: 180,
    scenarioId: 'compute_crunch_2031',
    startYear: 2029,
    quarterLimit: null,
    enableReferenceMarket: true,
    allowPlayerInnovation: true,
    autoExecuteRoutineDefault: false,
  },
  world,
  sectors: {
    frontier_models: { sectorId: 'frontier_models', sentiment: 0.22, multiple: 1.4, demand: 0.62, volatility: 0.44 },
    semiconductors: { sectorId: 'semiconductors', sentiment: -0.11, multiple: 1.15, demand: 0.58, volatility: 0.38 },
  },
  eventHazards: {
    fam_compute_supply: {
      familyId: 'fam_compute_supply',
      baseHazard: 0.12,
      currentHazard: 0.24,
      cooldownRemaining: 0,
      lastFiredQuarter: null,
      pendingDeltas: [{ amount: 0.12, remainingQuarters: 3, sourceEventId: 'wev_export_control_q5' }],
    },
  },
  techGraph: {
    version: 1,
    sessionId: 'sess_001',
    nodes: [],
    edges: [],
    updatedQuarter: 7,
  },
};

const gmProposal = {
  event: {
    candidateId: 'cand_q7_compute_1',
    familyId: 'fam_compute_supply',
    type: 'compute_supply_shock' as const,
    titleKey: 'advanced_packaging_disruption',
    title: 'Advanced packaging capacity disrupted',
    description:
      'A fire at a leading advanced-packaging facility has removed a material share of global capacity for at least two quarters. Accelerator vendors have begun reallocating allocations toward their largest committed customers, and smaller buyers report quotes rising sharply.',
    severity: 0.63,
    visibility: 'public' as const,
    durationQuarters: 3,
    causalParentId: null,
    affectedSectorIds: ['semiconductors', 'frontier_models'],
  },
  modifiers: [
    {
      target: 'world.compute.acceleratorSupply',
      operation: 'multiply' as const,
      value: 0.84,
      decay: 'linear' as const,
      durationQuarters: 3,
      reason: 'Lost packaging capacity removes roughly a sixth of usable accelerator supply.',
    },
    {
      target: 'world.compute.spotPrice',
      operation: 'multiply' as const,
      value: 1.24,
      decay: 'linear' as const,
      durationQuarters: 3,
      reason: 'Scarcity is felt first in the spot market.',
    },
    {
      target: 'sector.semiconductors.sentiment',
      operation: 'add' as const,
      value: 0.11,
      decay: 'exponential' as const,
      durationQuarters: 2,
      reason: 'Investors read constrained supply as pricing power for incumbents.',
    },
  ],
  rationale:
    'Compute supply is already tight at 0.44 and export controls are elevated, so a physical supply shock is both plausible and consequential. Three modifiers trace one causal chain: capacity falls, spot prices rise, and the semiconductor sector reprices upward on scarcity.',
  confidence: 0.78,
};

const innovationProposal = {
  nodeType: 'player_hypothesis' as const,
  title: 'Mass Multi-Agent World Learning',
  summary:
    'Persistent simulated environments in which millions of agents learn economic behaviour together, producing transferable policies for negotiation, pricing and coordination that no single-agent training run reaches.',
  novelty: 0.82,
  plausibility: 0.63,
  requiredCapabilities: ['agent_simulation', 'reinforcement_learning', 'large_scale_compute'],
  estimatedCost: 280_000_000,
  estimatedQuarters: 10,
  dependencies: ['tech_tool_learning', 'tech_long_horizon_planning'],
  initialVisibility: 'company_private' as const,
  rationale: 'We already lead on agents and evaluation, and a compute shortage rewards approaches that get more from simulation than from raw scale.',
};

const conditionalCommitment = {
  actorCharacterId: 'chr_sarah_zhou',
  proposalKind: 'acquisition' as const,
  stance: 'support' as const,
  conditions: [
    { field: 'purchasePriceUsd' as const, comparator: 'lte' as const, value: 5_500_000_000 },
    { field: 'stockComponentPct' as const, comparator: 'gte' as const, value: 0.35 },
  ],
  commitmentStrength: 0.86,
  expiresQuarter: 10,
  targetCompanyId: 'cmp_vector',
  rationale: 'Their enterprise retention is deteriorating and at $6.4bn you are paying for projected synergies.',
};

const actionFixtures: ActionIntent[] = [
  { type: 'set_research_budget', budgetUsd: 42_000_000 },
  { type: 'hire', role: 'engineers', count: 17, compBand: 'above_market' },
  { type: 'reserve_compute', units: 12_000, quarters: 4, maxPricePerUnitUsd: 2_400 },
  { type: 'buy_shares', securityId: 'sec_nexus_common', targetPct: 0.03, shares: null, maxPricePerShareUsd: 84.5 },
  { type: 'poach_executive', targetCharacterId: 'chr_helix_infra_lead', compPremiumPct: 0.2, approach: 'private' },
  { type: 'propose_innovation', proposal: innovationProposal },
  {
    type: 'social_post',
    draft: {
      authorCharacterId: 'chr_player_founder',
      network: 'technical_forum',
      text: 'Our new model is open-weight. Developers should own the tools they build on.',
      intent: 'announce',
      targetCompanyId: null,
    },
  },
  {
    type: 'acquire_company',
    targetCompanyId: 'cmp_vector',
    offerValueUsd: 5_400_000_000,
    cashPct: 0.6,
    stockPct: 0.4,
  },
];

/* -------------------------------------------------------------------------- */
/*  Valid fixtures parse                                                       */
/* -------------------------------------------------------------------------- */

describe('valid fixtures parse', () => {
  it('parses a World Director proposal exactly as the model returns it', () => {
    const parsed = GmEventProposalSchema.parse(gmProposal);
    expect(parsed.event.titleKey).toBe('advanced_packaging_disruption');
    expect(parsed.modifiers).toHaveLength(3);
  });

  it('parses the full world state with all twelve domains', () => {
    const parsed = WorldStateSchema.parse(world);
    expect(Object.keys(parsed).sort()).toEqual([...WORLD_DOMAIN_KEYS].sort());
    expect(WORLD_DOMAIN_KEYS).toHaveLength(12);
  });

  it('parses a company and reconciles its balance sheet', () => {
    const parsed = CompanySchema.parse(company);
    expect(parsed.ticker).toBe('ORBT');
    expect(balanceSheetReconciles(parsed.balanceSheet, BALANCE_SHEET_TOLERANCE_USD)).toBe(true);
  });

  it('parses a minimal session state and fills collection defaults', () => {
    const parsed = SessionStateSchema.parse(minimalSessionState);
    expect(parsed.companies).toEqual([]);
    expect(parsed.pendingActions).toEqual([]);
    expect(parsed.leaderboards).toEqual([]);
    expect(parsed.ledgerSequence).toBe(0);
    expect(parsed.lastResolvedQuarter).toBeNull();
    expect(parsed.quoteHistoryQuarters).toBe(24);
    expect(parsed.world.compute.spotPrice).toBeCloseTo(1.24);
  });

  it('parses a conditional commitment produced by a director conversation', () => {
    const parsed = ConditionalCommitmentSchema.parse(conditionalCommitment);
    expect(parsed.conditions).toHaveLength(2);
    expect(parsed.commitmentStrength).toBeCloseTo(0.86);
  });

  it('parses an innovation proposal', () => {
    const parsed = InnovationProposalSchema.parse(innovationProposal);
    expect(parsed.nodeType).toBe('player_hypothesis');
    expect(parsed.initialVisibility).toBe('company_private');
  });

  it('parses every action intent variant in the fixture set', () => {
    expect(actionFixtures.length).toBeGreaterThanOrEqual(5);
    for (const action of actionFixtures) {
      expect(() => ActionIntentSchema.parse(action)).not.toThrow();
    }
  });

  it('parses an NPC action bundle containing nested intents', () => {
    const bundle = NpcActionBundleSchema.parse({
      companyId: 'cmp_nexus_ai',
      strategySummary: 'Secure compute ahead of the shortage and fund it with a large private round before valuations reset.',
      posture: 'aggressive_growth',
      actions: [
        { type: 'reserve_compute', units: 45_000, quarters: 4, maxPricePerUnitUsd: 3_100 },
        { type: 'raise_round', stage: 'series_d', targetAmountUsd: 1_200_000_000, maxDilutionPct: 0.16 },
      ],
      rationale: 'Accelerator supply is at 0.44 and falling. Locking capacity now is worth accepting dilution at this valuation.',
    });
    expect(bundle.actions).toHaveLength(2);
  });

  it('parses each deal obligation variant', () => {
    const obligations = [
      { kind: 'compute_supply', units: 10_000, quarters: 2 },
      { kind: 'tech_license', techNodeId: 'tech_retrieval_v3', productId: null, quarters: 4 },
      { kind: 'cash_payment', amount: 250_000_000 },
      { kind: 'equity_transfer', securityId: 'sec_orbit_common', shares: 1_200_000 },
      { kind: 'board_vote_pledge', proposalKind: 'acquisition', stance: 'support', quarters: 3 },
      { kind: 'public_endorsement', statement: 'We support the sovereign inference standard.', quarters: 2 },
      { kind: 'consortium_membership', opportunityId: 'opp_sovereign_platform' },
      { kind: 'investment', amount: 400_000_000, securityId: 'sec_vector_preferred' },
    ];
    for (const o of obligations) {
      expect(() => DealObligationSchema.parse(o)).not.toThrow();
    }
  });
});

/* -------------------------------------------------------------------------- */
/*  Invalid fixtures fail                                                      */
/* -------------------------------------------------------------------------- */

describe('invalid fixtures fail', () => {
  it('rejects a GM proposal with out-of-range severity', () => {
    const bad = { ...gmProposal, event: { ...gmProposal.event, severity: 1.7 } };
    expect(GmEventProposalSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects a GM proposal with an upper-case titleKey', () => {
    const bad = { ...gmProposal, event: { ...gmProposal.event, titleKey: 'Advanced Packaging' } };
    expect(GmEventProposalSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects a GM proposal whose modifier duration exceeds twelve quarters', () => {
    const first = gmProposal.modifiers[0];
    expect(first).toBeDefined();
    const bad = { ...gmProposal, modifiers: [{ ...first!, durationQuarters: 40 }] };
    expect(GmEventProposalSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects an unknown action type', () => {
    expect(ActionIntentSchema.safeParse({ type: 'seize_competitor', targetCompanyId: 'cmp_vector' }).success).toBe(false);
  });

  it('rejects a hire action with a fractional headcount', () => {
    expect(ActionIntentSchema.safeParse({ type: 'hire', role: 'engineers', count: 4.5, compBand: 'market' }).success).toBe(false);
  });

  it('rejects a hire action with an unknown role', () => {
    expect(ActionIntentSchema.safeParse({ type: 'hire', role: 'lawyers', count: 4, compBand: 'market' }).success).toBe(false);
  });

  it('rejects a company with a reputation score above 100', () => {
    const bad = { ...company, reputation: { ...company.reputation, developer: 140 } };
    expect(CompanySchema.safeParse(bad).success).toBe(false);
  });

  it('rejects a company with negative cash', () => {
    const bad = { ...company, financials: { ...company.financials, cash: -1 } };
    expect(CompanySchema.safeParse(bad).success).toBe(false);
  });

  it('rejects a session state missing a world domain', () => {
    const { media: _media, ...partialWorld } = world;
    const bad = { ...minimalSessionState, world: partialWorld };
    expect(SessionStateSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects a conditional commitment with an unknown field', () => {
    const bad = { ...conditionalCommitment, conditions: [{ field: 'vibes', comparator: 'lte', value: 1 }] };
    expect(ConditionalCommitmentSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects an innovation proposal with plausibility outside 0..1', () => {
    const bad = { ...innovationProposal, plausibility: 1.4 };
    expect(InnovationProposalSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects an innovation proposal that omits a required field', () => {
    const { rationale: _rationale, ...bad } = innovationProposal;
    expect(InnovationProposalSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects an NPC bundle with more than eight actions', () => {
    const bad = {
      companyId: 'cmp_nexus_ai',
      strategySummary: 'Do everything at once, which is exactly what the cap exists to prevent.',
      posture: 'balanced',
      actions: Array.from({ length: 9 }, () => ({ type: 'set_research_budget', budgetUsd: 1_000_000 })),
      rationale: 'A bundle this scattered should not be accepted by the schema in the first place.',
    };
    expect(NpcActionBundleSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects a social post longer than 560 characters', () => {
    const bad: unknown = {
      type: 'social_post',
      draft: {
        authorCharacterId: 'chr_player_founder',
        network: 'fast_feed',
        text: 'x'.repeat(561),
        intent: 'hype',
        targetCompanyId: null,
      },
    };
    expect(ActionIntentSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects a deal obligation with an unknown kind', () => {
    expect(DealObligationSchema.safeParse({ kind: 'handshake', quarters: 2 }).success).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/*  Constants and invariants                                                   */
/* -------------------------------------------------------------------------- */

describe('constants and invariants', () => {
  it('FOUNDER_INDEX_WEIGHTS sums to exactly 1', () => {
    const total = Object.values(FOUNDER_INDEX_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(1, 10);
  });

  it('founderIndex returns 1 when every percentile is 1', () => {
    expect(
      founderIndex({
        wealth: 1,
        enterprise: 1,
        innovation: 1,
        reputation: 1,
        network: 1,
        government: 1,
        financialResilience: 1,
        sessionObjectives: 1,
      }),
    ).toBeCloseTo(1, 10);
  });

  it('the default evaluation weights sum to 1 and parse', () => {
    const total =
      DEFAULT_EVALUATION_WEIGHTS.technical +
      DEFAULT_EVALUATION_WEIGHTS.security +
      DEFAULT_EVALUATION_WEIGHTS.pastPerformance +
      DEFAULT_EVALUATION_WEIGHTS.priceRealism +
      DEFAULT_EVALUATION_WEIGHTS.schedule +
      DEFAULT_EVALUATION_WEIGHTS.domesticSupply +
      DEFAULT_EVALUATION_WEIGHTS.responsibleAi;
    expect(total).toBeCloseTo(1, 10);
    expect(EvaluationWeightsSchema.safeParse(DEFAULT_EVALUATION_WEIGHTS).success).toBe(true);
  });

  it('rejects evaluation weights that do not sum to 1', () => {
    const bad = { ...DEFAULT_EVALUATION_WEIGHTS, technical: 0.5 };
    expect(EvaluationWeightsSchema.safeParse(bad).success).toBe(false);
  });

  it('lists the eighteen resolution phases in pipeline order', () => {
    expect(RESOLUTION_PHASES).toHaveLength(18);
    expect(RESOLUTION_PHASES[0]).toBe('world_events');
    expect(RESOLUTION_PHASES[1]).toBe('gm_modifiers');
    expect(RESOLUTION_PHASES[RESOLUTION_PHASES.length - 2]).toBe('ledger_commit');
    expect(RESOLUTION_PHASES[RESOLUTION_PHASES.length - 1]).toBe('snapshot');
  });

  it('lists exactly the nine technology epistemic states', () => {
    expect(TECH_EPISTEMIC_STATES).toEqual([
      'established',
      'emerging',
      'forecast',
      'speculative',
      'company_thesis',
      'secret',
      'discredited',
      'achieved',
      'dead_end',
    ]);
  });

  it('exposes ownership thresholds in ascending order', () => {
    const pcts = OWNERSHIP_THRESHOLDS.map((t) => t.pct);
    expect(pcts).toEqual([...pcts].sort((a, b) => a - b));
    expect(ownershipThresholdFor(0.03)).toBeNull();
    expect(ownershipThresholdFor(0.07)?.label).toBe('significant_holder_disclosure');
    expect(ownershipThresholdFor(0.26)?.label).toBe('blocking_stake');
    expect(ownershipThresholdFor(0.62)?.label).toBe('control');
  });

  it('has a sane default impact budget', () => {
    expect(DEFAULT_IMPACT_BUDGET.maxEventsPerQuarter).toBeGreaterThan(0);
    expect(DEFAULT_IMPACT_BUDGET.maxSingleModifierMagnitude).toBeLessThan(1);
  });

  it('pins the contracts version', () => {
    expect(CONTRACTS_VERSION).toBe('1.0.0');
  });

  it('ACTION_TYPES matches the discriminated union exactly', () => {
    const fromUnion = Array.from(ActionIntentSchema.options).map((option) => {
      const literal = option.shape.type;
      return literal.value;
    });
    expect([...ACTION_TYPES].sort()).toEqual([...fromUnion].sort());
    expect(new Set(ACTION_TYPES).size).toBe(ACTION_TYPES.length);
    for (const t of CONFIRMATION_REQUIRED_ACTIONS) {
      expect(ACTION_TYPES).toContain(t);
      expect(requiresExplicitConfirmation(t)).toBe(true);
    }
    expect(requiresExplicitConfirmation('set_research_budget')).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/*  Target path registry                                                       */
/* -------------------------------------------------------------------------- */

describe('modifier target registry', () => {
  it('registers every world path with bounds where min is below max', () => {
    const specs = Object.values(WORLD_TARGET_PATHS);
    expect(specs.length).toBeGreaterThan(50);
    for (const spec of specs) {
      expect(spec.min).toBeLessThan(spec.max);
      expect(spec.operations.length).toBeGreaterThan(0);
    }
  });

  it('accepts the paths used by the World Director fixture', () => {
    for (const m of gmProposal.modifiers) {
      expect(isLegalTargetPath(m.target)).toBe(true);
    }
  });

  it('rejects an unregistered path', () => {
    expect(isLegalTargetPath('world.compute.magicSupply')).toBe(false);
    expect(getTargetPathSpec('world.compute.magicSupply')).toBeNull();
  });

  it('resolves sector and company pattern paths to their entity', () => {
    expect(targetPathEntityId('sector.semiconductors.sentiment')).toEqual({ entity: 'sector', id: 'semiconductors', metric: 'sentiment' });
    expect(targetPathEntityId('company.cmp_orbit.reputationPublic')).toEqual({ entity: 'company', id: 'cmp_orbit', metric: 'reputationPublic' });
    expect(targetPathEntityId('world.macro.inflation')).toBeNull();
    expect(PATTERN_TARGET_PATHS.length).toBeGreaterThan(0);
  });

  it('never allows a reference-market path', () => {
    expect(isLegalTargetPath('market.reference.NVDA.price')).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/*  LLM-facing schema discipline                                               */
/* -------------------------------------------------------------------------- */

interface LooseDef {
  typeName: string;
  shape?: () => Record<string, z.ZodTypeAny>;
  type?: z.ZodTypeAny;
  innerType?: z.ZodTypeAny;
  schema?: z.ZodTypeAny;
  keyType?: z.ZodTypeAny;
  valueType?: z.ZodTypeAny;
  options?: readonly z.ZodTypeAny[] | Map<string, z.ZodTypeAny>;
  items?: readonly z.ZodTypeAny[];
}

/** Walk a zod schema tree and collect every `typeName` it contains. */
function collectTypeNames(schema: z.ZodTypeAny, out: Set<string> = new Set(), depth = 0): Set<string> {
  if (depth > 40) return out;
  const def = schema._def as unknown as LooseDef;
  out.add(def.typeName);

  if (typeof def.shape === 'function') {
    for (const child of Object.values(def.shape())) collectTypeNames(child, out, depth + 1);
  }
  for (const key of ['type', 'innerType', 'schema', 'keyType', 'valueType'] as const) {
    const child = def[key];
    if (child) collectTypeNames(child, out, depth + 1);
  }
  if (def.options) {
    const opts = def.options instanceof Map ? Array.from(def.options.values()) : def.options;
    for (const opt of opts) collectTypeNames(opt, out, depth + 1);
  }
  if (def.items) {
    for (const item of def.items) collectTypeNames(item, out, depth + 1);
  }
  return out;
}

const LLM_FACING_SCHEMAS: ReadonlyArray<readonly [string, z.ZodTypeAny]> = [
  ['GmEventProposalSchema', GmEventProposalSchema],
  ['GmProposalBatchSchema', GmProposalBatchSchema],
  ['WorldModifierProposalSchema', WorldModifierProposalSchema],
  ['ActionIntentSchema', ActionIntentSchema],
  ['NpcActionBundleSchema', NpcActionBundleSchema],
  ['ChiefOfStaffInterpretationSchema', ChiefOfStaffInterpretationSchema],
  ['InnovationProposalSchema', InnovationProposalSchema],
  ['ConditionalCommitmentSchema', ConditionalCommitmentSchema],
  ['CharacterReplySchema', CharacterReplySchema],
  ['MemoryDraftSchema', MemoryDraftSchema],
  ['SocialPostDraftSchema', SocialPostDraftSchema],
  ['GovernmentBidSchema', GovernmentBidSchema],
  ['DealProposalDraftSchema', DealProposalDraftSchema],
  ['DealObligationSchema', DealObligationSchema],
  ['DealExtractionSchema', DealExtractionSchema],
  ['NarratorOutputSchema', NarratorOutputSchema],
];

describe('LLM-facing schemas stay compatible with structured outputs', () => {
  it.each(LLM_FACING_SCHEMAS.map(([name, schema]) => ({ name, schema })))(
    '$name contains no optional, record, transform or default node',
    ({ schema }) => {
      const names = collectTypeNames(schema);
      expect(names.has('ZodOptional')).toBe(false);
      expect(names.has('ZodRecord')).toBe(false);
      expect(names.has('ZodEffects')).toBe(false);
      expect(names.has('ZodDefault')).toBe(false);
      expect(names.has('ZodMap')).toBe(false);
      expect(names.has('ZodSet')).toBe(false);
      expect(names.has('ZodFunction')).toBe(false);
      expect(names.has('ZodAny')).toBe(false);
    },
  );

  it('every LLM-facing object field is required at the type level', () => {
    // A required-but-nullable field parses `null`; an optional field parses `undefined`.
    // The distinction matters because structured outputs must always emit the key.
    expect(SocialPostDraftSchema.safeParse({
      authorCharacterId: 'chr_a',
      network: 'fast_feed',
      text: 'hello',
      intent: 'announce',
      targetCompanyId: null,
    }).success).toBe(true);
    expect(SocialPostDraftSchema.safeParse({
      authorCharacterId: 'chr_a',
      network: 'fast_feed',
      text: 'hello',
      intent: 'announce',
    }).success).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/*  Pure helpers                                                               */
/* -------------------------------------------------------------------------- */

describe('pure helpers', () => {
  it('applies the connection gap rule symmetrically inside ten points', () => {
    expect(CONNECTION_GAP_RULE.symmetricGap).toBe(10);
    expect(canInitiateContact(72, 68)).toBe(true);
    expect(canInitiateContact(68, 72)).toBe(true);
    expect(canInitiateContact(17, 93)).toBe(false);
    expect(canInitiateContact(93, 17)).toBe(true);
  });

  it('evaluates commitment conditions against real proposal numbers', () => {
    const conditions = conditionalCommitment.conditions;
    expect(commitmentConditionsHold(conditions, { purchasePriceUsd: 5_400_000_000, stockComponentPct: 0.4 })).toBe(true);
    expect(commitmentConditionsHold(conditions, { purchasePriceUsd: 6_400_000_000, stockComponentPct: 0.4 })).toBe(false);
    expect(commitmentConditionsHold(conditions, { purchasePriceUsd: 5_400_000_000 })).toBe(false);
  });

  it('detects a balance sheet that does not reconcile', () => {
    const broken: BalanceSheet = { ...balanceSheet, equity: balanceSheet.equity + 1_000 };
    expect(balanceSheetReconciles(broken)).toBe(false);
  });

  it('checks that a return decomposition sums to its total', () => {
    const good = {
      instrumentId: 'ins_orbit_eq',
      companyId: 'cmp_orbit',
      quarter: 7,
      marketBeta: 0.012,
      sectorBeta: -0.022,
      fundamentalAlpha: 0.034,
      publicInfoEffect: -0.041,
      sentimentEffect: -0.017,
      liquidityEffect: 0.009,
      noise: -0.005,
      total: 0.012 - 0.022 + 0.034 - 0.041 - 0.017 + 0.009 - 0.005,
      priceBefore: 70.2,
      priceAfter: 67.44,
    };
    expect(returnDecompositionSums(good, 1e-9)).toBe(true);
    expect(returnDecompositionSums({ ...good, total: 0.5 }, 1e-9)).toBe(false);
  });

  it('formats quarter labels deterministically', () => {
    expect(quarterLabel(2029, 0)).toBe('2029 Q1');
    expect(quarterLabel(2029, 7)).toBe('2030 Q4');
    expect(quarterLabel(2029, 9)).toBe('2031 Q2');
  });

  it('builds deterministic ids from stable parts', () => {
    expect(makeId('evt', 'sess_001', 17, 844)).toBe('evt_sess_001_17_844');
    expect(makeId('cmp', 'Orbit Intelligence')).toBe('cmp_orbit_intelligence');
    expect(makeId('evt', 'sess_001', 17, 844)).toBe(makeId('evt', 'sess_001', 17, 844));
  });

  it('parses a cap table and can express the ownership invariant', () => {
    const capTable = CapTableSchema.parse({
      companyId: 'cmp_orbit',
      shareClasses: [
        {
          id: 'shc_orbit_common',
          companyId: 'cmp_orbit',
          kind: 'common',
          label: 'Class A common',
          votesPerShare: 1,
          liquidationPreferenceMultiple: 0,
          participating: false,
          authorisedShares: 1_000_000_000,
          issuedShares: 600_000_000,
          createdQuarter: 0,
        },
      ],
      holdings: [
        {
          id: 'hld_founder',
          holderId: 'chr_player_founder',
          holderKind: 'character',
          securityId: 'sec_orbit_common',
          shares: 150_000_000,
          costBasisUsd: 1_000_000,
          acquiredQuarter: 0,
          lockupUntilQuarter: null,
          isDisclosed: true,
        },
        {
          id: 'hld_float',
          holderId: 'public_float',
          holderKind: 'public_float',
          securityId: 'sec_orbit_common',
          shares: 450_000_000,
          costBasisUsd: 0,
          acquiredQuarter: 4,
          lockupUntilQuarter: null,
          isDisclosed: true,
        },
      ],
      totalIssuedByClass: { shc_orbit_common: 600_000_000 },
      fullyDilutedShares: 660_000_000,
      optionPoolShares: 60_000_000,
      lastUpdatedQuarter: 7,
    });

    const held = capTable.holdings.reduce((sum, h) => sum + h.shares, 0);
    expect(held).toBe(capTable.totalIssuedByClass['shc_orbit_common']);
  });
});
