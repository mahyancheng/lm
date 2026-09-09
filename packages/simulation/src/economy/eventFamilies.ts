/**
 * @frontier/simulation — economy/eventFamilies.ts
 *
 * The catalogue of the twenty-four world event families, exactly as specified in
 * `docs/WORLD_EVENTS.md` §2, expressed as data.
 *
 * Families are **data, not code**. Preconditions are `{path, op, value}` triples
 * the hazard engine evaluates through the target-path resolver; follow-on
 * hazards are `{familyId, hazardDelta, decayQuarters}` triples it pushes onto
 * other families when this one fires. Nothing in this file branches on a family
 * id, which is what lets a designer add a family in seed data without a deploy.
 *
 * Alongside the contract-shaped `EventFamily` each definition carries the
 * engine-side extras the schema has no room for:
 *
 * - `modifierTemplates` — the deterministic fallback consequences. When the
 *   World Director is unavailable (or declines a candidate), `materialiseCandidate`
 *   turns these into real modifiers at the drawn severity, so an LLM outage is a
 *   quarter with less character rather than a quarter with no weather.
 * - `suggestedTargetPaths` / `affectedSectorIds` — advisory context handed to the
 *   model in the candidate skeleton.
 * - `bidirectional` — the two families (`fam_macro_cycle`, `fam_capital_rotation`,
 *   `fam_ipo_window`) that fire in both directions with equal weight. An
 *   expansion is as much an event as a contraction.
 * - `companyScope` — how the engine picks the subject of a company-scoped family.
 *
 * Base hazards across the catalogue sum to 1.94, so an unfiltered draw averages
 * roughly two families per quarter; preconditions, cooldowns and incompatibility
 * typically reduce that to 1.2–1.6 and the impact budget caps the rest.
 */

import type { EventFamily, ModifierDecay, SectorKey, TargetOperation } from '@frontier/contracts';

/* -------------------------------------------------------------------------- */
/*  Definition shape                                                           */
/* -------------------------------------------------------------------------- */

/**
 * One deterministic consequence of a family firing.
 *
 * `low` is the operand at the bottom of the family's severity range and `high`
 * the operand at the top; the engine interpolates linearly between them on the
 * drawn severity. For `multiply` operations both numbers are ratios (0.84 is a
 * 16% fall); for `add` they are shifts in the target path's own units.
 */
export interface ModifierTemplate {
  /** Target path. `{sectorId}` and `{companyId}` are filled in by the engine. */
  readonly target: string;
  readonly operation: TargetOperation;
  readonly low: number;
  readonly high: number;
  readonly decay: ModifierDecay;
  readonly durationQuarters: number;
  readonly reason: string;
}

/** How the engine chooses the company a company-scoped family lands on. */
export type CompanyScopeRule =
  /** Not company scoped. */
  | 'none'
  /** By concentration: the largest, most acquisitive company in a strategic segment. */
  | 'concentration'
  /**
   * By exposure: thin operations headcount against serving load, weak public
   * standing, stretched utilisation. The event is public; the reason the company
   * was selected never is.
   */
  | 'incident';

export interface EventFamilyDefinition {
  readonly family: EventFamily;
  /** World paths this family usually moves. Advisory context for the World Director. */
  readonly suggestedTargetPaths: readonly string[];
  /** Sectors the engine expects to be affected. */
  readonly affectedSectorIds: readonly SectorKey[];
  /** Deterministic fallback consequences, applied at the drawn severity. */
  readonly modifierTemplates: readonly ModifierTemplate[];
  /** True when the family fires in both directions with equal weight. */
  readonly bidirectional: boolean;
  readonly companyScope: CompanyScopeRule;
}

/* -------------------------------------------------------------------------- */
/*  Builders                                                                   */
/* -------------------------------------------------------------------------- */

const mul = (
  target: string,
  low: number,
  high: number,
  decay: ModifierDecay,
  durationQuarters: number,
  reason: string,
): ModifierTemplate => ({ target, operation: 'multiply', low, high, decay, durationQuarters, reason });

const add = (
  target: string,
  low: number,
  high: number,
  decay: ModifierDecay,
  durationQuarters: number,
  reason: string,
): ModifierTemplate => ({ target, operation: 'add', low, high, decay, durationQuarters, reason });

/* -------------------------------------------------------------------------- */
/*  Catalogue                                                                  */
/* -------------------------------------------------------------------------- */

export const EVENT_FAMILY_DEFINITIONS: readonly EventFamilyDefinition[] = [
  /* --------------------------------- Compute -------------------------------- */
  {
    family: {
      id: 'fam_compute_supply',
      label: 'Accelerator supply disruption',
      description:
        'Accelerator supply tightens: an allocation cut, a logistics failure, a component shortage or a large buyer pre-empting the queue. Scarcity shows up first in the spot price and last in delivered capacity.',
      category: 'compute',
      allowedTypes: ['compute_supply_shock', 'supply_chain_disruption'],
      baseHazard: 0.1,
      preconditions: [],
      followOnHazards: [
        { familyId: 'fam_fab_capacity', hazardDelta: 0.15, decayQuarters: 4 },
        { familyId: 'fam_procurement_programme', hazardDelta: 0.08, decayQuarters: 6 },
      ],
      cooldownQuarters: 4,
      incompatibleFamilyIds: ['fam_compute_demand'],
      severityRange: [0.25, 0.8],
      defaultVisibility: 'public',
      defaultDurationQuarters: 3,
      weight: 1.2,
    },
    suggestedTargetPaths: [
      'world.compute.acceleratorSupply',
      'world.compute.spotPrice',
      'world.compute.cloudCapacity',
      'sector.semiconductors.sentiment',
    ],
    affectedSectorIds: ['semiconductors', 'cloud_infrastructure', 'frontier_models'],
    modifierTemplates: [
      mul('world.compute.acceleratorSupply', 0.95, 0.8, 'linear', 3, 'Allocations are cut and deliveries slip, so usable supply falls.'),
      mul('world.compute.spotPrice', 1.1, 1.35, 'linear', 3, 'Buyers bid for the capacity that did arrive, lifting the spot price.'),
      mul('world.compute.cloudCapacity', 0.97, 0.9, 'linear', 3, 'Managed capacity is rationed as operators protect committed customers.'),
      add('sector.semiconductors.sentiment', 0.05, 0.15, 'exponential', 3, 'Scarcity is good news for anyone who sells the scarce thing.'),
    ],
    bidirectional: false,
    companyScope: 'none',
  },
  {
    family: {
      id: 'fam_fab_capacity',
      label: 'Leading-edge fabrication and packaging disruption',
      description:
        'Leading-edge fabrication or advanced packaging capacity is disrupted. Slow-moving: shocks here take quarters to unwind, which is exactly what makes long compute reservations valuable insurance.',
      category: 'compute',
      allowedTypes: ['fab_disruption'],
      baseHazard: 0.06,
      preconditions: [{ path: 'world.compute.fabCapacity', op: 'gt', value: 0.25 }],
      followOnHazards: [
        { familyId: 'fam_compute_supply', hazardDelta: 0.3, decayQuarters: 4 },
        { familyId: 'fam_export_control', hazardDelta: 0.12, decayQuarters: 8 },
        { familyId: 'fam_procurement_programme', hazardDelta: 0.1, decayQuarters: 8 },
      ],
      cooldownQuarters: 8,
      incompatibleFamilyIds: [],
      severityRange: [0.35, 0.9],
      defaultVisibility: 'public',
      defaultDurationQuarters: 6,
      weight: 1,
    },
    suggestedTargetPaths: [
      'world.compute.fabCapacity',
      'world.compute.acceleratorSupply',
      'sector.semiconductors.multiple',
      'world.geopolitics.techCompetition',
    ],
    affectedSectorIds: ['semiconductors', 'cloud_infrastructure'],
    modifierTemplates: [
      mul('world.compute.fabCapacity', 0.92, 0.75, 'linear', 6, 'Leading-edge capacity is offline and cannot be replaced inside a year.'),
      mul('world.compute.acceleratorSupply', 0.96, 0.88, 'linear', 6, 'Fewer finished parts reach buyers as packaging throughput falls.'),
      mul('sector.semiconductors.multiple', 0.95, 0.85, 'linear', 6, 'The market reprices the sector on constrained throughput.'),
      add('world.geopolitics.techCompetition', 0.05, 0.12, 'none', 6, 'A fragile chokepoint sharpens strategic competition over it.'),
    ],
    bidirectional: false,
    companyScope: 'none',
  },
  {
    family: {
      id: 'fam_compute_demand',
      label: 'Training demand surge',
      description: 'A wave of large training runs is committed at once, and every buyer discovers how thin the marginal capacity really is.',
      category: 'compute',
      allowedTypes: ['compute_demand_shock'],
      baseHazard: 0.09,
      preconditions: [{ path: 'world.capitalMarkets.riskAppetite', op: 'gt', value: 0.55 }],
      followOnHazards: [
        { familyId: 'fam_energy_price', hazardDelta: 0.15, decayQuarters: 4 },
        { familyId: 'fam_grid_constraint', hazardDelta: 0.12, decayQuarters: 6 },
      ],
      cooldownQuarters: 3,
      incompatibleFamilyIds: ['fam_compute_supply'],
      severityRange: [0.2, 0.6],
      defaultVisibility: 'public',
      defaultDurationQuarters: 2,
      weight: 1,
    },
    suggestedTargetPaths: [
      'world.compute.spotPrice',
      'world.compute.reservedPrice',
      'world.compute.energyDemand',
      'sector.cloud_infrastructure.demand',
    ],
    affectedSectorIds: ['cloud_infrastructure', 'frontier_models', 'energy_infrastructure'],
    modifierTemplates: [
      mul('world.compute.spotPrice', 1.08, 1.25, 'exponential', 2, 'Simultaneous training commitments bid up on-demand capacity.'),
      mul('world.compute.reservedPrice', 1.04, 1.15, 'linear', 3, 'Reservation terms reprice as operators sell forward into the surge.'),
      add('world.compute.energyDemand', 0.03, 0.1, 'linear', 3, 'Sustained training draws a larger share of grid capacity.'),
      add('sector.cloud_infrastructure.demand', 0.03, 0.1, 'linear', 2, 'Everyone who cannot build capacity rents it instead.'),
    ],
    bidirectional: false,
    companyScope: 'none',
  },

  /* --------------------------------- Energy --------------------------------- */
  {
    family: {
      id: 'fam_energy_price',
      label: 'Industrial electricity price shock',
      description: 'Industrial power prices move sharply, and every inference-serving cost model moves with them.',
      category: 'energy',
      allowedTypes: ['energy_price_shock'],
      baseHazard: 0.08,
      preconditions: [],
      followOnHazards: [
        { familyId: 'fam_public_backlash', hazardDelta: 0.1, decayQuarters: 4 },
        { familyId: 'fam_grid_constraint', hazardDelta: 0.1, decayQuarters: 4 },
      ],
      cooldownQuarters: 4,
      incompatibleFamilyIds: [],
      severityRange: [0.2, 0.75],
      defaultVisibility: 'public',
      defaultDurationQuarters: 4,
      weight: 1,
    },
    suggestedTargetPaths: [
      'world.energy.electricityPrice',
      'world.compute.spotPrice',
      'world.aiFrontier.inferenceCost',
      'sector.energy_infrastructure.sentiment',
    ],
    affectedSectorIds: ['energy_infrastructure', 'cloud_infrastructure', 'frontier_models'],
    modifierTemplates: [
      mul('world.energy.electricityPrice', 1.1, 1.4, 'linear', 4, 'Industrial tariffs reset upward across the interconnection.'),
      mul('world.compute.spotPrice', 1.03, 1.12, 'linear', 4, 'Operators pass power costs through to on-demand pricing.'),
      mul('world.aiFrontier.inferenceCost', 1.04, 1.15, 'linear', 4, 'Serving a unit of frontier inference costs more energy-adjusted dollars.'),
      add('sector.energy_infrastructure.sentiment', 0.04, 0.12, 'exponential', 4, 'Generation and grid assets reprice upward on scarcity.'),
    ],
    bidirectional: false,
    companyScope: 'none',
  },
  {
    family: {
      id: 'fam_grid_constraint',
      label: 'Grid interconnection and siting freeze',
      description: 'Interconnection queues stall and new datacentre siting is refused or deferred. The grid, not capital, becomes the binding constraint on compute growth.',
      category: 'energy',
      allowedTypes: ['grid_constraint', 'infrastructure_outage'],
      baseHazard: 0.07,
      preconditions: [{ path: 'world.compute.energyDemand', op: 'gt', value: 0.55 }],
      followOnHazards: [
        { familyId: 'fam_public_backlash', hazardDelta: 0.12, decayQuarters: 6 },
        { familyId: 'fam_procurement_programme', hazardDelta: 0.08, decayQuarters: 8 },
      ],
      cooldownQuarters: 6,
      incompatibleFamilyIds: [],
      severityRange: [0.25, 0.7],
      defaultVisibility: 'public',
      defaultDurationQuarters: 6,
      weight: 1,
    },
    suggestedTargetPaths: [
      'world.energy.gridConstraint',
      'world.energy.datacentreAccess',
      'world.compute.cloudCapacity',
      'world.energy.electricityPrice',
    ],
    affectedSectorIds: ['energy_infrastructure', 'cloud_infrastructure'],
    modifierTemplates: [
      add('world.energy.gridConstraint', 0.08, 0.2, 'none', 6, 'Interconnection queues lengthen and transmission upgrades slip.'),
      mul('world.energy.datacentreAccess', 0.95, 0.82, 'none', 6, 'New siting and permitting decisions are deferred.'),
      mul('world.compute.cloudCapacity', 0.97, 0.9, 'linear', 6, 'Capacity that cannot be energised cannot be sold.'),
      mul('world.energy.electricityPrice', 1.04, 1.14, 'linear', 6, 'Congestion pricing lifts delivered power costs.'),
    ],
    bidirectional: false,
    companyScope: 'none',
  },

  /* ---------------------------------- Macro --------------------------------- */
  {
    family: {
      id: 'fam_macro_cycle',
      label: 'Macro regime shift',
      description:
        'The macroeconomic regime turns. The only family that fires in both directions with equal weight: an expansion is as much an event as a contraction.',
      category: 'macro',
      allowedTypes: ['macro_shift'],
      baseHazard: 0.12,
      preconditions: [],
      followOnHazards: [
        { familyId: 'fam_capital_rotation', hazardDelta: 0.2, decayQuarters: 4 },
        { familyId: 'fam_credit_event', hazardDelta: 0.1, decayQuarters: 6 },
      ],
      cooldownQuarters: 3,
      incompatibleFamilyIds: [],
      severityRange: [0.15, 0.7],
      defaultVisibility: 'public',
      defaultDurationQuarters: 4,
      weight: 1.4,
    },
    suggestedTargetPaths: [
      'world.macro.gdpGrowth',
      'world.macro.inflation',
      'world.macro.policyRate',
      'world.macro.unemployment',
      'world.macro.consumerDemand',
    ],
    affectedSectorIds: [],
    modifierTemplates: [
      add('world.macro.gdpGrowth', 0.005, 0.02, 'linear', 4, 'Output growth shifts as the regime turns.'),
      add('world.macro.inflation', 0.002, 0.008, 'linear', 4, 'Price pressure follows the demand impulse.'),
      add('world.macro.policyRate', 0.0025, 0.015, 'none', 4, 'The central bank responds to the change in conditions.'),
      add('world.macro.unemployment', -0.002, -0.01, 'linear', 4, 'Labour demand moves with output.'),
      add('world.macro.consumerDemand', 0.02, 0.06, 'linear', 4, 'Households adjust discretionary software and device spending.'),
    ],
    bidirectional: true,
    companyScope: 'none',
  },
  {
    family: {
      id: 'fam_credit_event',
      label: 'Credit event and spread blowout',
      description:
        'A borrower fails and corporate spreads gap wider. The standard route from "aggressive leveraged rival" to "distressed acquisition target".',
      category: 'macro',
      allowedTypes: ['credit_event'],
      baseHazard: 0.05,
      preconditions: [{ path: 'world.macro.creditSpreads', op: 'gt', value: 0.02 }],
      followOnHazards: [
        { familyId: 'fam_fund_collapse', hazardDelta: 0.18, decayQuarters: 6 },
        { familyId: 'fam_ipo_window', hazardDelta: 0.15, decayQuarters: 6 },
        { familyId: 'fam_capital_rotation', hazardDelta: 0.15, decayQuarters: 4 },
      ],
      cooldownQuarters: 8,
      incompatibleFamilyIds: [],
      severityRange: [0.35, 0.85],
      defaultVisibility: 'public',
      defaultDurationQuarters: 5,
      weight: 1,
    },
    suggestedTargetPaths: [
      'world.macro.creditSpreads',
      'world.capitalMarkets.debtAvailability',
      'world.capitalMarkets.riskAppetite',
      'world.capitalMarkets.sectorMultiples',
    ],
    affectedSectorIds: [],
    modifierTemplates: [
      mul('world.macro.creditSpreads', 1.3, 2, 'linear', 5, 'Corporate spreads gap wider as lenders reprice risk.'),
      mul('world.capitalMarkets.debtAvailability', 0.9, 0.7, 'linear', 5, 'Lenders withdraw from new AI credit.'),
      mul('world.capitalMarkets.riskAppetite', 0.92, 0.75, 'exponential', 4, 'Investors rotate out of unprofitable growth.'),
      mul('world.capitalMarkets.sectorMultiples', 0.95, 0.8, 'linear', 5, 'Higher discount rates compress every multiple in the sector.'),
    ],
    bidirectional: false,
    companyScope: 'none',
  },

  /* ----------------------------- Capital markets ---------------------------- */
  {
    family: {
      id: 'fam_capital_rotation',
      label: 'Risk-appetite rotation',
      description: 'Capital rotates into or out of unprofitable growth. Multiples, liquidity and volatility all move together.',
      category: 'capital',
      allowedTypes: ['capital_market_shift'],
      baseHazard: 0.13,
      preconditions: [],
      followOnHazards: [{ familyId: 'fam_ipo_window', hazardDelta: 0.15, decayQuarters: 3 }],
      cooldownQuarters: 2,
      incompatibleFamilyIds: [],
      severityRange: [0.15, 0.65],
      defaultVisibility: 'public',
      defaultDurationQuarters: 3,
      weight: 1.3,
    },
    suggestedTargetPaths: [
      'world.capitalMarkets.riskAppetite',
      'world.capitalMarkets.sectorMultiples',
      'world.capitalMarkets.volatility',
      'world.capitalMarkets.ventureLiquidity',
    ],
    affectedSectorIds: [],
    modifierTemplates: [
      add('world.capitalMarkets.riskAppetite', 0.03, 0.12, 'exponential', 3, 'Allocators change their willingness to fund growth ahead of profit.'),
      mul('world.capitalMarkets.sectorMultiples', 1.05, 1.25, 'linear', 3, 'The whole sector reprices with the rotation.'),
      add('world.capitalMarkets.volatility', -0.02, -0.08, 'linear', 3, 'Realised volatility moves inversely with the rotation.'),
      add('world.capitalMarkets.ventureLiquidity', 0.03, 0.1, 'linear', 3, 'Private capital follows public risk appetite with a short lag.'),
    ],
    bidirectional: true,
    companyScope: 'none',
  },
  {
    family: {
      id: 'fam_fund_collapse',
      label: 'Major venture fund fails',
      description:
        'A large venture or growth fund fails or suspends deployment. Late-stage private companies whose runway falls below four quarters begin looking for bridge rounds, and acquisition opportunities multiply.',
      category: 'capital',
      allowedTypes: ['fund_collapse'],
      baseHazard: 0.05,
      preconditions: [{ path: 'world.capitalMarkets.ventureLiquidity', op: 'lt', value: 0.55 }],
      followOnHazards: [
        { familyId: 'fam_capital_rotation', hazardDelta: 0.15, decayQuarters: 4 },
        { familyId: 'fam_ipo_window', hazardDelta: 0.12, decayQuarters: 6 },
      ],
      cooldownQuarters: 10,
      incompatibleFamilyIds: ['fam_ipo_window'],
      severityRange: [0.3, 0.75],
      defaultVisibility: 'public',
      defaultDurationQuarters: 4,
      weight: 1.1,
    },
    suggestedTargetPaths: [
      'world.capitalMarkets.ventureLiquidity',
      'world.capitalMarkets.riskAppetite',
      'sector.frontier_models.multiple',
    ],
    affectedSectorIds: ['frontier_models', 'enterprise_software', 'consumer_ai'],
    modifierTemplates: [
      mul('world.capitalMarkets.ventureLiquidity', 0.9, 0.7, 'linear', 4, 'A large source of private capital stops deploying.'),
      mul('world.capitalMarkets.riskAppetite', 0.95, 0.85, 'exponential', 3, 'Limited partners reassess the whole asset class.'),
      mul('sector.frontier_models.multiple', 0.95, 0.85, 'linear', 4, 'The most capital-hungry sector reprices first.'),
    ],
    bidirectional: false,
    companyScope: 'none',
  },
  {
    family: {
      id: 'fam_ipo_window',
      label: 'Listing window swings',
      description: 'The public listing window opens or closes. Below 0.3 an IPO will usually fail or price badly.',
      category: 'capital',
      allowedTypes: ['ipo_window_change'],
      baseHazard: 0.08,
      preconditions: [],
      followOnHazards: [],
      cooldownQuarters: 4,
      incompatibleFamilyIds: ['fam_fund_collapse'],
      severityRange: [0.15, 0.6],
      defaultVisibility: 'public',
      defaultDurationQuarters: 4,
      weight: 1,
    },
    suggestedTargetPaths: [
      'world.capitalMarkets.ipoWindow',
      'world.capitalMarkets.sectorMultiples',
      'world.capitalMarkets.volatility',
    ],
    affectedSectorIds: [],
    modifierTemplates: [
      add('world.capitalMarkets.ipoWindow', 0.05, 0.18, 'linear', 4, 'Underwriters reopen or close the listing calendar.'),
      mul('world.capitalMarkets.sectorMultiples', 1.03, 1.12, 'linear', 4, 'Comparable pricing follows the window.'),
      add('world.capitalMarkets.volatility', -0.02, -0.06, 'linear', 4, 'A predictable calendar dampens realised volatility.'),
    ],
    bidirectional: true,
    companyScope: 'none',
  },

  /* -------------------------------- Regulation ------------------------------ */
  {
    family: {
      id: 'fam_model_regulation',
      label: 'Frontier model rulemaking',
      description:
        'New rules govern frontier training, evaluation or release. Uses step-change modifiers far more often than other families: a rule holds for its duration rather than fading like a shock.',
      category: 'regulation',
      allowedTypes: ['regulatory_action', 'standards_change'],
      baseHazard: 0.1,
      preconditions: [{ path: 'world.society.aiTrust', op: 'lt', value: 0.7 }],
      followOnHazards: [
        { familyId: 'fam_public_backlash', hazardDelta: 0.08, decayQuarters: 4 },
        { familyId: 'fam_procurement_programme', hazardDelta: 0.06, decayQuarters: 6 },
      ],
      cooldownQuarters: 6,
      incompatibleFamilyIds: [],
      severityRange: [0.2, 0.75],
      defaultVisibility: 'public',
      defaultDurationQuarters: 8,
      weight: 1.2,
    },
    suggestedTargetPaths: [
      'world.regulation.modelRules',
      'world.regulation.safetyObligations',
      'sector.frontier_models.multiple',
      'world.media.attentionLevel',
    ],
    affectedSectorIds: ['frontier_models', 'enterprise_software'],
    modifierTemplates: [
      add('world.regulation.modelRules', 0.05, 0.2, 'none', 8, 'A new rule raises the bar for training, evaluation and release.'),
      add('world.regulation.safetyObligations', 0.03, 0.12, 'none', 8, 'Mandatory evaluation, audit and incident reporting expand.'),
      mul('sector.frontier_models.multiple', 0.97, 0.88, 'linear', 6, 'Compliance cost and release risk compress laboratory multiples.'),
      add('world.media.attentionLevel', 0.03, 0.1, 'exponential', 3, 'Rulemaking pulls the industry back into the news cycle.'),
    ],
    bidirectional: false,
    companyScope: 'none',
  },
  {
    family: {
      id: 'fam_antitrust',
      label: 'Antitrust investigation',
      description:
        'A competition authority opens an investigation. Company-scoped: the engine picks the subject by concentration — the largest share of a strategically important segment, weighted by recent acquisition activity. This is the family that punishes a consolidation strategy.',
      category: 'regulation',
      allowedTypes: ['antitrust_investigation'],
      baseHazard: 0.05,
      preconditions: [{ path: 'world.regulation.antitrust', op: 'gt', value: 0.25 }],
      followOnHazards: [{ familyId: 'fam_public_backlash', hazardDelta: 0.12, decayQuarters: 4 }],
      cooldownQuarters: 8,
      incompatibleFamilyIds: [],
      severityRange: [0.25, 0.7],
      defaultVisibility: 'public',
      defaultDurationQuarters: 6,
      weight: 1,
    },
    suggestedTargetPaths: [
      'world.regulation.antitrust',
      'company.{companyId}.reputationPublic',
      'company.{companyId}.valuationSentiment',
      'world.capitalMarkets.sectorMultiples',
    ],
    affectedSectorIds: [],
    modifierTemplates: [
      add('world.regulation.antitrust', 0.03, 0.1, 'none', 6, 'Enforcement intensity rises across the industry, not only at the subject.'),
      add('company.{companyId}.reputationPublic', -4, -12, 'linear', 6, 'A named investigation damages public standing while it runs.'),
      add('company.{companyId}.valuationSentiment', -0.05, -0.2, 'linear', 6, 'Investors discount a company whose strategy may be unwound.'),
      mul('world.capitalMarkets.sectorMultiples', 0.98, 0.93, 'linear', 4, 'Consolidation-dependent valuations are marked down.'),
    ],
    bidirectional: false,
    companyScope: 'concentration',
  },
  {
    family: {
      id: 'fam_ip_data_ruling',
      label: 'Copyright, privacy or litigation ruling',
      description: 'A court or regulator rules on training data, and the cost of legitimate corpora resets.',
      category: 'regulation',
      allowedTypes: ['copyright_ruling', 'privacy_enforcement', 'litigation'],
      baseHazard: 0.06,
      preconditions: [],
      followOnHazards: [{ familyId: 'fam_data_licensing', hazardDelta: 0.2, decayQuarters: 6 }],
      cooldownQuarters: 6,
      incompatibleFamilyIds: [],
      severityRange: [0.2, 0.7],
      defaultVisibility: 'public',
      defaultDurationQuarters: 8,
      weight: 1,
    },
    suggestedTargetPaths: [
      'world.regulation.copyright',
      'world.regulation.privacy',
      'world.dataDomain.dataAvailability',
      'world.dataDomain.licensingCost',
    ],
    affectedSectorIds: ['data_services', 'frontier_models'],
    modifierTemplates: [
      add('world.regulation.copyright', 0.03, 0.12, 'none', 8, 'The ruling strengthens enforcement against unlicensed training use.'),
      add('world.regulation.privacy', 0.02, 0.09, 'none', 8, 'Personal-data handling obligations are read more strictly.'),
      mul('world.dataDomain.dataAvailability', 0.96, 0.85, 'linear', 8, 'Publishers withdraw corpora rather than risk exposure.'),
      mul('world.dataDomain.licensingCost', 1.15, 1.6, 'linear', 8, 'Licensed corpora reprice now that the alternative is litigation.'),
    ],
    bidirectional: false,
    companyScope: 'none',
  },
  {
    family: {
      id: 'fam_export_control',
      label: 'Export control tightening',
      description:
        'Controls on exporting models, weights or accelerators tighten. Also flips export restrictions on new defence awards, which can conflict directly with a company\'s commercial customers.',
      category: 'regulation',
      allowedTypes: ['export_control'],
      baseHazard: 0.07,
      preconditions: [{ path: 'world.geopolitics.techCompetition', op: 'gt', value: 0.4 }],
      followOnHazards: [
        { familyId: 'fam_compute_supply', hazardDelta: 0.2, decayQuarters: 6 },
        { familyId: 'fam_trade_dispute', hazardDelta: 0.15, decayQuarters: 6 },
        { familyId: 'fam_procurement_programme', hazardDelta: 0.1, decayQuarters: 8 },
      ],
      cooldownQuarters: 6,
      incompatibleFamilyIds: [],
      severityRange: [0.3, 0.85],
      defaultVisibility: 'public',
      defaultDurationQuarters: 8,
      weight: 1.1,
    },
    suggestedTargetPaths: [
      'world.regulation.exportControls',
      'world.compute.acceleratorSupply',
      'world.talent.immigrationAccess',
      'sector.semiconductors.demand',
    ],
    affectedSectorIds: ['semiconductors', 'frontier_models', 'defence_tech'],
    modifierTemplates: [
      add('world.regulation.exportControls', 0.08, 0.25, 'none', 8, 'Licensing requirements are extended to more models and parts.'),
      mul('world.compute.acceleratorSupply', 0.95, 0.85, 'linear', 8, 'Controlled parts cannot reach a share of the market.'),
      add('world.talent.immigrationAccess', -0.03, -0.1, 'none', 8, 'Screening tightens around researchers from restricted jurisdictions.'),
      add('sector.semiconductors.demand', -0.03, -0.1, 'linear', 6, 'Addressable demand shrinks with the restricted geography.'),
    ],
    bidirectional: false,
    companyScope: 'none',
  },

  /* ------------------------------- Geopolitics ------------------------------ */
  {
    family: {
      id: 'fam_geopolitical_escalation',
      label: 'Strategic escalation',
      description:
        'The canonical cascade root. Its own modifiers are modest; its follow-on hazards are the largest in the catalogue, which is precisely how one root cause produces several correlated events over the following two years.',
      category: 'geopolitics',
      allowedTypes: ['geopolitical_escalation', 'sanctions_change'],
      baseHazard: 0.06,
      preconditions: [],
      followOnHazards: [
        { familyId: 'fam_energy_price', hazardDelta: 0.25, decayQuarters: 6 },
        { familyId: 'fam_export_control', hazardDelta: 0.22, decayQuarters: 8 },
        { familyId: 'fam_procurement_programme', hazardDelta: 0.18, decayQuarters: 8 },
        { familyId: 'fam_compute_supply', hazardDelta: 0.12, decayQuarters: 6 },
      ],
      cooldownQuarters: 8,
      incompatibleFamilyIds: [],
      severityRange: [0.35, 0.95],
      defaultVisibility: 'public',
      defaultDurationQuarters: 8,
      weight: 1.5,
    },
    suggestedTargetPaths: [
      'world.geopolitics.conflictRisk',
      'world.geopolitics.techCompetition',
      'world.geopolitics.sanctions',
      'world.macro.fxVolatility',
    ],
    affectedSectorIds: ['defence_tech', 'semiconductors', 'energy_infrastructure'],
    modifierTemplates: [
      add('world.geopolitics.conflictRisk', 0.06, 0.18, 'none', 8, 'The probability weight of supply-disrupting conflict rises.'),
      add('world.geopolitics.techCompetition', 0.05, 0.14, 'none', 8, 'Strategic technology competition sharpens between blocs.'),
      add('world.geopolitics.sanctions', 0.03, 0.09, 'none', 8, 'Sanctions regimes broaden in response.'),
      add('world.macro.fxVolatility', 0.04, 0.11, 'exponential', 4, 'Currency markets price the new risk immediately.'),
    ],
    bidirectional: false,
    companyScope: 'none',
  },
  {
    family: {
      id: 'fam_trade_dispute',
      label: 'Trade dispute and tariffs',
      description: 'Tariffs and non-tariff barriers are imposed on hardware or software trade.',
      category: 'geopolitics',
      allowedTypes: ['trade_dispute'],
      baseHazard: 0.07,
      preconditions: [],
      followOnHazards: [],
      cooldownQuarters: 5,
      incompatibleFamilyIds: [],
      severityRange: [0.2, 0.65],
      defaultVisibility: 'public',
      defaultDurationQuarters: 5,
      weight: 1,
    },
    suggestedTargetPaths: [
      'world.geopolitics.tradeFriction',
      'world.compute.spotPrice',
      'world.macro.inflation',
      'sector.semiconductors.demand',
    ],
    affectedSectorIds: ['semiconductors', 'cloud_infrastructure'],
    modifierTemplates: [
      add('world.geopolitics.tradeFriction', 0.04, 0.12, 'linear', 5, 'Tariffs and barriers raise the friction of moving hardware.'),
      mul('world.compute.spotPrice', 1.03, 1.1, 'linear', 5, 'Landed hardware cost feeds straight into capacity pricing.'),
      add('world.macro.inflation', 0.002, 0.01, 'linear', 5, 'Tariffs are a price level event before they are a trade event.'),
      add('sector.semiconductors.demand', -0.02, -0.08, 'linear', 5, 'Buyers defer orders while the dispute is unresolved.'),
    ],
    bidirectional: false,
    companyScope: 'none',
  },

  /* -------------------------------- Technology ------------------------------ */
  {
    family: {
      id: 'fam_frontier_breakthrough',
      label: 'Frontier capability breakthrough',
      description: 'A genuine step forward in demonstrated capability. The Frontier Map rearranges when this fires.',
      category: 'technology',
      allowedTypes: ['model_breakthrough', 'benchmark_result'],
      baseHazard: 0.11,
      preconditions: [{ path: 'world.aiFrontier.benchmarkSaturation', op: 'lt', value: 0.85 }],
      followOnHazards: [
        { familyId: 'fam_capital_rotation', hazardDelta: 0.12, decayQuarters: 3 },
        { familyId: 'fam_talent_war', hazardDelta: 0.1, decayQuarters: 4 },
      ],
      cooldownQuarters: 3,
      incompatibleFamilyIds: ['fam_research_disappointment'],
      severityRange: [0.2, 0.8],
      defaultVisibility: 'public',
      defaultDurationQuarters: 3,
      weight: 1.2,
    },
    suggestedTargetPaths: [
      'world.aiFrontier.frontierCapability',
      'world.aiFrontier.benchmarkSaturation',
      'sector.frontier_models.sentiment',
      'world.capitalMarkets.riskAppetite',
    ],
    affectedSectorIds: ['frontier_models', 'enterprise_software', 'consumer_ai'],
    modifierTemplates: [
      add('world.aiFrontier.frontierCapability', 0.02, 0.08, 'none', 3, 'The best publicly demonstrated model is meaningfully better.'),
      add('world.aiFrontier.benchmarkSaturation', 0.02, 0.07, 'none', 4, 'Headline benchmarks move closer to their ceiling.'),
      add('sector.frontier_models.sentiment', 0.05, 0.18, 'exponential', 3, 'Laboratories reprice on demonstrated progress.'),
      add('world.capitalMarkets.riskAppetite', 0.02, 0.08, 'exponential', 3, 'Visible progress pulls capital back toward the frontier.'),
    ],
    bidirectional: false,
    companyScope: 'none',
  },
  {
    family: {
      id: 'fam_open_weights',
      label: 'Major open-weight release',
      description:
        'A strong open-weight model is released. It compresses pricing power for anyone selling a capability the open weights now match, regardless of what they charge for it.',
      category: 'technology',
      allowedTypes: ['open_source_release'],
      baseHazard: 0.1,
      preconditions: [],
      followOnHazards: [{ familyId: 'fam_model_regulation', hazardDelta: 0.08, decayQuarters: 6 }],
      cooldownQuarters: 4,
      incompatibleFamilyIds: [],
      severityRange: [0.2, 0.7],
      defaultVisibility: 'public',
      defaultDurationQuarters: 4,
      weight: 1.1,
    },
    suggestedTargetPaths: [
      'world.aiFrontier.openSourceGap',
      'world.aiFrontier.inferenceCost',
      'world.society.developerSentiment',
      'sector.enterprise_software.multiple',
    ],
    affectedSectorIds: ['enterprise_software', 'frontier_models', 'consumer_ai'],
    modifierTemplates: [
      add('world.aiFrontier.openSourceGap', -0.05, -0.15, 'none', 6, 'Open weights close on the closed frontier.'),
      mul('world.aiFrontier.inferenceCost', 0.95, 0.8, 'none', 6, 'A free baseline drags the cost of serving comparable quality down.'),
      add('world.society.developerSentiment', 0.03, 0.1, 'linear', 4, 'The developer community rewards the release.'),
      mul('sector.enterprise_software.multiple', 0.97, 0.9, 'linear', 4, 'Software priced on a capability moat reprices without one.'),
    ],
    bidirectional: false,
    companyScope: 'none',
  },
  {
    family: {
      id: 'fam_research_disappointment',
      label: 'Scaling disappointment',
      description:
        'A widely expected capability gain fails to arrive. Only eligible when multiples are stretched: the disappointment is a repricing of optimism, not a physics result.',
      category: 'technology',
      allowedTypes: ['research_disappointment'],
      baseHazard: 0.07,
      preconditions: [{ path: 'world.capitalMarkets.sectorMultiples', op: 'gt', value: 1.4 }],
      followOnHazards: [
        { familyId: 'fam_capital_rotation', hazardDelta: 0.18, decayQuarters: 4 },
        { familyId: 'fam_fund_collapse', hazardDelta: 0.1, decayQuarters: 6 },
      ],
      cooldownQuarters: 6,
      incompatibleFamilyIds: ['fam_frontier_breakthrough'],
      severityRange: [0.25, 0.75],
      defaultVisibility: 'public',
      defaultDurationQuarters: 5,
      weight: 1,
    },
    suggestedTargetPaths: [
      'sector.frontier_models.sentiment',
      'world.capitalMarkets.sectorMultiples',
      'world.capitalMarkets.riskAppetite',
    ],
    affectedSectorIds: ['frontier_models'],
    modifierTemplates: [
      add('sector.frontier_models.sentiment', -0.05, -0.2, 'linear', 5, 'The premium paid for imminent capability is withdrawn.'),
      mul('world.capitalMarkets.sectorMultiples', 0.92, 0.78, 'linear', 5, 'Stretched multiples compress toward delivered fundamentals.'),
      mul('world.capitalMarkets.riskAppetite', 0.95, 0.85, 'exponential', 4, 'Allocators reassess the timeline they were underwriting.'),
    ],
    bidirectional: false,
    companyScope: 'none',
  },

  /* ----------------------------- Talent and data ---------------------------- */
  {
    family: {
      id: 'fam_talent_war',
      label: 'Talent market shock',
      description: 'Compensation, supply or mobility of technical staff moves sharply. Researchers are the binding constraint on research throughput far more often than money is.',
      category: 'talent',
      allowedTypes: ['talent_shock', 'immigration_change', 'labour_action'],
      baseHazard: 0.09,
      preconditions: [],
      followOnHazards: [],
      cooldownQuarters: 4,
      incompatibleFamilyIds: [],
      severityRange: [0.2, 0.65],
      defaultVisibility: 'public',
      defaultDurationQuarters: 4,
      weight: 1,
    },
    suggestedTargetPaths: [
      'world.talent.researcherSupply',
      'world.talent.engineerSupply',
      'world.talent.salaryPressure',
      'world.talent.immigrationAccess',
    ],
    affectedSectorIds: ['frontier_models', 'enterprise_software'],
    modifierTemplates: [
      mul('world.talent.researcherSupply', 0.95, 0.85, 'linear', 4, 'Available frontier researchers are absorbed by the bidders.'),
      mul('world.talent.engineerSupply', 0.96, 0.88, 'linear', 4, 'Senior infrastructure engineers become hard to hire at any band.'),
      mul('world.talent.salaryPressure', 1.1, 1.35, 'linear', 4, 'Compensation resets upward across the technical population.'),
      add('world.talent.immigrationAccess', -0.02, -0.08, 'linear', 4, 'Cross-border hiring becomes slower and less certain.'),
    ],
    bidirectional: false,
    companyScope: 'none',
  },
  {
    family: {
      id: 'fam_data_licensing',
      label: 'Data licensing shift',
      description:
        'Terms for licensed corpora change. The substitution effect matters: scarce real data raises the value of synthetic substitutes, so this family moves synthetic data maturity up.',
      category: 'data',
      allowedTypes: ['data_licensing_shift'],
      baseHazard: 0.06,
      preconditions: [],
      followOnHazards: [{ familyId: 'fam_ip_data_ruling', hazardDelta: 0.1, decayQuarters: 6 }],
      cooldownQuarters: 5,
      incompatibleFamilyIds: [],
      severityRange: [0.15, 0.6],
      defaultVisibility: 'sector',
      defaultDurationQuarters: 6,
      weight: 1,
    },
    suggestedTargetPaths: [
      'world.dataDomain.dataAvailability',
      'world.dataDomain.licensingCost',
      'world.dataDomain.syntheticDataMaturity',
      'sector.data_services.demand',
    ],
    affectedSectorIds: ['data_services', 'frontier_models'],
    modifierTemplates: [
      mul('world.dataDomain.dataAvailability', 0.96, 0.88, 'linear', 6, 'Rights holders withdraw or re-tier access to their corpora.'),
      mul('world.dataDomain.licensingCost', 1.08, 1.3, 'linear', 6, 'The remaining licensed corpora are repriced.'),
      add('world.dataDomain.syntheticDataMaturity', 0.02, 0.08, 'none', 6, 'Scarcity funds the substitutes; synthetic pipelines mature.'),
      add('sector.data_services.demand', 0.02, 0.08, 'linear', 6, 'Anyone who can supply compliant data has a queue at the door.'),
    ],
    bidirectional: false,
    companyScope: 'none',
  },

  /* --------------------- Society, media and corporate ----------------------- */
  {
    family: {
      id: 'fam_public_backlash',
      label: 'Public backlash cycle',
      description:
        'Public opinion turns against the industry. Also sets the dominant narrative to whichever frame best matches the trigger, which biases how every subsequent event is interpreted.',
      category: 'media',
      allowedTypes: ['public_backlash', 'media_cycle'],
      baseHazard: 0.09,
      preconditions: [{ path: 'world.media.attentionLevel', op: 'gt', value: 0.35 }],
      followOnHazards: [
        { familyId: 'fam_model_regulation', hazardDelta: 0.15, decayQuarters: 6 },
        { familyId: 'fam_antitrust', hazardDelta: 0.08, decayQuarters: 6 },
      ],
      cooldownQuarters: 3,
      incompatibleFamilyIds: [],
      severityRange: [0.2, 0.7],
      defaultVisibility: 'public',
      defaultDurationQuarters: 3,
      weight: 1.1,
    },
    suggestedTargetPaths: [
      'world.society.aiTrust',
      'world.society.automationAnxiety',
      'world.media.controversyIntensity',
      'world.media.attentionLevel',
    ],
    affectedSectorIds: ['consumer_ai', 'frontier_models'],
    modifierTemplates: [
      mul('world.society.aiTrust', 0.96, 0.86, 'linear', 3, 'Public trust falls with the coverage.'),
      add('world.society.automationAnxiety', 0.03, 0.12, 'linear', 4, 'Displacement fear rises while the story runs.'),
      add('world.media.controversyIntensity', 0.05, 0.18, 'exponential', 3, 'The controversy cycle runs hot.'),
      add('world.media.attentionLevel', 0.04, 0.12, 'exponential', 3, 'The industry occupies more of the news cycle.'),
    ],
    bidirectional: false,
    companyScope: 'none',
  },
  {
    family: {
      id: 'fam_safety_incident',
      label: 'Safety, security or conduct incident',
      description:
        'A safety failure, security breach or conduct scandal at a named company. The event is public; the reason that company was selected never is.',
      category: 'corporate',
      allowedTypes: ['safety_incident', 'cyber_incident', 'corporate_scandal'],
      baseHazard: 0.06,
      preconditions: [],
      followOnHazards: [
        { familyId: 'fam_model_regulation', hazardDelta: 0.2, decayQuarters: 8 },
        { familyId: 'fam_public_backlash', hazardDelta: 0.2, decayQuarters: 4 },
      ],
      cooldownQuarters: 5,
      incompatibleFamilyIds: [],
      severityRange: [0.3, 0.9],
      defaultVisibility: 'public',
      defaultDurationQuarters: 4,
      weight: 1.2,
    },
    suggestedTargetPaths: [
      'world.society.aiTrust',
      'world.regulation.safetyObligations',
      'company.{companyId}.reputationPublic',
      'company.{companyId}.reputationGovernment',
      'world.media.controversyIntensity',
    ],
    affectedSectorIds: [],
    modifierTemplates: [
      mul('world.society.aiTrust', 0.97, 0.88, 'linear', 4, 'A visible failure costs the whole industry trust, not only its author.'),
      add('world.regulation.safetyObligations', 0.03, 0.12, 'none', 8, 'Reporting and audit obligations are tightened in response.'),
      add('company.{companyId}.reputationPublic', -5, -20, 'linear', 4, 'The company named in the incident carries the public cost.'),
      add('company.{companyId}.reputationGovernment', -3, -12, 'linear', 6, 'Government buyers reassess the company\'s security posture.'),
      add('world.media.controversyIntensity', 0.05, 0.16, 'exponential', 3, 'The story dominates the cycle while it is live.'),
    ],
    bidirectional: false,
    companyScope: 'incident',
  },

  /* -------------------------------- Government ------------------------------ */
  {
    family: {
      id: 'fam_procurement_programme',
      label: 'Public programme announced',
      description:
        'A public AI programme is announced. The highest-frequency family, deliberately: it is the supply line for government work, and firing it opens one to three concrete procurement opportunities.',
      category: 'government',
      allowedTypes: ['procurement_programme', 'grant_programme', 'defence_mobilisation'],
      baseHazard: 0.12,
      preconditions: [{ path: 'world.government.procurementBudget', op: 'gt', value: 0.2 }],
      followOnHazards: [{ familyId: 'fam_talent_war', hazardDelta: 0.08, decayQuarters: 4 }],
      cooldownQuarters: 2,
      incompatibleFamilyIds: [],
      severityRange: [0.15, 0.7],
      defaultVisibility: 'public',
      defaultDurationQuarters: 6,
      weight: 1.3,
    },
    suggestedTargetPaths: [
      'world.government.procurementBudget',
      'world.government.defenceUrgency',
      'world.government.digitalModernisation',
      'world.government.grantFunding',
      'sector.defence_tech.demand',
    ],
    affectedSectorIds: ['defence_tech', 'enterprise_software'],
    modifierTemplates: [
      add('world.government.procurementBudget', 0.03, 0.12, 'none', 6, 'Appropriated budget for AI procurement rises.'),
      add('world.government.defenceUrgency', 0.03, 0.16, 'linear', 6, 'Political urgency behind national-security programmes increases.'),
      add('world.government.digitalModernisation', 0.02, 0.1, 'linear', 6, 'Civilian modernisation appetite rises alongside it.'),
      add('world.government.grantFunding', 0.02, 0.09, 'linear', 6, 'Non-dilutive research funding is expanded.'),
      add('sector.defence_tech.demand', 0.03, 0.12, 'linear', 6, 'Vendors in the addressed segment see immediate demand.'),
    ],
    bidirectional: false,
    companyScope: 'none',
  },
];

/* -------------------------------------------------------------------------- */
/*  Lookups                                                                    */
/* -------------------------------------------------------------------------- */

/** Every family as the contract shape, in stable catalogue order. */
export const EVENT_FAMILIES: readonly EventFamily[] = EVENT_FAMILY_DEFINITIONS.map((d) => d.family);

const BY_ID = new Map<string, EventFamilyDefinition>(EVENT_FAMILY_DEFINITIONS.map((d) => [d.family.id, d]));

/** Look up a family definition by id, or `null` when the catalogue has no such family. */
export function eventFamilyById(familyId: string): EventFamilyDefinition | null {
  return BY_ID.get(familyId) ?? null;
}

/** Sum of every base hazard in the catalogue. Documented as 1.94 in WORLD_EVENTS.md §1. */
export const TOTAL_BASE_HAZARD: number = EVENT_FAMILY_DEFINITIONS.reduce((sum, d) => sum + d.family.baseHazard, 0);
