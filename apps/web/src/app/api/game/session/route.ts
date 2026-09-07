import { NextResponse } from 'next/server';
import { admitQuick } from '@/app/api/llm/_gateway';
import { canonicalSessionFile } from '@/lib/game/server/sessionAuthority';
export const runtime = 'nodejs'; export const dynamic = 'force-dynamic';
export async function GET(request: Request): Promise<Response> { const admitted = await admitQuick(request); if (!admitted.ok) return admitted.response; const id = new URL(request.url).searchParams.get('sessionId') ?? ''; const value = canonicalSessionFile(id, admitted.admission.principal.id); return admitted.admission.finish(NextResponse.json(value ?? { ok: false }, { status: value === null ? 404 : 200 })); }
