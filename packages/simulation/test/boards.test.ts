/**
 * @frontier/simulation — board subsystem tests.
 *
 * The board is the seeded five-member Nexus board: Maya Chen in the founder
 * seat and the chair, Eleanor Vance and Marcus Feld for the investors, Idris
 * Bello and Sarah Zhou independent, with the seed's independence, risk,
 * growth, discipline, technology and safety scores intact.
 *
 * What these assert:
 * - a director's stance moves with a commitment whose conditions hold, and does
 *   not move when the same commitment's conditions fail;
 * - a broken promise is recorded as a betrayal and costs the relationship;
 * - dismissing a chief executive removes executive control and leaves every
 *   share exactly where it was;
 * - quorum, supermajority and recusal behave as the rule set says;
 * - the tally is pure and reproducible.
 */

import { describe, expect, it } from 'vitest';
import type { SessionState, StoredCommitment } from '@frontier/contracts';
import { commitmentConditionsHold } from '@frontier/contracts';
import {
  assessDirector,
  bindingCommitments,
  createBoardsSubsystem,
  proposalCommitmentValues,
  registerCommitment,
  tallyProposal,
} from '../src/boards/index';
import { cloneState, companyOf, eventsOfType, makeAction, makeContext, makeProposal, makeState } from './_institutionsHarness';

/* -------------------------------------------------------------------------- */
/*  Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

/** A dilutive financing the disciplined independent director dislikes. */
function financingState(): SessionState {
  const state = makeState();
  state.boardProposals = [
    makeProposal({
      id: 'prp_financing',
      kind: 'financing',
      title: 'Series D — $2.0bn primary at 22% dilution',
      amountUsd: 2_000_000_000,
      dilutionPct: 0.22,
    }),
  ];
  return state;
}

function commitmentFor(overrides: Partial<StoredCommitment> = {}): StoredCommitment {
  return {
    id: 'cmt_test',
    actorCharacterId: 'chr_sarah_zhou',
    proposalKind: 'financing',
    stance: 'support',
    conditions: [{ field: 'dilutionPct', comparator: 'lte', value: 0.25 }],
    commitmentStrength: 0.9,
    expiresQuarter: 4,
    targetCompanyId: null,
    rationale: 'Below 25% dilution I can live with it.',
    createdQuarter: 0,
    conversationId: null,
    status: 'active',
    resolvedProposalId: null,
    ...overrides,
  };
}

const directorVote = (state: SessionState, proposalId: string, characterId: string) =>
  tallyProposal(state, proposalId).perDirector.find((v) => v.directorCharacterId === characterId);

/* -------------------------------------------------------------------------- */
/*  Commitments                                                                */
/* -------------------------------------------------------------------------- */

describe('conditional commitments', () => {
  it('moves a director only when the conditions actually hold', () => {
    const base = financingState();
    const baseline = directorVote(base, 'prp_financing', 'chr_sarah_zhou');
    expect(baseline?.vote).not.toBe('support');

    // Conditions hold: dilution 22% is at or below the promised 25%.
    const holding = financingState();
    holding.commitments = [commitmentFor()];
    const held = directorVote(holding, 'prp_financing', 'chr_sarah_zhou');
    expect(held?.vote).toBe('support');
    expect(held?.honouredCommitmentId).toBe('cmt_test');

    // Same promise, a threshold the proposal misses.
    const failing = financingState();
    failing.commitments = [commitmentFor({ conditions: [{ field: 'dilutionPct', comparator: 'lte', value: 0.1 }] })];
    const notHeld = directorVote(failing, 'prp_financing', 'chr_sarah_zhou');
    expect(notHeld?.vote).toBe(baseline?.vote);
    expect(notHeld?.honouredCommitmentId).toBeNull();

    // And the contract's own evaluator agrees with the engine.
    const proposal = holding.boardProposals[0];
    if (proposal === undefined) throw new Error('missing proposal');
    const values = proposalCommitmentValues(holding, proposal);
    expect(commitmentConditionsHold(commitmentFor().conditions, values)).toBe(true);
    expect(commitmentConditionsHold([{ field: 'debtRatePct', comparator: 'lte', value: 0.1 }], values)).toBe(false);
    expect(bindingCommitments(holding, proposal, 'chr_sarah_zhou').length).toBe(1);
  });

  it('records a broken promise as a betrayal and charges the relationship for it', () => {
    const state = financingState();
    // Weak enough that she abandons it under her own preference.
    state.commitments = [commitmentFor({ commitmentStrength: 0.15 })];

    const harness = makeContext(1);
    createBoardsSubsystem().resolveProposals(state, harness.ctx);

    const commitment = state.commitments[0];
    expect(commitment?.status).toBe('broken');
    expect(commitment?.resolvedProposalId).toBe('prp_financing');
    expect(eventsOfType(harness, 'commitment_broken').length).toBe(1);

    const betrayal = state.memories.find((m) => m.kind === 'betrayal' && m.aboutId === 'chr_sarah_zhou');
    expect(betrayal).toBeDefined();
    // Betrayals barely decay: that is the point of them.
    expect(betrayal?.decayRate).toBeLessThanOrEqual(0.02);

    const seat = state.boards[0]?.directors.find((d) => d.characterId === 'chr_sarah_zhou');
    expect(seat?.relationshipWithCeo).toBeLessThan(5);
  });

  it('turns a lobbying action into a testable promise without reading the message', () => {
    const state = financingState();
    state.pendingActions = [
      makeAction(
        {
          type: 'lobby_director',
          directorCharacterId: 'chr_sarah_zhou',
          proposalId: 'prp_financing',
          concessions: [{ field: 'dilutionPct', comparator: 'lte', value: 0.12 }],
          message: 'Anything at all, the text is not read by the engine.',
        },
        { sequence: 0 },
      ),
    ];

    const harness = makeContext(1);
    createBoardsSubsystem().applyCommitments(state, harness.ctx);

    expect(state.commitments.length).toBe(1);
    const commitment = state.commitments[0];
    expect(commitment?.actorCharacterId).toBe('chr_sarah_zhou');
    expect(commitment?.proposalKind).toBe('financing');
    expect(commitment?.conditions[0]?.value).toBe(0.12);
    expect(commitment?.commitmentStrength).toBeGreaterThan(0);
    expect(commitment?.commitmentStrength).toBeLessThanOrEqual(1);
    expect(eventsOfType(harness, 'commitment_registered').length).toBe(1);
    for (const line of harness.lines) expect(line.refEventIds?.length ?? 0).toBeGreaterThan(0);
  });

  it('lapses a stale promise without treating it as broken', () => {
    const state = financingState();
    state.commitments = [commitmentFor({ expiresQuarter: 0 })];
    const harness = makeContext(3);
    createBoardsSubsystem().applyCommitments(state, harness.ctx);
    expect(state.commitments[0]?.status).toBe('expired');
    expect(eventsOfType(harness, 'commitment_broken').length).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/*  Voting mechanics                                                           */
/* -------------------------------------------------------------------------- */

describe('voting mechanics', () => {
  it('recuses the chief executive from their own removal and their own pay', () => {
    const state = makeState();
    state.boardProposals = [
      makeProposal({
        id: 'prp_dismissal',
        kind: 'ceo_dismissal',
        title: 'Removal of the chief executive',
        proposedByCharacterId: 'chr_eleanor_vance',
      }),
      makeProposal({ id: 'prp_comp', kind: 'ceo_comp', title: 'Chief executive compensation', amountUsd: 60_000_000 }),
    ];

    for (const id of ['prp_dismissal', 'prp_comp']) {
      const vote = directorVote(state, id, 'chr_maya_chen');
      expect(vote?.vote).toBe('absent');
      expect(vote?.rationale).toContain('Recused');
    }
    // Four of five seats still present: the meeting can act.
    expect(tallyProposal(state, 'prp_dismissal').quorumMet).toBe(true);
  });

  it('applies the supermajority threshold to reserved matters', () => {
    const state = makeState();
    state.boardProposals = [makeProposal({ id: 'prp_dismissal', kind: 'ceo_dismissal', proposedByCharacterId: 'chr_eleanor_vance' })];
    // A comfortable company: nobody has a reason to move against the founder.
    const tally = tallyProposal(state, 'prp_dismissal');
    expect(tally.passes).toBe(false);

    // Now make the case: no runway, deep losses, shrinking revenue.
    const failing = makeState();
    failing.boardProposals = state.boardProposals;
    const metrics = failing.companyMetrics.find((m) => m.companyId === 'cmp_nexus');
    if (metrics === undefined) throw new Error('missing metrics');
    metrics.runwayQuarters = 1;
    metrics.operatingMarginPct = -1.4;
    metrics.revenueGrowthYoY = -0.3;
    const angry = tallyProposal(failing, 'prp_dismissal');
    expect(angry.passes).toBe(true);
    expect(angry.support / (angry.support + angry.against)).toBeGreaterThanOrEqual(0.667);
  });

  it('rolls a matter that cannot reach quorum', () => {
    const state = makeState();
    const board = state.boards[0];
    if (board === undefined) throw new Error('missing board');
    board.quorumRule = { ...board.quorumRule, minPresentFraction: 0.9 };
    state.boardProposals = [makeProposal({ id: 'prp_comp', kind: 'ceo_comp', amountUsd: 60_000_000 })];

    const harness = makeContext(1);
    createBoardsSubsystem().resolveProposals(state, harness.ctx);

    expect(state.boardProposals[0]?.status).toBe('tabled');
    expect(state.boardProposals[0]?.decisionQuarter).toBe(2);
    const votes = eventsOfType(harness, 'board_vote_resolved');
    expect(votes.length).toBe(1);
    expect(votes[0]?.payload.quorumMet).toBe(false);
  });

  it('is pure: tallying twice from the same state gives the same answer', () => {
    const state = financingState();
    state.commitments = [commitmentFor()];
    const before = JSON.stringify(state);
    const first = tallyProposal(state, 'prp_financing');
    const second = tallyProposal(state, 'prp_financing');
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(JSON.stringify(state)).toBe(before);
  });
});

/* -------------------------------------------------------------------------- */
/*  Consequences                                                               */
/* -------------------------------------------------------------------------- */

describe('proposal effects', () => {
  it('separates executive control from ownership when a chief executive is dismissed', () => {
    const state = makeState();
    const metrics = state.companyMetrics.find((m) => m.companyId === 'cmp_nexus');
    if (metrics === undefined) throw new Error('missing metrics');
    metrics.runwayQuarters = 1;
    metrics.operatingMarginPct = -1.4;
    metrics.revenueGrowthYoY = -0.3;
    state.boardProposals = [
      makeProposal({ id: 'prp_dismissal', kind: 'ceo_dismissal', title: 'Removal of the chief executive', proposedByCharacterId: 'chr_eleanor_vance' }),
    ];

    const holdingsBefore = JSON.stringify(state.capTables.find((t) => t.companyId === 'cmp_nexus')?.holdings);
    const playerBefore = JSON.stringify(state.players[0]);

    const harness = makeContext(1);
    createBoardsSubsystem().resolveProposals(state, harness.ctx);

    const company = companyOf(state, 'cmp_nexus');
    expect(state.boardProposals[0]?.status).toBe('passed');
    // Executive control is gone; the company is NPC-run.
    expect(company.controllerPlayerId).toBeNull();
    expect(company.ceoCharacterId).not.toBe('chr_maya_chen');
    // The holdings are untouched, which is the whole point.
    expect(JSON.stringify(state.capTables.find((t) => t.companyId === 'cmp_nexus')?.holdings)).toBe(holdingsBefore);
    expect(JSON.stringify(state.players[0])).toBe(playerBefore);

    const dismissals = eventsOfType(harness, 'ceo_dismissed');
    expect(dismissals.length).toBe(1);
    expect(dismissals[0]?.visibility).toBe('public');
    expect(dismissals[0]?.payload.holdingsUnchanged).toBe(true);

    // The dismissed founder remembers precisely who moved against her.
    const betrayals = state.memories.filter((m) => m.ownerCharacterId === 'chr_maya_chen' && m.kind === 'betrayal');
    expect(betrayals.length).toBeGreaterThan(0);
  });

  it('carries a restructuring into posture, morale and attrition', () => {
    const state = makeState();
    const metrics = state.companyMetrics.find((m) => m.companyId === 'cmp_nexus');
    if (metrics === undefined) throw new Error('missing metrics');
    metrics.runwayQuarters = 2;
    state.boardProposals = [makeProposal({ id: 'prp_restructure', kind: 'restructuring', title: 'Restructuring plan', amountUsd: 0 })];

    const moraleBefore = companyOf(state, 'cmp_nexus').employees.morale;
    const harness = makeContext(1);
    createBoardsSubsystem().resolveProposals(state, harness.ctx);

    const company = companyOf(state, 'cmp_nexus');
    expect(state.boardProposals[0]?.status).toBe('passed');
    expect(company.posture).toBe('survival');
    expect(company.employees.morale).toBeLessThan(moraleBefore);
    expect(company.employees.attrition).toBeGreaterThan(0.06);
    expect(eventsOfType(harness, 'board_vote_resolved').length).toBe(1);
  });

  it('suspends a programme when the board refuses to continue it', () => {
    const state = makeState();
    state.governmentContracts = [
      {
        id: 'gct_under_review',
        opportunityId: 'opp_sovereign_platform',
        agencyId: 'agy_defence',
        primeCompanyId: 'cmp_nexus',
        consortiumMemberIds: [],
        subcontractors: [],
        awardedQuarter: 0,
        contractForm: 'cost_plus',
        totalValueUsd: 400_000_000,
        recognisedToDateUsd: 0,
        milestones: [],
        performanceToDate: 30,
        penaltiesUsd: 24_000_000,
        complianceBurdenQuarterlyUsd: 2_000_000,
        status: 'active',
        exportRestricted: true,
        publicControversyLevel: 0.9,
      },
    ];
    // A contested programme the company can no longer afford to carry.
    state.world.media.controversyIntensity = 0.95;
    state.world.society.automationAnxiety = 0.9;
    companyOf(state, 'cmp_nexus').financials.cash = 150_000_000;
    state.boardProposals = [
      makeProposal({
        id: 'prp_review',
        kind: 'gov_contract',
        title: 'Continuation review',
        proposedByCharacterId: 'chr_idris_bello',
        amountUsd: 400_000_000,
        linkedActionId: 'gct_under_review',
      }),
    ];

    const harness = makeContext(1);
    createBoardsSubsystem().resolveProposals(state, harness.ctx);
    expect(state.boardProposals[0]?.status).toBe('failed');
    expect(state.governmentContracts[0]?.status).toBe('suspended');
  });

  it('resolves the whole phase identically from an identical state', () => {
    const build = (): SessionState => {
      const state = financingState();
      state.commitments = [commitmentFor({ commitmentStrength: 0.15 })];
      return state;
    };
    const run = (state: SessionState) => {
      const harness = makeContext(1);
      const boards = createBoardsSubsystem();
      boards.applyCommitments(state, harness.ctx);
      boards.resolveProposals(state, harness.ctx);
      return { state, events: harness.events, lines: harness.lines };
    };

    const first = run(build());
    const second = run(cloneState(build()));
    expect(JSON.stringify(second.events)).toBe(JSON.stringify(first.events));
    expect(JSON.stringify(second.state.commitments)).toBe(JSON.stringify(first.state.commitments));
    expect(JSON.stringify(second.lines)).toBe(JSON.stringify(first.lines));
  });
});

/* -------------------------------------------------------------------------- */
/*  Director assessment                                                        */
/* -------------------------------------------------------------------------- */

describe('director assessment', () => {
  it('reads mandate, independence and the relationship with the chief executive', () => {
    const state = financingState();
    const board = state.boards[0];
    const proposal = state.boardProposals[0];
    if (board === undefined || proposal === undefined) throw new Error('missing fixture');

    const founder = board.directors.find((d) => d.characterId === 'chr_maya_chen');
    const independent = board.directors.find((d) => d.characterId === 'chr_sarah_zhou');
    if (founder === undefined || independent === undefined) throw new Error('missing directors');

    const founderView = assessDirector(state, proposal, founder);
    const independentView = assessDirector(state, proposal, independent);
    expect(founderView.preference).toBeGreaterThan(independentView.preference);
    expect(founderView.rationale.length).toBeGreaterThan(0);

    // Loyalty is real: souring the relationship moves the same director.
    const soured = cloneState(state);
    const seat = soured.boards[0]?.directors.find((d) => d.characterId === 'chr_eleanor_vance');
    const proposalAfter = soured.boardProposals[0];
    if (seat === undefined || proposalAfter === undefined) throw new Error('missing fixture');
    const before = assessDirector(soured, proposalAfter, seat).preference;
    seat.relationshipWithCeo = -80;
    const after = assessDirector(soured, proposalAfter, seat).preference;
    expect(after).toBeLessThan(before);
  });

  it('registers a commitment supplied by the dialogue layer with engine identity', () => {
    const state = financingState();
    const harness = makeContext(1);
    const { commitment, eventId } = registerCommitment(
      state,
      harness.ctx,
      {
        actorCharacterId: 'chr_marcus_feld',
        proposalKind: 'acquisition',
        stance: 'support',
        conditions: [
          { field: 'purchasePriceUsd', comparator: 'lte', value: 5_500_000_000 },
          { field: 'stockComponentPct', comparator: 'gte', value: 0.35 },
        ],
        commitmentStrength: 0.72,
        expiresQuarter: 3,
        targetCompanyId: 'cmp_vector',
        rationale: 'At $6.4bn I do not support it. Below $5.5bn, or with a larger stock component, I would.',
      },
      'cnv_0142',
    );

    expect(commitment.id.startsWith('cmt_')).toBe(true);
    expect(commitment.status).toBe('active');
    expect(commitment.createdQuarter).toBe(1);
    expect(commitment.conversationId).toBe('cnv_0142');
    expect(eventId).toBe(harness.events[0]?.eventId);
    expect(state.commitments.length).toBe(1);
  });
});
