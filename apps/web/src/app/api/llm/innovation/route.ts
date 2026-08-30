import { z } from 'zod';
import { InnovationInterpreterInputSchema } from '@frontier/contracts';
import { gateway, parseBody, runRole } from '../_gateway';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const BodySchema = z.object({
  input: InnovationInterpreterInputSchema,
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
  const parsed = await parseBody(request, BodySchema);
  if (!parsed.ok) return parsed.response;

  const { input } = parsed.value;

  return runRole(async () => {
    const result = await gateway().roles.innovation.interpret(input, {
      sessionId: input.sessionId,
      quarter: input.quarter,
    });
    return { output: result.output, fallbackUsed: result.fallbackUsed };
  });
}
