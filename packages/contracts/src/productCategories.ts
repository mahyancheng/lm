/**
 * @frontier/contracts — productCategories.ts
 *
 * @deprecated WORLD 2 ONLY. World version 3 replaces this catalogue with the
 * one node table in `nodes.ts` and `nodeGraph.ts`. This module is not deleted
 * because world-2 saves reference its ids and a game in progress has to be able
 * to finish; it is frozen, and no world-3 code may import it. A contract test
 * enforces that.
 *
 * The product category catalogue: the owner's second north star made explicit.
 *
 * World version 1 sells "seats" in four segments and nothing else. World
 * version 2 spans six sectors, and inside each one a company sells a real
 * industry line — a frontier model is not a warehouse robot is not a battery —
 * with its own unit, its own price, its own elasticity and churn, and its own
 * capacity kind. This module is the single table every one of those lines is
 * looked up from, and it is where the supply graph between them is declared:
 * `inputs` says what a line is built on (an agents product needs a model
 * underneath it; a humanoid needs accelerators, sensors and batteries; a cloud
 * line needs accelerators; a grid-storage line needs batteries), and
 * `canSupply` says whether the line itself can be sold as somebody else's
 * input. A frontier lab that publishes an API is choosing to let `canSupply`
 * be true; a founder shopping for a model provider is choosing among the
 * `canSupply` lines that feed the category they are building.
 *
 * Two rules keep this from becoming a second copy of the tech tree:
 * - **`requiresNodeIds` is a launch gate, not a demand input.** It says what a
 *   company must have achieved (or have public access to) before it may launch
 *   into this category at all — checked once, at `launch_product`. Empty means
 *   commodity: no research prerequisite, only capital and demand.
 * - **The `inputs` graph is required-edges acyclic.** A `required: true` input
 *   cannot eventually point back at the line that needs it —
 *   `requiredSupplyGraphIsAcyclic` proves it, and the contract tests run it. A
 *   `required: false` input may still form a cycle (two lines that can each
 *   optionally strengthen the other), because nothing downstream depends on it
 *   existing.
 *
 * `Product.categoryId` names a row here. It is optional on the schema on
 * purpose — see the comment on that field in `company.ts` — so a
 * world-version-1 product, or any product saved before this catalogue existed,
 * carries no key at all and the frozen world keeps hashing to what it always
 * hashed to. Every reader calls `categoryOf` (in `@frontier/simulation`) or, at
 * the edge, `defaultCategoryFor` directly; nothing reads `categoryId` bare.
 */

import { z } from 'zod';
import { intCount, unitInterval, usd } from './ids';
import { CapacityKindSchema, ProductSegmentSchema, type CapacityKind, type ProductSegment } from './company';
import { SECTORS, SectorSchema, type Sector } from './sectors';

/* -------------------------------------------------------------------------- */
/*  Category shape                                                             */
/* -------------------------------------------------------------------------- */

export const ProductCategoryInputSchema = z
  .object({
    categoryId: z.string().min(1).describe('The upstream category this line is built on.'),
    share: unitInterval('Fraction of this line\'s unit cost the input represents.'),
    required: z.boolean().describe('True when this line cannot exist without a supplier for the input at all; false when the input only strengthens it.'),
  })
  .describe('One upstream line a product category is built on.');
export type ProductCategoryInput = z.infer<typeof ProductCategoryInputSchema>;

export const ProductCategorySchema = z
  .object({
    id: z.string().min(1).describe('Category id, e.g. "ai_frontier_models".'),
    label: z.string().min(1).max(60).describe('Name as it appears on the Launch screen, e.g. "Frontier models / LLM".'),
    sector: SectorSchema,
    industryLine: z.string().min(1).max(60).describe('The lane within the sector this belongs to, e.g. "Frontier models / LLM" or "Batteries".'),
    buyerSegment: ProductSegmentSchema.describe('This line\'s typical audience. A product launched into this category still carries its own segment; this is the catalogue\'s default.'),
    unitLabel: z.string().min(1).max(24).describe('What one unit of this line is, e.g. "seat", "1M tokens", "unit", "MWh", "shipment", "subscription".'),
    referencePriceUsd: usd('Fallback reference price per unit per quarter, used only when no other active product in this category\'s segment exists yet to set a real market reference.'),
    elasticity: z.number().min(0).max(3).describe('Price elasticity for this line. Higher means buyers leave faster over a price rise.'),
    churnBand: z.object({ min: unitInterval('Low end of the healthy quarterly churn band.'), max: unitInterval('High end of the healthy quarterly churn band.') }).describe('The quarterly churn band a healthy line in this category runs inside.'),
    baseAddRate: unitInterval('Gross additions per quarter as a fraction of the addressable base, at neutral conditions.'),
    seedPool: intCount('The outside pool a new line in this category can recruit from even at zero customers.'),
    supportCostShare: unitInterval('Support and delivery cost as a share of this line\'s revenue, part of cost of goods sold.'),
    grossMarginBaselinePct: unitInterval('Sustainable gross margin baseline for this line before compute, capacity and support cost are applied.'),
    capacityKind: CapacityKindSchema,
    capacityYieldPerUnit: z
      .number()
      .min(0)
      .describe(
        'Customers/units this line can serve per $1,000,000 of its capacityKind — accelerators for "compute" (via the existing serve-per-accelerator constant, this field unused), plant/fleet/grid dollars for the other three kinds. Zero and unused for "none".',
      ),
    computeIntensityBaseline: unitInterval('How much serving compute one unit of this line consumes, relative to the world baseline. Only meaningful when capacityKind is "compute".'),
    requiresNodeIds: z.array(z.string()).max(8).describe('Frontier Map node ids the company must have achieved, or have public access to, before launching into this category. Empty for a commodity line.'),
    regionAffinityWeight: unitInterval('How much a company\'s regional sector fit should weigh on this specific line, relative to the sector average. 0.5 is the sector\'s own weighting; higher means this line is unusually regional (freight, energy), lower means it travels (software, APIs).'),
    inputs: z.array(ProductCategoryInputSchema).max(6).describe('Upstream lines this category is built on. Empty for a raw/commodity line that needs no other company\'s product.'),
    canSupply: z.boolean().describe('Whether this line can be published as another company\'s input — a frontier model as a public API, a chip line supplying clouds, a battery line supplying grid storage.'),
  })
  .describe('One product category: an industry line inside a sector, with its own unit economics, capacity kind and place in the supply graph.');
export type ProductCategory = z.infer<typeof ProductCategorySchema>;

/* -------------------------------------------------------------------------- */
/*  Segment defaults, reused as category baselines                            */
/* -------------------------------------------------------------------------- */

/**
 * Per-segment baselines a category starts from and overrides what its
 * industry actually needs. Mirrors the shape of `SEGMENT_*` in
 * `@frontier/simulation`'s `companies/balance.ts` (which stays the world-1
 * fallback) so a category's numbers read as a specialisation of the segment
 * default, not an unrelated guess.
 */
const SEGMENT_BASELINE: Readonly<
  Record<
    ProductSegment,
    Pick<ProductCategory, 'referencePriceUsd' | 'elasticity' | 'churnBand' | 'baseAddRate' | 'seedPool' | 'supportCostShare'>
  >
> = {
  consumer: { referencePriceUsd: 60, elasticity: 1.6, churnBand: { min: 0.12, max: 0.22 }, baseAddRate: 0.18, seedPool: 40_000, supportCostShare: 0.08 },
  enterprise: { referencePriceUsd: 38, elasticity: 0.7, churnBand: { min: 0.03, max: 0.08 }, baseAddRate: 0.11, seedPool: 120, supportCostShare: 0.12 },
  developer_api: { referencePriceUsd: 12, elasticity: 1.2, churnBand: { min: 0.06, max: 0.14 }, baseAddRate: 0.15, seedPool: 2_500, supportCostShare: 0.05 },
  government: { referencePriceUsd: 5_000, elasticity: 0.4, churnBand: { min: 0.01, max: 0.03 }, baseAddRate: 0.06, seedPool: 6, supportCostShare: 0.15 },
};

/**
 * Per-sector gross-margin baseline a category starts from: the midpoint of
 * that sector's `grossMarginBandPct` in `sectors.ts`, so a category's default
 * margin agrees with the sector table it belongs to rather than repeating a
 * second independent guess. A category may still override it.
 */
const SECTOR_MARGIN_BASELINE: Readonly<Record<Sector, number>> = {
  ai: 0.68,
  robotics: 0.45,
  manufacturing: 0.29,
  energy: 0.42,
  logistics: 0.22,
  consumer: 0.52,
};

/** Build one category from a segment baseline plus everything that makes its industry different. */
function category(
  id: string,
  label: string,
  sector: Sector,
  industryLine: string,
  buyerSegment: ProductSegment,
  overrides: Partial<Omit<ProductCategory, 'id' | 'label' | 'sector' | 'industryLine' | 'buyerSegment'>> &
    Pick<ProductCategory, 'unitLabel' | 'capacityKind' | 'capacityYieldPerUnit' | 'computeIntensityBaseline' | 'requiresNodeIds' | 'regionAffinityWeight' | 'inputs' | 'canSupply'>,
): ProductCategory {
  return {
    id,
    label,
    sector,
    industryLine,
    buyerSegment,
    ...SEGMENT_BASELINE[buyerSegment],
    grossMarginBaselinePct: SECTOR_MARGIN_BASELINE[sector],
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/*  The catalogue                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Every product line in the world-2 economy, across all six sectors. At least
 * five lines per sector (the catalogue integrity test asserts it), thirty-six
 * in total. Ids are stable: appending is safe, renaming is not — a stored
 * `categoryId` on a live save would go dangling.
 */
export const PRODUCT_CATEGORIES: readonly ProductCategory[] = [
  /* --- ai ------------------------------------------------------------- */
  category('ai_software', 'Software', 'ai', 'Software', 'enterprise', {
    unitLabel: 'seat',
    capacityKind: 'compute',
    capacityYieldPerUnit: 0,
    computeIntensityBaseline: 0.35,
    requiresNodeIds: [],
    regionAffinityWeight: 0.3,
    inputs: [{ categoryId: 'ai_frontier_models', share: 0.15, required: false }],
    canSupply: false,
  }),
  category('ai_frontier_models', 'Frontier models / LLM', 'ai', 'Frontier models / LLM', 'developer_api', {
    referencePriceUsd: 1_800,
    elasticity: 0.9,
    churnBand: { min: 0.03, max: 0.09 },
    unitLabel: '1M tokens',
    capacityKind: 'compute',
    capacityYieldPerUnit: 0,
    computeIntensityBaseline: 0.85,
    requiresNodeIds: [],
    regionAffinityWeight: 0.2,
    inputs: [],
    canSupply: true,
  }),
  category('ai_agents', 'Agents', 'ai', 'Agents', 'enterprise', {
    referencePriceUsd: 5_200,
    unitLabel: 'seat',
    capacityKind: 'compute',
    capacityYieldPerUnit: 0,
    computeIntensityBaseline: 0.7,
    requiresNodeIds: ['tech_tool_learning'],
    regionAffinityWeight: 0.3,
    inputs: [{ categoryId: 'ai_frontier_models', share: 0.4, required: true }],
    canSupply: false,
  }),
  category('ai_inference_api', 'Inference API', 'ai', 'Inference API', 'developer_api', {
    referencePriceUsd: 900,
    elasticity: 1.4,
    unitLabel: '1M tokens',
    capacityKind: 'compute',
    capacityYieldPerUnit: 0,
    computeIntensityBaseline: 0.6,
    requiresNodeIds: ['tech_efficient_sparse_inference'],
    regionAffinityWeight: 0.2,
    inputs: [{ categoryId: 'ai_frontier_models', share: 0.55, required: true }],
    canSupply: true,
  }),
  category('ai_data_labelling', 'Data & labelling', 'ai', 'Data & labelling', 'developer_api', {
    referencePriceUsd: 1_100,
    elasticity: 1.0,
    unitLabel: 'dataset',
    capacityKind: 'none',
    capacityYieldPerUnit: 0,
    computeIntensityBaseline: 0.25,
    requiresNodeIds: [],
    regionAffinityWeight: 0.4,
    inputs: [],
    canSupply: true,
  }),
  category('ai_safety_evals', 'Safety & evals', 'ai', 'Safety & evals', 'enterprise', {
    referencePriceUsd: 4_200,
    elasticity: 0.5,
    churnBand: { min: 0.02, max: 0.06 },
    unitLabel: 'audit',
    capacityKind: 'none',
    capacityYieldPerUnit: 0,
    computeIntensityBaseline: 0.4,
    requiresNodeIds: ['tech_mechanistic_interpretability'],
    regionAffinityWeight: 0.3,
    inputs: [{ categoryId: 'ai_frontier_models', share: 0.2, required: false }],
    canSupply: true,
  }),
  category('ai_cloud_infrastructure', 'AI cloud / reserved compute', 'ai', 'AI cloud infrastructure', 'enterprise', {
    referencePriceUsd: 5_800,
    elasticity: 0.5,
    churnBand: { min: 0.01, max: 0.04 },
    unitLabel: 'accelerator-hour',
    capacityKind: 'compute',
    capacityYieldPerUnit: 0,
    computeIntensityBaseline: 0.95,
    requiresNodeIds: ['tech_specialised_accelerator_design'],
    regionAffinityWeight: 0.5,
    inputs: [{ categoryId: 'manufacturing_accelerators', share: 0.6, required: true }],
    canSupply: true,
  }),
  category('ai_developer_tools', 'Developer tools', 'ai', 'Developer tools', 'developer_api', {
    referencePriceUsd: 480,
    elasticity: 1.3,
    unitLabel: 'seat',
    capacityKind: 'none',
    capacityYieldPerUnit: 0,
    computeIntensityBaseline: 0.15,
    requiresNodeIds: [],
    regionAffinityWeight: 0.2,
    inputs: [{ categoryId: 'ai_frontier_models', share: 0.1, required: false }],
    canSupply: false,
  }),
  category('ai_model_hosting', 'Model fine-tuning / hosting', 'ai', 'Model hosting', 'developer_api', {
    referencePriceUsd: 1_400,
    elasticity: 1.1,
    unitLabel: '1M tokens',
    capacityKind: 'compute',
    capacityYieldPerUnit: 0,
    computeIntensityBaseline: 0.55,
    requiresNodeIds: [],
    regionAffinityWeight: 0.3,
    inputs: [{ categoryId: 'ai_frontier_models', share: 0.3, required: false }],
    canSupply: true,
  }),

  /* --- robotics --------------------------------------------------------- */
  category('robotics_industrial_arms', 'Industrial arms', 'robotics', 'Industrial arms', 'enterprise', {
    referencePriceUsd: 42_000,
    elasticity: 0.6,
    unitLabel: 'unit',
    capacityKind: 'plant',
    capacityYieldPerUnit: 60,
    computeIntensityBaseline: 0.2,
    requiresNodeIds: [],
    regionAffinityWeight: 0.6,
    inputs: [{ categoryId: 'manufacturing_accelerators', share: 0.1, required: false }, { categoryId: 'manufacturing_sensors', share: 0.15, required: false }],
    canSupply: false,
  }),
  category('robotics_warehouse', 'Warehouse robots', 'robotics', 'Warehouse robots', 'enterprise', {
    referencePriceUsd: 9_400,
    elasticity: 0.65,
    unitLabel: 'unit',
    capacityKind: 'fleet',
    capacityYieldPerUnit: 40,
    computeIntensityBaseline: 0.4,
    requiresNodeIds: ['tech_field_autonomy_stack'],
    regionAffinityWeight: 0.6,
    inputs: [
      { categoryId: 'manufacturing_accelerators', share: 0.2, required: true },
      { categoryId: 'manufacturing_sensors', share: 0.2, required: true },
      { categoryId: 'manufacturing_batteries', share: 0.15, required: false },
    ],
    canSupply: false,
  }),
  category('robotics_humanoids', 'Humanoids', 'robotics', 'Humanoids', 'enterprise', {
    referencePriceUsd: 68_000,
    elasticity: 0.4,
    churnBand: { min: 0.01, max: 0.05 },
    baseAddRate: 0.05,
    seedPool: 40,
    unitLabel: 'unit',
    capacityKind: 'plant',
    capacityYieldPerUnit: 8,
    computeIntensityBaseline: 0.75,
    requiresNodeIds: ['tech_general_purpose_humanoid', 'tech_bipedal_locomotion'],
    regionAffinityWeight: 0.5,
    inputs: [
      { categoryId: 'manufacturing_accelerators', share: 0.25, required: true },
      { categoryId: 'manufacturing_sensors', share: 0.2, required: true },
      { categoryId: 'manufacturing_batteries', share: 0.2, required: true },
    ],
    canSupply: false,
  }),
  category('robotics_drones', 'Drones', 'robotics', 'Drones', 'government', {
    referencePriceUsd: 68_000,
    elasticity: 0.3,
    unitLabel: 'unit',
    capacityKind: 'plant',
    capacityYieldPerUnit: 30,
    computeIntensityBaseline: 0.45,
    requiresNodeIds: ['tech_swarm_coordination'],
    regionAffinityWeight: 0.5,
    inputs: [
      { categoryId: 'manufacturing_batteries', share: 0.25, required: true },
      { categoryId: 'manufacturing_sensors', share: 0.2, required: false },
    ],
    canSupply: false,
  }),
  category('robotics_software', 'Robot software', 'robotics', 'Robot software', 'developer_api', {
    referencePriceUsd: 1_800,
    elasticity: 1.0,
    unitLabel: 'seat',
    capacityKind: 'none',
    capacityYieldPerUnit: 0,
    computeIntensityBaseline: 0.3,
    requiresNodeIds: [],
    regionAffinityWeight: 0.2,
    inputs: [{ categoryId: 'ai_frontier_models', share: 0.2, required: false }],
    canSupply: true,
  }),

  /* --- manufacturing ------------------------------------------------------ */
  category('manufacturing_accelerators', 'Accelerators / chips', 'manufacturing', 'Accelerators / chips', 'enterprise', {
    referencePriceUsd: 240_000,
    elasticity: 0.5,
    churnBand: { min: 0.01, max: 0.03 },
    unitLabel: 'unit',
    capacityKind: 'plant',
    capacityYieldPerUnit: 25,
    computeIntensityBaseline: 0.15,
    requiresNodeIds: [],
    regionAffinityWeight: 0.7,
    inputs: [],
    canSupply: true,
  }),
  category('manufacturing_fabs_packaging', 'Fabs & packaging', 'manufacturing', 'Fabs & packaging', 'enterprise',
    {
      referencePriceUsd: 320_000,
      elasticity: 0.4,
      churnBand: { min: 0.01, max: 0.02 },
      unitLabel: 'wafer lot',
      capacityKind: 'plant',
      capacityYieldPerUnit: 4,
      computeIntensityBaseline: 0.1,
      requiresNodeIds: ['tech_closed_loop_yield'],
      regionAffinityWeight: 0.8,
      inputs: [],
      canSupply: true,
    }),
  category('manufacturing_sensors', 'Sensors', 'manufacturing', 'Sensors', 'enterprise', {
    referencePriceUsd: 34_000,
    elasticity: 0.7,
    unitLabel: 'unit',
    capacityKind: 'plant',
    capacityYieldPerUnit: 90,
    computeIntensityBaseline: 0.08,
    requiresNodeIds: [],
    regionAffinityWeight: 0.6,
    inputs: [],
    canSupply: true,
  }),
  category('manufacturing_batteries', 'Batteries', 'manufacturing', 'Batteries', 'enterprise', {
    referencePriceUsd: 18_000,
    elasticity: 0.8,
    unitLabel: 'unit',
    capacityKind: 'plant',
    capacityYieldPerUnit: 60,
    computeIntensityBaseline: 0.05,
    requiresNodeIds: ['tech_grid_scale_storage'],
    regionAffinityWeight: 0.6,
    inputs: [],
    canSupply: true,
  }),
  category('manufacturing_machine_tools', 'Machine tools', 'manufacturing', 'Machine tools', 'enterprise', {
    referencePriceUsd: 96_000,
    elasticity: 0.5,
    unitLabel: 'unit',
    capacityKind: 'plant',
    capacityYieldPerUnit: 12,
    computeIntensityBaseline: 0.08,
    requiresNodeIds: ['tech_self_reconfiguring_tooling'],
    regionAffinityWeight: 0.7,
    inputs: [],
    canSupply: true,
  }),
  category('manufacturing_contract_mfg', 'Contract manufacturing', 'manufacturing', 'Contract manufacturing', 'enterprise', {
    referencePriceUsd: 52_000,
    elasticity: 0.7,
    unitLabel: 'shipment',
    capacityKind: 'plant',
    capacityYieldPerUnit: 45,
    computeIntensityBaseline: 0.05,
    requiresNodeIds: [],
    regionAffinityWeight: 0.7,
    inputs: [{ categoryId: 'manufacturing_sensors', share: 0.1, required: false }],
    canSupply: true,
  }),

  /* --- energy --------------------------------------------------------- */
  category('energy_generation', 'Generation', 'energy', 'Generation', 'enterprise', {
    referencePriceUsd: 26_000,
    elasticity: 0.4,
    churnBand: { min: 0.01, max: 0.02 },
    unitLabel: 'MWh',
    capacityKind: 'grid',
    capacityYieldPerUnit: 350,
    computeIntensityBaseline: 0.02,
    requiresNodeIds: [],
    regionAffinityWeight: 0.8,
    inputs: [],
    canSupply: true,
  }),
  category('energy_grid_storage', 'Grid & storage', 'energy', 'Grid & storage', 'enterprise', {
    referencePriceUsd: 320_000,
    elasticity: 0.35,
    churnBand: { min: 0.01, max: 0.02 },
    unitLabel: 'MW connected',
    capacityKind: 'grid',
    capacityYieldPerUnit: 6,
    computeIntensityBaseline: 0.02,
    requiresNodeIds: ['tech_grid_scale_storage', 'tech_long_duration_storage'],
    regionAffinityWeight: 0.8,
    inputs: [{ categoryId: 'manufacturing_batteries', share: 0.4, required: true }],
    canSupply: true,
  }),
  category('energy_datacentre_power', 'Datacentre power', 'energy', 'Datacentre power', 'enterprise', {
    referencePriceUsd: 42_000,
    elasticity: 0.45,
    unitLabel: 'MW contracted',
    capacityKind: 'grid',
    capacityYieldPerUnit: 8,
    computeIntensityBaseline: 0.05,
    requiresNodeIds: ['tech_grid_forming_inverters'],
    regionAffinityWeight: 0.7,
    inputs: [],
    canSupply: true,
  }),
  category('energy_fuel_hydrogen', 'Fuel & hydrogen', 'energy', 'Fuel & hydrogen', 'enterprise', {
    referencePriceUsd: 22_000,
    elasticity: 0.6,
    unitLabel: 'tonne',
    capacityKind: 'plant',
    capacityYieldPerUnit: 70,
    computeIntensityBaseline: 0.02,
    requiresNodeIds: [],
    regionAffinityWeight: 0.7,
    inputs: [],
    canSupply: true,
  }),
  category('energy_transmission', 'Transmission & distribution', 'energy', 'Transmission & distribution', 'government', {
    referencePriceUsd: 12_000,
    elasticity: 0.3,
    unitLabel: 'connection',
    capacityKind: 'grid',
    capacityYieldPerUnit: 20,
    computeIntensityBaseline: 0.02,
    requiresNodeIds: ['tech_grid_forming_inverters'],
    regionAffinityWeight: 0.8,
    inputs: [],
    canSupply: false,
  }),

  /* --- logistics ------------------------------------------------------- */
  category('logistics_freight', 'Freight', 'logistics', 'Freight', 'enterprise', {
    referencePriceUsd: 46_000,
    elasticity: 0.9,
    churnBand: { min: 0.04, max: 0.09 },
    unitLabel: 'shipment',
    capacityKind: 'fleet',
    capacityYieldPerUnit: 40,
    computeIntensityBaseline: 0.05,
    requiresNodeIds: [],
    regionAffinityWeight: 0.7,
    inputs: [],
    canSupply: true,
  }),
  category('logistics_last_mile', 'Last mile', 'logistics', 'Last mile', 'consumer', {
    referencePriceUsd: 42,
    elasticity: 1.3,
    unitLabel: 'shipment',
    capacityKind: 'fleet',
    capacityYieldPerUnit: 2_400,
    computeIntensityBaseline: 0.08,
    requiresNodeIds: ['tech_drone_last_mile'],
    regionAffinityWeight: 0.7,
    inputs: [{ categoryId: 'logistics_freight', share: 0.2, required: false }],
    canSupply: false,
  }),
  category('logistics_ports_fleets', 'Ports & fleets', 'logistics', 'Ports & fleets', 'enterprise', {
    referencePriceUsd: 74_000,
    elasticity: 0.6,
    unitLabel: 'vessel-call',
    capacityKind: 'fleet',
    capacityYieldPerUnit: 15,
    computeIntensityBaseline: 0.1,
    requiresNodeIds: ['tech_autonomous_line_haul'],
    regionAffinityWeight: 0.8,
    inputs: [],
    canSupply: true,
  }),
  category('logistics_supply_chain_software', 'Supply-chain software', 'logistics', 'Supply-chain software', 'developer_api', {
    referencePriceUsd: 1_600,
    elasticity: 1.0,
    unitLabel: 'seat',
    capacityKind: 'none',
    capacityYieldPerUnit: 0,
    computeIntensityBaseline: 0.2,
    requiresNodeIds: ['tech_dynamic_network_routing'],
    regionAffinityWeight: 0.3,
    inputs: [{ categoryId: 'ai_frontier_models', share: 0.15, required: false }],
    canSupply: false,
  }),
  category('logistics_cold_chain', 'Cold chain', 'logistics', 'Cold chain', 'enterprise', {
    referencePriceUsd: 21_000,
    elasticity: 0.8,
    unitLabel: 'shipment',
    capacityKind: 'fleet',
    capacityYieldPerUnit: 50,
    computeIntensityBaseline: 0.06,
    requiresNodeIds: [],
    regionAffinityWeight: 0.7,
    inputs: [{ categoryId: 'logistics_freight', share: 0.3, required: false }],
    canSupply: false,
  }),

  /* --- consumer ---------------------------------------------------------- */
  category('consumer_apps', 'Apps', 'consumer', 'Apps', 'consumer', {
    referencePriceUsd: 14,
    elasticity: 1.7,
    unitLabel: 'subscription',
    capacityKind: 'none',
    capacityYieldPerUnit: 0,
    computeIntensityBaseline: 0.35,
    requiresNodeIds: [],
    regionAffinityWeight: 0.4,
    inputs: [{ categoryId: 'ai_frontier_models', share: 0.1, required: false }],
    canSupply: false,
  }),
  category('consumer_devices', 'Devices', 'consumer', 'Devices', 'consumer', {
    referencePriceUsd: 320,
    elasticity: 1.3,
    unitLabel: 'unit',
    capacityKind: 'plant',
    capacityYieldPerUnit: 900,
    computeIntensityBaseline: 0.15,
    requiresNodeIds: [],
    regionAffinityWeight: 0.6,
    inputs: [
      { categoryId: 'manufacturing_accelerators', share: 0.15, required: false },
      { categoryId: 'manufacturing_sensors', share: 0.1, required: false },
      { categoryId: 'manufacturing_batteries', share: 0.15, required: false },
    ],
    canSupply: false,
  }),
  category('consumer_media', 'Media', 'consumer', 'Media', 'consumer', {
    referencePriceUsd: 22,
    elasticity: 1.5,
    unitLabel: 'subscription',
    capacityKind: 'none',
    capacityYieldPerUnit: 0,
    computeIntensityBaseline: 0.3,
    requiresNodeIds: ['tech_synthetic_media_studio'],
    regionAffinityWeight: 0.3,
    inputs: [{ categoryId: 'ai_frontier_models', share: 0.2, required: false }],
    canSupply: false,
  }),
  category('consumer_marketplaces', 'Marketplaces', 'consumer', 'Marketplaces', 'consumer', {
    referencePriceUsd: 36,
    elasticity: 1.4,
    unitLabel: 'subscription',
    capacityKind: 'none',
    capacityYieldPerUnit: 0,
    computeIntensityBaseline: 0.2,
    requiresNodeIds: ['tech_personal_agent_commerce'],
    regionAffinityWeight: 0.5,
    inputs: [
      { categoryId: 'logistics_freight', share: 0.1, required: false },
      { categoryId: 'logistics_last_mile', share: 0.15, required: false },
    ],
    canSupply: false,
  }),
  category('consumer_subscriptions', 'Subscriptions', 'consumer', 'Subscriptions', 'consumer', {
    referencePriceUsd: 20,
    elasticity: 1.5,
    unitLabel: 'subscription',
    capacityKind: 'none',
    capacityYieldPerUnit: 0,
    computeIntensityBaseline: 0.25,
    requiresNodeIds: [],
    regionAffinityWeight: 0.3,
    inputs: [{ categoryId: 'ai_frontier_models', share: 0.05, required: false }],
    canSupply: false,
  }),
  category('consumer_retail_commerce', 'Retail & commerce', 'consumer', 'Retail & commerce', 'consumer', {
    referencePriceUsd: 9,
    elasticity: 1.8,
    unitLabel: 'unit',
    capacityKind: 'fleet',
    capacityYieldPerUnit: 3_000,
    computeIntensityBaseline: 0.1,
    requiresNodeIds: ['tech_neural_interface_retail'],
    regionAffinityWeight: 0.5,
    inputs: [
      { categoryId: 'logistics_last_mile', share: 0.2, required: false },
      { categoryId: 'manufacturing_contract_mfg', share: 0.2, required: false },
    ],
    canSupply: false,
  }),
];

/* -------------------------------------------------------------------------- */
/*  Lookups                                                                    */
/* -------------------------------------------------------------------------- */

export const PRODUCT_CATEGORIES_BY_ID: Readonly<Record<string, ProductCategory>> = Object.freeze(
  Object.fromEntries(PRODUCT_CATEGORIES.map((entry) => [entry.id, entry])),
);

/** The catalogue row for an id, or undefined when it names nothing (a stale or corrupt save). */
export function categoryById(id: string): ProductCategory | undefined {
  return PRODUCT_CATEGORIES_BY_ID[id];
}

/** Every category in one sector, in catalogue order. */
export function productCategoriesFor(sector: Sector): readonly ProductCategory[] {
  return PRODUCT_CATEGORIES.filter((entry) => entry.sector === sector);
}

/**
 * The category a product falls back to when it carries no `categoryId`: the
 * first catalogue entry in the product's sector whose `buyerSegment` matches
 * the product's own segment, and otherwise the first entry in that sector at
 * all. Total over every (sector, segment) pair — every sector has at least one
 * category for every segment to fall back to, because every sector's first
 * entry is a real answer for any segment nobody launched into deliberately.
 *
 * Deterministic and pure: the same (sector, segment) always resolves to the
 * same id, on any machine, forever — a stored world must be able to replay
 * this derivation exactly.
 */
export function defaultCategoryFor(sector: Sector, segment: ProductSegment): string {
  const inSector = productCategoriesFor(sector);
  const bySegment = inSector.find((entry) => entry.buyerSegment === segment);
  if (bySegment !== undefined) return bySegment.id;
  // Every sector carries at least one category (the integrity test asserts
  // it), so this index is never actually out of range; the catalogue's own
  // first entry is the ultimate, unconditional fallback.
  return (inSector[0] ?? PRODUCT_CATEGORIES[0]!).id;
}

/**
 * The category a product resolves to: its own `categoryId` when it has one and
 * the id still names a real category, otherwise the deterministic default for
 * its sector and segment. Never returns undefined — every sector carries at
 * least one category, so this always has a real row to fall back to.
 */
export function resolveCategory(categoryId: string | null | undefined, sector: Sector, segment: ProductSegment): ProductCategory {
  if (categoryId !== null && categoryId !== undefined) {
    const found = PRODUCT_CATEGORIES_BY_ID[categoryId];
    if (found !== undefined) return found;
  }
  const fallbackId = defaultCategoryFor(sector, segment);
  return PRODUCT_CATEGORIES_BY_ID[fallbackId] ?? PRODUCT_CATEGORIES[0]!;
}

/* -------------------------------------------------------------------------- */
/*  Graph integrity                                                            */
/* -------------------------------------------------------------------------- */

/**
 * True when the `required: true` edges of the `inputs` graph contain no cycle.
 * A category may point at another with `required: false` in either direction
 * (an optional strengthening relationship), but a line that cannot exist
 * without its input can never eventually depend on itself.
 *
 * Pure and deterministic; the contract tests run it against `PRODUCT_CATEGORIES`
 * and it is cheap enough to run again wherever a session accepts a new
 * player-defined category in a future stage.
 */
export function requiredSupplyGraphIsAcyclic(categories: readonly ProductCategory[] = PRODUCT_CATEGORIES): boolean {
  const byId = new Map(categories.map((entry) => [entry.id, entry]));
  const state = new Map<string, 'visiting' | 'done'>();

  const visit = (id: string): boolean => {
    const mark = state.get(id);
    if (mark === 'done') return true;
    if (mark === 'visiting') return false;
    state.set(id, 'visiting');
    const entry = byId.get(id);
    if (entry !== undefined) {
      for (const input of entry.inputs) {
        if (!input.required) continue;
        if (!byId.has(input.categoryId)) continue;
        if (!visit(input.categoryId)) return false;
      }
    }
    state.set(id, 'done');
    return true;
  };

  for (const entry of categories) {
    if (!visit(entry.id)) return false;
  }
  return true;
}

/** Every sector, for a test that walks the catalogue by sector. Re-exported for convenience. */
export const PRODUCT_CATEGORY_SECTORS = SECTORS;
