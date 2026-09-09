import type { Company } from '@frontier/contracts';

/** Coupon and amortization of issued loans; old untracked debt keeps its legacy terms.
 * A restructuring may have reduced the aggregate balance: scale tranches to it
 * before servicing, so stale schedules never resurrect written-off principal. */
export function debtService(company: Company, quarter: number, legacyQuarterlyRate: number, legacyAmortization: number) {
  const total = Math.max(0, company.balanceSheet.liabilities.debt);
  const tracked = (company.debtIssues ?? []).reduce((sum, loan) => sum + loan.outstandingUsd, 0);
  const scale = tracked > total && tracked > 0 ? total / tracked : 1;
  const legacy = Math.max(0, total - tracked);
  let interestUsd = legacy * legacyQuarterlyRate;
  let principalUsd = legacy * legacyAmortization;
  const loans = (company.debtIssues ?? []).map((loan) => {
    const outstanding = loan.outstandingUsd * scale;
    // A restructuring can write the aggregate balance down to zero. Do not
    // retain a zero-principal tranche: its schema requires a positive
    // scheduled payment, and a stale schedule must never resurrect debt.
    if (outstanding <= 0.005) return null;
    const payment = quarter < loan.issuedQuarter ? 0 : Math.min(outstanding, quarter >= loan.maturityQuarter ? outstanding : loan.principalPerQuarterUsd * scale);
    if (quarter >= loan.issuedQuarter) interestUsd += outstanding * loan.annualRatePct / 4;
    principalUsd += payment;
    return { ...loan, outstandingUsd: Math.max(0, outstanding - payment), principalPerQuarterUsd: loan.principalPerQuarterUsd * scale };
  }).filter((loan): loan is NonNullable<typeof loan> => loan !== null && loan.outstandingUsd > 0.005);
  return { interestUsd, principalUsd: Math.min(total, principalUsd), loans };
}
