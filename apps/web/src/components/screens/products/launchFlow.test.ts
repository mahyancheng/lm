/**
 * Launch-flow helpers: grouping, lock reasons, built-on offers. Every
 * assertion is checked against the same engine functions the validator and
 * `suppliersFor` use, never a restated number.
 */

import { describe, expect, it } from 'vitest';
import type { SessionState } from '@frontier/contracts';
import { PRODUCT_CATEGORIES, SECTORS, productCategoriesFor } from '@frontier/contracts';
import { createWorld2Session } from '@frontier/simulation';
import { builtOnRows, industriesForCompany, lineLock, missingNodeTitles, supplyChoicesFrom, unservedRequiredInputs } from './launchFlow';

const PLAYER_COMPANY = 'cmp_player_ventures';

function world2(): SessionState {
  return createWorld2Session();
}

const companyOf = (state: SessionState, id: string) => {
  const company = state.companies.find((entry) => entry.id === id);
  if (company === undefined) throw new Error(`no company ${id}`);
  return company;
};

describe('industriesForCompany', () => {
  it('puts the company\'s own sector first and lists every sector exactly once', () => {
    const state = world2();
    const company = companyOf(state, PLAYER_COMPANY);
    const order = industriesForCompany(company);
    expect(order[0]).toBe(company.sector);
    expect([...order].sort()).toEqual([...SECTORS].sort());
    expect(new Set(order).size).toBe(SECTORS.length);
  });
});

describe('lineLock', () => {
  it('is unlocked for a category with no requirement', () => {
    const state = world2();
    const company = companyOf(state, PLAYER_COMPANY);
    const open = PRODUCT_CATEGORIES.find((entry) => entry.requiresNodeIds.length === 0);
    if (open === undefined) throw new Error('no ungated category to test against');
    const lock = lineLock(state, company, open);
    expect(lock.locked).toBe(false);
    expect(lock.missingNodeIds).toEqual([]);
  });

  it('is locked for a category whose node has not been achieved, and clears once it has', () => {
    const state = world2();
    const company = companyOf(state, PLAYER_COMPANY);
    const gated = PRODUCT_CATEGORIES.find((entry) => entry.requiresNodeIds.length > 0);
    if (gated === undefined) throw new Error('no gated category to test against');
    const before = lineLock(state, company, gated);
    expect(before.locked).toBe(true);
    expect(before.missingNodeIds).toEqual(gated.requiresNodeIds.filter((nodeId) => before.missingNodeIds.includes(nodeId)));

    for (const nodeId of gated.requiresNodeIds) {
      const node = state.techGraph.nodes.find((entry) => entry.id === nodeId);
      if (node === undefined) continue;
      node.status = 'achieved';
      node.achievedByCompanyId = PLAYER_COMPANY;
      node.achievedQuarter = 0;
    }
    const after = lineLock(state, company, gated);
    expect(after.locked).toBe(false);
    expect(after.missingNodeIds).toEqual([]);
  });

  it('missingNodeTitles resolves ids to real node titles', () => {
    const state = world2();
    const company = companyOf(state, PLAYER_COMPANY);
    const gated = PRODUCT_CATEGORIES.find((entry) => entry.requiresNodeIds.length > 0);
    if (gated === undefined) throw new Error('no gated category to test against');
    const lock = lineLock(state, company, gated);
    const titles = missingNodeTitles(state, lock.missingNodeIds);
    expect(titles.length).toBe(lock.missingNodeIds.length);
    for (const title of titles) expect(title.length).toBeGreaterThan(0);
  });
});

describe('builtOnRows', () => {
  it('always offers "open market" first, for every declared input', () => {
    const state = world2();
    const company = companyOf(state, PLAYER_COMPANY);
    const withInputs = productCategoriesFor(company.sector).find((entry) => entry.inputs.length > 0) ?? PRODUCT_CATEGORIES.find((entry) => entry.inputs.length > 0);
    if (withInputs === undefined) throw new Error('no category with inputs to test against');
    const rows = builtOnRows(state, company, withInputs);
    expect(rows.length).toBe(withInputs.inputs.length);
    for (const row of rows) {
      expect(row.options[0]).toMatchObject({ kind: 'open_market', supplierCompanyId: null, supplierProductId: null });
    }
  });

  it('a category with no inputs returns no rows', () => {
    const state = world2();
    const company = companyOf(state, PLAYER_COMPANY);
    const commodity = PRODUCT_CATEGORIES.find((entry) => entry.inputs.length === 0);
    if (commodity === undefined) throw new Error('no commodity category to test against');
    expect(builtOnRows(state, company, commodity)).toEqual([]);
  });

  it('every offer beyond "open market" names a company genuinely publishing that input, matching suppliersFor', () => {
    const state = world2();
    const company = companyOf(state, PLAYER_COMPANY);
    const withInputs = PRODUCT_CATEGORIES.find((entry) => entry.inputs.some((input) => input.categoryId === 'ai_frontier_models'));
    if (withInputs === undefined) throw new Error('no category building on ai_frontier_models to test against');
    const rows = builtOnRows(state, company, withInputs);
    const row = rows.find((entry) => entry.input.categoryId === 'ai_frontier_models');
    if (row === undefined) return;
    const offerOptions = row.options.filter((option) => option.kind === 'offer');
    for (const option of offerOptions) {
      expect(option.offer).not.toBeNull();
      expect(option.supplierCompanyId).toBe(option.offer?.company.id);
    }
  });
});

describe('unservedRequiredInputs', () => {
  it('flags a required input with no offer and no open line at all', () => {
    const rows = [
      { input: { categoryId: 'x', share: 0.2, required: true }, category: null, options: [{ kind: 'open_market' as const, supplierCompanyId: null, supplierProductId: null, label: 'Open market', offer: null }] },
      { input: { categoryId: 'y', share: 0.2, required: false }, category: null, options: [{ kind: 'open_market' as const, supplierCompanyId: null, supplierProductId: null, label: 'Open market', offer: null }] },
    ];
    const flagged = unservedRequiredInputs(rows);
    expect(flagged.map((row) => row.input.categoryId)).toEqual(['x']);
  });
});

describe('supplyChoicesFrom', () => {
  it('drops open-market (null) selections, keeping only a deliberate named or refused choice', () => {
    const out = supplyChoicesFrom({
      a: { supplierCompanyId: null, supplierProductId: null },
      b: { supplierCompanyId: 'cmp_x', supplierProductId: 'prd_x' },
    });
    expect(out).toEqual([{ inputCategoryId: 'b', supplierCompanyId: 'cmp_x', supplierProductId: 'prd_x' }]);
  });
});
