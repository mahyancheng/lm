/**
 * What `/api/llm/token` and `/api/llm/token/test` both need.
 *
 * **Server only.** A Next route module may export nothing but its handlers and
 * the runtime flags, so the shared authority rules and the descriptor builder
 * live here rather than being re-exported from a route.
 *
 * The two routes deliberately share one gate. Setting a credential and spending
 * a live call on it are the same privilege: if a caller may do the first, the
 * second tells them whether it worked, and if they may not do the first there
 * is no reason to let them burn the operator's subscription proving the point.
 *
 * Every rule below is decided by a pure function in `_runtime.ts`. This module
 * only reads headers and the environment and hands the facts over, so the
 * matrix can be tested without a request scope.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import {
  type TokenMutationResult,
  type TokenStatusFull,
  TOKEN_MAX_LENGTH,
  TOKEN_MIN_LENGTH,
} from '@/lib/llm/token';
import { getServiceClient, isSupabaseConfigured } from '@/lib/supabase/server';
import { NO_STORE_HEADERS, modelName, takeTokenWriteBudget, transportAvailable, transportKind } from '../_gateway';
import type { Principal } from '../_identity';
import {
  type ConnectionFacts,
  type TokenIntent,
  type TokenWriteDecision,
  TOKEN_SETUP_ENV,
  authorizeTokenWrite,
  buildTokenStatus,
  checkWriteRequest,
  isLocalConnection,
  tokenWriteBudgetKey,
  tokenWriteOriginKey,
} from '../_runtime';

/** The pasted credential, bounded exactly as the paste field bounds it. */
export const TokenBodySchema = z.object({
  token: z
    .string()
    .trim()
    .min(TOKEN_MIN_LENGTH, `A credential is at least ${TOKEN_MIN_LENGTH} characters.`)
    .max(TOKEN_MAX_LENGTH, `A credential is at most ${TOKEN_MAX_LENGTH} characters.`)
    .refine((value) => !/\s/.test(value), 'A credential contains no whitespace.'),
});

export function json(body: unknown, status = 200, extraHeaders: Record<string, string> = {}): NextResponse {
  return NextResponse.json(body, { status, headers: { ...NO_STORE_HEADERS, ...extraHeaders } });
}

/* -------------------------------------------------------------------------- */
/*  Reading the request                                                        */
/* -------------------------------------------------------------------------- */

/** Everything `isLocalConnection` is allowed to judge this deployment's posture on. */
export function connectionFacts(request: Request): ConnectionFacts {
  return {
    optIn: process.env[TOKEN_SETUP_ENV],
    host: request.headers.get('host'),
    forwardedFor: request.headers.get('x-forwarded-for'),
  };
}

/**
 * Refuse a state-changing request that this app's own page did not make.
 *
 * Runs **before** `admit()` and therefore before anything is minted, read or
 * spent: a forged request should cost the process a header comparison and
 * nothing else, and must never leave a cookie behind that a later forgery could
 * present as an established principal.
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
/*  The descriptor                                                             */
/* -------------------------------------------------------------------------- */

/**
 * The credential descriptor, as every verb reports it.
 *
 * This function's whole job is to gather five facts from the gateway and the
 * request; the body is assembled by `buildTokenStatus`, which is pure and is
 * where the "never carries the credential" guarantee is tested. The baseline
 * handed over is the *process* environment — whether the runtime override is in
 * force is that function's decision, not something to pre-empt with an
 * already-merged view.
 */
export function describeCredential(request: Request): TokenStatusFull {
  return buildTokenStatus({
    base: process.env,
    transport: transportKind(),
    model: modelName(),
    available: transportAvailable(),
    supabaseConfigured: isSupabaseConfigured(),
    localConnection: isLocalConnection(connectionFacts(request)),
  });
}

/** The answer to a write. Its reader has just proved they may set the credential, so it carries the descriptor. */
export function mutationResult(request: Request, ok: boolean): TokenMutationResult {
  const status = describeCredential(request);
  return { ok, source: status.source, transportKind: status.transportKind, masked: status.masked, kind: status.kind };
}

/* -------------------------------------------------------------------------- */
/*  Authority                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Read `profiles.is_admin` for a verified user.
 *
 * The service-role client, because the flag is exactly the kind of thing a
 * client must not be able to assert about itself. Every failure — no service
 * key, no row, a query error — answers false: an unverifiable claim is not a
 * grant.
 */
async function isAdminUser(userId: string): Promise<boolean> {
  const supabase = getServiceClient();
  if (supabase === null) return false;
  try {
    const { data, error } = await supabase.from('profiles').select('is_admin').eq('id', userId).maybeSingle();
    if (error !== null) return false;
    return (data as { is_admin?: boolean } | null)?.is_admin === true;
  } catch {
    return false;
  }
}

/** What both the read and the write decision are made from. */
export interface TokenCaller {
  readonly principal: Principal;
  /** From `admit()`: true when this request presented no cookie and one was minted for it. */
  readonly mintedPrincipal: boolean;
}

export async function decideTokenWrite(request: Request, caller: TokenCaller, intent: TokenIntent): Promise<TokenWriteDecision> {
  const supabaseConfigured = isSupabaseConfigured();
  const isAdmin = supabaseConfigured && caller.principal.kind === 'supabase' ? await isAdminUser(caller.principal.id) : false;
  return authorizeTokenWrite({
    supabaseConfigured,
    principal: caller.principal,
    isAdmin,
    mintedPrincipal: caller.mintedPrincipal,
    localConnection: isLocalConnection(connectionFacts(request)),
    intent,
  });
}

/**
 * May this caller be told which credential is in force?
 *
 * The same rule as writing it, minus the established-cookie requirement: a
 * browser that has just been given its cookie is about to be allowed to write,
 * so withholding the descriptor from it would only mean the settings sheet
 * showed nothing on first open and everything on second.
 */
export async function mayReadDescriptor(request: Request, caller: TokenCaller): Promise<boolean> {
  return (await decideTokenWrite(request, caller, 'read')).ok;
}

/**
 * Authority, then budget, in that order.
 *
 * A refusal is cheap and a write is not, so an unauthorised caller never
 * reaches the limiter — and therefore can never spend a legitimate principal's
 * window by being refused loudly enough.
 *
 * The budget is charged to a composite of the principal and the origin key,
 * which is deliberately blind to `x-forwarded-for`: a bucket a caller can
 * rotate by editing a header is not a bucket.
 *
 * Returns the refusal to send, or null to proceed.
 */
export async function gateTokenWrite(request: Request, caller: TokenCaller): Promise<NextResponse | null> {
  const decision = await decideTokenWrite(request, caller, 'write');
  if (!decision.ok) return json({ ok: false, reason: decision.reason }, decision.status);

  const budgetKey = tokenWriteBudgetKey(caller.principal.id, tokenWriteOriginKey(request.headers));
  const budget = takeTokenWriteBudget(budgetKey);
  if (!budget.allowed) {
    return json({ ok: false, reason: 'rate_limited' }, 429, { 'retry-after': String(budget.retryAfterSeconds) });
  }
  return null;
}
