/**
 * @frontier/contracts — sim.ts
 *
 * The append-only ledger, the resolution pipeline and the leaderboards.
 *
 * Every economic mutation creates a `SimEvent`. Snapshots make loads fast; the
 * ledger makes history auditable. Together they let the game answer "why did my
 * stock fall?" from committed facts rather than by asking a model to invent an
 * explanation.
 *
 * The resolver order is not decoration. An acquisition approved by a board
 * before quarter end must alter the purchaser's cash before the market resolves.
 * A research accident that stays secret must damage internal research without
 * touching the public share price — and must be able to move it two quarters
 * later if it leaks. Getting the order wrong breaks causality, not just numbers.
 */

import { z } from 'zod';
import { QuarterIndexSchema, unitInterval, usd } from './ids';

/* -------------------------------------------------------------------------- */
/*  Ledger                                                                     */
/* -------------------------------------------------------------------------- */

export const SIM_EVENT_TYPES = [
  // quarter lifecycle
  'quarter_opened',
  'snapshot_created',
  'quarter_committed',
  'invariant_check_failed',
  // world
  'world_event_generated',
  'world_event_applied',
  'modifier_applied',
  'modifier_rejected',
  'modifier_expired',
  'information_revealed',
  // actions
  'action_submitted',
  'action_accepted',
  'action_clamped',
  'action_rejected',
  // governance
  'board_proposal_submitted',
  'board_vote_resolved',
  'commitment_registered',
  'commitment_honoured',
  'commitment_broken',
  'ceo_dismissed',
  'ceo_appointed',
  // capital and ownership
  'funding_round_closed',
  'funding_round_failed',
  'debt_issued',
  'shares_issued',
  'shares_traded',
  'buyback_executed',
  'ownership_threshold_crossed',
  'acquisition_completed',
  'ipo_completed',
  // government
  'opportunity_opened',
  'bid_submitted',
  'bid_disqualified',
  'contract_awarded',
  'contract_milestone',
  'contract_penalty',
  'contract_terminated',
  // people
  'hire_completed',
  'departure',
  'poach_attempted',
  'compensation_changed',
  'introduction_granted',
  'relationship_changed',
  'memory_stored',
  // research
  'research_progress',
  'research_setback',
  'tech_node_achieved',
  'tech_node_added',
  'tech_confidence_shifted',
  'research_published',
  // product and finance
  'product_launched',
  'product_sunset',
  'price_changed',
  'demand_resolved',
  'revenue_recognised',
  'cost_recognised',
  'cash_flow_resolved',
  'balance_sheet_checked',
  // markets and information
  'valuation_anchor_updated',
  'market_priced',
  'disclosure_published',
  'rumour_spread',
  'belief_updated',
  'guidance_evaluated',
  // social
  'social_post_published',
  'media_story_published',
  'sentiment_shifted',
  // deals
  'deal_proposed',
  'deal_accepted',
  'deal_rejected',
  'deal_executed',
  'deal_breached',
  // meta
  'leaderboard_updated',
  'llm_call_logged',
  'fallback_engaged',
  // priced economy (appended: SIM_EVENT_TYPES is a zod enum and is append-only)
  'sector_price_set',
  'sector_shortage_changed',
  'antitrust_exposure_changed',
  'predatory_pricing_flagged',
  'dividend_paid',
  // Capital entities (appended, never inserted). Each earns its place by
  // carrying something no existing type can. Everything else a fund does reuses
  // an existing type with an added payload field, which is what keeps every
  // movement of a company's equity inside the closed set the financial-integrity
  // reconstruction reads. See CAPITAL_INTEGRITY_INVARIANT in capital.ts.
  'short_position_opened',
  'short_position_covered',
  'short_interest_published',
  'short_squeeze_triggered',
  'borrow_cost_charged',
  'activist_campaign_opened',
  'activist_campaign_escalated',
  'activist_campaign_closed',
  'takeover_defence_raised',
  'capital_entity_marked',
  // Compute bought outright from another company. Appended, never inserted.
  'accelerators_bought',
] as const;

export const SimEventTypeSchema = z.enum(SIM_EVENT_TYPES).describe('What kind of thing happened. Every economic mutation in the game produces one of these.');
export type SimEventType = z.infer<typeof SimEventTypeSchema>;

export const LEDGER_VISIBILITIES = ['public', 'sector', 'company', 'private'] as const;

export const LedgerVisibilitySchema = z
  .enum(LEDGER_VISIBILITIES)
  .describe(
    'Who may read this ledger row. "public" is visible to every participant. "sector" to companies in the affected sector. "company" to the acting company only. "private" to the engine and, where relevant, a single character. Private facts do not automatically become public; that is enforced here and again by row-level policy.',
  );
export type LedgerVisibility = z.infer<typeof LedgerVisibilitySchema>;

export const SimEventSchema = z
  .object({
    eventId: z.string().min(1).describe('Deterministic ledger row id.'),
    sessionId: z.string().min(1),
    quarter: QuarterIndexSchema,
    sequence: z.number().int().min(0).describe('Monotonic position within the session. Assigned by the engine as events are emitted, so the ledger replays in exactly one order.'),
    type: SimEventTypeSchema,
    actorId: z.string().nullable().describe('Who caused it: a company id, character id or player id. Null for world and system events.'),
    targetId: z.string().nullable().describe('What it was done to: a company, contract, security, node or character id. Null when there is no distinct target.'),
    payload: z
      .record(z.string(), z.unknown())
      .describe('Type-specific detail, e.g. { value: 2400000000, expectedMargin: 0.17 }. INTERNAL: shape varies by event type and is not part of the LLM contract.'),
    stateHashBefore: z
      .string()
      .describe(
        'Canonical state hash at the opening of the resolution phase that wrote this row — i.e. at the close of the previous phase that wrote to the ledger. Every row emitted by one phase carries the same pair, because the full state is hashed once per phase boundary rather than once per row. Row-level tamper evidence is rowHash.',
      ),
    stateHashAfter: z
      .string()
      .describe(
        'Canonical state hash at the close of the phase that wrote this row. It is the stateHashBefore of the next ledger-writing phase, so the per-phase hashes still chain unbroken from the pre-resolution state to the committed one.',
      ),
    rowHash: z
      .string()
      .describe(
        'Chained row digest: fnv1a64(previous row\'s rowHash + this row canonically serialised), seeded with the pre-resolution state hash. Any row inserted, removed, reordered or altered breaks the chain from that point on, which is what makes a ledger of cheap per-phase state hashes still tamper-evident row by row.',
      ),
    visibility: LedgerVisibilitySchema,
  })
  .describe('One row of the append-only simulation ledger. Rows are never updated and never deleted.');
export type SimEvent = z.infer<typeof SimEventSchema>;

/** The fields a subsystem supplies when emitting; the engine adds the rest. */
export type SimEventDraft = Omit<SimEvent, 'eventId' | 'sequence' | 'stateHashBefore' | 'stateHashAfter' | 'rowHash'>;

/* -------------------------------------------------------------------------- */
/*  Snapshots                                                                  */
/* -------------------------------------------------------------------------- */

export const QuarterSnapshotSchema = z
  .object({
    sessionId: z.string().min(1),
    quarter: QuarterIndexSchema.describe('Quarter this snapshot opens. A snapshot is taken before resolution and again after commit.'),
    phase: z.enum(['pre_resolution', 'post_commit']).describe('Which side of the resolution this snapshot captures.'),
    stateHash: z.string().describe('Hash of the serialised state. Two runs of the same seed and the same recorded decisions must produce the same hash.'),
    lastSequence: z.number().int().min(0).describe('Ledger sequence at the moment of capture, so the snapshot and the ledger can be aligned exactly.'),
    state: z
      .unknown()
      .describe('The serialised canonical state. Parse it with SessionStateSchema; it is typed as unknown here so the ledger module does not depend on the session aggregate. See SessionSnapshotSchema in session.ts for the typed form.'),
  })
  .describe('A point-in-time capture of canonical state. Snapshots make loads fast; the ledger between two snapshots explains every difference.');
export type QuarterSnapshot = z.infer<typeof QuarterSnapshotSchema>;

/* -------------------------------------------------------------------------- */
/*  Resolution pipeline                                                        */
/* -------------------------------------------------------------------------- */

/**
 * The eighteen phases of quarter resolution, in the exact order they run.
 * Changing this order changes causality; it is part of the contract.
 */
export const RESOLUTION_PHASES = [
  'world_events',
  'gm_modifiers',
  'information_reveal',
  'action_collection',
  'board_resolution',
  'capital_resolution',
  'government_resolution',
  'talent_resolution',
  'research_resolution',
  'product_demand_resolution',
  'financial_resolution',
  'disclosure_resolution',
  'market_resolution',
  'social_resolution',
  'relationship_update',
  'leaderboard_update',
  'ledger_commit',
  'snapshot',
] as const;

export const ResolutionPhaseSchema = z
  .enum(RESOLUTION_PHASES)
  .describe(
    'One phase of quarter resolution. The order is fixed: world events and modifiers move the world before anyone acts; boards decide before capital moves; capital moves before government awards; research and product resolve before financials; financials before disclosure; disclosure before the market prices; the market before social propagation; and the ledger commits before the snapshot is taken.',
  );
export type ResolutionPhase = z.infer<typeof ResolutionPhaseSchema>;

export const RESOLUTION_LINE_TONES = ['positive', 'negative', 'neutral', 'warning'] as const;
export const ResolutionLineToneSchema = z
  .enum(RESOLUTION_LINE_TONES)
  .describe('How the line should read on the Quarter Resolution screen. "warning" is the line that carries a tick-mark exclamation: something that has not gone wrong yet.');
export type ResolutionLineTone = z.infer<typeof ResolutionLineToneSchema>;

export const ResolutionLineSchema = z
  .object({
    phase: ResolutionPhaseSchema,
    text: z.string().min(1).max(300).describe('One human-readable sentence, e.g. "Compute spot price rose 11% after the packaging disruption."'),
    deltaLabel: z.string().max(40).nullable().describe('Compact change label shown on the right, e.g. "+13%", "-2.1pp", "#3 to #1", or null when there is no number.'),
    refEventIds: z
      .array(z.string())
      .describe('Ledger rows this line summarises. INVARIANT: every line must reference at least one committed event, so nothing on the resolution screen is narrative invention.'),
    tone: ResolutionLineToneSchema,
    subjectId: z.string().nullable().describe('Company, character or instrument the line is about, so the UI can group and link it.'),
  })
  .describe('One line of the Quarter Resolution report.');
export type ResolutionLine = z.infer<typeof ResolutionLineSchema>;

export const ResolutionPhaseReportSchema = z
  .object({
    phase: ResolutionPhaseSchema,
    lines: z.array(ResolutionLineSchema),
    durationMs: z.number().min(0).describe('Wall-clock time the phase took. Diagnostics only; never an input to the simulation.'),
  })
  .describe('Everything that happened in one phase.');
export type ResolutionPhaseReport = z.infer<typeof ResolutionPhaseReportSchema>;

export const ResolutionReportSchema = z
  .object({
    sessionId: z.string().min(1),
    quarter: QuarterIndexSchema,
    headline: z.string().min(3).max(200).describe('The one-line summary of the quarter, e.g. "Export restriction announced; compute price up 11%."'),
    phases: z.array(ResolutionPhaseReportSchema).describe('One entry per phase that produced any output, in pipeline order.'),
    sequenceFrom: z.number().int().min(0).describe('First ledger sequence covered by this report.'),
    sequenceTo: z.number().int().min(0).describe('Last ledger sequence covered by this report.'),
    stateHashBefore: z.string(),
    stateHashAfter: z.string(),
  })
  .describe(
    'The Quarter Resolution report: the emotional centre of the game loop and, mechanically, a rendering of the ledger. Every line traces to committed events, which is why the screen can always be trusted.',
  );
export type ResolutionReport = z.infer<typeof ResolutionReportSchema>;

/* -------------------------------------------------------------------------- */
/*  Leaderboards                                                               */
/* -------------------------------------------------------------------------- */

export const LEADERBOARD_BOARDS = [
  'company_value',
  'founder_wealth',
  'revenue',
  'profit',
  'innovation',
  'market_influence',
  'network',
  'government',
  'reputation',
  'founder_index',
  // Appended: LEADERBOARD_BOARDS is a zod enum and grows only at the end.
  // Funds on the leaderboard is what makes them peers rather than scenery.
  'capital_returns',
  'assets_under_management',
] as const;

export const LeaderboardBoardSchema = z
  .enum(LEADERBOARD_BOARDS)
  .describe(
    'Which ranking this is. company_value ranks controlled enterprise value; founder_wealth personal net worth; revenue trailing revenue; profit operating and cash performance; innovation frontier achievement; market_influence ownership and control across the industry; network connection level; government procurement credibility and access; reputation multi-audience trust; founder_index the composite. Ten boards exist so that a technically brilliant company can lose financially, a rich founder can lose control, and a small company can become indispensable to governments. Two more rank institutions rather than people: capital_returns is realised plus unrealised multiple and is the only ranking in the game a player cannot enter, and assets_under_management is raw size.',
  );
export type LeaderboardBoard = z.infer<typeof LeaderboardBoardSchema>;

// Appended: 'fund' is a CapitalEntity, ranked on the two institution boards.
export const LEADERBOARD_SUBJECT_KINDS = ['player', 'company', 'character', 'fund'] as const;
export const LeaderboardSubjectKindSchema = z.enum(LEADERBOARD_SUBJECT_KINDS).describe('What is being ranked. "fund" is a CapitalEntity, and its subjectId is the cap-table holder id.');
export type LeaderboardSubjectKind = z.infer<typeof LeaderboardSubjectKindSchema>;

export const LeaderboardEntrySchema = z
  .object({
    rank: z.number().int().min(1),
    previousRank: z.number().int().min(1).nullable().describe('Rank last quarter, or null for a new entrant. The resolution screen shows movement, not just position.'),
    subjectId: z.string().min(1),
    subjectKind: LeaderboardSubjectKindSchema,
    label: z.string().min(1).max(80).describe('Display name.'),
    value: z.number().describe('Raw value in the board\'s own units.'),
    percentile: unitInterval('Value expressed as a percentile within the session. The composite index consumes percentiles, never raw dollars.'),
    delta: z.number().describe('Change in raw value since last quarter.'),
  })
  .describe('One row of a leaderboard.');
export type LeaderboardEntry = z.infer<typeof LeaderboardEntrySchema>;

export const LeaderboardSchema = z
  .object({
    board: LeaderboardBoardSchema,
    quarter: QuarterIndexSchema,
    entries: z.array(LeaderboardEntrySchema).describe('Ranked entries, best first.'),
  })
  .describe('One board for one quarter. Always recomputed server-side from the ledger: the client can never submit a score.');
export type Leaderboard = z.infer<typeof LeaderboardSchema>;

/**
 * Weights for the composite Founder Index.
 *
 * Every input is a percentile within the session, never a raw dollar amount —
 * otherwise wealth eventually overwhelms every other dimension and the composite
 * stops saying anything. These weights are a balancing variable, deliberately
 * held here as data rather than hard-coded in the frontend.
 *
 * INVARIANT: the eight weights sum to exactly 1.
 */
export const FOUNDER_INDEX_WEIGHTS = {
  /** W — founder wealth percentile. */
  wealth: 0.22,
  /** E — controlled enterprise-value percentile. */
  enterprise: 0.18,
  /** I — innovation percentile. */
  innovation: 0.15,
  /** R — multi-audience reputation percentile. */
  reputation: 0.12,
  /** N — network / connection percentile. */
  network: 0.1,
  /** G — government credibility percentile. */
  government: 0.1,
  /** F — financial resilience percentile. */
  financialResilience: 0.08,
  /** S — session objectives percentile. */
  sessionObjectives: 0.05,
} as const;

export type FounderIndexComponent = keyof typeof FOUNDER_INDEX_WEIGHTS;

/** The eight percentile inputs to the composite score. */
export const FounderIndexInputsSchema = z
  .object({
    wealth: unitInterval('Founder wealth percentile.'),
    enterprise: unitInterval('Controlled enterprise-value percentile.'),
    innovation: unitInterval('Innovation percentile.'),
    reputation: unitInterval('Reputation percentile.'),
    network: unitInterval('Network percentile.'),
    government: unitInterval('Government credibility percentile.'),
    financialResilience: unitInterval('Financial resilience percentile.'),
    sessionObjectives: unitInterval('Session objectives percentile.'),
  })
  .describe('Percentile-normalised inputs to the Founder Index.');
export type FounderIndexInputs = z.infer<typeof FounderIndexInputsSchema>;

/** Compute the composite score. Pure and deterministic. */
export function founderIndex(inputs: FounderIndexInputs): number {
  return (
    inputs.wealth * FOUNDER_INDEX_WEIGHTS.wealth +
    inputs.enterprise * FOUNDER_INDEX_WEIGHTS.enterprise +
    inputs.innovation * FOUNDER_INDEX_WEIGHTS.innovation +
    inputs.reputation * FOUNDER_INDEX_WEIGHTS.reputation +
    inputs.network * FOUNDER_INDEX_WEIGHTS.network +
    inputs.government * FOUNDER_INDEX_WEIGHTS.government +
    inputs.financialResilience * FOUNDER_INDEX_WEIGHTS.financialResilience +
    inputs.sessionObjectives * FOUNDER_INDEX_WEIGHTS.sessionObjectives
  );
}

/* -------------------------------------------------------------------------- */
/*  Session objectives                                                         */
/* -------------------------------------------------------------------------- */

export const OBJECTIVE_METRICS = [
  'enterprise_value',
  'founder_wealth',
  'revenue',
  'operating_income',
  'tech_nodes_achieved',
  'government_contract_value',
  'connection_level',
  'board_seats',
  'ownership_of_rival',
  'survive_quarters',
] as const;

export const ObjectiveMetricSchema = z.enum(OBJECTIVE_METRICS).describe('What an objective measures.');
export type ObjectiveMetric = z.infer<typeof ObjectiveMetricSchema>;

export const SessionObjectiveSchema = z
  .object({
    id: z.string().min(1),
    playerId: z.string().nullable().describe('Player this objective belongs to, or null for a session-wide objective.'),
    label: z.string().min(3).max(120),
    description: z.string().max(500),
    metric: ObjectiveMetricSchema,
    targetValue: z.number().describe('Value that counts as achievement, in the metric\'s own units.'),
    currentValue: z.number().describe('Where the player currently stands.'),
    progress: unitInterval('Fraction of the way there.'),
    completedQuarter: QuarterIndexSchema.nullable(),
    weight: unitInterval('Contribution to the sessionObjectives percentile of the Founder Index.'),
  })
  .describe('An explicit goal. Sessions can offer objectives without reducing the sandbox to a single victory condition; there is no fixed victory screen.');
export type SessionObjective = z.infer<typeof SessionObjectiveSchema>;

/* -------------------------------------------------------------------------- */
/*  Invariants                                                                 */
/* -------------------------------------------------------------------------- */

export const SIMULATION_INVARIANTS = [
  'deterministic_replay',
  'financial_integrity',
  'ownership_integrity',
  'market_integrity',
  'llm_containment',
  'idempotency',
  'information_boundary',
  'authoritative_backend',
  'social_security',
  'auditability',
  'tech_graph_safety',
  'agent_reproducibility',
  'failure_mode',
  // Appended: what financial_integrity does for companies, capital_integrity
  // does for capital entities. See CAPITAL_INTEGRITY_INVARIANT in capital.ts.
  'capital_integrity',
] as const;

export const SimulationInvariantSchema = z
  .enum(SIMULATION_INVARIANTS)
  .describe(
    'The quality invariants the engine enforces. deterministic_replay: same state, decisions and seed produce the same outcome. financial_integrity: balance sheets reconcile. ownership_integrity: issued shares and holdings reconcile. market_integrity: no negative or NaN prices. llm_containment: invalid model output cannot mutate state. idempotency: a quarter cannot resolve twice. information_boundary: private facts do not automatically become public. authoritative_backend: the client cannot manufacture money, shares or score. social_security: unauthorised users cannot join restricted conversations. auditability: material changes trace to an event. tech_graph_safety: generated technology cannot execute client code. agent_reproducibility: model output and version are logged. failure_mode: an LLM outage has deterministic fallback behaviour. capital_integrity: every movement of a capital entity\'s dry powder is explained by the quarter\'s rows, dry powder never goes negative, and a fund moves a company\'s equity only through an event type the equity reconstruction already reads.',
  );
export type SimulationInvariant = z.infer<typeof SimulationInvariantSchema>;

export const InvariantCheckResultSchema = z
  .object({
    invariant: SimulationInvariantSchema,
    passed: z.boolean(),
    detail: z.string().max(500).describe('What was checked and, on failure, exactly what did not reconcile.'),
    subjectId: z.string().nullable().describe('Company, security or instrument that failed, or null for session-wide checks.'),
  })
  .describe('The outcome of one invariant check. A failed check in the ledger_commit phase aborts the commit and restores the pre-resolution snapshot.');
export type InvariantCheckResult = z.infer<typeof InvariantCheckResultSchema>;

/** Convenience alias used by the financial phase. */
export const QuarterFinancialTotalsSchema = z
  .object({
    quarter: QuarterIndexSchema,
    totalRevenueUsd: usd('Revenue across every company in the session.'),
    totalCashUsd: usd('Cash across every company.'),
    totalDebtUsd: usd('Debt across every company.'),
    companiesInsolvent: z.number().int().min(0).describe('Companies that reached zero cash without financing.'),
  })
  .describe('Session-wide financial totals, used for sanity checks and the economy dashboard.');
export type QuarterFinancialTotals = z.infer<typeof QuarterFinancialTotalsSchema>;
