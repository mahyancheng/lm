/**
 * @frontier/contracts — deals.ts
 *
 * Structured agreements between actors.
 *
 * Free text never writes state. When one player types "I'll supply you 10,000
 * GPUs for two quarters if you let us use your retrieval technology", the game
 * detects a possible agreement and produces a typed `DealProposal`. The
 * counterparty sees the structured terms and accepts them. Only then does the
 * agreement enter the ledger.
 *
 * ## Binding versus non-binding
 *
 * This distinction is the whole point of the subsystem, so it is explicit in the
 * data:
 *
 * - **Binding.** `binding: true` and `status: 'accepted'`. The obligations in
 *   `gives` and `gets` are mechanically enforced by the engine each quarter.
 *   Failing to deliver a binding obligation is a breach: it transfers value,
 *   damages the relationship permanently and is visible in the ledger.
 * - **Non-binding.** `intentStatements` holds things like "we intend to support
 *   you next quarter". They are recorded, they are visible to both parties, and
 *   they are *not* enforced. Characters and players may rely on them at their
 *   own risk, which is exactly what makes human bluffing possible.
 *
 * The simulation therefore always knows what was promised and what was merely
 * said, and "but they promised me in chat" is never an argument.
 */

import { z } from 'zod';
import { QuarterIndexSchema, intCount, usd } from './ids';
import { SectorSchema } from './sectors';
import { FundingStageSchema } from './ownership';
import { BoardProposalKindSchema, VoteStanceSchema } from './governance';

/* -------------------------------------------------------------------------- */
/*  Obligations                                                                */
/* -------------------------------------------------------------------------- */

export const DEAL_OBLIGATION_KINDS = [
  'compute_supply',
  'tech_license',
  'cash_payment',
  'equity_transfer',
  'board_vote_pledge',
  'public_endorsement',
  'consortium_membership',
  'investment',
  // Appended: the discriminated union below grows safely at the end.
  'price_accord',
  // Capital entities. A term sheet and a buyout approach are deals, not a
  // parallel offer pipeline: the deal path already proposes, accepts, rejects,
  // expires and audits, and inventing a second one would be the worst decision
  // available here. Offered in quarter t, answerable only in t+1.
  'term_sheet',
  'buyout_offer',
] as const;

/**
 * One obligation on one side of a deal. Discriminated by `kind` so the engine
 * can execute each variant without inspecting free text.
 *
 * LLM-facing: every field is required; nullable is used instead of optional.
 */
export const DealObligationSchema = z
  .discriminatedUnion('kind', [
    z
      .object({
        kind: z.literal('compute_supply'),
        units: intCount('Accelerator-equivalent units supplied per quarter.'),
        quarters: z.number().int().min(1).max(20).describe('How many quarters the supply runs for, starting the quarter after acceptance.'),
      })
      .describe('Supply accelerator capacity to the counterparty. The supplier must actually hold the capacity each quarter or be in breach.'),
    z
      .object({
        kind: z.literal('tech_license'),
        techNodeId: z.string().nullable().describe('Frontier Map node being licensed, or null when licensing a product instead.'),
        productId: z.string().nullable().describe('Product being licensed, or null when licensing a technology node instead. Exactly one of techNodeId and productId should be set.'),
        quarters: z.number().int().min(1).max(20).describe('Licence term in quarters.'),
      })
      .describe('Grant the counterparty use of a technology or product.'),
    z
      .object({
        kind: z.literal('cash_payment'),
        amount: usd('Total amount paid.'),
      })
      .describe('Pay cash. Settled in the capital phase of the quarter following acceptance.'),
    z
      .object({
        kind: z.literal('equity_transfer'),
        securityId: z.string().min(1).describe('Security whose shares move.'),
        shares: intCount('Number of shares transferred.'),
      })
      .describe('Transfer existing shares. Subject to the cap-table reconciliation invariant and to any lock-up.'),
    z
      .object({
        kind: z.literal('board_vote_pledge'),
        proposalKind: BoardProposalKindSchema,
        stance: VoteStanceSchema,
        quarters: z.number().int().min(1).max(12).describe('How long the pledge stands.'),
      })
      .describe('Pledge to vote a particular way on a class of board matter. Breaking a pledge is a visible, permanent reputational event.'),
    z
      .object({
        kind: z.literal('public_endorsement'),
        statement: z.string().min(5).max(400).describe('What will be said publicly.'),
        quarters: z.number().int().min(1).max(8).describe('How long the endorsement is maintained.'),
      })
      .describe('Say something supportive in public. Spends the endorser\'s credibility with their own audiences.'),
    z
      .object({
        kind: z.literal('consortium_membership'),
        opportunityId: z.string().min(1).describe('Procurement opportunity the consortium is formed to bid on.'),
      })
      .describe('Join a joint bid. Membership is how a specialist reaches a programme it could not deliver alone.'),
    z
      .object({
        kind: z.literal('investment'),
        amount: usd('Capital invested.'),
        securityId: z.string().min(1).describe('Security received in exchange.'),
      })
      .describe('Invest capital for equity. Creates new shares or transfers existing ones depending on the security.'),
    z
      .object({
        kind: z.literal('price_accord'),
        sector: SectorSchema.describe('The sector the accord covers. Every member must operate in it; a mixed-sector accord is refused.'),
        memberCompanyIds: z
          .array(z.string().min(1))
          .min(2)
          .max(6)
          .describe('Every company bound by the accord, the proposer and the counterparty included. At least two, at most six.'),
        quarters: z.number().int().min(1).max(20).describe('How many quarters the accord runs for, starting the quarter after acceptance.'),
      })
      .describe(
        'Hold the sector price together. While it is active every member earns a bonus on the part of its revenue the sector chain reprices, scaled by the members\' combined share of the sector with a floor of five per cent — and every member carries the antitrust exposure that goes with it. An enforcement action suspends the accord for six quarters.',
      ),
    z
      .object({
        kind: z.literal('term_sheet'),
        entityId: z.string().min(1).describe('The CapitalEntity offering, which is also the cap-table holder id the new shares will be issued to.'),
        companyId: z.string().min(1).describe('Company being offered the money.'),
        stage: FundingStageSchema.describe('Stage the round is priced as.'),
        amountUsd: usd('The cheque. Already capped at the fund\'s stage share of committed capital and at a quarter of its remaining dry powder.'),
        preMoneyUsd: usd('Pre-money valuation offered. The engine computed it from the sourcing score; a model never sets it.'),
        dilutionPct: z.number().int().min(0).max(100).describe('Whole percentage of the company sold, equal to amount over post-money. The single economic dial on the card.'),
        boardSeats: intCount('Board seats created for the investor. One at fifteen per cent dilution or more, otherwise none. The single control dial on the card.'),
        proRata: z.boolean().describe('Whether the investor keeps the right to take its share of the next round. Standard from series_a on.'),
        protectiveProvisions: z.boolean().describe('Whether the investor gains a veto over a defined set of matters. Standard at twenty per cent dilution or more.'),
        liquidationPreferenceMultiple: z.number().min(0).max(5).describe('Multiple returned before common. Always 1 here: holding the preference constant is what leaves exactly one price dial and one control dial on a phone-sized card.'),
        participating: z.boolean().describe('Whether the preference also shares in the residual. Always false here, which is the ordinary series A outcome.'),
      })
      .describe(
        'A priced offer of primary capital from a capital entity, answerable in the quarter after it is made. Accepting it closes an ordinary funding round with a real lead investor; countering it inside the engine-computed band is accepted deterministically; rejecting it costs nothing the first time.',
      ),
    z
      .object({
        kind: z.literal('buyout_offer'),
        entityId: z.string().min(1).describe('The sponsor. Also the cap-table holder id that will accumulate the stake.'),
        targetCompanyId: z.string().min(1),
        offerValueUsd: usd('Total consideration offered for the company.'),
        premiumPct: z.number().int().min(0).max(100).describe('Whole percentage over the higher of last close and fundamental anchor. Bounded by the sponsor\'s own premium ceiling; a bear hug bumps it, it never runs away.'),
        stage: z.enum(['private_approach', 'bear_hug', 'tender']).describe('Where the sequence has got to. A private approach is confidential; a bear hug is the same offer made public; a tender accumulates toward control in the open, one quarter at a time.'),
        lboDebtUsd: usd('Debt to be placed on the target itself, capped at its trailing revenue and again at its net assets.'),
        equityChequeUsd: usd('The sponsor\'s own money, drawn from dry powder. Offer value less the debt.'),
      })
      .describe(
        'An approach to buy control of a company. It uses the takeover machinery that already exists — a controlling holder is already decisive on the board tally, and a block is already reachable at a premium — so this adds an offer, not a new verb.',
      ),
  ])
  .describe('One obligation. The set of obligations on each side is what makes a deal mechanically enforceable rather than a conversation.');
export type DealObligation = z.infer<typeof DealObligationSchema>;

/* -------------------------------------------------------------------------- */
/*  Proposals                                                                  */
/* -------------------------------------------------------------------------- */

export const DEAL_CONFIDENTIALITIES = ['private', 'public'] as const;

export const DealConfidentialitySchema = z
  .enum(DEAL_CONFIDENTIALITIES)
  .describe('"private" is known only to the parties, though it can still leak. "public" is announced, which is sometimes the point: a public alliance moves sentiment and warns rivals.');
export type DealConfidentiality = z.infer<typeof DealConfidentialitySchema>;

export const DEAL_STATUSES = ['draft', 'proposed', 'accepted', 'rejected', 'expired', 'executed'] as const;

export const DealStatusSchema = z
  .enum(DEAL_STATUSES)
  .describe(
    'Lifecycle. "draft" exists only for the proposer. "proposed" has been sent and awaits a decision. "accepted" is binding and awaiting execution. "executed" means every obligation has been discharged. "expired" means the counterparty never answered before expiresQuarter.',
  );
export type DealStatus = z.infer<typeof DealStatusSchema>;

export const DEAL_PARTY_KINDS = ['player', 'company', 'character'] as const;
export const DealPartyKindSchema = z.enum(DEAL_PARTY_KINDS).describe('What sort of entity is party to the deal.');
export type DealPartyKind = z.infer<typeof DealPartyKindSchema>;

/**
 * The draft a proposer (human, NPC or the deal-extraction agent) produces.
 * LLM-facing: no ids the model cannot know, all fields required.
 */
export const DealProposalDraftSchema = z
  .object({
    counterpartyId: z.string().min(1).describe('Who the offer is made to.'),
    counterpartyKind: DealPartyKindSchema,
    gives: z.array(DealObligationSchema).max(6).describe('What the proposer commits to provide.'),
    gets: z.array(DealObligationSchema).max(6).describe('What the proposer expects in return.'),
    confidentiality: DealConfidentialitySchema,
    expiresQuarter: QuarterIndexSchema.describe('Quarter after which the offer lapses if unanswered.'),
    binding: z.boolean().describe('True when the obligations are mechanically enforced on acceptance. False makes the whole thing a recorded statement of intent.'),
    intentStatements: z
      .array(z.string().max(300))
      .max(4)
      .describe('Non-binding language: things said but not contracted, such as "we intend to support you next quarter". Recorded, visible to both parties, never enforced.'),
    summary: z.string().min(10).max(600).describe('One paragraph a counterparty can read before opening the term detail.'),
  })
  .describe('A proposed agreement before the engine assigns identity. This is the shape the deal-extraction agent returns when it detects an agreement forming in conversation.');
export type DealProposalDraft = z.infer<typeof DealProposalDraftSchema>;

export const DealProposalSchema = DealProposalDraftSchema.extend({
  id: z.string().min(1),
  proposerId: z.string().min(1).describe('Who made the offer.'),
  proposerKind: DealPartyKindSchema,
  status: DealStatusSchema,
  createdQuarter: QuarterIndexSchema,
  respondedQuarter: QuarterIndexSchema.nullable().describe('Quarter the counterparty answered, or null.'),
  conversationId: z.string().nullable().describe('Conversation the deal came out of, for the audit trail.'),
  breachedByPartyId: z.string().nullable().describe('Party that failed to discharge an obligation, or null. A breach is permanent in every counterparty\'s memory.'),
}).describe('A structured deal in session state. Nothing about a deal is enforceable until status is "accepted" and binding is true.');
export type DealProposal = z.infer<typeof DealProposalSchema>;

/* -------------------------------------------------------------------------- */
/*  Extraction from conversation (LLM-facing)                                  */
/* -------------------------------------------------------------------------- */

export const DealExtractionSchema = z
  .object({
    dealDetected: z.boolean().describe('Whether the conversation contains a concrete, mutual agreement rather than an exchange of intentions. Be conservative: a maybe is not a deal.'),
    draft: DealProposalDraftSchema.nullable().describe('The structured proposal, or null when no deal was detected.'),
    confidence: z.number().min(0).max(1).describe('How confident you are that both parties meant to commit to these exact terms. Range: 0..1. Below 0.6 the game shows the draft as a suggestion rather than pre-filling it.'),
    ambiguities: z.array(z.string().max(200)).max(5).describe('Terms that were discussed but left vague, so the interface can ask the player to pin them down before proposing.'),
    summary: z.string().max(400).describe('One sentence describing what you understood the parties to have agreed.'),
  })
  .describe(
    'The result of watching a conversation for an emerging agreement. Detecting a deal never creates one: it produces a draft the proposer must send and the counterparty must accept.',
  );
export type DealExtraction = z.infer<typeof DealExtractionSchema>;

/* -------------------------------------------------------------------------- */
/*  Execution                                                                  */
/* -------------------------------------------------------------------------- */

export const DealObligationStatusSchema = z
  .object({
    dealId: z.string().min(1),
    side: z.enum(['gives', 'gets']).describe('Which side of the deal this obligation sits on, from the proposer\'s point of view.'),
    index: z.number().int().min(0).describe('Position within that side\'s array.'),
    quartersRemaining: z.number().int().min(0).describe('Quarters of the obligation still to run.'),
    dischargedThisQuarter: z.boolean().describe('Whether the obligation was met in the quarter just resolved.'),
    breach: z.boolean().describe('True when the obligor could not or would not deliver.'),
    note: z.string().max(240).describe('Explanation for the deal room and the ledger.'),
  })
  .describe('Per-quarter execution state for one obligation. Deals with multi-quarter terms are re-checked every quarter, not just on acceptance.');
export type DealObligationStatus = z.infer<typeof DealObligationStatusSchema>;

/** Patterns the deal system is expected to carry, for designer reference. */
export const SUPPORTED_DEAL_PATTERNS = [
  'joint_venture',
  'technology_licensing',
  'investment',
  'share_purchase',
  'merger_or_acquisition',
  'government_bid_consortium',
  'commercial_partnership',
  'research_collaboration',
  'board_voting_arrangement',
  'compute_agreement',
  'public_endorsement',
] as const;
