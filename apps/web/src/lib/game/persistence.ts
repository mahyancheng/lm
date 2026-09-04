/**
 * Replay-based persistence, with checkpoints.
 *
 * A saved game is not a serialised world. It is the seed and the *inputs to F*:
 *
 * ```json
 * { "version": 5, "seed": 424242, "difficulty": "standard",
 *   "setup": { "companyName": "Acme AI", "founderName": "Dana Vale", "backgroundId": "consumer_ai",
 *              "sector": "ai", "region": "north_america", "worldVersion": 2 },
 *   "worldVersion": 2,
 *   "log": [{ "quarter": 0, "actions": [...], "gmProposal": null, "npcBundles": [], "socialTexts": [] }],
 *   "checkpoint": { "quarter": 8, "state": { ... } },
 *   "queue": [...], "savedAtIso": "2027-01-01T00:00:00.000Z" }
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
 * `socialTexts` is the one entry that is not an input to `F`: words a model
 * wrote over engine-authored posts after the quarter had already committed. The
 * numbers of that quarter were fixed without them, so they are applied on replay
 * exactly where they were applied live — after the commit, through the engine's
 * own bounded `applySocialTextOverrides`. A file without them (every file
 * written before the feed existed, and every quarter played offline) replays as
 * the engine's template lines, which is what was played.
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
 *
 * ## Where the format lives
 *
 * Parsing, summarising and serialising a save file are in `./saveFile` — pure,
 * engine-free, and therefore importable by a server route that has to validate a
 * save a browser uploaded. This module is what remains once the storage medium
 * is taken into account: `localStorage`'s keys, its quota, and the replay that
 * needs the engine. The format is unchanged and still v5.
 */

import type { NewGameSetup, SessionDifficulty, SessionState, SubmittedAction, WorldVersion } from '@frontier/contracts';
import { applySocialTextOverrides } from '@frontier/simulation';
import { getEngine, createSession, DEMO_SEED } from './engine';
import {
  ABSENT_SAVE_SUMMARY,
  SAVE_SLOT_COUNT,
  SUPPORTED_SAVE_VERSIONS,
  type QuarterRecord,
  type SaveFile,
  type SaveFileSummary,
  type SaveInspection,
  type SaveStatus,
  inspectSaveText,
  saveFileBody,
  serializeSaveFile,
  summariseSaveText,
  versionOfRaw,
} from './saveFile';

export {
  CHECKPOINT_INTERVAL,
  SAVE_SLOT_COUNT,
  SAVE_VERSION,
  SUPPORTED_SAVE_VERSIONS,
  buildSaveFile,
  serializeSaveFile,
} from './saveFile';
export type { QuarterRecord, SaveCheckpoint, SaveFile, SaveInspection, SaveStatus } from './saveFile';

export const SAVE_KEY = 'frontier-demo-v1';

/** The `localStorage` keys the slots live under, in slot order. */
export const SLOT_KEYS: readonly string[] = Array.from(
  { length: SAVE_SLOT_COUNT },
  (_, index) => `frontier-demo-slot-${index + 1}`,
);

/** Replay depth ceiling for a save with no usable checkpoint. Ten years of quarters. */
export const MAX_REPLAY_QUARTERS = 40;

/** How the browser reads a file: the engine's seed is the one a seedless file gets. */
const PARSE_OPTIONS = { defaultSeed: DEMO_SEED } as const;

export interface LoadedGame {
  readonly session: SessionState;
  /** The **full** recorded log, exactly as stored — not the replayed prefix. */
  readonly log: QuarterRecord[];
  readonly seed: number;
  readonly difficulty: SessionDifficulty;
  readonly autoExecuteRoutine: boolean;
  /** The new-game setup the save was made with, or null for the default world. */
  readonly setup: NewGameSetup | null;
  /** Which world the replayed session was built from. */
  readonly worldVersion: WorldVersion;
  /** Quarters that were replayed but did not commit, if any. */
  readonly rejectedQuarters: number[];
  /** True when every recorded quarter replayed and committed. */
  readonly complete: boolean;
  /** The quarter the replay resumed from: a checkpoint, or 0 from the seed. */
  readonly replayedFrom: number;
  readonly replayedCount: number;
  /**
   * The stored unresolved queue, verbatim. The caller re-validates each entry
   * against the replayed session before queuing it; nothing here is trusted.
   */
  readonly queue: readonly SubmittedAction[];
}

function storage(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Raw text under one key: `null` for absent, `undefined` when the store threw. */
function rawAt(key: string): string | null | undefined {
  const store = storage();
  if (store === null) return undefined;
  try {
    return store.getItem(key);
  } catch {
    return undefined;
  }
}

/* -------------------------------------------------------------------------- */
/*  Read                                                                       */
/* -------------------------------------------------------------------------- */

/** Inspect whatever sits under one storage key. Shared by the autosave and the slots. */
function inspectKey(key: string): SaveInspection {
  const store = storage();
  if (store === null) return { status: 'absent', version: null, file: null, reason: null };
  let raw: string | null;
  try {
    raw = store.getItem(key);
  } catch {
    return { status: 'unreadable', version: null, file: null, reason: null };
  }
  if (raw === null) return { status: 'absent', version: null, file: null, reason: null };
  return inspectSaveText(raw, PARSE_OPTIONS);
}

/**
 * Read the stored autosave and say what it is.
 *
 * A version this build does not know is reported as `unsupported` rather than
 * as absent, so nothing downstream mistakes it for an empty slot and writes
 * over it.
 */
export function inspectSave(): SaveInspection {
  return inspectKey(SAVE_KEY);
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
  return typeof rawAt(SAVE_KEY) === 'string';
}

/** The stored autosave's version, or null when absent or unreadable. */
export function storedSaveVersion(): number | null {
  const raw = rawAt(SAVE_KEY);
  return typeof raw === 'string' ? versionOfRaw(raw) : null;
}

/* -------------------------------------------------------------------------- */
/*  Write                                                                      */
/* -------------------------------------------------------------------------- */

// The body last written under each key. A debounced write that would store
// the same bytes under a fresher advisory stamp is a no-op.
const lastWrittenBody = new Map<string, string>();

/** Write a file under one key with the shared refusal and quota-prune rules. */
function writeFileAt(key: string, file: SaveFile): boolean {
  const store = storage();
  if (store === null) return false;
  const existing = rawAt(key);
  const raw = existing === undefined ? null : existing;
  if (raw !== null) {
    const stored = versionOfRaw(raw);
    if (stored !== null && !SUPPORTED_SAVE_VERSIONS.includes(stored)) return false;
  }

  const body = saveFileBody(file);
  // Same body, verifiably still stored: only the advisory timestamp would
  // change, and it is never trusted for any decision, so the write is skipped.
  if (raw !== null && lastWrittenBody.get(key) === body) return true;
  try {
    store.setItem(key, `${body},"savedAtIso":${JSON.stringify(file.savedAtIso)}}`);
    lastWrittenBody.set(key, body);
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
    store.setItem(key, serializeSaveFile(pruned));
    lastWrittenBody.set(key, saveFileBody(pruned));
    return true;
  } catch {
    lastWrittenBody.delete(key);
    return false;
  }
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
  return writeFileAt(SAVE_KEY, file);
}

/** Remove the save. */
export function clearSaveFile(): void {
  // Forgotten before the removal, not after: a delete followed by a write of
  // the same state must actually write, never be skipped as already stored.
  lastWrittenBody.delete(SAVE_KEY);
  const store = storage();
  if (store === null) return;
  try {
    store.removeItem(SAVE_KEY);
  } catch {
    /* nothing to do */
  }
}

/* -------------------------------------------------------------------------- */
/*  Slots                                                                      */
/* -------------------------------------------------------------------------- */

/** The key for a 1-based slot, or null out of range: every slot call no-ops then. */
function slotKey(slot: number): string | null {
  if (!Number.isInteger(slot) || slot < 1 || slot > SAVE_SLOT_COUNT) return null;
  return SLOT_KEYS[slot - 1] ?? null;
}

/** Inspect one slot, with the same unsupported-version preservation as the autosave. */
export function readSlotFile(slot: number): SaveInspection {
  const key = slotKey(slot);
  if (key === null) return { status: 'absent', version: null, file: null, reason: null };
  return inspectKey(key);
}

/** Write one slot, with the same refusal and quota-prune rules as the autosave. */
export function writeSlotFile(slot: number, file: SaveFile): boolean {
  const key = slotKey(slot);
  if (key === null) return false;
  return writeFileAt(key, file);
}

/** Empty one slot. True only when the slot is verifiably gone afterwards. */
export function clearSlot(slot: number): boolean {
  const key = slotKey(slot);
  const store = storage();
  if (key === null || store === null) return false;
  lastWrittenBody.delete(key);
  try {
    store.removeItem(key);
    // Verified, not assumed: a browser that swallows the remove would otherwise
    // let a "deleted" toast stand over a slot row that is still there.
    return store.getItem(key) === null;
  } catch {
    return false;
  }
}

/** What a slot picker shows for one slot. Every field but `slot` may be null. */
export interface SlotSummary extends SaveFileSummary {
  readonly slot: number;
}

/**
 * Describe every slot without paying for a full inspection — see
 * `summariseSaveText`. An `ok` here promises the file parses as JSON with a
 * known version, not that it replays.
 */
export function slotSummaries(): SlotSummary[] {
  const summaries: SlotSummary[] = [];
  for (let slot = 1; slot <= SAVE_SLOT_COUNT; slot += 1) {
    summaries.push(summariseKey(slot, slotKey(slot)));
  }
  return summaries;
}

function summariseKey(slot: number, key: string | null): SlotSummary {
  const store = storage();
  if (key === null || store === null) return { slot, ...ABSENT_SAVE_SUMMARY };
  let raw: string | null;
  try {
    raw = store.getItem(key);
  } catch {
    return { slot, ...ABSENT_SAVE_SUMMARY, status: 'unreadable' };
  }
  return { slot, ...summariseSaveText(raw) };
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
  const file = inspectSaveText(text, PARSE_OPTIONS).file;
  if (file === null) return null;

  const store = storage();
  if (store === null) return file;
  // Through the guarded writer, never a raw setItem: an import is the easiest
  // way to hand this build a file while a newer build's save sits under the
  // key, and that save is preserved here exactly as it is everywhere else.
  return writeFileAt(SAVE_KEY, file) ? file : null;
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
      ? createSession({ seed: file.seed, difficulty: file.difficulty, autoExecuteRoutine: file.autoExecuteRoutine, setup: file.setup ?? undefined })
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
    // The words a model wrote over that quarter's engine-authored posts, applied
    // exactly where they were applied live: after the commit, touching nothing
    // but the text of posts the engine itself authored.
    session = applySocialTextOverrides(outcome.nextState, record.socialTexts, record.quarter);
    replayedCount += 1;
  }

  return {
    session,
    log,
    seed: file.seed,
    difficulty: file.difficulty,
    autoExecuteRoutine: file.autoExecuteRoutine,
    setup: file.setup,
    worldVersion: file.worldVersion,
    rejectedQuarters,
    complete,
    replayedFrom,
    replayedCount,
    queue: file.queue,
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
