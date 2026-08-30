/**
 * `POST /api/llm/token/test` — spend one real call to prove the credential works.
 *
 * **This is the only route in the app that deliberately costs a model call**,
 * and it does so only when a person clicks "Test connection". Every other route
 * either falls back deterministically or is part of playing a quarter.
 *
 * ## Why the narrator
 *
 * It is the cheapest honest probe available. The narrator has the least
 * authority of the seven roles — it explains committed facts and decides
 * nothing — so a fixture of one invented line cannot influence any game state,
 * and there is no session to resume, no conversation key, and no player data in
 * the prompt. The alternative, a dedicated ping, would test a path no role
 * uses, which is the wrong thing to be confident about.
 *
 * ## What a failure means
 *
 * `fallbackUsed` is the signal, and its reason is classified rather than shown
 * raw, because "disabled" and "the model wrote something that did not parse"
 * call for opposite reactions from the operator: regenerate the token, or leave
 * it alone. `invalid_output` is reported as a **success** — something on the
 * other end of that credential answered, which is exactly what a connection
 * test asks.
 *
 * Authority is the same gate as writing the credential: if a caller may not set
 * a token, there is no reason to let them burn the operator's subscription.
 * That includes the cross-site checks — this route spends money, so a page on
 * another origin must not be able to make a visiting developer's browser press
 * "Test connection" in a loop — and the established-cookie rule, which is why
 * the request carries a JSON content type it has no body for.
 */

import type { NarratorInput } from '@frontier/contracts';
import { type TokenTestResult, classifyTestFailure } from '@/lib/llm/token';
import { admit, gateway, modelName, transportAvailable } from '../../_gateway';
import { gateTokenWrite, guardWriteRequest, json } from '../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The smallest input the narrator will accept: one committed line, no focus
 * company, and a session id that names what this is so a stray run record is
 * self-explanatory. Nothing here is game state.
 */
const PROBE: NarratorInput = {
  sessionId: 'connection-test',
  quarter: 0,
  committedLines: [{ phase: 'setup', text: 'The connection test ran.', deltaLabel: null }],
  focusCompanyId: null,
};

export async function POST(request: Request): Promise<Response> {
  const forged = guardWriteRequest(request, true);
  if (forged !== null) return forged;

  const admission = await admit(request);
  if (!admission.ok) return admission.response;
  const { finish, principal, mintedPrincipal } = admission.admission;

  const refusal = await gateTokenWrite(request, { principal, mintedPrincipal });
  if (refusal !== null) return finish(refusal);

  if (!transportAvailable()) {
    const body: TokenTestResult = {
      ok: false,
      failure: 'transport_unavailable',
      detail: 'No credential is configured, so there is nothing to test.',
      latencyMs: 0,
    };
    return finish(json(body));
  }

  try {
    const result = await gateway().roles.narrator.narrate(PROBE);
    const failure = classifyTestFailure(result.fallbackUsed ? (result.fallback?.reason ?? 'api_error') : null);
    const latencyMs = Math.round(result.run.latencyMs);

    if (failure === null) {
      const body: TokenTestResult = result.fallbackUsed
        ? {
            ok: true,
            modelId: result.run.modelId,
            latencyMs,
            note: 'The model answered, but its reply did not match the schema. The credential works.',
          }
        : { ok: true, modelId: result.run.modelId, latencyMs };
      return finish(json(body));
    }

    const body: TokenTestResult = {
      ok: false,
      failure,
      detail: result.validation.issues[0]?.slice(0, 200) ?? 'The call did not reach a model.',
      latencyMs,
    };
    return finish(json(body));
  } catch (error) {
    // A transport never throws by contract, so reaching here means the gateway
    // itself could not be built — which is a configuration failure, not a
    // network one.
    const body: TokenTestResult = {
      ok: false,
      failure: 'transport_unavailable',
      detail: error instanceof Error ? error.message.slice(0, 200) : 'The gateway could not be built.',
      latencyMs: 0,
    };
    return finish(json(body));
  }
}
