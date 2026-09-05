/**
 * @frontier/simulation — the composed line in the seeded world, end to end.
 *
 * `nodeSlots.test.ts` proves the mechanics on stripped fixtures. This file
 * proves them where a founder meets them: the seeded world as the scenario
 * builds it — the enterprise-AI background, and the frontier laboratory where
 * the knowledge ladder requires it — with actions submitted as the player and
 * resolved by the whole nineteen-phase resolver, nothing hand-placed.
 *
 * 1. **Which API you build on moves your books.** The same vertical AI app
 *    launched on Sable Reasoning's inference API and on Basalt Compute's books
 *    a different unit cost and a different quality, and the Chief of Staff's
 *    sentence names the company chosen.
 * 2. **Publishing puts you on a rival's menu.** A line the player launches and
 *    then publishes is a buy route in a seeded rival's `slotOptions` the
 *    quarter after the terms land — the owner's "any company with a harness
 *    can decide if they want to put a product on the other company's LLM".
 * 3. **Aiming changes the pool.** `set_target_market` moves the line to another
 *    cell, the pool it draws from is a different number, and the ledger says so.
 * 4. **A launched line sells.** A second line on the same capacity bucket as
 *    the opening line ships units the quarter it lands and grows from there,
 *    and the launch preview quoted exactly the capacity it opened with. Before
 *    the foothold in `bucketShare` every launched second line sat at zero
 *    units for as long as anyone cared to run it.
 * 5. **The harness layer has sellers.** An app's harness slot offers each
 *    harness node from a named company, two companies for two nodes; a
 *    robot's control-stack slot offers a named seller; and a manufacturing
 *    structure slot offers two nodes made by two different producers.
 *
 * Deterministic: seed 424242 throughout, no clock, every action through the
 * validator first.
 */

import { describe, expect, it } from 'vitest';
import {
  NewGameSetupSchema,
  economicNodeById,
  nodeMarketPriceUsd,
  type ActionIntent,
  type ActionValidationResult,
  type Company,
  type EconomicNode,
  type Product,
  type SessionState,
  type SubmittedAction,
} from '@frontier/contracts';
import { createDefaultEngine } from '../src/engine';
import { createWorld3Session, W3_DEFAULT_SETUP } from '../src/scenario/world3';
import { W2_COMPANIES } from '../src/scenario/world2';
import { cellEndDemandUnits, cellOf, describeLine, launchCapacityPreview, resolveFills, slotOptions } from '../src/graph';
import { validateAction } from '../src/validator/index';
import { BatchBudget } from '../src/validator/context';

const SUITE = 'app_ai_software_suite';
const VERTICAL = 'app_vertical_ai_app';
const API = 'svc_inference_api';
const SMALL = 'sys_efficient_small_model';
const HARNESS = 'svc_agent_harness';
const ARM = 'sys_industrial_arm';

function session(backgroundId: 'enterprise_ai' | 'frontier_lab' = 'enterprise_ai'): SessionState {
  return createWorld3Session(424242, NewGameSetupSchema.parse({ ...W3_DEFAULT_SETUP, backgroundId, sector: 'ai' }));
}

function companyOf(state: SessionState, id: string): Company {
  const company = state.companies.find((candidate) => candidate.id === id);
  if (company === undefined) throw new Error(`${id} is not in the world`);
  return company;
}

const playerOf = (state: SessionState): Company => companyOf(state, W2_COMPANIES.player);

function lineOn(company: Company, nodeId: string): Product {
  const line = company.products.find((product) => product.isActive && product.nodeId === nodeId);
  if (line === undefined) throw new Error(`${company.name} runs no line on ${nodeId}`);
  return line;
}

function nodeOf(id: string): EconomicNode {
  const node = economicNodeById(id);
  if (node === undefined) throw new Error(`${id} is not in the table`);
  return node;
}

let sequence = 0;
/** The player's own instruction for their own company, as the UI submits it. */
function asPlayer(state: SessionState, intent: ActionIntent): SubmittedAction {
  const player = playerOf(state);
  sequence += 1;
  return {
    actionId: `act_composition_${sequence}`,
    sessionId: state.sessionId,
    quarter: state.quarter,
    sequence,
    actorPlayerId: player.controllerPlayerId,
    actorCompanyId: player.id,
    actorCharacterId: player.ceoCharacterId ?? 'chr_player',
    origin: 'player_ui',
    intent,
    confirmedByHuman: true,
  };
}

function verdictFor(state: SessionState, intent: ActionIntent): ActionValidationResult {
  const player = playerOf(state);
  return validateAction(
    state,
    intent,
    { playerId: player.controllerPlayerId, companyId: player.id, characterId: player.ceoCharacterId ?? 'chr_player', confirmedByHuman: true },
    new BatchBudget(),
    `composition_${intent.type}`,
  );
}

function resolve(state: SessionState, actions: readonly SubmittedAction[]) {
  return createDefaultEngine().resolver.resolveQuarter(state, actions, null, []);
}

/** A launch of `nodeId` composed on `slots`, priced at the node's market price, aimed at logistics enterprises. */
function launchOf(state: SessionState, nodeId: string, name: string, slots: Extract<ActionIntent, { type: 'launch_product' }>['slots'], segment: 'enterprise' | 'developer_api' = 'enterprise'): ActionIntent {
  return {
    type: 'launch_product',
    name,
    segment,
    categoryId: nodeId,
    pricePerSeatUsd: nodeMarketPriceUsd(state, nodeId),
    computeIntensity: 0.6,
    launchMarketingUsd: 0,
    targetQuality: 0.75,
    supply: [],
    targetIndustry: segment === 'enterprise' ? 'logistics' : 'ai',
    slots,
  };
}

/* -------------------------------------------------------------------------- */
/*  1. Sable's API against Basalt's                                            */
/* -------------------------------------------------------------------------- */

describe('the same line on two companies\' APIs, in the seeded world', () => {
  it('books a different unit cost and a different quality, and is described by the company chosen', { timeout: 120_000 }, () => {
    const booked: { seller: string; unitCostUsd: number; qualityScore: number; sentence: string }[] = [];

    for (const sellerId of [W2_COMPANIES.sable, W2_COMPANIES.basalt]) {
      let state = session();
      const seller = companyOf(state, sellerId);
      const sellerApi = lineOn(seller, API);
      const intent = launchOf(state, VERTICAL, `Vertical on ${seller.name}`, [
        { slotId: 'model', nodeId: API, supplierCompanyId: seller.id, supplierProductId: sellerApi.id },
        { slotId: 'harness', nodeId: HARNESS, supplierCompanyId: null, supplierProductId: null },
      ]);
      const verdict = verdictFor(state, intent);
      expect(verdict.status, verdict.reasons.join(' | ')).toBe('accepted');

      // What the founder was told the line would open with, before launching.
      const preview = launchCapacityPreview(state, playerOf(state), VERTICAL, 0.6);
      expect(preview?.capacityKind).toBe('compute');
      expect(preview?.sharers).toBe(1);
      expect(preview?.unitsPerQuarter ?? 0).toBeGreaterThan(0);

      // The launch lands in the first quarter; the second stamps what it made.
      const landed = resolve(state, [asPlayer(state, intent)]);
      state = landed.nextState;
      // It ships in the quarter it lands, on exactly the capacity the preview quoted.
      const firstQuarter = landed.events.find((event) => event.type === 'demand_resolved' && event.actorId === W2_COMPANIES.player && event.payload.nodeId === VERTICAL);
      expect(firstQuarter?.payload.producibleUnits, 'the launched line had no capacity').toBe(preview?.unitsPerQuarter);
      expect(firstQuarter?.payload.unitsSold as number, 'the launched line sold nothing the quarter it landed').toBeGreaterThan(0);
      state = resolve(state, []).nextState;

      const player = playerOf(state);
      const line = lineOn(player, VERTICAL);
      const model = resolveFills(state, player, line, nodeOf(VERTICAL)).find((fill) => fill.slotId === 'model');
      expect(model).toMatchObject({ route: 'buy', nodeId: API, supplierCompanyId: seller.id, supplierProductId: sellerApi.id });
      expect(line.unitCostUsd ?? 0).toBeGreaterThan(0);
      // Still selling, and the opening line beside it still selling too.
      expect(line.unitsSoldQuarterly ?? 0).toBeGreaterThan(firstQuarter?.payload.unitsSold as number);
      expect(lineOn(player, SUITE).unitsSoldQuarterly ?? 0).toBeGreaterThan(0);
      const sentence = describeLine(state, player, line, player.id);
      expect(sentence).toContain(`${seller.name}'s inference API`);
      expect(sentence).toContain('aimed at logistics enterprises');
      booked.push({ seller: seller.name, unitCostUsd: line.unitCostUsd ?? 0, qualityScore: line.qualityScore, sentence });
    }

    const [onSable, onBasalt] = booked as [(typeof booked)[number], (typeof booked)[number]];
    expect(onSable.unitCostUsd).not.toBe(onBasalt.unitCostUsd);
    expect(onSable.qualityScore).not.toBe(onBasalt.qualityScore);
  });
});

/* -------------------------------------------------------------------------- */
/*  1b. A launched line sells, on a plant as on a cluster                       */
/* -------------------------------------------------------------------------- */

describe('a second line on the same bucket as the opening line', () => {
  it('ships from the quarter it lands and grows, on a robotics plant', { timeout: 120_000 }, () => {
    // The warehouse-robotics founder opens an industrial arm beside the robot
    // line that already fills the plant. The arm shipped nothing for six
    // quarters before `bucketShare` kept a foothold for it.
    let state = createWorld3Session(424242, NewGameSetupSchema.parse({ ...W3_DEFAULT_SETUP, backgroundId: 'warehouse_robotics', sector: 'robotics' }));
    const intent: ActionIntent = { ...(launchOf(state, ARM, 'Arm line', []) as Extract<ActionIntent, { type: 'launch_product' }>), targetIndustry: 'manufacturing', computeIntensity: 0.5 };
    const verdict = verdictFor(state, intent);
    expect(verdict.status, verdict.reasons.join(' | ')).toBe('accepted');
    const preview = launchCapacityPreview(state, playerOf(state), ARM, 0.5);
    expect(preview).toMatchObject({ capacityKind: 'plant', sharers: 1 });
    expect(preview?.unitsPerQuarter ?? 0).toBeGreaterThan(0);

    const units: number[] = [];
    for (let quarter = 0; quarter < 4; quarter += 1) {
      state = resolve(state, quarter === 0 ? [asPlayer(state, intent)] : []).nextState;
      units.push(lineOn(playerOf(state), ARM).unitsSoldQuarterly ?? 0);
    }
    expect(units[0], 'the arm shipped nothing the quarter it landed').toBeGreaterThan(0);
    expect(units[3], 'the arm did not grow into the plant').toBeGreaterThan(units[0] as number);
    // The opening line was not starved of its plant either.
    expect(lineOn(playerOf(state), 'sys_warehouse_amr').unitsSoldQuarterly ?? 0).toBeGreaterThan(0);
  });
});

/* -------------------------------------------------------------------------- */
/*  1c. The harness layer, the control stack and the structure have sellers    */
/* -------------------------------------------------------------------------- */

describe('the slots the owner named, in the seeded world', () => {
  /** Buy routes on one slot as `nodeId -> seller company ids`, for the player, on a line being launched. */
  function buyRoutesFor(state: SessionState, buyer: Company, nodeId: string, slotId: string): ReadonlyMap<string, readonly string[]> {
    const slot = slotOptions(state, buyer, nodeId, null).find((entry) => entry.slotId === slotId);
    if (slot === undefined) throw new Error(`${nodeId} has no slot ${slotId}`);
    const out = new Map<string, string[]>();
    for (const candidate of slot.candidates) {
      out.set(candidate.nodeId, candidate.routes.filter((route) => route.kind === 'buy').map((route) => route.supplierCompanyId ?? ''));
    }
    return out;
  }

  it('offers an app founder each harness node from a named company — two nodes, two companies', () => {
    const state = session();
    const routes = buyRoutesFor(state, playerOf(state), VERTICAL, 'harness');
    expect(routes.get(HARNESS)).toEqual([W2_COMPANIES.aletheia]);
    expect(routes.get('svc_copilot_framework')).toEqual([W2_COMPANIES.sable]);
    // The same two the quarter after the NPC publishing pass has run.
    const later = buyRoutesFor(resolve(state, []).nextState, playerOf(state), VERTICAL, 'harness');
    expect(later.get(HARNESS)).toContain(W2_COMPANIES.aletheia);
    expect(later.get('svc_copilot_framework')).toContain(W2_COMPANIES.sable);
  });

  it('offers a robot builder a named control stack and a named autonomy stack, from two companies', () => {
    const state = createWorld3Session(424242, NewGameSetupSchema.parse({ ...W3_DEFAULT_SETUP, backgroundId: 'warehouse_robotics', sector: 'robotics' }));
    const routes = buyRoutesFor(state, playerOf(state), ARM, 'harness');
    expect(routes.get('svc_robot_control_stack')).toEqual([W2_COMPANIES.palma]);
    expect(routes.get('svc_autonomy_stack')).toEqual([W2_COMPANIES.sentinel]);
    // And the opening robot already runs on Palma's stack rather than an anonymous market node.
    const robot = lineOn(playerOf(state), 'sys_warehouse_amr');
    const harness = resolveFills(state, playerOf(state), robot, nodeOf('sys_warehouse_amr')).find((fill) => fill.slotId === 'harness');
    expect(harness).toMatchObject({ route: 'buy', nodeId: 'svc_robot_control_stack', supplierCompanyId: W2_COMPANIES.palma });
  });

  it('gives a manufacturing line a structure slot with two nodes from two different producers', () => {
    const state = createWorld3Session(424242, NewGameSetupSchema.parse({ ...W3_DEFAULT_SETUP, backgroundId: 'contract_manufacturer', sector: 'manufacturing' }));
    for (const nodeId of ['sys_ai_accelerator', 'sys_battery_pack_lfp', 'sys_ai_server_rack']) {
      const routes = buyRoutesFor(state, playerOf(state), nodeId, 'structure');
      expect(routes.get('mat_machined_structure'), `${nodeId}: machined structure`).toEqual([W2_COMPANIES.rasan]);
      expect(routes.get('mat_carbon_composite'), `${nodeId}: carbon composite`).toEqual([W2_COMPANIES.volta]);
    }
  });
});

/* -------------------------------------------------------------------------- */
/*  2. Publishing reaches a rival's slot options                                */
/* -------------------------------------------------------------------------- */

describe('publishing a new line in the seeded world', () => {
  it('makes it a buy route in a seeded rival\'s slot options the quarter after the terms land', { timeout: 120_000 }, () => {
    // A frontier laboratory: the one background whose ownership reaches an
    // inference API on day one. The API node `requires` the frontier-model
    // capability — the table's knowledge ladder, unchanged by slots — so an
    // enterprise-software founder is told to research, licence or buy it
    // first; that refusal is pinned below so the ladder cannot move unnoticed.
    let state = session('frontier_lab');
    const sable = companyOf(state, W2_COMPANIES.sable);
    const sableModel = lineOn(sable, SMALL);

    // Quarter 0: the player launches an inference API on Sable's small model.
    const launch = launchOf(state, API, 'Player API', [{ slotId: 'model', nodeId: SMALL, supplierCompanyId: sable.id, supplierProductId: sableModel.id }], 'developer_api');
    const launchVerdict = verdictFor(state, launch);
    expect(launchVerdict.status, launchVerdict.reasons.join(' | ')).toBe('accepted');
    state = resolve(state, [asPlayer(state, launch)]).nextState;
    const api = lineOn(playerOf(state), API);

    // Nobody can buy it yet: the line has no terms.
    const rivalBefore = companyOf(state, W2_COMPANIES.aletheia);
    const suiteBefore = lineOn(rivalBefore, SUITE);
    const routesBefore = slotOptions(state, rivalBefore, SUITE, suiteBefore.id)
      .find((slot) => slot.slotId === 'model')
      ?.candidates.find((candidate) => candidate.nodeId === API)?.routes ?? [];
    expect(routesBefore.some((route) => route.kind === 'buy' && route.supplierCompanyId === W2_COMPANIES.player)).toBe(false);

    // Quarter 1: publish, open to all, at list price.
    const publish: ActionIntent = {
      type: 'set_supply_terms',
      productId: api.id,
      terms: { openToAll: true, pricePerUnitUsd: api.pricePerSeat, exclusiveCustomerIds: [], blockedCustomerIds: [] },
    };
    const publishVerdict = verdictFor(state, publish);
    expect(publishVerdict.status, publishVerdict.reasons.join(' | ')).toBe('accepted');
    const outcome = resolve(state, [asPlayer(state, publish)]);
    state = outcome.nextState;
    expect(outcome.events.some((event) => event.type === 'cost_recognised' && event.payload.kind === 'supply_started' && event.payload.productId === api.id)).toBe(true);
    expect(lineOn(playerOf(state), API).supplyTerms?.openToAll).toBe(true);

    // Quarter 2: Aletheia's suite sees the player's API as a route for its model slot.
    const rival = companyOf(state, W2_COMPANIES.aletheia);
    const suite = lineOn(rival, SUITE);
    const routes = slotOptions(state, rival, SUITE, suite.id)
      .find((slot) => slot.slotId === 'model')
      ?.candidates.find((candidate) => candidate.nodeId === API)?.routes ?? [];
    const mine = routes.find((route) => route.kind === 'buy' && route.supplierCompanyId === W2_COMPANIES.player);
    expect(mine, routes.map((route) => `${route.kind}:${route.supplierCompanyId ?? 'market'}`).join(', ')).toBeDefined();
    expect(mine).toMatchObject({ supplierProductId: api.id });
    // Beside the two seeded sellers, not instead of them.
    expect(routes.filter((route) => route.kind === 'buy').map((route) => route.supplierCompanyId).sort()).toEqual(
      [W2_COMPANIES.basalt, W2_COMPANIES.player, W2_COMPANIES.sable].sort(),
    );
  });

  it('is refused to an enterprise-AI founder who does not hold the frontier-model capability, and says what to do', () => {
    const state = session();
    const sable = companyOf(state, W2_COMPANIES.sable);
    const verdict = verdictFor(state, launchOf(state, API, 'Player API', [{ slotId: 'model', nodeId: SMALL, supplierCompanyId: sable.id, supplierProductId: lineOn(sable, SMALL).id }], 'developer_api'));
    expect(verdict.status).toBe('rejected');
    expect(verdict.reasons.join(' ')).toContain('Frontier model');
    expect(verdict.reasons.join(' ')).toContain('Research it, licence it, or buy a company that has it');
  });
});

/* -------------------------------------------------------------------------- */
/*  3. Aiming changes the pool                                                 */
/* -------------------------------------------------------------------------- */

describe('aiming the opening line elsewhere', () => {
  it('moves it to another cell with a different pool, and the ledger records the move', { timeout: 120_000 }, () => {
    let state = session();
    const node = nodeOf(SUITE);
    const before = cellOf(lineOn(playerOf(state), SUITE), node);
    expect(before).toEqual({ industry: 'logistics', customer: 'enterprise' });
    const poolBefore = cellEndDemandUnits(state, node, before.industry, before.customer);
    expect(poolBefore).toBeGreaterThan(0);

    // Developers in the AI industry: a cell the suite's market weights differently.
    const aim: ActionIntent = { type: 'set_target_market', productId: lineOn(playerOf(state), SUITE).id, targetIndustry: 'ai', segment: 'developer_api' };
    const verdict = verdictFor(state, aim);
    expect(verdict.status, verdict.reasons.join(' | ')).toBe('accepted');
    const outcome = resolve(state, [asPlayer(state, aim)]);
    state = outcome.nextState;

    const line = lineOn(playerOf(state), SUITE);
    const after = cellOf(line, node);
    expect(after).toEqual({ industry: 'ai', customer: 'developer_api' });
    expect(line.targetIndustry).toBe('ai');
    expect(line.segment).toBe('developer_api');
    const poolAfter = cellEndDemandUnits(state, node, after.industry, after.customer);
    expect(poolAfter).not.toBe(poolBefore);
    expect(outcome.events.some((event) => event.type === 'target_market_set' && event.actorId === W2_COMPANIES.player && event.payload.productId === line.id)).toBe(true);
  });
});
