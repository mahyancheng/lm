/**
 * @frontier/contracts — governance.ts
 *
 * Boards, directors, proposals, votes and machine-readable conditional
 * commitments.
 *
 * Being CEO and owning the company are separate states. A board can dismiss the
 * player as chief executive; the campaign continues with the player as a 24%
 * shareholder running a proxy campaign. That single separation produces richer
 * corporate stories than treating the company as an extension of the player.
 *
 * Dialogue never writes support scores. A conversation with a director produces
 * a `ConditionalCommitment` — a structured, expiring, condition-bearing promise
 * the engine can check against the actual proposal. Negotiation matters because
 * a character has committed to something a machine can verify.
 */

import { z } from 'zod';
import { QuarterIndexSchema, score100, signedScore100, unitInterval, usd } from './ids';

/* -------------------------------------------------------------------------- */
/*  Directors                                                                  */
/* -------------------------------------------------------------------------- */

export const BOARD_SEATS = ['founder', 'investor', 'independent'] as const;

export const BoardSeatSchema = z
  .enum(BOARD_SEATS)
  .describe('Which constituency the seat represents. founder seats follow the founding team, investor seats are attached to financing rounds, independent seats are recruited for expertise and legitimacy.');
export type BoardSeat = z.infer<typeof BoardSeatSchema>;

export const DIRECTOR_MANDATES = [
  'founder_vision',
  'investor_return',
  'independent_oversight',
  'employee_voice',
  'public_interest',
  'strategic_partner',
  'government_liaison',
] as const;

export const DirectorMandateSchema = z
  .enum(DIRECTOR_MANDATES)
  .describe('The constituency a director believes they serve. It predicts how they weigh a proposal when their personal traits are ambiguous.');
export type DirectorMandate = z.infer<typeof DirectorMandateSchema>;

export const DirectorSchema = z
  .object({
    characterId: z.string().min(1).describe('The person occupying the seat. Directors are characters and can be talked to, lobbied, poached and offended.'),
    seat: BoardSeatSchema,
    independence: score100('How willing this director is to vote against the chief executive. Low independence means the seat follows management; high independence means it does not.'),
    riskTolerance: score100('Appetite for variance. Low-tolerance directors block leveraged expansion and large capital commitments.'),
    growthPreference: score100('Preference for growth over profitability. High values support spending ahead of revenue.'),
    financialDiscipline: score100('Attention to burn, dilution and balance-sheet quality. High values oppose dilutive rounds and expensive acquisitions.'),
    techKnowledge: score100('Ability to evaluate a technical claim. Low-knowledge directors rely on reputation and consensus instead.'),
    safetyOrientation: score100('Weight given to safety, audit and regulatory exposure. High values scrutinise model releases and defence work.'),
    relationshipWithCeo: signedScore100('How this director feels about the current chief executive. Moves with delivered promises and broken ones.'),
    mandate: DirectorMandateSchema,
    votingWeight: z.number().min(0).max(5).describe('Votes this seat carries. Normally 1; a chair may hold a casting vote of 1.5 in some governance rule sets.'),
    isChair: z.boolean().describe('True for the board chair, who sets the agenda and breaks ties.'),
    appointedQuarter: QuarterIndexSchema,
    representedHolderId: z.string().nullable().describe('The shareholder whose stake created this seat, or null for independents.'),
    committees: z.array(z.enum(['audit', 'risk', 'compensation', 'nominating', 'safety'])).describe('Committees this director sits on. Risk committee members open investigations after contract failures.'),
  })
  .describe('One board member. Directors are not a difficulty slider: they are people with mandates who remember how they were treated.');
export type Director = z.infer<typeof DirectorSchema>;

/* -------------------------------------------------------------------------- */
/*  Boards                                                                     */
/* -------------------------------------------------------------------------- */

export const QuorumRuleSchema = z
  .object({
    minPresentFraction: unitInterval('Fraction of directors that must be present for the meeting to act. The fictional default is a simple majority, 0.5.'),
    passThresholdFraction: unitInterval('Fraction of present votes needed to carry an ordinary matter. Default 0.5.'),
    supermajorityKinds: z.array(z.string()).describe('Proposal kinds that need a supermajority. Typically ceo_dismissal, acquisition and ipo.'),
    supermajorityThresholdFraction: unitInterval('Fraction of present votes needed for a supermajority matter. Default 0.667.'),
    chairBreaksTies: z.boolean().describe('Whether the chair carries a casting vote on a tie.'),
  })
  .describe('The governance rule set for one board. Inspired by default corporate law, simplified into a fictional rule set the game can explain in one screen.');
export type QuorumRule = z.infer<typeof QuorumRuleSchema>;

/** Sensible default governance for a startup board. */
export const DEFAULT_QUORUM_RULE: QuorumRule = {
  minPresentFraction: 0.5,
  passThresholdFraction: 0.5,
  supermajorityKinds: ['ceo_dismissal', 'acquisition', 'ipo', 'restructuring'],
  supermajorityThresholdFraction: 0.667,
  chairBreaksTies: true,
};

export const BoardSchema = z
  .object({
    id: z.string().min(1).describe('Board id.'),
    companyId: z.string().min(1),
    directors: z.array(DirectorSchema).describe('Seated directors. A five-member startup board is typically founder, lead investor, second investor and two independents; a mature public board runs to nine or eleven with several factions.'),
    quorumRule: QuorumRuleSchema,
    chairCharacterId: z.string().nullable().describe('Chair, or null when the seat is vacant.'),
    nextMeetingQuarter: QuarterIndexSchema.describe('Quarter the next scheduled meeting resolves.'),
    seatsAuthorised: z.number().int().min(1).max(15).describe('Total seats the charter permits, filled or vacant.'),
  })
  .describe('A company board.');
export type Board = z.infer<typeof BoardSchema>;

/* -------------------------------------------------------------------------- */
/*  Proposals                                                                  */
/* -------------------------------------------------------------------------- */

export const BOARD_PROPOSAL_KINDS = [
  'annual_plan',
  'financing',
  'acquisition',
  'divestiture',
  'ceo_comp',
  'csuite_appointment',
  'buyback',
  'ipo',
  'gov_contract',
  'model_release',
  'restructuring',
  'ceo_dismissal',
  // Appended: a payout is a capital-allocation decision of exactly the kind a
  // board exists to weigh, and appending to this array is safe.
  'dividend',
] as const;

export const BoardProposalKindSchema = z
  .enum(BOARD_PROPOSAL_KINDS)
  .describe(
    'Matters that require board approval. annual_plan sets the operating budget envelope; financing authorises dilution or debt; acquisition and divestiture move assets; ceo_comp sets the player\'s own incentives; csuite_appointment changes leadership quality; buyback allocates capital; ipo makes the company public; gov_contract accepts the risk and compliance burden of a major award; model_release governs safety-sensitive launches; restructuring is survival; ceo_dismissal removes the chief executive, which for a player means losing executive control while keeping their shares.',
  );
export type BoardProposalKind = z.infer<typeof BoardProposalKindSchema>;

export const BOARD_PROPOSAL_STATUSES = ['draft', 'tabled', 'voted', 'passed', 'failed', 'withdrawn'] as const;
export const BoardProposalStatusSchema = z.enum(BOARD_PROPOSAL_STATUSES).describe('Lifecycle of a proposal.');
export type BoardProposalStatus = z.infer<typeof BoardProposalStatusSchema>;

export const BoardProposalSchema = z
  .object({
    id: z.string().min(1),
    companyId: z.string().min(1),
    boardId: z.string().min(1),
    kind: BoardProposalKindSchema,
    title: z.string().min(3).max(140).describe('Agenda line as directors read it.'),
    summary: z.string().max(1200).describe('The case being made, including the numbers directors will actually argue about.'),
    proposedByCharacterId: z.string().min(1).describe('Who tabled it. A proposal to dismiss the chief executive is not tabled by the chief executive.'),
    quarterProposed: QuarterIndexSchema,
    decisionQuarter: QuarterIndexSchema.describe('Quarter the vote resolves in. Usually the quarter it was tabled.'),
    status: BoardProposalStatusSchema,
    amountUsd: z.number().min(0).nullable().describe('Headline monetary size, or null when the matter has no price. This is the field most conditional commitments reference.'),
    dilutionPct: z.number().min(0).max(1).nullable().describe('Fractional dilution created, or null.'),
    stockComponentPct: z.number().min(0).max(1).nullable().describe('Fraction of consideration paid in stock rather than cash, or null.'),
    targetCompanyId: z.string().nullable().describe('Target of an acquisition or divestiture, or null.'),
    linkedActionId: z.string().nullable().describe('Submitted action this proposal authorises, so a pass executes exactly what was voted on.'),
    requiredThresholdFraction: unitInterval('Fraction of present votes needed, resolved from the board quorum rule at tabling time.'),
  })
  .describe('One matter put to a board.');
export type BoardProposal = z.infer<typeof BoardProposalSchema>;

/* -------------------------------------------------------------------------- */
/*  Votes                                                                      */
/* -------------------------------------------------------------------------- */

export const VOTE_STANCES = ['support', 'oppose', 'abstain'] as const;

export const VoteStanceSchema = z
  .enum(VOTE_STANCES)
  .describe('How a director votes. Abstention is a real position: it neither carries a matter nor blocks it, and it is what a conflicted director does.');
export type VoteStance = z.infer<typeof VoteStanceSchema>;

export const BoardVoteSchema = z
  .object({
    proposalId: z.string().min(1),
    directorCharacterId: z.string().min(1),
    vote: z.enum(['support', 'oppose', 'abstain', 'absent']).describe('Cast vote, or "absent" when the director did not attend, which also affects quorum.'),
    quarter: QuarterIndexSchema,
    weight: z.number().min(0).max(5).describe('The director\'s voting weight as applied.'),
    rationale: z.string().max(400).nullable().describe('In-character reason, shown in the boardroom minutes.'),
    honouredCommitmentId: z.string().nullable().describe('Conditional commitment this vote satisfied, or null. A director who breaks a commitment takes a lasting reputation cost with the counterparty.'),
  })
  .describe('One director\'s vote on one proposal.');
export type BoardVote = z.infer<typeof BoardVoteSchema>;

export const BoardTallySchema = z
  .object({
    proposalId: z.string().min(1),
    support: z.number().min(0).describe('Weighted votes in favour.'),
    against: z.number().min(0).describe('Weighted votes against.'),
    abstain: z.number().min(0).describe('Weighted abstentions.'),
    absent: z.number().min(0).describe('Weighted absences.'),
    quorumMet: z.boolean().describe('False when too few directors attended; the matter does not resolve and rolls to the next meeting.'),
    passes: z.boolean().describe('Whether the matter carried under the board rule set.'),
    perDirector: z.array(BoardVoteSchema).describe('Every individual vote, so the boardroom screen can show who moved and why.'),
    decidedByControl: z
      .boolean()
      .default(false)
      .describe('True when a holder of 50% + 1 share decided the matter outright rather than the room. Never true for ceo_dismissal, which stays a genuine board matter.'),
    controllingHolderId: z.string().nullable().default(null).describe('The holder whose stake was decisive, or null when the room decided it.'),
  })
  .describe('The resolved outcome of a board vote.');
export type BoardTally = z.infer<typeof BoardTallySchema>;

/* -------------------------------------------------------------------------- */
/*  Conditional commitments (LLM-facing)                                       */
/* -------------------------------------------------------------------------- */

export const COMMITMENT_FIELDS = [
  'purchasePriceUsd',
  'stockComponentPct',
  'cashComponentPct',
  'dilutionPct',
  'amountUsd',
  'debtRatePct',
  'headcountReductionPct',
  'capexUsd',
  'ceoCompUsd',
  'floatPct',
  'contractValueUsd',
  'governmentRevenueSharePct',
  'safetyEvaluationQuarters',
  'runwayQuarters',
] as const;

export const CommitmentFieldSchema = z
  .enum(COMMITMENT_FIELDS)
  .describe(
    'Which number on the proposal the condition tests. purchasePriceUsd and stockComponentPct are the two most common levers in an acquisition negotiation; dilutionPct and amountUsd dominate financing; ceoCompUsd dominates compensation.',
  );
export type CommitmentField = z.infer<typeof CommitmentFieldSchema>;

export const COMMITMENT_COMPARATORS = ['lt', 'lte', 'eq', 'gte', 'gt'] as const;

export const CommitmentComparatorSchema = z
  .enum(COMMITMENT_COMPARATORS)
  .describe('How the proposal value is compared with the condition value. "A price below $5.5 billion" is field purchasePriceUsd, comparator lte, value 5500000000.');
export type CommitmentComparator = z.infer<typeof CommitmentComparatorSchema>;

export const CommitmentConditionSchema = z
  .object({
    field: CommitmentFieldSchema,
    comparator: CommitmentComparatorSchema,
    value: z.number().describe('The threshold, in the field\'s own units: dollars for USD fields, a 0..1 fraction for Pct fields, a count for quarter fields.'),
  })
  .describe('One machine-checkable condition on a commitment.');
export type CommitmentCondition = z.infer<typeof CommitmentConditionSchema>;

/**
 * A structured promise extracted from a conversation.
 *
 * LLM-facing: produced by the character dialogue agent when a negotiation
 * reaches something concrete. The engine stores it and, when the matching
 * proposal is tabled, checks each condition against the real numbers. Support is
 * engine state throughout; the conversation only created a testable promise.
 */
export const ConditionalCommitmentSchema = z
  .object({
    actorCharacterId: z.string().min(1).describe('The character making the promise.'),
    proposalKind: BoardProposalKindSchema,
    stance: z.enum(VOTE_STANCES).describe('What they promise to do if every condition holds.'),
    conditions: z
      .array(CommitmentConditionSchema)
      .max(6)
      .describe('All conditions must hold for the commitment to bind. An empty array is an unconditional promise, which characters rarely make.'),
    commitmentStrength: unitInterval(
      'How firmly they are bound. Above 0.8 they will honour it against their own preferences; below 0.4 it is a stated inclination they may abandon under pressure from another director or a changed world.',
    ),
    expiresQuarter: QuarterIndexSchema.describe('Quarter after which the promise lapses. Commitments are not permanent; a promise made three quarters ago has usually expired.'),
    targetCompanyId: z.string().nullable().describe('Company the commitment concerns when it is not the speaker\'s own, or null.'),
    rationale: z.string().max(400).describe('The reason the character gave, in their own framing. Shown in the boardroom screen next to the commitment.'),
  })
  .describe(
    'A conditional commitment: the machine-readable residue of a negotiation. "At $6.4 billion I do not support it. Below $5.5 billion, or with a larger stock component, I would" becomes support / purchasePriceUsd lte 5500000000 / stockComponentPct gte 0.35.',
  );
export type ConditionalCommitment = z.infer<typeof ConditionalCommitmentSchema>;

/** A stored commitment, with the engine-assigned identity and outcome. */
export const StoredCommitmentSchema = ConditionalCommitmentSchema.extend({
  id: z.string().min(1),
  createdQuarter: QuarterIndexSchema,
  conversationId: z.string().nullable().describe('Conversation this came out of, for the audit trail.'),
  status: z.enum(['active', 'honoured', 'broken', 'expired', 'superseded']).describe('Outcome. "broken" damages the relationship between the two characters permanently.'),
  resolvedProposalId: z.string().nullable(),
})
  .describe('A conditional commitment as the engine stores it.');
export type StoredCommitment = z.infer<typeof StoredCommitmentSchema>;

/**
 * Evaluate one commitment against a proposal's numbers. Pure and deterministic.
 * Returns true only when every condition holds; missing fields count as failures
 * because a promise conditioned on a number nobody supplied has not been met.
 */
export function commitmentConditionsHold(
  conditions: readonly CommitmentCondition[],
  values: Readonly<Record<string, number | null | undefined>>,
): boolean {
  for (const c of conditions) {
    const actual = values[c.field];
    if (actual === null || actual === undefined || !Number.isFinite(actual)) return false;
    switch (c.comparator) {
      case 'lt':
        if (!(actual < c.value)) return false;
        break;
      case 'lte':
        if (!(actual <= c.value)) return false;
        break;
      case 'eq':
        if (actual !== c.value) return false;
        break;
      case 'gte':
        if (!(actual >= c.value)) return false;
        break;
      case 'gt':
        if (!(actual > c.value)) return false;
        break;
    }
  }
  return true;
}

/* -------------------------------------------------------------------------- */
/*  Executive compensation                                                     */
/* -------------------------------------------------------------------------- */

export const ExecutiveCompensationSchema = z
  .object({
    characterId: z.string().min(1),
    companyId: z.string().min(1),
    baseSalaryUsd: usd('Annual cash salary.'),
    bonusTargetPct: unitInterval('Target bonus as a fraction of base salary.'),
    equityGrantShares: z.number().min(0).describe('Shares granted this package, vesting over vestingQuarters.'),
    vestingQuarters: z.number().int().min(1).max(40).describe('Vesting period in quarters.'),
    performanceConditions: z.array(CommitmentConditionSchema).describe('Conditions that must be met for the equity to vest.'),
    approvedQuarter: QuarterIndexSchema,
    publicReactionScore: score100('How the package was received publicly. Generous packages during layoffs are a reputation event.'),
  })
  .describe('A compensation package. Board-approved, publicly visible for listed companies, and a recurring source of governance conflict.');
export type ExecutiveCompensation = z.infer<typeof ExecutiveCompensationSchema>;
