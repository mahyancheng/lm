/**
 * The bid, as the player is composing it, in the shape the engine scores.
 *
 * Everything the Government screen shows about a draft bid — the requirement
 * checklist, the cost estimate, the realism score — comes from the engine's own
 * functions applied to a synthetic `StoredGovernmentBid`. Nothing here
 * reimplements a scoring rule, so the checklist a player reads while composing
 * is the checklist the evaluators will apply.
 */

import type {
  AuditRights,
  GovernmentBid,
  IpConcession,
  ProcurementOpportunity,
  StoredGovernmentBid,
} from '@frontier/contracts';
import { CLEARANCE_STAFF_REQUIREMENT, requiredReliability } from '@frontier/simulation';

export interface BidDraft {
  readonly price: string;
  readonly acceleratorUnits: string;
  readonly computeQuarters: number;
  readonly engineers: string;
  readonly researchers: string;
  readonly clearedStaff: string;
  readonly deliveryQuarters: number;
  readonly milestoneCount: number;
  readonly ipConcessions: IpConcession;
  readonly auditRights: AuditRights;
  readonly domesticSourcingPct: number;
  readonly consortiumMemberIds: readonly string[];
  readonly subcontractors: readonly { readonly companyId: string; readonly sharePct: number; readonly role: string }[];
  readonly modelCapability: number;
  readonly architectureQuality: number;
  readonly securityPosture: number;
  readonly reliabilityCommitment: number;
  readonly responsibleAiCommitment: number;
  readonly narrative: string;
}

const num = (value: string, fallback = 0): number => {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};

/** A sensible opening bid for one opportunity: the shape, not the answer. */
export function initialDraft(opportunity: ProcurementOpportunity): BidDraft {
  return {
    price: String(Math.round(opportunity.maxValue * 0.62)),
    acceleratorUnits: '0',
    computeQuarters: Math.min(8, opportunity.durationQuarters),
    engineers: '0',
    researchers: '0',
    clearedStaff: String(CLEARANCE_STAFF_REQUIREMENT[opportunity.requirements.clearanceLevel]),
    deliveryQuarters: Math.max(1, Math.min(40, Math.round(opportunity.durationQuarters / 2))),
    milestoneCount: 4,
    ipConcessions: 'government_use_rights',
    auditRights: opportunity.requirements.modelAudit ? 'annual' : 'none',
    domesticSourcingPct: opportunity.requirements.domesticInference ? 0.85 : 0.4,
    consortiumMemberIds: [],
    subcontractors: [],
    modelCapability: 0.5,
    architectureQuality: 0.5,
    securityPosture: 0.5,
    reliabilityCommitment: Math.min(1, requiredReliability(opportunity.requirements.uptimePct)),
    responsibleAiCommitment: 0.5,
    narrative: '',
  };
}

/** The typed bid an intent carries. */
export function toBid(opportunity: ProcurementOpportunity, draft: BidDraft): GovernmentBid {
  return {
    opportunityId: opportunity.id,
    price: num(draft.price),
    technicalScoreInputs: {
      modelCapability: draft.modelCapability,
      architectureQuality: draft.architectureQuality,
      securityPosture: draft.securityPosture,
      reliabilityCommitment: draft.reliabilityCommitment,
      responsibleAiCommitment: draft.responsibleAiCommitment,
    },
    computeCommitment: {
      acceleratorUnits: Math.round(num(draft.acceleratorUnits)),
      quarters: draft.computeQuarters,
    },
    staffCommitment: {
      engineers: Math.round(num(draft.engineers)),
      researchers: Math.round(num(draft.researchers)),
      clearedStaff: Math.round(num(draft.clearedStaff)),
    },
    timeline: {
      deliveryQuarters: draft.deliveryQuarters,
      milestoneCount: draft.milestoneCount,
    },
    subcontractors: draft.subcontractors.map((entry) => ({ ...entry })),
    ipConcessions: draft.ipConcessions,
    auditRights: draft.auditRights,
    domesticSourcingPct: draft.domesticSourcingPct,
    consortiumMemberIds: [...draft.consortiumMemberIds],
    narrative: draft.narrative.slice(0, 800),
  };
}

/**
 * The same bid wrapped as the engine stores it, so the scoring helpers can be
 * called on a draft that has not been submitted. Never written to state.
 */
export function toStoredBid(
  opportunity: ProcurementOpportunity,
  draft: BidDraft,
  companyId: string,
  quarter: number,
): StoredGovernmentBid {
  return {
    ...toBid(opportunity, draft),
    id: `bid_preview_${opportunity.id}`,
    bidderCompanyId: companyId,
    submittedQuarter: quarter,
    status: 'submitted',
    disqualificationReason: null,
  };
}

export const IP_CONCESSION_LABEL: Readonly<Record<IpConcession, string>> = {
  none: 'None — keep everything',
  government_use_rights: 'Government use rights',
  joint_ownership: 'Joint ownership',
  full_transfer: 'Full transfer',
};

export const AUDIT_RIGHTS_LABEL: Readonly<Record<AuditRights, string>> = {
  none: 'None',
  annual: 'Annual',
  continuous: 'Continuous — scores well, costs standing compliance',
};

export const EVALUATION_AXIS_LABEL = {
  technical: 'Technical capability',
  security: 'Security and reliability',
  pastPerformance: 'Past performance',
  priceRealism: 'Price and cost realism',
  schedule: 'Schedule credibility',
  domesticSupply: 'Domestic supply chain',
  responsibleAi: 'Responsible AI',
} as const;
