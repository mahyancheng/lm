import { NextResponse } from 'next/server';
import { admitQuick } from '@/app/api/llm/_gateway';
import { guardWriteRequest, readBoundedJson } from '@/app/api/saves/_shared';
import { registerGame } from '@/lib/game/server/sessionAuthority';
export const runtime = 'nodejs'; export const dynamic = 'force-dynamic';
export async function POST(request: Request): Promise<Response> {
  const guarded = guardWriteRequest(request, true); if (guarded !== null) return guarded;
  const admitted = await admitQuick(request); if (!admitted.ok) return admitted.response;
  const { finish, principal } = admitted.admission; const body = await readBoundedJson(request);
  if (!body.ok) return finish(NextResponse.json({ ok: false, reason: body.reason }, { status: body.status }));
  const result = registerGame((body.value as Record<string, unknown>)?.file, principal.id);
  return finish(NextResponse.json(result, { status: result.ok ? 200 : result.reason === 'authority_disabled' ? 404 : 409 }));
}
