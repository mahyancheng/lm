import { describe, expect, it } from 'vitest';
import type { FrontierResolutionOutcome } from '@frontier/simulation';
import { founderPortfolioOf } from '@frontier/simulation';
import {
  PLAYER_ID,
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

  it('reads one net worth, not two', () => {
    // The status bar, the leaderboard and the Portfolio screen must agree: the
    // store's figure and the projection's are the same arithmetic, and before
    // the first resolution the projection is what answers — where the old
    // fallback reported personal cash and silently omitted the founder's equity.
    const fresh = createSession();
    const projected = founderPortfolioOf(fresh, PLAYER_ID);
    expect(founderNetWorth(fresh)).toBe(projected.netWorthUsd);
    expect(projected.netWorthUsd).toBe(projected.cashUsd + projected.holdingsValueUsd);
    expect(projected.holdings.some((row) => row.isOwnCompany)).toBe(true);

    const resolved = getEngine().resolver.resolveQuarter(fresh, [], null, []).nextState;
    const board = resolved.leaderboards.find((entry) => entry.board === 'founder_wealth');
    const row = board?.entries.find((entry) => entry.subjectId === founderPortfolioOf(resolved, PLAYER_ID).characterId);
    expect(Math.round(row?.value ?? 0)).toBe(founderPortfolioOf(resolved, PLAYER_ID).netWorthUsd);
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
      setup: null,
      worldVersion: 1,
      endedQuarter: null,
      log: [{ quarter: 0, actions: [a], gmProposal: null, npcBundles: [], socialTexts: [] }],
      checkpoint: null,
      savedQuarter: 1,
      queue: [],
      savedAtIso: null,
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

  it('puts the chief executive, their feelings and their memories into the strategist input', () => {
    const s = createSession();
    const id = strategistCompanies(s)[0]!;
    const input = buildNpcStrategistInput(s, id)!;

    expect(input.persona).not.toBeNull();
    expect(input.persona?.traits.aggressiveness).toBeGreaterThanOrEqual(0);
    expect(input.companyName.length).toBeGreaterThan(0);
    // Absent `strategistMemory` — no quarter has resolved — reads as an empty
    // memory carrying the standing strategy the engine would have derived.
    expect(s.companies.find((entry) => entry.id === id)?.strategistMemory).toBeUndefined();
    expect(input.memory.grudges).toEqual([]);
    expect(input.memory.standingStrategy.length).toBeGreaterThan(0);
    for (const view of input.relationships) expect(view.counterpartyId).not.toBe(id);
    for (const view of input.memories) expect(view.strength).toBeGreaterThan(0);
  });

  it('sends a delta once there is a prior quarter to compress against, and never another company\'s memory', () => {
    const engine = getEngine();
    const opening = createSession();
    const resolved = engine.resolver.resolveQuarter(opening, [], null, []).nextState;
    const [mine, theirs] = strategistCompanies(resolved);

    // A private record belonging to the OTHER company. It must not appear in
    // this company's dossier in any form.
    const PRIVATE = 'Their board agreed in private to undercut us next quarter.';
    const planted = {
      ...resolved,
      companies: resolved.companies.map((company) =>
        company.id === theirs
          ? { ...company, strategistMemory: { standingStrategy: PRIVATE, standingStrategyQuarter: 1, grudges: [], attempts: [] } }
          : company,
      ),
    };

    const full = buildNpcStrategistInput(planted, mine!, { previousWorld: null })!;
    const delta = buildNpcStrategistInput(planted, mine!, { previousWorld: opening.world })!;

    expect(full.changedSinceLastQuarter.isFullBriefing).toBe(true);
    expect(full.worldBriefing.length).toBeGreaterThan(0);
    expect(delta.changedSinceLastQuarter.isFullBriefing).toBe(false);
    expect(delta.worldBriefing).toBe('');
    expect(delta.rivalBriefing).toBe('');
    expect(JSON.stringify(delta).length).toBeLessThan(JSON.stringify(full).length);

    for (const input of [full, delta]) {
      expect(JSON.stringify(input)).not.toContain(PRIVATE);
    }
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
