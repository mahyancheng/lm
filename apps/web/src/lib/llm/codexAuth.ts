/** Client contract for the managed Codex / ChatGPT device login. */

import { getSetupSecret, type TokenFetch } from './token';

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

export function codexLoginFailureLine(reason: string): string {
  if (reason === 'setup_secret_required') return 'Enter the setup secret for this deployment to connect ChatGPT.';
  if (reason === 'setup_disabled') return 'ChatGPT connections are disabled for this deployment.';
  if (reason === 'cookie_required') return 'Reload this page, then try connecting ChatGPT again.';
  if (reason === 'rate_limited') return 'Too many sign-in attempts. Wait a moment and try again.';
  return 'ChatGPT sign-in could not be started. Try again.';
}

const CODEX_LOGIN_ROUTE = '/api/llm/codex/login';
const REFUSAL_STATUSES = new Set([400, 401, 403, 404, 409, 429]);
const TIMEOUT_MS = 10_000;

function headers(): Record<string, string> {
  const secret = getSetupSecret();
  return secret === null ? {} : { 'x-setup-secret': secret };
}

async function call<T>(path: string, init: RequestInit): Promise<TokenFetch<T>> {
  if (typeof window === 'undefined') return { kind: 'unreachable' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(path, { ...init, headers: { ...headers(), ...(init.headers ?? {}) }, cache: 'no-store', signal: controller.signal });
    if (REFUSAL_STATUSES.has(response.status)) {
      const body = (await response.json().catch(() => ({}))) as { reason?: string };
      return { kind: 'refused', status: response.status, reason: body.reason ?? 'refused' };
    }
    if (!response.ok) return { kind: 'unreachable' };
    return { kind: 'ok', value: (await response.json()) as T };
  } catch {
    return { kind: 'unreachable' };
  } finally {
    clearTimeout(timer);
  }
}

export function startCodexLogin(): Promise<TokenFetch<CodexLoginStart>> {
  return call<CodexLoginStart>(CODEX_LOGIN_ROUTE, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
}

export function logoutCodex(): Promise<TokenFetch<{ readonly ok: boolean; readonly state?: string }>> {
  return call(CODEX_LOGIN_ROUTE, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'logout' }) });
}

export function pollCodexLogin(loginId: string): Promise<TokenFetch<CodexLoginStatus>> {
  return call<CodexLoginStatus>(`${CODEX_LOGIN_ROUTE}?loginId=${encodeURIComponent(loginId)}`, { method: 'GET' });
}

export function cancelCodexLogin(loginId: string): Promise<TokenFetch<CodexLoginCancel>> {
  return call<CodexLoginCancel>(CODEX_LOGIN_ROUTE, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ loginId }) });
}
