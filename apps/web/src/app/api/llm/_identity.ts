/**
 * Who is calling an LLM route, what they may resume, and how often.
 *
 * **Server only.** Everything here is pure and injectable so it can be tested
 * without a request scope; `_gateway.ts` does the Next-specific wiring.
 *
 * Three separate problems, and they are easy to confuse:
 *
 * 1. **Identity.** With Supabase configured, a caller is the user their auth
 *    cookie proves them to be, and the seat is derived from that — never from
 *    the request body. With no Supabase (demo mode) there is nobody to
 *    authenticate, so each browser gets an opaque id in a cookie. That id is
 *    not a security boundary; it is what stops two people on one deployment
 *    from landing in each other's Chief of Staff transcript.
 *
 * 2. **Conversation keys.** The transport resumes a Claude Code session by the
 *    key it is handed, so the key decides *whose transcript* a reply is written
 *    into and quoted from. A key a client can choose is therefore a way to read
 *    somebody else's briefing. Routes accept only the *parts* of a
 *    conversation — game session, seat, thread — and derive the key here as an
 *    HMAC under a server secret, so a caller cannot name a key at all, cannot
 *    reach another principal's thread by guessing ids, and cannot resume a
 *    Chief of Staff session through the character route: the role is part of
 *    the signed material and of the prefix.
 *
 * 3. **Rate.** Every role call spends the operator's Claude subscription. A
 *    small sliding window per principal keeps one loop from exhausting it.
 */

import { createHmac, randomBytes, randomUUID } from 'node:crypto';

/* -------------------------------------------------------------------------- */
/*  The signing secret                                                         */
/* -------------------------------------------------------------------------- */

/** Cookie holding the per-browser id used when there is nobody to authenticate. */
export const ANONYMOUS_ID_COOKIE = 'fc_anon_id';

/** How long the anonymous id cookie lives. Long enough for a campaign. */
export const ANONYMOUS_ID_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

let processSecret: string | null = null;

/**
 * The HMAC key for conversation keys.
 *
 * `LLM_KEY_SECRET` when the operator sets one. Otherwise a random per-process
 * secret, which is exactly right for the deployment this defaults to: the
 * session store is a process-local map, so a secret that dies with the process
 * outlives everything it protects. A multi-instance deployment that wants
 * continuity across instances must set the variable, and will also need a
 * shared session store.
 */
export function conversationKeySecret(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const configured = env['LLM_KEY_SECRET'];
  if (typeof configured === 'string' && configured.trim().length > 0) return configured.trim();
  processSecret ??= randomBytes(32).toString('hex');
  return processSecret;
}

/* -------------------------------------------------------------------------- */
/*  Principals                                                                 */
/* -------------------------------------------------------------------------- */

export type PrincipalKind = 'supabase' | 'anonymous';

export interface Principal {
  /** Stable per authenticated user, or per browser in demo mode. Never sent to a client. */
  readonly id: string;
  readonly kind: PrincipalKind;
}

export interface PrincipalResolution {
  readonly principal: Principal;
  /**
   * A newly minted anonymous id the response must set as a cookie, or null when
   * the caller already had one (or is authenticated).
   */
  readonly issuedAnonymousId: string | null;
}

export type PrincipalOutcome = { ok: true; resolution: PrincipalResolution } | { ok: false; reason: 'unauthenticated' };

export interface PrincipalRequest {
  /** True when the deployment has Supabase configured, and therefore real accounts. */
  readonly supabaseConfigured: boolean;
  /** Reads the verified user from the request's auth cookies. Returns null when there is none. */
  readonly getUserId: () => Promise<string | null>;
  /** The anonymous id the browser already presented, or null. */
  readonly anonymousId: string | null;
  /** Mints a fresh anonymous id. Injected so a test never depends on entropy. */
  readonly newAnonymousId?: () => string;
}

/**
 * Resolve the caller.
 *
 * With Supabase configured this is an authority check and it fails closed: an
 * unauthenticated call is 401, not a deterministic fallback. A fallback answers
 * "the model was unavailable", which is a different — and here, dishonest —
 * statement.
 */
export async function resolvePrincipal(request: PrincipalRequest): Promise<PrincipalOutcome> {
  if (request.supabaseConfigured) {
    let userId: string | null;
    try {
      userId = await request.getUserId();
    } catch {
      userId = null;
    }
    if (userId === null || userId.length === 0) return { ok: false, reason: 'unauthenticated' };
    return { ok: true, resolution: { principal: { id: userId, kind: 'supabase' }, issuedAnonymousId: null } };
  }

  const existing = request.anonymousId;
  if (existing !== null && isPlausibleAnonymousId(existing)) {
    return { ok: true, resolution: { principal: { id: existing, kind: 'anonymous' }, issuedAnonymousId: null } };
  }

  const minted = (request.newAnonymousId ?? randomUUID)();
  return { ok: true, resolution: { principal: { id: minted, kind: 'anonymous' }, issuedAnonymousId: minted } };
}

/**
 * Is this a cookie value we minted?
 *
 * A cookie is client-controlled, so it is never trusted as *identity* — only as
 * a partition. The shape check keeps a hostile value from growing the key
 * material without bound; it is not, and cannot be, authentication.
 */
export function isPlausibleAnonymousId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
}

/* -------------------------------------------------------------------------- */
/*  Conversation keys                                                          */
/* -------------------------------------------------------------------------- */

/** The two conversational roles. Each gets its own key namespace. */
export type ConversationRole = 'cos' | 'chr';

/** The parts of a conversation a client is allowed to name. */
export interface ConversationParts {
  /** The *game* session — never a Claude session. */
  readonly gameSessionId: string;
  /** The seat within it. Ignored in favour of the verified identity when there is one. */
  readonly playerId: string;
  /** The thread within the seat: `main` for the Chief of Staff, a character id for dialogue. */
  readonly conversationId: string;
}

/**
 * The seat a conversation belongs to.
 *
 * Authenticated: the principal *is* the seat, and the body's `playerId` is
 * discarded — otherwise a signed-in user could name someone else's seat.
 * Anonymous: there is no authority to derive a seat from, so the body's value
 * is used as a plain thread selector. It is safe there only because the whole
 * key is already namespaced under a per-browser id.
 */
export function seatFor(principal: Principal, parts: ConversationParts): string {
  return principal.kind === 'supabase' ? principal.id : parts.playerId;
}

/**
 * The key the transport resumes a Claude session from.
 *
 * `<role>:<hmac-sha256(role, principal, game session, seat, thread)>`. The
 * digest is one-way, so the key discloses nothing; the role is inside both the
 * prefix and the signed material, so a `cos:` thread can never be resumed
 * through the character route; and no part of it can be supplied directly.
 */
export function deriveConversationKey(role: ConversationRole, principal: Principal, parts: ConversationParts, secret: string): string {
  const material = [role, principal.kind, principal.id, parts.gameSessionId, seatFor(principal, parts), parts.conversationId]
    .map((part) => encodeURIComponent(part))
    .join(':');
  return `${role}:${createHmac('sha256', secret).update(material).digest('hex')}`;
}

/* -------------------------------------------------------------------------- */
/*  Rate limiting                                                              */
/* -------------------------------------------------------------------------- */

/** Calls one principal may make in `RATE_LIMIT_WINDOW_MS`. */
export const RATE_LIMIT_PER_WINDOW = 20;

/**
 * Calls one principal may make to `/chief-of-staff/quick` in
 * `RATE_LIMIT_WINDOW_MS` — a **separate** bucket from `RATE_LIMIT_PER_WINDOW`.
 *
 * The quick route answers from `offlineChiefOfStaff`: pure arithmetic over the
 * typed dossier, no transport, no concurrency-limiter permit, no Claude Code
 * subprocess. It exists specifically so the founder is never staring at a bare
 * spinner while the real call is still queued — so it must never itself be why
 * the real call gets a 429. Sharing `RATE_LIMIT_PER_WINDOW` with the model
 * routes would spend a slot of the *model* budget on a call that never reaches
 * a model, halving the real budget for exactly the two-request pattern this
 * route was built to support (`useChiefOfStaff.ts` fires both on every
 * question). Generous rather than tight: nothing here spawns a subprocess or
 * queues behind one, so the only thing this bucket needs to bound is a loop.
 */
export const RATE_LIMIT_QUICK_PER_WINDOW = 120;

/** The sliding window. One minute. */
export const RATE_LIMIT_WINDOW_MS = 60_000;

/** How many principals the limiter remembers before evicting the coldest. */
export const RATE_LIMIT_MAX_PRINCIPALS = 5_000;

/**
 * Calls one network origin may make *without presenting an id we minted*.
 *
 * Without this the per-principal window is trivially escaped: a caller that
 * throws its cookie away is a new principal on every request and never meets a
 * limit at all. In normal play exactly one POST per browser is cookieless — the
 * World Director call that starts a quarter, after which every request carries
 * the id — so this can be generous and still bound a loop.
 */
export const RATE_LIMIT_COOKIELESS_PER_WINDOW = 60;

/**
 * A coarse identifier for where a request came from, for the cookieless bucket
 * only.
 *
 * The forwarded headers are set by the platform in front of the app and are
 * forgeable by anything that reaches the app directly, so this is a
 * throttling hint and never an identity. Callers that present nothing usable
 * share one bucket, which is the correct answer for local development and a
 * safe answer for anyone hiding their origin.
 */
export function originKey(headers: Headers): string {
  const forwarded = headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  if (forwarded !== undefined && forwarded.length > 0 && forwarded.length <= 64) return forwarded;
  const real = headers.get('x-real-ip')?.trim();
  if (real !== undefined && real.length > 0 && real.length <= 64) return real;
  return 'unattributed';
}

export interface RateDecision {
  readonly allowed: boolean;
  /** Whole seconds until the oldest call in the window ages out. Zero when allowed. */
  readonly retryAfterSeconds: number;
  readonly remaining: number;
}

export interface RateLimiter {
  /** Record an attempt at `now` (a millisecond clock) and say whether it may proceed. */
  take(key: string, now: number): RateDecision;
  reset(): void;
}

export interface RateLimiterConfig {
  readonly limit?: number;
  readonly windowMs?: number;
  readonly maxKeys?: number;
}

/**
 * A sliding-window limiter over an in-memory map.
 *
 * Process-local, like the session store it protects, and honest about it: on a
 * multi-instance deployment each instance enforces its own window. That is
 * still a bound, and it is a great deal better than none. The clock is a
 * parameter so tests are deterministic — no wall clock reaches this module.
 */
export function createRateLimiter(config: RateLimiterConfig = {}): RateLimiter {
  const limit = config.limit ?? RATE_LIMIT_PER_WINDOW;
  const windowMs = config.windowMs ?? RATE_LIMIT_WINDOW_MS;
  const maxKeys = config.maxKeys ?? RATE_LIMIT_MAX_PRINCIPALS;
  const hits = new Map<string, number[]>();

  return {
    take(key: string, now: number): RateDecision {
      const cutoff = now - windowMs;
      const recent = (hits.get(key) ?? []).filter((at) => at > cutoff);

      if (recent.length >= limit) {
        hits.set(key, recent);
        const oldest = recent[0] ?? now;
        return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((oldest + windowMs - now) / 1000)), remaining: 0 };
      }

      recent.push(now);
      // Re-inserting moves the key to the end of the iteration order, so the
      // eviction below drops whoever has been quiet longest.
      hits.delete(key);
      hits.set(key, recent);

      while (hits.size > maxKeys) {
        const coldest = hits.keys().next();
        if (coldest.done === true) break;
        hits.delete(coldest.value);
      }

      return { allowed: true, retryAfterSeconds: 0, remaining: limit - recent.length };
    },
    reset(): void {
      hits.clear();
    },
  };
}

/* -------------------------------------------------------------------------- */
/*  Request size                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Bytes a role request body may declare.
 *
 * Generous next to the field bounds in `_bounds.ts` and deliberately so: this
 * is the cheap check that refuses a megabyte before it is read and parsed,
 * while the field bounds are what decide whether a *legible* body is
 * reasonable.
 */
export const MAX_BODY_BYTES = 256 * 1024;

/** True when the declared `content-length` is over the ceiling. An absent header is not a pass — the field bounds still apply. */
export function declaresOversizeBody(headers: Headers, max: number = MAX_BODY_BYTES): boolean {
  const declared = Number.parseInt(headers.get('content-length') ?? '', 10);
  return Number.isFinite(declared) && declared > max;
}
