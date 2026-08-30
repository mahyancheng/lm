/**
 * Typed client-side fetchers for the LLM routes.
 *
 * `@frontier/llm` and the Claude Agent SDK are **server-only** and must never
 * enter a client bundle. This module is the whole of the client's knowledge of
 * the model: five POSTs and a health check, each of which resolves to `null`
 * when no transport is configured or when anything at all goes wrong.
 *
 * Every caller must have a deterministic path for `null`. That is not a
 * courtesy: `failure_mode` is an engine invariant.
 */

import type {
  CharacterReply,
  CharacterUtteranceContext,
  ChiefOfStaffInput,
  ChiefOfStaffInterpretation,
  GmProposalBatch,
  NarratorOutput,
  NpcActionBundle,
  NpcStrategistInput,
  ResolutionReport,
  WorldDirectorInput,
} from '@frontier/contracts';

/* -------------------------------------------------------------------------- */
/*  Health                                                                     */
/* -------------------------------------------------------------------------- */

export interface LlmHealth {
  /** True when a transport other than `none` is configured. */
  readonly available: boolean;
  readonly transportKind: 'claude-session' | 'api' | 'none';
  readonly model: string | null;
}

const OFFLINE: LlmHealth = { available: false, transportKind: 'none', model: null };

/** Health checks are memoised for three seconds; a store may poll freely. */
const HEALTH_TTL_MS = 3_000;

let healthCache: { readonly at: number; readonly value: LlmHealth } | null = null;
let healthInFlight: Promise<LlmHealth> | null = null;

/**
 * Is a live model available?
 *
 * `Date.now` here is a UI-only concern (cache expiry) and never reaches the
 * simulation.
 */
export async function llmHealth(force = false): Promise<LlmHealth> {
  if (typeof window === 'undefined') return OFFLINE;
  const now = Date.now();
  if (!force && healthCache !== null && now - healthCache.at < HEALTH_TTL_MS) return healthCache.value;
  if (healthInFlight !== null) return healthInFlight;

  healthInFlight = (async () => {
    try {
      const response = await fetch('/api/llm/health', { cache: 'no-store' });
      if (!response.ok) return OFFLINE;
      const body = (await response.json()) as Partial<LlmHealth>;
      const value: LlmHealth = {
        available: body.available === true,
        transportKind: body.transportKind ?? 'none',
        model: body.model ?? null,
      };
      healthCache = { at: Date.now(), value };
      return value;
    } catch {
      healthCache = { at: Date.now(), value: OFFLINE };
      return OFFLINE;
    } finally {
      healthInFlight = null;
    }
  })();

  return healthInFlight;
}

/** Drop the memo, e.g. after the player edits their configuration. */
export function resetLlmHealth(): void {
  healthCache = null;
}

/* -------------------------------------------------------------------------- */
/*  Transport                                                                  */
/* -------------------------------------------------------------------------- */

interface RoleResponse<T> {
  readonly output: T | null;
  readonly fallback: boolean;
  readonly reason?: string;
}

/** Milliseconds before an interactive role call is abandoned. */
export const ROLE_TIMEOUT_MS = 45_000;

/**
 * The ceiling for calls that stand between the player and a resolved quarter.
 * Shorter on purpose: a quarter that takes half a minute to submit is a worse
 * game than a quarter the World Director sat out.
 */
export const QUARTER_ROLE_TIMEOUT_MS = 20_000;

async function postRole<T>(path: string, body: unknown, timeoutMs = ROLE_TIMEOUT_MS): Promise<T | null> {
  if (typeof window === 'undefined') return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const parsed = (await response.json()) as RoleResponse<T>;
    return parsed.output ?? null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/* -------------------------------------------------------------------------- */
/*  Conversations                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Which thread a conversational call belongs to.
 *
 * The client names the **parts** of a conversation — the game session, the seat
 * within it, the thread within that seat — and never the key. The key is what
 * the transport resumes a Claude session from, so it decides whose transcript a
 * reply is written into and can quote from; the server derives it from these
 * parts plus the verified caller, under a secret this bundle has never seen.
 *
 * That split is the whole point. A key composed here would be a key any caller
 * could compose, and `cos:<sessionId>` is guessable: one crafted POST would
 * resume another player's Chief of Staff thread, complete with their private
 * company briefing, and return the answer to the attacker.
 */
export interface ConversationRef {
  /** The *game* session. Never a Claude session. */
  readonly sessionId: string;
  readonly playerId: string;
  /** The thread within that seat: `main` for the Chief of Staff, the character id for dialogue. */
  readonly conversationId: string;
}

/** The wire form of a `ConversationRef`, named so nobody mistakes it for a Claude session id. */
function conversationBody(ref: ConversationRef): { gameSessionId: string; playerId: string; conversationId: string } {
  return { gameSessionId: ref.sessionId, playerId: ref.playerId, conversationId: ref.conversationId };
}

/* -------------------------------------------------------------------------- */
/*  Roles                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Interpret a natural-language instruction into typed actions.
 *
 * Returns null when no model is available. The Chief of Staff screen's
 * deterministic path is to echo the instruction back as a question requiring
 * confirmation — never to guess at an action.
 */
export function requestChiefOfStaff(
  input: ChiefOfStaffInput,
  conversation: ConversationRef,
): Promise<ChiefOfStaffInterpretation | null> {
  return postRole<ChiefOfStaffInterpretation>('/api/llm/chief-of-staff', {
    input,
    conversation: conversationBody(conversation),
  });
}

/**
 * Ask the World Director to contextualise this quarter's drawn candidates.
 *
 * Called by the store during `endQuarter`, never by a screen. Null falls the
 * resolver back to firing the drawn candidates on their family templates.
 */
export function requestWorldDirector(input: WorldDirectorInput): Promise<GmProposalBatch | null> {
  return postRole<GmProposalBatch>('/api/llm/world-director', { input }, QUARTER_ROLE_TIMEOUT_MS);
}

/**
 * Ask an NPC strategist for one company's quarter.
 *
 * Called by the store during `endQuarter`, never by a screen. Null leaves that
 * company on its archetype default.
 */
export function requestNpcBundle(
  input: NpcStrategistInput,
  evidence?: unknown,
): Promise<NpcActionBundle | null> {
  return postRole<NpcActionBundle>('/api/llm/npc-strategist', { input, evidence: evidence ?? null }, QUARTER_ROLE_TIMEOUT_MS);
}

/** One turn of dialogue with a character, on that seat's own thread. */
export function requestCharacterReply(
  context: CharacterUtteranceContext,
  conversation: ConversationRef,
): Promise<CharacterReply | null> {
  return postRole<CharacterReply>('/api/llm/character', {
    context,
    conversation: conversationBody(conversation),
  });
}

/**
 * Narrated colour over a committed resolution report.
 *
 * Optional by contract: if this returns null the Quarter Resolution screen
 * renders its lines directly, which are human-readable by construction.
 */
export function requestNarrative(
  report: ResolutionReport,
  focusCompanyId: string | null,
): Promise<NarratorOutput | null> {
  return postRole<NarratorOutput>('/api/llm/narrator', { report, focusCompanyId });
}
