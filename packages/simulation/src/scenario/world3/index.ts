/**
 * @frontier/simulation — scenario/world3
 *
 * The world-version-3 opening state: the world-2 economy, re-founded on the one
 * node table, with every company selling composed lines.
 *
 * ## What this module builds
 *
 * The seeds, the player, the people, the government and the market tape are
 * world 2's — cloned by *derivation* rather than by copy, so there is one place
 * those numbers live and world 2 keeps hashing to what it has always hashed to
 * — and on top of them this module adds the thing world 3 is actually about:
 *
 * - `config.worldVersion` is 3, so `isNodeEconomyWorld` is true and every
 *   world-3 branch switches on here and nowhere else;
 * - every company carries `ownedNodes`, derived by the rule in
 *   `@frontier/contracts`'s `nodeOwnership.ts` — never a hand-written list;
 * - **every node in the table has at least one producer at seed**, which is the
 *   direct fix for world 2, where `manufacturing_accelerators` was a required
 *   input of three categories and was sold by nobody;
 * - every seeded rival opens with the one or two **composed lines** in
 *   `lines.ts` — real fills, real sources, a real target cell, and published
 *   terms where the table says so — and the player opens with the composed
 *   line of their background from `BACKGROUND_OPENING_LINE`;
 * - `industryBaselineUsd` is written once, so the size of each buying industry
 *   is measured against what it was when the world was built;
 * - every node opens at the price index its own opening balance settles to
 *   (`w3NodePrices`), every ask is struck on costs at those prices and never
 *   below them (`w3LineAsks`), and every line's `qualityScore` is what the
 *   engine's own quality blend says of it (`w3SeedQualities`) — so nothing a
 *   founder sees on quarter zero is quietly repriced or re-rated on quarter
 *   one for no reason they could have acted on.
 *
 * `world3SessionInput` returns the fully measured input, so the demo
 * dispatcher and `createWorld3Session` build the same world: a player's New
 * Game and the picker that described it agree.
 *
 * ## Determinism
 *
 * Everything below is a pure function of the node table, the line table and
 * the world-2 seeds. No RNG, no clock, no module-level cache. The same seed and
 * setup produce a byte-identical opening state on any machine.
 */

import type {
  CompanyInput,
  NewGameSetup,
  ProductSegment,
  ProductSlotFill,
  Sector,
  SessionState,
  SessionStateInput,
  W3SeedLine,
  WorldVersion,
} from '@frontier/contracts';
import {
  BACKGROUND_OPENING_LINE,
  ECONOMIC_NODES,
  ECONOMIC_NODES_BY_ID,
  NewGameSetupSchema,
  NODE_ECONOMY_WORLD_VERSION,
  NODE_PRICE_BASELINE,
  SECTORS,
  SessionStateSchema,
  nextNodePriceIndex,
  nodeMarketPriceUsd,
  nodeTargetIndex,
  primaryCustomerOf,
  requiresClosure,
  startingNodesFor,
  startingNodesForRival,
  type BackgroundId,
  type EconomicNode,
} from '@frontier/contracts';
import { V2_COMPANY_SEEDS, W2_COMPANIES } from '../world2';
import { effectivePolicy } from '../../companies/archetypes';
import { DEBT_AMORTISATION_PER_QUARTER, DEBT_RISK_PREMIUM } from '../../companies/balance';
import { NODE_DISCRETIONARY_GROSS_PROFIT_SHARE } from '../../companies/policy';
import { regionalCompUsd } from '../../companies/hiring';
import { sectorBalances } from '../../economy/prices';
import { supplyBySector } from '../../economy/sectors';
import { createNodeCostCache } from '../../graph/lines';
import { bucketShare, nodeBalances, producibleUnits } from '../../graph/market';
import { unitCostOf } from '../../graph/cost';
import { SEGMENT_DATA_WEIGHT, petabytesPerUnit } from '../../graph/data';
import { effectiveQuality } from '../../graph/production';
import { nodeTechGraph } from '../../graph/techGraph';
import { world2SessionInput } from '../world2';
import { w3RivalLinesFor, w3SeedCompanyId, w3SeedProductId } from './lines';

/** The version a world-3 session declares. Pinned, exactly as world 2 pins 2. */
export const WORLD_3_VERSION: WorldVersion = NODE_ECONOMY_WORLD_VERSION;

/** The seed the world-3 demo opens on, matching the frozen world's. */
export const W3_SEED = 424242;

/** The most nodes one company may own, matching `Company.ownedNodes`'s bound. */
export const W3_MAX_OWNED_NODES = 48;

/** The staff roles a wage bill is summed over, in `Company.employees`'s own order. */
const W3_STAFF_ROLES = ['engineers', 'researchers', 'sales', 'ops', 'execs'] as const;

/** Quarters in a year, for turning annual compensation into one quarter of wages. */
const QUARTERS_PER_YEAR = 4;

/** The slug the world-2 player seed is built under; its product ids derive from it. */
export const W3_PLAYER_SLUG = 'player_ventures';

/**
 * What a new game defaults to when the chat has established nothing: the same
 * enterprise AI company in North America world 2 opens on, at version 3.
 */
export const W3_DEFAULT_SETUP: NewGameSetup = NewGameSetupSchema.parse({
  companyName: 'Player Ventures',
  founderName: 'Avery Sinclair',
  backgroundId: 'enterprise_ai',
  sector: 'ai',
  region: 'north_america',
  worldVersion: WORLD_3_VERSION,
});

/* -------------------------------------------------------------------------- */
/*  Which lines a company opens with                                           */
/* -------------------------------------------------------------------------- */

/**
 * The composed lines of every company in the opening world, keyed by company
 * id: the rivals' from `lines.ts`, the player's from their background card.
 */
export function w3SeedLinesFor(setup: NewGameSetup): Readonly<Record<string, readonly W3SeedLine[]>> {
  const out: Record<string, readonly W3SeedLine[]> = {};
  for (const seed of V2_COMPANY_SEEDS) out[seed.id] = w3RivalLinesFor(seed.id);
  out[W2_COMPANIES.player] = [BACKGROUND_OPENING_LINE[setup.backgroundId]];
  return out;
}

/** The seed slug behind a company id, from which its product ids derive. */
function w3SlugOf(companyId: string): string {
  if (companyId === W2_COMPANIES.player) return W3_PLAYER_SLUG;
  return V2_COMPANY_SEEDS.find((seed) => seed.id === companyId)?.slug ?? companyId;
}

/* -------------------------------------------------------------------------- */
/*  Ownership across the whole world                                           */
/* -------------------------------------------------------------------------- */

interface OwnershipSubject {
  readonly companyId: string;
  readonly sector: Sector;
  /** Null for the player, whose start comes from the background card instead. */
  readonly capabilityLevel: number | null;
  readonly background: BackgroundId | null;
  /** The nodes of the lines the company opens selling; a rival's signature. */
  readonly lineNodeIds: readonly string[];
}

/** Dollars and cents. Every price in state is stored to the cent, never to the dollar. */
function roundCents(usd: number): number {
  return Math.round(usd * 100) / 100;
}

/** Keep the node table's order, which makes every list hashable and comparable. */
function inTableOrder(ids: Iterable<string>): string[] {
  const wanted = new Set(ids);
  return ECONOMIC_NODES.filter((entry) => wanted.has(entry.id)).map((entry) => entry.id);
}

/**
 * Node ownership for every company in the world, keyed by company id.
 *
 * Two passes, both deterministic:
 *
 * 1. **The rule.** Each company gets `startingNodesFor` (player) or
 *    `startingNodesForRival` (everyone else) — its own sector up to its reach,
 *    the nodes of every line it opens selling as its signature, every tier-0
 *    commodity, and the `requires` closure of those lines.
 * 2. **Coverage.** Any node still without a producer is given to the company in
 *    that node's sector holding the fewest nodes, with its `requires` closure,
 *    so the world opens with a supplier for everything. Ties break on company
 *    id, and a sector with no company at all falls back to the smallest holder
 *    anywhere — the world must not open with an unmakeable input.
 */
export function w3NodeOwnership(subjects: readonly OwnershipSubject[]): Readonly<Record<string, readonly string[]>> {
  const owned = new Map<string, Set<string>>();
  const sectorOf = new Map<string, Sector>();

  for (const subject of subjects) {
    sectorOf.set(subject.companyId, subject.sector);
    const ids =
      subject.background !== null
        ? startingNodesFor(subject.background)
        : startingNodesForRival(subject.sector, subject.capabilityLevel ?? 0, subject.lineNodeIds);
    owned.set(subject.companyId, new Set(ids));
  }

  const ordered = [...owned.keys()].sort();
  const holdersOf = (nodeId: string): boolean => ordered.some((companyId) => owned.get(companyId)?.has(nodeId) === true);

  const smallestHolder = (sector: Sector | null): string | null => {
    let best: string | null = null;
    let bestSize = Number.POSITIVE_INFINITY;
    for (const companyId of ordered) {
      if (sector !== null && sectorOf.get(companyId) !== sector) continue;
      const size = owned.get(companyId)?.size ?? 0;
      if (size < bestSize) {
        best = companyId;
        bestSize = size;
      }
    }
    return best;
  };

  for (const node of ECONOMIC_NODES) {
    if (holdersOf(node.id)) continue;
    const holder = smallestHolder(node.sector) ?? smallestHolder(null);
    if (holder === null) continue;
    const set = owned.get(holder);
    if (set === undefined) continue;
    for (const id of requiresClosure(node.id)) set.add(id);
  }

  const result: Record<string, readonly string[]> = {};
  for (const companyId of ordered) {
    // The bound is a schema bound, so it is enforced here rather than hoped
    // for: the tail of the table order is dropped, never the head, which keeps
    // the company's own chain intact.
    result[companyId] = inTableOrder(owned.get(companyId) ?? []).slice(0, W3_MAX_OWNED_NODES);
  }
  return result;
}

/** Every company in the world-3 opening state, as an ownership subject. */
export function w3OwnershipSubjects(setup: NewGameSetup): readonly OwnershipSubject[] {
  const lines = w3SeedLinesFor(setup);
  return [
    ...V2_COMPANY_SEEDS.map((seed) => ({
      companyId: seed.id,
      sector: seed.sector,
      capabilityLevel: seed.capabilityLevel,
      background: null,
      lineNodeIds: (lines[seed.id] ?? []).map((line) => line.nodeId),
    })),
    {
      companyId: W2_COMPANIES.player,
      sector: setup.sector,
      capabilityLevel: null,
      background: setup.backgroundId,
      lineNodeIds: (lines[W2_COMPANIES.player] ?? []).map((line) => line.nodeId),
    },
  ];
}

/* -------------------------------------------------------------------------- */
/*  Opening lines                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Headroom the opening capacity carries over what the opening run rate needs.
 *
 * A quarter more than the line is already selling, so a rival can grow into it
 * for a year before it has to build — and so `invest_capacity`, which no NPC
 * policy takes yet, is not the only thing standing between the seeded world and
 * a permanent shortage of everything.
 */
export const W3_CAPACITY_HEADROOM = 1.25;

/** How many quarters of a durable line's output are already in the field at seed. */
export const W3_INSTALLED_BASE_QUARTERS = 8;

/**
 * How much of its cash a pre-revenue company has already put into the lines it
 * opens on, split between them by revenue share.
 *
 * A company with no revenue yet still has a pilot line: without one its opening
 * capacity would be zero, it could never make a first unit, and it would be
 * dead on turn one for a reason no player could see or fix. A twentieth of the
 * bank is a pilot, not a plant.
 */
export const W3_PILOT_CASH_SHARE = 0.05;

/** The node whose price the compute capacity rate is struck on, restated for the seed. */
const ACCELERATOR_NODE_ID = 'sys_ai_accelerator';

/**
 * A seed line's fills as the product stores them.
 *
 * `'self'` names the company's own line on that node when the same seed runs
 * one, and a supplier slug names that rival's line on the node when it is
 * published here; either that cannot be honoured falls to the open market,
 * which is exactly the clamp the validator applies to a launch. The shipped
 * table never relies on the fallback: `world3Scenario.test.ts` resolves every
 * fill and asserts the route it was written for.
 */
function w3FillsFor(ownerId: string, ownerSlug: string, ownerLines: readonly W3SeedLine[], line: W3SeedLine): ProductSlotFill[] {
  const out: ProductSlotFill[] = [];
  for (const fill of line.fills) {
    let supplierCompanyId: string | null = null;
    let supplierProductId: string | null = null;
    if (fill.source === 'self') {
      const index = ownerLines.findIndex((candidate) => candidate.nodeId === fill.nodeId);
      if (index >= 0) {
        supplierCompanyId = ownerId;
        supplierProductId = w3SeedProductId(ownerSlug, index);
      }
    } else if (fill.source !== 'market') {
      const sellerId = w3SeedCompanyId(fill.source);
      const index = w3RivalLinesFor(sellerId).findIndex((candidate) => candidate.nodeId === fill.nodeId && candidate.published);
      if (index >= 0) {
        supplierCompanyId = sellerId;
        supplierProductId = w3SeedProductId(fill.source, index);
      }
    }
    out.push({ slotId: fill.slotId, nodeId: fill.nodeId, supplierCompanyId, supplierProductId, cutOffNoticeQuarter: null, changedQuarter: null });
  }
  return out;
}

/** One line as it is about to be written, with what the capacity and data passes need to know about it. */
interface BuiltLine {
  readonly product: NonNullable<CompanyInput['products']>[number];
  readonly node: EconomicNode;
  readonly seedUnits: number;
  readonly capacityUnits: number;
  readonly priceUsd: number;
}

/**
 * Turn one world-2 company into a world-3 one: it produces and sells its
 * composed lines.
 *
 * Everything is derived — each price is the node's own base price or the ask
 * the roll-up supports, the units are the revenue the seed already declares
 * split by `revenueShare` and divided by that price, and the capacity is
 * exactly what those units draw with headroom, summed per bucket over every
 * line drawing on it — so the opening world has no hand-written numbers in it
 * and a change to the node table moves the scenario with it.
 *
 * The capacity is added to property, plant and equipment **and** to equity, so
 * the opening balance sheet still reconciles and the depreciation the financial
 * phase writes off is the depreciation the unit costs allocate.
 */
function asNodeCompany(
  company: CompanyInput,
  lines: readonly W3SeedLine[],
  asks: Readonly<Record<string, number>>,
  runRates: Readonly<Record<string, number>>,
  qualities: Readonly<Record<string, number>>,
): CompanyInput {
  const template = company.products?.[0];
  if (template === undefined || lines.length === 0) return company;
  const slug = w3SlugOf(company.id);
  const isPlayer = company.id === W2_COMPANIES.player;
  const brand = company.name.split(' ')[0] ?? company.name;
  const revenue = Math.max(0, company.financials?.revenueQuarterly ?? 0);
  // A pre-revenue company sizes its pilot off its bank instead of off a run
  // rate it does not have yet.
  const cash = Math.max(0, company.balanceSheet?.assets.cash ?? 0);

  const built: BuiltLine[] = [];
  lines.forEach((line, index) => {
    const node = ECONOMIC_NODES_BY_ID[line.nodeId];
    if (node === undefined) return;
    const productId = w3SeedProductId(slug, index);
    // Cents, not whole dollars: a packaging material sells for about a dollar a
    // unit and rounding its ask to the nearest dollar would put it under its own
    // cost by twenty percent before the world had opened.
    const priceUsd = Math.max(0.01, roundCents(asks[productId] ?? node.basePriceUsd));
    const lineRevenue = revenue * line.revenueShare;
    const seedUnits = lineRevenue > 0 ? Math.max(1, Math.round(lineRevenue / priceUsd)) : 0;
    // The run rate the company has to be at to pay its own people; see
    // `w3LineRunRates`. Never below the seed's own, and only ever applied to a
    // line that already has revenue — a pre-revenue background opens
    // pre-revenue.
    const runRate = runRates[productId];
    const units = seedUnits > 0 && runRate !== undefined ? Math.max(seedUnits, runRate) : seedUnits;
    const capacityUnits = units > 0 ? units : Math.max(1, Math.round((cash * W3_PILOT_CASH_SHARE * line.revenueShare) / priceUsd));
    const next: Record<string, unknown> = {
      ...template,
      id: productId,
      // A rival's line is named for what it now sells; the player's is the
      // founder's own name for it.
      name: isPlayer ? template.name : `${brand} ${node.label}`,
      nodeId: node.id,
      // The target cell the line is composed for: its customer type, and the
      // industry it is aimed at.
      segment: line.segment,
      targetIndustry: line.targetIndustry,
      pricePerSeat: priceUsd,
      activeCustomers: units,
      unitsSoldQuarterly: units,
      installedBase: node.saleKind === 'unit' ? units * W3_INSTALLED_BASE_QUARTERS : 0,
      backlogUnits: 0,
      unitCostUsd: 0,
      contractBilledUsd: 0,
      craftQuality: template.qualityScore,
      // What the line is worth to a buyer at quarter zero: the engine's own
      // blend of craft, data edge and what its suppliers ship (see
      // `w3SeedQualities`), so the market opens rating the line as the first
      // resolution will. The craft above stays the seed's own.
      qualityScore: qualities[productId] ?? template.qualityScore,
      qualityTier: template.computeIntensity,
      // World 3 keys a line on its node and composes it in `slots`. The
      // world-2 category and the world-2 supplier choices are dropped rather
      // than reinterpreted: a category id is not a node id, and leaving one
      // behind would let a reader think the line still has a category.
      supply: [],
      slots: w3FillsFor(company.id, slug, lines, line),
      // Published at list price: exactly the terms the NPC policy would write
      // on quarter one, so a seeded seller and a later one price the same way.
      supplyTerms: line.published ? { openToAll: true, pricePerUnitUsd: priceUsd, exclusiveCustomerIds: [], blockedCustomerIds: [] } : null,
    };
    delete next.categoryId;
    if (node.saleKind === 'contract') next.contractRemainingQuarters = 0;
    built.push({ product: next as typeof template, node, seedUnits, capacityUnits, priceUsd });
  });
  if (built.length === 0) return company;

  // What one quarter of each line's run rate draws on its own bucket, sized so
  // that EVERY line on the bucket holds `W3_CAPACITY_HEADROOM` of its own draw
  // under the engine's own split. Lines out of one bucket share it by
  // `bucketShare` — a quarter split equally, the rest in proportion to what
  // each drew — so a line drawing a fraction p of the bucket holds
  // 0.25/n + 0.75p of it, not p: summing the draws and adding headroom once
  // would leave the dominant line of a two-line rival with eleven percent of
  // growth room instead of twenty-five, and every buyer of what it makes a
  // tighter market than the seed intended. A single line holds the whole
  // bucket, so for it this is exactly draw × headroom.
  const bucketUnits = { plant: 0, fleet: 0, grid: 0, compute: 0 };
  const drawsByKind = new Map<keyof typeof bucketUnits, number[]>();
  for (const entry of built) {
    const kind = entry.node.capacityKind;
    if (kind === 'none') continue;
    const drawPerUnit = entry.node.capacityDrawPerUnit * (0.5 + (entry.product.qualityTier ?? 0.5));
    const draws = drawsByKind.get(kind) ?? [];
    draws.push(entry.capacityUnits * drawPerUnit);
    drawsByKind.set(kind, draws);
  }
  for (const [kind, draws] of drawsByKind) {
    const total = draws.reduce((sum, draw) => sum + draw, 0);
    let stock = 0;
    for (const draw of draws) stock = Math.max(stock, (draw * W3_CAPACITY_HEADROOM) / bucketShare(draw, total, draws.length));
    bucketUnits[kind] = stock;
  }
  const physical = built.some((entry) => entry.node.capacityKind === 'plant' || entry.node.capacityKind === 'fleet' || entry.node.capacityKind === 'grid');
  const onCompute = built.some((entry) => entry.node.capacityKind === 'compute');

  // A company opens pointing its capacity where its OWN archetype policy says
  // it should, rather than where the world-2 seed happened to leave it. The two
  // disagreed badly: an infrastructure company was seeded pointing seventy
  // percent of its fleet at training against an archetype policy of twelve, and
  // since the fleet has to be big enough that the SERVING share alone covers the
  // run rate, that one number sized its fleet at three and a third times what
  // its line draws. It is also the number the NPC policy moves a company to on
  // turn one anyway, so seeding it is the seed agreeing with the engine rather
  // than being corrected by it.
  const compute = company.compute;
  const trainingAllocation =
    compute === undefined ? 0 : effectivePolicy(company.archetype, company.posture).trainingAllocation;
  const servingShare = Math.max(0.05, 1 - trainingAllocation);

  let capacity = company.capacity;
  let requiredPpeUsd = 0;
  // NOBODY OPENS RENTING CAPACITY.
  //
  // World 2 left a robotics laboratory holding nine hundred reserved
  // accelerators and half a million dollars a quarter of cloud beside a plant
  // line that cannot draw on either: in world 3 that is three million dollars a
  // quarter of rent against no revenue, most of it charged to research and the
  // rest to idle capacity. Rent nothing produces is an idle-capacity charge on
  // capacity the line never asked for; untrimmed cloud is serving capacity that
  // is really unbounded, so nothing rations a line's growth; and a reservation
  // carries an expiry from the world-2 seed, which is a cliff nobody can see.
  //
  // So the opening fleet is OWNED, and it is exactly what the lines draw. That
  // is also the only reading consistent with the balance sheet below, which
  // books `needed` accelerators as property whether they were owned or rented.
  // Renting stays a lever the founder may pull; it is no longer a thing the
  // seed pulls for them.
  const rentedTrim = compute === undefined ? {} : { reservedAccelerators: 0, cloudSpendQuarterly: 0, reservationExpiryQuarter: null };
  let nextCompute = compute === undefined ? compute : { ...compute, trainingAllocation, ...rentedTrim };
  if (physical) {
    const plantUsd = Math.round(bucketUnits.plant * 1_000_000);
    const fleetUsd = Math.round(bucketUnits.fleet * 1_000_000);
    const gridUsd = Math.round(bucketUnits.grid * 1_000_000);
    requiredPpeUsd += plantUsd + fleetUsd + gridUsd;
    // Exactly the buckets the lines draw on, sized to them. World 2's buckets
    // were sized against a *category's* yield and are as much as ten times
    // what a node line draws; carrying them into world 3 would leave every
    // rival paying an idle-capacity charge on plant its own lines cannot use.
    capacity = { plantUsd, fleetUsd, gridUsd };
    // A line made in a plant is not made on accelerators. What the world-2 seed
    // left in the compute block is a fleet a plant line can never draw on, and
    // every quarter of it is energy and depreciation against nothing. The
    // training allocation stays: research is what a laboratory's compute is
    // for, and the research phase budgets it in dollars.
    if (compute !== undefined) nextCompute = { ...compute, trainingAllocation, ...rentedTrim, ownedAccelerators: 0 };
  }
  if (onCompute && compute !== undefined) {
    // Serving units are what makes product, so the fleet has to be big enough
    // that the serving half alone covers the run rate of every compute line.
    // World 2 sized a fleet against a *category's* serving yield and its
    // numbers are as much as a hundred times what a node line draws.
    const needed = Math.ceil(bucketUnits.compute / servingShare);
    nextCompute = { ...compute, trainingAllocation, ...rentedTrim, ownedAccelerators: needed };
    // Property, plant and equipment is what the lines run on: `needed`, never
    // whatever world 2 happened to hold.
    requiredPpeUsd += needed * Math.round(ECONOMIC_NODES_BY_ID[ACCELERATOR_NODE_ID]?.basePriceUsd ?? 0);
  }

  // Property, plant and equipment is EXACTLY the capacity the lines run on.
  // World 2 sized its buckets against a category's serving yield and left the
  // rest of a company's plant standing against a line that cannot draw on it;
  // carried into world 3 that becomes a permanent idle-capacity charge on
  // assets nothing can use, which is a statement about the promotion, not
  // about the company. Equity moves with it, so the opening sheet reconciles.
  const sheet = company.balanceSheet;
  const addedPpeUsd = sheet === undefined ? 0 : Math.round(requiredPpeUsd) - (sheet.assets.ppe ?? 0);
  const balanceSheet =
    addedPpeUsd === 0 || sheet === undefined
      ? sheet
      : { ...sheet, assets: { ...sheet.assets, ppe: Math.max(0, (sheet.assets.ppe ?? 0) + addedPpeUsd) }, equity: (sheet.equity ?? 0) + addedPpeUsd };

  // What this company has already collected from the lines it already runs,
  // pooled by each line's node's sector, in `SECTORS` order.
  const dataBySector = new Map<Sector, number>();
  for (const entry of built) {
    const pb = w3OpeningDataPb(entry.node, entry.capacityUnits, entry.product.segment);
    if (pb <= 0) continue;
    dataBySector.set(entry.node.sector, (dataBySector.get(entry.node.sector) ?? 0) + pb);
  }
  const dataAssets = SECTORS.filter((sector) => dataBySector.has(sector)).map((sector) => ({
    sector,
    petabytes: Math.round((dataBySector.get(sector) ?? 0) * 1000) / 1000,
  }));

  // The income statement says what the lines say. Revenue is units times price
  // and nothing else in world 3, so a run rate lifted to cover the wage bill has
  // to move the figure every budget in the world is struck against — marketing,
  // research and the market's own valuation all read `revenueQuarterly`, and
  // the spending policy reads the gross profit under it. Cost of goods moves
  // with it at the seed's own declared margin: the roll-up prices the first
  // resolved quarter, and until then the opening statement has to be internally
  // consistent rather than a margin the units no longer support.
  //
  // Restated whenever there is revenue at all, not only when the run rate
  // moved: `seedUnits` is `round(revenue x share / price)`, so the world-2
  // revenue figure and the units derived from it disagree by up to half a
  // unit's worth per line, and world 3's one identity is that revenue IS units
  // times price. A seed that states it to within a rounding error states it
  // falsely.
  let seedRevenueUsd = 0;
  let lineRevenueUsd = 0;
  for (const entry of built) {
    seedRevenueUsd += entry.seedUnits * entry.priceUsd;
    lineRevenueUsd += roundCents((entry.product.activeCustomers ?? 0) * entry.priceUsd);
  }
  const financials =
    company.financials === undefined || seedRevenueUsd <= 0
      ? company.financials
      : {
          ...company.financials,
          revenueQuarterly: roundCents(lineRevenueUsd),
          cogs: roundCents(company.financials.cogs * (lineRevenueUsd / seedRevenueUsd)),
        };

  return {
    ...company,
    products: built.map((entry) => entry.product),
    ...(financials === undefined ? {} : { financials }),
    ...(capacity === undefined ? {} : { capacity }),
    ...(nextCompute === undefined ? {} : { compute: nextCompute }),
    ...(balanceSheet === undefined ? {} : { balanceSheet }),
    ...(dataAssets.length > 0 ? { dataAssets } : {}),
  };
}

/**
 * Add opening capital to one company: cash on the sheet, equity behind it, and
 * the financials record that mirrors the cash balance kept in step.
 *
 * Nothing else moves, so the opening balance sheet reconciles exactly as it did
 * before and the double-entry gate reads the same residual of zero.
 */
function withOpeningCash(company: CompanyInput, addedUsd: number): CompanyInput {
  if (addedUsd <= 0) return company;
  const sheet = company.balanceSheet;
  if (sheet === undefined) return company;
  return {
    ...company,
    balanceSheet: { ...sheet, assets: { ...sheet.assets, cash: (sheet.assets.cash ?? 0) + addedUsd }, equity: (sheet.equity ?? 0) + addedUsd },
    ...(company.financials === undefined ? {} : { financials: { ...company.financials, cash: (company.financials.cash ?? 0) + addedUsd } }),
  };
}

/* -------------------------------------------------------------------------- */
/*  Research on the one graph                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Where a seeded world-2 programme points once the map is the node table.
 *
 * A world-2 project aims at a `tech_` node that does not exist in world 3, so
 * every one of them is re-aimed at a real node in its own company's sector:
 * researchable, not already owned, and whose `requires` the company already
 * holds — so no programme opens already blocked, which is the state world 2
 * left a dozen of them in. Nothing here is hand-written per company: the
 * candidate is the first in the node table's own order, which is what makes it
 * identical on every machine.
 *
 * A company with nothing left to research in its own sector keeps no programme
 * at all. That is honest: an incumbent that already owns its whole chain is not
 * researching it again.
 */
export function w3ResearchTargets(
  companies: readonly CompanyInput[],
  ownership: Readonly<Record<string, readonly string[]>>,
  projects: readonly { readonly id: string; readonly companyId: string }[],
): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  const takenByCompany = new Map<string, Set<string>>();
  for (const project of projects) {
    const company = companies.find((candidate) => candidate.id === project.companyId);
    if (company === undefined) continue;
    const owned = new Set(ownership[project.companyId] ?? []);
    const taken = takenByCompany.get(project.companyId) ?? new Set<string>();
    const target = ECONOMIC_NODES.find(
      (entry) =>
        entry.researchable &&
        entry.sector === company.sector &&
        !owned.has(entry.id) &&
        !taken.has(entry.id) &&
        entry.requires.every((required) => owned.has(required)),
    );
    if (target === undefined) continue;
    taken.add(target.id);
    takenByCompany.set(project.companyId, taken);
    out[project.id] = target.id;
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/*  Opening data                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Quarters of collection a seeded company opens with in the bank.
 *
 * Four: a year of what its own line already generates. Without it a company
 * whose line IS a dataset could sell nothing at all on turn one — the pool is
 * the capacity for a `dat_` line — and every model maker in the world would
 * lose its corpus supplier in the first quarter.
 *
 * The seed deliberately ignores the privacy drag: this stock was collected
 * under whatever regime held before the game opened, and the current one
 * governs what is collected from here on.
 */
export const W3_DATA_SEED_QUARTERS = 4;

/** The petabytes a line opens holding in its node's sector, given the customer type it is aimed at. */
export function w3OpeningDataPb(node: EconomicNode, units: number, segment: ProductSegment = primaryCustomerOf(node)): number {
  if (units <= 0) return 0;
  const perUnit = petabytesPerUnit(node.id);
  // A dataset line sells out of a pool, so it must open with one big enough to
  // sell what its run rate says it sells.
  if (perUnit > 0) return units * perUnit * W3_DATA_SEED_QUARTERS;
  if (node.dataYieldPerUnitQuarter <= 0) return 0;
  return node.dataYieldPerUnitQuarter * units * SEGMENT_DATA_WEIGHT[segment] * W3_DATA_SEED_QUARTERS;
}

/**
 * What the measuring passes have read off the world so far, each keyed as the
 * builder writes it. Every field is optional: the first build has none of them
 * and exists only to be measured.
 */
export interface W3Measured {
  /** Each line's ask, by product id. */
  readonly asks?: Readonly<Record<string, number>>;
  /** Each line's opening run rate, by product id. */
  readonly runRates?: Readonly<Record<string, number>>;
  /** Capital raised before the game opened, by company id. */
  readonly cashTopUps?: Readonly<Record<string, number>>;
  /** Each industry's size at seed. */
  readonly industryBaselineUsd?: Readonly<Record<Sector, number>>;
  /** Each node's opening price index. */
  readonly nodePrices?: Readonly<Record<string, number>>;
  /** Each sector's opening goods price index. */
  readonly sectorPrices?: Readonly<Record<string, number>>;
  /** Each line's opening quality, by product id. */
  readonly qualities?: Readonly<Record<string, number>>;
}

/** The two price maps the world opens at, measured together because a roll-up reads both. */
export interface W3OpeningPrices {
  readonly nodePrices: Readonly<Record<string, number>>;
  readonly sectorPrices: Readonly<Record<string, number>>;
}

/**
 * The unparsed, fully measured input — the same world `createWorld3Session`
 * parses — so the demo dispatcher and any fixture that varies one field before
 * parsing start from the world the picker describes rather than from the
 * unmeasured first build.
 */
export function world3SessionInput(seed: number = W3_SEED, setupInput?: NewGameSetup): SessionStateInput {
  return w3MeasuredInput(seed, setupInput ?? W3_DEFAULT_SETUP);
}

/** One build of the world, carrying whatever the passes so far have measured. */
function w3RawInput(seed: number, setup: NewGameSetup, measured: W3Measured): SessionStateInput {
  const { asks, runRates, cashTopUps, industryBaselineUsd, nodePrices, sectorPrices, qualities } = measured;
  const base = world2SessionInput(seed, setup);
  const ownership = w3NodeOwnership(w3OwnershipSubjects(setup));
  const lines = w3SeedLinesFor(setup);

  const sessionId = base.sessionId.replace('world2', 'world3');
  // Research aims at the ONE graph in world 3, so the Frontier Map is the node
  // table projected into the shape the research subsystem already speaks —
  // never a second catalogue that can drift from the first.
  const targets = w3ResearchTargets(base.companies ?? [], ownership, base.researchProjects ?? []);

  return {
    ...base,
    sessionId,
    config: { ...base.config, worldVersion: WORLD_3_VERSION, scenarioId: 'frontier_node_economy_2027' },
    techGraph: nodeTechGraph(sessionId, 0),
    // A world-2 programme aimed at a `tech_` node has nothing to aim at here,
    // so it is re-aimed at a real node its company can actually start, and
    // dropped when there is none. A dangling target would be a programme that
    // can never finish and never stop, which is the shape world 3 exists to
    // delete.
    researchProjects: (base.researchProjects ?? [])
      .filter((project) => targets[project.id] !== undefined)
      .map((project) => ({ ...project, targetNodeId: targets[project.id] ?? project.targetNodeId })),
    // `companies` is optional on the input type; world 2 always supplies it,
    // and an empty list is the only honest reading if it ever did not.
    companies: (base.companies ?? []).map((company) => {
      const nodes = ownership[company.id];
      const owned = nodes === undefined ? company : { ...company, ownedNodes: [...nodes] };
      const priced = asNodeCompany(owned, lines[company.id] ?? [], asks ?? {}, runRates ?? {}, qualities ?? {});
      // Capital the founders raised before the game opened, so a company whose
      // lines cannot pay for its people still has a bank that can. See
      // `w3RunwayTopUps`. Cash and equity move together; nothing else does.
      return withOpeningCash(priced, cashTopUps?.[company.id] ?? 0);
    }),
    // Each industry's size at seed, the denominator of the size factor in every
    // business cell. Written once, here, and never recomputed.
    ...(industryBaselineUsd === undefined ? {} : { industryBaselineUsd: { ...industryBaselineUsd } }),
    // Where each node's price opens: the index its own opening balance settles
    // to, so the first quarter does not ramp every produced input up to a level
    // the seed already implied. Absent on the unmeasured build, which reads
    // neutral exactly as a world-2 save does.
    ...(nodePrices === undefined ? {} : { nodePrices: { ...nodePrices } }),
    // The sector goods index restates its own balance every quarter with no
    // inertia, so it opens at exactly that restatement: every seller's price
    // factor and every company's energy cost read it, and an unstated 100 was
    // a first-quarter jump in both for the whole world.
    ...(sectorPrices === undefined ? {} : { sectorPrices: { ...sectorPrices } }),
  };
}

/**
 * The revenue each seeded line declares, keyed by product id: the world-2
 * seed's revenue split by the line table's shares, before any build has
 * rounded it into units at a price. What the run-rate pass is struck on, so a
 * half-unit rounding at a five-million-dollar licence is never lifted twelve
 * times over into a fifth of a company's revenue.
 */
export function w3SeedLineRevenueUsd(seed: number, setup: NewGameSetup): Readonly<Record<string, number>> {
  const lines = w3SeedLinesFor(setup);
  const out: Record<string, number> = {};
  for (const company of world2SessionInput(seed, setup).companies ?? []) {
    const slug = w3SlugOf(company.id);
    const revenue = Math.max(0, company.financials?.revenueQuarterly ?? 0);
    (lines[company.id] ?? []).forEach((line, index) => {
      out[w3SeedProductId(slug, index)] = revenue * line.revenueShare;
    });
  }
  return out;
}

/**
 * Bounds on the gross margin a seeded line opens on.
 *
 * The target itself is the company's *own* declared margin, carried over from
 * the world-2 seed: a company that has survived to 2027 sells above what it
 * costs it to build, and every one of these companies has a payroll, a research
 * programme and a marketing budget already sized against the margin its seed
 * declares. Pricing every line at the node table's base price instead would
 * hand a consumer-goods company a thirteen percent margin against a
 * twenty-five-percent-of-revenue marketing budget, and it would be insolvent
 * before a player had taken a single decision.
 *
 * The node's own base price is still the floor for everyone: a seed may charge
 * a premium for a line that is dear to make, never a discount for one that is
 * cheap. A line nobody is directing is floored at its node's market price at
 * seed as well — its base moved by the index the seed opens it at — because
 * that is where the NPC price-tracking rule walks it anyway, and a seeded ask
 * should not spend its first year arriving. See `w3LineAsks`.
 */
export const W3_SEED_MARGIN_BOUNDS = { min: 0.2, max: 0.75 } as const;

/** A copy of `state` opened at `prices`, or `state` itself when nothing has been measured yet. */
function atPrices(state: SessionState, prices: W3OpeningPrices | undefined): SessionState {
  if (prices === undefined) return state;
  return { ...state, nodePrices: { ...prices.nodePrices }, sectorPrices: { ...prices.sectorPrices } };
}

/**
 * A working copy of a state whose lines are asked at `asks`, terms included,
 * and whose nodes and sectors are priced at `prices` when given, so a roll-up
 * reads what sellers will really charge at the prices the world will really
 * open at.
 */
function withAsksApplied(state: SessionState, asks: Readonly<Record<string, number>>, prices?: W3OpeningPrices): SessionState {
  const working = SessionStateSchema.parse(atPrices(state, prices));
  for (const company of working.companies) {
    for (const product of company.products) {
      const ask = asks[product.id];
      if (ask === undefined) continue;
      product.pricePerSeat = ask;
      if (product.supplyTerms !== undefined && product.supplyTerms !== null) product.supplyTerms = { ...product.supplyTerms, pricePerUnitUsd: ask };
    }
  }
  return working;
}

/**
 * What each company asks for each of its lines, keyed by product id, given
 * what that line costs it.
 *
 * Read off the roll-up at the opening prices — the state's own indices, or
 * `prices` when the caller has measured where they settle — so this is a pure
 * function of the node table, the line table, the companies and those indices.
 * Never below the node's market price at those indices, and never below its
 * base price: a seed may charge a premium for a dear line, never a discount
 * for a cheap one.
 *
 * **Sellers are priced before buyers.** Every slot admits only nodes of a
 * strictly lower tier than the node that carries it, so walking the lines in
 * ascending tier order means that by the time a line is costed every published
 * line it buys from already carries its own ask, and the buyer's margin is
 * struck on what its supplier will really charge rather than on the table's
 * base price. The walk writes each ask into a working copy's terms as it goes;
 * the caller's state is never touched. Ties in tier keep company order then
 * product order, so the result is identical on every machine.
 */
export function w3LineAsks(state: SessionState, prices?: W3OpeningPrices): Readonly<Record<string, number>> {
  const working = SessionStateSchema.parse(atPrices(state, prices));
  const cache = createNodeCostCache(working);
  const refs: { readonly company: SessionState['companies'][number]; readonly product: SessionState['companies'][number]['products'][number]; readonly node: EconomicNode }[] = [];
  for (const company of working.companies) {
    for (const product of company.products) {
      const nodeId = product.nodeId;
      if (nodeId === undefined || nodeId === null) continue;
      const node = ECONOMIC_NODES_BY_ID[nodeId];
      if (node === undefined) continue;
      refs.push({ company, product, node });
    }
  }
  refs.sort((a, b) => a.node.tier - b.node.tier);

  const out: Record<string, number> = {};
  for (const ref of refs) {
    const unitCostUsd = unitCostOf(working, ref.company, ref.node.id, cache).unitCostUsd;
    const margin = Math.min(W3_SEED_MARGIN_BOUNDS.max, Math.max(W3_SEED_MARGIN_BOUNDS.min, ref.product.grossMarginPct));
    // The market floor is the tracking rule's, and applies exactly where that
    // rule does: a line nobody is directing is walked to its node's price a
    // third of the gap a quarter, so it opens there rather than spending its
    // first year arriving. A founder's line is never tracked — it stays where
    // the founder put it — so it opens on the margin its own plan supports and
    // is not handed the node's shortage premium as a gift it never chose. The
    // market price is read through the engine's one reader and is whole
    // dollars; the base price keeps the cents on a line that sells for about
    // a dollar, which is why both floors stand.
    const tracked = ref.company.controllerPlayerId === null;
    const marketFloorUsd = tracked ? roundCents(nodeMarketPriceUsd(working, ref.node.id)) : 0;
    const floorUsd = Math.max(roundCents(ref.node.basePriceUsd), marketFloorUsd);
    const ask = Math.max(floorUsd, roundCents(unitCostUsd / (1 - margin)));
    out[ref.product.id] = ask;
    ref.product.pricePerSeat = ask;
    if (ref.product.supplyTerms !== undefined && ref.product.supplyTerms !== null) ref.product.supplyTerms = { ...ref.product.supplyTerms, pricePerUnitUsd: ask };
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/*  Opening run rate                                                           */
/* -------------------------------------------------------------------------- */

/**
 * How much of the wage bill the opening lines have to cover.
 *
 * Exactly one: a company that has survived to 2027 sells enough of its lines to
 * pay the people who make them, and not a dollar more. Below one it is dying on
 * turn one for a reason no player could see or fix; well above one every
 * background would open rich, which is a different game.
 */
export const W3_OPENING_WAGE_COVER = 1;

/**
 * The most the opening run rate may be lifted over the seed's own.
 *
 * A line whose contribution per unit is nearly nothing — a thin-margin freight
 * network, a commodity material — would otherwise ask for a run rate in the
 * millions to cover one wage bill, which is not a correction, it is a different
 * company. Past this the seed stands as it is and the background is simply a
 * hard one.
 */
export const W3_OPENING_SCALE_CEILING = 12;

/**
 * The run rate each seeded line opens at, keyed by product id: enough units
 * that the margin on the company's lines together covers the wage bill the
 * talent market will actually charge.
 *
 * This is the completion of the rule `w3LineAsks` starts. That function reads a
 * price off the roll-up so a seed never sells under cost; this one reads a
 * QUANTITY off the same roll-up so a seed is never too small to pay for itself.
 * Without it the world-2 revenue figures carried straight across, and a
 * background with eight people and $1.3M of annual revenue was insolvent in
 * four quarters with no player input — because compensation drifts toward a
 * market that prices those eight people at $6.5M a year, and no decision the
 * player could take in four quarters closes a gap that size.
 *
 * A company's lines are lifted together, by one factor, so their revenue split
 * stays what the seed declared. Three things bound it, so it corrects rather
 * than rewrites:
 *
 * - it never lowers a run rate, only raises one (`max` against the seed);
 * - it never applies to a pre-revenue background, which is pre-revenue on
 *   purpose and lives on its bank — `w3RunwayTopUps` is what makes sure that
 *   bank is actually big enough, and is the other half of this rule;
 * - it never lifts a line by more than `W3_OPENING_SCALE_CEILING`.
 *
 * The wage bill is the market's, not the seed's: `resolveHiring` drifts every
 * company's compensation eighteen percent of the way to the market rate every
 * quarter, so the seed's own payroll is a number that stops being true within a
 * year. The costs are the priced ones — every supplier already asking what
 * `w3LineAsks` found — so the contribution is what the line will really earn.
 *
 * The units are the revenue the seed declares divided by the ask, unrounded
 * until the lift has been applied (`lineRevenueUsd`; a state's own units times
 * its price when the caller has not measured it). Rounding before lifting was
 * a real defect: a licence line worth two and a half units at its ask rounded
 * to three and was lifted twelve times over, and a company that declared two
 * equal lines opened selling 57% of its revenue on one of them.
 *
 * Deterministic: a pure function of the node table, the seeds and the talent
 * market. No RNG, no clock.
 */
export function w3LineRunRates(
  state: SessionState,
  asks: Readonly<Record<string, number>>,
  prices?: W3OpeningPrices,
  lineRevenueUsd?: Readonly<Record<string, number>>,
): Readonly<Record<string, number>> {
  const working = withAsksApplied(state, asks, prices);
  const cache = createNodeCostCache(working);
  const out: Record<string, number> = {};
  state.companies.forEach((company, companyIndex) => {
    const priced = working.companies[companyIndex];
    if (priced === undefined) return;
    const entries: { readonly productId: string; readonly units: number }[] = [];
    let contributionUsd = 0;
    for (const product of company.products) {
      const nodeId = product.nodeId;
      if (nodeId === undefined || nodeId === null || ECONOMIC_NODES_BY_ID[nodeId] === undefined) continue;
      const unpricedUnits = Math.max(0, product.unitsSoldQuarterly ?? product.activeCustomers);
      if (unpricedUnits <= 0 || !(product.pricePerSeat > 0)) continue;
      const priceUsd = asks[product.id] ?? product.pricePerSeat;
      // The units the seed's declared revenue buys AT THE ASK, not at the base
      // price the unpriced world counted them at: a line whose ask is twice its
      // base sells half as many units for the same revenue, and lifting the
      // base-price count would book it twice what the seed declared.
      const revenueUsd = lineRevenueUsd?.[product.id] ?? unpricedUnits * product.pricePerSeat;
      const seedUnits = revenueUsd / priceUsd;
      if (!(seedUnits > 0)) continue;
      const unitCostUsd = unitCostOf(working, priced, nodeId, cache).unitCostUsd;
      // What one unit leaves behind once the goods and the archetype's marketing
      // and research have been paid for. The same share `policy.ts` bounds
      // discretionary spend by, so the seed and the spending policy agree.
      contributionUsd += seedUnits * (priceUsd - unitCostUsd) * (1 - NODE_DISCRETIONARY_GROSS_PROFIT_SHARE);
      entries.push({ productId: product.id, units: seedUnits });
    }
    if (entries.length === 0 || !(contributionUsd > 0)) return;

    let wageBillUsd = 0;
    for (const role of W3_STAFF_ROLES) wageBillUsd += company.employees[role] * regionalCompUsd(state, company, role);
    wageBillUsd /= QUARTERS_PER_YEAR;
    if (!(wageBillUsd > 0)) return;

    const scale = (wageBillUsd * W3_OPENING_WAGE_COVER) / contributionUsd;
    if (scale <= 1) return;
    const bounded = Math.min(scale, W3_OPENING_SCALE_CEILING);
    for (const entry of entries) out[entry.productId] = Math.ceil(entry.units * bounded);
  });
  return out;
}

/* -------------------------------------------------------------------------- */
/*  Opening runway                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Quarters a seeded company that cannot pay for itself must be able to trade on
 * its bank alone.
 *
 * Twenty. The game is balanced over sixteen quarters — four years, the horizon
 * every autopilot claim in `world3Repair.test.ts` is made against — and a
 * company that reaches quarter sixteen with exactly nothing has not survived it,
 * it has arrived at the wire. A year of margin past the horizon is the smallest
 * number that makes "still trading at sixteen" a real claim rather than a
 * rounding one.
 */
export const W3_MIN_RUNWAY_QUARTERS = 20;

/**
 * What each seeded company's bank has to hold for it to still be trading in
 * four years, over and above what the seed already gave it.
 *
 * The rule this completes, stated whole:
 *
 * > **A seeded company opens either with lines that pay for its people or
 * > with a bank that will.** `w3LineRunRates` is the first half; this is the
 * > second.
 *
 * A background that is pre-revenue ON PURPOSE — a frontier laboratory, a
 * humanoid laboratory — has no line to size, so `w3LineRunRates` skips it by
 * construction and nothing else in the seed ever looked at whether its bank
 * could carry it. It could not: a robotics laboratory opened with twenty-four
 * people, a twenty-two-million-dollar bank and a pilot line selling fifteen
 * machines a quarter, which is nine quarters of runway against a game balanced
 * over sixteen, and it went into administration at quarter ten with no player
 * input and no decision available that would have changed it.
 *
 * The burn is the honest one: the wage bill the TALENT MARKET will charge —
 * `resolveHiring` drifts every company to it at eighteen percent a quarter, so
 * the seed's own payroll stops being true within a year — plus the service on
 * the debt the seed already carries, at the rate and the amortisation the
 * financial phase itself books, less what the lines contribute after the
 * archetype's own marketing and research have been paid for. The debt is not
 * optional: a grid developer seeded with twenty-five million of it pays more a
 * quarter in interest and principal than it pays its people, and a runway that
 * ignored it called a company solvent that was three years from empty. A
 * company whose lines already cover all of that has no deficit and is not
 * touched, which is every background that was never in trouble.
 *
 * The top-up lands on cash AND on equity, so the opening sheet still
 * reconciles: this is capital the founders raised before the game opened, not a
 * plug.
 *
 * Deterministic: a pure function of the node table, the seeds and the talent
 * market. No RNG, no clock.
 */
export function w3RunwayTopUps(state: SessionState): Readonly<Record<string, number>> {
  const cache = createNodeCostCache(state);
  const out: Record<string, number> = {};
  for (const company of state.companies) {
    let wageBillUsd = 0;
    for (const role of W3_STAFF_ROLES) wageBillUsd += company.employees[role] * regionalCompUsd(state, company, role);
    wageBillUsd /= QUARTERS_PER_YEAR;
    if (!(wageBillUsd > 0)) continue;

    let contributionUsd = 0;
    for (const product of company.products) {
      const nodeId = product.nodeId;
      if (!product.isActive || nodeId === undefined || nodeId === null) continue;
      // What the line will actually make, not what the seed's revenue figure
      // says it already sold. A pre-revenue background declares no units at all
      // and yet opens with a pilot line and the capacity to run it: reading the
      // seed's zero here would call a laboratory whose first quarter earns
      // thirty-nine million dollars a company with no income and hand it five
      // years of wages it does not need.
      const line = (cache.linesByCompany.get(company.id) ?? []).find((candidate) => candidate.productId === product.id);
      const capacityUnits = line === undefined ? 0 : producibleUnits(state, line, cache.linesByCompany);
      const units = Math.min(Math.max(0, product.unitsSoldQuarterly ?? product.activeCustomers) || capacityUnits, capacityUnits);
      if (!(units > 0)) continue;
      const unitCostUsd = unitCostOf(state, company, nodeId, cache).unitCostUsd;
      contributionUsd += units * (product.pricePerSeat - unitCostUsd) * (1 - NODE_DISCRETIONARY_GROSS_PROFIT_SHARE);
    }

    // Interest at the same rate `resolveFinancials` charges, plus the principal
    // it amortises: struck on the opening debt for the whole horizon, which
    // overstates a shrinking balance a little and is the conservative reading.
    const debtUsd = Math.max(0, company.balanceSheet.liabilities.debt);
    const debtRate = (state.world.macro.policyRate + state.world.macro.creditSpreads + DEBT_RISK_PREMIUM) / QUARTERS_PER_YEAR;
    const debtServiceUsd = debtUsd * (debtRate + DEBT_AMORTISATION_PER_QUARTER);

    const burnUsd = wageBillUsd + debtServiceUsd - contributionUsd;
    if (!(burnUsd > 0)) continue;
    const cashUsd = Math.max(0, company.balanceSheet.assets.cash);
    // What the opening sheet already owes, net of what it is owed. The seed
    // carries world 2's payables and receivables, and the first quarter settles
    // both out of the same bank the runway is measured against: a grid
    // developer opened owing five million against two receivable and was
    // seven quarters shorter than its top-up said before it had sold a thing.
    const owedUsd = Math.max(0, company.balanceSheet.liabilities.payables - company.balanceSheet.assets.receivables);
    const requiredUsd = burnUsd * W3_MIN_RUNWAY_QUARTERS + owedUsd;
    if (cashUsd >= requiredUsd) continue;
    out[company.id] = Math.round(requiredUsd - cashUsd);
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/*  Opening prices                                                             */
/* -------------------------------------------------------------------------- */

/**
 * The most quarters of the market phase's own inertia `w3NodePrices` follows
 * an index towards its target before calling it settled. The rule closes
 * 35% of the gap a quarter and stops moving once the gap is under a point
 * and a half, which from any start inside the bounds takes under twenty
 * steps; the cap is a guard, not a tuning.
 */
const W3_PRICE_SETTLE_STEPS = 64;

/**
 * Where every node's price index opens: the index the market phase would
 * settle on given the seed's own supply and demand, computed with the
 * phase's own rules and nothing else.
 *
 * Without this every node opened at 100 and the first six quarters were a
 * ramp: a node one seeded rival produces is judged against the whole world's
 * demand for it and is short by construction, so sensors, packs, interconnects
 * and models all climbed to the top of the swing while every buyer's price
 * stood still — a founder whose costs rose a fifth in the first quarter had
 * been handed a world that was already implying it. The imbalance is a pure
 * function of the seeded quantities, so the index it settles to is knowable
 * before the first quarter, and a seed that knows it and opens elsewhere is
 * stating a price it does not believe.
 *
 * Read off `nodeBalances` on the priced world, then followed with
 * `nextNodePriceIndex` from the baseline until it stops moving, so the seed
 * lands exactly on the phase's own fixed point and the first resolution
 * leaves it there. A node nobody produces is imported at balance and opens at
 * its world shifter's index alone — 100 for the many nodes without one,
 * exactly as before.
 */
export function w3NodePrices(state: SessionState): Readonly<Record<string, number>> {
  const balances = nodeBalances(state);
  const out: Record<string, number> = {};
  for (const node of ECONOMIC_NODES) {
    const balance = balances[node.id];
    if (balance === undefined) continue;
    const target = nodeTargetIndex(balance.imbalance, balance.worldShifter);
    let index = NODE_PRICE_BASELINE;
    for (let step = 0; step < W3_PRICE_SETTLE_STEPS; step += 1) {
      const next = nextNodePriceIndex(index, target);
      if (next === index) break;
      index = next;
    }
    out[node.id] = index;
  }
  return out;
}

/**
 * Where every sector's goods price index opens: what the economy phase would
 * write for the seed's own revenue by sector, read with the phase's own
 * function. The sector index carries no inertia — `priceSectors` restates the
 * balance every quarter — so there is nothing to settle; an absent map read as
 * 100 and was rewritten on quarter zero, which for the energy sector was a
 * two-thirds jump in every seller's regional energy factor and every
 * company's power bill on the first End Quarter.
 */
export function w3SectorPrices(state: SessionState): Readonly<Record<string, number>> {
  const balances = sectorBalances(state);
  const out: Record<string, number> = {};
  for (const sector of SECTORS) out[sector] = balances[sector].priceIndex;
  return out;
}

/** Both opening price maps, read off one priced world. */
export function w3OpeningPrices(state: SessionState): W3OpeningPrices {
  return { nodePrices: w3NodePrices(state), sectorPrices: w3SectorPrices(state) };
}

/** True when two index maps name the same keys at the same whole-number indices. */
function sameIndices(a: Readonly<Record<string, number>>, b: Readonly<Record<string, number>>): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) => a[key] === b[key]);
}

/** True when two opening price readings agree on every node and every sector. */
function samePrices(a: W3OpeningPrices, b: W3OpeningPrices): boolean {
  return sameIndices(a.nodePrices, b.nodePrices) && sameIndices(a.sectorPrices, b.sectorPrices);
}

/**
 * How many times the asks are re-struck at the prices the world they produce
 * settles to. Each round changes the quantities a little — a line asked
 * higher sells fewer units for the seed's revenue — and the quantities set the
 * balance, so the indices can move between rounds; almost every produced node
 * is short or long by more than two to one and sits at the end of the swing
 * from the first round, and the handful near balance settle on the second.
 * Three is a bound on a loop that stops the moment two rounds agree.
 */
export const W3_PRICING_ROUNDS = 3;

/* -------------------------------------------------------------------------- */
/*  Opening quality                                                            */
/* -------------------------------------------------------------------------- */

/**
 * What each line is worth to a buyer at quarter zero, keyed by product id: the
 * engine's own quality blend — craft through the tier lever, the data edge the
 * company's stock buys it, and what its suppliers ship weighted by value
 * share — read off the priced world with the engine's own function.
 *
 * The world-2 template carried one `qualityScore` per company and the first
 * resolution rewrote every one of them: a rival whose data stock saturated the
 * edge went from 0.90 to 1.00 on quarter zero, and a founder whose line was
 * composed on that rival's API watched their own quality jump a tenth the
 * moment the game began, for nothing they had done. The seed now states the
 * blend the engine will write.
 *
 * Suppliers before buyers, in ascending tier, writing each result into the
 * working copy as it goes, so a line composed on a rival's API is rated
 * against the API's seeded quality rather than the template's. The same walk
 * `w3LineAsks` takes, for the same reason.
 */
export function w3SeedQualities(state: SessionState): Readonly<Record<string, number>> {
  const working = SessionStateSchema.parse(state);
  const cache = createNodeCostCache(working);
  const refs: { readonly company: SessionState['companies'][number]; readonly product: SessionState['companies'][number]['products'][number]; readonly node: EconomicNode }[] = [];
  for (const company of working.companies) {
    for (const product of company.products) {
      const nodeId = product.nodeId;
      if (nodeId === undefined || nodeId === null) continue;
      const node = ECONOMIC_NODES_BY_ID[nodeId];
      if (node === undefined) continue;
      refs.push({ company, product, node });
    }
  }
  refs.sort((a, b) => a.node.tier - b.node.tier);

  const out: Record<string, number> = {};
  for (const ref of refs) {
    const cost = unitCostOf(working, ref.company, ref.node.id, cache);
    const quality = effectiveQuality(working, ref.company, ref.product, ref.node, cost, cache);
    out[ref.product.id] = quality;
    ref.product.qualityScore = quality;
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/*  The build                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The fully measured world-3 input.
 *
 * Built several times on purpose, each pass reading only what the one before
 * it revealed:
 *
 * 1. **Unpriced.** A line cannot be costed before it exists, so the first build
 *    exists only to be costed.
 * 2. **Priced and scaled.** Every line is asked at a price the roll-up supports
 *    — suppliers first, so a buyer's margin is struck on its supplier's real
 *    ask — and run at a rate that covers the wage bill the talent market will
 *    charge.
 * 3. **Settled.** The priced world's own supply and demand say where every
 *    node's price index will come to rest, so the asks and run rates are
 *    re-struck at those prices, and again until the indices the world produces
 *    are the indices it was priced at (`W3_PRICING_ROUNDS` bounds it).
 * 4. **Funded, rated and measured.** What the lines still cannot carry, the
 *    bank carries: the runway top-up is read off the settled world, because the
 *    deficit is not knowable until the price and the run rate are. The same
 *    world gives each line's opening quality and each industry's size at seed,
 *    neither of which a top-up moves: it adds cash and equity, never revenue.
 *
 * Every pass is a pure function of the seed and the tables, so the whole is as
 * deterministic as any one of them.
 */
function w3MeasuredInput(seed: number, setup: NewGameSetup): SessionStateInput {
  const build = (measured: W3Measured): SessionState => SessionStateSchema.parse(w3RawInput(seed, setup, measured));
  const lineRevenueUsd = w3SeedLineRevenueUsd(seed, setup);

  const unpriced = build({});
  let asks = w3LineAsks(unpriced);
  let runRates = w3LineRunRates(unpriced, asks, undefined, lineRevenueUsd);
  let priced = build({ asks, runRates });
  let prices = w3OpeningPrices(priced);

  for (let round = 0; round < W3_PRICING_ROUNDS; round += 1) {
    // Struck on the UNPRICED world every round, never on the previous round's
    // lifted run rates: the run-rate lift is a correction to the seed's own
    // figures, and compounding it round on round would turn a bounded
    // correction into an unbounded one.
    asks = w3LineAsks(unpriced, prices);
    runRates = w3LineRunRates(unpriced, asks, prices, lineRevenueUsd);
    priced = build({ asks, runRates, ...prices });
    const settled = w3OpeningPrices(priced);
    // Out of rounds, the world opens at the indices its asks were struck on:
    // an ask and the cost under it must never be priced at two different
    // indices, whatever the last round's balance said.
    if (samePrices(settled, prices) || round === W3_PRICING_ROUNDS - 1) break;
    prices = settled;
  }

  return w3RawInput(seed, setup, {
    asks,
    runRates,
    ...prices,
    qualities: w3SeedQualities(priced),
    cashTopUps: w3RunwayTopUps(priced),
    industryBaselineUsd: supplyBySector(priced),
  });
}

/** The world-3 session, parsed and ready for the resolver. See `w3MeasuredInput` for the passes. */
export function createWorld3Session(seed: number = W3_SEED, setup?: NewGameSetup): SessionState {
  return SessionStateSchema.parse(world3SessionInput(seed, setup));
}

/* -------------------------------------------------------------------------- */
/*  Readers                                                                    */
/* -------------------------------------------------------------------------- */

/** Every node in the table, for callers that would otherwise reach past the scenario. */
export const W3_NODES = ECONOMIC_NODES;

/** The node table indexed by id, re-exported so scenario code has one import. */
export const W3_NODES_BY_ID = ECONOMIC_NODES_BY_ID;

/** The composed lines of the seeded rivals, re-exported so the scenario has one door. */
export { W3_RIVAL_LINES, w3RivalLinesFor, w3SeedCompanyId, w3SeedProductId } from './lines';
export type { W3SeedFill, W3SeedLine } from './lines';

/* -------------------------------------------------------------------------- */
/*  The picker's numbers                                                       */
/* -------------------------------------------------------------------------- */

/**
 * What the New Game picker says a world-3 company opens with, checked against
 * what `createWorld3Session` above actually produces. Re-exported here so the
 * scenario has one door, exactly as the node table does.
 */
export {
  W3_BACKGROUND_OPENINGS,
  W3_NO_REVENUE_VALUE,
  w3CardMoney,
  w3CardPrice,
  w3OpeningFactsFor,
  world3Background,
  world3BackgroundHighlights,
  world3BackgroundsForSector,
} from './highlights';
export type { W3OpeningFacts } from './highlights';
