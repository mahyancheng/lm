/**
 * The store, mounted for real.
 *
 * The founding-save rule, the queue restore and the slot flow live in
 * `GameProvider`'s callbacks and effects, so testing them means rendering the
 * provider — replicating its call sequence in a test would keep passing after
 * the provider itself regressed.
 *
 * There is no jsdom here and none is needed: the provider renders no host
 * elements, so react-dom touches only the container it is handed, the document
 * it delegates events on, and the window it reads `event` and the active
 * element from. The fake DOM below answers exactly those questions and nothing
 * more, so a new dependency on a real DOM fails loudly instead of passing
 * vacuously.
 *
 * Determinism: fixed seed, an injected clock behind every stamp an assertion
 * could read, fake timers wherever the debounced autosave is in play, and a
 * settle loop bounded by store state, never by wall time.
 *
 * Relative imports throughout: the `@/` alias is wired up in vitest.config.mts
 * only so the modules under test can resolve their own imports; test files
 * keep to relative paths.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { NewGameSetup } from '@frontier/contracts';
import { NewGameSetupSchema } from '@frontier/contracts';
import { buildSubmittedAction, createSession } from './engine';
import { SAVE_KEY, SAVE_VERSION, SLOT_KEYS, buildSaveFile, writeSaveFile } from './persistence';
import { GameProvider, useGame, useGameActions, type GameStoreActions, type GameStoreState } from './provider';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SEED = 424242;

/** A stamp no real clock produces mid-test, so it can only appear via the injected `now`. */
const STAMP = '2030-01-02T03:04:05.000Z';

/* -------------------------------------------------------------------------- */
/*  A localStorage and a DOM that exist in node                                */
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
  const doc: Record<string, unknown> = {
    nodeType: 9,
    addEventListener: () => {},
    removeEventListener: () => {},
    activeElement: null,
  };
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
    localStorage: storage,
    document: doc,
    HTMLIFrameElement: class {},
  };
  doc.defaultView = win;
  return { win, container: element('div') as unknown as Element };
}

const globals = globalThis as unknown as { window?: unknown };

let container: Element;
let roots: Root[] = [];

beforeEach(() => {
  const dom = fakeDom(fakeStorage());
  globals.window = dom.win;
  container = dom.container;
  roots = [];
});

afterEach(async () => {
  for (const root of roots) {
    await act(async () => root.unmount());
  }
  vi.useRealTimers();
  delete globals.window;
});

function storedRaw(key: string): string | null {
  return (globals.window as { localStorage: Storage }).localStorage.getItem(key);
}

function storedJson(key: string): Record<string, unknown> {
  const raw = storedRaw(key);
  expect(raw).not.toBeNull();
  return JSON.parse(raw as string) as Record<string, unknown>;
}

/* -------------------------------------------------------------------------- */
/*  Mounting the provider                                                      */
/* -------------------------------------------------------------------------- */

interface Captured {
  state: GameStoreState;
  actions: GameStoreActions;
}

let captured: Captured | null = null;

function Probe(): null {
  captured = { state: useGame(), actions: useGameActions() };
  return null;
}

/**
 * Drain the mount/load pipeline until hydration lands. Bounded by store state:
 * each pass yields one macrotask so `replayAsync`'s between-quarter awaits and
 * the load's dispatches can run inside `act`, and the loop ends the moment the
 * store says it is ready — never after a fixed wall-clock wait.
 */
async function settle(state: () => GameStoreState): Promise<void> {
  for (let pass = 0; pass < 25 && (!state().hydrated || state().loading); pass += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  expect(state().hydrated).toBe(true);
  expect(state().loading).toBe(false);
}

async function mountGame(): Promise<{ state: () => GameStoreState; actions: () => GameStoreActions }> {
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
  const actions = (): GameStoreActions => {
    if (captured === null) throw new Error('The probe never rendered inside <GameProvider>.');
    return captured.actions;
  };
  await settle(state);
  return { state, actions };
}

function playerCompanyName(state: GameStoreState): string | undefined {
  return state.session.companies.find((company) => company.controllerPlayerId !== null)?.name;
}

/* -------------------------------------------------------------------------- */

describe('newGame founds a company that survives a refresh', () => {
  it('writes the founding save synchronously, before any quarter resolves', async () => {
    const { state, actions } = await mountGame();
    expect(storedRaw(SAVE_KEY)).toBeNull();
    expect(state().gameStarted).toBe(false);

    const setup = NewGameSetupSchema.parse({ companyName: 'Northwind AI', founderName: 'Rae Fontaine', backgroundId: 'consumer_ai' });
    let rawAfterCall: string | null = null;
    await act(async () => {
      actions().newGame({ seed: SEED, setup });
      // Read in the same tick as the call: the debounced effect cannot have
      // fired yet, so anything stored was written by `newGame` itself.
      rawAfterCall = storedRaw(SAVE_KEY);
    });

    const parsed = JSON.parse(rawAfterCall!) as Record<string, unknown>;
    expect(parsed.version).toBe(SAVE_VERSION);
    expect(parsed.log).toEqual([]);
    expect(parsed.queue).toEqual([]);
    expect(parsed.setup).toEqual(setup);
    expect(parsed.savedQuarter).toBe(0);

    expect(state().gameStarted).toBe(true);
    expect(state().session.quarter).toBe(0);
    expect(playerCompanyName(state())).toBe('Northwind AI');
  });

  it('carries the setup\'s world version into the session, the settings and the save', async () => {
    const { state, actions } = await mountGame();

    const setup = NewGameSetupSchema.parse({
      companyName: 'Kestrel Dynamics',
      founderName: 'Rae Fontaine',
      backgroundId: 'humanoid_lab',
      sector: 'robotics',
      region: 'east_asia',
      worldVersion: 2,
    });
    let rawAfterCall: string | null = null;
    await act(async () => {
      actions().newGame({ seed: SEED, setup });
      rawAfterCall = storedRaw(SAVE_KEY);
    });

    // The setup is what the scenario dispatcher reads, so the built world is
    // the one the chat chose — not the frozen demo the store started on.
    expect(state().settings.worldVersion).toBe(2);
    expect(state().session.config.worldVersion).toBe(2);
    expect(playerCompanyName(state())).toBe('Kestrel Dynamics');

    const parsed = JSON.parse(rawAfterCall!) as Record<string, unknown>;
    expect(parsed.worldVersion).toBe(2);
    expect((parsed.setup as { worldVersion: number }).worldVersion).toBe(2);
  });

  it('founds the frozen world when no setup is given, and says so', async () => {
    const { state, actions } = await mountGame();
    let rawAfterCall: string | null = null;
    await act(async () => {
      actions().newGame({ seed: SEED });
      rawAfterCall = storedRaw(SAVE_KEY);
    });

    expect(state().settings.worldVersion).toBe(1);
    expect(state().session.config.worldVersion).toBe(1);
    expect((JSON.parse(rawAfterCall!) as Record<string, unknown>).worldVersion).toBe(1);
  });
});

describe('the open queue rides the autosave', () => {
  it('restores a stored queue, re-validating each entry and counting the dropped one in the notice', async () => {
    const session = createSession({ seed: SEED });
    const keepA = buildSubmittedAction(session, { type: 'set_research_budget', budgetUsd: 400_000 }, 0);
    const keepB = buildSubmittedAction(session, { type: 'set_research_budget', budgetUsd: 600_000 }, 1);
    // Parses cleanly as a SubmittedAction but fails validation on load: no
    // such seat exists, so the validator rejects it deterministically.
    const ghost = { ...buildSubmittedAction(session, { type: 'set_research_budget', budgetUsd: 1 }, 2), actorPlayerId: 'player_ghost' };
    const file = buildSaveFile({
      seed: SEED,
      difficulty: 'standard',
      autoExecuteRoutine: false,
      setup: null,
      log: [],
      queue: [keepA, keepB, ghost],
      session,
      now: () => STAMP,
    });
    expect(writeSaveFile(file)).toBe(true);

    const { state } = await mountGame();
    expect(state().gameStarted).toBe(true);
    expect(state().saveWritable).toBe(true);
    expect(state().session.quarter).toBe(0);
    expect(state().queuedActions.map((entry) => entry.actionId)).toEqual([keepA.actionId, keepB.actionId]);
    // Each survivor re-earned a validation against the replayed session; the
    // ghost never reached the queue at all.
    expect(Object.keys(state().validations).sort()).toEqual([keepA.actionId, keepB.actionId].sort());
    expect(state().nextSequence).toBe(2);
    expect(state().notice).toBe('1 queued action from the save no longer validated and was dropped.');
  });

  it('persists a queued action through the debounced autosave', async () => {
    // Fake timers from the start, so the debounce fires exactly when advanced
    // to and never as a wall-clock race.
    vi.useFakeTimers();
    const { state, actions } = await mountGame();
    await act(async () => {
      actions().newGame({ seed: SEED });
    });
    await act(async () => {
      actions().queueAction({ type: 'set_research_budget', budgetUsd: 400_000 });
    });
    expect(state().queuedActions).toHaveLength(1);
    // Queued but not yet flushed: the founding save still holds an empty queue.
    expect(storedJson(SAVE_KEY).queue).toEqual([]);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    const flushed = storedJson(SAVE_KEY) as { queue: readonly { actionId: string }[] };
    expect(flushed.queue.map((entry) => entry.actionId)).toEqual([state().queuedActions[0]!.actionId]);
  });
});

describe('manual slots through the store', () => {
  it('saves to a slot, loads it back over the autosave, and deletes it', async () => {
    const { state, actions } = await mountGame();
    const northwind = NewGameSetupSchema.parse({ companyName: 'Northwind AI', founderName: 'Rae Fontaine', backgroundId: 'consumer_ai' });
    const vantage = NewGameSetupSchema.parse({ companyName: 'Vantage Labs', founderName: 'Ida Brandt', backgroundId: 'enterprise_ai' });

    await act(async () => {
      actions().newGame({ seed: SEED, setup: northwind });
    });
    await act(async () => {
      actions().saveToSlot(1);
    });
    expect(state().notice).toBe('Saved to slot 1.');
    expect((storedJson(SLOT_KEYS[0]!) as { setup: NewGameSetup }).setup.companyName).toBe('Northwind AI');

    // Another founding takes over the autosave...
    await act(async () => {
      actions().newGame({ seed: SEED, setup: vantage });
    });
    expect(playerCompanyName(state())).toBe('Vantage Labs');
    expect((storedJson(SAVE_KEY) as { setup: NewGameSetup }).setup.companyName).toBe('Vantage Labs');

    // ...and loading the slot lands the replayed session in the store *and*
    // re-adopts the slot as the autosave, so the continued game is the one
    // that keeps persisting.
    let landed = false;
    await act(async () => {
      landed = await actions().loadFromSlot(1);
    });
    await settle(state);
    expect(landed).toBe(true);
    expect(state().session.quarter).toBe(0);
    expect(playerCompanyName(state())).toBe('Northwind AI');
    expect(state().settings.setup).toEqual(northwind);
    expect((storedJson(SAVE_KEY) as { setup: NewGameSetup }).setup.companyName).toBe('Northwind AI');

    await act(async () => {
      actions().deleteSlot(1);
    });
    expect(state().notice).toBe('Slot 1 deleted.');
    expect(storedRaw(SLOT_KEYS[0]!)).toBeNull();
  });
});
