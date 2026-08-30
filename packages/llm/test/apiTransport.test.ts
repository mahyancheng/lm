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
import {
  ChiefOfStaffInterpretationSchema,
  GmProposalBatchSchema,
  NarratorOutputSchema,
  NpcActionBundleSchema,
} from '@frontier/contracts';
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

/* -------------------------------------------------------------------------- */
/*  Structured-output schema narrowing                                         */
/* -------------------------------------------------------------------------- */

/** The keywords the structured-output endpoint accepts, per the SDK's transform. */
const SUPPORTED_KEYWORDS = new Set([
  '$ref',
  '$defs',
  'type',
  'anyOf',
  'allOf',
  'description',
  'title',
  'properties',
  'additionalProperties',
  'required',
  'items',
  'format',
  'minItems',
]);

function collectKeywords(node: unknown, out: Set<string>): void {
  if (node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const entry of node) collectKeywords(entry, out);
    return;
  }
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    out.add(key);
    if (key === 'properties' || key === '$defs') {
      for (const child of Object.values(value as Record<string, unknown>)) collectKeywords(child, out);
    } else {
      collectKeywords(value, out);
    }
  }
}

describe('structured-output schema narrowing', () => {
  // Nested, with bounded strings, a bounded array, an enum, an optional field
  // and a nullable one — every shape the contracts schemas actually use.
  const Nested = z.object({
    headline: z.string().min(3).max(80),
    tone: z.enum(['calm', 'strained']),
    items: z
      .array(
        z.object({
          label: z.string().max(24),
          weight: z.number().min(0).max(1),
          note: z.string().optional(),
        }),
      )
      .min(1)
      .max(4),
    parent: z.string().nullable(),
  });

  it('emits no keyword the endpoint would reject', () => {
    const keywords = new Set<string>();
    collectKeywords(outputFormatFor(Nested).schema, keywords);
    expect([...keywords].filter((key) => !SUPPORTED_KEYWORDS.has(key))).toEqual([]);
  });

  it('narrows every contract schema the roles actually send', () => {
    for (const schema of [NarratorOutputSchema, ChiefOfStaffInterpretationSchema, GmProposalBatchSchema, NpcActionBundleSchema]) {
      const keywords = new Set<string>();
      collectKeywords(outputFormatFor(schema).schema, keywords);
      expect([...keywords].filter((key) => !SUPPORTED_KEYWORDS.has(key))).toEqual([]);
    }
  });

  it('forces every object strict, including the ones nested inside arrays', () => {
    const schema = outputFormatFor(Nested).schema as Record<string, unknown>;
    expect(schema['additionalProperties']).toBe(false);
    const properties = schema['properties'] as Record<string, Record<string, unknown>>;
    const items = properties['items']?.['items'] as Record<string, unknown>;
    expect(items['type']).toBe('object');
    expect(items['additionalProperties']).toBe(false);
    // An optional field is simply absent from `required`; the object stays strict.
    expect(items['required']).toEqual(['label', 'weight']);
  });

  it('keeps the bounds the endpoint refuses as keywords by folding them into the description', () => {
    const schema = outputFormatFor(Nested).schema as Record<string, unknown>;
    const properties = schema['properties'] as Record<string, Record<string, unknown>>;

    const headline = properties['headline'] as Record<string, unknown>;
    expect(headline['minLength']).toBeUndefined();
    expect(headline['description']).toContain('minLength: 3');
    expect(headline['description']).toContain('maxLength: 80');

    // minItems survives only at 0 or 1; maxItems never does.
    const items = properties['items'] as Record<string, unknown>;
    expect(items['minItems']).toBe(1);
    expect(items['description']).toContain('maxItems: 4');
  });

  it('rewrites a nullable union to anyOf and drops the $schema marker', () => {
    const schema = outputFormatFor(Nested).schema as Record<string, unknown>;
    expect(schema['$schema']).toBeUndefined();
    expect(JSON.stringify(schema)).not.toContain('$schema');
    const properties = schema['properties'] as Record<string, Record<string, unknown>>;
    const parent = properties['parent'] as Record<string, unknown>;
    expect(Array.isArray(parent['anyOf'])).toBe(true);
  });

  it('still validates against the untouched contract schema on the way back', () => {
    const format = outputFormatFor(NarratorOutputSchema);
    expect(format.parse(JSON.stringify(VALID_NARRATION))).toEqual(VALID_NARRATION);
    expect(() => format.parse('{"headline":"x"}')).toThrow();
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
    // A 400 is a malformed *request*, which is this side's bug. Recording it as
    // invalid_output would blame the model for a schema the endpoint refused.
    ['bad request', new Anthropic.BadRequestError(400, undefined, 'malformed', new Headers()), 'api_error'],
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
