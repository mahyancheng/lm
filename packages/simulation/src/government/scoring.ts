/**
 * @frontier/simulation — government/scoring.ts
 *
 * Bid evaluation: seven axes, the published weights, and an explanation for
 * every number.
 *
 * ```text
 * technical       = Σ(claim_i × credibility_i) / n,  credibility = min(1, real/claimed)
 * security        = f(security claim, ops headcount, cleared staff, incident record)
 * pastPerformance = g(this agency's record first, then the government-wide one)
 * priceRealism    = parabola(price, engine cost estimate, competitor prices)
 * schedule        = h(delivery quarters vs estimate, granularity, resources)
 * domesticSupply  = domesticSourcingPct
 * responsibleAi   = i(audit rights, IP concessions, commitment, safety record)
 * ```
 *
 * Two properties matter more than the exact coefficients:
 *
 * - **Claims are discounted, not rejected.** A bid that over-promises still
 *   scores better than an honest one — and then fails its milestones. That trap
 *   is the subsystem's sharpest edge, and `CLAIM_CREDIBILITY_FLOOR` is what
 *   creates it.
 * - **Cost realism is a parabola, not a slope.** Under `cost_plus` an
 *   implausibly low price scores near zero rather than winning, which is the
 *   only reason price is not a dominant strategy.
 *
 * There is no relationship term. Connections change which opportunities a
 * player can see and what they know about them; they never touch this file.
 */

import type {
  BidScoreBreakdown,
  Company,
  ContractorReputation,
  ProcurementOpportunity,
  SessionState,
  StoredGovernmentBid,
  TechCapabilityArea,
} from '@frontier/contracts';
import { CLEARANCE_STAFF_REQUIREMENT, CLEARANCE_BURDEN, requiredReliability } from './programmes';
import { capabilityOf, clamp, companyById, meanCapability, ratio, round, unit } from './util';

/* -------------------------------------------------------------------------- */
/*  Balancing constants                                                        */
/* -------------------------------------------------------------------------- */

/**
 * The share of a claim that survives even when the bidder cannot back it at
 * all. Above zero on purpose: over-promising must be able to win the award and
 * lose the programme.
 */
export const CLAIM_CREDIBILITY_FLOOR = 0.35;

/** Dollar cost of one accelerator-equivalent for one quarter at index 1.0. */
export const ACCELERATOR_QUARTER_COST_USD = 25_000;

/** Additional cost of holding one cleared person for one quarter, at level_iv. */
export const CLEARED_STAFF_QUARTER_COST_USD = 12_000;

/** Share of a programme's quarterly value that is compute. */
export const PROGRAMME_COMPUTE_SHARE = 0.35;

/** Share of a programme's quarterly value that is people. */
export const PROGRAMME_STAFF_SHARE = 0.4;

/** What a programme intrinsically costs to deliver, as a share of its ceiling. */
export const SCOPE_COST_RATIO = 0.62;

/** Standing compliance cost as a share of contract value, before multipliers. */
export const COMPLIANCE_BASE_RATE = 0.006;

/** Price/cost ratio the evaluators regard as ideal, and the tolerated spread. */
export const PRICE_REALISM_BANDS = {
  fixed_price: { ideal: 1.15, low: 0.5, high: 0.7 },
  cost_plus: { ideal: 1.25, low: 0.35, high: 0.6 },
} as const;

/** Below this realism score a price is not treated as a credible competitor price. */
export const CREDIBLE_PRICE_REALISM = 0.25;

const MODEL_AREAS: readonly TechCapabilityArea[] = ['reasoning', 'agents', 'multimodal'];
const ARCHITECTURE_AREAS: readonly TechCapabilityArea[] = ['infrastructure', 'training_systems', 'efficiency'];
const SECURITY_AREAS: readonly TechCapabilityArea[] = ['security'];
const RELIABILITY_AREAS: readonly TechCapabilityArea[] = ['infrastructure', 'efficiency'];
const RESPONSIBLE_AREAS: readonly TechCapabilityArea[] = ['safety_alignment', 'evaluation'];

const IP_TECHNICAL_SCORE = { none: 0.35, government_use_rights: 0.6, joint_ownership: 0.8, full_transfer: 1 } as const;
const IP_RESPONSIBLE_SCORE = { none: 0.2, government_use_rights: 0.6, joint_ownership: 0.85, full_transfer: 1 } as const;
const AUDIT_SCORE = { none: 0.1, annual: 0.6, continuous: 1 } as const;
const AUDIT_COST_MULTIPLIER = { none: 1, annual: 1.2, continuous: 1.6 } as const;

/* -------------------------------------------------------------------------- */
/*  Teams                                                                      */
/* -------------------------------------------------------------------------- */

export interface BidTeam {
  readonly prime: Company;
  /** Consortium members and subcontractors, with the weight their share earns. */
  readonly partners: readonly { readonly company: Company; readonly weight: number }[];
}

/**
 * The companies actually behind a bid. Consortium members are equals; a
 * subcontractor contributes in proportion to its share, saturating at a quarter
 * of contract value.
 */
export function bidTeam(draft: SessionState, bid: StoredGovernmentBid): BidTeam | null {
  const prime = companyById(draft, bid.bidderCompanyId);
  if (prime === null) return null;
  const partners: { company: Company; weight: number }[] = [];
  for (const memberId of bid.consortiumMemberIds) {
    const member = companyById(draft, memberId);
    if (member !== null && member.id !== prime.id) partners.push({ company: member, weight: 1 });
  }
  for (const sub of bid.subcontractors) {
    const company = companyById(draft, sub.companyId);
    if (company !== null && company.id !== prime.id) partners.push({ company, weight: unit(sub.sharePct / 0.25) });
  }
  return { prime, partners };
}

/**
 * The capability the team can bring to bear in an area.
 *
 * A partner can only ever raise the number: bringing in a specialist who is
 * weaker than you in some other area must not make your bid worse. What a
 * partner costs you is a share of the contract, not a scoring penalty.
 */
export function teamCapability(team: BidTeam, areas: readonly TechCapabilityArea[]): number {
  const prime = meanCapability(team.prime, areas);
  let best = 0;
  for (const partner of team.partners) {
    const value = meanCapability(partner.company, areas) * partner.weight;
    if (value > best) best = value;
  }
  return unit(Math.max(prime, prime * 0.6 + best * 0.4));
}

/** Mean team capability across everything the programme touches. */
export function teamBreadth(team: BidTeam): number {
  return unit(
    (teamCapability(team, MODEL_AREAS) +
      teamCapability(team, ARCHITECTURE_AREAS) +
      teamCapability(team, SECURITY_AREAS) +
      teamCapability(team, RESPONSIBLE_AREAS)) /
      4,
  );
}

/* -------------------------------------------------------------------------- */
/*  Claim discounting                                                          */
/* -------------------------------------------------------------------------- */

/** A claim, discounted by the credibility the bidder's real capability lends it. */
export function creditedClaim(claim: number, real: number): number {
  const c = unit(claim);
  if (c <= 1e-9) return 0;
  const credibility = unit(ratio(real, c, 0));
  return unit(c * (CLAIM_CREDIBILITY_FLOOR + (1 - CLAIM_CREDIBILITY_FLOOR) * credibility));
}

/* -------------------------------------------------------------------------- */
/*  Programme scale                                                            */
/* -------------------------------------------------------------------------- */

export interface ProgrammeScale {
  /** Accelerator-equivalents a competent delivery needs. */
  readonly computeUnits: number;
  /** Technical staff a competent delivery needs. */
  readonly staff: number;
  /** Operations staff a competent delivery needs. */
  readonly ops: number;
  /** Cleared staff the clearance requirement demands. */
  readonly clearedStaff: number;
}

/** What delivering this programme actually takes, before anyone bids on it. */
export function programmeScale(opportunity: ProcurementOpportunity, team: BidTeam | null): ProgrammeScale {
  const perQuarter = ratio(opportunity.maxValue, Math.max(1, opportunity.durationQuarters), 0);
  const avgComp = team === null ? 300_000 : Math.max(60_000, team.prime.employees.avgComp);
  const computeUnits = Math.max(1, Math.round((perQuarter * PROGRAMME_COMPUTE_SHARE) / ACCELERATOR_QUARTER_COST_USD));
  const staff = Math.max(1, Math.round((perQuarter * PROGRAMME_STAFF_SHARE) / (avgComp / 4)));
  return {
    computeUnits,
    staff,
    ops: Math.max(1, Math.round(staff * 0.25)),
    clearedStaff: CLEARANCE_STAFF_REQUIREMENT[opportunity.requirements.clearanceLevel],
  };
}

/* -------------------------------------------------------------------------- */
/*  Cost estimate                                                              */
/* -------------------------------------------------------------------------- */

export interface CostEstimate {
  readonly bottomUpUsd: number;
  readonly scopeUsd: number;
  readonly estimateUsd: number;
  readonly complianceQuarterlyUsd: number;
}

/**
 * What the evaluators think this bid will really cost the bidder to deliver.
 * Half bottom-up from the commitments the bid actually makes, half the scope
 * cost of the programme itself, so neither an absurd commitment nor an empty
 * one can distort the realism test.
 */
export function engineCostEstimate(
  draft: SessionState,
  opportunity: ProcurementOpportunity,
  bid: StoredGovernmentBid,
  team: BidTeam | null,
): CostEstimate {
  const world = draft.world;
  const deliveryQuarters = clamp(bid.timeline.deliveryQuarters, 1, 40);
  const avgComp = team === null ? 300_000 : Math.max(60_000, team.prime.employees.avgComp);

  const computeCost =
    bid.computeCommitment.acceleratorUnits * clamp(bid.computeCommitment.quarters, 1, 40) * ACCELERATOR_QUARTER_COST_USD * world.compute.reservedPrice;
  const staffCost = (bid.staffCommitment.engineers + bid.staffCommitment.researchers) * deliveryQuarters * (avgComp / 4) * world.talent.salaryPressure;
  const clearanceCost =
    bid.staffCommitment.clearedStaff *
    deliveryQuarters *
    CLEARED_STAFF_QUARTER_COST_USD *
    (0.5 + CLEARANCE_BURDEN[opportunity.requirements.clearanceLevel]);
  const complianceQuarterlyUsd =
    opportunity.maxValue *
    COMPLIANCE_BASE_RATE *
    AUDIT_COST_MULTIPLIER[bid.auditRights] *
    (1 + CLEARANCE_BURDEN[opportunity.requirements.clearanceLevel] * 0.5) *
    (opportunity.requirements.dataSovereignty ? 1.25 : 1);

  const efficiency = 1 - 0.3 * (team === null ? 0.3 : teamBreadth(team));
  const domesticPremium = 1 + 0.15 * unit(bid.domesticSourcingPct);
  const rawBottomUp = (computeCost + staffCost + clearanceCost + complianceQuarterlyUsd * opportunity.durationQuarters) * efficiency * domesticPremium;

  const scopeUsd = opportunity.maxValue * SCOPE_COST_RATIO;
  const bottomUpUsd = clamp(rawBottomUp, scopeUsd * 0.3, scopeUsd * 1.6);
  return {
    bottomUpUsd: round(bottomUpUsd, 2),
    scopeUsd: round(scopeUsd, 2),
    estimateUsd: round(0.5 * bottomUpUsd + 0.5 * scopeUsd, 2),
    complianceQuarterlyUsd: round(complianceQuarterlyUsd, 2),
  };
}

/** The cost-realism parabola, before any competitiveness adjustment. */
export function costRealism(priceUsd: number, estimateUsd: number, form: ProcurementOpportunity['contractForm']): number {
  const band = PRICE_REALISM_BANDS[form];
  const r = ratio(priceUsd, Math.max(1, estimateUsd), 0);
  const spread = r < band.ideal ? band.low : band.high;
  const distance = (r - band.ideal) / spread;
  return unit(1 - distance * distance);
}

/* -------------------------------------------------------------------------- */
/*  Past performance                                                           */
/* -------------------------------------------------------------------------- */

function reputationFor(draft: SessionState, companyId: string, agencyId: string | null): ContractorReputation | null {
  return draft.contractorReputations.find((r) => r.companyId === companyId && r.agencyId === agencyId) ?? null;
}

/** A company's record with one agency, blended with its government-wide record. */
export function pastPerformanceScore(draft: SessionState, company: Company, agencyId: string): number {
  const aggregateRecord = reputationFor(draft, company.id, null);
  const aggregate = aggregateRecord?.pastPerformanceScore ?? company.governmentPastPerformance;
  const agencyRecord = reputationFor(draft, company.id, agencyId);
  const base = agencyRecord === null ? aggregate : 0.65 * agencyRecord.pastPerformanceScore + 0.35 * aggregate;

  const record = agencyRecord ?? aggregateRecord;
  let score = base / 100;
  if (record !== null) {
    score += 0.1 * (record.onTimeDeliveryPct - 0.8);
    score -= 0.15 * clamp(record.costOverrunPct, 0, 1);
    score -= 0.2 * record.terminationsForDefault;
    score -= 0.03 * record.securityIncidents;
  }
  return unit(score);
}

/* -------------------------------------------------------------------------- */
/*  Requirement gates                                                          */
/* -------------------------------------------------------------------------- */

/** Every hard requirement this bid fails. An empty array means it is scored. */
export function disqualificationReasons(
  draft: SessionState,
  opportunity: ProcurementOpportunity,
  bid: StoredGovernmentBid,
  team: BidTeam | null,
): string[] {
  const reasons: string[] = [];
  const req = opportunity.requirements;

  if (team === null) {
    reasons.push('The bidding entity is not an active company in this session.');
    return reasons;
  }
  if (!team.prime.isActive) reasons.push(`${team.prime.name} is no longer trading.`);

  if (opportunity.visibility === 'invited' && opportunity.invitedCompanyIds.length > 0 && !opportunity.invitedCompanyIds.includes(team.prime.id)) {
    reasons.push('This competition is by invitation and the bidder was not invited.');
  }
  if (!opportunity.allowsConsortium && bid.consortiumMemberIds.length > 0) {
    reasons.push('The programme does not permit joint bids.');
  }

  const record = pastPerformanceScore(draft, team.prime, opportunity.agencyId) * 100;
  if (record < req.minimumPastPerformance) {
    reasons.push(
      `Past performance ${Math.round(record)} is below the programme floor of ${Math.round(req.minimumPastPerformance)}.`,
    );
  }

  const requiredCleared = CLEARANCE_STAFF_REQUIREMENT[req.clearanceLevel];
  if (bid.staffCommitment.clearedStaff < requiredCleared) {
    reasons.push(
      `${req.clearanceLevel.replace('_', ' ')} clearance demands ${requiredCleared} cleared staff; the bid commits ${bid.staffCommitment.clearedStaff}.`,
    );
  }
  if (req.domesticInference && bid.domesticSourcingPct < 0.8) {
    reasons.push('Domestic inference is mandatory and the bid sources less than 80% domestically.');
  }
  if (req.dataSovereignty && bid.domesticSourcingPct < 0.5) {
    reasons.push('Data sovereignty is mandatory and the bid cannot keep data in jurisdiction.');
  }
  if (req.modelAudit && bid.auditRights === 'none') {
    reasons.push('An independent model audit is mandatory and the bid grants no audit rights.');
  }
  const reliability = requiredReliability(req.uptimePct);
  if (bid.technicalScoreInputs.reliabilityCommitment < reliability) {
    reasons.push(
      `The ${req.uptimePct}% availability target needs a reliability commitment of at least ${round(reliability, 2)}; the bid offers ${round(bid.technicalScoreInputs.reliabilityCommitment, 2)}.`,
    );
  }
  if (bid.price <= 0) reasons.push('A bid must carry a price.');

  return reasons;
}

/* -------------------------------------------------------------------------- */
/*  Scoring                                                                    */
/* -------------------------------------------------------------------------- */

interface ScoredAxes {
  readonly technical: number;
  readonly security: number;
  readonly pastPerformance: number;
  readonly schedule: number;
  readonly domesticSupply: number;
  readonly responsibleAi: number;
  readonly realism: number;
  readonly estimate: CostEstimate;
  readonly notes: string[];
}

function scoreAxesExceptPrice(
  draft: SessionState,
  opportunity: ProcurementOpportunity,
  bid: StoredGovernmentBid,
  team: BidTeam,
): ScoredAxes {
  const notes: string[] = [];
  const claims = bid.technicalScoreInputs;
  const scale = programmeScale(opportunity, team);
  const estimate = engineCostEstimate(draft, opportunity, bid, team);

  const modelReal = teamCapability(team, MODEL_AREAS);
  const archReal = teamCapability(team, ARCHITECTURE_AREAS);
  const securityReal = teamCapability(team, SECURITY_AREAS);
  const reliabilityReal = teamCapability(team, RELIABILITY_AREAS);
  const responsibleReal = teamCapability(team, RESPONSIBLE_AREAS);

  const computeRatio = unit(ratio(bid.computeCommitment.acceleratorUnits, scale.computeUnits, 0));
  const staffRatio = unit(ratio(bid.staffCommitment.engineers + bid.staffCommitment.researchers, scale.staff, 0));
  const capacity = unit(0.5 * computeRatio + 0.5 * staffRatio);

  /* --------------------------------- technical -------------------------- */
  const modelScore = creditedClaim(claims.modelCapability, modelReal);
  const archScore = creditedClaim(claims.architectureQuality, archReal);
  const technical = unit(0.55 * ((modelScore + archScore) / 2) + 0.3 * capacity + 0.15 * IP_TECHNICAL_SCORE[bid.ipConcessions]);
  if (claims.modelCapability > modelReal + 0.15) {
    notes.push(`Model capability claimed at ${round(claims.modelCapability, 2)} against a demonstrated ${round(modelReal, 2)}; the claim was discounted.`);
  }
  if (computeRatio < 0.6) {
    notes.push(`Committed capacity covers ${Math.round(computeRatio * 100)}% of what the programme office estimates it needs.`);
  }

  /* --------------------------------- security --------------------------- */
  const aggregate = draft.contractorReputations.find((r) => r.companyId === team.prime.id && r.agencyId === null);
  const incidents = aggregate?.securityIncidents ?? 0;
  const opsAdequacy = unit(ratio(team.prime.employees.ops, scale.ops, 0));
  const clearanceCoverage = scale.clearedStaff === 0 ? 1 : unit(ratio(bid.staffCommitment.clearedStaff, scale.clearedStaff, 0));
  const incidentPenalty = 1 / (1 + 0.3 * incidents);
  const security = unit(
    (0.35 * creditedClaim(claims.securityPosture, securityReal) +
      0.25 * creditedClaim(claims.reliabilityCommitment, reliabilityReal) +
      0.2 * opsAdequacy +
      0.2 * clearanceCoverage) *
      incidentPenalty,
  );
  if (incidents > 0) notes.push(`${incidents} reportable security incident(s) on previous public work weighed against the security score.`);

  /* ------------------------------ past performance ---------------------- */
  let past = pastPerformanceScore(draft, team.prime, opportunity.agencyId);
  for (const partner of team.partners) {
    if (partner.weight < 0.5) continue;
    const partnerPast = pastPerformanceScore(draft, partner.company, opportunity.agencyId);
    past = Math.max(past, 0.7 * past + 0.3 * partnerPast);
  }
  if (team.partners.length > 0) notes.push('Consortium partners were blended into the technical and past-performance assessment.');

  /* --------------------------------- schedule --------------------------- */
  const resourceFactor = clamp(0.6 + 0.5 * computeRatio + 0.4 * staffRatio, 0.5, 1.6);
  const baselineQuarters = Math.max(1, opportunity.durationQuarters * 0.6 * (1 - 0.25 * teamBreadth(team)));
  const estimateQuarters = Math.max(1, baselineQuarters / resourceFactor);
  const speed = ratio(bid.timeline.deliveryQuarters, estimateQuarters, 0);
  const credibility = speed >= 1 ? 1 : unit(Math.pow(Math.max(speed, 0), 1.5));
  const patience =
    bid.timeline.deliveryQuarters <= opportunity.durationQuarters
      ? 1
      : unit(1 - (bid.timeline.deliveryQuarters - opportunity.durationQuarters) / Math.max(1, opportunity.durationQuarters));
  const idealMilestones = clamp(Math.round(opportunity.durationQuarters / 4), 1, 20);
  const granularity = unit(1 - Math.abs(bid.timeline.milestoneCount - idealMilestones) / Math.max(idealMilestones, bid.timeline.milestoneCount));
  const schedule = unit(0.5 * credibility + 0.2 * patience + 0.15 * capacity + 0.15 * granularity);
  if (speed < 0.8) {
    notes.push(`A ${bid.timeline.deliveryQuarters}-quarter delivery against an estimated ${Math.round(estimateQuarters)} quarters was not judged credible.`);
  }

  /* ------------------------------ domestic supply ----------------------- */
  const domesticSupply = unit(bid.domesticSourcingPct);

  /* ------------------------------ responsible AI ------------------------ */
  const safetyRecord = unit(0.6 * (team.prime.reputation.government / 100) + 0.4 * (1 - unit(0.2 * incidents)));
  const responsibleAi = unit(
    0.28 * AUDIT_SCORE[bid.auditRights] +
      0.17 * IP_RESPONSIBLE_SCORE[bid.ipConcessions] +
      0.35 * creditedClaim(claims.responsibleAiCommitment, responsibleReal) +
      0.2 * safetyRecord,
  );

  const realism = costRealism(bid.price, estimate.estimateUsd, opportunity.contractForm);
  if (opportunity.contractForm === 'cost_plus' && bid.price < estimate.estimateUsd * 0.8) {
    notes.push(
      `Cost realism: the proposed cost is ${Math.round((1 - ratio(bid.price, estimate.estimateUsd, 1)) * 100)}% below the government estimate and was not found credible.`,
    );
  }

  return { technical, security, pastPerformance: past, schedule, domesticSupply, responsibleAi, realism, estimate, notes };
}

/**
 * Score every bid on one opportunity and rank them.
 *
 * Pure with respect to the draft — it reads state and returns breakdowns — and
 * free of randomness, so `scoreBids` and `awardContracts` can each call it and
 * agree exactly.
 */
export function scoreOpportunityBids(
  draft: SessionState,
  opportunity: ProcurementOpportunity,
  bids: readonly StoredGovernmentBid[],
): BidScoreBreakdown[] {
  const weights = opportunity.evaluationWeights;

  interface Working {
    readonly bid: StoredGovernmentBid;
    readonly team: BidTeam | null;
    readonly reasons: string[];
    readonly axes: ScoredAxes | null;
  }

  const working: Working[] = bids.map((bid) => {
    const team = bidTeam(draft, bid);
    const reasons = disqualificationReasons(draft, opportunity, bid, team);
    const axes = reasons.length === 0 && team !== null ? scoreAxesExceptPrice(draft, opportunity, bid, team) : null;
    return { bid, team, reasons, axes };
  });

  // Competitiveness is relative, so it needs every credible price first.
  const crediblePrices = working
    .filter((w) => w.axes !== null && w.axes.realism >= CREDIBLE_PRICE_REALISM)
    .map((w) => w.bid.price);
  const bestCredible = crediblePrices.length === 0 ? null : Math.min(...crediblePrices);

  const scored: BidScoreBreakdown[] = [];
  const rejected: BidScoreBreakdown[] = [];

  for (const entry of working) {
    if (entry.axes === null) {
      rejected.push({
        bidId: entry.bid.id,
        companyId: entry.bid.bidderCompanyId,
        technical: 0,
        security: 0,
        pastPerformance: 0,
        priceRealism: 0,
        schedule: 0,
        domesticSupply: 0,
        responsibleAi: 0,
        weightedTotal: 0,
        rank: 1,
        disqualified: true,
        notes: entry.reasons,
      });
      continue;
    }

    const competitiveness =
      bestCredible === null ? 0.6 : unit(1 - ratio(entry.bid.price - bestCredible, Math.max(bestCredible, 1), 0));
    const priceRealism =
      opportunity.contractForm === 'cost_plus'
        ? unit(0.75 * entry.axes.realism + 0.25 * competitiveness)
        : unit(0.5 * entry.axes.realism + 0.5 * competitiveness);

    const axes = entry.axes;
    const weightedTotal = unit(
      axes.technical * weights.technical +
        axes.security * weights.security +
        axes.pastPerformance * weights.pastPerformance +
        priceRealism * weights.priceRealism +
        axes.schedule * weights.schedule +
        axes.domesticSupply * weights.domesticSupply +
        axes.responsibleAi * weights.responsibleAi,
    );

    scored.push({
      bidId: entry.bid.id,
      companyId: entry.bid.bidderCompanyId,
      technical: round(axes.technical, 4),
      security: round(axes.security, 4),
      pastPerformance: round(axes.pastPerformance, 4),
      priceRealism: round(priceRealism, 4),
      schedule: round(axes.schedule, 4),
      domesticSupply: round(axes.domesticSupply, 4),
      responsibleAi: round(axes.responsibleAi, 4),
      weightedTotal: round(weightedTotal, 6),
      rank: 1,
      disqualified: false,
      notes: [
        `Government cost estimate ${Math.round(axes.estimate.estimateUsd).toLocaleString('en-US')}; price/estimate ${round(ratio(entry.bid.price, axes.estimate.estimateUsd, 0), 2)}.`,
        ...axes.notes,
      ],
    });
  }

  // Deterministic ranking: weighted total, then the record, then submission
  // order, then id. Never a coin toss.
  const byRank = [...scored].sort((a, b) => {
    if (b.weightedTotal !== a.weightedTotal) return b.weightedTotal - a.weightedTotal;
    if (b.pastPerformance !== a.pastPerformance) return b.pastPerformance - a.pastPerformance;
    const bidA = bids.find((x) => x.id === a.bidId);
    const bidB = bids.find((x) => x.id === b.bidId);
    const qa = bidA?.submittedQuarter ?? 0;
    const qb = bidB?.submittedQuarter ?? 0;
    if (qa !== qb) return qa - qb;
    return a.bidId.localeCompare(b.bidId);
  });

  const ranked = byRank.map((entry, index) => ({ ...entry, rank: index + 1 }));
  const disqualified = rejected.map((entry) => ({ ...entry, rank: ranked.length + 1 }));
  return [...ranked, ...disqualified];
}
