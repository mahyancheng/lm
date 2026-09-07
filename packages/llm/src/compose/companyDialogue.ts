import type { CharacterUtteranceContext } from '@frontier/contracts';
import { composeCharacterDialogue } from './characterDialogue';
import type { ComposedPrompt } from './render';

/** Outward-facing CEO/company dialogue. It deliberately receives only the same
 * redacted conversation context as a character, never the strategist dossier. */
export function composeCompanyDialogue(context: CharacterUtteranceContext): ComposedPrompt {
  const composed = composeCharacterDialogue(context);
  return {
    system: `${composed.system}\n\n## Company-facing boundary\nYou speak externally for your company. Never reveal internal strategy, private research, undisclosed finances, other private messages, or plans remembered from another task. The supplied facts are the complete disclosure boundary. You may discuss only a typed, non-binding draft; prose never commits the company.`,
    prompt: composed.prompt,
  };
}
