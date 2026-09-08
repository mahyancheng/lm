import {
  CodexRpcClient,
  isRecord,
  spawnCodexAppServer,
  type CodexAppServerProcess,
  type CodexAppServerSpawn,
} from './codexProtocol';
import {
  ambientCodexEnv,
  assertIsolatedCodexHome,
  codexAppServerArgs,
  codexProcessEnv,
  type CodexAppServerTransportConfig,
} from './codexAppServer';

export const DEFAULT_CODEX_LOGIN_EXPIRY_MS = 15 * 60_000;
export const DEFAULT_CODEX_LOGIN_RPC_TIMEOUT_MS = 10_000;

export interface CodexLoginPrompt {
  readonly loginId: string;
  readonly userCode: string;
  readonly verificationUrl: string;
  readonly expiresAtMs: number;
}

export type CodexLoginStatus =
  | { readonly state: 'unavailable'; readonly cliAvailable: false; readonly signedIn: false; readonly error: string }
  | { readonly state: 'signedOut'; readonly cliAvailable: true; readonly signedIn: false }
  | { readonly state: 'waiting'; readonly cliAvailable: true; readonly signedIn: false; readonly login: CodexLoginPrompt }
  | { readonly state: 'signedIn'; readonly cliAvailable: true; readonly signedIn: true; readonly authMode: 'chatgpt' }
  | { readonly state: 'expired'; readonly cliAvailable: true; readonly signedIn: false; readonly error: string }
  | { readonly state: 'failed'; readonly cliAvailable: true; readonly signedIn: false; readonly error: string };

export interface CodexLoginManager {
  status(): CodexLoginStatus;
  refreshAccount(): Promise<CodexLoginStatus>;
  start(): Promise<CodexLoginStatus>;
  cancel(loginId?: string): Promise<CodexLoginStatus>;
  logout(): Promise<CodexLoginStatus>;
  close(): void;
}

export interface CodexLoginManagerConfig extends Pick<CodexAppServerTransportConfig, 'command' | 'codexHome' | 'cwd' | 'env'> {
  readonly spawn?: CodexAppServerSpawn;
  readonly expiryMs?: number;
  readonly rpcTimeoutMs?: number;
  readonly now?: () => number;
  /** Close cached inference clients after auth changes so they reload CODEX_HOME. */
  readonly onAccountChanged?: () => void;
}

interface LoginStartResult { readonly type: 'chatgptDeviceCode'; readonly loginId: string; readonly userCode: string; readonly verificationUrl: string }
interface LoginCompletion { readonly success: boolean; readonly loginId?: string | null; readonly error?: string | null }

export function createCodexLoginManager(config: CodexLoginManagerConfig = {}): CodexLoginManager {
  const env = config.env ?? ambientCodexEnv();
  const now = config.now ?? Date.now;
  const expiryMs = config.expiryMs ?? DEFAULT_CODEX_LOGIN_EXPIRY_MS;
  const rpcTimeoutMs = config.rpcTimeoutMs ?? DEFAULT_CODEX_LOGIN_RPC_TIMEOUT_MS;
  let current: CodexLoginStatus = { state: 'signedOut', cliAvailable: true, signedIn: false };
  let active: { client: CodexRpcClient; process: CodexAppServerProcess; login: CodexLoginPrompt; timer: ReturnType<typeof setTimeout>; unsubscribe: () => void } | null = null;
  let starting: Promise<CodexLoginStatus> | null = null;
  let refreshing: Promise<CodexLoginStatus> | null = null;
  let generation = 0;
  const notifyAccountChanged = (): void => { try { config.onAccountChanged?.(); } catch { /* auth state is already durable */ } };

  const open = async (): Promise<{ client: CodexRpcClient; process: CodexAppServerProcess }> => {
    if (config.spawn === undefined) await assertIsolatedCodexHome(config.codexHome);
    const process = (config.spawn ?? spawnCodexAppServer)({
      command: config.command ?? env['CODEX_COMMAND'] ?? 'codex',
      args: codexAppServerArgs(), cwd: config.cwd, env: codexProcessEnv(env, config.codexHome),
    });
    const client = new CodexRpcClient(process, rpcTimeoutMs);
    try {
      await client.request('initialize', { clientInfo: { name: 'frontier_capital', title: 'Frontier Capital', version: '0.1.0' }, capabilities: { experimentalApi: true } });
      client.sendNotification('initialized', {});
      return { client, process };
    } catch (error) { client.stop(); throw error; }
  };

  const endActive = (): void => {
    const session = active;
    if (session === null) return;
    active = null;
    clearTimeout(session.timer);
    session.unsubscribe();
    session.client.stop();
  };

  const finish = async (completion: LoginCompletion): Promise<void> => {
    const session = active;
    if (session === null || completion.loginId !== session.login.loginId) return;
    if (!completion.success) {
      endActive();
      current = { state: 'failed', cliAvailable: true, signedIn: false, error: 'ChatGPT sign-in did not complete.' };
      return;
    }
    try {
      const result = await session.client.request<unknown>('account/read', {});
      if (active !== session) return;
      const account = isRecord(result) ? result['account'] : null;
      endActive();
      if (isRecord(account) && account['type'] === 'chatgpt') {
        notifyAccountChanged();
        current = { state: 'signedIn', cliAvailable: true, signedIn: true, authMode: 'chatgpt' };
      } else {
        current = { state: 'failed', cliAvailable: true, signedIn: false, error: 'ChatGPT sign-in could not be verified.' };
      }
    } catch {
      if (active !== session) return;
      endActive();
      current = { state: 'failed', cliAvailable: true, signedIn: false, error: 'ChatGPT sign-in could not be verified.' };
    }
  };

  const manager: CodexLoginManager = {
    status: () => current,
    async refreshAccount() {
      if (active !== null) return current;
      const expectedGeneration = generation;
      refreshing ??= (async () => {
        let opened: Awaited<ReturnType<typeof open>> | null = null;
        try {
          opened = await open();
          const result = await opened.client.request<unknown>('account/read', {});
          if (generation !== expectedGeneration || active !== null) return current;
          const account = isRecord(result) ? result['account'] : null;
          current = isRecord(account) && account['type'] === 'chatgpt'
            ? { state: 'signedIn', cliAvailable: true, signedIn: true, authMode: 'chatgpt' }
            : { state: 'signedOut', cliAvailable: true, signedIn: false };
        } catch {
          if (generation !== expectedGeneration || active !== null) return current;
          current = { state: 'unavailable', cliAvailable: false, signedIn: false, error: 'Codex is unavailable on this host.' };
        } finally { opened?.client.stop(); }
        return current;
      })().finally(() => { refreshing = null; });
      return refreshing;
    },
    async start() {
      if (active !== null) return current;
      if (starting !== null) return starting;
      const expectedGeneration = ++generation;
      starting = (async () => {
        let opened: Awaited<ReturnType<typeof open>> | null = null;
        let early: LoginCompletion | null = null;
        try {
          opened = await open();
          const unsubscribe = opened.client.onNotification(({ method, params }) => {
            if (method !== 'account/login/completed' || !isRecord(params) || typeof params['success'] !== 'boolean') return;
            const completion: LoginCompletion = { success: params['success'], loginId: typeof params['loginId'] === 'string' ? params['loginId'] : null };
            if (active === null) early = completion; else void finish(completion);
          });
          const result = await opened.client.request<unknown>('account/login/start', { type: 'chatgptDeviceCode' });
          const parsed = loginStartOf(result, now() + expiryMs);
          if (generation !== expectedGeneration) { opened.client.stop(); return current; }
          const timer = setTimeout(() => {
            if (active?.login.loginId !== parsed.loginId) return;
            void active.client.request('account/login/cancel', { loginId: parsed.loginId }).catch(() => undefined);
            endActive();
            current = { state: 'expired', cliAvailable: true, signedIn: false, error: 'ChatGPT sign-in expired. Start again.' };
          }, expiryMs);
          active = { ...opened, login: parsed, timer, unsubscribe };
          const session = active;
          const unsubscribeClose = opened.client.onClose(() => {
            if (active !== session) return;
            endActive();
            current = { state: 'failed', cliAvailable: true, signedIn: false, error: 'ChatGPT sign-in was interrupted.' };
          });
          active.unsubscribe = () => { unsubscribe(); unsubscribeClose(); };
          current = { state: 'waiting', cliAvailable: true, signedIn: false, login: parsed };
          opened = null;
          if (early !== null) void finish(early);
          return current;
        } catch {
          opened?.client.stop();
          if (generation !== expectedGeneration) return current;
          current = { state: 'unavailable', cliAvailable: false, signedIn: false, error: 'Could not start ChatGPT sign-in.' };
          return current;
        }
      })().finally(() => { starting = null; });
      return starting;
    },
    async cancel(loginId) {
      const session = active;
      if (session === null || (loginId !== undefined && loginId !== session.login.loginId)) return current;
      try { await session.client.request('account/login/cancel', { loginId: session.login.loginId }); } catch { /* stopping still makes cancellation final locally */ }
      if (active !== session) return current;
      endActive();
      current = { state: 'signedOut', cliAvailable: true, signedIn: false };
      return current;
    },
    async logout() {
      const expectedGeneration = ++generation;
      endActive();
      let opened: Awaited<ReturnType<typeof open>> | null = null;
      try {
        opened = await open();
        await opened.client.request('account/logout', null);
        if (generation !== expectedGeneration) return current;
        current = { state: 'signedOut', cliAvailable: true, signedIn: false };
        notifyAccountChanged();
      } catch {
        if (generation !== expectedGeneration) return current;
        current = { state: 'unavailable', cliAvailable: false, signedIn: false, error: 'Could not sign out of ChatGPT.' };
      } finally { opened?.client.stop(); }
      return current;
    },
    close() { generation++; endActive(); },
  };
  return manager;
}

let singleton: CodexLoginManager | null = null;
export function getCodexLoginManager(config: CodexLoginManagerConfig = {}): CodexLoginManager {
  singleton ??= createCodexLoginManager(config);
  return singleton;
}

function loginStartOf(value: unknown, expiresAtMs: number): CodexLoginPrompt {
  if (!isRecord(value) || value['type'] !== 'chatgptDeviceCode') throw new Error('unexpected Codex login response');
  const loginId = safeText(value['loginId'], 512);
  const userCode = safeText(value['userCode'], 128);
  const verificationUrl = safeHttpsUrl(value['verificationUrl']);
  return { loginId, userCode, verificationUrl, expiresAtMs };
}

function safeText(value: unknown, max: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error('unsafe Codex login response');
  return value;
}

function safeHttpsUrl(value: unknown): string {
  const text = safeText(value, 2048);
  const url = new URL(text);
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.hostname !== 'auth.openai.com') throw new Error('unsafe Codex verification URL');
  return url.toString();
}
