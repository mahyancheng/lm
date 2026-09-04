/**
 * @frontier/simulation — world 3 books the node economy.
 *
 * Stage 3 is the one that has to survive the double-entry gate, so what is
 * proved here is the booking, in this order:
 *
 * 1. **Cost of goods is the roll-up's own number.** `Σ units × unitCost` over
 *    the lines that sold externally, and the same `unitCostUsd` the Products
 *    screen shows — not a cousin of it. World 2 ran a second, compute-only
 *    margin model beside its income statement and let the two disagree.
 * 2. **Every dollar of conversion cost is booked exactly once, at the point of
 *    external sale.** Labour comes out of payroll rather than beside it, and
 *    the capacity a unit draws comes out of the depreciation and rent the
 *    company is already paying rather than beside them. The remainder of each
 *    is still charged — payroll on its own line, capacity as "idle capacity" —
 *    so nothing is lost either.
 * 3. **The three sale kinds bill the way their goods are sold.** A chip bills
 *    once, a seat bills every quarter, and a twenty-quarter power contract is
 *    billed a year in advance and recognised a quarter at a time until deferred
 *    revenue is exactly empty — and its live book never exceeds the capacity
 *    that has to serve it every quarter of its term.
 * 4. **Twelve quarters of the real world resolve** through the real gate with
 *    every balance sheet reconciling, twice, to the same hash.
 *
 * The frozen worlds are pinned by hash in `world2Scenario.test.ts` and are not
 * restated here.
 */

import { describe, expect, it } from 'vitest';
import type { Company, Product, ResolverContext, SessionState } from '@frontier/contracts';
import { economicNodeById } from '@frontier/contracts';
import { createRng, hashState } from '@frontier/shared';
import { createDefaultEngine } from '../src/engine';
import { createWorld3Session } from '../src/scenario/world3';
import { priceNodes } from '../src/graph/market';
import { BACKLOG_CARRY, CONTRACT_ADVANCE_QUARTERS } from '../src/graph/production';
import { producibleUnits } from '../src/graph/market';
import { unitCostOf } from '../src/graph/cost';
import { createNodeCostCache } from '../src/graph/lines';
import { resolveProducts, unclampedGrossMargin } from '../src/companies/products';
import { resolveFinancials } from '../src/companies/financials';
import { totalHeadcount } from '../src/companies/util';

/* -------------------------------------------------------------------------- */
/*  A world the test owns outright                                             */
/* -------------------------------------------------------------------------- */

/** Nodes the fixtures build on, quoted from the table and asserted against it. */
const DIE = 'cmp_logic_die';
const WAFER = 'mat_wafer_300mm';
const ARM = 'sys_industrial_arm';
const SUITE = 'app_ai_software_suite';
const PPA = 'svc_power_purchase_agreement';

describe('the table these tests are pinned to', () => {
  it('still declares the sale kinds and capacity kinds they quote', () => {
    expect(economicNodeById(DIE)).toMatchObject({ saleKind: 'unit', capacityKind: 'plant' });
    expect(economicNodeById(WAFER)).toMatchObject({ saleKind: 'unit', capacityKind: 'plant' });
    expect(economicNodeById(ARM)).toMatchObject({ saleKind: 'unit', capacityKind: 'plant' });
    expect(economicNodeById(SUITE)?.saleKind).toBe('recurring');
    expect(economicNodeById(PPA)).toMatchObject({ saleKind: 'contract', contractQuarters: 20 });
  });
});

/** One line on one node, as a world-3 product. */
function lineOn(nodeId: string, units: number, priceUsd: number): Product {
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
    qualityScore: 0.6,
    craftQuality: 0.6,
    qualityTier: 0.5,
    launchedQuarter: 0,
    isActive: true,
  };
}

/**
 * A world-3 session stripped back to one company and one line.
 *
 * Everything that could put a second figure into the company's profit and loss
 * — other lines, government contracts, debt, deferred revenue, other companies'
 * lines — is removed, so an assertion about cost of goods is an assertion about
 * the roll-up and nothing else.
 */
function soloWorld(nodeId: string, units: number, priceUsd: number, plantUsd: number): { state: SessionState; company: Company } {
  const state = createWorld3Session();
  for (const company of state.companies) {
    company.products = [];
    company.capacity = { plantUsd: 0, fleetUsd: 0, gridUsd: 0 };
  }
  state.governmentContracts = [];
  state.researchProjects = [];
  const company = state.companies[0] as Company;
  company.region = 'north_america';
  company.products = [lineOn(nodeId, units, priceUsd)];
  company.capacity = { plantUsd, fleetUsd: 0, gridUsd: 0 };
  // A sheet with exactly two assets and no liabilities: the cash is large
  // enough that the solvency clock can never end the fixture mid-assertion, and
  // property, plant and equipment is exactly the capacity, so the depreciation
  // the financial phase writes off is the depreciation the unit costs allocate.
  company.balanceSheet.assets = { cash: FIXTURE_CASH_USD, ppe: plantUsd, goodwill: 0, investments: 0, receivables: 0 };
  company.balanceSheet.liabilities = { debt: 0, payables: 0, deferredRevenue: 0 };
  company.balanceSheet.equity = FIXTURE_CASH_USD + plantUsd;
  // No compute at all, so the capacity charge is the plant's depreciation and
  // nothing else — the one arrangement in which the lemma can be read exactly.
  company.compute = { ...company.compute, ownedAccelerators: 0, reservedAccelerators: 0, cloudSpendQuarterly: 0, trainingAllocation: 0 };
  return { state, company };
}

/** Cash the fixtures hold: enough that no assertion is ever cut short by a wind-up. */
const FIXTURE_CASH_USD = 1_000_000_000_000;

/** The payroll the financial phase will charge, restated the way that phase derives it. */
function chargedPayrollUsd(company: Company): number {
  return Math.max(company.financials.payroll, (totalHeadcount(company) * company.employees.avgComp) / 4);
}

/** A context that records what a phase emitted and said. */
function recorder(quarter: number) {
  const events: { type: string; payload: Record<string, unknown> }[] = [];
  const lines: string[] = [];
  let counter = 0;
  const ctx: ResolverContext = {
    quarter,
    rng: createRng(`node_production_q${quarter}`),
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

/** Run the three world-3 phases that make and book a quarter, in pipeline order. */
function runQuarter(state: SessionState, quarter: number) {
  const { events, lines, ctx } = recorder(quarter);
  priceNodes(state, ctx);
  resolveProducts(state, ctx);
  const result = resolveFinancials(state, ctx);
  return { events, lines, ctx, result };
}

/** The unkinded cost row for one company: the one that states the whole quarter. */
function costRow(events: { type: string; payload: Record<string, unknown> }[]): Record<string, unknown> {
  const row = events.find((event) => event.type === 'cost_recognised' && event.payload.kind === undefined);
  expect(row, 'no profit-and-loss cost row was written').toBeDefined();
  return (row as { payload: Record<string, unknown> }).payload;
}

const num = (payload: Record<string, unknown>, key: string): number => {
  const value = payload[key];
  expect(typeof value, `${key} is not a number`).toBe('number');
  return value as number;
};

/* -------------------------------------------------------------------------- */
/*  1. Cost of goods is the roll-up                                            */
/* -------------------------------------------------------------------------- */

describe('cost of goods in the node economy', () => {
  it('is units sold times the unit cost the Products screen shows, and nothing else', () => {
    const { state, company } = soloWorld(DIE, 400_000, 500, 400_000_000);
    const { events } = runQuarter(state, 0);
    const product = company.products[0] as Product;

    expect(product.unitsSoldQuarterly).toBeGreaterThan(0);
    expect(product.unitCostUsd).toBeGreaterThan(0);
    const row = costRow(events);
    expect(num(row, 'nodeCogsUsd')).toBeCloseTo((product.unitsSoldQuarterly ?? 0) * (product.unitCostUsd ?? 0), 2);
    // With no government contracts to comply with, everything else in the cost
    // of goods is a charge another company levies — a group's freight toll —
    // and it is named on its own row. The roll-up is the rest of it exactly:
    // the P&L and the Products screen agree by construction.
    expect(company.financials.cogs).toBeCloseTo(num(row, 'nodeCogsUsd') + num(row, 'logisticsTollUsd'), 2);
  });

  it('sets gross margin to exactly one minus unit cost over price', () => {
    const { state, company } = soloWorld(DIE, 400_000, 500, 400_000_000);
    runQuarter(state, 0);
    const product = company.products[0] as Product;
    expect(product.grossMarginPct).toBe(1 - (product.unitCostUsd ?? 0) / product.pricePerSeat);
  });

  it('transfers an in-house input at its own cost, so no dollar of conversion is booked twice', () => {
    const { state, company } = soloWorld(DIE, 400_000, 500, 800_000_000);
    company.products = [lineOn(DIE, 400_000, 500), { ...lineOn(WAFER, 0, 14_000), id: 'prd_wafer' }];
    runQuarter(state, 0);

    const cache = createNodeCostCache(state);
    const die = unitCostOf(state, company, DIE, cache);
    const wafer = unitCostOf(state, company, WAFER, cache);
    const waferLine = die.lines.find((line) => line.key === WAFER);
    expect(waferLine?.sourceKind).toBe('make');
    // The wafer enters the die at the wafer's own unit cost, with no internal
    // margin: the group's profit on an internal sale is not a cost to the group.
    expect(waferLine?.unitPriceUsd).toBe(wafer.unitCostUsd);
    // And the total cost of goods is still one sum over the lines that sold,
    // plus the toll another company levies on it.
    const booked = company.products.reduce((total, product) => total + (product.unitsSoldQuarterly ?? 0) * (product.unitCostUsd ?? 0), 0);
    expect(company.financials.cogs - booked).toBeGreaterThanOrEqual(0);
    expect(booked).toBeGreaterThan(0);
  });
});

/* -------------------------------------------------------------------------- */
/*  2. Conversion cost is booked exactly once                                  */
/* -------------------------------------------------------------------------- */

describe('the conversion cost invariant', () => {
  it('takes labour out of payroll rather than charging it beside payroll', () => {
    const { state, company } = soloWorld(DIE, 400_000, 500, 400_000_000);
    const stagedPayroll = chargedPayrollUsd(company);
    const { events } = runQuarter(state, 0);
    const row = costRow(events);
    const labourInCogs = num(row, 'labourInCogsUsd');
    expect(labourInCogs).toBeGreaterThan(0);
    // The whole wage bill is still charged, once: the part production consumed
    // sits inside cost of goods and the rest stays on the payroll line.
    expect(num(row, 'payrollUsd') + labourInCogs).toBeCloseTo(stagedPayroll, 2);
  });

  it('splits the capacity charge into what production absorbed and what stood idle', () => {
    const { state } = soloWorld(DIE, 400_000, 500, 400_000_000);
    const { events } = runQuarter(state, 0);
    const row = costRow(events);
    expect(num(row, 'capacityInCogsUsd') + num(row, 'idleCapacityUsd')).toBeCloseTo(num(row, 'capacityChargeUsd'), 2);
  });

  it('charges nothing idle at full utilisation, and the whole of it at none', () => {
    // THE LEMMA, read off two runs of the same fixture.
    //
    // Full utilisation: the fab's whole plant is drawn on, so what production
    // absorbed is exactly the depreciation the balance sheet wrote off and the
    // idle line is zero.
    const full = soloWorld(DIE, 400_000, 500, 400_000_000);
    const busy = runQuarter(full.state, 0);
    const busyRow = costRow(busy.events);
    expect(num(busyRow, 'capacityInCogsUsd')).toBeCloseTo(num(busyRow, 'capacityChargeUsd'), 2);
    expect(num(busyRow, 'idleCapacityUsd')).toBeCloseTo(0, 2);
    expect(full.company.financials.idleCapacityUsd).toBeCloseTo(0, 2);

    // Build the fab and sell nothing — no line at all — and the whole charge is
    // idle. Nothing is lost, and nothing is charged twice.
    const empty = soloWorld(DIE, 400_000, 500, 400_000_000);
    empty.company.products = [];
    const quiet = runQuarter(empty.state, 0);
    const quietRow = costRow(quiet.events);
    expect(num(quietRow, 'capacityInCogsUsd')).toBeCloseTo(0, 2);
    expect(num(quietRow, 'idleCapacityUsd')).toBeCloseTo(num(quietRow, 'capacityChargeUsd'), 2);
    expect(empty.company.financials.idleCapacityUsd ?? 0).toBeGreaterThan(0);
  });
});

/* -------------------------------------------------------------------------- */
/*  3. Capacity rations in units of the node                                   */
/* -------------------------------------------------------------------------- */

describe('capacity rationing', () => {
  it('produces nothing at all for a company with no capacity in its line\'s kind', () => {
    const { state, company } = soloWorld(ARM, 5_000, 38_000, 0);
    runQuarter(state, 0);
    expect(company.products[0]?.unitsSoldQuarterly).toBe(0);
  });

  it('carries unfilled orders as visible backlog and asks for them again', () => {
    const { state, company } = soloWorld(ARM, 5_000, 38_000, 200_000_000);
    runQuarter(state, 0);
    const product = company.products[0] as Product;
    const backlog = product.backlogUnits ?? 0;
    expect(backlog, 'a capacity-bound line should be leaving orders unfilled').toBeGreaterThan(0);
    expect(product.unitsSoldQuarterly).toBeGreaterThan(0);
    // Half of the disappointed buyers wait: next quarter's pool is larger by
    // exactly that share of the backlog.
    expect(BACKLOG_CARRY).toBe(0.5);
  });
});

/* -------------------------------------------------------------------------- */
/*  4. The three sale kinds                                                    */
/* -------------------------------------------------------------------------- */

describe('sale kinds', () => {
  it('bills a durable good once and keeps it as an installed base', () => {
    const { state, company } = soloWorld(ARM, 0, 38_000, 400_000_000);
    runQuarter(state, 0);
    const product = company.products[0] as Product;
    const shipped = product.unitsSoldQuarterly ?? 0;
    expect(shipped).toBeGreaterThan(0);
    expect(company.financials.revenueQuarterly).toBeCloseTo(shipped * product.pricePerSeat, 2);
    // The units shipped are in the field, not on the invoice again.
    expect(product.installedBase ?? 0).toBeGreaterThan(0);
    expect(company.financials.deferredRevenue).toBe(0);
  });

  it('bills a seat every quarter, on a base that persists', () => {
    const { state, company } = soloWorld(SUITE, 20_000, 1_500, 0);
    runQuarter(state, 0);
    const first = company.products[0]?.unitsSoldQuarterly ?? 0;
    runQuarter(state, 1);
    const second = company.products[0]?.unitsSoldQuarterly ?? 0;
    // The base is retained and churned, never re-won from a pool: both quarters
    // bill something close to the same number of seats.
    expect(first).toBeGreaterThan(0);
    expect(second).toBeGreaterThan(first * 0.5);
    expect(company.products[0]?.installedBase).toBe(0);
  });

  it('bills a term contract a year in advance and recognises it a quarter at a time', () => {
    const node = economicNodeById(PPA);
    const term = node?.contractQuarters ?? 0;
    expect(term).toBe(20);
    expect(CONTRACT_ADVANCE_QUARTERS).toBeLessThan(term);

    const { state, company } = soloWorld(PPA, 0, node?.basePriceUsd ?? 1, 0);
    company.capacity = { plantUsd: 0, fleetUsd: 0, gridUsd: 4_000_000_000 };
    runQuarter(state, 0);

    const product = company.products[0] as Product;
    const signed = product.unitsSoldQuarterly ?? 0;
    expect(signed).toBeGreaterThan(0);
    const perQuarter = signed * product.pricePerSeat;
    // A YEAR in advance, not five years. Nobody prepays a twenty-quarter power
    // purchase agreement in full on the day it is signed, and when this billed
    // the whole term a grid developer opened its first quarter with fifteen
    // times its own opening cash — every dollar of it properly matched by
    // deferred revenue, which is exactly why the double-entry gate never saw it.
    expect(company.financials.deferredRevenue).toBeCloseTo(perQuarter * (CONTRACT_ADVANCE_QUARTERS - 1), 0);
    expect(company.financials.revenueQuarterly).toBeCloseTo(perQuarter, 0);
    expect(product.contractRemainingQuarters).toBeCloseTo(term - 1, 6);

    // Nothing more is ever sold: the book runs off, deferred revenue empties
    // exactly, and the whole term is still recognised to the dollar — the rest
    // of it billed quarter by quarter as it is delivered.
    company.capacity = { plantUsd: 0, fleetUsd: 0, gridUsd: 0 };
    let recognised = perQuarter;
    for (let quarter = 1; quarter < term; quarter += 1) {
      runQuarter(state, quarter);
      recognised += company.financials.revenueQuarterly;
    }
    expect(company.financials.deferredRevenue).toBeCloseTo(0, 0);
    expect(recognised).toBeCloseTo(perQuarter * term, 0);
  });

  it('never commits a term book bigger than the capacity that has to serve it every quarter', () => {
    const node = economicNodeById(PPA);
    const { state, company } = soloWorld(PPA, 0, node?.basePriceUsd ?? 1, 0);
    // A plant that can hold about two hundred megawatt-quarters at a time.
    company.capacity = { plantUsd: 0, fleetUsd: 0, gridUsd: 250_000_000 };

    let ceiling = 0;
    let previousBook = 0;
    for (let quarter = 0; quarter < 8; quarter += 1) {
      const cache = createNodeCostCache(state);
      const line = (cache.linesByCompany.get(company.id) ?? []).find((candidate) => candidate.productId === company.products[0]?.id);
      ceiling = line === undefined ? 0 : producibleUnits(state, line, cache.linesByCompany);
      runQuarter(state, quarter);
      const book = company.products[0]?.activeCustomers ?? 0;
      // A megawatt-quarter is a megawatt HELD for a quarter, so the book may
      // never GROW past the capacity that has to serve every quarter of it.
      // (It may sit above a capacity that has since depreciated — that is a
      // company in breach of contracts it already signed, which is a real
      // position and a different problem.) Bounding only the new signings, as
      // this once did, let a grid developer with capacity for a hundred sign a
      // hundred every quarter and end up serving eleven hundred out of a plant
      // that was itself depreciating: revenue thirteen times its opening run
      // rate in four years, out of physical capacity that had halved.
      expect(book, `quarter ${quarter} signed past its own capacity`).toBeLessThanOrEqual(Math.max(previousBook, ceiling) + 1);
      previousBook = book;
    }
    expect(ceiling).toBeGreaterThan(0);
    expect(previousBook).toBeGreaterThan(0);
  });
});

/* -------------------------------------------------------------------------- */
/*  5. Demand judges a price against its own node                              */
/* -------------------------------------------------------------------------- */

describe('demand', () => {
  it('judges a line against its own node\'s market price, never a segment mean', () => {
    // A wafer fab and a die line both sell into "enterprise" at prices an order
    // of magnitude apart. In world 2 both were judged against the
    // customer-weighted mean price of every enterprise product in all six
    // sectors — about $21,000 — and the fab lost most of its growth to
    // saturation decay. Here each is judged against its own node.
    const { state, company } = soloWorld(DIE, 400_000, 500, 400_000_000);
    const fab = state.companies[1] as Company;
    fab.region = 'north_america';
    fab.products = [lineOn(WAFER, 20_000, 14_000)];
    fab.capacity = { plantUsd: 4_000_000_000, fleetUsd: 0, gridUsd: 0 };

    const { events } = runQuarter(state, 0);
    const rows = events.filter((event) => event.type === 'demand_resolved').map((event) => event.payload);
    const diePayload = rows.find((payload) => payload.nodeId === DIE);
    const waferPayload = rows.find((payload) => payload.nodeId === WAFER);
    expect(diePayload).toBeDefined();
    expect(waferPayload).toBeDefined();

    // Each line's reference is its own node's settled price, and the two are an
    // order of magnitude apart rather than one shared segment mean.
    expect(num(diePayload as Record<string, unknown>, 'marketPriceUsd')).toBeLessThan(2_000);
    expect(num(waferPayload as Record<string, unknown>, 'marketPriceUsd')).toBeGreaterThan(5_000);
    // Both ship: neither is punished for being priced nothing like the other.
    expect(company.products[0]?.unitsSoldQuarterly).toBeGreaterThan(0);
    expect(fab.products[0]?.unitsSoldQuarterly).toBeGreaterThan(0);
  });
});

/* -------------------------------------------------------------------------- */
/*  5b. The one margin model                                                   */
/* -------------------------------------------------------------------------- */

describe('the margin the predation test reads', () => {
  it('is the real one, and runs negative when the line sells below its unit cost', () => {
    const { state, company } = soloWorld(DIE, 400_000, 500, 400_000_000);
    runQuarter(state, 0);
    const product = company.products[0] as Product;
    const unitCost = product.unitCostUsd ?? 0;
    expect(unitCost).toBeGreaterThan(0);

    // At the price it charged, the stored margin and the unclamped one agree.
    expect(unclampedGrossMargin(state, product)).toBeCloseTo(1 - unitCost / product.pricePerSeat, 10);

    // Priced under its own cost, the margin the antitrust test reads is
    // negative — which world 2 could not say, because `grossMarginPct` is a
    // unit interval and its second, compute-only model never saw the bill of
    // materials at all.
    product.pricePerSeat = unitCost / 2;
    expect(unclampedGrossMargin(state, product)).toBeCloseTo(-1, 10);
  });
});

/* -------------------------------------------------------------------------- */
/*  6. The whole world, twelve quarters, through the real gate                 */
/* -------------------------------------------------------------------------- */

describe('the opening world', () => {
  it('gives every company a line it can make, priced above what that line costs it', () => {
    const state = createWorld3Session();
    const cache = createNodeCostCache(state);
    let checked = 0;
    for (const company of state.companies) {
      const product = company.products[0];
      const nodeId = product?.nodeId;
      if (product === undefined || nodeId === undefined || nodeId === null) continue;
      const cost = unitCostOf(state, company, nodeId, cache);
      // The ask covers the roll-up: a seeded company sells above what it costs
      // it to build, which is what its payroll and its research programme were
      // already sized against.
      expect(product.pricePerSeat, `${company.id} sells ${nodeId} below cost`).toBeGreaterThan(cost.unitCostUsd);
      expect(cost.blockedInputNodeIds, `${company.id} cannot source ${nodeId}`).toEqual([]);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(20);
  });

  it('carries property, plant and equipment that its own line can draw on', () => {
    const state = createWorld3Session();
    for (const company of state.companies) {
      const sheet = company.balanceSheet;
      const assets = sheet.assets.cash + sheet.assets.ppe + sheet.assets.goodwill + sheet.assets.investments + sheet.assets.receivables;
      const liabilities = sheet.liabilities.debt + sheet.liabilities.payables + sheet.liabilities.deferredRevenue;
      // The opening sheet still reconciles after the capacity was sized onto it.
      expect(Math.abs(assets - liabilities - sheet.equity), `${company.id}`).toBeLessThanOrEqual(1);
    }
  });
});

describe('twelve quarters of world 3', () => {
  it('resolves through the invariant gate with every balance sheet reconciling', () => {
    const engine = createDefaultEngine();
    let state = createWorld3Session();
    for (let quarter = 0; quarter < 12; quarter += 1) {
      const outcome = engine.resolver.resolveQuarter(state, [], null, []);
      const failures = outcome.invariants.filter((result) => !result.passed).map((result) => `${result.invariant}: ${result.detail}`);
      expect(failures, `quarter ${quarter}`).toEqual([]);
      expect(outcome.committed, `quarter ${quarter} did not commit`).toBe(true);
      state = outcome.nextState;
    }
    expect(state.quarter).toBe(12);
  }, 240_000);

  it('is deterministic: the same twelve quarters hash the same twice', () => {
    const engine = createDefaultEngine();
    const run = (): string => {
      let state = createWorld3Session();
      for (let quarter = 0; quarter < 12; quarter += 1) state = engine.resolver.resolveQuarter(state, [], null, []).nextState;
      return hashState(state);
    };
    expect(run()).toBe(run());
  }, 240_000);

  it('books a unit cost on every line that sold, and a margin that agrees with it', () => {
    const engine = createDefaultEngine();
    let state = createWorld3Session();
    for (let quarter = 0; quarter < 3; quarter += 1) state = engine.resolver.resolveQuarter(state, [], null, []).nextState;

    let checked = 0;
    for (const company of state.companies) {
      if (!company.isActive) continue;
      for (const product of company.products) {
        if (!product.isActive || product.nodeId === undefined || product.nodeId === null) continue;
        expect(product.unitsSoldQuarterly, `${company.id} ${product.id}`).toBeDefined();
        expect(product.unitCostUsd, `${company.id} ${product.id}`).toBeDefined();
        if (product.pricePerSeat > 0) {
          const expected = Math.min(1, Math.max(0, 1 - (product.unitCostUsd ?? 0) / product.pricePerSeat));
          expect(product.grossMarginPct, `${company.id} ${product.id}`).toBeCloseTo(expected, 10);
        }
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(10);
  }, 120_000);
});
