/**
 * The Chief of Staff transcript, kept per thread.
 *
 * The store owns game state; a conversation is not game state — nothing in it
 * binds until an action is queued — so it lives here, in the tab. Every
 * function below takes a `sessionId` parameter, but STAGE 5's switcher means
 * that is no longer just the session's own id: `useChiefOfStaff` passes
 * `${session.sessionId}:${activeCompany.id}` — a thread key — so a
 * subsidiary's conversation is a genuinely separate transcript from the
 * founding company's, never blurring memory (or, upstream, the Claude session
 * behind it) between the two. It survives navigation between screens and a
 * reload, and it is discarded when the session or the active company changes.
 *
 * Everything read back from storage is re-parsed with
 * `ChiefOfStaffInterpretationSchema` before it is trusted. That is the same
 * rule the gateway keeps on the way in: a model result is a proposal, and an
 * unvalidated one is not even that.
 */

import type { ChiefOfStaffInterpretation, LookupResult } from '@frontier/contracts';
import { ChiefOfStaffInterpretationSchema, LookupResultSchema } from '@frontier/contracts';
import type { ChiefOfStaffFailure } from '@/lib/llm/client';

export interface TranscriptEntry {
  /** Deterministic within a session: quarter and position, never a clock. */
  readonly id: string;
  readonly quarter: number;
  /** What the player typed. */
  readonly message: string;
  readonly interpretation: ChiefOfStaffInterpretation;
  /** True when no model answered and the deterministic echo is being shown. */
  readonly fallback: boolean;
  /**
   * True while `interpretation` is the instant offline preview and the real
   * request is still in flight — see the progressive-answer flow in
   * `useChiefOfStaff.ts`. Cleared the moment that request settles, whatever it
   * settles to, so it is never true on anything read back from storage.
   */
  readonly quick?: boolean;
  /**
   * Set only when the *final* answer is the offline one because the live call
   * genuinely failed (as opposed to no transport being configured at all,
   * which also sets `fallback` but leaves this unset). Lets the drawer say
   * "the model timed out" rather than a generic "no model reached".
   */
  readonly failureReason?: ChiefOfStaffFailure;
  /**
   * What the assistant went and looked up before answering, if it did.
   *
   * Produced by `runLookups` inside the engine against the session the tab
   * holds, so these are canonical figures rather than anything a model said.
   * Empty on a turn that needed no sourcing.
   */
  readonly findings?: readonly LookupResult[];
}

const memory = new Map<string, TranscriptEntry[]>();

/**
 * Who to tell when a transcript changes.
 *
 * The thread is now on two surfaces at once — the dedicated screen and the
 * drawer that opens over every other screen — and both must show the same
 * conversation. Without this, sending from the drawer would leave the screen
 * behind it holding a stale copy until it remounted.
 */
const listeners = new Set<() => void>();

/** Subscribe to transcript changes. Returns the unsubscribe. */
export function subscribeTranscript(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function notify(): void {
  for (const listener of [...listeners]) listener();
}

function storageKey(sessionId: string): string {
  return `frontier.cos.${sessionId}`;
}

/** Read the transcript for a session, hydrating from `sessionStorage` once. */
export function readTranscript(sessionId: string): TranscriptEntry[] {
  const cached = memory.get(sessionId);
  if (cached !== undefined) return cached;
  const hydrated = hydrate(sessionId);
  memory.set(sessionId, hydrated);
  return hydrated;
}

/** Replace the transcript for a session and persist it. */
export function writeTranscript(sessionId: string, entries: readonly TranscriptEntry[]): TranscriptEntry[] {
  const next = [...entries];
  memory.set(sessionId, next);
  persist(sessionId, next);
  notify();
  return next;
}

/** Append one exchange. Returns the new transcript. */
export function appendTranscript(sessionId: string, entry: TranscriptEntry): TranscriptEntry[] {
  return writeTranscript(sessionId, [...readTranscript(sessionId), entry]);
}

/**
 * Update one entry in place, by id. A no-op (returns the transcript unchanged,
 * still notifying nobody) if that id is no longer present — which is fine: it
 * means the founder cleared the thread while the live call was still in
 * flight, and there is nothing left to update.
 *
 * This is what turns the quick offline answer into the model's answer without
 * the exchange appearing to happen twice: same id, same position in the list,
 * new content.
 */
export function replaceTranscriptEntry(
  sessionId: string,
  id: string,
  patch: Partial<Omit<TranscriptEntry, 'id' | 'quarter' | 'message'>>,
): TranscriptEntry[] {
  const current = readTranscript(sessionId);
  const index = current.findIndex((entry) => entry.id === id);
  const existing = current[index];
  if (index === -1 || existing === undefined) return current;
  const next = [...current];
  next[index] = { ...existing, ...patch };
  return writeTranscript(sessionId, next);
}

/** Forget the conversation for a session. */
export function clearTranscript(sessionId: string): TranscriptEntry[] {
  return writeTranscript(sessionId, []);
}

/** The history the briefing builder wants: alternating turns, oldest first. */
export function historyOf(entries: readonly TranscriptEntry[]): { role: 'player' | 'chief_of_staff'; text: string }[] {
  const turns: { role: 'player' | 'chief_of_staff'; text: string }[] = [];
  for (const entry of entries) {
    turns.push({ role: 'player', text: entry.message });
    // The reply is what the founder read; the summary is the diff underneath
    // it. History carries the reply so the thread reads as a conversation.
    turns.push({ role: 'chief_of_staff', text: entry.interpretation.reply });
  }
  return turns.slice(-12);
}

/* -------------------------------------------------------------------------- */
/*  The deterministic path                                                     */
/* -------------------------------------------------------------------------- */

/** Trim to a length the schema will accept, without cutting mid-word where possible. */
function clip(value: string, max: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1)}…`;
}

/**
 * What the Chief of Staff says when no model answered.
 *
 * It asks rather than guesses, and it interprets nothing. `failure_mode` is an
 * engine invariant: the game never blocks on a model, and it never invents a
 * decision on the player's behalf to avoid admitting one is missing.
 */
export function echoFallback(message: string): ChiefOfStaffInterpretation {
  const asked = clip(message, 160);
  return {
    mode: 'answer',
    reply: clip(
      `I could not reach the server, so I have translated nothing and submitted nothing. What I heard was: "${asked}"`,
      2000,
    ),
    interpretedInstructions: [],
    summary: clip(
      `I could not reach a model, so I have translated nothing. What I heard was: "${asked}" — tell me which control you want and I will point you at it, or use the tickets beside this panel. No binding action has been submitted yet.`,
      1200,
    ),
    questions: [clip(`Should I read "${asked}" as one instruction, or several?`, 240)],
    requiresConfirmation: true,
    confidence: 0,
    unsupportedRequests: [],
    lookups: [],
  };
}

/* -------------------------------------------------------------------------- */
/*  Persistence                                                                */
/* -------------------------------------------------------------------------- */

interface StoredEntry {
  readonly id?: unknown;
  readonly quarter?: unknown;
  readonly message?: unknown;
  readonly interpretation?: unknown;
  readonly fallback?: unknown;
  readonly failureReason?: unknown;
  readonly findings?: unknown;
}

const FAILURE_REASONS: readonly ChiefOfStaffFailure[] = ['timeout', 'network_error', 'aborted'];

function readFailureReason(value: unknown): ChiefOfStaffFailure | undefined {
  return typeof value === 'string' && (FAILURE_REASONS as readonly string[]).includes(value) ? (value as ChiefOfStaffFailure) : undefined;
}

function hydrate(sessionId: string): TranscriptEntry[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.sessionStorage.getItem(storageKey(sessionId));
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: TranscriptEntry[] = [];
    for (const candidate of parsed as StoredEntry[]) {
      if (typeof candidate.id !== 'string' || typeof candidate.message !== 'string' || typeof candidate.quarter !== 'number') continue;
      const interpretation = ChiefOfStaffInterpretationSchema.safeParse(candidate.interpretation);
      if (!interpretation.success) continue;
      // Findings are re-parsed like the interpretation: a stored result is a
      // stored model-adjacent payload, and an unvalidated one is not data.
      const findings = Array.isArray(candidate.findings)
        ? candidate.findings.flatMap((row) => {
            const finding = LookupResultSchema.safeParse(row);
            return finding.success ? [finding.data] : [];
          })
        : [];
      // `quick` is deliberately never restored: it means "the live request is
      // still in flight", and nothing survives a reload to finish that
      // request. A rehydrated entry is always a settled one.
      const failureReason = readFailureReason(candidate.failureReason);
      out.push({
        id: candidate.id,
        quarter: candidate.quarter,
        message: candidate.message,
        interpretation: interpretation.data,
        fallback: candidate.fallback === true,
        ...(failureReason !== undefined ? { failureReason } : {}),
        ...(findings.length > 0 ? { findings } : {}),
      });
    }
    return out;
  } catch {
    return [];
  }
}

function persist(sessionId: string, entries: readonly TranscriptEntry[]): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(storageKey(sessionId), JSON.stringify(entries));
  } catch {
    // A full or disabled store is not an error worth surfacing: the transcript
    // is a convenience, and the in-memory copy still serves this tab.
  }
}
