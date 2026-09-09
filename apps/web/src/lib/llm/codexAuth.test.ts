import { afterEach, describe, expect, it, vi } from 'vitest';
import { cancelCodexLogin, codexCooldownLine, codexEffectiveReady, codexLoginFailureLine, codexRetryAfterSeconds, codexTerminalLoginLine, createCodexLoginLifecycle, pollCodexLogin, startCodexLogin } from './codexAuth';

const response = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

afterEach(() => vi.unstubAllGlobals());

describe('managed Codex login client', () => {
  it('lets local completion and sign-out outrank stale health', () => {
    expect(codexEffectiveReady(false, 'connected')).toBe(true);
    expect(codexEffectiveReady(true, 'cancelled')).toBe(false);
    expect(codexEffectiveReady(true, null)).toBe(true);
  });

  it('drops deferred callbacks after the drawer is disposed or a newer operation begins', async () => {
    const lifecycle = createCodexLoginLifecycle();
    const first = lifecycle.begin();
    let resolve!: () => void;
    const deferred = new Promise<void>((done) => { resolve = done; });
    const callbacks: string[] = [];
    const completion = deferred.then(() => {
      if (lifecycle.current(first)) callbacks.push('schedule poll');
    });

    lifecycle.dispose();
    resolve();
    await completion;
    expect(callbacks).toEqual([]);

    const retry = lifecycle.begin();
    const stale = retry;
    const current = lifecycle.begin();
    expect(lifecycle.current(stale)).toBe(false);
    expect(lifecycle.current(current)).toBe(true);
  });

  it('starts a device flow, polls pending, then observes confirmation', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(response({ ok: true, loginId: 'l1', userCode: 'ABCD-EFGH', verificationUrl: 'https://chatgpt.com/codex/auth', expiresAt: '2099-01-01T00:00:00Z' }))
      .mockResolvedValueOnce(response({ state: 'pending' }))
      .mockResolvedValueOnce(response({ state: 'connected' }));
    vi.stubGlobal('window', {});
    vi.stubGlobal('fetch', fetch);

    await expect(startCodexLogin()).resolves.toMatchObject({ kind: 'ok', value: { userCode: 'ABCD-EFGH' } });
    await expect(pollCodexLogin('l1')).resolves.toMatchObject({ kind: 'ok', value: { state: 'pending' } });
    await expect(pollCodexLogin('l1')).resolves.toMatchObject({ kind: 'ok', value: { state: 'connected' } });
    expect(fetch.mock.calls[1]![0]).toContain('loginId=l1');
  });

  it('keeps a start request alive past ten seconds, then aborts at its bounded deadline', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const fetch = vi.fn().mockImplementation((_path: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      signal = init.signal as AbortSignal;
      signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }));
    vi.stubGlobal('window', {});
    vi.stubGlobal('fetch', fetch);

    const request = startCodexLogin();
    await vi.advanceTimersByTimeAsync(10_001);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(14_999);
    expect(signal?.aborted).toBe(true);
    await expect(request).resolves.toEqual({ kind: 'unreachable' });
    vi.useRealTimers();
  });

  it('keeps a structured startup failure useful while ignoring arbitrary server detail', async () => {
    const fetch = vi.fn().mockResolvedValue(response({ reason: 'codex_executable_unavailable', detail: 'token=secret\nstack trace' }, 503));
    vi.stubGlobal('window', {});
    vi.stubGlobal('fetch', fetch);

    await expect(startCodexLogin()).resolves.toEqual({ kind: 'refused', status: 503, reason: 'codex_executable_unavailable' });
    expect(codexLoginFailureLine('account_verification_failed')).toBe('This server could not verify the ChatGPT account. Check the server setup.');
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('uses a bounded Retry-After cooldown and does not retry a failed start', async () => {
    const fetch = vi.fn().mockResolvedValue(response({ reason: 'rate_limited' }, 429));
    vi.stubGlobal('window', {});
    vi.stubGlobal('fetch', fetch);
    // The response helper keeps headers available to the client boundary.
    fetch.mockResolvedValueOnce(new Response(JSON.stringify({ reason: 'rate_limited' }), { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '12' } }));

    await expect(startCodexLogin()).resolves.toEqual({ kind: 'refused', status: 429, reason: 'rate_limited', retryAfterSeconds: 12 });
    expect(fetch).toHaveBeenCalledOnce();
    expect(codexRetryAfterSeconds('999999')).toBe(3600);
    expect(codexRetryAfterSeconds('not-a-number')).toBeUndefined();
    expect(codexCooldownLine(12)).toBe('Too many sign-in attempts. Try again in 12 seconds.');
    expect(codexTerminalLoginLine('error')).toBe('ChatGPT sign-in could not be completed. Try again.');
  });

  it('maps refused start and sends cancellation for an expired or abandoned flow', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(response({ reason: 'setup_secret_required' }, 403))
      .mockResolvedValueOnce(response({ ok: true }));
    vi.stubGlobal('window', {});
    vi.stubGlobal('fetch', fetch);

    await expect(startCodexLogin()).resolves.toMatchObject({ kind: 'refused', status: 403, reason: 'setup_secret_required' });
    await expect(cancelCodexLogin('l2')).resolves.toMatchObject({ kind: 'ok', value: { ok: true } });
    expect(fetch.mock.calls[1]![1]).toMatchObject({ method: 'DELETE' });
    expect(JSON.parse(String(fetch.mock.calls[1]![1]?.body))).toEqual({ loginId: 'l2' });
  });
});
