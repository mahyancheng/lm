import { afterEach, describe, expect, it, vi } from 'vitest';
import { cancelCodexLogin, codexEffectiveReady, createCodexLoginLifecycle, pollCodexLogin, startCodexLogin } from './codexAuth';

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
