/**
 * @frontier/simulation — group.ts
 *
 * STAGE 4's third deliverable: the group statement.
 *
 * `Company.financialHistory` already carries a fully reconciled income
 * statement, balance sheet and cash flow for one company, filed by the
 * financial phase (`companies/financials.ts` → `companies/history.ts`) and
 * never recomputed elsewhere. `groupStatementOf` does not re-derive any of
 * that arithmetic — depreciation, tax, the revenue split — a second time; it
 * takes each controlled company's own latest filed statement and combines
 * them, which is the only new arithmetic a *group* statement needs:
 *
 * - **Income and cash flow sum without elimination**, and that is not an
 *   omission. A dividend a subsidiary pays a parent never touches either
 *   company's income statement (`resolver/capital.ts` books it straight to
 *   cash and equity), and a `transfer_between_group` this stage adds moves
 *   only cash or compute, the same way — so both cancel in the sum by
 *   construction, one member's outflow against another member's inflow.
 *   Ordinary commercial sales between two companies that happen to share a
 *   controller are deliberately left as real, priced transactions: the
 *   owner's second north star is that an input is always a real transaction
 *   between two named companies, and group membership does not suspend that.
 * - **The balance sheet needs one real elimination.** A parent's `investments`
 *   line carries a subsidiary's shares at cost; summing it alongside the
 *   subsidiary's own assets and liabilities would count that value twice. The
 *   intra-group cost basis — read off the live cap tables, not the filed
 *   statement — is subtracted from both assets and equity together, which is
 *   the one adjustment that keeps `assets - liabilities = equity` intact.
 * - **Minority interest** is what is left of a non-founding member's own
 *   filed equity after the group's ownership share of it: a majority stake
 *   short of 100% still means somebody else owns the rest.
 *
 * Deterministic and pure: no RNG, no clock, no mutation. Redacted like
 * everything else — this reads only the calling seat's own controlled
 * companies, from `controlledCompaniesOf`.
 */

import type {
  FinancialBalanceSheet,
  FinancialCashFlow,
  FinancialIncomeStatement,
  SessionState,
} from '@frontier/contracts';
import { isMultiSectorWorld } from './economy/sectors';
import { controlledCompaniesOf } from './companies/control';
import { recentFinancialQuarters } from './companies/history';

/** The consolidated accounts for one seat's group, for one quarter. */
export interface GroupStatement {
  /** The quarter these accounts were last filed for. Null when nothing has filed yet. */
  readonly quarter: number | null;
  /** Every company folded in, founding company first — `controlledCompaniesOf`'s own order. */
  readonly companyIds: readonly string[];
  readonly income: FinancialIncomeStatement;
  readonly balance: FinancialBalanceSheet;
  readonly cashFlow: FinancialCashFlow;
  /** The slice of consolidated equity that belongs to holders outside the group. */
  readonly minorityInterestUsd: number;
  /** INVARIANT: balance.equityUsd - minorityInterestUsd = equityAttributableToGroupUsd. */
  readonly equityAttributableToGroupUsd: number;
}

const ZERO_INCOME: FinancialIncomeStatement = {
  revenueUsd: 0,
  cogsUsd: 0,
  grossProfitUsd: 0,
  opexUsd: 0,
  ebitdaUsd: 0,
  depreciationUsd: 0,
  operatingIncomeUsd: 0,
  interestUsd: 0,
  taxUsd: 0,
  netIncomeUsd: 0,
};

const ZERO_BALANCE: FinancialBalanceSheet = {
  cashUsd: 0,
  receivablesUsd: 0,
  computeAssetsUsd: 0,
  otherAssetsUsd: 0,
  investmentsUsd: 0,
  totalAssetsUsd: 0,
  debtUsd: 0,
  deferredRevenueUsd: 0,
  otherLiabilitiesUsd: 0,
  totalLiabilitiesUsd: 0,
  equityUsd: 0,
};

const ZERO_CASH_FLOW: FinancialCashFlow = {
  openingCashUsd: 0,
  operatingUsd: 0,
  investingUsd: 0,
  financingUsd: 0,
  netChangeUsd: 0,
  endingCashUsd: 0,
};

function round(value: number): number {
  return Number.isFinite(value) ? Math.round(value) : 0;
}

/**
 * Cost basis, read off the live cap tables, that one controlled company holds
 * in another controlled company's equity — the sum a naive addition of every
 * member's `assets.investments` would double count against that member's own
 * assets and liabilities, now folded in directly.
 */
function intraGroupInvestmentCostUsd(session: SessionState, controlledIds: ReadonlySet<string>): number {
  let total = 0;
  for (const table of session.capTables) {
    if (!controlledIds.has(table.companyId)) continue;
    for (const holding of table.holdings) {
      if (holding.holderKind !== 'company' || !controlledIds.has(holding.holderId) || holding.holderId === table.companyId) continue;
      total += holding.costBasisUsd;
    }
  }
  return total;
}

/**
 * The consolidated income statement, balance sheet and cash flow across the
 * founding company and every subsidiary or majority-held company this seat
 * directs, at ownership share.
 *
 * World version 1 has no subsidiary concept — an acquisition there absorbs
 * outright, so `controlledCompaniesOf` never returns more than the founding
 * company — and this returns that single company's own statement unchanged.
 */
export function groupStatementOf(session: SessionState, playerId: string): GroupStatement {
  const companies = controlledCompaniesOf(session, playerId);
  const foundingId = companies[0]?.id ?? null;

  if (companies.length === 0) {
    return {
      quarter: null,
      companyIds: [],
      income: ZERO_INCOME,
      balance: ZERO_BALANCE,
      cashFlow: ZERO_CASH_FLOW,
      minorityInterestUsd: 0,
      equityAttributableToGroupUsd: 0,
    };
  }

  const controlledIds = new Set(companies.map((company) => company.id));
  const income = { ...ZERO_INCOME };
  const balance = { ...ZERO_BALANCE };
  const cashFlow = { ...ZERO_CASH_FLOW };
  let latestQuarter: number | null = null;
  let filedCount = 0;
  let minorityInterestUsd = 0;

  for (const company of companies) {
    const filed = recentFinancialQuarters(company, 1)[0] ?? null;
    // A company that has not filed a single quarter yet — freshly founded, or
    // a subsidiary the same quarter it was acquired — contributes nothing
    // rather than an invented number. It still counts as a member, so the
    // caller can tell it apart from a seat with no group at all.
    if (filed === null) continue;
    filedCount += 1;
    if (latestQuarter === null || filed.quarter > latestQuarter) latestQuarter = filed.quarter;

    income.revenueUsd += filed.income.revenueUsd;
    income.cogsUsd += filed.income.cogsUsd;
    income.grossProfitUsd += filed.income.grossProfitUsd;
    income.opexUsd += filed.income.opexUsd;
    income.ebitdaUsd += filed.income.ebitdaUsd;
    income.depreciationUsd += filed.income.depreciationUsd;
    income.operatingIncomeUsd += filed.income.operatingIncomeUsd;
    income.interestUsd += filed.income.interestUsd;
    income.taxUsd += filed.income.taxUsd;
    income.netIncomeUsd += filed.income.netIncomeUsd;

    balance.cashUsd += filed.balance.cashUsd;
    balance.receivablesUsd += filed.balance.receivablesUsd;
    balance.computeAssetsUsd += filed.balance.computeAssetsUsd;
    balance.otherAssetsUsd += filed.balance.otherAssetsUsd;
    balance.investmentsUsd = (balance.investmentsUsd ?? 0) + (filed.balance.investmentsUsd ?? 0);
    balance.debtUsd += filed.balance.debtUsd;
    balance.deferredRevenueUsd += filed.balance.deferredRevenueUsd;
    balance.otherLiabilitiesUsd += filed.balance.otherLiabilitiesUsd;
    balance.equityUsd += filed.balance.equityUsd;

    cashFlow.openingCashUsd += filed.cashFlow.openingCashUsd;
    cashFlow.operatingUsd += filed.cashFlow.operatingUsd;
    cashFlow.investingUsd += filed.cashFlow.investingUsd;
    cashFlow.financingUsd += filed.cashFlow.financingUsd;
    cashFlow.netChangeUsd += filed.cashFlow.netChangeUsd;
    cashFlow.endingCashUsd += filed.cashFlow.endingCashUsd;

    if (company.id !== foundingId) {
      const groupHeld = groupOwnershipPct(session, controlledIds, company.id);
      minorityInterestUsd += (1 - groupHeld) * filed.balance.equityUsd;
    }
  }

  // Eliminate the double-counted stake, on both sides of the identity
  // together — see the module comment for why that is what preserves it.
  const eliminationUsd = Math.min(balance.investmentsUsd ?? 0, intraGroupInvestmentCostUsd(session, controlledIds));
  balance.otherAssetsUsd = Math.max(0, balance.otherAssetsUsd - eliminationUsd);
  balance.investmentsUsd = Math.max(0, (balance.investmentsUsd ?? 0) - eliminationUsd);
  balance.equityUsd -= eliminationUsd;

  balance.totalAssetsUsd = round(balance.cashUsd + balance.receivablesUsd + balance.computeAssetsUsd + balance.otherAssetsUsd);
  balance.totalLiabilitiesUsd = round(balance.debtUsd + balance.deferredRevenueUsd + balance.otherLiabilitiesUsd);

  income.revenueUsd = round(income.revenueUsd);
  income.cogsUsd = round(income.cogsUsd);
  income.grossProfitUsd = round(income.grossProfitUsd);
  income.opexUsd = round(income.opexUsd);
  income.ebitdaUsd = round(income.ebitdaUsd);
  income.depreciationUsd = round(income.depreciationUsd);
  income.operatingIncomeUsd = round(income.operatingIncomeUsd);
  income.interestUsd = round(income.interestUsd);
  income.taxUsd = round(income.taxUsd);
  income.netIncomeUsd = round(income.netIncomeUsd);
  balance.cashUsd = round(balance.cashUsd);
  balance.receivablesUsd = round(balance.receivablesUsd);
  balance.computeAssetsUsd = round(balance.computeAssetsUsd);
  balance.otherAssetsUsd = round(balance.otherAssetsUsd);
  balance.investmentsUsd = round(balance.investmentsUsd ?? 0);
  balance.debtUsd = round(balance.debtUsd);
  balance.deferredRevenueUsd = round(balance.deferredRevenueUsd);
  balance.otherLiabilitiesUsd = round(balance.otherLiabilitiesUsd);
  balance.equityUsd = round(balance.equityUsd);
  cashFlow.openingCashUsd = round(cashFlow.openingCashUsd);
  cashFlow.operatingUsd = round(cashFlow.operatingUsd);
  cashFlow.investingUsd = round(cashFlow.investingUsd);
  cashFlow.financingUsd = round(cashFlow.financingUsd);
  cashFlow.netChangeUsd = round(cashFlow.netChangeUsd);
  cashFlow.endingCashUsd = round(cashFlow.endingCashUsd);
  minorityInterestUsd = round(minorityInterestUsd);

  return {
    quarter: filedCount === 0 ? null : latestQuarter,
    companyIds: companies.map((company) => company.id),
    income,
    balance,
    cashFlow,
    minorityInterestUsd,
    equityAttributableToGroupUsd: round(balance.equityUsd - minorityInterestUsd),
  };
}

/**
 * The group's own share of one controlled company's equity: the fraction of
 * its issued ordinary shares held by another company inside the same
 * controlled set. 1 for the founding company itself, and for a company with
 * no cap table concept yet (pre-issuance).
 */
function groupOwnershipPct(session: SessionState, controlledIds: ReadonlySet<string>, companyId: string): number {
  const company = session.companies.find((candidate) => candidate.id === companyId) ?? null;
  const table = session.capTables.find((candidate) => candidate.companyId === companyId) ?? null;
  if (company === null || table === null) return 1;
  const security =
    session.securities.find((candidate) => candidate.id === company.primarySecurityId) ??
    session.securities.find((candidate) => candidate.companyId === companyId) ??
    null;
  const shareClass = security === null ? null : table.shareClasses.find((klass) => klass.id === security.shareClassId) ?? table.shareClasses[0] ?? null;
  const issued = shareClass?.issuedShares ?? 0;
  if (security === null || shareClass === null || issued <= 0) return 1;
  let held = 0;
  for (const holding of table.holdings) {
    if (holding.securityId === security.id && holding.holderKind === 'company' && controlledIds.has(holding.holderId)) held += holding.shares;
  }
  return Math.max(0, Math.min(1, held / issued));
}

/** True when a world's `groupStatementOf` can ever return more than one company. */
export function groupStatementsSupported(session: SessionState): boolean {
  return isMultiSectorWorld(session);
}
