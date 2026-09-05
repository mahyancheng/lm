/**
 * @frontier/simulation — validator/boardMatters.ts
 *
 * Which actions a board has to approve before they may happen, and what the
 * proposal looks like when the validator turns one into a board matter.
 *
 * The rule the whole file exists to enforce: **a company with a board cannot
 * finance, list, acquire, buy back, restructure or appoint its way past that
 * board.** An action that needs approval is not rejected — rejection would lose
 * the player's intent and teach them nothing. It is *transformed* into the
 * `submit_board_proposal` that has to precede it, returned with status
 * `clamped` and the code `board_approval_required`, so the quarter still
 * contains the decision the player meant to make. They tabled it; now they have
 * to win the vote.
 *
 * Once the board has passed the matching proposal, the same action validates
 * straight through: `authorisedByBoard` looks for a passed proposal of the same
 * kind within the authorisation window.
 *
 * A company with no board (`boardId === null`) needs no approval for anything.
 * That is the founder's brief, precious freedom before the first priced round.
 */

import type { ActionIntent, ActionType, BoardProposalKind, Company, SessionState } from '@frontier/contracts';
import { BOARD_GOV_CONTRACT_FLOOR_USD, BOARD_GOV_CONTRACT_REVENUE_MULTIPLE } from './balance';

/** Headcount share a single cut has to exceed before it becomes a board matter. */
export const LAYOFF_BOARD_THRESHOLD_PCT = 0.15;

/** Quarters a passed board approval remains good for. */
export const BOARD_AUTHORISATION_WINDOW_QUARTERS = 2;

/** The board matter each action maps to, for the actions that need one. */
export const BOARD_MATTER_BY_ACTION: Partial<Record<ActionType, BoardProposalKind>> = {
  raise_round: 'financing',
  issue_debt: 'financing',
  issue_shares: 'financing',
  buyback: 'buyback',
  ipo: 'ipo',
  acquire_company: 'acquisition',
  bid_government: 'gov_contract',
  appoint_executive: 'csuite_appointment',
  publish_research: 'model_release',
  layoff: 'restructuring',
  set_dividend_policy: 'dividend',
};

/** What a transformed proposal carries into the boardroom. */
export interface BoardMatter {
  readonly kind: BoardProposalKind;
  readonly title: string;
  readonly summary: string;
  readonly amountUsd: number | null;
  readonly targetCompanyId: string | null;
  readonly stockComponentPct: number | null;
}

/**
 * The board matter an action requires, or null when it needs no approval.
 *
 * Several mappings are conditional, because a rule that sent every action to the
 * board would make the board furniture: a small government bid, a modest team
 * reduction and a closed briefing are management decisions.
 */
export function boardMatterFor(intent: ActionIntent, company: Company): BoardMatter | null {
  switch (intent.type) {
    case 'raise_round':
      return {
        kind: 'financing',
        title: `Authorise a ${intent.stage.replace(/_/g, ' ')} financing`,
        summary: `Management seeks authority to raise ${usd(intent.targetAmountUsd)} at a ${stage(intent.stage)}, accepting no more than ${pct(
          intent.maxDilutionPct,
        )} dilution. Cash on hand is ${usd(company.financials.cash)} against a quarterly burn of ${usd(Math.abs(company.financials.quarterlyBurn))}.`,
        amountUsd: intent.targetAmountUsd,
        targetCompanyId: null,
        stockComponentPct: null,
      };

    case 'issue_debt':
      return {
        kind: 'financing',
        title: 'Authorise a debt issue',
        summary: `Management seeks authority to issue ${usd(intent.amountUsd)} of debt over ${intent.termQuarters} quarters at a coupon no higher than ${pct(
          intent.maxRatePct,
        )}. Existing debt stands at ${usd(company.financials.debt)}.`,
        amountUsd: intent.amountUsd,
        targetCompanyId: null,
        stockComponentPct: null,
      };

    case 'issue_shares':
      return {
        kind: 'financing',
        title: 'Authorise a primary share issue',
        summary: `Management seeks authority to issue ${count(intent.shares)} shares in class ${intent.shareClassId} at no less than ${usd(
          intent.minPricePerShareUsd,
        )} per share, raising approximately ${usd(intent.shares * intent.minPricePerShareUsd)}.`,
        amountUsd: intent.shares * intent.minPricePerShareUsd,
        targetCompanyId: null,
        stockComponentPct: null,
      };

    case 'buyback':
      return {
        kind: 'buyback',
        title: 'Authorise a share repurchase',
        summary: `Management proposes returning ${usd(intent.budgetUsd)} of capital through repurchases at no more than ${usd(
          intent.maxPricePerShareUsd,
        )} per share, instead of investing it.`,
        amountUsd: intent.budgetUsd,
        targetCompanyId: null,
        stockComponentPct: null,
      };

    case 'ipo':
      return {
        kind: 'ipo',
        title: 'Authorise a public listing',
        summary: `Management proposes listing ${pct(intent.floatPct)} of the company, raising ${usd(intent.targetRaiseUsd)} of primary capital at no less than ${usd(
          intent.minPricePerShareUsd,
        )} per share, and accepting quarterly disclosure and permanent public scrutiny.`,
        amountUsd: intent.targetRaiseUsd,
        targetCompanyId: null,
        stockComponentPct: null,
      };

    case 'acquire_company':
      return {
        kind: 'acquisition',
        title: 'Approve an acquisition',
        summary: `Management proposes acquiring ${intent.targetCompanyId} for ${usd(intent.offerValueUsd)}, ${pct(intent.cashPct)} in cash and ${pct(
          intent.stockPct,
        )} in stock. Cash on hand is ${usd(company.financials.cash)}.`,
        amountUsd: intent.offerValueUsd,
        targetCompanyId: intent.targetCompanyId,
        stockComponentPct: intent.stockPct,
      };

    case 'bid_government': {
      const threshold = Math.max(BOARD_GOV_CONTRACT_FLOOR_USD, company.financials.revenueQuarterly * BOARD_GOV_CONTRACT_REVENUE_MULTIPLE);
      if (intent.bid.price < threshold) return null;
      return {
        kind: 'gov_contract',
        title: 'Approve a major public bid',
        summary: `Management proposes bidding ${usd(intent.bid.price)} on ${intent.opportunityId}, committing ${count(
          intent.bid.computeCommitment.acceleratorUnits,
        )} accelerators for ${intent.bid.computeCommitment.quarters} quarters and accepting ${intent.bid.auditRights} audit rights and ${intent.bid.ipConcessions.replace(
          /_/g,
          ' ',
        )} on intellectual property.`,
        amountUsd: intent.bid.price,
        targetCompanyId: null,
        stockComponentPct: null,
      };
    }

    case 'appoint_executive':
      return {
        kind: 'csuite_appointment',
        title: `Appoint a ${intent.executiveRole.replace(/_/g, ' ')}`,
        summary: `Management proposes appointing ${intent.characterId} as ${intent.executiveRole.replace(/_/g, ' ')} on annual compensation of ${usd(
          intent.annualCompUsd,
        )}.`,
        amountUsd: intent.annualCompUsd,
        targetCompanyId: null,
        stockComponentPct: null,
      };

    case 'publish_research':
      // Only a release that hands rivals the method is a governance matter.
      if (intent.mode !== 'open_weights') return null;
      return {
        kind: 'model_release',
        title: 'Approve an open-weights release',
        summary: `Management proposes releasing the ${intent.nodeId} result as open weights. Stated rationale: ${
          intent.rationale.length > 0 ? intent.rationale : 'none given'
        }.`,
        amountUsd: null,
        targetCompanyId: null,
        stockComponentPct: null,
      };

    case 'set_dividend_policy': {
      // Cutting or holding a payout is management's to do. *Raising* one is a
      // capital-allocation decision, and that is what a board is for.
      const current = company.dividendPolicyPct ?? 0;
      if (intent.payoutPct <= current) return null;
      return {
        kind: 'dividend',
        title: 'Approve a higher payout',
        summary: `Management proposes paying out ${pct(intent.payoutPct / 100)} of net income to shareholders, up from ${pct(
          current / 100,
        )}. Cash on hand is ${usd(company.financials.cash)} against a quarterly burn of ${usd(Math.abs(company.financials.quarterlyBurn))}; capital paid out is capital the business does not get to spend.`,
        amountUsd: null,
        targetCompanyId: null,
        stockComponentPct: null,
      };
    }

    case 'layoff': {
      const headcount = totalHeadcount(company);
      if (headcount <= 0) return null;
      if (intent.count / headcount < LAYOFF_BOARD_THRESHOLD_PCT) return null;
      return {
        kind: 'restructuring',
        title: 'Approve a restructuring',
        summary: `Management proposes cutting ${count(intent.count)} ${intent.role}, ${pct(
          intent.count / headcount,
        )} of the company, with ${intent.severanceQuartersOfPay} quarters of severance.`,
        amountUsd: null,
        targetCompanyId: null,
        stockComponentPct: null,
      };
    }

    default:
      return null;
  }
}

/**
 * True when the board has already passed a proposal of this kind recently
 * enough to authorise the action.
 *
 * Deliberately kind-level rather than action-level: a board that has authorised
 * a financing has authorised management to go and raise it, and does not need
 * to be asked again in the same breath. `linkedActionId` narrows it further when
 * the proposal was tabled for one specific action.
 */
export function authorisedByBoard(draft: SessionState, companyId: string, kind: BoardProposalKind): boolean {
  for (const proposal of draft.boardProposals) {
    if (proposal.companyId !== companyId || proposal.kind !== kind) continue;
    if (proposal.status !== 'passed') continue;
    if (draft.quarter - proposal.decisionQuarter > BOARD_AUTHORISATION_WINDOW_QUARTERS) continue;
    return true;
  }
  return false;
}

/** The `submit_board_proposal` an unapproved action becomes. */
export function toBoardProposalIntent(matter: BoardMatter): ActionIntent {
  return {
    type: 'submit_board_proposal',
    kind: matter.kind,
    title: clip(matter.title, 140),
    summary: clip(matter.summary.length >= 10 ? matter.summary : `${matter.summary} Tabled by management for a decision this quarter.`, 1200),
    amountUsd: matter.amountUsd !== null && Number.isFinite(matter.amountUsd) ? Math.max(0, matter.amountUsd) : null,
    targetCompanyId: matter.targetCompanyId,
    stockComponentPct: matter.stockComponentPct === null ? null : Math.max(0, Math.min(1, matter.stockComponentPct)),
  };
}

/* -------------------------------------------------------------------------- */
/*  Local formatting                                                           */
/* -------------------------------------------------------------------------- */

function totalHeadcount(company: Company): number {
  const e = company.employees;
  return e.engineers + e.researchers + e.sales + e.ops + e.execs;
}

const usd = (value: number): string => {
  if (!Number.isFinite(value)) return '$0';
  const abs = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  if (abs >= 1e9) return `${sign}$${trim(abs / 1e9)}bn`;
  if (abs >= 1e6) return `${sign}$${trim(abs / 1e6)}m`;
  if (abs >= 1e3) return `${sign}$${trim(abs / 1e3)}k`;
  return `${sign}$${Math.round(abs)}`;
};

const pct = (fraction: number): string => `${trim((Number.isFinite(fraction) ? fraction : 0) * 100)}%`;

const count = (value: number): string => String(Math.round(Number.isFinite(value) ? value : 0));

const stage = (value: string): string => `${value.replace(/_/g, ' ')} valuation`;

const trim = (value: number): string => {
  const fixed = value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2);
  return fixed.includes('.') ? fixed.replace(/0+$/, '').replace(/\.$/, '') : fixed;
};

const clip = (value: string, max: number): string => (value.length <= max ? value : `${value.slice(0, max - 1)}…`);
