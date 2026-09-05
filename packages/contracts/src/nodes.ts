/**
 * @frontier/contracts — nodes.ts
 *
 * The world-version-3 economy is **one table of nodes**.
 *
 * A node is a thing in the world: a resource, a material, a component, a
 * subsystem, a product, a service, a dataset. A company has a *line* on a node
 * when it produces and sells that node. Every node has exactly one market price
 * per quarter, and every line's unit cost is that node's inputs rolled up
 * through those same prices — the same number the profit and loss books as cost
 * of goods sold, not a cousin of it.
 *
 * This module replaces, for world 3 only, both `TechNodeSchema` (`tech.ts`) and
 * `ProductCategorySchema` (`productCategories.ts`). Worlds 1 and 2 keep using
 * those and are frozen; nothing here is imported by world-2 code.
 *
 * ## Slots, not recipes
 *
 * A node's inputs are **slots**. A slot names a *role* — "a model", "a harness",
 * "a battery pack" — and a real quantity in the role's unit; any node of that
 * role, or the narrower list the slot `accepts`, can fill it. The table carries
 * a sensible default per slot, which is the recipe a line runs on until its
 * owner composes it differently, and the composition itself lives on the
 * product (`Product.slots`), never on the table. That is what lets a consumer
 * app run on one company's inference API this quarter and another's next, and
 * what lets a robot maker choose its cell chemistry at the pack.
 *
 * ## What the one table deletes
 *
 * - **`share`-of-revenue is gone.** A slot carries a real `qtyPerUnit` in the
 *   input's own unit. Quantities and prices are the only currency, so a bill of
 *   materials is arithmetic rather than an assertion.
 * - **`segmentReferencePrice` is gone.** A price is judged against its own
 *   node's market price. World 2 judged a wafer fab against the customer-
 *   weighted mean price of every product in the enterprise segment across all
 *   six sectors, which is why a wafer priced at its own reference lost most of
 *   its gross additions to saturation decay.
 * - **A global `achieved` state is gone.** Ownership is per company:
 *   `Company.ownedNodes`. `pioneer` records who got there first and nothing
 *   else. World 2 asked whether a node was achieved *by anybody*, and exactly
 *   one node of forty-two was seeded that way, so on turn one nearly every
 *   technology was locked for everybody — including the incumbents already
 *   selling it.
 * - **`canSupply` is gone.** Every node can be sold; that is what a node *is*.
 * - **A single `buyerSegment` is gone.** A node sells into a **market**: a
 *   weighted set of customer types and a weighted set of industries. A wafer
 *   sells to enterprises in the sectors whose slots admit it; an enterprise
 *   application sells to every industry; a consumer app sells to the public.
 * - **`TechEdge` and `TechTrack` are gone.** A second edge list that can
 *   disagree with `requires` is exactly the drift that made `unlocksCategoryIds`
 *   dead weight. Belief propagates along reverse-`requires`; lanes derive from
 *   `sector` and `tier`.
 *
 * ## The two invariants that make the table computable
 *
 * 1. **A slot's role sits strictly below its owner's tier, for every node of
 *    that role.** Not only the default: every node a player could ever put in
 *    the slot. That gives a free topological order for any composition, makes
 *    the cost roll-up provably terminating, and means no cycle is even
 *    representable.
 * 2. **`requires` is acyclic and non-increasing in tier.** Same-tier `requires`
 *    are legal: knowledge sits sideways.
 *
 * `economicGraphDefects` proves both, plus slot well-formedness, reference
 * resolution, unit agreement, market weights and sector connectivity, and the
 * contract tests run it against the real table.
 */

import { z } from 'zod';
import { CalendarYearSchema, QuarterIndexSchema, unitInterval, usd } from './ids';
import { CapacityKindSchema, PRODUCT_SEGMENTS, ProductSegmentSchema, TechCapabilityAreaSchema, type ProductSegment } from './company';
import { NodeRoleSchema, type NodeRole } from './nodeRoles';
import { SectorSchema, type Sector } from './sectors';
import { TechVisibilitySchema } from './tech';

/* -------------------------------------------------------------------------- */
/*  Tier                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The eight tiers, and the only ordering in the economy. Depth is deliberately
 * capped: a chain of slots can be at most eight nodes long, which is both the
 * deepest real supply chain worth modelling and the deepest one a phone can
 * draw. Tier 7 exists because every chain the owner drew ends in an
 * *operation* that takes a tier-6 platform in a slot — line haul on a routing
 * platform, a brand on a marketplace.
 */
export const NODE_TIERS = [0, 1, 2, 3, 4, 5, 6, 7] as const;
export type NodeTier = (typeof NODE_TIERS)[number];

/** The tier a node sits at. Load-bearing: every slot's role must sit strictly below it. */
export const NodeTierSchema = z
  .number()
  .int()
  .min(0)
  .max(7)
  .describe(
    'Position in the economy, 0 to 7. 0 raw resource, 1 power, 2 material, 3 component, 4 subsystem, 5 system or finished product, 6 platform, network or service, 7 operation run on a platform. Every slot must admit only nodes of strictly lower tier.',
  );

/** Lane titles the map draws above each tier. Whole words; no jargon. */
export const NODE_TIER_LABELS: Readonly<Record<NodeTier, string>> = {
  0: 'Resource',
  1: 'Power',
  2: 'Material',
  3: 'Component',
  4: 'Subsystem',
  5: 'Product',
  6: 'Platform',
  7: 'Operation',
};

/** The one node every other node's `energyMwhPerUnit` is an implicit edge to. */
export const GRID_POWER_NODE_ID = 'res_grid_power';

/** The tier `GRID_POWER_NODE_ID` sits at. Power is its own layer, above raw fuel. */
export const GRID_POWER_TIER: NodeTier = 1;

/**
 * The node one unit of the "compute" capacity bucket is. Compute is capital, not
 * a consumed input — a training run occupies accelerators, it does not eat them
 * — so this is deliberately *not* a slot and takes no part in the tier rule. It
 * counts for connectivity, because an AI company buying compute is a real
 * dependency on the semiconductor chain.
 */
export const COMPUTE_CAPACITY_NODE_ID = 'sys_ai_accelerator';

/* -------------------------------------------------------------------------- */
/*  Maturity                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * How the world regards this node, replacing world 2's nine-state
 * `TechEpistemicState`. Six states, and none of them is `achieved`: whether a
 * node is achieved is a question about a *company*, not about the world.
 */
export const NODE_MATURITIES = ['commodity', 'established', 'emerging', 'frontier', 'speculative', 'discredited'] as const;

export const NodeMaturitySchema = z
  .enum(NODE_MATURITIES)
  .describe(
    'How the world regards this node. "commodity": traded everywhere, nobody has an edge. "established": widely produced, entry is capital not invention. "emerging": credible and being built now. "frontier": at the edge of what anyone can do. "speculative": contested evidence. "discredited": previously expected, now considered unlikely.',
  );
export type NodeMaturity = z.infer<typeof NodeMaturitySchema>;

/** Maturities a company can hold at the start of a game without having researched anything. */
export const STARTING_MATURITIES: readonly NodeMaturity[] = ['commodity', 'established'];

/* -------------------------------------------------------------------------- */
/*  Sale kind                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * How one unit is billed. World 2 billed every price as a recurring quarterly
 * subscription, which is why a chip billed $240,000 every quarter forever and a
 * megawatt-hour billed $26,000 a quarter against a real thirty to a hundred
 * dollars. Three kinds fix it:
 *
 * - `unit` — a one-off sale of a physical or licensed thing. Revenue is booked
 *   once; `lifetimeQuarters` says how long before the buyer replaces it.
 * - `recurring` — a seat or subscription, billed every quarter it is held.
 * - `contract` — a multi-quarter commitment billed per quarter for exactly
 *   `contractQuarters`. A twenty-quarter power purchase agreement is how
 *   "$26,000 per megawatt-hour every quarter" becomes an honest number.
 */
export const NODE_SALE_KINDS = ['unit', 'recurring', 'contract'] as const;

export const NodeSaleKindSchema = z
  .enum(NODE_SALE_KINDS)
  .describe(
    'How one unit is billed. "unit": sold once, replaced after lifetimeQuarters. "recurring": billed every quarter the customer stays. "contract": billed every quarter for exactly contractQuarters, then renegotiated.',
  );
export type NodeSaleKind = z.infer<typeof NodeSaleKindSchema>;

/* -------------------------------------------------------------------------- */
/*  Id convention                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Every node id begins with one of these. The prefix is not decoration: it
 * tells a reader — and the map — what layer of the economy a bare id belongs
 * to without a lookup, and `nodeIdPrefixSuitsTier` proves the prefix and the
 * tier agree.
 */
export const NODE_ID_PREFIXES = ['res_', 'mat_', 'cmp_', 'sys_', 'svc_', 'app_', 'dat_'] as const;
export type NodeIdPrefix = (typeof NODE_ID_PREFIXES)[number];

/**
 * Which tiers each prefix may sit at. Ranges rather than a single tier because
 * a service and a platform are the same kind of thing one layer apart, and a
 * dataset is a material at tier 2 and an asset at tier 5.
 */
export const NODE_PREFIX_TIERS: Readonly<Record<NodeIdPrefix, readonly NodeTier[]>> = {
  res_: [0, 1],
  mat_: [2],
  cmp_: [3],
  sys_: [4, 5, 6],
  svc_: [3, 4, 5, 6, 7],
  app_: [5, 6, 7],
  dat_: [2, 3, 4, 5],
};

/** The prefix of a node id, or null when it carries none of the seven. */
export function nodeIdPrefixOf(id: string): NodeIdPrefix | null {
  for (const prefix of NODE_ID_PREFIXES) if (id.startsWith(prefix)) return prefix;
  return null;
}

/** True when a node's id prefix is legal for the tier it declares. */
export function nodeIdPrefixSuitsTier(id: string, tier: number): boolean {
  const prefix = nodeIdPrefixOf(id);
  if (prefix === null) return false;
  return NODE_PREFIX_TIERS[prefix].some((allowed) => allowed === tier);
}

/* -------------------------------------------------------------------------- */
/*  Slots                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Where a slot is drawn. An `input` feeds the node; a `delivery` slot is the
 * thing the node ships *on* — software delivered on a device — and the canvas
 * draws it from the output side so the picture reads model → API → software →
 * device, left to right.
 */
export const NODE_SLOT_KINDS = ['input', 'delivery'] as const;

export const NodeSlotKindSchema = z
  .enum(NODE_SLOT_KINDS)
  .describe('"input": a material or service one unit takes in. "delivery": what the node ships on, drawn on the output side of the card.');
export type NodeSlotKind = z.infer<typeof NodeSlotKindSchema>;

/** The most slots one node may carry. Six is what a 390-point card can label. */
export const MAX_NODE_SLOTS = 6;

/** The most nodes one slot may narrow itself to. */
export const MAX_SLOT_ACCEPTS = 6;

export const NodeSlotSchema = z
  .object({
    id: z.string().min(1).max(24).describe('Unique within the node: "model", "harness", "copper". The key a product fill names.'),
    role: NodeRoleSchema,
    label: z.string().min(1).max(24).describe('The port label on the canvas.'),
    qtyPerUnit: z
      .number()
      .min(0)
      .describe('How many units of the filling node, in the admissible nodes\' shared unitLabel, one unit of this node takes. A real quantity, never a share of revenue: 8 HBM stacks per package, 1.4 kg of silicon per wafer, 0.022 wafers per die.'),
    required: z.boolean().describe('False when the slot may be left empty and the line still ships. True when a line without it is not this product.'),
    blocking: z
      .boolean()
      .describe('True when a required slot nobody in the world can fill — no admissible node owned or licensed by anyone — stops the line shipping anything. False when the open market always has some of it.'),
    accepts: z
      .array(z.string().min(1))
      .max(MAX_SLOT_ACCEPTS)
      .describe('Node ids this slot narrows itself to. Empty means every node of the role.'),
    defaultNodeId: z
      .string()
      .min(1)
      .nullable()
      .describe('The node a line runs on until its owner chooses otherwise. Null only on a slot that is not required: the default is to leave it empty.'),
    kind: NodeSlotKindSchema,
  })
  .describe('One typed input of a node: a role, a quantity, and the rules for filling it.');
export type NodeSlot = z.infer<typeof NodeSlotSchema>;

/* -------------------------------------------------------------------------- */
/*  Market                                                                     */
/* -------------------------------------------------------------------------- */

/** A weight inside a market, normalised so each set sums to one at build. */
const marketWeight = z.number().min(0).max(1).describe('Share of this node\'s end demand, 0..1. The set sums to one.');

/**
 * Who buys a node outside the supply chain, in two dimensions: the **customer
 * type** (who signs) and the **industry** (what business they are in). Demand
 * is modelled per (node × industry × customer) cell, so a line aimed at
 * logistics enterprises grows with the logistics sector and a line aimed at the
 * public grows with consumer appetite.
 */
export const NodeMarketSchema = z
  .object({
    customers: z
      .record(ProductSegmentSchema, marketWeight)
      .describe('Customer types and their share of end demand. Every node carries at least one; an intermediate sells to enterprises.'),
    industries: z
      .record(SectorSchema, marketWeight)
      .describe('Industries buying this node and their share. When the customer is the public this collapses to the consumer sector: selling to the public has no industry.'),
  })
  .describe('Who buys a node: weighted customer types times weighted industries.');
export type NodeMarket = z.infer<typeof NodeMarketSchema>;

/* -------------------------------------------------------------------------- */
/*  Edges                                                                      */
/* -------------------------------------------------------------------------- */

/** Who reached a node first. Records history; it gates nothing. */
export const NodePioneerSchema = z
  .object({
    companyId: z.string().min(1).describe('The company that first produced this node in this session.'),
    quarter: QuarterIndexSchema.describe('Quarter they first produced it.'),
  })
  .describe('The first producer of a node in this session. Replaces world 2\'s global achievedByCompanyId: ownership is per company, so being first is reputation, not a gate.');
export type NodePioneer = z.infer<typeof NodePioneerSchema>;

export const NodeChurnBandSchema = z
  .object({
    min: unitInterval('Low end of the healthy quarterly churn band.'),
    max: unitInterval('High end of the healthy quarterly churn band.'),
  })
  .describe('The quarterly churn band a healthy line on this node runs inside.');
export type NodeChurnBand = z.infer<typeof NodeChurnBandSchema>;

/* -------------------------------------------------------------------------- */
/*  The node                                                                   */
/* -------------------------------------------------------------------------- */

export const EconomicNodeSchema = z
  .object({
    /* --- identity ------------------------------------------------------- */
    id: z.string().min(1).describe('Node id, prefixed by tier family: res_, mat_, cmp_, sys_, svc_, app_ or dat_. Example: "cmp_hbm_stack".'),
    label: z.string().min(1).max(40).describe('Name as it appears on the node canvas. Forty characters because the canvas is 390 points wide.'),
    blurb: z.string().min(1).max(140).describe('One line saying what this is and why anyone buys it.'),
    sector: SectorSchema,
    tier: NodeTierSchema,
    role: NodeRoleSchema,
    maturity: NodeMaturitySchema,

    /* --- unit ----------------------------------------------------------- */
    unitLabel: z.string().min(1).max(16).describe('What one unit is, e.g. "wafer", "kWh", "1M tokens", "MW-quarter", "parcel".'),
    saleKind: NodeSaleKindSchema,
    lifetimeQuarters: z
      .number()
      .int()
      .min(1)
      .max(80)
      .nullable()
      .describe('Quarters before a unit sold outright is replaced. Set only when saleKind is "unit"; null otherwise.'),
    contractQuarters: z
      .number()
      .int()
      .min(1)
      .max(80)
      .nullable()
      .describe('Length of the commitment in quarters. Set only when saleKind is "contract"; null otherwise.'),
    basePriceUsd: usd('Price of one unit where supply and demand balance. Seeds the price index and is the fallback price when nobody in the world produces this node.'),

    /* --- edges ---------------------------------------------------------- */
    requires: z
      .array(z.string())
      .max(4)
      .describe('Node ids whose ownership a company must hold before it may produce this one. Replaces both TechNode.dependencies and ProductCategory.requiresNodeIds. Acyclic and non-increasing in tier; same-tier entries are legal because knowledge sits sideways. Empty for a commodity.'),
    slots: z
      .array(NodeSlotSchema)
      .max(MAX_NODE_SLOTS)
      .describe('Typed inputs in real quantity. Every node of every slot\'s role must sit at a strictly lower tier.'),

    /* --- production ------------------------------------------------------ */
    capacityKind: CapacityKindSchema,
    capacityDrawPerUnit: z
      .number()
      .min(0)
      .describe(
        'Units of the capacity bucket one unit per quarter draws. The bucket is ACCELERATORS for "compute" and $1,000,000 OF INSTALLED CAPITAL for "plant", "fleet" and "grid". This inverts world 2\'s capacityYieldPerUnit on purpose: required and available are now the same unit by construction, which is the dimensional break that made rationing compare dollar-millions of plant against reference-priced unit counts.',
      ),
    labourPerUnit: z
      .number()
      .min(0)
      .describe('Staff-quarters one unit per quarter needs. A cost, never a rationing constraint: one binding constraint per line is all a phone can explain.'),
    energyMwhPerUnit: z
      .number()
      .min(0)
      .describe(
        'Megawatt-hours one unit draws. An implicit slot on res_grid_power priced at that node\'s market price — one field instead of ninety hand-authored wires, and it makes every company in the world an energy customer. Must be zero for tiers 0 and 1.',
      ),
    supportCostShare: unitInterval(
      'Support and delivery cost as a share of UNIT COST, not of revenue. Charging it on revenue would make unit cost depend on the price about to be set from unit cost, which is a circularity.',
    ),

    /* --- research -------------------------------------------------------- */
    researchCostRangeUsd: z
      .tuple([usd('Low estimate of total programme cost.'), usd('High estimate of total programme cost.')])
      .describe('[low, high] estimated cost to reach ownership of this node. Estimates, not truth: the real figure is drawn inside the range and can overrun.'),
    researchComputeIntensity: unitInterval('How compute-hungry the programme is. High-intensity nodes are hostage to what the company can get hold of.'),
    talentAreas: z
      .array(TechCapabilityAreaSchema)
      .max(4)
      .describe('Capability areas the programme needs, typed against TECH_CAPABILITY_AREAS. World 2 carried untyped strings here and isCapabilityArea silently dropped every one of them.'),
    dataRequiredPb: z.number().min(0).describe('Petabytes of relevant data the programme needs. Data a company has collected from its own customers counts.'),
    novelty: unitInterval('How far this sits from what the world already believes.'),
    plausibility: unitInterval('Engine assessment of coherence with known physics, economics and the current frontier.'),
    researchable: z
      .boolean()
      .describe('Whether a research programme can target this node at all. False for raw resources and power, so the map is a few dozen real programmes rather than ninety.'),

    /* --- belief ---------------------------------------------------------- */
    publicConfidence: unitInterval('How likely the world at large thinks this is to work. What the map renders and what events move.'),
    confidenceByCompany: z
      .record(z.string(), unitInterval('That company\'s private confidence in this node.'))
      .describe('Private confidence keyed by company id. INTERNAL: never send another company\'s entry to a client. The gap between a company\'s confidence and public confidence is the edge a research bet is made on.'),
    estimatedWindow: z.tuple([CalendarYearSchema, CalendarYearSchema]).describe('[earliestYear, latestYear] in which the world expects this to be routine.'),
    originalProposerId: z.string().nullable().describe('Character who first proposed this node, or null for a seeded node.'),
    visibility: TechVisibilitySchema,
    pioneer: NodePioneerSchema.nullable().describe('The first producer in this session, or null. Replaces achievedByCompanyId and achievedQuarter.'),
    createdQuarter: QuarterIndexSchema.describe('Quarter the node entered the graph.'),

    /* --- market ---------------------------------------------------------- */
    market: NodeMarketSchema,
    endDemandBaseUnits: z
      .number()
      .min(0)
      .describe('World-wide end demand in units per quarter at neutral conditions, split across the market\'s cells. Replaces seedPool and baseAddRate with an honest market size. Positive on every node: an intermediate still has buyers the cast does not model.'),
    elasticity: z.number().min(0).max(3).describe('Price elasticity against this node\'s own market price. Higher means buyers leave faster over a price rise.'),
    churnBand: NodeChurnBandSchema,
    dataYieldPerUnitQuarter: z
      .number()
      .min(0)
      .describe('Petabytes of usable customer data one unit generates per quarter. The owner asked for data collection to be first class: this is where a product earns the data that improves the next one.'),
    dataSensitivity: unitInterval('How exposed the data this node generates is to regulation and to reputational damage when it leaks. Zero for a node that observes nothing personal.'),
  })
  .describe('One node in the world-3 economy: a thing that can be produced, priced, slotted into other nodes and sold into a market.');
export type EconomicNode = z.infer<typeof EconomicNodeSchema>;

/* -------------------------------------------------------------------------- */
/*  Slot readers                                                               */
/* -------------------------------------------------------------------------- */

/** Index by id. Pure; callers pass whichever table they are checking. Insertion order is table order. */
export function indexNodes(nodes: readonly EconomicNode[]): ReadonlyMap<string, EconomicNode> {
  return new Map(nodes.map((node) => [node.id, node] as const));
}

/** Every slot of a node, in the table's order. Named so a reader never touches the field bare. */
export function slotsOf(node: EconomicNode): readonly NodeSlot[] {
  return node.slots;
}

/** One slot by id, or undefined. */
export function slotById(node: EconomicNode, slotId: string): NodeSlot | undefined {
  return node.slots.find((slot) => slot.id === slotId);
}

/**
 * Every node that may fill a slot, in table order: the `accepts` list when the
 * slot narrows itself, otherwise every node of the slot's role. Ids the table
 * does not carry are dropped rather than returned, so a caller can price every
 * entry it gets back.
 */
export function admissibleNodeIds(node: EconomicNode, slot: NodeSlot, byId: ReadonlyMap<string, EconomicNode>): readonly string[] {
  if (slot.accepts.length > 0) {
    const wanted = new Set(slot.accepts);
    const out: string[] = [];
    for (const candidate of byId.values()) if (wanted.has(candidate.id) && candidate.id !== node.id) out.push(candidate.id);
    return out;
  }
  const out: string[] = [];
  for (const candidate of byId.values()) if (candidate.role === slot.role && candidate.id !== node.id) out.push(candidate.id);
  return out;
}

/**
 * One line of a node's default recipe: the slot, the node its default names,
 * the quantity, and whether an unfillable slot stops the line.
 *
 * `blocking` carries exactly what the old `substitutable: false` meant, so a
 * reader that walked `consumes` and read `!substitutable` reads `blocking` here
 * and behaves identically on the default recipe.
 */
export interface DefaultInput {
  readonly slotId: string;
  readonly nodeId: string;
  readonly qtyPerUnit: number;
  readonly blocking: boolean;
}

/**
 * The default recipe: every slot whose default is a node, in slot order. A slot
 * whose default is empty (an optional delivery device, an evaluation nobody
 * ordered) is not part of it. This is what the bill-of-materials bands are
 * judged on and what the map draws before a line is composed.
 */
export function defaultInputsOf(node: EconomicNode): readonly DefaultInput[] {
  const out: DefaultInput[] = [];
  for (const slot of node.slots) {
    if (slot.defaultNodeId === null) continue;
    out.push({ slotId: slot.id, nodeId: slot.defaultNodeId, qtyPerUnit: slot.qtyPerUnit, blocking: slot.blocking });
  }
  return out;
}

/**
 * The customer type carrying the most weight in a node's market; ties break
 * in `PRODUCT_SEGMENTS` order. The one reading a node's market collapses to
 * where a single segment is wanted — a launch's default segment, a data weight.
 */
export function primaryCustomerOf(node: EconomicNode): ProductSegment {
  let best: ProductSegment = 'enterprise';
  let bestWeight = -1;
  for (const segment of PRODUCT_SEGMENTS) {
    const weight = node.market.customers[segment] ?? 0;
    if (weight > bestWeight) {
      best = segment;
      bestWeight = weight;
    }
  }
  return best;
}

/* -------------------------------------------------------------------------- */
/*  Graph integrity                                                            */
/* -------------------------------------------------------------------------- */

/**
 * (1) Every id a node references resolves to a node in the same table, no node
 * references itself, and every id carries a prefix legal for its tier.
 */
export function nodeReferencesResolve(nodes: readonly EconomicNode[]): boolean {
  const byId = indexNodes(nodes);
  for (const node of nodes) {
    if (!nodeIdPrefixSuitsTier(node.id, node.tier)) return false;
    for (const id of node.requires) {
      if (id === node.id || !byId.has(id)) return false;
    }
    for (const slot of node.slots) {
      for (const id of slot.accepts) if (id === node.id || !byId.has(id)) return false;
      if (slot.defaultNodeId !== null && (slot.defaultNodeId === node.id || !byId.has(slot.defaultNodeId))) return false;
    }
  }
  return true;
}

/**
 * (2) Every node of a slot's role sits strictly below the slot's owner, and the
 * implicit energy edge obeys the same rule: a node with `energyMwhPerUnit > 0`
 * draws `res_grid_power` at tier 1, so it must itself sit at tier 2 or
 * above. Checked at the role level, not the default: a player may fill a slot
 * with any node of the role.
 */
export function slotRolesStrictlyDecreaseTier(nodes: readonly EconomicNode[]): boolean {
  for (const node of nodes) {
    if (node.energyMwhPerUnit > 0 && node.tier <= GRID_POWER_TIER) return false;
    for (const slot of node.slots) {
      for (const candidate of nodes) {
        if (candidate.role !== slot.role) continue;
        if (candidate.tier >= node.tier) return false;
      }
    }
  }
  return true;
}

/**
 * (3) `requires` is acyclic and never points upward in tier. Same-tier edges
 * are legal, so acyclicity is proved by a depth-first walk rather than implied
 * by the tier ordering as it is for slots.
 */
export function requiresIsAcyclicAndNonIncreasing(nodes: readonly EconomicNode[]): boolean {
  const byId = indexNodes(nodes);
  const state = new Map<string, 'visiting' | 'done'>();

  const visit = (id: string): boolean => {
    const mark = state.get(id);
    if (mark === 'done') return true;
    if (mark === 'visiting') return false;
    state.set(id, 'visiting');
    const node = byId.get(id);
    if (node !== undefined) {
      for (const required of node.requires) {
        const upstream = byId.get(required);
        if (upstream === undefined) return false;
        if (upstream.tier > node.tier) return false;
        if (!visit(required)) return false;
      }
    }
    state.set(id, 'done');
    return true;
  };

  for (const node of nodes) if (!visit(node.id)) return false;
  return true;
}

/**
 * (4) No orphan sector and no isolated node. Every sector carries nodes; every
 * sector is wired to at least one other sector by a slot or `requires` edge in
 * either direction; and every node above tier 0 has at least one edge touching
 * it. A slot links its owner to **every** admissible node, not only the default:
 * a harness nobody's default names is still wired to every app that could run
 * on it. World 2's catalogue was ten weakly-connected components with eight
 * fully isolated rows, which is the shape this refuses.
 */
export function sectorsAreConnected(nodes: readonly EconomicNode[], sectors: readonly Sector[]): boolean {
  const byId = indexNodes(nodes);
  const crossing = new Map<Sector, Set<Sector>>();
  const touched = new Set<string>();
  for (const sector of sectors) crossing.set(sector, new Set<Sector>());

  const link = (from: EconomicNode, toId: string): void => {
    const to = byId.get(toId);
    if (to === undefined) return;
    touched.add(from.id);
    touched.add(to.id);
    if (from.sector === to.sector) return;
    crossing.get(from.sector)?.add(to.sector);
    crossing.get(to.sector)?.add(from.sector);
  };

  for (const node of nodes) {
    for (const slot of node.slots) for (const id of admissibleNodeIds(node, slot, byId)) link(node, id);
    for (const required of node.requires) link(node, required);
    // The implicit energy edge is a real edge for connectivity too, and so is
    // the compute bucket: an AI line's accelerators come from somebody's fab.
    if (node.energyMwhPerUnit > 0) link(node, GRID_POWER_NODE_ID);
    if (node.capacityKind === 'compute' && node.capacityDrawPerUnit > 0) link(node, COMPUTE_CAPACITY_NODE_ID);
  }

  for (const sector of sectors) {
    const inSector = nodes.filter((node) => node.sector === sector);
    if (inSector.length === 0) return false;
    if ((crossing.get(sector)?.size ?? 0) === 0) return false;
  }
  for (const node of nodes) {
    if (node.tier === 0) continue;
    if (!touched.has(node.id)) return false;
  }
  return true;
}

/** True when every weight is finite and non-negative and at least one is positive. */
function weightsHavePositiveEntry(weights: Readonly<Record<string, number | undefined>>): boolean {
  let positive = false;
  for (const value of Object.values(weights)) {
    if (value === undefined) continue;
    if (!Number.isFinite(value) || value < 0) return false;
    if (value > 0) positive = true;
  }
  return positive;
}

/**
 * Every defect in one pass, as player-readable lines. Empty means the table is
 * sound. The predicates above answer yes or no; this says what is wrong, which
 * is what a failing test needs to print.
 *
 * The slot rules, in the order they are checked per slot:
 *
 * 1. every `accepts` id exists, is not the owner, and carries the slot's role;
 * 2. the default is admissible: an existing node of the role, inside `accepts`
 *    when `accepts` narrows;
 * 3. `defaultNodeId === null` only on a slot that is not required;
 * 4. `blocking` only on a required slot;
 * 5. slot ids are unique within the node;
 * 6. **every** node of the slot's role sits strictly below the owner's tier;
 * 7. every admissible node of the slot shares one `unitLabel`, so `qtyPerUnit`
 *    means the same thing whichever node fills it.
 */
export function economicGraphDefects(nodes: readonly EconomicNode[], sectors: readonly Sector[]): readonly string[] {
  const defects: string[] = [];
  const byId = indexNodes(nodes);
  const seen = new Set<string>();

  for (const node of nodes) {
    if (seen.has(node.id)) defects.push(`${node.id}: duplicate id`);
    seen.add(node.id);
    if (!nodeIdPrefixSuitsTier(node.id, node.tier)) defects.push(`${node.id}: id prefix does not suit tier ${node.tier}`);
    if (node.saleKind === 'unit' && node.lifetimeQuarters === null) defects.push(`${node.id}: unit sale with no lifetimeQuarters`);
    if (node.saleKind !== 'unit' && node.lifetimeQuarters !== null) defects.push(`${node.id}: lifetimeQuarters set on a ${node.saleKind} node`);
    if (node.saleKind === 'contract' && node.contractQuarters === null) defects.push(`${node.id}: contract sale with no contractQuarters`);
    if (node.saleKind !== 'contract' && node.contractQuarters !== null) defects.push(`${node.id}: contractQuarters set on a ${node.saleKind} node`);
    if (!weightsHavePositiveEntry(node.market.customers)) defects.push(`${node.id}: market names no customer type`);
    if (!weightsHavePositiveEntry(node.market.industries)) defects.push(`${node.id}: market names no industry`);
    if (node.endDemandBaseUnits <= 0) defects.push(`${node.id}: no end demand`);
    if (node.energyMwhPerUnit > 0 && node.tier <= GRID_POWER_TIER) defects.push(`${node.id}: tier ${node.tier} cannot consume grid power`);
    if (node.churnBand.min > node.churnBand.max) defects.push(`${node.id}: churn band is inverted`);
    if (node.researchCostRangeUsd[0] > node.researchCostRangeUsd[1]) defects.push(`${node.id}: research cost range is inverted`);
    if (node.estimatedWindow[0] > node.estimatedWindow[1]) defects.push(`${node.id}: estimated window is inverted`);
    if (!node.researchable && node.requires.length > 0) defects.push(`${node.id}: unresearchable node cannot require anything`);

    for (const id of node.requires) {
      const upstream = byId.get(id);
      if (id === node.id) defects.push(`${node.id}: requires itself`);
      else if (upstream === undefined) defects.push(`${node.id}: requires unknown node ${id}`);
      else if (upstream.tier > node.tier) defects.push(`${node.id}: requires ${id} at a higher tier`);
    }

    const slotIds = new Set<string>();
    for (const slot of node.slots) {
      const where = `${node.id}.${slot.id}`;
      if (slotIds.has(slot.id)) defects.push(`${where}: duplicate slot id`);
      slotIds.add(slot.id);

      for (const id of slot.accepts) {
        const accepted = byId.get(id);
        if (id === node.id) defects.push(`${where}: accepts itself`);
        else if (accepted === undefined) defects.push(`${where}: accepts unknown node ${id}`);
        else if (accepted.role !== slot.role) defects.push(`${where}: accepts ${id}, whose role ${accepted.role} is not ${slot.role}`);
      }

      const admissible = admissibleNodeIds(node, slot, byId);
      if (admissible.length === 0) defects.push(`${where}: no node can fill it`);
      if (slot.defaultNodeId === null) {
        if (slot.required) defects.push(`${where}: required slot with no default`);
      } else if (!admissible.includes(slot.defaultNodeId)) {
        defects.push(`${where}: default ${slot.defaultNodeId} is not admissible`);
      }
      if (slot.blocking && !slot.required) defects.push(`${where}: blocking slot that is not required`);

      for (const candidate of nodes) {
        if (candidate.role !== slot.role) continue;
        if (candidate.tier >= node.tier) defects.push(`${where}: role ${slot.role} carries ${candidate.id} at tier ${candidate.tier}, not below ${node.tier}`);
      }

      const units = new Set(admissible.map((id) => byId.get(id)?.unitLabel ?? ''));
      if (units.size > 1) defects.push(`${where}: admissible nodes disagree on unit (${[...units].join(', ')})`);
    }
  }

  if (!requiresIsAcyclicAndNonIncreasing(nodes)) defects.push('requires graph contains a cycle');
  if (!sectorsAreConnected(nodes, sectors)) defects.push('a sector is orphaned, or a node above tier 0 has no edge at all');
  if (byId.get(GRID_POWER_NODE_ID) === undefined) defects.push(`${GRID_POWER_NODE_ID} is missing`);
  else if (byId.get(GRID_POWER_NODE_ID)?.tier !== GRID_POWER_TIER) defects.push(`${GRID_POWER_NODE_ID} is not at tier ${GRID_POWER_TIER}`);

  return defects;
}

/* -------------------------------------------------------------------------- */
/*  Bill of materials                                                          */
/* -------------------------------------------------------------------------- */

/**
 * What one unit's default recipe costs at base prices, energy included.
 *
 * This is the *catalogue* roll-up: it uses `basePriceUsd` rather than the live
 * market price, so it is a pure function of the table and is what the contract
 * tests judge the bill of materials band against. The engine's own roll-up in
 * `@frontier/simulation` is the same arithmetic against the session's stored
 * node prices and the line's own fills, memoised per resolution.
 */
export function billOfMaterialsUsd(node: EconomicNode, byId: ReadonlyMap<string, EconomicNode>): number {
  let total = 0;
  for (const input of defaultInputsOf(node)) {
    const upstream = byId.get(input.nodeId);
    if (upstream === undefined) continue;
    total += input.qtyPerUnit * upstream.basePriceUsd;
  }
  if (node.energyMwhPerUnit > 0) {
    total += node.energyMwhPerUnit * (byId.get(GRID_POWER_NODE_ID)?.basePriceUsd ?? 0);
  }
  return total;
}

/** The bill of materials as a share of the node's own balance price. */
export function billOfMaterialsShare(node: EconomicNode, byId: ReadonlyMap<string, EconomicNode>): number {
  if (node.basePriceUsd <= 0) return 0;
  return billOfMaterialsUsd(node, byId) / node.basePriceUsd;
}

/**
 * The band a manufactured end product's bill of materials must land inside.
 *
 * Applied to `sys_` nodes at tier 4 and above sold by the unit: a thing
 * somebody assembles from bought parts. Not applied to materials and
 * components, whose value is fab and plant capacity rather than purchased
 * content, and not to `svc_` or `app_` nodes, whose cost is labour, capacity
 * and energy — those are held under `BOM_CAP_SERVICE` instead.
 */
export const BOM_BAND_HARDWARE: readonly [number, number] = [0.4, 0.75];

/** A service or platform may not spend more than this share of its price on inputs. */
export const BOM_CAP_SERVICE = 0.75;

/** True when this node is one the hardware bill-of-materials band applies to. */
export function bomBandApplies(node: EconomicNode): boolean {
  return node.saleKind === 'unit' && node.tier >= 4 && node.id.startsWith('sys_');
}

/** True when this node is a service or platform, held under `BOM_CAP_SERVICE`. */
export function bomCapApplies(node: EconomicNode): boolean {
  return node.id.startsWith('svc_') || node.id.startsWith('app_');
}

/* -------------------------------------------------------------------------- */
/*  The node price index                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Every node carries one price per quarter, held as a whole-number index around
 * a baseline of 100 and multiplied into the node's own `basePriceUsd`.
 *
 * The shape is `sectorPrices`' shape on purpose — same baseline, same clamped
 * imbalance, same whole numbers — because two price curves that behave
 * differently is how world 2 ended up running three economies that never
 * reconciled. What is new is the *inertia*: a sector price is recomputed from
 * scratch every quarter, while a node price walks a share of the way towards
 * its target, so a shock prices in over about three quarters instead of
 * arriving whole.
 */
export const NODE_PRICE_BASELINE = 100;

/**
 * How far a total shortage or a total glut may move a price, as a fraction.
 *
 * At 0.6 a 2:1 shortage prices a chip or a megawatt-hour 60% above balance:
 * a genuine crisis, and still a number a founder can hold in their head on a
 * phone. More than that stops reading as a market and starts reading as a bug.
 */
export const NODE_PRICE_SWING = 0.6;

/**
 * The share of the gap to the target a price closes each quarter.
 *
 * At 0.35 about two-thirds of a shock is in the price after three quarters and
 * 90% after six. Inertia is the point: a price a player cannot plan against is
 * not a price, it is noise.
 */
export const NODE_PRICE_ADJUST = 0.35;

/** Hard bounds on the index. Nothing in the world trades at four times balance. */
export const NODE_PRICE_BOUNDS = { min: 30, max: 250 } as const;

/** Clamp into `[min, max]`; non-finite collapses to `min`. Local so this module stays dependency-free. */
function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return value < min ? min : value > max ? max : value;
}

/**
 * The stateless half of the rule: an imbalance in `[-1, +1]`.
 *
 * `(demand - supply) / max(1, min(demand, supply))` reaches ±1 at a 2:1 ratio
 * and is clamped there. The floor of 1 is what makes a node nobody supplies at
 * all answer +1 rather than a division by zero.
 */
export function nodeImbalance(demandUnits: number, supplyUnits: number): number {
  const floor = Math.max(1, Math.min(demandUnits, supplyUnits));
  return clampNumber((demandUnits - supplyUnits) / floor, -1, 1);
}

/**
 * The index this imbalance is pulling towards, before inertia and before
 * bounds. `worldShifter` is the one place a world variable may touch a price;
 * everywhere else it is exactly 1.
 */
export function nodeTargetIndex(imbalance: number, worldShifter: number): number {
  const shifter = Number.isFinite(worldShifter) && worldShifter > 0 ? worldShifter : 1;
  return NODE_PRICE_BASELINE * (1 + NODE_PRICE_SWING * clampNumber(imbalance, -1, 1)) * shifter;
}

/** One quarter of movement towards a target: whole numbers, always inside the bounds. */
export function nextNodePriceIndex(current: number, target: number): number {
  const from = clampNumber(Math.round(current), NODE_PRICE_BOUNDS.min, NODE_PRICE_BOUNDS.max);
  const moved = Math.round(from + NODE_PRICE_ADJUST * (target - from));
  return clampNumber(moved, NODE_PRICE_BOUNDS.min, NODE_PRICE_BOUNDS.max);
}

/** Anything carrying the stored node price map. Structural, so no module has to import the session. */
export interface NodePricedState {
  readonly nodePrices?: Readonly<Record<string, number>> | undefined;
}

/**
 * A node's stored price index, defaulting to the baseline.
 *
 * The one accessor the engine and the screens read a node price through, so a
 * session that has never priced its nodes — every world-1 and world-2 save, and
 * a world-3 save opened before its first resolution — reads exactly neutral
 * rather than undefined.
 */
export function nodePriceIndex(state: NodePricedState, nodeId: string): number {
  const value = state.nodePrices?.[nodeId];
  return value === undefined || !Number.isFinite(value) ? NODE_PRICE_BASELINE : Math.round(value);
}

/** What one unit of this node costs on the open market this quarter, in whole dollars. */
export function nodePriceUsd(node: EconomicNode, index: number): number {
  return Math.max(0, Math.round((node.basePriceUsd * clampNumber(index, NODE_PRICE_BOUNDS.min, NODE_PRICE_BOUNDS.max)) / NODE_PRICE_BASELINE));
}

/* -------------------------------------------------------------------------- */
/*  The unit cost roll-up                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Where one line of a unit cost came from.
 *
 * - `make`: the company produces the input itself, transferred at its own cost.
 * - `buy`: a named supplier with live terms, at their ask.
 * - `market`: nobody named, bought on the open market at a premium.
 * - `conversion`: not an input at all — power, labour, capacity, support or a
 *   licence royalty.
 */
export const UNIT_COST_SOURCE_KINDS = ['make', 'buy', 'market', 'conversion'] as const;
export type UnitCostSourceKind = (typeof UNIT_COST_SOURCE_KINDS)[number];

/**
 * One line of a unit cost, in the shape a phone can render as a row.
 *
 * `amountUsd` is `unitsPerUnit × unitPriceUsd` for every line, conversion lines
 * included, so the column arithmetic on screen is the arithmetic the engine
 * did. Never persisted in session state: derived every time it is asked for.
 */
export interface UnitCostLine {
  /** Stable key: `slot:${slotId}` for an input, or one of `power`, `labour`, `capacity`, `support`, `licence:${nodeId}`. */
  readonly key: string;
  /** The slot this row fills, on an input row. Absent on a conversion row. */
  readonly slotId?: string;
  /** The node in that slot, or null when the slot is left empty. Absent on a conversion row. */
  readonly nodeId?: string | null;
  /** What the row says on screen, e.g. "Wafer, 300mm" or "Power". */
  readonly label: string;
  readonly unitsPerUnit: number;
  readonly unitPriceUsd: number;
  readonly amountUsd: number;
  /** The counterparty this line is bought from, or null for market and conversion lines. */
  readonly sourceCompanyId: string | null;
  readonly sourceKind: UnitCostSourceKind;
}

/**
 * One company's live line on one node: it produces that node and sells it.
 *
 * The read model the market and the roll-up both walk, so neither has to know
 * how a line is stored. World 3 keys a product on `Product.nodeId`; a product
 * without one is not a node line and is not in this index.
 */
export interface NodeLineRef {
  readonly companyId: string;
  readonly productId: string;
  readonly nodeId: string;
  /**
   * Units this line sold in the quarter that has already closed.
   *
   * Derived demand reads this rather than this quarter's output, which removes
   * the fixed point from the market and makes it one linear pass. It is also
   * how ordering works: a buyer places next quarter's orders against the run
   * rate it can actually see.
   */
  readonly unitsSoldLastQuarter: number;
  /** What this line charges its own customers, before any published supply terms. */
  readonly listPriceUsd: number;
  /**
   * Durable units of this line still in service, for a unit-sale node.
   *
   * One lifetime's worth of it retires every quarter, and that retirement is
   * next quarter's replacement demand: an ageing fleet creates its own repeat
   * business. Absent on a line that is not a durable good, and on every line
   * built before the field existed, which both read as zero.
   */
  readonly installedBase?: number;
}

/**
 * What one unit of one company's line costs to make this quarter.
 *
 * `unitCostUsd` is the sum of `lines[].amountUsd` exactly — not a second
 * calculation that agrees with it approximately — which is what lets the profit
 * and loss book this number as cost of goods sold and lets the screen explain
 * it without a reconciling difference.
 */
export interface UnitCostResult {
  readonly nodeId: string;
  readonly unitCostUsd: number;
  readonly lines: readonly UnitCostLine[];
  /** Whole percent of the input bill this company makes rather than buys. */
  readonly madeInHouseSharePct: number;
  /** Blocking inputs with no supplier and no producer anywhere: the line ships nothing until one exists. */
  readonly blockedInputNodeIds: readonly string[];
}

/**
 * The memo table for one quarter's roll-up, carried on `ResolverContext`.
 *
 * Per resolution, never module-level: a cache that outlived a resolution would
 * leak one save's prices into another's and break replay. Screens create and
 * discard their own.
 */
export interface NodeCostCache {
  /** Keyed `companyId|nodeId`. */
  readonly units: Map<string, UnitCostResult>;
  /** Keyed `companyId|capacityKind`: what one unit of that bucket costs its owner for a quarter. */
  readonly capacityRates: Map<string, number>;
  /** Every live line in the world, keyed by the node it sells. Indexed once per resolution. */
  readonly linesByNode: Map<string, readonly NodeLineRef[]>;
  /** The same lines keyed by the company that runs them. */
  readonly linesByCompany: Map<string, readonly NodeLineRef[]>;
  /**
   * Every node some live company owns or licences, whether or not anybody runs
   * a line on it today.
   *
   * The difference between "nobody is making this right now" and "nobody in the
   * world can make this at all". The first is a price — the market prices a
   * node with no producer at the top of its band and the open market sells it
   * dearly — and only the second blocks a line.
   */
  readonly ownedNodeIds: ReadonlySet<string>;
}
