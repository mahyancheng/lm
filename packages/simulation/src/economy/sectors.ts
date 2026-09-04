/**
 * @frontier/simulation — economy/sectors.ts
 *
 * The real-economy layer of world version 2: six sectors, each on its own demand
 * cycle, coupled through the supply graph declared in `@frontier/contracts`.
 *
 * Everything here is a **pure function of the draft**. No RNG, no clock, no
 * mutation: the same state yields the same conditions on every machine, which is
 * what lets the product, financial, talent and market phases all read the same
 * numbers without any of them having to agree on an order.
 *
 * ## World version gating
 *
 * World version 1 is frozen. Every multiplier in this file returns exactly `1`
 * (and every gate exactly `1`) for a version-1 session, so a legacy save
 * replays byte-identically. `isMultiSectorWorld` is the only place that decision
 * is made; nothing else in the engine reads `config.worldVersion` directly.
 *
 * ## What the couplings actually do
 *
 * | coupling                                   | where it lands                  |
 * |--------------------------------------------|---------------------------------|
 * | each sector's own demand cycle              | product demand (gross adds)     |
 * | energy price into energy-hungry sectors     | cost of goods                   |
 * | AI capability as economy-wide productivity  | cost of goods (downward)        |
 * | upstream supply shortfall                   | demand realisation gate         |
 * | capital intensity                           | sustaining capital in cost      |
 *
 * The supply gate is deliberately one-sided: a starved sector cannot realise the
 * demand it has, but a sector whose inputs are abundant does **not** get to sell
 * more than its customers want. Surplus shows up as price and margin pressure in
 * the market phase, not as extra volume here.
 */

import type { Company, SessionState } from '@frontier/contracts';
import {
  DEFAULT_SECTOR,
  NODE_ECONOMY_WORLD_VERSION,
  SECTORS,
  SECTOR_META,
  sectorInputs,
  sectorPriceFactor,
  sectorPriceIndex,
  sectorShortage,
  shortageGate,
  type Sector,
  type WholeBand,
} from '@frontier/contracts';
import { clamp, clamp01 } from './util';

/* -------------------------------------------------------------------------- */
/*  World version                                                              */
/* -------------------------------------------------------------------------- */

/** The first world version whose economy spans more than the AI sector. */
export const MULTI_SECTOR_WORLD_VERSION = 2;

/**
 * Whether this session runs the multi-sector economy. The single gate: a
 * version-1 session takes none of the branches below, so its numbers are the
 * ones it has always produced.
 */
export function isMultiSectorWorld(state: SessionState): boolean {
  return state.config.worldVersion >= MULTI_SECTOR_WORLD_VERSION;
}

/**
 * The first world version whose economy is the one node table. Taken from the
 * contracts rather than restated, so the two can never drift apart.
 */
export const NODE_ECONOMY_VERSION: number = NODE_ECONOMY_WORLD_VERSION;

/**
 * Whether this session runs the node economy.
 *
 * A second gate, deliberately not a reuse of `isMultiSectorWorld`. That one
 * means "version 2 or later" and world 2 is frozen: repurposing it would drag a
 * live world-2 game into world-3 behaviour the quarter this shipped. Every
 * world-3 branch in the engine asks this and only this.
 */
export function isNodeEconomyWorld(state: SessionState): boolean {
  return state.config.worldVersion >= NODE_ECONOMY_VERSION;
}

/** The sector a company operates in, total even for a save that predates the field. */
export function sectorOf(company: Company): Sector {
  return company.sector ?? DEFAULT_SECTOR;
}

/* -------------------------------------------------------------------------- */
/*  Balancing constants                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Peak deviation of a sector's demand cycle from its baseline, as a fraction.
 * At 0.16 a sector runs between 84% and 116% of trend across its cycle, which is
 * large enough to be worth planning around and small enough that a good company
 * in a bad quarter is still a good company.
 */
export const SECTOR_CYCLE_AMPLITUDE = 0.16;

/**
 * Hard bounds on the demand multiplier after every term has been applied.
 *
 * The floor is 0.35 rather than 0.6 because the stateful shortage counter can
 * take the realisation gate down to 0.40 on its own (`SECTOR_SHORTAGE_MAX` is
 * 60), and a crisis a bound quietly cancels is not a crisis. Nothing but a fully
 * developed shortage reaches anywhere near it.
 */
export const SECTOR_DEMAND_BOUNDS = { min: 0.35, max: 1.5 } as const;

/**
 * The floor the upstream supply gate can pull demand realisation down to. A
 * sector whose inputs have collapsed still ships three quarters of what it sold,
 * because contracts, inventory and substitution all take time to fail.
 */
export const SUPPLY_GATE_FLOOR = 0.75;

/**
 * How much of a coupled sector's output one dollar of downstream revenue calls
 * on. Used only to form the tightness ratio, never as a cash flow.
 */
export const SUPPLY_COUPLING = 0.35;

/**
 * Most a fully capable, fully adopted AI sector can take off everybody else's
 * cost of goods. Twelve percent is a decade of productivity growth arriving at
 * once, which is the claim the game is making.
 */
export const AI_PRODUCTIVITY_MAX_UPLIFT = 0.12;

/**
 * Share of an electricity price move that reaches an energy-consuming sector's
 * cost of goods, before that sector's own capital intensity scales it.
 */
export const ENERGY_COST_PASS_THROUGH = 0.35;

/**
 * Hard bounds on the input-cost multiplier after every term has been applied.
 *
 * Widened from `[0.85, 1.40]` when goods prices arrived: the mean input price
 * index alone spans 0.25 to 1.75, and clamping it back to the old band would
 * have made the whole chain unreadable at exactly the moment it mattered.
 */
export const SECTOR_INPUT_COST_BOUNDS = { min: 0.7, max: 1.8 } as const;

/**
 * Sustaining capital as a share of revenue at capital intensity 100. Energy
 * (intensity 95) therefore reinvests about 8.6% of revenue just to stand still;
 * consumer (intensity 20) reinvests 1.8%. Booked into cost of goods rather than
 * as capital expenditure, so the double entry stays inside the one place that is
 * allowed to move cash.
 */
export const SUSTAINING_CAPITAL_MAX_REVENUE_SHARE = 0.09;

/* -------------------------------------------------------------------------- */
/*  Demand cycles                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Where a sector sits in its cycle at quarter 0, as a fraction of one full turn.
 * Derived from position in `SECTORS`, so the six sectors are spread evenly and
 * the whole economy never breathes in unison — and so the phase is a constant of
 * the build rather than a seeded draw that a replay would have to reproduce.
 */
export function sectorCyclePhase(sector: Sector): number {
  return SECTORS.indexOf(sector) / SECTORS.length;
}

/**
 * A sector's demand multiplier from its own cycle alone: 1 at trend, and between
 * `1 - SECTOR_CYCLE_AMPLITUDE` and `1 + SECTOR_CYCLE_AMPLITUDE` across the cycle
 * length `SECTOR_META[sector].demandCycleQuarters`.
 */
export function sectorDemandCycle(sector: Sector, quarter: number): number {
  const meta = SECTOR_META[sector];
  const length = Math.max(1, meta.demandCycleQuarters);
  const turns = quarter / length + sectorCyclePhase(sector);
  return 1 + SECTOR_CYCLE_AMPLITUDE * Math.sin(2 * Math.PI * turns);
}

/* -------------------------------------------------------------------------- */
/*  Sector economy                                                             */
/* -------------------------------------------------------------------------- */

/** Everything the phases need to know about one sector this quarter. */
export interface SectorEconomy {
  readonly sector: Sector;
  /** Annualised revenue of every active company in the sector. The supply proxy. */
  readonly supplyUsd: number;
  /** How well supplied the sector is relative to what its customers call on, 0..1. */
  readonly tightness: number;
  /** Where the sector's own demand cycle stands, around 1. */
  readonly cycle: number;
  /** Realisation gate from upstream shortfall: `SUPPLY_GATE_FLOOR`..1. */
  readonly supplyGate: number;
  /** Multiplier on new demand: cycle x gate x market sentiment, bounded. */
  readonly demandMultiplier: number;
  /** Multiplier on cost of goods: energy pass-through x AI productivity x input prices, bounded. */
  readonly inputCostMultiplier: number;
  /** Sustaining capital as a share of revenue, from the sector's capital intensity. */
  readonly sustainingCapitalShare: number;
  /** Mean price index of this sector's inputs as a multiplier around 1. Exactly 1 with no inputs and no prices. */
  readonly inputPriceFactor: number;
  /** This sector's own goods price index, whole number around 100. */
  readonly priceIndex: number;
  /** This sector's stateful shortage counter, 0..60. */
  readonly shortage: number;
}

/** The neutral row a version-1 session sees: every multiplier exactly one. */
export function neutralSectorEconomy(sector: Sector): SectorEconomy {
  return {
    sector,
    supplyUsd: 0,
    tightness: 1,
    cycle: 1,
    supplyGate: 1,
    demandMultiplier: 1,
    inputCostMultiplier: 1,
    sustainingCapitalShare: 0,
    inputPriceFactor: 1,
    priceIndex: 100,
    shortage: 0,
  };
}

/**
 * One company's contribution to its sector's supply, in whole dollars.
 *
 * Trailing revenue where the metrics phase has written it, four times the
 * quarter otherwise. Stated once and exported so a screen drawing a
 * market-share bar divides by the same numerator the engine summed, rather than
 * restating the rule and drifting from it. Structurally typed because the
 * interface reads it off a redacted rival, which is a `Partial<Company>`.
 */
export function annualisedRevenueUsd(company: {
  readonly fundamentals?: { readonly revenueTtmUsd: number } | undefined;
  readonly financials?: { readonly revenueQuarterly: number } | undefined;
}): number {
  const trailing = company.fundamentals?.revenueTtmUsd ?? 0;
  if (trailing > 0) return trailing;
  return Math.max(0, company.financials?.revenueQuarterly ?? 0) * 4;
}

/** Annualised revenue by sector. Trailing revenue where the metrics phase has written it. */
export function supplyBySector(state: SessionState): Record<Sector, number> {
  const supply = {} as Record<Sector, number>;
  for (const sector of SECTORS) supply[sector] = 0;
  for (const company of state.companies) {
    if (!company.isActive) continue;
    supply[sectorOf(company)] += annualisedRevenueUsd(company);
  }
  return supply;
}

/**
 * How well supplied each sector is, 0 (nothing) to 1 (enough for everyone who
 * calls on it). `2s / (s + c·d)` is exactly 1 when supply equals the coupled
 * demand of the sectors downstream, and saturates rather than rewarding surplus.
 * A sector nobody consumes is always 1: there is nothing for it to be short of.
 */
export function tightnessBySector(state: SessionState, supply: Record<Sector, number>): Record<Sector, number> {
  const tightness = {} as Record<Sector, number>;
  for (const sector of SECTORS) {
    let downstream = 0;
    for (const consumer of SECTOR_META[sector].outputs) downstream += supply[consumer];
    const called = SUPPLY_COUPLING * downstream;
    tightness[sector] = called <= 0 ? 1 : clamp01((2 * supply[sector]) / (supply[sector] + called));
  }
  return tightness;
}

/** Market sentiment for the market bucket a real-economy sector mostly trades in. */
const MARKET_SECTOR_FOR: Readonly<Record<Sector, string>> = {
  ai: 'frontier_models',
  robotics: 'enterprise_software',
  manufacturing: 'semiconductors',
  energy: 'energy_infrastructure',
  logistics: 'data_services',
  consumer: 'consumer_ai',
};

/**
 * Compute every sector's conditions for this quarter.
 *
 * Call this **once per phase**, before the per-company loop, and index into the
 * result: it walks every company, so calling it inside the loop would be
 * quadratic in a world with two hundred of them.
 */
export function sectorEconomy(state: SessionState): Readonly<Record<Sector, SectorEconomy>> {
  const out = {} as Record<Sector, SectorEconomy>;
  if (!isMultiSectorWorld(state)) {
    for (const sector of SECTORS) out[sector] = neutralSectorEconomy(sector);
    return out;
  }

  const supply = supplyBySector(state);
  const tightness = tightnessBySector(state, supply);

  // Frontier capability only raises productivity to the extent the AI sector can
  // actually supply it: capability nobody can buy changes nobody's cost.
  const adoption = clamp01(state.world.aiFrontier.frontierCapability) * tightness.ai;
  const productivity = 1 - AI_PRODUCTIVITY_MAX_UPLIFT * adoption;
  const electricity = state.world.energy.electricityPrice;

  for (const sector of SECTORS) {
    const meta = SECTOR_META[sector];

    const gate = supplyGateFor(state, sector, tightness);

    const cycle = sectorDemandCycle(sector, state.quarter);
    const marketSector = state.sectors[MARKET_SECTOR_FOR[sector]];
    // Sector sentiment is a belief, so it nudges demand rather than setting it.
    const sentiment = 1 + 0.08 * (marketSector?.sentiment ?? 0);

    const energyExposure = meta.inputs.includes('energy') ? meta.capexIntensity / 100 : 0;
    // The buyer side of the goods chain: what this sector's inputs cost, as the
    // mean of their price indices. A sector with no inputs pays exactly 1.
    const inputPrice = meanInputPriceFactor(state, sector);
    const inputCost = (1 + ENERGY_COST_PASS_THROUGH * energyExposure * (electricity - 1)) * productivity * inputPrice;

    out[sector] = {
      sector,
      supplyUsd: supply[sector],
      tightness: tightness[sector],
      cycle,
      supplyGate: gate,
      demandMultiplier: clamp(cycle * gate * sentiment, SECTOR_DEMAND_BOUNDS.min, SECTOR_DEMAND_BOUNDS.max),
      inputCostMultiplier: clamp(inputCost, SECTOR_INPUT_COST_BOUNDS.min, SECTOR_INPUT_COST_BOUNDS.max),
      sustainingCapitalShare: (SUSTAINING_CAPITAL_MAX_REVENUE_SHARE * meta.capexIntensity) / 100,
      inputPriceFactor: inputPrice,
      priceIndex: sectorPriceIndex(state, sector),
      shortage: sectorShortage(state, sector),
    };
  }
  return out;
}

/**
 * The realisation gate one sector faces from its inputs.
 *
 * Two constraints, and the binding one wins:
 *
 * - the **tightness gate**, `SUPPLY_GATE_FLOOR + (1 - floor) x tightness`, which
 *   is the original soft coupling and costs at most 25% of realised demand;
 * - the **shortage gate**, `1 - shortage/100`, which is the stateful half of the
 *   price rule and takes over once the price clamp has saturated.
 *
 * With no shortage the shortage term is exactly 1, so the gate is the number it
 * has always been. A fully developed shortage upstream takes it to 0.40, which
 * is a crisis rather than a headwind — and takes six quarters of neglect to
 * arrive at and twelve to recover from.
 *
 * Deliberately a `min` of the two rather than the study's outright replacement:
 * dropping the tightness gate would have deleted a tuned mechanic and its tests
 * along with it, and a shortage is by construction the tighter of the two
 * wherever it matters at all.
 */
export function supplyGateFor(state: SessionState, sector: Sector, tightness: Readonly<Record<Sector, number>>): number {
  let gate = 1;
  for (const input of sectorInputs(sector)) {
    const byTightness = SUPPLY_GATE_FLOOR + (1 - SUPPLY_GATE_FLOOR) * tightness[input];
    gate = Math.min(gate, byTightness, shortageGate(sectorShortage(state, input)));
  }
  return clamp01(gate);
}

/** Mean price index of a sector's inputs, as a multiplier around 1. Exactly 1 with no inputs. */
export function meanInputPriceFactor(state: SessionState, sector: Sector): number {
  const inputs = sectorInputs(sector);
  if (inputs.length === 0) return 1;
  let sum = 0;
  for (const input of inputs) sum += sectorPriceFactor(sectorPriceIndex(state, input));
  return sum / inputs.length;
}

/* -------------------------------------------------------------------------- */
/*  Bands                                                                      */
/* -------------------------------------------------------------------------- */

/** A sector's sustainable gross margin band as fractions rather than whole percents. */
export function sectorMarginBand(sector: Sector): { readonly min: number; readonly max: number } {
  const band: WholeBand = SECTOR_META[sector].grossMarginBandPct;
  return { min: band[0] / 100, max: band[1] / 100 };
}

/** A sector's trailing-revenue multiple band, as whole multiples. */
export function sectorRevenueMultipleBand(sector: Sector): WholeBand {
  return SECTOR_META[sector].revenueMultipleBand;
}

/** Sustaining capital a company of this size owes its sector each quarter. */
export function sustainingCapitalUsd(economy: SectorEconomy, quarterlyRevenueUsd: number): number {
  return Math.max(0, quarterlyRevenueUsd) * economy.sustainingCapitalShare;
}
