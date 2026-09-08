import { z } from 'zod';
import { NextResponse } from 'next/server';
import { SubmittedActionSchema, type SessionState } from '@frontier/contracts';
import { admit, admitQuick, gateway } from '@/app/api/llm/_gateway';
import { guardWriteRequest, readBoundedJson } from '@/app/api/saves/_shared';
import { buildNpcStrategistInput, buildWorldDirectorInput } from '@/lib/game/briefings';
import { resolveCanonicalQuarter, type CanonicalPlanner } from '@/lib/game/server/sessionAuthority';

import { processSingleton } from '@/app/api/llm/_runtime';
import { createResolutionJobs } from '@/lib/game/server/resolutionJobs';
import { strategistPriority } from '@frontier/simulation';

const jobs = () => processSingleton('game.resolutionJobs', createResolutionJobs);
const noStore = { 'cache-control': 'no-store' };

export async function GET(request: Request): Promise<Response> {
  const admitted = await admitQuick(request); if (!admitted.ok) return admitted.response;
  const { principal, finish } = admitted.admission;
  const url = new URL(request.url);
  const result = jobs().read(principal.id, url.searchParams.get('sessionId') ?? '', url.searchParams.get('requestId') ?? '');
  return finish(NextResponse.json(result ?? { status: 'missing' }, { status: result === null ? 404 : result.status === 'pending' ? 202 : 200, headers: noStore }));
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Body = z.object({
  sessionId: z.string().min(1).max(200), expectedRevision: z.number().int().min(0), requestId: z.string().min(1).max(200),
  playerActions: z.array(SubmittedActionSchema).max(100),
});


export async function POST(request: Request): Promise<Response> {
  const guarded = guardWriteRequest(request, true); if (guarded !== null) return guarded;
  const admitted = await admit(request); if (!admitted.ok) return admitted.response;
  const { finish, principal, conversationKey } = admitted.admission;
  const raw = await readBoundedJson(request); const parsed = raw.ok ? Body.safeParse(raw.value) : null;
  if (!parsed?.success) return finish(NextResponse.json({ status: 'forbidden' }, { status: 400 }));
  const result = jobs().start(principal.id, parsed.data.sessionId, parsed.data.requestId, JSON.stringify(parsed.data.playerActions), async (progress) => {
  let planned = 0;
  const planner: CanonicalPlanner = {
    async planWorld(state: SessionState) { progress('Planning world events'); const input = buildWorldDirectorInput(state, null); return input === null ? null : (await gateway().roles.worldDirector.propose(input, { sessionId: state.sessionId, quarter: state.quarter })).output; },
    async reviewResearch(input) { progress('Reviewing research'); return (await gateway().roles.innovation.interpret(input, { sessionId: input.sessionId, quarter: input.quarter })).output; },
    async planNpc(state: SessionState, companyId: string) { const total = strategistPriority(state, state.players[0]?.companyId ?? '').length; progress(`Planning rival companies: ${++planned} of ${total}`); const input = buildNpcStrategistInput(state, companyId); if (input === null) return null; const key = conversationKey('npc', { gameSessionId: state.sessionId, playerId: companyId, conversationId: companyId }); const output = (await gateway().roles.npcStrategist.plan(input, undefined, { sessionId: state.sessionId, quarter: state.quarter }, key)).output; return output === null ? null : { requestedCompanyId: companyId, bundle: output }; },
  };
  return resolveCanonicalQuarter({ ...parsed.data, ownerId: principal.id }, planner);
  });
  return finish(NextResponse.json(result, { status: result.status === 'pending' ? 202 : result.status === 'resolved' || result.status === 'duplicate' ? 200 : 409, headers: noStore }));
}
