/**
 * The runtime Claude credential — a token pasted into the running process.
 *
 * **Server only.** Nothing in this module may be imported from a client
 * component: it holds a live secret in memory, and a client bundle that
 * referenced it would inline nothing while advertising exactly where to look.
 *
 * ## What this is for
 *
 * `claude setup-token` prints a subscription OAuth token. Before this module
 * the only way to give it to the game was to edit `.env.local` and restart, and
 * "edit a dotfile and restart the server" is not a step a player will take. The
 * runtime store lets Settings hand the token to the process directly.
 *
 * ## The precedence rule, stated once
 *
 * The environment is the **baseline**; the runtime credential is an
 * **override**; clearing the override falls back to the baseline. There is no
 * third source and no merging within a source: whichever wins supplies both the
 * transport and the credential, so a runtime API key cannot end up half-applied
 * on top of an environment OAuth token.
 *
 * ## Where it lives, honestly
 *
 * In one process's memory, for the life of that process. That is exactly right
 * for the deployment this feature is for — `next dev` or `next start` on the
 * owner's machine — and it is *not* a persistence mechanism. On a multi-instance
 * serverless deployment each instance has its own empty store, so a token
 * pasted into one lambda is unknown to the next, and the environment variable
 * is the only durable answer there. The UI and the docs say so rather than
 * implying otherwise.
 *
 * ## Rebuilding the gateway
 *
 * The gateway is built once and cached, so a changed credential has to
 * invalidate it. The signal is a **monotonic counter**, bumped on every set and
 * every clear — not a timestamp. A clock would make the cache key depend on
 * wall time, which is the one thing the rest of this codebase is careful never
 * to do, and two changes inside the same millisecond would compare equal.
 *
 * ## Why the store hangs off `globalThis`
 *
 * A module-level `let` is process state only if the module is evaluated once,
 * and under `next dev` it is not: compiling a route the process has not served
 * yet recreates the module registry, and every module-scope value in it starts
 * again from its initialiser. The observed failure was exact and silent — paste
 * a token, visit a page whose route had not been compiled, and the credential
 * was gone with the UI still showing it connected. Holding the store on a
 * `Symbol.for` slot is the standard dev-HMR singleton: the registry may be
 * rebuilt as often as it likes, the process keeps one store.
 *
 * The slot is defined **non-enumerable**, so nothing that walks the global
 * object — a logger, a serialiser, a crash reporter — can reach a live secret
 * by accident.
 */

// Relative rather than `@/`: this module is imported directly by its test, and
// the path alias is a tsconfig/bundler concern the test runner does not share.
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  type CredentialKind,
  type CredentialSource,
  type LlmTransportKind,
  type TokenAuthGate,
  type TokenStatusFull,
  type TokenStatusPublic,
  TOKEN_MAX_LENGTH,
  TOKEN_MIN_LENGTH,
  classifyCredential,
  maskCredential,
} from '../../../lib/llm/token';
import type { Principal } from './_identity';

/* -------------------------------------------------------------------------- */
/*  Process-wide singletons                                                    */
/* -------------------------------------------------------------------------- */

/**
 * A value that must outlive the module that declares it.
 *
 * Keyed by a registered symbol so two evaluations of the same module find the
 * same slot, and defined non-enumerable and non-configurable so nothing
 * enumerating the global object can find it and nothing can replace it.
 *
 * This is for **process state**, not for caches that merely benefit from
 * living longer: everything stored this way survives a hot reload, which is
 * exactly as useful for a rate limiter as it is dangerous for a value a
 * developer expects their edit to reset.
 */
export function processSingleton<T extends object>(name: string, create: () => T): T {
  const key = Symbol.for(`frontier.${name}`);
  const host = globalThis as unknown as Record<symbol, T | undefined>;
  const existing = host[key];
  if (existing !== undefined) return existing;

  const value = create();
  Object.defineProperty(globalThis, key, { value, writable: false, enumerable: false, configurable: false });
  return value;
}

/* -------------------------------------------------------------------------- */
/*  The store                                                                  */
/* -------------------------------------------------------------------------- */

/** The credential the process is holding. The `value` never leaves this module's callers on the server. */
interface RuntimeCredential {
  readonly kind: CredentialKind;
  readonly value: string;
  readonly descriptor: RuntimeCredentialDescriptor;
}

/** Everything about a runtime credential that is safe to return, log or render. */
export interface RuntimeCredentialDescriptor {
  readonly kind: CredentialKind;
  /** Last four characters of the secret, with a leading ellipsis. Never more. */
  readonly masked: string;
  /** ISO timestamp of when it was pasted. Diagnostic only; never an engine input. */
  readonly setAt: string;
}

/**
 * The one store, and the one counter.
 *
 * `generation` is bumped on every mutation. The gateway cache compares against
 * it, so a stale gateway can never outlive a credential change — and because
 * the counter lives beside the credential in the same process-wide slot, a
 * module re-evaluation cannot rewind it and hand out a gateway built for a
 * credential that is no longer there.
 */
interface RuntimeStore {
  credential: RuntimeCredential | null;
  generation: number;
}

/** The name is part of the contract: two module instances must agree on it. */
export const RUNTIME_STORE_KEY = 'llm.runtimeCredentialStore';

function store(): RuntimeStore {
  return processSingleton<RuntimeStore>(RUNTIME_STORE_KEY, () => ({ credential: null, generation: 0 }));
}

/** The current generation. Monotonic, process-local, and not a clock. */
export function runtimeGeneration(): number {
  return store().generation;
}

export interface SetCredentialOptions {
  /** Injected so a test never depends on the wall clock. */
  readonly now?: () => string;
}

/**
 * Accept a pasted credential.
 *
 * Returns the descriptor, which is what the route answers with. The value is
 * held here and nowhere else.
 */
export function setRuntimeCredential(token: string, options: SetCredentialOptions = {}): RuntimeCredentialDescriptor {
  const value = token.trim();
  const descriptor: RuntimeCredentialDescriptor = {
    kind: classifyCredential(value),
    masked: maskCredential(value),
    setAt: (options.now ?? (() => new Date().toISOString()))(),
  };
  const held = store();
  held.credential = { kind: descriptor.kind, value, descriptor };
  held.generation += 1;
  return descriptor;
}

/** Forget the runtime credential. Returns true when there was one to forget. */
export function clearRuntimeCredential(): boolean {
  const held = store();
  const had = held.credential !== null;
  held.credential = null;
  held.generation += 1;
  return had;
}

/** The descriptor for the held credential, or null. Never carries the value. */
export function runtimeCredentialDescriptor(): RuntimeCredentialDescriptor | null {
  return store().credential?.descriptor ?? null;
}

/**
 * Test-only reset, so one suite's paste cannot leak into another's
 * expectations. It **bumps** the generation like any other mutation rather than
 * zeroing it: a counter that can go backwards is a cache that can serve a stale
 * gateway, which is the exact bug the counter exists to prevent.
 */
export function resetRuntimeCredential(): void {
  const held = store();
  held.credential = null;
  held.generation += 1;
}

/**
 * A value built once and rebuilt whenever the credential generation moves.
 *
 * This is the whole of the gateway cache's logic, extracted so it can be tested
 * without constructing a real gateway — and so that "rebuilds when the
 * credential changes" is a property of code rather than of a comment.
 */
export function createGenerationCache<T>(build: () => T): () => T {
  let held: { readonly value: T; readonly generation: number } | null = null;
  return (): T => {
    const current = store().generation;
    if (held === null || held.generation !== current) held = { value: build(), generation: current };
    return held.value;
  };
}

/* -------------------------------------------------------------------------- */
/*  Resolving the environment the gateway is built from                        */
/* -------------------------------------------------------------------------- */

/** The subset of the environment the gateway reads. */
export type LlmEnv = Readonly<Record<string, string | undefined>>;

function hasValue(value: string | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * The environment the gateway should be built from: the process environment,
 * with the runtime credential laid over it when there is one.
 *
 * The overlay sets `LLM_TRANSPORT` as well as the credential, because a pasted
 * token is an unambiguous statement of intent: it would be perverse to accept
 * an OAuth token and then leave the process on `LLM_TRANSPORT=none` because
 * that is what the dotfile said.
 */
export function resolveLlmEnv(base: LlmEnv): LlmEnv {
  const held = store().credential;
  if (held === null) return base;
  return held.kind === 'api_key'
    ? { ...base, LLM_TRANSPORT: 'api', ANTHROPIC_API_KEY: held.value }
    : { ...base, LLM_TRANSPORT: 'claude-session', CLAUDE_CODE_OAUTH_TOKEN: held.value };
}

export interface CredentialStatus {
  readonly configured: boolean;
  readonly source: CredentialSource;
  readonly kind: CredentialKind | null;
  readonly masked: string | null;
  readonly setAt: string | null;
}

const UNCONFIGURED: CredentialStatus = { configured: false, source: 'none', kind: null, masked: null, setAt: null };

/**
 * What the operator would see if they asked "which credential is in use?".
 *
 * The environment side reads whichever variable the *configured transport*
 * would use, so an `ANTHROPIC_API_KEY` left in a dotfile is not reported as the
 * live credential while the process is running on `claude-session`.
 */
export function credentialStatus(base: LlmEnv, transport: 'claude-session' | 'api' | 'none'): CredentialStatus {
  const held = store().credential;
  if (held !== null) {
    return { configured: true, source: 'runtime', kind: held.kind, masked: held.descriptor.masked, setAt: held.descriptor.setAt };
  }
  if (transport === 'none') return UNCONFIGURED;

  const envValue = transport === 'api' ? base['ANTHROPIC_API_KEY'] : base['CLAUDE_CODE_OAUTH_TOKEN'];
  if (!hasValue(envValue)) return UNCONFIGURED;

  return {
    configured: true,
    source: 'env',
    kind: transport === 'api' ? 'api_key' : 'oauth',
    masked: maskCredential(envValue as string),
    setAt: null,
  };
}

/** The transport facts `buildTokenStatus` needs, gathered by the route from the gateway. */
export interface TransportFacts {
  /** The process environment, unmerged — this function decides what overrides it. */
  readonly base: LlmEnv;
  readonly transport: LlmTransportKind;
  readonly model: string | null;
  /** True when a role call has any chance of reaching a model. */
  readonly available: boolean;
  readonly supabaseConfigured: boolean;
  /** True when this request looks like it came from the machine the process runs on. */
  readonly localConnection: boolean;
  /** True when `LLM_SETUP_SECRET` is set, so the deployment offers the secret-unlock gate. */
  readonly secretConfigured: boolean;
  /** True when this host is serverless (e.g. `VERCEL=1`), where `claude-session` cannot spawn its subprocess. */
  readonly serverless: boolean;
}

/**
 * The full body `GET /api/llm/token` answers an authorised caller with.
 *
 * Assembled here rather than in the route so that "this response never carries
 * the credential" is a property a test can hold the whole object up against,
 * instead of a claim about a handler that needs a request scope to run.
 */
export function buildTokenStatus(facts: TransportFacts): TokenStatusFull {
  const status = credentialStatus(facts.base, facts.transport);
  return {
    configured: status.configured,
    available: facts.available,
    source: status.source,
    transportKind: facts.transport,
    model: facts.model,
    masked: status.masked,
    kind: status.kind,
    setAt: status.setAt,
    authGate: tokenAuthGate(facts.supabaseConfigured, facts.localConnection, facts.secretConfigured),
    serverless: facts.serverless,
  };
}

/**
 * The same body with everything that describes the secret removed.
 *
 * This is what a caller who may not write the credential is told, and the
 * subtraction is deliberate rather than incidental: `masked` and `setAt`
 * describe the *environment's* credential too, so returning them to any
 * admitted caller told every signed-in player the last four characters of the
 * operator's token and when it was rotated. What survives is what the caller
 * can observe anyway — whether roles reach a model, on what transport, and who
 * this deployment lets change that.
 */
export function publicTokenStatus(status: TokenStatusFull): TokenStatusPublic {
  return {
    configured: status.configured,
    available: status.available,
    transportKind: status.transportKind,
    authGate: status.authGate,
    serverless: status.serverless,
  };
}

/* -------------------------------------------------------------------------- */
/*  Is the caller actually sitting at this machine?                            */
/* -------------------------------------------------------------------------- */

/** The variable an operator sets to state the posture rather than have it inferred. */
export const TOKEN_SETUP_ENV = 'LLM_TOKEN_SETUP';

/** Addresses that mean "this machine", including the IPv4-mapped IPv6 spellings. */
function isLoopbackAddress(value: string): boolean {
  const address = value.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (address.length === 0) return false;
  if (address === 'localhost' || address === '::1' || address === '::ffff:127.0.0.1') return true;
  // The whole of 127.0.0.0/8, not just 127.0.0.1.
  const v4 = /^(?:::ffff:)?(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(address);
  return v4 !== null && v4[1] === '127' && v4.slice(1).every((part) => Number(part) <= 255);
}

/** The host part of an authority, without the port. `[::1]:3000` keeps its brackets stripped. */
function authorityHost(authority: string): string {
  const trimmed = authority.trim();
  if (trimmed.startsWith('[')) return trimmed.slice(0, trimmed.indexOf(']') + 1);
  const colon = trimmed.lastIndexOf(':');
  return colon === -1 ? trimmed : trimmed.slice(0, colon);
}

/** What `isLocalConnection` may look at. Every field is a header value or an environment variable. */
export interface ConnectionFacts {
  /** `LLM_TOKEN_SETUP`, the explicit statement of posture. */
  readonly optIn: string | undefined;
  /** The `Host` header — what the browser was pointed at. */
  readonly host: string | null;
  /**
   * `x-forwarded-for`. Next fills this from the socket's `remoteAddress` when
   * the client did not send one, so on a direct connection it is the truth; a
   * client that sends one keeps its own value, which is why a non-loopback
   * entry is disqualifying and a forged loopback one is not sufficient on its
   * own.
   */
  readonly forwardedFor: string | null;
  /** Connection address, when a platform hands one over. Nothing in Next does today. */
  readonly connectionAddress?: string | null;
}

/**
 * Did this request come from the machine the process is running on?
 *
 * This exists because "Supabase is not configured" was being read as "this is
 * the owner's laptop", and it is not: `next dev` binds every interface, so on
 * any shared network the credential form was reachable — and writable — by
 * everyone on that network, who could then spend the owner's subscription
 * through the connection test.
 *
 * A Next route handler is not given the socket, so this is inference, and the
 * inference is stated honestly:
 *
 * - `LLM_TOKEN_SETUP=local` is an operator saying *yes* out loud, and wins.
 *   Any other non-empty value is an operator saying *no*, and also wins.
 * - Otherwise the request must have been aimed at a loopback authority **and**
 *   carry no non-loopback forwarding hop. A browser cannot forge either: it
 *   sets `Host` from the address bar and cannot set `x-forwarded-for` on a
 *   cross-site request at all. That is precisely the LAN-browser attack, closed.
 *
 * What it does not close is a scripted caller on the LAN that forges both
 * headers. Nothing readable from a route handler can, and saying so here is
 * better than implying otherwise: an operator who needs certainty binds the
 * server to loopback (`next dev -H 127.0.0.1`) or leaves the credential in the
 * environment, and both are documented.
 */
export function isLocalConnection(facts: ConnectionFacts): boolean {
  const declared = facts.optIn?.trim().toLowerCase() ?? '';
  if (declared.length > 0) return declared === 'local';

  const address = facts.connectionAddress ?? null;
  if (address !== null) return isLoopbackAddress(address);

  if (facts.host === null || !isLoopbackAddress(authorityHost(facts.host))) return false;

  const chain = facts.forwardedFor;
  if (chain === null || chain.trim().length === 0) return true;
  return chain.split(',').every((hop) => isLoopbackAddress(hop));
}

/* -------------------------------------------------------------------------- */
/*  Cross-site request forgery                                                 */
/* -------------------------------------------------------------------------- */

/** The headers a state-changing request is judged on. All four are set by the browser, not by the page. */
export interface WriteGuardFacts {
  /** `sec-fetch-site`. Every current browser sends it; nothing else does. */
  readonly secFetchSite: string | null;
  readonly origin: string | null;
  readonly host: string | null;
  readonly contentType: string | null;
  /** POST carries a body and must declare JSON; DELETE carries none and is not asked to. */
  readonly requiresJson: boolean;
}

export type WriteGuardDecision = { readonly ok: true } | { readonly ok: false; readonly status: 403; readonly reason: string };

const CSRF_OK: WriteGuardDecision = { ok: true };

/**
 * Is this state-changing request one the app's own page made?
 *
 * The defect this closes was worse than a missing header check. `SameSite=Lax`
 * kept the anonymous cookie off a cross-site POST, but the route then **minted
 * a fresh principal for the cookieless caller and let it write** — so the
 * cookie's protection was undone by the very thing that was supposed to
 * identify the caller. An attacker's page could set the credential of any
 * developer who visited it.
 *
 * Three rules, each of which a browser enforces and a page cannot escape:
 *
 * 1. `Sec-Fetch-Site` must say `same-origin` when it is present. The browser
 *    computes it; script cannot set it, because it is a forbidden header name.
 * 2. With no `Sec-Fetch-Site` (an older browser, or a non-browser client), the
 *    `Origin` must be present and its authority must equal the `Host`. Absent
 *    both, the request is refused: a state-changing call that will not say
 *    where it came from does not get the benefit of the doubt.
 * 3. A body-carrying write must declare `application/json`. A cross-site form —
 *    the one cross-origin POST that needs no preflight — can only send
 *    `text/plain`, `multipart/form-data` or `application/x-www-form-urlencoded`,
 *    so this alone makes the silent form POST impossible.
 *
 * Ordinary same-origin `fetch` from this app satisfies all three without
 * knowing they exist.
 */
export function checkWriteRequest(facts: WriteGuardFacts): WriteGuardDecision {
  const site = facts.secFetchSite?.trim().toLowerCase() ?? null;
  if (site !== null) {
    if (site !== 'same-origin') return { ok: false, status: 403, reason: 'cross_site' };
  } else {
    const origin = facts.origin?.trim() ?? '';
    const host = facts.host?.trim() ?? '';
    if (origin.length === 0 || host.length === 0) return { ok: false, status: 403, reason: 'origin_unverified' };
    let originAuthority: string;
    try {
      originAuthority = new URL(origin).host;
    } catch {
      return { ok: false, status: 403, reason: 'origin_unverified' };
    }
    if (originAuthority.toLowerCase() !== host.toLowerCase()) return { ok: false, status: 403, reason: 'cross_site' };
  }

  if (facts.requiresJson) {
    const mediaType = facts.contentType?.split(';')[0]?.trim().toLowerCase() ?? '';
    if (mediaType !== 'application/json') return { ok: false, status: 403, reason: 'unsupported_media_type' };
  }

  return CSRF_OK;
}

/* -------------------------------------------------------------------------- */
/*  Who may write it                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Which posture this deployment is in.
 *
 * With Supabase configured there are real accounts, so writing the credential
 * that every player's model calls will be billed against is an administrative
 * act — and that is true wherever the request came from.
 *
 * With no Supabase there is nobody to be an administrator, so authority has to
 * come from somewhere else:
 *
 * - *Being at the machine* (`open-local`) — the demo and local-dev posture.
 * - A *shared setup secret* (`secret`) — the operator has set
 *   `LLM_SETUP_SECRET`, so a caller who can present it in the `x-setup-secret`
 *   header may write. This is what lets a public serverless deployment offer
 *   in-app setup without wiring up Supabase admin.
 *
 * Local wins over the secret: a request already known to be from the machine
 * needs no secret. When none of these apply the answer is `disabled` rather
 * than a softer gate — an unauthenticated stranger on the network is not a
 * lesser administrator, and the honest thing to tell them is that this
 * deployment does not take a pasted credential at all.
 */
export function tokenAuthGate(supabaseConfigured: boolean, localConnection: boolean, secretConfigured = false): TokenAuthGate {
  if (supabaseConfigured) return 'admin';
  if (localConnection) return 'open-local';
  if (secretConfigured) return 'secret';
  return 'disabled';
}

/* -------------------------------------------------------------------------- */
/*  The setup secret, and the serverless host                                  */
/* -------------------------------------------------------------------------- */

/** The variable that unlocks in-app setup on a public deployment. Unset means the secret gate does not exist. */
export const SETUP_SECRET_ENV = 'LLM_SETUP_SECRET';

/** Is a non-empty setup secret configured for this deployment? */
export function setupSecretConfigured(env: LlmEnv): boolean {
  return hasValue(env[SETUP_SECRET_ENV]);
}

/**
 * Does the presented secret match the configured one, in constant time?
 *
 * False whenever there is nothing to match against — an unset or empty
 * `LLM_SETUP_SECRET` never unlocks anything, so a deployment that forgot to set
 * it does not silently accept an empty header. Both sides are hashed to a
 * fixed-width digest before comparison, so neither the match nor the length of
 * the secret leaks through timing.
 */
export function checkSetupSecret(presented: string | null, configured: string | undefined): boolean {
  const expected = (configured ?? '').trim();
  const candidate = (presented ?? '').trim();
  if (expected.length === 0 || candidate.length === 0) return false;
  const a = createHash('sha256').update(candidate).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

/**
 * The variable a serverless platform sets on its function runtime.
 *
 * `VERCEL=1` on Vercel. It is the signal that `claude-session` cannot work
 * here: that transport spawns the Claude Code CLI as a subprocess, which a
 * serverless function may not do. A normal Node process — `pnpm start` on a
 * server, a container — never sets it, which is exactly where the subscription
 * transport does work.
 */
export const SERVERLESS_ENV = 'VERCEL';

/** True when this deployment runs on a serverless host. */
export function isServerless(env: LlmEnv): boolean {
  return env[SERVERLESS_ENV] === '1';
}

/**
 * True when the resolved transport cannot actually reach a model on this host.
 *
 * The one case today: `claude-session` on a serverless function, which would
 * spawn a subprocess it is not allowed to spawn. Saying so up front is both
 * more honest than a green light and cheaper than discovering it once per role
 * call by burning the whole timeout.
 */
export function transportCannotRunHere(transport: LlmTransportKind, env: LlmEnv): boolean {
  return transport === 'claude-session' && isServerless(env);
}

/** Reading the descriptor and writing the credential are gated by the same rule, with one difference. */
export type TokenIntent = 'read' | 'write';

export interface TokenWriteRequest {
  readonly supabaseConfigured: boolean;
  /** The admitted caller, or null when there is none. */
  readonly principal: Principal | null;
  /**
   * `profiles.is_admin` for a verified user. False when the flag is absent, and
   * false when it could not be read — an unverifiable claim is not a grant.
   */
  readonly isAdmin: boolean;
  /** True when this request's anonymous principal was minted for it, because it presented no cookie. */
  readonly mintedPrincipal: boolean;
  /** Whether the request looks like it came from the machine the process runs on. */
  readonly localConnection: boolean;
  /** `write` additionally requires an established principal; `read` only decides disclosure. */
  readonly intent: TokenIntent;
  /** True when `LLM_SETUP_SECRET` is set on this deployment. Optional so callers that predate the secret gate are unaffected. */
  readonly secretConfigured?: boolean;
  /** True when the request presented the matching setup secret (compared in constant time by the caller). */
  readonly secretPresented?: boolean;
}

export type TokenWriteDecision =
  | { readonly ok: true; readonly gate: TokenAuthGate }
  | { readonly ok: false; readonly status: 401 | 403; readonly reason: string };

/**
 * May this caller set or clear the credential — or, for `read`, be told what it
 * is?
 *
 * Fails closed in both postures, and never treats an anonymous cookie as an
 * identity on a deployment that has real ones: a Supabase-configured
 * deployment that somehow admitted an anonymous principal is a bug, and the
 * answer to a bug here is 401, not a shrug.
 *
 * The demo branch used to end here, reasoning that anyone who reached the
 * process was its owner. Two things were wrong with that. The process is
 * reachable from the whole network, which `localConnection` now answers; and
 * *minting a principal for a caller who presented no cookie* meant every
 * cookieless request was a brand-new principal — a fresh rate-limit bucket
 * every time, and a write that `SameSite=Lax` had specifically arranged should
 * not happen. So a write now requires a principal that already existed.
 *
 * That costs the interface nothing: the settings sheet reads the status before
 * it can offer any control, `GET` still mints, and the cookie is therefore in
 * place long before a Connect button exists to press.
 */
export function authorizeTokenWrite(request: TokenWriteRequest): TokenWriteDecision {
  if (request.principal === null) return { ok: false, status: 401, reason: 'unauthenticated' };

  if (request.supabaseConfigured) {
    if (request.principal.kind !== 'supabase') return { ok: false, status: 401, reason: 'unauthenticated' };
    if (!request.isAdmin) return { ok: false, status: 403, reason: 'admin_only' };
    return { ok: true, gate: 'admin' };
  }

  if (request.principal.kind !== 'anonymous') return { ok: false, status: 401, reason: 'unauthenticated' };

  // Local wins: a request already known to be from the machine needs no secret,
  // and this keeps the demo posture exactly as it was.
  if (request.localConnection) {
    if (request.intent === 'write' && request.mintedPrincipal) return { ok: false, status: 401, reason: 'cookie_required' };
    return { ok: true, gate: 'open-local' };
  }

  // The setup secret is the only other thing that can stand in for authority on
  // a networked deployment with no accounts. It sits *on top of* the same CSRF
  // and established-cookie rules the local path is held to — it is an unlock,
  // never a replacement for them.
  if (request.secretConfigured === true) {
    if (request.secretPresented !== true) return { ok: false, status: 403, reason: 'setup_secret_required' };
    if (request.intent === 'write' && request.mintedPrincipal) return { ok: false, status: 401, reason: 'cookie_required' };
    return { ok: true, gate: 'secret' };
  }

  return { ok: false, status: 403, reason: 'setup_disabled' };
}

/* -------------------------------------------------------------------------- */
/*  Bounds                                                                     */
/* -------------------------------------------------------------------------- */

/** Writes per principal per minute. Far stricter than the role window: this is configuration, not play. */
export const TOKEN_WRITE_RATE_LIMIT = 5;

/**
 * The origin half of the write-budget key.
 *
 * It takes the headers and reads **none** of them, and that is the point: the
 * general-purpose `originKey()` in `_identity.ts` reads `x-forwarded-for`,
 * which any caller may set and change on every request. Charging the five-a-
 * minute budget to a value the caller chooses is the same defect as charging it
 * to a principal the caller can rotate — a fresh bucket per request, and a
 * limit that never binds. Written as a function taking headers so that "no
 * header rotates this bucket" is a property a test can hold two wildly
 * different header sets against.
 *
 * `connectionAddress` is the seam for a platform that does expose the socket;
 * Next does not, so today this is one bucket per process and the principal is
 * what separates callers.
 */
export function tokenWriteOriginKey(_headers: Headers, connectionAddress: string | null = null): string {
  return connectionAddress === null ? 'process' : connectionAddress.trim().toLowerCase();
}

/** The composite the tight budget is charged to: who, and from where. */
export function tokenWriteBudgetKey(principalId: string, origin: string): string {
  return `${origin}|${principalId}`;
}

/* -------------------------------------------------------------------------- */
/*  The in-flight OAuth flows                                                   */
/* -------------------------------------------------------------------------- */

/**
 * One pending in-app connect.
 *
 * The `verifier` is the PKCE secret and **never leaves the server** — it is the
 * whole reason a copied authorize link cannot be completed by anyone but the
 * browser that started the flow through this process. The `state` is echoed on
 * the way back and checked, so a code minted for a different flow is rejected.
 */
interface OAuthFlowRecord {
  readonly verifier: string;
  readonly state: string;
  /** Millisecond clock, for the TTL only. Never an engine input. */
  readonly createdAt: number;
}

/** How long a started flow may sit unfinished. Fifteen minutes is longer than an approval takes and short enough to bound the map. */
export const OAUTH_FLOW_TTL_MS = 15 * 60 * 1000;

/** The name is part of the contract: two module instances must agree on it, exactly like the credential store. */
export const OAUTH_FLOW_STORE_KEY = 'llm.oauthFlowStore';

function oauthFlows(): Map<string, OAuthFlowRecord> {
  return processSingleton<Map<string, OAuthFlowRecord>>(OAUTH_FLOW_STORE_KEY, () => new Map());
}

/** Drop every flow older than the TTL. Cheap, and keeps a never-finished flow from lingering. */
function pruneOAuthFlows(now: number): void {
  const flows = oauthFlows();
  for (const [id, record] of flows) {
    if (now - record.createdAt >= OAUTH_FLOW_TTL_MS) flows.delete(id);
  }
}

export interface StartedOAuthFlow {
  readonly flowId: string;
}

/**
 * Store a started flow and return its id.
 *
 * The id is what the browser holds; the verifier and state are held here. The
 * id is injectable so a test is deterministic, and defaults to a random UUID.
 */
export function startOAuthFlow(input: {
  readonly verifier: string;
  readonly state: string;
  readonly now?: number;
  readonly flowId?: string;
}): StartedOAuthFlow {
  const now = input.now ?? Date.now();
  pruneOAuthFlows(now);
  const flowId = input.flowId ?? randomUUID();
  oauthFlows().set(flowId, { verifier: input.verifier, state: input.state, createdAt: now });
  return { flowId };
}

export type OAuthFlowLookup =
  | { readonly ok: true; readonly verifier: string; readonly state: string }
  | { readonly ok: false; readonly reason: 'not_found' | 'expired' };

/**
 * Take a flow by id — **single use**. Whether it is found, expired, or missing,
 * it is removed, so a code can be tried against a flow exactly once and a
 * replay finds nothing.
 */
export function takeOAuthFlow(flowId: string, now: number = Date.now()): OAuthFlowLookup {
  const flows = oauthFlows();
  const record = flows.get(flowId);
  flows.delete(flowId);
  pruneOAuthFlows(now);
  if (record === undefined) return { ok: false, reason: 'not_found' };
  if (now - record.createdAt >= OAUTH_FLOW_TTL_MS) return { ok: false, reason: 'expired' };
  return { ok: true, verifier: record.verifier, state: record.state };
}

/** Test-only: forget every pending flow so one suite's start cannot leak into another's finish. */
export function resetOAuthFlows(): void {
  oauthFlows().clear();
}

export { TOKEN_MAX_LENGTH, TOKEN_MIN_LENGTH };
