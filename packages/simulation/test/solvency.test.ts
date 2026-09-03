/**
 * Solvency: the world-2 rule that replaced "you cannot afford that".
 *
 * Two owner rules are under test here and nothing else:
 *
 * 1. **Cash never refuses a decision.** From world version 2 the validator
 *    reserves what an action commits and *notes* where the balance lands. It
 *    does not reject and it does not clamp. World 1 keeps every clamp it had.
 * 2. **Bankruptcy is two straight quarters below zero.** For the player's
 *    company and for a bot, identically. One quarter is a warning; two is
 *    administration; a quarter back above zero in between resets the count.
 *
 * Everything in between — the overdraft charge, the player/bot bridge asymmetry,
 * the fact that a negative close still reconciles — is proved against a real
 * resolution through the real engine with the invariant gate on, because a
 * balance sheet that goes negative is exactly where a double-entry defect would
 * hide.
 */

import { describe, expect, it } from 'vitest';
import type { ActionIntent, SessionState, SimEvent, SubmittedAction } from '@frontier/contracts';
import { SessionStateSchema } from '@frontier/contracts';
import { createDefaultEngine } from '../src/engine';
import { createActionValidator } from '../src/validator';
import { DEMO_CHARACTERS, DEMO_COMPANIES, DEMO_PLAYER_ID, createDemoSession, demoSessionInput } from '../src/scenario';
import {
  OVERDRAFT_SPREAD,
  SOLVENCY_NEGATIVE_QUARTERS,
  negativeCashQuarters,
  overdraftChargeUsd,
  solvencyLine,
} from '../src/companies';

/* -------------------------------------------------------------------------- */
/*  Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

const SECTOR_BY_INDEX = ['ai', 'robotics', 'manufacturing', 'energy', 'logistics', 'consumer'] as const;

/** The same multi-sector fixture the financial-history suite uses, so the two agree. */
function world2Session(): SessionState {
  const input = demoSessionInput(424242);
  const companies = input.companies ?? [];
  return SessionStateSchema.parse({
    ...input,
    config: { ...input.config, worldVersion: 2 },
    companies: companies.map((company, index) => ({
      ...company,
      sector: SECTOR_BY_INDEX[index % SECTOR_BY_INDEX.length],
      fundamentals: {
        revenueTtmUsd: Math.max(0, company.financials.revenueQuarterly) * 4,
        revenueGrowthQoQ: 0.04,
        revenueGrowthYoY: 0.18,
        grossMarginPct: 0.55,
        netIncomeTtmUsd: 0,
        sharesOutstanding: 10_000_000,
      },
    })),
  });
}

const companyOf = (state: SessionState, id: string) => {
  const company = state.companies.find((candidate) => candidate.id === id);
  if (company === undefined) throw new Error(`no company ${id}`);
  return company;
};

/**
 * Put a company on a path to a negative close: no products to sell, no
 * receivables to collect, and `cashUsd` on hand against a payroll it still owes.
 * The wage bill is what takes it under, which is the ordinary way a company runs
 * out of money.
 */
function starve(state: SessionState, companyId: string, cashUsd: number): SessionState {
  return SessionStateSchema.parse({
    ...state,
    companies: state.companies.map((company) => {
      if (company.id !== companyId) return company;
      const sheet = company.balanceSheet;
      const assets = { ...sheet.assets, cash: cashUsd, receivables: 0, goodwill: 0, investments: 0 };
      const liabilities = { ...sheet.liabilities, payables: 0, deferredRevenue: 0, debt: 0 };
      const equity =
        assets.cash + assets.ppe + assets.goodwill + assets.investments + assets.receivables - liabilities.debt - liabilities.payables - liabilities.deferredRevenue;
      return {
        ...company,
        products: company.products.map((product) => ({ ...product, isActive: false, activeCustomers: 0 })),
        balanceSheet: { assets, liabilities, equity },
        financials: { ...company.financials, cash: cashUsd, revenueQuarterly: 0, debt: 0, deferredRevenue: 0, backlogUsd: 0 },
      };
    }),
  });
}

/** Resolve one quarter through the whole engine, gate on. */
function step(state: SessionState): { state: SessionState; events: readonly SimEvent[] } {
  const engine = createDefaultEngine();
  const outcome = engine.resolver.resolveQuarter(state, [], null, []);
  const failures = outcome.invariants.filter((result) => !result.passed).map((result) => `${result.invariant}: ${result.detail}`);
  expect(failures).toEqual([]);
  expect(outcome.committed).toBe(true);
  return { state: outcome.nextState, events: outcome.events };
}

const resolve = (state: SessionState): SessionState => step(state).state;

/** Every row the quarter emitted for one company. */
const rowsFor = (events: readonly SimEvent[], companyId: string): readonly SimEvent[] => events.filter((event) => event.actorId === companyId);

/** Top the company back up so the next close lands above zero. */
function refill(state: SessionState, companyId: string, cashUsd: number): SessionState {
  return SessionStateSchema.parse({
    ...state,
    companies: state.companies.map((company) => {
      if (company.id !== companyId) return company;
      const added = cashUsd - company.balanceSheet.assets.cash;
      return {
        ...company,
        balanceSheet: {
          ...company.balanceSheet,
          assets: { ...company.balanceSheet.assets, cash: cashUsd },
          // Matched entry, so the sheet still reconciles into the next quarter.
          equity: company.balanceSheet.equity + added,
        },
        financials: { ...company.financials, cash: cashUsd },
      };
    }),
  });
}

/* -------------------------------------------------------------------------- */
/*  Harness for the validator                                                  */
/* -------------------------------------------------------------------------- */

let sequence = 0;

function act(state: SessionState, intent: ActionIntent, companyId = DEMO_COMPANIES.player): SubmittedAction {
  sequence += 1;
  return {
    actionId: `act_solvency_${sequence}`,
    sessionId: state.sessionId,
    quarter: state.quarter,
    sequence,
    actorPlayerId: DEMO_PLAYER_ID,
    actorCompanyId: companyId,
    actorCharacterId: DEMO_CHARACTERS.player,
    origin: 'player_ui',
    intent,
    confirmedByHuman: true,
  };
}

/* -------------------------------------------------------------------------- */
/*  The validator                                                              */
/* -------------------------------------------------------------------------- */

describe('cash never refuses a decision (world 2)', () => {
  it('accepts a batch that overspends whole, with a note on every action that took it below zero', () => {
    const state = world2Session();
    const cash = companyOf(state, DEMO_COMPANIES.player).financials.cash;
    expect(cash).toBeGreaterThan(0);

    const validator = createActionValidator();
    const results = validator.validateBatch(state, [
      act(state, { type: 'set_research_budget', budgetUsd: cash }),
      act(state, { type: 'buy_cloud_capacity', quarterlySpendUsd: cash, providerCompanyId: null, commitmentQuarters: 0 }),
    ]);

    // The first fits exactly; the second is entirely on the overdraft.
    expect(results[0]?.status).toBe('accepted');
    expect(results[0]?.codes).not.toContain('insufficient_cash');
    expect(results[1]?.status).toBe('accepted');
    expect(results[1]?.codes).toContain('insufficient_cash');
    expect(results[1]?.clampedAction).toBeNull();
    expect(results[1]?.reasons.join(' ')).toContain('Takes cash from');
    expect(results[1]?.reasons.join(' ')).toContain('the company is wound up');
  });

  it('still reserves what it committed, so a third action sees the whole overdraft', () => {
    const state = world2Session();
    const cash = companyOf(state, DEMO_COMPANIES.player).financials.cash;
    const validator = createActionValidator();
    const results = validator.validateBatch(state, [
      act(state, { type: 'set_research_budget', budgetUsd: cash * 2 }),
      act(state, { type: 'buy_cloud_capacity', quarterlySpendUsd: cash, providerCompanyId: null, commitmentQuarters: 0 }),
    ]);

    // The budget's note starts from the cash on hand; the cloud spend's note
    // starts from what the budget left, which is already below zero.
    const first = results[0]?.reasons.join(' ') ?? '';
    const second = results[1]?.reasons.join(' ') ?? '';
    expect(first).toContain('Takes cash from');
    expect(second).toContain('Takes cash from -$');
    expect(results.every((result) => result.status === 'accepted')).toBe(true);
  });

  it('refuses nothing for cash across the whole cash-spending surface', () => {
    const state = starve(world2Session(), DEMO_COMPANIES.player, 0);
    const validator = createActionValidator();
    const intents: ActionIntent[] = [
      { type: 'set_research_budget', budgetUsd: 40_000_000 },
      { type: 'set_marketing_budget', allocations: [{ segment: 'enterprise', budgetUsd: 25_000_000 }] },
      { type: 'marketing_campaign', theme: 'brand', segment: 'enterprise', budgetUsd: 20_000_000, quarters: 2 },
      { type: 'hire', role: 'engineers', count: 40, compBand: 'top_of_market' },
      { type: 'buy_cloud_capacity', quarterlySpendUsd: 12_000_000, providerCompanyId: null, commitmentQuarters: 0 },
      { type: 'reserve_compute', units: 2_000, quarters: 4, maxPricePerUnitUsd: 4_000, providerCompanyId: null },
    ];
    const results = validator.validateBatch(
      state,
      intents.map((intent) => act(state, intent)),
    );
    for (const [index, result] of results.entries()) {
      expect(result.status, `${intents[index]?.type} was ${result.status}`).toBe('accepted');
      expect(result.codes).toContain('insufficient_cash');
    }
  });

  it('still rejects and clamps for reasons that are not cash', () => {
    const state = starve(world2Session(), DEMO_COMPANIES.player, 0);
    const validator = createActionValidator();
    const results = validator.validateBatch(state, [
      act(state, { type: 'start_research_project', targetNodeId: 'not_a_node', researchersAssigned: 2, computeUnits: 10, budgetUsd: 10_000_000, secret: false }),
      act(state, { type: 'layoff', role: 'sales', count: 9_999, severanceQuartersOfPay: 1 }),
    ]);
    expect(results[0]?.status).toBe('rejected');
    expect(results[0]?.codes).toContain('unknown_target');
    expect(results[1]?.status).toBe('clamped');
    expect(results[1]?.codes).toContain('insufficient_headcount');
  });
});

describe('world 1 keeps every cash clamp it had', () => {
  it('clamps a research budget to the cash on hand and rejects what nothing covers', () => {
    const state = createDemoSession();
    const cash = companyOf(state, DEMO_COMPANIES.player).financials.cash;
    const validator = createActionValidator();
    const results = validator.validateBatch(state, [
      act(state, { type: 'set_research_budget', budgetUsd: cash * 3 }),
      act(state, { type: 'buy_cloud_capacity', quarterlySpendUsd: 5_000_000, providerCompanyId: null, commitmentQuarters: 0 }),
    ]);
    expect(results[0]?.status).toBe('clamped');
    expect(results[0]?.codes).toContain('insufficient_cash');
    expect((results[0]?.clampedAction as { budgetUsd: number } | null)?.budgetUsd).toBe(cash);
    // The first took every dollar, so nothing is left for the second.
    expect(results[1]?.status).toBe('rejected');
    expect(results[1]?.codes).toContain('insufficient_cash');
  });
});

/* -------------------------------------------------------------------------- */
/*  The financial phase                                                        */
/* -------------------------------------------------------------------------- */

describe('a quarter that closes below zero', () => {
  it('closes negative, reconciles, and dumps nothing into payables', () => {
    const opening = starve(world2Session(), DEMO_COMPANIES.player, 250_000);
    const openingPayables = companyOf(opening, DEMO_COMPANIES.player).balanceSheet.liabilities.payables;
    const state = resolve(opening);
    const company = companyOf(state, DEMO_COMPANIES.player);

    expect(company.financials.cash).toBeLessThan(0);
    expect(company.balanceSheet.assets.cash).toBe(company.financials.cash);
    // World 1 would have floored the cash and financed the gap through payables.
    // Ordinary trade credit on the quarter's cash cost of goods is all that is
    // left here, and it is nowhere near the size of the overdraft.
    expect(company.balanceSheet.liabilities.payables).toBeLessThan(-company.financials.cash);
    expect(openingPayables).toBe(0);
    expect(company.posture).toBe('survival');

    const filed = company.financialHistory?.[company.financialHistory.length - 1];
    expect(filed?.balance.cashUsd).toBe(company.financials.cash);
    expect(negativeCashQuarters(company)).toBe(1);
  });

  it('charges the overdraft at the policy rate plus the spread, on the opening balance', () => {
    const overdraft = -20_000_000;
    const opening = starve(world2Session(), DEMO_COMPANIES.player, overdraft);
    const { state, events } = step(opening);
    // The macro phase drifts the rate before the financial phase charges it, so
    // the rate that priced the overdraft is the one on the resolved world.
    const policyRate = state.world.macro.policyRate;

    const row = rowsFor(events, DEMO_COMPANIES.player).find(
      (event) => event.type === 'cost_recognised' && event.payload['kind'] === 'overdraft_interest',
    );
    expect(row).toBeDefined();
    const expected = Math.round(overdraftChargeUsd(overdraft, policyRate) * 100) / 100;
    expect(row?.payload['chargeUsd']).toBe(expected);
    expect(expected).toBeCloseTo((20_000_000 * (policyRate + OVERDRAFT_SPREAD)) / 4, 2);

    // And it is inside the quarter's interest, so the gate explains it.
    expect(companyOf(state, DEMO_COMPANIES.player).financials.interestExpense).toBeGreaterThanOrEqual(expected);
  });

  it('warns after the first negative close and does not wind the company up', () => {
    const { state, events } = step(starve(world2Session(), DEMO_COMPANIES.player, 250_000));
    const company = companyOf(state, DEMO_COMPANIES.player);
    const rows = rowsFor(events, DEMO_COMPANIES.player);

    expect(negativeCashQuarters(company)).toBe(1);
    expect(company.employees.engineers + company.employees.researchers + company.employees.sales + company.employees.ops + company.employees.execs).toBeGreaterThan(0);

    const warning = rows.find((event) => event.type === 'information_revealed' && event.payload['kind'] === 'solvency_warning');
    expect(warning).toBeDefined();
    expect(warning?.payload['negativeCashQuarters']).toBe(1);
    expect(rows.some((event) => event.payload['kind'] === 'administration')).toBe(false);
  });
});

describe('bankruptcy is two straight quarters below zero', () => {
  it('winds the company up on the second consecutive negative close, naming the cause', () => {
    const first = resolve(starve(world2Session(), DEMO_COMPANIES.player, 250_000));
    expect(negativeCashQuarters(companyOf(first, DEMO_COMPANIES.player))).toBe(1);

    const { state, events } = step(first);
    const company = companyOf(state, DEMO_COMPANIES.player);
    const administration = rowsFor(events, DEMO_COMPANIES.player).find(
      (event) => event.type === 'information_revealed' && event.payload['kind'] === 'administration',
    );
    expect(administration).toBeDefined();
    expect(administration?.payload['cause']).toBe('insolvent');
    expect(administration?.payload['causeDetail']).toBe(`${SOLVENCY_NEGATIVE_QUARTERS} quarters of negative cash`);

    // Wound up: no staff, no live product.
    expect(company.employees.engineers + company.employees.researchers + company.employees.sales + company.employees.ops + company.employees.execs).toBe(0);
    expect(company.products.some((product) => product.isActive)).toBe(false);
  });

  it('resets the count when a quarter closes back above zero', () => {
    let state = resolve(starve(world2Session(), DEMO_COMPANIES.player, 250_000));
    expect(negativeCashQuarters(companyOf(state, DEMO_COMPANIES.player))).toBe(1);

    // A raise, a sale, a cut — however it happened, the company is solvent again.
    state = resolve(refill(state, DEMO_COMPANIES.player, 400_000_000));
    expect(companyOf(state, DEMO_COMPANIES.player).financials.cash).toBeGreaterThan(0);
    expect(negativeCashQuarters(companyOf(state, DEMO_COMPANIES.player))).toBe(0);

    // Down again: this is the first quarter of a new run, not the second of the old one.
    const last = step(refill(state, DEMO_COMPANIES.player, 250_000));
    const company = companyOf(last.state, DEMO_COMPANIES.player);
    expect(company.financials.cash).toBeLessThan(0);
    expect(negativeCashQuarters(company)).toBe(1);
    expect(rowsFor(last.events, DEMO_COMPANIES.player).some((event) => event.payload['kind'] === 'administration')).toBe(false);
  });
});

describe('the bridge asymmetry', () => {
  it('never bridges a player-controlled company, and always offers one to a bot', () => {
    const player = DEMO_COMPANIES.player;
    const bot = DEMO_COMPANIES.helix;

    const playerState = resolve(starve(world2Session(), player, 250_000));
    expect(companyOf(playerState, player).financials.cash).toBeLessThan(0);
    expect(playerState.fundingRounds.some((round) => round.companyId === player && round.stage === 'bridge')).toBe(false);

    const botState = resolve(starve(world2Session(), bot, 250_000));
    expect(companyOf(botState, bot).controllerPlayerId).toBeNull();
    expect(companyOf(botState, bot).financials.cash).toBeLessThan(0);
    expect(botState.fundingRounds.some((round) => round.companyId === bot && round.stage === 'bridge')).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/*  The line every cash preview prints                                         */
/* -------------------------------------------------------------------------- */

describe('solvencyLine', () => {
  it('says nothing while the balance stays at or above zero', () => {
    expect(solvencyLine(0, 1)).toBeNull();
    expect(solvencyLine(0, 0)).toBeNull();
    expect(solvencyLine(1, 5_000_000)).toBeNull();
  });

  it('names the first quarter, then counts down to the wind-up', () => {
    expect(solvencyLine(0, -1)).toContain('First quarter below zero');
    expect(solvencyLine(1, -1)).toBe(`1 of ${SOLVENCY_NEGATIVE_QUARTERS} quarters below zero — end this one below zero and the company is wound up.`);
    expect(solvencyLine(2, -1)).toContain(`2 of ${SOLVENCY_NEGATIVE_QUARTERS}`);
  });
});
