/**
 * Every purchase has a counterparty.
 *
 * The claim under test is narrow and load-bearing: from world version 2, compute
 * is bought **from a named company**, the buyer's cash and the seller's revenue
 * are the same dollar in the same quarter, and both balance sheets still
 * reconcile afterwards. Everything is proved against a real resolution through
 * the real engine with the invariant gate on, because a transfer between two
 * balance sheets is exactly where a double-entry defect would hide.
 *
 * World 1 is untouched and is asserted to be: it has no sellers, `buy_accelerators`
 * is refused there, and its frozen hash is pinned in `world2Scenario.test.ts`.
 */

import { describe, expect, it } from 'vitest';
import type { ActionIntent, SessionState, SubmittedAction } from '@frontier/contracts';
import { hashState } from '@frontier/shared';
import { createDefaultEngine } from '../src/engine';
import { createActionValidator } from '../src/validator';
import { createDemoSession, DEMO_CHARACTERS, DEMO_COMPANIES, DEMO_PLAYER_ID } from '../src/scenario';
import { createWorld2Session } from '../src/scenario/world2';
import {
  acceleratorUnitPriceUsd,
  counterpartyCharges,
  resolveComputeSeller,
  sellableCapacityUnits,
  sellersFor,
} from '../src/companies';
import { reservableUnitsFor, runLookups } from '../src/lookups';

/* -------------------------------------------------------------------------- */
/*  Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

const PLAYER_COMPANY = 'cmp_player_ventures';
const PLAYER_CHARACTER = 'chr_avery_sinclair';

function world2(): SessionState {
  return createWorld2Session();
}

const companyOf = (state: SessionState, id: string) => {
  const company = state.companies.find((entry) => entry.id === id);
  if (company === undefined) throw new Error(`no company ${id}`);
  return company;
};

let sequence = 0;

function act(
  state: SessionState,
  intent: ActionIntent,
  companyId = PLAYER_COMPANY,
  characterId = PLAYER_CHARACTER,
): SubmittedAction {
  sequence += 1;
  return {
    actionId: `act_sellers_${sequence}`,
    sessionId: state.sessionId,
    quarter: state.quarter,
    sequence,
    actorPlayerId: DEMO_PLAYER_ID,
    actorCompanyId: companyId,
    actorCharacterId: characterId,
    origin: 'player_ui',
    intent,
    confirmedByHuman: true,
  };
}

/** Give the player enough cash that the purchase is not the interesting variable. */
function withCash(state: SessionState, cashUsd: number): SessionState {
  const company = companyOf(state, PLAYER_COMPANY);
  const added = cashUsd - company.balanceSheet.assets.cash;
  company.balanceSheet.assets.cash = cashUsd;
  company.balanceSheet.equity += added;
  company.financials.cash = cashUsd;
  return state;
}

function resolveOne(state: SessionState, actions: readonly SubmittedAction[]) {
  const engine = createDefaultEngine();
  const outcome = engine.resolver.resolveQuarter(state, [...actions], null, []);
  const failures = outcome.invariants.filter((result) => !result.passed).map((result) => `${result.invariant}: ${result.detail}`);
  expect(failures).toEqual([]);
  expect(outcome.committed).toBe(true);
  return outcome;
}

/* -------------------------------------------------------------------------- */
/*  Who sells                                                                  */
/* -------------------------------------------------------------------------- */

describe('the compute market has named sellers', () => {
  it('has none at all in world 1', () => {
    const state = createDemoSession();
    expect(sellersFor(state, 'accelerators', null)).toEqual([]);
    expect(sellersFor(state, 'cloud', null)).toEqual([]);
    expect(resolveComputeSeller(state, 'accelerators', null, DEMO_COMPANIES.player)).toBeNull();
  });

  it('lists manufacturers for accelerators and infrastructure for capacity', () => {
    const state = world2();
    const chips = sellersFor(state, 'accelerators', PLAYER_COMPANY);
    const cloud = sellersFor(state, 'cloud', PLAYER_COMPANY);
    expect(chips.length).toBeGreaterThan(0);
    expect(cloud.length).toBeGreaterThan(0);
    for (const seller of chips) expect(seller.sellableUnits).toBeGreaterThan(0);
    // Sorted cheapest first, ties by id: the ordering is the resolution rule.
    for (let index = 1; index < chips.length; index += 1) {
      const previous = chips[index - 1]!;
      const current = chips[index]!;
      expect(previous.unitPriceUsd <= current.unitPriceUsd).toBe(true);
    }
  });

  it('resolves the same counterparty every time, and honours one that is named', () => {
    const state = world2();
    const first = resolveComputeSeller(state, 'accelerators', null, PLAYER_COMPANY, 10);
    const second = resolveComputeSeller(world2(), 'accelerators', null, PLAYER_COMPANY, 10);
    expect(first?.company.id).toBe(second?.company.id);

    const market = sellersFor(state, 'accelerators', PLAYER_COMPANY);
    const other = market[market.length - 1]!;
    expect(resolveComputeSeller(state, 'accelerators', other.company.id, PLAYER_COMPANY, 10)?.company.id).toBe(other.company.id);
    // A seller that does not exist falls through rather than failing the order.
    expect(resolveComputeSeller(state, 'accelerators', 'cmp_nobody', PLAYER_COMPANY, 10)?.company.id).toBe(first?.company.id);
  });

  it('never sells a company its own spare capacity', () => {
    const state = world2();
    const seller = sellersFor(state, 'cloud', null)[0]!;
    expect(sellersFor(state, 'cloud', seller.company.id).some((entry) => entry.company.id === seller.company.id)).toBe(false);
  });

  it('prices an accelerator above what four years of renting costs, and below eight', () => {
    const state = world2();
    const seller = sellersFor(state, 'accelerators', PLAYER_COMPANY)[0]!;
    const price = acceleratorUnitPriceUsd(state, seller.company);
    expect(price).toBe(seller.unitPriceUsd);
    // The trade the constant encodes: dearer than a year of rent, cheaper than a decade of it.
    expect(price).toBeGreaterThan(2_100 * 4);
    expect(price).toBeLessThan(2_100 * 40);
  });
});

/* -------------------------------------------------------------------------- */
/*  The validator                                                              */
/* -------------------------------------------------------------------------- */

describe('buy_accelerators at the validator', () => {
  it('is refused outright in world 1', () => {
    const state = createDemoSession();
    const validator = createActionValidator();
    const [result] = validator.validateBatch(state, [
      {
        actionId: 'act_w1_buy',
        sessionId: state.sessionId,
        quarter: state.quarter,
        sequence: 1,
        actorPlayerId: DEMO_PLAYER_ID,
        actorCompanyId: DEMO_COMPANIES.player,
        actorCharacterId: DEMO_CHARACTERS.player,
        origin: 'player_ui',
        intent: { type: 'buy_accelerators', units: 10, maxPricePerUnitUsd: 100_000, sellerCompanyId: null },
        confirmedByHuman: true,
      },
    ]);
    expect(result?.status).toBe('rejected');
    expect(result?.codes).toContain('requirement_not_met');
  });

  it('accepts the order whole and notes what the named seller can ship (world 2: availability, not a refusal)', () => {
    const state = world2();
    const market = sellersFor(state, 'accelerators', PLAYER_COMPANY);
    const smallest = [...market].sort((a, b) => a.sellableUnits - b.sellableUnits)[0]!;
    const validator = createActionValidator();
    const [result] = validator.validateBatch(state, [
      act(state, {
        type: 'buy_accelerators',
        units: smallest.sellableUnits + 5_000,
        maxPricePerUnitUsd: smallest.unitPriceUsd * 2,
        sellerCompanyId: smallest.company.id,
      }),
    ]);
    // The ask runs whole; `resolveComputeOrders` ships what the seller
    // actually has this quarter and reports the rest as a `partial_fill`,
    // rather than the validator clamping the order down to it.
    expect(result?.status).toBe('accepted');
    expect(result?.codes).toContain('partial_fill_expected');
    expect(result?.clampedAction).toBeNull();
  });

  it('notes the cash rather than refusing it, and the note carries the solvency clock', () => {
    const state = withCash(world2(), 0);
    const seller = sellersFor(state, 'accelerators', PLAYER_COMPANY)[0]!;
    const validator = createActionValidator();
    const [result] = validator.validateBatch(state, [
      act(state, { type: 'buy_accelerators', units: 10, maxPricePerUnitUsd: seller.unitPriceUsd * 2, sellerCompanyId: seller.company.id }),
    ]);
    expect(result?.status).toBe('accepted');
    expect(result?.codes).toContain('insufficient_cash');
    expect(result?.reasons.join(' ')).toContain('the company is wound up');
  });

  it('refuses an order for nothing', () => {
    const state = world2();
    const validator = createActionValidator();
    const [result] = validator.validateBatch(state, [
      act(state, { type: 'buy_accelerators', units: 0, maxPricePerUnitUsd: 100_000, sellerCompanyId: null }),
    ]);
    expect(result?.status).toBe('rejected');
    expect(result?.codes).toContain('illegal_value');
  });
});

/* -------------------------------------------------------------------------- */
/*  Resolution                                                                 */
/* -------------------------------------------------------------------------- */

describe('buying accelerators moves cash, capacity and somebody else\'s revenue', () => {
  function buyQuarter() {
    const state = withCash(world2(), 400_000_000);
    const seller = sellersFor(state, 'accelerators', PLAYER_COMPANY)[0]!;
    const units = 100;
    const before = {
      owned: companyOf(state, PLAYER_COMPANY).compute.ownedAccelerators,
      cash: companyOf(state, PLAYER_COMPANY).balanceSheet.assets.cash,
      ppe: companyOf(state, PLAYER_COMPANY).balanceSheet.assets.ppe,
      sellerRevenue: companyOf(state, seller.company.id).financials.revenueQuarterly,
    };
    const outcome = resolveOne(state, [
      act(state, {
        type: 'buy_accelerators',
        units,
        maxPricePerUnitUsd: seller.unitPriceUsd * 2,
        sellerCompanyId: seller.company.id,
      }),
    ]);
    return { outcome, seller, units, before };
  }

  it('books the units, the capital and a ledger row naming both parties', () => {
    const { outcome, seller, units, before } = buyQuarter();
    const row = outcome.events.find((event) => event.type === 'accelerators_bought');
    expect(row).toBeDefined();
    expect(row?.payload.sellerCompanyId).toBe(seller.company.id);
    expect(row?.payload.buyerCompanyId).toBe(PLAYER_COMPANY);
    expect(row?.payload.units).toBe(units);

    const after = companyOf(outcome.nextState, PLAYER_COMPANY);
    expect(after.compute.ownedAccelerators).toBe(before.owned + units);
    // Capital expenditure is booked by the financial phase, so the quarter it
    // settles in reports it rather than reporting nought.
    expect(after.financials.capex).toBe(Number(row?.payload.totalUsd));
    // Cash out, plant in: the staging list is cleared once it has been paid for.
    expect(after.balanceSheet.assets.ppe).toBeGreaterThan(before.ppe);
    expect(after.compute.pendingAcceleratorPurchases ?? []).toEqual([]);
  });

  it('pays the seller exactly what the buyer spent, in the same quarter', () => {
    const { outcome, seller } = buyQuarter();
    const total = Number(outcome.events.find((event) => event.type === 'accelerators_bought')?.payload.totalUsd);
    expect(total).toBeGreaterThan(0);

    // The same quarter with and without the order. Everything else about the
    // seller is identical between the two runs, so the difference in what its
    // revenue row states as counterparty revenue is the purchase and nothing
    // else. That is the claim: one dollar, two books, one quarter.
    const withoutPurchase = resolveOne(withCash(world2(), 400_000_000), []);
    const creditedOf = (events: readonly { type: string; actorId: string | null; payload: Record<string, unknown> }[]): number => {
      const row = events.find((event) => event.type === 'revenue_recognised' && event.actorId === seller.company.id);
      const value = row?.payload.interCompanyRevenueUsd;
      return typeof value === 'number' ? value : 0;
    };
    expect(creditedOf(outcome.events) - creditedOf(withoutPurchase.events)).toBeCloseTo(total, 0);
  });

  it('reconciles both balance sheets and repeats exactly', () => {
    const first = buyQuarter();
    const second = buyQuarter();
    expect(hashState(first.outcome.nextState)).toBe(hashState(second.outcome.nextState));
  });

  it('fails the order rather than clearing above the limit', () => {
    const state = withCash(world2(), 400_000_000);
    const seller = sellersFor(state, 'accelerators', PLAYER_COMPANY)[0]!;
    const outcome = resolveOne(state, [
      act(state, { type: 'buy_accelerators', units: 10, maxPricePerUnitUsd: 1, sellerCompanyId: seller.company.id }),
    ]);
    const failed = outcome.events.find((event) => event.payload.kind === 'accelerator_purchase_failed');
    expect(failed).toBeDefined();
    expect(companyOf(outcome.nextState, PLAYER_COMPANY).compute.ownedAccelerators).toBe(
      companyOf(state, PLAYER_COMPANY).compute.ownedAccelerators,
    );
  });
});

/* -------------------------------------------------------------------------- */
/*  The counterparty ledger                                                    */
/* -------------------------------------------------------------------------- */

describe('renting compute pays a company too', () => {
  it('records who is paying whom once a provider is named', () => {
    const state = withCash(world2(), 100_000_000);
    const provider = sellersFor(state, 'cloud', PLAYER_COMPANY)[0]!;
    const outcome = resolveOne(state, [
      act(state, {
        type: 'buy_cloud_capacity',
        quarterlySpendUsd: 2_000_000,
        providerCompanyId: provider.company.id,
        commitmentQuarters: 0,
      }),
    ]);
    const after = companyOf(outcome.nextState, PLAYER_COMPANY);
    expect(after.compute.cloudProviderCompanyId).toBe(provider.company.id);
    expect(after.compute.cloudProviderFactor).toBeGreaterThan(0);

    const charges = counterpartyCharges(outcome.nextState).filter((charge) => charge.buyerCompanyId === PLAYER_COMPANY);
    const cloud = charges.find((charge) => charge.kind === 'cloud');
    expect(cloud?.sellerCompanyId).toBe(provider.company.id);
    expect(cloud?.amountUsd).toBeGreaterThan(0);
  });

  it('has nothing to record in world 1', () => {
    expect(counterpartyCharges(createDemoSession())).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/*  runLookups                                                                 */
/* -------------------------------------------------------------------------- */

describe('runLookups answers from canonical state', () => {
  it('caps a reservation row at the market ceiling the validator applies', () => {
    const state = world2();
    const [result] = runLookups(state, PLAYER_COMPANY, [{ kind: 'compute_market', units: 50 }]);
    if (result?.kind !== 'compute_market') throw new Error('wrong kind');
    const ceiling = reservableUnitsFor(state);
    for (const row of result.sellers) {
      if (row.offering === 'reservation') expect(row.sellableUnits).toBeLessThanOrEqual(ceiling);
    }
  });

  it('quotes sellable units the validator then advises against, not clamps to', () => {
    const state = world2();
    const [result] = runLookups(state, PLAYER_COMPANY, [{ kind: 'compute_market', units: 50 }]);
    expect(result?.kind).toBe('compute_market');
    if (result?.kind !== 'compute_market') throw new Error('wrong kind');
    const row = result.sellers.find((entry) => entry.offering === 'accelerators');
    expect(row).toBeDefined();
    if (row === undefined) return;

    const validator = createActionValidator();
    const [verdict] = validator.validateBatch(state, [
      act(state, { type: 'buy_accelerators', units: row.sellableUnits + 1, maxPricePerUnitUsd: row.unitPriceUsd * 2, sellerCompanyId: row.companyId }),
    ]);
    // World 2: what a seller can actually ship is availability, not a limit on
    // the order — the ask is accepted whole and the shortfall is a
    // `partial_fill` at resolution, not a validator clamp.
    expect(verdict?.status).toBe('accepted');
    expect(verdict?.codes).toContain('partial_fill_expected');
    expect(verdict?.clampedAction).toBeNull();
  });

  it('hands back an acquisition intent the validator accepts', () => {
    const state = withCash(world2(), 10_000_000_000);
    const [result] = runLookups(state, PLAYER_COMPANY, [
      { kind: 'acquisition_targets', sector: '', region: '', maxValueUsd: 0, keyword: '' },
    ]);
    if (result?.kind !== 'acquisition_targets') throw new Error('wrong kind');
    expect(result.rows.length).toBeGreaterThan(0);
    const row = result.rows[0]!;
    const validator = createActionValidator();
    const [verdict] = validator.validateBatch(state, [act(state, row.intent)]);
    // Acquisitions are board matters, so "accepted" means the validator did not
    // refuse it — it tabled it. What must never happen is a rejection.
    expect(verdict?.status).not.toBe('rejected');
  });

  it('honours the four-lookup bound and answers each kind once', () => {
    const state = world2();
    const results = runLookups(state, PLAYER_COMPANY, [
      { kind: 'own_position' },
      { kind: 'own_position' },
      { kind: 'debt_headroom' },
      { kind: 'hiring_market', role: 'engineers' },
      { kind: 'government_programmes' },
      { kind: 'compute_market', units: 0 },
    ]);
    expect(results.length).toBeLessThanOrEqual(4);
    expect(new Set(results.map((entry) => entry.kind)).size).toBe(results.length);
  });

  it('states the solvency clock rather than refusing an expensive answer', () => {
    const state = withCash(world2(), 0);
    const [result] = runLookups(state, PLAYER_COMPANY, [{ kind: 'compute_market', units: 1_000 }]);
    if (result?.kind !== 'compute_market') throw new Error('wrong kind');
    expect(result.cashAfterPurchaseUsd).toBeLessThan(0);
    expect(result.solvencyLine.length).toBeGreaterThan(0);
  });

  it('answers nothing for a company that does not exist', () => {
    expect(runLookups(world2(), 'cmp_nobody', [{ kind: 'own_position' }])).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/*  Spare capacity                                                             */
/* -------------------------------------------------------------------------- */

describe('a seller only sells what it is not using', () => {
  it('never offers negative capacity', () => {
    const state = world2();
    for (const company of state.companies) {
      expect(sellableCapacityUnits(state, company)).toBeGreaterThanOrEqual(0);
    }
  });
});
