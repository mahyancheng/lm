import { z } from 'zod';
import { BoundedSocialAuthorInputSchema } from '../_bounds';
import { admit, gateway, parseBody, runRole } from '../_gateway';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const BodySchema = z.object({
  input: BoundedSocialAuthorInputSchema,
  sessionId: z.string().min(1).optional(),
  quarter: z.number().int().min(0).optional(),
});

/**
 * `POST /api/llm/social-author` — draft the words of a post.
 *
 * The division of labour this route exists to keep: **an LLM writes the post,
 * the engine decides what it does.** The output is a `SocialPostDraft` and
 * nothing else — reach, per-audience sentiment, press pickup and competitor
 * hostility are all computed by the social phase from the typed draft.
 *
 * Null is the ordinary answer when no model is configured, and the role's own
 * fallback is "publish nothing". The Social screen's deterministic path is to
 * post the player's own words verbatim, which is strictly better than a model
 * putting words in a founder's mouth.
 */
export async function POST(request: Request): Promise<Response> {
  const admission = await admit(request);
  if (!admission.ok) return admission.response;
  const { finish } = admission.admission;

  const parsed = await parseBody(request, BodySchema);
  if (!parsed.ok) return finish(parsed.response);

  const { input, sessionId, quarter } = parsed.value;

  return finish(
    await runRole(async () => {
      const result = await gateway().roles.social.author(input, {
        ...(sessionId === undefined ? {} : { sessionId }),
        ...(quarter === undefined ? {} : { quarter }),
      });
      return { output: result.output, fallbackUsed: result.fallbackUsed };
    }),
  );
}
