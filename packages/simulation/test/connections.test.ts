/**
 * The Connections engine: the viewer's own order book on a wire, who buys a
 * line, what share of its market it took, and what a seat is entitled to see
 * when it looks at somebody else's company.
 *
 * The privacy tests are the point of the file. A rival is stamped with five
 * numbers that collide with nothing else in the world, and the assertions say
 * exactly where each of them may and may not appear.
 */

import { describe, expect, it } from 'vitest';
import type { Company, EconomicNode, GovernmentContract, Product } from '@frontier/contracts';
import { economicNodeById } from '@frontier/contracts';
import { createDemoSession, createWorld3Session } from '../src/scenario/index';
import { connectionsOf, customersOf, lineMarketShare, marketsForNode, MAX_ALTERNATIVES_PER_SLOT } from '../src/graph/connections';
import { namedSupplierPriceUsd, unitCostOf } from '../src/graph/cost';
import { createNodeCostCache, unitsSoldLastQuarterOf } from '../src/graph/lines';
import { nodeBalances } from '../src/graph/market';
import { nodeMapFor } from '../src/graph/projection';
import { cellKey, cellOf } from '../src/graph/slots';
import { sectorOf } from '../src/economy/sectors';

const PLAYER = 'cmp_player_ventures';
const API_NODE = 'svc_inference_api';

/** The five numbers a rival owns, none of which collides with anything else in the world. */
const RIVAL_LIST_PRICE = 7_777_777;
const RIVAL_UNIT_COST = 6_666_666;
const RIVAL_MARGIN = 0.123_456;
const RIVAL_QUALITY = 0.987_654;
const RIVAL_ASK = 5_555_555;

function companyOf(state: ReturnType<typeof createWorld3Session>, id: string): Company {
  const company = state.companies.find((candidate) => candidate.id === id);
  expect(company, `${id} is not in the seeded world`).toBeDefined();
  return company as Company;
}

function productOn(company: Company, nodeId: string): Product {
  const product = company.products.find((candidate) => candidate.nodeId === nodeId);
  expect(product, `${company.id} runs no line on ${nodeId}`).toBeDefined();
  return product as Product;
}

function qtyOf(nodeId: string, slotId: string): number {
  const slot = economicNodeById(nodeId)?.slots.find((candidate) => candidate.id === slotId);
  expect(slot, `${nodeId} has no slot ${slotId}`).toBeDefined();
  return slot?.qtyPerUnit ?? 0;
}

/**
 * The player with a second line: an inference API of their own, published, with
 * their app switched onto it and one rival buying it.
 *
 * The stored-fill equivalent of the canvas test's route override — a rival's
 * `model` slot rewritten to name the player's line — so `resolveFill` produces
 * a real BUY and the wire is a real relationship rather than a fixture.
 */
function withPlayerApiLine(state: ReturnType<typeof createWorld3Session>): {
  readonly player: Company;
  readonly app: Product;
  readonly api: Product;
  readonly buyer: Company;
  readonly buyerLine: Product;
} {
  const player = companyOf(state, PLAYER);
  const app = productOn(player, 'app_ai_software_suite');
  const api: Product = {
    ...app,
    id: 'prd_player_api',
    name: 'Ventures Inference',
    nodeId: API_NODE,
    slots: [],
    supplyTerms: { openToAll: true, pricePerUnitUsd: 12, exclusiveCustomerIds: [], blockedCustomerIds: [] },
    unitsSoldQuarterly: 2_000_000,
    activeCustomers: 2_000_000,
    pricePerSeat: 12,
  };
  (player.products as Product[]).push(api);

  // My own app now runs on my own API: a make wire out of the new line.
  const own = app.slots?.find((slot) => slot.slotId === 'model');
  expect(own).toBeDefined();
  if (own !== undefined) {
    own.supplierCompanyId = player.id;
    own.supplierProductId = api.id;
    own.nodeId = API_NODE;
  }

  // And one rival buys it, in the slot it already fills from somebody else.
  const buyer = companyOf(state, 'cmp_lumen');
  const buyerLine = productOn(buyer, 'app_consumer_subscription');
  const fill = buyerLine.slots?.find((slot) => slot.slotId === 'model');
  expect(fill).toBeDefined();
  if (fill !== undefined) {
    fill.supplierCompanyId = player.id;
    fill.supplierProductId = api.id;
    fill.nodeId = API_NODE;
  }

  return { player, app, api, buyer, buyerLine };
}

/** Stamp a rival's line with the five numbers nobody else in the world owns. */
function stamp(line: Product): void {
  line.pricePerSeat = RIVAL_LIST_PRICE;
  line.unitCostUsd = RIVAL_UNIT_COST;
  line.grossMarginPct = RIVAL_MARGIN;
  line.qualityScore = RIVAL_QUALITY;
  line.supplyTerms = { openToAll: true, pricePerUnitUsd: RIVAL_ASK, exclusiveCustomerIds: [], blockedCustomerIds: [] };
}

/** Every number anywhere inside a serialised view, however deeply nested. */
function numbersIn(value: unknown, found: number[] = []): readonly number[] {
  if (typeof value === 'number') found.push(value);
  else if (Array.isArray(value)) for (const entry of value) numbersIn(entry, found);
  else if (value !== null && typeof value === 'object') for (const entry of Object.values(value)) numbersIn(entry, found);
  return found;
}

/* -------------------------------------------------------------------------- */

describe('the order book on a supply wire', () => {
  it('counts the units on a wire the viewer is standing on, and none on one between two other companies', () => {
    const state = createWorld3Session();
    const player = companyOf(state, PLAYER);
    const app = productOn(player, 'app_ai_software_suite');
    const view = nodeMapFor(state, PLAYER);

    const mine = view.supplyWires.find((wire) => wire.buyerCompanyId === PLAYER && wire.slotId === 'model');
    expect(mine).toBeDefined();
    expect(mine?.supplierCompanyId).toBe('cmp_basalt');
    // The wire's own arithmetic, and the market's, are one expression.
    const expected = unitsSoldLastQuarterOf(app) * qtyOf('app_ai_software_suite', 'model');
    expect(mine?.unitsDrawnLastQuarter).toBe(expected);
    expect(expected).toBeGreaterThan(0);

    // That draw is inside the derived demand the market landed for the node,
    // in the buyer's own cell — the same units counted once.
    const balances = nodeBalances(state);
    const cell = balances[API_NODE]?.cells[cellKey(sectorOf(player), 'enterprise')] ?? 0;
    expect(cell).toBeGreaterThanOrEqual(expected);

    // A wire between two other companies is a relationship and nothing else.
    const foreign = view.supplyWires.find((wire) => wire.buyerCompanyId !== PLAYER && wire.supplierCompanyId !== PLAYER);
    expect(foreign, 'the seed has no wire between two other companies').toBeDefined();
    expect(foreign?.unitsDrawnLastQuarter).toBeNull();

    // The same wire, from either end of it, carries the units.
    const fromBuyer = nodeMapFor(state, foreign?.buyerCompanyId ?? '').supplyWires.find(
      (wire) => wire.buyerProductId === foreign?.buyerProductId && wire.slotId === foreign?.slotId,
    );
    const fromSupplier = nodeMapFor(state, foreign?.supplierCompanyId ?? '').supplyWires.find(
      (wire) => wire.buyerProductId === foreign?.buyerProductId && wire.slotId === foreign?.slotId,
    );
    expect(typeof fromBuyer?.unitsDrawnLastQuarter).toBe('number');
    expect(fromSupplier?.unitsDrawnLastQuarter).toBe(fromBuyer?.unitsDrawnLastQuarter);
  });

  it('counts a company\'s own make wire', () => {
    const state = createWorld3Session();
    const { app } = withPlayerApiLine(state);
    const wire = nodeMapFor(state, PLAYER).supplyWires.find((entry) => entry.buyerProductId === app.id && entry.slotId === 'model');
    expect(wire?.supplierCompanyId).toBe(PLAYER);
    expect(wire?.unitsDrawnLastQuarter).toBe(unitsSoldLastQuarterOf(app) * qtyOf('app_ai_software_suite', 'model'));
  });
});

/* -------------------------------------------------------------------------- */

describe('customersOf', () => {
  it('names every buyer of a published line, prices it at the ask the buyer books, and marks an internal transfer', () => {
    const state = createWorld3Session();
    const { player, app, api, buyer, buyerLine } = withPlayerApiLine(state);
    const cache = createNodeCostCache(state);
    const rows = customersOf(state, PLAYER, api.id, cache);

    expect(rows.map((row) => row.buyerCompanyId).sort()).toEqual([PLAYER, buyer.id].sort());

    const external = rows.find((row) => row.buyerCompanyId === buyer.id);
    expect(external?.internal).toBe(false);
    expect(external?.buyerProductId).toBe(buyerLine.id);
    // The ask, bounded exactly as the buyer's own roll-up bounds it.
    const ask = api.supplyTerms?.pricePerUnitUsd ?? 0;
    expect(external?.unitPriceUsd).toBe(namedSupplierPriceUsd(state, player, ask, API_NODE));
    const externalUnits = unitsSoldLastQuarterOf(buyerLine) * qtyOf('app_consumer_subscription', 'model');
    expect(external?.unitsDrawnLastQuarter).toBe(externalUnits);
    expect(external?.bookedByBuyerUsd).toBe(externalUnits * (external?.unitPriceUsd ?? 0));

    const internal = rows.find((row) => row.buyerCompanyId === PLAYER);
    expect(internal?.internal).toBe(true);
    expect(internal?.buyerProductId).toBe(app.id);
    // An internal transfer moves at own cost, with no margin taken on the way.
    expect(internal?.unitPriceUsd).toBe(unitCostOf(state, player, API_NODE, cache).unitCostUsd);
    expect(internal?.unitsDrawnLastQuarter).toBe(unitsSoldLastQuarterOf(app) * qtyOf('app_ai_software_suite', 'model'));

    // Biggest booking first.
    for (let index = 1; index < rows.length; index += 1) {
      expect(rows[index - 1]?.bookedByBuyerUsd ?? 0).toBeGreaterThanOrEqual(rows[index]?.bookedByBuyerUsd ?? 0);
    }
  });

  it('is empty for a line nobody has named', () => {
    const state = createWorld3Session();
    const app = productOn(companyOf(state, PLAYER), 'app_ai_software_suite');
    expect(customersOf(state, PLAYER, app.id)).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */

describe('a line against its own market', () => {
  it('reports the share of the cell the line actually draws from, clamped', () => {
    const state = createWorld3Session();
    const player = companyOf(state, PLAYER);
    const app = productOn(player, 'app_ai_software_suite');
    const node = economicNodeById('app_ai_software_suite') as EconomicNode;
    const balances = nodeBalances(state);

    const share = lineMarketShare(state, player, app, balances);
    expect(share).not.toBeNull();
    const cell = cellOf(app, node);
    expect(share?.cellKey).toBe(cellKey(cell.industry, cell.customer));
    expect(share?.industry).toBe(cell.industry);
    expect(share?.customer).toBe(cell.customer);

    const demand = balances['app_ai_software_suite']?.cells[share?.cellKey ?? ''] ?? 0;
    expect(share?.demandUnits).toBe(demand);
    expect(share?.myUnits).toBe(unitsSoldLastQuarterOf(app));
    const expected = demand <= 0 ? 0 : Math.min(100, Math.max(0, Math.round((unitsSoldLastQuarterOf(app) / demand) * 100)));
    expect(share?.sharePct).toBe(expected);
    expect(share?.sharePct).toBeGreaterThanOrEqual(0);
    expect(share?.sharePct).toBeLessThanOrEqual(100);
  });

  it('has nothing to say about a product with no node', () => {
    const demo = createDemoSession();
    const company = demo.companies.find((candidate) => candidate.products.length > 0) as Company;
    const product = company.products[0] as Product;
    expect(product.nodeId).toBeUndefined();
    expect(lineMarketShare(demo, company, product)).toBeNull();
  });
});

describe('marketsForNode', () => {
  it('lists every cell that is asking for something, biggest first, and drops the ones that are not', () => {
    const state = createWorld3Session();
    const balances = nodeBalances(state);
    const cells = marketsForNode(state, API_NODE, balances);

    expect(cells.length).toBeGreaterThan(0);
    for (const cell of cells) expect(cell.demandUnits).toBeGreaterThan(0);
    for (let index = 1; index < cells.length; index += 1) {
      expect(cells[index - 1]?.demandUnits ?? 0).toBeGreaterThanOrEqual(cells[index]?.demandUnits ?? 0);
    }

    const balance = balances[API_NODE];
    const zeroes = Object.entries(balance?.cells ?? {}).filter(([, units]) => units <= 0);
    for (const [key] of zeroes) expect(cells.some((cell) => cell.cellKey === key)).toBe(false);
    // Only zeroes were dropped, so what is left is the whole of the demand.
    const total = cells.reduce((sum, cell) => sum + cell.demandUnits, 0);
    expect(total).toBeCloseTo(balance?.demandUnits ?? 0, 6);
  });
});

/* -------------------------------------------------------------------------- */

describe('connectionsOf, on the viewer\'s own company', () => {
  it('carries the hub figures, the live fill first in every slot and at most two alternatives', () => {
    const state = createWorld3Session();
    const player = companyOf(state, PLAYER);
    const app = productOn(player, 'app_ai_software_suite');
    const view = connectionsOf(state, PLAYER, PLAYER, app.id);

    expect(view.isOwn).toBe(true);
    expect(view.productId).toBe(app.id);
    expect(view.lines.filter((line) => line.selected).map((line) => line.productId)).toEqual([app.id]);
    expect(view.hub?.nodeId).toBe('app_ai_software_suite');
    expect(view.hub?.listPriceUsd).toBe(app.pricePerSeat);
    expect(view.hub?.grossMarginPct).toBe(app.grossMarginPct);
    expect(view.hub?.unitsSoldLastQuarter).toBe(unitsSoldLastQuarterOf(app));
    expect(view.hub?.unitCostUsd).toBe(unitCostOf(state, player, 'app_ai_software_suite', createNodeCostCache(state)).unitCostUsd);
    expect(view.hub?.askUsd).toBeNull();

    const slotIds = (economicNodeById('app_ai_software_suite') as EconomicNode).slots.map((slot) => slot.id);
    expect(view.suppliers.map((supplier) => supplier.slotId)).toEqual(slotIds);
    for (const supplier of view.suppliers) {
      expect(supplier.options[0]?.live).toBe(true);
      expect(supplier.options.slice(1).every((option) => !option.live)).toBe(true);
      expect(supplier.options.length).toBeLessThanOrEqual(1 + MAX_ALTERNATIVES_PER_SLOT);
      expect(supplier.moreCount).toBeGreaterThanOrEqual(0);
      // An alternative is a route nobody has taken, so nothing has crossed it.
      for (const option of supplier.options.slice(1)) expect(option.unitsDrawnLastQuarter).toBeNull();
    }

    const model = view.suppliers.find((supplier) => supplier.slotId === 'model');
    expect(model?.options[0]?.kind).toBe('buy');
    expect(model?.options[0]?.supplierCompanyId).toBe('cmp_basalt');
    expect(model?.options[0]?.unitsDrawnLastQuarter).toBe(unitsSoldLastQuarterOf(app) * qtyOf('app_ai_software_suite', 'model'));
    expect(view.companyNames['cmp_basalt']).toBe(companyOf(state, 'cmp_basalt').name);

    // The live cell first, then everything else the node's market wants.
    expect(view.cells[0]?.live).toBe(true);
    expect(view.cells[0]?.sharePct).not.toBeNull();
    expect(view.cells[0]?.listPriceUsd).toBe(app.pricePerSeat);
    for (const cell of view.cells.slice(1)) {
      expect(cell.live).toBe(false);
      expect(cell.sharePct).toBeNull();
      expect(cell.myUnits).toBeNull();
      expect(cell.listPriceUsd).toBeNull();
    }
  });

  it('lists the buyers of a published line as customers', () => {
    const state = createWorld3Session();
    const { api, buyer } = withPlayerApiLine(state);
    const view = connectionsOf(state, PLAYER, PLAYER, api.id);
    expect(view.customers.map((customer) => customer.buyerCompanyId)).toContain(buyer.id);
    expect(view.customers.every((customer) => customer.unitsDrawnLastQuarter !== null)).toBe(true);
    expect(view.hub?.askUsd).toBe(api.supplyTerms?.pricePerUnitUsd);
    expect(view.companyNames[buyer.id]).toBe(buyer.name);
  });

  it('says so plainly when a company runs no line at all', () => {
    const state = createWorld3Session();
    const player = companyOf(state, PLAYER);
    for (const product of player.products) product.isActive = false;
    const view = connectionsOf(state, PLAYER, PLAYER, null);
    expect(view.lines).toEqual([]);
    expect(view.productId).toBeNull();
    expect(view.hub).toBeNull();
    expect(view.suppliers).toEqual([]);
    expect(view.customers).toEqual([]);
    expect(view.cells).toEqual([]);
    // Company-wide relationships survive: they belong to the company, not the line.
    expect(Array.isArray(view.agencies)).toBe(true);
    expect(Array.isArray(view.compute)).toBe(true);
    expect(view.companyNames[PLAYER]).toBe(player.name);
  });

  it('falls back to the first active line when no product is named', () => {
    const state = createWorld3Session();
    const app = productOn(companyOf(state, PLAYER), 'app_ai_software_suite');
    expect(connectionsOf(state, PLAYER, PLAYER, null).productId).toBe(app.id);
    expect(connectionsOf(state, PLAYER, PLAYER, 'prd_not_a_line').productId).toBe(app.id);
  });
});

/* -------------------------------------------------------------------------- */

describe('what a rival\'s numbers may reach', () => {
  it('keeps a supplier\'s list price, unit cost and margin out of my own view, and its ask and quality inside its own offer', () => {
    const state = createWorld3Session();
    const basalt = companyOf(state, 'cmp_basalt');
    const basaltApi = productOn(basalt, API_NODE);
    stamp(basaltApi);

    const app = productOn(companyOf(state, PLAYER), 'app_ai_software_suite');
    const view = connectionsOf(state, PLAYER, PLAYER, app.id);
    const found = new Set(numbersIn(view));

    // Never published to anybody: their price to their own customers, what a
    // unit costs them, and what they keep on it.
    for (const secret of [RIVAL_LIST_PRICE, RIVAL_UNIT_COST, RIVAL_MARGIN]) {
      expect(found.has(secret), `${secret} reached the viewer`).toBe(false);
    }

    // Published TO ME, and therefore mine to read — but only ever inside the
    // offer that seller made me. The ask arrives bounded by the market, so the
    // raw figure never appears at all; the quality does, on that pill and
    // nowhere else.
    const theirs = view.suppliers.flatMap((supplier) => supplier.options).filter((option) => option.supplierCompanyId === basalt.id);
    expect(theirs.length).toBeGreaterThan(0);
    expect(theirs.some((option) => option.qualityScore === RIVAL_QUALITY)).toBe(true);
    expect(found.has(RIVAL_ASK), 'a raw ask escaped the market bounds').toBe(false);

    const elsewhere = view.suppliers
      .flatMap((supplier) => supplier.options)
      .filter((option) => option.supplierCompanyId !== basalt.id)
      .flatMap((option) => [option.qualityScore, option.unitPriceUsd]);
    expect(elsewhere.includes(RIVAL_QUALITY)).toBe(false);
  });

  it('says nothing numeric about a company I am not trading with', () => {
    const state = createWorld3Session();
    // A frontier laboratory two steps up my own chain: it buys corpora from a
    // third company and sells to my supplier, and has no wire to me at all.
    const rival = companyOf(state, 'cmp_aletheia');
    stamp(rival.products[0] as Product);

    const view = connectionsOf(state, PLAYER, rival.id, null);
    expect(view.isOwn).toBe(false);
    expect(view.subjectCompanyId).toBe(rival.id);

    const found = new Set(numbersIn(view));
    for (const secret of [RIVAL_LIST_PRICE, RIVAL_UNIT_COST, RIVAL_MARGIN, RIVAL_QUALITY, RIVAL_ASK]) {
      expect(found.has(secret), `${secret} reached a viewer who is not party to it`).toBe(false);
    }

    // The hub is the node and nothing else.
    expect(view.hub).not.toBeNull();
    expect(view.hub?.unitCostUsd).toBeNull();
    expect(view.hub?.listPriceUsd).toBeNull();
    expect(view.hub?.askUsd).toBeNull();
    expect(view.hub?.grossMarginPct).toBeNull();
    expect(view.hub?.unitsSoldLastQuarter).toBeNull();
    expect(view.hub?.blockedInputNodeIds).toEqual([]);

    // Their live named wires, without a price, a quality or an alternative.
    expect(view.suppliers.length).toBeGreaterThan(0);
    for (const supplier of view.suppliers) {
      expect(supplier.options.length).toBe(1);
      expect(supplier.moreCount).toBe(0);
      const option = supplier.options[0];
      expect(option?.live).toBe(true);
      expect(option?.kind === 'buy' || option?.kind === 'make').toBe(true);
      expect(option?.unitPriceUsd).toBeNull();
      expect(option?.qualityScore).toBeNull();
      expect(option?.premiumPct).toBeNull();
      expect(option?.unitsDrawnLastQuarter).toBeNull();
    }

    // Their target market as a public relationship: which cell, and what that
    // cell wants. No share, no price.
    expect(view.cells.length).toBeLessThanOrEqual(1);
    for (const cell of view.cells) {
      expect(cell.live).toBe(true);
      expect(cell.myUnits).toBeNull();
      expect(cell.sharePct).toBeNull();
      expect(cell.listPriceUsd).toBeNull();
    }

    // And their customers are names, not numbers.
    for (const customer of view.customers) {
      expect(customer.unitPriceUsd).toBeNull();
      expect(customer.unitsDrawnLastQuarter).toBeNull();
      expect(customer.bookedByBuyerUsd).toBeNull();
    }
  });

  it('shows my own ask and my own order book on the one wire I am standing on', () => {
    const state = createWorld3Session();
    const { player, api, buyer } = withPlayerApiLine(state);
    const buyerLine = productOn(buyer, 'app_consumer_subscription');

    const view = connectionsOf(state, PLAYER, buyer.id, buyerLine.id);
    const model = view.suppliers.find((supplier) => supplier.slotId === 'model');
    expect(model?.options[0]?.supplierCompanyId).toBe(PLAYER);
    const ask = api.supplyTerms?.pricePerUnitUsd ?? 0;
    expect(model?.options[0]?.unitPriceUsd).toBe(namedSupplierPriceUsd(state, player, ask, API_NODE));
    expect(model?.options[0]?.unitsDrawnLastQuarter).toBe(unitsSoldLastQuarterOf(buyerLine) * qtyOf('app_consumer_subscription', 'model'));

    // Every other wire on their picture stays a relationship.
    for (const supplier of view.suppliers) {
      if (supplier.slotId === 'model') continue;
      expect(supplier.options[0]?.unitPriceUsd).toBeNull();
      expect(supplier.options[0]?.unitsDrawnLastQuarter).toBeNull();
    }
  });
});

/* -------------------------------------------------------------------------- */

describe('company-wide relationships', () => {
  it('names the agencies holding a live award, with its value, on either seat', () => {
    const state = createWorld3Session();
    const agency = state.agencies[0];
    expect(agency).toBeDefined();
    const rival = companyOf(state, 'cmp_kestrel');
    const contract: GovernmentContract = {
      id: 'gct_test_award',
      opportunityId: 'gop_test',
      agencyId: agency?.id ?? '',
      primeCompanyId: PLAYER,
      consortiumMemberIds: [],
      subcontractors: [{ companyId: rival.id, sharePct: 0.2, role: 'corpus' }],
      awardedQuarter: 0,
      contractForm: 'fixed_price',
      totalValueUsd: 4_000_000,
      recognisedToDateUsd: 0,
      milestones: [],
      performanceToDate: 50,
      penaltiesUsd: 0,
      complianceBurdenQuarterlyUsd: 0,
      status: 'active',
      exportRestricted: false,
      publicControversyLevel: 0,
    };
    state.governmentContracts.push(contract);

    const mine = connectionsOf(state, PLAYER, PLAYER, null);
    expect(mine.agencies.map((entry) => [entry.contractId, entry.role, entry.totalValueUsd])).toEqual([['gct_test_award', 'prime', 4_000_000]]);
    expect(mine.agencies[0]?.shortName).toBe(agency?.shortName);

    // An award is public: the value survives the trip to a rival's view.
    const theirs = connectionsOf(state, PLAYER, rival.id, null);
    expect(theirs.agencies.map((entry) => [entry.contractId, entry.role, entry.totalValueUsd])).toEqual([
      ['gct_test_award', 'subcontractor', 4_000_000],
    ]);
  });
});

/* -------------------------------------------------------------------------- */

describe('determinism', () => {
  it('returns the same view twice, from either seat', () => {
    const state = createWorld3Session();
    const app = productOn(companyOf(state, PLAYER), 'app_ai_software_suite');
    expect(JSON.stringify(connectionsOf(state, PLAYER, PLAYER, app.id))).toBe(JSON.stringify(connectionsOf(state, PLAYER, PLAYER, app.id)));
    expect(JSON.stringify(connectionsOf(state, PLAYER, 'cmp_basalt', null))).toBe(JSON.stringify(connectionsOf(state, PLAYER, 'cmp_basalt', null)));
    expect(JSON.stringify(customersOf(state, PLAYER, app.id))).toBe(JSON.stringify(customersOf(state, PLAYER, app.id)));
    expect(JSON.stringify(marketsForNode(state, API_NODE))).toBe(JSON.stringify(marketsForNode(state, API_NODE)));
  });
});
