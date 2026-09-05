/**
 * The Street, as things a screen can draw.
 *
 * Eleven institutions with clocks, an inbox of offers they made, and the short
 * book they built against the register. Every figure on every surface below was
 * committed by the resolver onto `EconomyReport.capitalEntities`,
 * `.capitalPositions` and `.shortInterest`, or onto a `DealProposal` obligation
 * a capital desk wrote. This module is the whole translation layer, and it obeys
 * the same rule the Wave 3 economy surfaces obey (`docs/economy-study.md` §6.2):
 *
 * > Nothing here computes an economic number. It maps a committed figure onto a
 * > tone, a label, a bar width, an ordering or an answerability, and it hands
 * > percentages and dollars to the shared formatters exactly as the engine
 * > recorded them.
 *
 * Three things look like arithmetic and are not:
 *
 * - **the stance** is a per-reader derivation the entity row cannot carry,
 *   because `CapitalEntityRow.stance` is written once for every seat. The four
 *   states and their thresholds are the contract's own (`CapitalStance`), and
 *   the inputs are committed state: a disclosed position, a live approach, an
 *   open campaign, a disclosed short, a relationship edge.
 * - **the forced-seller horizon** projects the engine's own LP-pressure clock
 *   forward at the rate that clock runs (`100 / FUND_TERM_QUARTERS` points a
 *   quarter, DPI held where it is). It is a reading of a date, not a new number,
 *   which is the whole reason §2.3 says a player can see a forced seller coming
 *   four quarters out.
 * - **a now→after preview** adds one engine figure to another — the cheque to
 *   the cash, the fund's seat to the board — and never restates a rule.
 *
 * World 1 has no `economyReport` at all, so every accessor takes `null` and
 * answers with an empty list rather than a default a player would read as fact.
 */

import type {
  ActivistCampaign,
  ActivistCampaignStage,
  CapitalEntityKind,
  CapitalEntityRow,
  CapitalPositionRow,
  CapitalStance,
  DealObligation,
  DealProposal,
  EconomyReport,
  LpPressureBand,
  ShortInterestRow,
  SimEvent,
  TakeoverDefence,
} from '@frontier/contracts';
import {
  COUNTER_BAND_PCT,
  FUND_TERM_QUARTERS,
  LP_PRESSURE_FORCED_FLOOR,
  OWNERSHIP_THRESHOLDS,
  SHORT_DISCLOSURE_PCT,
  SHORT_INTEREST_CAP_PCT,
  SQUEEZE_MIN_SHORT_INTEREST_PCT,
  TAKEOVER_DEFENCE_REPUTATION_COST,
} from '@frontier/contracts';
import { formatCount, formatMoney } from '@frontier/shared';
import type { IconName } from '@/components/ui/icons';
import type { Tone } from '@/components/ui/tokens';

/* -------------------------------------------------------------------------- */
/*  Kinds                                                                      */
/* -------------------------------------------------------------------------- */

export const CAPITAL_KIND_LABEL: Readonly<Record<CapitalEntityKind, string>> = {
  vc: 'Venture',
  pe: 'Buyout',
  hedge_fund: 'Hedge fund',
  sovereign: 'Sovereign',
};

/**
 * One mark per kind, from the existing set. Never a monogram: a two-letter
 * badge is what the icon pass replaced everywhere else in the app.
 */
export const CAPITAL_KIND_ICON: Readonly<Record<CapitalEntityKind, IconName>> = {
  vc: 'compass',
  pe: 'vault',
  hedge_fund: 'chart',
  sovereign: 'capitol',
};

export const CAPITAL_KIND_BLURB: Readonly<Record<CapitalEntityKind, string>> = {
  vc: 'Prices rounds, takes a seat, and eventually needs an exit.',
  pe: 'Buys control, places debt on the business, and squeezes it.',
  hedge_fund: 'Trades the gap between the anchor and the price, long or short.',
  sovereign: 'Patient, long-only, and bound by a charter cap below control.',
};

/* -------------------------------------------------------------------------- */
/*  The LP-pressure clock                                                      */
/* -------------------------------------------------------------------------- */

export const LP_BAND_LABEL: Readonly<Record<LpPressureBand, string>> = {
  calm: 'Patient',
  harvesting: 'Harvesting',
  forced: 'Forced seller',
};

/** Low pressure is a patient backer; high pressure is a seller who does not care. */
export const LP_BAND_TONE: Readonly<Record<LpPressureBand, Tone>> = {
  calm: 'info',
  harvesting: 'warn',
  forced: 'loss',
};

/**
 * Points the engine's LP-pressure clock adds each quarter with nothing returned.
 *
 * `lpPressure = round(100 × age / FUND_TERM_QUARTERS − 100 × dpi)`, so a quarter
 * of ageing is worth exactly this much. Stated as the engine states it rather
 * than as a literal, so a Stage D change to the term changes the horizon too.
 */
export const LP_PRESSURE_PER_QUARTER = 100 / FUND_TERM_QUARTERS;

/**
 * How many quarters until this fund is a forced seller, holding DPI where it is.
 *
 * Zero when it already is one. Null when the clock would take longer than a
 * fund's whole term to get there, which on this scale means "not a thing you are
 * waiting for". This is the number §2.3 calls the best buying window in the
 * game, and the point of printing it is that it arrives on a date rather than on
 * a draw.
 */
export function forcedSellerInQuarters(lpPressure: number): number | null {
  if (!Number.isFinite(lpPressure)) return null;
  if (lpPressure >= LP_PRESSURE_FORCED_FLOOR) return 0;
  const quarters = Math.ceil((LP_PRESSURE_FORCED_FLOOR - lpPressure) / LP_PRESSURE_PER_QUARTER);
  return quarters > FUND_TERM_QUARTERS ? null : quarters;
}

/** "Forced seller in 3 quarters", or the line for a fund already selling. */
export function forcedSellerLine(row: Pick<CapitalEntityRow, 'lpPressure' | 'lpBand'>): string {
  const quarters = forcedSellerInQuarters(row.lpPressure);
  if (quarters === null) return 'No forced sale in this fund’s term';
  if (quarters === 0) return 'Forced seller now — the tranche goes at any price';
  return `Forced seller in ${quarters} quarter${quarters === 1 ? '' : 's'}`;
}

/* -------------------------------------------------------------------------- */
/*  Stance: the one derivation that is per-reader                              */
/* -------------------------------------------------------------------------- */

/** A position this size in one of your companies makes a holder a backer. */
export const BACKER_STAKE_PCT = 5;
/** Partner trust at or above this, with a stake, reads as backing. */
export const BACKER_TRUST = 55;
/** Partner hostility at or above this reads as hostile on its own. */
export const HOSTILE_HOSTILITY = 55;

/**
 * Everything the four-state stance is derived from, all of it committed state.
 *
 * Built once per screen by the page, from the projection and the session, and
 * handed to every card — so no card reaches into state for itself.
 */
export interface StanceContext {
  /** Companies the reader owns or runs. */
  readonly ownCompanyIds: ReadonlySet<string>;
  /** How each partner character regards the reader. Absent edges are neutral. */
  readonly trustByPartnerId: ReadonlyMap<string, number>;
  readonly hostilityByPartnerId: ReadonlyMap<string, number>;
  /** Entities with a live buyout approach against one of the reader's companies. */
  readonly approachEntityIds: ReadonlySet<string>;
  /** Entities running an open campaign against one of them. */
  readonly campaignEntityIds: ReadonlySet<string>;
  /** Entities whose campaign has reached the proxy fight. */
  readonly proxyFightEntityIds: ReadonlySet<string>;
  /** Entities disclosed short one of the reader's instruments. */
  readonly shortEntityIds: ReadonlySet<string>;
}

export const EMPTY_STANCE_CONTEXT: StanceContext = {
  ownCompanyIds: new Set<string>(),
  trustByPartnerId: new Map<string, number>(),
  hostilityByPartnerId: new Map<string, number>(),
  approachEntityIds: new Set<string>(),
  campaignEntityIds: new Set<string>(),
  proxyFightEntityIds: new Set<string>(),
  shortEntityIds: new Set<string>(),
};

/**
 * Where this institution stands toward the reader.
 *
 * Precedence runs from the loudest fact down: an approach or a proxy fight makes
 * an adversary whatever else is true; a short, a campaign or plain hostility
 * makes a hostile; a disclosed stake with a partner who trusts you makes a
 * backer; everything else is watching. `CapitalEntityRow.stance` is the engine's
 * seat-agnostic default and is deliberately not consulted.
 */
export function stanceOf(
  row: Pick<CapitalEntityRow, 'entityId' | 'partnerCharacterId'>,
  positions: readonly CapitalPositionRow[],
  context: StanceContext,
): CapitalStance {
  const id = row.entityId;
  if (context.approachEntityIds.has(id) || context.proxyFightEntityIds.has(id)) return 'adversary';
  if (context.campaignEntityIds.has(id) || context.shortEntityIds.has(id)) return 'hostile';

  const partnerId = row.partnerCharacterId;
  const hostility = partnerId === null ? 0 : (context.hostilityByPartnerId.get(partnerId) ?? 0);
  if (hostility >= HOSTILE_HOSTILITY) return 'hostile';

  // A relationship nobody has yet formed is neutral, not bad — the same reading
  // the engine's own partner scoring takes for an absent edge.
  const trust = partnerId === null ? 50 : (context.trustByPartnerId.get(partnerId) ?? 50);
  const backs = positions.some(
    (position) =>
      position.entityId === id && context.ownCompanyIds.has(position.companyId) && position.stakePct >= BACKER_STAKE_PCT,
  );
  if (backs && trust >= BACKER_TRUST) return 'backer';
  return 'watching';
}

export const STANCE_LABEL: Readonly<Record<CapitalStance, string>> = {
  backer: 'Backer',
  watching: 'Watching',
  hostile: 'Hostile',
  adversary: 'Adversary',
};

export const STANCE_TONE: Readonly<Record<CapitalStance, Tone>> = {
  backer: 'gain',
  watching: 'neutral',
  hostile: 'warn',
  adversary: 'loss',
};

/* -------------------------------------------------------------------------- */
/*  The cards                                                                  */
/* -------------------------------------------------------------------------- */

/** One institution, as one card, with everything the drawer behind it needs. */
export interface StreetCardRow {
  readonly row: CapitalEntityRow;
  readonly stance: CapitalStance;
  /** Every live long position this entity holds that the reader may see. */
  readonly portfolio: readonly CapitalPositionRow[];
  /** Instruments this entity is a disclosed holder of the short book in. */
  readonly shorts: readonly ShortInterestRow[];
  /** Positions in one of the reader's own companies. The reason to care first. */
  readonly ownPositions: readonly CapitalPositionRow[];
  /** Quarters until the LP clock forces a sale, or null. */
  readonly forcedInQuarters: number | null;
}

/**
 * Every institution, in roster order, with its portfolio and short book attached.
 *
 * Roster order is the engine's order, and it is kept: a card that jumped the
 * queue because it grew this quarter would make the screen unreadable across
 * quarters. Cards a reader has a live interest in are not floated to the top for
 * the same reason — the stance chip says it instead.
 */
export function streetCards(report: EconomyReport | null | undefined, context: StanceContext): StreetCardRow[] {
  if (report === null || report === undefined) return [];
  const positions = report.capitalPositions;
  return report.capitalEntities.map((row) => {
    const portfolio = positions
      .filter((position) => position.entityId === row.entityId)
      .slice()
      .sort((a, b) => (b.valueUsd !== a.valueUsd ? b.valueUsd - a.valueUsd : a.companyId.localeCompare(b.companyId)));
    return {
      row,
      stance: stanceOf(row, positions, context),
      portfolio,
      shorts: report.shortInterest.filter((entry) => entry.disclosedEntityIds.includes(row.entityId)),
      ownPositions: portfolio.filter((position) => context.ownCompanyIds.has(position.companyId)),
      forcedInQuarters: forcedSellerInQuarters(row.lpPressure),
    } satisfies StreetCardRow;
  });
}

/** Committed ledger rows this entity produced, oldest first. */
export function entityLedgerRows(events: readonly SimEvent[], entityId: string): SimEvent[] {
  return events
    .filter((event) => {
      if (event.actorId === entityId || event.targetId === entityId) return true;
      const payload = event.payload as Record<string, unknown>;
      return payload['entityId'] === entityId || payload['sponsorId'] === entityId || payload['raiderEntityId'] === entityId;
    })
    .slice()
    .sort((a, b) => a.sequence - b.sequence);
}

/* -------------------------------------------------------------------------- */
/*  Short interest                                                             */
/* -------------------------------------------------------------------------- */

export type SqueezeRisk = 'none' | 'watch' | 'fired';

/**
 * The squeeze badge, at the engine's own thresholds.
 *
 * `fired` is a fact the resolver wrote on the row. `watch` is the standing
 * condition of the squeeze rule — short interest at or above
 * `SQUEEZE_MIN_SHORT_INTEREST_PCT` is one leg of it, and the other leg is a
 * price move nobody can promise. Below that there is nothing to warn about.
 */
export function squeezeRisk(row: Pick<ShortInterestRow, 'shortInterestPct' | 'squeezeFired'>): SqueezeRisk {
  if (row.squeezeFired) return 'fired';
  return row.shortInterestPct >= SQUEEZE_MIN_SHORT_INTEREST_PCT ? 'watch' : 'none';
}

export interface ShortBadge {
  readonly risk: SqueezeRisk;
  readonly label: string;
  readonly tone: Tone;
}

/** The one badge a Markets card carries for a name with an open short book. */
export function shortInterestBadge(row: ShortInterestRow): ShortBadge {
  const risk = squeezeRisk(row);
  if (risk === 'fired') {
    return { risk, label: `SQUEEZE · ${formatCount(row.forcedCoverShares)} force-covered`, tone: 'loss' };
  }
  if (risk === 'watch') return { risk, label: 'Squeeze risk', tone: 'warn' };
  return { risk, label: 'Orderly', tone: 'neutral' };
}

/** The short-interest bar is drawn against the per-instrument cap, never against 100. */
export function shortInterestFraction(row: Pick<ShortInterestRow, 'shortInterestPct'>): number {
  if (SHORT_INTEREST_CAP_PCT <= 0) return 0;
  return Math.max(0, Math.min(1, row.shortInterestPct / SHORT_INTEREST_CAP_PCT));
}

/** `Short interest 14% · borrow 14%/qtr` — the whole line, in whole numbers. */
export function shortInterestLine(row: ShortInterestRow): string {
  return `Short interest ${row.shortInterestPct}% · borrow ${row.borrowFeePctPerQuarter}%/qtr`;
}

/** Short-interest rows for one company, or an empty list where no book is open. */
export function shortInterestFor(report: EconomyReport | null | undefined, companyId: string): ShortInterestRow[] {
  if (report === null || report === undefined) return [];
  return report.shortInterest.filter((row) => row.companyId === companyId);
}

/**
 * The 13F line: who is disclosed in this name, and nobody else.
 *
 * Below the disclosure threshold a holder is **absent** — not blurred, not
 * summarised, absent — because that is what the projection already did and
 * softening it here would give back the game's sharpest weapon.
 */
export function disclosedHolders(
  report: EconomyReport | null | undefined,
  companyId: string,
): readonly CapitalPositionRow[] {
  if (report === null || report === undefined) return [];
  return report.capitalPositions
    .filter((row) => row.companyId === companyId && row.isDisclosed)
    .slice()
    .sort((a, b) => (b.stakePct !== a.stakePct ? b.stakePct - a.stakePct : a.entityId.localeCompare(b.entityId)));
}

/**
 * The threshold a holder crosses to appear at all, stated on the panel.
 *
 * The ownership table's own first rung — `significant_holder_disclosure` — and
 * not the short book's constant, which happens to sit at the same number for
 * the same reason and is a different rule.
 */
export const HOLDER_DISCLOSURE_PCT = Math.round((OWNERSHIP_THRESHOLDS[0]?.pct ?? 0.05) * 100);

/** The threshold a short book crosses to name its holders. */
export const SHORT_HOLDER_DISCLOSURE_PCT = SHORT_DISCLOSURE_PCT;

/* -------------------------------------------------------------------------- */
/*  The offers inbox                                                           */
/* -------------------------------------------------------------------------- */

export type TermSheet = Extract<DealObligation, { kind: 'term_sheet' }>;
export type BuyoutOffer = Extract<DealObligation, { kind: 'buyout_offer' }>;

/** The term sheet on a deal, or null when it carries none. */
export function termSheetOf(deal: DealProposal): TermSheet | null {
  for (const obligation of deal.gives) if (obligation.kind === 'term_sheet') return obligation;
  return null;
}

/** The buyout offer on a deal, or null. */
export function buyoutOf(deal: DealProposal): BuyoutOffer | null {
  for (const obligation of deal.gives) if (obligation.kind === 'buyout_offer') return obligation;
  return null;
}

/** The rungs of the campaign ladder, as a reader reads them. */
export const CAMPAIGN_STAGE_LABEL: Readonly<Record<ActivistCampaignStage, string>> = {
  private_letter: 'Private letter',
  public_letter: 'Public letter',
  board_demand: 'Board demand',
  proxy_fight: 'Proxy fight',
};

export function campaignStageLabel(stage: ActivistCampaignStage): string {
  return CAMPAIGN_STAGE_LABEL[stage];
}

/** The stage a public approach has reached. A bear hug is the offer made public. */
export const BUYOUT_STAGE_LABEL: Readonly<Record<BuyoutOffer['stage'], string>> = {
  private_approach: 'Private approach',
  bear_hug: 'Bear hug',
  tender: 'Tender',
};

export type OfferKind = 'term_sheet' | 'buyout' | 'activist';

export interface OfferCardRow {
  readonly id: string;
  readonly kind: OfferKind;
  /** Null only for an activist letter, which is a campaign rather than a deal. */
  readonly deal: DealProposal | null;
  readonly campaign: ActivistCampaign | null;
  readonly entityId: string;
  readonly companyId: string;
  readonly createdQuarter: number;
  /**
   * The quarter this can first be answered in.
   *
   * A fund's offer is never resolved in the quarter it is made: that one-quarter
   * delay is what makes the inbox a decision rather than a notification, and the
   * card says so in those words.
   */
  readonly answerableFromQuarter: number;
  readonly isAnswerable: boolean;
  readonly expiresQuarter: number | null;
  /** What the offer is worth, for the ordering only. Never printed from here. */
  readonly valueUsd: number;
}

/** Everything an inbox is built from. All of it committed state. */
export interface InboxInput {
  readonly deals: readonly DealProposal[];
  readonly campaigns: readonly ActivistCampaign[];
  readonly companyIds: ReadonlySet<string>;
  readonly quarter: number;
}

/**
 * The offers inbox, in the order a founder should read it.
 *
 * Answerable first — those are the ones that need a decision this quarter — then
 * by value, then newest, then by id so the order never wobbles between renders.
 * An offer made this quarter still appears: it is a warning, and the card that
 * carries it says which quarter it becomes answerable in.
 */
export function offerInbox(input: InboxInput): OfferCardRow[] {
  const rows: OfferCardRow[] = [];

  for (const deal of input.deals) {
    if (deal.status !== 'proposed') continue;
    const sheet = termSheetOf(deal);
    const buyout = buyoutOf(deal);
    if (sheet === null && buyout === null) continue;
    const companyId = sheet?.companyId ?? buyout?.targetCompanyId ?? deal.counterpartyId;
    if (!input.companyIds.has(companyId)) continue;

    const answerableFrom = deal.createdQuarter + 1;
    rows.push({
      id: deal.id,
      kind: sheet === null ? 'buyout' : 'term_sheet',
      deal,
      campaign: null,
      entityId: (sheet?.entityId ?? buyout?.entityId) as string,
      companyId,
      createdQuarter: deal.createdQuarter,
      answerableFromQuarter: answerableFrom,
      isAnswerable: input.quarter >= answerableFrom && deal.expiresQuarter >= input.quarter,
      expiresQuarter: deal.expiresQuarter,
      valueUsd: sheet?.amountUsd ?? buyout?.offerValueUsd ?? 0,
    });
  }

  for (const campaign of input.campaigns) {
    if (campaign.outcome !== null) continue;
    if (!input.companyIds.has(campaign.targetCompanyId)) continue;
    rows.push({
      id: campaign.id,
      kind: 'activist',
      deal: null,
      campaign,
      entityId: campaign.entityId,
      companyId: campaign.targetCompanyId,
      createdQuarter: campaign.openedQuarter,
      // A campaign is answered on the board's clock, not the deal clock: it is
      // live from the quarter it opens and it does not lapse.
      answerableFromQuarter: campaign.openedQuarter,
      isAnswerable: true,
      expiresQuarter: null,
      valueUsd: 0,
    });
  }

  return rows.sort((a, b) => {
    if (a.isAnswerable !== b.isAnswerable) return a.isAnswerable ? -1 : 1;
    if (b.valueUsd !== a.valueUsd) return b.valueUsd - a.valueUsd;
    if (b.createdQuarter !== a.createdQuarter) return b.createdQuarter - a.createdQuarter;
    return a.id.localeCompare(b.id);
  });
}

/** How many of the inbox need an answer this quarter — the Command Centre count. */
export function answerableCount(rows: readonly OfferCardRow[]): number {
  return rows.filter((row) => row.isAnswerable).length;
}

/* -------------------------------------------------------------------------- */
/*  Now → after previews (V5)                                                  */
/* -------------------------------------------------------------------------- */

/** A preview row, already formatted. `NowAfter` never multiplies anything. */
export interface PreviewRow {
  readonly key: string;
  readonly label: string;
  readonly now: string;
  readonly after: string;
  readonly tone?: Tone;
}

export interface TermSheetContext {
  /** The reader's own stake in the company, as a whole percentage. */
  readonly ownStakePct: number;
  readonly cashUsd: number;
  readonly boardSeats: number;
  readonly partnerName: string;
}

/**
 * What a term sheet does to the three things a founder actually holds.
 *
 * Dilution is the fund's own figure off the obligation; the cheque is the
 * fund's; the seat is the fund's. The only step taken here is applying them.
 */
export function termSheetPreview(sheet: TermSheet, context: TermSheetContext): PreviewRow[] {
  const ownAfterPct = Math.round((context.ownStakePct * (100 - sheet.dilutionPct)) / 100);
  const seatsAfter = context.boardSeats + sheet.boardSeats;
  return [
    {
      key: 'ownership',
      label: 'You own',
      now: `${Math.round(context.ownStakePct)}%`,
      after: `${ownAfterPct}%`,
      tone: ownAfterPct < Math.round(context.ownStakePct) ? 'loss' : undefined,
    },
    {
      key: 'cash',
      label: 'Cash',
      now: formatMoney(context.cashUsd),
      after: formatMoney(context.cashUsd + sheet.amountUsd),
      tone: 'gain',
    },
    {
      key: 'board',
      label: 'Board',
      now: `${context.boardSeats} seat${context.boardSeats === 1 ? '' : 's'}`,
      after:
        sheet.boardSeats === 0
          ? `${seatsAfter} seat${seatsAfter === 1 ? '' : 's'}`
          : `${seatsAfter} seats (${context.partnerName} takes one)`,
      tone: sheet.boardSeats > 0 ? 'warn' : undefined,
    },
  ];
}

export interface BuyoutContext {
  /** The reader's own stake in the target, as a whole percentage. */
  readonly ownStakePct: number;
  /** What the raider already holds, as a whole percentage. */
  readonly raiderStakePct: number;
  readonly controlPct: number;
}

/**
 * What an approach means: what the reader's stake is worth at the offer, and
 * how far the raider still is from the control line.
 */
export function buyoutPreview(offer: BuyoutOffer, context: BuyoutContext): PreviewRow[] {
  const proceeds = Math.round((offer.offerValueUsd * context.ownStakePct) / 100);
  return [
    {
      key: 'proceeds',
      label: 'Your stake, at the offer',
      now: `${Math.round(context.ownStakePct)}%`,
      after: formatMoney(proceeds),
      tone: 'gain',
    },
    {
      key: 'raider',
      label: 'They hold',
      now: `${Math.round(context.raiderStakePct)}%`,
      after: `${Math.round(context.controlPct)}% wins it`,
      tone: context.raiderStakePct >= context.controlPct ? 'loss' : 'warn',
    },
    {
      key: 'debt',
      label: 'Debt placed on you',
      now: formatMoney(0),
      after: formatMoney(offer.lboDebtUsd),
      tone: offer.lboDebtUsd > 0 ? 'loss' : undefined,
    },
  ];
}

/* -------------------------------------------------------------------------- */
/*  Countering                                                                 */
/* -------------------------------------------------------------------------- */

export interface CounterBand {
  readonly minUsd: number;
  readonly maxUsd: number;
  readonly minSeats: number;
  readonly maxSeats: number;
}

/**
 * The band a counter may move inside: price within ±`COUNTER_BAND_PCT`, board
 * seats ±1.
 *
 * The band is engine-computed and there is no reason to hide it, so the sheet
 * shows it before the player commits rather than after they are refused.
 */
export function counterBand(sheet: TermSheet): CounterBand {
  const min = Math.round((sheet.preMoneyUsd * (100 - COUNTER_BAND_PCT)) / 100);
  const max = Math.round((sheet.preMoneyUsd * (100 + COUNTER_BAND_PCT)) / 100);
  return {
    minUsd: min,
    maxUsd: max,
    minSeats: Math.max(0, sheet.boardSeats - 1),
    maxSeats: sheet.boardSeats + 1,
  };
}

/** Is this counter inside the band the fund's own score computed? */
export function counterInsideBand(sheet: TermSheet, preMoneyUsd: number, boardSeats: number): boolean {
  const band = counterBand(sheet);
  return preMoneyUsd >= band.minUsd && preMoneyUsd <= band.maxUsd && boardSeats >= band.minSeats && boardSeats <= band.maxSeats;
}

/**
 * The countered obligation.
 *
 * Every field the fund computed is carried through untouched except the two the
 * player is allowed to move: the price and the seat. Dilution is restated from
 * the countered price by the definition the obligation itself gives — amount
 * over post-money — because a card that showed the old dilution beside a new
 * price would be printing a number that is not true.
 */
export function counteredTermSheet(sheet: TermSheet, preMoneyUsd: number, boardSeats: number): TermSheet {
  const price = Math.max(1, Math.round(preMoneyUsd));
  return {
    ...sheet,
    preMoneyUsd: price,
    boardSeats: Math.max(0, Math.round(boardSeats)),
    dilutionPct: Math.max(0, Math.min(100, Math.round((100 * sheet.amountUsd) / (price + sheet.amountUsd)))),
  };
}

/* -------------------------------------------------------------------------- */
/*  Defences                                                                   */
/* -------------------------------------------------------------------------- */

export interface DefenceOption {
  readonly defence: TakeoverDefence;
  readonly label: string;
  /** What raising it does, in one line. */
  readonly effect: string;
  /** How it is actually raised, so the verb is never a mystery. */
  readonly mechanism: string;
  /** Signed investor-reputation cost, from the contract's own table. */
  readonly reputationDelta: number;
  /** Null when it can be raised; a reason when it cannot. V4: present, disabled. */
  readonly blockedReason: string | null;
}

export interface DefenceContext {
  /** False while the approach is still confidential: there is nothing to defend against in public. */
  readonly approachIsPublic: boolean;
  readonly hasBoard: boolean;
  readonly boardIsStaggered: boolean;
  readonly pillAlreadyRaised: boolean;
  /** Rival institutions with the dry powder to counter-bid. */
  readonly rescuerCount: number;
}

/**
 * The canonical three, each an existing structure and each priced.
 *
 * None of them is a new verb: a pill and a staggered board are board matters the
 * player already tables, and a white knight is a deal already offered to a rival
 * institution. A defence that cannot be raised is shown disabled with the reason
 * rather than hidden, which is the V4 pattern.
 */
export function defenceOptions(context: DefenceContext): DefenceOption[] {
  return [
    {
      defence: 'poison_pill',
      label: 'Poison pill',
      effect: 'Issues shares to every holder except the raider, diluting them.',
      mechanism: 'A financing matter, tabled and passed while the approach is public.',
      reputationDelta: TAKEOVER_DEFENCE_REPUTATION_COST.poison_pill,
      blockedReason: !context.hasBoard
        ? 'No board to table it at'
        : !context.approachIsPublic
          ? 'The approach is still confidential'
          : context.pillAlreadyRaised
            ? 'Already raised against this raider'
            : null,
    },
    {
      defence: 'staggered_board',
      label: 'Staggered board',
      effect: 'A holder that crosses control is not decisive for two quarters.',
      mechanism: 'A restructuring matter, tabled and passed while the approach is public.',
      reputationDelta: TAKEOVER_DEFENCE_REPUTATION_COST.staggered_board,
      blockedReason: !context.hasBoard
        ? 'No board to table it at'
        : !context.approachIsPublic
          ? 'The approach is still confidential'
          : context.boardIsStaggered
            ? 'The board is already staggered'
            : null,
    },
    {
      defence: 'white_knight',
      label: 'White knight',
      effect: 'A rival institution counter-bids over the standing offer.',
      mechanism: 'An invitation offered to a rival fund, answered the quarter after it is made.',
      reputationDelta: TAKEOVER_DEFENCE_REPUTATION_COST.white_knight,
      blockedReason:
        !context.approachIsPublic
          ? 'The approach is still confidential'
          : context.rescuerCount === 0
            ? 'No institution here has the dry powder'
            : null,
    },
  ];
}

/** The line on the confirm button: what raising this costs. */
export function defenceCostLine(option: DefenceOption): string {
  if (option.reputationDelta === 0) return 'No reputation cost — you still lose the company';
  return `${option.reputationDelta} investor reputation`;
}

/* -------------------------------------------------------------------------- */
/*  Small formatted readings                                                   */
/* -------------------------------------------------------------------------- */

/** `$18B · dry powder $10B (55%)` — the card's one number and its one bar. */
export function dryPowderLine(row: Pick<CapitalEntityRow, 'dryPowderUsd' | 'dryPowderPct'>): string {
  return `Dry powder ${formatMoney(row.dryPowderUsd)} · ${row.dryPowderPct}%`;
}

/** A portfolio line's multiple, on the one 0-based scale: 300 is a three-bagger. */
export function multipleLabel(position: Pick<CapitalPositionRow, 'unrealisedMultiplePct'>): string {
  return `${position.unrealisedMultiplePct}%`;
}

/** Above cost is a gain, below is a loss, at cost is neither. */
export function multipleTone(position: Pick<CapitalPositionRow, 'unrealisedMultiplePct'>): Tone {
  if (position.unrealisedMultiplePct > 100) return 'gain';
  if (position.unrealisedMultiplePct < 100) return 'loss';
  return 'neutral';
}

/** `DPI 40% · track record 62` — what an LP actually counts, then reputation. */
export function trackRecordLine(row: Pick<CapitalEntityRow, 'dpiPct' | 'trackRecord'>): string {
  return `DPI ${row.dpiPct}% · track record ${row.trackRecord}`;
}
