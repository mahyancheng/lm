import { z } from 'zod';
import { ChiefOfStaffInputSchema } from '@frontier/contracts';
import { gateway, parseBody, runRole } from '../_gateway';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const BodySchema = z.object({
  input: ChiefOfStaffInputSchema,
  /** Conversation key: gives the thread genuine multi-turn memory across calls. */
  conversationKey: z.string().min(1).max(200),
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
  const parsed = await parseBody(request, BodySchema);
  if (!parsed.ok) return parsed.response;

  const { input, conversationKey } = parsed.value;
  return runRole(async () => {
    const result = await gateway().roles.chiefOfStaff.interpret(input, conversationKey, {
      sessionId: input.sessionId,
      quarter: input.quarter,
    });
    return { output: result.output, fallbackUsed: result.fallbackUsed };
  });
}
