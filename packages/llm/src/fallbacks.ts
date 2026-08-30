/**
 * @frontier/llm — fallbacks.ts
 *
 * What the game does when a model is unavailable or wrong twice.
 *
 * **An LLM outage is a degraded quarter, never a blocked one.** Every function
 * here is pure and deterministic: same inputs, same output, no RNG, no clock,
 * no state. That is deliberate — the fallbacks run inside a resolution whose
 * whole contract is `S_{t+1} = F(S_t, actions, modifiers, seed)`, so anything
 * they produce has to be reproducible from the recorded inputs alone. It is
 * also why `LLM_TRANSPORT=none` is a supported configuration and the basis of
 * demo mode: a session driven entirely by fallbacks is a real session.
 *
 * The strategies mirror `LLM_FALLBACK_STRATEGIES` in `@frontier/contracts`:
 *
 * | Role | Fallback |
 * |---|---|
 * | `world_director` | null — the engine materialises the drawn candidates from their family templates. The quarter still has weather; it just has less character. |
 * | `chief_of_staff` | The instruction echoed back as a question requiring confirmation. Nothing is interpreted, nothing is submitted. |
 * | `npc_strategist` | null — the engine runs the deterministic archetype policy for that company's posture. |
 * | `character_dialogue` | A short templated reply consistent with traits and relationship, and **no** commitment. Commitments are never fabricated by a fallback. |
 * | `innovation_interpreter` | A decline with `llm_unavailable`. A node is never added to the Frontier Map without interpretation. |
 * | `social_author` | null — publish nothing. Structured campaigns still run; personal posting is unavailable that quarter. |
 * | `narrator` | The resolution report lines rendered directly. They are already human-readable by construction. |
 */

import type {
  CharacterReply,
  CharacterUtteranceContext,
  ChiefOfStaffInput,
  ChiefOfStaffInterpretation,
  NarratorInput,
  NarratorOutput,
} from '@frontier/contracts';
import { groupLinesByPhase } from './compose/narrator';
import { truncate } from './compose/render';

/** The reason recorded on an innovation decline when no model was available. */
export const INNOVATION_DECLINE_REASON = 'llm_unavailable';

/* -------------------------------------------------------------------------- */
/*  Chief of Staff                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Interpret nothing; hand the instruction back as a question.
 *
 * The player falls back to the normal controls. Nothing is auto-interpreted,
 * `requiresConfirmation` is true and `confidence` is zero, so the interface
 * presents it as a draft that cannot be submitted by accident.
 */
export function fallbackChiefOfStaff(input: ChiefOfStaffInput): ChiefOfStaffInterpretation {
  const echoed = truncate(input.playerMessage.trim(), 640);
  return {
    interpretedInstructions: [],
    summary: truncate(
      `The Chief of Staff is unavailable this quarter, so nothing has been interpreted and nothing has been submitted. Your instruction was recorded exactly as written: "${echoed}" Use the normal controls to make these changes yourself, or try again shortly.`,
      1200,
    ),
    questions: [truncate(`Do you want to submit this through the controls yourself: "${echoed}"?`, 240)],
    requiresConfirmation: true,
    confidence: 0,
    unsupportedRequests: [],
  };
}

/* -------------------------------------------------------------------------- */
/*  Character dialogue                                                         */
/* -------------------------------------------------------------------------- */

/** Which register a templated reply uses, derived from the relationship. */
export type DialogueRegister = 'unacquainted' | 'hostile' | 'warm' | 'respectful' | 'guarded' | 'neutral';

/** Pure classification of the speaker's stance toward the other party. */
export function dialogueRegister(context: CharacterUtteranceContext): DialogueRegister {
  const relationship = context.relationship;
  if (relationship === null) return 'unacquainted';
  if (relationship.hostility >= 60) return 'hostile';
  if (relationship.trust >= 70) return 'warm';
  if (relationship.respect >= 70) return 'respectful';
  if (relationship.trust <= 30) return 'guarded';
  return 'neutral';
}

const REGISTER_OPENING: Readonly<Record<DialogueRegister, string>> = {
  unacquainted: 'We have not worked together before, so I will be brief.',
  hostile: 'I will be short about this.',
  warm: 'Good to hear from you.',
  respectful: 'I take the question seriously.',
  guarded: 'I will keep this narrow for now.',
  neutral: 'Understood.',
};

const REGISTER_CLOSING: Readonly<Record<DialogueRegister, string>> = {
  unacquainted: 'Put the specifics in writing and I will look at them properly.',
  hostile: 'I am not going to commit to anything on this today.',
  warm: 'Send me the numbers and we can go through them properly.',
  respectful: 'Give me the detail and I will come back to you with a considered answer.',
  guarded: 'I would want the terms in front of me before I say anything more.',
  neutral: 'Let me come back to you on it.',
};

/**
 * A short reply consistent with the character's traits and relationship, and
 * **no commitment**. Deterministic from the context: no RNG, no clock.
 */
export function fallbackCharacterReply(context: CharacterUtteranceContext): CharacterReply {
  const register = dialogueRegister(context);
  const firstFact = context.gameFacts[0];
  const traits = context.character.stableTraits;

  const stance =
    traits.financialConservatism >= 70
      ? 'My first question is always what it costs and what happens if it does not work.'
      : traits.riskTolerance >= 70
        ? 'I am willing to take a position on this if the case is coherent.'
        : traits.technicalOrientation >= 70
          ? 'I would want to see the evidence rather than the framing.'
          : 'I would want to understand the shape of it before I take a view.';

  const factLine = firstFact === undefined ? '' : ` The number I keep coming back to is ${firstFact.label.toLowerCase()}: ${firstFact.value}.`;

  const text = truncate(
    `${REGISTER_OPENING[register]} On ${context.topic}: ${stance}${factLine} ${REGISTER_CLOSING[register]}`,
    1200,
  );

  return {
    text,
    newCommitment: null,
    relationshipDeltas: { trust: 0, respect: 0, hostility: 0 },
    memoryToStore: null,
  };
}

/* -------------------------------------------------------------------------- */
/*  Narrator                                                                   */
/* -------------------------------------------------------------------------- */

const NEGATIVE_DELTA = /^\s*[-−]/;
const POSITIVE_DELTA = /^\s*\+/;

/**
 * Tone from the shape of the committed deltas alone.
 *
 * No sentiment analysis of the prose: the deltas are the facts, and a
 * deterministic tally of them is reproducible where a reading of the words
 * would not be.
 */
export function narratorTone(lines: NarratorInput['committedLines']): NarratorOutput['tone'] {
  let positive = 0;
  let negative = 0;
  for (const line of lines) {
    const label = line.deltaLabel;
    if (label === null) continue;
    if (POSITIVE_DELTA.test(label)) positive += 1;
    else if (NEGATIVE_DELTA.test(label)) negative += 1;
  }
  const total = positive + negative;
  if (total === 0) return 'steady';
  const share = positive / total;
  if (share >= 0.75) return 'triumphant';
  if (share >= 0.45) return 'steady';
  if (share >= 0.2) return 'strained';
  return 'grim';
}

const EMPTY_QUARTER_BODY = 'The quarter resolved with no material changes recorded in the ledger. Nothing in the world moved far enough to report.';

/**
 * Render the resolution report directly. The lines are already human-readable
 * by construction — every one of them traces to a committed ledger event — so
 * the "fallback" is simply presenting them without colour.
 */
export function fallbackNarratorOutput(input: NarratorInput): NarratorOutput {
  const lines = input.committedLines;
  const focus = input.focusCompanyId === null ? '' : `${input.focusCompanyId} — `;
  const headline = truncate(
    lines.length === 0
      ? `${focus}Quarter ${input.quarter} resolved with no material changes`
      : `${focus}Quarter ${input.quarter} resolved: ${lines.length} recorded ${lines.length === 1 ? 'change' : 'changes'}`,
    160,
  );

  let body: string;
  if (lines.length === 0) {
    body = EMPTY_QUARTER_BODY;
  } else {
    const paragraphs: string[] = [];
    for (const group of groupLinesByPhase(lines)) {
      paragraphs.push(`${group.phase}: ${group.entries.join('; ')}.`);
    }
    body = truncate(paragraphs.join('\n\n'), 1500);
    if (body.length < 20) body = EMPTY_QUARTER_BODY;
  }

  return { headline, body, tone: narratorTone(lines) };
}
