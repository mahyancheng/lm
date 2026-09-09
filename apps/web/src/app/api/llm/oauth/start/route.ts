/**
 * `POST /api/llm/oauth/start` — mint a one-time subscription-connect link.
 *
 * This is the "click a button and a link comes out" half of in-app setup. The
 * server generates the PKCE verifier and the state, holds them against a random
 * flow id for fifteen minutes, and answers with the authorize link and the id.
 * The **verifier never leaves the process** — that is what makes the link safe
 * to hand to a browser: copying it is not enough to complete the flow, because
 * finishing requires the verifier this server alone holds.
 *
 * ## Authority
 *
 * Exactly the write gate the token routes use, and for the same reason: a
 * completed flow sets the credential every player's calls are billed against.
 * So this runs the CSRF guard, `admit()`, and `gateTokenWrite` — which means it
 * is allowed on a public deployment only when the caller is a verified admin, is
 * on the machine, or presents the setup secret, and it is charged the same tight
 * five-a-minute write budget. Starting a flow spends nothing upstream, but
 * gating it keeps an unauthorised caller from farming links.
 */

import { buildClaudeAuthorizeUrl, createOAuthState, createPkcePair } from '@frontier/llm';
import type { OAuthStartResult } from '@/lib/llm/token';
import { admit } from '../../_gateway';
import { startOAuthFlow } from '../../_runtime';
import { gateTokenWrite, guardWriteRequest, json } from '../../token/_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  const forged = guardWriteRequest(request, true);
  if (forged !== null) return forged;

  const admission = await admit(request);
  if (!admission.ok) return admission.response;
  const { finish, principal, mintedPrincipal } = admission.admission;

  const refusal = await gateTokenWrite(request, { principal, mintedPrincipal });
  if (refusal !== null) return finish(refusal);

  const { verifier, challenge } = createPkcePair();
  const state = createOAuthState();
  const { flowId } = startOAuthFlow({ verifier, state });
  const authorizeUrl = buildClaudeAuthorizeUrl({ challenge, state });

  const body: OAuthStartResult = { ok: true, flowId, authorizeUrl };
  return finish(json(body));
}
