/**
 * @frontier/llm — transport/api.ts
 *
 * The **fallback** transport: the metered Anthropic API through
 * `@anthropic-ai/sdk`. Selected with `LLM_TRANSPORT=api`; it requires an
 * `ANTHROPIC_API_KEY`, which the default `claude-session` path never does.
 *
 * Conventions from docs/LLM_CONTRACTS.md §9, all mandatory here:
 *
 * - **Structured outputs, not hand-rolled JSON prompting.** `messages.parse`
 *   with an `output_config.format` whose `parse` is the contract schema, so
 *   `parsed_output` is either the validated object or null — never a guess.
 * - **Thinking is adaptive**, which is the model default. `budget_tokens` is
 *   never sent; current models reject it.
 * - **Typed errors**, most specific first, never string matching. Every one
 *   becomes a failed `LlmCompletion`, never a throw that kills the resolver.
 * - **Caching.** The stable per-role system prefix carries
 *   `cache_control: { type: 'ephemeral' }`; the volatile dossier goes after it
 *   as the user message.
 *
 * ### Why not `zodOutputFormat`
 *
 * `@anthropic-ai/sdk/helpers/zod` is typed against **zod v4** (`import * as z
 * from 'zod/v4'`), while `@frontier/contracts` is pinned to the zod 3 classic
 * API. A v3 schema is not assignable to the v4 `ZodType`, so this module builds
 * the same `AutoParseableOutputFormat` shape directly: a `json_schema` format
 * plus a `parse(content)` that runs the contract schema. The behaviour —
 * `parsed_output` typed and validated, null on a parse failure — is identical;
 * only the construction differs. Should contracts move to zod 4, replace
 * `outputFormatFor` with `zodOutputFormat` and delete this note.
 *
 * What that hand-rolling must not skip is the schema *transformation*.
 * `zodOutputFormat` does not send raw JSON Schema: it runs it through
 * `transformJSONSchema` first, because the structured-output endpoint accepts
 * only a narrow keyword set. The contracts schemas are full of the keywords it
 * refuses (`minLength`, `maximum`, `pattern`, `maxItems`, `const`, `$schema`),
 * so sending them raw earns an `invalid_request_error` on *every* call and
 * quietly degrades every role to its deterministic fallback. That
 * transformation is replicated in `structuredOutputSchemaFor`.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { z } from 'zod';
import { structuredOutputSchemaFor } from './schemaText';
import {
  type LlmCompletion,
  type LlmCompletionRequest,
  type LlmTransport,
  type LlmTokenUsage,
  nowMs,
  taggedIssue,
  validationFailed,
  validationOk,
  zodIssueSummary,
} from './types';

/** Minimal client surface this transport needs. Lets a test inject a stub. */
export interface AnthropicMessagesClient {
  readonly messages: {
    parse(params: never, options?: never): Promise<unknown>;
  };
}

export interface ApiTransportConfig {
  /** Metered API key. Defaults to `env.ANTHROPIC_API_KEY`. */
  readonly apiKey?: string;
  /** Model id, exactly as sent. Defaults to `env.ANTHROPIC_MODEL`, then `'claude-sonnet-5'`. */
  readonly model?: string;
  /** Output ceiling. Defaults to 16000, which comfortably fits a full GM proposal batch. */
  readonly maxTokens?: number;
  /** Pre-built client, for tests. */
  readonly client?: Anthropic;
  /** Environment to read defaults from. Defaults to `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export const DEFAULT_API_MODEL = 'claude-sonnet-5';
export const DEFAULT_API_MAX_TOKENS = 16000;

function ambientEnv(): Readonly<Record<string, string | undefined>> {
  const holder = globalThis as { process?: { env?: Record<string, string | undefined> } };
  return holder.process?.env ?? {};
}

/**
 * The `AutoParseableOutputFormat<T>` shape, built from a zod 3 schema.
 * Structural, so `messages.parse` still infers `parsed_output: T | null`.
 *
 * The schema goes through the same narrowing `zodOutputFormat` applies, so what
 * reaches `output_config.format` carries only keywords the endpoint accepts.
 */
export function outputFormatFor<T>(schema: z.ZodType<T>): {
  type: 'json_schema';
  schema: { [key: string]: unknown };
  parse: (content: string) => T;
} {
  return {
    type: 'json_schema',
    schema: structuredOutputSchemaFor(schema),
    parse: (content: string): T => schema.parse(JSON.parse(content)),
  };
}

function readTokens(usage: unknown): LlmTokenUsage | null {
  if (usage === null || typeof usage !== 'object') return null;
  const record = usage as Record<string, unknown>;
  const input = record['input_tokens'];
  const output = record['output_tokens'];
  if (typeof input !== 'number' || typeof output !== 'number') return null;
  return { input, output };
}

function rawTextOf(content: unknown): string {
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (block !== null && typeof block === 'object') {
      const record = block as Record<string, unknown>;
      if (record['type'] === 'text' && typeof record['text'] === 'string') parts.push(record['text']);
    }
  }
  return parts.join('\n');
}

function describe(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

export function createApiTransport(config: ApiTransportConfig = {}): LlmTransport {
  const env = config.env ?? ambientEnv();
  const model = config.model ?? env['ANTHROPIC_MODEL'] ?? DEFAULT_API_MODEL;
  const maxTokens = config.maxTokens ?? DEFAULT_API_MAX_TOKENS;
  const apiKey = config.apiKey ?? env['ANTHROPIC_API_KEY'];
  let client: Anthropic | null = config.client ?? null;

  return {
    kind: 'api',
    async complete<T>(req: LlmCompletionRequest<T>): Promise<LlmCompletion<T>> {
      const started = nowMs();
      const finish = (partial: Omit<LlmCompletion<T>, 'latencyMs'>): LlmCompletion<T> => ({ ...partial, latencyMs: nowMs() - started });
      const fail = (reason: Parameters<typeof taggedIssue>[0], detail: string, raw = ''): LlmCompletion<T> =>
        finish({
          output: null,
          raw,
          validation: validationFailed(req.schemaName, [taggedIssue(reason, detail)]),
          modelId: model,
          tokens: null,
          claudeSessionId: null,
        });

      try {
        if (client === null) client = new Anthropic(apiKey === undefined ? {} : { apiKey });

        const response = await client.messages.parse({
          model,
          max_tokens: maxTokens,
          system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
          messages: [{ role: 'user', content: req.prompt }],
          output_config: { format: outputFormatFor(req.schema) },
        });

        const raw = rawTextOf(response.content);
        const tokens = readTokens(response.usage);
        const parsed = response.parsed_output;

        if (parsed === null || parsed === undefined) {
          return finish({
            output: null,
            raw,
            validation: validationFailed(req.schemaName, [taggedIssue('invalid_output', 'the model returned no parseable structured output')]),
            modelId: response.model ?? model,
            tokens,
            claudeSessionId: null,
          });
        }

        // parsed_output already ran the contract schema; re-checking is cheap
        // and keeps the "output is schema-valid or null" invariant local.
        const recheck = req.schema.safeParse(parsed);
        if (!recheck.success) {
          return finish({
            output: null,
            raw,
            validation: validationFailed(req.schemaName, zodIssueSummary(recheck.error).map((line) => taggedIssue('invalid_output', line))),
            modelId: response.model ?? model,
            tokens,
            claudeSessionId: null,
          });
        }

        return finish({
          output: recheck.data,
          raw,
          validation: validationOk(req.schemaName, false),
          modelId: response.model ?? model,
          tokens,
          claudeSessionId: null,
        });
      } catch (error) {
        // Most specific first. Never string-match a provider message.
        if (error instanceof Anthropic.RateLimitError) return fail('rate_limited', describe(error));
        if (error instanceof Anthropic.AuthenticationError) return fail('disabled', describe(error));
        if (error instanceof Anthropic.PermissionDeniedError) return fail('disabled', describe(error));
        // A 400 is this side's fault — a malformed request or a schema the
        // endpoint will not take — never the model answering badly. Recording
        // it as `invalid_output` would blame the model for a configuration bug.
        if (error instanceof Anthropic.BadRequestError) return fail('api_error', describe(error));
        if (error instanceof Anthropic.APIConnectionTimeoutError) return fail('timeout', describe(error));
        if (error instanceof Anthropic.APIConnectionError) return fail('api_error', describe(error));
        if (error instanceof Anthropic.APIError) return fail('api_error', describe(error));
        return fail('api_error', describe(error));
      }
    },
  };
}
