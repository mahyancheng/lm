/**
 * `describeLlmStatus` — one sentence per state, and nothing else to test:
 * it is a pure function of a health reading and (optionally) the failure of
 * the attempt the founder just watched. Every branch gets its own case.
 */

import { describe, expect, it } from 'vitest';
import type { LlmHealth } from './client';
import { describeLlmStatus, estimateWaitLabel } from './status';

const READY: LlmHealth = { available: true, transportKind: 'claude-session', model: 'sonnet', queueDepth: 0, runningRole: null };

describe('estimateWaitLabel', () => {
  it('says "about to start" for an empty queue', () => {
    expect(estimateWaitLabel(0)).toBe('about to start');
    expect(estimateWaitLabel(-1)).toBe('about to start');
  });

  it('rounds to whole minutes, never claiming false precision', () => {
    expect(estimateWaitLabel(1, 60)).toBe('about 1 minute');
    expect(estimateWaitLabel(3, 60)).toBe('about 3 minutes');
    expect(estimateWaitLabel(1, 20)).toBe('less than a minute');
  });
});

describe('describeLlmStatus', () => {
  it('reports no credential when the transport is configured but nothing is', () => {
    const status = describeLlmStatus({ health: { available: false, transportKind: 'claude-session', model: null, queueDepth: 0, runningRole: null } });
    expect(status.kind).toBe('no_credential');
    expect(status.sentence).toBe('No credential connected.');
    expect(status.action).not.toBeNull();
  });

  it('reports deliberate offline demo mode distinctly from a missing credential', () => {
    const status = describeLlmStatus({ health: { available: false, transportKind: 'none', model: null, queueDepth: 0, runningRole: null } });
    expect(status.kind).toBe('offline_demo');
    expect(status.sentence).toContain('own state');
  });

  it('reports busy with a queue estimate when the model is available but occupied', () => {
    const status = describeLlmStatus({
      health: { available: true, transportKind: 'claude-session', model: 'sonnet', queueDepth: 3, runningRole: 'npc_strategist' },
    });
    expect(status.kind).toBe('busy');
    expect(status.sentence).toBe('The model is busy with a rival strategist — 3 calls ahead, about 3 minutes.');
  });

  it('reports ready with no action when nothing is queued and everything is configured', () => {
    const status = describeLlmStatus({ health: READY });
    expect(status.kind).toBe('ready');
    expect(status.action).toBeNull();
  });

  it('reports a timeout distinctly from a network error, from a cancel', () => {
    expect(describeLlmStatus({ health: READY, lastFailure: 'timeout' }).kind).toBe('timeout');
    expect(describeLlmStatus({ health: READY, lastFailure: 'network_error' }).kind).toBe('network_error');
    expect(describeLlmStatus({ health: READY, lastFailure: 'aborted' }).kind).toBe('aborted');
  });

  it('lets a just-watched failure outrank the ambient busy reading', () => {
    const busyHealth: LlmHealth = { available: true, transportKind: 'claude-session', model: 'sonnet', queueDepth: 5, runningRole: 'world_director' };
    expect(describeLlmStatus({ health: busyHealth, lastFailure: 'timeout' }).kind).toBe('timeout');
  });

  it('lets "no credential" outrank a stale queue reading that predates disconnecting', () => {
    const health: LlmHealth = { available: false, transportKind: 'claude-session', model: null, queueDepth: 4, runningRole: 'npc_strategist' };
    expect(describeLlmStatus({ health }).kind).toBe('no_credential');
  });

  it('treats an absent queueDepth as zero, for a health object from before this field existed', () => {
    const health: LlmHealth = { available: true, transportKind: 'claude-session', model: 'sonnet' };
    expect(describeLlmStatus({ health }).kind).toBe('ready');
  });
});
