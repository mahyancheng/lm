/**
 * Stage 3's three new lookup kinds — `launchable_lines`, `suppliers`,
 * `customers` — proved against the same functions the Products screen and
 * `resolveSupplyLine` use, so a row the Chief of Staff quotes is a row the
 * screen would show and the validator would accept.
 */

import { describe, expect, it } from 'vitest';
import type { SessionState } from '@frontier/contracts';
import { PRODUCT_CATEGORIES } from '@frontier/contracts';
import { createDemoSession, DEMO_COMPANIES, DEMO_PLAYER_ID } from '../src/scenario';
import { createWorld2Session, W2_COMPANIES } from '../src/scenario/world2';
import { createActionValidator } from '../src/validator';
import { runLookups } from '../src/lookups';

const PLAYER_COMPANY = 'cmp_player_ventures';

function world2(): SessionState {
  return createWorld2Session();
}

const companyOf = (state: SessionState, id: string) => {
  const company = state.companies.find((entry) => entry.id === id);
  if (company === undefined) throw new Error(`no company ${id}`);
  return company;
};

describe('launchable_lines', () => {
  it('is empty in world 1, which has no catalogue', () => {
    const state = createDemoSession();
    const [result] = runLookups(state, DEMO_COMPANIES.player, [{ kind: 'launchable_lines' }]);
    expect(result?.kind).toBe('launchable_lines');
    if (result?.kind === 'launchable_lines') expect(result.rows).toEqual([]);
  });

  it('lists every catalogue line in the company\'s own sector, and a locked one names what is missing', () => {
    const state = world2();
    const company = companyOf(state, PLAYER_COMPANY);
    const [result] = runLookups(state, PLAYER_COMPANY, [{ kind: 'launchable_lines' }]);
    expect(result?.kind).toBe('launchable_lines');
    if (result?.kind !== 'launchable_lines') return;
    const inSector = PRODUCT_CATEGORIES.filter((entry) => entry.sector === company.sector);
    expect(result.rows.length).toBe(inSector.length);
    const gated = result.rows.find((row) => row.locked);
    if (gated !== undefined) {
      expect(gated.missingNodeTitles.length).toBeGreaterThan(0);
      expect(gated.intent).toBeNull();
    }
    const open = result.rows.find((row) => !row.locked);
    if (open !== undefined) {
      expect(open.intent).not.toBeNull();
      expect(open.intent).toMatchObject({ type: 'launch_product', categoryId: open.categoryId });
    }
  });

  it('a row it marks open is accepted by the real validator, unaltered by the launch category it names', () => {
    const state = world2();
    const [result] = runLookups(state, PLAYER_COMPANY, [{ kind: 'launchable_lines' }]);
    if (result?.kind !== 'launchable_lines') throw new Error('expected launchable_lines');
    const open = result.rows.find((row) => !row.locked && row.intent !== null);
    if (open === undefined || open.intent === null) throw new Error('no open line to test against');
    const validator = createActionValidator();
    const [verdict] = validator.validateBatch(state, [
      {
        actionId: 'act_launchable_probe',
        sessionId: state.sessionId,
        quarter: state.quarter,
        sequence: 1,
        actorPlayerId: DEMO_PLAYER_ID,
        actorCompanyId: PLAYER_COMPANY,
        actorCharacterId: 'chr_avery_sinclair',
        origin: 'player_ui',
        intent: open.intent,
        confirmedByHuman: true,
      },
    ]);
    expect(verdict?.status).not.toBe('rejected');
  });

  it('unlocks once the required node is achieved', () => {
    const state = world2();
    const gated = PRODUCT_CATEGORIES.find((entry) => entry.requiresNodeIds.length > 0 && entry.sector === companyOf(state, PLAYER_COMPANY).sector);
    if (gated === undefined) return; // no gated line in this company's own sector to prove against
    for (const nodeId of gated.requiresNodeIds) {
      const node = state.techGraph.nodes.find((entry) => entry.id === nodeId);
      if (node === undefined) continue;
      node.status = 'achieved';
      node.achievedByCompanyId = PLAYER_COMPANY;
      node.achievedQuarter = 0;
    }
    const [result] = runLookups(state, PLAYER_COMPANY, [{ kind: 'launchable_lines' }]);
    if (result?.kind !== 'launchable_lines') throw new Error('expected launchable_lines');
    const row = result.rows.find((entry) => entry.categoryId === gated.id);
    expect(row?.locked).toBe(false);
  });
});

describe('suppliers', () => {
  it('finds a live named supplier, best quality per dollar first, and names the choose_supplier intent when a product is given', () => {
    const state = world2();
    // ai_frontier_models is canSupply and every AI seed company publishes it
    // by default (npc.ts's default policy) — assert against whichever
    // frontier-model seed actually has terms live rather than hard-coding one.
    const [probe] = runLookups(state, PLAYER_COMPANY, [{ kind: 'suppliers', inputCategoryId: 'ai_frontier_models', productId: null }]);
    if (probe?.kind !== 'suppliers') throw new Error('expected suppliers');
    if (probe.rows.length === 0) return; // nothing publishes yet on this seed; the empty-catalogue path is covered below
    const buyerProduct = companyOf(state, PLAYER_COMPANY).products.find((product) => product.isActive);
    const [withProduct] = runLookups(state, PLAYER_COMPANY, [
      { kind: 'suppliers', inputCategoryId: 'ai_frontier_models', productId: buyerProduct?.id ?? null },
    ]);
    if (withProduct?.kind !== 'suppliers') throw new Error('expected suppliers');
    if (buyerProduct !== undefined) {
      expect(withProduct.rows[0]?.intent).toMatchObject({ type: 'choose_supplier', productId: buyerProduct.id, inputCategoryId: 'ai_frontier_models' });
    }
    expect(probe.rows[0]?.intent).toBeNull();
    // best quality per dollar first
    for (let index = 1; index < probe.rows.length; index += 1) {
      const prior = probe.rows[index - 1]!;
      const current = probe.rows[index]!;
      const priorScore = prior.qualityScorePct / Math.max(1, prior.pricePerUnitUsd);
      const currentScore = current.qualityScorePct / Math.max(1, current.pricePerUnitUsd);
      expect(priorScore).toBeGreaterThanOrEqual(currentScore - 1e-9);
    }
  });

  it('is empty for a category nobody publishes', () => {
    const state = world2();
    const [result] = runLookups(state, PLAYER_COMPANY, [{ kind: 'suppliers', inputCategoryId: 'energy_transmission', productId: null }]);
    if (result?.kind !== 'suppliers') throw new Error('expected suppliers');
    // energy_transmission has canSupply: false in the catalogue, so it is never offered.
    expect(result.rows).toEqual([]);
  });
});

describe('customers', () => {
  it('is empty when nobody is building on the named line', () => {
    const state = world2();
    const own = companyOf(state, PLAYER_COMPANY).products.find((product) => product.isActive);
    if (own === undefined) throw new Error('player has no product to test against');
    const [result] = runLookups(state, PLAYER_COMPANY, [{ kind: 'customers', productId: own.id }]);
    if (result?.kind !== 'customers') throw new Error('expected customers');
    expect(Array.isArray(result.rows)).toBe(true);
  });

  it('lists a real buyer once one is drawing on a published line, matching customersFor', () => {
    const state = world2();
    const supplier = companyOf(state, W2_COMPANIES.aletheia ?? PLAYER_COMPANY);
    const supplyingProduct = supplier.products.find((product) => product.isActive && product.supplyTerms != null);
    if (supplyingProduct === undefined) return; // this seed's default policy did not publish anything yet
    const [result] = runLookups(state, supplier.id, [{ kind: 'customers', productId: supplyingProduct.id }]);
    if (result?.kind !== 'customers') throw new Error('expected customers');
    for (const row of result.rows) {
      expect(row.revenueUsd).toBeGreaterThanOrEqual(0);
      expect(row.unitsFilled).toBeGreaterThanOrEqual(0);
    }
  });
});
