import { spawn as nodeSpawn } from 'node:child_process';

export interface CodexAppServerProcess {
  readonly stdout: AsyncIterable<string | Uint8Array>;
  write(line: string): void;
  kill(): void;
  readonly exited: Promise<{ readonly code: number | null; readonly signal: string | null }>;
}

export type CodexAppServerSpawn = (params: {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}) => CodexAppServerProcess;

export interface CodexRpcError {
  readonly code?: number;
  readonly message: string;
  readonly data?: unknown;
}

export interface CodexNotification {
  readonly method: string;
  readonly params?: unknown;
}

type RpcResponse = { readonly id: number; readonly result?: unknown; readonly error?: CodexRpcError };

export class CodexProtocolError extends Error {
  readonly rpcError: CodexRpcError | null;
  constructor(message: string, rpcError: CodexRpcError | null = null) {
    super(message);
    this.name = 'CodexProtocolError';
    this.rpcError = rpcError;
  }
}

export class CodexRpcClient {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  private readonly listeners = new Set<(notification: CodexNotification) => void>();
  private readonly closeListeners = new Set<(error: Error) => void>();
  private closed: Error | null = null;

  constructor(private readonly process: CodexAppServerProcess, private readonly timeoutMs: number) {
    void this.readLoop();
    void process.exited.then(
      ({ code, signal }) => this.close(new CodexProtocolError(`codex app-server exited (code ${String(code)}, signal ${String(signal)})`)),
      (error) => this.close(new CodexProtocolError(`could not start codex app-server: ${describe(error)}`)),
    );
  }

  sendNotification(method: string, params: unknown = {}): void {
    this.ensureOpen();
    this.process.write(`${JSON.stringify({ method, params })}\n`);
  }

  request<T>(method: string, params: unknown = {}): Promise<T> {
    try {
      this.ensureOpen();
    } catch (error) {
      return Promise.reject(error);
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CodexProtocolError(`${method} timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject, timer });
      try {
        this.process.write(`${JSON.stringify({ method, id, params })}\n`);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  onNotification(listener: (notification: CodexNotification) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onClose(listener: (error: Error) => void): () => void {
    if (this.closed !== null) {
      listener(this.closed);
      return () => {};
    }
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  stop(): void {
    this.close(new CodexProtocolError('codex app-server client stopped'));
    this.process.kill();
  }

  private async readLoop(): Promise<void> {
    let buffer = '';
    const decoder = new TextDecoder();
    try {
      for await (const chunk of this.process.stdout) {
        buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
        if (buffer.length > 8 * 1024 * 1024) throw new CodexProtocolError('codex app-server JSONL frame exceeded 8 MiB');
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) this.consume(line);
      }
      buffer += decoder.decode();
      if (buffer.trim().length > 0) this.consume(buffer);
    } catch (error) {
      this.close(new CodexProtocolError(`could not read codex app-server output: ${describe(error)}`));
    }
  }

  private consume(line: string): void {
    if (line.trim().length === 0) return;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      this.close(new CodexProtocolError('codex app-server emitted invalid JSON'));
      return;
    }
    if (!isRecord(message)) return;
    if ((typeof message['id'] === 'number' || typeof message['id'] === 'string') && typeof message['method'] === 'string') {
      this.denyServerRequest(message['id'], message['method']);
      return;
    }
    if (typeof message['id'] === 'number') {
      const response = message as RpcResponse;
      const waiter = this.pending.get(response.id);
      if (waiter === undefined) return;
      clearTimeout(waiter.timer);
      this.pending.delete(response.id);
      if (response.error !== undefined) waiter.reject(new CodexProtocolError(response.error.message, response.error));
      else waiter.resolve(response.result);
      return;
    }
    if (typeof message['method'] === 'string') {
      const notification = message as unknown as CodexNotification;
      for (const listener of this.listeners) listener(notification);
    }
  }

  private denyServerRequest(id: number | string, method: string): void {
    const result = method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval'
      ? { decision: 'decline' }
      : method === 'item/permissions/requestApproval'
        ? { permissions: {}, scope: 'turn' }
        : null;
    if (result !== null) this.process.write(`${JSON.stringify({ id, result })}\n`);
    else this.process.write(`${JSON.stringify({ id, error: { code: -32601, message: `Client refuses server request ${method}` } })}\n`);
  }

  private ensureOpen(): void {
    if (this.closed !== null) throw this.closed;
  }

  private close(error: Error): void {
    if (this.closed !== null) return;
    this.closed = error;
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.pending.clear();
    for (const listener of this.closeListeners) listener(error);
    this.closeListeners.clear();
  }
}

export const spawnCodexAppServer: CodexAppServerSpawn = ({ command, args, cwd, env }) => {
  const child = nodeSpawn(command, [...args], { cwd, env: definedEnv(env) as NodeJS.ProcessEnv, stdio: 'pipe' });
  if (child.stdin === null || child.stdout === null) throw new Error('codex app-server stdio was not piped');
  // Never retain logs, but keep draining the pipe so a noisy long-lived server
  // cannot deadlock on its stderr buffer.
  child.stderr?.resume();
  child.stdin.on('error', () => { /* process.exited closes pending RPCs */ });
  return {
    stdout: child.stdout,
    write(line: string): void { child.stdin?.write(line); },
    kill(): void { child.kill(); },
    exited: new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve({ code, signal }));
    }),
  };
};

function definedEnv(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined));
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
