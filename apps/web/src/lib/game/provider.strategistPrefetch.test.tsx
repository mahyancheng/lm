/**
 * The strategist-prefetch effect (provider.tsx, just above `endQuarter`)
 * never spends the prefetch budget on the throwaway default session that
 * exists for the instant before a stored save is read on mount.
 *
 * `requestNpcBundle` is mocked (same technique as `strategistPrefetch.test.ts`)
 * so this counts real calls without a network or a Claude Code subprocess.
 * Mounted for real, like `provider.test.tsx`: the bug lived in the effect's
 * interaction with React's own render/commit cycle during hydration, which a
 * unit test over `strategistPrefetch.ts` alone — already covered, and already
 * green — cannot see.
 *
 * What actually pins the regression: every call's `input.sessionId` groups
 * into exactly one session. The old code fired a first batch for
 * `initialState()`'s throwaway demo session, then aborted it and fired a
 * second batch for the loaded save's session — client-side abort only stops
 * this promise from being waited on (see `strategistPrefetch.ts`'s own doc
 * comment), so that first batch's calls still went out, and the mock still
 * recorded them. A plain "count stayed put after settling" assertion cannot
 * see this: in this harness the whole load resolves within the mount's own
 * `act()`, so by the time anything can be read both batches have already
 * fired — grouping by session catches it regardless of that timing.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { NpcActionBundle, NpcStrategistInput } from '@frontier/contracts';
import { NewGameSetupSchema } from '@frontier/contracts';
import type { GameStoreState } from './provider';

const requestNpcBundle = vi.fn();
const llmHealth = vi.fn();

vi.mock('@/lib/llm/client', () => ({
  LLM_QUARTER_BUDGET_MS: 60_000,
  LLM_STRATEGISTS_PER_QUARTER: 4,
  llmHealth: (...args: unknown[]) => llmHealth(...args),
  requestNpcBundle: (...args: unknown[]) => requestNpcBundle(...args),
  requestSocialPost: vi.fn(async () => null),
  requestWorldDirector: vi.fn(async () => null),
}));

const { createSession } = await import('./engine');
const { buildSaveFile, writeSaveFile } = await import('./persistence');
const { GameProvider, useGame } = await import('./provider');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SEED = 512_512;
const STAMP = '2031-05-06T07:08:09.000Z';

/* -------------------------------------------------------------------------- */
/*  The same fake DOM `provider.test.tsx` uses                                 */
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

function fakeDom(storage: Storage): { win: Record<string, unknown>; container: Element } {
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
  const win: Record<string, unknown> = { event: undefined, localStorage: storage, document: doc, HTMLIFrameElement: class {} };
  doc.defaultView = win;
  return { win, container: element('div') as unknown as Element };
}

const globals = globalThis as unknown as { window?: unknown };
let container: Element;
let roots: Root[] = [];

beforeEach(() => {
  requestNpcBundle.mockReset();
  // Never settles: this file only counts and inspects the calls made, not
  // what the strategist route answers.
  requestNpcBundle.mockImplementation(() => new Promise<NpcActionBundle | null>(() => undefined));
  llmHealth.mockReset();
  llmHealth.mockResolvedValue({ available: false, transportKind: 'none', model: null });
  const dom = fakeDom(fakeStorage());
  globals.window = dom.win;
  container = dom.container;
  roots = [];
});

afterEach(async () => {
  for (const root of roots) {
    await act(async () => root.unmount());
  }
  delete globals.window;
});

/* -------------------------------------------------------------------------- */

interface Captured {
  state: GameStoreState;
}

let captured: Captured | null = null;

function Probe(): null {
  captured = { state: useGame() };
  return null;
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

/** World 3: the only world this build opens a save from. */
const W3_SETUP = NewGameSetupSchema.parse({
  companyName: 'Northwind AI',
  founderName: 'Rae Fontaine',
  backgroundId: 'consumer_ai',
  worldVersion: 3,
});

function writeExistingSave(): string {
  const session = createSession({ seed: SEED, setup: W3_SETUP });
  const file = buildSaveFile({
    seed: SEED,
    difficulty: 'standard',
    autoExecuteRoutine: false,
    setup: W3_SETUP,
    log: [],
    queue: [],
    session,
    now: () => STAMP,
  });
  expect(writeSaveFile(file)).toBe(true);
  return session.sessionId;
}

describe('the strategist prefetch effect', () => {
  it('prefetches only the loaded save\'s session on a mount that hydrates a stored save — never the throwaway default session first', async () => {
    const loadedSessionId = writeExistingSave();

    captured = null;
    const root = createRoot(container);
    roots.push(root);
    await act(async () => {
      root.render(
        <GameProvider>
          <Probe />
        </GameProvider>,
      );
    });
    const state = (): GameStoreState => {
      if (captured === null) throw new Error('The probe never rendered inside <GameProvider>.');
      return captured.state;
    };
    await settle(state);

    // The loaded save is the live session once hydration settles.
    expect(state().gameStarted).toBe(true);
    expect(state().session.sessionId).toBe(loadedSessionId);

    // A couple more idle passes give any stray extra pass every chance to
    // land before the calls made are inspected.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const calls = requestNpcBundle.mock.calls as unknown as [NpcStrategistInput, ...unknown[]][];
    expect(calls.length).toBeGreaterThan(0);

    // Every call belongs to one session: the loaded one. A call for any other
    // session id — the default demo world `initialState()` starts on before a
    // save is read — is exactly the regression this test pins.
    const sessionIds = new Set(calls.map(([input]) => input.sessionId));
    expect(sessionIds).toEqual(new Set([loadedSessionId]));
  });

  it('a fresh mount with no stored save prefetches only the one session it ever has', async () => {
    // No save written: the default demo session `initialState()` starts on is
    // the only session that will ever exist for this mount, so there is
    // nothing to duplicate against — this is the control for the test above.
    captured = null;
    const root = createRoot(container);
    roots.push(root);
    await act(async () => {
      root.render(
        <GameProvider>
          <Probe />
        </GameProvider>,
      );
    });
    const state = (): GameStoreState => {
      if (captured === null) throw new Error('The probe never rendered inside <GameProvider>.');
      return captured.state;
    };
    await settle(state);

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const calls = requestNpcBundle.mock.calls as unknown as [NpcStrategistInput, ...unknown[]][];
    const sessionIds = new Set(calls.map(([input]) => input.sessionId));
    expect(sessionIds.size).toBeLessThanOrEqual(1);
    if (sessionIds.size === 1) expect(sessionIds).toEqual(new Set([state().session.sessionId]));
  });
});
