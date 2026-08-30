/**
 * Boardroom vocabulary, plus the plain-language rendering of a machine-readable
 * commitment.
 *
 * "support / purchasePriceUsd lte 5500000000 / stockComponentPct gte 0.35"
 * becomes "supports below $5.50B, or with at least 35% stock" — the same
 * promise, in the words a director would actually use. The condition objects
 * stay authoritative; this only reads them out.
 */

import type {
  BoardProposalKind,
  CommitmentComparator,
  CommitmentCondition,
  CommitmentField,
  DirectorMandate,
} from '@frontier/contracts';
import { formatMoney, formatPct } from '@frontier/shared';

export const PROPOSAL_KIND_LABEL: Readonly<Record<BoardProposalKind, string>> = {
  annual_plan: 'Annual plan',
  financing: 'Financing',
  acquisition: 'Acquisition',
  divestiture: 'Divestiture',
  ceo_comp: 'Chief executive compensation',
  csuite_appointment: 'C-suite appointment',
  buyback: 'Share repurchase',
  ipo: 'Public listing',
  gov_contract: 'Government contract',
  model_release: 'Model release',
  restructuring: 'Restructuring',
  ceo_dismissal: 'Dismissal of the chief executive',
};

export const PROPOSAL_KIND_BLURB: Readonly<Record<BoardProposalKind, string>> = {
  annual_plan: 'Sets the operating budget envelope.',
  financing: 'Authorises dilution or debt.',
  acquisition: 'Moves assets, and brings their problems.',
  divestiture: 'Sells a business.',
  ceo_comp: 'Sets your own incentives — you are recused.',
  csuite_appointment: 'Changes leadership quality.',
  buyback: 'Returns capital instead of investing it.',
  ipo: 'Quarterly disclosure, activists and permanent scrutiny.',
  gov_contract: 'Accepts the risk and compliance burden of a major award.',
  model_release: 'Governs a safety-sensitive launch.',
  restructuring: 'Survival.',
  ceo_dismissal: 'Removes the chief executive — for a player, executive control without losing a share.',
};

export const MANDATE_LABEL: Readonly<Record<DirectorMandate, string>> = {
  founder_vision: 'Founder vision',
  investor_return: 'Investor return',
  independent_oversight: 'Independent oversight',
  employee_voice: 'Employee voice',
  public_interest: 'Public interest',
  strategic_partner: 'Strategic partner',
  government_liaison: 'Government liaison',
};

const COMPARATOR_WORD: Readonly<Record<CommitmentComparator, string>> = {
  lt: 'below',
  lte: 'at or below',
  eq: 'exactly',
  gte: 'at least',
  gt: 'above',
};

const USD_FIELDS = new Set<CommitmentField>([
  'purchasePriceUsd',
  'amountUsd',
  'capexUsd',
  'ceoCompUsd',
  'contractValueUsd',
]);

const PCT_FIELDS = new Set<CommitmentField>([
  'stockComponentPct',
  'cashComponentPct',
  'dilutionPct',
  'debtRatePct',
  'headcountReductionPct',
  'floatPct',
  'governmentRevenueSharePct',
]);

const FIELD_LABEL: Readonly<Record<CommitmentField, string>> = {
  purchasePriceUsd: 'purchase price',
  stockComponentPct: 'stock component',
  cashComponentPct: 'cash component',
  dilutionPct: 'dilution',
  amountUsd: 'headline amount',
  debtRatePct: 'coupon',
  headcountReductionPct: 'headcount reduction',
  capexUsd: 'capital expenditure',
  ceoCompUsd: 'chief-executive compensation',
  floatPct: 'float',
  contractValueUsd: 'contract value',
  governmentRevenueSharePct: 'government revenue share',
  safetyEvaluationQuarters: 'safety evaluation',
  runwayQuarters: 'runway',
};

/** One condition, in words. */
export function conditionText(condition: CommitmentCondition): string {
  const field = FIELD_LABEL[condition.field];
  const comparator = COMPARATOR_WORD[condition.comparator];
  const value = USD_FIELDS.has(condition.field)
    ? formatMoney(condition.value)
    : PCT_FIELDS.has(condition.field)
      ? formatPct(condition.value, 0)
      : `${condition.value} quarters`;
  return `${field} ${comparator} ${value}`;
}

/** Every condition on a commitment, joined the way a director would say it. */
export function commitmentText(conditions: readonly CommitmentCondition[]): string {
  if (conditions.length === 0) return 'unconditionally';
  return conditions.map(conditionText).join(' and ');
}
