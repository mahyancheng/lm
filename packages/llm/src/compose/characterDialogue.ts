/**
 * @frontier/llm — compose/characterDialogue.ts
 *
 * One character, speaking as themselves.
 *
 * The persona is not written by hand: it is assembled from canonical state
 * every turn — stable traits that never change over a session, current beliefs,
 * the relationship in *both* directions (characters sense asymmetry), and the
 * memories that survived decay. That is what makes an NPC bring up a poaching
 * raid three years later, and it is why the same character sounds different to
 * two different people.
 *
 * Dialogue creates commitments; it does not change reality. A conversation can
 * never move a support score, a price or a vote. The only machine-readable
 * residue it may produce is a `ConditionalCommitment` — an expiring,
 * condition-bearing promise the engine checks against the real proposal — plus
 * small relationship deltas and, occasionally, a memory.
 *
 * Boundary: a speaker may only be handed their own memories and their own
 * feelings. Being given somebody else's memories would let a character
 * reminisce about a meeting they were never in.
 */

import type { CharacterUtteranceContext } from '@frontier/contracts';
import { AUTHORITY_PREAMBLE, type ComposedPrompt, OUTPUT_DISCIPLINE, bullets, joinBlocks, lastN, num, numbered, section, truncate } from './render';
import { LlmContextLeakError, assertOwnedBy } from './redaction';

/** How many turns of a conversation are carried forward in the composed dossier. */
export const DIALOGUE_HISTORY_TURNS = 12;

/** How many memories are offered to the speaker, strongest first. */
export const DIALOGUE_MEMORY_LIMIT = 10;

function traitLine(label: string, value: number, low: string, high: string): string {
  const leaning = value >= 70 ? high : value <= 30 ? low : 'balanced';
  return `${label} ${value}/100 (${leaning})`;
}

/**
 * The persona system prompt, built from stable state.
 *
 * Kept separate from the turn dossier because it is the stable half: the same
 * character in the same session produces the same system prompt every turn,
 * which is exactly the prefix a provider can cache.
 */
export function composeCharacterPersona(context: CharacterUtteranceContext): string {
  const character = context.character;
  const traits = character.stableTraits;

  const beliefs = context.character.beliefs.map((belief) => `${belief.topic}: ${belief.level}`);

  const feelings =
    context.relationship === null
      ? 'You have never met this person. You are cordial, guarded, and you do not pretend to a familiarity you do not have.'
      : `Toward them you feel: trust ${context.relationship.trust}/100, respect ${context.relationship.respect}/100, hostility ${context.relationship.hostility}/100, dependence ${context.relationship.dependence}/100. ` +
        `You have dealt with each other ${context.relationship.interactionCount} time(s)` +
        `${context.relationship.lastInteractionQuarter === null ? '.' : `, last in Q${context.relationship.lastInteractionQuarter}.`}`;

  const theirView =
    context.counterpartRelationship === null
      ? 'You have no read on how they regard you.'
      : `You sense they regard you with trust ${context.counterpartRelationship.trust}/100, respect ${context.counterpartRelationship.respect}/100 and hostility ${context.counterpartRelationship.hostility}/100. People notice asymmetry, and so do you.`;

  return [
    `You are ${character.name}, ${character.title || character.role}${character.companyId === null ? '' : ` at ${character.companyId}`}. You are speaking in your own voice, in a simulated AI-industry economy.`,
    '',
    AUTHORITY_PREAMBLE,
    '',
    '## Who you are',
    bullets([
      traitLine('Risk tolerance', traits.riskTolerance, 'you want the downside covered before the upside', 'you will take a leveraged bet and forgive a failure'),
      traitLine('Technical orientation', traits.technicalOrientation, 'you judge a claim by who made it', 'you judge a claim on its merits'),
      traitLine('Financial conservatism', traits.financialConservatism, 'you spend to win the position', 'you watch cash, dilution and downside first'),
      traitLine('Aggressiveness', traits.aggressiveness, 'you avoid public fights', 'you will poach, litigate and escalate in public'),
      traitLine('Status sensitivity', traits.statusSensitivity, 'slights roll off you', 'you remember being embarrassed for a very long time'),
      `Connection level ${character.connectionLevel}/100; ${character.boardSeatCount} board seat(s).`,
    ]),
    '',
    '## What you currently believe',
    context.character.beliefs.length > 0 ? bullets(beliefs) : '(nothing recorded)',
    '',
    '## How you regard the person you are speaking to',
    `${feelings}\n${theirView}`,
    '',
    '## How you are speaking to them at all',
    context.accessBasis,
    '',
    '## Rules you cannot break',
    bullets([
      'Argue only from the verified facts supplied in the dossier. You may not invent a number, a result or a deal term.',
      'Never state a game outcome as though it had already happened. You have opinions about the future, not knowledge of it.',
      'A conversation cannot change a support score, a price or a vote. If you agree to something concrete, express it as a conditional commitment with machine-checkable conditions.',
      'Return newCommitment as null unless the conversation genuinely reached something specific — which is most of the time. A fabricated promise is worse than no promise.',
      'relationshipDeltas are small. Most conversations move trust by 0 to 2 points; -10..10 is the range, not the expectation.',
      'memoryToStore is null unless this exchange was actually memorable, written in your own framing.',
    ]),
    '',
    '## Continuity',
    'This conversation may be resumed across several turns. Speak as though you remember what has already been said in it — because you do — but treat the dossier below as the only source of facts about the world; it is rebuilt from canonical state every turn and supersedes anything you recall.',
    '',
    OUTPUT_DISCIPLINE,
  ].join('\n');
}

export function composeCharacterDialogue(context: CharacterUtteranceContext): ComposedPrompt {
  // --- boundary checks ---
  assertOwnedBy('memories', context.memories, context.character.id, (memory) => memory.ownerCharacterId);
  if (context.relationship !== null && context.relationship.fromId !== context.character.id) {
    throw new LlmContextLeakError('relationship', `relationship is held by "${context.relationship.fromId}", not by the speaker "${context.character.id}"`);
  }
  if (context.counterpartRelationship !== null && context.counterpartRelationship.toId !== context.character.id) {
    throw new LlmContextLeakError(
      'counterpartRelationship',
      `counterpart relationship points at "${context.counterpartRelationship.toId}", not at the speaker "${context.character.id}"`,
    );
  }

  const memories = context.memories
    .slice(0, DIALOGUE_MEMORY_LIMIT)
    .map((memory) => `Q${memory.quarter} [${memory.kind}, salience ${num(memory.strength, 2)}, feeling ${num(memory.sentiment, 2)}] about ${memory.aboutId}: ${truncate(memory.summary, 300)}`);

  const facts = context.gameFacts.map((fact) => `${fact.label}: ${fact.value}`);

  const history = lastN(context.conversationHistory, DIALOGUE_HISTORY_TURNS).map((turn) => `${turn.speakerId}: ${truncate(turn.text, 800)}`);

  const prompt = joinBlocks([
    `# Conversation about: ${context.topic}`,
    section('What you remember about them', bullets(memories)),
    section('Verified facts you may argue from', bullets(facts)),
    section('Matter under discussion', context.pendingProposalSummary ?? '(no formal proposal is on the table)'),
    section('The conversation so far', numbered(history)),
    section(
      'Your task',
      [
        'Reply in your own voice, in at most 1200 characters.',
        'Return relationshipDeltas describing how this exchange moved your feelings, newCommitment only if something concrete was agreed, and memoryToStore only if this was worth remembering.',
      ].join('\n'),
    ),
  ]);

  return { system: composeCharacterPersona(context), prompt };
}
