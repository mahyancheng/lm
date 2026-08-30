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
 * Two postures, decided by whether the deployment has Supabase:
 *
 * - **Configured.** There are real accounts, and setting the credential every
 *   player's calls are billed against is an administrative act: a verified JWT
 *   whose `profiles.is_admin` is true, read with the service-role client so the
 *   claim cannot be self-asserted.
 * - **Not configured.** Demo and local play. There is nobody to be an
 *   administrator — the deployment is one person's machine — so the anonymous
 *   cookie principal is accepted and the write budget is five a minute. `GET`
 *   reports which of the two applies as `authGate`, so the interface can say so
 *   rather than guess.
 *
 * Either way `admit()` runs first, unchanged: the size ceiling, the principal
 * and the ordinary role window all still apply. This route only ever adds.
 *
 * ## Lifetime
 *
 * One process's memory, for the life of that process. Right for `next dev` and
 * `next start` on the owner's machine, which is what this is for; on a
 * multi-instance serverless deployment each instance starts empty, so the
 * environment variable remains the only durable answer there.
 */

import { admit } from '../_gateway';
import { clearRuntimeCredential, setRuntimeCredential } from '../_runtime';
import { TokenBodySchema, describeCredential, gateTokenWrite, json, mutationResult } from './_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Which credential is in force, described but never disclosed. */
export async function GET(request: Request): Promise<Response> {
  const admission = await admit(request);
  if (!admission.ok) return admission.response;
  return admission.admission.finish(json(describeCredential()));
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
  const admission = await admit(request);
  if (!admission.ok) return admission.response;
  const { finish, principal } = admission.admission;

  const refusal = await gateTokenWrite(principal);
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
  return finish(json(mutationResult(true)));
}

/** Forget the pasted credential. Whatever the environment supplies takes over again. */
export async function DELETE(request: Request): Promise<Response> {
  const admission = await admit(request);
  if (!admission.ok) return admission.response;
  const { finish, principal } = admission.admission;

  const refusal = await gateTokenWrite(principal);
  if (refusal !== null) return finish(refusal);

  clearRuntimeCredential();
  return finish(json(mutationResult(true)));
}
