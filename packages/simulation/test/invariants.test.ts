/**
 * The invariant gate.
 *
 * Two halves, as in `determinism.test.ts`. The first drives `runInvariantGate`
 * directly against the demo world and against deliberately corrupted copies of
 * it, so each check is shown to catch the thing it is named after. The second
 * runs twelve quarters of deliberately chaotic instructions through the full
 * engine and requires that the gate never trips — the difference between "the
 * invariants are enforced" and "the invariants are enforceable".
 */

import { describe, expect, it } from 'vitest';
import type { InvariantCheckResult, NpcActionBundle, SessionState, SimEvent, SimulationInvariant, SubmittedAction } from '@frontier/contracts';
import { SIMULATION_INVARIANTS, SessionStateSchema, balanceSheetReconciles } from '@frontier/contracts';
import { hashState } from '@frontier/shared';
import { ENGINE_INVARIANTS, runInvariantGate } from '../src/resolver';
import { DEMO_CHARACTERS, DEMO_COMPANIES, DEMO_PLAYER_ID, createDemoSession } from '../src/scenario';

/* -------------------------------------------------------------------------- */
/*  The gate itself                                                            */
/* -------------------------------------------------------------------------- */

const gate = (state: SessionState, events: SimEvent[] = []): InvariantCheckResult[] => {
  const startSequence = events[0]?.sequence ?? state.ledgerSequence;
  // The recorder advances the counter as it emits; these fixtures fabricate the
  // rows directly, so the counter is advanced here instead.
  const draft: SessionState = { ...state, ledgerSequence: startSequence + events.length };
  return runInvariantGate({
    draft,
    events,
    lines: [],
    startSequence,
    preResolutionHash: hashState(state),
    droppedLines: 0,
    gmProposalWasPresent: true,
    quarterWasOpen: true,
  });
};

const check = (results: InvariantCheckResult[], invariant: SimulationInvariant): InvariantCheckResult => {
  const found = results.find((result) => result.invariant === invariant);
  if (found === undefined) throw new Error(`no result for ${invariant}`);
  return found;
};

/** A minimal, well-formed ledger row, so the reproducibility checks are happy. */
const agentRow = (state: SessionState): SimEvent => ({
  eventId: 'evt_agent',
  sessionId: state.sessionId,
  quarter: state.quarter,
  sequence: state.ledgerSequence,
  type: 'llm_call_logged',
  actorId: null,
  targetId: null,
  payload: { agentRole: 'world_director' },
  stateHashBefore: hashState(state),
  stateHashAfter: hashState(state),
  visibility: 'private',
});

describe('runInvariantGate', () => {
  it('checks all thirteen invariants', () => {
    const state = createDemoSession();
    const results = gate(state, [agentRow(state)]);
    expect(results).toHaveLength(SIMULATION_INVARIANTS.length);
    expect(results.map((result) => result.invariant).sort()).toEqual([...SIMULATION_INVARIANTS].sort());
  });

  it('passes cleanly on the demo world', () => {
    const state = createDemoSession();
    const failures = gate(state, [agentRow(state)]).filter((result) => !result.passed);
    expect(failures).toEqual([]);
  });

  it('catches a balance sheet that does not reconcile', () => {
    const state = createDemoSession();
    const company = state.companies[0];
    if (company === undefined) throw new Error('missing company');
    company.balanceSheet.equity += 2;
    expect(balanceSheetReconciles(company.balanceSheet)).toBe(false);
    const result = check(gate(state, [agentRow(state)]), 'financial_integrity');
    expect(result.passed).toBe(false);
    expect(result.detail).toContain(company.id);
  });

  it('catches a cap table that does not reconcile', () => {
    const state = createDemoSession();
    const table = state.capTables[0];
    const holding = table?.holdings[0];
    if (table === undefined || holding === undefined) throw new Error('missing cap table');
    holding.shares += 1_000;
    expect(check(gate(state, [agentRow(state)]), 'ownership_integrity').passed).toBe(false);
  });

  it('catches shares issued beyond their authorisation', () => {
    const state = createDemoSession();
    const shareClass = state.capTables[0]?.shareClasses[0];
    if (shareClass === undefined) throw new Error('missing share class');
    shareClass.authorisedShares = shareClass.issuedShares - 1;
    expect(check(gate(state, [agentRow(state)]), 'authoritative_backend').passed).toBe(false);
  });

  it('catches a non-positive or non-finite price', () => {
    const state = createDemoSession();
    const quote = state.quotes[0];
    if (quote === undefined) throw new Error('missing quote');
    quote.price = 0;
    expect(check(gate(state, [agentRow(state)]), 'market_integrity').passed).toBe(false);
  });

  it('catches a modifier on a path the registry does not know', () => {
    const state = createDemoSession();
    state.activeModifiers.push({
      id: 'mod_illegal',
      source: 'gm',
      target: 'world.compute.everything',
      operation: 'multiply',
      value: 2,
      decay: 'none',
      durationQuarters: 2,
      remainingQuarters: 2,
      appliedAtQuarter: 0,
      originEventId: null,
      reason: 'A path that does not exist.',
      elapsedQuarters: 0,
      effectiveValue: 2,
      lastAppliedQuarter: null,
      exhausted: false,
    });
    const result = check(gate(state, [agentRow(state)]), 'llm_containment');
    expect(result.passed).toBe(false);
    expect(result.detail).toContain('unregistered');
  });

  it('catches a secret programme named in a public disclosure', () => {
    const state = createDemoSession();
    const secret = state.researchProjects.find((project) => project.isSecret);
    if (secret === undefined) throw new Error('missing secret programme');
    state.disclosures.push({
      id: 'dsc_leak',
      companyId: DEMO_COMPANIES.nexus,
      quarter: state.quarter,
      kind: 'press_release',
      headline: 'An indiscreet release',
      body: `Programme ${secret.id} is behind schedule.`,
      metrics: {},
      credibility: 0.5,
      sourceCharacterId: null,
      isTruthful: true,
      beliefTopic: null,
    });
    expect(check(gate(state, [agentRow(state)]), 'information_boundary').passed).toBe(false);
  });

  it('catches markup smuggled into the technology graph', () => {
    const state = createDemoSession();
    const node = state.techGraph.nodes[0];
    if (node === undefined) throw new Error('missing node');
    node.summary = 'Scaling, and also <script>alert(1)</script>.';
    expect(check(gate(state, [agentRow(state)]), 'tech_graph_safety').passed).toBe(false);
  });

  it('catches a conversation containing somebody who does not exist', () => {
    const state = createDemoSession();
    state.conversations.push({
      id: 'cnv_intruder',
      sessionId: state.sessionId,
      kind: 'boardroom',
      participantCharacterIds: [DEMO_CHARACTERS.player, 'chr_nobody'],
      createdQuarter: 0,
      lastMessageQuarter: null,
      accessOverrideId: null,
      dealProposalIds: [],
      isModerated: true,
      messageCount: 0,
    });
    expect(check(gate(state, [agentRow(state)]), 'social_security').passed).toBe(false);
  });

  it('catches a broken ledger hash chain', () => {
    const state = createDemoSession();
    const row = { ...agentRow(state), stateHashBefore: 'not_the_previous_hash' };
    expect(check(gate(state, [row]), 'deterministic_replay').passed).toBe(false);
  });

  it('catches a gap in the ledger sequence', () => {
    const state = createDemoSession();
    const first = agentRow(state);
    const second: SimEvent = { ...first, eventId: 'evt_two', sequence: first.sequence + 4, stateHashBefore: first.stateHashAfter };
    expect(check(gate(state, [first, second]), 'auditability').passed).toBe(false);
  });

  it('catches a quarter that recorded neither a model decision nor a fallback', () => {
    const state = createDemoSession();
    expect(check(gate(state, []), 'agent_reproducibility').passed).toBe(false);
  });

  it('catches an outage with no fallback recorded', () => {
    const state = createDemoSession();
    const results = runInvariantGate({
      draft: state,
      events: [],
      lines: [],
      startSequence: state.ledgerSequence,
      preResolutionHash: hashState(state),
      droppedLines: 0,
      gmProposalWasPresent: false,
      quarterWasOpen: true,
    });
    expect(check(results, 'failure_mode').passed).toBe(false);
  });

  it('separates engine faults from world outcomes', () => {
    expect(ENGINE_INVARIANTS).toContain('deterministic_replay');
    expect(ENGINE_INVARIANTS).toContain('auditability');
    expect(ENGINE_INVARIANTS).not.toContain('financial_integrity');
    expect(ENGINE_INVARIANTS).not.toContain('ownership_integrity');
  });
});

/* -------------------------------------------------------------------------- */
/*  Twelve chaotic quarters                                                    */
/* -------------------------------------------------------------------------- */

const engineModule = await (async (): Promise<typeof import('../src/engine') | null> => {
  try {
    return await import('../src/engine');
  } catch {
    return null;
  }
})();

/**
 * A deliberately awkward quarter: spending the company does not have, positions
 * it cannot fund, board matters, public statements, procurement, deals and an
 * introduction request, all at once. Most of it will be clamped or refused —
 * that is the point. The gate must survive every path through the engine, not
 * just the tidy one.
 */
function chaosFor(state: SessionState, quarter: number): { actions: SubmittedAction[]; bundles: NpcActionBundle[] } {
  const player = (sequence: number, intent: SubmittedAction['intent']): SubmittedAction => ({
    actionId: `act_chaos_q${quarter}_${sequence}`,
    sessionId: state.sessionId,
    quarter,
    sequence,
    actorPlayerId: DEMO_PLAYER_ID,
    actorCompanyId: DEMO_COMPANIES.player,
    actorCharacterId: DEMO_CHARACTERS.player,
    origin: 'player_ui',
    intent,
    confirmedByHuman: true,
  });

  const actions: SubmittedAction[] = [
    player(0, { type: 'set_research_budget', budgetUsd: 900_000 * (quarter + 1) }),
    player(1, { type: 'hire', role: quarter % 2 === 0 ? 'engineers' : 'researchers', count: 3 + quarter, compBand: 'above_market' }),
    player(2, { type: 'reserve_compute', units: 200 * (quarter + 1), quarters: 4, maxPricePerUnitUsd: 6_000 }),
    player(3, {
      type: 'set_marketing_budget',
      allocations: [
        { segment: 'enterprise', budgetUsd: 400_000 },
        { segment: 'developer_api', budgetUsd: 150_000 },
      ],
    }),
    player(4, {
      type: 'social_post',
      draft: {
        authorCharacterId: DEMO_CHARACTERS.player,
        network: 'fast_feed',
        text: `Quarter ${quarter}: shipping faster than our runway says we should.`,
        intent: quarter % 3 === 0 ? 'announce' : 'hype',
        targetCompanyId: quarter % 4 === 0 ? DEMO_COMPANIES.vectorworks : null,
      },
    }),
    player(5, { type: 'buy_shares', securityId: 'sec_vectorworks_common', targetPct: null, shares: 5_000 * (quarter + 1), maxPricePerShareUsd: 25 }),
  ];

  if (quarter % 3 === 1) {
    actions.push(player(6, { type: 'raise_round', stage: 'series_a', targetAmountUsd: 12_000_000, maxDilutionPct: 0.25 }));
  }
  if (quarter % 4 === 2) {
    actions.push(
      player(7, {
        type: 'request_introduction',
        viaCharacterId: DEMO_CHARACTERS.eleanor,
        targetCharacterId: DEMO_CHARACTERS.nadia,
        purpose: 'Sovereign capital for a compute reservation we cannot fund alone.',
      }),
    );
  }
  if (quarter % 5 === 3) {
    actions.push(player(8, { type: 'layoff', role: 'engineers', count: 2, severanceQuartersOfPay: 1 }));
  }
  if (quarter === 5) {
    actions.push(
      player(9, {
        type: 'start_research_project',
        targetNodeId: 'tech_efficient_sparse_inference',
        budgetUsd: 400_000,
        computeUnits: 40,
        researchersAssigned: 2,
        secret: true,
      }),
    );
  }

  const bundles: NpcActionBundle[] = [
    {
      companyId: DEMO_COMPANIES.nexus,
      strategySummary: 'Spend ahead of the model, and take the compute market with us on the way.',
      posture: 'aggressive_growth',
      actions: [
        { type: 'set_research_budget', budgetUsd: 1_100_000_000 },
        { type: 'hire', role: 'researchers', count: 60, compBand: 'top_of_market' },
        { type: 'reserve_compute', units: 40_000, quarters: 6, maxPricePerUnitUsd: 5_000 },
        { type: 'give_guidance', metric: 'revenue', value: 2_200_000_000 + quarter * 50_000_000, quarter: quarter + 1 },
      ],
      rationale: 'The board bought a model schedule and the schedule is what has to be defended.',
    },
    {
      companyId: DEMO_COMPANIES.helix,
      strategySummary: 'Sell capacity to everyone, including the people trying to replace us.',
      posture: 'efficiency',
      actions: [
        { type: 'set_product_price', productId: 'prd_helix_reserved_capacity', pricePerSeatUsd: 6_240 + quarter * 120 },
        { type: 'issue_debt', amountUsd: 800_000_000, maxRatePct: 0.11, termQuarters: 20 },
      ],
      rationale: 'Capacity is capital: the cheapest debt in the sector is the whole competitive position.',
    },
    {
      companyId: DEMO_COMPANIES.aurora,
      strategySummary: 'Allocate scarce silicon the way a sovereign allocates favours.',
      posture: 'consolidation',
      actions: [
        { type: 'buyback', budgetUsd: 900_000_000, maxPricePerShareUsd: 140 },
        { type: 'buy_shares', securityId: 'sec_meridian_common', targetPct: null, shares: 2_000_000, maxPricePerShareUsd: 30 },
      ],
      rationale: 'Cash is piling up faster than the fab plan can spend it, and the corpus business is cheap.',
    },
  ];

  if (quarter === 6) {
    bundles.push({
      companyId: DEMO_COMPANIES.orbit,
      strategySummary: 'Buy the retrieval technology rather than rebuild it, while the price is on the floor.',
      posture: 'consolidation',
      actions: [
        { type: 'acquire_company', targetCompanyId: DEMO_COMPANIES.vectorworks, offerValueUsd: 2_400_000_000, cashPct: 0.5, stockPct: 0.5 },
      ],
      rationale: 'VectorWorks has the retrieval stack our enterprise base keeps asking for and four quarters of cash left.',
    });
  }

  return { actions, bundles };
}

describe.skipIf(engineModule === null)('twelve chaotic quarters', () => {
  it(
    'never trips an invariant, and leaves a contiguous ledger behind it',
    () => {
      if (engineModule === null) return;
      const engine = engineModule.createDefaultEngine();
      let state = createDemoSession();
      let expectedSequence = state.ledgerSequence;
      let totalEvents = 0;

      for (let quarter = 0; quarter < 12; quarter += 1) {
        const script = chaosFor(state, quarter);
        const outcome = engine.resolver.resolveQuarter(state, script.actions, null, script.bundles);

        const failures = outcome.invariants.filter((result) => !result.passed);
        expect(failures.map((failure) => `${failure.invariant}: ${failure.detail}`)).toEqual([]);
        expect(outcome.committed).toBe(true);

        // The ledger runs on without a gap or a rewind, quarter after quarter.
        outcome.events.forEach((event, index) => {
          expect(event.sequence).toBe(expectedSequence + index);
          expect(event.quarter).toBe(quarter);
        });
        expectedSequence += outcome.events.length;
        totalEvents += outcome.events.length;
        expect(outcome.nextState.ledgerSequence).toBe(expectedSequence);

        // And the two invariants that matter most hold company by company.
        for (const company of outcome.nextState.companies) {
          if (!company.isActive) continue;
          expect(balanceSheetReconciles(company.balanceSheet)).toBe(true);
          expect(Number.isFinite(company.financials.cash)).toBe(true);
        }
        for (const table of outcome.nextState.capTables) {
          for (const shareClass of table.shareClasses) {
            expect(table.totalIssuedByClass[shareClass.id]).toBe(shareClass.issuedShares);
          }
        }

        expect(outcome.nextState.quarter).toBe(quarter + 1);
        expect(outcome.nextState.pendingActions).toHaveLength(0);
        state = outcome.nextState;
      }

      expect(totalEvents).toBeGreaterThan(100);
      expect(state.quarter).toBe(12);
      expect(state.lastResolvedQuarter).toBe(11);
      expect(state.leaderboards).toHaveLength(10);

      // After three years of abuse the aggregate still satisfies its own schema,
      // span-scaled modifier operands included.
      const parsed = SessionStateSchema.safeParse(state);
      expect(parsed.success ? [] : parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`)).toEqual([]);
    },
    180_000,
  );

  it(
    'keeps quotes positive and finite through every quarter',
    () => {
      if (engineModule === null) return;
      const engine = engineModule.createDefaultEngine();
      let state = createDemoSession();
      for (let quarter = 0; quarter < 6; quarter += 1) {
        const script = chaosFor(state, quarter);
        const outcome = engine.resolver.resolveQuarter(state, script.actions, null, script.bundles);
        expect(outcome.committed).toBe(true);
        for (const quote of outcome.nextState.quotes) {
          expect(quote.price).toBeGreaterThan(0);
          expect(Number.isFinite(quote.price)).toBe(true);
          expect(quote.return).toBeGreaterThanOrEqual(-1);
        }
        state = outcome.nextState;
      }
    },
    120_000,
  );
});
