/**
 * The Chief of Staff contracts.
 *
 * Three things are being pinned down here: the typed dossier parses and stays
 * bounded, the interpretation carries a mode and a reply the founder can read,
 * and the always-confirm set is a single list rather than a claim repeated in
 * two places.
 */

import { describe, expect, it } from 'vitest';
import {
  ACTION_TYPES,
  COS_MEMORY_EXCHANGES,
  COS_MEMORY_PREFERENCES,
  COS_MODES,
  CONFIRMATION_REQUIRED_ACTIONS,
  ChiefOfStaffDossierSchema,
  ChiefOfStaffInputSchema,
  ChiefOfStaffInterpretationSchema,
  ChiefOfStaffMemorySchema,
  CosAvailableActionSchema,
  EMPTY_CHIEF_OF_STAFF_MEMORY,
  LOOKUP_KINDS,
  LookupRequestSchema,
  LookupResultSchema,
  MAX_LOOKUPS_PER_TURN,
  MAX_LOOKUP_ROWS,
  requiresExplicitConfirmation,
} from '../src/index';

const AVAILABLE_ACTION = {
  type: 'hire' as const,
  available: true,
  reason: null,
  becomesBoardMatter: false,
  requiresConfirmation: false,
  bounds: [{ field: 'count', label: 'Engineers at market pay', min: 1, max: 31, unit: 'count' as const }],
  targets: [],
  maxCashUsd: 3_000_000,
};

const DOSSIER = {
  companyName: 'Player Ventures',
  founderName: 'Avery Sinclair',
  quarterLabel: '2027 Q1',
  posture: 'balanced' as const,
  finances: {
    cashUsd: 4_000_000,
    debtUsd: 0,
    revenueQuarterlyUsd: 1_200_000,
    quarterlyBurnUsd: -600_000,
    runwayQuarters: 6,
    grossMarginPct: 0.6,
    operatingMarginPct: -0.2,
    history: [],
  },
  group: {
    companyCount: 1,
    revenueUsd: 1_200_000,
    netIncomeUsd: -600_000,
    cashUsd: 4_000_000,
    debtUsd: 0,
    headcount: 9,
    marketValueUsd: 10_000_000,
  },
  products: {
    lines: [],
    computeOwned: 0,
    computeReserved: 0,
    computeUtilisationPct: 0,
    trainingAllocationPct: 0.5,
    reservationExpiryQuarter: null,
    cloudSpendQuarterlyUsd: 0,
  },
  people: {
    engineers: 4,
    researchers: 2,
    sales: 1,
    ops: 1,
    execs: 1,
    total: 9,
    moralePct: 70,
    attritionPct: 0.05,
    openRoles: 0,
    payrollQuarterlyUsd: 900_000,
    keyCharacters: [],
  },
  governance: {
    hasBoard: true,
    seatsAuthorised: 5,
    seatsFilled: 3,
    founderSeats: 1,
    founderOwnershipPct: 0.6,
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
    sectorSentiment: 0.5,
    sectorMultiple: 10,
    sectorDemand: 1,
    sectorPriceIndex: null,
    sectorShortage: null,
    rivals: [],
  },
  capital: {
    funds: [],
    approaches: [],
    debtHeadroomUsd: 0,
    dividendPayoutPct: 0,
    sharesOutstanding: 10_000_000,
    ipoWindow: 0.4,
    ventureLiquidity: 0.5,
    debtAvailability: 0.5,
  },
  research: { budgetQuarterlyUsd: 400_000, projects: [], availableNodes: [] },
  government: { openProgrammes: [], liveContracts: [], pastPerformance: 0 },
  feed: [],
  openDecisions: [],
  availableActions: [AVAILABLE_ACTION],
  worldNotes: [],
};

describe('the dossier', () => {
  it('parses', () => {
    expect(ChiefOfStaffDossierSchema.safeParse(DOSSIER).success).toBe(true);
  });

  it('refuses more than eight filed quarters, because that is what "recent" means here', () => {
    const tooMany = { ...DOSSIER, finances: { ...DOSSIER.finances, history: Array.from({ length: 9 }, () => filedQuarter()) } };
    expect(ChiefOfStaffDossierSchema.safeParse(tooMany).success).toBe(false);
  });

  it('refuses more than ten feed items', () => {
    const item = { itemId: 'x', quarter: 0, kind: 'story', headline: 'Something happened', whyItMatters: null };
    const tooMany = { ...DOSSIER, feed: Array.from({ length: 11 }, () => item) };
    expect(ChiefOfStaffDossierSchema.safeParse(tooMany).success).toBe(false);
  });

  it('can carry every action type at once and no more', () => {
    const all = ACTION_TYPES.map((type) => ({ ...AVAILABLE_ACTION, type, requiresConfirmation: requiresExplicitConfirmation(type) }));
    expect(ChiefOfStaffDossierSchema.safeParse({ ...DOSSIER, availableActions: all }).success).toBe(true);
    expect(all.filter((entry) => entry.requiresConfirmation).map((entry) => entry.type).sort()).toEqual([...CONFIRMATION_REQUIRED_ACTIONS].sort());
  });

  it('will not name an action the union does not have', () => {
    expect(CosAvailableActionSchema.safeParse({ ...AVAILABLE_ACTION, type: 'sack_the_board' }).success).toBe(false);
  });

  it('takes null for a bound with no floor or ceiling', () => {
    const open = { ...AVAILABLE_ACTION, bounds: [{ field: 'amountUsd', label: 'Principal', min: null, max: null, unit: 'usd' as const }] };
    expect(CosAvailableActionSchema.safeParse(open).success).toBe(true);
  });
});

/** The minimum a Chief of Staff input needs, shared by the blocks below. */
const inputBase = {
  sessionId: 'sess_1',
  quarter: 0,
  playerId: 'ply_1',
  companyId: 'cmp_1',
  playerMessage: 'How are we doing?',
  companyBriefing: 'Cash $4m.',
  worldBriefing: 'Compute tight.',
  currentBudgets: [],
  openDecisions: [],
  conversationHistory: [],
  autoExecuteEnabled: false,
};

describe('the input', () => {
  const base = {
    sessionId: 'sess_1',
    quarter: 0,
    playerId: 'ply_1',
    companyId: 'cmp_1',
    playerMessage: 'How are we doing?',
    companyBriefing: 'Cash $4m.',
    worldBriefing: 'Compute tight.',
    currentBudgets: [],
    openDecisions: [],
    conversationHistory: [],
    autoExecuteEnabled: false,
  };

  it('parses with the dossier, and without it', () => {
    expect(ChiefOfStaffInputSchema.safeParse({ ...base, dossier: DOSSIER }).success).toBe(true);
    expect(ChiefOfStaffInputSchema.safeParse(base).success).toBe(true);
  });

  it('carries the screen the founder asked from', () => {
    const parsed = ChiefOfStaffInputSchema.safeParse({ ...base, screen: '/capital' });
    expect(parsed.success && parsed.data.screen).toBe('/capital');
  });

  it('carries a memory', () => {
    expect(ChiefOfStaffInputSchema.safeParse({ ...base, memory: EMPTY_CHIEF_OF_STAFF_MEMORY }).success).toBe(true);
  });
});

describe('the interpretation', () => {
  const base = {
    mode: 'answer' as const,
    reply: 'Cash is $4m, which is six quarters of runway.',
    interpretedInstructions: [],
    summary: 'Nothing was interpreted. No binding action has been submitted yet.',
    questions: [],
    requiresConfirmation: true,
    confidence: 0.8,
    unsupportedRequests: [],
    // Required, not optional: this schema is handed to structured outputs, where
    // every key must be emitted. Empty is how a reply says it needs no sourcing.
    lookups: [],
  };

  it('parses in every mode', () => {
    for (const mode of COS_MODES) expect(ChiefOfStaffInterpretationSchema.safeParse({ ...base, mode }).success).toBe(true);
  });

  it('carries the lookups a research turn asks for, and refuses a fifth', () => {
    const request = { kind: 'own_position' as const };
    expect(
      ChiefOfStaffInterpretationSchema.safeParse({
        ...base,
        mode: 'research',
        lookups: [{ kind: 'compute_market', units: 500 }, request],
      }).success,
    ).toBe(true);
    expect(
      ChiefOfStaffInterpretationSchema.safeParse({ ...base, mode: 'research', lookups: [request, request, request, request, request] }).success,
    ).toBe(false);
  });

  it('demands the lookups key even when there is nothing to look up', () => {
    const { lookups: _lookups, ...withoutLookups } = base;
    expect(ChiefOfStaffInterpretationSchema.safeParse(withoutLookups).success).toBe(false);
  });

  it('demands a reply: the founder always gets words back', () => {
    expect(ChiefOfStaffInterpretationSchema.safeParse({ ...base, reply: '' }).success).toBe(false);
    const { reply: _reply, ...withoutReply } = base;
    expect(ChiefOfStaffInterpretationSchema.safeParse(withoutReply).success).toBe(false);
  });

  it('refuses a mode the interface does not know how to render', () => {
    expect(ChiefOfStaffInterpretationSchema.safeParse({ ...base, mode: 'execute' }).success).toBe(false);
  });

  it('still carries typed actions', () => {
    const parsed = ChiefOfStaffInterpretationSchema.safeParse({
      ...base,
      mode: 'act',
      interpretedInstructions: [{ type: 'set_research_budget', budgetUsd: 1_000_000 }],
    });
    expect(parsed.success).toBe(true);
  });
});

describe('the memory', () => {
  it('is bounded on both axes', () => {
    const exchange = { quarter: 1, founderSaid: 'a', chiefReplied: 'b' };
    const preference = { quarter: 1, text: 'Never dilute below 25%.' };
    expect(
      ChiefOfStaffMemorySchema.safeParse({
        exchanges: Array.from({ length: COS_MEMORY_EXCHANGES }, () => exchange),
        preferences: Array.from({ length: COS_MEMORY_PREFERENCES }, () => preference),
      }).success,
    ).toBe(true);
    expect(
      ChiefOfStaffMemorySchema.safeParse({
        exchanges: Array.from({ length: COS_MEMORY_EXCHANGES + 1 }, () => exchange),
        preferences: [],
      }).success,
    ).toBe(false);
  });

  it('stamps every entry with the quarter it came from', () => {
    const parsed = ChiefOfStaffMemorySchema.safeParse({ exchanges: [{ founderSaid: 'a', chiefReplied: 'b' }], preferences: [] });
    expect(parsed.success).toBe(false);
  });

  it('starts empty', () => {
    expect(ChiefOfStaffMemorySchema.safeParse(EMPTY_CHIEF_OF_STAFF_MEMORY).success).toBe(true);
  });
});

/** A minimal reconciling filed quarter, for the history bound above. */
function filedQuarter() {
  return {
    quarter: 0,
    income: {
      revenueUsd: 0,
      cogsUsd: 0,
      grossProfitUsd: 0,
      opexUsd: 0,
      ebitdaUsd: 0,
      depreciationUsd: 0,
      operatingIncomeUsd: 0,
      interestUsd: 0,
      taxUsd: 0,
      netIncomeUsd: 0,
    },
    balance: {
      cashUsd: 0,
      receivablesUsd: 0,
      computeAssetsUsd: 0,
      otherAssetsUsd: 0,
      totalAssetsUsd: 0,
      debtUsd: 0,
      deferredRevenueUsd: 0,
      otherLiabilitiesUsd: 0,
      totalLiabilitiesUsd: 0,
      equityUsd: 0,
    },
    cashFlow: { openingCashUsd: 0, operatingUsd: 0, investingUsd: 0, financingUsd: 0, netChangeUsd: 0, endingCashUsd: 0 },
    kpis: {
      headcount: 0,
      grossMarginPct: 0,
      revenueGrowthQoQ: 0,
      revenueGrowthYoY: 0,
      runwayQuarters: 0,
      runRateUsd: 0,
      marketCapUsd: null,
      sharePriceUsd: null,
    },
  };
}

/* -------------------------------------------------------------------------- */
/*  The lookup catalogue                                                       */
/* -------------------------------------------------------------------------- */

describe('the lookup catalogue', () => {
  it('names nine kinds and bounds a turn to four of them', () => {
    expect([...LOOKUP_KINDS]).toEqual([
      'compute_market',
      'acquisition_targets',
      'debt_headroom',
      'government_programmes',
      'hiring_market',
      'own_position',
      'launchable_lines',
      'suppliers',
      'customers',
    ]);
    expect(MAX_LOOKUPS_PER_TURN).toBe(4);
    expect(MAX_LOOKUP_ROWS).toBe(12);
  });

  it('round-trips every request kind', () => {
    const requests = [
      { kind: 'compute_market', units: 500 },
      { kind: 'acquisition_targets', sector: 'cloud_infrastructure', region: 'north_america', maxValueUsd: 400_000_000, keyword: 'basalt' },
      { kind: 'debt_headroom' },
      { kind: 'government_programmes' },
      { kind: 'hiring_market', role: 'researchers' },
      { kind: 'own_position' },
      { kind: 'launchable_lines' },
      { kind: 'suppliers', inputCategoryId: 'ai_frontier_models', productId: 'prd_agent_copilot' },
      { kind: 'customers', productId: 'prd_frontier_model_api' },
    ];
    for (const request of requests) {
      const parsed = LookupRequestSchema.safeParse(request);
      expect(parsed.success, JSON.stringify(request)).toBe(true);
      if (parsed.success) expect(parsed.data).toEqual(request);
    }
    expect(LOOKUP_KINDS.every((kind) => requests.some((request) => request.kind === kind))).toBe(true);
  });

  it('refuses a kind the engine has no answer for', () => {
    expect(LookupRequestSchema.safeParse({ kind: 'rival_private_state' }).success).toBe(false);
  });

  it('round-trips a compute-market result, ids and action intact', () => {
    const result = {
      kind: 'compute_market' as const,
      summary: 'Tessellate will sell 8000 accelerators.',
      units: 500,
      ownedUnits: 1_200,
      reservedUnits: 400,
      cloudUnits: 90,
      heldUnits: 1_690,
      ownedQuarterlyCostUsd: 1_400_000,
      reservedQuarterlyCostUsd: 1_300_000,
      cloudQuarterlyCostUsd: 1_900_000,
      purchaseCostUsd: 21_000_000,
      cashUsd: 4_000_000,
      cashAfterPurchaseUsd: -17_000_000,
      solvencyLine: '1 more quarter below zero and the company is wound up.',
      sellers: [
        {
          companyId: 'cmp_tessellate',
          name: 'Tessellate Fabrication',
          offering: 'accelerators' as const,
          sectorId: 'semiconductors',
          region: 'east_asia',
          unitPriceUsd: 42_000,
          sellableUnits: 8_000,
          quarterlyCostPerUnitUsd: 2_310,
          energyFactorPct: 96,
          utilisationPct: 71,
          intent: { type: 'buy_accelerators' as const, units: 500, maxPricePerUnitUsd: 46_200, sellerCompanyId: 'cmp_tessellate' },
        },
      ],
    };
    const parsed = LookupResultSchema.safeParse(result);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data).toEqual(result);
  });

  it('lets a cash figure go negative, because cash never refuses an answer', () => {
    const parsed = LookupResultSchema.safeParse({
      kind: 'own_position',
      summary: 'Overdrawn.',
      cashUsd: -9_000_000,
      quarterlyBurnUsd: -2_000_000,
      runwayQuarters: 0,
      negativeCashQuarters: 1,
      solvencyQuartersAllowed: 2,
      statements: [],
    });
    expect(parsed.success && parsed.data.kind === 'own_position' && parsed.data.cashUsd).toBe(-9_000_000);
  });

  it('bounds a result to twelve rows', () => {
    const row = {
      companyId: 'cmp_a',
      name: 'A',
      offering: 'cloud' as const,
      sectorId: 'cloud_infrastructure',
      region: 'north_america',
      unitPriceUsd: 3_600,
      sellableUnits: 10,
      quarterlyCostPerUnitUsd: 3_600,
      energyFactorPct: 100,
      utilisationPct: 50,
      intent: null,
    };
    const base = {
      kind: 'compute_market' as const,
      summary: 'x',
      units: 1,
      ownedUnits: 0,
      reservedUnits: 0,
      cloudUnits: 0,
      heldUnits: 0,
      ownedQuarterlyCostUsd: 0,
      reservedQuarterlyCostUsd: 0,
      cloudQuarterlyCostUsd: 0,
      purchaseCostUsd: 0,
      cashUsd: 0,
      cashAfterPurchaseUsd: 0,
      solvencyLine: '',
    };
    expect(LookupResultSchema.safeParse({ ...base, sellers: Array.from({ length: MAX_LOOKUP_ROWS }, () => row) }).success).toBe(true);
    expect(LookupResultSchema.safeParse({ ...base, sellers: Array.from({ length: MAX_LOOKUP_ROWS + 1 }, () => row) }).success).toBe(false);
  });

  it('carries findings on the input, bounded to one round', () => {
    const finding = {
      kind: 'own_position' as const,
      summary: 'x',
      cashUsd: 1,
      quarterlyBurnUsd: 0,
      runwayQuarters: 1,
      negativeCashQuarters: 0,
      solvencyQuartersAllowed: 2,
      statements: [],
    };
    expect(ChiefOfStaffInputSchema.safeParse({ ...inputBase, findings: [finding] }).success).toBe(true);
    expect(
      ChiefOfStaffInputSchema.safeParse({ ...inputBase, findings: Array.from({ length: MAX_LOOKUPS_PER_TURN + 1 }, () => finding) }).success,
    ).toBe(false);
  });
});
