import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ proposal: vi.fn(), submit: vi.fn(), record: vi.fn() }));
vi.mock('../../_gateway', () => ({
  admit: async () => ({ ok: true, admission: { principal: { id: 'owner' }, finish: (response: Response) => response } }),
  parseBody: async (request: Request, schema: any) => ({ ok: true, value: schema.parse(await request.json()) }),
}));
vi.mock('@/lib/game/server/sessionAuthority', () => ({
  canonicalCompanyDialogueProposal: (...args: any[]) => mocks.proposal(...args),
  submitCompanyCommand: (...args: any[]) => mocks.submit(...args),
  recordCompanyDialogueProposalReceipt: (...args: any[]) => mocks.record(...args),
}));
const { POST } = await import('./route');
const command = { type: 'accept_deal', dealId: 'deal_server' } as const;
function request(extra: Record<string, unknown> = {}) { return new Request('http://local/api', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: 'session_123', companyId: 'company_123', turnId: 'turn_12345', proposalIndex: 1, ...extra }) }); }

beforeEach(() => {
  mocks.proposal.mockReset().mockReturnValue({ status: 'ready', revision: 7, command });
  mocks.submit.mockReset().mockResolvedValue({ status: 'queued', revision: 8, queuedAction: { intent: command }, validation: null });
  mocks.record.mockReset().mockResolvedValue(9);
});

describe('company dialogue proposal queue', () => {
  it('queues only the server-persisted command and links its exact proposal index', async () => {
    const response = await POST(request({ command: { type: 'reject_deal', dealId: 'tampered', reason: 'changed' } }));
    const body = await response.json();
    expect(mocks.submit.mock.calls[0]![0]).toMatchObject({ expectedRevision: 7, command, commandId: 'dialogue_turn_12345_1' });
    expect(body.receipt).toMatchObject({ proposalIndex: 1, status: 'queued', intent: command });
    expect(mocks.record.mock.calls[0]![0]).toMatchObject({ turnId: 'turn_12345', proposalIndex: 1 });
    expect(body.revision).toBe(9);
  });

  it('rejects stale drafts before submission', async () => {
    mocks.proposal.mockReturnValue({ status: 'stale' });
    const response = await POST(request());
    expect(response.status).toBe(409);
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it('returns an idempotent duplicate without rewriting its stored receipt', async () => {
    mocks.submit.mockResolvedValue({ status: 'duplicate', revision: 11, queuedAction: { intent: command }, validation: null });
    const body = await (await POST(request())).json();
    expect(body.receipt.status).toBe('duplicate');
    expect(body.revision).toBe(11);
    expect(mocks.record).not.toHaveBeenCalled();
  });
});
