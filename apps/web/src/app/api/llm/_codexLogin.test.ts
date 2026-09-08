import { beforeEach, describe, expect, it, vi } from 'vitest';

let resolveStart: ((value: any) => void) | null = null;
const manager = {
  status: vi.fn(),
  start: vi.fn(),
  cancel: vi.fn(),
  refreshAccount: vi.fn(),
  logout: vi.fn(),
  close: vi.fn(),
};
const invalidate = vi.fn();
vi.mock('@frontier/llm', () => ({ getCodexLoginManager: vi.fn(() => manager) }));
vi.mock('./_gateway', () => ({ invalidateGatewayForManagedCodexAuth: invalidate }));
const { resetCodexLoginOwnership, startLoginFor, loginStatusFor, refreshCodexAccount } = await import('./_codexLogin');

const a = { kind: 'anonymous' as const, id: 'operator-a' };
const b = { kind: 'anonymous' as const, id: 'operator-b' };
const waiting = { state: 'waiting' as const, cliAvailable: true as const, signedIn: false as const, login: { loginId: 'login-1', userCode: 'ABCDE', verificationUrl: 'https://auth.openai.com/device', expiresAtMs: Date.UTC(2026, 0, 1) } };

beforeEach(() => {
  process.env.CODEX_HOME = '/workspace/scratch/2fbf25b6959f/lm/.test-codex-home';
  process.env.CODEX_WORKDIR = '/workspace/scratch/2fbf25b6959f/lm/.test-codex-home/workspace';
  resetCodexLoginOwnership();
  manager.status.mockReset().mockReturnValue(waiting);
  manager.start.mockReset().mockImplementation(() => new Promise((resolve) => { resolveStart = resolve; }));
  manager.cancel.mockReset(); manager.refreshAccount.mockReset(); manager.logout.mockReset(); manager.close.mockReset();
  invalidate.mockReset();
});

describe('managed Codex login ownership', () => {
  it('reserves a pending device ceremony before awaiting Codex so another browser cannot steal it', async () => {
    const first = startLoginFor(a);
    const second = await startLoginFor(b);
    expect(second).toEqual({ ok: false, reason: 'login_in_progress' });
    resolveStart?.(waiting);
    expect(await first).toMatchObject({ ok: true, loginId: 'login-1' });
    expect(loginStatusFor(b, 'login-1')).toMatchObject({ state: 'error' });
    expect(loginStatusFor(a, 'login-1')).toEqual({ state: 'pending' });
  });

  it('releases a completed ceremony so a later actor cannot be held hostage by stale ownership', async () => {
    manager.start.mockResolvedValue(waiting);
    await startLoginFor(a);
    manager.status.mockReturnValue({ state: 'expired', cliAvailable: true, signedIn: false, error: 'expired' });
    expect(loginStatusFor(a, 'login-1')).toEqual({ state: 'expired' });
    manager.start.mockResolvedValue(waiting);
    expect(await startLoginFor(b)).toMatchObject({ ok: true, loginId: 'login-1' });
  });

  it('returns the manager safe failure code without exposing diagnostic text', async () => {
    manager.start.mockResolvedValue({ state: 'unavailable', cliAvailable: false, signedIn: false, error: 'secret account diagnostic', errorCode: 'codex_executable_unavailable' });
    expect(await startLoginFor(a)).toEqual({ ok: false, reason: 'codex_executable_unavailable' });
  });

  it('turns unexpected manager rejections into safe bounded failures', async () => {
    manager.start.mockRejectedValue(new Error('token=secret account=private'));
    expect(await startLoginFor(a)).toEqual({ ok: false, reason: 'codex_start_failed' });
    manager.refreshAccount.mockRejectedValue(new Error('token=secret account=private'));
    expect(await refreshCodexAccount()).toEqual({ state: 'unavailable', cliAvailable: false, signedIn: false, error: 'Codex app-server could not initialize.', errorCode: 'codex_initialization_failed' });
  });
});
