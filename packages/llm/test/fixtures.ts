/**
 * Test fixtures for @frontier/llm.
 *
 * Mirrors supabase/seed.sql: session seed 424242, 2027 Q1, Nexus Intelligence
 * (NXS) with Maya Chen as chief executive, Orbit Dynamics (ORB) as the nearest
 * rival. Ids are the seed's uuids so a fixture can be pasted into a real
 * session without renaming anything.
 *
 * No live model is ever contacted from this package's tests.
 */

import type {
  AgentRole,
  Character,
  CharacterUtteranceContext,
  ChiefOfStaffDossier,
  ChiefOfStaffInput,
  InnovationInterpreterInput,
  Memory,
  NarratorInput,
  NpcStrategistInput,
  Relationship,
  ResearchProject,
  SocialAuthorInput,
  WorldDirectorInput,
} from '@frontier/contracts';
import { DEFAULT_IMPACT_BUDGET } from '@frontier/contracts';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ClaudeQueryFn } from '../src/transport/claudeSession';
import type { LlmCompletion, LlmCompletionRequest, LlmTransport } from '../src/transport/types';
import { taggedIssue, validationFailed, validationOk, zodIssueSummary } from '../src/transport/types';

export const SESSION_ID = '00000000-0000-4000-8000-000000000001';
export const NEXUS_ID = '10000000-0000-4000-8000-000000000001';
export const ORBIT_ID = '10000000-0000-4000-8000-000000000002';
export const MAYA_ID = '20000000-0000-4000-8000-000000000001';
export const DANIEL_ID = '20000000-0000-4000-8000-000000000002';
export const PLAYER_ID = '30000000-0000-4000-8000-000000000001';

/* -------------------------------------------------------------------------- */
/*  Mock transport                                                             */
/* -------------------------------------------------------------------------- */

export interface MockCall {
  readonly role: AgentRole;
  readonly system: string;
  readonly prompt: string;
  readonly schemaName: string;
  readonly sessionKey: string | null;
}

export interface MockTransport extends LlmTransport {
  readonly calls: MockCall[];
}

/**
 * A transport that hands back whatever `reply` returns, validated against the
 * caller's schema exactly as a real transport would. Returning `undefined`
 * simulates "no model answered".
 */
export function createMockTransport(reply: (call: MockCall) => unknown, config: { modelId?: string; tokens?: { input: number; output: number } | null } = {}): MockTransport {
  const calls: MockCall[] = [];
  const modelId = config.modelId ?? 'mock-sonnet';
  const tokens = config.tokens === undefined ? { input: 100, output: 50 } : config.tokens;

  return {
    kind: 'none',
    calls,
    async complete<T>(req: LlmCompletionRequest<T>): Promise<LlmCompletion<T>> {
      const call: MockCall = { role: req.role, system: req.system, prompt: req.prompt, schemaName: req.schemaName, sessionKey: req.sessionKey };
      calls.push(call);
      const value = reply(call);
      if (value === undefined) {
        return {
          output: null,
          raw: '',
          validation: validationFailed(req.schemaName, [taggedIssue('api_error', 'mock transport returned nothing')]),
          modelId,
          latencyMs: 1,
          tokens,
          claudeSessionId: null,
        };
      }
      const parsed = req.schema.safeParse(value);
      if (!parsed.success) {
        return {
          output: null,
          raw: JSON.stringify(value),
          validation: validationFailed(req.schemaName, zodIssueSummary(parsed.error).map((line) => taggedIssue('invalid_output', line))),
          modelId,
          latencyMs: 1,
          tokens,
          claudeSessionId: null,
        };
      }
      return {
        output: parsed.data,
        raw: JSON.stringify(value),
        validation: validationOk(req.schemaName, false),
        modelId,
        latencyMs: 1,
        tokens,
        claudeSessionId: req.sessionKey === null ? null : 'mock-claude-session',
      };
    },
  };
}

/* -------------------------------------------------------------------------- */
/*  Agent SDK stub                                                             */
/* -------------------------------------------------------------------------- */

export interface StubTurn {
  /** The text the session returns as its result. */
  readonly text: string;
  /** Session id reported on the init and result messages. */
  readonly sessionId: string;
  readonly model?: string;
  readonly tokens?: { input: number; output: number };
  /** When set, the stub throws instead of yielding. */
  readonly throws?: Error;
  /** A typed `SDKAssistantMessageError` reported on the assistant message. */
  readonly error?: string;
}

export interface StubQuery {
  readonly fn: ClaudeQueryFn;
  readonly calls: { prompt: string; options: Options | undefined }[];
}

/** A `query()` stand-in that plays a scripted list of turns. */
export function stubQuery(script: readonly StubTurn[]): StubQuery {
  const calls: { prompt: string; options: Options | undefined }[] = [];
  let index = 0;

  const fn: ClaudeQueryFn = (params) => {
    calls.push({ prompt: params.prompt, options: params.options });
    const turn = script[Math.min(index, script.length - 1)];
    index += 1;
    if (turn === undefined) throw new Error('stubQuery: empty script');
    if (turn.throws !== undefined) throw turn.throws;

    const model = turn.model ?? 'claude-sonnet-5';
    const usage = { input_tokens: turn.tokens?.input ?? 1234, output_tokens: turn.tokens?.output ?? 567 };
    const messages: SDKMessage[] = [
      { type: 'system', subtype: 'init', session_id: turn.sessionId, model, uuid: 'u-init' } as unknown as SDKMessage,
      {
        type: 'assistant',
        session_id: turn.sessionId,
        uuid: 'u-asst',
        parent_tool_use_id: null,
        message: { content: [{ type: 'text', text: turn.text }] },
        ...(turn.error === undefined ? {} : { error: turn.error }),
      } as unknown as SDKMessage,
      { type: 'result', subtype: 'success', session_id: turn.sessionId, uuid: 'u-res', result: turn.text, is_error: false, usage } as unknown as SDKMessage,
    ];

    return {
      async *[Symbol.asyncIterator]() {
        for (const message of messages) yield message;
      },
    };
  };

  return { fn, calls };
}

/* -------------------------------------------------------------------------- */
/*  Role inputs                                                                */
/* -------------------------------------------------------------------------- */

export function worldDirectorInput(overrides: Partial<WorldDirectorInput> = {}): WorldDirectorInput {
  return {
    sessionId: SESSION_ID,
    quarter: 1,
    quarterLabel: '2027 Q1',
    worldSummary: 'Accelerator supply is tight and repricing weekly. Venture liquidity is ample but selective. The press is preoccupied with energy cost.',
    worldDigest: [
      { path: 'world.compute.acceleratorSupply', value: 0.62, delta: -0.07, label: 'Accelerator supply' },
      { path: 'world.compute.spotPrice', value: 1.34, delta: 0.11, label: 'Compute spot price' },
    ],
    sectorSummary: [{ sectorId: 'semiconductors', sentiment: 0.44, multiple: 8.2, demand: 0.71 }],
    eventCandidates: [
      {
        candidateId: 'cand_q1_compute_1',
        familyId: 'fam_compute_supply',
        familyLabel: 'Compute supply disruption',
        allowedTypes: ['compute_supply_shock', 'fab_disruption'],
        severityBand: [0.3, 0.7],
        suggestedSeverity: 0.55,
        defaultVisibility: 'public',
        maxDurationQuarters: 4,
        causalParentId: null,
        suggestedTargetPaths: ['world.compute.acceleratorSupply', 'world.compute.spotPrice'],
        relevantWorldReadings: [{ path: 'world.compute.acceleratorSupply', value: 0.62, label: 'Accelerator supply' }],
        affectedSectorIds: ['semiconductors'],
      },
    ],
    impactBudget: DEFAULT_IMPACT_BUDGET,
    recentEvents: [{ eventId: 'wev_energy_q0', quarter: 0, type: 'energy_price_shock', title: 'Grid pricing reform lands early', severity: 0.4, stillActive: true }],
    activeModifierSummaries: [{ target: 'world.energy.industrialPrice', operation: 'multiply', value: 1.12, remainingQuarters: 2, reason: 'Reform passed through to industrial tariffs.' }],
    legalTargetPaths: ['world.compute.acceleratorSupply', 'world.compute.spotPrice', 'world.energy.industrialPrice'],
    knownSectorIds: ['semiconductors', 'cloud_infrastructure'],
    styleGuidance: 'In-world reporting. No second person. No prediction of any participant outcome.',
    ...overrides,
  };
}

export function npcStrategistInput(overrides: Partial<NpcStrategistInput> = {}): NpcStrategistInput {
  return {
    sessionId: SESSION_ID,
    quarter: 1,
    companyId: NEXUS_ID,
    companyBriefing: 'Nexus Intelligence (NXS). Cash $2.1bn, burn $310m per quarter, 1,240 staff, 180,000 accelerator-equivalents reserved through 2028.',
    worldBriefing: 'Compute is tight and repricing. Venture liquidity is ample but selective.',
    rivalBriefing: 'Orbit Dynamics has announced an enterprise deployment partnership. Nothing else material has been disclosed this quarter.',
    openOpportunities: [{ opportunityId: 'opp_defence_eval', programme: 'National evaluation harness', maxValueUsd: 480_000_000, closeQuarter: 3 }],
    incomingDeals: [{ dealId: 'deal_helix_capacity', fromId: ORBIT_ID, summary: 'Six quarters of reserved capacity at a 12% premium to spot.' }],
    priorPosture: 'aggressive_growth',
    priorStrategySummary: 'Lock supply before the shortage prices in, and hold enterprise pricing.',
    constraints: ['Available cash $2.1bn', 'Board approval required above $500m', 'Existing reservation commitments through 2028'],
    ...overrides,
  };
}

export function chiefOfStaffInput(overrides: Partial<ChiefOfStaffInput> = {}): ChiefOfStaffInput {
  return {
    sessionId: SESSION_ID,
    quarter: 1,
    playerId: PLAYER_ID,
    companyId: NEXUS_ID,
    playerMessage: 'Stop caring about growth next year. Get us profitable and keep total burn roughly unchanged.',
    companyBriefing: 'Cash $2.1bn, runway 7 quarters, 1,240 staff, two products, 180,000 accelerator-equivalents reserved.',
    worldBriefing: 'Compute tight, capital selective, enterprise demand holding.',
    currentBudgets: [
      { label: 'Research', amountUsd: 180_000_000 },
      { label: 'Marketing', amountUsd: 40_000_000 },
    ],
    openDecisions: ['Board proposal BP-14 on the buyback expires next quarter'],
    conversationHistory: [{ role: 'player', text: 'What worries you most this quarter?' }],
    autoExecuteEnabled: false,
    ...overrides,
  };
}

export function mayaChen(overrides: Partial<Character> = {}): Character {
  return {
    id: MAYA_ID,
    name: 'Maya Chen',
    role: 'founder_ceo',
    companyId: NEXUS_ID,
    title: 'CEO — Nexus Intelligence',
    stableTraits: { riskTolerance: 89, technicalOrientation: 96, financialConservatism: 27, aggressiveness: 83, statusSensitivity: 66 },
    beliefs: [
      { topic: 'compute_scarcity', level: 'high' },
      { topic: 'market_bubble', level: 'low' },
    ],
    connectionLevel: 86,
    isPlayer: false,
    personalWealthUsd: 4_100_000_000,
    boardSeatCount: 2,
    publicFollowing: 1_200_000,
    isActive: true,
    ...overrides,
  };
}

export function relationship(overrides: Partial<Relationship> = {}): Relationship {
  return {
    fromId: MAYA_ID,
    toId: DANIEL_ID,
    trust: 44,
    respect: 71,
    hostility: 22,
    dependence: 18,
    lastInteractionQuarter: 0,
    interactionCount: 3,
    ...overrides,
  };
}

export function memory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: 'mem_poach_q0',
    ownerCharacterId: MAYA_ID,
    aboutId: DANIEL_ID,
    quarter: 0,
    kind: 'poach',
    summary: 'Orbit approached two of my inference engineers during the supply squeeze.',
    sentiment: -0.6,
    decayRate: 0.02,
    strength: 0.82,
    ...overrides,
  };
}

export function utteranceContext(overrides: Partial<CharacterUtteranceContext> = {}): CharacterUtteranceContext {
  return {
    character: mayaChen(),
    relationship: relationship(),
    counterpartRelationship: relationship({ fromId: DANIEL_ID, toId: MAYA_ID, trust: 31, respect: 80, hostility: 40 }),
    memories: [memory()],
    topic: 'a six-quarter capacity swap at a premium to spot',
    gameFacts: [{ label: 'Nexus reserved capacity', value: '180,000 units through 2028' }],
    conversationHistory: [{ speakerId: DANIEL_ID, text: 'We would take six quarters at twelve points over spot.' }],
    accessBasis: 'negotiation opened through a shared investor',
    pendingProposalSummary: null,
    ...overrides,
  };
}

export function innovationInput(overrides: Partial<InnovationInterpreterInput> = {}): InnovationInterpreterInput {
  return {
    sessionId: SESSION_ID,
    quarter: 1,
    companyId: NEXUS_ID,
    playerIdea: 'Train agents inside a simulated economy so they learn negotiation from consequences rather than from transcripts.',
    existingNodes: [
      { nodeId: 'tech_agentic_planning', title: 'Agentic long-horizon planning', status: 'emerging', publicConfidence: 0.51 },
      { nodeId: 'tech_sparse_inference', title: 'Efficient sparse inference', status: 'established', publicConfidence: 0.79 },
    ],
    companyCapabilities: [
      { area: 'reasoning', strength: 0.74 },
      { area: 'agents', strength: 0.61 },
    ],
    companyResources: { cashUsd: 2_100_000_000, quarterlyRdUsd: 180_000_000, researchers: 310, computeUnits: 180_000 },
    worldContext: 'Compute is tight and repricing weekly. Energy cost is elevated. Talent supply is thin at the frontier.',
    ...overrides,
  };
}

export function socialInput(overrides: Partial<SocialAuthorInput> = {}): SocialAuthorInput {
  return {
    authorCharacterId: MAYA_ID,
    authorBriefing: 'Maya Chen posts rarely and technically. When she does, the technical forum reads it closely and the press quotes it.',
    network: 'technical_forum',
    intent: 'announce',
    situation: 'Nexus has finished a training run that beat its own internal target on long-horizon evaluation.',
    audienceMix: [
      { audience: 'developers', share: 0.58 },
      { audience: 'investors', share: 0.21 },
    ],
    constraints: ['No unannounced product names', 'No contract terms under confidentiality', 'No undisclosed material figures'],
    ...overrides,
  };
}

export function narratorInput(overrides: Partial<NarratorInput> = {}): NarratorInput {
  return {
    sessionId: SESSION_ID,
    quarter: 1,
    committedLines: [
      { phase: 'world', text: 'Accelerator supply tightened after a packaging disruption', deltaLabel: '-7%' },
      { phase: 'world', text: 'Compute spot price repriced upward', deltaLabel: '+11%' },
      { phase: 'companies', text: 'Nexus Intelligence recognised enterprise revenue', deltaLabel: '+$142m' },
      { phase: 'markets', text: 'Nexus Intelligence share price moved on the disclosure', deltaLabel: '-3%' },
    ],
    focusCompanyId: NEXUS_ID,
    ...overrides,
  };
}

export function researchProject(overrides: Partial<ResearchProject> = {}): ResearchProject {
  return {
    id: 'rp_nexus_agents',
    companyId: NEXUS_ID,
    targetNodeId: 'tech_agentic_planning',
    budgetQuarterly: 120_000_000,
    computeAllocated: 40_000,
    talentAllocated: 90,
    progress: 0.34,
    internalConfidence: 0.48,
    quartersElapsed: 3,
    expectedQuarters: 9,
    isSecret: true,
    status: 'active',
    cumulativeSpendUsd: 360_000_000,
    setbacks: 1,
    startedQuarter: 0,
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/*  Valid role outputs                                                         */
/* -------------------------------------------------------------------------- */

export const VALID_GM_BATCH = {
  proposals: [
    {
      event: {
        candidateId: 'cand_q1_compute_1',
        familyId: 'fam_compute_supply',
        type: 'compute_supply_shock',
        titleKey: 'advanced_packaging_disruption',
        title: 'Advanced packaging capacity disrupted',
        description: 'A fire at a packaging subcontractor removed a fifth of advanced substrate throughput for the quarter. Accelerator assembly lines have begun rationing allocations to their largest customers.',
        severity: 0.55,
        visibility: 'public' as const,
        durationQuarters: 3,
        causalParentId: null,
        affectedSectorIds: ['semiconductors'],
      },
      modifiers: [
        { target: 'world.compute.acceleratorSupply', operation: 'multiply' as const, value: 0.86, decay: 'linear' as const, durationQuarters: 3, reason: 'Packaging is the binding constraint.' },
      ],
      rationale: 'Supply was already tight and the hazard engine drew this family; a packaging failure is the most legible cause available.',
      confidence: 0.78,
    },
  ],
  quarterSummary: 'A tight compute quarter got tighter, and the cost showed up first in the smallest laboratories.',
};

export const VALID_NPC_BUNDLE = {
  companyId: NEXUS_ID,
  strategySummary: 'Lock capacity ahead of the squeeze and hold enterprise pricing rather than chase volume.',
  posture: 'aggressive_growth' as const,
  actions: [{ type: 'reserve_compute' as const, units: 45_000, quarters: 6, maxPricePerUnitUsd: 20_000 }],
  rationale: 'Supply is repricing weekly and our reservation book expires before the shortage is expected to clear.',
};

export const VALID_CHARACTER_REPLY = {
  text: 'Twelve points over spot is not a partnership, it is a toll. Bring me eight and a two-quarter break clause and I will take it to my board.',
  newCommitment: null,
  relationshipDeltas: { trust: 0, respect: 1, hostility: 0 },
  memoryToStore: null,
};

export const VALID_NARRATION = {
  headline: 'A tighter quarter for compute, and a softer one for the share price',
  body: 'Accelerator supply tightened and the spot price repriced upward. Nexus recognised enterprise revenue on schedule, but the disclosure moved the share price down.',
  tone: 'strained' as const,
};

export const VALID_SOCIAL_POST = {
  authorCharacterId: MAYA_ID,
  network: 'technical_forum' as const,
  text: 'Long-horizon eval run finished above our internal target. Numbers and methodology when the writeup lands.',
  intent: 'announce' as const,
  targetCompanyId: null,
};

export const VALID_INNOVATION_PROPOSAL = {
  nodeType: 'player_hypothesis' as const,
  title: 'Mass Multi-Agent Economic Simulation',
  summary: 'Train negotiating agents inside a simulated economy so that incentives, not transcripts, shape their behaviour. The mechanism is population-scale self-play against economic consequence rather than imitation of recorded dialogue.',
  novelty: 0.72,
  plausibility: 0.41,
  requiredCapabilities: ['agent_simulation', 'reinforcement_learning', 'large_scale_compute'],
  estimatedCost: 280_000_000,
  estimatedQuarters: 11,
  dependencies: ['tech_agentic_planning'],
  initialVisibility: 'company_private' as const,
  rationale: 'Nexus already holds the planning capability and the reserved compute; the missing piece is an environment, which is cheap relative to the frontier run it would replace.',
};

/* -------------------------------------------------------------------------- */
/*  Chief of Staff dossier                                                     */
/* -------------------------------------------------------------------------- */

/**
 * A typed dossier for Nexus, small enough to read and complete enough to answer
 * every canonical question the offline responder handles.
 *
 * Deliberately arithmetically consistent — $2.1bn of cash against $300m a
 * quarter really is seven quarters — because a fixture whose numbers disagree
 * would let a broken responder pass.
 */
export function chiefOfStaffDossier(overrides: Partial<ChiefOfStaffDossier> = {}): ChiefOfStaffDossier {
  return {
    companyName: 'Nexus Intelligence',
    founderName: 'Maya Chen',
    quarterLabel: '2027 Q2',
    posture: 'balanced',
    finances: {
      cashUsd: 2_100_000_000,
      debtUsd: 400_000_000,
      revenueQuarterlyUsd: 900_000_000,
      quarterlyBurnUsd: -300_000_000,
      runwayQuarters: 7,
      grossMarginPct: 0.62,
      operatingMarginPct: -0.12,
      history: [],
    },
    products: {
      lines: [
        {
          productId: 'prd_enterprise_agent',
          name: 'Nexus Enterprise Agent',
          segment: 'enterprise',
          pricePerSeatUsd: 900,
          activeCustomers: 620_000,
          grossMarginPct: 0.71,
          churnQuarterly: 0.04,
          qualityScore: 0.72,
          revenueQuarterlyUsd: 558_000_000,
          isActive: true,
        },
        {
          productId: 'prd_consumer_copilot',
          name: 'Nexus Copilot',
          segment: 'consumer',
          pricePerSeatUsd: 40,
          activeCustomers: 3_100_000,
          grossMarginPct: 0.21,
          churnQuarterly: 0.19,
          qualityScore: 0.55,
          revenueQuarterlyUsd: 124_000_000,
          isActive: true,
        },
      ],
      computeOwned: 40_000,
      computeReserved: 180_000,
      computeUtilisationPct: 0.88,
      trainingAllocationPct: 0.6,
      reservationExpiryQuarter: 9,
      cloudSpendQuarterlyUsd: 120_000_000,
    },
    people: {
      engineers: 620,
      researchers: 240,
      sales: 260,
      ops: 110,
      execs: 10,
      total: 1_240,
      moralePct: 64,
      attritionPct: 0.06,
      openRoles: 35,
      payrollQuarterlyUsd: 210_000_000,
      keyCharacters: [{ characterId: MAYA_ID, name: 'Maya Chen', role: 'founder', title: 'Chief Executive', isCeo: true }],
    },
    governance: {
      hasBoard: true,
      seatsAuthorised: 7,
      seatsFilled: 5,
      founderSeats: 2,
      founderOwnershipPct: 0.24,
      thresholds: [{ label: 'board control', fraction: 0.5, reached: false }],
      openProposals: [
        { proposalId: 'prp_buyback', kind: 'buyback', title: 'Repurchase $200m of stock', status: 'tabled', decisionQuarter: 2, amountUsd: 200_000_000 },
      ],
      isCeo: true,
    },
    markets: {
      isPublic: true,
      ticker: 'NXS',
      sharePriceUsd: 140,
      marketCapUsd: 18_000_000_000,
      sectorId: 'ai',
      sectorSentiment: 0.61,
      sectorMultiple: 12.4,
      sectorDemand: 1.08,
      sectorPriceIndex: 104,
      sectorShortage: 10,
      rivals: [
        {
          companyId: ORBIT_ID,
          name: 'Orbit Dynamics',
          ticker: 'ORB',
          sectorId: 'ai',
          isPublic: true,
          revenueQuarterlyUsd: 1_400_000_000,
          marketCapUsd: 31_000_000_000,
          enterpriseReputation: 74,
        },
      ],
    },
    capital: {
      funds: [
        { entityId: 'fund_seawall', name: 'Seawall Capital', kind: 'hedge_fund', dryPowderUsd: 3_000_000_000, holdsStakePct: 0.06, thesis: 'Short the story, own the cash flow.' },
      ],
      approaches: [],
      debtHeadroomUsd: 900_000_000,
      dividendPayoutPct: 0,
      sharesOutstanding: 128_000_000,
      ipoWindow: 0.5,
      ventureLiquidity: 0.42,
      debtAvailability: 0.55,
    },
    research: {
      budgetQuarterlyUsd: 180_000_000,
      projects: [],
      availableNodes: [{ nodeId: 'tech_agentic_planning', title: 'Agentic Planning' }],
    },
    government: { openProgrammes: [], liveContracts: [], pastPerformance: 62 },
    feed: [],
    openDecisions: ['Board proposal BP-14 on the buyback expires next quarter.'],
    availableActions: [
      {
        type: 'set_research_budget',
        available: true,
        reason: null,
        becomesBoardMatter: false,
        requiresConfirmation: false,
        bounds: [{ field: 'budgetUsd', label: 'Quarterly research budget', min: 0, max: 2_100_000_000, unit: 'usd' }],
        targets: [],
        maxCashUsd: 2_100_000_000,
      },
      {
        type: 'raise_round',
        available: true,
        reason: null,
        becomesBoardMatter: true,
        requiresConfirmation: true,
        bounds: [{ field: 'maxDilutionPct', label: 'Dilution ceiling', min: 0, max: 0.5, unit: 'fraction' }],
        targets: [],
        maxCashUsd: null,
      },
      {
        type: 'ipo',
        available: false,
        reason: 'Nexus Intelligence is already listed.',
        becomesBoardMatter: false,
        requiresConfirmation: true,
        bounds: [],
        targets: [],
        maxCashUsd: null,
      },
    ],
    worldNotes: ['Compute tight, capital selective, enterprise demand holding.'],
    ...overrides,
  };
}
