/**
 * The save file, and the four ways it used to lose a decision.
 *
 * 1. It recorded only the player's actions, so a quarter a live World Director
 *    or an NPC strategist contributed to replayed into a different world.
 * 2. It kept the newest forty quarters while the replay applied them from
 *    quarter zero, so past forty every recorded action was stamped with a
 *    quarter it was never replayed into and the engine's collector dropped it
 *    silently — no ledger row, no rejection, no notice.
 * 3. A partial replay was written straight back over the file, destroying every
 *    quarter after the one that failed, permanently.
 * 4. A file written by a newer build read as absent and was overwritten.
 *
 * Relative imports throughout: `apps/web` has no vitest config, so the `@/`
 * alias is a Next-only convenience and does not resolve here.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GmProposalBatch, NpcActionBundle, SessionState, SubmittedAction } from '@frontier/contracts';
import { buildSubmittedAction, createSession, getEngine } from './engine';
import {
  CHECKPOINT_INTERVAL,
  MAX_REPLAY_QUARTERS,
  SAVE_KEY,
  SAVE_VERSION,
  buildSaveFile,
  exportSave,
  importSave,
  inspectSave,
  readSaveFile,
  replay,
  replayAsync,
  writeSaveFile,
  type QuarterRecord,
  type SaveFile,
} from './persistence';

/* -------------------------------------------------------------------------- */
/*  A localStorage that exists in node                                         */
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

const globals = globalThis as unknown as { window?: { localStorage: Storage } };

beforeEach(() => {
  globals.window = { localStorage: fakeStorage() };
});

afterEach(() => {
  delete globals.window;
});

/* -------------------------------------------------------------------------- */
/*  Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

const SEED = 424242;

/** A World Director proposal that fires nothing: a legal, quiet quarter. */
const QUIET_GM: GmProposalBatch = {
  proposals: [],
  quarterSummary: 'A quiet quarter in which nothing the World Director proposed reached the ledger.',
};

/** One rival's quarter, in the shape the resolver accepts. */
function bundleFor(companyId: string): NpcActionBundle {
  return {
    companyId,
    strategySummary: 'Hold the line on price and keep spending flat while the market decides what it believes.',
    posture: 'balanced',
    actions: [{ type: 'set_research_budget', budgetUsd: 12_000_000 }],
    rationale: 'A steady quarter is the correct answer when nothing in the world has changed enough to justify a move.',
  };
}

function fileOf(log: readonly QuarterRecord[], checkpoint: SaveFile['checkpoint'] = null): SaveFile {
  return {
    version: SAVE_VERSION,
    seed: SEED,
    difficulty: 'standard',
    autoExecuteRoutine: false,
    setup: null,
    log,
    checkpoint,
    savedQuarter: (log[log.length - 1]?.quarter ?? -1) + 1,
  };
}

/* -------------------------------------------------------------------------- */

describe('a save records every input to F, not just the player half', () => {
  it('reproduces a quarter an NPC strategist contributed to', () => {
    const engine = getEngine();
    const start = createSession({ seed: SEED });
    const rival = start.companies.find((company) => company.controllerPlayerId === null);
    expect(rival).toBeDefined();

    const action = buildSubmittedAction(start, { type: 'set_research_budget', budgetUsd: 400_000 }, 0);
    const bundles = [bundleFor(rival?.id ?? '')];
    const live = engine.resolver.resolveQuarter(start, [action], QUIET_GM, bundles);
    expect(live.committed).toBe(true);

    const withAgents = replay(fileOf([{ quarter: 0, actions: [action], gmProposal: QUIET_GM, npcBundles: bundles }]));
    expect(withAgents.complete).toBe(true);
    expect(JSON.stringify(withAgents.session)).toBe(JSON.stringify(live.nextState));

    // And the old format — player actions only — really did produce a different
    // world, which is what made recording the agent inputs necessary.
    const withoutAgents = replay(fileOf([{ quarter: 0, actions: [action], gmProposal: null, npcBundles: [] }]));
    expect(JSON.stringify(withoutAgents.session)).not.toBe(JSON.stringify(live.nextState));
  });
});

describe('the replay ceiling never destroys a decision', () => {
  it(
    'checkpoints past the interval and resumes from the checkpoint, keeping the whole log',
    () => {
      const engine = getEngine();
      const quarters = CHECKPOINT_INTERVAL + 2;
      let session: SessionState = createSession({ seed: SEED });
      const log: QuarterRecord[] = [];
      let file: SaveFile | null = null;

      for (let index = 0; index < quarters; index += 1) {
        const action: SubmittedAction = buildSubmittedAction(
          session,
          { type: 'set_research_budget', budgetUsd: 400_000 + index * 1_000 },
          0,
        );
        const outcome = engine.resolver.resolveQuarter(session, [action], null, []);
        expect(outcome.committed).toBe(true);
        log.push({ quarter: session.quarter, actions: [action], gmProposal: null, npcBundles: [] });
        session = outcome.nextState;
        // Exactly what the store's persistence effect does after every resolve.
        file = buildSaveFile({
          seed: SEED,
          difficulty: 'standard',
          autoExecuteRoutine: false,
          setup: null,
          log,
          session,
          previous: file,
        });
      }

      expect(file).not.toBeNull();
      // Nothing was trimmed, and the snapshot lands on the interval.
      expect(file?.log).toHaveLength(quarters);
      expect(file?.checkpoint?.quarter).toBe(CHECKPOINT_INTERVAL);

      const loaded = replay(file as SaveFile);
      expect(loaded.complete).toBe(true);
      expect(loaded.rejectedQuarters).toHaveLength(0);
      // The bounded-work claim: two quarters replayed, not ten.
      expect(loaded.replayedFrom).toBe(CHECKPOINT_INTERVAL);
      expect(loaded.replayedCount).toBe(quarters - CHECKPOINT_INTERVAL);
      // The whole log survives the load, so a later save still holds every quarter.
      expect(loaded.log).toHaveLength(quarters);
      // And the world is the one the player left.
      expect(loaded.session.quarter).toBe(quarters);
      expect(JSON.stringify(loaded.session)).toBe(JSON.stringify(session));
    },
    120_000,
  );

  it('refuses a record whose quarter does not match the session, rather than dropping it', () => {
    const start = createSession({ seed: SEED });
    const stray = buildSubmittedAction(start, { type: 'set_research_budget', budgetUsd: 400_000 }, 0);
    // The window-drift case: an entry recorded for quarter 5 replayed into a
    // fresh session at quarter 0. The engine's collector would filter it out
    // with no ledger row at all; the loader refuses instead.
    const loaded = replay(fileOf([{ quarter: 5, actions: [{ ...stray, quarter: 5 }], gmProposal: null, npcBundles: [] }]));
    expect(loaded.complete).toBe(false);
    expect(loaded.rejectedQuarters).toEqual([5]);
    expect(loaded.session.quarter).toBe(0);
    // The log is handed back whole so the caller can preserve the file.
    expect(loaded.log).toHaveLength(1);
  });

  it('reports a partial replay so the caller can refuse to write over the file', () => {
    const start = createSession({ seed: SEED });
    const good = buildSubmittedAction(start, { type: 'set_research_budget', budgetUsd: 400_000 }, 0);
    const loaded = replay(
      fileOf([
        { quarter: 0, actions: [good], gmProposal: null, npcBundles: [] },
        // Recorded for quarter 2, so it can never be replayed into quarter 1.
        { quarter: 2, actions: [], gmProposal: null, npcBundles: [] },
      ]),
    );
    expect(loaded.complete).toBe(false);
    expect(loaded.replayedCount).toBe(1);
    expect(loaded.log).toHaveLength(2);
  });
});

describe('a replay from the seed is bounded by the ceiling', () => {
  it('caps the work and reports the load as incomplete rather than replaying forever', async () => {
    const start = createSession({ seed: SEED });
    const first = buildSubmittedAction(start, { type: 'set_research_budget', budgetUsd: 400_000 }, 0);
    // A file with no usable checkpoint and far more records than the ceiling.
    // The second record is stamped for a quarter that will never come round, so
    // the replay stops immediately — but the *plan* was already bounded.
    const log: QuarterRecord[] = [{ quarter: 0, actions: [first], gmProposal: null, npcBundles: [] }];
    for (let index = 1; index <= MAX_REPLAY_QUARTERS + 4; index += 1) {
      log.push({ quarter: index === 1 ? 500 : 500 + index, actions: [], gmProposal: null, npcBundles: [] });
    }

    const totals: number[] = [];
    const loaded = await replayAsync(fileOf(log), { onProgress: (progress) => totals.push(progress.total) });
    expect(totals[0]).toBe(MAX_REPLAY_QUARTERS);
    expect(loaded.complete).toBe(false);
    // Incomplete means read-only, so the whole file is handed back untouched.
    expect(loaded.log).toHaveLength(log.length);
  });
});

describe('a quota failure prunes only what the checkpoint already absorbed', () => {
  it('retries without the absorbed entries, and refuses outright when there is no checkpoint', () => {
    const start = createSession({ seed: SEED });
    const checkpoint = { quarter: 2, state: { ...start, quarter: 2 } };
    const log: QuarterRecord[] = [0, 1, 2, 3].map((quarter) => ({ quarter, actions: [], gmProposal: null, npcBundles: [] }));

    // A store that refuses the first write and accepts the second.
    const inner = fakeStorage();
    let refusals = 1;
    globals.window = {
      localStorage: {
        ...inner,
        getItem: (key: string) => inner.getItem(key),
        setItem: (key: string, value: string) => {
          if (refusals > 0) {
            refusals -= 1;
            throw new Error('QuotaExceededError');
          }
          inner.setItem(key, value);
        },
      } as Storage,
    };

    expect(writeSaveFile({ ...fileOf(log, checkpoint), savedQuarter: 4 })).toBe(true);
    expect(readSaveFile()?.log.map((record) => record.quarter)).toEqual([2, 3]);

    // Without a checkpoint there is nothing safe to drop, so it fails instead.
    refusals = 2;
    expect(writeSaveFile(fileOf(log))).toBe(false);
  });
});

describe('replaying without freezing the tab', () => {
  it('yields between quarters and reports progress', async () => {
    const start = createSession({ seed: SEED });
    const a = buildSubmittedAction(start, { type: 'set_research_budget', budgetUsd: 400_000 }, 0);
    const engine = getEngine();
    const first = engine.resolver.resolveQuarter(start, [a], null, []);
    const b = buildSubmittedAction(first.nextState, { type: 'set_research_budget', budgetUsd: 500_000 }, 0);

    const seen: number[] = [];
    let yields = 0;
    const loaded = await replayAsync(
      fileOf([
        { quarter: 0, actions: [a], gmProposal: null, npcBundles: [] },
        { quarter: 1, actions: [b], gmProposal: null, npcBundles: [] },
      ]),
      {
        onProgress: (progress) => seen.push(progress.quarter),
        yieldControl: async () => {
          yields += 1;
        },
      },
    );

    expect(loaded.complete).toBe(true);
    expect(seen).toEqual([0, 1]);
    expect(yields).toBe(2);
    expect(loaded.session.quarter).toBe(2);
  });
});

describe('a file this build cannot read is preserved, never overwritten', () => {
  it('reports an unknown version and refuses the write', () => {
    const future = JSON.stringify({ version: 99, seed: 1, difficulty: 'standard', log: [] });
    globals.window?.localStorage.setItem(SAVE_KEY, future);

    const inspection = inspectSave();
    expect(inspection.status).toBe('unsupported');
    expect(inspection.version).toBe(99);
    expect(inspection.file).toBeNull();
    expect(readSaveFile()).toBeNull();

    expect(writeSaveFile(fileOf([]))).toBe(false);
    expect(globals.window?.localStorage.getItem(SAVE_KEY)).toBe(future);
  });

  it('migrates a v1 file rather than discarding it', () => {
    const start = createSession({ seed: SEED });
    const a = buildSubmittedAction(start, { type: 'set_research_budget', budgetUsd: 400_000 }, 0);
    globals.window?.localStorage.setItem(
      SAVE_KEY,
      JSON.stringify({ version: 1, seed: SEED, difficulty: 'standard', actionLog: [[a]], savedQuarter: 1 }),
    );

    const file = readSaveFile();
    expect(file?.log).toHaveLength(1);
    expect(file?.log[0]?.quarter).toBe(0);
    expect(file?.log[0]?.actions).toHaveLength(1);
    expect(file?.log[0]?.gmProposal).toBeNull();
    expect(replay(file as SaveFile).complete).toBe(true);
  });

  it('records the new-game setup and rebuilds the renamed company on replay', () => {
    const setup = { companyName: 'Northwind AI', founderName: 'Rae Fontaine', backgroundId: 'consumer_ai' as const };
    const start = createSession({ seed: SEED, setup });
    const a = buildSubmittedAction(start, { type: 'set_research_budget', budgetUsd: 200_000 }, 0);
    const file = buildSaveFile({
      seed: SEED,
      difficulty: 'standard',
      autoExecuteRoutine: false,
      setup,
      log: [{ quarter: 0, actions: [a], gmProposal: null, npcBundles: [] }],
      session: getEngine().resolver.resolveQuarter(start, [a], null, []).nextState,
    });
    expect(file.version).toBe(SAVE_VERSION);
    expect(file.setup).toEqual(setup);

    const loaded = replay(file);
    expect(loaded.complete).toBe(true);
    expect(loaded.setup).toEqual(setup);
    const player = loaded.session.companies.find((company) => company.controllerPlayerId !== null);
    expect(player?.name).toBe('Northwind AI');
    expect(player?.archetype).toBe('consumer_ai');
  });

  it('reads a v2 file (no setup) as the default world', () => {
    const start = createSession({ seed: SEED });
    const a = buildSubmittedAction(start, { type: 'set_research_budget', budgetUsd: 400_000 }, 0);
    globals.window?.localStorage.setItem(
      SAVE_KEY,
      JSON.stringify({ version: 2, seed: SEED, difficulty: 'standard', log: [{ quarter: 0, actions: [a], gmProposal: null, npcBundles: [] }], checkpoint: null, savedQuarter: 1 }),
    );
    const file = readSaveFile();
    expect(file?.setup).toBeNull();
    const loaded = replay(file as SaveFile);
    expect(loaded.complete).toBe(true);
    expect(loaded.session.companies.find((company) => company.controllerPlayerId !== null)?.name).toBe('Player Ventures');
  });

  it('round-trips an export through an import', () => {
    const start = createSession({ seed: SEED });
    const a = buildSubmittedAction(start, { type: 'set_research_budget', budgetUsd: 400_000 }, 0);
    writeSaveFile(fileOf([{ quarter: 0, actions: [a], gmProposal: QUIET_GM, npcBundles: [] }]));

    const text = exportSave();
    expect(text).not.toBeNull();

    globals.window = { localStorage: fakeStorage() };
    expect(inspectSave().status).toBe('absent');

    const imported = importSave(text as string);
    expect(imported?.log).toHaveLength(1);
    expect(imported?.log[0]?.gmProposal?.quarterSummary).toBe(QUIET_GM.quarterSummary);
    expect(readSaveFile()?.log).toHaveLength(1);

    expect(importSave('not json at all')).toBeNull();
    // The rejected import left the stored file alone.
    expect(readSaveFile()?.log).toHaveLength(1);
  });
});
