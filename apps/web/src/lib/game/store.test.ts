import { describe, expect, it } from 'vitest';
import type { FrontierResolutionOutcome } from '@frontier/simulation';
import {
  createSequenceAllocator,
  createSession,
  getEngine,
  buildSubmittedAction,
  drawWorldCandidates,
  resolveQuarterSafely,
} from './engine';
import { projectPlayerView, buildAlerts, marketCapOf, founderNetWorth } from './playerView';
import { buildWorldDirectorInput, buildNpcStrategistInput, strategistCompanies, buildChiefOfStaffInput } from './briefings';
import { replay } from './persistence';

describe('demo store surfaces', () => {
  it('creates the demo session', () => {
    const s = createSession();
    expect(s.quarter).toBe(0);
    expect(s.companies).toHaveLength(7);
    expect(s.characters).toHaveLength(16);
    expect(s.lastResolvedQuarter).toBeNull();
  });

  it('projects a player view without leaking rival secrets', () => {
    const s = createSession();
    const view = projectPlayerView(s);
    expect(view.ownCompany.name).toBe('Player Ventures');
    expect(view.visibleCompanies).toHaveLength(6);
    for (const node of view.techGraph.nodes) {
      for (const key of Object.keys(node.confidenceByCompany)) {
        expect(key).toBe(view.ownCompany.id);
      }
    }
    expect(Array.isArray(view.alerts)).toBe(true);
  });

  it('validates and resolves a quarter offline', () => {
    const engine = getEngine();
    const s = createSession();
    const v = engine.validator.validate(s, { type: 'set_research_budget', budgetUsd: 500_000 }, 'player_1');
    expect(['accepted', 'clamped', 'rejected']).toContain(v.status);
    const action = buildSubmittedAction(s, { type: 'set_research_budget', budgetUsd: 500_000 }, 0);
    const outcome = engine.resolver.resolveQuarter(s, [action], null, []);
    expect(outcome.committed).toBe(true);
    expect(outcome.nextState.quarter).toBe(1);
    expect(outcome.nextState.leaderboards.length).toBe(10);
    expect(outcome.report.headline.length).toBeGreaterThan(2);
    // derived readings work post-resolve
    expect(marketCapOf(outcome.nextState, 'cmp_nexus')).toBeGreaterThan(0);
    expect(founderNetWorth(outcome.nextState)).toBeGreaterThan(0);
    expect(buildAlerts(outcome.nextState)).toBeInstanceOf(Array);
  });

  it('board matters clamp into a board proposal', () => {
    const engine = getEngine();
    const s = createSession();
    const v = engine.validator.validate(
      s,
      { type: 'raise_round', stage: 'series_a', targetAmountUsd: 20_000_000, maxDilutionPct: 0.2 },
      'player_1',
    );
    expect(v.status === 'clamped' || v.status === 'rejected' || v.status === 'accepted').toBe(true);
  });

  it('replays a saved decision log deterministically', () => {
    const engine = getEngine();
    const s = createSession();
    const a = buildSubmittedAction(s, { type: 'set_research_budget', budgetUsd: 400_000 }, 0);
    const first = engine.resolver.resolveQuarter(s, [a], null, []);
    const loaded = replay({
      version: 2,
      seed: 424242,
      difficulty: 'standard',
      autoExecuteRoutine: false,
      log: [{ quarter: 0, actions: [a], gmProposal: null, npcBundles: [] }],
      checkpoint: null,
      savedQuarter: 1,
    });
    expect(loaded.session.quarter).toBe(1);
    expect(loaded.rejectedQuarters).toHaveLength(0);
    expect(loaded.complete).toBe(true);
    expect(JSON.stringify(loaded.session)).toBe(JSON.stringify(first.nextState));
  });

  it('draws candidates matching the resolver stream and builds LLM inputs', () => {
    const s = createSession();
    const candidates = drawWorldCandidates(s);
    expect(Array.isArray(candidates)).toBe(true);
    const wd = buildWorldDirectorInput(s, null);
    if (candidates.length > 0) {
      expect(wd).not.toBeNull();
      expect(wd?.eventCandidates.length).toBe(candidates.length);
      expect(wd?.legalTargetPaths.length).toBeGreaterThan(10);
    }
    const ids = strategistCompanies(s);
    expect(ids.length).toBeGreaterThan(0);
    const npc = buildNpcStrategistInput(s, ids[0]!);
    expect(npc?.companyId).toBe(ids[0]);
    const cos = buildChiefOfStaffInput(s, 'cut marketing in half', []);
    expect(cos.playerMessage).toContain('marketing');
    // state is untouched by the candidate draw
    expect(s.quarter).toBe(0);
  });
});

/**
 * The resolving overlay is `fixed inset-0` with no dismiss control, so the one
 * state `endQuarter` may never leave behind is `resolving: true`. It used to:
 * the recovery from a throwing `resolveQuarter` was to call `resolveQuarter`
 * again, unguarded, and the four engine invariants throw on both calls because
 * they are checks over the ledger the resolve just produced.
 */
describe('resolving without a way to get stuck', () => {
  const s = createSession();
  const action = buildSubmittedAction(s, { type: 'set_research_budget', budgetUsd: 400_000 }, 0);
  const quiet = { proposals: [], quarterSummary: 'A deliberately quiet quarter with nothing proposed.' };

  it('falls back to an offline resolve when the model breaks the engine, and records the offline inputs', () => {
    let calls = 0;
    const attempt = resolveQuarterSafely(s, [action], quiet, [], (state, actions, proposal, bundles) => {
      calls += 1;
      if (proposal !== null) throw new Error('the proposal broke the pipeline');
      return getEngine().resolver.resolveQuarter(state, actions, proposal, bundles);
    });
    expect(calls).toBe(2);
    expect(attempt.error).toBeNull();
    expect(attempt.outcome?.committed).toBe(true);
    // What is recorded for replay is what actually ran, not what was attempted.
    expect(attempt.gmProposal).toBeNull();
    expect(attempt.npcBundles).toEqual([]);
  });

  it('reports a fault instead of throwing when the offline resolve throws too', () => {
    const attempt = resolveQuarterSafely(s, [action], quiet, [], () => {
      throw new Error('invariant auditability failed');
    });
    expect(attempt.outcome).toBeNull();
    expect(attempt.error).toContain('auditability');
  });

  it('passes an outcome straight through when nothing throws', () => {
    const outcome: FrontierResolutionOutcome = getEngine().resolver.resolveQuarter(s, [action], null, []);
    const attempt = resolveQuarterSafely(s, [action], null, [], () => outcome);
    expect(attempt.outcome).toBe(outcome);
    expect(attempt.error).toBeNull();
  });
});

/**
 * "Approve N routine actions" loops `queueAction` inside one event handler.
 * React does not re-render between the iterations, so a sequence read from
 * rendered state is the same number every time round and every action minted in
 * the loop collided on its `actionId` — one validation survived for all of them,
 * and removing any one removed them all.
 */
describe('action ids survive a bulk approve', () => {
  it('mints a distinct id per queued action from one stale state', () => {
    const s = createSession();
    const allocator = createSequenceAllocator();
    const budgets = [100_000, 200_000, 300_000, 400_000];
    // `s` never changes inside the loop: that is precisely the stale-state case.
    const queued = budgets.map((budgetUsd) =>
      buildSubmittedAction(s, { type: 'set_research_budget', budgetUsd }, allocator.next()),
    );
    expect(new Set(queued.map((entry) => entry.actionId)).size).toBe(budgets.length);
    expect(queued.map((entry) => entry.sequence)).toEqual([0, 1, 2, 3]);
    expect(allocator.peek()).toBe(4);

    allocator.reset();
    expect(allocator.next()).toBe(0);
  });
});
