import { describe, expect, it } from 'vitest';
import { ECONOMIC_NODES, type DealProposal, type SessionState } from '@frontier/contracts';
import { hashState } from '@frontier/shared';
import { createDefaultEngine } from '../src/engine';
import { createWorld3Session } from '../src/scenario/world3';

function withAcceptedCashDeal(unfunded = false): SessionState {
  const state = createWorld3Session();
  const proposer = state.companies.find((entry) => entry.id === state.players[0]!.companyId)!;
  const counterparty = state.companies.find((entry) => entry.controllerPlayerId === null && entry.isActive)!;
  const deal: DealProposal = {
    id: 'deal_resolver_cash', counterpartyId: counterparty.id, counterpartyKind: 'company',
    gives: [{ kind: 'cash_payment', amount: unfunded ? proposer.financials.cash + 1 : 1_000 }],
    gets: [{ kind: 'cash_payment', amount: 250 }], confidentiality: 'private', expiresQuarter: 2,
    binding: true, intentStatements: [], summary: 'A delayed cash exchange for resolver integration testing.',
    proposerId: proposer.id, proposerKind: 'company', status: 'accepted', createdQuarter: 0,
    respondedQuarter: 0, conversationId: null, breachedByPartyId: null,
  };
  state.deals.push(deal);
  state.quarter = 1;
  return state;
}

function cloneState(state: SessionState): SessionState {
  return JSON.parse(JSON.stringify(state)) as SessionState;
}

describe('cash deal full-quarter settlement', () => {
  it('settles after acceptance, preserves invariants, and replays deterministically', () => {
    const initial = withAcceptedCashDeal();
    const second = cloneState(initial);
    const control = cloneState(initial);
    control.deals = [];
    const proposer = initial.companies.find((entry) => entry.id === initial.players[0]!.companyId)!;
    const engine = createDefaultEngine();
    const first = engine.resolver.resolveQuarter(initial, [], null, []);
    const replay = engine.resolver.resolveQuarter(second, [], null, []);
    const controlOutcome = engine.resolver.resolveQuarter(control, [], null, []);
    expect(first.committed).toBe(true);
    expect(first.invariants.every((result) => result.passed)).toBe(true);
    expect(first.events.some((event) => event.type === 'deal_executed')).toBe(true);
    expect(first.nextState.companies.find((entry) => entry.id === proposer.id)!.financials.cash).toBe(
      controlOutcome.nextState.companies.find((entry) => entry.id === proposer.id)!.financials.cash - 750,
    );
    expect(hashState(first.nextState)).toBe(hashState(replay.nextState));
  });

  it('records an unfunded accepted deal as a breach without moving cash', () => {
    const state = withAcceptedCashDeal(true);
    const proposer = state.companies.find((entry) => entry.id === state.players[0]!.companyId)!;
    const counterparty = state.companies.find((entry) => entry.id === state.deals[0]!.counterpartyId)!;
    const baseline = cloneState(state);
    baseline.deals = [];
    const engine = createDefaultEngine();
    const baselineOutcome = engine.resolver.resolveQuarter(baseline, [], null, []);
    const outcome = engine.resolver.resolveQuarter(state, [], null, []);
    expect(outcome.invariants.find((result) => result.invariant === 'financial_integrity')?.passed).toBe(true);
    expect(outcome.nextState.deals[0]?.breachedByPartyId).toBe(proposer.id);
    expect(outcome.nextState.companies.find((entry) => entry.id === proposer.id)!.financials.cash).toBe(baselineOutcome.nextState.companies.find((entry) => entry.id === proposer.id)!.financials.cash);
    expect(outcome.nextState.companies.find((entry) => entry.id === counterparty.id)!.financials.cash).toBe(baselineOutcome.nextState.companies.find((entry) => entry.id === counterparty.id)!.financials.cash);
  });

  it('commits a licence-plus-cash signing bundle exactly once with reconciled equity', () => {
    const state = createWorld3Session();
    const proposer = state.companies.find((entry) => entry.id === state.players[0]!.companyId)!;
    const owner = state.companies.find((entry) => entry.controllerPlayerId === null && entry.isActive)!;
    const node = ECONOMIC_NODES.find((entry) => entry.researchable)!;
    owner.ownedNodes = [...(owner.ownedNodes ?? []), node.id];
    proposer.licences = [];
    const fee = 12_345;
    const deal: DealProposal = {
      id: 'deal_resolver_licence_bundle', counterpartyId: owner.id, counterpartyKind: 'company',
      gives: [{ kind: 'cash_payment', amount: 800 }],
      gets: [
        { kind: 'node_licence', nodeId: node.id, ownerCompanyId: owner.id, licenseeCompanyId: proposer.id, royaltyPct: 15, quarters: 4, upfrontUsd: fee },
        { kind: 'cash_payment', amount: 125 },
      ], confidentiality: 'private', expiresQuarter: 2, binding: true, intentStatements: [], summary: 'A licence signing fee plus bilateral cash consideration.',
      proposerId: proposer.id, proposerKind: 'company', status: 'accepted', createdQuarter: 0, respondedQuarter: 0, conversationId: null, breachedByPartyId: null,
    };
    state.deals.push(deal);
    const before = proposer.financials.cash;
    const engine = createDefaultEngine();
    const outcome = engine.resolver.resolveQuarter(state, [], null, []);
    expect(outcome.invariants.find((result) => result.invariant === 'financial_integrity')?.passed).toBe(true);
    expect(outcome.nextState.deals[0]?.status).toBe('executed');
    expect(outcome.nextState.companies.find((entry) => entry.id === proposer.id)!.licences).toContainEqual({ nodeId: node.id, ownerCompanyId: owner.id, royaltyPct: 15, expiryQuarter: 4 });
    // Operating cash also moves in the same quarter; compare against the
    // identical no-deal replay to isolate exactly the negotiated settlement.
    const baseline = createWorld3Session();
    const baselineOutcome = engine.resolver.resolveQuarter(baseline, [], null, []);
    const settled = outcome.nextState.companies.find((entry) => entry.id === proposer.id)!.financials.cash;
    const baselineCash = baselineOutcome.nextState.companies.find((entry) => entry.id === proposer.id)!.financials.cash;
    expect(settled - baselineCash).toBe(-fee - 800 + 125);
    expect(before).toBeGreaterThan(fee + 800);
  });
});
