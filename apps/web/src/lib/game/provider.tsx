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
  NpcActionBundle,
  PlayerView,
  Quote,
  SessionDifficulty,
  SessionState,
  SubmittedAction,
  WorldState,
} from '@frontier/contracts';
import type { FrontierResolutionOutcome } from '@frontier/simulation';
import { llmHealth, requestNpcBundle, requestWorldDirector, type LlmHealth } from '@/lib/llm/client';
import {
  DEMO_SEED,
  PLAYER_ID,
  buildSubmittedAction,
  createSession,
  getEngine,
  needsConfirmation,
  playerCharacterOf,
  playerCompanyOf,
  seedOf,
} from './engine';
import { buildNpcStrategistInput, buildWorldDirectorInput, strategistCompanies } from './briefings';
import {
  MAX_REPLAY_QUARTERS,
  clearSaveFile,
  loadSavedGame,
  readSaveFile,
  writeSaveFile,
  type LoadedGame,
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
  readonly actionLog: readonly (readonly SubmittedAction[])[];
  readonly lastOutcome: FrontierResolutionOutcome | null;
  /** The world as it stood before the last resolve, for quarter-over-quarter deltas. */
  readonly previousWorld: WorldState | null;
  readonly resolving: boolean;
  /** Human-readable status shown on the resolving overlay. */
  readonly resolveStatus: string;
  readonly settings: GameSettings;
  /** False during the first render pass, before localStorage has been consulted. */
  readonly hydrated: boolean;
  readonly llm: LlmHealth;
  /** A transient message for the shell to surface, or null. */
  readonly notice: string | null;
  readonly nextSequence: number;
}

export interface GameStoreActions {
  newGame(options?: { seed?: number; difficulty?: SessionDifficulty; autoExecuteRoutine?: boolean }): void;
  /** Validate an intent without queuing it. Use for live previews and disabled states. */
  validateIntent(intent: ActionIntent): ActionValidationResult;
  /** Validate and queue. Returns the entry so a caller can render the outcome immediately. */
  queueAction(intent: ActionIntent, options?: { origin?: SubmittedAction['origin']; confirmed?: boolean }): QueuedActionEntry;
  unqueueAction(actionId: string): void;
  /** Record the explicit human confirmation a `CONFIRMATION_REQUIRED_ACTIONS` type needs. */
  confirmAction(actionId: string): void;
  clearQueue(): void;
  /** Resolve the open quarter. Always completes, with or without a model. */
  endQuarter(): Promise<void>;
  saveGame(): void;
  loadGame(): boolean;
  deleteSave(): void;
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
  | { type: 'loaded'; loaded: LoadedGame }
  | { type: 'hydrated' }
  | { type: 'queue'; action: SubmittedAction; validation: ActionValidationResult }
  | { type: 'unqueue'; actionId: string }
  | { type: 'confirm'; actionId: string; validation: ActionValidationResult }
  | { type: 'clear_queue' }
  | { type: 'resolve_start' }
  | { type: 'resolve_status'; status: string }
  | { type: 'resolve_done'; outcome: FrontierResolutionOutcome; submitted: readonly SubmittedAction[] }
  | { type: 'settings'; partial: Partial<GameSettings> }
  | { type: 'llm'; health: LlmHealth }
  | { type: 'notice'; notice: string | null };

const DEFAULT_SETTINGS: GameSettings = {
  seed: DEMO_SEED,
  difficulty: 'standard',
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
    llm: { available: false, transportKind: 'none', model: null },
    notice: null,
    nextSequence: 0,
  };
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
      };

    case 'loaded': {
      const settings: GameSettings = {
        ...state.settings,
        seed: action.loaded.seed,
        difficulty: action.loaded.difficulty,
      };
      const notice =
        action.loaded.rejectedQuarters.length > 0
          ? `Replay stopped at quarter ${action.loaded.rejectedQuarters[0]}: a recorded quarter no longer commits under the current engine.`
          : null;
      return {
        ...state,
        session: action.loaded.session,
        actionLog: action.loaded.actionLog,
        settings,
        queuedActions: [],
        validations: {},
        lastOutcome: null,
        previousWorld: null,
        notice,
        hydrated: true,
        nextSequence: 0,
      };
    }

    case 'hydrated':
      return state.hydrated ? state : { ...state, hydrated: true };

    case 'queue':
      return {
        ...state,
        queuedActions: [...state.queuedActions, action.action],
        validations: { ...state.validations, [action.action.actionId]: action.validation },
        nextSequence: state.nextSequence + 1,
      };

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
          lastOutcome: outcome,
          notice: 'The quarter did not commit: an engine invariant refused it. Nothing changed — the report explains what failed.',
        };
      }
      return {
        ...state,
        session: outcome.nextState,
        previousWorld: state.session.world,
        queuedActions: [],
        validations: {},
        actionLog: [...state.actionLog, [...action.submitted]].slice(-MAX_REPLAY_QUARTERS),
        lastOutcome: outcome,
        resolving: false,
        resolveStatus: '',
        nextSequence: 0,
      };
    }

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

  /* --- hydrate from the save file, once ----------------------------------- */
  useEffect(() => {
    const loaded = loadSavedGame();
    if (loaded === null) dispatch({ type: 'hydrated' });
    else dispatch({ type: 'loaded', loaded });
  }, []);

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
    if (!state.hydrated) return;
    if (state.actionLog.length === 0 && readSaveFile() === null) return;
    writeSaveFile({
      version: 1,
      seed: state.settings.seed,
      difficulty: state.settings.difficulty,
      actionLog: state.actionLog,
      savedQuarter: state.session.quarter,
    });
  }, [state.actionLog, state.hydrated, state.session.quarter, state.settings.difficulty, state.settings.seed]);

  /* --- actions ------------------------------------------------------------- */

  const validateIntent = useCallback((intent: ActionIntent): ActionValidationResult => {
    const current = stateRef.current;
    return getEngine().validator.validate(current.session, intent, PLAYER_ID);
  }, []);

  const queueAction = useCallback<GameStoreActions['queueAction']>((intent, options) => {
    const current = stateRef.current;
    const confirmed = options?.confirmed ?? !needsConfirmation(intent.type);
    const submitted = buildSubmittedAction(current.session, intent, current.nextSequence, {
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
  }, []);

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

  const endQuarter = useCallback(async () => {
    const current = stateRef.current;
    if (current.resolving) return;

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

    let outcome: FrontierResolutionOutcome;
    const engine = getEngine();
    try {
      outcome = engine.resolver.resolveQuarter(session, submitted, gmProposal, npcBundles);
    } catch {
      // Anything the model contributed is discarded and the quarter resolves
      // fully offline. The game never blocks on a model.
      outcome = engine.resolver.resolveQuarter(session, submitted, null, []);
    }

    dispatch({ type: 'resolve_done', outcome, submitted });
  }, []);

  const newGame = useCallback<GameStoreActions['newGame']>((options) => {
    const current = stateRef.current;
    const settings: GameSettings = {
      ...current.settings,
      seed: options?.seed ?? current.settings.seed,
      difficulty: options?.difficulty ?? current.settings.difficulty,
      autoExecuteRoutine: options?.autoExecuteRoutine ?? current.settings.autoExecuteRoutine,
    };
    const session = createSession({
      seed: settings.seed,
      difficulty: settings.difficulty,
      autoExecuteRoutine: settings.autoExecuteRoutine,
    });
    clearSaveFile();
    dispatch({ type: 'new_game', session, settings });
  }, []);

  const saveGame = useCallback(() => {
    const current = stateRef.current;
    writeSaveFile({
      version: 1,
      seed: current.settings.seed,
      difficulty: current.settings.difficulty,
      actionLog: current.actionLog,
      savedQuarter: current.session.quarter,
    });
    dispatch({ type: 'notice', notice: 'Session saved.' });
  }, []);

  const loadGame = useCallback(() => {
    const loaded = loadSavedGame();
    if (loaded === null) {
      dispatch({ type: 'notice', notice: 'No saved session found in this browser.' });
      return false;
    }
    dispatch({ type: 'loaded', loaded });
    return true;
  }, []);

  const deleteSave = useCallback(() => {
    clearSaveFile();
    dispatch({ type: 'notice', notice: 'Saved session deleted.' });
  }, []);

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

/** Player preferences. */
export function useSettings(): GameSettings {
  return useStore().settings;
}

/** Whether a live model is configured, and which one. */
export function useLlm(): LlmHealth {
  return useStore().llm;
}

export { seedOf };
