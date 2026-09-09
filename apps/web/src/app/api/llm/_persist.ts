/**
 * The runtime Claude credential, kept across restarts.
 *
 * `_runtime.ts` holds the pasted or OAuth-issued credential in process memory,
 * which is exactly right for a serverless deployment (no disk, one lambda per
 * request) and exactly wrong for an always-on host: every container restart
 * on the Pi, every `systemctl restart` on a VPS, sent the player back through
 * Settings → AI → Connect. This module writes the credential to disk so the
 * connection survives — and only under conditions where that is safe:
 *
 * - **Encrypted at rest**, AES-256-GCM under a key derived from
 *   `LLM_KEY_SECRET`. Without that secret there is nothing to protect the file
 *   with, so persistence is simply off; a per-process random key (what
 *   `_identity.ts` falls back to) would produce a file no restart could read.
 * - **Never on serverless.** `VERCEL` set means no durable disk and many
 *   instances; the file would be a lie.
 * - **Fail closed.** A wrong key, a tampered ciphertext, an unreadable file or
 *   a refused write all answer "nothing persisted" — the in-memory store is
 *   unaffected and the player is asked to connect again, which is the state
 *   they would have been in without this module.
 *
 * Where the file lives, in precedence order: `LLM_STATE_DIR`; else
 * `frontier-capital/` under `CLAUDE_CONFIG_DIR` (the Agent SDK's own state
 * directory — on the Pi that is the one persistent volume); else
 * `~/.frontier-capital`. The Pi image sets the variable explicitly, the VPS
 * installer points it at /var/lib.
 *
 * Every function takes its environment and clock as parameters so the tests
 * never touch the real home directory or the wall clock.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export type PersistEnv = Readonly<Record<string, string | undefined>>;

/** The file name is stable so an operator can find, back up or delete it. */
export const CREDENTIAL_FILE_NAME = 'credential.enc.json';

/** Bumped only if the on-disk shape changes; an unknown version fails closed. */
const FILE_VERSION = 1;

export interface PersistLocation {
  readonly dir: string;
  readonly file: string;
}

function hasValue(value: string | undefined): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Where the credential file would live, or null when persistence is off for
 * this process: no secret to encrypt under, or a serverless host.
 */
export function persistLocation(env: PersistEnv = process.env, home: () => string = homedir): PersistLocation | null {
  if (hasValue(env['VERCEL'])) return null;
  if (!hasValue(env['LLM_KEY_SECRET'])) return null;
  const dir = hasValue(env['LLM_STATE_DIR'])
    ? env['LLM_STATE_DIR'].trim()
    : hasValue(env['CLAUDE_CONFIG_DIR'])
      ? join(env['CLAUDE_CONFIG_DIR'].trim(), 'frontier-capital')
      : join(home(), '.frontier-capital');
  return { dir, file: join(dir, CREDENTIAL_FILE_NAME) };
}

/* -------------------------------------------------------------------------- */
/*  Encryption                                                                 */
/* -------------------------------------------------------------------------- */

/** What is sealed inside the file. `setAt` is diagnostic, carried so the descriptor survives too. */
export interface PersistedCredential {
  readonly value: string;
  readonly setAt: string;
}

interface SealedFile {
  readonly version: number;
  readonly algorithm: 'aes-256-gcm';
  readonly iv: string;
  readonly tag: string;
  readonly data: string;
}

/** A 32-byte key from the operator's secret. SHA-256, not a KDF with a salt: the secret is already high-entropy and random per deployment. */
function keyFrom(secret: string): Buffer {
  return createHash('sha256').update(secret.trim(), 'utf8').digest();
}

export function sealCredential(record: PersistedCredential, secret: string, iv: Buffer = randomBytes(12)): string {
  const cipher = createCipheriv('aes-256-gcm', keyFrom(secret), iv);
  const plain = Buffer.from(JSON.stringify(record), 'utf8');
  const data = Buffer.concat([cipher.update(plain), cipher.final()]);
  const sealed: SealedFile = {
    version: FILE_VERSION,
    algorithm: 'aes-256-gcm',
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  };
  return JSON.stringify(sealed);
}

/** The record, or null for anything that is not a file this build sealed under this secret. */
export function openCredential(text: string, secret: string): PersistedCredential | null {
  let sealed: Partial<SealedFile>;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed === null || typeof parsed !== 'object') return null;
    sealed = parsed as Partial<SealedFile>;
  } catch {
    return null;
  }
  if (sealed.version !== FILE_VERSION || sealed.algorithm !== 'aes-256-gcm') return null;
  if (typeof sealed.iv !== 'string' || typeof sealed.tag !== 'string' || typeof sealed.data !== 'string') return null;
  try {
    const decipher = createDecipheriv('aes-256-gcm', keyFrom(secret), Buffer.from(sealed.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));
    const plain = Buffer.concat([decipher.update(Buffer.from(sealed.data, 'base64')), decipher.final()]).toString('utf8');
    const record = JSON.parse(plain) as Partial<PersistedCredential>;
    if (typeof record.value !== 'string' || record.value.length === 0) return null;
    return { value: record.value, setAt: typeof record.setAt === 'string' ? record.setAt : '' };
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/*  The file                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Write the sealed credential. Owner-only permissions on both the directory
 * and the file, and a rename from a temp file so a crash mid-write leaves the
 * previous file rather than a torn one. Returns whether it landed.
 */
export function saveCredentialFile(location: PersistLocation, record: PersistedCredential, secret: string): boolean {
  try {
    mkdirSync(location.dir, { recursive: true, mode: 0o700 });
    const temp = join(dirname(location.file), `.${CREDENTIAL_FILE_NAME}.${process.pid}.tmp`);
    writeFileSync(temp, sealCredential(record, secret), { encoding: 'utf8', mode: 0o600 });
    chmodSync(temp, 0o600);
    renameSync(temp, location.file);
    return true;
  } catch {
    return false;
  }
}

/** The sealed record, or null when there is no file, it cannot be read, or it does not open under this secret. */
export function loadCredentialFile(location: PersistLocation, secret: string): PersistedCredential | null {
  try {
    if (!statSync(location.file).isFile()) return null;
    return openCredential(readFileSync(location.file, 'utf8'), secret);
  } catch {
    return null;
  }
}

/** Remove the file. Absent is success. */
export function clearCredentialFile(location: PersistLocation): boolean {
  try {
    rmSync(location.file, { force: true });
    return true;
  } catch {
    return false;
  }
}
