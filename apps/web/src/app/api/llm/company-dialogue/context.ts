import type { CharacterUtteranceContext } from '@frontier/contracts';
import { sellersFor } from '@frontier/simulation';
import type { loadCanonicalCompanyDialogue } from '@/lib/game/server/sessionAuthority';

type CanonicalDialogue = NonNullable<ReturnType<typeof loadCanonicalCompanyDialogue>>;
const chunks = (value: string, size = 116): string[] => Array.from({ length: Math.ceil(value.length / size) }, (_, index) => value.slice(index * size, (index + 1) * size));

/** Private server-only commercial dossier. It is never returned to the browser. */
export function buildCompanyDialogueContext(canonical: CanonicalDialogue, companyId: string, playerId: string, message: string): { context: CharacterUtteranceContext; playerCompanyId: string; playerCharacterId: string } | null {
  const state = canonical.state;
  const company = state.companies.find((entry) => entry.id === companyId);
  const player = state.players.find((entry) => entry.playerId === playerId) ?? state.players[0];
  const playerCompany = state.companies.find((entry) => entry.id === player?.companyId);
  const ceo = state.characters.find((entry) => entry.id === company?.ceoCharacterId) ?? state.characters.find((entry) => entry.companyId === companyId);
  if (!company || !player || !playerCompany || !ceo) return null;
  const thread = (state.conversationThreads ?? []).find((entry) => entry.playerCompanyId === playerCompany.id && entry.playerCharacterId === player.characterId && entry.targetCharacterId === ceo.id && entry.targetCompanyId === companyId);
  const memories = state.memories.filter((memory) => memory.ownerCharacterId === ceo.id && (memory.aboutId === player.characterId || memory.aboutId === playerCompany.id)).slice(-8);
  const facts: CharacterUtteranceContext['gameFacts'] = [
    { label: 'Current quarter', value: String(state.quarter) }, { label: 'NPC company ID', value: company.id }, { label: 'Player buyer company ID', value: playerCompany.id },
    { label: 'PRIVATE company cash', value: `${Math.round(company.financials.cash)}; internal only; do not disclose unless intentionally negotiated` },
  ];
  const seller = sellersFor(state, 'accelerators', playerCompany.id).find((entry) => entry.company.id === company.id);
  if (seller) facts.push({ label: 'Hardware seller quote', value: `${seller.unitPriceUsd} USD/unit` }, { label: 'Current physical capacity', value: `${seller.sellableUnits} accelerators; subject to existing priority contracts` });
  const addJson = (label: string, value: unknown): void => { chunks(JSON.stringify(value)).forEach((part, index) => facts.push({ label: `${label} ${index + 1}`, value: part })); };
  state.deals.filter((deal) => deal.proposerId === company.id || deal.counterpartyId === company.id).slice(-6).forEach((deal) => addJson(`Deal ${deal.id}`, deal));
  canonical.queuedActions.filter((action) => action.actorCompanyId === company.id).slice(-4).forEach((action) => addJson(`Queued ${action.actionId}`, action.intent));
  state.boardProposals.filter((proposal) => proposal.companyId === company.id && (proposal.status === 'draft' || proposal.status === 'tabled')).slice(-4).forEach((proposal) => addJson(`Pending board ${proposal.id}`, proposal));
  return { context: { character: ceo, relationship: null, counterpartRelationship: null, memories, topic: message.slice(0, 200), gameFacts: facts,
    conversationHistory: [...(thread?.turns.slice(-10).map((turn) => ({ speakerId: turn.speakerId, text: turn.text })) ?? []), { speakerId: player.characterId, text: message }],
    accessBasis: 'Private canonical company negotiation. Internal facts inform decisions but are not automatic disclosures.', pendingProposalSummary: state.deals.find((deal) => deal.status === 'proposed' && (deal.proposerId === company.id || deal.counterpartyId === company.id))?.summary ?? null },
    playerCompanyId: playerCompany.id, playerCharacterId: player.characterId };
}
