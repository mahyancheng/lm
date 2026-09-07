import { AcceleratorPurchaseDraftSchema, DealProposalDraftSchema, type AcceleratorPurchaseDraft, type DealProposalDraft, type GameFact, type Character, type SessionState, type Company, type TechGraph } from '@frontier/contracts';
import { sellersFor } from '@frontier/simulation';
import { publicFactsFor } from './actions';

/** The same bounded, public dossier used by the live character request. */
export function negotiationFacts(session: SessionState, target: Character, company: Company, graph: TechGraph, counterpartyId?: string): GameFact[] {
  const acceleratorOffer = counterpartyId === undefined ? undefined : sellersFor(session, 'accelerators', company.id).find((seller) => seller.company.id === counterpartyId);
  return [...publicFactsFor(session, target),
    { label: 'Player company', value: company.id },
    { label: 'Current quarter', value: String(session.quarter) },
    ...(counterpartyId ? [{ label: 'Negotiation counterparty (company)', value: counterpartyId }] : []),
    {
      label: 'Executable offer',
      value: 'Cash settles next quarter. Node licences sign now. Other purchases use separate routes. Never say chat closed one.',
    },
    ...(acceleratorOffer === undefined ? [] : [{
      label: 'Published accelerator offer',
      value: `${acceleratorOffer.company.id}: ${acceleratorOffer.sellableUnits} units at $${acceleratorOffer.unitPriceUsd} each this quarter.`,
    }]),
    ...publicTechnologyFacts(graph.nodes),
    // A player's internal product catalogue is not automatically public. Only
    // lines with published supply terms are safe to hand to a rival persona.
    ...company.products.filter((p) => p.supplyTerms !== null && p.supplyTerms !== undefined).slice(0, 12)
      .map((p) => ({ label: `Published player product: ${p.name}`.slice(0, 80), value: p.id.slice(0, 120) })),
  ].slice(0, 40);
}

/** Reject model prose unless it exactly repeats a live manufacturer quote. */
export function acceleratorPurchaseDraft(value: unknown, session: SessionState, buyer: Company, counterpartyId: string | undefined): AcceleratorPurchaseDraft | undefined {
  const parsed = AcceleratorPurchaseDraftSchema.safeParse(value);
  if (!parsed.success || counterpartyId === undefined) return undefined;
  const draft = parsed.data;
  const seller = sellersFor(session, 'accelerators', buyer.id).find((entry) => entry.company.id === counterpartyId);
  if (seller === undefined || draft.sellerCompanyId !== seller.company.id || draft.unitPriceUsd !== seller.unitPriceUsd || draft.units > seller.sellableUnits) return undefined;
  return draft;
}

/** A once-verified quote stays visible after a quarter, but cannot be reused once its offer changed. */
export function acceleratorPurchaseQuoteStatus(draft: AcceleratorPurchaseDraft, session: SessionState, buyer: Company): 'current' | 'expired' {
  const seller = sellersFor(session, 'accelerators', buyer.id).find((entry) => entry.company.id === draft.sellerCompanyId);
  return seller !== undefined && seller.unitPriceUsd === draft.unitPriceUsd && seller.sellableUnits >= draft.units ? 'current' : 'expired';
}

/**
 * Ordinary deal obligations do not all have an executor yet.  Keep dialogue
 * from presenting a model-generated promise as binding until the resolver has
 * a deterministic settlement path for it.  Node licences are handled by the
 * existing licence executor. Other commercial terms remain proposals only.
 */
export const EXECUTABLE_NEGOTIATION_KINDS = ['node_licence', 'cash_payment'] as const;

export function canExecuteNegotiatedDraft(draft: DealProposalDraft): boolean {
  if (!draft.binding) return true;
  const obligations = [...draft.gives, ...draft.gets];
  // A node licence is canonical only when addressed to the counterparty on
  // gets. Cash is the one separately-executed consideration it may carry.
  const licences = obligations.filter((obligation) => obligation.kind === 'node_licence');
  if (licences.length > 0) {
    return licences.length === 1 && draft.gets.filter((obligation) => obligation.kind === 'node_licence').length === 1 && obligations.every((obligation) => obligation.kind === 'node_licence' || obligation.kind === 'cash_payment');
  }
  return obligations.every((obligation) => obligation.kind === 'cash_payment');
}

/** Public technology facts safe for a rival context, bounded for the LLM wire. */
export function publicTechnologyFacts(
  nodes: readonly { readonly id: string; readonly title: string; readonly visibility: string }[],
): { readonly label: string; readonly value: string }[] {
  return nodes
    .filter((node) => node.visibility === 'public')
    .slice(0, 12)
    .map((node) => ({ label: `Public technology: ${node.title}`.slice(0, 80), value: node.id.slice(0, 120) }));
}

/** Dialogue can suggest terms, but cannot redirect a deal to another party. */
export function negotiationDraft(value: unknown, counterpartyId: string | undefined, quarter: number, proposerId?: string): DealProposalDraft | undefined {
  const parsed = DealProposalDraftSchema.safeParse(value);
  if (!parsed.success || !counterpartyId) return undefined;
  const draft = parsed.data;
  if (draft.counterpartyKind !== 'company' || draft.counterpartyId !== counterpartyId || draft.expiresQuarter < quarter) return undefined;
  if (draft.gives.length + draft.gets.length === 0) return undefined;
  if (!canExecuteNegotiatedDraft(draft)) return undefined;
  const licence = draft.gets[0]?.kind === 'node_licence' ? draft.gets[0] : null;
  if (licence !== null && licence.ownerCompanyId !== counterpartyId) return undefined;
  if (licence !== null && proposerId !== undefined && licence.licenseeCompanyId !== proposerId) return undefined;
  return draft;
}

/**
 * The only deal language supplied back to an NPC. It is derived from typed
 * queued actions and canonical deal state; conversational prose is excluded.
 */
type RecentLedgerEvent = {
  readonly type: string;
  readonly actorId: string | null;
  readonly targetId: string | null;
  readonly payload: unknown;
  /** Present on canonical ledger rows; optional only for older callers. */
  readonly quarter?: number;
  readonly sequence?: number;
};

function eventPayload(event: RecentLedgerEvent | undefined): Record<string, unknown> | undefined {
  return event !== undefined && event.payload !== null && typeof event.payload === 'object' && !Array.isArray(event.payload)
    ? event.payload as Record<string, unknown>
    : undefined;
}

function numberPayload(payload: Record<string, unknown> | undefined, field: string): number | undefined {
  const value = payload?.[field];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * The session after a resolved turn opens the next quarter, so only rows from
 * `session.quarter - 1` describe the last outcome.  `ledger` may contain the
 * full history and must never turn an old shipment into a fresh promise.
 */
function lastAcceleratorOutcome(
  session: SessionState,
  recentEvents: readonly RecentLedgerEvent[],
  playerCompanyId: string,
  counterpartyCompanyId: string,
): { event: RecentLedgerEvent; partial?: RecentLedgerEvent } | undefined {
  const resolvedQuarter = session.quarter - 1;
  const currentRows = recentEvents.filter((event) => event.quarter === resolvedQuarter && event.actorId === playerCompanyId && event.targetId === counterpartyCompanyId);
  const outcome = currentRows
    .filter((event) => event.type === 'accelerators_bought' || (event.type === 'cost_recognised' && eventPayload(event)?.kind === 'accelerator_purchase_failed'))
    .sort((a, b) => (b.sequence ?? -1) - (a.sequence ?? -1))[0];
  if (outcome === undefined) return undefined;
  if (outcome.type !== 'accelerators_bought') return { event: outcome };

  // The resolver emits a partial-fill row immediately before the shipment. A
  // closest preceding row is the only safe association available on the
  // append-only event schema (which deliberately has no client action id).
  const partial = currentRows
    .filter((event) => event.type === 'information_revealed' && eventPayload(event)?.kind === 'partial_fill' && eventPayload(event)?.actionType === 'buy_accelerators' && (event.sequence ?? -1) <= (outcome.sequence ?? Number.MAX_SAFE_INTEGER))
    .sort((a, b) => (b.sequence ?? -1) - (a.sequence ?? -1))[0];
  return { event: outcome, ...(partial === undefined ? {} : { partial }) };
}

export function proposalStatusSummary(
  session: SessionState,
  queued: readonly { readonly action: { readonly actorCompanyId: string; readonly intent: unknown } }[],
  playerCompanyId: string,
  counterpartyCompanyId: string | undefined,
  recentEvents: readonly RecentLedgerEvent[] = [],
): string | null {
  if (counterpartyCompanyId === undefined) return null;
  const queuedOffer = queued.some(({ action }) => {
    if (action.actorCompanyId !== playerCompanyId || action.intent === null || typeof action.intent !== 'object') return false;
    const intent = action.intent as { type?: unknown; proposal?: { counterpartyId?: unknown } };
    return intent.type === 'propose_deal' && intent.proposal?.counterpartyId === counterpartyCompanyId;
  });
  const queuedAcceleratorOrder = queued.some(({ action }) => {
    if (action.actorCompanyId !== playerCompanyId || action.intent === null || typeof action.intent !== 'object') return false;
    const intent = action.intent as { type?: unknown; sellerCompanyId?: unknown };
    return intent.type === 'buy_accelerators' && intent.sellerCompanyId === counterpartyCompanyId;
  });
  const acceleratorOutcome = lastAcceleratorOutcome(session, recentEvents, playerCompanyId, counterpartyCompanyId);
  const deals = session.deals
    .filter((deal) =>
      (deal.proposerId === playerCompanyId && deal.counterpartyId === counterpartyCompanyId) ||
      (deal.proposerId === counterpartyCompanyId && deal.counterpartyId === playerCompanyId),
    )
    .slice()
    .sort((a, b) => b.createdQuarter - a.createdQuarter || b.id.localeCompare(a.id))
    .slice(0, 3);
  const lines: string[] = [];
  if (queuedOffer) lines.push('A typed offer is queued for this quarter; it has not been proposed or accepted yet.');
  if (queuedAcceleratorOrder) lines.push('A confirmed accelerator order is queued for this quarter; it has not filled yet.');
  if (acceleratorOutcome?.event.type === 'cost_recognised') {
    const reason = eventPayload(acceleratorOutcome.event)?.reason;
    lines.push(`The recorded accelerator order did not fill in the last resolved quarter${typeof reason === 'string' ? `: ${reason}.` : '.'}`);
  } else if (acceleratorOutcome !== undefined) {
    const delivered = numberPayload(eventPayload(acceleratorOutcome.event), 'units');
    const requested = numberPayload(eventPayload(acceleratorOutcome.partial), 'asked');
    if (requested !== undefined && delivered !== undefined && delivered < requested) {
      lines.push(`The recorded accelerator order partially filled in the last resolved quarter: ${delivered} of ${requested} accelerators arrived.`);
    } else if (delivered !== undefined) {
      lines.push(`The recorded accelerator order filled in the last resolved quarter: ${delivered} accelerators arrived.`);
    } else {
      lines.push('The recorded accelerator order filled in the last resolved quarter.');
    }
  }
  for (const deal of deals) {
    const execution = deal.status === 'executed'
      ? 'all recorded obligations executed'
      : deal.status === 'accepted'
        ? (deal.binding ? 'accepted; binding obligations await their scheduled execution' : 'accepted as non-binding intent only')
        : deal.status === 'proposed'
          ? 'proposed; awaiting a response'
          : deal.status;
    lines.push(`Canonical deal ${deal.id}: ${execution}.`);
  }
  return lines.length === 0 ? null : lines.join(' ').slice(0, 600);
}
