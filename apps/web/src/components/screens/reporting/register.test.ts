/**
 * The company register, in both worlds.
 *
 * The register is how twenty-five companies become legible, and it is also the
 * one derivation on the reporting screens that could quietly leak a private
 * figure, so this file pins both halves:
 *
 * 1. **Coverage.** Every company in the projection gets exactly one row, the
 *    player's first, and the roll-up accounts for all of them. A world-version-1
 *    session produces a single sector and a world-version-2 session produces
 *    six, which is what every "should this control appear?" branch reads.
 * 2. **The boundary.** A private rival has no value, no revenue, no margin and
 *    no multiple — the fields are absent rather than estimated — and the sector
 *    roll-up never sums a capitalisation it is not allowed to know.
 *
 * Everything is checked against real sessions from `@frontier/simulation` rather
 * than hand-built fixtures, so a change to the redaction shows up here.
 */

import { describe, expect, it } from 'vitest';
import type { NewGameSetupInput, SessionState } from '@frontier/contracts';
import { CURRENT_WORLD_VERSION, SECTORS } from '@frontier/contracts';
import { createDefaultEngine, createDemoSession } from '@frontier/simulation';
import { projectPlayerView } from '@/lib/game/playerView';
import { registerRows, sectorCounts, sectorRollups } from './register';

const MULTI_SECTOR_SETUP: NewGameSetupInput = {
  companyName: 'Player Ventures',
  founderName: 'Avery Sinclair',
  backgroundId: 'frontier_lab',
  worldVersion: CURRENT_WORLD_VERSION,
};

function world1(): SessionState {
  return createDemoSession();
}

function world2(): SessionState {
  return createDemoSession(undefined, MULTI_SECTOR_SETUP);
}

function resolved(state: SessionState, quarters: number): SessionState {
  const engine = createDefaultEngine();
  let next = state;
  for (let index = 0; index < quarters; index += 1) {
    const outcome = engine.resolver.resolveQuarter(next, [], null, []);
    expect(outcome.committed).toBe(true);
    next = outcome.nextState;
  }
  return next;
}

function rowsOf(state: SessionState) {
  return registerRows(state, projectPlayerView(state));
}

describe('the register covers the whole world', () => {
  it('gives every active company exactly one row, the player first', () => {
    const state = world2();
    const rows = rowsOf(state);
    const active = state.companies.filter((company) => company.isActive);
    expect(rows).toHaveLength(active.length);
    expect(new Set(rows.map((row) => row.companyId)).size).toBe(rows.length);
    expect(rows[0]?.isOwn).toBe(true);
    expect(rows.filter((row) => row.isOwn)).toHaveLength(1);
  });

  it('spans six sectors in world 2 and one in world 1', () => {
    expect(new Set(rowsOf(world2()).map((row) => row.sector)).size).toBe(SECTORS.length);
    expect(new Set(rowsOf(world1()).map((row) => row.sector)).size).toBe(1);
  });

  it('counts every row into exactly one sector', () => {
    const rows = rowsOf(world2());
    const counts = sectorCounts(rows);
    const total = Object.values(counts).reduce((sum, value) => sum + value, 0);
    expect(total).toBe(rows.length);
  });

  it('is stable across two builds of one quarter', () => {
    const state = world2();
    expect(rowsOf(state)).toEqual(rowsOf(state));
  });

  it('keeps its order when a quarter resolves', () => {
    const state = world2();
    const before = rowsOf(state).map((row) => row.companyId);
    const after = rowsOf(resolved(state, 2)).map((row) => row.companyId);
    expect(after).toEqual(before);
  });
});

describe('the register respects the information boundary', () => {
  it('discloses nothing financial about a privately held rival', () => {
    const rows = rowsOf(world2());
    const privateRivals = rows.filter((row) => !row.isOwn && !row.isPublic);
    expect(privateRivals.length).toBeGreaterThan(0);
    for (const row of privateRivals) {
      expect(row.valueUsd, row.companyId).toBeNull();
      expect(row.valueBasis, row.companyId).toBe('none');
      expect(row.revenueTtmUsd, row.companyId).toBeNull();
      expect(row.grossMarginPct, row.companyId).toBeNull();
      expect(row.revenueGrowthYoY, row.companyId).toBeNull();
      expect(row.revenueMultiple, row.companyId).toBeNull();
      // Identity, sector and region are on the public register and stay.
      expect(row.name.length).toBeGreaterThan(0);
      expect(SECTORS).toContain(row.sector);
    }
  });

  it('shows a listed rival what it actually files', () => {
    const rows = rowsOf(world2());
    const listed = rows.filter((row) => !row.isOwn && row.isPublic);
    expect(listed.length).toBeGreaterThan(0);
    for (const row of listed) {
      expect(row.valueBasis, row.companyId).toBe('quote');
      expect(row.valueUsd ?? 0, row.companyId).toBeGreaterThan(0);
      expect(row.revenueTtmUsd ?? -1, row.companyId).toBeGreaterThanOrEqual(0);
      expect(row.revenueMultiple ?? 0, row.companyId).toBeGreaterThan(0);
    }
  });

  it('marks the player at their own anchor while they are unlisted', () => {
    const rows = rowsOf(world2());
    const own = rows.find((row) => row.isOwn);
    expect(own?.isPublic).toBe(false);
    expect(own?.valueBasis).toBe('anchor');
    expect(own?.valueUsd ?? 0).toBeGreaterThan(0);
  });
});

describe('the sector roll-up', () => {
  it('aggregates only the figures that are public', () => {
    const rows = rowsOf(world2());
    const rollups = sectorRollups(rows);
    expect(rollups.length).toBe(SECTORS.length);

    for (const rollup of rollups) {
      const here = rows.filter((row) => row.sector === rollup.sector);
      expect(rollup.companies).toBe(here.length);
      expect(rollup.listed).toBe(here.filter((row) => row.isPublic).length);

      // Only quoted capitalisations. The player's own anchor is a figure the
      // market has not seen, so it stays out of the sector total.
      const quoted = here
        .filter((row) => row.valueBasis === 'quote')
        .reduce((total, row) => total + (row.valueUsd ?? 0), 0);
      expect(rollup.marketCapUsd).toBe(quoted);
      expect(rollup.revenueTtmUsd).toBe(here.reduce((total, row) => total + (row.revenueTtmUsd ?? 0), 0));
    }
  });

  it('leaves the multiple and the margin null rather than dividing by nothing', () => {
    const rollups = sectorRollups([
      {
        companyId: 'cmp_quiet',
        name: 'Quiet Holdings',
        ticker: null,
        sector: 'logistics',
        region: 'east_asia',
        archetype: null,
        newLabel: null,
        isPublic: false,
        isOwn: false,
        valueUsd: null,
        valueBasis: 'none',
        revenueTtmUsd: null,
        grossMarginPct: null,
        revenueGrowthYoY: null,
        sharesOutstanding: null,
        revenueMultiple: null,
      },
    ]);
    expect(rollups).toHaveLength(1);
    expect(rollups[0]?.companies).toBe(1);
    expect(rollups[0]?.marketCapUsd).toBe(0);
    expect(rollups[0]?.blendedMultiple).toBeNull();
    expect(rollups[0]?.grossMarginPct).toBeNull();
  });

  it('drops a sector nobody is in rather than showing an empty row', () => {
    const rollups = sectorRollups(rowsOf(world1()));
    expect(rollups).toHaveLength(1);
    expect(rollups[0]?.sector).toBe('ai');
  });
});
