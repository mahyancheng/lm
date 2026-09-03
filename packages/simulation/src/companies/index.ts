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
 *
 * The order matters a second time for the filed statements: `resolveFinancials`
 * writes each closed quarter's `FinancialQuarter`, and `recomputeMetrics` — six
 * phases and one market print later — stamps the market capitalisation and the
 * closing share price onto the statement that quarter already filed.
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
export {
  ACCELERATOR_SELLER_ARCHETYPES,
  MANUFACTURING_SECTORS,
  SELLER_ENERGY_WEIGHT,
  SELLER_FACTOR_BOUNDS,
  SELLER_UTILISATION_WEIGHT,
  acceleratorOutputUnits,
  acceleratorSupplyFactor,
  acceleratorUnitPriceUsd,
  cloudUnitPriceUsd,
  makesAccelerators,
  ownComputeNeedUnits,
  rentsCapacity,
  reservationUnitPriceUsd,
  resolveCloudSeller,
  resolveComputeSeller,
  sellableCapacityUnits,
  sellerPriceFactor,
  sellersFor,
} from './sellers';
export type { ComputeSeller } from './sellers';
export {
  cloudChargeUsd,
  counterpartyCharges,
  counterpartyRevenueByCompany,
  reservationChargeUsd,
} from './counterparty';
export type { CounterpartyCharge } from './counterparty';
export { resolveFinancials, computeCost, COUNTERPARTY_DEFAULT_MARGIN, counterpartyMarginOf, lastQuarterNetIncomeUsd } from './financials';
export type { ComputeCostBreakdown } from './financials';
export { appendFinancialQuarter, financialHistoryOf, financialQuarterOf, recentFinancialQuarters, stampMarketKpis } from './history';
export { isInsolvent, negativeCashQuarters, overdraftChargeUsd, solvencyCommitmentNote, solvencyLine } from './solvency';
export type { FinancialQuarterInput } from './history';
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
export {
  ACTIVE_COMPANY_CAP,
  ENTRANTS_PER_QUARTER,
  FOUNDER_NAME_BANK,
  NAME_BANK,
  NEW_ENTRANT_QUARTERS,
  activeNonHuskCount,
  closeEliminatedSeats,
  isEliminated,
  isNewEntrant,
  leadInvestorFor,
  regionWeightFor,
  resolveMarketEntry,
  seedCapitalUsd,
} from './entrants';
export type { AdministrationRow, MarketEntry } from './entrants';
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
