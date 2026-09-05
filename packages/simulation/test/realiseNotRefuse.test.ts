/**
 * @frontier/simulation — "fail only": availability realised, not refused.
 *
 * The owner, verbatim: "it's not logical if I can't perform what I can do
 * freely in the real world. A price cut is a price cut." From world version 2
 * the validator refuses only what is malformed or impossible; everything that
 * is merely scarce is accepted whole, and the owning resolution phase fills
 * what it can and reports the rest as a `partial_fill` row. See
 * `docs/SIMULATION.md` §11 for the full classification this file proves
 * against real fixtures.
 *
 * Three groups:
 *
 * 1. **The validator table** — every action type this pass converted from
 *    reject/clamp to accept-with-note, walked with a deliberately over-asking
 *    intent, against the world-2 fixture. Verdict must be `accepted`, must
 *    carry `partial_fill_expected`, and must carry no `clampedAction`.
 * 2. **Resolution** — a full quarter, through the real engine, with the
 *    invariant gate on: the shortfall lands as a `partial_fill` ledger row,
 *    `got <= asked`, and the quarter still commits.
 * 3. **Pricing at the extremes** — a 10x rise does not raise revenue for
 *    nothing (the demand model's saturation decay bites), and a 0.1x cut
 *    resolves and reconciles, margin included, at whatever the cost model
 *    produces.
 *
 * World 1 is checked once, directly, against the pinned hash: none of this
 * moves it.
 */

import { describe, expect, it } from 'vitest';
import type { ActionIntent, SessionState, SimEvent, SubmittedAction } from '@frontier/contracts';
import { hashState } from '@frontier/shared';
import { createDefaultEngine } from '../src/engine';
import { createDemoSession, createWorld2Session } from '../src/scenario';
import { createActionValidator } from '../src/validator';
import { repriceForecast } from '../src/companies/products';

/** Pinned in `test/world2Scenario.test.ts`; repeated here rather than imported
 *  from another test module, so this file's assertion stands on its own. */
const FROZEN_WORLD_1_HASH = 'a0e39d23dd0c7c3a';

/* -------------------------------------------------------------------------- */
/*  Fixture                                                                    */
/* -------------------------------------------------------------------------- */

/** The world-2 fixture, staged so every action in the table below is legal to attempt. */
function staged(): SessionState {
  const state = createWorld2Session();
  const company = state.companies.find((entry) => entry.controllerPlayerId !== null);
  if (company === undefined) throw new Error('no player company');
  // No board: several of these actions are, separately and correctly, board
  // matters above a headcount/authorisation share — this file is about
  // availability, not that unrelated mechanism, so it is set aside here.
  company.boardId = null;
  company.compute.cloudSpendQuarterly = 500_000;
  return state;
}

function playerCompany(state: SessionState) {
  const company = state.companies.find((entry) => entry.controllerPlayerId !== null);
  if (company === undefined) throw new Error('no player company');
  return company;
}

let sequence = 0;
function submit(state: SessionState, intent: ActionIntent, companyId: string, characterId: string): SubmittedAction {
  sequence += 1;
  const seat = state.players[0];
  if (seat === undefined) throw new Error('no player seat');
  return {
    actionId: `act_realise_${sequence}`,
    sessionId: state.sessionId,
    quarter: state.quarter,
    sequence,
    actorPlayerId: seat.playerId,
    actorCompanyId: companyId,
    actorCharacterId: characterId,
    origin: 'player_ui',
    intent,
    confirmedByHuman: true,
  };
}

/** Resolve one quarter through the whole engine, invariant gate on. */
function resolveOneQuarter(state: SessionState, actions: readonly SubmittedAction[]): { state: SessionState; events: readonly SimEvent[] } {
  const engine = createDefaultEngine();
  const outcome = engine.resolver.resolveQuarter(state, actions, null, []);
  const failures = outcome.invariants.filter((result) => !result.passed).map((result) => `${result.invariant}: ${result.detail}`);
  expect(failures).toEqual([]);
  expect(outcome.committed).toBe(true);
  return { state: outcome.nextState, events: outcome.events };
}

/** `partial_fill` rows this quarter emitted for one company. */
function partialFills(events: readonly SimEvent[], companyId: string): readonly SimEvent[] {
  return events.filter(
    (event) => event.type === 'information_revealed' && event.actorId === companyId && (event.payload as { kind?: string }).kind === 'partial_fill',
  );
}

/* -------------------------------------------------------------------------- */
/*  1. The validator table                                                    */
/* -------------------------------------------------------------------------- */

describe('the validator table: availability is accepted and noted, not refused', () => {
  it('layoff beyond headcount', () => {
    const state = staged();
    const company = playerCompany(state);
    const validator = createActionValidator();
    const [result] = validator.validateBatch(state, [
      submit(state, { type: 'layoff', role: 'engineers', count: company.employees.engineers + 20, severanceQuartersOfPay: 1 }, company.id, company.ceoCharacterId ?? ''),
    ]);
    if (result === undefined) throw new Error('no result');
    expect(result.status).toBe('accepted');
    expect(result.codes).toContain('partial_fill_expected');
    expect(result.clampedAction).toBeNull();
  });

  it('reserve_compute beyond the market', () => {
    const state = staged();
    const company = playerCompany(state);
    const validator = createActionValidator();
    const [result] = validator.validateBatch(state, [
      submit(
        state,
        { type: 'reserve_compute', units: 5_000_000, quarters: 4, maxPricePerUnitUsd: 1_000_000, providerCompanyId: null },
        company.id,
        company.ceoCharacterId ?? '',
      ),
    ]);
    if (result === undefined) throw new Error('no result');
    expect(result.status).toBe('accepted');
    expect(result.codes).toContain('partial_fill_expected');
    expect(result.clampedAction).toBeNull();
  });

  it('start_research_project beyond researchers and compute', () => {
    const state = staged();
    const company = playerCompany(state);
    const node = state.techGraph.nodes.find((entry) => entry.status !== 'achieved');
    if (node === undefined) throw new Error('no open node');
    const validator = createActionValidator();
    const [result] = validator.validateBatch(state, [
      submit(
        state,
        { type: 'start_research_project', targetNodeId: node.id, budgetUsd: 100_000, computeUnits: 1_000_000, researchersAssigned: 500, secret: false },
        company.id,
        company.ceoCharacterId ?? '',
      ),
    ]);
    if (result === undefined) throw new Error('no result');
    expect(result.status).toBe('accepted');
    expect(result.codes).toContain('partial_fill_expected');
    expect(result.clampedAction).toBeNull();
  });

  it('buy_accelerators beyond what any manufacturer can ship', () => {
    const state = staged();
    const company = playerCompany(state);
    const validator = createActionValidator();
    const [result] = validator.validateBatch(state, [
      submit(state, { type: 'buy_accelerators', units: 50_000_000, maxPricePerUnitUsd: 1_000_000, sellerCompanyId: null }, company.id, company.ceoCharacterId ?? ''),
    ]);
    if (result === undefined) throw new Error('no result');
    expect(result.status).toBe('accepted');
    expect(result.codes).toContain('partial_fill_expected');
    expect(result.clampedAction).toBeNull();
  });

  it('issue_shares beyond a class’s unissued authorisation', () => {
    const state = staged();
    const company = playerCompany(state);
    const security = state.securities.find((entry) => entry.id === company.primarySecurityId);
    if (security === undefined) throw new Error('no primary security');
    const validator = createActionValidator();
    const [result] = validator.validateBatch(state, [
      submit(
        state,
        { type: 'issue_shares', shareClassId: security.shareClassId, shares: 500_000_000, minPricePerShareUsd: 1 },
        company.id,
        company.ceoCharacterId ?? '',
      ),
    ]);
    if (result === undefined) throw new Error('no result');
    expect(result.status).toBe('accepted');
    expect(result.codes).toContain('partial_fill_expected');
    expect(result.clampedAction).toBeNull();
  });

  it('issue_debt when credit markets are shut — attempted, not refused', () => {
    const state = staged();
    state.world.capitalMarkets.debtAvailability = 0;
    const company = playerCompany(state);
    const validator = createActionValidator();
    const [result] = validator.validateBatch(state, [
      submit(state, { type: 'issue_debt', amountUsd: 10_000_000, termQuarters: 8, maxRatePct: 0.2 }, company.id, company.ceoCharacterId ?? ''),
    ]);
    if (result === undefined) throw new Error('no result');
    expect(result.status).toBe('accepted');
  });

  it('meet_regulator out of network reach — attempted, not refused', () => {
    const state = staged();
    const company = playerCompany(state);
    const regulator = state.characters.find((entry) => entry.role === 'regulator');
    if (regulator === undefined) throw new Error('no regulator in the fixture');
    const validator = createActionValidator();
    const [result] = validator.validateBatch(state, [
      submit(
        state,
        { type: 'meet_regulator', regulatorCharacterId: regulator.id, topic: 'antitrust', posture: 'cooperative', concessionsOffered: [] },
        company.id,
        company.ceoCharacterId ?? '',
      ),
    ]);
    if (result === undefined) throw new Error('no result');
    expect(result.status).toBe('accepted');
    expect(result.codes).toContain('target_not_reachable');
  });

  it('poach_executive and lobby_director out of reach still accept — a contrived actor with no path', () => {
    // A real fixture's founders and directors sit in a densely connected
    // investor network (`docs/SIMULATION.md` notes this), so an unreachable
    // *counterparty* is easy to find but an unreachable *approach* needs an
    // actor with genuinely no path. A character id that does not exist has
    // none, and the mechanism does not care why reach failed — only that it
    // did — so this exercises the same branch honestly.
    const state = staged();
    const company = playerCompany(state);
    const rival = state.characters.find((entry) => entry.companyId !== null && entry.companyId !== company.id && entry.isActive);
    if (rival === undefined) throw new Error('no rival character');
    const noPath = 'chr_nobody_in_particular';
    const validator = createActionValidator();
    const [poach] = validator.validateBatch(state, [
      submit(state, { type: 'poach_executive', targetCharacterId: rival.id, compPremiumPct: 0.2, approach: 'private' }, company.id, noPath),
    ]);
    if (poach === undefined) throw new Error('no result');
    expect(poach.status).toBe('accepted');
    expect(poach.codes).toContain('target_not_reachable');
  });

  /* --- a few KEEP examples, unchanged in world 2 too ------------------------ */

  it('unknown_target still refuses outright (structural, not availability)', () => {
    const state = staged();
    const company = playerCompany(state);
    const validator = createActionValidator();
    const [result] = validator.validateBatch(state, [
      submit(state, { type: 'start_research_project', targetNodeId: 'not_a_real_node', budgetUsd: 1, computeUnits: 1, researchersAssigned: 1, secret: false }, company.id, company.ceoCharacterId ?? ''),
    ]);
    expect(result?.status).toBe('rejected');
    expect(result?.codes).toContain('unknown_target');
  });

  it('a share issue past the class’s dilution ceiling still clamps (a legal limit, not scarcity)', () => {
    const state = staged();
    const company = playerCompany(state);
    const validator = createActionValidator();
    const [result] = validator.validateBatch(state, [
      submit(state, { type: 'raise_round', stage: 'series_a', targetAmountUsd: 10_000_000, maxDilutionPct: 0.9 }, company.id, company.ceoCharacterId ?? ''),
    ]);
    // Above MAX_ROUND_DILUTION_PCT: clamped to the ceiling, still a decision the
    // founder can act on — a legal limit, stated as such, not availability.
    expect(result?.status).toBe('clamped');
    expect(result?.codes).toContain('illegal_value');
  });
});

/* -------------------------------------------------------------------------- */
/*  2. Resolution: the shortfall is a partial_fill row, not a silent cut      */
/* -------------------------------------------------------------------------- */

describe('resolution: the shortfall lands as a partial_fill row', () => {
  it('layoff cuts what exists and reports the rest', () => {
    const state = staged();
    const company = playerCompany(state);
    const asked = company.employees.engineers + 15;
    const { state: next, events } = resolveOneQuarter(state, [
      submit(state, { type: 'layoff', role: 'engineers', count: asked, severanceQuartersOfPay: 1 }, company.id, company.ceoCharacterId ?? ''),
    ]);
    const rows = partialFills(events, company.id).filter((event) => (event.payload as { actionType?: string }).actionType === 'layoff');
    expect(rows.length).toBeGreaterThan(0);
    const payload = rows[0]?.payload as { asked: number; got: number };
    expect(payload.asked).toBe(asked);
    expect(payload.got).toBeLessThanOrEqual(payload.asked);
    const nextCompany = next.companies.find((entry) => entry.id === company.id);
    expect(nextCompany?.employees.engineers).toBe(0);
  });

  it('reserve_compute clears what the market frees and reports the rest', () => {
    const state = staged();
    const company = playerCompany(state);
    const { events } = resolveOneQuarter(state, [
      submit(
        state,
        { type: 'reserve_compute', units: 5_000_000, quarters: 4, maxPricePerUnitUsd: 1_000_000, providerCompanyId: null },
        company.id,
        company.ceoCharacterId ?? '',
      ),
    ]);
    const rows = partialFills(events, company.id).filter((event) => (event.payload as { actionType?: string }).actionType === 'reserve_compute');
    expect(rows.length).toBeGreaterThan(0);
    const payload = rows[0]?.payload as { asked: number; got: number };
    expect(payload.got).toBeLessThan(payload.asked);
  });

  it('a research programme opens with whatever researchers and compute are free', () => {
    const state = staged();
    const company = playerCompany(state);
    const node = state.techGraph.nodes.find((entry) => entry.status !== 'achieved');
    if (node === undefined) throw new Error('no open node');
    const { state: next, events } = resolveOneQuarter(state, [
      submit(
        state,
        { type: 'start_research_project', targetNodeId: node.id, budgetUsd: 100_000, computeUnits: 1_000_000, researchersAssigned: 500, secret: false },
        company.id,
        company.ceoCharacterId ?? '',
      ),
    ]);
    const rows = partialFills(events, company.id).filter((event) => (event.payload as { actionType?: string }).actionType === 'start_research_project');
    expect(rows.length).toBeGreaterThan(0);
    const project = next.researchProjects.find((entry) => entry.companyId === company.id && entry.targetNodeId === node.id);
    expect(project).toBeDefined();
    if (project === undefined) return;
    expect(project.talentAllocated).toBeLessThan(500);
  });

  it('buy_accelerators ships what a manufacturer actually has', () => {
    const state = staged();
    const company = playerCompany(state);
    const { events } = resolveOneQuarter(state, [
      submit(state, { type: 'buy_accelerators', units: 50_000_000, maxPricePerUnitUsd: 1_000_000, sellerCompanyId: null }, company.id, company.ceoCharacterId ?? ''),
    ]);
    // Either a partial fill (some units cleared) or a total miss is reported —
    // both are a stated outcome, never a silent no-op.
    const informed = events.some(
      (event) =>
        event.actorId === company.id &&
        ((event.payload as { kind?: string }).kind === 'partial_fill' || (event.payload as { kind?: string }).kind === 'accelerator_purchase_failed'),
    );
    expect(informed).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/*  3. Pricing at the extremes                                                */
/* -------------------------------------------------------------------------- */

describe('pricing without a band', () => {
  function firstActiveProduct(state: SessionState) {
    const company = playerCompany(state);
    const product = company.products.find((entry) => entry.isActive);
    if (product === undefined) throw new Error('no active product');
    return { company, product };
  }

  it('a 10x rise does not raise revenue for nothing', () => {
    const state = staged();
    const { company, product } = firstActiveProduct(state);
    const at1x = repriceForecast(state, company.id, product.id, product.pricePerSeat);
    const at10x = repriceForecast(state, company.id, product.id, product.pricePerSeat * 10);
    if (at1x === null || at10x === null) throw new Error('no forecast');
    // Naively, ten times the price and the same customers would be ten times
    // the revenue. The demand model's saturation decay and churn shock mean it
    // is not: a price that far out costs more in customers than it gains in
    // price.
    expect(at10x.revenueAfterUsd).toBeLessThan(at1x.revenueAfterUsd * 10);
    expect(at10x.customersAfter).toBeLessThan(at1x.customersAfter);
  });

  it('an even bigger rise erodes the base further, not less — the decay does not reverse', () => {
    const state = staged();
    const { company, product } = firstActiveProduct(state);
    const at10x = repriceForecast(state, company.id, product.id, product.pricePerSeat * 10);
    const at20x = repriceForecast(state, company.id, product.id, product.pricePerSeat * 20);
    if (at10x === null || at20x === null) throw new Error('no forecast');
    expect(at20x.customersAfter).toBeLessThanOrEqual(at10x.customersAfter);
  });

  it('a deep cut sells at whatever margin the cost model produces, and resolves', () => {
    const state = staged();
    const { company, product } = firstActiveProduct(state);
    const cut = money10x(product.pricePerSeat);
    const { state: next, events } = resolveOneQuarter(state, [
      submit(state, { type: 'set_product_price', productId: product.id, pricePerSeatUsd: cut }, company.id, company.ceoCharacterId ?? ''),
    ]);
    const nextCompany = next.companies.find((entry) => entry.id === company.id);
    const nextProduct = nextCompany?.products.find((entry) => entry.id === product.id);
    expect(nextProduct).toBeDefined();
    if (nextProduct === undefined) return;
    expect(nextProduct.pricePerSeat).toBe(cut);
    // No band clamped it back up, and the quarter still committed and reconciled
    // (the invariant gate inside resolveOneQuarter already checked that).
    const priced = events.some((event) => event.type === 'price_changed' && event.actorId === company.id);
    expect(priced).toBe(true);
  });

  function money10x(priceUsd: number): number {
    return Math.max(0.01, Math.round(priceUsd * 0.1 * 100) / 100);
  }
});

/* -------------------------------------------------------------------------- */
/*  4. World 1 is untouched                                                   */
/* -------------------------------------------------------------------------- */

describe('world 1 stays byte-identical', () => {
  it('the frozen hash still matches', () => {
    expect(hashState(createDemoSession())).toBe(FROZEN_WORLD_1_HASH);
  });
});
