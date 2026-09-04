/**
 * @frontier/simulation — the world-3 node market and the unit-cost roll-up.
 *
 * Two things are proved here, and they are deliberately proved apart:
 *
 * 1. **The market.** One price per node per quarter, moved by supply and demand
 *    with inertia, bounded, deterministic, and a no-op in the frozen worlds.
 * 2. **The roll-up.** What one unit of one line costs, itemised, with
 *    `unitCostUsd` equal to the sum of its own lines exactly rather than to a
 *    second calculation that agrees approximately.
 *
 * Nothing consumes either yet — the profit and loss books them in the next
 * stage — which is exactly why the arithmetic has to be pinned now, while it
 * can be read on its own.
 *
 * The chain the exact-number tests use is a real one out of the table:
 * silicon feedstock (tier 0) and fab chemicals (tier 0) into a 300mm wafer
 * (tier 2) into a logic die (tier 3). The table's own numbers are quoted as
 * literals and asserted against the table at the top of the file, so a change
 * to a node's price or draw fails *here*, naming the literal to update, rather
 * than silently rewriting what the test claims to prove.
 */

import { describe, expect, it } from 'vitest';
import type { Company, NodeLineRef, Product, ResolverContext, SessionState } from '@frontier/contracts';
import {
  ECONOMIC_NODES,
  NODE_PRICE_BASELINE,
  NODE_PRICE_BOUNDS,
  NODE_TIERS,
  economicNodeById,
  nodeMarketPriceUsd,
  nodePriceIndex,
} from '@frontier/contracts';
import { createRng, hashState } from '@frontier/shared';
import { createDefaultEngine } from '../src/engine';
import { ResolutionRecorder } from '../src/resolver';
import { createWorld2Session } from '../src/scenario/world2';
import { createWorld3Session } from '../src/scenario/world3';
import {
  CAPACITY_RATE_USD_PER_MILLION,
  MAX_COST_DEPTH,
  OPEN_MARKET_PREMIUM,
  createNodeCostCache,
  nodeBalances,
  nodeLinesOf,
  priceNodes,
  producibleUnits,
  unitCostOf,
  worldShifterFor,
} from '../src/graph';
import { companyEnergyCostFactor } from '../src/economy/regions';
import { sellerPriceFactor } from '../src/companies/sellers';
import { indexNodeLines } from '../src/graph/lines';

/* -------------------------------------------------------------------------- */
/*  The chain, as the table declares it                                        */
/* -------------------------------------------------------------------------- */

const SILICON = 'res_silicon_feedstock';
const CHEMICALS = 'res_fab_chemicals';
const WAFER = 'mat_wafer_300mm';
const DIE = 'cmp_logic_die';
const POWER = 'res_grid_power';

/** Annual compensation the fixture pays, so a quarter of labour is exactly $100,000. */
const AVG_COMP_USD = 400_000;
const LABOUR_RATE_USD = AVG_COMP_USD / 4;

/** North America's energy cost index is 95, and no sector price has been set yet. */
const ENERGY_FACTOR = 0.95;

describe('the table the arithmetic below is pinned to', () => {
  it('still carries the prices, draws and quantities these tests quote', () => {
    expect(economicNodeById(SILICON)).toMatchObject({ basePriceUsd: 11, capacityDrawPerUnit: 0.000_02, labourPerUnit: 0.000_002, energyMwhPerUnit: 0, supportCostShare: 0.04 });
    expect(economicNodeById(CHEMICALS)).toMatchObject({ basePriceUsd: 600 });
    expect(economicNodeById(WAFER)).toMatchObject({ basePriceUsd: 14_000, capacityDrawPerUnit: 0.222, labourPerUnit: 0.004, energyMwhPerUnit: 1.4, supportCostShare: 0.03 });
    expect(economicNodeById(DIE)).toMatchObject({ basePriceUsd: 420, capacityDrawPerUnit: 0.000_5, labourPerUnit: 0.000_05, energyMwhPerUnit: 0.02, supportCostShare: 0.04 });
    expect(economicNodeById(POWER)?.basePriceUsd).toBe(51);
    expect(economicNodeById(WAFER)?.consumes).toEqual([
      { nodeId: SILICON, qtyPerUnit: 1.4, substitutable: true },
      { nodeId: CHEMICALS, qtyPerUnit: 1, substitutable: false },
    ]);
    expect(economicNodeById(DIE)?.consumes).toEqual([{ nodeId: WAFER, qtyPerUnit: 0.022, substitutable: false }]);
    expect(CAPACITY_RATE_USD_PER_MILLION).toBe(55_000);
    expect(OPEN_MARKET_PREMIUM).toBe(1.08);
  });
});

/* -------------------------------------------------------------------------- */
/*  Fixture                                                                    */
/* -------------------------------------------------------------------------- */

function lineOn(nodeId: string, units: number, priceUsd: number): Product {
  return {
    id: `prd_${nodeId}`,
    name: nodeId,
    segment: 'enterprise',
    nodeId,
    pricePerSeat: priceUsd,
    activeCustomers: units,
    churnQuarterly: 0.05,
    growthQuarterly: 0,
    grossMarginPct: 0.4,
    computeIntensity: 0.5,
    qualityScore: 0.6,
    launchedQuarter: 0,
    isActive: true,
  };
}

/**
 * A world-3 session with every seeded line stripped, so a test owns the whole
 * supply side of the world and nothing it did not put there can move a price.
 */
function emptyWorld(): SessionState {
  const state = createWorld3Session();
  for (const company of state.companies) company.products = [];
  return state;
}

/** The first two companies of the world, renamed for what the tests use them as. */
function twoCompanies(state: SessionState): { maker: Company; supplier: Company } {
  const maker = state.companies[0] as Company;
  const supplier = state.companies[1] as Company;
  maker.region = 'north_america';
  maker.employees.avgComp = AVG_COMP_USD;
  supplier.region = 'north_america';
  supplier.employees.avgComp = AVG_COMP_USD;
  return { maker, supplier };
}

/* -------------------------------------------------------------------------- */
/*  The roll-up                                                                */
/* -------------------------------------------------------------------------- */

describe('the unit cost roll-up', () => {
  it('rolls a three-tier chain up to an exact number', () => {
    const state = emptyWorld();
    const { maker, supplier } = twoCompanies(state);
    // The maker makes its own silicon, its own wafers and its own dies; fab
    // chemicals it buys, and somebody in the world makes those.
    maker.products = [lineOn(SILICON, 0, 11), lineOn(WAFER, 0, 14_000), lineOn(DIE, 0, 420)];
    supplier.products = [lineOn(CHEMICALS, 0, 600)];
    expect(companyEnergyCostFactor(state, maker)).toBe(ENERGY_FACTOR);

    const cache = createNodeCostCache(state);
    const silicon = unitCostOf(state, maker, SILICON, cache);
    const wafer = unitCostOf(state, maker, WAFER, cache);
    const die = unitCostOf(state, maker, DIE, cache);

    // silicon: labour 0.000002 × 100,000 = 0.20, capacity 0.00002 × 55,000 = 1.10,
    // support 4% of 1.30 = 0.052.
    expect(silicon.unitCostUsd).toBeCloseTo(1.352, 9);

    // wafer: 1.4 silicon at its own cost (1.8928) + 1 chemical set on the open
    // market (600 × 1.08 = 648) + power 1.4 MWh at 51 × 0.95 (67.83) + labour
    // 400 + capacity 0.222 × 55,000 (12,210), and 3% support on all of it.
    expect(wafer.unitCostUsd).toBeCloseTo(13_727.554_484, 6);

    // die: 0.022 wafers at the maker's own wafer cost, plus its own conversion.
    expect(die.unitCostUsd).toBeCloseTo(348.894_206_593_92, 6);
  });

  it('is the sum of its own lines exactly, never a second calculation', () => {
    const state = emptyWorld();
    const { maker, supplier } = twoCompanies(state);
    maker.products = [lineOn(SILICON, 0, 11), lineOn(WAFER, 0, 14_000), lineOn(DIE, 0, 420)];
    supplier.products = [lineOn(CHEMICALS, 0, 600)];

    const cache = createNodeCostCache(state);
    for (const nodeId of [SILICON, WAFER, DIE]) {
      const result = unitCostOf(state, maker, nodeId, cache);
      expect(result.unitCostUsd).toBe(result.lines.reduce((total, line) => total + line.amountUsd, 0));
      for (const line of result.lines) {
        expect(line.amountUsd).toBeCloseTo(line.unitsPerUnit * line.unitPriceUsd, 9);
      }
      // Power, labour, capacity and support are always present.
      expect(result.lines.filter((line) => line.sourceKind === 'conversion').map((line) => line.key)).toEqual([
        'power',
        'labour',
        'capacity',
        'support',
      ]);
    }
  });

  it('makes vertical integration cheaper by exactly the premium plus the maker\'s margin', () => {
    const state = emptyWorld();
    const { maker, supplier } = twoCompanies(state);
    maker.products = [lineOn(SILICON, 0, 11), lineOn(WAFER, 0, 14_000), lineOn(DIE, 0, 420)];
    // The buyer runs the same die line and makes nothing upstream of it.
    const buyer = state.companies[2] as Company;
    buyer.region = 'north_america';
    buyer.employees.avgComp = AVG_COMP_USD;
    buyer.products = [lineOn(DIE, 0, 420)];
    supplier.products = [lineOn(CHEMICALS, 0, 600), lineOn(WAFER, 0, 14_000)];

    const cache = createNodeCostCache(state);
    const own = unitCostOf(state, maker, WAFER, cache);
    const integrated = unitCostOf(state, maker, DIE, cache);
    const bought = unitCostOf(state, buyer, DIE, cache);

    const marketWafer = nodeMarketPriceUsd(state, WAFER) * OPEN_MARKET_PREMIUM;
    const gap = 0.022 * (marketWafer - own.unitCostUsd) * (1 + (economicNodeById(DIE)?.supportCostShare ?? 0));
    expect(bought.unitCostUsd - integrated.unitCostUsd).toBeCloseTo(gap, 6);
    expect(bought.unitCostUsd).toBeGreaterThan(integrated.unitCostUsd);

    expect(integrated.lines.find((line) => line.key === WAFER)?.sourceKind).toBe('make');
    expect(bought.lines.find((line) => line.key === WAFER)?.sourceKind).toBe('market');
    expect(integrated.madeInHouseSharePct).toBe(100);
    expect(bought.madeInHouseSharePct).toBe(0);
  });

  it('blocks a line whose non-substitutable input nobody in the world can make, and says which', () => {
    // CHANGED DELIBERATELY, stage 3: "blocked" now means nobody *owns* the
    // input, not merely that nobody is running a line on it this quarter. A
    // node with an owner and no producer is bought on the open market, dearly —
    // the market has already run its price to the top of its band — because
    // twenty-five companies are not the whole economy. So this test strips the
    // ownership as well as the lines, which is the only state in which the
    // input genuinely cannot be had at any price.
    const state = emptyWorld();
    const { maker } = twoCompanies(state);
    maker.products = [lineOn(WAFER, 0, 14_000)];
    for (const company of state.companies) company.ownedNodes = (company.ownedNodes ?? []).filter((id) => id !== CHEMICALS);

    const wafer = unitCostOf(state, maker, WAFER, createNodeCostCache(state));
    expect(wafer.blockedInputNodeIds).toEqual([CHEMICALS]);
    // Silicon is substitutable, so it still prices on the open market.
    expect(wafer.lines.find((line) => line.key === SILICON)?.sourceKind).toBe('market');
    expect(wafer.lines.find((line) => line.key === CHEMICALS)?.amountUsd).toBe(0);
  });

  it('prices — rather than blocks — an input somebody owns but nobody is making', () => {
    const state = emptyWorld();
    const { maker } = twoCompanies(state);
    maker.products = [lineOn(WAFER, 0, 14_000)];
    // Nobody runs a chemicals line, but the ownership rule guarantees somebody
    // could: the input is imported at the open market's price, not blocked.
    expect(state.companies.some((company) => (company.ownedNodes ?? []).includes(CHEMICALS))).toBe(true);

    const wafer = unitCostOf(state, maker, WAFER, createNodeCostCache(state));
    expect(wafer.blockedInputNodeIds).toEqual([]);
    const chemicals = wafer.lines.find((line) => line.key === CHEMICALS);
    expect(chemicals?.sourceKind).toBe('market');
    expect(chemicals?.amountUsd).toBeGreaterThan(0);
  });

  it('buys from a named supplier at their ask, inside the market\'s gravity', () => {
    const state = emptyWorld();
    const { maker, supplier } = twoCompanies(state);
    supplier.products = [{ ...lineOn(CHEMICALS, 0, 600), supplyTerms: { openToAll: true, pricePerUnitUsd: 540, exclusiveCustomerIds: [], blockedCustomerIds: [] } }];
    maker.products = [
      {
        ...lineOn(WAFER, 0, 14_000),
        supply: [{ inputCategoryId: CHEMICALS, supplierCompanyId: supplier.id, supplierProductId: `prd_${CHEMICALS}`, cutOffNoticeQuarter: null }],
      },
    ];

    const wafer = unitCostOf(state, maker, WAFER, createNodeCostCache(state));
    const chemicals = wafer.lines.find((line) => line.key === CHEMICALS);
    expect(chemicals?.sourceKind).toBe('buy');
    expect(chemicals?.sourceCompanyId).toBe(supplier.id);
    // The ask, at this seller's own cost base: `sellerPriceFactor` — the energy
    // where it operates and how loaded it already is — is what makes two
    // suppliers quoting the same number different suppliers. It was world 2's
    // one good idea about the compute market and it is generalised to every
    // node here, which is why this is the ask times the factor rather than the
    // ask alone.
    expect(chemicals?.unitPriceUsd).toBeCloseTo(540 * sellerPriceFactor(state, supplier), 6);
    // And a contract still beats the open market's 600 × 1.08 = 648.
    expect(chemicals?.unitPriceUsd ?? 0).toBeLessThan(600 * OPEN_MARKET_PREMIUM);
    expect(wafer.blockedInputNodeIds).toEqual([]);
  });

  it('holds a hostage ask inside two and a half times the market price', () => {
    const state = emptyWorld();
    const { maker, supplier } = twoCompanies(state);
    supplier.products = [{ ...lineOn(CHEMICALS, 0, 600), supplyTerms: { openToAll: true, pricePerUnitUsd: 90_000, exclusiveCustomerIds: [], blockedCustomerIds: [] } }];
    maker.products = [
      {
        ...lineOn(WAFER, 0, 14_000),
        supply: [{ inputCategoryId: CHEMICALS, supplierCompanyId: supplier.id, supplierProductId: `prd_${CHEMICALS}`, cutOffNoticeQuarter: null }],
      },
    ];

    const wafer = unitCostOf(state, maker, WAFER, createNodeCostCache(state));
    expect(wafer.lines.find((line) => line.key === CHEMICALS)?.unitPriceUsd).toBe(600 * 2.5);
  });

  it('charges a licence royalty on the node\'s market price, not on the line\'s own ask', () => {
    const state = emptyWorld();
    const { maker, supplier } = twoCompanies(state);
    supplier.products = [lineOn(CHEMICALS, 0, 600)];
    maker.products = [lineOn(SILICON, 0, 11), lineOn(WAFER, 0, 14_000)];
    maker.licences = [{ nodeId: WAFER, ownerCompanyId: supplier.id, royaltyPct: 10, expiryQuarter: 40 }];

    const wafer = unitCostOf(state, maker, WAFER, createNodeCostCache(state));
    const licence = wafer.lines.find((line) => line.key === `licence:${WAFER}`);
    expect(licence?.amountUsd).toBe(0.1 * 14_000);
    expect(licence?.sourceCompanyId).toBe(supplier.id);
    // A lapsed licence charges nothing.
    maker.licences = [{ nodeId: WAFER, ownerCompanyId: supplier.id, royaltyPct: 10, expiryQuarter: 0 }];
    const lapsed = unitCostOf(state, maker, WAFER, createNodeCostCache(state));
    expect(lapsed.lines.some((line) => line.key.startsWith('licence:'))).toBe(false);
  });

  it('terminates at the tier depth, whatever it is asked for', () => {
    expect(MAX_COST_DEPTH).toBe(NODE_TIERS.length);
    const state = emptyWorld();
    const { maker } = twoCompanies(state);
    // One company that makes literally everything: the deepest possible
    // recursion, on every node in the table, in one pass.
    maker.products = ECONOMIC_NODES.slice(0, 48).map((node) => lineOn(node.id, 0, node.basePriceUsd));
    const cache = createNodeCostCache(state);
    for (const node of ECONOMIC_NODES) {
      const result = unitCostOf(state, maker, node.id, cache);
      expect(Number.isFinite(result.unitCostUsd)).toBe(true);
      expect(result.unitCostUsd).toBeGreaterThanOrEqual(0);
    }
  });
});

/* -------------------------------------------------------------------------- */
/*  The cache                                                                  */
/* -------------------------------------------------------------------------- */

describe('the cost cache', () => {
  it('memoises one entry per company and node, and no more', () => {
    const state = emptyWorld();
    const { maker, supplier } = twoCompanies(state);
    maker.products = [lineOn(SILICON, 0, 11), lineOn(WAFER, 0, 14_000), lineOn(DIE, 0, 420)];
    supplier.products = [lineOn(CHEMICALS, 0, 600)];

    const cache = createNodeCostCache(state);
    unitCostOf(state, maker, DIE, cache);
    // The die, the wafer it makes and the silicon that goes into that: three.
    expect(cache.units.size).toBe(3);
    unitCostOf(state, maker, DIE, cache);
    expect(cache.units.size).toBe(3);
    expect(cache.units.size).toBeLessThanOrEqual(state.companies.length * ECONOMIC_NODES.length);
  });

  it('is per resolution: a fresh cache starts empty and shares nothing with the last one', () => {
    const state = emptyWorld();
    const { maker, supplier } = twoCompanies(state);
    maker.products = [lineOn(SILICON, 0, 11), lineOn(WAFER, 0, 14_000)];
    supplier.products = [lineOn(CHEMICALS, 0, 600)];

    const first = createNodeCostCache(state);
    unitCostOf(state, maker, WAFER, first);
    expect(first.units.size).toBeGreaterThan(0);

    const second = createNodeCostCache(state);
    expect(second.units.size).toBe(0);
    expect(second.capacityRates.size).toBe(0);
    // Same answer either way: the cache is a memo table, never a source of truth.
    expect(unitCostOf(state, maker, WAFER, second).unitCostUsd).toBe(unitCostOf(state, maker, WAFER, first).unitCostUsd);
    // And with no cache at all.
    expect(unitCostOf(state, maker, WAFER).unitCostUsd).toBe(unitCostOf(state, maker, WAFER, first).unitCostUsd);
  });

  it('is one table per resolution, handed to every phase of it', () => {
    const state = createWorld3Session();
    const rng = createRng('cache');
    const first = new ResolutionRecorder(state, hashState, 'opening');
    const second = new ResolutionRecorder(state, hashState, 'opening');

    // Every phase of one resolution shares one table...
    expect(first.contextFor('world_events', rng).costCache).toBe(first.contextFor('snapshot', rng).costCache);
    // ...and the next resolution gets its own, which is what stops a cache
    // outliving the quarter whose prices it was built against.
    expect(second.contextFor('world_events', rng).costCache).not.toBe(first.contextFor('world_events', rng).costCache);
  });
});

/* -------------------------------------------------------------------------- */
/*  The market                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * A context that records what was emitted and logged.
 *
 * The stream is the real seeded one rather than a stub, so a future draw added
 * to the phase would be a real draw — but the phase must not make one: it is
 * pure, which is what lets it be inserted into the pipeline without shifting
 * any other phase's sequence.
 */
function recorder(quarter: number) {
  const events: { type: string; targetId: string | null; payload: Record<string, unknown> }[] = [];
  const lines: { text: string; deltaLabel: string | null }[] = [];
  let counter = 0;
  const ctx: ResolverContext = {
    quarter,
    rng: createRng(`node_market_q${quarter}`),
    emit(draft) {
      events.push({ type: draft.type, targetId: draft.targetId, payload: draft.payload });
      counter += 1;
      return `evt_${counter}`;
    },
    log(line) {
      lines.push({ text: line.text, deltaLabel: line.deltaLabel });
    },
  };
  return { events, lines, ctx };
}

/** A company with one line on `nodeId` and exactly this much plant. */
function withPlant(state: SessionState, nodeId: string, plantUsd: number, unitsSoldLastQuarter = 0): Company {
  const { maker } = twoCompanies(state);
  maker.products = [lineOn(nodeId, unitsSoldLastQuarter, economicNodeById(nodeId)?.basePriceUsd ?? 1)];
  maker.capacity = { plantUsd, fleetUsd: 0, gridUsd: 0 };
  return maker;
}

describe('the node market', () => {
  it('raises a price where demand exceeds supply and lowers it where supply exceeds demand', () => {
    const short = emptyWorld();
    withPlant(short, DIE, 1_000_000);
    const shortBalance = nodeBalances(short)[DIE];
    expect(shortBalance?.demandUnits).toBeGreaterThan(shortBalance?.supplyUnits ?? 0);
    expect(shortBalance?.index).toBeGreaterThan(NODE_PRICE_BASELINE);

    const glut = emptyWorld();
    // Enough plant to make many times the world's end demand for dies.
    withPlant(glut, DIE, 2_000_000_000_000);
    const glutBalance = nodeBalances(glut)[DIE];
    expect(glutBalance?.supplyUnits).toBeGreaterThan(glutBalance?.demandUnits ?? 0);
    expect(glutBalance?.index).toBeLessThan(NODE_PRICE_BASELINE);
  });

  it('reads derived demand from last quarter\'s output, so the market is one linear pass', () => {
    const state = emptyWorld();
    const { maker } = twoCompanies(state);
    // A die line that sold a million units last quarter draws 0.022 wafers and
    // 0.02 MWh for every one of them.
    maker.products = [lineOn(DIE, 1_000_000, 420)];
    const balances = nodeBalances(state);
    expect(balances[WAFER]?.derivedDemandUnits).toBeCloseTo(1_000_000 * 0.022, 6);
    expect(balances[POWER]?.derivedDemandUnits).toBeCloseTo(1_000_000 * 0.02, 6);
    // A wafer has no end customers at all: its only demand is the edge above.
    expect(balances[WAFER]?.endDemandUnits).toBe(0);
  });

  it('rations one bucket across the lines that share it', () => {
    const state = emptyWorld();
    const { maker } = twoCompanies(state);
    maker.capacity = { plantUsd: 1_000_000, fleetUsd: 0, gridUsd: 0 };
    maker.products = [lineOn(DIE, 0, 420)];
    const alone = nodeBalances(state)[DIE]?.supplyUnits ?? 0;

    maker.products = [lineOn(DIE, 0, 420), lineOn(SILICON, 0, 11)];
    const shared = nodeBalances(state)[DIE]?.supplyUnits ?? 0;
    expect(shared).toBe(Math.floor(alone / 2));
  });

  it('never lets a price leave its bounds, however extreme the imbalance', () => {
    const state = emptyWorld();
    // One company with a dollar of plant against the whole world's demand: the
    // most extreme imbalance the market can be handed.
    withPlant(state, DIE, 1);
    for (let quarter = 0; quarter < 12; quarter += 1) {
      const { ctx } = recorder(quarter);
      priceNodes(state, ctx);
      for (const node of ECONOMIC_NODES) {
        const index = nodePriceIndex(state, node.id);
        expect(index).toBeGreaterThanOrEqual(NODE_PRICE_BOUNDS.min);
        expect(index).toBeLessThanOrEqual(NODE_PRICE_BOUNDS.max);
      }
    }
  });

  it('prices a shock in over about three quarters rather than all at once', () => {
    const state = emptyWorld();
    withPlant(state, DIE, 1_000_000);
    const seen: number[] = [];
    for (let quarter = 0; quarter < 12; quarter += 1) {
      const { ctx } = recorder(quarter);
      priceNodes(state, ctx);
      seen.push(nodePriceIndex(state, DIE));
    }
    // Monotone towards the target, never past it, and settled by the end.
    expect(seen[0]).toBe(121);
    for (let i = 1; i < seen.length; i += 1) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1] as number);
    // The target for a total shortage with no world shifter is 160.
    expect(seen[seen.length - 1]).toBeGreaterThanOrEqual(158);
    expect(seen[seen.length - 1]).toBeLessThanOrEqual(160);
    expect(seen[seen.length - 1]).toBe(seen[seen.length - 2]);
  });

  it('is deterministic: the same state prices identically every time', () => {
    const first = emptyWorld();
    withPlant(first, DIE, 1_000_000);
    const second = emptyWorld();
    withPlant(second, DIE, 1_000_000);

    const a = recorder(0);
    const b = recorder(0);
    priceNodes(first, a.ctx);
    priceNodes(second, b.ctx);
    expect(first.nodePrices).toEqual(second.nodePrices);
    expect(a.events.map((event) => event.targetId)).toEqual(b.events.map((event) => event.targetId));
    expect(a.lines).toEqual(b.lines);
    expect(hashState(first)).toBe(hashState(second));
  });

  it('writes a ledger row for every price that moved, and reports only the movers', () => {
    const state = emptyWorld();
    withPlant(state, DIE, 1_000_000);
    const { ctx, events, lines } = recorder(0);
    priceNodes(state, ctx);

    expect(events.length).toBeGreaterThan(0);
    for (const event of events) expect(event.type).toBe('node_price_set');
    expect(lines.length).toBeLessThanOrEqual(6);
    // Every reported line names a node whose row was written.
    const targets = new Set(events.map((event) => event.targetId));
    expect(lines.length).toBeLessThanOrEqual(targets.size);
  });

  it('lets a world variable shift a price only through the shifter table', () => {
    const state = emptyWorld();
    expect(worldShifterFor(state.world, DIE)).toBe(1);
    expect(worldShifterFor(state.world, WAFER)).toBe(1);
    const before = worldShifterFor(state.world, POWER);
    state.world.energy.electricityPrice *= 2;
    expect(worldShifterFor(state.world, POWER)).toBeCloseTo(before * 2, 9);
  });

  it('holds a price where a line nothing constrains supplies whatever is asked', () => {
    const state = emptyWorld();
    const { maker } = twoCompanies(state);
    maker.products = [lineOn('dat_web_corpus', 0, 100)];
    const { linesByCompany } = indexNodeLines(nodeLinesOf(state));
    const line = nodeLinesOf(state)[0];
    expect(line).toBeDefined();
    expect(producibleUnits(state, line as NodeLineRef, linesByCompany)).toBe(Number.POSITIVE_INFINITY);
    // Data is gathered, not manufactured: a producer is never the short side.
    expect(nodeBalances(state)['dat_web_corpus']?.imbalance).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/*  The frozen worlds                                                          */
/* -------------------------------------------------------------------------- */

describe('the frozen worlds', () => {
  it('grow no node prices, so adding the phase cannot move their hashes', () => {
    const engine = createDefaultEngine();
    let state = createWorld2Session();
    for (let quarter = 0; quarter < 2; quarter += 1) {
      const outcome = engine.resolver.resolveQuarter(state, [], null, []);
      expect(outcome.committed).toBe(true);
      state = outcome.nextState;
      expect(state.nodePrices).toBeUndefined();
      expect(outcome.events.some((event) => event.type === 'node_price_set')).toBe(false);
    }
  });

  it('prices every node of a world-3 session, once, inside the bounds', () => {
    const engine = createDefaultEngine();
    const outcome = engine.resolver.resolveQuarter(createWorld3Session(), [], null, []);
    expect(outcome.committed).toBe(true);
    const prices = outcome.nextState.nodePrices;
    expect(prices).toBeDefined();
    expect(Object.keys(prices ?? {})).toHaveLength(ECONOMIC_NODES.length);
    for (const value of Object.values(prices ?? {})) {
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(NODE_PRICE_BOUNDS.min);
      expect(value).toBeLessThanOrEqual(NODE_PRICE_BOUNDS.max);
    }
  });
});
