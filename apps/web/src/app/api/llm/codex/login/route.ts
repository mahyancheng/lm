import { z } from 'zod';
import { admit, admitQuick } from '../../_gateway';
import { cancelLoginFor, loginStatusFor, logoutCodex, startLoginFor } from '../../_codexLogin';
import { gateTokenWrite, guardWriteRequest, json, mayReadDescriptor } from '../../token/_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ActionBody = z.object({ action: z.literal('logout').optional() });
const CancelBody = z.object({ loginId: z.string().trim().min(1).max(512) });

/** Starts a device ceremony. GET never starts, cancels, logs out, or reads Codex auth. */
export async function GET(request: Request): Promise<Response> {
  // Polling is a cached local read. Keep it out of the scarce model-call
  // bucket: the normal 2.5s device-login poll cadence exceeds that budget.
  const admission = await admitQuick(request);
  if (!admission.ok) return admission.response;
  if (!(await mayReadDescriptor(request, { principal: admission.admission.principal, mintedPrincipal: admission.admission.mintedPrincipal }))) {
    return admission.admission.finish(json({ ok: false, reason: 'not_authorized' }, 403));
  }
  const loginId = new URL(request.url).searchParams.get('loginId');
  if (loginId === null || loginId.length === 0 || loginId.length > 512) return admission.admission.finish(json({ ok: false, reason: 'invalid_login' }, 400));
  return admission.admission.finish(json(loginStatusFor(admission.admission.principal, loginId)));
}

export async function POST(request: Request): Promise<Response> {
  const forged = guardWriteRequest(request, true);
  if (forged !== null) return forged;
  const admission = await admit(request);
  if (!admission.ok) return admission.response;
  const { finish, principal, mintedPrincipal } = admission.admission;
  const refusal = await gateTokenWrite(request, { principal, mintedPrincipal });
  if (refusal !== null) return finish(refusal);
  const parsed = ActionBody.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return finish(json({ ok: false, reason: 'invalid_request' }, 400));

  if (parsed.data.action === 'logout') {
    const status = await logoutCodex();
    return finish(json({ ok: status.state !== 'unavailable', state: status.state === 'signedIn' ? 'connected' : 'cancelled' }));
  }
  const result = await startLoginFor(principal);
  return finish(json(result, result.ok ? 200 : result.reason === 'login_in_progress' || result.reason === 'already_connected' ? 409 : 503));
}

export async function DELETE(request: Request): Promise<Response> {
  const forged = guardWriteRequest(request, true);
  if (forged !== null) return forged;
  const admission = await admit(request);
  if (!admission.ok) return admission.response;
  const { finish, principal, mintedPrincipal } = admission.admission;
  const refusal = await gateTokenWrite(request, { principal, mintedPrincipal });
  if (refusal !== null) return finish(refusal);
  const parsed = CancelBody.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return finish(json({ ok: false, reason: 'invalid_request' }, 400));
  const result = await cancelLoginFor(principal, parsed.data.loginId);
  return finish(json(result, result.ok ? 200 : result.reason === 'forbidden' ? 403 : 404));
}
