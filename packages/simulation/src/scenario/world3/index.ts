/**
 * @frontier/simulation — scenario/world3
 *
 * The world-version-3 opening state: the world-2 economy, re-founded on the one
 * node table.
 *
 * ## What this stage builds, and what it deliberately does not
 *
 * Stage 1 lays the ownership floor. The seeds, the player, the people, the
 * government and the market tape are world 2's — cloned by *derivation* rather
 * than by copy, so there is one place those numbers live and world 2 keeps
 * hashing to what it has always hashed to — and on top of them this module adds
 * the thing world 3 is actually about:
 *
 * - `config.worldVersion` is 3, so `isNodeEconomyWorld` is true and every
 *   world-3 branch the later stages add switches on here and nowhere else;
 * - every company carries `ownedNodes`, derived by the rule in
 *   `@frontier/contracts`'s `nodeOwnership.ts` — never a hand-written list;
 * - **every node in the table has at least one producer at seed**, which is the
 *   direct fix for world 2, where `manufacturing_accelerators` was a required
 *   input of three categories and was sold by nobody.
 *
 * Node prices, the cost roll-up, node markets and production are stage 3. Until
 * then a world-3 session resolves through exactly the world-2 engine, because
 * `isMultiSectorWorld` is true for version 3 as well — which is why
 * `isNodeEconomyWorld` had to be a second, separate gate rather than a reuse of
 * the first.
 *
 * ## Determinism
 *
 * Everything below is a pure function of the node table and the world-2 seeds.
 * No RNG, no clock, no module-level cache. The same seed and setup produce a
 * byte-identical opening state on any machine.
 */

import type { CompanyInput, NewGameSetup, SessionState, SessionStateInput, WorldVersion } from '@frontier/contracts';
import {
  ECONOMIC_NODES,
  ECONOMIC_NODES_BY_ID,
  NewGameSetupSchema,
  NODE_ECONOMY_WORLD_VERSION,
  SessionStateSchema,
  STARTING_MATURITIES,
  requiresClosure,
  rivalTierReach,
  startingLineNodeFor,
  startingNodesFor,
  startingNodesForRival,
  type BackgroundId,
  type EconomicNode,
  type Sector,
} from '@frontier/contracts';
import { V2_COMPANY_SEEDS, W2_COMPANIES } from '../world2';
import { effectivePolicy } from '../../companies/archetypes';
import { NODE_DISCRETIONARY_GROSS_PROFIT_SHARE } from '../../companies/policy';
import { regionalCompUsd } from '../../companies/hiring';
import { createNodeCostCache } from '../../graph/lines';
import { producibleUnits } from '../../graph/market';
import { unitCostOf } from '../../graph/cost';
import { SEGMENT_DATA_WEIGHT, petabytesPerUnit } from '../../graph/data';
import { nodeTechGraph } from '../../graph/techGraph';
import { world2SessionInput } from '../world2';

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
/*  Which node is a company's line                                             */
/* -------------------------------------------------------------------------- */

/**
 * The node a seeded rival opens selling: the highest-tier node in its own
 * sector that a company of that capability simply knows how to make.
 *
 * Chosen *before* ownership is assigned, so the test that every company can
 * produce its own line is a real check on the ownership rule rather than a
 * restatement of it. Ties break on the node table's own order, which is what
 * keeps this identical on every machine.
 */
export function w3LineNodeFor(sector: Sector, capabilityLevel: number): string {
  const reach = rivalTierReach(capabilityLevel);
  const eligible = ECONOMIC_NODES.filter(
    (entry) => entry.sector === sector && entry.tier <= reach && STARTING_MATURITIES.includes(entry.maturity),
  );
  let best: EconomicNode | null = null;
  for (const entry of eligible) if (best === null || entry.tier > best.tier) best = entry;
  // Every sector carries a commodity or established node at tier 2 or below,
  // so this fallback is unreachable and exists only to keep the function total.
  return best?.id ?? ECONOMIC_NODES[0]?.id ?? '';
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
 *    its signature nodes, every tier-0 commodity, and the `requires` closure of
 *    the line it opens selling.
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
        : startingNodesForRival(subject.sector, subject.capabilityLevel ?? 0, [w3LineNodeFor(subject.sector, subject.capabilityLevel ?? 0)]);
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
  return [
    ...V2_COMPANY_SEEDS.map((seed) => ({ companyId: seed.id, sector: seed.sector, capabilityLevel: seed.capabilityLevel, background: null })),
    { companyId: W2_COMPANIES.player, sector: setup.sector, capabilityLevel: null, background: setup.backgroundId },
  ];
}

/* -------------------------------------------------------------------------- */
/*  Assembly                                                                   */
/* -------------------------------------------------------------------------- */

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

/** What a supplier asks over the node's own base price when it opens its line to all. */
export const W3_SUPPLY_MARGIN = 1.1;

/**
 * How much of its cash a pre-revenue company has already put into the line it
 * opens on.
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
 * Turn one world-2 company into a world-3 one: it produces and sells a node.
 *
 * Everything is derived — the price is the node's own base price, the units are
 * the revenue the seed already declares divided by that price, and the capacity
 * is exactly what those units draw with headroom — so the opening world has no
 * hand-written numbers in it and a change to the node table moves the scenario
 * with it.
 *
 * The capacity is added to property, plant and equipment **and** to equity, so
 * the opening balance sheet still reconciles and the depreciation the financial
 * phase writes off is the depreciation the unit costs allocate.
 */
function asNodeCompany(company: CompanyInput, lineNodeId: string, askUsd?: number, runRateUnits?: number): CompanyInput {
  const node = ECONOMIC_NODES_BY_ID[lineNodeId];
  if (node === undefined) return company;
  // Cents, not whole dollars: a packaging material sells for about a dollar a
  // unit and rounding its ask to the nearest dollar would put it under its own
  // cost by twenty percent before the world had opened.
  const priceUsd = Math.max(0.01, roundCents(askUsd ?? node.basePriceUsd));
  const revenue = Math.max(0, company.financials?.revenueQuarterly ?? 0);
  const seedUnits = revenue > 0 ? Math.max(1, Math.round(revenue / priceUsd)) : 0;
  // The run rate the company has to be at to pay its own people; see
  // `w3LineRunRates`. Never below the seed's own, and only ever applied to a
  // company that already has revenue — a pre-revenue background opens
  // pre-revenue.
  const units = seedUnits > 0 && runRateUnits !== undefined ? Math.max(seedUnits, runRateUnits) : seedUnits;
  // A pre-revenue company sizes its pilot off its bank instead of off a run
  // rate it does not have yet.
  const cash = Math.max(0, company.balanceSheet?.assets.cash ?? 0);
  const capacityUnits = units > 0 ? units : Math.max(1, Math.round((cash * W3_PILOT_CASH_SHARE) / priceUsd));

  const products = (company.products ?? []).map((product, index) => {
    if (index > 0) return product;
    const tier = product.computeIntensity;
    const next: Record<string, unknown> = {
      ...product,
      nodeId: node.id,
      pricePerSeat: priceUsd,
      activeCustomers: units,
      unitsSoldQuarterly: units,
      installedBase: node.saleKind === 'unit' ? units * W3_INSTALLED_BASE_QUARTERS : 0,
      backlogUnits: 0,
      unitCostUsd: 0,
      contractBilledUsd: 0,
      craftQuality: product.qualityScore,
      qualityTier: tier,
      // World 3 keys a line on its node. The world-2 category and the world-2
      // supplier choices are dropped rather than reinterpreted: a category id
      // is not a node id, and leaving one behind would let a reader think the
      // line still has a category.
      supply: [],
    };
    delete next.categoryId;
    if (node.saleKind === 'contract') next.contractRemainingQuarters = 0;
    const terms = product.supplyTerms;
    if (terms !== undefined && terms !== null) {
      next.supplyTerms = { ...terms, pricePerUnitUsd: Math.round(priceUsd * W3_SUPPLY_MARGIN) };
    }
    return next as typeof product;
  });

  // What one quarter of this run rate draws on its own bucket, with headroom.
  const drawPerUnit = node.capacityDrawPerUnit * (0.5 + (products[0]?.qualityTier ?? 0.5));
  const requiredUnits = capacityUnits * drawPerUnit * W3_CAPACITY_HEADROOM;
  // A company opens pointing its capacity where its OWN archetype policy says
  // it should, rather than where the world-2 seed happened to leave it. The two
  // disagreed badly: an infrastructure company was seeded pointing seventy
  // percent of its fleet at training against an archetype policy of twelve, and
  // since the fleet has to be big enough that the SERVING share alone covers the
  // run rate, that one number sized its fleet at three and a third times what
  // its line draws — twenty-five thousand accelerators against a line needing
  // seven and a half thousand — and charged the difference to research every
  // quarter. It is also the number the NPC policy moves a company to on turn
  // one anyway, so seeding it is the seed agreeing with the engine rather than
  // being corrected by it.
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
  // rest to idle capacity. The trim used to apply only to a company with no
  // revenue, and that left two holes that between them account for most of what
  // a sixteen-quarter autopilot probe found:
  //
  // - **Rent nothing produces.** An enterprise software company opened paying a
  //   million dollars a quarter of world-2 cloud beside a line sized in owned
  //   accelerators, because `held` counted owned and reserved and never the
  //   cloud. Every quarter of that is an idle-capacity charge on capacity the
  //   line never asked for, and it is most of why that background bled to death
  //   at quarter eleven.
  // - **Capacity that is really unbounded.** The same untrimmed cloud spend is
  //   forty million subscriber-slots of serving capacity for a consumer line
  //   that opens serving three hundred and seventy-five thousand, so nothing
  //   rations its growth at all and it compounds eighty-fold in four years with
  //   no player input.
  // - **A cliff nobody can see.** Reserved capacity carries an expiry quarter
  //   from the world-2 seed. A frontier laboratory ran profitably on a hundred
  //   and seventy-two reserved accelerators for eleven quarters, the
  //   reservation lapsed, and its only line could produce nothing ever again.
  //
  // So the opening fleet is OWNED, and it is exactly what the line draws. That
  // is also the only reading consistent with the balance sheet below, which
  // books `needed` accelerators as property whether they were owned or rented.
  // Renting stays a lever the founder may pull; it is no longer a thing the
  // seed pulls for them.
  const rentedTrim = compute === undefined ? {} : { reservedAccelerators: 0, cloudSpendQuarterly: 0, reservationExpiryQuarter: null };
  let nextCompute = compute === undefined ? compute : { ...compute, trainingAllocation, ...rentedTrim };
  if (node.capacityKind === 'plant' || node.capacityKind === 'fleet' || node.capacityKind === 'grid') {
    const usd = Math.round(requiredUnits * 1_000_000);
    requiredPpeUsd += usd;
    // Exactly one bucket, sized to the line. World 2's buckets were sized
    // against a *category's* yield and are as much as ten times what a node
    // line draws; carrying them into world 3 would leave every rival paying an
    // idle-capacity charge on plant its own line cannot use.
    capacity = { plantUsd: 0, fleetUsd: 0, gridUsd: 0, [`${node.capacityKind}Usd`]: usd } as typeof capacity;
    // A line made in a plant is not made on accelerators. What the world-2 seed
    // left in the compute block is a fleet this company's line can never draw
    // on, and every quarter of it is energy and depreciation against nothing.
    // The training allocation stays: research is what a laboratory's compute is
    // for, and the research phase budgets it in dollars.
    nextCompute = compute === undefined ? compute : { ...compute, trainingAllocation, ...rentedTrim, ownedAccelerators: 0 };
  } else if (node.capacityKind === 'compute' && compute !== undefined) {
    // Serving units are what makes product, so the fleet has to be big enough
    // that the serving half alone covers the run rate. World 2 sized a fleet
    // against a *category's* serving yield and its numbers are as much as a
    // hundred times what a node line draws: carried across unchanged, an
    // infrastructure company opened holding four thousand accelerators against
    // a line that draws forty, which in world 3 is a billion dollars of
    // property depreciating at five percent a quarter and a training bill on
    // the idle half.
    const needed = Math.ceil(requiredUnits / servingShare);
    nextCompute = { ...compute, trainingAllocation, ...rentedTrim, ownedAccelerators: needed };
    // Property, plant and equipment is what the line runs on: `needed`, never
    // whatever world 2 happened to hold.
    requiredPpeUsd += needed * Math.round(ECONOMIC_NODES_BY_ID[ACCELERATOR_NODE_ID]?.basePriceUsd ?? 0);
  }

  // Property, plant and equipment is EXACTLY the capacity the line runs on.
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

  // What this company has already collected from the line it already runs.
  // Pooled by the node's sector, which for an opening line is the company's own.
  const openingDataPb = w3OpeningDataPb(node, capacityUnits);

  // The income statement says what the line says. Revenue is units times price
  // and nothing else in world 3, so a run rate lifted to cover the wage bill has
  // to move the figure every budget in the world is struck against — marketing,
  // research and the market's own valuation all read `revenueQuarterly`, and
  // the spending policy reads the gross profit under it. Cost of goods moves
  // with it at the seed's own declared margin: the roll-up prices the first
  // resolved quarter, and until then the opening statement has to be internally
  // consistent rather than a margin the units no longer support.
  //
  // Restated whenever there is a line at all, not only when the run rate moved.
  // `seedUnits` is `round(revenue / price)`, so the world-2 revenue figure and
  // the units derived from it disagree by up to half a unit's worth — four
  // thousand dollars on a contract manufacturer — and world 3's one identity is
  // that revenue IS units times price. A seed that states it to within a
  // rounding error states it falsely.
  const financials =
    company.financials === undefined || seedUnits <= 0
      ? company.financials
      : {
          ...company.financials,
          revenueQuarterly: roundCents(units * priceUsd),
          cogs: roundCents(company.financials.cogs * (units / seedUnits)),
        };

  return {
    ...company,
    products,
    ...(financials === undefined ? {} : { financials }),
    ...(capacity === undefined ? {} : { capacity }),
    ...(nextCompute === undefined ? {} : { compute: nextCompute }),
    ...(balanceSheet === undefined ? {} : { balanceSheet }),
    ...(openingDataPb > 0 ? { dataAssets: [{ sector: node.sector, petabytes: Math.round(openingDataPb * 1000) / 1000 }] } : {}),
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

/** The petabytes a company opens holding in its own sector, from the line it opens selling. */
export function w3OpeningDataPb(node: EconomicNode, units: number): number {
  if (units <= 0) return 0;
  const perUnit = petabytesPerUnit(node.id);
  // A dataset line sells out of a pool, so it must open with one big enough to
  // sell what its run rate says it sells.
  if (perUnit > 0) return units * perUnit * W3_DATA_SEED_QUARTERS;
  const segment = node.buyerSegment;
  if (segment === null || node.dataYieldPerUnitQuarter <= 0) return 0;
  return node.dataYieldPerUnitQuarter * units * SEGMENT_DATA_WEIGHT[segment] * W3_DATA_SEED_QUARTERS;
}

/** The node each company in the opening world produces and sells, keyed by company id. */
export function w3LineNodes(setup: NewGameSetup): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const seed of V2_COMPANY_SEEDS) out[seed.id] = w3LineNodeFor(seed.sector, seed.capabilityLevel);
  out[W2_COMPANIES.player] = startingLineNodeFor(setup.backgroundId);
  return out;
}

/** The unparsed input, for fixtures that want to vary one field before parsing. */
export function world3SessionInput(
  seed: number = W3_SEED,
  setupInput?: NewGameSetup,
  asks?: Readonly<Record<string, number>>,
  runRates?: Readonly<Record<string, number>>,
  cashTopUps?: Readonly<Record<string, number>>,
): SessionStateInput {
  const setup = setupInput ?? W3_DEFAULT_SETUP;
  const base = world2SessionInput(seed, setup);
  const ownership = w3NodeOwnership(w3OwnershipSubjects(setup));
  const lineNodes = w3LineNodes(setup);

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
      const lineNodeId = lineNodes[company.id];
      const priced = lineNodeId === undefined ? owned : asNodeCompany(owned, lineNodeId, asks?.[company.id], runRates?.[company.id]);
      // Capital the founders raised before the game opened, so a company whose
      // line cannot pay for its people still has a bank that can. See
      // `w3RunwayTopUps`. Cash and equity move together; nothing else does.
      return withOpeningCash(priced, cashTopUps?.[company.id] ?? 0);
    }),
  };
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
 * The node's own base price is still the floor: a seed may charge a premium for
 * a line that is dear to make, never a discount for one that is cheap.
 */
export const W3_SEED_MARGIN_BOUNDS = { min: 0.2, max: 0.75 } as const;

/**
 * What each company asks for its line, given what that line costs it.
 *
 * Read off the roll-up at the opening prices — every node's index is 100 before
 * a quarter has resolved, so this is a pure function of the node table and the
 * companies — and never below the node's own base price: a seed may charge a
 * premium for a dear line, never a discount for a cheap one.
 */
export function w3LineAsks(state: SessionState): Readonly<Record<string, number>> {
  const cache = createNodeCostCache(state);
  const out: Record<string, number> = {};
  for (const company of state.companies) {
    const product = company.products[0];
    const nodeId = product?.nodeId;
    if (product === undefined || nodeId === undefined || nodeId === null) continue;
    const node = ECONOMIC_NODES_BY_ID[nodeId];
    if (node === undefined) continue;
    const unitCostUsd = unitCostOf(state, company, nodeId, cache).unitCostUsd;
    const margin = Math.min(W3_SEED_MARGIN_BOUNDS.max, Math.max(W3_SEED_MARGIN_BOUNDS.min, product.grossMarginPct));
    out[company.id] = Math.max(roundCents(node.basePriceUsd), roundCents(unitCostUsd / (1 - margin)));
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/*  Opening run rate                                                           */
/* -------------------------------------------------------------------------- */

/**
 * How much of the wage bill the opening line has to cover.
 *
 * Exactly one: a company that has survived to 2027 sells enough of its line to
 * pay the people who make it, and not a dollar more. Below one it is dying on
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
 * The run rate each seeded company opens at: enough units that the margin on
 * them covers the wage bill the talent market will actually charge.
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
 * Three things bound it, so it corrects rather than rewrites:
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
 * year. Sizing against where it is going is the only sizing that holds.
 *
 * Deterministic: a pure function of the node table, the seeds and the talent
 * market. No RNG, no clock.
 */
export function w3LineRunRates(state: SessionState, asks: Readonly<Record<string, number>>): Readonly<Record<string, number>> {
  const cache = createNodeCostCache(state);
  const out: Record<string, number> = {};
  for (const company of state.companies) {
    const product = company.products[0];
    const nodeId = product?.nodeId;
    if (product === undefined || nodeId === undefined || nodeId === null) continue;
    const seedUnits = Math.max(0, product.unitsSoldQuarterly ?? product.activeCustomers);
    if (seedUnits <= 0) continue;

    const priceUsd = asks[company.id] ?? product.pricePerSeat;
    const unitCostUsd = unitCostOf(state, company, nodeId, cache).unitCostUsd;
    // What one unit leaves behind once the goods and the archetype's marketing
    // and research have been paid for. The same share `policy.ts` bounds
    // discretionary spend by, so the seed and the spending policy agree.
    const contributionUsd = (priceUsd - unitCostUsd) * (1 - NODE_DISCRETIONARY_GROSS_PROFIT_SHARE);
    if (!(contributionUsd > 0)) continue;

    let wageBillUsd = 0;
    for (const role of W3_STAFF_ROLES) wageBillUsd += company.employees[role] * regionalCompUsd(state, company, role);
    wageBillUsd /= QUARTERS_PER_YEAR;
    if (!(wageBillUsd > 0)) continue;

    const needed = Math.ceil((wageBillUsd * W3_OPENING_WAGE_COVER) / contributionUsd);
    out[company.id] = Math.min(needed, seedUnits * W3_OPENING_SCALE_CEILING);
  }
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
 * > **A seeded company opens either with a line that pays for its people or
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
 * the seed's own payroll stops being true within a year — less what the line
 * contributes after the archetype's own marketing and research have been paid
 * for. A company whose line already covers that has no deficit and is not
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

    const burnUsd = wageBillUsd - contributionUsd;
    if (!(burnUsd > 0)) continue;
    const cashUsd = Math.max(0, company.balanceSheet.assets.cash);
    const requiredUsd = burnUsd * W3_MIN_RUNWAY_QUARTERS;
    if (cashUsd >= requiredUsd) continue;
    out[company.id] = Math.round(requiredUsd - cashUsd);
  }
  return out;
}

/**
 * The world-3 session, parsed and ready for the resolver.
 *
 * Built three times on purpose, each pass reading only what the one before it
 * revealed:
 *
 * 1. **Unpriced.** A line cannot be costed before it exists, so the first build
 *    exists only to be costed.
 * 2. **Priced and scaled.** Every line is asked at a price the roll-up supports
 *    and run at a rate that covers the wage bill the talent market will charge.
 * 3. **Funded.** What the line still cannot carry, the bank carries: the
 *    runway top-up is read off the priced world, because the deficit is not
 *    knowable until the price and the run rate are.
 *
 * All three are pure functions of the seed and the table, so the trio is as
 * deterministic as any one of them.
 */
export function createWorld3Session(seed: number = W3_SEED, setup?: NewGameSetup): SessionState {
  const unpriced = SessionStateSchema.parse(world3SessionInput(seed, setup));
  const asks = w3LineAsks(unpriced);
  const runRates = w3LineRunRates(unpriced, asks);
  const priced = SessionStateSchema.parse(world3SessionInput(seed, setup, asks, runRates));
  return SessionStateSchema.parse(world3SessionInput(seed, setup, asks, runRates, w3RunwayTopUps(priced)));
}

/* -------------------------------------------------------------------------- */
/*  Readers                                                                    */
/* -------------------------------------------------------------------------- */

/** Every node in the table, for callers that would otherwise reach past the scenario. */
export const W3_NODES = ECONOMIC_NODES;

/** The node table indexed by id, re-exported so scenario code has one import. */
export const W3_NODES_BY_ID = ECONOMIC_NODES_BY_ID;

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
