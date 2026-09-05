/**
 * @frontier/llm — oauth.ts
 *
 * The subscription-OAuth authorization-code flow that `claude setup-token`
 * runs, reproduced as three pure, injectable steps so the game can drive it
 * in-app instead of asking a player to open a terminal.
 *
 * **Server only, and additive.** Nothing here is wired into a transport or a
 * role: it is the protocol, factored out so a route can build the authorize
 * link, and later exchange the pasted code for a token, without either handler
 * embedding an endpoint or a request shape. Every constant below was read off
 * the installed Claude Code CLI (`@anthropic-ai/claude-agent-sdk`,
 * `manifest.json` build 2.1.251), never guessed:
 *
 * | Step | What the CLI does | Reproduced by |
 * |---|---|---|
 * | authorize | opens `claude.com/cai/oauth/authorize` with PKCE S256 | `buildClaudeAuthorizeUrl` |
 * | exchange | `POST platform.claude.com/v1/oauth/token`, JSON body | `exchangeClaudeOAuthCode` |
 *
 * The exchange body the CLI sends is
 * `{ grant_type: "authorization_code", code, redirect_uri, client_id,
 *    code_verifier, state, expires_in? }` as `application/json`; a 200 answers
 * `{ access_token, expires_in, refresh_token? }`, and `access_token` is the
 * `sk-ant-oat…` value `setup-token` prints. This module returns that token and
 * nothing else — the caller stores it exactly as it would a pasted one.
 *
 * ## The manual-redirect (headless) variant
 *
 * There is no loopback server here — a deployed web app cannot open one — so
 * the flow uses the CLI's *manual* redirect (`redirect_uri` =
 * `…/oauth/code/callback`). After approving, the person lands on a page that
 * prints the authorization code as `code#state`; they paste it back. The route
 * splits on `#`, checks the right half against the state it stored, and passes
 * the left half here.
 *
 * ## Why every source of entropy is a parameter
 *
 * PKCE is only worth anything if the verifier is unguessable, which is a claim
 * about randomness — so the tests pin it by injecting a deterministic byte
 * source, and production passes none and gets `crypto.randomBytes`. The same is
 * true of `fetch`: the exchange is the one network call in this file, and a
 * test proves the request shape and reads a canned response without a socket.
 */

import { createHash, randomBytes as nodeRandomBytes } from 'node:crypto';

/* -------------------------------------------------------------------------- */
/*  Configuration — read from the installed CLI, not invented                  */
/* -------------------------------------------------------------------------- */

/**
 * The OAuth endpoints and the public client id the Claude Code CLI uses.
 *
 * `authorizeUrl` is the *subscription* (claude.ai) authorize URL, which is the
 * one `setup-token` uses and the one that yields a token an in-game role can
 * spend. `redirectUri` is the CLI's manual-redirect callback: the only variant
 * a server with no loopback listener can complete. `expiresIn` is one year in
 * seconds — the CLI requests a long-lived token for `setup-token`, and the game
 * wants the same rather than a session-length one that dies mid-campaign.
 */
export const CLAUDE_OAUTH_CONFIG = {
  clientId: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
  authorizeUrl: 'https://claude.com/cai/oauth/authorize',
  tokenUrl: 'https://platform.claude.com/v1/oauth/token',
  redirectUri: 'https://platform.claude.com/oauth/code/callback',
  scope: 'user:inference',
  /** Seconds. One year, matching the CLI's long-lived `setup-token`. */
  expiresIn: 31_536_000,
} as const;

/* -------------------------------------------------------------------------- */
/*  PKCE                                                                        */
/* -------------------------------------------------------------------------- */

/** A source of random bytes. `crypto.randomBytes` in production; deterministic in a test. */
export type RandomBytes = (size: number) => Buffer;

/** Base64URL without padding — the encoding PKCE and OAuth state both require. */
export function base64Url(bytes: Buffer): string {
  return bytes.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** The PKCE pair. The verifier is the secret and never leaves the server; the challenge is what the authorize URL carries. */
export interface ClaudePkcePair {
  readonly verifier: string;
  readonly challenge: string;
}

/**
 * A PKCE S256 pair.
 *
 * 32 random bytes base64url-encode to a 43-character verifier, comfortably
 * inside the RFC 7636 range, and the challenge is the base64url of its SHA-256.
 */
export function createPkcePair(random: RandomBytes = nodeRandomBytes): ClaudePkcePair {
  const verifier = base64Url(random(32));
  const challenge = base64Url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

/** An opaque, unguessable `state`, bound to one flow and checked on the way back. */
export function createOAuthState(random: RandomBytes = nodeRandomBytes): string {
  return base64Url(random(32));
}

/* -------------------------------------------------------------------------- */
/*  The authorize URL                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The link a person opens to approve the connection.
 *
 * Every parameter and its order match the CLI's manual-redirect authorize URL:
 * `code=true` (ask the callback to print the code), `response_type=code`,
 * `code_challenge_method=S256`, the manual `redirect_uri`, and the state. The
 * challenge is the only per-flow secret-derived value; the verifier that made
 * it stays on the server.
 */
export function buildClaudeAuthorizeUrl(params: { readonly challenge: string; readonly state: string }): string {
  const url = new URL(CLAUDE_OAUTH_CONFIG.authorizeUrl);
  url.searchParams.set('code', 'true');
  url.searchParams.set('client_id', CLAUDE_OAUTH_CONFIG.clientId);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', CLAUDE_OAUTH_CONFIG.redirectUri);
  url.searchParams.set('scope', CLAUDE_OAUTH_CONFIG.scope);
  url.searchParams.set('code_challenge', params.challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', params.state);
  return url.toString();
}

/* -------------------------------------------------------------------------- */
/*  The token exchange                                                         */
/* -------------------------------------------------------------------------- */

/** Why an exchange did not yield a token. Each maps to a distinct instruction for the operator. */
export type ClaudeOAuthExchangeError =
  /** The authorization code was rejected — usually expired, reused, or mistyped. */
  | 'expired_code'
  /** The endpoint answered non-200 for some other reason. */
  | 'exchange_failed'
  /** The request never reached the endpoint. */
  | 'network'
  /** A 200 whose body carried no usable `access_token`. */
  | 'bad_response';

export type ClaudeOAuthExchangeResult =
  | { readonly ok: true; readonly token: string; readonly expiresIn: number | null }
  | { readonly ok: false; readonly error: ClaudeOAuthExchangeError; readonly detail: string };

/** The subset of `fetch` this module uses, so a test can supply a stub with the same shape. */
export type FetchLike = (input: string, init: {
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string;
}) => Promise<{ readonly status: number; text(): Promise<string> }>;

export interface ExchangeInput {
  /** The authorization code, already split from any `#state` suffix. */
  readonly code: string;
  /** The PKCE verifier stored when the flow started. */
  readonly verifier: string;
  /** The state stored when the flow started. Echoed in the body, as the CLI does. */
  readonly state: string;
  /** Injected transport. Defaults to the global `fetch`. */
  readonly fetchImpl?: FetchLike;
}

/** Bound so a malformed or hostile body can never grow memory without limit before it is parsed. */
const MAX_EXCHANGE_BODY_BYTES = 64 * 1024;

/**
 * Exchange an authorization code for a subscription token.
 *
 * Mirrors the CLI exactly: a JSON `POST` to the token endpoint with the
 * manual `redirect_uri`, the public `client_id`, the `code_verifier`, the
 * `state`, and the long `expires_in`. Never throws — a thrown `fetch` is
 * `network`, a 401 is `expired_code`, any other non-200 is `exchange_failed`,
 * and a 200 without an `access_token` string is `bad_response`. The returned
 * `token` is stored verbatim; the classifier will read its `sk-ant-oat…` prefix
 * and select the Claude-session transport.
 */
export async function exchangeClaudeOAuthCode(input: ExchangeInput): Promise<ClaudeOAuthExchangeResult> {
  const fetchImpl = input.fetchImpl ?? (globalThis.fetch as unknown as FetchLike | undefined);
  if (fetchImpl === undefined) {
    return { ok: false, error: 'network', detail: 'No fetch implementation is available in this runtime.' };
  }

  const body = JSON.stringify({
    grant_type: 'authorization_code',
    code: input.code,
    redirect_uri: CLAUDE_OAUTH_CONFIG.redirectUri,
    client_id: CLAUDE_OAUTH_CONFIG.clientId,
    code_verifier: input.verifier,
    state: input.state,
    expires_in: CLAUDE_OAUTH_CONFIG.expiresIn,
  });

  let status: number;
  let text: string;
  try {
    const response = await fetchImpl(CLAUDE_OAUTH_CONFIG.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body,
    });
    status = response.status;
    text = (await response.text()).slice(0, MAX_EXCHANGE_BODY_BYTES);
  } catch (error) {
    return { ok: false, error: 'network', detail: error instanceof Error ? error.message.slice(0, 200) : 'The token endpoint could not be reached.' };
  }

  if (status === 401 || status === 400) {
    return { ok: false, error: 'expired_code', detail: `The authorization code was rejected (HTTP ${status}).` };
  }
  if (status !== 200) {
    return { ok: false, error: 'exchange_failed', detail: `The token endpoint answered HTTP ${status}.` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: 'bad_response', detail: 'The token endpoint answered 200 with a body that was not JSON.' };
  }

  const record = parsed as { access_token?: unknown; expires_in?: unknown };
  const token = typeof record.access_token === 'string' ? record.access_token.trim() : '';
  if (token.length === 0) {
    return { ok: false, error: 'bad_response', detail: 'The token endpoint answered 200 but carried no access_token.' };
  }

  const expiresIn = typeof record.expires_in === 'number' && Number.isFinite(record.expires_in) ? record.expires_in : null;
  return { ok: true, token, expiresIn };
}
