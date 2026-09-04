/**
 * @frontier/contracts — company.ts
 *
 * Companies are the operating unit of the game: products, people, compute,
 * offices, a profit and loss account and a balance sheet that must reconcile
 * before any quarter commits.
 *
 * A company is not the player. The player controls a *character*, who may or may
 * not be the CEO, and may or may not own a controlling stake. `controllerPlayerId`
 * records who currently directs company actions; ownership lives in `ownership.ts`
 * and executive control lives in `governance.ts`. A board can separate the two at
 * any time, and the campaign continues.
 */

import { z } from 'zod';
import { QuarterIndexSchema, intCount, percent100, rateFraction, score100, signedUsd, unitInterval, usd } from './ids';
import { DEFAULT_REGION, DEFAULT_SECTOR, RegionSchema, SectorSchema } from './sectors';

/* -------------------------------------------------------------------------- */
/*  Enumerations                                                               */
/* -------------------------------------------------------------------------- */

export const COMPANY_ARCHETYPES = [
  'frontier_lab',
  'enterprise_ai',
  'consumer_ai',
  'infrastructure',
  'chip_maker',
  'cloud',
  'data',
  'defence_ai',
] as const;

export const CompanyArchetypeSchema = z
  .enum(COMPANY_ARCHETYPES)
  .describe(
    'What kind of company this is. frontier_lab trains state-of-the-art models and burns compute; enterprise_ai sells seats and services to businesses; consumer_ai sells to the public; infrastructure builds datacentres and platforms; chip_maker designs or fabricates accelerators; cloud rents capacity; data licenses and curates corpora; defence_ai serves government and security customers.',
  );
export type CompanyArchetype = z.infer<typeof CompanyArchetypeSchema>;

export const COMPANY_TIERS = ['major', 'significant', 'background'] as const;

export const CompanyTierSchema = z
  .enum(COMPANY_TIERS)
  .describe(
    'Simulation fidelity tier. "major" companies (4-10 per session) receive full LLM strategic planning each quarter. "significant" companies (20-50) run rule-based strategy with occasional LLM deliberation. "background" companies (hundreds) are pure deterministic archetype AI and are only promoted when they become strategically relevant, for example when a player considers acquiring one.',
  );
export type CompanyTier = z.infer<typeof CompanyTierSchema>;

export const COMPANY_POSTURES = [
  'aggressive_growth',
  'balanced',
  'efficiency',
  'research_first',
  'land_grab',
  'consolidation',
  'defensive',
  'survival',
] as const;

export const CompanyPostureSchema = z
  .enum(COMPANY_POSTURES)
  .describe(
    'The strategic stance driving this company\'s quarterly decisions. aggressive_growth spends ahead of revenue; efficiency protects margin; research_first prioritises the frontier over near-term product; land_grab buys market share with price; consolidation acquires; defensive protects existing accounts; survival preserves cash.',
  );
export type CompanyPosture = z.infer<typeof CompanyPostureSchema>;

export const PRODUCT_SEGMENTS = ['consumer', 'enterprise', 'developer_api', 'government'] as const;

export const ProductSegmentSchema = z
  .enum(PRODUCT_SEGMENTS)
  .describe('Which market a product sells into. Each segment has its own demand curve, price sensitivity, churn behaviour and reputation input.');
export type ProductSegment = z.infer<typeof ProductSegmentSchema>;

/**
 * What kind of physical or virtual capacity a product category is served from.
 * "compute" is accelerator-equivalents, exactly as world version 1 always
 * modelled it. "plant", "fleet" and "grid" are world-2 capacity kinds a company
 * builds with `invest_capacity`, held in `Company.capacity`. "none" is
 * uncapacitated: a line whose growth is never bounded by anything the company
 * owns (a marketplace, a subscription app).
 */
export const CAPACITY_KINDS = ['compute', 'plant', 'fleet', 'grid', 'none'] as const;

export const CapacityKindSchema = z
  .enum(CAPACITY_KINDS)
  .describe(
    'The kind of capacity a product category is served from. "compute" is accelerator-equivalents. "plant", "fleet" and "grid" are built by investing in Company.capacity. "none" is never capacity-constrained.',
  );
export type CapacityKind = z.infer<typeof CapacityKindSchema>;

export const STAFF_ROLES = ['engineers', 'researchers', 'sales', 'ops', 'execs'] as const;

export const StaffRoleSchema = z
  .enum(STAFF_ROLES)
  .describe('Employee category. engineers build product, researchers advance the frontier, sales converts enterprise demand, ops runs infrastructure and compliance, execs are the leadership layer.');
export type StaffRole = z.infer<typeof StaffRoleSchema>;

export const COMP_BANDS = ['below_market', 'market', 'above_market', 'top_of_market'] as const;

export const CompBandSchema = z
  .enum(COMP_BANDS)
  .describe('Compensation band for a hiring action. Higher bands fill roles faster and raise retention, at proportionally higher payroll and with a knock-on effect on existing staff expectations.');
export type CompBand = z.infer<typeof CompBandSchema>;

export const EXECUTIVE_ROLES = ['ceo', 'cto', 'cfo', 'coo', 'chief_scientist', 'chief_revenue', 'general_counsel', 'chief_security'] as const;

export const ExecutiveRoleSchema = z.enum(EXECUTIVE_ROLES).describe('A C-suite post. Appointments are usually board matters.');
export type ExecutiveRole = z.infer<typeof ExecutiveRoleSchema>;

/* -------------------------------------------------------------------------- */
/*  Products                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * One resolved input choice on a product: which upstream category
 * (`ProductCategoryInput.categoryId` in `productCategories.ts`), bought from
 * which company and which of that company's products.
 *
 * `supplierCompanyId` and `supplierProductId` are required-but-nullable rather
 * than optional throughout — this shape backs both `Product.supply` (state)
 * and the `choose_supplier` action (LLM-facing), and an LLM-facing schema must
 * emit every key. Null means the open market for an input that is not
 * `required`, or a deliberate refusal to fill a `required` one — see the
 * `supply` field's own doc comment for exactly how that resolves.
 */
export const ProductSupplyLineSchema = z
  .object({
    inputCategoryId: z.string().min(1).describe('The upstream category (PRODUCT_CATEGORIES) this line names a supplier for.'),
    supplierCompanyId: z.string().min(1).nullable().describe('The company this input is bought from, or null for the open market or a deliberately unfilled required input.'),
    supplierProductId: z.string().min(1).nullable().describe('The specific supplying product, or null exactly when supplierCompanyId is null.'),
    cutOffNoticeQuarter: QuarterIndexSchema.nullable().describe(
      'Set by the engine when the supplier has announced it is closing this line to this buyer: the line drops to unsupplied at the start of this quarter, one quarter after the notice. Null when nothing is pending. Never set by an action — a buyer cannot pre-empt its own cut-off.',
    ),
  })
  .describe('One resolved input choice on a product.');
export type ProductSupplyLine = z.infer<typeof ProductSupplyLineSchema>;

/**
 * Published terms for a product line as somebody else's input — set with
 * `set_supply_terms`. Publishing a public API, in the owner's own words, is
 * `openToAll: true`.
 */
export const SupplyTermsSchema = z
  .object({
    openToAll: z.boolean().describe('True when any company may build on this line at its published price — a public API.'),
    pricePerUnitUsd: usd('Price this line charges, matched against its category\'s referencePriceUsd to price every buyer\'s draw. A price above reference costs every customer margin; a price below wins share.'),
    exclusiveCustomerIds: z.array(z.string()).max(20).describe('Companies allowed to buy when openToAll is false. Ignored when openToAll is true.'),
    blockedCustomerIds: z.array(z.string()).max(50).describe('Companies refused regardless of openToAll — a deliberate cut-off, which takes effect one quarter after it is set.'),
  })
  .describe('Published supply terms for a canSupply product line: whether, and at what price, other companies may build on it.');
export type SupplyTerms = z.infer<typeof SupplyTermsSchema>;

export const ProductSchema = z
  .object({
    id: z.string().min(1).describe('Product id, e.g. "prd_enterprise_agent".'),
    name: z.string().min(1).max(80).describe('Product name as customers see it.'),
    segment: ProductSegmentSchema,
    /*
     * The industry line this product is: PRODUCT_CATEGORIES in
     * productCategories.ts is the catalogue this id names an entry of. Absent
     * rather than defaulted, and load-bearing: a defaulted field would
     * materialise on every world-version-1 product the moment the schema
     * parsed one, and the frozen world would stop hashing to the value it has
     * always hashed to. Absent means "derive it" — `defaultCategoryFor(sector,
     * segment)` in productCategories.ts does that deterministically from the
     * product's own sector and segment — and every reader calls `categoryOf`
     * rather than reading this field bare, so the derivation happens on read
     * and is never written back into a world-version-1 product. World version
     * 2 always writes a real id here at launch.
     */
    categoryId: z.string().min(1).nullable().optional().describe(
      'Id into PRODUCT_CATEGORIES (productCategories.ts): the industry line this product is, e.g. "ai_frontier_models" or "manufacturing_batteries". Absent on a world-version-1 product or a save from before this field existed; call categoryOf/defaultCategoryFor rather than reading it directly. Never absent on a product launched in world version 2.',
    ),
    /*
     * World version 3: the node of the one economic table this line produces
     * and sells. Optional for exactly the reason `categoryId` is — a defaulted
     * field would materialise on every world-1 and world-2 product the moment
     * the schema parsed one, and both frozen worlds would stop hashing to what
     * they have always hashed to.
     *
     * A line with a node is the world-3 unit of production: its unit cost is
     * that node's inputs rolled up through the stored node prices, and its
     * price is judged against that node's own market price rather than against
     * the mean price of every product in its buyer segment across all six
     * sectors. A product without one is a world-2 product and is priced the
     * world-2 way.
     */
    nodeId: z
      .string()
      .min(1)
      .nullable()
      .optional()
      .describe('Id into ECONOMIC_NODES (nodeGraph.ts): the node this line produces and sells. Absent on every world-1 and world-2 product; always set on a world-3 line.'),
    pricePerSeat: usd('List price per seat per quarter. For developer_api products, price per million billed units.'),
    activeCustomers: intCount('Paying seats or accounts at the end of the quarter.'),
    churnQuarterly: unitInterval('Fraction of customers lost this quarter. 0.05 is healthy enterprise, 0.20 is a leaking consumer product.'),
    growthQuarterly: z
      .number()
      .min(-1)
      .max(5)
      .describe('Fractional change in active customers this quarter before churn. 0.13 means 13% gross additions. Range: -1..5.'),
    grossMarginPct: unitInterval('Gross margin as a fraction of revenue, after inference compute and support cost.'),
    computeIntensity: unitInterval('How much serving compute one unit of this product consumes, relative to the archetype baseline of 0.5. Rises with model quality and falls with efficiency research.'),
    qualityScore: unitInterval('How good the product is relative to the market frontier. Drives win rates, pricing power and churn.'),
    launchedQuarter: QuarterIndexSchema.describe('Quarter the product went live.'),
    isActive: z.boolean().describe('False once the product has been sunset. Sunset products keep their history for financial comparatives.'),
    /*
     * Stage 2b — the supply chain. Optional for exactly the reason `categoryId`
     * is: a world-version-1 product, and every world-2 product launched before
     * this field existed, carries neither key at all, so the frozen world (and
     * every product already sitting in a live save) keeps hashing to what it
     * always hashed to. Absent is read as "nothing chosen yet" everywhere —
     * `resolveSupplyLine` in `@frontier/simulation` treats a missing `supply`
     * entry for a category exactly like an empty array: the input sits on the
     * open market, which costs nothing beyond what its category's own margin
     * already assumes and moves no counterparty's revenue. Only an
     * *explicit* null supplier on a `required` input (a
     * deliberate `choose_supplier`, or a supplier that cut this buyer off)
     * books zero units — so this field can never retroactively break a product
     * that never touched it. World version 2 always writes a real (possibly
     * empty) array at launch.
     */
    supply: z
      .array(ProductSupplyLineSchema)
      .max(6)
      .optional()
      .describe(
        'Resolved input choices, one entry per PRODUCT_CATEGORIES input this product has an opinion about. A category input with no entry here is bought on the open market. Absent on a world-version-1 product or one launched before supply chains existed.',
      ),
    supplyTerms: SupplyTermsSchema.nullable()
      .optional()
      .describe(
        'Published terms for this line as somebody else\'s input, set with set_supply_terms. Null (or absent) means not published: this line cannot be anyone\'s supplier yet, whatever its category\'s canSupply says. Only meaningful when the category canSupply is true. Absent on a world-version-1 product.',
      ),

    /*
     * World version 3 — the node line. Every field below is optional for the
     * one reason every world-2 field above is: a defaulted key would
     * materialise on every world-1 and world-2 product the moment the schema
     * parsed one, and both frozen worlds would stop hashing to what they have
     * always hashed to. Absent is read as the neutral value everywhere.
     *
     * `unitsSoldQuarterly` is the quarter's *billed* units in every sale kind,
     * stamped by the demand phase, and is what the profit and loss, the filed
     * statement and every screen multiply by the price. Nothing recomputes it:
     * `activeCustomers x pricePerSeat` appeared in six places in world 2 and
     * disagreed with the income statement in at least two of them.
     */
    unitsSoldQuarterly: intCount(
      'Units billed this quarter, stamped by the demand phase: seats for a recurring line, shipments for a unit line, the serviced book for a contract line. Revenue is this times pricePerSeat, everywhere. Absent on a world-1 or world-2 product.',
    ).optional(),
    installedBase: intCount(
      'Durable units of a unit-sale line still in service. Grows by what shipped and decays by one lifetime\'s worth a quarter; the decay is next quarter\'s replacement demand. Absent outside world 3 and on lines that are not durable goods.',
    ).optional(),
    backlogUnits: intCount(
      'Orders this line could not fill, carried into next quarter\'s pool at BACKLOG_CARRY. Visible on purpose: unfilled orders are what make building capacity obviously worth doing. Absent outside world 3.',
    ).optional(),
    contractRemainingQuarters: z
      .number()
      .min(0)
      .max(80)
      .optional()
      .describe(
        'Quarters left on the book of a contract line, weighted by units. Falls by one a quarter; at zero the book has run off. Absent outside world 3 and on lines that are not sold as contracts.',
      ),
    contractBilledUsd: usd(
      'Cash billed in advance this quarter for contracts signed this quarter: units x price x contractQuarters. Stamped by the demand phase, turned into deferred revenue by the financial phase, and recognised a quarter at a time. Absent outside world 3.',
    ).optional(),
    unitCostUsd: usd(
      'What one unit of this line cost to make this quarter, rolled up through the node prices. The number the profit and loss books as cost of goods sold, not a cousin of it: grossMarginPct is 1 - unitCostUsd / pricePerSeat exactly. Absent outside world 3.',
    ).optional(),
    craftQuality: unitInterval(
      'How well this line is built, before the quality tier scales it. World 3\'s reading of qualityScore, which stays for world 1 and world 2. Absent outside world 3.',
    ).optional(),
    qualityTier: unitInterval(
      'One lever, both consequences: capacityDrawPerUnit and delivered quality both scale by (0.5 + qualityTier), so a higher tier buys quality and costs real unit cost. World 3\'s reading of computeIntensity, which stays for world 1 and world 2. Absent outside world 3.',
    ).optional(),
  })
  .describe('One commercial product line. Unit economics are resolved per product each quarter, then rolled up into the company P&L.');
export type Product = z.infer<typeof ProductSchema>;

/* -------------------------------------------------------------------------- */
/*  Employees, compute, offices                                                */
/* -------------------------------------------------------------------------- */

export const EmployeeBaseSchema = z
  .object({
    engineers: intCount('Product and platform engineers.'),
    researchers: intCount('Frontier researchers. The binding constraint on research throughput.'),
    sales: intCount('Enterprise and government sales staff.'),
    ops: intCount('Infrastructure, support, security and compliance staff.'),
    execs: intCount('Executive leadership headcount.'),
    avgComp: usd('Average fully loaded annual compensation per employee, in dollars.'),
    morale: score100('Company-wide morale. Falls with layoffs, controversial contracts and missed promises; rises with wins, equity appreciation and credible leadership.'),
    attrition: unitInterval('Fraction of staff who will leave next quarter at current morale and market compensation.'),
    openRoles: intCount('Roles currently being recruited for but not yet filled.'),
  })
  .describe('The people inside the company. Headcount by role, what they cost, how they feel and how fast they are leaving.');
export type EmployeeBase = z.infer<typeof EmployeeBaseSchema>;

/**
 * One accelerator order accepted this quarter and not yet paid for.
 *
 * Staged by the compute phase and consumed by the financial phase, which is the
 * only phase permitted to move cash. Written only from world version 2, and
 * always empty on a committed state: the financial phase clears it.
 */
export const AcceleratorPurchaseSchema = z
  .object({
    sellerCompanyId: z.string().nullable().describe('The manufacturer the units were bought from, or null when no seller could be resolved.'),
    units: intCount('Accelerators bought.'),
    unitPriceUsd: usd('Price cleared per unit.'),
    totalUsd: usd('Cash the financial phase will move into property, plant and equipment.'),
  })
  .describe('An accepted accelerator purchase awaiting settlement in the financial phase.');
export type AcceleratorPurchase = z.infer<typeof AcceleratorPurchaseSchema>;

export const ComputeHoldingsSchema = z
  .object({
    ownedAccelerators: intCount('Accelerators the company owns outright. Depreciating capital, immune to spot price swings.'),
    reservedAccelerators: intCount('Accelerator-equivalents held under multi-quarter reservation.'),
    reservationExpiryQuarter: QuarterIndexSchema.nullable().describe('Quarter the current reservation lapses, or null when nothing is reserved. Letting a reservation lapse into a shortage is a classic way to lose a session.'),
    cloudSpendQuarterly: usd('Quarterly spend on on-demand cloud capacity, in dollars. Flexible but exposed to spot price.'),
    computeUtilisation: unitInterval('Fraction of held capacity actually in use. Sustained low utilisation is wasted capital; sustained high utilisation blocks new training runs.'),
    trainingAllocation: unitInterval('Share of total capacity directed at training rather than serving. Inference gets the remainder.'),
    /*
     * Counterparties. Appended and optional, so a company recorded before
     * compute had sellers still parses and world version 1 — which has no
     * sellers — carries none of them and hashes exactly as it did.
     *
     * The factor rather than the price is stored so the charge still tracks the
     * world's spot and reserved indices: what the counterparty fixes is the
     * premium or discount its region and its own load produce, not the market.
     */
    cloudProviderCompanyId: z.string().nullable().optional().describe('The company selling this on-demand capacity, or null when it was bought at the index.'),
    cloudProviderFactor: z.number().min(0.1).max(3).optional().describe('That provider\'s price multiplier on the spot index, from its region and utilisation. Absent means 1.'),
    reservationProviderCompanyId: z.string().nullable().optional().describe('The company whose capacity is reserved, or null when it was reserved at the index.'),
    reservationProviderFactor: z.number().min(0.1).max(3).optional().describe('That provider\'s price multiplier on the reserved index. Absent means 1.'),
    pendingAcceleratorPurchases: z
      .array(AcceleratorPurchaseSchema)
      .max(8)
      .optional()
      .describe('Purchases accepted this quarter and awaiting settlement. Staged by the compute phase, cleared by the financial phase, so a committed state never carries any.'),
  })
  .describe('Compute the company controls, who it was procured from, and how it is allocated.');
export type ComputeHoldings = z.infer<typeof ComputeHoldingsSchema>;

/**
 * One capacity investment accepted this quarter and not yet settled.
 *
 * Staged by `invest_capacity`'s resolution in the product phase and consumed by
 * the financial phase, exactly the same two-phase contract
 * `AcceleratorPurchaseSchema` uses for owned accelerators: the compute (or
 * here, capacity) phase stages the order, the financial phase is the only phase
 * that moves cash, lands the capex in `ppe` and in the matching bucket on
 * `CapacityHoldings`, and depreciates it from there on like any other property.
 * World version 2 only, and always empty on a committed state.
 */
export const PendingCapacityInvestmentSchema = z
  .object({
    kind: CapacityKindSchema.exclude(['compute', 'none']),
    amountUsd: usd('Cash the financial phase will move into property, plant and equipment and into this capacity kind.'),
  })
  .describe('A capacity investment accepted this quarter, awaiting settlement in the financial phase.');
export type PendingCapacityInvestment = z.infer<typeof PendingCapacityInvestmentSchema>;

/**
 * Non-compute capacity a company has built with `invest_capacity`: plant for
 * manufacturing lines, fleet for logistics, grid for energy. Each bucket is
 * cash invested, not a physical unit count — the category catalogue's
 * `capacityYieldPerUnit` says how many customers a million dollars of it
 * serves, exactly as `SERVE_CUSTOMERS_PER_ACCELERATOR` says for compute.
 *
 * World version 2 only. Optional rather than defaulted for the reason every
 * other priced-economy field on `Company` is: a defaulted object would
 * materialise on every world-version-1 company the moment the schema parsed
 * one, and the frozen world would stop hashing to the value it has always
 * hashed to.
 */
export const CapacityHoldingsSchema = z
  .object({
    plantUsd: usd('Cash invested in manufacturing plant: fabs, packaging lines, machine tools.'),
    fleetUsd: usd('Cash invested in vehicle and vessel fleets: freight, last-mile, ports.'),
    gridUsd: usd('Cash invested in grid and storage infrastructure: transmission, batteries at grid scale.'),
    pendingInvestments: z
      .array(PendingCapacityInvestmentSchema)
      .max(8)
      .optional()
      .describe('Investments accepted this quarter and awaiting settlement. Staged by the product phase, cleared by the financial phase, so a committed state never carries any.'),
  })
  .describe('Non-compute capacity the company has built: plant, fleet and grid, each in cash invested.');
export type CapacityHoldings = z.infer<typeof CapacityHoldingsSchema>;

/** What a company gets when it has never invested in non-compute capacity. */
export const DEFAULT_CAPACITY_HOLDINGS: CapacityHoldings = { plantUsd: 0, fleetUsd: 0, gridUsd: 0 };

export const OfficeSchema = z
  .object({
    id: z.string().min(1),
    city: z.string().min(1).max(80).describe('City name, e.g. "Zurich".'),
    headcountCapacity: intCount('How many staff the site can hold.'),
    quarterlyCostUsd: usd('Quarterly occupancy cost.'),
    openedQuarter: QuarterIndexSchema,
    isHeadquarters: z.boolean(),
  })
  .describe('A physical site. Offices constrain headcount growth and add fixed cost.');
export type Office = z.infer<typeof OfficeSchema>;

/* -------------------------------------------------------------------------- */
/*  Financials                                                                 */
/* -------------------------------------------------------------------------- */

export const FinancialsSchema = z
  .object({
    revenueQuarterly: usd('Revenue recognised this quarter across all products and contracts.'),
    cogs: usd('Cost of goods sold: serving compute, support and delivery cost.'),
    payroll: usd('Total employment cost this quarter, including the loaded cost of open roles being filled.'),
    marketing: usd('Marketing, demand generation and developer relations spend this quarter.'),
    rdSpend: usd('Research and development spend this quarter, excluding compute booked to capex.'),
    capex: usd('Capital expenditure this quarter, principally owned accelerators and datacentre build.'),
    interestExpense: usd('Interest paid on outstanding debt this quarter.'),
    cash: signedUsd(
      'Cash and equivalents at the end of the quarter. May be negative: from world version 2 a company overdraws rather than having its instructions refused, is charged an overdraft rate on the balance, and is wound up after SOLVENCY_NEGATIVE_QUARTERS consecutive quarters below zero.',
    ),
    debt: usd('Total interest-bearing debt outstanding.'),
    quarterlyBurn: signedUsd('Net cash movement this quarter. Negative means the company consumed cash; positive means it generated cash.'),
    deferredRevenue: usd('Contracted revenue billed but not yet recognised, principally from government contracts.'),
    backlogUsd: usd('Contracted future revenue not yet billed. Government awards create backlog before they create revenue.'),
    /*
     * World version 3 only, and optional for the reason every world-3 field is:
     * a defaulted key would materialise on every world-1 and world-2 company
     * and move both frozen worlds' hashes.
     *
     * The capacity a company owns and did not use. The rationing rule bounds
     * what production can absorb at what the buckets actually cost, so the
     * remainder is a real charge with nothing to attach to: build a fab and
     * sell nothing and this is what it costs you. An operating expense, never a
     * cost of goods, so gross margin stays a per-unit truth.
     */
    idleCapacityUsd: usd('Capacity charge no production absorbed this quarter, booked as an operating expense. Absent outside world version 3.').optional(),
    dataCustodyUsd: usd(
      'What it cost this quarter to hold the customer data this company has collected: encryption, access logging, retention machinery and audit, scaled by how stringent privacy regulation is. An operating expense, never a cost of goods — holding an asset lawfully is not part of making a unit. Absent outside world version 3.',
    ).optional(),
  })
  .describe('The quarterly profit and loss and cash position. Every figure is in dollars for the quarter just resolved, not annualised.');
export type Financials = z.infer<typeof FinancialsSchema>;

export const BalanceSheetSchema = z
  .object({
    assets: z
      .object({
        cash: signedUsd('Cash and equivalents. Negative when the company is overdrawn; the solvency clock, not a floor, is what ends the company.'),
        ppe: usd('Property, plant and equipment, net of depreciation. Principally accelerators and datacentre build.'),
        goodwill: usd('Goodwill recognised on acquisitions.'),
        investments: usd('Holdings in other companies\' securities, at carrying value.'),
        receivables: usd('Amounts invoiced and not yet collected.'),
      })
      .describe('Everything the company owns.'),
    liabilities: z
      .object({
        debt: usd('Interest-bearing debt.'),
        payables: usd('Amounts owed to suppliers, including unpaid compute bills.'),
        deferredRevenue: usd('Cash collected for work not yet delivered.'),
      })
      .describe('Everything the company owes.'),
    equity: signedUsd('Total shareholders\' equity. May be negative for a distressed company.'),
  })
  .describe(
    'The balance sheet. Invariant, checked before every quarter commit: sum(assets) - sum(liabilities) must equal equity within a tolerance of one dollar. A quarter that fails this check does not commit.',
  );
export type BalanceSheet = z.infer<typeof BalanceSheetSchema>;

/** Tolerance in dollars for the balance-sheet reconciliation invariant. */
export const BALANCE_SHEET_TOLERANCE_USD = 1;

/** Pure invariant check. Deterministic; safe in the engine. */
export function balanceSheetReconciles(sheet: BalanceSheet, toleranceUsd: number = BALANCE_SHEET_TOLERANCE_USD): boolean {
  const assets = sheet.assets.cash + sheet.assets.ppe + sheet.assets.goodwill + sheet.assets.investments + sheet.assets.receivables;
  const liabilities = sheet.liabilities.debt + sheet.liabilities.payables + sheet.liabilities.deferredRevenue;
  return Math.abs(assets - liabilities - sheet.equity) <= toleranceUsd;
}

/* -------------------------------------------------------------------------- */
/*  Per-quarter financial statements (world version 2 and later)               */
/*                                                                            */
/*  `Financials` is one quarter, overwritten every quarter. `FinancialQuarter` */
/*  is the filed record of a quarter that has closed, kept as a bounded series */
/*  so a screen can draw a trend without re-deriving one from the ledger.      */
/* -------------------------------------------------------------------------- */

/**
 * The most closed quarters a company's series may CARRY. Ten years.
 *
 * The schema bound, and it does not move: a save written before the engine
 * shortened its window still holds up to forty statements and still has to
 * parse, because a game in progress has to be able to finish.
 */
export const FINANCIAL_HISTORY_QUARTERS = 40;

/**
 * How many closed quarters the engine KEEPS. Three years.
 *
 * BOUND: the array is trimmed from the front, oldest first, every time the
 * financial phase appends. The complete series lives in the snapshots and the
 * ledger; this is the phone-sized window a screen reads.
 *
 * Three years rather than ten because the whole session is hashed once per
 * ledger phase, eighteen times a quarter, and a company's filed statements are
 * about eighty-five percent of what a session weighs: at ten years a
 * twenty-seven-company world hashed 1.5MB eighteen times and a quarter took
 * 1.2 seconds on desktop hardware, against a Pi budget of well under a second.
 * Three years still carries every year-on-year comparison the screens and the
 * Chief of Staff draw, and the older statements are not lost — they are in the
 * ledger, where the full record has always lived.
 */
export const FINANCIAL_HISTORY_KEPT_QUARTERS = 12;

export const FinancialRevenueBySourceSchema = z
  .object({
    productsUsd: usd('Revenue from product lines: active customers multiplied by list price, summed across active products.'),
    contractsUsd: usd('Revenue from government contract milestones accepted this quarter.'),
    otherUsd: signedUsd(
      'Everything else the engine recognised: the goods-chain trade uplift and any price-accord bonus. Signed, because a falling chain price takes revenue away. INVARIANT: products + contracts + other = revenue.',
    ),
  })
  .describe('Where the quarter\'s revenue came from. Internal detail: a listed company files the total, not this split.');
export type FinancialRevenueBySource = z.infer<typeof FinancialRevenueBySourceSchema>;

export const FinancialOpexByLineSchema = z
  .object({
    payrollUsd: usd('Loaded employment cost for the quarter.'),
    researchUsd: usd('Research and development excluding the training compute booked beside it, so the two lines do not double count.'),
    marketingUsd: usd('Marketing, demand generation and developer relations.'),
    computeUsd: usd('Training compute charged to operating expense. Serving compute is a cost of revenue and is inside COGS, not here.'),
    otherUsd: signedUsd('The remainder, so the lines always sum to the operating expense total. INVARIANT: payroll + research + marketing + compute + other = opex.'),
  })
  .describe('Operating expense by line. Internal detail: a listed company files the total, not this split.');
export type FinancialOpexByLine = z.infer<typeof FinancialOpexByLineSchema>;

export const FinancialIncomeStatementSchema = z
  .object({
    revenueUsd: usd('Total revenue recognised in the quarter.'),
    revenueBySource: FinancialRevenueBySourceSchema.optional().describe(
      'Absent on a filed statement a rival may read. Absent means withheld, never zero.',
    ),
    cogsUsd: usd('Cost of revenue: serving compute, support, delivery and compliance.'),
    grossProfitUsd: signedUsd('Revenue less cost of revenue.'),
    opexUsd: usd('Total operating expense: payroll, marketing and research and development.'),
    opexByLine: FinancialOpexByLineSchema.optional().describe('Absent on a filed statement a rival may read.'),
    ebitdaUsd: signedUsd('Operating income before depreciation. INVARIANT: ebitda = operatingIncome + depreciation.'),
    depreciationUsd: usd('Depreciation charged against property, plant and equipment this quarter. The only non-cash charge the engine books.'),
    operatingIncomeUsd: signedUsd('Gross profit less operating expense. INVARIANT: operatingIncome = grossProfit - opex.'),
    interestUsd: usd('Interest paid on outstanding debt.'),
    taxUsd: usd('Tax charged on a positive pre-tax result. Zero for a loss-making quarter.'),
    netIncomeUsd: signedUsd('The bottom line. INVARIANT: netIncome = operatingIncome - interest - tax.'),
  })
  .describe('The income statement for one closed quarter, in whole dollars.');
export type FinancialIncomeStatement = z.infer<typeof FinancialIncomeStatementSchema>;

export const FinancialBalanceSheetSchema = z
  .object({
    cashUsd: signedUsd('Cash and equivalents at the close. Negative for an overdrawn company.'),
    receivablesUsd: usd('Invoiced and not yet collected.'),
    computeAssetsUsd: usd('Property, plant and equipment net of depreciation — principally accelerators and datacentre build.'),
    otherAssetsUsd: usd('Goodwill and investments carried at book value.'),
    investmentsUsd: usd(
      'The investments half of otherAssets: holdings in other companies\' securities at carrying value, which is cost. A part of otherAssetsUsd, never an addition to it, so the total-assets identity is untouched. Optional because it postdates the statement: absent on a statement filed before the line was split out, and absent is "not stated", never zero.',
    ).optional(),
    totalAssetsUsd: signedUsd('INVARIANT: cash + receivables + computeAssets + otherAssets. Signed because cash is.'),
    debtUsd: usd('Interest-bearing debt outstanding.'),
    deferredRevenueUsd: usd('Collected for work not yet delivered.'),
    otherLiabilitiesUsd: usd('Payables, including unpaid compute bills.'),
    totalLiabilitiesUsd: usd('INVARIANT: debt + deferredRevenue + otherLiabilities.'),
    equityUsd: signedUsd('Shareholders\' equity. INVARIANT: totalAssets - totalLiabilities = equity, within FINANCIAL_STATEMENT_TOLERANCE_USD.'),
  })
  .describe('The balance sheet at the close of one quarter, restated flat so a screen renders it without arithmetic.');
export type FinancialBalanceSheet = z.infer<typeof FinancialBalanceSheetSchema>;

export const FinancialCashFlowSchema = z
  .object({
    openingCashUsd: signedUsd('Cash carried into the financial phase. Negative when the previous quarter closed overdrawn.'),
    operatingUsd: signedUsd('Cash generated by operations: collections less everything the quarter paid out other than debt principal and capital expenditure.'),
    investingUsd: signedUsd('Cash spent on capital assets. Negative when the company bought compute.'),
    financingUsd: signedUsd('Debt principal repaid, negative, plus anything drawn.'),
    netChangeUsd: signedUsd('INVARIANT: operating + investing + financing = netChange = endingCash - openingCash.'),
    endingCashUsd: signedUsd('Cash at the close of the quarter. Negative for an overdrawn company. INVARIANT: endingCash = balance.cashUsd.'),
  })
  .describe('The cash-flow statement for one closed quarter. Reconciles to the cash line of the balance sheet by construction.');
export type FinancialCashFlow = z.infer<typeof FinancialCashFlowSchema>;

export const FinancialKpisSchema = z
  .object({
    headcount: intCount('Total employees across the five staff roles at the close.'),
    grossMarginPct: unitInterval('Gross profit over revenue. Zero for a pre-revenue quarter.'),
    revenueGrowthQoQ: rateFraction('Revenue against the previous closed quarter, where 0.08 is +8%. Zero when there is no previous quarter on this series.', -1, 5),
    revenueGrowthYoY: rateFraction('Revenue against the quarter four back on this series. Zero before four quarters of history exist.', -1, 10),
    runwayQuarters: z.number().min(0).max(200).describe('Quarters of cash left at this quarter\'s burn. Capped at 200 for a cash-generative company.'),
    runRateUsd: usd('Annualised revenue: this quarter multiplied by four. The ARR figure the screen prints.'),
    marketCapUsd: usd('Market capitalisation at the close.').nullable().describe('Market capitalisation at the close, or null before the market has priced this company.'),
    sharePriceUsd: usd('Closing share price.').nullable().describe('Closing share price from the tape, or null while unlisted.'),
  })
  .describe('The handful of derived figures a Financials screen leads with. Every one is computed by the engine, never by a screen.');
export type FinancialKpis = z.infer<typeof FinancialKpisSchema>;

export const FinancialProductLineSchema = z
  .object({
    productId: z.string().min(1),
    name: z.string().min(1).max(80),
    segment: ProductSegmentSchema,
    units: intCount('Paying seats or accounts at the close of the quarter.'),
    priceUsd: usd('List price per unit per quarter.'),
    revenueUsd: usd('INVARIANT: units multiplied by price.'),
    grossMarginPct: unitInterval('This line\'s gross margin, as the product phase resolved it.'),
    // Appended: written only from world version 2, where every product line
    // resolves through a real catalogue entry. Absent on a statement filed
    // before this field existed.
    categoryId: z.string().min(1).optional().describe('The product\'s industry line at the close of the quarter (PRODUCT_CATEGORIES). Absent on a statement filed before this field existed.'),
    unit: z.string().min(1).optional().describe('The category\'s unit label at the close of the quarter, e.g. "seat", "1M tokens", "MWh". Absent on a statement filed before this field existed.'),
  })
  .describe('One product line\'s unit economics for one closed quarter.');
export type FinancialProductLine = z.infer<typeof FinancialProductLineSchema>;

/**
 * One closed quarter's complete accounts for one company.
 *
 * Written by the financial phase from the figures that phase has already
 * computed — never recomputed, and never by a model. Every optional block is
 * optional because a *projection* removes it: a listed rival files the
 * statements at a coarser grain, and a private rival files nothing at all. An
 * absent block means withheld; it never means zero.
 */
export const FinancialQuarterSchema = z
  .object({
    quarter: QuarterIndexSchema.describe('The quarter these accounts close.'),
    income: FinancialIncomeStatementSchema,
    balance: FinancialBalanceSheetSchema,
    cashFlow: FinancialCashFlowSchema,
    kpis: FinancialKpisSchema,
    productLines: z
      .array(FinancialProductLineSchema)
      .max(64)
      .optional()
      .describe('Per-line economics, ordered by product id. Absent on a filed statement a rival may read: nobody files this.'),
  })
  .describe('A company\'s filed accounts for one closed quarter. Bounded to FINANCIAL_HISTORY_QUARTERS entries on the company.');
export type FinancialQuarter = z.infer<typeof FinancialQuarterSchema>;

/** Tolerance in dollars for the statement identities. Same one dollar the live sheet uses. */
export const FINANCIAL_STATEMENT_TOLERANCE_USD = BALANCE_SHEET_TOLERANCE_USD;

/**
 * Every identity a committed statement must satisfy. Pure; safe in the engine
 * and used by the tests that guard the financial phase.
 */
export function financialQuarterReconciles(
  entry: FinancialQuarter,
  toleranceUsd: number = FINANCIAL_STATEMENT_TOLERANCE_USD,
): boolean {
  const near = (a: number, b: number): boolean => Math.abs(a - b) <= toleranceUsd;
  const b = entry.balance;
  const c = entry.cashFlow;
  const i = entry.income;
  return (
    near(b.totalAssetsUsd, b.cashUsd + b.receivablesUsd + b.computeAssetsUsd + b.otherAssetsUsd) &&
    near(b.totalLiabilitiesUsd, b.debtUsd + b.deferredRevenueUsd + b.otherLiabilitiesUsd) &&
    near(b.totalAssetsUsd - b.totalLiabilitiesUsd, b.equityUsd) &&
    near(c.operatingUsd + c.investingUsd + c.financingUsd, c.netChangeUsd) &&
    near(c.netChangeUsd, c.endingCashUsd - c.openingCashUsd) &&
    near(c.endingCashUsd, b.cashUsd) &&
    near(i.grossProfitUsd, i.revenueUsd - i.cogsUsd) &&
    near(i.operatingIncomeUsd, i.grossProfitUsd - i.opexUsd) &&
    near(i.ebitdaUsd, i.operatingIncomeUsd + i.depreciationUsd) &&
    near(i.netIncomeUsd, i.operatingIncomeUsd - i.interestUsd - i.taxUsd) &&
    (i.revenueBySource === undefined ||
      near(i.revenueUsd, i.revenueBySource.productsUsd + i.revenueBySource.contractsUsd + i.revenueBySource.otherUsd)) &&
    (i.opexByLine === undefined ||
      near(
        i.opexUsd,
        i.opexByLine.payrollUsd + i.opexByLine.researchUsd + i.opexByLine.marketingUsd + i.opexByLine.computeUsd + i.opexByLine.otherUsd,
      ))
  );
}

/**
 * The same statement as a listed company files it: totals, no internal split.
 *
 * A projection removes and never rewrites, so this drops the two breakdowns and
 * the product lines and leaves every surviving figure exactly as the engine
 * committed it. A *private* company files nothing, so its history is absent
 * entirely rather than passed through here.
 */
export function filedFinancialQuarter(entry: FinancialQuarter): FinancialQuarter {
  const { revenueBySource: _bySource, opexByLine: _byLine, ...income } = entry.income;
  const { productLines: _lines, ...rest } = entry;
  return { ...rest, income };
}

export const ProfitAndLossSchema = z
  .object({
    companyId: z.string().min(1),
    quarter: QuarterIndexSchema,
    revenue: usd('Total recognised revenue.'),
    grossProfit: signedUsd('Revenue less cost of goods sold.'),
    operatingExpenses: usd('Payroll, marketing, research and development, and general costs.'),
    operatingIncome: signedUsd('Gross profit less operating expenses.'),
    netIncome: signedUsd('Operating income less interest and tax.'),
    freeCashFlow: signedUsd('Net income plus depreciation less capital expenditure and working capital movement.'),
    revenueBySegment: z
      .array(z.object({ segment: ProductSegmentSchema, revenue: usd('Segment revenue for the quarter.') }))
      .describe('Revenue split for the Financials screen.'),
  })
  .describe('The per-company result of the financial resolution phase.');
export type ProfitAndLoss = z.infer<typeof ProfitAndLossSchema>;

export const BalanceSheetCheckSchema = z
  .object({
    companyId: z.string().min(1),
    quarter: QuarterIndexSchema,
    reconciles: z.boolean().describe('True when assets minus liabilities equals equity within tolerance.'),
    discrepancyUsd: signedUsd('Signed size of the gap. Must be within BALANCE_SHEET_TOLERANCE_USD for the quarter to commit.'),
  })
  .describe('Result of the balance-sheet invariant check. A false result blocks the quarter commit.');
export type BalanceSheetCheck = z.infer<typeof BalanceSheetCheckSchema>;

/* -------------------------------------------------------------------------- */
/*  Fundamentals (the pricing anchor's inputs)                                 */
/* -------------------------------------------------------------------------- */

/**
 * The handful of figures the pricing model anchors a share price to.
 *
 * Almost all of this is derivable from `financials` and the cap table, but the
 * derivation needs *history* — four quarters of revenue, last year's revenue —
 * which live state does not keep. So the metrics phase writes the rolled-up
 * answer here once a quarter and the market phase reads it, which is what makes
 * a price traceable to fundamentals rather than to a fresh guess each quarter.
 *
 * `sharesOutstanding` is the one figure that exists nowhere else on a company:
 * `MarketInstrument.sharesOutstanding` only exists once a company is listed,
 * and the cap table's `issuedShares` is per share class. This is the single
 * total the price and the market capitalisation are derived from, and it is the
 * number `SHARE_PRICE_BAND_USD` is enforced through.
 */
export const CompanyFundamentalsSchema = z
  .object({
    revenueTtmUsd: usd('Trailing four-quarter revenue. Zero for a company younger than a quarter or pre-revenue.'),
    revenueGrowthQoQ: rateFraction('Revenue growth against the previous quarter, where 0.08 is +8%.', -1, 5),
    revenueGrowthYoY: rateFraction('Revenue growth against the same quarter a year earlier. Falls back to the quarterly figure before four quarters of history exist.', -1, 10),
    grossMarginPct: unitInterval('Blended gross margin across active products, as a fraction of revenue.'),
    netIncomeTtmUsd: signedUsd('Trailing four-quarter net income. Deeply negative for a frontier laboratory and that is fine; the earnings method is simply not chosen for it.'),
    sharesOutstanding: intCount(
      'Total ordinary shares in issue. INVARIANT: price multiplied by this must equal the market capitalisation, and the price it implies must sit inside SHARE_PRICE_BAND_USD at listing. Never zero for a company with a priced security.',
    ),
  })
  .describe('The fundamental figures the valuation anchor and the share price are built from. Refreshed by the metrics phase every quarter; never written by a model.');
export type CompanyFundamentals = z.infer<typeof CompanyFundamentalsSchema>;

/**
 * What a company gets when its save predates the fundamentals block. Every
 * figure is deliberately inert — no revenue, no growth, baseline margin — so a
 * world-version-1 company that has not yet been through a metrics phase cannot
 * accidentally price itself off stale defaults. The share count is the baseline
 * float, which puts a company worth `$50m` to `$5bn` inside the price band.
 */
export const DEFAULT_SHARES_OUTSTANDING = 10_000_000;

export const DEFAULT_COMPANY_FUNDAMENTALS: CompanyFundamentals = {
  revenueTtmUsd: 0,
  revenueGrowthQoQ: 0,
  revenueGrowthYoY: 0,
  grossMarginPct: 0.5,
  netIncomeTtmUsd: 0,
  sharesOutstanding: DEFAULT_SHARES_OUTSTANDING,
};

/* -------------------------------------------------------------------------- */
/*  Reputation and capability                                                  */
/* -------------------------------------------------------------------------- */

export const ReputationSchema = z
  .object({
    public: score100('How the general public regards the company.'),
    developer: score100('How the developer community regards the company. Open weights and good documentation raise it; API price rises and deprecations lower it.'),
    enterprise: score100('How enterprise buyers regard the company. Driven by reliability, security posture and delivery record.'),
    government: score100('How government buyers regard the company. Distinct from governmentPastPerformance, which is the formal procurement score.'),
    investor: score100('How investors regard management. Credibility here is spent on guidance and recovered slowly after a miss.'),
  })
  .describe('Five audiences, five separate reputations. A company can be loved by developers and distrusted by regulators at the same time.');
export type Reputation = z.infer<typeof ReputationSchema>;

export const TECH_CAPABILITY_AREAS = [
  'reasoning',
  'agents',
  'multimodal',
  'efficiency',
  'evaluation',
  'safety_alignment',
  'infrastructure',
  'retrieval',
  'training_systems',
  'hardware_design',
  'data_curation',
  'security',
] as const;

export const TechCapabilityAreaSchema = z.enum(TECH_CAPABILITY_AREAS).describe('A technical capability area a company can be strong or weak in.');
export type TechCapabilityArea = z.infer<typeof TechCapabilityAreaSchema>;

/** Capability strength per area. Internal state — records permitted. */
export const TechCapabilitiesSchema = z
  .record(z.string(), unitInterval('Capability strength in this area, 0 (absent) to 1 (world leading).'))
  .describe('Capability strength keyed by area (see TECH_CAPABILITY_AREAS). Determines which research projects a company can credibly attempt and how it scores on technical evaluation.');
export type TechCapabilities = z.infer<typeof TechCapabilitiesSchema>;

/* -------------------------------------------------------------------------- */
/*  Company                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * What an acquirer paid, kept on the company that was bought.
 *
 * An absorbed target is emptied into its acquirer: cash, staff, products and
 * balance sheet all move, and the husk keeps only its name, its sector and this
 * row. Without it the portfolio could state that a subsidiary exists but never
 * what it cost, because `sim_event`s are an append-only ledger outside session
 * state and a save carries none of them.
 *
 * Written by the capital phase in world version 2 only, so a world-version-1
 * company never grows the key and that frozen world keeps hashing to the value
 * it has always hashed to.
 */
export const AcquisitionRecordSchema = z
  .object({
    acquirerCompanyId: z.string().min(1).describe('The company that bought this one.'),
    quarter: QuarterIndexSchema.describe('Quarter the acquisition completed.'),
    priceUsd: usd('Total offer value, cash and stock together. The cost basis of the subsidiary.'),
    cashUsd: usd('The cash half of the consideration.'),
    stockUsd: usd('The stock half of the consideration, at the acquirer\'s price on the day.'),
    goodwillUsd: usd('Goodwill the acquirer recognised: what it paid over the net assets it took on. Zero on a bargain purchase.'),
  })
  .describe('The consideration paid for one company, recorded on the company that was bought.');
export type AcquisitionRecord = z.infer<typeof AcquisitionRecordSchema>;


/**
 * The right to produce a node somebody else owns.
 *
 * A licence is the alternative to researching a node yourself and the reason
 * ownership does not become a wall: an AI laboratory that has no business
 * learning to run a fab can still buy the right to make its own accelerators,
 * and pay for it every quarter. Defined here rather than in `nodes.ts` because
 * it hangs off a company, and defining it there would make `nodes.ts` and
 * `company.ts` import one another.
 */
export const NodeLicenceSchema = z
  .object({
    nodeId: z.string().min(1).describe('The node this licence covers, an id into ECONOMIC_NODES.'),
    ownerCompanyId: z.string().min(1).describe('The company that owns the node and grants the licence.'),
    royaltyPct: z.number().int().min(0).max(40).describe('Whole percent of this line\'s revenue paid to the owner every quarter, 0-40.'),
    expiryQuarter: QuarterIndexSchema.describe('Quarter the licence lapses. Producing after it lapses is not possible; renewing it is a negotiation.'),
  })
  .describe('A right to produce one node owned by another company, at a royalty, until an expiry. World version 3.');
export type NodeLicence = z.infer<typeof NodeLicenceSchema>;

/**
 * Terms an owner advertises for a node it owns.
 *
 * A licence is a negotiation, and a negotiation needs an opening price that is
 * not a guess. An owner that has published terms is stating what it will say
 * yes to: a request at or above `royaltyPct` from anybody it is `openToAll`
 * for is accepted deterministically, which is what turns the whole mechanism
 * from a lottery into a price a founder can read before spending a quarter on
 * it. Publishing binds nobody to renew, and it never sublicenses.
 */
export const NodeLicenceOfferSchema = z
  .object({
    nodeId: z.string().min(1).describe('The node being offered, an id into ECONOMIC_NODES. The company must own it outright — a licensee cannot sublicense.'),
    royaltyPct: z.number().int().min(0).max(40).describe('The whole percent of revenue the owner will licence at. A request at or above this is accepted.'),
    openToAll: z.boolean().describe('True when anybody may take these terms. False advertises the price while leaving the owner free to refuse a direct rival.'),
  })
  .describe('Published licence terms for one node this company owns. World version 3.');
export type NodeLicenceOffer = z.infer<typeof NodeLicenceOfferSchema>;

/* -------------------------------------------------------------------------- */
/*  Customer data                                                              */
/* -------------------------------------------------------------------------- */

/**
 * How hard a company collects from its own customers. One dial, three
 * positions, and every one of them costs something: aggressive collection buys
 * yield and pays for it in churn, reputation and regulatory exposure; minimal
 * collection buys goodwill and gives up the data that would have improved the
 * product.
 */
export const DATA_COLLECTION_LEVELS = ['minimal', 'standard', 'aggressive'] as const;

export const DataCollectionLevelSchema = z
  .enum(DATA_COLLECTION_LEVELS)
  .describe(
    'How hard this company collects customer data. "minimal": less yield, calmer customers, better standing. "standard": the default. "aggressive": far more yield, more churn on consumer lines, worse standing and a higher chance of enforcement.',
  );
export type DataCollectionLevel = z.infer<typeof DataCollectionLevelSchema>;

/**
 * One sector's pool of customer data, in petabytes.
 *
 * Pooled BY SECTOR because data is not fungible across industries: an AI
 * laboratory's chat logs improve its models and do nothing at all for its
 * batteries. An array rather than a record so the shape stays inside the
 * LLM-facing schema rules, and capped at six because there are six sectors.
 */
export const DataAssetSchema = z
  .object({
    sector: SectorSchema,
    petabytes: z.number().min(0).describe('Petabytes of usable customer data held in this sector, after decay.'),
  })
  .describe('One sector\'s stock of customer data. World version 3.');
export type DataAsset = z.infer<typeof DataAssetSchema>;

/* -------------------------------------------------------------------------- */
/*  Strategist memory                                                          */
/* -------------------------------------------------------------------------- */

/**
 * What a company remembers about how it has been treated and how its own
 * instructions have gone — the thing that makes one rival read differently from
 * another twenty quarters in.
 *
 * Three properties are load-bearing and are why this lives on state rather than
 * in a model transcript:
 *
 * - **The engine writes it.** Every entry below is derived by
 *   `updateStrategistMemory` in `@frontier/simulation` from committed ledger
 *   rows, the memories the relationships subsystem already stored and the
 *   company's own posture. No model output reaches it, so it costs no tokens,
 *   survives an LLM outage and cannot hallucinate a slight that never happened.
 * - **It is bounded.** Six grudges, eight attempts, 240 characters of standing
 *   strategy. A forty-quarter campaign cannot grow it, so it cannot be quietly
 *   compacted, truncated or summarised away by anything.
 * - **It replays.** A pure function of the recorded quarters, so a save
 *   replayed from its recorded decisions reconstructs the same memory byte for
 *   byte, and the same seed produces the same rival personality twice.
 */

/** Most grudges one company carries. Trimmed oldest-first. */
export const MAX_STRATEGIST_GRUDGES = 6;

/** Most attempts one company remembers. Trimmed oldest-first. */
export const MAX_STRATEGIST_ATTEMPTS = 8;

/** Longest a standing strategy may be, in characters. */
export const MAX_STANDING_STRATEGY_CHARS = 240;

/** Longest a grudge's reason may be. The writer clips to it; the schema enforces it. */
export const MAX_GRUDGE_REASON_CHARS = 160;

/** Longest an attempt's two halves may be. */
export const MAX_ATTEMPT_WHAT_CHARS = 120;
export const MAX_ATTEMPT_OUTCOME_CHARS = 200;

export const StrategistGrudgeSchema = z
  .object({
    companyId: z
      .string()
      .min(1)
      .describe('Who it is against: a company id, or the id of the fund behind an activist campaign. Never this company itself.'),
    reason: z.string().min(1).max(MAX_GRUDGE_REASON_CHARS).describe('What they did, in one sentence, taken from the ledger row or stored memory that caused it.'),
    quarter: QuarterIndexSchema.describe('The quarter the most recent instance of this happened in.'),
    intensity: z
      .number()
      .int()
      .min(0)
      .max(100)
      .describe('How much it still rankles, 0-100. Raised when the same counterparty does it again, and decayed a few points every quarter, so a slight fades unless it is repeated.'),
  })
  .describe('One standing complaint a company holds against a counterparty, written from what actually happened.');
export type StrategistGrudge = z.infer<typeof StrategistGrudgeSchema>;

export const StrategistAttemptSchema = z
  .object({
    quarter: QuarterIndexSchema.describe('The quarter the attempt was made in.'),
    what: z.string().min(1).max(MAX_ATTEMPT_WHAT_CHARS).describe('What the company tried, e.g. "Hiring 40 engineers".'),
    outcome: z
      .string()
      .min(1)
      .max(MAX_ATTEMPT_OUTCOME_CHARS)
      .describe('What the world did with it: the shortfall, the refusal or the reduction, in the words the founder read.'),
  })
  .describe('One thing this company tried and how that went. Written from the validator\'s verdict and the resolver\'s fills, never from intent.');
export type StrategistAttempt = z.infer<typeof StrategistAttemptSchema>;

export const StrategistMemorySchema = z
  .object({
    standingStrategy: z
      .string()
      .max(MAX_STANDING_STRATEGY_CHARS)
      .describe('What this company is trying to do, in its own words. Derived from its archetype policy and its posture, and rewritten only when the posture actually changes, so it stays stable and legible.'),
    standingStrategyQuarter: QuarterIndexSchema.describe('The quarter the standing strategy last changed. Unmoved by a quarter that changed nothing.'),
    grudges: z.array(StrategistGrudgeSchema).max(MAX_STRATEGIST_GRUDGES).describe('Standing complaints, oldest first. Bounded and trimmed oldest-first.'),
    attempts: z.array(StrategistAttemptSchema).max(MAX_STRATEGIST_ATTEMPTS).describe('Recent attempts and their outcomes, oldest first. Bounded and trimmed oldest-first.'),
  })
  .describe('A company\'s bounded, engine-written memory: what it is trying to do, who has wronged it, and what it has tried.');
export type StrategistMemory = z.infer<typeof StrategistMemorySchema>;

export const CompanySchema = z
  .object({
    // --- identity ---
    id: z.string().min(1).describe('Company id.'),
    name: z.string().min(1).max(120).describe('Company name.'),
    ticker: z.string().max(8).nullable().describe('Exchange ticker once listed, or null while private.'),
    archetype: CompanyArchetypeSchema,
    tier: CompanyTierSchema,
    isPublic: z.boolean().describe('True once the company has listed. Public companies disclose, are priced every quarter and attract activists.'),
    controllerPlayerId: z.string().nullable().describe('Player whose submitted actions direct this company, or null for an NPC-run company. Being the controller is not the same as owning the company: a board can dismiss a CEO who still holds 24% of the stock.'),
    sectorId: z.string().min(1).describe('Primary sector, used for sector beta and sentiment. See SECTOR_IDS in world.ts.'),
    sector: SectorSchema.default(DEFAULT_SECTOR).describe(
      'Which part of the real economy this company operates in, driving supply-chain coupling, capital intensity and its margin and multiple bands. Defaults to "ai" so a world-version-1 save parses unchanged.',
    ),
    region: RegionSchema.default(DEFAULT_REGION).describe(
      'Where the company is based, driving talent and energy cost, procurement appetite and capital depth. Defaults to "north_america" so a world-version-1 save parses unchanged.',
    ),
    foundedQuarter: QuarterIndexSchema.describe('Quarter the company was founded, which may be before quarter 0 for incumbents (use 0).'),
    headquartersCity: z.string().max(80).describe('Headquarters city.'),
    isActive: z.boolean().describe('False once acquired, wound up or delisted into another entity.'),

    // --- operations ---
    products: z.array(ProductSchema).describe('Product lines, active and sunset.'),
    employees: EmployeeBaseSchema,
    compute: ComputeHoldingsSchema,
    offices: z.array(OfficeSchema).describe('Physical sites.'),

    // --- financial position ---
    financials: FinancialsSchema,
    balanceSheet: BalanceSheetSchema,
    fundamentals: CompanyFundamentalsSchema.default(DEFAULT_COMPANY_FUNDAMENTALS).describe(
      'Rolled-up figures the share price is anchored to. Written by the metrics phase, read by the market phase. Defaults to DEFAULT_COMPANY_FUNDAMENTALS so a world-version-1 save parses unchanged.',
    ),

    financialHistory: z
      .array(FinancialQuarterSchema)
      .max(FINANCIAL_HISTORY_QUARTERS)
      .optional()
      .describe(
        'Closed-quarter accounts, oldest first, bounded to FINANCIAL_HISTORY_QUARTERS with the oldest dropped. Optional rather than defaulted for the reason the priced-economy block below is: a defaulted array would materialise on every world-version-1 company the moment the schema parsed one and that frozen world would stop hashing to the value it has always hashed to. Absent means the world does not keep statements, or that this seat may not read them.',
      ),

    // --- priced economy (world version 2 and later) ---
    //
    // Every field below is `.optional()` rather than defaulted, and that is
    // load-bearing: a defaulted field would materialise on every world-version-1
    // company the moment the schema parsed one, and the frozen world would stop
    // hashing to the value it has always hashed to. Absent means "this world does
    // not have priced goods", and every reader treats absent as the neutral value.
    antitrustExposure: score100(
      'Antitrust exposure, 0-100. Built from sector share, accord membership, recent acquisitions, tolls charged and quarters of predatory pricing; about a tenth of it decays every quarter, so a player can de-escalate. Drives the probability that an investigation names this company.',
    )
      .optional(),
    predatoryQuarters: z
      .number()
      .int()
      .min(0)
      .max(8)
      .optional()
      .describe('Consecutive quarters this company has priced below cost and materially under its segment. Rises by one, falls by one, capped at eight, and worth eight points of antitrust exposure each.'),
    dividendPolicyPct: z
      .number()
      .int()
      .min(0)
      .max(80)
      .optional()
      .describe('Share of last quarter\'s net income paid out to holders, 0-80. Settled in the capital phase and capped at half of cash however high the policy is.'),
    accordSuspendedUntilQuarter: QuarterIndexSchema.nullable()
      .optional()
      .describe('Quarter until which every price accord this company is party to pays nothing, set by an antitrust enforcement action. Null or absent when nothing is suspended.'),
    logisticsTollPct: z
      .number()
      .int()
      .min(0)
      .max(25)
      .optional()
      .describe('The toll this company charges rivals on its inputs in regions where its group dominates logistics. A dial, not a right: the engine caps it at what the group\'s regional share actually earns.'),
    recentAcquisitionQuarters: z
      .array(QuarterIndexSchema)
      .max(8)
      .optional()
      .describe('Quarters in which this company completed an acquisition, pruned to the antitrust window. Bounded history: the full record lives in the ledger.'),
    realisedInvestmentGainsUsd: signedUsd(
      'Cumulative gain or loss realised on selling stakes in other companies: proceeds less the carrying value that left the investments line, added up over the life of the company. Signed. The gain itself is already in equity the quarter it happens; this is the memory of it, because nothing else in state remembers a sale after the position is gone. World version 2 only.',
    ).optional(),
    acquisition: AcquisitionRecordSchema.nullable()
      .optional()
      .describe(
        'What was paid for this company when it was absorbed, written on the company that was bought. Absent for a company nobody has bought. The ledger row is the record of the event; this is the durable residue of it, because the ledger is not part of session state and the portfolio has to state a cost basis quarters later.',
      ),
    capacity: CapacityHoldingsSchema.optional().describe(
      'Non-compute capacity built with invest_capacity: plant, fleet and grid. Absent until the company first invests, and absent for every world-version-1 company, for the same hash-freezing reason every field in this block is optional rather than defaulted.',
    ),

    /*
     * World version 3: which nodes of the one economic table this company can
     * produce, and what it has licensed from somebody else. Both optional for
     * exactly the reason every priced-economy field above is — a defaulted
     * array would materialise on every world-1 and world-2 company the moment
     * the schema parsed one, and both frozen worlds would stop hashing to the
     * values they have always hashed to.
     *
     * Ownership is per company on purpose. World 2 asked whether a technology
     * was achieved *by anybody*, which locked nearly every line for everybody
     * on turn one, incumbents included.
     */
    ownedNodes: z
      // The table is 87 rows. The cap is above it because ownership UNIONS on
      // an acquisition: two companies owning thirty nodes each become one
      // owning fifty, and a cap below what a legal acquisition produces would
      // make the resulting session unsavable.
      .array(z.string().min(1))
      .max(96)
      .optional()
      .describe(
        'Ids into ECONOMIC_NODES (nodeGraph.ts) this company may produce. A company has a line on a node when it produces and sells it; owning the node is what makes that legal. Absent on a world-1 or world-2 company.',
      ),
    licences: z
      .array(NodeLicenceSchema)
      .max(12)
      .optional()
      .describe('Nodes this company may produce under somebody else\'s ownership, at a royalty and until an expiry. Absent on a world-1 or world-2 company.'),
    licenceOffers: z
      .array(NodeLicenceOfferSchema)
      .max(12)
      .optional()
      .describe('Terms this company advertises for nodes it owns. Absent on a world-1 or world-2 company, and absent for an owner that has never published.'),
    dataAssets: z
      .array(DataAssetSchema)
      .max(6)
      .optional()
      .describe(
        'Customer data this company holds, pooled by sector, in petabytes. Accrues from what its lines serve, decays every quarter, lifts the quality of what it sells in that sector and feeds any line whose node consumes a dataset. Absent on a world-1 or world-2 company.',
      ),
    dataPolicy: DataCollectionLevelSchema.optional().describe(
      'How hard this company collects from its own customers. Absent means "standard", which is what every company starts on and what a world-1 or world-2 company always is.',
    ),

    /*
     * The bounded memory `updateStrategistMemory` writes after every quarter's
     * events are committed: what this company is trying to do, who has wronged
     * it and what it has tried. Optional for exactly the reason every
     * priced-economy field above is — a defaulted object would materialise on
     * every world-1 and world-2 company the moment the schema parsed one, and
     * both frozen worlds would stop hashing to what they have always hashed to.
     * Absent means "nothing has happened to this company yet", which every
     * reader treats as an empty memory.
     */
    strategistMemory: StrategistMemorySchema.optional().describe(
      'This company\'s bounded, engine-written memory. Absent until the first quarter resolves against it, and absent on a world-1 or world-2 opening state.',
    ),

    // --- strategy (drives NPC behaviour and describes player companies) ---
    posture: CompanyPostureSchema,
    riskTolerance: unitInterval('How much variance this company will accept for upside. Drives NPC leverage, hiring pace and bid aggression.'),

    // --- capability and standing ---
    techCapabilities: TechCapabilitiesSchema,
    governmentPastPerformance: score100(
      'Formal procurement past-performance score, 0-100. Built from delivered milestones, cost realism and security record; damaged by missed deliveries. Directly feeds the past-performance weight of every future bid.',
    ),
    reputation: ReputationSchema,

    // --- links into other subsystems ---
    boardId: z.string().nullable().describe('Board governing this company, or null for companies too small to have one.'),
    primarySecurityId: z.string().nullable().describe('Security representing this company\'s ordinary equity, or null before any shares are issued.'),
    instrumentId: z.string().nullable().describe('Market instrument this company trades as, or null while unlisted.'),
    ceoCharacterId: z.string().nullable().describe('Character currently serving as chief executive.'),
    parentCompanyId: z.string().nullable().describe(
      'Acquirer, once this company has been bought. In world version 2 the company usually stays `isActive` as a live subsidiary — its own books, board and cap table, with the acquirer holding the stake in `assets.investments` — until an explicit `merge_subsidiary` absorbs it; in world version 1, and after that merge, the company is inactive and this is the residual pointer to who took it.',
    ),
  })
  .describe('An operating company in the session economy.');
export type Company = z.infer<typeof CompanySchema>;

/**
 * The *input* type: `sector`, `region` and `fundamentals` may be omitted and are
 * filled from the defaults. This is the shape a world-version-1 save has on
 * disk, and the shape a fixture should be written in.
 */
export type CompanyInput = z.input<typeof CompanySchema>;

/* -------------------------------------------------------------------------- */
/*  Derived per-quarter metrics                                                */
/* -------------------------------------------------------------------------- */

export const CompanyQuarterMetricsSchema = z
  .object({
    companyId: z.string().min(1),
    quarter: QuarterIndexSchema,
    revenueTtm: usd('Trailing four-quarter revenue.'),
    revenueGrowthYoY: rateFraction('Year-on-year revenue growth.', -1, 10),
    grossMarginPct: unitInterval('Blended gross margin this quarter.'),
    operatingMarginPct: z.number().min(-10).max(1).describe('Operating income divided by revenue. Deeply negative for early frontier labs. Range: -10..1.'),
    headcount: intCount('Total employees.'),
    runwayQuarters: z.number().min(0).max(200).describe('Quarters of cash left at the current burn. Capped at 200 for a cash-generative company.'),
    enterpriseValueUsd: usd('Engine estimate of controlled enterprise value, used by the leaderboard.'),
    marketCapUsd: usd('Market capitalisation when listed; last private round post-money otherwise.'),
    computeCostShare: unitInterval('Share of total cost that is compute. High values make the company fragile to supply shocks.'),
    governmentRevenueShare: unitInterval('Share of revenue from government contracts. High values bring stability and constraint together.'),
  })
  .describe('Derived metrics computed each quarter for the Command Centre, leaderboards and valuation anchors.');
export type CompanyQuarterMetrics = z.infer<typeof CompanyQuarterMetricsSchema>;

/** Percentage helper re-exported for consumers building comp/pricing UIs. */
export const PercentSchema = percent100('A percentage value.');
