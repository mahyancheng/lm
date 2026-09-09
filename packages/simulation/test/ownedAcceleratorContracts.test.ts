import { describe, expect, it } from 'vitest';
import { SessionStateSchema, type DealProposal, type SessionState } from '@frontier/contracts';
import { createDefaultEngine } from '../src/engine';
import { createWorld2Session, W2_COMPANIES } from '../src/scenario/world2';

function resolve(state: SessionState) {
  const out = createDefaultEngine().resolver.resolveQuarter(state, [], null, []);
  expect(out.committed).toBe(true);
  expect(out.invariants.filter((x) => !x.passed)).toEqual([]);
  return out;
}
function deal(state: SessionState, patch: Partial<Extract<DealProposal['gives'][number], { kind: 'owned_accelerator_supply' }>> = {}): DealProposal {
  const terms = {
    kind: 'owned_accelerator_supply' as const, supplierCompanyId: W2_COMPANIES.tessellate, buyerCompanyId: W2_COMPANIES.ironvale,
    quantityPerQuarter: 10, durationQuarters: 3, hardwarePriceReference: 'seller_quote' as const, premiumPct: 5,
    maxUnitPriceUsd: 1_000_000, priority: 10, nonExclusive: true, cancellable: true, contractEndQuarter: 4, ...patch,
  };
  return { id: 'deal_owned_contract', proposerId: terms.supplierCompanyId, proposerKind: 'company', counterpartyId: terms.buyerCompanyId,
    counterpartyKind: 'company', gives: [terms], gets: [], confidentiality: 'private', expiresQuarter: 0, binding: true,
    intentStatements: [], summary: 'A binding three-quarter owned accelerator supply contract.', status: 'accepted',
    createdQuarter: 0, respondedQuarter: 0, conversationId: null, breachedByPartyId: null };
}
function seeded(patch: Parameters<typeof deal>[1] = {}) { const s = createWorld2Session(); s.deals.push(deal(s, patch)); return s; }

describe('owned accelerator supply contracts', () => {
  it('delivers three instalments, remains accepted after the first, and replay hashes identically', () => {
    let a = seeded(); let b = JSON.parse(JSON.stringify(a)) as SessionState;
    for (let q = 0; q < 4; q += 1) {
      const ao = resolve(a); const bo = resolve(b);
      expect(JSON.stringify(ao.nextState)).toBe(JSON.stringify(bo.nextState));
      a = ao.nextState; b = bo.nextState;
      const d = a.deals[0]!;
      if (q <= 1) expect(d.status).toBe('accepted');
    }
    const d = a.deals[0]!;
    expect(d.status).toBe('executed');
    expect(d.settlements?.map((x) => x.status)).toEqual(['delivered', 'delivered', 'delivered']);
    expect(SessionStateSchema.parse(a).deals[0]?.settlements).toHaveLength(3);
  });

  it('records a price-cap suspension without a supplier breach or cash side payment', () => {
    const out = resolve(resolve(seeded({ maxUnitPriceUsd: 1 })).nextState);
    const d = out.nextState.deals[0]!;
    expect(d.status).toBe('accepted');
    expect(d.breachedByPartyId).toBeNull();
    expect(d.settlements?.[0]).toMatchObject({ status: 'price_cap_unmet', deliveredUnits: 0, totalUsd: 0 });
  });

  it('expires explicitly when the supplier becomes inactive', () => {
    const s = resolve(seeded()).nextState;
    const seller = s.companies.find((x) => x.id === W2_COMPANIES.tessellate)!;
    seller.isActive = false;
    const out = resolve(s);
    const d = out.nextState.deals[0]!;
    expect(d.status).toBe('executed');
    expect(d.settlements?.[0]?.status).toBe('expired');
    expect(out.events.some((x) => x.type === 'deal_breached')).toBe(true);
  });

  it('expires with a ledger event when the contract end passes before an instalment', () => {
    const out = resolve(resolve(seeded({ contractEndQuarter: 0 })).nextState);
    const d = out.nextState.deals[0]!;
    expect(d.status).toBe('executed');
    expect(d.settlements?.[0]?.status).toBe('expired');
    expect(out.events.some((x) => x.type === 'deal_breached')).toBe(true);
  });

  it('cancels only future instalments after an already delivered instalment', () => {
    const first = resolve(resolve(seeded()).nextState);
    const buyer = first.nextState.companies.find((x) => x.id === W2_COMPANIES.ironvale)!;
    const action = {
      actionId: 'cancel_owned_contract', sessionId: first.nextState.sessionId, quarter: first.nextState.quarter, sequence: 1,
      actorPlayerId: buyer.controllerPlayerId, actorCompanyId: buyer.id, actorCharacterId: buyer.ceoCharacterId!, origin: 'npc_default' as const,
      intent: { type: 'cancel_deal' as const, dealId: 'deal_owned_contract', reason: 'Future capacity is no longer needed.' }, confirmedByHuman: false,
    };
    const out = createDefaultEngine().resolver.resolveQuarter(first.nextState, [action], null, []);
    expect(out.committed).toBe(true);
    const d = out.nextState.deals[0]!;
    expect(d.status).toBe('executed');
    expect(d.settlements?.some((x) => x.status === 'delivered')).toBe(true);
    expect(d.settlements?.at(-1)).toMatchObject({ status: 'cancelled', dueUnits: 0, deliveredUnits: 0 });
  });

  it('records a scarce partial delivery without turning it into a default', () => {
    const out = resolve(resolve(seeded({ quantityPerQuarter: 50_000_000 })).nextState);
    const d = out.nextState.deals[0]!;
    expect(d.status).toBe('accepted');
    expect(d.breachedByPartyId).toBeNull();
    expect(d.settlements?.[0]).toMatchObject({ status: 'partial', dueUnits: 50_000_000 });
    expect(d.settlements?.[0]?.deliveredUnits ?? 0).toBeGreaterThan(0);
  });

  it('records a true zero-output default and terminates the contract', () => {
    const s = resolve(seeded()).nextState;
    const seller = s.companies.find((x) => x.id === W2_COMPANIES.tessellate)!;
    const ppe = seller.balanceSheet.assets.ppe;
    seller.balanceSheet.assets.ppe = 0;
    seller.balanceSheet.equity -= ppe;
    seller.compute.ownedAccelerators = 0;
    const out = resolve(s);
    const d = out.nextState.deals[0]!;
    expect(d.status).toBe('executed');
    expect(d.breachedByPartyId).toBe(W2_COMPANIES.tessellate);
    expect(d.settlements?.[0]).toMatchObject({ status: 'defaulted', deliveredUnits: 0 });
  });

  it('rejects a unilateral exclusive hardware proposal at the full resolver boundary', () => {
    const s = createWorld2Session();
    const seller = s.companies.find((x) => x.id === W2_COMPANIES.tessellate)!;
    const proposal = { ...deal(s, { nonExclusive: false }), status: undefined };
    const action = {
      actionId: 'exclusive_offer', sessionId: s.sessionId, quarter: s.quarter, sequence: 1,
      actorPlayerId: seller.controllerPlayerId, actorCompanyId: seller.id, actorCharacterId: seller.ceoCharacterId!, origin: 'npc_default' as const,
      intent: { type: 'propose_deal' as const, proposal: {
        counterpartyId: W2_COMPANIES.ironvale, counterpartyKind: 'company' as const, gives: proposal.gives, gets: [],
        confidentiality: 'private' as const, expiresQuarter: 1, binding: true, intentStatements: [], summary: 'An invalid unilateral exclusive hardware offer.'
      } }, confirmedByHuman: false,
    };
    const out = createDefaultEngine().resolver.resolveQuarter(s, [action], null, []);
    expect(out.nextState.deals.some((x) => x.summary === 'An invalid unilateral exclusive hardware offer.')).toBe(false);
  });

});


it('settles a larger first delivery then the recurring quantity without repeating the first instalment', () => {
  let state = seeded({ initialQuantity: 50, quantityPerQuarter: 10, durationQuarters: 3 });
  for (let q = 0; q < 4; q++) state = resolve(state).nextState;
  expect(state.deals[0]!.settlements?.map((row) => row.dueUnits)).toEqual([50, 10, 10]);
  expect(state.deals[0]!.settlements?.map((row) => row.deliveredUnits)).toEqual([50, 10, 10]);
  expect(state.deals[0]!.status).toBe('executed');
  expect(SessionStateSchema.parse(state).deals[0]!.gives[0]).toMatchObject({ initialQuantity: 50 });
});
