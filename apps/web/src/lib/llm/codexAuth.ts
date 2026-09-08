/** Client contract for the managed Codex / ChatGPT device login. */

import { getSetupSecret } from './token';

export type CodexLoginState = 'pending' | 'connected' | 'expired' | 'cancelled' | 'error';

export interface CodexLoginStart {
  readonly ok: true;
  readonly loginId: string;
  readonly userCode: string;
  readonly verificationUrl: string;
  readonly expiresAt: string;
}

export interface CodexLoginStatus {
  readonly state: CodexLoginState;
  readonly error?: string;
}

export interface CodexLoginCancel { readonly ok: true }

/** A refusal can carry a bounded server-requested cooldown. */
export type CodexLoginFetch<T> =
  | { readonly kind: 'ok'; readonly value: T }
  | { readonly kind: 'unreachable' }
  | { readonly kind: 'refused'; readonly status: number; readonly reason: string; readonly retryAfterSeconds?: number };

/** Local terminal events outrank a health response already in flight. */
export function codexEffectiveReady(healthReady: boolean, state: CodexLoginState | null): boolean {
  if (state === 'connected') return true;
  if (state === 'cancelled') return false;
  return healthReady;
}

/**
 * Guards async drawer work against completing after cancel, retry, or unmount.
 * Each operation owns a generation; beginning another operation or disposing
 * the drawer makes every callback from the older generation inert.
 */
export interface CodexLoginLifecycle {
  begin(): number;
  current(generation: number): boolean;
  dispose(): void;
}

export function createCodexLoginLifecycle(): CodexLoginLifecycle {
  let generation = 0;
  let disposed = false;
  return {
    begin(): number { disposed = false; generation += 1; return generation; },
    current(candidate: number): boolean { return !disposed && candidate === generation; },
    dispose(): void { disposed = true; generation += 1; },
  };
}

/** Only backend codes deliberately safe for an account-connection screen. */
const SAFE_START_FAILURES = new Set([
  'storage_unavailable',
  'codex_configuration_invalid',
  'codex_executable_unavailable',
  'codex_initialization_failed',
  'device_auth_unavailable',
  'provider_unavailable',
  'account_verification_failed',
  'codex_start_failed',
]);

export function codexLoginFailureLine(reason: string): string {
  if (reason === 'setup_secret_required') return 'Enter the setup secret for this deployment to connect ChatGPT.';
  if (reason === 'setup_disabled') return 'ChatGPT connections are disabled for this deployment.';
  if (reason === 'cookie_required') return 'Reload this page, then try connecting ChatGPT again.';
  if (reason === 'rate_limited') return 'Too many sign-in attempts. Wait for the timer before trying again.';
  if (reason === 'storage_unavailable') return 'ChatGPT sign-in storage needs repair on this server.';
  if (reason === 'codex_configuration_invalid') return 'The Codex app server setup needs repair on this server.';
  if (reason === 'codex_executable_unavailable') return 'The Codex app server is not available on this server.';
  if (reason === 'codex_initialization_failed') return 'The Codex app server could not be initialized. Try again shortly.';
  if (reason === 'device_auth_unavailable') return 'ChatGPT device sign-in is unavailable on this server.';
  if (reason === 'provider_unavailable') return 'The ChatGPT sign-in provider is unavailable. Try again shortly.';
  if (reason === 'account_verification_failed') return 'This server could not verify the ChatGPT account. Check the server setup.';
  if (reason === 'codex_start_failed') return 'ChatGPT sign-in could not be started on this server. Try again shortly.';
  return 'ChatGPT sign-in could not be started. Try again.';
}

/** A present-tense line for the disabled Connect button. */
export function codexCooldownLine(seconds: number): string {
  return `Too many sign-in attempts. Try again in ${Math.max(1, Math.ceil(seconds))} second${Math.max(1, Math.ceil(seconds)) === 1 ? '' : 's'}.`;
}

/** Login status errors are not public diagnostic text. */
export function codexTerminalLoginLine(state: CodexLoginState): string {
  if (state === 'expired') return 'This sign-in code expired.';
  if (state === 'cancelled') return 'Sign-in was cancelled.';
  return 'ChatGPT sign-in could not be completed. Try again.';
}

const CODEX_LOGIN_ROUTE = '/api/llm/codex/login';
const REFUSAL_STATUSES = new Set([400, 401, 403, 404, 409, 429, 503]);
// The server may spend ten seconds initializing the app server and another ten starting device auth.
const TIMEOUT_MS = 25_000;
const MAX_RETRY_AFTER_SECONDS = 3_600;

function headers(): Record<string, string> {
  const secret = getSetupSecret();
  return secret === null ? {} : { 'x-setup-secret': secret };
}

/** Parses only a small, useful Retry-After number; malformed or huge values do not lock the UI. */
export function codexRetryAfterSeconds(value: string | null): number | undefined {
  if (value === null || !/^\d+$/.test(value.trim())) return undefined;
  const seconds = Number(value);
  if (!Number.isSafeInteger(seconds) || seconds < 1) return undefined;
  return Math.min(seconds, MAX_RETRY_AFTER_SECONDS);
}

function safeReason(status: number, body: unknown): string {
  const candidate = typeof body === 'object' && body !== null && typeof (body as { reason?: unknown }).reason === 'string'
    ? (body as { reason: string }).reason
    : 'refused';
  if (status !== 503 || SAFE_START_FAILURES.has(candidate)) return candidate;
  return 'refused';
}

async function call<T>(path: string, init: RequestInit): Promise<CodexLoginFetch<T>> {
  if (typeof window === 'undefined') return { kind: 'unreachable' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(path, { ...init, headers: { ...headers(), ...(init.headers ?? {}) }, cache: 'no-store', signal: controller.signal });
    if (REFUSAL_STATUSES.has(response.status)) {
      const body: unknown = await response.json().catch(() => ({}));
      const retryAfterSeconds = response.status === 429 ? codexRetryAfterSeconds(response.headers.get('retry-after')) : undefined;
      return { kind: 'refused', status: response.status, reason: safeReason(response.status, body), ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }) };
    }
    if (!response.ok) return { kind: 'unreachable' };
    return { kind: 'ok', value: (await response.json()) as T };
  } catch {
    return { kind: 'unreachable' };
  } finally {
    clearTimeout(timer);
  }
}

export function startCodexLogin(): Promise<CodexLoginFetch<CodexLoginStart>> {
  return call<CodexLoginStart>(CODEX_LOGIN_ROUTE, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
}

export function logoutCodex(): Promise<CodexLoginFetch<{ readonly ok: boolean; readonly state?: string }>> {
  return call(CODEX_LOGIN_ROUTE, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'logout' }) });
}

export function pollCodexLogin(loginId: string): Promise<CodexLoginFetch<CodexLoginStatus>> {
  return call<CodexLoginStatus>(`${CODEX_LOGIN_ROUTE}?loginId=${encodeURIComponent(loginId)}`, { method: 'GET' });
}

export function cancelCodexLogin(loginId: string): Promise<CodexLoginFetch<CodexLoginCancel>> {
  return call<CodexLoginCancel>(CODEX_LOGIN_ROUTE, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ loginId }) });
}
