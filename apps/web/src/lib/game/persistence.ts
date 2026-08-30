/**
 * Replay-based persistence, with checkpoints.
 *
 * A saved game is not a serialised world. It is the seed and the *inputs to F*:
 *
 * ```json
 * { "version": 2, "seed": 424242, "difficulty": "standard",
 *   "log": [{ "quarter": 0, "actions": [...], "gmProposal": null, "npcBundles": [] }],
 *   "checkpoint": { "quarter": 8, "state": { ... } } }
 * ```
 *
 * `S_{t+1} = F(S_t, actions, agents, seed)`, so a save that records only the
 * player's actions cannot reproduce a quarter a live World Director or an NPC
 * strategist contributed to. Every input is recorded instead: the submitted
 * actions **and** the agent proposals the resolver was actually handed (null and
 * `[]` when the quarter resolved offline). Those proposals are already
 * zod-validated and re-validated by the engine on replay, so persisting them
 * costs nothing in trust and buys exact reproduction.
 *
 * Two ceilings meet here and neither may destroy a decision:
 *
 * - **Work.** Every `CHECKPOINT_INTERVAL` quarters the session state is
 *   snapshotted beside the log, and a load replays forward from the newest
 *   checkpoint. A hundred-quarter session therefore costs at most seven
 *   quarters of replay, not a hundred.
 * - **Size.** The log is never trimmed on a normal write. Only a quota failure
 *   prunes it, and only the entries the checkpoint has already absorbed.
 *
 * A file this build cannot read is **preserved, never overwritten**: an unknown
 * `version` is refused on read and refused again on write, so a save written by
 * a newer build survives being opened by an older one.
 */

import type {
  GmProposalBatch,
  NpcActionBundle,
  SessionDifficulty,
  SessionState,
  SubmittedAction,
} from '@frontier/contracts';
import {
  GmProposalBatchSchema,
  NpcActionBundleSchema,
  SESSION_DIFFICULTIES,
  SessionStateSchema,
  SubmittedActionSchema,
} from '@frontier/contracts';
import { getEngine, createSession, DEMO_SEED } from './engine';

export const SAVE_KEY = 'frontier-demo-v1';
export const SAVE_VERSION = 2;

/** Replay depth ceiling for a save with no usable checkpoint. Ten years of quarters. */
export const MAX_REPLAY_QUARTERS = 40;

/** Quarters between state snapshots. A load never replays more than this many. */
export const CHECKPOINT_INTERVAL = 8;

/** Everything the resolver was handed for one quarter. */
export interface QuarterRecord {
  /** The quarter this was submitted for. Asserted against the session on replay. */
  readonly quarter: number;
  readonly actions: readonly SubmittedAction[];
  /** What the World Director proposed, or null when the quarter resolved offline. */
  readonly gmProposal: GmProposalBatch | null;
  /** What the rival strategists proposed. Empty when the quarter resolved offline. */
  readonly npcBundles: readonly NpcActionBundle[];
}

/** A serialised session, so a long save does not cost a long replay. */
export interface SaveCheckpoint {
  /** The quarter this state is *open* at: replay resumes with the record for it. */
  readonly quarter: number;
  readonly state: SessionState;
}

/** The shape written to `localStorage`. */
export interface SaveFile {
  readonly version: number;
  readonly seed: number;
  readonly difficulty: SessionDifficulty;
  /** Part of the starting state, so a replay must restore it too. */
  readonly autoExecuteRoutine: boolean;
  /** One entry per resolved quarter, in order, holding every input to it. */
  readonly log: readonly QuarterRecord[];
  readonly checkpoint: SaveCheckpoint | null;
  /** Advisory only; never trusted on load. */
  readonly savedQuarter: number;
}

export interface LoadedGame {
  readonly session: SessionState;
  /** The **full** recorded log, exactly as stored — not the replayed prefix. */
  readonly log: QuarterRecord[];
  readonly seed: number;
  readonly difficulty: SessionDifficulty;
  readonly autoExecuteRoutine: boolean;
  /** Quarters that were replayed but did not commit, if any. */
  readonly rejectedQuarters: number[];
  /** True when every recorded quarter replayed and committed. */
  readonly complete: boolean;
  /** The quarter the replay resumed from: a checkpoint, or 0 from the seed. */
  readonly replayedFrom: number;
  readonly replayedCount: number;
}

/** Why a stored file could not be read. `unsupported` is preserved, never overwritten. */
export type SaveStatus = 'absent' | 'ok' | 'unreadable' | 'unsupported';

export interface SaveInspection {
  readonly status: SaveStatus;
  readonly version: number | null;
  readonly file: SaveFile | null;
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

function parseRecords(raw: unknown): QuarterRecord[] {
  if (!Array.isArray(raw)) return [];
  const records: QuarterRecord[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object') continue;
    const value = entry as Record<string, unknown>;
    const quarter = typeof value.quarter === 'number' && Number.isInteger(value.quarter) ? value.quarter : records.length;
    const actions: SubmittedAction[] = [];
    if (Array.isArray(value.actions)) {
      for (const action of value.actions) {
        const parsed = SubmittedActionSchema.safeParse(action);
        if (parsed.success) actions.push(parsed.data);
      }
    }
    const gm = GmProposalBatchSchema.safeParse(value.gmProposal);
    const npcBundles: NpcActionBundle[] = [];
    if (Array.isArray(value.npcBundles)) {
      for (const bundle of value.npcBundles) {
        const parsed = NpcActionBundleSchema.safeParse(bundle);
        if (parsed.success) npcBundles.push(parsed.data);
      }
    }
    records.push({ quarter, actions, gmProposal: gm.success ? gm.data : null, npcBundles });
  }
  return records;
}

/** A v1 file recorded only the player's actions, and replayed them offline. */
function migrateV1(raw: unknown): QuarterRecord[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((actions, index) => {
    const list: SubmittedAction[] = [];
    if (Array.isArray(actions)) {
      for (const action of actions) {
        const parsed = SubmittedActionSchema.safeParse(action);
        if (parsed.success) list.push(parsed.data);
      }
    }
    return { quarter: index, actions: list, gmProposal: null, npcBundles: [] };
  });
}

function parseCheckpoint(raw: unknown): SaveCheckpoint | null {
  if (raw === null || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.quarter !== 'number' || !Number.isInteger(value.quarter) || value.quarter < 0) return null;
  const parsed = SessionStateSchema.safeParse(value.state);
  if (!parsed.success) return null;
  if (parsed.data.quarter !== value.quarter) return null;
  return { quarter: value.quarter, state: parsed.data };
}

/**
 * Read the stored file and say what it is.
 *
 * A version this build does not know is reported as `unsupported` rather than
 * as absent, so nothing downstream mistakes it for an empty slot and writes
 * over it.
 */
export function inspectSave(): SaveInspection {
  const store = storage();
  if (store === null) return { status: 'absent', version: null, file: null };
  let raw: string | null;
  try {
    raw = store.getItem(SAVE_KEY);
  } catch {
    return { status: 'unreadable', version: null, file: null };
  }
  if (raw === null) return { status: 'absent', version: null, file: null };

  let parsed: Record<string, unknown>;
  try {
    const value = JSON.parse(raw) as unknown;
    if (value === null || typeof value !== 'object') return { status: 'unreadable', version: null, file: null };
    parsed = value as Record<string, unknown>;
  } catch {
    return { status: 'unreadable', version: null, file: null };
  }

  const version = typeof parsed.version === 'number' ? parsed.version : null;
  if (version !== 1 && version !== SAVE_VERSION) return { status: 'unsupported', version, file: null };

  const seed = typeof parsed.seed === 'number' && Number.isFinite(parsed.seed) ? parsed.seed : DEMO_SEED;
  const difficulty = SESSION_DIFFICULTIES.includes(parsed.difficulty as SessionDifficulty)
    ? (parsed.difficulty as SessionDifficulty)
    : 'standard';
  const log = version === 1 ? migrateV1(parsed.actionLog) : parseRecords(parsed.log);
  const checkpoint = version === 1 ? null : parseCheckpoint(parsed.checkpoint ?? null);
  const savedQuarter =
    typeof parsed.savedQuarter === 'number' && Number.isInteger(parsed.savedQuarter)
      ? parsed.savedQuarter
      : (log[log.length - 1]?.quarter ?? -1) + 1;

  return {
    status: 'ok',
    version,
    file: {
      version: SAVE_VERSION,
      seed,
      difficulty,
      autoExecuteRoutine: parsed.autoExecuteRoutine === true,
      log,
      checkpoint,
      savedQuarter,
    },
  };
}

/**
 * Parse the save file without replaying it. Returns null when absent or
 * unreadable.
 *
 * This validates a checkpoint against `SessionStateSchema`, which is not free —
 * call it on a load or a user action, not on every write. `hasStoredSave` and
 * `storedSaveVersion` answer the two cheap questions the write path asks.
 */
export function readSaveFile(): SaveFile | null {
  return inspectSave().file;
}

/** Is there a game to continue? */
export function hasSavedGame(): boolean {
  return readSaveFile() !== null;
}

/** Is anything at all stored, without parsing it? */
export function hasStoredSave(): boolean {
  const store = storage();
  if (store === null) return false;
  try {
    return store.getItem(SAVE_KEY) !== null;
  } catch {
    return false;
  }
}

/** The stored file's version, or null when absent or unreadable. */
export function storedSaveVersion(): number | null {
  const store = storage();
  if (store === null) return null;
  try {
    const raw = store.getItem(SAVE_KEY);
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== 'object') return null;
    const version = (parsed as Record<string, unknown>).version;
    return typeof version === 'number' ? version : null;
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/*  Write                                                                      */
/* -------------------------------------------------------------------------- */

/** Assemble the file for a session, carrying or refreshing its checkpoint. */
export function buildSaveFile(input: {
  readonly seed: number;
  readonly difficulty: SessionDifficulty;
  readonly autoExecuteRoutine: boolean;
  readonly log: readonly QuarterRecord[];
  /** The session as it now stands, i.e. with `quarter` open and unresolved. */
  readonly session: SessionState;
  readonly previous?: SaveFile | null;
}): SaveFile {
  const previous = input.previous ?? null;
  const due = input.session.quarter > 0 && input.session.quarter % CHECKPOINT_INTERVAL === 0;
  const carried = previous?.checkpoint ?? null;
  const checkpoint: SaveCheckpoint | null = due
    ? { quarter: input.session.quarter, state: input.session }
    : carried !== null && carried.quarter <= input.session.quarter
      ? carried
      : null;
  return {
    version: SAVE_VERSION,
    seed: input.seed,
    difficulty: input.difficulty,
    autoExecuteRoutine: input.autoExecuteRoutine,
    log: input.log,
    checkpoint,
    savedQuarter: input.session.quarter,
  };
}

/**
 * Persist the seed, the decision log and the checkpoint.
 *
 * Refuses to overwrite a stored file whose version this build cannot read —
 * losing a save to a downgrade is worse than not saving. Returns whether it
 * wrote. A quota failure prunes the entries the checkpoint has already absorbed
 * and tries once more; a second failure is silent by design.
 */
export function writeSaveFile(file: SaveFile): boolean {
  const store = storage();
  if (store === null) return false;
  const stored = storedSaveVersion();
  if (stored !== null && stored !== 1 && stored !== SAVE_VERSION) return false;

  try {
    store.setItem(SAVE_KEY, JSON.stringify(file));
    return true;
  } catch {
    /* Quota: fall through to the pruned form. */
  }

  // Only the entries a checkpoint has already absorbed may be dropped: their
  // effect is in the snapshot, so nothing is lost. With no checkpoint there is
  // nothing safe to prune, and failing to save beats destroying a decision.
  const floor = file.checkpoint?.quarter;
  if (floor === undefined) return false;
  const pruned: SaveFile = { ...file, log: file.log.filter((record) => record.quarter >= floor) };
  try {
    store.setItem(SAVE_KEY, JSON.stringify(pruned));
    return true;
  } catch {
    return false;
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

/** The stored file as text, for the player to keep somewhere we do not control. */
export function exportSave(): string | null {
  const file = readSaveFile();
  return file === null ? null : JSON.stringify(file);
}

/**
 * Adopt a pasted save. Validates before it writes: a file that will not parse
 * never replaces one that does.
 */
export function importSave(text: string): SaveFile | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  const value = parsed as Record<string, unknown>;
  const version = typeof value.version === 'number' ? value.version : null;
  if (version !== 1 && version !== SAVE_VERSION) return null;

  const log = version === 1 ? migrateV1(value.actionLog) : parseRecords(value.log);
  const file: SaveFile = {
    version: SAVE_VERSION,
    seed: typeof value.seed === 'number' && Number.isFinite(value.seed) ? value.seed : DEMO_SEED,
    difficulty: SESSION_DIFFICULTIES.includes(value.difficulty as SessionDifficulty)
      ? (value.difficulty as SessionDifficulty)
      : 'standard',
    autoExecuteRoutine: value.autoExecuteRoutine === true,
    log,
    checkpoint: version === 1 ? null : parseCheckpoint(value.checkpoint ?? null),
    savedQuarter:
      typeof value.savedQuarter === 'number' && Number.isInteger(value.savedQuarter)
        ? value.savedQuarter
        : (log[log.length - 1]?.quarter ?? -1) + 1,
  };

  const store = storage();
  if (store === null) return file;
  try {
    store.setItem(SAVE_KEY, JSON.stringify(file));
  } catch {
    return null;
  }
  return file;
}

/* -------------------------------------------------------------------------- */
/*  Replay                                                                     */
/* -------------------------------------------------------------------------- */

/** How far a load has got, for a progress indicator. */
export interface ReplayProgress {
  readonly completed: number;
  readonly total: number;
  /** The quarter about to be replayed. */
  readonly quarter: number;
}

export interface ReplayOptions {
  readonly onProgress?: (progress: ReplayProgress) => void;
  /** Awaited between quarters so the tab paints instead of freezing. */
  readonly yieldControl?: () => Promise<void>;
}

/**
 * Rebuild a session by re-resolving its recorded quarters.
 *
 * The replay resumes from the newest checkpoint when there is one, so the work
 * is bounded by `CHECKPOINT_INTERVAL` however long the session is. Each record
 * is replayed with the *same* inputs the live resolve was handed — the player's
 * actions and the agent proposals — so a save made with a live model reproduces
 * the world it was made in, not a different one.
 *
 * A record whose `quarter` does not match the session it would be replayed into
 * is a refusal, not a silent skip: the engine's action collector would drop such
 * actions without a ledger row, which is exactly the failure this guard exists
 * to make visible.
 */
function* replaySteps(file: SaveFile): Generator<ReplayProgress, LoadedGame, void> {
  const engine = getEngine();
  const log = [...file.log].sort((a, b) => a.quarter - b.quarter);

  // A checkpoint is usable when the records it does not already absorb resume
  // exactly where it left off. A gap means the file was edited or truncated
  // between the two, and replaying across it would apply a quarter's decisions
  // to a world they were never taken in.
  const candidate = file.checkpoint;
  const after = candidate === null ? [] : log.filter((record) => record.quarter >= candidate.quarter);
  const usable = candidate !== null && (after.length === 0 || after[0]?.quarter === candidate.quarter) ? candidate : null;
  let session =
    usable === null
      ? createSession({ seed: file.seed, difficulty: file.difficulty, autoExecuteRoutine: file.autoExecuteRoutine })
      : usable.state;
  const replayedFrom = usable === null ? 0 : usable.quarter;

  const outstanding = log.filter((record) => record.quarter >= replayedFrom);
  // With a checkpoint the work is bounded by the interval. Without one — an
  // unreadable snapshot, or a hand-edited file — it is bounded by the ceiling
  // instead, and a log that exceeds it loads as incomplete rather than replaying
  // for minutes. Incomplete means read-only, so nothing is written over.
  const pending = usable === null ? outstanding.slice(0, MAX_REPLAY_QUARTERS) : outstanding;
  const rejectedQuarters: number[] = [];
  let replayedCount = 0;
  let complete = pending.length === outstanding.length;

  for (const record of pending) {
    yield { completed: replayedCount, total: pending.length, quarter: record.quarter };

    if (record.quarter !== session.quarter) {
      rejectedQuarters.push(record.quarter);
      complete = false;
      break;
    }
    let outcome;
    try {
      outcome = engine.resolver.resolveQuarter(session, [...record.actions], record.gmProposal, [...record.npcBundles]);
    } catch {
      rejectedQuarters.push(session.quarter);
      complete = false;
      break;
    }
    if (!outcome.committed) {
      rejectedQuarters.push(session.quarter);
      complete = false;
      break;
    }
    session = outcome.nextState;
    replayedCount += 1;
  }

  return {
    session,
    log,
    seed: file.seed,
    difficulty: file.difficulty,
    autoExecuteRoutine: file.autoExecuteRoutine,
    rejectedQuarters,
    complete,
    replayedFrom,
    replayedCount,
  };
}

/** Replay in one synchronous pass. Prefer `replayAsync` on the main thread. */
export function replay(file: SaveFile): LoadedGame {
  const steps = replaySteps(file);
  let step = steps.next();
  while (!step.done) step = steps.next();
  return step.value;
}

/**
 * Replay a quarter at a time, yielding to the browser between each.
 *
 * A quarter is milliseconds of arithmetic and a full state hash per ledger row;
 * eight of them back to back is long enough to freeze a tab. Yielding is what
 * lets the progress indicator actually render.
 */
export async function replayAsync(file: SaveFile, options: ReplayOptions = {}): Promise<LoadedGame> {
  const steps = replaySteps(file);
  let step = steps.next();
  while (!step.done) {
    options.onProgress?.(step.value);
    if (options.yieldControl !== undefined) await options.yieldControl();
    step = steps.next();
  }
  return step.value;
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

/** Read and replay without holding the main thread. */
export async function loadSavedGameAsync(options: ReplayOptions = {}): Promise<LoadedGame | null> {
  const file = readSaveFile();
  if (file === null) return null;
  try {
    return await replayAsync(file, options);
  } catch {
    return null;
  }
}
