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
import { QuarterIndexSchema, bipolarUnit, intCount, score100, signedUsd, unitInterval, usd } from './ids';
import { WorldVariableReadingSchema } from './world';
import { ImpactBudgetSchema } from './modifiers';
import { GmEventProposalSchema, GmProposalBatchSchema } from './events';
import { WorldEventCandidateSchema } from './engine';
import { ActionIntentSchema, ActionTypeSchema } from './actions';
import { ConditionalCommitmentSchema } from './governance';
import { CharacterBeliefSchema, CharacterRoleSchema, CharacterSchema, MemoryDraftSchema, MemoryKindSchema, MemorySchema, RelationshipSchema, StableTraitsSchema } from './people';
import { InnovationProposalSchema } from './tech';
import { NetworkArchetypeSchema, PostIntentSchema, SocialPostDraftSchema } from './social';
import { CompBandSchema, CompanyPostureSchema, FinancialQuarterSchema, ProductSegmentSchema, StaffRoleSchema, StrategistMemorySchema } from './company';

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

/**
 * STAGE 5 — the group, consolidated: every company this seat directs, not
 * only the one the dossier is otherwise built for. `companyCount` is 1 for a
 * seat that controls nothing beyond its founding company (world 1 always,
 * and most of world 2), which is how a required, non-optional field states
 * "there is no group" rather than omitting itself.
 */
export const CosGroupSchema = z
  .object({
    companyCount: z.number().int().min(1).describe('How many companies this seat directs, founding company included. 1 means there is nothing to consolidate.'),
    revenueUsd: z.number().describe('Consolidated revenue, last filed quarter, summed across every controlled company.'),
    netIncomeUsd: z.number().describe('Consolidated net income, last filed quarter.'),
    cashUsd: z.number().describe('Consolidated cash on hand right now.'),
    debtUsd: z.number().describe('Consolidated debt outstanding.'),
    headcount: z.number().int().min(0).describe('Combined headcount across every controlled company.'),
    marketValueUsd: z.number().min(0).describe('Consolidated enterprise value: the founding company plus its ownership share of every subsidiary.'),
  })
  .describe('The group\'s own consolidated accounts, from groupStatementOf. Ordinary sales between companies in the group are real, priced transactions and stay in these numbers.');
export type CosGroup = z.infer<typeof CosGroupSchema>;

export const CosProductLineSchema = z
  .object({
    productId: z.string().min(1),
    name: z.string().min(1).max(80),
    segment: ProductSegmentSchema,
    categoryId: z.string().min(1).describe('What this line sells: a node id (ECONOMIC_NODES) in the node economy, an industry line (PRODUCT_CATEGORIES) before it. Never absent.'),
    unitLabel: z.string().min(1).describe('What one unit of this line is, e.g. "wafer", "MWh", "seat" — the node\'s own unitLabel, never the buyer segment\'s.'),
    pricePerSeatUsd: z.number().describe('Current list price per unit per quarter.'),
    activeCustomers: z.number().int().min(0),
    grossMarginPct: unitInterval('Gross margin on this line.'),
    churnQuarterly: unitInterval('Fraction of customers lost last quarter.'),
    qualityScore: unitInterval('How good it is relative to the market frontier.'),
    revenueQuarterlyUsd: z.number().describe('Price times customers: what the line brings in per quarter.'),
    isActive: z.boolean().describe('False once the line has been sunset.'),
    unitCostUsd: usd('What one unit costs to make, from the cost roll-up — the same number cost of goods books. 0 outside the node economy, where cost is not held per unit.'),
    marketPriceUsd: usd('The node\'s one settled market price this quarter. A price is judged against this, never against a segment average. 0 outside the node economy.'),
    unitsSoldQuarterly: intCount('Units sold last quarter. Equal to activeCustomers on every node line by construction.'),
    backlogUnits: intCount('Ordered and not yet shipped. 0 for anything but a unit-sale line.'),
    installedBase: intCount('Durable units still in service, which retire into next quarter\'s replacement demand. 0 for anything but a unit-sale line.'),
    ownsNode: z.boolean().describe('Whether the company owns or licences the node it is producing. False outside the node economy.'),
    // World 3's composition, as words. Both are plain strings bounded like
    // every lookup text field rather than `lookupText`, which is declared
    // further down this module and cannot be referenced here.
    targetIndustry: z
      .string()
      .max(200)
      .describe('The industry this line is aimed at, e.g. "logistics", paired with `segment` as the customer type. "" outside the node economy.'),
    composition: z
      .string()
      .max(200)
      .describe(
        'The line described from the founder\'s seat, e.g. "your AI software suite on Basalt\'s inference API with an agent harness from the open market, aimed at logistics enterprises". Names the two slots carrying most of the unit cost and their sources. "" outside the node economy.',
      ),
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
    ownedNodeCount: intCount('How many nodes the company owns or licences outright: everything it is entitled to produce. 0 outside the node economy.'),
    dataPetabytes: intCount('Customer data held, in petabytes, across every sector. Improves quality and feeds any line with a dataset slot.'),
    dataPolicy: z.string().min(1).describe('How much is collected from customers: "minimal", "standard" or "aggressive". Aggressive buys data and costs churn and reputation.'),
  })
  .describe('What the company sells, what it is entitled to make, and the capacity and data it sells on.');
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

export const CosNewEntrantSchema = z
  .object({
    companyId: z.string().min(1),
    name: z.string().min(1).max(80),
    sectorId: z.string().min(1),
    region: z.string().min(1).max(40),
    foundedQuarter: QuarterIndexSchema,
    seedCapitalUsd: z.number().describe('The founding cheque, which is public: a founding is announced.'),
    inYourRegion: z.boolean().describe('Whether the newcomer set up where this company competes.'),
    replacesName: z.string().max(80).nullable().describe('The company whose failure left the gap, or null when it is not on the public record.'),
  })
  .describe('A company founded since last quarter, into the gap a wound-up company left.');
export type CosNewEntrant = z.infer<typeof CosNewEntrantSchema>;

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
    newEntrants: z
      .array(CosNewEntrantSchema)
      .max(4)
      .default([])
      .describe('Companies founded since last quarter. A newcomer in your sector and region is a competitor you did not have.'),
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
    group: CosGroupSchema,
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

/* -------------------------------------------------------------------------- */
/*  The lookup catalogue                                                       */
/* -------------------------------------------------------------------------- */

/**
 * What the Chief of Staff may go and look up before it answers.
 *
 * The dossier is a snapshot of the founder's own company. "Buy a small data
 * centre" is not answerable from a snapshot: it needs the market — who sells
 * capacity, at what price, with how much to spare, and what the purchase does to
 * the balance. So the role gets one bounded round of sourcing.
 *
 * Three rules make that safe:
 *
 * - **The model asks; the client answers.** A `LookupRequest` names a question
 *   from a fixed catalogue. It is run by `runLookups` in `@frontier/simulation`
 *   against canonical state, on the client that holds it, and the answers come
 *   back as data. The model never reads state and never queries anything.
 * - **One round.** At most `MAX_LOOKUPS_PER_TURN` requests, at most
 *   `MAX_LOOKUP_ROWS` rows per result, and a second research turn is refused.
 *   A loop that can spin is a loop that will, on somebody else's subscription.
 * - **Every figure is whole and every row names its ids.** A row the model can
 *   quote is a row the founder can approve: each carries the identifiers the
 *   action would name, and several carry the exact intent the validator accepts.
 *
 * Since the solvency stage, "can we afford it" is not a gate. Rows say what the
 * cash balance would be afterwards and what the solvency clock reads; the role
 * is required to repeat both honestly rather than to refuse.
 */

/** Requests one turn may carry. */
export const MAX_LOOKUPS_PER_TURN = 4;
/** Rows one result may carry. */
export const MAX_LOOKUP_ROWS = 12;
/** Characters any free-text field of a lookup may carry. */
export const LOOKUP_TEXT_MAX = 200;

export const LOOKUP_KINDS = [
  'compute_market',
  'acquisition_targets',
  'debt_headroom',
  'government_programmes',
  'hiring_market',
  'own_position',
  // Appended for the product screens (stage 3) — enum growth stays at the end.
  'launchable_lines',
  'suppliers',
  'customers',
  // Appended for the node economy: "what does this cost me to build?" and
  // "what do I need to research to enter robotics?" — the two questions the
  // world-3 screens answer that the world-2 catalogue had no vocabulary for.
  'unit_cost',
  'entry_path',
  // Appended for the composed line: "what could go in this slot, from whom,
  // at what price and quality" — every node a slot admits and every source
  // for each, each row carrying the fill_slot intent that puts it there.
  'slot_candidates',
] as const;
export type LookupKind = (typeof LOOKUP_KINDS)[number];

export const LookupKindSchema = z.enum(LOOKUP_KINDS).describe('One question from the catalogue, named rather than carried.');

const lookupText = (description: string) => z.string().max(LOOKUP_TEXT_MAX).describe(description);

/* --- requests ------------------------------------------------------------- */

export const LookupRequestSchema = z
  .discriminatedUnion('kind', [
    z
      .object({
        kind: z.literal('compute_market'),
        units: intCount('How many accelerator-equivalents the founder is asking about. The three quarterly costs are quoted for this many. Use 0 when they named no size.'),
      })
      .describe('Who sells compute, at what price, with what to spare, and what N units cost owned against reserved against cloud.'),

    z
      .object({
        kind: z.literal('acquisition_targets'),
        sector: lookupText('Sector to restrict to, or "" for any.'),
        region: lookupText('Region to restrict to, or "" for any.'),
        maxValueUsd: usd('Ceiling on the indicative price. 0 means no ceiling.'),
        keyword: lookupText('Word to match against company names, or "" for any.'),
      })
      .describe('Companies with a public position that this company could bid for, with an indicative price and the cash left afterwards.'),

    z
      .object({ kind: z.literal('debt_headroom') })
      .describe('What could be borrowed, at what indicative coupon, what last quarter\'s operating income would service, and who has an open sheet.'),

    z
      .object({ kind: z.literal('government_programmes') })
      .describe('Procurement this seat can see, with the requirements met and unmet.'),

    z
      .object({
        kind: z.literal('hiring_market'),
        role: StaffRoleSchema.nullable().describe('One role, or null for every role.'),
      })
      .describe('Fill rate, the quarterly cost of one hire by role and band, and what is already open.'),

    z
      .object({ kind: z.literal('own_position') })
      .describe('Cash, runway, burn, the solvency clock and the last four filed quarters.'),

    z
      .object({ kind: z.literal('launchable_lines') })
      .describe('Product lines in this company\'s own industry: which are open to launch right now, and which are waiting on a Frontier Map node.'),

    z
      .object({
        kind: z.literal('suppliers'),
        inputCategoryId: z.string().min(1).describe('The upstream product category (PRODUCT_CATEGORIES) to find a supplier for.'),
        productId: z
          .string()
          .min(1)
          .nullable()
          .describe('Our own product this input feeds, so the row\'s action can name it directly, or null to browse without one.'),
      })
      .describe('Companies whose published terms would sell us this input right now, best quality per dollar first.'),

    z
      .object({
        kind: z.literal('customers'),
        productId: z.string().min(1).describe('Our own product, published as a supply line, to find who is building on it.'),
      })
      .describe('Companies currently building on one of our own published lines, and what that is worth to us.'),

    z
      .object({
        kind: z.literal('unit_cost'),
        nodeId: z.string().min(1).describe('The node to cost, an id into ECONOMIC_NODES, e.g. "sys_ai_accelerator". Works for a node we already make and for one we are only considering.'),
      })
      .describe('What one unit of a node would cost this company to make: every input and conversion line, biggest first, and where each comes from.'),

    z
      .object({
        kind: z.literal('entry_path'),
        sector: lookupText('The sector to enter, e.g. "robotics", or "" to ask about one node instead.'),
        nodeId: lookupText('One node to reach, an id into ECONOMIC_NODES, or "" to ask about a whole sector.'),
      })
      .describe('What this company would have to own before it could make anything in a sector, and the three ways to get each piece: research it, licence it, or buy the output.'),

    z
      .object({
        kind: z.literal('slot_candidates'),
        productId: z
          .string()
          .min(1)
          .nullable()
          .describe('Our own line on the node, so each row\'s fill_slot intent can name it, or null to browse a node we do not sell yet.'),
        nodeId: z.string().min(1).describe('The node whose slot is being filled, an id into ECONOMIC_NODES — the dossier\'s own lines carry theirs as `categoryId`.'),
        slotId: z.string().min(1).describe('The slot on that node, e.g. "model", "harness", "battery".'),
      })
      .describe('Every node that could fill one slot of a line and every source for each — our own line, each open seller, the open market — with price and quality, each row carrying the exact fill_slot intent.'),
  ])
  .describe('One question the Chief of Staff wants answered from canonical state before it replies.');
export type LookupRequest = z.infer<typeof LookupRequestSchema>;

/* --- shared rows ---------------------------------------------------------- */

export const COMPUTE_OFFERINGS = ['accelerators', 'reservation', 'cloud'] as const;
export const ComputeOfferingSchema = z
  .enum(COMPUTE_OFFERINGS)
  .describe('What a seller is selling: accelerators bought outright, capacity reserved by the quarter, or on-demand cloud.');
export type ComputeOffering = z.infer<typeof ComputeOfferingSchema>;

export const ComputeSellerRowSchema = z
  .object({
    companyId: z.string().min(1).describe('The seller. Name it verbatim in the action.'),
    name: lookupText('The seller\'s name, for the founder.'),
    offering: ComputeOfferingSchema,
    sectorId: lookupText('The seller\'s sector.'),
    region: lookupText('Where the capacity sits. Energy is priced locally, which is most of why sellers differ.'),
    unitPriceUsd: usd('Price of one unit: the purchase price for accelerators, the price per unit per quarter for a reservation or cloud.'),
    sellableUnits: intCount('Units this seller could sell this quarter, beyond what it needs itself. The validator clamps to exactly this.'),
    quarterlyCostPerUnitUsd: usd('What one unit costs per quarter once held: depreciation for an owned accelerator, rent for a reservation or cloud unit.'),
    energyFactorPct: intCount('The seller\'s regional energy cost as a percentage of the world index. 100 is the index itself.'),
    utilisationPct: intCount('How hard the seller is already working its own fleet, as a percentage.'),
    intent: ActionIntentSchema.nullable().describe('The action that buys from this seller at the size asked about, exactly as the validator would accept it, or null when nothing legal fits.'),
  })
  .describe('One named counterparty selling compute, with the price its own region and utilisation produce.');
export type ComputeSellerRow = z.infer<typeof ComputeSellerRowSchema>;

export const AcquisitionTargetRowSchema = z
  .object({
    companyId: z.string().min(1),
    name: lookupText('The company\'s name.'),
    sectorId: lookupText('Its sector.'),
    region: lookupText('Its region.'),
    listed: z.boolean().describe('Whether it is publicly traded. A listed company has a quote; a private one has an anchor.'),
    ticker: lookupText('Its ticker, or "" when private.'),
    lastPublicRevenueUsd: signedUsd('Last revenue it disclosed publicly. 0 when it has disclosed none.'),
    headcountBand: lookupText('Headcount as a band, e.g. "50-200". Exact headcount is not public.'),
    ownedAccelerators: intCount('Accelerators it owns, as far as the public record shows.'),
    indicativePriceUsd: usd('What an offer would plausibly have to clear, from the quote or the valuation anchor.'),
    cashAfterUsd: signedUsd('Where this company\'s cash balance lands if that price is paid. May be negative: cash does not refuse an instruction.'),
    solvencyLine: lookupText('The solvency clock after the deal, or "" when the balance stays at or above zero.'),
    intent: ActionIntentSchema.describe('The exact acquire_company intent the validator would accept for this target.'),
  })
  .describe('One company that could be bought, priced, with the consequence for the balance stated.');
export type AcquisitionTargetRow = z.infer<typeof AcquisitionTargetRowSchema>;

export const CapitalDeskRowSchema = z
  .object({
    entityId: z.string().min(1),
    name: lookupText('The desk\'s name.'),
    kind: lookupText('What kind of desk it is: a venture fund, a buyout firm, a lender.'),
    dryPowderUsd: usd('Uncommitted capital it holds.'),
    holdsStakePct: intCount('How much of this company it already holds, as a percentage.'),
    thesis: lookupText('What it says it is looking for.'),
  })
  .describe('One capital desk with an open sheet.');
export type CapitalDeskRow = z.infer<typeof CapitalDeskRowSchema>;

export const ProgrammeRowSchema = z
  .object({
    opportunityId: z.string().min(1),
    programme: lookupText('The programme\'s name.'),
    agencyName: lookupText('The agency running it.'),
    maxValueUsd: usd('The ceiling on the award.'),
    closeQuarter: QuarterIndexSchema.describe('Quarter bidding closes.'),
    requirementsMet: z.array(lookupText('A requirement this company already meets.')).max(8),
    requirementsUnmet: z.array(lookupText('A requirement this company does not meet.')).max(8),
    intent: ActionIntentSchema.nullable().describe('A bid the validator would accept, or null when a requirement blocks it.'),
  })
  .describe('One open procurement opportunity, with the requirements scored against this company.');
export type ProgrammeRow = z.infer<typeof ProgrammeRowSchema>;

export const HiringRowSchema = z
  .object({
    role: StaffRoleSchema,
    band: CompBandSchema,
    quarterlyCostUsd: usd('Fully loaded cost of one hire in this role at this band, per quarter.'),
    annualCostUsd: usd('The same figure over four quarters.'),
    intent: ActionIntentSchema.nullable().describe('A hire the validator would accept at this role and band, or null.'),
  })
  .describe('What one person in one role at one band costs.');
export type HiringRow = z.infer<typeof HiringRowSchema>;

export const StatementRowSchema = z
  .object({
    quarter: QuarterIndexSchema,
    revenueUsd: signedUsd('Revenue that quarter.'),
    netIncomeUsd: signedUsd('Net income that quarter.'),
    cashUsd: signedUsd('Closing cash that quarter. May be negative.'),
    headcount: intCount('Headcount at the close.'),
  })
  .describe('One filed quarter, as the company filed it.');
export type StatementRow = z.infer<typeof StatementRowSchema>;

export const LaunchableLineRowSchema = z
  .object({
    categoryId: z.string().min(1).describe('Id into PRODUCT_CATEGORIES.'),
    label: lookupText('The line\'s name, e.g. "Frontier models / LLM".'),
    sectorId: lookupText('The sector this line belongs to.'),
    unitLabel: lookupText('What one unit of this line is, e.g. "seat", "1M tokens", "MWh".'),
    referencePriceUsd: usd('Reference price per unit per quarter, before this company has set one of its own.'),
    locked: z.boolean().describe('True when a Frontier Map node stands between this company and this line.'),
    missingNodeTitles: z.array(lookupText('A node title still missing.')).max(4),
    intent: ActionIntentSchema.nullable().describe('A launch_product intent the validator would accept into this line at its reference price, or null while locked.'),
  })
  .describe('One product line this company could consider: open now, or gated on research.');
export type LaunchableLineRow = z.infer<typeof LaunchableLineRowSchema>;

export const SupplierOfferRowSchema = z
  .object({
    companyId: z.string().min(1).describe('The supplier. Name it verbatim in the action.'),
    name: lookupText('The supplier\'s name.'),
    productId: z.string().min(1).describe('The specific supplying product.'),
    productName: lookupText('The supplying product\'s name.'),
    pricePerUnitUsd: usd('Its published price per unit.'),
    qualityScorePct: intCount('Its quality out of 100.'),
    isDirectRival: z.boolean().describe('True when we already sell into the same line ourselves.'),
    intent: ActionIntentSchema.nullable().describe('The intent that would build the named product on this one — fill_slot in the node economy, choose_supplier before it — or null when no product was named.'),
  })
  .describe('One company that would currently sell us this input, best quality per dollar first.');
export type SupplierOfferRow = z.infer<typeof SupplierOfferRowSchema>;

export const SupplyCustomerRowSchema = z
  .object({
    buyerCompanyId: z.string().min(1),
    buyerName: lookupText('The buyer\'s name.'),
    buyerProductName: lookupText('The buyer\'s product built on us.'),
    unitsFilled: intCount('Units it drew from us this quarter.'),
    revenueUsd: usd('What it paid us this quarter.'),
  })
  .describe('One company currently building on our published line.');
export type SupplyCustomerRow = z.infer<typeof SupplyCustomerRowSchema>;

/* --- results -------------------------------------------------------------- */

export const UnitCostRowSchema = z
  .object({
    key: z.string().min(1).describe('The row\'s stable key: an input node id, or one of "power", "labour", "capacity", "support", or a licence key.'),
    label: lookupText('What the row is called, e.g. "Wafer, 300mm" or "Power".'),
    amountUsd: usd('What this row contributes to one unit\'s cost.'),
    sharePct: intCount('That amount as a whole percentage of the unit cost.'),
    sourceKind: z.enum(['make', 'buy', 'market', 'conversion']).describe('Where it comes from: our own line, a named seller, the open market, or conversion (power, labour, capacity, support, licence).'),
    sourceName: lookupText('The counterparty\'s name when there is one, or "".'),
    slotId: lookupText('The slot this row fills, e.g. "model", or "" on a conversion row (power, labour, capacity, support, licence).'),
    nodeId: lookupText('The node in that slot, an id into ECONOMIC_NODES, or "" on a conversion row or an empty slot.'),
  })
  .describe('One line of a unit-cost roll-up. The rows sum to the unit cost exactly; there is no second calculation.');
export type UnitCostRow = z.infer<typeof UnitCostRowSchema>;

export const SlotCandidateRowSchema = z
  .object({
    nodeId: z.string().min(1).describe('The node that would sit in the slot, an id into ECONOMIC_NODES. Name it verbatim in the action.'),
    label: lookupText('Its name, e.g. "Frontier model".'),
    tier: intCount('Its tier, 0 (a raw resource) to 7 (an operation).'),
    sourceKind: z.enum(['make', 'buy', 'market']).describe('Where it would come from: our own line, a named seller\'s published line, or the open market.'),
    sellerCompanyId: lookupText('The seller for "buy", our own id for "make", or "" for the open market.'),
    sellerName: lookupText('The seller\'s name for "buy", "" otherwise.'),
    unitPriceUsd: usd('What one unit costs by this route: our own unit cost, the seller\'s ask at their cost base, or the market price plus the spot premium.'),
    qualityScorePct: intCount('The quality that flows through with it, out of 100. The open market delivers the middle of the band.'),
    blocked: z.boolean().describe('True when putting this node in the slot would stop the line shipping: a blocking slot, and nobody in the world owns the node.'),
    intent: ActionIntentSchema.nullable().describe('The fill_slot intent that puts this node from this source in the slot, or null when no product was named or the route would block the line.'),
  })
  .describe('One way of filling one slot: a node and a source, priced exactly as the cost roll-up would price it.');
export type SlotCandidateRow = z.infer<typeof SlotCandidateRowSchema>;

export const EntryStepRowSchema = z
  .object({
    nodeId: z.string().min(1).describe('The node that has to be owned, an id into ECONOMIC_NODES.'),
    label: lookupText('Its name.'),
    tier: intCount('Its tier, 0 (a raw resource) to 7 (an operation).'),
    researchable: z.boolean().describe('Whether a research programme can reach it at all.'),
    researchLowUsd: usd('Low end of the table\'s estimate for a programme against it.'),
    researchHighUsd: usd('High end of the same estimate.'),
    licensorName: lookupText('The cheapest owner currently licensing it, or "" when nobody is.'),
    licensorRoyaltyPct: intCount('That owner\'s royalty as a whole percentage of revenue. 0 when nobody licenses it.'),
    sellerName: lookupText('A company that would sell us the finished output instead, or "".'),
    sellerAskUsd: usd('What that seller asks per unit. 0 when nobody sells it.'),
    intent: ActionIntentSchema.nullable().describe('A start_research intent the validator would accept against this node right now, or null when something else has to happen first.'),
  })
  .describe('One thing standing between this company and a sector, with all three ways through it priced.');
export type EntryStepRow = z.infer<typeof EntryStepRowSchema>;

export const LookupResultSchema = z
  .discriminatedUnion('kind', [
    z
      .object({
        kind: z.literal('compute_market'),
        summary: lookupText('One sentence stating the finding.'),
        units: intCount('The size the three costs below are quoted for.'),
        ownedUnits: intCount('Accelerators this company owns today.'),
        reservedUnits: intCount('Accelerator-equivalents it holds under reservation today.'),
        cloudUnits: intCount('Accelerator-equivalents its cloud spend buys today.'),
        heldUnits: intCount('Everything it holds today.'),
        ownedQuarterlyCostUsd: usd('What owning `units` accelerators costs per quarter: depreciation and energy, no rent.'),
        reservedQuarterlyCostUsd: usd('What reserving `units` accelerator-equivalents costs per quarter.'),
        cloudQuarterlyCostUsd: usd('What buying `units` accelerator-equivalents of cloud costs per quarter.'),
        purchaseCostUsd: usd('Cash to buy `units` accelerators outright at the cheapest seller.'),
        cashUsd: signedUsd('Cash on hand now.'),
        cashAfterPurchaseUsd: signedUsd('Where cash lands if that purchase is made. May be negative.'),
        solvencyLine: lookupText('The solvency clock after that purchase, or "" when the balance stays at or above zero.'),
        sellers: z.array(ComputeSellerRowSchema).max(MAX_LOOKUP_ROWS),
      })
      .describe('The compute market: what we hold, what N units cost three ways, and every named seller with capacity.'),

    z
      .object({
        kind: z.literal('acquisition_targets'),
        summary: lookupText('One sentence stating the finding.'),
        cashUsd: signedUsd('Cash on hand now.'),
        rows: z.array(AcquisitionTargetRowSchema).max(MAX_LOOKUP_ROWS),
      })
      .describe('Companies this company could bid for under the filter asked about.'),

    z
      .object({
        kind: z.literal('debt_headroom'),
        summary: lookupText('One sentence stating the finding.'),
        available: z.boolean().describe('Whether the validator would accept an issue at all today.'),
        reason: lookupText('Why not, in the validator\'s own words, or "" when it would.'),
        headroomUsd: usd('The most that could be issued.'),
        indicativeCouponPct: intCount('Indicative annual coupon as a whole percentage, from the world\'s capital markets.'),
        servisableUsd: usd('What last quarter\'s operating income would service at that coupon.'),
        lastOperatingIncomeUsd: signedUsd('Last quarter\'s operating income.'),
        desks: z.array(CapitalDeskRowSchema).max(MAX_LOOKUP_ROWS),
        intent: ActionIntentSchema.nullable().describe('An issue at the headroom the validator would accept, or null.'),
      })
      .describe('What this company could borrow, and from whom.'),

    z
      .object({
        kind: z.literal('government_programmes'),
        summary: lookupText('One sentence stating the finding.'),
        pastPerformance: intCount('Past-performance score out of 100.'),
        rows: z.array(ProgrammeRowSchema).max(MAX_LOOKUP_ROWS),
      })
      .describe('Procurement open to this seat.'),

    z
      .object({
        kind: z.literal('hiring_market'),
        summary: lookupText('One sentence stating the finding.'),
        fillRatePct: intCount('Share of an opened role the market would fill this quarter, as a percentage.'),
        openRoles: intCount('Roles already open and unfilled.'),
        rows: z.array(HiringRowSchema).max(MAX_LOOKUP_ROWS),
      })
      .describe('What hiring costs and how much of it the market would actually fill.'),

    z
      .object({
        kind: z.literal('own_position'),
        summary: lookupText('One sentence stating the finding.'),
        cashUsd: signedUsd('Cash on hand.'),
        quarterlyBurnUsd: signedUsd('Net cash movement per quarter. Negative is cash leaving.'),
        runwayQuarters: intCount('Quarters of runway at that rate.'),
        negativeCashQuarters: intCount('Consecutive filed quarters closed below zero.'),
        solvencyQuartersAllowed: intCount('How many such quarters end the company.'),
        statements: z.array(StatementRowSchema).max(4),
      })
      .describe('The company\'s own position, from the filed statements.'),

    z
      .object({
        kind: z.literal('launchable_lines'),
        summary: lookupText('One sentence stating the finding.'),
        rows: z.array(LaunchableLineRowSchema).max(MAX_LOOKUP_ROWS),
      })
      .describe('Product lines in this company\'s own industry, open now or gated on research.'),

    z
      .object({
        kind: z.literal('suppliers'),
        summary: lookupText('One sentence stating the finding.'),
        inputCategoryId: z.string().min(1),
        rows: z.array(SupplierOfferRowSchema).max(MAX_LOOKUP_ROWS),
      })
      .describe('Every company whose published terms would sell us this input right now.'),

    z
      .object({
        kind: z.literal('customers'),
        summary: lookupText('One sentence stating the finding.'),
        productId: z.string().min(1),
        rows: z.array(SupplyCustomerRowSchema).max(MAX_LOOKUP_ROWS),
      })
      .describe('Every company currently building on one of our own published lines.'),

    z
      .object({
        kind: z.literal('unit_cost'),
        summary: lookupText('One sentence stating the finding, naming the biggest line.'),
        nodeId: z.string().min(1),
        label: lookupText('The node\'s name.'),
        unitLabel: lookupText('What one unit of it is, e.g. "wafer", "MWh", "rack".'),
        unitCostUsd: usd('What one unit costs this company to make, at today\'s input prices.'),
        marketPriceUsd: usd('The node\'s one settled market price this quarter.'),
        grossMarginPct: intCount('The whole-percent gross margin selling at the market price would leave. 0 when the market price is 0.'),
        madeInHouseSharePct: intCount('Whole percent of the input bill this company makes rather than buys.'),
        blockedInputs: z.array(lookupText('An input nobody in the world owns, so the line would ship nothing.')).max(8),
        rows: z.array(UnitCostRowSchema).max(MAX_LOOKUP_ROWS),
      })
      .describe('What one unit of a node costs this company to make, itemised. This is the number cost of goods books.'),

    z
      .object({
        kind: z.literal('entry_path'),
        summary: lookupText('One sentence stating the finding.'),
        sector: lookupText('The sector asked about, or "".'),
        nodeId: lookupText('The node asked about, or "".'),
        alreadyIn: z.boolean().describe('True when this company can already make something there.'),
        rows: z.array(EntryStepRowSchema).max(MAX_LOOKUP_ROWS),
      })
      .describe('What this company would have to own to enter a sector, and how to get each piece.'),

    z
      .object({
        kind: z.literal('slot_candidates'),
        summary: lookupText('One sentence stating the finding: how many ways the slot could be filled, the best on quality per dollar, and what fills it today.'),
        nodeId: lookupText('The node asked about.'),
        slotId: lookupText('The slot asked about, or "" when the node has no such slot.'),
        slotLabel: lookupText('The slot\'s label on the canvas, e.g. "Model".'),
        productId: lookupText('Our own line the rows\' intents name, or "" when none was named.'),
        rows: z.array(SlotCandidateRowSchema).max(MAX_LOOKUP_ROWS),
      })
      .describe('Every node that could fill one slot and every source for each, priced as the roll-up would price them.'),
  ])
  .describe('The answer to one lookup, read off canonical state by the engine. Every figure is a whole number of dollars or units.');
export type LookupResult = z.infer<typeof LookupResultSchema>;

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
    /**
     * The answers to the lookups the previous turn asked for.
     *
     * Present only on the second turn of a sourcing round, and its presence is
     * what forbids a third: a composer handed findings tells the model that
     * research mode is closed, and the route refuses another round outright.
     */
    findings: z
      .array(LookupResultSchema)
      .max(MAX_LOOKUPS_PER_TURN)
      .optional()
      .describe('What the requested lookups returned, run against canonical state by the client. Absent on the first turn of a message.'),
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

// Appended, never inserted: COS_MODES backs a zod enum and a stored transcript.
export const COS_MODES = ['answer', 'plan', 'act', 'research'] as const;
export const CosModeSchema = z
  .enum(COS_MODES)
  .describe(
    '"answer" — the founder asked a question and wants words back; interpretedInstructions is empty. "plan" — a course of action is proposed for discussion, with the actions attached. "act" — the founder gave an instruction and these are the typed actions that carry it out. "research" — you cannot answer from the dossier alone and are asking for lookups first; `lookups` carries them, `interpretedInstructions` MUST be empty, and this mode is available only on a turn that arrived without findings.',
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
    /**
     * Only meaningful in `research` mode, and empty in every other. Required
     * rather than optional because this schema is handed to structured outputs,
     * where every key must be emitted; an empty array is how a reply that needs
     * no sourcing says so.
     */
    lookups: z
      .array(LookupRequestSchema)
      .max(MAX_LOOKUPS_PER_TURN)
      .describe('Questions to run against canonical state before answering. Read only in `research` mode, at most four, and never on a turn that already carried findings. Empty in every other mode.'),
  })
  .describe(
    'The Chief of Staff\'s answer to one message. It is a proposal: the player approves or edits it, and only then is anything submitted.',
  );
export type ChiefOfStaffInterpretation = z.infer<typeof ChiefOfStaffInterpretationSchema>;

/* -------------------------------------------------------------------------- */
/*  NPC strategist                                                             */
/* -------------------------------------------------------------------------- */

/*
 * Bounds on everything the strategist prompt carries about a person.
 *
 * They exist so the prompt is the same size in quarter 40 as in quarter 1. A
 * chief executive holds at most this many remembered slights and this many
 * live relationships in front of them when they plan; the projection builder
 * keeps the strongest and drops the rest.
 */

/** Beliefs shown per persona. The topic list itself is twelve long. */
export const MAX_STRATEGIST_BELIEFS = 12;

/** Counterparties a strategist is shown feelings about. */
export const MAX_STRATEGIST_RELATIONSHIPS = 8;

/** Memories a strategist is shown, strongest first. */
export const MAX_STRATEGIST_MEMORIES = 10;

/** Lines in the since-last-quarter delta. */
export const MAX_STRATEGIST_CHANGES = 24;

/** Characters in one delta line. */
export const MAX_STRATEGIST_CHANGE_CHARS = 240;

/**
 * Who is running the company.
 *
 * A rival that behaves like every other rival is a rival with no chief
 * executive in its prompt. The character already exists in canonical state with
 * traits, beliefs, a role and a title; this is that character projected for the
 * strategist, and it is the reason two companies in identical positions choose
 * differently.
 */
export const NpcPersonaSchema = z
  .object({
    characterId: z.string().min(1).describe('The chief executive\'s character id.'),
    name: z.string().min(1).max(80).describe('Their name, as the world knows it. The prompt is written in their voice.'),
    title: z.string().max(80).describe('Their stated title, or empty when they have none.'),
    role: CharacterRoleSchema,
    traits: StableTraitsSchema.describe('The five stable traits, 0-100. These decide what kind of move this executive reaches for first.'),
    beliefs: z.array(CharacterBeliefSchema).max(MAX_STRATEGIST_BELIEFS).describe('What they currently think is true about the world.'),
  })
  .describe('The chief executive behind the company, projected from canonical character state. Never invented, never model-authored.');
export type NpcPersona = z.infer<typeof NpcPersonaSchema>;

/** How this company's chief executive regards one counterparty. Own feelings only. */
export const NpcRelationshipViewSchema = z
  .object({
    counterpartyId: z.string().min(1).describe('The company the feeling is about — the player\'s company included.'),
    counterpartyName: z.string().min(1).max(120),
    isPlayerCompany: z.boolean().describe('True when this counterparty is a company a session participant controls.'),
    trust: score100('Belief that they keep their word.'),
    respect: score100('Regard for their competence.'),
    hostility: score100('Active antagonism.'),
  })
  .describe('One directional relationship, held BY this company\'s chief executive. How anybody else feels is not knowable and is never included.');
export type NpcRelationshipView = z.infer<typeof NpcRelationshipViewSchema>;

/** One thing this company's chief executive remembers, projected for the prompt. */
export const NpcMemoryViewSchema = z
  .object({
    quarter: QuarterIndexSchema,
    kind: MemoryKindSchema,
    aboutId: z.string().min(1).describe('Who or what it is about: a character id or a company id.'),
    aboutName: z.string().min(1).max(120).describe('That party\'s name, so the prompt reads as a person recalling a person.'),
    summary: z.string().min(1).max(300).describe('The memory in the rememberer\'s own framing.'),
    sentiment: bipolarUnit('How they feel about it, -1 bitter to +1 grateful.'),
    strength: unitInterval('Salience after decay. Strongest first.'),
  })
  .describe('A memory held by this company\'s own chief executive. This is what makes a rival bring up a poaching raid three years later.');
export type NpcMemoryView = z.infer<typeof NpcMemoryViewSchema>;

export const STRATEGIST_CHANGE_KINDS = ['own_move', 'world', 'rival', 'opportunity', 'deal'] as const;
export const StrategistChangeKindSchema = z
  .enum(STRATEGIST_CHANGE_KINDS)
  .describe('What sort of change this is: something this company did, a world variable that moved, a rival\'s public action, a new procurement, or a new deal.');
export type StrategistChangeKind = z.infer<typeof StrategistChangeKindSchema>;

export const StrategistChangeSchema = z
  .object({
    kind: StrategistChangeKindSchema,
    detail: z.string().min(1).max(MAX_STRATEGIST_CHANGE_CHARS).describe('One line, already written from this company\'s point of view.'),
  })
  .describe('One thing that changed since this company last planned.');
export type StrategistChange = z.infer<typeof StrategistChangeSchema>;

/**
 * The delta a strategist gets instead of a full dossier.
 *
 * Sessions are fresh on every call, so this is a compression of what we SEND,
 * never a reliance on the model remembering: the company's standing memory and
 * its position line always travel with it. The full world and rival dossier is
 * re-sent on the first call of a run, after a load, and on the periodic
 * refresh — which is what `isFullBriefing` records.
 */
export const StrategistDeltaSchema = z
  .object({
    isFullBriefing: z.boolean().describe('True when this call carries the whole dossier: the first call of a run, the first after a load, and the periodic refresh.'),
    quartersSinceFullBriefing: z.number().int().min(0).max(4000).describe('Quarters since the last full dossier. Zero on a full one.'),
    changes: z
      .array(StrategistChangeSchema)
      .max(MAX_STRATEGIST_CHANGES)
      .describe('What moved since last quarter, oldest concern first. Empty on a quiet quarter, which is a legitimate answer.'),
  })
  .describe('What changed since this company last planned. Bounded, so a forty-quarter campaign never grows the prompt.');
export type StrategistDelta = z.infer<typeof StrategistDeltaSchema>;

/**
 * How often a strategist call carries the whole dossier rather than a delta.
 *
 * This lives here, beside the schema it governs, rather than in the composer:
 * the browser decides which shape to build and the composer renders it, and a
 * constant only one of them can see is a constant they can disagree about.
 * Keeping it in contracts is also what stops `apps/web` importing
 * `@frontier/llm`, whose default transport spawns a Claude Code subprocess and
 * therefore cannot be bundled for a browser at all.
 */
export const STRATEGIST_FULL_BRIEFING_INTERVAL = 8;

/**
 * Quarters since the last full dossier, under the anchor rule below.
 *
 * Pure and stateless: the anchor is the quarter index itself, so two callers
 * never disagree about which quarter was a refresh and a reloaded save reaches
 * the same answer as the run that wrote it.
 */
export function quartersSinceFullBriefing(quarter: number, interval: number = STRATEGIST_FULL_BRIEFING_INTERVAL): number {
  if (interval <= 0) return 0;
  const whole = Math.max(0, Math.trunc(quarter));
  return whole % interval;
}

/**
 * Whether this call carries the whole dossier.
 *
 * True on the periodic refresh, and true whenever the caller has no prior
 * context to compress against — the first call of a run and the first after a
 * load, where "what changed since last quarter" would be a sentence nobody can
 * write honestly.
 */
export function isFullBriefingQuarter(quarter: number, hasPriorContext: boolean, interval: number = STRATEGIST_FULL_BRIEFING_INTERVAL): boolean {
  if (!hasPriorContext) return true;
  return quartersSinceFullBriefing(quarter, interval) === 0;
}

export const NpcStrategistInputSchema = z
  .object({
    sessionId: z.string().min(1),
    quarter: QuarterIndexSchema,
    companyId: z.string().min(1),
    companyName: z.string().min(1).max(120).describe('The company\'s name, so the prompt addresses a person running a named business rather than an id.'),
    companyBriefing: z.string().describe('This company\'s own position, in full.'),
    worldBriefing: z.string().describe('World conditions as this company would understand them.'),
    rivalBriefing: z.string().describe('What this company knows about rivals — public information only, plus anything it has legitimately learned.'),
    openOpportunities: z.array(z.object({ opportunityId: z.string(), programme: z.string(), maxValueUsd: z.number(), closeQuarter: z.number() })).describe('Procurement this company can see.'),
    incomingDeals: z.array(z.object({ dealId: z.string(), fromId: z.string(), summary: z.string() })).describe('Deals awaiting an answer.'),
    priorPosture: CompanyPostureSchema.describe('The stance this company took last quarter. Wild swings without cause read as incoherent.'),
    priorStrategySummary: z.string().describe('What this company said it was doing last quarter, so its behaviour has continuity.'),
    constraints: z.array(z.string()).describe('Hard limits: available cash, available compute, board approvals required, contractual commitments already made.'),
    persona: NpcPersonaSchema.nullable().describe('The chief executive running this company, or null when it has none — a company in administration, or one whose founder has left.'),
    relationships: z
      .array(NpcRelationshipViewSchema)
      .max(MAX_STRATEGIST_RELATIONSHIPS)
      .describe('How this chief executive regards the player and the rivals that matter, strongest feeling first. Their own feelings only.'),
    memories: z
      .array(NpcMemoryViewSchema)
      .max(MAX_STRATEGIST_MEMORIES)
      .describe('What this chief executive actually remembers about others, strongest first.'),
    memory: StrategistMemorySchema.describe(
      'The company\'s own bounded, engine-written memory: standing strategy, grudges and recent attempts. An empty memory is the neutral reading, never a missing key.',
    ),
    changedSinceLastQuarter: StrategistDeltaSchema.describe('What moved since this company last planned, and whether this call carries the full dossier.'),
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
