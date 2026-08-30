/**
 * Shared plumbing for the LLM route handlers.
 *
 * **Server only.** `@frontier/llm` reaches the Claude Agent SDK, which must
 * never enter a client bundle. Every module in `app/api/llm` runs on the Node
 * runtime and is uncached.
 *
 * The contract every route keeps: a 200 with `{ output: null, fallback: true }`
 * whenever no model is configured, the model refuses, or anything throws. The
 * client always has a deterministic path, and `failure_mode` is an engine
 * invariant, not an aspiration.
 */

import { NextResponse } from 'next/server';
import type { z, ZodTypeAny } from 'zod';
import {
  DEFAULT_API_MODEL,
  DEFAULT_CLAUDE_SESSION_MODEL,
  createGateway,
  resolveTransportKind,
  type LlmGateway,
  type LlmTransportKind,
} from '@frontier/llm';

/** Every LLM route runs on Node and is never cached. */
export const LLM_ROUTE_RUNTIME = 'nodejs';

let cached: LlmGateway | null = null;

/** The process-wide gateway, built from `process.env`. */
export function gateway(): LlmGateway {
  if (cached === null) cached = createGateway(process.env);
  return cached;
}

/** The transport configured for this deployment. */
export function transportKind(): LlmTransportKind {
  return resolveTransportKind(process.env.LLM_TRANSPORT);
}

/** The model each role will run on, or null when there is no transport. */
export function modelName(): string | null {
  const kind = transportKind();
  if (kind === 'none') return null;
  if (kind === 'api') return process.env.ANTHROPIC_MODEL ?? DEFAULT_API_MODEL;
  return process.env.LLM_MODEL ?? DEFAULT_CLAUDE_SESSION_MODEL;
}

function hasValue(value: string | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * True when a role call has any chance of reaching a model.
 *
 * Deliberately stricter than "the transport is not `none`". With no
 * environment at all, `LLM_TRANSPORT` resolves to `claude-session` by
 * default — but nothing is credentialed, so every call would burn its timeout
 * before falling back. A zero-variable deployment must answer *offline*
 * immediately, because that is the configuration demo mode runs on.
 *
 * A machine already logged into Claude Code has no token in the environment;
 * setting `LLM_TRANSPORT=claude-session` explicitly is how such an operator
 * opts in.
 */
export function transportAvailable(): boolean {
  const kind = transportKind();
  if (kind === 'none') return false;
  if (kind === 'api') return hasValue(process.env.ANTHROPIC_API_KEY);
  return hasValue(process.env.CLAUDE_CODE_OAUTH_TOKEN) || hasValue(process.env.LLM_TRANSPORT);
}

export interface RolePayload<T> {
  readonly output: T | null;
  readonly fallback: boolean;
  readonly reason?: string;
}

const NO_STORE = {
  'cache-control': 'no-store, no-cache, must-revalidate',
} as const;

/** A successful role response. */
export function ok<T>(output: T | null, fallback: boolean, reason?: string): NextResponse {
  const body: RolePayload<T> = reason === undefined ? { output, fallback } : { output, fallback, reason };
  return NextResponse.json(body, { headers: NO_STORE });
}

/** The graceful null response every failure path returns. Always HTTP 200. */
export function fallback(reason: string): NextResponse {
  return ok(null, true, reason);
}

/**
 * Parse a request body against a schema.
 *
 * A malformed body is the one case that is genuinely the caller's fault, so it
 * answers 400 rather than pretending a model was consulted.
 */
export async function parseBody<S extends ZodTypeAny>(
  request: Request,
  schema: S,
): Promise<{ ok: true; value: z.infer<S> } | { ok: false; response: NextResponse }> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return {
      ok: false,
      response: NextResponse.json({ output: null, fallback: true, reason: 'invalid_json' }, { status: 400, headers: NO_STORE }),
    };
  }

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      response: NextResponse.json(
        {
          output: null,
          fallback: true,
          reason: 'invalid_body',
          issues: parsed.error.issues.slice(0, 8).map((issue) => `${issue.path.join('.')}: ${issue.message}`),
        },
        { status: 400, headers: NO_STORE },
      ),
    };
  }

  return { ok: true, value: parsed.data };
}

/**
 * Run one role call, converting every failure into the null response.
 *
 * `fallbackUsed` from the role is surfaced so a client can tell the difference
 * between "the model answered" and "the deterministic fallback answered" —
 * without ever having to handle an error.
 */
export async function runRole<T>(
  call: () => Promise<{ output: T | null; fallbackUsed: boolean }>,
): Promise<NextResponse> {
  if (!transportAvailable()) return fallback('transport_none');
  try {
    const result = await call();
    return ok(result.output, result.fallbackUsed);
  } catch (error) {
    return fallback(error instanceof Error ? `role_error: ${error.message.slice(0, 160)}` : 'role_error');
  }
}
