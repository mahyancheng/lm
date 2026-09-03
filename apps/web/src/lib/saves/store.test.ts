/**
 * The file-backed save store.
 *
 * What must never regress:
 *
 * 1. **Off by default.** No `SAVE_DIR` means no store, and the client is
 *    unchanged.
 * 2. **A save is never overwritten by an older one.** `isNewer` decides by
 *    `savedQuarter`, then `savedAtIso`, and a tie goes to the incumbent.
 * 3. **One bad write is undoable.** Every overwrite leaves `<slot>.prev.json`.
 * 4. **Owner-only, atomic.** Directories 0700, files 0600, no torn file.
 * 5. **Bounded.** 4 MB per save, four slots, 32 profiles.
 * 6. **A slug cannot escape the root.**
 *
 * Every case runs against a `mkdtemp` directory with an injected clock: no real
 * home directory and no wall clock are ever touched.
 */

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MAX_PROFILES,
  MAX_SAVE_BYTES,
  MAX_SLOTS_PER_PROFILE,
  SAVE_SLOTS,
  createSaveStore,
  emptySlot,
  isNewer,
  isProfileSlug,
  isSaveSlot,
  profileSlug,
  saveRootFrom,
  saveStoreFrom,
  summaryOf,
  type SaveStore,
} from './store';

/* -------------------------------------------------------------------------- */
/*  Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

interface FileOptions {
  readonly savedQuarter?: number;
  readonly savedAtIso?: string | null;
  readonly companyName?: string;
  readonly padding?: string;
}

/** A minimal but genuinely valid v5 save file — the shape the parser accepts. */
function saveFile(options: FileOptions = {}): Record<string, unknown> {
  return {
    version: 5,
    seed: 424242,
    difficulty: 'standard',
    autoExecuteRoutine: false,
    setup: {
      companyName: options.companyName ?? 'Acme AI',
      founderName: 'Dana Vale',
      backgroundId: 'consumer_ai',
      sector: 'ai',
      region: 'north_america',
      worldVersion: 2,
    },
    worldVersion: 2,
    log: [],
    checkpoint: null,
    savedQuarter: options.savedQuarter ?? 4,
    queue: [],
    savedAtIso: options.savedAtIso === undefined ? '2027-01-01T00:00:00.000Z' : options.savedAtIso,
    ...(options.padding === undefined ? {} : { padding: options.padding }),
  };
}

let root: string;
let store: SaveStore;
let tick = 0;

const clock = (): string => {
  tick += 1;
  return `2027-02-0${tick}T00:00:00.000Z`;
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'frontier-saves-'));
  tick = 0;
  store = createSaveStore({ root, now: clock });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/* -------------------------------------------------------------------------- */
/*  Names, slots, caps                                                         */
/* -------------------------------------------------------------------------- */

describe('profile slugs', () => {
  it('accepts the documented pattern and refuses everything else', () => {
    expect(isProfileSlug('yc')).toBe(true);
    expect(isProfileSlug('a1-b2-c3')).toBe(true);
    expect(isProfileSlug('a'.repeat(32))).toBe(true);
    expect(isProfileSlug('a'.repeat(33))).toBe(false);
    expect(isProfileSlug('y')).toBe(false);
    expect(isProfileSlug('-yc')).toBe(false);
    expect(isProfileSlug('YC')).toBe(false);
    expect(isProfileSlug('y c')).toBe(false);
    expect(isProfileSlug('..')).toBe(false);
    expect(isProfileSlug('../etc')).toBe(false);
    expect(isProfileSlug('a/b')).toBe(false);
    expect(isProfileSlug(7)).toBe(false);
  });

  it('normalises a typed name, and answers null when nothing usable is left', () => {
    expect(profileSlug('YC')).toBe('yc');
    expect(profileSlug("Mum's Laptop!!")).toBe('mum-s-laptop');
    expect(profileSlug('  Living Room  ')).toBe('living-room');
    expect(profileSlug('!')).toBeNull();
    expect(profileSlug('x')).toBeNull();
    expect(profileSlug('x'.repeat(64))).toBe('x'.repeat(32));
  });

  it('knows its four slots', () => {
    expect(SAVE_SLOTS).toEqual(['autosave', '1', '2', '3']);
    expect(MAX_SLOTS_PER_PROFILE).toBe(4);
    expect(isSaveSlot('autosave')).toBe(true);
    expect(isSaveSlot('4')).toBe(false);
    expect(isSaveSlot('profile')).toBe(false);
  });
});

describe('saveRootFrom', () => {
  it('is off unless SAVE_DIR names something', () => {
    expect(saveRootFrom({})).toBeNull();
    expect(saveRootFrom({ SAVE_DIR: '' })).toBeNull();
    expect(saveRootFrom({ SAVE_DIR: '   ' })).toBeNull();
    expect(saveRootFrom({ SAVE_DIR: '/data/saves' })).toBe('/data/saves');
    expect(saveStoreFrom({})).toBeNull();
    expect(saveStoreFrom({ SAVE_DIR: root })?.root).toBe(root);
  });

  it('is off when SAVE_DIR names something this process cannot write', () => {
    // A regular file where the directory should be: `mkdir` fails, so the host
    // reports no server saves rather than 500ing on every autosave.
    const blocked = join(root, 'a-file');
    writeFileSync(blocked, 'not a directory');
    expect(saveStoreFrom({ SAVE_DIR: blocked })).toBeNull();
  });

  it('creates the root, owner-only, the first time it is asked for', () => {
    const nested = join(root, 'nested', 'saves');
    expect(saveStoreFrom({ SAVE_DIR: nested })?.root).toBe(nested);
    expect(statSync(nested).mode & 0o777).toBe(0o700);
  });
});

/* -------------------------------------------------------------------------- */
/*  The conflict rule                                                          */
/* -------------------------------------------------------------------------- */

describe('isNewer', () => {
  it('orders by savedQuarter first', () => {
    expect(isNewer({ savedQuarter: 5, savedAtIso: '2020-01-01T00:00:00.000Z' }, { savedQuarter: 4, savedAtIso: '2030-01-01T00:00:00.000Z' })).toBe(true);
    expect(isNewer({ savedQuarter: 4, savedAtIso: '2030-01-01T00:00:00.000Z' }, { savedQuarter: 5, savedAtIso: '2020-01-01T00:00:00.000Z' })).toBe(false);
  });

  it('falls back to savedAtIso only on an equal quarter', () => {
    expect(isNewer({ savedQuarter: 4, savedAtIso: '2027-01-02T00:00:00.000Z' }, { savedQuarter: 4, savedAtIso: '2027-01-01T00:00:00.000Z' })).toBe(true);
    expect(isNewer({ savedQuarter: 4, savedAtIso: '2027-01-01T00:00:00.000Z' }, { savedQuarter: 4, savedAtIso: '2027-01-02T00:00:00.000Z' })).toBe(false);
  });

  it('gives every tie to the incumbent', () => {
    const same = { savedQuarter: 4, savedAtIso: '2027-01-01T00:00:00.000Z' };
    expect(isNewer(same, same)).toBe(false);
    expect(isNewer({ savedQuarter: null, savedAtIso: null }, { savedQuarter: null, savedAtIso: null })).toBe(false);
  });

  it('treats a missing or unparseable stamp as the oldest thing there is', () => {
    expect(isNewer({ savedQuarter: 4, savedAtIso: null }, { savedQuarter: 4, savedAtIso: '2027-01-01T00:00:00.000Z' })).toBe(false);
    expect(isNewer({ savedQuarter: 4, savedAtIso: 'not a date' }, { savedQuarter: 4, savedAtIso: '2027-01-01T00:00:00.000Z' })).toBe(false);
    expect(isNewer({ savedQuarter: 4, savedAtIso: '2027-01-01T00:00:00.000Z' }, { savedQuarter: 4, savedAtIso: null })).toBe(true);
    // A file with no quarter at all still loses to one at quarter 0.
    expect(isNewer({ savedQuarter: null, savedAtIso: '2030-01-01T00:00:00.000Z' }, { savedQuarter: 0, savedAtIso: null })).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/*  Writing and reading                                                        */
/* -------------------------------------------------------------------------- */

describe('write and read', () => {
  it('stores the file verbatim under an envelope, owner-only', () => {
    const file = saveFile({ savedQuarter: 4, companyName: 'Acme AI' });
    const result = store.write('yc', 'autosave', file, { displayName: 'YC' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.envelope.profile).toBe('yc');
    expect(result.envelope.slot).toBe('autosave');
    expect(result.envelope.revision).toBe(1);
    expect(result.envelope.updatedAtIso).toBe('2027-02-01T00:00:00.000Z');
    expect(result.envelope.savedQuarter).toBe(4);
    expect(result.envelope.savedAtIso).toBe('2027-01-01T00:00:00.000Z');
    expect(result.envelope.companyName).toBe('Acme AI');
    expect(result.envelope.founderName).toBe('Dana Vale');
    expect(result.envelope.worldVersion).toBe(2);
    expect(result.envelope.byteLength).toBe(Buffer.byteLength(JSON.stringify(file), 'utf8'));

    // Verbatim: what comes back parses to exactly what went in.
    expect(store.read('yc', 'autosave')?.file).toEqual(file);

    expect(statSync(join(root, 'yc')).mode & 0o777).toBe(0o700);
    expect(statSync(join(root, 'yc', 'autosave.json')).mode & 0o777).toBe(0o600);
    expect(statSync(join(root, 'yc', 'profile.json')).mode & 0o777).toBe(0o600);
  });

  it('records the display name beside the slug and keeps createdAt across writes', () => {
    store.write('yc', 'autosave', saveFile({ savedQuarter: 1 }), { displayName: 'YC' });
    store.write('yc', 'autosave', saveFile({ savedQuarter: 2 }), { displayName: 'YC' });
    const listing = store.readProfile('yc');
    expect(listing?.displayName).toBe('YC');
    expect(listing?.createdAtIso).toBe('2027-02-01T00:00:00.000Z');
    expect(listing?.updatedAtIso).toBe('2027-02-02T00:00:00.000Z');
  });

  it('describes four slots for a profile, empty ones included', () => {
    store.write('yc', '2', saveFile({ savedQuarter: 9 }));
    const slots = store.slots('yc');
    expect(slots).toHaveLength(4);
    expect(slots.map((slot) => slot.slot)).toEqual(['autosave', '1', '2', '3']);
    expect(slots[0]).toEqual(emptySlot('yc', 'autosave'));
    expect(slots[2]?.savedQuarter).toBe(9);
    expect(slots[2]?.revision).toBe(1);
    // A summary never carries the file.
    expect(Object.keys(slots[2] ?? {})).not.toContain('file');
  });

  it('lists profiles newest first, with slugs only', () => {
    store.write('phone', 'autosave', saveFile({ savedQuarter: 1 }), { displayName: 'Phone' });
    store.write('laptop', 'autosave', saveFile({ savedQuarter: 1 }), { displayName: 'Laptop' });
    // A stray file and a badly named directory are not profiles.
    writeFileSync(join(root, 'stray.json'), '{}');
    expect(store.listProfiles().map((entry) => entry.profile)).toEqual(['laptop', 'phone']);
    expect(store.listProfiles()[0]?.slots).toHaveLength(4);
  });

  it('answers null for an absent profile, slot or unreadable file', () => {
    expect(store.read('yc', 'autosave')).toBeNull();
    expect(store.readProfile('yc')).toBeNull();
    expect(store.slots('..')).toEqual([]);
    store.write('yc', 'autosave', saveFile());
    writeFileSync(join(root, 'yc', '1.json'), 'not json');
    expect(store.read('yc', '1')).toBeNull();
    expect(store.slots('yc')[1]).toEqual(emptySlot('yc', '1'));
  });
});

/* -------------------------------------------------------------------------- */
/*  Refusals                                                                   */
/* -------------------------------------------------------------------------- */

describe('what a write refuses', () => {
  it('refuses a bad profile or slot before it touches the disk', () => {
    expect(store.write('../etc', 'autosave', saveFile())).toMatchObject({ ok: false, status: 400, reason: 'invalid_profile' });
    expect(store.write('yc', '4', saveFile())).toMatchObject({ ok: false, status: 400, reason: 'invalid_slot' });
    expect(store.write('yc', 'profile', saveFile())).toMatchObject({ ok: false, status: 400, reason: 'invalid_slot' });
    expect(existsSync(join(root, 'yc'))).toBe(false);
  });

  it('refuses a file this build cannot read, and a version it does not know', () => {
    expect(store.write('yc', 'autosave', { version: 99 })).toMatchObject({ ok: false, status: 400, reason: 'unsupported_save' });
    expect(store.write('yc', 'autosave', 'a string')).toMatchObject({ ok: false, status: 400, reason: 'invalid_save' });
    expect(store.write('yc', 'autosave', null)).toMatchObject({ ok: false, status: 400, reason: 'invalid_save' });
  });

  it('refuses a save over the size cap with 413', () => {
    const big = saveFile({ padding: 'x'.repeat(MAX_SAVE_BYTES) });
    expect(store.write('yc', 'autosave', big)).toMatchObject({ ok: false, status: 413, reason: 'save_too_large' });
    expect(store.read('yc', 'autosave')).toBeNull();
  });

  it('refuses a profile beyond the host cap with 507, but still writes to existing ones', () => {
    for (let index = 0; index < MAX_PROFILES; index += 1) {
      const result = store.write(`p${index}`, 'autosave', saveFile({ savedQuarter: 1 }));
      expect(result.ok).toBe(true);
    }
    expect(store.write('one-too-many', 'autosave', saveFile())).toMatchObject({ ok: false, status: 507, reason: 'profile_limit' });
    expect(store.write('p0', '1', saveFile({ savedQuarter: 2 })).ok).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/*  Conflicts                                                                  */
/* -------------------------------------------------------------------------- */

describe('conflicts', () => {
  it('bumps the revision by one per accepted write', () => {
    expect(store.write('yc', 'autosave', saveFile({ savedQuarter: 1 }))).toMatchObject({ ok: true });
    expect(store.write('yc', 'autosave', saveFile({ savedQuarter: 2 }))).toMatchObject({ ok: true });
    expect(store.read('yc', 'autosave')?.revision).toBe(2);
  });

  it('answers 409 with the current summary when ifRevision is stale, and never carries the file', () => {
    store.write('yc', 'autosave', saveFile({ savedQuarter: 1 }));
    const stale = store.write('yc', 'autosave', saveFile({ savedQuarter: 2 }), { ifRevision: 0 });
    expect(stale).toMatchObject({ ok: false, status: 409, reason: 'stale_revision' });
    if (stale.ok) return;
    expect(stale.current?.revision).toBe(1);
    expect(stale.current?.savedQuarter).toBe(1);
    expect(stale.current).not.toHaveProperty('file');
    // The stored save is untouched.
    expect(store.read('yc', 'autosave')?.savedQuarter).toBe(1);
  });

  it('accepts a conditional write whose revision matches, even for a first write', () => {
    expect(store.write('yc', '1', saveFile({ savedQuarter: 3 }), { ifRevision: 0 })).toMatchObject({ ok: true });
    expect(store.write('yc', '1', saveFile({ savedQuarter: 4 }), { ifRevision: 1 })).toMatchObject({ ok: true });
    expect(store.read('yc', '1')?.revision).toBe(2);
  });

  it('never lets an unconditional write replace a newer save', () => {
    store.write('yc', 'autosave', saveFile({ savedQuarter: 8, savedAtIso: '2027-01-05T00:00:00.000Z' }));
    const older = store.write('yc', 'autosave', saveFile({ savedQuarter: 5, savedAtIso: '2027-01-09T00:00:00.000Z' }));
    expect(older).toMatchObject({ ok: false, status: 409, reason: 'older_save' });
    expect(store.read('yc', 'autosave')?.savedQuarter).toBe(8);

    // Same quarter, same stamp: a tie goes to the server copy.
    expect(store.write('yc', 'autosave', saveFile({ savedQuarter: 8, savedAtIso: '2027-01-05T00:00:00.000Z' }))).toMatchObject({
      ok: false,
      reason: 'older_save',
    });
    // Strictly newer is accepted.
    expect(store.write('yc', 'autosave', saveFile({ savedQuarter: 9, savedAtIso: '2027-01-05T00:00:00.000Z' }))).toMatchObject({ ok: true });
  });

  it('honours a reconciled conditional write even when it is older, and keeps the loser', () => {
    store.write('yc', '2', saveFile({ savedQuarter: 8 }));
    const deliberate = store.write('yc', '2', saveFile({ savedQuarter: 2, companyName: 'Other Co' }), { ifRevision: 1 });
    expect(deliberate).toMatchObject({ ok: true });
    expect(store.read('yc', '2')?.savedQuarter).toBe(2);
    expect(store.readPrevious('yc', '2')?.savedQuarter).toBe(8);
  });
});

/* -------------------------------------------------------------------------- */
/*  Rotation and deletion                                                      */
/* -------------------------------------------------------------------------- */

describe('rotation', () => {
  it('keeps the replaced version as <slot>.prev.json on every overwrite', () => {
    store.write('yc', 'autosave', saveFile({ savedQuarter: 1 }));
    expect(existsSync(join(root, 'yc', 'autosave.prev.json'))).toBe(false);
    store.write('yc', 'autosave', saveFile({ savedQuarter: 2 }));
    store.write('yc', 'autosave', saveFile({ savedQuarter: 3 }));
    expect(store.read('yc', 'autosave')?.savedQuarter).toBe(3);
    expect(store.readPrevious('yc', 'autosave')?.savedQuarter).toBe(2);
    expect(statSync(join(root, 'yc', 'autosave.prev.json')).mode & 0o777).toBe(0o600);
    // The rotated copy is the previous file byte for byte.
    expect((JSON.parse(readFileSync(join(root, 'yc', 'autosave.prev.json'), 'utf8')) as { revision: number }).revision).toBe(2);
  });

  it('deletes a slot, keeping what was there, and does not create a profile', () => {
    store.write('yc', '3', saveFile({ savedQuarter: 6 }));
    expect(store.remove('yc', '3')).toBe(true);
    expect(store.read('yc', '3')).toBeNull();
    expect(store.readPrevious('yc', '3')?.savedQuarter).toBe(6);
    // Absent is success; an unknown profile is never created by a delete.
    expect(store.remove('yc', '3')).toBe(true);
    expect(store.remove('nobody', 'autosave')).toBe(true);
    expect(existsSync(join(root, 'nobody'))).toBe(false);
    expect(store.remove('..', 'autosave')).toBe(false);
  });

  it('leaves no temp file behind', () => {
    store.write('yc', 'autosave', saveFile({ savedQuarter: 1 }));
    store.write('yc', 'autosave', saveFile({ savedQuarter: 2 }));
    const names = readdirSync(join(root, 'yc'));
    expect(names.filter((name) => name.includes('.tmp'))).toEqual([]);
    expect(names.sort()).toEqual(['autosave.json', 'autosave.prev.json', 'profile.json']);
  });
});

describe('summaryOf', () => {
  it('is the envelope minus the file', () => {
    const written = store.write('yc', 'autosave', saveFile());
    expect(written.ok).toBe(true);
    if (!written.ok) return;
    const summary = summaryOf(written.envelope);
    expect(summary).not.toHaveProperty('file');
    expect(summary.revision).toBe(written.envelope.revision);
    expect(summary.byteLength).toBe(written.envelope.byteLength);
  });
});
