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

export const ProductSchema = z
  .object({
    id: z.string().min(1).describe('Product id, e.g. "prd_enterprise_agent".'),
    name: z.string().min(1).max(80).describe('Product name as customers see it.'),
    segment: ProductSegmentSchema,
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

export const ComputeHoldingsSchema = z
  .object({
    ownedAccelerators: intCount('Accelerators the company owns outright. Depreciating capital, immune to spot price swings.'),
    reservedAccelerators: intCount('Accelerator-equivalents held under multi-quarter reservation.'),
    reservationExpiryQuarter: QuarterIndexSchema.nullable().describe('Quarter the current reservation lapses, or null when nothing is reserved. Letting a reservation lapse into a shortage is a classic way to lose a session.'),
    cloudSpendQuarterly: usd('Quarterly spend on on-demand cloud capacity, in dollars. Flexible but exposed to spot price.'),
    computeUtilisation: unitInterval('Fraction of held capacity actually in use. Sustained low utilisation is wasted capital; sustained high utilisation blocks new training runs.'),
    trainingAllocation: unitInterval('Share of total capacity directed at training rather than serving. Inference gets the remainder.'),
  })
  .describe('Compute the company controls, how it was procured and how it is allocated.');
export type ComputeHoldings = z.infer<typeof ComputeHoldingsSchema>;

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
    cash: usd('Cash and equivalents at the end of the quarter. Reaching zero triggers emergency financing or restructuring.'),
    debt: usd('Total interest-bearing debt outstanding.'),
    quarterlyBurn: signedUsd('Net cash movement this quarter. Negative means the company consumed cash; positive means it generated cash.'),
    deferredRevenue: usd('Contracted revenue billed but not yet recognised, principally from government contracts.'),
    backlogUsd: usd('Contracted future revenue not yet billed. Government awards create backlog before they create revenue.'),
  })
  .describe('The quarterly profit and loss and cash position. Every figure is in dollars for the quarter just resolved, not annualised.');
export type Financials = z.infer<typeof FinancialsSchema>;

export const BalanceSheetSchema = z
  .object({
    assets: z
      .object({
        cash: usd('Cash and equivalents.'),
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
    parentCompanyId: z.string().nullable().describe('Acquirer, when this company has been absorbed as a subsidiary.'),
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
