/**
 * Typed client-side fetchers for the LLM routes.
 *
 * `@frontier/llm` and the Claude Agent SDK are **server-only** and must never
 * enter a client bundle. This module is the whole of the client's knowledge of
 * the model: six POSTs and a health check, each of which resolves to `null`
 * when no transport is configured or when anything at all goes wrong.
 *
 * Every caller must have a deterministic path for `null`. That is not a
 * courtesy: `failure_mode` is an engine invariant.
 */

import type {
  AgentRole,
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
  SocialAuthorInput,
  SocialPostDraft,
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
  /**
   * How many calls the shared concurrency limiter is holding right now, across
   * both priority lanes — see `LlmCallClass` in `@frontier/llm`. Zero whenever
   * nothing is queued, which is most of the time; a quarter's own batch of
   * calls is what runs this up. Used to tell "no credential" apart from "the
   * model is busy resolving the quarter" — see `describeLlmStatus`.
   *
   * Optional, and read as `?? 0` by every consumer: the game store's own
   * default health state predates this field, and a health object with it
   * simply absent must read as "nothing queued", not as a type error.
   */
  readonly queueDepth?: number;
  /** Which role currently holds the limiter's one permit, or null/absent when it is idle. */
  readonly runningRole?: AgentRole | null;
}

const OFFLINE: LlmHealth = { available: false, transportKind: 'none', model: null, queueDepth: 0, runningRole: null };

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
        queueDepth: typeof body.queueDepth === 'number' && Number.isFinite(body.queueDepth) ? Math.max(0, body.queueDepth) : 0,
        runningRole: body.runningRole ?? null,
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

/**
 * Milliseconds before an interactive role call is abandoned.
 *
 * Chief of Staff no longer uses this — see `CHIEF_OF_STAFF_TIMEOUT_MS` below,
 * and `requestChiefOfStaff`'s own doc comment for why 45s was never enough on
 * the Pi. This ceiling still governs the other interactive role, character
 * dialogue, which has not (yet) had the same treatment.
 */
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

/**
 * How long a quarter's own batch of model calls (World Director, then NPC
 * strategists) is allowed to run before the rest fall back to policy.
 *
 * Read once at module load, like every other `NEXT_PUBLIC_*` value: Next
 * inlines it at build time, so "reads the environment" is really "reads what
 * the image was built with" — consistent with `NEXT_PUBLIC_DEMO_MODE` in
 * `deploy/pi/.env.example`. Anything that does not parse as a positive finite
 * number reads as the 90s default the Pi's own env example documents: a typo
 * in a deployment variable must fail closed to *some* budget, never to an
 * unbounded one.
 */
export function resolveQuarterBudgetMs(raw: string | undefined): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 90_000;
}

export const LLM_QUARTER_BUDGET_MS = resolveQuarterBudgetMs(process.env.NEXT_PUBLIC_LLM_QUARTER_BUDGET_MS);

/**
 * How many rivals get a live strategist call in one quarter, at most.
 *
 * Independent of, and no larger a number than, `MAX_LIVE_STRATEGISTS` in
 * `@frontier/simulation` (the engine's own selection cap): that constant picks
 * *which* rivals are eligible at all — major tier, largest first — and this one
 * further trims how many of the eligible set actually get a model call before
 * the quarter's own `LLM_QUARTER_BUDGET_MS` is spent on them. Four is the Pi's
 * own budget divided by a genuine call's measured 4-10s with room for queueing
 * behind the World Director; a bigger host can raise it.
 */
export function resolveStrategistsPerQuarter(raw: string | undefined): number {
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 4;
}

export const LLM_STRATEGISTS_PER_QUARTER = resolveStrategistsPerQuarter(process.env.NEXT_PUBLIC_LLM_STRATEGISTS_PER_QUARTER);

async function postRole<T>(path: string, body: unknown, timeoutMs = ROLE_TIMEOUT_MS, signal?: AbortSignal): Promise<T | null> {
  if (typeof window === 'undefined') return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onExternalAbort = (): void => controller.abort();
  signal?.addEventListener('abort', onExternalAbort);
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
    signal?.removeEventListener('abort', onExternalAbort);
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
 * The deterministic answer, before any model has been asked.
 *
 * Hits a dedicated route that runs `offlineChiefOfStaff` server-side (the same
 * pure arithmetic the fallback uses) and nothing else: no queue, no
 * subprocess, no wait behind a resolving quarter. The point is speed — the
 * founder should see *something real* the instant they hit send, not a
 * spinner — so this has its own short timeout and is meant to be raced
 * alongside `requestChiefOfStaff`, not chained before it.
 *
 * Never writes the thread's memory: it is a preview of what the model call
 * would answer offline, and the turn that actually gets remembered is
 * whichever of the two replies the caller keeps.
 */
export function requestChiefOfStaffQuick(
  input: ChiefOfStaffInput,
  conversation: ConversationRef,
): Promise<ChiefOfStaffInterpretation | null> {
  return postRole<ChiefOfStaffInterpretation>(
    '/api/llm/chief-of-staff/quick',
    { input, conversation: conversationBody(conversation) },
    QUICK_ANSWER_TIMEOUT_MS,
  );
}

/**
 * Ceiling for a Chief of Staff turn that actually reaches a model.
 *
 * The old 45s ceiling was never enough even *uncontended* — a single
 * `claude-session` call has been measured at 27.5s, more than half the
 * budget — and on the Pi it shares one `LLM_MAX_CONCURRENCY=1` permit with a
 * resolving quarter's up to ten sequential batch calls, each 30-90s. A Chief
 * of Staff call queued behind that was aborted from the client every time,
 * which read to the founder as "consistently unreliable" when the model had
 * in fact answered — just after the 45s window gave up on it.
 *
 * Two things fix that together, not separately: `chief_of_staff` now runs in
 * the limiter's `interactive` lane (`packages/llm/src/transport/limited.ts`),
 * so it jumps ahead of a resolving quarter's batch calls rather than queuing
 * behind them — and this ceiling is wide enough to cover the case where it
 * still has to wait for whichever single call is already in flight (the
 * limiter never pre-empts a running call) plus its own genuine model time.
 *
 * 150s is generous on purpose, and it is safe to be generous because it is no
 * longer a silent wait: `requestChiefOfStaff` reports elapsed time and accepts
 * a cancel signal, so the caller can show a live "thinking · 37s" counter
 * instead of a bare spinner, and the founder decides for themself when
 * "generous" has become "too long".
 */
export const CHIEF_OF_STAFF_TIMEOUT_MS = 150_000;

/** How long the offline preview is allowed before it, too, is given up on. Generous only because it is meant to never need it. */
const QUICK_ANSWER_TIMEOUT_MS = 15_000;

/** Why a Chief of Staff attempt did not produce a model answer. Null means it did. */
export type ChiefOfStaffFailure = 'timeout' | 'network_error' | 'aborted' | null;

export interface ChiefOfStaffAttempt {
  /** A validated model reply, or null when nothing schema-valid came back. */
  readonly output: ChiefOfStaffInterpretation | null;
  /** Set whenever `output` is null, naming why. Distinguishes a deliberate cancel from a real failure. */
  readonly failure: ChiefOfStaffFailure;
  /**
   * True when the server ran its own deterministic responder instead of the
   * model — no transport configured, or the model answered invalid JSON twice.
   * Distinct from `failure`: this is still `output !== null`, a real answer,
   * just not a model-authored one.
   */
  readonly fallback: boolean;
}

export interface ChiefOfStaffCallOptions {
  /** Abort this attempt early — wired to the drawer's cancel button. Never retried once fired. */
  readonly signal?: AbortSignal;
}

type ChiefOfStaffOnceResult =
  | { readonly kind: 'ok'; readonly body: RoleResponse<ChiefOfStaffInterpretation> }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'aborted' }
  | { readonly kind: 'server_error' }
  | { readonly kind: 'network_error' }
  /**
   * A definitive 4xx from `admit()` or `parseBody()` — bad JSON, a rate limit,
   * an unauthenticated caller. Retrying it immediately would repeat the exact
   * same outcome (or, for a rate limit, make it worse), so this is deliberately
   * a separate kind from `server_error`/`network_error`: it reaches the
   * founder as the same "network error" sentence, but `requestChiefOfStaff`
   * never retries it.
   */
  | { readonly kind: 'client_error' };

/** One HTTP attempt at `/api/llm/chief-of-staff`, with enough bookkeeping to tell a timeout from a cancel from a 5xx. */
async function chiefOfStaffAttemptOnce(body: unknown, timeoutMs: number, external?: AbortSignal): Promise<ChiefOfStaffOnceResult> {
  if (typeof window === 'undefined') return { kind: 'network_error' };
  const controller = new AbortController();
  let abortedBy: 'timeout' | 'external' | null = null;
  const timer = setTimeout(() => {
    abortedBy = 'timeout';
    controller.abort();
  }, timeoutMs);
  const onExternalAbort = (): void => {
    abortedBy = 'external';
    controller.abort();
  };
  external?.addEventListener('abort', onExternalAbort);

  try {
    const response = await fetch('/api/llm/chief-of-staff', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!response.ok) return { kind: response.status >= 500 ? 'server_error' : 'client_error' };
    const parsed = (await response.json()) as RoleResponse<ChiefOfStaffInterpretation>;
    return { kind: 'ok', body: parsed };
  } catch {
    if (abortedBy === 'timeout') return { kind: 'timeout' };
    if (abortedBy === 'external') return { kind: 'aborted' };
    // Whatever the browser calls ECONNRESET, a DNS hiccup, or the tab going
    // offline mid-request — anything the fetch itself threw that was not our
    // own abort — is transient by nature, which is exactly what one retry is for.
    return { kind: 'network_error' };
  } finally {
    clearTimeout(timer);
    external?.removeEventListener('abort', onExternalAbort);
  }
}

/**
 * Interpret a natural-language instruction into typed actions.
 *
 * A transient failure — a 5xx or the connection dropping mid-request, neither
 * of which says anything about whether the model itself would have answered —
 * is retried exactly once before giving up. A timeout is not retried: at 150s
 * the caller has already shown the founder a live counter and a cancel button,
 * so a timeout is either genuine ("wait longer" is the founder's call, not this
 * function's) or the founder's own cancel, which must never turn into a second
 * request.
 *
 * Returns a `ChiefOfStaffAttempt`, never a bare null, so the caller can render
 * "no credential" (server said `fallback: true`, `reason: 'transport_none'`)
 * differently from "the model timed out" (`failure: 'timeout'`) differently
 * from "network error" (`failure: 'network_error'`) — the distinction the
 * drawer needs to tell the founder what to do next, rather than one generic
 * "no model reached".
 */
export async function requestChiefOfStaff(
  input: ChiefOfStaffInput,
  conversation: ConversationRef,
  options: ChiefOfStaffCallOptions = {},
): Promise<ChiefOfStaffAttempt> {
  const body = { input, conversation: conversationBody(conversation) };
  let attempt = await chiefOfStaffAttemptOnce(body, CHIEF_OF_STAFF_TIMEOUT_MS, options.signal);
  if ((attempt.kind === 'server_error' || attempt.kind === 'network_error') && options.signal?.aborted !== true) {
    attempt = await chiefOfStaffAttemptOnce(body, CHIEF_OF_STAFF_TIMEOUT_MS, options.signal);
  }

  switch (attempt.kind) {
    case 'ok':
      return { output: attempt.body.output ?? null, failure: null, fallback: attempt.body.fallback === true };
    case 'timeout':
      return { output: null, failure: 'timeout', fallback: false };
    case 'aborted':
      return { output: null, failure: 'aborted', fallback: false };
    case 'server_error':
    case 'network_error':
    case 'client_error':
      return { output: null, failure: 'network_error', fallback: false };
  }
}

/**
 * Ask the World Director to contextualise this quarter's drawn candidates.
 *
 * Called by the store during `endQuarter`, never by a screen. Null falls the
 * resolver back to firing the drawn candidates on their family templates.
 */
export function requestWorldDirector(input: WorldDirectorInput, signal?: AbortSignal): Promise<GmProposalBatch | null> {
  return postRole<GmProposalBatch>('/api/llm/world-director', { input }, QUARTER_ROLE_TIMEOUT_MS, signal);
}

/**
 * Ask an NPC strategist for one company's quarter.
 *
 * Called by the store during `endQuarter` and by the quarter-open strategist
 * prefetch (`lib/game/strategistPrefetch.ts`) alike — a strategist's plan
 * depends only on state at the start of the quarter and its own private
 * information, so both callers ask exactly the same question. Null leaves
 * that company on its archetype default.
 *
 * `signal` lets a caller abandon the request — the prefetch cache does this on
 * a new game or a load, so a background call for a session that no longer
 * exists does not resolve into it. Note the doc on `limited.ts`: aborting
 * client-side does not free the server's queue permit or stop an
 * already-spawned subprocess, only this promise's own settlement.
 */
export function requestNpcBundle(
  input: NpcStrategistInput,
  evidence?: unknown,
  signal?: AbortSignal,
): Promise<NpcActionBundle | null> {
  return postRole<NpcActionBundle>('/api/llm/npc-strategist', { input, evidence: evidence ?? null }, QUARTER_ROLE_TIMEOUT_MS, signal);
}

/**
 * Ask for the words of one post the engine has already decided to make.
 *
 * Called by the store during `endQuarter`, never by a screen, and capped at
 * `MAX_SOCIAL_TEXT_OVERRIDES` posts a quarter. Only `text` is ever read from the
 * result: the author, the network, the typed intent and the target came from the
 * engine and are not the model's to change. Null leaves the engine's own
 * template line in place, which is a complete post.
 */
export function requestSocialPost(input: SocialAuthorInput): Promise<SocialPostDraft | null> {
  return postRole<SocialPostDraft>('/api/llm/social-author', { input }, QUARTER_ROLE_TIMEOUT_MS);
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
