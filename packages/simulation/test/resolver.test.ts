/**
 * The quarter resolver, driven entirely by stub subsystems.
 *
 * The point of the exercise: phase order, the fork-per-phase rule, the
 * idempotency guard, the World Director gate, action collection, the capital
 * phase, the disclosure bridge, the leaderboards and the invariant gate are all
 * properties of the resolver itself, and they are verified here without a single
 * line of economy, market or company code. The subsystems are injected, so they
 * can be replaced by recorders.
 */

import { describe, expect, it } from 'vitest';
import type {
  BoardsSubsystem,
  CompaniesSubsystem,
  EconomySubsystem,
  GmProposalBatch,
  GovernmentSubsystem,
  MarketsSubsystem,
  NpcActionBundle,
  RelationshipsSubsystem,
  ResearchSubsystem,
  ResolverContext,
  SessionState,
  SocialSubsystem,
  SubmittedAction,
  Subsystems,
  WorldEventCandidate,
} from '@frontier/contracts';
import { RESOLUTION_PHASES, ResolutionReportSchema, SIMULATION_INVARIANTS, SessionSnapshotSchema, SessionStateSchema, SimEventSchema, balanceSheetReconciles, makeId } from '@frontier/contracts';
import { createStateHasher } from '@frontier/shared';
import type { NpcBundleInput } from '../src/resolver';
import { InvariantViolationError, chainRowHash, createQuarterResolver, projectResolutionOutcomeForPlayer } from '../src/resolver';
import { createActionValidator } from '../src/validator';
import { DEMO_CHARACTERS, DEMO_COMPANIES, DEMO_PLAYER_ID, createDemoSession } from '../src/scenario';

/** The hasher the resolver uses by default: money rounded to the cent. */
const engineHash = createStateHasher(2);

/* -------------------------------------------------------------------------- */
/*  Stubs                                                                      */
/* -------------------------------------------------------------------------- */

interface Call {
  readonly method: string;
  readonly draw: number;
  readonly quarter: number;
}

interface StubOptions {
  /** Candidates the hazard engine "drew" this quarter. */
  readonly candidates?: readonly WorldEventCandidate[];
  /** Give the economy a `materialiseCandidate`, as the real one has. */
  readonly canMaterialise?: boolean;
  /** Corrupt a balance sheet during the financial phase. */
  readonly breakBalanceSheet?: boolean;
  /**
   * Mint an asset and the equity to match it, writing no ledger row.
   *
   * This is the corruption the stored identity cannot see: the sheet still
   * reconciles afterwards, exactly as it does when `resolveFinancials` derives
   * closing equity from a sheet an earlier phase quietly unbalanced. Only a
   * check that reads the ledger can tell that nobody issued this equity.
   */
  readonly mintEquity?: boolean;
  /** Log a report line pointing at a ledger row that does not exist. */
  readonly logPhantomReference?: boolean;
  /** Emit one ledger row and one line from the macro step. */
  readonly narrate?: boolean;
}

interface Stubs {
  readonly subsystems: Subsystems;
  readonly calls: Call[];
}

function makeStubs(options: StubOptions = {}): Stubs {
  const calls: Call[] = [];
  const record = (method: string, ctx: ResolverContext): void => {
    calls.push({ method, draw: ctx.rng.next(), quarter: ctx.quarter });
  };

  const economy: EconomySubsystem & { materialiseCandidate?: unknown } = {
    // The priced economy is a no-op in this stub: the pipeline tests are about
    // phase order and the fork-per-phase rule, not about goods prices.
    priceSectors() {
      // Deliberately silent: recording here would consume a draw and change the
      // call sequence these tests exist to pin.
    },
    updateMacro(draft, ctx) {
      record('economy.updateMacro', ctx);
      if (options.narrate !== false) {
        const eventId = ctx.emit({
          sessionId: draft.sessionId,
          quarter: ctx.quarter,
          type: 'world_event_applied',
          actorId: null,
          targetId: 'world',
          payload: { kind: 'stub_drift' },
          visibility: 'public',
        });
        ctx.log({
          phase: 'world_events',
          text: 'The world moved on its own dynamics.',
          deltaLabel: null,
          refEventIds: [eventId],
          tone: 'neutral',
          subjectId: null,
        });
      }
      if (options.logPhantomReference === true) {
        ctx.log({
          phase: 'world_events',
          text: 'A line that claims a ledger row nobody wrote.',
          deltaLabel: null,
          refEventIds: ['evt_does_not_exist'],
          tone: 'neutral',
          subjectId: null,
        });
      }
    },
    computeEventCandidates(_draft, ctx) {
      record('economy.computeEventCandidates', ctx);
      return [...(options.candidates ?? [])];
    },
    applyModifiers(_draft, ctx) {
      record('economy.applyModifiers', ctx);
    },
    decayModifiers(_draft, ctx) {
      record('economy.decayModifiers', ctx);
    },
    applyGmProposals(draft, batch, _candidates, ctx) {
      record('economy.applyGmProposals', ctx);
      for (const proposal of batch.proposals) {
        ctx.emit({
          sessionId: draft.sessionId,
          quarter: ctx.quarter,
          type: 'world_event_generated',
          actorId: null,
          targetId: proposal.event.candidateId,
          payload: { severity: proposal.event.severity, modifiers: proposal.modifiers.length },
          visibility: 'public',
        });
      }
    },
    revealInformation(_draft, ctx) {
      record('economy.revealInformation', ctx);
    },
  };
  if (options.canMaterialise === true) {
    economy.materialiseCandidate = (draft: SessionState, candidate: WorldEventCandidate, ctx: ResolverContext) => {
      record('economy.materialiseCandidate', ctx);
      ctx.emit({
        sessionId: draft.sessionId,
        quarter: ctx.quarter,
        type: 'world_event_generated',
        actorId: null,
        targetId: candidate.candidateId,
        payload: { materialised: true, severity: candidate.suggestedSeverity },
        visibility: 'public',
      });
      return null;
    };
  }

  const markets: MarketsSubsystem = {
    computeValuationAnchor(_draft, companyId) {
      return { companyId, quarter: 0, method: 'revenue_multiple', inputs: {}, anchorValueUsd: 0, perShareValueUsd: null, confidence: 0.5 };
    },
    updateBeliefs(_draft, ctx) {
      record('markets.updateBeliefs', ctx);
    },
    priceMarket(_draft, ctx) {
      record('markets.priceMarket', ctx);
      return [];
    },
    settleTrades(_draft, ctx) {
      record('markets.settleTrades', ctx);
    },
  };

  const companies: CompaniesSubsystem = {
    resolveHiring(_draft, ctx) {
      record('companies.resolveHiring', ctx);
    },
    resolveProducts(_draft, ctx) {
      record('companies.resolveProducts', ctx);
    },
    resolveFinancials(draft, ctx) {
      record('companies.resolveFinancials', ctx);
      if (options.breakBalanceSheet === true) {
        const company = draft.companies[0];
        if (company !== undefined) company.balanceSheet.equity += 1_000_000;
      }
      if (options.mintEquity === true) {
        const company = draft.companies[0];
        if (company !== undefined) {
          company.balanceSheet.assets.cash += 1_000_000;
          company.balanceSheet.equity += 1_000_000;
        }
      }
      return { pnl: [], balanceChecks: [] };
    },
    applyNpcDefaults(_draft, ctx) {
      record('companies.applyNpcDefaults', ctx);
    },
    recomputeMetrics(_draft, ctx) {
      record('companies.recomputeMetrics', ctx);
    },
  };

  const research: ResearchSubsystem = {
    advanceProjects(_draft, ctx) {
      record('research.advanceProjects', ctx);
    },
    updateTechConfidence(_draft, ctx) {
      record('research.updateTechConfidence', ctx);
      return [];
    },
    achieveNodes(_draft, ctx) {
      record('research.achieveNodes', ctx);
    },
    integrateInnovationProposal(_draft, _proposal, ctx) {
      record('research.integrateInnovationProposal', ctx);
      return { accepted: false, nodeId: null, reasons: ['stub'], adjustedPlausibility: 0.5, adjustedCostUsd: 0, adjustedQuarters: 1 };
    },
  };

  const government: GovernmentSubsystem = {
    openOpportunities(_draft, ctx) {
      record('government.openOpportunities', ctx);
    },
    scoreBids(_draft, ctx) {
      record('government.scoreBids', ctx);
      return [];
    },
    awardContracts(_draft, ctx) {
      record('government.awardContracts', ctx);
    },
    advanceMilestones(_draft, ctx) {
      record('government.advanceMilestones', ctx);
    },
  };

  const boards: BoardsSubsystem = {
    tallyProposal(_draft, proposalId) {
      return { proposalId, support: 0, against: 0, abstain: 0, absent: 0, quorumMet: false, passes: false, perDirector: [], decidedByControl: false, controllingHolderId: null };
    },
    resolveProposals(_draft, ctx) {
      record('boards.resolveProposals', ctx);
    },
    applyCommitments(_draft, ctx) {
      record('boards.applyCommitments', ctx);
    },
  };

  const relationships: RelationshipsSubsystem = {
    updateRelationships(_draft, ctx) {
      record('relationships.updateRelationships', ctx);
    },
    decayMemories(_draft, ctx) {
      record('relationships.decayMemories', ctx);
    },
    recomputeConnectionLevels(_draft, ctx) {
      record('relationships.recomputeConnectionLevels', ctx);
    },
    checkAccess(_draft, a, b) {
      return { allowed: a !== b, reason: 'stub', overrideId: null, gap: 0 };
    },
  };

  const social: SocialSubsystem = {
    propagatePosts(_draft, ctx) {
      record('social.propagatePosts', ctx);
      return [];
    },
    updateMediaStories(_draft, ctx) {
      record('social.updateMediaStories', ctx);
    },
  };

  return {
    calls,
    subsystems: { economy, markets, companies, research, government, boards, relationships, social, actionValidator: createActionValidator() },
  };
}

/** The order the resolver must call the subsystems in, phase by phase. */
const EXPECTED_CALL_ORDER = [
  'economy.updateMacro',
  'economy.computeEventCandidates',
  'economy.applyGmProposals',
  'economy.applyModifiers',
  'economy.decayModifiers',
  'economy.revealInformation',
  'companies.applyNpcDefaults',
  'boards.applyCommitments',
  'boards.resolveProposals',
  'government.openOpportunities',
  'government.scoreBids',
  'government.awardContracts',
  'government.advanceMilestones',
  'companies.resolveHiring',
  'research.advanceProjects',
  'research.achieveNodes',
  'research.updateTechConfidence',
  'companies.resolveProducts',
  'companies.resolveFinancials',
  'markets.updateBeliefs',
  'markets.priceMarket',
  'markets.settleTrades',
  'social.propagatePosts',
  'social.updateMediaStories',
  'relationships.updateRelationships',
  'relationships.decayMemories',
  'relationships.recomputeConnectionLevels',
  'companies.recomputeMetrics',
];

/** The first call inside each phase, used to prove the streams are forked. */
const PHASE_ENTRY_CALLS = [
  'economy.updateMacro',
  'economy.applyModifiers',
  'economy.revealInformation',
  'companies.applyNpcDefaults',
  'boards.applyCommitments',
  'government.openOpportunities',
  'companies.resolveHiring',
  'research.advanceProjects',
  'companies.resolveProducts',
  'companies.resolveFinancials',
  'markets.updateBeliefs',
  'social.propagatePosts',
  'relationships.updateRelationships',
  'companies.recomputeMetrics',
];

const candidate = (id: string, familyId: string): WorldEventCandidate => ({
  candidateId: id,
  familyId,
  familyLabel: 'Compute supply disruption',
  allowedTypes: ['compute_supply_shock'],
  severityBand: [0.2, 0.5],
  suggestedSeverity: 0.35,
  defaultVisibility: 'public',
  maxDurationQuarters: 3,
  causalParentId: null,
  suggestedTargetPaths: ['world.compute.acceleratorSupply'],
  relevantWorldReadings: [{ path: 'world.compute.acceleratorSupply', value: 0.41, label: 'Accelerator supply' }],
  affectedSectorIds: ['semiconductors'],
});

const proposalBatch = (severity: number, target: string): GmProposalBatch => ({
  proposals: [
    {
      event: {
        candidateId: 'cnd_1',
        familyId: 'fam_compute_supply',
        type: 'compute_supply_shock',
        titleKey: 'advanced_packaging_disruption',
        title: 'Advanced packaging capacity disrupted',
        description: 'A packaging plant fire removed a fifth of advanced packaging capacity from the market for at least two quarters.',
        severity,
        visibility: 'public',
        durationQuarters: 9,
        causalParentId: null,
        affectedSectorIds: ['semiconductors'],
      },
      modifiers: [
        { target, operation: 'multiply', value: 3.4, decay: 'linear', durationQuarters: 3, reason: 'Packaging capacity is the binding constraint.' },
        { target: 'world.nonsense.path', operation: 'add', value: 0.1, decay: 'none', durationQuarters: 2, reason: 'Not a registered path.' },
      ],
      rationale: 'The hazard engine drew a compute supply family and this is the most plausible instance of it.',
      confidence: 0.8,
    },
  ],
  quarterSummary: 'Packaging capacity disrupted; compute pricing followed within the quarter.',
});

const resolve = (state: SessionState, stubs: Stubs, gm: GmProposalBatch | null = null, actions: SubmittedAction[] = [], npc: NpcBundleInput[] = []) =>
  createQuarterResolver(stubs.subsystems).resolveQuarter(state, actions, gm, npc);

/** One instruction, attributed to a company and the character giving it. */
const submittedFor = (intent: SubmittedAction['intent'], companyId: string, characterId: string, sequence = 1): SubmittedAction => ({
  actionId: `act_${intent.type}_${sequence}`,
  sessionId: createDemoSession().sessionId,
  quarter: 0,
  sequence,
  actorPlayerId: null,
  actorCompanyId: companyId,
  actorCharacterId: characterId,
  origin: 'npc_strategist',
  intent,
  confirmedByHuman: false,
});

/* -------------------------------------------------------------------------- */
/*  Phase order and streams                                                    */
/* -------------------------------------------------------------------------- */

describe('the pipeline', () => {
  it('runs the eighteen phases in the order the contract declares', () => {
    expect(RESOLUTION_PHASES).toHaveLength(18);
    const stubs = makeStubs();
    resolve(createDemoSession(), stubs, proposalBatch(0.35, 'world.compute.acceleratorSupply'));
    expect(stubs.calls.map((call) => call.method)).toEqual(EXPECTED_CALL_ORDER);
  });

  it('forks an independent random stream for every phase', () => {
    const stubs = makeStubs();
    resolve(createDemoSession(), stubs, proposalBatch(0.35, 'world.compute.acceleratorSupply'));
    const entryDraws = PHASE_ENTRY_CALLS.map((method) => stubs.calls.find((call) => call.method === method)?.draw);
    expect(entryDraws.every((draw) => typeof draw === 'number')).toBe(true);
    expect(new Set(entryDraws).size).toBe(PHASE_ENTRY_CALLS.length);
  });

  it('draws the same numbers from the same state and different ones from a different seed', () => {
    const first = makeStubs();
    resolve(createDemoSession(), first, null);
    const second = makeStubs();
    resolve(createDemoSession(), second, null);
    expect(second.calls).toEqual(first.calls);

    const other = makeStubs();
    resolve(createDemoSession(99), other, null);
    expect(other.calls.map((c) => c.draw)).not.toEqual(first.calls.map((c) => c.draw));
  });

  it('advances the quarter, records the resolution and returns a post-commit snapshot', () => {
    const state = createDemoSession();
    const outcome = resolve(state, makeStubs(), null);
    expect(outcome.committed).toBe(true);
    expect(outcome.nextState.quarter).toBe(1);
    expect(outcome.nextState.lastResolvedQuarter).toBe(0);
    expect(outcome.nextState.status).toBe('active');
    expect(outcome.snapshot.phase).toBe('post_commit');
    expect(outcome.snapshot.stateHash).toBe(outcome.report.stateHashAfter);
    expect(outcome.report.stateHashBefore).toBe(engineHash(state));
    // The incoming state is never mutated.
    expect(state.quarter).toBe(0);
  });

  it('reports timings that are zero, because the engine may not read a clock', () => {
    const outcome = resolve(createDemoSession(), makeStubs(), null);
    expect(outcome.phaseTimings).toHaveLength(18);
    expect(outcome.phaseTimings.every((timing) => timing.durationMs === 0)).toBe(true);
    expect(outcome.phaseTimings.reduce((sum, timing) => sum + timing.eventsEmitted, 0)).toBeGreaterThan(0);
  });
});

/* -------------------------------------------------------------------------- */
/*  Idempotency                                                                */
/* -------------------------------------------------------------------------- */

describe('idempotency', () => {
  it('refuses a quarter that has already committed, and mutates nothing', () => {
    const state = createDemoSession();
    const stubs = makeStubs();
    const first = resolve(state, stubs, null);
    expect(first.committed).toBe(true);

    const replayStubs = makeStubs();
    const again = createQuarterResolver(replayStubs.subsystems).resolveQuarter(
      { ...first.nextState, quarter: first.nextState.quarter - 1 },
      [],
      null,
      [],
    );
    expect(again.committed).toBe(false);
    expect(again.events).toHaveLength(0);
    expect(again.report.phases).toHaveLength(0);
    expect(replayStubs.calls).toHaveLength(0);
    expect(again.invariants.some((result) => result.invariant === 'idempotency' && !result.passed)).toBe(true);
  });

  it('refuses to resolve a completed session', () => {
    const state = createDemoSession();
    const outcome = resolve({ ...state, status: 'completed' }, makeStubs(), null);
    expect(outcome.committed).toBe(false);
  });

  it('is deterministic: two runs from the same state produce the same hash and ledger', () => {
    const state = createDemoSession();
    const a = resolve(state, makeStubs(), null);
    const b = resolve(state, makeStubs(), null);
    expect(b.report.stateHashAfter).toBe(a.report.stateHashAfter);
    expect(b.events.map((event) => [event.sequence, event.type, event.stateHashAfter])).toEqual(
      a.events.map((event) => [event.sequence, event.type, event.stateHashAfter]),
    );
  });
});

/* -------------------------------------------------------------------------- */
/*  The World Director gate                                                    */
/* -------------------------------------------------------------------------- */

describe('the World Director gate', () => {
  it('clamps severity into the candidate band and drops an unregistered target', () => {
    const stubs = makeStubs({ candidates: [candidate('cnd_1', 'fam_compute_supply')] });
    let seen: GmProposalBatch | null = null;
    const economy = stubs.subsystems.economy;
    const original = economy.applyGmProposals.bind(economy);
    economy.applyGmProposals = (draft, batch, candidates, ctx) => {
      seen = batch;
      original(draft, batch, candidates, ctx);
    };

    const outcome = resolve(createDemoSession(), stubs, proposalBatch(0.98, 'world.compute.acceleratorSupply'));
    const batch = seen as GmProposalBatch | null;
    expect(batch).not.toBeNull();
    const proposal = batch?.proposals[0];
    expect(proposal?.event.severity).toBe(0.5); // clamped into [0.2, 0.5]
    expect(proposal?.event.durationQuarters).toBe(3); // clamped to the candidate's maximum
    expect(proposal?.modifiers).toHaveLength(1); // the unregistered path is gone
    expect(proposal?.modifiers[0]?.value).toBeCloseTo(1.35, 9); // 3.4x capped by the impact budget

    expect(outcome.events.some((event) => event.type === 'modifier_rejected')).toBe(true);
    expect(outcome.events.some((event) => event.type === 'llm_call_logged')).toBe(true);
  });

  it('uses the proposal summary as the quarter headline', () => {
    const outcome = resolve(createDemoSession(), makeStubs(), proposalBatch(0.3, 'world.compute.acceleratorSupply'));
    expect(outcome.report.headline).toBe('Packaging capacity disrupted; compute pricing followed within the quarter.');
  });

  it('falls back deterministically when there is no proposal at all', () => {
    const stubs = makeStubs({ candidates: [candidate('cnd_1', 'fam_compute_supply')] });
    const outcome = resolve(createDemoSession(), stubs, null);
    expect(outcome.committed).toBe(true);
    expect(outcome.events.some((event) => event.type === 'fallback_engaged')).toBe(true);
    expect(outcome.events.some((event) => event.type === 'llm_call_logged')).toBe(false);
    expect(outcome.invariants.find((result) => result.invariant === 'failure_mode')?.passed).toBe(true);
    // With no materialiser on this economy, the candidates are handed back
    // through applyGmProposals as a plain fallback batch.
    expect(stubs.calls.some((call) => call.method === 'economy.applyGmProposals')).toBe(true);
  });

  it('prefers the economy own materialiser when it has one', () => {
    const stubs = makeStubs({ candidates: [candidate('cnd_1', 'fam_compute_supply')], canMaterialise: true });
    const outcome = resolve(createDemoSession(), stubs, null);
    expect(stubs.calls.some((call) => call.method === 'economy.materialiseCandidate')).toBe(true);
    expect(stubs.calls.some((call) => call.method === 'economy.applyGmProposals')).toBe(false);
    expect(outcome.events.some((event) => event.type === 'fallback_engaged')).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/*  Action collection                                                          */
/* -------------------------------------------------------------------------- */

describe('action collection', () => {
  const hire = (count: number): SubmittedAction => ({
    actionId: 'act_hire',
    sessionId: createDemoSession().sessionId,
    quarter: 0,
    sequence: 1,
    actorPlayerId: DEMO_PLAYER_ID,
    actorCompanyId: DEMO_COMPANIES.player,
    actorCharacterId: DEMO_CHARACTERS.player,
    origin: 'player_ui',
    intent: { type: 'hire', role: 'engineers', count, compBand: 'market' },
    confirmedByHuman: true,
  });

  it('reduces pendingActions to what will actually run, then clears it at commit', () => {
    const state = createDemoSession();
    const outcome = resolve(state, makeStubs(), null, [hire(2)]);
    expect(outcome.committed).toBe(true);
    expect(outcome.nextState.pendingActions).toHaveLength(0);
    expect(outcome.events.some((event) => event.type === 'action_accepted')).toBe(true);
  });

  it('rewrites a clamped action to the form that will run', () => {
    const state = createDemoSession();
    const stubs = makeStubs();
    let observed: SubmittedAction[] = [];
    const companies = stubs.subsystems.companies;
    companies.resolveHiring = (draft) => {
      observed = draft.pendingActions.map((action) => ({ ...action }));
    };
    resolve(state, stubs, null, [hire(5_000)]);
    const intent = observed[0]?.intent;
    expect(intent?.type).toBe('hire');
    if (intent?.type !== 'hire') throw new Error('expected a hire');
    expect(intent.count).toBeLessThan(5_000);
    expect(intent.count).toBeGreaterThan(0);
  });

  it('drops a rejected action entirely and records why', () => {
    const state = createDemoSession();
    const stubs = makeStubs();
    let observed = 0;
    stubs.subsystems.companies.resolveHiring = (draft) => {
      observed = draft.pendingActions.length;
    };
    const outcome = resolve(state, stubs, null, [{ ...hire(1), actorCompanyId: 'cmp_ghost' }]);
    expect(observed).toBe(0);
    const rejection = outcome.events.find((event) => event.type === 'action_rejected');
    expect(rejection).toBeDefined();
    expect(outcome.report.phases.some((phase) => phase.phase === 'action_collection')).toBe(true);
  });

  it('validates NPC bundles by exactly the same rules', () => {
    const state = createDemoSession();
    const stubs = makeStubs();
    let observed: SubmittedAction[] = [];
    stubs.subsystems.companies.resolveHiring = (draft) => {
      observed = draft.pendingActions.map((action) => ({ ...action }));
    };
    const bundle: NpcActionBundle = {
      companyId: DEMO_COMPANIES.meridian,
      strategySummary: 'Hold the corpus advantage and keep hiring researchers ahead of the market.',
      posture: 'research_first',
      actions: [
        { type: 'hire', role: 'researchers', count: 4, compBand: 'above_market' },
        { type: 'hire', role: 'researchers', count: 4_000_000, compBand: 'top_of_market' },
      ],
      rationale: 'Researchers are the binding constraint on everything Meridian is trying to prove.',
    };
    resolve(state, stubs, null, [], [bundle]);

    expect(observed).toHaveLength(2);
    const clamped = observed[1]?.intent;
    if (clamped?.type !== 'hire') throw new Error('expected a hire');
    expect(clamped.count).toBeLessThan(4_000_000);
    expect(observed.every((action) => action.actorPlayerId === null)).toBe(true);
    expect(observed.every((action) => action.actorCharacterId === DEMO_CHARACTERS.kenji)).toBe(true);
  });

  /** A well-formed bundle for whichever company it names. */
  const bundleFor = (companyId: string, budgetUsd = 1_000_000): NpcActionBundle => ({
    companyId,
    strategySummary: 'Fund the programme the board bought and defend the schedule it was sold on.',
    posture: 'research_first',
    actions: [{ type: 'set_research_budget', budgetUsd }],
    rationale: 'The model schedule is the only thing this board is really buying, so it is the thing to protect.',
  });

  const observePending = (stubs: Stubs): { seen: SubmittedAction[] } => {
    const seen: SubmittedAction[] = [];
    stubs.subsystems.companies.applyNpcDefaults = (draft) => {
      for (const action of draft.pendingActions) seen.push({ ...action });
    };
    return { seen };
  };

  it('refuses a bundle that names a company its strategist was not asked to run', () => {
    const state = createDemoSession();
    const stubs = makeStubs();
    const observed = observePending(stubs);
    // Nexus's strategist sees Nexus's private position. It returned Orbit.
    const outcome = resolve(state, stubs, null, [], [{ requestedCompanyId: DEMO_COMPANIES.nexus, bundle: bundleFor(DEMO_COMPANIES.orbit, 1_560_000_000) }]);

    expect(observed.seen).toHaveLength(0);
    const refusal = outcome.events.find((event) => event.type === 'action_rejected' && event.payload.scope === 'bundle');
    expect(refusal?.payload.code).toBe('company_mismatch');
    expect(refusal?.payload.requestedCompanyId).toBe(DEMO_COMPANIES.nexus);
    expect(refusal?.payload.claimedCompanyId).toBe(DEMO_COMPANIES.orbit);
    // A containment record is engine business, not news.
    expect(refusal?.visibility).toBe('private');
    expect(outcome.committed).toBe(true);
  });

  it('accepts the same bundle when it names the company it was asked about', () => {
    const state = createDemoSession();
    const stubs = makeStubs();
    const observed = observePending(stubs);
    resolve(state, stubs, null, [], [{ requestedCompanyId: DEMO_COMPANIES.orbit, bundle: bundleFor(DEMO_COMPANIES.orbit) }]);
    expect(observed.seen.map((action) => action.actorCompanyId)).toEqual([DEMO_COMPANIES.orbit]);
  });

  it('refuses a bundle for a company a human directs, and one for a company that does not exist', () => {
    const state = createDemoSession();
    const stubs = makeStubs();
    const observed = observePending(stubs);
    const outcome = resolve(state, stubs, null, [], [bundleFor(DEMO_COMPANIES.player), bundleFor('cmp_ghost')]);

    expect(observed.seen).toHaveLength(0);
    const codes = outcome.events.filter((event) => event.payload.scope === 'bundle').map((event) => event.payload.code);
    expect(codes).toContain('not_npc_controlled');
    expect(codes).toContain('unknown_company');
  });

  it('honours one bundle per company, so two cannot collide on the same action ids', () => {
    const state = createDemoSession();
    const stubs = makeStubs();
    const observed = observePending(stubs);
    const outcome = resolve(state, stubs, null, [], [bundleFor(DEMO_COMPANIES.orbit, 111_000_000), bundleFor(DEMO_COMPANIES.orbit, 222_000_000)]);

    expect(observed.seen).toHaveLength(1);
    const intent = observed.seen[0]?.intent;
    if (intent?.type !== 'set_research_budget') throw new Error('expected a research budget');
    // The first bundle to arrive is the one that runs; the second is refused
    // rather than silently overwriting it through a duplicate action id.
    expect(intent.budgetUsd).toBe(111_000_000);
    expect(outcome.events.some((event) => event.payload.code === 'duplicate_bundle')).toBe(true);
    expect(new Set(observed.seen.map((action) => action.actionId)).size).toBe(observed.seen.length);
  });

  it('refuses an instruction whose shape is out of contract rather than dying on it', () => {
    const state = createDemoSession();
    const stubs = makeStubs();
    let reached = 0;
    stubs.subsystems.social.propagatePosts = (draft) => {
      reached = draft.pendingActions.length;
      return [];
    };
    const outcome = resolve(state, stubs, null, [
      {
        ...hire(1),
        actionId: 'act_bad_post',
        // `thought_leadership` is not a member of POST_INTENTS. Downstream this
        // indexes a profile table by the value and finds nothing.
        intent: {
          type: 'social_post',
          draft: { authorCharacterId: DEMO_CHARACTERS.player, network: 'fast_feed', text: 'Shipping.', intent: 'thought_leadership', targetCompanyId: null },
        } as unknown as SubmittedAction['intent'],
      },
    ]);

    expect(outcome.committed).toBe(true);
    expect(reached).toBe(0);
    const rejection = outcome.events.find((event) => event.type === 'action_rejected' && event.targetId === 'act_bad_post');
    expect(rejection?.payload.codes).toEqual(['illegal_value']);
  });

  it('turns a board matter into a tabled proposal instead of executing it', () => {
    const state = createDemoSession();
    const outcome = resolve(state, makeStubs(), null, [
      {
        ...hire(1),
        actionId: 'act_raise',
        intent: { type: 'raise_round', stage: 'series_a', targetAmountUsd: 9_000_000, maxDilutionPct: 0.2 },
      },
    ]);
    const proposals = outcome.nextState.boardProposals;
    expect(proposals).toHaveLength(1);
    expect(proposals[0]?.kind).toBe('financing');
    expect(proposals[0]?.status).toBe('tabled');
    expect(proposals[0]?.linkedActionId).toBe('act_raise');
    expect(outcome.events.some((event) => event.type === 'board_proposal_submitted')).toBe(true);
    // Nothing was raised: the cash is untouched.
    const company = outcome.nextState.companies.find((c) => c.id === DEMO_COMPANIES.player);
    expect(company?.financials.cash).toBe(4_000_000);
  });
});

/* -------------------------------------------------------------------------- */
/*  Capital                                                                    */
/* -------------------------------------------------------------------------- */

describe('capital resolution', () => {
  const submitted = (intent: SubmittedAction['intent'], companyId: string, characterId: string): SubmittedAction => ({
    actionId: `act_${intent.type}`,
    sessionId: createDemoSession().sessionId,
    quarter: 0,
    sequence: 1,
    actorPlayerId: null,
    actorCompanyId: companyId,
    actorCharacterId: characterId,
    origin: 'npc_strategist',
    intent,
    confirmedByHuman: false,
  });

  it('closes a round that clears, issues the shares and keeps both invariants', () => {
    const state = createDemoSession();
    state.world.capitalMarkets.ventureLiquidity = 1;
    state.world.capitalMarkets.riskAppetite = 1;

    const before = state.capTables.find((t) => t.companyId === DEMO_COMPANIES.orbit)?.shareClasses[0]?.issuedShares ?? 0;
    const outcome = resolve(state, makeStubs(), null, [
      submitted({ type: 'raise_round', stage: 'growth', targetAmountUsd: 500_000_000, maxDilutionPct: 0.3 }, DEMO_COMPANIES.orbit, DEMO_CHARACTERS.daniel),
    ]);

    expect(outcome.committed).toBe(true);
    expect(outcome.events.some((event) => event.type === 'funding_round_closed')).toBe(true);
    const company = outcome.nextState.companies.find((c) => c.id === DEMO_COMPANIES.orbit);
    expect(company?.financials.cash).toBeCloseTo(3_900_000_000 + 500_000_000, 2);

    const table = outcome.nextState.capTables.find((t) => t.companyId === DEMO_COMPANIES.orbit);
    const shareClass = table?.shareClasses[0];
    expect(shareClass?.issuedShares).toBeGreaterThan(before);
    const held = table?.holdings.reduce((sum, holding) => sum + holding.shares, 0) ?? 0;
    expect(held).toBe(shareClass?.issuedShares);
    expect(table?.totalIssuedByClass[shareClass?.id ?? '']).toBe(shareClass?.issuedShares);
    expect(outcome.invariants.every((result) => result.passed)).toBe(true);
  });

  it('fails a round that would breach its own dilution ceiling, publicly', () => {
    const state = createDemoSession();
    const outcome = resolve(state, makeStubs(), null, [
      submitted({ type: 'raise_round', stage: 'bridge', targetAmountUsd: 6_000_000_000, maxDilutionPct: 0.05 }, DEMO_COMPANIES.vectorworks, DEMO_CHARACTERS.tomas),
    ]);
    const failure = outcome.events.find((event) => event.type === 'funding_round_failed');
    expect(failure).toBeDefined();
    expect(failure?.visibility).toBe('public');
    expect(failure?.payload.reason).toBe('dilution_ceiling');
    expect(outcome.nextState.fundingRounds.some((round) => round.status === 'failed')).toBe(true);
  });

  it('places debt when the coupon clears and leaves the balance sheet reconciled', () => {
    const state = createDemoSession();
    const outcome = resolve(state, makeStubs(), null, [
      submitted({ type: 'issue_debt', amountUsd: 200_000_000, maxRatePct: 0.4, termQuarters: 12 }, DEMO_COMPANIES.orbit, DEMO_CHARACTERS.daniel),
    ]);
    const company = outcome.nextState.companies.find((c) => c.id === DEMO_COMPANIES.orbit);
    expect(company?.financials.debt).toBeCloseTo(500_000_000, 2);
    expect(company?.financials.cash).toBeCloseTo(4_100_000_000, 2);
    expect(outcome.invariants.find((result) => result.invariant === 'financial_integrity')?.passed).toBe(true);
  });

  it('retires repurchased shares and takes them out of the float', () => {
    const state = createDemoSession();
    const outcome = resolve(state, makeStubs(), null, [
      submitted({ type: 'buyback', budgetUsd: 41_720_000, maxPricePerShareUsd: 41.72 }, DEMO_COMPANIES.orbit, DEMO_CHARACTERS.daniel),
    ]);
    const table = outcome.nextState.capTables.find((t) => t.companyId === DEMO_COMPANIES.orbit);
    const shareClass = table?.shareClasses[0];
    expect(shareClass?.issuedShares).toBe(540_000_000 - 1_000_000);
    const held = table?.holdings.reduce((sum, holding) => sum + holding.shares, 0) ?? 0;
    expect(held).toBe(shareClass?.issuedShares);
    expect(outcome.events.some((event) => event.type === 'buyback_executed')).toBe(true);
  });

  it('settles an acquisition into goodwill, shares and a consolidated balance sheet', () => {
    const state = createDemoSession();
    const outcome = resolve(state, makeStubs(), null, [
      submitted(
        { type: 'acquire_company', targetCompanyId: DEMO_COMPANIES.vectorworks, offerValueUsd: 3_000_000_000, cashPct: 0.4, stockPct: 0.6 },
        DEMO_COMPANIES.orbit,
        DEMO_CHARACTERS.daniel,
      ),
    ]);

    expect(outcome.committed).toBe(true);
    const acquirer = outcome.nextState.companies.find((c) => c.id === DEMO_COMPANIES.orbit);
    const target = outcome.nextState.companies.find((c) => c.id === DEMO_COMPANIES.vectorworks);
    expect(target?.isActive).toBe(false);
    expect(target?.parentCompanyId).toBe(DEMO_COMPANIES.orbit);
    expect(acquirer?.balanceSheet.assets.goodwill).toBeGreaterThan(600_000_000);
    expect(acquirer?.employees.engineers).toBe(1_420 + 520);
    expect(outcome.events.some((event) => event.type === 'acquisition_completed')).toBe(true);
    expect(outcome.invariants.every((result) => result.passed)).toBe(true);
  });

  /**
   * Both sides of net asset value, from the same starting world.
   *
   * Above it the excess is goodwill, an asset. Below it the difference is a
   * bargain purchase and is recognised as a gain, because the acquirer really is
   * better off by it. Recognising neither — the old behaviour — left assets
   * exceeding liabilities plus equity by the whole discount.
   */
  const netAssetsOf = (state: SessionState, companyId: string): number => {
    const sheet = state.companies.find((company) => company.id === companyId)?.balanceSheet;
    if (sheet === undefined) throw new Error(`missing ${companyId}`);
    const assets = sheet.assets.cash + sheet.assets.ppe + sheet.assets.goodwill + sheet.assets.investments + sheet.assets.receivables;
    return assets - (sheet.liabilities.debt + sheet.liabilities.payables + sheet.liabilities.deferredRevenue);
  };

  const buyVectorworks = (offerValueUsd: number) => {
    const state = createDemoSession();
    const netAssets = netAssetsOf(state, DEMO_COMPANIES.vectorworks);
    const equityBefore = state.companies.find((company) => company.id === DEMO_COMPANIES.orbit)?.balanceSheet.equity ?? 0;
    const goodwillBefore = state.companies.find((company) => company.id === DEMO_COMPANIES.orbit)?.balanceSheet.assets.goodwill ?? 0;
    const outcome = resolve(state, makeStubs(), null, [
      submittedFor(
        { type: 'acquire_company', targetCompanyId: DEMO_COMPANIES.vectorworks, offerValueUsd, cashPct: 1, stockPct: 0 },
        DEMO_COMPANIES.orbit,
        DEMO_CHARACTERS.daniel,
      ),
    ]);
    const acquirer = outcome.nextState.companies.find((company) => company.id === DEMO_COMPANIES.orbit);
    const row = outcome.events.find((event) => event.type === 'acquisition_completed');
    // The target's own goodwill crosses over with the rest of its sheet, and is
    // not part of what this purchase recognised.
    const inherited = createDemoSession().companies.find((company) => company.id === DEMO_COMPANIES.vectorworks)?.balanceSheet.assets.goodwill ?? 0;
    return { netAssets, equityBefore, goodwillBefore: goodwillBefore + inherited, outcome, acquirer, row };
  };

  it('recognises goodwill when the price is above net asset value', () => {
    const bought = buyVectorworks(2_000_000_000);
    expect(bought.outcome.committed).toBe(true);
    expect(bought.row?.payload.goodwillUsd).toBeCloseTo(2_000_000_000 - bought.netAssets, 2);
    expect(bought.row?.payload.bargainGainUsd).toBe(0);
    // All cash, no stock: nothing was issued, so equity does not move at all.
    expect(bought.acquirer?.balanceSheet.equity).toBeCloseTo(bought.equityBefore, 2);
    expect(bought.acquirer?.balanceSheet.assets.goodwill).toBeCloseTo(bought.goodwillBefore + (2_000_000_000 - bought.netAssets), 2);
    if (bought.acquirer === undefined) throw new Error('missing acquirer');
    expect(balanceSheetReconciles(bought.acquirer.balanceSheet)).toBe(true);
    expect(bought.outcome.invariants.find((result) => result.invariant === 'financial_integrity')?.passed).toBe(true);
  });

  it('recognises a gain when the price is below net asset value, instead of minting equity', () => {
    const bought = buyVectorworks(400_000_000);
    const discount = bought.netAssets - 400_000_000;
    expect(discount).toBeGreaterThan(0);
    expect(bought.outcome.committed).toBe(true);
    expect(bought.row?.payload.goodwillUsd).toBe(0);
    expect(bought.row?.payload.bargainGainUsd).toBeCloseTo(discount, 2);
    if (bought.acquirer === undefined) throw new Error('missing acquirer');
    // The gain is equity, and it is the *only* thing that moved equity here.
    expect(bought.acquirer.balanceSheet.equity - bought.equityBefore).toBeCloseTo(discount, 2);
    expect(bought.acquirer.balanceSheet.assets.goodwill).toBeCloseTo(bought.goodwillBefore, 2);
    // Without the gain the sheet would be out by the whole discount: this is
    // the assertion the old behaviour failed.
    expect(balanceSheetReconciles(bought.acquirer.balanceSheet)).toBe(true);
    expect(bought.outcome.invariants.every((result) => result.passed)).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/*  Disclosure and leaderboards                                                */
/* -------------------------------------------------------------------------- */

describe('disclosure', () => {
  it('publishes earnings for listed companies and nothing for private ones', () => {
    const outcome = resolve(createDemoSession(), makeStubs(), null);
    const published = outcome.nextState.disclosures.filter((disclosure) => disclosure.quarter === 0 && disclosure.kind === 'earnings');
    expect(published).toHaveLength(6);
    expect(published.some((disclosure) => disclosure.companyId === DEMO_COMPANIES.player)).toBe(false);
  });

  it('never leaks a secret programme into a public disclosure', () => {
    const outcome = resolve(createDemoSession(), makeStubs(), null);
    const secret = outcome.nextState.researchProjects.find((project) => project.isSecret);
    expect(secret).toBeDefined();
    const leaked = outcome.nextState.disclosures.some(
      (disclosure) => disclosure.body.includes(secret?.id ?? '!') || disclosure.body.includes('tech_dense_scaling_saturation'),
    );
    expect(leaked).toBe(false);
    expect(outcome.invariants.find((result) => result.invariant === 'information_boundary')?.passed).toBe(true);
  });

  it('settles guidance when the quarter it named arrives, and moves credibility', () => {
    const first = resolve(createDemoSession(), makeStubs(), null);
    const second = resolve(first.nextState, makeStubs(), null);
    const evaluated = second.events.find((event) => event.type === 'guidance_evaluated');
    expect(evaluated).toBeDefined();
    expect(evaluated?.payload.metric).toBe('revenue');
    // Nexus guided $2.1bn against $1.85bn of actual revenue: a miss.
    expect(evaluated?.payload.met).toBe(false);
    const nexusBefore = first.nextState.companies.find((c) => c.id === DEMO_COMPANIES.nexus)?.reputation.investor ?? 0;
    const nexusAfter = second.nextState.companies.find((c) => c.id === DEMO_COMPANIES.nexus)?.reputation.investor ?? 0;
    expect(nexusAfter).toBeLessThan(nexusBefore);
  });
});

describe('leaderboards', () => {
  it('builds all ten boards from state, with percentiles inside the unit interval', () => {
    const outcome = resolve(createDemoSession(), makeStubs(), null);
    const boards = outcome.nextState.leaderboards;
    expect(boards).toHaveLength(10);
    expect(boards.map((board) => board.board)).toContain('founder_index');

    for (const board of boards) {
      for (const entry of board.entries) {
        expect(entry.percentile).toBeGreaterThanOrEqual(0);
        expect(entry.percentile).toBeLessThanOrEqual(1);
        expect(Number.isFinite(entry.value)).toBe(true);
      }
    }
    const composite = boards.find((board) => board.board === 'founder_index');
    expect(composite?.entries.length).toBeGreaterThan(0);
    expect(composite?.entries[0]?.rank).toBe(1);
    expect(outcome.events.some((event) => event.type === 'leaderboard_updated')).toBe(true);
  });

  it('carries the previous rank forward on the second quarter', () => {
    const first = resolve(createDemoSession(), makeStubs(), null);
    const second = resolve(first.nextState, makeStubs(), null);
    const board = second.nextState.leaderboards.find((entry) => entry.board === 'company_value');
    expect(board?.entries.every((entry) => entry.previousRank !== null)).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/*  The report and the ledger                                                  */
/* -------------------------------------------------------------------------- */

describe('the ledger and the report', () => {
  it('assigns contiguous sequence numbers and two unbroken hash chains', () => {
    const state = createDemoSession();
    const outcome = resolve(state, makeStubs(), null);
    outcome.events.forEach((event, index) => {
      expect(event.sequence).toBe(state.ledgerSequence + index);
    });

    // The state chain runs phase by phase: every row a phase wrote shares one
    // before-hash and one after-hash, and each phase opens where the last closed.
    let opensAt = engineHash(state);
    let groupBefore: string | null = null;
    let phases = 0;
    for (const event of outcome.events) {
      if (event.stateHashBefore !== groupBefore) {
        expect(event.stateHashBefore).toBe(opensAt);
        groupBefore = event.stateHashBefore;
        phases += 1;
      }
      expect(event.stateHashAfter).toBe(outcome.events.find((row) => row.stateHashBefore === groupBefore)?.stateHashAfter);
      opensAt = event.stateHashAfter;
    }
    expect(phases).toBeGreaterThan(1);
    expect(phases).toBeLessThan(outcome.events.length);

    // The row chain runs row by row, and costs no state hash at all.
    let rowChain = engineHash(state);
    for (const event of outcome.events) {
      rowChain = chainRowHash(rowChain, event);
      expect(event.rowHash).toBe(rowChain);
    }

    expect(outcome.nextState.ledgerSequence).toBe(state.ledgerSequence + outcome.events.length);
    expect(outcome.report.sequenceFrom).toBe(0);
    expect(outcome.report.sequenceTo).toBe(outcome.events.length - 1);
  });

  it('closes the last phase, so the committed and snapshot rows are whole', () => {
    const outcome = resolve(createDemoSession(), makeStubs(), null);
    for (const event of outcome.events) {
      expect(event.stateHashAfter.length).toBeGreaterThan(0);
      expect(event.rowHash.length).toBeGreaterThan(0);
    }
    const last = outcome.events[outcome.events.length - 1];
    expect(last?.stateHashAfter).toBe(outcome.report.stateHashAfter);
  });

  it('stamps every row of a quarter with that quarter, ids included', () => {
    const state = createDemoSession();
    const outcome = resolve(state, makeStubs(), null);
    expect(outcome.nextState.quarter).toBe(state.quarter + 1);
    for (const event of outcome.events) {
      expect(event.quarter).toBe(state.quarter);
      // The commit and the snapshot rows are written after the clock advances;
      // their ids must still name the quarter they belong to.
      expect(event.eventId).toBe(makeId('evt', state.sessionId, state.quarter, event.sequence));
    }
    expect(outcome.events.some((event) => event.type === 'quarter_committed')).toBe(true);
    expect(outcome.events.some((event) => event.type === 'snapshot_created')).toBe(true);
  });

  it('gives every report line at least one committed ledger row', () => {
    const outcome = resolve(createDemoSession(), makeStubs(), proposalBatch(0.3, 'world.compute.acceleratorSupply'));
    const ids = new Set(outcome.events.map((event) => event.eventId));
    const lines = outcome.report.phases.flatMap((phase) => phase.lines);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line.refEventIds.length).toBeGreaterThan(0);
      for (const ref of line.refEventIds) expect(ids.has(ref)).toBe(true);
    }
    expect(outcome.invariants.find((result) => result.invariant === 'auditability')?.passed).toBe(true);
  });

  it('produces a state, a report and rows that satisfy their own schemas', () => {
    const outcome = resolve(createDemoSession(), makeStubs(), proposalBatch(0.3, 'world.compute.acceleratorSupply'), []);
    expect(() => SessionStateSchema.parse(outcome.nextState)).not.toThrow();
    expect(() => ResolutionReportSchema.parse(outcome.report)).not.toThrow();
    for (const event of outcome.events) expect(() => SimEventSchema.parse(event)).not.toThrow();
    expect(() => SessionSnapshotSchema.parse(outcome.snapshot)).not.toThrow();
  });

  it('opens with a quarter_opened row and closes with quarter_committed and snapshot_created', () => {
    const outcome = resolve(createDemoSession(), makeStubs(), null);
    expect(outcome.events[0]?.type).toBe('quarter_opened');
    const types = outcome.events.map((event) => event.type);
    expect(types).toContain('quarter_committed');
    expect(types[types.length - 1]).toBe('snapshot_created');
  });

  it('reports phases in pipeline order and only where something happened', () => {
    const outcome = resolve(createDemoSession(), makeStubs(), null);
    const order = outcome.report.phases.map((phase) => phase.phase);
    const positions = order.map((phase) => RESOLUTION_PHASES.indexOf(phase));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(outcome.report.phases.every((phase) => phase.lines.length > 0)).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/*  The invariant gate                                                         */
/* -------------------------------------------------------------------------- */

describe('the invariant gate', () => {
  it('accepts the demo world as it stands', () => {
    const outcome = resolve(createDemoSession(), makeStubs(), null);
    const failed = outcome.invariants.filter((result) => !result.passed);
    expect(failed).toEqual([]);
    // Fourteen since capital_integrity was appended. World 1 has no capital
    // entities, so that check passes trivially — which is the point of it
    // being a state check rather than a phase.
    expect(outcome.invariants).toHaveLength(SIMULATION_INVARIANTS.length);
  });

  it('refuses to commit a quarter whose balance sheets do not reconcile', () => {
    const state = createDemoSession();
    const outcome = resolve(state, makeStubs({ breakBalanceSheet: true }), null);
    expect(outcome.committed).toBe(false);
    expect(outcome.nextState).toBe(state);
    expect(outcome.nextState.quarter).toBe(0);
    expect(outcome.invariants.find((result) => result.invariant === 'financial_integrity')?.passed).toBe(false);
    expect(outcome.events.some((event) => event.type === 'invariant_check_failed')).toBe(true);
    expect(outcome.report.headline).toContain('did not commit');
    expect(outcome.snapshot.phase).toBe('pre_resolution');
  });

  it('refuses a quarter whose equity moved without a ledger row behind it', () => {
    // The corruption is double-entry *shaped*: an asset and the equity to match
    // it. The stored identity therefore still holds, which is precisely why an
    // invariant that only checks the stored identity is no invariant at all.
    const shown = createDemoSession();
    const company = shown.companies[0];
    if (company === undefined) throw new Error('missing company');
    company.balanceSheet.assets.cash += 1_000_000;
    company.balanceSheet.equity += 1_000_000;
    expect(balanceSheetReconciles(company.balanceSheet)).toBe(true);

    const state = createDemoSession();
    const outcome = resolve(state, makeStubs({ mintEquity: true }), null);
    expect(outcome.committed).toBe(false);
    expect(outcome.nextState).toBe(state);
    const result = outcome.invariants.find((entry) => entry.invariant === 'financial_integrity');
    expect(result?.passed).toBe(false);
    expect(result?.detail).toContain(company.id);
    expect(result?.detail).toContain('unexplained');
  });

  it('accepts equity that moved by exactly what the ledger says moved it', () => {
    const state = createDemoSession();
    state.world.capitalMarkets.ventureLiquidity = 1;
    state.world.capitalMarkets.riskAppetite = 1;
    const outcome = resolve(state, makeStubs(), null, [
      submittedFor({ type: 'raise_round', stage: 'growth', targetAmountUsd: 500_000_000, maxDilutionPct: 0.3 }, DEMO_COMPANIES.orbit, DEMO_CHARACTERS.daniel),
    ]);
    expect(outcome.events.some((event) => event.type === 'funding_round_closed')).toBe(true);
    expect(outcome.committed).toBe(true);
    expect(outcome.invariants.find((entry) => entry.invariant === 'financial_integrity')?.passed).toBe(true);

    const before = state.companies.find((company) => company.id === DEMO_COMPANIES.orbit)?.balanceSheet.equity ?? 0;
    const after = outcome.nextState.companies.find((company) => company.id === DEMO_COMPANIES.orbit)?.balanceSheet.equity ?? 0;
    expect(after - before).toBeCloseTo(500_000_000, 2);
  });

  it('throws when the engine itself is wrong, rather than quietly not committing', () => {
    expect(() => resolve(createDemoSession(), makeStubs({ logPhantomReference: true }), null)).toThrow(InvariantViolationError);
  });

  it('throws on any failure at all in strict mode', () => {
    const stubs = makeStubs({ breakBalanceSheet: true });
    const resolver = createQuarterResolver(stubs.subsystems, { strictInvariants: true });
    expect(() => resolver.resolveQuarter(createDemoSession(), [], null, [])).toThrow(InvariantViolationError);
  });
});
