/**
 * Replay-based persistence.
 *
 * A saved game is not a serialised world. It is the seed and the decisions:
 *
 * ```json
 * { "version": 1, "seed": 424242, "difficulty": "standard",
 *   "actionLog": [[...q0 actions...], [...q1 actions...]] }
 * ```
 *
 * Loading re-resolves those quarters from the seed. That is not a trick — it is
 * the engine's first invariant (`deterministic_replay`) used as a storage
 * format: same state plus same recorded decisions plus same seed produces the
 * same outcome, always. The file stays small, it never goes stale against an
 * engine change in a way we cannot detect, and a save can be replayed
 * server-side to verify a client never manufactured anything.
 *
 * The replay is capped at `MAX_REPLAY_QUARTERS`; a longer session would want
 * snapshots, which is what Supabase mode has.
 */

import type { SessionDifficulty, SessionState, SubmittedAction } from '@frontier/contracts';
import { SESSION_DIFFICULTIES } from '@frontier/contracts';
import { getEngine, createSession, DEMO_SEED } from './engine';

export const SAVE_KEY = 'frontier-demo-v1';
export const SAVE_VERSION = 1;

/** Replay depth ceiling. Ten years of quarters. */
export const MAX_REPLAY_QUARTERS = 40;

/** The shape written to `localStorage`. */
export interface SaveFile {
  readonly version: number;
  readonly seed: number;
  readonly difficulty: SessionDifficulty;
  /** One entry per resolved quarter, in order, holding the actions submitted for it. */
  readonly actionLog: readonly (readonly SubmittedAction[])[];
  /** Advisory only; never trusted on load. */
  readonly savedQuarter: number;
}

export interface LoadedGame {
  readonly session: SessionState;
  readonly actionLog: SubmittedAction[][];
  readonly seed: number;
  readonly difficulty: SessionDifficulty;
  /** Quarters that were replayed but did not commit, if any. */
  readonly rejectedQuarters: number[];
}

function storage(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/*  Read                                                                       */
/* -------------------------------------------------------------------------- */

/** Parse the save file without replaying it. Returns null when absent or unreadable. */
export function readSaveFile(): SaveFile | null {
  const store = storage();
  if (store === null) return null;
  try {
    const raw = store.getItem(SAVE_KEY);
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as Partial<SaveFile>;
    if (parsed.version !== SAVE_VERSION) return null;
    const seed = typeof parsed.seed === 'number' && Number.isFinite(parsed.seed) ? parsed.seed : DEMO_SEED;
    const difficulty = SESSION_DIFFICULTIES.includes(parsed.difficulty as SessionDifficulty)
      ? (parsed.difficulty as SessionDifficulty)
      : 'standard';
    const actionLog = Array.isArray(parsed.actionLog) ? parsed.actionLog : [];
    return {
      version: SAVE_VERSION,
      seed,
      difficulty,
      actionLog: actionLog.slice(0, MAX_REPLAY_QUARTERS) as readonly (readonly SubmittedAction[])[],
      savedQuarter: typeof parsed.savedQuarter === 'number' ? parsed.savedQuarter : actionLog.length,
    };
  } catch {
    return null;
  }
}

/** Is there a game to continue? */
export function hasSavedGame(): boolean {
  return readSaveFile() !== null;
}

/* -------------------------------------------------------------------------- */
/*  Write                                                                      */
/* -------------------------------------------------------------------------- */

/** Persist the seed and the decision log. Failures are silent by design. */
export function writeSaveFile(file: SaveFile): void {
  const store = storage();
  if (store === null) return;
  try {
    store.setItem(SAVE_KEY, JSON.stringify(file));
  } catch {
    /* Quota or private mode: the session simply is not persisted. */
  }
}

/** Remove the save. */
export function clearSaveFile(): void {
  const store = storage();
  if (store === null) return;
  try {
    store.removeItem(SAVE_KEY);
  } catch {
    /* nothing to do */
  }
}

/* -------------------------------------------------------------------------- */
/*  Replay                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Rebuild a session by re-resolving its recorded quarters from the seed.
 *
 * Offline and deterministic: no World Director proposal and no NPC bundles, so
 * a replay of a save made with a live model still reproduces the same
 * *decisions* against the same deterministic fallbacks. Quarters that fail to
 * commit are reported rather than silently skipped.
 */
export function replay(file: SaveFile): LoadedGame {
  const engine = getEngine();
  let session = createSession({ seed: file.seed, difficulty: file.difficulty });
  const replayed: SubmittedAction[][] = [];
  const rejectedQuarters: number[] = [];

  const quarters = file.actionLog.slice(0, MAX_REPLAY_QUARTERS);
  for (const actions of quarters) {
    const list = [...actions];
    let outcome;
    try {
      outcome = engine.resolver.resolveQuarter(session, list, null, []);
    } catch {
      break;
    }
    if (!outcome.committed) {
      rejectedQuarters.push(session.quarter);
      break;
    }
    session = outcome.nextState;
    replayed.push(list);
  }

  return { session, actionLog: replayed, seed: file.seed, difficulty: file.difficulty, rejectedQuarters };
}

/** Read and replay in one step. Returns null when there is nothing to continue. */
export function loadSavedGame(): LoadedGame | null {
  const file = readSaveFile();
  if (file === null) return null;
  try {
    return replay(file);
  } catch {
    return null;
  }
}
