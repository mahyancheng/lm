/**
 * @frontier/contracts — economy.ts
 *
 * The priced economy: goods prices along the sector chain, the logistics toll,
 * price accords and antitrust exposure, predatory pricing, dividends and the
 * control thresholds — plus the **attribution rows** every one of them writes so
 * the interface can render a modifier stack without doing any arithmetic of its
 * own.
 *
 * Two things live here and nothing else.
 *
 * 1. **Balancing constants and the pure functions over them.** Every formula in
 *    `docs/economy-study.md` §4 that both the engine and the interface need to
 *    agree on. They are pure, integer-valued where the design says whole
 *    numbers, and free of session state, so a screen can preview a decision with
 *    exactly the arithmetic the resolver will later commit.
 * 2. **The attribution schemas.** `EconomyReport` is the one quarter's worth of
 *    itemised rows the resolver writes onto `SessionState`. It is derived state,
 *    like `companyMetrics`: rebuilt every quarter, never accumulated, and
 *    **absent entirely in world version 1** so a frozen save hashes as it always
 *    did.
 *
 * The rule these schemas exist to make mechanical, from §6.2 of the study:
 *
 * > If the engine multiplied it, the screen names it and signs it — and tapping
 * > the row shows the event that caused it.
 *
 * So every row carries a `causeEventId` pointing at the committed ledger row it
 * came from, and every percentage is a **signed whole number**.
 *
 * Nothing in this module is LLM-facing. A model may be told a price index; it
 * never returns one of these tables.
 */

import { z } from 'zod';
import { QuarterIndexSchema, signedUsd, usd } from './ids';
import { RegionSchema, SectorSchema, type Region, type Sector } from './sectors';
import { ProductSegmentSchema } from './company';
import { HolderKindSchema } from './ownership';

/* -------------------------------------------------------------------------- */
/*  P0-1 — sector goods prices                                                 */
/* -------------------------------------------------------------------------- */

/** The index every sector price is quoted against. One number the player learns once. */
export const SECTOR_PRICE_BASELINE = 100;

/**
 * Peak deviation of a sector price from baseline, as a fraction. At 0.75 a 2:1
 * imbalance in either direction reaches the end of the range, which is a number
 * a player can hold in their head — exactly Victoria 3's clamp, restated.
 */
export const SECTOR_PRICE_SWING = 0.75;

/** Hard range of a sector price index. Both ends are reachable at a 2:1 imbalance. */
export const SECTOR_PRICE_BOUNDS = { min: 25, max: 175 } as const;

/**
 * Fraction of a sector's output that goes to end customers rather than to the
 * other five sectors, as whole percentage points. The complement is the **trade
 * share**: the part of a seller's revenue the sector price actually reprices.
 *
 * Balancing values, to be tuned in playtest. Consumer sells only to people, so
 * nothing of its revenue is repriced by the chain; energy sells almost entirely
 * to other sectors, so nearly all of it is.
 */
export const SECTOR_END_SHARE_PCT: Readonly<Record<Sector, number>> = {
  ai: 60,
  robotics: 80,
  manufacturing: 30,
  energy: 20,
  logistics: 30,
  consumer: 100,
};

/** End-customer share of a sector's output, as a fraction. */
export function sectorEndShare(sector: Sector): number {
  return SECTOR_END_SHARE_PCT[sector] / 100;
}

/** Share of a sector's output sold to the other sectors, as a fraction. */
export function sectorTradeShare(sector: Sector): number {
  return 1 - sectorEndShare(sector);
}

/** Ceiling of the stateful shortage counter. Six quarters of neglect to reach it. */
export const SECTOR_SHORTAGE_MAX = 60;
/** How much a shortage deepens in a quarter where the price clamp saturates. */
export const SECTOR_SHORTAGE_STEP_UP = 10;
/** How much it heals in a quarter where it does not. Healing is half as fast. */
export const SECTOR_SHORTAGE_STEP_DOWN = 5;
/** The imbalance at which the price stops carrying information and the counter takes over. */
export const SECTOR_SHORTAGE_TRIGGER_IMBALANCE = 1;

/** Most of a seller's revenue the sector price may add or take away. */
export const TRADE_UPLIFT_REVENUE_CAP = 0.25;

/** Clamp into `[min, max]`. Non-finite collapses to `min`. */
function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return value < min ? min : value > max ? max : value;
}

const clamp01 = (value: number): number => clamp(value, 0, 1);

/**
 * The stateless half of the price rule: an imbalance in `[-1, +1]`.
 *
 * `(demand - supply) / min(demand, supply)` reaches ±1 at a 2:1 ratio and is
 * clamped there, so beyond that the price stops moving and the stateful shortage
 * counter is what carries the information instead.
 */
export function sectorImbalance(demandUsd: number, supplyUsd: number): number {
  const floor = Math.max(1, Math.min(demandUsd, supplyUsd));
  return clamp((demandUsd - supplyUsd) / floor, -1, 1);
}

/** The whole-number price index for an imbalance. Always inside `SECTOR_PRICE_BOUNDS`. */
export function sectorPriceIndexFor(imbalance: number): number {
  const raw = Math.round(SECTOR_PRICE_BASELINE * (1 + SECTOR_PRICE_SWING * clamp(imbalance, -1, 1)));
  return clamp(raw, SECTOR_PRICE_BOUNDS.min, SECTOR_PRICE_BOUNDS.max);
}

/** Step the shortage counter. Deepens twice as fast as it heals; whole numbers. */
export function nextSectorShortage(shortage: number, imbalance: number): number {
  const current = clamp(Math.round(shortage), 0, SECTOR_SHORTAGE_MAX);
  if (imbalance >= SECTOR_SHORTAGE_TRIGGER_IMBALANCE) return Math.min(SECTOR_SHORTAGE_MAX, current + SECTOR_SHORTAGE_STEP_UP);
  return Math.max(0, current - SECTOR_SHORTAGE_STEP_DOWN);
}

/** What a shortage counter does to the realisation gate of everyone downstream. */
export function shortageGate(shortage: number): number {
  return clamp01(1 - clamp(Math.round(shortage), 0, SECTOR_SHORTAGE_MAX) / 100);
}

/**
 * A sector price index as a plain multiplier around 1.
 *
 * The one accessor the whole engine reads a price through, so a session that has
 * never priced its sectors (world version 1, or a save written before prices
 * existed) is exactly neutral rather than undefined.
 */
export function sectorPriceFactor(index: number | undefined): number {
  const value = index === undefined || !Number.isFinite(index) ? SECTOR_PRICE_BASELINE : index;
  return clamp(value, SECTOR_PRICE_BOUNDS.min, SECTOR_PRICE_BOUNDS.max) / SECTOR_PRICE_BASELINE;
}

/** Anything carrying the optional priced-economy maps. Structural, to avoid an import cycle. */
export interface PricedEconomyState {
  readonly sectorPrices?: Readonly<Record<string, number>> | undefined;
  readonly sectorShortages?: Readonly<Record<string, number>> | undefined;
  readonly regionTolls?: Readonly<Record<string, number>> | undefined;
}

/** A sector's price index, defaulting to the baseline. Total. */
export function sectorPriceIndex(state: PricedEconomyState, sector: Sector): number {
  const value = state.sectorPrices?.[sector];
  return value === undefined || !Number.isFinite(value) ? SECTOR_PRICE_BASELINE : Math.round(value);
}

/** A sector's shortage counter, defaulting to zero. Total. */
export function sectorShortage(state: PricedEconomyState, sector: Sector): number {
  const value = state.sectorShortages?.[sector];
  return value === undefined || !Number.isFinite(value) ? 0 : clamp(Math.round(value), 0, SECTOR_SHORTAGE_MAX);
}

/* -------------------------------------------------------------------------- */
/*  P0-2 — the logistics toll                                                  */
/* -------------------------------------------------------------------------- */

/** Below this regional logistics share the toll is exactly zero. You must dominate. */
export const TOLL_FLOOR_SHARE = 0.4;

/** The toll at a total regional monopoly, as whole percentage points of cash cost. */
export const TOLL_MAX_PCT = 25;

/** The toll a dominant share earns, whole percentage points. Zero below the floor. */
export function logisticsTollPct(dominantShare: number): number {
  const above = (clamp01(dominantShare) - TOLL_FLOOR_SHARE) / (1 - TOLL_FLOOR_SHARE);
  return Math.round(TOLL_MAX_PCT * clamp01(above));
}

/** A region's toll in force this quarter, defaulting to zero. Total. */
export function regionToll(state: PricedEconomyState, region: Region): number {
  const value = state.regionTolls?.[region];
  return value === undefined || !Number.isFinite(value) ? 0 : clamp(Math.round(value), 0, TOLL_MAX_PCT);
}

/* -------------------------------------------------------------------------- */
/*  P0-3 — accords and antitrust exposure                                      */
/* -------------------------------------------------------------------------- */

/** The bonus any active accord pays, whatever its combined share. Plutocracy's floor. */
export const CARTEL_BONUS_FLOOR_PCT = 5;
/** The additional bonus a total sector accord pays, whole percentage points. */
export const CARTEL_BONUS_SHARE_PCT = 25;

/** `5 + round(25 x combinedShare)`, whole percentage points, 5 to 30. */
export function cartelBonusPct(combinedShare: number): number {
  return CARTEL_BONUS_FLOOR_PCT + Math.round(CARTEL_BONUS_SHARE_PCT * clamp01(combinedShare));
}

/** Quarters an accord stays suspended after an enforcement action. */
export const ACCORD_SUSPENSION_QUARTERS = 6;

/** How far back an acquisition still counts toward antitrust exposure. */
export const ACQUISITION_EXPOSURE_WINDOW_QUARTERS = 4;

/**
 * The five drivers of antitrust exposure and the decay that lets a player
 * de-escalate. The 0.90 carry is what makes exposure a decision rather than a
 * ratchet: stop, and it falls about a tenth a quarter to nothing.
 */
export const ANTITRUST_EXPOSURE_WEIGHTS = {
  /** Fraction of last quarter's exposure carried forward. */
  carry: 0.9,
  /** Points at a total share of the company's own sector. */
  sectorShare: 40,
  /** Points for membership of any active price accord. */
  accord: 25,
  /** Points per acquisition inside the window, up to `maxAcquisitions`. */
  acquisition: 8,
  /** Acquisitions beyond this add nothing. */
  maxAcquisitions: 2,
  /** Points at the maximum logistics toll charged to rivals. */
  toll: 20,
  /** Points per quarter of predatory pricing (P0-4). */
  predation: 8,
} as const;

/** The three bands the exposure score is coloured in. */
export const ANTITRUST_BANDS = { watched: 40, exposed: 75 } as const;

export const ANTITRUST_BAND_NAMES = ['calm', 'watched', 'exposed'] as const;
export const AntitrustBandSchema = z.enum(ANTITRUST_BAND_NAMES).describe('Colour band for the antitrust exposure score: 0-39 calm, 40-74 watched, 75-100 exposed.');
export type AntitrustBand = z.infer<typeof AntitrustBandSchema>;

/** Which band an exposure score falls in. Pure. */
export function antitrustBand(exposure: number): AntitrustBand {
  if (exposure >= ANTITRUST_BANDS.exposed) return 'exposed';
  if (exposure >= ANTITRUST_BANDS.watched) return 'watched';
  return 'calm';
}

/** The inputs to one company's exposure recomputation. All fractions or counts. */
export interface AntitrustExposureInputs {
  /** Last quarter's score, 0..100. */
  readonly exposure: number;
  /** This company's share of its own sector's supply, 0..1. */
  readonly sectorShare: number;
  /** Whether it is a member of an accord that is active and not suspended. */
  readonly inAccord: boolean;
  /** Acquisitions completed inside `ACQUISITION_EXPOSURE_WINDOW_QUARTERS`. */
  readonly recentAcquisitions: number;
  /** The toll its group charges rivals, whole percentage points, 0 when it charges none. */
  readonly tollChargedPct: number;
  /** Consecutive quarters of predatory pricing, 0..8. */
  readonly predatoryQuarters: number;
}

/** One signed contribution to the exposure score, for the drill-down. */
export interface AntitrustExposureContribution {
  readonly key: string;
  readonly label: string;
  readonly points: number;
  readonly detail: string;
}

/**
 * Recompute antitrust exposure. Pure, whole-number, and **monotone in every
 * driver**: raising any one input can never lower the score.
 */
export function antitrustExposure(inputs: AntitrustExposureInputs): { readonly score: number; readonly contributions: readonly AntitrustExposureContribution[] } {
  const w = ANTITRUST_EXPOSURE_WEIGHTS;
  // Floored, not rounded. `round(0.9 × 5)` is 5, so a rounded carry would leave
  // a company that stopped concentrating stuck at five points forever — a
  // ratchet, which is the one thing this score must not be.
  const carried = Math.floor(w.carry * clamp(inputs.exposure, 0, 100));
  const share = w.sectorShare * clamp01(inputs.sectorShare);
  const accord = inputs.inAccord ? w.accord : 0;
  const acquisitions = w.acquisition * Math.min(w.maxAcquisitions, Math.max(0, Math.round(inputs.recentAcquisitions)));
  const toll = w.toll * clamp01(clamp(inputs.tollChargedPct, 0, TOLL_MAX_PCT) / TOLL_MAX_PCT);
  const predation = w.predation * clamp(Math.round(inputs.predatoryQuarters), 0, PREDATORY_QUARTERS_MAX);

  const score = clamp(Math.round(carried + share + accord + acquisitions + toll + predation), 0, 100);
  return {
    score,
    contributions: [
      { key: 'carried', label: 'Carried from last quarter', points: Math.round(carried), detail: `${Math.round(w.carry * 100)}% of ${Math.round(clamp(inputs.exposure, 0, 100))}` },
      { key: 'sector_share', label: 'Share of your sector', points: Math.round(share), detail: `${Math.round(clamp01(inputs.sectorShare) * 100)}% of sector supply` },
      { key: 'accord', label: 'Price accord', points: Math.round(accord), detail: inputs.inAccord ? 'A member of an active accord' : 'No active accord' },
      { key: 'acquisitions', label: 'Recent acquisitions', points: Math.round(acquisitions), detail: `${Math.max(0, Math.round(inputs.recentAcquisitions))} in the last ${ACQUISITION_EXPOSURE_WINDOW_QUARTERS} quarters` },
      { key: 'toll', label: 'Logistics toll charged', points: Math.round(toll), detail: `${Math.round(clamp(inputs.tollChargedPct, 0, TOLL_MAX_PCT))}% on rivals` },
      { key: 'predation', label: 'Predatory pricing', points: Math.round(predation), detail: `${clamp(Math.round(inputs.predatoryQuarters), 0, PREDATORY_QUARTERS_MAX)} quarter(s) below cost` },
    ],
  };
}

/** Hazard floor for the antitrust family at zero exposure, as a multiple of base. */
export const ANTITRUST_HAZARD_FLOOR = 0.25;
/** Additional hazard multiple at maximum exposure. Floor + span = 2x base at 100. */
export const ANTITRUST_HAZARD_SPAN = 1.75;

/** `baseHazard x (0.25 + 1.75 x exposure/100)`. Pure, monotone, no new RNG draw. */
export function antitrustHazardWeight(maxExposure: number): number {
  return ANTITRUST_HAZARD_FLOOR + ANTITRUST_HAZARD_SPAN * (clamp(maxExposure, 0, 100) / 100);
}

/** Share of cash an enforcement fine may take. */
export const ANTITRUST_FINE_CASH_SHARE = 0.05;
/** Share of trailing revenue an enforcement fine may take. The binding cap is the lower. */
export const ANTITRUST_FINE_REVENUE_SHARE = 0.02;
/** Exposure the investigation itself clears. The air is cleared by being caught. */
export const ANTITRUST_ENFORCEMENT_RELIEF = 30;

/** The bounded remedy: the lower of a share of cash and a share of trailing revenue. */
export function antitrustFineUsd(cashUsd: number, revenueTtmUsd: number): number {
  const byCash = Math.round(Math.max(0, cashUsd) * ANTITRUST_FINE_CASH_SHARE);
  const byRevenue = Math.round(Math.max(0, revenueTtmUsd) * ANTITRUST_FINE_REVENUE_SHARE);
  return Math.max(0, Math.min(byCash, byRevenue));
}

/* -------------------------------------------------------------------------- */
/*  P0-4 — dumping and price wars                                              */
/* -------------------------------------------------------------------------- */

/** Undercut at which a below-cost price becomes predatory. */
export const PREDATORY_UNDERCUT_THRESHOLD = 0.2;
/** Undercut beyond which nothing more is counted: the product is selling something else. */
export const PREDATORY_UNDERCUT_CAP = 0.6;
/** Most demand one predator may take off one rival in one quarter. */
export const PRESSURE_MAX = 0.12;
/** Most every predator combined may take. A three-way price war cannot zero a segment. */
export const PRESSURE_TOTAL_CAP = 0.25;
/** Ceiling of the per-company predatory-quarters counter. */
export const PREDATORY_QUARTERS_MAX = 8;

/** How far under the segment reference a price sits, 0..0.60. */
export function undercutFraction(priceUsd: number, referencePriceUsd: number): number {
  if (!(referencePriceUsd > 0)) return 0;
  return clamp(1 - priceUsd / referencePriceUsd, 0, PREDATORY_UNDERCUT_CAP);
}

/** Both conditions, stated once: below cost **and** materially under the market. */
export function isPredatoryPrice(grossMarginFraction: number, undercut: number): boolean {
  return grossMarginFraction < 0 && undercut >= PREDATORY_UNDERCUT_THRESHOLD;
}

/** One predator's pressure on one rival, 0..`PRESSURE_MAX`. */
export function predatorPressure(predatorSegmentShare: number, undercut: number): number {
  const intensity = undercut / PREDATORY_UNDERCUT_THRESHOLD;
  return clamp(PRESSURE_MAX * clamp01(predatorSegmentShare) * intensity, 0, PRESSURE_MAX);
}

/**
 * Combine several predators' pressures: `1 - Π(1 - p_k)`, capped in total.
 * Order-independent by construction, which is what the phase relies on.
 */
export function combinedPressure(pressures: readonly number[]): number {
  let survives = 1;
  for (const pressure of pressures) survives *= 1 - clamp(pressure, 0, PRESSURE_MAX);
  return clamp(1 - survives, 0, PRESSURE_TOTAL_CAP);
}

/** Step the per-company predatory counter: up one, down one, bounded 0..8. */
export function nextPredatoryQuarters(current: number, predatoryThisQuarter: boolean): number {
  const value = clamp(Math.round(current), 0, PREDATORY_QUARTERS_MAX);
  return predatoryThisQuarter ? Math.min(PREDATORY_QUARTERS_MAX, value + 1) : Math.max(0, value - 1);
}

/* -------------------------------------------------------------------------- */
/*  P0-5 — dividends, stake accumulation and control                           */
/* -------------------------------------------------------------------------- */

/** Highest payout a board will authorise, whole percentage points of net income. */
export const DIVIDEND_MAX_PAYOUT_PCT = 80;
/** Step the payout slider snaps to. */
export const DIVIDEND_PAYOUT_STEP_PCT = 5;
/** A payout may never take more than half the cash on hand, whatever the policy says. */
export const DIVIDEND_CASH_CAP_SHARE = 0.5;
/** Most investor reputation a standing payout may buy. */
export const DIVIDEND_REPUTATION_MAX = 6;

/** What a payout policy would actually pay, in whole dollars. Pure — the screen's preview. */
export function dividendUsd(netIncomeLastQuarterUsd: number, payoutPct: number, cashUsd: number): number {
  const pct = clamp(Math.round(payoutPct), 0, DIVIDEND_MAX_PAYOUT_PCT);
  const payable = (Math.max(0, netIncomeLastQuarterUsd) * pct) / 100;
  return Math.max(0, Math.round(Math.min(payable, Math.max(0, cashUsd) * DIVIDEND_CASH_CAP_SHARE)));
}

/** Investor reputation a standing payout buys, bounded. */
export function dividendReputationBonus(payoutPct: number): number {
  return Math.min(DIVIDEND_REPUTATION_MAX, Math.round(clamp(payoutPct, 0, DIVIDEND_MAX_PAYOUT_PCT) / 10) * 2);
}

/** Price impact per unit of float bought. Buying the whole float costs twice the quote. */
export const STAKE_IMPACT = 1;
/** What a named holder's block costs, as a multiple of the quote. */
export const BLOCK_PREMIUM = 2;

/** Whole-percentage price impact of taking `sharesBought` out of a float of `floatShares`. */
export function stakeImpactPct(sharesBought: number, floatShares: number): number {
  const fraction = clamp01(Math.max(0, sharesBought) / Math.max(1, floatShares));
  return Math.round(100 * STAKE_IMPACT * fraction);
}

/** Execution price for a float purchase: the quote plus its own impact, whole cents. */
export function stakeExecutionPriceUsd(quoteUsd: number, sharesBought: number, floatShares: number): number {
  const impact = stakeImpactPct(sharesBought, floatShares);
  return Math.round(quoteUsd * (1 + impact / 100) * 100) / 100;
}

/** Execution price for a block outside the float: flat double, whole cents. */
export function blockExecutionPriceUsd(quoteUsd: number): number {
  return Math.round(quoteUsd * BLOCK_PREMIUM * 100) / 100;
}

/**
 * Largest number of float shares that can be bought without the execution price
 * passing `limitUsd`. The convex price is what makes a raider decide how fast to
 * move, so the limit has to bind on the *execution* price, not on the quote.
 */
export function sharesWithinLimit(quoteUsd: number, limitUsd: number, floatShares: number): number {
  if (!(quoteUsd > 0) || limitUsd < quoteUsd) return 0;
  const headroom = clamp01((limitUsd / quoteUsd - 1) / STAKE_IMPACT);
  return Math.max(0, Math.floor(headroom * Math.max(0, floatShares)));
}

/** Stake at which a holder gains the information right through the projection layer. */
export const CONTROL_INFORMATION_PCT = 0.25;
/** Stake above which a holder is decisive in the boardroom. Strictly more than half. */
export const CONTROL_DECISIVE_PCT = 0.5;

/** True at 25% or more of an issued class. */
export function grantsInformationRight(sharesHeld: number, issuedShares: number): boolean {
  return issuedShares > 0 && sharesHeld / issuedShares >= CONTROL_INFORMATION_PCT;
}

/**
 * True at 50% + 1 share, and false at exactly 50%.
 *
 * Compared in shares rather than in a rounded percentage on purpose: at exactly
 * half the register a holder is not decisive, and a fraction is not a safe way
 * to say so.
 */
export function grantsControl(sharesHeld: number, issuedShares: number): boolean {
  return issuedShares > 0 && sharesHeld * 2 > issuedShares;
}

/**
 * The one board matter a controlling holder does not decide.
 *
 * A controlling player can still be dismissed as chief executive, which is a
 * better story than a stake that makes its holder unremovable.
 */
export const CONTROL_EXEMPT_PROPOSAL_KINDS = ['ceo_dismissal'] as const;

/* -------------------------------------------------------------------------- */
/*  Attribution — the rows the interface renders                               */
/* -------------------------------------------------------------------------- */

export const MODIFIER_ROW_TONES = ['positive', 'negative', 'neutral'] as const;
export const ModifierRowToneSchema = z.enum(MODIFIER_ROW_TONES).describe('How the row reads: positive is money in, negative is money out, neutral is neither.');
export type ModifierRowTone = z.infer<typeof ModifierRowToneSchema>;

export const ModifierRowSchema = z
  .object({
    key: z.string().min(1).max(60).describe('Stable machine key, e.g. "sector_price" or "logistics_toll". Safe to switch on.'),
    label: z.string().min(1).max(80).describe('What the row says on screen, already written for a phone.'),
    icon: z.string().min(1).max(40).describe('Icon name from the app icon set. Never a monogram.'),
    pct: z.number().int().describe('Signed whole percentage points this row moved the base. -18 means eighteen percent off.'),
    amountUsd: z.number().describe('Signed whole dollars this row moved. The screen adds nothing up itself.'),
    tone: ModifierRowToneSchema,
    causeEventId: z.string().nullable().describe('Committed ledger row this came from, so tapping the row opens the cause. Null only when the base itself is the row.'),
  })
  .describe('One line of an itemised modifier stack. Written by the resolver, never computed by a screen.');
export type ModifierRow = z.infer<typeof ModifierRowSchema>;

export const MODIFIER_STACK_KINDS = ['price', 'cost'] as const;
export const ModifierStackKindSchema = z.enum(MODIFIER_STACK_KINDS).describe('Which side of the income statement the stack itemises.');
export type ModifierStackKind = z.infer<typeof ModifierStackKindSchema>;

export const CompanyModifierStackSchema = z
  .object({
    companyId: z.string().min(1),
    quarter: QuarterIndexSchema,
    kind: ModifierStackKindSchema,
    baseUsd: usd('The figure before any modifier: gross product revenue for a price stack, cash cost of goods for a cost stack.'),
    totalUsd: usd('The figure after every row. Equals baseUsd plus the signed sum of the rows.'),
    netPct: z.number().int().describe('Signed whole percentage change from base to total.'),
    rows: z.array(ModifierRowSchema).max(12).describe('The signed rows, in the order the engine applied them.'),
  })
  .describe('An itemised price or cost stack for one company for one quarter. The V1 surface of the visual contract.');
export type CompanyModifierStack = z.infer<typeof CompanyModifierStackSchema>;

export const AntitrustDriverRowSchema = z
  .object({
    key: z.string().min(1).max(60),
    label: z.string().min(1).max(80),
    points: z.number().int().describe('Signed whole points this driver contributed to the score.'),
    detail: z.string().max(120).describe('The number behind the points, e.g. "34% of sector supply".'),
  })
  .describe('One named driver of the antitrust exposure score. The drill-down Plutocracy never built.');
export type AntitrustDriverRow = z.infer<typeof AntitrustDriverRowSchema>;

export const CompanyExposureSchema = z
  .object({
    companyId: z.string().min(1),
    quarter: QuarterIndexSchema,
    before: z.number().int().min(0).max(100),
    after: z.number().int().min(0).max(100),
    band: AntitrustBandSchema,
    drivers: z.array(AntitrustDriverRowSchema).max(8),
    causeEventId: z.string().nullable(),
  })
  .describe('One company\'s antitrust exposure with its named drivers. Visibility is company-scoped: a rival never sees your exact score.');
export type CompanyExposure = z.infer<typeof CompanyExposureSchema>;

export const SectorPriceRowSchema = z
  .object({
    sector: SectorSchema,
    priceIndex: z.number().int().min(SECTOR_PRICE_BOUNDS.min).max(SECTOR_PRICE_BOUNDS.max),
    priceIndexBefore: z.number().int().min(SECTOR_PRICE_BOUNDS.min).max(SECTOR_PRICE_BOUNDS.max),
    supplyUsd: usd('Annualised revenue of every active company in the sector.'),
    demandUsd: usd('Coupled downstream demand plus end-customer demand.'),
    imbalancePct: z.number().int().min(-100).max(100).describe('Signed whole percentage imbalance. The bar the interface draws.'),
    shortage: z.number().int().min(0).max(SECTOR_SHORTAGE_MAX),
    shortageBefore: z.number().int().min(0).max(SECTOR_SHORTAGE_MAX),
    gatePct: z.number().int().min(0).max(100).describe('Realisation gate this sector faces from its own inputs, as a whole percentage.'),
    endSharePct: z.number().int().min(0).max(100),
    tradeSharePct: z.number().int().min(0).max(100),
    causeEventId: z.string().nullable(),
  })
  .describe('One row of the Sector Flow readout: one number, twin bars, one badge.');
export type SectorPriceRow = z.infer<typeof SectorPriceRowSchema>;

export const RegionTollRowSchema = z
  .object({
    region: RegionSchema,
    tollPct: z.number().int().min(0).max(TOLL_MAX_PCT),
    dominantControllerId: z.string().nullable().describe('Ultimate controller of the region\'s logistics, or null when nobody dominates.'),
    dominantSharePct: z.number().int().min(0).max(100),
    logisticsRevenueUsd: usd('Annualised logistics revenue based in this region.'),
    causeEventId: z.string().nullable(),
  })
  .describe('One region\'s logistics toll, and who is charging it.');
export type RegionTollRow = z.infer<typeof RegionTollRowSchema>;

export const PredationRowSchema = z
  .object({
    companyId: z.string().min(1),
    productId: z.string().min(1),
    segment: ProductSegmentSchema,
    priceUsd: usd('The product\'s own price.'),
    referencePriceUsd: usd('The customer-weighted segment reference it is judged against.'),
    undercutPct: z.number().int().min(0).max(100),
    grossMarginPct: z.number().int().describe('Signed whole percentage. Negative is the half of the predation test that is about cost.'),
    predatoryQuarters: z.number().int().min(0).max(PREDATORY_QUARTERS_MAX),
    exposurePoints: z.number().int().min(0).describe('Antitrust points this predation is worth next time exposure is recomputed.'),
    causeEventId: z.string().nullable(),
  })
  .describe('One flagged predatory price. Public by nature: a price war should move belief.');
export type PredationRow = z.infer<typeof PredationRowSchema>;

export const RivalPressureRowSchema = z
  .object({
    companyId: z.string().min(1).describe('The company being squeezed.'),
    segment: ProductSegmentSchema,
    pressurePct: z.number().int().min(0).max(100).describe('Whole percentage of gross additions lost to predators this quarter.'),
    fromCompanyIds: z.array(z.string()).max(8).describe('Who is doing the squeezing. Naming the attacker is what makes the economy feel populated.'),
    causeEventId: z.string().nullable(),
  })
  .describe('The demand a company lost to rivals dumping in its segment.');
export type RivalPressureRow = z.infer<typeof RivalPressureRowSchema>;

export const DividendPreviewSchema = z
  .object({
    companyId: z.string().min(1),
    quarter: QuarterIndexSchema,
    payoutPct: z.number().int().min(0).max(DIVIDEND_MAX_PAYOUT_PCT),
    netIncomeBasisUsd: signedUsd('Last quarter\'s net income, which is the basis the payout is struck on.'),
    cashUsd: usd('Cash on hand before the payout.'),
    payableUsd: usd('What the policy calls for, before the cash cap.'),
    dividendUsd: usd('What was actually paid, after the cap at half of cash.'),
    retainedUsd: signedUsd('Net income left in the business. The counterfactual the slider preview shows.'),
    perShareUsd: z.number().min(0).describe('Dividend per ordinary share, to the cent.'),
    sharesOutstanding: z.number().int().min(0),
    cappedByCash: z.boolean().describe('True when the cash cap bound rather than the policy.'),
    causeEventId: z.string().nullable(),
  })
  .describe('Everything the Capital screen needs to render a dividend and its now-to-after preview.');
export type DividendPreview = z.infer<typeof DividendPreviewSchema>;

export const ControlStatusSchema = z
  .object({
    companyId: z.string().min(1),
    holderId: z.string().min(1),
    holderKind: HolderKindSchema,
    sharesHeld: z.number().int().min(0),
    issuedShares: z.number().int().min(0),
    stakePct: z.number().int().min(0).max(100).describe('Whole percentage of the issued class. The one number and one target of the Markets card.'),
    hasInformationRight: z.boolean(),
    hasControl: z.boolean(),
    informationThresholdPct: z.number().int().min(0).max(100),
    controlThresholdPct: z.number().int().min(0).max(100),
  })
  .describe('One holder\'s position against the two thresholds that mean something. The V4 surface.');
export type ControlStatus = z.infer<typeof ControlStatusSchema>;

export const EconomyReportSchema = z
  .object({
    quarter: QuarterIndexSchema,
    sectorPrices: z.array(SectorPriceRowSchema).max(12).default([]),
    regionTolls: z.array(RegionTollRowSchema).max(12).default([]),
    priceStacks: z.array(CompanyModifierStackSchema).default([]),
    costStacks: z.array(CompanyModifierStackSchema).default([]),
    exposures: z.array(CompanyExposureSchema).default([]),
    predation: z.array(PredationRowSchema).default([]),
    rivalPressure: z.array(RivalPressureRowSchema).default([]),
    dividends: z.array(DividendPreviewSchema).default([]),
    control: z.array(ControlStatusSchema).default([]),
  })
  .describe(
    'One quarter of itemised economic attribution: the rows every V1-V8 surface renders. Derived state, like companyMetrics — rebuilt every quarter and never accumulated, so a long session stays survivable on a phone. Absent entirely in world version 1.',
  );
export type EconomyReport = z.infer<typeof EconomyReportSchema>;

/** The empty report a quarter starts from. */
export function emptyEconomyReport(quarter: number): EconomyReport {
  return {
    quarter,
    sectorPrices: [],
    regionTolls: [],
    priceStacks: [],
    costStacks: [],
    exposures: [],
    predation: [],
    rivalPressure: [],
    dividends: [],
    control: [],
  };
}

/* -------------------------------------------------------------------------- */
/*  Selectors                                                                  */
/* -------------------------------------------------------------------------- */

/** The price stack for one company, or null when the quarter wrote none. */
export function priceStackFor(report: EconomyReport | null | undefined, companyId: string): CompanyModifierStack | null {
  return report?.priceStacks.find((stack) => stack.companyId === companyId) ?? null;
}

/** The cost stack for one company, or null. */
export function costStackFor(report: EconomyReport | null | undefined, companyId: string): CompanyModifierStack | null {
  return report?.costStacks.find((stack) => stack.companyId === companyId) ?? null;
}

/** The exposure card for one company, or null. */
export function exposureFor(report: EconomyReport | null | undefined, companyId: string): CompanyExposure | null {
  return report?.exposures.find((entry) => entry.companyId === companyId) ?? null;
}

/** The dividend preview for one company, or null. */
export function dividendFor(report: EconomyReport | null | undefined, companyId: string): DividendPreview | null {
  return report?.dividends.find((entry) => entry.companyId === companyId) ?? null;
}

/** One sector's ladder row, or null. */
export function sectorRowFor(report: EconomyReport | null | undefined, sector: Sector): SectorPriceRow | null {
  return report?.sectorPrices.find((row) => row.sector === sector) ?? null;
}

/** One region's toll row, or null. */
export function regionTollRowFor(report: EconomyReport | null | undefined, region: Region): RegionTollRow | null {
  return report?.regionTolls.find((row) => row.region === region) ?? null;
}

/** The pressure a company is under in one segment, or null when nobody is squeezing it. */
export function rivalPressureFor(report: EconomyReport | null | undefined, companyId: string, segment: string): RivalPressureRow | null {
  return report?.rivalPressure.find((row) => row.companyId === companyId && row.segment === segment) ?? null;
}

/** Every control row for one company, largest stake first. */
export function controlRowsFor(report: EconomyReport | null | undefined, companyId: string): readonly ControlStatus[] {
  return (report?.control ?? []).filter((row) => row.companyId === companyId);
}
