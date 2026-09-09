/**
 * @frontier/contracts — world.ts
 *
 * The canonical world state: twelve domains of named numeric variables that
 * describe the AI economy every session shares.
 *
 * Rules of the road:
 * - The world is *numbers only*. Narrative lives in events, media stories and
 *   character dialogue; the world itself is a vector the engine can integrate.
 * - Every variable documents its unit and range in `.describe()`. Those strings
 *   are handed to the World Director LLM verbatim, so they read like a briefing
 *   note rather than a type annotation.
 * - Nothing in the world may be mutated by an LLM. The World Director proposes
 *   modifiers whose `target` must resolve against `WORLD_TARGET_PATHS` (or a
 *   registered pattern) and whose result is clamped to the registered bounds.
 * - Reference-market instruments (real securities) are *not* part of the world
 *   state and can never be targeted. Reality is not ours to modify.
 */

import { z } from 'zod';
import { bipolarUnit, unitInterval } from './ids';

/* -------------------------------------------------------------------------- */
/*  Domain 1 — Macro economy                                                   */
/* -------------------------------------------------------------------------- */

export const MacroDomainSchema = z
  .object({
    gdpGrowth: z
      .number()
      .min(-0.15)
      .max(0.15)
      .describe('Annualised real GDP growth as a fraction (0.024 = 2.4%). Range: -0.15..0.15. Recession below 0.'),
    inflation: z
      .number()
      .min(-0.05)
      .max(0.3)
      .describe('Annualised consumer inflation as a fraction (0.031 = 3.1%). Range: -0.05..0.30.'),
    policyRate: z
      .number()
      .min(0)
      .max(0.25)
      .describe('Central bank policy interest rate as a fraction (0.0525 = 5.25%). Range: 0..0.25. Drives debt cost and discount rates.'),
    unemployment: z
      .number()
      .min(0)
      .max(0.3)
      .describe('Unemployment rate as a fraction (0.042 = 4.2%). Range: 0..0.30.'),
    creditSpreads: z
      .number()
      .min(0)
      .max(0.2)
      .describe('Corporate credit spread over the policy rate as a fraction (0.018 = 180bp). Range: 0..0.20. Widening spreads make debt issuance expensive.'),
    fxVolatility: unitInterval('Volatility of major currency pairs. 0 is placid, 1 is a currency crisis.'),
    consumerDemand: unitInterval('Aggregate consumer appetite for paid software and devices. 0.5 is neutral.'),
  })
  .describe('Macro economy: growth, prices, rates, employment, credit and consumer demand.');
export type MacroDomain = z.infer<typeof MacroDomainSchema>;

/* -------------------------------------------------------------------------- */
/*  Domain 2 — Capital markets                                                 */
/* -------------------------------------------------------------------------- */

export const CapitalMarketsDomainSchema = z
  .object({
    riskAppetite: unitInterval('Investor willingness to fund unprofitable growth. 0 is risk-off, 1 is euphoric.'),
    ipoWindow: unitInterval('How open the public listing window is. Below 0.3 an IPO will usually fail or price badly.'),
    ventureLiquidity: unitInterval('Availability of private venture and growth capital. 0 is a funding winter.'),
    sectorMultiples: z
      .number()
      .min(0.2)
      .max(6)
      .describe('Multiplier applied to baseline valuation multiples across the AI sector. 1.0 is the long-run average; 2.5 is a bubble. Range: 0.2..6.'),
    volatility: unitInterval('Realised equity volatility regime. Feeds the noise term of the quarterly return model.'),
    debtAvailability: unitInterval('Willingness of lenders to extend corporate credit to AI companies. 0 means debt is effectively unavailable.'),
  })
  .describe('Capital markets: risk appetite, listing window, private liquidity, multiples, volatility and debt supply.');
export type CapitalMarketsDomain = z.infer<typeof CapitalMarketsDomainSchema>;

/* -------------------------------------------------------------------------- */
/*  Domain 3 — Compute                                                         */
/* -------------------------------------------------------------------------- */

export const ComputeDomainSchema = z
  .object({
    acceleratorSupply: unitInterval('Global supply of AI accelerators relative to baseline demand. Below 0.5 is a shortage; 1 is abundant.'),
    cloudCapacity: unitInterval('Available managed cloud inference and training capacity relative to demand.'),
    spotPrice: z
      .number()
      .min(0.1)
      .max(10)
      .describe('Spot price index for one accelerator-hour, where 1.0 is the session baseline. 1.24 means 24% above baseline. Range: 0.1..10.'),
    reservedPrice: z
      .number()
      .min(0.1)
      .max(10)
      .describe('Price index for multi-quarter reserved capacity, where 1.0 is the session baseline. Usually below spotPrice. Range: 0.1..10.'),
    fabCapacity: unitInterval('Leading-edge fabrication and advanced packaging capacity relative to demand. Slow-moving; shocks here take quarters to unwind.'),
    energyDemand: unitInterval('Share of grid capacity consumed by datacentre compute. High values create political and cost pressure.'),
  })
  .describe('Compute: accelerator supply, cloud capacity, spot and reserved pricing, fabrication capacity and energy draw.');
export type ComputeDomain = z.infer<typeof ComputeDomainSchema>;

/* -------------------------------------------------------------------------- */
/*  Domain 4 — Energy                                                          */
/* -------------------------------------------------------------------------- */

export const EnergyDomainSchema = z
  .object({
    electricityPrice: z
      .number()
      .min(0.1)
      .max(10)
      .describe('Industrial electricity price index, where 1.0 is the session baseline. Range: 0.1..10.'),
    datacentreAccess: unitInterval('Ease of securing new datacentre siting, interconnection and permits. 0 means new capacity cannot be built.'),
    renewableCapacity: unitInterval('Share of usable generation that is renewable or nuclear. Affects cost stability and public sentiment.'),
    gridConstraint: unitInterval('Severity of transmission and interconnection bottlenecks. 1 means the grid is the binding constraint on compute growth.'),
  })
  .describe('Energy: electricity cost, datacentre siting access, clean generation and grid constraints.');
export type EnergyDomain = z.infer<typeof EnergyDomainSchema>;

/* -------------------------------------------------------------------------- */
/*  Domain 5 — AI frontier                                                     */
/* -------------------------------------------------------------------------- */

export const AiFrontierDomainSchema = z
  .object({
    frontierCapability: unitInterval('Capability of the best publicly demonstrated model in the world. Monotonic in most sessions but can stall.'),
    inferenceCost: z
      .number()
      .min(0.01)
      .max(10)
      .describe('Cost index to serve a unit of frontier-quality inference, where 1.0 is the session baseline. Falls as efficiency improves. Range: 0.01..10.'),
    trainingEfficiency: unitInterval('How much capability a unit of compute buys. Rising efficiency reduces the advantage of raw scale.'),
    openSourceGap: unitInterval('Capability gap between the best closed model and the best open-weight model. 0 means open weights have caught up.'),
    benchmarkSaturation: unitInterval('How saturated public benchmarks are. High saturation weakens the marketing value of benchmark wins.'),
  })
  .describe('AI frontier: state of the art capability, serving cost, training efficiency, the open-weight gap and benchmark credibility.');
export type AiFrontierDomain = z.infer<typeof AiFrontierDomainSchema>;

/* -------------------------------------------------------------------------- */
/*  Domain 6 — Talent                                                          */
/* -------------------------------------------------------------------------- */

export const TalentDomainSchema = z
  .object({
    researcherSupply: unitInterval('Availability of frontier research talent relative to demand. Low values make poaching the only route.'),
    engineerSupply: unitInterval('Availability of senior infrastructure and product engineering talent relative to demand.'),
    salaryPressure: z
      .number()
      .min(0.3)
      .max(4)
      .describe('Compensation index for technical staff, where 1.0 is the session baseline. 1.4 means salaries run 40% hot. Range: 0.3..4.'),
    immigrationAccess: unitInterval('Ease of hiring across borders. Falls with geopolitical friction and restrictive policy.'),
  })
  .describe('Talent: supply of researchers and engineers, compensation pressure and cross-border hiring access.');
export type TalentDomain = z.infer<typeof TalentDomainSchema>;

/* -------------------------------------------------------------------------- */
/*  Domain 7 — Data                                                            */
/* -------------------------------------------------------------------------- */

export const DataDomainSchema = z
  .object({
    dataAvailability: unitInterval('Availability of high-quality training and evaluation data. Falls as publishers withdraw or litigate.'),
    licensingCost: z
      .number()
      .min(0.1)
      .max(10)
      .describe('Cost index for licensed data corpora, where 1.0 is the session baseline. Range: 0.1..10.'),
    privacyRestriction: unitInterval('Severity of privacy constraints on collecting and training. 1 means most personal data is off limits.'),
    syntheticDataMaturity: unitInterval('How well synthetic data substitutes for scarce real data. High values blunt data-scarcity shocks.'),
  })
  .describe('Data: corpus availability, licensing cost, privacy restrictions and the maturity of synthetic substitutes.');
export type DataDomain = z.infer<typeof DataDomainSchema>;

/* -------------------------------------------------------------------------- */
/*  Domain 8 — Society                                                         */
/* -------------------------------------------------------------------------- */

export const SocietyDomainSchema = z
  .object({
    aiTrust: unitInterval('General public trust in AI systems and the companies that build them.'),
    automationAnxiety: unitInterval('Public fear of AI-driven job displacement. High values feed regulation and hostile media.'),
    consumerSentiment: unitInterval('Consumer enthusiasm for buying AI products. Drives consumer-segment demand.'),
    developerSentiment: unitInterval('Developer community goodwill toward the industry. Drives API adoption and open-source contribution.'),
  })
  .describe('Society: public trust, automation anxiety, consumer enthusiasm and developer goodwill.');
export type SocietyDomain = z.infer<typeof SocietyDomainSchema>;

/* -------------------------------------------------------------------------- */
/*  Domain 9 — Regulation                                                      */
/* -------------------------------------------------------------------------- */

export const RegulationDomainSchema = z
  .object({
    modelRules: unitInterval('Stringency of rules governing frontier model training, evaluation and release. 0 is unregulated, 1 is licence-gated.'),
    privacy: unitInterval('Stringency of data protection and privacy enforcement.'),
    antitrust: unitInterval('Intensity of competition enforcement. High values block acquisitions and scrutinise concentration.'),
    copyright: unitInterval('Strength of copyright enforcement against training data use.'),
    safetyObligations: unitInterval('Weight of mandatory safety evaluation, audit and incident reporting obligations.'),
    exportControls: unitInterval('Severity of controls on exporting models, weights and accelerators across borders.'),
  })
  .describe('Regulation: model rules, privacy, antitrust, copyright, safety obligations and export controls.');
export type RegulationDomain = z.infer<typeof RegulationDomainSchema>;

/* -------------------------------------------------------------------------- */
/*  Domain 10 — Government                                                     */
/* -------------------------------------------------------------------------- */

export const GovernmentDomainSchema = z
  .object({
    procurementBudget: unitInterval('Size of the public AI procurement budget relative to the session baseline. Drives how many opportunities open each quarter.'),
    defenceUrgency: unitInterval('Political urgency behind defence and national-security AI programmes.'),
    digitalModernisation: unitInterval('Appetite for civilian digital modernisation programmes.'),
    grantFunding: unitInterval('Availability of non-dilutive research grants and co-funded programmes.'),
  })
  .describe('Government: procurement budget, defence urgency, civilian modernisation demand and grant funding.');
export type GovernmentDomain = z.infer<typeof GovernmentDomainSchema>;

/* -------------------------------------------------------------------------- */
/*  Domain 11 — Geopolitics                                                    */
/* -------------------------------------------------------------------------- */

export const GeopoliticsDomainSchema = z
  .object({
    tradeFriction: unitInterval('Tariffs, restrictions and non-tariff barriers affecting hardware and software trade.'),
    conflictRisk: unitInterval('Probability weight of active conflict disrupting supply chains and energy.'),
    sanctions: unitInterval('Breadth of sanctions regimes constraining who may buy, sell and partner.'),
    techCompetition: unitInterval('Intensity of strategic technology competition between blocs. Raises defence procurement and export controls together.'),
  })
  .describe('Geopolitics: trade friction, conflict risk, sanctions and strategic technology competition.');
export type GeopoliticsDomain = z.infer<typeof GeopoliticsDomainSchema>;

/* -------------------------------------------------------------------------- */
/*  Domain 12 — Media                                                          */
/* -------------------------------------------------------------------------- */

export const DOMINANT_NARRATIVES = [
  'ai_optimism',
  'productivity_miracle',
  'bubble_concern',
  'safety_alarm',
  'labour_disruption',
  'concentration_backlash',
  'geopolitical_race',
  'energy_backlash',
  'scandal_cycle',
  'neutral',
] as const;

export const DominantNarrativeSchema = z
  .enum(DOMINANT_NARRATIVES)
  .describe(
    'The single story the press is currently telling about the AI industry. It biases how every new event is interpreted: the same product launch reads as visionary under ai_optimism and reckless under safety_alarm.',
  );
export type DominantNarrative = z.infer<typeof DominantNarrativeSchema>;

export const MediaDomainSchema = z
  .object({
    attentionLevel: unitInterval('How much of the total news cycle the AI industry occupies. High attention amplifies both good and bad coverage.'),
    institutionalTrust: unitInterval('Public trust in institutions reporting on and regulating the industry. Low trust makes rumours travel further than corrections.'),
    controversyIntensity: unitInterval('Heat of the current controversy cycle. High values increase the chance that a leak becomes a press story.'),
    dominantNarrative: DominantNarrativeSchema,
  })
  .describe('Media: attention level, institutional trust, controversy intensity and the dominant narrative frame.');
export type MediaDomain = z.infer<typeof MediaDomainSchema>;

/* -------------------------------------------------------------------------- */
/*  World state                                                                */
/* -------------------------------------------------------------------------- */

export const WORLD_DOMAIN_KEYS = [
  'macro',
  'capitalMarkets',
  'compute',
  'energy',
  'aiFrontier',
  'talent',
  'dataDomain',
  'society',
  'regulation',
  'government',
  'geopolitics',
  'media',
] as const;
export type WorldDomainKey = (typeof WORLD_DOMAIN_KEYS)[number];

/**
 * The canonical world state: exactly twelve domains.
 *
 * This object is the shared reality of a session. Every player sees the same
 * world; what differs is what they *know* about companies inside it.
 */
export const WorldStateSchema = z
  .object({
    macro: MacroDomainSchema,
    capitalMarkets: CapitalMarketsDomainSchema,
    compute: ComputeDomainSchema,
    energy: EnergyDomainSchema,
    aiFrontier: AiFrontierDomainSchema,
    talent: TalentDomainSchema,
    dataDomain: DataDomainSchema,
    society: SocietyDomainSchema,
    regulation: RegulationDomainSchema,
    government: GovernmentDomainSchema,
    geopolitics: GeopoliticsDomainSchema,
    media: MediaDomainSchema,
  })
  .describe('The canonical twelve-domain world state shared by every participant in a session.');
export type WorldState = z.infer<typeof WorldStateSchema>;

/* -------------------------------------------------------------------------- */
/*  Sectors                                                                    */
/* -------------------------------------------------------------------------- */

export const SECTOR_IDS = [
  'semiconductors',
  'cloud_infrastructure',
  'frontier_models',
  'enterprise_software',
  'consumer_ai',
  'data_services',
  'defence_tech',
  'energy_infrastructure',
] as const;
export type SectorKey = (typeof SECTOR_IDS)[number];

export const SectorKeySchema = z.enum(SECTOR_IDS).describe('An industry sector used for sector betas, sentiment and valuation multiples.');

export const SectorStateSchema = z
  .object({
    sectorId: SectorKeySchema,
    sentiment: bipolarUnit('How investors currently feel about this sector, independent of fundamentals.'),
    multiple: z
      .number()
      .min(0.1)
      .max(10)
      .describe('Valuation multiple index for the sector, where 1.0 is the session baseline. Range: 0.1..10.'),
    demand: unitInterval('End-customer demand for this sector relative to the session baseline midpoint of 0.5.'),
    volatility: unitInterval('Sector-specific return volatility, feeding the sector beta term of the quarterly return model.'),
  })
  .describe('Per-sector market conditions. Sector sentiment is a legal World Director modifier target.');
export type SectorState = z.infer<typeof SectorStateSchema>;

/** Sector state keyed by sector id. Internal state — records are permitted here. */
export const SectorStateMapSchema = z
  .record(z.string(), SectorStateSchema)
  .describe('Sector state keyed by sector id. Keys should come from SECTOR_IDS.');
export type SectorStateMap = z.infer<typeof SectorStateMapSchema>;

/* -------------------------------------------------------------------------- */
/*  Modifier operations (declared here so world.ts stays dependency-free)      */
/* -------------------------------------------------------------------------- */

export const TARGET_OPERATIONS = ['add', 'multiply', 'set'] as const;
export const TargetOperationSchema = z
  .enum(TARGET_OPERATIONS)
  .describe(
    'How a modifier combines with the current value. "add" shifts by value (use for 0..1 variables), "multiply" scales by value (use for price and supply indices, where 1.24 means +24%), "set" overwrites (reserved for structural changes; the engine may reject it).',
  );
export type TargetOperation = z.infer<typeof TargetOperationSchema>;

/* -------------------------------------------------------------------------- */
/*  Target path registry                                                       */
/* -------------------------------------------------------------------------- */

/** Bounds and metadata for one legal modifier target. */
export interface TargetPathSpec {
  /** The dotted path itself, or the pattern template for pattern targets. */
  readonly path: string;
  /** Hard lower bound. The engine clamps to this; it never throws on overflow. */
  readonly min: number;
  /** Hard upper bound. */
  readonly max: number;
  /** Unit description, e.g. "normalised 0..1" or "index, 1.0 = baseline". */
  readonly unit: string;
  /** Which operations make sense on this path. */
  readonly operations: readonly TargetOperation[];
  /** One-line description used in World Director prompts. */
  readonly description: string;
}

const p = (
  path: string,
  min: number,
  max: number,
  unit: string,
  operations: readonly TargetOperation[],
  description: string,
): TargetPathSpec => ({ path, min, max, unit, operations, description });

const NORM = 'normalised 0..1';
const INDEX = 'index, 1.0 = session baseline';
const FRACTION = 'fraction, 0.045 = 4.5%';
const ADD_ONLY: readonly TargetOperation[] = ['add'];
const ADD_MUL: readonly TargetOperation[] = ['add', 'multiply'];
const MUL_ONLY: readonly TargetOperation[] = ['multiply'];

/**
 * Every legal fixed modifier target path, with the bounds the engine clamps to.
 *
 * The World Director must choose targets from this registry (or from
 * `PATTERN_TARGET_PATHS`). A proposal naming an unknown path is rejected whole;
 * a proposal naming a known path with an out-of-range result is clamped and the
 * clamp is recorded in the ledger.
 */
export const WORLD_TARGET_PATHS = {
  // Macro
  'world.macro.gdpGrowth': p('world.macro.gdpGrowth', -0.15, 0.15, FRACTION, ADD_ONLY, 'Annualised real GDP growth.'),
  'world.macro.inflation': p('world.macro.inflation', -0.05, 0.3, FRACTION, ADD_ONLY, 'Annualised consumer inflation.'),
  'world.macro.policyRate': p('world.macro.policyRate', 0, 0.25, FRACTION, ADD_ONLY, 'Central bank policy rate.'),
  'world.macro.unemployment': p('world.macro.unemployment', 0, 0.3, FRACTION, ADD_ONLY, 'Unemployment rate.'),
  'world.macro.creditSpreads': p('world.macro.creditSpreads', 0, 0.2, FRACTION, ADD_MUL, 'Corporate credit spread over the policy rate.'),
  'world.macro.fxVolatility': p('world.macro.fxVolatility', 0, 1, NORM, ADD_MUL, 'Major currency pair volatility.'),
  'world.macro.consumerDemand': p('world.macro.consumerDemand', 0, 1, NORM, ADD_MUL, 'Aggregate consumer appetite for paid software.'),

  // Capital markets
  'world.capitalMarkets.riskAppetite': p('world.capitalMarkets.riskAppetite', 0, 1, NORM, ADD_MUL, 'Investor willingness to fund unprofitable growth.'),
  'world.capitalMarkets.ipoWindow': p('world.capitalMarkets.ipoWindow', 0, 1, NORM, ADD_MUL, 'How open the public listing window is.'),
  'world.capitalMarkets.ventureLiquidity': p('world.capitalMarkets.ventureLiquidity', 0, 1, NORM, ADD_MUL, 'Availability of private venture and growth capital.'),
  'world.capitalMarkets.sectorMultiples': p('world.capitalMarkets.sectorMultiples', 0.2, 6, INDEX, MUL_ONLY, 'Economy-wide AI valuation multiple index.'),
  'world.capitalMarkets.volatility': p('world.capitalMarkets.volatility', 0, 1, NORM, ADD_MUL, 'Realised equity volatility regime.'),
  'world.capitalMarkets.debtAvailability': p('world.capitalMarkets.debtAvailability', 0, 1, NORM, ADD_MUL, 'Lender willingness to extend corporate credit.'),

  // Compute
  'world.compute.acceleratorSupply': p('world.compute.acceleratorSupply', 0, 1, NORM, ADD_MUL, 'Global AI accelerator supply relative to demand.'),
  'world.compute.cloudCapacity': p('world.compute.cloudCapacity', 0, 1, NORM, ADD_MUL, 'Available managed cloud capacity relative to demand.'),
  'world.compute.spotPrice': p('world.compute.spotPrice', 0.1, 10, INDEX, MUL_ONLY, 'Spot accelerator-hour price index.'),
  'world.compute.reservedPrice': p('world.compute.reservedPrice', 0.1, 10, INDEX, MUL_ONLY, 'Reserved capacity price index.'),
  'world.compute.fabCapacity': p('world.compute.fabCapacity', 0, 1, NORM, ADD_MUL, 'Leading-edge fabrication and packaging capacity.'),
  'world.compute.energyDemand': p('world.compute.energyDemand', 0, 1, NORM, ADD_MUL, 'Share of grid capacity consumed by datacentres.'),

  // Energy
  'world.energy.electricityPrice': p('world.energy.electricityPrice', 0.1, 10, INDEX, MUL_ONLY, 'Industrial electricity price index.'),
  'world.energy.datacentreAccess': p('world.energy.datacentreAccess', 0, 1, NORM, ADD_MUL, 'Ease of siting and interconnecting new datacentres.'),
  'world.energy.renewableCapacity': p('world.energy.renewableCapacity', 0, 1, NORM, ADD_MUL, 'Share of usable clean generation.'),
  'world.energy.gridConstraint': p('world.energy.gridConstraint', 0, 1, NORM, ADD_MUL, 'Severity of transmission bottlenecks.'),

  // AI frontier
  'world.aiFrontier.frontierCapability': p('world.aiFrontier.frontierCapability', 0, 1, NORM, ADD_ONLY, 'Capability of the best publicly demonstrated model.'),
  'world.aiFrontier.inferenceCost': p('world.aiFrontier.inferenceCost', 0.01, 10, INDEX, MUL_ONLY, 'Cost index to serve frontier-quality inference.'),
  'world.aiFrontier.trainingEfficiency': p('world.aiFrontier.trainingEfficiency', 0, 1, NORM, ADD_MUL, 'Capability bought per unit of training compute.'),
  'world.aiFrontier.openSourceGap': p('world.aiFrontier.openSourceGap', 0, 1, NORM, ADD_MUL, 'Capability gap between best closed and best open-weight model.'),
  'world.aiFrontier.benchmarkSaturation': p('world.aiFrontier.benchmarkSaturation', 0, 1, NORM, ADD_MUL, 'How saturated public benchmarks are.'),

  // Talent
  'world.talent.researcherSupply': p('world.talent.researcherSupply', 0, 1, NORM, ADD_MUL, 'Availability of frontier research talent.'),
  'world.talent.engineerSupply': p('world.talent.engineerSupply', 0, 1, NORM, ADD_MUL, 'Availability of senior engineering talent.'),
  'world.talent.salaryPressure': p('world.talent.salaryPressure', 0.3, 4, INDEX, MUL_ONLY, 'Technical compensation index.'),
  'world.talent.immigrationAccess': p('world.talent.immigrationAccess', 0, 1, NORM, ADD_MUL, 'Ease of cross-border hiring.'),

  // Data
  'world.dataDomain.dataAvailability': p('world.dataDomain.dataAvailability', 0, 1, NORM, ADD_MUL, 'Availability of high-quality training data.'),
  'world.dataDomain.licensingCost': p('world.dataDomain.licensingCost', 0.1, 10, INDEX, MUL_ONLY, 'Cost index for licensed data corpora.'),
  'world.dataDomain.privacyRestriction': p('world.dataDomain.privacyRestriction', 0, 1, NORM, ADD_MUL, 'Severity of privacy constraints on training data.'),
  'world.dataDomain.syntheticDataMaturity': p('world.dataDomain.syntheticDataMaturity', 0, 1, NORM, ADD_MUL, 'How well synthetic data substitutes for real data.'),

  // Society
  'world.society.aiTrust': p('world.society.aiTrust', 0, 1, NORM, ADD_MUL, 'Public trust in AI systems and their makers.'),
  'world.society.automationAnxiety': p('world.society.automationAnxiety', 0, 1, NORM, ADD_MUL, 'Public fear of AI-driven job displacement.'),
  'world.society.consumerSentiment': p('world.society.consumerSentiment', 0, 1, NORM, ADD_MUL, 'Consumer enthusiasm for AI products.'),
  'world.society.developerSentiment': p('world.society.developerSentiment', 0, 1, NORM, ADD_MUL, 'Developer community goodwill.'),

  // Regulation
  'world.regulation.modelRules': p('world.regulation.modelRules', 0, 1, NORM, ADD_MUL, 'Stringency of frontier model rules.'),
  'world.regulation.privacy': p('world.regulation.privacy', 0, 1, NORM, ADD_MUL, 'Stringency of privacy enforcement.'),
  'world.regulation.antitrust': p('world.regulation.antitrust', 0, 1, NORM, ADD_MUL, 'Intensity of competition enforcement.'),
  'world.regulation.copyright': p('world.regulation.copyright', 0, 1, NORM, ADD_MUL, 'Strength of copyright enforcement on training data.'),
  'world.regulation.safetyObligations': p('world.regulation.safetyObligations', 0, 1, NORM, ADD_MUL, 'Weight of mandatory safety and audit obligations.'),
  'world.regulation.exportControls': p('world.regulation.exportControls', 0, 1, NORM, ADD_MUL, 'Severity of export controls on models and hardware.'),

  // Government
  'world.government.procurementBudget': p('world.government.procurementBudget', 0, 1, NORM, ADD_MUL, 'Size of the public AI procurement budget.'),
  'world.government.defenceUrgency': p('world.government.defenceUrgency', 0, 1, NORM, ADD_MUL, 'Political urgency behind defence AI programmes.'),
  'world.government.digitalModernisation': p('world.government.digitalModernisation', 0, 1, NORM, ADD_MUL, 'Appetite for civilian modernisation programmes.'),
  'world.government.grantFunding': p('world.government.grantFunding', 0, 1, NORM, ADD_MUL, 'Availability of non-dilutive research grants.'),

  // Geopolitics
  'world.geopolitics.tradeFriction': p('world.geopolitics.tradeFriction', 0, 1, NORM, ADD_MUL, 'Tariffs and non-tariff barriers on technology trade.'),
  'world.geopolitics.conflictRisk': p('world.geopolitics.conflictRisk', 0, 1, NORM, ADD_MUL, 'Probability weight of supply-disrupting conflict.'),
  'world.geopolitics.sanctions': p('world.geopolitics.sanctions', 0, 1, NORM, ADD_MUL, 'Breadth of active sanctions regimes.'),
  'world.geopolitics.techCompetition': p('world.geopolitics.techCompetition', 0, 1, NORM, ADD_MUL, 'Intensity of strategic technology competition.'),

  // Media
  'world.media.attentionLevel': p('world.media.attentionLevel', 0, 1, NORM, ADD_MUL, 'Share of the news cycle occupied by AI.'),
  'world.media.institutionalTrust': p('world.media.institutionalTrust', 0, 1, NORM, ADD_MUL, 'Public trust in reporting and regulating institutions.'),
  'world.media.controversyIntensity': p('world.media.controversyIntensity', 0, 1, NORM, ADD_MUL, 'Heat of the current controversy cycle.'),
} as const satisfies Record<string, TargetPathSpec>;

/** The union of every fixed legal target path. */
export type WorldTargetPath = keyof typeof WORLD_TARGET_PATHS;

/** All fixed target paths as an array, for prompt rendering and validation. */
export const WORLD_TARGET_PATH_LIST = Object.keys(WORLD_TARGET_PATHS) as readonly WorldTargetPath[];

/**
 * Pattern targets. These take a runtime id segment, so they cannot be enumerated
 * at schema definition time. The engine matches the path against `regex` and
 * checks the captured id exists before applying anything.
 */
export interface PatternTargetSpec extends TargetPathSpec {
  /** Template with a `{placeholder}`, e.g. "sector.{sectorId}.sentiment". */
  readonly template: string;
  /** Regex the concrete path must match. Capture group 1 is the entity id. */
  readonly regex: RegExp;
  /** Which entity the capture refers to. */
  readonly entity: 'sector' | 'company';
  /** For company targets, the trailing metric segment. */
  readonly metric: string | null;
}

/** Metrics a `company.<companyId>.<metric>` modifier may address. */
export const COMPANY_TARGET_METRICS = [
  'reputationPublic',
  'reputationDeveloper',
  'reputationEnterprise',
  'reputationGovernment',
  'reputationInvestor',
  'demandMultiplier',
  'costMultiplier',
  'attritionRate',
  'valuationSentiment',
] as const;
export type CompanyTargetMetric = (typeof COMPANY_TARGET_METRICS)[number];

/** Metrics a `sector.<sectorId>.<metric>` modifier may address. */
export const SECTOR_TARGET_METRICS = ['sentiment', 'multiple', 'demand'] as const;
export type SectorTargetMetric = (typeof SECTOR_TARGET_METRICS)[number];

const companyMetricSpec = (
  metric: CompanyTargetMetric,
  min: number,
  max: number,
  unit: string,
  operations: readonly TargetOperation[],
  description: string,
): PatternTargetSpec => ({
  path: `company.{companyId}.${metric}`,
  template: `company.{companyId}.${metric}`,
  regex: new RegExp(`^company\\.([A-Za-z0-9_-]{1,128})\\.${metric}$`),
  entity: 'company',
  metric,
  min,
  max,
  unit,
  operations,
  description,
});

const sectorMetricSpec = (
  metric: SectorTargetMetric,
  min: number,
  max: number,
  unit: string,
  operations: readonly TargetOperation[],
  description: string,
): PatternTargetSpec => ({
  path: `sector.{sectorId}.${metric}`,
  template: `sector.{sectorId}.${metric}`,
  regex: new RegExp(`^sector\\.([A-Za-z0-9_-]{1,128})\\.${metric}$`),
  entity: 'sector',
  metric,
  min,
  max,
  unit,
  operations,
  description,
});

/**
 * Pattern target registry. Example concrete paths:
 * - `sector.semiconductors.sentiment`
 * - `company.cmp_nexus_ai.reputationPublic`
 */
export const PATTERN_TARGET_PATHS: readonly PatternTargetSpec[] = [
  sectorMetricSpec('sentiment', -1, 1, 'signed -1..1', ADD_ONLY, 'Investor sentiment toward one sector.'),
  sectorMetricSpec('multiple', 0.1, 10, INDEX, MUL_ONLY, 'Valuation multiple index for one sector.'),
  sectorMetricSpec('demand', 0, 1, NORM, ADD_MUL, 'End-customer demand for one sector.'),
  companyMetricSpec('reputationPublic', 0, 100, '0..100 score', ADD_ONLY, 'Public reputation of one company.'),
  companyMetricSpec('reputationDeveloper', 0, 100, '0..100 score', ADD_ONLY, 'Developer reputation of one company.'),
  companyMetricSpec('reputationEnterprise', 0, 100, '0..100 score', ADD_ONLY, 'Enterprise-buyer reputation of one company.'),
  companyMetricSpec('reputationGovernment', 0, 100, '0..100 score', ADD_ONLY, 'Government reputation of one company.'),
  companyMetricSpec('reputationInvestor', 0, 100, '0..100 score', ADD_ONLY, 'Investor reputation of one company.'),
  companyMetricSpec('demandMultiplier', 0.1, 5, INDEX, MUL_ONLY, 'Transient demand multiplier applied to one company.'),
  companyMetricSpec('costMultiplier', 0.1, 5, INDEX, MUL_ONLY, 'Transient cost multiplier applied to one company.'),
  companyMetricSpec('attritionRate', 0, 1, NORM, ADD_MUL, 'Quarterly staff attrition rate of one company.'),
  companyMetricSpec('valuationSentiment', -1, 1, 'signed -1..1', ADD_ONLY, 'Company-specific market sentiment premium or discount.'),
];

/**
 * Look up the bounds for a concrete target path, fixed or pattern.
 * Pure and deterministic; safe to call from the engine.
 * Returns `null` when the path is not a legal target at all.
 */
export function getTargetPathSpec(path: string): TargetPathSpec | null {
  const fixed = (WORLD_TARGET_PATHS as Record<string, TargetPathSpec | undefined>)[path];
  if (fixed !== undefined) return fixed;
  for (const spec of PATTERN_TARGET_PATHS) {
    if (spec.regex.test(path)) return spec;
  }
  return null;
}

/** The entity id embedded in a pattern target path, or `null` for fixed paths. */
export function targetPathEntityId(path: string): { entity: 'sector' | 'company'; id: string; metric: string } | null {
  for (const spec of PATTERN_TARGET_PATHS) {
    const m = spec.regex.exec(path);
    const captured = m?.[1];
    if (captured !== undefined && spec.metric !== null) {
      return { entity: spec.entity, id: captured, metric: spec.metric };
    }
  }
  return null;
}

/** True when `path` is a legal modifier target. */
export function isLegalTargetPath(path: string): boolean {
  return getTargetPathSpec(path) !== null;
}

/** Clamp a value into a target path's registered bounds. Pure. */
export function clampToTargetBounds(spec: TargetPathSpec, value: number): { value: number; clamped: boolean } {
  if (!Number.isFinite(value)) return { value: spec.min, clamped: true };
  if (value < spec.min) return { value: spec.min, clamped: true };
  if (value > spec.max) return { value: spec.max, clamped: true };
  return { value, clamped: false };
}

/* -------------------------------------------------------------------------- */
/*  Resolver signatures (implementations live in @frontier/simulation)         */
/* -------------------------------------------------------------------------- */

/**
 * The structural view a target-path resolver needs. The engine builds one of
 * these from `SessionState` — `world` and `sectors` come straight off the
 * session, and `companyMetrics` is a projection of the mutable per-company
 * numbers a modifier is allowed to touch.
 */
export interface TargetPathScope {
  readonly world: WorldState;
  readonly sectors: SectorStateMap;
  /** companyId -> metric name (see `COMPANY_TARGET_METRICS`) -> current value. */
  readonly companyMetrics: Readonly<Record<string, Readonly<Record<string, number>>>>;
}

/**
 * Read the current numeric value at a target path.
 * Returns `null` when the path is illegal or the referenced entity is missing.
 *
 * Implemented in `@frontier/simulation`; declared here so every package agrees
 * on the signature.
 */
export type ResolveTargetPathFn = (scope: TargetPathScope, path: string) => number | null;

/** The outcome of applying one modifier to one path. */
export interface TargetApplication {
  /** False when the path was illegal, the entity was missing, or the operation was not permitted. */
  readonly applied: boolean;
  readonly path: string;
  readonly before: number;
  readonly after: number;
  /** True when the registered bounds truncated the result. */
  readonly clamped: boolean;
  /** Human-readable reason when `applied` is false, or the clamp explanation. */
  readonly reason: string | null;
}

/**
 * Apply an operation to a target path, mutating `scope` in place and clamping
 * to the registered bounds. Never throws on an illegal path: it returns
 * `applied: false` with a reason so the caller can log a rejection to the ledger.
 *
 * Implemented in `@frontier/simulation`.
 */
export type ApplyToTargetPathFn = (
  scope: TargetPathScope,
  path: string,
  operation: TargetOperation,
  value: number,
) => TargetApplication;

/* -------------------------------------------------------------------------- */
/*  World summary (what the World Director actually reads)                     */
/* -------------------------------------------------------------------------- */

export const WorldVariableReadingSchema = z
  .object({
    path: z.string().describe('The target path this reading refers to, e.g. "world.compute.spotPrice".'),
    value: z.number().describe('Current value at that path.'),
    delta: z.number().describe('Change since the previous quarter, in the same units as value.'),
    label: z.string().describe('Short human label, e.g. "Compute spot price".'),
  })
  .describe('One line of the world digest handed to the World Director.');
export type WorldVariableReading = z.infer<typeof WorldVariableReadingSchema>;

/** Reference capital scale (USD) for a new founder at session start. */
export const BASELINE_SESSION_CAPITAL_USD = 4_000_000;
