/**
 * Product categories: the industry-line catalogue wired into the engine.
 *
 * Four things are under test, matching the stage's own scope:
 *
 * 1. **World 1 reads the segment tables exactly as it always did.** No
 *    category is ever resolved there, `Product.categoryId` is never written,
 *    and the frozen hash (pinned in `world2Scenario.test.ts`) does not move.
 * 2. **A launch is gated on its category's `requiresNodeIds`.** Refused
 *    without the node, accepted once it is achieved.
 * 3. **`invest_capacity` behaves exactly like `buy_accelerators` did**: refused
 *    in world 1, noted rather than refused for cash in world 2, staged by the
 *    product phase and settled by the financial phase into `ppe` and the
 *    matching capacity bucket, with a real `sim_event` and a reconciling
 *    balance sheet.
 * 4. **Capacity rations demand by kind.** A plant-kind product with no
 *    capacity is rationed; investing relieves it — "the same words it uses
 *    for compute", now for another kind.
 */

import { describe, expect, it } from 'vitest';
import type { ActionIntent, SessionState, SubmittedAction } from '@frontier/contracts';
import {
  PRODUCT_CATEGORIES,
  SECTORS,
  defaultCategoryFor,
} from '@frontier/contracts';
import { hashState } from '@frontier/shared';
import { createDefaultEngine } from '../src/engine';
import { createActionValidator } from '../src/validator';
import { createDemoSession, DEMO_CHARACTERS, DEMO_COMPANIES, DEMO_PLAYER_ID } from '../src/scenario';
import { createWorld2Session, W2_AI_NODES, W2_COMPANIES } from '../src/scenario/world2';
import { categoryOf, capacityUsd } from '../src/companies/categories';
import { isMultiSectorWorld } from '../src/economy/sectors';

const PLAYER_COMPANY = 'cmp_player_ventures';
const PLAYER_CHARACTER = 'chr_avery_sinclair';

function world2(): SessionState {
  return createWorld2Session();
}

const companyOf = (state: SessionState, id: string) => {
  const company = state.companies.find((entry) => entry.id === id);
  if (company === undefined) throw new Error(`no company ${id}`);
  return company;
};

let sequence = 0;

function act(state: SessionState, intent: ActionIntent, companyId = PLAYER_COMPANY, characterId = PLAYER_CHARACTER): SubmittedAction {
  sequence += 1;
  return {
    actionId: `act_categories_${sequence}`,
    sessionId: state.sessionId,
    quarter: state.quarter,
    sequence,
    actorPlayerId: DEMO_PLAYER_ID,
    actorCompanyId: companyId,
    actorCharacterId: characterId,
    origin: 'player_ui',
    intent,
    confirmedByHuman: true,
  };
}

function withCash(state: SessionState, cashUsd: number, companyId = PLAYER_COMPANY): SessionState {
  const company = companyOf(state, companyId);
  const added = cashUsd - company.balanceSheet.assets.cash;
  company.balanceSheet.assets.cash = cashUsd;
  company.balanceSheet.equity += added;
  company.financials.cash = cashUsd;
  return state;
}

function resolveOne(state: SessionState, actions: readonly SubmittedAction[]) {
  const engine = createDefaultEngine();
  const outcome = engine.resolver.resolveQuarter(state, [...actions], null, []);
  const failures = outcome.invariants.filter((result) => !result.passed).map((result) => `${result.invariant}: ${result.detail}`);
  expect(failures).toEqual([]);
  expect(outcome.committed).toBe(true);
  return outcome;
}

/* -------------------------------------------------------------------------- */
/*  The catalogue as the engine reads it                                      */
/* -------------------------------------------------------------------------- */

describe('categoryOf', () => {
  it('never resolves a category in world 1, and never writes categoryId onto a product', () => {
    const state = createDemoSession();
    const company = companyOf(state, DEMO_COMPANIES.player);
    expect(isMultiSectorWorld(state)).toBe(false);
    for (const product of company.products) {
      expect(product.categoryId).toBeUndefined();
    }
  });

  it('resolves every world-2 seed product to a category that matches its company\'s sector', () => {
    const state = world2();
    for (const company of state.companies) {
      for (const product of company.products) {
        const category = categoryOf(company, product);
        expect(category.sector).toBe(company.sector);
      }
    }
  });

  it('derives a category on read for a product that carries no categoryId, without writing it back', () => {
    const state = world2();
    const company = companyOf(state, W2_COMPANIES.tessellate ?? state.companies[0]!.id);
    const product = company.products[0]!;
    const original = product.categoryId;
    // Strip it, exactly as an old save (or a pre-catalogue product) would.
    delete (product as { categoryId?: string }).categoryId;
    const derived = categoryOf(company, product);
    expect(derived.id).toBe(defaultCategoryFor(company.sector, product.segment));
    // Read-only: the strip is still in effect.
    expect(product.categoryId).toBeUndefined();
    // Restore, so this test does not leak state into another fixture instance
    // (createWorld2Session() is called fresh per test, but keep this honest).
    if (original !== undefined) product.categoryId = original;
  });

  it('every world-2 node a category requires actually exists on the world-2 graph', () => {
    const state = world2();
    const nodeIds = new Set(state.techGraph.nodes.map((node) => node.id));
    for (const category of PRODUCT_CATEGORIES) {
      for (const nodeId of category.requiresNodeIds) {
        expect(nodeIds.has(nodeId), `${category.id} requires unknown node ${nodeId}`).toBe(true);
      }
    }
  });

  it('defaultCategoryFor is total: every sector has an entry for every segment', () => {
    const state = world2();
    for (const sector of SECTORS) {
      for (const segment of ['consumer', 'enterprise', 'developer_api', 'government'] as const) {
        const id = defaultCategoryFor(sector, segment);
        expect(state.techGraph.nodes).toBeDefined(); // graph loaded; id itself checked below
        expect(PRODUCT_CATEGORIES.some((entry) => entry.id === id && entry.sector === sector)).toBe(true);
      }
    }
  });
});

/* -------------------------------------------------------------------------- */
/*  Launch gated on requiresNodeIds                                           */
/* -------------------------------------------------------------------------- */

describe('launch_product and requiresNodeIds', () => {
  it('is refused for a category whose node the company has not achieved', () => {
    const state = withCash(world2(), 50_000_000);
    const gated = PRODUCT_CATEGORIES.find((entry) => entry.requiresNodeIds.length > 0);
    if (gated === undefined) throw new Error('no gated category in the catalogue to test against');
    const validator = createActionValidator();
    const [result] = validator.validateBatch(state, [
      act(state, {
        type: 'launch_product',
        name: 'Gated Line Probe',
        segment: gated.buyerSegment,
        categoryId: gated.id,
        pricePerSeatUsd: gated.referencePriceUsd,
        computeIntensity: gated.computeIntensityBaseline,
        launchMarketingUsd: 100_000,
        targetQuality: 0.5,
        supply: [],
      }),
    ]);
    expect(result?.status).toBe('rejected');
    expect(result?.codes).toContain('requirement_not_met');
  });

  it('is accepted once every required node is achieved', () => {
    const state = withCash(world2(), 50_000_000);
    const gated = PRODUCT_CATEGORIES.find((entry) => entry.requiresNodeIds.length > 0);
    if (gated === undefined) throw new Error('no gated category in the catalogue to test against');
    for (const nodeId of gated.requiresNodeIds) {
      const node = state.techGraph.nodes.find((entry) => entry.id === nodeId);
      expect(node, `node ${nodeId} missing from the world-2 graph`).toBeDefined();
      if (node === undefined) continue;
      node.status = 'achieved';
      node.achievedByCompanyId = PLAYER_COMPANY;
      node.achievedQuarter = 0;
    }
    const validator = createActionValidator();
    const [result] = validator.validateBatch(state, [
      act(state, {
        type: 'launch_product',
        name: 'Unlocked Line Probe',
        segment: gated.buyerSegment,
        categoryId: gated.id,
        pricePerSeatUsd: gated.referencePriceUsd,
        computeIntensity: gated.computeIntensityBaseline,
        launchMarketingUsd: 100_000,
        targetQuality: 0.5,
        supply: [],
      }),
    ]);
    expect(result?.status).not.toBe('rejected');
  });

  it('a null categoryId resolves to the sector/segment default and lands on the launched product', () => {
    const state = withCash(world2(), 50_000_000);
    const outcome = resolveOne(state, [
      act(state, {
        type: 'launch_product',
        name: 'Default Line Probe',
        segment: 'consumer',
        categoryId: null,
        pricePerSeatUsd: 20,
        computeIntensity: 0.2,
        launchMarketingUsd: 50_000,
        targetQuality: 0.4,
        supply: [],
      }),
    ]);
    const company = companyOf(outcome.nextState, PLAYER_COMPANY);
    const launched = company.products.find((product) => product.name === 'Default Line Probe');
    expect(launched).toBeDefined();
    expect(launched?.categoryId).toBe(defaultCategoryFor(company.sector, 'consumer'));
  });
});

/* -------------------------------------------------------------------------- */
/*  invest_capacity                                                            */
/* -------------------------------------------------------------------------- */

describe('invest_capacity', () => {
  it('is refused outright in world 1', () => {
    const state = createDemoSession();
    const validator = createActionValidator();
    const [result] = validator.validateBatch(state, [
      {
        actionId: 'act_w1_capacity',
        sessionId: state.sessionId,
        quarter: state.quarter,
        sequence: 1,
        actorPlayerId: DEMO_PLAYER_ID,
        actorCompanyId: DEMO_COMPANIES.player,
        actorCharacterId: DEMO_CHARACTERS.player,
        origin: 'player_ui',
        intent: { type: 'invest_capacity', kind: 'plant', amountUsd: 1_000_000 },
        confirmedByHuman: true,
      },
    ]);
    expect(result?.status).toBe('rejected');
    expect(result?.codes).toContain('requirement_not_met');
  });

  it('notes cash rather than refusing or clamping it in world 2', () => {
    const state = withCash(world2(), 10_000);
    const validator = createActionValidator();
    const [result] = validator.validateBatch(state, [act(state, { type: 'invest_capacity', kind: 'plant', amountUsd: 5_000_000 })]);
    expect(result?.status).not.toBe('rejected');
    if (result?.status === 'clamped') {
      expect(result.clampedAction).toMatchObject({ type: 'invest_capacity', amountUsd: 5_000_000 });
    }
  });

  it('lands the capex in ppe and in the matching capacity bucket, with a reconciling balance sheet and a sim_event', () => {
    const state = withCash(world2(), 20_000_000);
    const before = companyOf(state, PLAYER_COMPANY);
    const ppeBefore = before.balanceSheet.assets.ppe;
    const plantBefore = capacityUsd(before, 'plant');

    const outcome = resolveOne(state, [act(state, { type: 'invest_capacity', kind: 'plant', amountUsd: 3_000_000 })]);

    const invested = outcome.events.find((event) => event.type === 'capacity_invested' && event.actorId === PLAYER_COMPANY);
    expect(invested).toBeDefined();
    expect(invested?.payload).toMatchObject({ kind: 'plant', amountUsd: 3_000_000 });

    const after = companyOf(outcome.nextState, PLAYER_COMPANY);
    expect(after.balanceSheet.assets.ppe).toBeGreaterThan(ppeBefore);
    expect(capacityUsd(after, 'plant')).toBeGreaterThan(plantBefore);
    // Settled: nothing pending survives into a committed state.
    expect(after.capacity?.pendingInvestments ?? []).toEqual([]);
  });

  it('resolves twice from the same seed to the same hash', () => {
    const build = () => withCash(world2(), 20_000_000);
    const run = (state: SessionState) => resolveOne(state, [act(state, { type: 'invest_capacity', kind: 'grid', amountUsd: 4_000_000 })]).nextState;
    expect(hashState(run(build()))).toBe(hashState(run(build())));
  });
});

/* -------------------------------------------------------------------------- */
/*  Capacity rations demand by kind                                           */
/* -------------------------------------------------------------------------- */

describe('capacity rationing by kind', () => {
  it('rations a plant-kind product with no capacity, and relieves it once invested', () => {
    const plantCategory = PRODUCT_CATEGORIES.find((entry) => entry.capacityKind === 'plant' && entry.requiresNodeIds.length === 0);
    if (plantCategory === undefined) throw new Error('no ungated plant-kind category to test against');

    const state = withCash(world2(), 200_000_000);
    const company = companyOf(state, PLAYER_COMPANY);
    // A real customer base to ration, well past what zero capacity can serve.
    company.products.push({
      id: 'prd_capacity_probe',
      name: 'Capacity Probe',
      segment: plantCategory.buyerSegment,
      categoryId: plantCategory.id,
      pricePerSeat: plantCategory.referencePriceUsd,
      activeCustomers: 400,
      churnQuarterly: plantCategory.churnBand.min,
      growthQuarterly: 0,
      grossMarginPct: plantCategory.grossMarginBaselinePct,
      computeIntensity: plantCategory.computeIntensityBaseline,
      qualityScore: 0.6,
      launchedQuarter: 0,
      isActive: true,
    });
    // company.capacity stays absent: an untracked kind is unconstrained (see
    // rationCapacityByKind's own comment), so seed a zero bucket explicitly to
    // put the company on the tracked, rationed side of that line.
    company.capacity = { plantUsd: 0, fleetUsd: 0, gridUsd: 0 };

    const constrainedOutcome = resolveOne(state, []);
    const constrained = constrainedOutcome.nextState.companies.find((entry) => entry.id === PLAYER_COMPANY)!;
    const probeAfter = constrained.products.find((product) => product.id === 'prd_capacity_probe');
    expect(probeAfter).toBeDefined();
    // Zero tracked capacity: nothing new is served, and the ledger says why.
    const constraintRow = constrainedOutcome.events.find(
      (event) => event.type === 'cost_recognised' && event.actorId === PLAYER_COMPANY && (event.payload as { capacityKind?: string }).capacityKind === 'plant',
    );
    expect(constraintRow).toBeDefined();

    // Invest enough plant capacity to serve the base, and it clears.
    const relieved = withCash(world2(), 200_000_000);
    const relievedCompany = companyOf(relieved, PLAYER_COMPANY);
    relievedCompany.products.push({
      id: 'prd_capacity_probe',
      name: 'Capacity Probe',
      segment: plantCategory.buyerSegment,
      categoryId: plantCategory.id,
      pricePerSeat: plantCategory.referencePriceUsd,
      activeCustomers: 400,
      churnQuarterly: plantCategory.churnBand.min,
      growthQuarterly: 0,
      grossMarginPct: plantCategory.grossMarginBaselinePct,
      computeIntensity: plantCategory.computeIntensityBaseline,
      qualityScore: 0.6,
      launchedQuarter: 0,
      isActive: true,
    });
    const neededUsd = (400 / plantCategory.capacityYieldPerUnit) * 1_000_000 * 3;
    relievedCompany.capacity = { plantUsd: neededUsd, fleetUsd: 0, gridUsd: 0 };
    const relievedOutcome = resolveOne(relieved, []);
    const relievedAfter = relievedOutcome.nextState.companies.find((entry) => entry.id === PLAYER_COMPANY)!;
    const relievedProbe = relievedAfter.products.find((product) => product.id === 'prd_capacity_probe');
    expect(relievedProbe).toBeDefined();
    if (probeAfter !== undefined && relievedProbe !== undefined) {
      expect(relievedProbe.activeCustomers).toBeGreaterThanOrEqual(probeAfter.activeCustomers);
    }
  });
});

/* -------------------------------------------------------------------------- */
/*  Statements carry the line                                                 */
/* -------------------------------------------------------------------------- */

describe('filed statements carry the category', () => {
  it('every product line in a filed statement carries a categoryId and a unit', () => {
    let state = world2();
    const engine = createDefaultEngine();
    for (let quarter = 0; quarter < 2; quarter += 1) {
      const outcome = engine.resolver.resolveQuarter(state, [], null, []);
      expect(outcome.committed).toBe(true);
      state = outcome.nextState;
    }
    let sawALine = false;
    for (const company of state.companies) {
      for (const entry of company.financialHistory ?? []) {
        for (const line of entry.productLines ?? []) {
          sawALine = true;
          expect(line.categoryId).toBeDefined();
          expect(line.unit).toBeDefined();
        }
      }
    }
    expect(sawALine).toBe(true);
  });
});
