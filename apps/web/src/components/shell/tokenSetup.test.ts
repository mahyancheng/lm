/**
 * The Settings "AI · Claude" section, as a decision rather than as markup.
 *
 * This repo tests logic modules and not mounted JSX, which is why the phase
 * machine and every label live in `tokenSetup.ts` and the component is a
 * rendering of what they return.
 *
 * What must never regress:
 *
 * 1. **The static build shows no form.** The artifact has no backend, so the
 *    section must degrade to one honest line rather than to a paste field that
 *    silently cannot work.
 * 2. **"No credential" and "no server" are different answers**, and so are
 *    "refused" and "unreachable".
 * 3. **A machine already logged into Claude Code counts as configured**, even
 *    with no credential in the process.
 * 4. No label ever renders more of a secret than the mask it was given.
 */

import { describe, expect, it } from 'vitest';
import {
  NO_SERVER_LINE,
  credentialLine,
  refusalLine,
  sourceChip,
  statusHeadline,
  testResultLine,
  tokenPanelState,
  transportLabel,
} from './tokenSetup';
import type { TokenFetch, TokenStatus, TokenTestResult } from '../../lib/llm/token';

function status(overrides: Partial<TokenStatus> = {}): TokenStatus {
  return {
    configured: false,
    available: false,
    source: 'none',
    transportKind: 'none',
    model: null,
    masked: null,
    kind: null,
    setAt: null,
    authGate: 'open-local',
    ...overrides,
  };
}

const ok = (value: TokenStatus): TokenFetch<TokenStatus> => ({ kind: 'ok', value });

const CONFIGURED = status({
  configured: true,
  available: true,
  source: 'runtime',
  transportKind: 'claude-session',
  model: 'sonnet',
  masked: '…wxyz',
  kind: 'oauth',
  setAt: '2027-01-01T00:00:00.000Z',
});

/* -------------------------------------------------------------------------- */

describe('phases', () => {
  it('waits while the status call is in flight', () => {
    expect(tokenPanelState(null)).toEqual({ phase: 'loading', message: '', canWrite: false, status: null });
  });

  it('shows the paste form when a server answered and nothing is configured', () => {
    const state = tokenPanelState(ok(status()));
    expect(state.phase).toBe('unconfigured');
    expect(state.canWrite).toBe(true);
    expect(state.status).not.toBeNull();
  });

  it('shows the masked row when a credential is in force', () => {
    const state = tokenPanelState(ok(CONFIGURED));
    expect(state.phase).toBe('configured');
    expect(state.canWrite).toBe(true);
  });

  it('counts an ambient Claude Code login as configured, with no credential in the process', () => {
    // The machine is logged in and every role works; there is simply no token
    // here to mask. Offering the setup guide would be telling a working
    // deployment it is broken.
    const state = tokenPanelState(ok(status({ available: true, transportKind: 'claude-session', model: 'sonnet' })));
    expect(state.phase).toBe('configured');
  });

  it('replaces the whole section with one line when there is no server', () => {
    const state = tokenPanelState({ kind: 'unreachable' });
    expect(state.phase).toBe('no-server');
    expect(state.message).toBe(NO_SERVER_LINE);
    expect(state.message).toMatch(/pnpm dev/);
    expect(state.canWrite).toBe(false);
    expect(state.status).toBeNull();
  });

  it('distinguishes a server that refused from a server that is not there', () => {
    for (const httpStatus of [401, 403]) {
      const state = tokenPanelState({ kind: 'refused', status: httpStatus, reason: 'admin_only' });
      expect(state.phase).toBe('restricted');
      expect(state.message).not.toBe(NO_SERVER_LINE);
      expect(state.canWrite).toBe(false);
    }
  });

  it('says so plainly when the refusal was a rate limit', () => {
    const state = tokenPanelState({ kind: 'refused', status: 429, reason: 'rate_limited' });
    expect(state.phase).toBe('restricted');
    expect(state.message).toMatch(/minute/i);
  });
});

/* -------------------------------------------------------------------------- */

describe('labels', () => {
  it('names the transport in words a player has met', () => {
    expect(transportLabel('claude-session')).toBe('Claude Code session');
    expect(transportLabel('api')).toBe('Anthropic API');
    expect(transportLabel('none')).toBe('No transport');
  });

  it('attributes the credential, or nothing', () => {
    expect(sourceChip('runtime')).toBe('set in app');
    expect(sourceChip('env')).toBe('from env');
    expect(sourceChip('none')).toBeNull();
  });

  it('renders only the mask it was given, never a longer secret', () => {
    const line = credentialLine(CONFIGURED);
    expect(line).toContain('…wxyz');
    expect(line).toContain('Claude subscription token');
    expect(credentialLine({ ...CONFIGURED, kind: 'api_key' })).toContain('Anthropic API key');
  });

  it('explains the two credential-less states differently', () => {
    expect(credentialLine(status())).toMatch(/No credential/);
    expect(credentialLine(status({ available: true }))).toMatch(/Claude Code login/);
  });

  it('puts the model in the headline when there is one', () => {
    expect(statusHeadline(CONFIGURED)).toBe('Live · sonnet');
    expect(statusHeadline(status({ available: true }))).toBe('Live');
    expect(statusHeadline(status())).toBe('Offline');
    expect(statusHeadline(null)).toBe('Offline');
  });
});

/* -------------------------------------------------------------------------- */

describe('outcomes', () => {
  it('reports a clean success with the model and the latency', () => {
    const result: TokenTestResult = { ok: true, modelId: 'claude-sonnet-5', latencyMs: 1234 };
    expect(testResultLine(result)).toBe('Answered in 1234 ms on claude-sonnet-5.');
  });

  it('carries the note when the model answered but did not validate', () => {
    const result: TokenTestResult = { ok: true, modelId: 'sonnet', latencyMs: 900, note: 'The credential works.' };
    expect(testResultLine(result)).toMatch(/The credential works\./);
  });

  it('tells the operator to regenerate only when the token is the problem', () => {
    const bad: TokenTestResult = { ok: false, failure: 'bad_token', detail: 'disabled: no token', latencyMs: 40 };
    expect(testResultLine(bad)).toMatch(/setup-token/);

    const limited: TokenTestResult = { ok: false, failure: 'rate_limited', detail: 'rate_limited', latencyMs: 40 };
    expect(testResultLine(limited)).toMatch(/credential is fine/i);
    expect(testResultLine(limited)).not.toMatch(/setup-token/);
  });

  it('quotes the detail for a network failure, bounded by the route', () => {
    const network: TokenTestResult = { ok: false, failure: 'network', detail: 'timeout: gave up after 45s', latencyMs: 45_000 };
    expect(testResultLine(network)).toContain('timeout: gave up after 45s');
  });

  it('says there is nothing to test when no credential is configured', () => {
    const none: TokenTestResult = { ok: false, failure: 'transport_unavailable', detail: 'x', latencyMs: 0 };
    expect(testResultLine(none)).toMatch(/nothing to test/);
  });

  it('turns each refusal status into an instruction rather than a code', () => {
    expect(refusalLine(401, 'unauthenticated')).toMatch(/Sign in/);
    expect(refusalLine(403, 'admin_only')).toMatch(/administrator/);
    expect(refusalLine(429, 'rate_limited')).toMatch(/minute/i);
    expect(refusalLine(400, 'A credential is at least 20 characters.')).toBe('A credential is at least 20 characters.');
  });
});
