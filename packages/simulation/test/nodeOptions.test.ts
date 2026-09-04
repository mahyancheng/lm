/**
 * @frontier/simulation — the launch flow's engine surface, and the boundary
 * the canvas is drawn behind.
 *
 * Two things are proved here and neither can be eyeballed on a screen:
 *
 * 1. **A route's price is the roll-up's price.** `inputOptions` exists so the
 *    launch screen renders three buttons instead of walking the graph, and the
 *    only way that is worth anything is if the number on the button is the
 *    number the profit and loss books afterwards. Every route is therefore
 *    checked against `unitCostOf` on the same input in the same session — not
 *    against a restatement of the formula, which would pass while both were
 *    wrong together.
 * 2. **A rival's economics are not in the projection.** In demo mode the whole
 *    aggregate sits in the browser tab, so `nodeMapFor` is the entire
 *    information boundary for the canvas. The test walks the serialised
 *    projection and asserts that no rival list price, ask, unit cost, margin
 *    or quality score appears anywhere in it — by value, so a field renamed
 *    into innocence still fails.
 */

import { describe, expect, it } from 'vitest';
import type { Company, Product, SessionState } from '@frontier/contracts';
import { economicNodeById, nodeMarketPriceUsd } from '@frontier/contracts';
import { createWorld3Session } from '../src/scenario/world3';
import { createDemoSession } from '../src/scenario';
import {
  MARKET_QUALITY,
  biggestCostSentence,
  costBreakdown,
  inputOptions,
  nodeEntryRoutes,
  nodeSellersFor,
  priceVerdict,
} from '../src/graph/options';
import { OPEN_MARKET_PREMIUM, unitCostOf } from '../src/graph/cost';
import { chainNodeIds, neighbourhoodNodeIds, nodeMapFor } from '../src/graph/projection';
import { createNodeCostCache } from '../src/graph/lines';

/* -------------------------------------------------------------------------- */
/*  Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

/** A node with real inputs, in the sector the fixtures live in. */
const ACCELERATOR = 'sys_ai_accelerator';
const WAFER = 'mat_wafer_300mm';
const DIE = 'cmp_accelerator_die';

/** One line on one node, minimal but complete. */
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
 * A world-3 session with every seeded line removed, so the only lines in it are
 * the ones a test puts there. Ownership and prices are left exactly as the
 * scenario built them.
 */
function bareWorld(): SessionState {
  const state = createWorld3Session();
  for (const company of state.companies) company.products = [];
  return state;
}

/** Give `company` a published line on `nodeId` that anybody may buy from. */
function publishLine(company: Company, nodeId: string, askUsd: number, quality = 0.6): Product {
  const product = lineOn(nodeId, 1_000, askUsd);
  product.qualityScore = quality;
  product.supplyTerms = { openToAll: true, pricePerUnitUsd: askUsd, exclusiveCustomerIds: [], blockedCustomerIds: [] };
  company.products.push(product);
  if (!(company.ownedNodes ?? []).includes(nodeId)) company.ownedNodes = [...(company.ownedNodes ?? []), nodeId];
  return product;
}

/* -------------------------------------------------------------------------- */
/*  1. The three routes                                                        */
/* -------------------------------------------------------------------------- */

describe('inputOptions — the three shapes, priced as the roll-up prices them', () => {
  it('offers market for every input when nothing is made and nobody is named', () => {
    const state = bareWorld();
    const company = state.companies[0] as Company;
    const node = economicNodeById(ACCELERATOR);
    expect(node?.consumes.length ?? 0).toBeGreaterThan(0);

    const options = inputOptions(state, company, ACCELERATOR);
    expect(options.length).toBe(node?.consumes.length);
    for (const option of options) {
      const market = option.routes.find((route) => route.kind === 'market');
      expect(market, `${option.inputNodeId} has no market route`).toBeDefined();
      // The spot price is the node's own settled price plus the premium, to the
      // cent — the same arithmetic `openMarketPriceUsd` gives the roll-up.
      expect(market?.unitPriceUsd).toBeCloseTo(nodeMarketPriceUsd(state, option.inputNodeId) * OPEN_MARKET_PREMIUM, 6);
      expect(market?.premiumPct).toBe(Math.round((OPEN_MARKET_PREMIUM - 1) * 100));
      expect(market?.qualityScore).toBe(MARKET_QUALITY);
    }
  });

  it('quotes a make route at this company\'s own unit cost, with no internal margin', () => {
    const state = bareWorld();
    const company = state.companies[0] as Company;
    company.ownedNodes = [...(company.ownedNodes ?? []), WAFER, DIE, ACCELERATOR];
    company.products = [lineOn(WAFER, 5_000, 900)];

    const options = inputOptions(state, company, DIE);
    const wafer = options.find((option) => option.inputNodeId === WAFER);
    expect(wafer, 'the die does not consume a wafer any more').toBeDefined();

    const make = wafer?.routes.find((route) => route.kind === 'make');
    expect(make?.supplierCompanyId).toBe(company.id);
    // The transfer price is the roll-up's own answer for that node, exactly.
    expect(make?.unitPriceUsd).toBe(unitCostOf(state, company, WAFER).unitCostUsd);
    expect(wafer?.chosen?.kind).toBe('make');
  });

  it('quotes a buy route only from a seller whose terms are open to this buyer', () => {
    const state = bareWorld();
    const buyer = state.companies[0] as Company;
    const seller = state.companies[1] as Company;
    publishLine(seller, WAFER, 1_200);

    expect(nodeSellersFor(state, buyer.id, WAFER).map((entry) => entry.company.id)).toEqual([seller.id]);

    // Blocked, and the seller vanishes from the list rather than appearing greyed.
    const line = seller.products[0] as Product;
    line.supplyTerms = { openToAll: true, pricePerUnitUsd: 1_200, exclusiveCustomerIds: [], blockedCustomerIds: [buyer.id] };
    expect(nodeSellersFor(state, buyer.id, WAFER)).toEqual([]);
  });

  it('marks the named supplier as the chosen route, and the roll-up agrees', () => {
    const state = bareWorld();
    const buyer = state.companies[0] as Company;
    const seller = state.companies[1] as Company;
    const sellerLine = publishLine(seller, WAFER, 1_200);

    const buyerLine = lineOn(DIE, 2_000, 3_000);
    buyerLine.supply = [
      { inputCategoryId: WAFER, supplierCompanyId: seller.id, supplierProductId: sellerLine.id, cutOffNoticeQuarter: null },
    ];
    buyer.products = [buyerLine];
    buyer.ownedNodes = [...(buyer.ownedNodes ?? []), DIE];

    const wafer = inputOptions(state, buyer, DIE, buyerLine.id).find((option) => option.inputNodeId === WAFER);
    expect(wafer?.chosen?.kind).toBe('buy');
    expect(wafer?.chosen?.supplierCompanyId).toBe(seller.id);

    // What the screen quotes is what cost of goods will charge: the same input's
    // line in the roll-up carries the same price and the same counterparty.
    const rollUp = unitCostOf(state, buyer, DIE);
    const costLine = rollUp.lines.find((entry) => entry.key === WAFER);
    expect(costLine?.sourceKind).toBe('buy');
    expect(costLine?.sourceCompanyId).toBe(seller.id);
    expect(costLine?.unitPriceUsd).toBeCloseTo(wafer?.chosen?.unitPriceUsd ?? -1, 6);
  });

  it('reports an input as blocked exactly when the roll-up blocks it', () => {
    const state = bareWorld();
    const company = state.companies[0] as Company;
    const node = economicNodeById(ACCELERATOR);
    const required = node?.consumes.find((input) => !input.substitutable);
    expect(required, 'the accelerator has no non-substitutable input to block').toBeDefined();

    // Strip ownership of that input from the whole world: nobody can make it at
    // any price, which is the only thing that blocks.
    const inputId = required?.nodeId ?? '';
    for (const candidate of state.companies) {
      candidate.ownedNodes = (candidate.ownedNodes ?? []).filter((id) => id !== inputId);
      candidate.licences = (candidate.licences ?? []).filter((licence) => licence.nodeId !== inputId);
      candidate.products = candidate.products.filter((product) => product.nodeId !== inputId);
    }

    const option = inputOptions(state, company, ACCELERATOR).find((entry) => entry.inputNodeId === inputId);
    expect(option?.blocked).toBe(true);
    expect(option?.chosen).toBeNull();
    expect(unitCostOf(state, company, ACCELERATOR).blockedInputNodeIds).toContain(inputId);
  });
});

/* -------------------------------------------------------------------------- */
/*  2. The cost breakdown and the sentence over it                             */
/* -------------------------------------------------------------------------- */

describe('costBreakdown — descending, with the biggest line named', () => {
  it('sorts descending, shares sum to the whole, and keeps a zero row', () => {
    const state = bareWorld();
    const company = state.companies[0] as Company;
    company.ownedNodes = [...(company.ownedNodes ?? []), ACCELERATOR];
    const result = unitCostOf(state, company, ACCELERATOR);
    const rows = costBreakdown(result);

    expect(rows.length).toBe(result.lines.length);
    for (let i = 1; i < rows.length; i += 1) {
      expect((rows[i - 1]?.amountUsd ?? 0) >= (rows[i]?.amountUsd ?? 0)).toBe(true);
    }
    // Every row's share is a whole percent, and they add to 100 within the
    // rounding of one row each.
    const total = rows.reduce((sum, row) => sum + row.sharePct, 0);
    expect(Math.abs(total - 100)).toBeLessThanOrEqual(rows.length);
    expect(rows.every((row) => Number.isInteger(row.sharePct))).toBe(true);
  });

  it('names the counterparty in the sentence when the biggest line is bought from somebody', () => {
    const state = bareWorld();
    const buyer = state.companies[0] as Company;
    const seller = state.companies[1] as Company;
    seller.name = 'Basalt';
    const sellerLine = publishLine(seller, DIE, 24_000);

    const buyerLine = lineOn(ACCELERATOR, 500, 40_000);
    buyerLine.supply = [
      { inputCategoryId: DIE, supplierCompanyId: seller.id, supplierProductId: sellerLine.id, cutOffNoticeQuarter: null },
    ];
    buyer.products = [buyerLine];
    buyer.ownedNodes = [...(buyer.ownedNodes ?? []), ACCELERATOR];

    const result = unitCostOf(state, buyer, ACCELERATOR);
    const rows = costBreakdown(result);
    const names = new Map(state.companies.map((company) => [company.id, company.name]));
    const sentence = biggestCostSentence(result, rows, names, (value) => `$${Math.round(value)}`);

    expect(sentence).toContain('of your');
    expect(sentence).toContain('unit cost is');
    if (rows[0]?.sourceCompanyId === seller.id) expect(sentence).toContain('Basalt');
  });

  it('says nothing at all about a line that costs nothing', () => {
    const empty = { nodeId: 'res_silicon_feedstock', unitCostUsd: 0, lines: [], madeInHouseSharePct: 0, blockedInputNodeIds: [] };
    expect(biggestCostSentence(empty, costBreakdown(empty), new Map(), String)).toBe('');
  });
});

/* -------------------------------------------------------------------------- */
/*  3. A price is judged against its own node's market price                   */
/* -------------------------------------------------------------------------- */

describe('priceVerdict', () => {
  it('measures against the node\'s own market price, never a segment average', () => {
    const state = bareWorld();
    const node = economicNodeById(ACCELERATOR);
    const market = nodeMarketPriceUsd(state, ACCELERATOR);
    const verdict = priceVerdict(state, node!, market * 1.2, market * 0.5);

    expect(verdict.marketPriceUsd).toBe(market);
    expect(verdict.againstMarketPct).toBe(20);
    // Margin is whole percent, and negative when the price is under cost.
    expect(verdict.grossMarginPct).toBe(Math.round((1 - market * 0.5 / (market * 1.2)) * 100));
    expect(priceVerdict(state, node!, 100, 150).grossMarginPct).toBe(-50);
  });
});

/* -------------------------------------------------------------------------- */
/*  4. A node you cannot make yet                                              */
/* -------------------------------------------------------------------------- */

describe('nodeEntryRoutes — research it, licence it, or buy the output', () => {
  it('names every node still missing and offers a licensor that publishes an offer', () => {
    const state = bareWorld();
    const company = state.companies[0] as Company;
    const owner = state.companies[1] as Company;
    owner.name = 'Meridian';

    company.ownedNodes = [];
    company.licences = [];
    owner.ownedNodes = [ACCELERATOR];
    owner.licenceOffers = [{ nodeId: ACCELERATOR, royaltyPct: 9, openToAll: true }];

    const routes = nodeEntryRoutes(state, company, ACCELERATOR);
    expect(routes.canProduce).toBe(false);
    expect(routes.missing.map((entry) => entry.nodeId)).toContain(ACCELERATOR);

    const own = routes.missing.find((entry) => entry.nodeId === ACCELERATOR);
    expect(own?.licensors.map((licensor) => licensor.name)).toContain('Meridian');
    expect(own?.licensors[0]?.royaltyPct).toBe(9);
    // The third route: somebody who will simply sell the finished thing.
    publishLine(owner, ACCELERATOR, 250_000);
    expect(nodeEntryRoutes(state, company, ACCELERATOR).buyInstead.map((row) => row.name)).toContain('Meridian');
  });

  it('reports nothing missing for a node the company already holds outright', () => {
    const state = bareWorld();
    const company = state.companies[0] as Company;
    const node = economicNodeById(WAFER);
    company.ownedNodes = [WAFER, ...(node?.requires ?? [])];
    const routes = nodeEntryRoutes(state, company, WAFER);
    expect(routes.canProduce).toBe(true);
    expect(routes.missing).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/*  5. The information boundary                                                */
/* -------------------------------------------------------------------------- */

/** Every number anywhere inside a value, however deeply nested. */
function numbersIn(value: unknown, out: number[] = []): number[] {
  if (typeof value === 'number') out.push(value);
  else if (Array.isArray(value)) for (const entry of value) numbersIn(entry, out);
  else if (value !== null && typeof value === 'object') for (const entry of Object.values(value)) numbersIn(entry, out);
  return out;
}

describe('nodeMapFor — relationships are public, economics are not', () => {
  it('carries who owns and who produces every node, and the names to render them', () => {
    const state = createWorld3Session();
    const viewer = state.companies[0] as Company;
    const view = nodeMapFor(state, viewer.id);

    expect(view.viewerCompanyId).toBe(viewer.id);
    expect(view.nodes.length).toBeGreaterThan(80);
    // Somebody owns something, and every id named resolves to a name.
    const named = view.nodes.flatMap((node) => [...node.ownerCompanyIds, ...node.producerCompanyIds]);
    expect(named.length).toBeGreaterThan(0);
    for (const companyId of named) expect(view.companyNames[companyId]).toBeTypeOf('string');
    // Structure is the table's, both edge kinds present.
    expect(view.wires.some((wire) => wire.kind === 'consumes')).toBe(true);
    expect(view.wires.some((wire) => wire.kind === 'requires')).toBe(true);
  });

  it('never carries a rival\'s list price, ask, unit cost, margin or quality', () => {
    const state = createWorld3Session();
    const viewer = state.companies[0] as Company;
    const rival = state.companies.find((company) => company.id !== viewer.id && company.products.length > 0);
    expect(rival, 'the scenario seeded no rival with a line').toBeDefined();

    // Give the rival prices no two of which collide with anything else in the
    // world, so finding one in the projection is proof rather than coincidence.
    const rivalLine = rival?.products[0] as Product;
    rivalLine.pricePerSeat = 7_777_777;
    rivalLine.unitCostUsd = 6_666_666;
    rivalLine.grossMarginPct = 0.123_456;
    rivalLine.qualityScore = 0.987_654;
    rivalLine.supplyTerms = { openToAll: true, pricePerUnitUsd: 5_555_555, exclusiveCustomerIds: [], blockedCustomerIds: [] };

    const found = new Set(numbersIn(nodeMapFor(state, viewer.id)));
    for (const secret of [7_777_777, 6_666_666, 0.123_456, 0.987_654, 5_555_555]) {
      expect(found.has(secret), `${secret} reached the client`).toBe(false);
    }

    // And a supply wire carries the relationship without a price on it.
    for (const wire of nodeMapFor(state, viewer.id).supplyWires) {
      expect(Object.keys(wire).sort()).toEqual(
        ['buyerCompanyId', 'buyerNodeId', 'buyerProductId', 'inputNodeId', 'supplierCompanyId'],
      );
    }
  });

  it('fits the opening view to the viewer\'s own chain, and focuses one node with its neighbours', () => {
    const state = createWorld3Session();
    const viewer = state.companies.find((company) => company.products.some((product) => product.nodeId !== undefined)) as Company;
    const view = nodeMapFor(state, viewer.id);

    const chain = chainNodeIds(view);
    const mine = view.nodes.filter((node) => node.yourProductId !== null).map((node) => node.nodeId);
    expect(mine.length).toBeGreaterThan(0);
    for (const nodeId of mine) expect(chain).toContain(nodeId);
    // The chain is a proper subset of the map: fitting to it is the point.
    expect(chain.length).toBeLessThan(view.nodes.length);

    const focus = mine[0] as string;
    const around = neighbourhoodNodeIds(view, focus);
    expect(around).toContain(focus);
    for (const input of economicNodeById(focus)?.consumes ?? []) expect(around).toContain(input.nodeId);
  });

  it('is empty of world-3 lines in a world-2 session, and does not throw', () => {
    const state = createDemoSession();
    const view = nodeMapFor(state, state.companies[0]?.id ?? '');
    expect(view.nodes.every((node) => node.yourProductId === null)).toBe(true);
    expect(view.supplyWires).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/*  6. The cache is honoured                                                   */
/* -------------------------------------------------------------------------- */

describe('inputOptions with a cost cache', () => {
  it('gives the same answer with and without one', () => {
    const state = bareWorld();
    const company = state.companies[0] as Company;
    company.ownedNodes = [...(company.ownedNodes ?? []), WAFER, DIE];
    company.products = [lineOn(WAFER, 5_000, 900)];

    const cache = createNodeCostCache(state);
    const withCache = inputOptions(state, company, DIE, null, cache);
    const without = inputOptions(state, company, DIE);
    expect(withCache.map((option) => [option.inputNodeId, option.chosen?.kind, option.chosen?.unitPriceUsd])).toEqual(
      without.map((option) => [option.inputNodeId, option.chosen?.kind, option.chosen?.unitPriceUsd]),
    );
  });
});
