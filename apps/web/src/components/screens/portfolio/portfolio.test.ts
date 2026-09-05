/**
 * The Portfolio screen's reading layer.
 *
 * These are the sentences and tones a founder actually reads, and they are
 * tested away from React because a string that says the wrong thing about money
 * is a bug whether or not it renders. The rows themselves come from the engine
 * and are pinned in `packages/simulation/test/portfolio.test.ts`; here the
 * fixtures are hand-built so each claim is about one reading and not about the
 * world that produced it.
 */

import { describe, expect, it } from 'vitest';
import type { Portfolio, PortfolioShortRow, PortfolioStakeRow, PortfolioSubsidiaryRow } from '@frontier/simulation';
import {
  PORTFOLIO_TABS,
  actionHref,
  firstPopulatedTab,
  gainPct,
  gainTone,
  lockupLine,
  ownershipLabel,
  pctLabel,
  reconciliationLine,
  shortLine,
  stakeLine,
  subsidiaryLine,
  tabCounts,
  totalsLine,
} from './rows';

/* -------------------------------------------------------------------------- */
/*  Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

const stake: PortfolioStakeRow = {
  kind: 'stake',
  holdingId: 'hld_1',
  companyId: 'cmp_rival',
  securityId: 'sec_rival',
  name: 'Rival Systems',
  sector: 'ai',
  region: 'north_america',
  shares: 1_000,
  ownershipPct: 0.03,
  costUsd: 1_000_000,
  valueUsd: 1_400_000,
  priceBasis: 'quote',
  unrealisedUsd: 400_000,
  dividendsUsd: 25_000,
  acquiredQuarter: 2,
  lockupUntilQuarter: null,
  isDisclosed: false,
  isListed: true,
  thresholdLabel: null,
  actions: ['buy_shares', 'sell_shares', 'acquire_company', 'propose_deal'],
};

const subsidiary: PortfolioSubsidiaryRow = {
  kind: 'subsidiary',
  companyId: 'cmp_bought',
  name: 'Bought Ltd',
  sector: 'robotics',
  region: 'europe',
  status: 'absorbed',
  acquiredQuarter: 3,
  costUsd: 90_000_000,
  valueUsd: 0,
  controlPct: 1,
  shares: 0,
  goodwillUsd: 20_000_000,
  dividendsUsd: 0,
  lastRevenueUsd: 0,
  lastNetIncomeUsd: 0,
  isListed: false,
  actions: [],
  note: 'Absorbed. Its cash, staff, products and revenue are inside your own accounts, so it carries no separate value here.',
};

const short: PortfolioShortRow = {
  kind: 'short',
  positionId: 'shp_1',
  companyId: 'cmp_rival',
  name: 'Rival Systems',
  shares: 500,
  openPriceUsd: 40,
  markPriceUsd: 30,
  notionalUsd: 15_000,
  unrealisedUsd: 5_000,
  marginPostedUsd: 8_000,
  borrowFeePctPerQuarter: 4,
  openedQuarter: 1,
  isDisclosed: false,
};

function portfolio(overrides: Partial<Portfolio> = {}): Portfolio {
  return {
    companyId: 'cmp_player',
    quarter: 4,
    subsidiaries: [],
    stakes: [],
    shorts: [],
    funds: [],
    totals: {
      costUsd: 0,
      valueUsd: 0,
      unrealisedUsd: 0,
      dividendsUsd: 0,
      realisedUsd: null,
      carryingUsd: 0,
      previousCarryingUsd: null,
      carryingChangeUsd: null,
      subsidiariesValueUsd: 0,
      stakesValueUsd: 0,
      fundsValueUsd: 0,
      shortsNotionalUsd: 0,
    },
    reconciliation: {
      basis: 'cost',
      investmentsLineUsd: 0,
      stakesCostUsd: 0,
      unattributedUsd: 0,
      toleranceUsd: 1,
      reconciles: true,
      note: '',
    },
    history: [],
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/*  Figures                                                                    */
/* -------------------------------------------------------------------------- */

describe('the gain on a position', () => {
  it('is a whole percentage of what was paid', () => {
    expect(gainPct(1_000_000, 1_400_000)).toBe(40);
    expect(gainPct(1_000_000, 600_000)).toBe(-40);
    expect(pctLabel(40)).toBe('+40%');
    expect(pctLabel(-40)).toBe('-40%');
  });

  it('is absent rather than zero on a position that cost nothing', () => {
    // "0%" would claim it broke even. A free position has no return to state.
    expect(gainPct(0, 500_000)).toBeNull();
    expect(pctLabel(null)).toBe('—');
    expect(gainTone(null)).toBe('neutral');
  });

  it('colours a profit and a loss and nothing else', () => {
    expect(gainTone(12)).toBe('gain');
    expect(gainTone(-12)).toBe('loss');
    expect(gainTone(0)).toBe('neutral');
  });
});

describe('an ownership percentage', () => {
  it('is a whole number', () => {
    expect(ownershipLabel(0.26)).toBe('26%');
    expect(ownershipLabel(1)).toBe('100%');
    expect(ownershipLabel(0)).toBe('0%');
  });

  it('never rounds a real stake down to nothing', () => {
    expect(ownershipLabel(0.002)).toBe('under 1%');
  });
});

/* -------------------------------------------------------------------------- */
/*  Tabs                                                                       */
/* -------------------------------------------------------------------------- */

describe('the tab strip', () => {
  it('counts every kind', () => {
    const counts = tabCounts(portfolio({ stakes: [stake], subsidiaries: [subsidiary], shorts: [short] }));
    expect(counts).toEqual({ subsidiaries: 1, stakes: 1, shorts: 1, funds: 0 });
    expect(PORTFOLIO_TABS).toHaveLength(4);
  });

  it('opens on the first tab that has anything in it', () => {
    expect(firstPopulatedTab(portfolio({ stakes: [stake] }))).toBe('stakes');
    expect(firstPopulatedTab(portfolio({ subsidiaries: [subsidiary], stakes: [stake] }))).toBe('subsidiaries');
    expect(firstPopulatedTab(portfolio({ shorts: [short] }))).toBe('shorts');
  });

  it('falls back to stakes when nothing is held, rather than to an empty first tab', () => {
    expect(firstPopulatedTab(portfolio())).toBe('stakes');
  });
});

/* -------------------------------------------------------------------------- */
/*  Sentences                                                                  */
/* -------------------------------------------------------------------------- */

describe('what the screen says', () => {
  it('summarises what is held', () => {
    expect(totalsLine(portfolio())).toBe('Nothing held outside the company');
    expect(totalsLine(portfolio({ stakes: [stake], subsidiaries: [subsidiary] }))).toBe('1 controlled · 1 held');
  });

  it('states the reconciliation in money, not in jargon', () => {
    const clean = reconciliationLine(
      portfolio({
        reconciliation: { basis: 'cost', investmentsLineUsd: 1_000_000, stakesCostUsd: 1_000_000, unattributedUsd: 0, toleranceUsd: 1, reconciles: true, note: '' },
      }),
    );
    expect(clean).toContain('Every dollar');

    const mixed = reconciliationLine(
      portfolio({
        reconciliation: { basis: 'cost', investmentsLineUsd: 1_000_000, stakesCostUsd: 600_000, unattributedUsd: 400_000, toleranceUsd: 1, reconciles: true, note: '' },
      }),
    );
    expect(mixed).toContain('acquired company');
    expect(mixed).toContain('opening balance sheet');
  });

  it('says nothing about a line that does not exist', () => {
    expect(reconciliationLine(portfolio())).toBe('Nothing sits on the investments line.');
  });

  it('says how a stake is marked and whether anyone knows about it', () => {
    expect(stakeLine(stake)).toBe('Marked to the tape · below the disclosure threshold');
    expect(stakeLine({ ...stake, priceBasis: 'anchor', isDisclosed: true })).toBe('Marked to the fundamental anchor · disclosed');
    expect(stakeLine({ ...stake, priceBasis: 'none' })).toContain('Unpriced');
  });

  it('says an absorbed subsidiary carries no separate value', () => {
    expect(subsidiaryLine(subsidiary)).toBe(subsidiary.note);
    expect(subsidiaryLine({ ...subsidiary, status: 'controlled', controlPct: 0.62, note: 'Still filing.' })).toBe('62% held. Still filing.');
  });

  it('says a short is exposure rather than an asset', () => {
    expect(shortLine(short)).toContain('not an asset');
    expect(shortLine(short)).toContain('4% borrow');
  });

  it('warns about a lock-up only while one is in force', () => {
    expect(lockupLine(null, 4)).toBeNull();
    expect(lockupLine(3, 4)).toBeNull();
    expect(lockupLine(5, 4)).toBe('Locked for 1 more quarter; it cannot be sold before then.');
    expect(lockupLine(8, 4)).toBe('Locked for 4 more quarters; it cannot be sold before then.');
  });
});

/* -------------------------------------------------------------------------- */
/*  Where an action happens                                                    */
/* -------------------------------------------------------------------------- */

describe('where an instruction is carried out', () => {
  it('keeps trading and bidding on this screen', () => {
    expect(actionHref('buy_shares', 'cmp_rival')).toBeNull();
    expect(actionHref('sell_shares', 'cmp_rival')).toBeNull();
    expect(actionHref('acquire_company', 'cmp_rival')).toBeNull();
  });

  it('sends the two long-form instruments to the screens that own them', () => {
    // No target in the query string: neither screen reads one, and a URL that
    // promises a preselection it does not make is worse than a plain one.
    expect(actionHref('propose_deal', 'cmp_rival')).toBe('/deal-room');
    expect(actionHref('submit_board_proposal', 'cmp_rival')).toBe('/boardroom');
  });
});
