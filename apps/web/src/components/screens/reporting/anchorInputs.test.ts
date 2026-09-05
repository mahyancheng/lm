/**
 * How the valuation anchor's working is written down.
 *
 * `ValuationAnchor.inputs` is an open bag of numbers, and the fundamentals
 * method added three that the old rendering rule got wrong: it treated anything
 * under a thousand as a fraction, so a 28× sector revenue multiple printed as
 * "2,800%" and a 0.64 quality score printed as "64%" — which is a percentage of
 * nothing. Units are declared per key now, and this pins that.
 *
 * It also pins the two properties a "show the working" panel needs: every input
 * the engine wrote is shown, and the declared ones come first in a fixed order
 * so the panel does not reshuffle between quarters.
 */

import { describe, expect, it } from 'vitest';
import type { NewGameSetupInput, ValuationAnchor } from '@frontier/contracts';
import { CURRENT_WORLD_VERSION } from '@frontier/contracts';
import { createDemoSession } from '@frontier/simulation';
import { anchorInputRows } from './util';

const MULTI_SECTOR_SETUP: NewGameSetupInput = {
  companyName: 'Player Ventures',
  founderName: 'Avery Sinclair',
  backgroundId: 'frontier_lab',
  worldVersion: CURRENT_WORLD_VERSION,
};

function anchorWith(inputs: Record<string, number>): ValuationAnchor {
  return {
    companyId: 'cmp_test',
    quarter: 0,
    method: 'revenue_multiple',
    inputs,
    anchorValueUsd: 1_000_000_000,
    perShareValueUsd: 50,
    confidence: 0.5,
  };
}

describe('anchor inputs are rendered in their own units', () => {
  it('writes a revenue multiple as a whole multiple, not as a percentage', () => {
    const rows = anchorInputRows(anchorWith({ sectorRevenueMultiple: 27.8 }));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.label).toBe('Sector revenue multiple');
    expect(rows[0]?.value).toBe('28x');
  });

  it('writes a quality score as a score out of a hundred', () => {
    expect(anchorInputRows(anchorWith({ qualityScore: 0.64 }))[0]?.value).toBe('64');
  });

  it('writes money as money however small the figure is', () => {
    const rows = anchorInputRows(anchorWith({ cash: 250, debt: 0 }));
    expect(rows.map((row) => row.label)).toEqual(['Cash', 'Debt']);
    for (const row of rows) expect(row.value).not.toContain('%');
  });

  it('writes a margin as a whole percentage', () => {
    expect(anchorInputRows(anchorWith({ grossMargin: 0.66 }))[0]?.value).toBe('66%');
  });

  it('keeps the declared order and puts anything new after it, sorted', () => {
    const rows = anchorInputRows(
      anchorWith({ zeta: 1, qualityScore: 0.5, alpha: 2, forwardRevenue: 100, grossMargin: 0.4 }),
    );
    expect(rows.map((row) => row.key)).toEqual(['forwardRevenue', 'grossMargin', 'qualityScore', 'alpha', 'zeta']);
  });

  it('shows every input the engine wrote and invents none', () => {
    const state = createDemoSession(undefined, MULTI_SECTOR_SETUP);
    for (const anchor of state.valuationAnchors) {
      const rows = anchorInputRows(anchor);
      expect(rows.map((row) => row.key).sort()).toEqual(Object.keys(anchor.inputs).sort());
      for (const row of rows) expect(row.value.length, `${anchor.companyId}/${row.key}`).toBeGreaterThan(0);
    }
  });

  it('names the fundamentals inputs the multi-sector anchor actually carries', () => {
    const state = createDemoSession(undefined, MULTI_SECTOR_SETUP);
    const listed = state.valuationAnchors.find((anchor) => anchor.inputs['sectorRevenueMultiple'] !== undefined);
    expect(listed, 'no anchor uses the fundamentals method').toBeDefined();
    if (listed === undefined) return;
    const labels = anchorInputRows(listed).map((row) => row.label);
    expect(labels).toContain('Fundamental value');
    expect(labels).toContain('Sector revenue multiple');
    expect(labels).toContain('Quality score');
    // No raw camelCase key ever reaches the screen.
    for (const label of labels) expect(label).not.toMatch(/[a-z][A-Z]/);
  });
});
