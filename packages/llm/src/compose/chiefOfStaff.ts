/**
 * @frontier/llm — compose/chiefOfStaff.ts
 *
 * The Chief of Staff dossier.
 *
 * This is the conversational surface of the game: the player types *"I don't
 * care about growth next year, get us profitable"* or *"what happens if we cut
 * prices by half?"* and the Chief of Staff reads state, explains options and
 * translates intention into typed `ActionIntent` objects.
 *
 * It sees the player's own company **in full** and nothing private about anyone
 * else — that asymmetry is the whole point of the role. And it never submits
 * anything: its output is a proposal the player approves or edits.
 *
 * Confirmation is belt and braces. The interpretation carries an advisory
 * `requiresConfirmation`, and the system prompt tells the model when to set it,
 * but the binding rule is the thirteen types in `CONFIRMATION_REQUIRED_ACTIONS`
 * enforced by `enforceConfirmationPolicy` below and again by the engine. A
 * model that forgets cannot cause an unconfirmed layoff.
 */

import { CONFIRMATION_REQUIRED_ACTIONS, type ChiefOfStaffInput, type ChiefOfStaffInterpretation, requiresExplicitConfirmation } from '@frontier/contracts';
import { AUTHORITY_PREAMBLE, type ComposedPrompt, OUTPUT_DISCIPLINE, bullets, joinBlocks, numbered, section, truncate, usd } from './render';

export const CHIEF_OF_STAFF_SYSTEM = [
  'You are the Chief of Staff to the founder of one company in Frontier Capital, a simulated AI-industry economy.',
  '',
  AUTHORITY_PREAMBLE,
  '',
  'Your job is to turn what the founder said into typed actions they can check at a glance, and to say plainly what you could not do.',
  '',
  'Rules:',
  '- You interpret. You never submit. Nothing is binding until the founder approves it in the interface.',
  '- Preserve arithmetic constraints they stated. "Keep total burn roughly unchanged" means the new budget lines must sum to roughly the old total; do the arithmetic and show it.',
  '- Never invent a commitment they did not ask for. If they said nothing about hiring, propose nothing about hiring.',
  '- When a figure is ambiguous, ask. A question in `questions` is always better than a guess in `interpretedInstructions`.',
  '- Anything the game has no action for goes in `unsupportedRequests`, said plainly. Never drop it silently.',
  '- Actions carry no companyId and no actionId: the acting company comes from context and the engine assigns ids.',
  '',
  `- Set requiresConfirmation to true whenever any interpreted action is one of: ${CONFIRMATION_REQUIRED_ACTIONS.join(', ')}. Also set it true whenever your confidence is low. When in doubt, true.`,
  '- `summary` is a plain-language restatement written so the founder can check it at a glance: one line per change, old value then new value. State plainly that nothing has been submitted yet.',
  '- `confidence` below 0.7 causes the interface to present this as a draft rather than a ready submission. Be honest about it.',
  '',
  OUTPUT_DISCIPLINE,
].join('\n');

export function composeChiefOfStaff(input: ChiefOfStaffInput): ComposedPrompt {
  const budgets = input.currentBudgets.map((line) => `${line.label}: ${usd(line.amountUsd)}`);
  const total = input.currentBudgets.reduce((sum, line) => sum + line.amountUsd, 0);
  const history = input.conversationHistory.map((turn) => `${turn.role === 'player' ? 'Founder' : 'You'}: ${truncate(turn.text, 800)}`);

  const prompt = joinBlocks([
    `# Quarter ${input.quarter} — session ${input.sessionId}, company ${input.companyId}, founder ${input.playerId}`,
    section('Your company', input.companyBriefing),
    section('World conditions that bear on it', input.worldBriefing),
    section('Current spend lines', `${bullets(budgets)}\n\nTotal committed spend: ${usd(total)}`),
    section('Awaiting the founder', bullets([...input.openDecisions])),
    section('This conversation so far', numbered(history)),
    section(
      'Execution mode',
      input.autoExecuteEnabled
        ? 'The founder has enabled automatic execution of routine instructions. It does not extend to financing, mergers, layoffs, share issuance, major contracts or large spending commitments — those always require an explicit confirmation.'
        : 'Automatic execution is off. Every interpreted action will be presented for explicit approval.',
    ),
    section('What the founder just said', truncate(input.playerMessage, 4000)),
    section(
      'Your task',
      [
        'Interpret that instruction into typed actions, or into questions if it is not yet safe to act on.',
        'Return interpretedInstructions, a summary the founder can check at a glance, any questions, requiresConfirmation, your confidence and anything the game cannot do.',
      ].join('\n'),
    ),
  ]);

  return { system: CHIEF_OF_STAFF_SYSTEM, prompt };
}

/**
 * Force `requiresConfirmation` true when any interpreted action is in the
 * always-confirm set, regardless of what the model said.
 *
 * The model's flag is advisory; this is not. Applied to every interpretation
 * before it leaves the gateway, so a forgetful or adversarial reply still
 * cannot produce a layoff, a raise or an acquisition the founder did not
 * explicitly approve. The engine rejects those a second time with
 * `confirmation_required`.
 */
export function enforceConfirmationPolicy(interpretation: ChiefOfStaffInterpretation): ChiefOfStaffInterpretation {
  const mustConfirm = interpretation.interpretedInstructions.some((intent) => requiresExplicitConfirmation(intent.type));
  if (!mustConfirm || interpretation.requiresConfirmation) return interpretation;
  return { ...interpretation, requiresConfirmation: true };
}
