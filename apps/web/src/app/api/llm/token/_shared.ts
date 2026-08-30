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
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { type TokenMutationResult, type TokenStatus, TOKEN_MAX_LENGTH, TOKEN_MIN_LENGTH } from '@/lib/llm/token';
import { getServiceClient, isSupabaseConfigured } from '@/lib/supabase/server';
import { NO_STORE_HEADERS, modelName, takeTokenWriteBudget, transportAvailable, transportKind } from '../_gateway';
import type { Principal } from '../_identity';
import { type TokenWriteDecision, authorizeTokenWrite, buildTokenStatus } from '../_runtime';

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

/**
 * The credential descriptor, as every verb reports it.
 *
 * This function's whole job is to gather four facts from the gateway; the body
 * is assembled by `buildTokenStatus`, which is pure and is where the "never
 * carries the credential" guarantee is tested. The baseline handed over is the
 * *process* environment — whether the runtime override is in force is that
 * function's decision, not something to pre-empt with an already-merged view.
 */
export function describeCredential(): TokenStatus {
  return buildTokenStatus({
    base: process.env,
    transport: transportKind(),
    model: modelName(),
    available: transportAvailable(),
    supabaseConfigured: isSupabaseConfigured(),
  });
}

export function mutationResult(ok: boolean): TokenMutationResult {
  const status = describeCredential();
  return { ok, source: status.source, transportKind: status.transportKind, masked: status.masked, kind: status.kind };
}

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

export async function decideTokenWrite(principal: Principal): Promise<TokenWriteDecision> {
  const supabaseConfigured = isSupabaseConfigured();
  const isAdmin = supabaseConfigured && principal.kind === 'supabase' ? await isAdminUser(principal.id) : false;
  return authorizeTokenWrite({ supabaseConfigured, principal, isAdmin });
}

/**
 * Authority, then budget, in that order.
 *
 * A refusal is cheap and a write is not, so an unauthorised caller never
 * reaches the limiter — and therefore can never spend a legitimate principal's
 * window by being refused loudly enough.
 *
 * Returns the refusal to send, or null to proceed.
 */
export async function gateTokenWrite(principal: Principal): Promise<NextResponse | null> {
  const decision = await decideTokenWrite(principal);
  if (!decision.ok) return json({ ok: false, reason: decision.reason }, decision.status);

  const budget = takeTokenWriteBudget(principal.id);
  if (!budget.allowed) {
    return json({ ok: false, reason: 'rate_limited' }, 429, { 'retry-after': String(budget.retryAfterSeconds) });
  }
  return null;
}
