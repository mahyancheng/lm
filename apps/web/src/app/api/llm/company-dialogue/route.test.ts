import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSession, PLAYER_ID } from '@/lib/game/engine';

const mocks = vi.hoisted(() => ({ calls: [] as any[], append: vi.fn(), turn: vi.fn(), load: vi.fn() }));
vi.mock('../_gateway', () => ({
  admit: async () => ({ ok: true, admission: { principal: { id: PLAYER_ID }, conversationKey: () => 'company-session', finish: (response: Response) => response } }),
  parseBody: async (request: Request, schema: any) => ({ ok: true, value: schema.parse(await request.json()) }),
  transportAvailable: () => true,
  fallback: (reason: string) => Response.json({ output: null, fallback: true, reason }),
  gateway: () => ({ roles: { companyDialogue: { converse: async (context: any) => { mocks.calls.push(context); return { output: { text: 'I sign it.', commands: [{ type: 'submit_board_proposal', kind: 'annual_plan', title: 'Plan', summary: 'Approve plan.', amountUsd: null, targetCompanyId: null, stockComponentPct: null }], relationshipDeltas: { trust: 0, respect: 0, hostility: 0 }, newCommitment: null, memoryToStore: null }, fallbackUsed: false }; } } } }),
}));
vi.mock('@/lib/game/server/sessionAuthority', () => ({
  canonicalDialogueTurn: (...args: any[]) => mocks.turn(...args), loadCanonicalCompanyDialogue: (...args: any[]) => mocks.load(...args), appendCanonicalDialogueTurn: (...args: any[]) => mocks.append(...args),
}));
const { POST } = await import('./route');
const setup = { companyName: 'Buyer Labs', founderName: 'Avery', backgroundId: 'consumer_ai' as const, sector: 'ai' as const, region: 'north_america' as const, worldVersion: 3 as const };
function request(message = 'Make the offer') { return new Request('http://local/api', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: 'session_123', companyId: 'npc_company', turnId: 'turn_12345', message }) }); }
beforeEach(() => { mocks.calls.length = 0; mocks.turn.mockReset().mockReturnValue({ status: 'missing' }); mocks.append.mockReset().mockResolvedValue(6); const state = createSession({ seed: 8123, setup }); const npc = state.companies.find((company) => company.controllerPlayerId === null)!; Object.assign(npc, { id: 'npc_company' }); mocks.load.mockReturnValue({ state, revision: 4, queuedActions: [] }); });
describe('company dialogue proposal drafting', () => {
  it('persists a reviewable command without executing it and avoids claiming signature', async () => { const response = await POST(request()); const body = await response.json(); expect(mocks.calls).toHaveLength(1); expect(body.output.text).toContain('Nothing is queued'); expect(body.output.commands).toHaveLength(1); expect(body.receipts).toEqual([]); expect(body.turnId).toBe('turn_12345'); expect(body.revision).toBe(6); expect(mocks.append.mock.calls[0]![0].output.commands).toEqual(body.output.commands); });
  it('returns a stored turn without another model call and rejects changed text', async () => { mocks.turn.mockReturnValue({ status: 'complete', playerText: 'Make the offer', replyText: 'Terms below.', output: { text: 'Terms below.', commands: [] }, receipts: [], fallbackUsed: false, revision: 8 }); const replay = await POST(request()); expect((await replay.json()).output.text).toBe('Terms below.'); expect(mocks.calls).toHaveLength(0); mocks.turn.mockReturnValue({ status: 'conflict' }); expect((await POST(request('changed'))).status).toBe(409); });
});
