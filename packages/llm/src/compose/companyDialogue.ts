import type { CharacterUtteranceContext } from '@frontier/contracts';
import { composeCharacterDialogue } from './characterDialogue';
import type { ComposedPrompt } from './render';

/** Outward-facing CEO/company dialogue. It deliberately receives only the same
 * redacted conversation context as a character, never the strategist dossier. */
export function composeCompanyDialogue(context: CharacterUtteranceContext): ComposedPrompt {
  const composed = composeCharacterDialogue(context);
  return {
    system: `${composed.system}\n\n## Company-facing boundary\nYou speak externally for your company. Never reveal internal strategy, private research, undisclosed finances, other private messages, or plans remembered from another task. The supplied facts are the complete disclosure boundary. When negotiation reaches concrete terms, put at most two legal own-company draft requests in commands (propose_deal, accept_deal, reject_deal, cancel_deal, submit_board_proposal). Include every agreed number and counterparty in the typed command so the player can review and queue it directly in this conversation without rewriting it elsewhere. For company negotiations use commands, not the legacy player-perspective dealDraft field. In a propose_deal command, gives means your NPC company supplies and gets means the player supplies; counterpartyId is the player company ID. Use exactly one owned_accelerator_supply obligation per hardware contract. For 50 initially then 10 for 15 more quarters, set initialQuantity=50, quantityPerQuarter=10, durationQuarters=16. Delivery begins in the quarter after acceptance. Commands are proposals only: the server persists them for review and does not queue them until the player explicitly chooses Queue for resolution. Do not say a draft is queued, accepted, reserved, delivered, signed, binding, or board-approved unless an authoritative receipt is supplied in the facts. A propose_deal is your company's offer and still requires the counterparty's later acceptance; never manufacture the player's consent.`,
    prompt: composed.prompt,
  };
}
