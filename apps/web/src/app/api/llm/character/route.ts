import { z } from 'zod';
import { CharacterUtteranceContextSchema } from '@frontier/contracts';
import { gateway, parseBody, runRole } from '../_gateway';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const BodySchema = z.object({
  context: CharacterUtteranceContextSchema,
  /** The conversation this turn belongs to. Gives dialogue multi-turn memory. */
  conversationKey: z.string().min(1).max(200),
  sessionId: z.string().min(1).optional(),
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
  const parsed = await parseBody(request, BodySchema);
  if (!parsed.ok) return parsed.response;

  const { context, conversationKey, sessionId, quarter } = parsed.value;

  return runRole(async () => {
    const result = await gateway().roles.character.converse(context, conversationKey, {
      ...(sessionId === undefined ? {} : { sessionId }),
      ...(quarter === undefined ? {} : { quarter }),
    });
    return { output: result.output, fallbackUsed: result.fallbackUsed };
  });
}
