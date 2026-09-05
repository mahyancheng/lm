/**
 * The progressive-answer flow.
 *
 * A message produces two requests: the instant offline preview
 * (`/api/llm/chief-of-staff/quick`) and the real model call
 * (`/api/llm/chief-of-staff`). The preview is appended to the transcript the
 * moment it lands — marked `quick: true` — and the *same* entry is upgraded in
 * place once the model call settles, whichever way it settles: replaced with
 * the model's reply on success, left standing (with `failureReason` recorded)
 * on a genuine failure or a founder-initiated cancel.
 *
 * Mounts the real `GameProvider`: `useChiefOfStaff` reads `useSession`,
 * `useActiveCompany` and `useGame` directly, so a stub context would only be
 * exercising the stub. `fetch` is stubbed at the one door the client already
 * owns — same technique as `provider.test.tsx`'s fake DOM, extended with a
 * `sessionStorage` because the transcript module (unlike the store) persists
 * there rather than to `localStorage`. No jsdom, no testing-library: neither
 * `GameProvider` nor this hook render a single host element themselves.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ChiefOfStaffInterpretation } from '@frontier/contracts';
import { ChiefOfStaffInterpretationSchema, NewGameSetupSchema } from '@frontier/contracts';
import { GameProvider, useGame, useGameActions, type GameStoreActions, type GameStoreState } from '../../../lib/game/provider';
import { clearTranscript } from './transcript';
import { useChiefOfStaff, type ChiefOfStaffThread } from './useChiefOfStaff';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SEED = 909_090;

/* -------------------------------------------------------------------------- */
/*  A localStorage, a sessionStorage and a DOM that exist in node              */
/* -------------------------------------------------------------------------- */

function fakeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key: string) => map.get(key) ?? null,
    key: (index: number) => Array.from(map.keys())[index] ?? null,
    removeItem: (key: string) => void map.delete(key),
    setItem: (key: string, value: string) => void map.set(key, value),
  } as Storage;
}

function fakeDom(): { win: Record<string, unknown>; container: Element } {
  const doc: Record<string, unknown> = { nodeType: 9, addEventListener: () => {}, removeEventListener: () => {}, activeElement: null };
  const element = (tag: string): Record<string, unknown> => ({
    nodeType: 1,
    nodeName: tag.toUpperCase(),
    tagName: tag.toUpperCase(),
    namespaceURI: 'http://www.w3.org/1999/xhtml',
    ownerDocument: doc,
    addEventListener: () => {},
    removeEventListener: () => {},
    appendChild: (child: unknown) => child,
    removeChild: (child: unknown) => child,
    insertBefore: (child: unknown) => child,
    textContent: '',
  });
  doc.createElement = element;
  doc.createTextNode = (text: string) => ({ nodeType: 3, nodeValue: text, ownerDocument: doc });
  doc.documentElement = element('html');
  const win: Record<string, unknown> = {
    event: undefined,
    localStorage: fakeStorage(),
    sessionStorage: fakeStorage(),
    document: doc,
    HTMLIFrameElement: class {},
  };
  doc.defaultView = win;
  return { win, container: element('div') as unknown as Element };
}

const globals = globalThis as unknown as { window?: unknown };

let container: Element;
let roots: Root[] = [];
let originalFetch: typeof fetch;

beforeEach(() => {
  const dom = fakeDom();
  globals.window = dom.win;
  container = dom.container;
  roots = [];
  originalFetch = globalThis.fetch;
});

afterEach(async () => {
  for (const root of roots) {
    await act(async () => root.unmount());
  }
  globalThis.fetch = originalFetch;
  delete globals.window;
});

/* -------------------------------------------------------------------------- */
/*  Mounting the provider and the hook under test                              */
/* -------------------------------------------------------------------------- */

interface CapturedGame {
  state: GameStoreState;
  actions: GameStoreActions;
}

let capturedGame: CapturedGame | null = null;
let capturedThread: ChiefOfStaffThread | null = null;

/** Only mounted once a company exists — `useChiefOfStaff` calls `useActiveCompany`, which has nothing to read before then. */
function ThreadProbe(): null {
  capturedThread = useChiefOfStaff();
  return null;
}

function Harness(): React.JSX.Element | null {
  const state = useGame();
  const actions = useGameActions();
  capturedGame = { state, actions };
  return state.gameStarted ? <ThreadProbe /> : null;
}

async function settle(state: () => GameStoreState): Promise<void> {
  for (let pass = 0; pass < 25 && (!state().hydrated || state().loading); pass += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  expect(state().hydrated).toBe(true);
  expect(state().loading).toBe(false);
}

/** Flush `turns` microtask hops inside one `act`, so state updates scheduled deep in an async chain land before the next assertion. */
async function flush(turns = 40): Promise<void> {
  await act(async () => {
    for (let i = 0; i < turns; i += 1) await Promise.resolve();
  });
}

async function mountThread(): Promise<{ state: () => GameStoreState; actions: () => GameStoreActions; thread: () => ChiefOfStaffThread }> {
  capturedGame = null;
  capturedThread = null;
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(
      <GameProvider>
        <Harness />
      </GameProvider>,
    );
  });

  const state = (): GameStoreState => {
    if (capturedGame === null) throw new Error('The harness never rendered inside <GameProvider>.');
    return capturedGame.state;
  };
  const actions = (): GameStoreActions => {
    if (capturedGame === null) throw new Error('The harness never rendered inside <GameProvider>.');
    return capturedGame.actions;
  };
  await settle(state);

  const setup = NewGameSetupSchema.parse({ companyName: 'Northwind AI', founderName: 'Rae Fontaine', backgroundId: 'consumer_ai' });
  await act(async () => {
    actions().newGame({ seed: SEED, setup });
  });
  await flush(10);

  // The transcript module keys its in-memory store by thread key
  // (`${sessionId}:${activeCompanyId}` — STAGE 5), and the fixed `SEED` above
  // means every test in this file founds the same session and the same
  // founding company — so without this, a later test would read the previous
  // test's transcript entries. `sessionStorage` itself is fresh every test
  // (see `beforeEach`); this clears the module-level cache sitting in front
  // of it.
  clearTranscript(`${state().session.sessionId}:${state().activeCompanyId}`);

  const thread = (): ChiefOfStaffThread => {
    if (capturedThread === null) throw new Error('<ThreadProbe> never mounted — newGame did not start the session.');
    return capturedThread;
  };
  expect(state().gameStarted).toBe(true);
  return { state, actions, thread };
}

/* -------------------------------------------------------------------------- */
/*  A network of exactly two doors                                             */
/* -------------------------------------------------------------------------- */

const QUICK_ANSWER: ChiefOfStaffInterpretation = ChiefOfStaffInterpretationSchema.parse({
  mode: 'answer',
  reply: 'Offline preview: you have eleven months of runway at the current burn.',
  interpretedInstructions: [],
  summary: 'Read straight off the balance sheet — no model consulted.',
  questions: [],
  requiresConfirmation: true,
  confidence: 0,
  unsupportedRequests: [],
  lookups: [],
});

const LIVE_ANSWER: ChiefOfStaffInterpretation = ChiefOfStaffInterpretationSchema.parse({
  mode: 'answer',
  reply: 'The model says: eleven months of runway, and margin is improving quarter over quarter.',
  interpretedInstructions: [],
  summary: 'Model-authored reading of the same figures, with trend context added.',
  questions: [],
  requiresConfirmation: true,
  confidence: 0.82,
  unsupportedRequests: [],
  lookups: [],
});

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/**
 * A `fetch` that answers the quick route instantly and health with "offline",
 * and hands every call to `/api/llm/chief-of-staff` (the real, model-backed
 * route) to `liveHandler` — the one door each test actually controls.
 */
function stubFetch(liveHandler: (init: RequestInit | undefined) => Promise<Response>): void {
  const calls: string[] = [];
  globalThis.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith('/chief-of-staff/quick')) return Promise.resolve(jsonResponse({ output: QUICK_ANSWER, fallback: true, reason: 'quick_answer' }));
    if (url.endsWith('/api/llm/chief-of-staff')) return liveHandler(init);
    if (url.endsWith('/api/llm/health')) {
      return Promise.resolve(jsonResponse({ available: false, transportKind: 'none', model: null, queueDepth: 0, runningRole: null }));
    }
    return Promise.resolve(jsonResponse({ output: null, fallback: true }));
  }) as unknown as typeof fetch;
}

/* -------------------------------------------------------------------------- */

describe('useChiefOfStaff — progressive answer', () => {
  it('shows the offline preview immediately, then upgrades it to the model reply', async () => {
    const live = deferred<Response>();
    stubFetch(() => live.promise);
    const { thread } = await mountThread();

    let sendSettled = false;
    const sendPromise = thread()
      .send('How much cash have we got?')
      .then(() => {
        sendSettled = true;
      });
    await flush();

    // The preview has landed and the live call is still open — sending stays
    // true, but the founder is reading a real, arithmetic-grounded answer.
    expect(sendSettled).toBe(false);
    expect(thread().entries).toHaveLength(1);
    expect(thread().entries[0]?.quick).toBe(true);
    expect(thread().entries[0]?.fallback).toBe(true);
    expect(thread().entries[0]?.interpretation.reply).toBe(QUICK_ANSWER.reply);
    expect(thread().sending).toBe(true);
    expect(thread().cancellable).toBe(true);

    live.resolve(jsonResponse({ output: LIVE_ANSWER, fallback: false }));
    await flush();
    await sendPromise;

    // Same row, upgraded — not a second entry.
    expect(thread().entries).toHaveLength(1);
    expect(thread().entries[0]?.quick).toBe(false);
    expect(thread().entries[0]?.fallback).toBe(false);
    expect(thread().entries[0]?.interpretation.reply).toBe(LIVE_ANSWER.reply);
    expect(thread().sending).toBe(false);
    expect(thread().cancellable).toBe(false);
  });

  it('leaves the preview standing, with the reason recorded, when the live call fails outright', async () => {
    // Fails both the first attempt and its one retry — see `requestChiefOfStaff`.
    stubFetch(() => Promise.reject(new TypeError('network down')));
    const { thread } = await mountThread();

    const sendPromise = thread().send('How much cash have we got?');
    await flush();
    await sendPromise;
    await flush();

    expect(thread().entries).toHaveLength(1);
    const entry = thread().entries[0];
    expect(entry?.quick).toBe(false);
    // The preview is still what is shown — a real answer, not a blank state.
    expect(entry?.interpretation.reply).toBe(QUICK_ANSWER.reply);
    expect(entry?.fallback).toBe(true);
    expect(entry?.failureReason).toBe('network_error');
    expect(thread().sending).toBe(false);
  });

  it('keeps the preview and marks the entry cancelled when the founder cancels the live call', async () => {
    stubFetch(
      (init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
        }),
    );
    const { thread } = await mountThread();

    const sendPromise = thread().send('How much cash have we got?');
    await flush();
    expect(thread().cancellable).toBe(true);

    thread().cancel();
    await flush();
    await sendPromise;

    const entry = thread().entries[0];
    expect(entry?.interpretation.reply).toBe(QUICK_ANSWER.reply);
    expect(entry?.failureReason).toBe('aborted');
    expect(thread().sending).toBe(false);
    expect(thread().cancellable).toBe(false);
  });
});
