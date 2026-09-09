/**
 * Independent resolver-level conservation checks for direct hardware and
 * private production chains. These deliberately use complete quarterly
 * resolution rather than internal allocator helpers.
 */
import { describe, expect, it } from 'vitest';
import { COMPUTE_CAPACITY_NODE_ID, economicNodeById, type ActionIntent, type SessionState, type SubmittedAction } from '@frontier/contracts';
import { createDefaultEngine } from '../src/engine';
import { acceleratorUnitPriceUsd } from '../src/companies/sellers';
import { currentAcceleratorOutputCapacity, lineNodeIdOf } from '../src/graph';
import { createWorld3Session } from '../src/scenario/world3';

function company(state: SessionState, id: string) {
  const found = state.companies.find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`Missing company ${id}`);
  return found;
}

function resolve(state: SessionState, actions: readonly SubmittedAction[] = []) {
  const outcome = createDefaultEngine().resolver.resolveQuarter(state, actions, null, []);
  expect(outcome.committed).toBe(true);
  expect(outcome.invariants.filter((entry) => !entry.passed)).toEqual([]);
  return outcome;
}

describe('world-3 direct accelerator conservation and accounting', () => {
  it('keeps a shocked manufacturer’s direct and anonymous shipments within current output, and books direct COGS once', () => {
    const state = createWorld3Session();
    const buyer = company(state, state.players[0]!.companyId);
    const seller = state.companies
      .filter((entry) => entry.id !== buyer.id && entry.products.some((product) => lineNodeIdOf(product, state) === COMPUTE_CAPACITY_NODE_ID))
      .map((entry) => ({ entry, capacity: currentAcceleratorOutputCapacity(state, entry) }))
      .find(({ capacity }) => capacity > 4);
    expect(seller).toBeDefined();
    if (seller === undefined) return;

    // A capacity shock must affect the direct allocator and the anonymous
    // production pass together. Keep some plant so the assertion exercises a
    // partial physical pool rather than a trivial zero-output path.
    if (seller.entry.capacity !== undefined) {
      seller.entry.capacity = { ...seller.entry.capacity, plantUsd: seller.entry.capacity.plantUsd * 0.15 };
    }
    const currentOutput = currentAcceleratorOutputCapacity(state, seller.entry);
    expect(currentOutput).toBeGreaterThan(0);

    const intent: ActionIntent = {
      type: 'buy_accelerators',
      units: currentOutput + 10_000,
      maxPricePerUnitUsd: Math.max(1_000_000, acceleratorUnitPriceUsd(state, seller.entry) * 2),
      sellerCompanyId: seller.entry.id,
      quotedUnitPriceUsd: null,
    };
    const action: SubmittedAction = {
      actionId: 'act_physics_direct_hardware', sessionId: state.sessionId, quarter: state.quarter, sequence: 1,
      actorPlayerId: state.players[0]!.playerId, actorCompanyId: buyer.id, actorCharacterId: state.players[0]!.characterId!,
      origin: 'player_ui', confirmedByHuman: true, intent,
    };
    const outcome = resolve(state, [action]);
    const nextSeller = company(outcome.nextState, seller.entry.id);
    const purchase = outcome.events.find((event) => event.type === 'accelerators_bought' && event.actorId === buyer.id && event.targetId === seller.entry.id);
    const directUnits = typeof purchase?.payload.units === 'number' ? purchase.payload.units : 0;
    const anonymousUnits = nextSeller.products
      .filter((product) => product.isActive && lineNodeIdOf(product, outcome.nextState) === COMPUTE_CAPACITY_NODE_ID)
      .reduce((sum, product) => sum + Math.max(0, product.unitsSoldQuarterly ?? 0), 0);
    expect(directUnits).toBeGreaterThan(0);
    expect(directUnits + anonymousUnits).toBeLessThanOrEqual(currentOutput);

    const cost = outcome.events.find(
      (event) => event.type === 'cost_recognised' && event.actorId === seller.entry.id && typeof event.payload.nodeCogsUsd === 'number',
    );
    expect(cost?.payload.directHardwareCogsUsd).toEqual(expect.any(Number));
    const directCogs = Number(cost?.payload.directHardwareCogsUsd ?? 0);
    expect(directCogs).toBeGreaterThan(0);
    const anonymousRollup = nextSeller.products
      .filter((product) => product.isActive && lineNodeIdOf(product, outcome.nextState) !== null)
      .reduce((sum, product) => sum + Math.max(0, product.unitsSoldQuarterly ?? 0) * Math.max(0, product.unitCostUsd ?? 0), 0);
    expect(Number(cost?.payload.nodeCogsUsd ?? 0)).toBeCloseTo(anonymousRollup + directCogs, 2);
  });
});

describe('private three-stage physical chain', () => {
  it('does not reuse a ten-unit private material through a B→C chain in one quarter', () => {
    const state = createWorld3Session();
    const owner = company(state, state.players[0]!.companyId);
    const base = economicNodeById('sys_ai_accelerator')!;
    const slot = (id: string, input: string, qty: number) => ({ id, label: id, role: 'accelerator' as const, qtyPerUnit: qty, required: true, blocking: true, accepts: [input], defaultNodeId: input, kind: 'input' as const });
    const a = { ...base, id: 'custom_private_a', label: 'Private A', tier: 2, slots: [], requires: [], capacityKind: 'plant' as const, capacityDrawPerUnit: 1, basePriceUsd: 100 };
    const b = { ...base, id: 'custom_private_b', label: 'Private B', tier: 3, slots: [slot('a', a.id, 10)], requires: [], capacityKind: 'none' as const, capacityDrawPerUnit: 0, basePriceUsd: 200 };
    const c = { ...base, id: 'custom_private_c', label: 'Private C', tier: 4, slots: [slot('b', b.id, 1)], requires: [], capacityKind: 'none' as const, capacityDrawPerUnit: 0, basePriceUsd: 300 };
    state.customEconomicNodes = [a, b, c];
    owner.capacity = { plantUsd: 10_000_000, fleetUsd: 0, gridUsd: 0 };
    const template = owner.products[0]!;
    owner.products = [a, b, c].map((node, index) => ({ ...template, id: `prd_chain_${index}`, name: node.label, nodeId: node.id, segment: 'enterprise' as const, targetIndustry: 'manufacturing' as const, unitsSoldQuarterly: 100, unitsSoldLastQuarter: 100, isActive: true, slots: index === 0 ? [] : [{ slotId: index === 1 ? 'a' : 'b', nodeId: index === 1 ? a.id : b.id, supplierCompanyId: owner.id, supplierProductId: `prd_chain_${index - 1}`, cutOffNoticeQuarter: null, changedQuarter: null }] }));
    const next = resolve(state).nextState;
    const lines = company(next, owner.id).products;
    const aUnits = lines[0]!.unitsSoldQuarterly ?? 0;
    const bUnits = lines[1]!.unitsSoldQuarterly ?? 0;
    const cUnits = lines[2]!.unitsSoldQuarterly ?? 0;
    expect(aUnits).toBeGreaterThan(0);
    expect(bUnits * 10).toBeLessThanOrEqual(aUnits);
    expect(cUnits).toBeLessThanOrEqual(bUnits);
  });
});
