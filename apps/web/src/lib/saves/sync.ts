/**
 * Local first, always; the host second, never blocking the game.
 *
 * This is the only module that has both sides of a save in its hands, and its
 * whole job is to make a second device possible without making the first one
 * worse. Three commitments, in order of how much they matter:
 *
 * 1. **The game never waits for the network.** Every write still goes to
 *    `localStorage` through `@/lib/game/persistence` exactly as it did before
 *    this existed, synchronously, on the path that already worked. Only *after*
 *    that lands does a push get scheduled. A Pi that is off, a tailnet that has
 *    dropped, a `SAVE_DIR` that was never set — all of it costs a status chip
 *    and nothing else.
 * 2. **Nothing is silently dropped.** A push that loses a reconciliation keeps
 *    its file: on the host as `<slot>.prev.json`, in the browser under a backup
 *    key that nothing else reads or overwrites. The conflict rule decides which
 *    copy is *shown*, never which copy is *destroyed*.
 * 3. **The rule is the server's rule.** Reconciliation is `./plan`, which is
 *    `isNewer` from `./shared` — the same function the route applies. There is
 *    no second opinion about which of two saves is later.
 *
 * ## Why a lost push heals itself
 *
 * A phone that is backgrounded mid-push, or leaves the tailnet, simply does not
 * finish. Nothing is queued to disk and nothing needs to be: the browser's copy
 * is now strictly newer than the host's, so the next time this profile is
 * reconciled — the next load, on this device or the same one — `planSlot`
 * answers `upload` for that slot and it goes. Durable retry state would be a
 * second record of the same fact.
 *
 * ## What is stored in `localStorage`
 *
 * - `frontier-saves-profile` — the chosen profile: `{ profile, displayName }`.
 *   Remembered per browser so the phone opens on its own game; switchable, and
 *   listable from the host so the laptop can pick the phone's.
 * - `frontier-saves-migrated-<profile>` — that this profile's first
 *   reconciliation has been reported to the player. Reconciliation itself runs
 *   every load and is idempotent; this flag only decides whether the landing
 *   page says a line about it.
 * - `frontier-saves-backup-<slot>` — a local copy that lost a reconciliation,
 *   set aside before the host's copy was adopted. Never read by the game.
 */

import { DEMO_SEED } from '@/lib/game/engine';
import { SAVE_KEY, SLOT_KEYS, writeSaveFile, writeSlotFile } from '@/lib/game/persistence';
import {
  ABSENT_SAVE_SUMMARY,
  type SaveFileSummary,
  inspectSaveValue,
  summariseSaveText,
} from '@/lib/game/saveFile';
import { createSavesClient, type SavesClient, type SavesResult } from './client';
import {
  type MigrationOutcome,
  NO_MIGRATION,
  type SlotFacts,
  planMigration,
  reconcileConflict,
  slotNumberOf,
} from './plan';
import {
  SAVE_SLOTS,
  type ProfileListing,
  type SaveEnvelope,
  type SaveOrder,
  type SaveSlot,
  type SaveSummaryEnvelope,
  displayNameOf,
  profileSlug,
} from './shared';

/* -------------------------------------------------------------------------- */
/*  Storage keys                                                               */
/* -------------------------------------------------------------------------- */

export const PROFILE_KEY = 'frontier-saves-profile';
export const MIGRATED_PREFIX = 'frontier-saves-migrated-';
export const BACKUP_PREFIX = 'frontier-saves-backup-';

/** The key one slot's losing local copy is kept under. Nothing in the game reads it. */
export function backupKeyOf(slot: SaveSlot): string {
  return `${BACKUP_PREFIX}${slot}`;
}

/**
 * The `localStorage` key for one server slot name.
 *
 * The autosave and the three numbered slots have had their keys since before
 * there was a host, and this stage does not renumber them: an existing save
 * must still be exactly where the build that wrote it left it.
 */
export function localKeyOf(slot: SaveSlot): string | null {
  const number = slotNumberOf(slot);
  if (number === null) return SAVE_KEY;
  return SLOT_KEYS[number - 1] ?? null;
}

/* -------------------------------------------------------------------------- */
/*  The local side, as a port                                                  */
/* -------------------------------------------------------------------------- */

/**
 * What the sync layer is allowed to do to this browser's storage.
 *
 * A port rather than direct calls for two reasons: the reconciliation tests
 * need a store that is not a browser, and — more importantly — every *write*
 * has to go through `persistence`'s guarded writer, which refuses to overwrite
 * a save version this build cannot read and keeps the memo that makes repeat
 * writes cheap. A `setItem` here would quietly defeat both.
 */
export interface LocalSaves {
  summary(slot: SaveSlot): SaveFileSummary;
  /** The stored save value, or null when absent or unparseable. */
  read(slot: SaveSlot): unknown;
  /** Adopt a value into the slot, through the guarded writer. */
  write(slot: SaveSlot, file: unknown): boolean;
  /** Set a losing copy aside. Best effort: a full quota must not block an adoption. */
  backup(slot: SaveSlot, value: unknown): boolean;
  /** A flag remembered per browser (the migration marker). */
  flag(key: string): boolean;
  setFlag(key: string): void;
  readIdentity(): ProfileIdentity | null;
  writeIdentity(identity: ProfileIdentity | null): void;
}

export interface ProfileIdentity {
  readonly profile: string;
  readonly displayName: string;
}

function storage(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** The real browser store: summaries and reads direct, every write through `persistence`. */
export function browserLocalSaves(): LocalSaves {
  const raw = (key: string): string | null => {
    const store = storage();
    if (store === null) return null;
    try {
      return store.getItem(key);
    } catch {
      return null;
    }
  };
  return {
    summary(slot) {
      const key = localKeyOf(slot);
      return key === null ? ABSENT_SAVE_SUMMARY : summariseSaveText(raw(key));
    },
    read(slot) {
      const key = localKeyOf(slot);
      const text = key === null ? null : raw(key);
      if (text === null) return null;
      try {
        return JSON.parse(text) as unknown;
      } catch {
        return null;
      }
    },
    write(slot, file) {
      // Validated here, not trusted: the value came off the wire, and the
      // guarded writer takes a parsed `SaveFile`. A file this build cannot read
      // is refused rather than written, which is the same answer `importSave`
      // gives a pasted one.
      const parsed = inspectSaveValue(file, { defaultSeed: DEMO_SEED }).file;
      if (parsed === null) return false;
      const number = slotNumberOf(slot);
      return number === null ? writeSaveFile(parsed) : writeSlotFile(number, parsed);
    },
    backup(slot, value) {
      const store = storage();
      if (store === null) return false;
      try {
        store.setItem(backupKeyOf(slot), JSON.stringify(value));
        return true;
      } catch {
        return false;
      }
    },
    flag(key) {
      return raw(key) !== null;
    },
    setFlag(key) {
      const store = storage();
      if (store === null) return;
      try {
        store.setItem(key, '1');
      } catch {
        /* A browser that refuses this simply reports the migration twice. */
      }
    },
    readIdentity() {
      const text = raw(PROFILE_KEY);
      if (text === null) return null;
      try {
        const parsed = JSON.parse(text) as Record<string, unknown>;
        const profile = typeof parsed.profile === 'string' ? profileSlug(parsed.profile) : null;
        if (profile === null) return null;
        const shown = typeof parsed.displayName === 'string' ? displayNameOf(parsed.displayName) : null;
        return { profile, displayName: shown ?? profile };
      } catch {
        return null;
      }
    },
    writeIdentity(identity) {
      const store = storage();
      if (store === null) return;
      try {
        if (identity === null) store.removeItem(PROFILE_KEY);
        else store.setItem(PROFILE_KEY, JSON.stringify(identity));
      } catch {
        /* Nothing to do: the profile is then per-session rather than remembered. */
      }
    },
  };
}

/* -------------------------------------------------------------------------- */
/*  State                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * What the chip says.
 *
 * - `unknown` — the host has not been asked yet.
 * - `off` — this host does not do server saves. **Not a fault**: it is the
 *   default, and the game behaves exactly as it always has.
 * - `synced` — everything this browser holds is on the host.
 * - `offline` — the host could not be reached. The game is unaffected and the
 *   next load reconciles.
 * - `unsynced` — the host answered and something is still not stored there: a
 *   push in flight, or one it refused.
 */
export type SyncStatus = 'unknown' | 'off' | 'synced' | 'offline' | 'unsynced';

export interface SyncState {
  readonly status: SyncStatus;
  /** Has a probe found a host that does server saves? */
  readonly enabled: boolean;
  readonly profile: string | null;
  readonly displayName: string | null;
  /** The host's four slot summaries as last seen. Null where it has not been asked. */
  readonly server: Readonly<Record<SaveSlot, SaveSummaryEnvelope | null>>;
  /** What the first reconciliation of this profile did, once, for the landing page. */
  readonly migration: MigrationOutcome | null;
  /** A refusal a person should read (too large, host full), or null. */
  readonly notice: string | null;
  readonly busy: boolean;
}

const EMPTY_SERVER: Readonly<Record<SaveSlot, SaveSummaryEnvelope | null>> = {
  autosave: null,
  '1': null,
  '2': null,
  '3': null,
};

/** What is true before any host has been asked. Also React's server snapshot. */
export const PRE_PROBE_STATE: SyncState = {
  status: 'unknown',
  enabled: false,
  profile: null,
  displayName: null,
  server: EMPTY_SERVER,
  migration: null,
  notice: null,
  busy: false,
};

/* -------------------------------------------------------------------------- */
/*  Timing                                                                     */
/* -------------------------------------------------------------------------- */

export interface SyncTimings {
  /** A burst of local writes collapses into one push. */
  readonly debounceMs: number;
  /** Backoff for a push that could not reach the host, in order. */
  readonly backoffMs: readonly number[];
}

export const DEFAULT_TIMINGS: SyncTimings = {
  debounceMs: 1_500,
  // Four tries over about a minute, then it stops and waits for the next load
  // to reconcile — which it will, because the local copy is newer by then.
  backoffMs: [2_000, 6_000, 20_000, 45_000],
};

export interface SaveSyncOptions {
  readonly client?: SavesClient;
  readonly local?: LocalSaves;
  readonly timings?: Partial<SyncTimings>;
  /** Injectable so a test can drive the debounce with fake timers of its own. */
  readonly setTimer?: (fn: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
}

/* -------------------------------------------------------------------------- */
/*  The controller                                                             */
/* -------------------------------------------------------------------------- */

export interface SaveSync {
  snapshot(): SyncState;
  subscribe(listener: () => void): () => void;
  /** Ask the host whether it does server saves, and for its profile list. */
  probe(): Promise<ProfileListing[]>;
  /** The profiles the host holds, from the last probe. */
  profiles(): readonly ProfileListing[];
  /** Adopt a profile (creating nothing on the host until something is written). */
  chooseProfile(name: string): Promise<boolean>;
  /** Forget the profile this browser remembers. Deletes nothing anywhere. */
  forgetProfile(): void;
  /** Refresh the host's slot summaries and carry out any reconciliation they imply. */
  reconcile(): Promise<MigrationOutcome>;
  /** What both sides hold, for the picker and for `mergeSlots`. */
  facts(): SlotFacts[];
  /** Schedule a push of a slot the game just wrote locally. Never awaited by the game. */
  push(slot: SaveSlot, file: unknown): void;
  /** Send everything scheduled, now. */
  flush(): Promise<void>;
  /** The host's copy of a slot, file included, for adoption. */
  pull(slot: SaveSlot): Promise<SaveEnvelope | null>;
  /** Set the local copy aside before the host's replaces it. */
  backupLocal(slot: SaveSlot): void;
  /** Remove a slot from the host. The local copy is the caller's business. */
  remove(slot: SaveSlot): Promise<void>;
  /** Clear the one-line migration report once the landing page has shown it. */
  acknowledgeMigration(): void;
}

interface SlotRunner {
  file: unknown;
  order: SaveOrder | null;
  timer: unknown;
  attempts: number;
  inFlight: boolean;
  revision: number;
  trouble: 'none' | 'offline' | 'refused';
}

function newRunner(): SlotRunner {
  return { file: undefined, order: null, timer: null, attempts: 0, inFlight: false, revision: 0, trouble: 'none' };
}

export function createSaveSync(options: SaveSyncOptions = {}): SaveSync {
  const client = options.client ?? createSavesClient();
  const local = options.local ?? browserLocalSaves();
  const timings: SyncTimings = { ...DEFAULT_TIMINGS, ...options.timings };
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));

  let state: SyncState = { ...PRE_PROBE_STATE, ...identityInto(local.readIdentity()) };
  let listings: ProfileListing[] = [];
  let probed = false;
  // Whether the host answered at all, last time anyone spoke to it. Distinct
  // from `enabled`, which is what it answered: "not there" and "there, and does
  // not do server saves" are different facts and get different chips.
  let reachable = true;
  const runners = new Map<SaveSlot, SlotRunner>(SAVE_SLOTS.map((slot) => [slot, newRunner()]));
  const listeners = new Set<() => void>();

  function identityInto(identity: ProfileIdentity | null): Pick<SyncState, 'profile' | 'displayName'> {
    return { profile: identity?.profile ?? null, displayName: identity?.displayName ?? null };
  }

  function emit(): void {
    for (const listener of listeners) listener();
  }

  function patch(next: Partial<SyncState>): void {
    // Applied first, then the chip recomputed from it: `statusNow` reads
    // `enabled` and the runners, so it has to see the world after the change.
    state = { ...state, ...next };
    state = { ...state, status: statusNow() };
    emit();
  }

  /**
   * The chip, computed rather than tracked.
   *
   * Order matters: unreachable outranks refused, because "the Pi is not there"
   * is the explanation a person can act on, and a refusal noticed while offline
   * is usually the same event seen twice.
   */
  function statusNow(): SyncStatus {
    if (!probed) return 'unknown';
    if (!reachable) return 'offline';
    if (!state.enabled) return 'off';
    let pending = false;
    let offline = false;
    let refused = false;
    for (const runner of runners.values()) {
      if (runner.file !== undefined || runner.inFlight) pending = true;
      if (runner.trouble === 'offline') offline = true;
      if (runner.trouble === 'refused') refused = true;
    }
    if (offline) return 'offline';
    if (refused) return 'unsynced';
    return pending ? 'unsynced' : 'synced';
  }

  function setServer(slot: SaveSlot, summary: SaveSummaryEnvelope | null): void {
    patch({ server: { ...state.server, [slot]: summary } });
  }

  /* --- the push pipeline --------------------------------------------------- */

  function schedule(slot: SaveSlot, delay: number): void {
    const runner = runners.get(slot);
    if (runner === undefined) return;
    if (runner.timer !== null) clearTimer(runner.timer);
    runner.timer = setTimer(() => {
      runner.timer = null;
      void run(slot);
    }, delay);
  }

  /**
   * Send this slot's pending file, and keep sending while the answer says to.
   *
   * A loop rather than a re-scheduled timer because the one case that repeats
   * immediately — a 409 whose `current` proves ours is the later position — is
   * a *continuation of this write*, not a new one. Anything a caller awaits
   * (`flush`, and every test) must therefore see it through to the end;
   * bouncing it off a timer would let `flush` return with the save unsent.
   * `attempts` bounds the loop.
   */
  async function run(slot: SaveSlot): Promise<void> {
    const runner = runners.get(slot);
    if (runner === undefined || runner.inFlight) return;
    const profile = state.profile;
    if (profile === null || !state.enabled) return;
    if (runner.file === undefined || runner.order === null) return;

    runner.inFlight = true;
    patch({ busy: true });
    try {
      for (;;) {
        const file = runner.file;
        const order = runner.order;
        if (file === undefined || order === null) break;
        // Cleared before the request, not after: a local write that lands while
        // this is in flight must leave a *new* pending file behind, and clearing
        // on success would then throw that newer save away.
        runner.file = undefined;
        runner.order = null;
        const result = await client.put(profile, slot, file, {
          ifRevision: runner.revision,
          ...(state.displayName === null ? {} : { displayName: state.displayName }),
        });
        if (settle(slot, runner, file, order, result) === 'done') break;
      }
    } finally {
      runner.inFlight = false;
      patch({ busy: anyInFlight() });
    }
  }

  /**
   * The host has just answered, so "could not reach the host" is no longer
   * true of any slot.
   *
   * A refusal is left standing: a save the host declined is still declined, and
   * hearing from it again does not change that.
   */
  function clearOfflineTrouble(): void {
    for (const runner of runners.values()) if (runner.trouble === 'offline') runner.trouble = 'none';
  }

  function anyInFlight(): boolean {
    for (const runner of runners.values()) if (runner.inFlight) return true;
    return false;
  }

  /**
   * Fold one PUT's answer back into the runner. The conflict rule lives in
   * `./plan`; this decides only whether the same write should go again now.
   */
  function settle(
    slot: SaveSlot,
    runner: SlotRunner,
    file: unknown,
    order: SaveOrder,
    result: SavesResult<SaveEnvelope>,
  ): 'again' | 'done' {
    if (result.ok) {
      reachable = true;
      runner.revision = result.value.revision;
      runner.attempts = 0;
      runner.trouble = 'none';
      const { file: _file, ...summary } = result.value;
      setServer(slot, summary);
      // A newer save arrived while this one was on the wire. It is a separate
      // write, so it goes through the debounce like any other rather than
      // riding this one's loop.
      if (runner.file !== undefined) schedule(slot, timings.debounceMs);
      return 'done';
    }

    if (result.reason === 'saves_disabled') {
      // The host stopped doing server saves under us (a `SAVE_DIR` that went
      // away). Off is a state the game knows how to be in; stop pushing.
      probed = true;
      reachable = true;
      runner.trouble = 'none';
      patch({ enabled: false });
      return 'done';
    }

    if (result.reason === 'stale_revision' || result.reason === 'older_save') {
      const current = result.current ?? null;
      if (current === null) {
        runner.trouble = 'refused';
        patch({ notice: 'The host refused a save and did not say what it holds.' });
        return 'done';
      }
      runner.revision = current.revision;
      setServer(slot, current);
      const outcome = reconcileConflict(order, current);
      if (outcome === 'resend' && runner.attempts < timings.backoffMs.length) {
        // Ours is the later position: re-send it against the revision the host
        // just named. What it displaces is kept by the host as `.prev.json`.
        runner.attempts += 1;
        runner.file = file;
        runner.order = order;
        return 'again';
      }
      // Theirs is later (or the two are the same position). Nothing is deleted:
      // this browser's copy stays under its own key, and the picker will offer
      // the host's. `backupLocal` runs if and when it is actually adopted.
      runner.attempts = 0;
      runner.trouble = 'none';
      return 'done';
    }

    if (result.reason === 'unreachable' || result.reason === 'rate_limited' || result.reason === 'server_error') {
      if (result.reason === 'unreachable') reachable = false;
      runner.trouble = result.reason === 'unreachable' ? 'offline' : 'refused';
      const delay = timings.backoffMs[runner.attempts];
      if (delay === undefined) {
        // Out of tries. The file is *not* re-queued: the local copy is newer
        // than the host's, so the next `reconcile()` uploads it. One record of
        // one fact.
        runner.attempts = 0;
        return 'done';
      }
      runner.attempts += 1;
      runner.file = file;
      runner.order = order;
      // Backoff waits on a timer, not in the loop: a caller awaiting `flush`
      // must not be held for a minute because the Pi is asleep.
      schedule(slot, Math.max(delay, (result.retryAfterSeconds ?? 0) * 1_000));
      return 'done';
    }

    runner.trouble = 'refused';
    runner.attempts = 0;
    patch({ notice: noticeFor(result.reason) });
    return 'done';
  }

  function noticeFor(reason: string): string {
    if (reason === 'save_too_large') return 'This save is too large for the host to store (the limit is 4 MB). It is still saved in this browser.';
    if (reason === 'profile_limit') return 'The host already holds 32 profiles and will not add another. This game is still saved in this browser.';
    if (reason === 'forbidden') return 'The host refused the save as a cross-site request. Open the game from its own address.';
    return 'The host refused the save. It is still saved in this browser.';
  }

  /* --- reconciliation ------------------------------------------------------ */

  function factsFrom(server: Readonly<Record<SaveSlot, SaveSummaryEnvelope | null>>): SlotFacts[] {
    return SAVE_SLOTS.map((slot) => ({ slot, local: local.summary(slot), server: server[slot] }));
  }

  return {
    snapshot: () => state,

    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },

    profiles: () => listings,

    async probe() {
      const result = await client.profiles();
      probed = true;
      if (!result.ok) {
        // Unreachable is not "off". A host that may well do server saves and
        // simply is not there right now must not be reported as one that has
        // them switched off — the two need different words and different hope.
        reachable = result.reason !== 'unreachable';
        if (result.reason === 'saves_disabled') patch({ enabled: false });
        else patch({});
        return listings;
      }
      reachable = true;
      clearOfflineTrouble();
      listings = result.value.profiles;
      patch({ enabled: result.value.enabled });
      return listings;
    },

    async chooseProfile(name: string) {
      const slug = profileSlug(name);
      if (slug === null) return false;
      const shown = displayNameOf(name) ?? slug;
      // Every slot's push state belongs to the profile it was pushing to.
      for (const slot of SAVE_SLOTS) {
        const runner = runners.get(slot);
        if (runner !== undefined && runner.timer !== null) clearTimer(runner.timer);
        runners.set(slot, newRunner());
      }
      local.writeIdentity({ profile: slug, displayName: shown });
      patch({ profile: slug, displayName: shown, server: EMPTY_SERVER, migration: null, notice: null });
      return true;
    },

    forgetProfile() {
      for (const slot of SAVE_SLOTS) {
        const runner = runners.get(slot);
        if (runner !== undefined && runner.timer !== null) clearTimer(runner.timer);
        runners.set(slot, newRunner());
      }
      local.writeIdentity(null);
      patch({ profile: null, displayName: null, server: EMPTY_SERVER, migration: null });
    },

    /**
     * Bring the two sides into agreement, and say what that took.
     *
     * Run on every load, not only the first: it is a function of the two
     * inventories, so a second run over an agreed pair does nothing. That is
     * also what makes an interrupted push self-healing — the browser's copy is
     * newer, so this uploads it — and why no retry queue is written to disk.
     *
     * The *report* is once per profile per browser; the flag decides that and
     * nothing else.
     */
    async reconcile(): Promise<MigrationOutcome> {
      const profile = state.profile;
      if (profile === null || !state.enabled) return NO_MIGRATION;

      const listed = await client.listSlots(profile);
      if (!listed.ok) {
        if (listed.reason === 'unreachable') reachable = false;
        if (listed.reason === 'saves_disabled') patch({ enabled: false });
        else patch({});
        return NO_MIGRATION;
      }
      reachable = true;
      clearOfflineTrouble();

      const server: Record<SaveSlot, SaveSummaryEnvelope | null> = { ...EMPTY_SERVER };
      for (const summary of listed.value.slots) server[summary.slot] = summary;
      for (const slot of SAVE_SLOTS) {
        const runner = runners.get(slot);
        if (runner !== undefined) runner.revision = server[slot]?.revision ?? 0;
      }
      patch({ server, busy: true });

      const uploaded: SaveSlot[] = [];
      const adopted: SaveSlot[] = [];
      const backedUp: SaveSlot[] = [];
      const blocked: SaveSlot[] = [];

      for (const plan of planMigration(factsFrom(server))) {
        if (plan.action === 'blocked') {
          blocked.push(plan.slot);
          continue;
        }
        if (plan.action === 'upload') {
          const file = local.read(plan.slot);
          if (file === null) continue;
          const result = await client.put(profile, plan.slot, file, {
            ifRevision: plan.ifRevision,
            ...(state.displayName === null ? {} : { displayName: state.displayName }),
          });
          const runner = runners.get(plan.slot);
          if (result.ok) {
            uploaded.push(plan.slot);
            if (runner !== undefined) {
              runner.revision = result.value.revision;
              runner.trouble = 'none';
            }
            const { file: _file, ...summary } = result.value;
            server[plan.slot] = summary;
          } else if (runner !== undefined) {
            runner.trouble = result.reason === 'unreachable' ? 'offline' : 'refused';
            if (result.current !== undefined) {
              runner.revision = result.current.revision;
              server[plan.slot] = result.current;
            }
          }
          continue;
        }
        if (plan.action === 'adopt') {
          const envelope = await client.get(profile, plan.slot);
          if (!envelope.ok) continue;
          // The local copy is set aside *before* the host's is written, so an
          // adoption can never be the step that loses it.
          const mine = local.read(plan.slot);
          if (mine !== null && local.backup(plan.slot, mine)) backedUp.push(plan.slot);
          if (local.write(plan.slot, envelope.value.file)) adopted.push(plan.slot);
          const runner = runners.get(plan.slot);
          if (runner !== undefined) runner.revision = envelope.value.revision;
        }
      }

      const outcome: MigrationOutcome = { uploaded, adopted, backedUp, blocked };
      const flag = `${MIGRATED_PREFIX}${profile}`;
      const first = !local.flag(flag);
      if (first) local.setFlag(flag);
      patch({ server, busy: anyInFlight(), migration: first ? outcome : null });
      return outcome;
    },

    facts: () => factsFrom(state.server),

    push(slot: SaveSlot, file: unknown) {
      if (state.profile === null || !state.enabled) return;
      const runner = runners.get(slot);
      if (runner === undefined) return;
      // The order is taken from the file itself rather than from the caller:
      // it is what the host will re-derive, so a reconciliation compares the
      // same two facts on both sides.
      const summary = inspectSummaryOf(file);
      if (summary === null) return;
      runner.file = file;
      runner.order = summary;
      runner.attempts = 0;
      schedule(slot, timings.debounceMs);
      patch({});
    },

    async flush() {
      const waiting: Promise<void>[] = [];
      for (const slot of SAVE_SLOTS) {
        const runner = runners.get(slot);
        if (runner === undefined) continue;
        if (runner.timer !== null) {
          clearTimer(runner.timer);
          runner.timer = null;
        }
        if (runner.file !== undefined) waiting.push(run(slot));
      }
      await Promise.all(waiting);
    },

    async pull(slot: SaveSlot) {
      const profile = state.profile;
      if (profile === null || !state.enabled) return null;
      const result = await client.get(profile, slot);
      if (!result.ok) return null;
      const { file: _file, ...summary } = result.value;
      const runner = runners.get(slot);
      if (runner !== undefined) runner.revision = result.value.revision;
      setServer(slot, summary);
      return result.value;
    },

    backupLocal(slot: SaveSlot) {
      const mine = local.read(slot);
      if (mine !== null) local.backup(slot, mine);
    },

    async remove(slot: SaveSlot) {
      const profile = state.profile;
      if (profile === null || !state.enabled) return;
      const runner = runners.get(slot);
      if (runner !== undefined) {
        if (runner.timer !== null) clearTimer(runner.timer);
        runners.set(slot, newRunner());
      }
      const result = await client.remove(profile, slot);
      if (result.ok) setServer(slot, null);
    },

    acknowledgeMigration() {
      if (state.migration !== null) patch({ migration: null });
    },
  };
}

/**
 * The two ordering facts, read straight off a save file value.
 *
 * Deliberately not a zod parse: the push path runs after every move, and the
 * host re-derives these itself with `summariseSaveValue` before it stores
 * anything. Null means the value carries no position at all, and a save with no
 * position cannot be ordered against another — so it is not pushed.
 */
function inspectSummaryOf(file: unknown): SaveOrder | null {
  if (file === null || typeof file !== 'object') return null;
  const raw = file as Record<string, unknown>;
  const savedQuarter = typeof raw.savedQuarter === 'number' && Number.isFinite(raw.savedQuarter) ? raw.savedQuarter : null;
  const savedAtIso = typeof raw.savedAtIso === 'string' ? raw.savedAtIso : null;
  if (savedQuarter === null && savedAtIso === null) return null;
  return { savedQuarter, savedAtIso };
}

/* -------------------------------------------------------------------------- */
/*  The one this app uses                                                      */
/* -------------------------------------------------------------------------- */

let singleton: SaveSync | null = null;

/**
 * The browser's sync layer, made once.
 *
 * One instance because the push state (revisions, backoff, what is in flight)
 * is about this *browser's* relationship with the host, and a second copy of it
 * would push the same slot twice with the same stale revision.
 */
export function saveSync(): SaveSync {
  singleton ??= createSaveSync();
  return singleton;
}
