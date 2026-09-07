/**
 * Cross-subsystem regression: an accepted private hardware contract has to
 * consume the same physical output ordinary spot orders use, while settling
 * through the established owned-accelerator accounting path.
 */

import { describe, expect, it } from 'vitest';
import type { ActionIntent, DealProposal, SessionState, SubmittedAction } from '@frontier/contracts';
import { createDefaultEngine } from '../src/engine';
import { sellersFor } from '../src/companies/sellers';
import { DEMO_PLAYER_ID } from '../src/scenario';
import { createWorld2Session, W2_COMPANIES } from '../src/scenario/world2';
import { W2_PLAYER_CHARACTER_ID } from '../src/scenario/world2/player';
import { W2_PLAYER_BOARD_ID } from '../src/scenario/world2/player';

function company(state: SessionState, id: string) {
  const found = state.companies.find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`Missing company ${id}`);
  return found;
}

function resolve(state: SessionState, actions: readonly SubmittedAction[] = []) {
  const outcome = createDefaultEngine().resolver.resolveQuarter(state, actions, null, []);
  const failures = outcome.invariants.filter((result) => !result.passed).map((result) => `${result.invariant}: ${result.detail}`);
  expect(failures).toEqual([]);
  expect(outcome.committed).toBe(true);
  return outcome;
}

function hardwareDeal(state: SessionState): DealProposal {
  return {
    id: 'deal_integration_tessellate_ironvale',
    proposerId: W2_COMPANIES.tessellate,
    proposerKind: 'company',
    counterpartyId: W2_COMPANIES.ironvale,
    counterpartyKind: 'company',
    gives: [{
      kind: 'owned_accelerator_supply',
      supplierCompanyId: W2_COMPANIES.tessellate,
      buyerCompanyId: W2_COMPANIES.ironvale,
      quantityPerQuarter: 100,
      durationQuarters: 2,
      hardwarePriceReference: 'seller_quote',
      premiumPct: 5,
      maxUnitPriceUsd: 1_000_000,
      priority: 10,
      nonExclusive: true,
      cancellable: true,
      contractEndQuarter: 2,
    }],
    gets: [],
    confidentiality: 'private',
    expiresQuarter: 0,
    binding: true,
    intentStatements: [],
    summary: 'Tessellate will deliver 100 owned accelerators each quarter to Ironvale.',
    status: 'accepted',
    createdQuarter: 0,
    respondedQuarter: 0,
    conversationId: null,
    breachedByPartyId: null,
  };
}

describe('recurring accelerator contract finance integration', () => {
  it('allocates the Tessellate contract before a competing spot order and stages both as owned hardware', () => {
    const opening = createWorld2Session();
    opening.deals.push(hardwareDeal(opening));

    // Acceptance in Q0 deliberately starts delivery in Q1.
    const afterAcceptance = resolve(opening).nextState;
    const capacity = sellersFor(afterAcceptance, 'accelerators', W2_COMPANIES.ironvale).find((seller) => seller.company.id === W2_COMPANIES.tessellate)?.sellableUnits ?? 0;
    expect(capacity).toBeGreaterThanOrEqual(100);

    const spotIntent: ActionIntent = {
      type: 'buy_accelerators',
      // Ask beyond the stale planning snapshot: Q1 macro can move fab output,
      // so this guarantees the spot order competes for every delivery-quarter
      // unit left after the private allocation.
      units: capacity + 10_000,
      maxPricePerUnitUsd: 1_000_000,
      sellerCompanyId: W2_COMPANIES.tessellate,
      quotedUnitPriceUsd: null,
    };
    const spotOrder: SubmittedAction = {
      actionId: 'act_integration_competing_spot',
      sessionId: afterAcceptance.sessionId,
      quarter: afterAcceptance.quarter,
      sequence: 1,
      actorPlayerId: DEMO_PLAYER_ID,
      actorCompanyId: W2_COMPANIES.player,
      actorCharacterId: W2_PLAYER_CHARACTER_ID,
      origin: 'player_ui',
      intent: spotIntent,
      confirmedByHuman: true,
    };

    // A twin resolution with the contract removed establishes the exact Q1
    // manufacturer output after macro movement.  Comparing like-for-like keeps
    // this conservation assertion independent of a changing fab index.
    const noContract = JSON.parse(JSON.stringify(afterAcceptance)) as SessionState;
    noContract.deals = noContract.deals.filter((deal) => deal.id !== 'deal_integration_tessellate_ironvale');
    const baseline = resolve(noContract, [spotOrder]);
    const baselineShipment = baseline.events.find(
      (event) => event.type === 'accelerators_bought' && event.actorId === W2_COMPANIES.player && event.targetId === W2_COMPANIES.tessellate,
    );
    const baselineUnits = typeof baselineShipment?.payload.units === 'number' ? baselineShipment.payload.units : 0;

    const outcome = resolve(afterAcceptance, [spotOrder]);
    const contract = outcome.nextState.deals.find((deal) => deal.id === 'deal_integration_tessellate_ironvale');
    const receipt = contract?.settlements?.[0];
    expect(receipt).toMatchObject({ status: 'delivered', dueUnits: 100, deliveredUnits: 100 });

    const buyer = company(outcome.nextState, W2_COMPANIES.ironvale);
    expect(buyer.compute.ownedAccelerators).toBe(company(afterAcceptance, W2_COMPANIES.ironvale).compute.ownedAccelerators + 100);

    const spotShipment = outcome.events.find(
      (event) => event.type === 'accelerators_bought' && event.actorId === W2_COMPANIES.player && event.targetId === W2_COMPANIES.tessellate,
    );
    const spotUnits = typeof spotShipment?.payload.units === 'number' ? spotShipment.payload.units : 0;
    expect(spotUnits).toBe(baselineUnits - 100);
    expect(receipt?.deliveredUnits ?? 0).toBe(100);
    expect(spotUnits + (receipt?.deliveredUnits ?? 0)).toBe(baselineUnits);

    const contractEvent = outcome.events.find(
      (event) => event.type === 'accelerators_bought' && event.payload.dealId === 'deal_integration_tessellate_ironvale',
    );
    expect(contractEvent?.payload).toMatchObject({ supplierCompanyId: W2_COMPANIES.tessellate, buyerCompanyId: W2_COMPANIES.ironvale, totalUsd: receipt?.totalUsd });
  });
});

describe('financing mandate integration', () => {
  const debtIntent: ActionIntent = { type: 'issue_debt', amountUsd: 1_000_000, maxRatePct: 0.5, termQuarters: 8 };

  function playerDebtAction(state: SessionState, intent: ActionIntent = debtIntent): SubmittedAction {
    return {
      actionId: 'act_integration_board_debt',
      sessionId: state.sessionId,
      quarter: state.quarter,
      sequence: 1,
      actorPlayerId: DEMO_PLAYER_ID,
      actorCompanyId: W2_COMPANIES.player,
      actorCharacterId: W2_PLAYER_CHARACTER_ID,
      origin: 'player_ui',
      intent,
      confirmedByHuman: true,
    };
  }

  function passedDebtMandate(state: SessionState): void {
    state.boardProposals.push({
      id: 'prp_integration_exact_debt',
      companyId: W2_COMPANIES.player,
      boardId: W2_PLAYER_BOARD_ID,
      kind: 'financing',
      title: 'Authorise exact debt terms',
      summary: 'The board approved exactly $1m of eight-quarter debt at no more than 50% annual interest.',
      proposedByCharacterId: W2_PLAYER_CHARACTER_ID,
      quarterProposed: state.quarter,
      decisionQuarter: state.quarter,
      status: 'passed',
      amountUsd: 1_000_000,
      dilutionPct: null,
      stockComponentPct: null,
      targetCompanyId: null,
      linkedActionId: null,
      debtTerms: { amountUsd: 1_000_000, maxRatePct: 0.5, termQuarters: 8 },
      requiredThresholdFraction: 0.5,
    });
  }

  it('executes an exact approved player debt mandate in the current capital phase', () => {
    const state = createWorld2Session();
    state.world.capitalMarkets.debtAvailability = 1;
    passedDebtMandate(state);
    const outcome = resolve(state, [playerDebtAction(state)]);
    const issuance = outcome.events.find(
      (event) => event.type === 'debt_issued' && event.actorId === W2_COMPANIES.player && event.payload.cleared === true,
    );
    expect(issuance?.payload).toMatchObject({ amountUsd: 1_000_000, termQuarters: 8 });
    expect(typeof issuance?.payload.debtAfter).toBe('number');
    expect(outcome.events.some((event) => event.type === 'action_clamped' && event.targetId === 'act_integration_board_debt')).toBe(false);
  });

  it('does not treat an exact debt mandate as approval for changed terms', () => {
    const state = createWorld2Session();
    state.world.capitalMarkets.debtAvailability = 1;
    passedDebtMandate(state);
    const changed: ActionIntent = { type: 'issue_debt', amountUsd: 1_100_000, maxRatePct: 0.5, termQuarters: 8 };
    const outcome = resolve(state, [playerDebtAction(state, changed)]);
    expect(outcome.events.some((event) => event.type === 'debt_issued' && event.actorId === W2_COMPANIES.player && event.payload.cleared === true)).toBe(false);
    expect(outcome.events.some((event) => event.type === 'action_clamped' && event.targetId === 'act_integration_board_debt')).toBe(true);
  });
});
