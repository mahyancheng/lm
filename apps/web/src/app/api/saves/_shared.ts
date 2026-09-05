/**
 * What every `/api/saves` route needs.
 *
 * **Server only**, and deliberately thin: the rules live in
 * `@/lib/saves/store` (pure, tested against a temp directory) and in
 * `../llm/_runtime` (the CSRF decision, already tested). This module reads
 * headers and the environment, hands the facts over, and shapes the answer.
 *
 * ## What these routes are, and are not
 *
 * They are not an account system. The Pi is reachable on the tailnet only, so
 * everyone who can send a request is the household, and a password would be
 * theatre. What the routes must still refuse is a *forged* request: a page on
 * another origin must not be able to make a household browser delete a save.
 * That is `checkWriteRequest`, the same gate the credential routes use, and it
 * runs before anything is read or written.
 *
 * ## The size ceiling, twice
 *
 * A declared `content-length` over the ceiling is refused before the body is
 * touched at all. A body that lies about its length — or declares none — is
 * refused while it streams, at the byte that crosses the line, so an endless
 * upload cannot be buffered into the Pi's memory on the way to being rejected.
 */

import { NextResponse } from 'next/server';
import { createRateLimiter, originKey } from '../llm/_identity';
import { checkWriteRequest, processSingleton } from '../llm/_runtime';
import { MAX_SAVE_BYTES, type SaveStore, saveStoreFrom } from '@/lib/saves/store';

/** Saves are per-player state; nothing about them may be cached by anything. */
export const NO_STORE_HEADERS: Readonly<Record<string, string>> = {
  'cache-control': 'no-store, no-cache, must-revalidate',
  pragma: 'no-cache',
};

export function json(body: unknown, status = 200, extraHeaders: Record<string, string> = {}): NextResponse {
  return NextResponse.json(body, { status, headers: { ...NO_STORE_HEADERS, ...extraHeaders } });
}

/* -------------------------------------------------------------------------- */
/*  The store                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The store this process serves, or null when `SAVE_DIR` is unset.
 *
 * Null is not an error: it is the default, and it means the client keeps every
 * save in `localStorage` exactly as it did before these routes existed. The
 * listing route says so as `enabled: false`; the rest answer 404 rather than
 * pretending to have stored something.
 */
export function store(): SaveStore | null {
  return saveStoreFrom(process.env);
}

/** The refusal every route sends when this host does not do server saves. */
export function savesDisabled(): NextResponse {
  return json({ ok: false, reason: 'saves_disabled' }, 404);
}

/* -------------------------------------------------------------------------- */
/*  Forgery                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Refuse a state-changing request this app's own page did not make.
 *
 * Runs first in `PUT` and `DELETE`, before the store is resolved or a byte of
 * body is read: a forged request should cost this process a header comparison
 * and nothing else.
 */
export function guardWriteRequest(request: Request, requiresJson: boolean): NextResponse | null {
  const decision = checkWriteRequest({
    secFetchSite: request.headers.get('sec-fetch-site'),
    origin: request.headers.get('origin'),
    host: request.headers.get('host'),
    contentType: request.headers.get('content-type'),
    requiresJson,
  });
  return decision.ok ? null : json({ ok: false, reason: decision.reason }, decision.status);
}

/* -------------------------------------------------------------------------- */
/*  Rate limits                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Two light buckets, on the process rather than on this module — a limiter that
 * empties whenever `next dev` rebuilds the module registry is not a limit.
 *
 * Reads are generous because a picker lists profiles on every visit. Writes are
 * tighter, but nowhere near what an autosaving session needs: the client
 * debounces and coalesces, so a real game sends a handful a minute.
 */
const readLimiter = processSingleton('saves.readLimiter', () => createRateLimiter({ limit: 120 }));
const writeLimiter = processSingleton('saves.writeLimiter', () => createRateLimiter({ limit: 60 }));

interface Chargeable {
  take(key: string, now: number): { readonly allowed: boolean; readonly retryAfterSeconds: number };
}

function charge(limiter: Chargeable, request: Request): NextResponse | null {
  const decision = limiter.take(originKey(request.headers), Date.now());
  if (decision.allowed) return null;
  return json({ ok: false, reason: 'rate_limited' }, 429, { 'retry-after': String(decision.retryAfterSeconds) });
}

export function chargeRead(request: Request): NextResponse | null {
  return charge(readLimiter, request);
}

export function chargeWrite(request: Request): NextResponse | null {
  return charge(writeLimiter, request);
}

/** Empty both buckets. For tests; nothing in the app calls it. */
export function resetSaveLimiters(): void {
  readLimiter.reset();
  writeLimiter.reset();
}

/* -------------------------------------------------------------------------- */
/*  The body                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Bytes a `PUT` body may be.
 *
 * The save itself is capped at `MAX_SAVE_BYTES`; the envelope around it is
 * `{"file":…,"ifRevision":N,"displayName":"…"}`, which is under a hundred
 * bytes. The slack is deliberately small so the request ceiling means the same
 * thing as the save ceiling.
 */
export const MAX_REQUEST_BYTES = MAX_SAVE_BYTES + 8 * 1024;

export type BodyRead =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly status: 400 | 413; readonly reason: 'save_too_large' | 'invalid_json' };

/**
 * Read a JSON body under a hard byte ceiling.
 *
 * The declared length is checked first, so an honest oversized upload is
 * refused without being read. The stream is then counted as it arrives and
 * abandoned the moment it crosses the ceiling, so a body that declares nothing
 * — or lies — cannot be buffered past it either.
 */
export async function readBoundedJson(request: Request, maxBytes = MAX_REQUEST_BYTES): Promise<BodyRead> {
  const declared = Number(request.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > maxBytes) return { ok: false, status: 413, reason: 'save_too_large' };

  let text: string;
  const body = request.body;
  if (body === null) {
    // No stream to meter (a synthesised Request, or an empty body): buffer it,
    // then apply the same ceiling to what actually arrived.
    text = await request.text();
    if (Buffer.byteLength(text, 'utf8') > maxBytes) return { ok: false, status: 413, reason: 'save_too_large' };
  } else {
    const reader = body.getReader();
    const chunks: Buffer[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done === true) break;
        if (value === undefined) continue;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel().catch(() => undefined);
          return { ok: false, status: 413, reason: 'save_too_large' };
        }
        chunks.push(Buffer.from(value));
      }
    } catch {
      return { ok: false, status: 400, reason: 'invalid_json' };
    }
    text = Buffer.concat(chunks).toString('utf8');
  }

  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, status: 400, reason: 'invalid_json' };
  }
}
