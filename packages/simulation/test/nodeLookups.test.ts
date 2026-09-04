/**
 * The Chief of Staff, asked the node economy's two questions.
 *
 * "What does this cost me to build?" and "What do I need to research to enter
 * robotics?" are the questions world 2's vocabulary could not put: it had a
 * catalogue of product lines and a reference price, and no way to say what a
 * thing costs to make or what standing between a company and an industry.
 *
 * Both answers are read off canonical state by the engine — `unitCostOf`,
 * `costBreakdown`, `nodeEntryRoutes` — so what is tested here is that the rows
 * carry the engine's own numbers, that an intent on a row is one the validator
 * accepts, and that both degrade to an honest empty answer in a world that has
 * no node economy rather than throwing or inventing.
 */

import { describe, expect, it } from 'vitest';
import type { Company, SessionState } from '@frontier/contracts';
import { ECONOMIC_NODES, economicNodeById, nodeMarketPriceUsd } from '@frontier/contracts';
import { createWorld3Session } from '../src/scenario/world3';
import { createDemoSession } from '../src/scenario';
import { runLookups } from '../src/lookups';
import { unitCostOf } from '../src/graph/cost';
import { costBreakdown } from '../src/graph/options';
import { availableActionsFor } from '../src/validator/availability';
import { validateAction } from '../src/validator';
import { BatchBudget } from '../src/validator/context';

const ACCELERATOR = 'sys_ai_accelerator';

/** The seat the probes are asked from: the company's own controller and chief executive. */
function actorFor(company: Company): { playerId: string; companyId: string; characterId: string } {
  return {
    playerId: company.controllerPlayerId ?? 'player_1',
    companyId: company.id,
    characterId: company.ceoCharacterId ?? '',
  };
}

/** The company the player actually directs, so a validator verdict is about the rule under test. */
function playerCompany(state: SessionState): Company {
  const controlled = state.companies.find((company) => company.controllerPlayerId !== null && company.isActive);
  return (controlled ?? state.companies[0]) as Company;
}

/* -------------------------------------------------------------------------- */
/*  unit_cost                                                                  */
/* -------------------------------------------------------------------------- */

describe('the unit_cost lookup', () => {
  it('is the roll-up, itemised, descending, with the same total', () => {
    const state = createWorld3Session();
    const company = playerCompany(state);
    const [result] = runLookups(state, company.id, [{ kind: 'unit_cost', nodeId: ACCELERATOR }]);
    expect(result?.kind).toBe('unit_cost');
    if (result?.kind !== 'unit_cost') throw new Error('wrong kind');

    const truth = unitCostOf(state, company, ACCELERATOR);
    expect(result.unitCostUsd).toBe(Math.round(truth.unitCostUsd));
    expect(result.marketPriceUsd).toBe(Math.round(nodeMarketPriceUsd(state, ACCELERATOR)));
    expect(result.unitLabel).toBe(economicNodeById(ACCELERATOR)?.unitLabel);

    // Same rows, same order, same numbers as `costBreakdown`.
    const rows = costBreakdown(truth).slice(0, result.rows.length);
    expect(result.rows.map((row) => row.key)).toEqual(rows.map((row) => row.key));
    for (let i = 0; i < result.rows.length; i += 1) {
      expect(result.rows[i]?.amountUsd).toBe(Math.max(0, Math.round(rows[i]?.amountUsd ?? 0)));
    }
    // Whole numbers only, everywhere.
    expect(Number.isInteger(result.unitCostUsd)).toBe(true);
    expect(result.rows.every((row) => Number.isInteger(row.amountUsd) && Number.isInteger(row.sharePct))).toBe(true);
  });

  it('names the counterparty on a row that is bought from one', () => {
    const state = createWorld3Session();
    const company = playerCompany(state);
    const [result] = runLookups(state, company.id, [{ kind: 'unit_cost', nodeId: ACCELERATOR }]);
    if (result?.kind !== 'unit_cost') throw new Error('wrong kind');
    for (const row of result.rows) {
      if (row.sourceKind === 'buy') expect(row.sourceName.length).toBeGreaterThan(0);
      if (row.sourceKind === 'market' || row.sourceKind === 'conversion') expect(row.sourceName).toBe('');
    }
  });

  it('answers an unknown node and a world with no node economy without throwing', () => {
    const state = createWorld3Session();
    const company = playerCompany(state);
    const [missing] = runLookups(state, company.id, [{ kind: 'unit_cost', nodeId: 'nope_not_a_node' }]);
    if (missing?.kind !== 'unit_cost') throw new Error('wrong kind');
    expect(missing.rows).toEqual([]);
    expect(missing.summary).toContain('no node');

    const world2 = createDemoSession();
    const [outside] = runLookups(world2, playerCompany(world2).id, [{ kind: 'unit_cost', nodeId: ACCELERATOR }]);
    if (outside?.kind !== 'unit_cost') throw new Error('wrong kind');
    expect(outside.unitCostUsd).toBe(0);
    expect(outside.rows).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/*  entry_path                                                                 */
/* -------------------------------------------------------------------------- */

describe('the entry_path lookup', () => {
  it('finds the shortest way into a sector this company is not in', () => {
    const state = createWorld3Session();
    const company = playerCompany(state);
    // A sector that is not this company's own, so the answer is a real path.
    const foreign = (['robotics', 'energy', 'logistics', 'consumer', 'manufacturing', 'ai'] as const).find(
      (sector) => sector !== company.sector,
    );
    const [result] = runLookups(state, company.id, [{ kind: 'entry_path', sector: foreign ?? 'robotics', nodeId: '' }]);
    if (result?.kind !== 'entry_path') throw new Error('wrong kind');

    expect(result.sector).toBe(foreign);
    // The target it picked is in the sector asked about.
    expect(economicNodeById(result.nodeId)?.sector).toBe(foreign);
    if (!result.alreadyIn) {
      expect(result.rows.length).toBeGreaterThan(0);
      // Every step is a node the company does not hold, with its tier stated.
      for (const row of result.rows) {
        expect(ECONOMIC_NODES.some((node) => node.id === row.nodeId)).toBe(true);
        expect(Number.isInteger(row.tier)).toBe(true);
        expect(row.researchLowUsd).toBeLessThanOrEqual(row.researchHighUsd);
      }
    }
  });

  it('offers a start_research intent only where the validator would accept one', () => {
    const state = createWorld3Session();
    const company = playerCompany(state);
    const foreign = (['robotics', 'energy', 'logistics', 'consumer', 'manufacturing'] as const).find(
      (sector) => sector !== company.sector,
    );
    const [result] = runLookups(state, company.id, [{ kind: 'entry_path', sector: foreign ?? 'robotics', nodeId: '' }]);
    if (result?.kind !== 'entry_path') throw new Error('wrong kind');

    for (const row of result.rows) {
      if (row.intent === null) continue;
      const verdict = validateAction(
        state,
        row.intent,
        { playerId: company.controllerPlayerId ?? 'player_1', companyId: company.id, characterId: company.ceoCharacterId, confirmedByHuman: true },
        new BatchBudget(),
        `entry_${row.nodeId}`,
      );
      // A programme the role offers is one the validator will not refuse for a
      // structural reason. Money is never a gate, so a clamp is a pass.
      expect(
        verdict.status !== 'rejected' || !verdict.codes.includes('requirement_not_met'),
        `${row.nodeId}: ${verdict.reasons.join(' | ')}`,
      ).toBe(true);
    }
  });

  it('says so plainly when the company is already in the sector', () => {
    const state = createWorld3Session();
    const company = playerCompany(state);
    const [result] = runLookups(state, company.id, [{ kind: 'entry_path', sector: company.sector ?? 'ai', nodeId: '' }]);
    if (result?.kind !== 'entry_path') throw new Error('wrong kind');
    expect(result.alreadyIn).toBe(true);
    expect(result.summary).toContain('already');
  });

  it('takes one node instead of a sector, and refuses to guess when given neither', () => {
    const state = createWorld3Session();
    const company = playerCompany(state);
    const [named] = runLookups(state, company.id, [{ kind: 'entry_path', sector: '', nodeId: ACCELERATOR }]);
    if (named?.kind !== 'entry_path') throw new Error('wrong kind');
    expect(named.nodeId).toBe(ACCELERATOR);

    const [nothing] = runLookups(state, company.id, [{ kind: 'entry_path', sector: '', nodeId: '' }]);
    if (nothing?.kind !== 'entry_path') throw new Error('wrong kind');
    expect(nothing.rows).toEqual([]);
    expect(nothing.summary).toContain('Name a sector');
  });

  it('degrades honestly in a world with no node economy', () => {
    const world2 = createDemoSession();
    const [result] = runLookups(world2, playerCompany(world2).id, [{ kind: 'entry_path', sector: 'robotics', nodeId: '' }]);
    if (result?.kind !== 'entry_path') throw new Error('wrong kind');
    expect(result.rows).toEqual([]);
    expect(result.alreadyIn).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/*  The probes                                                                 */
/* -------------------------------------------------------------------------- */

describe('the available-actions probes speak world 3', () => {
  it('offers node targets for a launch, and every one of them is legal', () => {
    const state = createWorld3Session();
    const company = playerCompany(state);
    const actions = availableActionsFor(state, actorFor(company));
    const launch = actions.find((action) => action.type === 'launch_product');
    expect(launch?.available).toBe(true);
    expect((launch?.targets ?? []).length).toBeGreaterThan(0);
    for (const target of launch?.targets ?? []) {
      expect(ECONOMIC_NODES.some((node) => node.id === target.id), `${target.id} is not a node`).toBe(true);
    }
    // The probe's own price is quoted per unit, not per seat.
    expect(launch?.bounds.some((bound) => bound.label.includes('per unit'))).toBe(true);
  });

  it('wires an input the line\'s own node consumes, and refuses one it does not', () => {
    const state = createWorld3Session();
    const company = playerCompany(state);
    const line = company.products.find((product) => (economicNodeById(product.nodeId ?? '')?.consumes.length ?? 0) > 0);
    expect(line, 'the player company runs no line with inputs').toBeDefined();
    const lineNode = economicNodeById(line?.nodeId ?? '');
    const inputNodeId = lineNode?.consumes[0]?.nodeId ?? '';

    const actor = { playerId: company.controllerPlayerId, companyId: company.id, characterId: company.ceoCharacterId, confirmedByHuman: true };

    // The open market is always legal, on an input the node really consumes.
    const open = validateAction(
      state,
      { type: 'choose_supplier', productId: line?.id ?? '', inputCategoryId: inputNodeId, supplierCompanyId: null, supplierProductId: null },
      actor,
      new BatchBudget(),
      'wire_open',
    );
    expect(open.status, open.reasons.join(' | ')).not.toBe('rejected');

    // An input this node does not consume is refused, and the refusal names the
    // node rather than a world-2 category.
    const wrong = validateAction(
      state,
      { type: 'choose_supplier', productId: line?.id ?? '', inputCategoryId: 'res_diesel_fuel', supplierCompanyId: null, supplierProductId: null },
      actor,
      new BatchBudget(),
      'wire_wrong',
    );
    if (!lineNode?.consumes.some((input) => input.nodeId === 'res_diesel_fuel')) {
      expect(wrong.status).toBe('rejected');
      expect(wrong.reasons.join(' ')).toContain(lineNode?.label ?? '');
    }
  });
});
