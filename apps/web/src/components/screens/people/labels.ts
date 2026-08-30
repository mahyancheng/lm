/**
 * Display vocabulary and the two blended figures the People screen needs.
 *
 * `blendedMarketCompUsd` restates the engine's own headcount-weighted market
 * rate (`companies/hiring.ts`), and `talentReputationOf` restates the weighted
 * talent audience (`companies/util.ts`). Both are three lines of arithmetic over
 * exported constants, kept here because neither is exported from the package.
 */

import type { Company, CompBand, SessionState, StaffRole } from '@frontier/contracts';
import { STAFF_ROLES } from '@frontier/contracts';
import { TALENT_REPUTATION_WEIGHTS, requiredCompUsd } from '@frontier/simulation';

export const ROLE_LABEL: Readonly<Record<StaffRole, string>> = {
  engineers: 'Engineers',
  researchers: 'Researchers',
  sales: 'Sales',
  ops: 'Operations',
  execs: 'Executives',
};

export const ROLE_BLURB: Readonly<Record<StaffRole, string>> = {
  engineers: 'Build product and platform.',
  researchers: 'Advance the frontier — usually the binding constraint, not money.',
  sales: 'Convert enterprise and government demand.',
  ops: 'Infrastructure, support, security and compliance.',
  execs: 'The leadership layer.',
};

export const BAND_LABEL: Readonly<Record<CompBand, string>> = {
  below_market: 'Below market',
  market: 'Market',
  above_market: 'Above market',
  top_of_market: 'Top of market',
};

export const BAND_BLURB: Readonly<Record<CompBand, string>> = {
  below_market: 'Fills slowly, retains badly, and the people you already employ notice.',
  market: 'The neutral band. Fill rate and retention as designed.',
  above_market: 'Fills faster and retains better at a proportional payroll cost.',
  top_of_market: 'Buys the search outright, and resets what everyone else expects.',
};

/** Total employees across every function. */
export function headcountOf(company: Company): number {
  return STAFF_ROLES.reduce((total, role) => total + company.employees[role], 0);
}

/** The headcount-weighted market rate this company is actually judged against. */
export function blendedMarketCompUsd(session: SessionState, company: Company): number {
  const head = headcountOf(company);
  if (head === 0) return requiredCompUsd(session, 'engineers');
  let sum = 0;
  for (const role of STAFF_ROLES) sum += company.employees[role] * requiredCompUsd(session, role);
  return sum / head;
}

/** The reputation the talent market reads: developer, then public, then investor. */
export function talentReputationOf(company: Company): number {
  const reputation = company.reputation;
  return (
    reputation.developer * TALENT_REPUTATION_WEIGHTS.developer +
    reputation.public * TALENT_REPUTATION_WEIGHTS.public +
    reputation.investor * TALENT_REPUTATION_WEIGHTS.investor
  );
}
