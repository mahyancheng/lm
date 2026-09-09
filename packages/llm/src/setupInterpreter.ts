/**
 * @frontier/llm — setupInterpreter.ts
 *
 * The reader for the new-game conversation.
 *
 * Before a session exists, the Chief of Staff asks the founder where they want
 * to begin. The player may tap chips — sector, region, background — or simply
 * say "a robotics startup in East Asia, call it Kestrel Dynamics". This turns
 * that sentence into a `SetupProposal`.
 *
 * Three things make it unlike the seven in-game roles, and each is deliberate:
 *
 * 1. **There is no session.** No session id, no quarter, no state hash, no
 *    canonical state to redact — the world it is helping to choose has not been
 *    built. So it produces no `AgentRunRecord`: that record is keyed to a
 *    session and a quarter, and inventing either would put a row in the audit
 *    trail describing a game that does not exist. It calls the transport
 *    directly instead of going through `createLlmRoles`.
 * 2. **It borrows the `chief_of_staff` role tag.** `AgentRole` is a contracts
 *    enum mirrored by a Postgres enum; adding a member is a migration, and this
 *    caller needs the tag only for transport diagnostics and per-role policy.
 *    The Chief of Staff is literally who is speaking on this screen, so the tag
 *    is honest. The schema is named explicitly below, so nothing about the
 *    wiring is guessed from the role.
 * 3. **Its fallback contributes nothing.** Every other role falls back to a
 *    deterministic behaviour computed here. This one falls back to *what the
 *    conversation had already established*, because the deterministic reading
 *    of the player's words lives in the client (`apps/web/src/lib/game/
 *    setupChat.ts`) and runs on every message whether or not a model does. Two
 *    keyword parsers would be two chances to disagree.
 *
 * Nothing here builds a session. The output is a proposal: the client merges it
 * under its own deterministic reading, `newGameSetupFromProposal` re-validates
 * it through `NewGameSetupSchema`, and the player confirms before a world is
 * built.
 */

import {
  ALL_BACKGROUNDS,
  REGIONS,
  REGION_META,
  SECTORS,
  SECTOR_META,
  SETUP_SLOTS,
  SetupProposalSchema,
  type SetupProposal,
  missingSetupSlots,
} from '@frontier/contracts';
import type { z } from 'zod';
import { AUTHORITY_PREAMBLE, type ComposedPrompt, OUTPUT_DISCIPLINE, bullets, joinBlocks, lastN, numbered, section, truncate } from './compose/render';
import type { LlmTransport } from './transport/types';

/**
 * The schema, with its declared input narrowed to its output.
 *
 * `LlmCompletionRequest.schema` is `z.ZodType<T>`, which declares input and
 * output as the same type. `SetupProposalSchema` defaults five of its fields,
 * so its input type has those optional. Nothing about the parse changes here —
 * the transport only ever feeds it `unknown` lifted out of model text — and the
 * value that comes back is the fully-populated output either way.
 */
const SETUP_PROPOSAL_SCHEMA = SetupProposalSchema as unknown as z.ZodType<SetupProposal>;

/** The schema name recorded on this call's `LlmValidationResult`. */
export const SETUP_INTERPRETER_SCHEMA_NAME = 'SetupProposalSchema';

/** Turns of the new-game conversation the prompt carries. The whole thing is short by construction. */
export const SETUP_HISTORY_TURNS = 12;

/** Hard cap on one turn of that conversation, so a pasted essay cannot blow the window. */
export const SETUP_TURN_MAX_CHARS = 2_000;

/** One turn of the new-game conversation. */
export interface SetupConversationTurn {
  readonly role: 'player' | 'chief_of_staff';
  readonly text: string;
}

/** Everything the interpreter is given. There is no session to redact: none exists yet. */
export interface SetupInterpreterInput {
  /** What the player just said, verbatim. */
  readonly message: string;
  /** The conversation before this message, oldest first. */
  readonly history: readonly SetupConversationTurn[];
  /** What the conversation has already established, or null at the first turn. */
  readonly established: SetupProposal | null;
}

/** Nothing established, nothing read. The starting point of every conversation. */
export const EMPTY_SETUP_PROPOSAL: SetupProposal = SetupProposalSchema.parse({
  confidence: 0,
  missing: [...SETUP_SLOTS],
});

export const SETUP_INTERPRETER_SYSTEM = [
  'You are the Chief of Staff for Frontier Capital, a simulated multi-sector economy, talking to a founder who has not started a company yet. Your only job on this screen is to work out what they want to build.',
  '',
  AUTHORITY_PREAMBLE,
  '',
  'Read what they said and fill in the five slots you can honestly fill:',
  '- `sector` and `region` must be one of the enumerated values below. Never invent one.',
  '- `backgroundId` must be a background belonging to the sector you chose. If the sector is still unclear, leave the background null too.',
  '- `companyName` and `founderName` are names the player actually gave. A description of a business ("a robotics startup") is not a name — leave it null.',
  '- Carry forward everything already established unless the player has just changed their mind about it. A new statement about a slot replaces the old one; silence does not.',
  '- `missing` lists exactly the slots you left null.',
  '- `confidence` is how sure you are of this reading as a whole. Below 0.4 the interface asks the player to confirm before building anything.',
  '',
  'Guess nothing. A founder who says "something physical" has not chosen between robotics, manufacturing and logistics: leave the sector null and let the interface ask. Filling a slot the player did not choose is the one failure that matters here, because they will live in that world for the whole game.',
  '',
  OUTPUT_DISCIPLINE,
].join('\n');

/** One line per sector: the id the model must use, and what it is. */
function sectorLines(): string[] {
  return SECTORS.map((sector) => `${sector} — ${SECTOR_META[sector].label}: ${SECTOR_META[sector].tagline}`);
}

/** One line per region, same contract. */
function regionLines(): string[] {
  return REGIONS.map((region) => `${region} — ${REGION_META[region].label}: ${REGION_META[region].tagline}`);
}

/** One line per background, grouped by the sector it belongs to. */
function backgroundLines(): string[] {
  return ALL_BACKGROUNDS.map((background) => `${background.id} (${background.sector}) — ${background.label}: ${background.tagline}`);
}

/** What the conversation has already settled, as prose the model can carry forward or overturn. */
function establishedLines(established: SetupProposal | null): string[] {
  if (established === null) return [];
  const lines: string[] = [];
  if (established.companyName) lines.push(`companyName: ${established.companyName}`);
  if (established.founderName) lines.push(`founderName: ${established.founderName}`);
  if (established.sector !== null) lines.push(`sector: ${established.sector}`);
  if (established.region !== null) lines.push(`region: ${established.region}`);
  if (established.backgroundId !== null) lines.push(`backgroundId: ${established.backgroundId}`);
  return lines;
}

export function composeSetupInterpreter(input: SetupInterpreterInput): ComposedPrompt {
  const history = lastN(input.history, SETUP_HISTORY_TURNS).map(
    (turn) => `${turn.role === 'player' ? 'Founder' : 'You'}: ${truncate(turn.text, SETUP_TURN_MAX_CHARS)}`,
  );

  const prompt = joinBlocks([
    '# New game — what does this founder want to build?',
    section('Sectors, by id', bullets(sectorLines())),
    section('Regions, by id', bullets(regionLines())),
    section('Starting backgrounds, by id', bullets(backgroundLines())),
    section('Already established', bullets(establishedLines(input.established))),
    section('The conversation so far', numbered(history)),
    section('What they just said', truncate(input.message, SETUP_TURN_MAX_CHARS)),
    section(
      'Your task',
      [
        'Return the whole proposal, not a delta: every slot the conversation has established, including the ones established earlier.',
        'Leave a slot null rather than guessing at it, and list every null slot in `missing`.',
      ].join('\n'),
    ),
  ]);

  return { system: SETUP_INTERPRETER_SYSTEM, prompt };
}

/**
 * Repair the two things a model gets wrong here, and derive the third.
 *
 * `missing` is recomputed rather than trusted — it is the field the interface
 * asks its next question from, and a model that lists the wrong slots makes the
 * conversation ask for something it already has. A background from a sector the
 * proposal does not name is dropped rather than kept, so the interface asks
 * again instead of the player discovering the substitution after founding.
 */
export function normaliseSetupProposal(proposal: SetupProposal): SetupProposal {
  const background = proposal.backgroundId === null ? null : (ALL_BACKGROUNDS.find((entry) => entry.id === proposal.backgroundId) ?? null);
  const backgroundId = background !== null && (proposal.sector === null || background.sector === proposal.sector) ? background.id : null;
  const next: SetupProposal = { ...proposal, backgroundId, missing: [] };
  return { ...next, missing: [...missingSetupSlots(next)] };
}

/** What the interpreter returns. `output` is always a valid proposal — the established one when no model answered. */
export interface SetupInterpretation {
  readonly output: SetupProposal;
  /** True when nothing schema-valid came back and the established proposal was returned unchanged. */
  readonly fallbackUsed: boolean;
  /** Raw model text, verbatim. Empty when no model was consulted. */
  readonly raw: string;
  readonly modelId: string;
}

/**
 * Read one turn of the new-game conversation.
 *
 * Never throws — the transport contract guarantees that — and never returns
 * anything but a schema-valid proposal, so the caller's only branch is on
 * `fallbackUsed`.
 */
export async function interpretSetup(transport: LlmTransport, input: SetupInterpreterInput): Promise<SetupInterpretation> {
  const composed = composeSetupInterpreter(input);
  const completion = await transport.complete<SetupProposal>({
    role: 'chief_of_staff',
    system: composed.system,
    prompt: composed.prompt,
    schema: SETUP_PROPOSAL_SCHEMA,
    schemaName: SETUP_INTERPRETER_SCHEMA_NAME,
    // Always a fresh session: the whole conversation is in the prompt above, so
    // there is nothing a resumed thread would add except a way for two tabs to
    // read each other's founding.
    sessionKey: null,
  });

  if (completion.output === null) {
    return {
      output: input.established ?? EMPTY_SETUP_PROPOSAL,
      fallbackUsed: true,
      raw: completion.raw,
      modelId: completion.modelId,
    };
  }

  return {
    output: normaliseSetupProposal(completion.output),
    fallbackUsed: false,
    raw: completion.raw,
    modelId: completion.modelId,
  };
}
