/**
 * Shared plumbing for the LLM route handlers.
 *
 * **Server only.** `@frontier/llm` reaches the Claude Agent SDK, which must
 * never enter a client bundle. Every module in `app/api/llm` runs on the Node
 * runtime and is uncached.
 *
 * The contract every route keeps: a 200 with `{ output: null, fallback: true }`
 * whenever no model is configured, the model refuses, or anything throws. The
 * client always has a deterministic path, and `failure_mode` is an engine
 * invariant, not an aspiration.
 *
 * That contract covers the *model*, and only the model. It is not a way to
 * answer an authority question, so `admit()` runs first and its refusals are
 * real HTTP failures:
 *
 * | Situation | Answer |
 * |---|---|
 * | Body larger than `MAX_BODY_BYTES` | 413, before the body is read |
 * | Supabase configured, no signed-in user | 401 |
 * | More than `RATE_LIMIT_PER_WINDOW` calls in a minute | 429 with `retry-after` |
 * | Anything the model does or does not do | 200, `fallback: true` |
 *
 * Each call spawns a Claude Code subprocess on the operator's subscription, so
 * "no auth and no limit" is not a missing nicety — it is an open tap.
 *
 * `/chief-of-staff/quick` is the one route that never opens that tap — pure
 * arithmetic, no transport — so it calls `admitQuick()` instead of `admit()`
 * and spends a separate, more generous window (`RATE_LIMIT_QUICK_PER_WINDOW`)
 * rather than the model budget every other route shares.
 */

import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import type { z, ZodTypeAny } from 'zod';
import {
  DEFAULT_API_MODEL,
  DEFAULT_CLAUDE_SESSION_MODEL,
  createConcurrencyLimiter,
  createGateway,
  createInMemoryMemoryStore,
  resolveMaxConcurrency,
  resolveTransportKind,
  type ConcurrencyLimiter,
  type LimiterSnapshot,
  type LlmGateway,
  type LlmMemoryStore,
  type LlmTransportKind,
} from '@frontier/llm';
import { getRouteClient, isSupabaseAdminConfigured } from '@/lib/supabase/server';
import {
  ANONYMOUS_ID_COOKIE,
  ANONYMOUS_ID_MAX_AGE_SECONDS,
  type ConversationParts,
  type ConversationRole,
  MAX_BODY_BYTES,
  type Principal,
  RATE_LIMIT_COOKIELESS_PER_WINDOW,
  RATE_LIMIT_QUICK_PER_WINDOW,
  type RateDecision,
  type RateLimiter,
  conversationKeySecret,
  createRateLimiter,
  declaresOversizeBody,
  deriveConversationKey,
  originKey,
  resolvePrincipal,
} from './_identity';
import {
  type LlmEnv,
  TOKEN_WRITE_RATE_LIMIT,
  createGenerationCache,
  processSingleton,
  resolveLlmEnv,
  transportCannotRunHere,
} from './_runtime';

/** Every LLM route runs on Node and is never cached. */
export const LLM_ROUTE_RUNTIME = 'nodejs';

/**
 * The environment every read below answers from: `process.env` as the
 * baseline, with a credential pasted into Settings laid over it.
 *
 * Every function in this section resolves it afresh rather than closing over a
 * snapshot, because the override can change between two requests in one
 * process and a cached view of it would report the old answer.
 */
export function llmEnv(): LlmEnv {
  return resolveLlmEnv(process.env);
}

/**
 * How many model calls this process will run at once.
 *
 * Held on the **process**, not on the gateway, and deliberately so. A quarter
 * fans out over every rival strategist at once, and each `claude-session` call
 * spawns a Claude Code subprocess of a couple of hundred megabytes; on a small
 * always-on host four of those at once is the difference between a slow quarter
 * and an out-of-memory kill that takes the whole machine's other tenants with
 * it. The gateway is rebuilt whenever the credential changes, so a limiter
 * built *inside* it would reset mid-flight and let a second wave of
 * subprocesses start alongside the calls already running — the exact situation
 * the bound exists to prevent. One limiter per process, shared by every gateway
 * the process ever builds.
 *
 * The ceiling is read from `process.env` rather than from `llmEnv()`: the
 * pasted-credential overlay can name a transport and a secret, and neither of
 * those is a statement about how much memory this host has.
 */
const concurrencyLimiter = processSingleton<ConcurrencyLimiter>('llm.concurrencyLimiter', () =>
  createConcurrencyLimiter(resolveMaxConcurrency(process.env.LLM_MAX_CONCURRENCY)),
);

/** The bound in force, for diagnostics. */
export function maxConcurrency(): number {
  return concurrencyLimiter.max;
}

/**
 * The limiter's own bookkeeping, right now: queue depth per priority lane and
 * which role — if any — holds the permit.
 *
 * This is what turns "the model cannot be reached" into an honest sentence.
 * `/api/llm/health` reads it so the client can tell "no credential" (nothing
 * would ever start) apart from "the model is busy resolving the quarter — 3
 * calls ahead" (something is running, plenty is queued, and it will clear) —
 * two situations a bare `available: boolean` cannot distinguish. Cheap and
 * synchronous: it is the same process-wide limiter every role route already
 * shares, just read rather than acquired.
 */
export function limiterSnapshot(): LimiterSnapshot {
  return concurrencyLimiter.snapshot();
}

/**
 * The process-wide gateway.
 *
 * Cached, because building one starts a session store; rebuilt whenever the
 * runtime credential generation moves, because a gateway holds its transport —
 * and therefore its credential — from the moment it is constructed. The cache
 * key is a monotonic counter rather than a timestamp, which keeps this free of
 * the clock and correct for two changes inside one millisecond.
 *
 * A rebuild takes the dialogue session store with it, and that is the right
 * answer rather than an oversight: the stored ids name Claude sessions opened
 * under the *previous* credential, and resuming one of those on a new account
 * is at best a failed call. A changed credential starts fresh threads.
 *
 * What a rebuild does **not** take with it is the concurrency bound: that one
 * is handed in from the process singleton above and survives every rebuild.
 */
const cachedGateway = createGenerationCache<LlmGateway>(() =>
  createGateway(llmEnv(), { concurrencyLimiter }),
);

export function gateway(): LlmGateway {
  return cachedGateway();
}

/**
 * The durable half of every Chief of Staff thread — see the doc comment on
 * `chief-of-staff/route.ts` for why it lives on the **process**, not on the
 * gateway. Shared with `chief-of-staff/quick/route.ts`, which reads the same
 * memory (never writes it) so the instant offline answer and the eventual
 * model answer are read against one thread rather than two.
 */
const chiefOfStaffMemory = processSingleton<LlmMemoryStore>('llm.chiefOfStaffMemory', () => createInMemoryMemoryStore());

export function chiefOfStaffMemoryStore(): LlmMemoryStore {
  return chiefOfStaffMemory;
}

/** The transport in force: the pasted credential's, or the environment's. */
export function transportKind(): LlmTransportKind {
  return resolveTransportKind(llmEnv()['LLM_TRANSPORT']);
}

/** The model each role will run on, or null when there is no transport. */
export function modelName(): string | null {
  const env = llmEnv();
  const kind = resolveTransportKind(env['LLM_TRANSPORT']);
  if (kind === 'none') return null;
  if (kind === 'api') return env['ANTHROPIC_MODEL'] ?? DEFAULT_API_MODEL;
  return env['LLM_MODEL'] ?? DEFAULT_CLAUDE_SESSION_MODEL;
}

function hasValue(value: string | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * True when a role call has any chance of reaching a model.
 *
 * Deliberately stricter than "the transport is not `none`". With no
 * environment at all, `LLM_TRANSPORT` resolves to `claude-session` by
 * default — but nothing is credentialed, so every call would burn its timeout
 * before falling back. A zero-variable deployment must answer *offline*
 * immediately, because that is the configuration demo mode runs on.
 *
 * A machine already logged into Claude Code has no token in the environment;
 * setting `LLM_TRANSPORT=claude-session` explicitly is how such an operator
 * opts in.
 */
export function transportAvailable(): boolean {
  const env = llmEnv();
  const kind = resolveTransportKind(env['LLM_TRANSPORT']);
  if (kind === 'none') return false;
  // A credential can be configured and still be unable to run on this host: the
  // Claude-session transport spawns the CLI as a subprocess, which a serverless
  // function cannot do. Report *unavailable* there rather than let every role
  // call discover it by burning a spawn timeout, and rather than claim live AI
  // the deployment cannot deliver.
  if (transportCannotRunHere(kind, env)) return false;
  if (kind === 'api') return hasValue(env['ANTHROPIC_API_KEY']);
  return hasValue(env['CLAUDE_CODE_OAUTH_TOKEN']) || hasValue(env['LLM_TRANSPORT']);
}

export interface RolePayload<T> {
  readonly output: T | null;
  readonly fallback: boolean;
  readonly reason?: string;
}

const NO_STORE = {
  'cache-control': 'no-store, no-cache, must-revalidate',
} as const;

/** A successful role response. */
export function ok<T>(output: T | null, fallback: boolean, reason?: string): NextResponse {
  const body: RolePayload<T> = reason === undefined ? { output, fallback } : { output, fallback, reason };
  return NextResponse.json(body, { headers: NO_STORE });
}

/* -------------------------------------------------------------------------- */
/*  Admission                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The three buckets, held on the process rather than on this module.
 *
 * A limiter that starts empty whenever the module registry is rebuilt is not a
 * limit under `next dev`, where compiling a route the process has not served
 * yet re-evaluates everything. Same reasoning, and the same slot, as the
 * runtime credential store.
 */

/** One limiter for the process, shared by every route that may reach a model. */
const limiter = processSingleton('llm.roleLimiter', () => createRateLimiter());

/**
 * The second bucket, charged only to callers who presented no id we minted.
 * Without it, discarding the cookie makes every request a fresh principal and
 * the window above never binds.
 */
const cookielessLimiter = processSingleton('llm.cookielessLimiter', () =>
  createRateLimiter({ limit: RATE_LIMIT_COOKIELESS_PER_WINDOW }),
);

/**
 * A separate, generous bucket for `/chief-of-staff/quick` — see
 * `RATE_LIMIT_QUICK_PER_WINDOW`. Kept off the `limiter` above so the instant
 * offline preview never spends the budget the real model call needs.
 */
const quickAnswerLimiter = processSingleton('llm.quickAnswerLimiter', () =>
  createRateLimiter({ limit: RATE_LIMIT_QUICK_PER_WINDOW }),
);

/**
 * A third, much tighter bucket for writing the Claude credential.
 *
 * It sits *on top of* `admit()`'s window rather than replacing it. Setting a
 * token is configuration, not play: nobody legitimately does it five times a
 * minute, and the endpoint is the one place in the app where guessing is worth
 * an attacker's time.
 */
const tokenWriteLimiter = processSingleton('llm.tokenWriteLimiter', () => createRateLimiter({ limit: TOKEN_WRITE_RATE_LIMIT }));

/**
 * Charge one credential write.
 *
 * The key is composite — see `tokenWriteBudgetKey` — and the caller builds it,
 * because deciding *what a bucket is* is an authority question and belongs
 * beside the rest of them rather than in this plumbing.
 */
export function takeTokenWriteBudget(budgetKey: string, now: number = Date.now()): RateDecision {
  return tokenWriteLimiter.take(budgetKey, now);
}

/**
 * A wrong or absent setup secret is the one refusal an attacker can grind, and
 * the per-principal write budget never sees it (authority is decided before the
 * budget is charged). This bucket throttles the guess itself: a process-wide
 * 10-per-minute ceiling makes a long random `LLM_SETUP_SECRET` uncrackable
 * online, while a legitimate operator fat-fingering the field a few times is
 * nowhere near it.
 */
const setupSecretFailLimiter = processSingleton('llm.setupSecretFailLimiter', () => createRateLimiter({ limit: 10 }));

export function chargeSetupSecretAttempt(originKey: string, now: number = Date.now()): RateDecision {
  return setupSecretFailLimiter.take(originKey, now);
}

/** Headers every route in this folder answers with. */
export const NO_STORE_HEADERS: Readonly<Record<string, string>> = NO_STORE;

/** What a route needs once it has been let in. */
export interface Admission {
  readonly principal: Principal;
  /**
   * True when this request presented no anonymous id and one was minted for it.
   *
   * Role routes do not care — a first call is as legitimate as any other. The
   * credential routes very much do: a minted principal is a caller with no
   * cookie, which is what a cross-site POST looks like and what makes a
   * per-principal rate limit meaningless.
   */
  readonly mintedPrincipal: boolean;
  /**
   * The conversation key for this principal and thread. Derived, never
   * accepted — see `_identity.ts`.
   */
  conversationKey(role: ConversationRole, parts: ConversationParts): string;
  /** Attach anything the admission owes the response, such as a new anonymous id cookie. */
  finish(response: NextResponse): NextResponse;
}

function refuse(status: number, reason: string, extraHeaders: Record<string, string> = {}): NextResponse {
  return NextResponse.json({ output: null, fallback: false, reason }, { status, headers: { ...NO_STORE, ...extraHeaders } });
}

/**
 * Decide whether this request may reach a model at all.
 *
 * Order matters: size before identity (refuse a megabyte without reading it),
 * identity before rate (a limit shared by every anonymous caller would be a
 * denial-of-service surface rather than a protection).
 */
export async function admit(request: Request): Promise<{ ok: true; admission: Admission } | { ok: false; response: NextResponse }> {
  return admitAgainst(request, limiter);
}

/**
 * `admit()`, but charged against `quickAnswerLimiter` instead of the shared
 * model-call budget.
 *
 * For `/chief-of-staff/quick` only — see `RATE_LIMIT_QUICK_PER_WINDOW`. Every
 * other check (size ceiling, identity, the cookieless bucket) is identical:
 * this route still needs a principal and a conversation key, and a caller with
 * no cookie is still worth bounding by origin. What differs is only *which*
 * per-principal window a call spends, because this call never reaches a model.
 */
export async function admitQuick(request: Request): Promise<{ ok: true; admission: Admission } | { ok: false; response: NextResponse }> {
  return admitAgainst(request, quickAnswerLimiter);
}

async function admitAgainst(
  request: Request,
  perPrincipalLimiter: RateLimiter,
): Promise<{ ok: true; admission: Admission } | { ok: false; response: NextResponse }> {
  if (declaresOversizeBody(request.headers)) {
    return { ok: false, response: refuse(413, `body_too_large: at most ${MAX_BODY_BYTES} bytes`) };
  }

  const store = await cookies();
  const outcome = await resolvePrincipal({
    // Admin-verifiable, not merely public-configured: without a service-role
    // key the server cannot check a Supabase session against the admin flag, so
    // demanding a Supabase login would strand every caller. Fall to the
    // anonymous principal (which the setup-secret / local gates build on).
    supabaseConfigured: isSupabaseAdminConfigured(),
    getUserId: async () => {
      const supabase = getRouteClient({
        getAll: () => store.getAll(),
        setAll: (list) => list.forEach(({ name, value, options }) => store.set(name, value, options)),
      });
      if (supabase === null) return null;
      const { data, error } = await supabase.auth.getUser();
      if (error !== null) return null;
      return data.user?.id ?? null;
    },
    anonymousId: store.get(ANONYMOUS_ID_COOKIE)?.value ?? null,
  });

  if (!outcome.ok) return { ok: false, response: refuse(401, 'unauthenticated') };

  const { principal, issuedAnonymousId } = outcome.resolution;
  const now = Date.now();
  const decisions = [perPrincipalLimiter.take(principal.id, now)];
  if (issuedAnonymousId !== null) decisions.push(cookielessLimiter.take(originKey(request.headers), now));

  const refused = decisions.find((decision) => !decision.allowed);
  if (refused !== undefined) {
    return { ok: false, response: refuse(429, 'rate_limited', { 'retry-after': String(refused.retryAfterSeconds) }) };
  }

  const secret = conversationKeySecret();
  return {
    ok: true,
    admission: {
      principal,
      mintedPrincipal: issuedAnonymousId !== null,
      conversationKey: (role, parts) => deriveConversationKey(role, principal, parts, secret),
      finish(response: NextResponse): NextResponse {
        if (issuedAnonymousId !== null) {
          response.cookies.set(ANONYMOUS_ID_COOKIE, issuedAnonymousId, {
            httpOnly: true,
            sameSite: 'lax',
            path: '/',
            maxAge: ANONYMOUS_ID_MAX_AGE_SECONDS,
            // `Secure` only when this request actually arrived over HTTPS. A
            // production build served over plain HTTP — the tailnet-only Pi —
            // would otherwise mint a cookie no browser stores, and every write
            // route would answer `cookie_required` forever.
            secure: requestIsHttps(request),
          });
        }
        return response;
      },
    },
  };
}

/**
 * Did this request arrive over TLS? The URL's own scheme when Next saw it
 * directly; the first `x-forwarded-proto` hop when a proxy terminated TLS.
 */
export function requestIsHttps(request: Request): boolean {
  try {
    if (new URL(request.url).protocol === 'https:') return true;
  } catch {
    /* an unparseable URL is not HTTPS */
  }
  const forwarded = request.headers.get('x-forwarded-proto');
  return forwarded !== null && forwarded.split(',')[0]?.trim().toLowerCase() === 'https';
}

/** The graceful null response every failure path returns. Always HTTP 200. */
export function fallback(reason: string): NextResponse {
  return ok(null, true, reason);
}

/**
 * Parse a request body against a schema.
 *
 * A malformed body is the one case that is genuinely the caller's fault, so it
 * answers 400 rather than pretending a model was consulted.
 */
export async function parseBody<S extends ZodTypeAny>(
  request: Request,
  schema: S,
): Promise<{ ok: true; value: z.infer<S> } | { ok: false; response: NextResponse }> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return {
      ok: false,
      response: NextResponse.json({ output: null, fallback: true, reason: 'invalid_json' }, { status: 400, headers: NO_STORE }),
    };
  }

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      response: NextResponse.json(
        {
          output: null,
          fallback: true,
          reason: 'invalid_body',
          issues: parsed.error.issues.slice(0, 8).map((issue) => `${issue.path.join('.')}: ${issue.message}`),
        },
        { status: 400, headers: NO_STORE },
      ),
    };
  }

  return { ok: true, value: parsed.data };
}

/**
 * Run one role call, converting every failure into the null response.
 *
 * `fallbackUsed` from the role is surfaced so a client can tell the difference
 * between "the model answered" and "the deterministic fallback answered" —
 * without ever having to handle an error.
 */
export async function runRole<T>(
  call: () => Promise<{ output: T | null; fallbackUsed: boolean }>,
): Promise<NextResponse> {
  if (!transportAvailable()) return fallback('transport_none');
  try {
    const result = await call();
    return ok(result.output, result.fallbackUsed);
  } catch (error) {
    return fallback(error instanceof Error ? `role_error: ${error.message.slice(0, 160)}` : 'role_error');
  }
}
