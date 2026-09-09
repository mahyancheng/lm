/**
 * @frontier/contracts — government.ts
 *
 * Public procurement as a complete strategic subsystem, not "government customer,
 * plus one hundred million dollars of revenue".
 *
 * An opportunity states its evaluation weights and its hard requirements up
 * front. A bid is a set of genuine trade-offs: price against margin, compute
 * commitment against flexibility, IP concessions against future leverage.
 * Winning is not automatically good — a large award brings backlog, credibility
 * and stable demand, and also compliance cost, capacity lock-in, employee
 * unease, public criticism, export restrictions and cost-overrun risk.
 *
 * Contract performance persists as `governmentPastPerformance` on the company,
 * and past performance is itself an evaluation weight. A failed programme is
 * therefore not one bad quarter; it is a multi-quarter reputational tax.
 *
 * Connections may help a company *discover* opportunities, obtain introductions,
 * understand policy priorities and join consortia. Connections never buy an
 * award: there is no hidden bribery statistic that decides who wins.
 */

import { z } from 'zod';
import { QuarterIndexSchema, intCount, score100, unitInterval, usd } from './ids';

/* -------------------------------------------------------------------------- */
/*  Agencies                                                                   */
/* -------------------------------------------------------------------------- */

export const AGENCY_JURISDICTIONS = ['federal_civil', 'defence', 'intelligence', 'state_regional', 'supranational', 'allied_foreign'] as const;

export const AgencyJurisdictionSchema = z.enum(AGENCY_JURISDICTIONS).describe('Which part of government the agency belongs to. Defence and intelligence carry clearance requirements and heavier public scrutiny.');
export type AgencyJurisdiction = z.infer<typeof AgencyJurisdictionSchema>;

export const AGENCY_PRIORITIES = [
  'national_security',
  'cost_efficiency',
  'domestic_industry',
  'responsible_ai',
  'speed_of_delivery',
  'vendor_diversity',
  'data_sovereignty',
  'workforce_modernisation',
] as const;

export const AgencyPrioritySchema = z.enum(AGENCY_PRIORITIES).describe('A standing policy priority. Understanding an agency\'s priorities is exactly what a well-connected founder gets from a meeting.');
export type AgencyPriority = z.infer<typeof AgencyPrioritySchema>;

export const AgencySchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1).max(120).describe('Agency name, e.g. "United Federation Department of Defence".'),
    shortName: z.string().min(1).max(24).describe('Abbreviation used in tables.'),
    jurisdiction: AgencyJurisdictionSchema,
    mission: z.string().max(400).describe('What the agency exists to do.'),
    budgetQuarterlyUsd: usd('Procurement budget available per quarter. Scales with world.government.procurementBudget.'),
    priorities: z.array(AgencyPrioritySchema).describe('Standing priorities, ordered by importance.'),
    contactCharacterIds: z.array(z.string()).describe('Officials a player can meet. Access is governed by the connection rules in people.ts.'),
    clearanceAuthority: z.boolean().describe('Whether this agency can sponsor security clearances for a contractor\'s staff.'),
  })
  .describe('A government buyer.');
export type Agency = z.infer<typeof AgencySchema>;

/* -------------------------------------------------------------------------- */
/*  Opportunities                                                              */
/* -------------------------------------------------------------------------- */

export const CONTRACT_FORMS = ['fixed_price', 'cost_plus'] as const;

export const ContractFormSchema = z
  .enum(CONTRACT_FORMS)
  .describe(
    'How the contract pays. "fixed_price" transfers overrun risk to the contractor and rewards efficiency; "cost_plus" reimburses cost with an incentive fee, caps the upside, and brings a cost-realism examination of the bid.',
  );
export type ContractForm = z.infer<typeof ContractFormSchema>;

export const CLEARANCE_LEVELS = ['none', 'level_i', 'level_ii', 'level_iii', 'level_iv'] as const;

export const ClearanceLevelSchema = z
  .enum(CLEARANCE_LEVELS)
  .describe('Personnel security clearance required. Higher levels take quarters to obtain and constrain who a company can hire onto the programme.');
export type ClearanceLevel = z.infer<typeof ClearanceLevelSchema>;

export const EvaluationWeightsSchema = z
  .object({
    technical: unitInterval('Weight on technical capability: model quality, architecture, evidence of delivery at scale.'),
    security: unitInterval('Weight on security and reliability posture.'),
    pastPerformance: unitInterval('Weight on the bidder\'s record on previous public contracts. This is where a failed programme keeps costing.'),
    priceRealism: unitInterval('Weight on price and, for cost-plus competitions, whether the proposed cost is realistic. Bidding implausibly low scores badly rather than winning.'),
    schedule: unitInterval('Weight on delivery timeline credibility.'),
    domesticSupply: unitInterval('Weight on domestic supply chain content.'),
    responsibleAi: unitInterval('Weight on responsible AI compliance: evaluation, audit, incident response.'),
  })
  .describe('Evaluation weights. INVARIANT: the seven weights sum to 1.0 within 1e-6. The engine scores each bid on each axis, multiplies by these weights and ranks.')
  .refine(
    (w) => Math.abs(w.technical + w.security + w.pastPerformance + w.priceRealism + w.schedule + w.domesticSupply + w.responsibleAi - 1) <= 1e-6,
    { message: 'evaluationWeights must sum to 1.0 (tolerance 1e-6)' },
  );
export type EvaluationWeights = z.infer<typeof EvaluationWeightsSchema>;

/** A representative weighting, matching the worked example in the design brief. */
export const DEFAULT_EVALUATION_WEIGHTS: EvaluationWeights = {
  technical: 0.3,
  security: 0.2,
  pastPerformance: 0.15,
  priceRealism: 0.15,
  schedule: 0.1,
  domesticSupply: 0.05,
  responsibleAi: 0.05,
};

export const OpportunityRequirementsSchema = z
  .object({
    clearanceLevel: ClearanceLevelSchema,
    domesticInference: z.boolean().describe('Whether all inference must run on domestic infrastructure.'),
    modelAudit: z.boolean().describe('Whether an independent model audit is mandatory.'),
    uptimePct: z.number().min(90).max(100).describe('Contractual availability target as a percentage, e.g. 99.99.'),
    dataSovereignty: z.boolean().describe('Whether all data must remain within the jurisdiction.'),
    minimumPastPerformance: score100('Minimum past-performance score to be eligible at all. New entrants are locked out of the largest programmes until they build a record on smaller ones.'),
  })
  .describe('Hard gates. A bid that fails any requirement is not scored — it is disqualified.');
export type OpportunityRequirements = z.infer<typeof OpportunityRequirementsSchema>;

export const ProcurementOpportunitySchema = z
  .object({
    id: z.string().min(1),
    agencyId: z.string().min(1),
    programme: z.string().min(3).max(140).describe('Programme name, e.g. "Sovereign Intelligence Platform".'),
    description: z.string().max(1200).describe('What the agency is buying and why now.'),
    maxValue: usd('Ceiling value of the award across its full term.'),
    contractForm: ContractFormSchema,
    durationQuarters: z.number().int().min(1).max(40).describe('Term of the resulting contract.'),
    evaluationWeights: EvaluationWeightsSchema,
    requirements: OpportunityRequirementsSchema,
    openQuarter: QuarterIndexSchema.describe('Quarter the opportunity becomes visible and biddable.'),
    closeQuarter: QuarterIndexSchema.describe('Quarter after which bids are no longer accepted. Awards resolve in the government phase of that quarter.'),
    visibility: z.enum(['public', 'invited', 'classified']).describe('"public" appears on the Government screen for everyone; "invited" only reaches companies with sufficient standing or an introduction; "classified" requires clearance to see at all.'),
    invitedCompanyIds: z.array(z.string()).describe('Companies explicitly invited. Empty for public opportunities.'),
    allowsConsortium: z.boolean().describe('Whether several companies may bid jointly, which is how a specialist gets into a programme it cannot deliver alone.'),
    status: z.enum(['open', 'evaluating', 'awarded', 'cancelled']),
  })
  .describe('An open government opportunity.');
export type ProcurementOpportunity = z.infer<typeof ProcurementOpportunitySchema>;

/* -------------------------------------------------------------------------- */
/*  Bids                                                                       */
/* -------------------------------------------------------------------------- */

export const IP_CONCESSIONS = ['none', 'government_use_rights', 'joint_ownership', 'full_transfer'] as const;
export const IpConcessionSchema = z
  .enum(IP_CONCESSIONS)
  .describe('How much intellectual property the bidder gives up. Greater concessions raise the technical and responsible-AI scores and permanently reduce the commercial value of the work elsewhere.');
export type IpConcession = z.infer<typeof IpConcessionSchema>;

export const AUDIT_RIGHTS = ['none', 'annual', 'continuous'] as const;
export const AuditRightsSchema = z.enum(AUDIT_RIGHTS).describe('Depth of audit access granted to the agency. Continuous access scores well and adds a standing compliance cost.');
export type AuditRights = z.infer<typeof AuditRightsSchema>;

export const TechnicalScoreInputsSchema = z
  .object({
    modelCapability: unitInterval('Capability of the model being offered, relative to the frontier.'),
    architectureQuality: unitInterval('Quality of the proposed system architecture.'),
    securityPosture: unitInterval('Strength of the security commitments, including personnel and supply chain.'),
    reliabilityCommitment: unitInterval('Credibility of the availability commitment, checked against the bidder\'s operating record.'),
    responsibleAiCommitment: unitInterval('Depth of evaluation, red-teaming and incident-response commitments.'),
  })
  .describe('The technical claims a bid makes. The engine discounts each claim by the bidder\'s actual capabilities: promising what you cannot deliver scores well now and destroys past performance later.');
export type TechnicalScoreInputs = z.infer<typeof TechnicalScoreInputsSchema>;

export const SubcontractorSchema = z
  .object({
    companyId: z.string().min(1),
    sharePct: unitInterval('Fraction of the contract value flowing to this subcontractor.'),
    role: z.string().max(120).describe('What they provide, e.g. "domestic inference capacity".'),
  })
  .describe('One subcontractor on a bid.');
export type Subcontractor = z.infer<typeof SubcontractorSchema>;

/**
 * A government bid. LLM-safe: no optional fields, no records, no transforms, so
 * an NPC strategist can produce one inside an action bundle.
 */
export const GovernmentBidSchema = z
  .object({
    opportunityId: z.string().min(1),
    price: usd('Total proposed price across the contract term. Under cost_plus this is the proposed cost plus fee and is examined for realism.'),
    technicalScoreInputs: TechnicalScoreInputsSchema,
    computeCommitment: z
      .object({
        acceleratorUnits: intCount('Accelerator-equivalents dedicated to the programme.'),
        quarters: z.number().int().min(1).max(40).describe('How long that capacity is locked to this programme and unavailable for commercial work.'),
      })
      .describe('Capacity committed. Locked capacity is the hidden cost of a large award during a compute shortage.'),
    staffCommitment: z
      .object({
        engineers: intCount('Engineers assigned.'),
        researchers: intCount('Researchers assigned.'),
        clearedStaff: intCount('Staff who already hold, or will obtain, the required clearance.'),
      })
      .describe('People committed. Cleared staff are scarce and slow to create.'),
    timeline: z
      .object({
        deliveryQuarters: z.number().int().min(1).max(40).describe('Quarters to first full delivery.'),
        milestoneCount: z.number().int().min(1).max(20).describe('How many milestones the programme is split into. More milestones mean earlier revenue recognition and more chances to miss.'),
      })
      .describe('Proposed schedule.'),
    subcontractors: z.array(SubcontractorSchema).max(8).describe('Subcontractors and their share. Empty when bidding alone.'),
    ipConcessions: IpConcessionSchema,
    auditRights: AuditRightsSchema,
    domesticSourcingPct: unitInterval('Fraction of the delivery sourced domestically.'),
    consortiumMemberIds: z.array(z.string()).max(6).describe('Other companies bidding jointly as equals. Empty when bidding as sole prime.'),
    narrative: z.string().max(800).describe('The pitch, in the agency\'s language. Colour only: the score comes from the numbers.'),
  })
  .describe('A submitted bid. Every field is a real trade-off with a cost elsewhere in the company.');
export type GovernmentBid = z.infer<typeof GovernmentBidSchema>;

/** A bid as stored by the engine, with identity and outcome attached. */
export const StoredGovernmentBidSchema = GovernmentBidSchema.extend({
  id: z.string().min(1),
  bidderCompanyId: z.string().min(1),
  submittedQuarter: QuarterIndexSchema,
  status: z.enum(['submitted', 'disqualified', 'shortlisted', 'won', 'lost', 'withdrawn']),
  disqualificationReason: z.string().nullable(),
}).describe('A bid in the session state.');
export type StoredGovernmentBid = z.infer<typeof StoredGovernmentBidSchema>;

export const BidScoreBreakdownSchema = z
  .object({
    bidId: z.string().min(1),
    companyId: z.string().min(1),
    technical: unitInterval('Score on the technical axis, after discounting claims by real capability.'),
    security: unitInterval('Score on security and reliability.'),
    pastPerformance: unitInterval('Score derived from governmentPastPerformance and agency-specific history.'),
    priceRealism: unitInterval('Score on price and cost realism. Both an implausibly low and an uncompetitively high price score badly.'),
    schedule: unitInterval('Score on schedule credibility.'),
    domesticSupply: unitInterval('Score on domestic content.'),
    responsibleAi: unitInterval('Score on responsible AI commitments.'),
    weightedTotal: unitInterval('Sum of each axis multiplied by its evaluation weight. The highest weighted total wins.'),
    rank: z.number().int().min(1).describe('Final ranking among scored bids.'),
    disqualified: z.boolean(),
    notes: z.array(z.string()).describe('Human-readable evaluation notes, shown to the bidder after award.'),
  })
  .describe('Why a bid won or lost, axis by axis. Shown to the player so procurement never feels like a dice roll.');
export type BidScoreBreakdown = z.infer<typeof BidScoreBreakdownSchema>;

/* -------------------------------------------------------------------------- */
/*  Contracts                                                                  */
/* -------------------------------------------------------------------------- */

export const MILESTONE_STATUSES = ['pending', 'in_progress', 'delivered', 'late', 'failed', 'waived'] as const;
export const MilestoneStatusSchema = z.enum(MILESTONE_STATUSES).describe('State of one contract milestone.');
export type MilestoneStatus = z.infer<typeof MilestoneStatusSchema>;

export const ContractMilestoneSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(3).max(140).describe('What must be delivered.'),
    dueQuarter: QuarterIndexSchema,
    valueUsd: usd('Payment released on acceptance.'),
    status: MilestoneStatusSchema,
    completedQuarter: QuarterIndexSchema.nullable(),
    qualityScore: unitInterval('How well it was delivered. Below 0.5 the agency accepts with reservations, which still damages past performance.'),
    computeRequiredUnits: intCount('Capacity that must be available in the delivery quarter.'),
  })
  .describe('One milestone. Revenue recognition, penalties and past-performance movement all hang off milestones rather than off the contract as a whole.');
export type ContractMilestone = z.infer<typeof ContractMilestoneSchema>;

export const GovernmentContractSchema = z
  .object({
    id: z.string().min(1),
    opportunityId: z.string().min(1),
    agencyId: z.string().min(1),
    primeCompanyId: z.string().min(1).describe('The prime contractor, accountable for the whole programme.'),
    consortiumMemberIds: z.array(z.string()).describe('Joint bidders sharing the award.'),
    subcontractors: z.array(SubcontractorSchema),
    awardedQuarter: QuarterIndexSchema,
    contractForm: ContractFormSchema,
    totalValueUsd: usd('Awarded ceiling value.'),
    recognisedToDateUsd: usd('Revenue recognised so far.'),
    milestones: z.array(ContractMilestoneSchema),
    performanceToDate: score100('Running performance score for this contract, which feeds the company\'s governmentPastPerformance.'),
    penaltiesUsd: usd('Penalties incurred for late or failed delivery.'),
    complianceBurdenQuarterlyUsd: usd('Standing compliance cost while the contract is live: audit, clearance maintenance, reporting, segregated infrastructure.'),
    status: z.enum(['active', 'completed', 'terminated', 'suspended']).describe('Termination for default is the worst outcome available in this subsystem and follows the company for the rest of the session.'),
    exportRestricted: z.boolean().describe('True when the work restricts what the company may sell abroad, which can conflict directly with commercial customers.'),
    publicControversyLevel: unitInterval('How contested the contract is publicly. Drives employee morale effects and media attention.'),
  })
  .describe('An awarded contract in flight.');
export type GovernmentContract = z.infer<typeof GovernmentContractSchema>;

export const ContractorReputationSchema = z
  .object({
    companyId: z.string().min(1),
    agencyId: z.string().nullable().describe('Agency-specific record, or null for the government-wide aggregate.'),
    pastPerformanceScore: score100('The formal score used as an evaluation input on every future bid.'),
    onTimeDeliveryPct: unitInterval('Fraction of milestones delivered on or before their due quarter.'),
    costOverrunPct: z.number().min(-1).max(5).describe('Average overrun against proposed cost. Negative means delivered under budget. Range: -1..5.'),
    securityIncidents: intCount('Reportable security incidents on public work.'),
    contractsWon: intCount('Awards won.'),
    contractsLost: intCount('Competitions lost.'),
    terminationsForDefault: intCount('Contracts terminated for default. Each is close to disqualifying for the largest programmes.'),
    lastUpdatedQuarter: QuarterIndexSchema,
  })
  .describe('A company\'s procurement record. Persistent, slow to build and quick to damage.');
export type ContractorReputation = z.infer<typeof ContractorReputationSchema>;
