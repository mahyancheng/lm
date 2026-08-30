/**
 * The eight obligation kinds, as an editable form.
 *
 * `DealObligation` is a discriminated union, which is exactly what makes a deal
 * mechanically enforceable rather than a conversation. The builder therefore
 * edits typed fields per kind and never a free-text term: when the engine
 * executes the deal it reads `kind` and the numbers beside it, and anything the
 * parties merely *said* lives in `intentStatements`, unenforced and labelled.
 */

import type { BoardProposalKind, DealObligation, VoteStance } from '@frontier/contracts';
import { DEAL_OBLIGATION_KINDS } from '@frontier/contracts';
import { formatMoney } from '@frontier/shared';

export type ObligationKind = (typeof DEAL_OBLIGATION_KINDS)[number];

export const OBLIGATION_LABELS: Readonly<Record<ObligationKind, string>> = {
  compute_supply: 'Compute supply',
  tech_license: 'Technology licence',
  cash_payment: 'Cash payment',
  equity_transfer: 'Equity transfer',
  board_vote_pledge: 'Board vote pledge',
  public_endorsement: 'Public endorsement',
  consortium_membership: 'Consortium membership',
  investment: 'Investment',
};

export const OBLIGATION_HINTS: Readonly<Record<ObligationKind, string>> = {
  compute_supply: 'The supplier must actually hold the capacity every quarter, or be in breach.',
  tech_license: 'Grants use of one Frontier Map node or one product. Set exactly one.',
  cash_payment: 'Settled in the capital phase of the quarter after acceptance.',
  equity_transfer: 'Existing shares move. Subject to cap-table reconciliation and any lock-up.',
  board_vote_pledge: 'Breaking a pledge is a visible, permanent reputational event.',
  public_endorsement: 'Spends the endorser’s credibility with their own audiences.',
  consortium_membership: 'How a specialist reaches a programme it could not deliver alone.',
  investment: 'Capital for equity. Creates or transfers shares depending on the security.',
};

/**
 * A blank obligation of one kind.
 *
 * Every field is filled with a legal starting value so the union always parses;
 * a zero is a zero, never an invented default the player did not choose.
 */
export function blankObligation(kind: ObligationKind, quarter: number): DealObligation {
  switch (kind) {
    case 'compute_supply':
      return { kind, units: 0, quarters: 1 };
    case 'tech_license':
      return { kind, techNodeId: null, productId: null, quarters: 1 };
    case 'cash_payment':
      return { kind, amount: 0 };
    case 'equity_transfer':
      return { kind, securityId: '', shares: 0 };
    case 'board_vote_pledge':
      return { kind, proposalKind: 'financing' as BoardProposalKind, stance: 'support' as VoteStance, quarters: 1 };
    case 'public_endorsement':
      return { kind, statement: '', quarters: 1 };
    case 'consortium_membership':
      return { kind, opportunityId: '' };
    case 'investment':
      return { kind, amount: 0, securityId: '' };
    default:
      return { kind: 'cash_payment', amount: 0 };
  }
}

/** One line describing an obligation as the counterparty would read it. */
export function describeObligation(obligation: DealObligation): string {
  switch (obligation.kind) {
    case 'compute_supply':
      return `${obligation.units} accelerator-equivalents a quarter for ${obligation.quarters} quarters`;
    case 'tech_license':
      return `Licence of ${obligation.techNodeId ?? obligation.productId ?? 'nothing named'} for ${obligation.quarters} quarters`;
    case 'cash_payment':
      return `${formatMoney(obligation.amount)} in cash`;
    case 'equity_transfer':
      return `${obligation.shares} shares of ${obligation.securityId || 'an unnamed security'}`;
    case 'board_vote_pledge':
      return `Vote ${obligation.stance} on ${obligation.proposalKind.replace(/_/g, ' ')} matters for ${obligation.quarters} quarters`;
    case 'public_endorsement':
      return `Public support for ${obligation.quarters} quarters: “${obligation.statement || 'unwritten'}”`;
    case 'consortium_membership':
      return `Joint bid on ${obligation.opportunityId || 'an unnamed opportunity'}`;
    case 'investment':
      return `${formatMoney(obligation.amount)} invested for ${obligation.securityId || 'an unnamed security'}`;
    default:
      return 'An obligation';
  }
}

/** Cash the player would owe this quarter if the deal were accepted as drafted. */
export function cashInObligations(obligations: readonly DealObligation[]): number {
  return obligations.reduce((total, obligation) => {
    if (obligation.kind === 'cash_payment') return total + obligation.amount;
    if (obligation.kind === 'investment') return total + obligation.amount;
    return total;
  }, 0);
}
