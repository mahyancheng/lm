/**
 * The persisted credential.
 *
 * What must never regress:
 *
 * 1. **Off by default where it is unsafe.** No `LLM_KEY_SECRET`, or a
 *    serverless host, means no file — ever.
 * 2. **Sealed.** The file never contains the credential in the clear, and
 *    opens only under the secret that sealed it; a wrong key or a flipped byte
 *    answers null rather than garbage.
 * 3. **Owner-only.** Directory 0700, file 0600.
 * 4. **The store round-trips.** A credential set in one "process" is what a
 *    fresh store restores, and a clear removes the file too.
 */

import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CREDENTIAL_FILE_NAME,
  clearCredentialFile,
  loadCredentialFile,
  openCredential,
  persistLocation,
  saveCredentialFile,
  sealCredential,
} from './_persist';
import {
  clearRuntimeCredential,
  resetRuntimeCredential,
  restoreRuntimeCredential,
  runtimeCredentialDescriptor,
  setRuntimeCredential,
} from './_runtime';

const SECRET = 'bdbb0341-test-secret-0000000000000000000000000000000000000000';
const OAUTH = 'sk-ant-oat01-ABCDEFGHIJKLMNOPQRSTUVWXYZ-0123456789-wxyz';
const at = (): string => '2027-01-01T00:00:00.000Z';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'frontier-persist-'));
  resetRuntimeCredential();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('persistLocation', () => {
  it('is off without a key secret', () => {
    expect(persistLocation({ LLM_STATE_DIR: dir }, () => '/nowhere')).toBeNull();
  });

  it('is off on a serverless host even with a secret', () => {
    expect(persistLocation({ LLM_KEY_SECRET: SECRET, VERCEL: '1', LLM_STATE_DIR: dir }, () => '/nowhere')).toBeNull();
  });

  it('prefers LLM_STATE_DIR, then the Agent SDK config dir, then the home directory', () => {
    expect(persistLocation({ LLM_KEY_SECRET: SECRET, LLM_STATE_DIR: '/state', CLAUDE_CONFIG_DIR: '/cfg' }, () => '/home/x')?.dir).toBe('/state');
    expect(persistLocation({ LLM_KEY_SECRET: SECRET, CLAUDE_CONFIG_DIR: '/cfg' }, () => '/home/x')?.dir).toBe(join('/cfg', 'frontier-capital'));
    expect(persistLocation({ LLM_KEY_SECRET: SECRET }, () => '/home/x')?.dir).toBe(join('/home/x', '.frontier-capital'));
    expect(persistLocation({ LLM_KEY_SECRET: SECRET }, () => '/home/x')?.file.endsWith(CREDENTIAL_FILE_NAME)).toBe(true);
  });
});

describe('sealing', () => {
  it('round-trips under the same secret and never stores the value in the clear', () => {
    const sealed = sealCredential({ value: OAUTH, setAt: at() }, SECRET);
    expect(sealed).not.toContain(OAUTH);
    expect(sealed).not.toContain('wxyz');
    expect(openCredential(sealed, SECRET)).toEqual({ value: OAUTH, setAt: at() });
  });

  it('fails closed under the wrong secret, on a tampered byte, and on foreign JSON', () => {
    const sealed = sealCredential({ value: OAUTH, setAt: at() }, SECRET);
    expect(openCredential(sealed, SECRET + 'x')).toBeNull();
    const parsed = JSON.parse(sealed) as { data: string };
    const bytes = Buffer.from(parsed.data, 'base64');
    bytes[0] = bytes[0] === 0 ? 1 : 0;
    expect(openCredential(JSON.stringify({ ...parsed, data: bytes.toString('base64') }), SECRET)).toBeNull();
    expect(openCredential('{"version":1}', SECRET)).toBeNull();
    expect(openCredential('not json', SECRET)).toBeNull();
    expect(openCredential(JSON.stringify({ ...parsed, version: 99 }), SECRET)).toBeNull();
  });
});

describe('the file', () => {
  it('saves owner-only, loads back, and clears', () => {
    const location = persistLocation({ LLM_KEY_SECRET: SECRET, LLM_STATE_DIR: join(dir, 'nested') }, () => dir);
    expect(location).not.toBeNull();
    if (location === null) return;

    expect(saveCredentialFile(location, { value: OAUTH, setAt: at() }, SECRET)).toBe(true);
    expect(statSync(location.dir).mode & 0o777).toBe(0o700);
    expect(statSync(location.file).mode & 0o777).toBe(0o600);
    expect(readFileSync(location.file, 'utf8')).not.toContain(OAUTH);
    expect(loadCredentialFile(location, SECRET)).toEqual({ value: OAUTH, setAt: at() });
    expect(loadCredentialFile(location, 'other')).toBeNull();

    expect(clearCredentialFile(location)).toBe(true);
    expect(loadCredentialFile(location, SECRET)).toBeNull();
    // Absent is success.
    expect(clearCredentialFile(location)).toBe(true);
  });

  it('answers null for a missing file and false for an unwritable directory', () => {
    const location = { dir: join(dir, 'missing'), file: join(dir, 'missing', CREDENTIAL_FILE_NAME) };
    expect(loadCredentialFile(location, SECRET)).toBeNull();
    const blocked = { dir: join(dir, 'file-not-dir'), file: join(dir, 'file-not-dir', CREDENTIAL_FILE_NAME) };
    // A regular file where the directory should be makes mkdir fail.
    saveCredentialFile({ dir, file: join(dir, 'file-not-dir') }, { value: OAUTH, setAt: at() }, SECRET);
    expect(saveCredentialFile(blocked, { value: OAUTH, setAt: at() }, SECRET)).toBe(false);
  });
});

describe('the store, across a restart', () => {
  it('persists on set, restores into an empty store, and clears the file on disconnect', () => {
    const env = { LLM_KEY_SECRET: SECRET, LLM_STATE_DIR: dir };
    setRuntimeCredential(OAUTH, { now: at, env });
    const location = persistLocation(env, () => dir);
    expect(location).not.toBeNull();
    if (location === null) return;
    expect(loadCredentialFile(location, SECRET)?.value).toBe(OAUTH);

    // A new process: empty store, first read consults the disk.
    resetRuntimeCredential();
    expect(runtimeCredentialDescriptor()).toBeNull();
    // A reset marks the store as already restored so suites stay hermetic —
    // so after one, a restore is a no-op even with the file present.
    expect(restoreRuntimeCredential(env)).toBe(false);
    // A real boot has not restored yet; that is what clearing the flag models.
    resetStoreForRestore();
    expect(restoreRuntimeCredential(env)).toBe(true);
    expect(runtimeCredentialDescriptor()).toEqual({ kind: 'oauth', masked: '…wxyz', setAt: at() });

    expect(clearRuntimeCredential(env)).toBe(true);
    expect(loadCredentialFile(location, SECRET)).toBeNull();
  });

  it('never writes without a secret', () => {
    setRuntimeCredential(OAUTH, { now: at, env: { LLM_STATE_DIR: dir } });
    expect(() => statSync(join(dir, CREDENTIAL_FILE_NAME))).toThrow();
  });

  it('does not let a stale file outrank a credential set in this process', () => {
    const env = { LLM_KEY_SECRET: SECRET, LLM_STATE_DIR: dir };
    const location = persistLocation(env, () => dir);
    if (location === null) throw new Error('location');
    saveCredentialFile(location, { value: OAUTH, setAt: '2026-01-01T00:00:00.000Z' }, SECRET);
    resetStoreForRestore();
    setRuntimeCredential('sk-ant-oat01-NEWTOKENNEWTOKENNEWTOKEN-0123456789-abcd', { now: at, env });
    expect(runtimeCredentialDescriptor()?.masked).toBe('…abcd');
    expect(loadCredentialFile(location, SECRET)?.value.endsWith('abcd')).toBe(true);
  });
});

/**
 * The store is a process singleton whose `restored` flag is set by a reset so
 * suites stay hermetic; a "fresh process" is modelled by clearing that flag
 * through the one seam the module exposes for it.
 */
function resetStoreForRestore(): void {
  resetRuntimeCredential();
  const host = globalThis as unknown as Record<symbol, { restored: boolean } | undefined>;
  const slot = host[Symbol.for('frontier.llm.runtimeCredentialStore')];
  if (slot !== undefined) slot.restored = false;
}
