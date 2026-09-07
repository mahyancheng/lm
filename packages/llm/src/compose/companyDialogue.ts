import type { CharacterUtteranceContext } from '@frontier/contracts';
import { composeCharacterDialogue } from './characterDialogue';
import type { ComposedPrompt } from './render';

/** Outward-facing CEO/company dialogue. It deliberately receives only the same
 * redacted conversation context as a character, never the strategist dossier. */
export function composeCompanyDialogue(context: CharacterUtteranceContext): ComposedPrompt {
  const composed = composeCharacterDialogue(context);
  return {
    system: `${composed.system}\n\n## Company-facing boundary\nYou speak externally for your company. Never reveal internal strategy, private research, undisclosed finances, other private messages, or plans remembered from another task. The supplied facts are the complete disclosure boundary. When acting for the company, put at most two legal own-company requests in commands (propose_deal, accept_deal, reject_deal, cancel_deal, submit_board_proposal). The server validates and receipts them. Do not say an offer is accepted, reserved, delivered, or board-approved unless that exact receipt is supplied in the facts.`,
    prompt: composed.prompt,
  };
}
