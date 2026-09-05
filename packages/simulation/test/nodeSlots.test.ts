/**
 * @frontier/simulation — the chain is the product: fills, cells and routes.
 *
 * What is proved here is the second half of the owner's ask, on the engine
 * side: that WHICH model, WHICH harness and WHICH company sit in a line's slots
 * changes the number the profit and loss books and the quality the market
 * judges, and that WHO a line is aimed at decides which pool it sells from.
 *
 * 1. **Composition moves the books.** The same consumer app on rival A's
 *    inference API and on rival B's books a different unit cost and a
 *    different quality after one resolution.
 * 2. **A switch costs a quarter.** Refilling the model slot dips quality in the
 *    quarter of the switch and recovers the next, with `changedQuarter`
 *    written on the fill rather than remembered in any set.
 * 3. **MAKE is a choice.** A fill naming a rival prices as a buy even when the
 *    company runs its own line on that node, and the company's own line costs
 *    what it always cost.
 * 4. **Target decides the pool.** The same product aimed at two industries
 *    draws different orders; aimed at a cell its node's market gives no
 *    weight, it draws nothing and is told so in a row rather than refused.
 * 5. **Industry size scales business demand.** The size factor follows the
 *    logistics sector's revenue against its baseline, and reads neutral with
 *    no baseline at all.
 * 6. **Publishing works.** Any node line may publish terms, and a rival sees
 *    it as a route next quarter; `fill_slot` and `set_target_market` are the
 *    actions that change a line, with the validator refusing only the
 *    impossible and clamping a source that cannot supply to the open market.
 * 7. **Rivals compose too.** A company nobody directs publishes every node
 *    line at its list price and refills its slots by quality per dollar,
 *    byte-identically across two runs, sticky below the switch threshold.
 *
 * Every fixture strips the seeded lines so the only lines in the world are the
 * ones a test puts there. Nothing here draws a random number outside the
 * production pass's own single draw per line.
 */

import { describe, expect, it } from 'vitest';
import type { ActionIntent, ActionValidationResult, Company, Product, ResolverContext, SessionState, SubmittedAction } from '@frontier/contracts';
import { economicNodeById, type EconomicNode } from '@frontier/contracts';
import { createRng } from '@frontier/shared';
import { createWorld3Session } from '../src/scenario/world3';
import { resolveProducts } from '../src/companies/products';
import { applyNodeDefaults } from '../src/companies/npc';
import { NPC_SLOT_SETTLE_QUARTERS, NPC_SLOT_SWITCH_THRESHOLD, npcFillFor, npcSupplyTermsFor, scoredSlotOptions } from '../src/companies/npcSlots';
import { priceNodes, cellEndDemandUnits, industrySizeFactors, marketCellWeight, marketCellsOf, nodeBalances } from '../src/graph/market';
import { effectiveQuality, resolveNodeProduction } from '../src/graph/production';
import { OPEN_MARKET_PREMIUM, unitCostOf } from '../src/graph/cost';
import { createNodeCostCache } from '../src/graph/lines';
import { SWITCH_QUALITY_FACTOR, cellKey, cellOf, resolveFill, resolveFills, slotForInput, targetOf, withFill } from '../src/graph/slots';
import { nodeSellersFor, slotOptions } from '../src/graph/options';
import { validateAction } from '../src/validator/index';
import { BatchBudget } from '../src/validator/context';
import { availableActionsFor } from '../src/validator/availability';

/* -------------------------------------------------------------------------- */
/*  Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

const APP = 'app_consumer_subscription';
const API = 'svc_inference_api';
const FRONTIER = 'sys_frontier_model';
const SMALL = 'sys_efficient_small_model';
const ARM = 'sys_industrial_arm';
const WAFER = 'mat_wafer_300mm';
const DIE = 'cmp_logic_die';
const CHEMICALS = 'res_fab_chemicals';

describe('the table these tests are pinned to', () => {
  it('still carries the slots they fill', () => {
    expect(economicNodeById(APP)?.slots.map((slot) => slot.id)).toEqual(['model', 'harness', 'data', 'delivery']);
    expect(economicNodeById(API)?.slots.map((slot) => `${slot.id}:${slot.role}`)).toEqual(['model:model']);
    expect(economicNodeById(DIE)?.slots.map((slot) => slot.id)).toEqual(['wafer']);
    expect(economicNodeById(ARM)?.market.customers.government ?? 0).toBe(0);
    expect(economicNodeById(ARM)?.market.industries.manufacturing ?? 0).toBeGreaterThan(economicNodeById(ARM)?.market.industries.consumer ?? 0);
  });
});

function lineOn(nodeId: string, units: number, priceUsd: number, quality = 0.6): Product {
  return {
    id: `prd_${nodeId}`,
    name: nodeId,
    segment: 'enterprise',
    nodeId,
    pricePerSeat: priceUsd,
    activeCustomers: units,
    unitsSoldQuarterly: units,
    installedBase: 0,
    backlogUnits: 0,
    contractBilledUsd: 0,
    unitCostUsd: 0,
    churnQuarterly: 0.05,
    growthQuarterly: 0,
    grossMarginPct: 0.4,
    computeIntensity: 0.5,
    qualityScore: quality,
    craftQuality: quality,
    qualityTier: 0.5,
    launchedQuarter: 0,
    isActive: true,
  };
}

/** The seeded world with every line removed; ownership and prices as built. */
function bareWorld(): SessionState {
  const state = createWorld3Session();
  for (const company of state.companies) {
    company.products = [];
    company.capacity = { plantUsd: 0, fleetUsd: 0, gridUsd: 0 };
  }
  state.governmentContracts = [];
  state.researchProjects = [];
  return state;
}

/** Give `company` a published, open line on `nodeId`. */
function publishLine(company: Company, nodeId: string, askUsd: number, quality: number, id = `prd_${nodeId}_${company.id}`): Product {
  const product = lineOn(nodeId, 1_000, askUsd, quality);
  product.id = id;
  product.supplyTerms = { openToAll: true, pricePerUnitUsd: askUsd, exclusiveCustomerIds: [], blockedCustomerIds: [] };
  company.products.push(product);
  if (!(company.ownedNodes ?? []).includes(nodeId)) company.ownedNodes = [...(company.ownedNodes ?? []), nodeId];
  return product;
}

function fillOn(slotId: string, nodeId: string, supplierCompanyId: string | null, supplierProductId: string | null, changedQuarter: number | null = null) {
  return { slotId, nodeId, supplierCompanyId, supplierProductId, cutOffNoticeQuarter: null, changedQuarter };
}

/** A context that records what a phase emitted and said. */
function recorder(quarter: number) {
  const events: { type: string; payload: Record<string, unknown> }[] = [];
  const lines: string[] = [];
  let counter = 0;
  const ctx: ResolverContext = {
    quarter,
    rng: createRng(`node_slots_q${quarter}`),
    emit(draft) {
      events.push({ type: draft.type, payload: draft.payload });
      counter += 1;
      return `evt_${counter}`;
    },
    log(line) {
      lines.push(line.text);
    },
  };
  return { events, lines, ctx };
}

/** One quarter of the two world-3 phases that make and judge a line. */
function runQuarter(state: SessionState, quarter: number) {
  state.quarter = quarter;
  const { events, lines, ctx } = recorder(quarter);
  priceNodes(state, ctx);
  resolveProducts(state, ctx);
  return { events, lines };
}

/**
 * A consumer app line on a consumer company, with two rival AI companies each
 * publishing an inference API: A's on the frontier model, B's on the small one.
 */
function twoApis(): { state: SessionState; app: Company; rivalA: Company; rivalB: Company; apiA: Product; apiB: Product } {
  const state = bareWorld();
  const app = state.companies.find((company) => company.sector === 'consumer') as Company;
  const [rivalA, rivalB] = state.companies.filter((company) => company.sector === 'ai' && company.id !== app.id) as [Company, Company];
  app.region = 'north_america';
  rivalA.region = 'north_america';
  rivalB.region = 'north_america';
  app.ownedNodes = [...(app.ownedNodes ?? []), APP];
  const apiA = publishLine(rivalA, API, 9, 0.8);
  apiA.slots = [fillOn('model', FRONTIER, null, null)];
  const apiB = publishLine(rivalB, API, 6, 0.5);
  apiB.slots = [fillOn('model', SMALL, null, null)];
  return { state, app, rivalA, rivalB, apiA, apiB };
}

/* -------------------------------------------------------------------------- */
/*  0. Resolution                                                              */
/* -------------------------------------------------------------------------- */

describe('resolveFill', () => {
  it('resolves a slot with no fill to the table\'s default on the open market', () => {
    const state = bareWorld();
    const company = state.companies[0] as Company;
    const node = economicNodeById(API) as EconomicNode;
    const fill = resolveFill(state, company, null, node, node.slots[0]!);
    expect(fill).toMatchObject({ slotId: 'model', nodeId: FRONTIER, route: 'market', supplierCompanyId: null, supplierProductId: null, askUsd: null, changedThisQuarter: false });
  });

  it('makes when the company runs its own line and nothing says otherwise', () => {
    const state = bareWorld();
    const company = state.companies[0] as Company;
    company.products = [lineOn(WAFER, 100, 14_000)];
    const die = economicNodeById(DIE) as EconomicNode;
    expect(resolveFill(state, company, null, die, die.slots[0]!).route).toBe('make');
    // A fill naming the company itself says the same thing.
    const product = lineOn(DIE, 0, 500);
    product.slots = [fillOn('wafer', WAFER, company.id, 'prd_mat_wafer_300mm')];
    expect(resolveFill(state, company, product, die, die.slots[0]!)).toMatchObject({ route: 'make', supplierProductId: 'prd_mat_wafer_300mm' });
  });

  it('falls back to the default when a fill names a node the slot does not admit, and to the market when a named seller is not selling', () => {
    const state = bareWorld();
    const company = state.companies[0] as Company;
    const rival = state.companies[1] as Company;
    const api = economicNodeById(API) as EconomicNode;
    const product = lineOn(API, 0, 10);
    product.slots = [fillOn('model', WAFER, null, null)];
    expect(resolveFill(state, company, product, api, api.slots[0]!).nodeId).toBe(FRONTIER);
    // A seller with no published terms is not a seller.
    rival.products = [lineOn(FRONTIER, 1, 20_000_000)];
    product.slots = [fillOn('model', FRONTIER, rival.id, 'prd_sys_frontier_model')];
    expect(resolveFill(state, company, product, api, api.slots[0]!).route).toBe('market');
    // Published, and it is a buy at the published ask.
    (rival.products[0] as Product).supplyTerms = { openToAll: true, pricePerUnitUsd: 19_000_000, exclusiveCustomerIds: [], blockedCustomerIds: [] };
    expect(resolveFill(state, company, product, api, api.slots[0]!)).toMatchObject({ route: 'buy', supplierCompanyId: rival.id, askUsd: 19_000_000 });
  });

  it('leaves an optional slot empty and blocks a blocking slot nobody in the world can fill', () => {
    const state = bareWorld();
    const company = state.companies[0] as Company;
    const app = economicNodeById(APP) as EconomicNode;
    const delivery = app.slots.find((slot) => slot.id === 'delivery')!;
    expect(resolveFill(state, company, null, app, delivery)).toMatchObject({ nodeId: null, route: 'empty' });

    const die = economicNodeById(DIE) as EconomicNode;
    for (const candidate of state.companies) candidate.ownedNodes = (candidate.ownedNodes ?? []).filter((id) => id !== WAFER);
    expect(resolveFill(state, company, null, die, die.slots[0]!).route).toBe('blocked');
  });

  it('names the slot an input node belongs to, preferring the one it already sits in', () => {
    const app = economicNodeById(APP) as EconomicNode;
    expect(slotForInput(app, [], API)?.id).toBe('model');
    expect(slotForInput(app, [], 'svc_copilot_framework')?.id).toBe('harness');
    expect(slotForInput(app, [], 'sys_consumer_device')?.id).toBe('delivery');
    expect(slotForInput(app, [], WAFER)).toBeNull();
  });

  it('stamps changedQuarter only when the node or the source actually moves', () => {
    const before = [fillOn('model', API, 'cmp_a', 'prd_a')];
    expect(withFill(before, 'model', API, 'cmp_a', 'prd_a', 5).changed).toBe(false);
    const moved = withFill(before, 'model', API, 'cmp_b', 'prd_b', 5);
    expect(moved.changed).toBe(true);
    expect(moved.fills.find((fill) => fill.slotId === 'model')?.changedQuarter).toBe(5);
  });
});

/* -------------------------------------------------------------------------- */
/*  1. Composition moves the books                                             */
/* -------------------------------------------------------------------------- */

describe('the same app on two different APIs', () => {
  it('books a different unit cost and a different quality after one resolution', () => {
    const onA = twoApis();
    const onB = twoApis();
    const lineA = lineOn(APP, 200_000, 30, 0.6);
    lineA.segment = 'consumer';
    lineA.slots = [fillOn('model', API, onA.rivalA.id, onA.apiA.id)];
    onA.app.products = [lineA];
    const lineB = lineOn(APP, 200_000, 30, 0.6);
    lineB.segment = 'consumer';
    lineB.slots = [fillOn('model', API, onB.rivalB.id, onB.apiB.id)];
    onB.app.products = [lineB];

    runQuarter(onA.state, 0);
    runQuarter(onB.state, 0);
    const bookedA = onA.app.products[0] as Product;
    const bookedB = onB.app.products[0] as Product;

    expect(bookedA.unitCostUsd).toBeGreaterThan(0);
    expect(bookedB.unitCostUsd).toBeGreaterThan(0);
    // A asks 9 a unit against B's 6: the dearer API is the dearer app.
    expect(bookedA.unitCostUsd).toBeGreaterThan(bookedB.unitCostUsd ?? 0);
    // A's API is the better one, and the app inherits that by value share.
    expect(bookedA.qualityScore).toBeGreaterThan(bookedB.qualityScore);
    // The row says which slot, which node and which company.
    const rowA = unitCostOf(onA.state, onA.app, APP).lines.find((line) => line.key === 'slot:model');
    expect(rowA).toMatchObject({ slotId: 'model', nodeId: API, sourceKind: 'buy', sourceCompanyId: onA.rivalA.id });
  });

  it('shows both APIs as candidates of the model slot, with the filled one chosen', () => {
    const { state, app, rivalA, rivalB, apiA } = twoApis();
    const line = lineOn(APP, 1_000, 30);
    line.segment = 'consumer';
    line.slots = [fillOn('model', API, rivalA.id, apiA.id)];
    app.products = [line];
    const model = slotOptions(state, app, APP, line.id).find((slot) => slot.slotId === 'model');
    const candidate = model?.candidates.find((entry) => entry.nodeId === API);
    expect(candidate?.routes.filter((route) => route.kind === 'buy').map((route) => route.supplierCompanyId).sort()).toEqual([rivalA.id, rivalB.id].sort());
    expect(candidate?.routes.find((route) => route.chosen)?.supplierCompanyId).toBe(rivalA.id);
  });
});

/* -------------------------------------------------------------------------- */
/*  2. A switch costs a quarter                                                */
/* -------------------------------------------------------------------------- */

describe('switching the model slot', () => {
  it('dips quality in the quarter of the switch and recovers the next, with changedQuarter on the fill', () => {
    const { state, app, rivalA, rivalB, apiA, apiB } = twoApis();
    // Two sellers of the same quality, so the only thing a switch can do is cost.
    apiA.qualityScore = 0.7;
    apiB.qualityScore = 0.7;
    const line = lineOn(APP, 200_000, 30, 0.6);
    line.segment = 'consumer';
    line.slots = [fillOn('model', API, rivalA.id, apiA.id)];
    app.products = [line];

    runQuarter(state, 0);
    const settled = (app.products[0] as Product).qualityScore;

    // The switch, written the way `choose_supplier` writes it: the fill moves
    // and carries the quarter it moved in.
    const switched = withFill(line.slots ?? [], 'model', API, rivalB.id, apiB.id, 1);
    line.slots = [...switched.fills];
    expect(line.slots.find((fill) => fill.slotId === 'model')?.changedQuarter).toBe(1);
    const cost = unitCostOf(state, app, APP, createNodeCostCache(state));
    const fills = resolveFills(state, app, line, economicNodeById(APP) as EconomicNode);
    expect(fills.find((fill) => fill.slotId === 'model')?.changedThisQuarter).toBe(false);
    state.quarter = 1;
    const during = resolveFills(state, app, line, economicNodeById(APP) as EconomicNode);
    expect(during.find((fill) => fill.slotId === 'model')?.changedThisQuarter).toBe(true);
    // The switched input delivers at the factor, and only this quarter.
    const base = effectiveQuality(state, app, line, economicNodeById(APP) as EconomicNode, cost, undefined, fills);
    const dipped = effectiveQuality(state, app, line, economicNodeById(APP) as EconomicNode, cost, undefined, during);
    expect(dipped).toBeLessThan(base);
    expect(SWITCH_QUALITY_FACTOR).toBe(0.7);

    runQuarter(state, 1);
    const inSwitch = (app.products[0] as Product).qualityScore;
    runQuarter(state, 2);
    const recovered = (app.products[0] as Product).qualityScore;
    expect(inSwitch).toBeLessThan(settled);
    expect(recovered).toBeGreaterThan(inSwitch);
    // Persisted: the fill still says when it changed, and nothing else moved it.
    expect((app.products[0] as Product).slots?.find((fill) => fill.slotId === 'model')).toMatchObject({ supplierCompanyId: rivalB.id, changedQuarter: 1 });
  });
});

/* -------------------------------------------------------------------------- */
/*  3. MAKE is a choice                                                        */
/* -------------------------------------------------------------------------- */

describe('declining to make', () => {
  it('prices a rival-named fill as a buy beside the company\'s own line, and leaves that line\'s cost alone', () => {
    const state = bareWorld();
    const maker = state.companies[0] as Company;
    const seller = state.companies[1] as Company;
    maker.region = 'north_america';
    seller.region = 'north_america';
    maker.ownedNodes = [...(maker.ownedNodes ?? []), WAFER, DIE];
    maker.products = [lineOn(WAFER, 1_000, 14_000), lineOn(DIE, 1_000, 500)];
    const sellerWafer = publishLine(seller, WAFER, 13_000, 0.7);

    const cache = createNodeCostCache(state);
    const ownWaferBefore = unitCostOf(state, maker, WAFER, cache).unitCostUsd;
    const madeIn = unitCostOf(state, maker, DIE, cache);
    expect(madeIn.lines.find((line) => line.key === 'slot:wafer')?.sourceKind).toBe('make');

    // Decline MAKE: the die's wafer slot names the rival.
    const die = maker.products[1] as Product;
    die.slots = [fillOn('wafer', WAFER, seller.id, sellerWafer.id)];
    const fresh = createNodeCostCache(state);
    const bought = unitCostOf(state, maker, DIE, fresh);
    const row = bought.lines.find((line) => line.key === 'slot:wafer');
    expect(row?.sourceKind).toBe('buy');
    expect(row?.sourceCompanyId).toBe(seller.id);
    expect(bought.madeInHouseSharePct).toBe(0);
    // The company's own wafer line costs exactly what it did.
    expect(unitCostOf(state, maker, WAFER, fresh).unitCostUsd).toBe(ownWaferBefore);
    // And the launch screen offers the make route, chosen no longer, rather than hiding it.
    const wafer = slotOptions(state, maker, DIE, die.id, fresh).find((slot) => slot.slotId === 'wafer');
    const candidate = wafer?.candidates.find((entry) => entry.nodeId === WAFER);
    expect(candidate?.routes.find((route) => route.kind === 'make')?.chosen).toBe(false);
    expect(candidate?.routes.find((route) => route.kind === 'buy')?.chosen).toBe(true);
  });

  it('costs a line that has never filled a slot exactly what the default recipe costs', () => {
    const state = bareWorld();
    const maker = state.companies[0] as Company;
    maker.region = 'north_america';
    maker.products = [lineOn(WAFER, 1_000, 14_000)];
    const untouched = unitCostOf(state, maker, WAFER).unitCostUsd;
    (maker.products[0] as Product).slots = [];
    expect(unitCostOf(state, maker, WAFER).unitCostUsd).toBe(untouched);
    // The chemicals slot on the open market: settled price plus the premium.
    const chemicals = unitCostOf(state, maker, WAFER).lines.find((line) => line.key === 'slot:chemicals');
    expect(chemicals?.unitPriceUsd).toBeCloseTo((economicNodeById(CHEMICALS)?.basePriceUsd ?? 0) * OPEN_MARKET_PREMIUM, 6);
  });
});

/* -------------------------------------------------------------------------- */
/*  4. Target decides the pool                                                 */
/* -------------------------------------------------------------------------- */

describe('the target market', () => {
  it('is the product\'s own customer type and industry, collapsing the public to one cell', () => {
    const arm = economicNodeById(ARM) as EconomicNode;
    const aimed = lineOn(ARM, 0, 40_000);
    aimed.targetIndustry = 'logistics';
    expect(targetOf(aimed, arm)).toBe('logistics');
    expect(cellOf(aimed, arm)).toEqual({ industry: 'logistics', customer: 'enterprise' });
    // Unaimed: the market's heaviest industry, ties in SECTORS order.
    expect(targetOf(lineOn(ARM, 0, 40_000), arm)).toBe('manufacturing');
    const consumer = lineOn(APP, 0, 30);
    consumer.segment = 'consumer';
    consumer.targetIndustry = 'energy';
    expect(cellOf(consumer, economicNodeById(APP) as EconomicNode)).toEqual({ industry: 'consumer', customer: 'consumer' });
    // The cells of a node sum to one.
    for (const nodeId of [ARM, APP, API, 'sys_autonomous_drone']) {
      const node = economicNodeById(nodeId) as EconomicNode;
      const total = marketCellsOf(node).reduce((sum, cell) => sum + cell.weight, 0);
      expect(total).toBeCloseTo(1, 6);
    }
  });

  it('gives the same product different pools and different units when it is aimed at two industries', () => {
    const run = (industry: 'manufacturing' | 'consumer') => {
      const state = bareWorld();
      const maker = state.companies.find((company) => company.sector === 'robotics') as Company;
      maker.region = 'north_america';
      maker.ownedNodes = [...(maker.ownedNodes ?? []), ARM];
      const line = lineOn(ARM, 0, 40_000);
      line.targetIndustry = industry;
      maker.products = [line];
      // Plant enough that demand, not capacity, decides what ships.
      maker.capacity = { plantUsd: 50_000_000_000, fleetUsd: 0, gridUsd: 0 };
      const { events } = runQuarter(state, 0);
      const row = events.find((event) => event.type === 'demand_resolved')?.payload ?? {};
      return { units: line.unitsSoldQuarterly ?? 0, orders: row.ordersDesired as number, industry: row.industry, pool: nodeBalances(state)[ARM]?.cells[cellKey(industry, 'enterprise')] ?? 0 };
    };
    const manufacturing = run('manufacturing');
    const consumer = run('consumer');
    expect(manufacturing.industry).toBe('manufacturing');
    expect(consumer.industry).toBe('consumer');
    // Manufacturing carries four times the weight consumer goods do for an arm.
    expect(manufacturing.pool).toBeGreaterThan(consumer.pool * 3);
    expect(manufacturing.orders).toBeGreaterThan(consumer.orders);
    expect(manufacturing.units).toBeGreaterThan(consumer.units);
    expect(consumer.units).toBeGreaterThan(0);
  });

  it('gives a zero-weight cell no pool, and says so in a row rather than refusing', () => {
    const state = bareWorld();
    const maker = state.companies.find((company) => company.sector === 'robotics') as Company;
    maker.region = 'north_america';
    maker.ownedNodes = [...(maker.ownedNodes ?? []), ARM];
    const line = lineOn(ARM, 0, 40_000);
    line.segment = 'government';
    maker.products = [line];
    maker.capacity = { plantUsd: 50_000_000_000, fleetUsd: 0, gridUsd: 0 };
    expect(marketCellWeight(economicNodeById(ARM) as EconomicNode, 'manufacturing', 'government')).toBe(0);

    const { events, lines } = runQuarter(state, 0);
    expect(line.unitsSoldQuarterly).toBe(0);
    const advisory = events.find((event) => event.type === 'information_revealed' && event.payload.kind === 'market_cell_empty');
    expect(advisory?.payload).toMatchObject({ productId: line.id, nodeId: ARM, customer: 'government' });
    expect(lines.some((text) => text.includes('do not buy'))).toBe(true);
    // Still a live, active line: nothing was refused or closed.
    expect(line.isActive).toBe(true);
  });

  it('lands a buyer\'s derived demand in the buyer\'s own industry as an enterprise', () => {
    const state = bareWorld();
    const buyer = state.companies.find((company) => company.sector === 'logistics') as Company;
    buyer.products = [lineOn(DIE, 1_000_000, 500)];
    const balances = nodeBalances(state);
    const wafer = balances[WAFER];
    expect(wafer?.cells[cellKey('logistics', 'enterprise')]).toBeCloseTo(1_000_000 * 0.022, 6);
    expect(wafer?.derivedDemandUnits).toBeCloseTo(1_000_000 * 0.022, 6);
    // The per-node total is the sum of its cells: the price index keeps its shape.
    const total = Object.values(wafer?.cells ?? {}).reduce((sum, units) => sum + units, 0);
    expect(total).toBeCloseTo(wafer?.demandUnits ?? -1, 6);
  });
});

/* -------------------------------------------------------------------------- */
/*  5. Industry size                                                           */
/* -------------------------------------------------------------------------- */

describe('the size factor', () => {
  it('follows the logistics sector\'s revenue against its baseline, for business customers only', () => {
    const state = bareWorld();
    const die = economicNodeById('cmp_electric_drivetrain') as EconomicNode;
    expect(die.market.industries.logistics ?? 0).toBeGreaterThan(0);

    // No baseline: neutral everywhere.
    delete state.industryBaselineUsd;
    const neutral = industrySizeFactors(state);
    expect(Object.values(neutral).every((factor) => factor === 1)).toBe(true);
    const before = cellEndDemandUnits(state, die, 'logistics', 'enterprise');

    // A baseline written as if logistics were twice as large at seed as it is now.
    const revenue = state.companies.filter((company) => company.sector === 'logistics').reduce((sum, company) => sum + company.fundamentals.revenueTtmUsd, 0);
    expect(revenue).toBeGreaterThan(0);
    state.industryBaselineUsd = { logistics: revenue * 2 } as SessionState['industryBaselineUsd'];
    const shrunk = industrySizeFactors(state);
    expect(shrunk.logistics).toBeCloseTo(0.5, 6);
    expect(shrunk.ai).toBe(1);
    expect(cellEndDemandUnits(state, die, 'logistics', 'enterprise')).toBeCloseTo(before * 0.5, 6);

    // Logistics grows: the factor moves with it, and is clamped at two.
    for (const company of state.companies) if (company.sector === 'logistics') company.fundamentals.revenueTtmUsd *= 8;
    expect(industrySizeFactors(state).logistics).toBe(2);
    expect(cellEndDemandUnits(state, die, 'logistics', 'enterprise')).toBeCloseTo(before * 2, 6);
    // The public and the state do not scale with an industry's size.
    const drone = economicNodeById('sys_autonomous_drone') as EconomicNode;
    expect(marketCellWeight(drone, 'logistics', 'government')).toBeGreaterThan(0);
    const government = cellEndDemandUnits(state, drone, 'logistics', 'government');
    state.industryBaselineUsd = { logistics: revenue * 8 * 4 } as SessionState['industryBaselineUsd'];
    expect(industrySizeFactors(state).logistics).toBeCloseTo(0.5, 6);
    expect(cellEndDemandUnits(state, drone, 'logistics', 'government')).toBeCloseTo(government, 6);
    expect(cellEndDemandUnits(state, drone, 'logistics', 'enterprise')).toBeLessThan(cellEndDemandUnits({ ...state, industryBaselineUsd: undefined } as SessionState, drone, 'logistics', 'enterprise'));
  });
});

/* -------------------------------------------------------------------------- */
/*  6. The production pass on fills                                            */
/* -------------------------------------------------------------------------- */

describe('the production pass', () => {
  it('reads blocking on the node actually in the slot, and ships nothing while it is blocked', () => {
    const state = bareWorld();
    const maker = state.companies[0] as Company;
    maker.region = 'north_america';
    maker.ownedNodes = [...(maker.ownedNodes ?? []), DIE];
    maker.products = [lineOn(DIE, 1_000, 500)];
    maker.capacity = { plantUsd: 1_000_000_000, fleetUsd: 0, gridUsd: 0 };
    for (const candidate of state.companies) candidate.ownedNodes = (candidate.ownedNodes ?? []).filter((id) => id !== WAFER);
    const { events, ctx } = recorder(0);
    priceNodes(state, ctx);
    resolveNodeProduction(state, ctx, { marketingByProduct: new Map(), shockByProduct: new Map() });
    expect(maker.products[0]?.unitsSoldQuarterly).toBe(0);
    const row = events.find((event) => event.type === 'demand_resolved')?.payload;
    expect(row).toMatchObject({ supplyBlocked: true, blockedInputNodeIds: [WAFER], industry: 'robotics', segment: 'enterprise' });
  });
});

/* -------------------------------------------------------------------------- */
/*  7. Publishing, the composition actions and the rivals that compose        */
/* -------------------------------------------------------------------------- */

let sequence = 0;

/** A submitted action for `company`, attributed to its own chief executive; queued for the state's current quarter. */
function submitted(state: SessionState, company: Company, intent: ActionIntent): SubmittedAction {
  sequence += 1;
  return {
    actionId: `act_slots_${sequence}`,
    sessionId: state.sessionId,
    quarter: state.quarter,
    sequence,
    actorPlayerId: null,
    actorCompanyId: company.id,
    actorCharacterId: company.ceoCharacterId ?? 'chr_x',
    origin: 'npc_strategist',
    intent,
    confirmedByHuman: false,
  };
}

/** Validate one intent for `company` as its own chief executive. */
function verdictFor(state: SessionState, company: Company, intent: ActionIntent): ActionValidationResult {
  return validateAction(
    state,
    intent,
    { playerId: null, companyId: company.id, characterId: company.ceoCharacterId ?? 'chr_x', confirmedByHuman: true },
    new BatchBudget(),
    `probe_${intent.type}`,
  );
}

const launchOf = (nodeId: string, slots: Extract<ActionIntent, { type: 'launch_product' }>['slots'], targetIndustry: Extract<ActionIntent, { type: 'launch_product' }>['targetIndustry'] = null): ActionIntent => ({
  type: 'launch_product',
  name: `Composed ${nodeId}`,
  segment: 'enterprise',
  categoryId: nodeId,
  pricePerSeatUsd: 30,
  computeIntensity: 0.8,
  launchMarketingUsd: 0,
  targetQuality: 0.6,
  supply: [],
  targetIndustry,
  slots,
});

describe('publishing in world 3', () => {
  it('lets any node line publish terms, whatever the world-2 catalogue says, and a rival sees it as a route next quarter', () => {
    const state = bareWorld();
    const seller = state.companies.find((company) => company.sector === 'ai') as Company;
    const buyer = state.companies.find((company) => company.sector === 'consumer') as Company;
    seller.region = 'north_america';
    buyer.region = 'north_america';
    seller.ownedNodes = [...(seller.ownedNodes ?? []), API];
    const api = lineOn(API, 1_000, 9, 0.8);
    seller.products = [api];
    buyer.ownedNodes = [...(buyer.ownedNodes ?? []), APP];
    const app = lineOn(APP, 1_000, 30);
    app.segment = 'consumer';
    buyer.products = [app];

    // Nobody sells the API to the buyer yet.
    expect(nodeSellersFor(state, buyer.id, API)).toHaveLength(0);

    const publish: ActionIntent = { type: 'set_supply_terms', productId: api.id, terms: { openToAll: true, pricePerUnitUsd: 9, exclusiveCustomerIds: [], blockedCustomerIds: [] } };
    const verdict = verdictFor(state, seller, publish);
    expect(verdict.status, verdict.reasons.join(' | ')).toBe('accepted');

    state.pendingActions.push(submitted(state, seller, publish));
    const { events } = runQuarter(state, 0);
    expect(api.supplyTerms).toEqual({ openToAll: true, pricePerUnitUsd: 9, exclusiveCustomerIds: [], blockedCustomerIds: [] });
    expect(events.some((event) => event.type === 'cost_recognised' && event.payload.kind === 'supply_started' && event.payload.productId === api.id)).toBe(true);

    // Next quarter the line is a route the rival can pick for its model slot.
    state.quarter = 1;
    const model = slotOptions(state, buyer, APP, app.id).find((slot) => slot.slotId === 'model');
    const route = model?.candidates.find((entry) => entry.nodeId === API)?.routes.find((entry) => entry.kind === 'buy');
    // The route carries the seller's quality as the production pass rewrote it, not the fixture's number.
    expect(route).toMatchObject({ kind: 'buy', supplierCompanyId: seller.id, supplierProductId: api.id, qualityScore: api.qualityScore });
  });

  it('refuses to publish a line that produces no node, and the probe offers every node line at its list price', () => {
    const state = bareWorld();
    const company = state.companies.find((entry) => entry.sector === 'ai') as Company;
    // The probes are asked as the seat directing this company.
    company.controllerPlayerId = state.players[0]?.playerId ?? 'player_1';
    company.ownedNodes = [...(company.ownedNodes ?? []), API];
    const api = lineOn(API, 1_000, 9);
    const legacy: Product = { ...lineOn(API, 10, 100), id: 'prd_legacy', name: 'legacy' };
    delete legacy.nodeId;
    company.products = [api, legacy];
    const refused = verdictFor(state, company, { type: 'set_supply_terms', productId: legacy.id, terms: { openToAll: true, pricePerUnitUsd: 1, exclusiveCustomerIds: [], blockedCustomerIds: [] } });
    expect(refused.status).toBe('rejected');

    const probe = availableActionsFor(state, { playerId: company.controllerPlayerId ?? 'player_1', companyId: company.id, characterId: company.ceoCharacterId ?? 'chr_x' }).find(
      (entry) => entry.type === 'set_supply_terms',
    );
    expect(probe?.available).toBe(true);
    expect(probe?.targets.map((target) => target.id)).toEqual([api.id]);
    // And choose_supplier is reported unavailable, pointing at fill_slot.
    const legacyProbe = availableActionsFor(state, { playerId: company.controllerPlayerId ?? 'player_1', companyId: company.id, characterId: company.ceoCharacterId ?? 'chr_x' }).find(
      (entry) => entry.type === 'choose_supplier',
    );
    expect(legacyProbe?.available).toBe(false);
    expect(legacyProbe?.reason).toContain('fill_slot');
  });
});

describe('the composition actions', () => {
  it('refuses a second launch on a node the company already sells, and says to change its slots', () => {
    const state = bareWorld();
    const company = state.companies.find((entry) => entry.sector === 'consumer') as Company;
    company.ownedNodes = [...(company.ownedNodes ?? []), APP];
    company.products = [lineOn(APP, 1_000, 30)];
    const verdict = verdictFor(state, company, launchOf(APP, []));
    expect(verdict.status).toBe('rejected');
    expect(verdict.reasons.join(' ')).toContain('change its slots');
  });

  it('drops an off-table slot with a clamp, refuses an emptied required slot, and clamps a source that cannot supply to the open market', () => {
    const state = bareWorld();
    const company = state.companies.find((entry) => entry.sector === 'consumer') as Company;
    const rival = state.companies.find((entry) => entry.sector === 'ai') as Company;
    company.ownedNodes = [...(company.ownedNodes ?? []), APP];

    const offTable = verdictFor(state, company, launchOf(APP, [{ slotId: 'engine', nodeId: API, supplierCompanyId: null, supplierProductId: null }]));
    expect(offTable.status).toBe('clamped');
    expect((offTable.clampedAction as Extract<ActionIntent, { type: 'launch_product' }>).slots).toEqual([]);
    expect(offTable.reasons.join(' ')).toContain('no slot called "engine"');

    const emptied = verdictFor(state, company, launchOf(APP, [{ slotId: 'model', nodeId: null, supplierCompanyId: null, supplierProductId: null }]));
    expect(emptied.status).toBe('rejected');
    expect(emptied.reasons.join(' ')).toContain('cannot be left empty');

    // A seller with no line on the node falls to the open market; the node choice survives.
    const unsold = verdictFor(state, company, launchOf(APP, [{ slotId: 'model', nodeId: API, supplierCompanyId: rival.id, supplierProductId: 'prd_missing' }]));
    expect(unsold.status).toBe('clamped');
    const clamped = (unsold.clampedAction as Extract<ActionIntent, { type: 'launch_product' }>).slots;
    expect(clamped).toEqual([{ slotId: 'model', nodeId: API, supplierCompanyId: null, supplierProductId: null }]);
    expect(unsold.reasons.join(' ')).toContain('open market');

    // The world-2 supplier list is dropped in world 3 with a reason of its own.
    const legacy = verdictFor(state, company, {
      ...(launchOf(APP, []) as Extract<ActionIntent, { type: 'launch_product' }>),
      supply: [{ inputCategoryId: API, supplierCompanyId: null, supplierProductId: null }],
    });
    expect(legacy.status).toBe('clamped');
    expect((legacy.clampedAction as Extract<ActionIntent, { type: 'launch_product' }>).supply).toEqual([]);

    // A valid composition is accepted as it stands.
    const seller = publishLine(rival, API, 9, 0.8);
    const composed = verdictFor(state, company, launchOf(APP, [{ slotId: 'model', nodeId: API, supplierCompanyId: rival.id, supplierProductId: seller.id }], 'logistics'));
    expect(composed.status, composed.reasons.join(' | ')).toBe('accepted');
  });

  it('writes the launch\'s slots, target industry and quality tier onto the line', () => {
    const state = bareWorld();
    const company = state.companies.find((entry) => entry.sector === 'consumer') as Company;
    const rival = state.companies.find((entry) => entry.sector === 'ai') as Company;
    company.region = 'north_america';
    rival.region = 'north_america';
    company.ownedNodes = [...(company.ownedNodes ?? []), APP];
    const seller = publishLine(rival, API, 9, 0.8);
    state.pendingActions.push(submitted(state, company, launchOf(APP, [{ slotId: 'model', nodeId: API, supplierCompanyId: rival.id, supplierProductId: seller.id }], 'logistics')));
    runQuarter(state, 0);
    const launched = company.products.find((product) => product.nodeId === APP);
    expect(launched?.slots).toEqual([{ slotId: 'model', nodeId: API, supplierCompanyId: rival.id, supplierProductId: seller.id, cutOffNoticeQuarter: null, changedQuarter: null }]);
    expect(launched?.targetIndustry).toBe('logistics');
    expect(launched?.qualityTier).toBe(0.8);
    expect(launched !== undefined && cellOf(launched, economicNodeById(APP) as EconomicNode)).toEqual({ industry: 'logistics', customer: 'enterprise' });
  });

  it('fill_slot stamps changedQuarter and records slot_filled once; a re-stated fill changes nothing', () => {
    const { state, app, rivalA, rivalB, apiA, apiB } = twoApis();
    const line = lineOn(APP, 1_000, 30);
    line.segment = 'consumer';
    line.slots = [fillOn('model', API, rivalA.id, apiA.id)];
    app.products = [line];

    const fill: ActionIntent = { type: 'fill_slot', productId: line.id, slotId: 'model', nodeId: API, supplierCompanyId: rivalB.id, supplierProductId: apiB.id };
    expect(verdictFor(state, app, fill).status).toBe('accepted');
    // Refusals: a slot the node lacks, a node the slot does not take, an emptied required slot.
    expect(verdictFor(state, app, { ...fill, slotId: 'engine' } as ActionIntent).status).toBe('rejected');
    expect(verdictFor(state, app, { ...fill, nodeId: WAFER } as ActionIntent).status).toBe('rejected');
    expect(verdictFor(state, app, { ...fill, nodeId: null } as ActionIntent).status).toBe('rejected');
    // A seller closed to this buyer is clamped to the open market rather than refused.
    apiB.supplyTerms = { openToAll: false, pricePerUnitUsd: 6, exclusiveCustomerIds: [], blockedCustomerIds: [] };
    const closed = verdictFor(state, app, fill);
    expect(closed.status).toBe('clamped');
    expect(closed.clampedAction).toMatchObject({ supplierCompanyId: null, supplierProductId: null });
    apiB.supplyTerms = { openToAll: true, pricePerUnitUsd: 6, exclusiveCustomerIds: [], blockedCustomerIds: [] };
    // And the world-2 action is refused outright.
    expect(verdictFor(state, app, { type: 'choose_supplier', productId: line.id, inputCategoryId: API, supplierCompanyId: rivalB.id, supplierProductId: apiB.id }).reasons.join(' ')).toContain('fill_slot');

    state.quarter = 1;
    state.pendingActions.push(submitted(state, app, fill));
    const first = runQuarter(state, 1);
    expect(line.slots?.find((entry) => entry.slotId === 'model')).toMatchObject({ supplierCompanyId: rivalB.id, supplierProductId: apiB.id, changedQuarter: 1 });
    const filled = first.events.filter((event) => event.type === 'slot_filled');
    expect(filled).toHaveLength(1);
    expect(filled[0]?.payload).toMatchObject({ productId: line.id, nodeId: APP, slotId: 'model', inputNodeId: API, fromSupplierCompanyId: rivalA.id, toSupplierCompanyId: rivalB.id });

    state.quarter = 2;
    state.pendingActions.push(submitted(state, app, fill));
    const second = runQuarter(state, 2);
    expect(second.events.filter((event) => event.type === 'slot_filled')).toHaveLength(0);
    expect(line.slots?.find((entry) => entry.slotId === 'model')?.changedQuarter).toBe(1);
  });

  it('set_target_market aims a line, warns about a cell nobody buys in rather than refusing, and records the move', () => {
    const state = bareWorld();
    const maker = state.companies.find((company) => company.sector === 'robotics') as Company;
    maker.ownedNodes = [...(maker.ownedNodes ?? []), ARM];
    const line = lineOn(ARM, 0, 40_000);
    maker.products = [line];

    const empty = verdictFor(state, maker, { type: 'set_target_market', productId: line.id, targetIndustry: 'manufacturing', segment: 'government' });
    expect(empty.status).toBe('accepted');
    expect(empty.reasons.join(' ')).toContain('do not buy');
    const aimed = verdictFor(state, maker, { type: 'set_target_market', productId: line.id, targetIndustry: 'logistics', segment: 'enterprise' });
    expect(aimed.status).toBe('accepted');
    expect(aimed.reasons).toEqual([]);
    expect(verdictFor(state, maker, { type: 'set_target_market', productId: 'prd_missing', targetIndustry: 'logistics', segment: 'enterprise' }).status).toBe('rejected');

    state.pendingActions.push(submitted(state, maker, { type: 'set_target_market', productId: line.id, targetIndustry: 'logistics', segment: 'enterprise' }));
    const { events } = runQuarter(state, 0);
    expect(line.targetIndustry).toBe('logistics');
    expect(cellOf(line, economicNodeById(ARM) as EconomicNode)).toEqual({ industry: 'logistics', customer: 'enterprise' });
    expect(events.find((event) => event.type === 'target_market_set')?.payload).toMatchObject({ productId: line.id, fromIndustry: 'manufacturing', toIndustry: 'logistics' });
  });
});

describe('rivals compose too', () => {
  /** Two open sellers of the API at the same ask and quality, and an undirected consumer company running an app on the default. */
  function contested(quality = 0.9) {
    const world = twoApis();
    world.app.controllerPlayerId = null;
    world.apiA.supplyTerms = { openToAll: true, pricePerUnitUsd: 1, exclusiveCustomerIds: [], blockedCustomerIds: [] };
    world.apiB.supplyTerms = { openToAll: true, pricePerUnitUsd: 1, exclusiveCustomerIds: [], blockedCustomerIds: [] };
    world.apiA.qualityScore = quality;
    world.apiB.qualityScore = quality;
    const line = lineOn(APP, 1_000, 30);
    line.segment = 'consumer';
    world.app.products = [line];
    return { ...world, line };
  }

  it('publishes every node line open at its list price, and reprices only when the list moves more than five percent', () => {
    const state = bareWorld();
    const npc = state.companies.find((company) => company.sector === 'ai' && company.controllerPlayerId === null) as Company;
    npc.ownedNodes = [...(npc.ownedNodes ?? []), API];
    const api = lineOn(API, 1_000, 9.5);
    npc.products = [api];
    const { ctx } = recorder(0);
    applyNodeDefaults(state, ctx, 0);
    const published = state.pendingActions.filter((action) => action.actorCompanyId === npc.id && action.intent.type === 'set_supply_terms');
    expect(published).toHaveLength(1);
    expect(published[0]?.origin).toBe('npc_default');
    expect(published[0]?.intent).toEqual({ type: 'set_supply_terms', productId: api.id, terms: { openToAll: true, pricePerUnitUsd: 9.5, exclusiveCustomerIds: [], blockedCustomerIds: [] } });

    api.supplyTerms = { openToAll: true, pricePerUnitUsd: 9.5, exclusiveCustomerIds: [], blockedCustomerIds: ['cmp_someone'] };
    api.pricePerSeat = 9.9;
    expect(npcSupplyTermsFor(api)).toBeNull();
    api.pricePerSeat = 10.2;
    expect(npcSupplyTermsFor(api)).toEqual({ type: 'set_supply_terms', productId: api.id, terms: { openToAll: true, pricePerUnitUsd: 10.2, exclusiveCustomerIds: [], blockedCustomerIds: ['cmp_someone'] } });

    // Told this quarter: the policy stands aside.
    const told = bareWorld();
    const toldNpc = told.companies.find((company) => company.id === npc.id) as Company;
    toldNpc.ownedNodes = [...(toldNpc.ownedNodes ?? []), API];
    toldNpc.products = [lineOn(API, 1_000, 9.5)];
    told.pendingActions.push(submitted(told, toldNpc, { type: 'set_supply_terms', productId: `prd_${API}`, terms: { openToAll: false, pricePerUnitUsd: 20, exclusiveCustomerIds: [], blockedCustomerIds: [] } }));
    applyNodeDefaults(told, recorder(0).ctx, 1);
    expect(told.pendingActions.filter((action) => action.actorCompanyId === npc.id && action.intent.type === 'set_supply_terms')).toHaveLength(1);
  });

  it('fills a slot by quality per dollar, byte-identically across two runs, breaking a tie by company id', () => {
    const first = contested();
    const second = contested();
    const node = economicNodeById(APP) as EconomicNode;
    const model = node.slots.find((slot) => slot.id === 'model')!;
    const one = npcFillFor(first.state, first.app, first.line, node, model, createNodeCostCache(first.state));
    const two = npcFillFor(second.state, second.app, second.line, node, model, createNodeCostCache(second.state));
    expect(JSON.stringify(one)).toBe(JSON.stringify(two));
    const lowerId = [first.rivalA.id, first.rivalB.id].sort()[0];
    expect(one).toMatchObject({ type: 'fill_slot', productId: first.line.id, slotId: 'model', nodeId: API, supplierCompanyId: lowerId });
    // The scored options say why: both sellers beat the open market, and the tie is broken on id.
    const options = scoredSlotOptions(first.state, first.app, node, model);
    expect(options[0]?.supplierCompanyId).toBe(lowerId);
    expect(options[0]?.score).toBe(options[1]?.score);
    expect(options.find((option) => option.route === 'market')?.qualityScore).toBe(0.5);

    // Queued through applyNodeDefaults with origin npc_default, once per slot that moves, and skipped when told.
    const { ctx } = recorder(0);
    applyNodeDefaults(first.state, ctx, 0);
    const fills = first.state.pendingActions
      .filter((action) => action.actorCompanyId === first.app.id && action.intent.type === 'fill_slot')
      .map((action) => action.intent as Extract<ActionIntent, { type: 'fill_slot' }>);
    expect(fills.map((intent) => intent.slotId)).toEqual(['model', 'harness']);
    expect(first.state.pendingActions.filter((action) => action.actorCompanyId === first.app.id).every((action) => action.origin === 'npc_default')).toBe(true);
    // Quality per dollar is judged across nodes too: the cheaper harness at the
    // same market quality wins the harness slot. The data slot's default has no
    // cheaper admissible node and no seller, and the empty delivery slot is
    // left alone.
    expect(fills[1]).toMatchObject({ slotId: 'harness', nodeId: 'svc_copilot_framework', supplierCompanyId: null, supplierProductId: null });
  });

  it('is sticky below the switch threshold and excludes a direct rival unless nothing else is on offer', () => {
    const world = contested(0.6);
    const node = economicNodeById(APP) as EconomicNode;
    const model = node.slots.find((slot) => slot.id === 'model')!;
    world.line.slots = [fillOn('model', API, world.rivalA.id, world.apiA.id)];
    // B eight percent better on quality: kept.
    world.apiB.qualityScore = 0.65;
    expect(npcFillFor(world.state, world.app, world.line, node, model)).toBeNull();
    // B a quarter better: switched.
    world.apiB.qualityScore = 0.6 * NPC_SLOT_SWITCH_THRESHOLD * 1.1;
    expect(npcFillFor(world.state, world.app, world.line, node, model)).toMatchObject({ supplierCompanyId: world.rivalB.id, supplierProductId: world.apiB.id });
    // The current fill re-stated is never emitted.
    world.apiB.qualityScore = 0.6;
    expect(npcFillFor(world.state, world.app, world.line, node, model)).toBeNull();

    // A company publishing its own API is a direct rival of every API seller.
    const rivalWorld = contested(0.9);
    const own = publishLine(rivalWorld.app, API, 9, 0.7, 'prd_own_api');
    own.slots = [];
    const options = scoredSlotOptions(rivalWorld.state, rivalWorld.app, node, model);
    expect(options.filter((option) => option.route === 'buy').every((option) => option.isDirectRival)).toBe(true);
    // Standing on a rival, it moves off it: its own line is the best non-rival
    // source, so MAKE wins, whatever the rivals score.
    rivalWorld.line.slots = [fillOn('model', API, rivalWorld.rivalA.id, rivalWorld.apiA.id)];
    expect(npcFillFor(rivalWorld.state, rivalWorld.app, rivalWorld.line, node, model)).toMatchObject({ supplierCompanyId: rivalWorld.app.id, supplierProductId: 'prd_own_api' });
    // Already making it: nothing to emit.
    rivalWorld.line.slots = [];
    expect(resolveFill(rivalWorld.state, rivalWorld.app, rivalWorld.line, node, model).route).toBe('make');
    expect(npcFillFor(rivalWorld.state, rivalWorld.app, rivalWorld.line, node, model)).toBeNull();
  });

  it('leaves a slot it has just moved alone for the settle window, unless it stands on a direct rival', () => {
    // The oscillation this exists for: a seller that switched its own model
    // slot carries the switch dip in its stamped quality for one quarter; a
    // buyer that read the dip moved off it, and moved back the quarter after,
    // costing itself two switches for nothing that lasted.
    const world = contested(0.6);
    const node = economicNodeById(APP) as EconomicNode;
    const model = node.slots.find((slot) => slot.id === 'model')!;
    // B is a quarter better: a fill with no history moves.
    world.apiB.qualityScore = 0.6 * NPC_SLOT_SWITCH_THRESHOLD * 1.1;
    world.line.slots = [fillOn('model', API, world.rivalA.id, world.apiA.id)];
    world.state.quarter = 6;
    expect(npcFillFor(world.state, world.app, world.line, node, model)).not.toBeNull();
    // The same fill moved onto A inside the window is kept, whatever B scores.
    for (const ago of [0, 1, NPC_SLOT_SETTLE_QUARTERS - 1]) {
      world.line.slots = [fillOn('model', API, world.rivalA.id, world.apiA.id, 6 - ago)];
      expect(npcFillFor(world.state, world.app, world.line, node, model), `${ago} quarters ago`).toBeNull();
    }
    // The window closes, and the judgement is made again.
    world.line.slots = [fillOn('model', API, world.rivalA.id, world.apiA.id, 6 - NPC_SLOT_SETTLE_QUARTERS)];
    expect(npcFillFor(world.state, world.app, world.line, node, model)).toMatchObject({ supplierCompanyId: world.rivalB.id });

    // Standing on a direct rival, freshly or not, it moves: the rivalry is the reason.
    const rivalWorld = contested(0.9);
    const own = publishLine(rivalWorld.app, API, 9, 0.7, 'prd_own_api');
    own.slots = [];
    rivalWorld.state.quarter = 6;
    rivalWorld.line.slots = [fillOn('model', API, rivalWorld.rivalA.id, rivalWorld.apiA.id, 6)];
    expect(npcFillFor(rivalWorld.state, rivalWorld.app, rivalWorld.line, node, model)).toMatchObject({ supplierCompanyId: rivalWorld.app.id, supplierProductId: 'prd_own_api' });
  });
});
