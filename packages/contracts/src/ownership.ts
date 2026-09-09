/**
 * @frontier/contracts — ownership.ts
 *
 * Cap tables, share classes, holdings and funding rounds.
 *
 * The central rule: **share ownership must always reconcile to issued shares**.
 * For every share class, the sum of holdings equals `totalIssuedByClass`. The
 * engine checks this before every quarter commit; a quarter that fails does not
 * commit. The client can never manufacture shares.
 *
 * The second rule: control is not percentage. Founder super-voting stock,
 * voting agreements, institutional blocs, board composition and shareholder
 * turnout all sit between "owns 26%" and "decides what happens".
 */

import { z } from 'zod';
import { QuarterIndexSchema, intCount, unitInterval, usd } from './ids';

/* -------------------------------------------------------------------------- */
/*  Share classes                                                              */
/* -------------------------------------------------------------------------- */

export const SHARE_CLASS_KINDS = ['common', 'preferred', 'founder_super_voting'] as const;

export const ShareClassKindSchema = z
  .enum(SHARE_CLASS_KINDS)
  .describe(
    'Kind of equity. "common" is ordinary stock with one vote. "preferred" carries a liquidation preference and usually investor protective rights. "founder_super_voting" carries multiple votes per share and is how a founder can retain control well below 50% economic ownership.',
  );
export type ShareClassKind = z.infer<typeof ShareClassKindSchema>;

export const ShareClassSchema = z
  .object({
    id: z.string().min(1).describe('Share class id, e.g. "shc_orbit_common".'),
    companyId: z.string().min(1),
    kind: ShareClassKindSchema,
    label: z.string().min(1).max(60).describe('Human label, e.g. "Class B (founder)".'),
    votesPerShare: z
      .number()
      .min(0)
      .max(50)
      .describe('Votes each share carries. 1 for ordinary common, 0 for non-voting, 10 for typical founder super-voting stock. This is the number that decides board fights, not the economic percentage.'),
    liquidationPreferenceMultiple: z
      .number()
      .min(0)
      .max(5)
      .describe('Multiple of invested capital returned before common in a liquidation. 0 for common, typically 1 for preferred.'),
    participating: z.boolean().describe('True when preferred also shares in the residual after its preference is paid.'),
    authorisedShares: intCount('Shares the company is authorised to issue in this class.'),
    issuedShares: intCount('Shares actually issued in this class. The sum of all holdings in this class must equal this number.'),
    createdQuarter: QuarterIndexSchema,
  })
  .describe('One class of equity in a company.');
export type ShareClass = z.infer<typeof ShareClassSchema>;

/* -------------------------------------------------------------------------- */
/*  Securities                                                                 */
/* -------------------------------------------------------------------------- */

export const SecuritySchema = z
  .object({
    id: z.string().min(1).describe('Security id, e.g. "sec_nexus_common".'),
    companyId: z.string().min(1),
    shareClassId: z.string().min(1).describe('The share class this security represents.'),
    symbol: z.string().max(12).nullable().describe('Trading symbol once listed, or null while private.'),
    isTradable: z.boolean().describe('True when the security can change hands on the in-world exchange. Private preferred is typically false.'),
    instrumentId: z.string().nullable().describe('Market instrument used to price this security, or null when it is not quoted.'),
    parValueUsd: usd('Nominal par value per share. Usually negligible; kept for the balance sheet.'),
  })
  .describe('A tradable or transferable claim on a company. Buying "3% of a public rival" means acquiring shares of a security.');
export type Security = z.infer<typeof SecuritySchema>;

/* -------------------------------------------------------------------------- */
/*  Holdings                                                                   */
/* -------------------------------------------------------------------------- */

export const HOLDER_KINDS = ['player', 'company', 'character', 'fund', 'public_float'] as const;

export const HolderKindSchema = z
  .enum(HOLDER_KINDS)
  .describe(
    'What sort of entity owns the position. "player" is a session participant holding personally; "character" is any other named person; "company" is a corporate holding (a strategic stake); "fund" is an institutional bloc that votes as one; "public_float" is the anonymous remainder held by the market, which votes only partially and predictably.',
  );
export type HolderKind = z.infer<typeof HolderKindSchema>;

export const HoldingSchema = z
  .object({
    id: z.string().min(1).describe('Holding id.'),
    holderId: z.string().min(1).describe('Id of the owner. Interpret according to holderKind.'),
    holderKind: HolderKindSchema,
    securityId: z.string().min(1),
    shares: intCount('Number of shares held. Never negative: short positions are not modelled.'),
    costBasisUsd: usd('Total amount paid for the position, used for founder net worth and realised gains.'),
    acquiredQuarter: QuarterIndexSchema.describe('Quarter the position was first opened.'),
    lockupUntilQuarter: QuarterIndexSchema.nullable().describe('Quarter before which the position cannot be sold, or null when unrestricted. Applied after an IPO or a stock-funded acquisition.'),
    isDisclosed: z.boolean().describe('True once the position has crossed a disclosure threshold and become public knowledge. An undisclosed accumulation is one of the game\'s sharpest weapons.'),
    dividendsReceivedUsd: usd(
      'Cumulative dividends this position has been paid, never reset and never reduced by a sale. It is income already banked, so it belongs beside the cost basis rather than inside it: a position can be under water on price and still ahead on cash. Optional because only world version 2 pays dividends at all; absent means "this world pays none", never zero received.',
    ).optional(),
  })
  .describe('One ownership position in one security.');
export type Holding = z.infer<typeof HoldingSchema>;

/* -------------------------------------------------------------------------- */
/*  Cap table                                                                  */
/* -------------------------------------------------------------------------- */

export const CapTableSchema = z
  .object({
    companyId: z.string().min(1),
    shareClasses: z.array(ShareClassSchema).describe('Every class of equity this company has issued.'),
    holdings: z.array(HoldingSchema).describe('Every position in every class.'),
    totalIssuedByClass: z
      .record(z.string(), intCount('Shares issued in this class.'))
      .describe(
        'Issued share count keyed by share class id. INVARIANT: for every class, the sum of `shares` across holdings whose security belongs to that class equals this number. The engine verifies this before each quarter commits and refuses to commit on a mismatch.',
      ),
    fullyDilutedShares: intCount('Total shares outstanding across all classes, including issued option pool.'),
    optionPoolShares: intCount('Shares reserved for employee options, issued or not.'),
    lastUpdatedQuarter: QuarterIndexSchema,
  })
  .describe('The complete ownership picture of one company.');
export type CapTable = z.infer<typeof CapTableSchema>;

/** Machine-readable statement of the ownership invariant, for tests and docs. */
export const CAP_TABLE_INVARIANT = {
  id: 'ownership_reconciles',
  statement: 'For every share class, sum(holdings.shares for that class) === totalIssuedByClass[classId].',
  enforcedAt: 'quarter_commit',
  onFailure: 'The quarter does not commit. The engine emits a ledger rejection and restores the pre-resolution snapshot.',
} as const;

/** Result of running the ownership invariant over one cap table. */
export const CapTableCheckSchema = z
  .object({
    companyId: z.string().min(1),
    reconciles: z.boolean(),
    perClass: z.array(
      z.object({
        shareClassId: z.string().min(1),
        issued: intCount('Declared issued shares.'),
        heldSum: intCount('Sum of holdings.'),
        difference: z.number().int().describe('heldSum minus issued. Must be exactly 0.'),
      }),
    ),
  })
  .describe('Ownership invariant check for one company.');
export type CapTableCheck = z.infer<typeof CapTableCheckSchema>;

/* -------------------------------------------------------------------------- */
/*  Funding rounds                                                             */
/* -------------------------------------------------------------------------- */

export const FUNDING_STAGES = ['pre_seed', 'seed', 'series_a', 'series_b', 'series_c', 'series_d', 'series_e', 'growth', 'bridge'] as const;

export const FundingStageSchema = z
  .enum(FUNDING_STAGES)
  .describe(
    'Stage of a private financing. Later stages demand more evidence: seed is priced on team and thesis, series_c on revenue quality and retention, growth on profitability trajectory. "bridge" is an emergency top-up and signals distress to the market.',
  );
export type FundingStage = z.infer<typeof FundingStageSchema>;

export const FundingRoundSchema = z
  .object({
    id: z.string().min(1),
    companyId: z.string().min(1),
    stage: FundingStageSchema,
    amount: usd('Cash raised in the round.'),
    preMoney: usd('Pre-money valuation agreed with investors.'),
    postMoney: usd('Pre-money valuation plus the amount raised.'),
    dilution: unitInterval('Fraction of the company sold, equal to amount divided by postMoney. Founders who ignore this arrive at a public listing owning nothing.'),
    pricePerShareUsd: usd('Price per share paid by the incoming investors.'),
    shareClassId: z.string().min(1).describe('Class the new shares were issued in.'),
    leadInvestorCharacterId: z.string().nullable().describe('Character who led the round, or null for an unled round. The lead usually takes a board seat.'),
    participantHolderIds: z.array(z.string()).describe('Ids of every entity that took part.'),
    boardSeatsGranted: intCount('Board seats created for investors as a condition of the round.'),
    closedQuarter: QuarterIndexSchema,
    status: z.enum(['open', 'closed', 'failed', 'withdrawn']).describe('Rounds can fail: a weak market or poor metrics means the raise does not close, and the attempt itself is visible to the market.'),
  })
  .describe('One private financing event.');
export type FundingRound = z.infer<typeof FundingRoundSchema>;

/* -------------------------------------------------------------------------- */
/*  Ownership thresholds                                                       */
/* -------------------------------------------------------------------------- */

export interface OwnershipThreshold {
  /** Fraction of an equity class, 0..1. */
  readonly pct: number;
  /** Machine label used by the ledger and the UI. */
  readonly label: string;
  /** What crossing this threshold does in the game. */
  readonly effect: string;
}

/**
 * Simplified, fictional ownership thresholds. Crossing one upward emits an
 * `ownership_threshold_crossed` ledger event; the disclosure threshold also
 * makes the position public, which is usually when the target's CEO notices.
 */
export const OWNERSHIP_THRESHOLDS: readonly OwnershipThreshold[] = [
  { pct: 0.05, label: 'significant_holder_disclosure', effect: 'The position becomes public. Media and the target company learn who is accumulating.' },
  { pct: 0.1, label: 'major_holder', effect: 'The holder gains standing to demand meetings and put questions to management.' },
  { pct: 0.15, label: 'board_pressure', effect: 'The holder can credibly demand a board seat; refusal becomes a governance story.' },
  { pct: 0.25, label: 'blocking_stake', effect: 'The holder can block supermajority matters such as a sale of the company.' },
  { pct: 0.5, label: 'control', effect: 'The holder controls ordinary shareholder votes outright, subject to super-voting classes.' },
];

/** The highest threshold a percentage has reached, or `null` below 5%. Pure. */
export function ownershipThresholdFor(pct: number): OwnershipThreshold | null {
  let found: OwnershipThreshold | null = null;
  for (const t of OWNERSHIP_THRESHOLDS) {
    if (pct >= t.pct) found = t;
  }
  return found;
}

/* -------------------------------------------------------------------------- */
/*  Voting power                                                               */
/* -------------------------------------------------------------------------- */

export const VotingPowerSchema = z
  .object({
    holderId: z.string().min(1),
    holderKind: HolderKindSchema,
    economicPct: unitInterval('Share of total economic ownership.'),
    votingPct: unitInterval('Share of total votes. Diverges from economicPct wherever super-voting stock exists.'),
    thresholdLabel: z.string().nullable().describe('Highest ownership threshold crossed, or null.'),
    isDisclosed: z.boolean(),
  })
  .describe('One holder\'s economic and voting position in a company.');
export type VotingPower = z.infer<typeof VotingPowerSchema>;

/**
 * Compute voting power for every holder of a company. Implemented in
 * `@frontier/simulation`; declared here so the web app and the engine agree.
 * Must be pure: same cap table in, same array out, ordered deterministically by
 * descending votingPct then by holderId.
 */
export type ComputeVotingPowerFn = (capTable: CapTable) => readonly VotingPower[];

/* -------------------------------------------------------------------------- */
/*  Transactions                                                               */
/* -------------------------------------------------------------------------- */

export const SHARE_TRANSACTION_KINDS = ['primary_issue', 'secondary_purchase', 'secondary_sale', 'buyback', 'acquisition_exchange', 'option_exercise', 'grant'] as const;

export const ShareTransactionKindSchema = z.enum(SHARE_TRANSACTION_KINDS).describe('How shares moved. Primary issues create shares; secondary trades move existing ones; buybacks retire them.');
export type ShareTransactionKind = z.infer<typeof ShareTransactionKindSchema>;

export const ShareTransactionSchema = z
  .object({
    id: z.string().min(1),
    quarter: QuarterIndexSchema,
    securityId: z.string().min(1),
    kind: ShareTransactionKindSchema,
    fromHolderId: z.string().nullable().describe('Seller, or null for a primary issue.'),
    toHolderId: z.string().nullable().describe('Buyer, or null for a retirement.'),
    shares: intCount('Shares moved.'),
    pricePerShareUsd: usd('Execution price per share.'),
    totalUsd: usd('Total consideration.'),
    disclosedPublicly: z.boolean().describe('False for undisclosed accumulation below the disclosure threshold.'),
  })
  .describe('One movement of shares. Every economic mutation of a cap table produces one of these plus a ledger event.');
export type ShareTransaction = z.infer<typeof ShareTransactionSchema>;
