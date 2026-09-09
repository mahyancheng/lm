import { describe, expect, it, vi } from 'vitest';
import { CodexProtocolError, CodexRpcClient, type CodexAppServerProcess } from '../src/transport/codexProtocol';

class FakeProcess implements CodexAppServerProcess {
  readonly writes: string[] = [];
  private readonly chunks: Array<string | Uint8Array> = [];
  private wake: (() => void) | null = null;
  private done = false;
  private readonly exitPromise: Promise<{ code: number | null; signal: string | null }>;
  private exitResolve!: (value: { code: number | null; signal: string | null }) => void;

  readonly stdout: AsyncIterable<string | Uint8Array> = {
    [Symbol.asyncIterator]: () => ({
      next: async (): Promise<IteratorResult<string | Uint8Array>> => {
        while (!this.done && this.chunks.length === 0) await new Promise<void>((resolve) => { this.wake = resolve; });
        const value = this.chunks.shift();
        if (value !== undefined) return { done: false, value };
        return { done: true, value: undefined } as IteratorReturnResult<undefined>;
      },
    }),
  };

  constructor() {
    this.exitPromise = new Promise((resolve) => { this.exitResolve = resolve; });
  }

  get exited(): Promise<{ code: number | null; signal: string | null }> { return this.exitPromise; }
  write(line: string): void { this.writes.push(line); }
  kill(): void { this.finish(); }
  push(chunk: string | Uint8Array): void { this.chunks.push(chunk); this.wake?.(); this.wake = null; }
  endStdout(): void { if (this.done) return; this.done = true; this.wake?.(); this.wake = null; }
  exit(): void { this.exitResolve({ code: 0, signal: null }); }
  finish(): void {
    if (this.done) return;
    this.endStdout();
    queueMicrotask(() => this.exitResolve({ code: 0, signal: null }));
  }
  response(id: number, result: unknown): void { this.push(JSON.stringify({ id, result }) + '\n'); }
}

const eventually = async (check: () => boolean): Promise<void> => {
  for (let i = 0; i < 100 && !check(); i += 1) await new Promise((resolve) => setTimeout(resolve, 1));
  expect(check()).toBe(true);
};

describe('CodexRpcClient protocol boundaries', () => {
  it('reassembles a multibyte UTF-8 response split across chunks and consumes EOF data', async () => {
    const process = new FakeProcess();
    const client = new CodexRpcClient(process, 1000);
    const pending = client.request<{ text: string }>('echo', {});
    const encoded = new TextEncoder().encode(JSON.stringify({ id: 1, result: { text: 'café' } }) + '\n');
    const split = encoded.indexOf(0xc3) + 1;
    process.push(encoded.slice(0, split));
    process.push(encoded.slice(split));
    await expect(pending).resolves.toEqual({ text: 'café' });
    client.stop();

    const eofProcess = new FakeProcess();
    const eofClient = new CodexRpcClient(eofProcess, 1000);
    const eofPending = eofClient.request('eof', {});
    eofProcess.push(JSON.stringify({ id: 1, result: 'without-newline' }));
    eofProcess.endStdout();
    await expect(eofPending).resolves.toBe('without-newline');
    eofProcess.exit();
  });

  it('rejects a pending request when the process exits, without an unhandled rejection', async () => {
    const fake = new FakeProcess();
    const client = new CodexRpcClient(fake, 1000);
    const unhandled = vi.fn();
    const pending = client.request('crash', {});
    const handler = (reason: unknown) => unhandled(reason);
    globalThis.process?.on('unhandledRejection', handler);
    fake.finish();
    await expect(pending).rejects.toBeInstanceOf(CodexProtocolError);
    await new Promise((resolve) => setTimeout(resolve, 0));
    globalThis.process?.off('unhandledRejection', handler);
    expect(unhandled).not.toHaveBeenCalled();
  });

  it('denies server requests with both numeric and string IDs', async () => {
    const process = new FakeProcess();
    const client = new CodexRpcClient(process, 1000);
    process.push(JSON.stringify({ id: 7, method: 'unknown/server/request', params: {} }) + '\n');
    process.push(JSON.stringify({ id: 's7', method: 'item/commandExecution/requestApproval', params: {} }) + '\n');
    await eventually(() => process.writes.length === 2);
    expect(JSON.parse(process.writes[0]!)).toMatchObject({ id: 7, error: { code: -32601 } });
    expect(JSON.parse(process.writes[1]!)).toMatchObject({ id: 's7', result: { decision: 'decline' } });
    client.stop();
  });

  it('invokes late onClose listeners safely and only once', async () => {
    const process = new FakeProcess();
    const client = new CodexRpcClient(process, 1000);
    const listener = vi.fn();
    client.stop();
    const unsubscribe = client.onClose(listener);
    unsubscribe();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(() => client.stop()).not.toThrow();
  });

  it('closes on malformed JSON and oversize frames', async () => {
    const malformed = new FakeProcess();
    const malformedClient = new CodexRpcClient(malformed, 1000);
    const malformedClose = vi.fn();
    malformedClient.onClose(malformedClose);
    malformed.push('{not-json}\n');
    await eventually(() => malformedClose.mock.calls.length === 1);
    expect(malformedClose.mock.calls[0]![0]).toBeInstanceOf(CodexProtocolError);

    const oversized = new FakeProcess();
    const oversizedClient = new CodexRpcClient(oversized, 1000);
    const oversizedClose = vi.fn();
    oversizedClient.onClose(oversizedClose);
    oversized.push('x'.repeat(8 * 1024 * 1024 + 1));
    await eventually(() => oversizedClose.mock.calls.length === 1);
    expect(oversizedClose.mock.calls[0]![0]).toBeInstanceOf(CodexProtocolError);
  });
});
