/**
 * @frontier/simulation — world 3, stage 5: licensing, acquisition and the cull.
 *
 * Ownership of a node is per company, which is the fix world 3 exists for — and
 * it would be a wall if the only way through it were a research programme. It
 * is not. There are three ways to be able to make a thing, and this file is
 * about the two that are not research:
 *
 * 1. **Licence it.** A signing fee of `LICENCE_UPFRONT_SHARE` of what the
 *    programme would have cost — about a sixth of it — and a royalty on every
 *    line that needs it, every quarter, for twelve quarters, after which the
 *    owner may simply decline. The request rides the ordinary deal machinery:
 *    it proposes, it is accepted or refused, and it is audited, exactly like
 *    every other agreement in the game.
 * 2. **Buy the company.** Absorbing one unions its ownership into yours.
 *    Licences do NOT move, because a licence names its licensee — so buying a
 *    licensee buys the revenue and not the right behind it, which is a real
 *    detail and a real trap.
 *
 * And the cull: who may sell an accelerator in world 3 is no longer an
 * archetype list. It is whoever owns `sys_ai_accelerator` and runs a line on
 * it, at the price the node market set this quarter.
 *
 * The frozen worlds are pinned by hash in `world2Scenario.test.ts` and are not
 * restated here.
 */

import { describe, expect, it } from 'vitest';
import type { ActionIntent, Company, SessionState, SubmittedAction } from '@frontier/contracts';
import { COMPUTE_CAPACITY_NODE_ID, economicNodeById, holdsNode, nodeMarketPriceUsd } from '@frontier/contracts';
import { createDefaultEngine } from '../src/engine';
import { createWorld3Session } from '../src/scenario/world3';
import { createWorld2Session } from '../src/scenario/world2';
import {
  LICENCE_ROYALTY_BOUNDS,
  LICENCE_TERM_QUARTERS,
  LICENCE_UPFRONT_SHARE,
  NPC_LICENCE_ROYALTY_FLOOR_PCT,
  boundedRoyaltyPct,
  isDirectRivalOnNode,
  licenceUpfrontUsd,
  licenseesOf,
  nodeResearchMidUsd,
  npcLicenceVerdict,
  ownsNodeOutright,
} from '../src/graph/licensing';
import { createNodeCostCache } from '../src/graph/lines';
import { unitCostOf } from '../src/graph/cost';
import { acceleratorLineOutputUnits, sellersFor, sellsAcceleratorNode } from '../src/companies/sellers';
import { validateAction } from '../src/validator';
import { BatchBudget } from '../src/validator/context';

/* -------------------------------------------------------------------------- */
/*  Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

const PLAYER = 'cmp_player_ventures';
const PLAYER_CHARACTER = 'chr_avery_sinclair';
const PLAYER_ID = 'player_1';

/** Nodes and owners this file quotes from the seeded world, asserted before anything is built on them. */
const ACTUATOR = 'cmp_precision_actuator';
const ACTUATOR_OWNER = 'cmp_ironvale';
const MODEL = 'sys_frontier_model';
const MODEL_OWNER = 'cmp_aletheia';
const INFERENCE = 'svc_inference_api';
const INFERENCE_SELLER = 'cmp_sable';

const companyOf = (state: SessionState, id: string): Company => {
  const company = state.companies.find((entry) => entry.id === id);
  if (company === undefined) throw new Error(`no company ${id}`);
  return company;
};

function withCash(state: SessionState, cashUsd: number, companyId = PLAYER): SessionState {
  const company = companyOf(state, companyId);
  const added = cashUsd - company.balanceSheet.assets.cash;
  company.balanceSheet.assets.cash = cashUsd;
  company.balanceSheet.equity += added;
  company.financials.cash = cashUsd;
  return state;
}

/** Board approval is exercised elsewhere; this isolates the licensing path. */
function withoutBoard(state: SessionState, companyId = PLAYER): SessionState {
  const company = companyOf(state, companyId);
  const boardId = company.boardId;
  company.boardId = null;
  state.boards = state.boards.filter((board) => board.id !== boardId);
  state.boardProposals = state.boardProposals.filter((proposal) => proposal.boardId !== boardId);
  return state;
}

let sequence = 0;

function act(state: SessionState, intent: ActionIntent, companyId = PLAYER, characterId = PLAYER_CHARACTER): SubmittedAction {
  sequence += 1;
  return {
    actionId: `act_licence_${sequence}`,
    sessionId: state.sessionId,
    quarter: state.quarter,
    sequence,
    actorPlayerId: PLAYER_ID,
    actorCompanyId: companyId,
    actorCharacterId: characterId,
    origin: 'player_ui',
    intent,
    confirmedByHuman: true,
  };
}

function resolveOne(state: SessionState, actions: readonly SubmittedAction[]) {
  const engine = createDefaultEngine();
  const outcome = engine.resolver.resolveQuarter(state, [...actions], null, []);
  const failures = outcome.invariants.filter((result) => !result.passed).map((result) => `${result.invariant}: ${result.detail}`);
  expect(failures).toEqual([]);
  expect(outcome.committed).toBe(true);
  return outcome;
}

/**
 * The seeded world, with the frontier model in Aletheia's hands.
 *
 * CHANGED DELIBERATELY, slots: a rival's reach is `round(1 + 6 x capability)`,
 * so the coverage pass that once handed Aletheia the model — the only AI node
 * nobody's rule reached — no longer needs to. CHANGED AGAIN, composed lines:
 * Aletheia now opens SELLING the frontier model (`W3_RIVAL_LINES`), so it owns
 * it outright at seed beside the three inference sellers and the addition
 * below is a no-op kept so the fixture states what it relies on. The royalty
 * assertions below need an owner that does NOT compete with the licensee's
 * inference line, or the owner's takings would move for two reasons at once;
 * Aletheia sells a model and a suite, never inference, which is exactly the
 * world these tests were written against.
 */
function seeded(): SessionState {
  const state = createWorld3Session();
  const owner = companyOf(state, MODEL_OWNER);
  if (!(owner.ownedNodes ?? []).includes(MODEL)) owner.ownedNodes = [...(owner.ownedNodes ?? []), MODEL];
  return state;
}

/** The seeded world with the seat solvent enough to sign, and no board in the way. */
function world3(cashUsd = 4_000_000_000): SessionState {
  const state = seeded();
  const player = companyOf(state, PLAYER);
  player.controllerPlayerId = PLAYER_ID;
  return withoutBoard(withCash(state, cashUsd));
}

describe('the seeded world these tests are pinned to', () => {
  it('still has the owners and the lines they quote', () => {
    const state = seeded();
    // The raw seed hands the model to the lab that sells it and to the three
    // inference sellers; the fixture's addition changes nothing.
    const rawOwners = createWorld3Session().companies.filter((company) => ownsNodeOutright(company, MODEL)).map((company) => company.id);
    expect(rawOwners).toEqual(['cmp_aletheia', 'cmp_sable', 'cmp_basalt', 'cmp_kestrel']);
    expect(economicNodeById(ACTUATOR)?.sector).toBe('robotics');
    expect(economicNodeById(MODEL)?.sector).toBe('ai');
    // The inference line requires the model: that is what makes a licence over
    // the model reach the roll-up of a line that sells something else.
    expect(economicNodeById(INFERENCE)?.requires).toEqual([MODEL]);
    expect(ownsNodeOutright(companyOf(state, ACTUATOR_OWNER), ACTUATOR)).toBe(true);
    expect(ownsNodeOutright(companyOf(state, MODEL_OWNER), MODEL)).toBe(true);
    expect(ownsNodeOutright(companyOf(state, PLAYER), ACTUATOR)).toBe(false);
    expect(companyOf(state, INFERENCE_SELLER).products.some((product) => product.nodeId === INFERENCE)).toBe(true);
    // The seat and the actuator's owner are in different industries, which is
    // what makes the owner willing to licence at the floor.
    expect(companyOf(state, PLAYER).sector).toBe('ai');
  });
});

/* -------------------------------------------------------------------------- */
/*  1. What a licence costs                                                    */
/* -------------------------------------------------------------------------- */

describe('the price of a licence', () => {
  it('is a fixed share of what researching it would have cost, and about a sixth of it', () => {
    for (const nodeId of [ACTUATOR, MODEL, COMPUTE_CAPACITY_NODE_ID]) {
      const node = economicNodeById(nodeId);
      expect(node).toBeDefined();
      if (node === undefined) continue;
      const fee = licenceUpfrontUsd(node);
      expect(fee).toBe(Math.round(nodeResearchMidUsd(node) * LICENCE_UPFRONT_SHARE));
      // Plainly cheaper than the programme — the whole reason to offer it —
      // and never so cheap that owning is pointless.
      const ratio = nodeResearchMidUsd(node) / fee;
      expect(ratio).toBeGreaterThan(5);
      expect(ratio).toBeLessThan(8);
    }
  });

  it('holds a royalty inside the band rather than refusing it', () => {
    expect(boundedRoyaltyPct(0)).toBe(LICENCE_ROYALTY_BOUNDS.min);
    expect(boundedRoyaltyPct(40)).toBe(LICENCE_ROYALTY_BOUNDS.max);
    expect(boundedRoyaltyPct(7)).toBe(7);
    expect(boundedRoyaltyPct(Number.NaN)).toBe(LICENCE_ROYALTY_BOUNDS.min);
  });
});

/* -------------------------------------------------------------------------- */
/*  2. Whether the owner says yes                                              */
/* -------------------------------------------------------------------------- */

describe('an NPC owner\'s answer', () => {
  const state = createWorld3Session();
  const node = economicNodeById(ACTUATOR);
  const owner = companyOf(state, ACTUATOR_OWNER);
  const outsider = companyOf(state, PLAYER);
  const rival = companyOf(state, 'cmp_sentinel');

  it('knows a rival in the node\'s own industry from a stranger to it', () => {
    expect(node).toBeDefined();
    if (node === undefined) return;
    expect(isDirectRivalOnNode(owner, rival, node)).toBe(true);
    expect(isDirectRivalOnNode(owner, outsider, node)).toBe(false);
  });

  it('licenses a stranger at the floor and refuses below it', () => {
    if (node === undefined) return;
    expect(npcLicenceVerdict(owner, outsider, node, NPC_LICENCE_ROYALTY_FLOOR_PCT).accepted).toBe(true);
    expect(npcLicenceVerdict(owner, outsider, node, NPC_LICENCE_ROYALTY_FLOOR_PCT - 1).accepted).toBe(false);
  });

  it('makes a rival clear twice the floor, and says why either way', () => {
    if (node === undefined) return;
    const thin = npcLicenceVerdict(owner, rival, node, NPC_LICENCE_ROYALTY_FLOOR_PCT);
    expect(thin.accepted).toBe(false);
    expect(thin.reason).toContain('rival');
    expect(npcLicenceVerdict(owner, rival, node, NPC_LICENCE_ROYALTY_FLOOR_PCT * 2).accepted).toBe(true);
  });

  it('honours terms it published, and still refuses a rival unless they are open to all', () => {
    if (node === undefined) return;
    const publisher: Company = { ...owner, licenceOffers: [{ nodeId: ACTUATOR, royaltyPct: 3, openToAll: true }] };
    // Three percent is under the floor; published terms are the owner's own
    // word and beat the floor.
    expect(npcLicenceVerdict(publisher, outsider, node, 3).accepted).toBe(true);
    expect(npcLicenceVerdict(publisher, rival, node, 3).accepted).toBe(true);

    const guarded: Company = { ...owner, licenceOffers: [{ nodeId: ACTUATOR, royaltyPct: 3, openToAll: false }] };
    expect(npcLicenceVerdict(guarded, outsider, node, 3).accepted).toBe(true);
    const refused = npcLicenceVerdict(guarded, rival, node, 3);
    expect(refused.accepted).toBe(false);
    expect(refused.reason).toContain('rival');
  });
});

/* -------------------------------------------------------------------------- */
/*  3. A licence grants production, and it lapses                              */
/* -------------------------------------------------------------------------- */

describe('licensing a node from the company that owns it', () => {
  it('signs, pays the fee, and grants the right for twelve quarters', () => {
    const state = world3();
    const node = economicNodeById(ACTUATOR);
    expect(node).toBeDefined();
    if (node === undefined) return;
    const fee = licenceUpfrontUsd(node);

    const outcome = resolveOne(state, [
      act(state, { type: 'license_node', nodeId: ACTUATOR, ownerCompanyId: ACTUATOR_OWNER, royaltyPct: NPC_LICENCE_ROYALTY_FLOOR_PCT }),
    ]);
    const next = outcome.nextState;
    const seat = companyOf(next, PLAYER);

    // The right, at the term the engine sets — never the licensee's choice.
    const licence = (seat.licences ?? []).find((entry) => entry.nodeId === ACTUATOR);
    expect(licence).toBeDefined();
    expect(licence?.ownerCompanyId).toBe(ACTUATOR_OWNER);
    expect(licence?.royaltyPct).toBe(NPC_LICENCE_ROYALTY_FLOOR_PCT);
    expect(licence?.expiryQuarter).toBe(state.quarter + LICENCE_TERM_QUARTERS);
    expect(holdsNode(seat, ACTUATOR, next.quarter)).toBe(true);
    // Holding is not owning: it cannot be licensed on.
    expect(ownsNodeOutright(seat, ACTUATOR)).toBe(false);

    // The fee moved, both ways, in the quarter it was signed — measured
    // against the same quarter with nothing asked, so the companies' own
    // trading is on both sides of the comparison and cancels.
    const quiet = resolveOne(world3(), []).nextState;
    expect(companyOf(next, ACTUATOR_OWNER).financials.cash - companyOf(quiet, ACTUATOR_OWNER).financials.cash).toBeCloseTo(fee, 0);
    expect(companyOf(quiet, PLAYER).financials.cash - seat.financials.cash).toBeCloseTo(fee, 0);

    // It rode the ordinary deal path, and it is done rather than left open.
    const deal = next.deals.find((entry) => entry.gets.some((obligation) => obligation.kind === 'node_licence'));
    expect(deal?.status).toBe('executed');
    expect(outcome.events.some((event) => event.type === 'node_licensed' && event.targetId === PLAYER)).toBe(true);
    // The owner is on the other side of it, and can read who is paying.
    expect(licenseesOf(next, ACTUATOR_OWNER).map((entry) => entry.company.id)).toContain(PLAYER);
  });

  it('is refused by a rival owner at the floor, and nothing is granted or paid', () => {
    // Sable and the seat both sell into the AI sector, which is the node's
    // own sector — so the floor is doubled and six percent is not enough.
    const asked = resolveOne(world3(2_000_000_000), [
      act(world3(2_000_000_000), { type: 'license_node', nodeId: MODEL, ownerCompanyId: MODEL_OWNER, royaltyPct: NPC_LICENCE_ROYALTY_FLOOR_PCT }),
    ]).nextState;
    // The control: the same quarter with nothing asked. A refusal has to leave
    // the owner exactly where an ordinary quarter would, and comparing against
    // the opening cash would compare against the quarter's trading too.
    const quiet = resolveOne(world3(2_000_000_000), []).nextState;

    expect((companyOf(asked, PLAYER).licences ?? []).some((entry) => entry.nodeId === MODEL)).toBe(false);
    expect(companyOf(asked, MODEL_OWNER).financials.cash).toBeCloseTo(companyOf(quiet, MODEL_OWNER).financials.cash, 0);
    const deal = asked.deals.find((entry) => entry.gets.some((obligation) => obligation.kind === 'node_licence'));
    expect(deal?.status).toBe('rejected');
  });

  it('lapses when the term runs out, and says so', () => {
    const state = world3();
    const seat = companyOf(state, PLAYER);
    // A licence with one quarter left, which is to say none: `holdsNode` reads
    // the expiry as exclusive, so this quarter is already past it.
    seat.licences = [{ nodeId: ACTUATOR, ownerCompanyId: ACTUATOR_OWNER, royaltyPct: 6, expiryQuarter: state.quarter }];
    const outcome = resolveOne(state, []);
    const next = outcome.nextState;
    expect((companyOf(next, PLAYER).licences ?? []).some((entry) => entry.nodeId === ACTUATOR)).toBe(false);
    expect(outcome.events.some((event) => event.type === 'node_licence_lapsed' && event.targetId === PLAYER)).toBe(true);
  });

  it('is refused outright when the named owner only licenses it themselves', () => {
    const state = world3();
    const middleman = companyOf(state, 'cmp_sable');
    middleman.ownedNodes = (middleman.ownedNodes ?? []).filter((id) => id !== MODEL);
    middleman.licences = [{ nodeId: MODEL, ownerCompanyId: MODEL_OWNER, royaltyPct: 8, expiryQuarter: state.quarter + 8 }];
    expect(holdsNode(middleman, MODEL, state.quarter)).toBe(true);

    const verdict = validateAction(
      state,
      { type: 'license_node', nodeId: MODEL, ownerCompanyId: middleman.id, royaltyPct: 8 },
      { playerId: PLAYER_ID, companyId: PLAYER, characterId: PLAYER_CHARACTER, confirmedByHuman: true },
      new BatchBudget(),
      'act_licence_probe',
    );
    expect(verdict.status).toBe('rejected');
    expect(verdict.reasons.join(' ')).toContain('licence on what it licensed');
  });

  it('clamps a royalty outside the band instead of refusing the ask', () => {
    const state = world3();
    const verdict = validateAction(
      state,
      { type: 'license_node', nodeId: ACTUATOR, ownerCompanyId: ACTUATOR_OWNER, royaltyPct: 40 },
      { playerId: PLAYER_ID, companyId: PLAYER, characterId: PLAYER_CHARACTER, confirmedByHuman: true },
      new BatchBudget(),
      'act_licence_probe',
    );
    expect(verdict.status).toBe('clamped');
    expect(verdict.clampedAction).toMatchObject({ type: 'license_node', royaltyPct: LICENCE_ROYALTY_BOUNDS.max });
  });

  it('is not an action any earlier world has', () => {
    const world2 = createWorld2Session();
    const seat = world2.companies.find((company) => company.controllerPlayerId !== null);
    expect(seat).toBeDefined();
    const character = world2.characters.find((entry) => entry.companyId === seat?.id);
    const verdict = validateAction(
      world2,
      { type: 'license_node', nodeId: ACTUATOR, ownerCompanyId: ACTUATOR_OWNER, royaltyPct: 6 },
      { playerId: PLAYER_ID, companyId: seat?.id ?? '', characterId: character?.id ?? '', confirmedByHuman: true },
      new BatchBudget(),
      'act_licence_probe',
    );
    expect(verdict.status).toBe('rejected');
    expect(verdict.codes).toContain('requirement_not_met');
  });
});

/* -------------------------------------------------------------------------- */
/*  4. The royalty, in the unit cost and in both sets of books                 */
/* -------------------------------------------------------------------------- */

/** Sable's inference line, made to run under Aletheia's licence rather than its own model. */
function underLicence(royaltyPct: number): SessionState {
  const state = seeded();
  const licensee = companyOf(state, INFERENCE_SELLER);
  licensee.ownedNodes = (licensee.ownedNodes ?? []).filter((id) => id !== MODEL);
  licensee.licences = [{ nodeId: MODEL, ownerCompanyId: MODEL_OWNER, royaltyPct, expiryQuarter: state.quarter + LICENCE_TERM_QUARTERS }];
  return state;
}

/**
 * One resolved quarter of the whole engine, not the financial phase alone: the
 * roll-up reads what the production phase stamped, so a phase run on its own
 * would be answering a question nothing in the game ever asks.
 */
function afterOneQuarter(state: SessionState): SessionState {
  return resolveOne(state, []).nextState;
}

describe('the royalty', () => {
  it('appears in the licensee\'s unit cost breakdown, struck on the node\'s market price', () => {
    const royaltyPct = 8;
    const state = underLicence(royaltyPct);
    const licensee = companyOf(state, INFERENCE_SELLER);
    const cost = unitCostOf(state, licensee, INFERENCE, createNodeCostCache(state));

    const line = cost.lines.find((entry) => entry.key === `licence:${MODEL}`);
    expect(line, 'the roll-up says nothing about the licence it is producing under').toBeDefined();
    expect(line?.sourceCompanyId).toBe(MODEL_OWNER);
    expect(line?.amountUsd).toBeCloseTo((royaltyPct / 100) * nodeMarketPriceUsd(state, INFERENCE), 6);
    // It is part of the total, not a note beside it: the column adds up.
    expect(cost.unitCostUsd).toBeCloseTo(
      cost.lines.reduce((total, entry) => total + entry.amountUsd, 0),
      6,
    );
  });

  it('is a cost to the licensee and revenue to the owner, of the same dollars', () => {
    const royaltyPct = 8;
    const withLicence = afterOneQuarter(underLicence(royaltyPct));
    const withoutLicence = afterOneQuarter(seeded());

    const licensee = companyOf(withLicence, INFERENCE_SELLER);
    const baseline = companyOf(withoutLicence, INFERENCE_SELLER);
    const owner = companyOf(withLicence, MODEL_OWNER);
    const ownerBaseline = companyOf(withoutLicence, MODEL_OWNER);

    const units = licensee.products.find((product) => product.nodeId === INFERENCE)?.unitsSoldQuarterly ?? 0;
    expect(units).toBeGreaterThan(0);

    // The owner's revenue rose. It rose by a royalty, so it has no cost of
    // goods behind it — the owner is being paid for a thing it already owns.
    const ownerGain = owner.financials.revenueQuarterly - ownerBaseline.financials.revenueQuarterly;
    expect(ownerGain).toBeGreaterThan(0);
    expect(owner.financials.cogs).toBeCloseTo(ownerBaseline.financials.cogs, 0);

    // And the licensee's cost of goods rose, because it stopped MAKING the
    // model and started paying for it: the royalty plus the input it now buys
    // rather than transfers at its own cost.
    expect(licensee.financials.cogs).toBeGreaterThan(baseline.financials.cogs);
  });
});

/* -------------------------------------------------------------------------- */
/*  5. An acquisition takes the nodes and not the licences                     */
/* -------------------------------------------------------------------------- */

describe('buying the company instead', () => {
  it('leaves a live subsidiary its own ownership, and unions it on the merge — licences excepted', () => {
    const state = world3(30_000_000_000);
    const target = companyOf(state, ACTUATOR_OWNER);
    // The target holds one node outright and one only under licence. Only the
    // first is a thing the acquirer can be sold.
    target.licences = [{ nodeId: MODEL, ownerCompanyId: MODEL_OWNER, royaltyPct: 9, expiryQuarter: state.quarter + 8 }];
    const targetOwned = [...(target.ownedNodes ?? [])];
    const seatOwnedBefore = [...(companyOf(state, PLAYER).ownedNodes ?? [])];
    expect(targetOwned).toContain(ACTUATOR);
    expect(seatOwnedBefore).not.toContain(ACTUATOR);

    const bought = resolveOne(state, [
      act(state, { type: 'acquire_company', targetCompanyId: ACTUATOR_OWNER, offerValueUsd: 8_000_000_000, cashPct: 1, stockPct: 0 }),
    ]).nextState;

    // A multi-sector acquisition keeps the target alive, and a live subsidiary
    // keeps its own ownership: the group has the capability, the company that
    // holds it still exists.
    const subsidiary = companyOf(bought, ACTUATOR_OWNER);
    expect(subsidiary.isActive).toBe(true);
    expect(subsidiary.ownedNodes).toEqual(targetOwned);
    expect(companyOf(bought, PLAYER).ownedNodes).toEqual(seatOwnedBefore);

    const merged = resolveOne(bought, [act(bought, { type: 'merge_subsidiary', subsidiaryCompanyId: ACTUATOR_OWNER })]).nextState;
    const acquirer = companyOf(merged, PLAYER);
    // Every node the target owned, and everything the acquirer already had.
    for (const nodeId of targetOwned) expect(acquirer.ownedNodes).toContain(nodeId);
    for (const nodeId of seatOwnedBefore) expect(acquirer.ownedNodes).toContain(nodeId);
    expect(new Set(acquirer.ownedNodes).size).toBe(acquirer.ownedNodes?.length);

    // But NOT the licence: it named the company that has just been
    // extinguished, and it dies with it.
    expect((acquirer.licences ?? []).some((entry) => entry.nodeId === MODEL)).toBe(false);
    expect(holdsNode(acquirer, MODEL, merged.quarter)).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/*  6. The cull: who may sell an accelerator                                   */
/* -------------------------------------------------------------------------- */

describe('who sells accelerators in the node economy', () => {
  it('is whoever owns the node and runs a line on it, and nobody else', () => {
    const state = createWorld3Session();
    for (const company of state.companies) {
      if (!company.isActive) continue;
      const holdsIt = holdsNode(company, COMPUTE_CAPACITY_NODE_ID, state.quarter);
      const runsIt = company.products.some((product) => product.isActive && product.nodeId === COMPUTE_CAPACITY_NODE_ID);
      expect(sellsAcceleratorNode(state, company), `${company.id} disagrees with the ownership rule`).toBe(holdsIt && runsIt);
    }
    // And the market is exactly that set, priced off the node. The seeded world
    // may hold no accelerator line at all — nobody has opened a fab yet — which
    // is why the rule, not the seed, is what is asserted here.
    const market = sellersFor(state, 'accelerators', PLAYER);
    for (const seller of market) {
      expect(sellsAcceleratorNode(state, seller.company)).toBe(true);
      expect(seller.sellableUnits).toBe(acceleratorLineOutputUnits(seller.company));
      // The node market has already priced the quarter's scarcity, once, for
      // everybody: what is left is the seller's own region and load.
      const list = nodeMarketPriceUsd(state, COMPUTE_CAPACITY_NODE_ID);
      expect(seller.unitPriceUsd).toBeGreaterThan(list * 0.6);
      expect(seller.unitPriceUsd).toBeLessThan(list * 1.6);
    }
  });

  it('starts when an owner opens a line and stops when the line does', () => {
    const state = createWorld3Session();
    // An owner of the node with no line on it is not a seller: owning a design
    // and running a fab are different things.
    const owner = state.companies.find((company) => ownsNodeOutright(company, COMPUTE_CAPACITY_NODE_ID));
    expect(owner, 'the seeded world has no owner of the accelerator node').toBeDefined();
    if (owner === undefined) return;
    expect(sellsAcceleratorNode(state, owner)).toBe(false);

    const line = owner.products[0];
    expect(line).toBeDefined();
    if (line === undefined) return;
    owner.products = [{ ...line, id: 'prd_accelerator_line', name: 'Accelerators', nodeId: COMPUTE_CAPACITY_NODE_ID, unitsSoldQuarterly: 4_000, isActive: true }];

    expect(sellsAcceleratorNode(state, owner)).toBe(true);
    expect(acceleratorLineOutputUnits(owner)).toBe(4_000);
    const market = sellersFor(state, 'accelerators', PLAYER);
    expect(market.map((entry) => entry.company.id)).toContain(owner.id);
    const quote = market.find((entry) => entry.company.id === owner.id);
    const list = nodeMarketPriceUsd(state, COMPUTE_CAPACITY_NODE_ID);
    // The node market has already priced the quarter's scarcity, once, for
    // everybody: what is left is the seller's own region and load.
    expect(quote?.sellableUnits).toBe(4_000);
    expect(quote?.unitPriceUsd ?? 0).toBeGreaterThan(list * 0.6);
    expect(quote?.unitPriceUsd ?? 0).toBeLessThan(list * 1.6);

    // And a licence that lapses under a live line ends the business the same
    // quarter, which no archetype list could ever express.
    owner.ownedNodes = (owner.ownedNodes ?? []).filter((id) => id !== COMPUTE_CAPACITY_NODE_ID);
    expect(sellsAcceleratorNode(state, owner)).toBe(false);
    expect(sellersFor(state, 'accelerators', PLAYER).map((entry) => entry.company.id)).not.toContain(owner.id);
  });
});
