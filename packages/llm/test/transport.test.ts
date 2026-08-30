/**
 * Transport tests. No live model is contacted: the Agent SDK's `query()` is
 * injected as a scripted stub, and the API transport is never constructed
 * against a real key.
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { GmProposalBatchSchema } from '@frontier/contracts';
import { extractJsonObject, firstBalancedObject, stripCodeFence } from '../src/transport/json';
import type { ClaudeQueryFn } from '../src/transport/claudeSession';
import {
  DISALLOWED_TOOLS,
  JSON_PROTOCOL_INSTRUCTION,
  buildQueryOptions,
  buildSystemPrompt,
  createClaudeSessionTransport,
} from '../src/transport/claudeSession';
import { createNullTransport } from '../src/transport/none';
import { LLM_SKIPPED_ISSUE, classifyIssues, isSkipped } from '../src/transport/types';
import { createInMemorySessionStore } from '../src/sessionStore';
import { VALID_GM_BATCH, stubQuery } from './fixtures';

const TinySchema = z.object({ a: z.number(), b: z.string() });

describe('JSON extraction', () => {
  it('parses a bare object', () => {
    const result = extractJsonObject('{"a":1,"b":"x"}');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ a: 1, b: 'x' });
  });

  it('strips a fenced code block', () => {
    expect(stripCodeFence('```json\n{"a":1}\n```').trim()).toBe('{"a":1}');
    const result = extractJsonObject('```json\n{"a":1,"b":"x"}\n```');
    expect(result.ok).toBe(true);
  });

  it('ignores prose before and after the object', () => {
    const result = extractJsonObject('Sure — here is the proposal you asked for:\n\n{"a":2,"b":"y"}\n\nLet me know if you want a quieter quarter.');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ a: 2, b: 'y' });
  });

  it('keeps nested objects and braces inside strings intact', () => {
    const text = 'noise {"outer":{"inner":{"deep":1}},"note":"a } inside a string {"} tail';
    const balanced = firstBalancedObject(text);
    expect(balanced).toBe('{"outer":{"inner":{"deep":1}},"note":"a } inside a string {"}');
    const result = extractJsonObject(text);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ outer: { inner: { deep: 1 } }, note: 'a } inside a string {' });
  });

  it('survives an escaped quote before a brace', () => {
    const result = extractJsonObject('{"note":"they said \\"no }\\" and left"}');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ note: 'they said "no }" and left' });
  });

  it('refuses a bare array, a bare string and an unbalanced object', () => {
    expect(extractJsonObject('[1,2,3]').ok).toBe(false);
    expect(extractJsonObject('"just prose"').ok).toBe(false);
    expect(extractJsonObject('{"a": 1').ok).toBe(false);
    expect(extractJsonObject('   ').ok).toBe(false);
  });
});

describe('null transport', () => {
  it('always skips, and marks the skip so a fallback can be attributed to a disabled model', async () => {
    const transport = createNullTransport();
    const completion = await transport.complete({
      role: 'world_director',
      system: 's',
      prompt: 'p',
      schema: GmProposalBatchSchema,
      schemaName: 'GmProposalBatchSchema',
      sessionKey: null,
    });
    expect(transport.kind).toBe('none');
    expect(completion.output).toBeNull();
    expect(completion.validation.ok).toBe(false);
    expect(completion.validation.issues).toEqual([LLM_SKIPPED_ISSUE]);
    expect(isSkipped(completion.validation)).toBe(true);
    expect(classifyIssues(completion.validation.issues)).toBe('disabled');
    expect(completion.tokens).toBeNull();
    expect(completion.latencyMs).toBe(0);
  });
});

describe('claude-session transport', () => {
  const request = <T>(schema: z.ZodType<T>, sessionKey: string | null) => ({
    role: 'chief_of_staff' as const,
    system: 'You are a role.',
    prompt: 'Do the thing.',
    schema,
    schemaName: 'TinySchema',
    sessionKey,
  });

  it('locks the session down: no tools, no settings, one turn', () => {
    const options = buildQueryOptions({ system: 'sys', model: 'sonnet', resume: null, oauthToken: undefined, cwd: undefined, env: {} });
    expect(options.allowedTools).toEqual([]);
    expect(options.disallowedTools).toEqual([...DISALLOWED_TOOLS]);
    expect(options.settingSources).toEqual([]);
    expect(options.permissionMode).toBe('dontAsk');
    expect(options.maxTurns).toBe(1);
    expect(options.model).toBe('sonnet');
    expect(options.resume).toBeUndefined();
    expect(options.env).toBeUndefined();
  });

  it('forwards the OAuth token through the subprocess environment', () => {
    const options = buildQueryOptions({ system: 'sys', model: 'sonnet', resume: 'abc', oauthToken: 'tok', cwd: undefined, env: { PATH: '/bin' } });
    expect(options.resume).toBe('abc');
    expect(options.env).toEqual({ PATH: '/bin', CLAUDE_CODE_OAUTH_TOKEN: 'tok' });
  });

  it('puts the JSON Schema into the system prompt', () => {
    const system = buildSystemPrompt('Role text.', '{"type":"object"}');
    expect(system).toContain('Role text.');
    expect(system).toContain(JSON_PROTOCOL_INSTRUCTION);
    expect(system.endsWith('{"type":"object"}')).toBe(true);
  });

  it('defaults the model to sonnet and reads LLM_MODEL from the supplied env', async () => {
    const stub = stubQuery([{ text: '{"a":1,"b":"x"}', sessionId: 's1' }]);
    const transport = createClaudeSessionTransport({ queryFn: stub.fn, env: {} });
    await transport.complete(request(TinySchema, null));
    expect(stub.calls[0]?.options?.model).toBe('sonnet');

    const stub2 = stubQuery([{ text: '{"a":1,"b":"x"}', sessionId: 's1' }]);
    const transport2 = createClaudeSessionTransport({ queryFn: stub2.fn, env: { LLM_MODEL: 'claude-sonnet-5' } });
    await transport2.complete(request(TinySchema, null));
    expect(stub2.calls[0]?.options?.model).toBe('claude-sonnet-5');
  });

  it('resumes a stored conversation and writes back the new session id', async () => {
    const store = createInMemorySessionStore({ 'cos:demo': 'session-old' });
    const stub = stubQuery([{ text: '{"a":1,"b":"x"}', sessionId: 'session-new' }]);
    const transport = createClaudeSessionTransport({ queryFn: stub.fn, sessionStore: store, env: {} });

    const completion = await transport.complete(request(TinySchema, 'cos:demo'));

    expect(stub.calls[0]?.options?.resume).toBe('session-old');
    expect(completion.claudeSessionId).toBe('session-new');
    expect(store.peek('cos:demo')).toBe('session-new');
    expect(completion.output).toEqual({ a: 1, b: 'x' });
    expect(completion.tokens).toEqual({ input: 1234, output: 567 });
    expect(completion.modelId).toBe('claude-sonnet-5');
  });

  it('never resumes and never stores for a strategic call', async () => {
    const store = createInMemorySessionStore({ 'cos:demo': 'session-old' });
    const stub = stubQuery([{ text: '{"a":1,"b":"x"}', sessionId: 'session-new' }]);
    const transport = createClaudeSessionTransport({ queryFn: stub.fn, sessionStore: store, env: {} });

    await transport.complete(request(TinySchema, null));

    expect(stub.calls[0]?.options?.resume).toBeUndefined();
    expect(store.entries()).toEqual([['cos:demo', 'session-old']]);
  });

  it('retries once with the zod error summary and records the run as repaired', async () => {
    const stub = stubQuery([
      { text: '{"a":"not a number","b":"x"}', sessionId: 'session-1' },
      { text: '```json\n{"a":7,"b":"x"}\n```', sessionId: 'session-1' },
    ]);
    const transport = createClaudeSessionTransport({ queryFn: stub.fn, env: {} });

    const completion = await transport.complete(request(TinySchema, null));

    expect(stub.calls).toHaveLength(2);
    expect(completion.output).toEqual({ a: 7, b: 'x' });
    expect(completion.validation.ok).toBe(true);
    expect(completion.validation.repaired).toBe(true);
    expect(completion.validation.issues.length).toBeGreaterThan(0);

    const retryPrompt = stub.calls[1]?.prompt ?? '';
    expect(retryPrompt).toContain('did not satisfy the schema');
    expect(retryPrompt).toContain('a:');
    // The repair resumes the attempt it is repairing, so the model sees its own reply.
    expect(stub.calls[1]?.options?.resume).toBe('session-1');
  });

  it('gives up after the second failure without throwing', async () => {
    const stub = stubQuery([
      { text: 'no json here at all', sessionId: 'session-1' },
      { text: 'still no json', sessionId: 'session-1' },
    ]);
    const transport = createClaudeSessionTransport({ queryFn: stub.fn, env: {} });

    const completion = await transport.complete(request(TinySchema, null));

    expect(stub.calls).toHaveLength(2);
    expect(completion.output).toBeNull();
    expect(completion.validation.ok).toBe(false);
    expect(completion.validation.repaired).toBe(false);
    expect(classifyIssues(completion.validation.issues)).toBe('invalid_output');
  });

  it('makes only one attempt when the repair is disabled', async () => {
    const stub = stubQuery([{ text: 'not json', sessionId: 's' }]);
    const transport = createClaudeSessionTransport({ queryFn: stub.fn, env: {}, repairOnce: false });
    const completion = await transport.complete(request(TinySchema, null));
    expect(stub.calls).toHaveLength(1);
    expect(completion.output).toBeNull();
    expect(completion.validation.repaired).toBe(false);
  });

  it('turns a thrown transport error into a failed completion, never a throw', async () => {
    const boom: ClaudeQueryFn = () => {
      throw new Error('connection reset by peer');
    };
    const transport = createClaudeSessionTransport({ queryFn: boom, env: {} });
    const completion = await transport.complete(request(TinySchema, null));
    expect(completion.output).toBeNull();
    expect(classifyIssues(completion.validation.issues)).toBe('api_error');
  });

  it('classifies a timeout distinctly from a generic API error', async () => {
    const transport = createClaudeSessionTransport({
      queryFn: () => {
        throw new Error('request timed out after 60s');
      },
      env: {},
    });
    const completion = await transport.complete(request(TinySchema, null));
    expect(classifyIssues(completion.validation.issues)).toBe('timeout');
  });

  it('validates a real contract schema end to end', async () => {
    const stub = stubQuery([{ text: JSON.stringify(VALID_GM_BATCH), sessionId: 's' }]);
    const transport = createClaudeSessionTransport({ queryFn: stub.fn, env: {} });
    const completion = await transport.complete({
      role: 'world_director',
      system: 'You are the World Director.',
      prompt: 'dossier',
      schema: GmProposalBatchSchema,
      schemaName: 'GmProposalBatchSchema',
      sessionKey: null,
    });
    expect(completion.validation.ok).toBe(true);
    expect(completion.output?.proposals).toHaveLength(1);
    // The JSON Schema really did reach the system prompt.
    expect(stub.calls[0]?.options?.systemPrompt).toContain('quarterSummary');
  });
});
