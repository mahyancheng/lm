/**
 * The Claude credential, as a wire contract and a set of client fetchers.
 *
 * **Shared.** Nothing here imports `@frontier/llm`, the Agent SDK or anything
 * else that is server-only, because both halves need it: the route handlers
 * import the limits and the classifier so a body is bounded the same way the
 * form bounds it, and the settings drawer imports the fetchers.
 *
 * The rule this module exists to keep: **a credential travels in exactly one
 * direction.** It goes from the paste field to the server and is never sent
 * back, never logged, never stored in the browser and never written to disk.
 * What comes back is a *descriptor* — the kind, the last four characters, and
 * when it was set — which is enough to answer "is this the token I pasted?"
 * and useless to anybody who intercepts it.
 */

/* -------------------------------------------------------------------------- */
/*  Shape of a credential                                                      */
/* -------------------------------------------------------------------------- */

/** Which of the two credentials this is, and therefore which transport it selects. */
export type CredentialKind = 'oauth' | 'api_key';

/** Where the credential the server is using came from. */
export type CredentialSource = 'runtime' | 'env' | 'none';

/** Who may write the credential on this deployment. */
export type TokenAuthGate = 'admin' | 'open-local';

export type LlmTransportKind = 'claude-session' | 'api' | 'none';

/**
 * Shortest credential accepted. Both real tokens are far longer; this only has
 * to be long enough that a stray word or a paste of half a line is refused
 * before it reaches a transport that would spend its whole timeout failing.
 */
export const TOKEN_MIN_LENGTH = 20;

/** Longest credential accepted. Generous — an OAuth token is a few hundred characters. */
export const TOKEN_MAX_LENGTH = 4096;

/** How many trailing characters of a secret may ever be shown or returned. */
export const TOKEN_MASK_TAIL = 4;

/** The family prefix both Anthropic credentials share. */
export const ANTHROPIC_PREFIX = 'sk-ant-';

/**
 * The sub-prefix `claude setup-token` produces.
 *
 * This one carve-out is load-bearing. **Both** credentials begin `sk-ant-`, so
 * a rule that stopped at the family prefix would classify every subscription
 * OAuth token as a metered API key, set it as `ANTHROPIC_API_KEY`, and fail
 * every call on the exact path this feature exists to make easy.
 */
export const OAUTH_TOKEN_PREFIX = 'sk-ant-oat';

/**
 * Which credential is this, and therefore which transport does it select?
 *
 * | Looks like | Kind | Transport |
 * |---|---|---|
 * | `sk-ant-oat…` | `oauth` | `claude-session` |
 * | `sk-ant-…` anything else | `api_key` | `api` |
 * | no Anthropic prefix | `oauth` | `claude-session` |
 *
 * By prefix and never by parsing: a credential's internal shape is not ours to
 * depend on. The unprefixed default is `oauth` because that is the transport
 * this game runs on, so an unrecognised value fails on the path the operator
 * asked for rather than on one they never chose.
 */
export function classifyCredential(token: string): CredentialKind {
  const trimmed = token.trim();
  if (trimmed.startsWith(OAUTH_TOKEN_PREFIX)) return 'oauth';
  return trimmed.startsWith(ANTHROPIC_PREFIX) ? 'api_key' : 'oauth';
}

/**
 * The only rendering of a secret this codebase produces.
 *
 * At most `TOKEN_MASK_TAIL` characters of the value survive, and the ellipsis
 * is unconditional so a short value cannot accidentally be shown whole.
 */
export function maskCredential(token: string): string {
  return `…${token.trim().slice(-TOKEN_MASK_TAIL)}`;
}

/** Is this paste plausibly a credential? Length only — the server decides the rest. */
export function tokenDraftIssue(draft: string): string | null {
  const trimmed = draft.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length < TOKEN_MIN_LENGTH) return 'That looks too short to be a token.';
  if (trimmed.length > TOKEN_MAX_LENGTH) return 'That is longer than any Claude credential.';
  if (/\s/.test(trimmed)) return 'A token has no spaces or line breaks in it.';
  return null;
}

/* -------------------------------------------------------------------------- */
/*  Wire types                                                                 */
/* -------------------------------------------------------------------------- */

/** `GET /api/llm/token`. Carries a descriptor, never a value. */
export interface TokenStatus {
  /** True when a credential is known to the server, from the runtime store or the environment. */
  readonly configured: boolean;
  /**
   * True when a role call has a chance of reaching a model. Wider than
   * `configured`: a machine already logged into Claude Code is available with
   * no credential in the process at all.
   */
  readonly available: boolean;
  readonly source: CredentialSource;
  readonly transportKind: LlmTransportKind;
  readonly model: string | null;
  /** Last four characters, or null. Never more. */
  readonly masked: string | null;
  readonly kind: CredentialKind | null;
  /** ISO timestamp, set only for a credential pasted into this process. */
  readonly setAt: string | null;
  readonly authGate: TokenAuthGate;
}

/** `POST`/`DELETE /api/llm/token`. */
export interface TokenMutationResult {
  readonly ok: boolean;
  readonly source: CredentialSource;
  readonly transportKind: LlmTransportKind;
  readonly masked: string | null;
  readonly kind: CredentialKind | null;
  readonly reason?: string;
}

/** Why a live connection test did not reach a model. */
export type TokenTestFailure = 'bad_token' | 'rate_limited' | 'network' | 'transport_unavailable';

/** `POST /api/llm/token/test`. */
export type TokenTestResult =
  | { readonly ok: true; readonly modelId: string; readonly latencyMs: number; readonly note?: string }
  | { readonly ok: false; readonly failure: TokenTestFailure; readonly detail: string; readonly latencyMs: number };

/** Mirrors `LlmFallbackRecord.reason`, spelled out here so no client bundle needs the contracts to read it. */
export type LlmFallbackReason = 'timeout' | 'rate_limited' | 'invalid_output' | 'api_error' | 'disabled';

/**
 * Turn a fallback reason into what the operator should do about it.
 *
 * Two of these are not failures of the credential and are reported as such:
 *
 * - `null` — the model answered and its reply validated.
 * - `invalid_output` — the model answered and its reply did *not* validate.
 *   That is a prompt or schema problem, and it is a **successful** connection
 *   test: something on the other end of the credential replied. Reporting it as
 *   a bad token would send the operator to regenerate a token that works.
 *
 * `disabled` is the reason the Agent SDK reports for a token that is missing,
 * expired, revoked, or attached to an account that may not use the model, which
 * is precisely the set of things "bad token" should mean.
 */
export function classifyTestFailure(reason: LlmFallbackReason | null): TokenTestFailure | null {
  switch (reason) {
    case null:
    case 'invalid_output':
      return null;
    case 'disabled':
      return 'bad_token';
    case 'rate_limited':
      return 'rate_limited';
    default:
      return 'network';
  }
}

/** What a fetcher returns when it could not get an answer at all. */
export type TokenFetch<T> =
  | { readonly kind: 'ok'; readonly value: T }
  /** No server answered — the static export, or `next dev` not running. */
  | { readonly kind: 'unreachable' }
  /** A server answered and refused: a bad paste, no authority, or too many tries. */
  | { readonly kind: 'refused'; readonly status: number; readonly reason: string };

/* -------------------------------------------------------------------------- */
/*  Client fetchers                                                            */
/* -------------------------------------------------------------------------- */

const TOKEN_ROUTE = '/api/llm/token';

/**
 * Answers that mean "a server is there and said no", as opposed to "there is no
 * server". The distinction is the whole difference between showing the paste
 * form with an error on it and quietly explaining that this build has no
 * backend at all.
 */
const REFUSAL_STATUSES: ReadonlySet<number> = new Set([400, 401, 403, 429]);

/** Milliseconds before a status or mutation call is abandoned. */
const TOKEN_TIMEOUT_MS = 15_000;

/** A live test spawns a Claude Code session, which is slower than a mutation. */
const TEST_TIMEOUT_MS = 60_000;

async function call<T>(path: string, init: RequestInit, timeoutMs: number): Promise<TokenFetch<T>> {
  if (typeof window === 'undefined') return { kind: 'unreachable' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(path, { ...init, cache: 'no-store', signal: controller.signal });
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

/** Read the credential descriptor. Never returns the credential. */
export function fetchTokenStatus(): Promise<TokenFetch<TokenStatus>> {
  return call<TokenStatus>(TOKEN_ROUTE, { method: 'GET' }, TOKEN_TIMEOUT_MS);
}

/** Hand a pasted credential to the server. The value leaves the browser once and never comes back. */
export function connectToken(token: string): Promise<TokenFetch<TokenMutationResult>> {
  return call<TokenMutationResult>(
    TOKEN_ROUTE,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }) },
    TOKEN_TIMEOUT_MS,
  );
}

/** Drop the runtime credential. The environment baseline, if any, takes over again. */
export function disconnectToken(): Promise<TokenFetch<TokenMutationResult>> {
  return call<TokenMutationResult>(TOKEN_ROUTE, { method: 'DELETE' }, TOKEN_TIMEOUT_MS);
}

/** Spend one real model call to prove the credential works. Only ever from an explicit click. */
export function testToken(): Promise<TokenFetch<TokenTestResult>> {
  return call<TokenTestResult>(`${TOKEN_ROUTE}/test`, { method: 'POST' }, TEST_TIMEOUT_MS);
}
