import { z } from 'zod';
import { NextResponse } from 'next/server';
import { SubmittedActionSchema, type SessionState } from '@frontier/contracts';
import { admit, gateway } from '@/app/api/llm/_gateway';
import { guardWriteRequest, readBoundedJson } from '@/app/api/saves/_shared';
import { buildNpcStrategistInput, buildWorldDirectorInput } from '@/lib/game/briefings';
import { resolveCanonicalQuarter, type CanonicalPlanner } from '@/lib/game/server/sessionAuthority';

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
  const planner: CanonicalPlanner = {
    async planWorld(state: SessionState) { const input = buildWorldDirectorInput(state, null); return input === null ? null : (await gateway().roles.worldDirector.propose(input, { sessionId: state.sessionId, quarter: state.quarter })).output; },
    async reviewResearch(input) { return (await gateway().roles.innovation.interpret(input, { sessionId: input.sessionId, quarter: input.quarter })).output; },
    async planNpc(state: SessionState, companyId: string) { const input = buildNpcStrategistInput(state, companyId); if (input === null) return null; const key = conversationKey('npc', { gameSessionId: state.sessionId, playerId: companyId, conversationId: companyId }); const output = (await gateway().roles.npcStrategist.plan(input, undefined, { sessionId: state.sessionId, quarter: state.quarter }, key)).output; return output === null ? null : { requestedCompanyId: companyId, bundle: output }; },
  };
  const result = await resolveCanonicalQuarter({ ...parsed.data, ownerId: principal.id }, planner);
  return finish(NextResponse.json(result, { status: result.status === 'resolved' || result.status === 'duplicate' ? 200 : 409 }));
}
