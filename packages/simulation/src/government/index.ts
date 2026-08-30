/**
 * @frontier/simulation — government
 *
 * Public procurement as a complete strategic subsystem. Phase 7,
 * `government_resolution`, after boards and capital and before talent.
 *
 * ```text
 * openOpportunities   world.government.* + agency budgets -> new competitions
 * scoreBids           requirement gates, then seven weighted axes
 * awardContracts      highest weighted total wins; backlog, not revenue
 * advanceMilestones   deliver, stage revenue, penalise, move past performance
 * ```
 *
 * The design claim the whole module serves: **winning is not automatically
 * good.** An award brings backlog, credibility and stable demand, and with it
 * compliance cost, capacity lock-in, export restrictions, employee unease and
 * cost-overrun risk. A player who bids on everything loses.
 *
 * Connections change which opportunities a company can see and what it knows
 * about them. They never touch `scoreBids`: there is no relationship term in the
 * scoring model and no hidden bribery statistic anywhere in this package.
 */

import type {
  Agency,
  BidScoreBreakdown,
  GovernmentSubsystem,
  ProcurementOpportunity,
  ResolverContext,
  SeededRng,
  SessionState,
  StoredGovernmentBid,
} from '@frontier/contracts';
import { EvaluationWeightsSchema, makeId } from '@frontier/contracts';
import { ceoOf, rememberEvent } from '../relationships/relations';
import {
  PROGRAMME_TEMPLATES,
  evaluationWeightsFor,
  programmeDemand,
  requirementsFor,
  templatesForAgency,
  type ProgrammeTemplate,
} from './programmes';
import { scoreOpportunityBids } from './scoring';
import { advanceMilestones, createContract, ensureReputation } from './contracts';
import { clamp, companyById, emitEvent, line, money, round, unit, usdLabel } from './util';

export * from './programmes';
export {
  bidTeam,
  teamCapability,
  teamBreadth,
  creditedClaim,
  programmeScale,
  engineCostEstimate,
  costRealism,
  pastPerformanceScore,
  recordPastPerformance,
  disqualificationReasons,
  scoreOpportunityBids,
  CLAIM_CREDIBILITY_FLOOR,
  ACCELERATOR_QUARTER_COST_USD,
  SCOPE_COST_RATIO,
  PRICE_REALISM_BANDS,
  COMPLIANCE_BASE_RATE,
} from './scoring';
export type { BidTeam, CostEstimate, ProgrammeScale } from './scoring';
export {
  advanceMilestones,
  buildMilestones,
  createContract,
  ensureReputation,
  movePastPerformance,
  refreshDeliveryStatistics,
  CAPACITY_FAIL_THRESHOLD,
  MISS_QUALITY_THRESHOLD,
  RESERVATION_QUALITY,
  PENALTY_RATE,
  PAST_PERFORMANCE_MOVES,
  GOVERNMENT_STAFF_AVAILABILITY,
} from './contracts';
export type { AwardResult, MilestoneOutcome } from './contracts';

/* -------------------------------------------------------------------------- */
/*  Balancing constants                                                        */
/* -------------------------------------------------------------------------- */

/** Most competitions the engine will open in one quarter. */
export const MAX_OPENINGS_PER_QUARTER = 2;

/** Most competitions that may stand open at once across the whole session. */
export const MAX_OPEN_OPPORTUNITIES = 6;

/** Standing a company needs before an invited or classified competition reaches it. */
export const INVITATION_PAST_PERFORMANCE_MARGIN = 5;

/* -------------------------------------------------------------------------- */
/*  Opening                                                                    */
/* -------------------------------------------------------------------------- */

const LEDGER_VISIBILITY = { public: 'public', invited: 'sector', classified: 'private' } as const;

function alreadyRunning(draft: SessionState, agency: Agency, template: ProgrammeTemplate): boolean {
  return draft.procurementOpportunities.some(
    (o) => o.agencyId === agency.id && o.programme === template.label && (o.status === 'open' || o.status === 'evaluating'),
  );
}

/** Companies standing high enough to be invited to a restricted competition. */
function invitees(draft: SessionState, minimumPastPerformance: number): string[] {
  return draft.companies
    .filter((c) => c.isActive && c.governmentPastPerformance >= minimumPastPerformance - INVITATION_PAST_PERFORMANCE_MARGIN)
    .map((c) => c.id);
}

/** Build one opportunity from a template, an agency and the world. */
export function buildOpportunity(
  draft: SessionState,
  agency: Agency,
  template: ProgrammeTemplate,
  quarter: number,
  rng: SeededRng,
): ProcurementOpportunity {
  const budgetPressure = 0.6 + 0.8 * draft.world.government.procurementBudget;
  const jitter = rng.range(0.85, 1.2);
  const maxValue = money(Math.max(1_000_000, agency.budgetQuarterlyUsd * template.budgetShare * budgetPressure * jitter));
  const sizeShare = agency.budgetQuarterlyUsd <= 0 ? template.budgetShare : maxValue / agency.budgetQuarterlyUsd;
  const requirements = requirementsFor(template, agency, draft.world, sizeShare);
  const weights = EvaluationWeightsSchema.parse(evaluationWeightsFor(template, agency));

  return {
    id: makeId('opp', draft.sessionId, quarter, agency.id, template.id),
    agencyId: agency.id,
    programme: template.label,
    description: template.description,
    maxValue,
    contractForm: template.contractForm,
    durationQuarters: template.durationQuarters,
    evaluationWeights: weights,
    requirements,
    openQuarter: quarter,
    closeQuarter: quarter + template.biddingQuarters,
    visibility: template.visibility,
    invitedCompanyIds: template.visibility === 'public' ? [] : invitees(draft, requirements.minimumPastPerformance),
    allowsConsortium: template.allowsConsortium,
    status: 'open',
  };
}

/* -------------------------------------------------------------------------- */
/*  Subsystem                                                                  */
/* -------------------------------------------------------------------------- */

/** The government subsystem, plus the helpers the resolver and tests reach for. */
export interface GovernmentSubsystemImpl extends GovernmentSubsystem {
  /** Move every competition whose bidding window has closed into evaluation. */
  closeExpiredOpportunities(draft: SessionState, ctx: ResolverContext): ProcurementOpportunity[];
}

export function createGovernmentSubsystem(): GovernmentSubsystemImpl {
  /* ------------------------------- opening ------------------------------- */

  function openOpportunities(draft: SessionState, ctx: ResolverContext): void {
    const rng = ctx.rng.fork(`government_open_q${ctx.quarter}`);
    const openCount = draft.procurementOpportunities.filter((o) => o.status === 'open').length;
    let pipeline = openCount;
    let opened = 0;

    for (const agency of draft.agencies) {
      if (opened >= MAX_OPENINGS_PER_QUARTER) break;
      for (const template of templatesForAgency(agency)) {
        if (opened >= MAX_OPENINGS_PER_QUARTER) break;
        if (pipeline >= MAX_OPEN_OPPORTUNITIES) break;
        if (alreadyRunning(draft, agency, template)) continue;

        const demand = programmeDemand(template, draft.world);
        const crowding = clamp(1 - pipeline / MAX_OPEN_OPPORTUNITIES, 0, 1);
        const hazard = unit(template.openRate * demand * (0.4 + 0.6 * crowding));
        if (rng.next() >= hazard) continue;

        const opportunity = buildOpportunity(draft, agency, template, ctx.quarter, rng);
        draft.procurementOpportunities.push(opportunity);
        opened += 1;
        pipeline += 1;

        const eventId = emitEvent(
          draft,
          ctx,
          'opportunity_opened',
          agency.id,
          opportunity.id,
          {
            programme: opportunity.programme,
            maxValue: opportunity.maxValue,
            contractForm: opportunity.contractForm,
            durationQuarters: opportunity.durationQuarters,
            closeQuarter: opportunity.closeQuarter,
            visibility: opportunity.visibility,
            evaluationWeights: opportunity.evaluationWeights,
            requirements: opportunity.requirements,
            demand: round(demand, 3),
            hazard: round(hazard, 3),
          },
          LEDGER_VISIBILITY[opportunity.visibility],
        );

        ctx.log({
          phase: 'government_resolution',
          text: line(
            `${agency.shortName} opened ${opportunity.programme} — ${usdLabel(opportunity.maxValue)} over ${opportunity.durationQuarters} quarters, ${opportunity.contractForm.replace('_', ' ')}, past-performance floor ${Math.round(opportunity.requirements.minimumPastPerformance)}.`,
          ),
          deltaLabel: `closes Q${opportunity.closeQuarter}`,
          refEventIds: [eventId],
          tone: 'neutral',
          subjectId: null,
        });
      }
    }
  }

  /* ------------------------------- evaluation ---------------------------- */

  function closeExpiredOpportunities(draft: SessionState, ctx: ResolverContext): ProcurementOpportunity[] {
    const closing: ProcurementOpportunity[] = [];
    for (const opportunity of draft.procurementOpportunities) {
      if (opportunity.status === 'open' && opportunity.closeQuarter <= ctx.quarter) {
        opportunity.status = 'evaluating';
        closing.push(opportunity);
      } else if (opportunity.status === 'evaluating') {
        closing.push(opportunity);
      }
    }
    return closing;
  }

  function bidsFor(draft: SessionState, opportunityId: string): StoredGovernmentBid[] {
    return draft.governmentBids
      .filter((b) => b.opportunityId === opportunityId && (b.status === 'submitted' || b.status === 'shortlisted'))
      .sort((a, b) => a.submittedQuarter - b.submittedQuarter || a.id.localeCompare(b.id));
  }

  function scoreBids(draft: SessionState, ctx: ResolverContext): BidScoreBreakdown[] {
    const all: BidScoreBreakdown[] = [];

    for (const opportunity of closeExpiredOpportunities(draft, ctx)) {
      const bids = bidsFor(draft, opportunity.id);
      if (bids.length === 0) continue;
      const breakdowns = scoreOpportunityBids(draft, opportunity, bids);
      all.push(...breakdowns);

      for (const breakdown of breakdowns) {
        const bid = bids.find((b) => b.id === breakdown.bidId);
        if (bid === undefined) continue;
        if (breakdown.disqualified) {
          bid.status = 'disqualified';
          bid.disqualificationReason = breakdown.notes.join(' ').slice(0, 400);
          const eventId = emitEvent(
            draft,
            ctx,
            'bid_disqualified',
            bid.bidderCompanyId,
            bid.id,
            { opportunityId: opportunity.id, reasons: breakdown.notes },
            'company',
          );
          ctx.log({
            phase: 'government_resolution',
            text: line(`${companyById(draft, bid.bidderCompanyId)?.name ?? bid.bidderCompanyId} was disqualified from ${opportunity.programme}: ${breakdown.notes[0] ?? 'a requirement was not met'}`),
            deltaLabel: null,
            refEventIds: [eventId],
            tone: 'negative',
            subjectId: bid.bidderCompanyId,
          });
        } else {
          bid.status = 'shortlisted';
          bid.disqualificationReason = null;
        }
      }

      // The evaluation record itself. Private until the award makes it public;
      // the breakdown is what the bidder is shown afterwards, so procurement
      // never feels like a dice roll.
      const eventId = emitEvent(
        draft,
        ctx,
        'information_revealed',
        null,
        opportunity.id,
        {
          kind: 'bid_evaluation',
          programme: opportunity.programme,
          evaluationWeights: opportunity.evaluationWeights,
          breakdowns: breakdowns.map((b) => ({
            bidId: b.bidId,
            companyId: b.companyId,
            rank: b.rank,
            weightedTotal: b.weightedTotal,
            disqualified: b.disqualified,
            technical: b.technical,
            security: b.security,
            pastPerformance: b.pastPerformance,
            priceRealism: b.priceRealism,
            schedule: b.schedule,
            domesticSupply: b.domesticSupply,
            responsibleAi: b.responsibleAi,
          })),
        },
        'private',
      );
      const scoredCount = breakdowns.filter((b) => !b.disqualified).length;
      ctx.log({
        phase: 'government_resolution',
        text: line(`${opportunity.programme} closed with ${scoredCount} scored bid(s) and ${breakdowns.length - scoredCount} disqualification(s).`),
        deltaLabel: `${breakdowns.length} bids`,
        refEventIds: [eventId],
        tone: 'neutral',
        subjectId: null,
      });
    }

    return all;
  }

  /* -------------------------------- award -------------------------------- */

  function awardContracts(draft: SessionState, ctx: ResolverContext): void {
    // Idempotent, and safe when called without a preceding scoreBids: a
    // competition whose window has closed is always in evaluation by here.
    closeExpiredOpportunities(draft, ctx);
    for (const opportunity of draft.procurementOpportunities) {
      if (opportunity.status !== 'evaluating' || opportunity.closeQuarter > ctx.quarter) continue;

      const bids = bidsFor(draft, opportunity.id);
      const breakdowns = scoreOpportunityBids(draft, opportunity, bids);
      const eligible = breakdowns.filter((b) => !b.disqualified).sort((a, b) => a.rank - b.rank);
      const winning = eligible[0];

      if (winning === undefined) {
        opportunity.status = 'cancelled';
        const eventId = emitEvent(
          draft,
          ctx,
          'information_revealed',
          null,
          opportunity.id,
          { kind: 'procurement_cancelled', programme: opportunity.programme, reason: 'no qualified bids', bidsReceived: bids.length },
          'public',
        );
        ctx.log({
          phase: 'government_resolution',
          text: line(`${opportunity.programme} was cancelled: no bid met the programme's requirements.`),
          deltaLabel: null,
          refEventIds: [eventId],
          tone: 'warning',
          subjectId: null,
        });
        continue;
      }

      const winningBid = bids.find((b) => b.id === winning.bidId);
      if (winningBid === undefined) continue;
      const award = createContract(draft, ctx, opportunity, winningBid, winning);
      if (award === null) continue;

      winningBid.status = 'won';
      opportunity.status = 'awarded';

      const winnerName = companyById(draft, winningBid.bidderCompanyId)?.name ?? winningBid.bidderCompanyId;
      const runnerUp = eligible[1];
      ctx.log({
        phase: 'government_resolution',
        text: line(
          `${winnerName} won ${opportunity.programme}, ${usdLabel(award.contract.totalValueUsd)} of backlog${runnerUp === undefined ? '' : `, ahead of the field by ${round((winning.weightedTotal - runnerUp.weightedTotal) * 100, 1)} points`}.`,
        ),
        deltaLabel: usdLabel(award.contract.totalValueUsd),
        refEventIds: [award.eventId],
        tone: 'positive',
        subjectId: winningBid.bidderCompanyId,
      });

      const winnerCeo = ceoOf(draft, winningBid.bidderCompanyId);
      if (winnerCeo !== null) {
        rememberEvent(draft, ctx, {
          ownerCharacterId: winnerCeo,
          aboutId: opportunity.agencyId,
          kind: 'contract_win',
          summary: `We took ${opportunity.programme} at ${usdLabel(award.contract.totalValueUsd)}.`,
          sentiment: 0.6,
          stableKey: `${award.contract.id}_win`,
        });
      }

      for (const loser of eligible.slice(1)) {
        const bid = bids.find((b) => b.id === loser.bidId);
        if (bid === undefined) continue;
        bid.status = 'lost';
        ensureReputation(draft, bid.bidderCompanyId, opportunity.agencyId, ctx.quarter).contractsLost += 1;
        ensureReputation(draft, bid.bidderCompanyId, null, ctx.quarter).contractsLost += 1;

        const gap = round((winning.weightedTotal - loser.weightedTotal) * 100, 1);
        ctx.log({
          phase: 'government_resolution',
          text: line(
            `${companyById(draft, bid.bidderCompanyId)?.name ?? bid.bidderCompanyId} placed ${loser.rank} on ${opportunity.programme}, ${gap} points behind on the weighted score.`,
          ),
          deltaLabel: `#${loser.rank}`,
          refEventIds: [award.eventId],
          tone: 'negative',
          subjectId: bid.bidderCompanyId,
        });

        const loserCeo = ceoOf(draft, bid.bidderCompanyId);
        if (loserCeo !== null) {
          rememberEvent(draft, ctx, {
            ownerCharacterId: loserCeo,
            aboutId: winningBid.bidderCompanyId,
            kind: 'contract_loss',
            summary: `They took ${opportunity.programme} from under us; we were ${gap} points behind.`,
            sentiment: -0.45,
            stableKey: `${award.contract.id}_loss`,
          });
        }
      }
    }
  }

  return {
    openOpportunities,
    scoreBids,
    awardContracts,
    advanceMilestones(draft: SessionState, ctx: ResolverContext): void {
      advanceMilestones(draft, ctx);
    },
    closeExpiredOpportunities,
  };
}

/** The programme catalogue, for the designer log and the Government screen. */
export const PROGRAMME_CATALOGUE = PROGRAMME_TEMPLATES;
