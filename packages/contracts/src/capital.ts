/**
 * @frontier/contracts — capital.ts
 *
 * Venture, buyout, hedge and sovereign funds as **actors**: `CapitalEntity`.
 *
 * The identity rule, and it governs everything else in this module:
 *
 * > `CapitalEntity.id` **is** the holder id already on the cap tables —
 * > `fund_seawall`, `fund_tessera`, and so on. An entity is not a new owner; it
 * > is the thing that was always at the other end of those `holderKind: 'fund'`
 * > holdings.
 *
 * Consequences, stated because they are what keep this cheap and safe:
 *
 * - Every long position a fund holds is an ordinary `Holding`. There is **no
 *   second ownership ledger**, so `CAP_TABLE_INVARIANT` is untouched.
 * - Every fund vote is already counted by the board tally, because the fund's
 *   partner already sits as a `Director` whose `representedHolderId` is this id.
 * - `deployedUsd`, `navUsd`, `dpiPct`, `lpPressure` and the stance a player sees
 *   are **derived every quarter** (see `CapitalEntityRow` in `economy.ts`) and
 *   never stored, exactly as `companyMetrics` and `EconomyReport` are. A stored
 *   copy drifts the first time a cost basis is rebased.
 * - A short is **never** a holding: `Holding.shares` stays non-negative, and a
 *   short is a separate cash-settled exposure that neither votes nor counts
 *   toward an ownership percentage. See `SHORT_LEDGER_INVARIANT`.
 *
 * World version 1 is frozen: it grows no `capitalEntities`, no `shortPositions`
 * and no `capitalOrders`, which is why every one of those fields on
 * `SessionState` is `.optional()` rather than `.default([])`. An absent key is
 * the neutral reading and hashes exactly as it always has.
 */

import { z } from 'zod';
import { QuarterIndexSchema, intCount, usd } from './ids';
import { RegionSchema, SECTORS } from './sectors';
import { FundingStageSchema, type FundingStage } from './ownership';
import type { BoardProposalKind } from './governance';
import type { SimEventType } from './sim';

/* -------------------------------------------------------------------------- */
/*  Appendix A — the constants, in one block                                   */
/*                                                                            */
/*  Every number the capital desks run on lives here and nowhere else. The     */
/*  balance pass is allowed to change any value in this block and nothing      */
/*  else, which is what makes tuning a separate, low-risk change.              */
/*  All whole numbers or whole percentages, all bounded on both sides.         */
/* -------------------------------------------------------------------------- */

/** Hard ceiling on entities in one session. State size, and the size of The Street. */
export const MAX_CAPITAL_ENTITIES = 12;

/** Orders + deals + board proposals every desk in the world may produce in one quarter. */
export const CAPITAL_DESK_ORDER_BUDGET = 40;

/** Ten years. A fund that reaches term is a forced seller, and that is a buying window. */
export const FUND_TERM_QUARTERS = 40;
/** Five years. After it, the fund harvests rather than deploys. */
export const INVESTMENT_PERIOD_QUARTERS = 20;
/** 2%/yr on committed capital, charged out of dry powder. This is the J-curve. */
export const MANAGEMENT_FEE_PCT_PER_QUARTER = 0.5;
/** Carried interest on realised gains above cost. */
export const CARRY_PCT = 20;
/** Share of committed capital a fund never deploys, whatever the score says. */
export const DRY_POWDER_FLOOR_PCT = 5;

/** Per instrument, session-wide, as a percentage of float. */
export const SHORT_INTEREST_CAP_PCT = 20;
/** Dry powder posted as margin when a short opens. */
export const SHORT_MARGIN_PCT = 50;
/** Below this share of current notional the position is force-covered in full. */
export const SHORT_MAINTENANCE_PCT = 30;
/** A short position this large, as a percentage of float, becomes public. */
export const SHORT_DISCLOSURE_PCT = 5;
/** Borrow fee at zero utilisation, whole percent per quarter. */
export const BORROW_FEE_MIN_PCT = 1;
/** Borrow fee at the short-interest cap, whole percent per quarter. A crowded short bleeds. */
export const BORROW_FEE_MAX_PCT = 20;

/** Quarter return at or above which a squeeze can fire. */
export const SQUEEZE_RETURN_TRIGGER_PCT = 15;
/** Short interest at or above which a squeeze can fire. */
export const SQUEEZE_MIN_SHORT_INTEREST_PCT = 10;
/** Share of every open position force-covered when a squeeze fires. */
export const SQUEEZE_COVER_SHARE_PCT = 25;

/** Sourcing score at or above which a venture fund writes a term sheet. */
export const VC_TERM_SHEET_FLOOR = 62;
/** Term sheets one fund may offer in one quarter. */
export const VC_TERM_SHEETS_PER_QUARTER = 2;
/** Quarters before the same fund may offer the same company again. */
export const VC_REOFFER_COOLDOWN_QUARTERS = 4;
/** Full width of the price multiplier, as a percentage: 0.70x at the floor, 1.60x at 100. */
export const VC_PRICE_STRETCH_PCT = 60;
/** Unrealised multiple a fund holds out for, and the reduced target under LP pressure. */
export const TARGET_MULTIPLE = 3;
export const TARGET_MULTIPLE_UNDER_PRESSURE = 2;
/** LP pressure at or above which the reduced target and the shortened horizon apply. */
export const LP_PRESSURE_HARVEST_FLOOR = 40;
/** LP pressure at or above which the fund stops offering and starts selling down. */
export const LP_PRESSURE_SELLING_FLOOR = 60;
/** LP pressure at or above which the fund sells regardless of the limit price. */
export const LP_PRESSURE_FORCED_FLOOR = 85;
/** Share of a position sold per quarter once it is being exited. */
export const EXIT_TRANCHE_PCT = 25;
/** IPO window at or above which a venture fund tables an `ipo` board proposal. */
export const IPO_WINDOW_FLOOR = 0.3;

/** Target score at or above which a buyout fund approaches. */
export const PE_APPROACH_FLOOR = 66;
/** Trailing revenue below which a company is too small to be a buyout target. */
export const PE_MIN_REVENUE_USD = 200_000_000;
/** Premium over the higher of market cap and fundamental anchor, on the first approach. */
export const PE_CONTROL_PREMIUM_PCT = 25;
/** Extra premium when a private approach is made public. */
export const BEAR_HUG_BUMP_PCT = 10;
/** The premium ceiling. No sequence of bumps goes past it. */
export const PE_MAX_PREMIUM_PCT = 60;
/** Quarters before the same fund may approach the same target again. */
export const PE_REAPPROACH_COOLDOWN_QUARTERS = 6;
/** LBO debt placed on the target, as a percentage of its trailing revenue. */
export const LBO_DEBT_TO_REVENUE_PCT = 100;
/** Spread over the target's offered debt rate, in whole percentage points. */
export const LBO_SPREAD_PCT = 2;
/** Incremental debt raised in a dividend recap, as a percentage of revenue. */
export const RECAP_DEBT_TO_REVENUE_PCT = 50;
/** Payout policy a recap sets. */
export const RECAP_PAYOUT_PCT = 60;
/** Headcount cut from one role per quarter during an operational squeeze. */
export const PE_SQUEEZE_LAYOFF_PCT = 8;
/** How many quarters a squeeze runs before the sponsor has to grow the business instead. */
export const PE_SQUEEZE_QUARTERS = 4;

/** Dilution a rights plan inflicts on the raider, and only the raider. */
export const POISON_PILL_DILUTION_PCT = 20;
/** Quarters a controlling holder waits before a staggered board becomes decisive. */
export const STAGGERED_DELAY_QUARTERS = 2;
/** A white knight counter-bids this far over the standing offer. */
export const WHITE_KNIGHT_BUMP_PCT = 5;

/** Conviction at or above which a hedge fund goes long. */
export const LONG_CONVICTION_FLOOR = 25;
/** Conviction at or below which a hedge fund goes short. */
export const SHORT_CONVICTION_FLOOR = -25;
/** One position may absorb this much of dry powder. */
export const POSITION_SIZE_PCT = 15;
/** One position may reach this much of a company's float. */
export const FLOAT_SIZE_PCT = 10;
/** Size of a merger-arbitrage leg, as a percentage of dry powder. */
export const ARB_SIZE_PCT = 5;
/** Event-driven trades one fund may place in one quarter. */
export const EVENT_TRADES_PER_QUARTER = 2;
/** Conviction at or below which a short report is publishable. */
export const SHORT_REPORT_CONVICTION_FLOOR = -55;
/** Quarters between short reports from the same fund. */
export const SHORT_REPORT_COOLDOWN_QUARTERS = 4;
/** Window in which a published report is judged against the target's anchor. */
export const SHORT_REPORT_JUDGEMENT_QUARTERS = 4;
/** Anchor move, either way, that counts as the report being right or wrong. */
export const SHORT_REPORT_JUDGEMENT_MOVE_PCT = 10;
/** Track record moves. Asymmetric on purpose: crying wolf costs more than being right earns. */
export const SHORT_REPORT_HIT_TRACK_RECORD = 8;
export const SHORT_REPORT_MISS_TRACK_RECORD = -12;

/** Stake at which an activist campaign may open, and the ladder above it. */
export const ACTIVIST_OPEN_STAKE_PCT = 10;
export const ACTIVIST_PUBLIC_STAKE_PCT = 15;
export const ACTIVIST_PROXY_STAKE_PCT = 25;
/** Conviction that must hold for two consecutive quarters before a campaign opens. */
export const ACTIVIST_CONVICTION_FLOOR = 40;
/** Support share at or above which the target settles rather than fights. */
export const ACTIVIST_SETTLEMENT_SUPPORT_PCT = 40;
/** Quarters a closed campaign is kept on state before it is pruned. */
export const ACTIVIST_CAMPAIGN_PRUNE_QUARTERS = 12;

/** Band, either side, inside which a countered term sheet is accepted. */
export const COUNTER_BAND_PCT = 20;
/** Model utterances the whole capital layer may spend in one quarter. Everything else is templated. */
export const CAPITAL_PARTNER_UTTERANCES_PER_QUARTER = 2;
/** The sovereign charter: never above this share of any company, so it never takes control. */
export const SOVEREIGN_CHARTER_CAP_PCT = 25;
/** The sovereign holds for fifteen years and has no LPs, so its LP pressure is permanently zero. */
export const SOVEREIGN_EXIT_HORIZON_QUARTERS = 60;
/** Risk appetite below which the sovereign doubles its cheque: the buyer of last resort. */
export const SOVEREIGN_COUNTERCYCLICAL_RISK_APPETITE = 0.35;

/** Entries of per-entity memory kept on state. Bounded, like every other history in the engine. */
export const CAPITAL_ENTITY_MEMORY_LIMIT = 24;

/**
 * Cheque size as a percentage of committed capital, by stage. The five stages
 * the design names are exact; `series_d`, `series_e` and `bridge` are filled in
 * on the same curve so the map is total over `FUNDING_STAGES`.
 */
export const VC_CHEQUE_PCT_OF_AUM: Readonly<Record<FundingStage, number>> = {
  pre_seed: 1,
  seed: 1,
  series_a: 2,
  series_b: 4,
  series_c: 6,
  series_d: 8,
  series_e: 8,
  growth: 8,
  bridge: 2,
};

/** A cheque may never exceed this share of the fund's remaining dry powder. */
export const VC_CHEQUE_MAX_DRY_POWDER_PCT = 25;

/* -------------------------------------------------------------------------- */
/*  The entity                                                                 */
/* -------------------------------------------------------------------------- */

export const CAPITAL_ENTITY_KINDS = ['vc', 'pe', 'hedge_fund', 'sovereign'] as const;

export const CapitalEntityKindSchema = z
  .enum(CAPITAL_ENTITY_KINDS)
  .describe(
    'What sort of institution this is. "vc" writes primary cheques into private companies and lives on a fund clock. "pe" buys control, leverages, squeezes and rolls up. "hedge_fund" trades both sides of the quoted market and agitates from a minority stake. "sovereign" is patient, long-only, never hostile and bound by a charter cap that stops it ever taking control. A bank is not one of these: a bank has revenue, staff and products, so a bank is a Company.',
  );
export type CapitalEntityKind = z.infer<typeof CapitalEntityKindSchema>;

export const CAPITAL_MEMORY_KINDS = [
  'term_sheet_offered',
  'approach_made',
  'short_report_published',
  'campaign_closed',
  'position_exited',
] as const;

export const CapitalMemoryKindSchema = z
  .enum(CAPITAL_MEMORY_KINDS)
  .describe('What the desk did. This is the cooldown ledger as well as the audit trail: a re-offer, a re-approach and a second report are all gated on the quarter recorded here.');
export type CapitalMemoryKind = z.infer<typeof CapitalMemoryKindSchema>;

export const CAPITAL_MEMORY_OUTCOMES = ['pending', 'accepted', 'rejected', 'lapsed', 'right', 'wrong'] as const;
export const CapitalMemoryOutcomeSchema = z
  .enum(CAPITAL_MEMORY_OUTCOMES)
  .describe('How it ended. "right"/"wrong" are reserved for a published short report judged against the target\'s anchor within the judgement window.');
export type CapitalMemoryOutcome = z.infer<typeof CapitalMemoryOutcomeSchema>;

export const CapitalEntityMemorySchema = z
  .object({
    companyId: z.string().min(1).describe('Company the act was aimed at.'),
    kind: CapitalMemoryKindSchema,
    quarter: QuarterIndexSchema.describe('Quarter the act happened. Every cooldown in this module is measured against it.'),
    outcome: CapitalMemoryOutcomeSchema,
    note: z.string().max(120).describe('One short line for the drawer on The Street. Never prose the engine reads.'),
  })
  .describe('One thing this desk did, kept so cooldowns and reputations are decided from state rather than from a re-scan of the ledger.');
export type CapitalEntityMemory = z.infer<typeof CapitalEntityMemorySchema>;

/**
 * A fund's vintage, which is the one quarter index in the game that may be
 * **negative**: an institution on the opening register was struck years before
 * the session opened, and a roster whose funds all vintage at quarter 0 would
 * start every clock at zero and leave LP pressure inert for thirty-four
 * quarters. A negative vintage is read only by the age arithmetic below; it
 * never indexes a quarter of history, so nothing else needs to widen.
 */
export const FundVintageQuarterSchema = z
  .number()
  .int()
  .min(-200)
  .max(4000)
  .describe('Quarter the fund was struck. Negative for a fund that existed before the session opened, which is how the opening roster carries eleven institutions at eleven different points on the clock.');

/** Whole 0..100 score, integer. Every score in this module uses the same scale and the same three bands. */
const capitalScore = (description: string) => z.number().int().min(0).max(100).describe(`${description} Whole number from 0 (lowest) to 100 (highest).`);

/** A whole-dollar amount. Funds deal in round numbers; the UI prints whole numbers only. */
const wholeUsd = (description: string) => usd(description).int();

export const CapitalEntitySchema = z
  .object({
    id: z
      .string()
      .min(1)
      .describe('The entity id, which IS the cap-table holder id: "fund_seawall", "fund_qadr". Never a new id. Every holding, every vote and every block premium already reaches this string.'),
    name: z.string().min(1).max(80).describe('Display name, e.g. "Seawall Capital".'),
    kind: CapitalEntityKindSchema,
    region: RegionSchema.describe('Where the institution is based. Sets which companies it sees first and which regulator it answers to.'),
    sectorAffinity: z
      .record(z.string(), capitalScore('Appetite for this sector.'))
      .describe('Appetite per sector, keyed by sector id, whole numbers 0..100. One key per entry of SECTORS; a missing key reads as zero appetite.'),
    stageBand: z
      .tuple([FundingStageSchema, FundingStageSchema])
      .describe('Inclusive [earliest, latest] funding stage this fund writes into. Venture only; every other kind carries ["growth","growth"] and never uses it.'),
    thesis: z.string().min(1).max(160).describe('One line, printed verbatim on The Street card. The only free text on the entity.'),

    committedCapitalUsd: wholeUsd('Assets under management. Fixed for the life of the vintage: a fund does not raise mid-term in this game.'),
    dryPowderUsd: wholeUsd('Uncalled, undeployed capital. The ONLY stored cash figure on an entity, and the one number that says how much they can still do to you.'),
    realisedProceedsUsd: wholeUsd('Cumulative cash back from exits. The numerator of DPI, which is what LPs judge a fund on.').default(0),
    feesPaidUsd: wholeUsd('Cumulative management fees charged out of dry powder.').default(0),
    borrowFeesPaidUsd: wholeUsd('Cumulative stock-borrow cost paid out of dry powder.').default(0),
    carryPaidUsd: wholeUsd('Cumulative carried interest paid to the partners.').default(0),

    vintageQuarter: FundVintageQuarterSchema.describe('Quarter the fund was struck. Age, and therefore LP pressure, is measured from here.').default(0),
    termQuarters: z.number().int().min(1).max(200).describe('Fund life. LP pressure reaches 100 here with nothing returned.').default(FUND_TERM_QUARTERS),
    investmentPeriodQuarters: z.number().int().min(1).max(200).describe('Quarters of deployment before the fund harvests.').default(INVESTMENT_PERIOD_QUARTERS),
    exitHorizonQuarters: z.number().int().min(1).max(200).describe('Target hold length per position, before LP pressure shortens it.').default(INVESTMENT_PERIOD_QUARTERS),

    riskAppetite: capitalScore('How far from the fundamental anchor this desk will price.'),
    trackRecord: capitalScore('Reputation. Moves on realised outcomes and on whether published reports were right. Weights the credibility of anything this fund publishes.').default(50),
    partnerCharacterIds: z
      .array(z.string().min(1))
      .min(1)
      .max(3)
      .describe('The partners, as ordinary Character ids with role "investor". Relationships, memory, connection level and board seats all live on those people; this module invents no person layer of its own.'),
    memory: z
      .array(CapitalEntityMemorySchema)
      .max(CAPITAL_ENTITY_MEMORY_LIMIT)
      .describe('Bounded history of this desk\'s own acts, newest last. Pruned to CAPITAL_ENTITY_MEMORY_LIMIT entries so a forty-quarter session stays a phone-sized save.')
      .default([]),
    isActive: z.boolean().describe('False once the fund is wound up. An inactive entity still owns its holdings; it simply stops acting.').default(true),
  })
  .describe(
    'One institution that allocates capital. NAV, DPI, LP pressure, deployed capital, portfolio and stance are all DERIVED every quarter into the economy report and are deliberately absent here: a stored copy drifts the first moment a cost basis is rebased.',
  );
export type CapitalEntity = z.infer<typeof CapitalEntitySchema>;

/* -------------------------------------------------------------------------- */
/*  Lifecycle arithmetic — pure, whole numbers, no draw                        */
/* -------------------------------------------------------------------------- */

const clampInt = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, Math.round(value)));

/** Quarters since the vintage. Never negative. */
export function fundAgeQuarters(entity: Pick<CapitalEntity, 'vintageQuarter'>, quarter: number): number {
  return Math.max(0, Math.trunc(quarter) - entity.vintageQuarter);
}

/**
 * Distributions to paid-in, as a whole percentage, capped at 200.
 * Cash actually returned, which is the only thing LPs count from year six on.
 */
export function dpiPct(entity: Pick<CapitalEntity, 'realisedProceedsUsd' | 'committedCapitalUsd'>): number {
  return clampInt((100 * entity.realisedProceedsUsd) / Math.max(1, entity.committedCapitalUsd), 0, 200);
}

/**
 * LP pressure, 0..100. Zero at the vintage, fifty at the end of the investment
 * period with nothing returned, one hundred at term — and every ten points of
 * DPI knocks ten points off it.
 *
 * The sovereign has no LPs, so its pressure is permanently zero. That is a
 * property of the kind, not a special case in the caller.
 */
export function lpPressureFor(
  entity: Pick<CapitalEntity, 'kind' | 'vintageQuarter' | 'termQuarters' | 'realisedProceedsUsd' | 'committedCapitalUsd'>,
  quarter: number,
): number {
  if (entity.kind === 'sovereign') return 0;
  const age = fundAgeQuarters(entity, quarter);
  const term = Math.max(1, entity.termQuarters);
  return clampInt((100 * age) / term - dpiPct(entity), 0, 100);
}

export const LP_PRESSURE_BANDS = ['calm', 'harvesting', 'forced'] as const;
export const LpPressureBandSchema = z
  .enum(LP_PRESSURE_BANDS)
  .describe('The three-band reading of LP pressure the meter shows: "calm" is a patient backer, "harvesting" is an investor asking about the exit, "forced" is a seller who does not care what you pay.');
export type LpPressureBand = z.infer<typeof LpPressureBandSchema>;

/** The band a pressure reading falls in. Same three bands as every other 0..100 score in the game. */
export function lpPressureBand(lpPressure: number): LpPressureBand {
  if (lpPressure >= LP_PRESSURE_FORCED_FLOOR) return 'forced';
  if (lpPressure >= LP_PRESSURE_HARVEST_FLOOR) return 'harvesting';
  return 'calm';
}

/** The unrealised multiple a fund holds out for, which falls once LPs start counting. */
export function targetMultipleFor(lpPressure: number): number {
  return lpPressure >= LP_PRESSURE_HARVEST_FLOOR ? TARGET_MULTIPLE_UNDER_PRESSURE : TARGET_MULTIPLE;
}

/** Quarterly management fee, in whole dollars, charged on committed capital out of dry powder. */
export function managementFeeUsd(entity: Pick<CapitalEntity, 'committedCapitalUsd'>): number {
  return Math.round((entity.committedCapitalUsd * MANAGEMENT_FEE_PCT_PER_QUARTER) / 100);
}

/** Capital the fund may never deploy, whatever the score says. */
export function dryPowderFloorUsd(entity: Pick<CapitalEntity, 'committedCapitalUsd'>): number {
  return Math.round((entity.committedCapitalUsd * DRY_POWDER_FLOOR_PCT) / 100);
}

/* -------------------------------------------------------------------------- */
/*  Shorts: one new ledger, cash-settled, never on the register                 */
/* -------------------------------------------------------------------------- */

/**
 * The design of this schema is decided by one constraint: the ownership
 * invariant sums `holdings.shares` per class against `totalIssuedByClass`. A
 * negative holding would either break that sum or force the invariant to
 * special-case a sign, and that invariant is the spine of the game.
 *
 * So `Holding.shares` stays non-negative and a short is never a holding. It is a
 * separate cash-settled exposure that never votes, never counts toward an
 * ownership percentage, and never touches a company's balance sheet.
 *
 * The honest note, stated once: a real short borrows a specific lender's shares
 * and sells them to a real buyer. We do not model the borrow leg — only the
 * price of borrowing and the pressure of covering, which is where the gameplay
 * is. The cost is that short interest never appears on the register; the benefit
 * is that the one invariant everything else rests on is not touched.
 */
export const ShortPositionSchema = z
  .object({
    id: z.string().min(1).describe('Short position id.'),
    entityId: z.string().min(1).describe('The CapitalEntity that is short. Also the cap-table holder id, though this position is not on the cap table.'),
    securityId: z.string().min(1).describe('Security being shorted.'),
    instrumentId: z.string().min(1).describe('Quoted instrument the position marks against.'),
    companyId: z.string().min(1).describe('Company the security belongs to, denormalised so the feed and the drawer need no join.'),
    shares: intCount('Shares short. ALWAYS POSITIVE: the direction is carried by the type, never by a sign. Nothing anywhere in the engine may negate this number onto a holding.'),
    openedQuarter: QuarterIndexSchema,
    openPriceUsd: z.number().min(0).finite().describe('The quote the position was struck at, in dollars per share.'),
    markPriceUsd: z.number().min(0).finite().describe('Last quarter\'s mark, in dollars per share. The P&L step reads this and then overwrites it.'),
    marginPostedUsd: wholeUsd('Dry powder posted against the position. Falling below SHORT_MAINTENANCE_PCT of current notional force-covers it in full, at the quote, immediately.'),
    borrowFeePctPerQuarter: z
      .number()
      .int()
      .min(BORROW_FEE_MIN_PCT)
      .max(BORROW_FEE_MAX_PCT)
      .describe('Whole percent of notional charged every quarter out of dry powder. Recomputed every quarter from utilisation: 1% when nobody else is short, 20% at the cap. A crowded short bleeds; a lonely one is nearly free.')
      .default(BORROW_FEE_MIN_PCT),
    isDisclosed: z
      .boolean()
      .describe('True once the position crossed SHORT_DISCLOSURE_PCT of float and became public. Below that it is ABSENT from every projection — redaction, never repair.')
      .default(false),
  })
  .describe('One cash-settled short exposure. Never a Holding, never a vote, never part of an ownership percentage.');
export type ShortPosition = z.infer<typeof ShortPositionSchema>;

/** Machine-readable statement of the short-ledger invariant, for tests and docs. */
export const SHORT_LEDGER_INVARIANT = {
  id: 'shorts_are_not_holdings',
  statement:
    'A ShortPosition never appears in CapTable.holdings, contributes zero votes and zero economic ownership, and moves no company balance sheet. Holding.shares stays >= 0 and sum(holdings.shares) per class still equals totalIssuedByClass. Per instrument, sum(shortPositions.shares) <= floatShares * SHORT_INTEREST_CAP_PCT / 100.',
  enforcedAt: 'quarter_commit',
  onFailure: 'The quarter does not commit. The engine emits a ledger rejection and restores the pre-resolution snapshot.',
} as const;

/** Whole-percentage short interest against a float. Zero when there is no float to be short of. */
export function shortInterestPctOf(sharesShort: number, floatShares: number): number {
  if (floatShares <= 0) return 0;
  return clampInt((100 * sharesShort) / floatShares, 0, 100);
}

/**
 * Borrow cost as a whole percent of notional per quarter: 1% at zero
 * utilisation, 20% at the cap. Non-decreasing in short interest and always
 * inside [BORROW_FEE_MIN_PCT, BORROW_FEE_MAX_PCT].
 */
export function borrowFeePctFor(shortInterestPct: number): number {
  const utilisation = Math.max(0, shortInterestPct) / SHORT_INTEREST_CAP_PCT;
  const span = BORROW_FEE_MAX_PCT - BORROW_FEE_MIN_PCT;
  return clampInt(BORROW_FEE_MIN_PCT + span * utilisation, BORROW_FEE_MIN_PCT, BORROW_FEE_MAX_PCT);
}

/** Shares that may still be sold short in an instrument before the cap binds. */
export function shortHeadroomShares(sharesAlreadyShort: number, floatShares: number): number {
  const cap = Math.floor((floatShares * SHORT_INTEREST_CAP_PCT) / 100);
  return Math.max(0, cap - Math.max(0, sharesAlreadyShort));
}

/**
 * A squeeze is a consequence, never an event draw: a rising price and a crowded
 * short force covering, and the covering pushes the price further through the
 * liquidity term the market phase already clamps.
 */
export function squeezeTriggered(quarterReturnPct: number, shortInterestPct: number): boolean {
  return quarterReturnPct >= SQUEEZE_RETURN_TRIGGER_PCT && shortInterestPct >= SQUEEZE_MIN_SHORT_INTEREST_PCT;
}

/** True when a position has fallen through maintenance and must be closed in full this quarter. */
export function shortBreachesMaintenance(position: Pick<ShortPosition, 'shares' | 'marginPostedUsd'>, markPriceUsd: number): boolean {
  const notional = position.shares * markPriceUsd;
  return position.marginPostedUsd < (notional * SHORT_MAINTENANCE_PCT) / 100;
}

export const SHORT_COVER_REASONS = ['target', 'squeeze', 'margin', 'horizon'] as const;
export const ShortCoverReasonSchema = z
  .enum(SHORT_COVER_REASONS)
  .describe('Why a short closed. "target" is the thesis paying off, "squeeze" and "margin" are forced, "horizon" is the desk giving up on a position that stopped bleeding into a profit.');
export type ShortCoverReason = z.infer<typeof ShortCoverReasonSchema>;

/* -------------------------------------------------------------------------- */
/*  Activism                                                                   */
/* -------------------------------------------------------------------------- */

export const ACTIVIST_CAMPAIGN_STAGES = ['private_letter', 'public_letter', 'board_demand', 'proxy_fight'] as const;
export const ActivistCampaignStageSchema = z
  .enum(ACTIVIST_CAMPAIGN_STAGES)
  .describe(
    'The ladder, in order. "private_letter" at 10% is a confidential deal proposal carrying the demands; "public_letter" at 15% is a disclosure and a post; "board_demand" needs a seat or a friendly director and tables a real proposal; "proxy_fight" at 25% takes it to a vote the fund can block or, at 50% + 1, carry. A stage is never skipped.',
  );
export type ActivistCampaignStage = z.infer<typeof ActivistCampaignStageSchema>;

export const ACTIVIST_DEMANDS = ['sell_the_company', 'replace_ceo', 'cut_costs', 'return_capital', 'split_the_business'] as const;
export const ActivistDemandSchema = z
  .enum(ACTIVIST_DEMANDS)
  .describe('What the activist wants. Five entries, each mapping to a board proposal kind that already exists, so a campaign never needs a new governance verb.');
export type ActivistDemand = z.infer<typeof ActivistDemandSchema>;

/** Every demand maps to a proposal kind the board already knows how to resolve. */
export const ACTIVIST_DEMAND_PROPOSAL_KIND: Readonly<Record<ActivistDemand, BoardProposalKind>> = {
  sell_the_company: 'divestiture',
  replace_ceo: 'ceo_dismissal',
  cut_costs: 'restructuring',
  return_capital: 'dividend',
  split_the_business: 'divestiture',
};

export const ACTIVIST_CAMPAIGN_OUTCOMES = ['settled', 'won', 'defeated', 'withdrawn'] as const;
export const ActivistCampaignOutcomeSchema = z
  .enum(ACTIVIST_CAMPAIGN_OUTCOMES)
  .describe('How a campaign ended. Settlement is the common outcome by design: most real campaigns end in a negotiated seat, and here that is decided by the board tally rather than by a draw.');
export type ActivistCampaignOutcome = z.infer<typeof ActivistCampaignOutcomeSchema>;

export const ActivistCampaignSchema = z
  .object({
    id: z.string().min(1),
    entityId: z.string().min(1).describe('The activist. Always a CapitalEntity id.'),
    targetCompanyId: z.string().min(1),
    stage: ActivistCampaignStageSchema,
    demands: z.array(ActivistDemandSchema).min(1).max(3).describe('What is being demanded. Conceding one closes the campaign as "settled" and costs one board seat.'),
    openedQuarter: QuarterIndexSchema,
    lastEscalatedQuarter: QuarterIndexSchema.describe('Quarter the stage last moved. An escalation is never twice in the same quarter.'),
    stakePct: z.number().int().min(0).max(100).describe('The activist\'s whole-percentage stake at the last escalation. The gate on every rung of the ladder.'),
    convictionPct: z.number().int().min(-100).max(100).describe('Engine-computed conviction that opened the campaign. Never model output.'),
    seatsGranted: intCount('Board seats conceded so far.').default(0),
    outcome: ActivistCampaignOutcomeSchema.nullable().describe('Null while the campaign is live.').default(null),
    closedQuarter: QuarterIndexSchema.nullable().describe('Quarter it closed, or null. Closed campaigns are pruned ACTIVIST_CAMPAIGN_PRUNE_QUARTERS later.').default(null),
  })
  .describe('One activist campaign, from the private letter to the ballot. Every rung is gated on a stake threshold the player can watch climbing.');
export type ActivistCampaign = z.infer<typeof ActivistCampaignSchema>;

/** The stake a rung requires. Pure; the desks read it, the surfaces print it. */
export function activistStakeGatePct(stage: ActivistCampaignStage): number {
  switch (stage) {
    case 'private_letter':
      return ACTIVIST_OPEN_STAKE_PCT;
    case 'public_letter':
    case 'board_demand':
      return ACTIVIST_PUBLIC_STAKE_PCT;
    case 'proxy_fight':
      return ACTIVIST_PROXY_STAKE_PCT;
  }
}

/* -------------------------------------------------------------------------- */
/*  Orders                                                                     */
/* -------------------------------------------------------------------------- */

export const CAPITAL_ORDER_KINDS = ['buy', 'sell', 'short_open', 'short_cover', 'publish_report', 'campaign_step'] as const;

export const CAPITAL_ORDER_REASONS = ['conviction', 'follow_on', 'exit', 'lp_pressure', 'tender', 'arbitrage', 'charter'] as const;
export const CapitalOrderReasonSchema = z
  .enum(CAPITAL_ORDER_REASONS)
  .describe('Why the desk wrote the order. Printed on the drawer line and on the feed item, so a fund move is never unexplained.');
export type CapitalOrderReason = z.infer<typeof CapitalOrderReasonSchema>;

const orderBase = {
  id: z.string().min(1).describe('Deterministic order id.'),
  entityId: z.string().min(1),
  quarter: QuarterIndexSchema.describe('Quarter the desk wrote it. Orders are cleared at ledger_commit, exactly like pendingActions.'),
};

export const CapitalOrderSchema = z
  .discriminatedUnion('kind', [
    z
      .object({
        ...orderBase,
        kind: z.literal('buy'),
        securityId: z.string().min(1),
        companyId: z.string().min(1),
        shares: intCount('Shares sought. Already capped by dry powder, by FLOAT_SIZE_PCT of float and by last quarter\'s traded volume before it reaches here.'),
        limitPriceUsd: z.number().min(0).finite().nullable().describe('Highest price per share the desk will pay, or null to take the quote.'),
        reason: CapitalOrderReasonSchema,
      })
      .describe('Accumulate a long position through the same settlement path every other buyer uses.'),
    z
      .object({
        ...orderBase,
        kind: z.literal('sell'),
        securityId: z.string().min(1),
        companyId: z.string().min(1),
        shares: intCount('Shares offered.'),
        limitPriceUsd: z.number().min(0).finite().nullable().describe('Lowest price the desk will take, or null. A forced seller sets this to null and means it.'),
        reason: CapitalOrderReasonSchema,
        isForced: z.boolean().describe('True when LP pressure is at or above LP_PRESSURE_FORCED_FLOOR: the tranche goes regardless of the limit price. This is the best buying window in the game, and it is visible four quarters out.'),
      })
      .describe('Sell down a long position, moving the price through the ordinary liquidity term like anyone else.'),
    z
      .object({
        ...orderBase,
        kind: z.literal('short_open'),
        securityId: z.string().min(1),
        instrumentId: z.string().min(1),
        companyId: z.string().min(1),
        shares: intCount('Shares to sell short. Already inside the per-instrument cap when the order is written.'),
        marginUsd: wholeUsd('Dry powder to post, SHORT_MARGIN_PCT of notional.'),
      })
      .describe('Open a cash-settled short. Struck at this quarter\'s quote; the P&L lands next quarter, which is what makes it plannable.'),
    z
      .object({
        ...orderBase,
        kind: z.literal('short_cover'),
        positionId: z.string().min(1).describe('The ShortPosition being covered.'),
        shares: intCount('Shares to buy back. Equal to the position size on a forced cover.'),
        reason: ShortCoverReasonSchema,
      })
      .describe('Cover a short, in whole or in part.'),
    z
      .object({
        ...orderBase,
        kind: z.literal('publish_report'),
        companyId: z.string().min(1),
        beliefTopic: z.string().min(1).max(60).describe('The belief the report argues for, chosen from the fundamental that drove the gap. The engine owns the belief delta; a model owns only the prose.'),
        credibilityPct: z.number().int().min(0).max(100).describe('Engine-computed credibility from track record and past hit rate. Never model output.'),
      })
      .describe('Publish a short report as an ordinary public disclosure, and be judged on it four quarters later.'),
    z
      .object({
        ...orderBase,
        kind: z.literal('campaign_step'),
        campaignId: z.string().min(1),
        toStage: ActivistCampaignStageSchema,
      })
      .describe('Move a campaign one rung up the ladder. The gate is the stake, not a draw.'),
  ])
  .describe('One thing a desk wants done this quarter. Cleared at ledger_commit. Term sheets and buyout approaches are NOT orders: they are written straight into `deals`, because the deal path already resolves them.');
export type CapitalOrder = z.infer<typeof CapitalOrderSchema>;

/* -------------------------------------------------------------------------- */
/*  Takeover defences                                                          */
/* -------------------------------------------------------------------------- */

export const TAKEOVER_DEFENCES = ['poison_pill', 'staggered_board', 'white_knight'] as const;
export const TakeoverDefenceSchema = z
  .enum(TAKEOVER_DEFENCES)
  .describe(
    'The canonical three, each priced. "poison_pill" issues shares pro rata to everyone except the raider and must raise authorised shares in the same step or it is refused. "staggered_board" delays a controlling holder becoming decisive by STAGGERED_DELAY_QUARTERS, bought once, at the cost of an entrenchment reputation hit. "white_knight" invites a rival fund to counter-bid: you still lose the company, to somebody who will treat you better.',
  );
export type TakeoverDefence = z.infer<typeof TakeoverDefenceSchema>;

/** Investor-reputation cost of raising each defence. Negative, whole, and shown on the confirm button. */
export const TAKEOVER_DEFENCE_REPUTATION_COST: Readonly<Record<TakeoverDefence, number>> = {
  poison_pill: -8,
  staggered_board: -4,
  white_knight: 0,
};

/* -------------------------------------------------------------------------- */
/*  The player-facing stance                                                   */
/* -------------------------------------------------------------------------- */

export const CAPITAL_STANCES = ['backer', 'watching', 'hostile', 'adversary'] as const;
export const CapitalStanceSchema = z
  .enum(CAPITAL_STANCES)
  .describe(
    'How an entity stands toward the reader, derived every quarter and never stored. "backer" holds at least 5% of one of your companies with partner trust at or above 55; "watching" is the default; "hostile" is hostility at or above 55, an open short or an open campaign; "adversary" is an open buyout approach or a proxy fight.',
  );
export type CapitalStance = z.infer<typeof CapitalStanceSchema>;

/* -------------------------------------------------------------------------- */
/*  Events and invariants this module adds                                     */
/* -------------------------------------------------------------------------- */

/**
 * The ten ledger types appended to `SIM_EVENT_TYPES` for this subsystem, named
 * here so a test can assert they are all present and all at the end.
 *
 * Everything else a fund does reuses an existing type with an added payload
 * field — `deal_proposed`, `funding_round_closed`, `shares_traded`,
 * `acquisition_completed`, `debt_issued`, `dividend_paid`,
 * `disclosure_published` — which is what keeps the ledger's audit surface
 * stable and, more importantly, what keeps every equity movement inside the
 * closed set the financial-integrity reconstruction already reads.
 */
export const CAPITAL_EVENT_TYPES: readonly SimEventType[] = [
  'short_position_opened',
  'short_position_covered',
  'short_interest_published',
  'short_squeeze_triggered',
  'borrow_cost_charged',
  'activist_campaign_opened',
  'activist_campaign_escalated',
  'activist_campaign_closed',
  'takeover_defence_raised',
  'capital_entity_marked',
];

/**
 * The rule every implementer must read before writing a line of the engine
 * half: the financial-integrity check reconstructs each company's equity
 * movement from a closed set of ledger types. A movement explained by none of
 * them is an unexplained gap and the quarter does not commit.
 */
export const CAPITAL_INTEGRITY_INVARIANT = {
  id: 'capital_integrity',
  statement:
    'A CapitalEntity may move a company\'s equity ONLY through a row the equity reconstruction already reads: funding_round_closed, shares_issued, shares_traded, acquisition_completed, dividend_paid, buyback_executed, ipo_completed. Everything a fund does to its own books (short_position_opened, borrow_cost_charged, capital_entity_marked) touches no company balance sheet at all. Separately: every movement of dryPowderUsd in a quarter must be explained by that quarter\'s rows, and dryPowderUsd >= 0 at every commit.',
  enforcedAt: 'quarter_commit',
  onFailure: 'The quarter does not commit and the pre-resolution snapshot is restored. Promoted from a state invariant to a throwing engine invariant only after a clean forty-quarter soak.',
} as const;

/* -------------------------------------------------------------------------- */
/*  Roster helpers                                                             */
/* -------------------------------------------------------------------------- */

/** A sector-affinity map with every sector present, so a lookup is never undefined. */
export function fullSectorAffinity(partial: Readonly<Record<string, number>>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const sector of SECTORS) out[sector] = Math.max(0, Math.min(100, Math.round(partial[sector] ?? 0)));
  return out;
}

/** Dry powder implied by a whole-percentage share of committed capital. Whole dollars. */
export function dryPowderFromPct(committedCapitalUsd: number, pct: number): number {
  return Math.round((committedCapitalUsd * Math.max(0, Math.min(100, pct))) / 100);
}
