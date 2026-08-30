/**
 * `/api/llm/token` — hand the running process a Claude credential.
 *
 * The point of this route is that `claude setup-token` prints a token and a
 * player should be able to paste it into Settings, not into a dotfile. What it
 * must never become is a way to read one back out, so the shape is asymmetric
 * on purpose:
 *
 * | Verb | Does | Answers with |
 * |---|---|---|
 * | `GET` | Reads the descriptor | kind, last four characters, when it was set |
 * | `POST` | Accepts a pasted credential | the same descriptor, never the value |
 * | `DELETE` | Drops it, falling back to the environment | the descriptor that now applies |
 *
 * ## Authority
 *
 * Three postures. Supabase decides the first two; **where the request came
 * from** decides the third, because a dev server binds every interface and "no
 * accounts are configured" is not evidence that the caller owns the machine:
 *
 * - **Supabase configured.** There are real accounts, and setting the
 *   credential every player's calls are billed against is an administrative
 *   act: a verified JWT whose `profiles.is_admin` is true, read with the
 *   service-role client so the claim cannot be self-asserted.
 * - **No Supabase, local connection.** Demo and local play. There is nobody to
 *   be an administrator, so the per-browser cookie principal is accepted and
 *   the write budget is five a minute.
 * - **No Supabase, connection from elsewhere.** `authGate: "disabled"`. Nothing
 *   may be written; the environment variable is the only way in.
 *
 * `GET` reports which applies as `authGate`, so the interface says so rather
 * than guesses, and it answers the descriptor **only** to a caller who could
 * have written it — everyone else is told the four public facts and nothing
 * about the secret.
 *
 * ## What a write additionally requires
 *
 * | Check | Because |
 * |---|---|
 * | `Sec-Fetch-Site: same-origin`, or `Origin` matching `Host` | A cross-site page must not be able to set this credential. |
 * | `content-type: application/json` on `POST` | The one cross-origin POST that needs no preflight is a form, and a form cannot send JSON. |
 * | A cookie we minted on an **earlier** request | Minting a principal for a cookieless caller undid `SameSite=Lax` and handed every request a fresh rate-limit bucket. Only `GET` mints now. |
 *
 * The last one costs the interface nothing: the settings sheet reads the status
 * before it can offer any control, so the cookie is always in place before a
 * Connect button exists to press.
 *
 * `admit()` still runs first, unchanged: the size ceiling, the principal and
 * the ordinary role window all apply. This route only ever adds.
 *
 * ## Lifetime
 *
 * One process's memory, for the life of that process — held on a `globalThis`
 * slot so that a `next dev` module reload cannot silently drop it. Right for
 * `next dev` and `next start` on the owner's machine, which is what this is
 * for; on a multi-instance serverless deployment each instance starts empty, so
 * the environment variable remains the only durable answer there.
 */

import { admit } from '../_gateway';
import { clearRuntimeCredential, publicTokenStatus, setRuntimeCredential } from '../_runtime';
import {
  TokenBodySchema,
  describeCredential,
  gateTokenWrite,
  guardWriteRequest,
  json,
  mayReadDescriptor,
  mutationResult,
} from './_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Which credential is in force, described but never disclosed — and described
 * at all only to a caller who could replace it.
 *
 * This is also the only verb that mints an anonymous id, which is what makes
 * the writes below possible for an ordinary browser and impossible for a
 * cross-site one.
 */
export async function GET(request: Request): Promise<Response> {
  const admission = await admit(request);
  if (!admission.ok) return admission.response;
  const { finish, principal, mintedPrincipal } = admission.admission;

  const status = describeCredential(request);
  const disclose = await mayReadDescriptor(request, { principal, mintedPrincipal });
  return finish(json(disclose ? status : publicTokenStatus(status)));
}

/**
 * Accept a pasted credential.
 *
 * Classification is by prefix and happens in `setRuntimeCredential`: an
 * `sk-ant-…` key selects the metered `api` transport, anything else is treated
 * as the output of `claude setup-token` and selects `claude-session`. The next
 * call to `gateway()` sees a bumped generation and rebuilds against it.
 */
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
    return finish(json({ ok: false, reason: 'invalid_json' }, 400));
  }

  const parsed = TokenBodySchema.safeParse(raw);
  if (!parsed.success) {
    // The message describes the *shape* of a credential, never the value.
    return finish(json({ ok: false, reason: parsed.error.issues[0]?.message ?? 'invalid_token' }, 400));
  }

  setRuntimeCredential(parsed.data.token);
  return finish(json(mutationResult(request, true)));
}

/**
 * Forget the pasted credential. Whatever the environment supplies takes over
 * again.
 *
 * No content type is demanded here because there is no body to type; the
 * origin checks are what stand between this and a cross-site page, and a
 * cross-site `DELETE` cannot be sent without a preflight the app never grants.
 */
export async function DELETE(request: Request): Promise<Response> {
  const forged = guardWriteRequest(request, false);
  if (forged !== null) return forged;

  const admission = await admit(request);
  if (!admission.ok) return admission.response;
  const { finish, principal, mintedPrincipal } = admission.admission;

  const refusal = await gateTokenWrite(request, { principal, mintedPrincipal });
  if (refusal !== null) return finish(refusal);

  clearRuntimeCredential();
  return finish(json(mutationResult(request, true)));
}
