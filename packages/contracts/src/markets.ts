/**
 * @frontier/contracts — markets.ts
 *
 * Two market planes and one hard rule.
 *
 * - The **live reference market** carries real-world securities and indices. It
 *   is read-only. No modifier, no event and no player action may change it.
 *   Reality is not ours to modify; a reference quote is a fact we display.
 * - The **in-world exchange** carries the fictional securities of this session.
 *   It is fully simulated, has no real-money leg, and prices *beliefs*.
 *
 * Markets price what participants believe, not what the database knows. A model
 * programme that is two quarters late and 31% over budget moves the share price
 * only when the information set changes — through disclosure, leak, rumour or
 * the arrival of results that contradict prior guidance.
 *
 * The quarterly return model is decomposed so the game can always answer
 * "why did my stock fall?" from committed events rather than from a narrator.
 */

import { z } from 'zod';
import { QuarterIndexSchema, bipolarUnit, unitInterval, usd } from './ids';

/* -------------------------------------------------------------------------- */
/*  Instruments                                                                */
/* -------------------------------------------------------------------------- */

export const INSTRUMENT_KINDS = [
  'in_world_equity',
  'in_world_index',
  'reference_equity',
  'reference_index',
  'reference_rate',
  'reference_fx',
  'reference_commodity',
] as const;

export const InstrumentKindSchema = z
  .enum(INSTRUMENT_KINDS)
  .describe(
    'What the instrument is. Anything prefixed "in_world" is simulated and may be affected by the game. Anything prefixed "reference" mirrors a real market through the market-data adapter and is strictly read-only: the World Director may never target it, and no in-world action changes it.',
  );
export type InstrumentKind = z.infer<typeof InstrumentKindSchema>;

export const MarketInstrumentSchema = z
  .object({
    id: z.string().min(1).describe('Instrument id, e.g. "ins_orbit_eq".'),
    kind: InstrumentKindSchema,
    symbol: z.string().min(1).max(12).describe('Display symbol, e.g. "ORBT" or "NDX".'),
    name: z.string().min(1).max(120).describe('Display name.'),
    companyId: z.string().nullable().describe('In-world company this instrument prices, or null for indices and reference instruments.'),
    securityId: z.string().nullable().describe('Security this instrument quotes, or null for indices.'),
    sectorId: z.string().nullable().describe('Sector used for the sector beta term, or null.'),
    isReference: z.boolean().describe('True for real-world instruments. Enforced separately from kind so a single boolean guards every mutation path.'),
    currency: z.string().length(3).describe('ISO currency code, e.g. "USD".'),
    sharesOutstanding: z.number().min(0).nullable().describe('Shares outstanding for market capitalisation, or null for non-equity instruments.'),
    listedQuarter: QuarterIndexSchema.nullable().describe('Quarter the instrument began trading in world, or null for reference instruments.'),
    beta: z.number().min(-2).max(4).describe('Sensitivity to the market factor. 1.0 moves with the market; 1.8 is a high-beta frontier lab.'),
  })
  .describe('One quotable instrument on either market plane.');
export type MarketInstrument = z.infer<typeof MarketInstrumentSchema>;

/* -------------------------------------------------------------------------- */
/*  Quotes                                                                     */
/* -------------------------------------------------------------------------- */

export const QuoteSchema = z
  .object({
    instrumentId: z.string().min(1),
    quarter: QuarterIndexSchema,
    price: z
      .number()
      .min(0)
      .finite()
      .describe('Closing price for the quarter, in the instrument currency. INVARIANT: never negative, never NaN. A price that would go non-positive is floored and the company is marked distressed instead.'),
    return: z
      .number()
      .min(-1)
      .max(10)
      .describe('Simple return over the quarter, where 0.047 means +4.7%. Bounded below by -1 (total loss). Note: `return` is a reserved word, so read it as `quote.return` rather than destructuring it bare.'),
    volume: z.number().min(0).describe('Shares traded during the quarter. Drives the liquidity term of the return model.'),
    marketCapUsd: usd('Price multiplied by shares outstanding, or 0 for indices.'),
  })
  .describe('One instrument\'s price for one quarter. History is bounded: the session retains a rolling window rather than every quarter forever.');
export type Quote = z.infer<typeof QuoteSchema>;

/* -------------------------------------------------------------------------- */
/*  Valuation anchors                                                          */
/* -------------------------------------------------------------------------- */

export const VALUATION_METHODS = [
  'revenue_multiple',
  'forward_revenue_quality',
  'earnings_fcf',
  'asset_cashflow_utilisation',
  'technology_option_value',
] as const;

export const ValuationMethodSchema = z
  .enum(VALUATION_METHODS)
  .describe(
    'How fundamental value is estimated, chosen by company maturity. revenue_multiple for early startups (multiple plus probability-weighted growth); forward_revenue_quality for growth companies (forward revenue, gross margin, retention, growth); earnings_fcf for mature companies (cash flow and balance sheet); asset_cashflow_utilisation for infrastructure (cash flow, asset value, utilisation); technology_option_value for pre-revenue frontier laboratories (option value, capital requirement, strategic probability).',
  );
export type ValuationMethod = z.infer<typeof ValuationMethodSchema>;

export const ValuationAnchorSchema = z
  .object({
    companyId: z.string().min(1),
    quarter: QuarterIndexSchema,
    method: ValuationMethodSchema,
    inputs: z
      .record(z.string(), z.number())
      .describe('The named inputs that produced the anchor, e.g. { forwardRevenue, grossMargin, netRetention, growth, discountRate }. Kept so the Markets screen can show the working.'),
    anchorValueUsd: usd('Estimated fundamental enterprise value. Prices are pulled toward this over several quarters rather than snapping to it.'),
    perShareValueUsd: z.number().min(0).nullable().describe('Anchor value per share, or null when the company has no priced security.'),
    confidence: unitInterval('How much weight the market puts on this anchor. Low confidence widens the band in which sentiment dominates.'),
  })
  .describe('The fundamental value a price is pulled toward. A company can trade at $74 against a $52 anchor; the gap is exactly what the return decomposition explains.');
export type ValuationAnchor = z.infer<typeof ValuationAnchorSchema>;

/* -------------------------------------------------------------------------- */
/*  Beliefs                                                                    */
/* -------------------------------------------------------------------------- */

export const MARKET_BELIEF_TOPICS = [
  'model_delay',
  'model_success',
  'revenue_beat',
  'revenue_miss',
  'margin_pressure',
  'contract_win',
  'contract_loss',
  'fundraise_needed',
  'acquisition_target',
  'acquisition_acquirer',
  'regulatory_action',
  'leadership_change',
  'safety_incident',
  'accounting_concern',
  'talent_exodus',
] as const;

export const MarketBeliefTopicSchema = z.enum(MARKET_BELIEF_TOPICS).describe('What the market has an opinion about.');
export type MarketBeliefTopic = z.infer<typeof MarketBeliefTopicSchema>;

export const BELIEF_SUBJECT_KINDS = ['company', 'sector', 'world'] as const;
export const BeliefSubjectKindSchema = z.enum(BELIEF_SUBJECT_KINDS).describe('Whether the belief is about a company, a sector or the world at large.');
export type BeliefSubjectKind = z.infer<typeof BeliefSubjectKindSchema>;

export const MarketBeliefSchema = z
  .object({
    id: z.string().min(1),
    subjectId: z.string().min(1).describe('Company id, sector id, or the literal "world".'),
    subjectKind: BeliefSubjectKindSchema,
    topic: MarketBeliefTopicSchema,
    probability: unitInterval(
      'How likely the market currently thinks this is. This — not the canonical database — is what the price reflects. Reality only reaches the price by changing this number, through disclosure, leak, rumour or results.',
    ),
    priorProbability: unitInterval('The same figure at the end of the previous quarter, so the UI can show what moved.'),
    lastUpdatedQuarter: QuarterIndexSchema,
    evidenceDisclosureIds: z.array(z.string()).describe('Disclosures that shaped this belief, newest first.'),
  })
  .describe('One belief the market holds. Truth and belief are stored separately on purpose: that separation is what makes earnings surprises, leaks, short theses and credibility gameplay possible.');
export type MarketBelief = z.infer<typeof MarketBeliefSchema>;

/* -------------------------------------------------------------------------- */
/*  Public disclosures                                                         */
/* -------------------------------------------------------------------------- */

export const DISCLOSURE_KINDS = ['guidance', 'earnings', 'leak', 'rumour', 'press_release', 'regulatory_filing', 'analyst_note'] as const;

export const DisclosureKindSchema = z
  .enum(DISCLOSURE_KINDS)
  .describe(
    'Where the information came from. "guidance" and "earnings" are the company speaking on the record and spend or build management credibility. "leak" and "rumour" are unattributed and land with reduced credibility. "analyst_note" is a third-party interpretation.',
  );
export type DisclosureKind = z.infer<typeof DisclosureKindSchema>;

export const PublicDisclosureSchema = z
  .object({
    id: z.string().min(1),
    companyId: z.string().nullable().describe('Company the disclosure concerns, or null for sector and macro commentary.'),
    quarter: QuarterIndexSchema,
    kind: DisclosureKindSchema,
    headline: z.string().min(3).max(160).describe('One-line summary as it appears on the News screen.'),
    body: z.string().max(1500).describe('Full text of the disclosure.'),
    metrics: z
      .record(z.string(), z.number())
      .describe('Any numbers asserted, e.g. { guidedRevenue: 2800000000, guidedMargin: 0.61 }. The engine compares these against reality next quarter to update management credibility.'),
    credibility: unitInterval(
      'How much weight the market gives this. Company statements start near the issuer\'s investor reputation; anonymous rumours start low. A denial that later proves misleading permanently damages the issuer\'s credibility.',
    ),
    sourceCharacterId: z.string().nullable().describe('Who said it, or null for anonymous.'),
    isTruthful: z.boolean().describe('INTERNAL ONLY. Whether the statement matched canonical reality at the time it was made. Never expose this to the client; it is what the engine uses to punish misleading guidance two quarters later.'),
    beliefTopic: MarketBeliefTopicSchema.nullable().describe('Belief this disclosure updates, or null when it is colour rather than information.'),
  })
  .describe('A piece of public information. Disclosures are the bridge between canonical private reality and market belief.');
export type PublicDisclosure = z.infer<typeof PublicDisclosureSchema>;

/* -------------------------------------------------------------------------- */
/*  Return decomposition                                                       */
/* -------------------------------------------------------------------------- */

export const ReturnDecompositionSchema = z
  .object({
    instrumentId: z.string().min(1),
    companyId: z.string().nullable(),
    quarter: QuarterIndexSchema,
    marketBeta: z.number().describe('Contribution of the whole-market factor, as a fractional return component.'),
    sectorBeta: z.number().describe('Contribution of the sector factor.'),
    fundamentalAlpha: z.number().describe('Contribution of the pull toward the valuation anchor: earnings, margin, retention and growth actually delivered.'),
    publicInfoEffect: z.number().describe('Contribution of information that became public this quarter: guidance, earnings surprise, contract awards, leaks.'),
    sentimentEffect: z.number().describe('Contribution of sentiment and narrative unsupported by fundamentals. This is the euphoria and the panic.'),
    liquidityEffect: z.number().describe('Contribution of trading flow: index inclusion, block purchases, forced selling.'),
    noise: z.number().describe('Residual idiosyncratic term drawn from the seeded RNG. Deterministic given the seed.'),
    total: z.number().describe('Sum of the components. Must equal the applied return within 1e-9, so the "why did my stock move?" screen always adds up.'),
    priceBefore: z.number().min(0).describe('Price at the start of the quarter.'),
    priceAfter: z.number().min(0).describe('Price at the end of the quarter.'),
  })
  .describe(
    'A fully explained quarterly price move. Every component traces to committed simulation events, which is why the game can answer "why did my stock fall?" without asking a model to invent a reason.',
  );
export type ReturnDecomposition = z.infer<typeof ReturnDecompositionSchema>;

/** Tolerance for the "components sum to total" invariant. */
export const RETURN_DECOMPOSITION_TOLERANCE = 1e-9;

/** Pure check that a decomposition adds up. Deterministic. */
export function returnDecompositionSums(d: ReturnDecomposition, tolerance: number = RETURN_DECOMPOSITION_TOLERANCE): boolean {
  const sum = d.marketBeta + d.sectorBeta + d.fundamentalAlpha + d.publicInfoEffect + d.sentimentEffect + d.liquidityEffect + d.noise;
  return Math.abs(sum - d.total) <= tolerance;
}

/* -------------------------------------------------------------------------- */
/*  Reference market adapter                                                   */
/* -------------------------------------------------------------------------- */

export const ReferenceSnapshotSchema = z
  .object({
    capturedAtQuarter: QuarterIndexSchema.describe('Session quarter at which the real tape was sampled. Normally only quarter 0: once the session runs faster than real time, its causality must branch.'),
    riskFreeRate: z.number().min(-0.05).max(0.25).describe('Benchmark risk-free rate used to calibrate in-world discounting.'),
    majorIndexLevel: z.number().min(0).describe('Level of a major reference index at capture.'),
    semiconductorIndexLevel: z.number().min(0).describe('Level of a semiconductor sector reference at capture.'),
    volatilityLevel: unitInterval('Normalised volatility reading used to calibrate the in-world noise term.'),
    quotes: z.array(QuoteSchema).describe('Reference quotes captured, for display only.'),
  })
  .describe(
    'A snapshot of the real tape, used once to calibrate a new session. It initialises the interest-rate environment, benchmark levels and volatility. It never overwrites in-world prices afterwards: continuously re-syncing a session that has run to 2030 with today\'s real prices would destroy cause and effect.',
  );
export type ReferenceSnapshot = z.infer<typeof ReferenceSnapshotSchema>;

/**
 * The market-data adapter the web app implements. Kept as an interface so the
 * game never scrapes and never hard-codes one vendor; real-time equity data is a
 * licensed product and the provider is a deployment decision.
 */
export interface MarketDataProvider {
  getQuote(symbol: string): Promise<Quote | null>;
  getDailyBars(symbol: string, days: number): Promise<readonly Quote[]>;
  getIndex(symbol: string): Promise<Quote | null>;
  getFx(pair: string): Promise<number | null>;
  getReferenceSnapshot(): Promise<ReferenceSnapshot | null>;
}
