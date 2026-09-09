import { z } from 'zod';
import { SetupProposalSchema } from '@frontier/contracts';
import { interpretSetup } from '@frontier/llm';
import { LLM_INPUT_LIMITS } from '../_bounds';
import { admit, gateway, parseBody, runRole } from '../_gateway';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Turns of the new-game conversation one request may carry.
 *
 * Far below the shared `historyTurns` ceiling on purpose: this conversation
 * establishes five slots and is over. Forty turns of it is not a founder
 * deciding, it is somebody using the endpoint as a text channel on the
 * operator's Claude subscription.
 */
const SETUP_HISTORY_LIMIT = 24;

const TurnSchema = z.object({
  role: z.enum(['player', 'chief_of_staff']),
  text: z.string().max(LLM_INPUT_LIMITS.historyText),
});

const BodySchema = z.object({
  message: z.string().min(1).max(LLM_INPUT_LIMITS.message),
  history: z.array(TurnSchema).max(SETUP_HISTORY_LIMIT).default([]),
  /** What the conversation has already established, or null at the first turn. */
  established: SetupProposalSchema.nullable().default(null),
});

/**
 * `POST /api/llm/setup-interpreter` — read one turn of the new-game
 * conversation into a `SetupProposal`.
 *
 * The only role route that runs before a session exists, so it carries no
 * session id, no quarter and no briefing: there is no world yet to redact. It
 * writes no `AgentRunRecord` for the same reason — that record is keyed to a
 * session and a quarter, and both would have to be invented.
 *
 * Null is a first-class answer here rather than a degraded one. The client
 * parses every message deterministically first (`lib/game/setupChat.ts`) and
 * only layers a model reading on top, so a null from this route means the chat
 * asks a more direct question — never that it stops working.
 */
export async function POST(request: Request): Promise<Response> {
  const admission = await admit(request);
  if (!admission.ok) return admission.response;
  const { finish } = admission.admission;

  const parsed = await parseBody(request, BodySchema);
  if (!parsed.ok) return finish(parsed.response);

  const { message, history, established } = parsed.value;

  return finish(
    await runRole(async () => {
      const result = await interpretSetup(gateway().transport, { message, history, established });
      return { output: result.fallbackUsed ? null : result.output, fallbackUsed: result.fallbackUsed };
    }),
  );
}
