/**
 * `api` transport tests.
 *
 * The client is a stub throughout: no request ever leaves the process and no
 * `ANTHROPIC_API_KEY` is required to run these. What is being checked is that
 * every typed provider error becomes a failed completion with the right
 * fallback reason — never a throw that would kill a quarter resolution.
 */

import { describe, expect, it } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { NarratorOutputSchema } from '@frontier/contracts';
import { DEFAULT_API_MAX_TOKENS, DEFAULT_API_MODEL, createApiTransport, outputFormatFor } from '../src/transport/api';
import { classifyIssues } from '../src/transport/types';
import { VALID_NARRATION } from './fixtures';

const TinySchema = z.object({ a: z.number() });

function clientReturning(response: unknown, capture?: { params?: Record<string, unknown> }): Anthropic {
  return {
    messages: {
      parse: async (params: Record<string, unknown>) => {
        if (capture !== undefined) capture.params = params;
        return response;
      },
    },
  } as unknown as Anthropic;
}

function clientThrowing(error: unknown): Anthropic {
  return {
    messages: {
      parse: async () => {
        throw error;
      },
    },
  } as unknown as Anthropic;
}

const request = <T>(schema: z.ZodType<T>) => ({
  role: 'narrator' as const,
  system: 'You write the quarter summary.',
  prompt: 'the committed lines',
  schema,
  schemaName: 'NarratorOutputSchema',
  sessionKey: null,
});

describe('output format', () => {
  it('is a json_schema format whose parse runs the contract schema', () => {
    const format = outputFormatFor(TinySchema);
    expect(format.type).toBe('json_schema');
    expect(format.schema['type']).toBe('object');
    expect(format.parse('{"a":3}')).toEqual({ a: 3 });
    expect(() => format.parse('{"a":"no"}')).toThrow();
  });

  it('inlines rather than emitting $ref, which models follow badly', () => {
    const format = outputFormatFor(NarratorOutputSchema);
    expect(JSON.stringify(format.schema)).not.toContain('$ref');
  });
});

describe('successful call', () => {
  it('returns the validated output, the token usage and the reported model', async () => {
    const capture: { params?: Record<string, unknown> } = {};
    const transport = createApiTransport({
      client: clientReturning(
        {
          content: [{ type: 'text', text: JSON.stringify(VALID_NARRATION) }],
          parsed_output: VALID_NARRATION,
          usage: { input_tokens: 1500, output_tokens: 300 },
          model: 'claude-sonnet-5',
        },
        capture,
      ),
      env: {},
    });

    const completion = await transport.complete(request(NarratorOutputSchema));

    expect(transport.kind).toBe('api');
    expect(completion.validation.ok).toBe(true);
    expect(completion.output).toEqual(VALID_NARRATION);
    expect(completion.tokens).toEqual({ input: 1500, output: 300 });
    expect(completion.modelId).toBe('claude-sonnet-5');
    expect(completion.claudeSessionId).toBeNull();
  });

  it('sends the model, the output ceiling and a cacheable system prefix', async () => {
    const capture: { params?: Record<string, unknown> } = {};
    const transport = createApiTransport({ client: clientReturning({ content: [], parsed_output: VALID_NARRATION, usage: {} }, capture), env: {} });
    await transport.complete(request(NarratorOutputSchema));

    expect(capture.params?.['model']).toBe(DEFAULT_API_MODEL);
    expect(capture.params?.['max_tokens']).toBe(DEFAULT_API_MAX_TOKENS);
    expect(capture.params?.['system']).toEqual([{ type: 'text', text: 'You write the quarter summary.', cache_control: { type: 'ephemeral' } }]);
    // Adaptive thinking is the model default; budget_tokens is never sent.
    expect(capture.params?.['thinking']).toBeUndefined();
  });

  it('takes the model from ANTHROPIC_MODEL when the config does not name one', async () => {
    const capture: { params?: Record<string, unknown> } = {};
    const transport = createApiTransport({ client: clientReturning({ content: [], parsed_output: VALID_NARRATION, usage: {} }, capture), env: { ANTHROPIC_MODEL: 'claude-opus-5' } });
    await transport.complete(request(NarratorOutputSchema));
    expect(capture.params?.['model']).toBe('claude-opus-5');
  });

  it('treats a null parsed_output as a failure rather than a guess', async () => {
    const transport = createApiTransport({ client: clientReturning({ content: [{ type: 'text', text: 'sorry' }], parsed_output: null, usage: {} }), env: {} });
    const completion = await transport.complete(request(NarratorOutputSchema));
    expect(completion.output).toBeNull();
    expect(classifyIssues(completion.validation.issues)).toBe('invalid_output');
    expect(completion.raw).toBe('sorry');
  });

  it('re-checks parsed_output against the schema', async () => {
    const transport = createApiTransport({ client: clientReturning({ content: [], parsed_output: { headline: 'x', body: 'y', tone: 'jubilant' }, usage: {} }), env: {} });
    const completion = await transport.complete(request(NarratorOutputSchema));
    expect(completion.output).toBeNull();
    expect(completion.validation.ok).toBe(false);
  });
});

describe('typed error handling', () => {
  const cases: [string, unknown, string][] = [
    ['rate limit', new Anthropic.RateLimitError(429, undefined, 'slow down', new Headers()), 'rate_limited'],
    ['authentication', new Anthropic.AuthenticationError(401, undefined, 'bad key', new Headers()), 'disabled'],
    ['permission denied', new Anthropic.PermissionDeniedError(403, undefined, 'not allowed', new Headers()), 'disabled'],
    ['bad request', new Anthropic.BadRequestError(400, undefined, 'malformed', new Headers()), 'invalid_output'],
    ['connection timeout', new Anthropic.APIConnectionTimeoutError({ message: 'took too long' }), 'timeout'],
    ['connection', new Anthropic.APIConnectionError({ message: 'socket hang up' }), 'api_error'],
    ['internal server', new Anthropic.InternalServerError(500, undefined, 'boom', new Headers()), 'api_error'],
    ['non-API', new Error('something else entirely'), 'api_error'],
  ];

  for (const [label, error, expected] of cases) {
    it(`turns a ${label} error into a ${expected} fallback rather than a throw`, async () => {
      const transport = createApiTransport({ client: clientThrowing(error), env: {} });
      const completion = await transport.complete(request(NarratorOutputSchema));
      expect(completion.output).toBeNull();
      expect(completion.validation.ok).toBe(false);
      expect(classifyIssues(completion.validation.issues)).toBe(expected);
    });
  }
});
