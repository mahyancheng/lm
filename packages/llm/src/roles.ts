/**
 * @frontier/llm — roles.ts
 *
 * The seven in-game roles, wired.
 *
 * Each role is the same five steps, and the order matters:
 *
 * 1. **Compose** the prompt pair from a pre-redacted input. The composer is the
 *    information boundary; nothing reaches a model that did not pass through it.
 * 2. **Call** the transport with the role's schema from
 *    `AGENT_OUTPUT_SCHEMA_NAMES`, so a role can never be wired to the wrong
 *    schema by accident. Strategic roles pass `sessionKey: null` — their calls
 *    are ALWAYS fresh sessions. Only the two dialogue roles pass a conversation
 *    key, which is what gives a Chief of Staff thread or a negotiation genuine
 *    multi-turn memory.
 * 3. **Fall back** deterministically when nothing schema-valid came back. Every
 *    fallback is pure from its inputs: no RNG, no clock, no state.
 * 4. **Post-process** where the contract demands it — the confirmation policy on
 *    a Chief of Staff interpretation is enforced here as well as in the engine.
 * 5. **Record** an `AgentRunRecord` into the injected `RunSink`, with
 *    `contextHash = fnv1a64(stableStringify(input))` so two runs with the same
 *    hash and the same model are comparable.
 *
 * Nothing in this module writes state, and nothing in it returns a value the
 * engine will apply without bounds-checking it first.
 */

import {
  AGENT_OUTPUT_SCHEMA_NAMES,
  type AgentRole,
  type AgentRunRecord,
  CONTRACTS_VERSION,
  CharacterReplySchema,
  type CharacterReply,
  type CharacterUtteranceContext,
  ChiefOfStaffInterpretationSchema,
  type ChiefOfStaffInput,
  type ChiefOfStaffInterpretation,
  GmProposalBatchSchema,
  type GmProposalBatch,
  InnovationProposalSchema,
  type InnovationInterpreterInput,
  type InnovationProposal,
  type LlmFallbackRecord,
  type LlmValidationResult,
  NarratorOutputSchema,
  type NarratorInput,
  type NarratorOutput,
  NpcActionBundleSchema,
  type NpcActionBundle,
  type NpcStrategistInput,
  SocialPostDraftSchema,
  type SocialAuthorInput,
  type SocialPostDraft,
  type WorldDirectorInput,
} from '@frontier/contracts';
import { fnv1a64, stableStringify } from '@frontier/shared';
import type { z } from 'zod';
import { composeCharacterDialogue } from './compose/characterDialogue';
import { composeChiefOfStaff, enforceConfirmationPolicy } from './compose/chiefOfStaff';
import { composeInnovationInterpreter } from './compose/innovationInterpreter';
import { composeNarrator } from './compose/narrator';
import { composeNpcStrategist, type NpcStrategistEvidence } from './compose/npcStrategist';
import { composeSocialAuthor } from './compose/socialAuthor';
import { composeWorldDirector } from './compose/worldDirector';
import type { ComposedPrompt } from './compose/render';
import { INNOVATION_DECLINE_REASON, fallbackCharacterReply, fallbackChiefOfStaff, fallbackNarratorOutput } from './fallbacks';
import { type RunSink, createNullRunSink, safeRunSink } from './runSink';
import { type LlmFailureReason, type LlmTransport, classifyIssues } from './transport/types';

/** Version of the prompts and wiring in this package. Bump when behaviour changes. */
export const AGENT_VERSION = 'llm-1.0.0';

/* -------------------------------------------------------------------------- */
/*  Results                                                                    */
/* -------------------------------------------------------------------------- */

export interface RoleResult<T> {
  readonly role: AgentRole;
  /** The validated model output, the deterministic fallback, or null when the fallback is "do nothing". */
  readonly output: T | null;
  readonly validation: LlmValidationResult;
  /** True when the deterministic fallback ran instead of, or after, the model. */
  readonly fallbackUsed: boolean;
  /** The recorded fallback, or null when the model answered cleanly. */
  readonly fallback: LlmFallbackRecord | null;
  /**
   * Set only by the innovation interpreter's fallback, where declining is the
   * strategy: `'llm_unavailable'`. A node is never added to the Frontier Map
   * without interpretation.
   */
  readonly declineReason: string | null;
  /** Raw model text, verbatim. Empty when no model was consulted. */
  readonly raw: string;
  readonly run: AgentRunRecord;
}

/** Per-call overrides for the fields a run record needs but an input may not carry. */
export interface RoleCallMeta {
  readonly sessionId?: string;
  readonly quarter?: number;
  /** State hash of the session at the moment of the call. */
  readonly inputStateVersion?: string;
}

export interface LlmRolesOptions {
  /** Fallback session id for calls whose input does not carry one. */
  readonly sessionId: string;
  /** Fallback quarter for calls whose input does not carry one. Defaults to 0. */
  readonly quarter?: number;
  readonly runSink?: RunSink;
  readonly agentVersion?: string;
  /** State hash at call time, when the caller has one. Defaults to `'unrecorded'`. */
  readonly inputStateVersion?: string;
}

export interface LlmRoles {
  readonly worldDirector: {
    propose(input: WorldDirectorInput, meta?: RoleCallMeta): Promise<RoleResult<GmProposalBatch>>;
  };
  readonly chiefOfStaff: {
    interpret(input: ChiefOfStaffInput, conversationKey: string, meta?: RoleCallMeta): Promise<RoleResult<ChiefOfStaffInterpretation>>;
  };
  readonly npcStrategist: {
    plan(input: NpcStrategistInput, evidence?: NpcStrategistEvidence, meta?: RoleCallMeta): Promise<RoleResult<NpcActionBundle>>;
  };
  readonly character: {
    converse(context: CharacterUtteranceContext, conversationKey: string, meta?: RoleCallMeta): Promise<RoleResult<CharacterReply>>;
  };
  readonly innovation: {
    interpret(input: InnovationInterpreterInput, meta?: RoleCallMeta): Promise<RoleResult<InnovationProposal>>;
  };
  readonly social: {
    author(input: SocialAuthorInput, meta?: RoleCallMeta): Promise<RoleResult<SocialPostDraft>>;
  };
  readonly narrator: {
    narrate(input: NarratorInput, meta?: RoleCallMeta): Promise<RoleResult<NarratorOutput>>;
  };
}

/* -------------------------------------------------------------------------- */
/*  Factory                                                                    */
/* -------------------------------------------------------------------------- */

export function createLlmRoles(transport: LlmTransport, opts: LlmRolesOptions): LlmRoles {
  const sink = safeRunSink(opts.runSink ?? createNullRunSink());
  const agentVersion = opts.agentVersion ?? AGENT_VERSION;
  const defaultStateVersion = opts.inputStateVersion ?? 'unrecorded';
  const defaultQuarter = opts.quarter ?? 0;
  let sequence = 0;

  /**
   * One role call, end to end. `fallback` returns the deterministic result for
   * this role: `output` null means "the engine does something deterministic
   * instead", which is the correct answer for the World Director, the NPC
   * strategist and the social author.
   */
  async function run<TInput, TOutput>(params: {
    role: AgentRole;
    schema: z.ZodType<TOutput>;
    schemaName: string;
    input: TInput;
    composed: ComposedPrompt;
    sessionKey: string | null;
    sessionId: string;
    quarter: number;
    inputStateVersion: string;
    fallback: () => { output: TOutput | null; declineReason: string | null };
    postProcess?: (value: TOutput) => TOutput;
  }): Promise<RoleResult<TOutput>> {
    const contextHash = fnv1a64(stableStringify(params.input));
    const completion = await transport.complete<TOutput>({
      role: params.role,
      system: params.composed.system,
      prompt: params.composed.prompt,
      schema: params.schema,
      schemaName: params.schemaName,
      sessionKey: params.sessionKey,
    });

    let output: TOutput | null = completion.output;
    let fallbackUsed = false;
    let fallback: LlmFallbackRecord | null = null;
    let declineReason: string | null = null;

    if (output === null) {
      const reason: LlmFailureReason = classifyIssues(completion.validation.issues);
      const applied = params.fallback();
      output = applied.output;
      declineReason = applied.declineReason;
      fallbackUsed = true;
      fallback = {
        sessionId: params.sessionId,
        quarter: params.quarter,
        agentRole: params.role,
        reason,
        strategyApplied: LLM_FALLBACK_STRATEGY_TEXT[params.role],
      };
    } else if (params.postProcess !== undefined) {
      output = params.postProcess(output);
    }

    sequence += 1;
    const record: AgentRunRecord = {
      id: `run_${params.role}_q${params.quarter}_${sequence}_${contextHash}`,
      sessionId: params.sessionId,
      quarter: params.quarter,
      agentRole: params.role,
      agentVersion,
      modelId: completion.modelId,
      schemaVersion: CONTRACTS_VERSION,
      contextHash,
      inputStateVersion: params.inputStateVersion,
      structuredOutput: output,
      validationResult: completion.validation,
      engineResult: null,
      latencyMs: completion.latencyMs,
      tokens: completion.tokens ?? { input: 0, output: 0 },
      fallbackUsed,
      error: completion.validation.ok ? null : completion.validation.issues.join('; ').slice(0, 2000),
    };
    sink.record(record);

    return {
      role: params.role,
      output,
      validation: completion.validation,
      fallbackUsed,
      fallback,
      declineReason,
      raw: completion.raw,
      run: record,
    };
  }

  const resolveMeta = (meta: RoleCallMeta | undefined, sessionId: string | undefined, quarter: number | undefined) => ({
    sessionId: meta?.sessionId ?? sessionId ?? opts.sessionId,
    quarter: meta?.quarter ?? quarter ?? defaultQuarter,
    inputStateVersion: meta?.inputStateVersion ?? defaultStateVersion,
  });

  return {
    worldDirector: {
      async propose(input, meta) {
        const scope = resolveMeta(meta, input.sessionId, input.quarter);
        return run({
          role: 'world_director',
          schema: GmProposalBatchSchema,
          schemaName: AGENT_OUTPUT_SCHEMA_NAMES.world_director,
          input,
          composed: composeWorldDirector(input),
          sessionKey: null,
          ...scope,
          // The engine materialises the drawn candidates from their family
          // templates at the drawn severity. Less character, same weather.
          fallback: () => ({ output: null, declineReason: null }),
        });
      },
    },

    chiefOfStaff: {
      async interpret(input, conversationKey, meta) {
        const scope = resolveMeta(meta, input.sessionId, input.quarter);
        return run({
          role: 'chief_of_staff',
          schema: ChiefOfStaffInterpretationSchema,
          schemaName: AGENT_OUTPUT_SCHEMA_NAMES.chief_of_staff,
          input,
          composed: composeChiefOfStaff(input),
          sessionKey: conversationKey,
          ...scope,
          fallback: () => ({ output: fallbackChiefOfStaff(input), declineReason: null }),
          postProcess: enforceConfirmationPolicy,
        });
      },
    },

    npcStrategist: {
      async plan(input, evidence, meta) {
        const scope = resolveMeta(meta, input.sessionId, input.quarter);
        return run({
          role: 'npc_strategist',
          schema: NpcActionBundleSchema,
          schemaName: AGENT_OUTPUT_SCHEMA_NAMES.npc_strategist,
          input,
          composed: composeNpcStrategist(input, evidence),
          sessionKey: null,
          ...scope,
          // The engine runs the deterministic archetype policy for this
          // company's posture — the same policy background companies use.
          fallback: () => ({ output: null, declineReason: null }),
        });
      },
    },

    character: {
      async converse(context, conversationKey, meta) {
        const scope = resolveMeta(meta, undefined, undefined);
        return run({
          role: 'character_dialogue',
          schema: CharacterReplySchema,
          schemaName: AGENT_OUTPUT_SCHEMA_NAMES.character_dialogue,
          input: context,
          composed: composeCharacterDialogue(context),
          sessionKey: conversationKey,
          ...scope,
          fallback: () => ({ output: fallbackCharacterReply(context), declineReason: null }),
        });
      },
    },

    innovation: {
      async interpret(input, meta) {
        const scope = resolveMeta(meta, input.sessionId, input.quarter);
        return run({
          role: 'innovation_interpreter',
          schema: InnovationProposalSchema,
          schemaName: AGENT_OUTPUT_SCHEMA_NAMES.innovation_interpreter,
          input,
          composed: composeInnovationInterpreter(input),
          sessionKey: null,
          ...scope,
          // Decline and leave the Frontier Map unchanged. A node is never added
          // without interpretation.
          fallback: () => ({ output: null, declineReason: INNOVATION_DECLINE_REASON }),
        });
      },
    },

    social: {
      async author(input, meta) {
        const scope = resolveMeta(meta, undefined, undefined);
        return run({
          role: 'social_author',
          schema: SocialPostDraftSchema,
          schemaName: AGENT_OUTPUT_SCHEMA_NAMES.social_author,
          input,
          composed: composeSocialAuthor(input),
          sessionKey: null,
          ...scope,
          // Publish nothing. Structured campaigns still run.
          fallback: () => ({ output: null, declineReason: null }),
        });
      },
    },

    narrator: {
      async narrate(input, meta) {
        const scope = resolveMeta(meta, input.sessionId, input.quarter);
        return run({
          role: 'narrator',
          schema: NarratorOutputSchema,
          schemaName: AGENT_OUTPUT_SCHEMA_NAMES.narrator,
          input,
          composed: composeNarrator(input),
          sessionKey: null,
          ...scope,
          fallback: () => ({ output: fallbackNarratorOutput(input), declineReason: null }),
        });
      },
    },
  };
}

/* -------------------------------------------------------------------------- */
/*  Strategy text                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The `strategyApplied` string recorded on an `LlmFallbackRecord`, taken
 * verbatim from `LLM_FALLBACK_STRATEGIES` in the contracts so the ledger and
 * the documentation can never drift apart.
 */
const LLM_FALLBACK_STRATEGY_TEXT: Record<AgentRole, string> = {
  world_director: 'Apply the candidate skeletons using their event family template modifiers at the drawn severity.',
  chief_of_staff: 'Fall back to the normal controls: the instruction is echoed back for the player to submit themselves.',
  npc_strategist: 'Run the deterministic archetype policy for that company\'s posture.',
  character_dialogue: 'Return a short templated reply consistent with traits and relationship, and store no commitment.',
  innovation_interpreter: 'Decline the proposal and leave the Frontier Map unchanged.',
  social_author: 'Publish nothing. Structured marketing campaigns still run.',
  narrator: 'Render the resolution report lines directly.',
};
