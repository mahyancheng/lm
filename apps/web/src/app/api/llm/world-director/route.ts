import { z } from 'zod';
import { WorldDirectorInputSchema } from '@frontier/contracts';
import { gateway, parseBody, runRole } from '../_gateway';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const BodySchema = z.object({ input: WorldDirectorInputSchema });

/**
 * `POST /api/llm/world-director` — contextualise the quarter's drawn events.
 *
 * The deterministic hazard engine has already decided that *something in each
 * family* happens; the Director says what it is and how it reads. Its batch is
 * then clamped into the impact budget and matched against the same candidate
 * ids before anything materialises.
 *
 * Null is a first-class answer: `resolveQuarter(state, actions, null, [])`
 * fires the drawn candidates on their family templates instead.
 */
export async function POST(request: Request): Promise<Response> {
  const parsed = await parseBody(request, BodySchema);
  if (!parsed.ok) return parsed.response;

  const { input } = parsed.value;
  return runRole(async () => {
    const result = await gateway().roles.worldDirector.propose(input, {
      sessionId: input.sessionId,
      quarter: input.quarter,
    });
    return { output: result.output, fallbackUsed: result.fallbackUsed };
  });
}
