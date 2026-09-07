import { describe, expect, it } from 'vitest';
import { createSession, PLAYER_ID } from '@/lib/game/engine';
import { sellersFor } from '@frontier/simulation';
import { buildCompanyDialogueContext } from './context';
const setup = { companyName: 'Buyer Labs', founderName: 'Avery', backgroundId: 'consumer_ai' as const, sector: 'ai' as const, region: 'north_america' as const, worldVersion: 3 as const };
describe('company dialogue commercial dossier', () => { it('supplies exact buyer id, manufacturer quote, and physical capacity', () => {
  const state = createSession({ seed: 8123, setup }); const buyerId = state.players[0]!.companyId; const seller = sellersFor(state, 'accelerators', buyerId)[0]!; expect(seller).toBeDefined();
  const built = buildCompanyDialogueContext({ state, revision: 4, queuedActions: [] }, seller.company.id, PLAYER_ID, 'Can you supply accelerators?')!;
  expect(built.context.gameFacts).toContainEqual({ label: 'Player buyer company ID', value: buyerId }); expect(built.context.gameFacts).toContainEqual({ label: 'NPC company ID', value: seller.company.id });
  expect(built.context.gameFacts).toContainEqual({ label: 'Hardware seller quote', value: `${seller.unitPriceUsd} USD/unit` }); expect(built.context.gameFacts.find((fact) => fact.label === 'Current physical capacity')?.value).toContain(String(seller.sellableUnits)); expect(built.context.gameFacts.find((fact) => fact.label === 'PRIVATE company cash')?.value).toContain('do not disclose');
}); });
