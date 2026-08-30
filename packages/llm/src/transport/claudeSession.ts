/**
 * @frontier/llm — transport/claudeSession.ts
 *
 * **The default transport.** Every in-game role runs on Sonnet through a
 * Claude Code session driven by `@anthropic-ai/claude-agent-sdk`'s `query()`,
 * authenticated with the operator's subscription OAuth token
 * (`CLAUDE_CODE_OAUTH_TOKEN`, generated with `claude setup-token`). This path
 * never requires an `ANTHROPIC_API_KEY`.
 *
 * The session is locked down to be a pure text-in/JSON-out function:
 *
 * - `tools: []` — the base set of built-in tools is empty, so nothing is
 *   offered to the model in the first place. This is the option that actually
 *   restricts availability: `allowedTools` only names what may run *without a
 *   permission prompt*, which is a different question. `disallowedTools` names
 *   the built-ins explicitly as belt-and-braces, and `canUseTool` denies every
 *   request that reaches it, so no tool executes even if a future SDK offers
 *   one this list has never heard of. A World Director that could read the
 *   filesystem would be a security bug and an information-boundary bug at the
 *   same time.
 * - `permissionMode: 'dontAsk'` — nothing may be approved interactively; a
 *   server-side resolver has nobody to ask.
 * - `settingSources: []` — no user, project or local settings are loaded, so
 *   this repository's `CLAUDE.md`, skills and hooks never leak into an in-game
 *   role's context. A director in a boardroom must not know it lives in a
 *   monorepo.
 * - `maxTurns: 1` — one turn, one answer. There is no tool loop to run.
 *
 * ## JSON protocol
 *
 * Claude Code sessions are conversational, so the schema contract is carried in
 * the system prompt: the role prompt, then the JSON Schema of the expected
 * reply, then an instruction to answer with that object and nothing else. The
 * reply is de-fenced, brace-balanced and zod-parsed. A failure is retried
 * **once** with the zod error summary appended, resuming the first attempt's
 * session so the model can see what it wrote. A success on that retry is
 * recorded as `repaired: true` — a repaired run is not the same as a clean one.
 *
 * ## Failure taxonomy
 *
 * The SDK reports transport-level failures as a typed `SDKAssistantMessageError`
 * enum, and those are mapped one-for-one onto `LlmFallbackRecord.reason`
 * (`ASSISTANT_ERROR_REASONS`) rather than flattened to `api_error`. The reason
 * then steers the retry, because retrying is not always the kind thing to do:
 * a `disabled` failure (no token, org not allowed, billing) cannot be repaired
 * by asking again, so the repair is skipped entirely; a `rate_limited` failure
 * waits `RATE_LIMIT_RETRY_DELAY_MS` before its single retry rather than firing
 * a second call straight into the limit that just rejected the first.
 *
 * ## Session continuity
 *
 * When `sessionKey` is non-null the transport looks the Claude session id up in
 * the `LlmSessionStore`, passes it as `resume`, and writes back whatever id the
 * SDK reports afterwards (a resume can fork). When it is null the call opens a
 * fresh session and nothing is stored — that is how strategic calls stay
 * boundary-safe.
 */

import type { CanUseTool, Options, PermissionResult, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { LlmSessionStore } from '../sessionStore';
import { extractJsonObject } from './json';
import {
  type LlmCompletion,
  type LlmCompletionRequest,
  type LlmFailureReason,
  type LlmTransport,
  type LlmTokenUsage,
  classifyIssues,
  nowMs,
  parseAgainst,
  taggedIssue,
  validationFailed,
  validationOk,
} from './types';
import { jsonSchemaTextFor } from './schemaText';

/* -------------------------------------------------------------------------- */
/*  Configuration                                                              */
/* -------------------------------------------------------------------------- */

/** The shape of the Agent SDK's `query()`, narrowed to what this transport uses. */
export type ClaudeQueryFn = (params: { prompt: string; options?: Options }) => AsyncIterable<SDKMessage>;

export interface ClaudeSessionTransportConfig {
  /** Model id or alias. Defaults to `env.LLM_MODEL`, then `'sonnet'`. */
  readonly model?: string;
  /** Subscription OAuth token, forwarded to the subprocess as `CLAUDE_CODE_OAUTH_TOKEN`. */
  readonly oauthToken?: string;
  /** Where dialogue conversations remember their Claude session id. */
  readonly sessionStore?: LlmSessionStore;
  /** Injected `query()`, for tests. Defaults to a lazy import of the Agent SDK. */
  readonly queryFn?: ClaudeQueryFn;
  /** Environment to read `LLM_MODEL` / `CLAUDE_CODE_OAUTH_TOKEN` from. Defaults to `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Working directory for the session. Irrelevant with no tools, but pinned when supplied. */
  readonly cwd?: string;
  /** Retry an invalid reply once with the error summary. Default true. */
  readonly repairOnce?: boolean;
  /** How the rate-limit backoff waits. Injected by tests so no test ever sleeps. */
  readonly sleep?: (ms: number) => Promise<void>;
}

export const DEFAULT_CLAUDE_SESSION_MODEL = 'sonnet';

/**
 * How long to wait before the single retry of a rate-limited call. Bounded and
 * fixed: one short pause, never a growing storm of attempts.
 */
export const RATE_LIMIT_RETRY_DELAY_MS = 2_000;

/**
 * Built-in tools named as denied. Redundant with `tools: []`, which already
 * empties the base set — kept so a session is refused these by name even if a
 * future SDK default reintroduces one.
 */
export const DISALLOWED_TOOLS: readonly string[] = [
  'Bash',
  'Read',
  'Write',
  'Edit',
  'NotebookEdit',
  'Glob',
  'Grep',
  'WebFetch',
  'WebSearch',
  'Task',
  'TodoWrite',
  'Skill',
  'SlashCommand',
  'KillShell',
  'BashOutput',
];

export const JSON_PROTOCOL_INSTRUCTION = 'Respond with ONLY a JSON object matching this JSON Schema (no prose, no code fences):';

/** The message a denied tool request is answered with. */
export const TOOL_DENIED_MESSAGE = 'This session is a pure text-in/JSON-out role. No tool may run.';

/**
 * The last line of the lockdown: whatever is asked for, the answer is no.
 *
 * `tools: []` already means nothing is offered, so in practice this is never
 * called. It exists so that "no tool executes" is guaranteed by a decision this
 * package makes, not by the contents of a hardcoded name list.
 */
export const denyEveryTool: CanUseTool = async (): Promise<PermissionResult> => ({
  behavior: 'deny',
  message: TOOL_DENIED_MESSAGE,
  interrupt: true,
});

/* -------------------------------------------------------------------------- */
/*  Failure taxonomy                                                           */
/* -------------------------------------------------------------------------- */

/**
 * `SDKAssistantMessageError` (sdk.d.ts) mapped onto the fallback reasons the
 * ledger records. Flattening these to `api_error` would make
 * `LlmFallbackRecord.reason` — the field whose whole job is to say *why* the
 * model was unavailable — useless: an expired OAuth token and a malformed reply
 * would read identically to an operator.
 */
export const ASSISTANT_ERROR_REASONS: Readonly<Record<string, LlmFailureReason>> = {
  authentication_failed: 'disabled',
  oauth_org_not_allowed: 'disabled',
  account_on_hold: 'disabled',
  billing_error: 'disabled',
  rate_limit: 'rate_limited',
  overloaded: 'rate_limited',
  server_error: 'api_error',
  invalid_request: 'api_error',
  model_not_found: 'api_error',
  max_output_tokens: 'invalid_output',
  unknown: 'api_error',
};

/** The reason for one reported assistant error. Anything unrecognised is an API error. */
export function classifyAssistantError(error: string): LlmFailureReason {
  return ASSISTANT_ERROR_REASONS[error] ?? 'api_error';
}

/* -------------------------------------------------------------------------- */
/*  Environment                                                                */
/* -------------------------------------------------------------------------- */

function ambientEnv(): Readonly<Record<string, string | undefined>> {
  const holder = globalThis as { process?: { env?: Record<string, string | undefined> } };
  return holder.process?.env ?? {};
}

/* -------------------------------------------------------------------------- */
/*  Message reading                                                            */
/* -------------------------------------------------------------------------- */

interface AttemptOutcome {
  readonly text: string;
  readonly claudeSessionId: string | null;
  readonly modelId: string | null;
  readonly tokens: LlmTokenUsage | null;
  /** Tagged issues (`"<reason>: <detail>"`), so the cause survives into the ledger. */
  readonly errors: string[];
}

function readTokenUsage(usage: unknown): LlmTokenUsage | null {
  if (usage === null || typeof usage !== 'object') return null;
  const record = usage as Record<string, unknown>;
  const input = record['input_tokens'];
  const output = record['output_tokens'];
  if (typeof input !== 'number' || typeof output !== 'number') return null;
  return { input, output };
}

/** Drain one `query()` stream into the pieces this transport cares about. */
export async function collectAttempt(stream: AsyncIterable<SDKMessage>): Promise<AttemptOutcome> {
  const assistantText: string[] = [];
  const errors: string[] = [];
  let resultText: string | null = null;
  let claudeSessionId: string | null = null;
  let modelId: string | null = null;
  let tokens: LlmTokenUsage | null = null;

  for await (const message of stream) {
    if (message.type === 'system' && message.subtype === 'init') {
      claudeSessionId = message.session_id;
      modelId = message.model;
      continue;
    }
    if (message.type === 'assistant') {
      for (const block of message.message.content) {
        if (block.type === 'text') assistantText.push(block.text);
      }
      if (message.error !== undefined) {
        errors.push(taggedIssue(classifyAssistantError(message.error), `assistant error: ${message.error}`));
      }
      continue;
    }
    if (message.type === 'result') {
      claudeSessionId = message.session_id;
      tokens = readTokenUsage(message.usage) ?? tokens;
      if (message.subtype === 'success') {
        resultText = message.result;
        if (message.is_error) errors.push(taggedIssue('api_error', `result reported an error: ${message.result}`));
      } else {
        errors.push(taggedIssue('api_error', `result ${message.subtype}${message.errors.length > 0 ? `: ${message.errors.join('; ')}` : ''}`));
      }
    }
  }

  const text = resultText !== null && resultText.trim().length > 0 ? resultText : assistantText.join('\n');
  return { text, claudeSessionId, modelId, tokens, errors };
}

/* -------------------------------------------------------------------------- */
/*  Transport                                                                  */
/* -------------------------------------------------------------------------- */

let cachedQuery: ClaudeQueryFn | null = null;

async function resolveQueryFn(config: ClaudeSessionTransportConfig): Promise<ClaudeQueryFn> {
  if (config.queryFn !== undefined) return config.queryFn;
  if (cachedQuery === null) {
    const sdk = await import('@anthropic-ai/claude-agent-sdk');
    cachedQuery = sdk.query;
  }
  return cachedQuery;
}

/**
 * Build the Agent SDK options for one attempt. Exported so a test can assert
 * the lockdown without spawning a session.
 */
export function buildQueryOptions(params: {
  readonly system: string;
  readonly model: string;
  readonly resume: string | null;
  readonly oauthToken: string | undefined;
  readonly cwd: string | undefined;
  readonly env: Readonly<Record<string, string | undefined>>;
}): Options {
  const options: Options = {
    model: params.model,
    systemPrompt: params.system,
    maxTurns: 1,
    // `tools: []` is the option that empties the base set of built-ins; the
    // other three are defence in depth, in decreasing order of trust.
    tools: [],
    allowedTools: [],
    disallowedTools: [...DISALLOWED_TOOLS],
    canUseTool: denyEveryTool,
    permissionMode: 'dontAsk',
    settingSources: [],
  };
  if (params.resume !== null) options.resume = params.resume;
  if (params.cwd !== undefined) options.cwd = params.cwd;
  if (params.oauthToken !== undefined && params.oauthToken.length > 0) {
    options.env = { ...params.env, CLAUDE_CODE_OAUTH_TOKEN: params.oauthToken };
  }
  return options;
}

/** Compose the system prompt: role authority, then the JSON contract. */
export function buildSystemPrompt(roleSystem: string, schemaJson: string): string {
  return `${roleSystem.trim()}\n\n${JSON_PROTOCOL_INSTRUCTION}\n${schemaJson}`;
}

/** Append the zod error summary for the one permitted repair attempt. */
export function buildRepairPrompt(prompt: string, issues: readonly string[]): string {
  const listed = issues.slice(0, 12).map((issue) => `- ${issue}`).join('\n');
  return `${prompt}\n\nYour previous reply did not satisfy the schema:\n${listed}\n\nReturn the corrected object: a single JSON object, no prose and no code fences.`;
}

export function createClaudeSessionTransport(config: ClaudeSessionTransportConfig = {}): LlmTransport {
  const env = config.env ?? ambientEnv();
  const model = config.model ?? env['LLM_MODEL'] ?? DEFAULT_CLAUDE_SESSION_MODEL;
  const oauthToken = config.oauthToken ?? env['CLAUDE_CODE_OAUTH_TOKEN'];
  const store = config.sessionStore;
  const repairOnce = config.repairOnce ?? true;
  const sleep = config.sleep ?? defaultSleep;

  return {
    kind: 'claude-session',
    async complete<T>(req: LlmCompletionRequest<T>): Promise<LlmCompletion<T>> {
      const started = nowMs();
      const finish = (partial: Omit<LlmCompletion<T>, 'latencyMs'>): LlmCompletion<T> => ({ ...partial, latencyMs: nowMs() - started });

      let system: string;
      try {
        system = buildSystemPrompt(req.system, jsonSchemaTextFor(req.schema, req.schemaName));
      } catch (error) {
        return finish({
          output: null,
          raw: '',
          validation: validationFailed(req.schemaName, [taggedIssue('invalid_output', `could not render a JSON Schema for ${req.schemaName}: ${describe(error)}`)]),
          modelId: model,
          tokens: null,
          claudeSessionId: null,
        });
      }

      let queryFn: ClaudeQueryFn;
      try {
        queryFn = await resolveQueryFn(config);
      } catch (error) {
        return finish({
          output: null,
          raw: '',
          validation: validationFailed(req.schemaName, [taggedIssue('api_error', `the Claude Agent SDK could not be loaded: ${describe(error)}`)]),
          modelId: model,
          tokens: null,
          claudeSessionId: null,
        });
      }

      let resume: string | null = null;
      if (req.sessionKey !== null && store !== undefined) {
        try {
          resume = await store.get(req.sessionKey);
        } catch {
          resume = null; // continuity is a nicety; never a failure
        }
      }

      let raw = '';
      let modelId = model;
      let tokens: LlmTokenUsage | null = null;
      let claudeSessionId: string | null = resume;
      let firstIssues: string[] = [];
      let prompt = req.prompt;

      for (let attempt = 0; attempt < (repairOnce ? 2 : 1); attempt += 1) {
        let outcome: AttemptOutcome;
        try {
          const options = buildQueryOptions({ system, model, resume, oauthToken, cwd: config.cwd, env });
          outcome = await collectAttempt(queryFn({ prompt, options }));
        } catch (error) {
          const issues = [taggedIssue(classifyThrown(error), describe(error)), ...firstIssues];
          await remember(store, req.sessionKey, claudeSessionId);
          return finish({ output: null, raw, validation: validationFailed(req.schemaName, issues, attempt > 0), modelId, tokens, claudeSessionId });
        }

        raw = outcome.text;
        modelId = outcome.modelId ?? modelId;
        tokens = outcome.tokens ?? tokens;
        claudeSessionId = outcome.claudeSessionId ?? claudeSessionId;

        // The schema is the arbiter of which balanced object in the reply is
        // the answer, so a thinking aside that happens to contain JSON cannot
        // shadow it.
        const extraction = extractJsonObject(outcome.text, (value) => req.schema.safeParse(value).success);
        const issues: string[] = [...outcome.errors];

        if (!extraction.ok) {
          issues.push(taggedIssue('invalid_output', extraction.reason));
        } else {
          const parsed = parseAgainst(req.schema, extraction.value);
          if (parsed.ok) {
            await remember(store, req.sessionKey, claudeSessionId);
            return finish({
              output: parsed.value,
              raw,
              validation: validationOk(req.schemaName, attempt > 0, firstIssues),
              modelId,
              tokens,
              claudeSessionId,
            });
          }
          issues.push(...parsed.issues);
        }

        if (attempt === 0 && repairOnce) {
          const reason = classifyIssues(issues);
          // A missing token, a suspended account or a billing failure is not
          // something a second call can talk its way out of. Stop here.
          if (reason !== 'disabled') {
            // A rate limit asked for less traffic. Honour it with one bounded
            // pause instead of answering with a second immediate call.
            if (reason === 'rate_limited') await sleep(RATE_LIMIT_RETRY_DELAY_MS);
            firstIssues = issues;
            prompt = buildRepairPrompt(req.prompt, issues);
            // Resume the attempt we just made, so the repair sees its own reply.
            resume = claudeSessionId;
            continue;
          }
        }

        await remember(store, req.sessionKey, claudeSessionId);
        return finish({ output: null, raw, validation: validationFailed(req.schemaName, [...firstIssues, ...issues], false), modelId, tokens, claudeSessionId });
      }

      // Defensive tail: every path through the loop above returns.
      await remember(store, req.sessionKey, claudeSessionId);
      return finish({ output: null, raw, validation: validationFailed(req.schemaName, firstIssues), modelId, tokens, claudeSessionId });
    },
  };
}

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function remember(store: LlmSessionStore | undefined, sessionKey: string | null, claudeSessionId: string | null): Promise<void> {
  if (store === undefined || sessionKey === null || claudeSessionId === null) return;
  try {
    await store.set(sessionKey, claudeSessionId);
  } catch {
    /* continuity is a nicety; never a failure */
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

function classifyThrown(error: unknown): 'timeout' | 'rate_limited' | 'api_error' {
  const text = describe(error).toLowerCase();
  if (text.includes('timeout') || text.includes('timed out') || text.includes('aborted')) return 'timeout';
  if (text.includes('rate limit') || text.includes('rate_limit') || text.includes('429')) return 'rate_limited';
  return 'api_error';
}
