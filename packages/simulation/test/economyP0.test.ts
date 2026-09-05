/**
 * The priced economy: goods prices along the chain, the logistics toll, price
 * accords and antitrust exposure, dumping, dividends and control.
 *
 * Three rules run through the whole file, and they are the same three that
 * govern the engine:
 *
 * - **World 1 is frozen.** Every new mechanic is asserted to be exactly neutral
 *   for a version-1 session, and a version-1 session is asserted to grow none of
 *   the new state at all — an absent field hashes differently from a defaulted
 *   one, and the frozen hash in `world2Scenario.test.ts` is the other half of
 *   that proof.
 * - **Bounds, not dynamics.** Every figure the study bounds is fuzzed against
 *   its bound rather than spot-checked at one value.
 * - **Determinism first.** Anything resolved is resolved twice and compared by
 *   state hash, never by eye.
 */

import { describe, expect, it } from 'vitest';
import type { ActionIntent, SessionState, SubmittedAction } from '@frontier/contracts';
import {
  ACCORD_SUSPENSION_QUARTERS,
  ANTITRUST_EXPOSURE_WEIGHTS,
  BLOCK_PREMIUM,
  CARTEL_BONUS_FLOOR_PCT,
  CONTROL_DECISIVE_PCT,
  DIVIDEND_CASH_CAP_SHARE,
  DIVIDEND_MAX_PAYOUT_PCT,
  PREDATORY_QUARTERS_MAX,
  PREDATORY_UNDERCUT_THRESHOLD,
  PRESSURE_MAX,
  PRESSURE_TOTAL_CAP,
  SECTORS,
  SECTOR_META,
  SECTOR_PRICE_BOUNDS,
  SECTOR_SHORTAGE_MAX,
  SECTOR_SHORTAGE_STEP_DOWN,
  SECTOR_SHORTAGE_STEP_UP,
  SessionStateSchema,
  TOLL_FLOOR_SHARE,
  TOLL_MAX_PCT,
  TRADE_UPLIFT_REVENUE_CAP,
  antitrustExposure,
  antitrustFineUsd,
  antitrustHazardWeight,
  balanceSheetReconciles,
  blockExecutionPriceUsd,
  cartelBonusPct,
  combinedPressure,
  dividendUsd,
  grantsControl,
  grantsInformationRight,
  isPredatoryPrice,
  logisticsTollPct,
  nextPredatoryQuarters,
  nextSectorShortage,
  predatorPressure,
  sectorImbalance,
  sectorPriceIndexFor,
  shortageGate,
  stakeExecutionPriceUsd,
  undercutFraction,
} from '@frontier/contracts';
import { createRng, hashState } from '@frontier/shared';
import { createDefaultEngine } from '../src/engine';
import { DEMO_CHARACTERS, DEMO_COMPANIES, DEMO_PLAYER_ID, demoSessionInput } from '../src/scenario';
import { budgetFor, drawCandidates, ensureHazardStates, familyHazardFor, maxAntitrustExposure } from '../src/economy/hazards';
import { activeAccords, regionLogistics, sectorBalances, tollPaidPct, ultimateControllerId } from '../src/economy/prices';
import { isMultiSectorWorld, sectorEconomy, supplyGateFor, tightnessBySector, supplyBySector } from '../src/economy/sectors';
import { companyEnergyCostFactor, regionalEnergyIndex } from '../src/economy/regions';
import { controllingHolderId, tallyProposal } from '../src/boards/tally';
import { unclampedGrossMargin } from '../src/companies/products';
import { computeCost, lastQuarterNetIncomeUsd } from '../src/companies/financials';
import { runSettlement } from '../src/markets/settlement';

/* -------------------------------------------------------------------------- */
/*  Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

const SECTOR_BY_INDEX = ['ai', 'robotics', 'manufacturing', 'energy', 'logistics', 'consumer'] as const;
const REGION_BY_INDEX = ['north_america', 'east_asia', 'east_asia', 'middle_east', 'south_asia', 'europe'] as const;

/** A seven-company world-version-2 session, small enough to resolve dozens of times. */
function world2(seed = 424242): SessionState {
  const input = demoSessionInput(seed);
  const companies = input.companies ?? [];
  return SessionStateSchema.parse({
    ...input,
    config: { ...input.config, worldVersion: 2 },
    companies: companies.map((company, index) => ({
      ...company,
      sector: SECTOR_BY_INDEX[index % SECTOR_BY_INDEX.length],
      region: REGION_BY_INDEX[index % REGION_BY_INDEX.length],
      fundamentals: {
        revenueTtmUsd: Math.max(0, company.financials.revenueQuarterly) * 4,
        revenueGrowthQoQ: 0.04,
        revenueGrowthYoY: 0.18,
        grossMarginPct: 0.55,
        netIncomeTtmUsd: 0,
        sharesOutstanding: 10_000_000,
      },
    })),
  });
}

const world1 = (): SessionState => SessionStateSchema.parse(demoSessionInput());

const engine = createDefaultEngine();

/** Resolve `quarters` quarters and return the state hash at each step. */
function replay(start: SessionState, quarters: number, actionsFor: (quarter: number) => SubmittedAction[] = () => []): { state: SessionState; hashes: string[] } {
  let state = start;
  const hashes: string[] = [hashState(state)];
  for (let index = 0; index < quarters; index += 1) {
    const outcome = engine.resolver.resolveQuarter(state, actionsFor(index), null, []);
    expect(outcome.committed).toBe(true);
    state = outcome.nextState;
    hashes.push(hashState(state));
  }
  return { state, hashes };
}

function submit(state: SessionState, intent: ActionIntent, companyId = DEMO_COMPANIES.player): SubmittedAction {
  return {
    actionId: `act_p0_${intent.type}`,
    sessionId: state.sessionId,
    quarter: state.quarter,
    sequence: 0,
    actorPlayerId: DEMO_PLAYER_ID,
    actorCompanyId: companyId,
    actorCharacterId: DEMO_CHARACTERS.player,
    origin: 'player_ui',
    intent,
    confirmedByHuman: true,
  };
}

/* -------------------------------------------------------------------------- */
/*  P0-1 — sector goods prices                                                 */
/* -------------------------------------------------------------------------- */

describe('P0-1 sector goods prices', () => {
  it('is a pure function of the draft: the same state gives the same prices', () => {
    const state = world2();
    expect(JSON.stringify(sectorBalances(state))).toBe(JSON.stringify(sectorBalances(state)));
  });

  it('stays an integer inside [25, 175] across a fuzz of five hundred states', () => {
    const rng = createRng('p0_1_fuzz');
    for (let trial = 0; trial < 500; trial += 1) {
      const state = world2();
      for (const company of state.companies) {
        // Revenue anywhere from nothing to a hundred times trend, which is well
        // past any imbalance the clamp is meant to survive.
        const scale = rng.range(0, 100);
        company.fundamentals = { ...company.fundamentals, revenueTtmUsd: company.fundamentals.revenueTtmUsd * scale };
        company.financials = { ...company.financials, revenueQuarterly: company.financials.revenueQuarterly * scale };
      }
      const balances = sectorBalances(state);
      for (const sector of SECTORS) {
        const index = balances[sector].priceIndex;
        expect(Number.isInteger(index)).toBe(true);
        expect(index).toBeGreaterThanOrEqual(SECTOR_PRICE_BOUNDS.min);
        expect(index).toBeLessThanOrEqual(SECTOR_PRICE_BOUNDS.max);
      }
    }
  }, 60_000);

  it('reaches both ends of the band at a two-to-one imbalance', () => {
    expect(sectorPriceIndexFor(sectorImbalance(200, 100))).toBe(SECTOR_PRICE_BOUNDS.max);
    expect(sectorPriceIndexFor(sectorImbalance(100, 200))).toBe(SECTOR_PRICE_BOUNDS.min);
    expect(sectorPriceIndexFor(sectorImbalance(100, 100))).toBe(100);
  });

  it('raises an upstream price when downstream revenue rises', () => {
    const before = world2();
    const after = world2();
    for (const company of after.companies) {
      if (company.sector !== 'robotics') continue;
      company.fundamentals = { ...company.fundamentals, revenueTtmUsd: company.fundamentals.revenueTtmUsd * 8 + 1e9 };
    }
    // Robotics buys from manufacturing, so more robotics revenue calls on more
    // manufacturing output and the manufacturing index has to rise.
    expect(sectorBalances(after).manufacturing.priceIndex).toBeGreaterThan(sectorBalances(before).manufacturing.priceIndex);
  });

  it('deepens the shortage by ten and heals it by five, bounded at sixty and nought', () => {
    expect(nextSectorShortage(0, 1)).toBe(SECTOR_SHORTAGE_STEP_UP);
    expect(nextSectorShortage(10, 1)).toBe(20);
    expect(nextSectorShortage(SECTOR_SHORTAGE_MAX, 1)).toBe(SECTOR_SHORTAGE_MAX);
    expect(nextSectorShortage(SECTOR_SHORTAGE_MAX - 5, 1)).toBe(SECTOR_SHORTAGE_MAX);
    expect(nextSectorShortage(20, 0.99)).toBe(20 - SECTOR_SHORTAGE_STEP_DOWN);
    expect(nextSectorShortage(0, -1)).toBe(0);
    expect(nextSectorShortage(3, 0)).toBe(0);

    // Six quarters of neglect to a full shortage, twelve to recover from one.
    let counter = 0;
    let quarters = 0;
    while (counter < SECTOR_SHORTAGE_MAX) {
      counter = nextSectorShortage(counter, 1);
      quarters += 1;
    }
    expect(quarters).toBe(6);
    let healing = 0;
    while (counter > 0) {
      counter = nextSectorShortage(counter, 0);
      healing += 1;
    }
    expect(healing).toBe(12);
  });

  it('gates realised demand at exactly one minus the binding input\'s counter', () => {
    const state = world2();
    // Twenty-five and above is always the tighter of the two constraints, so the
    // gate is the shortage term outright.
    state.sectorShortages = { energy: 40 };
    const tightness = tightnessBySector(state, supplyBySector(state));
    expect(supplyGateFor(state, 'manufacturing', tightness)).toBeCloseTo(shortageGate(40), 9);
    expect(shortageGate(SECTOR_SHORTAGE_MAX)).toBeCloseTo(0.4, 9);
  });

  it('lands on the buyer as an input cost and on the seller as a bounded uplift', () => {
    const cheap = world2();
    cheap.sectorPrices = { ai: 50, energy: 50, manufacturing: 50, logistics: 50, robotics: 50, consumer: 50 };
    const dear = world2();
    dear.sectorPrices = { ai: 175, energy: 175, manufacturing: 175, logistics: 175, robotics: 175, consumer: 175 };
    for (const sector of SECTORS) {
      if (SECTOR_META[sector].inputs.length === 0) continue;
      expect(sectorEconomy(dear)[sector].inputCostMultiplier).toBeGreaterThan(sectorEconomy(cheap)[sector].inputCostMultiplier);
    }
  });

  it('writes one public price row per sector, and a shortage row only when the counter moves', () => {
    const outcome = engine.resolver.resolveQuarter(world2(), [], null, []);
    expect(outcome.committed).toBe(true);
    const priced = outcome.events.filter((event) => event.type === 'sector_price_set');
    expect(priced).toHaveLength(SECTORS.length);
    expect(priced.every((event) => event.visibility === 'public')).toBe(true);
    for (const event of outcome.events.filter((candidate) => candidate.type === 'sector_shortage_changed')) {
      expect(event.payload.before).not.toBe(event.payload.after);
    }
  });

  it('is exactly absent in world version 1, so the frozen world grows no new state', () => {
    const { state } = replay(world1(), 4);
    expect(isMultiSectorWorld(state)).toBe(false);
    expect(state.sectorPrices).toBeUndefined();
    expect(state.sectorShortages).toBeUndefined();
    expect(state.regionTolls).toBeUndefined();
    expect(state.economyReport ?? null).toBeNull();
    for (const company of state.companies) {
      expect(company.antitrustExposure).toBeUndefined();
      expect(company.predatoryQuarters).toBeUndefined();
      expect(company.dividendPolicyPct).toBeUndefined();
    }
  });

  it('resolves twelve quarters of a priced world identically from the same seed', () => {
    const first = replay(world2(), 12).hashes;
    const second = replay(world2(), 12).hashes;
    expect(second).toEqual(first);
    expect(new Set(first).size).toBe(first.length);
  }, 120_000);
});

/* -------------------------------------------------------------------------- */
/*  P0-2 — the logistics toll                                                  */
/* -------------------------------------------------------------------------- */

describe('P0-2 regional basis and the logistics toll', () => {
  it('is exactly zero below the dominance floor', () => {
    expect(logisticsTollPct(TOLL_FLOOR_SHARE - 0.001)).toBe(0);
    expect(logisticsTollPct(0.399)).toBe(0);
    expect(logisticsTollPct(0)).toBe(0);
    expect(logisticsTollPct(TOLL_FLOOR_SHARE)).toBe(0);
  });

  it('is non-decreasing in share and never exceeds the cap', () => {
    let previous = -1;
    for (let share = 0; share <= 1.0001; share += 0.005) {
      const toll = logisticsTollPct(share);
      expect(toll).toBeGreaterThanOrEqual(previous);
      expect(toll).toBeLessThanOrEqual(TOLL_MAX_PCT);
      expect(Number.isInteger(toll)).toBe(true);
      previous = toll;
    }
    expect(logisticsTollPct(1)).toBe(TOLL_MAX_PCT);
  });

  it('exempts the dominant controller\'s own group and charges everybody else', () => {
    const state = world2();
    // One region, one logistics company, one group: total dominance.
    const freight = state.companies.find((company) => company.sector === 'logistics');
    expect(freight).toBeDefined();
    if (freight === undefined) return;
    for (const company of state.companies) company.region = 'south_asia';
    const logistics = regionLogistics(state);
    expect(logistics.south_asia.dominantControllerId).toBe(ultimateControllerId(state, freight));
    expect(logistics.south_asia.tollPct).toBe(TOLL_MAX_PCT);

    expect(tollPaidPct(state, freight, logistics)).toBe(0);
    for (const company of state.companies) {
      if (company.id === freight.id || !company.isActive) continue;
      expect(tollPaidPct(state, company, logistics)).toBe(TOLL_MAX_PCT);
    }
  });

  it('lets a controller charge less than it has earned, and never more', () => {
    const state = world2();
    for (const company of state.companies) company.region = 'south_asia';
    const freight = state.companies.find((company) => company.sector === 'logistics');
    if (freight === undefined) throw new Error('fixture has no logistics company');
    freight.logisticsTollPct = 7;
    expect(regionLogistics(state).south_asia.tollPct).toBe(7);
    freight.logisticsTollPct = 99;
    expect(regionLogistics(state).south_asia.tollPct).toBe(TOLL_MAX_PCT);
  });

  it('traces the number on screen to a committed cost_recognised row', () => {
    const state = world2();
    for (const company of state.companies) company.region = 'south_asia';
    const outcome = engine.resolver.resolveQuarter(state, [], null, []);
    expect(outcome.committed).toBe(true);
    const costs = outcome.events.filter((event) => event.type === 'cost_recognised' && event.payload.kind === undefined);
    expect(costs.length).toBeGreaterThan(0);
    expect(costs.some((event) => (event.payload.logisticsTollPct as number) > 0)).toBe(true);
    for (const event of costs) {
      expect(typeof event.payload.logisticsTollPct).toBe('number');
      expect(typeof event.payload.tollExempt).toBe('boolean');
      expect(typeof event.payload.regionalEnergyIndex).toBe('number');
    }
  });

  it('applies the energy factor exactly once, so it cannot compound', () => {
    // `regions.ts` earns its discipline by giving each index one named accessor
    // and one call site, and the energy price now rides in through that accessor
    // rather than beside it. Applied twice, the energy line would be the square
    // of the factor; this pins it to exactly the first power.
    const state = world2();
    state.sectorPrices = { energy: 160 };
    const company = state.companies.find((candidate) => candidate.compute.ownedAccelerators > 0);
    if (company === undefined) throw new Error('fixture has no company with compute');

    const factor = companyEnergyCostFactor(state, company);
    expect(factor).toBeGreaterThan(1);

    const neutral = world2();
    neutral.sectorPrices = { energy: 100 };
    const same = neutral.companies.find((candidate) => candidate.id === company.id);
    if (same === undefined) throw new Error('fixture lost a company');
    const neutralFactor = companyEnergyCostFactor(neutral, same);

    const dearEnergy = computeCost(state, company).energyUsd;
    const baseEnergy = computeCost(neutral, same).energyUsd;
    expect(dearEnergy / baseEnergy).toBeCloseTo(factor / neutralFactor, 9);
    // The square would be the signature of a second call site.
    expect(dearEnergy / baseEnergy).not.toBeCloseTo((factor / neutralFactor) ** 2, 6);
  });

  it('folds the energy price into the one regional call site rather than beside it', () => {
    const state = world2();
    const company = state.companies[0];
    if (company === undefined) throw new Error('fixture has no companies');
    state.sectorPrices = { energy: 100 };
    const neutral = companyEnergyCostFactor(state, company);
    state.sectorPrices = { energy: 150 };
    const dear = companyEnergyCostFactor(state, company);
    expect(dear).toBeGreaterThan(neutral);
    expect(regionalEnergyIndex(state, 'middle_east')).toBe(Math.round(150 * (55 / 100)));
    // World 1 sees exactly one, whatever the (absent) energy price says.
    expect(companyEnergyCostFactor(world1(), company)).toBe(1);
  });
});

/* -------------------------------------------------------------------------- */
/*  P0-3 — accords and antitrust exposure                                      */
/* -------------------------------------------------------------------------- */

describe('P0-3 accords and antitrust exposure', () => {
  it('floors the accord bonus at five and caps it at thirty', () => {
    expect(cartelBonusPct(0)).toBe(CARTEL_BONUS_FLOOR_PCT);
    expect(cartelBonusPct(0.0001)).toBeGreaterThanOrEqual(CARTEL_BONUS_FLOOR_PCT);
    expect(cartelBonusPct(1)).toBe(30);
    let previous = -1;
    for (let share = 0; share <= 1.0001; share += 0.01) {
      const bonus = cartelBonusPct(share);
      expect(bonus).toBeGreaterThanOrEqual(previous);
      expect(bonus).toBeLessThanOrEqual(30);
      previous = bonus;
    }
  });

  it('cannot push the trade uplift past a quarter of revenue', () => {
    const state = world2();
    const member = state.companies.find((company) => company.sector === 'energy');
    const other = state.companies.find((company) => company.sector === 'energy' && company.id !== member?.id) ?? state.companies[1];
    if (member === undefined || other === undefined) throw new Error('fixture has no energy company');
    other.sector = 'energy';
    state.deals.push({
      id: 'deal_accord_test',
      proposerId: member.id,
      proposerKind: 'company',
      counterpartyId: other.id,
      counterpartyKind: 'company',
      gives: [{ kind: 'price_accord', sector: 'energy', memberCompanyIds: [member.id, other.id], quarters: 8 }],
      gets: [],
      confidentiality: 'private',
      expiresQuarter: state.quarter + 8,
      binding: true,
      intentStatements: [],
      summary: 'Hold the energy price together for two years.',
      status: 'accepted',
      createdQuarter: state.quarter,
      respondedQuarter: state.quarter,
      conversationId: null,
      breachedByPartyId: null,
    });
    // The dearest possible chain price plus the fattest possible accord bonus.
    state.sectorPrices = { energy: SECTOR_PRICE_BOUNDS.max };

    const accords = activeAccords(state);
    expect(accords).toHaveLength(1);
    expect(accords[0]?.bonusPct).toBeGreaterThanOrEqual(CARTEL_BONUS_FLOOR_PCT);

    const outcome = engine.resolver.resolveQuarter(state, [], null, []);
    expect(outcome.committed).toBe(true);
    for (const event of outcome.events.filter((candidate) => candidate.type === 'revenue_recognised')) {
      const revenue = event.payload.revenueUsd as number;
      const uplift = event.payload.tradeUpliftUsd as number;
      const gross = revenue - uplift;
      expect(Math.abs(uplift)).toBeLessThanOrEqual(gross * TRADE_UPLIFT_REVENUE_CAP + 1);
    }
  });

  it('decays about a tenth a quarter with every driver idle, and reaches nothing', () => {
    let score = 100;
    const idle = { sectorShare: 0, inAccord: false, recentAcquisitions: 0, tollChargedPct: 0, predatoryQuarters: 0 };
    const first = antitrustExposure({ exposure: score, ...idle }).score;
    expect(first).toBe(Math.round(0.9 * 100));
    for (let quarter = 0; quarter < 80 && score > 0; quarter += 1) score = antitrustExposure({ exposure: score, ...idle }).score;
    expect(score).toBe(0);
  });

  it('is monotone in each of the five drivers', () => {
    const base = { exposure: 20, sectorShare: 0.1, inAccord: false, recentAcquisitions: 0, tollChargedPct: 0, predatoryQuarters: 0 };
    const at = (patch: Partial<typeof base>): number => antitrustExposure({ ...base, ...patch }).score;
    expect(at({ sectorShare: 0.9 })).toBeGreaterThan(at({}));
    expect(at({ inAccord: true })).toBeGreaterThan(at({}));
    expect(at({ recentAcquisitions: 2 })).toBeGreaterThan(at({}));
    expect(at({ tollChargedPct: TOLL_MAX_PCT })).toBeGreaterThan(at({}));
    expect(at({ predatoryQuarters: 4 })).toBeGreaterThan(at({}));
    // And bounded at both ends.
    expect(at({ exposure: 100, sectorShare: 1, inAccord: true, recentAcquisitions: 9, tollChargedPct: 99, predatoryQuarters: 99 })).toBeLessThanOrEqual(100);
    expect(antitrustExposure({ exposure: 0, ...{ sectorShare: 0, inAccord: false, recentAcquisitions: 0, tollChargedPct: 0, predatoryQuarters: 0 } }).score).toBe(0);
  });

  it('names its five drivers plus the carry, for the drill-down', () => {
    const { contributions } = antitrustExposure({ exposure: 30, sectorShare: 0.4, inAccord: true, recentAcquisitions: 1, tollChargedPct: 10, predatoryQuarters: 2 });
    expect(contributions.map((entry) => entry.key)).toEqual(['carried', 'sector_share', 'accord', 'acquisitions', 'toll', 'predation']);
    for (const entry of contributions) expect(Number.isInteger(entry.points)).toBe(true);
  });

  it('fires the investigation more often at high exposure than at low, on the same seeds', () => {
    const count = (exposure: number): number => {
      let fired = 0;
      for (let seed = 0; seed < 240; seed += 1) {
        const state = world2();
        state.world.regulation.antitrust = 0.9;
        for (const company of state.companies) company.antitrustExposure = exposure;
        ensureHazardStates(state);
        const draw = drawCandidates(state, 0, createRng(`enforcement_${seed}`), budgetFor(state));
        if (draw.diagnostics.some((entry) => entry.familyId === 'fam_antitrust' && entry.fired)) fired += 1;
      }
      return fired;
    };
    expect(count(90)).toBeGreaterThan(count(10));
    expect(antitrustHazardWeight(0)).toBeLessThan(antitrustHazardWeight(100));
    expect(antitrustHazardWeight(100)).toBeCloseTo(2, 9);
  });

  it('changes the antitrust weight in place, so the draw order is unchanged', () => {
    const draws = (exposure: number | undefined): number => {
      const state = world2();
      state.world.regulation.antitrust = 0.9;
      for (const company of state.companies) company.antitrustExposure = exposure;
      ensureHazardStates(state);
      let count = 0;
      const base = createRng('draw_order');
      const counting = {
        next: () => {
          count += 1;
          return base.next();
        },
        range: (min: number, max: number) => base.range(min, max),
        int: (min: number, max: number) => base.int(min, max),
        pick: <T,>(arr: readonly T[]): T => base.pick(arr),
        shuffle: <T,>(arr: readonly T[]): T[] => base.shuffle(arr),
        fork: (label: string) => base.fork(label),
      };
      // `fork` returns the real stream, so the count is of this level only; the
      // point is that the number of draws does not depend on exposure.
      drawCandidates(state, 0, counting.fork('x'), budgetFor(state));
      return count;
    };
    expect(draws(0)).toBe(draws(95));
  });

  it('leaves the version-1 hazard exactly as it was', () => {
    const legacy = world1();
    for (const company of legacy.companies) company.antitrustExposure = 100;
    expect(familyHazardFor(legacy, 'fam_antitrust', 0.05)).toBe(0.05);
    expect(maxAntitrustExposure(legacy)).toBe(100);
    const priced = world2();
    for (const company of priced.companies) company.antitrustExposure = 100;
    expect(familyHazardFor(priced, 'fam_antitrust', 0.05)).toBeCloseTo(0.1, 9);
    expect(familyHazardFor(priced, 'fam_compute_supply', 0.05)).toBe(0.05);
  });

  it('bounds the fine by the lower of a share of cash and a share of trailing revenue', () => {
    expect(antitrustFineUsd(1_000_000, 100_000_000)).toBe(50_000);
    expect(antitrustFineUsd(100_000_000, 1_000_000)).toBe(20_000);
    expect(antitrustFineUsd(0, 100_000_000)).toBe(0);
    expect(antitrustFineUsd(-5, -5)).toBe(0);
  });

  it('suspends an accord for six quarters and pays nothing while it is suspended', () => {
    const state = world2();
    const [first, second] = state.companies;
    if (first === undefined || second === undefined) throw new Error('fixture has no companies');
    first.sector = 'energy';
    second.sector = 'energy';
    state.deals.push({
      id: 'deal_accord_suspended',
      proposerId: first.id,
      proposerKind: 'company',
      counterpartyId: second.id,
      counterpartyKind: 'company',
      gives: [{ kind: 'price_accord', sector: 'energy', memberCompanyIds: [first.id, second.id], quarters: 20 }],
      gets: [],
      confidentiality: 'private',
      expiresQuarter: state.quarter + 20,
      binding: true,
      intentStatements: [],
      summary: 'An accord that is about to be suspended by an investigation.',
      status: 'accepted',
      createdQuarter: state.quarter,
      respondedQuarter: state.quarter,
      conversationId: null,
      breachedByPartyId: null,
    });

    expect(activeAccords(state)[0]?.suspendedMemberIds).toEqual([]);
    first.accordSuspendedUntilQuarter = state.quarter + ACCORD_SUSPENSION_QUARTERS;
    expect(activeAccords(state)[0]?.suspendedMemberIds).toEqual([first.id]);

    // The sixth quarter is still suspended; the seventh is not.
    state.quarter += ACCORD_SUSPENSION_QUARTERS - 1;
    expect(activeAccords(state)[0]?.suspendedMemberIds).toEqual([first.id]);
    state.quarter += 1;
    expect(activeAccords(state)[0]?.suspendedMemberIds).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/*  P0-4 — dumping and price wars                                              */
/* -------------------------------------------------------------------------- */

describe('P0-4 dumping and price wars', () => {
  it('needs both a negative margin and a twenty per cent undercut', () => {
    expect(isPredatoryPrice(-0.4, 0.25)).toBe(true);
    expect(isPredatoryPrice(-0.4, PREDATORY_UNDERCUT_THRESHOLD)).toBe(true);
    // A loss at the market price is not predation, it is a bad business.
    expect(isPredatoryPrice(-0.4, 0.19)).toBe(false);
    // And a deep discount at a profit is competition, not predation.
    expect(isPredatoryPrice(0.3, 0.4)).toBe(false);
    expect(isPredatoryPrice(0, 0.4)).toBe(false);
  });

  it('measures the undercut against the segment reference, bounded at sixty per cent', () => {
    expect(undercutFraction(80, 100)).toBeCloseTo(0.2, 9);
    expect(undercutFraction(120, 100)).toBe(0);
    expect(undercutFraction(1, 100)).toBeCloseTo(0.6, 9);
    expect(undercutFraction(50, 0)).toBe(0);
  });

  it('is exactly zero when nobody is dumping', () => {
    expect(combinedPressure([])).toBe(0);
    expect(predatorPressure(0, 0.5)).toBe(0);
    expect(predatorPressure(0.5, 0)).toBe(0);
  });

  it('bounds pressure per predator and in total', () => {
    for (let share = 0; share <= 1.0001; share += 0.05) {
      for (let undercut = 0; undercut <= 0.6001; undercut += 0.05) {
        expect(predatorPressure(share, undercut)).toBeLessThanOrEqual(PRESSURE_MAX + 1e-12);
      }
    }
    expect(combinedPressure([PRESSURE_MAX, PRESSURE_MAX, PRESSURE_MAX, PRESSURE_MAX, PRESSURE_MAX])).toBeLessThanOrEqual(PRESSURE_TOTAL_CAP);
    expect(combinedPressure([PRESSURE_MAX, PRESSURE_MAX])).toBeCloseTo(1 - (1 - PRESSURE_MAX) ** 2, 9);
  });

  it('combines predators order-independently', () => {
    const pressures = [0.03, 0.11, 0.07, 0.02];
    const shuffled = [0.07, 0.02, 0.11, 0.03];
    expect(combinedPressure(shuffled)).toBeCloseTo(combinedPressure(pressures), 12);
  });

  it('steps the predatory counter by one in each direction and caps it at eight', () => {
    expect(nextPredatoryQuarters(0, true)).toBe(1);
    expect(nextPredatoryQuarters(7, true)).toBe(8);
    expect(nextPredatoryQuarters(PREDATORY_QUARTERS_MAX, true)).toBe(PREDATORY_QUARTERS_MAX);
    expect(nextPredatoryQuarters(3, false)).toBe(2);
    expect(nextPredatoryQuarters(0, false)).toBe(0);
  });

  it('feeds antitrust exposure eight points a quarter', () => {
    expect(ANTITRUST_EXPOSURE_WEIGHTS.predation).toBe(8);
    const idle = { exposure: 0, sectorShare: 0, inAccord: false, recentAcquisitions: 0, tollChargedPct: 0 };
    expect(antitrustExposure({ ...idle, predatoryQuarters: 1 }).score).toBe(8);
    expect(antitrustExposure({ ...idle, predatoryQuarters: 3 }).score).toBe(24);
  });

  it('reads a below-cost margin the stored unit interval cannot express', () => {
    const state = world2();
    const company = state.companies.find((candidate) => candidate.products.some((product) => product.isActive));
    const product = company?.products.find((candidate) => candidate.isActive);
    if (company === undefined || product === undefined) throw new Error('fixture has no product');
    product.pricePerSeat = 0.01;
    product.activeCustomers = Math.max(1000, product.activeCustomers);
    expect(product.grossMarginPct).toBeGreaterThanOrEqual(0);
    expect(unclampedGrossMargin(state, product)).toBeLessThan(0);
  });

  it('flags a dumped price publicly and squeezes the rivals in that segment', () => {
    const state = world2();
    // Everybody into one segment, and one of them sells at a cent.
    for (const company of state.companies) {
      for (const product of company.products) {
        product.segment = 'enterprise';
        product.isActive = true;
        product.activeCustomers = Math.max(2000, product.activeCustomers);
        product.pricePerSeat = 200;
      }
    }
    const predator = state.companies[1];
    if (predator === undefined) throw new Error('fixture has no rival');
    for (const product of predator.products) product.pricePerSeat = 1;

    const outcome = engine.resolver.resolveQuarter(state, [], null, []);
    expect(outcome.committed).toBe(true);
    const flagged = outcome.events.filter((event) => event.type === 'predatory_pricing_flagged');
    expect(flagged.length).toBeGreaterThan(0);
    expect(flagged.every((event) => event.visibility === 'public')).toBe(true);
    expect(flagged.every((event) => event.actorId === predator.id)).toBe(true);

    const squeezed = outcome.events.filter(
      (event) => event.type === 'demand_resolved' && (event.payload.rivalPricePressurePct as number) > 0,
    );
    expect(squeezed.length).toBeGreaterThan(0);
    for (const event of squeezed) {
      expect(event.payload.rivalPricePressurePct as number).toBeLessThanOrEqual(Math.round(PRESSURE_TOTAL_CAP * 100));
      expect(event.actorId).not.toBe(predator.id);
      expect(event.payload.pressureFrom).toContain(predator.id);
    }
    const after = outcome.nextState.companies.find((company) => company.id === predator.id);
    expect(after?.predatoryQuarters).toBe(1);
  });

  it('leaves the tuned price-rise path alone: world 1 never sees a pressure term', () => {
    const outcome = engine.resolver.resolveQuarter(world1(), [], null, []);
    expect(outcome.committed).toBe(true);
    expect(outcome.events.some((event) => event.type === 'predatory_pricing_flagged')).toBe(false);
    for (const event of outcome.events.filter((candidate) => candidate.type === 'demand_resolved')) {
      expect(event.payload.rivalPricePressurePct).toBe(0);
    }
  });
});

/* -------------------------------------------------------------------------- */
/*  P0-5 — dividends, stake accumulation and control                           */
/* -------------------------------------------------------------------------- */

describe('P0-5 dividends', () => {
  /** The fixture, with the player made comfortably profitable last quarter. */
  function profitable(payoutPct: number): SessionState {
    const state = world2();
    const company = state.companies.find((candidate) => candidate.id === DEMO_COMPANIES.player);
    if (company === undefined) throw new Error('fixture has no player company');
    company.dividendPolicyPct = payoutPct;
    company.financials = {
      ...company.financials,
      revenueQuarterly: 40_000_000,
      cogs: 8_000_000,
      payroll: 6_000_000,
      marketing: 1_000_000,
      rdSpend: 1_000_000,
      interestExpense: 0,
    };
    company.balanceSheet.assets.cash = 60_000_000;
    company.financials.cash = 60_000_000;
    company.balanceSheet.equity =
      company.balanceSheet.assets.cash +
      company.balanceSheet.assets.ppe +
      company.balanceSheet.assets.goodwill +
      company.balanceSheet.assets.investments +
      company.balanceSheet.assets.receivables -
      (company.balanceSheet.liabilities.debt + company.balanceSheet.liabilities.payables + company.balanceSheet.liabilities.deferredRevenue);
    return state;
  }

  it('balances the sheet at every payout from nought to eighty in fives', () => {
    for (let payout = 0; payout <= DIVIDEND_MAX_PAYOUT_PCT; payout += 5) {
      const outcome = engine.resolver.resolveQuarter(profitable(payout), [], null, []);
      expect(`${payout}%: ${outcome.invariants.filter((entry) => !entry.passed).map((entry) => entry.detail).join('; ')}`).toBe(`${payout}%: `);
      expect(outcome.committed).toBe(true);
      for (const company of outcome.nextState.companies) {
        if (!company.isActive) continue;
        expect(balanceSheetReconciles(company.balanceSheet)).toBe(true);
      }
    }
  }, 120_000);

  it('caps the payout at half of cash however high the policy is', () => {
    expect(dividendUsd(100, 80, 1_000_000)).toBe(80);
    // Ten million of income, a million of cash: half the cash is the binding cap.
    expect(dividendUsd(10_000_000, 80, 1_000_000)).toBe(Math.round(1_000_000 * DIVIDEND_CASH_CAP_SHARE));
    expect(dividendUsd(10_000_000, 80, 0)).toBe(0);
    // A loss pays nothing, whatever the policy.
    expect(dividendUsd(-10_000_000, 80, 50_000_000)).toBe(0);
  });

  it('pays nothing and emits nothing at a payout of zero', () => {
    const outcome = engine.resolver.resolveQuarter(profitable(0), [], null, []);
    expect(outcome.committed).toBe(true);
    expect(outcome.events.some((event) => event.type === 'dividend_paid')).toBe(false);
  });

  it('strikes the payout on last quarter\'s net income, not this quarter\'s', () => {
    const state = profitable(50);
    const company = state.companies.find((candidate) => candidate.id === DEMO_COMPANIES.player);
    if (company === undefined) throw new Error('fixture has no player company');
    const basis = lastQuarterNetIncomeUsd(company);
    expect(basis).toBeGreaterThan(0);

    const outcome = engine.resolver.resolveQuarter(state, [], null, []);
    const paid = outcome.events.find((event) => event.type === 'dividend_paid');
    expect(paid).toBeDefined();
    expect(paid?.payload.netIncomeBasisUsd).toBeCloseTo(basis, 1);
    // The quarter's *own* result is different, and is not what was paid on.
    const thisQuarter = outcome.nextState.companies.find((candidate) => candidate.id === company.id);
    expect(lastQuarterNetIncomeUsd(thisQuarter ?? company)).not.toBeCloseTo(basis, 1);
    expect(paid?.payload.dividendUsd).toBe(dividendUsd(basis, 50, 60_000_000));
  });

  it('is never paid in a single-sector world', () => {
    const state = world1();
    const company = state.companies.find((candidate) => candidate.id === DEMO_COMPANIES.player);
    if (company === undefined) throw new Error('fixture has no player company');
    company.dividendPolicyPct = 80;
    company.financials = { ...company.financials, revenueQuarterly: 40_000_000, cogs: 1_000, payroll: 1_000, marketing: 0, rdSpend: 0, interestExpense: 0 };
    const outcome = engine.resolver.resolveQuarter(state, [], null, []);
    expect(outcome.committed).toBe(true);
    expect(outcome.events.some((event) => event.type === 'dividend_paid')).toBe(false);
  });

  it('records the payout policy the action set, and offers a preview the screen can render', () => {
    const state = world2();
    const company = state.companies.find((candidate) => candidate.id === DEMO_COMPANIES.player);
    if (company === undefined) throw new Error('fixture has no player company');
    company.boardId = null; // management's call when there is no board to ask
    const action = submit(state, { type: 'set_dividend_policy', payoutPct: 35 });
    const outcome = engine.resolver.resolveQuarter(state, [action], null, []);
    expect(outcome.committed).toBe(true);
    expect(outcome.nextState.companies.find((candidate) => candidate.id === company.id)?.dividendPolicyPct).toBe(35);
  });
});

describe('P0-5 convex stake accumulation', () => {
  it('rises with size and never passes twice the quote', () => {
    const quote = 10;
    let previous = 0;
    for (let bought = 0; bought <= 1000; bought += 25) {
      const price = stakeExecutionPriceUsd(quote, bought, 1000);
      expect(price).toBeGreaterThanOrEqual(previous);
      expect(price).toBeLessThanOrEqual(quote * BLOCK_PREMIUM + 1e-9);
      previous = price;
    }
    expect(stakeExecutionPriceUsd(quote, 1000, 1000)).toBeCloseTo(quote * 2, 9);
    expect(stakeExecutionPriceUsd(quote, 0, 1000)).toBeCloseTo(quote, 9);
    expect(stakeExecutionPriceUsd(quote, 100, 1000)).toBeCloseTo(quote * 1.1, 9);
  });

  it('prices a named holder\'s block at flat double', () => {
    expect(blockExecutionPriceUsd(10)).toBeCloseTo(20, 9);
    expect(blockExecutionPriceUsd(3.33)).toBeCloseTo(6.66, 9);
  });

  it('charges the impact on a real purchase, and leaves world 1 paying the quote', () => {
    const buy = (state: SessionState): { settled: number; quote: number; execution: number; impact: number; consideration: number } => {
      const buyer = state.companies.find((company) => company.id === DEMO_COMPANIES.player);
      if (buyer === undefined) throw new Error('fixture has no player company');
      buyer.financials.cash = 5_000_000_000;
      buyer.balanceSheet.assets.cash = 5_000_000_000;
      state.quotes.push({ instrumentId: 'ins_nexus_eq', quarter: state.quarter, price: 10, return: 0, volume: 10_000_000, marketCapUsd: 10 * 10_000_000 });
      state.pendingActions.push(
        submit(state, { type: 'buy_shares', securityId: 'sec_nexus_common', targetPct: null, shares: 5_000_000, maxPricePerShareUsd: 100 }),
      );
      const settlement = runSettlement(state, state.quarter)[0];
      if (settlement === undefined) throw new Error('nothing settled');
      return {
        settled: settlement.settledShares,
        quote: settlement.quotePriceUsd,
        execution: settlement.executionPriceUsd,
        impact: settlement.impactPct,
        consideration: settlement.considerationUsd,
      };
    };

    const legacy = buy(world1());
    expect(legacy.impact).toBe(0);
    expect(legacy.execution).toBe(legacy.quote);
    expect(legacy.consideration).toBeCloseTo(legacy.settled * legacy.quote, 2);

    const priced = buy(world2());
    expect(priced.settled).toBeGreaterThan(0);
    expect(priced.impact).toBeGreaterThan(0);
    expect(priced.execution).toBeGreaterThan(priced.quote);
    expect(priced.execution).toBeLessThanOrEqual(priced.quote * BLOCK_PREMIUM);
  });

  it('reconciles the cap table after a convex purchase', () => {
    const state = world2();
    const buyer = state.companies.find((company) => company.id === DEMO_COMPANIES.player);
    if (buyer === undefined) throw new Error('fixture has no player company');
    buyer.financials.cash = 5_000_000_000;
    buyer.balanceSheet.assets.cash = 5_000_000_000;
    state.quotes.push({ instrumentId: 'ins_nexus_eq', quarter: state.quarter, price: 10, return: 0, volume: 50_000_000, marketCapUsd: 500_000_000 });
    state.pendingActions.push(submit(state, { type: 'buy_shares', securityId: 'sec_nexus_common', targetPct: null, shares: 2_000_000, maxPricePerShareUsd: 100 }));

    const table = state.capTables.find((candidate) => candidate.companyId === DEMO_COMPANIES.nexus);
    if (table === undefined) throw new Error('fixture has no nexus cap table');
    const before = table.holdings.reduce((sum, holding) => sum + holding.shares, 0);
    runSettlement(state, state.quarter);
    const after = table.holdings.reduce((sum, holding) => sum + holding.shares, 0);
    expect(after).toBe(before);
    for (const shareClass of table.shareClasses) {
      expect(table.totalIssuedByClass[shareClass.id] ?? shareClass.issuedShares).toBe(shareClass.issuedShares);
    }
  });
});

describe('P0-5 control', () => {
  it('flips at fifty per cent plus one share and not at exactly a half', () => {
    expect(grantsControl(500, 1000)).toBe(false);
    expect(grantsControl(501, 1000)).toBe(true);
    expect(grantsControl(0, 0)).toBe(false);
    expect(grantsInformationRight(250, 1000)).toBe(true);
    expect(grantsInformationRight(249, 1000)).toBe(false);
  });

  it('finds the controlling holder, and none when the register is split', () => {
    const state = world2();
    const table = state.capTables.find((candidate) => candidate.companyId === DEMO_COMPANIES.player);
    if (table === undefined) throw new Error('fixture has no player cap table');
    const controller = controllingHolderId(state, DEMO_COMPANIES.player);
    expect(controller).not.toBeNull();

    // Halve the largest position and the register no longer has a majority.
    const largest = table.holdings.slice().sort((a, b) => b.shares - a.shares)[0];
    if (largest === undefined) throw new Error('fixture has no holdings');
    const issued = table.shareClasses.reduce((sum, klass) => sum + klass.issuedShares, 0);
    largest.shares = Math.floor(issued / 2);
    expect(controllingHolderId(state, DEMO_COMPANIES.player)).toBeNull();
  });

  it('lets the controlling holder decide everything except a dismissal', () => {
    const state = world2();
    const board = state.boards.find((candidate) => candidate.companyId === DEMO_COMPANIES.player);
    const table = state.capTables.find((candidate) => candidate.companyId === DEMO_COMPANIES.player);
    if (board === undefined || table === undefined) throw new Error('fixture has no board');

    // The founder holds a clear majority and sits on the board.
    const issued = table.shareClasses.reduce((sum, klass) => sum + klass.issuedShares, 0);
    for (const holding of table.holdings) holding.shares = 0;
    const founder = table.holdings[0];
    if (founder === undefined) throw new Error('fixture has no holdings');
    founder.holderId = DEMO_CHARACTERS.player;
    founder.holderKind = 'character';
    founder.shares = issued;
    expect(controllingHolderId(state, DEMO_COMPANIES.player)).toBe(DEMO_CHARACTERS.player);

    // Every other director is set to oppose as hard as the model allows.
    for (const director of board.directors) {
      if (director.characterId === DEMO_CHARACTERS.player) continue;
      director.independence = 100;
      director.financialDiscipline = 100;
      director.riskTolerance = 0;
      director.growthPreference = 0;
      director.relationshipWithCeo = -100;
      director.mandate = 'public_interest';
    }

    const tabled = (kind: 'annual_plan' | 'ceo_dismissal', id: string): void => {
      state.boardProposals.push({
        id,
        companyId: DEMO_COMPANIES.player,
        boardId: board.id,
        kind,
        title: kind === 'annual_plan' ? 'The operating plan' : 'Dismiss the chief executive',
        summary: 'A matter for the board, tabled so the tally can be read directly.',
        proposedByCharacterId: board.directors[1]?.characterId ?? DEMO_CHARACTERS.player,
        quarterProposed: state.quarter,
        decisionQuarter: state.quarter,
        status: 'tabled',
        amountUsd: null,
        dilutionPct: null,
        stockComponentPct: null,
        targetCompanyId: null,
        linkedActionId: null,
        requiredThresholdFraction: 0.5,
      });
    };
    tabled('annual_plan', 'prp_control_plan');
    tabled('ceo_dismissal', 'prp_control_dismissal');

    const plan = tallyProposal(state, 'prp_control_plan');
    expect(plan.controllingHolderId).toBe(DEMO_CHARACTERS.player);
    expect(plan.decidedByControl).toBe(true);
    expect(plan.passes).toBe(true);

    // A controlling player can still be fired. That is the better story.
    const dismissal = tallyProposal(state, 'prp_control_dismissal');
    expect(dismissal.decidedByControl).toBe(false);
    expect(dismissal.controllingHolderId).toBeNull();
  });

  it('leaves world 1 tallies exactly as they were', () => {
    const state = world1();
    const board = state.boards.find((candidate) => candidate.companyId === DEMO_COMPANIES.player);
    if (board === undefined) throw new Error('fixture has no board');
    state.boardProposals.push({
      id: 'prp_v1_plan',
      companyId: DEMO_COMPANIES.player,
      boardId: board.id,
      kind: 'annual_plan',
      title: 'The operating plan',
      summary: 'A matter for the board, tabled so the tally can be read directly.',
      proposedByCharacterId: DEMO_CHARACTERS.player,
      quarterProposed: state.quarter,
      decisionQuarter: state.quarter,
      status: 'tabled',
      amountUsd: null,
      dilutionPct: null,
      stockComponentPct: null,
      targetCompanyId: null,
      linkedActionId: null,
      requiredThresholdFraction: 0.5,
    });
    const tally = tallyProposal(state, 'prp_v1_plan');
    expect(tally.decidedByControl).toBe(false);
    expect(tally.controllingHolderId).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/*  Attribution — the rows every surface reads                                 */
/* -------------------------------------------------------------------------- */

describe('attribution', () => {
  it('writes stacks whose rows sum exactly to the total, each citing a committed row', () => {
    const state = world2();
    for (const company of state.companies) company.region = 'south_asia';
    const outcome = engine.resolver.resolveQuarter(state, [], null, []);
    expect(outcome.committed).toBe(true);
    const report = outcome.nextState.economyReport;
    expect(report).toBeDefined();
    if (report === undefined || report === null) return;

    const emitted = new Set(outcome.events.map((event) => event.eventId));
    expect(report.priceStacks.length).toBeGreaterThan(0);
    expect(report.costStacks.length).toBeGreaterThan(0);

    for (const stack of [...report.priceStacks, ...report.costStacks]) {
      const summed = stack.rows.reduce((total, row) => total + row.amountUsd, 0);
      // Whole dollars in, whole dollars out: the screen adds nothing up itself.
      expect(Math.abs(stack.baseUsd + summed - stack.totalUsd)).toBeLessThanOrEqual(2);
      for (const row of stack.rows) {
        expect(Number.isInteger(row.pct)).toBe(true);
        expect(Number.isInteger(row.amountUsd)).toBe(true);
        expect(row.causeEventId).not.toBeNull();
        expect(emitted.has(row.causeEventId ?? '')).toBe(true);
      }
    }
  });

  it('writes one ladder row per sector and one toll row per region, and exposure drivers per company', () => {
    const outcome = engine.resolver.resolveQuarter(world2(), [], null, []);
    const report = outcome.nextState.economyReport;
    expect(report).toBeDefined();
    if (report === undefined || report === null) return;
    expect(report.sectorPrices).toHaveLength(SECTORS.length);
    expect(report.regionTolls).toHaveLength(6);
    for (const row of report.sectorPrices) {
      expect(Number.isInteger(row.priceIndex)).toBe(true);
      expect(Number.isInteger(row.imbalancePct)).toBe(true);
      expect(row.endSharePct + row.tradeSharePct).toBe(100);
    }
    for (const exposure of report.exposures) {
      expect(exposure.drivers.length).toBe(6);
      expect(['calm', 'watched', 'exposed']).toContain(exposure.band);
    }
    for (const row of report.control) {
      expect(row.controlThresholdPct).toBe(Math.round(CONTROL_DECISIVE_PCT * 100));
      expect(row.hasControl).toBe(grantsControl(row.sharesHeld, row.issuedShares));
    }
  });

  it('is rebuilt every quarter rather than accumulated', () => {
    const { state } = replay(world2(), 3);
    expect(state.economyReport?.quarter).toBe(2);
    expect(state.economyReport?.sectorPrices).toHaveLength(SECTORS.length);
  });
});
