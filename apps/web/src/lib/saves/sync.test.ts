/**
 * The sync layer, against a host that behaves like the real route.
 *
 * The fake host below is not a stub that returns whatever the test wants: it
 * assigns revisions, refuses a stale `ifRevision` with the summary it holds, and
 * applies the same `isNewer` to an unconditional write that
 * `/api/saves/[profile]/[slot]` applies. A reconciliation that only passes
 * against an agreeable mock is not a reconciliation, and the 409 handling is the
 * whole reason this module exists.
 *
 * What must never regress:
 *
 * 1. **Off is off.** No `SAVE_DIR` on the host and nothing is pushed at all.
 * 2. **Unreachable is not off.** The two get different words.
 * 3. **The game is never waited on.** A push is debounced and coalesced; the
 *    caller gets nothing to await.
 * 4. **A conflict is reconciled by the conflict rule**, and the loser is kept.
 * 5. **Reconciling twice does nothing the second time.**
 *
 * Deterministic: injected timers, an injected store, no clock and no network.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { SavesClient, SavesResult } from './client';
import type { LocalSaves, ProfileIdentity } from './sync';
import { MIGRATED_PREFIX, createSaveSync } from './sync';
import {
  type ProfileListing,
  type SaveEnvelope,
  type SaveSlot,
  type SaveSummaryEnvelope,
  SAVE_SLOTS,
  emptySlot,
  isNewer,
  summaryOf,
} from './shared';
import { ABSENT_SAVE_SUMMARY, type SaveFileSummary } from '../game/saveFile';

/* -------------------------------------------------------------------------- */
/*  A save file, as far as any of this cares                                   */
/* -------------------------------------------------------------------------- */

interface Fake {
  readonly version: number;
  readonly savedQuarter: number;
  readonly savedAtIso: string;
  readonly setup: { readonly companyName: string; readonly founderName: string };
}

function file(quarter: number, at = '2027-01-01T00:00:00.000Z', company = 'Acme AI'): Fake {
  return { version: 5, savedQuarter: quarter, savedAtIso: at, setup: { companyName: company, founderName: 'Dana Vale' } };
}

function summaryFor(value: unknown, profile: string, slot: SaveSlot, revision: number): SaveSummaryEnvelope {
  const raw = value as Fake;
  return {
    ...emptySlot(profile, slot),
    revision,
    updatedAtIso: '2027-09-09T00:00:00.000Z',
    savedQuarter: raw.savedQuarter,
    savedAtIso: raw.savedAtIso,
    companyName: raw.setup.companyName,
    founderName: raw.setup.founderName,
    byteLength: JSON.stringify(value).length,
  };
}

/* -------------------------------------------------------------------------- */
/*  A host that keeps the route's promises                                     */
/* -------------------------------------------------------------------------- */

interface FakeHost extends SavesClient {
  enabled: boolean;
  reachable: boolean;
  readonly stored: Map<string, SaveEnvelope>;
  puts: number;
  seed(profile: string, slot: SaveSlot, value: unknown, revision?: number): void;
}

function fakeHost(): FakeHost {
  const stored = new Map<string, SaveEnvelope>();
  const key = (profile: string, slot: SaveSlot): string => `${profile}/${slot}`;

  const host: FakeHost = {
    enabled: true,
    reachable: true,
    stored,
    puts: 0,

    seed(profile, slot, value, revision = 1) {
      stored.set(key(profile, slot), { ...summaryFor(value, profile, slot, revision), file: value });
    },

    async profiles(): Promise<SavesResult<{ enabled: boolean; profiles: ProfileListing[] }>> {
      if (!host.reachable) return { ok: false, reason: 'unreachable', status: null };
      if (!host.enabled) return { ok: true, value: { enabled: false, profiles: [] } };
      const names = new Set(Array.from(stored.keys(), (entry) => entry.split('/')[0] ?? ''));
      return {
        ok: true,
        value: {
          enabled: true,
          profiles: Array.from(names, (profile) => ({
            profile,
            displayName: profile,
            createdAtIso: '',
            updatedAtIso: '',
            slots: SAVE_SLOTS.map((slot) => summaryAt(profile, slot)),
          })),
        },
      };
    },

    async listSlots(profile) {
      if (!host.reachable) return { ok: false, reason: 'unreachable', status: null };
      if (!host.enabled) return { ok: false, reason: 'saves_disabled', status: 404 };
      return { ok: true, value: { exists: true, displayName: profile, slots: SAVE_SLOTS.map((slot) => summaryAt(profile, slot)) } };
    },

    async get(profile, slot) {
      if (!host.reachable) return { ok: false, reason: 'unreachable', status: null };
      if (!host.enabled) return { ok: false, reason: 'saves_disabled', status: 404 };
      const envelope = stored.get(key(profile, slot));
      return envelope === undefined ? { ok: false, reason: 'no_save', status: 404 } : { ok: true, value: envelope };
    },

    async put(profile, slot, value, options = {}) {
      host.puts += 1;
      if (!host.reachable) return { ok: false, reason: 'unreachable', status: null };
      if (!host.enabled) return { ok: false, reason: 'saves_disabled', status: 404 };
      const current = stored.get(key(profile, slot)) ?? null;
      const revision = current?.revision ?? 0;
      if (options.ifRevision !== undefined && options.ifRevision !== revision) {
        return { ok: false, reason: 'stale_revision', status: 409, current: summaryAt(profile, slot) };
      }
      const incoming = summaryFor(value, profile, slot, revision + 1);
      if (options.ifRevision === undefined && current !== null && !isNewer(incoming, current)) {
        return { ok: false, reason: 'older_save', status: 409, current: summaryOf(current) };
      }
      const envelope: SaveEnvelope = { ...incoming, file: value };
      stored.set(key(profile, slot), envelope);
      return { ok: true, value: envelope };
    },

    async remove(profile, slot) {
      if (!host.reachable) return { ok: false, reason: 'unreachable', status: null };
      if (!host.enabled) return { ok: false, reason: 'saves_disabled', status: 404 };
      return { ok: true, value: { deleted: stored.delete(key(profile, slot)) } };
    },
  };

  function summaryAt(profile: string, slot: SaveSlot): SaveSummaryEnvelope {
    const envelope = stored.get(key(profile, slot));
    return envelope === undefined ? emptySlot(profile, slot) : summaryOf(envelope);
  }

  return host;
}

/* -------------------------------------------------------------------------- */
/*  A browser store that is a Map                                              */
/* -------------------------------------------------------------------------- */

interface FakeLocal extends LocalSaves {
  readonly saves: Map<SaveSlot, unknown>;
  readonly backups: Map<SaveSlot, unknown>;
  readonly flags: Set<string>;
  /** Set to make one slot behave like a save this build cannot read. */
  readonly unreadable: Set<SaveSlot>;
}

function fakeLocal(): FakeLocal {
  const saves = new Map<SaveSlot, unknown>();
  const backups = new Map<SaveSlot, unknown>();
  const flags = new Set<string>();
  const unreadable = new Set<SaveSlot>();
  let identity: ProfileIdentity | null = null;

  return {
    saves,
    backups,
    flags,
    unreadable,
    summary(slot): SaveFileSummary {
      if (unreadable.has(slot)) return { ...ABSENT_SAVE_SUMMARY, status: 'unsupported', version: 99 };
      const value = saves.get(slot) as Fake | undefined;
      if (value === undefined) return ABSENT_SAVE_SUMMARY;
      return {
        ...ABSENT_SAVE_SUMMARY,
        status: 'ok',
        version: 5,
        savedQuarter: value.savedQuarter,
        savedAtIso: value.savedAtIso,
        companyName: value.setup.companyName,
        founderName: value.setup.founderName,
      };
    },
    read: (slot) => saves.get(slot) ?? null,
    write(slot, value) {
      if (unreadable.has(slot)) return false;
      saves.set(slot, value);
      return true;
    },
    backup(slot, value) {
      backups.set(slot, value);
      return true;
    },
    flag: (key) => flags.has(key),
    setFlag: (key) => void flags.add(key),
    readIdentity: () => identity,
    writeIdentity: (next) => void (identity = next),
  };
}

/* -------------------------------------------------------------------------- */
/*  Timers the test drives                                                     */
/* -------------------------------------------------------------------------- */

interface Clockwork {
  readonly scheduled: { fn: () => void; ms: number }[];
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

function clockwork(): Clockwork {
  const scheduled: { fn: () => void; ms: number }[] = [];
  return {
    scheduled,
    setTimer(fn, ms) {
      const entry = { fn, ms };
      scheduled.push(entry);
      return entry;
    },
    clearTimer(handle) {
      const at = scheduled.indexOf(handle as { fn: () => void; ms: number });
      if (at >= 0) scheduled.splice(at, 1);
    },
  };
}

/* -------------------------------------------------------------------------- */

let host: FakeHost;
let local: FakeLocal;
let timers: Clockwork;

function sync() {
  return createSaveSync({ client: host, local, setTimer: timers.setTimer, clearTimer: timers.clearTimer });
}

beforeEach(() => {
  host = fakeHost();
  local = fakeLocal();
  timers = clockwork();
});

/* -------------------------------------------------------------------------- */
/*  Off, and not-there                                                         */
/* -------------------------------------------------------------------------- */

describe('a host that does not do server saves', () => {
  it('is reported as off, and nothing is ever sent to it', async () => {
    host.enabled = false;
    const layer = sync();
    expect(layer.snapshot().status).toBe('unknown');

    await layer.probe();
    expect(layer.snapshot()).toMatchObject({ status: 'off', enabled: false });

    await layer.chooseProfile('YC');
    layer.push('autosave', file(3));
    await layer.flush();
    expect(host.puts).toBe(0);
  });

  it('reconciles to nothing rather than erroring', async () => {
    host.enabled = false;
    const layer = sync();
    await layer.probe();
    await layer.chooseProfile('YC');
    expect(await layer.reconcile()).toEqual({ uploaded: [], adopted: [], backedUp: [], blocked: [] });
  });
});

describe('a host that cannot be reached', () => {
  it('is offline, which is a different word from off', async () => {
    host.reachable = false;
    const layer = sync();
    await layer.probe();
    expect(layer.snapshot().status).toBe('offline');
    expect(layer.snapshot().enabled).toBe(false);
  });

  it('goes back to synced once it answers', async () => {
    host.reachable = false;
    const layer = sync();
    await layer.probe();
    host.reachable = true;
    await layer.probe();
    expect(layer.snapshot().status).toBe('synced');
  });
});

/* -------------------------------------------------------------------------- */
/*  Profiles                                                                   */
/* -------------------------------------------------------------------------- */

describe('choosing a profile', () => {
  it('normalises the typed name to a slug and remembers what was typed', async () => {
    const layer = sync();
    expect(await layer.chooseProfile('YC')).toBe(true);
    expect(layer.snapshot()).toMatchObject({ profile: 'yc', displayName: 'YC' });
    expect(local.readIdentity()).toEqual({ profile: 'yc', displayName: 'YC' });
  });

  it('accepts a name with punctuation in it', async () => {
    const layer = sync();
    expect(await layer.chooseProfile("Mum's Laptop!!")).toBe(true);
    expect(layer.snapshot().profile).toBe('mum-s-laptop');
  });

  it('refuses a name that leaves nothing usable', async () => {
    const layer = sync();
    expect(await layer.chooseProfile('!!')).toBe(false);
    expect(layer.snapshot().profile).toBeNull();
  });

  it('is remembered across a reload of this browser', async () => {
    await sync().chooseProfile('YC');
    expect(sync().snapshot()).toMatchObject({ profile: 'yc', displayName: 'YC' });
  });

  it('forgetting deletes nothing on the host', async () => {
    host.seed('yc', 'autosave', file(4));
    const layer = sync();
    await layer.probe();
    await layer.chooseProfile('YC');
    layer.forgetProfile();
    expect(layer.snapshot().profile).toBeNull();
    expect(host.stored.size).toBe(1);
  });
});

/* -------------------------------------------------------------------------- */
/*  Pushing                                                                    */
/* -------------------------------------------------------------------------- */

describe('pushing after a local write', () => {
  async function ready() {
    const layer = sync();
    await layer.probe();
    await layer.chooseProfile('YC');
    await layer.reconcile();
    return layer;
  }

  it('debounces: the game hands over a file and waits for nothing', async () => {
    const layer = await ready();
    layer.push('autosave', file(1));
    expect(host.puts).toBe(0);
    expect(timers.scheduled).toHaveLength(1);
    expect(timers.scheduled[0]?.ms).toBe(1_500);
  });

  it('coalesces a burst into one write of the last file', async () => {
    const layer = await ready();
    layer.push('autosave', file(1));
    layer.push('autosave', file(2));
    layer.push('autosave', file(3));
    await layer.flush();
    expect(host.puts).toBe(1);
    expect((host.stored.get('yc/autosave')?.file as Fake).savedQuarter).toBe(3);
  });

  it('is conditional on the revision it last saw', async () => {
    const layer = await ready();
    layer.push('autosave', file(1));
    await layer.flush();
    expect(host.stored.get('yc/autosave')?.revision).toBe(1);
    layer.push('autosave', file(2));
    await layer.flush();
    // A second accepted write, not a 409: the runner carried the revision the
    // first one returned.
    expect(host.stored.get('yc/autosave')?.revision).toBe(2);
    expect(layer.snapshot().status).toBe('synced');
  });

  it('goes offline when the host stops answering, and recovers without losing the file', async () => {
    const layer = await ready();
    host.reachable = false;
    layer.push('autosave', file(4));
    await layer.flush();
    expect(layer.snapshot().status).toBe('offline');
    // Not dropped: the file is queued behind a backoff timer.
    expect(timers.scheduled).toHaveLength(1);

    host.reachable = true;
    await layer.probe();
    // Reachable again, but the save is still not there — two different words.
    expect(layer.snapshot().status).toBe('unsynced');

    await layer.flush();
    expect(layer.snapshot().status).toBe('synced');
    expect((host.stored.get('yc/autosave')?.file as Fake).savedQuarter).toBe(4);
  });

  it('does nothing at all without a profile', async () => {
    const layer = sync();
    await layer.probe();
    layer.push('autosave', file(1));
    await layer.flush();
    expect(host.puts).toBe(0);
  });

  it('will not push a value that carries no position to order it by', async () => {
    const layer = await ready();
    layer.push('autosave', { version: 5 });
    await layer.flush();
    expect(host.puts).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/*  Conflicts                                                                  */
/* -------------------------------------------------------------------------- */

describe('a second device wrote the same slot', () => {
  async function readyWith(serverQuarter: number, revision: number) {
    host.seed('yc', 'autosave', file(serverQuarter), revision);
    const layer = sync();
    await layer.probe();
    await layer.chooseProfile('YC');
    return layer;
  }

  it('re-sends when ours is the later position, and the host keeps the loser', async () => {
    const layer = await readyWith(2, 5);
    // No reconcile first: the runner's revision is 0, so the conditional write
    // is stale on arrival — exactly what a phone that has been asleep sends.
    local.saves.set('autosave', file(9));
    layer.push('autosave', file(9));
    await layer.flush();
    expect(host.stored.get('yc/autosave')?.revision).toBe(6);
    expect((host.stored.get('yc/autosave')?.file as Fake).savedQuarter).toBe(9);
    expect(layer.snapshot().status).toBe('synced');
  });

  it('yields when theirs is later, keeps ours, and stops retrying', async () => {
    const layer = await readyWith(20, 5);
    local.saves.set('autosave', file(3));
    layer.push('autosave', file(3));
    await layer.flush();

    expect((host.stored.get('yc/autosave')?.file as Fake).savedQuarter).toBe(20);
    // Ours is not deleted, and the host's summary is now what the picker sees.
    expect((local.saves.get('autosave') as Fake).savedQuarter).toBe(3);
    expect(layer.snapshot().server.autosave).toMatchObject({ savedQuarter: 20, revision: 5 });
    expect(layer.snapshot().status).toBe('synced');
  });

  it('settles on an exact tie without looping', async () => {
    const layer = await readyWith(4, 5);
    layer.push('autosave', file(4));
    await layer.flush();
    expect(host.stored.get('yc/autosave')?.revision).toBe(5);
    expect(layer.snapshot().status).toBe('synced');
  });
});

/* -------------------------------------------------------------------------- */
/*  Reconciliation — decision 6                                                */
/* -------------------------------------------------------------------------- */

describe('reconcile', () => {
  async function ready() {
    const layer = sync();
    await layer.probe();
    await layer.chooseProfile('YC');
    return layer;
  }

  it('uploads every local slot the host does not have', async () => {
    local.saves.set('autosave', file(6));
    local.saves.set('2', file(3));
    const layer = await ready();

    const outcome = await layer.reconcile();
    expect(outcome.uploaded).toEqual(['autosave', '2']);
    expect(outcome.adopted).toEqual([]);
    expect(host.stored.get('yc/autosave')?.revision).toBe(1);
    expect(host.stored.get('yc/2')?.revision).toBe(1);
  });

  it('adopts a slot only the host has, and reports it once', async () => {
    host.seed('yc', '1', file(11));
    const layer = await ready();

    const outcome = await layer.reconcile();
    expect(outcome.adopted).toEqual(['1']);
    expect((local.saves.get('1') as Fake).savedQuarter).toBe(11);
    expect(layer.snapshot().migration).toMatchObject({ adopted: ['1'] });
    expect(local.flags.has(`${MIGRATED_PREFIX}yc`)).toBe(true);
  });

  it('sets the local copy aside before the host replaces it', async () => {
    local.saves.set('autosave', file(2));
    host.seed('yc', 'autosave', file(15));
    const layer = await ready();

    const outcome = await layer.reconcile();
    expect(outcome.adopted).toEqual(['autosave']);
    expect(outcome.backedUp).toEqual(['autosave']);
    expect((local.backups.get('autosave') as Fake).savedQuarter).toBe(2);
    expect((local.saves.get('autosave') as Fake).savedQuarter).toBe(15);
  });

  it('never sends an older local save over a newer server one', async () => {
    local.saves.set('autosave', file(2));
    host.seed('yc', 'autosave', file(15), 4);
    const layer = await ready();
    await layer.reconcile();
    expect(host.stored.get('yc/autosave')?.revision).toBe(4);
    expect((host.stored.get('yc/autosave')?.file as Fake).savedQuarter).toBe(15);
  });

  it('never deletes a server save because this browser lacks it', async () => {
    host.seed('yc', '3', file(7));
    const layer = await ready();
    await layer.reconcile();
    expect(host.stored.has('yc/3')).toBe(true);
  });

  it('leaves a save this build cannot read alone, in both directions', async () => {
    local.unreadable.add('1');
    host.seed('yc', '1', file(30));
    const layer = await ready();

    const outcome = await layer.reconcile();
    expect(outcome.blocked).toEqual(['1']);
    expect(outcome.uploaded).toEqual([]);
    expect(outcome.adopted).toEqual([]);
    expect(local.saves.has('1')).toBe(false);
    expect((host.stored.get('yc/1')?.file as Fake).savedQuarter).toBe(30);
  });

  it('does nothing the second time, so it can run on every load', async () => {
    local.saves.set('autosave', file(6));
    const layer = await ready();

    await layer.reconcile();
    const before = host.puts;
    const second = await layer.reconcile();
    expect(second).toEqual({ uploaded: [], adopted: [], backedUp: [], blocked: [] });
    expect(host.puts).toBe(before);
  });

  it('reports the migration once per profile per browser', async () => {
    host.seed('yc', '1', file(11));
    const layer = await ready();
    await layer.reconcile();
    expect(layer.snapshot().migration).not.toBeNull();

    layer.acknowledgeMigration();
    await layer.reconcile();
    expect(layer.snapshot().migration).toBeNull();
  });

  it('is offline, not wrong, when the host disappears mid-session', async () => {
    local.saves.set('autosave', file(6));
    const layer = await ready();
    host.reachable = false;
    expect(await layer.reconcile()).toEqual({ uploaded: [], adopted: [], backedUp: [], blocked: [] });
    expect(layer.snapshot().status).toBe('offline');
  });
});

/* -------------------------------------------------------------------------- */
/*  Pull and remove                                                            */
/* -------------------------------------------------------------------------- */

describe('pull and remove', () => {
  it('pulls the whole envelope, file included, for adoption', async () => {
    host.seed('yc', '2', file(12, '2027-01-01T00:00:00.000Z', 'Northwind'));
    const layer = sync();
    await layer.probe();
    await layer.chooseProfile('YC');

    const envelope = await layer.pull('2');
    expect((envelope?.file as Fake).savedQuarter).toBe(12);
    expect(layer.snapshot().server['2']).toMatchObject({ companyName: 'Northwind', revision: 1 });
  });

  it('removes the host copy and forgets what it held', async () => {
    host.seed('yc', '3', file(4));
    const layer = sync();
    await layer.probe();
    await layer.chooseProfile('YC');
    await layer.reconcile();

    await layer.remove('3');
    expect(host.stored.has('yc/3')).toBe(false);
    expect(layer.snapshot().server['3']).toBeNull();
  });

  it('sets the local copy aside on request, without touching it', async () => {
    local.saves.set('autosave', file(5));
    const layer = sync();
    layer.backupLocal('autosave');
    expect((local.backups.get('autosave') as Fake).savedQuarter).toBe(5);
    expect(local.saves.has('autosave')).toBe(true);
  });
});
