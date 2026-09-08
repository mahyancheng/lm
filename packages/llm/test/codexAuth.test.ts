import { describe, expect, it, vi } from 'vitest';
import { createCodexLoginManager, type CodexAppServerProcess } from '../src';

function fakeProcess(options: { url?: string; signedIn?: boolean; earlyCompletion?: boolean } = {}) {
  const sent: Record<string, unknown>[] = [];
  const queue: string[] = [];
  let wake: (() => void) | null = null;
  let killed = false;
  let signedIn = options.signedIn ?? false;
  let resolveExit!: (value: { code: number | null; signal: string | null }) => void;
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => { resolveExit = resolve; });
  const push = (message: unknown) => { queue.push(`${JSON.stringify(message)}\n`); wake?.(); wake = null; };
  const process: CodexAppServerProcess & { sent: typeof sent; complete(success?: boolean): void; readonly killed: boolean } = {
    sent,
    get killed() { return killed; },
    write(line) {
      const message = JSON.parse(line) as Record<string, unknown>;
      sent.push(message);
      if (message['method'] === 'initialize') push({ id: message['id'], result: {} });
      if (message['method'] === 'account/read') push({ id: message['id'], result: { account: signedIn ? { type: 'chatgpt' } : null } });
      if (message['method'] === 'account/login/start') {
        if (options.earlyCompletion) { signedIn = true; push({ method: 'account/login/completed', params: { loginId: 'login-1', success: true } }); }
        push({ id: message['id'], result: { type: 'chatgptDeviceCode', loginId: 'login-1', userCode: 'ABCD-EFGH', verificationUrl: options.url ?? 'https://auth.openai.com/device' } });
      }
      if (message['method'] === 'account/login/cancel') push({ id: message['id'], result: { status: 'canceled' } });
      if (message['method'] === 'account/logout') push({ id: message['id'], result: {} });
    },
    complete(success = true) { signedIn = success; push({ method: 'account/login/completed', params: { loginId: 'login-1', success } }); },
    kill() { if (killed) return; killed = true; resolveExit({ code: null, signal: 'SIGTERM' }); },
    exited,
    stdout: { async *[Symbol.asyncIterator]() { while (!killed) { if (queue.length === 0) await new Promise<void>((resolve) => { wake = resolve; }); const next = queue.shift(); if (next !== undefined) yield next; } } },
  };
  return process;
}

describe('Codex managed ChatGPT login', () => {
  it('starts one device-code ceremony and completes from the matching notification', async () => {
    const process = fakeProcess();
    let spawns = 0;
    const manager = createCodexLoginManager({ spawn: () => { spawns++; return process; }, env: {}, rpcTimeoutMs: 100 });
    const [one, two] = await Promise.all([manager.start(), manager.start()]);
    expect(spawns).toBe(1);
    expect(one).toEqual(two);
    expect(one).toMatchObject({ state: 'waiting', login: { loginId: 'login-1', userCode: 'ABCD-EFGH', verificationUrl: 'https://auth.openai.com/device', expiresAtMs: expect.any(Number) } });
    expect(process.sent.find((x) => x['method'] === 'account/login/start')?.['params']).toEqual({ type: 'chatgptDeviceCode' });
    process.complete();
    await vi.waitFor(() => expect(manager.status()).toMatchObject({ state: 'signedIn', signedIn: true, authMode: 'chatgpt' }));
    expect(process.killed).toBe(true);
  });

  it('cancels only the current login and cannot leave stale readiness', async () => {
    const process = fakeProcess();
    const manager = createCodexLoginManager({ spawn: () => process, env: {}, rpcTimeoutMs: 100 });
    await manager.start();
    expect((await manager.cancel('another-login')).state).toBe('waiting');
    expect((await manager.cancel('login-1')).state).toBe('signedOut');
    expect(process.sent.find((x) => x['method'] === 'account/login/cancel')?.['params']).toEqual({ loginId: 'login-1' });
    process.complete();
    expect(manager.status().state).toBe('signedOut');
  });

  it('buffers completion that arrives before the login/start response', async () => {
    const process = fakeProcess({ earlyCompletion: true });
    const manager = createCodexLoginManager({ spawn: () => process, env: {}, rpcTimeoutMs: 100 });
    await manager.start();
    await vi.waitFor(() => expect(manager.status().state).toBe('signedIn'));
  });

  it('turns a mid-ceremony process exit into a terminal failure', async () => {
    const process = fakeProcess();
    const manager = createCodexLoginManager({ spawn: () => process, env: {}, rpcTimeoutMs: 100 });
    await manager.start();
    process.kill();
    await vi.waitFor(() => expect(manager.status()).toMatchObject({ state: 'failed', error: 'ChatGPT sign-in was interrupted.' }));
  });

  it('expires, requests cancellation, and terminates the login process', async () => {
    vi.useFakeTimers();
    const process = fakeProcess();
    const manager = createCodexLoginManager({ spawn: () => process, env: {}, expiryMs: 50, rpcTimeoutMs: 100 });
    await manager.start();
    await vi.advanceTimersByTimeAsync(50);
    expect(manager.status()).toMatchObject({ state: 'expired', error: 'ChatGPT sign-in expired. Start again.' });
    expect(process.killed).toBe(true);
    vi.useRealTimers();
  });

  it('rejects unsafe verification URLs without exposing them', async () => {
    const process = fakeProcess({ url: 'http://attacker.test/steal' });
    const manager = createCodexLoginManager({ spawn: () => process, env: {}, rpcTimeoutMs: 100 });
    expect(await manager.start()).toEqual({ state: 'unavailable', cliAvailable: false, signedIn: false, error: 'Could not start ChatGPT sign-in.' });
    expect(process.killed).toBe(true);
  });

  it('probes and logs out with sanitized process environment', async () => {
    const signedIn = fakeProcess({ signedIn: true });
    const logout = fakeProcess();
    const processes = [signedIn, logout];
    let childEnv: Readonly<Record<string, string | undefined>> = {};
    const manager = createCodexLoginManager({ spawn: (params) => { childEnv = params.env; return processes.shift()!; }, env: { PATH: '/bin', OPENAI_API_KEY: 'secret' }, rpcTimeoutMs: 100 });
    expect(await manager.refreshAccount()).toMatchObject({ state: 'signedIn', signedIn: true });
    expect(childEnv).toEqual({ PATH: '/bin' });
    expect((await manager.logout()).state).toBe('signedOut');
    expect(logout.sent.find((x) => x['method'] === 'account/logout')?.['params']).toBeNull();
  });
});
