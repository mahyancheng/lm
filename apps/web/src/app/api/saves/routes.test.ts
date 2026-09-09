/**
 * The `/api/saves` routes.
 *
 * What must never regress:
 *
 * 1. **Off means off.** With no `SAVE_DIR`, the listing says `enabled: false`
 *    and every other verb answers 404 — the client stays on `localStorage`.
 * 2. **A forged write is refused before anything is read.** No cookie, no
 *    parse, no disk.
 * 3. **The size ceiling holds** on a lying `content-length` as well as an
 *    honest one.
 * 4. **A 409 hands back the server's summary and never the file**, and the
 *    stored save is untouched.
 * 5. **An older save never silently replaces a newer one.**
 * 6. **A malformed profile or slot never reaches the disk.**
 *
 * Requests are ordinary `Request` objects and the route params are the promise
 * Next hands a handler — no server, no fetch, no network.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_SAVE_BYTES } from '@/lib/saves/store';
import { resetSaveLimiters } from './_shared';
import { GET as listProfiles } from './profiles/route';
import { GET as getProfile } from './[profile]/route';
import { DELETE as deleteSlot, GET as getSlot, PUT as putSlot } from './[profile]/[slot]/route';

const ORIGIN = 'http://pi.local:8110';

function saveFile(options: { savedQuarter?: number; savedAtIso?: string; padding?: string } = {}): Record<string, unknown> {
  return {
    version: 5,
    seed: 424242,
    difficulty: 'standard',
    autoExecuteRoutine: false,
    setup: {
      companyName: 'Acme AI',
      founderName: 'Dana Vale',
      backgroundId: 'consumer_ai',
      sector: 'ai',
      region: 'north_america',
      worldVersion: 3,
    },
    worldVersion: 3,
    log: [],
    checkpoint: null,
    savedQuarter: options.savedQuarter ?? 4,
    queue: [],
    savedAtIso: options.savedAtIso ?? '2027-01-01T00:00:00.000Z',
    ...(options.padding === undefined ? {} : { padding: options.padding }),
  };
}

function params<T extends Record<string, string>>(value: T): { params: Promise<T> } {
  return { params: Promise.resolve(value) };
}

/** A same-origin request, as this app's own page sends it. */
function request(path: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  headers.set('host', 'pi.local:8110');
  if (!headers.has('sec-fetch-site')) headers.set('sec-fetch-site', 'same-origin');
  return new Request(`${ORIGIN}${path}`, { ...init, headers });
}

function put(path: string, body: unknown, extra: Record<string, string> = {}): Request {
  return request(path, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', ...extra },
    body: JSON.stringify(body),
  });
}

async function bodyOf(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

let root: string;
const previousSaveDir = process.env.SAVE_DIR;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'frontier-saves-routes-'));
  process.env.SAVE_DIR = root;
  resetSaveLimiters();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  if (previousSaveDir === undefined) delete process.env.SAVE_DIR;
  else process.env.SAVE_DIR = previousSaveDir;
});

/* -------------------------------------------------------------------------- */
/*  Off by default                                                             */
/* -------------------------------------------------------------------------- */

describe('with no SAVE_DIR', () => {
  beforeEach(() => {
    delete process.env.SAVE_DIR;
  });

  it('says so on the listing and 404s everywhere else', async () => {
    const listing = await listProfiles(request('/api/saves/profiles'));
    expect(listing.status).toBe(200);
    expect(await bodyOf(listing)).toEqual({ ok: true, enabled: false, profiles: [] });

    const profile = await getProfile(request('/api/saves/yc'), params({ profile: 'yc' }));
    expect(profile.status).toBe(404);
    expect(await bodyOf(profile)).toEqual({ ok: false, reason: 'saves_disabled' });

    const slot = await getSlot(request('/api/saves/yc/autosave'), params({ profile: 'yc', slot: 'autosave' }));
    expect(slot.status).toBe(404);

    const written = await putSlot(put('/api/saves/yc/autosave', { file: saveFile() }), params({ profile: 'yc', slot: 'autosave' }));
    expect(written.status).toBe(404);
    expect(await bodyOf(written)).toEqual({ ok: false, reason: 'saves_disabled' });
  });
});

/* -------------------------------------------------------------------------- */
/*  The happy path                                                             */
/* -------------------------------------------------------------------------- */

describe('storing and reading a save', () => {
  it('accepts a PUT, hands back the envelope, and reads it back verbatim', async () => {
    const file = saveFile({ savedQuarter: 4 });
    const written = await putSlot(
      put('/api/saves/yc/autosave', { file, displayName: 'YC' }),
      params({ profile: 'yc', slot: 'autosave' }),
    );
    expect(written.status).toBe(200);
    const envelope = (await bodyOf(written)).envelope as Record<string, unknown>;
    expect(envelope.profile).toBe('yc');
    expect(envelope.slot).toBe('autosave');
    expect(envelope.revision).toBe(1);
    expect(envelope.savedQuarter).toBe(4);
    expect(envelope.savedAtIso).toBe('2027-01-01T00:00:00.000Z');
    expect(envelope.companyName).toBe('Acme AI');
    expect(envelope.byteLength).toBe(Buffer.byteLength(JSON.stringify(file), 'utf8'));
    expect(envelope.file).toEqual(file);
    expect(written.headers.get('cache-control')).toContain('no-store');

    const read = await getSlot(request('/api/saves/yc/autosave'), params({ profile: 'yc', slot: 'autosave' }));
    expect(read.status).toBe(200);
    expect(((await bodyOf(read)).envelope as Record<string, unknown>).file).toEqual(file);
  });

  it('lists the profile and its four slots, never the files', async () => {
    await putSlot(put('/api/saves/yc/2', { file: saveFile({ savedQuarter: 9 }), displayName: 'YC' }), params({ profile: 'yc', slot: '2' }));

    const listing = await bodyOf(await listProfiles(request('/api/saves/profiles')));
    expect(listing.enabled).toBe(true);
    const profiles = listing.profiles as { profile: string; displayName: string; slots: Record<string, unknown>[] }[];
    expect(profiles).toHaveLength(1);
    expect(profiles[0]?.profile).toBe('yc');
    expect(profiles[0]?.displayName).toBe('YC');
    expect(profiles[0]?.slots).toHaveLength(4);
    expect(profiles[0]?.slots.some((slot) => 'file' in slot)).toBe(false);

    const one = await bodyOf(await getProfile(request('/api/saves/yc'), params({ profile: 'yc' })));
    expect(one.exists).toBe(true);
    expect((one.slots as { slot: string; savedQuarter: number | null }[])[2]).toMatchObject({ slot: '2', savedQuarter: 9 });
  });

  it('answers 200 with four empty slots for a profile nobody has used yet', async () => {
    const response = await getProfile(request('/api/saves/nobody'), params({ profile: 'nobody' }));
    expect(response.status).toBe(200);
    const body = await bodyOf(response);
    expect(body.exists).toBe(false);
    expect((body.slots as { slot: string; revision: number }[]).map((slot) => slot.slot)).toEqual(['autosave', '1', '2', '3']);
    expect((body.slots as { revision: number }[])[0]?.revision).toBe(0);
  });

  it('404s a slot that has never been written', async () => {
    const response = await getSlot(request('/api/saves/yc/1'), params({ profile: 'yc', slot: '1' }));
    expect(response.status).toBe(404);
    expect(await bodyOf(response)).toEqual({ ok: false, reason: 'no_save' });
  });

  it('deletes a slot, keeps saying yes, and reports whether anything was there', async () => {
    await putSlot(put('/api/saves/yc/3', { file: saveFile() }), params({ profile: 'yc', slot: '3' }));
    const first = await deleteSlot(request('/api/saves/yc/3', { method: 'DELETE' }), params({ profile: 'yc', slot: '3' }));
    expect(first.status).toBe(200);
    expect(await bodyOf(first)).toEqual({ ok: true, deleted: true });

    const again = await deleteSlot(request('/api/saves/yc/3', { method: 'DELETE' }), params({ profile: 'yc', slot: '3' }));
    expect(await bodyOf(again)).toEqual({ ok: true, deleted: false });
  });
});

/* -------------------------------------------------------------------------- */
/*  Forgery, names and bodies                                                  */
/* -------------------------------------------------------------------------- */

describe('what a write refuses', () => {
  it('refuses a cross-site PUT and DELETE before the body is read', async () => {
    const forged = new Request(`${ORIGIN}/api/saves/yc/autosave`, {
      method: 'PUT',
      headers: { host: 'pi.local:8110', 'sec-fetch-site': 'cross-site', 'content-type': 'application/json' },
      body: JSON.stringify({ file: saveFile() }),
    });
    const response = await putSlot(forged, params({ profile: 'yc', slot: 'autosave' }));
    expect(response.status).toBe(403);
    expect(await bodyOf(response)).toEqual({ ok: false, reason: 'cross_site' });
    // Nothing was stored.
    expect((await getSlot(request('/api/saves/yc/autosave'), params({ profile: 'yc', slot: 'autosave' }))).status).toBe(404);

    const mismatched = new Request(`${ORIGIN}/api/saves/yc/autosave`, {
      method: 'DELETE',
      headers: { host: 'pi.local:8110', origin: 'https://evil.example' },
    });
    expect((await deleteSlot(mismatched, params({ profile: 'yc', slot: 'autosave' }))).status).toBe(403);
  });

  it('refuses a PUT that is not JSON', async () => {
    const formish = new Request(`${ORIGIN}/api/saves/yc/autosave`, {
      method: 'PUT',
      headers: { host: 'pi.local:8110', 'sec-fetch-site': 'same-origin', 'content-type': 'text/plain' },
      body: 'file=1',
    });
    const response = await putSlot(formish, params({ profile: 'yc', slot: 'autosave' }));
    expect(response.status).toBe(403);
    expect(await bodyOf(response)).toEqual({ ok: false, reason: 'unsupported_media_type' });
  });

  it('refuses a malformed profile or slot without touching the disk', async () => {
    const badProfile = await putSlot(put('/api/saves/..%2Fetc/autosave', { file: saveFile() }), params({ profile: '../etc', slot: 'autosave' }));
    expect(badProfile.status).toBe(400);
    expect(await bodyOf(badProfile)).toEqual({ ok: false, reason: 'invalid_profile' });

    const badSlot = await putSlot(put('/api/saves/yc/9', { file: saveFile() }), params({ profile: 'yc', slot: '9' }));
    expect(badSlot.status).toBe(400);
    expect(await bodyOf(badSlot)).toEqual({ ok: false, reason: 'invalid_slot' });

    // `profiles` is the listing route, so it can never be a profile.
    const reserved = await getProfile(request('/api/saves/profiles'), params({ profile: 'profiles' }));
    expect(reserved.status).toBe(400);
  });

  it('refuses a body that is not an object, has no file, or has a nonsense ifRevision', async () => {
    const cases: [unknown, string][] = [
      [[], 'invalid_body'],
      ['nope', 'invalid_body'],
      [{ ifRevision: 1 }, 'missing_file'],
      [{ file: saveFile(), ifRevision: -1 }, 'invalid_if_revision'],
      [{ file: saveFile(), ifRevision: 'one' }, 'invalid_if_revision'],
    ];
    for (const [body, reason] of cases) {
      const response = await putSlot(put('/api/saves/yc/autosave', body), params({ profile: 'yc', slot: 'autosave' }));
      expect(response.status).toBe(400);
      expect((await bodyOf(response)).reason).toBe(reason);
    }
  });

  it('refuses a save file this build cannot read', async () => {
    const response = await putSlot(put('/api/saves/yc/autosave', { file: { version: 99 } }), params({ profile: 'yc', slot: 'autosave' }));
    expect(response.status).toBe(400);
    expect(await bodyOf(response)).toEqual({ ok: false, reason: 'unsupported_save' });
  });

  it('refuses a body over the ceiling on the declared length and on a lying one', async () => {
    const honest = put('/api/saves/yc/autosave', { file: saveFile({ padding: 'x'.repeat(MAX_SAVE_BYTES) }) });
    const declared = await putSlot(honest, params({ profile: 'yc', slot: 'autosave' }));
    expect(declared.status).toBe(413);
    expect(await bodyOf(declared)).toEqual({ ok: false, reason: 'save_too_large' });

    // A body that understates its own length is metered as it streams.
    const lying = new Request(`${ORIGIN}/api/saves/yc/autosave`, {
      method: 'PUT',
      headers: { host: 'pi.local:8110', 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', 'content-length': '12' },
      body: JSON.stringify({ file: saveFile({ padding: 'x'.repeat(MAX_SAVE_BYTES) }) }),
    });
    const streamed = await putSlot(lying, params({ profile: 'yc', slot: 'autosave' }));
    expect(streamed.status).toBe(413);
    expect((await getSlot(request('/api/saves/yc/autosave'), params({ profile: 'yc', slot: 'autosave' }))).status).toBe(404);
  });
});

/* -------------------------------------------------------------------------- */
/*  Conflicts                                                                  */
/* -------------------------------------------------------------------------- */

describe('conflicts', () => {
  it('409s a stale ifRevision with the current summary, file withheld, save untouched', async () => {
    await putSlot(put('/api/saves/yc/autosave', { file: saveFile({ savedQuarter: 6 }) }), params({ profile: 'yc', slot: 'autosave' }));
    const stale = await putSlot(
      put('/api/saves/yc/autosave', { file: saveFile({ savedQuarter: 7 }), ifRevision: 0 }),
      params({ profile: 'yc', slot: 'autosave' }),
    );
    expect(stale.status).toBe(409);
    const body = await bodyOf(stale);
    expect(body.reason).toBe('stale_revision');
    const current = body.current as Record<string, unknown>;
    expect(current.revision).toBe(1);
    expect(current.savedQuarter).toBe(6);
    expect(current).not.toHaveProperty('file');

    const read = await bodyOf(await getSlot(request('/api/saves/yc/autosave'), params({ profile: 'yc', slot: 'autosave' })));
    expect((read.envelope as { savedQuarter: number }).savedQuarter).toBe(6);
  });

  it('accepts the re-send once the client has reconciled', async () => {
    await putSlot(put('/api/saves/yc/autosave', { file: saveFile({ savedQuarter: 6 }) }), params({ profile: 'yc', slot: 'autosave' }));
    const resent = await putSlot(
      put('/api/saves/yc/autosave', { file: saveFile({ savedQuarter: 7 }), ifRevision: 1 }),
      params({ profile: 'yc', slot: 'autosave' }),
    );
    expect(resent.status).toBe(200);
    expect(((await bodyOf(resent)).envelope as { revision: number }).revision).toBe(2);
  });

  it('409s an unconditional write of an older save', async () => {
    await putSlot(put('/api/saves/yc/autosave', { file: saveFile({ savedQuarter: 8 }) }), params({ profile: 'yc', slot: 'autosave' }));
    const older = await putSlot(
      put('/api/saves/yc/autosave', { file: saveFile({ savedQuarter: 3, savedAtIso: '2030-01-01T00:00:00.000Z' }) }),
      params({ profile: 'yc', slot: 'autosave' }),
    );
    expect(older.status).toBe(409);
    const body = await bodyOf(older);
    expect(body.reason).toBe('older_save');
    expect((body.current as { savedQuarter: number }).savedQuarter).toBe(8);
  });
});
