/**
 * @frontier/simulation — graph/data.ts
 *
 * Customer data as a real asset: where it comes from, what it decays to, and
 * the three things it moves.
 *
 * The owner asked for it directly — *"you should include the cost of each node
 * and total cost of product before pricing and also data collection from
 * customer which is crucial for product and product improvements"* — and this
 * is the second half of that sentence. The first half is `graph/cost.ts`.
 *
 * ## Where it comes from
 *
 * ```text
 * generated = node.dataYieldPerUnitQuarter
 *           x servedUnits
 *           x SEGMENT_DATA_WEIGHT[the line's own customer type]
 *           x COLLECTION_MULTIPLE[policy]
 *           x (1 - PRIVACY_DRAG x world.regulation.privacy x node.dataSensitivity)
 *
 * closing   = (opening + generated - consumed - sold) x (1 - DATA_DECAY)
 * ```
 *
 * Pooled **by sector**, because data is not fungible across industries: an AI
 * laboratory's chat logs improve its models and do nothing whatever for its
 * batteries.
 *
 * ## What it moves — three effects, each bounded and named
 *
 * 1. **Quality.** `dataEdge = pb / (pb + DATA_HALF_PB)`, and the uplift is
 *    `DATA_QUALITY_MAX x dataEdge`. This is also the fix for world 2's frozen
 *    quality, where `qualityScore` was set at launch and never revisited, so a
 *    breakthrough never improved anything a company already sold.
 * 2. **An input.** A node with a dataset slot is fed free from the
 *    company's own pool, and buys the shortfall at market. That is priced in
 *    `graph/cost.ts`, which reads `dataPetabytesOf` from here.
 * 3. **Research.** `dataAdequacy` is the fourth resourcing factor, so a
 *    programme can be short of data exactly as it can be short of compute.
 *
 * And one cost: a large stock under tight privacy regulation raises compliance
 * cost, which `companies/financials.ts` already charges on a company's own
 * regulatory exposure.
 *
 * ## Determinism
 *
 * Every function here is a pure function of the draft. No RNG, no clock. The
 * accrual pass walks companies in state order and each company's lines in
 * product order, so the ledger rows come out in one order on every machine.
 */

import type { Company, DataAsset, DataCollectionLevel, EconomicNode, NodeCostCache, Product, ProductSegment, ResolverContext, SessionState } from '@frontier/contracts';
import type { Sector } from '@frontier/contracts';
import { economicNodeById } from '@frontier/contracts';
import { activeCompanies, activeProducts, clamp, emitEvent, unit } from '../companies/util';
import { createNodeCostCache, lineNodeOf } from './lines';
import { resolveFills } from './slots';

/* -------------------------------------------------------------------------- */
/*  Constants, and why each is the number it is                                */
/* -------------------------------------------------------------------------- */

/**
 * How much of what a unit could yield each buyer segment actually lets you
 * keep.
 *
 * A consumer app sees everything its customers do. A developer paying for an
 * API sends you their prompts and not much else. An enterprise signs a data
 * processing agreement. A government customer contractually forbids it
 * outright — fifteen percent is the telemetry you are allowed to keep for
 * operating the system, and no more.
 */
export const SEGMENT_DATA_WEIGHT: Readonly<Record<ProductSegment, number>> = {
  consumer: 1,
  developer_api: 0.7,
  enterprise: 0.35,
  government: 0.15,
};

/**
 * What each collection policy multiplies the yield by.
 *
 * Aggressive is not a free lunch and minimal is not free either: the churn,
 * reputation and enforcement consequences are applied beside the yield, in
 * `resolveNodeData` and in the product pass.
 */
export const COLLECTION_MULTIPLE: Readonly<Record<DataCollectionLevel, number>> = {
  minimal: 0.4,
  standard: 1,
  aggressive: 1.7,
};

/**
 * How much of a maximally sensitive line's yield the tightest privacy
 * regulation takes away.
 *
 * Eight tenths, not all of it: at maximum regulation a maximally sensitive line
 * still yields a fifth, because operating a service lawfully always produces
 * some record of it. This is the FIRST economic number `world.regulation.privacy`
 * has ever moved — until now it was a dial that changed nothing.
 */
export const PRIVACY_DRAG = 0.8;

/**
 * How much of a stock is worth nothing by next quarter.
 *
 * Twelve percent a quarter halves a stock in about five and a half quarters:
 * stale behaviour is stale, and a company that stops serving customers stops
 * having an edge. An asset, not a ratchet.
 */
export const DATA_DECAY = 0.12;

/**
 * The stock at which a company has half the data edge it can ever have.
 *
 * One petabyte. A saturating curve rather than a linear one, so the first
 * terabyte matters far more than the ten thousandth and nobody can hoard their
 * way to a permanent advantage.
 *
 * Struck against what the lines in this world actually collect, which is the
 * whole of why it moved: at four hundred petabytes the half-point sat two to
 * four orders of magnitude above every seeded line in the game — a courier
 * holding a quarter of a petabyte, a consumer app reaching twelve after three
 * years — so the curve was flat at zero across the entire range the simulation
 * ever visits and the mechanism was wired end to end without moving a single
 * number. At one petabyte a consumer or logistics line is meaningfully ahead
 * inside a year, a large incumbent saturates, and a seat-based enterprise
 * product is not: which is the true thing to say about who owns customer data.
 */
export const DATA_HALF_PB = 1;

/**
 * The most quality data can ever buy.
 *
 * Fifteen points. At `DATA_HALF_PB` it is half of that — seven and a half — and
 * with `QUALITY_DEMAND_SENSITIVITY` at 0.9 that is about thirteen percent more
 * gross additions: meaningful, never decisive.
 */
export const DATA_QUALITY_MAX = 0.15;

/** The floor of the research data adequacy factor, matching compute's and talent's. */
export const DATA_FLOOR = 0.6;

/** Petabytes past which a data stock is worth a line in the quarter report. */
export const DATA_REPORT_PB = 1;

/**
 * How many petabytes one saleable unit of each dataset node stands for.
 *
 * The node table prices datasets in the unit its buyers actually buy — a
 * terabyte of curated corpus, ten thousand graded comparisons, a petabyte of
 * telemetry — while a company's own stock is kept in petabytes, one number a
 * player can compare across sectors. This is the conversion between them, and
 * it is stated once here rather than assumed anywhere.
 *
 * `dat_preference_data` is the only judgement call: ten thousand expert-graded
 * comparisons, with the artefacts they were graded against, is about two
 * hundred gigabytes.
 */
export const DATA_PB_PER_UNIT: Readonly<Record<string, number>> = {
  dat_web_corpus: 0.001,
  dat_preference_data: 0.0002,
  dat_robot_telemetry: 1,
  dat_consumer_behaviour: 1,
};

/**
 * The conversion for a dataset node the table has grown since. A terabyte: the
 * smallest unit anybody sells data in, so an unknown node is never allowed to
 * drain a stock faster than a known one.
 */
export const DEFAULT_DATA_PB_PER_UNIT = 0.001;

/** True when this node is a dataset — a thing whose units come out of a data pool. */
export function isDataNode(nodeId: string): boolean {
  return nodeId.startsWith('dat_');
}

/** Petabytes one unit of this node is, for a dataset node. Zero for anything else. */
export function petabytesPerUnit(nodeId: string): number {
  if (!isDataNode(nodeId)) return 0;
  return DATA_PB_PER_UNIT[nodeId] ?? DEFAULT_DATA_PB_PER_UNIT;
}

/**
 * What aggressive and minimal collection do to a consumer line's churn, and to
 * public standing, every quarter they are in force.
 *
 * Consumer lines only: an enterprise buyer's contract already says what may be
 * collected, so the surprise — and the churn — is the consumer's.
 */
export const DATA_POLICY_CHURN: Readonly<Record<DataCollectionLevel, number>> = {
  minimal: -0.015,
  standard: 0,
  aggressive: 0.02,
};

/** Points of public reputation each collection policy costs or earns per quarter. */
export const DATA_POLICY_REPUTATION: Readonly<Record<DataCollectionLevel, number>> = {
  minimal: 2,
  standard: 0,
  aggressive: -4,
};

/** How much aggressive collection raises the world's privacy-enforcement hazard, per company doing it. */
export const AGGRESSIVE_PRIVACY_EXPOSURE = 0.08;

/** Quarters that raised hazard takes to decay away. One year: a regulator has a memory. */
export const AGGRESSIVE_PRIVACY_DECAY_QUARTERS = 4;

/** The event family aggressive collection makes likelier. Raised only if the scenario authored it. */
export const PRIVACY_HAZARD_FAMILY_ID = 'fam_ip_data_ruling';

/* -------------------------------------------------------------------------- */
/*  Reading a company's stock                                                  */
/* -------------------------------------------------------------------------- */

/** The collection policy in force. Absent means standard, which is where everybody starts. */
export function dataPolicyOf(company: Company): DataCollectionLevel {
  return company.dataPolicy ?? 'standard';
}

/** Petabytes this company holds in one sector. Zero when it holds none, or is a world-1/2 company. */
export function dataPetabytesOf(company: Company, sector: Sector): number {
  const found = (company.dataAssets ?? []).find((entry) => entry.sector === sector);
  return found === undefined ? 0 : Math.max(0, found.petabytes);
}

/** Every sector's stock added up. What the compliance charge and the breach hazard read. */
export function totalDataPetabytes(company: Company): number {
  let total = 0;
  for (const entry of company.dataAssets ?? []) total += Math.max(0, entry.petabytes);
  return total;
}

/**
 * The saturating edge a stock buys, 0..1.
 *
 * `pb / (pb + DATA_HALF_PB)`: zero at nothing, a half at `DATA_HALF_PB`, and
 * approaching but never reaching one.
 */
export function dataEdgeOf(petabytes: number): number {
  const pb = Math.max(0, petabytes);
  return pb <= 0 ? 0 : pb / (pb + DATA_HALF_PB);
}

/** Points of quality a company's stock in one sector adds to what it sells there. */
export function dataQualityUplift(company: Company, sector: Sector): number {
  return DATA_QUALITY_MAX * dataEdgeOf(dataPetabytesOf(company, sector));
}

/**
 * How well supplied with data a programme against `node` is, 0..1-and-a-bit.
 *
 * The same saturating adequacy shape the funding, compute and talent factors
 * use, against the node's own `dataRequiredPb`. A node that asks for no data is
 * fully supplied by definition.
 */
export function dataAdequacy(availablePb: number, requiredPb: number): number {
  if (requiredPb <= 0) return 1;
  const r = Math.max(0, availablePb) / requiredPb;
  return DATA_FLOOR + (1 - DATA_FLOOR) * Math.min(1, r);
}

/* -------------------------------------------------------------------------- */
/*  Writing a company's stock                                                  */
/* -------------------------------------------------------------------------- */

/**
 * How finely a stock is stored: to the gigabyte, a millionth of a petabyte.
 *
 * The quantisation exists so a stock is a stable, hashable number rather than a
 * drifting float. At a thousandth of a petabyte it was also a silent floor: a
 * seat-based enterprise line generating a twentieth of a terabyte a quarter
 * rounded to exactly nothing every quarter forever, so the mechanism was wired
 * end to end and accrued zero for the background the game opens on.
 */
export const DATA_STORAGE_QUANTUM_PB = 1e-6;

/** Set one sector's stock, adding the row when it is not there and keeping sector order stable. */
function setPetabytes(company: Company, sector: Sector, petabytes: number): void {
  const value = Math.max(0, Math.round(petabytes / DATA_STORAGE_QUANTUM_PB) * DATA_STORAGE_QUANTUM_PB);
  const assets: DataAsset[] = [...(company.dataAssets ?? [])];
  const index = assets.findIndex((entry) => entry.sector === sector);
  if (index >= 0) {
    const existing = assets[index];
    if (existing === undefined) return;
    assets[index] = { sector: existing.sector, petabytes: value };
  } else {
    assets.push({ sector, petabytes: value });
  }
  company.dataAssets = assets;
}

/** What one line generates this quarter, before decay. Zero for a node that observes nothing. */
export function generatedPetabytes(
  draft: SessionState,
  company: Company,
  node: EconomicNode,
  servedUnits: number,
  segment: ProductSegment,
): number {
  if (node.dataYieldPerUnitQuarter <= 0 || servedUnits <= 0) return 0;
  const weight = SEGMENT_DATA_WEIGHT[segment];
  const collection = COLLECTION_MULTIPLE[dataPolicyOf(company)];
  return node.dataYieldPerUnitQuarter * servedUnits * weight * collection * privacyFactor(draft, node);
}

/**
 * What survives the privacy regime, 0.2..1.
 *
 * The one place `world.regulation.privacy` becomes an economic number. A node
 * that observes nothing personal (`dataSensitivity` 0) is untouched by any
 * regime, which is why the drag is a product of the two and not a sum.
 */
export function privacyFactor(draft: SessionState, node: EconomicNode): number {
  const privacy = unit(draft.world.regulation.privacy);
  return clamp(1 - PRIVACY_DRAG * privacy * unit(node.dataSensitivity), 0, 1);
}

/**
 * How much data one line uses each quarter to make what it makes.
 *
 * A dataset in one of the node's slots is a real input in real quantity,
 * exactly like a wafer: `qtyPerUnit` petabytes per unit produced, read off the
 * dataset the slot is actually filled with. What the company's own pool cannot
 * cover is bought, and that is priced in the roll-up rather than here.
 */
export function consumedPetabytes(
  state: SessionState,
  company: Company,
  product: Product,
  node: EconomicNode,
  units: number,
  cache?: NodeCostCache,
): number {
  if (units <= 0) return 0;
  let total = 0;
  for (const fill of resolveFills(state, company, product, node, cache)) {
    if (fill.nodeId === null) continue;
    const perUnit = petabytesPerUnit(fill.nodeId);
    if (perUnit <= 0) continue;
    const slot = node.slots.find((candidate) => candidate.id === fill.slotId);
    if (slot === undefined) continue;
    total += slot.qtyPerUnit * units * perUnit;
  }
  return total;
}

/**
 * How many units of a dataset node a company's own pool can supply this
 * quarter.
 *
 * The cap on selling data: a corpus you have not collected is a corpus you
 * cannot sell, which is why selling data needs no second lever — it is
 * `launch_product` on a `dat_` node and the stock is the capacity.
 */
export function sellableDataUnits(company: Company, node: EconomicNode): number {
  const perUnit = petabytesPerUnit(node.id);
  if (perUnit <= 0) return Number.POSITIVE_INFINITY;
  return dataPetabytesOf(company, node.sector) / perUnit;
}

/**
 * How much of a line's dataset input the company's own pool covers, 0..1.
 *
 * Own data is FREE to the line that owns it — that is the entire point of
 * having collected it — and the shortfall is bought at market by the roll-up.
 * Coverage is measured against one quarter of production at the line's current
 * scale, floored at a single unit so a line that has not shipped yet is not
 * handed free data for ever.
 */
export function dataSelfSupplyShare(company: Company, node: EconomicNode, inputNodeId: string, qtyPerUnit: number, unitsPerQuarter: number): number {
  const perUnit = petabytesPerUnit(inputNodeId);
  if (perUnit <= 0) return 0;
  const upstream = economicNodeById(inputNodeId);
  if (upstream === undefined) return 0;
  const neededPb = qtyPerUnit * Math.max(1, unitsPerQuarter) * perUnit;
  if (neededPb <= 0) return 0;
  return clamp(dataPetabytesOf(company, upstream.sector) / neededPb, 0, 1);
}

/* -------------------------------------------------------------------------- */
/*  The pass                                                                   */
/* -------------------------------------------------------------------------- */

/** One sector's movement for one company, before it is written back. */
interface SectorFlow {
  generated: number;
  consumed: number;
  sold: number;
}

/**
 * Accrue, spend and decay every company's data for one quarter, and say so.
 *
 * Runs inside `product_demand_resolution`, straight after the production pass,
 * because what a line served this quarter is what it collected this quarter.
 * One `data_resolved` row per company per sector it holds data in.
 *
 * Nothing here draws a random number, so it cannot move any other phase's call
 * sequence.
 */
export function resolveNodeData(draft: SessionState, ctx: ResolverContext, cache: NodeCostCache = createNodeCostCache(draft)): void {
  for (const company of activeCompanies(draft)) {
    applyPolicyStanding(draft, company);
    const flows = new Map<Sector, SectorFlow>();
    const flowFor = (sector: Sector): SectorFlow => {
      const found = flows.get(sector);
      if (found !== undefined) return found;
      const fresh: SectorFlow = { generated: 0, consumed: 0, sold: 0 };
      flows.set(sector, fresh);
      return fresh;
    };
    // Every sector already holding a stock takes part, so a company that has
    // stopped collecting still sees its stock decay rather than freeze.
    for (const asset of company.dataAssets ?? []) flowFor(asset.sector);

    for (const product of activeProducts(company)) {
      const node = lineNodeOf(product);
      if (node === undefined) continue;
      const units = Math.max(0, product.unitsSoldQuarterly ?? product.activeCustomers);
      // What a line may keep depends on who it sells to: the line's own
      // customer type, not the node's typical one.
      const segment = product.segment;
      const flow = flowFor(node.sector);
      // A line whose node IS a dataset sells its stock rather than observing
      // anything: selling a corpus is `launch_product` on a `dat_` node, with
      // no second lever anywhere.
      if (isDataNode(node.id)) flow.sold += units * petabytesPerUnit(node.id);
      else flow.generated += generatedPetabytes(draft, company, node, units, segment);
      flow.consumed += consumedPetabytes(draft, company, product, node, units, cache);
    }

    for (const [sector, flow] of flows) {
      const opening = dataPetabytesOf(company, sector);
      const drawn = Math.min(opening + flow.generated, flow.consumed + flow.sold);
      const beforeDecay = Math.max(0, opening + flow.generated - drawn);
      const closing = beforeDecay * (1 - DATA_DECAY);
      const decayed = beforeDecay - closing;
      setPetabytes(company, sector, closing);

      if (opening <= 0 && flow.generated <= 0) continue;
      emitEvent(
        draft,
        ctx,
        'data_resolved',
        company.id,
        company.id,
        {
          sector,
          openingPb: round(opening),
          generatedPb: round(flow.generated),
          decayedPb: round(decayed),
          consumedPb: round(Math.min(drawn, flow.consumed)),
          soldPb: round(Math.max(0, drawn - flow.consumed)),
          closingPb: round(closing),
          collectionLevel: dataPolicyOf(company),
          qualityUpliftPct: Math.round(DATA_QUALITY_MAX * dataEdgeOf(closing) * 100),
          privacyDragPct: Math.round(unit(draft.world.regulation.privacy) * PRIVACY_DRAG * 100),
        },
        'company',
      );
    }
  }
}

/**
 * What the collection policy costs, or earns, in standing — and what aggressive
 * collection does to the odds of a ruling.
 *
 * Every quarter it is in force, not once when it is set: a company that
 * collects everything is disliked for as long as it does so, and the pressure
 * comes off the quarter it stops.
 */
function applyPolicyStanding(draft: SessionState, company: Company): void {
  const level = dataPolicyOf(company);
  const delta = DATA_POLICY_REPUTATION[level];
  if (delta !== 0) {
    company.reputation.public = clamp(company.reputation.public + delta, 0, 100);
  }
  if (level !== 'aggressive') return;
  // The hazard is the world's, because a ruling is: one company's practices
  // raise the chance of a rule everybody then lives under. Only a family the
  // scenario actually authored is touched — the engine never invents one.
  const hazard = draft.eventHazards[PRIVACY_HAZARD_FAMILY_ID];
  if (hazard === undefined) return;
  hazard.pendingDeltas.push({
    amount: AGGRESSIVE_PRIVACY_EXPOSURE,
    remainingQuarters: AGGRESSIVE_PRIVACY_DECAY_QUARTERS,
    sourceEventId: `${company.id}:data_policy`,
  });
  let sum = hazard.baseHazard;
  for (const pending of hazard.pendingDeltas) sum += pending.amount;
  hazard.currentHazard = unit(sum);
}

/** Three decimals: a petabyte figure a screen can print and a hash can compare. */
function round(value: number): number {
  return Math.round(Math.max(0, value) * 1000) / 1000;
}
