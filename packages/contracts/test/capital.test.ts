/**
 * Capital entities: the schema surface venture, buyout, hedge and sovereign
 * funds are built on.
 *
 * Three things are pinned here, and they are the three that would be expensive
 * to discover later:
 *
 * - **Every default.** A partial fixture written by the scenario, by a stage
 *   that has not shipped yet, or by a save from an older contract version must
 *   parse into exactly the row the engine expects.
 * - **The short ledger is not the register.** A short never becomes a holding,
 *   never carries a vote and never counts toward an ownership percentage. That
 *   is the constraint the whole design of `ShortPosition` was derived from, so
 *   it is asserted structurally rather than trusted.
 * - **Every enum grew at the end.** Reordering `SIM_EVENT_TYPES`,
 *   `SIMULATION_INVARIANTS` or `LEADERBOARD_BOARDS` would silently reinterpret
 *   every row already written against them.
 */

import { describe, expect, it } from 'vitest';

import {
  ACTION_ORIGINS,
  ACTIVIST_CAMPAIGN_STAGES,
  ACTIVIST_DEMANDS,
  ACTIVIST_DEMAND_PROPOSAL_KIND,
  ACTIVIST_OPEN_STAKE_PCT,
  ACTIVIST_PROXY_STAKE_PCT,
  ACTIVIST_PUBLIC_STAKE_PCT,
  ActivistCampaignSchema,
  activistStakeGatePct,
  BOARD_PROPOSAL_KINDS,
  BORROW_FEE_MAX_PCT,
  BORROW_FEE_MIN_PCT,
  CAPITAL_ENTITY_KINDS,
  CAPITAL_ENTITY_MEMORY_LIMIT,
  CAPITAL_EVENT_TYPES,
  CAPITAL_INTEGRITY_INVARIANT,
  CAPITAL_ORDER_KINDS,
  CapTableSchema,
  CapitalEntitySchema,
  CapitalOrderSchema,
  DEAL_OBLIGATION_KINDS,
  DealObligationSchema,
  FUNDING_STAGES,
  FUND_TERM_QUARTERS,
  HOLDER_KINDS,
  HoldingSchema,
  INVESTMENT_PERIOD_QUARTERS,
  LEADERBOARD_BOARDS,
  LEADERBOARD_SUBJECT_KINDS,
  LP_PRESSURE_FORCED_FLOOR,
  LP_PRESSURE_HARVEST_FLOOR,
  MAX_CAPITAL_ENTITIES,
  SECTORS,
  SHORT_INTEREST_CAP_PCT,
  SHORT_LEDGER_INVARIANT,
  SHORT_MAINTENANCE_PCT,
  SIMULATION_INVARIANTS,
  SIM_EVENT_TYPES,
  SOVEREIGN_CHARTER_CAP_PCT,
  ShortPositionSchema,
  TARGET_MULTIPLE,
  TARGET_MULTIPLE_UNDER_PRESSURE,
  VC_CHEQUE_PCT_OF_AUM,
  borrowFeePctFor,
  dpiPct,
  dryPowderFromPct,
  fullSectorAffinity,
  fundAgeQuarters,
  lpPressureBand,
  lpPressureFor,
  shortBreachesMaintenance,
  shortHeadroomShares,
  shortInterestPctOf,
  squeezeTriggered,
  targetMultipleFor,
} from '../src/index';

const BN = 1_000_000_000;

/** The narrowest entity that parses: everything else must come from a default. */
const minimalEntity = {
  id: 'fund_seawall',
  name: 'Seawall Capital',
  kind: 'vc' as const,
  region: 'north_america' as const,
  sectorAffinity: fullSectorAffinity({ ai: 88 }),
  stageBand: ['series_a', 'growth'] as const,
  thesis: 'The biggest cheque in the game.',
  committedCapitalUsd: 18 * BN,
  dryPowderUsd: 9 * BN,
  riskAppetite: 72,
  partnerCharacterIds: ['chr_helena_ward'],
};

/* -------------------------------------------------------------------------- */
/*  Defaults                                                                   */
/* -------------------------------------------------------------------------- */

describe('capital entity defaults', () => {
  it('fills every field a partial row omits', () => {
    const entity = CapitalEntitySchema.parse(minimalEntity);
    expect(entity.realisedProceedsUsd).toBe(0);
    expect(entity.feesPaidUsd).toBe(0);
    expect(entity.borrowFeesPaidUsd).toBe(0);
    expect(entity.carryPaidUsd).toBe(0);
    expect(entity.vintageQuarter).toBe(0);
    expect(entity.termQuarters).toBe(FUND_TERM_QUARTERS);
    expect(entity.investmentPeriodQuarters).toBe(INVESTMENT_PERIOD_QUARTERS);
    expect(entity.exitHorizonQuarters).toBe(INVESTMENT_PERIOD_QUARTERS);
    expect(entity.trackRecord).toBe(50);
    expect(entity.memory).toEqual([]);
    expect(entity.isActive).toBe(true);
  });

  it('takes a negative vintage, because an institution predates the session', () => {
    const entity = CapitalEntitySchema.parse({ ...minimalEntity, vintageQuarter: -26 });
    expect(entity.vintageQuarter).toBe(-26);
    expect(fundAgeQuarters(entity, 0)).toBe(26);
    // The clock never runs backwards, whatever quarter it is asked about.
    expect(fundAgeQuarters(entity, -40)).toBe(0);
  });

  it('refuses money that is not a whole number of dollars', () => {
    expect(() => CapitalEntitySchema.parse({ ...minimalEntity, dryPowderUsd: 1.5 })).toThrow();
    expect(() => CapitalEntitySchema.parse({ ...minimalEntity, committedCapitalUsd: -1 })).toThrow();
  });

  it('refuses an entity with no partner and one with four', () => {
    expect(() => CapitalEntitySchema.parse({ ...minimalEntity, partnerCharacterIds: [] })).toThrow();
    expect(() => CapitalEntitySchema.parse({ ...minimalEntity, partnerCharacterIds: ['a', 'b', 'c', 'd'] })).toThrow();
  });

  it('bounds the memory it keeps, because history on state is bounded', () => {
    const one = { companyId: 'cmp_x', kind: 'approach_made' as const, quarter: 3, outcome: 'rejected' as const, note: 'They said no.' };
    expect(CapitalEntitySchema.parse({ ...minimalEntity, memory: [one] }).memory).toHaveLength(1);
    const tooMany = Array.from({ length: CAPITAL_ENTITY_MEMORY_LIMIT + 1 }, () => one);
    expect(() => CapitalEntitySchema.parse({ ...minimalEntity, memory: tooMany })).toThrow();
  });

  it('keeps every kind on one 0..100 scale, with no second rating system', () => {
    expect(CAPITAL_ENTITY_KINDS).toEqual(['vc', 'pe', 'hedge_fund', 'sovereign']);
    expect(() => CapitalEntitySchema.parse({ ...minimalEntity, riskAppetite: 101 })).toThrow();
    expect(() => CapitalEntitySchema.parse({ ...minimalEntity, trackRecord: 4.5 })).toThrow();
  });
});

describe('short position defaults', () => {
  const minimalShort = {
    id: 'shp_0001',
    entityId: 'fund_coldbrook',
    securityId: 'sec_lumen',
    instrumentId: 'ins_lumen',
    companyId: 'cmp_lumen',
    shares: 400_000,
    openedQuarter: 4,
    openPriceUsd: 61,
    markPriceUsd: 61,
    marginPostedUsd: 12_200_000,
  };

  it('opens at the floor borrow fee and undisclosed', () => {
    const position = ShortPositionSchema.parse(minimalShort);
    expect(position.borrowFeePctPerQuarter).toBe(BORROW_FEE_MIN_PCT);
    expect(position.isDisclosed).toBe(false);
  });

  it('refuses a negative share count: the direction is the type, never a sign', () => {
    expect(() => ShortPositionSchema.parse({ ...minimalShort, shares: -400_000 })).toThrow();
  });

  it('refuses a borrow fee outside the ladder', () => {
    expect(() => ShortPositionSchema.parse({ ...minimalShort, borrowFeePctPerQuarter: 0 })).toThrow();
    expect(() => ShortPositionSchema.parse({ ...minimalShort, borrowFeePctPerQuarter: BORROW_FEE_MAX_PCT + 1 })).toThrow();
  });
});

describe('activist campaign defaults', () => {
  const minimalCampaign = {
    id: 'acp_0001',
    entityId: 'fund_kaido',
    targetCompanyId: 'cmp_ironvale',
    stage: 'private_letter' as const,
    demands: ['cut_costs' as const],
    openedQuarter: 6,
    lastEscalatedQuarter: 6,
    stakePct: 11,
    convictionPct: 44,
  };

  it('opens with no seats conceded and no outcome', () => {
    const campaign = ActivistCampaignSchema.parse(minimalCampaign);
    expect(campaign.seatsGranted).toBe(0);
    expect(campaign.outcome).toBeNull();
    expect(campaign.closedQuarter).toBeNull();
  });

  it('demands at least one thing and at most three', () => {
    expect(() => ActivistCampaignSchema.parse({ ...minimalCampaign, demands: [] })).toThrow();
    expect(() => ActivistCampaignSchema.parse({ ...minimalCampaign, demands: ['cut_costs', 'replace_ceo', 'return_capital', 'sell_the_company'] })).toThrow();
  });

  it('maps every demand onto a board proposal kind that already exists', () => {
    for (const demand of ACTIVIST_DEMANDS) {
      const kind = ACTIVIST_DEMAND_PROPOSAL_KIND[demand];
      expect(BOARD_PROPOSAL_KINDS).toContain(kind);
    }
  });

  it('gates the ladder on a rising stake and never skips a rung', () => {
    const gates = ACTIVIST_CAMPAIGN_STAGES.map((stage) => ({ stage, gate: stageGate(stage) }));
    for (let i = 1; i < gates.length; i += 1) {
      expect(gates[i]!.gate).toBeGreaterThanOrEqual(gates[i - 1]!.gate);
    }
    expect(gates[0]!.gate).toBe(ACTIVIST_OPEN_STAKE_PCT);
    expect(gates[1]!.gate).toBe(ACTIVIST_PUBLIC_STAKE_PCT);
    expect(gates[3]!.gate).toBe(ACTIVIST_PROXY_STAKE_PCT);
    for (const { stage, gate } of gates) expect(activistStakeGatePct(stage)).toBe(gate);
  });
});

/* -------------------------------------------------------------------------- */
/*  The short ledger is not the register                                       */
/* -------------------------------------------------------------------------- */

describe('shorts never touch ownership', () => {
  const capTable = CapTableSchema.parse({
    companyId: 'cmp_lumen',
    shareClasses: [
      {
        id: 'shc_lumen',
        companyId: 'cmp_lumen',
        kind: 'common',
        label: 'Common Stock',
        votesPerShare: 1,
        liquidationPreferenceMultiple: 0,
        participating: false,
        authorisedShares: 15_000_000,
        issuedShares: 10_000_000,
        createdQuarter: 0,
      },
    ],
    holdings: [
      { id: 'hld_1', holderId: 'chr_teresa', holderKind: 'character', securityId: 'sec_lumen', shares: 2_000_000, costBasisUsd: 100, acquiredQuarter: 0, lockupUntilQuarter: null, isDisclosed: true },
      { id: 'hld_2', holderId: 'fund_seawall', holderKind: 'fund', securityId: 'sec_lumen', shares: 1_000_000, costBasisUsd: 200, acquiredQuarter: 0, lockupUntilQuarter: null, isDisclosed: true },
      { id: 'hld_3', holderId: 'flt_lumen', holderKind: 'public_float', securityId: 'sec_lumen', shares: 7_000_000, costBasisUsd: 300, acquiredQuarter: 0, lockupUntilQuarter: null, isDisclosed: false },
    ],
    totalIssuedByClass: { shc_lumen: 10_000_000 },
    fullyDilutedShares: 10_000_000,
    optionPoolShares: 0,
    lastUpdatedQuarter: 0,
  });

  const short = ShortPositionSchema.parse({
    id: 'shp_lumen_coldbrook',
    entityId: 'fund_coldbrook',
    securityId: 'sec_lumen',
    instrumentId: 'ins_lumen',
    companyId: 'cmp_lumen',
    shares: 900_000,
    openedQuarter: 4,
    openPriceUsd: 61,
    markPriceUsd: 61,
    marginPostedUsd: 27_450_000,
  });

  it('leaves the ownership sum exactly as it was', () => {
    const held = capTable.holdings.reduce((sum, holding) => sum + holding.shares, 0);
    expect(held).toBe(capTable.totalIssuedByClass.shc_lumen);
    // The short exists and is large, and the register does not know about it.
    expect(short.shares).toBeGreaterThan(0);
    expect(capTable.holdings.some((holding) => holding.holderId === short.entityId)).toBe(false);
    expect(held).toBe(10_000_000);
  });

  it('never lets a holding go negative, which is what forced the separate ledger', () => {
    const negative = { ...capTable.holdings[0]!, id: 'hld_bad', shares: -1 };
    expect(() => HoldingSchema.parse(negative)).toThrow();
  });

  it('carries no holder kind, no votes and no cost basis, so nothing can mistake it for a position', () => {
    const keys = Object.keys(ShortPositionSchema.shape);
    for (const forbidden of ['holderId', 'holderKind', 'votesPerShare', 'costBasisUsd', 'lockupUntilQuarter']) {
      expect(keys).not.toContain(forbidden);
    }
    // And there is no holder kind that means "short": the register's vocabulary
    // is unchanged.
    expect(HOLDER_KINDS).toEqual(['player', 'company', 'character', 'fund', 'public_float']);
    expect(SHORT_LEDGER_INVARIANT.enforcedAt).toBe('quarter_commit');
    expect(SHORT_LEDGER_INVARIANT.statement).toContain('never appears in CapTable.holdings');
  });

  it('stays inside the per-instrument cap, measured against the float', () => {
    const floatShares = 7_000_000;
    expect(shortInterestPctOf(short.shares, floatShares)).toBe(13);
    expect(shortInterestPctOf(short.shares, floatShares)).toBeLessThanOrEqual(SHORT_INTEREST_CAP_PCT);
    // A second desk may still open, but only up to the cap.
    expect(shortHeadroomShares(short.shares, floatShares)).toBe(Math.floor((floatShares * SHORT_INTEREST_CAP_PCT) / 100) - short.shares);
    expect(shortHeadroomShares(2_000_000, floatShares)).toBe(0);
  });

  it('force-covers a position that falls through maintenance', () => {
    // Struck with 50% margin; a 60% rally leaves the margin under 30% of notional.
    expect(shortBreachesMaintenance(short, 61)).toBe(false);
    expect(shortBreachesMaintenance(short, 61 * 1.6)).toBe(false);
    expect(shortBreachesMaintenance(short, 61 * 1.7)).toBe(true);
    expect(SHORT_MAINTENANCE_PCT).toBeLessThan(50);
  });
});

/* -------------------------------------------------------------------------- */
/*  The arithmetic                                                             */
/* -------------------------------------------------------------------------- */

describe('the fund clock', () => {
  const entity = (over: Partial<Record<string, unknown>>) => CapitalEntitySchema.parse({ ...minimalEntity, ...over });

  it('runs from nothing at the vintage to everything at term', () => {
    const fresh = entity({ vintageQuarter: 0 });
    expect(lpPressureFor(fresh, 0)).toBe(0);
    expect(lpPressureFor(fresh, INVESTMENT_PERIOD_QUARTERS)).toBe(50);
    expect(lpPressureFor(fresh, FUND_TERM_QUARTERS)).toBe(100);
    expect(lpPressureFor(fresh, FUND_TERM_QUARTERS * 3)).toBe(100);
  });

  it('knocks ten points off for every ten points of DPI', () => {
    const returned = entity({ vintageQuarter: 0, realisedProceedsUsd: Math.round(18 * BN * 0.4) });
    expect(dpiPct(returned)).toBe(40);
    expect(lpPressureFor(returned, FUND_TERM_QUARTERS)).toBe(60);
    // DPI is capped at 2x, so a spectacular fund cannot drive pressure negative.
    const spectacular = entity({ vintageQuarter: 0, realisedProceedsUsd: 100 * BN });
    expect(dpiPct(spectacular)).toBe(200);
    expect(lpPressureFor(spectacular, FUND_TERM_QUARTERS)).toBe(0);
  });

  it('leaves the sovereign permanently unpressured, because it has no LPs', () => {
    const sovereign = entity({ kind: 'sovereign', vintageQuarter: -80 });
    expect(lpPressureFor(sovereign, 0)).toBe(0);
    expect(lpPressureBand(0)).toBe('calm');
    expect(SOVEREIGN_CHARTER_CAP_PCT).toBe(25);
  });

  it('reads in three bands and shortens the target multiple in the middle one', () => {
    expect(lpPressureBand(LP_PRESSURE_HARVEST_FLOOR - 1)).toBe('calm');
    expect(lpPressureBand(LP_PRESSURE_HARVEST_FLOOR)).toBe('harvesting');
    expect(lpPressureBand(LP_PRESSURE_FORCED_FLOOR)).toBe('forced');
    expect(targetMultipleFor(0)).toBe(TARGET_MULTIPLE);
    expect(targetMultipleFor(LP_PRESSURE_HARVEST_FLOOR)).toBe(TARGET_MULTIPLE_UNDER_PRESSURE);
  });
});

describe('the borrow ladder', () => {
  it('is a whole number, bounded, and never falls as the crowd grows', () => {
    let previous = 0;
    for (let interest = 0; interest <= 100; interest += 1) {
      const fee = borrowFeePctFor(interest);
      expect(Number.isInteger(fee)).toBe(true);
      expect(fee).toBeGreaterThanOrEqual(BORROW_FEE_MIN_PCT);
      expect(fee).toBeLessThanOrEqual(BORROW_FEE_MAX_PCT);
      expect(fee).toBeGreaterThanOrEqual(previous);
      previous = fee;
    }
    expect(borrowFeePctFor(0)).toBe(BORROW_FEE_MIN_PCT);
    expect(borrowFeePctFor(SHORT_INTEREST_CAP_PCT)).toBe(BORROW_FEE_MAX_PCT);
  });

  it('makes a squeeze a consequence of two public numbers and nothing else', () => {
    expect(squeezeTriggered(15, 10)).toBe(true);
    expect(squeezeTriggered(14, 40)).toBe(false);
    expect(squeezeTriggered(40, 9)).toBe(false);
  });

  it('reads zero short interest against a company with no float', () => {
    expect(shortInterestPctOf(1_000, 0)).toBe(0);
  });
});

describe('roster helpers', () => {
  it('fills every sector, so an affinity lookup is never undefined', () => {
    const affinity = fullSectorAffinity({ ai: 88, energy: 200, robotics: -5 });
    expect(Object.keys(affinity).sort()).toEqual([...SECTORS].sort());
    expect(affinity.energy).toBe(100);
    expect(affinity.robotics).toBe(0);
    expect(affinity.consumer).toBe(0);
  });

  it('turns a whole percentage into whole dollars', () => {
    expect(dryPowderFromPct(18 * BN, 55)).toBe(9_900_000_000);
    expect(Number.isInteger(dryPowderFromPct(900_000_000, 65))).toBe(true);
    expect(dryPowderFromPct(1_000, 140)).toBe(1_000);
  });

  it('prices a cheque for every stage the game has', () => {
    for (const stage of FUNDING_STAGES) {
      const pct = VC_CHEQUE_PCT_OF_AUM[stage];
      expect(pct).toBeGreaterThan(0);
      expect(pct).toBeLessThanOrEqual(10);
    }
  });
});

/* -------------------------------------------------------------------------- */
/*  Append-only                                                                */
/* -------------------------------------------------------------------------- */

describe('every enum grew at the end', () => {
  it('appends exactly ten ledger types, in one contiguous block', () => {
    expect(CAPITAL_EVENT_TYPES).toHaveLength(10);
    // The block stays contiguous and stays after `dividend_paid`. It is no
    // longer the *tail* of the enum: `accelerators_bought` was appended after it
    // when compute gained counterparties, and appending is exactly what the
    // enum's contract permits. What must never happen is an insertion, which
    // would renumber every row written before it.
    const start = SIM_EVENT_TYPES.indexOf(CAPITAL_EVENT_TYPES[0] as (typeof SIM_EVENT_TYPES)[number]);
    expect(start).toBeGreaterThan(0);
    expect(SIM_EVENT_TYPES.slice(start, start + 10)).toEqual(CAPITAL_EVENT_TYPES);
    expect(SIM_EVENT_TYPES[0]).toBe('quarter_opened');
    expect(SIM_EVENT_TYPES[start - 1]).toBe('dividend_paid');
    // `capacity_invested` was appended after `accelerators_bought` when
    // world 2 gained non-compute capacity (`invest_capacity`), and
    // `control_changed`/`group_transfer_executed`/`subsidiary_merged` after
    // that when world 2 gained group control (STAGE 4) — the same
    // append-only contract, three rows further along.
    expect(SIM_EVENT_TYPES.slice(start + 10)).toEqual([
      'accelerators_bought',
      'capacity_invested',
      'control_changed',
      'group_transfer_executed',
      'subsidiary_merged',
    ]);
    expect(new Set(SIM_EVENT_TYPES).size).toBe(SIM_EVENT_TYPES.length);
  });

  it('appends one invariant and names it in a machine-readable statement', () => {
    expect(SIMULATION_INVARIANTS[SIMULATION_INVARIANTS.length - 1]).toBe('capital_integrity');
    expect(SIMULATION_INVARIANTS[0]).toBe('deterministic_replay');
    expect(CAPITAL_INTEGRITY_INVARIANT.id).toBe('capital_integrity');
    expect(CAPITAL_INTEGRITY_INVARIANT.statement).toContain('funding_round_closed');
    expect(CAPITAL_INTEGRITY_INVARIANT.statement).toContain('dryPowderUsd >= 0');
  });

  it('appends two leaderboards, one subject kind and one action origin', () => {
    expect(LEADERBOARD_BOARDS.slice(-2)).toEqual(['capital_returns', 'assets_under_management']);
    expect(LEADERBOARD_BOARDS[0]).toBe('company_value');
    expect(LEADERBOARD_SUBJECT_KINDS.slice(-1)).toEqual(['fund']);
    expect(ACTION_ORIGINS.slice(-1)).toEqual(['sponsor']);
    expect(ACTION_ORIGINS[0]).toBe('player_ui');
  });

  it('appends two deal obligations that the union actually carries', () => {
    expect(DEAL_OBLIGATION_KINDS.slice(-2)).toEqual(['term_sheet', 'buyout_offer']);
    const termSheet = DealObligationSchema.parse({
      kind: 'term_sheet',
      entityId: 'fund_seawall',
      companyId: 'cmp_player',
      stage: 'series_b',
      amountUsd: 60_000_000,
      preMoneyUsd: 340_000_000,
      dilutionPct: 15,
      boardSeats: 1,
      proRata: true,
      protectiveProvisions: false,
      liquidationPreferenceMultiple: 1,
      participating: false,
    });
    expect(termSheet.kind).toBe('term_sheet');
    const buyout = DealObligationSchema.parse({
      kind: 'buyout_offer',
      entityId: 'fund_grantwood',
      targetCompanyId: 'cmp_lumen',
      offerValueUsd: 6_400_000_000,
      premiumPct: 22,
      stage: 'bear_hug',
      lboDebtUsd: 2_100_000_000,
      equityChequeUsd: 4_300_000_000,
    });
    expect(buyout.kind).toBe('buyout_offer');
    // The premium ceiling is a number, not a hope.
    expect(() => DealObligationSchema.parse({ kind: 'buyout_offer', entityId: 'f', targetCompanyId: 'c', offerValueUsd: 1, premiumPct: 140, stage: 'tender', lboDebtUsd: 0, equityChequeUsd: 1 })).toThrow();
  });

  it('carries exactly six order kinds and nothing that resolves an offer instantly', () => {
    expect(CAPITAL_ORDER_KINDS).toEqual(['buy', 'sell', 'short_open', 'short_cover', 'publish_report', 'campaign_step']);
    const order = CapitalOrderSchema.parse({
      kind: 'sell',
      id: 'cor_0001',
      entityId: 'fund_altiplano',
      quarter: 9,
      securityId: 'sec_copa',
      companyId: 'cmp_copa',
      shares: 120_000,
      limitPriceUsd: null,
      reason: 'lp_pressure',
      isForced: true,
    });
    expect(order.kind === 'sell' && order.isForced).toBe(true);
    // A term sheet is a deal, not an order: there is no order kind for it.
    expect(CAPITAL_ORDER_KINDS).not.toContain('term_sheet');
  });

  it('keeps the roster small enough to render on a phone', () => {
    expect(MAX_CAPITAL_ENTITIES).toBe(12);
  });
});

/** Local re-derivation of the stake gate, so the test does not just echo the source. */
function stageGate(stage: (typeof ACTIVIST_CAMPAIGN_STAGES)[number]): number {
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
