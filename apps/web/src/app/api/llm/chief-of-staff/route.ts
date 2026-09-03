import { z } from 'zod';
import { offlineChiefOfStaff, rememberExchange } from '@frontier/llm';
import { BoundedChiefOfStaffInputSchema, ConversationPartsSchema } from '../_bounds';
import { admit, chiefOfStaffMemoryStore, gateway, ok, parseBody, runRole, transportAvailable } from '../_gateway';

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
 * `POST /api/llm/chief-of-staff` — answer, plan or act.
 *
 * Returns a `ChiefOfStaffInterpretation`: `reply` is the words the founder
 * reads, and `interpretedInstructions` is the diff the UI renders as typed
 * rows with the validator's verdict already on them. Confirm is a separate,
 * human step: nothing here submits anything, and the gateway has already
 * re-applied the confirmation and mode policies to whatever the model set.
 *
 * The thread survives the whole game two ways. The Claude session is resumed by
 * the same derived conversation key it has always been; alongside it, this
 * route reads and writes a compact bounded memory under that key — the last few
 * exchanges and the founder's standing preferences, each stamped with the
 * quarter it came from — and hands it to the composer. That is what lets a
 * founder say "never dilute below 25%" once in year two and be held to it in
 * year six, through restarts and compactions that take the transcript.
 *
 * ## Sourcing takes two POSTs, and only two
 *
 * A founder who asks "can I buy a small data centre" gets an answer the dossier
 * does not contain, so the role may reply once with `mode: "research"` and a
 * list of lookups. The **client** runs those against its own canonical state and
 * posts the same message again with `findings` attached, on the same
 * conversation key, and the second reply is the answer.
 *
 * The bound is enforced twice, in the two places it can be: the composer tells
 * the model that research mode is closed on a turn carrying findings, and
 * `enforceInterpretationPolicy` rewrites a third-round request into an answer
 * before it ever reaches the client. A loop that can spin is a loop that will,
 * and each turn here is a Claude Code subprocess on the owner's own machine.
 *
 * With no transport this does **not** answer null. It runs the deterministic
 * offline responder over the same typed dossier, which answers the common
 * questions — cash, runway, burn, best and worst product, who is circling us,
 * what needs deciding, what is even possible — by arithmetic, and interprets
 * nothing into an action. `failure_mode` is an engine invariant: a founder
 * with no model configured gets an answer, not an apology. The client's own
 * null path remains, and now means only what it says: the server was
 * unreachable.
 */
export async function POST(request: Request): Promise<Response> {
  const admission = await admit(request);
  if (!admission.ok) return admission.response;
  const { finish, conversationKey } = admission.admission;

  const parsed = await parseBody(request, BodySchema);
  if (!parsed.ok) return finish(parsed.response);

  const { input, conversation } = parsed.value;
  const key = conversationKey('cos', conversation);
  const memoryStore = chiefOfStaffMemoryStore();

  // No transport: answer deterministically rather than returning nothing. The
  // memory is still read and written, so an offline quarter is part of the same
  // thread as the quarters around it.
  if (!transportAvailable()) {
    const memory = await memoryStore.get(key);
    const output = offlineChiefOfStaff({ ...input, memory });
    if (output.mode !== 'research') {
      await memoryStore.set(
        key,
        rememberExchange(memory, { quarter: input.quarter, founderSaid: input.playerMessage, chiefReplied: output.reply }),
      );
    }
    return finish(ok(output, true, 'transport_none'));
  }

  return finish(
    await runRole(async () => {
      // The memory the client sent, if any, is ignored: a client-supplied
      // memory is a client-supplied prompt, and the whole point of holding this
      // server-side is that the founder's standing preferences are not
      // something a request may rewrite.
      const memory = await memoryStore.get(key);

      const result = await gateway().roles.chiefOfStaff.interpret({ ...input, memory }, key, {
        sessionId: input.sessionId,
        quarter: input.quarter,
      });

      // Record the exchange whether the model answered or the deterministic
      // fallback did: a thread the founder can see is a thread the assistant
      // should remember, and the fallback's own reply is a real answer.
      //
      // A `research` turn is not an answer. "Checking the compute market" is the
      // role clearing its throat, and writing it into a memory that survives the
      // whole campaign would fill the founder's history with throat-clearing.
      // The second turn of the same message is the one that gets remembered.
      if (result.output !== null && result.output.mode !== 'research') {
        await memoryStore.set(
          key,
          rememberExchange(memory, {
            quarter: input.quarter,
            founderSaid: input.playerMessage,
            chiefReplied: result.output.reply,
          }),
        );
      }

      return { output: result.output, fallbackUsed: result.fallbackUsed };
    }),
  );
}
