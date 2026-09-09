/**
 * @frontier/contracts — sectors.ts
 *
 * The economy is not only AI. World version 2 spans six broad sectors and six
 * regions, and this module is the single table both the engine and the
 * interface read them from.
 *
 * Two things live here and nothing else:
 *
 * - **`Sector`** — what a company *does*. Distinct from `SectorKey` in
 *   `world.ts`, which is a finer-grained *market* bucket used for sector beta,
 *   sentiment and valuation multiples (`semiconductors`, `frontier_models`, …).
 *   A company carries both: `sector` for the real economy and supply chain,
 *   `sectorId` for how the market prices it. World version 1 companies have no
 *   `sector` recorded, so the schema default gives them `"ai"`.
 * - **`Region`** — where a company operates. Regions are cost and appetite
 *   indices, never multipliers applied twice: an index of 100 is the session
 *   baseline and every figure is a whole number so the interface can print it
 *   without a decimal point.
 *
 * The supply graph is declared twice — `inputs` and `outputs` — and the two
 * halves must be exact inverses of one another. `sectorSupplyGraphIsConsistent`
 * proves it, and the contract tests run it.
 *
 * Nothing in here is LLM-facing. A model may be *told* what the sectors are;
 * it never returns one of these tables.
 */

import { z } from 'zod';

/* -------------------------------------------------------------------------- */
/*  Sectors                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The six sectors of the world-version-2 economy, in presentation order.
 *
 * Order is load-bearing: it is the order the new-game chat offers them, the
 * order the Markets screen groups by, and the iteration order of every
 * per-sector phase in the engine. Appending is safe; reordering is not.
 */
export const SECTORS = ['ai', 'robotics', 'manufacturing', 'energy', 'logistics', 'consumer'] as const;

export const SectorSchema = z
  .enum(SECTORS)
  .describe(
    'Which part of the real economy a company operates in. "ai" builds models and software; "robotics" builds embodied autonomy; "manufacturing" makes physical goods; "energy" generates and delivers power; "logistics" moves goods and carries demand; "consumer" sells to the public. Distinct from the market sector id used for beta and multiples.',
  );
export type Sector = z.infer<typeof SectorSchema>;

const SECTOR_SET: ReadonlySet<string> = new Set<string>(SECTORS);

/** Narrowing guard, for parsing free text out of the new-game chat. */
export function isSector(value: unknown): value is Sector {
  return typeof value === 'string' && SECTOR_SET.has(value);
}

/** The sector a company gets when a save predates world version 2. */
export const DEFAULT_SECTOR: Sector = 'ai';

/**
 * A whole-number band, `[low, high]`, with `low <= high`. Bands are inclusive
 * and are the range the engine draws a starting value from and clamps to.
 */
export type WholeBand = readonly [number, number];

/** Static description of one sector. Constants only — no session state. */
export interface SectorMeta {
  readonly id: Sector;
  /** Icon name from the app icon set (`ICON_NAMES` in `components/ui/icons`). */
  readonly icon: string;
  readonly label: string;
  /** One line for a picker card. */
  readonly tagline: string;
  /**
   * Capital intensity index, 0-100. How much of a quarter's revenue a company
   * in this sector typically reinvests as capital expenditure. Energy and
   * manufacturing are heavy; consumer is light.
   */
  readonly capexIntensity: number;
  /** Sustainable gross margin band, whole percentage points. */
  readonly grossMarginBandPct: WholeBand;
  /** Trailing-revenue multiple band the valuation anchor works within. */
  readonly revenueMultipleBand: WholeBand;
  /**
   * Length of one full demand cycle in quarters. Consumer turns fast; energy
   * turns slowly. The engine phases each sector's demand on its own cycle so
   * the whole economy does not breathe in unison.
   */
  readonly demandCycleQuarters: number;
  /** Sectors whose output this sector buys. Inverse of every `outputs`. */
  readonly inputs: readonly Sector[];
  /** Sectors this sector supplies. Inverse of every `inputs`. */
  readonly outputs: readonly Sector[];
}

/**
 * The sector table.
 *
 * The supply graph encodes four couplings:
 * - **energy feeds manufacturing and logistics** — and AI, whose datacentres
 *   are an energy load like any other, which is what makes an electricity
 *   shock reach the frontier;
 * - **manufacturing feeds robotics and consumer** — robots and goods are made
 *   of parts;
 * - **AI raises productivity everywhere** — it is an input to all five others;
 * - **logistics carries consumer and manufacturing demand** — a logistics
 *   squeeze shows up as unmet demand in the sectors it serves.
 *
 * Robotics and consumer are terminal: nothing downstream of them is modelled.
 */
export const SECTOR_META: Readonly<Record<Sector, SectorMeta>> = {
  ai: {
    id: 'ai',
    icon: 'flask',
    label: 'AI',
    tagline: 'Models, agents and the software on top of them',
    capexIntensity: 70,
    grossMarginBandPct: [55, 80],
    revenueMultipleBand: [6, 24],
    demandCycleQuarters: 12,
    inputs: ['energy'],
    outputs: ['robotics', 'manufacturing', 'energy', 'logistics', 'consumer'],
  },
  robotics: {
    id: 'robotics',
    icon: 'settings',
    label: 'Robotics',
    tagline: 'Autonomy that has to survive contact with the physical world',
    capexIntensity: 55,
    grossMarginBandPct: [35, 55],
    revenueMultipleBand: [3, 12],
    demandCycleQuarters: 16,
    inputs: ['ai', 'manufacturing'],
    outputs: [],
  },
  manufacturing: {
    id: 'manufacturing',
    icon: 'building',
    label: 'Manufacturing',
    tagline: 'Lines, yields and the cost of a physical unit',
    capexIntensity: 80,
    grossMarginBandPct: [20, 38],
    revenueMultipleBand: [1, 4],
    demandCycleQuarters: 20,
    inputs: ['ai', 'energy', 'logistics'],
    outputs: ['robotics', 'consumer'],
  },
  energy: {
    id: 'energy',
    icon: 'live',
    label: 'Energy',
    tagline: 'Generation, grid and the price everyone else pays',
    capexIntensity: 95,
    grossMarginBandPct: [30, 55],
    revenueMultipleBand: [2, 7],
    demandCycleQuarters: 24,
    inputs: ['ai'],
    outputs: ['ai', 'manufacturing', 'logistics'],
  },
  logistics: {
    id: 'logistics',
    icon: 'box',
    label: 'Logistics',
    tagline: 'Freight, warehousing and the demand they carry',
    capexIntensity: 45,
    grossMarginBandPct: [15, 30],
    revenueMultipleBand: [1, 3],
    demandCycleQuarters: 8,
    inputs: ['ai', 'energy'],
    outputs: ['manufacturing', 'consumer'],
  },
  consumer: {
    id: 'consumer',
    icon: 'people',
    label: 'Consumer',
    tagline: 'Millions of small accounts and no patience at all',
    capexIntensity: 20,
    grossMarginBandPct: [40, 65],
    revenueMultipleBand: [2, 8],
    demandCycleQuarters: 6,
    inputs: ['ai', 'manufacturing', 'logistics'],
    outputs: [],
  },
};

/** The table row for a sector. Total, so callers never handle `undefined`. */
export function sectorMeta(sector: Sector): SectorMeta {
  return SECTOR_META[sector];
}

/** Sectors that supply `sector`, in `SECTORS` order. */
export function sectorInputs(sector: Sector): readonly Sector[] {
  return SECTOR_META[sector].inputs;
}

/** Sectors `sector` supplies, in `SECTORS` order. */
export function sectorOutputs(sector: Sector): readonly Sector[] {
  return SECTOR_META[sector].outputs;
}

/**
 * The supply graph is declared from both ends; this proves the halves agree.
 * Pure and deterministic — the contract tests assert it, and the engine may
 * assert it at scenario build time.
 */
export function sectorSupplyGraphIsConsistent(): boolean {
  for (const from of SECTORS) {
    for (const to of SECTOR_META[from].outputs) {
      if (!SECTOR_META[to].inputs.includes(from)) return false;
    }
    for (const upstream of SECTOR_META[from].inputs) {
      if (!SECTOR_META[upstream].outputs.includes(from)) return false;
    }
  }
  return true;
}

/* -------------------------------------------------------------------------- */
/*  Regions                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The six regions a company can be based in, in presentation order. Same rule
 * as sectors: appending is safe, reordering is not.
 */
export const REGIONS = ['north_america', 'europe', 'east_asia', 'south_asia', 'middle_east', 'latin_america'] as const;

export const RegionSchema = z
  .enum(REGIONS)
  .describe(
    'Where a company is based. A region sets what talent and energy cost, how much government work is available, how deep local capital is, and which sectors the region is naturally good at. Every figure is an index around a baseline of 100.',
  );
export type Region = z.infer<typeof RegionSchema>;

const REGION_SET: ReadonlySet<string> = new Set<string>(REGIONS);

/** Narrowing guard, for parsing free text out of the new-game chat. */
export function isRegion(value: unknown): value is Region {
  return typeof value === 'string' && REGION_SET.has(value);
}

/** The region a company gets when a save predates world version 2. */
export const DEFAULT_REGION: Region = 'north_america';

/** The baseline every region index is expressed against. */
export const REGION_INDEX_BASELINE = 100;

/** Static description of one region. Constants only — no session state. */
export interface RegionMeta {
  readonly id: Region;
  /** Icon name from the app icon set, chosen for the region's character. */
  readonly icon: string;
  readonly label: string;
  /** One line for a picker card. */
  readonly tagline: string;
  /** Cost of engineers and researchers, indexed to 100. Higher is dearer. */
  readonly talentCostIndex: number;
  /** Cost of electricity, indexed to 100. Higher is dearer. */
  readonly energyCostIndex: number;
  /** How much government work is on offer, indexed to 100. Higher is more. */
  readonly procurementAppetite: number;
  /** Depth of local private and public capital, indexed to 100. */
  readonly capitalDepth: number;
  /**
   * Per-sector fit, indexed to 100. Above 100 the region is unusually good at
   * that sector — cheaper inputs, better supply, readier customers.
   */
  readonly sectorAffinities: Readonly<Record<Sector, number>>;
}

/**
 * The region table. Indices are whole numbers around 100 so the interface can
 * print them bare and a player can compare two regions by eye.
 */
export const REGION_META: Readonly<Record<Region, RegionMeta>> = {
  north_america: {
    id: 'north_america',
    icon: 'coins',
    label: 'North America',
    tagline: 'Deepest capital, dearest engineers',
    talentCostIndex: 130,
    energyCostIndex: 95,
    procurementAppetite: 130,
    capitalDepth: 145,
    sectorAffinities: { ai: 135, robotics: 100, manufacturing: 80, energy: 105, logistics: 100, consumer: 115 },
  },
  europe: {
    id: 'europe',
    icon: 'stamp',
    label: 'Europe',
    tagline: 'Precision engineering under a heavy rulebook',
    talentCostIndex: 105,
    energyCostIndex: 125,
    procurementAppetite: 110,
    capitalDepth: 100,
    sectorAffinities: { ai: 95, robotics: 120, manufacturing: 105, energy: 100, logistics: 105, consumer: 100 },
  },
  east_asia: {
    id: 'east_asia',
    icon: 'network',
    label: 'East Asia',
    tagline: 'The supply chain everyone else depends on',
    talentCostIndex: 85,
    energyCostIndex: 105,
    procurementAppetite: 95,
    capitalDepth: 110,
    sectorAffinities: { ai: 110, robotics: 140, manufacturing: 145, energy: 90, logistics: 120, consumer: 105 },
  },
  south_asia: {
    id: 'south_asia',
    icon: 'people',
    label: 'South Asia',
    tagline: 'The largest talent pool and the fastest new demand',
    talentCostIndex: 55,
    energyCostIndex: 90,
    procurementAppetite: 70,
    capitalDepth: 65,
    sectorAffinities: { ai: 105, robotics: 75, manufacturing: 105, energy: 85, logistics: 115, consumer: 120 },
  },
  middle_east: {
    id: 'middle_east',
    icon: 'vault',
    label: 'Middle East',
    tagline: 'Cheap power and sovereign money in a hurry',
    talentCostIndex: 95,
    energyCostIndex: 55,
    procurementAppetite: 120,
    capitalDepth: 120,
    sectorAffinities: { ai: 85, robotics: 70, manufacturing: 80, energy: 150, logistics: 110, consumer: 80 },
  },
  latin_america: {
    id: 'latin_america',
    icon: 'globe',
    label: 'Latin America',
    tagline: 'Renewables, resources and a young consumer market',
    talentCostIndex: 65,
    energyCostIndex: 85,
    procurementAppetite: 60,
    capitalDepth: 60,
    sectorAffinities: { ai: 75, robotics: 70, manufacturing: 95, energy: 115, logistics: 100, consumer: 110 },
  },
};

/** The table row for a region. Total, so callers never handle `undefined`. */
export function regionMeta(region: Region): RegionMeta {
  return REGION_META[region];
}

/** How well a region suits a sector, as a whole-number index around 100. */
export function regionSectorAffinity(region: Region, sector: Sector): number {
  return REGION_META[region].sectorAffinities[sector];
}

/**
 * Regions ordered by fit for one sector, best first. Ties break on `REGIONS`
 * order, which keeps the result deterministic.
 */
export function regionsBySectorAffinity(sector: Sector): readonly Region[] {
  return [...REGIONS].sort((a, b) => regionSectorAffinity(b, sector) - regionSectorAffinity(a, sector) || REGIONS.indexOf(a) - REGIONS.indexOf(b));
}

/** The region that suits a sector best. Deterministic; used as a chat default. */
export function defaultRegionFor(sector: Sector): Region {
  return regionsBySectorAffinity(sector)[0] ?? DEFAULT_REGION;
}
