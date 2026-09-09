/**
 * STAGE 4 — group control.
 *
 * An acquisition in world 2 keeps the target alive as a subsidiary; the
 * player then directs it like any other company they control, moves cash and
 * compute between group members explicitly, and can later absorb a
 * subsidiary outright with `merge_subsidiary`. A majority stake built up
 * without a formal offer hands over control the same way, and gives it back
 * when the stake drops. `controlledCompaniesOf` and `groupStatementOf` are
 * the read side of all of it.
 *
 * World 1 is untouched by any of this: `portfolio.test.ts` and
 * `world2Scenario.test.ts` are what pin that.
 */

import { describe, expect, it } from 'vitest';
import type { ActionIntent, SessionState, SubmittedAction } from '@frontier/contracts';
import { createDefaultEngine } from '../src/engine';
import { DEMO_PLAYER_ID } from '../src/scenario';
import { createWorld2Session } from '../src/scenario/world2';
import { controlledCompaniesOf, groupStatementOf } from '../src';
import { strategistCompanyIds } from '../src/companies/strategists';

const PLAYER_COMPANY = 'cmp_player_ventures';
const PLAYER_CHARACTER = 'chr_avery_sinclair';
const ALETHEIA = 'cmp_aletheia';
const ALETHEIA_CEO = 'chr_rhea_valdes'; // W2_FOUNDERS.aletheia — see scenario/world2/seeds.ts
const BASALT = 'cmp_basalt';
const BASALT_SECURITY = 'sec_basalt_common';

const companyOf = (state: SessionState, id: string) => {
  const company = state.companies.find((entry) => entry.id === id);
  if (company === undefined) throw new Error(`no company ${id}`);
  return company;
};

function withCash(state: SessionState, cashUsd: number): SessionState {
  const company = companyOf(state, PLAYER_COMPANY);
  const added = cashUsd - company.balanceSheet.assets.cash;
  company.balanceSheet.assets.cash = cashUsd;
  company.balanceSheet.equity += added;
  company.financials.cash = cashUsd;
  return state;
}

/** Board approval is exercised elsewhere; this isolates the group-control path. */
function withoutBoard(state: SessionState): SessionState {
  const company = companyOf(state, PLAYER_COMPANY);
  const boardId = company.boardId;
  company.boardId = null;
  state.boards = state.boards.filter((board) => board.id !== boardId);
  state.boardProposals = state.boardProposals.filter((proposal) => proposal.boardId !== boardId);
  return state;
}

let sequence = 0;

function act(
  state: SessionState,
  intent: ActionIntent,
  options: { readonly companyId?: string; readonly characterId?: string; readonly playerId?: string | null } = {},
): SubmittedAction {
  sequence += 1;
  return {
    actionId: `act_group_${sequence}`,
    sessionId: state.sessionId,
    quarter: state.quarter,
    sequence,
    actorPlayerId: options.playerId === undefined ? DEMO_PLAYER_ID : options.playerId,
    actorCompanyId: options.companyId ?? PLAYER_COMPANY,
    actorCharacterId: options.characterId ?? PLAYER_CHARACTER,
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

/** A world-2 session with Aletheia Labs acquired as a live subsidiary. */
function afterAcquiringAletheia() {
  const state = withoutBoard(withCash(createWorld2Session(), 30_000_000_000));
  const outcome = resolveOne(state, [
    act(state, { type: 'acquire_company', targetCompanyId: ALETHEIA, offerValueUsd: 12_000_000_000, cashPct: 1, stockPct: 0 }),
  ]);
  return outcome.nextState;
}

/* -------------------------------------------------------------------------- */
/*  controlledCompaniesOf                                                     */
/* -------------------------------------------------------------------------- */

describe('controlledCompaniesOf', () => {
  it('is just the founding company before any acquisition', () => {
    const state = createWorld2Session();
    const controlled = controlledCompaniesOf(state, DEMO_PLAYER_ID);
    expect(controlled.map((company) => company.id)).toEqual([PLAYER_COMPANY]);
  });

  it('lists the founding company first, then a live subsidiary', () => {
    const next = afterAcquiringAletheia();
    const controlled = controlledCompaniesOf(next, DEMO_PLAYER_ID);
    expect(controlled.map((company) => company.id)).toEqual([PLAYER_COMPANY, ALETHEIA]);
    expect(controlled[1]?.isActive).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/*  Acting as a subsidiary                                                    */
/* -------------------------------------------------------------------------- */

describe('directing a subsidiary', () => {
  it('accepts and resolves an ordinary action submitted on its behalf', () => {
    const next = afterAcquiringAletheia();
    const outcome = resolveOne(next, [act(next, { type: 'hire', role: 'engineers', count: 5, compBand: 'market' }, { companyId: ALETHEIA })]);
    const row = outcome.events.find(
      (event) => event.type === 'action_accepted' && event.actorId === ALETHEIA && (event.payload as { intentType?: string }).intentType === 'hire',
    );
    expect(row).toBeDefined();
  });

  it('rejects the same action from a player who does not control it', () => {
    const next = afterAcquiringAletheia();
    const engine = createDefaultEngine();
    const outcome = engine.resolver.resolveQuarter(
      next,
      [act(next, { type: 'hire', role: 'engineers', count: 5, compBand: 'market' }, { companyId: ALETHEIA, playerId: 'ply_rival', characterId: 'chr_rival' })],
      null,
      [],
    );
    const row = outcome.events.find((event) => event.targetId !== undefined && event.type === 'action_rejected');
    expect(row?.payload).toMatchObject({ codes: expect.arrayContaining(['not_controller_of_company']) });
  });

  it('lets the controller overrule the subsidiary CEO on a CEO_ONLY action, and the CEO remembers it', () => {
    const next = afterAcquiringAletheia();
    const outcome = resolveOne(next, [
      act(next, { type: 'give_guidance', metric: 'revenue', value: 800_000_000, quarter: next.quarter + 1 }, { companyId: ALETHEIA }),
    ]);
    const accepted = outcome.events.some(
      (event) => event.type === 'action_accepted' && event.actorId === ALETHEIA && (event.payload as { intentType?: string }).intentType === 'give_guidance',
    );
    expect(accepted).toBe(true);

    const memory = outcome.nextState.memories.find((entry) => entry.ownerCharacterId === ALETHEIA_CEO && entry.aboutId === PLAYER_CHARACTER);
    expect(memory?.kind).toBe('personal');
    expect(memory?.sentiment).toBeLessThan(0);
  });
});

/* -------------------------------------------------------------------------- */
/*  transfer_between_group                                                    */
/* -------------------------------------------------------------------------- */

describe('transfer_between_group', () => {
  it('moves cash both ways with a double entry', () => {
    // Ordinary quarterly P&L moves cash on both companies regardless of the
    // transfer, so the proof is the ledger's double entry — one row, both
    // ends named, the same amount — not an exact before/after cash diff.
    const afterAcquisition = afterAcquiringAletheia();

    const down = resolveOne(afterAcquisition, [
      act(afterAcquisition, { type: 'transfer_between_group', fromCompanyId: PLAYER_COMPANY, toCompanyId: ALETHEIA, cashUsd: 500_000_000, acceleratorUnits: null }),
    ]);
    const downRow = down.events.find((event) => event.type === 'group_transfer_executed' && event.actorId === PLAYER_COMPANY);
    expect(downRow).toMatchObject({ actorId: PLAYER_COMPANY, targetId: ALETHEIA, payload: { kind: 'cash', amountUsd: 500_000_000 } });

    const up = resolveOne(down.nextState, [
      act(down.nextState, { type: 'transfer_between_group', fromCompanyId: ALETHEIA, toCompanyId: PLAYER_COMPANY, cashUsd: 200_000_000, acceleratorUnits: null }, { companyId: ALETHEIA }),
    ]);
    const upRow = up.events.find((event) => event.type === 'group_transfer_executed' && event.actorId === ALETHEIA);
    expect(upRow).toMatchObject({ actorId: ALETHEIA, targetId: PLAYER_COMPANY, payload: { kind: 'cash', amountUsd: 200_000_000 } });
  });

  it('is refused between two companies that do not answer to the same seat', () => {
    const next = afterAcquiringAletheia();
    const outsider = next.companies.find((company) => company.isActive && company.id !== PLAYER_COMPANY && company.id !== ALETHEIA);
    if (outsider === undefined) throw new Error('world 2 has no third company');
    const engine = createDefaultEngine();
    const outcome = engine.resolver.resolveQuarter(
      next,
      [act(next, { type: 'transfer_between_group', fromCompanyId: PLAYER_COMPANY, toCompanyId: outsider.id, cashUsd: 1_000_000, acceleratorUnits: null })],
      null,
      [],
    );
    const row = outcome.events.find((event) => event.type === 'action_rejected');
    expect(row?.payload).toMatchObject({ codes: expect.arrayContaining(['not_controller_of_company']) });
  });
});

/* -------------------------------------------------------------------------- */
/*  Majority control without a full buy                                       */
/* -------------------------------------------------------------------------- */

describe('a decisive stake bought on the exchange', () => {
  it('hands over control, and losing the majority hands it back', () => {
    const opening = withCash(createWorld2Session(), 50_000_000_000);
    const table = opening.capTables.find((entry) => entry.companyId === BASALT);
    if (table === undefined) throw new Error('no cap table for basalt');
    const issued = table.shareClasses.reduce((sum, klass) => sum + klass.issuedShares, 0);
    const decisive = Math.floor(issued * 0.55);

    const buy = resolveOne(opening, [
      act(opening, { type: 'buy_shares', securityId: BASALT_SECURITY, targetPct: null, shares: decisive, maxPricePerShareUsd: 100_000 }),
    ]);
    const afterBuy = buy.nextState;

    const boughtTable = afterBuy.capTables.find((entry) => entry.companyId === BASALT);
    const held = boughtTable?.holdings.filter((holding) => holding.holderId === PLAYER_COMPANY).reduce((sum, holding) => sum + holding.shares, 0) ?? 0;
    // The precondition for the rest of the test: the order actually cleared a
    // majority. If it did not, everything below would pass for the wrong reason.
    expect(held).toBeGreaterThan(issued / 2);
    expect(companyOf(afterBuy, BASALT).controllerPlayerId).toBe(DEMO_PLAYER_ID);
    expect(controlledCompaniesOf(afterBuy, DEMO_PLAYER_ID).map((company) => company.id)).toContain(BASALT);

    const controlEvent = buy.events.find((event) => event.type === 'control_changed' && event.actorId === BASALT);
    expect(controlEvent?.payload).toMatchObject({ toController: DEMO_PLAYER_ID });

    const sellDown = held - Math.floor(issued * 0.1);
    const sell = resolveOne(afterBuy, [
      act(afterBuy, { type: 'sell_shares', securityId: BASALT_SECURITY, shares: sellDown, minPricePerShareUsd: 0 }),
    ]);
    const afterSell = sell.nextState;

    expect(companyOf(afterSell, BASALT).controllerPlayerId).toBeNull();
    expect(controlledCompaniesOf(afterSell, DEMO_PLAYER_ID).map((company) => company.id)).not.toContain(BASALT);
  });
});

/* -------------------------------------------------------------------------- */
/*  merge_subsidiary                                                          */
/* -------------------------------------------------------------------------- */

describe('merge_subsidiary', () => {
  it('extinguishes the subsidiary and folds its books into the parent', () => {
    const next = afterAcquiringAletheia();
    const merged = resolveOne(next, [act(next, { type: 'merge_subsidiary', subsidiaryCompanyId: ALETHEIA })]).nextState;
    const husk = companyOf(merged, ALETHEIA);
    expect(husk.isActive).toBe(false);
    expect(husk.parentCompanyId).toBe(PLAYER_COMPANY);
    expect(controlledCompaniesOf(merged, DEMO_PLAYER_ID).map((company) => company.id)).toEqual([PLAYER_COMPANY]);
  });

  it('is refused for a company that is not the acting company\'s subsidiary', () => {
    const next = afterAcquiringAletheia();
    const outsider = next.companies.find((company) => company.isActive && company.id !== PLAYER_COMPANY && company.id !== ALETHEIA);
    if (outsider === undefined) throw new Error('world 2 has no third company');
    const engine = createDefaultEngine();
    const outcome = engine.resolver.resolveQuarter(next, [act(next, { type: 'merge_subsidiary', subsidiaryCompanyId: outsider.id })], null, []);
    const row = outcome.events.find((event) => event.type === 'action_rejected');
    expect(row?.payload).toMatchObject({ codes: expect.arrayContaining(['requirement_not_met']) });
  });
});

/* -------------------------------------------------------------------------- */
/*  NPC strategists                                                            */
/* -------------------------------------------------------------------------- */

describe('NPC strategist eligibility', () => {
  it('never plans for a subsidiary the player controls', () => {
    const before = strategistCompanyIds(createWorld2Session());
    expect(before).toContain(ALETHEIA);

    const next = afterAcquiringAletheia();
    const after = strategistCompanyIds(next);
    expect(after).not.toContain(ALETHEIA);
  });
});

/* -------------------------------------------------------------------------- */
/*  groupStatementOf                                                          */
/* -------------------------------------------------------------------------- */

describe('groupStatementOf', () => {
  it('reconciles across the founding company and a wholly-owned subsidiary', () => {
    const next = afterAcquiringAletheia();
    const statement = groupStatementOf(next, DEMO_PLAYER_ID);

    expect(statement.companyIds).toEqual([PLAYER_COMPANY, ALETHEIA]);
    expect(statement.quarter).not.toBeNull();
    expect(Math.abs(statement.balance.totalAssetsUsd - statement.balance.totalLiabilitiesUsd - statement.balance.equityUsd)).toBeLessThanOrEqual(5);
    expect(statement.balance.equityUsd - statement.minorityInterestUsd).toBe(statement.equityAttributableToGroupUsd);
    // 100% owned: nothing is attributable to a minority.
    expect(statement.minorityInterestUsd).toBe(0);
  });

  it('is just the founding company for a seat with nothing else', () => {
    const state = createWorld2Session();
    const statement = groupStatementOf(state, DEMO_PLAYER_ID);
    expect(statement.companyIds).toEqual([PLAYER_COMPANY]);
    expect(statement.minorityInterestUsd).toBe(0);
  });
});
