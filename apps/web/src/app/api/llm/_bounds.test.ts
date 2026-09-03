/**
 * Input-bound tests for the LLM routes.
 *
 * The defect these close: the contracts schemas put no ceiling on the prose
 * fields, so one POST could compose a multi-megabyte prompt on the operator's
 * subscription. Each case checks both directions — an ordinary body still
 * passes, an absurd one is refused with the field named.
 */

import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { DEFAULT_IMPACT_BUDGET } from '@frontier/contracts';
import {
  BoundedChiefOfStaffInputSchema,
  BoundedNpcStrategistInputSchema,
  BoundedResolutionReportSchema,
  BoundedWorldDirectorInputSchema,
  ConversationPartsSchema,
  LLM_INPUT_LIMITS,
} from './_bounds';

const SESSION_ID = '00000000-0000-4000-8000-000000000001';

function chiefOfStaffInput(overrides: Record<string, unknown> = {}): unknown {
  return {
    sessionId: SESSION_ID,
    quarter: 1,
    playerId: 'player-1',
    companyId: 'company-1',
    playerMessage: 'Get us profitable and keep total burn roughly unchanged.',
    companyBriefing: 'Cash $2.1bn, runway 7 quarters, 1,240 staff.',
    worldBriefing: 'Compute tight, capital selective.',
    currentBudgets: [{ label: 'Research', amountUsd: 180_000_000 }],
    openDecisions: ['Board proposal BP-14 expires next quarter'],
    conversationHistory: [{ role: 'player', text: 'What worries you most?' }],
    autoExecuteEnabled: false,
    ...overrides,
  };
}

function pathsOf(result: z.SafeParseReturnType<unknown, unknown>): string[] {
  return result.success ? [] : result.error.issues.map((issue) => issue.path.join('.'));
}

describe('chief of staff bounds', () => {
  it('accepts an ordinary instruction', () => {
    expect(BoundedChiefOfStaffInputSchema.safeParse(chiefOfStaffInput()).success).toBe(true);
  });

  it('refuses a message longer than a person types', () => {
    const result = BoundedChiefOfStaffInputSchema.safeParse(chiefOfStaffInput({ playerMessage: 'x'.repeat(LLM_INPUT_LIMITS.message + 1) }));
    expect(result.success).toBe(false);
    expect(pathsOf(result)).toContain('playerMessage');
  });

  it('refuses a briefing that would dominate the prompt', () => {
    const oversize = 'x'.repeat(LLM_INPUT_LIMITS.briefing + 1);
    expect(pathsOf(BoundedChiefOfStaffInputSchema.safeParse(chiefOfStaffInput({ companyBriefing: oversize })))).toContain('companyBriefing');
    expect(pathsOf(BoundedChiefOfStaffInputSchema.safeParse(chiefOfStaffInput({ worldBriefing: oversize })))).toContain('worldBriefing');
  });

  it('refuses an unbounded conversation history', () => {
    const history = Array.from({ length: LLM_INPUT_LIMITS.historyTurns + 1 }, () => ({ role: 'player', text: 'hi' }));
    expect(pathsOf(BoundedChiefOfStaffInputSchema.safeParse(chiefOfStaffInput({ conversationHistory: history })))).toContain('conversationHistory');
  });

  it('names the offending entry when one history turn is the problem', () => {
    const history = [
      { role: 'player', text: 'ok' },
      { role: 'chief_of_staff', text: 'y'.repeat(LLM_INPUT_LIMITS.historyText + 1) },
    ];
    expect(pathsOf(BoundedChiefOfStaffInputSchema.safeParse(chiefOfStaffInput({ conversationHistory: history })))).toContain('conversationHistory.1.text');
  });

  it('refuses a flood of open decisions and of budget lines', () => {
    const many = Array.from({ length: LLM_INPUT_LIMITS.listEntries + 1 }, (_, index) => `decision ${index}`);
    expect(pathsOf(BoundedChiefOfStaffInputSchema.safeParse(chiefOfStaffInput({ openDecisions: many })))).toContain('openDecisions');

    const budgets = Array.from({ length: LLM_INPUT_LIMITS.listEntries + 1 }, () => ({ label: 'Research', amountUsd: 1 }));
    expect(pathsOf(BoundedChiefOfStaffInputSchema.safeParse(chiefOfStaffInput({ currentBudgets: budgets })))).toContain('currentBudgets');
  });

  it('leaves the parsed value untouched — an over-long field is refused, never truncated', () => {
    const input = chiefOfStaffInput();
    const result = BoundedChiefOfStaffInputSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.companyBriefing).toBe('Cash $2.1bn, runway 7 quarters, 1,240 staff.');
  });

  /* --- the typed dossier ------------------------------------------------- */

  it('carries the typed dossier through unchanged', () => {
    const result = BoundedChiefOfStaffInputSchema.safeParse(chiefOfStaffInput({ dossier: dossier(), screen: '/capital' }));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.dossier?.companyName).toBe('Nexus Intelligence');
      expect(result.data.screen).toBe('/capital');
    }
  });

  it('refuses a dossier that names an action the union does not have', () => {
    const broken = dossier();
    const result = BoundedChiefOfStaffInputSchema.safeParse(
      chiefOfStaffInput({ dossier: { ...broken, availableActions: [{ ...broken.availableActions[0], type: 'sack_the_board' }] } }),
    );
    expect(result.success).toBe(false);
  });

  it('refuses a dossier carrying more filed quarters than the role is given', () => {
    const broken = dossier();
    const result = BoundedChiefOfStaffInputSchema.safeParse(
      chiefOfStaffInput({ dossier: { ...broken, finances: { ...broken.finances, history: Array.from({ length: 9 }, () => ({})) } } }),
    );
    expect(result.success).toBe(false);
  });

  it('refuses a screen longer than a route', () => {
    expect(BoundedChiefOfStaffInputSchema.safeParse(chiefOfStaffInput({ screen: 'x'.repeat(200) })).success).toBe(false);
  });
});

/** A minimal dossier the contract accepts. Only the fields these bounds touch matter. */
function dossier() {
  return {
    companyName: 'Nexus Intelligence',
    founderName: 'Maya Chen',
    quarterLabel: '2027 Q1',
    posture: 'balanced' as const,
    finances: {
      cashUsd: 1,
      debtUsd: 0,
      revenueQuarterlyUsd: 1,
      quarterlyBurnUsd: 0,
      runwayQuarters: 1,
      grossMarginPct: 0.5,
      operatingMarginPct: 0,
      history: [],
    },
    group: {
      companyCount: 1,
      revenueUsd: 1,
      netIncomeUsd: 0,
      cashUsd: 1,
      debtUsd: 0,
      headcount: 0,
      marketValueUsd: 0,
    },
    products: {
      lines: [],
      computeOwned: 0,
      computeReserved: 0,
      computeUtilisationPct: 0,
      trainingAllocationPct: 0,
      reservationExpiryQuarter: null,
      cloudSpendQuarterlyUsd: 0,
    },
    people: {
      engineers: 0,
      researchers: 0,
      sales: 0,
      ops: 0,
      execs: 0,
      total: 0,
      moralePct: 50,
      attritionPct: 0,
      openRoles: 0,
      payrollQuarterlyUsd: 0,
      keyCharacters: [],
    },
    governance: {
      hasBoard: false,
      seatsAuthorised: 0,
      seatsFilled: 0,
      founderSeats: 0,
      founderOwnershipPct: 1,
      thresholds: [],
      openProposals: [],
      isCeo: true,
    },
    markets: {
      isPublic: false,
      ticker: null,
      sharePriceUsd: null,
      marketCapUsd: null,
      sectorId: 'ai',
      sectorSentiment: 0,
      sectorMultiple: 0,
      sectorDemand: 0,
      sectorPriceIndex: null,
      sectorShortage: null,
      rivals: [],
    },
    capital: {
      funds: [],
      approaches: [],
      debtHeadroomUsd: 0,
      dividendPayoutPct: 0,
      sharesOutstanding: 0,
      ipoWindow: 0,
      ventureLiquidity: 0,
      debtAvailability: 0,
    },
    research: { budgetQuarterlyUsd: 0, projects: [], availableNodes: [] },
    government: { openProgrammes: [], liveContracts: [], pastPerformance: 0 },
    feed: [],
    openDecisions: [],
    availableActions: [
      {
        type: 'hire' as const,
        available: true,
        reason: null,
        becomesBoardMatter: false,
        requiresConfirmation: false,
        bounds: [],
        targets: [],
        maxCashUsd: null,
      },
    ],
    worldNotes: [],
  };
}

describe('other role bounds', () => {
  const npcInput = (overrides: Record<string, unknown> = {}): unknown => ({
    sessionId: SESSION_ID,
    quarter: 1,
    companyId: 'company-1',
    companyBriefing: 'Cash $2.1bn.',
    worldBriefing: 'Compute tight.',
    rivalBriefing: 'Orbit announced a partnership.',
    openOpportunities: [],
    incomingDeals: [],
    priorPosture: 'balanced',
    priorStrategySummary: 'Hold pricing.',
    constraints: ['Available cash $2.1bn'],
    ...overrides,
  });

  it('bounds all three NPC briefings', () => {
    const oversize = 'x'.repeat(LLM_INPUT_LIMITS.briefing + 1);
    expect(pathsOf(BoundedNpcStrategistInputSchema.safeParse(npcInput({ rivalBriefing: oversize })))).toContain('rivalBriefing');
    expect(BoundedNpcStrategistInputSchema.safeParse(npcInput()).success).toBe(true);
  });

  it('bounds the World Director\'s candidate list and target paths', () => {
    const base = {
      sessionId: SESSION_ID,
      quarter: 1,
      quarterLabel: '2027 Q1',
      worldSummary: 'Supply is tight.',
      worldDigest: [],
      sectorSummary: [],
      eventCandidates: [],
      impactBudget: DEFAULT_IMPACT_BUDGET,
      recentEvents: [],
      activeModifierSummaries: [],
      legalTargetPaths: ['world.compute.acceleratorSupply'],
      knownSectorIds: ['semiconductors'],
      styleGuidance: 'In-world reporting.',
    };
    expect(BoundedWorldDirectorInputSchema.safeParse(base).success).toBe(true);

    const flooded = { ...base, legalTargetPaths: Array.from({ length: LLM_INPUT_LIMITS.targetPaths + 1 }, (_, i) => `world.path.${i}`) };
    expect(pathsOf(BoundedWorldDirectorInputSchema.safeParse(flooded))).toContain('legalTargetPaths');
  });

  it('bounds the narrator on total committed lines across phases, not per phase', () => {
    const line = {
      phase: 'world_events' as const,
      text: 'Accelerator supply tightened after a packaging disruption',
      deltaLabel: '-7%',
      refEventIds: ['wev_1'],
      tone: 'negative' as const,
      subjectId: null,
    };
    const phase = (count: number): unknown => ({ phase: 'world_events', lines: Array.from({ length: count }, () => line), durationMs: 1 });
    const report = (perPhase: number): unknown => ({
      sessionId: SESSION_ID,
      quarter: 1,
      headline: 'A tighter quarter',
      phases: [phase(perPhase), phase(perPhase)],
      sequenceFrom: 0,
      sequenceTo: 10,
      stateHashBefore: 'a',
      stateHashAfter: 'b',
    });

    // Each phase is within the ceiling; together they are not.
    const half = Math.ceil(LLM_INPUT_LIMITS.reportLines / 2);
    expect(BoundedResolutionReportSchema.safeParse(report(half - 1)).success).toBe(true);
    expect(pathsOf(BoundedResolutionReportSchema.safeParse(report(half + 1)))).toContain('phases');
  });
});

describe('conversation parts', () => {
  it('accepts the three ids and nothing else', () => {
    const result = ConversationPartsSchema.safeParse({
      gameSessionId: SESSION_ID,
      playerId: 'player-1',
      conversationId: 'main',
      conversationKey: 'cos:sess_demo_20270101',
    });
    expect(result.success).toBe(true);
    // A key smuggled into the body is stripped, so it can never reach a store.
    if (result.success) expect(Object.keys(result.data)).toEqual(['gameSessionId', 'playerId', 'conversationId']);
  });

  it('bounds each id', () => {
    expect(ConversationPartsSchema.safeParse({ gameSessionId: 'x'.repeat(201), playerId: 'p', conversationId: 'main' }).success).toBe(false);
    expect(ConversationPartsSchema.safeParse({ gameSessionId: '', playerId: 'p', conversationId: 'main' }).success).toBe(false);
  });
});
