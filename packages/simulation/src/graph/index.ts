/**
 * @frontier/simulation — graph
 *
 * World 3's one node economy, as the engine sees it: the lines companies run,
 * the market that prices every node once a quarter, and the roll-up that turns
 * those prices into the unit cost the profit and loss books.
 *
 * Nothing in here reads a random number or a clock, and nothing in here is
 * reached at all below world version 3 — `isNodeEconomyWorld` is the single
 * gate, and it is deliberately not `isMultiSectorWorld`, which means "version 2
 * or later" and would drag a live world-2 game into world-3 behaviour.
 */

export {
  CAPACITY_RATE_USD_PER_MILLION,
  CAPACITY_UNIT_USD,
  NODE_CAPACITY_KINDS,
  QUALITY_TIER_BASELINE,
  capacityRateUsd,
  capacityStockOf,
  createNodeCostCache,
  drawPerUnitAtTier,
  drawPerUnitOf,
  ownedNodeIdsOf,
  indexNodeLines,
  launchableNodes,
  lineNodeIdOf,
  lineNodeOf,
  lineOf,
  nodeLinesOf,
  producersOf,
  productOf,
  qualityTierFactor,
} from './lines';
export type { LaunchableNode, NodeLineIndex } from './lines';

export {
  CAPACITY_FOOTHOLD_SHARE,
  DEMAND_LEVEL_BOUNDS,
  NEUTRAL_SEGMENT_APPETITE,
  NODE_PRICE_REPORT_LIMIT,
  NODE_PRICE_REPORT_THRESHOLD,
  NODE_WORLD_SHIFTER,
  SIZED_CUSTOMERS,
  SIZE_FACTOR_BOUNDS,
  bucketShare,
  cellDemandLevel,
  cellEndDemandUnits,
  endDemandUnits,
  industrySizeFactors,
  launchCapacityPreview,
  marketCellWeight,
  marketCellsOf,
  nodeBalances,
  priceNodes,
  producibleUnits,
  segmentAppetite,
  sizeFactorFor,
  worldShifterFor,
} from './market';
export type { LaunchCapacityPreview, NodeBalance, WeightedCell } from './market';

export {
  SWITCH_QUALITY_FACTOR,
  admissibleSetFor,
  cellKey,
  cellOf,
  defaultIndustryFor,
  fillFor,
  fillsOf,
  resolveFill,
  resolveFills,
  slotAdmits,
  slotForInput,
  supplierAskFor,
  targetOf,
  withFill,
} from './slots';
export type { FillOverride, FillRoute, MarketCell, ResolvedFill, SupplierAsk } from './slots';

export {
  LICENCE_ROYALTY_BOUNDS,
  LICENCE_TERM_QUARTERS,
  LICENCE_UPFRONT_SHARE,
  NPC_LICENCE_GRUDGE_REFUSAL,
  NPC_LICENCE_ROYALTY_FLOOR_PCT,
  NPC_RIVAL_ROYALTY_MULTIPLE,
  boundedRoyaltyPct,
  dropLapsedLicences,
  grantLicence,
  isDirectRivalOnNode,
  lapsedLicencesOf,
  licenceFrom,
  licenceOfferOf,
  licenceUpfrontUsd,
  licenseesOf,
  nodeLicenceOf,
  nodeResearchMidUsd,
  npcLicenceVerdict,
  ownsNodeOutright,
} from './licensing';
export type { LicenceVerdict } from './licensing';

export {
  MAX_COST_DEPTH,
  OPEN_MARKET_PREMIUM,
  SUPPLIER_ASK_BOUNDS,
  inputLinesOf,
  lineIsBlocked,
  namedSupplierPriceUsd,
  openMarketPriceUsd,
  unitCostOf,
  unitCostOfProduct,
} from './cost';

export { DESCRIBED_SLOTS, describeLine, describeSource, industryWord, possessiveOf, proseLabel, targetPhrase, withArticle } from './describe';

export {
  MARKET_QUALITY,
  biggestCostSentence,
  costBreakdown,
  nodeEntryRoutes,
  nodeSellersFor,
  priceVerdict,
  slotOptions,
} from './options';
export type { CostBreakdownRow, InputRoute, InputRouteKind, MissingNodeRoute, NodeEntryRoutes, NodeSlotOptions, PriceVerdict, SlotCandidate } from './options';

export { chainNodeIds, neighbourhoodNodeIds, nodeMapFor, structuralWires } from './projection';
export type { NodeMapEntry, NodeMapView, NodeMapWire, NodeSupplyWire } from './projection';

export {
  BACKLOG_CARRY,
  BACKLOG_REPORT_UNITS,
  DEFAULT_LIFETIME_QUARTERS,
  INPUT_FILL_FLOOR,
  ORDER_BOOK_QUARTERS,
  QUALITY_DECAY,
  deliveredQuality,
  effectiveQuality,
  inputFillRatio,
  resolveNodeProduction,
} from './production';
export type { StagedLineInputs } from './production';

export {
  AGGRESSIVE_PRIVACY_DECAY_QUARTERS,
  AGGRESSIVE_PRIVACY_EXPOSURE,
  COLLECTION_MULTIPLE,
  DATA_DECAY,
  DATA_FLOOR,
  DATA_HALF_PB,
  DATA_PB_PER_UNIT,
  DATA_POLICY_CHURN,
  DATA_POLICY_REPUTATION,
  DATA_QUALITY_MAX,
  DATA_REPORT_PB,
  DATA_STORAGE_QUANTUM_PB,
  DEFAULT_DATA_PB_PER_UNIT,
  PRIVACY_DRAG,
  PRIVACY_HAZARD_FAMILY_ID,
  SEGMENT_DATA_WEIGHT,
  consumedPetabytes,
  dataAdequacy,
  dataEdgeOf,
  dataPetabytesOf,
  dataPolicyOf,
  dataQualityUplift,
  dataSelfSupplyShare,
  generatedPetabytes,
  isDataNode,
  petabytesPerUnit,
  privacyFactor,
  resolveNodeData,
  sellableDataUnits,
  totalDataPetabytes,
} from './data';

export {
  MATURITY_STATE,
  SECTOR_TRACK_SUMMARY,
  SECTOR_TRACK_TITLE,
  STATE_LADDER,
  isEconomicTechNode,
  nodeTechGraph,
  nodeTechNodes,
  nodeTechTracks,
  projectNode,
  stateAfterFirstAchievement,
  unlockedByNode,
} from './techGraph';
