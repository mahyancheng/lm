/**
 * @frontier/simulation — resolver
 *
 * `F` in `S_{t+1} = F(S_t, A_player, A_agents, M_world, ε_seed)`.
 *
 * Nineteen phases, in the order `RESOLUTION_PHASES` declares them, each one
 * forking its own random stream and calling the subsystems that own it. The
 * order is part of the contract, not decoration: an acquisition approved by a
 * board in phase five alters the purchaser's cash in phase six, before the
 * market prices in phase thirteen; a secret research setback in phase nine never
 * reaches phase twelve, so it never reaches the share price.
 *
 * ## What the resolver itself is responsible for
 *
 * Most of the work belongs to subsystems, which are injected. The resolver owns
 * the things that are nobody else's:
 *
 * - **Idempotency.** A quarter that has already committed is refused, and
 *   nothing is mutated.
 * - **The World Director gate.** Proposals are clamped into the impact budget;
 *   a missing proposal falls back to the drawn candidates rather than blocking.
 * - **Action collection.** Player submissions and NPC bundles are validated by
 *   the same validator and reduced to `pendingActions`, which every later phase
 *   treats as the set of things that are actually going to happen. A bundle that
 *   names a company its strategist was not asked to run is refused there.
 * - **Capital, disclosure and leaderboards.** Rounds, debt, issuance, buybacks,
 *   listings and acquisitions; the private-to-public bridge; the ten boards.
 * - **The ledger.** Sequence numbers, the two hash chains, and the report whose
 *   every line traces to a committed row.
 * - **The invariant gate.** Balance sheets, cap tables, prices and the
 *   information boundary, checked before anything commits.
 * - **Projection.** `projectResolutionOutcomeForPlayer` cuts the quarter down to
 *   one seat's entitlement. The resolver returns the whole truth; nothing but
 *   the engine is allowed to hold it.
 *
 * ## Determinism
 *
 * No `Math.random`, no clock, no ambient I/O. The random stream is forked from
 * the session seed and the quarter index, then per phase, so adding a draw in
 * one phase cannot shift another's sequence. `durationMs` on every phase report
 * is zero by construction — a wall-clock reading inside `resolveQuarter` would
 * make two runs of the same seed disagree.
 */

import type {
  EngineOptions,
  EnginePhaseTiming,
  GmProposalBatch,
  InvariantCheckResult,
  QuarterResolutionOutcome,
  QuarterResolver,
  ResolutionPhase,
  ResolutionReport,
  ResolverContext,
  SeededRng,
  SessionSnapshot,
  SessionState,
  SimEvent,
  SubmittedAction,
  Subsystems,
} from '@frontier/contracts';
import { RESOLUTION_PHASES, quarterLabel } from '@frontier/contracts';
import { createRng, createStateHasher, hashState } from '@frontier/shared';
import { ResolutionRecorder } from './ledger';
import { buildFallbackBatch, canMaterialise, clampGmBatch, impactBudgetFor } from './gm';
import { collectActions, pendingOfType, reviewActions } from './actions';
import type { NpcBundleInput } from './actions';
import {
  applyDataPolicies,
  applyIntroductionRequests,
  applyResearchAbandonments,
  applyResearchAdjustments,
  ensureBoardProposals,
  ensureGovernmentBids,
  ensureResearchProjects,
  ensureSocialPosts,
} from './routing';
import { resolveCapital } from './capital';
import { resolveDisclosures } from './disclosure';
import { rebuildLeaderboards } from './leaderboards';
import { ENGINE_INVARIANTS, InvariantViolationError, runInvariantGate } from './invariants';
import { resolveControlChanges } from '../companies/control';
import { updateStrategistMemory } from '../companies/strategistMemory';

export { ResolutionRecorder, chainRowHash, rowFingerprint } from './ledger';
export { buildFallbackBatch, canMaterialise, clampGmBatch, impactBudgetFor } from './gm';
export type { ClampedGmBatch, GmRejection, CandidateMaterialiser } from './gm';
export { collectActions, reviewActions, pendingOfType, labelFor, summariseIntent } from './actions';
export type { ReviewedAction, NpcBundleInput, NpcBundleRefusal, NpcBundleSubmission } from './actions';
export {
  ensureBoardProposals,
  ensureGovernmentBids,
  ensureResearchProjects,
  applyResearchAdjustments,
  applyResearchAbandonments,
  applyDataPolicies,
  ensureSocialPosts,
  routeDeals,
  routeNodeLicences,
  applyIntroductionRequests,
  INTRODUCTION_THRESHOLD,
} from './routing';
export * from './capital';
export * from './disclosure';
export * from './leaderboards';
export { audienceFor, isEventVisibleTo, projectEconomyReportForPlayer, projectResolutionOutcomeForPlayer } from './projection';
export type { PlayerAudience, ProjectableOutcome, ProjectedOutcome } from './projection';
export {
  DISCLOSURE_ATTENTION,
  DISCLOSURE_KICKER,
  EVENT_KICKER,
  LEDGER_SUBJECT_KEYS,
  POST_HEADLINE_MAX,
  POST_KICKER,
  PUBLIC_RECORD_DEFAULT_LIMIT,
  STORY_KICKER,
  buildLedgerIndex,
  clipHeadline,
  headlineFromText,
  ledgerIdsFor,
  peopleLabel,
  planFolds,
  projectEditionIndex,
  projectPublicRecord,
  quartersToRun,
  severityLabel,
  worldEventVisibleTo,
} from './publicRecord';
export type { EditionSummary, FoldPlan, LedgerIndex, LedgerSubjectKey, PublicRecordOptions } from './publicRecord';
export { ENGINE_INVARIANTS, InvariantViolationError, runInvariantGate } from './invariants';
export type { InvariantGateInput } from './invariants';

/* -------------------------------------------------------------------------- */
/*  Options                                                                    */
/* -------------------------------------------------------------------------- */

/** Engine defaults. Everything here is data, never behaviour. */
export const DEFAULT_ENGINE_OPTIONS: EngineOptions = {
  hashState,
  createRng,
  moneyPrecision: 2,
};

/** Construction options for the resolver. */
export interface ResolverOptions extends Partial<EngineOptions> {
  /**
   * Treat *every* invariant failure as an engine fault and throw, rather than
   * returning an uncommitted quarter for the state invariants. Off by default,
   * because a world that fails an invariant is a legitimate — if alarming —
   * outcome the session has to survive; on in the invariant test suite, where
   * any failure at all is a bug.
   */
  readonly strictInvariants?: boolean;
}

/** The outcome, with the snapshot and diagnostics the contract type omits. */
export interface FrontierResolutionOutcome extends QuarterResolutionOutcome {
  /** `post_commit` when the quarter committed, `pre_resolution` when it did not. */
  readonly snapshot: SessionSnapshot;
  readonly phaseTimings: readonly EnginePhaseTiming[];
}

/**
 * `QuarterResolver`, narrowed to the richer outcome this engine returns.
 *
 * `npcBundles` is widened, not narrowed: a caller that knows which company it
 * asked a strategist to plan for may pass `{ requestedCompanyId, bundle }` so
 * the engine can refuse a bundle that names a different one. A bare bundle is
 * still accepted and is checked against the company it names.
 */
export interface FrontierQuarterResolver extends QuarterResolver {
  resolveQuarter(
    state: SessionState,
    submittedActions: readonly SubmittedAction[],
    gmProposal: GmProposalBatch | null,
    npcBundles: readonly NpcBundleInput[],
  ): FrontierResolutionOutcome;
}

/* -------------------------------------------------------------------------- */
/*  The resolver                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Build the quarter resolver over a set of subsystems.
 *
 * The subsystems are injected rather than imported, which is what allows the
 * pipeline to be tested against stubs: the phase order, the fork-per-phase rule,
 * the idempotency guard and the invariant gate are all properties of this file
 * and are verified without a single line of economy or market code.
 */
export function createQuarterResolver(subsystems: Subsystems, options: ResolverOptions = {}): FrontierQuarterResolver {
  const moneyPrecision = options.moneyPrecision ?? DEFAULT_ENGINE_OPTIONS.moneyPrecision;
  const engine: EngineOptions = {
    // Money is rounded to `moneyPrecision` before hashing, so a cent of
    // floating-point noise in a nine-figure balance cannot break replay
    // equality. Unit intervals and price indices keep their full precision.
    hashState: options.hashState ?? createStateHasher(moneyPrecision),
    createRng: options.createRng ?? DEFAULT_ENGINE_OPTIONS.createRng,
    moneyPrecision,
  };
  const strict = options.strictInvariants === true;
  const hash = (value: unknown): string => engine.hashState(value as SessionState);

  return {
    resolveQuarter(
      state: SessionState,
      submittedActions: readonly SubmittedAction[],
      gmProposal: GmProposalBatch | null,
      npcBundles: readonly NpcBundleInput[],
    ): FrontierResolutionOutcome {
      const quarter = state.quarter;
      const preResolutionHash = hash(state);

      /* --- idempotency: a quarter cannot resolve twice --------------------- */
      const quarterWasOpen = state.lastResolvedQuarter === null || state.lastResolvedQuarter < quarter;
      if (!quarterWasOpen || state.status === 'completed' || state.status === 'abandoned') {
        return refuse(state, quarter, preResolutionHash, quarterWasOpen);
      }

      /* --- the draft -------------------------------------------------------- */
      const draft = cloneState(state);
      draft.status = 'resolving';
      const recorder = new ResolutionRecorder(draft, hash, preResolutionHash);
      const rootRng = engine.createRng(String(draft.seed)).fork(`quarter:${quarter}`);

      recorder.beginPhase('world_events');
      recorder.emit({
        sessionId: draft.sessionId,
        quarter,
        type: 'quarter_opened',
        actorId: null,
        targetId: null,
        payload: {
          label: quarterLabel(draft.startYear, quarter),
          submittedActions: submittedActions.length,
          npcBundles: npcBundles.length,
          gmProposal: gmProposal === null ? 'absent' : `${gmProposal.proposals.length} proposal(s)`,
        },
        visibility: 'public',
      });

      /* --- the nineteen phases ----------------------------------------------- */
      const timings: EnginePhaseTiming[] = [];
      let balanceCheckCount = 0;

      for (const phase of RESOLUTION_PHASES) {
        const before = recorder.events.length;
        recorder.beginPhase(phase);
        const rng = phaseStream(rootRng, phase);
        const ctx = recorder.contextFor(phase, rng);

        switch (phase) {
          case 'world_events':
            runWorldEvents(draft, ctx, subsystems, gmProposal);
            break;

          case 'gm_modifiers':
            subsystems.economy.applyModifiers(draft, ctx);
            subsystems.economy.decayModifiers(draft, ctx);
            break;

          case 'information_reveal':
            subsystems.economy.revealInformation(draft, ctx);
            break;

          case 'action_collection': {
            const queued = collectActions(draft, submittedActions, npcBundles, ctx);
            reviewActions(draft, subsystems.actionValidator, queued, ctx);
            // NPC defaults run after validation so a background company only
            // acts where its strategist did not, and so its own actions face
            // exactly the rules everyone else's do.
            subsystems.companies.applyNpcDefaults(draft, ctx);
            // The capital desks run last in this phase, so they see what the
            // world already decided this quarter, and on a stream forked inside
            // the subsystem, so they cannot move the hiring jitter above.
            subsystems.capitalDesks?.runCapitalDesks(draft, ctx);
            break;
          }

          case 'board_resolution':
            ensureBoardProposals(draft, ctx);
            subsystems.boards.applyCommitments(draft, ctx);
            subsystems.boards.resolveProposals(draft, ctx);
            break;

          case 'capital_resolution':
            resolveCapital(draft, ctx);
            // After the deal router, so an accepted term sheet is already
            // recorded as accepted before the round closes against it.
            subsystems.capitalDesks?.resolveSponsorCapital(draft, ctx);
            break;

          case 'government_resolution':
            subsystems.government.openOpportunities(draft, ctx);
            ensureGovernmentBids(draft, ctx);
            subsystems.government.scoreBids(draft, ctx);
            subsystems.government.awardContracts(draft, ctx);
            subsystems.government.advanceMilestones(draft, ctx);
            break;

          case 'talent_resolution':
            subsystems.companies.resolveHiring(draft, ctx);
            break;

          case 'research_resolution': {
            ensureResearchProjects(draft, ctx);
            // Re-resourcing lands before the quarter is advanced, so the fix a
            // founder made this quarter is the resourcing this quarter runs on.
            applyResearchAdjustments(draft, ctx);
            // Closing a programme lands before it too, so a programme abandoned
            // this quarter costs nothing this quarter. Both are world 3's only
            // way out of a blocked programme and cost nothing in worlds 1 and 2,
            // which never submit either action.
            applyResearchAbandonments(draft, ctx);
            applyDataPolicies(draft, ctx);
            subsystems.research.advanceProjects(draft, ctx);
            subsystems.research.achieveNodes(draft, ctx);
            subsystems.research.updateTechConfidence(draft, ctx);
            for (const { intent } of pendingOfType(draft, 'propose_innovation')) {
              subsystems.research.integrateInnovationProposal(draft, intent.proposal, ctx);
            }
            break;
          }

          case 'node_market_resolution':
            // World 3 only, and the whole phase: every node in the table is
            // priced from last quarter's supply and demand before a single unit
            // is sold against those prices. A no-op in worlds 1 and 2.
            subsystems.economy.priceNodes(draft, ctx);
            break;

          case 'product_demand_resolution':
            subsystems.companies.resolveProducts(draft, ctx);
            break;

          case 'financial_resolution': {
            const financials = subsystems.companies.resolveFinancials(draft, ctx);
            balanceCheckCount = financials.balanceChecks.length;
            break;
          }

          case 'disclosure_resolution':
            resolveDisclosures(draft, ctx);
            subsystems.capitalDesks?.publishSponsorDisclosures(draft, ctx);
            break;

          case 'market_resolution':
            subsystems.markets.updateBeliefs(draft, ctx);
            subsystems.markets.priceMarket(draft, ctx);
            subsystems.markets.settleTrades(draft, ctx);
            // Shorts settle after the market prices, so a short opened this
            // quarter is struck at this quarter's quote and its profit and loss
            // lands next quarter. Plannable, and stated.
            subsystems.capitalDesks?.settleShorts(draft, ctx);
            // Last in the phase: every mechanism that can hand a company a
            // decisive stake without a formal acquire_company offer — a
            // buy_shares order settled just above, a term sheet or a PE
            // tender/LBO/activist win from capital_resolution earlier this
            // quarter — has run by now, so this is the one point in the
            // quarter where `controllerPlayerId` can be brought current.
            resolveControlChanges(draft, ctx);
            break;

          case 'social_resolution':
            ensureSocialPosts(draft, ctx);
            subsystems.social.propagatePosts(draft, ctx);
            subsystems.social.updateMediaStories(draft, ctx);
            break;

          case 'relationship_update':
            applyIntroductionRequests(draft, ctx, (from, to) => subsystems.relationships.checkAccess(draft, from, to).allowed);
            subsystems.relationships.updateRelationships(draft, ctx);
            subsystems.relationships.decayMemories(draft, ctx);
            subsystems.relationships.recomputeConnectionLevels(draft, ctx);
            break;

          case 'leaderboard_update':
            subsystems.companies.recomputeMetrics(draft, ctx);
            subsystems.capitalDesks?.recomputeCapitalEntities(draft, ctx);
            rebuildLeaderboards(draft, ctx);
            // Last in the last phase that touches companies: every economic
            // phase has run, phase fifteen has already turned this quarter's
            // events into memories and feelings, and the ledger is complete but
            // for the commit and the snapshot. A company's memory is therefore
            // written from what happened, never from what was planned.
            updateStrategistMemory(draft, ctx, recorder.events);
            break;

          case 'ledger_commit':
          case 'snapshot':
            // Handled below, after the gate has decided whether to commit.
            break;

          default:
            break;
        }

        timings.push({
          quarter,
          phase,
          // Zero by construction: the engine may not read a clock.
          durationMs: 0,
          eventsEmitted: recorder.events.length - before,
        });
      }

      /* --- ledger_commit: the invariant gate -------------------------------- */
      recorder.beginPhase('ledger_commit');
      const commitCtx = recorder.contextFor('ledger_commit', phaseStream(rootRng, 'ledger_commit'));

      const invariants = runInvariantGate({
        draft,
        opening: state,
        events: recorder.events,
        lines: recorder.allLines(),
        startSequence: recorder.startSequence,
        preResolutionHash,
        droppedLines: recorder.droppedLineCount,
        gmProposalWasPresent: gmProposal !== null,
        quarterWasOpen,
      });
      const failures = invariants.filter((result) => !result.passed);

      if (failures.length > 0) {
        for (const failure of failures) {
          commitCtx.emit({
            sessionId: draft.sessionId,
            quarter,
            type: 'invariant_check_failed',
            actorId: null,
            targetId: failure.subjectId,
            payload: { invariant: failure.invariant, detail: failure.detail },
            visibility: 'private',
          });
          commitCtx.log({
            phase: 'ledger_commit',
            text: `The quarter did not commit: ${failure.invariant.replace(/_/g, ' ')} failed. ${failure.detail}`,
            deltaLabel: 'rolled back',
            refEventIds: [],
            tone: 'negative',
            subjectId: failure.subjectId,
          });
        }

        // Seal the refusal rows before anything reads them: a row is only whole
        // once its phase has closed.
        recorder.seal();
        const engineFault = failures.some((failure) => ENGINE_INVARIANTS.includes(failure.invariant));
        const report = buildReport(draft, recorder, quarter, preResolutionHash, hash(state), gmProposal, true);
        if (engineFault || strict) {
          throw new InvariantViolationError(
            `Quarter ${quarter} failed ${failures.length} invariant check(s): ${failures.map((f) => `${f.invariant} (${f.detail})`).join(' | ')}`,
            invariants,
            quarter,
          );
        }
        return {
          // The pre-resolution state, untouched. `events` below are diagnostic:
          // they describe a quarter that did not happen and must not be
          // persisted as though it had.
          nextState: state,
          report,
          events: [...recorder.events],
          invariants,
          committed: false,
          snapshot: snapshotOf(state, 'pre_resolution', preResolutionHash, recorder.startSequence),
          phaseTimings: timings,
        };
      }

      /* --- commit ------------------------------------------------------------ */
      pruneHistory(draft);
      draft.pendingActions = [];
      // Capital orders are this quarter's working set, exactly like pending
      // actions: written in phase four, settled in phase fourteen, gone at
      // commit. The key is only touched where it already exists, so world 1
      // still grows no `capitalOrders`.
      if (draft.capitalOrders !== undefined) draft.capitalOrders = [];
      draft.lastResolvedQuarter = quarter;
      draft.quarter = quarter + 1;
      draft.status = draft.config.quarterLimit !== null && draft.quarter >= draft.config.quarterLimit ? 'completed' : 'active';
      for (const player of draft.players) player.hasSubmittedThisQuarter = false;

      const committedEventId = commitCtx.emit({
        sessionId: draft.sessionId,
        quarter,
        type: 'quarter_committed',
        actorId: null,
        targetId: null,
        payload: {
          label: quarterLabel(draft.startYear, quarter),
          events: recorder.events.length,
          balanceChecks: balanceCheckCount,
          invariantsChecked: invariants.length,
          nextQuarter: draft.quarter,
        },
        visibility: 'public',
      });
      commitCtx.log({
        phase: 'ledger_commit',
        text: `${quarterLabel(draft.startYear, quarter)} committed with ${recorder.events.length} ledger rows and every invariant intact.`,
        deltaLabel: `${invariants.length} checks`,
        refEventIds: [committedEventId],
        tone: 'positive',
        subjectId: null,
      });

      /* --- snapshot ---------------------------------------------------------- */
      recorder.beginPhase('snapshot');
      const snapshotCtx = recorder.contextFor('snapshot', phaseStream(rootRng, 'snapshot'));
      const snapshotEventId = snapshotCtx.emit({
        sessionId: draft.sessionId,
        quarter,
        type: 'snapshot_created',
        actorId: null,
        targetId: null,
        payload: { phase: 'post_commit', lastSequence: draft.ledgerSequence },
        visibility: 'private',
      });
      const stateHashAfter = hash(draft);
      // The last phase closes on the hash the snapshot already needed, so the
      // committed state is hashed once rather than twice.
      recorder.seal(stateHashAfter);
      const snapshot = snapshotOf(draft, 'post_commit', stateHashAfter, draft.ledgerSequence);
      snapshotCtx.log({
        phase: 'snapshot',
        text: `Post-commit snapshot taken at ledger sequence ${draft.ledgerSequence}.`,
        deltaLabel: null,
        refEventIds: [snapshotEventId],
        tone: 'neutral',
        subjectId: null,
      });

      return {
        nextState: draft,
        report: buildReport(draft, recorder, quarter, preResolutionHash, stateHashAfter, gmProposal, false),
        events: [...recorder.events],
        invariants,
        committed: true,
        snapshot,
        phaseTimings: timings,
      };
    },
  };
}

/* -------------------------------------------------------------------------- */
/*  World events                                                               */
/* -------------------------------------------------------------------------- */

function runWorldEvents(draft: SessionState, ctx: ResolverContext, subsystems: Subsystems, gmProposal: GmProposalBatch | null): void {
  subsystems.economy.updateMacro(draft, ctx);
  // Goods prices, shortages and tolls settle before the hazard draw, so an
  // antitrust investigation is drawn against a world whose concentration is
  // already priced. Draws no random numbers, so the phase stream is unmoved.
  subsystems.economy.priceSectors(draft, ctx);
  const candidates = subsystems.economy.computeEventCandidates(draft, ctx);
  const budget = impactBudgetFor(draft);

  if (gmProposal !== null) {
    const clamped = clampGmBatch(gmProposal, candidates, budget);

    for (const rejection of clamped.rejections) {
      ctx.emit({
        sessionId: draft.sessionId,
        quarter: ctx.quarter,
        type: 'modifier_rejected',
        actorId: null,
        targetId: rejection.target ?? rejection.candidateId,
        payload: { candidateId: rejection.candidateId, target: rejection.target, reason: rejection.reason },
        visibility: 'private',
      });
    }

    const eventId = ctx.emit({
      sessionId: draft.sessionId,
      quarter: ctx.quarter,
      type: 'llm_call_logged',
      actorId: null,
      targetId: null,
      payload: {
        agentRole: 'world_director',
        proposalsReceived: gmProposal.proposals.length,
        proposalsAccepted: clamped.batch.proposals.length,
        modifiersClamped: clamped.clampedCount,
        severityUsed: Math.round(clamped.severityUsed * 1000) / 1000,
        severityBudget: budget.maxTotalSeverity,
        rejections: clamped.rejections.length,
      },
      visibility: 'private',
    });
    if (clamped.clampedCount > 0 || clamped.rejections.length > 0) {
      ctx.log({
        phase: 'world_events',
        text: `The World Director's proposal was bounded: ${clamped.clampedCount} value(s) clamped and ${clamped.rejections.length} refused before anything took effect.`,
        deltaLabel: `${clamped.batch.proposals.length}/${gmProposal.proposals.length} kept`,
        refEventIds: [eventId],
        tone: 'neutral',
        subjectId: null,
      });
    }

    subsystems.economy.applyGmProposals(draft, clamped.batch, candidates, ctx);
    return;
  }

  /* --- no World Director: a degraded quarter, never a blocked one ---------- */
  const eventId = ctx.emit({
    sessionId: draft.sessionId,
    quarter: ctx.quarter,
    type: 'fallback_engaged',
    actorId: null,
    targetId: null,
    payload: {
      agentRole: 'world_director',
      reason: 'no_proposal_supplied',
      strategy: 'Apply the candidate skeletons using their event family template modifiers at the drawn severity.',
      candidates: candidates.length,
    },
    visibility: 'private',
  });
  if (candidates.length > 0) {
    ctx.log({
      phase: 'world_events',
      text: `No World Director output this quarter: ${candidates.length} drawn event(s) fired on their family templates instead.`,
      deltaLabel: 'fallback',
      refEventIds: [eventId],
      tone: 'warning',
      subjectId: null,
    });
  }

  if (canMaterialise(subsystems.economy)) {
    let severityUsed = 0;
    let fired = 0;
    for (const candidate of candidates) {
      if (fired >= budget.maxEventsPerQuarter) break;
      const [low, high] = candidate.severityBand;
      const severity = Math.min(Math.max(candidate.suggestedSeverity, Math.min(low, high)), Math.max(low, high));
      if (severityUsed + severity > budget.maxTotalSeverity) continue;
      severityUsed += severity;
      fired += 1;
      subsystems.economy.materialiseCandidate(draft, candidate, ctx);
    }
    return;
  }

  subsystems.economy.applyGmProposals(draft, buildFallbackBatch(candidates, budget), candidates, ctx);
}

/* -------------------------------------------------------------------------- */
/*  Report, snapshot, housekeeping                                             */
/* -------------------------------------------------------------------------- */

function buildReport(
  draft: SessionState,
  recorder: ResolutionRecorder,
  quarter: number,
  hashBefore: string,
  hashAfter: string,
  gmProposal: GmProposalBatch | null,
  rolledBack: boolean,
): ResolutionReport {
  const events = recorder.events;
  const lines = recorder.allLines();
  const headline = rolledBack
    ? `${quarterLabel(draft.startYear, quarter)} did not commit: an invariant failed.`
    : headlineFor(draft, quarter, gmProposal, lines);

  return {
    sessionId: draft.sessionId,
    quarter,
    headline: clip(headline.length >= 3 ? headline : `Quarter ${quarter} resolved.`, 200),
    phases: recorder.phaseReports(),
    sequenceFrom: recorder.startSequence,
    sequenceTo: Math.max(recorder.startSequence, recorder.startSequence + events.length - 1),
    stateHashBefore: hashBefore,
    stateHashAfter: hashAfter,
  };
}

/** The one line at the top of the resolution screen. */
function headlineFor(
  draft: SessionState,
  quarter: number,
  gmProposal: GmProposalBatch | null,
  lines: readonly { text: string; tone: string }[],
): string {
  if (gmProposal !== null && gmProposal.quarterSummary.length >= 3) return gmProposal.quarterSummary;
  const notable = lines.find((line) => line.tone === 'negative') ?? lines.find((line) => line.tone === 'warning') ?? lines.find((line) => line.tone === 'positive');
  if (notable !== undefined) return notable.text;
  return `${quarterLabel(draft.startYear, quarter)} passed without material change.`;
}

/** A typed snapshot of a state at a point in the pipeline. */
function snapshotOf(state: SessionState, phase: 'pre_resolution' | 'post_commit', stateHash: string, lastSequence: number): SessionSnapshot {
  return {
    sessionId: state.sessionId,
    quarter: state.quarter,
    phase,
    stateHash,
    lastSequence,
    state,
  };
}

/**
 * How long a *settled* procurement record stays in live state after it closes.
 *
 * Twelve quarters — three years — for one reason: it is the window a player can
 * still act on. A contract that completed within three years is what a rival's
 * bid team, an agency's memory and the Government screen's history are made of;
 * one that completed five years ago has already been absorbed into
 * `governmentPastPerformance` and `contractorReputations`, which are scores on
 * the company and are never pruned.
 *
 * The consequence to know about: `refreshDeliveryStatistics` recomputes on-time
 * delivery from the contracts still in state, so past that horizon it is a
 * rolling three-year record rather than a lifetime one. That is how procurement
 * past performance actually works, and it is why the horizon is stated here
 * rather than buried at the call site.
 */
export const SETTLED_RECORD_HORIZON_QUARTERS = 12;

/**
 * How many quarters of the written public record the session carries.
 *
 * Twelve, against `quoteHistoryQuarters`'s twenty-four, because the two are not
 * the same kind of thing. A quote is four numbers a price chart draws, and six
 * years of them is a few kilobytes; a disclosure carries a headline, a body of
 * up to fifteen hundred characters and a metric bag, and six years of them for
 * every listed company in a twenty-seven-company world is two hundred
 * kilobytes of state that the whole session is hashed over once per ledger
 * phase, eighteen times a quarter. Nothing reads back further than a few
 * quarters — credibility is settled against a claim two quarters old, the news
 * screen shows the quarter, the desks read this quarter's filings — so three
 * years is generous, and the full record is in the ledger where it belongs.
 */
export const DISCLOSURE_WINDOW_QUARTERS = 12;

/**
 * Trim the rolling windows. History is not lost: quotes, disclosures, posts and
 * settled procurement records older than the window live on in snapshots and in
 * the ledger, which is where the audit trail belongs.
 *
 * Three windows, not one. Quotes, posts and stories follow
 * `quoteHistoryQuarters`, which a session configures; the written public record
 * follows the shorter `DISCLOSURE_WINDOW_QUARTERS`; procurement records follow
 * `SETTLED_RECORD_HORIZON_QUARTERS` and are only ever dropped once they are
 * *settled* — nothing still open, still evaluating, still active or still
 * referenced by something open is ever removed, however old it is.
 */
function pruneHistory(draft: SessionState): void {
  pruneSettledProcurement(draft);
  const oldestDisclosure = draft.quarter - DISCLOSURE_WINDOW_QUARTERS;
  if (oldestDisclosure > 0) draft.disclosures = draft.disclosures.filter((disclosure) => disclosure.quarter >= oldestDisclosure);
  const oldest = draft.quarter - draft.quoteHistoryQuarters;
  if (oldest <= 0) return;
  draft.quotes = draft.quotes.filter((quote) => quote.quarter >= oldest);
  draft.socialPosts = draft.socialPosts.filter((post) => post.quarter >= oldest);
  draft.mediaStories = draft.mediaStories.filter((story) => story.quarter >= oldest);
}

/**
 * Drop procurement records that are both settled and old.
 *
 * Left alone, `procurementOpportunities`, `governmentBids` and
 * `governmentContracts` only ever grow: two competitions can open every quarter,
 * every one of them accumulates a bid per interested company, and an awarded
 * contract is never removed once it completes. Over a long session that is
 * several kilobytes a quarter of state that nothing reads — which on a phone is
 * a crash rather than an inefficiency.
 *
 * The order matters: contracts are pruned first, then bids (a bid is kept while
 * the contract it won survives), then opportunities (kept while any bid or
 * contract still points at them). Nothing live is ever dropped.
 */
function pruneSettledProcurement(draft: SessionState): void {
  const horizon = draft.quarter - SETTLED_RECORD_HORIZON_QUARTERS;
  if (horizon <= 0) return;

  const contractSettled = (status: string): boolean => status === 'completed' || status === 'terminated';
  draft.governmentContracts = draft.governmentContracts.filter((contract) => {
    if (!contractSettled(contract.status)) return true;
    const lastActivity = contract.milestones.reduce(
      (latest, milestone) => Math.max(latest, milestone.completedQuarter ?? milestone.dueQuarter),
      contract.awardedQuarter,
    );
    return lastActivity >= horizon;
  });

  const liveOpportunityIds = new Set<string>();
  for (const opportunity of draft.procurementOpportunities) {
    if (opportunity.status === 'open' || opportunity.status === 'evaluating') liveOpportunityIds.add(opportunity.id);
  }
  const survivingContractOpportunityIds = new Set(draft.governmentContracts.map((contract) => contract.opportunityId));

  draft.governmentBids = draft.governmentBids.filter((bid) => {
    if (liveOpportunityIds.has(bid.opportunityId)) return true;
    if (survivingContractOpportunityIds.has(bid.opportunityId)) return true;
    return bid.submittedQuarter >= horizon;
  });

  const referencedOpportunityIds = new Set<string>([
    ...draft.governmentBids.map((bid) => bid.opportunityId),
    ...survivingContractOpportunityIds,
  ]);
  draft.procurementOpportunities = draft.procurementOpportunities.filter((opportunity) => {
    if (opportunity.status === 'open' || opportunity.status === 'evaluating') return true;
    if (referencedOpportunityIds.has(opportunity.id)) return true;
    return opportunity.closeQuarter >= horizon;
  });
}

/** The refusal returned when a quarter has already committed. */
function refuse(state: SessionState, quarter: number, stateHash: string, quarterWasOpen: boolean): FrontierResolutionOutcome {
  const detail = quarterWasOpen
    ? `Session ${state.sessionId} is ${state.status} and no longer resolves quarters.`
    : `Quarter ${quarter} has already committed (lastResolvedQuarter is ${String(state.lastResolvedQuarter)}). Resolution is idempotent: nothing was mutated.`;
  const invariants: InvariantCheckResult[] = [{ invariant: 'idempotency', passed: false, detail: detail.slice(0, 500), subjectId: null }];

  return {
    nextState: state,
    report: {
      sessionId: state.sessionId,
      quarter,
      headline: clip(detail, 200),
      phases: [],
      sequenceFrom: state.ledgerSequence,
      sequenceTo: state.ledgerSequence,
      stateHashBefore: stateHash,
      stateHashAfter: stateHash,
    },
    events: [] as SimEvent[],
    invariants,
    committed: false,
    snapshot: snapshotOf(state, 'pre_resolution', stateHash, state.ledgerSequence),
    phaseTimings: [],
  };
}

/**
 * Deep copy of the incoming state.
 *
 * `SessionState` is plain JSON by contract — no dates, no maps, no class
 * instances — so a JSON round trip is both a correct clone and a cheap
 * assertion that nothing non-serialisable has crept into the aggregate.
 */
export function cloneState(state: SessionState): SessionState {
  return JSON.parse(JSON.stringify(state)) as SessionState;
}

/** Fork a phase stream by the same rule the resolver uses. Exported for tests. */
export function phaseStream(root: SeededRng, phase: ResolutionPhase): SeededRng {
  return root.fork(`phase:${phase}`);
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
