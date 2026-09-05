/**
 * @frontier/simulation — the world-3 repairs.
 *
 * Seven claims, each of which was false in the tree before this file existed
 * and each of which is checked against a real resolved world rather than
 * against a fixture:
 *
 * 1. **One number for cost.** The profit and loss books the roll-up. Not a
 *    capped version of it, not a cousin of it: what the Products screen prints
 *    as `unitCostUsd` times what the line shipped, to the cent, plus exactly
 *    the one named extra the cost row states — a logistics toll — and the
 *    gross margin on the income statement agrees with the gross margin on the
 *    line.
 * 2. **An order book is bounded by what the company could build.** Not by the
 *    world's whole appetite.
 * 3. **Quality is written every quarter.** A line's `qualityScore` is what the
 *    line is worth now, not what it was worth the quarter it launched.
 * 4. **Customer data accrues and bites.** A stock that rounds to nothing is not
 *    a mechanism, and neither is an uplift measured against a half-point three
 *    orders of magnitude above anything in the world.
 * 5. **Lines track their node's market price.** A company nobody is directing
 *    closes the gap to the price its own node settled at.
 * 6. **No background is insolvent on autopilot.** Fifteen backgrounds, no
 *    actions, SIXTEEN quarters — and the claim is that each is still *trading*:
 *    not in administration, still holding a live line, still selling, and not
 *    multiplying its opening capital out of all proportion. Eight quarters and
 *    an `isActive` flag proved none of that: four backgrounds died between
 *    quarter ten and quarter thirteen while both of the tests here passed.
 * 7. **A session stops growing.** The per-company statement series and the
 *    public record are both bounded, so the cost of a quarter stops climbing.
 *
 * Every run below takes no actions at all: the claim in each case is about what
 * the engine does to a player who does nothing, which is the only baseline a
 * balance claim can be made against.
 */

import { describe, expect, it } from 'vitest';
import {
  FINANCIAL_HISTORY_KEPT_QUARTERS,
  NEW_GAME_BACKGROUNDS,
  NewGameSetupSchema,
  SECTOR_BACKGROUNDS,
  economicNodeById,
  nodeMarketPriceUsd,
  type Company,
  type NewGameBackground,
  type SessionState,
} from '@frontier/contracts';
import { createDefaultEngine } from '../src/engine';
import { createWorld3Session, W3_DEFAULT_SETUP } from '../src/scenario/world3';
import { W2_COMPANIES } from '../src/scenario/world2';
import { ORDER_BOOK_QUARTERS, createNodeCostCache, dataQualityUplift, lineNodeIdOf, nodeBalances, producibleUnits, totalDataPetabytes, unitCostOf } from '../src/graph';
import { isWoundUp } from '../src/companies/distress';
import { regionalCompUsd } from '../src/companies/hiring';
import { NODE_DISCRETIONARY_GROSS_PROFIT_SHARE } from '../src/companies/policy';

/** The staff roles a wage bill is summed over, in `Company.employees`'s own order. */
const W3_STAFF_ROLES = ['engineers', 'researchers', 'sales', 'ops', 'execs'] as const;

import { NPC_PRICE_TRACKING } from '../src/companies';
import { DISCLOSURE_WINDOW_QUARTERS } from '../src/resolver';

const BACKGROUNDS: readonly NewGameBackground[] = [...NEW_GAME_BACKGROUNDS, ...SECTOR_BACKGROUNDS];

function sessionFor(background: NewGameBackground): SessionState {
  return createWorld3Session(
    424242,
    NewGameSetupSchema.parse({ ...W3_DEFAULT_SETUP, backgroundId: background.id, sector: background.sector }),
  );
}

/** Resolve `quarters` quarters with no actions at all, keeping every intermediate state. */
function run(state: SessionState, quarters: number): readonly SessionState[] {
  const engine = createDefaultEngine();
  const states: SessionState[] = [state];
  let current = state;
  for (let i = 0; i < quarters; i += 1) {
    current = engine.resolver.resolveQuarter(current, [], null, []).nextState;
    states.push(current);
  }
  return states;
}

const playerOf = (state: SessionState): Company => {
  const company = state.companies.find((candidate) => candidate.id === W2_COMPANIES.player);
  if (company === undefined) throw new Error('the player company is missing');
  return company;
};

/* -------------------------------------------------------------------------- */
/*  1. Cost of goods is the roll-up                                            */
/* -------------------------------------------------------------------------- */

describe('cost of goods in the node economy', () => {
  it('is the roll-up itself, to the cent, plus exactly the named extras the row carries', { timeout: 120_000 }, () => {
    const engine = createDefaultEngine();
    let state = sessionFor(BACKGROUNDS[1] as NewGameBackground);
    let checked = 0;

    for (let quarter = 0; quarter < 8; quarter += 1) {
      const outcome = engine.resolver.resolveQuarter(state, [], null, []);
      state = outcome.nextState;
      for (const company of state.companies) {
        if (!company.isActive) continue;
        // Government contract revenue carries its own support share and a
        // compliance charge, and a logistics toll is a charge another company
        // levies: the first two are excluded by skipping the primes, the third
        // is read off the row itself.
        const hasContract = state.governmentContracts.some((contract) => contract.primeCompanyId === company.id && contract.status === 'active');
        if (hasContract) continue;
        const lines = company.products.filter((product) => product.isActive && lineNodeIdOf(product) !== null);
        if (lines.length === 0 || lines.length !== company.products.filter((product) => product.isActive).length) continue;

        let rollUpUsd = 0;
        for (const product of lines) rollUpUsd += Math.max(0, product.unitsSoldQuarterly ?? 0) * (product.unitCostUsd ?? 0);
        if (rollUpUsd <= 0) continue;

        const row = outcome.events.find((event) => event.type === 'cost_recognised' && event.actorId === company.id && typeof event.payload.nodeCogsUsd === 'number');
        expect(row, `${company.id} booked no cost row`).toBeDefined();
        if (row === undefined) continue;
        // THE IDENTITY. What the lines stamped is what the row books as the
        // roll-up, to the cent: the wedge this test exists for was a line whose
        // roll-up was $7.3M against a booked $2.1M.
        expect(Math.abs((row.payload.nodeCogsUsd as number) - rollUpUsd), `${company.id} booked a roll-up other than its lines'`).toBeLessThan(0.01 * (lines.length + 1));
        // And cost of goods is that roll-up plus exactly one named extra — the
        // logistics toll the row itself states; a node line's support share is
        // already a line of its roll-up — never a third opinion about cost.
        // Before this was pinned the test tolerated thirty-five percent of
        // unexplained extras.
        const tollUsd = (row.payload.logisticsTollUsd as number | undefined) ?? 0;
        expect(Math.abs(company.financials.cogs - (rollUpUsd + tollUsd)), `${company.id} books an extra beside the roll-up and the toll`).toBeLessThan(0.01 * (lines.length + 3));
        checked += 1;
      }
    }

    expect(checked, 'no company was in a position to state the identity').toBeGreaterThan(20);
  });

  it('leaves the income statement and the line agreeing about gross margin', { timeout: 120_000 }, () => {
    const states = run(sessionFor(BACKGROUNDS[9] as NewGameBackground), 8);
    let checked = 0;

    for (const state of states.slice(1)) {
      const company = playerOf(state);
      const product = company.products[0];
      const revenue = company.financials.revenueQuarterly;
      if (product === undefined || revenue <= 0 || company.financials.cogs <= 0) continue;
      // A government contract prime recognises milestone revenue the line knows
      // nothing about, so the two margins are only comparable without one.
      if (state.governmentContracts.some((contract) => contract.primeCompanyId === company.id && contract.status === 'active')) continue;

      const statementMargin = (revenue - company.financials.cogs) / revenue;
      expect(Math.abs(statementMargin - product.grossMarginPct), `quarter ${state.quarter}`).toBeLessThan(0.1);
      checked += 1;
    }

    expect(checked).toBeGreaterThan(0);
  });
});

/* -------------------------------------------------------------------------- */
/*  2. The order book                                                          */
/* -------------------------------------------------------------------------- */

describe('a line\'s order book', () => {
  it('is bounded by what the company could build in a year, on every line in the world', { timeout: 120_000 }, () => {
    let seen = 0;
    for (const background of [BACKGROUNDS[11], BACKGROUNDS[12], BACKGROUNDS[7]] as NewGameBackground[]) {
      for (const state of run(sessionFor(background), 6).slice(1)) {
        for (const company of state.companies) {
          for (const product of company.products) {
            const backlog = product.backlogUnits ?? 0;
            if (backlog <= 0) continue;
            const units = Math.max(0, product.unitsSoldQuarterly ?? 0);
            // Orders are capped at `ORDER_BOOK_QUARTERS` times what the line can
            // make, and what shipped is what it could make, so the unfilled
            // remainder can never exceed one year less this quarter's delivery.
            // Before the bound a courier shipping 285,714 parcels carried an
            // order book of twenty-five billion.
            expect(backlog, `${company.id}/${product.id} carries an order book it could never work through`).toBeLessThanOrEqual(
              Math.max(1, units) * ORDER_BOOK_QUARTERS,
            );
            seen += 1;
          }
        }
      }
    }
    expect(seen, 'no line carried a backlog at all').toBeGreaterThan(10);
  });
});

/* -------------------------------------------------------------------------- */
/*  3. Quality is written                                                      */
/* -------------------------------------------------------------------------- */

describe('a line\'s quality', () => {
  it('is rewritten every quarter rather than pinned at what it launched with', { timeout: 120_000 }, () => {
    const states = run(sessionFor(BACKGROUNDS[1] as NewGameBackground), 8);
    const scores = states.slice(1).map((state) => playerOf(state).products[0]?.qualityScore ?? -1);

    expect(scores.every((score) => score >= 0)).toBe(true);
    // It moves. World 2 held `qualityScore` at exactly its launch value for the
    // life of the line while `craftQuality` decayed underneath it.
    expect(new Set(scores.map((score) => score.toFixed(4))).size).toBeGreaterThan(1);

    // And it is the quality demand was actually built from, which decays when
    // nothing is done about it.
    const first = scores[0] ?? 0;
    const last = scores[scores.length - 1] ?? 0;
    expect(last).toBeLessThan(first);
  });

  it('never ratchets its own craft: the decay reads craft, and quality is written from craft', { timeout: 120_000 }, () => {
    const states = run(sessionFor(BACKGROUNDS[5] as NewGameBackground), 6);
    let previousCraft = Number.POSITIVE_INFINITY;
    for (const state of states.slice(1)) {
      const craft = playerOf(state).products[0]?.craftQuality ?? 0;
      expect(craft).toBeLessThan(previousCraft);
      previousCraft = craft;
    }
  });
});

/* -------------------------------------------------------------------------- */
/*  4. Customer data                                                           */
/* -------------------------------------------------------------------------- */

describe('customer data', () => {
  it('accrues for the background the game opens on, rather than rounding to nothing forever', { timeout: 120_000 }, () => {
    const states = run(sessionFor(BACKGROUNDS[1] as NewGameBackground), 8);
    const stocks = states.slice(1).map((state) => totalDataPetabytes(playerOf(state)));

    for (const stock of stocks) expect(stock).toBeGreaterThan(0);
    // It grows while the line is serving customers: the quantisation used to
    // floor every quarter's collection to zero for a line this size.
    expect(stocks[stocks.length - 1] ?? 0).toBeGreaterThan(stocks[0] ?? 0);
  });

  it('buys a measurable quality uplift for a line that collects at scale', { timeout: 120_000 }, () => {
    const states = run(sessionFor(BACKGROUNDS[2] as NewGameBackground), 12);
    const last = states[states.length - 1] as SessionState;
    const company = playerOf(last);
    // Pooled by the node's sector, which is where the line's customers are.
    let uplift = 0;
    for (const asset of company.dataAssets ?? []) uplift = Math.max(uplift, dataQualityUplift(company, asset.sector));

    // Against a four-hundred-petabyte half-point this was 0.00000000 for every
    // background the game ships.
    expect(uplift).toBeGreaterThan(0.01);
  });
});

/* -------------------------------------------------------------------------- */
/*  5. Lines track the node market                                             */
/* -------------------------------------------------------------------------- */

/** A twentieth: what a third of the gap a quarter leaves after seven quarters. */
const PRICE_TRACKING_RESIDUAL = 0.05;

describe('a company nobody is directing', () => {
  it('closes the gap between what it charges and what its node settled at', { timeout: 120_000 }, () => {
    const states = run(sessionFor(BACKGROUNDS[1] as NewGameBackground), 8);
    let closed = 0;
    let seen = 0;

    const openingGaps = new Map<string, number>();
    for (const state of states) {
      for (const company of state.companies) {
        if (company.controllerPlayerId !== null || !company.isActive) continue;
        const product = company.products[0];
        const nodeId = product === undefined ? null : lineNodeIdOf(product);
        if (product === undefined || nodeId === null || product.pricePerSeat <= 0) continue;
        const gap = Math.abs(nodeMarketPriceUsd(state, nodeId) - product.pricePerSeat) / product.pricePerSeat;
        const opening = openingGaps.get(company.id);
        if (opening === undefined) {
          openingGaps.set(company.id, gap);
          continue;
        }
        if (state === states[states.length - 1]) {
          seen += 1;
          // A third of the gap a quarter over seven quarters leaves a twentieth
          // of it; anything inside that residual is tracking. CHANGED
          // DELIBERATELY, slots: a line asked at exactly its node's base price
          // opens with NO gap, and once the index moves it can never be "not
          // widened" however closely it follows — ten of the twenty-four seeded
          // rivals open that way — so the residual the comment always claimed
          // is what is measured.
          if (gap <= Math.max(opening, PRICE_TRACKING_RESIDUAL) + 1e-9) closed += 1;
        }
      }
    }

    expect(seen).toBeGreaterThan(10);
    expect(closed / seen, 'most rivals should be no further from their node price than they started').toBeGreaterThan(0.6);
    expect(NPC_PRICE_TRACKING).toBeGreaterThan(0);
  });

  it('still never sells under its own cost floor', { timeout: 120_000 }, () => {
    const last = run(sessionFor(BACKGROUNDS[7] as NewGameBackground), 6).at(-1) as SessionState;
    const cache = createNodeCostCache(last);
    for (const company of last.companies) {
      if (company.controllerPlayerId !== null || !company.isActive) continue;
      for (const product of company.products) {
        const nodeId = lineNodeIdOf(product);
        if (nodeId === null || !product.isActive) continue;
        const unitCostUsd = unitCostOf(last, company, nodeId, cache).unitCostUsd;
        if (unitCostUsd <= 0) continue;
        expect(product.pricePerSeat, `${company.id} is selling ${nodeId} under cost`).toBeGreaterThan(unitCostUsd * 0.9);
      }
    }
  });
});

/* -------------------------------------------------------------------------- */
/*  6. No background dies on autopilot                                         */
/* -------------------------------------------------------------------------- */

/**
 * The horizon every claim below is made against: four years of pressing End
 * Quarter and doing nothing else.
 *
 * Sixteen rather than eight, because eight is not long enough to see any of
 * this. Four of the fifteen backgrounds died between quarter ten and quarter
 * thirteen and the eight-quarter run said they were fine.
 */
const AUTOPILOT_QUARTERS = 16;

/**
 * The sixteen-quarter autopilot run for one background, computed once.
 *
 * Four claims are made against the same run — not in administration, still
 * selling, still holding a bank, and not multiplying its capital out of all
 * proportion — and resolving fifteen backgrounds sixteen quarters takes most of
 * a minute each time. One run, four readings.
 */
const AUTOPILOT_RUNS = new Map<string, readonly SessionState[]>();
function autopilot(background: NewGameBackground): readonly SessionState[] {
  const cached = AUTOPILOT_RUNS.get(background.id);
  if (cached !== undefined) return cached;
  const states = run(sessionFor(background), AUTOPILOT_QUARTERS);
  AUTOPILOT_RUNS.set(background.id, states);
  return states;
}

/**
 * Whether the company is in administration.
 *
 * `isActive` is NOT this test, and the version of it that used `isActive` could
 * never fail: `companies/distress.ts` keeps a wound-up company `isActive` ON
 * PURPOSE, as a husk that can still be bought, so `expect(isActive).toBe(true)`
 * passed for four backgrounds that had gone bankrupt. Administration is what
 * `isWoundUp` says it is — no staff and no live product — which is a fact about
 * the company rather than a flag about the record.
 */
function inAdministration(company: Company): boolean {
  return isWoundUp(company);
}

describe('every opening background', () => {
  it('is still trading after sixteen quarters with no player input', { timeout: 900_000 }, () => {
    for (const background of BACKGROUNDS) {
      const states = autopilot(background);
      const last = states[states.length - 1] as SessionState;
      const company = playerOf(last);

      // 1. Not in administration. The bankruptcy rule itself is deliberate and
      //    correct — two consecutive quarter-ends below zero — so this asserts
      //    the company never earned it, not that the rule is soft.
      expect(inAdministration(company), `${background.id} went into administration on autopilot`).toBe(false);

      // 2. Its opening line is still there and still live. A company with no
      //    live product has nothing for a founder to make decisions about, which
      //    is the whole of what "still trading" means here.
      expect(company.products.some((product) => product.isActive), `${background.id} has no live product left`).toBe(true);

      // 3. It never sat below zero two quarters running, which is the thing the
      //    solvency clock actually counts, checked across the WHOLE run rather
      //    than the first five quarters. Every death this test exists for
      //    happened after quarter nine.
      let consecutive = 0;
      for (const state of states.slice(1)) {
        consecutive = playerOf(state).financials.cash < 0 ? consecutive + 1 : 0;
        expect(consecutive, `${background.id} was insolvent two quarters running by quarter ${state.quarter}`).toBeLessThan(2);
      }

      // 4. And it never ran the bank dry: whatever it was burning, there was
      //    still money in it at the end of the horizon.
      expect(company.financials.cash, `${background.id} ended the horizon with nothing in the bank`).toBeGreaterThan(0);
    }
  });

  it('is still selling at quarter sixteen, unless it opened pre-revenue on purpose', { timeout: 900_000 }, () => {
    for (const background of BACKGROUNDS) {
      const states = autopilot(background);
      const opening = playerOf(states[0] as SessionState);
      const last = playerOf(states[states.length - 1] as SessionState);
      const openedWithRevenue = opening.financials.revenueQuarterly > 0;

      const line = last.products.find((product) => product.isActive);
      expect(line, `${background.id} lost its line`).toBeDefined();

      if (!openedWithRevenue) {
        // A pre-revenue background is allowed to earn nothing. What it is not
        // allowed to do is run out of money: its bank has to carry it for the
        // whole horizon. See `W3_MIN_RUNWAY_QUARTERS`.
        expect(last.financials.cash, `${background.id} is pre-revenue and out of money`).toBeGreaterThan(0);
        continue;
      }

      // A revenue background still has revenue, and it is real units at a real
      // price rather than a figure left over on the record. The old version of
      // this test asserted `revenue === units x price`, which is an identity the
      // stamping code guarantees and could never have caught a line that went
      // to zero — which is exactly what happened to `frontier_lab` at quarter
      // twelve while the test said nothing.
      expect(last.financials.revenueQuarterly, `${background.id} stopped selling by quarter ${AUTOPILOT_QUARTERS}`).toBeGreaterThan(0);
      expect(Math.max(0, line?.unitsSoldQuarterly ?? 0), `${background.id} shipped nothing at quarter ${AUTOPILOT_QUARTERS}`).toBeGreaterThan(0);
    }
  });

  it('opens with a line that covers its own wage bill, or a bank that will for the whole horizon', { timeout: 120_000 }, () => {
    // The claim the old test's NAME made and its body never checked: it asserted
    // `revenue === units x pricePerSeat`, an identity the stamping code
    // guarantees, and looked at no wage bill at all.
    //
    // Both halves are computed here from the outside — the wage bill off the
    // talent market, the contribution off the graph — so this is a check on the
    // opening state rather than a restatement of how it was built. Before the
    // repair four backgrounds failed it, and all four were in administration by
    // quarter thirteen with no player input.
    for (const background of BACKGROUNDS) {
      const state = sessionFor(background);
      const company = playerOf(state);
      const cache = createNodeCostCache(state);

      // The wage bill the TALENT MARKET will charge, not the one the seed
      // happens to be paying: `resolveHiring` drifts every company eighteen
      // percent of the way to the market rate every quarter, so the seed's own
      // payroll figure stops being true within a year.
      let wageBillUsd = 0;
      for (const role of W3_STAFF_ROLES) wageBillUsd += company.employees[role] * regionalCompUsd(state, company, role);
      wageBillUsd /= 4;
      expect(wageBillUsd, `${background.id} has no wage bill at all`).toBeGreaterThan(0);

      // What the line will actually make, not the units the seed's revenue
      // figure implies: a pre-revenue background declares none and still runs a
      // pilot line.
      let contributionUsd = 0;
      for (const product of company.products) {
        const nodeId = lineNodeIdOf(product);
        if (!product.isActive || nodeId === null) continue;
        const ref = (cache.linesByCompany.get(company.id) ?? []).find((candidate) => candidate.productId === product.id);
        const capacityUnits = ref === undefined ? 0 : producibleUnits(state, ref, cache.linesByCompany);
        const units = Math.min(Math.max(0, product.unitsSoldQuarterly ?? product.activeCustomers) || capacityUnits, capacityUnits);
        if (!(units > 0) || !Number.isFinite(units)) continue;
        const unitCostUsd = unitCostOf(state, company, nodeId, cache).unitCostUsd;
        contributionUsd += units * (product.pricePerSeat - unitCostUsd) * (1 - NODE_DISCRETIONARY_GROSS_PROFIT_SHARE);
      }

      if (contributionUsd >= wageBillUsd) continue;
      // It does not cover it — which is allowed, and is what a pre-revenue
      // background IS — but then the bank has to, for the whole horizon.
      expect(
        company.financials.cash / (wageBillUsd - contributionUsd),
        `${background.id} neither pays for itself nor has the runway to`,
      ).toBeGreaterThanOrEqual(AUTOPILOT_QUARTERS);
    }
  });

  it('lets a line win customers back from a base of nothing', { timeout: 300_000 }, () => {
    // THE ABSORBING ZERO. Gross additions may not be proportional to the
    // existing base alone, or a line that ever reaches nought is dead for good
    // however much demand there is and however much the company can make —
    // which is what happened to `frontier_lab`, sitting on $57M with an active
    // product and a permanent revenue of zero for four straight quarters.
    //
    // Proved by construction on both allocation paths, because they are
    // different code: a seat line keeps a base and grows it, a durable line
    // wins a share of an order pool.
    for (const [background, kind] of [
      [BACKGROUNDS[1] as NewGameBackground, 'recurring'],
      [BACKGROUNDS[7] as NewGameBackground, 'unit'],
    ] as const) {
      const engine = createDefaultEngine();
      let state = engine.resolver.resolveQuarter(sessionFor(background), [], null, []).nextState;

      const before = playerOf(state);
      const line = before.products[0];
      const nodeId = line === undefined ? null : lineNodeIdOf(line);
      expect(nodeId, `${background.id} has no node line`).not.toBeNull();
      expect(economicNodeById(nodeId as string)?.saleKind).toBe(kind);
      expect(Math.max(0, line?.unitsSoldQuarterly ?? 0)).toBeGreaterThan(0);

      // Everything the company can do stays exactly as it was — the capacity,
      // the price, the quality, the cash. Only the customers are gone.
      (line as { activeCustomers: number }).activeCustomers = 0;
      (line as { unitsSoldQuarterly?: number }).unitsSoldQuarterly = 0;
      (line as { backlogUnits?: number }).backlogUnits = 0;

      const cache = createNodeCostCache(state);
      const ref = (cache.linesByCompany.get(before.id) ?? []).find((candidate) => candidate.productId === line?.id);
      expect(ref === undefined ? 0 : producibleUnits(state, ref, cache.linesByCompany), `${background.id} cannot produce`).toBeGreaterThan(0);
      expect(nodeBalances(state)[nodeId as string]?.demandUnits ?? 0, `${background.id}'s node has no demand`).toBeGreaterThan(0);

      state = engine.resolver.resolveQuarter(state, [], null, []).nextState;
      const after = playerOf(state).products[0];
      expect(
        Math.max(0, after?.unitsSoldQuarterly ?? 0),
        `${background.id}: a ${kind} line at zero never came back with capacity and demand in hand`,
      ).toBeGreaterThan(0);
    }
  });

  it('says so in the ledger when a line\'s customer base collapses', { timeout: 300_000 }, () => {
    // A collapse used to be silent: revenue fell to nothing and the resolution
    // report and the news feed had not one word about it. Drive a real line's
    // capacity to zero and the quarter has to name what happened.
    const state = sessionFor(BACKGROUNDS[0] as NewGameBackground);
    const engine = createDefaultEngine();
    let current = engine.resolver.resolveQuarter(state, [], null, []).nextState;
    const company = playerOf(current);
    expect(Math.max(0, company.products[0]?.unitsSoldQuarterly ?? 0)).toBeGreaterThan(0);

    // The exact shape of the frontier laboratory's death: the compute the line
    // is made on is gone, and nothing else about the company changes.
    company.compute = { ...company.compute, ownedAccelerators: 0, reservedAccelerators: 0, cloudSpendQuarterly: 0 };
    const result = engine.resolver.resolveQuarter(current, [], null, []);
    current = result.nextState;

    const collapse = result.events.find(
      (event) => event.type === 'information_revealed' && event.payload.kind === 'line_collapsed' && event.actorId === W2_COMPANIES.player,
    );
    expect(collapse, 'a line collapsed and the ledger said nothing').toBeDefined();
    expect(collapse?.payload.cause).toBe('no_capacity');
    expect(collapse?.payload.canStillProduce).toBe(false);
    expect(Math.max(0, playerOf(current).products[0]?.unitsSoldQuarterly ?? 0)).toBe(0);

    // And the founder is told, in the report the resolution screen renders.
    expect(
      result.report.phases.some((phase) => phase.lines.some((line) => line.text.includes('no compute capacity left'))),
      'the resolution report never mentioned the collapse',
    ).toBe(true);
  });

  it('leaves no background multiplying its opening capital out of all proportion', { timeout: 900_000 }, () => {
    // Four years of doing nothing is not an investment strategy. Before this
    // bound a grid developer turned $12M into $1.82B — a hundred and fifty times
    // its capital, almost all of it a five-year power contract billed in advance
    // — while a renewables operator in the same world ended below what it opened
    // with, so the spread across fifteen identical decisions (none) was five
    // orders of magnitude and the leaderboard meant nothing.
    const closing: { id: string; openingUsd: number; closingUsd: number; multiple: number }[] = [];
    for (const background of BACKGROUNDS) {
      const states = autopilot(background);
      const openingUsd = playerOf(states[0] as SessionState).financials.cash;
      const closingUsd = playerOf(states[states.length - 1] as SessionState).financials.cash;
      expect(openingUsd).toBeGreaterThan(0);
      closing.push({ id: background.id, openingUsd, closingUsd, multiple: closingUsd / openingUsd });
    }

    for (const row of closing) {
      // Observed at the time of writing: 0.28x (grid_developer) to 6.8x
      // (consumer_ai). The bounds are loose enough for deliberate rebalancing
      // and tight enough that another 150x cannot appear unnoticed.
      expect(row.multiple, `${row.id} multiplied its opening capital ${row.multiple.toFixed(1)}x doing nothing`).toBeLessThanOrEqual(10);
      expect(row.multiple, `${row.id} lost almost all of its opening capital doing nothing`).toBeGreaterThanOrEqual(0.15);
    }

    const richest = Math.max(...closing.map((row) => row.closingUsd));
    const poorest = Math.min(...closing.map((row) => row.closingUsd));
    expect(poorest).toBeGreaterThan(0);
    // Observed: 27x, about one and a half orders of magnitude. It was five.
    expect(richest / poorest, 'the spread across backgrounds on autopilot is out of hand again').toBeLessThanOrEqual(40);
  });
});

/* -------------------------------------------------------------------------- */
/*  7. A session stops growing                                                 */
/* -------------------------------------------------------------------------- */

describe('the weight of a session', () => {
  it('stops growing: the statement series and the public record are both bounded', { timeout: 300_000 }, () => {
    const states = run(createWorld3Session(), 20);
    const last = states[states.length - 1] as SessionState;

    for (const company of last.companies) {
      expect((company.financialHistory ?? []).length).toBeLessThanOrEqual(FINANCIAL_HISTORY_KEPT_QUARTERS);
    }
    for (const disclosure of last.disclosures) {
      expect(disclosure.quarter).toBeGreaterThanOrEqual(last.quarter - 1 - DISCLOSURE_WINDOW_QUARTERS);
    }

    // The whole point: the state a quarter has to hash eighteen times is no
    // bigger at quarter twenty than at quarter fourteen.
    const weigh = (state: SessionState): number => JSON.stringify(state).length;
    const fourteen = weigh(states[14] as SessionState);
    expect(weigh(last)).toBeLessThan(fourteen * 1.25);
  });
});
