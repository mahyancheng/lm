/**
 * The investments portfolio.
 *
 * One projection answers "what do I own that is not this company", and the
 * claims worth pinning are the ones a screen would otherwise get wrong:
 *
 * - a purchase produces a **stake** whose cost basis is the consideration the
 *   engine actually paid, and the investments line rises by exactly the same
 *   dollar, so the reconciliation holds against the balance sheet rather than
 *   against a restatement of itself;
 * - an acquisition produces a **subsidiary** carrying the price paid, which is
 *   only possible because the capital phase writes the record on the husk — a
 *   save carries no ledger, and this is the test that would notice if it stopped;
 * - the founder's portfolio sums to exactly the number the founder-wealth board
 *   ranks, because both come from `founderWealthOf`;
 * - a rival's positions never appear in the player's portfolio, and the check is
 *   made against a register the rival really does hold shares on;
 * - the whole thing is pure: same state, same rows.
 *
 * Everything is proved through a real resolution with the invariant gate on.
 */

import { describe, expect, it } from 'vitest';
import type { ActionIntent, SessionState, SubmittedAction } from '@frontier/contracts';
import { CONTROL_DECISIVE_PCT } from '@frontier/contracts';
import { createDefaultEngine } from '../src/engine';
import { createDemoSession, DEMO_PLAYER_ID } from '../src/scenario';
import { createWorld2Session } from '../src/scenario/world2';
import { founderWealthOf } from '../src/resolver/leaderboards';
import { PORTFOLIO_HISTORY_QUARTERS, founderPortfolioOf, portfolioOf } from '../src/portfolio';

/* -------------------------------------------------------------------------- */
/*  Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

const PLAYER_COMPANY = 'cmp_player_ventures';
const PLAYER_CHARACTER = 'chr_avery_sinclair';
const RIVAL = 'cmp_aletheia';
const RIVAL_SECURITY = 'sec_aletheia_common';

const companyOf = (state: SessionState, id: string) => {
  const company = state.companies.find((entry) => entry.id === id);
  if (company === undefined) throw new Error(`no company ${id}`);
  return company;
};

/** Put cash on the player's balance sheet without breaking the identity. */
function withCash(state: SessionState, cashUsd: number): SessionState {
  const company = companyOf(state, PLAYER_COMPANY);
  const added = cashUsd - company.balanceSheet.assets.cash;
  company.balanceSheet.assets.cash = cashUsd;
  company.balanceSheet.equity += added;
  company.financials.cash = cashUsd;
  return state;
}

let sequence = 0;

function act(state: SessionState, intent: ActionIntent): SubmittedAction {
  sequence += 1;
  return {
    actionId: `act_portfolio_${sequence}`,
    sessionId: state.sessionId,
    quarter: state.quarter,
    sequence,
    actorPlayerId: DEMO_PLAYER_ID,
    actorCompanyId: PLAYER_COMPANY,
    actorCharacterId: PLAYER_CHARACTER,
    origin: 'player_ui',
    intent,
    confirmedByHuman: true,
  };
}

function resolveOne(state: SessionState, actions: readonly SubmittedAction[]): SessionState {
  const engine = createDefaultEngine();
  const outcome = engine.resolver.resolveQuarter(state, [...actions], null, []);
  const failures = outcome.invariants.filter((result) => !result.passed).map((result) => `${result.invariant}: ${result.detail}`);
  expect(failures).toEqual([]);
  expect(outcome.committed).toBe(true);
  return outcome.nextState;
}

/** A world-2 session in which the player has bought a slice of a listed rival. */
function afterPurchase(shares = 4_000_000): SessionState {
  const state = withCash(createWorld2Session(), 3_000_000_000);
  return resolveOne(
    state,
    [act(state, { type: 'buy_shares', securityId: RIVAL_SECURITY, targetPct: null, shares, maxPricePerShareUsd: 1_000 })],
  );
}

/**
 * Take the board off the player company.
 *
 * With a board in place `acquire_company` is correctly clamped into the board
 * matter that has to precede it, and nothing is absorbed this quarter — which is
 * the validator working, not a bug. This fixture is about what the portfolio
 * says *after* an absorption, so it removes the gate rather than driving three
 * quarters of governance to reach the same state.
 */
function withoutBoard(state: SessionState): SessionState {
  const company = companyOf(state, PLAYER_COMPANY);
  const boardId = company.boardId;
  company.boardId = null;
  state.boards = state.boards.filter((board) => board.id !== boardId);
  state.boardProposals = state.boardProposals.filter((proposal) => proposal.boardId !== boardId);
  return state;
}

/** The smallest private company in the world, which is the cheapest thing to buy outright. */
function smallestTarget(state: SessionState): string {
  const candidates = state.companies
    .filter((company) => company.isActive && company.id !== PLAYER_COMPANY && company.instrumentId === null)
    .sort((a, b) => a.financials.revenueQuarterly - b.financials.revenueQuarterly);
  const first = candidates[0];
  if (first === undefined) throw new Error('world 2 has no private company to buy');
  return first.id;
}

/* -------------------------------------------------------------------------- */
/*  Stakes                                                                     */
/* -------------------------------------------------------------------------- */

describe('a stake bought on the exchange', () => {
  it('appears as one row carrying the cost the engine actually paid', () => {
    const state = afterPurchase();
    const portfolio = portfolioOf(state, PLAYER_COMPANY);

    const stake = portfolio.stakes.find((row) => row.companyId === RIVAL);
    expect(stake).toBeDefined();
    expect(stake?.shares).toBeGreaterThan(0);
    expect(stake?.costUsd).toBeGreaterThan(0);

    // The register is the source of the cost, so the row cannot drift from it.
    const table = state.capTables.find((entry) => entry.companyId === RIVAL);
    const held = (table?.holdings ?? []).filter((holding) => holding.holderId === PLAYER_COMPANY);
    const cost = held.reduce((sum, holding) => sum + holding.costBasisUsd, 0);
    expect(stake?.costUsd).toBe(Math.round(cost));
    expect(stake?.shares).toBe(held.reduce((sum, holding) => sum + holding.shares, 0));
  });

  it('is marked off the tape, and says so', () => {
    const portfolio = portfolioOf(afterPurchase(), PLAYER_COMPANY);
    const stake = portfolio.stakes.find((row) => row.companyId === RIVAL);
    expect(stake?.priceBasis).toBe('quote');
    expect(stake?.isListed).toBe(true);
    expect(stake?.valueUsd).toBeGreaterThan(0);
    expect(stake?.unrealisedUsd).toBe(stake!.valueUsd - stake!.costUsd);
  });

  it('offers the instructions that are shaped for it', () => {
    const portfolio = portfolioOf(afterPurchase(), PLAYER_COMPANY);
    const stake = portfolio.stakes.find((row) => row.companyId === RIVAL);
    expect(stake?.actions).toContain('buy_shares');
    expect(stake?.actions).toContain('sell_shares');
    expect(stake?.actions).toContain('acquire_company');
    // A minority holder tables nothing at somebody else's board.
    expect(stake?.actions).not.toContain('submit_board_proposal');
  });
});

/* -------------------------------------------------------------------------- */
/*  Reconciliation                                                             */
/* -------------------------------------------------------------------------- */

describe('the rows reconcile to the balance sheet', () => {
  it('states the basis, and the attributed cost never exceeds the line it is part of', () => {
    const state = afterPurchase();
    const portfolio = portfolioOf(state, PLAYER_COMPANY);
    const company = companyOf(state, PLAYER_COMPANY);

    expect(portfolio.reconciliation.basis).toBe('cost');
    expect(portfolio.reconciliation.investmentsLineUsd).toBe(Math.round(company.balanceSheet.assets.investments));
    expect(portfolio.reconciliation.reconciles).toBe(true);
    expect(portfolio.reconciliation.unattributedUsd).toBe(
      portfolio.reconciliation.investmentsLineUsd - portfolio.reconciliation.stakesCostUsd,
    );
  });

  it('moves the line by exactly what the purchase cost, leaving nothing unattributed', () => {
    const before = withCash(createWorld2Session(), 3_000_000_000);
    const openingLine = companyOf(before, PLAYER_COMPANY).balanceSheet.assets.investments;
    expect(openingLine).toBe(0);

    const after = afterPurchase();
    const portfolio = portfolioOf(after, PLAYER_COMPANY);
    // Opening line was zero and the only movement was this purchase, so the
    // whole line is attributed: every dollar on it has a position behind it.
    expect(portfolio.reconciliation.unattributedUsd).toBe(0);
    expect(portfolio.reconciliation.stakesCostUsd).toBe(portfolio.reconciliation.investmentsLineUsd);
    expect(portfolio.totals.costUsd).toBe(portfolio.reconciliation.stakesCostUsd);
  });

  it('carries a filed history of the line, bounded and oldest first', () => {
    let state = afterPurchase();
    for (let index = 0; index < 3; index += 1) state = resolveOne(state, []);
    const portfolio = portfolioOf(state, PLAYER_COMPANY);

    expect(portfolio.history.length).toBeGreaterThan(1);
    expect(portfolio.history.length).toBeLessThanOrEqual(PORTFOLIO_HISTORY_QUARTERS);
    for (let index = 1; index < portfolio.history.length; index += 1) {
      expect(portfolio.history[index]!.quarter).toBeGreaterThan(portfolio.history[index - 1]!.quarter);
    }
    // The most recent filed quarter is the line the company closed on.
    const last = portfolio.history[portfolio.history.length - 1]!;
    expect(last.carryingUsd).toBe(portfolio.totals.carryingUsd);
    expect(portfolio.totals.carryingChangeUsd).toBe(portfolio.totals.carryingUsd - (portfolio.totals.previousCarryingUsd ?? 0));
  });
});

/* -------------------------------------------------------------------------- */
/*  Subsidiaries                                                               */
/* -------------------------------------------------------------------------- */

describe('a company bought outright', () => {
  it('becomes a subsidiary row carrying the price paid', () => {
    const state = withoutBoard(withCash(createWorld2Session(), 20_000_000_000));
    const targetId = smallestTarget(state);
    const target = companyOf(state, targetId);
    const offer = Math.max(50_000_000, Math.round(target.financials.revenueQuarterly * 8));

    const next = resolveOne(
      state,
      [act(state, { type: 'acquire_company', targetCompanyId: targetId, offerValueUsd: offer, cashPct: 1, stockPct: 0 })],
    );

    const husk = companyOf(next, targetId);
    expect(husk.isActive).toBe(false);
    expect(husk.parentCompanyId).toBe(PLAYER_COMPANY);
    expect(husk.acquisition?.priceUsd).toBe(offer);

    const portfolio = portfolioOf(next, PLAYER_COMPANY);
    const row = portfolio.subsidiaries.find((entry) => entry.companyId === targetId);
    expect(row?.status).toBe('absorbed');
    expect(row?.costUsd).toBe(offer);
    expect(row?.controlPct).toBe(1);
    // Its assets are inside the parent now; counting them again here would
    // double-count the parent, so the row is worth nothing on its own.
    expect(row?.valueUsd).toBe(0);
    expect(row?.actions).toEqual([]);

    // ...and it stays off the investments line, which is where a double count
    // would show up first.
    expect(portfolio.reconciliation.reconciles).toBe(true);
  });

  it('is not confused with a stake, however large the stake is', () => {
    const portfolio = portfolioOf(afterPurchase(), PLAYER_COMPANY);
    for (const stake of portfolio.stakes) expect(stake.ownershipPct).toBeLessThanOrEqual(CONTROL_DECISIVE_PCT);
    for (const subsidiary of portfolio.subsidiaries) expect(subsidiary.controlPct).toBeGreaterThan(CONTROL_DECISIVE_PCT);
  });
});

/* -------------------------------------------------------------------------- */
/*  The founder                                                                */
/* -------------------------------------------------------------------------- */

describe('the founder view', () => {
  it('sums to exactly the number the founder-wealth board ranks', () => {
    const state = resolveOne(createWorld2Session(), []);
    const character = state.characters.find((entry) => entry.id === PLAYER_CHARACTER)!;
    const founder = founderPortfolioOf(state, DEMO_PLAYER_ID);

    expect(founder.netWorthUsd).toBe(Math.round(founderWealthOf(state, character)));
    expect(founder.netWorthUsd).toBe(founder.cashUsd + founder.holdingsValueUsd);

    const board = state.leaderboards.find((entry) => entry.board === 'founder_wealth');
    const row = board?.entries.find((entry) => entry.subjectId === character.id);
    expect(row).toBeDefined();
    expect(Math.round(row!.value)).toBe(founder.netWorthUsd);
  });

  it('includes the founder\'s own company, marked as such', () => {
    const founder = founderPortfolioOf(resolveOne(createWorld2Session(), []), DEMO_PLAYER_ID);
    const own = founder.holdings.find((row) => row.isOwnCompany);
    expect(own).toBeDefined();
    expect(own?.companyId).toBe(PLAYER_COMPANY);
    expect(own?.shares).toBeGreaterThan(0);
    expect(founder.basis).toBe('enterprise_value_per_share');
  });

  it('has no fund rows unless the founder is a partner in one', () => {
    const founder = founderPortfolioOf(createWorld2Session(), DEMO_PLAYER_ID);
    expect(founder.funds).toEqual([]);
  });

  it('reads a partner\'s funds when there is one', () => {
    const state = resolveOne(createWorld2Session(), []);
    const entity = (state.capitalEntities ?? [])[0];
    expect(entity).toBeDefined();
    const partnerId = entity!.partnerCharacterIds[0]!;
    // Seat the partner as the player, which is the only way this projection is
    // ever asked about somebody who runs a fund.
    const seated: SessionState = { ...state, players: state.players.map((seat) => ({ ...seat, characterId: partnerId })) };
    const founder = founderPortfolioOf(seated, DEMO_PLAYER_ID);
    const row = founder.funds.find((entry) => entry.entityId === entity!.id);
    expect(row?.role).toBe('general_partner');
    expect(row?.committedCapitalUsd).toBe(Math.round(entity!.committedCapitalUsd));
  });
});

/* -------------------------------------------------------------------------- */
/*  Redaction and determinism                                                  */
/* -------------------------------------------------------------------------- */

describe('the projection is the player\'s and only the player\'s', () => {
  it('never lists a position another holder owns', () => {
    const state = afterPurchase();
    const portfolio = portfolioOf(state, PLAYER_COMPANY);
    const mine = new Set(portfolio.stakes.map((row) => row.holdingId));

    // Every position on every register that is not the player company's — funds,
    // characters, the float — and none of them may be on this list.
    for (const table of state.capTables) {
      for (const holding of table.holdings) {
        if (holding.holderId === PLAYER_COMPANY) continue;
        expect(mine.has(holding.id)).toBe(false);
      }
    }
    // The rival really does have other holders, so the check has something to bite on.
    const rivalTable = state.capTables.find((entry) => entry.companyId === RIVAL)!;
    expect(rivalTable.holdings.filter((holding) => holding.holderId !== PLAYER_COMPANY).length).toBeGreaterThan(0);
  });

  it('gives a fund holder no rows on the player\'s portfolio', () => {
    const state = afterPurchase();
    const fundPortfolio = portfolioOf(state, 'fund_seawall');
    // A fund is not a company: it holds shares but files no balance sheet, so
    // there is no investments line to reconcile against and the projection says
    // so rather than reporting a break against a line that does not exist.
    expect(fundPortfolio.stakes.length).toBeGreaterThan(0);
    expect(fundPortfolio.reconciliation.reconciles).toBe(true);
    expect(fundPortfolio.reconciliation.note).toContain('files no balance sheet');
    const playerPortfolio = portfolioOf(state, PLAYER_COMPANY);
    for (const row of fundPortfolio.stakes) {
      expect(playerPortfolio.stakes.some((entry) => entry.holdingId === row.holdingId)).toBe(false);
    }
  });

  it('returns the same rows for the same state', () => {
    const state = afterPurchase();
    expect(JSON.stringify(portfolioOf(state, PLAYER_COMPANY))).toBe(JSON.stringify(portfolioOf(state, PLAYER_COMPANY)));
    expect(JSON.stringify(founderPortfolioOf(state, DEMO_PLAYER_ID))).toBe(JSON.stringify(founderPortfolioOf(state, DEMO_PLAYER_ID)));
  });

  it('answers for the frozen world too, with nothing on it', () => {
    const state = createDemoSession();
    const player = state.players[0]!;
    const portfolio = portfolioOf(state, player.companyId);
    expect(portfolio.shorts).toEqual([]);
    expect(portfolio.funds).toEqual([]);
    // World 1 files no statements, so there is no carrying history to read.
    expect(portfolio.history).toEqual([]);
    expect(portfolio.totals.realisedUsd).toBeNull();
    expect(portfolio.reconciliation.reconciles).toBe(true);
  });
});
