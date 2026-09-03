/**
 * The engine, in the browser.
 *
 * `@frontier/simulation` is pure TypeScript with no I/O, no clock and no
 * `Math.random`, so demo mode runs the real engine client-side against the real
 * demo world. The store in `provider.tsx` is a thin wrapper over what lives
 * here; nothing in this module holds React state.
 *
 * > LLMs are allowed to think, propose, negotiate, communicate and reinterpret
 * > the future; only the simulation engine is allowed to make reality.
 */

import type {
  ActionIntent,
  ActionType,
  ActionValidationResult,
  GmProposalBatch,
  NewGameSetupInput,
  NpcActionBundle,
  ResolverContext,
  SessionDifficulty,
  SessionState,
  SubmittedAction,
  WorldEventCandidate,
} from '@frontier/contracts';
import { CONFIRMATION_REQUIRED_ACTIONS, SessionStateSchema } from '@frontier/contracts';
import { createRng } from '@frontier/shared';
import {
  DEMO_PLAYER_ID,
  DEMO_SEED,
  controlledCompaniesOf,
  createDefaultEngine,
  demoSessionInput,
  phaseStream,
  type FrontierEngine,
  type FrontierResolutionOutcome,
} from '@frontier/simulation';

export { DEMO_CHARACTERS, DEMO_COMPANIES, DEMO_PLAYER_ID, DEMO_SEED } from '@frontier/simulation';

/* -------------------------------------------------------------------------- */
/*  The engine singleton                                                       */
/* -------------------------------------------------------------------------- */

let engineInstance: FrontierEngine | null = null;

/**
 * The process-wide engine. Stateless by construction: every session's state
 * lives in the `SessionState` handed to `resolveQuarter`, so one instance can
 * serve every session in the tab.
 */
export function getEngine(): FrontierEngine {
  if (engineInstance === null) engineInstance = createDefaultEngine();
  return engineInstance;
}

/* -------------------------------------------------------------------------- */
/*  Sessions                                                                   */
/* -------------------------------------------------------------------------- */

/** Options for a new demo session. */
export interface NewGameOptions {
  readonly seed?: number;
  readonly difficulty?: SessionDifficulty;
  readonly autoExecuteRoutine?: boolean;
  /** Company name, founder name, background, sector and region. Omit for the default world. */
  readonly setup?: NewGameSetupInput;
}

/**
 * Build a fresh demo session at 2027 Q1.
 *
 * The world data is fixed; the seed enters through `SessionState.seed` and the
 * session id. Same seed, same starting state, byte for byte. An optional `setup`
 * renames the player company and founder and reshapes the player company; with
 * none, the world is today's default.
 */
export function createSession(options: NewGameOptions = {}): SessionState {
  const seed = Number.isFinite(options.seed) ? Number(options.seed) : DEMO_SEED;
  const input = demoSessionInput(seed, options.setup);
  const difficulty = options.difficulty ?? 'standard';
  const autoExecute = options.autoExecuteRoutine ?? false;

  return SessionStateSchema.parse({
    ...input,
    config: { ...input.config, difficulty, autoExecuteRoutineDefault: autoExecute },
    players: (input.players ?? []).map((player) => ({ ...player, autoExecuteRoutine: autoExecute })),
  });
}

/** The seed of a session, as a number, for display and for the save file. */
export function seedOf(session: SessionState): number {
  const parsed = Number(session.seed);
  return Number.isFinite(parsed) ? parsed : DEMO_SEED;
}

/** A structural deep copy that survives the shapes `SessionState` uses. */
export function cloneSession(state: SessionState): SessionState {
  if (typeof structuredClone === 'function') return structuredClone(state);
  return JSON.parse(JSON.stringify(state)) as SessionState;
}

/* -------------------------------------------------------------------------- */
/*  Player context                                                             */
/* -------------------------------------------------------------------------- */

/** The single-player seat in a demo session. */
export const PLAYER_ID = DEMO_PLAYER_ID;

/** The player's seat, or null in the (impossible in demo) case there is none. */
export function playerSeat(session: SessionState) {
  return session.players.find((player) => player.playerId === PLAYER_ID) ?? session.players[0] ?? null;
}

/**
 * The player's FOUNDING company — `players[].companyId`, set once and never
 * reassigned. Every screen that means "my own company" as opposed to "a
 * company I also happen to direct" reads this, not `controllerPlayerId`:
 * STAGE 4 lets a controller direct several companies at once (see
 * `controlledCompaniesOf` in `@frontier/simulation`), and scanning for *any*
 * company whose `controllerPlayerId` is the seat would answer this with
 * whichever one happens to sort first once a subsidiary also carries it.
 */
export function playerCompanyOf(session: SessionState) {
  const seat = playerSeat(session);
  if (seat !== null) {
    const byId = session.companies.find((company) => company.id === seat.companyId);
    if (byId !== undefined) return byId;
  }
  // The seat's own company id could not be found — a malformed save, not the
  // normal path. Falling back to any company this seat directs beats
  // throwing, and is still better than the first company in the list.
  const byController = session.companies.find((company) => company.controllerPlayerId === PLAYER_ID);
  if (byController !== undefined) return byController;
  const first = session.companies[0];
  if (first === undefined) throw new Error('Session contains no companies.');
  return first;
}

/** The founder character the player is. */
export function playerCharacterOf(session: SessionState) {
  const seat = playerSeat(session);
  const bySeat = seat === null ? undefined : session.characters.find((character) => character.id === seat.characterId);
  if (bySeat !== undefined) return bySeat;
  const byFlag = session.characters.find((character) => character.isPlayer);
  if (byFlag !== undefined) return byFlag;
  const first = session.characters[0];
  if (first === undefined) throw new Error('Session contains no characters.');
  return first;
}

/* -------------------------------------------------------------------------- */
/*  Actions                                                                    */
/* -------------------------------------------------------------------------- */

/** True when this action type may never be executed without a human clicking. */
export function needsConfirmation(type: ActionType): boolean {
  return CONFIRMATION_REQUIRED_ACTIONS.includes(type);
}

/**
 * Build a `SubmittedAction` around an intent.
 *
 * The id is deterministic from session, quarter and sequence — never random —
 * so a replay of the recorded action log reproduces the session exactly.
 */
export function buildSubmittedAction(
  session: SessionState,
  intent: ActionIntent,
  sequence: number,
  options: { readonly origin?: SubmittedAction['origin']; readonly confirmedByHuman?: boolean } = {},
): SubmittedAction {
  return buildSubmittedActionForCompany(session, intent, sequence, playerCompanyOf(session).id, options);
}

/**
 * Build a `SubmittedAction` acting as an explicit company the seat controls.
 *
 * STAGE 5: a controller may direct any company in `controlledCompaniesOf`, not
 * only the one they founded — the switcher decides which company is "acting",
 * and this is what lets a queued instruction carry that company as
 * `actorCompanyId` instead of always the founding one. The character is always
 * the human founder's own: `overrulesSubsidiaryCeo` in the validator lets a
 * controller take `CEO_ONLY_ACTIONS` on a company they control whatever
 * character submits it, so there is no reason to invent a different actor here
 * — and every relationship consequence of overruling a subsidiary's incumbent
 * management is attributed to the one person actually making the call.
 *
 * Not itself validated against `controlledCompaniesOf`: that is the
 * validator's job (`not_controller_of_company`), the same as every other
 * refusal. This only shapes the envelope.
 */
export function buildSubmittedActionForCompany(
  session: SessionState,
  intent: ActionIntent,
  sequence: number,
  companyId: string,
  options: { readonly origin?: SubmittedAction['origin']; readonly confirmedByHuman?: boolean } = {},
): SubmittedAction {
  const character = playerCharacterOf(session);
  return {
    actionId: `act_${session.sessionId}_q${session.quarter}_${sequence}`,
    sessionId: session.sessionId,
    quarter: session.quarter,
    sequence,
    actorPlayerId: PLAYER_ID,
    actorCompanyId: companyId,
    actorCharacterId: character.id,
    origin: options.origin ?? 'player_ui',
    intent,
    confirmedByHuman: options.confirmedByHuman ?? !needsConfirmation(intent.type),
  };
}

/**
 * Re-validate one already-built `SubmittedAction` exactly as recorded — its
 * own `actorPlayerId`, `actorCompanyId` and `actorCharacterId`, not the
 * current seat's. Used to re-check a stored queue entry on load and to
 * re-confirm one still queued: both cases must judge the action as it was
 * actually submitted, which for STAGE 5 may be a subsidiary rather than the
 * founding company.
 */
export function validateSubmittedAction(session: SessionState, action: SubmittedAction): ActionValidationResult {
  const [result] = getEngine().validator.validateBatch(session, [action]);
  return (
    result ?? {
      actionId: action.actionId,
      status: 'rejected',
      reasons: ['The action could not be re-validated.'],
      codes: ['illegal_value'],
      clampedAction: null,
    }
  );
}

/**
 * Validate a preview for an explicit acting company.
 *
 * `ActionValidator.validate` (the single-intent preview) always resolves the
 * acting company from the seat's `companyId` — the founding company — because
 * an `ActionIntent` carries no company of its own (see its doc comment in
 * `@frontier/simulation`). That is the right default everywhere except a
 * screen that means "as the company I am currently directing", which is what
 * the switcher exists for — so this builds the same one-element batch a real
 * queue submission would and reads `validateBatch`'s answer for it instead,
 * which resolves the actor from `actorCompanyId` directly.
 */
export function validateIntentForCompany(session: SessionState, intent: ActionIntent, companyId: string): ActionValidationResult {
  const preview = buildSubmittedActionForCompany(session, intent, 0, companyId, { confirmedByHuman: true });
  const [result] = getEngine().validator.validateBatch(session, [preview]);
  return (
    result ?? {
      actionId: preview.actionId,
      status: 'rejected',
      reasons: ['The preview could not be validated.'],
      codes: ['illegal_value'],
      clampedAction: null,
    }
  );
}

/**
 * The active company id, corrected for a seat that no longer controls it.
 *
 * `activeCompanyId` is client UI state, not engine state (STAGE 5): the store
 * carries whatever the player last switched to, and this is the one place
 * that reconciles it against a session that may have moved on — a subsidiary
 * sold off, absorbed, or wound up — falling back to the founding company,
 * which every seat always controls. Also the answer for a candidate of `null`
 * (nothing stored yet, e.g. a fresh tab).
 */
export function resolveActiveCompanyId(session: SessionState, candidateId: string | null): string {
  const founding = playerCompanyOf(session).id;
  if (candidateId === null) return founding;
  const controlled = controlledCompaniesOf(session, PLAYER_ID);
  return controlled.some((company) => company.id === candidateId) ? candidateId : founding;
}

/* -------------------------------------------------------------------------- */
/*  Resolving without a way to get stuck                                       */
/* -------------------------------------------------------------------------- */

/** What one attempt to resolve a quarter produced, including its own failure. */
export interface ResolveAttempt {
  /** The outcome, or null when the engine threw on both attempts. */
  readonly outcome: FrontierResolutionOutcome | null;
  /** The World Director proposal the surviving attempt actually used. */
  readonly gmProposal: GmProposalBatch | null;
  /** The NPC bundles the surviving attempt actually used. */
  readonly npcBundles: readonly NpcActionBundle[];
  /** Why nothing resolved, or null. */
  readonly error: string | null;
}

/**
 * Resolve a quarter and never throw.
 *
 * `resolveQuarter` throws `InvariantViolationError` for the four engine
 * invariants — `deterministic_replay`, `auditability`, `agent_reproducibility`,
 * `failure_mode` — and those are checks over the ledger this resolve just
 * produced, so they are deterministic in the input state and independent of
 * anything the model contributed. Retrying offline therefore fixes a bad
 * proposal and cannot fix a subsystem fault, and the caller has to be told which
 * happened rather than being left holding a rejected promise behind a
 * full-screen overlay with no dismiss control.
 *
 * The returned `gmProposal`/`npcBundles` are the inputs of the attempt that
 * *survived*, so a caller recording them for replay records what happened rather
 * than what was attempted.
 */
export function resolveQuarterSafely(
  session: SessionState,
  submitted: readonly SubmittedAction[],
  gmProposal: GmProposalBatch | null,
  npcBundles: readonly NpcActionBundle[],
  resolve: (
    state: SessionState,
    actions: readonly SubmittedAction[],
    proposal: GmProposalBatch | null,
    bundles: readonly NpcActionBundle[],
  ) => FrontierResolutionOutcome = (state, actions, proposal, bundles) =>
    getEngine().resolver.resolveQuarter(state, actions, proposal, bundles),
): ResolveAttempt {
  try {
    return { outcome: resolve(session, submitted, gmProposal, npcBundles), gmProposal, npcBundles, error: null };
  } catch {
    // Anything the model contributed is discarded and the quarter resolves
    // fully offline. The game never blocks on a model.
  }
  try {
    return { outcome: resolve(session, submitted, null, []), gmProposal: null, npcBundles: [], error: null };
  } catch (error) {
    return {
      outcome: null,
      gmProposal: null,
      npcBundles: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * A monotonic sequence allocator, held outside React state.
 *
 * `actionId` is derived from the sequence number, so two actions queued from
 * one event handler must not read the same one. React batches a discrete event
 * — the component does not re-render between the iterations of a bulk approve —
 * so a sequence read from rendered state is the *same* number every time round
 * the loop, and every action minted in that loop collides on its id. The
 * allocator increments on call rather than on render, which is the only thing
 * that makes the ids unique. It is reset when the queue is emptied for a new
 * quarter, a new game or a load.
 */
export interface SequenceAllocator {
  /** Take the next number. Never returns the same value twice between resets. */
  next(): number;
  reset(value?: number): void;
  /** The number `next()` will return, without taking it. */
  peek(): number;
}

export function createSequenceAllocator(start = 0): SequenceAllocator {
  let value = start;
  return {
    next: () => {
      const current = value;
      value += 1;
      return current;
    },
    reset: (next = 0) => {
      value = next;
    },
    peek: () => value,
  };
}

/* -------------------------------------------------------------------------- */
/*  World Director candidates                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Recompute the hazard engine's candidate skeletons for the open quarter,
 * exactly as `resolveQuarter` will.
 *
 * The stream is forked identically — `seed -> quarter:N -> phase:world_events`
 * — and `updateMacro` is drawn first, so the candidate ids handed to the World
 * Director are the ids the resolver will match proposals against. Runs against
 * a clone; the live session is never touched.
 *
 * Returns an empty array if anything at all goes wrong: an absent proposal is a
 * degraded quarter, never a blocked one.
 */
export function drawWorldCandidates(session: SessionState): WorldEventCandidate[] {
  try {
    const engine = getEngine();
    const draft = cloneSession(session);
    const rng = phaseStream(createRng(String(draft.seed)).fork(`quarter:${draft.quarter}`), 'world_events');
    const ctx: ResolverContext = {
      quarter: draft.quarter,
      rng,
      emit: () => 'evt_preview',
      log: () => undefined,
    };
    engine.subsystems.economy.updateMacro(draft, ctx);
    return engine.subsystems.economy.computeEventCandidates(draft, ctx);
  } catch {
    return [];
  }
}
