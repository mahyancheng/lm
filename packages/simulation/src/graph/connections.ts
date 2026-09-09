/**
 * @frontier/simulation — graph/connections.ts
 *
 * One company's commercial position as three columns: who supplies it, what it
 * is, and who buys from it.
 *
 * The canvas asked a founder to understand the industry before they could
 * understand their own company. This module answers the smaller question the
 * screen actually needs — *what is wired to this line, and on what terms that I
 * am party to* — so the picture is a supplier column, a hub and a customer
 * column rather than ninety nodes laid out by tier.
 *
 * ## The boundary
 *
 * Rule 9 governs every field here. **Relationships are public**: who fills
 * which slot from whom, who buys a published line, who holds a government
 * award. **Numbers are not**, with exactly two exceptions, and both of them are
 * the viewer's own:
 *
 * 1. **The viewer's own order book.** How many units cross a wire the viewer is
 *    standing on, either end of it. Mine to see because half of it is mine.
 * 2. **A price the viewer is party to.** My ask landing as a rival's slot price
 *    is a number I published; the price I pay a supplier is a number I pay.
 *    Neither is a rival's secret.
 *
 * Everything else a rival owns — their unit cost, their margin, their quality,
 * their list price, their ask to somebody else, their share of a market — is
 * absent from a rival's view rather than blurred, which is the rule
 * `projection.ts` already follows and the one `connections.test.ts` proves with
 * distinctive numbers.
 *
 * Every price on the viewer's own view comes from `cost.ts` and `options.ts` —
 * the roll-up's own `slot:${slotId}` rows and `slotOptions`' routes — so the
 * figure on a wire is the figure the profit and loss books, not a cousin of it.
 *
 * Pure and total. No random source, no clock, no module-level cache.
 */

import type {
  Company,
  EconomicNode,
  NodeCostCache,
  Product,
  ProductSegment,
  SessionState,
  Sector,
} from '@frontier/contracts';
import { economicNodeById } from '@frontier/contracts';
import { counterpartyCharges } from '../companies/counterparty';
import { namedSupplierPriceUsd, unitCostOf, unitCostOfProduct } from './cost';
import { createNodeCostCache, lineNodeIdOf, lineNodeOf, unitsSoldLastQuarterOf } from './lines';
import { nodeBalances, type NodeBalance } from './market';
import { slotOptions, type InputRoute, type NodeSlotOptions, type SlotCandidate } from './options';
import { cellKey, resolveFills, targetOf } from './slots';

/* -------------------------------------------------------------------------- */
/*  Constants                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * How many dashed alternatives a slot offers before the header says "+N more".
 *
 * One. Three slots at three rows each is a 572-point picture under 354 points
 * of page, which does not fit an 844-point phone; at two rows each it is 416
 * and it does. The reference draws exactly this — the live supplier and one
 * other — and the slot's own candidate sheet still lists every admissible route
 * with its price, which is where a comparison belongs anyway.
 */
export const MAX_ALTERNATIVES_PER_SLOT = 1;

/* -------------------------------------------------------------------------- */
/*  Shapes                                                                     */
/* -------------------------------------------------------------------------- */

/** One named buyer drawing on one line. */
export interface LineCustomer {
  readonly buyerCompanyId: string;
  readonly buyerProductId: string;
  readonly buyerNodeId: string;
  readonly slotId: string;
  /** True when the buyer is the seller: an internal transfer at own cost. */
  readonly internal: boolean;
  /** Units this buyer drew last quarter. Null when the viewer is on neither end. */
  readonly unitsDrawnLastQuarter: number | null;
  /** The seller's ask as this buyer pays it; the seller's own unit cost on an internal transfer. */
  readonly unitPriceUsd: number | null;
  /** What that buyer's roll-up books for this input: units times price. */
  readonly bookedByBuyerUsd: number | null;
}

/** One cell of a node's market, and what it is asking for this quarter. */
export interface NodeMarketCellDemand {
  readonly cellKey: string;
  readonly industry: Sector;
  readonly customer: ProductSegment;
  readonly demandUnits: number;
}

/** One line's share of the single cell it draws its orders from. */
export interface LineMarketShare extends NodeMarketCellDemand {
  readonly myUnits: number;
  /** Whole percent, 0..100. */
  readonly sharePct: number;
}

/** One of the subject's lines, for the switcher above the picture. */
export interface ConnectionsLine {
  readonly productId: string;
  readonly nodeId: string;
  readonly nodeLabel: string;
  readonly name: string;
  readonly selected: boolean;
}

/** The centre pill: the line itself, and the four figures that decide whether it works. */
export interface ConnectionsHub {
  readonly nodeId: string;
  readonly nodeLabel: string;
  readonly unitLabel: string;
  readonly unitCostUsd: number | null;
  readonly listPriceUsd: number | null;
  /** The published ask, or null when the line is not published. */
  readonly askUsd: number | null;
  /** Stored as the 0..1 fraction the product carries; the screen does the times-100. */
  readonly grossMarginPct: number | null;
  readonly unitsSoldLastQuarter: number | null;
  readonly blockedInputNodeIds: readonly string[];
}

/** What a supply pill is: the live fill's route, or a route that is merely possible. */
export type SupplyOptionKind = 'make' | 'buy' | 'market' | 'blocked' | 'empty';

/** One pill in the supplier column. */
export interface ConnectionsSupplyOption {
  readonly kind: SupplyOptionKind;
  /** True for the route the slot actually runs on: a solid wire. */
  readonly live: boolean;
  readonly nodeId: string | null;
  readonly nodeLabel: string;
  readonly supplierCompanyId: string | null;
  readonly supplierProductId: string | null;
  /** "Make it yourself", a seller's name, "Open market", "Nobody makes it". */
  readonly label: string;
  readonly unitPriceUsd: number | null;
  readonly qualityScore: number | null;
  readonly premiumPct: number | null;
  /** The viewer's own order book on a live wire they are on; null on anything else. */
  readonly unitsDrawnLastQuarter: number | null;
}

/** One slot of the hub's node: its live fill first, then what else it could run on. */
export interface ConnectionsSupplier {
  readonly slotId: string;
  readonly slotLabel: string;
  readonly required: boolean;
  readonly blocking: boolean;
  readonly qtyPerUnit: number;
  readonly unitLabel: string;
  /** Live first, then at most `MAX_ALTERNATIVES_PER_SLOT` alternatives. */
  readonly options: readonly ConnectionsSupplyOption[];
  /** Admissible routes beyond the ones listed, for a "+N more" on the header. */
  readonly moreCount: number;
}

/** One market cell in the customer column. */
export interface ConnectionsCell extends NodeMarketCellDemand {
  /** True for the cell this line actually draws from. */
  readonly live: boolean;
  readonly myUnits: number | null;
  readonly sharePct: number | null;
  readonly listPriceUsd: number | null;
}

/** One government award the subject is on. An award is public, its value included. */
export interface ConnectionsAgency {
  readonly agencyId: string;
  readonly name: string;
  readonly shortName: string;
  readonly contractId: string;
  readonly totalValueUsd: number;
  readonly role: 'prime' | 'consortium' | 'subcontractor';
}

/** One compute bill passing between the subject and somebody else. */
export interface ConnectionsCompute {
  readonly counterpartyCompanyId: string;
  /** Relative to the subject of the view. */
  readonly direction: 'pays_me' | 'i_pay';
  readonly kind: 'reservation' | 'cloud' | 'accelerators';
  /** Null unless the viewer is one of the two parties. */
  readonly amountUsd: number | null;
}

/** One company's connections, as one seat is entitled to see them. */
export interface ConnectionsView {
  readonly viewerCompanyId: string;
  readonly subjectCompanyId: string;
  readonly isOwn: boolean;
  readonly lines: readonly ConnectionsLine[];
  readonly productId: string | null;
  readonly hub: ConnectionsHub | null;
  readonly suppliers: readonly ConnectionsSupplier[];
  readonly customers: readonly LineCustomer[];
  readonly cells: readonly ConnectionsCell[];
  readonly agencies: readonly ConnectionsAgency[];
  readonly compute: readonly ConnectionsCompute[];
  /** Company id to name, for every company named anywhere above. */
  readonly companyNames: Readonly<Record<string, string>>;
}

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/** Clamp into `[min, max]`; non-finite collapses to `min`. */
function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return value < min ? min : value > max ? max : value;
}

/** Compare two ids as strings, for a total order that does not depend on insertion. */
function byId(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The routes' own order when two of them cost the same: make, then buy, then market. */
const ROUTE_ORDER: Readonly<Record<InputRoute['kind'], number>> = { make: 0, buy: 1, market: 2 };

/* -------------------------------------------------------------------------- */
/*  Customers of one line                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Every named buyer drawing on one company's line, biggest first.
 *
 * One walk of the world's active lines, resolving each one's fills — so a
 * lapsed notice or closed terms is not a customer, and a company's own line
 * feeding another of its own lines is, marked `internal`.
 *
 * The two price expressions are deliberately the two `priceResolved` uses for
 * the same two routes, so what this says a buyer pays is what that buyer's
 * roll-up actually books.
 */
export function customersOf(
  state: SessionState,
  companyId: string,
  productId: string,
  cache: NodeCostCache = createNodeCostCache(state),
): readonly LineCustomer[] {
  const seller = state.companies.find((company) => company.id === companyId);
  if (seller === undefined || !seller.isActive) return [];
  const sellerLine = seller.products.find((product) => product.id === productId);
  if (sellerLine === undefined || !sellerLine.isActive) return [];
  const soldNodeId = lineNodeIdOf(sellerLine);
  if (soldNodeId === null) return [];

  const out: LineCustomer[] = [];
  for (const buyer of state.companies) {
    if (!buyer.isActive) continue;
    for (const product of buyer.products) {
      if (!product.isActive) continue;
      const node = lineNodeOf(product);
      if (node === undefined) continue;
      for (const fill of resolveFills(state, buyer, product, node, cache)) {
        if (fill.route !== 'buy' && fill.route !== 'make') continue;
        if (fill.nodeId !== soldNodeId) continue;
        if (fill.supplierCompanyId !== companyId || fill.supplierProductId !== productId) continue;
        const slot = node.slots.find((candidate) => candidate.id === fill.slotId);
        const internal = buyer.id === companyId;
        const units = unitsSoldLastQuarterOf(product) * (slot?.qtyPerUnit ?? 0);
        const unitPriceUsd = internal
          ? unitCostOf(state, seller, soldNodeId, cache).unitCostUsd
          : namedSupplierPriceUsd(state, seller, fill.askUsd ?? 0, soldNodeId);
        out.push({
          buyerCompanyId: buyer.id,
          buyerProductId: product.id,
          buyerNodeId: node.id,
          slotId: fill.slotId,
          internal,
          unitsDrawnLastQuarter: units,
          unitPriceUsd,
          bookedByBuyerUsd: units * unitPriceUsd,
        });
      }
    }
  }

  out.sort(
    (a, b) =>
      (b.bookedByBuyerUsd ?? 0) - (a.bookedByBuyerUsd ?? 0) ||
      byId(a.buyerCompanyId, b.buyerCompanyId) ||
      byId(a.buyerProductId, b.buyerProductId),
  );
  return out;
}

/* -------------------------------------------------------------------------- */
/*  A line against its own market                                              */
/* -------------------------------------------------------------------------- */

/**
 * What share of its own cell a line took last quarter.
 *
 * The denominator is the cell of `nodeBalances` the line actually draws from —
 * the same cell `resolveNodeProduction` rations it against — so the percentage
 * on the screen is the percentage the engine used. Null for a product with no
 * node: a world-2 line has no cell to have a share of.
 */
export function lineMarketShare(
  state: SessionState,
  company: Company,
  product: Product,
  balances: Readonly<Record<string, NodeBalance>> = nodeBalances(state),
): LineMarketShare | null {
  const nodeId = lineNodeIdOf(product);
  if (nodeId === null) return null;
  const node = economicNodeById(nodeId);
  if (node === undefined) return null;

  const industry = targetOf(product, node);
  const customer = product.segment;
  const key = cellKey(industry, customer);
  const demandUnits = balances[nodeId]?.cells[key] ?? 0;
  const myUnits = unitsSoldLastQuarterOf(product);
  return {
    cellKey: key,
    industry,
    customer,
    demandUnits,
    myUnits,
    // Clamped because supply and demand are two passes over the same quarter
    // and the engine does not reconcile them: a line can ship more than its
    // cell asked for, and "140% of the market" is not a sentence.
    sharePct: demandUnits <= 0 ? 0 : clamp(Math.round((myUnits / demandUnits) * 100), 0, 100),
  };
}

/**
 * Every cell of one node's market that is asking for something, biggest first.
 *
 * Zero cells are dropped rather than listed: a market with no demand is not a
 * market a founder can aim at. What is left therefore sums to the node's
 * `demandUnits` exactly.
 */
export function marketsForNode(
  state: SessionState,
  nodeId: string,
  balances: Readonly<Record<string, NodeBalance>> = nodeBalances(state),
): readonly NodeMarketCellDemand[] {
  const cells = balances[nodeId]?.cells ?? {};
  const out: NodeMarketCellDemand[] = [];
  for (const [key, demandUnits] of Object.entries(cells)) {
    if (demandUnits <= 0) continue;
    const [industry, customer] = key.split('|');
    if (industry === undefined || customer === undefined) continue;
    out.push({ cellKey: key, industry: industry as Sector, customer: customer as ProductSegment, demandUnits });
  }
  out.sort((a, b) => b.demandUnits - a.demandUnits || byId(a.cellKey, b.cellKey));
  return out;
}

/* -------------------------------------------------------------------------- */
/*  The whole view                                                             */
/* -------------------------------------------------------------------------- */

/**
 * One company's connections as `viewerCompanyId` may see them.
 *
 * `subjectCompanyId` is the company in the middle; pass the viewer's own id for
 * their screen, or a rival's to follow the chain one company along.
 * `productId` null selects the subject's first active node line.
 *
 * One cost cache and one `nodeBalances` for the whole call, so a screen that
 * rebuilds this on every tap pays for one pass over the lines rather than one
 * per pill.
 */
export function connectionsOf(
  state: SessionState,
  viewerCompanyId: string,
  subjectCompanyId: string,
  productId: string | null = null,
): ConnectionsView {
  const isOwn = viewerCompanyId === subjectCompanyId;
  const subject = state.companies.find((company) => company.id === subjectCompanyId && company.isActive);
  const names: Record<string, string> = {};
  const nameOf = (companyId: string | null): string | null => {
    if (companyId === null) return null;
    const company = state.companies.find((candidate) => candidate.id === companyId && candidate.isActive);
    if (company === undefined) return null;
    names[company.id] = company.name;
    return company.name;
  };

  if (subject === undefined) {
    return {
      viewerCompanyId,
      subjectCompanyId,
      isOwn,
      lines: [],
      productId: null,
      hub: null,
      suppliers: [],
      customers: [],
      cells: [],
      agencies: [],
      compute: [],
      companyNames: names,
    };
  }
  nameOf(subject.id);

  const cache = createNodeCostCache(state);
  const balances = nodeBalances(state, cache);

  /* --- the lines, and the one this picture is of ------------------------- */
  const nodeLines = subject.products.filter((product) => product.isActive && lineNodeIdOf(product) !== null);
  const chosen = nodeLines.find((product) => product.id === productId) ?? nodeLines[0] ?? null;
  const lines: readonly ConnectionsLine[] = nodeLines.map((product) => ({
    productId: product.id,
    nodeId: lineNodeIdOf(product) ?? '',
    nodeLabel: lineNodeOf(product)?.label ?? '',
    name: product.name,
    selected: chosen !== null && product.id === chosen.id,
  }));

  const node = chosen === null ? undefined : lineNodeOf(chosen);
  const nodeId = node?.id ?? null;

  const agencies = agenciesFor(state, subject.id);
  const compute = computeFor(state, subject.id, viewerCompanyId, nameOf);

  if (chosen === null || node === undefined || nodeId === null) {
    return {
      viewerCompanyId,
      subjectCompanyId,
      isOwn,
      lines,
      productId: null,
      hub: null,
      suppliers: [],
      customers: [],
      cells: [],
      agencies,
      compute,
      companyNames: names,
    };
  }

  const unitsSold = unitsSoldLastQuarterOf(chosen);

  /* --- the hub ----------------------------------------------------------- */
  // A rival's hub carries the node and nothing else. Their cost, their price,
  // their ask and their margin are the four numbers this screen exists to show
  // a founder about their OWN line, and none of them is mine to read.
  const cost = isOwn ? (unitCostOfProduct(state, subject, chosen, cache) ?? unitCostOf(state, subject, nodeId, cache)) : null;
  const hub: ConnectionsHub = {
    nodeId,
    nodeLabel: node.label,
    unitLabel: node.unitLabel,
    unitCostUsd: cost === null ? null : cost.unitCostUsd,
    listPriceUsd: isOwn ? chosen.pricePerSeat : null,
    askUsd: isOwn ? (chosen.supplyTerms?.pricePerUnitUsd ?? null) : null,
    grossMarginPct: isOwn ? chosen.grossMarginPct : null,
    unitsSoldLastQuarter: isOwn ? unitsSold : null,
    blockedInputNodeIds: cost === null ? [] : cost.blockedInputNodeIds,
  };

  /* --- the two columns --------------------------------------------------- */
  const suppliers = isOwn
    ? ownSuppliers(state, subject, node, chosen, unitsSold, cache, nameOf)
    : rivalSuppliers(state, subject, node, chosen, viewerCompanyId, unitsSold, cache, nameOf);

  const rawCustomers = customersOf(state, subject.id, chosen.id, cache);
  for (const customer of rawCustomers) nameOf(customer.buyerCompanyId);
  const customers: readonly LineCustomer[] = isOwn
    ? rawCustomers
    : rawCustomers.map((customer) =>
        customer.buyerCompanyId === viewerCompanyId
          ? customer
          : { ...customer, unitsDrawnLastQuarter: null, unitPriceUsd: null, bookedByBuyerUsd: null },
      );

  const share = lineMarketShare(state, subject, chosen, balances);
  const cells: readonly ConnectionsCell[] = isOwn
    ? [
        ...(share === null ? [] : [{ ...share, live: true, myUnits: share.myUnits, sharePct: share.sharePct, listPriceUsd: chosen.pricePerSeat }]),
        ...marketsForNode(state, nodeId, balances)
          .filter((cell) => cell.cellKey !== share?.cellKey)
          .map((cell) => ({ ...cell, live: false, myUnits: null, sharePct: null, listPriceUsd: null })),
      ]
    : // A rival's target market is a public relationship — which cell they aim
      // at — and nothing more. The cell's own demand is a market fact, the same
      // class as a node's settled price.
      share === null
      ? []
      : [
          {
            cellKey: share.cellKey,
            industry: share.industry,
            customer: share.customer,
            demandUnits: share.demandUnits,
            live: true,
            myUnits: null,
            sharePct: null,
            listPriceUsd: null,
          },
        ];

  return {
    viewerCompanyId,
    subjectCompanyId,
    isOwn,
    lines,
    productId: chosen.id,
    hub,
    suppliers,
    customers,
    cells,
    agencies,
    compute,
    companyNames: names,
  };
}

/* -------------------------------------------------------------------------- */
/*  Suppliers: the viewer's own line                                           */
/* -------------------------------------------------------------------------- */

/** The live fill, then the cheapest routes it could be swapped for, per slot. */
function ownSuppliers(
  state: SessionState,
  subject: Company,
  node: EconomicNode,
  product: Product,
  unitsSold: number,
  cache: NodeCostCache,
  nameOf: (companyId: string | null) => string | null,
): readonly ConnectionsSupplier[] {
  const cost = unitCostOfProduct(state, subject, product, cache) ?? unitCostOf(state, subject, node.id, cache);
  return slotOptions(state, subject, node.id, product.id, cache).map((slot) => {
    const fill = slot.fill;
    const kind: SupplyOptionKind = fill === null ? 'empty' : fill.route;
    const chosenRoute = routeChosenIn(slot);
    nameOf(fill?.supplierCompanyId ?? null);

    // The price is the roll-up's own `slot:` row rather than the route's, because
    // that row is the only one carrying the dataset self-supply discount — the
    // number the profit and loss actually books for this slot.
    const row = cost.lines.find((entry) => entry.key === `slot:${slot.slotId}`);
    const priced = kind === 'make' || kind === 'buy' || kind === 'market';
    const live: ConnectionsSupplyOption = {
      kind,
      live: true,
      nodeId: fill?.nodeId ?? null,
      nodeLabel: nodeLabelOf(fill?.nodeId ?? null, slot.label),
      supplierCompanyId: fill?.supplierCompanyId ?? null,
      supplierProductId: fill?.supplierProductId ?? null,
      label: liveLabel(kind, slot, chosenRoute),
      unitPriceUsd: priced ? (row?.unitPriceUsd ?? null) : null,
      qualityScore: chosenRoute?.qualityScore ?? null,
      premiumPct: chosenRoute?.premiumPct ?? null,
      // Nothing crosses a wire that has no counterparty: the open market is a
      // price, not a relationship, and a blocked slot never shipped anything.
      unitsDrawnLastQuarter: kind === 'make' || kind === 'buy' ? unitsSold * slot.qtyPerUnit : null,
    };

    const pool = alternativeRoutes(slot, fill?.nodeId ?? null);
    const alternatives = pool.slice(0, MAX_ALTERNATIVES_PER_SLOT).map((entry) => {
      nameOf(entry.route.supplierCompanyId);
      return {
        kind: entry.route.kind,
        live: false,
        nodeId: entry.candidate.nodeId,
        nodeLabel: entry.candidate.label,
        supplierCompanyId: entry.route.supplierCompanyId,
        supplierProductId: entry.route.supplierProductId,
        label: entry.route.label,
        unitPriceUsd: entry.route.unitPriceUsd,
        qualityScore: entry.route.qualityScore,
        premiumPct: entry.route.premiumPct,
        unitsDrawnLastQuarter: null,
      } satisfies ConnectionsSupplyOption;
    });

    return {
      slotId: slot.slotId,
      slotLabel: slot.label,
      required: slot.required,
      blocking: slot.blocking,
      qtyPerUnit: slot.qtyPerUnit,
      unitLabel: slot.unitLabel,
      options: [live, ...alternatives],
      moreCount: Math.max(0, pool.length - alternatives.length),
    } satisfies ConnectionsSupplier;
  });
}

/** The route the slot resolves to right now, or null on a blocked or empty slot. */
function routeChosenIn(slot: NodeSlotOptions): InputRoute | null {
  for (const candidate of slot.candidates) {
    for (const route of candidate.routes) if (route.chosen) return route;
  }
  return null;
}

/** What the live pill says: the route's own words, or why there is no route at all. */
function liveLabel(kind: SupplyOptionKind, slot: NodeSlotOptions, route: InputRoute | null): string {
  if (route !== null) return route.label;
  if (kind === 'blocked') return 'Nobody makes it';
  return slot.label;
}

/** A node's own label, falling back to the slot's when the slot is empty. */
function nodeLabelOf(nodeId: string | null, fallback: string): string {
  if (nodeId === null) return fallback;
  return economicNodeById(nodeId)?.label ?? nodeId;
}

/** One route on one candidate, kept together so the pill can name both. */
interface AlternativeRoute {
  readonly candidate: SlotCandidate;
  readonly route: InputRoute;
}

/**
 * What else this slot could run on, cheapest first.
 *
 * Two pools in order, because they answer two different questions: *the same
 * input from somewhere else* comes before *a different input altogether*. A
 * candidate that would block the line is excluded — offering a founder a route
 * that stops production is not an alternative.
 */
function alternativeRoutes(slot: NodeSlotOptions, liveNodeId: string | null): readonly AlternativeRoute[] {
  const sameNode: AlternativeRoute[] = [];
  const otherNodes: AlternativeRoute[] = [];

  for (const candidate of slot.candidates) {
    if (candidate.nodeId === liveNodeId) {
      for (const route of candidate.routes) {
        if (route.chosen) continue;
        sameNode.push({ candidate, route });
      }
      continue;
    }
    if (candidate.blocked) continue;
    const cheapest = [...candidate.routes].sort(
      (a, b) => a.unitPriceUsd - b.unitPriceUsd || ROUTE_ORDER[a.kind] - ROUTE_ORDER[b.kind] || byId(a.supplierCompanyId ?? '', b.supplierCompanyId ?? ''),
    )[0];
    if (cheapest !== undefined) otherNodes.push({ candidate, route: cheapest });
  }

  sameNode.sort(
    (a, b) =>
      a.route.unitPriceUsd - b.route.unitPriceUsd ||
      ROUTE_ORDER[a.route.kind] - ROUTE_ORDER[b.route.kind] ||
      byId(a.route.supplierCompanyId ?? '', b.route.supplierCompanyId ?? ''),
  );
  otherNodes.sort((a, b) => a.route.unitPriceUsd - b.route.unitPriceUsd || byId(a.candidate.nodeId, b.candidate.nodeId));
  return [...sameNode, ...otherNodes];
}

/* -------------------------------------------------------------------------- */
/*  Suppliers: a rival's line                                                  */
/* -------------------------------------------------------------------------- */

/**
 * A rival's supplier column: their live named wires and nothing else.
 *
 * An open-market fill is not a relationship — there is no counterparty to draw
 * a pill for — and an alternative is a decision only the line's owner gets to
 * consider, so neither appears. A price and an order book appear on exactly one
 * kind of wire: the one whose supplier is the viewer, where the ask is the
 * viewer's own published number and the units are half theirs.
 */
function rivalSuppliers(
  state: SessionState,
  subject: Company,
  node: EconomicNode,
  product: Product,
  viewerCompanyId: string,
  unitsSold: number,
  cache: NodeCostCache,
  nameOf: (companyId: string | null) => string | null,
): readonly ConnectionsSupplier[] {
  const viewer = state.companies.find((company) => company.id === viewerCompanyId);
  const out: ConnectionsSupplier[] = [];

  for (const fill of resolveFills(state, subject, product, node, cache)) {
    if (fill.route !== 'buy' && fill.route !== 'make') continue;
    if (fill.nodeId === null || fill.supplierCompanyId === null) continue;
    const slot = node.slots.find((candidate) => candidate.id === fill.slotId);
    if (slot === undefined) continue;
    const supplierName = nameOf(fill.supplierCompanyId);
    const mine = fill.supplierCompanyId === viewerCompanyId;

    out.push({
      slotId: slot.id,
      slotLabel: slot.label,
      required: slot.required,
      blocking: slot.blocking,
      qtyPerUnit: slot.qtyPerUnit,
      unitLabel: economicNodeById(fill.nodeId)?.unitLabel ?? 'unit',
      options: [
        {
          kind: fill.route,
          live: true,
          nodeId: fill.nodeId,
          nodeLabel: nodeLabelOf(fill.nodeId, slot.label),
          supplierCompanyId: fill.supplierCompanyId,
          supplierProductId: fill.supplierProductId,
          label: fill.route === 'make' ? 'Makes it in-house' : (supplierName ?? slot.label),
          unitPriceUsd: mine ? namedSupplierPriceUsd(state, viewer, fill.askUsd ?? 0, fill.nodeId) : null,
          qualityScore: null,
          premiumPct: null,
          unitsDrawnLastQuarter: mine ? unitsSold * slot.qtyPerUnit : null,
        },
      ],
      moreCount: 0,
    });
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/*  Company-wide relationships                                                 */
/* -------------------------------------------------------------------------- */

/** Every live award the subject is on, biggest first. An award is public, value included. */
function agenciesFor(state: SessionState, subjectCompanyId: string): readonly ConnectionsAgency[] {
  const out: ConnectionsAgency[] = [];
  for (const contract of state.governmentContracts) {
    if (contract.status !== 'active') continue;
    const role: ConnectionsAgency['role'] | null =
      contract.primeCompanyId === subjectCompanyId
        ? 'prime'
        : contract.consortiumMemberIds.includes(subjectCompanyId)
          ? 'consortium'
          : contract.subcontractors.some((entry) => entry.companyId === subjectCompanyId)
            ? 'subcontractor'
            : null;
    if (role === null) continue;
    const agency = state.agencies.find((candidate) => candidate.id === contract.agencyId);
    if (agency === undefined) continue;
    out.push({
      agencyId: agency.id,
      name: agency.name,
      shortName: agency.shortName,
      contractId: contract.id,
      totalValueUsd: contract.totalValueUsd,
      role,
    });
  }
  out.sort((a, b) => b.totalValueUsd - a.totalValueUsd || byId(a.contractId, b.contractId));
  return out;
}

/**
 * Every compute bill the subject is on either end of, in `counterpartyCharges`'
 * own order.
 *
 * The rows exist on a rival's view too — who buys their compute from whom is a
 * relationship the trade press reports — but the amount is only a number the
 * viewer is party to.
 */
function computeFor(
  state: SessionState,
  subjectCompanyId: string,
  viewerCompanyId: string,
  nameOf: (companyId: string | null) => string | null,
): readonly ConnectionsCompute[] {
  const out: ConnectionsCompute[] = [];
  for (const charge of counterpartyCharges(state)) {
    const isBuyer = charge.buyerCompanyId === subjectCompanyId;
    const isSeller = charge.sellerCompanyId === subjectCompanyId;
    if (!isBuyer && !isSeller) continue;
    const counterparty = isBuyer ? charge.sellerCompanyId : charge.buyerCompanyId;
    nameOf(counterparty);
    const party = charge.buyerCompanyId === viewerCompanyId || charge.sellerCompanyId === viewerCompanyId;
    out.push({
      counterpartyCompanyId: counterparty,
      direction: isBuyer ? 'i_pay' : 'pays_me',
      kind: charge.kind,
      amountUsd: party ? charge.amountUsd : null,
    });
  }
  return out;
}
