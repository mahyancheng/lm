/**
 * The world-3 launch flow's gating, copy and ticket.
 *
 * The point of this file is that the launch screen makes no economic claim of
 * its own: the cost it shows is `unitCostOf`, the routes it offers are
 * `slotOptions`, the lock it reports is `canProduce`, the cell weight it reads
 * is `marketCellWeight`. What is left to test is exactly what this module owns
 * — which node is offered and in what order, how a draft of fills and a target
 * is held, what the words say, and whether the ticket that comes out the far
 * end is one the validator accepts.
 *
 * The last of those is checked against the real validator rather than against
 * an expectation of it, because "the screen offers it and the engine refuses
 * it" is the failure this whole stage exists to prevent.
 */

import { describe, expect, it } from 'vitest';
import type { Company, Product, SessionState } from '@frontier/contracts';
import { economicNodeById, primaryCustomerOf } from '@frontier/contracts';
import { createWorld3Session, defaultIndustryFor, launchCapacityPreview, nodeEntryRoutes, slotOptions, unitCostOf } from '@frontier/simulation';
import { playerCompanyOf, validateIntentForCompany } from '../../../lib/game/engine';
import {
  bestRouteOf,
  canLeaveEmpty,
  capacitySentence,
  choiceOfRoute,
  costingBlockers,
  costRowsBySlot,
  customerChoices,
  defaultFills,
  defaultTarget,
  EMPTY_CHOICE,
  entryRoutes,
  fillSummary,
  industryChoices,
  LAUNCH_TARGET_QUALITY,
  launchIntent,
  launchOptions,
  lockReason,
  NODE_LAUNCH_STEPS,
  previewFills,
  priceSentence,
  roleCaption,
  targetIndustryOf,
  targetSentence,
  tierCaption,
  type FillMap,
  withChoice,
} from './nodeLaunch';

const usd = (value: number): string => `$${Math.round(value)}`;

/**
 * The world, seen from the seat that actually directs a company.
 *
 * `companies[0]` is not the player's: a ticket built against it is refused for
 * `not_controller_of_company` long before any world-3 rule is reached, which
 * would have made the validator assertions below pass for the wrong reason.
 */
function world(): { state: SessionState; company: Company } {
  const state = createWorld3Session();
  return { state, company: playerCompanyOf(state) };
}

/** The owner's own example: developer tooling — a model slot, a harness slot, a device to ship on. */
const TOOLING = 'app_developer_tooling';
/** The vertical app: the same three slots, but its harness slot defaults to the copilot framework. */
const VERTICAL = 'app_vertical_ai_app';

/** Give `company` a live line on `nodeId`, cloned from its first line, so a slot admitting that node gains a MAKE route. */
function runLineOn(company: Company, nodeId: string): Product {
  const template = company.products[0];
  if (template === undefined) throw new Error('the seed gave the player no line to clone');
  const line: Product = { ...template, id: `prd_test_${nodeId}`, name: `${nodeId} line`, nodeId, slots: [], supplyTerms: null };
  company.products.push(line);
  return line;
}

/* -------------------------------------------------------------------------- */

describe('the five steps', () => {
  it('runs what to sell → inputs → target → cost → price, costing before pricing', () => {
    expect(NODE_LAUNCH_STEPS).toEqual(['What to sell', 'Inputs', 'Target', 'Cost to make', 'Price']);
    expect(NODE_LAUNCH_STEPS.indexOf('Inputs')).toBeLessThan(NODE_LAUNCH_STEPS.indexOf('Cost to make'));
    expect(NODE_LAUNCH_STEPS.indexOf('Cost to make')).toBeLessThan(NODE_LAUNCH_STEPS.indexOf('Price'));
  });
});

describe('launchOptions', () => {
  it('offers open nodes before locked ones and finished goods before commodities', () => {
    const { state, company } = world();
    const options = launchOptions(state, company);
    expect(options.length).toBeGreaterThan(0);

    const firstLocked = options.findIndex((option) => option.locked);
    if (firstLocked >= 0) {
      expect(options.slice(firstLocked).every((option) => option.locked)).toBe(true);
    }
    const open = options.filter((option) => !option.locked && !option.alreadySold);
    for (let i = 1; i < open.length; i += 1) {
      expect((open[i - 1]?.tier ?? 0) >= (open[i]?.tier ?? 0)).toBe(true);
    }
  });

  it('never offers a node from a sector this company has no foothold in', () => {
    const { state, company } = world();
    const owned = new Set(company.ownedNodes ?? []);
    for (const option of launchOptions(state, company)) {
      const inOwnSector = option.node.sector === company.sector;
      expect(inOwnSector || owned.has(option.node.id)).toBe(true);
    }
  });
});

describe('lockReason and the three ways in', () => {
  it('says nothing when the company can already make it', () => {
    const { state, company } = world();
    const own = launchOptions(state, company).find((option) => !option.locked);
    expect(own).toBeDefined();
    expect(lockReason(nodeEntryRoutes(state, company, own!.node.id))).toBe('');
  });

  it('names the node the company does not own', () => {
    const { state, company } = world();
    const locked = launchOptions(state, company).find((option) => option.locked);
    if (locked === undefined) return;
    const reason = lockReason(nodeEntryRoutes(state, company, locked.node.id));
    expect(reason.length).toBeGreaterThan(0);
    expect(reason).toContain(locked.node.label);
  });

  it('offers all three routes, and says which of them the world actually has', () => {
    const { state, company } = world();
    const locked = launchOptions(state, company).find((option) => option.locked);
    if (locked === undefined) return;
    const offers = entryRoutes(nodeEntryRoutes(state, company, locked.node.id), usd);
    expect(offers.map((offer) => offer.kind)).toEqual(['research', 'licence', 'buy']);
    for (const offer of offers) {
      expect(offer.detail.length).toBeGreaterThan(0);
      if (!offer.available) expect(offer.detail).toMatch(/Nobody|cannot|nothing/i);
    }
  });
});

/* -------------------------------------------------------------------------- */
/*  Fills                                                                      */
/* -------------------------------------------------------------------------- */

describe('fills', () => {
  it('opens on whatever route each slot resolves to, so the first costing is the one a founder who changes nothing launches at', () => {
    const { state, company } = world();
    const slots = slotOptions(state, company, TOOLING, null);
    expect(slots.length).toBe(3);
    const fills = defaultFills(slots);
    for (const slot of slots) {
      const choice = fills[slot.slotId];
      expect(choice).toBeDefined();
      expect(choice?.nodeId).toBe(slot.fill?.nodeId ?? null);
      // Nothing is named on a slot the roll-up takes from the market.
      if (slot.fill?.route === 'market' || slot.fill?.route === 'empty') expect(choice?.supplierCompanyId).toBeNull();
    }
    // The optional delivery slot opens empty: a device nobody asked for is a cost nobody asked for.
    expect(fills.delivery).toEqual(EMPTY_CHOICE);
  });

  it('names the company itself on a slot it fills from its own line — MAKE is the roll-up\'s default', () => {
    const { state, company } = world();
    runLineOn(company, 'svc_copilot_framework');
    const harness = slotOptions(state, company, VERTICAL, null).find((slot) => slot.slotId === 'harness');
    expect(harness?.fill?.route).toBe('make');
    const fills = defaultFills(slotOptions(state, company, VERTICAL, null));
    expect(fills.harness?.nodeId).toBe('svc_copilot_framework');
    expect(fills.harness?.supplierCompanyId).toBe(company.id);
  });

  it('lets a founder decline MAKE: the open market is a tappable route, and the roll-up prices the decline', () => {
    const { state, company } = world();
    runLineOn(company, 'svc_copilot_framework');
    const slots = slotOptions(state, company, VERTICAL, null);
    const harness = slots.find((slot) => slot.slotId === 'harness');
    const framework = harness?.candidates.find((candidate) => candidate.nodeId === 'svc_copilot_framework');
    const market = framework?.routes.find((route) => route.kind === 'market');
    expect(framework?.routes.some((route) => route.kind === 'make')).toBe(true);
    expect(market).toBeDefined();

    const made = defaultFills(slots);
    const declined = withChoice(made, harness!, choiceOfRoute('svc_copilot_framework', market!));
    expect(declined.harness?.supplierCompanyId).toBeNull();

    const madeCost = unitCostOf(state, company, VERTICAL, undefined, { fills: previewFills(made) });
    const declinedCost = unitCostOf(state, company, VERTICAL, undefined, { fills: previewFills(declined) });
    expect(madeCost.lines.find((line) => line.slotId === 'harness')?.sourceKind).toBe('make');
    expect(declinedCost.lines.find((line) => line.slotId === 'harness')?.sourceKind).toBe('market');

    // And the validator takes both tickets: declining is a decision, not an error.
    const node = economicNodeById(VERTICAL)!;
    for (const fills of [made, declined]) {
      const intent = launchIntent({ node, name: 'Terminal', priceUsd: 600, marketingUsd: 0, qualityTier: 0.5, target: defaultTarget(node), fills });
      const verdict = validateIntentForCompany(state, intent!, company.id);
      expect(verdict.status, verdict.reasons.join(' | ')).not.toBe('rejected');
    }
  });

  it('offers "leave empty" only on a slot the table does not require', () => {
    const { state, company } = world();
    const slots = slotOptions(state, company, TOOLING, null);
    const model = slots.find((slot) => slot.slotId === 'model')!;
    const delivery = slots.find((slot) => slot.slotId === 'delivery')!;
    expect(canLeaveEmpty(model)).toBe(false);
    expect(canLeaveEmpty(delivery)).toBe(true);

    const fills = defaultFills(slots);
    // A required slot cannot be emptied from the form...
    expect(withChoice(fills, model, EMPTY_CHOICE)).toBe(fills);
    // ...and the validator agrees with the form if a ticket tried anyway.
    const node = economicNodeById(TOOLING)!;
    const forced: FillMap = { ...fills, model: EMPTY_CHOICE };
    const intent = launchIntent({ node, name: 'Terminal', priceUsd: 600, marketingUsd: 0, qualityTier: 0.5, target: defaultTarget(node), fills: forced });
    expect(validateIntentForCompany(state, intent!, company.id).status).toBe('rejected');

    // An optional slot can be filled and emptied again.
    const device = delivery.candidates[0]!;
    const filled = withChoice(fills, delivery, choiceOfRoute(device.nodeId, device.routes[0]!));
    expect(filled.delivery?.nodeId).toBe(device.nodeId);
    expect(withChoice(filled, delivery, EMPTY_CHOICE).delivery).toEqual(EMPTY_CHOICE);
  });

  it('summarises a slot in a few words: the node in it and where it comes from', () => {
    const { state, company } = world();
    const slots = slotOptions(state, company, TOOLING, null);
    const model = slots.find((slot) => slot.slotId === 'model')!;
    const fills = defaultFills(slots);
    expect(fillSummary(model, fills.model, company.id)).toBe('Inference API · open market');
    const seller = model.candidates[0]!.routes.find((route) => route.kind === 'buy')!;
    expect(fillSummary(model, choiceOfRoute(model.candidates[0]!.nodeId, seller), company.id)).toBe(`Inference API · ${seller.label}`);
    const delivery = slots.find((slot) => slot.slotId === 'delivery')!;
    expect(fillSummary(delivery, fills.delivery, company.id)).toBe('Left empty');
  });

  it('captions a slot row with the kind of node it takes only when the label does not already say so', () => {
    const { state, company } = world();
    const slots = slotOptions(state, company, TOOLING, null);
    // An app's "Model" slot takes an inference API, which the label alone would not tell a founder.
    expect(roleCaption(slots.find((slot) => slot.slotId === 'model')!)).toBe('API');
    expect(roleCaption(slots.find((slot) => slot.slotId === 'harness')!)).toBe('');
    expect(roleCaption({ label: 'Actuators', role: 'actuator' })).toBe('');
    expect(roleCaption({ label: 'Arms', role: 'robot' })).toBe('Robot');
    expect(roleCaption({ label: 'Battery', role: 'battery_pack' })).toBe('Pack');
  });

  it('picks the cheapest route as a candidate\'s best, ties to the better quality', () => {
    const { state, company } = world();
    const model = slotOptions(state, company, TOOLING, null).find((slot) => slot.slotId === 'model')!;
    const candidate = model.candidates[0]!;
    const best = bestRouteOf(candidate)!;
    for (const route of candidate.routes) {
      expect(best.unitPriceUsd).toBeLessThanOrEqual(route.unitPriceUsd);
      if (route.unitPriceUsd === best.unitPriceUsd) expect(best.qualityScore).toBeGreaterThanOrEqual(route.qualityScore);
    }
  });
});

/* -------------------------------------------------------------------------- */
/*  Target                                                                     */
/* -------------------------------------------------------------------------- */

describe('target', () => {
  it('opens on the heaviest customer type and the heaviest industry in the node\'s own market', () => {
    const node = economicNodeById(TOOLING)!;
    const target = defaultTarget(node);
    expect(target.customer).toBe(primaryCustomerOf(node));
    expect(target.industry).toBe(defaultIndustryFor(node));
    expect(customerChoices(node).map((entry) => entry.customer)).toEqual(['consumer', 'enterprise', 'developer_api', 'government']);
    expect(industryChoices(node, 'enterprise').length).toBe(6);
  });

  it('states the cell weight in words, whole percent', () => {
    const suite = economicNodeById('app_ai_software_suite')!;
    // Enterprise apps are uniform over six industries: one sixth, rounded.
    expect(targetSentence(suite, { customer: 'enterprise', industry: 'logistics' })).toBe('Logistics enterprises are 17% of who buys this.');
    expect(targetSentence(suite, { customer: 'consumer', industry: 'consumer' })).toContain('sells nothing');
    const marketplace = economicNodeById('app_marketplace')!;
    expect(targetSentence(marketplace, { customer: 'consumer', industry: 'consumer' })).toBe('The public is 100% of who buys this.');
  });

  it('sends no industry for the public, who have none', () => {
    expect(targetIndustryOf({ customer: 'consumer', industry: 'logistics' })).toBeNull();
    expect(targetIndustryOf({ customer: 'enterprise', industry: 'logistics' })).toBe('logistics');
  });
});

/* -------------------------------------------------------------------------- */
/*  Cost by slot                                                               */
/* -------------------------------------------------------------------------- */

describe('costRowsBySlot', () => {
  it('lays the roll-up out one row per slot in slot order, then the conversion lines, adding up to the unit cost', () => {
    const { state, company } = world();
    const node = economicNodeById(TOOLING)!;
    const fills = defaultFills(slotOptions(state, company, TOOLING, null));
    const cost = unitCostOf(state, company, TOOLING, undefined, { fills: previewFills(fills) });
    const names = new Map(state.companies.map((entry) => [entry.id, entry.name]));
    const rows = costRowsBySlot(node, cost, names, company.id);
    expect(rows.inputs.map((row) => row.label)).toEqual(node.slots.map((slot) => slot.label));
    expect(rows.inputs[0]?.detail).toBe('Inference API · open market');
    expect(rows.inputs[2]?.detail).toBe('left empty');
    const total = [...rows.inputs, ...rows.making].reduce((sum, row) => sum + row.amountUsd, 0);
    expect(total).toBeCloseTo(cost.unitCostUsd, 6);
  });

  it('names the seller on a bought slot', () => {
    const { state, company } = world();
    const node = economicNodeById(TOOLING)!;
    const slots = slotOptions(state, company, TOOLING, null);
    const model = slots.find((slot) => slot.slotId === 'model')!;
    const seller = model.candidates[0]!.routes.find((route) => route.kind === 'buy')!;
    const fills = withChoice(defaultFills(slots), model, choiceOfRoute(model.candidates[0]!.nodeId, seller));
    const cost = unitCostOf(state, company, TOOLING, undefined, { fills: previewFills(fills) });
    const names = new Map(state.companies.map((entry) => [entry.id, entry.name]));
    expect(costRowsBySlot(node, cost, names, company.id).inputs[0]?.detail).toBe(`Inference API · ${seller.label}`);
  });
});

describe('tierCaption', () => {
  it('states the engine\'s own factor: half plus the tier', () => {
    expect(tierCaption(0.5)).toContain('1×');
    expect(tierCaption(1)).toContain('1.5×');
    expect(tierCaption(0)).toContain('0.5×');
  });
});

describe('capacitySentence', () => {
  const formatUnits = (value: number): string => String(Math.round(value));

  it('says how much of the bucket a second line opens with, from the engine\'s own preview', () => {
    const { state, company } = world();
    // The enterprise-AI founder's suite already fills the compute; a vertical
    // app beside it opens on the foothold and says so.
    const node = economicNodeById('app_vertical_ai_app');
    if (node === undefined) throw new Error('no vertical app node');
    const preview = launchCapacityPreview(state, company, node.id, 0.5);
    expect(preview).not.toBeNull();
    expect(preview?.sharers).toBe(1);
    const sentence = capacitySentence(preview, node, formatUnits);
    expect(sentence).toContain(`${Math.round((preview?.share ?? 0) * 100)}% of your compute`);
    expect(sentence).toContain(`${formatUnits(preview?.unitsPerQuarter ?? 0)} ${node.unitLabel} a quarter`);
    expect(sentence).toContain('the line already on it keeps the rest');
    expect(sentence).toContain('grows into more as it sells');
  });

  it('warns when the share is under one unit, and is empty for a node no bucket constrains', () => {
    const node = economicNodeById('sys_frontier_model');
    if (node === undefined) throw new Error('no frontier model node');
    const starved = capacitySentence({ capacityKind: 'compute', sharers: 1, share: 0.125, unitsPerQuarter: 0 }, node, formatUnits);
    expect(starved).toContain('nothing ships until you add capacity');
    const alone = capacitySentence({ capacityKind: 'plant', sharers: 0, share: 1, unitsPerQuarter: 40 }, node, formatUnits);
    expect(alone).toContain('Made on your plant');
    expect(alone).toContain('40 licence a quarter');
    expect(capacitySentence(null, node, formatUnits)).toBe('');
  });
});

describe('priceSentence', () => {
  it('states the position against the market and the margin, in whole percent', () => {
    expect(priceSentence(120, 100, 60, usd)).toBe('20% above the market at $100, a 50% gross margin.');
    expect(priceSentence(80, 100, 60, usd)).toBe('20% below the market at $100, a 25% gross margin.');
  });

  it('says "under cost" in words rather than showing a negative margin', () => {
    expect(priceSentence(50, 100, 75, usd)).toContain('50% under cost');
  });

  it('handles a free line and a node with no market price', () => {
    expect(priceSentence(0, 100, 10, usd)).toContain('Free');
    expect(priceSentence(100, 0, 50, usd)).toBe('a 50% gross margin.');
  });
});

describe('costingBlockers', () => {
  it('names a blocked input by its label, and is empty when nothing blocks', () => {
    const { state, company } = world();
    const nodeId = company.products.find((product) => product.nodeId !== undefined)?.nodeId ?? '';
    if (nodeId === '') return;
    expect(costingBlockers(unitCostOf(state, company, nodeId))).toEqual([]);

    const node = economicNodeById(nodeId);
    const required = node?.slots.find((slot) => slot.blocking && slot.defaultNodeId !== null);
    if (required === undefined || required.defaultNodeId === null) return;
    const blockedId = required.defaultNodeId;
    for (const candidate of state.companies) {
      candidate.ownedNodes = (candidate.ownedNodes ?? []).filter((id) => id !== blockedId);
      candidate.licences = (candidate.licences ?? []).filter((licence) => licence.nodeId !== blockedId);
      candidate.products = candidate.products.filter((product) => product.nodeId !== blockedId);
    }
    expect(costingBlockers(unitCostOf(state, company, nodeId))).toContain(economicNodeById(blockedId)?.label);
  });
});

/* -------------------------------------------------------------------------- */
/*  The ticket, against the real validator                                     */
/* -------------------------------------------------------------------------- */

describe('launchIntent', () => {
  const node = economicNodeById(TOOLING)!;
  const draft = (fills: FillMap, extra: Partial<Parameters<typeof launchIntent>[0]> = {}) => ({
    node,
    name: 'Terminal',
    priceUsd: 600,
    marketingUsd: 0,
    qualityTier: 0.5,
    target: defaultTarget(node),
    fills,
    ...extra,
  });

  it('refuses to build a ticket out of an incomplete form', () => {
    expect(launchIntent(draft({}, { name: '   ' }))).toBeNull();
    expect(launchIntent(draft({}, { priceUsd: -1 }))).toBeNull();
  });

  it('carries the chosen segment, industry, fills and tier, and nothing world 2 would read', () => {
    const { state, company } = world();
    const slots = slotOptions(state, company, TOOLING, null);
    const model = slots.find((slot) => slot.slotId === 'model')!;
    const harness = slots.find((slot) => slot.slotId === 'harness')!;
    const seller = model.candidates[0]!.routes.find((route) => route.kind === 'buy')!;
    const framework = harness.candidates.find((candidate) => candidate.nodeId === 'svc_copilot_framework')!;
    let fills = withChoice(defaultFills(slots), model, choiceOfRoute(model.candidates[0]!.nodeId, seller));
    fills = withChoice(fills, harness, choiceOfRoute(framework.nodeId, framework.routes.find((route) => route.kind === 'market')!));

    const intent = launchIntent(draft(fills, { qualityTier: 0.8, target: { customer: 'enterprise', industry: 'logistics' } }));
    expect(intent).not.toBeNull();
    if (intent === null || intent.type !== 'launch_product') throw new Error('not a launch');
    expect(intent.categoryId).toBe(TOOLING);
    expect(intent.segment).toBe('enterprise');
    expect(intent.targetIndustry).toBe('logistics');
    expect(intent.computeIntensity).toBe(0.8);
    expect(intent.targetQuality).toBe(LAUNCH_TARGET_QUALITY);
    expect(intent.supply).toEqual([]);
    expect(intent.slots.map((slot) => slot.slotId)).toEqual(['model', 'harness', 'delivery']);
    expect(intent.slots[0]).toEqual({ slotId: 'model', nodeId: 'svc_inference_api', supplierCompanyId: seller.supplierCompanyId, supplierProductId: seller.supplierProductId });
    expect(intent.slots[1]).toEqual({ slotId: 'harness', nodeId: 'svc_copilot_framework', supplierCompanyId: null, supplierProductId: null });
    expect(intent.slots[2]).toEqual({ slotId: 'delivery', nodeId: null, supplierCompanyId: null, supplierProductId: null });

    // And the validator accepts exactly that composition, aimed exactly there.
    const verdict = validateIntentForCompany(state, intent, company.id);
    expect(verdict.status, verdict.reasons.join(' | ')).not.toBe('rejected');
  });

  it('collapses a consumer target to no industry', () => {
    const intent = launchIntent(draft({}, { target: { customer: 'consumer', industry: 'logistics' } }));
    if (intent === null || intent.type !== 'launch_product') throw new Error('not a launch');
    expect(intent.segment).toBe('consumer');
    expect(intent.targetIndustry).toBeNull();
  });

  it('produces a ticket the validator refuses for a node the company does not own', () => {
    const { state, company } = world();
    const locked = launchOptions(state, company).find((option) => option.locked);
    if (locked === undefined) return;
    const intent = launchIntent({ node: locked.node, name: 'Something locked', priceUsd: 1_000, marketingUsd: 0, qualityTier: 0.5, target: defaultTarget(locked.node), fills: {} });
    const verdict = validateIntentForCompany(state, intent!, company.id);
    expect(verdict.status).toBe('rejected');
    expect(verdict.reasons.some((reason) => reason.includes(locked.node.label))).toBe(true);
  });
});
