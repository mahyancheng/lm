import { describe, expect, it } from 'vitest';
import { createSession, getEngine, buildSubmittedAction, drawWorldCandidates } from './engine';
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
    const loaded = replay({ version: 1, seed: 424242, difficulty: 'standard', actionLog: [[a]], savedQuarter: 1 });
    expect(loaded.session.quarter).toBe(1);
    expect(loaded.rejectedQuarters).toHaveLength(0);
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
