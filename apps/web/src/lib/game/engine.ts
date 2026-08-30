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
  createDefaultEngine,
  demoSessionInput,
  phaseStream,
  type FrontierEngine,
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
}

/**
 * Build a fresh demo session at 2027 Q1.
 *
 * The world data is fixed; the seed enters through `SessionState.seed` and the
 * session id. Same seed, same starting state, byte for byte.
 */
export function createSession(options: NewGameOptions = {}): SessionState {
  const seed = Number.isFinite(options.seed) ? Number(options.seed) : DEMO_SEED;
  const input = demoSessionInput(seed);
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

/** The company the player directs. */
export function playerCompanyOf(session: SessionState) {
  const seat = playerSeat(session);
  const byController = session.companies.find((company) => company.controllerPlayerId === PLAYER_ID);
  if (byController !== undefined) return byController;
  if (seat !== null) {
    const byId = session.companies.find((company) => company.id === seat.companyId);
    if (byId !== undefined) return byId;
  }
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
  const company = playerCompanyOf(session);
  const character = playerCharacterOf(session);
  return {
    actionId: `act_${session.sessionId}_q${session.quarter}_${sequence}`,
    sessionId: session.sessionId,
    quarter: session.quarter,
    sequence,
    actorPlayerId: PLAYER_ID,
    actorCompanyId: company.id,
    actorCharacterId: character.id,
    origin: options.origin ?? 'player_ui',
    intent,
    confirmedByHuman: options.confirmedByHuman ?? !needsConfirmation(intent.type),
  };
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
