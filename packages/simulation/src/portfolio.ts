/**
 * @frontier/simulation — portfolio.ts
 *
 * Everything a company owns that is not the company.
 *
 * Before this module the answer was scattered: `balanceSheet.assets.investments`
 * was one number, the positions behind it were rows on *other* companies' cap
 * tables, an acquired company was an inactive husk pointing at its parent, a
 * short lived on the hedge ledger, and the founder's own wealth was recomputed
 * in the web store. Five readings, none of which agreed on what "the portfolio"
 * meant. `portfolioOf` is the one projection that answers it, and every screen
 * that shows an outside asset reads it rather than adding a sixth.
 *
 * Four rules run through the file:
 *
 * - **Nothing is computed twice.** Prices come from the quote or the anchor the
 *   market phase wrote; a subsidiary's cost comes from the acquisition record
 *   the capital phase wrote; the founder's holdings are valued exactly as
 *   `founderWealthOf` values them, by importing it, so the portfolio and the
 *   leaderboard can never disagree.
 * - **The basis is stated, never assumed.** The engine carries investments at
 *   **cost**: `runSettlement` adds the consideration to the line on a purchase
 *   and removes the pro-rata carrying value on a sale. So the portfolio's cost
 *   total is what reconciles to the balance sheet, and market value is a second
 *   column beside it rather than a restatement of the first.
 * - **Redaction, never repair.** Rows are built only from positions the subject
 *   holds. A rival's undisclosed accumulation is not on this list because it is
 *   not this subject's, which is a stronger guarantee than filtering one out.
 * - **Pure.** No RNG, no clock, no mutation. Same state in, same rows out, in a
 *   deterministic order.
 */

import type {
  AcquisitionRecord,
  CapTable,
  CapitalEntity,
  CapitalEntityKind,
  Character,
  Company,
  Holding,
  Region,
  Sector,
  SessionState,
  ShortPosition,
} from '@frontier/contracts';
import { CONTROL_DECISIVE_PCT, ownershipThresholdFor } from '@frontier/contracts';
import { enterpriseValueOf, founderWealthOf } from './resolver/leaderboards';

/* -------------------------------------------------------------------------- */
/*  Row types                                                                  */
/* -------------------------------------------------------------------------- */

/** The four kinds of thing a company can own outside itself. */
export const PORTFOLIO_ROW_KINDS = ['subsidiary', 'stake', 'short', 'fund'] as const;
export type PortfolioRowKind = (typeof PORTFOLIO_ROW_KINDS)[number];

/**
 * What the validator will hear about a row.
 *
 * The row says which instructions are *shaped* for it — a listed company can be
 * bought, a position you hold can be sold, a majority you do not have can be
 * bid for. Whether one is allowed *this quarter* is the validator's answer and
 * nobody else's: the screen builds the intent and calls `validateAction`.
 */
export const PORTFOLIO_ACTIONS = ['buy_shares', 'sell_shares', 'acquire_company', 'propose_deal', 'submit_board_proposal'] as const;
export type PortfolioAction = (typeof PORTFOLIO_ACTIONS)[number];

/** Where a per-share figure came from. `none` means the world has not priced it. */
export type PriceBasis = 'quote' | 'anchor' | 'none';

/** A company this one controls: absorbed into it, or majority-owned and still standing. */
export interface PortfolioSubsidiaryRow {
  readonly kind: 'subsidiary';
  readonly companyId: string;
  readonly name: string;
  readonly sector: Sector;
  readonly region: Region;
  /**
   * `absorbed` — bought outright, its assets, staff and revenue merged into the
   * parent, leaving a husk. `controlled` — still a company, still filing, with
   * this holder past `CONTROL_DECISIVE_PCT` of its issued shares.
   */
  readonly status: 'absorbed' | 'controlled';
  readonly acquiredQuarter: number | null;
  /** Price paid: the acquisition record for an absorbed company, the cost basis for a controlled one. */
  readonly costUsd: number;
  /**
   * What the stake is worth now. Zero for an absorbed company on purpose: its
   * value is inside the parent's own cash, plant, goodwill and revenue, and
   * counting it again here would double-count the parent.
   */
  readonly valueUsd: number;
  readonly controlPct: number;
  readonly shares: number;
  readonly goodwillUsd: number;
  readonly dividendsUsd: number;
  /** Revenue and bottom line from the subsidiary's last filed quarter; zero once absorbed. */
  readonly lastRevenueUsd: number;
  readonly lastNetIncomeUsd: number;
  readonly isListed: boolean;
  readonly actions: readonly PortfolioAction[];
  /** One line saying what the value on this row means. */
  readonly note: string;
}

/** A minority position in another company's security. */
export interface PortfolioStakeRow {
  readonly kind: 'stake';
  readonly holdingId: string;
  readonly companyId: string;
  readonly securityId: string;
  readonly name: string;
  readonly sector: Sector;
  readonly region: Region;
  readonly shares: number;
  /** Fraction of issued shares across every class. */
  readonly ownershipPct: number;
  readonly costUsd: number;
  readonly valueUsd: number;
  readonly priceBasis: PriceBasis;
  readonly unrealisedUsd: number;
  readonly dividendsUsd: number;
  readonly acquiredQuarter: number;
  readonly lockupUntilQuarter: number | null;
  readonly isDisclosed: boolean;
  readonly isListed: boolean;
  /** Highest ownership threshold this position has crossed, or null below 5%. */
  readonly thresholdLabel: string | null;
  readonly actions: readonly PortfolioAction[];
}

/** An open cash-settled short. Never a holding, never a vote, never an ownership percentage. */
export interface PortfolioShortRow {
  readonly kind: 'short';
  readonly positionId: string;
  readonly companyId: string;
  readonly name: string;
  readonly shares: number;
  readonly openPriceUsd: number;
  readonly markPriceUsd: number;
  /** Shares multiplied by the mark: the exposure, not an asset. */
  readonly notionalUsd: number;
  /** Struck above the mark is a profit, which is why the subtraction runs this way round. */
  readonly unrealisedUsd: number;
  readonly marginPostedUsd: number;
  readonly borrowFeePctPerQuarter: number;
  readonly openedQuarter: number;
  readonly isDisclosed: boolean;
}

/** A position in a fund rather than in a company. */
export interface PortfolioFundRow {
  readonly kind: 'fund';
  readonly entityId: string;
  readonly name: string;
  readonly entityKind: CapitalEntityKind;
  readonly region: Region;
  /** The only role the game models: the partners run the fund. Limited partners are not modelled. */
  readonly role: 'general_partner';
  readonly committedCapitalUsd: number;
  readonly dryPowderUsd: number;
  /** Marked value of the book plus dry powder, from the economy report. Falls back to dry powder before the first mark. */
  readonly navUsd: number;
  readonly realisedProceedsUsd: number;
  /** Distributions plus current mark over committed capital, as a whole percentage. */
  readonly returnPct: number;
}

/* -------------------------------------------------------------------------- */
/*  Totals and reconciliation                                                  */
/* -------------------------------------------------------------------------- */

export interface PortfolioTotals {
  /** What every row cost. Subsidiaries at the price paid, stakes at their cost basis. */
  readonly costUsd: number;
  /** Subsidiaries plus stakes plus funds. Shorts are an exposure, not an asset, and are excluded. */
  readonly valueUsd: number;
  readonly unrealisedUsd: number;
  readonly dividendsUsd: number;
  /**
   * Cumulative gain or loss on stakes already sold, from the company's own
   * record. Null in a world that does not keep one — never zero, which would
   * claim every sale broke even.
   */
  readonly realisedUsd: number | null;
  /** The investments line itself: what the balance sheet carries, at cost. */
  readonly carryingUsd: number;
  /** The same line at the previous filed quarter, or null before two quarters exist. */
  readonly previousCarryingUsd: number | null;
  /** Quarter-on-quarter movement in the carrying line, or null when there is nothing to compare with. */
  readonly carryingChangeUsd: number | null;
  readonly subsidiariesValueUsd: number;
  readonly stakesValueUsd: number;
  readonly fundsValueUsd: number;
  readonly shortsNotionalUsd: number;
}

/**
 * How the rows line up against the balance sheet.
 *
 * The engine carries investments at **cost**, so the figure that must agree is
 * the stakes' cost basis, not their market value. It agrees as an inequality
 * rather than an equality, because a company can open the world already holding
 * an investments balance that no cap-table position backs — every world-2 seed
 * does — and an acquirer absorbs its target's whole investments line without
 * inheriting a single holding. `unattributedUsd` is exactly that remainder, and
 * naming it is the difference between reconciling and fudging.
 */
export interface PortfolioReconciliation {
  readonly basis: 'cost';
  readonly investmentsLineUsd: number;
  readonly stakesCostUsd: number;
  readonly unattributedUsd: number;
  readonly toleranceUsd: number;
  /** True when the attributed cost does not exceed the line it is part of. */
  readonly reconciles: boolean;
  readonly note: string;
}

/** One quarter of the carrying line, as the company filed it. */
export interface PortfolioValuePoint {
  readonly quarter: number;
  readonly carryingUsd: number;
}

export interface Portfolio {
  readonly companyId: string;
  readonly quarter: number;
  readonly subsidiaries: readonly PortfolioSubsidiaryRow[];
  readonly stakes: readonly PortfolioStakeRow[];
  readonly shorts: readonly PortfolioShortRow[];
  readonly funds: readonly PortfolioFundRow[];
  readonly totals: PortfolioTotals;
  readonly reconciliation: PortfolioReconciliation;
  /** The carrying line over the last `PORTFOLIO_HISTORY_QUARTERS` filed quarters, oldest first. */
  readonly history: readonly PortfolioValuePoint[];
}

/** One personal position, valued the way the founder-wealth board values it. */
export interface FounderHoldingRow {
  readonly holdingId: string;
  readonly companyId: string;
  readonly securityId: string;
  readonly name: string;
  readonly sector: Sector;
  readonly region: Region;
  readonly shares: number;
  readonly ownershipPct: number;
  readonly costUsd: number;
  readonly valueUsd: number;
  readonly unrealisedUsd: number;
  readonly dividendsUsd: number;
  readonly acquiredQuarter: number;
  readonly lockupUntilQuarter: number | null;
  readonly isOwnCompany: boolean;
  readonly isListed: boolean;
  readonly thresholdLabel: string | null;
  readonly actions: readonly PortfolioAction[];
}

export interface FounderPortfolio {
  readonly playerId: string | null;
  readonly characterId: string;
  readonly name: string;
  /** Cash and everything else held outside the register. */
  readonly cashUsd: number;
  readonly holdings: readonly FounderHoldingRow[];
  readonly funds: readonly PortfolioFundRow[];
  readonly holdingsValueUsd: number;
  /**
   * Personal cash plus the holdings. INVARIANT: equal to `founderWealthOf` for
   * the same character, because the rows are valued by the same function.
   */
  readonly netWorthUsd: number;
  /**
   * How the holdings are valued: enterprise value per issued share, which is
   * what the founder-wealth board uses. Deliberately *not* the quote the
   * Markets screen shows, because a net worth that disagreed with the board it
   * is ranked on would be the second computation this module exists to remove.
   */
  readonly basis: 'enterprise_value_per_share';
}

/* -------------------------------------------------------------------------- */
/*  Constants                                                                  */
/* -------------------------------------------------------------------------- */

/** How many filed quarters the carrying-value line shows. Two years. */
export const PORTFOLIO_HISTORY_QUARTERS = 8;

/** Dollars of slack allowed when checking the cost total against the investments line. */
export const PORTFOLIO_RECONCILIATION_TOLERANCE_USD = 1;

/* -------------------------------------------------------------------------- */
/*  Small shared helpers                                                       */
/* -------------------------------------------------------------------------- */

const money = (value: number): number => (Number.isFinite(value) ? Math.round(value) : 0);
const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Issued shares across every class on a register. */
function issuedSharesOf(table: CapTable): number {
  return table.shareClasses.reduce((sum, klass) => sum + klass.issuedShares, 0);
}

/** The last quote for an instrument, or null. Quotes are kept oldest-first per instrument. */
function lastQuotePriceUsd(state: SessionState, instrumentId: string | null): number | null {
  if (instrumentId === null) return null;
  let price: number | null = null;
  let at = -1;
  for (const quote of state.quotes) {
    if (quote.instrumentId !== instrumentId) continue;
    if (quote.quarter >= at) {
      at = quote.quarter;
      price = quote.price;
    }
  }
  return price !== null && price > 0 ? price : null;
}

/**
 * Price per share and where it came from: the tape when the company is listed,
 * the fundamental anchor when it is not. Identical in spirit to the web's
 * `perSharePrice`, and this is now the copy that matters.
 */
export function perSharePriceOf(state: SessionState, companyId: string): { readonly value: number; readonly basis: PriceBasis } {
  const company = state.companies.find((entry) => entry.id === companyId) ?? null;
  const quote = company === null ? null : lastQuotePriceUsd(state, company.instrumentId);
  if (quote !== null) return { value: quote, basis: 'quote' };
  const anchor = state.valuationAnchors.find((entry) => entry.companyId === companyId) ?? null;
  if (anchor !== null && anchor.perShareValueUsd !== null && anchor.perShareValueUsd > 0) {
    return { value: anchor.perShareValueUsd, basis: 'anchor' };
  }
  return { value: 0, basis: 'none' };
}

/** Market capitalisation from state: the quote when listed, the anchor when not. */
function marketValueOf(state: SessionState, company: Company): number {
  const price = perSharePriceOf(state, company.id);
  const table = state.capTables.find((entry) => entry.companyId === company.id) ?? null;
  const issued = table === null ? 0 : issuedSharesOf(table);
  if (price.basis !== 'none' && issued > 0) return money(price.value * issued);
  const metrics = state.companyMetrics.find((entry) => entry.companyId === company.id) ?? null;
  if (metrics !== null && metrics.marketCapUsd > 0) return money(metrics.marketCapUsd);
  const anchor = state.valuationAnchors.find((entry) => entry.companyId === company.id) ?? null;
  return money(anchor?.anchorValueUsd ?? 0);
}

/** The last quarter this company filed, or null when it files nothing. */
function lastFiledQuarter(company: Company) {
  const history = company.financialHistory ?? [];
  return history[history.length - 1] ?? null;
}

/** Every holding one holder has on one register, in a stable order. */
function holdingsOf(table: CapTable, holderId: string): Holding[] {
  return table.holdings.filter((holding) => holding.holderId === holderId && holding.shares > 0).sort((a, b) => compare(a.id, b.id));
}

/** Whether this security's company is quoted on the exchange. */
function isListed(company: Company | null): boolean {
  return company !== null && company.instrumentId !== null;
}

/**
 * Which instructions are shaped for a position.
 *
 * Shape only. Whether the board must approve it, whether the lock-up has run,
 * whether there is cash — all of that is the validator's, and the screen asks
 * it before offering the button.
 */
function actionsForStake(input: {
  readonly listed: boolean;
  readonly holdsShares: boolean;
  readonly controls: boolean;
  readonly targetActive: boolean;
  readonly ownController: boolean;
}): readonly PortfolioAction[] {
  const actions: PortfolioAction[] = [];
  if (input.listed && input.targetActive) actions.push('buy_shares');
  if (input.holdsShares && input.listed) actions.push('sell_shares');
  if (input.targetActive && !input.controls) actions.push('acquire_company');
  if (input.targetActive) actions.push('propose_deal');
  if (input.controls && input.ownController) actions.push('submit_board_proposal');
  return actions;
}

/* -------------------------------------------------------------------------- */
/*  portfolioOf                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Everything one company owns outside itself.
 *
 * Order is deterministic throughout: subsidiaries and stakes by descending
 * value then by id, shorts by company id, funds by entity id. A caller may sort
 * again for display; nothing downstream may depend on this order to be correct,
 * only to be stable.
 */
export function portfolioOf(state: SessionState, companyId: string): Portfolio {
  const owner = state.companies.find((entry) => entry.id === companyId) ?? null;
  const subsidiaries: PortfolioSubsidiaryRow[] = [];
  const stakes: PortfolioStakeRow[] = [];

  const controlsOwnBoard = owner !== null && owner.controllerPlayerId !== null;

  for (const table of state.capTables) {
    if (table.companyId === companyId) continue;
    const target = state.companies.find((entry) => entry.id === table.companyId) ?? null;
    if (target === null) continue;

    const issued = issuedSharesOf(table);
    const held = holdingsOf(table, companyId);
    const shares = held.reduce((sum, holding) => sum + holding.shares, 0);
    const pct = issued > 0 ? shares / issued : 0;
    const dividends = held.reduce((sum, holding) => sum + (holding.dividendsReceivedUsd ?? 0), 0);
    const cost = held.reduce((sum, holding) => sum + holding.costBasisUsd, 0);

    // Majority of a company still standing is a subsidiary, not a stake: it
    // consolidates in every sense that matters to a founder reading a list.
    if (shares > 0 && pct > CONTROL_DECISIVE_PCT && target.isActive) {
      const filed = lastFiledQuarter(target);
      subsidiaries.push({
        kind: 'subsidiary',
        companyId: target.id,
        name: target.name,
        sector: target.sector,
        region: target.region,
        status: 'controlled',
        acquiredQuarter: held[0]?.acquiredQuarter ?? null,
        costUsd: money(cost),
        valueUsd: money(pct * marketValueOf(state, target)),
        controlPct: pct,
        shares,
        goodwillUsd: 0,
        dividendsUsd: money(dividends),
        lastRevenueUsd: money(filed?.income.revenueUsd ?? target.financials.revenueQuarterly),
        lastNetIncomeUsd: money(filed?.income.netIncomeUsd ?? 0),
        isListed: isListed(target),
        actions: actionsForStake({ listed: isListed(target), holdsShares: true, controls: true, targetActive: true, ownController: controlsOwnBoard }),
        note: 'Majority-held and still filing its own accounts. Value is your share of what the market makes it worth.',
      });
      continue;
    }

    if (shares <= 0) continue;
    const price = perSharePriceOf(state, target.id);
    const value = money(shares * price.value);
    const first = held[0] as Holding;
    stakes.push({
      kind: 'stake',
      holdingId: first.id,
      companyId: target.id,
      securityId: first.securityId,
      name: target.name,
      sector: target.sector,
      region: target.region,
      shares,
      ownershipPct: pct,
      costUsd: money(cost),
      valueUsd: value,
      priceBasis: price.basis,
      unrealisedUsd: money(value - cost),
      dividendsUsd: money(dividends),
      acquiredQuarter: first.acquiredQuarter,
      lockupUntilQuarter: first.lockupUntilQuarter,
      isDisclosed: held.some((holding) => holding.isDisclosed),
      isListed: isListed(target),
      thresholdLabel: ownershipThresholdFor(pct)?.label ?? null,
      actions: actionsForStake({
        listed: isListed(target),
        holdsShares: true,
        controls: false,
        targetActive: target.isActive,
        ownController: controlsOwnBoard,
      }),
    });
  }

  // Companies bought outright. The husk keeps its name, its sector and the
  // record of what it cost; everything else moved to the parent in the quarter
  // it was absorbed, which is why the row's value is zero and says so.
  for (const company of state.companies) {
    if (company.parentCompanyId !== companyId || company.isActive) continue;
    const record: AcquisitionRecord | null = company.acquisition ?? null;
    subsidiaries.push({
      kind: 'subsidiary',
      companyId: company.id,
      name: company.name,
      sector: company.sector,
      region: company.region,
      status: 'absorbed',
      acquiredQuarter: record?.quarter ?? null,
      costUsd: money(record?.priceUsd ?? 0),
      valueUsd: 0,
      controlPct: 1,
      shares: 0,
      goodwillUsd: money(record?.goodwillUsd ?? 0),
      dividendsUsd: 0,
      lastRevenueUsd: 0,
      lastNetIncomeUsd: 0,
      isListed: false,
      actions: [],
      note: 'Absorbed. Its cash, staff, products and revenue are inside your own accounts, so it carries no separate value here.',
    });
  }

  const shorts: PortfolioShortRow[] = (state.shortPositions ?? [])
    .filter((position: ShortPosition) => position.entityId === companyId)
    .map((position) => {
      const target = state.companies.find((entry) => entry.id === position.companyId) ?? null;
      return {
        kind: 'short' as const,
        positionId: position.id,
        companyId: position.companyId,
        name: target?.name ?? position.companyId,
        shares: position.shares,
        openPriceUsd: position.openPriceUsd,
        markPriceUsd: position.markPriceUsd,
        notionalUsd: money(position.shares * position.markPriceUsd),
        unrealisedUsd: money(position.shares * (position.openPriceUsd - position.markPriceUsd)),
        marginPostedUsd: money(position.marginPostedUsd),
        borrowFeePctPerQuarter: position.borrowFeePctPerQuarter,
        openedQuarter: position.openedQuarter,
        isDisclosed: position.isDisclosed,
      };
    })
    .sort((a, b) => compare(a.positionId, b.positionId));

  // A company is not modelled as a limited partner in anybody's fund, so this
  // is empty for a company and populated only for a founder who is a partner.
  // Empty rather than absent: the tab exists, and saying "none" is information.
  const funds: PortfolioFundRow[] = [];

  subsidiaries.sort((a, b) => (b.valueUsd !== a.valueUsd ? b.valueUsd - a.valueUsd : compare(a.companyId, b.companyId)));
  stakes.sort((a, b) => (b.valueUsd !== a.valueUsd ? b.valueUsd - a.valueUsd : compare(a.holdingId, b.holdingId)));

  const stakesValue = stakes.reduce((sum, row) => sum + row.valueUsd, 0);
  const subsidiariesValue = subsidiaries.reduce((sum, row) => sum + row.valueUsd, 0);
  const stakesCost = stakes.reduce((sum, row) => sum + row.costUsd, 0);
  const subsidiaryStakeCost = subsidiaries.reduce((sum, row) => sum + (row.status === 'controlled' ? row.costUsd : 0), 0);
  const cost = stakesCost + subsidiaries.reduce((sum, row) => sum + row.costUsd, 0);
  const dividends = stakes.reduce((sum, row) => sum + row.dividendsUsd, 0) + subsidiaries.reduce((sum, row) => sum + row.dividendsUsd, 0);

  const carrying = money(owner?.balanceSheet.assets.investments ?? 0);
  const history = carryingHistory(owner);
  const previous = history.length >= 2 ? (history[history.length - 2]?.carryingUsd ?? null) : null;

  // Both a controlled subsidiary and a minority stake sit on the investments
  // line — the engine books every share purchase there — so both count toward
  // the attributed cost. An absorbed company does not: its consideration became
  // goodwill and the assets it brought with it, never an investment.
  const attributedCost = money(stakesCost + subsidiaryStakeCost);

  return {
    companyId,
    quarter: state.quarter,
    subsidiaries,
    stakes,
    shorts,
    funds,
    totals: {
      costUsd: money(cost),
      valueUsd: money(stakesValue + subsidiariesValue),
      unrealisedUsd: money(stakesValue + subsidiariesValue - stakesCost - subsidiaryStakeCost),
      dividendsUsd: money(dividends),
      realisedUsd: owner?.realisedInvestmentGainsUsd === undefined ? null : money(owner.realisedInvestmentGainsUsd),
      carryingUsd: carrying,
      previousCarryingUsd: previous,
      carryingChangeUsd: previous === null ? null : money(carrying - previous),
      subsidiariesValueUsd: money(subsidiariesValue),
      stakesValueUsd: money(stakesValue),
      fundsValueUsd: 0,
      shortsNotionalUsd: money(shorts.reduce((sum, row) => sum + row.notionalUsd, 0)),
    },
    reconciliation: {
      basis: 'cost',
      investmentsLineUsd: carrying,
      stakesCostUsd: attributedCost,
      unattributedUsd: money(carrying - attributedCost),
      toleranceUsd: PORTFOLIO_RECONCILIATION_TOLERANCE_USD,
      // A holder that is not a company — a fund, asked about its own book — has
      // no balance sheet to reconcile against, so there is nothing to fail. It
      // reconciles vacuously rather than reporting a break against a line that
      // does not exist.
      reconciles: owner === null || attributedCost <= carrying + PORTFOLIO_RECONCILIATION_TOLERANCE_USD,
      note:
        owner === null
          ? 'This holder is not a company and files no balance sheet, so there is no investments line to reconcile against.'
          : 'Investments are carried at cost. Anything the line holds beyond the positions listed here was on the opening balance sheet or came in with an acquired company.',
    },
    history,
  };
}

/**
 * The carrying line over the last filed quarters.
 *
 * Derived, not stored: the financial phase already files the investments half of
 * other assets on every closed quarter, so a second history on the company would
 * be a copy that could drift. A statement filed before the line was split out
 * carries no figure, and a quarter with no figure is absent rather than zero.
 */
function carryingHistory(company: Company | null): PortfolioValuePoint[] {
  if (company === null) return [];
  const out: PortfolioValuePoint[] = [];
  for (const entry of company.financialHistory ?? []) {
    const value = entry.balance.investmentsUsd;
    if (value === undefined) continue;
    out.push({ quarter: entry.quarter, carryingUsd: money(value) });
  }
  return out.slice(-PORTFOLIO_HISTORY_QUARTERS);
}

/* -------------------------------------------------------------------------- */
/*  founderPortfolioOf                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Everything one founder owns personally, their own company's shares included.
 *
 * The valuation basis is the founder-wealth board's, not the exchange's, and
 * that is the whole point: `netWorthUsd` is `founderWealthOf` decomposed into
 * rows, so the number on the status bar and the number on the leaderboard are
 * the same arithmetic run once. A row priced off the tape would look more
 * "correct" and would immediately disagree with the board the founder is ranked
 * on, which is the failure this projection exists to prevent.
 */
export function founderPortfolioOf(state: SessionState, playerId: string): FounderPortfolio {
  const seat = state.players.find((entry) => entry.playerId === playerId) ?? null;
  const character =
    (seat === null ? null : state.characters.find((entry) => entry.id === seat.characterId) ?? null) ??
    state.characters.find((entry) => entry.isPlayer) ??
    null;

  if (character === null) {
    return {
      playerId: seat?.playerId ?? null,
      characterId: '',
      name: '',
      cashUsd: 0,
      holdings: [],
      funds: [],
      holdingsValueUsd: 0,
      netWorthUsd: 0,
      basis: 'enterprise_value_per_share',
    };
  }

  const ownCompanyId = seat?.companyId ?? character.companyId ?? null;
  const holdings: FounderHoldingRow[] = [];

  for (const table of state.capTables) {
    const target = state.companies.find((entry) => entry.id === table.companyId) ?? null;
    if (target === null) continue;
    const held = holdingsOf(table, character.id);
    if (held.length === 0) continue;

    const issued = issuedSharesOf(table);
    const shares = held.reduce((sum, holding) => sum + holding.shares, 0);
    const pct = issued > 0 ? shares / issued : 0;
    // The board's own per-share figure, so a row and the board agree by
    // construction rather than by coincidence.
    const perShare = issued > 0 ? enterpriseValueOf(state, target) / issued : 0;
    const value = money(shares * perShare);
    const cost = held.reduce((sum, holding) => sum + holding.costBasisUsd, 0);
    const first = held[0] as Holding;

    holdings.push({
      holdingId: first.id,
      companyId: target.id,
      securityId: first.securityId,
      name: target.name,
      sector: target.sector,
      region: target.region,
      shares,
      ownershipPct: pct,
      costUsd: money(cost),
      valueUsd: value,
      unrealisedUsd: money(value - cost),
      dividendsUsd: money(held.reduce((sum, holding) => sum + (holding.dividendsReceivedUsd ?? 0), 0)),
      acquiredQuarter: first.acquiredQuarter,
      lockupUntilQuarter: first.lockupUntilQuarter,
      isOwnCompany: target.id === ownCompanyId,
      isListed: isListed(target),
      thresholdLabel: ownershipThresholdFor(pct)?.label ?? null,
      actions: actionsForStake({
        listed: isListed(target),
        holdsShares: true,
        controls: pct > CONTROL_DECISIVE_PCT,
        targetActive: target.isActive,
        ownController: target.id === ownCompanyId,
      }),
    });
  }

  holdings.sort((a, b) => (b.valueUsd !== a.valueUsd ? b.valueUsd - a.valueUsd : compare(a.holdingId, b.holdingId)));

  const funds = fundRowsFor(state, character);

  return {
    playerId: seat?.playerId ?? null,
    characterId: character.id,
    name: character.name,
    cashUsd: money(character.personalWealthUsd),
    holdings,
    funds,
    holdingsValueUsd: money(holdings.reduce((sum, row) => sum + row.valueUsd, 0)),
    // Rounded from the board's own figure rather than from the rows: the rows
    // round individually, and eight rounded rows do not sum to the rounding of
    // their sum. The board is the number that must match.
    netWorthUsd: money(founderWealthOf(state, character)),
    basis: 'enterprise_value_per_share',
  };
}

/**
 * The funds this person runs.
 *
 * Being a partner is the only fund position the game models — nobody in this
 * world is somebody else's limited partner — so a founder who is not on a
 * partner roster has no fund rows, and that is a fact rather than a gap.
 */
function fundRowsFor(state: SessionState, character: Character): PortfolioFundRow[] {
  const rows = state.economyReport?.capitalEntities ?? [];
  return (state.capitalEntities ?? [])
    .filter((entity: CapitalEntity) => entity.partnerCharacterIds.includes(character.id))
    .map((entity) => {
      const marked = rows.find((row) => row.entityId === entity.id) ?? null;
      const nav = marked?.navUsd ?? entity.dryPowderUsd;
      return {
        kind: 'fund' as const,
        entityId: entity.id,
        name: entity.name,
        entityKind: entity.kind,
        region: entity.region,
        role: 'general_partner' as const,
        committedCapitalUsd: money(entity.committedCapitalUsd),
        dryPowderUsd: money(entity.dryPowderUsd),
        navUsd: money(nav),
        realisedProceedsUsd: money(entity.realisedProceedsUsd),
        returnPct: Math.round((100 * (entity.realisedProceedsUsd + nav)) / Math.max(1, entity.committedCapitalUsd)),
      };
    })
    .sort((a, b) => compare(a.entityId, b.entityId));
}
