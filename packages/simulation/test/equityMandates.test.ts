import { describe, expect, it } from 'vitest';
import type { ActionIntent, BoardProposal, ResolverContext, SessionState, SubmittedAction } from '@frontier/contracts';
import { createRng } from '@frontier/shared';
import { createDefaultEngine } from '../src/engine';
import { resolveCapital } from '../src/resolver/capital';
import { executeApprovedEquity } from '../src/resolver/routing';
import { createWorld3Session } from '../src/scenario/world3';
import { createActionValidator } from '../src/validator';

function companyOf(state: SessionState) {
  const company = state.companies.find((entry) => entry.controllerPlayerId !== null && entry.boardId !== null);
  if (!company) throw new Error('no player company with board');
  return company;
}

function action(state: SessionState, intent: ActionIntent, companyId: string, id = 'act_equity_test'): SubmittedAction {
  const company = state.companies.find((entry) => entry.id === companyId)!;
  return {
    actionId: id,
    sessionId: state.sessionId,
    quarter: state.quarter,
    sequence: 0,
    actorPlayerId: state.players[0]?.playerId ?? null,
    actorCompanyId: companyId,
    actorCharacterId: company.ceoCharacterId ?? 'char_test',
    origin: 'player_ui',
    intent,
    confirmedByHuman: true,
  };
}

function ctx(state: SessionState): ResolverContext {
  return { quarter: state.quarter, rng: createRng(17), emit: () => 'evt_equity_test', log: () => undefined };
}

describe('world 3 equity mandates', () => {
  it('runs an approved private round through a whole quarter with exact cash, shares, and invariants', () => {
    const state = createWorld3Session();
    const baseline = createWorld3Session();
    const company = companyOf(state);
    const baselineCompany = companyOf(baseline);
    // Make a small, fully fundable proposal that every director deterministically supports.
    const board = state.boards.find((entry) => entry.id === company.boardId)!;
    for (const director of board.directors) {
      director.riskTolerance = 100;
      director.growthPreference = 100;
    }
    const baselineBoard = baseline.boards.find((entry) => entry.id === baselineCompany.boardId)!;
    for (const director of baselineBoard.directors) {
      director.riskTolerance = 100;
      director.growthPreference = 100;
    }
    state.world.capitalMarkets.ventureLiquidity = 1;
    state.world.capitalMarkets.riskAppetite = 1;
    baseline.world.capitalMarkets.ventureLiquidity = 1;
    baseline.world.capitalMarkets.riskAppetite = 1;
    const terms = { type: 'raise_round' as const, stage: 'seed' as const, targetAmountUsd: 1_000_000, maxDilutionPct: 0.3 };
    const table = state.capTables.find((entry) => entry.companyId === company.id)!;
    const shareClass = table.shareClasses[0]!;
    const beforeIssued = shareClass.issuedShares;

    const outcome = createDefaultEngine().resolver.resolveQuarter(state, [action(state, terms, company.id)], null, []);
    const control = createDefaultEngine().resolver.resolveQuarter(baseline, [], null, []);
    expect(outcome.committed).toBe(true);
    expect(control.committed).toBe(true);
    const proposal = outcome.nextState.boardProposals.find((entry) => entry.linkedActionId === 'act_equity_test')!;
    expect(proposal.status).toBe('passed');
    expect(proposal.equityTerms).toEqual(terms);
    expect(proposal.equityExecutionQuarter).toBe(state.quarter);
    expect(proposal.dilutionPct).toBe(terms.maxDilutionPct);
    const closed = outcome.events.find((event) => event.type === 'funding_round_closed' && event.actorId === company.id)!;
    expect(closed.payload.amountUsd).toBe(terms.targetAmountUsd);
    const after = outcome.nextState.companies.find((entry) => entry.id === company.id)!;
    const controlAfter = control.nextState.companies.find((entry) => entry.id === company.id)!;
    // This route has no issuance-fee model: compared with the identical no-action
    // quarter, the only cash difference is the closed round's exact proceeds.
    expect(after.financials.cash - controlAfter.financials.cash).toBeCloseTo(terms.targetAmountUsd, 2);
    const afterTable = outcome.nextState.capTables.find((entry) => entry.companyId === company.id)!;
    expect(afterTable.shareClasses[0]!.issuedShares).toBeGreaterThan(beforeIssued);
    expect(afterTable.holdings.reduce((sum, holding) => sum + holding.shares, 0)).toBe(afterTable.shareClasses[0]!.issuedShares);
    const leadId = closed.payload.entityId;
    if (typeof leadId === 'string') {
      const afterLead = outcome.nextState.capitalEntities?.find((entry) => entry.id === leadId)!;
      const controlLead = control.nextState.capitalEntities?.find((entry) => entry.id === leadId)!;
      expect(afterLead.dryPowderUsd - controlLead.dryPowderUsd).toBe(-terms.targetAmountUsd);
      expect(afterTable.holdings.some((holding) => holding.holderId === leadId && holding.shares > 0)).toBe(true);
    }
    expect(outcome.invariants.every((result) => result.passed)).toBe(true);
  }, 60_000);

  it('executes an approved direct primary issue exactly once and accounts for its precise proceeds', () => {
    const state = createWorld3Session();
    const company = companyOf(state);
    const table = state.capTables.find((entry) => entry.companyId === company.id)!;
    const shareClass = table.shareClasses[0]!;
    const terms = { type: 'issue_shares' as const, shares: 7, shareClassId: shareClass.id, minPricePerShareUsd: 3 };
    const proposalIntent = { type: 'submit_board_proposal' as const, kind: 'financing' as const, title: 'Primary issue', summary: 'Approve an exact primary issue for seven shares.', amountUsd: 21, stockComponentPct: null, targetCompanyId: null, equityTerms: terms };
    const source = action(state, proposalIntent, company.id, 'act_equity_source');
    state.pendingActions.push(source);
    state.boardProposals.push({ id: 'prp_equity_issue', companyId: company.id, boardId: company.boardId!, kind: 'financing', title: proposalIntent.title, summary: proposalIntent.summary, proposedByCharacterId: source.actorCharacterId, quarterProposed: state.quarter, decisionQuarter: state.quarter, status: 'passed', amountUsd: 21, dilutionPct: null, stockComponentPct: null, targetCompanyId: null, equityTerms: terms, linkedActionId: source.actionId, requiredThresholdFraction: 0.5 } satisfies BoardProposal);
    const beforeCash = company.financials.cash;
    const beforeIssued = shareClass.issuedShares;

    executeApprovedEquity(state);
    executeApprovedEquity(state);
    expect(state.pendingActions.filter((entry) => entry.intent.type === 'issue_shares')).toHaveLength(1);
    company.boardId = null;
    resolveCapital(state, ctx(state));
    expect(company.financials.cash - beforeCash).toBeCloseTo(21, 2);
    expect(shareClass.issuedShares - beforeIssued).toBe(7);
    expect(table.holdings.reduce((sum, holding) => sum + holding.shares, 0)).toBe(shareClass.issuedShares);
  });

  it('restores an approved IPO only as the exact listing attempt the board voted on', () => {
    const state = createWorld3Session();
    const company = companyOf(state);
    const terms = { type: 'ipo' as const, targetRaiseUsd: 500_000, floatPct: 0.2, minPricePerShareUsd: 1 };
    const proposalIntent = { type: 'submit_board_proposal' as const, kind: 'ipo' as const, title: 'Exact IPO', summary: 'Approve this exact public listing attempt.', amountUsd: terms.targetRaiseUsd, stockComponentPct: null, targetCompanyId: null, equityTerms: terms };
    const source = action(state, proposalIntent, company.id, 'act_equity_ipo');
    state.pendingActions.push(source);
    state.boardProposals.push({ id: 'prp_equity_ipo', companyId: company.id, boardId: company.boardId!, kind: 'ipo', title: proposalIntent.title, summary: proposalIntent.summary, proposedByCharacterId: source.actorCharacterId, quarterProposed: state.quarter, decisionQuarter: state.quarter, status: 'passed', amountUsd: terms.targetRaiseUsd, dilutionPct: terms.floatPct, stockComponentPct: null, targetCompanyId: null, equityTerms: terms, linkedActionId: source.actionId, requiredThresholdFraction: 0.5 } satisfies BoardProposal);
    executeApprovedEquity(state);
    executeApprovedEquity(state);
    expect(state.pendingActions.filter((entry) => entry.intent.type === 'ipo')).toHaveLength(1);
    expect(state.boardProposals[0]?.equityExecutionQuarter).toBe(state.quarter);
  });

  it('does not execute failed, altered, stale, or user-injected equity mandates', () => {
    const state = createWorld3Session();
    const company = companyOf(state);
    const terms = { type: 'raise_round' as const, stage: 'seed' as const, targetAmountUsd: 10, maxDilutionPct: 0.2 };
    const proposalIntent = { type: 'submit_board_proposal' as const, kind: 'financing' as const, title: 'Exact raise', summary: 'Approve this exact raise and no different financing.', amountUsd: 10, stockComponentPct: null, targetCompanyId: null, equityTerms: terms };
    const source = action(state, proposalIntent, company.id, 'act_equity_mismatch');
    state.pendingActions.push(source);
    state.boardProposals.push({ id: 'prp_equity_mismatch', companyId: company.id, boardId: company.boardId!, kind: 'financing', title: proposalIntent.title, summary: proposalIntent.summary, proposedByCharacterId: source.actorCharacterId, quarterProposed: state.quarter, decisionQuarter: state.quarter, status: 'passed', amountUsd: 10, dilutionPct: null, stockComponentPct: null, targetCompanyId: null, equityTerms: { ...terms, targetAmountUsd: 11 }, linkedActionId: source.actionId, requiredThresholdFraction: 0.5 } satisfies BoardProposal);
    state.boardProposals.push({ id: 'prp_equity_failed', companyId: company.id, boardId: company.boardId!, kind: 'financing', title: 'Rejected raise', summary: 'The board rejected this exact raise.', proposedByCharacterId: source.actorCharacterId, quarterProposed: state.quarter, decisionQuarter: state.quarter, status: 'failed', amountUsd: 10, dilutionPct: null, stockComponentPct: null, targetCompanyId: null, equityTerms: terms, linkedActionId: source.actionId, requiredThresholdFraction: 0.5 } satisfies BoardProposal);
    state.boardProposals.push({ id: 'prp_equity_stale', companyId: company.id, boardId: company.boardId!, kind: 'financing', title: 'Stale raise', summary: 'An old approval must not execute in a later quarter.', proposedByCharacterId: source.actorCharacterId, quarterProposed: 0, decisionQuarter: state.quarter - 1, status: 'passed', amountUsd: 10, dilutionPct: null, stockComponentPct: null, targetCompanyId: null, equityTerms: terms, linkedActionId: source.actionId, requiredThresholdFraction: 0.5 } satisfies BoardProposal);
    executeApprovedEquity(state);
    expect(state.pendingActions.some((entry) => entry.intent.type === 'raise_round')).toBe(false);

    const injected = createActionValidator().validateBatch(state, [action(state, proposalIntent, company.id, 'act_injected')])[0]!;
    expect(injected.status).toBe('rejected');
    expect(injected.codes).toContain('illegal_value');
  });
});
