import { ActionIntentSchema, DealProposalDraftSchema, type CharacterReply } from '@frontier/contracts';

/** Older dialogue emits player-perspective drafts. Convert their typed terms,
 * never their prose, into a reviewable offer from the speaking company. */
export function companyDialogueDraft(output: CharacterReply, companyId: string, playerCompanyId: string, quarter: number): CharacterReply {
  if ((output.commands?.length ?? 0) > 0 || output.dealDraft === undefined) return output;
  const parsed = DealProposalDraftSchema.safeParse(output.dealDraft);
  if (!parsed.success) return output;
  const draft = parsed.data;
  if (draft.counterpartyKind !== 'company' || draft.counterpartyId !== companyId || draft.expiresQuarter < quarter || draft.gives.length + draft.gets.length === 0) return output;
  const hardware = [...draft.gives, ...draft.gets].filter((term) => term.kind === 'owned_accelerator_supply');
  if (hardware.some((term) => term.supplierCompanyId !== companyId || term.buyerCompanyId !== playerCompanyId)) return output;
  // These variants have deterministic settlement paths. Leave other legacy
  // drafts to their existing review surface rather than inventing executors.
  if ([...draft.gives, ...draft.gets].some((term) => term.kind !== 'owned_accelerator_supply' && term.kind !== 'cash_payment')) return output;
  let gives = draft.gets;
  let gets = draft.gives;
  if (hardware.length > 1) {
    // Legacy models represented a larger first instalment as overlapping
    // one-quarter and recurring legs. Collapse only that exact schedule.
    if (hardware.length !== 2 || draft.gives.length !== 0 || draft.gets.length !== 2) return output;
    const first = hardware.find((term) => term.durationQuarters === 1);
    const recurring = hardware.find((term) => term.durationQuarters > 1);
    if (!first || !recurring || first.initialQuantity !== undefined || recurring.initialQuantity !== undefined) return output;
    const common = (term: typeof first) => ({ supplierCompanyId: term.supplierCompanyId, buyerCompanyId: term.buyerCompanyId, hardwarePriceReference: term.hardwarePriceReference, premiumPct: term.premiumPct, maxUnitPriceUsd: term.maxUnitPriceUsd, priority: term.priority, nonExclusive: term.nonExclusive, cancellable: term.cancellable });
    if (JSON.stringify(common(first)) !== JSON.stringify(common(recurring))) return output;
    gives = [{ ...recurring, initialQuantity: first.quantityPerQuarter + recurring.quantityPerQuarter }];
    gets = [];
  }
  const command = ActionIntentSchema.safeParse({ type: 'propose_deal', proposal: { ...draft, counterpartyId: playerCompanyId, gives, gets } });
  if (!command.success) return output;
  const { dealDraft: _draft, ...rest } = output;
  return { ...rest, commands: [command.data] };
}
