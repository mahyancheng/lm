/**
 * @frontier/contracts — session.ts
 *
 * `SessionState` is the canonical root aggregate: everything the deterministic
 * resolver needs to compute `S_{t+1} = F(S_t, actions, modifiers, seed)`.
 *
 * Rules that shape the shape:
 * - **Collections are arrays, not records**, except where a keyed lookup is the
 *   natural representation (`sectors`, `eventHazards`). Arrays iterate in a
 *   stable order, which matters for determinism and for state hashing.
 * - **Bounded history.** Quotes and disclosures are kept for a rolling window;
 *   the full history lives in the ledger and in snapshots, not in live state.
 * - **Truth and belief are separate.** `companies` and `researchProjects` hold
 *   canonical reality; `beliefs` and `disclosures` hold what the market thinks.
 *   Nothing crosses between them except through the disclosure phase.
 * - Collection fields carry `.default([])` so a partial fixture parses cleanly.
 *   The inferred `SessionState` type still has every field required.
 */

import { z } from 'zod';
import { QuarterIndexSchema, unitInterval } from './ids';
import { SectorStateMapSchema, WorldStateSchema } from './world';
import { ActiveModifierSchema } from './modifiers';
import { EventHazardMapSchema, WorldEventSchema } from './events';
import { CompanySchema, CompanyQuarterMetricsSchema } from './company';
import { CapTableSchema, FundingRoundSchema, SecuritySchema } from './ownership';
import { MarketBeliefSchema, MarketInstrumentSchema, PublicDisclosureSchema, QuoteSchema, ValuationAnchorSchema } from './markets';
import { BoardProposalSchema, BoardSchema, StoredCommitmentSchema } from './governance';
import { AgencySchema, ContractorReputationSchema, GovernmentContractSchema, ProcurementOpportunitySchema, StoredGovernmentBidSchema } from './government';
import { ResearchProjectSchema, TechGraphSchema } from './tech';
import { AccessOverrideSchema, CharacterSchema, ConversationMetadataSchema, MemorySchema, RelationshipSchema } from './people';
import { MediaStorySchema, SocialAccountSchema, SocialPostSchema } from './social';
import { DealProposalSchema } from './deals';
import { SubmittedActionSchema } from './actions';
import { LeaderboardSchema, QuarterSnapshotSchema, SessionObjectiveSchema } from './sim';

/* -------------------------------------------------------------------------- */
/*  Configuration                                                              */
/* -------------------------------------------------------------------------- */

export const SESSION_DIFFICULTIES = ['sandbox', 'standard', 'hard', 'brutal'] as const;

export const SessionDifficultySchema = z
  .enum(SESSION_DIFFICULTIES)
  .describe('How volatile the world is and how sharply rivals play. Difficulty scales the impact budget and NPC aggression; it never gives rivals information they should not have.');
export type SessionDifficulty = z.infer<typeof SessionDifficultySchema>;

export const SessionConfigSchema = z
  .object({
    playerCount: z.number().int().min(1).max(8).describe('Human founders in the session. A solo session simply contains one human and more AI-controlled companies.'),
    difficulty: SessionDifficultySchema,
    majorRivalCount: z.number().int().min(0).max(10).describe('Companies on the "major" tier receiving full LLM strategic planning each quarter. Four to ten is the intended range.'),
    significantCompanyCount: z.number().int().min(0).max(60).describe('Companies on the "significant" tier running rule-based strategy with occasional LLM deliberation.'),
    backgroundCompanyCount: z.number().int().min(0).max(500).describe('Deterministic archetype companies. They are promoted to a higher tier only when they become strategically relevant.'),
    scenarioId: z.string().min(1).describe('Seed scenario, e.g. "compute_crunch_2031". Determines starting world values, seed companies and the initial Frontier Map.'),
    startYear: z.number().int().min(2020).max(2100).describe('Calendar year quarter 0 falls in.'),
    quarterLimit: z.number().int().min(1).max(400).nullable().describe('Quarter at which the session ends, or null for an open-ended sandbox. There is no fixed victory screen either way.'),
    enableReferenceMarket: z.boolean().describe('Whether to display the live real-world reference tape alongside the in-world exchange. Reference instruments are read-only regardless.'),
    allowPlayerInnovation: z.boolean().describe('Whether players may propose new Frontier Map nodes.'),
    autoExecuteRoutineDefault: z.boolean().describe('Default for the per-player "execute routine instructions automatically" preference. Never applies to actions in CONFIRMATION_REQUIRED_ACTIONS.'),
  })
  .describe('Static configuration chosen when the session is created. Immutable once the session starts.');
export type SessionConfig = z.infer<typeof SessionConfigSchema>;

/* -------------------------------------------------------------------------- */
/*  Players                                                                    */
/* -------------------------------------------------------------------------- */

export const SessionPlayerSchema = z
  .object({
    playerId: z.string().min(1),
    characterId: z.string().min(1).describe('The founder character this participant controls. The player is the character, not the company.'),
    companyId: z.string().min(1).describe('Company they currently direct. This can change: a dismissed chief executive keeps their shares and may later direct a different company.'),
    isHuman: z.boolean().describe('False for AI-controlled founders occupying a player seat. Their messages must be labelled as AI-generated.'),
    displayName: z.string().min(1).max(60),
    joinedQuarter: QuarterIndexSchema,
    autoExecuteRoutine: z.boolean().describe('Whether low-risk interpreted instructions may execute without an explicit confirmation.'),
    hasSubmittedThisQuarter: z.boolean().describe('Whether they have locked their instructions for the current quarter. Resolution waits for every active player or for the planning window to close.'),
    isActive: z.boolean(),
  })
  .describe('One seat at the table.');
export type SessionPlayer = z.infer<typeof SessionPlayerSchema>;

/* -------------------------------------------------------------------------- */
/*  Session status                                                             */
/* -------------------------------------------------------------------------- */

export const SESSION_STATUSES = ['lobby', 'active', 'resolving', 'completed', 'abandoned'] as const;

export const SessionStatusSchema = z
  .enum(SESSION_STATUSES)
  .describe('Lifecycle. "resolving" is a lock: a quarter cannot resolve twice, and no action may be submitted while the resolver runs.');
export type SessionStatus = z.infer<typeof SessionStatusSchema>;

/* -------------------------------------------------------------------------- */
/*  The root aggregate                                                         */
/* -------------------------------------------------------------------------- */

export const SessionStateSchema = z
  .object({
    // --- identity and clock ---
    sessionId: z.string().min(1),
    seed: z.string().min(1).describe('The session seed. Every stochastic decision in the engine derives from it through the seeded RNG. Same state plus same decisions plus same seed produces the same outcome, always.'),
    quarter: QuarterIndexSchema.describe('The quarter currently open for planning.'),
    startYear: z.number().int().min(2020).max(2100),
    status: SessionStatusSchema,
    config: SessionConfigSchema,
    ledgerSequence: z.number().int().min(0).default(0).describe('Next ledger sequence number to assign. Advances monotonically and never rewinds.'),
    lastResolvedQuarter: QuarterIndexSchema.nullable().default(null).describe('Last quarter that committed, or null before the first resolution. Guards idempotency.'),

    // --- world ---
    world: WorldStateSchema,
    sectors: SectorStateMapSchema.describe('Per-sector conditions, keyed by sector id.'),
    activeModifiers: z.array(ActiveModifierSchema).default([]).describe('Modifiers currently in force, with decay resolved for this quarter.'),
    activeEvents: z.array(WorldEventSchema).default([]).describe('World events still within their duration.'),
    eventHazards: EventHazardMapSchema.describe('Per-family hazard state, keyed by family id. This is where causal cascades live between quarters.'),

    // --- companies and ownership ---
    companies: z.array(CompanySchema).default([]),
    companyMetrics: z.array(CompanyQuarterMetricsSchema).default([]).describe('Derived metrics for the current quarter, one entry per active company.'),
    capTables: z.array(CapTableSchema).default([]),
    securities: z.array(SecuritySchema).default([]),
    fundingRounds: z.array(FundingRoundSchema).default([]),

    // --- markets and information ---
    marketInstruments: z.array(MarketInstrumentSchema).default([]),
    quotes: z.array(QuoteSchema).default([]).describe('Rolling price history, bounded by quoteHistoryQuarters. Older quotes live in snapshots and the ledger.'),
    quoteHistoryQuarters: z.number().int().min(1).max(80).default(24).describe('How many quarters of quotes to retain in live state.'),
    valuationAnchors: z.array(ValuationAnchorSchema).default([]).describe('Current fundamental anchors, one per company with a priced security.'),
    beliefs: z.array(MarketBeliefSchema).default([]).describe('What the market believes. The share price reflects this, not the canonical database.'),
    disclosures: z.array(PublicDisclosureSchema).default([]).describe('Public information released so far, bounded to a rolling window.'),

    // --- technology ---
    techGraph: TechGraphSchema,
    researchProjects: z.array(ResearchProjectSchema).default([]).describe('Canonical private reality of every research programme, secret ones included.'),

    // --- people ---
    characters: z.array(CharacterSchema).default([]),
    relationships: z.array(RelationshipSchema).default([]).describe('Directional feelings between characters.'),
    memories: z.array(MemorySchema).default([]).describe('What characters remember, with salience already decayed.'),
    accessOverrides: z.array(AccessOverrideSchema).default([]).describe('Active bypasses of the connection gap rule.'),
    conversations: z.array(ConversationMetadataSchema).default([]).describe('Conversation metadata only. Message bodies live in Supabase and stream over Realtime.'),

    // --- governance ---
    boards: z.array(BoardSchema).default([]),
    boardProposals: z.array(BoardProposalSchema).default([]),
    commitments: z.array(StoredCommitmentSchema).default([]).describe('Conditional commitments made in conversation and still live.'),

    // --- government ---
    agencies: z.array(AgencySchema).default([]),
    procurementOpportunities: z.array(ProcurementOpportunitySchema).default([]),
    governmentBids: z.array(StoredGovernmentBidSchema).default([]),
    governmentContracts: z.array(GovernmentContractSchema).default([]),
    contractorReputations: z.array(ContractorReputationSchema).default([]),

    // --- social ---
    socialAccounts: z.array(SocialAccountSchema).default([]),
    socialPosts: z.array(SocialPostSchema).default([]).describe('Published posts, bounded to a rolling window.'),
    mediaStories: z.array(MediaStorySchema).default([]),

    // --- deals ---
    deals: z.array(DealProposalSchema).default([]),

    // --- participants and pending work ---
    players: z.array(SessionPlayerSchema).default([]),
    pendingActions: z.array(SubmittedActionSchema).default([]).describe('Actions submitted for the open quarter and not yet resolved. Cleared at ledger_commit.'),

    // --- competition ---
    leaderboards: z.array(LeaderboardSchema).default([]).describe('One entry per board, recomputed server-side every quarter from the ledger.'),
    objectives: z.array(SessionObjectiveSchema).default([]),
  })
  .describe(
    'The canonical root aggregate of a session. In production Supabase Postgres holds this; in demo mode the in-memory store does, with the same engine and the same invariants. The client is never authoritative over any part of it.',
  );
export type SessionState = z.infer<typeof SessionStateSchema>;

/**
 * The input type of `SessionStateSchema` — collections may be omitted and are
 * filled with empty arrays. Useful for fixtures and for scenario seed data.
 */
export type SessionStateInput = z.input<typeof SessionStateSchema>;

/* -------------------------------------------------------------------------- */
/*  Typed snapshot                                                             */
/* -------------------------------------------------------------------------- */

/** A quarter snapshot with the state field typed, for callers that need it. */
export const SessionSnapshotSchema = QuarterSnapshotSchema.extend({
  state: SessionStateSchema,
}).describe('A quarter snapshot carrying a fully typed SessionState.');
export type SessionSnapshot = z.infer<typeof SessionSnapshotSchema>;

/* -------------------------------------------------------------------------- */
/*  Read-model projections                                                     */
/* -------------------------------------------------------------------------- */

/**
 * What one player is allowed to see. The engine produces this from
 * `SessionState`; the client never receives the full aggregate, because the full
 * aggregate contains every rival's private research, internal confidence,
 * undisclosed holdings and secret programmes.
 */
export const PlayerViewSchema = z
  .object({
    sessionId: z.string().min(1),
    quarter: QuarterIndexSchema,
    startYear: z.number().int(),
    playerId: z.string().min(1),
    world: WorldStateSchema.describe('The world is shared: every participant sees the same world state.'),
    sectors: SectorStateMapSchema,
    ownCompany: CompanySchema.describe('Full detail for the company this player directs.'),
    ownCapTable: CapTableSchema,
    ownResearchProjects: z.array(ResearchProjectSchema).describe('Including secret programmes, which only this company can see.'),
    visibleCompanies: z
      .array(CompanySchema.partial())
      .describe('Rivals, redacted to what this player could reasonably know: public financials for listed companies, much less for private ones.'),
    techGraph: TechGraphSchema.describe('The Frontier Map with confidenceByCompany reduced to this player\'s own entry and the public figure.'),
    quotes: z.array(QuoteSchema),
    disclosures: z.array(PublicDisclosureSchema).describe('Public information only.'),
    activeEvents: z.array(WorldEventSchema).describe('Events whose visibility reaches this player.'),
    board: BoardSchema.nullable(),
    boardProposals: z.array(BoardProposalSchema),
    opportunities: z.array(ProcurementOpportunitySchema).describe('Opportunities this player can see, which depends on standing and invitations.'),
    contracts: z.array(GovernmentContractSchema),
    deals: z.array(DealProposalSchema).describe('Deals this player is party to.'),
    leaderboards: z.array(LeaderboardSchema),
    objectives: z.array(SessionObjectiveSchema),
    alerts: z.array(z.string()).describe('Command Centre alert lines for the open quarter.'),
  })
  .describe('The redacted projection sent to one client. Information boundaries are enforced here and again by row-level policy.');
export type PlayerView = z.infer<typeof PlayerViewSchema>;
