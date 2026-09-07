import { DealProposalDraftSchema, type DealProposalDraft, type GameFact, type Character, type SessionState, type Company, type TechGraph } from '@frontier/contracts';
import { publicFactsFor } from './actions';

/** The same bounded, public dossier used by the live character request. */
export function negotiationFacts(session: SessionState, target: Character, company: Company, graph: TechGraph, counterpartyId?: string): GameFact[] {
  return [...publicFactsFor(session, target),
    { label: 'Player company', value: company.id },
    { label: 'Current quarter', value: String(session.quarter) },
    ...(counterpartyId ? [{ label: 'Negotiation counterparty (company)', value: counterpartyId }] : []),
    { label: 'Executable offer', value: 'Cash settles next quarter; a node_licence plus bilateral cash settles on signing. Other typed terms are intent.' },
    ...publicTechnologyFacts(graph.nodes),
    // A player's internal product catalogue is not automatically public. Only
    // lines with published supply terms are safe to hand to a rival persona.
    ...company.products.filter((p) => p.supplyTerms !== null && p.supplyTerms !== undefined).slice(0, 12)
      .map((p) => ({ label: `Published player product: ${p.name}`.slice(0, 80), value: p.id.slice(0, 120) })),
  ].slice(0, 40);
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
