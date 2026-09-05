/**
 * Market entry, and the seat that closes behind it.
 *
 * The owner's rule: "new companies should be able to spawn when one company is
 * either bankrupt (count as kicked out of the game)". Two halves, both proved
 * here against real resolutions through the real engine with the invariant gate
 * on, because a company minted mid-quarter is exactly where a cap table or a
 * balance sheet would quietly stop reconciling.
 *
 * 1. **Every wind-up leaves a gap and something fills it.** One entrant per
 *    company wound up, `ENTRANTS_PER_QUARTER` at most in a quarter, nothing at
 *    all at `ACTIVE_COMPANY_CAP`, and the entrant is a real company: its shares
 *    reconcile, its books close, its name is its own and its founder exists.
 * 2. **A bankrupt player is out.** The seat carries `eliminatedQuarter`, the
 *    validator refuses everything it submits from then on, and the market does
 *    not care: an entrant spawns for the player's slot exactly as it does for a
 *    bot's.
 */

import { describe, expect, it } from 'vitest';
import type { SessionState, SimEvent } from '@frontier/contracts';
import { SessionStateSchema, makeId } from '@frontier/contracts';
import { hashState } from '@frontier/shared';
import { createDefaultEngine } from '../src/engine';
import { createActionValidator } from '../src/validator';
import { DEMO_PLAYER_ID, createDemoSession, createWorld2Session, W2_COMPANIES } from '../src/scenario';
import { ACTIVE_COMPANY_CAP, ENTRANTS_PER_QUARTER, isEliminated, isNewEntrant, isWoundUp } from '../src/companies';
import { projectPublicRecord } from '../src/resolver/publicRecord';

/* -------------------------------------------------------------------------- */
/*  Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

const companyOf = (state: SessionState, id: string) => {
  const company = state.companies.find((candidate) => candidate.id === id);
  if (company === undefined) throw new Error(`no company ${id}`);
  return company;
};

/**
 * Put companies on a path to a negative close: no products to sell, no
 * receivables to collect, and `cashUsd` on hand against a payroll they still
 * owe. The wage bill is what takes them under, which is the ordinary way a
 * company runs out of money.
 *
 * Each starved company is put under the player's control as well, because a bot
 * that closes below zero has a forced bridge queued for it and a bridge that
 * clears puts the cash back before the second close. The asymmetry is the
 * engine's, not the fixture's: a player-controlled company is never
 * force-bridged, so it is the only way to make a company die on schedule
 * without shutting the whole capital market and killing bystanders too.
 */
function starve(state: SessionState, companyIds: readonly string[], cashUsd: number): SessionState {
  const ids = new Set(companyIds);
  return SessionStateSchema.parse({
    ...state,
    companies: state.companies.map((company) => {
      if (!ids.has(company.id)) return company;
      const sheet = company.balanceSheet;
      const assets = { ...sheet.assets, cash: cashUsd, receivables: 0, goodwill: 0, investments: 0 };
      const liabilities = { ...sheet.liabilities, payables: 0, deferredRevenue: 0, debt: 0 };
      const equity =
        assets.cash + assets.ppe + assets.goodwill + assets.investments + assets.receivables - liabilities.debt - liabilities.payables - liabilities.deferredRevenue;
      return {
        ...company,
        controllerPlayerId: DEMO_PLAYER_ID,
        products: company.products.map((product) => ({ ...product, isActive: false, activeCustomers: 0 })),
        balanceSheet: { assets, liabilities, equity },
        financials: { ...company.financials, cash: cashUsd, revenueQuarterly: 0, debt: 0, deferredRevenue: 0, backlogUsd: 0 },
      };
    }),
  });
}

/** Resolve one quarter through the whole engine, gate on. */
function step(state: SessionState): { state: SessionState; events: readonly SimEvent[]; hash: string } {
  const engine = createDefaultEngine();
  const outcome = engine.resolver.resolveQuarter(state, [], null, []);
  const failures = outcome.invariants.filter((result) => !result.passed).map((result) => `${result.invariant}: ${result.detail}`);
  expect(failures).toEqual([]);
  expect(outcome.committed).toBe(true);
  return { state: outcome.nextState, events: outcome.events, hash: hashState(outcome.nextState) };
}

/**
 * Starve `ids` and resolve until they are wound up: the clock is two closes, and
 * the fixture is re-starved between them so the second close is negative too.
 */
function bankrupt(state: SessionState, ids: readonly string[], cashUsd = 250_000): { state: SessionState; events: readonly SimEvent[]; hash: string } {
  const first = step(starve(state, ids, cashUsd));
  return step(starve(first.state, ids, cashUsd));
}

/** Companies founded in `quarter`, i.e. this quarter's entrants. */
const entrantsOf = (state: SessionState, quarter: number) => state.companies.filter((company) => company.foundedQuarter === quarter);

const foundingRows = (events: readonly SimEvent[]): readonly SimEvent[] =>
  events.filter((event) => event.type === 'information_revealed' && event.payload['kind'] === 'company_founded');

/* -------------------------------------------------------------------------- */
/*  One wind-up, one entrant                                                   */
/* -------------------------------------------------------------------------- */

describe('a wind-up is a gap and something fills it', () => {
  it('founds exactly one company, in the dead company\'s sector, with books that reconcile', () => {
    const opening = createWorld2Session();
    const dead = companyOf(opening, W2_COMPANIES.player);
    const { state, events } = bankrupt(opening, [dead.id]);

    expect(isWoundUp(companyOf(state, dead.id))).toBe(true);

    const founded = foundingRows(events);
    expect(founded.length).toBe(1);
    const row = founded[0];
    expect(row?.payload['replacesCompanyId']).toBe(dead.id);
    expect(row?.visibility).toBe('public');

    const entrants = entrantsOf(state, state.quarter - 1);
    expect(entrants.length).toBe(1);
    const entrant = entrants[0];
    if (entrant === undefined) throw new Error('no entrant');

    // The gap it was founded into.
    expect(entrant.sector).toBe(dead.sector);
    // Private at birth: no ticker, no instrument, nothing on the tape.
    expect(entrant.isPublic).toBe(false);
    expect(entrant.instrumentId).toBeNull();
    expect(state.marketInstruments.some((instrument) => instrument.companyId === entrant.id)).toBe(false);
    expect(entrant.controllerPlayerId).toBeNull();
    expect(entrant.products.length).toBe(1);
    expect(entrant.compute.ownedAccelerators).toBeGreaterThan(0);

    // The books close. `financial_integrity` already refused the quarter if they
    // did not; this states it in the terms a reader checks.
    const sheet = entrant.balanceSheet;
    const assets = sheet.assets.cash + sheet.assets.ppe + sheet.assets.goodwill + sheet.assets.investments + sheet.assets.receivables;
    const liabilities = sheet.liabilities.debt + sheet.liabilities.payables + sheet.liabilities.deferredRevenue;
    expect(Math.abs(assets - liabilities - sheet.equity)).toBeLessThanOrEqual(1);

    // Every per-company table carries its row.
    expect(state.capTables.some((table) => table.companyId === entrant.id)).toBe(true);
    expect(state.securities.some((security) => security.companyId === entrant.id)).toBe(true);
    expect(state.companyMetrics.some((metric) => metric.companyId === entrant.id)).toBe(true);
    expect(state.valuationAnchors.some((anchor) => anchor.companyId === entrant.id)).toBe(true);
    expect(state.characters.some((character) => character.id === entrant.ceoCharacterId)).toBe(true);
    expect(state.fundingRounds.some((round) => round.companyId === entrant.id)).toBe(true);
  });

  it('gives the entrant a name and a founder nobody else in the session has', () => {
    const { state } = bankrupt(createWorld2Session(), [W2_COMPANIES.player]);
    const names = state.companies.map((company) => company.name.toLowerCase());
    expect(new Set(names).size).toBe(names.length);
    const people = state.characters.map((character) => character.name.toLowerCase());
    expect(new Set(people).size).toBe(people.length);

    const entrant = entrantsOf(state, state.quarter - 1)[0];
    if (entrant === undefined) throw new Error('no entrant');
    const founder = state.characters.find((character) => character.id === entrant.ceoCharacterId);
    expect(founder?.companyId).toBe(entrant.id);
    expect(founder?.isPlayer).toBe(false);
    expect(founder?.role).toBe('founder_ceo');
    expect(founder?.connectionLevel).toBeLessThan(40);
  });

  it('reconciles the lead fund\'s stake to the issued shares and declares the cheque on the ledger', () => {
    const { state, events } = bankrupt(createWorld2Session(), [W2_COMPANIES.player]);
    const entrant = entrantsOf(state, state.quarter - 1)[0];
    if (entrant === undefined) throw new Error('no entrant');

    const table = state.capTables.find((entry) => entry.companyId === entrant.id);
    if (table === undefined) throw new Error('no cap table');
    const issued = table.shareClasses.reduce((sum, shareClass) => sum + shareClass.issuedShares, 0);
    const held = table.holdings.reduce((sum, holding) => sum + holding.shares, 0);
    expect(held).toBe(issued);
    expect(table.holdings.every((holding) => holding.shares > 0)).toBe(true);

    const round = events.find((event) => event.type === 'funding_round_closed' && event.actorId === entrant.id);
    expect(round).toBeDefined();
    const leadId = round?.payload['entityId'];
    if (typeof leadId === 'string') {
      // A fund backed it, so the fund holds the stake and its dry powder moved by
      // exactly what the row declares — the only thing `capital_integrity` reads.
      expect(table.holdings.some((holding) => holding.holderId === leadId && holding.holderKind === 'fund')).toBe(true);
      expect(round?.payload['dryPowderDeltaUsd']).toBeLessThan(0);
    } else {
      expect(table.holdings.every((holding) => holding.holderKind === 'character')).toBe(true);
    }
  });

  it('says why a founding matters only when the newcomer is next door', () => {
    const { state } = bankrupt(createWorld2Session(), [W2_COMPANIES.player]);
    const entrant = entrantsOf(state, state.quarter - 1)[0];
    if (entrant === undefined) throw new Error('no entrant');

    // Same sector by construction; put the seat's company in the same region and
    // the feed says so. `whyItMatters` is a consequence for this seat, so a
    // newcomer on the other side of the world earns no line at all.
    const near = SessionStateSchema.parse({
      ...state,
      companies: state.companies.map((company) => (company.id === W2_COMPANIES.player ? { ...company, region: entrant.region } : company)),
    });
    const far = SessionStateSchema.parse({
      ...state,
      companies: state.companies.map((company) =>
        company.id === W2_COMPANIES.player ? { ...company, region: entrant.region === 'east_asia' ? 'latin_america' : 'east_asia' } : company,
      ),
    });

    const lineOf = (session: SessionState): string | null =>
      projectPublicRecord(session, DEMO_PLAYER_ID).find((item) => item.companyIds.includes(entrant.id))?.whyItMatters ?? null;

    expect(lineOf(near)).toContain('in your region');
    expect(lineOf(far)).toBeNull();
  });

  it('tells the story on the public record', () => {
    const { state } = bankrupt(createWorld2Session(), [W2_COMPANIES.player]);
    const entrant = entrantsOf(state, state.quarter - 1)[0];
    if (entrant === undefined) throw new Error('no entrant');

    const items = projectPublicRecord(state, DEMO_PLAYER_ID);
    const founding = items.find((item) => item.companyIds.includes(entrant.id));
    expect(founding).toBeDefined();
    expect(founding?.kind).toBe('disclosure');
    expect(founding?.headline).toContain(entrant.name);
  });
});

/* -------------------------------------------------------------------------- */
/*  Bounds                                                                     */
/* -------------------------------------------------------------------------- */

describe('how many arrive', () => {
  it('founds two when two die in one quarter, and two when three do', () => {
    const opening = createWorld2Session();
    const bots = opening.companies.filter((company) => company.id !== W2_COMPANIES.player && company.isActive);
    const two = bots.slice(0, 2).map((company) => company.id);
    const three = bots.slice(0, 3).map((company) => company.id);

    const pair = bankrupt(opening, two);
    expect(foundingRows(pair.events).length).toBe(2);

    const trio = bankrupt(opening, three);
    expect(foundingRows(trio.events).length).toBe(ENTRANTS_PER_QUARTER);
    expect(ENTRANTS_PER_QUARTER).toBe(2);
  });

  it('founds nothing once the industry is at the cap', () => {
    const opening = createWorld2Session();
    // Clone the roster up to the cap. Ids and names stay unique, so every
    // invariant the gate checks still holds; the only thing under test is that a
    // full industry absorbs a failure rather than restocking.
    const filler = [];
    const capTables = [...opening.capTables];
    const securities = [...opening.securities];
    const metrics = [...opening.companyMetrics];
    const anchors = [...opening.valuationAnchors];
    let index = 0;
    // Four spare: the company that dies becomes a husk before the count is
    // taken, so a roster filled to exactly the cap would drop under it.
    while (opening.companies.length + filler.length < ACTIVE_COMPANY_CAP + 4) {
      const source = opening.companies[index % opening.companies.length];
      if (source === undefined) break;
      const id = makeId('cmp', 'filler', index);
      const securityId = makeId('sec', 'filler', index);
      const classId = makeId('shc', 'filler', index);
      const table = capTables.find((entry) => entry.companyId === source.id) ?? null;
      const sourceClass = table?.shareClasses[0] ?? null;
      filler.push({
        ...source,
        id,
        name: `Filler ${index}`,
        ticker: null,
        isPublic: false,
        instrumentId: null,
        controllerPlayerId: null,
        boardId: null,
        primarySecurityId: securityId,
        ceoCharacterId: null,
      });
      securities.push({ id: securityId, companyId: id, shareClassId: classId, symbol: null, isTradable: false, instrumentId: null, parValueUsd: 0.0001 });
      if (table !== null && sourceClass !== null) {
        const shares = sourceClass.issuedShares;
        capTables.push({
          ...table,
          companyId: id,
          shareClasses: [{ ...sourceClass, id: classId, companyId: id, issuedShares: shares, authorisedShares: shares * 2 }],
          holdings: [
            {
              id: makeId('hld', 'filler', index),
              holderId: 'fund_seawall',
              holderKind: 'fund' as const,
              securityId,
              shares,
              costBasisUsd: 0,
              acquiredQuarter: 0,
              lockupUntilQuarter: null,
              isDisclosed: true,
            },
          ],
          totalIssuedByClass: { [classId]: shares },
          fullyDilutedShares: shares,
          optionPoolShares: 0,
        });
      }
      const metric = metrics.find((entry) => entry.companyId === source.id);
      if (metric !== undefined) metrics.push({ ...metric, companyId: id });
      const anchor = anchors.find((entry) => entry.companyId === source.id);
      if (anchor !== undefined) anchors.push({ ...anchor, companyId: id });
      index += 1;
    }

    const crowded = SessionStateSchema.parse({
      ...opening,
      companies: [...opening.companies, ...filler],
      capTables,
      securities,
      companyMetrics: metrics,
      valuationAnchors: anchors,
    });
    expect(crowded.companies.filter((company) => company.isActive).length).toBeGreaterThanOrEqual(ACTIVE_COMPANY_CAP);

    const { events } = bankrupt(crowded, [W2_COMPANIES.player]);
    expect(foundingRows(events).length).toBe(0);
  });

  it('founds nothing in world version 1, whose hash is frozen', () => {
    const base = createDemoSession();
    const before = base.companies.length;
    const { state, events } = bankrupt(base, [base.companies[0]?.id ?? '']);
    expect(foundingRows(events).length).toBe(0);
    expect(state.companies.length).toBe(before);
    expect(state.players.every((player) => !isEliminated(player))).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/*  Determinism                                                                */
/* -------------------------------------------------------------------------- */

describe('the same seed founds the same company', () => {
  it('produces a byte-identical state across two runs', () => {
    const a = bankrupt(createWorld2Session(), [W2_COMPANIES.player]);
    const b = bankrupt(createWorld2Session(), [W2_COMPANIES.player]);
    expect(a.hash).toBe(b.hash);

    const first = entrantsOf(a.state, a.state.quarter - 1)[0];
    const second = entrantsOf(b.state, b.state.quarter - 1)[0];
    expect(first?.id).toBe(second?.id);
    expect(first?.name).toBe(second?.name);
    expect(first?.region).toBe(second?.region);
    expect(first?.financials.cash).toBe(second?.financials.cash);
  });
});

/* -------------------------------------------------------------------------- */
/*  Elimination                                                                */
/* -------------------------------------------------------------------------- */

describe('a bankrupt player is out', () => {
  it('closes the seat on the quarter the company is wound up', () => {
    const { state } = bankrupt(createWorld2Session(), [W2_COMPANIES.player]);
    const seat = state.players.find((player) => player.playerId === DEMO_PLAYER_ID);
    expect(seat).toBeDefined();
    expect(isEliminated(seat ?? { eliminatedQuarter: null })).toBe(true);
    expect(seat?.eliminatedQuarter).toBe(state.quarter - 1);
  });

  it('leaves the seat open while the company is only warned', () => {
    const first = step(starve(createWorld2Session(), [W2_COMPANIES.player], 250_000));
    const seat = first.state.players.find((player) => player.playerId === DEMO_PLAYER_ID);
    expect(isEliminated(seat ?? { eliminatedQuarter: null })).toBe(false);
  });

  it('refuses every instruction the closed seat submits', () => {
    const { state } = bankrupt(createWorld2Session(), [W2_COMPANIES.player]);
    const validator = createActionValidator();
    const result = validator.validate(state, { type: 'set_marketing_budget', allocations: [] }, DEMO_PLAYER_ID);
    expect(result.status).toBe('rejected');
    expect(result.codes).toContain('requirement_not_met');
    expect(result.reasons.join(' ')).toContain('the seat is closed');
  });

  it('still founds a company into the player\'s slot: the market does not care who died', () => {
    const { state, events } = bankrupt(createWorld2Session(), [W2_COMPANIES.player]);
    const dead = companyOf(state, W2_COMPANIES.player);
    expect(foundingRows(events).length).toBe(1);
    expect(entrantsOf(state, state.quarter - 1)[0]?.sector).toBe(dead.sector);
    // The husk stays purchasable.
    expect(dead.isActive).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/*  Badge window                                                               */
/* -------------------------------------------------------------------------- */

describe('the new-entrant badge', () => {
  it('runs for four quarters from the founding and no longer', () => {
    expect(isNewEntrant({ foundedQuarter: 8 }, 8)).toBe(true);
    expect(isNewEntrant({ foundedQuarter: 8 }, 11)).toBe(true);
    expect(isNewEntrant({ foundedQuarter: 8 }, 12)).toBe(false);
    // Never worn by a company the scenario seeded.
    expect(isNewEntrant({ foundedQuarter: 0 }, 0)).toBe(false);
  });
});
