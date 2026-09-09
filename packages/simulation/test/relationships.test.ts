/**
 * @frontier/simulation — relationships subsystem tests.
 *
 * Fifteen seeded characters, their seeded connection levels and the directional
 * relationships between them.
 *
 * What these assert:
 * - a quarter's memories move a relationship by a bounded amount, however many
 *   of them there are;
 * - salience decays at the rate the memory's kind deserves, and a betrayal is
 *   still there long after a meeting has been forgotten;
 * - the connection gap rule, the stored override and the structural override
 *   produce the access matrix `docs/MULTIPLAYER.md` describes;
 * - connection level is percentile-scaled across ten inputs and cannot be
 *   bought with followers.
 */

import { describe, expect, it } from 'vitest';
import type { Memory, SessionState } from '@frontier/contracts';
import { MEMORY_RECALL_THRESHOLD, canInitiateContact } from '@frontier/contracts';
import {
  CONNECTION_WEIGHTS,
  MAX_CONNECTION_STEP,
  MAX_QUARTER_DELTA,
  checkAccess,
  connectionInputs,
  createRelationshipsSubsystem,
  decayMemories,
  findRelationship,
  memoryEffect,
  recomputeConnectionLevels,
  updateRelationships,
} from '../src/relationships/index';
import { cloneState, eventsOfType, makeAction, makeContext, makeState } from './_institutionsHarness';

function memory(overrides: Partial<Memory> & { id: string }): Memory {
  return {
    ownerCharacterId: 'chr_maya_chen',
    aboutId: 'chr_daniel_okonkwo',
    quarter: 1,
    kind: 'betrayal',
    summary: 'They went back on what they told me in the room.',
    sentiment: -1,
    decayRate: 0.01,
    strength: 1,
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/*  Bounded movement                                                           */
/* -------------------------------------------------------------------------- */

describe('relationship movement', () => {
  it('bounds a quarter of memories, however many of them there are', () => {
    const state = makeState();
    const before = findRelationship(state, 'chr_maya_chen', 'chr_daniel_okonkwo');
    if (before === null) throw new Error('missing relationship');
    const trustBefore = before.trust;
    const hostilityBefore = before.hostility;

    state.memories = Array.from({ length: 8 }, (_, i) => memory({ id: `mem_${i}` }));

    const harness = makeContext(1);
    updateRelationships(state, harness.ctx);

    const after = findRelationship(state, 'chr_maya_chen', 'chr_daniel_okonkwo');
    if (after === null) throw new Error('missing relationship');
    expect(trustBefore - after.trust).toBeLessThanOrEqual(MAX_QUARTER_DELTA + 1e-9);
    expect(after.hostility - hostilityBefore).toBeLessThanOrEqual(MAX_QUARTER_DELTA + 1e-9);
    expect(after.trust).toBeGreaterThanOrEqual(0);
    expect(after.hostility).toBeLessThanOrEqual(100);
    expect(after.lastInteractionQuarter).toBe(1);

    const changes = eventsOfType(harness, 'relationship_changed');
    expect(changes.length).toBe(1);
    for (const line of harness.lines) expect(line.refEventIds?.length ?? 0).toBeGreaterThan(0);
  });

  it('moves each dimension in the direction the memory implies', () => {
    const hostile = memoryEffect('public_attack', -1);
    expect(hostile.trust).toBeLessThan(0);
    expect(hostile.hostility).toBeGreaterThan(0);

    const kind = memoryEffect('public_support', 1);
    expect(kind.trust).toBeGreaterThan(0);
    expect(kind.hostility).toBeLessThan(0);

    // A poach is read as competence and as an act of war at once.
    const poach = memoryEffect('poach', -1);
    expect(poach.respect).toBeGreaterThan(0);
    expect(poach.hostility).toBeGreaterThan(0);

    // Sentiment scales the magnitude.
    expect(Math.abs(memoryEffect('betrayal', -0.2).trust)).toBeLessThan(Math.abs(memoryEffect('betrayal', -1).trust));
  });

  it('records a poaching approach in the employer\'s memory either way', () => {
    const state = makeState();
    state.pendingActions = [
      makeAction(
        { type: 'poach_executive', targetCharacterId: 'chr_tomas_lindqvist', compPremiumPct: 0.6, approach: 'public' },
        { sequence: 0 },
      ),
    ];

    const harness = makeContext(1);
    updateRelationships(state, harness.ctx);

    const poach = state.memories.find((m) => m.kind === 'poach');
    expect(poach).toBeDefined();
    expect(poach?.ownerCharacterId).toBe('chr_tomas_lindqvist');
    expect(poach?.aboutId).toBe('cmp_nexus');
    expect(poach?.sentiment).toBeLessThan(-0.5);

    // A company memory still lands on a person: hostility toward Nexus's chief.
    const relationship = findRelationship(state, 'chr_tomas_lindqvist', 'chr_maya_chen');
    expect(relationship?.hostility ?? 0).toBeGreaterThan(0);
    expect(eventsOfType(harness, 'memory_stored').length).toBeGreaterThan(0);
  });
});

/* -------------------------------------------------------------------------- */
/*  Memory decay                                                               */
/* -------------------------------------------------------------------------- */

describe('memory decay', () => {
  it('fades a favour and keeps a betrayal', () => {
    const state = makeState();
    state.memories = [
      memory({ id: 'mem_betrayal', quarter: 0, kind: 'betrayal', decayRate: 0.01 }),
      memory({ id: 'mem_meeting', quarter: 0, kind: 'meeting', decayRate: 0.2, sentiment: 0.3, strength: 0.3 }),
    ];

    for (let quarter = 1; quarter <= 8; quarter += 1) {
      decayMemories(state, makeContext(quarter).ctx);
    }

    const betrayal = state.memories.find((m) => m.id === 'mem_betrayal');
    expect(betrayal).toBeDefined();
    expect(betrayal?.strength ?? 0).toBeGreaterThan(0.9);
    // The passing conversation has fallen below the recall threshold and gone.
    expect(state.memories.find((m) => m.id === 'mem_meeting')).toBeUndefined();
    for (const remaining of state.memories) {
      expect(remaining.strength).toBeGreaterThanOrEqual(MEMORY_RECALL_THRESHOLD);
    }
  });

  it('leaves this quarter\'s memories at full strength', () => {
    const state = makeState();
    state.memories = [memory({ id: 'mem_now', quarter: 3 })];
    decayMemories(state, makeContext(3).ctx);
    expect(state.memories[0]?.strength).toBe(1);
  });
});

/* -------------------------------------------------------------------------- */
/*  Access                                                                     */
/* -------------------------------------------------------------------------- */

describe('the access rule', () => {
  it('follows the connection gap in both directions', () => {
    const state = makeState();

    // 51 against 93: the founder cannot open a channel upward.
    const upward = checkAccess(state, 'chr_tomas_lindqvist', 'chr_nadia_okafor');
    expect(upward.allowed).toBe(false);
    expect(upward.overrideId).toBeNull();
    expect(upward.gap).toBeCloseTo(42, 6);
    expect(upward.reason).toContain('introduction');

    // The same pair downward is always permitted.
    const downward = checkAccess(state, 'chr_nadia_okafor', 'chr_tomas_lindqvist');
    expect(downward.allowed).toBe(true);
    expect(downward.overrideId).toBeNull();

    // Inside the symmetric band either party may start.
    expect(checkAccess(state, 'chr_maya_chen', 'chr_eleanor_vance').allowed).toBe(true);
    expect(checkAccess(state, 'chr_eleanor_vance', 'chr_maya_chen').allowed).toBe(true);
    expect(canInitiateContact(51, 93)).toBe(false);
    expect(canInitiateContact(93, 51)).toBe(true);
  });

  it('honours a live stored override and ignores an expired one', () => {
    const state = makeState();
    state.accessOverrides = [
      {
        id: 'ovr_intro_1',
        kind: 'introduction',
        fromId: 'chr_tomas_lindqvist',
        toId: 'chr_nadia_okafor',
        grantedQuarter: 0,
        expiresQuarter: 3,
        isPermanent: false,
        grantedByCharacterId: 'chr_eleanor_vance',
        reason: 'Eleanor Vance introduced you.',
      },
    ];
    const granted = checkAccess(state, 'chr_tomas_lindqvist', 'chr_nadia_okafor');
    expect(granted.allowed).toBe(true);
    expect(granted.overrideId).toBe('ovr_intro_1');

    const expired = cloneState(state);
    const override = expired.accessOverrides[0];
    if (override === undefined) throw new Error('missing override');
    override.expiresQuarter = 0;
    expect(checkAccess(expired, 'chr_tomas_lindqvist', 'chr_nadia_okafor').allowed).toBe(false);
  });

  it('derives a structural override from a shared board seat', () => {
    const state = makeState();
    // Idris (64) cannot reach Eleanor (88) on the gap rule alone.
    expect(canInitiateContact(64, 88)).toBe(false);
    const decision = checkAccess(state, 'chr_idris_bello', 'chr_eleanor_vance');
    expect(decision.allowed).toBe(true);
    expect(decision.overrideId).toContain('shared_board');
    expect(decision.reason).toContain('board');

    // Take the seat away and the channel closes.
    const without = cloneState(state);
    const board = without.boards[0];
    if (board === undefined) throw new Error('missing board');
    board.directors = board.directors.filter((d) => d.characterId !== 'chr_eleanor_vance');
    expect(checkAccess(without, 'chr_idris_bello', 'chr_eleanor_vance').allowed).toBe(false);
  });

  it('grants an introduction when the introducer is reachable and willing', () => {
    const state = makeState();
    state.pendingActions = [
      makeAction(
        {
          type: 'request_introduction',
          viaCharacterId: 'chr_eleanor_vance',
          targetCharacterId: 'chr_nadia_okafor',
          purpose: 'A sovereign co-investment in the next training cluster, sized at two billion.',
        },
        { sequence: 0 },
      ),
    ];

    const harness = makeContext(1);
    updateRelationships(state, harness.ctx);

    expect(state.accessOverrides.length).toBe(1);
    const override = state.accessOverrides[0];
    expect(override?.kind).toBe('introduction');
    expect(override?.grantedByCharacterId).toBe('chr_eleanor_vance');
    expect(override?.isPermanent).toBe(false);
    expect(eventsOfType(harness, 'introduction_granted').length).toBe(1);
    expect(checkAccess(state, 'chr_maya_chen', 'chr_nadia_okafor').allowed).toBe(true);
  });

  it('refuses an introduction the asker has not earned', () => {
    const state = makeState();
    state.pendingActions = [
      makeAction(
        {
          type: 'request_introduction',
          viaCharacterId: 'chr_eleanor_vance',
          targetCharacterId: 'chr_nadia_okafor',
          purpose: 'A sovereign co-investment in the next training cluster, sized at two billion.',
        },
        { sequence: 0, actorCharacterId: 'chr_tomas_lindqvist', actorCompanyId: 'cmp_vector', actorPlayerId: null },
      ),
    ];

    const harness = makeContext(1);
    updateRelationships(state, harness.ctx);
    expect(state.accessOverrides.length).toBe(0);
    expect(eventsOfType(harness, 'introduction_granted').length).toBe(0);
    expect(state.memories.some((m) => m.ownerCharacterId === 'chr_eleanor_vance' && m.sentiment < 0)).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/*  Connection level                                                           */
/* -------------------------------------------------------------------------- */

describe('connection level', () => {
  it('weights ten percentile inputs that sum to one', () => {
    const total = Object.values(CONNECTION_WEIGHTS).reduce((s, w) => s + w, 0);
    expect(total).toBeCloseTo(1, 9);

    const state = makeState();
    const inputs = connectionInputs(state);
    expect(inputs.length).toBe(state.characters.length);
    for (const entry of inputs) {
      for (const key of Object.keys(CONNECTION_WEIGHTS) as (keyof typeof CONNECTION_WEIGHTS)[]) {
        expect(entry[key]).toBeGreaterThanOrEqual(0);
        expect(entry[key]).toBeLessThanOrEqual(1);
      }
      expect(entry.computedLevel).toBeGreaterThanOrEqual(0);
      expect(entry.computedLevel).toBeLessThanOrEqual(100);
    }
  });

  it('cannot be bought with followers, and moves slowly', () => {
    const state = makeState();
    const journalist = state.characters.find((c) => c.id === 'chr_leo_park');
    if (journalist === undefined) throw new Error('missing character');
    journalist.publicFollowing = 500_000_000;
    const before = journalist.connectionLevel;

    const harness = makeContext(1);
    recomputeConnectionLevels(state, harness.ctx);

    const after = state.characters.find((c) => c.id === 'chr_leo_park')?.connectionLevel ?? 0;
    expect(Math.abs(after - before)).toBeLessThanOrEqual(MAX_CONNECTION_STEP + 1e-9);
    // Publishing to half a billion people does not make you a sovereign fund.
    const nadia = state.characters.find((c) => c.id === 'chr_nadia_okafor')?.connectionLevel ?? 0;
    expect(after).toBeLessThan(nadia);
    expect(eventsOfType(harness, 'relationship_changed').length).toBeGreaterThan(0);
  });

  it('rewards depth of relationship over breadth', () => {
    const state = makeState();
    const inputs = connectionInputs(state);
    const eleanor = inputs.find((i) => i.characterId === 'chr_eleanor_vance');
    const kenji = inputs.find((i) => i.characterId === 'chr_kenji_watanabe');
    expect(eleanor).toBeDefined();
    expect(kenji).toBeDefined();
    // Eleanor holds mutual, high-value relationships; Kenji has followers.
    expect(eleanor?.mutualRelationshipQuality ?? 0).toBeGreaterThan(kenji?.mutualRelationshipQuality ?? 1);
  });
});

/* -------------------------------------------------------------------------- */
/*  Determinism                                                                */
/* -------------------------------------------------------------------------- */

describe('determinism', () => {
  it('resolves the phase identically from an identical state', () => {
    const build = (): SessionState => {
      const state = makeState();
      state.memories = [memory({ id: 'mem_a' }), memory({ id: 'mem_b', kind: 'poach', sentiment: -0.7 })];
      state.pendingActions = [
        makeAction({ type: 'poach_executive', targetCharacterId: 'chr_tomas_lindqvist', compPremiumPct: 0.4, approach: 'private' }, { sequence: 0 }),
      ];
      return state;
    };
    const run = (state: SessionState) => {
      const harness = makeContext(1);
      const relationships = createRelationshipsSubsystem();
      relationships.updateRelationships(state, harness.ctx);
      relationships.decayMemories(state, harness.ctx);
      relationships.recomputeConnectionLevels(state, harness.ctx);
      return { state, events: harness.events, lines: harness.lines };
    };

    const first = run(build());
    const second = run(cloneState(build()));
    expect(JSON.stringify(second.events)).toBe(JSON.stringify(first.events));
    expect(JSON.stringify(second.lines)).toBe(JSON.stringify(first.lines));
    expect(JSON.stringify(second.state.relationships)).toBe(JSON.stringify(first.state.relationships));
    expect(JSON.stringify(second.state.characters)).toBe(JSON.stringify(first.state.characters));
  });
});
