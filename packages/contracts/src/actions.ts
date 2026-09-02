/**
 * @frontier/contracts — actions.ts
 *
 * Every legal quarterly action, as one discriminated union.
 *
 * `ActionIntent` is the boundary between intention and reality. Players reach it
 * through the normal controls or through the Chief of Staff, which translates
 * natural language into these objects. NPC strategists emit them directly. In
 * both cases nothing has happened yet: an intent is submitted, validated,
 * possibly clamped, and only then resolved by the engine.
 *
 * ## Conventions every builder depends on
 *
 * 1. **No `companyId` on the intent.** The acting company comes from context —
 *    `SubmittedAction.actorCompanyId` for players, `NpcActionBundle.companyId`
 *    for NPCs. Actions that concern *another* company name it explicitly
 *    (`targetCompanyId`, `targetCharacterId`, and so on). This keeps LLM output
 *    small and removes a whole class of impersonation bug.
 * 2. **No `actionId` on the intent.** The engine assigns ids when queuing, so an
 *    LLM never invents one and replays stay deterministic.
 * 3. **LLM-safe throughout.** Every field is required, categorical fields are
 *    enums, nullable replaces optional, and there are no records or transforms —
 *    the whole union has to survive a structured-output round trip.
 * 4. **Attempts, not outcomes.** `raise_round` attempts a raise; the engine
 *    decides whether the market clears it. `poach_executive` makes an approach;
 *    the target decides.
 */

import { z } from 'zod';
import { QuarterIndexSchema, intCount, unitInterval, usd } from './ids';
import { CompBandSchema, CompanyPostureSchema, ExecutiveRoleSchema, ProductSegmentSchema, StaffRoleSchema } from './company';
import { RegionSchema } from './sectors';
import { FundingStageSchema } from './ownership';
import { BoardProposalKindSchema, CommitmentConditionSchema } from './governance';
import { GovernmentBidSchema } from './government';
import { InnovationProposalSchema, PublicationModeSchema } from './tech';
import { SocialPostDraftSchema, CampaignThemeSchema } from './social';
import { DealProposalDraftSchema } from './deals';

/* -------------------------------------------------------------------------- */
/*  Shared sub-shapes                                                          */
/* -------------------------------------------------------------------------- */

export const ApproachSchema = z
  .enum(['private', 'public'])
  .describe('How an approach is made. "private" is discreet and slower; "public" is faster, applies pressure, and creates a public fight the target\'s employer will remember.');
export type Approach = z.infer<typeof ApproachSchema>;

export const SegmentBudgetSchema = z
  .object({
    segment: ProductSegmentSchema,
    budgetUsd: usd('Spend allocated to this segment for the quarter.'),
  })
  .describe('One segment\'s share of a marketing budget.');
export type SegmentBudget = z.infer<typeof SegmentBudgetSchema>;

export const GUIDANCE_METRICS = ['revenue', 'gross_margin', 'operating_income', 'customers', 'model_launch_quarter'] as const;
export const GuidanceMetricSchema = z
  .enum(GUIDANCE_METRICS)
  .describe('What is being guided. Guidance spends management credibility: meeting it builds investor reputation, missing it costs several times as much.');
export type GuidanceMetric = z.infer<typeof GuidanceMetricSchema>;

export const CRISIS_RESPONSES = ['deny', 'acknowledge', 'apologise', 'investigate', 'counter_attack', 'silence'] as const;
export const CrisisResponseSchema = z
  .enum(CRISIS_RESPONSES)
  .describe(
    'How to answer a crisis. "deny" recovers credibility now and destroys it later if the allegation proves true. "acknowledge" and "investigate" cost less over time. "silence" lets the story run. "counter_attack" shifts attention at the cost of hostility.',
  );
export type CrisisResponse = z.infer<typeof CrisisResponseSchema>;

export const REGULATOR_TOPICS = ['model_rules', 'privacy', 'antitrust', 'copyright', 'safety_obligations', 'export_controls', 'procurement_policy'] as const;
export const RegulatorTopicSchema = z.enum(REGULATOR_TOPICS).describe('Subject of a regulatory meeting.');
export type RegulatorTopic = z.infer<typeof RegulatorTopicSchema>;

export const REGULATOR_POSTURES = ['cooperative', 'defensive', 'lobbying', 'informational'] as const;
export const RegulatorPostureSchema = z
  .enum(REGULATOR_POSTURES)
  .describe('The stance taken into the meeting. Cooperative builds standing slowly; lobbying can shift a rule and is remembered by everyone it disadvantages.');
export type RegulatorPosture = z.infer<typeof RegulatorPostureSchema>;

/* -------------------------------------------------------------------------- */
/*  ActionIntent                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Every action a player or NPC company may take in a quarter.
 *
 * Grouped below by the resolution phase that consumes them, which is also the
 * order the engine applies them in.
 */
export const ActionIntentSchema = z
  .discriminatedUnion('type', [
    /* ---------------------------- research ---------------------------- */
    z
      .object({
        type: z.literal('set_research_budget'),
        budgetUsd: usd('Total research and development budget for the coming quarter, across all projects.'),
      })
      .describe('Set the quarterly research budget envelope. Individual projects draw from it in priority order.'),

    z
      .object({
        type: z.literal('start_research_project'),
        targetNodeId: z.string().min(1).describe('Frontier Map node to pursue. Must exist in the current graph.'),
        budgetUsd: usd('Cash committed per quarter to this project, excluding compute.'),
        computeUnits: intCount('Accelerator-equivalents dedicated per quarter. Compute-intensive nodes will stall without enough.'),
        researchersAssigned: intCount('Researchers assigned. Usually the binding constraint rather than money.'),
        secret: z.boolean().describe('Keep the programme concealed. A secret setback stays out of the share price unless it leaks; a secret success surprises the market.'),
      })
      .describe('Begin a research programme against a node on the Frontier Map.'),

    z
      .object({
        type: z.literal('propose_innovation'),
        proposal: InnovationProposalSchema,
      })
      .describe('Propose a technology that is not on the Frontier Map at all. If the rules engine accepts it, it becomes a real node in this session\'s graph, credited to the proposer.'),

    z
      .object({
        type: z.literal('publish_research'),
        nodeId: z.string().min(1).describe('Node whose result is being made public.'),
        mode: PublicationModeSchema,
        rationale: z.string().max(400).describe('Why publish now. Shown in the resolution report.'),
      })
      .describe('Make a private research result public. Buys reputation and hands rivals the method.'),

    /* ---------------------------- product ----------------------------- */
    z
      .object({
        type: z.literal('set_product_price'),
        productId: z.string().min(1),
        pricePerSeatUsd: usd('New list price per seat per quarter.'),
      })
      .describe('Reprice a product. Demand response depends on segment elasticity, quality relative to rivals and switching cost.'),

    z
      .object({
        type: z.literal('launch_product'),
        name: z.string().min(1).max(80).describe('Product name.'),
        segment: ProductSegmentSchema,
        pricePerSeatUsd: usd('Launch price per seat per quarter.'),
        computeIntensity: unitInterval('How much serving compute each unit consumes. Higher intensity buys quality and costs margin.'),
        launchMarketingUsd: usd('One-off launch marketing spend.'),
        targetQuality: unitInterval('Quality the team is aiming for. The engine delivers this discounted by the company\'s real capabilities and by how rushed the launch is.'),
      })
      .describe('Launch a new product line.'),

    z
      .object({
        type: z.literal('sunset_product'),
        productId: z.string().min(1),
        windDownQuarters: z.number().int().min(1).max(8).describe('How long customers are given. Shorter wind-downs save cost and damage enterprise and developer reputation.'),
      })
      .describe('Retire a product.'),

    /* ---------------------------- marketing --------------------------- */
    z
      .object({
        type: z.literal('set_marketing_budget'),
        allocations: z.array(SegmentBudgetSchema).max(4).describe('Per-segment marketing spend for the quarter. Segments not listed are set to zero.'),
      })
      .describe('Reallocate marketing spend across segments. Pulling consumer advertising to fund enterprise sales is a classic mid-game pivot.'),

    z
      .object({
        type: z.literal('marketing_campaign'),
        theme: CampaignThemeSchema,
        segment: ProductSegmentSchema,
        budgetUsd: usd('Total campaign spend.'),
        quarters: z.number().int().min(1).max(8).describe('Campaign duration.'),
      })
      .describe('Run a structured campaign executed by the communications team, as opposed to the founder posting personally.'),

    /* ----------------------------- people ----------------------------- */
    z
      .object({
        type: z.literal('hire'),
        role: StaffRoleSchema,
        count: intCount('How many people to recruit this quarter.'),
        compBand: CompBandSchema,
      })
      .describe('Open and fund roles. Fill rate depends on talent supply, the company\'s reputation with the talent audience and the compensation band.'),

    z
      .object({
        type: z.literal('layoff'),
        role: StaffRoleSchema,
        count: intCount('How many roles to cut.'),
        severanceQuartersOfPay: z.number().min(0).max(4).describe('Severance in quarters of pay. Generous severance costs cash now and protects morale and public reputation.'),
      })
      .describe('Reduce headcount. Always damages morale; the size of the damage depends on how it is done and what else the company is spending on.'),

    z
      .object({
        type: z.literal('poach_executive'),
        targetCharacterId: z.string().min(1).describe('The person being approached. They have their own traits, relationships and memory of how you have behaved.'),
        compPremiumPct: z.number().min(0).max(3).describe('Premium over their current compensation, as a fraction. 0.4 means a 40% raise. Range: 0..3.'),
        approach: ApproachSchema,
      })
      .describe('Approach a senior person at another company. Succeeding takes talent and money; the target\'s employer remembers it either way.'),

    z
      .object({
        type: z.literal('appoint_executive'),
        characterId: z.string().min(1).describe('Person to appoint. Must already be recruited or already employed.'),
        executiveRole: ExecutiveRoleSchema,
        annualCompUsd: usd('Annual compensation for the post.'),
      })
      .describe('Fill a C-suite post. Usually requires a board proposal of kind csuite_appointment first.'),

    /* ---------------------------- compute ----------------------------- */
    z
      .object({
        type: z.literal('reserve_compute'),
        units: intCount('Accelerator-equivalents to reserve.'),
        quarters: z.number().int().min(1).max(16).describe('Reservation term. Long reservations are insurance against a shortage and dead weight in a glut.'),
        maxPricePerUnitUsd: usd('Highest price per unit per quarter you will accept. The reservation fails rather than clearing above this.'),
      })
      .describe('Reserve accelerator capacity for several quarters at a negotiated price.'),

    z
      .object({
        type: z.literal('buy_cloud_capacity'),
        quarterlySpendUsd: usd('On-demand cloud spend for the quarter.'),
        providerCompanyId: z.string().nullable().describe('Preferred provider, or null to buy at market. Buying from a rival creates dependence in both directions.'),
        commitmentQuarters: z.number().int().min(0).max(12).describe('Quarters committed. Zero is fully flexible and fully exposed to spot price.'),
      })
      .describe('Buy on-demand capacity. Flexible, and hostage to the compute domain of the world state.'),

    z
      .object({
        type: z.literal('allocate_compute'),
        trainingFraction: unitInterval('Share of total held capacity directed at training. Serving gets the remainder. Pivoting compute from training into enterprise inference is how a company survives a shortage.'),
      })
      .describe('Split held capacity between training and serving.'),

    /* ---------------------------- capital ----------------------------- */
    z
      .object({
        type: z.literal('raise_round'),
        stage: FundingStageSchema,
        targetAmountUsd: usd('Amount sought.'),
        maxDilutionPct: unitInterval('Most dilution you will accept, as a fraction. The raise fails rather than clearing above this.'),
      })
      .describe('Attempt a private financing. Whether it clears depends on venture liquidity, the company\'s metrics and the market\'s belief about its prospects. A failed raise is itself public information.'),

    z
      .object({
        type: z.literal('issue_debt'),
        amountUsd: usd('Principal sought.'),
        maxRatePct: z.number().min(0).max(0.5).describe('Highest coupon you will accept, as a fraction. 0.09 means 9%. The issue fails rather than clearing above this.'),
        termQuarters: z.number().int().min(1).max(40).describe('Term in quarters.'),
      })
      .describe('Attempt a debt issue. Cheaper than equity while rates and spreads are low, and a trap when they rise.'),

    z
      .object({
        type: z.literal('buyback'),
        budgetUsd: usd('Cash allocated to repurchasing shares.'),
        maxPricePerShareUsd: usd('Highest price you will pay per share.'),
      })
      .describe('Repurchase shares. Requires board approval and returns capital instead of investing it.'),

    z
      .object({
        type: z.literal('issue_shares'),
        shares: intCount('New shares to issue.'),
        shareClassId: z.string().min(1).describe('Class to issue in.'),
        minPricePerShareUsd: usd('Lowest price you will accept per share.'),
      })
      .describe('Issue new equity directly. Dilutive; requires board approval.'),

    z
      .object({
        type: z.literal('ipo'),
        targetRaiseUsd: usd('Primary capital sought at listing.'),
        floatPct: unitInterval('Fraction of the company offered to the public.'),
        minPricePerShareUsd: usd('Lowest price you will list at. A weak IPO window means pricing below this, or pulling the listing.'),
      })
      .describe('Take the company public. Requires board approval and an open listing window; brings quarterly disclosure, activists and permanent scrutiny.'),

    z
      .object({
        type: z.literal('set_dividend_policy'),
        payoutPct: z
          .number()
          .int()
          .min(0)
          .max(80)
          .describe('Share of last quarter\'s net income to pay out to holders, 0 to 80 whole percentage points. The engine caps the payment at half of cash on hand however high this is.'),
      })
      .describe('Set the payout policy. The growth-versus-extraction decision: capital paid out is capital the business does not get to spend. Raising it is a matter for the board.'),

    z
      .object({
        type: z.literal('set_logistics_toll'),
        region: RegionSchema.describe('Region whose freight your group dominates. A region you do not dominate earns a toll of zero.'),
        tollPct: z
          .number()
          .int()
          .min(0)
          .max(25)
          .describe('Toll to charge rivals on their inputs in that region, 0 to 25 whole percentage points. Clamped to what your group\'s regional share actually earns; your own group never pays it.'),
      })
      .describe('Set the toll your logistics group charges everyone else in a region. Cheap inputs for you, dear inputs for them — and antitrust exposure for charging it.'),

    /* --------------------------- ownership ---------------------------- */
    z
      .object({
        type: z.literal('buy_shares'),
        securityId: z.string().min(1).describe('Security to accumulate.'),
        targetPct: z.number().min(0).max(1).nullable().describe('Ownership fraction to reach, or null when specifying a share count instead.'),
        shares: z.number().int().min(0).nullable().describe('Exact share count to buy, or null when specifying a target percentage instead.'),
        maxPricePerShareUsd: usd('Highest price you will pay. Accumulating without moving the price is a skill in itself.'),
      })
      .describe('Accumulate a position in another company. Crossing 5% makes the position public, which is usually the moment the target notices.'),

    z
      .object({
        type: z.literal('sell_shares'),
        securityId: z.string().min(1),
        shares: intCount('Shares to sell.'),
        minPricePerShareUsd: usd('Lowest price you will accept.'),
      })
      .describe('Reduce a position. Large sales move the price against you and are read as a signal.'),

    z
      .object({
        type: z.literal('acquire_company'),
        targetCompanyId: z.string().min(1),
        offerValueUsd: usd('Total offer value for the whole company.'),
        cashPct: unitInterval('Fraction of consideration paid in cash.'),
        stockPct: unitInterval('Fraction paid in stock. cashPct and stockPct should sum to 1; the validator normalises them if they do not.'),
      })
      .describe('Make an offer for another company. Requires board approval, may attract antitrust attention, and hands you its technology, its staff and its problems.'),

    /* ---------------------------- boards ------------------------------ */
    z
      .object({
        type: z.literal('submit_board_proposal'),
        kind: BoardProposalKindSchema,
        title: z.string().min(3).max(140),
        summary: z.string().min(10).max(1200).describe('The case, including the numbers directors will argue about.'),
        amountUsd: z.number().min(0).nullable().describe('Headline monetary size, or null when the matter has no price.'),
        targetCompanyId: z.string().nullable().describe('Target of an acquisition or divestiture, or null.'),
        stockComponentPct: z.number().min(0).max(1).nullable().describe('Stock share of consideration, or null. Directors negotiate hard over this.'),
      })
      .describe('Table a matter for the board to vote on.'),

    z
      .object({
        type: z.literal('lobby_director'),
        directorCharacterId: z.string().min(1),
        proposalId: z.string().min(1).describe('Proposal you want their vote on.'),
        concessions: z.array(CommitmentConditionSchema).max(4).describe('Terms you are willing to change to win the vote, in the same field/comparator/value form a commitment uses.'),
        message: z.string().max(600).describe('What you say to them. Their reply comes from their traits, their mandate and their memory of you — not from how persuasive the text is.'),
      })
      .describe('Speak to a director before the vote. Produces a conditional commitment if the conversation reaches something concrete; it never edits the support score directly.'),

    /* --------------------------- government --------------------------- */
    z
      .object({
        type: z.literal('bid_government'),
        opportunityId: z.string().min(1).describe('Opportunity being bid on. Must equal bid.opportunityId; a mismatch is rejected.'),
        bid: GovernmentBidSchema,
      })
      .describe('Submit a bid. Every field in the bid is a trade-off with a cost somewhere else in the company.'),

    z
      .object({
        type: z.literal('decline_opportunity'),
        opportunityId: z.string().min(1),
        reason: z.string().max(300).describe('Why. Declining an invited opportunity is noted by the agency and mildly reduces future invitations.'),
      })
      .describe('Formally decline to bid.'),

    z
      .object({
        type: z.literal('form_consortium'),
        opportunityId: z.string().min(1),
        inviteeCompanyIds: z.array(z.string()).min(1).max(5).describe('Companies invited to bid jointly.'),
        leadCompanyId: z.string().min(1).describe('Prime contractor, accountable for the whole programme.'),
        sharePct: unitInterval('Your share of the contract value.'),
      })
      .describe('Propose a joint bid. Each invitee must accept through the deal system before the consortium is real.'),

    z
      .object({
        type: z.literal('meet_regulator'),
        regulatorCharacterId: z.string().min(1),
        topic: RegulatorTopicSchema,
        posture: RegulatorPostureSchema,
        concessionsOffered: z.array(z.string().max(160)).max(4).describe('What you offer: early access to evaluations, an audit commitment, a delayed release. Concessions are remembered and expected to be honoured.'),
      })
      .describe('Meet a regulator. Builds or spends institutional standing; never guarantees a rule change.'),

    /* ----------------------------- social ----------------------------- */
    z
      .object({
        type: z.literal('social_post'),
        draft: SocialPostDraftSchema,
      })
      .describe('Publish a post. The engine computes reach and every consequence from the typed draft.'),

    z
      .object({
        type: z.literal('give_guidance'),
        metric: GuidanceMetricSchema,
        value: z.number().describe('The number being guided to, in the metric\'s own units: dollars for revenue and operating income, a 0..1 fraction for gross margin, a count for customers, a quarter index for a launch.'),
        quarter: QuarterIndexSchema.describe('Quarter the guidance applies to.'),
      })
      .describe('Give public guidance. The engine compares it against reality when that quarter resolves and adjusts management credibility accordingly — in both directions.'),

    z
      .object({
        type: z.literal('respond_crisis'),
        crisisEventId: z.string().min(1).describe('World event, media story or disclosure being responded to.'),
        responseKind: CrisisResponseSchema,
        statement: z.string().max(600).describe('What is said publicly.'),
      })
      .describe('Respond to a crisis. A denial that is later contradicted by the facts collapses credibility and brings board pressure.'),

    /* ------------------------- deals and people ----------------------- */
    z
      .object({
        type: z.literal('propose_deal'),
        proposal: DealProposalDraftSchema,
      })
      .describe('Send a structured deal to a counterparty. Nothing binds until they accept.'),

    z
      .object({
        type: z.literal('accept_deal'),
        dealId: z.string().min(1),
      })
      .describe('Accept a deal offered to you. If it is binding, its obligations start executing next quarter.'),

    z
      .object({
        type: z.literal('reject_deal'),
        dealId: z.string().min(1),
        reason: z.string().max(300).describe('Why. The proposer\'s character remembers how they were turned down.'),
      })
      .describe('Reject a deal.'),

    z
      .object({
        type: z.literal('request_introduction'),
        viaCharacterId: z.string().min(1).describe('Person asked to make the introduction. They must be reachable by you and must think well enough of you to spend their standing.'),
        targetCharacterId: z.string().min(1).describe('Person you want to reach, typically far above your connection level.'),
        purpose: z.string().max(300).describe('What you want from the meeting. Vague requests are refused.'),
      })
      .describe('Ask for an introduction. The main legitimate route from a low connection level to a high one.'),
  ])
  .describe('One intended action. Submitting it is not doing it: the engine validates, clamps and then resolves.');
export type ActionIntent = z.infer<typeof ActionIntentSchema>;

/** Every legal `type` discriminator, for exhaustive UI and validator switches. */
export const ACTION_TYPES = [
  'set_research_budget',
  'start_research_project',
  'propose_innovation',
  'publish_research',
  'set_product_price',
  'launch_product',
  'sunset_product',
  'set_marketing_budget',
  'marketing_campaign',
  'hire',
  'layoff',
  'poach_executive',
  'appoint_executive',
  'reserve_compute',
  'buy_cloud_capacity',
  'allocate_compute',
  'raise_round',
  'issue_debt',
  'buyback',
  'issue_shares',
  'ipo',
  'set_dividend_policy',
  'set_logistics_toll',
  'buy_shares',
  'sell_shares',
  'acquire_company',
  'submit_board_proposal',
  'lobby_director',
  'bid_government',
  'decline_opportunity',
  'form_consortium',
  'meet_regulator',
  'social_post',
  'give_guidance',
  'respond_crisis',
  'propose_deal',
  'accept_deal',
  'reject_deal',
  'request_introduction',
] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

/**
 * Actions that must always be confirmed explicitly by a human, even when the
 * player has enabled "execute routine instructions automatically". Financing,
 * mergers and acquisitions, layoffs, stock issuance, major contracts and large
 * spending commitments stay explicit.
 */
export const CONFIRMATION_REQUIRED_ACTIONS: readonly ActionType[] = [
  'raise_round',
  'issue_debt',
  'buyback',
  'issue_shares',
  'ipo',
  'set_dividend_policy',
  'acquire_company',
  'layoff',
  'bid_government',
  'submit_board_proposal',
  'propose_deal',
  'accept_deal',
  'sell_shares',
  'buy_shares',
];

/** True when an action may never be auto-executed on the player's behalf. */
export function requiresExplicitConfirmation(type: ActionType): boolean {
  return CONFIRMATION_REQUIRED_ACTIONS.includes(type);
}

/* -------------------------------------------------------------------------- */
/*  Submitted actions                                                          */
/* -------------------------------------------------------------------------- */

export const ACTION_ORIGINS = ['player_ui', 'chief_of_staff', 'npc_strategist', 'npc_default', 'board_execution', 'deal_execution'] as const;
export const ActionOriginSchema = z
  .enum(ACTION_ORIGINS)
  .describe('Where the action came from. Recorded so a replay can distinguish a decision the player clicked from one the Chief of Staff interpreted on their behalf.');
export type ActionOrigin = z.infer<typeof ActionOriginSchema>;

export const SubmittedActionSchema = z
  .object({
    actionId: z.string().min(1).describe('Engine-assigned id. Deterministic from session, quarter and submission sequence.'),
    sessionId: z.string().min(1),
    quarter: QuarterIndexSchema.describe('Quarter this action is submitted for. An action can only affect the quarter it was locked into.'),
    sequence: z.number().int().min(0).describe('Submission order within the quarter, used to break ties deterministically. Asynchronous multiplayer resolves all actions against one canonical state, so this is a tie-break, not a race.'),
    actorPlayerId: z.string().nullable().describe('Player who submitted it, or null for NPC and system actions.'),
    actorCompanyId: z.string().min(1).describe('Company the action is taken on behalf of. The intent itself never carries this.'),
    actorCharacterId: z.string().min(1).describe('Character taking the action. Relationships and memory attach to people, not companies.'),
    origin: ActionOriginSchema,
    intent: ActionIntentSchema,
    confirmedByHuman: z.boolean().describe('Whether a human explicitly approved it. Must be true for every action in CONFIRMATION_REQUIRED_ACTIONS.'),
  })
  .describe('An action queued for the coming resolution, with everything the engine needs to attribute it.');
export type SubmittedAction = z.infer<typeof SubmittedActionSchema>;

/* -------------------------------------------------------------------------- */
/*  Validation                                                                 */
/* -------------------------------------------------------------------------- */

export const ACTION_VALIDATION_STATUSES = ['accepted', 'rejected', 'clamped'] as const;

export const ActionValidationStatusSchema = z
  .enum(ACTION_VALIDATION_STATUSES)
  .describe(
    '"accepted" means the action runs as submitted. "clamped" means it runs in a reduced form the company could actually afford or execute, and clampedAction carries that form. "rejected" means it does not run at all.',
  );
export type ActionValidationStatus = z.infer<typeof ActionValidationStatusSchema>;

export const ACTION_REJECTION_CODES = [
  'insufficient_cash',
  'insufficient_compute',
  'insufficient_headcount',
  'board_approval_required',
  'board_approval_denied',
  'unknown_target',
  'target_not_reachable',
  'not_controller_of_company',
  'opportunity_closed',
  'requirement_not_met',
  'duplicate_action',
  'lockup_active',
  'confirmation_required',
  'exceeds_authorised_shares',
  'quarter_already_locked',
  'illegal_value',
] as const;
export const ActionRejectionCodeSchema = z.enum(ACTION_REJECTION_CODES).describe('Machine-readable reason an action was refused or reduced.');
export type ActionRejectionCode = z.infer<typeof ActionRejectionCodeSchema>;

export const ActionValidationResultSchema = z
  .object({
    actionId: z.string().min(1),
    status: ActionValidationStatusSchema,
    reasons: z.array(z.string()).describe('Player-readable explanations, one per issue. Always populated for rejected and clamped results.'),
    codes: z.array(ActionRejectionCodeSchema).describe('Machine-readable counterparts to reasons, for UI affordances and tests.'),
    clampedAction: ActionIntentSchema.nullable().describe('The reduced action that will actually run, or null when the action was accepted unchanged or rejected outright.'),
  })
  .describe('The result of validating one submitted action against the current state. The client is never authoritative: this runs server-side, always.');
export type ActionValidationResult = z.infer<typeof ActionValidationResultSchema>;

/* -------------------------------------------------------------------------- */
/*  NPC action bundles (LLM-facing)                                            */
/* -------------------------------------------------------------------------- */

export const NpcActionBundleSchema = z
  .object({
    companyId: z.string().min(1).describe('The company you are running. Every action in this bundle is taken on its behalf.'),
    strategySummary: z
      .string()
      .min(10)
      .max(600)
      .describe('Two or three sentences describing what this company is trying to achieve this quarter, in its own terms. Shown to the designer, never to rival players.'),
    posture: CompanyPostureSchema.describe('The stance driving these actions. It should follow from the company\'s position, not from a desire to be interesting.'),
    actions: z
      .array(ActionIntentSchema)
      .max(8)
      .describe('At most eight actions for the quarter. Fewer, coherent actions beat many scattered ones. The engine decides whether each attempt succeeds; you are choosing what to attempt with the information this company could reasonably have.'),
    rationale: z.string().min(20).max(1000).describe('Why these actions, given what this company knows. Used for the designer log and for post-hoc explanation.'),
  })
  .describe('One quarter of decisions for one NPC company, produced by an NPC strategist that sees only what that company could reasonably know.');
export type NpcActionBundle = z.infer<typeof NpcActionBundleSchema>;
