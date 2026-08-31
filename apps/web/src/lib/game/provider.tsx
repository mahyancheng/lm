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
  NpcActionBundle,
  PlayerView,
  Quote,
  SessionDifficulty,
  SessionState,
  SubmittedAction,
  WorldState,
} from '@frontier/contracts';
import type { FrontierResolutionOutcome } from '@frontier/simulation';
import { projectResolutionOutcomeForPlayer } from '@frontier/simulation';
import { llmHealth, requestNpcBundle, requestWorldDirector, type LlmHealth } from '@/lib/llm/client';
import {
  DEMO_SEED,
  PLAYER_ID,
  buildSubmittedAction,
  createSession,
  createSequenceAllocator,
  getEngine,
  needsConfirmation,
  playerCharacterOf,
  playerCompanyOf,
  resolveQuarterSafely,
  seedOf,
} from './engine';
import { buildNpcStrategistInput, buildWorldDirectorInput, strategistCompanies } from './briefings';
import {
  MAX_REPLAY_QUARTERS,
  buildSaveFile,
  clearSaveFile,
  exportSave,
  importSave,
  hasStoredSave,
  inspectSave,
  loadSavedGameAsync,
  writeSaveFile,
  type LoadedGame,
  type SaveFile,
  type QuarterRecord,
  type ReplayProgress,
} from './persistence';
import {
  founderNetWorth,
  leaderboardOf,
  marketCapOf,
  metricsFor,
  projectPlayerView,
  quotesFor,
} from './playerView';

/* -------------------------------------------------------------------------- */
/*  Shapes                                                                     */
/* -------------------------------------------------------------------------- */

export interface GameSettings {
  readonly seed: number;
  readonly difficulty: SessionDifficulty;
  /** The new-game setup this session was started with, or null for the default world. Immutable once set. */
  readonly setup: NewGameSetup | null;
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
  newGame(options?: { seed?: number; difficulty?: SessionDifficulty; autoExecuteRoutine?: boolean; setup?: NewGameSetup }): void;
  /** Validate an intent without queuing it. Use for live previews and disabled states. */
  validateIntent(intent: ActionIntent): ActionValidationResult;
  /** Validate and queue. Returns the entry so a caller can render the outcome immediately. */
  queueAction(intent: ActionIntent, options?: { origin?: SubmittedAction['origin']; confirmed?: boolean }): QueuedActionEntry;
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
  | { type: 'new_game'; session: SessionState; settings: GameSettings }
  | { type: 'load_start' }
  | { type: 'load_progress'; progress: ReplayProgress }
  | { type: 'loaded'; loaded: LoadedGame }
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
  | { type: 'notice'; notice: string | null };

const DEFAULT_SETTINGS: GameSettings = {
  seed: DEMO_SEED,
  difficulty: 'standard',
  setup: null,
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
        saveWritable: true,
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
        autoExecuteRoutine: action.loaded.autoExecuteRoutine,
      };
      // A partial replay is read-only. The stored file still holds every quarter
      // the player recorded; writing the prefix that happened to load back over
      // it would destroy the rest permanently, and no engine fix could recover
      // them afterwards.
      const preserved =
        'Your saved session has been left exactly as it was — nothing will be written over it until you start a new game.';
      const notice = action.loaded.complete
        ? null
        : action.loaded.rejectedQuarters.length > 0
          ? `Replay stopped at quarter ${action.loaded.rejectedQuarters[0]}: a recorded quarter no longer commits under the current engine. ${preserved}`
          : `This save is longer than the ${MAX_REPLAY_QUARTERS}-quarter ceiling a replay from the seed can rebuild, and its checkpoint could not be read. You are at quarter ${action.loaded.session.quarter}. ${preserved}`;
      return {
        ...state,
        session: action.loaded.session,
        actionLog: action.loaded.log,
        settings,
        queuedActions: [],
        validations: {},
        lastOutcome: null,
        previousWorld: null,
        notice,
        hydrated: true,
        loading: false,
        loadProgress: null,
        saveWritable: action.loaded.complete,
        nextSequence: 0,
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

  /* --- replay the save file, once ------------------------------------------ */
  const runLoad = useCallback(async (): Promise<boolean> => {
    const inspection = inspectSave();
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
    const loaded = await loadSavedGameAsync({
      onProgress: (progress) => dispatch({ type: 'load_progress', progress }),
      yieldControl: nextPaint,
    });
    if (loaded === null) {
      dispatch({
        type: 'load_failed',
        notice: 'The saved session could not be replayed. It has been left in place, so nothing is lost — start a new session or import a save.',
      });
      return false;
    }
    sequences.reset(0);
    savedFile.current = inspection.file;
    dispatch({ type: 'loaded', loaded });
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

  /* --- persist the decision log ------------------------------------------- */
  useEffect(() => {
    if (!state.hydrated || state.loading) return;
    // A replay that did not finish, or a file this build cannot read, is never
    // written over: the stored decisions outrank whatever is in this tab.
    if (!state.saveWritable) return;
    if (state.actionLog.length === 0 && !hasStoredSave()) return;
    const file = buildSaveFile({
      seed: state.settings.seed,
      difficulty: state.settings.difficulty,
      autoExecuteRoutine: state.settings.autoExecuteRoutine,
      setup: state.settings.setup,
      log: state.actionLog,
      session: state.session,
      previous: savedFile.current,
    });
    if (writeSaveFile(file)) savedFile.current = file;
  }, [
    state.actionLog,
    state.hydrated,
    state.loading,
    state.saveWritable,
    state.session,
    state.settings.autoExecuteRoutine,
    state.settings.difficulty,
    state.settings.seed,
    state.settings.setup,
  ]);

  /* --- actions ------------------------------------------------------------- */

  const validateIntent = useCallback((intent: ActionIntent): ActionValidationResult => {
    const current = stateRef.current;
    return getEngine().validator.validate(current.session, intent, PLAYER_ID);
  }, []);

  const queueAction = useCallback<GameStoreActions['queueAction']>((intent, options) => {
    const current = stateRef.current;
    const confirmed = options?.confirmed ?? !needsConfirmation(intent.type);
    const submitted = buildSubmittedAction(current.session, intent, sequences.next(), {
      origin: options?.origin ?? 'player_ui',
      confirmedByHuman: confirmed,
    });
    const raw = getEngine().validator.validate(current.session, intent, submitted.actorPlayerId);
    const validation: ActionValidationResult = { ...raw, actionId: submitted.actionId };
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
    const raw = getEngine().validator.validate(current.session, entry.intent, entry.actorPlayerId);
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

    if (current.settings.useLiveModel) {
      try {
        const health = await llmHealth();
        if (health.available) {
          dispatch({ type: 'resolve_status', status: 'Consulting the World Director' });
          const directorInput = buildWorldDirectorInput(session, current.previousWorld);
          if (directorInput !== null) gmProposal = await requestWorldDirector(directorInput);

          dispatch({ type: 'resolve_status', status: 'Rival strategists are planning' });
          const ids = strategistCompanies(session);
          const settled = await Promise.all(
            ids.map(async (companyId) => {
              const input = buildNpcStrategistInput(session, companyId);
              return input === null ? null : await requestNpcBundle(input);
            }),
          );
          npcBundles = settled.filter((bundle): bundle is NpcActionBundle => bundle !== null);
        }
      } catch {
        // An LLM outage is not an error condition. Fall through to the
        // deterministic path with nothing from the model.
        gmProposal = null;
        npcBundles = [];
      }
    }

    dispatch({ type: 'resolve_status', status: 'Resolving eighteen phases' });
    await nextPaint();

    // The record holds the inputs the surviving attempt was *actually* handed:
    // when the model's contribution makes the engine throw and the offline retry
    // succeeds, a replay must reproduce the quarter that happened.
    const attempt = resolveQuarterSafely(session, submitted, gmProposal, npcBundles);
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

    dispatch({
      type: 'resolve_done',
      outcome: attempt.outcome,
      record: {
        quarter: session.quarter,
        actions: submitted,
        gmProposal: attempt.gmProposal,
        npcBundles: [...attempt.npcBundles],
      },
    });
    if (attempt.outcome.committed) sequences.reset(0);
    return true;
  }, [sequences]);

  const newGame = useCallback<GameStoreActions['newGame']>((options) => {
    const current = stateRef.current;
    // The setup is per-game: a new game takes what it was given, and defaults to
    // the classic world when none is supplied.
    const setup = options?.setup ?? null;
    const settings: GameSettings = {
      ...current.settings,
      seed: options?.seed ?? current.settings.seed,
      difficulty: options?.difficulty ?? current.settings.difficulty,
      setup,
      autoExecuteRoutine: options?.autoExecuteRoutine ?? current.settings.autoExecuteRoutine,
    };
    const session = createSession({
      seed: settings.seed,
      difficulty: settings.difficulty,
      autoExecuteRoutine: settings.autoExecuteRoutine,
      setup: setup ?? undefined,
    });
    clearSaveFile();
    savedFile.current = null;
    sequences.reset(0);
    dispatch({ type: 'new_game', session, settings });
  }, [sequences]);

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
      session: current.session,
      previous: savedFile.current,
    });
    const wrote = writeSaveFile(file);
    if (wrote) savedFile.current = file;
    dispatch({
      type: 'notice',
      notice: wrote ? 'Session saved.' : 'The session could not be saved: this browser refused the write and the stored file is unchanged.',
    });
  }, []);

  const loadGame = useCallback(async (): Promise<boolean> => {
    if (inspectSave().status === 'absent') {
      dispatch({ type: 'notice', notice: 'No saved session found in this browser.' });
      return false;
    }
    return await runLoad();
  }, [runLoad]);

  const deleteSave = useCallback(() => {
    clearSaveFile();
    savedFile.current = null;
    dispatch({ type: 'notice', notice: 'Saved session deleted.' });
  }, []);

  const exportSaveText = useCallback(() => exportSave(), []);

  const importSaveText = useCallback(
    async (text: string): Promise<boolean> => {
      const file = importSave(text);
      if (file === null) {
        dispatch({ type: 'notice', notice: 'That is not a Frontier Capital save this build can read. Nothing was changed.' });
        return false;
      }
      return await runLoad();
    },
    [runLoad],
  );

  const updateSettings = useCallback((partial: Partial<GameSettings>) => {
    dispatch({ type: 'settings', partial });
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
      unqueueAction,
      confirmAction,
      clearQueue,
      endQuarter,
      saveGame,
      loadGame,
      deleteSave,
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
      unqueueAction,
      confirmAction,
      clearQueue,
      endQuarter,
      saveGame,
      loadGame,
      deleteSave,
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
