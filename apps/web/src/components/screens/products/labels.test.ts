/**
 * `productsByIndustryLine`: pure grouping over `categoryOf`, nothing computed.
 */

import { describe, expect, it } from 'vitest';
import type { SessionState } from '@frontier/contracts';
import { categoryOf, createWorld2Session } from '@frontier/simulation';
import { productsByIndustryLine } from './labels';

const PLAYER_COMPANY = 'cmp_player_ventures';

function world2(): SessionState {
  return createWorld2Session();
}

const companyOf = (state: SessionState, id: string) => {
  const company = state.companies.find((entry) => entry.id === id);
  if (company === undefined) throw new Error(`no company ${id}`);
  return company;
};

describe('productsByIndustryLine', () => {
  it('places every product in the group named by its own category\'s industryLine', () => {
    const state = world2();
    const company = companyOf(state, PLAYER_COMPANY);
    const groups = productsByIndustryLine(company, company.products);
    const total = groups.reduce((sum, group) => sum + group.products.length, 0);
    expect(total).toBe(company.products.length);
    for (const group of groups) {
      for (const product of group.products) {
        expect(categoryOf(company, product).industryLine).toBe(group.industryLine);
      }
    }
  });

  it('is sorted by industry line name', () => {
    const state = world2();
    const company = companyOf(state, PLAYER_COMPANY);
    const groups = productsByIndustryLine(company, company.products);
    const names = groups.map((group) => group.industryLine);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  });

  it('is empty for an empty product list', () => {
    const state = world2();
    const company = companyOf(state, PLAYER_COMPANY);
    expect(productsByIndustryLine(company, [])).toEqual([]);
  });
});
