/**
 * @frontier/contracts — nodeGraph.ts
 *
 * The world-3 node table: one row per thing the economy can make.
 *
 * Every price is a **balance price** — what one unit costs where supply and
 * demand meet — not a scarcity price and not a list price. Where the real
 * figure is a range, the row takes the middle and the comment says so. Where a
 * number is not obvious, the comment cites what it was checked against, with
 * 2026 figures.
 *
 * ## Slots, and the choices they carry
 *
 * Every input is a **slot**: a role, a quantity, a default. The default is
 * today's recipe; the role is what a founder may swap in. The places the owner
 * asked for a real choice are the roles with more than one node:
 *
 * - the inference API's **model** — frontier, small or policy;
 * - every application's **harness** — agent harness or copilot framework — and
 *   an optional **delivery** device;
 * - a robot's **actuator**, **edge compute**, **battery pack**, **model** and
 *   **control stack**;
 * - a vehicle's **battery pack** chemistry and an optional **autonomy stack**;
 * - a power purchase agreement's **generation asset** — solar, wind or SMR;
 * - grid storage's and a device's **cell** chemistry;
 * - a wind turbine's **structure** — composite or machined;
 * - a logistics service's **vehicle** and optional **routing** software;
 * - a brand's **goods** and optional **storefront** marketplace.
 *
 * ## The six chains, and where they cross
 *
 * - **Semiconductors** (manufacturing) — silicon feedstock → 300mm logic wafer
 *   → logic and accelerator die, HBM stack, substrate → advanced package → AI
 *   accelerator → AI server rack.
 * - **Batteries** (manufacturing) — lithium, nickel and graphite → NMC or LFP
 *   cathode, anode and electrolyte → cell → pack, one chemistry per chain.
 * - **Energy** — gas and uranium → grid power; solar module, wind turbine, SMR
 *   module, storage and substation → grid interconnect → power purchase
 *   agreement and datacentre capacity.
 * - **AI** — curated corpus and preference data → training runs → frontier and
 *   small models → inference API → harnesses → agent platform, software suite,
 *   vertical applications, developer tooling.
 * - **Robotics** — actuators, sensors and edge compute, a battery pack, a
 *   policy model and a control stack → industrial arm, warehouse AMR, humanoid,
 *   drone.
 * - **Logistics** — electric trucks and vans (built from packs, drivetrains and
 *   chips) and warehouse automation cells (built from AMRs and arms) → line
 *   haul, last mile, brokerage and port terminals run on a routing platform.
 * - **Consumer** — SoCs, camera modules and display panels → devices and
 *   wearables; inference and a harness → marketplaces, media, subscriptions,
 *   social; goods and a storefront → a direct brand.
 *
 * They cross in earnest: robotics buys AI training runs and manufacturing
 * structures, logistics buys robots and packs, consumer buys wafers through its
 * own SoC line and inference through the AI chain, and **every** node above
 * tier 1 with an energy draw buys `res_grid_power`, which is what makes every
 * company in the world an energy customer.
 *
 * ## Compute and energy are capacity, not bill of materials
 *
 * `capacityKind: "compute"` draws ACCELERATORS and `"plant" | "fleet" | "grid"`
 * draw $1,000,000 OF INSTALLED CAPITAL. That is why the AI chain does not carry
 * a slot on `sys_ai_accelerator`: a training run does not eat accelerators, it
 * occupies them. `energyMwhPerUnit` is the one implicit slot in the table, on
 * `res_grid_power`.
 *
 * ## Markets
 *
 * A row states who buys it as weighted customer types and weighted industries.
 * Most rows say nothing and take the derivation in `withDerivedMarkets`: an
 * intermediate sells to enterprises in the sectors whose slots admit it, a
 * terminal with no buyer in the table sells to every industry, and a row sold
 * to the public sells into the consumer sector alone.
 */

import type { ProductSegment, CapacityKind, TechCapabilityArea } from './company';
import type { Sector } from './sectors';
import { SECTORS } from './sectors';
import type { NodeRole } from './nodeRoles';
import { NODE_ROLE_LABELS } from './nodeRoles';
import {
  EconomicNodeSchema,
  GRID_POWER_NODE_ID,
  admissibleNodeIds,
  indexNodes,
  nodePriceIndex,
  nodePriceUsd,
  type EconomicNode,
  type NodeMaturity,
  type NodePricedState,
  type NodeSaleKind,
  type NodeSlot,
  type NodeSlotKind,
  type NodeTier,
} from './nodes';

/* -------------------------------------------------------------------------- */
/*  Defaults                                                                   */
/* -------------------------------------------------------------------------- */

/** Belief defaults per maturity, so ninety rows do not repeat six numbers each. */
const MATURITY_BELIEF: Readonly<Record<NodeMaturity, { confidence: number; novelty: number; plausibility: number; window: readonly [number, number] }>> = {
  commodity: { confidence: 0.99, novelty: 0.02, plausibility: 1, window: [2027, 2027] },
  established: { confidence: 0.95, novelty: 0.1, plausibility: 0.98, window: [2027, 2028] },
  emerging: { confidence: 0.72, novelty: 0.36, plausibility: 0.9, window: [2028, 2031] },
  frontier: { confidence: 0.46, novelty: 0.62, plausibility: 0.78, window: [2030, 2035] },
  speculative: { confidence: 0.22, novelty: 0.85, plausibility: 0.54, window: [2034, 2042] },
  discredited: { confidence: 0.08, novelty: 0.7, plausibility: 0.24, window: [2040, 2048] },
};

/** Programme cost defaults per maturity, before the tier factor below. */
const MATURITY_RESEARCH_COST: Readonly<Record<NodeMaturity, readonly [number, number]>> = {
  commodity: [2_000_000, 8_000_000],
  established: [20_000_000, 90_000_000],
  emerging: [120_000_000, 600_000_000],
  frontier: [700_000_000, 4_000_000_000],
  speculative: [2_000_000_000, 12_000_000_000],
  discredited: [1_000_000_000, 6_000_000_000],
};

/** Which capability areas a sector's programmes draw on, when a row says nothing. */
const SECTOR_TALENT: Readonly<Record<Sector, readonly TechCapabilityArea[]>> = {
  ai: ['reasoning', 'training_systems'],
  robotics: ['agents', 'hardware_design'],
  manufacturing: ['hardware_design', 'infrastructure'],
  energy: ['infrastructure', 'efficiency'],
  logistics: ['infrastructure', 'agents'],
  consumer: ['multimodal', 'retrieval'],
};

/** Healthy churn bands per sale kind. A contract churns at renewal, not monthly. */
const SALE_CHURN: Readonly<Record<NodeSaleKind, readonly [number, number]>> = {
  unit: [0.02, 0.07],
  recurring: [0.06, 0.15],
  contract: [0.01, 0.04],
};

/* -------------------------------------------------------------------------- */
/*  Slot builder                                                               */
/* -------------------------------------------------------------------------- */

/**
 * How strictly a slot binds:
 * - `RB` required and blocking — nobody in the world can fill it, nothing ships;
 * - `R` required, never blocking — the open market always has some of it;
 * - `O` optional — may be left empty.
 */
type SlotMode = 'RB' | 'R' | 'O';

interface SlotOptions {
  /** Narrow the slot to these nodes. Empty (the default) admits every node of the role. */
  readonly accepts?: readonly string[];
  /** The default fill. Inferred when `accepts` pins exactly one node; null leaves the slot empty. */
  readonly def?: string | null;
  /** Port label, when the role's own word is not the right one. */
  readonly label?: string;
  readonly kind?: NodeSlotKind;
}

/** One slot, in its shortest honest form. Throws at build on an ambiguous default, which the suite reports. */
function slot(id: string, role: NodeRole, qtyPerUnit: number, mode: SlotMode, options: SlotOptions = {}): NodeSlot {
  const accepts = options.accepts ?? [];
  const inferred = accepts.length === 1 ? accepts[0] : undefined;
  const def = options.def !== undefined ? options.def : inferred;
  if (def === undefined) throw new Error(`slot ${id} (${role}): the default must be stated when accepts does not pin one node`);
  return {
    id,
    role,
    label: options.label ?? NODE_ROLE_LABELS[role],
    qtyPerUnit,
    required: mode !== 'O',
    blocking: mode === 'RB',
    accepts: [...accepts],
    defaultNodeId: def,
    kind: options.kind ?? 'input',
  };
}

/* -------------------------------------------------------------------------- */
/*  Row builder                                                                */
/* -------------------------------------------------------------------------- */

interface NodeDraft {
  readonly id: string;
  readonly label: string;
  readonly blurb: string;
  readonly sector: Sector;
  readonly tier: NodeTier;
  readonly role: NodeRole;
  readonly maturity: NodeMaturity;
  readonly unit: string;
  readonly sale: NodeSaleKind;
  readonly price: number;
  /** Quarters before a unit sale is replaced. Required for `sale: "unit"`. */
  readonly life?: number;
  /** Commitment length. Required for `sale: "contract"`. */
  readonly term?: number;
  readonly requires?: readonly string[];
  readonly slots?: readonly NodeSlot[];
  readonly capacity?: CapacityKind;
  readonly draw?: number;
  readonly labour?: number;
  readonly energy?: number;
  readonly support?: number;
  readonly computeIntensity?: number;
  readonly talent?: readonly TechCapabilityArea[];
  readonly dataPb?: number;
  /** Customer types and weights. Absent means enterprises only. */
  readonly customers?: Partial<Record<ProductSegment, number>>;
  /** Industries and weights. Absent means derived from the slots that admit this node. */
  readonly industries?: Partial<Record<Sector, number>>;
  /** End demand in units per quarter. Every row has some: an intermediate still has buyers the cast does not model. */
  readonly demand: number;
  readonly elasticity?: number;
  readonly churn?: readonly [number, number];
  readonly dataYield?: number;
  readonly dataSensitivity?: number;
}

function node(draft: NodeDraft): EconomicNode {
  const belief = MATURITY_BELIEF[draft.maturity];
  const [costLow, costHigh] = MATURITY_RESEARCH_COST[draft.maturity];
  // A deeper node is a dearer programme: the tier factor keeps ninety research
  // ranges consistent without ninety hand-picked pairs.
  const tierFactor = 1 + draft.tier * 0.35;
  const churn = draft.churn ?? SALE_CHURN[draft.sale];
  const researchable = draft.tier >= 2;
  return EconomicNodeSchema.parse({
    id: draft.id,
    label: draft.label,
    blurb: draft.blurb,
    sector: draft.sector,
    tier: draft.tier,
    role: draft.role,
    maturity: draft.maturity,
    unitLabel: draft.unit,
    saleKind: draft.sale,
    lifetimeQuarters: draft.sale === 'unit' ? (draft.life ?? 12) : null,
    contractQuarters: draft.sale === 'contract' ? (draft.term ?? 12) : null,
    basePriceUsd: draft.price,
    requires: draft.requires ?? [],
    slots: draft.slots ?? [],
    capacityKind: draft.capacity ?? 'none',
    capacityDrawPerUnit: draft.draw ?? 0,
    labourPerUnit: draft.labour ?? 0,
    energyMwhPerUnit: draft.energy ?? 0,
    supportCostShare: draft.support ?? 0.04,
    researchCostRangeUsd: [Math.round(costLow * tierFactor), Math.round(costHigh * tierFactor)],
    researchComputeIntensity: draft.computeIntensity ?? (draft.sector === 'ai' ? 0.8 : 0.25),
    talentAreas: draft.talent ?? SECTOR_TALENT[draft.sector],
    dataRequiredPb: draft.dataPb ?? 0,
    novelty: belief.novelty,
    plausibility: belief.plausibility,
    researchable,
    publicConfidence: belief.confidence,
    confidenceByCompany: {},
    estimatedWindow: [belief.window[0], belief.window[1]],
    originalProposerId: null,
    visibility: 'public',
    pioneer: null,
    createdQuarter: 0,
    // Industries left empty here are filled by `withDerivedMarkets` once the
    // whole table exists, because the derivation reads every other row's slots.
    market: { customers: draft.customers ?? { enterprise: 1 }, industries: draft.industries ?? {} },
    endDemandBaseUnits: draft.demand,
    elasticity: draft.elasticity ?? 0.8,
    churnBand: { min: churn[0], max: churn[1] },
    dataYieldPerUnitQuarter: draft.dataYield ?? 0,
    dataSensitivity: draft.dataSensitivity ?? 0,
  });
}

/* -------------------------------------------------------------------------- */
/*  Manufacturing — raw materials, semiconductors, batteries, machining        */
/* -------------------------------------------------------------------------- */

const MANUFACTURING_NODES: readonly EconomicNode[] = [
  /* --- tier 0: what comes out of the ground ---------------------------- */
  node({
    id: 'res_silicon_feedstock',
    label: 'Polysilicon',
    blurb: 'Refined silicon feedstock. Everything with a transistor in it starts here.',
    sector: 'manufacturing',
    tier: 0,
    role: 'silicon',
    maturity: 'commodity',
    unit: 'kg',
    sale: 'unit',
    life: 1,
    // 2026: China mono premium about $7/kg, Europe about $21, North America
    // about $26. $11 is the middle of the traded range.
    price: 11,
    demand: 420_000_000,
    elasticity: 1.1,
    capacity: 'plant',
    draw: 0.000_02,
    labour: 0.000_002,
  }),
  node({
    id: 'res_lithium_carbonate',
    label: 'Lithium carbonate',
    blurb: 'Battery-grade lithium salt. The metal every cell chemistry is named after.',
    sector: 'manufacturing',
    tier: 0,
    role: 'lithium',
    maturity: 'commodity',
    unit: 'tonne',
    sale: 'unit',
    life: 1,
    // 2026 assessments ran $8,800 (South America) to $18,300 (Northeast Asia);
    // $18,000 takes the battery-grade end, which is what a cell maker pays.
    price: 18_000,
    demand: 380_000,
    elasticity: 1.3,
    capacity: 'plant',
    draw: 0.9,
    labour: 0.02,
  }),
  node({
    id: 'res_nickel_sulphate',
    label: 'Nickel sulphate',
    blurb: 'Class-one nickel in the form a cathode plant can actually use.',
    sector: 'manufacturing',
    tier: 0,
    role: 'nickel',
    maturity: 'commodity',
    unit: 'tonne',
    sale: 'unit',
    life: 1,
    price: 16_500,
    demand: 260_000,
    elasticity: 1.2,
    capacity: 'plant',
    draw: 0.7,
    labour: 0.015,
  }),
  node({
    id: 'res_graphite',
    label: 'Anode-grade graphite',
    blurb: 'Spherical graphite, natural or synthetic. Half the mass of a cell anode.',
    sector: 'manufacturing',
    tier: 0,
    role: 'graphite',
    maturity: 'commodity',
    unit: 'tonne',
    sale: 'unit',
    life: 1,
    price: 6_000,
    demand: 420_000,
    elasticity: 1.1,
    capacity: 'plant',
    draw: 0.5,
    labour: 0.02,
  }),
  node({
    id: 'res_copper_cathode',
    label: 'Copper cathode',
    blurb: 'Grade-A copper. Every winding, busbar and cable in the economy.',
    sector: 'manufacturing',
    tier: 0,
    role: 'copper',
    maturity: 'commodity',
    unit: 'tonne',
    sale: 'unit',
    life: 1,
    // Around $9,800/t on the exchanges through 2026.
    price: 9_800,
    demand: 6_800_000,
    elasticity: 0.9,
    capacity: 'plant',
    draw: 0.6,
    labour: 0.01,
  }),
  node({
    id: 'res_steel_alloy',
    label: 'Structural steel',
    blurb: 'Hot-rolled alloy plate and section. What large things are made of.',
    sector: 'manufacturing',
    tier: 0,
    role: 'steel',
    maturity: 'commodity',
    unit: 'tonne',
    sale: 'unit',
    life: 1,
    price: 850,
    demand: 420_000_000,
    elasticity: 0.7,
    capacity: 'plant',
    draw: 0.09,
    labour: 0.002,
  }),
  node({
    id: 'res_aluminium',
    label: 'Aluminium billet',
    blurb: 'Extrusion-grade billet. Light structure, heat sinks, vehicle bodies.',
    sector: 'manufacturing',
    tier: 0,
    role: 'aluminium',
    maturity: 'commodity',
    unit: 'tonne',
    sale: 'unit',
    life: 1,
    price: 2_600,
    demand: 18_000_000,
    elasticity: 0.8,
    capacity: 'plant',
    draw: 0.2,
    labour: 0.004,
  }),
  node({
    id: 'res_rare_earth_oxides',
    label: 'Rare earth oxides',
    blurb: 'Neodymium and dysprosium oxide. Small tonnages, enormous leverage.',
    sector: 'manufacturing',
    tier: 0,
    role: 'rare_earth',
    maturity: 'commodity',
    unit: 'kg',
    sale: 'unit',
    life: 1,
    price: 95,
    demand: 42_000_000,
    elasticity: 0.6,
    capacity: 'plant',
    draw: 0.000_2,
    labour: 0.000_02,
  }),
  node({
    // A tier-0 resource rather than a tier-2 material: a fab buys chemicals in
    // and the tier rule forbids a material consuming a material, so the
    // formulation step is folded into the price the fab pays.
    id: 'res_fab_chemicals',
    label: 'Fab chemicals and gases',
    blurb: 'Photoresists, etchants and process gases, priced per wafer set.',
    sector: 'manufacturing',
    tier: 0,
    role: 'chemicals',
    maturity: 'commodity',
    unit: 'wafer set',
    sale: 'unit',
    life: 1,
    price: 600,
    capacity: 'plant',
    draw: 0.001,
    labour: 0.000_4,
    demand: 9_000_000,
    elasticity: 0.5,
  }),
  node({
    id: 'res_specialty_polymers',
    label: 'Specialty polymers',
    blurb: 'Engineering plastics and films: housings, insulation, packaging stock.',
    sector: 'manufacturing',
    tier: 0,
    role: 'polymer',
    maturity: 'commodity',
    unit: 'kg',
    sale: 'unit',
    life: 1,
    price: 3.2,
    demand: 900_000_000,
    elasticity: 1,
    capacity: 'plant',
    draw: 0.000_01,
    labour: 0.000_001,
  }),

  /* --- tier 2: materials ------------------------------------------------ */
  node({
    id: 'mat_wafer_300mm',
    label: '300mm logic wafer',
    blurb: 'A processed advanced-node wafer, out of the fab and ready to dice.',
    sector: 'manufacturing',
    tier: 2,
    role: 'wafer',
    maturity: 'established',
    unit: 'wafer',
    sale: 'unit',
    life: 1,
    // 2026 foundry pricing: about $20,000 at 3nm, $18,500 at 5nm, $9,500 at
    // 7nm. $14,000 is the middle of the leading-edge band. A blank polished
    // wafer is $100-200 of that; the rest is the fab, which is the plant draw.
    price: 14_000,
    slots: [slot('silicon', 'silicon', 1.4, 'R', { def: 'res_silicon_feedstock' }), slot('chemicals', 'chemicals', 1, 'RB', { def: 'res_fab_chemicals' })],
    capacity: 'plant',
    draw: 0.222, // A $20bn leading-edge fab starts roughly 90,000 wafers a quarter.
    labour: 0.004,
    energy: 1.4, // Leading-edge logic runs about 1.4 MWh per wafer.
    support: 0.03,
    talent: ['hardware_design', 'infrastructure'],
    // Fabless designers outside the cast buy wafers too: the world starts about
    // nine million 300mm wafers a quarter, most of them for chips no node here
    // models.
    demand: 9_000_000,
    elasticity: 0.7,
  }),
  node({
    id: 'mat_dram_wafer',
    label: 'DRAM wafer',
    blurb: 'A processed memory wafer. Cheaper node, brutal cyclicality.',
    sector: 'manufacturing',
    tier: 2,
    role: 'wafer',
    maturity: 'established',
    unit: 'wafer',
    sale: 'unit',
    life: 1,
    price: 4_500,
    slots: [slot('silicon', 'silicon', 1.4, 'R', { def: 'res_silicon_feedstock' }), slot('chemicals', 'chemicals', 0.7, 'RB', { def: 'res_fab_chemicals' })],
    capacity: 'plant',
    draw: 0.06,
    labour: 0.002,
    energy: 0.9,
    support: 0.03,
    demand: 4_000_000,
    elasticity: 0.8,
  }),
  node({
    id: 'mat_cathode_active',
    label: 'NMC cathode material',
    blurb: 'Nickel-manganese-cobalt powder. The single largest line in a cell bill of materials.',
    sector: 'manufacturing',
    tier: 2,
    role: 'cathode',
    maturity: 'established',
    unit: 'tonne',
    sale: 'unit',
    life: 1,
    price: 21_000,
    slots: [slot('lithium', 'lithium', 0.25, 'RB', { def: 'res_lithium_carbonate' }), slot('nickel', 'nickel', 0.35, 'R', { def: 'res_nickel_sulphate' })],
    capacity: 'plant',
    draw: 1.2,
    labour: 0.03,
    energy: 8,
    demand: 640_000,
    elasticity: 0.9,
  }),
  node({
    id: 'mat_cathode_lfp',
    label: 'LFP cathode material',
    blurb: 'Lithium iron phosphate powder. Cheaper, safer, heavier: the chemistry that ate the low end.',
    sector: 'manufacturing',
    tier: 2,
    role: 'cathode',
    maturity: 'established',
    unit: 'tonne',
    sale: 'unit',
    life: 1,
    // LFP cathode powder ran roughly $8,000-$10,000/t in 2026 against $20,000+
    // for NMC; iron and phosphate are folded into the plant, as fab chemicals
    // are folded into a wafer.
    price: 9_000,
    slots: [slot('lithium', 'lithium', 0.22, 'RB', { def: 'res_lithium_carbonate' })],
    capacity: 'plant',
    draw: 0.7,
    labour: 0.025,
    energy: 6,
    demand: 900_000,
    elasticity: 1,
  }),
  node({
    id: 'mat_anode_material',
    label: 'Anode material',
    blurb: 'Coated graphite, increasingly with silicon in it. Charge rate lives here.',
    sector: 'manufacturing',
    tier: 2,
    role: 'anode',
    maturity: 'established',
    unit: 'tonne',
    sale: 'unit',
    life: 1,
    price: 9_000,
    slots: [slot('graphite', 'graphite', 1.05, 'RB', { def: 'res_graphite' })],
    capacity: 'plant',
    draw: 0.6,
    labour: 0.02,
    energy: 6,
    demand: 380_000,
    elasticity: 0.9,
  }),
  node({
    id: 'mat_electrolyte_separator',
    label: 'Electrolyte and separator',
    blurb: 'The two thin things between the electrodes that decide whether a cell burns.',
    sector: 'manufacturing',
    tier: 2,
    role: 'electrolyte',
    maturity: 'established',
    unit: 'tonne',
    sale: 'unit',
    life: 1,
    price: 14_000,
    slots: [slot('polymer', 'polymer', 300, 'R', { def: 'res_specialty_polymers' })],
    capacity: 'plant',
    draw: 0.9,
    labour: 0.02,
    energy: 5,
    demand: 210_000,
    elasticity: 0.8,
  }),
  node({
    id: 'mat_permanent_magnet',
    label: 'Permanent magnets',
    blurb: 'Sintered NdFeB. Every efficient motor and generator turns on these.',
    sector: 'manufacturing',
    tier: 2,
    role: 'magnet',
    maturity: 'established',
    unit: 'kg',
    sale: 'unit',
    life: 1,
    price: 75,
    slots: [slot('rare_earth', 'rare_earth', 0.42, 'RB', { def: 'res_rare_earth_oxides' })],
    capacity: 'plant',
    draw: 0.000_6,
    labour: 0.000_08,
    energy: 0.02,
    demand: 62_000_000,
    elasticity: 0.6,
  }),
  node({
    id: 'mat_carbon_composite',
    label: 'Carbon composite',
    blurb: 'Prepreg and laid-up structure. Stiff, light and slow to make.',
    sector: 'manufacturing',
    tier: 2,
    role: 'structure',
    maturity: 'established',
    unit: 'kg',
    sale: 'unit',
    life: 1,
    price: 28,
    slots: [slot('polymer', 'polymer', 0.6, 'R', { def: 'res_specialty_polymers' })],
    capacity: 'plant',
    draw: 0.000_9,
    labour: 0.000_3,
    energy: 0.05,
    demand: 42_000_000,
    elasticity: 0.9,
  }),
  node({
    id: 'mat_machined_structure',
    label: 'Machined structure',
    blurb: 'Precision frames, housings and gearboxes, priced by the kilogram.',
    sector: 'manufacturing',
    tier: 2,
    role: 'structure',
    maturity: 'established',
    unit: 'kg',
    sale: 'unit',
    life: 1,
    price: 34,
    slots: [slot('aluminium', 'aluminium', 0.000_9, 'R', { def: 'res_aluminium' }), slot('steel', 'steel', 0.000_5, 'R', { def: 'res_steel_alloy' })],
    capacity: 'plant',
    draw: 0.001_1,
    labour: 0.000_25,
    energy: 0.02,
    demand: 240_000_000,
    elasticity: 0.9,
  }),

  /* --- tier 3: components ---------------------------------------------- */
  node({
    id: 'cmp_logic_die',
    label: 'Logic die',
    blurb: 'A mainstream advanced-node die, tested and known good.',
    sector: 'manufacturing',
    tier: 3,
    role: 'chip_component',
    maturity: 'established',
    unit: 'die',
    sale: 'unit',
    life: 1,
    // About 45 known-good die per $14,000 wafer at mainstream die sizes.
    price: 420,
    slots: [slot('wafer', 'wafer', 0.022, 'RB', { accepts: ['mat_wafer_300mm'] })],
    capacity: 'plant',
    draw: 0.000_5,
    labour: 0.000_05,
    energy: 0.02,
    demand: 620_000_000,
    elasticity: 0.9,
  }),
  node({
    id: 'cmp_accelerator_die',
    label: 'Accelerator die',
    blurb: 'A reticle-limit compute die. Nine to a wafer if the yield is kind.',
    sector: 'manufacturing',
    tier: 3,
    role: 'chip_component',
    maturity: 'emerging',
    unit: 'die',
    sale: 'unit',
    life: 1,
    // Nine known-good reticle-limit die per $14,000 wafer is about $1,550 of
    // silicon; $1,900 is that plus test and the yield the fab actually gets.
    price: 1_900,
    requires: ['mat_wafer_300mm'],
    slots: [slot('wafer', 'wafer', 0.1, 'RB', { accepts: ['mat_wafer_300mm'] })],
    capacity: 'plant',
    draw: 0.004,
    labour: 0.000_3,
    energy: 0.06,
    talent: ['hardware_design', 'infrastructure'],
    demand: 2_400_000,
    elasticity: 0.6,
  }),
  node({
    id: 'cmp_hbm_stack',
    label: 'HBM stack',
    blurb: 'Twelve-high stacked memory. The part of an accelerator that is scarce.',
    sector: 'manufacturing',
    tier: 3,
    role: 'memory',
    maturity: 'emerging',
    unit: 'stack',
    sale: 'unit',
    life: 1,
    // 12-high HBM3E ran about $300 and reached $500 under 2026 shortage;
    // $400 is the middle and the balance price.
    price: 400,
    requires: ['mat_dram_wafer'],
    slots: [slot('wafer', 'wafer', 0.05, 'RB', { accepts: ['mat_dram_wafer'] })],
    capacity: 'plant',
    draw: 0.001_2,
    labour: 0.000_1,
    energy: 0.03,
    talent: ['hardware_design', 'efficiency'],
    demand: 24_000_000,
    elasticity: 0.5,
  }),
  node({
    id: 'cmp_ic_substrate',
    label: 'IC substrate',
    blurb: 'Build-up film substrate. Unglamorous, and it has been the bottleneck twice.',
    sector: 'manufacturing',
    tier: 3,
    role: 'substrate',
    maturity: 'established',
    unit: 'substrate',
    sale: 'unit',
    life: 1,
    price: 95,
    slots: [slot('polymer', 'polymer', 0.09, 'R', { def: 'res_specialty_polymers' }), slot('copper', 'copper', 0.000_6, 'R', { def: 'res_copper_cathode' })],
    capacity: 'plant',
    draw: 0.000_3,
    labour: 0.000_06,
    energy: 0.01,
    demand: 180_000_000,
    elasticity: 0.8,
  }),
  node({
    id: 'cmp_network_switch_asic',
    label: 'Switch ASIC',
    blurb: 'The fabric silicon that turns seventy-two accelerators into one machine.',
    sector: 'manufacturing',
    tier: 3,
    role: 'chip_component',
    maturity: 'emerging',
    unit: 'die',
    sale: 'unit',
    life: 1,
    price: 2_400,
    requires: ['mat_wafer_300mm'],
    slots: [slot('wafer', 'wafer', 0.03, 'RB', { accepts: ['mat_wafer_300mm'] })],
    capacity: 'plant',
    draw: 0.003,
    labour: 0.000_4,
    energy: 0.05,
    talent: ['hardware_design', 'infrastructure'],
    demand: 1_600_000,
    elasticity: 0.6,
  }),
  node({
    id: 'cmp_battery_cell',
    label: 'NMC battery cell',
    blurb: 'A nickel-manganese-cobalt cell, priced by the kilowatt-hour. Range, at a price.',
    sector: 'manufacturing',
    tier: 3,
    role: 'battery_cell',
    maturity: 'established',
    unit: 'kWh',
    sale: 'unit',
    life: 1,
    // China cell costs run near $50/kWh and Western near $80; $58 is the
    // global mix behind BloombergNEF's $105/kWh pack average for 2026.
    price: 58,
    slots: [
      slot('cathode', 'cathode', 0.001_35, 'RB', { accepts: ['mat_cathode_active'] }),
      slot('anode', 'anode', 0.000_8, 'RB', { def: 'mat_anode_material' }),
      slot('electrolyte', 'electrolyte', 0.000_45, 'RB', { def: 'mat_electrolyte_separator' }),
    ],
    capacity: 'plant',
    draw: 0.000_9,
    labour: 0.000_03,
    energy: 0.04, // Cell manufacture uses roughly 40 kWh per kWh of capacity.
    demand: 620_000_000,
    elasticity: 1,
  }),
  node({
    id: 'cmp_battery_cell_lfp',
    label: 'LFP battery cell',
    blurb: 'An iron-phosphate cell, priced by the kilowatt-hour. Less range, more cycles, no nickel.',
    sector: 'manufacturing',
    tier: 3,
    role: 'battery_cell',
    maturity: 'established',
    unit: 'kWh',
    sale: 'unit',
    life: 1,
    // LFP cells cleared near $45-$55/kWh through 2026, a fifth under NMC.
    price: 48,
    slots: [
      slot('cathode', 'cathode', 0.002_2, 'RB', { accepts: ['mat_cathode_lfp'] }),
      slot('anode', 'anode', 0.000_9, 'RB', { def: 'mat_anode_material' }),
      slot('electrolyte', 'electrolyte', 0.000_45, 'RB', { def: 'mat_electrolyte_separator' }),
    ],
    capacity: 'plant',
    draw: 0.000_8,
    labour: 0.000_03,
    energy: 0.04,
    demand: 700_000_000,
    elasticity: 1.1,
  }),
  node({
    id: 'cmp_power_electronics',
    label: 'Power electronics',
    blurb: 'Inverters and converters, priced by the kilowatt they can move.',
    sector: 'manufacturing',
    tier: 3,
    role: 'power_electronics',
    maturity: 'established',
    unit: 'kW',
    sale: 'unit',
    life: 1,
    price: 55,
    slots: [
      slot('wafer', 'wafer', 0.000_9, 'RB', { accepts: ['mat_wafer_300mm'] }),
      slot('copper', 'copper', 0.000_8, 'R', { def: 'res_copper_cathode' }),
      slot('polymer', 'polymer', 0.12, 'R', { def: 'res_specialty_polymers' }),
    ],
    capacity: 'plant',
    draw: 0.000_5,
    labour: 0.000_07,
    energy: 0.008,
    demand: 92_000_000,
    elasticity: 0.9,
  }),
  node({
    id: 'cmp_electric_drivetrain',
    label: 'Electric drivetrain',
    blurb: 'Motor, reduction and controller as one unit, priced by the kilowatt.',
    sector: 'manufacturing',
    tier: 3,
    role: 'drivetrain',
    maturity: 'established',
    unit: 'kW',
    sale: 'unit',
    life: 1,
    price: 38,
    slots: [
      slot('magnet', 'magnet', 0.14, 'RB', { def: 'mat_permanent_magnet' }),
      slot('copper', 'copper', 0.001_2, 'R', { def: 'res_copper_cathode' }),
      slot('wafer', 'wafer', 0.000_08, 'R', { accepts: ['mat_wafer_300mm'] }),
    ],
    capacity: 'plant',
    draw: 0.000_4,
    labour: 0.000_06,
    energy: 0.006,
    demand: 140_000_000,
    elasticity: 0.9,
  }),
  node({
    id: 'cmp_transformer',
    label: 'Power transformer',
    blurb: 'Large grid transformer, priced by MVA. Four-year lead times and rising.',
    sector: 'manufacturing',
    tier: 3,
    role: 'transformer',
    maturity: 'established',
    unit: 'MVA',
    sale: 'unit',
    life: 1,
    // Large power transformers ran roughly $30,000-$60,000 per MVA in 2026;
    // $45,000 is the middle, and the lead time is the real scarcity.
    price: 45_000,
    slots: [slot('copper', 'copper', 1.1, 'RB', { def: 'res_copper_cathode' }), slot('steel', 'steel', 2.4, 'RB', { def: 'res_steel_alloy' })],
    capacity: 'plant',
    draw: 0.9,
    labour: 0.05,
    energy: 3,
    demand: 480_000,
    elasticity: 0.4,
  }),

  /* --- tier 4-6: assembled semiconductors and packs --------------------- */
  node({
    id: 'sys_advanced_package',
    label: 'Advanced package',
    blurb: 'One compute die and its memory stacks on a single interposer.',
    sector: 'manufacturing',
    tier: 4,
    role: 'package',
    maturity: 'frontier',
    unit: 'package',
    sale: 'unit',
    life: 1,
    // CoWoS-class packaging alone ran $750-$1,100 per chip in 2026; the price
    // here is the finished package, silicon and memory included.
    price: 9_000,
    requires: ['cmp_accelerator_die', 'cmp_hbm_stack'],
    slots: [
      slot('die', 'chip_component', 1, 'RB', { accepts: ['cmp_accelerator_die'] }),
      slot('memory', 'memory', 8, 'RB', { def: 'cmp_hbm_stack' }),
      slot('substrate', 'substrate', 1, 'RB', { def: 'cmp_ic_substrate' }),
    ],
    capacity: 'plant',
    draw: 0.02,
    labour: 0.001_2,
    energy: 0.09,
    talent: ['hardware_design', 'infrastructure'],
    demand: 2_200_000,
    elasticity: 0.5,
  }),
  node({
    id: 'sys_battery_pack',
    label: 'NMC battery pack',
    blurb: 'Nickel-manganese-cobalt cells, cooling and management, priced by the kilowatt-hour.',
    sector: 'manufacturing',
    tier: 4,
    role: 'battery_pack',
    maturity: 'established',
    unit: 'kWh',
    sale: 'unit',
    life: 32,
    // BloombergNEF: pack prices averaged $108/kWh in 2025 and were forecast to
    // fall about 3% to $105/kWh in 2026.
    price: 105,
    slots: [
      slot('cell', 'battery_cell', 1, 'RB', { accepts: ['cmp_battery_cell'] }),
      slot('power', 'power_electronics', 0.1, 'R', { def: 'cmp_power_electronics' }),
      slot('structure', 'structure', 0.25, 'R', { def: 'mat_machined_structure' }),
    ],
    capacity: 'plant',
    draw: 0.000_6,
    labour: 0.000_04,
    energy: 0.02,
    demand: 320_000_000,
    elasticity: 1,
  }),
  node({
    id: 'sys_battery_pack_lfp',
    label: 'LFP battery pack',
    blurb: 'Iron-phosphate cells, cooling and management, priced by the kilowatt-hour. The fleet chemistry.',
    sector: 'manufacturing',
    tier: 4,
    role: 'battery_pack',
    maturity: 'established',
    unit: 'kWh',
    sale: 'unit',
    life: 32,
    // LFP packs cleared near $85-$95/kWh in 2026; a heavier pack carries a
    // little more structure per kilowatt-hour than an NMC one.
    price: 88,
    slots: [
      slot('cell', 'battery_cell', 1, 'RB', { accepts: ['cmp_battery_cell_lfp'] }),
      slot('power', 'power_electronics', 0.1, 'R', { def: 'cmp_power_electronics' }),
      slot('structure', 'structure', 0.28, 'R', { def: 'mat_machined_structure' }),
    ],
    capacity: 'plant',
    draw: 0.000_6,
    labour: 0.000_04,
    energy: 0.02,
    demand: 380_000_000,
    elasticity: 1.1,
  }),
  node({
    id: 'sys_ai_accelerator',
    label: 'AI accelerator',
    blurb: 'One board of frontier compute. The unit every training budget is counted in.',
    sector: 'manufacturing',
    tier: 5,
    role: 'accelerator',
    maturity: 'frontier',
    unit: 'accelerator',
    sale: 'unit',
    life: 14,
    // Street prices for H200-class parts ran $30,000-$40,000 in 2026 under
    // acute shortage. $20,000 is the balance price: cost plus a fab margin,
    // which is what the market clears at once supply catches up.
    price: 20_000,
    requires: ['sys_advanced_package'],
    slots: [
      slot('package', 'package', 1, 'RB', { def: 'sys_advanced_package' }),
      slot('power', 'power_electronics', 2, 'R', { def: 'cmp_power_electronics' }),
      slot('structure', 'structure', 3, 'R', { def: 'mat_machined_structure' }),
    ],
    capacity: 'plant',
    draw: 0.03,
    labour: 0.002,
    energy: 0.4,
    talent: ['hardware_design', 'infrastructure', 'efficiency'],
    demand: 1_500_000,
    elasticity: 0.5,
    dataYield: 0.000_01,
  }),
  node({
    id: 'sys_ai_server_rack',
    label: 'AI server rack',
    blurb: 'Seventy-two accelerators wired as one machine, delivered on a pallet.',
    sector: 'manufacturing',
    tier: 6,
    role: 'rack',
    maturity: 'frontier',
    unit: 'rack',
    sale: 'unit',
    life: 14,
    // A GB200/GB300 NVL72 rack was quoted at $2.8m-$3.4m through 2026.
    price: 3_000_000,
    requires: ['sys_ai_accelerator'],
    slots: [
      slot('accelerators', 'accelerator', 72, 'RB', { def: 'sys_ai_accelerator', label: 'Accelerators' }),
      slot('fabric', 'chip_component', 18, 'RB', { accepts: ['cmp_network_switch_asic'], label: 'Fabric' }),
      slot('power', 'power_electronics', 140, 'R', { def: 'cmp_power_electronics' }),
      slot('structure', 'structure', 900, 'R', { def: 'mat_machined_structure' }),
      slot('transformer', 'transformer', 0.15, 'R', { def: 'cmp_transformer' }),
    ],
    capacity: 'plant',
    draw: 1.4,
    labour: 0.12,
    energy: 12,
    talent: ['infrastructure', 'hardware_design'],
    demand: 4_000,
    elasticity: 0.4,
    dataYield: 0.000_8,
  }),
];

/* -------------------------------------------------------------------------- */
/*  Energy                                                                     */
/* -------------------------------------------------------------------------- */

/** Where the grid's power and the datacentres it feeds are actually sold. */
const POWER_BUYER_INDUSTRIES: Partial<Record<Sector, number>> = { ai: 0.4, manufacturing: 0.3, logistics: 0.1, consumer: 0.1, energy: 0.1 };

const ENERGY_NODES: readonly EconomicNode[] = [
  node({
    id: 'res_natural_gas',
    label: 'Natural gas',
    blurb: 'Delivered gas. Still the marginal fuel, so still the marginal price.',
    sector: 'energy',
    tier: 0,
    role: 'fuel',
    maturity: 'commodity',
    unit: 'MMBtu',
    sale: 'unit',
    life: 1,
    // Henry Hub was projected to average about $4.00/MMBtu in 2026.
    price: 4,
    demand: 9_400_000_000,
    elasticity: 0.6,
    capacity: 'grid',
    draw: 0.000_02,
    labour: 0.000_001,
  }),
  node({
    id: 'res_uranium_fuel',
    label: 'Uranium fuel',
    blurb: 'Enriched fuel assemblies, priced back to the pound of yellowcake.',
    sector: 'energy',
    tier: 0,
    role: 'fuel',
    maturity: 'commodity',
    unit: 'lb U3O8',
    sale: 'unit',
    life: 1,
    price: 82,
    demand: 48_000_000,
    elasticity: 0.3,
    capacity: 'grid',
    draw: 0.001,
    labour: 0.000_05,
  }),
  node({
    id: GRID_POWER_NODE_ID,
    label: 'Grid power',
    blurb: 'A megawatt-hour delivered at the wholesale node. Every other node buys this.',
    sector: 'energy',
    tier: 1,
    role: 'grid_power',
    maturity: 'commodity',
    unit: 'MWh',
    sale: 'unit',
    life: 1,
    // The EIA's load-weighted average of eleven regional wholesale prices was
    // forecast at $51/MWh for 2026, up from $47 in 2025.
    price: 51,
    slots: [
      // Two fuels, two slots: a unit of gas and a unit of uranium are not the
      // same thing, so one slot of role `fuel` could not carry one quantity.
      slot('gas', 'fuel', 6.9, 'R', { accepts: ['res_natural_gas'], label: 'Gas' }), // A modern combined-cycle heat rate.
      slot('uranium', 'fuel', 0.005, 'R', { accepts: ['res_uranium_fuel'], label: 'Uranium' }),
    ],
    capacity: 'grid',
    draw: 0.000_4,
    labour: 0.000_002,
    energy: 0, // INVARIANT: power cannot consume itself.
    industries: POWER_BUYER_INDUSTRIES,
    demand: 900_000_000,
    elasticity: 0.4,
  }),
  node({
    id: 'mat_solar_module',
    label: 'Solar module',
    blurb: 'A 600-watt panel off the line. The cheapest electron-maker ever built.',
    sector: 'energy',
    tier: 2,
    role: 'solar_module',
    maturity: 'commodity',
    unit: 'panel',
    sale: 'unit',
    life: 80,
    // About $0.10 per watt in 2026, so roughly $60 for a 600 W module.
    price: 60,
    slots: [
      slot('silicon', 'silicon', 1.4, 'RB', { def: 'res_silicon_feedstock' }),
      slot('aluminium', 'aluminium', 0.004, 'R', { def: 'res_aluminium' }),
      slot('polymer', 'polymer', 1.4, 'R', { def: 'res_specialty_polymers' }),
    ],
    capacity: 'plant',
    draw: 0.000_4,
    labour: 0.000_05,
    energy: 0.35,
    customers: { consumer: 1 },
    demand: 190_000_000,
    elasticity: 1.4,
  }),
  node({
    id: 'sys_electrolyser_stack',
    label: 'Electrolyser stack',
    blurb: 'The stack that turns cheap power into hydrogen, priced by the megawatt.',
    sector: 'energy',
    tier: 4,
    role: 'electrolyser',
    maturity: 'emerging',
    unit: 'MW',
    sale: 'unit',
    life: 40,
    // A complete electrolyser plant runs $300,000-$500,000 per MW; this is the
    // stack itself, which is roughly a third to a half of that.
    price: 160_000,
    slots: [
      slot('power', 'power_electronics', 1_000, 'RB', { def: 'cmp_power_electronics' }),
      slot('rare_earth', 'rare_earth', 20, 'R', { def: 'res_rare_earth_oxides' }),
      slot('steel', 'steel', 12, 'R', { def: 'res_steel_alloy' }),
    ],
    capacity: 'plant',
    draw: 1.1,
    labour: 0.09,
    energy: 4,
    talent: ['efficiency', 'infrastructure'],
    demand: 1_800,
    elasticity: 1.1,
  }),
  node({
    id: 'sys_solar_array',
    label: 'Solar array',
    blurb: 'A megawatt of panels, racking and inverters, shipped ready to build.',
    sector: 'energy',
    tier: 4,
    role: 'generation_asset',
    maturity: 'established',
    unit: 'MW',
    sale: 'unit',
    life: 80,
    // Utility solar lands near $0.90-$1.10 per watt installed; $600,000/MW is
    // the equipment, the rest being site construction and the plant draw.
    price: 600_000,
    slots: [
      slot('modules', 'solar_module', 1_667, 'RB', { def: 'mat_solar_module', label: 'Panels' }),
      slot('power', 'power_electronics', 1_100, 'RB', { def: 'cmp_power_electronics' }),
      slot('transformer', 'transformer', 1.1, 'RB', { def: 'cmp_transformer' }),
      slot('steel', 'steel', 45, 'R', { def: 'res_steel_alloy' }),
    ],
    capacity: 'grid',
    draw: 0.6,
    labour: 0.14,
    energy: 8,
    demand: 62_000,
    elasticity: 1.2,
  }),
  node({
    id: 'sys_wind_turbine',
    label: 'Wind turbine',
    blurb: 'A megawatt of onshore turbine: blades, nacelle and tower, delivered by road.',
    sector: 'energy',
    tier: 4,
    role: 'generation_asset',
    maturity: 'established',
    unit: 'MW',
    sale: 'unit',
    life: 80,
    // Onshore turbine supply runs roughly $0.9m-$1.1m per MW. Priced per
    // megawatt so a power purchase agreement can choose between solar, wind and
    // an SMR in one unit; a six-megawatt machine is six of these.
    price: 1_000_000,
    slots: [
      slot('structure', 'structure', 10_000, 'RB', { def: 'mat_carbon_composite' }),
      slot('power', 'power_electronics', 1_000, 'RB', { def: 'cmp_power_electronics' }),
      slot('magnet', 'magnet', 333, 'RB', { def: 'mat_permanent_magnet' }),
      slot('steel', 'steel', 50, 'R', { def: 'res_steel_alloy' }),
    ],
    capacity: 'plant',
    draw: 0.92,
    labour: 0.18,
    energy: 150,
    demand: 28_800,
    elasticity: 0.8,
  }),
  node({
    id: 'sys_smr_module',
    label: 'SMR module',
    blurb: 'A factory-built reactor module, priced by the megawatt it will carry.',
    sector: 'energy',
    tier: 4,
    role: 'generation_asset',
    maturity: 'frontier',
    unit: 'MW',
    sale: 'unit',
    life: 80,
    // A complete SMR plant runs near $6m/MW overnight; $2.3m/MW is the
    // factory-built module itself, the balance being site construction.
    price: 2_300_000,
    requires: ['cmp_transformer'],
    slots: [
      slot('steel', 'steel', 700, 'RB', { def: 'res_steel_alloy' }),
      slot('structure', 'structure', 8_000, 'RB', { def: 'mat_machined_structure' }),
      slot('transformer', 'transformer', 1.2, 'RB', { def: 'cmp_transformer' }),
      slot('power', 'power_electronics', 1_100, 'R', { def: 'cmp_power_electronics' }),
    ],
    capacity: 'plant',
    draw: 3.2,
    labour: 0.9,
    energy: 260,
    talent: ['infrastructure', 'safety_alignment'],
    customers: { government: 1 },
    demand: 900,
    elasticity: 0.3,
  }),
  node({
    id: 'sys_grid_storage_system',
    label: 'Grid storage system',
    blurb: 'A megawatt-hour of containerised storage, inverter and controls included.',
    sector: 'energy',
    tier: 4,
    role: 'storage',
    maturity: 'established',
    unit: 'MWh',
    sale: 'unit',
    life: 48,
    // Stationary storage packs fell to about $70/kWh in 2025; a delivered
    // system with power conversion and controls lands near $150/kWh.
    price: 150_000,
    slots: [
      slot('cell', 'battery_cell', 1_000, 'RB', { def: 'cmp_battery_cell_lfp' }),
      slot('power', 'power_electronics', 250, 'RB', { def: 'cmp_power_electronics' }),
      slot('structure', 'structure', 400, 'R', { def: 'mat_machined_structure' }),
    ],
    capacity: 'grid',
    draw: 0.14,
    labour: 0.03,
    energy: 20,
    demand: 92_000,
    elasticity: 1,
  }),
  node({
    id: 'sys_substation',
    label: 'Substation',
    blurb: 'A megavolt-ampere of switchgear and transformation between two voltages.',
    sector: 'energy',
    tier: 4,
    role: 'substation',
    maturity: 'established',
    unit: 'MVA',
    sale: 'unit',
    life: 80,
    price: 140_000,
    slots: [
      slot('transformer', 'transformer', 1, 'RB', { def: 'cmp_transformer' }),
      slot('copper', 'copper', 1.5, 'RB', { def: 'res_copper_cathode' }),
      slot('steel', 'steel', 8, 'R', { def: 'res_steel_alloy' }),
      slot('power', 'power_electronics', 60, 'R', { def: 'cmp_power_electronics' }),
    ],
    capacity: 'grid',
    draw: 0.12,
    labour: 0.04,
    energy: 2,
    demand: 220_000,
    elasticity: 0.4,
  }),
  node({
    id: 'svc_hydrogen_supply',
    label: 'Hydrogen supply',
    blurb: 'Electrolytic hydrogen by the tonne. Mostly a very expensive way to store power.',
    sector: 'energy',
    tier: 5,
    role: 'energy_service',
    maturity: 'emerging',
    unit: 'tonne H2',
    sale: 'unit',
    life: 1,
    price: 4_200,
    requires: ['sys_electrolyser_stack'],
    slots: [slot('electrolyser', 'electrolyser', 0.000_02, 'RB', { def: 'sys_electrolyser_stack' })],
    capacity: 'grid',
    draw: 0.02,
    labour: 0.002,
    energy: 55, // Electrolysis needs roughly 55 MWh per tonne of hydrogen.
    talent: ['efficiency', 'infrastructure'],
    demand: 2_400_000,
    elasticity: 1.3,
  }),
  node({
    id: 'svc_grid_interconnect',
    label: 'Grid interconnection',
    blurb: 'Firm connection rights, per megawatt per quarter. The real queue in this economy.',
    sector: 'energy',
    tier: 5,
    role: 'interconnect',
    maturity: 'established',
    unit: 'MW-quarter',
    sale: 'contract',
    term: 16,
    price: 9_000,
    requires: ['sys_substation'],
    slots: [slot('substation', 'substation', 0.012, 'RB', { def: 'sys_substation' })],
    capacity: 'grid',
    draw: 0.05,
    labour: 0.004,
    energy: 22,
    demand: 180_000,
    elasticity: 0.3,
  }),
  node({
    id: 'svc_power_purchase_agreement',
    label: 'Power purchase agreement',
    blurb: 'Twenty quarters of firm supply at a fixed price, per megawatt per quarter.',
    sector: 'energy',
    tier: 6,
    role: 'energy_service',
    maturity: 'established',
    unit: 'MW-quarter',
    sale: 'contract',
    term: 20,
    // One megawatt held for a quarter is about 2,184 MWh; at $51 that is
    // $111,000 of energy, and $118,000 is that plus the firming premium.
    price: 118_000,
    slots: [
      slot('interconnect', 'interconnect', 1, 'RB', { def: 'svc_grid_interconnect' }),
      // The plant behind the contract: a megawatt of generation is bought once
      // and amortised over the agreement, so a quarter of one megawatt draws
      // three percent of one. Solar, wind or an SMR: the buyer's call.
      slot('generation', 'generation_asset', 0.03, 'R', { def: 'sys_solar_array' }),
    ],
    capacity: 'grid',
    // A generator does not buy this power at the wholesale index and resell it;
    // it builds a plant, and the plant is now the generation slot above. The
    // megawatt-quarter draws what the slot does not carry — land, firming and
    // the balance of construction — and energyMwhPerUnit is zero on purpose.
    draw: 0.5,
    labour: 0.002,
    energy: 0,
    industries: POWER_BUYER_INDUSTRIES,
    demand: 220_000,
    elasticity: 0.5,
  }),
  node({
    id: 'svc_datacentre_capacity',
    label: 'Datacentre capacity',
    blurb: 'A megawatt of IT load, powered and cooled, per quarter. What compute actually sits in.',
    sector: 'energy',
    tier: 6,
    role: 'energy_service',
    maturity: 'emerging',
    unit: 'MW-quarter',
    sale: 'contract',
    term: 20,
    // Standard facilities cost $10m-$13m per MW to build in 2026 and AI-ready
    // ones $20m-$37m; leased capacity clears near $450,000 per MW-quarter.
    price: 450_000,
    requires: ['svc_grid_interconnect'],
    slots: [
      slot('interconnect', 'interconnect', 1, 'RB', { def: 'svc_grid_interconnect' }),
      slot('storage', 'storage', 0.03, 'O', { def: 'sys_grid_storage_system' }),
    ],
    capacity: 'grid',
    draw: 3.6,
    labour: 0.4,
    energy: 2_730, // 2,184 MWh of IT load at a power usage effectiveness of 1.25.
    talent: ['infrastructure', 'efficiency'],
    industries: POWER_BUYER_INDUSTRIES,
    demand: 62_000,
    elasticity: 0.6,
    dataYield: 0.002,
  }),
  node({
    id: 'svc_grid_balancing',
    label: 'Grid balancing',
    blurb: 'Frequency response and reserve, sold by the megawatt-quarter to the system operator.',
    sector: 'energy',
    tier: 6,
    role: 'energy_service',
    maturity: 'established',
    unit: 'MW-quarter',
    sale: 'recurring',
    price: 26_000,
    slots: [slot('storage', 'storage', 0.02, 'RB', { def: 'sys_grid_storage_system' })],
    capacity: 'grid',
    draw: 0.09,
    labour: 0.003,
    energy: 90,
    customers: { government: 1 },
    demand: 84_000,
    elasticity: 0.4,
  }),
];

/* -------------------------------------------------------------------------- */
/*  AI                                                                         */
/* -------------------------------------------------------------------------- */

/** A model licence is bought by enterprises and by the developers who serve them. */
const MODEL_CUSTOMERS: Partial<Record<ProductSegment, number>> = { enterprise: 0.6, developer_api: 0.4 };

/** An application ships on a device when its owner says so; by default it ships on nothing. */
const DELIVERY_SLOT = slot('delivery', 'device', 0.02, 'O', { def: null, kind: 'delivery' });

const AI_NODES: readonly EconomicNode[] = [
  node({
    id: 'dat_web_corpus',
    label: 'Curated corpus',
    blurb: 'Cleaned, deduplicated, rights-cleared text and video, priced by the terabyte.',
    sector: 'ai',
    tier: 2,
    role: 'dataset',
    maturity: 'established',
    unit: 'TB curated',
    sale: 'unit',
    life: 12,
    price: 18_000,
    capacity: 'none',
    labour: 0.02,
    energy: 0.4,
    talent: ['data_curation', 'retrieval'],
    dataPb: 0.2,
    demand: 42_000,
    elasticity: 1.1,
    dataSensitivity: 0.55,
  }),
  node({
    id: 'dat_preference_data',
    label: 'Preference data',
    blurb: 'Expert-graded comparisons. Ten thousand judgements at a time.',
    sector: 'ai',
    tier: 2,
    role: 'dataset',
    maturity: 'established',
    unit: '10k samples',
    sale: 'unit',
    life: 8,
    price: 60_000,
    capacity: 'none',
    labour: 0.9,
    talent: ['evaluation', 'data_curation'],
    dataPb: 0.01,
    demand: 9_000,
    elasticity: 0.9,
    dataSensitivity: 0.4,
  }),
  node({
    id: 'svc_training_run',
    label: 'Training run',
    blurb: 'A block of training compute sold as a service, priced per 10^24 FLOP.',
    sector: 'ai',
    tier: 3,
    role: 'training_compute',
    maturity: 'emerging',
    unit: '1e24 FLOP',
    sale: 'unit',
    life: 1,
    price: 300_000,
    slots: [slot('corpus', 'dataset', 0.5, 'R', { accepts: ['dat_web_corpus'], label: 'Corpus' })],
    capacity: 'compute',
    // 126 accelerators held for one quarter is about 10^24 FLOP of useful work.
    draw: 126,
    labour: 0.02,
    // 126 accelerators at 1.2 kW for 2,184 hours is roughly 330 MWh.
    energy: 330,
    computeIntensity: 1,
    talent: ['training_systems', 'infrastructure'],
    customers: { developer_api: 1 },
    demand: 62_000,
    elasticity: 1.2,
    dataYield: 0.000_2,
  }),
  node({
    id: 'svc_model_evaluation',
    label: 'Model evaluation',
    blurb: 'Independent capability and safety testing, sold per evaluated model.',
    sector: 'ai',
    tier: 3,
    role: 'evaluation',
    maturity: 'emerging',
    unit: 'evaluation',
    sale: 'unit',
    life: 1,
    price: 140_000,
    slots: [slot('preference', 'dataset', 1.2, 'RB', { accepts: ['dat_preference_data'], label: 'Preferences' })],
    capacity: 'compute',
    draw: 4,
    labour: 0.6,
    energy: 11,
    computeIntensity: 0.5,
    talent: ['evaluation', 'safety_alignment'],
    demand: 3_200,
    elasticity: 0.7,
    dataYield: 0.000_4,
  }),
  node({
    id: 'sys_frontier_model',
    label: 'Frontier model',
    blurb: 'A trained and aligned frontier model, licensed for eight quarters at a time.',
    sector: 'ai',
    tier: 4,
    role: 'model',
    maturity: 'frontier',
    unit: 'licence',
    sale: 'unit',
    life: 8,
    price: 22_000_000,
    requires: ['svc_training_run', 'dat_web_corpus'],
    slots: [
      slot('compute', 'training_compute', 40, 'RB', { def: 'svc_training_run' }),
      slot('corpus', 'dataset', 180, 'RB', { accepts: ['dat_web_corpus'], label: 'Corpus' }),
      slot('preference', 'dataset', 15, 'RB', { accepts: ['dat_preference_data'], label: 'Preferences' }),
      slot('evaluation', 'evaluation', 1, 'O', { def: 'svc_model_evaluation' }),
    ],
    capacity: 'compute',
    draw: 40,
    labour: 12,
    computeIntensity: 1,
    talent: ['reasoning', 'training_systems', 'safety_alignment', 'evaluation'],
    dataPb: 8,
    customers: MODEL_CUSTOMERS,
    demand: 90,
    elasticity: 0.6,
    dataYield: 0.02,
    dataSensitivity: 0.5,
  }),
  node({
    id: 'sys_efficient_small_model',
    label: 'Small model',
    blurb: 'A distilled model that fits on one accelerator. Most of the capability, a tenth of the cost.',
    sector: 'ai',
    tier: 4,
    role: 'model',
    maturity: 'emerging',
    unit: 'licence',
    sale: 'unit',
    life: 8,
    price: 2_400_000,
    requires: ['svc_training_run'],
    slots: [
      slot('compute', 'training_compute', 4, 'RB', { def: 'svc_training_run' }),
      slot('corpus', 'dataset', 30, 'RB', { accepts: ['dat_web_corpus'], label: 'Corpus' }),
      slot('evaluation', 'evaluation', 1, 'O', { def: null }),
    ],
    capacity: 'compute',
    draw: 6,
    labour: 3,
    computeIntensity: 0.6,
    talent: ['efficiency', 'training_systems'],
    dataPb: 1.5,
    customers: MODEL_CUSTOMERS,
    demand: 640,
    elasticity: 1,
    dataYield: 0.004,
    dataSensitivity: 0.35,
  }),
  node({
    id: 'svc_inference_api',
    label: 'Inference API',
    blurb: 'Tokens served on demand, priced per million. The meter the whole industry runs on.',
    sector: 'ai',
    tier: 5,
    role: 'inference_api',
    maturity: 'established',
    unit: '1M tokens',
    sale: 'unit',
    life: 1,
    // Frontier APIs ran $2.50-$15 per million tokens in and out through 2026;
    // $6.00 is the blended middle.
    price: 6,
    requires: ['sys_frontier_model'],
    // ONE slot, and it is the choice the owner asked for: the model behind the
    // API. A licence serves about twenty million million-token units over its
    // eight quarters, so one unit draws a twenty-millionth of one.
    slots: [slot('model', 'model', 0.000_000_05, 'R', { def: 'sys_frontier_model' })],
    capacity: 'compute',
    // One accelerator serves roughly 30,000 million-token units a quarter.
    draw: 0.000_033_3,
    labour: 0.000_000_2,
    energy: 0.000_09,
    support: 0.05,
    computeIntensity: 0.9,
    talent: ['infrastructure', 'efficiency'],
    customers: { developer_api: 0.7, enterprise: 0.3 },
    industries: { ai: 0.5, consumer: 0.2, logistics: 0.1, robotics: 0.1, manufacturing: 0.1 },
    demand: 900_000_000,
    elasticity: 1.4,
    dataYield: 0.000_000_1,
    dataSensitivity: 0.6,
  }),
  node({
    id: 'svc_agent_harness',
    label: 'Agent harness',
    blurb: 'Tools, memory, sandboxing and orchestration around any model. What turns tokens into work.',
    sector: 'ai',
    tier: 5,
    role: 'harness',
    maturity: 'emerging',
    unit: 'seat',
    sale: 'recurring',
    // Agent runtimes and orchestration platforms billed $100-$250 a seat a
    // month in 2026; $180 a quarter is a platform licence, not the tokens.
    price: 180,
    capacity: 'compute',
    draw: 0.000_2,
    labour: 0.000_05,
    support: 0.08,
    computeIntensity: 0.5,
    talent: ['agents', 'security'],
    demand: 6_000_000,
    elasticity: 0.9,
    churn: [0.05, 0.12],
    dataYield: 0.000_001,
    dataSensitivity: 0.5,
  }),
  node({
    id: 'svc_copilot_framework',
    label: 'Copilot framework',
    blurb: 'Retrieval, prompting and guardrails packaged for the workaday application. Narrower, cheaper, everywhere.',
    sector: 'ai',
    tier: 5,
    role: 'harness',
    maturity: 'established',
    unit: 'seat',
    sale: 'recurring',
    price: 120,
    capacity: 'compute',
    draw: 0.000_1,
    labour: 0.000_03,
    support: 0.07,
    computeIntensity: 0.4,
    talent: ['retrieval', 'agents'],
    demand: 9_000_000,
    elasticity: 1,
    churn: [0.06, 0.14],
    dataYield: 0.000_000_5,
    dataSensitivity: 0.45,
  }),
  node({
    id: 'app_agent_platform',
    label: 'Agent platform',
    blurb: 'Tools, memory and orchestration around a model, sold by the seat.',
    sector: 'ai',
    tier: 6,
    role: 'app',
    maturity: 'emerging',
    unit: 'seat',
    sale: 'recurring',
    price: 2_400,
    requires: ['svc_inference_api'],
    slots: [
      slot('model', 'inference_api', 90, 'R', { def: 'svc_inference_api', label: 'Model' }),
      slot('harness', 'harness', 1, 'R', { def: 'svc_agent_harness' }),
      DELIVERY_SLOT,
    ],
    capacity: 'compute',
    draw: 0.003,
    labour: 0.000_6,
    support: 0.09,
    computeIntensity: 0.7,
    talent: ['agents', 'reasoning', 'security'],
    demand: 14_000_000,
    elasticity: 0.7,
    churn: [0.04, 0.11],
    dataYield: 0.000_002,
    dataSensitivity: 0.7,
  }),
  node({
    id: 'app_ai_software_suite',
    label: 'AI software suite',
    blurb: 'The workaday enterprise application with a model behind every field.',
    sector: 'ai',
    tier: 6,
    role: 'app',
    maturity: 'established',
    unit: 'seat',
    sale: 'recurring',
    price: 1_500,
    slots: [
      slot('model', 'inference_api', 40, 'R', { def: 'svc_inference_api', label: 'Model' }),
      slot('harness', 'harness', 1, 'R', { def: 'svc_copilot_framework' }),
      DELIVERY_SLOT,
    ],
    capacity: 'compute',
    draw: 0.001_2,
    labour: 0.000_5,
    support: 0.1,
    computeIntensity: 0.4,
    talent: ['reasoning', 'retrieval'],
    demand: 46_000_000,
    elasticity: 0.8,
    churn: [0.03, 0.09],
    dataYield: 0.000_001,
    dataSensitivity: 0.65,
  }),
  node({
    id: 'app_vertical_ai_app',
    label: 'Vertical application',
    blurb: 'One industry, one workflow, one model tuned to it. Narrow and sticky.',
    sector: 'ai',
    tier: 6,
    role: 'app',
    maturity: 'emerging',
    unit: 'seat',
    sale: 'recurring',
    price: 900,
    slots: [
      slot('model', 'inference_api', 22, 'R', { def: 'svc_inference_api', label: 'Model' }),
      slot('harness', 'harness', 1, 'R', { def: 'svc_copilot_framework' }),
      DELIVERY_SLOT,
    ],
    capacity: 'compute',
    draw: 0.000_7,
    labour: 0.000_4,
    support: 0.12,
    computeIntensity: 0.35,
    talent: ['retrieval', 'evaluation'],
    demand: 62_000_000,
    elasticity: 0.9,
    churn: [0.04, 0.1],
    dataYield: 0.000_001,
    dataSensitivity: 0.6,
  }),
  node({
    id: 'app_developer_tooling',
    label: 'Developer tooling',
    blurb: 'An agent in the terminal that writes, runs and fixes code, sold by the seat to the people who build everything else.',
    sector: 'ai',
    tier: 6,
    role: 'app',
    maturity: 'emerging',
    unit: 'seat',
    sale: 'recurring',
    // Agentic coding seats billed $100-$200 a month per developer in 2026;
    // $600 a quarter is the middle of that.
    price: 600,
    slots: [
      slot('model', 'inference_api', 40, 'R', { def: 'svc_inference_api', label: 'Model' }),
      slot('harness', 'harness', 1, 'R', { def: 'svc_agent_harness' }),
      DELIVERY_SLOT,
    ],
    capacity: 'compute',
    draw: 0.001_5,
    labour: 0.000_2,
    support: 0.08,
    computeIntensity: 0.6,
    talent: ['agents', 'reasoning'],
    customers: { developer_api: 0.6, enterprise: 0.4 },
    demand: 8_000_000,
    elasticity: 0.9,
    churn: [0.04, 0.1],
    dataYield: 0.000_002,
    dataSensitivity: 0.6,
  }),
];

/* -------------------------------------------------------------------------- */
/*  Robotics                                                                   */
/* -------------------------------------------------------------------------- */

/** Where robots go to work. */
const ROBOT_INDUSTRIES: Partial<Record<Sector, number>> = { manufacturing: 0.4, logistics: 0.4, consumer: 0.1, energy: 0.1 };

const ROBOTICS_NODES: readonly EconomicNode[] = [
  node({
    id: 'dat_robot_telemetry',
    label: 'Robot telemetry',
    blurb: 'Hours of real manipulation and failure, priced by the petabyte. The scarce input.',
    sector: 'robotics',
    tier: 2,
    role: 'dataset',
    maturity: 'emerging',
    unit: 'PB',
    sale: 'unit',
    life: 12,
    price: 180_000,
    capacity: 'none',
    labour: 0.4,
    energy: 1.2,
    talent: ['data_curation', 'agents'],
    dataPb: 1,
    demand: 2_600,
    elasticity: 1,
    dataSensitivity: 0.25,
  }),
  node({
    id: 'cmp_precision_actuator',
    label: 'Precision actuator',
    blurb: 'Motor, harmonic drive, encoder and brake as one joint.',
    sector: 'robotics',
    tier: 3,
    role: 'actuator',
    maturity: 'established',
    unit: 'actuator',
    sale: 'unit',
    life: 28,
    price: 850,
    slots: [
      slot('magnet', 'magnet', 0.9, 'RB', { def: 'mat_permanent_magnet' }),
      slot('structure', 'structure', 3.2, 'RB', { accepts: ['mat_machined_structure'] }),
      slot('wafer', 'wafer', 0.000_4, 'R', { accepts: ['mat_wafer_300mm'] }),
    ],
    capacity: 'plant',
    draw: 0.001_4,
    labour: 0.000_2,
    energy: 0.03,
    demand: 12_000_000,
    elasticity: 0.9,
  }),
  node({
    id: 'cmp_hydraulic_actuator',
    label: 'Hydraulic actuator',
    blurb: 'Pump, valve and cylinder as one joint. Brute force where a motor would stall.',
    sector: 'robotics',
    tier: 3,
    role: 'actuator',
    maturity: 'established',
    unit: 'actuator',
    sale: 'unit',
    life: 24,
    // Industrial servo-hydraulic actuators ran $1,200-$2,500 in 2026.
    price: 1_600,
    slots: [
      slot('structure', 'structure', 6, 'RB', { accepts: ['mat_machined_structure'] }),
      // A valve solenoid is wound copper, not an inverter: power electronics
      // sit at this actuator's own tier and could not be its input.
      slot('copper', 'copper', 0.002, 'R', { def: 'res_copper_cathode' }),
      slot('steel', 'steel', 0.002, 'R', { def: 'res_steel_alloy' }),
    ],
    capacity: 'plant',
    draw: 0.002_2,
    labour: 0.000_4,
    energy: 0.05,
    demand: 3_000_000,
    elasticity: 0.9,
  }),
  node({
    id: 'cmp_sensor_suite',
    label: 'Sensor suite',
    blurb: 'Depth, vision and inertial sensing calibrated as one head.',
    sector: 'robotics',
    tier: 3,
    role: 'sensor',
    maturity: 'established',
    unit: 'suite',
    sale: 'unit',
    life: 24,
    price: 1_400,
    slots: [
      slot('wafer', 'wafer', 0.008, 'RB', { accepts: ['mat_wafer_300mm'] }),
      slot('structure', 'structure', 1.4, 'R', { def: 'mat_machined_structure' }),
      slot('polymer', 'polymer', 0.6, 'R', { def: 'res_specialty_polymers' }),
    ],
    capacity: 'plant',
    draw: 0.001_1,
    labour: 0.000_2,
    energy: 0.02,
    demand: 6_400_000,
    elasticity: 1,
  }),
  node({
    id: 'sys_edge_compute_module',
    label: 'Edge compute module',
    blurb: 'A rugged inference board that runs a policy on the machine itself.',
    sector: 'robotics',
    tier: 4,
    role: 'edge_compute',
    maturity: 'established',
    unit: 'module',
    sale: 'unit',
    life: 20,
    // Rugged edge inference modules ran roughly $400-$2,000 in 2026.
    price: 850,
    slots: [
      slot('die', 'chip_component', 1, 'RB', { accepts: ['cmp_logic_die'] }),
      slot('substrate', 'substrate', 1, 'RB', { def: 'cmp_ic_substrate' }),
      slot('polymer', 'polymer', 0.08, 'R', { def: 'res_specialty_polymers' }),
    ],
    capacity: 'plant',
    draw: 0.001_6,
    labour: 0.000_25,
    energy: 0.04,
    talent: ['hardware_design', 'efficiency'],
    demand: 9_400_000,
    elasticity: 1,
  }),
  node({
    id: 'sys_edge_ai_accelerator',
    label: 'Edge AI accelerator',
    blurb: 'A dedicated inference module with stacked memory. Runs a bigger policy on the machine, at a price.',
    sector: 'robotics',
    tier: 4,
    role: 'edge_compute',
    maturity: 'emerging',
    unit: 'module',
    sale: 'unit',
    life: 20,
    // Automotive-grade inference modules with on-package memory quoted
    // $1,800-$3,000 in 2026.
    price: 2_400,
    slots: [
      slot('die', 'chip_component', 2, 'RB', { accepts: ['cmp_logic_die'] }),
      slot('memory', 'memory', 1, 'RB', { def: 'cmp_hbm_stack' }),
      slot('substrate', 'substrate', 1, 'RB', { def: 'cmp_ic_substrate' }),
      slot('power', 'power_electronics', 0.2, 'R', { def: 'cmp_power_electronics' }),
    ],
    capacity: 'plant',
    draw: 0.004,
    labour: 0.000_5,
    energy: 0.08,
    talent: ['hardware_design', 'efficiency'],
    demand: 2_400_000,
    elasticity: 1,
  }),
  node({
    id: 'sys_robot_policy_model',
    label: 'Robot policy model',
    blurb: 'A manipulation policy trained on real telemetry. The difference between a demo and a shift.',
    sector: 'robotics',
    tier: 4,
    role: 'model',
    maturity: 'frontier',
    unit: 'licence',
    sale: 'unit',
    life: 12,
    price: 3_200_000,
    requires: ['svc_training_run', 'dat_robot_telemetry'],
    slots: [
      slot('compute', 'training_compute', 6, 'RB', { def: 'svc_training_run' }),
      slot('telemetry', 'dataset', 2, 'RB', { accepts: ['dat_robot_telemetry'], label: 'Telemetry' }),
      slot('evaluation', 'evaluation', 1, 'O', { def: null }),
    ],
    capacity: 'compute',
    draw: 8,
    labour: 2.4,
    computeIntensity: 0.9,
    talent: ['agents', 'reasoning', 'training_systems'],
    dataPb: 3,
    customers: MODEL_CUSTOMERS,
    demand: 260,
    elasticity: 0.7,
    dataYield: 0.006,
  }),
  node({
    id: 'svc_robot_control_stack',
    label: 'Robot control stack',
    blurb: 'Motion planning, safety and fleet integration, licensed per machine. The harness a robot runs on.',
    sector: 'robotics',
    tier: 4,
    role: 'control_stack',
    maturity: 'established',
    unit: 'licence',
    sale: 'unit',
    life: 20,
    // Per-robot software licences for industrial control ran $1,000-$3,000.
    price: 1_800,
    capacity: 'compute',
    draw: 0.000_4,
    labour: 0.000_3,
    support: 0.06,
    computeIntensity: 0.5,
    talent: ['agents', 'safety_alignment'],
    demand: 400_000,
    elasticity: 0.9,
    dataYield: 0.000_01,
  }),
  node({
    id: 'svc_autonomy_stack',
    label: 'Autonomy stack',
    blurb: 'Perception, planning and a driving policy for a vehicle, licensed per vehicle. The harness a truck runs on.',
    sector: 'robotics',
    tier: 4,
    role: 'control_stack',
    maturity: 'emerging',
    unit: 'licence',
    sale: 'unit',
    life: 28,
    // Per-vehicle autonomy licences were quoted $5,000-$8,000 for commercial
    // fleets in 2026.
    price: 6_500,
    capacity: 'compute',
    draw: 0.001,
    labour: 0.000_8,
    support: 0.06,
    computeIntensity: 0.7,
    talent: ['agents', 'multimodal', 'safety_alignment'],
    demand: 120_000,
    elasticity: 0.8,
    dataYield: 0.000_04,
    dataSensitivity: 0.3,
  }),
  node({
    id: 'sys_industrial_arm',
    label: 'Industrial arm',
    blurb: 'Six axes bolted to a floor. Boring, profitable and still the volume market.',
    sector: 'robotics',
    tier: 5,
    role: 'robot',
    maturity: 'established',
    unit: 'robot',
    sale: 'unit',
    life: 40,
    // Six-axis industrial robots ran roughly $25,000-$60,000 in 2026.
    price: 38_000,
    slots: [
      slot('actuators', 'actuator', 8, 'RB', { def: 'cmp_precision_actuator', label: 'Actuators' }),
      slot('sensors', 'sensor', 1, 'RB', { accepts: ['cmp_sensor_suite'], label: 'Sensors' }),
      slot('edge', 'edge_compute', 1, 'RB', { def: 'sys_edge_compute_module' }),
      slot('structure', 'structure', 200, 'RB', { def: 'mat_machined_structure' }),
      slot('model', 'model', 0.000_6, 'O', { def: 'sys_robot_policy_model' }),
      slot('harness', 'control_stack', 1, 'R', { def: 'svc_robot_control_stack', label: 'Control stack' }),
    ],
    capacity: 'plant',
    draw: 0.06,
    labour: 0.012,
    energy: 0.15,
    industries: ROBOT_INDUSTRIES,
    demand: 160_000,
    elasticity: 0.8,
    dataYield: 0.000_02,
  }),
  node({
    id: 'sys_warehouse_amr',
    label: 'Warehouse AMR',
    blurb: 'A mobile robot that brings the shelf to the picker instead of the other way round.',
    sector: 'robotics',
    tier: 5,
    role: 'robot',
    maturity: 'established',
    unit: 'robot',
    sale: 'unit',
    life: 28,
    // Goods-to-person AMRs ran $25,000-$50,000 per unit in 2026.
    price: 28_000,
    slots: [
      slot('actuators', 'actuator', 4, 'RB', { def: 'cmp_precision_actuator', label: 'Actuators' }),
      slot('sensors', 'sensor', 2, 'RB', { accepts: ['cmp_sensor_suite'], label: 'Sensors' }),
      slot('edge', 'edge_compute', 1, 'RB', { def: 'sys_edge_compute_module' }),
      slot('battery', 'battery_pack', 3, 'RB', { def: 'sys_battery_pack_lfp', label: 'Battery' }),
      slot('model', 'model', 0.001_5, 'R', { def: 'sys_robot_policy_model' }),
      slot('harness', 'control_stack', 1, 'R', { def: 'svc_robot_control_stack', label: 'Control stack' }),
    ],
    capacity: 'plant',
    draw: 0.045,
    labour: 0.009,
    energy: 0.12,
    industries: ROBOT_INDUSTRIES,
    demand: 90_000,
    elasticity: 1,
    dataYield: 0.000_04,
  }),
  node({
    id: 'sys_humanoid_robot',
    label: 'Humanoid robot',
    blurb: 'Two arms, two legs and twenty-two joints of unresolved argument.',
    sector: 'robotics',
    tier: 5,
    role: 'robot',
    maturity: 'frontier',
    unit: 'robot',
    sale: 'unit',
    life: 20,
    // 2026 street prices spanned $13,500 (Unitree G1) to about $90,000 (H1),
    // with industrial units clustering at $20,000-$45,000. $45,000 is a
    // work-capable machine at the top of the industrial band, which is what a
    // twenty-two-joint bill of materials with a control stack costs to build.
    price: 45_000,
    requires: ['sys_robot_policy_model'],
    slots: [
      slot('actuators', 'actuator', 22, 'RB', { def: 'cmp_precision_actuator', label: 'Actuators' }),
      slot('sensors', 'sensor', 2, 'RB', { accepts: ['cmp_sensor_suite'], label: 'Sensors' }),
      slot('edge', 'edge_compute', 2, 'RB', { def: 'sys_edge_compute_module' }),
      slot('battery', 'battery_pack', 2, 'RB', { def: 'sys_battery_pack', label: 'Battery' }),
      slot('model', 'model', 0.002_2, 'RB', { def: 'sys_robot_policy_model' }),
      slot('harness', 'control_stack', 1, 'R', { def: 'svc_robot_control_stack', label: 'Control stack' }),
    ],
    capacity: 'plant',
    draw: 0.08,
    labour: 0.03,
    energy: 0.1,
    talent: ['agents', 'hardware_design', 'reasoning'],
    industries: ROBOT_INDUSTRIES,
    demand: 40_000,
    elasticity: 1.2,
    dataYield: 0.000_2,
    dataSensitivity: 0.3,
  }),
  node({
    id: 'sys_autonomous_drone',
    label: 'Autonomous drone',
    blurb: 'Inspection, survey and increasingly delivery. Cheap enough to lose.',
    sector: 'robotics',
    tier: 5,
    role: 'robot',
    maturity: 'established',
    unit: 'robot',
    sale: 'unit',
    life: 12,
    // Industrial inspection and delivery drones ran $8,000-$14,000 in 2026;
    // $10,500 carries a control stack the older figure did not.
    price: 10_500,
    slots: [
      slot('motors', 'drivetrain', 8, 'RB', { def: 'cmp_electric_drivetrain', label: 'Motors' }),
      slot('sensors', 'sensor', 2, 'RB', { accepts: ['cmp_sensor_suite'], label: 'Sensors' }),
      slot('edge', 'edge_compute', 1, 'RB', { def: 'sys_edge_compute_module' }),
      slot('battery', 'battery_pack', 1.5, 'RB', { def: 'sys_battery_pack', label: 'Battery' }),
      slot('model', 'model', 0.000_4, 'R', { def: 'sys_robot_policy_model' }),
      slot('harness', 'control_stack', 1, 'R', { def: 'svc_robot_control_stack', label: 'Control stack' }),
    ],
    capacity: 'plant',
    draw: 0.012,
    labour: 0.003,
    energy: 0.03,
    customers: { enterprise: 0.7, government: 0.3 },
    demand: 250_000,
    elasticity: 1.3,
    dataYield: 0.000_03,
    dataSensitivity: 0.4,
  }),
  node({
    id: 'svc_robot_fleet_management',
    label: 'Fleet management',
    blurb: 'Uptime, updates and incident review for somebody else\'s robots, per robot per quarter.',
    sector: 'robotics',
    tier: 6,
    role: 'fleet_service',
    maturity: 'emerging',
    unit: 'robot-quarter',
    sale: 'recurring',
    price: 1_100,
    slots: [
      slot('model', 'inference_api', 26, 'R', { def: 'svc_inference_api', label: 'Model' }),
      slot('telemetry', 'dataset', 0.000_4, 'R', { accepts: ['dat_robot_telemetry'], label: 'Telemetry' }),
    ],
    capacity: 'compute',
    draw: 0.000_9,
    labour: 0.001_2,
    support: 0.14,
    talent: ['agents', 'infrastructure'],
    demand: 3_400_000,
    elasticity: 0.7,
    churn: [0.03, 0.08],
    dataYield: 0.000_02,
  }),
];

/* -------------------------------------------------------------------------- */
/*  Logistics                                                                  */
/* -------------------------------------------------------------------------- */

/** A vehicle drives itself when its owner licenses a stack for it; by default a person does. */
const AUTONOMY_SLOT = slot('autonomy', 'control_stack', 1, 'O', { accepts: ['svc_autonomy_stack'], def: null, label: 'Autonomy' });

const LOGISTICS_NODES: readonly EconomicNode[] = [
  node({
    id: 'res_diesel_fuel',
    label: 'Diesel',
    blurb: 'Still what most of the world\'s freight actually burns.',
    sector: 'logistics',
    tier: 0,
    role: 'fuel',
    maturity: 'commodity',
    unit: 'gallon',
    sale: 'unit',
    life: 1,
    price: 3.8,
    demand: 14_000_000_000,
    elasticity: 0.5,
    capacity: 'fleet',
    draw: 0.000_001,
    labour: 0.000_000_2,
  }),
  node({
    id: 'mat_packaging_materials',
    label: 'Packaging',
    blurb: 'Board, film and void fill. Nobody notices it until it costs more than the freight.',
    sector: 'logistics',
    tier: 2,
    role: 'packaging',
    maturity: 'commodity',
    unit: 'kg',
    sale: 'unit',
    life: 1,
    price: 1.4,
    slots: [slot('polymer', 'polymer', 0.25, 'R', { def: 'res_specialty_polymers' })],
    capacity: 'plant',
    draw: 0.000_004,
    labour: 0.000_002,
    energy: 0.002,
    demand: 4_200_000_000,
    elasticity: 1.1,
  }),
  node({
    id: 'sys_electric_truck',
    label: 'Electric truck',
    blurb: 'A class-eight tractor with a five-hundred-kilowatt-hour pack under the cab.',
    sector: 'logistics',
    tier: 5,
    role: 'vehicle',
    maturity: 'emerging',
    unit: 'truck',
    sale: 'unit',
    life: 32,
    price: 165_000,
    slots: [
      slot('battery', 'battery_pack', 500, 'RB', { def: 'sys_battery_pack_lfp', label: 'Battery' }),
      slot('drivetrain', 'drivetrain', 350, 'RB', { def: 'cmp_electric_drivetrain' }),
      slot('steel', 'steel', 8, 'RB', { def: 'res_steel_alloy' }),
      slot('sensors', 'sensor', 1, 'R', { accepts: ['cmp_sensor_suite'], label: 'Sensors' }),
      slot('edge', 'edge_compute', 1, 'R', { def: 'sys_edge_compute_module' }),
      AUTONOMY_SLOT,
    ],
    capacity: 'plant',
    draw: 0.22,
    labour: 0.06,
    energy: 0.6,
    talent: ['hardware_design', 'efficiency'],
    demand: 62_000,
    elasticity: 1,
    dataYield: 0.000_06,
  }),
  node({
    id: 'sys_delivery_van',
    label: 'Delivery van',
    blurb: 'The last-mile workhorse. Bought a thousand at a time or not at all.',
    sector: 'logistics',
    tier: 5,
    role: 'vehicle',
    maturity: 'established',
    unit: 'van',
    sale: 'unit',
    life: 28,
    // Electric delivery vans listed $48,000-$60,000 in 2026; on an LFP pack
    // the balance price sits at the lower end of that.
    price: 52_000,
    slots: [
      slot('battery', 'battery_pack', 130, 'RB', { def: 'sys_battery_pack_lfp', label: 'Battery' }),
      slot('drivetrain', 'drivetrain', 150, 'RB', { def: 'cmp_electric_drivetrain' }),
      slot('steel', 'steel', 2.2, 'RB', { def: 'res_steel_alloy' }),
      slot('sensors', 'sensor', 1, 'R', { accepts: ['cmp_sensor_suite'], label: 'Sensors' }),
      slot('edge', 'edge_compute', 1, 'R', { def: 'sys_edge_compute_module' }),
      AUTONOMY_SLOT,
    ],
    capacity: 'plant',
    draw: 0.09,
    labour: 0.02,
    energy: 0.3,
    demand: 420_000,
    elasticity: 1.1,
    dataYield: 0.000_04,
  }),
  node({
    id: 'sys_warehouse_automation_cell',
    label: 'Automation cell',
    blurb: 'Ten thousand square feet of warehouse, robots and racking, commissioned as one thing.',
    sector: 'logistics',
    tier: 6,
    role: 'automation_cell',
    maturity: 'emerging',
    unit: 'cell',
    sale: 'unit',
    life: 40,
    price: 1_400_000,
    requires: ['sys_warehouse_amr'],
    slots: [
      slot('robots', 'robot', 18, 'RB', { accepts: ['sys_warehouse_amr', 'sys_humanoid_robot'], def: 'sys_warehouse_amr', label: 'Robots' }),
      slot('arms', 'robot', 4, 'RB', { accepts: ['sys_industrial_arm'], label: 'Arms' }),
      slot('edge', 'edge_compute', 8, 'RB', { def: 'sys_edge_compute_module' }),
      slot('structure', 'structure', 2_000, 'RB', { def: 'mat_machined_structure' }),
    ],
    capacity: 'fleet',
    draw: 1.2,
    labour: 0.3,
    energy: 60,
    talent: ['infrastructure', 'agents'],
    demand: 9_400,
    elasticity: 0.9,
    dataYield: 0.001,
  }),
  node({
    id: 'svc_routing_platform',
    label: 'Routing platform',
    blurb: 'Software that decides which vehicle goes where. A percent of fuel is a fortune.',
    sector: 'logistics',
    tier: 6,
    role: 'logistics_software',
    maturity: 'emerging',
    unit: 'vehicle-quarter',
    sale: 'recurring',
    price: 95,
    slots: [slot('model', 'inference_api', 4, 'R', { def: 'svc_inference_api', label: 'Model' })],
    capacity: 'compute',
    draw: 0.000_15,
    labour: 0.000_08,
    support: 0.1,
    talent: ['agents', 'infrastructure'],
    demand: 42_000_000,
    elasticity: 0.8,
    churn: [0.03, 0.09],
    dataYield: 0.000_000_6,
  }),
  node({
    id: 'svc_line_haul',
    label: 'Line haul',
    blurb: 'Long-distance freight, priced per loaded mile. The oldest market in the game.',
    sector: 'logistics',
    tier: 7,
    role: 'logistics_service',
    maturity: 'commodity',
    unit: 'loaded mile',
    sale: 'unit',
    life: 1,
    // 2026 national spot averages: dry van $1.92, flatbed $2.18, reefer $2.28
    // a mile, with contract rates 15-30% above spot.
    price: 2.35,
    slots: [
      slot('vehicle', 'vehicle', 0.000_002, 'R', { accepts: ['sys_electric_truck'] }),
      // A vehicle-quarter of routing spread over the miles a truck runs in a
      // quarter: about 25,000, so one mile draws four hundred-thousandths.
      slot('routing', 'logistics_software', 0.000_04, 'O', { def: 'svc_routing_platform' }),
    ],
    capacity: 'fleet',
    draw: 0.000_006,
    labour: 0.000_02,
    energy: 0.002,
    demand: 75_000_000_000,
    elasticity: 1.5,
    dataYield: 0.000_000_02,
  }),
  node({
    id: 'svc_last_mile',
    label: 'Last mile',
    blurb: 'The final delivery. Over half of what shipping actually costs.',
    sector: 'logistics',
    tier: 7,
    role: 'logistics_service',
    maturity: 'established',
    unit: 'parcel',
    sale: 'unit',
    life: 1,
    // Urban deliveries ran near $10 a package in 2026 and rural far higher;
    // last mile was about 53% of total logistics cost.
    price: 10.5,
    slots: [
      slot('vehicle', 'vehicle', 0.000_001_1, 'R', { accepts: ['sys_delivery_van'] }),
      slot('drones', 'robot', 0.000_000_6, 'O', { accepts: ['sys_autonomous_drone'], label: 'Drones' }),
      slot('packaging', 'packaging', 0.35, 'RB', { def: 'mat_packaging_materials' }),
      slot('routing', 'logistics_software', 0.000_02, 'O', { def: 'svc_routing_platform' }),
    ],
    capacity: 'fleet',
    draw: 0.000_012,
    labour: 0.000_06,
    energy: 0.001,
    support: 0.06,
    customers: { consumer: 1 },
    demand: 25_000_000_000,
    elasticity: 1.2,
    dataYield: 0.000_000_05,
    dataSensitivity: 0.5,
  }),
  node({
    id: 'svc_freight_brokerage',
    label: 'Freight brokerage',
    blurb: 'Matching loads to capacity for a margin. Thin, enormous and relentlessly automated.',
    sector: 'logistics',
    tier: 7,
    role: 'logistics_service',
    maturity: 'commodity',
    unit: 'load',
    sale: 'unit',
    life: 1,
    price: 210,
    slots: [
      slot('model', 'inference_api', 1.4, 'R', { def: 'svc_inference_api', label: 'Model' }),
      slot('routing', 'logistics_software', 0.000_5, 'O', { def: 'svc_routing_platform' }),
    ],
    capacity: 'compute',
    draw: 0.000_02,
    labour: 0.000_9,
    support: 0.08,
    demand: 62_000_000,
    elasticity: 1.6,
    dataYield: 0.000_000_4,
  }),
  node({
    id: 'svc_port_terminal',
    label: 'Port terminal',
    blurb: 'Berth, crane and yard, contracted by the thousand containers a quarter.',
    sector: 'logistics',
    tier: 7,
    role: 'logistics_service',
    maturity: 'established',
    unit: '1k TEU-qtr',
    sale: 'contract',
    term: 20,
    price: 168_000,
    slots: [
      slot('robots', 'robot', 0.04, 'R', { accepts: ['sys_warehouse_amr', 'sys_humanoid_robot'], def: 'sys_warehouse_amr', label: 'Robots' }),
      slot('arms', 'robot', 0.02, 'R', { accepts: ['sys_industrial_arm'], label: 'Arms' }),
      slot('routing', 'logistics_software', 0.5, 'O', { def: 'svc_routing_platform' }),
    ],
    capacity: 'fleet',
    draw: 0.9,
    labour: 0.4,
    energy: 42,
    demand: 240_000,
    elasticity: 0.4,
    dataYield: 0.000_04,
  }),
];

/* -------------------------------------------------------------------------- */
/*  Consumer                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Harness seats a consumer application runs on, per buyer or subscriber per
 * quarter. A platform of five hundred million buyers is built by about ten
 * thousand seats, so one buyer draws two hundred-thousandths of one.
 */
const CONSUMER_HARNESS_SEATS = 0.000_02;

/** The people whose behaviour a consumer application learns from, per unit. */
const BEHAVIOUR_SLOT = (qtyPerUnit: number): NodeSlot => slot('data', 'dataset', qtyPerUnit, 'R', { accepts: ['dat_consumer_behaviour'], label: 'Behaviour data' });

const CONSUMER_NODES: readonly EconomicNode[] = [
  node({
    id: 'mat_display_panel',
    label: 'Display panel',
    blurb: 'An OLED panel cut to size. The most expensive thing a phone looks at you with.',
    sector: 'consumer',
    tier: 2,
    role: 'display',
    maturity: 'established',
    unit: 'panel',
    sale: 'unit',
    life: 1,
    price: 95,
    slots: [slot('polymer', 'polymer', 0.06, 'R', { def: 'res_specialty_polymers' }), slot('rare_earth', 'rare_earth', 0.004, 'R', { def: 'res_rare_earth_oxides' })],
    capacity: 'plant',
    draw: 0.000_3,
    labour: 0.000_04,
    energy: 0.06,
    demand: 420_000_000,
    elasticity: 1.1,
  }),
  node({
    id: 'dat_consumer_behaviour',
    label: 'Behaviour data',
    blurb: 'What millions of people actually did, priced by the petabyte and watched by regulators.',
    sector: 'consumer',
    tier: 2,
    role: 'dataset',
    maturity: 'established',
    unit: 'PB',
    sale: 'unit',
    life: 6,
    price: 240_000,
    capacity: 'none',
    labour: 0.3,
    energy: 1.6,
    talent: ['data_curation', 'retrieval'],
    dataPb: 1,
    demand: 6_200,
    elasticity: 1.2,
    dataSensitivity: 0.95,
  }),
  node({
    id: 'cmp_consumer_soc',
    label: 'Consumer SoC',
    blurb: 'The whole phone on one die, neural engine included.',
    sector: 'consumer',
    tier: 3,
    role: 'soc',
    maturity: 'established',
    unit: 'SoC',
    sale: 'unit',
    life: 1,
    price: 90,
    slots: [slot('wafer', 'wafer', 0.004, 'RB', { accepts: ['mat_wafer_300mm'] }), slot('polymer', 'polymer', 0.02, 'R', { def: 'res_specialty_polymers' })],
    capacity: 'plant',
    draw: 0.000_2,
    labour: 0.000_02,
    energy: 0.01,
    talent: ['hardware_design', 'efficiency'],
    demand: 340_000_000,
    elasticity: 0.9,
  }),
  node({
    id: 'cmp_camera_module',
    label: 'Camera module',
    blurb: 'Sensor, stack and actuator in a package the size of a fingernail.',
    sector: 'consumer',
    tier: 3,
    role: 'sensor',
    maturity: 'commodity',
    unit: 'module',
    sale: 'unit',
    life: 1,
    price: 22,
    slots: [slot('wafer', 'wafer', 0.000_6, 'RB', { accepts: ['mat_wafer_300mm'] }), slot('polymer', 'polymer', 0.01, 'R', { def: 'res_specialty_polymers' })],
    capacity: 'plant',
    draw: 0.000_05,
    labour: 0.000_01,
    energy: 0.004,
    demand: 1_100_000_000,
    elasticity: 1.3,
  }),
  node({
    id: 'sys_consumer_device',
    label: 'Consumer device',
    blurb: 'The phone-shaped thing. Three hundred million of them a quarter.',
    sector: 'consumer',
    tier: 5,
    role: 'device',
    maturity: 'established',
    unit: 'device',
    sale: 'unit',
    life: 12,
    price: 380,
    slots: [
      slot('soc', 'soc', 1, 'RB', { def: 'cmp_consumer_soc' }),
      slot('display', 'display', 1, 'RB', { def: 'mat_display_panel' }),
      slot('camera', 'sensor', 1, 'RB', { accepts: ['cmp_camera_module'], label: 'Camera' }),
      slot('cell', 'battery_cell', 0.018, 'RB', { def: 'cmp_battery_cell' }),
      slot('polymer', 'polymer', 0.15, 'R', { def: 'res_specialty_polymers' }),
      // A model on the device: a share of one licence over the devices it
      // ships in. Empty by default — most phones run nothing of their own.
      slot('model', 'model', 0.000_000_5, 'O', { def: null }),
    ],
    capacity: 'plant',
    draw: 0.000_02,
    labour: 0.000_02,
    energy: 0.03,
    support: 0.05,
    customers: { consumer: 1 },
    demand: 300_000_000,
    elasticity: 1.5,
    dataYield: 0.000_001,
    dataSensitivity: 0.75,
  }),
  node({
    id: 'sys_ai_wearable',
    label: 'AI wearable',
    blurb: 'A camera, a microphone and a model, worn. Nobody agrees whether this works yet.',
    sector: 'consumer',
    tier: 5,
    role: 'device',
    maturity: 'emerging',
    unit: 'device',
    sale: 'unit',
    life: 8,
    price: 165,
    slots: [
      slot('soc', 'soc', 0.5, 'RB', { def: 'cmp_consumer_soc' }),
      slot('camera', 'sensor', 1, 'RB', { accepts: ['cmp_camera_module'], label: 'Camera' }),
      slot('display', 'display', 0.15, 'R', { def: 'mat_display_panel' }),
      slot('cell', 'battery_cell', 0.005, 'RB', { def: 'cmp_battery_cell' }),
      slot('polymer', 'polymer', 0.05, 'R', { def: 'res_specialty_polymers' }),
      // The model IS the product here, so the default is a small model: one
      // licence over the half-million devices it ships in.
      slot('model', 'model', 0.000_002, 'O', { def: 'sys_efficient_small_model' }),
    ],
    capacity: 'plant',
    draw: 0.000_02,
    labour: 0.000_03,
    energy: 0.02,
    support: 0.08,
    talent: ['multimodal', 'efficiency'],
    customers: { consumer: 1 },
    demand: 26_000_000,
    elasticity: 1.9,
    dataYield: 0.000_004,
    dataSensitivity: 0.9,
  }),
  node({
    id: 'app_marketplace',
    label: 'Marketplace',
    blurb: 'Somebody else\'s inventory, your checkout, a take rate per active buyer.',
    sector: 'consumer',
    tier: 6,
    role: 'app',
    maturity: 'established',
    unit: 'buyer-quarter',
    sale: 'recurring',
    price: 9,
    slots: [
      slot('model', 'inference_api', 0.1, 'R', { def: 'svc_inference_api', label: 'Model' }),
      slot('harness', 'harness', CONSUMER_HARNESS_SEATS, 'R', { def: 'svc_agent_harness' }),
      BEHAVIOUR_SLOT(0.000_000_01),
      DELIVERY_SLOT,
    ],
    capacity: 'compute',
    draw: 0.000_002,
    labour: 0.000_003,
    support: 0.16,
    customers: { consumer: 1 },
    demand: 500_000_000,
    elasticity: 1.2,
    churn: [0.08, 0.18],
    dataYield: 0.000_000_2,
    dataSensitivity: 0.8,
  }),
  node({
    id: 'app_streaming_media',
    label: 'Streaming media',
    blurb: 'A library and a recommendation engine, billed monthly and cancelled constantly.',
    sector: 'consumer',
    tier: 6,
    role: 'app',
    maturity: 'established',
    unit: 'subscriber',
    sale: 'recurring',
    price: 36,
    slots: [
      slot('model', 'inference_api', 0.05, 'R', { def: 'svc_inference_api', label: 'Model' }),
      slot('harness', 'harness', CONSUMER_HARNESS_SEATS, 'R', { def: 'svc_agent_harness' }),
      BEHAVIOUR_SLOT(0.000_000_005),
      DELIVERY_SLOT,
    ],
    capacity: 'compute',
    draw: 0.000_001_5,
    labour: 0.000_002,
    support: 0.14,
    customers: { consumer: 1 },
    demand: 420_000_000,
    elasticity: 1.6,
    churn: [0.09, 0.2],
    dataYield: 0.000_000_3,
    dataSensitivity: 0.7,
  }),
  node({
    id: 'app_consumer_subscription',
    label: 'Consumer subscription',
    blurb: 'The small monthly app that a hundred million people forget they pay for.',
    sector: 'consumer',
    tier: 6,
    role: 'app',
    maturity: 'commodity',
    unit: 'subscriber',
    sale: 'recurring',
    price: 16,
    slots: [
      slot('model', 'inference_api', 0.4, 'R', { def: 'svc_inference_api', label: 'Model' }),
      slot('harness', 'harness', CONSUMER_HARNESS_SEATS, 'R', { def: 'svc_agent_harness' }),
      BEHAVIOUR_SLOT(0.000_000_005),
      DELIVERY_SLOT,
    ],
    capacity: 'compute',
    draw: 0.000_004,
    labour: 0.000_002,
    support: 0.12,
    customers: { consumer: 1 },
    demand: 620_000_000,
    elasticity: 1.8,
    churn: [0.1, 0.24],
    dataYield: 0.000_000_2,
    dataSensitivity: 0.65,
  }),
  node({
    id: 'app_social_network',
    label: 'Social network',
    blurb: 'Attention, sold by the active user and regulated by the week.',
    sector: 'consumer',
    tier: 6,
    role: 'app',
    maturity: 'established',
    unit: 'user-quarter',
    sale: 'recurring',
    price: 4,
    slots: [
      slot('model', 'inference_api', 0.05, 'R', { def: 'svc_inference_api', label: 'Model' }),
      slot('harness', 'harness', CONSUMER_HARNESS_SEATS, 'R', { def: 'svc_agent_harness' }),
      BEHAVIOUR_SLOT(0.000_000_005),
      DELIVERY_SLOT,
    ],
    capacity: 'compute',
    draw: 0.000_001_2,
    labour: 0.000_001,
    support: 0.18,
    customers: { consumer: 1 },
    demand: 2_400_000_000,
    elasticity: 2.2,
    churn: [0.06, 0.16],
    dataYield: 0.000_000_6,
    dataSensitivity: 0.92,
  }),
  node({
    id: 'svc_brand_retail',
    label: 'Direct brand',
    blurb: 'Your own product, your own storefront, your own returns problem.',
    sector: 'consumer',
    tier: 7,
    role: 'retail',
    maturity: 'established',
    unit: 'order',
    sale: 'unit',
    life: 1,
    price: 74,
    slots: [
      slot('goods', 'device', 0.06, 'R', { def: 'sys_consumer_device', label: 'Goods' }),
      slot('packaging', 'packaging', 0.4, 'RB', { def: 'mat_packaging_materials' }),
      slot('storefront', 'app', 0.02, 'O', { accepts: ['app_marketplace'], def: null, label: 'Storefront' }),
    ],
    capacity: 'fleet',
    draw: 0.000_01,
    labour: 0.000_2,
    support: 0.11,
    customers: { consumer: 1 },
    demand: 1_800_000_000,
    elasticity: 1.7,
    dataYield: 0.000_000_4,
    dataSensitivity: 0.6,
  }),
];

/* -------------------------------------------------------------------------- */
/*  Markets, derived                                                           */
/* -------------------------------------------------------------------------- */

/** Weights scaled to sum to one, in the order given. A set with no weight stays as it is. */
function normaliseWeights<K extends string>(weights: Partial<Record<K, number>>): Partial<Record<K, number>> {
  let total = 0;
  for (const value of Object.values(weights) as (number | undefined)[]) if (value !== undefined && Number.isFinite(value) && value > 0) total += value;
  if (total <= 0) return weights;
  const out: Partial<Record<K, number>> = {};
  for (const [key, value] of Object.entries(weights) as [K, number | undefined][]) {
    if (value === undefined || !(value > 0)) continue;
    out[key] = value / total;
  }
  return out;
}

/** True when at least one weight is positive. */
function hasWeight(weights: Partial<Record<string, number>>): boolean {
  return Object.values(weights).some((value) => value !== undefined && value > 0);
}

/**
 * Fill in and normalise every row's market once the whole table exists.
 *
 * Customers default to enterprises. Industries a row leaves empty are derived:
 * a row sold only to the public sells into the consumer sector; otherwise the
 * sectors of every node whose slots admit this one, uniform, in `SECTORS`
 * order; a terminal nothing admits sells to every industry uniformly. The
 * derivation reads slots, so it has to run over the finished table rather than
 * inside the row builder.
 */
export function withDerivedMarkets(nodes: readonly EconomicNode[]): readonly EconomicNode[] {
  const byId = indexNodes(nodes);
  const admittedBy = new Map<string, Set<Sector>>();
  for (const owner of nodes) {
    for (const slotOf of owner.slots) {
      for (const id of admissibleNodeIds(owner, slotOf, byId)) {
        const set = admittedBy.get(id) ?? new Set<Sector>();
        set.add(owner.sector);
        admittedBy.set(id, set);
      }
    }
  }

  return nodes.map((entry) => {
    const customers = normaliseWeights(hasWeight(entry.market.customers) ? entry.market.customers : { enterprise: 1 });
    let industries = entry.market.industries;
    if (!hasWeight(industries)) {
      const publicOnly = Object.keys(customers).every((key) => key === 'consumer');
      if (publicOnly) {
        industries = { consumer: 1 };
      } else {
        const admitting = admittedBy.get(entry.id);
        const sectors = admitting === undefined || admitting.size === 0 ? SECTORS : SECTORS.filter((sector) => admitting.has(sector));
        const uniform: Partial<Record<Sector, number>> = {};
        for (const sector of sectors) uniform[sector] = 1;
        industries = uniform;
      }
    }
    return EconomicNodeSchema.parse({ ...entry, market: { customers, industries: normaliseWeights(industries) } });
  });
}

/* -------------------------------------------------------------------------- */
/*  The table                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Every node in the world-3 economy, in sector order and then tier order
 * within each sector. Ids are stable: appending is safe, renaming is not.
 */
export const ECONOMIC_NODES: readonly EconomicNode[] = withDerivedMarkets([
  ...MANUFACTURING_NODES,
  ...ENERGY_NODES,
  ...AI_NODES,
  ...ROBOTICS_NODES,
  ...LOGISTICS_NODES,
  ...CONSUMER_NODES,
]);

/** Lookup by id. Total for a known id; undefined for anything else. */
export const ECONOMIC_NODES_BY_ID: Readonly<Record<string, EconomicNode>> = Object.fromEntries(ECONOMIC_NODES.map((entry) => [entry.id, entry]));

/** The table indexed as a map, in table order, for the slot readers that take one. */
const NODE_INDEX: ReadonlyMap<string, EconomicNode> = indexNodes(ECONOMIC_NODES);

/** One node by id, or undefined. */
export function economicNodeById(id: string): EconomicNode | undefined {
  return ECONOMIC_NODES_BY_ID[id];
}

/** Every node in one sector, in table order. Named to avoid `nodesInSector` in `tech.ts`. */
export function economicNodesInSector(sector: Sector): readonly EconomicNode[] {
  return ECONOMIC_NODES.filter((entry) => entry.sector === sector);
}

/** Every node at one tier, in table order. The map draws one lane per tier. */
export function economicNodesAtTier(tier: NodeTier): readonly EconomicNode[] {
  return ECONOMIC_NODES.filter((entry) => entry.tier === tier);
}

/** Every node of one role, in table order. What a slot with an empty `accepts` admits. */
export function economicNodesOfRole(role: NodeRole): readonly EconomicNode[] {
  return ECONOMIC_NODES.filter((entry) => entry.role === role);
}

/** The nodes that may fill one slot of one node, in table order. Empty for an unknown node or slot. */
export function admissibleNodesFor(nodeId: string, slotId: string): readonly EconomicNode[] {
  const owner = ECONOMIC_NODES_BY_ID[nodeId];
  const target = owner?.slots.find((entry) => entry.id === slotId);
  if (owner === undefined || target === undefined) return [];
  return admissibleNodeIds(owner, target, NODE_INDEX)
    .map((id) => ECONOMIC_NODES_BY_ID[id])
    .filter((entry): entry is EconomicNode => entry !== undefined);
}

/** One node and one of its slots: where a node could be sold into. */
export interface SlotRef {
  readonly node: EconomicNode;
  readonly slot: NodeSlot;
}

/**
 * Every slot in the table that admits `nodeId` — the reverse edge the canvas
 * draws downstream, and the list of things a line on that node could be sold
 * into. Table order, then slot order.
 */
export function slotsAccepting(nodeId: string): readonly SlotRef[] {
  const out: SlotRef[] = [];
  for (const owner of ECONOMIC_NODES) {
    for (const entry of owner.slots) {
      if (admissibleNodeIds(owner, entry, NODE_INDEX).includes(nodeId)) out.push({ node: owner, slot: entry });
    }
  }
  return out;
}

/** The sectors the table covers, for tests that walk it sector by sector. */
export const ECONOMIC_NODE_SECTORS = SECTORS;

/**
 * What one unit of a node costs on the open market this quarter: the node's own
 * balance price moved by the index the market phase stored on the session.
 *
 * The single reader of a node price for the whole game — engine, screens and
 * the Chief of Staff alike — so a price can never be computed two ways. An
 * unknown id answers 0 rather than throwing: a corrupt save must not take a
 * quarter down.
 */
export function nodeMarketPriceUsd(state: NodePricedState, nodeId: string): number {
  const node = ECONOMIC_NODES_BY_ID[nodeId];
  if (node === undefined) return 0;
  return nodePriceUsd(node, nodePriceIndex(state, nodeId));
}
