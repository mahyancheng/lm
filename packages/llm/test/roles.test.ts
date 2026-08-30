/**
 * Role wiring tests.
 *
 * The three things that must never regress:
 *
 * 1. Each role is wired to the schema `AGENT_OUTPUT_SCHEMA_NAMES` names for it.
 * 2. Strategic calls always pass `sessionKey: null` — a fresh session, context
 *    rebuilt from state — while dialogue calls carry a stable conversation key.
 * 3. When nothing schema-valid comes back, the deterministic fallback for that
 *    role runs, and a run record is written either way.
 */

import { describe, expect, it } from 'vitest';
import { AGENT_OUTPUT_SCHEMA_NAMES, CONTRACTS_VERSION, CharacterReplySchema, ChiefOfStaffInterpretationSchema, NarratorOutputSchema } from '@frontier/contracts';
import { AGENT_VERSION, contextHashFor, createLlmRoles } from '../src/roles';
import { EMPTY_NPC_EVIDENCE, composeNpcStrategist } from '../src/compose/npcStrategist';
import { createMemoryRunSink } from '../src/runSink';
import { createNullTransport } from '../src/transport/none';
import { INNOVATION_DECLINE_REASON } from '../src/fallbacks';
import {
  NEXUS_ID,
  ORBIT_ID,
  SESSION_ID,
  VALID_CHARACTER_REPLY,
  VALID_GM_BATCH,
  VALID_INNOVATION_PROPOSAL,
  VALID_NARRATION,
  VALID_NPC_BUNDLE,
  VALID_SOCIAL_POST,
  chiefOfStaffInput,
  createMockTransport,
  innovationInput,
  narratorInput,
  npcStrategistInput,
  socialInput,
  utteranceContext,
  worldDirectorInput,
} from './fixtures';

const ROLES_OPTIONS = { sessionId: SESSION_ID, quarter: 1, inputStateVersion: 'state-abc' };

describe('role wiring', () => {
  it('passes each role its own output schema and the right session key', async () => {
    const transport = createMockTransport((call) => {
      switch (call.role) {
        case 'world_director':
          return VALID_GM_BATCH;
        case 'npc_strategist':
          return VALID_NPC_BUNDLE;
        case 'chief_of_staff':
          return { interpretedInstructions: [], summary: 'Nothing has been submitted yet.', questions: [], requiresConfirmation: false, confidence: 0.9, unsupportedRequests: [] };
        case 'character_dialogue':
          return VALID_CHARACTER_REPLY;
        case 'innovation_interpreter':
          return VALID_INNOVATION_PROPOSAL;
        case 'social_author':
          return VALID_SOCIAL_POST;
        case 'narrator':
          return VALID_NARRATION;
      }
    });
    const roles = createLlmRoles(transport, ROLES_OPTIONS);

    await roles.worldDirector.propose(worldDirectorInput());
    await roles.npcStrategist.plan(npcStrategistInput());
    await roles.chiefOfStaff.interpret(chiefOfStaffInput(), 'cos:demo:player-1');
    await roles.character.converse(utteranceContext(), 'chr:demo:conv-9');
    await roles.innovation.interpret(innovationInput());
    await roles.social.author(socialInput());
    await roles.narrator.narrate(narratorInput());

    const byRole = new Map(transport.calls.map((call) => [call.role, call]));
    for (const [role, schemaName] of Object.entries(AGENT_OUTPUT_SCHEMA_NAMES)) {
      expect(byRole.get(role as keyof typeof AGENT_OUTPUT_SCHEMA_NAMES)?.schemaName).toBe(schemaName);
    }

    // Strategic calls are ALWAYS fresh sessions.
    expect(byRole.get('world_director')?.sessionKey).toBeNull();
    expect(byRole.get('npc_strategist')?.sessionKey).toBeNull();
    expect(byRole.get('innovation_interpreter')?.sessionKey).toBeNull();
    expect(byRole.get('social_author')?.sessionKey).toBeNull();
    expect(byRole.get('narrator')?.sessionKey).toBeNull();

    // Dialogue calls carry their conversation key.
    expect(byRole.get('chief_of_staff')?.sessionKey).toBe('cos:demo:player-1');
    expect(byRole.get('character_dialogue')?.sessionKey).toBe('chr:demo:conv-9');
  });

  it('keeps the same conversation key across turns of one dialogue', async () => {
    const transport = createMockTransport(() => VALID_CHARACTER_REPLY);
    const roles = createLlmRoles(transport, ROLES_OPTIONS);
    await roles.character.converse(utteranceContext(), 'chr:demo:conv-9');
    await roles.character.converse(utteranceContext({ topic: 'a follow-up on the break clause' }), 'chr:demo:conv-9');
    expect(transport.calls.map((call) => call.sessionKey)).toEqual(['chr:demo:conv-9', 'chr:demo:conv-9']);
  });

  it('returns the validated model output when the model answers cleanly', async () => {
    const transport = createMockTransport(() => VALID_GM_BATCH);
    const roles = createLlmRoles(transport, ROLES_OPTIONS);
    const result = await roles.worldDirector.propose(worldDirectorInput());
    expect(result.output?.proposals).toHaveLength(1);
    expect(result.fallbackUsed).toBe(false);
    expect(result.fallback).toBeNull();
    expect(result.validation.ok).toBe(true);
  });

  it('forces confirmation on the interpretation even when the model said otherwise', async () => {
    const transport = createMockTransport(() => ({
      interpretedInstructions: [{ type: 'layoff', role: 'engineers', count: 40, severanceQuartersOfPay: 1 }],
      summary: 'Reduce engineering headcount by 40 with one quarter of severance. Nothing has been submitted yet.',
      questions: [],
      requiresConfirmation: false,
      confidence: 0.92,
      unsupportedRequests: [],
    }));
    const roles = createLlmRoles(transport, ROLES_OPTIONS);
    const result = await roles.chiefOfStaff.interpret(chiefOfStaffInput(), 'cos:demo');
    expect(result.output?.requiresConfirmation).toBe(true);
    expect(result.fallbackUsed).toBe(false);
  });
});

describe('run records', () => {
  it('captures role, model, context hash, schema version and tokens', async () => {
    const sink = createMemoryRunSink();
    const transport = createMockTransport(() => VALID_NPC_BUNDLE, { modelId: 'sonnet', tokens: { input: 900, output: 220 } });
    const roles = createLlmRoles(transport, { ...ROLES_OPTIONS, runSink: sink });

    const input = npcStrategistInput();
    const result = await roles.npcStrategist.plan(input);

    expect(sink.runs).toHaveLength(1);
    const run = sink.runs[0];
    expect(run).toBeDefined();
    expect(run?.agentRole).toBe('npc_strategist');
    expect(run?.modelId).toBe('sonnet');
    expect(run?.agentVersion).toBe(AGENT_VERSION);
    expect(run?.schemaVersion).toBe(CONTRACTS_VERSION);
    expect(run?.sessionId).toBe(SESSION_ID);
    expect(run?.quarter).toBe(1);
    expect(run?.inputStateVersion).toBe('state-abc');
    expect(run?.contextHash).toBe(contextHashFor(composeNpcStrategist(input), null));
    expect(run?.tokens).toEqual({ input: 900, output: 220 });
    expect(run?.fallbackUsed).toBe(false);
    expect(run?.error).toBeNull();
    expect(run?.structuredOutput).toEqual(result.output);
    expect(result.run).toBe(run);
  });

  it('gives the same context hash for the same input and a different one otherwise', async () => {
    const sink = createMemoryRunSink();
    const transport = createMockTransport(() => VALID_NPC_BUNDLE);
    const roles = createLlmRoles(transport, { ...ROLES_OPTIONS, runSink: sink });

    await roles.npcStrategist.plan(npcStrategistInput());
    await roles.npcStrategist.plan(npcStrategistInput());
    await roles.npcStrategist.plan(npcStrategistInput({ priorPosture: 'survival' }));

    expect(sink.runs[0]?.contextHash).toBe(sink.runs[1]?.contextHash);
    expect(sink.runs[0]?.contextHash).not.toBe(sink.runs[2]?.contextHash);
    // Ids stay distinct even when the context repeats, so two runs never collide.
    expect(sink.runs[0]?.id).not.toBe(sink.runs[1]?.id);
  });

  it('covers the NPC evidence, which never appears in the input', async () => {
    const sink = createMemoryRunSink();
    const transport = createMockTransport(() => VALID_NPC_BUNDLE);
    const roles = createLlmRoles(transport, { ...ROLES_OPTIONS, runSink: sink });
    const input = npcStrategistInput();

    await roles.npcStrategist.plan(input, {
      ...EMPTY_NPC_EVIDENCE,
      rivalSignals: [{ companyId: ORBIT_ID, basis: 'public filing', observation: 'Orbit is hiring inference engineers hard.' }],
    });
    await roles.npcStrategist.plan(input, {
      ...EMPTY_NPC_EVIDENCE,
      rivalSignals: [{ companyId: ORBIT_ID, basis: 'public filing', observation: 'Orbit has frozen hiring entirely.' }],
    });

    // Same input, opposite rival intelligence. Two runs this different must
    // never report the same context hash.
    expect(transport.calls[0]?.prompt).not.toBe(transport.calls[1]?.prompt);
    expect(sink.runs[0]?.contextHash).not.toBe(sink.runs[1]?.contextHash);
  });

  it('separates two dialogue threads that differ only by conversation key', async () => {
    const sink = createMemoryRunSink();
    const roles = createLlmRoles(createMockTransport(() => VALID_CHARACTER_REPLY), { ...ROLES_OPTIONS, runSink: sink });
    const context = utteranceContext();

    await roles.character.converse(context, 'chr:session:player-a:maya');
    await roles.character.converse(context, 'chr:session:player-b:maya');
    await roles.character.converse(context, 'chr:session:player-a:maya');

    // The resumed transcript cannot be hashed, but the thread it belongs to can:
    // two seats never share a hash, and one seat is stable across turns.
    expect(sink.runs[0]?.contextHash).not.toBe(sink.runs[1]?.contextHash);
    expect(sink.runs[0]?.contextHash).toBe(sink.runs[2]?.contextHash);
  });

  it('records the failure and the fallback when nothing valid came back', async () => {
    const sink = createMemoryRunSink();
    const roles = createLlmRoles(createNullTransport(), { ...ROLES_OPTIONS, runSink: sink });

    const result = await roles.narrator.narrate(narratorInput());

    expect(result.fallbackUsed).toBe(true);
    expect(result.fallback?.reason).toBe('disabled');
    expect(result.fallback?.agentRole).toBe('narrator');
    expect(result.fallback?.strategyApplied).toContain('Render the resolution report lines');
    expect(sink.runs[0]?.fallbackUsed).toBe(true);
    expect(sink.runs[0]?.error).toContain('disabled:');
    expect(sink.runs[0]?.tokens).toEqual({ input: 0, output: 0 });
  });

  it('never lets a broken run sink break a call', async () => {
    const roles = createLlmRoles(createMockTransport(() => VALID_GM_BATCH), {
      ...ROLES_OPTIONS,
      runSink: {
        record() {
          throw new Error('the ledger is on fire');
        },
      },
    });
    const result = await roles.worldDirector.propose(worldDirectorInput());
    expect(result.output).not.toBeNull();
  });
});

describe('fallback strategies through the role layer', () => {
  const roles = () => createLlmRoles(createNullTransport(), ROLES_OPTIONS);

  it('world director: null, so the engine materialises the drawn candidates', async () => {
    const result = await roles().worldDirector.propose(worldDirectorInput());
    expect(result.output).toBeNull();
    expect(result.fallbackUsed).toBe(true);
    expect(result.declineReason).toBeNull();
  });

  it('npc strategist: null, so the engine runs the archetype policy', async () => {
    const result = await roles().npcStrategist.plan(npcStrategistInput());
    expect(result.output).toBeNull();
    expect(result.fallbackUsed).toBe(true);
  });

  it('social author: null, so nothing is published', async () => {
    const result = await roles().social.author(socialInput());
    expect(result.output).toBeNull();
    expect(result.fallbackUsed).toBe(true);
  });

  it('innovation interpreter: declines with llm_unavailable and adds no node', async () => {
    const result = await roles().innovation.interpret(innovationInput());
    expect(result.output).toBeNull();
    expect(result.declineReason).toBe(INNOVATION_DECLINE_REASON);
    expect(result.fallback?.strategyApplied).toContain('leave the Frontier Map unchanged');
  });

  it('chief of staff: a schema-valid echo requiring confirmation', async () => {
    const result = await roles().chiefOfStaff.interpret(chiefOfStaffInput(), 'cos:demo');
    expect(ChiefOfStaffInterpretationSchema.safeParse(result.output).success).toBe(true);
    expect(result.output?.requiresConfirmation).toBe(true);
    expect(result.output?.interpretedInstructions).toEqual([]);
  });

  it('character dialogue: a schema-valid templated reply with no commitment', async () => {
    const result = await roles().character.converse(utteranceContext(), 'chr:demo');
    expect(CharacterReplySchema.safeParse(result.output).success).toBe(true);
    expect(result.output?.newCommitment).toBeNull();
  });

  it('narrator: a schema-valid rendering of the committed lines', async () => {
    const result = await roles().narrator.narrate(narratorInput());
    expect(NarratorOutputSchema.safeParse(result.output).success).toBe(true);
    expect(result.output?.body).toContain('Accelerator supply tightened');
  });

  it('is deterministic across two identical outages', async () => {
    const first = await roles().character.converse(utteranceContext(), 'chr:demo');
    const second = await roles().character.converse(utteranceContext(), 'chr:demo');
    expect(first.output).toEqual(second.output);
  });
});

describe('call metadata', () => {
  it('takes sessionId and quarter from the input when it carries them', async () => {
    const sink = createMemoryRunSink();
    const roles = createLlmRoles(createNullTransport(), { sessionId: 'placeholder', runSink: sink });
    await roles.worldDirector.propose(worldDirectorInput({ sessionId: 'other-session', quarter: 7 }));
    expect(sink.runs[0]?.sessionId).toBe('other-session');
    expect(sink.runs[0]?.quarter).toBe(7);
  });

  it('falls back to the roles options, then to per-call meta, for inputs that carry neither', async () => {
    const sink = createMemoryRunSink();
    const roles = createLlmRoles(createNullTransport(), { sessionId: SESSION_ID, quarter: 3, runSink: sink });
    await roles.social.author(socialInput());
    expect(sink.runs[0]?.sessionId).toBe(SESSION_ID);
    expect(sink.runs[0]?.quarter).toBe(3);

    await roles.character.converse(utteranceContext(), 'chr:demo', { sessionId: 'meta-session', quarter: 9, inputStateVersion: 'state-xyz' });
    expect(sink.runs[1]?.sessionId).toBe('meta-session');
    expect(sink.runs[1]?.quarter).toBe(9);
    expect(sink.runs[1]?.inputStateVersion).toBe('state-xyz');
  });

  it('scopes an npc plan to the company it names', async () => {
    const transport = createMockTransport(() => VALID_NPC_BUNDLE);
    const roles = createLlmRoles(transport, ROLES_OPTIONS);
    const result = await roles.npcStrategist.plan(npcStrategistInput());
    expect(result.output?.companyId).toBe(NEXUS_ID);
  });
});
