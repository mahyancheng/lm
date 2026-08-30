/**
 * @frontier/llm — transport/types.ts
 *
 * The one interface every Claude transport implements.
 *
 * A transport knows how to turn `{ system, prompt, schema }` into a validated
 * object of that schema's type. It knows nothing about the game: no roles, no
 * fallbacks, no run records. That separation is what lets the default
 * `claude-session` transport (Claude Code sessions over subscription OAuth),
 * the `api` transport (metered Anthropic API) and the `none` transport (no
 * model at all) be swapped without touching a single prompt.
 *
 * Two rules hold across every implementation:
 *
 * 1. **A transport never throws.** A network failure, an auth failure, a rate
 *    limit or two consecutive schema violations all come back as an
 *    `LlmCompletion` with `output: null` and a failed `LlmValidationResult`.
 *    The resolver must never die because a model was unavailable.
 * 2. **`output` is either schema-valid or null.** There is no third state.
 *    Unvalidated model text can never reach the engine.
 *
 * `Date.now()` is permitted in this package, and only here: `latencyMs` is a
 * diagnostic recorded on `AgentRunRecord` and is never an input to the
 * simulation. Everything downstream of the gateway is clock-free.
 */

import type { z } from 'zod';
import type { AgentRole, LlmFallbackRecord, LlmValidationResult } from '@frontier/contracts';

/* -------------------------------------------------------------------------- */
/*  Failure taxonomy                                                           */
/* -------------------------------------------------------------------------- */

/** Why a deterministic fallback ran. Mirrors `LlmFallbackRecordSchema.reason`. */
export type LlmFailureReason = LlmFallbackRecord['reason'];

/** Every failure reason, in the order `classifyIssues` scans for them. */
export const LLM_FAILURE_REASONS: readonly LlmFailureReason[] = ['timeout', 'rate_limited', 'invalid_output', 'api_error', 'disabled'];

/**
 * Issues are written as `"<reason>: <detail>"` so the role layer can pick the
 * right `LlmFallbackRecord.reason` without string-matching provider messages.
 */
export function taggedIssue(reason: LlmFailureReason, detail: string): string {
  return `${reason}: ${detail}`;
}

/** Read the failure reason back off a tagged issue list. Defaults to `invalid_output`. */
export function classifyIssues(issues: readonly string[]): LlmFailureReason {
  for (const issue of issues) {
    for (const reason of LLM_FAILURE_REASONS) {
      if (issue.startsWith(`${reason}:`)) return reason;
    }
  }
  return 'invalid_output';
}

/** The `none` transport marks every completion with this, so "no model ran" is distinguishable from "the model was wrong". */
export const LLM_SKIPPED_ISSUE = taggedIssue('disabled', 'skipped — no transport is configured (LLM_TRANSPORT=none)');

/** True when no model was consulted at all, as opposed to consulted and rejected. */
export function isSkipped(validation: LlmValidationResult): boolean {
  return validation.issues.includes(LLM_SKIPPED_ISSUE);
}

/* -------------------------------------------------------------------------- */
/*  Requests and completions                                                   */
/* -------------------------------------------------------------------------- */

export interface LlmCompletionRequest<T> {
  /** Which in-game role is calling. Diagnostics and per-role transport policy only. */
  readonly role: AgentRole;
  /** The role system prompt. The transport appends its own JSON protocol block. */
  readonly system: string;
  /** The composed dossier for this one call. */
  readonly prompt: string;
  /** The schema the reply must satisfy. Unvalidated output never escapes the transport. */
  readonly schema: z.ZodType<T>;
  /** Schema name recorded on `LlmValidationResult.schemaName`, e.g. `"GmProposalBatchSchema"`. */
  readonly schemaName: string;
  /**
   * Conversation key for a persistent session, or null for a fresh one.
   *
   * Strategic calls (World Director, NPC strategist, innovation, social,
   * narrator) always pass null: their context is rebuilt from canonical state
   * every quarter, which is what enforces the information boundary. Dialogue
   * calls (Chief of Staff, character conversations) pass a stable key so the
   * Agent SDK can `resume` the same Claude Code session.
   */
  readonly sessionKey: string | null;
}

export interface LlmTokenUsage {
  readonly input: number;
  readonly output: number;
}

export interface LlmCompletion<T> {
  /** The validated output, or null when nothing schema-valid came back. */
  readonly output: T | null;
  /** Raw model text, kept verbatim for the `agent_runs` audit trail. */
  readonly raw: string;
  readonly validation: LlmValidationResult;
  /** Model identifier exactly as it was sent to (or reported by) the provider. */
  readonly modelId: string;
  /** Round-trip latency. Diagnostics only; never an input to the simulation. */
  readonly latencyMs: number;
  /** Token usage when the provider reported it, else null. */
  readonly tokens: LlmTokenUsage | null;
  /** Claude Code session id for a resumable conversation, or null. */
  readonly claudeSessionId: string | null;
}

export type LlmTransportKind = 'claude-session' | 'api' | 'none';

export interface LlmTransport {
  /** Which transport this is, for run records and for `createGateway` diagnostics. */
  readonly kind: LlmTransportKind;
  complete<T>(req: LlmCompletionRequest<T>): Promise<LlmCompletion<T>>;
}

/* -------------------------------------------------------------------------- */
/*  Validation helpers                                                         */
/* -------------------------------------------------------------------------- */

/** One human-readable line per zod issue: `"path.to.field: message"`. */
export function zodIssueSummary(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
    return `${path}: ${issue.message}`;
  });
}

export function validationOk(schemaName: string, repaired: boolean, priorIssues: readonly string[] = []): LlmValidationResult {
  return { ok: true, schemaName, issues: [...priorIssues], repaired };
}

export function validationFailed(schemaName: string, issues: readonly string[], repaired = false): LlmValidationResult {
  return { ok: false, schemaName, issues: [...issues], repaired };
}

/** Parse `text` against `schema`, returning either the value or tagged issues. */
export function parseAgainst<T>(schema: z.ZodType<T>, value: unknown): { ok: true; value: T } | { ok: false; issues: string[] } {
  const result = schema.safeParse(value);
  if (result.success) return { ok: true, value: result.data };
  return { ok: false, issues: zodIssueSummary(result.error).map((line) => taggedIssue('invalid_output', line)) };
}

/** Wall-clock reading used only for `latencyMs`. Isolated here so the rule is auditable. */
export function nowMs(): number {
  return Date.now();
}
