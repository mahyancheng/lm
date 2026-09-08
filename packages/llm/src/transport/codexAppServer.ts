import type { LlmSessionStore } from '../sessionStore';
import { access, readdir } from 'node:fs/promises';
import { extractJsonObject } from './json';
import { structuredOutputSchemaFor } from './schemaText';
import { CodexProtocolError, CodexRpcClient, isRecord, spawnCodexAppServer, type CodexAppServerProcess, type CodexAppServerSpawn } from './codexProtocol';
import { nowMs, parseAgainst, taggedIssue, validationFailed, validationOk, type LlmCompletion, type LlmCompletionRequest, type LlmFailureReason, type LlmTokenUsage, type LlmTransport } from './types';

export type { CodexAppServerProcess, CodexAppServerSpawn } from './codexProtocol';

/** Audit label used when app-server selects the account's configured model. */
export const DEFAULT_CODEX_APP_SERVER_MODEL = 'codex-app-server';
export const DEFAULT_CODEX_APP_SERVER_TIMEOUT_MS = 120_000;

export interface CodexAppServerTransportConfig {
  readonly model?: string;
  readonly sessionStore?: LlmSessionStore;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly cwd?: string;
  readonly timeoutMs?: number;
  readonly command?: string;
  /** Dedicated Codex home containing only the integration's locked-down config. */
  readonly codexHome?: string;
  readonly spawn?: CodexAppServerSpawn;
}

export interface CodexAppServerTransport extends LlmTransport {
  readonly kind: 'codex-app-server';
  close(): void;
}

export interface CodexAppServerAccountStatus {
  readonly cliAvailable: boolean;
  readonly signedIn: boolean;
  readonly authMode?: 'chatgpt';
}

/** Short, read-only readiness probe. It never returns account identifiers or tokens. */
export async function probeCodexAppServerAccount(config: CodexAppServerTransportConfig = {}): Promise<CodexAppServerAccountStatus> {
  const env = config.env ?? ambientEnv();
  let process: CodexAppServerProcess | null = null;
  try {
    if (config.spawn === undefined) await assertIsolatedCodexHome(config.codexHome);
    process = (config.spawn ?? spawnCodexAppServer)({
      command: config.command ?? env['CODEX_COMMAND'] ?? 'codex', args: codexArgs(), cwd: config.cwd,
      env: codexProcessEnv(env, config.codexHome),
    });
    const client = new CodexRpcClient(process, Math.min(config.timeoutMs ?? 3_000, 3_000));
    await client.request('initialize', { clientInfo: { name: 'frontier_capital_health', title: 'Frontier Capital Health', version: '0.1.0' } });
    client.sendNotification('initialized', {});
    try {
      const result = await client.request<unknown>('account/read', {});
      client.stop();
      const account = isRecord(result) ? result['account'] : null;
      const signedIn = isRecord(account) && account['type'] === 'chatgpt';
      return signedIn ? { cliAvailable: true, signedIn: true, authMode: 'chatgpt' } : { cliAvailable: true, signedIn: false };
    } catch {
      client.stop();
      return { cliAvailable: true, signedIn: false };
    }
  } catch {
    process?.kill();
    return { cliAvailable: false, signedIn: false };
  }
}

interface ThreadResult { readonly model?: string; readonly thread: { readonly id: string } }
interface TurnResult { readonly turn: { readonly id: string } }

interface TurnOutcome {
  readonly text: string;
  readonly error: Error | null;
  readonly tokens: LlmTokenUsage | null;
}

export function createCodexAppServerTransport(config: CodexAppServerTransportConfig = {}): CodexAppServerTransport {
  const env = config.env ?? ambientEnv();
  const configuredModel = config.model ?? env['CODEX_MODEL'];
  const model = configuredModel ?? DEFAULT_CODEX_APP_SERVER_MODEL;
  const timeoutMs = config.timeoutMs ?? DEFAULT_CODEX_APP_SERVER_TIMEOUT_MS;
  const store = config.sessionStore;
  const locks = createKeyLocks();
  let connection: Promise<CodexRpcClient> | null = null;

  const connect = (): Promise<CodexRpcClient> => {
    if (connection !== null) return connection;
    let initializingClient: CodexRpcClient | null = null;
    connection = (async () => {
      if (config.spawn === undefined) await assertIsolatedCodexHome(config.codexHome);
      const processEnv = codexProcessEnv(env, config.codexHome);
      const process = (config.spawn ?? spawnCodexAppServer)({
        command: config.command ?? env['CODEX_COMMAND'] ?? 'codex',
        args: codexArgs(), cwd: config.cwd,
        env: processEnv,
      });
      const client = new CodexRpcClient(process, timeoutMs);
      initializingClient = client;
      client.onClose(() => { connection = null; });
      await client.request('initialize', { clientInfo: { name: 'frontier_capital', title: 'Frontier Capital', version: '0.1.0' }, capabilities: { experimentalApi: true } });
      client.sendNotification('initialized', {});
      return client;
    })().catch((error) => {
      initializingClient?.stop();
      connection = null;
      throw error;
    });
    return connection;
  };

  return {
    kind: 'codex-app-server',
    close(): void {
      void connection?.then((client) => client.stop()).catch(() => undefined);
      connection = null;
    },
    async complete<T>(req: LlmCompletionRequest<T>): Promise<LlmCompletion<T>> {
      const release = req.sessionKey === null ? null : await locks.acquire(req.sessionKey);
      const started = nowMs();
      const finish = (partial: Omit<LlmCompletion<T>, 'latencyMs'>): LlmCompletion<T> => ({ ...partial, latencyMs: nowMs() - started });
      let threadId: string | null = null;
      let modelId = model;
      try {
        let outputSchema: Record<string, unknown>;
        try { outputSchema = structuredOutputSchemaFor(req.schema); }
        catch (error) { return failed(finish, req.schemaName, model, 'invalid_output', describe(error), null); }

        const client = await connect();
        const stored = await safeGet(store, req.sessionKey);
        if (stored !== null) {
          try {
            const resumed = await client.request<ThreadResult>('thread/resume', resumeParams(stored, configuredModel, config.cwd, req.system));
            threadId = threadIdOf(resumed);
            modelId = modelOf(resumed, modelId);
          } catch (error) {
            if (!isStaleThreadError(error)) throw error;
            await safeInvalidate(store, req.sessionKey);
          }
        }
        if (threadId === null) {
          const fresh = await client.request<ThreadResult>('thread/start', threadParams(configuredModel, config.cwd, req.sessionKey === null, req.system));
          threadId = threadIdOf(fresh);
          modelId = modelOf(fresh, modelId);
          await safeSet(store, req.sessionKey, threadId);
        }

        const prompt = req.prompt;
        const outcome = await startAndAwaitTurn(client, {
          threadId,
          input: [{ type: 'text', text: prompt }],
          outputSchema,
          approvalPolicy: 'never',
          sandboxPolicy: { type: 'readOnly', access: { type: 'restricted', includePlatformDefaults: true, readableRoots: [] } },
        }, timeoutMs);
        if (outcome.error !== null) return failed(finish, req.schemaName, modelId, classifyError(outcome.error), describe(outcome.error), threadId, outcome.text, outcome.tokens);

        const extraction = extractJsonObject(outcome.text, (value) => parseAgainst(req.schema, value).ok);
        if (!extraction.ok) return failed(finish, req.schemaName, modelId, 'invalid_output', extraction.reason, threadId, outcome.text, outcome.tokens);
        const parsed = parseAgainst(req.schema, extraction.value);
        if (!parsed.ok) {
          return finish({ output: null, raw: outcome.text, validation: validationFailed(req.schemaName, parsed.issues), modelId, tokens: outcome.tokens, claudeSessionId: threadId });
        }
        return finish({ output: parsed.value, raw: outcome.text, validation: validationOk(req.schemaName, false), modelId, tokens: outcome.tokens, claudeSessionId: threadId });
      } catch (error) {
        return failed(finish, req.schemaName, modelId, classifyError(error), describe(error), threadId);
      } finally {
        release?.();
      }
    },
  };
}

function threadParams(model: string | undefined, cwd: string | undefined, ephemeral: boolean, developerInstructions: string): Record<string, unknown> {
  const params: Record<string, unknown> = {
    approvalPolicy: 'never', sandbox: 'read-only', serviceName: 'frontier_capital', ephemeral, developerInstructions,
    dynamicTools: [], environments: [],
    config: {
      web_search: 'disabled',
      project_doc_max_bytes: 0,
      features: { shell_tool: false, unified_exec: false, multi_agent: false, memories: false, apps: false },
      forced_login_method: 'chatgpt',
      agents: { enabled: false },
      tools: { view_image: false },
      apps: { _default: { enabled: false } },
      mcp_servers: {},
    },
  };
  if (model !== undefined) params['model'] = model;
  if (cwd !== undefined) params['cwd'] = cwd;
  return params;
}

function resumeParams(threadId: string, model: string | undefined, cwd: string | undefined, developerInstructions: string): Record<string, unknown> {
  const params = threadParams(model, cwd, false, developerInstructions);
  delete params['ephemeral'];
  delete params['dynamicTools'];
  delete params['environments'];
  params['threadId'] = threadId;
  return params;
}

async function startAndAwaitTurn(client: CodexRpcClient, params: Record<string, unknown>, timeoutMs: number): Promise<TurnOutcome> {
  const threadId = params['threadId'];
  if (typeof threadId !== 'string') throw new CodexProtocolError('turn/start needs threadId');
  const buffered: Parameters<Parameters<CodexRpcClient['onNotification']>[0]>[0][] = [];
  let consume: ((notification: (typeof buffered)[number]) => void) | null = null;
  const unsubscribeBuffer = client.onNotification((notification) => {
    const eventThread = isRecord(notification.params) ? notification.params['threadId'] : undefined;
    if (eventThread !== threadId) return;
    if (consume === null) {
      if (buffered.length >= 1024) { client.stop(); return; }
      buffered.push(notification);
    }
    else consume(notification);
  });
  try {
    let turn: TurnResult;
    try { turn = await client.request<TurnResult>('turn/start', params); }
    catch (error) { client.stop(); throw error; }
    const turnId = turnIdOf(turn);
    return await awaitTurn(client, threadId, turnId, timeoutMs, buffered, (handler) => { consume = handler; });
  } finally {
    unsubscribeBuffer();
  }
}

function awaitTurn(client: CodexRpcClient, threadId: string, turnId: string, timeoutMs: number, buffered: readonly Parameters<Parameters<CodexRpcClient['onNotification']>[0]>[0][], install: (handler: (notification: Parameters<Parameters<CodexRpcClient['onNotification']>[0]>[0]) => void) => void): Promise<TurnOutcome> {
  return new Promise((resolve) => {
    let text = '';
    let tokens: LlmTokenUsage | null = null;
    let settled = false;
    const done = (error: Error | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      resolve({ text, error, tokens });
    };
    const consume = ({ method, params }: Parameters<Parameters<CodexRpcClient['onNotification']>[0]>[0]) => {
      if (!isRecord(params) || params['threadId'] !== threadId) return;
      if (method !== 'turn/completed' && params['turnId'] !== turnId) return;
      if (method === 'item/completed' && isRecord(params)) {
        const item = params['item'];
        if (isRecord(item) && item['type'] === 'agentMessage' && typeof item['text'] === 'string') text = item['text'];
      }
      if (method === 'thread/tokenUsage/updated' && isRecord(params)) tokens = tokenUsageOf(params) ?? tokens;
      if (method === 'turn/completed' && isRecord(params)) {
        const turn = params['turn'];
        if (!isRecord(turn) || turn['id'] !== turnId) return;
        if (turn['status'] === 'completed') done(null);
        else done(new CodexProtocolError(turnError(turn)));
      }
    };
    const timer = setTimeout(() => {
      void client.request('turn/interrupt', { threadId, turnId }).catch(() => undefined);
      done(new CodexProtocolError(`turn/start timed out after ${timeoutMs}ms`));
      client.stop();
    }, timeoutMs);
    let unsubscribeClose = () => {};
    const unsubscribe = () => { unsubscribeClose(); };
    unsubscribeClose = client.onClose((error) => done(error));
    install(consume);
    for (const notification of buffered) consume(notification);
  });
}

function threadIdOf(value: ThreadResult): string {
  if (typeof value?.thread?.id !== 'string') throw new CodexProtocolError('thread response did not contain thread.id');
  return value.thread.id;
}
function modelOf(value: ThreadResult, fallback: string): string { return typeof value?.model === 'string' ? value.model : fallback; }
function turnIdOf(value: TurnResult): string {
  if (typeof value?.turn?.id !== 'string') throw new CodexProtocolError('turn response did not contain turn.id');
  return value.turn.id;
}
function turnError(turn: Record<string, unknown>): string {
  const error = turn['error'];
  return isRecord(error) && typeof error['message'] === 'string' ? error['message'] : `Codex turn ${String(turn['status'])}`;
}

function failed<T>(finish: (partial: Omit<LlmCompletion<T>, 'latencyMs'>) => LlmCompletion<T>, schemaName: string, model: string, reason: LlmFailureReason, detail: string, threadId: string | null, raw = '', tokens: LlmTokenUsage | null = null): LlmCompletion<T> {
  return finish({ output: null, raw, validation: validationFailed(schemaName, [taggedIssue(reason, detail)]), modelId: model, tokens, claudeSessionId: threadId });
}

function tokenUsageOf(params: Record<string, unknown>): LlmTokenUsage | null {
  const envelope = params['tokenUsage'];
  const usage = isRecord(envelope) && isRecord(envelope['last']) ? envelope['last'] : null;
  if (usage === null) return null;
  const input = usage['inputTokens'] ?? usage['input_tokens'];
  const output = usage['outputTokens'] ?? usage['output_tokens'];
  return typeof input === 'number' && typeof output === 'number' ? { input, output } : null;
}

function isStaleThreadError(error: unknown): boolean {
  if (!(error instanceof CodexProtocolError)) return false;
  const text = error.message.toLowerCase();
  // No stable app-server error code is currently specified for a missing
  // rollout. Stay deliberately narrow so auth, limits and outages never erase
  // a valid continuity handle.
  return text.includes('thread not found') || text.includes('thread does not exist') || text.includes('rollout not found');
}

function classifyError(error: unknown): LlmFailureReason {
  const text = describe(error).toLowerCase();
  if (text.includes('timeout') || text.includes('timed out') || text.includes('aborted')) return 'timeout';
  if (text.includes('rate limit') || text.includes('usage limit') || text.includes('429')) return 'rate_limited';
  if (text.includes('unauthorized') || text.includes('authentication') || text.includes('not logged in')) return 'disabled';
  return 'api_error';
}

function ambientEnv(): Readonly<Record<string, string | undefined>> {
  const holder = globalThis as { process?: { env?: Record<string, string | undefined> } };
  return holder.process?.env ?? {};
}
function codexArgs(): readonly string[] { return ['app-server', '-c', 'forced_login_method="chatgpt"']; }

export async function assertIsolatedCodexHome(codexHome: string | undefined): Promise<void> {
  if (codexHome === undefined || codexHome.trim().length === 0) {
    throw new Error('CODEX_HOME must identify a dedicated Frontier Capital Codex home');
  }
  for (const relative of ['config.toml', 'plugins', 'AGENTS.md']) {
    try {
      await access(`${codexHome}/${relative}`);
      throw new Error(`dedicated CODEX_HOME must not contain external config: ${relative}`);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('dedicated CODEX_HOME')) throw error;
      if (!isRecord(error) || error['code'] !== 'ENOENT') throw error;
    }
  }
  try {
    const skillChildren = await readdir(`${codexHome}/skills`);
    const custom = skillChildren.filter((name) => name !== '.system');
    if (custom.length > 0) throw new Error(`dedicated CODEX_HOME must not contain custom skills: ${custom.join(', ')}`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('dedicated CODEX_HOME')) throw error;
    if (!isRecord(error) || error['code'] !== 'ENOENT') throw error;
  }
}
const CODEX_ENV_ALLOWLIST = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY'] as const;
function codexProcessEnv(env: Readonly<Record<string, string | undefined>>, codexHome: string | undefined): Readonly<Record<string, string | undefined>> {
  const safe: Record<string, string | undefined> = {};
  for (const key of CODEX_ENV_ALLOWLIST) if (env[key] !== undefined) safe[key] = env[key];
  if (codexHome !== undefined) safe['CODEX_HOME'] = codexHome;
  return safe;
}
function describe(error: unknown): string { return error instanceof Error ? `${error.name}: ${error.message}` : String(error); }
function compact(value: Record<string, unknown>): Record<string, unknown> { return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)); }
async function safeGet(store: LlmSessionStore | undefined, key: string | null): Promise<string | null> {
  if (store === undefined || key === null) return null;
  // Starting a fresh persistent conversation during a storage outage would
  // silently fork memory. Let the outer transport boundary report a fallback.
  return store.get(key);
}
async function safeSet(store: LlmSessionStore | undefined, key: string | null, value: string): Promise<void> { if (store === undefined || key === null) return; await store.set(key, value); }
async function safeInvalidate(store: LlmSessionStore | undefined, key: string | null): Promise<void> { if (store?.invalidate === undefined || key === null) return; await store.invalidate(key); }

function createKeyLocks(): { acquire(key: string): Promise<() => void> } {
  const tails = new Map<string, Promise<void>>();
  return { async acquire(key) {
    const previous = tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => gate);
    tails.set(key, tail);
    await previous;
    return () => { release(); if (tails.get(key) === tail) tails.delete(key); };
  } };
}
