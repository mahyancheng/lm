import { describe, expect, it } from 'vitest';
import type { ActionIntent, BoardProposal, DealProposal, SessionState, SubmittedAction } from '@frontier/contracts';
import { createWorld2Session, W2_COMPANIES, W2_FOUNDERS } from '../src/scenario/world2';
import { createActionValidator, boardMatterFor } from '../src/validator';
import { executeApprovedMaterialDeal } from '../src/resolver/routing';

function company(state: SessionState, id: string) {
  const found = state.companies.find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`Missing ${id}`);
  return found;
}

function materialHardwareProposal(state: SessionState): Extract<ActionIntent, { type: 'propose_deal' }> {
  return {
    type: 'propose_deal',
    proposal: {
      counterpartyId: W2_COMPANIES.ironvale,
      counterpartyKind: 'company',
      gives: [{
        kind: 'owned_accelerator_supply', supplierCompanyId: W2_COMPANIES.tessellate, buyerCompanyId: W2_COMPANIES.ironvale,
        quantityPerQuarter: 10_000, durationQuarters: 4, hardwarePriceReference: 'seller_quote', premiumPct: 5,
        maxUnitPriceUsd: 1_000_000, priority: 9, nonExclusive: true, cancellable: true, contractEndQuarter: state.quarter + 4,
      }],
      gets: [], confidentiality: 'private', expiresQuarter: state.quarter + 1, binding: true, intentStatements: [],
      summary: 'A four-quarter hardware title-transfer contract with a maximum commitment of four billion dollars.',
    },
  };
}

function submitted(state: SessionState, intent: ActionIntent): SubmittedAction {
  return {
    actionId: 'act_tessellate_material_hardware', sessionId: state.sessionId, quarter: state.quarter, sequence: 0,
    actorPlayerId: null, actorCompanyId: W2_COMPANIES.tessellate, actorCharacterId: W2_FOUNDERS.tessellate,
    origin: 'npc_strategist', confirmedByHuman: false, intent,
  };
}

describe('material accelerator-contract board authority', () => {
  it('turns a material recurring hardware proposal into an exact board mandate', () => {
    const state = createWorld2Session();
    const intent = materialHardwareProposal(state);
    const supplier = company(state, W2_COMPANIES.tessellate);
    // Tessellate is normally founder-controlled without a board. Attach its
    // existing board fixture to exercise the governance gate without changing
    // the commercial validation path.
    supplier.boardId = 'brd_test_material';
    expect(boardMatterFor(intent, supplier)?.amountUsd).toBe(40_000_000_000);
    const result = createActionValidator().validateBatch(state, [submitted(state, intent)])[0]!;
    expect(result.status).toBe('clamped');
    expect(result.clampedAction).toMatchObject({ type: 'submit_board_proposal', kind: 'financing', dealProposal: intent.proposal });
  });

  it('releases only the board-approved exact contract once', () => {
    const state = createWorld2Session();
    const proposal = materialHardwareProposal(state).proposal;
    const title = 'Material hardware deal';
    const source: SubmittedAction = { ...submitted(state, { type: 'submit_board_proposal', kind: 'financing', title, summary: proposal.summary, amountUsd: 40_000_000_000, targetCompanyId: proposal.counterpartyId, stockComponentPct: null, dealProposal: proposal }), actionId: 'act_material_board_source' };
    state.pendingActions.push(source);
    state.boardProposals.push({
      id: 'prp_material_hardware', companyId: W2_COMPANIES.tessellate, boardId: state.boards[0]!.id, kind: 'financing', title, summary: proposal.summary,
      proposedByCharacterId: W2_FOUNDERS.tessellate, quarterProposed: state.quarter, decisionQuarter: state.quarter, status: 'passed', amountUsd: 40_000_000_000,
      dilutionPct: null, stockComponentPct: null, targetCompanyId: proposal.counterpartyId, linkedActionId: source.actionId, requiredThresholdFraction: 0.5, dealProposalJson: JSON.stringify(proposal),
    } satisfies BoardProposal);
    executeApprovedMaterialDeal(state);
    executeApprovedMaterialDeal(state);
    const released = state.pendingActions.filter((entry) => entry.intent.type === 'propose_deal');
    expect(released).toHaveLength(1);
    expect(released[0]?.intent).toEqual({ type: 'propose_deal', proposal });
  });
});

function pendingMaterialDeal(state: SessionState): DealProposal {
  const draft = materialHardwareProposal(state).proposal;
  return {
    ...draft, id: 'deal_pending_material_hardware', proposerId: W2_COMPANIES.tessellate, proposerKind: 'company',
    status: 'proposed', createdQuarter: state.quarter, respondedQuarter: null, conversationId: null, breachedByPartyId: null,
  };
}

describe('material accelerator-contract acceptance authority', () => {
  it('requires the buyer company’s own board before it can accept', () => {
    const state = createWorld2Session();
    const deal = pendingMaterialDeal(state);
    state.deals.push(deal);
    const buyer = company(state, W2_COMPANIES.ironvale);
    expect(buyer.boardId).not.toBeNull();
    const action: SubmittedAction = { actionId: 'act_buyer_accept', sessionId: state.sessionId, quarter: state.quarter, sequence: 0, actorPlayerId: null, actorCompanyId: buyer.id, actorCharacterId: W2_FOUNDERS.ironvale, origin: 'npc_strategist', confirmedByHuman: false, intent: { type: 'accept_deal', dealId: deal.id } };
    const result = createActionValidator().validateBatch(state, [action])[0]!;
    expect(result.clampedAction).toMatchObject({ type: 'submit_board_proposal', dealAcceptance: { dealId: deal.id, dealJson: JSON.stringify(deal) } });
  });

  it('does not treat the supplier’s approval as the buyer’s authority', () => {
    const state = createWorld2Session();
    const deal = pendingMaterialDeal(state);
    state.deals.push(deal);
    state.boardProposals.push({
      id: 'prp_supplier_only', companyId: W2_COMPANIES.tessellate, boardId: 'brd_supplier', kind: 'financing', title: 'Supplier approval', summary: deal.summary,
      proposedByCharacterId: W2_FOUNDERS.tessellate, quarterProposed: state.quarter, decisionQuarter: state.quarter, status: 'passed', amountUsd: 40_000_000_000,
      dilutionPct: null, stockComponentPct: null, targetCompanyId: deal.counterpartyId, linkedActionId: null, requiredThresholdFraction: 0.5,
      dealAcceptanceDealId: deal.id, dealAcceptanceJson: JSON.stringify(deal),
    } satisfies BoardProposal);
    const action = submitted(state, { type: 'accept_deal', dealId: deal.id });
    const buyerAction = { ...action, actorCompanyId: W2_COMPANIES.ironvale, actorCharacterId: W2_FOUNDERS.ironvale };
    expect(createActionValidator().validateBatch(state, [buyerAction])[0]?.status).toBe('clamped');
  });

  it('releases one valid buyer acceptance, but never changed or expired terms', () => {
    const state = createWorld2Session();
    const deal = pendingMaterialDeal(state);
    state.deals.push(deal);
    const boardAction: SubmittedAction = { actionId: 'act_accept_board_source', sessionId: state.sessionId, quarter: state.quarter, sequence: 0, actorPlayerId: null, actorCompanyId: W2_COMPANIES.ironvale, actorCharacterId: W2_FOUNDERS.ironvale, origin: 'npc_strategist', confirmedByHuman: false, intent: { type: 'submit_board_proposal', kind: 'financing', title: 'Accept exact hardware offer', summary: deal.summary, amountUsd: 40_000_000_000, targetCompanyId: deal.proposerId, stockComponentPct: null, dealAcceptance: { dealId: deal.id, dealJson: JSON.stringify(deal) } } };
    state.pendingActions.push(boardAction);
    state.boardProposals.push({ id: 'prp_accept_exact', companyId: W2_COMPANIES.ironvale, boardId: company(state, W2_COMPANIES.ironvale).boardId!, kind: 'financing', title: 'Accept exact hardware offer', summary: deal.summary, proposedByCharacterId: W2_FOUNDERS.ironvale, quarterProposed: state.quarter, decisionQuarter: state.quarter, status: 'passed', amountUsd: 40_000_000_000, dilutionPct: null, stockComponentPct: null, targetCompanyId: deal.proposerId, linkedActionId: boardAction.actionId, requiredThresholdFraction: 0.5, dealAcceptanceDealId: deal.id, dealAcceptanceJson: JSON.stringify(deal) } satisfies BoardProposal);
    executeApprovedMaterialDeal(state);
    executeApprovedMaterialDeal(state);
    expect(state.pendingActions.filter((entry) => entry.intent.type === 'accept_deal')).toHaveLength(1);

    const changed = createWorld2Session();
    const changedDeal = pendingMaterialDeal(changed);
    changed.deals.push(changedDeal);
    const changedAction = { ...boardAction, sessionId: changed.sessionId, quarter: changed.quarter, intent: { ...boardAction.intent, dealAcceptance: { dealId: changedDeal.id, dealJson: JSON.stringify(changedDeal) } } };
    changed.pendingActions.push(changedAction);
    changed.boardProposals.push({ ...state.boardProposals[0]!, id: 'prp_changed', companyId: W2_COMPANIES.ironvale, boardId: company(changed, W2_COMPANIES.ironvale).boardId!, linkedActionId: changedAction.actionId, dealAcceptanceDealId: changedDeal.id, dealAcceptanceJson: JSON.stringify(changedDeal) });
    changedDeal.summary = 'Terms changed after the vote.';
    executeApprovedMaterialDeal(changed);
    expect(changed.pendingActions.filter((entry) => entry.intent.type === 'accept_deal')).toHaveLength(0);

    const expired = createWorld2Session();
    const expiredDeal = pendingMaterialDeal(expired);
    expiredDeal.expiresQuarter = expired.quarter - 1;
    expired.deals.push(expiredDeal);
    const expiredAction = { ...boardAction, sessionId: expired.sessionId, quarter: expired.quarter, intent: { ...boardAction.intent, dealAcceptance: { dealId: expiredDeal.id, dealJson: JSON.stringify(expiredDeal) } } };
    expired.pendingActions.push(expiredAction);
    expired.boardProposals.push({ ...state.boardProposals[0]!, id: 'prp_expired', companyId: W2_COMPANIES.ironvale, boardId: company(expired, W2_COMPANIES.ironvale).boardId!, linkedActionId: expiredAction.actionId, dealAcceptanceDealId: expiredDeal.id, dealAcceptanceJson: JSON.stringify(expiredDeal) });
    executeApprovedMaterialDeal(expired);
    expect(expired.pendingActions.filter((entry) => entry.intent.type === 'accept_deal')).toHaveLength(0);
  });
});
