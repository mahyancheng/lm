/**
 * @frontier/simulation — companies
 *
 * The company operations subsystem: people, products, money and the archetype
 * behaviour that keeps hundreds of companies alive without a model call each.
 *
 * The five functions here are the `CompaniesSubsystem` interface from
 * `@frontier/contracts/engine`, and they run in four different resolver phases:
 *
 * | Function            | Phase                       |
 * |---------------------|-----------------------------|
 * | `applyNpcDefaults`  | `action_collection` (4)      |
 * | `resolveHiring`     | `talent_resolution` (8)      |
 * | `resolveProducts`   | `product_demand_resolution` (10) |
 * | `resolveFinancials` | `financial_resolution` (11)  |
 * | `recomputeMetrics`  | `leaderboard_update` (16)    |
 *
 * The order matters and is part of the contract. `resolveHiring` stages the
 * quarter's payroll and `resolveProducts` stages the quarter's marketing;
 * `resolveFinancials` is the only function that moves cash, and it is the only
 * place the balance-sheet identity is enforced.
 */

import type { CompaniesSubsystem } from '@frontier/contracts';
import { resolveHiring } from './hiring';
import { resolveProducts } from './products';
import { resolveFinancials } from './financials';
import { applyNpcDefaults } from './npc';
import { recomputeMetrics } from './metrics';

export { resolveHiring, fillRate, poachProbability, offerCompUsd, requiredCompUsd, regionalCompUsd, regionalOfferCompUsd } from './hiring';
export { livedGrossMarginPct, previousTtmUsd, quarterNetIncomeUsd, rollFundamentals, sharesOutstandingFor } from './fundamentals';
export { MAX_LIVE_STRATEGISTS, strategistCompanyIds } from './strategists';
export {
  resolveProducts,
  segmentDemand,
  priceFactor,
  relativePrice,
  productChurn,
  priceShock,
  marketingLift,
  customersPerUnit,
  servingComputeUnits,
  heldComputeUnits,
  unclampedGrossMargin,
} from './products';
export { resolveComputeOrders, reservedUnitPriceUsd } from './compute';
export { resolveFinancials, computeCost, lastQuarterNetIncomeUsd } from './financials';
export type { ComputeCostBreakdown } from './financials';
export {
  resolveDistress,
  bridgeAppetite,
  enterAdministration,
  recentFailedBridges,
  rescueQuartersRunning,
  chronicallyRescued,
  isWoundUp,
} from './distress';
export type { AdministrationCause } from './distress';
export { applyNpcDefaults, bidTarget } from './npc';
export { recomputeMetrics, recomputeAntitrustExposure, recomputeControlStatus } from './metrics';
export { marketingPlan, policyMarketingUsd, policyResearchEnvelopeUsd, researchEnvelopeUsd } from './policy';
export type { MarketingPlan } from './policy';
export { ARCHETYPE_POLICIES, POSTURE_ADJUSTMENTS, effectivePolicy } from './archetypes';
export type { ArchetypePolicy, PostureAdjustment, EffectivePolicy } from './archetypes';
export * from './balance';

/**
 * Build the company subsystem. Stateless: everything it needs comes from the
 * draft and the resolver context, so one instance can serve every session.
 */
export function createCompaniesSubsystem(): CompaniesSubsystem {
  return {
    resolveHiring,
    resolveProducts,
    resolveFinancials,
    applyNpcDefaults,
    recomputeMetrics,
  };
}
