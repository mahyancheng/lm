/**
 * @frontier/simulation — government subsystem tests.
 *
 * The fixture mirrors `supabase/seed.sql`: session seed 424242, 2027 Q1, the six
 * seeded companies, three agencies and the $2.4bn Sovereign Intelligence
 * Platform competition with the seed's evaluation weights and requirements.
 *
 * What these assert, in the language of the design brief:
 * - the weighted total is exactly the seven axes times the published weights;
 * - an implausibly low cost-plus price loses realism points rather than winning;
 * - a hard requirement disqualifies rather than discounts;
 * - a missed milestone cascades: penalty, past-performance drop, public event,
 *   and a risk-committee investigation once it fails outright;
 * - everything is reproducible under a fixed seed.
 */

import { describe, expect, it } from 'vitest';
import type { GovernmentContract, SessionState } from '@frontier/contracts';
import { EvaluationWeightsSchema } from '@frontier/contracts';
import {
  createGovernmentSubsystem,
  scoreOpportunityBids,
  engineCostEstimate,
  bidTeam,
  costRealism,
  PAST_PERFORMANCE_MOVES,
} from '../src/government/index';
import {
  cloneState,
  companyOf,
  eventsOfType,
  makeBid,
  makeContext,
  makeState,
} from './_institutionsHarness';

/* -------------------------------------------------------------------------- */
/*  Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

/** Three bids on the sovereign platform: two credible, one lowball. */
function competitiveState(): SessionState {
  const state = makeState();
  state.governmentBids = [
    makeBid({ id: 'bid_nexus', bidderCompanyId: 'cmp_nexus', price: 2_000_000_000 }),
    makeBid({
      id: 'bid_orbit',
      bidderCompanyId: 'cmp_orbit',
      price: 1_900_000_000,
      technicalScoreInputs: {
        modelCapability: 0.6,
        architectureQuality: 0.65,
        securityPosture: 0.8,
        reliabilityCommitment: 0.85,
        responsibleAiCommitment: 0.7,
      },
    }),
    // Buying the programme: a third of the government estimate.
    makeBid({ id: 'bid_helix', bidderCompanyId: 'cmp_helix', price: 500_000_000 }),
  ];
  return state;
}

function breakdownFor<T extends { bidId: string }>(rows: readonly T[], id: string): T {
  const row = rows.find((r) => r.bidId === id);
  if (row === undefined) throw new Error(`no breakdown for ${id}`);
  return row;
}

/** An active contract with one milestone falling due this quarter. */
function contractWithDueMilestone(state: SessionState, companyId: string, computeRequiredUnits: number): GovernmentContract {
  const contract: GovernmentContract = {
    id: 'gct_sovereign_1',
    opportunityId: 'opp_sovereign_platform',
    agencyId: 'agy_defence',
    primeCompanyId: companyId,
    consortiumMemberIds: [],
    subcontractors: [],
    awardedQuarter: 0,
    contractForm: 'cost_plus',
    totalValueUsd: 400_000_000,
    recognisedToDateUsd: 0,
    milestones: [
      {
        id: 'mil_1',
        label: 'Sovereign Intelligence Platform — milestone 1 of 2',
        dueQuarter: 1,
        valueUsd: 200_000_000,
        status: 'pending',
        completedQuarter: null,
        qualityScore: 0,
        computeRequiredUnits,
      },
      {
        id: 'mil_2',
        label: 'Sovereign Intelligence Platform — milestone 2 of 2',
        dueQuarter: 4,
        valueUsd: 200_000_000,
        status: 'pending',
        completedQuarter: null,
        qualityScore: 0,
        computeRequiredUnits,
      },
    ],
    performanceToDate: 58,
    penaltiesUsd: 0,
    complianceBurdenQuarterlyUsd: 2_400_000,
    status: 'active',
    exportRestricted: true,
    publicControversyLevel: 0.5,
  };
  state.governmentContracts = [contract];
  const company = companyOf(state, companyId);
  company.financials.backlogUsd = contract.totalValueUsd;
  return contract;
}

/* -------------------------------------------------------------------------- */
/*  Scoring                                                                    */
/* -------------------------------------------------------------------------- */

describe('bid scoring', () => {
  it('weights the seven axes exactly as the opportunity publishes them', () => {
    const state = competitiveState();
    const opportunity = state.procurementOpportunities[0];
    expect(opportunity).toBeDefined();
    if (opportunity === undefined) return;

    const rows = scoreOpportunityBids(state, opportunity, state.governmentBids);
    const weights = opportunity.evaluationWeights;
    expect(EvaluationWeightsSchema.safeParse(weights).success).toBe(true);

    for (const row of rows.filter((r) => !r.disqualified)) {
      const expected =
        row.technical * weights.technical +
        row.security * weights.security +
        row.pastPerformance * weights.pastPerformance +
        row.priceRealism * weights.priceRealism +
        row.schedule * weights.schedule +
        row.domesticSupply * weights.domesticSupply +
        row.responsibleAi * weights.responsibleAi;
      expect(row.weightedTotal).toBeCloseTo(expected, 5);
      expect(row.weightedTotal).toBeGreaterThanOrEqual(0);
      expect(row.weightedTotal).toBeLessThanOrEqual(1);
    }
  });

  it('penalises an implausibly low cost-plus price rather than rewarding it', () => {
    const state = competitiveState();
    const opportunity = state.procurementOpportunities[0];
    if (opportunity === undefined) throw new Error('missing opportunity');

    const rows = scoreOpportunityBids(state, opportunity, state.governmentBids);
    const lowball = breakdownFor(rows, 'bid_helix');
    const credible = breakdownFor(rows, 'bid_nexus');

    // The cheapest bid on the table scores worst on price.
    expect(lowball.priceRealism).toBeLessThan(credible.priceRealism);
    expect(lowball.rank).toBeGreaterThan(1);
    expect(lowball.notes.join(' ')).toContain('not found credible');

    // And the parabola itself: both far below and far above the estimate score badly.
    const team = bidTeam(state, state.governmentBids[0]!);
    const estimate = engineCostEstimate(state, opportunity, state.governmentBids[0]!, team);
    expect(costRealism(estimate.estimateUsd * 0.25, estimate.estimateUsd, 'cost_plus')).toBeLessThan(0.1);
    expect(costRealism(estimate.estimateUsd * 2.4, estimate.estimateUsd, 'cost_plus')).toBeLessThan(0.2);
    expect(costRealism(estimate.estimateUsd * 1.25, estimate.estimateUsd, 'cost_plus')).toBeGreaterThan(0.9);
  });

  it('discounts a claim by real capability instead of rejecting it', () => {
    const state = competitiveState();
    const opportunity = state.procurementOpportunities[0];
    if (opportunity === undefined) throw new Error('missing opportunity');

    const honest = makeBid({ id: 'bid_honest', bidderCompanyId: 'cmp_vector' });
    honest.technicalScoreInputs = { ...honest.technicalScoreInputs, modelCapability: 0.4, architectureQuality: 0.4 };
    const boastful = makeBid({ id: 'bid_boastful', bidderCompanyId: 'cmp_vector' });
    boastful.technicalScoreInputs = { ...boastful.technicalScoreInputs, modelCapability: 1, architectureQuality: 1 };

    // VectorWorks cannot back either claim; the loud one still scores higher,
    // which is the trap the design intends.
    const rows = scoreOpportunityBids(state, { ...opportunity, requirements: { ...opportunity.requirements, minimumPastPerformance: 0 } }, [honest, boastful]);
    const honestRow = breakdownFor(rows, 'bid_honest');
    const boastfulRow = breakdownFor(rows, 'bid_boastful');
    expect(boastfulRow.technical).toBeGreaterThan(honestRow.technical);
    // But not by the full amount claimed: the discount is real.
    expect(boastfulRow.technical).toBeLessThan(1);
  });
});

/* -------------------------------------------------------------------------- */
/*  Requirement gates                                                          */
/* -------------------------------------------------------------------------- */

describe('requirement gates', () => {
  it('disqualifies rather than discounts, and never awards to a disqualified bid', () => {
    const state = competitiveState();
    // Below the past-performance floor of 55.
    state.governmentBids.push(makeBid({ id: 'bid_vector', bidderCompanyId: 'cmp_vector' }));
    // Level IV clearance demands 80 cleared staff.
    state.governmentBids.push(
      makeBid({
        id: 'bid_meridian',
        bidderCompanyId: 'cmp_meridian',
        staffCommitment: { engineers: 200, researchers: 100, clearedStaff: 4 },
      }),
    );

    const harness = makeContext(1);
    const government = createGovernmentSubsystem();
    const rows = government.scoreBids(state, harness.ctx);

    const vector = breakdownFor(rows, 'bid_vector');
    expect(vector.disqualified).toBe(true);
    expect(vector.notes.join(' ')).toContain('below the programme floor');
    const meridian = breakdownFor(rows, 'bid_meridian');
    expect(meridian.disqualified).toBe(true);
    expect(meridian.notes.join(' ')).toContain('cleared staff');

    expect(state.governmentBids.find((b) => b.id === 'bid_vector')?.status).toBe('disqualified');
    expect(eventsOfType(harness, 'bid_disqualified').length).toBe(2);

    government.awardContracts(state, harness.ctx);
    const contract = state.governmentContracts[0];
    expect(contract).toBeDefined();
    expect(['cmp_nexus', 'cmp_orbit']).toContain(contract?.primeCompanyId);
    const winningBid = state.governmentBids.find((b) => b.status === 'won');
    expect(winningBid?.bidderCompanyId).toBe(contract?.primeCompanyId);
    expect(state.procurementOpportunities[0]?.status).toBe('awarded');
  });

  it('cancels a competition in which nothing qualifies', () => {
    const state = makeState();
    state.governmentBids = [makeBid({ id: 'bid_vector', bidderCompanyId: 'cmp_vector' })];
    const harness = makeContext(1);
    const government = createGovernmentSubsystem();
    government.scoreBids(state, harness.ctx);
    government.awardContracts(state, harness.ctx);
    expect(state.procurementOpportunities[0]?.status).toBe('cancelled');
    expect(state.governmentContracts.length).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/*  Award                                                                      */
/* -------------------------------------------------------------------------- */

describe('awarding', () => {
  it('creates backlog rather than revenue, and tells the losers why they lost', () => {
    const state = competitiveState();
    const harness = makeContext(1);
    const government = createGovernmentSubsystem();
    government.scoreBids(state, harness.ctx);
    government.awardContracts(state, harness.ctx);

    const contract = state.governmentContracts[0];
    expect(contract).toBeDefined();
    if (contract === undefined) return;

    const winner = companyOf(state, contract.primeCompanyId);
    expect(winner.financials.backlogUsd).toBeCloseTo(contract.totalValueUsd, 2);
    expect(winner.financials.revenueQuarterly).toBe(makeState().companies.find((c) => c.id === winner.id)?.financials.revenueQuarterly);
    expect(contract.milestones.length).toBe(5);
    expect(contract.milestones.reduce((s, m) => s + m.valueUsd, 0)).toBeCloseTo(contract.totalValueUsd, 2);
    expect(contract.exportRestricted).toBe(true);

    const awards = eventsOfType(harness, 'contract_awarded');
    expect(awards.length).toBe(1);
    expect(awards[0]?.visibility).toBe('public');

    // Losers keep a memory of who took it, and the ledger explains the gap.
    const losses = state.memories.filter((m) => m.kind === 'contract_loss');
    expect(losses.length).toBeGreaterThan(0);
    const loserLines = harness.lines.filter((l) => l.text.includes('points behind'));
    expect(loserLines.length).toBeGreaterThan(0);
    for (const line of harness.lines) {
      expect(line.refEventIds?.length ?? 0).toBeGreaterThan(0);
    }
  });
});

/* -------------------------------------------------------------------------- */
/*  Milestones                                                                 */
/* -------------------------------------------------------------------------- */

describe('milestone delivery', () => {
  it('cascades a miss into a penalty, a past-performance drop and a public event', () => {
    const state = makeState();
    // VectorWorks holds 7,000 accelerators against a 20,000-unit milestone.
    contractWithDueMilestone(state, 'cmp_vector', 20_000);
    const before = companyOf(state, 'cmp_vector').governmentPastPerformance;

    const harness = makeContext(1);
    createGovernmentSubsystem().advanceMilestones(state, harness.ctx);

    const contract = state.governmentContracts[0];
    expect(contract?.milestones[0]?.status).toBe('late');
    expect(contract?.penaltiesUsd).toBeGreaterThan(0);
    expect(companyOf(state, 'cmp_vector').governmentPastPerformance).toBeCloseTo(before + PAST_PERFORMANCE_MOVES.late, 4);

    const penalties = eventsOfType(harness, 'contract_penalty');
    expect(penalties.length).toBe(1);
    expect(penalties[0]?.visibility).toBe('public');
    expect(harness.lines.some((l) => l.tone === 'negative' && l.text.includes('missed'))).toBe(true);

    // The aggregate procurement record carries it too.
    const record = state.contractorReputations.find((r) => r.companyId === 'cmp_vector' && r.agencyId === null);
    expect(record?.pastPerformanceScore).toBeLessThan(50);
  });

  it('escalates a second miss to failure and calls a risk-committee review', () => {
    const state = makeState();
    contractWithDueMilestone(state, 'cmp_nexus', 400_000);
    const government = createGovernmentSubsystem();

    government.advanceMilestones(state, makeContext(1).ctx);
    expect(state.governmentContracts[0]?.milestones[0]?.status).toBe('late');

    const second = makeContext(2);
    government.advanceMilestones(state, second.ctx);
    expect(state.governmentContracts[0]?.milestones[0]?.status).toBe('failed');

    const review = state.boardProposals.find((p) => p.kind === 'gov_contract');
    expect(review).toBeDefined();
    expect(review?.status).toBe('tabled');
    expect(review?.linkedActionId).toBe('gct_sovereign_1');
    // Tabled by a director who actually sits on the risk committee.
    const board = state.boards[0];
    const proposer = board?.directors.find((d) => d.characterId === review?.proposedByCharacterId);
    expect(proposer?.committees).toContain('risk');
    expect(eventsOfType(second, 'board_proposal_submitted').length).toBe(1);
  });

  it('stages delivered value into deferred revenue and never into revenue', () => {
    const state = makeState();
    contractWithDueMilestone(state, 'cmp_helix', 1_000);
    const revenueBefore = companyOf(state, 'cmp_helix').financials.revenueQuarterly;

    const harness = makeContext(1);
    createGovernmentSubsystem().advanceMilestones(state, harness.ctx);

    const contract = state.governmentContracts[0];
    const company = companyOf(state, 'cmp_helix');
    expect(contract?.milestones[0]?.status).toBe('delivered');
    expect(company.financials.deferredRevenue).toBeCloseTo(200_000_000, 2);
    expect(company.financials.backlogUsd).toBeCloseTo(200_000_000, 2);
    expect(company.financials.revenueQuarterly).toBe(revenueBefore);
    expect(contract?.recognisedToDateUsd).toBeCloseTo(200_000_000, 2);

    // The compliance burden is emitted for the financial phase, not deducted here.
    const costs = eventsOfType(harness, 'cost_recognised');
    expect(costs.length).toBe(1);
    expect(costs[0]?.payload.kind).toBe('government_compliance_burden');
    expect(company.financials.cash).toBe(makeState().companies.find((c) => c.id === 'cmp_helix')?.financials.cash);
  });
});

/* -------------------------------------------------------------------------- */
/*  Opening and determinism                                                    */
/* -------------------------------------------------------------------------- */

describe('opportunity generation', () => {
  it('produces schema-valid weights and is reproducible under a fixed seed', () => {
    const runOnce = (): SessionState => {
      const state = makeState();
      state.procurementOpportunities = [];
      const harness = makeContext(4);
      createGovernmentSubsystem().openOpportunities(state, harness.ctx);
      return state;
    };

    const a = runOnce();
    const b = runOnce();
    expect(JSON.stringify(a.procurementOpportunities)).toBe(JSON.stringify(b.procurementOpportunities));

    for (const opportunity of a.procurementOpportunities) {
      expect(EvaluationWeightsSchema.safeParse(opportunity.evaluationWeights).success).toBe(true);
      expect(opportunity.closeQuarter).toBeGreaterThan(opportunity.openQuarter);
      expect(opportunity.maxValue).toBeGreaterThan(0);
      // Requirements scale to the programme: a defence programme is harder.
      if (opportunity.agencyId === 'agy_defence') {
        expect(opportunity.requirements.minimumPastPerformance).toBeGreaterThan(30);
      }
    }
  });

  it('resolves the whole phase identically from an identical state', () => {
    const run = (state: SessionState) => {
      const harness = makeContext(1);
      const government = createGovernmentSubsystem();
      government.openOpportunities(state, harness.ctx);
      government.scoreBids(state, harness.ctx);
      government.awardContracts(state, harness.ctx);
      government.advanceMilestones(state, harness.ctx);
      return { state, events: harness.events };
    };

    const first = run(competitiveState());
    const second = run(cloneState(competitiveState()));
    expect(JSON.stringify(second.events)).toBe(JSON.stringify(first.events));
    expect(JSON.stringify(second.state.governmentContracts)).toBe(JSON.stringify(first.state.governmentContracts));
  });
});
