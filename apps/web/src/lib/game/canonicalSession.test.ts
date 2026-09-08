import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSession } from './engine';
import { buildSaveFile, type SaveFile } from './saveFile';
import { bindCanonicalGameSession, canonicalSessionRevision, noteCanonicalSessionRevision } from './canonicalSession';

function file(): SaveFile {
  const session = { ...createSession({ seed: 424242 }), conversationThreads: [] };
  return buildSaveFile({ seed: 424242, difficulty: 'standard', autoExecuteRoutine: false, setup: null, log: [], queue: [], session });
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

afterEach(() => vi.unstubAllGlobals());

describe('canonical session binding', () => {
  it('hydrates the remote save, including receipt-backed conversation state', async () => {
    const local = file();
    const copied = structuredClone(local);
    const state = copied.checkpoint!.state;
    const remote: SaveFile = { ...copied, checkpoint: { ...copied.checkpoint!, state: { ...state, conversationThreads: [{ id: 'npc:remote', sessionId: state.sessionId, playerCompanyId: state.players[0]!.companyId, playerCharacterId: state.players[0]!.characterId, targetCharacterId: state.characters[1]!.id, targetCompanyId: state.characters[1]!.companyId, nextTurnSequence: 2, lastMessageQuarter: state.quarter, turns: [{ speakerId: state.players[0]!.characterId, text: 'Terms?', quarter: state.quarter }, { speakerId: state.characters[1]!.id, text: 'Queued.', quarter: state.quarter, receipts: [{ status: 'queued', revision: 9, intent: { type: 'accept_deal', dealId: 'deal_remote' }, reason: null }] }] }] } } };
    vi.stubGlobal('fetch', vi.fn(async () => json({ ok: true, revision: 10, file: remote })));
    const binding = await bindCanonicalGameSession(local);
    expect(binding).toMatchObject({ kind: 'bound', revision: 10, file: remote });
    expect(canonicalSessionRevision(local.checkpoint!.state.sessionId)).toBe(10);
  });

  it('permits local resolution only after explicit authority_disabled registration', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(json({ ok: false }, 404))
      .mockResolvedValueOnce(json({ ok: false, reason: 'authority_disabled' }, 404)));
    await expect(bindCanonicalGameSession(file())).resolves.toEqual({ kind: 'disabled' });
  });

  it('re-reads the server after a concurrent registration instead of binding the stale local file', async () => {
    const local = file();
    const remote: SaveFile = { ...structuredClone(local), savedQuarter: 99 };
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(json({ ok: false }, 404))
      .mockResolvedValueOnce(json({ ok: false, reason: 'already_registered', sessionId: local.checkpoint!.state.sessionId, revision: 3 }, 409))
      .mockResolvedValueOnce(json({ ok: true, revision: 4, file: remote })));
    await expect(bindCanonicalGameSession(local)).resolves.toMatchObject({ kind: 'bound', revision: 4, file: remote });
  });

  it('blocks network and foreign-session registration failures', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    await expect(bindCanonicalGameSession(file())).resolves.toEqual({ kind: 'blocked' });
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(json({ ok: false }, 404))
      .mockResolvedValueOnce(json({ ok: false, reason: 'forbidden', sessionId: 'someone_else', revision: 3 }, 409)));
    await expect(bindCanonicalGameSession(file())).resolves.toEqual({ kind: 'blocked' });
  });

  it('never regresses a cached canonical revision', () => {
    const id = 'revision_monotonic_test';
    noteCanonicalSessionRevision(id, 12);
    noteCanonicalSessionRevision(id, 4);
    expect(canonicalSessionRevision(id)).toBe(12);
  });
});

describe('long-running canonical quarter observation', () => {
  it('recovers a lost start response by polling the existing job without starting it again', async () => {
    vi.useFakeTimers();
    try {
      const { resolveCanonicalGameQuarter } = await import('./canonicalSession');
      const id = 'poll_lost_response'; noteCanonicalSessionRevision(id, 1);
      const fetcher = vi.fn().mockRejectedValueOnce(new Error('lost connection'))
        .mockResolvedValueOnce(json({ status: 'pending', progress: 'Planning rival companies: 2 of 24' }, 202))
        .mockResolvedValueOnce(json({ status: 'resolved', revision: 2, file: null, outcome: null }));
      vi.stubGlobal('fetch', fetcher);
      const progress = vi.fn();
      const result = resolveCanonicalGameQuarter(id, 'q0', [], progress);
      await vi.advanceTimersByTimeAsync(4001);
      await expect(result).resolves.toMatchObject({ status: 'resolved', revision: 2 });
      expect(fetcher.mock.calls.filter((call) => call[1]?.method === 'POST')).toHaveLength(1);
      expect(progress).toHaveBeenCalledWith('Planning rival companies: 2 of 24');
    } finally { vi.useRealTimers(); }
  });
  it('resubmits the exact request after a restart so durable receipts prevent a double commit', async () => {
    vi.useFakeTimers();
    try {
      const { resolveCanonicalGameQuarter } = await import('./canonicalSession');
      const id = 'poll_restart'; noteCanonicalSessionRevision(id, 3);
      const fetcher = vi.fn().mockResolvedValueOnce(json({ status: 'pending' }, 202))
        .mockResolvedValueOnce(json({ status: 'missing' }, 404))
        .mockResolvedValueOnce(json({ status: 'duplicate', revision: 4, file: null, outcome: null }));
      vi.stubGlobal('fetch', fetcher);
      const result = resolveCanonicalGameQuarter(id, 'q0', []);
      await vi.advanceTimersByTimeAsync(4001);
      await expect(result).resolves.toMatchObject({ status: 'duplicate', revision: 4 });
      expect(fetcher.mock.calls[2]?.[1]?.body).toBe(fetcher.mock.calls[0]?.[1]?.body);
    } finally { vi.useRealTimers(); }
  });
});
