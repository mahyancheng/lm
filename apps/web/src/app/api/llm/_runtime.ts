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
 */

// Relative rather than `@/`: this module is imported directly by its test, and
// the path alias is a tsconfig/bundler concern the test runner does not share.
import {
  type CredentialKind,
  type CredentialSource,
  type LlmTransportKind,
  type TokenAuthGate,
  type TokenStatus,
  TOKEN_MAX_LENGTH,
  TOKEN_MIN_LENGTH,
  classifyCredential,
  maskCredential,
} from '../../../lib/llm/token';
import type { Principal } from './_identity';

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

let credential: RuntimeCredential | null = null;

/**
 * Bumped on every mutation. The gateway cache compares against it, so a stale
 * gateway can never outlive a credential change.
 */
let generation = 0;

/** The current generation. Monotonic, process-local, and not a clock. */
export function runtimeGeneration(): number {
  return generation;
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
  credential = { kind: descriptor.kind, value, descriptor };
  generation += 1;
  return descriptor;
}

/** Forget the runtime credential. Returns true when there was one to forget. */
export function clearRuntimeCredential(): boolean {
  const had = credential !== null;
  credential = null;
  generation += 1;
  return had;
}

/** The descriptor for the held credential, or null. Never carries the value. */
export function runtimeCredentialDescriptor(): RuntimeCredentialDescriptor | null {
  return credential?.descriptor ?? null;
}

/**
 * Test-only reset, so one suite's paste cannot leak into another's
 * expectations. It **bumps** the generation like any other mutation rather than
 * zeroing it: a counter that can go backwards is a cache that can serve a stale
 * gateway, which is the exact bug the counter exists to prevent.
 */
export function resetRuntimeCredential(): void {
  credential = null;
  generation += 1;
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
    const current = generation;
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
  const held = credential;
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
  const held = credential;
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
}

/**
 * The exact body `GET /api/llm/token` answers with.
 *
 * Assembled here rather than in the route so that "this response never carries
 * the credential" is a property a test can hold the whole object up against,
 * instead of a claim about a handler that needs a request scope to run.
 */
export function buildTokenStatus(facts: TransportFacts): TokenStatus {
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
    authGate: tokenAuthGate(facts.supabaseConfigured),
  };
}

/* -------------------------------------------------------------------------- */
/*  Who may write it                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Which posture this deployment is in.
 *
 * With Supabase configured there are real accounts, so writing the credential
 * that every player's model calls will be billed against is an administrative
 * act. With no Supabase there is nobody to be an administrator: the deployment
 * is one person's machine, the anonymous cookie is the only principal there is,
 * and refusing the owner access to their own settings would make the feature
 * useless in exactly the configuration it exists for.
 */
export function tokenAuthGate(supabaseConfigured: boolean): TokenAuthGate {
  return supabaseConfigured ? 'admin' : 'open-local';
}

export interface TokenWriteRequest {
  readonly supabaseConfigured: boolean;
  /** The admitted caller, or null when there is none. */
  readonly principal: Principal | null;
  /**
   * `profiles.is_admin` for a verified user. False when the flag is absent, and
   * false when it could not be read — an unverifiable claim is not a grant.
   */
  readonly isAdmin: boolean;
}

export type TokenWriteDecision =
  | { readonly ok: true; readonly gate: TokenAuthGate }
  | { readonly ok: false; readonly status: 401 | 403; readonly reason: string };

/**
 * May this caller set or clear the credential?
 *
 * Fails closed in both postures, and never treats an anonymous cookie as an
 * identity on a deployment that has real ones: a Supabase-configured
 * deployment that somehow admitted an anonymous principal is a bug, and the
 * answer to a bug here is 401, not a shrug.
 */
export function authorizeTokenWrite(request: TokenWriteRequest): TokenWriteDecision {
  if (request.principal === null) return { ok: false, status: 401, reason: 'unauthenticated' };

  if (request.supabaseConfigured) {
    if (request.principal.kind !== 'supabase') return { ok: false, status: 401, reason: 'unauthenticated' };
    if (!request.isAdmin) return { ok: false, status: 403, reason: 'admin_only' };
    return { ok: true, gate: 'admin' };
  }

  if (request.principal.kind !== 'anonymous') return { ok: false, status: 401, reason: 'unauthenticated' };

  // The per-browser cookie is a partition, not an identity, and it is not
  // pretended to be one here: on a deployment with no accounts, *any* caller
  // who reaches this process is the owner of it or is already inside their
  // network. What actually bounds this branch is the 5/min write budget above
  // and the fact that the process is a local one. Refusing a caller who has not
  // yet been issued a cookie would add no security — accepting one costs an
  // attacker a single extra request — while breaking the player whose browser
  // declines it.
  return { ok: true, gate: 'open-local' };
}

/* -------------------------------------------------------------------------- */
/*  Bounds                                                                     */
/* -------------------------------------------------------------------------- */

/** Writes per principal per minute. Far stricter than the role window: this is configuration, not play. */
export const TOKEN_WRITE_RATE_LIMIT = 5;

export { TOKEN_MAX_LENGTH, TOKEN_MIN_LENGTH };
