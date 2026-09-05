/**
 * Reading the portfolio.
 *
 * Every number on the Portfolio screen comes from `portfolioOf` or
 * `founderPortfolioOf` in the engine. This file computes nothing economic: it
 * turns rows into the words and tones a card shows, and it is a separate module
 * from the components so those sentences can be tested without rendering React.
 *
 * The one arithmetic here is presentational and says so: a gain over cost as a
 * whole percentage, which is a ratio of two figures the engine already stated.
 */

import type {
  FounderHoldingRow,
  Portfolio,
  PortfolioAction,
  PortfolioFundRow,
  PortfolioShortRow,
  PortfolioStakeRow,
  PortfolioSubsidiaryRow,
} from '@frontier/simulation';
import { formatMoney } from '@frontier/shared';
import type { IconName, Tone } from '@/components/ui';

/* -------------------------------------------------------------------------- */
/*  Tabs                                                                       */
/* -------------------------------------------------------------------------- */

export const PORTFOLIO_TABS = ['subsidiaries', 'stakes', 'shorts', 'funds'] as const;
export type PortfolioTab = (typeof PORTFOLIO_TABS)[number];

export const TAB_LABEL: Readonly<Record<PortfolioTab, string>> = {
  subsidiaries: 'Subsidiaries',
  stakes: 'Stakes',
  shorts: 'Shorts',
  funds: 'Funds',
};

export const TAB_ICON: Readonly<Record<PortfolioTab, IconName>> = {
  subsidiaries: 'building',
  stakes: 'coins',
  shorts: 'chart',
  funds: 'vault',
};

/** How many rows each tab holds, so the tab strip can print counts. */
export function tabCounts(portfolio: Portfolio): Readonly<Record<PortfolioTab, number>> {
  return {
    subsidiaries: portfolio.subsidiaries.length,
    stakes: portfolio.stakes.length,
    shorts: portfolio.shorts.length,
    funds: portfolio.funds.length,
  };
}

/**
 * The tab a screen should open on: the first one with anything in it.
 *
 * Landing on an empty Subsidiaries tab when the player holds four stakes is the
 * screen telling them they own nothing, which is false.
 */
export function firstPopulatedTab(portfolio: Portfolio): PortfolioTab {
  const counts = tabCounts(portfolio);
  return PORTFOLIO_TABS.find((tab) => counts[tab] > 0) ?? 'stakes';
}

/* -------------------------------------------------------------------------- */
/*  Figures                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Gain over cost as a whole percentage, or null when nothing was paid.
 *
 * Null rather than zero on a free position: "0%" claims it broke even, and a
 * position with no cost basis has no return to state.
 */
export function gainPct(costUsd: number, valueUsd: number): number | null {
  if (costUsd <= 0) return null;
  return Math.round((100 * (valueUsd - costUsd)) / costUsd);
}

/** Whole percent, already computed, as the string a card prints. */
export function pctLabel(value: number | null): string {
  if (value === null) return '—';
  return `${value > 0 ? '+' : ''}${value}%`;
}

/** Profit is a gain, loss is a loss, flat is neutral. */
export function gainTone(value: number | null): Tone {
  if (value === null || value === 0) return 'neutral';
  return value > 0 ? 'gain' : 'loss';
}

/** A whole-percentage ownership figure from a fraction. */
export function ownershipLabel(fraction: number): string {
  const whole = Math.round(fraction * 100);
  // Below half a point a stake still exists; saying "0%" would deny it.
  if (whole === 0 && fraction > 0) return 'under 1%';
  return `${whole}%`;
}

/* -------------------------------------------------------------------------- */
/*  Sentences                                                                  */
/* -------------------------------------------------------------------------- */

/** What the headline figure is made of, in one line. */
export function totalsLine(portfolio: Portfolio): string {
  const parts: string[] = [];
  if (portfolio.subsidiaries.length > 0) parts.push(`${portfolio.subsidiaries.length} controlled`);
  if (portfolio.stakes.length > 0) parts.push(`${portfolio.stakes.length} held`);
  if (portfolio.shorts.length > 0) parts.push(`${portfolio.shorts.length} short`);
  if (portfolio.funds.length > 0) parts.push(`${portfolio.funds.length} fund${portfolio.funds.length === 1 ? '' : 's'}`);
  if (parts.length === 0) return 'Nothing held outside the company';
  return parts.join(' · ');
}

/**
 * How the rows sit against the balance sheet, said plainly.
 *
 * The engine carries investments at cost, and it is the reconciliation, not this
 * sentence, that decides whether the words are true.
 */
export function reconciliationLine(portfolio: Portfolio): string {
  const { investmentsLineUsd, stakesCostUsd, unattributedUsd } = portfolio.reconciliation;
  if (investmentsLineUsd === 0 && stakesCostUsd === 0) return 'Nothing sits on the investments line.';
  if (unattributedUsd <= 0) {
    return `Every dollar of the ${formatMoney(investmentsLineUsd)} investments line is a position listed here, at cost.`;
  }
  return `${formatMoney(stakesCostUsd)} of the ${formatMoney(investmentsLineUsd)} investments line is listed here at cost; ${formatMoney(
    unattributedUsd,
  )} came in with an acquired company or was on the opening balance sheet.`;
}

/** The line under a subsidiary card. */
export function subsidiaryLine(row: PortfolioSubsidiaryRow): string {
  if (row.status === 'absorbed') return row.note;
  return `${ownershipLabel(row.controlPct)} held. ${row.note}`;
}

/** The line under a stake card: what the mark is, and whether anyone knows. */
export function stakeLine(row: PortfolioStakeRow): string {
  const mark = row.priceBasis === 'quote' ? 'Marked to the tape' : row.priceBasis === 'anchor' ? 'Marked to the fundamental anchor' : 'Unpriced';
  const disclosure = row.isDisclosed ? 'disclosed' : 'below the disclosure threshold';
  return `${mark} · ${disclosure}`;
}

/** The line under a short card. A short is exposure, not an asset, and says so. */
export function shortLine(row: PortfolioShortRow): string {
  return `${formatMoney(row.notionalUsd)} of exposure at ${row.borrowFeePctPerQuarter}% borrow a quarter. Cash-settled: it is not an asset and carries no vote.`;
}

/** The line under a fund card. */
export function fundLine(row: PortfolioFundRow): string {
  return `${formatMoney(row.dryPowderUsd)} still to deploy · ${formatMoney(row.realisedProceedsUsd)} returned`;
}

/** What a lock-up means on a row, or null when there is none in force. */
export function lockupLine(lockupUntilQuarter: number | null, quarter: number): string | null {
  if (lockupUntilQuarter === null || quarter >= lockupUntilQuarter) return null;
  const left = lockupUntilQuarter - quarter;
  return `Locked for ${left} more quarter${left === 1 ? '' : 's'}; it cannot be sold before then.`;
}

/* -------------------------------------------------------------------------- */
/*  Actions                                                                    */
/* -------------------------------------------------------------------------- */

export const ACTION_LABEL: Readonly<Record<PortfolioAction, string>> = {
  buy_shares: 'Buy more',
  sell_shares: 'Sell',
  acquire_company: 'Bid for the whole company',
  propose_deal: 'Propose a deal',
  submit_board_proposal: 'Table a board matter',
};

/**
 * Where an action is carried out.
 *
 * Trading and bidding happen on this screen, against the row you are looking at.
 * A deal and a board matter are long-form instruments with their own screens,
 * and duplicating those tickets here would be a second copy of two forms that
 * already exist — so those two are offered as the route to the screen that owns
 * them.
 *
 * The link carries no target in the query string, deliberately: neither screen
 * reads one, and a URL that promises a preselection it does not make is worse
 * than a plain one. `companyId` is taken so a future preselection changes this
 * function and nothing else.
 */
export function actionHref(action: PortfolioAction, companyId: string): string | null {
  void companyId;
  switch (action) {
    case 'propose_deal':
      return '/deal-room';
    case 'submit_board_proposal':
      return '/boardroom';
    default:
      return null;
  }
}

/** The founder's own company is the row a founder reads first. */
export function founderHoldingLine(row: FounderHoldingRow): string {
  const own = row.isOwnCompany ? 'Your own company' : row.isListed ? 'Listed' : 'Privately held';
  return `${own} · ${ownershipLabel(row.ownershipPct)} of the register`;
}
