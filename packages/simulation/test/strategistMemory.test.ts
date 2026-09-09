/**
 * @frontier/simulation — the engine-written strategist memory.
 *
 * What these assert:
 *
 * - the memory is bounded at its limits and trims oldest-first, so a
 *   forty-quarter campaign cannot grow it;
 * - a grudge is written only when the triggering ledger row or stored memory
 *   actually exists — the same state with no events writes nothing;
 * - grudges decay a few points a quarter and are eventually forgotten, unless
 *   the counterparty does it again;
 * - the standing strategy is rewritten only when the posture actually moves;
 * - the whole thing is a pure function of the recorded quarters: the same seed
 *   and the same recorded decisions produce byte-identical memory, and a
 *   replayed save reconstructs it exactly.
 */

import { describe, expect, it } from 'vitest';
import type { Memory, SessionState, SimEvent, SubmittedAction } from '@frontier/contracts';
import { MAX_STRATEGIST_ATTEMPTS, MAX_STRATEGIST_GRUDGES, MAX_STANDING_STRATEGY_CHARS } from '@frontier/contracts';
import { stableStringify } from '@frontier/shared';
import {
  GRUDGE_DECAY_PER_QUARTER,
  MAX_ATTEMPTS_PER_QUARTER,
  standingStrategyFor,
  updateStrategistMemory,
} from '../src/companies/strategistMemory';
import { cloneState, companyOf, makeContext, makeState } from './_institutionsHarness';
import {
  DEMO_CHARACTERS,
  DEMO_COMPANIES,
  DEMO_PLAYER_ID,
  DEMO_SEED,
  createDemoSession,
} from '../src/scenario';

/* -------------------------------------------------------------------------- */
/*  Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

let sequence = 0;

/** A ledger row as the recorder would have written it. */
function row(overrides: Partial<SimEvent> & Pick<SimEvent, 'type'>): SimEvent {
  sequence += 1;
  return {
    eventId: `evt_${sequence}`,
    sessionId: 'sess_demo_world',
    quarter: 1,
    sequence,
    actorId: null,
    targetId: null,
    payload: {},
    stateHashBefore: 'before',
    stateHashAfter: 'after',
    rowHash: 'row',
    visibility: 'private',
    ...overrides,
  };
}

/** A stored memory of the kind the relationships subsystem writes. */
function memory(overrides: Partial<Memory> & Pick<Memory, 'id' | 'ownerCharacterId' | 'aboutId'>): Memory {
  return {
    quarter: 1,
    kind: 'poach',
    summary: 'They came for two of my researchers with a 40% package.',
    sentiment: -0.8,
    decayRate: 0.05,
    strength: 1,
    ...overrides,
  };
}

/** The supply cut-off row: a staging row on cost_recognised, buyer as target. */
function cutOff(quarter: number, supplierId: string, buyerId: string): SimEvent {
  return row({
    type: 'cost_recognised',
    quarter,
    actorId: supplierId,
    targetId: buyerId,
    payload: { kind: 'supply_terms_changed', productId: 'prd_x', buyerCompanyId: buyerId, noticeQuarter: quarter + 1 },
  });
}

const memoryOf = (state: SessionState, companyId: string) => companyOf(state, companyId).strategistMemory;

/* -------------------------------------------------------------------------- */
/*  The standing strategy                                                      */
/* -------------------------------------------------------------------------- */

describe('the standing strategy', () => {
  it('is derived from the archetype policy and the posture, and fits its bound', () => {
    const state = makeState();
    const nexus = companyOf(state, 'cmp_nexus');
    const sentence = standingStrategyFor(nexus);
    expect(sentence.length).toBeGreaterThan(0);
    expect(sentence.length).toBeLessThanOrEqual(MAX_STANDING_STRATEGY_CHARS);
    expect(standingStrategyFor(nexus)).toBe(sentence);

    const shifted = { ...nexus, posture: 'survival' as const };
    expect(standingStrategyFor(shifted)).not.toBe(sentence);
  });

  it('is rewritten only when the posture actually changes', () => {
    const state = makeState();
    const first = makeContext(1);
    updateStrategistMemory(state, first.ctx, []);
    const opening = memoryOf(state, 'cmp_nexus');
    expect(opening?.standingStrategyQuarter).toBe(1);

    // A quarter in which nothing about the company moved leaves the stamp alone.
    const quiet = makeContext(2);
    updateStrategistMemory(state, quiet.ctx, []);
    expect(memoryOf(state, 'cmp_nexus')?.standingStrategy).toBe(opening?.standingStrategy);
    expect(memoryOf(state, 'cmp_nexus')?.standingStrategyQuarter).toBe(1);

    // A posture change does move it, and only then.
    companyOf(state, 'cmp_nexus').posture = 'survival';
    const changed = makeContext(3);
    updateStrategistMemory(state, changed.ctx, []);
    expect(memoryOf(state, 'cmp_nexus')?.standingStrategy).not.toBe(opening?.standingStrategy);
    expect(memoryOf(state, 'cmp_nexus')?.standingStrategyQuarter).toBe(3);
  });
});

/* -------------------------------------------------------------------------- */
/*  Grudges come from what happened                                            */
/* -------------------------------------------------------------------------- */

describe('grudges', () => {
  it('are not written when the triggering ledger row did not occur', () => {
    const state = makeState();
    const h = makeContext(1);
    updateStrategistMemory(state, h.ctx, []);
    for (const company of state.companies) expect(company.strategistMemory?.grudges ?? []).toEqual([]);
  });

  it('are written when the ledger says a supplier cut this company off', () => {
    const state = makeState();
    const h = makeContext(1);
    const result = updateStrategistMemory(state, h.ctx, [cutOff(1, 'cmp_helix', 'cmp_nexus')]);

    expect(result.grudgesOpened).toBe(1);
    const grudges = memoryOf(state, 'cmp_nexus')?.grudges ?? [];
    expect(grudges).toHaveLength(1);
    expect(grudges[0]?.companyId).toBe('cmp_helix');
    expect(grudges[0]?.quarter).toBe(1);
    expect(grudges[0]?.intensity).toBeGreaterThan(0);
    expect(grudges[0]?.reason).toContain('Helix');

    // Nobody else took anything from it.
    expect(memoryOf(state, 'cmp_helix')?.grudges ?? []).toEqual([]);
  });

  it('are derived from the memory the relationships subsystem already stored', () => {
    const state = makeState();
    state.memories.push(
      memory({ id: 'mem_poach', ownerCharacterId: 'chr_maya_chen', aboutId: 'cmp_orbit', quarter: 1, kind: 'poach', sentiment: -0.9 }),
    );
    const h = makeContext(1);
    updateStrategistMemory(state, h.ctx, []);

    const grudges = memoryOf(state, 'cmp_nexus')?.grudges ?? [];
    expect(grudges).toHaveLength(1);
    expect(grudges[0]?.companyId).toBe('cmp_orbit');
    expect(grudges[0]?.reason).toBe('They came for two of my researchers with a 40% package.');
  });

  it('ignore a memory that is not a grievance, and one from another quarter', () => {
    const state = makeState();
    state.memories.push(
      memory({ id: 'mem_good', ownerCharacterId: 'chr_maya_chen', aboutId: 'cmp_orbit', kind: 'deal_kept', sentiment: 0.8 }),
      memory({ id: 'mem_old', ownerCharacterId: 'chr_maya_chen', aboutId: 'cmp_helix', quarter: 0, sentiment: -0.9 }),
    );
    const h = makeContext(1);
    updateStrategistMemory(state, h.ctx, []);
    expect(memoryOf(state, 'cmp_nexus')?.grudges ?? []).toEqual([]);
  });

  it('decay a few points a quarter, and are forgotten when nothing repeats them', () => {
    const state = makeState();
    updateStrategistMemory(state, makeContext(1).ctx, [cutOff(1, 'cmp_helix', 'cmp_nexus')]);
    const opened = memoryOf(state, 'cmp_nexus')?.grudges[0]?.intensity ?? 0;
    expect(opened).toBeGreaterThan(0);

    updateStrategistMemory(state, makeContext(2).ctx, []);
    expect(memoryOf(state, 'cmp_nexus')?.grudges[0]?.intensity).toBe(opened - GRUDGE_DECAY_PER_QUARTER);

    // Long enough with nothing repeating it and the company has let it go.
    for (let quarter = 3; quarter < 3 + Math.ceil(opened / GRUDGE_DECAY_PER_QUARTER); quarter += 1) {
      updateStrategistMemory(state, makeContext(quarter).ctx, []);
    }
    expect(memoryOf(state, 'cmp_nexus')?.grudges ?? []).toEqual([]);
  });

  it('rise again when the same counterparty does it again', () => {
    const state = makeState();
    updateStrategistMemory(state, makeContext(1).ctx, [cutOff(1, 'cmp_helix', 'cmp_nexus')]);
    const opened = memoryOf(state, 'cmp_nexus')?.grudges[0]?.intensity ?? 0;
    updateStrategistMemory(state, makeContext(2).ctx, []);
    updateStrategistMemory(state, makeContext(3).ctx, [cutOff(3, 'cmp_helix', 'cmp_nexus')]);

    const grudges = memoryOf(state, 'cmp_nexus')?.grudges ?? [];
    expect(grudges).toHaveLength(1);
    expect(grudges[0]?.intensity).toBeGreaterThan(opened);
    expect(grudges[0]?.quarter).toBe(3);
  });

  it('are not written when a parent moves in its own subsidiary', () => {
    const state = makeState();
    companyOf(state, 'cmp_vector').parentCompanyId = 'cmp_nexus';
    updateStrategistMemory(state, makeContext(1).ctx, [
      row({ type: 'ownership_threshold_crossed', quarter: 1, actorId: 'cmp_nexus', targetId: 'cmp_vector', payload: { threshold: 'control', grantsControl: true } }),
    ]);
    expect(memoryOf(state, 'cmp_vector')?.grudges ?? []).toEqual([]);
  });

  it('are written when somebody outside the group builds a stake', () => {
    const state = makeState();
    updateStrategistMemory(state, makeContext(1).ctx, [
      row({ type: 'ownership_threshold_crossed', quarter: 1, actorId: 'cmp_orbit', targetId: 'cmp_vector', payload: { threshold: 'disclosure', grantsControl: false } }),
    ]);
    const grudges = memoryOf(state, 'cmp_vector')?.grudges ?? [];
    expect(grudges).toHaveLength(1);
    expect(grudges[0]?.companyId).toBe('cmp_orbit');
  });

  it('are bounded at six and drop the least recently repeated first', () => {
    const state = makeState();

    // One fresh counterparty a quarter, two more of them than the bound allows.
    const seen = Array.from({ length: MAX_STRATEGIST_GRUDGES + 2 }, (_, index) => `cmp_supplier_${index}`);
    seen.forEach((rival, index) => {
      const quarter = index + 1;
      updateStrategistMemory(state, makeContext(quarter).ctx, [cutOff(quarter, rival, 'cmp_nexus')]);
    });

    const grudges = memoryOf(state, 'cmp_nexus')?.grudges ?? [];
    expect(grudges).toHaveLength(MAX_STRATEGIST_GRUDGES);
    // Oldest first, and the two oldest counterparties are the ones that went.
    const quarters = grudges.map((grudge) => grudge.quarter);
    expect([...quarters].sort((a, b) => a - b)).toEqual(quarters);
    expect(grudges.map((grudge) => grudge.companyId)).not.toContain(seen[0]);
    expect(grudges.map((grudge) => grudge.companyId)).toContain(seen[seen.length - 1]);
  });
});

/* -------------------------------------------------------------------------- */
/*  Attempts come from the validator and the fills                             */
/* -------------------------------------------------------------------------- */

describe('attempts', () => {
  it('record what was asked for against what arrived', () => {
    const state = makeState();
    const h = makeContext(1);
    updateStrategistMemory(state, h.ctx, [
      row({
        type: 'information_revealed',
        quarter: 1,
        actorId: 'cmp_nexus',
        payload: { kind: 'partial_fill', actionType: 'hire', asked: 40, got: 6, unit: 'roles', reason: 'The talent market could not fill the rest.' },
      }),
    ]);

    const attempts = memoryOf(state, 'cmp_nexus')?.attempts ?? [];
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.what).toContain('40 roles');
    expect(attempts[0]?.outcome).toContain('6 of 40 roles');
    expect(attempts[0]?.quarter).toBe(1);
  });

  it('record a refusal and a reduction in the words the founder read', () => {
    const state = makeState();
    updateStrategistMemory(state, makeContext(1).ctx, [
      row({ type: 'action_rejected', quarter: 1, actorId: 'cmp_nexus', payload: { intentType: 'acquire_company', reasons: ['The board has not approved it.'] } }),
      row({ type: 'action_clamped', quarter: 1, actorId: 'cmp_nexus', payload: { intentType: 'raise_round', reasons: ['Priced below the ask.'] } }),
    ]);

    const attempts = memoryOf(state, 'cmp_nexus')?.attempts ?? [];
    expect(attempts).toHaveLength(2);
    expect(attempts[0]?.outcome).toContain('Refused');
    expect(attempts[1]?.outcome).toContain('Reduced');
    expect(attempts[1]?.what).toBe('raise round');
  });

  it('take at most three from one quarter, so one bad quarter cannot flush the record', () => {
    const state = makeState();
    const rows = Array.from({ length: 6 }, (_, index) =>
      row({ type: 'action_rejected', quarter: 1, actorId: 'cmp_nexus', payload: { intentType: `hire`, reasons: [`reason ${index}`] } }),
    );
    const result = updateStrategistMemory(state, makeContext(1).ctx, rows);
    expect(result.attemptsRecorded).toBe(MAX_ATTEMPTS_PER_QUARTER);
    expect(memoryOf(state, 'cmp_nexus')?.attempts).toHaveLength(MAX_ATTEMPTS_PER_QUARTER);
  });

  it('spend the quarter\'s slots on the shortfalls before the refusals', () => {
    const state = makeState();
    const rows = [
      row({ type: 'action_rejected', quarter: 1, actorId: 'cmp_nexus', payload: { intentType: 'hire', reasons: ['first'] } }),
      row({ type: 'action_rejected', quarter: 1, actorId: 'cmp_nexus', payload: { intentType: 'hire', reasons: ['second'] } }),
      row({ type: 'action_rejected', quarter: 1, actorId: 'cmp_nexus', payload: { intentType: 'hire', reasons: ['third'] } }),
      row({
        type: 'information_revealed',
        quarter: 1,
        actorId: 'cmp_nexus',
        payload: { kind: 'partial_fill', actionType: 'reserve_compute', asked: 1_000, got: 200, unit: 'accelerators', reason: 'The fabs could not ship the rest.' },
      }),
    ];
    updateStrategistMemory(state, makeContext(1).ctx, rows);

    const attempts = memoryOf(state, 'cmp_nexus')?.attempts ?? [];
    expect(attempts).toHaveLength(MAX_ATTEMPTS_PER_QUARTER);
    expect(attempts.some((attempt) => attempt.what.includes('accelerators'))).toBe(true);
    // The record still reads in the order the quarter wrote it.
    expect(attempts[attempts.length - 1]?.what).toContain('accelerators');
  });

  it('are bounded at eight and trimmed oldest-first', () => {
    const state = makeState();
    for (let quarter = 1; quarter <= MAX_STRATEGIST_ATTEMPTS + 3; quarter += 1) {
      updateStrategistMemory(state, makeContext(quarter).ctx, [
        row({ type: 'action_rejected', quarter, actorId: 'cmp_nexus', payload: { intentType: 'hire', reasons: [`quarter ${quarter}`] } }),
      ]);
    }
    const attempts = memoryOf(state, 'cmp_nexus')?.attempts ?? [];
    expect(attempts).toHaveLength(MAX_STRATEGIST_ATTEMPTS);
    expect(attempts[0]?.quarter).toBe(4);
    expect(attempts[attempts.length - 1]?.quarter).toBe(MAX_STRATEGIST_ATTEMPTS + 3);
  });
});

/* -------------------------------------------------------------------------- */
/*  Determinism                                                                */
/* -------------------------------------------------------------------------- */

describe('the memory is a pure function of the recorded quarters', () => {
  it('writes byte-identical memory from the same state and the same rows', () => {
    const build = (): SessionState => {
      const state = makeState();
      state.memories.push(memory({ id: 'mem_poach', ownerCharacterId: 'chr_maya_chen', aboutId: 'cmp_orbit' }));
      const rows = [
        cutOff(1, 'cmp_helix', 'cmp_nexus'),
        row({
          type: 'information_revealed',
          quarter: 1,
          actorId: 'cmp_nexus',
          payload: { kind: 'partial_fill', actionType: 'hire', asked: 40, got: 6, unit: 'roles', reason: 'Nobody was available.' },
        }),
      ];
      updateStrategistMemory(state, makeContext(1).ctx, rows);
      return state;
    };

    const first = build().companies.map((company) => company.strategistMemory ?? null);
    const second = build().companies.map((company) => company.strategistMemory ?? null);
    expect(stableStringify(second)).toBe(stableStringify(first));
  });

  it('does not depend on the order the same rows arrive in state', () => {
    const state = makeState();
    const clone = cloneState(state);
    const rows = [cutOff(1, 'cmp_helix', 'cmp_nexus'), cutOff(1, 'cmp_orbit', 'cmp_nexus')];
    updateStrategistMemory(state, makeContext(1).ctx, rows);
    updateStrategistMemory(clone, makeContext(1).ctx, rows);
    expect(stableStringify(clone.companies.map((c) => c.strategistMemory ?? null))).toBe(
      stableStringify(state.companies.map((c) => c.strategistMemory ?? null)),
    );
  });
});

/* -------------------------------------------------------------------------- */
/*  The whole engine                                                           */
/* -------------------------------------------------------------------------- */

const engineModule = await (async (): Promise<typeof import('../src/engine') | null> => {
  try {
    return await import('../src/engine');
  } catch {
    return null;
  }
})();

/** The same instructions every run: a poaching raid, a raise and some hiring. */
function scriptFor(state: SessionState, quarter: number): SubmittedAction[] {
  const base = (sequence: number, intent: SubmittedAction['intent']): SubmittedAction => ({
    actionId: `act_q${quarter}_${sequence}`,
    sessionId: state.sessionId,
    quarter,
    sequence,
    actorPlayerId: DEMO_PLAYER_ID,
    actorCompanyId: DEMO_COMPANIES.player,
    actorCharacterId: DEMO_CHARACTERS.player,
    origin: 'player_ui',
    intent,
    confirmedByHuman: true,
  });
  return [
    base(0, { type: 'hire', role: 'engineers', count: 400, compBand: 'top_of_market' }),
    base(1, {
      type: 'poach_executive',
      targetCharacterId: DEMO_CHARACTERS.maya,
      compPremiumPct: 0.4,
      approach: 'public',
    }),
  ];
}

describe.skipIf(engineModule === null)('the memory across resolved quarters', () => {
  it(
    'is identical on two runs of the same seed and the same recorded decisions',
    () => {
      if (engineModule === null) return;
      const run = (): string => {
        const engine = engineModule.createDefaultEngine();
        let state = createDemoSession(DEMO_SEED);
        for (let quarter = 0; quarter < 4; quarter += 1) {
          const outcome = engine.resolver.resolveQuarter(state, scriptFor(state, quarter), null, []);
          expect(outcome.committed).toBe(true);
          state = outcome.nextState;
        }
        return stableStringify(state.companies.map((company) => ({ id: company.id, memory: company.strategistMemory ?? null })));
      };
      const first = run();
      expect(run()).toBe(first);
      // Not vacuous: those quarters really did write a grudge and an attempt.
      expect(first).toContain('standingStrategy');
      expect(first).toContain('grudges');
      const written = JSON.parse(first) as { id: string; memory: { grudges: unknown[]; attempts: unknown[] } | null }[];
      expect(written.some((entry) => (entry.memory?.grudges.length ?? 0) > 0)).toBe(true);
      expect(written.some((entry) => (entry.memory?.attempts.length ?? 0) > 0)).toBe(true);
    },
    120_000,
  );

  it(
    'reconstructs itself when the recorded quarters are replayed',
    () => {
      if (engineModule === null) return;
      const engine = engineModule.createDefaultEngine();
      const opening = createDemoSession(DEMO_SEED);
      const first = engine.resolver.resolveQuarter(opening, scriptFor(opening, 0), null, []);
      expect(first.committed).toBe(true);

      // The replay path the save file takes: the same opening state and the
      // same recorded decisions, resolved again by a fresh engine.
      const replayEngine = engineModule.createDefaultEngine();
      const replayOpening = createDemoSession(DEMO_SEED);
      const replay = replayEngine.resolver.resolveQuarter(replayOpening, scriptFor(replayOpening, 0), null, []);
      expect(stableStringify(replay.nextState.companies.map((c) => c.strategistMemory ?? null))).toBe(
        stableStringify(first.nextState.companies.map((c) => c.strategistMemory ?? null)),
      );
    },
    120_000,
  );

  it(
    'stays bounded over a long campaign',
    () => {
      if (engineModule === null) return;
      const engine = engineModule.createDefaultEngine();
      let state = createDemoSession(DEMO_SEED);
      for (let quarter = 0; quarter < 12; quarter += 1) {
        const outcome = engine.resolver.resolveQuarter(state, scriptFor(state, quarter), null, []);
        if (!outcome.committed) break;
        state = outcome.nextState;
      }
      for (const company of state.companies) {
        const held = company.strategistMemory;
        if (held === undefined) continue;
        expect(held.grudges.length).toBeLessThanOrEqual(MAX_STRATEGIST_GRUDGES);
        expect(held.attempts.length).toBeLessThanOrEqual(MAX_STRATEGIST_ATTEMPTS);
        expect(held.standingStrategy.length).toBeLessThanOrEqual(MAX_STANDING_STRATEGY_CHARS);
      }
    },
    120_000,
  );
});
