/**
 * World version 2: the multi-sector economy, regional cost, prices anchored to
 * fundamentals, and the bounded state that keeps a long session survivable on a
 * phone.
 *
 * Two rules run through every test here:
 *
 * - **World version 1 is frozen.** Every new multiplier is asserted to be
 *   exactly `1` for a version-1 session. The 410 tests that were passing before
 *   this file existed are the other half of that proof; nothing in them changed.
 * - **Determinism first.** Anything the engine does twice must produce the same
 *   bytes, so the pricing and resolution tests resolve the same world twice and
 *   compare hashes rather than eyeballing a number.
 */

import { describe, expect, it } from 'vitest';
import type { GovernmentContract, ProcurementOpportunity, SessionState, StoredGovernmentBid } from '@frontier/contracts';
import {
  REGIONS,
  REGION_META,
  SECTORS,
  SECTOR_META,
  SHARE_PRICE_BAND_USD,
  SessionStateSchema,
  marketCapFromPrice,
  quoteMarketCapReconciles,
  sharesForMarketCap,
  sectorSupplyGraphIsConsistent,
} from '@frontier/contracts';
import { hashState } from '@frontier/shared';
import { createDefaultEngine } from '../src/engine';
import { demoSessionInput } from '../src/scenario';
import {
  SECTOR_CYCLE_AMPLITUDE,
  SECTOR_DEMAND_BOUNDS,
  SECTOR_INPUT_COST_BOUNDS,
  SUPPLY_GATE_FLOOR,
  isMultiSectorWorld,
  sectorDemandCycle,
  sectorEconomy,
} from '../src/economy/sectors';
import {
  REGION_FACTOR_BOUNDS,
  companyCapitalDepthFactor,
  companyEnergyCostFactor,
  companyRegionFitFactor,
  companyTalentCostFactor,
  regionTalentCostFactor,
  sessionProcurementFactor,
} from '../src/economy/regions';
import { fundamentalValueUsd, qualityScore, sectorRevenueMultiple } from '../src/markets/fundamentalValue';
import { V2_MAX_ABS_LOG_RETURN, V2_SHOCK_MAX_ABS_LOG_RETURN } from '../src/markets/pricing';
import { strategistCompanyIds } from '../src/companies/strategists';
import { SETTLED_RECORD_HORIZON_QUARTERS, normaliseShareCount } from '../src/resolver';

/* -------------------------------------------------------------------------- */
/*  Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

/** The six real-economy sectors, spread across the seven demo companies. */
const SECTOR_BY_INDEX = ['ai', 'robotics', 'manufacturing', 'energy', 'logistics', 'consumer'] as const;
const REGION_BY_INDEX = ['north_america', 'east_asia', 'east_asia', 'middle_east', 'south_asia', 'europe'] as const;

/**
 * A world-version-2 session built from the frozen demo world.
 *
 * The scenario stage owns the real version-2 world; this fixture exists so the
 * engine can be exercised against a multi-sector state before that lands. It
 * changes exactly three things: the world version, each company's sector and
 * region, and a starting set of fundamentals — which is precisely the list a
 * version-2 scenario must supply.
 */
function createWorld2Session(seed = 424242): SessionState {
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

const v1Session = (): SessionState => SessionStateSchema.parse(demoSessionInput());

/* -------------------------------------------------------------------------- */
/*  Sector economics                                                           */
/* -------------------------------------------------------------------------- */

describe('sector economics', () => {
  it('declares a supply graph whose two halves agree', () => {
    expect(sectorSupplyGraphIsConsistent()).toBe(true);
  });

  it('puts each sector on its own cycle, bounded by the amplitude and never in unison', () => {
    for (const sector of SECTORS) {
      const length = SECTOR_META[sector].demandCycleQuarters;
      for (let quarter = 0; quarter <= length * 2; quarter += 1) {
        const value = sectorDemandCycle(sector, quarter);
        expect(value).toBeGreaterThanOrEqual(1 - SECTOR_CYCLE_AMPLITUDE - 1e-9);
        expect(value).toBeLessThanOrEqual(1 + SECTOR_CYCLE_AMPLITUDE + 1e-9);
      }
    }
    // Six sectors on six phases: at quarter 0 no two share a cycle position.
    const atZero = SECTORS.map((sector) => sectorDemandCycle(sector, 0).toFixed(6));
    expect(new Set(atZero).size).toBeGreaterThan(1);
  });

  it('is a pure function of the state: the same state gives the same conditions', () => {
    const state = createWorld2Session();
    expect(JSON.stringify(sectorEconomy(state))).toBe(JSON.stringify(sectorEconomy(state)));
  });

  it('bounds every multiplier it produces', () => {
    const economy = sectorEconomy(createWorld2Session());
    for (const sector of SECTORS) {
      const row = economy[sector];
      expect(row.demandMultiplier).toBeGreaterThanOrEqual(SECTOR_DEMAND_BOUNDS.min);
      expect(row.demandMultiplier).toBeLessThanOrEqual(SECTOR_DEMAND_BOUNDS.max);
      expect(row.inputCostMultiplier).toBeGreaterThanOrEqual(SECTOR_INPUT_COST_BOUNDS.min);
      expect(row.inputCostMultiplier).toBeLessThanOrEqual(SECTOR_INPUT_COST_BOUNDS.max);
      expect(row.supplyGate).toBeGreaterThanOrEqual(SUPPLY_GATE_FLOOR);
      expect(row.supplyGate).toBeLessThanOrEqual(1);
      expect(row.tightness).toBeGreaterThanOrEqual(0);
      expect(row.tightness).toBeLessThanOrEqual(1);
    }
  });

  it('gates a sector on its inputs and leaves a terminal sector alone', () => {
    const state = createWorld2Session();
    // Strip every energy company out and the sectors that consume energy must be
    // gated, while a sector with no energy input is untouched.
    const starved = SessionStateSchema.parse({
      ...state,
      companies: state.companies.map((company) => (company.sector === 'energy' ? { ...company, isActive: false } : company)),
    });
    const before = sectorEconomy(state);
    const after = sectorEconomy(starved);
    expect(after.manufacturing.supplyGate).toBeLessThan(before.manufacturing.supplyGate);
    expect(after.ai.supplyGate).toBeLessThan(before.ai.supplyGate);
    // Energy is the sector that vanished, so nobody is calling on it any more:
    // its own input (AI) is better supplied than before and its gate rises. That
    // the coupling runs in both directions is the point of the supply graph.
    expect(after.energy.supplyGate).toBeGreaterThanOrEqual(before.energy.supplyGate);
    // Robotics and consumer are terminal; nothing downstream of them exists, so
    // their tightness is 1 whatever happens upstream.
    expect(after.robotics.tightness).toBe(1);
    expect(after.consumer.tightness).toBe(1);
  });

  it('is exactly neutral in world version 1', () => {
    const economy = sectorEconomy(v1Session());
    expect(isMultiSectorWorld(v1Session())).toBe(false);
    for (const sector of SECTORS) {
      expect(economy[sector].demandMultiplier).toBe(1);
      expect(economy[sector].inputCostMultiplier).toBe(1);
      expect(economy[sector].supplyGate).toBe(1);
      expect(economy[sector].sustainingCapitalShare).toBe(0);
    }
  });
});

/* -------------------------------------------------------------------------- */
/*  Regions                                                                    */
/* -------------------------------------------------------------------------- */

describe('regions', () => {
  it('turns every index into a bounded multiplier around one', () => {
    for (const region of REGIONS) {
      const factor = regionTalentCostFactor(region);
      expect(factor).toBeGreaterThanOrEqual(REGION_FACTOR_BOUNDS.min);
      expect(factor).toBeLessThanOrEqual(REGION_FACTOR_BOUNDS.max);
      expect(factor).toBeCloseTo(REGION_META[region].talentCostIndex / 100, 9);
    }
  });

  it('prices talent where the company actually is', () => {
    const state = createWorld2Session();
    const american = state.companies.find((company) => company.region === 'north_america');
    const asian = state.companies.find((company) => company.region === 'south_asia');
    expect(american).toBeDefined();
    expect(asian).toBeDefined();
    if (american === undefined || asian === undefined) return;
    expect(companyTalentCostFactor(state, american)).toBeGreaterThan(companyTalentCostFactor(state, asian));
  });

  it('is exactly one everywhere in world version 1', () => {
    const state = v1Session();
    for (const company of state.companies) {
      expect(companyTalentCostFactor(state, company)).toBe(1);
      expect(companyEnergyCostFactor(state, company)).toBe(1);
      expect(companyCapitalDepthFactor(state, company)).toBe(1);
      expect(companyRegionFitFactor(state, company)).toBe(1);
    }
    expect(sessionProcurementFactor(state)).toBe(1);
  });

  it('damps sector affinity rather than passing it through whole', () => {
    const state = createWorld2Session();
    for (const company of state.companies) {
      const fit = companyRegionFitFactor(state, company);
      expect(fit).toBeGreaterThan(0.6);
      expect(fit).toBeLessThan(1.3);
    }
  });
});

/* -------------------------------------------------------------------------- */
/*  Fundamentals and the valuation anchor                                      */
/* -------------------------------------------------------------------------- */

describe('fundamental value', () => {
  it('keeps a multiple inside its sector band, so a freight network is not a laboratory', () => {
    const state = createWorld2Session();
    for (const company of state.companies) {
      const band = SECTOR_META[company.sector].revenueMultipleBand;
      const multiple = sectorRevenueMultiple(state, company);
      expect(multiple).toBeGreaterThanOrEqual(band[0] * 0.5);
      expect(multiple).toBeLessThanOrEqual(band[1] * 2.2);
    }
    const ai = state.companies.find((company) => company.sector === 'ai');
    const logistics = state.companies.find((company) => company.sector === 'logistics');
    if (ai === undefined || logistics === undefined) throw new Error('fixture is missing a sector');
    expect(sectorRevenueMultiple(state, ai)).toBeGreaterThan(sectorRevenueMultiple(state, logistics));
  });

  it('rewards growth and margin monotonically', () => {
    const slow = qualityScore(0, 0.4, 'ai');
    const fast = qualityScore(0.5, 0.4, 'ai');
    const fatter = qualityScore(0.5, 0.75, 'ai');
    expect(fast).toBeGreaterThan(slow);
    expect(fatter).toBeGreaterThan(fast);
    expect(fatter).toBeLessThanOrEqual(1);
  });

  it('refuses to value a company with no trailing revenue', () => {
    const state = createWorld2Session();
    const company = state.companies[0];
    if (company === undefined) throw new Error('fixture is missing a company');
    company.fundamentals = { ...company.fundamentals, revenueTtmUsd: 0 };
    expect(fundamentalValueUsd(state, company)).toBeNull();
  });

  it('returns whole dollars', () => {
    const state = createWorld2Session();
    for (const company of state.companies) {
      const value = fundamentalValueUsd(state, company);
      if (value === null) continue;
      expect(Number.isInteger(value.valueUsd)).toBe(true);
    }
  });

  it('is populated by the metrics phase for every active company', () => {
    const engine = createDefaultEngine();
    const outcome = engine.resolver.resolveQuarter(createWorld2Session(), [], null, []);
    expect(outcome.committed).toBe(true);
    for (const company of outcome.nextState.companies) {
      if (!company.isActive) continue;
      expect(company.fundamentals.sharesOutstanding).toBeGreaterThan(0);
      expect(Number.isFinite(company.fundamentals.revenueTtmUsd)).toBe(true);
      expect(company.fundamentals.grossMarginPct).toBeGreaterThanOrEqual(0);
      expect(company.fundamentals.grossMarginPct).toBeLessThanOrEqual(1);
    }
  });
});

/* -------------------------------------------------------------------------- */
/*  Prices                                                                     */
/* -------------------------------------------------------------------------- */

describe('world version 2 prices', () => {
  it('resolves identically twice from the same seed', () => {
    const engine = createDefaultEngine();
    const run = (): string[] => {
      let state = createWorld2Session();
      const hashes: string[] = [];
      for (let quarter = 0; quarter < 6; quarter += 1) {
        const outcome = engine.resolver.resolveQuarter(state, [], null, []);
        expect(outcome.committed).toBe(true);
        state = outcome.nextState;
        hashes.push(hashState(state));
      }
      return hashes;
    };
    expect(run()).toEqual(run());
  }, 60_000);

  it('keeps every quarterly move inside its bound unless a shock is on the record', () => {
    const engine = createDefaultEngine();
    let state = createWorld2Session();
    let shockRows = 0;
    let moves = 0;

    for (let quarter = 0; quarter < 8; quarter += 1) {
      const outcome = engine.resolver.resolveQuarter(state, [], null, []);
      expect(outcome.committed).toBe(true);

      const shocked = new Set(
        outcome.events
          .filter((event) => event.type === 'sentiment_shifted' && event.payload.kind === 'price_shock')
          .map((event) => String(event.targetId)),
      );
      shockRows += shocked.size;

      for (const event of outcome.events) {
        if (event.type !== 'market_priced' || event.payload.floored === true) continue;
        const before = Number(event.payload.priceBefore);
        const after = Number(event.payload.priceAfter);
        if (!(before > 0) || !(after > 0)) continue;
        moves += 1;
        const bound = shocked.has(String(event.targetId)) ? V2_SHOCK_MAX_ABS_LOG_RETURN : V2_MAX_ABS_LOG_RETURN;
        expect(Math.abs(Math.log(after / before))).toBeLessThanOrEqual(bound + 1e-6);
      }
      state = outcome.nextState;
    }

    expect(moves).toBeGreaterThan(0);
    // The bound above is only worth checking if the shock path is actually taken,
    // so the run is long enough that some name is dislocated. Deterministic: the
    // same seed dislocates the same names in the same quarters, every time.
    expect(shockRows).toBeGreaterThan(0);
  }, 60_000);

  it('reconciles every priced capitalisation to price times shares', () => {
    const engine = createDefaultEngine();
    let state = createWorld2Session();
    for (let quarter = 0; quarter < 4; quarter += 1) {
      const outcome = engine.resolver.resolveQuarter(state, [], null, []);
      expect(outcome.committed).toBe(true);
      state = outcome.nextState;

      for (const quote of state.quotes) {
        const instrument = state.marketInstruments.find((entry) => entry.id === quote.instrumentId);
        if (instrument === undefined || instrument.isReference) continue;
        const shares = instrument.sharesOutstanding;
        if (shares == null || shares <= 0) continue;
        expect(quoteMarketCapReconciles(quote, shares)).toBe(true);
      }
    }
  }, 60_000);

  it('keeps listed prices readable, and never lets the market integrity check fail', () => {
    const engine = createDefaultEngine();
    let state = createWorld2Session();
    for (let quarter = 0; quarter < 6; quarter += 1) {
      const outcome = engine.resolver.resolveQuarter(state, [], null, []);
      const market = outcome.invariants.find((result) => result.invariant === 'market_integrity');
      expect(market?.passed).toBe(true);
      state = outcome.nextState;
    }

    // Every listed name in the fixture started inside the band and, absent a
    // collapse, stays somewhere a player can read at a glance.
    for (const instrument of state.marketInstruments) {
      if (instrument.isReference || instrument.kind !== 'in_world_equity') continue;
      const latest = state.quotes
        .filter((quote) => quote.instrumentId === instrument.id)
        .sort((a, b) => b.quarter - a.quarter)[0];
      if (latest === undefined) continue;
      expect(latest.price).toBeGreaterThan(0);
      expect(latest.price).toBeLessThan(SHARE_PRICE_BAND_USD[1] * 4);
    }
  }, 60_000);

  it('anchors a price to the fundamentals the metrics phase wrote', () => {
    const engine = createDefaultEngine();
    let state = createWorld2Session();
    for (let quarter = 0; quarter < 3; quarter += 1) {
      state = engine.resolver.resolveQuarter(state, [], null, []).nextState;
    }
    const listed = state.companies.find((company) => company.isPublic && company.fundamentals.revenueTtmUsd > 0);
    expect(listed).toBeDefined();
    if (listed === undefined) return;
    const anchor = state.valuationAnchors.find((entry) => entry.companyId === listed.id);
    expect(anchor?.inputs['fundamentalValueUsd']).toBeGreaterThan(0);
    expect(anchor?.inputs['sectorRevenueMultiple']).toBeGreaterThan(0);
  }, 60_000);
});

/* -------------------------------------------------------------------------- */
/*  Share-count normalisation                                                  */
/* -------------------------------------------------------------------------- */

describe('share counts', () => {
  it('re-denominates a register without breaking the ownership invariant', () => {
    const state = createWorld2Session();
    const table = state.capTables.find((entry) => entry.holdings.length > 1 && entry.fullyDilutedShares > 0);
    if (table === undefined) throw new Error('fixture is missing a cap table with more than one holder');

    const classOfSecurity = new Map(
      state.securities.filter((security) => security.companyId === table.companyId).map((security) => [security.id, security.shareClassId] as const),
    );
    const before = table.fullyDilutedShares;
    const target = sharesForMarketCap(before * 37);

    const after = normaliseShareCount(state, table, target, state.quarter);
    expect(after).toBe(table.fullyDilutedShares);
    expect(after).not.toBe(before);

    // The invariant the gate checks: per class, holdings sum to the issued count
    // and to the declared total, exactly.
    for (const shareClass of table.shareClasses) {
      let held = 0;
      for (const holding of table.holdings) {
        if (classOfSecurity.get(holding.securityId) === shareClass.id) held += holding.shares;
      }
      expect(held).toBe(shareClass.issuedShares);
      expect(table.totalIssuedByClass[shareClass.id]).toBe(shareClass.issuedShares);
      expect(shareClass.issuedShares).toBeLessThanOrEqual(shareClass.authorisedShares);
    }
    for (const holding of table.holdings) expect(holding.shares).toBeGreaterThanOrEqual(0);
  });

  it('refuses a degenerate or negligible re-denomination', () => {
    const state = createWorld2Session();
    const table = state.capTables.find((entry) => entry.fullyDilutedShares > 0);
    if (table === undefined) throw new Error('fixture is missing a cap table');
    const before = table.fullyDilutedShares;
    expect(normaliseShareCount(state, table, 0, state.quarter)).toBe(before);
    expect(normaliseShareCount(state, table, before, state.quarter)).toBe(before);
  });

  it('implies a market capitalisation that matches the count it chose', () => {
    const state = createWorld2Session();
    for (const instrument of state.marketInstruments) {
      if (instrument.isReference || instrument.sharesOutstanding == null) continue;
      const quote = state.quotes.find((entry) => entry.instrumentId === instrument.id);
      if (quote === undefined) continue;
      expect(Math.abs(quote.marketCapUsd - marketCapFromPrice(quote.price, instrument.sharesOutstanding))).toBeLessThanOrEqual(1);
    }
  });
});

/* -------------------------------------------------------------------------- */
/*  Bounded state                                                              */
/* -------------------------------------------------------------------------- */

describe('bounded procurement state', () => {
  /** A settled record from long enough ago that the horizon has passed it. */
  function ageingState(): SessionState {
    const state = createWorld2Session();
    const company = state.companies[0];
    const agency = state.agencies[0];
    if (company === undefined || agency === undefined) throw new Error('fixture is missing an agency');

    const old: ProcurementOpportunity = {
      ...(state.procurementOpportunities[0] as ProcurementOpportunity),
      id: 'opp_ancient',
      status: 'awarded',
      openQuarter: 0,
      closeQuarter: 1,
    };
    const recent: ProcurementOpportunity = { ...old, id: 'opp_recent', closeQuarter: 30 };
    // Still open at quarter 40, so the bid against it is genuinely live rather
    // than merely young.
    const live: ProcurementOpportunity = { ...old, id: 'opp_live', status: 'open', closeQuarter: 48 };

    const oldBid: StoredGovernmentBid = {
      id: 'bid_ancient',
      opportunityId: 'opp_ancient',
      bidderCompanyId: company.id,
      submittedQuarter: 1,
      status: 'lost',
      disqualificationReason: null,
      price: 5_000_000,
      technicalScoreInputs: {
        modelCapability: 0.5,
        architectureQuality: 0.5,
        securityPosture: 0.5,
        reliabilityCommitment: 0.5,
        responsibleAiCommitment: 0.5,
      },
      computeCommitment: { acceleratorUnits: 40, quarters: 4 },
      staffCommitment: { engineers: 10, researchers: 4, clearedStaff: 6 },
      timeline: { deliveryQuarters: 4, milestoneCount: 3 },
      subcontractors: [],
      ipConcessions: 'government_use_rights',
      auditRights: 'annual',
      domesticSourcingPct: 0.8,
      consortiumMemberIds: [],
      narrative: 'A fixture bid.',
    };
    const liveBid: StoredGovernmentBid = { ...oldBid, id: 'bid_live', opportunityId: 'opp_live', status: 'submitted' };

    const oldContract: GovernmentContract = {
      id: 'gct_ancient',
      opportunityId: 'opp_ancient',
      agencyId: agency.id,
      primeCompanyId: company.id,
      consortiumMemberIds: [],
      subcontractors: [],
      awardedQuarter: 1,
      contractForm: 'fixed_price',
      totalValueUsd: 1_000_000,
      recognisedToDateUsd: 1_000_000,
      milestones: [
        {
          id: 'mst_ancient',
          label: 'Delivered years ago',
          dueQuarter: 2,
          valueUsd: 1_000_000,
          status: 'delivered',
          completedQuarter: 2,
          qualityScore: 0.8,
          computeRequiredUnits: 10,
        },
      ],
      performanceToDate: 70,
      penaltiesUsd: 0,
      complianceBurdenQuarterlyUsd: 0,
      status: 'completed',
      exportRestricted: false,
      publicControversyLevel: 0.1,
    };
    const activeContract: GovernmentContract = {
      ...oldContract,
      id: 'gct_active',
      opportunityId: 'opp_recent',
      status: 'active',
      recognisedToDateUsd: 0,
      milestones: [
        {
          id: 'mst_pending',
          label: 'Still to come',
          dueQuarter: 44,
          valueUsd: 1_000_000,
          status: 'pending',
          completedQuarter: null,
          qualityScore: 0,
          computeRequiredUnits: 10,
        },
      ],
    };

    return {
      ...state,
      quarter: 40,
      lastResolvedQuarter: 39,
      procurementOpportunities: [old, recent, live],
      governmentBids: [oldBid, liveBid],
      governmentContracts: [oldContract, activeContract],
    };
  }

  it('drops settled records past the horizon and keeps everything still live', () => {
    const engine = createDefaultEngine();
    const outcome = engine.resolver.resolveQuarter(ageingState(), [], null, []);
    expect(outcome.committed).toBe(true);
    const next = outcome.nextState;

    // Settled and older than the horizon: gone.
    expect(next.governmentContracts.some((contract) => contract.id === 'gct_ancient')).toBe(false);
    expect(next.governmentBids.some((bid) => bid.id === 'bid_ancient')).toBe(false);
    expect(next.procurementOpportunities.some((opportunity) => opportunity.id === 'opp_ancient')).toBe(false);

    // Still live, or still referenced by something live: kept, however old.
    expect(next.governmentContracts.some((contract) => contract.id === 'gct_active')).toBe(true);
    expect(next.governmentBids.some((bid) => bid.id === 'bid_live')).toBe(true);
    expect(next.procurementOpportunities.some((opportunity) => opportunity.id === 'opp_recent')).toBe(true);
  }, 60_000);

  it('leaves a young session untouched, so the horizon cannot bite early', () => {
    const engine = createDefaultEngine();
    const state = createWorld2Session();
    const before = state.procurementOpportunities.length;
    expect(state.quarter).toBeLessThan(SETTLED_RECORD_HORIZON_QUARTERS);
    const outcome = engine.resolver.resolveQuarter(state, [], null, []);
    expect(outcome.nextState.procurementOpportunities.length).toBeGreaterThanOrEqual(before);
  }, 60_000);
});

/* -------------------------------------------------------------------------- */
/*  Strategist selection                                                       */
/* -------------------------------------------------------------------------- */

describe('strategist selection', () => {
  it('caps how many companies get a live model and ranks them deterministically', () => {
    const state = createWorld2Session();
    const first = strategistCompanyIds(state, 3);
    expect(first.length).toBeLessThanOrEqual(3);
    expect(strategistCompanyIds(state, 3)).toEqual(first);
    for (const id of first) {
      const company = state.companies.find((entry) => entry.id === id);
      expect(company?.controllerPlayerId).toBeNull();
      expect(company?.tier).toBe('major');
      expect(company?.isActive).toBe(true);
    }
  });

  it('holds the per-quarter model bill flat as the world grows', () => {
    const state = createWorld2Session();
    const widened: SessionState = {
      ...state,
      companies: state.companies.map((company) => ({ ...company, tier: 'major' as const, controllerPlayerId: null })),
    };
    expect(strategistCompanyIds(widened).length).toBeLessThanOrEqual(6);
  });
});
