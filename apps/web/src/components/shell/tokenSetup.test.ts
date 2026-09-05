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
 * 5. **The reduced answer is a first-class shape.** The server describes the
 *    credential only to a caller who could change it, so every label has to
 *    read a status that carries four fields rather than nine — and the panel
 *    has to say *why* rather than render an empty row.
 */

import { describe, expect, it } from 'vitest';
import {
  DISABLED_LINE,
  LOCKED_LINE,
  NO_SERVER_LINE,
  credentialLine,
  isServerlessClaudeSession,
  runtimeServerlessCaveat,
  oauthFailureLine,
  pasteFieldLabel,
  pasteMode,
  refusalLine,
  serverlessNotice,
  sourceChip,
  statusDotTone,
  statusHeadline,
  testResultLine,
  tokenPanelState,
  transportLabel,
} from './tokenSetup';
import type { TokenFetch, TokenStatus, TokenStatusFull, TokenStatusPublic, TokenTestResult } from '../../lib/llm/token';

function status(overrides: Partial<TokenStatusFull> = {}): TokenStatusFull {
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
    serverless: false,
    ...overrides,
  };
}

/** What a caller who may not write the credential is told: the public facts, no descriptor. */
function publicStatus(overrides: Partial<TokenStatusPublic> = {}): TokenStatusPublic {
  return { configured: false, available: false, transportKind: 'none', authGate: 'admin', serverless: false, ...overrides };
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
    expect(tokenPanelState(null)).toEqual({ phase: 'loading', message: '', canWrite: false, status: null, descriptor: null });
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

  it('explains a deployment that takes no pasted credential at all, and names both ways out', () => {
    // A dev server binds every interface, so "no Supabase" is not evidence the
    // caller owns the machine. Reached from the network, the honest answer is
    // that this path is closed — with the two that are not.
    const state = tokenPanelState(ok(publicStatus({ authGate: 'disabled', available: true, transportKind: 'claude-session' })));
    expect(state.phase).toBe('disabled');
    expect(state.message).toBe(DISABLED_LINE);
    expect(state.message).toMatch(/CLAUDE_CODE_OAUTH_TOKEN/);
    expect(state.message).toMatch(/LLM_TOKEN_SETUP=local/);
    expect(state.canWrite).toBe(false);
    // The headline is still worth rendering: whether roles reach a model is a
    // public fact, and it is what the player opened this section to check.
    expect(state.status).not.toBeNull();
    expect(state.descriptor).toBeNull();
  });

  it('says disabled even when a credential is in force, because it is still not writable', () => {
    const state = tokenPanelState(ok(status({ authGate: 'disabled', configured: true, available: true, masked: '…wxyz' })));
    expect(state.phase).toBe('disabled');
    expect(state.canWrite).toBe(false);
  });

  it('treats a withheld descriptor as the refusal it is', () => {
    // On an admin deployment a signed-in player is admitted and told the four
    // public facts. There is no form to draw for them, and no masked row.
    const state = tokenPanelState(ok(publicStatus({ configured: true, available: true, transportKind: 'claude-session' })));
    expect(state.phase).toBe('restricted');
    expect(state.message).toMatch(/administrator/);
    expect(state.canWrite).toBe(false);
    expect(state.descriptor).toBeNull();
    expect(state.status).not.toBeNull();
  });

  it('hands the narrowed descriptor to the caller who was given one', () => {
    const state = tokenPanelState(ok(CONFIGURED));
    expect(state.descriptor).toEqual(CONFIGURED);
    expect(state.descriptor?.masked).toBe('…wxyz');
  });

  it('leads with the unlock field when the deployment offers the secret gate and this caller has not unlocked', () => {
    // authGate `secret` with no descriptor: not "you may never write" but "you
    // have not unlocked yet". The panel shows the one-time secret field, not the
    // administrator dead end.
    const state = tokenPanelState(ok(publicStatus({ authGate: 'secret', available: false, transportKind: 'none' })));
    expect(state.phase).toBe('locked');
    expect(state.message).toBe(LOCKED_LINE);
    expect(state.canWrite).toBe(false);
    expect(state.descriptor).toBeNull();
  });

  it('becomes an ordinary configured panel once the secret unlocks the descriptor', () => {
    // After the secret is accepted the server discloses the descriptor, so the
    // same `secret` gate now flows through to the live check.
    const unlocked = tokenPanelState(ok(status({ authGate: 'secret', configured: true, available: true, masked: '…wxyz', source: 'runtime', transportKind: 'claude-session' })));
    expect(unlocked.phase).toBe('configured');
    expect(unlocked.canWrite).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */

describe('serverless honesty', () => {
  const serverlessOauth = status({
    configured: true,
    available: false,
    serverless: true,
    transportKind: 'claude-session',
    source: 'runtime',
    masked: '…wxyz',
    authGate: 'secret',
  });

  it('recognises a subscription credential that cannot run on this host', () => {
    expect(isServerlessClaudeSession(serverlessOauth)).toBe(true);
    // An API key on the same host runs fine; a self-hosted subscription runs fine.
    expect(isServerlessClaudeSession({ ...serverlessOauth, transportKind: 'api' })).toBe(false);
    expect(isServerlessClaudeSession({ ...serverlessOauth, serverless: false })).toBe(false);
  });

  it('never claims Live for it — it is connected, not live', () => {
    expect(statusHeadline(serverlessOauth)).toBe('Subscription connected');
    // And the dot is a caution, not the green live pulse and not plain idle.
    expect(statusDotTone(serverlessOauth)).toBe('caution');
    expect(statusDotTone(status({ available: true }))).toBe('live');
    expect(statusDotTone(status())).toBe('idle');
  });

  it('spells out both truths: it runs self-hosted, and this host wants an API key', () => {
    const note = serverlessNotice(serverlessOauth);
    expect(note).toMatch(/self-hosted/);
    expect(note).toMatch(/API key/);
    // Nothing to caveat when the transport can actually run here.
    expect(serverlessNotice(status({ available: true, transportKind: 'claude-session' }))).toBeNull();
    expect(serverlessNotice(null)).toBeNull();
  });

  it('warns that an in-app credential reaches only one serverless instance', () => {
    // An API key pasted in-app on Vercel: the transport is fine, but it lives in
    // one lambda — the caveat names the env-var fix.
    const apiRuntime = status({ configured: true, available: true, serverless: true, transportKind: 'api', source: 'runtime', masked: '…api1', kind: 'api_key' });
    const note = runtimeServerlessCaveat(apiRuntime);
    expect(note).toMatch(/one server instance/);
    expect(note).toMatch(/environment variable/);
    // An env-sourced credential is on every instance; a non-serverless host has one process.
    expect(runtimeServerlessCaveat({ ...apiRuntime, source: 'env' })).toBeNull();
    expect(runtimeServerlessCaveat({ ...apiRuntime, serverless: false })).toBeNull();
    // A public (reduced) status carries no source, so no runtime claim to caveat.
    expect(runtimeServerlessCaveat(publicStatus({ configured: true, serverless: true }))).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */

describe('pasting a replacement', () => {
  const configured = tokenPanelState(ok(CONFIGURED));
  const unconfigured = tokenPanelState(ok(status()));

  it('keeps the three-step guide exclusive to the unconfigured phase', () => {
    expect(pasteMode(unconfigured, false)).toBe('guided');
    expect(pasteMode(unconfigured, true)).toBe('guided');
    expect(pasteMode(configured, false)).toBe('none');
  });

  it('offers the same field again once a credential is in force', () => {
    // The dead end this closes: an expired env token still reports Live, and
    // Disconnect renders only for a runtime credential, so there was no way to
    // paste a new one without editing a dotfile and restarting.
    expect(pasteMode(configured, true)).toBe('replace');
    expect(pasteFieldLabel('replace')).toMatch(/replacement/);
    expect(pasteFieldLabel('guided')).toBe('Paste a token or API key');
  });

  it('works for an environment credential, which is the case that needed it', () => {
    const fromEnv = tokenPanelState(ok(status({ configured: true, available: true, source: 'env', masked: '…envv' })));
    expect(fromEnv.phase).toBe('configured');
    expect(pasteMode(fromEnv, true)).toBe('replace');
  });

  it('offers nothing to a phase that may not write, however the disclosure is toggled', () => {
    for (const state of [
      tokenPanelState({ kind: 'unreachable' }),
      tokenPanelState({ kind: 'refused', status: 403, reason: 'admin_only' }),
      tokenPanelState(ok(publicStatus({ authGate: 'disabled', available: true }))),
      tokenPanelState(ok(publicStatus({ configured: true, available: true }))),
      tokenPanelState(null),
    ]) {
      expect(pasteMode(state, true)).toBe('none');
      expect(pasteMode(state, false)).toBe('none');
    }
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

  it('still answers live or offline from the four public facts alone', () => {
    // The model name is part of the descriptor, so a caller who was not shown
    // one gets the plain headline rather than a crash or an "undefined".
    expect(statusHeadline(publicStatus({ available: true }))).toBe('Live');
    expect(statusHeadline(publicStatus())).toBe('Offline');
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

  it('gives each hardened refusal its own instruction, because they are not the same problem', () => {
    // Three 403s and two 401s that would otherwise read identically, and the
    // right response to each is completely different.
    expect(refusalLine(403, 'setup_disabled')).toBe(DISABLED_LINE);
    expect(refusalLine(403, 'setup_secret_required')).toMatch(/setup secret/i);
    expect(refusalLine(401, 'cookie_required')).toMatch(/session cookie/i);
    expect(refusalLine(401, 'cookie_required')).not.toMatch(/Sign in/);
    for (const reason of ['cross_site', 'origin_unverified', 'unsupported_media_type']) {
      expect(refusalLine(403, reason)).toMatch(/did not look like it came from this page/);
    }
  });

  it('turns each in-app connect failure into its own next step', () => {
    expect(oauthFailureLine('expired_code', 'HTTP 401')).toMatch(/expired/i);
    // The flow-level failures already carry an actionable sentence from the server.
    expect(oauthFailureLine('bad_state', 'Start again and use the newest link.')).toMatch(/newest link/);
    expect(oauthFailureLine('expired_flow', 'This connect attempt has expired or was already used. Start again.')).toMatch(/expired/i);
    expect(oauthFailureLine('network', 'ECONNRESET')).toMatch(/ECONNRESET/);
    // An exchange failure points at the manual paste fallback rather than a dead end.
    expect(oauthFailureLine('exchange_failed', 'HTTP 500')).toMatch(/setup-token/);
  });
});
