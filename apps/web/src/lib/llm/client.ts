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
  SetupProposal,
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
 * Bumped whenever the answer this module holds stops being about the current
 * configuration — which is exactly when the player changes the credential.
 *
 * The bug this closes: `resetLlmHealth()` dropped the cache but left the
 * in-flight request alone, so a health check that started **before** a token
 * was pasted would land afterwards and write its stale `offline` into the cache
 * with a brand-new timestamp. The status dot then stayed wrong for the whole
 * TTL — and every settings mutation resets health, so the race was not exotic,
 * it was the ordinary sequence of clicking Connect while the status bar polled.
 *
 * A request now carries the generation it was issued under and simply declines
 * to write a cache it no longer speaks for.
 */
let healthGeneration = 0;

/**
 * Is a live model available?
 *
 * `Date.now` here is a UI-only concern (cache expiry) and never reaches the
 * simulation.
 *
 * `force` means *ask again now*: it skips the memo and, unlike the shared path,
 * refuses to join a request that is already in flight, because a caller forcing
 * a re-check has just changed something the older request cannot know about.
 */
export async function llmHealth(force = false): Promise<LlmHealth> {
  if (typeof window === 'undefined') return OFFLINE;
  const now = Date.now();
  if (!force) {
    if (healthCache !== null && now - healthCache.at < HEALTH_TTL_MS) return healthCache.value;
    if (healthInFlight !== null) return healthInFlight;
  }

  const generation = healthGeneration;
  /** Only the newest request may speak for the module. */
  const publish = (value: LlmHealth): LlmHealth => {
    if (generation === healthGeneration) healthCache = { at: Date.now(), value };
    return value;
  };

  // Declared before it is built so the `finally` below can compare identities:
  // a request must only retract the in-flight slot if the slot is still its own.
  let request: Promise<LlmHealth> | null = null;
  request = (async () => {
    try {
      const response = await fetch('/api/llm/health', { cache: 'no-store' });
      if (!response.ok) return OFFLINE;
      const body = (await response.json()) as Partial<LlmHealth>;
      return publish({
        available: body.available === true,
        transportKind: body.transportKind ?? 'none',
        model: body.model ?? null,
      });
    } catch {
      return publish(OFFLINE);
    } finally {
      // Never clear a newer request's promise: this one may be the loser of a
      // race it started first.
      if (healthInFlight === request) healthInFlight = null;
    }
  })();

  healthInFlight = request;
  return request;
}

/**
 * Drop the memo, e.g. after the player edits their configuration.
 *
 * Bumps the generation as well as clearing both slots, so an answer already on
 * its way back cannot overwrite the fresh one behind it.
 */
export function resetLlmHealth(): void {
  healthGeneration += 1;
  healthCache = null;
  healthInFlight = null;
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
 *
 * This used to be 20s, on the reasoning that a quarter taking half a minute to
 * submit is a worse game than a quarter the World Director sat out. That was
 * right when the five quarter calls — the Director and one per rival — all ran
 * at once, and each request's clock measured only model time.
 *
 * It is wrong now. The gateway bounds how many model calls run at once
 * (`LLM_MAX_CONCURRENCY`, default 1), because each `claude-session` call spawns
 * a Claude Code subprocess and a small always-on host cannot afford five of
 * them at once. So a request's clock now covers **queue time plus model time**,
 * and queue time is not the model being slow — it is this deployment being
 * careful. At the default bound the last rival waits behind four calls ahead of
 * it, and a 20s ceiling would abort it every single quarter: every rival past
 * the second would silently drop to its archetype default, which is exactly the
 * degradation the bound was added to avoid.
 *
 * 90s covers five sequential turns at the measured 4-10s each, with room for
 * the transport's one permitted repair attempt. Aborting earlier does not free
 * the server's permit or stop the subprocess — it only throws away an answer
 * that was already being paid for.
 */
export const QUARTER_ROLE_TIMEOUT_MS = 90_000;

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

/**
 * Read one turn of the new-game conversation into a `SetupProposal`.
 *
 * The only role call made before a session exists, and the only one whose null
 * changes nothing about what the player can do: the chat parses every message
 * deterministically in `lib/game/setupChat.ts` first, and this reading is
 * merged *under* that one. Offline, the conversation simply asks more directly.
 */
export function requestSetupProposal(
  message: string,
  history: readonly { readonly role: 'player' | 'chief_of_staff'; readonly text: string }[],
  established: SetupProposal | null,
): Promise<SetupProposal | null> {
  return postRole<SetupProposal>('/api/llm/setup-interpreter', { message, history, established });
}
