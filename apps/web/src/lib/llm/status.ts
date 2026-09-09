/**
 * Turning `LlmHealth` and a Chief of Staff attempt's own failure into one
 * honest sentence.
 *
 * "Chief of staff is unreliable, consistently gets model cannot reach" was the
 * report. The actual causes were four different situations that all rendered
 * as the same generic wall: no credential connected, the model genuinely busy
 * behind a resolving quarter, a client-side timeout, and a plain network
 * error. Collapsing all four into "cannot reach" told the founder nothing
 * about what to do next. This module tells them apart, in plain words, with
 * what to do about each — and is pure so every branch is a one-line test.
 */

import type { AgentRole } from '@frontier/contracts';
import type { ChiefOfStaffFailure, LlmHealth } from './client';

/** Seconds a single `claude-session` call is budgeted for, for the "about N minutes" estimate below. Midpoint of the documented 30-90s range on the Pi. */
const ESTIMATED_CALL_SECONDS = 60;

/**
 * "About N minutes" (or "about a minute", or "less than a minute") for
 * `queueDepth` calls ahead at `secondsPerCall` each.
 *
 * Deliberately coarse: this is a queue estimate on a single-core machine
 * running a language model, not a delivery promise, and a number with false
 * precision ("about 132 seconds") would read as more certain than it is.
 */
export function estimateWaitLabel(queueDepth: number, secondsPerCall: number = ESTIMATED_CALL_SECONDS): string {
  if (queueDepth <= 0) return 'about to start';
  const totalSeconds = Math.max(0, queueDepth) * Math.max(1, secondsPerCall);
  const minutes = Math.round(totalSeconds / 60);
  if (minutes <= 0) return 'less than a minute';
  if (minutes === 1) return 'about 1 minute';
  return `about ${minutes} minutes`;
}

/** Which honest-status bucket the client is in right now. */
export type LlmStatusKind = 'ready' | 'no_credential' | 'offline_demo' | 'busy' | 'timeout' | 'network_error' | 'aborted';

export interface LlmStatusMessage {
  readonly kind: LlmStatusKind;
  /** The one line the drawer shows: what is true right now, in plain words. */
  readonly sentence: string;
  /** What to do about it, or null when there is nothing to do. */
  readonly action: string | null;
}

export interface LlmStatusInput {
  readonly health: LlmHealth;
  /**
   * The most recent Chief of Staff attempt's own failure, if the founder just
   * tried and it did not land. Takes priority over the ambient health reading
   * — a person who just watched their own request time out should be told
   * about *that*, not a generic queue estimate that may have since changed.
   */
  readonly lastFailure?: ChiefOfStaffFailure;
}

function roleLabel(role: AgentRole | null | undefined): string {
  switch (role) {
    case 'world_director':
      return 'the World Director';
    case 'npc_strategist':
      return 'a rival strategist';
    case 'social_author':
      return 'a social post';
    case 'narrator':
      return 'the narrator';
    case 'chief_of_staff':
      return 'another Chief of Staff question';
    case 'character_dialogue':
      return 'a conversation';
    case 'innovation_interpreter':
      return 'an innovation proposal';
    default:
      return 'another call';
  }
}

/**
 * The one sentence to show, and the one thing to do about it.
 *
 * Order of the checks is the order of relevance: a failure from the attempt
 * the founder just watched outranks the ambient queue reading (which may
 * already be stale by the time it is rendered); "no credential at all" and
 * "deliberately offline" outrank "busy", because neither of those is going to
 * resolve itself by waiting; "busy" only applies once every simpler
 * explanation has been ruled out.
 */
export function describeLlmStatus(input: LlmStatusInput): LlmStatusMessage {
  const { health, lastFailure } = input;

  if (lastFailure === 'aborted') {
    return { kind: 'aborted', sentence: 'Cancelled — showing the quick answer.', action: 'Ask again to try the model once more.' };
  }
  if (lastFailure === 'timeout') {
    return {
      kind: 'timeout',
      sentence: 'The model timed out.',
      action: 'Showing the quick answer for now. Try again, or wait — a resolving quarter clears on its own.',
    };
  }
  if (lastFailure === 'network_error') {
    return { kind: 'network_error', sentence: 'Network error reaching the model.', action: 'Check the connection and try again.' };
  }

  if (!health.available) {
    if (health.transportKind === 'none') {
      return {
        kind: 'offline_demo',
        sentence: 'No model connected — answers come from your own state.',
        action: 'Connect a credential in Settings → AI for live replies.',
      };
    }
    return { kind: 'no_credential', sentence: 'No credential connected.', action: 'Connect one in Settings → AI.' };
  }

  const queueDepth = health.queueDepth ?? 0;
  if (queueDepth > 0) {
    const callWord = queueDepth === 1 ? 'call' : 'calls';
    const runningWhat = roleLabel(health.runningRole);
    return {
      kind: 'busy',
      sentence: `The model is busy with ${runningWhat} — ${queueDepth} ${callWord} ahead, ${estimateWaitLabel(queueDepth)}.`,
      action: 'Keep asking — the quick answer still comes through now, and your question jumps the line ahead of the quarter.',
    };
  }

  return { kind: 'ready', sentence: 'Connected.', action: null };
}
