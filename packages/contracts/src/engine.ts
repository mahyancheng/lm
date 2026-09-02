/**
 * @frontier/contracts — engine.ts
 *
 * The subsystem interfaces `@frontier/simulation` implements.
 *
 * Every subsystem function here is:
 * - **Deterministic.** No `Math.random()`, no `Date.now()`, no ambient I/O. All
 *   randomness comes from the `SeededRng` on the context, forked per subsystem
 *   so that adding a call in one subsystem cannot shift another's draw sequence.
 * - **A mutator of a draft.** Functions take a `draft: SessionState` and change
 *   it in place. The resolver clones the incoming state once, hands the draft
 *   through the phase list in order, and returns the result. No subsystem
 *   returns a new state.
 * - **An emitter.** Anything economically material calls `ctx.emit()` to write a
 *   ledger row, and `ctx.log()` to add a human-readable line to the Quarter
 *   Resolution report. Every report line must reference at least one emitted
 *   event; nothing on that screen is narrative invention.
 */

import { z } from 'zod';
import { QuarterIndexSchema, unitInterval } from './ids';
import type { GmProposalBatch } from './events';
import { EventVisibilitySchema, WorldEventTypeSchema } from './events';
import type { ReturnDecomposition, ValuationAnchor } from './markets';
import type { BalanceSheetCheck, ProfitAndLoss } from './company';
import type { BoardTally } from './governance';
import type { BidScoreBreakdown } from './government';
import type { InnovationProposal, InnovationIntegrationResult, TechConfidenceUpdate } from './tech';
import type { AccessDecision } from './people';
import type { EngagementResult } from './social';
import type { ActionIntent, ActionValidationResult, NpcActionBundle, SubmittedAction } from './actions';
import type { InvariantCheckResult, ResolutionLine, ResolutionReport, SimEvent, SimEventDraft } from './sim';
import type { SessionState } from './session';

/* -------------------------------------------------------------------------- */
/*  Seeded randomness                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The only source of randomness permitted anywhere in the simulation.
 *
 * `fork(label)` derives an independent stream from the same seed. Every
 * subsystem forks its own stream so that changing the number of draws in, say,
 * the market phase cannot silently change which companies got hired into in the
 * talent phase. Implemented in `@frontier/shared`.
 */
export interface SeededRng {
  /** Uniform in [0, 1). */
  next(): number;
  /** Uniform real in [min, max). */
  range(min: number, max: number): number;
  /** Uniform integer in [min, max] inclusive. */
  int(min: number, max: number): number;
  /** One element of a non-empty array. Throws on an empty array. */
  pick<T>(arr: readonly T[]): T;
  /** A new shuffled copy. Does not mutate the input. */
  shuffle<T>(arr: readonly T[]): T[];
  /** An independent stream derived from this one and `label`. */
  fork(label: string): SeededRng;
}

/* -------------------------------------------------------------------------- */
/*  Resolver context                                                           */
/* -------------------------------------------------------------------------- */

/** A resolution-report line as a subsystem supplies it: refs may be omitted while an event is being emitted in the same breath. */
export type ResolutionLineDraft = Omit<ResolutionLine, 'refEventIds'> & { refEventIds?: string[] };

/**
 * Everything a subsystem is allowed to reach for beyond the draft state.
 *
 * Deliberately narrow: no clock, no network, no config lookup. If a subsystem
 * needs a number it cannot derive from the draft, that number belongs in the
 * state, not in the context.
 */
export interface ResolverContext {
  /** The quarter being resolved. */
  readonly quarter: number;
  /** This subsystem's forked RNG stream. */
  readonly rng: SeededRng;
  /** Append a row to the ledger. Returns the assigned event id so `log` can reference it. */
  emit(draft: SimEventDraft): string;
  /** Add a line to the Quarter Resolution report. */
  log(line: ResolutionLineDraft): void;
}

/* -------------------------------------------------------------------------- */
/*  Event candidates                                                           */
/* -------------------------------------------------------------------------- */

/**
 * The skeleton the deterministic hazard engine hands to the World Director.
 *
 * The engine has already decided that *something in this family* happens, how
 * severe it may be and which variables are plausibly in scope. The model's job
 * is to say what it actually is and how it reads — not whether it occurs.
 */
export const WorldEventCandidateSchema = z
  .object({
    candidateId: z.string().min(1).describe('Id for this candidate, echoed back in the proposal so the engine can match them up.'),
    familyId: z.string().min(1).describe('Event family that fired.'),
    familyLabel: z.string().min(1).describe('Human label for the family, e.g. "Compute supply disruption".'),
    allowedTypes: z.array(WorldEventTypeSchema).min(1).describe('Event types this candidate may take. Choose one of these.'),
    severityBand: z
      .tuple([unitInterval('Minimum permitted severity.'), unitInterval('Maximum permitted severity.')])
      .describe('[minimum, maximum] severity permitted. A proposal outside this band is clamped into it.'),
    suggestedSeverity: unitInterval('The severity the engine drew from the seeded RNG. Deviate only with reason.'),
    defaultVisibility: EventVisibilitySchema,
    maxDurationQuarters: z.number().int().min(1).max(12).describe('Longest duration permitted for this candidate.'),
    causalParentId: z.string().nullable().describe('Recent event that raised this family\'s hazard, or null. When set, write the event as a consequence of that one rather than as an unrelated shock.'),
    suggestedTargetPaths: z.array(z.string()).describe('World target paths this family usually moves. Advisory: any legal path is permitted, but wandering far from these is usually a mistake.'),
    relevantWorldReadings: z
      .array(z.object({ path: z.string(), value: z.number(), label: z.string() }))
      .describe('Current values of the variables most relevant to this candidate, so the proposal can be numerate about direction and size.'),
    affectedSectorIds: z.array(z.string()).describe('Sectors the engine expects to be affected.'),
  })
  .describe('A candidate event skeleton. The engine decides whether and roughly what; the World Director decides how it reads and which variables move.');
export type WorldEventCandidate = z.infer<typeof WorldEventCandidateSchema>;

/* -------------------------------------------------------------------------- */
/*  Economy                                                                    */
/* -------------------------------------------------------------------------- */

export interface EconomySubsystem {
  /** Advance macro, capital-market, compute, energy and society variables by their own dynamics, before any event or modifier applies. */
  updateMacro(draft: SessionState, ctx: ResolverContext): void;
  /**
   * Price the six-sector goods chain and the regional logistics tolls from last
   * quarter's supply and demand, and step the stateful shortage counters.
   *
   * Runs immediately after `updateMacro` and before `computeEventCandidates`, so
   * a price is settled before anybody plans against it. Pure with respect to
   * randomness: it draws nothing, and it is a no-op in a single-sector world.
   */
  priceSectors(draft: SessionState, ctx: ResolverContext): void;
  /** Run hazard calculation, eligibility, cooldown and contradiction checks, then draw candidate skeletons within the severity budget. May legitimately return an empty array: a quiet quarter is a valid outcome. */
  computeEventCandidates(draft: SessionState, ctx: ResolverContext): WorldEventCandidate[];
  /** Apply every active modifier to its target path, clamping to the registered bounds and emitting a ledger row per application. */
  applyModifiers(draft: SessionState, ctx: ResolverContext): void;
  /** Advance decay, decrement remaining quarters and remove exhausted modifiers. Runs at the end of the world phase. */
  decayModifiers(draft: SessionState, ctx: ResolverContext): void;
  /** Fold a validated World Director batch into the draft: create the events, register the modifiers, update follow-on hazards. */
  applyGmProposals(draft: SessionState, batch: GmProposalBatch, candidates: readonly WorldEventCandidate[], ctx: ResolverContext): void;
  /** Reveal information according to event visibility: who learns what, and when. */
  revealInformation(draft: SessionState, ctx: ResolverContext): void;
}

/* -------------------------------------------------------------------------- */
/*  Markets                                                                    */
/* -------------------------------------------------------------------------- */

export interface MarketsSubsystem {
  /** Choose the valuation method by company maturity and compute the fundamental anchor. Pure with respect to the draft: reads it, returns a value. */
  computeValuationAnchor(draft: SessionState, companyId: string): ValuationAnchor;
  /** Move market beliefs in response to the quarter's disclosures, results and rumours. This is the only path from private truth to price. */
  updateBeliefs(draft: SessionState, ctx: ResolverContext): void;
  /** Price every in-world instrument and return the full decomposition for each. Reference instruments are skipped: their prices belong to reality. */
  priceMarket(draft: SessionState, ctx: ResolverContext): ReturnDecomposition[];
  /** Settle share purchases, sales, buybacks and issuances submitted this quarter, respecting lock-ups and disclosure thresholds. */
  settleTrades(draft: SessionState, ctx: ResolverContext): void;
}

/* -------------------------------------------------------------------------- */
/*  Companies                                                                  */
/* -------------------------------------------------------------------------- */

export interface CompaniesSubsystem {
  /** Fill open roles, apply attrition and departures, update morale and compensation. */
  resolveHiring(draft: SessionState, ctx: ResolverContext): void;
  /** Resolve serving capacity, pricing, demand and churn for every product of every company. */
  resolveProducts(draft: SessionState, ctx: ResolverContext): void;
  /** Recognise revenue and cost, settle interest and cash flow, then run the balance-sheet invariant. A failing check blocks the quarter commit. */
  resolveFinancials(draft: SessionState, ctx: ResolverContext): { pnl: ProfitAndLoss[]; balanceChecks: BalanceSheetCheck[] };
  /** Give background-tier companies deterministic archetype behaviour, so hundreds of companies live in the economy without hundreds of model calls. */
  applyNpcDefaults(draft: SessionState, ctx: ResolverContext): void;
  /** Recompute the derived per-quarter metrics used by leaderboards, valuation and the Command Centre. */
  recomputeMetrics(draft: SessionState, ctx: ResolverContext): void;
}

/* -------------------------------------------------------------------------- */
/*  Research                                                                   */
/* -------------------------------------------------------------------------- */

export interface ResearchSubsystem {
  /** Advance every active project by its funding, compute and talent, applying setbacks from the seeded RNG. */
  advanceProjects(draft: SessionState, ctx: ResolverContext): void;
  /** Move public and per-company confidence across the Frontier Map in response to events, results and publications. */
  updateTechConfidence(draft: SessionState, ctx: ResolverContext): TechConfidenceUpdate[];
  /** Mark nodes achieved where a project has completed, and propagate the consequences down unlock edges. */
  achieveNodes(draft: SessionState, ctx: ResolverContext): void;
  /** Check a player innovation proposal against the session's resources and technology, and add it to the graph when it is remotely consistent. */
  integrateInnovationProposal(draft: SessionState, proposal: InnovationProposal, ctx: ResolverContext): InnovationIntegrationResult;
}

/* -------------------------------------------------------------------------- */
/*  Government                                                                 */
/* -------------------------------------------------------------------------- */

export interface GovernmentSubsystem {
  /** Open new procurement opportunities according to agency budgets and the government domain of the world state. */
  openOpportunities(draft: SessionState, ctx: ResolverContext): void;
  /** Score every bid on every axis, discounting claims by real capability, and apply the opportunity's evaluation weights. */
  scoreBids(draft: SessionState, ctx: ResolverContext): BidScoreBreakdown[];
  /** Award contracts to the highest weighted score, create the contract and its milestones, and emit the award. */
  awardContracts(draft: SessionState, ctx: ResolverContext): void;
  /** Advance milestones, recognise contracted revenue, apply penalties and update past-performance scores. */
  advanceMilestones(draft: SessionState, ctx: ResolverContext): void;
}

/* -------------------------------------------------------------------------- */
/*  Boards                                                                     */
/* -------------------------------------------------------------------------- */

export interface BoardsSubsystem {
  /** Tally one proposal: every director's stance from traits, mandate, relationship and any live commitment. Pure with respect to the draft. */
  tallyProposal(draft: SessionState, proposalId: string): BoardTally;
  /** Resolve every tabled proposal for the quarter, apply the consequences of those that pass, and emit the votes. */
  resolveProposals(draft: SessionState, ctx: ResolverContext): void;
  /** Check live conditional commitments against the proposals actually tabled, honour or break them, and apply the relationship consequences. */
  applyCommitments(draft: SessionState, ctx: ResolverContext): void;
}

/* -------------------------------------------------------------------------- */
/*  Capital entities                                                           */
/* -------------------------------------------------------------------------- */

/**
 * The venture, buyout, hedge and sovereign desks. Five entry points, all inside
 * the existing eighteen phases: adding a phase would shift every phase's RNG
 * stream after it, and nothing here needs one.
 *
 * Every method is deterministic and takes no draw of its own. Where a tie-break
 * of last resort needs a stream it must be a **fork** (`ctx.rng.fork('capital_desks')`)
 * so the desks cannot move any other consumer's draw sequence.
 *
 * Gated on world version: in world 1 every method is a no-op and the session
 * grows no `capitalEntities`, `shortPositions`, `activistCampaigns` or
 * `capitalOrders` key at all.
 */
export interface CapitalDesksSubsystem {
  /**
   * Phase `action_collection`, **after** NPC defaults so the desks see what the
   * world already decided this quarter. Scores every eligible company, applies
   * one threshold and hard per-entity caps, and writes deal proposals (term
   * sheets, buyout approaches, white-knight invitations), capital orders and
   * sponsor actions — never more than `CAPITAL_DESK_ORDER_BUDGET` rows in total.
   *
   * A term sheet offered here is answerable only by an action submitted in the
   * NEXT quarter. A fund's offer is never resolved in the quarter it is made.
   */
  runCapitalDesks(draft: SessionState, ctx: ResolverContext): void;
  /**
   * Phase `capital_resolution`, after deals are routed. Accepted term sheets
   * close as ordinary funding rounds with a real lead investor; buyouts place
   * debt on the target and settle through the ordinary acquisition path; fees
   * and capital calls move `dryPowderUsd`.
   */
  resolveSponsorCapital(draft: SessionState, ctx: ResolverContext): void;
  /** Phase `disclosure_resolution`. Short reports, public activist letters and every position over the disclosure threshold become ordinary public disclosures with an engine-computed credibility. */
  publishSponsorDisclosures(draft: SessionState, ctx: ResolverContext): void;
  /** Phase `market_resolution`, after the market prices, so a short opened this quarter is struck at this quarter's quote and its P&L lands next quarter. Opens, marks, accrues borrow cost, and force-covers on squeeze or margin. */
  settleShorts(draft: SessionState, ctx: ResolverContext): void;
  /** Phase `leaderboard_update`, before the boards are rebuilt. Recomputes NAV, DPI, LP pressure and track record into the economy report. */
  recomputeCapitalEntities(draft: SessionState, ctx: ResolverContext): void;
}

/* -------------------------------------------------------------------------- */
/*  Relationships                                                              */
/* -------------------------------------------------------------------------- */

export interface RelationshipsSubsystem {
  /** Move trust, respect, hostility and dependence in response to what actually happened this quarter. */
  updateRelationships(draft: SessionState, ctx: ResolverContext): void;
  /** Decay memory salience and drop memories below the recall threshold. Betrayals decay far more slowly than favours. */
  decayMemories(draft: SessionState, ctx: ResolverContext): void;
  /** Recompute every character's connection level from its ten inputs. */
  recomputeConnectionLevels(draft: SessionState, ctx: ResolverContext): void;
  /** Decide whether character `a` may initiate contact with character `b`, applying the connection gap rule and any access override. */
  checkAccess(draft: SessionState, a: string, b: string): AccessDecision;
}

/* -------------------------------------------------------------------------- */
/*  Social                                                                     */
/* -------------------------------------------------------------------------- */

export interface SocialSubsystem {
  /** Compute reach, engagement and every sentiment consequence for the quarter's posts. The text was written by a model; every number here is engine output. */
  propagatePosts(draft: SessionState, ctx: ResolverContext): EngagementResult[];
  /** Decide which posts and events the press picks up, and create the resulting stories. */
  updateMediaStories(draft: SessionState, ctx: ResolverContext): void;
}

/* -------------------------------------------------------------------------- */
/*  Action validation                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Governance of actions. Runs server-side, always, against the canonical draft.
 * The client is never authoritative: an action that cannot be afforded is
 * clamped or rejected here regardless of what the interface allowed.
 */
export interface ActionValidator {
  validate(draft: SessionState, action: ActionIntent, actorPlayerId: string | null): ActionValidationResult;
  /** Validate a whole submission in order, so that two actions competing for the same cash are resolved deterministically by sequence. */
  validateBatch(draft: SessionState, actions: readonly SubmittedAction[]): ActionValidationResult[];
}

/* -------------------------------------------------------------------------- */
/*  Quarter resolver                                                           */
/* -------------------------------------------------------------------------- */

/** Everything the resolver returns for one quarter. */
export interface QuarterResolutionOutcome {
  readonly nextState: SessionState;
  readonly report: ResolutionReport;
  readonly events: SimEvent[];
  readonly invariants: InvariantCheckResult[];
  /** False when an invariant failed: the quarter did not commit and `nextState` is the restored pre-resolution state. */
  readonly committed: boolean;
}

/**
 * The whole of `F` in `S_{t+1} = F(S_t, actions, modifiers, seed)`.
 *
 * Idempotent by contract: resolving a quarter that has already committed must
 * return the same outcome without mutating anything. Deterministic by contract:
 * the same state, the same recorded decisions and the same seed produce a
 * byte-identical `stateHashAfter`.
 *
 * `gmProposal` may be null. An LLM outage is not an error condition: the engine
 * falls back to deterministic template modifiers for the drawn candidates and
 * the game continues.
 */
export interface QuarterResolver {
  resolveQuarter(
    state: SessionState,
    submittedActions: readonly SubmittedAction[],
    gmProposal: GmProposalBatch | null,
    npcBundles: readonly NpcActionBundle[],
  ): QuarterResolutionOutcome;
}

/* -------------------------------------------------------------------------- */
/*  Composition                                                                */
/* -------------------------------------------------------------------------- */

/** The full set of subsystems the resolver composes. */
export interface Subsystems {
  readonly economy: EconomySubsystem;
  readonly markets: MarketsSubsystem;
  readonly companies: CompaniesSubsystem;
  readonly research: ResearchSubsystem;
  readonly government: GovernmentSubsystem;
  readonly boards: BoardsSubsystem;
  readonly relationships: RelationshipsSubsystem;
  readonly social: SocialSubsystem;
  readonly actionValidator: ActionValidator;
  /**
   * Optional, and optional on purpose: an engine composed without it resolves
   * exactly as it did before capital entities existed, which is what world 1
   * and every existing fixture rely on.
   */
  readonly capitalDesks?: CapitalDesksSubsystem;
}

/**
 * Canonical state hashing. Must be stable across processes and platforms:
 * key order normalised, floats rounded to a fixed precision, no timestamps.
 * Implemented in `@frontier/shared`.
 */
export type StateHasher = (state: SessionState) => string;

/** Engine construction options. Everything here is data, never behaviour. */
export interface EngineOptions {
  readonly hashState: StateHasher;
  readonly createRng: (seed: string) => SeededRng;
  /** Rounding precision applied to monetary values before hashing. */
  readonly moneyPrecision: number;
}

/* -------------------------------------------------------------------------- */
/*  Diagnostics                                                                */
/* -------------------------------------------------------------------------- */

export const EnginePhaseTimingSchema = z
  .object({
    quarter: QuarterIndexSchema,
    phase: z.string(),
    durationMs: z.number().min(0),
    eventsEmitted: z.number().int().min(0),
  })
  .describe('Per-phase diagnostics. Never an input to the simulation; timing must not influence any outcome.');
export type EnginePhaseTiming = z.infer<typeof EnginePhaseTimingSchema>;

