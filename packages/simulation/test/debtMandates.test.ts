import { describe, expect, it } from 'vitest';
import type { ActionIntent, BoardProposal, ResolverContext, SessionState, SubmittedAction } from '@frontier/contracts';
import { createRng } from '@frontier/shared';
import { createWorld3Session } from '../src/scenario/world3';
import { debtService } from '../src/companies/debt';
import { resolveCapital } from '../src/resolver/capital';
import { executeApprovedDebt } from '../src/resolver/routing';
import { createActionValidator } from '../src/validator';

function companyOf(state: SessionState) {
  const company = state.companies.find((entry) => entry.controllerPlayerId !== null && entry.boardId !== null);
  if (!company) throw new Error('no player company with board');
  return company;
}

function action(state: SessionState, intent: ActionIntent, companyId: string): SubmittedAction {
  const company = state.companies.find((entry) => entry.id === companyId)!;
  return { actionId: 'act_debt_test', sessionId: state.sessionId, quarter: state.quarter, sequence: 0,
    actorPlayerId: state.players[0]?.playerId ?? null, actorCompanyId: companyId,
    actorCharacterId: company.ceoCharacterId ?? 'char_test', origin: 'player_ui', intent, confirmedByHuman: true };
}

function ctx(state: SessionState): ResolverContext {
  return { quarter: state.quarter, rng: createRng(17), emit: () => 'evt_debt_test', log: () => undefined };
}

describe('world 3 debt mandates', () => {
  it('routes a confirmed issue to the board and executes the exact terms once', () => {
    const state = createWorld3Session();
    const company = companyOf(state);
    const terms = { amountUsd: 100_000_000, maxRatePct: 0.5, termQuarters: 8 };
    const result = createActionValidator().validateBatch(state, [action(state, { type: 'issue_debt', ...terms }, company.id)])[0]!;
    expect(result.status).toBe('clamped');
    expect(result.clampedAction).toMatchObject({ type: 'submit_board_proposal', debtTerms: terms });
    const routed = { ...action(state, result.clampedAction!, company.id), actionId: 'act_routed_debt' };
    state.pendingActions.push(routed);
    const proposal = { id: 'prp_debt_test', companyId: company.id, boardId: company.boardId!, kind: 'financing', title: 'Debt mandate', summary: 'Approve this exact debt mandate.', proposedByCharacterId: routed.actorCharacterId, quarterProposed: state.quarter, decisionQuarter: state.quarter, status: 'passed', amountUsd: terms.amountUsd, dilutionPct: null, stockComponentPct: null, targetCompanyId: null, debtTerms: terms, linkedActionId: routed.actionId, requiredThresholdFraction: 0.5 } satisfies BoardProposal;
    state.boardProposals.push(proposal);
    executeApprovedDebt(state);
    executeApprovedDebt(state);
    const issues = state.pendingActions.filter((entry) => entry.intent.type === 'issue_debt');
    expect(issues).toHaveLength(1);
    expect(issues[0]!.intent).toEqual({ type: 'issue_debt', ...terms });
    company.boardId = null;
    state.world.capitalMarkets.debtAvailability = 1;
    const cashBefore = company.financials.cash;
    resolveCapital(state, ctx(state));
    expect(company.financials.cash).toBeGreaterThan(cashBefore);
    expect(company.financials.debt).toBeGreaterThan(0);
  });

  it('does not execute when the approved terms differ from the linked action', () => {
    const state = createWorld3Session();
    const company = companyOf(state);
    const terms = { amountUsd: 10_000_000, maxRatePct: 0.2, termQuarters: 8 };
    const source = action(state, { type: 'submit_board_proposal', kind: 'financing', title: 'Debt mandate', summary: 'Approve this exact debt mandate.', amountUsd: terms.amountUsd, stockComponentPct: null, targetCompanyId: null, debtTerms: terms }, company.id);
    state.pendingActions.push(source);
    state.boardProposals.push({ id: 'prp_mismatch', companyId: company.id, boardId: company.boardId!, kind: 'financing', title: 'Debt mandate', summary: 'Approve this exact debt mandate.', proposedByCharacterId: source.actorCharacterId, quarterProposed: state.quarter, decisionQuarter: state.quarter, status: 'passed', amountUsd: terms.amountUsd, dilutionPct: null, stockComponentPct: null, targetCompanyId: null, debtTerms: { ...terms, amountUsd: terms.amountUsd + 1 }, linkedActionId: source.actionId, requiredThresholdFraction: 0.5 });
    executeApprovedDebt(state);
    expect(state.pendingActions.some((entry) => entry.intent.type === 'issue_debt')).toBe(false);
  });

  it('does not issue debt from a rejected board vote', () => {
    const state = createWorld3Session();
    const company = companyOf(state);
    const terms = { amountUsd: 10_000_000, maxRatePct: 0.2, termQuarters: 8 };
    const source = action(state, { type: 'submit_board_proposal', kind: 'financing', title: 'Rejected debt', summary: 'The board should reject this debt mandate.', amountUsd: terms.amountUsd, stockComponentPct: null, targetCompanyId: null, debtTerms: terms }, company.id);
    state.pendingActions.push(source);
    state.boardProposals.push({ id: 'prp_failed_debt', companyId: company.id, boardId: company.boardId!, kind: 'financing', title: 'Rejected debt', summary: 'The board should reject this debt mandate.', proposedByCharacterId: source.actorCharacterId, quarterProposed: state.quarter, decisionQuarter: state.quarter, status: 'failed', amountUsd: terms.amountUsd, dilutionPct: null, stockComponentPct: null, targetCompanyId: null, debtTerms: terms, linkedActionId: source.actionId, requiredThresholdFraction: 0.5 });
    executeApprovedDebt(state);
    expect(state.pendingActions.some((entry) => entry.intent.type === 'issue_debt')).toBe(false);
  });

  it('does not let a debt approval authorize an unrelated equity raise', () => {
    const state = createWorld3Session();
    const company = companyOf(state);
    const terms = { amountUsd: 10_000_000, maxRatePct: 0.2, termQuarters: 8 };
    state.boardProposals.push({ id: 'prp_debt_only', companyId: company.id, boardId: company.boardId!, kind: 'financing', title: 'Debt only', summary: 'Authorize debt only.', proposedByCharacterId: company.ceoCharacterId!, quarterProposed: state.quarter, decisionQuarter: state.quarter, status: 'passed', amountUsd: terms.amountUsd, dilutionPct: null, stockComponentPct: null, targetCompanyId: null, debtTerms: terms, linkedActionId: null, requiredThresholdFraction: 0.5 });
    const result = createActionValidator().validateBatch(state, [action(state, { type: 'raise_round', stage: 'seed', targetAmountUsd: 10_000_000, maxDilutionPct: 0.2 }, company.id)])[0]!;
    expect(result.status).toBe('clamped');
    expect(result.clampedAction?.type).toBe('submit_board_proposal');
  });

  it('does not allow debt terms on a user-authored board proposal', () => {
    const state = createWorld3Session();
    const company = companyOf(state);
    const intent = { type: 'submit_board_proposal', kind: 'financing', title: 'Hidden financing', summary: 'Attempt to smuggle debt terms into a normal proposal.', amountUsd: 10_000_000, dilutionPct: null, stockComponentPct: null, targetCompanyId: null, debtTerms: { amountUsd: 10_000_000, maxRatePct: 0.2, termQuarters: 8 } } as ActionIntent;
    const result = createActionValidator().validateBatch(state, [action(state, intent, company.id)])[0]!;
    expect(result.status).toBe('rejected');
    expect(result.codes).toContain('illegal_value');
  });

  it('does not increase cash when lenders refuse a closed market', () => {
    const state = createWorld3Session();
    const company = companyOf(state);
    company.boardId = null;
    state.world.capitalMarkets.debtAvailability = 0;
    state.pendingActions.push(action(state, { type: 'issue_debt', amountUsd: 10_000_000, maxRatePct: 0.2, termQuarters: 8 }, company.id));
    const before = company.financials.cash;
    resolveCapital(state, ctx(state));
    expect(company.financials.cash).toBe(before);
    expect(company.debtIssues ?? []).toHaveLength(0);
  });

  it('charges the coupon and amortizes through maturity, including final payoff', () => {
    const state = createWorld3Session();
    const company = companyOf(state);
    company.balanceSheet.liabilities.debt = 100;
    company.debtIssues = [{ id: 'loan', outstandingUsd: 100, annualRatePct: 0.12, principalPerQuarterUsd: 25, issuedQuarter: 0, maturityQuarter: 3 }];
    const first = debtService(company, 0, 0, 0);
    expect(first.interestUsd).toBeCloseTo(3);
    expect(first.principalUsd).toBeCloseTo(25);
    const final = debtService({ ...company, debtIssues: first.loans, balanceSheet: { ...company.balanceSheet, liabilities: { ...company.balanceSheet.liabilities, debt: 75 } } }, 3, 0, 0);
    expect(final.interestUsd).toBeCloseTo(2.25);
    expect(final.principalUsd).toBeCloseTo(75);
    expect(final.loans).toHaveLength(0);
  });
});
