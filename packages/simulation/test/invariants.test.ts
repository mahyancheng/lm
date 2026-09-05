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
import { ResolutionReportSchema, SIMULATION_INVARIANTS, SessionStateSchema, balanceSheetReconciles } from '@frontier/contracts';
import { hashState } from '@frontier/shared';
import { ENGINE_INVARIANTS, chainRowHash, isEventVisibleTo, audienceFor, projectResolutionOutcomeForPlayer, runInvariantGate } from '../src/resolver';
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

/** Close a fabricated row the way the recorder does: chained onto its predecessor. */
const chained = (previousRowHash: string, row: Omit<SimEvent, 'rowHash'>): SimEvent => {
  const unchained: SimEvent = { ...row, rowHash: '' };
  return { ...unchained, rowHash: chainRowHash(previousRowHash, unchained) };
};

/** A minimal, well-formed ledger row, so the reproducibility checks are happy. */
const agentRow = (state: SessionState): SimEvent =>
  chained(hashState(state), {
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
  it('checks every declared invariant', () => {
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
    const second = chained(first.rowHash, { ...first, eventId: 'evt_two', sequence: first.sequence + 4, stateHashBefore: first.stateHashAfter });
    expect(check(gate(state, [first, second]), 'auditability').passed).toBe(false);
  });

  it('catches a ledger row edited after it was written, without hashing the state again', () => {
    const state = createDemoSession();
    const row = agentRow(state);
    // Everything a state hash would notice is untouched: only the row's own
    // payload is rewritten, which is precisely what the row chain is for.
    const tampered: SimEvent = { ...row, payload: { agentRole: 'world_director', severityUsed: 99 } };
    expect(check(gate(state, [tampered]), 'deterministic_replay').passed).toBe(false);
    expect(check(gate(state, [row]), 'deterministic_replay').passed).toBe(true);
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
    player(2, { type: 'reserve_compute', units: 200 * (quarter + 1), quarters: 4, maxPricePerUnitUsd: 6_000, providerCompanyId: null }),
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
        { type: 'reserve_compute', units: 40_000, quarters: 6, maxPricePerUnitUsd: 5_000, providerCompanyId: null },
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

        // Passing is only worth something if the check ran: every active company
        // must have been compared against its own ledger, not skipped.
        const financial = outcome.invariants.find((result) => result.invariant === 'financial_integrity');
        expect(financial?.detail).not.toContain('could not be reconstructed');
        expect(financial?.detail).toContain(`${outcome.nextState.companies.filter((company) => company.isActive).length} balance sheets`);

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

/* -------------------------------------------------------------------------- */
/*  The information boundary, seat by seat                                     */
/* -------------------------------------------------------------------------- */

/**
 * The gate proves the *world* keeps its secrets. This proves the *screen* does.
 *
 * `resolveQuarter` returns the whole quarter — it has to, it is the engine — and
 * `projectResolutionOutcomeForPlayer` is what one seat is allowed to be handed.
 * Eight chaotic quarters of guidance, secret programmes, acquisitions and
 * accumulation, and at every one of them: nothing a rival keeps private reaches
 * the player, everything about the player does, every surviving line still cites
 * a row that survived with it, and no public payload anywhere carries the flag
 * that says whether a statement was true.
 */
describe.skipIf(engineModule === null)('the per-player projection', () => {
  it(
    'hands a player their own quarter and nobody else\'s, across eight chaotic quarters',
    () => {
      if (engineModule === null) return;
      const engine = engineModule.createDefaultEngine();
      let state = createDemoSession();
      let ownLinesSeen = 0;
      let rivalRowsWithheld = 0;
      let rivalSecretResearchRows = 0;
      let truthRowsRecorded = 0;

      for (let quarter = 0; quarter < 8; quarter += 1) {
        const script = chaosFor(state, quarter);
        const outcome = engine.resolver.resolveQuarter(state, script.actions, null, script.bundles);
        expect(outcome.committed).toBe(true);
        const session = outcome.nextState;

        // No public row anywhere says whether a statement was true. That fact is
        // canonical reality, and it is recorded privately or not at all.
        for (const event of outcome.events) {
          if (event.visibility !== 'public') continue;
          expect(Object.keys(event.payload)).not.toContain('isTruthful');
          expect(Object.keys(event.payload)).not.toContain('wasTruthfulWhenMade');
        }
        truthRowsRecorded += outcome.events.filter((event) => event.visibility === 'private' && event.payload.assessment === 'internal').length;

        const projected = projectResolutionOutcomeForPlayer(outcome, session, DEMO_PLAYER_ID);
        const audience = audienceFor(session, DEMO_PLAYER_ID);
        expect(audience.companyIds.has(DEMO_COMPANIES.player)).toBe(true);

        // Every row handed over is a row this seat may read...
        for (const event of projected.events) {
          expect(isEventVisibleTo(event, session, audience)).toBe(true);
        }
        // ...and every row withheld is one it may not.
        const withheld = outcome.events.filter((event) => !projected.events.includes(event));
        for (const event of withheld) {
          expect(isEventVisibleTo(event, session, audience)).toBe(false);
          expect(event.visibility).not.toBe('public');
        }

        // A rival's private research never appears, secret or merely internal.
        const rivalResearch = outcome.events.filter(
          (event) => event.type.startsWith('research_') && event.visibility !== 'public' && event.actorId !== null && event.actorId !== DEMO_COMPANIES.player,
        );
        rivalSecretResearchRows += rivalResearch.length;
        for (const event of rivalResearch) expect(projected.events).not.toContain(event);
        rivalRowsWithheld += withheld.length;

        // Every surviving line still cites a row that survived with it.
        const ids = new Set(projected.events.map((event) => event.eventId));
        for (const phase of projected.report.phases) {
          expect(phase.lines.length).toBeGreaterThan(0);
          for (const line of phase.lines) {
            expect(line.refEventIds.length).toBeGreaterThan(0);
            for (const ref of line.refEventIds) expect(ids.has(ref)).toBe(true);
          }
        }
        // And it is still a report: the schema does not bend for a projection.
        expect(() => ResolutionReportSchema.parse(projected.report)).not.toThrow();

        ownLinesSeen += projected.report.phases.flatMap((phase) => phase.lines).filter((line) => line.subjectId === DEMO_COMPANIES.player).length;
        state = session;
      }

      // The projection is not vacuous in either direction: the player's own
      // quarter reaches them, and a great deal of everyone else's does not.
      expect(ownLinesSeen).toBeGreaterThan(0);
      expect(rivalRowsWithheld).toBeGreaterThan(50);
      expect(rivalSecretResearchRows).toBeGreaterThan(0);
      expect(truthRowsRecorded).toBeGreaterThan(0);
    },
    180_000,
  );

  it(
    'shows a rival exactly the same quarter from the other side',
    () => {
      if (engineModule === null) return;
      const engine = engineModule.createDefaultEngine();
      const state = createDemoSession();
      // Seat a second player at Nexus, so the same quarter has two audiences.
      const rivalPlayerId = 'player_rival';
      state.players.push({
        playerId: rivalPlayerId,
        characterId: DEMO_CHARACTERS.maya,
        companyId: DEMO_COMPANIES.nexus,
        isHuman: true,
        displayName: 'Maya Chen',
        joinedQuarter: 0,
        autoExecuteRoutine: false,
        hasSubmittedThisQuarter: false,
        isActive: true,
      });
      const nexus = state.companies.find((company) => company.id === DEMO_COMPANIES.nexus);
      if (nexus === undefined) throw new Error('missing rival');
      nexus.controllerPlayerId = rivalPlayerId;

      const script = chaosFor(state, 0);
      const outcome = engine.resolver.resolveQuarter(state, script.actions, null, script.bundles);
      expect(outcome.committed).toBe(true);
      const session = outcome.nextState;

      const mine = projectResolutionOutcomeForPlayer(outcome, session, DEMO_PLAYER_ID);
      const theirs = projectResolutionOutcomeForPlayer(outcome, session, rivalPlayerId);

      const rowsOf = (view: { events: readonly { eventId: string }[] }): Set<string> => new Set(view.events.map((event) => event.eventId));
      const minesIds = rowsOf(mine);
      const theirsIds = rowsOf(theirs);
      expect(minesIds).not.toEqual(theirsIds);

      // Nexus keeps one secret programme. Its owner sees it; the player does not.
      const secret = session.researchProjects.find((project) => project.isSecret && project.companyId === DEMO_COMPANIES.nexus);
      expect(secret).toBeDefined();
      const secretRows = outcome.events.filter((event) => event.targetId === secret?.targetNodeId && event.actorId === DEMO_COMPANIES.nexus);
      expect(secretRows.length).toBeGreaterThan(0);
      for (const row of secretRows) {
        expect(theirsIds.has(row.eventId)).toBe(true);
        if (row.visibility !== 'public') expect(minesIds.has(row.eventId)).toBe(false);
      }
    },
    120_000,
  );
});

/* -------------------------------------------------------------------------- */
/*  A stake bought and sold                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The one equity movement the ledger cannot state outright.
 *
 * A sale realises a gain — cash in at the market, carrying value out of
 * investments — and the carrying value is not on the trade row. The invariant
 * reconstructs it from the investments line, which moves by exactly that and by
 * nothing else. Get the sign or the netting wrong and this quarter stops
 * committing, which is why it is worth resolving a real sale rather than
 * trusting the arithmetic.
 */
describe.skipIf(engineModule === null)('a stake bought and sold', () => {
  it(
    'commits the quarter in which a holding is sold at a profit',
    () => {
      if (engineModule === null) return;
      const engine = engineModule.createDefaultEngine();
      let state = createDemoSession();

      const trade = (intent: SubmittedAction['intent']): NpcActionBundle => ({
        companyId: DEMO_COMPANIES.aurora,
        strategySummary: 'Take the corpus business while it is cheap, and take the profit when it is not.',
        posture: 'consolidation',
        actions: [intent],
        rationale: 'Cash is piling up faster than the fab plan can spend it, and a listed corpus business is the cheapest thing in the sector.',
      });

      const bought = engine.resolver.resolveQuarter(
        state,
        [],
        null,
        [trade({ type: 'buy_shares', securityId: 'sec_meridian_common', targetPct: null, shares: 2_000_000, maxPricePerShareUsd: 60 })],
      );
      expect(bought.committed).toBe(true);
      expect(bought.events.some((event) => event.type === 'shares_traded' && event.payload.side === 'buy')).toBe(true);
      state = bought.nextState;

      const sold = engine.resolver.resolveQuarter(
        state,
        [],
        null,
        [trade({ type: 'sell_shares', securityId: 'sec_meridian_common', shares: 1_000_000, minPricePerShareUsd: 0 })],
      );
      const sale = sold.events.find((event) => event.type === 'shares_traded' && event.payload.side === 'sell');
      expect(sale).toBeDefined();
      expect(sold.committed).toBe(true);
      expect(check(sold.invariants, 'financial_integrity').passed).toBe(true);

      // The realised result really did move equity: the seller's books are not
      // simply unchanged by the trade.
      const aurora = sold.nextState.companies.find((company) => company.id === DEMO_COMPANIES.aurora);
      if (aurora === undefined) throw new Error('missing seller');
      expect(balanceSheetReconciles(aurora.balanceSheet)).toBe(true);
    },
    120_000,
  );
});

/* -------------------------------------------------------------------------- */
/*  A company wound up                                                         */
/* -------------------------------------------------------------------------- */

/**
 * The other equity movement that is not a trade, and the one the gate nearly
 * refused.
 *
 * `enterAdministration` realises the estate at a haircut and releases the
 * creditors it cannot pay. Both move equity, and neither is revenue nor cost, so
 * for a while the wind-up moved a balance sheet that the ledger did not explain
 * — which is exactly what `financial_integrity` exists to catch. The quarter a
 * company failed in was therefore refused, and the world rolled back to a state
 * that would fail again: the session could not proceed at all.
 *
 * The administration row now states that movement from its two causes, and this
 * test is the only thing in the suite that reaches administration through the
 * real resolver. The unit tests in `companies.test.ts` drive the phase directly
 * and never see the gate, which is why the deadlock went unnoticed.
 */
describe.skipIf(engineModule === null)('a company wound up in administration', () => {
  it(
    'commits the quarter it fails in, and every quarter after it',
    () => {
      if (engineModule === null) return;
      const engine = engineModule.createDefaultEngine();
      let state = createDemoSession();

      // The player's company with nothing in the bank, in a market that will not
      // rescue anybody: appetite is 0.5 liquidity + 0.3 risk + 0.2 standing, and
      // it has to stay below the floor for three quarters running.
      const target = state.companies.find((company) => company.id === DEMO_COMPANIES.player);
      if (target === undefined) throw new Error('demo has no player company');
      target.financials.cash = 0;
      target.balanceSheet.assets.cash = 0;
      target.balanceSheet.equity =
        target.balanceSheet.assets.ppe +
        target.balanceSheet.assets.goodwill +
        target.balanceSheet.assets.investments +
        target.balanceSheet.assets.receivables -
        (target.balanceSheet.liabilities.debt + target.balanceSheet.liabilities.payables + target.balanceSheet.liabilities.deferredRevenue);
      target.reputation.investor = 1;

      let administered = false;
      for (let quarter = 0; quarter < 6 && !administered; quarter += 1) {
        state.world.capitalMarkets.ventureLiquidity = 0.02;
        state.world.capitalMarkets.riskAppetite = 0.02;
        const outcome = engine.resolver.resolveQuarter(state, [], null, []);
        expect(outcome.invariants.filter((result) => !result.passed).map((result) => `${result.invariant}: ${result.detail}`)).toEqual([]);
        expect(outcome.committed).toBe(true);
        administered = outcome.events.some(
          (event) => event.actorId === DEMO_COMPANIES.player && event.type === 'information_revealed' && event.payload.kind === 'administration',
        );
        state = outcome.nextState;
      }
      expect(administered).toBe(true);

      // The husk keeps resolving. A wind-up that fails the gate one quarter later
      // is the same deadlock one step further on.
      for (let quarter = 0; quarter < 3; quarter += 1) {
        const outcome = engine.resolver.resolveQuarter(state, [], null, []);
        expect(outcome.invariants.filter((result) => !result.passed).map((result) => `${result.invariant}: ${result.detail}`)).toEqual([]);
        expect(outcome.committed).toBe(true);
        state = outcome.nextState;
      }

      const wound = state.companies.find((company) => company.id === DEMO_COMPANIES.player);
      if (wound === undefined) throw new Error('the husk vanished');
      expect(balanceSheetReconciles(wound.balanceSheet)).toBe(true);
      expect(wound.isActive).toBe(true);
      expect(wound.products.some((product) => product.isActive)).toBe(false);
    },
    120_000,
  );
});
