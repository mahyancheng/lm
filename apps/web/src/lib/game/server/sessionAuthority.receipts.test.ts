import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path';
import { buildSaveFile } from '@/lib/game/saveFile'; import { createSession } from '@/lib/game/engine';
import { canonicalSessionFile, registerGame, resolveCanonicalQuarter, submitCompanyCommand } from './sessionAuthority';
const roots: string[] = []; afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
function fixture() { const setup = { companyName: 'Authority Labs', founderName: 'Avery', backgroundId: 'consumer_ai' as const, sector: 'ai' as const, region: 'north_america' as const, worldVersion: 3 as const }; const session = createSession({ seed: 8123, setup }); return { session, file: buildSaveFile({ seed: 8123, difficulty: 'standard', autoExecuteRoutine: false, setup, log: [], queue: [], session }) }; }
describe('canonical authority receipt retention', () => { it('keeps a resolve tombstone across a later company command and never advances twice', async () => {
  const root = mkdtempSync(join(tmpdir(), 'frontier-receipts-')); roots.push(root); const { session, file } = fixture(); const registration = registerGame(file, 'owner', root);
  const resolved = await resolveCanonicalQuarter({ sessionId: session.sessionId, ownerId: 'owner', expectedRevision: registration.revision!, requestId: 'original', playerActions: [] }, null, root); expect(resolved.status).toBe('resolved');
  const npc = resolved.file!.checkpoint!.state.companies.find((company) => company.controllerPlayerId === null && company.isActive)!;
  await submitCompanyCommand({ sessionId: session.sessionId, ownerId: 'owner', expectedRevision: resolved.revision!, conversationId: npc.id, commandId: 'after_resolve', command: { type: 'submit_board_proposal', kind: 'annual_plan', title: 'Plan', summary: 'Keep operating.', amountUsd: null, targetCompanyId: null, stockComponentPct: null } }, root);
  const retry = await resolveCanonicalQuarter({ sessionId: session.sessionId, ownerId: 'owner', expectedRevision: registration.revision!, requestId: 'original', playerActions: [] }, null, root); expect(retry.status).toBe('duplicate'); expect(canonicalSessionFile(session.sessionId, 'owner', root)!.file.checkpoint!.state.quarter).toBe(1);
}); });
