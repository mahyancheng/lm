import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createInMemorySessionStore } from '../src/sessionStore';
import { assertIsolatedCodexHome, createCodexAppServerTransport } from '../src/transport/codexAppServer';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexRpcClient, type CodexAppServerProcess } from '../src/transport/codexProtocol';
import { classifyIssues } from '../src/transport/types';

const TinySchema = z.object({ a: z.number() });
const request = (sessionKey: string | null) => ({
  role: 'chief_of_staff' as const,
  system: 'You are a bounded game',
  prompt: 'Return the answer',
  schema: TinySchema,
  schemaName: 'TinySchema',
  sessionKey,
});

interface Sent { method?: string; id?: number; params?: Record<string, unknown>; result?: unknown }

function fakeProcess(options: { failResume?: string; silentInitialize?: boolean; silentTurn?: boolean; earlyCompletion?: boolean; crashOnTurn?: boolean } = {}): CodexAppServerProcess & { sent: Sent[]; killed: boolean } {
  const sent: Sent[] = [];
  const queue: string[] = [];
  let wake: (() => void) | null = null;
  let threadCounter = 0;
  let resolveExit!: (value: { code: number | null; signal: string | null }) => void;
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => { resolveExit = resolve; });
  const push = (message: unknown) => {
    queue.push(`${JSON.stringify(message)}\n`);
    wake?.(); wake = null;
  };
  const result: CodexAppServerProcess & { sent: Sent[]; killed: boolean } = {
    sent,
    killed: false,
    write(line) {
      const message = JSON.parse(line) as Sent;
      sent.push(message);
      if (message.id === undefined || message.method === undefined) return;
      if (message.method === 'initialize' && !options.silentInitialize) push({ id: message.id, result: { userAgent: 'fake' } });
      if (message.method === 'thread/start') {
        threadCounter += 1;
        push({ id: message.id, result: { thread: { id: `thread-${threadCounter}` } } });
      }
      if (message.method === 'thread/resume') {
        if (options.failResume !== undefined) push({ id: message.id, error: { code: -32000, message: options.failResume } });
        else push({ id: message.id, result: { thread: { id: message.params?.['threadId'] } } });
      }
      if (message.method === 'turn/start' && !options.silentTurn) {
        if (options.crashOnTurn) { resolveExit({ code: 1, signal: null }); return; }
        const threadId = message.params?.['threadId'];
        const turnId = `turn-${String(threadId)}`;
        const events = () => {
          push({ method: 'item/completed', params: { threadId, turnId, item: { type: 'agentMessage', id: 'item-1', text: '{"a":7}' } } });
          push({ method: 'thread/tokenUsage/updated', params: { threadId, turnId, tokenUsage: { last: { inputTokens: 11, outputTokens: 3, cachedInputTokens: 0, reasoningOutputTokens: 0, totalTokens: 14 } } } });
          push({ method: 'turn/completed', params: { threadId, turnId, turn: { id: turnId, status: 'completed', items: [], error: null } } });
        };
        if (options.earlyCompletion) events();
        push({ id: message.id, result: { turn: { id: turnId, status: 'inProgress', items: [], error: null } } });
        if (!options.earlyCompletion) queueMicrotask(events);
      }
    },
    kill() { result.killed = true; resolveExit({ code: null, signal: 'SIGTERM' }); },
    exited,
    stdout: {
      async *[Symbol.asyncIterator]() {
        while (true) {
          if (queue.length === 0) await new Promise<void>((resolve) => { wake = resolve; });
          const next = queue.shift();
          if (next !== undefined) yield next;
        }
      },
    },
  };
  return result;
}

describe('Codex app-server transport', () => {
  it('performs initialize, thread/start and turn/start over JSONL and buffers early completion events', async () => {
    const process = fakeProcess({ earlyCompletion: true });
    let childEnv: Readonly<Record<string, string | undefined>> = {};
    const transport = createCodexAppServerTransport({ spawn: (params) => { childEnv = params.env; return process; }, env: {
      PATH: '/bin', LANG: 'en_US.UTF-8', OPENAI_API_KEY: 'must-not-leak', ANTHROPIC_API_KEY: 'must-not-leak', LLM_KEY_SECRET: 'must-not-leak',
    }, timeoutMs: 100 });
    const completion = await transport.complete(request(null));

    expect(completion.output).toEqual({ a: 7 });
    expect(completion.claudeSessionId).toBe('thread-1');
    expect(completion.tokens).toEqual({ input: 11, output: 3 });
    expect(childEnv).toEqual({ PATH: '/bin', LANG: 'en_US.UTF-8' });
    expect(process.sent.map((entry) => entry.method)).toEqual(['initialize', 'initialized', 'thread/start', 'turn/start']);
    const start = process.sent.find((entry) => entry.method === 'thread/start');
    expect(start?.params?.['ephemeral']).toBe(true);
    expect(start?.params).toMatchObject({
      approvalPolicy: 'never',
      sandbox: 'read-only',
      developerInstructions: 'You are a bounded game',
      dynamicTools: [],
      environments: [],
      config: {
        web_search: 'disabled',
        project_doc_max_bytes: 0,
        forced_login_method: 'chatgpt',
        features: { shell_tool: false, unified_exec: false, multi_agent: false, memories: false, apps: false },
        agents: { enabled: false },
        tools: { view_image: false },
        apps: { _default: { enabled: false } },
        mcp_servers: {},
      },
    });
    const turn = process.sent.find((entry) => entry.method === 'turn/start');
    expect(turn?.params).toMatchObject({
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'readOnly', access: { type: 'restricted', includePlatformDefaults: true, readableRoots: [] } },
      outputSchema: { type: 'object', additionalProperties: false },
    });
    transport.close();
  });

  it('persists a thread and resumes it after the app-server process restarts', async () => {
    const store = createInMemorySessionStore();
    const firstProcess = fakeProcess();
    const first = createCodexAppServerTransport({ spawn: () => firstProcess, sessionStore: store, env: {}, timeoutMs: 100 });
    await first.complete(request('game-a:cos'));
    first.close();

    const secondProcess = fakeProcess();
    const second = createCodexAppServerTransport({ spawn: () => secondProcess, sessionStore: store, env: {}, cwd: '/isolated', timeoutMs: 100 });
    const completion = await second.complete(request('game-a:cos'));
    expect(completion.output).toEqual({ a: 7 });
    expect(secondProcess.sent.find((entry) => entry.method === 'thread/resume')?.params).toMatchObject({
      threadId: 'thread-1',
      cwd: '/isolated',
      approvalPolicy: 'never',
      sandbox: 'read-only',
      developerInstructions: 'You are a bounded game',
      config: {
        web_search: 'disabled',
        project_doc_max_bytes: 0,
        features: { shell_tool: false, unified_exec: false, multi_agent: false, memories: false, apps: false },
        agents: { enabled: false },
        mcp_servers: {},
      },
    });
    expect(secondProcess.sent.some((entry) => entry.method === 'thread/start')).toBe(false);
    second.close();
  });

  it('keeps different game conversation keys on different threads', async () => {
    const store = createInMemorySessionStore();
    const process = fakeProcess();
    const transport = createCodexAppServerTransport({ spawn: () => process, sessionStore: store, env: {}, timeoutMs: 100 });
    await transport.complete(request('game-a:seat-1'));
    await transport.complete(request('game-b:seat-1'));
    expect(store.entries()).toEqual([['game-a:seat-1', 'thread-1'], ['game-b:seat-1', 'thread-2']]);
    transport.close();
  });

  it('does not erase a saved thread when resume fails ambiguously', async () => {
    const store = createInMemorySessionStore({ conversation: 'important-thread' });
    const process = fakeProcess({ failResume: 'rate limit exceeded' });
    const transport = createCodexAppServerTransport({ spawn: () => process, sessionStore: store, env: {}, timeoutMs: 100 });
    const completion = await transport.complete(request('conversation'));
    expect(completion.output).toBeNull();
    expect(classifyIssues(completion.validation.issues)).toBe('rate_limited');
    expect(store.peek('conversation')).toBe('important-thread');
    transport.close();
  });

  it('starts fresh and replaces only an explicitly missing persisted thread', async () => {
    const store = createInMemorySessionStore({ conversation: 'gone-thread' });
    const process = fakeProcess({ failResume: 'thread not found' });
    const transport = createCodexAppServerTransport({ spawn: () => process, sessionStore: store, env: {}, timeoutMs: 100 });
    const completion = await transport.complete(request('conversation'));
    expect(completion.output).toEqual({ a: 7 });
    expect(store.peek('conversation')).toBe('thread-1');
    transport.close();
  });

  it('returns a timeout completion instead of throwing', async () => {
    const process = fakeProcess({ silentTurn: true });
    const transport = createCodexAppServerTransport({ spawn: () => process, env: {}, timeoutMs: 5 });
    const completion = await transport.complete(request(null));
    expect(completion.output).toBeNull();
    expect(classifyIssues(completion.validation.issues)).toBe('timeout');
    expect(process.killed).toBe(true);
    transport.close();
  });

  it('does not release a same-key waiter until a timed-out process is killed', async () => {
    const first = fakeProcess({ silentTurn: true });
    const second = fakeProcess();
    const processes = [first, second];
    const transport = createCodexAppServerTransport({ spawn: () => processes.shift()!, env: {}, timeoutMs: 8 });
    const one = transport.complete(request('shared-company'));
    const two = transport.complete(request('shared-company'));
    const failed = await one;
    expect(classifyIssues(failed.validation.issues)).toBe('timeout');
    expect(first.killed).toBe(true);
    expect(second.sent).toHaveLength(0);
    expect((await two).output).toEqual({ a: 7 });
    transport.close();
  });

  it('reconnects after an app-server process crashes', async () => {
    const crashed = fakeProcess({ crashOnTurn: true });
    const healthy = fakeProcess();
    const processes = [crashed, healthy];
    const transport = createCodexAppServerTransport({ spawn: () => processes.shift()!, env: {}, timeoutMs: 100 });
    expect((await transport.complete(request(null))).output).toBeNull();
    expect((await transport.complete(request(null))).output).toEqual({ a: 7 });
    expect(healthy.sent[0]?.method).toBe('initialize');
    transport.close();
  });

  it('kills an app-server whose initialize request times out before retrying', async () => {
    const stuck = fakeProcess({ silentInitialize: true });
    const healthy = fakeProcess();
    const processes = [stuck, healthy];
    const transport = createCodexAppServerTransport({ spawn: () => processes.shift()!, env: {}, timeoutMs: 8 });
    expect((await transport.complete(request(null))).output).toBeNull();
    expect(stuck.killed).toBe(true);
    expect((await transport.complete(request(null))).output).toEqual({ a: 7 });
    expect(healthy.sent[0]?.method).toBe('initialize');
    transport.close();
  });

  it('filters interleaved notifications by thread and turn', async () => {
    const process = fakeProcess();
    const transport = createCodexAppServerTransport({ spawn: () => process, env: {}, timeoutMs: 100 });
    const [a, b] = await Promise.all([transport.complete(request(null)), transport.complete(request(null))]);
    expect(a.output).toEqual({ a: 7 });
    expect(b.output).toEqual({ a: 7 });
    expect(a.claudeSessionId).not.toBe(b.claudeSessionId);
    transport.close();
  });

  it('fails instead of silently forking when the persistent store read fails', async () => {
    const process = fakeProcess();
    const transport = createCodexAppServerTransport({ spawn: () => process, env: {}, timeoutMs: 100, sessionStore: {
      async get() { throw new Error('database unavailable'); }, async set() {},
    } });
    const completion = await transport.complete(request('persistent'));
    expect(completion.output).toBeNull();
    expect(process.sent.some((entry) => entry.method === 'thread/start')).toBe(false);
    transport.close();
  });

  it('fails before inference when a fresh persistent thread cannot be recorded', async () => {
    const process = fakeProcess();
    const transport = createCodexAppServerTransport({ spawn: () => process, env: {}, timeoutMs: 100, sessionStore: {
      async get() { return null; }, async set() { throw new Error('database unavailable'); },
    } });
    const completion = await transport.complete(request('persistent'));
    expect(completion.output).toBeNull();
    expect(classifyIssues(completion.validation.issues)).toBe('api_error');
    expect(process.sent.some((entry) => entry.method === 'turn/start')).toBe(false);
    transport.close();
  });

  it('passes only allowlisted process environment values to Codex', async () => {
    const process = fakeProcess();
    let childEnv: Readonly<Record<string, string | undefined>> = {};
    const transport = createCodexAppServerTransport({
      spawn: (params) => { childEnv = params.env; return process; },
      env: { PATH: '/bin', LANG: 'C.UTF-8', SUPABASE_SERVICE_ROLE_KEY: 'secret', LLM_KEY_SECRET: 'secret', ANTHROPIC_API_KEY: 'secret', OPENAI_API_KEY: 'secret' },
      timeoutMs: 100,
    });
    await transport.complete(request(null));
    expect(childEnv).toEqual({ PATH: '/bin', LANG: 'C.UTF-8' });
    transport.close();
  });
});

describe('Codex JSONL protocol', () => {
  it('handles a listener registered after the client has already closed', async () => {
    const process = fakeProcess();
    const client = new CodexRpcClient(process, 20);
    client.stop();
    let closed = false;
    expect(() => client.onClose(() => { closed = true; })).not.toThrow();
    expect(closed).toBe(true);
  });

  it('decodes a JSON response when a multi-byte character is split across chunks', async () => {
    const encoder = new TextEncoder();
    const bytes = encoder.encode('{"id":1,"result":{"name":"José"}}\n');
    const split = bytes.indexOf(0xc3) + 1;
    const process: CodexAppServerProcess = {
      write() {}, kill() {}, exited: new Promise(() => undefined),
      stdout: { async *[Symbol.asyncIterator]() { yield bytes.slice(0, split); yield bytes.slice(split); } },
    };
    const client = new CodexRpcClient(process, 100);
    await expect(client.request<{ name: string }>('test')).resolves.toEqual({ name: 'José' });
  });
});


describe('dedicated Codex home isolation', () => {
  it('allows CLI-owned system skills but rejects custom skill siblings', async () => {
    const home = await mkdtemp(join(tmpdir(), 'frontier-codex-home-'));
    try {
      await mkdir(join(home, 'skills', '.system'), { recursive: true });
      await expect(assertIsolatedCodexHome(home)).resolves.toBeUndefined();
      await mkdir(join(home, 'skills', 'custom-skill'));
      await expect(assertIsolatedCodexHome(home)).rejects.toThrow('custom skills: custom-skill');
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
