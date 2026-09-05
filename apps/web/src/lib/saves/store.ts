/**
 * Server-side saves: one directory per profile, one file per slot.
 *
 * **Server only.** This module touches the filesystem; nothing under
 * `@/lib/game` may import it.
 *
 * ## Why files and not a database
 *
 * The Pi runs in demo mode: there is no Supabase, no Postgres of ours, and no
 * account system. What the household actually wants is smaller than any of
 * that — "the game I started on my phone should be on the laptop" — and a
 * directory of JSON files answers it exactly, is trivially backed up with
 * `tar`, and is readable by a person with `cat` when something goes wrong.
 *
 * ## What a profile is
 *
 * A name the player types on the start page, normalised to a slug. It is
 * **not** an account: no password, no email, nothing to reset. On a
 * tailnet-only household host a password would be theatre, and a cookie —
 * which is what identifies a browser today — can never make the phone and the
 * laptop the same game, because it is per-browser by construction. A name can.
 *
 * ## What is stored
 *
 * The save file itself is **untouched**: still v5, still the bytes the client
 * built. The server wraps it in an envelope carrying who and where it belongs,
 * a server-assigned `revision`, and the few scalars a slot picker shows, so
 * listing four slots never costs four full parses. The client is not
 * authoritative over the engine, but a save is the player's own record of their
 * own game: the server validates its *shape* with the same pure parser the
 * browser uses (`@/lib/game/saveFile`) and then stores it verbatim.
 *
 * ## What is guaranteed
 *
 * - **Atomic.** Temp file plus `rename`, so a crash mid-write leaves the
 *   previous file rather than a torn one. Directories 0700, files 0600.
 * - **Undoable.** Every overwrite rotates the file it replaced to
 *   `<slot>.prev.json`, so one bad write is always recoverable.
 * - **Never silently older.** See `isNewer`: an unconditional write of a save
 *   older than the stored one is refused, not applied.
 * - **Bounded.** 4 MB per save, 4 slots per profile, 32 profiles per host.
 *
 * Everything takes its root and its clock as parameters, so the tests run
 * against a `mkdtemp` directory and a fixed clock and never touch a real home.
 */

import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { inspectSaveValue, summariseSaveValue } from '@/lib/game/saveFile';
import {
  MAX_PROFILES,
  MAX_SAVE_BYTES,
  SAVE_SLOTS,
  type ProfileListing,
  type ProfileRecord,
  type SaveEnvelope,
  type SaveSlot,
  type SaveSummaryEnvelope,
  type SaveWriteResult,
  emptySlot,
  isNewer,
  isProfileSlug,
  isSaveSlot,
  summaryOf,
} from './shared';

/* -------------------------------------------------------------------------- */
/*  Names, slots, the envelope and the conflict rule                           */
/* -------------------------------------------------------------------------- */

/**
 * All of it lives in `./shared`, which is pure — no `fs`, no clock — so the
 * browser's sync layer can reconcile a 409 with the *same* `isNewer` the server
 * applied rather than a second implementation of the same sentence. Re-exported
 * here because this module is where the rest of the app already imports them
 * from.
 */
export {
  MAX_DISPLAY_NAME,
  MAX_PROFILES,
  MAX_SAVE_BYTES,
  MAX_SLOTS_PER_PROFILE,
  PROFILE_SLUG_PATTERN,
  RESERVED_PROFILE_SLUGS,
  SAVE_SLOTS,
  displayNameOf,
  emptySlot,
  isNewer,
  isProfileSlug,
  isSaveSlot,
  profileSlug,
  slotOccupied,
  summaryOf,
} from './shared';
export type {
  ProfileListing,
  ProfileRecord,
  SaveEnvelope,
  SaveOrder,
  SaveSlot,
  SaveSummaryEnvelope,
  SaveWriteReason,
  SaveWriteResult,
} from './shared';

/** Unset means server saves are OFF and the client behaves exactly as it did before this existed. */
export const SAVE_DIR_ENV = 'SAVE_DIR';

/* -------------------------------------------------------------------------- */
/*  The store                                                                  */
/* -------------------------------------------------------------------------- */

export interface SaveStoreConfig {
  readonly root: string;
  /** The server clock, injectable so a test can stamp a fixed `updatedAtIso`. */
  readonly now?: () => string;
}

export interface WriteOptions {
  /**
   * The revision the client last saw. Present makes the write conditional: a
   * mismatch is a 409 carrying the current summary, and the client reconciles
   * by `isNewer` before re-sending.
   *
   * Absent makes it unconditional — and an unconditional write is the one the
   * conflict rule guards, because nobody has looked at what it would replace.
   */
  readonly ifRevision?: number;
  /** What the player typed, recorded on the profile the first time it is seen. */
  readonly displayName?: string;
}

export interface SaveStore {
  readonly root: string;
  listProfiles(): ProfileListing[];
  readProfile(profile: string): ProfileListing | null;
  slots(profile: string): SaveSummaryEnvelope[];
  read(profile: string, slot: SaveSlot): SaveEnvelope | null;
  readPrevious(profile: string, slot: SaveSlot): SaveEnvelope | null;
  write(profile: string, slot: string, file: unknown, options?: WriteOptions): SaveWriteResult;
  remove(profile: string, slot: SaveSlot): boolean;
}

const PROFILE_FILE = 'profile.json';

/** The directory a save root wants to be created with, and every directory under it. */
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/**
 * The save directory this process serves, or null when server saves are off.
 *
 * Off is the default and is not a degraded mode: with no `SAVE_DIR` the routes
 * answer `enabled: false` and the client keeps every save in `localStorage`,
 * which is exactly how the game worked before this module existed.
 */
export function saveRootFrom(env: Readonly<Record<string, string | undefined>> = process.env): string | null {
  const value = env[SAVE_DIR_ENV];
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

export function createSaveStore(config: SaveStoreConfig): SaveStore {
  const root = config.root;
  const now = config.now ?? ((): string => new Date().toISOString());

  const profileDir = (profile: string): string => join(root, profile);
  const slotPath = (profile: string, slot: SaveSlot): string => join(profileDir(profile), `${slot}.json`);
  const prevPath = (profile: string, slot: SaveSlot): string => join(profileDir(profile), `${slot}.prev.json`);

  /** Write text atomically: temp file, 0600, rename. Returns whether it landed. */
  function writeAtomic(path: string, text: string): boolean {
    try {
      mkdirSync(dirname(path), { recursive: true, mode: DIR_MODE });
      const temp = `${path}.${process.pid}.tmp`;
      writeFileSync(temp, text, { encoding: 'utf8', mode: FILE_MODE });
      chmodSync(temp, FILE_MODE);
      renameSync(temp, path);
      return true;
    } catch {
      return false;
    }
  }

  function readJson(path: string): unknown {
    try {
      if (!statSync(path).isFile()) return null;
      return JSON.parse(readFileSync(path, 'utf8')) as unknown;
    } catch {
      return null;
    }
  }

  /** A stored envelope, or null for absent, unreadable, or a file that is not one. */
  function readEnvelope(path: string, profile: string, slot: SaveSlot): SaveEnvelope | null {
    const raw = readJson(path);
    if (raw === null || typeof raw !== 'object') return null;
    const value = raw as Record<string, unknown>;
    if (value.file === undefined) return null;
    const summary = summariseSaveValue(value.file);
    return {
      profile,
      slot,
      revision: typeof value.revision === 'number' && Number.isInteger(value.revision) && value.revision >= 0 ? value.revision : 1,
      updatedAtIso: typeof value.updatedAtIso === 'string' ? value.updatedAtIso : '',
      // Re-derived from the file rather than believed from the envelope: the
      // file is the record, the envelope is an index over it, and an index that
      // can disagree with what it indexes is a second source of truth.
      savedQuarter: summary.savedQuarter,
      savedAtIso: summary.savedAtIso,
      worldVersion: summary.worldVersion,
      companyName: summary.companyName,
      founderName: summary.founderName,
      byteLength: typeof value.byteLength === 'number' && Number.isFinite(value.byteLength) ? value.byteLength : 0,
      file: value.file,
    };
  }

  function readProfileRecord(profile: string): ProfileRecord | null {
    const raw = readJson(join(profileDir(profile), PROFILE_FILE));
    const value = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    if (!existsSync(profileDir(profile))) return null;
    return {
      profile,
      displayName: typeof value.displayName === 'string' && value.displayName.length > 0 ? value.displayName : profile,
      createdAtIso: typeof value.createdAtIso === 'string' ? value.createdAtIso : '',
      updatedAtIso: typeof value.updatedAtIso === 'string' ? value.updatedAtIso : '',
    };
  }

  function writeProfileRecord(profile: string, displayName: string | undefined, at: string): void {
    const existing = readProfileRecord(profile);
    const record: ProfileRecord = {
      profile,
      displayName: displayName !== undefined && displayName.trim().length > 0 ? displayName.trim().slice(0, 64) : (existing?.displayName ?? profile),
      createdAtIso: existing?.createdAtIso !== undefined && existing.createdAtIso.length > 0 ? existing.createdAtIso : at,
      updatedAtIso: at,
    };
    writeAtomic(join(profileDir(profile), PROFILE_FILE), JSON.stringify(record));
  }

  function slotsOf(profile: string): SaveSummaryEnvelope[] {
    return SAVE_SLOTS.map((slot) => {
      const envelope = readEnvelope(slotPath(profile, slot), profile, slot);
      return envelope === null ? emptySlot(profile, slot) : summaryOf(envelope);
    });
  }

  function profileNames(): string[] {
    try {
      return readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && isProfileSlug(entry.name))
        .map((entry) => entry.name)
        .sort();
    } catch {
      return [];
    }
  }

  return {
    root,

    /**
     * Every profile on this host, most recently written first so the laptop's
     * picker opens on the game the phone was just playing. Ties break on the
     * slug, so the order is a function of the data and nothing else.
     */
    listProfiles(): ProfileListing[] {
      const listings = profileNames().flatMap((profile) => {
        const record = readProfileRecord(profile);
        return record === null ? [] : [{ ...record, slots: slotsOf(profile) }];
      });
      return listings.sort((a, b) =>
        a.updatedAtIso === b.updatedAtIso ? a.profile.localeCompare(b.profile) : a.updatedAtIso < b.updatedAtIso ? 1 : -1,
      );
    },

    readProfile(profile: string): ProfileListing | null {
      if (!isProfileSlug(profile)) return null;
      const record = readProfileRecord(profile);
      return record === null ? null : { ...record, slots: slotsOf(profile) };
    },

    slots(profile: string): SaveSummaryEnvelope[] {
      if (!isProfileSlug(profile)) return [];
      return slotsOf(profile);
    },

    read(profile: string, slot: SaveSlot): SaveEnvelope | null {
      if (!isProfileSlug(profile) || !isSaveSlot(slot)) return null;
      return readEnvelope(slotPath(profile, slot), profile, slot);
    },

    /** The version one overwrite ago, for undoing a bad write. */
    readPrevious(profile: string, slot: SaveSlot): SaveEnvelope | null {
      if (!isProfileSlug(profile) || !isSaveSlot(slot)) return null;
      return readEnvelope(prevPath(profile, slot), profile, slot);
    },

    write(profile: string, slot: string, file: unknown, options: WriteOptions = {}): SaveWriteResult {
      if (!isProfileSlug(profile)) return { ok: false, status: 400, reason: 'invalid_profile' };
      if (!isSaveSlot(slot)) return { ok: false, status: 400, reason: 'invalid_slot' };

      // The same pure parser the browser uses. A file this build cannot read is
      // refused rather than stored: a save the server cannot describe is a save
      // no picker can label and no reconciliation can order.
      const inspection = inspectSaveValue(file);
      if (inspection.status === 'unsupported') return { ok: false, status: 400, reason: 'unsupported_save' };
      if (inspection.file === null) return { ok: false, status: 400, reason: 'invalid_save' };

      // Measured, not estimated: the cap is on the bytes this host will keep,
      // and a value that will not serialise at all is not a save file.
      let text: string | undefined;
      try {
        text = JSON.stringify(file);
      } catch {
        return { ok: false, status: 400, reason: 'invalid_save' };
      }
      if (text === undefined) return { ok: false, status: 400, reason: 'invalid_save' };
      const byteLength = Buffer.byteLength(text, 'utf8');
      if (byteLength > MAX_SAVE_BYTES) return { ok: false, status: 413, reason: 'save_too_large' };

      const dir = profileDir(profile);
      const isNewProfile = !existsSync(dir);
      if (isNewProfile && profileNames().length >= MAX_PROFILES) {
        return { ok: false, status: 507, reason: 'profile_limit' };
      }

      const current = readEnvelope(slotPath(profile, slot), profile, slot);
      const currentRevision = current?.revision ?? 0;
      if (options.ifRevision !== undefined && options.ifRevision !== currentRevision) {
        return {
          ok: false,
          status: 409,
          reason: 'stale_revision',
          current: current === null ? emptySlot(profile, slot) : summaryOf(current),
        };
      }

      // The conflict rule, applied where nobody has reconciled. A conditional
      // write whose revision matches has already been reconciled by the client
      // (or is a player deliberately putting a different game in this slot), and
      // whatever it replaces is kept as `<slot>.prev.json` either way.
      const summary = summariseSaveValue(file);
      if (options.ifRevision === undefined && current !== null && !isNewer(summary, current)) {
        return { ok: false, status: 409, reason: 'older_save', current: summaryOf(current) };
      }

      const at = now();
      const envelope: SaveEnvelope = {
        profile,
        slot,
        revision: currentRevision + 1,
        updatedAtIso: at,
        savedQuarter: summary.savedQuarter,
        savedAtIso: summary.savedAtIso,
        worldVersion: summary.worldVersion,
        companyName: summary.companyName,
        founderName: summary.founderName,
        byteLength,
        file,
      };

      try {
        mkdirSync(dir, { recursive: true, mode: DIR_MODE });
      } catch {
        return { ok: false, status: 500, reason: 'write_failed' };
      }

      // Rotate before replacing, never after: the previous version must already
      // be safe when the new one lands, or a crash between the two loses both.
      if (current !== null) {
        const existingText = (() => {
          try {
            return readFileSync(slotPath(profile, slot), 'utf8');
          } catch {
            return null;
          }
        })();
        if (existingText !== null) writeAtomic(prevPath(profile, slot), existingText);
      }

      if (!writeAtomic(slotPath(profile, slot), JSON.stringify(envelope))) {
        return { ok: false, status: 500, reason: 'write_failed' };
      }
      writeProfileRecord(profile, options.displayName, at);
      return { ok: true, envelope };
    },

    /** Empty one slot, keeping what was there as `<slot>.prev.json`. Absent is success. */
    remove(profile: string, slot: SaveSlot): boolean {
      if (!isProfileSlug(profile) || !isSaveSlot(slot)) return false;
      // A profile that does not exist has nothing to delete, and a DELETE must
      // never be the thing that creates one.
      if (!existsSync(profileDir(profile))) return true;
      const path = slotPath(profile, slot);
      try {
        if (existsSync(path)) {
          const text = readFileSync(path, 'utf8');
          writeAtomic(prevPath(profile, slot), text);
        }
        rmSync(path, { force: true });
        writeProfileRecord(profile, undefined, now());
        return true;
      } catch {
        return false;
      }
    },
  };
}

/**
 * Is this root usable — does it exist (or can it be made) and can this process
 * write to it?
 *
 * The question is not academic on the Pi. A fresh Docker named volume's mount
 * point is created by the runtime as root, while the app runs as `node`, so
 * `SAVE_DIR` can name a directory this process cannot write a byte to. The
 * honest answer to that is "this host does not do server saves" — the client
 * then stays on `localStorage`, which is exactly how the game worked before —
 * rather than a 500 on every autosave.
 */
export function rootWritable(root: string): boolean {
  try {
    mkdirSync(root, { recursive: true, mode: DIR_MODE });
    accessSync(root, constants.W_OK | constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * The store for this process, or null when `SAVE_DIR` is unset or unusable.
 *
 * Checked per call rather than memoised: an operator who fixes the directory's
 * ownership should see saves start working on the next request, not after a
 * container restart.
 */
export function saveStoreFrom(
  env: Readonly<Record<string, string | undefined>> = process.env,
  now?: () => string,
): SaveStore | null {
  const root = saveRootFrom(env);
  if (root === null || !rootWritable(root)) return null;
  return createSaveStore(now === undefined ? { root } : { root, now });
}
