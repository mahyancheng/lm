'use client';

/**
 * The demo game store.
 *
 * A React context over the **real** engine. `@frontier/simulation` is pure
 * TypeScript, so demo mode is not a mock: the same resolver, the same
 * eighteen phases, the same invariant gate, running in the tab.
 *
 * ```text
 *   queueAction(intent) ──▶ validator.validate ──▶ queuedActions
 *                                                      │
 *   endQuarter() ──▶ [live model, if any] ──▶ resolver.resolveQuarter
 *                                                      │
 *                            nextState ◀── committed ──┘
 * ```
 *
 * Two rules this file exists to keep:
 *
 * 1. **The client is never authoritative.** `queueAction` runs the validator
 *    only so the interface can tell the truth early; the engine validates
 *    again, and its answer is the one that counts.
 * 2. **The model is never load-bearing.** Every LLM call is wrapped, and every
 *    failure path resolves the quarter offline and deterministically.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type ReactNode,
} from 'react';
import type {
  ActionIntent,
  ActionValidationResult,
  Character,
  Company,
  CompanyQuarterMetrics,
  GmProposalBatch,
  Leaderboard,
  NewGameSetup,
  NewGameSetupInput,
  NpcActionBundle,
  PlayerView,
  Quote,
  SessionDifficulty,
  SessionState,
  SocialTextOverride,
  SubmittedAction,
  WorldState,
  WorldVersion,
} from '@frontier/contracts';
import { LEGACY_WORLD_VERSION, NewGameSetupSchema } from '@frontier/contracts';
import type { FrontierResolutionOutcome } from '@frontier/simulation';
import {
  MAX_LIVE_STRATEGISTS,
  applySocialTextOverrides,
  controlledCompaniesOf,
  projectResolutionOutcomeForPlayer,
  selectPostsForAuthoring,
  strategistPriority,
} from '@frontier/simulation';
import {
  LLM_QUARTER_BUDGET_MS,
  LLM_STRATEGISTS_PER_QUARTER,
  llmHealth,
  requestNpcBundle,
  requestSocialPost,
  requestWorldDirector,
  type LlmHealth,
} from '@/lib/llm/client';
import {
  DEMO_SEED,
  PLAYER_ID,
  buildSubmittedActionForCompany,
  createSession,
  createSequenceAllocator,
  needsConfirmation,
  playerCharacterOf,
  playerCompanyOf,
  resolveActiveCompanyId,
  resolveQuarterSafely,
  seedOf,
  validateIntentForCompany,
  validateSubmittedAction,
} from './engine';
import { readStoredActiveCompanyId, writeStoredActiveCompanyId } from './activeCompanyStorage';
import { buildNpcStrategistInput, buildSocialAuthorInput, buildWorldDirectorInput } from './briefings';
import { formatProgressStatus, type ProgressRow } from './resolveProgress';
import { clearStrategistPrefetch, hasStrategistPrefetch, startStrategistPrefetch, takeStrategistPrefetch } from './strategistPrefetch';
import {
  MAX_REPLAY_QUARTERS,
  SUPPORTED_SAVE_VERSIONS,
  buildSaveFile,
  clearSaveFile,
  clearSlot,
  exportSave,
  importSave,
  inspectSave,
  readSlotFile,
  replayAsync,
  storedSaveVersion,
  writeSaveFile,
  writeSlotFile,
  type LoadedGame,
  type SaveFile,
  type SaveInspection,
  type QuarterRecord,
  type ReplayProgress,
} from './persistence';
import { inspectSaveValue } from './saveFile';
import {
  founderNetWorth,
  leaderboardOf,
  marketCapOf,
  metricsFor,
  projectPlayerView,
  quotesFor,
} from './playerView';
import { saveSlotOf } from '@/lib/saves/plan';
import { saveSync } from '@/lib/saves/sync';

/* -------------------------------------------------------------------------- */
/*  Shapes                                                                     */
/* -------------------------------------------------------------------------- */

export interface GameSettings {
  readonly seed: number;
  readonly difficulty: SessionDifficulty;
  /** The new-game setup this session was started with, or null for the default world. Immutable once set. */
  readonly setup: NewGameSetup | null;
  /**
   * Which world scenario this session was built from. Derived from the setup —
   * that is what `createSession` dispatches on — and held here so a screen can
   * ask without reaching into the setup. Immutable once set.
   */
  readonly worldVersion: WorldVersion;
  /** Whether low-risk interpreted instructions may execute without a click. Never applies to the thirteen. */
  readonly autoExecuteRoutine: boolean;
  /** Player opt-out for the live model even when one is configured. */
  readonly useLiveModel: boolean;
  /** Whether the Quarter Resolution screen replays phases or jumps to the end. */
  readonly skipResolutionReveal: boolean;
}

/** One queued action with everything a screen needs to render its state. */
export interface QueuedActionEntry {
  readonly action: SubmittedAction;
  readonly validation: ActionValidationResult;
  /** True when the type is one of the thirteen that always need a human. */
  readonly needsConfirmation: boolean;
  /** True when it needs confirmation and has not had one: End Quarter blocks these. */
  readonly blocked: boolean;
}

export interface GameStoreState {
  readonly session: SessionState;
  /**
   * The company the player is currently directing — STAGE 5. Client UI state,
   * not engine state: never an input to `F`, never written to a `sim_event`,
   * and persisted separately from the save file (see `activeCompanyStorage.ts`
   * for why). Defaults to the founding company and is reconciled against
   * `controlledCompaniesOf` on every session change, so a company that leaves
   * the group — sold, wound up, absorbed — can never be left as the active
   * one; `useActiveCompany` is the read side.
   */
  readonly activeCompanyId: string;
  readonly queuedActions: readonly SubmittedAction[];
  readonly validations: Readonly<Record<string, ActionValidationResult>>;
  /** Every input to every resolved quarter, in order: the save, in memory. */
  readonly actionLog: readonly QuarterRecord[];
  /**
   * The last outcome **projected to this seat**. The engine returns the whole
   * quarter; a screen may only ever be handed the part of it this player is
   * entitled to, so the projection happens here, once, rather than in each
   * screen that reads a report or a ledger row.
   */
  readonly lastOutcome: FrontierResolutionOutcome | null;
  /** The world as it stood before the last resolve, for quarter-over-quarter deltas. */
  readonly previousWorld: WorldState | null;
  readonly resolving: boolean;
  /** Human-readable status shown on the resolving overlay. */
  readonly resolveStatus: string;
  readonly settings: GameSettings;
  /** False during the first render pass, before localStorage has been consulted. */
  readonly hydrated: boolean;
  /** True while a save is being replayed, with `loadProgress` for the indicator. */
  readonly loading: boolean;
  readonly loadProgress: ReplayProgress | null;
  /**
   * False when the store must not write over the stored save: a replay that did
   * not finish leaves the file alone rather than truncating it to the prefix
   * that happened to load.
   */
  readonly saveWritable: boolean;
  /**
   * True once this tab holds a game the player actually started — a new game or
   * a loaded save. The persist effect gates on this, not on resolved quarters:
   * a founding must survive a refresh, but the default just-visited session
   * must never write a save the player did not ask for.
   */
  readonly gameStarted: boolean;
  readonly llm: LlmHealth;
  /** A transient message for the shell to surface, or null. */
  readonly notice: string | null;
  /**
   * The lowest sequence number not yet taken, for display and diagnostics only.
   * The allocator in `GameProvider` is what actually mints them: a number read
   * from rendered state is the same number for every iteration of a bulk
   * approve, which is how a whole batch used to collide on one `actionId`.
   */
  readonly nextSequence: number;
}

export interface GameStoreActions {
  newGame(options?: { seed?: number; difficulty?: SessionDifficulty; autoExecuteRoutine?: boolean; setup?: NewGameSetupInput }): void;
  /**
   * Validate an intent without queuing it. Use for live previews and disabled
   * states. Defaults to the active company — the switcher's choice — so a
   * preview shown while directing a subsidiary answers for the subsidiary,
   * not the founding company; pass `companyId` to override.
   */
  validateIntent(intent: ActionIntent, companyId?: string): ActionValidationResult;
  /**
   * Validate and queue. Returns the entry so a caller can render the outcome
   * immediately. `options.companyId` names who is acting; it defaults to the
   * active company, so a screen switched to a subsidiary queues on its behalf
   * without every call site having to say so.
   */
  queueAction(
    intent: ActionIntent,
    options?: { origin?: SubmittedAction['origin']; confirmed?: boolean; companyId?: string },
  ): QueuedActionEntry;
  /** Switch which controlled company the interface is directing. A no-op if this seat does not control it. */
  setActiveCompany(companyId: string): void;
  unqueueAction(actionId: string): void;
  /** Record the explicit human confirmation a `CONFIRMATION_REQUIRED_ACTIONS` type needs. */
  confirmAction(actionId: string): void;
  clearQueue(): void;
  /**
   * Resolve the open quarter. Always completes, with or without a model, and
   * never leaves the resolving overlay up. Resolves to true when there is an
   * outcome to show — including a refused one — and false when the engine threw
   * and the quarter is still open.
   */
  endQuarter(): Promise<boolean>;
  saveGame(): void;
  /** Replay the stored save into memory. Asynchronous: the tab keeps painting. */
  loadGame(): Promise<boolean>;
  deleteSave(): void;
  /** Copy the current session into a manual slot, 1-based. */
  saveToSlot(slot: number): void;
  /** Adopt a slot as the autosave and load it, exactly as `loadGame` would. */
  loadFromSlot(slot: number): Promise<boolean>;
  /** Empty a manual slot. The autosave is untouched. */
  deleteSlot(slot: number): void;
  /**
   * Adopt a save that came from somewhere other than this browser's own key —
   * today, the host — and load it exactly as `loadFromSlot` would.
   *
   * `intoSlot` also mirrors it into that manual slot's local key, so the
   * browser's cache of the slot matches what the host holds. The copy it
   * displaces is kept under the sync layer's backup key first: adopting must
   * never be the step that loses a game.
   */
  loadSaveFile(file: unknown, options?: { intoSlot?: number }): Promise<boolean>;
  /** The stored save as text, for the player to keep. Null when there is none. */
  exportSave(): string | null;
  /** Adopt a pasted save and load it. False when it will not parse. */
  importSave(text: string): Promise<boolean>;
  updateSettings(partial: Partial<GameSettings>): void;
  dismissNotice(): void;
  /** Re-check whether a live model is configured. */
  refreshLlmHealth(): Promise<void>;
}

/* -------------------------------------------------------------------------- */
/*  Reducer                                                                    */
/* -------------------------------------------------------------------------- */

type Action =
  | {
      type: 'new_game';
      session: SessionState;
      settings: GameSettings;
      /** False when an unsupported stored save is being preserved: the game plays unsaved. */
      saveWritable: boolean;
    }
  | { type: 'load_start' }
  | { type: 'load_progress'; progress: ReplayProgress }
  | {
      type: 'loaded';
      loaded: LoadedGame;
      /** The stored queue entries that still validate against the replayed session. */
      queue: readonly SubmittedAction[];
      validations: Readonly<Record<string, ActionValidationResult>>;
      /** How many stored entries no longer validated and were dropped. */
      droppedCount: number;
      /** One past the highest restored sequence, so new ids never collide with restored ones. */
      nextSequence: number;
      /** The switcher's stored choice for this session, already reconciled against the replayed session. */
      activeCompanyId: string;
    }
  | { type: 'load_failed'; notice: string }
  | { type: 'hydrated' }
  | { type: 'queue'; action: SubmittedAction; validation: ActionValidationResult }
  | { type: 'unqueue'; actionId: string }
  | { type: 'confirm'; actionId: string; validation: ActionValidationResult }
  | { type: 'clear_queue' }
  | { type: 'resolve_start' }
  | { type: 'resolve_status'; status: string }
  | {
      type: 'resolve_done';
      outcome: FrontierResolutionOutcome;
      /** The inputs the resolver was actually handed, recorded verbatim for replay. */
      record: QuarterRecord;
    }
  | { type: 'resolve_failed'; notice: string }
  | { type: 'settings'; partial: Partial<GameSettings> }
  | { type: 'llm'; health: LlmHealth }
  | { type: 'notice'; notice: string | null }
  | { type: 'set_active_company'; companyId: string };

const DEFAULT_SETTINGS: GameSettings = {
  seed: DEMO_SEED,
  difficulty: 'standard',
  setup: null,
  // The session this store starts on is the frozen demo world: no setup, so
  // `demoSessionInput` short-circuits to world 1.
  worldVersion: LEGACY_WORLD_VERSION,
  autoExecuteRoutine: false,
  useLiveModel: true,
  skipResolutionReveal: false,
};

function applyAutoExecute(session: SessionState, autoExecuteRoutine: boolean): SessionState {
  return {
    ...session,
    config: { ...session.config, autoExecuteRoutineDefault: autoExecuteRoutine },
    players: session.players.map((player) => ({ ...player, autoExecuteRoutine })),
  };
}

function initialState(): GameStoreState {
  const session = createSession({ seed: DEFAULT_SETTINGS.seed, difficulty: DEFAULT_SETTINGS.difficulty });
  return {
    session,
    activeCompanyId: playerCompanyOf(session).id,
    queuedActions: [],
    validations: {},
    actionLog: [],
    lastOutcome: null,
    previousWorld: null,
    resolving: false,
    resolveStatus: '',
    settings: DEFAULT_SETTINGS,
    hydrated: false,
    loading: false,
    loadProgress: null,
    saveWritable: true,
    gameStarted: false,
    llm: { available: false, transportKind: 'none', model: null },
    notice: null,
    nextSequence: 0,
  };
}

/**
 * The outcome as this seat may be handed it.
 *
 * `resolveQuarter` returns the whole quarter — every rival's morale, runway,
 * churn and internal confidence — because the engine is the one thing that sees
 * all of canonical reality. A screen may not. The projection runs once, here,
 * so no screen can accidentally read the unprojected report.
 */
function projectForPlayer(outcome: FrontierResolutionOutcome, session: SessionState): FrontierResolutionOutcome {
  try {
    const projected = projectResolutionOutcomeForPlayer(outcome, session, PLAYER_ID);
    return { ...outcome, report: projected.report, events: projected.events };
  } catch {
    // A projection that cannot be computed withholds everything rather than
    // falling back to the unprojected quarter.
    return { ...outcome, report: { ...outcome.report, phases: [] }, events: [] };
  }
}

function reducer(state: GameStoreState, action: Action): GameStoreState {
  switch (action.type) {
    case 'new_game':
      return {
        ...state,
        session: action.session,
        // A new game starts directing the founding company: there is nothing
        // else in the group yet.
        activeCompanyId: playerCompanyOf(action.session).id,
        settings: action.settings,
        queuedActions: [],
        validations: {},
        actionLog: [],
        lastOutcome: null,
        previousWorld: null,
        resolving: false,
        resolveStatus: '',
        notice: null,
        nextSequence: 0,
        saveWritable: action.saveWritable,
        gameStarted: true,
        loading: false,
        loadProgress: null,
      };

    case 'load_start':
      return { ...state, loading: true, loadProgress: null, notice: null };

    case 'load_progress':
      return { ...state, loadProgress: action.progress };

    case 'loaded': {
      const settings: GameSettings = {
        ...state.settings,
        seed: action.loaded.seed,
        difficulty: action.loaded.difficulty,
        setup: action.loaded.setup,
        worldVersion: action.loaded.worldVersion,
        autoExecuteRoutine: action.loaded.autoExecuteRoutine,
      };
      // A partial replay is read-only. The stored file still holds every quarter
      // the player recorded; writing the prefix that happened to load back over
      // it would destroy the rest permanently, and no engine fix could recover
      // them afterwards.
      const preserved =
        'Your saved session has been left exactly as it was — nothing will be written over it until you start a new game.';
      const base = action.loaded.complete
        ? null
        : action.loaded.rejectedQuarters.length > 0
          ? `Replay stopped at quarter ${action.loaded.rejectedQuarters[0]}: a recorded quarter no longer commits under the current engine. ${preserved}`
          : `This save is longer than the ${MAX_REPLAY_QUARTERS}-quarter ceiling a replay from the seed can rebuild, and its checkpoint could not be read. You are at quarter ${action.loaded.session.quarter}. ${preserved}`;
      const dropped =
        action.droppedCount > 0
          ? `${action.droppedCount} queued action${action.droppedCount === 1 ? '' : 's'} from the save no longer validated and ${action.droppedCount === 1 ? 'was' : 'were'} dropped.`
          : null;
      const notice = base === null ? dropped : dropped === null ? base : `${base} ${dropped}`;
      return {
        ...state,
        session: action.loaded.session,
        activeCompanyId: action.activeCompanyId,
        actionLog: action.loaded.log,
        settings,
        queuedActions: action.queue,
        validations: action.validations,
        lastOutcome: null,
        previousWorld: null,
        notice,
        hydrated: true,
        loading: false,
        loadProgress: null,
        saveWritable: action.loaded.complete,
        gameStarted: true,
        nextSequence: action.nextSequence,
      };
    }

    case 'load_failed':
      return { ...state, hydrated: true, loading: false, loadProgress: null, saveWritable: false, notice: action.notice };

    case 'hydrated':
      return state.hydrated ? state : { ...state, hydrated: true };

    case 'queue': {
      // The allocator, not the reducer, owns the sequence: two actions queued
      // from one event handler must not share an id.
      const duplicate = state.queuedActions.some((entry) => entry.actionId === action.action.actionId);
      if (duplicate) return state;
      return {
        ...state,
        queuedActions: [...state.queuedActions, action.action],
        validations: { ...state.validations, [action.action.actionId]: action.validation },
        nextSequence: Math.max(state.nextSequence, action.action.sequence + 1),
      };
    }

    case 'unqueue': {
      const validations = { ...state.validations };
      delete validations[action.actionId];
      return {
        ...state,
        queuedActions: state.queuedActions.filter((entry) => entry.actionId !== action.actionId),
        validations,
      };
    }

    case 'confirm':
      return {
        ...state,
        queuedActions: state.queuedActions.map((entry) =>
          entry.actionId === action.actionId ? { ...entry, confirmedByHuman: true } : entry,
        ),
        validations: { ...state.validations, [action.actionId]: action.validation },
      };

    case 'clear_queue':
      return { ...state, queuedActions: [], validations: {} };

    case 'resolve_start':
      return { ...state, resolving: true, resolveStatus: 'Collecting submitted actions', notice: null };

    case 'resolve_status':
      return { ...state, resolveStatus: action.status };

    case 'resolve_done': {
      const { outcome } = action;
      if (!outcome.committed) {
        return {
          ...state,
          resolving: false,
          resolveStatus: '',
          lastOutcome: projectForPlayer(outcome, state.session),
          notice: 'The quarter did not commit: an engine invariant refused it. Nothing changed — the report explains what failed.',
        };
      }
      return {
        ...state,
        session: outcome.nextState,
        // Reconciled every commit, not just on load: a quarter can cost the
        // seat control of the company it was directing — sold, wound up,
        // absorbed by another controller's move — and the active company must
        // never be left pointing at one that is no longer part of the group.
        activeCompanyId: resolveActiveCompanyId(outcome.nextState, state.activeCompanyId),
        previousWorld: state.session.world,
        queuedActions: [],
        validations: {},
        actionLog: [...state.actionLog, action.record],
        lastOutcome: projectForPlayer(outcome, outcome.nextState),
        resolving: false,
        resolveStatus: '',
        nextSequence: 0,
      };
    }

    case 'resolve_failed':
      // The overlay covers the whole application and has no dismiss control, so
      // the one thing this path may never do is leave `resolving` true.
      return { ...state, resolving: false, resolveStatus: '', notice: action.notice };

    case 'settings': {
      const settings = { ...state.settings, ...action.partial };
      const session =
        action.partial.autoExecuteRoutine !== undefined
          ? applyAutoExecute(state.session, action.partial.autoExecuteRoutine)
          : state.session;
      return { ...state, settings, session };
    }

    case 'llm':
      return { ...state, llm: action.health };

    case 'notice':
      return { ...state, notice: action.notice };

    case 'set_active_company':
      // Reconciled here too, not trusted from the caller: `resolveActiveCompanyId`
      // is cheap and this is the one gate every path to a changed active
      // company passes through.
      return { ...state, activeCompanyId: resolveActiveCompanyId(state.session, action.companyId) };

    default:
      return state;
  }
}

/* -------------------------------------------------------------------------- */
/*  Context                                                                    */
/* -------------------------------------------------------------------------- */

const StateContext = createContext<GameStoreState | null>(null);
const ActionsContext = createContext<GameStoreActions | null>(null);

/** Wait for the browser to paint before doing synchronous work. */
function nextPaint(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => setTimeout(resolve, 0));
    } else {
      setTimeout(resolve, 0);
    }
  });
}

export function GameProvider({ children }: { readonly children: ReactNode }): React.JSX.Element {
  const [state, dispatch] = useReducer(reducer, undefined, initialState);
  const stateRef = useRef(state);
  stateRef.current = state;
  // Ids are minted from this, never from rendered state: see the allocator's
  // note in engine.ts for why a bulk approve would otherwise collide.
  const sequences = useRef(createSequenceAllocator()).current;
  // The file as this tab last wrote or read it. Held here so the persistence
  // effect does not re-parse a checkpointed session out of localStorage — and
  // back through `SessionStateSchema` — after every quarter.
  const savedFile = useRef<SaveFile | null>(null);
  // The debounced write in flight, reachable from outside the persist effect:
  // a pagehide must flush it, and a delete or a new game must cancel it so a
  // timer armed moments earlier cannot resurrect what was just replaced.
  const pendingPersist = useRef<{ timer: ReturnType<typeof setTimeout>; write: () => void } | null>(null);
  // The resolved-quarter count last written to storage. A mismatch means a
  // quarter (or a founding) exists only in memory, which is written through
  // immediately rather than debounced.
  const persistedLogLength = useRef(-1);
  // One warning per session when the browser refuses storage writes.
  const saveHealthWarned = useRef(false);
  // Set by a load: the next persist run would only rewrite what storage already
  // holds (upgrading its version as a side effect), so it is skipped once.
  const suppressNextPersist = useRef(false);

  const cancelPendingPersist = useCallback((): void => {
    if (pendingPersist.current !== null) {
      clearTimeout(pendingPersist.current.timer);
      pendingPersist.current = null;
    }
  }, []);

  /**
   * Local first, host second — and only ever after a local write landed.
   *
   * Pushing a file this browser failed to store would put a save on the host
   * that the device it came from does not have, which is the one direction the
   * conflict rule cannot repair. The call itself is fire-and-forget: the sync
   * layer debounces, coalesces and retries on its own, and nothing here awaits
   * it, so a Pi that is off costs a status chip and not a frame.
   */
  const pushToServer = useCallback((slot: number | null, file: SaveFile): void => {
    const name = saveSlotOf(slot);
    if (name !== null) saveSync().push(name, file);
  }, []);

  /* --- replay the save file, once ------------------------------------------ */
  // An already-inspected file (a slot copied to the autosave key) skips the
  // re-read; everything after that point is identical to a plain load.
  const runLoad = useCallback(async (preInspected?: SaveInspection): Promise<boolean> => {
    const inspection = preInspected ?? inspectSave();
    if (inspection.status === 'unsupported') {
      dispatch({
        type: 'load_failed',
        notice: `This browser holds a save written by a newer build (version ${inspection.version ?? 'unknown'}). It has been left untouched rather than overwritten; nothing will be saved over it in this session.`,
      });
      return false;
    }
    if (inspection.file === null) {
      dispatch({ type: 'hydrated' });
      return false;
    }

    dispatch({ type: 'load_start' });
    let loaded: LoadedGame | null;
    try {
      loaded = await replayAsync(inspection.file, {
        onProgress: (progress) => dispatch({ type: 'load_progress', progress }),
        yieldControl: nextPaint,
      });
    } catch {
      loaded = null;
    }
    if (loaded === null) {
      dispatch({
        type: 'load_failed',
        notice: 'The saved session could not be replayed. It has been left in place, so nothing is lost — start a new session or import a save.',
      });
      return false;
    }

    // The stored queue is a proposal, not state: each entry is re-validated
    // against the session the replay actually produced, and an entry the
    // validator now rejects is dropped rather than queued unrunnable. Dropped
    // for the same reason: an entry stamped for a different quarter than the
    // replay reached (the resolver's collector would discard it without a
    // ledger row), and a duplicated actionId (the live queue path refuses
    // those too).
    const restored: SubmittedAction[] = [];
    const validations: Record<string, ActionValidationResult> = {};
    const seenIds = new Set<string>();
    for (const entry of loaded.queue) {
      if (entry.quarter !== loaded.session.quarter || seenIds.has(entry.actionId)) continue;
      // Re-validated exactly as recorded — its own actorCompanyId, not the
      // founding company: STAGE 5 lets a queued action belong to any company
      // the seat controls, and re-validating every restored entry as the
      // founding company would wrongly reject (or wrongly accept) one that
      // was queued for a subsidiary.
      const raw = validateSubmittedAction(loaded.session, entry);
      if (raw.status === 'rejected') continue;
      seenIds.add(entry.actionId);
      restored.push(entry);
      validations[entry.actionId] = { ...raw, actionId: entry.actionId };
    }
    const nextSequence = restored.reduce((max, entry) => Math.max(max, entry.sequence + 1), 0);
    sequences.reset(nextSequence);
    savedFile.current = inspection.file;
    // What just loaded is what storage holds; the persist effect's first run
    // after this would only rewrite it (stamping the current SAVE_VERSION on a
    // file an older build could still read), so that one run is skipped.
    persistedLogLength.current = loaded.log.length;
    suppressNextPersist.current = true;
    // The switcher's own, separately stored choice for this session (see
    // `activeCompanyStorage.ts`) — reconciled against the replayed session so a
    // company sold or wound up since it was last chosen never comes back as
    // the active one.
    const activeCompanyId = resolveActiveCompanyId(loaded.session, readStoredActiveCompanyId(loaded.session.sessionId));
    dispatch({
      type: 'loaded',
      loaded,
      queue: restored,
      validations,
      droppedCount: loaded.queue.length - restored.length,
      nextSequence,
      activeCompanyId,
    });
    return loaded.complete;
  }, [sequences]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const inspection = inspectSave();
      if (inspection.status === 'absent' || inspection.status === 'unreadable') {
        if (!cancelled) dispatch({ type: 'hydrated' });
        return;
      }
      await runLoad();
    })();
    return () => {
      cancelled = true;
    };
  }, [runLoad]);

  /* --- ask whether a model is configured ---------------------------------- */
  useEffect(() => {
    let cancelled = false;
    void llmHealth().then((health) => {
      if (!cancelled) dispatch({ type: 'llm', health });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  /*
   * --- prefetch this quarter's strategist calls the moment it opens ----------
   *
   * A strategist's plan depends only on state at the start of the quarter and
   * its own private information (see `strategistPrefetch.ts`), so there is no
   * reason to wait for End Quarter to ask for it: this effect fires as soon as
   * `state.session` names a new (session, quarter) pair — a new game, a load,
   * or the quarter `resolve_done` just opened — and `endQuarter` reaches for
   * whatever came back instead of firing the same request twice.
   *
   * Deliberately **not** keyed on `state.resolving`: `endQuarter` flips that to
   * true as its very first act, long before it is done reading the prefetch
   * cache — keying on `resolving` would clear the cache out from under the very
   * call it was started for. `state.session` itself does not change until
   * `resolve_done` commits, well after `endQuarter` has read what it needed.
   *
   * This effect's cleanup deliberately does **not** call
   * `clearStrategistPrefetch()` on every re-run any more. `startStrategistPrefetch`
   * is already idempotent per `(state hash, quarter, companyId)` — it reuses an
   * existing entry for a key it is asked for again, and aborts only the entries
   * a new call does *not* ask for (see `strategistPrefetch.ts`). A React effect
   * re-runs its cleanup and then its body on every change of its own
   * dependencies, so any re-render that changes one of them — a settings
   * toggle unrelated to the session, a store update that happens to hand this
   * effect a new but structurally identical `state.session` object — used to
   * throw the whole quarter's cache away and immediately re-request it,
   * because unconditionally wiping the cache first defeated the reuse
   * `startStrategistPrefetch` was already built to do: the four (or more)
   * strategist calls for the quarter already in flight were aborted and
   * re-fired, doubling the load on the shared per-principal rate limit for no
   * reason tied to anything the player did. Leaving the cache alone here lets
   * `startStrategistPrefetch`'s own key-based diffing do its job instead: a
   * same-quarter re-run is a no-op, and a genuine new quarter still prunes the
   * old entries, because their keys are no longer in the new call's set.
   *
   * Not run before hydration decides what the live session even is
   * (`state.hydrated`), while replaying a load (`state.loading`), or with the
   * live model off: in every one of those there is nothing this effect should
   * be prefetching, so it explicitly clears the cache itself in that branch —
   * `startStrategistPrefetch` is not called to do the pruning for it, since a
   * `return` before it is not a call with an empty set. The `hydrated` guard
   * matters for exactly the case above: on a reload with an existing save, the
   * very first render still holds the *previous* tab's throwaway default
   * session (`initialState()`) for the handful of milliseconds before the
   * loader either replaces it or confirms there is nothing to load — without
   * this guard, that render fired a full batch of strategist calls for a
   * session about to be discarded, calls the client-side abort in the old
   * per-run cleanup could only ask nicely to stop (see `strategistPrefetch.ts`)
   * and which may already have reached the server. Turning the live model
   * back on, a load finishing, or hydration completing with nothing to load
   * all run the effect again and repopulate it. The one case still left to a
   * cleanup is the founder leaving the game (or this provider unmounting)
   * with the effect's own guard never firing again to clean up after itself —
   * handled by the mount/unmount-only effect just below.
   */
  useEffect(() => {
    if (!state.hydrated || state.loading || !state.settings.useLiveModel) {
      clearStrategistPrefetch();
      return;
    }
    const player = playerCompanyOf(state.session);
    const strategistCap = Math.max(0, Math.min(LLM_STRATEGISTS_PER_QUARTER, MAX_LIVE_STRATEGISTS));
    const ids = strategistPriority(state.session, player.id, strategistCap);
    startStrategistPrefetch(state.session, ids);
  }, [state.session, state.hydrated, state.loading, state.settings.useLiveModel]);

  // Final unmount only — see the long comment above. The effect above prunes
  // stale entries itself on every subsequent run; this is only for the run
  // that never happens because the component went away first.
  useEffect(() => () => clearStrategistPrefetch(), []);

  /* --- persist the decision log and the open queue -------------------------- */
  useEffect(() => {
    if (!state.hydrated || state.loading) return;
    // A replay that did not finish, or a file this build cannot read, is never
    // written over: the stored decisions outrank whatever is in this tab.
    if (!state.saveWritable) return;
    // Only a game the player started is saved. Gating on resolved quarters
    // instead used to lose a founding to a refresh; gating on the flag also
    // keeps the default just-visited session from writing a save nobody asked
    // for.
    if (!state.gameStarted) return;
    // A load primes this effect with state that is byte-for-byte what storage
    // already holds; skipping that one run keeps a v1–v3 file readable by the
    // build that wrote it until the player actually changes something.
    if (suppressNextPersist.current) {
      suppressNextPersist.current = false;
      return;
    }
    const write = (): void => {
      pendingPersist.current = null;
      const file = buildSaveFile({
        seed: state.settings.seed,
        difficulty: state.settings.difficulty,
        autoExecuteRoutine: state.settings.autoExecuteRoutine,
        setup: state.settings.setup,
        log: state.actionLog,
        queue: state.queuedActions,
        session: state.session,
        previous: savedFile.current,
      });
      if (writeSaveFile(file)) {
        savedFile.current = file;
        persistedLogLength.current = state.actionLog.length;
        pushToServer(null, file);
      } else if (!saveHealthWarned.current) {
        // Said once, not per write: a browser that refuses storage refuses it
        // for the whole session, and the player needs the fact, not a drumbeat.
        saveHealthWarned.current = true;
        dispatch({
          type: 'notice',
          notice:
            'This browser refused the save write, so progress will not survive closing the tab. Private browsing and blocked site data do this.',
        });
      }
    };
    // A newly resolved quarter (or a just-committed load/founding) is written
    // immediately: a decision may never sit only in memory behind a timer.
    // Everything else — queue taps, settings — debounces, collapsing a burst
    // into one localStorage write.
    if (state.actionLog.length !== persistedLogLength.current) {
      if (pendingPersist.current !== null) {
        clearTimeout(pendingPersist.current.timer);
        pendingPersist.current = null;
      }
      write();
      return;
    }
    const timer = setTimeout(write, 300);
    pendingPersist.current = { timer, write };
    return () => {
      // Clear only our own timer: an action (delete, new game) may already have
      // cancelled and replaced what this cleanup would otherwise tear down.
      if (pendingPersist.current !== null && pendingPersist.current.timer === timer) {
        clearTimeout(timer);
        pendingPersist.current = null;
      }
    };
  }, [
    state.actionLog,
    state.gameStarted,
    state.hydrated,
    state.loading,
    state.queuedActions,
    state.saveWritable,
    state.session,
    state.settings.autoExecuteRoutine,
    state.settings.difficulty,
    state.settings.seed,
    state.settings.setup,
    pushToServer,
  ]);

  /* --- ask the host once whether it keeps saves ----------------------------- */
  useEffect(() => {
    // Probe only, never reconcile. Reconciliation can *adopt* a save, and
    // adopting one into a tab that is already playing a different game would
    // replace the session under the player; the landing page is where nothing
    // is loaded yet and where it therefore belongs. What the probe buys is that
    // a player who opened a deep link straight into the game still has their
    // moves pushed, instead of syncing nothing until they next see the start
    // page. A push sent with no known revision is a 409 the sync layer
    // reconciles by the same rule as everything else.
    void saveSync().probe();
  }, []);

  /* --- flush the pending write before the tab can vanish -------------------- */
  useEffect(() => {
    // A phone backgrounds a tab and may never resume it; `pagehide` covers
    // navigation and close, the hidden-visibility flush covers the discard path
    // where `pagehide` never fires. Flushing runs the exact write the timer
    // would have run.
    const flush = (): void => {
      const pending = pendingPersist.current;
      if (pending !== null) {
        clearTimeout(pending.timer);
        pending.write();
      }
      // Best effort, and deliberately not awaited: a request started at
      // `pagehide` often does not finish. It does not need to — the local copy
      // is then newer than the host's, and the next reconciliation uploads it.
      void saveSync().flush();
    };
    const onVisibility = (): void => {
      if (document.visibilityState === 'hidden') flush();
    };
    // Guarded, not assumed: the store also mounts under test in a pared-down
    // window that has storage but no event target.
    const canListen =
      typeof window !== 'undefined' &&
      typeof window.addEventListener === 'function' &&
      typeof document !== 'undefined' &&
      typeof document.addEventListener === 'function';
    if (!canListen) return;
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  /* --- actions ------------------------------------------------------------- */

  const validateIntent = useCallback((intent: ActionIntent, companyId?: string): ActionValidationResult => {
    const current = stateRef.current;
    return validateIntentForCompany(current.session, intent, companyId ?? current.activeCompanyId);
  }, []);

  const queueAction = useCallback<GameStoreActions['queueAction']>((intent, options) => {
    const current = stateRef.current;
    const confirmed = options?.confirmed ?? !needsConfirmation(intent.type);
    const actingCompanyId = options?.companyId ?? current.activeCompanyId;
    const submitted = buildSubmittedActionForCompany(current.session, intent, sequences.next(), actingCompanyId, {
      origin: options?.origin ?? 'player_ui',
      confirmedByHuman: confirmed,
    });
    const validation = validateSubmittedAction(current.session, submitted);
    dispatch({ type: 'queue', action: submitted, validation });
    return {
      action: submitted,
      validation,
      needsConfirmation: needsConfirmation(intent.type),
      blocked: needsConfirmation(intent.type) && !submitted.confirmedByHuman,
    };
  }, [sequences]);

  const unqueueAction = useCallback((actionId: string) => {
    dispatch({ type: 'unqueue', actionId });
  }, []);

  const confirmAction = useCallback((actionId: string) => {
    const current = stateRef.current;
    const entry = current.queuedActions.find((item) => item.actionId === actionId);
    if (entry === undefined) return;
    const raw = validateSubmittedAction(current.session, entry);
    dispatch({ type: 'confirm', actionId, validation: { ...raw, actionId } });
  }, []);

  const clearQueue = useCallback(() => dispatch({ type: 'clear_queue' }), []);

  const endQuarter = useCallback(async (): Promise<boolean> => {
    const current = stateRef.current;
    if (current.resolving) return false;

    dispatch({ type: 'resolve_start' });
    // Let the overlay paint before the engine takes the thread.
    await nextPaint();

    const session = current.session;
    const submitted = [...current.queuedActions];
    let gmProposal: GmProposalBatch | null = null;
    let npcBundles: NpcActionBundle[] = [];
    let modelAvailable = false;

    /*
     * Live progress, encoded into `resolveStatus` — a plain string, exactly the
     * type it has always been — as one line per row plus a headline the
     * overlay's existing `stageOfStatus` still recognises by its `startsWith`
     * prefix. This is deliberately not a new field on `GameStoreState`: the
     * store shape is untouched, only how often, and with how much detail,
     * `resolve_status` is dispatched.
     *
     * A row moves through `pending → running → done`, or `pending → skipped`
     * when the quarter's own time budget (`LLM_QUARTER_BUDGET_MS`) is spent
     * before it gets a turn — the report line the resolving overlay shows the
     * player, not a silent truncation.
     */
    const rows: ProgressRow[] = [];
    let headline = '';
    let ticker: ReturnType<typeof setInterval> | null = null;

    const renderProgress = (): void => {
      dispatch({ type: 'resolve_status', status: formatProgressStatus(headline, rows, Date.now()) });
    };
    const setHeadline = (text: string): void => {
      headline = text;
      renderProgress();
    };
    const startTicking = (): void => {
      if (ticker !== null) return;
      ticker = setInterval(renderProgress, 1000);
    };
    const stopTicking = (): void => {
      if (ticker === null) return;
      clearInterval(ticker);
      ticker = null;
    };
    /** Stop waiting for `promise` once `msRemaining` passes, without cancelling it — a queued call is never refused, only stopped being waited on. */
    const withDeadline = <T,>(promise: Promise<T | null>, msRemaining: number): Promise<T | null> => {
      if (msRemaining <= 0) return Promise.resolve(null);
      return new Promise<T | null>((resolve) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (!settled) {
            settled = true;
            resolve(null);
          }
        }, msRemaining);
        promise.then(
          (value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(value);
          },
          () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(null);
          },
        );
      });
    };

    if (current.settings.useLiveModel) {
      // A fixed budget for the whole batch, not per call: the World Director
      // and every strategist share it, so a slow Director already leaves less
      // time for rivals rather than each call getting its own fresh ceiling.
      const budgetDeadline = Date.now() + LLM_QUARTER_BUDGET_MS;
      try {
        const health = await llmHealth();
        modelAvailable = health.available;
        if (health.available) {
          setHeadline('Consulting the World Director');
          const directorRow: ProgressRow = { label: 'World Director', state: 'pending', startedAt: null, doneAt: null, note: null };
          rows.push(directorRow);
          const directorInput = buildWorldDirectorInput(session, current.previousWorld);
          if (directorInput !== null) {
            directorRow.state = 'running';
            directorRow.startedAt = Date.now();
            startTicking();
            renderProgress();
            gmProposal = await requestWorldDirector(directorInput);
            directorRow.state = 'done';
            directorRow.doneAt = Date.now();
            renderProgress();
          }

          setHeadline('Rival strategists are planning');
          // Priority order, not the engine's plain size ordering: the rivals
          // whose plan actually bears on the player's next decision — mid-deal,
          // head-to-head on a bid, same sector, same region — go first, so when
          // the budget runs out it is the least-relevant rival that falls back
          // to policy, never whichever one happened to be asked first.
          const player = playerCompanyOf(session);
          const strategistCap = Math.max(0, Math.min(LLM_STRATEGISTS_PER_QUARTER, MAX_LIVE_STRATEGISTS));
          const ids = strategistPriority(session, player.id, strategistCap);
          const companyName = (companyId: string): string => session.companies.find((entry) => entry.id === companyId)?.name ?? companyId;
          const strategistRows = new Map<string, ProgressRow>(
            ids.map((id) => [id, { label: `${companyName(id)} strategist`, state: 'pending', startedAt: null, doneAt: null, note: null }] as const),
          );
          rows.push(...strategistRows.values());
          renderProgress();

          const collected: NpcActionBundle[] = [];
          for (const id of ids) {
            const row = strategistRows.get(id);
            if (row === undefined) continue;
            const remaining = budgetDeadline - Date.now();
            if (remaining <= 0) {
              row.state = 'skipped';
              row.note = 'on policy (budget)';
              renderProgress();
              continue;
            }
            row.state = 'running';
            row.startedAt = Date.now();
            startTicking();
            renderProgress();

            // Reach for the call the quarter-open prefetch already started
            // (`strategistPrefetch.ts`) before firing a fresh one: a strategist's
            // plan depends only on state at the start of the quarter, which is
            // exactly `session` here, so the cached answer is the same answer a
            // live call would give — just already paid for.
            const bundle = hasStrategistPrefetch(session, id)
              ? await withDeadline(takeStrategistPrefetch(session, id), remaining)
              : await (async () => {
                  const input = buildNpcStrategistInput(session, id);
                  return input === null ? null : await withDeadline(requestNpcBundle(input), remaining);
                })();

            if (bundle === null && Date.now() >= budgetDeadline) {
              row.state = 'skipped';
              row.note = 'on policy (budget)';
            } else {
              row.state = 'done';
              row.doneAt = Date.now();
              if (bundle !== null) collected.push(bundle);
            }
            renderProgress();
          }
          npcBundles = collected;
        }
      } catch {
        // An LLM outage is not an error condition. Fall through to the
        // deterministic path with nothing from the model.
        modelAvailable = false;
        gmProposal = null;
        npcBundles = [];
      } finally {
        stopTicking();
      }
    }

    setHeadline('Resolving eighteen phases');
    const engineRow: ProgressRow = { label: 'Resolving eighteen phases', state: 'running', startedAt: Date.now(), doneAt: null, note: null };
    rows.push(engineRow);
    renderProgress();
    await nextPaint();

    // The record holds the inputs the surviving attempt was *actually* handed:
    // when the model's contribution makes the engine throw and the offline retry
    // succeeds, a replay must reproduce the quarter that happened.
    const attempt = resolveQuarterSafely(session, submitted, gmProposal, npcBundles);
    engineRow.state = 'done';
    engineRow.doneAt = Date.now();
    renderProgress();
    if (attempt.outcome === null) {
      // Both attempts threw, so the fault is in the engine and not in anything
      // the model said. The queue is preserved and the overlay comes down: a
      // full-screen overlay with no dismiss control is the one state this
      // function may never leave behind.
      dispatch({
        type: 'resolve_failed',
        notice: `The quarter could not be resolved: ${attempt.error ?? 'the engine refused it'}. Nothing was committed and your queue is intact.`,
      });
      return false;
    }

    // The quarter is decided. What is left is prose: the engine has already
    // authored this quarter's posts, computed their reach and applied every
    // consequence, and a model may now write a capped handful of those lines in
    // their author's voice. Nothing it returns can change a number, and a
    // failure leaves the engine's own line standing.
    let outcome = attempt.outcome;
    const socialTexts: SocialTextOverride[] = [];
    if (modelAvailable && outcome.committed) {
      try {
        const authored = selectPostsForAuthoring(outcome.nextState, session.quarter);
        if (authored.length > 0) {
          setHeadline('The networks are talking');
          const socialRow: ProgressRow = { label: 'Writing the quarter’s posts', state: 'running', startedAt: Date.now(), doneAt: null, note: null };
          rows.push(socialRow);
          startTicking();
          renderProgress();
          // Sequential on purpose: the server bounds concurrent model calls to
          // one by default, so firing these in parallel would only queue them.
          for (const post of authored) {
            const input = buildSocialAuthorInput(outcome.nextState, post);
            if (input === null) continue;
            const draft = await requestSocialPost(input);
            if (draft === null) continue;
            socialTexts.push({ postId: post.id, text: draft.text });
          }
          stopTicking();
          socialRow.state = 'done';
          socialRow.doneAt = Date.now();
          renderProgress();
        }
      } catch {
        // Words are the least important thing in the quarter. Keep the templates.
        socialTexts.length = 0;
      }
      if (socialTexts.length > 0) {
        outcome = { ...outcome, nextState: applySocialTextOverrides(outcome.nextState, socialTexts, session.quarter) };
      }
    }

    dispatch({
      type: 'resolve_done',
      outcome,
      record: {
        quarter: session.quarter,
        actions: submitted,
        gmProposal: attempt.gmProposal,
        npcBundles: [...attempt.npcBundles],
        socialTexts,
      },
    });
    if (outcome.committed) sequences.reset(0);
    return true;
  }, [sequences]);

  const newGame = useCallback<GameStoreActions['newGame']>((options) => {
    const current = stateRef.current;
    // The setup is per-game: a new game takes what it was given, and defaults to
    // the classic world when none is supplied. Parsed once here, so everything
    // downstream holds a setup with its sector, region and world version filled.
    const setup = options?.setup === undefined ? null : NewGameSetupSchema.parse(options.setup);
    const settings: GameSettings = {
      ...current.settings,
      seed: options?.seed ?? current.settings.seed,
      difficulty: options?.difficulty ?? current.settings.difficulty,
      setup,
      // A game founded through the chat carries world 2 in its setup; one
      // founded with no setup at all is the frozen world, and says so.
      worldVersion: setup?.worldVersion ?? LEGACY_WORLD_VERSION,
      autoExecuteRoutine: options?.autoExecuteRoutine ?? current.settings.autoExecuteRoutine,
    };
    const session = createSession({
      seed: settings.seed,
      difficulty: settings.difficulty,
      autoExecuteRoutine: settings.autoExecuteRoutine,
      setup: setup ?? undefined,
    });
    // A timer armed by the previous game must not fire after the founding save
    // lands and rewrite it with the world that was just left.
    cancelPendingPersist();
    // The one thing a new game may not do is destroy a save this build cannot
    // read: that file belongs to a newer build, and clearing it here would be
    // the exact overwrite every other path refuses. The new game still starts —
    // it just plays unsaved, and says so.
    const storedVersion = storedSaveVersion();
    const preserved = storedVersion !== null && !SUPPORTED_SAVE_VERSIONS.includes(storedVersion);
    if (!preserved) clearSaveFile();
    savedFile.current = null;
    sequences.reset(0);
    dispatch({ type: 'new_game', session, settings, saveWritable: !preserved });
    if (preserved) {
      dispatch({
        type: 'notice',
        notice:
          'This browser holds a save written by a newer build, and it has been preserved untouched — so this new game will not be saved. Delete the stored session in Settings if you want saving back.',
      });
      return;
    }
    // The founding save is written here, synchronously, not left to the
    // debounced effect: a refresh inside the debounce window would otherwise
    // lose the company the player just founded.
    const file = buildSaveFile({
      seed: settings.seed,
      difficulty: settings.difficulty,
      autoExecuteRoutine: settings.autoExecuteRoutine,
      setup,
      log: [],
      queue: [],
      session,
      previous: null,
    });
    if (writeSaveFile(file)) {
      savedFile.current = file;
      persistedLogLength.current = 0;
      suppressNextPersist.current = true;
      pushToServer(null, file);
    } else if (!saveHealthWarned.current) {
      saveHealthWarned.current = true;
      dispatch({
        type: 'notice',
        notice:
          'This browser refused the save write, so progress will not survive closing the tab. Private browsing and blocked site data do this.',
      });
    }
  }, [sequences, cancelPendingPersist, pushToServer]);

  const saveGame = useCallback(() => {
    const current = stateRef.current;
    if (!current.saveWritable) {
      dispatch({
        type: 'notice',
        notice: 'This session will not be saved: the stored file could not be replayed in full and is being preserved as it is.',
      });
      return;
    }
    const file = buildSaveFile({
      seed: current.settings.seed,
      difficulty: current.settings.difficulty,
      autoExecuteRoutine: current.settings.autoExecuteRoutine,
      setup: current.settings.setup,
      log: current.actionLog,
      queue: current.queuedActions,
      session: current.session,
      previous: savedFile.current,
    });
    const wrote = writeSaveFile(file);
    if (wrote) {
      savedFile.current = file;
      pushToServer(null, file);
    }
    dispatch({
      type: 'notice',
      notice: wrote ? 'Session saved.' : 'The session could not be saved: this browser refused the write and the stored file is unchanged.',
    });
  }, [pushToServer]);

  const loadGame = useCallback(async (): Promise<boolean> => {
    if (inspectSave().status === 'absent') {
      dispatch({ type: 'notice', notice: 'No saved session found in this browser.' });
      return false;
    }
    return await runLoad();
  }, [runLoad]);

  const deleteSave = useCallback(() => {
    // Cancelled first: a debounced write armed by a tap moments before the
    // delete would otherwise fire into the now-empty key and quietly undo it.
    cancelPendingPersist();
    clearSaveFile();
    savedFile.current = null;
    // The host's copy goes too: a delete the player asked for is the one case
    // where the two sides must agree, or the next reconciliation would helpfully
    // restore what they just threw away.
    void saveSync().remove('autosave');
    dispatch({ type: 'notice', notice: 'Saved session deleted.' });
  }, [cancelPendingPersist]);

  const saveToSlot = useCallback((slot: number) => {
    const current = stateRef.current;
    if (!current.saveWritable) {
      dispatch({
        type: 'notice',
        notice: 'This session will not be saved: the stored file could not be replayed in full and is being preserved as it is.',
      });
      return;
    }
    // A slot holding a newer build's save is preserved for the same reason the
    // autosave is; `writeSlotFile` would refuse anyway, but checking first lets
    // the notice say why.
    if (readSlotFile(slot).status === 'unsupported') {
      dispatch({
        type: 'notice',
        notice: `Slot ${slot} holds a save written by a newer build and has been left untouched. Pick another slot.`,
      });
      return;
    }
    const file = buildSaveFile({
      seed: current.settings.seed,
      difficulty: current.settings.difficulty,
      autoExecuteRoutine: current.settings.autoExecuteRoutine,
      setup: current.settings.setup,
      log: current.actionLog,
      queue: current.queuedActions,
      session: current.session,
      previous: savedFile.current,
    });
    const wrote = writeSlotFile(slot, file);
    if (wrote) pushToServer(slot, file);
    dispatch({
      type: 'notice',
      notice: wrote
        ? `Saved to slot ${slot}.`
        : `Slot ${slot} could not be written: this browser refused the write and the slot is unchanged.`,
    });
  }, [pushToServer]);

  const loadFromSlot = useCallback(
    async (slot: number): Promise<boolean> => {
      const inspection = readSlotFile(slot);
      if (inspection.status === 'unsupported') {
        dispatch({
          type: 'notice',
          notice: `Slot ${slot} holds a save written by a newer build (version ${inspection.version ?? 'unknown'}). It has been left untouched and cannot be loaded here.`,
        });
        return false;
      }
      if (inspection.file === null) {
        dispatch({ type: 'notice', notice: `Slot ${slot} holds no save this build can read.` });
        return false;
      }
      // Adoption is decided before anything replays: an autosave written by a
      // newer build is preserved, and a slot load that would displace it is
      // refused outright rather than half-done with persistence silently off.
      const stored = storedSaveVersion();
      if (stored !== null && !SUPPORTED_SAVE_VERSIONS.includes(stored)) {
        dispatch({
          type: 'notice',
          notice:
            'The saved session in this browser was written by a newer build and is preserved untouched, so a slot cannot replace it. Delete the saved session in Settings first.',
        });
        return false;
      }
      cancelPendingPersist();
      const complete = await runLoad(inspection);
      // The slot becomes the autosave only after the replay proved it loads in
      // full: a slot that fails or half-loads must not have cost the previous
      // game its autosave along the way.
      if (complete) {
        if (writeSaveFile(inspection.file)) {
          savedFile.current = inspection.file;
          pushToServer(null, inspection.file);
        } else {
          dispatch({
            type: 'notice',
            notice: `Loaded slot ${slot}, but this browser refused to adopt it as the autosave — the previous autosave is unchanged.`,
          });
        }
      }
      return complete;
    },
    [runLoad, cancelPendingPersist, pushToServer],
  );

  /**
   * Adopt a save from outside this browser's own keys — today, the host's copy
   * of a slot the picker decided is the later position.
   *
   * The order is the point. The local copy is set aside under the sync layer's
   * backup key *before* anything is written, the replay has to succeed before
   * the file is adopted as the autosave, and a stored save this build cannot
   * read still refuses the whole operation rather than being overwritten.
   */
  const loadSaveFile = useCallback(
    async (file: unknown, options: { intoSlot?: number } = {}): Promise<boolean> => {
      const inspection = inspectSaveValue(file, { defaultSeed: DEMO_SEED });
      if (inspection.file === null) {
        dispatch({
          type: 'notice',
          notice:
            inspection.status === 'unsupported'
              ? `That save was written by a newer build (version ${inspection.version ?? 'unknown'}) and cannot be loaded here.`
              : 'That save could not be read, so nothing was changed.',
        });
        return false;
      }
      const stored = storedSaveVersion();
      if (stored !== null && !SUPPORTED_SAVE_VERSIONS.includes(stored)) {
        dispatch({
          type: 'notice',
          notice:
            'The saved session in this browser was written by a newer build and is preserved untouched, so another save cannot replace it. Delete the saved session in Settings first.',
        });
        return false;
      }
      cancelPendingPersist();
      const slot = options.intoSlot ?? null;
      const name = slot === null ? null : saveSlotOf(slot);
      // The autosave is always displaced by a load, and the manual slot as well
      // when one is named. Both losers are set aside before anything is written.
      saveSync().backupLocal('autosave');
      if (name !== null) saveSync().backupLocal(name);
      const complete = await runLoad(inspection);
      if (complete) {
        if (writeSaveFile(inspection.file)) savedFile.current = inspection.file;
        if (slot !== null) writeSlotFile(slot, inspection.file);
      }
      return complete;
    },
    [runLoad, cancelPendingPersist],
  );

  const deleteSlot = useCallback((slot: number) => {
    const removed = clearSlot(slot);
    const name = saveSlotOf(slot);
    if (removed && name !== null) void saveSync().remove(name);
    dispatch({
      type: 'notice',
      notice: removed ? `Slot ${slot} deleted.` : `Slot ${slot} could not be deleted: this browser refused the removal.`,
    });
  }, []);

  const exportSaveText = useCallback(() => exportSave(), []);

  const importSaveText = useCallback(
    async (text: string): Promise<boolean> => {
      // Cancelled for the same reason as a delete: the import just replaced the
      // stored file, and a timer armed by the outgoing game must not overwrite it.
      cancelPendingPersist();
      const file = importSave(text);
      if (file === null) {
        dispatch({
          type: 'notice',
          notice:
            'Nothing was changed: either that is not a save this build can read, or the stored save here was written by a newer build and is preserved.',
        });
        return false;
      }
      return await runLoad();
    },
    [runLoad, cancelPendingPersist],
  );

  const updateSettings = useCallback((partial: Partial<GameSettings>) => {
    dispatch({ type: 'settings', partial });
  }, []);

  const setActiveCompany = useCallback((companyId: string) => {
    const current = stateRef.current;
    writeStoredActiveCompanyId(current.session.sessionId, companyId);
    dispatch({ type: 'set_active_company', companyId });
  }, []);

  const dismissNotice = useCallback(() => dispatch({ type: 'notice', notice: null }), []);

  const refreshLlmHealth = useCallback(async () => {
    const health = await llmHealth(true);
    dispatch({ type: 'llm', health });
  }, []);

  const actions = useMemo<GameStoreActions>(
    () => ({
      newGame,
      validateIntent,
      queueAction,
      setActiveCompany,
      unqueueAction,
      confirmAction,
      clearQueue,
      endQuarter,
      saveGame,
      loadGame,
      deleteSave,
      saveToSlot,
      loadFromSlot,
      deleteSlot,
      loadSaveFile,
      exportSave: exportSaveText,
      importSave: importSaveText,
      updateSettings,
      dismissNotice,
      refreshLlmHealth,
    }),
    [
      newGame,
      validateIntent,
      queueAction,
      setActiveCompany,
      unqueueAction,
      confirmAction,
      clearQueue,
      endQuarter,
      saveGame,
      loadGame,
      deleteSave,
      saveToSlot,
      loadFromSlot,
      deleteSlot,
      loadSaveFile,
      exportSaveText,
      importSaveText,
      updateSettings,
      dismissNotice,
      refreshLlmHealth,
    ],
  );

  return (
    <StateContext.Provider value={state}>
      <ActionsContext.Provider value={actions}>{children}</ActionsContext.Provider>
    </StateContext.Provider>
  );
}

/* -------------------------------------------------------------------------- */
/*  Hooks                                                                      */
/* -------------------------------------------------------------------------- */

function useStore(): GameStoreState {
  const value = useContext(StateContext);
  if (value === null) throw new Error('useGame hooks must be used inside <GameProvider>.');
  return value;
}

/** Everything the store holds. Prefer a narrower hook where one exists. */
export function useGame(): GameStoreState {
  return useStore();
}

/** The store's action surface. Stable across renders. */
export function useGameActions(): GameStoreActions {
  const value = useContext(ActionsContext);
  if (value === null) throw new Error('useGameActions must be used inside <GameProvider>.');
  return value;
}

/** The canonical session state. */
export function useSession(): SessionState {
  return useStore().session;
}

/** The company the player directs, in full. */
export function usePlayerCompany(): Company {
  const session = useSession();
  return useMemo(() => playerCompanyOf(session), [session]);
}

/**
 * The company the player is currently *looking at* — STAGE 5's switcher.
 *
 * Reads for "the company I am directing right now": products, people,
 * research, financials, the company screen, boardroom, capital, the deal
 * room, government, markets tickets, and a network offer that acts on a
 * company's behalf. Every other screen still means "my own company" —
 * elimination, the founder-wealth board, the start page — and keeps reading
 * `usePlayerCompany`.
 *
 * Falls back to the founding company for the one render before the store's
 * own reconciliation (on load, or on a quarter that cost the seat control of
 * whatever it was directing) has run — never a company outside the group.
 */
export function useActiveCompany(): Company {
  const session = useSession();
  const { activeCompanyId } = useStore();
  return useMemo(() => {
    const found = session.companies.find((company) => company.id === activeCompanyId && company.isActive);
    return found ?? playerCompanyOf(session);
  }, [session, activeCompanyId]);
}

/** The raw `activeCompanyId`, for anything that needs the id rather than the full company (the switcher's own highlight, a route param). */
export function useActiveCompanyId(): string {
  return useStore().activeCompanyId;
}

/** Every company this seat directs, founding company first — the switcher's own list. */
export function useControlledCompanies(): Company[] {
  const session = useSession();
  return useMemo(() => controlledCompaniesOf(session, PLAYER_ID), [session]);
}

/** The founder character the player is. */
export function usePlayerCharacter(): Character {
  const session = useSession();
  return useMemo(() => playerCharacterOf(session), [session]);
}

/**
 * The redacted projection. Read this for anything about someone else: rival
 * secret programmes are absent from it and rival private confidence never
 * appears in its tech graph.
 */
export function usePlayerView(): PlayerView {
  const session = useSession();
  return useMemo(() => projectPlayerView(session), [session]);
}

/** Derived metrics for the player's company, or null before the first resolve. */
export function useCompanyMetrics(companyId?: string): CompanyQuarterMetrics | null {
  const session = useSession();
  const company = usePlayerCompany();
  const id = companyId ?? company.id;
  return useMemo(() => metricsFor(session, id), [session, id]);
}

/** Quotes for one instrument oldest-first, or every quote when no id is given. */
export function useQuotes(instrumentId?: string): Quote[] {
  const session = useSession();
  return useMemo(
    () => (instrumentId === undefined ? [...session.quotes].sort((a, b) => a.quarter - b.quarter) : quotesFor(session, instrumentId)),
    [session, instrumentId],
  );
}

/** All ten boards, or one when named. Empty until the first quarter resolves. */
export function useLeaderboards(board?: Leaderboard['board']): Leaderboard[] {
  const session = useSession();
  return useMemo(() => {
    if (board === undefined) return session.leaderboards;
    const found = leaderboardOf(session, board);
    return found === null ? [] : [found];
  }, [session, board]);
}

/** The queue the End Quarter screen consumes and the tray displays. */
export function useQueuedActions(): QueuedActionEntry[] {
  const { queuedActions, validations } = useStore();
  return useMemo(
    () =>
      queuedActions.map((action) => {
        const validation =
          validations[action.actionId] ??
          ({ actionId: action.actionId, status: 'accepted', reasons: [], codes: [], clampedAction: null } as ActionValidationResult);
        const confirmationRequired = needsConfirmation(action.intent.type);
        return {
          action,
          validation,
          needsConfirmation: confirmationRequired,
          blocked: confirmationRequired && !action.confirmedByHuman,
        };
      }),
    [queuedActions, validations],
  );
}

/** The last resolution outcome, or null before a quarter has been resolved in this tab. */
export function useOutcome(): FrontierResolutionOutcome | null {
  return useStore().lastOutcome;
}

/** The founder's connection level: the number the whole social layer turns on. */
export function useConnection(): number {
  return usePlayerCharacter().connectionLevel;
}

/** Market capitalisation of a company from state — quote when listed, anchor when private. */
export function useMarketCap(companyId?: string): number {
  const session = useSession();
  const company = usePlayerCompany();
  const id = companyId ?? company.id;
  return useMemo(() => marketCapOf(session, id), [session, id]);
}

/** The founder's personal net worth as the leaderboard measures it. */
export function useFounderNetWorth(): number {
  const session = useSession();
  return useMemo(() => founderNetWorth(session), [session]);
}

/** True while the engine is resolving a quarter in this tab. */
export function useResolving(): { resolving: boolean; status: string } {
  const { resolving, resolveStatus } = useStore();
  return useMemo(() => ({ resolving, status: resolveStatus }), [resolving, resolveStatus]);
}

/** True while a saved session is being replayed, with how far it has got. */
export function useLoading(): { loading: boolean; progress: ReplayProgress | null } {
  const { loading, loadProgress } = useStore();
  return useMemo(() => ({ loading, progress: loadProgress }), [loading, loadProgress]);
}

/** Player preferences. */
export function useSettings(): GameSettings {
  return useStore().settings;
}

/** Whether a live model is configured, and which one. */
export function useLlm(): LlmHealth {
  return useStore().llm;
}

export { seedOf };
