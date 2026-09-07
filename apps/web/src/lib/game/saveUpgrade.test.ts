import { describe, expect, it } from 'vitest';
import { createSession, getEngine } from './engine';
import { buildSaveFile } from './saveFile';
import { replay } from './persistence';
import { upgradeSaveFileAtLoad } from './saveUpgrade';
import { sellersFor } from '@frontier/simulation';
import { holdsNode } from '@frontier/contracts';

function oldWorld3File() {
  const setup = { companyName: 'Upgrade Labs', founderName: 'Avery', backgroundId: 'consumer_ai' as const, sector: 'ai' as const, region: 'north_america' as const, worldVersion: 3 as const };
  const session = createSession({ seed: 9911, setup });
  const tessellate = session.companies.find((company) => company.id === 'cmp_tessellate')!;
  const old = { ...session, companies: session.companies.map((company) => company.id === tessellate.id ? { ...company, products: company.products.filter((product) => product.nodeId !== 'sys_ai_accelerator'), ownedNodes: (company.ownedNodes ?? []).filter((node) => node !== 'sys_ai_accelerator') } : company) };
  const file = buildSaveFile({ seed: 9911, difficulty: 'standard', autoExecuteRoutine: false, setup, log: [], queue: [], session: old });
  return { file: { ...file, checkpoint: { quarter: old.quarter, state: old }, scenarioMigrations: [] }, old, tessellate };
}

describe('World 3 Tessellate save upgrade', () => {
  it('adds only the missing seeded supplier line and preserves player state', () => {
    const { file, old } = oldWorld3File();
    const upgraded = upgradeSaveFileAtLoad(file);
    const beforePlayer = old.companies.find((company) => company.id === old.players[0]!.companyId)!;
    const after = upgraded.file.checkpoint!.state;
    const afterPlayer = after.companies.find((company) => company.id === beforePlayer.id)!;
    const tessellate = after.companies.find((company) => company.id === 'cmp_tessellate')!;
    expect(upgraded.changed).toBe(true);
    expect(tessellate.products.map((product) => product.nodeId)).toContain('sys_ai_accelerator');
    expect(holdsNode(tessellate, 'sys_ai_accelerator', after.quarter)).toBe(true);
    expect(afterPlayer.balanceSheet.assets.cash).toBe(beforePlayer.balanceSheet.assets.cash);
    expect(after.players).toEqual(old.players);
    expect(after.companies.find((company) => company.id === tessellate.id)!.capacity).toEqual(old.companies.find((company) => company.id === tessellate.id)!.capacity);
    expect(upgraded.file.log).toBe(file.log);
    expect(upgraded.file.migrationEvents).toHaveLength(1);
    expect(upgraded.file.migrationEvents![0]).toMatchObject({ type: 'migration_applied', quarter: old.quarter, actorId: 'cmp_tessellate', targetId: 'sys_ai_accelerator', payload: expect.objectContaining({ financialAssetsAddedUsd: 0, capacityAdded: false }) });
    expect(sellersFor(after, 'accelerators', beforePlayer.id).some((seller) => seller.company.id === 'cmp_tessellate')).toBe(true);
  });

  it('replays recorded quarters from the original checkpoint before repairing the present', () => {
    const { file, old } = oldWorld3File();
    const historical = getEngine().resolver.resolveQuarter(old, [], null, []);
    expect(historical.committed).toBe(true);
    const replayedFile = { ...file, log: [{ quarter: old.quarter, actions: [], gmProposal: null, npcBundles: [], socialTexts: [] }] };
    const loaded = replay(replayedFile);
    const expectedPlayer = historical.nextState.companies.find((company) => company.id === old.players[0]!.companyId)!;
    const actualPlayer = loaded.session.companies.find((company) => company.id === expectedPlayer.id)!;
    expect(actualPlayer.balanceSheet.assets.cash).toBe(expectedPlayer.balanceSheet.assets.cash);
    expect(loaded.session.quarter).toBe(historical.nextState.quarter);
    expect(loaded.session.companies.find((company) => company.id === 'cmp_tessellate')!.products.some((product) => product.nodeId === 'sys_ai_accelerator')).toBe(true);
    expect(loaded.migrationEvents).toHaveLength(1);
    expect(loaded.migrationEvents[0]!.quarter).toBe(loaded.session.quarter);
  });

  it('is idempotent and respects an inactive or explicit Tessellate line', () => {
    const { file } = oldWorld3File();
    const once = upgradeSaveFileAtLoad(file);
    expect(upgradeSaveFileAtLoad(once.file)).toEqual({ file: once.file, changed: false });
    const inactive = { ...file, checkpoint: { ...file.checkpoint!, state: { ...file.checkpoint!.state, companies: file.checkpoint!.state.companies.map((company) => company.id === 'cmp_tessellate' ? { ...company, isActive: false } : company) } } };
    const protectedFile = upgradeSaveFileAtLoad(inactive);
    expect(protectedFile.changed).toBe(true);
    expect(protectedFile.file.checkpoint!.state.companies.find((company) => company.id === 'cmp_tessellate')!.products).toHaveLength(2);
  });
});
