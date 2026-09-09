import { z } from 'zod';
import { offlineChiefOfStaff } from '@frontier/llm';
import { BoundedChiefOfStaffInputSchema, ConversationPartsSchema } from '../../_bounds';
import { admitQuick, chiefOfStaffMemoryStore, ok, parseBody } from '../../_gateway';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const BodySchema = z.object({
  input: BoundedChiefOfStaffInputSchema,
  conversation: ConversationPartsSchema,
});

/**
 * `POST /api/llm/chief-of-staff/quick` — the deterministic answer, instantly.
 *
 * The progressive-answer half of the reliability work: `/api/llm/chief-of-staff`
 * can take up to `CHIEF_OF_STAFF_TIMEOUT_MS` (150s) on the Pi, because it may
 * queue behind a resolving quarter and then spawn a real Claude Code subprocess.
 * A founder should never be looking at a bare spinner for that long, so the
 * client fires this route in parallel and shows its answer — labelled "Quick
 * answer" — the instant it lands, then upgrades it in place when the model
 * replies.
 *
 * This is exactly `offlineChiefOfStaff`, the same pure arithmetic responder the
 * real route's own fallback uses when no model is configured — cash, runway,
 * burn, best and worst product, sourcing lookups, all answered from the typed
 * dossier without a model. That is what makes the preview trustworthy rather
 * than a placeholder: it is a real answer, just not a model-authored one.
 *
 * Deliberately does **not** touch the concurrency limiter — nothing here spawns
 * a subprocess — and deliberately does **not** write the thread's memory: this
 * is a preview of one exchange, and the exchange is only remembered once,
 * whichever of this reply or the model's the caller keeps as final.
 *
 * Admitted through `admitQuick()`, not `admit()`: this call is one half of
 * every Chief of Staff question (`useChiefOfStaff.ts` fires it alongside the
 * real call, every time), and it never reaches a model — charging it against
 * the same per-principal window the model routes share would spend that
 * budget on a call that was never going to need it, and starve the real call
 * of half its own window for no reason.
 */
export async function POST(request: Request): Promise<Response> {
  const admission = await admitQuick(request);
  if (!admission.ok) return admission.response;
  const { finish, conversationKey } = admission.admission;

  const parsed = await parseBody(request, BodySchema);
  if (!parsed.ok) return finish(parsed.response);

  const { input, conversation } = parsed.value;
  const key = conversationKey('cos', conversation);
  const memory = await chiefOfStaffMemoryStore().get(key);
  const output = offlineChiefOfStaff({ ...input, memory });

  return finish(ok(output, true, 'quick_answer'));
}
