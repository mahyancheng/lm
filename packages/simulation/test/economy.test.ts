import { describe, expect, it } from 'vitest';
import {
  DEFAULT_IMPACT_BUDGET,
  IMPACT_BUDGET_BY_DIFFICULTY,
  LEDGER_VISIBILITIES,
  ResolutionLineSchema,
  SIM_EVENT_TYPES,
  WorldStateSchema,
  getTargetPathSpec,
} from '@frontier/contracts';
import type { GmProposalBatch, SessionState, SimEventDraft, WorldModifier } from '@frontier/contracts';
import {
  EVENT_FAMILY_DEFINITIONS,
  TOTAL_BASE_HAZARD,
  createEconomySubsystem,
  decayFactor,
  drawCandidates,
  driftWorld,
  ensureHazardStates,
  eventFamilyById,
  magnitudeCap,
  tickHazardStates,
  toActiveModifier,
} from '../src/economy';
import { makeContext, makeRng, makeState, cloneState, type HarnessContext } from './_economyMarketsHarness';
import { createDefaultEngine } from '../src/engine';
import { createDemoSession } from '../src/scenario/demo';

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/** Every report line must reference a committed ledger row and satisfy the schema. */
function assertReportIsWellFormed(harness: HarnessContext): void {
  const emittedIds = new Set(harness.events.map((event) => event.eventId));
  for (const line of harness.lines) {
    expect(line.refEventIds, line.text).toBeDefined();
    expect((line.refEventIds ?? []).length, line.text).toBeGreaterThan(0);
    for (const ref of line.refEventIds ?? []) expect(emittedIds.has(ref), `${line.text} → ${ref}`).toBe(true);
    ResolutionLineSchema.parse({ ...line, refEventIds: line.refEventIds ?? [] });
  }
  for (const event of harness.events) {
    expect(SIM_EVENT_TYPES as readonly string[]).toContain(event.type);
    expect(LEDGER_VISIBILITIES as readonly string[]).toContain(event.visibility);
  }
}

/** Push a long-lived hazard delta onto a family, without disturbing the ones already there. */
function pushHazard(state: SessionState, familyId: string, amount: number): void {
  ensureHazardStates(state);
  const hazard = state.eventHazards[familyId];
  if (hazard === undefined) throw new Error(`unknown family ${familyId}`);
  hazard.pendingDeltas = [...hazard.pendingDeltas, { amount, remainingQuarters: 16, sourceEventId: null }];
  hazard.currentHazard = Math.max(0, Math.min(1, hazard.baseHazard + hazard.pendingDeltas.reduce((sum, delta) => sum + delta.amount, 0)));
}

/** Force a family to fire: hazard 1.0 means every roll lands under it. */
function forceFamily(state: SessionState, familyId: string): void {
  pushHazard(state, familyId, 1);
}

/**
 * Drive every other family's hazard to zero so only `familyId` can be drawn.
 * Deltas that came from a real event are preserved — those carry the causality
 * the cascade test is about.
 */
function isolateFamily(state: SessionState, familyId: string): void {
  ensureHazardStates(state);
  for (const definition of EVENT_FAMILY_DEFINITIONS) {
    const hazard = state.eventHazards[definition.family.id];
    if (hazard === undefined) continue;
    hazard.pendingDeltas = [
      ...hazard.pendingDeltas.filter((delta) => delta.sourceEventId !== null),
      { amount: definition.family.id === familyId ? 1 : -1, remainingQuarters: 16, sourceEventId: null },
    ];
    hazard.currentHazard = Math.max(0, Math.min(1, hazard.baseHazard + hazard.pendingDeltas.reduce((sum, delta) => sum + delta.amount, 0)));
  }
}

function runWorldPhase(state: SessionState, quarter: number, seed: string): HarnessContext {
  const economy = createEconomySubsystem();
  const harness = makeContext(quarter, seed);
  economy.updateMacro(state, harness.ctx);
  const candidates = economy.computeEventCandidates(state, harness.ctx);
  for (const candidate of candidates) economy.materialiseCandidate(state, candidate, harness.ctx);
  economy.applyModifiers(state, harness.ctx);
  economy.revealInformation(state, harness.ctx);
  economy.decayModifiers(state, harness.ctx);
  return harness;
}

const payloadsOf = (events: readonly (SimEventDraft & { eventId: string })[]): string => JSON.stringify(events);

/* -------------------------------------------------------------------------- */
/*  Catalogue                                                                  */
/* -------------------------------------------------------------------------- */

describe('event family catalogue', () => {
  it('holds the twenty-four documented families with a summed base hazard of 1.94', () => {
    expect(EVENT_FAMILY_DEFINITIONS).toHaveLength(24);
    expect(TOTAL_BASE_HAZARD).toBeCloseTo(1.94, 6);
  });

  it('references only families that exist and only legal target paths', () => {
    for (const definition of EVENT_FAMILY_DEFINITIONS) {
      for (const followOn of definition.family.followOnHazards) {
        expect(eventFamilyById(followOn.familyId), `${definition.family.id} → ${followOn.familyId}`).not.toBeNull();
      }
      for (const incompatible of definition.family.incompatibleFamilyIds) {
        expect(eventFamilyById(incompatible), incompatible).not.toBeNull();
      }
      for (const path of definition.suggestedTargetPaths) {
        const concrete = path.replace('{companyId}', 'cmp_nexus');
        expect(getTargetPathSpec(concrete), `${definition.family.id}: ${concrete}`).not.toBeNull();
      }
      for (const template of definition.modifierTemplates) {
        const concrete = template.target.replace('{companyId}', 'cmp_nexus');
        const spec = getTargetPathSpec(concrete);
        expect(spec, `${definition.family.id}: ${concrete}`).not.toBeNull();
        expect(spec?.operations, `${definition.family.id}: ${concrete}`).toContain(template.operation);
      }
      const [minSeverity, maxSeverity] = definition.family.severityRange;
      expect(maxSeverity).toBeGreaterThan(minSeverity);
    }
  });
});

/* -------------------------------------------------------------------------- */
/*  Macro drift                                                                */
/* -------------------------------------------------------------------------- */

describe('updateMacro', () => {
  it('is deterministic: the same seed twice produces identical drift', () => {
    const a = makeState();
    const b = makeState();
    driftWorld(a.world, makeRng('drift'));
    driftWorld(b.world, makeRng('drift'));
    expect(JSON.stringify(a.world)).toBe(JSON.stringify(b.world));

    const c = makeState();
    driftWorld(c.world, makeRng('different'));
    expect(JSON.stringify(c.world)).not.toBe(JSON.stringify(a.world));
  });

  it('keeps every domain inside its schema bounds over forty quarters', () => {
    const state = makeState();
    for (let quarter = 0; quarter < 40; quarter += 1) {
      driftWorld(state.world, makeRng(`q${quarter}`));
      const parsed = WorldStateSchema.safeParse(state.world);
      expect(parsed.success, `quarter ${quarter}: ${parsed.success ? '' : JSON.stringify(parsed.error.issues)}`).toBe(true);
    }
  });

  it('moves the policy rate toward the inflation it is fighting', () => {
    const hot = makeState();
    hot.world.macro.inflation = 0.09;
    const cold = makeState();
    cold.world.macro.inflation = 0.0;

    driftWorld(hot.world, makeRng('rates'));
    driftWorld(cold.world, makeRng('rates'));
    expect(hot.world.macro.policyRate).toBeGreaterThan(cold.world.macro.policyRate);
  });

  it('couples venture liquidity to risk appetite and the compute spot price to supply and energy', () => {
    const risky = makeState();
    risky.world.capitalMarkets.riskAppetite = 0.95;
    const cautious = makeState();
    cautious.world.capitalMarkets.riskAppetite = 0.05;
    driftWorld(risky.world, makeRng('capital'));
    driftWorld(cautious.world, makeRng('capital'));
    expect(risky.world.capitalMarkets.ventureLiquidity).toBeGreaterThan(cautious.world.capitalMarkets.ventureLiquidity);

    const scarce = makeState();
    scarce.world.compute.acceleratorSupply = 0.15;
    scarce.world.energy.electricityPrice = 1.8;
    const plentiful = makeState();
    plentiful.world.compute.acceleratorSupply = 0.95;
    plentiful.world.energy.electricityPrice = 0.9;
    driftWorld(scarce.world, makeRng('compute'));
    driftWorld(plentiful.world, makeRng('compute'));
    expect(scarce.world.compute.spotPrice).toBeGreaterThan(plentiful.world.compute.spotPrice);
  });

  it('emits one auditable drift row and only references it from report lines', () => {
    const state = makeState();
    const harness = runWorldPhase(state, 1, 'macro-report');
    const driftRows = harness.events.filter((event) => event.payload['kind'] === 'macro_drift');
    expect(driftRows).toHaveLength(1);
    assertReportIsWellFormed(harness);
  });
});

/* -------------------------------------------------------------------------- */
/*  Hazard engine                                                              */
/* -------------------------------------------------------------------------- */

describe('computeEventCandidates', () => {
  it('draws identically for the same state and seed, and differently for another seed', () => {
    const a = makeState();
    const b = cloneState(makeState());
    tickHazardStates(a);
    tickHazardStates(b);
    const first = drawCandidates(a, 4, makeRng('same'), DEFAULT_IMPACT_BUDGET);
    const second = drawCandidates(b, 4, makeRng('same'), DEFAULT_IMPACT_BUDGET);
    expect(JSON.stringify(first.candidates)).toBe(JSON.stringify(second.candidates));

    const c = makeState();
    tickHazardStates(c);
    const other = drawCandidates(c, 4, makeRng('other'), DEFAULT_IMPACT_BUDGET);
    expect(JSON.stringify(other.candidates)).not.toBe(JSON.stringify(first.candidates));
  });

  it('gates families on their preconditions', () => {
    const quiet = makeState();
    quiet.world.capitalMarkets.riskAppetite = 0.4; // below the 0.55 gate
    forceFamily(quiet, 'fam_compute_demand');
    const gated = drawCandidates(quiet, 3, makeRng('gate'), DEFAULT_IMPACT_BUDGET);
    const gatedDiagnostic = gated.diagnostics.find((entry) => entry.familyId === 'fam_compute_demand');
    expect(gatedDiagnostic?.eligible).toBe(false);
    expect(gatedDiagnostic?.reason).toContain('precondition');
    expect(gated.candidates.some((candidate) => candidate.familyId === 'fam_compute_demand')).toBe(false);

    const hot = makeState();
    hot.world.capitalMarkets.riskAppetite = 0.9; // above the gate
    forceFamily(hot, 'fam_compute_demand');
    const open = drawCandidates(hot, 3, makeRng('gate'), DEFAULT_IMPACT_BUDGET);
    expect(open.diagnostics.find((entry) => entry.familyId === 'fam_compute_demand')?.eligible).toBe(true);
  });

  it('respects the event count, severity budget and contradiction rules when everything fires', () => {
    const state = makeState();
    tickHazardStates(state);
    for (const definition of EVENT_FAMILY_DEFINITIONS) {
      const hazard = state.eventHazards[definition.family.id];
      if (hazard !== undefined) {
        hazard.pendingDeltas = [{ amount: 1, remainingQuarters: 16, sourceEventId: null }];
        hazard.currentHazard = 1;
      }
    }
    const draw = drawCandidates(state, 6, makeRng('storm'), DEFAULT_IMPACT_BUDGET);
    expect(draw.candidates.length).toBeLessThanOrEqual(DEFAULT_IMPACT_BUDGET.maxEventsPerQuarter);
    expect(draw.severityUsed).toBeLessThanOrEqual(DEFAULT_IMPACT_BUDGET.maxTotalSeverity + 1e-9);

    const drawnIds = draw.candidates.map((candidate) => candidate.familyId);
    for (const familyId of drawnIds) {
      const definition = eventFamilyById(familyId);
      for (const incompatible of definition?.family.incompatibleFamilyIds ?? []) {
        expect(drawnIds).not.toContain(incompatible);
      }
    }
    for (const candidate of draw.candidates) {
      const [low, high] = candidate.severityBand;
      expect(candidate.suggestedSeverity).toBeGreaterThanOrEqual(low);
      expect(candidate.suggestedSeverity).toBeLessThanOrEqual(high);
    }
  });

  it('holds a family off for its cooldown after it fires', () => {
    const state = makeState();
    isolateFamily(state, 'fam_fab_capacity'); // cooldown 8 quarters
    const harness = makeContext(1, 'cooldown');
    const economy = createEconomySubsystem();
    const candidates = economy.computeEventCandidates(state, harness.ctx);
    const target = candidates.find((candidate) => candidate.familyId === 'fam_fab_capacity');
    expect(target).toBeDefined();
    if (target === undefined) return;
    economy.materialiseCandidate(state, target, harness.ctx);
    expect(state.eventHazards['fam_fab_capacity']?.cooldownRemaining).toBe(8);

    for (let quarter = 2; quarter <= 8; quarter += 1) {
      const next = makeContext(quarter, `cooldown-${quarter}`);
      const drawn = createEconomySubsystem().computeEventCandidates(state, next.ctx);
      expect(drawn.some((candidate) => candidate.familyId === 'fam_fab_capacity'), `quarter ${quarter}`).toBe(false);
      expect(state.eventHazards['fam_fab_capacity']?.cooldownRemaining).toBe(9 - quarter);
    }
  });

  it('pushes follow-on hazards and links the child event to its causal parent', () => {
    const state = makeState();
    isolateFamily(state, 'fam_geopolitical_escalation');
    const harness = makeContext(1, 'cascade');
    const economy = createEconomySubsystem();
    const [candidate] = economy.computeEventCandidates(state, harness.ctx);
    expect(candidate?.familyId).toBe('fam_geopolitical_escalation');
    if (candidate === undefined) return;
    const materialised = economy.materialiseCandidate(state, candidate, harness.ctx);
    expect(materialised).not.toBeNull();

    const exportHazard = state.eventHazards['fam_export_control'];
    const pushed = exportHazard?.pendingDeltas.find((delta) => delta.sourceEventId === materialised?.event.id);
    expect(pushed).toBeDefined();
    expect(pushed?.amount).toBeCloseTo(0.22, 9);
    expect(pushed?.remainingQuarters).toBe(8);

    // Next quarter the raised family names its parent on the candidate skeleton.
    state.world.geopolitics.techCompetition = 0.8;
    isolateFamily(state, 'fam_export_control');
    const followOn = makeContext(2, 'cascade-2');
    const nextCandidates = createEconomySubsystem().computeEventCandidates(state, followOn.ctx);
    const child = nextCandidates.find((entry) => entry.familyId === 'fam_export_control');
    expect(child?.causalParentId).toBe(materialised?.event.id);
  });
});

/* -------------------------------------------------------------------------- */
/*  Materialisation                                                            */
/* -------------------------------------------------------------------------- */

describe('materialiseCandidate', () => {
  it('produces the same event and modifiers twice from the same state and seed', () => {
    const first = makeState();
    const second = makeState();
    forceFamily(first, 'fam_compute_supply');
    forceFamily(second, 'fam_compute_supply');

    const runOne = makeContext(3, 'materialise');
    const runTwo = makeContext(3, 'materialise');
    const economy = createEconomySubsystem();
    const candidateOne = economy.computeEventCandidates(first, runOne.ctx).find((c) => c.familyId === 'fam_compute_supply');
    const candidateTwo = createEconomySubsystem().computeEventCandidates(second, runTwo.ctx).find((c) => c.familyId === 'fam_compute_supply');
    expect(candidateOne).toBeDefined();
    if (candidateOne === undefined || candidateTwo === undefined) return;

    const a = economy.materialiseCandidate(first, candidateOne, runOne.ctx);
    const b = createEconomySubsystem().materialiseCandidate(second, candidateTwo, runTwo.ctx);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(JSON.stringify(first.activeModifiers)).toBe(JSON.stringify(second.activeModifiers));
    expect(payloadsOf(runOne.events)).toBe(payloadsOf(runTwo.events));
  });

  it('keeps the event inside its severity band and every modifier inside the impact budget', () => {
    for (const definition of EVENT_FAMILY_DEFINITIONS) {
      const state = makeState();
      // Give the company-scoped families something to land on and satisfy gates.
      state.world.geopolitics.techCompetition = 0.8;
      state.world.capitalMarkets.sectorMultiples = 1.8;
      state.world.capitalMarkets.riskAppetite = 0.8;
      forceFamily(state, definition.family.id);

      const harness = makeContext(2, `materialise-${definition.family.id}`);
      const economy = createEconomySubsystem();
      const candidate = economy.computeEventCandidates(state, harness.ctx).find((entry) => entry.familyId === definition.family.id);
      if (candidate === undefined) continue;
      const built = economy.materialiseCandidate(state, candidate, harness.ctx);
      expect(built, definition.family.id).not.toBeNull();
      if (built === null) continue;

      const [low, high] = definition.family.severityRange;
      expect(built.event.severity).toBeGreaterThanOrEqual(low);
      expect(built.event.severity).toBeLessThanOrEqual(high);
      expect(built.modifiers.length).toBeLessThanOrEqual(DEFAULT_IMPACT_BUDGET.maxModifiersPerEvent);
      expect(built.event.titleKey).toMatch(/^[a-z0-9_]+$/);
      expect(built.event.description.length).toBeGreaterThanOrEqual(20);

      for (const modifier of built.modifiers) {
        const cap = magnitudeCap(modifier.target, modifier.operation, DEFAULT_IMPACT_BUDGET);
        const magnitude = modifier.operation === 'multiply' ? Math.abs(modifier.value - 1) : Math.abs(modifier.value);
        expect(magnitude, `${definition.family.id} ${modifier.target}`).toBeLessThanOrEqual(cap + 1e-9);
        expect(getTargetPathSpec(modifier.target), modifier.target).not.toBeNull();
        expect(modifier.target).not.toContain('{');
      }
      if (definition.companyScope !== 'none') {
        expect(built.subjectCompanyId).not.toBeNull();
        expect(built.event.affectedCompanyIds.length).toBeGreaterThan(0);
      }
    }
  });
});

/* -------------------------------------------------------------------------- */
/*  Modifiers                                                                  */
/* -------------------------------------------------------------------------- */

describe('applyModifiers and decayModifiers', () => {
  const modifier = (overrides: Partial<WorldModifier> = {}): WorldModifier => ({
    id: 'mod_test_1',
    source: 'system',
    target: 'world.society.aiTrust',
    operation: 'add',
    value: 0.05,
    decay: 'linear',
    durationQuarters: 3,
    remainingQuarters: 3,
    appliedAtQuarter: 1,
    originEventId: null,
    reason: 'A test modifier.',
    ...overrides,
  });

  it('clamps an oversized application to the registered bounds and records the clamp', () => {
    const state = makeState();
    state.activeModifiers = [toActiveModifier(modifier({ value: 5, decay: 'none' }), 1)];
    const harness = makeContext(1, 'clamp');
    createEconomySubsystem().applyModifiers(state, harness.ctx);

    expect(state.world.society.aiTrust).toBe(1);
    const applied = harness.events.find((event) => event.type === 'modifier_applied');
    expect(applied?.payload['clamped']).toBe(true);
    assertReportIsWellFormed(harness);
  });

  it('applies at most once per quarter however many times the phase runs', () => {
    const state = makeState();
    const before = state.world.society.aiTrust;
    state.activeModifiers = [toActiveModifier(modifier({ decay: 'none' }), 1)];
    const harness = makeContext(1, 'idempotent');
    const economy = createEconomySubsystem();
    economy.applyModifiers(state, harness.ctx);
    economy.applyModifiers(state, harness.ctx);
    expect(state.world.society.aiTrust).toBeCloseTo(before + 0.05, 10);
  });

  it('decays to expiry and emits modifier_expired on the last quarter', () => {
    const state = makeState();
    state.activeModifiers = [toActiveModifier(modifier(), 1)];
    const economy = createEconomySubsystem();
    const effects: number[] = [];

    for (let quarter = 1; quarter <= 3; quarter += 1) {
      const harness = makeContext(quarter, `decay-${quarter}`);
      const trustBefore = state.world.society.aiTrust;
      economy.applyModifiers(state, harness.ctx);
      effects.push(state.world.society.aiTrust - trustBefore);
      economy.decayModifiers(state, harness.ctx);
      if (quarter < 3) expect(state.activeModifiers).toHaveLength(1);
    }

    expect(effects[0]).toBeGreaterThan(effects[1] ?? 0);
    expect(effects[1]).toBeGreaterThan(effects[2] ?? 0);
    expect(state.activeModifiers).toHaveLength(0);

    const final = makeContext(4, 'decay-final');
    economy.applyModifiers(state, final.ctx);
    expect(final.events.filter((event) => event.type === 'modifier_applied')).toHaveLength(0);
  });

  it('computes the three decay shapes as documented', () => {
    expect(decayFactor('none', 0, 4)).toBe(1);
    expect(decayFactor('none', 3, 4)).toBe(1);
    expect(decayFactor('none', 4, 4)).toBe(0);
    expect(decayFactor('linear', 2, 4)).toBeCloseTo(0.5, 12);
    expect(decayFactor('exponential', 0, 4)).toBe(1);
    expect(decayFactor('exponential', 1, 4)).toBeLessThan(decayFactor('linear', 1, 4));
  });

  it('decays a multiply modifier toward 1.0, never toward zero', () => {
    const state = makeState();
    state.activeModifiers = [
      toActiveModifier(modifier({ id: 'mod_spot', target: 'world.compute.spotPrice', operation: 'multiply', value: 1.3, durationQuarters: 4, remainingQuarters: 4 }), 1),
    ];
    const economy = createEconomySubsystem();
    const ratios: number[] = [];
    for (let quarter = 1; quarter <= 3; quarter += 1) {
      const harness = makeContext(quarter, `mul-${quarter}`);
      const before = state.world.compute.spotPrice;
      economy.applyModifiers(state, harness.ctx);
      ratios.push(state.world.compute.spotPrice / before);
      economy.decayModifiers(state, harness.ctx);
    }
    expect(ratios[0]).toBeCloseTo(1.3, 6);
    expect(ratios[1]).toBeLessThan(ratios[0] ?? 0);
    expect(ratios[1]).toBeGreaterThan(1);
    expect(ratios[2]).toBeGreaterThan(1);
  });

  it('writes company-scoped modifiers back into the company', () => {
    const state = makeState();
    const company = state.companies[0];
    expect(company).toBeDefined();
    if (company === undefined) return;
    const before = company.reputation.public;
    state.activeModifiers = [
      toActiveModifier(modifier({ id: 'mod_rep', target: `company.${company.id}.reputationPublic`, value: -12, decay: 'none' }), 1),
    ];
    const harness = makeContext(1, 'company-mod');
    createEconomySubsystem().applyModifiers(state, harness.ctx);
    expect(company.reputation.public).toBeCloseTo(before - 12, 6);
  });
});

/* -------------------------------------------------------------------------- */
/*  World Director integration                                                 */
/* -------------------------------------------------------------------------- */

describe('applyGmProposals', () => {
  const batchFor = (candidateId: string, familyId: string): GmProposalBatch => ({
    quarterSummary: 'A quarter in which supply tightened and the market noticed.',
    proposals: [
      {
        event: {
          candidateId,
          familyId,
          type: 'compute_supply_shock',
          titleKey: 'packaging_line_failure',
          title: 'Advanced packaging capacity disrupted',
          description: 'A packaging subcontractor halted output after a process failure, and accelerator deliveries have slipped across the industry.',
          severity: 0.99, // outside the band on purpose
          visibility: 'public',
          durationQuarters: 3,
          causalParentId: null,
          affectedSectorIds: ['semiconductors', 'atlantis'],
        },
        modifiers: [
          { target: 'world.compute.acceleratorSupply', operation: 'multiply', value: 0.1, decay: 'linear', durationQuarters: 3, reason: 'Deliveries slipped.' },
          { target: 'world.macro.gdpGrowth', operation: 'multiply', value: 1.2, decay: 'none', durationQuarters: 2, reason: 'Not a permitted operation.' },
          { target: 'world.not.aRealPath', operation: 'add', value: 0.1, decay: 'none', durationQuarters: 2, reason: 'Not a real path.' },
          { target: 'company.cmp_nowhere.reputationPublic', operation: 'add', value: -5, decay: 'none', durationQuarters: 2, reason: 'No such company.' },
          { target: 'world.compute.spotPrice', operation: 'multiply', value: 1.15, decay: 'linear', durationQuarters: 3, reason: 'Buyers bid up spot capacity.' },
        ],
        rationale: 'A supply shock is the most legible consequence of the packaging failure the engine drew.',
        confidence: 0.8,
      },
    ],
  });

  it('clamps severity into the band, validates every modifier and records each rejection', () => {
    const state = makeState();
    forceFamily(state, 'fam_compute_supply');
    const harness = makeContext(2, 'gm');
    const economy = createEconomySubsystem();
    const candidates = economy.computeEventCandidates(state, harness.ctx);
    const candidate = candidates.find((entry) => entry.familyId === 'fam_compute_supply');
    expect(candidate).toBeDefined();
    if (candidate === undefined) return;

    economy.applyGmProposals(state, batchFor(candidate.candidateId, candidate.familyId), candidates, harness.ctx);

    const event = state.activeEvents.find((entry) => entry.familyId === 'fam_compute_supply');
    expect(event).toBeDefined();
    expect(event?.severity).toBeLessThanOrEqual(0.8); // the family's band maximum
    expect(event?.affectedSectorIds).toEqual(['semiconductors']); // the unknown sector was dropped

    const rejections = harness.events.filter((entry) => entry.type === 'modifier_rejected');
    const reasons = rejections.map((entry) => entry.payload['reason']);
    expect(reasons).toContain('operation_not_permitted');
    expect(reasons).toContain('unknown_target_path');
    expect(reasons).toContain('unknown_entity');

    // The 0.1x supply operand is far outside the budget and comes back clamped.
    const supply = state.activeModifiers.find((entry) => entry.target === 'world.compute.acceleratorSupply');
    expect(supply).toBeDefined();
    expect(supply?.value).toBeCloseTo(1 - DEFAULT_IMPACT_BUDGET.maxSingleModifierMagnitude, 9);
    expect(state.eventHazards['fam_compute_supply']?.cooldownRemaining).toBe(4);
    assertReportIsWellFormed(harness);
  });

  it('never fires more events or more severity than the difficulty budget allows', () => {
    const state = makeState({ config: { ...makeState().config, difficulty: 'sandbox' } });
    const budget = IMPACT_BUDGET_BY_DIFFICULTY.sandbox;
    for (const definition of EVENT_FAMILY_DEFINITIONS) forceFamily(state, definition.family.id);

    const harness = makeContext(2, 'budget');
    const economy = createEconomySubsystem();
    const candidates = economy.computeEventCandidates(state, harness.ctx);
    expect(candidates.length).toBeLessThanOrEqual(budget.maxEventsPerQuarter);

    const batch: GmProposalBatch = {
      quarterSummary: 'Everything happens at once, and the budget refuses most of it.',
      proposals: candidates.map((candidate) => ({
        event: {
          candidateId: candidate.candidateId,
          familyId: candidate.familyId,
          type: candidate.allowedTypes[0] ?? 'other',
          titleKey: 'a_test_event',
          title: candidate.familyLabel,
          description: 'An event contextualised by the test harness so the validator has something to chew on.',
          severity: 1,
          visibility: 'public',
          durationQuarters: 12,
          causalParentId: null,
          affectedSectorIds: [],
        },
        modifiers: [],
        rationale: 'Testing that the impact budget is the ceiling, not the suggestion.',
        confidence: 0.9,
      })),
    };
    economy.applyGmProposals(state, batch, candidates, harness.ctx);

    const fired = state.activeEvents.filter((event) => event.quarter === 2);
    expect(fired.length).toBeLessThanOrEqual(budget.maxEventsPerQuarter);
    expect(fired.reduce((sum, event) => sum + event.severity, 0)).toBeLessThanOrEqual(budget.maxTotalSeverity + 1e-9);
  });
});

/* -------------------------------------------------------------------------- */
/*  Whole-phase determinism                                                    */
/* -------------------------------------------------------------------------- */

describe('the world phase as a whole', () => {
  it('is byte-identical across two runs from the same state and seed', () => {
    const runOnce = (): { state: SessionState; events: string } => {
      const state = makeState();
      const events: string[] = [];
      for (let quarter = 1; quarter <= 8; quarter += 1) {
        const harness = runWorldPhase(state, quarter, `world-${quarter}`);
        events.push(payloadsOf(harness.events));
        assertReportIsWellFormed(harness);
      }
      return { state, events: events.join('|') };
    };

    const first = runOnce();
    const second = runOnce();
    expect(JSON.stringify(first.state)).toBe(JSON.stringify(second.state));
    expect(first.events).toBe(second.events);
  });

  it('survives twenty chaotic quarters with every world value in bounds', () => {
    const state = makeState({ config: { ...makeState().config, difficulty: 'brutal' } });
    for (let quarter = 1; quarter <= 20; quarter += 1) {
      for (const definition of EVENT_FAMILY_DEFINITIONS) forceFamily(state, definition.family.id);
      runWorldPhase(state, quarter, `chaos-${quarter}`);
      const parsed = WorldStateSchema.safeParse(state.world);
      expect(parsed.success, `quarter ${quarter}: ${parsed.success ? '' : JSON.stringify(parsed.error.issues)}`).toBe(true);
      for (const company of state.companies) {
        expect(Number.isFinite(company.reputation.public)).toBe(true);
        expect(company.reputation.public).toBeGreaterThanOrEqual(0);
        expect(company.reputation.public).toBeLessThanOrEqual(100);
      }
      for (const sector of Object.values(state.sectors)) {
        expect(sector.sentiment).toBeGreaterThanOrEqual(-1);
        expect(sector.sentiment).toBeLessThanOrEqual(1);
        expect(sector.multiple).toBeGreaterThan(0);
      }
    }
  });
});

/* -------------------------------------------------------------------------- */
/*  The compute cycle                                                          */
/* -------------------------------------------------------------------------- */

describe('accelerator supply', () => {
  /** Resolve `quarters` baseline quarters of the demo world and trace the compute domain. */
  function traceSupply(seed: number, quarters: number): { supply: number[]; spot: number[] } {
    const engine = createDefaultEngine();
    let state = createDemoSession(seed);
    const supply: number[] = [];
    const spot: number[] = [];
    for (let quarter = 0; quarter < quarters; quarter += 1) {
      const outcome = engine.resolver.resolveQuarter(state, [], null, []);
      expect(`q${quarter} committed: ${outcome.committed}`).toBe(`q${quarter} committed: true`);
      state = outcome.nextState;
      supply.push(state.world.compute.acceleratorSupply);
      spot.push(state.world.compute.spotPrice);
    }
    return { supply, spot };
  }

  it('recovers after the shortage families have decayed, on every seed', () => {
    // Three event families multiply this path down and none multiplies it back
    // up. Without a supply-side response to price it is a one-way ratchet to
    // zero: the crunch becomes permanent, every reservation is pinned at the
    // floor and the compute pillar stops being a decision.
    for (const seed of [424242, 99991, 31337]) {
      const { supply } = traceSupply(seed, 24);
      const late = supply.slice(12);
      expect(`seed ${seed}: floor ${Math.min(...supply) > 0.05}`).toBe(`seed ${seed}: floor true`);
      expect(`seed ${seed}: recovers ${Math.max(...late) >= 0.35}`).toBe(`seed ${seed}: recovers true`);
    }
  }, 60_000);

  it('turns a shortage into capacity: the supply target rises with the spot price', () => {
    const cheap = makeState();
    const dear = makeState();
    cheap.world.compute.spotPrice = 1;
    dear.world.compute.spotPrice = 3;
    for (const state of [cheap, dear]) {
      state.world.compute.acceleratorSupply = 0.1;
      state.world.compute.fabCapacity = 0.2;
    }

    driftWorld(cheap.world, makeRng('supply-cheap'));
    driftWorld(dear.world, makeRng('supply-cheap'));

    expect(dear.world.compute.acceleratorSupply).toBeGreaterThan(cheap.world.compute.acceleratorSupply);
    expect(dear.world.compute.fabCapacity).toBeGreaterThan(cheap.world.compute.fabCapacity);
  });
});
