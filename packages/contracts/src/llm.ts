/**
 * @frontier/contracts — llm.ts
 *
 * The input and output contracts for every LLM role.
 *
 * There is no single "AI" process in this game. There are seven roles with
 * sharply separated authority:
 *
 * | Role                  | Sees                                   | Produces                        |
 * |-----------------------|----------------------------------------|---------------------------------|
 * | world_director        | World digest, candidates, impact budget | Event proposals and modifiers   |
 * | chief_of_staff        | The player's own state, in full         | ActionIntent objects            |
 * | npc_strategist        | Only what that company could know       | An NpcActionBundle              |
 * | character_dialogue    | One character's traits, memory, ties    | A reply and optional commitment  |
 * | innovation_interpreter| The Frontier Map and company resources  | An InnovationProposal           |
 * | social_author         | An actor's intent and audiences         | A SocialPostDraft               |
 * | narrator              | Committed ledger events only            | Prose describing what happened  |
 *
 * The World Director is mostly invisible: it does not narrate the player's
 * story, it proposes legal modifiers. The Chief of Staff is conversational: it
 * reads state, explains options and translates intention into typed actions.
 * Neither writes state. Every result is a proposal, validated by these schemas
 * and then bounds-checked by the engine before any mutation.
 *
 * Every important LLM result is logged as an `AgentRunRecord`, which is what
 * makes bugs reproducible and replays honest.
 */

import { z } from 'zod';
import { QuarterIndexSchema, unitInterval } from './ids';
import { WorldVariableReadingSchema } from './world';
import { ImpactBudgetSchema } from './modifiers';
import { GmEventProposalSchema, GmProposalBatchSchema } from './events';
import { WorldEventCandidateSchema } from './engine';
import { ActionIntentSchema, ActionTypeSchema } from './actions';
import { ConditionalCommitmentSchema } from './governance';
import { CharacterSchema, MemoryDraftSchema, MemorySchema, RelationshipSchema } from './people';
import { InnovationProposalSchema } from './tech';
import { NetworkArchetypeSchema, PostIntentSchema, SocialPostDraftSchema } from './social';
import { CompanyPostureSchema, FinancialQuarterSchema, ProductSegmentSchema } from './company';

/* -------------------------------------------------------------------------- */
/*  Roles                                                                      */
/* -------------------------------------------------------------------------- */

export const AGENT_ROLES = [
  'world_director',
  'chief_of_staff',
  'npc_strategist',
  'character_dialogue',
  'innovation_interpreter',
  'social_author',
  'narrator',
] as const;

export const AgentRoleSchema = z.enum(AGENT_ROLES).describe('Which LLM role produced or is producing this output. Authority is scoped per role and never overlaps.');
export type AgentRole = z.infer<typeof AgentRoleSchema>;

/* -------------------------------------------------------------------------- */
/*  World Director                                                             */
/* -------------------------------------------------------------------------- */

export const RecentEventSummarySchema = z
  .object({
    eventId: z.string().min(1),
    quarter: QuarterIndexSchema,
    type: z.string().describe('Event type.'),
    title: z.string().describe('Headline as it was published.'),
    severity: unitInterval('How consequential it was.'),
    stillActive: z.boolean().describe('Whether the event is still inside its duration.'),
  })
  .describe('One recent world event, so the Director can build on causes already in play instead of inventing unrelated shocks.');
export type RecentEventSummary = z.infer<typeof RecentEventSummarySchema>;

export const WorldDirectorInputSchema = z
  .object({
    sessionId: z.string().min(1),
    quarter: QuarterIndexSchema,
    quarterLabel: z.string().describe('Human label for the quarter, e.g. "2031 Q2".'),
    worldSummary: z
      .string()
      .describe('A prose briefing on the state of the world: what is tight, what is cheap, what the press is preoccupied with, what changed last quarter.'),
    worldDigest: z.array(WorldVariableReadingSchema).describe('The numeric readings behind the briefing, with their change since last quarter.'),
    sectorSummary: z.array(z.object({ sectorId: z.string(), sentiment: z.number(), multiple: z.number(), demand: z.number() })).describe('Per-sector conditions.'),
    eventCandidates: z
      .array(WorldEventCandidateSchema)
      .describe('Candidate skeletons drawn by the deterministic hazard engine. The engine has already decided that something in each family happens; contextualise them. Returning fewer proposals than candidates is allowed.'),
    impactBudget: ImpactBudgetSchema,
    recentEvents: z.array(RecentEventSummarySchema).describe('Events from the last several quarters, so cascades read as consequences rather than coincidences.'),
    activeModifierSummaries: z
      .array(z.object({ target: z.string(), operation: z.string(), value: z.number(), remainingQuarters: z.number(), reason: z.string() }))
      .describe('Modifiers already in force. Do not stack a second shock on a variable that is already 30% below baseline unless that is the point.'),
    legalTargetPaths: z.array(z.string()).describe('Every legal fixed target path. Any target outside this list, or outside the documented sector and company patterns, causes the whole proposal to be discarded.'),
    knownSectorIds: z.array(z.string()).describe('Sector ids that exist in this session.'),
    styleGuidance: z.string().describe('Tone notes for the copy: in-world reporting, no second person, no prediction of any player\'s outcome.'),
  })
  .describe('Everything the World Director sees. It never sees a player\'s private state, and it is never asked what should happen to a specific player.');
export type WorldDirectorInput = z.infer<typeof WorldDirectorInputSchema>;

/** The World Director's output is `GmProposalBatchSchema` (see events.ts). */
export const WorldDirectorOutputSchema = GmProposalBatchSchema;
export type WorldDirectorOutput = z.infer<typeof WorldDirectorOutputSchema>;

/** Single-event convenience alias, for callers that ask for one proposal at a time. */
export const WorldDirectorSingleOutputSchema = GmEventProposalSchema;
export type WorldDirectorSingleOutput = z.infer<typeof WorldDirectorSingleOutputSchema>;

/* -------------------------------------------------------------------------- */
/*  Chief of Staff                                                             */
/* -------------------------------------------------------------------------- */

/**
 * The Chief of Staff dossier.
 *
 * Everything below this line is *typed* state, composed from the canonical
 * session by a builder that reads nothing private about anyone else. It
 * replaces the prose briefing the role used to be handed — the prose fields on
 * the input survive, filled from these sections, so an older caller still
 * works and the model still gets a readable summary.
 *
 * The rule the sections keep: **absent means withheld, never zero.** A private
 * rival carries no financial figures at all rather than nulls that read as a
 * broke company, and an optional block that is missing is missing because this
 * seat may not see it.
 */

export const CosFinancesSchema = z
  .object({
    cashUsd: z.number().describe('Cash on hand right now.'),
    debtUsd: z.number().describe('Debt outstanding.'),
    revenueQuarterlyUsd: z.number().describe('Revenue recognised last quarter.'),
    quarterlyBurnUsd: z.number().describe('Net cash movement per quarter. Negative is cash consumed.'),
    runwayQuarters: z.number().min(0).max(200).describe('Quarters of cash left at the current burn. 200 means effectively unbounded.'),
    grossMarginPct: unitInterval('Gross margin as a fraction of revenue.'),
    operatingMarginPct: z.number().min(-10).max(1).describe('Operating margin as a fraction of revenue. Range: -10..1.'),
    history: z
      .array(FinancialQuarterSchema)
      .max(8)
      .describe('The last eight closed quarters, oldest first. Never padded: a company with two filed quarters has two entries.'),
  })
  .describe('What the company is worth, what it earns and what it is spending, with the filed statements behind it.');
export type CosFinances = z.infer<typeof CosFinancesSchema>;

export const CosProductLineSchema = z
  .object({
    productId: z.string().min(1),
    name: z.string().min(1).max(80),
    segment: ProductSegmentSchema,
    pricePerSeatUsd: z.number().describe('Current list price per seat per quarter.'),
    activeCustomers: z.number().int().min(0),
    grossMarginPct: unitInterval('Gross margin on this line.'),
    churnQuarterly: unitInterval('Fraction of customers lost last quarter.'),
    qualityScore: unitInterval('How good it is relative to the market frontier.'),
    revenueQuarterlyUsd: z.number().describe('Price times customers: what the line brings in per quarter.'),
    isActive: z.boolean().describe('False once the line has been sunset.'),
  })
  .describe('One product line as the founder would discuss it.');
export type CosProductLine = z.infer<typeof CosProductLineSchema>;

export const CosProductsSchema = z
  .object({
    lines: z.array(CosProductLineSchema).max(24),
    computeOwned: z.number().int().min(0).describe('Accelerators owned outright.'),
    computeReserved: z.number().int().min(0).describe('Accelerator-equivalents under reservation.'),
    computeUtilisationPct: unitInterval('Fraction of held capacity in use.'),
    trainingAllocationPct: unitInterval('Share of capacity pointed at training rather than serving.'),
    reservationExpiryQuarter: QuarterIndexSchema.nullable().describe('Quarter the current reservation lapses, or null.'),
    cloudSpendQuarterlyUsd: z.number().describe('On-demand cloud spend per quarter.'),
  })
  .describe('What the company sells and the capacity it sells it on.');
export type CosProducts = z.infer<typeof CosProductsSchema>;

export const CosPersonSchema = z
  .object({
    characterId: z.string().min(1),
    name: z.string().min(1).max(120),
    role: z.string().min(1).max(60).describe('Their role in the world, e.g. "founder", "investor".'),
    title: z.string().max(120).describe('Their job title, or empty.'),
    isCeo: z.boolean(),
  })
  .describe('One person who matters to this company.');
export type CosPerson = z.infer<typeof CosPersonSchema>;

export const CosPeopleSchema = z
  .object({
    engineers: z.number().int().min(0),
    researchers: z.number().int().min(0),
    sales: z.number().int().min(0),
    ops: z.number().int().min(0),
    execs: z.number().int().min(0),
    total: z.number().int().min(0),
    moralePct: z.number().min(0).max(100).describe('Company-wide morale, 0-100.'),
    attritionPct: unitInterval('Fraction of staff who will leave next quarter at current morale and pay.'),
    openRoles: z.number().int().min(0),
    payrollQuarterlyUsd: z.number(),
    keyCharacters: z.array(CosPersonSchema).max(12).describe('The founder, the chief executive and the executives, when this seat can see them.'),
  })
  .describe('Headcount by function, how the staff feel, and who the company\'s people are.');
export type CosPeople = z.infer<typeof CosPeopleSchema>;

export const CosBoardProposalSchema = z
  .object({
    proposalId: z.string().min(1),
    kind: z.string().min(1).max(60),
    title: z.string().min(1).max(140),
    status: z.string().min(1).max(40),
    decisionQuarter: QuarterIndexSchema,
    amountUsd: z.number().nullable().describe('Headline size, or null when the matter has no price.'),
  })
  .describe('One matter in front of the board.');
export type CosBoardProposal = z.infer<typeof CosBoardProposalSchema>;

export const CosThresholdSchema = z
  .object({
    label: z.string().min(1).max(80).describe('What the threshold buys, e.g. "board control".'),
    fraction: unitInterval('The ownership fraction it takes.'),
    reached: z.boolean().describe('Whether the founder is already past it.'),
  })
  .describe('One ownership threshold and whether the founder has crossed it.');
export type CosThreshold = z.infer<typeof CosThresholdSchema>;

export const CosGovernanceSchema = z
  .object({
    hasBoard: z.boolean().describe('False for a company small enough to have no board, which is also what makes financing and M&A unavailable.'),
    seatsAuthorised: z.number().int().min(0),
    seatsFilled: z.number().int().min(0),
    founderSeats: z.number().int().min(0).describe('Seats held by the founder or their nominees.'),
    founderOwnershipPct: unitInterval('The founder\'s own fraction of the company.'),
    thresholds: z.array(CosThresholdSchema).max(8),
    openProposals: z.array(CosBoardProposalSchema).max(12),
    isCeo: z.boolean().describe('Whether the founder still holds the chief executive\'s office. Losing it removes most of the action surface.'),
  })
  .describe('Who controls the company, and what the board is being asked.');
export type CosGovernance = z.infer<typeof CosGovernanceSchema>;

export const CosRivalSchema = z
  .object({
    companyId: z.string().min(1),
    name: z.string().min(1).max(120),
    ticker: z.string().max(8).nullable(),
    sectorId: z.string().min(1),
    isPublic: z.boolean(),
    revenueQuarterlyUsd: z.number().nullable().describe('Last reported revenue, or null when the company is private and discloses nothing.'),
    marketCapUsd: z.number().nullable().describe('Market capitalisation, or null when unlisted.'),
    enterpriseReputation: z.number().min(0).max(100),
  })
  .describe('A rival as this seat may see it: public information only.');
export type CosRival = z.infer<typeof CosRivalSchema>;

export const CosMarketsSchema = z
  .object({
    isPublic: z.boolean(),
    ticker: z.string().max(8).nullable(),
    sharePriceUsd: z.number().nullable().describe('Last quote, or null when unlisted.'),
    marketCapUsd: z.number().nullable(),
    sectorId: z.string().min(1),
    sectorSentiment: z.number().describe('Sector sentiment, as the engine holds it.'),
    sectorMultiple: z.number().describe('Revenue multiple the sector is being paid.'),
    sectorDemand: z.number(),
    sectorPriceIndex: z.number().nullable().describe('Goods price index for the sector, or null in a world that does not price goods.'),
    sectorShortage: z.number().nullable().describe('Shortage counter for the sector, or null in a world that does not price goods.'),
    rivals: z.array(CosRivalSchema).max(24),
  })
  .describe('What the market thinks, of the company and of the sector it trades in.');
export type CosMarkets = z.infer<typeof CosMarketsSchema>;

export const CosFundStanceSchema = z
  .object({
    entityId: z.string().min(1),
    name: z.string().min(1).max(80),
    kind: z.string().min(1).max(40).describe('venture, private equity, hedge fund, and so on.'),
    dryPowderUsd: z.number().describe('Uncalled capital: how much they could still do to you.'),
    holdsStakePct: unitInterval('Fraction of this company they already hold.'),
    thesis: z.string().max(160),
  })
  .describe('One capital desk and where it stands relative to this company.');
export type CosFundStance = z.infer<typeof CosFundStanceSchema>;

export const CosApproachSchema = z
  .object({
    id: z.string().min(1),
    kind: z.enum(['term_sheet', 'deal', 'activist_letter']).describe('What kind of approach this is.'),
    fromName: z.string().min(1).max(120).describe('Who made it.'),
    summary: z.string().min(1).max(300),
    quarter: QuarterIndexSchema,
  })
  .describe('One open approach: a term sheet, a proposed deal or an activist letter.');
export type CosApproach = z.infer<typeof CosApproachSchema>;

export const CosCapitalSchema = z
  .object({
    funds: z.array(CosFundStanceSchema).max(12),
    approaches: z.array(CosApproachSchema).max(16),
    debtHeadroomUsd: z.number().min(0).describe('Debt the company could plausibly add before its balance sheet stops supporting it.'),
    dividendPayoutPct: z.number().int().min(0).max(80).describe('Current payout policy in whole percentage points.'),
    sharesOutstanding: z.number().min(0),
    ipoWindow: unitInterval('How open the listing window is, 0..1.'),
    ventureLiquidity: unitInterval('How freely private capital is being written, 0..1.'),
    debtAvailability: unitInterval('How available debt is, 0..1.'),
  })
  .describe('Who might fund this company, who is circling it, and what it could raise.');
export type CosCapital = z.infer<typeof CosCapitalSchema>;

export const CosResearchProjectSchema = z
  .object({
    projectId: z.string().min(1),
    nodeId: z.string().min(1),
    title: z.string().min(1).max(140),
    progressPct: unitInterval('Fraction of the way to demonstration.'),
    internalConfidencePct: unitInterval('The team\'s own belief it will land.'),
    researchers: z.number().int().min(0),
    computeUnits: z.number().int().min(0),
    budgetQuarterlyUsd: z.number(),
    quartersRemaining: z.number().int().min(0).describe('Internal estimate of quarters still to run.'),
    isSecret: z.boolean(),
    status: z.string().min(1).max(40),
  })
  .describe('One live research programme, in its private truth.');
export type CosResearchProject = z.infer<typeof CosResearchProjectSchema>;

export const CosResearchSchema = z
  .object({
    budgetQuarterlyUsd: z.number(),
    projects: z.array(CosResearchProjectSchema).max(16),
    availableNodes: z.array(z.object({ nodeId: z.string().min(1), title: z.string().min(1).max(140) })).max(24).describe('Frontier Map nodes this company could start a programme against.'),
  })
  .describe('What the company is trying to invent, and what it could try next.');
export type CosResearch = z.infer<typeof CosResearchSchema>;

export const CosProgrammeSchema = z
  .object({
    opportunityId: z.string().min(1),
    programme: z.string().min(1).max(140),
    agencyName: z.string().max(120),
    maxValueUsd: z.number(),
    closeQuarter: QuarterIndexSchema,
    invited: z.boolean().describe('True when this company was invited rather than merely able to see it.'),
    alreadyBid: z.boolean(),
  })
  .describe('One procurement opportunity this company can act on.');
export type CosProgramme = z.infer<typeof CosProgrammeSchema>;

export const CosGovernmentSchema = z
  .object({
    openProgrammes: z.array(CosProgrammeSchema).max(16),
    liveContracts: z.array(z.object({ contractId: z.string().min(1), programme: z.string().max(140), valueUsd: z.number() })).max(16),
    pastPerformance: z.number().min(0).max(100).describe('Formal procurement past-performance score, 0-100.'),
  })
  .describe('Public money: what is open, what has been won, and how the agencies rate this contractor.');
export type CosGovernment = z.infer<typeof CosGovernmentSchema>;

export const CosFeedItemSchema = z
  .object({
    itemId: z.string().min(1),
    quarter: QuarterIndexSchema,
    kind: z.string().min(1).max(40),
    headline: z.string().min(1).max(200),
    whyItMatters: z.string().max(160).nullable().describe('The engine\'s own one-line consequence for this company, or null when it did nothing to them.'),
  })
  .describe('One item of the public record that bears on this company.');
export type CosFeedItem = z.infer<typeof CosFeedItemSchema>;

export const COS_BOUND_UNITS = ['usd', 'count', 'fraction', 'percent', 'quarters'] as const;
export const CosBoundUnitSchema = z.enum(COS_BOUND_UNITS).describe('How to read a bound\'s numbers.');
export type CosBoundUnit = z.infer<typeof CosBoundUnitSchema>;

export const CosBoundSchema = z
  .object({
    field: z.string().min(1).max(60).describe('The field on the action intent this bounds.'),
    label: z.string().min(1).max(80).describe('What it is, in words.'),
    min: z.number().nullable().describe('Lowest legal value, or null when there is no floor.'),
    max: z.number().nullable().describe('Highest value this company could actually execute right now, or null when unbounded.'),
    unit: CosBoundUnitSchema,
  })
  .describe('One numeric bound on one field, derived from the validator\'s own constants and this company\'s position. Never hand-typed.');
export type CosBound = z.infer<typeof CosBoundSchema>;

export const CosTargetSchema = z
  .object({
    id: z.string().min(1).describe('The id to put on the intent, verbatim.'),
    label: z.string().min(1).max(140).describe('What it is, for the founder.'),
  })
  .describe('One legal target for an action that names something: a product, an opportunity, a person, a company.');
export type CosTarget = z.infer<typeof CosTargetSchema>;

export const CosAvailableActionSchema = z
  .object({
    type: ActionTypeSchema,
    available: z.boolean().describe('True when the validator accepted a probe of this action against the current state. False means it would be refused today.'),
    reason: z
      .string()
      .max(400)
      .nullable()
      .describe('Why it is unavailable, in the validator\'s own words, or null when it is available. This is the sentence to quote back to the founder.'),
    becomesBoardMatter: z.boolean().describe('True when the validator turns this into a board proposal instead of executing it.'),
    requiresConfirmation: z.boolean().describe('True for the always-confirm set. Taken from CONFIRMATION_REQUIRED_ACTIONS, never decided here.'),
    bounds: z.array(CosBoundSchema).max(8),
    targets: z.array(CosTargetSchema).max(24).describe('Legal targets for the ids this action carries. Empty when it names nothing, or when nothing legal exists.'),
    maxCashUsd: z.number().min(0).nullable().describe('Cash this action may commit, or null when it commits none.'),
  })
  .describe(
    'One action type, with what this company could actually do with it right now. Derived by probing the engine\'s own validator: a bound the validator would reject never appears here as available.',
  );
export type CosAvailableAction = z.infer<typeof CosAvailableActionSchema>;

export const ChiefOfStaffDossierSchema = z
  .object({
    companyName: z.string().min(1).max(120),
    founderName: z.string().min(1).max(120),
    quarterLabel: z.string().min(1).max(20).describe('Human label for the open quarter, e.g. "2031 Q2".'),
    posture: CompanyPostureSchema,
    finances: CosFinancesSchema,
    products: CosProductsSchema,
    people: CosPeopleSchema,
    governance: CosGovernanceSchema,
    markets: CosMarketsSchema,
    capital: CosCapitalSchema,
    research: CosResearchSchema,
    government: CosGovernmentSchema,
    feed: z.array(CosFeedItemSchema).max(10).describe('The ten public-record items that matter most to this company, newest first.'),
    openDecisions: z.array(z.string().max(300)).max(20).describe('Matters awaiting the founder this quarter.'),
    availableActions: z.array(CosAvailableActionSchema).max(64).describe('Every action type, with its bounds and its verdict for this company right now.'),
    worldNotes: z.array(z.string().max(300)).max(12).describe('World conditions that bear on this company: rates, compute, talent, regulation.'),
  })
  .describe(
    'Everything the Chief of Staff knows, typed. Built from the player\'s own company in full and from nothing private about anyone else — a rival appears here exactly as the public record shows them.',
  );
export type ChiefOfStaffDossier = z.infer<typeof ChiefOfStaffDossierSchema>;

/* --- memory --------------------------------------------------------------- */

/** Exchanges the server-side memory keeps for one Chief of Staff thread. */
export const COS_MEMORY_EXCHANGES = 8;
/** Standing preferences the memory keeps. */
export const COS_MEMORY_PREFERENCES = 6;

export const CosMemoryExchangeSchema = z
  .object({
    quarter: QuarterIndexSchema.describe('Which quarter this exchange happened in. Recorded so an old instruction is not read as a live one.'),
    founderSaid: z.string().min(1).max(240),
    chiefReplied: z.string().min(1).max(240),
  })
  .describe('One compressed turn of a thread that has to survive a forty-quarter campaign.');
export type CosMemoryExchange = z.infer<typeof CosMemoryExchangeSchema>;

export const CosStandingPreferenceSchema = z
  .object({
    quarter: QuarterIndexSchema.describe('Quarter the founder stated it.'),
    text: z.string().min(1).max(200).describe('The preference in the founder\'s own words, e.g. "never lay anyone off without asking me twice".'),
  })
  .describe('A standing instruction the founder gave once and expects to be remembered.');
export type CosStandingPreference = z.infer<typeof CosStandingPreferenceSchema>;

export const ChiefOfStaffMemorySchema = z
  .object({
    exchanges: z.array(CosMemoryExchangeSchema).max(COS_MEMORY_EXCHANGES).describe('The last few exchanges, oldest first, summarised.'),
    preferences: z.array(CosStandingPreferenceSchema).max(COS_MEMORY_PREFERENCES).describe('Standing preferences, oldest first.'),
  })
  .describe('The compact server-side memory of one Chief of Staff thread. Bounded on purpose: a thread lasts a whole game, a context window does not.');
export type ChiefOfStaffMemory = z.infer<typeof ChiefOfStaffMemorySchema>;

/** An empty memory. The starting value for a thread nobody has spoken on yet. */
export const EMPTY_CHIEF_OF_STAFF_MEMORY: ChiefOfStaffMemory = { exchanges: [], preferences: [] };

/* --- input ---------------------------------------------------------------- */

export const ChiefOfStaffInputSchema = z
  .object({
    sessionId: z.string().min(1),
    quarter: QuarterIndexSchema,
    playerId: z.string().min(1),
    companyId: z.string().min(1),
    playerMessage: z.string().min(1).describe('What the player actually typed.'),
    /**
     * Where the founder asked from. The drawer is reachable from every screen,
     * and "explain this screen's numbers" is only answerable if the role knows
     * which screen that was.
     */
    screen: z.string().max(80).optional().describe('Route the founder asked from, e.g. "/capital". Absent when asked from the dedicated screen.'),
    dossier: ChiefOfStaffDossierSchema.optional().describe('The typed state. Absent only for a caller that predates it, which then relies on the prose fields alone.'),
    memory: ChiefOfStaffMemorySchema.optional().describe('The compact server-side memory of this thread, injected by the route. Absent on the first turn.'),
    companyBriefing: z.string().describe('Prose summary of the company: cash, runway, headcount, products, compute, current budgets and commitments. Filled from the dossier when there is one.'),
    worldBriefing: z.string().describe('Prose summary of world conditions relevant to this company.'),
    currentBudgets: z.array(z.object({ label: z.string(), amountUsd: z.number() })).describe('Current spend lines, so "keep total burn roughly unchanged" can be honoured arithmetically.'),
    openDecisions: z.array(z.string()).describe('Matters awaiting the player: board proposals, expiring reservations, open opportunities, unanswered deals.'),
    conversationHistory: z.array(z.object({ role: z.enum(['player', 'chief_of_staff']), text: z.string() })).describe('Recent turns of this conversation, as the client holds them.'),
    autoExecuteEnabled: z.boolean().describe('Whether the player has enabled automatic execution of routine instructions. Financing, mergers, layoffs, share issuance, major contracts and large spending commitments always require explicit confirmation regardless.'),
  })
  .describe('Everything the Chief of Staff sees. It sees the player\'s own company in full and nothing private about anyone else.');
export type ChiefOfStaffInput = z.infer<typeof ChiefOfStaffInputSchema>;

/* --- output --------------------------------------------------------------- */

export const COS_MODES = ['answer', 'plan', 'act'] as const;
export const CosModeSchema = z
  .enum(COS_MODES)
  .describe(
    '"answer" — the founder asked a question and wants words back; interpretedInstructions is empty. "plan" — a course of action is proposed for discussion, with the actions attached. "act" — the founder gave an instruction and these are the typed actions that carry it out.',
  );
export type CosMode = z.infer<typeof CosModeSchema>;

export const ChiefOfStaffInterpretationSchema = z
  .object({
    mode: CosModeSchema,
    reply: z
      .string()
      .min(1)
      .max(2000)
      .describe(
        'The words the founder reads: the answer to their question, the advice they asked for, or the rationale behind the plan. Always written; state numbers as whole figures and cite only what the dossier contains.',
      ),
    interpretedInstructions: z
      .array(ActionIntentSchema)
      .max(12)
      .describe('The player\'s intention expressed as typed actions. Empty in answer mode. Preserve arithmetic constraints they stated, such as keeping total spend roughly unchanged. Never invent a commitment they did not ask for.'),
    summary: z
      .string()
      .min(10)
      .max(1200)
      .describe('A plain-language restatement of what will be submitted, written so the player can check it at a glance: old value, new value, one line per change. State plainly that no binding action has been submitted yet.'),
    questions: z
      .array(z.string().max(240))
      .max(5)
      .describe('Questions you need answered before this is safe to submit. Ask when a figure is ambiguous rather than guessing at it.'),
    requiresConfirmation: z
      .boolean()
      .describe('True whenever any interpreted action is in the always-confirm set, or whenever your confidence is low. When in doubt, true.'),
    confidence: unitInterval('How confident you are that this matches what the player meant. Below 0.7 the interface presents it as a draft rather than a ready submission.'),
    unsupportedRequests: z.array(z.string().max(240)).max(5).describe('Things the player asked for that the game has no action for, or that this company cannot do today, said plainly rather than silently dropped.'),
  })
  .describe(
    'The Chief of Staff\'s answer to one message. It is a proposal: the player approves or edits it, and only then is anything submitted.',
  );
export type ChiefOfStaffInterpretation = z.infer<typeof ChiefOfStaffInterpretationSchema>;

/* -------------------------------------------------------------------------- */
/*  NPC strategist                                                             */
/* -------------------------------------------------------------------------- */

export const NpcStrategistInputSchema = z
  .object({
    sessionId: z.string().min(1),
    quarter: QuarterIndexSchema,
    companyId: z.string().min(1),
    companyBriefing: z.string().describe('This company\'s own position, in full.'),
    worldBriefing: z.string().describe('World conditions as this company would understand them.'),
    rivalBriefing: z.string().describe('What this company knows about rivals — public information only, plus anything it has legitimately learned.'),
    openOpportunities: z.array(z.object({ opportunityId: z.string(), programme: z.string(), maxValueUsd: z.number(), closeQuarter: z.number() })).describe('Procurement this company can see.'),
    incomingDeals: z.array(z.object({ dealId: z.string(), fromId: z.string(), summary: z.string() })).describe('Deals awaiting an answer.'),
    priorPosture: CompanyPostureSchema.describe('The stance this company took last quarter. Wild swings without cause read as incoherent.'),
    priorStrategySummary: z.string().describe('What this company said it was doing last quarter, so its behaviour has continuity.'),
    constraints: z.array(z.string()).describe('Hard limits: available cash, available compute, board approvals required, contractual commitments already made.'),
  })
  .describe('What an NPC strategist sees: only the information its company could reasonably have. Rival private state is never included.');
export type NpcStrategistInput = z.infer<typeof NpcStrategistInputSchema>;

/* -------------------------------------------------------------------------- */
/*  Character dialogue                                                         */
/* -------------------------------------------------------------------------- */

export const GameFactSchema = z
  .object({
    label: z.string().min(1).max(80).describe('What the fact is, e.g. "Vector enterprise retention".'),
    value: z.string().min(1).max(120).describe('The value as a string, already formatted, e.g. "84%, down from 91%".'),
  })
  .describe('One verified fact from the simulation, supplied so a character argues from real numbers rather than invented ones.');
export type GameFact = z.infer<typeof GameFactSchema>;

export const CharacterUtteranceContextSchema = z
  .object({
    character: CharacterSchema.describe('Who is speaking: their traits, beliefs, role and standing.'),
    relationship: RelationshipSchema.nullable().describe('How the speaker regards the person they are talking to, or null if they have never met.'),
    counterpartRelationship: RelationshipSchema.nullable().describe('How the other party regards the speaker, or null. Characters can sense asymmetry.'),
    memories: z.array(MemorySchema).describe('What the speaker remembers about this person, strongest first. This is what makes an NPC bring up a poaching raid three years later.'),
    topic: z.string().min(1).max(200).describe('What the conversation is about.'),
    gameFacts: z.array(GameFactSchema).describe('Verified numbers relevant to the topic. A character may argue from these; they may not invent others.'),
    conversationHistory: z.array(z.object({ speakerId: z.string(), text: z.string() })).describe('Recent turns.'),
    accessBasis: z.string().describe('Why this conversation is permitted: connection gap, shared board, introduction, negotiation. Characters know when they are talking to someone far outside their usual circle.'),
    pendingProposalSummary: z.string().nullable().describe('The board matter or deal under discussion, or null.'),
  })
  .describe('Everything a character dialogue agent sees. Conversations emerge from actual state, never from a generic persona.');
export type CharacterUtteranceContext = z.infer<typeof CharacterUtteranceContextSchema>;

export const RelationshipDeltasSchema = z
  .object({
    trust: z.number().min(-10).max(10).describe('Change in the speaker\'s trust toward the other party, -10..10. Most conversations move this by 0 to 2.'),
    respect: z.number().min(-10).max(10).describe('Change in respect, -10..10.'),
    hostility: z.number().min(-10).max(10).describe('Change in hostility, -10..10. Positive means more hostile.'),
  })
  .describe('How this exchange changed the speaker\'s feelings. Small numbers: a single conversation rarely transforms a relationship.');
export type RelationshipDeltas = z.infer<typeof RelationshipDeltasSchema>;

export const CharacterReplySchema = z
  .object({
    text: z
      .string()
      .min(1)
      .max(1200)
      .describe('What the character says, in their own voice. They argue from the supplied facts, they remember what is in their memories, and they never state a game outcome as though it had already happened.'),
    newCommitment: ConditionalCommitmentSchema.nullable().describe(
      'A structured promise, when the conversation reached something concrete: "below $5.5 billion, or with a larger stock component, I would support it". Null when nothing concrete was agreed — which is most of the time.',
    ),
    relationshipDeltas: RelationshipDeltasSchema,
    memoryToStore: MemoryDraftSchema.nullable().describe('Something the speaker will remember about this exchange, or null when it was unremarkable.'),
  })
  .describe('One reply from a character. The support score, the price and every other number remain engine state: dialogue creates commitments, it does not change reality.');
export type CharacterReply = z.infer<typeof CharacterReplySchema>;

/* -------------------------------------------------------------------------- */
/*  Innovation interpreter                                                     */
/* -------------------------------------------------------------------------- */

export const InnovationInterpreterInputSchema = z
  .object({
    sessionId: z.string().min(1),
    quarter: QuarterIndexSchema,
    companyId: z.string().min(1),
    playerIdea: z.string().min(1).describe('The player\'s idea in their own words.'),
    existingNodes: z
      .array(z.object({ nodeId: z.string(), title: z.string(), status: z.string(), publicConfidence: z.number() }))
      .describe('The current Frontier Map, so the proposal can depend on real nodes and avoid duplicating one that already exists.'),
    companyCapabilities: z.array(z.object({ area: z.string(), strength: z.number() })).describe('What this company can actually do today.'),
    companyResources: z.object({ cashUsd: z.number(), quarterlyRdUsd: z.number(), researchers: z.number(), computeUnits: z.number() }).describe('What this company can actually afford.'),
    worldContext: z.string().describe('Conditions that bear on feasibility: compute supply, energy cost, talent availability, regulation.'),
  })
  .describe('What the Innovation Interpreter sees when a player proposes something the Frontier Map has never contained.');
export type InnovationInterpreterInput = z.infer<typeof InnovationInterpreterInputSchema>;

/** The interpreter's output is `InnovationProposalSchema` (see tech.ts). */
export const InnovationInterpreterOutputSchema = InnovationProposalSchema;
export type InnovationInterpreterOutput = z.infer<typeof InnovationInterpreterOutputSchema>;

/* -------------------------------------------------------------------------- */
/*  Social author                                                              */
/* -------------------------------------------------------------------------- */

export const SocialAuthorInputSchema = z
  .object({
    authorCharacterId: z.string().min(1),
    authorBriefing: z.string().describe('Who is posting: their voice, their standing, their history of public statements.'),
    network: NetworkArchetypeSchema,
    intent: PostIntentSchema,
    situation: z.string().describe('What has just happened that prompts the post.'),
    audienceMix: z.array(z.object({ audience: z.string(), share: z.number() })).describe('Who actually follows this account, so the register matches the room.'),
    constraints: z.array(z.string()).describe('Things that must not be said: undisclosed material information, contract terms under confidentiality, unannounced products.'),
  })
  .describe('What the social author sees. It writes the words; the engine computes reach and every consequence.');
export type SocialAuthorInput = z.infer<typeof SocialAuthorInputSchema>;

/** The social author's output is `SocialPostDraftSchema` (see social.ts). */
export const SocialAuthorOutputSchema = SocialPostDraftSchema;
export type SocialAuthorOutput = z.infer<typeof SocialAuthorOutputSchema>;

/* -------------------------------------------------------------------------- */
/*  Narrator                                                                   */
/* -------------------------------------------------------------------------- */

export const NarratorInputSchema = z
  .object({
    sessionId: z.string().min(1),
    quarter: QuarterIndexSchema,
    committedLines: z
      .array(z.object({ phase: z.string(), text: z.string(), deltaLabel: z.string().nullable() }))
      .describe('Resolution report lines, every one of which already traces to a committed ledger event. These are the only facts available.'),
    focusCompanyId: z.string().nullable().describe('Company to write from the perspective of, or null for a world summary.'),
  })
  .describe('What the narrator sees: committed facts only. It explains what the simulator did; it never decides anything.');
export type NarratorInput = z.infer<typeof NarratorInputSchema>;

export const NarratorOutputSchema = z
  .object({
    headline: z.string().min(3).max(160).describe('One line summarising the quarter.'),
    body: z.string().min(20).max(1500).describe('Two to five short paragraphs explaining what happened and why, using only the supplied facts. Never introduce a number that was not supplied.'),
    tone: z.enum(['triumphant', 'steady', 'strained', 'grim']).describe('Overall register, chosen from what the facts support.'),
  })
  .describe('Narrated colour over committed facts.');
export type NarratorOutput = z.infer<typeof NarratorOutputSchema>;

/* -------------------------------------------------------------------------- */
/*  Validation and logging                                                     */
/* -------------------------------------------------------------------------- */

export const LlmValidationResultSchema = z
  .object({
    ok: z.boolean().describe('Whether the model output parsed against its schema.'),
    schemaName: z.string().describe('Which schema it was checked against, e.g. "GmProposalBatchSchema".'),
    issues: z.array(z.string()).describe('Parse or bounds issues, one per line. Invalid output cannot mutate state under any circumstances.'),
    repaired: z.boolean().describe('True when a retry with error feedback produced a valid result. Recorded because a repaired run is not the same as a clean one.'),
  })
  .describe('The outcome of validating one model response.');
export type LlmValidationResult = z.infer<typeof LlmValidationResultSchema>;

export const AgentRunRecordSchema = z
  .object({
    id: z.string().min(1),
    sessionId: z.string().min(1),
    quarter: QuarterIndexSchema,
    agentRole: AgentRoleSchema,
    agentVersion: z.string().describe('Version of the prompt and tooling for this role, so a behaviour change is attributable.'),
    modelId: z.string().describe('Model identifier used, recorded exactly as it was sent to the provider.'),
    schemaVersion: z.string().describe('Contracts package version the output was validated against.'),
    contextHash: z.string().describe('Hash of the exact input supplied. Two runs with the same context hash and the same model should be comparable.'),
    inputStateVersion: z.string().describe('State hash of the session at the moment the call was made.'),
    structuredOutput: z.unknown().describe('The parsed structured output, stored verbatim. INTERNAL: shape varies by role.'),
    validationResult: LlmValidationResultSchema,
    engineResult: z.unknown().describe('What the engine did with the output after bounds checking: accepted, clamped, or rejected, with detail. Null when the call had no engine consequence.'),
    latencyMs: z.number().min(0).describe('Round-trip latency. Diagnostics only; never an input to the simulation.'),
    tokens: z.object({ input: z.number().int().min(0), output: z.number().int().min(0) }).describe('Token usage for cost tracking.'),
    fallbackUsed: z.boolean().describe('True when the deterministic fallback ran instead of, or after, the model. The game never blocks on a model.'),
    error: z.string().nullable().describe('Error class and message when the call failed, or null.'),
  })
  .describe(
    'A complete, reproducible record of one LLM call. Every important model result is logged this way, which is what makes bugs reproducible and replays honest.',
  );
export type AgentRunRecord = z.infer<typeof AgentRunRecordSchema>;

/* -------------------------------------------------------------------------- */
/*  Fallback behaviour                                                         */
/* -------------------------------------------------------------------------- */

/**
 * What happens when a model is unavailable or returns something invalid twice.
 * An outage is a degraded quarter, never a blocked one.
 */
export const LLM_FALLBACK_STRATEGIES = {
  world_director: 'Apply the candidate skeletons using their event family template modifiers at the drawn severity. The quarter still has weather; it just has less character.',
  chief_of_staff: 'Fall back to the normal controls. The player submits through the interface; nothing is auto-interpreted.',
  npc_strategist: 'Run the deterministic archetype policy for that company\'s posture, the same policy background-tier companies always use.',
  character_dialogue: 'Return a short templated reply consistent with the character\'s traits and relationship, and store no commitment. Commitments are never fabricated by a fallback.',
  innovation_interpreter: 'Decline the proposal with an explanation and leave the Frontier Map unchanged. A node is never added without interpretation.',
  social_author: 'Publish nothing. Structured marketing campaigns still run; personal posting is simply unavailable that quarter.',
  narrator: 'Render the resolution report lines directly. They are already human-readable by construction.',
} as const satisfies Record<AgentRole, string>;

export const LlmFallbackRecordSchema = z
  .object({
    sessionId: z.string().min(1),
    quarter: QuarterIndexSchema,
    agentRole: AgentRoleSchema,
    reason: z.enum(['timeout', 'rate_limited', 'invalid_output', 'api_error', 'disabled']).describe('Why the fallback ran.'),
    strategyApplied: z.string().describe('Which deterministic behaviour was used instead.'),
  })
  .describe('A recorded fallback. Sessions remain deterministic and playable through a model outage.');
export type LlmFallbackRecord = z.infer<typeof LlmFallbackRecordSchema>;

/* -------------------------------------------------------------------------- */
/*  Role to schema map                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Which output schema each role must validate against. The LLM gateway uses
 * this so a role can never be wired to the wrong schema by accident.
 */
export const AGENT_OUTPUT_SCHEMA_NAMES = {
  world_director: 'GmProposalBatchSchema',
  chief_of_staff: 'ChiefOfStaffInterpretationSchema',
  npc_strategist: 'NpcActionBundleSchema',
  character_dialogue: 'CharacterReplySchema',
  innovation_interpreter: 'InnovationProposalSchema',
  social_author: 'SocialPostDraftSchema',
  narrator: 'NarratorOutputSchema',
} as const satisfies Record<AgentRole, string>;
