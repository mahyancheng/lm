/**
 * The Chief of Staff, asked the node economy's two questions.
 *
 * "What does this cost me to build?" and "What do I need to research to enter
 * robotics?" are the questions world 2's vocabulary could not put: it had a
 * catalogue of product lines and a reference price, and no way to say what a
 * thing costs to make or what standing between a company and an industry.
 *
 * Both answers are read off canonical state by the engine — `unitCostOf`,
 * `costBreakdown`, `nodeEntryRoutes` — so what is tested here is that the rows
 * carry the engine's own numbers, that an intent on a row is one the validator
 * accepts, and that both degrade to an honest empty answer in a world that has
 * no node economy rather than throwing or inventing.
 */

import { describe, expect, it } from 'vitest';
import type { Company, Product, SessionState } from '@frontier/contracts';
import { ECONOMIC_NODES, defaultInputsOf, economicNodeById, nodeMarketPriceUsd } from '@frontier/contracts';
import { createWorld3Session } from '../src/scenario/world3';
import { createDemoSession } from '../src/scenario';
import { runLookups } from '../src/lookups';
import { unitCostOf } from '../src/graph/cost';
import { costBreakdown } from '../src/graph/options';
import { describeLine, possessiveOf, proseLabel, targetPhrase, withArticle } from '../src/graph/describe';
import { defaultIndustryFor } from '../src/graph/slots';
import { availableActionsFor } from '../src/validator/availability';
import { validateAction } from '../src/validator';
import { BatchBudget } from '../src/validator/context';

const ACCELERATOR = 'sys_ai_accelerator';
const SUITE = 'app_ai_software_suite';
const API = 'svc_inference_api';
const FRONTIER = 'sys_frontier_model';
const SMALL = 'sys_efficient_small_model';
const FRAMEWORK = 'svc_copilot_framework';
const DIE = 'cmp_logic_die';
const WAFER = 'mat_wafer_300mm';
const BASALT = 'cmp_basalt';
const SABLE = 'cmp_sable';
const ALETHEIA = 'cmp_aletheia';

/* -------------------------------------------------------------------------- */
/*  A composed world of the test's own making                                  */
/* -------------------------------------------------------------------------- */

function lineOn(nodeId: string, id: string, priceUsd: number, quality = 0.6): Product {
  return {
    id,
    name: `${nodeId} line`,
    segment: 'enterprise',
    nodeId,
    pricePerSeat: priceUsd,
    activeCustomers: 1_000,
    unitsSoldQuarterly: 1_000,
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

function companyOf(state: SessionState, id: string): Company {
  const company = state.companies.find((entry) => entry.id === id);
  if (company === undefined) throw new Error(`no company ${id}`);
  return company;
}

/** Give `company` a published, open line on `nodeId`. */
function publishLine(company: Company, nodeId: string, askUsd: number, quality: number): Product {
  const product = lineOn(nodeId, `prd_${nodeId}_${company.id}`, askUsd, quality);
  product.supplyTerms = { openToAll: true, pricePerUnitUsd: askUsd, exclusiveCustomerIds: [], blockedCustomerIds: [] };
  company.products.push(product);
  if (!(company.ownedNodes ?? []).includes(nodeId)) company.ownedNodes = [...(company.ownedNodes ?? []), nodeId];
  return product;
}

/**
 * The seeded world with every line removed, then exactly the lines these
 * tests read: Aletheia publishes a frontier model, Sable a small model and an
 * API on it, Basalt an API on Aletheia's model, and the player runs an AI
 * software suite on Basalt's API with a copilot framework from the open
 * market, aimed at logistics enterprises. Ownership and prices are as built.
 */
function composedWorld(): { state: SessionState; player: Company; suite: Product } {
  const state = createWorld3Session();
  for (const company of state.companies) {
    company.products = [];
    company.capacity = { plantUsd: 0, fleetUsd: 0, gridUsd: 0 };
  }
  state.governmentContracts = [];
  state.researchProjects = [];

  const frontier = publishLine(companyOf(state, ALETHEIA), FRONTIER, 900_000, 0.9);
  const small = publishLine(companyOf(state, SABLE), SMALL, 300_000, 0.6);
  const sableApi = publishLine(companyOf(state, SABLE), API, 13, 0.8);
  sableApi.slots = [{ slotId: 'model', nodeId: SMALL, supplierCompanyId: SABLE, supplierProductId: small.id, cutOffNoticeQuarter: null, changedQuarter: null }];
  const basaltApi = publishLine(companyOf(state, BASALT), API, 9, 0.85);
  basaltApi.slots = [{ slotId: 'model', nodeId: FRONTIER, supplierCompanyId: ALETHEIA, supplierProductId: frontier.id, cutOffNoticeQuarter: null, changedQuarter: null }];

  const player = playerCompany(state);
  const suite = lineOn(SUITE, 'prd_player_suite', 2_400, 0.7);
  suite.name = 'Player Suite';
  suite.targetIndustry = 'logistics';
  suite.slots = [
    { slotId: 'model', nodeId: API, supplierCompanyId: BASALT, supplierProductId: basaltApi.id, cutOffNoticeQuarter: null, changedQuarter: null },
    { slotId: 'harness', nodeId: FRAMEWORK, supplierCompanyId: null, supplierProductId: null, cutOffNoticeQuarter: null, changedQuarter: null },
  ];
  player.products.push(suite);
  if (!(player.ownedNodes ?? []).includes(SUITE)) player.ownedNodes = [...(player.ownedNodes ?? []), SUITE];
  return { state, player, suite };
}

function actorOf(company: Company) {
  return { playerId: company.controllerPlayerId ?? 'player_1', companyId: company.id, characterId: company.ceoCharacterId ?? '', confirmedByHuman: true };
}

/** The seat the probes are asked from: the company's own controller and chief executive. */
function actorFor(company: Company): { playerId: string; companyId: string; characterId: string } {
  return {
    playerId: company.controllerPlayerId ?? 'player_1',
    companyId: company.id,
    characterId: company.ceoCharacterId ?? '',
  };
}

/** The company the player actually directs, so a validator verdict is about the rule under test. */
function playerCompany(state: SessionState): Company {
  const controlled = state.companies.find((company) => company.controllerPlayerId !== null && company.isActive);
  return (controlled ?? state.companies[0]) as Company;
}

/* -------------------------------------------------------------------------- */
/*  unit_cost                                                                  */
/* -------------------------------------------------------------------------- */

describe('the unit_cost lookup', () => {
  it('is the roll-up, itemised, descending, with the same total', () => {
    const state = createWorld3Session();
    const company = playerCompany(state);
    const [result] = runLookups(state, company.id, [{ kind: 'unit_cost', nodeId: ACCELERATOR }]);
    expect(result?.kind).toBe('unit_cost');
    if (result?.kind !== 'unit_cost') throw new Error('wrong kind');

    const truth = unitCostOf(state, company, ACCELERATOR);
    expect(result.unitCostUsd).toBe(Math.round(truth.unitCostUsd));
    expect(result.marketPriceUsd).toBe(Math.round(nodeMarketPriceUsd(state, ACCELERATOR)));
    expect(result.unitLabel).toBe(economicNodeById(ACCELERATOR)?.unitLabel);

    // Same rows, same order, same numbers as `costBreakdown`.
    const rows = costBreakdown(truth).slice(0, result.rows.length);
    expect(result.rows.map((row) => row.key)).toEqual(rows.map((row) => row.key));
    for (let i = 0; i < result.rows.length; i += 1) {
      expect(result.rows[i]?.amountUsd).toBe(Math.max(0, Math.round(rows[i]?.amountUsd ?? 0)));
    }
    // Whole numbers only, everywhere.
    expect(Number.isInteger(result.unitCostUsd)).toBe(true);
    expect(result.rows.every((row) => Number.isInteger(row.amountUsd) && Number.isInteger(row.sharePct))).toBe(true);
  });

  it('names the counterparty on a row that is bought from one', () => {
    const state = createWorld3Session();
    const company = playerCompany(state);
    const [result] = runLookups(state, company.id, [{ kind: 'unit_cost', nodeId: ACCELERATOR }]);
    if (result?.kind !== 'unit_cost') throw new Error('wrong kind');
    for (const row of result.rows) {
      if (row.sourceKind === 'buy') expect(row.sourceName.length).toBeGreaterThan(0);
      if (row.sourceKind === 'market' || row.sourceKind === 'conversion') expect(row.sourceName).toBe('');
    }
  });

  it('keys every input row by the slot it fills and names the biggest slot with its source', () => {
    const { state, player } = composedWorld();
    const [result] = runLookups(state, player.id, [{ kind: 'unit_cost', nodeId: SUITE }]);
    if (result?.kind !== 'unit_cost') throw new Error('wrong kind');

    const model = result.rows.find((row) => row.slotId === 'model');
    expect(model?.key).toBe('slot:model');
    expect(model?.nodeId).toBe(API);
    expect(model?.sourceKind).toBe('buy');
    expect(model?.sourceName).toBe(companyOf(state, BASALT).name);
    const harness = result.rows.find((row) => row.slotId === 'harness');
    expect(harness?.nodeId).toBe(FRAMEWORK);
    expect(harness?.sourceKind).toBe('market');
    // Conversion rows carry no slot and no node — the empty string, never an id.
    for (const row of result.rows.filter((entry) => entry.sourceKind === 'conversion')) {
      expect(row.slotId).toBe('');
      expect(row.nodeId).toBe('');
    }
    // The summary is grouped by slot: the biggest input is named as the slot
    // it fills and the source that fills it, in the seller's own name.
    expect(result.summary).toContain('is the model slot, on');
    expect(result.summary).toContain(`${possessiveOf(companyOf(state, BASALT).name)} inference API`);
    expect(result.summary).not.toContain('cmp_');
  });

  it('answers an unknown node and a world with no node economy without throwing', () => {
    const state = createWorld3Session();
    const company = playerCompany(state);
    const [missing] = runLookups(state, company.id, [{ kind: 'unit_cost', nodeId: 'nope_not_a_node' }]);
    if (missing?.kind !== 'unit_cost') throw new Error('wrong kind');
    expect(missing.rows).toEqual([]);
    expect(missing.summary).toContain('no node');

    const world2 = createDemoSession();
    const [outside] = runLookups(world2, playerCompany(world2).id, [{ kind: 'unit_cost', nodeId: ACCELERATOR }]);
    if (outside?.kind !== 'unit_cost') throw new Error('wrong kind');
    expect(outside.unitCostUsd).toBe(0);
    expect(outside.rows).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/*  describeLine                                                               */
/* -------------------------------------------------------------------------- */

describe('describeLine', () => {
  it('reads a composed line back from the founder\'s seat, top two slots by value, then the target', () => {
    const { state, player, suite } = composedWorld();
    const basalt = companyOf(state, BASALT);
    expect(describeLine(state, player, suite, player.id)).toBe(
      `your AI software suite on ${possessiveOf(basalt.name)} inference API with a copilot framework from the open market, aimed at logistics enterprises`,
    );
  });

  it('is possessive from the viewer: a rival\'s line is theirs, and their own inputs are "its own"', () => {
    const { state, player } = composedWorld();
    const sable = companyOf(state, SABLE);
    const api = sable.products.find((product) => product.nodeId === API);
    if (api === undefined) throw new Error('no api line');
    const fromPlayer = describeLine(state, sable, api, player.id);
    expect(fromPlayer).toBe(`${possessiveOf(sable.name)} inference API on its own small model, aimed at AI enterprises`);
    // The same line read by its own founder.
    expect(describeLine(state, sable, api, sable.id)).toBe('your inference API on your own small model, aimed at AI enterprises');
  });

  it('names no ids and describes a slotless node as the node and its target alone', () => {
    const { state } = composedWorld();
    const aletheia = companyOf(state, ALETHEIA);
    for (const company of state.companies) {
      for (const product of company.products) {
        const text = describeLine(state, company, product, aletheia.id);
        expect(text).not.toMatch(/\b(prd|cmp|svc|app|sys|mat|cmp|res|dat)_/);
        expect(text).toContain(', aimed at ');
      }
    }
    const kestrel = companyOf(state, 'cmp_kestrel');
    const corpus = publishLine(kestrel, 'dat_web_corpus', 100, 0.7);
    expect(describeLine(state, kestrel, corpus, aletheia.id)).toBe(`${possessiveOf(kestrel.name)} curated corpus, aimed at AI enterprises`);
  });

  it('collapses a consumer line to "consumers" and follows the target the market sells into', () => {
    const { state, player, suite } = composedWorld();
    suite.segment = 'consumer';
    suite.targetIndustry = 'logistics';
    expect(describeLine(state, player, suite, player.id)).toMatch(/, aimed at consumers$/);
    suite.segment = 'developer_api';
    expect(describeLine(state, player, suite, player.id)).toMatch(/, aimed at logistics developers$/);
    suite.segment = 'government';
    expect(describeLine(state, player, suite, player.id)).toMatch(/, aimed at government buyers in logistics$/);
    // A line never aimed lands where the market puts it by default.
    suite.segment = 'enterprise';
    delete suite.targetIndustry;
    expect(describeLine(state, player, suite, player.id)).toMatch(new RegExp(`aimed at ${targetPhrase(defaultIndustryFor(economicNodeById(SUITE)!), 'enterprise')}$`));
  });

  it('returns nothing for a product that is not a node line, and is deterministic', () => {
    const { state, player, suite } = composedWorld();
    const world2 = createDemoSession();
    const w2company = playerCompany(world2);
    const w2product = w2company.products[0];
    if (w2product === undefined) throw new Error('world 2 has no product');
    expect(describeLine(world2, w2company, w2product, w2company.id)).toBe('');
    expect(describeLine(state, player, suite, player.id)).toBe(describeLine(state, player, suite, player.id));
  });

  it('spells the words a founder would: acronyms keep their case, plurals and mass nouns take no article', () => {
    expect(proseLabel('Inference API')).toBe('inference API');
    expect(proseLabel('AI software suite')).toBe('AI software suite');
    expect(withArticle('inference API')).toBe('an inference API');
    expect(withArticle('frontier model')).toBe('a frontier model');
    expect(withArticle('permanent magnets')).toBe('permanent magnets');
    expect(withArticle('robot telemetry')).toBe('robot telemetry');
    expect(possessiveOf('Basalt Compute')).toBe("Basalt Compute's");
    expect(possessiveOf('Player Ventures')).toBe("Player Ventures'");
  });
});

/* -------------------------------------------------------------------------- */
/*  slot_candidates                                                            */
/* -------------------------------------------------------------------------- */

describe('the slot_candidates lookup', () => {
  it('lists every source for every admissible node, priced as the roll-up would, each carrying a legal fill_slot', () => {
    const { state, player, suite } = composedWorld();
    const [result] = runLookups(state, player.id, [{ kind: 'slot_candidates', productId: suite.id, nodeId: SUITE, slotId: 'model' }]);
    if (result?.kind !== 'slot_candidates') throw new Error('wrong kind');

    expect(result.slotId).toBe('model');
    expect(result.slotLabel).toBe('Model');
    expect(result.productId).toBe(suite.id);
    // Two published APIs and the open market: three ways, in the roll-up's order.
    expect(result.rows.map((row) => `${row.nodeId}:${row.sourceKind}:${row.sellerCompanyId}`)).toEqual([
      `${API}:buy:${BASALT}`,
      `${API}:buy:${SABLE}`,
      `${API}:market:`,
    ]);
    const basalt = result.rows[0]!;
    expect(basalt.sellerName).toBe(companyOf(state, BASALT).name);
    expect(basalt.qualityScorePct).toBe(85);
    expect(result.rows[2]?.qualityScorePct).toBe(50);
    expect(result.rows.every((row) => Number.isInteger(row.unitPriceUsd) && row.unitPriceUsd >= 0)).toBe(true);

    for (const row of result.rows) {
      expect(row.intent?.type).toBe('fill_slot');
      if (row.intent?.type !== 'fill_slot') continue;
      expect(row.intent).toEqual({
        type: 'fill_slot',
        productId: suite.id,
        slotId: 'model',
        nodeId: row.nodeId,
        supplierCompanyId: row.sourceKind === 'market' ? null : row.sellerCompanyId,
        supplierProductId: row.sourceKind === 'market' ? null : expect.any(String),
      });
      const verdict = validateAction(state, row.intent, actorOf(player), new BatchBudget(), `fill_${row.sellerCompanyId}`);
      expect(verdict.status, verdict.reasons.join(' | ')).not.toBe('rejected');
    }
    expect(result.summary).toContain('3 ways to fill the model slot');
    expect(result.summary).toContain(`today it runs on ${possessiveOf(companyOf(state, BASALT).name)} inference API`);
  });

  it('spans every node of the role, and carries no action when no line was named', () => {
    const { state, player } = composedWorld();
    const [result] = runLookups(state, player.id, [{ kind: 'slot_candidates', productId: null, nodeId: API, slotId: 'model' }]);
    if (result?.kind !== 'slot_candidates') throw new Error('wrong kind');
    const nodes = new Set(result.rows.map((row) => row.nodeId));
    expect(nodes.has(FRONTIER)).toBe(true);
    expect(nodes.has(SMALL)).toBe(true);
    expect(result.rows.find((row) => row.nodeId === FRONTIER && row.sourceKind === 'buy')?.sellerCompanyId).toBe(ALETHEIA);
    expect(result.rows.find((row) => row.nodeId === SMALL && row.sourceKind === 'buy')?.sellerCompanyId).toBe(SABLE);
    expect(result.rows.every((row) => row.intent === null)).toBe(true);
    expect(result.productId).toBe('');
    // Browsing a node we do not sell: the default runs from the open market.
    expect(result.summary).toContain('today it runs on a frontier model from the open market');
  });

  it('marks a node nobody can make as blocked and offers no fill that would stop the line', () => {
    const { state, player } = composedWorld();
    for (const company of state.companies) {
      company.ownedNodes = (company.ownedNodes ?? []).filter((nodeId) => nodeId !== WAFER);
      company.licences = (company.licences ?? []).filter((licence) => licence.nodeId !== WAFER);
    }
    const die = lineOn(DIE, 'prd_player_die', 60);
    player.products.push(die);
    const [result] = runLookups(state, player.id, [{ kind: 'slot_candidates', productId: die.id, nodeId: DIE, slotId: 'wafer' }]);
    if (result?.kind !== 'slot_candidates') throw new Error('wrong kind');
    const wafer = result.rows.find((row) => row.nodeId === WAFER && row.sourceKind === 'market');
    expect(wafer?.blocked).toBe(true);
    expect(wafer?.intent).toBeNull();
  });

  it('answers an unknown slot, an unknown node and a world without slots honestly', () => {
    const { state, player } = composedWorld();
    const [slot] = runLookups(state, player.id, [{ kind: 'slot_candidates', productId: null, nodeId: API, slotId: 'nope' }]);
    if (slot?.kind !== 'slot_candidates') throw new Error('wrong kind');
    expect(slot.rows).toEqual([]);
    expect(slot.slotId).toBe('');
    expect(slot.summary).toContain('its slots are model');

    const [node] = runLookups(state, player.id, [{ kind: 'slot_candidates', productId: null, nodeId: 'nope_node', slotId: 'model' }]);
    if (node?.kind !== 'slot_candidates') throw new Error('wrong kind');
    expect(node.rows).toEqual([]);
    expect(node.summary).toContain('no node called');

    const world2 = createDemoSession();
    const [outside] = runLookups(world2, playerCompany(world2).id, [{ kind: 'slot_candidates', productId: null, nodeId: API, slotId: 'model' }]);
    if (outside?.kind !== 'slot_candidates') throw new Error('wrong kind');
    expect(outside.rows).toEqual([]);
    expect(outside.summary).toContain('no slots');
  });
});

/* -------------------------------------------------------------------------- */
/*  suppliers, asked in world 3                                                */
/* -------------------------------------------------------------------------- */

describe('the suppliers lookup in world 3', () => {
  it('answers with the named sellers of the slot the input fills, each carrying the fill_slot that buys it', () => {
    const { state, player, suite } = composedWorld();
    const [result] = runLookups(state, player.id, [{ kind: 'suppliers', inputCategoryId: API, productId: suite.id }]);
    if (result?.kind !== 'suppliers') throw new Error('wrong kind');
    expect(result.rows.map((row) => row.companyId)).toEqual([BASALT, SABLE]);
    for (const row of result.rows) {
      expect(row.intent).toEqual({
        type: 'fill_slot',
        productId: suite.id,
        slotId: 'model',
        nodeId: API,
        supplierCompanyId: row.companyId,
        supplierProductId: row.productId,
      });
      const verdict = validateAction(state, row.intent!, actorOf(player), new BatchBudget(), `buy_${row.companyId}`);
      expect(verdict.status, verdict.reasons.join(' | ')).not.toBe('rejected');
    }
    expect(result.summary).toContain('model slot of AI software suite');
  });

  it('spans the whole role when the slot admits more than one node', () => {
    const { state, player } = composedWorld();
    // The player also runs an API, whose model slot admits every model.
    const api = lineOn(API, 'prd_player_api', 12);
    player.products.push(api);
    const [result] = runLookups(state, player.id, [{ kind: 'suppliers', inputCategoryId: FRONTIER, productId: api.id }]);
    if (result?.kind !== 'suppliers') throw new Error('wrong kind');
    const nodes = result.rows.map((row) => (row.intent?.type === 'fill_slot' ? row.intent.nodeId : null));
    expect(nodes).toContain(FRONTIER);
    expect(nodes).toContain(SMALL);
    // The API line publishes nothing, so a seller of a model is not a rival on it.
    expect(result.rows.every((row) => !row.isDirectRival)).toBe(true);
  });

  it('finds the slot through the company\'s own lines when no product is named', () => {
    const { state, player, suite } = composedWorld();
    const [result] = runLookups(state, player.id, [{ kind: 'suppliers', inputCategoryId: API, productId: null }]);
    if (result?.kind !== 'suppliers') throw new Error('wrong kind');
    expect(result.rows.length).toBe(2);
    expect(result.rows[0]?.intent).toMatchObject({ type: 'fill_slot', productId: suite.id, slotId: 'model' });
  });
});

/* -------------------------------------------------------------------------- */
/*  launchable_lines, aimed                                                    */
/* -------------------------------------------------------------------------- */

describe('the launchable_lines lookup in world 3', () => {
  it('aims every launch at the node\'s heaviest customer and industry with no slots chosen', () => {
    const state = createWorld3Session();
    const company = playerCompany(state);
    const [result] = runLookups(state, company.id, [{ kind: 'launchable_lines' }]);
    if (result?.kind !== 'launchable_lines') throw new Error('wrong kind');
    const offered = result.rows.filter((row) => row.intent !== null);
    expect(offered.length).toBeGreaterThan(0);
    for (const row of offered) {
      if (row.intent?.type !== 'launch_product') throw new Error('wrong intent');
      const node = economicNodeById(row.categoryId);
      expect(node).toBeDefined();
      expect(row.intent.targetIndustry).toBe(defaultIndustryFor(node!));
      expect(row.intent.slots).toEqual([]);
      const verdict = validateAction(state, row.intent, actorOf(company), new BatchBudget(), `launch_${row.categoryId}`);
      expect(verdict.status, verdict.reasons.join(' | ')).not.toBe('rejected');
    }
  });
});

/* -------------------------------------------------------------------------- */
/*  entry_path                                                                 */
/* -------------------------------------------------------------------------- */

describe('the entry_path lookup', () => {
  it('finds the shortest way into a sector this company is not in', () => {
    const state = createWorld3Session();
    const company = playerCompany(state);
    // A sector that is not this company's own, so the answer is a real path.
    const foreign = (['robotics', 'energy', 'logistics', 'consumer', 'manufacturing', 'ai'] as const).find(
      (sector) => sector !== company.sector,
    );
    const [result] = runLookups(state, company.id, [{ kind: 'entry_path', sector: foreign ?? 'robotics', nodeId: '' }]);
    if (result?.kind !== 'entry_path') throw new Error('wrong kind');

    expect(result.sector).toBe(foreign);
    // The target it picked is in the sector asked about.
    expect(economicNodeById(result.nodeId)?.sector).toBe(foreign);
    if (!result.alreadyIn) {
      expect(result.rows.length).toBeGreaterThan(0);
      // Every step is a node the company does not hold, with its tier stated.
      for (const row of result.rows) {
        expect(ECONOMIC_NODES.some((node) => node.id === row.nodeId)).toBe(true);
        expect(Number.isInteger(row.tier)).toBe(true);
        expect(row.researchLowUsd).toBeLessThanOrEqual(row.researchHighUsd);
      }
    }
  });

  it('offers a start_research intent only where the validator would accept one', () => {
    const state = createWorld3Session();
    const company = playerCompany(state);
    const foreign = (['robotics', 'energy', 'logistics', 'consumer', 'manufacturing'] as const).find(
      (sector) => sector !== company.sector,
    );
    const [result] = runLookups(state, company.id, [{ kind: 'entry_path', sector: foreign ?? 'robotics', nodeId: '' }]);
    if (result?.kind !== 'entry_path') throw new Error('wrong kind');

    for (const row of result.rows) {
      if (row.intent === null) continue;
      const verdict = validateAction(
        state,
        row.intent,
        { playerId: company.controllerPlayerId ?? 'player_1', companyId: company.id, characterId: company.ceoCharacterId, confirmedByHuman: true },
        new BatchBudget(),
        `entry_${row.nodeId}`,
      );
      // A programme the role offers is one the validator will not refuse for a
      // structural reason. Money is never a gate, so a clamp is a pass.
      expect(
        verdict.status !== 'rejected' || !verdict.codes.includes('requirement_not_met'),
        `${row.nodeId}: ${verdict.reasons.join(' | ')}`,
      ).toBe(true);
    }
  });

  it('says so plainly when the company is already in the sector', () => {
    const state = createWorld3Session();
    const company = playerCompany(state);
    const [result] = runLookups(state, company.id, [{ kind: 'entry_path', sector: company.sector ?? 'ai', nodeId: '' }]);
    if (result?.kind !== 'entry_path') throw new Error('wrong kind');
    expect(result.alreadyIn).toBe(true);
    expect(result.summary).toContain('already');
  });

  it('takes one node instead of a sector, and refuses to guess when given neither', () => {
    const state = createWorld3Session();
    const company = playerCompany(state);
    const [named] = runLookups(state, company.id, [{ kind: 'entry_path', sector: '', nodeId: ACCELERATOR }]);
    if (named?.kind !== 'entry_path') throw new Error('wrong kind');
    expect(named.nodeId).toBe(ACCELERATOR);

    const [nothing] = runLookups(state, company.id, [{ kind: 'entry_path', sector: '', nodeId: '' }]);
    if (nothing?.kind !== 'entry_path') throw new Error('wrong kind');
    expect(nothing.rows).toEqual([]);
    expect(nothing.summary).toContain('Name a sector');
  });

  it('degrades honestly in a world with no node economy', () => {
    const world2 = createDemoSession();
    const [result] = runLookups(world2, playerCompany(world2).id, [{ kind: 'entry_path', sector: 'robotics', nodeId: '' }]);
    if (result?.kind !== 'entry_path') throw new Error('wrong kind');
    expect(result.rows).toEqual([]);
    expect(result.alreadyIn).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/*  The probes                                                                 */
/* -------------------------------------------------------------------------- */

describe('the available-actions probes speak world 3', () => {
  it('offers node targets for a launch, and every one of them is legal', () => {
    const state = createWorld3Session();
    const company = playerCompany(state);
    const actions = availableActionsFor(state, actorFor(company));
    const launch = actions.find((action) => action.type === 'launch_product');
    expect(launch?.available).toBe(true);
    expect((launch?.targets ?? []).length).toBeGreaterThan(0);
    for (const target of launch?.targets ?? []) {
      expect(ECONOMIC_NODES.some((node) => node.id === target.id), `${target.id} is not a node`).toBe(true);
    }
    // The probe's own price is quoted per unit, not per seat.
    expect(launch?.bounds.some((bound) => bound.label.includes('per unit'))).toBe(true);
  });

  it('wires an input the line\'s own node takes in a slot, and refuses one it does not', () => {
    const state = createWorld3Session();
    const company = playerCompany(state);
    const line = company.products.find((product) => {
      const node = economicNodeById(product.nodeId ?? '');
      return node !== undefined && defaultInputsOf(node).length > 0;
    });
    expect(line, 'the player company runs no line with inputs').toBeDefined();
    const lineNode = economicNodeById(line?.nodeId ?? '');
    const inputNodeId = (lineNode === undefined ? [] : defaultInputsOf(lineNode))[0]?.nodeId ?? '';

    const actor = { playerId: company.controllerPlayerId, companyId: company.id, characterId: company.ceoCharacterId, confirmedByHuman: true };

    // CHANGED DELIBERATELY: world 3 composes a line by slot, so the wiring
    // action is fill_slot and the world-2 choose_supplier is refused outright.
    const slotId = (lineNode === undefined ? [] : defaultInputsOf(lineNode))[0]?.slotId ?? '';

    // The open market is always legal, on a slot the node really carries.
    const open = validateAction(
      state,
      { type: 'fill_slot', productId: line?.id ?? '', slotId, nodeId: inputNodeId, supplierCompanyId: null, supplierProductId: null },
      actor,
      new BatchBudget(),
      'wire_open',
    );
    expect(open.status, open.reasons.join(' | ')).not.toBe('rejected');

    // A slot this node does not carry is refused, and the refusal names the
    // node rather than a world-2 category.
    const wrong = validateAction(
      state,
      { type: 'fill_slot', productId: line?.id ?? '', slotId: 'diesel', nodeId: 'res_diesel_fuel', supplierCompanyId: null, supplierProductId: null },
      actor,
      new BatchBudget(),
      'wire_wrong',
    );
    expect(wrong.status).toBe('rejected');
    expect(wrong.reasons.join(' ')).toContain(lineNode?.label ?? '');

    // The world-2 action is refused in world 3, and the refusal says what to use.
    const legacy = validateAction(
      state,
      { type: 'choose_supplier', productId: line?.id ?? '', inputCategoryId: inputNodeId, supplierCompanyId: null, supplierProductId: null },
      actor,
      new BatchBudget(),
      'wire_legacy',
    );
    expect(legacy.status).toBe('rejected');
    expect(legacy.reasons.join(' ')).toContain('fill_slot');
  });
});
