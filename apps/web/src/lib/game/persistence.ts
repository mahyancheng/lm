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
 */

import type {
  GmProposalBatch,
  NewGameSetup,
  NpcActionBundle,
  SessionDifficulty,
  SessionState,
  SocialTextOverride,
  SubmittedAction,
  WorldVersion,
} from '@frontier/contracts';
import {
  GmProposalBatchSchema,
  LEGACY_WORLD_VERSION,
  NewGameSetupSchema,
  NpcActionBundleSchema,
  SESSION_DIFFICULTIES,
  SessionStateSchema,
  SocialTextOverrideSchema,
  SubmittedActionSchema,
  WORLD_VERSIONS,
} from '@frontier/contracts';
import { applySocialTextOverrides } from '@frontier/simulation';
import { getEngine, createSession, DEMO_SEED } from './engine';

export const SAVE_KEY = 'frontier-demo-v1';
export const SAVE_VERSION = 5;

/**
 * Versions this build can read. A save written by any of these loads; anything
 * else is preserved untouched, never overwritten. v1 recorded only the player's
 * actions; v2 added agent proposals and checkpoints; v3 added the new-game
 * setup; v4 added the unresolved action queue and an advisory timestamp; v5
 * records which world the session was built from. A v5 file may also carry
 * `socialTexts` per quarter; a v5 file without them is not older, it is a
 * session that was played with no model attached.
 */
export const SUPPORTED_SAVE_VERSIONS: readonly number[] = [1, 2, 3, 4, 5];

/**
 * Which world a stored file was built from, read off the file itself.
 *
 * The **setup** is the authority: it is the actual input to `F`, the scenario
 * dispatcher reads `setup.worldVersion` and nothing else, and a save with no
 * setup can only ever have been the frozen world-1 demo. The stored number is a
 * convenience for readers — a slot row, the Continue panel — that should not
 * have to reach inside the setup, and it is believed only when there is no
 * setup to contradict it.
 */
function worldVersionOf(setup: NewGameSetup | null, stored: unknown): WorldVersion {
  if (setup !== null) return setup.worldVersion;
  return WORLD_VERSIONS.find((version) => version === stored) ?? LEGACY_WORLD_VERSION;
}

/** Manual save slots, beside the autosave. */
export const SAVE_SLOT_COUNT = 3;

/** The `localStorage` keys the slots live under, in slot order. */
export const SLOT_KEYS: readonly string[] = Array.from(
  { length: SAVE_SLOT_COUNT },
  (_, index) => `frontier-demo-slot-${index + 1}`,
);

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
  /**
   * Words a model wrote over engine-authored posts *after* the quarter
   * committed, capped at `MAX_SOCIAL_TEXT_OVERRIDES`.
   *
   * Unlike the two above, these are not inputs to `F`: the quarter resolved
   * without them and every number in it was already fixed. They are recorded
   * because they are still a state change, and a replay that skipped them would
   * produce the right numbers under the wrong sentences. Absent in a file
   * written before the feed existed, which replays as the template lines it was
   * played with.
   */
  readonly socialTexts: readonly SocialTextOverride[];
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
  /** The new-game setup (company name, founder name, background), or null for the default world. */
  readonly setup: NewGameSetup | null;
  /**
   * Which world scenario this session was built from. Derived from the setup on
   * every write — the setup is what the dispatcher actually reads — and stored
   * so a reader can label a save without parsing one.
   */
  readonly worldVersion: WorldVersion;
  /** One entry per resolved quarter, in order, holding every input to it. */
  readonly log: readonly QuarterRecord[];
  readonly checkpoint: SaveCheckpoint | null;
  /** Advisory only; never trusted on load. */
  readonly savedQuarter: number;
  /**
   * Actions queued but not yet resolved, so a tab discarded mid-turn loses
   * nothing. Re-validated against the replayed session on load, never trusted.
   */
  readonly queue: readonly SubmittedAction[];
  /**
   * When the file was written, for display only. Advisory metadata: never
   * trusted for any logic, ordering or replay decision. Null in a v1–v3 file.
   */
  readonly savedAtIso: string | null;
}

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
    const socialTexts: SocialTextOverride[] = [];
    if (Array.isArray(value.socialTexts)) {
      for (const override of value.socialTexts) {
        const parsed = SocialTextOverrideSchema.safeParse(override);
        if (parsed.success) socialTexts.push(parsed.data);
      }
    }
    records.push({ quarter, actions, gmProposal: gm.success ? gm.data : null, npcBundles, socialTexts });
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
    return { quarter: index, actions: list, gmProposal: null, npcBundles: [], socialTexts: [] };
  });
}

/** Read a stored new-game setup, or null when absent (a v1/v2 file) or malformed. */
function parseSetup(raw: unknown): NewGameSetup | null {
  if (raw === null || raw === undefined) return null;
  const parsed = NewGameSetupSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** Read a stored unresolved queue, dropping entries that will not parse. */
function parseQueue(raw: unknown): SubmittedAction[] {
  if (!Array.isArray(raw)) return [];
  const queue: SubmittedAction[] = [];
  for (const entry of raw) {
    const parsed = SubmittedActionSchema.safeParse(entry);
    if (parsed.success) queue.push(parsed.data);
  }
  return queue;
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

/** Inspect whatever sits under one storage key. Shared by the autosave and the slots. */
function inspectKey(key: string): SaveInspection {
  const store = storage();
  if (store === null) return { status: 'absent', version: null, file: null };
  let raw: string | null;
  try {
    raw = store.getItem(key);
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
  if (version === null || !SUPPORTED_SAVE_VERSIONS.includes(version)) return { status: 'unsupported', version, file: null };

  const seed = typeof parsed.seed === 'number' && Number.isFinite(parsed.seed) ? parsed.seed : DEMO_SEED;
  const difficulty = SESSION_DIFFICULTIES.includes(parsed.difficulty as SessionDifficulty)
    ? (parsed.difficulty as SessionDifficulty)
    : 'standard';
  const log = version === 1 ? migrateV1(parsed.actionLog) : parseRecords(parsed.log);
  const checkpoint = version === 1 ? null : parseCheckpoint(parsed.checkpoint ?? null);
  // The setup arrives with v3. A v1/v2 file has none, so it replays as the
  // default Player Ventures world.
  const setup = parseSetup(parsed.setup);
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
      setup,
      // v5 records it; a v1–v4 file states it through its setup, or is world 1.
      worldVersion: worldVersionOf(setup, parsed.worldVersion),
      log,
      checkpoint,
      savedQuarter,
      // The queue and the timestamp arrive with v4. A v1–v3 file has neither.
      queue: parseQueue(parsed.queue),
      savedAtIso: typeof parsed.savedAtIso === 'string' ? parsed.savedAtIso : null,
    },
  };
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
  const store = storage();
  if (store === null) return false;
  try {
    return store.getItem(SAVE_KEY) !== null;
  } catch {
    return false;
  }
}

/** The version stored under one key, or null when absent or unreadable. */
function storedVersionAt(key: string): number | null {
  const store = storage();
  if (store === null) return null;
  try {
    const raw = store.getItem(key);
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== 'object') return null;
    const version = (parsed as Record<string, unknown>).version;
    return typeof version === 'number' ? version : null;
  } catch {
    return null;
  }
}

/** The stored autosave's version, or null when absent or unreadable. */
export function storedSaveVersion(): number | null {
  return storedVersionAt(SAVE_KEY);
}

/* -------------------------------------------------------------------------- */
/*  Write                                                                      */
/* -------------------------------------------------------------------------- */

// Serialised chunks keyed by object identity. A carried checkpoint and an
// already-resolved log record never change, and the checkpoint alone is most
// of the file, so each is stringified once per object — not once per write.
const checkpointJsonCache = new WeakMap<SaveCheckpoint, string>();
const recordJsonCache = new WeakMap<QuarterRecord, string>();

function cachedJson<T extends object>(cache: WeakMap<T, string>, value: T): string {
  const hit = cache.get(value);
  if (hit !== undefined) return hit;
  const json = JSON.stringify(value);
  cache.set(value, json);
  return json;
}

/**
 * Everything but the advisory timestamp, serialised. Two files with the same
 * body describe the same saved game, so a write whose body matches the last
 * one under a key is skipped rather than re-stamped.
 */
function saveFileBody(file: SaveFile): string {
  const log = `[${file.log.map((record) => cachedJson(recordJsonCache, record)).join(',')}]`;
  const checkpoint = file.checkpoint === null ? 'null' : cachedJson(checkpointJsonCache, file.checkpoint);
  return (
    `{"version":${JSON.stringify(file.version)}` +
    `,"seed":${JSON.stringify(file.seed)}` +
    `,"difficulty":${JSON.stringify(file.difficulty)}` +
    `,"autoExecuteRoutine":${JSON.stringify(file.autoExecuteRoutine)}` +
    `,"setup":${JSON.stringify(file.setup)}` +
    `,"worldVersion":${JSON.stringify(file.worldVersion)}` +
    `,"log":${log}` +
    `,"checkpoint":${checkpoint}` +
    `,"savedQuarter":${JSON.stringify(file.savedQuarter)}` +
    `,"queue":${JSON.stringify(file.queue)}`
  );
}

/**
 * The file exactly as `JSON.stringify(file)` writes it — same fields, same
 * order, same bytes — assembled from the cached chunks. The format is v4
 * either way; only the cost of producing it changes.
 */
export function serializeSaveFile(file: SaveFile): string {
  return `${saveFileBody(file)},"savedAtIso":${JSON.stringify(file.savedAtIso)}}`;
}

// The body last written under each key. A debounced write that would store
// the same bytes under a fresher advisory stamp is a no-op.
const lastWrittenBody = new Map<string, string>();

/**
 * The version inside a stored raw file, without parsing the whole thing on
 * every write: every file this build writes opens with `{"version":N,`, so the
 * prefix answers directly. Anything shaped differently pays the full parse.
 */
function versionOfRaw(raw: string): number | null {
  const quick = /^\{"version":(-?\d+)[,}]/.exec(raw);
  if (quick !== null) return Number(quick[1]);
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== 'object') return null;
    const version = (parsed as Record<string, unknown>).version;
    return typeof version === 'number' ? version : null;
  } catch {
    return null;
  }
}

/** Assemble the file for a session, carrying or refreshing its checkpoint. */
export function buildSaveFile(input: {
  readonly seed: number;
  readonly difficulty: SessionDifficulty;
  readonly autoExecuteRoutine: boolean;
  /** The new-game setup, or null for the default world. */
  readonly setup: NewGameSetup | null;
  readonly log: readonly QuarterRecord[];
  /** The actions queued but not yet resolved, so a discarded tab keeps its turn. */
  readonly queue: readonly SubmittedAction[];
  /** The session as it now stands, i.e. with `quarter` open and unresolved. */
  readonly session: SessionState;
  readonly previous?: SaveFile | null;
  /** The clock, injectable so a test can stamp a fixed `savedAtIso`. */
  readonly now?: () => string;
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
    setup: input.setup,
    // Derived, never passed in: the setup is what `createSession` dispatches on,
    // so a `worldVersion` that could disagree with it would be a second answer
    // to a question that already has one.
    worldVersion: worldVersionOf(input.setup, null),
    log: input.log,
    checkpoint,
    savedQuarter: input.session.quarter,
    queue: input.queue,
    savedAtIso: (input.now ?? (() => new Date().toISOString()))(),
  };
}

/** Write a file under one key with the shared refusal and quota-prune rules. */
function writeFileAt(key: string, file: SaveFile): boolean {
  const store = storage();
  if (store === null) return false;
  let raw: string | null;
  try {
    raw = store.getItem(key);
  } catch {
    raw = null;
  }
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
  if (key === null) return { status: 'absent', version: null, file: null };
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
export interface SlotSummary {
  readonly slot: number;
  readonly status: SaveStatus;
  readonly version: number | null;
  readonly savedQuarter: number | null;
  readonly seed: number | null;
  readonly difficulty: SessionDifficulty | null;
  readonly companyName: string | null;
  readonly founderName: string | null;
  /** Which world this slot holds. Null only when the slot is empty or unreadable. */
  readonly worldVersion: WorldVersion | null;
  readonly savedAtIso: string | null;
}

/**
 * Describe every slot without paying for a full inspection: a checkpoint is a
 * whole `SessionState` and validating three of them through
 * `SessionStateSchema` just to label a menu is work a picker never needs. The
 * summary reads only the scalar fields and the stored setup, so an `ok` here
 * promises the file parses as JSON with a known version — not that it replays.
 */
export function slotSummaries(): SlotSummary[] {
  const summaries: SlotSummary[] = [];
  for (let slot = 1; slot <= SAVE_SLOT_COUNT; slot += 1) {
    summaries.push(summariseKey(slot, slotKey(slot)));
  }
  return summaries;
}

function summariseKey(slot: number, key: string | null): SlotSummary {
  const empty: SlotSummary = {
    slot,
    status: 'absent',
    version: null,
    savedQuarter: null,
    seed: null,
    difficulty: null,
    companyName: null,
    founderName: null,
    worldVersion: null,
    savedAtIso: null,
  };
  const store = storage();
  if (key === null || store === null) return empty;
  let raw: string | null;
  try {
    raw = store.getItem(key);
  } catch {
    return { ...empty, status: 'unreadable' };
  }
  if (raw === null) return empty;

  let parsed: Record<string, unknown>;
  try {
    const value = JSON.parse(raw) as unknown;
    if (value === null || typeof value !== 'object') return { ...empty, status: 'unreadable' };
    parsed = value as Record<string, unknown>;
  } catch {
    return { ...empty, status: 'unreadable' };
  }

  const version = typeof parsed.version === 'number' ? parsed.version : null;
  if (version === null || !SUPPORTED_SAVE_VERSIONS.includes(version)) {
    return { ...empty, status: 'unsupported', version };
  }
  const setup = parseSetup(parsed.setup);
  return {
    slot,
    status: 'ok',
    version,
    savedQuarter:
      typeof parsed.savedQuarter === 'number' && Number.isInteger(parsed.savedQuarter) ? parsed.savedQuarter : null,
    seed: typeof parsed.seed === 'number' && Number.isFinite(parsed.seed) ? parsed.seed : null,
    difficulty: SESSION_DIFFICULTIES.includes(parsed.difficulty as SessionDifficulty)
      ? (parsed.difficulty as SessionDifficulty)
      : null,
    companyName: setup?.companyName ?? null,
    founderName: setup?.founderName ?? null,
    worldVersion: worldVersionOf(setup, parsed.worldVersion),
    savedAtIso: typeof parsed.savedAtIso === 'string' ? parsed.savedAtIso : null,
  };
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
  if (version === null || !SUPPORTED_SAVE_VERSIONS.includes(version)) return null;

  const log = version === 1 ? migrateV1(value.actionLog) : parseRecords(value.log);
  const setup = parseSetup(value.setup);
  const file: SaveFile = {
    version: SAVE_VERSION,
    seed: typeof value.seed === 'number' && Number.isFinite(value.seed) ? value.seed : DEMO_SEED,
    difficulty: SESSION_DIFFICULTIES.includes(value.difficulty as SessionDifficulty)
      ? (value.difficulty as SessionDifficulty)
      : 'standard',
    autoExecuteRoutine: value.autoExecuteRoutine === true,
    setup,
    worldVersion: worldVersionOf(setup, value.worldVersion),
    log,
    checkpoint: version === 1 ? null : parseCheckpoint(value.checkpoint ?? null),
    savedQuarter:
      typeof value.savedQuarter === 'number' && Number.isInteger(value.savedQuarter)
        ? value.savedQuarter
        : (log[log.length - 1]?.quarter ?? -1) + 1,
    queue: parseQueue(value.queue),
    savedAtIso: typeof value.savedAtIso === 'string' ? value.savedAtIso : null,
  };

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
