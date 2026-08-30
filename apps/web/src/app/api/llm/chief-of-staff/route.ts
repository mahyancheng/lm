import { z } from 'zod';
import { BoundedChiefOfStaffInputSchema, ConversationPartsSchema } from '../_bounds';
import { admit, gateway, parseBody, runRole } from '../_gateway';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const BodySchema = z.object({
  input: BoundedChiefOfStaffInputSchema,
  /**
   * Which seat's thread this belongs to — the parts, never a key. This prompt
   * carries the player's whole private company briefing, so the thread it is
   * written into is derived from the verified caller and nothing else.
   */
  conversation: ConversationPartsSchema,
});

/**
 * `POST /api/llm/chief-of-staff` — interpret → propose.
 *
 * Returns a `ChiefOfStaffInterpretation` the UI renders as a diff, never as
 * prose the player has to parse. Confirm is a separate, human step: nothing
 * here submits anything, and the gateway has already re-applied the
 * confirmation policy to whatever the model set.
 *
 * With no transport this answers `{ output: null, fallback: true }` and the
 * screen echoes the instruction back as a question — asking is better than
 * guessing.
 */
export async function POST(request: Request): Promise<Response> {
  const admission = await admit(request);
  if (!admission.ok) return admission.response;
  const { finish, conversationKey } = admission.admission;

  const parsed = await parseBody(request, BodySchema);
  if (!parsed.ok) return finish(parsed.response);

  const { input, conversation } = parsed.value;

  return finish(
    await runRole(async () => {
      const result = await gateway().roles.chiefOfStaff.interpret(input, conversationKey('cos', conversation), {
        sessionId: input.sessionId,
        quarter: input.quarter,
      });
      return { output: result.output, fallbackUsed: result.fallbackUsed };
    }),
  );
}
