/**
 * @frontier/llm
 *
 * The Claude gateway. Every in-game LLM role runs through here, and nothing
 * here writes state of any kind.
 *
 * > LLMs are allowed to think, propose, negotiate, communicate and reinterpret
 * > the future; only the simulation engine is allowed to make reality.
 *
 * ## Shape
 *
 * | Layer | Responsibility |
 * |---|---|
 * | `compose/*` | Build `{ system, prompt }` from a pre-redacted input. **The information boundary.** |
 * | `transport/*` | Turn a prompt pair plus a schema into a validated object, or null. Never throws. |
 * | `fallbacks` | Deterministic behaviour when a model is unavailable or wrong twice. Pure, no RNG, no clock. |
 * | `roles` | Compose → call → fall back → post-process → log an `AgentRunRecord`. |
 * | `sessionStore` | The conversation → Claude-session mapping that gives dialogue multi-turn memory. |
 *
 * ## Transports
 *
 * | `LLM_TRANSPORT` | Mechanism | Auth | Model |
 * |---|---|---|---|
 * | `claude-session` *(default)* | Claude Code sessions via the Claude Agent SDK | `CLAUDE_CODE_OAUTH_TOKEN` | `sonnet` |
 * | `api` | `@anthropic-ai/sdk` `messages.parse` | `ANTHROPIC_API_KEY` | `claude-sonnet-5` |
 * | `none` | No model at all | — | — |
 *
 * The default path is deliberately not metered API billing: it drives Claude
 * Code sessions with the operator's subscription OAuth token, generated with
 * `claude setup-token`. `none` yields the rule-based fallbacks for every role
 * and is what demo mode runs on, which is why demo mode needs no credentials.
 */

/* ------------------------------- transports ------------------------------- */

export type {
  LlmCompletion,
  LlmCompletionRequest,
  LlmFailureReason,
  LlmTokenUsage,
  LlmTransport,
  LlmTransportKind,
} from './transport/types';
export {
  LLM_FAILURE_REASONS,
  LLM_SKIPPED_ISSUE,
  classifyIssues,
  isSkipped,
  parseAgainst,
  taggedIssue,
  validationFailed,
  validationOk,
  zodIssueSummary,
} from './transport/types';

export type { JsonCandidateFilter, JsonExtraction } from './transport/json';
export { balancedObjects, extractJsonObject, firstBalancedObject, stripCodeFence } from './transport/json';

export { jsonSchemaObjectFor, jsonSchemaTextFor, structuredOutputSchemaFor, transformJsonSchema } from './transport/schemaText';

export type { ClaudeQueryFn, ClaudeSessionTransportConfig } from './transport/claudeSession';
export {
  ASSISTANT_ERROR_REASONS,
  DEFAULT_CLAUDE_SESSION_MODEL,
  DISALLOWED_TOOLS,
  JSON_PROTOCOL_INSTRUCTION,
  RATE_LIMIT_RETRY_DELAY_MS,
  TOOL_DENIED_MESSAGE,
  buildQueryOptions,
  buildRepairPrompt,
  buildSystemPrompt,
  classifyAssistantError,
  collectAttempt,
  createClaudeSessionTransport,
  denyEveryTool,
} from './transport/claudeSession';

export type { ApiTransportConfig } from './transport/api';
export { DEFAULT_API_MAX_TOKENS, DEFAULT_API_MODEL, createApiTransport, outputFormatFor } from './transport/api';

export type { NullTransportConfig } from './transport/none';
export { createNullTransport } from './transport/none';

export type { ConcurrencyLimiter } from './transport/limited';
export {
  DEFAULT_LLM_MAX_CONCURRENCY,
  MAX_CONCURRENCY_ENV,
  createConcurrencyLimiter,
  resolveMaxConcurrency,
  withConcurrencyLimit,
} from './transport/limited';

/* ------------------------------ session store ----------------------------- */

export type { InMemoryLlmMemoryStore, InMemoryLlmSessionStore, LlmMemoryStore, LlmSessionStore } from './sessionStore';
export { createInMemoryMemoryStore, createInMemorySessionStore, createNullMemoryStore, createNullSessionStore } from './sessionStore';

/* -------------------------------- composers ------------------------------- */

export type { ComposedPrompt, ContextComposer } from './compose/render';
export { AUTHORITY_PREAMBLE, OUTPUT_DISCIPLINE, bullets, joinBlocks, lastN, num, numbered, pct, section, signed, truncate, usd } from './compose/render';

export type { SecretBearingRecord } from './compose/redaction';
export { INTERNAL_STATE_MARKERS, LlmContextLeakError, assertNoForeignSecretResearch, assertNoInternalMarkers, assertOwnedBy } from './compose/redaction';

export { WORLD_DIRECTOR_SYSTEM, composeWorldDirector } from './compose/worldDirector';
export {
  CHIEF_OF_STAFF_SYSTEM,
  composeChiefOfStaff,
  enforceConfirmationPolicy,
  enforceInterpretationPolicy,
  enforceModePolicy,
  renderAvailableAction,
  renderDossier,
} from './compose/chiefOfStaff';
export {
  COS_QUESTION_KINDS,
  answerFromDossier,
  bestProduct,
  classifyQuestion,
  offlineChiefOfStaff,
  worstProduct,
  type CosQuestionKind,
} from './chiefOfStaffOffline';
export { forgetBefore, readMemory, rememberExchange, standingPreferenceOf, type ExchangeToRemember } from './chiefOfStaffMemory';
export type { NpcPastDecision, NpcStrategistEvidence, RivalSignal } from './compose/npcStrategist';
export { EMPTY_NPC_EVIDENCE, NPC_DECISION_HISTORY_QUARTERS, NPC_STRATEGIST_SYSTEM, composeNpcStrategist } from './compose/npcStrategist';
export { DIALOGUE_HISTORY_TURNS, DIALOGUE_MEMORY_LIMIT, composeCharacterDialogue, composeCharacterPersona } from './compose/characterDialogue';
export { INNOVATION_INTERPRETER_SYSTEM, composeInnovationInterpreter } from './compose/innovationInterpreter';
export { SOCIAL_AUTHOR_SYSTEM, composeSocialAuthor } from './compose/socialAuthor';
export { NARRATOR_SYSTEM, composeNarrator, groupLinesByPhase } from './compose/narrator';

/* -------------------------------- fallbacks ------------------------------- */

export type { DialogueRegister } from './fallbacks';
export { INNOVATION_DECLINE_REASON, dialogueRegister, fallbackCharacterReply, fallbackChiefOfStaff, fallbackNarratorOutput, narratorTone } from './fallbacks';

export { EMPTY_SETUP_PROPOSAL, SETUP_HISTORY_TURNS, SETUP_INTERPRETER_SCHEMA_NAME, SETUP_INTERPRETER_SYSTEM, SETUP_TURN_MAX_CHARS, composeSetupInterpreter, interpretSetup, normaliseSetupProposal, type SetupConversationTurn, type SetupInterpretation, type SetupInterpreterInput } from './setupInterpreter';

/* --------------------------------- roles ---------------------------------- */

export type { LlmRoles, LlmRolesOptions, RoleCallMeta, RoleResult } from './roles';
export { AGENT_VERSION, contextHashFor, createLlmRoles } from './roles';

export type { MemoryRunSink, RunSink } from './runSink';
export { createMemoryRunSink, createNullRunSink, safeRunSink } from './runSink';

/* ---------------------------- subscription oauth -------------------------- */

export type {
  ClaudeOAuthExchangeError,
  ClaudeOAuthExchangeResult,
  ClaudePkcePair,
  ExchangeInput,
  FetchLike,
  RandomBytes,
} from './oauth';
export {
  CLAUDE_OAUTH_CONFIG,
  base64Url,
  buildClaudeAuthorizeUrl,
  createOAuthState,
  createPkcePair,
  exchangeClaudeOAuthCode,
} from './oauth';

/* -------------------------------------------------------------------------- */
/*  Gateway                                                                    */
/* -------------------------------------------------------------------------- */

import type Anthropic from '@anthropic-ai/sdk';
import { type LlmRoles, type LlmRolesOptions, createLlmRoles } from './roles';
import { type LlmSessionStore, createInMemorySessionStore } from './sessionStore';
import { type ClaudeQueryFn, createClaudeSessionTransport } from './transport/claudeSession';
import { createApiTransport } from './transport/api';
import { createNullTransport } from './transport/none';
import { type ConcurrencyLimiter, resolveMaxConcurrency, withConcurrencyLimit } from './transport/limited';
import type { LlmTransport, LlmTransportKind } from './transport/types';
import type { RunSink } from './runSink';

/** The environment variables the gateway reads. A plain object, so a caller can supply a redacted view of `process.env`. */
export interface GatewayEnv {
  readonly [key: string]: string | undefined;
  readonly LLM_TRANSPORT?: string | undefined;
  readonly LLM_MODEL?: string | undefined;
  readonly CLAUDE_CODE_OAUTH_TOKEN?: string | undefined;
  readonly ANTHROPIC_API_KEY?: string | undefined;
  readonly ANTHROPIC_MODEL?: string | undefined;
  /** How many model calls may be in flight at once. Whole number ≥ 1; anything else means 1. */
  readonly LLM_MAX_CONCURRENCY?: string | undefined;
}

export interface GatewayOptions {
  /** Where dialogue conversations remember their Claude session id. Defaults to an in-memory store. */
  readonly sessionStore?: LlmSessionStore;
  /** Where `AgentRunRecord`s go. Defaults to dropping them. */
  readonly runSink?: RunSink;
  /** Options for the pre-built `roles` accessor. Also the defaults for `createRoles`. */
  readonly roles?: LlmRolesOptions;
  /** Injected Agent SDK `query()`, for tests. */
  readonly queryFn?: ClaudeQueryFn;
  /** Injected Anthropic client for the `api` transport, for tests. */
  readonly anthropicClient?: Anthropic;
  /**
   * A concurrency bound to share rather than build.
   *
   * Supply one when the gateway itself is rebuilt during a process's life — the
   * web app rebuilds it whenever the pasted credential changes — so that the
   * calls already in flight and the calls made after the rebuild are counted
   * against the *same* ceiling. A per-gateway limiter would let a rebuild
   * double the number of live Claude Code subprocesses, which is precisely the
   * failure the bound exists to prevent.
   */
  readonly concurrencyLimiter?: ConcurrencyLimiter;
}

export interface LlmGateway {
  readonly transport: LlmTransport;
  readonly transportKind: LlmTransportKind;
  readonly sessionStore: LlmSessionStore;
  /** How many model calls this gateway allows in flight at once. */
  readonly maxConcurrency: number;
  /** Roles bound to `options.roles`, or to a placeholder session when none was supplied. */
  readonly roles: LlmRoles;
  /** Bind a fresh set of roles to a specific session. */
  createRoles(rolesOptions: LlmRolesOptions): LlmRoles;
}

/** Resolve `LLM_TRANSPORT` to a transport kind. Anything unrecognised is the default. */
export function resolveTransportKind(value: string | undefined): LlmTransportKind {
  const normalised = (value ?? '').trim().toLowerCase();
  if (normalised === 'none' || normalised === 'off' || normalised === 'disabled') return 'none';
  if (normalised === 'api') return 'api';
  return 'claude-session';
}

/**
 * Build the gateway from environment configuration.
 *
 * `claude-session` is the default and the only path that works with no API
 * key. `none` is a first-class configuration, not a degraded one: it produces
 * the deterministic fallback for every role, which is exactly what demo mode
 * wants and what every test in this package uses.
 *
 * Whichever model-bearing transport is chosen is then wrapped in the
 * `LLM_MAX_CONCURRENCY` bound (see `transport/limited.ts`). The bound belongs
 * here rather than at any call site: a quarter fans out over every rival
 * strategist, each `claude-session` call spawns a subprocess, and a limit that
 * one caller can forget to apply is not a limit. `none` is left unwrapped —
 * there is no subprocess to bound, and a queue in front of a function that
 * returns immediately is only latency.
 */
export function createGateway(env: GatewayEnv = {}, options: GatewayOptions = {}): LlmGateway {
  const kind = resolveTransportKind(env.LLM_TRANSPORT);
  const sessionStore = options.sessionStore ?? createInMemorySessionStore();
  const limiter = options.concurrencyLimiter;
  const maxConcurrency = limiter?.max ?? resolveMaxConcurrency(env.LLM_MAX_CONCURRENCY);

  let transport: LlmTransport;
  if (kind === 'none') {
    transport = createNullTransport();
  } else if (kind === 'api') {
    transport = withConcurrencyLimit(
      createApiTransport({
        model: env.ANTHROPIC_MODEL,
        apiKey: env.ANTHROPIC_API_KEY,
        client: options.anthropicClient,
        env,
      }),
      limiter ?? maxConcurrency,
    );
  } else {
    transport = withConcurrencyLimit(
      createClaudeSessionTransport({
        model: env.LLM_MODEL,
        oauthToken: env.CLAUDE_CODE_OAUTH_TOKEN,
        sessionStore,
        queryFn: options.queryFn,
        env,
      }),
      limiter ?? maxConcurrency,
    );
  }

  const defaults: LlmRolesOptions = options.roles ?? { sessionId: 'unbound-session', quarter: 0 };
  const rolesOptions: LlmRolesOptions = { ...defaults, runSink: defaults.runSink ?? options.runSink };

  return {
    transport,
    transportKind: kind,
    sessionStore,
    maxConcurrency,
    roles: createLlmRoles(transport, rolesOptions),
    createRoles(next: LlmRolesOptions): LlmRoles {
      return createLlmRoles(transport, { ...next, runSink: next.runSink ?? options.runSink });
    },
  };
}

/** Version of this gateway surface. */
export const LLM_GATEWAY_VERSION = '1.0.0';
