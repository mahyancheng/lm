/** Server-owned lifecycle for the one shared managed Codex / ChatGPT login. */

import { accessSync, constants, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { getCodexLoginManager, type CodexLoginManager, type CodexLoginStatus } from '@frontier/llm';
import type { Principal } from './_identity';
import { processSingleton } from './_runtime';
import { invalidateGatewayForManagedCodexAuth } from './_gateway';

export type PublicCodexLoginState = 'pending' | 'connected' | 'expired' | 'cancelled' | 'error';

interface OwnedLogin {
  readonly loginId: string;
  readonly actor: string;
  active: boolean;
  terminal: Exclude<PublicCodexLoginState, 'pending' | 'connected'> | null;
}

interface LoginStore {
  owned: OwnedLogin | null;
  /** Reservation is set before awaiting the app-server, closing a two-POST race. */
  starting: { readonly actor: string; readonly result: Promise<StartLoginResult> } | null;
}
const LOGIN_STORE_KEY = 'llm.managedCodexLoginOwnership';
function store(): LoginStore {
  return processSingleton<LoginStore>(LOGIN_STORE_KEY, () => ({ owned: null, starting: null }));
}

function actorFor(principal: Principal): string {
  return `${principal.kind}:${principal.id}`;
}

/** Make the dedicated paths when a new volume is attached, as the app user. */
function prepareCodexHome(env: Readonly<Record<string, string | undefined>> = process.env): string | null {
  const home = env['CODEX_HOME']?.trim();
  if (home === undefined || home.length === 0) return 'Managed Codex storage is not configured.';
  const workdir = env['CODEX_WORKDIR']?.trim() || join(home, 'workspace');
  try {
    mkdirSync(home, { recursive: true, mode: 0o700 });
    mkdirSync(workdir, { recursive: true, mode: 0o700 });
    accessSync(home, constants.R_OK | constants.W_OK | constants.X_OK);
    accessSync(workdir, constants.R_OK | constants.W_OK | constants.X_OK);
    return null;
  } catch {
    return 'Managed Codex storage is not writable by the app service.';
  }
}

export function codexLoginManager(): CodexLoginManager {
  return processSingleton<CodexLoginManager>('llm.managedCodexLoginManager', () => getCodexLoginManager({
    env: process.env,
    command: process.env['CODEX_COMMAND'],
    codexHome: process.env['CODEX_HOME'],
    cwd: process.env['CODEX_WORKDIR']?.trim() || (process.env['CODEX_HOME']?.trim() ? join(process.env['CODEX_HOME'].trim(), 'workspace') : undefined),
    onAccountChanged: invalidateGatewayForManagedCodexAuth,
  }));
}

/** Reconcile an event/expiry that happened after the previous browser poll. */
function reconcileOwned(): void {
  const owned = store().owned;
  if (owned === null || !owned.active) return;
  const status = codexLoginManager().status();
  if (status.state === 'waiting' && status.login.loginId === owned.loginId) return;
  owned.active = false;
  if (status.state === 'expired') owned.terminal = 'expired';
  else if (status.state === 'signedIn') owned.terminal = null;
  else if (status.state === 'signedOut') owned.terminal = 'cancelled';
  else owned.terminal = 'error';
}

function terminalState(status: CodexLoginStatus): PublicCodexLoginState {
  const owned = store().owned;
  if (owned?.terminal !== null && owned !== null) return owned.terminal;
  if (status.state === 'waiting') return 'pending';
  if (status.state === 'signedIn') return 'connected';
  return 'error';
}

/** Polling only returns cached lifecycle state; it never opens an auth process. */
export function loginStatusFor(principal: Principal, loginId: string): { readonly state: PublicCodexLoginState; readonly error?: string } {
  const owned = store().owned;
  if (owned === null || owned.loginId !== loginId || owned.actor !== actorFor(principal)) return { state: 'error', error: 'This sign-in attempt is not available to this browser.' };
  reconcileOwned();
  const status = codexLoginManager().status();
  const state = terminalState(status);
  return state === 'error' ? { state, error: status.state === 'failed' || status.state === 'unavailable' ? status.error : 'ChatGPT sign-in did not complete.' } : { state };
}

export type StartLoginResult =
  | { readonly ok: true; readonly loginId: string; readonly userCode: string; readonly verificationUrl: string; readonly expiresAt: string }
  | { readonly ok: false; readonly reason: 'login_in_progress' | 'already_connected' | 'storage_unavailable' | 'codex_configuration_invalid' | 'codex_executable_unavailable' | 'codex_initialization_failed' | 'device_auth_unavailable' | 'provider_unavailable' | 'account_verification_failed' | 'codex_start_failed' };

export async function startLoginFor(principal: Principal): Promise<StartLoginResult> {
  const storageError = prepareCodexHome();
  if (storageError !== null) return { ok: false, reason: 'storage_unavailable' };
  const actor = actorFor(principal);
  const held = store();
  reconcileOwned();
  const owned = held.owned;
  if (owned !== null && owned.active && owned.actor !== actor) return { ok: false, reason: 'login_in_progress' };
  if (held.starting !== null) return held.starting.actor === actor ? held.starting.result : { ok: false, reason: 'login_in_progress' };

  const result = (async (): Promise<StartLoginResult> => {
    let status: CodexLoginStatus;
    try { status = await codexLoginManager().start(); }
    catch { return { ok: false, reason: 'codex_start_failed' }; }
    if (status.state === 'signedIn') return { ok: false, reason: 'already_connected' };
    if (status.state !== 'waiting') return { ok: false, reason: status.state === 'unavailable' ? status.errorCode : 'codex_start_failed' };
    held.owned = { loginId: status.login.loginId, actor, active: true, terminal: null };
    return { ok: true, loginId: status.login.loginId, userCode: status.login.userCode, verificationUrl: status.login.verificationUrl, expiresAt: new Date(status.login.expiresAtMs).toISOString() };
  })();
  held.starting = { actor, result };
  try { return await result; }
  finally { if (held.starting?.result === result) held.starting = null; }
}

export async function cancelLoginFor(principal: Principal, loginId: string): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: 'login_not_found' | 'forbidden' }> {
  const owned = store().owned;
  if (owned === null || owned.loginId !== loginId) return { ok: false, reason: 'login_not_found' };
  if (owned.actor !== actorFor(principal)) return { ok: false, reason: 'forbidden' };
  const status = await codexLoginManager().cancel(loginId);
  if (status.state === 'signedIn') {
    owned.active = false;
    owned.terminal = null;
    return { ok: false, reason: 'login_not_found' };
  }
  owned.active = false;
  owned.terminal = status.state === 'expired' ? 'expired' : 'cancelled';
  return { ok: true };
}

/** Health is allowed to perform the explicit read-only account truth check. */
export async function refreshCodexAccount(): Promise<CodexLoginStatus> {
  const storageError = prepareCodexHome();
  if (storageError !== null) return { state: 'unavailable', cliAvailable: false, signedIn: false, error: storageError, errorCode: 'storage_unavailable' };
  try { return await codexLoginManager().refreshAccount(); }
  catch { return { state: 'unavailable', cliAvailable: false, signedIn: false, error: 'Codex app-server could not initialize.', errorCode: 'codex_initialization_failed' }; }
}

export async function logoutCodex(): Promise<CodexLoginStatus> {
  const result = await codexLoginManager().logout();
  const owned = store().owned;
  if (owned !== null && owned.active) { owned.active = false; owned.terminal = 'cancelled'; }
  return result;
}

/** Test seam. */
export function resetCodexLoginOwnership(): void { store().owned = null; store().starting = null; }
