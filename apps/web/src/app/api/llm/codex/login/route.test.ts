import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  quick: vi.fn(), admit: vi.fn(), gate: vi.fn(), start: vi.fn(), cancel: vi.fn(), status: vi.fn(), logout: vi.fn(), invalidate: vi.fn(),
}));
vi.mock('../../_gateway', () => ({ admitQuick: mocks.quick, admit: mocks.admit, invalidateGatewayForManagedCodexAuth: mocks.invalidate }));
vi.mock('../../token/_shared', () => ({ guardWriteRequest: () => null, gateTokenWrite: mocks.gate, mayReadDescriptor: async () => true, json: (body: unknown, status = 200) => Response.json(body, { status }) }));
vi.mock('../../_codexLogin', () => ({ startLoginFor: mocks.start, cancelLoginFor: mocks.cancel, loginStatusFor: mocks.status, logoutCodex: mocks.logout }));
const { GET, POST, DELETE } = await import('./route');

const principal = { id: 'operator-a', kind: 'anonymous' as const };
const admission = { ok: true as const, admission: { principal, mintedPrincipal: false, finish: (response: Response) => response } };
const headers = { host: 'localhost', origin: 'http://localhost', 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' };

beforeEach(() => {
  mocks.quick.mockReset().mockResolvedValue(admission);
  mocks.admit.mockReset().mockResolvedValue(admission);
  mocks.gate.mockReset().mockResolvedValue(null);
  mocks.start.mockReset().mockResolvedValue({ ok: true, loginId: 'login_1', userCode: 'ABCDE', verificationUrl: 'https://auth.openai.com/device', expiresAt: '2026-01-01T00:00:00.000Z' });
  mocks.cancel.mockReset().mockResolvedValue({ ok: true });
  mocks.status.mockReset().mockReturnValue({ state: 'pending' });
  mocks.logout.mockReset().mockResolvedValue({ state: 'signedOut' });
  mocks.invalidate.mockReset();
});

describe('managed Codex login routes', () => {
  it('uses the separate quick admission bucket for read-only polling', async () => {
    const response = await GET(new Request('http://localhost/api/llm/codex/login?loginId=login_1'));
    expect(response.status).toBe(200);
    expect(mocks.quick).toHaveBeenCalledOnce();
    expect(mocks.admit).not.toHaveBeenCalled();
    expect(mocks.status).toHaveBeenCalledWith(principal, 'login_1');
  });

  it('starts only through the protected POST path', async () => {
    const response = await POST(new Request('http://localhost/api/llm/codex/login', { method: 'POST', headers, body: '{}' }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, loginId: 'login_1' });
    expect(mocks.gate).toHaveBeenCalledWith(expect.any(Request), { principal, mintedPrincipal: false });
    expect(mocks.start).toHaveBeenCalledWith(principal);
  });

  it('does not invalidate inference when cancellation was not authorized for the login', async () => {
    mocks.cancel.mockResolvedValue({ ok: false, reason: 'forbidden' });
    const response = await DELETE(new Request('http://localhost/api/llm/codex/login', { method: 'DELETE', headers, body: JSON.stringify({ loginId: 'someone_else' }) }));
    expect(response.status).toBe(403);
    expect(mocks.invalidate).not.toHaveBeenCalled();
  });
});
