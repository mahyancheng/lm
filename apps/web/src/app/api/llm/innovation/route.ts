import { z } from 'zod';
import { BoundedInnovationInputSchema } from '../_bounds';
import { admit, gateway, parseBody, runRole } from '../_gateway';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const BodySchema = z.object({
  input: BoundedInnovationInputSchema,
});

/**
 * `POST /api/llm/innovation` — turn a player's own words into a typed
 * `InnovationProposal`.
 *
 * The interpreter never adds a node. It returns a proposal the player reviews
 * and then queues as a `propose_innovation` action; the engine assesses
 * plausibility, cost and duration itself and may refuse it outright.
 *
 * Null is the *designed* answer when no model is configured: the innovation
 * fallback declines rather than inventing a thesis, because a node is never
 * added to the Frontier Map without interpretation. The Research screen's
 * deterministic path is the guided form, where the player states the same
 * fields themselves.
 */
export async function POST(request: Request): Promise<Response> {
  const admission = await admit(request);
  if (!admission.ok) return admission.response;
  const { finish } = admission.admission;

  const parsed = await parseBody(request, BodySchema);
  if (!parsed.ok) return finish(parsed.response);

  const { input } = parsed.value;

  return finish(
    await runRole(async () => {
      const result = await gateway().roles.innovation.interpret(input, {
        sessionId: input.sessionId,
        quarter: input.quarter,
      });
      return { output: result.output, fallbackUsed: result.fallbackUsed };
    }),
  );
}
