import { z } from 'zod';
import { BoundedCharacterContextSchema, ConversationPartsSchema } from '../_bounds';
import { admit, gateway, parseBody, runRole } from '../_gateway';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const BodySchema = z.object({
  context: BoundedCharacterContextSchema,
  /**
   * Which thread this turn belongs to. Note the shape: the *parts* of a
   * conversation, never a conversation key. The key the transport resumes a
   * Claude session from is derived server-side from these plus the verified
   * caller, because a key a client can name is a key that reaches another
   * player's negotiation transcript.
   */
  conversation: ConversationPartsSchema,
  quarter: z.number().int().min(0).optional(),
});

/**
 * `POST /api/llm/character` — one turn of dialogue.
 *
 * The reply may carry a `ConditionalCommitment`, which the UI renders as a
 * structured card rather than as prose. That distinction is the whole point:
 * persuading a character means *getting a commitment*, not talking a number up.
 * The support score, the price and every other figure remain engine state.
 *
 * Null means the deterministic reply is used instead — in character, in
 * register, and carrying no commitment.
 */
export async function POST(request: Request): Promise<Response> {
  const admission = await admit(request);
  if (!admission.ok) return admission.response;
  const { finish, conversationKey } = admission.admission;

  const parsed = await parseBody(request, BodySchema);
  if (!parsed.ok) return finish(parsed.response);

  const { context, conversation, quarter } = parsed.value;

  return finish(
    await runRole(async () => {
      const result = await gateway().roles.character.converse(context, conversationKey('chr', conversation), {
        sessionId: conversation.gameSessionId,
        ...(quarter === undefined ? {} : { quarter }),
      });
      return { output: result.output, fallbackUsed: result.fallbackUsed };
    }),
  );
}
