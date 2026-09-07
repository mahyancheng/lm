import { describe, expect, it } from 'vitest';
import type { DealProposalDraft } from '@frontier/contracts';
import { createWorld2Session, createWorld3Session, sellersFor } from '@frontier/simulation';
import { BoundedCharacterContextSchema } from '@/app/api/llm/_bounds';
import { acceleratorPurchaseDraft, acceleratorPurchaseQuoteStatus, canExecuteNegotiatedDraft, negotiationDraft, negotiationFacts } from './negotiation';

describe('negotiation boundaries', () => {
  it('fits the actual route bound and excludes private research with a large catalogue', () => {
    const session = createWorld3Session();
    const company = session.companies.find((c) => c.id === session.players[0]!.companyId)!;
    const target = session.characters.find((c) => c.companyId !== company.id)!;
    const privateNode = { ...session.techGraph.nodes[0]!, id: 'secret_method', title: 'Confidential Method', visibility: 'company_private' as const };
    const graph = { ...session.techGraph, nodes: [privateNode, ...session.techGraph.nodes] };
    company.products = Array.from({ length: 100 }, (_, i) => ({ ...company.products[0]!, id: 'product_' + i, name: 'Product ' + i }));
    const gameFacts = negotiationFacts(session, target, company, graph, target.companyId ?? undefined);
    expect(gameFacts.length).toBeLessThanOrEqual(40);
    expect(JSON.stringify(gameFacts)).not.toContain('Confidential Method');
    expect(JSON.stringify(gameFacts)).not.toContain('secret_method');
    expect(gameFacts.find((fact) => fact.label === 'Executable offer')?.value).toContain('Never say');
    const result = BoundedCharacterContextSchema.safeParse({ character: target, relationship: null, counterpartRelationship: null, memories: [],
      topic: 'Negotiate a licence', gameFacts, conversationHistory: [], accessBasis: 'A public business conversation.', pendingProposalSummary: null });
    expect(result.success).toBe(true);
  });

  it('accepts only a correctly addressed executable binding offer', () => {
    const draft: DealProposalDraft = { counterpartyId: 'owner', counterpartyKind: 'company', gives: [],
      gets: [{ kind: 'node_licence', nodeId: 'sys_frontier_model', ownerCompanyId: 'owner', licenseeCompanyId: 'player', royaltyPct: 12, quarters: 4, upfrontUsd: 100 }],
      binding: true, confidentiality: 'private', expiresQuarter: 2, summary: 'Licence a model for our product.', intentStatements: [] };
    expect(negotiationDraft(draft, 'owner', 0, 'player')).toEqual(draft);
    expect(negotiationDraft(draft, 'other', 0, 'player')).toBeUndefined();
    expect(negotiationDraft(draft, 'owner', 3, 'player')).toBeUndefined();
    expect(negotiationDraft(draft, 'owner', 0, 'someone_else')).toBeUndefined();
    expect(negotiationDraft({ ...draft, gives: [{ kind: 'cash_payment', amount: 10 }] }, 'owner', 0, 'player')).toBeDefined();
    expect(negotiationDraft({ ...draft, gets: [...draft.gets, { kind: 'cash_payment', amount: 10 }] }, 'owner', 0, 'player')).toBeDefined();
    expect(negotiationDraft({ ...draft, gives: [{ kind: 'public_endorsement', statement: 'We support this partnership.', quarters: 2 }] }, 'owner', 0, 'player')).toBeUndefined();
    // A CEO is not assumed to own a private company’s cap table. An equity
    // transfer therefore cannot become a chat-settled purchase merely because
    // it was discussed in dialogue.
    expect(canExecuteNegotiatedDraft({ ...draft, gives: [{ kind: 'equity_transfer', securityId: 'sec_private', shares: 100 }] })).toBe(false);
  });

  it('accepts only an exact live manufacturer quote as an accelerator order', () => {
    const session = createWorld2Session();
    const buyer = session.companies.find((company) => company.id === session.players[0]!.companyId)!;
    const seller = sellersFor(session, 'accelerators', buyer.id)[0]!;
    const draft = { sellerCompanyId: seller.company.id, units: Math.min(10, seller.sellableUnits), unitPriceUsd: seller.unitPriceUsd };
    expect(acceleratorPurchaseDraft(draft, session, buyer, seller.company.id)).toEqual(draft);
    expect(acceleratorPurchaseDraft({ ...draft, unitPriceUsd: draft.unitPriceUsd - 1 }, session, buyer, seller.company.id)).toBeUndefined();
    expect(acceleratorPurchaseDraft({ ...draft, sellerCompanyId: 'cmp_forged' }, session, buyer, seller.company.id)).toBeUndefined();
    expect(acceleratorPurchaseDraft({ ...draft, units: seller.sellableUnits + 1 }, session, buyer, seller.company.id)).toBeUndefined();
    expect(acceleratorPurchaseQuoteStatus(draft, session, buyer)).toBe('current');
    session.world.compute.spotPrice *= 1.2;
    expect(acceleratorPurchaseQuoteStatus(draft, session, buyer)).toBe('expired');
  });
});
