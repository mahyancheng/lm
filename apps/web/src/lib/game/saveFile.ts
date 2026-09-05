/**
 * The save file, parsed — and nothing else.
 *
 * `persistence.ts` does three jobs: it *reads* a stored file, it *writes* one,
 * and it *replays* one through the engine. Only the third needs the engine.
 * This module holds the first two, so that a server route can validate a save a
 * browser uploaded with the same code the browser validated it with, without
 * pulling `@frontier/simulation` into a request handler.
 *
 * Everything here is pure and environment-free: no `localStorage`, no `fs`, no
 * clock (`buildSaveFile` takes one). The only imports are zod schemas and types
 * from `@frontier/contracts`, which is the contract layer both sides already
 * share.
 *
 * The format is unchanged and stays v5. Splitting where the storage medium
 * begins is a refactor, not a version bump: `persistence.ts` re-exports every
 * name it used to export and writes byte-identical files.
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
  RETIRED_WORLD_SAVE_MESSAGE,
  NewGameSetupSchema,
  NpcActionBundleSchema,
  SESSION_DIFFICULTIES,
  SessionStateSchema,
  SocialTextOverrideSchema,
  SubmittedActionSchema,
  WORLD_VERSIONS,
  worldVersionIsSupported,
} from '@frontier/contracts';

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

/** Manual save slots, beside the autosave. */
export const SAVE_SLOT_COUNT = 3;

/** Quarters between state snapshots. A load never replays more than this many. */
export const CHECKPOINT_INTERVAL = 8;

/**
 * The seed a file that has lost its own is read as. Equal to the engine's
 * `DEMO_SEED`, but stated here as a number so this module owes the engine
 * nothing; every caller inside the app passes `DEMO_SEED` explicitly.
 */
export const FALLBACK_SEED = 424242;

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

/** The shape written to `localStorage`, and the shape a server stores verbatim. */
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
   * The quarter this seat was wound up, or null while it is still playing.
   *
   * Advisory display metadata, exactly like `savedAtIso`: the authority is the
   * replayed session's `SessionPlayer.eliminatedQuarter`, and this exists so a
   * save picker can mark a run ended without replaying forty quarters to find
   * out. A file written before this field existed reads as null, which is what
   * a save that never ended actually is.
   */
  readonly endedQuarter: number | null;
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

/** Why a stored file could not be read. `unsupported` is preserved, never overwritten. */
export type SaveStatus = 'absent' | 'ok' | 'unreadable' | 'unsupported';

export interface SaveInspection {
  readonly status: SaveStatus;
  readonly version: number | null;
  readonly file: SaveFile | null;
  /**
   * Why the file was refused, in words a player can read, or null when there is
   * nothing to explain. Required-and-nullable rather than optional so every
   * construction site has to decide what it says.
   */
  readonly reason: string | null;
}

/* -------------------------------------------------------------------------- */
/*  Parsing                                                                    */
/* -------------------------------------------------------------------------- */

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
export function worldVersionOf(setup: NewGameSetup | null, stored: unknown): WorldVersion {
  if (setup !== null) return setup.worldVersion;
  return WORLD_VERSIONS.find((version) => version === stored) ?? LEGACY_WORLD_VERSION;
}

export function parseRecords(raw: unknown): QuarterRecord[] {
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
export function migrateV1(raw: unknown): QuarterRecord[] {
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
export function parseSetup(raw: unknown): NewGameSetup | null {
  if (raw === null || raw === undefined) return null;
  const parsed = NewGameSetupSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** Read a stored unresolved queue, dropping entries that will not parse. */
export function parseQueue(raw: unknown): SubmittedAction[] {
  if (!Array.isArray(raw)) return [];
  const queue: SubmittedAction[] = [];
  for (const entry of raw) {
    const parsed = SubmittedActionSchema.safeParse(entry);
    if (parsed.success) queue.push(parsed.data);
  }
  return queue;
}

export function parseCheckpoint(raw: unknown): SaveCheckpoint | null {
  if (raw === null || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.quarter !== 'number' || !Number.isInteger(value.quarter) || value.quarter < 0) return null;
  const parsed = SessionStateSchema.safeParse(value.state);
  if (!parsed.success) return null;
  if (parsed.data.quarter !== value.quarter) return null;
  return { quarter: value.quarter, state: parsed.data };
}

/** What a parse may be told about the world it is happening in. */
export interface SaveParseOptions {
  /** The seed a file with none of its own is read as. Defaults to `FALLBACK_SEED`. */
  readonly defaultSeed?: number;
}

/**
 * Inspect an already-JSON-parsed value and say what it is.
 *
 * A version this build does not know is reported as `unsupported` rather than
 * as absent, so nothing downstream mistakes it for an empty slot and writes
 * over it — in a browser, and equally in a route handler that is about to
 * overwrite a file on the Pi.
 */
export function inspectSaveValue(value: unknown, options: SaveParseOptions = {}): SaveInspection {
  // Exactly the original guard: an array is an object here, so it falls through
  // to the version check and is refused as `unsupported`, never as absent.
  if (value === null || typeof value !== 'object') {
    return { status: 'unreadable', version: null, file: null, reason: null };
  }
  const parsed = value as Record<string, unknown>;

  const version = typeof parsed.version === 'number' ? parsed.version : null;
  if (version === null || !SUPPORTED_SAVE_VERSIONS.includes(version)) return { status: 'unsupported', version, file: null, reason: null };

  const defaultSeed = options.defaultSeed ?? FALLBACK_SEED;
  const seed = typeof parsed.seed === 'number' && Number.isFinite(parsed.seed) ? parsed.seed : defaultSeed;
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

  // A save from a world this build retired is refused, not migrated — and
  // refused as `unsupported`, which is the status that is preserved and never
  // written over. The file stays exactly where it is; a build that can read it
  // still can.
  const worldVersion = worldVersionOf(setup, parsed.worldVersion);
  if (!worldVersionIsSupported(worldVersion)) {
    return { status: 'unsupported', version, file: null, reason: RETIRED_WORLD_SAVE_MESSAGE };
  }

  return {
    status: 'ok',
    version,
    reason: null,
    file: {
      version: SAVE_VERSION,
      seed,
      difficulty,
      autoExecuteRoutine: parsed.autoExecuteRoutine === true,
      setup,
      // v5 records it; a v1–v4 file states it through its setup, or is world 1.
      worldVersion,
      log,
      checkpoint,
      savedQuarter,
      endedQuarter:
        typeof parsed.endedQuarter === 'number' && Number.isInteger(parsed.endedQuarter) && parsed.endedQuarter >= 0
          ? parsed.endedQuarter
          : null,
      // The queue and the timestamp arrive with v4. A v1–v3 file has neither.
      queue: parseQueue(parsed.queue),
      savedAtIso: typeof parsed.savedAtIso === 'string' ? parsed.savedAtIso : null,
    },
  };
}

/** Inspect stored text. Text that is not JSON is `unreadable`, never `absent`. */
export function inspectSaveText(raw: string, options: SaveParseOptions = {}): SaveInspection {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return { status: 'unreadable', version: null, file: null, reason: null };
  }
  return inspectSaveValue(value, options);
}

/* -------------------------------------------------------------------------- */
/*  Summaries                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The scalar facts a picker shows, read without a full inspection.
 *
 * A checkpoint is a whole `SessionState`, and validating one through
 * `SessionStateSchema` just to label a menu row is work no picker needs. An
 * `ok` here therefore promises the file parses as JSON with a known version —
 * not that it replays.
 */
export interface SaveFileSummary {
  readonly status: SaveStatus;
  readonly version: number | null;
  readonly savedQuarter: number | null;
  readonly seed: number | null;
  readonly difficulty: SessionDifficulty | null;
  readonly companyName: string | null;
  readonly founderName: string | null;
  /** Which world this file holds. Null only when it is absent or unreadable. */
  readonly worldVersion: WorldVersion | null;
  readonly savedAtIso: string | null;
  /** Quarter the run ended in, or null while the seat is still playing. */
  readonly endedQuarter: number | null;
  /** Why this file cannot be opened, in words, or null when it can. */
  readonly reason: string | null;
}

/** Nothing stored. Every field but `status` is null. */
export const ABSENT_SAVE_SUMMARY: SaveFileSummary = {
  status: 'absent',
  version: null,
  savedQuarter: null,
  seed: null,
  difficulty: null,
  companyName: null,
  founderName: null,
  worldVersion: null,
  savedAtIso: null,
  endedQuarter: null,
  reason: null,
};

export function summariseSaveValue(value: unknown): SaveFileSummary {
  if (value === null || typeof value !== 'object') {
    return { ...ABSENT_SAVE_SUMMARY, status: 'unreadable' };
  }
  const parsed = value as Record<string, unknown>;
  const version = typeof parsed.version === 'number' ? parsed.version : null;
  if (version === null || !SUPPORTED_SAVE_VERSIONS.includes(version)) {
    return { ...ABSENT_SAVE_SUMMARY, status: 'unsupported', version };
  }
  const setup = parseSetup(parsed.setup);
  const worldVersion = worldVersionOf(setup, parsed.worldVersion);
  if (!worldVersionIsSupported(worldVersion)) {
    // Named, not blank: a picker row for a retired world still says whose
    // company it was and when it was saved, and says why it cannot be opened.
    return {
      ...ABSENT_SAVE_SUMMARY,
      status: 'unsupported',
      version,
      worldVersion,
      companyName: setup?.companyName ?? null,
      founderName: setup?.founderName ?? null,
      savedQuarter: typeof parsed.savedQuarter === 'number' && Number.isInteger(parsed.savedQuarter) ? parsed.savedQuarter : null,
      savedAtIso: typeof parsed.savedAtIso === 'string' ? parsed.savedAtIso : null,
      reason: RETIRED_WORLD_SAVE_MESSAGE,
    };
  }
  return {
    status: 'ok',
    version,
    reason: null,
    savedQuarter:
      typeof parsed.savedQuarter === 'number' && Number.isInteger(parsed.savedQuarter) ? parsed.savedQuarter : null,
    seed: typeof parsed.seed === 'number' && Number.isFinite(parsed.seed) ? parsed.seed : null,
    difficulty: SESSION_DIFFICULTIES.includes(parsed.difficulty as SessionDifficulty)
      ? (parsed.difficulty as SessionDifficulty)
      : null,
    companyName: setup?.companyName ?? null,
    founderName: setup?.founderName ?? null,
    worldVersion,
    savedAtIso: typeof parsed.savedAtIso === 'string' ? parsed.savedAtIso : null,
    endedQuarter:
      typeof parsed.endedQuarter === 'number' && Number.isInteger(parsed.endedQuarter) && parsed.endedQuarter >= 0
        ? parsed.endedQuarter
        : null,
  };
}

/** Summarise stored text. `null` text is `absent`; unparseable text is `unreadable`. */
export function summariseSaveText(raw: string | null): SaveFileSummary {
  if (raw === null) return ABSENT_SAVE_SUMMARY;
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return { ...ABSENT_SAVE_SUMMARY, status: 'unreadable' };
  }
  return summariseSaveValue(value);
}

/* -------------------------------------------------------------------------- */
/*  Writing                                                                    */
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
export function saveFileBody(file: SaveFile): string {
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
    `,"endedQuarter":${JSON.stringify(file.endedQuarter)}` +
    `,"queue":${JSON.stringify(file.queue)}`
  );
}

/**
 * The file exactly as `JSON.stringify(file)` writes it — same fields, same
 * order, same bytes — assembled from the cached chunks. The format is v5
 * either way; only the cost of producing it changes.
 */
export function serializeSaveFile(file: SaveFile): string {
  return `${saveFileBody(file)},"savedAtIso":${JSON.stringify(file.savedAtIso)}}`;
}

/**
 * The version inside a stored raw file, without parsing the whole thing on
 * every write: every file this build writes opens with `{"version":N,`, so the
 * prefix answers directly. Anything shaped differently pays the full parse.
 */
export function versionOfRaw(raw: string): number | null {
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
    // Read off the seat, so a picker can say "ended" without a replay. Demo mode
    // seats one player, so the first eliminated seat is the seat.
    endedQuarter: input.session.players.find((player) => player.eliminatedQuarter != null)?.eliminatedQuarter ?? null,
    queue: input.queue,
    savedAtIso: (input.now ?? (() => new Date().toISOString()))(),
  };
}
