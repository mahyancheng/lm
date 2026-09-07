import { describe, expect, it } from 'vitest';
import { CharacterReplySchema, type SubmittedAction } from '@frontier/contracts';
import { createDefaultEngine, createWorld2Session, sellersFor } from '@frontier/simulation';
import { hashState } from '@frontier/shared';
import { acceleratorPurchaseDraft, proposalStatusSummary } from './negotiation';

describe('dialogue accelerator-purchase bridge', () => {
  it('turns an exact typed CEO quote into a reviewed owned-accelerator order and reports its recorded fill next quarter', () => {
    const state = createWorld2Session();
    const player = state.companies.find((company) => company.id === state.players[0]!.companyId)!;
    // Fund the test without changing the accounting identity; the test is
    // about the named physical purchase, not a liquidity rejection.
    const addedCash = 1_000_000_000 - player.financials.cash;
    player.financials.cash += addedCash;
    player.balanceSheet.assets.cash += addedCash;
    player.balanceSheet.equity += addedCash;
    const seller = sellersFor(state, 'accelerators', player.id)[0]!;
    const units = Math.min(100, seller.sellableUnits);
    const reply = CharacterReplySchema.parse({
      text: 'We can supply the published quantity at the published price.',
      acceleratorPurchaseDraft: { sellerCompanyId: seller.company.id, units, unitPriceUsd: seller.unitPriceUsd },
      newCommitment: null,
      relationshipDeltas: { trust: 0, respect: 0, hostility: 0 },
      memoryToStore: null,
    });
    const quote = acceleratorPurchaseDraft(reply.acceleratorPurchaseDraft, state, player, seller.company.id);
    expect(quote).toEqual(reply.acceleratorPurchaseDraft);
    if (quote === undefined) throw new Error('exact CEO quote was not reviewable');

    const action: SubmittedAction = {
      actionId: 'act_ceo_accelerator_quote', sessionId: state.sessionId, quarter: state.quarter, sequence: 1,
      actorPlayerId: state.players[0]!.playerId, actorCompanyId: player.id, actorCharacterId: state.players[0]!.characterId,
      origin: 'player_ui', confirmedByHuman: true,
      // This is precisely the action the seller-locked, quoted BuyAccelerators
      // confirmation submits: no alternative seller and no price headroom.
      intent: { type: 'buy_accelerators', sellerCompanyId: quote.sellerCompanyId, units: quote.units, maxPricePerUnitUsd: quote.unitPriceUsd, quotedUnitPriceUsd: quote.unitPriceUsd },
    };
    expect(proposalStatusSummary(state, [{ action }], player.id, seller.company.id)).toContain('confirmed accelerator order is queued');
    const before = { owned: player.compute.ownedAccelerators, ppe: player.balanceSheet.assets.ppe, cash: player.financials.cash };
    const replayState = JSON.parse(JSON.stringify(state)) as typeof state;

    const outcome = createDefaultEngine().resolver.resolveQuarter(state, [action], null, []);
    const replay = createDefaultEngine().resolver.resolveQuarter(replayState, [action], null, []);
    expect(outcome.committed).toBe(true);
    expect(outcome.invariants.every((check) => check.passed)).toBe(true);
    expect(hashState(outcome.nextState)).toBe(hashState(replay.nextState));
    const purchased = outcome.events.find((event) => event.type === 'accelerators_bought' && event.actorId === player.id && event.targetId === seller.company.id);
    expect(purchased).toBeDefined();
    expect(purchased?.payload).toMatchObject({ sellerCompanyId: seller.company.id, units, unitPriceUsd: seller.unitPriceUsd });
    const totalUsd = Number(purchased?.payload.totalUsd);
    const after = outcome.nextState.companies.find((company) => company.id === player.id)!;
    expect(after.compute.ownedAccelerators).toBe(before.owned + units);
    expect(after.balanceSheet.assets.ppe).toBeGreaterThan(before.ppe);
    expect(after.financials.cash).toBeLessThan(before.cash);
    expect(after.financials.capex).toBe(totalUsd);
    const sellerRevenue = outcome.events.find((event) => event.type === 'revenue_recognised' && event.actorId === seller.company.id);
    expect(Number(sellerRevenue?.payload.interCompanyRevenueUsd)).toBeGreaterThanOrEqual(totalUsd);
    expect(proposalStatusSummary(outcome.nextState, [], player.id, seller.company.id, outcome.events)).toContain('recorded accelerator order filled');
  });

  it('reports only the latest resolved-quarter accelerator outcome, including partial fills and failures', () => {
    const state = createWorld2Session();
    const player = state.companies.find((company) => company.id === state.players[0]!.companyId)!;
    const seller = sellersFor(state, 'accelerators', player.id)[0]!;
    const afterResolution = { ...state, quarter: state.quarter + 1 };
    const lastQuarter = afterResolution.quarter - 1;

    const failedAfterAnOlderFill = proposalStatusSummary(afterResolution, [], player.id, seller.company.id, [
      { type: 'accelerators_bought', actorId: player.id, targetId: seller.company.id, quarter: lastQuarter - 1, sequence: 9, payload: { units: 80 } },
      { type: 'cost_recognised', actorId: player.id, targetId: seller.company.id, quarter: lastQuarter, sequence: 2, payload: { kind: 'accelerator_purchase_failed', reason: 'no_capacity', sellerCompanyId: seller.company.id } },
    ]);
    expect(failedAfterAnOlderFill).toContain('did not fill in the last resolved quarter: no_capacity');
    expect(failedAfterAnOlderFill).not.toContain('filled in the last resolved quarter');

    const partial = proposalStatusSummary(afterResolution, [], player.id, seller.company.id, [
      { type: 'information_revealed', actorId: player.id, targetId: seller.company.id, quarter: lastQuarter, sequence: 3, payload: { kind: 'partial_fill', actionType: 'buy_accelerators', asked: 100, got: 30 } },
      { type: 'accelerators_bought', actorId: player.id, targetId: seller.company.id, quarter: lastQuarter, sequence: 4, payload: { units: 30 } },
    ]);
    expect(partial).toContain('partially filled in the last resolved quarter: 30 of 100 accelerators arrived');

    expect(proposalStatusSummary(afterResolution, [], player.id, seller.company.id, [])).toBeNull();
  });

  it('does not let a forged quote or a colliding action id reuse a valid receipt', () => {
    const state = createWorld2Session();
    const player = state.companies.find((company) => company.id === state.players[0]!.companyId)!;
    const addedCash = 1_000_000_000 - player.financials.cash;
    player.financials.cash += addedCash;
    player.balanceSheet.assets.cash += addedCash;
    player.balanceSheet.equity += addedCash;
    const seller = sellersFor(state, 'accelerators', player.id)[0]!;
    const units = Math.min(10, seller.sellableUnits);
    const valid: SubmittedAction = {
      actionId: 'act_quote_collision', sessionId: state.sessionId, quarter: state.quarter, sequence: 1,
      actorPlayerId: state.players[0]!.playerId, actorCompanyId: player.id, actorCharacterId: state.players[0]!.characterId,
      origin: 'player_ui', confirmedByHuman: true,
      intent: { type: 'buy_accelerators', sellerCompanyId: seller.company.id, units, maxPricePerUnitUsd: seller.unitPriceUsd, quotedUnitPriceUsd: seller.unitPriceUsd },
    };
    const forged: SubmittedAction = {
      ...valid,
      sequence: 2,
      // Same id is deliberately hostile: it must not borrow the first
      // receipt when it changes the quantity and price.
      intent: { type: 'buy_accelerators', sellerCompanyId: seller.company.id, units: units + 1, maxPricePerUnitUsd: seller.unitPriceUsd - 1, quotedUnitPriceUsd: seller.unitPriceUsd - 1 },
    };
    const outcome = createDefaultEngine().resolver.resolveQuarter(state, [valid, forged], null, []);
    expect(outcome.committed).toBe(true);
    expect(outcome.invariants.every((check) => check.passed)).toBe(true);
    const purchases = outcome.events.filter((event) => event.type === 'accelerators_bought' && event.actorId === player.id);
    expect(purchases).toHaveLength(1);
    expect(purchases[0]?.payload).toMatchObject({ units, unitPriceUsd: seller.unitPriceUsd });
  });

  it('does not settle a client-supplied below-market quote without a receipt', () => {
    const state = createWorld2Session();
    const player = state.companies.find((company) => company.id === state.players[0]!.companyId)!;
    const seller = sellersFor(state, 'accelerators', player.id)[0]!;
    const action: SubmittedAction = {
      actionId: 'act_forged_quote', sessionId: state.sessionId, quarter: state.quarter, sequence: 1,
      actorPlayerId: state.players[0]!.playerId, actorCompanyId: player.id, actorCharacterId: state.players[0]!.characterId,
      origin: 'player_ui', confirmedByHuman: true,
      intent: { type: 'buy_accelerators', sellerCompanyId: seller.company.id, units: 1, maxPricePerUnitUsd: 1, quotedUnitPriceUsd: 1 },
    };
    const outcome = createDefaultEngine().resolver.resolveQuarter(state, [action], null, []);
    expect(outcome.invariants.every((check) => check.passed)).toBe(true);
    expect(outcome.events.some((event) => event.type === 'accelerators_bought')).toBe(false);
    expect(outcome.events.some((event) => event.type === 'cost_recognised' && event.payload.reason === 'quote_unverified')).toBe(true);
  });

  it('rejects an old-quarter quote after the published price changes', () => {
    const state = createWorld2Session();
    const player = state.companies.find((company) => company.id === state.players[0]!.companyId)!;
    const seller = sellersFor(state, 'accelerators', player.id)[0]!;
    const oldPrice = seller.unitPriceUsd;
    state.world.compute.spotPrice *= 1.2;
    const action: SubmittedAction = {
      actionId: 'act_stale_quote', sessionId: state.sessionId, quarter: state.quarter, sequence: 1,
      actorPlayerId: state.players[0]!.playerId, actorCompanyId: player.id, actorCharacterId: state.players[0]!.characterId,
      origin: 'player_ui', confirmedByHuman: true,
      intent: { type: 'buy_accelerators', sellerCompanyId: seller.company.id, units: 1, maxPricePerUnitUsd: oldPrice, quotedUnitPriceUsd: oldPrice },
    };
    const outcome = createDefaultEngine().resolver.resolveQuarter(state, [action], null, []);
    expect(outcome.invariants.every((check) => check.passed)).toBe(true);
    expect(outcome.events.some((event) => event.type === 'accelerators_bought')).toBe(false);
    expect(outcome.events.some((event) => event.type === 'cost_recognised' && event.payload.reason === 'quote_unverified')).toBe(true);
  });

  it('uses the signed opening quote for affordability when macro repricing would make the live ask unaffordable', () => {
    const state = createWorld2Session();
    const player = state.companies.find((company) => company.id === state.players[0]!.companyId)!;
    // Enough for the signed quote and ordinary operations, deliberately below
    // the macro-repriced amount observed in this deterministic opening.
    const addedCash = 50_000_000 - player.financials.cash;
    player.financials.cash += addedCash;
    player.balanceSheet.assets.cash += addedCash;
    player.balanceSheet.equity += addedCash;
    const seller = sellersFor(state, 'accelerators', player.id)[0]!;
    const units = Math.min(1_000, seller.sellableUnits);
    const action: SubmittedAction = {
      actionId: 'act_quote_affordability', sessionId: state.sessionId, quarter: state.quarter, sequence: 1,
      actorPlayerId: state.players[0]!.playerId, actorCompanyId: player.id, actorCharacterId: state.players[0]!.characterId,
      origin: 'player_ui', confirmedByHuman: true,
      intent: { type: 'buy_accelerators', sellerCompanyId: seller.company.id, units, maxPricePerUnitUsd: seller.unitPriceUsd, quotedUnitPriceUsd: seller.unitPriceUsd },
    };
    const outcome = createDefaultEngine().resolver.resolveQuarter(state, [action], null, []);
    expect(outcome.committed).toBe(true);
    expect(outcome.invariants.every((check) => check.passed)).toBe(true);
    const bought = outcome.events.find((event) => event.type === 'accelerators_bought' && event.actorId === player.id);
    expect(bought?.payload).toMatchObject({ units, unitPriceUsd: seller.unitPriceUsd });
    expect(outcome.nextState.companies.find((company) => company.id === player.id)!.financials.cash).toBeGreaterThanOrEqual(0);
  });
});
