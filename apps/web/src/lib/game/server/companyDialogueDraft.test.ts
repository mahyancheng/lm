import { describe, expect, it } from 'vitest';
import type { CharacterReply, DealProposalDraft } from '@frontier/contracts';
import { companyDialogueDraft } from './companyDialogueDraft';
const term = { kind: 'owned_accelerator_supply' as const, supplierCompanyId: 'seller', buyerCompanyId: 'buyer', quantityPerQuarter: 10, durationQuarters: 16, hardwarePriceReference: 'seller_quote' as const, premiumPct: 5, maxUnitPriceUsd: 80000, priority: 7, nonExclusive: true, cancellable: false, contractEndQuarter: 16 };
const draft: DealProposalDraft = { counterpartyId: 'seller', counterpartyKind: 'company', gives: [], gets: [{ ...term, quantityPerQuarter: 40, durationQuarters: 1, contractEndQuarter: 1 }, term], confidentiality: 'private', expiresQuarter: 1, binding: true, intentStatements: [], summary: '50 initially then 10 each quarter for 15 quarters.' };
const output: CharacterReply = { text: 'Review the offer.', dealDraft: draft, newCommitment: null, relationshipDeltas: { trust: 0, respect: 0, hostility: 0 }, memoryToStore: null };
describe('legacy company offers', () => {
  it('preserves the exact typed schedule and reverses party perspective once', () => {
    const result = companyDialogueDraft(output, 'seller', 'buyer', 0);
    expect(result.commands).toEqual([{ type: 'propose_deal', proposal: { ...draft, counterpartyId: 'buyer', gives: [{ ...term, initialQuantity: 50 }], gets: [] } }]);
    expect(result.dealDraft).toBeUndefined();
    expect(companyDialogueDraft(result, 'seller', 'buyer', 0)).toBe(result);
  });
  it('does not manufacture a proposal from prose, expired terms or unrelated parties', () => {
    const { dealDraft: _, ...words } = output;
    expect(companyDialogueDraft(words, 'seller', 'buyer', 0)).toBe(words);
    expect(companyDialogueDraft(output, 'other', 'buyer', 0)).toBe(output);
    expect(companyDialogueDraft(output, 'seller', 'other', 0)).toBe(output);
    expect(companyDialogueDraft(output, 'seller', 'buyer', 2)).toBe(output);
  });
});
