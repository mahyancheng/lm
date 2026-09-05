/**
 * `POST /api/llm/oauth/finish` — complete an in-app subscription connect.
 *
 * The person pasted back what the Claude callback page showed them. This looks
 * up the flow the verifier is held against, exchanges the code, and — on
 * success — stores the resulting token as the runtime credential, exactly as a
 * paste would. **The token is never returned**; the browser is told only its
 * mask and which transport it selected.
 *
 * ## The two halves of the pasted value
 *
 * The CLI's manual-redirect page prints the authorization code as `code#state`.
 * We split on `#`: the left half is the code to exchange, and the right half, if
 * present, must equal the state this server stored when it started the flow. A
 * code minted for someone else's flow therefore fails the state check before it
 * is ever sent upstream.
 *
 * ## Single use, and honest failure
 *
 * The flow is taken exactly once — found, expired, or missing, it is removed —
 * so a code cannot be replayed. Every failure is a named, un-misleading reason:
 * an expired flow, a bad state, a rejected code, an upstream error, or a dead
 * network. If the exchange itself is impossible we would say so rather than
 * pretend; here it is fully implemented against the CLI's own endpoint.
 *
 * ## Authority
 *
 * The same write gate as everything else in this folder — CSRF guard,
 * `admit()`, `gateTokenWrite` — so on a public deployment only an admin, a local
 * caller, or the holder of the setup secret can finish a connect, and the tight
 * write budget applies.
 */

import type { NextResponse } from 'next/server';
import { z } from 'zod';
import { exchangeClaudeOAuthCode } from '@frontier/llm';
import type { OAuthFinishFailure, OAuthFinishResult } from '@/lib/llm/token';
import { admit, transportKind } from '../../_gateway';
import { setRuntimeCredential, takeOAuthFlow } from '../../_runtime';
import { gateTokenWrite, guardWriteRequest, json } from '../../token/_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Bounds a pasted code+state generously — a few hundred characters — while refusing a page of junk. */
const FinishBodySchema = z.object({
  flowId: z.string().trim().min(1).max(200),
  code: z.string().trim().min(1).max(4096),
});

function fail(failure: OAuthFinishFailure, detail: string, status = 200): NextResponse {
  const body: OAuthFinishResult = { ok: false, failure, detail };
  return json(body, status);
}

/** Constant-time-ish state comparison. Rejects on any length or content difference without an early-out on length. */
function statesMatch(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function POST(request: Request): Promise<Response> {
  const forged = guardWriteRequest(request, true);
  if (forged !== null) return forged;

  const admission = await admit(request);
  if (!admission.ok) return admission.response;
  const { finish, principal, mintedPrincipal } = admission.admission;

  const refusal = await gateTokenWrite(request, { principal, mintedPrincipal });
  if (refusal !== null) return finish(refusal);

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return finish(fail('invalid_request', 'The request body was not valid JSON.', 400));
  }

  const parsed = FinishBodySchema.safeParse(raw);
  if (!parsed.success) {
    return finish(fail('invalid_request', 'Paste the code the Claude page showed you.', 400));
  }

  // The pasted value may be `code#state`. Split once: everything before the
  // first '#' is the code, the remainder (if any) is the state to verify.
  const hashAt = parsed.data.code.indexOf('#');
  const code = hashAt === -1 ? parsed.data.code : parsed.data.code.slice(0, hashAt);
  const returnedState = hashAt === -1 ? null : parsed.data.code.slice(hashAt + 1);
  if (code.length === 0) {
    return finish(fail('invalid_request', 'That did not contain an authorization code.', 400));
  }

  const flow = takeOAuthFlow(parsed.data.flowId);
  if (!flow.ok) {
    return finish(fail('expired_flow', 'This connect attempt has expired or was already used. Start again.'));
  }

  // The manual-redirect page always prints the code as `code#state`, so a
  // missing state is not a benign omission — it means the pasted value is not
  // what this flow issued. Require it present and matching: every finish is
  // then bound to the state its own start minted, closing the OAuth CSRF leg.
  if (returnedState === null || !statesMatch(returnedState, flow.state)) {
    return finish(fail('bad_state', 'The code did not match this connect attempt. Paste the whole code the page showed you (it ends in #…), or start again with the newest link.'));
  }

  const result = await exchangeClaudeOAuthCode({ code, verifier: flow.verifier, state: flow.state });
  if (!result.ok) {
    const failure: OAuthFinishFailure =
      result.error === 'expired_code' ? 'expired_code' : result.error === 'network' ? 'network' : 'exchange_failed';
    return finish(fail(failure, result.detail));
  }

  // Store it exactly as a paste would: the classifier reads the sk-ant-oat…
  // prefix and selects the Claude-session transport, and the next gateway build
  // sees the bumped generation.
  const descriptor = setRuntimeCredential(result.token);
  const body: OAuthFinishResult = {
    ok: true,
    masked: descriptor.masked,
    transportKind: transportKind(),
    kind: descriptor.kind,
  };
  return finish(json(body));
}
