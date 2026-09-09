/**
 * Bounded repair for the short-lived World 3 seed that omitted Tessellate's
 * accelerator supply line.  This is deliberately a state upgrade, not a
 * historical replay edit: it leaves the recorded decisions and ledger alone.
 */
import type { Product, ProductSlotFill, SessionState, SimEvent } from '@frontier/contracts';
import { ECONOMIC_NODES_BY_ID, makeId } from '@frontier/contracts';
import { fnv1a64, hashState, stableStringify } from '@frontier/shared';
import { W2_COMPANIES } from '../world2';
import { w3RivalLinesFor, w3SeedProductId } from './lines';

export const W3_TESSELLATE_ACCELERATOR_SAVE_UPGRADE = 'w3_tessellate_accelerator_supplier_v1';
const TESSELLATE = W2_COMPANIES.tessellate;
const ACCELERATOR = 'sys_ai_accelerator';
const OLD_SEED_NODES = new Set(['mat_wafer_300mm', 'sys_advanced_package']);

export interface World3SaveUpgradeResult {
  readonly state: SessionState;
  /** True only when the missing seed line was actually inserted. */
  readonly applied: boolean;
  /** True when this is recognisably the pre-fix seed layout. */
  readonly recognisedOldLayout: boolean;
  readonly event: SimEvent | null;
}

/**
 * Make the one missing *seeded* supplier line in an old World 3 snapshot.
 *
 * It never changes cash, financials, balance sheet, research, capacity, old
 * products, or historical records.  The new line starts without a fabricated
 * customer book, and draws from Tessellate's already-owned shared plant.
 *
 * A state is eligible only when it still has the exact two-line Tessellate seed
 * layout. This prevents this compatibility repair from adding products to a
 * player-modified company. An inactive company and an already-explicit line
 * are intentionally left untouched; the save-file marker prevents a future
 * reload from treating a deliberate sunset/removal as the old seed again.
 */
export function upgradeWorld3TessellateAcceleratorSupplier(state: SessionState): World3SaveUpgradeResult {
  if (state.config.worldVersion !== 3) return { state, applied: false, recognisedOldLayout: false, event: null };
  const company = state.companies.find((candidate) => candidate.id === TESSELLATE);
  if (company === undefined) return { state, applied: false, recognisedOldLayout: false, event: null };

  const explicit = company.products.some((product) => product.id === w3SeedProductId('tessellate', 2) || product.nodeId === ACCELERATOR);
  // An explicit seed-id line (including an inactive one) is already a deliberate
  // successor state and only needs its marker, never an edit.
  if (explicit) return { state, applied: false, recognisedOldLayout: true, event: null };
  const recognisedOldLayout =

    company.products.length === 2 &&
    company.products.every((product) => OLD_SEED_NODES.has(product.nodeId ?? '')) &&
    company.products.some((product) => product.id === w3SeedProductId('tessellate', 0) && product.nodeId === 'mat_wafer_300mm') &&
    company.products.some((product) => product.id === w3SeedProductId('tessellate', 1) && product.nodeId === 'sys_advanced_package');
  if (!recognisedOldLayout || !company.isActive) return { state, applied: false, recognisedOldLayout, event: null };

  const recipe = w3RivalLinesFor(TESSELLATE).find((line) => line.nodeId === ACCELERATOR);
  const node = ECONOMIC_NODES_BY_ID[ACCELERATOR];
  const template = company.products[1] ?? company.products[0];
  if (recipe === undefined || node === undefined || template === undefined) return { state, applied: false, recognisedOldLayout, event: null };

  const fills: ProductSlotFill[] = recipe.fills.map((fill) => {
    if (fill.source === 'self') {
      const index = w3RivalLinesFor(TESSELLATE).findIndex((line) => line.nodeId === fill.nodeId);
      return { slotId: fill.slotId, nodeId: fill.nodeId, supplierCompanyId: TESSELLATE, supplierProductId: index < 0 ? null : w3SeedProductId('tessellate', index), cutOffNoticeQuarter: null, changedQuarter: null };
    }
    const sellerId = `cmp_${fill.source}`;
    const index = w3RivalLinesFor(sellerId).findIndex((line) => line.nodeId === fill.nodeId && line.published);
    return { slotId: fill.slotId, nodeId: fill.nodeId, supplierCompanyId: index < 0 ? null : sellerId, supplierProductId: index < 0 ? null : w3SeedProductId(fill.source, index), cutOffNoticeQuarter: null, changedQuarter: null };
  });

  const price = Math.max(0.01, node.basePriceUsd);
  const product: Product = {
    ...template,
    id: w3SeedProductId('tessellate', 2),
    name: `Tessellate ${node.label}`,
    nodeId: node.id,
    segment: recipe.segment,
    targetIndustry: recipe.targetIndustry,
    pricePerSeat: price,
    activeCustomers: 0,
    unitsSoldQuarterly: 0,
    installedBase: 0,
    backlogUnits: 0,
    contractBilledUsd: 0,
    unitCostUsd: 0,
    craftQuality: template.craftQuality ?? template.qualityScore,
    qualityScore: template.qualityScore,
    qualityTier: template.qualityTier ?? template.computeIntensity,
    supply: [],
    slots: fills,
    supplyTerms: { openToAll: true, pricePerUnitUsd: price, exclusiveCustomerIds: [], blockedCustomerIds: [] },
    isActive: true,
    launchedQuarter: state.quarter,
  };
  const companies = state.companies.map((candidate) => candidate.id === TESSELLATE ? { ...candidate, products: [...candidate.products, product], ownedNodes: (candidate.ownedNodes ?? []).includes(ACCELERATOR) ? candidate.ownedNodes : [...(candidate.ownedNodes ?? []), ACCELERATOR] } : candidate);
  const before = hashState(state);
  const next = { ...state, companies, ledgerSequence: state.ledgerSequence + 1 };
  const after = hashState(next);
  const event: SimEvent = {
    eventId: makeId('evt', state.sessionId, state.quarter, state.ledgerSequence), sessionId: state.sessionId, quarter: state.quarter, sequence: state.ledgerSequence,
    type: 'migration_applied', actorId: TESSELLATE, targetId: ACCELERATOR,
    payload: { migration: W3_TESSELLATE_ACCELERATOR_SAVE_UPGRADE, grantedNodeId: ACCELERATOR, grantedProductId: product.id, financialAssetsAddedUsd: 0, capacityAdded: false },
    stateHashBefore: before, stateHashAfter: after, rowHash: '', visibility: 'company',
  };
  event.rowHash = fnv1a64(`${before}|${stableStringify({ eventId: event.eventId, sessionId: event.sessionId, quarter: event.quarter, sequence: event.sequence, type: event.type, actorId: event.actorId, targetId: event.targetId, payload: event.payload, stateHashBefore: event.stateHashBefore, stateHashAfter: event.stateHashAfter, visibility: event.visibility })}`);
  return { state: next, applied: true, recognisedOldLayout: true, event };
}
