import { z } from 'zod';
import { NextResponse } from 'next/server';
import { BoundedCharacterContextSchema, ConversationPartsSchema } from '../_bounds';
import { admit, gateway, parseBody, runRole } from '../_gateway';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const BodySchema = z.object({ context: BoundedCharacterContextSchema, conversation: ConversationPartsSchema, quarter: z.number().int().min(0).optional() });

/** Company CEO dialogue. The opaque key is derived from the admitted seat,
 * game and company id; clients never receive a resumable Claude handle. */
export async function POST(request: Request): Promise<Response> {
  const admission = await admit(request); if (!admission.ok) return admission.response;
  const parsed = await parseBody(request, BodySchema); if (!parsed.ok) return admission.admission.finish(parsed.response);
  const { context, conversation, quarter } = parsed.value;
  if (context.character.companyId === null || conversation.conversationId !== context.character.companyId) return admission.admission.finish(NextResponse.json({ error: 'invalid_company_conversation' }, { status: 400 }));
  return admission.admission.finish(await runRole(async () => {
    const result = await gateway().roles.companyDialogue.converse(context, admission.admission.conversationKey('npc', { ...conversation, playerId: context.character.companyId! }), { sessionId: conversation.gameSessionId, ...(quarter === undefined ? {} : { quarter }) });
    return { output: result.output, fallbackUsed: result.fallbackUsed };
  }));
}
