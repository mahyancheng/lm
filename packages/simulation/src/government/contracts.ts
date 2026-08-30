/**
 * @frontier/simulation — government/contracts.ts
 *
 * Awards, contracts in flight and the long reputational tail of both.
 *
 * The money discipline here matters. Government resolution is phase 7 and
 * financial resolution is phase 11, so this module **stages** value and never
 * books it:
 *
 * ```text
 * award              backlogUsd += contract value          (no revenue yet)
 * milestone accepted backlogUsd -> deferredRevenue         (still no revenue)
 * financial phase    deferredRevenue -> revenueQuarterly   (recognised there)
 * ```
 *
 * Neither `backlogUsd` nor `financials.deferredRevenue` is part of the balance
 * sheet, so nothing in this file can break the balance-sheet identity. Penalties
 * and the standing compliance burden are recorded on the contract and emitted to
 * the ledger for the financial phase to settle; they are not deducted from cash
 * twice.
 */

import type {
  BidScoreBreakdown,
  Company,
  ContractMilestone,
  ContractorReputation,
  GovernmentContract,
  ProcurementOpportunity,
  ResolverContext,
  SeededRng,
  SessionState,
  StoredGovernmentBid,
} from '@frontier/contracts';
import { DEFAULT_QUORUM_RULE, makeId } from '@frontier/contracts';
import { rememberEvent, ceoOf } from '../relationships/relations';
import { bidTeam, engineCostEstimate, programmeScale, teamBreadth, type BidTeam } from './scoring';
import { clamp, companyById, emitEvent, headcount, heldCompute, line, money, ratio, round, score100, unit, usdLabel } from './util';

/* -------------------------------------------------------------------------- */
/*  Balancing constants                                                        */
/* -------------------------------------------------------------------------- */

/** Below this share of the capacity a milestone needs, delivery fails outright. */
export const CAPACITY_FAIL_THRESHOLD = 0.6;

/** Below this delivery quality the milestone is missed rather than accepted. */
export const MISS_QUALITY_THRESHOLD = 0.35;

/** Below this quality the agency accepts with reservations, which still hurts. */
export const RESERVATION_QUALITY = 0.5;

/** Penalty as a share of milestone value, by contract form. */
export const PENALTY_RATE = { fixed_price: 0.06, cost_plus: 0.03 } as const;

/** Past-performance movement, in points. */
export const PAST_PERFORMANCE_MOVES = {
  delivered: 2.5,
  deliveredWithReservations: -2,
  late: -6,
  failed: -14,
  completed: 6,
  terminated: -25,
  won: 1,
  /**
   * Credit for delivering somebody else's programme as a consortium member or a
   * subcontractor. Smaller than winning outright, and the only route to a first
   * past-performance point for a company no agency would let bid alone.
   */
  partnered: 3,
} as const;

/** Share of a company's technical staff that can be on public work at once. */
export const GOVERNMENT_STAFF_AVAILABILITY = 0.35;

/* -------------------------------------------------------------------------- */
/*  Contractor reputation                                                      */
/* -------------------------------------------------------------------------- */

/** Find or create the reputation record for one company with one agency. */
export function ensureReputation(draft: SessionState, companyId: string, agencyId: string | null, quarter: number): ContractorReputation {
  const existing = draft.contractorReputations.find((r) => r.companyId === companyId && r.agencyId === agencyId);
  if (existing !== undefined) return existing;
  const company = companyById(draft, companyId);
  const created: ContractorReputation = {
    companyId,
    agencyId,
    pastPerformanceScore: company?.governmentPastPerformance ?? 50,
    onTimeDeliveryPct: 0.8,
    costOverrunPct: 0,
    securityIncidents: 0,
    contractsWon: 0,
    contractsLost: 0,
    terminationsForDefault: 0,
    lastUpdatedQuarter: quarter,
  };
  draft.contractorReputations.push(created);
  return created;
}

/** Move a company's past-performance score, on the record and on the company. */
export function movePastPerformance(draft: SessionState, companyId: string, agencyId: string, delta: number, quarter: number): number {
  const company = companyById(draft, companyId);
  const agencyRecord = ensureReputation(draft, companyId, agencyId, quarter);
  const aggregate = ensureReputation(draft, companyId, null, quarter);
  agencyRecord.pastPerformanceScore = score100(agencyRecord.pastPerformanceScore + delta);
  aggregate.pastPerformanceScore = score100(aggregate.pastPerformanceScore + delta);
  agencyRecord.lastUpdatedQuarter = quarter;
  aggregate.lastUpdatedQuarter = quarter;
  if (company !== null) {
    company.governmentPastPerformance = score100(company.governmentPastPerformance + delta);
    company.reputation.government = score100(company.reputation.government + delta * 0.5);
  }
  return aggregate.pastPerformanceScore;
}

/** Recompute the derived delivery statistics from the contracts themselves. */
export function refreshDeliveryStatistics(draft: SessionState, companyId: string, agencyId: string, quarter: number): void {
  for (const scope of [agencyId, null] as const) {
    const record = ensureReputation(draft, companyId, scope, quarter);
    const contracts = draft.governmentContracts.filter((c) => c.primeCompanyId === companyId && (scope === null || c.agencyId === scope));
    let onTime = 0;
    let resolved = 0;
    let value = 0;
    let penalties = 0;
    for (const contract of contracts) {
      value += contract.totalValueUsd;
      penalties += contract.penaltiesUsd;
      for (const milestone of contract.milestones) {
        if (milestone.status === 'pending' || milestone.status === 'in_progress') continue;
        resolved += 1;
        if (milestone.status === 'delivered' && milestone.completedQuarter !== null && milestone.completedQuarter <= milestone.dueQuarter) onTime += 1;
      }
    }
    record.onTimeDeliveryPct = resolved === 0 ? record.onTimeDeliveryPct : unit(onTime / resolved);
    record.costOverrunPct = clamp(ratio(penalties, value, 0), -1, 5);
    record.lastUpdatedQuarter = quarter;
  }
}

/* -------------------------------------------------------------------------- */
/*  Building a contract                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Split a programme into milestones. More milestones mean earlier revenue
 * recognition and more chances to miss, which is exactly the trade-off the bid
 * made when it chose `milestoneCount`.
 */
export function buildMilestones(
  opportunity: ProcurementOpportunity,
  bid: StoredGovernmentBid,
  contractId: string,
  totalValueUsd: number,
  awardQuarter: number,
): ContractMilestone[] {
  const count = clamp(Math.trunc(bid.timeline.milestoneCount), 1, 20);
  const span = clamp(Math.trunc(bid.timeline.deliveryQuarters), 1, Math.max(1, opportunity.durationQuarters));
  const each = money(totalValueUsd / count);
  const milestones: ContractMilestone[] = [];
  let assigned = 0;

  for (let index = 0; index < count; index += 1) {
    const last = index === count - 1;
    const valueUsd = last ? money(totalValueUsd - assigned) : each;
    assigned += valueUsd;
    const dueQuarter = awardQuarter + Math.max(1, Math.round(((index + 1) * span) / count));
    const loadShare = 0.6 + (0.4 * (index + 1)) / count;
    milestones.push({
      id: makeId('mil', contractId, index + 1),
      label: `${opportunity.programme} — milestone ${index + 1} of ${count}`.slice(0, 140),
      dueQuarter,
      valueUsd,
      status: 'pending',
      completedQuarter: null,
      qualityScore: 0,
      computeRequiredUnits: Math.max(0, Math.round(bid.computeCommitment.acceleratorUnits * loadShare)),
    });
  }
  return milestones;
}

/** A team as it stands after award, for delivery assessment. */
function contractTeam(draft: SessionState, contract: GovernmentContract): BidTeam | null {
  const prime = companyById(draft, contract.primeCompanyId);
  if (prime === null) return null;
  const partners: { company: Company; weight: number }[] = [];
  for (const memberId of contract.consortiumMemberIds) {
    const member = companyById(draft, memberId);
    if (member !== null && member.id !== prime.id) partners.push({ company: member, weight: 1 });
  }
  for (const sub of contract.subcontractors) {
    const company = companyById(draft, sub.companyId);
    if (company !== null && company.id !== prime.id) partners.push({ company, weight: unit(sub.sharePct / 0.25) });
  }
  return { prime, partners };
}

/* -------------------------------------------------------------------------- */
/*  Awarding                                                                   */
/* -------------------------------------------------------------------------- */

export interface AwardResult {
  readonly contract: GovernmentContract;
  readonly eventId: string;
}

/** Create the contract, stage the backlog and record the win. */
export function createContract(
  draft: SessionState,
  ctx: ResolverContext,
  opportunity: ProcurementOpportunity,
  bid: StoredGovernmentBid,
  breakdown: BidScoreBreakdown,
): AwardResult | null {
  const team = bidTeam(draft, bid);
  if (team === null) return null;
  const agency = draft.agencies.find((a) => a.id === opportunity.agencyId) ?? null;
  const totalValueUsd = money(Math.min(bid.price, opportunity.maxValue));
  const contractId = makeId('gct', draft.sessionId, opportunity.id, bid.bidderCompanyId);
  const estimate = engineCostEstimate(draft, opportunity, bid, team);

  const defenceLike = agency !== null && (agency.jurisdiction === 'defence' || agency.jurisdiction === 'intelligence');
  const contract: GovernmentContract = {
    id: contractId,
    opportunityId: opportunity.id,
    agencyId: opportunity.agencyId,
    primeCompanyId: bid.bidderCompanyId,
    consortiumMemberIds: [...bid.consortiumMemberIds],
    subcontractors: bid.subcontractors.map((s) => ({ ...s })),
    awardedQuarter: ctx.quarter,
    contractForm: opportunity.contractForm,
    totalValueUsd,
    recognisedToDateUsd: 0,
    milestones: buildMilestones(opportunity, bid, contractId, totalValueUsd, ctx.quarter),
    performanceToDate: score100(team.prime.governmentPastPerformance),
    penaltiesUsd: 0,
    complianceBurdenQuarterlyUsd: estimate.complianceQuarterlyUsd,
    status: 'active',
    exportRestricted: defenceLike || opportunity.requirements.dataSovereignty,
    publicControversyLevel: unit(
      (defenceLike ? 0.45 : 0.12) + 0.25 * draft.world.society.automationAnxiety + 0.2 * draft.world.media.controversyIntensity,
    ),
  };
  draft.governmentContracts.push(contract);

  // An award creates backlog, never revenue.
  team.prime.financials.backlogUsd = money(team.prime.financials.backlogUsd + totalValueUsd);

  const reputation = ensureReputation(draft, team.prime.id, opportunity.agencyId, ctx.quarter);
  reputation.contractsWon += 1;
  ensureReputation(draft, team.prime.id, null, ctx.quarter).contractsWon += 1;
  movePastPerformance(draft, team.prime.id, opportunity.agencyId, PAST_PERFORMANCE_MOVES.won, ctx.quarter);

  // Junior partners are on the award too. A consortium seat or a subcontract is
  // how a company with no record earns its first one, which is what keeps the
  // programme floors from closing procurement to every new entrant for good.
  const partners = new Set<string>([...contract.consortiumMemberIds, ...contract.subcontractors.map((s) => s.companyId)]);
  partners.delete(team.prime.id);
  for (const partnerId of [...partners].sort()) {
    const partner = companyById(draft, partnerId);
    if (partner === null || !partner.isActive) continue;
    ensureReputation(draft, partnerId, opportunity.agencyId, ctx.quarter).contractsWon += 1;
    movePastPerformance(draft, partnerId, opportunity.agencyId, PAST_PERFORMANCE_MOVES.partnered, ctx.quarter);
    emitEvent(
      draft,
      ctx,
      'contract_awarded',
      partnerId,
      contractId,
      {
        opportunityId: opportunity.id,
        agencyId: opportunity.agencyId,
        programme: opportunity.programme,
        role: contract.consortiumMemberIds.includes(partnerId) ? 'consortium_member' : 'subcontractor',
        primeCompanyId: team.prime.id,
        pastPerformanceAfter: round(partner.governmentPastPerformance, 2),
      },
      'public',
    );
  }

  const eventId = emitEvent(
    draft,
    ctx,
    'contract_awarded',
    team.prime.id,
    contract.id,
    {
      opportunityId: opportunity.id,
      agencyId: opportunity.agencyId,
      programme: opportunity.programme,
      contractForm: contract.contractForm,
      totalValueUsd: contract.totalValueUsd,
      milestoneCount: contract.milestones.length,
      exportRestricted: contract.exportRestricted,
      publicControversyLevel: round(contract.publicControversyLevel, 3),
      complianceBurdenQuarterlyUsd: contract.complianceBurdenQuarterlyUsd,
      consortiumMemberIds: contract.consortiumMemberIds,
      winningScore: breakdown.weightedTotal,
      axes: {
        technical: breakdown.technical,
        security: breakdown.security,
        pastPerformance: breakdown.pastPerformance,
        priceRealism: breakdown.priceRealism,
        schedule: breakdown.schedule,
        domesticSupply: breakdown.domesticSupply,
        responsibleAi: breakdown.responsibleAi,
      },
    },
    // An award is public information: it is how a competitor learns they lost.
    'public',
  );

  const ceo = ceoOf(draft, team.prime.id);
  if (ceo !== null && agency !== null) {
    for (const contactId of agency.contactCharacterIds) {
      rememberEvent(draft, ctx, {
        ownerCharacterId: contactId,
        aboutId: team.prime.id,
        kind: 'contract_win',
        summary: `We awarded ${team.prime.name} the ${opportunity.programme} programme.`,
        sentiment: 0.5,
        stableKey: `${contract.id}_award`,
      });
    }
  }

  return { contract, eventId };
}

/* -------------------------------------------------------------------------- */
/*  Milestone delivery                                                         */
/* -------------------------------------------------------------------------- */

interface DeliveryAssessment {
  readonly capacityRatio: number;
  readonly staffRatio: number;
  readonly capability: number;
  readonly quality: number;
}

function assessDelivery(milestone: ContractMilestone, coverage: number, team: BidTeam, rng: SeededRng): DeliveryAssessment {
  const prime = team.prime;
  const requiredStaff = Math.max(
    1,
    Math.round((milestone.valueUsd * 0.4) / Math.max(1, prime.employees.avgComp / 4)),
  );
  const availableStaff = (prime.employees.engineers + prime.employees.researchers) * GOVERNMENT_STAFF_AVAILABILITY;
  const staffRatio = unit(ratio(availableStaff, requiredStaff, 0));
  const capability = teamBreadth(team);
  const capacityRatio = unit(coverage);
  const base = 0.4 * capacityRatio + 0.25 * staffRatio + 0.35 * capability;
  // Execution variance: the only random draw in the government phase.
  const quality = unit(base * (0.85 + 0.3 * rng.next()));
  return { capacityRatio, staffRatio, capability, quality };
}

/** Table a risk-committee investigation after a failed milestone. */
function tableRiskReview(draft: SessionState, ctx: ResolverContext, contract: GovernmentContract, milestone: ContractMilestone): string | null {
  const company = companyById(draft, contract.primeCompanyId);
  if (company === null || company.boardId === null) return null;
  const board = draft.boards.find((b) => b.id === company.boardId);
  if (board === undefined) return null;
  const investigator = board.directors.find((d) => d.committees.includes('risk')) ?? board.directors.find((d) => d.committees.includes('audit'));
  if (investigator === undefined) return null;

  const proposalId = makeId('prp', contract.id, 'risk_review', milestone.id);
  if (draft.boardProposals.some((p) => p.id === proposalId)) return null;

  const rule = board.quorumRule ?? DEFAULT_QUORUM_RULE;
  draft.boardProposals.push({
    id: proposalId,
    companyId: company.id,
    boardId: board.id,
    kind: 'gov_contract',
    title: `Continuation review: ${contract.id}`.slice(0, 140),
    summary:
      `The risk committee has called a review of the ${contract.id} programme after milestone ${milestone.label} failed. ` +
      `Contract value ${usdLabel(contract.totalValueUsd)}, penalties to date ${usdLabel(contract.penaltiesUsd)}. ` +
      'A vote against directs management to withdraw from the programme.',
    proposedByCharacterId: investigator.characterId,
    quarterProposed: ctx.quarter,
    decisionQuarter: ctx.quarter + 1,
    status: 'tabled',
    amountUsd: contract.totalValueUsd,
    dilutionPct: null,
    stockComponentPct: null,
    targetCompanyId: null,
    // The matter under review, so a failed vote knows what to suspend.
    linkedActionId: contract.id,
    requiredThresholdFraction: rule.passThresholdFraction,
  });

  return emitEvent(
    draft,
    ctx,
    'board_proposal_submitted',
    investigator.characterId,
    proposalId,
    { kind: 'gov_contract', contractId: contract.id, milestoneId: milestone.id, reason: 'risk_committee_investigation' },
    'company',
  );
}

export interface MilestoneOutcome {
  readonly contractId: string;
  readonly milestoneId: string;
  readonly status: ContractMilestone['status'];
  readonly qualityScore: number;
  readonly penaltyUsd: number;
  readonly stagedRevenueUsd: number;
}

/**
 * Advance every milestone that falls due, recognise contracted value into
 * deferred revenue, apply penalties and move past performance.
 */
export function advanceMilestones(draft: SessionState, ctx: ResolverContext): MilestoneOutcome[] {
  const rng = ctx.rng.fork(`government_delivery_q${ctx.quarter}`);
  const outcomes: MilestoneOutcome[] = [];

  // Capacity is company-wide: two programmes due in the same quarter compete
  // for the same accelerators, which is exactly the lock-in a large award buys.
  const demand = new Map<string, number>();
  for (const contract of draft.governmentContracts) {
    if (contract.status !== 'active') continue;
    for (const milestone of contract.milestones) {
      if (milestone.status !== 'pending' && milestone.status !== 'in_progress' && milestone.status !== 'late') continue;
      if (milestone.dueQuarter > ctx.quarter) continue;
      demand.set(contract.primeCompanyId, (demand.get(contract.primeCompanyId) ?? 0) + milestone.computeRequiredUnits);
    }
  }

  for (const contract of draft.governmentContracts) {
    if (contract.status !== 'active') continue;
    const team = contractTeam(draft, contract);
    if (team === null) continue;
    const prime = team.prime;

    // The standing compliance cost, whether or not a milestone falls due. The
    // financial phase books it; the ledger records it here.
    if (contract.complianceBurdenQuarterlyUsd > 0) {
      emitEvent(
        draft,
        ctx,
        'cost_recognised',
        prime.id,
        contract.id,
        { kind: 'government_compliance_burden', amountUsd: contract.complianceBurdenQuarterlyUsd, quarter: ctx.quarter },
        'company',
      );
    }

    const totalRequired = demand.get(prime.id) ?? 0;
    const coverage = totalRequired === 0 ? 1 : unit(ratio(heldCompute(prime), totalRequired, 0));

    let failedCount = contract.milestones.filter((m) => m.status === 'failed').length;

    for (const milestone of contract.milestones) {
      const dueNow = milestone.dueQuarter <= ctx.quarter;
      if (!dueNow) continue;
      if (milestone.status === 'delivered' || milestone.status === 'failed' || milestone.status === 'waived') continue;

      const assessment = assessDelivery(milestone, coverage, team, rng);
      const missed = assessment.capacityRatio < CAPACITY_FAIL_THRESHOLD || assessment.quality < MISS_QUALITY_THRESHOLD;

      if (missed) {
        const alreadyLate = milestone.status === 'late';
        milestone.status = alreadyLate ? 'failed' : 'late';
        if (milestone.status === 'failed') failedCount += 1;
        const penalty = money(milestone.valueUsd * PENALTY_RATE[contract.contractForm] * (alreadyLate ? 2 : 1));
        contract.penaltiesUsd = money(contract.penaltiesUsd + penalty);
        const drop = alreadyLate ? PAST_PERFORMANCE_MOVES.failed : PAST_PERFORMANCE_MOVES.late;
        contract.performanceToDate = score100(contract.performanceToDate + drop);
        movePastPerformance(draft, prime.id, contract.agencyId, drop, ctx.quarter);

        const eventId = emitEvent(
          draft,
          ctx,
          'contract_penalty',
          prime.id,
          contract.id,
          {
            milestoneId: milestone.id,
            status: milestone.status,
            penaltyUsd: penalty,
            capacityRatio: round(assessment.capacityRatio, 3),
            staffRatio: round(assessment.staffRatio, 3),
            qualityScore: round(assessment.quality, 3),
            pastPerformanceDelta: drop,
          },
          // A missed public milestone is public: it is how the market learns.
          'public',
        );
        ctx.log({
          phase: 'government_resolution',
          text: line(
            `${prime.name} missed "${milestone.label}" (${Math.round(assessment.capacityRatio * 100)}% of the capacity it needed). Penalty ${usdLabel(penalty)}, past performance ${drop}.`,
          ),
          deltaLabel: `${drop}pp`,
          refEventIds: [eventId],
          tone: 'negative',
          subjectId: prime.id,
        });

        if (milestone.status === 'failed') {
          const reviewEventId = tableRiskReview(draft, ctx, contract, milestone);
          if (reviewEventId !== null) {
            ctx.log({
              phase: 'government_resolution',
              text: line(`The risk committee called a continuation review of ${contract.id} after a failed milestone.`),
              deltaLabel: null,
              refEventIds: [reviewEventId],
              tone: 'warning',
              subjectId: prime.id,
            });
          }
        }

        outcomes.push({
          contractId: contract.id,
          milestoneId: milestone.id,
          status: milestone.status,
          qualityScore: round(assessment.quality, 4),
          penaltyUsd: penalty,
          stagedRevenueUsd: 0,
        });
        continue;
      }

      milestone.status = 'delivered';
      milestone.completedQuarter = ctx.quarter;
      milestone.qualityScore = round(assessment.quality, 4);

      // Staged, not recognised: the financial phase turns deferred revenue into
      // revenue, and only it moves cash.
      prime.financials.backlogUsd = money(Math.max(0, prime.financials.backlogUsd - milestone.valueUsd));
      prime.financials.deferredRevenue = money(prime.financials.deferredRevenue + milestone.valueUsd);
      contract.recognisedToDateUsd = money(contract.recognisedToDateUsd + milestone.valueUsd);

      const reservations = assessment.quality < RESERVATION_QUALITY;
      const move = reservations ? PAST_PERFORMANCE_MOVES.deliveredWithReservations : PAST_PERFORMANCE_MOVES.delivered;
      contract.performanceToDate = score100(contract.performanceToDate + move);
      movePastPerformance(draft, prime.id, contract.agencyId, move, ctx.quarter);

      const eventId = emitEvent(
        draft,
        ctx,
        'contract_milestone',
        prime.id,
        contract.id,
        {
          milestoneId: milestone.id,
          status: 'delivered',
          acceptedWithReservations: reservations,
          qualityScore: milestone.qualityScore,
          stagedRevenueUsd: milestone.valueUsd,
          capacityRatio: round(assessment.capacityRatio, 3),
          pastPerformanceDelta: move,
        },
        'public',
      );
      ctx.log({
        phase: 'government_resolution',
        text: line(
          `${prime.name} delivered "${milestone.label}"${reservations ? ', accepted with reservations' : ''}. ${usdLabel(milestone.valueUsd)} moved from backlog into deferred revenue.`,
        ),
        deltaLabel: `${move >= 0 ? '+' : ''}${move}pp`,
        refEventIds: [eventId],
        tone: reservations ? 'warning' : 'positive',
        subjectId: prime.id,
      });

      outcomes.push({
        contractId: contract.id,
        milestoneId: milestone.id,
        status: 'delivered',
        qualityScore: milestone.qualityScore,
        penaltyUsd: 0,
        stagedRevenueUsd: milestone.valueUsd,
      });
    }

    refreshDeliveryStatistics(draft, prime.id, contract.agencyId, ctx.quarter);

    // Termination for default: the worst outcome in this subsystem, and it
    // follows the company for the rest of the session.
    const terminationThreshold = Math.max(2, Math.ceil(contract.milestones.length / 3));
    if (failedCount >= terminationThreshold) {
      contract.status = 'terminated';
      const record = ensureReputation(draft, prime.id, contract.agencyId, ctx.quarter);
      record.terminationsForDefault += 1;
      ensureReputation(draft, prime.id, null, ctx.quarter).terminationsForDefault += 1;
      movePastPerformance(draft, prime.id, contract.agencyId, PAST_PERFORMANCE_MOVES.terminated, ctx.quarter);
      prime.financials.backlogUsd = money(
        Math.max(0, prime.financials.backlogUsd - Math.max(0, contract.totalValueUsd - contract.recognisedToDateUsd)),
      );

      const eventId = emitEvent(
        draft,
        ctx,
        'contract_terminated',
        prime.id,
        contract.id,
        { reason: 'default', failedMilestones: failedCount, penaltiesUsd: contract.penaltiesUsd },
        'public',
      );
      ctx.log({
        phase: 'government_resolution',
        text: line(`${contract.id} was terminated for default after ${failedCount} failed milestones. ${prime.name}'s procurement record will carry it for the rest of the session.`),
        deltaLabel: `${PAST_PERFORMANCE_MOVES.terminated}pp`,
        refEventIds: [eventId],
        tone: 'negative',
        subjectId: prime.id,
      });

      const agency = draft.agencies.find((a) => a.id === contract.agencyId);
      for (const contactId of agency?.contactCharacterIds ?? []) {
        rememberEvent(draft, ctx, {
          ownerCharacterId: contactId,
          aboutId: prime.id,
          kind: 'betrayal',
          summary: `${prime.name} failed the ${contract.id} programme and we terminated it for default.`,
          sentiment: -0.95,
          stableKey: `${contract.id}_terminated`,
        });
      }
      continue;
    }

    const outstanding = contract.milestones.some((m) => m.status !== 'delivered' && m.status !== 'waived');
    if (!outstanding) {
      contract.status = 'completed';
      movePastPerformance(draft, prime.id, contract.agencyId, PAST_PERFORMANCE_MOVES.completed, ctx.quarter);
      const eventId = emitEvent(
        draft,
        ctx,
        'contract_milestone',
        prime.id,
        contract.id,
        { status: 'contract_completed', recognisedToDateUsd: contract.recognisedToDateUsd, penaltiesUsd: contract.penaltiesUsd },
        'public',
      );
      ctx.log({
        phase: 'government_resolution',
        text: line(`${prime.name} completed ${contract.id} in full. Past performance rose ${PAST_PERFORMANCE_MOVES.completed} points.`),
        deltaLabel: `+${PAST_PERFORMANCE_MOVES.completed}pp`,
        refEventIds: [eventId],
        tone: 'positive',
        subjectId: prime.id,
      });
    }
  }

  return outcomes;
}

/** Total headcount helper re-exported for delivery diagnostics. */
export { headcount, programmeScale };
