import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSaveFile, inspectSaveValue } from '@/lib/game/saveFile';
import type { DealProposal } from '@frontier/contracts';
import { createSession, PLAYER_ID } from '@/lib/game/engine';
import { registerGame, resolveCanonicalQuarter, submitCompanyCommand } from './sessionAuthority';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
function root(): string { const value = mkdtempSync(join(tmpdir(), 'frontier-authority-')); roots.push(value); return value; }
function fixture() { const setup = { companyName: 'Authority Labs', founderName: 'Avery', backgroundId: 'consumer_ai' as const, sector: 'ai' as const, region: 'north_america' as const, worldVersion: 3 as const }; const session = createSession({ seed: 8123, setup }); const file = buildSaveFile({ seed: 8123, difficulty: 'standard', autoExecuteRoutine: false, setup, log: [], queue: [], session }); return { session, file }; }
function npc(session: ReturnType<typeof createSession>) { return session.companies.find((company) => company.controllerPlayerId === null && company.isActive)!; }
function playerAction(session: ReturnType<typeof createSession>, id = 'player_action') { const companyId = session.players[0]!.companyId; const characterId = session.characters.find((character) => character.companyId === companyId && character.role === 'founder_ceo')!.id; return { actionId: id, sessionId: session.sessionId, quarter: session.quarter, sequence: 0, actorPlayerId: PLAYER_ID, actorCompanyId: companyId, actorCharacterId: characterId, origin: 'player_ui' as const, confirmedByHuman: true, intent: { type: 'set_research_budget' as const, budgetUsd: 1 } }; }

describe('Pi canonical session authority', () => {
  it('registers two same-seed runs independently when their run identities differ', () => {
    const r = root();
    const setup = { companyName: 'Authority Labs', founderName: 'Avery', backgroundId: 'consumer_ai' as const, sector: 'ai' as const, region: 'north_america' as const, worldVersion: 3 as const };
    const sessions = ['game_first', 'game_second'].map((sessionId) => createSession({ seed: 8123, setup, sessionId }));
    expect(sessions.map((session) => session.sessionId)).toEqual(['game_first', 'game_second']);
    const files = sessions.map((session) => buildSaveFile({ seed: 8123, difficulty: 'standard', autoExecuteRoutine: false, setup, log: [], queue: [], session }));
    expect(registerGame(files[0]!, 'owner_a', r).reason).toBe(null);
    expect(registerGame(files[1]!, 'owner_a', r).reason).toBe(null);
  });

  it('binds registration to owner and reloads a durable record', () => { const r = root(); const { session, file } = fixture(); expect(inspectSaveValue(file).status).toBe('ok'); expect(session.sessionId).toMatch(/^[A-Za-z0-9:_-]{1,200}$/); expect(registerGame(file, 'owner_a', r).reason).toBe(null); expect(registerGame(file, 'owner_a', r).reason).toBe('already_registered'); expect(registerGame(file, 'owner_b', r).reason).toBe('forbidden'); expect(session.sessionId).toBeTruthy(); });
  it('fails closed on a corrupt canonical record', () => { const r = root(); const { session, file } = fixture(); expect(registerGame(file, 'owner_a', r).ok).toBe(true); writeFileSync(join(r, `${session.sessionId}.json`), '{bad'); expect(registerGame(file, 'owner_a', r).reason).toBe('corrupt_server_record'); });
  it('queues an NPC party’s cancellable owned-hardware contract and rejects a foreign deal', async () => {
    const r = root(); const { session, file } = fixture(); const seller = npc(session); const buyerId = session.players[0]!.companyId;
    const deal: DealProposal = { id: 'deal_cancel_by_supplier', proposerId: seller.id, proposerKind: 'company', counterpartyId: buyerId, counterpartyKind: 'company', gives: [{ kind: 'owned_accelerator_supply', supplierCompanyId: seller.id, buyerCompanyId: buyerId, quantityPerQuarter: 10, durationQuarters: 3, hardwarePriceReference: 'seller_quote', premiumPct: 5, maxUnitPriceUsd: 1_000_000, priority: 10, nonExclusive: true, cancellable: true, contractEndQuarter: session.quarter + 3 }], gets: [], confidentiality: 'private', expiresQuarter: session.quarter + 1, binding: true, intentStatements: [], summary: 'Cancellable future owned accelerator supply.', status: 'accepted', createdQuarter: session.quarter, respondedQuarter: session.quarter, conversationId: null, breachedByPartyId: null };
    session.deals.push(deal); session.conversationThreads = [];
    const persisted = buildSaveFile({ seed: 8123, difficulty: 'standard', autoExecuteRoutine: false, setup: file.setup, log: [], queue: [], session });
    const reg = registerGame(persisted, 'owner_a', r);
    const accepted = await submitCompanyCommand({ sessionId: session.sessionId, ownerId: 'owner_a', expectedRevision: reg.revision!, conversationId: seller.id, commandId: 'cancel_own', command: { type: 'cancel_deal', dealId: deal.id, reason: 'Capacity is reassigned.' } }, r);
    expect(accepted.status).toBe('queued'); expect(accepted.queuedAction?.intent).toEqual({ type: 'cancel_deal', dealId: deal.id, reason: 'Capacity is reassigned.' });
    const foreign = await submitCompanyCommand({ sessionId: session.sessionId, ownerId: 'owner_a', expectedRevision: accepted.revision!, conversationId: seller.id, commandId: 'cancel_foreign', command: { type: 'cancel_deal', dealId: 'not_a_company_deal', reason: 'No authority.' } }, r);
    expect(foreign.status).toBe('rejected');
  });
  it('records same command once and refuses a changed replay', async () => { const r = root(); const { session, file } = fixture(); const company = npc(session); const reg = registerGame(file, 'owner_a', r); const input = { sessionId: session.sessionId, ownerId: 'owner_a', expectedRevision: reg.revision!, conversationId: company.id, commandId: 'offer_1', command: { type: 'submit_board_proposal', kind: 'annual_plan', title: 'Plan', summary: 'Approve the annual operating plan.', amountUsd: null, targetCompanyId: null, stockComponentPct: null } }; const one = await submitCompanyCommand(input, r); expect(one.status).toBe('queued'); const duplicate = await submitCompanyCommand(input, r); expect(duplicate.status).toBe('duplicate'); expect(duplicate.queuedAction?.actionId).toBe(one.queuedAction?.actionId); const changed = await submitCompanyCommand({ ...input, command: { ...input.command, title: 'Different plan' } }, r); expect(changed.status).toBe('forbidden'); });
  it('rejects forged player identity and resolves an exact duplicate only once', async () => { const r = root(); const { session, file } = fixture(); const reg = registerGame(file, 'owner_a', r); const forged = { ...playerAction(session), actorPlayerId: 'forged' }; expect((await resolveCanonicalQuarter({ sessionId: session.sessionId, ownerId: 'owner_a', expectedRevision: reg.revision!, requestId: 'q1', playerActions: [forged] }, null, r)).status).toBe('forbidden'); const action = playerAction(session); const first = await resolveCanonicalQuarter({ sessionId: session.sessionId, ownerId: 'owner_a', expectedRevision: reg.revision!, requestId: 'q2', playerActions: [action, action] }, null, r); expect(first.status).toBe('resolved'); const again = await resolveCanonicalQuarter({ sessionId: session.sessionId, ownerId: 'owner_a', expectedRevision: reg.revision!, requestId: 'q2', playerActions: [action] }, null, r); expect(again.status).toBe('duplicate'); expect(again.file!.log).toHaveLength(1); });
  it('serializes concurrent resolves and preserves a planned NPC bundle for replay', async () => { const r = root(); const { session, file } = fixture(); const reg = registerGame(file, 'owner_a', r); const rival = npc(session); const planner = { planWorld: async () => null, reviewResearch: async () => null, planNpc: async (_state: typeof session, id: string) => id === rival.id ? { requestedCompanyId: id, bundle: { companyId: id, posture: rival.posture, rationale: 'test', strategySummary: 'test', actions: [] } } : null }; const input = { sessionId: session.sessionId, ownerId: 'owner_a', expectedRevision: reg.revision!, requestId: 'q3', playerActions: [playerAction(session)] }; const [a, b] = await Promise.all([resolveCanonicalQuarter(input, planner, r), resolveCanonicalQuarter(input, planner, r)]); expect([a.status, b.status].sort()).toEqual(['duplicate', 'resolved']); const saved = (a.file ?? b.file)!; expect(saved.log[0]!.npcBundles).toHaveLength(1); });
});
