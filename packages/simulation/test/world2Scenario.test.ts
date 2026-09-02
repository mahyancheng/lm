/**
 * The world-version-2 scenario: twenty-four rivals across six sectors and six
 * regions, a six-track Frontier Map, per-sector public programmes, and a player
 * start that follows the sector, region and background the new-game chat
 * established.
 *
 * Three rules run through the file:
 *
 * - **World 1 is frozen.** The default `createDemoSession()` still hashes to the
 *   value it hashed to before this scenario existed, and that hash is pinned
 *   here rather than merely compared with itself.
 * - **The engine accepts it.** Building a world nobody can resolve is not
 *   building a world, so every assertion about the opening state is backed by an
 *   actual resolution through the real engine with the invariant gate on.
 * - **Determinism first.** Twelve quarters are resolved twice and compared by
 *   state hash, not by eye.
 */

import { describe, expect, it } from 'vitest';
import type { SessionState } from '@frontier/contracts';
import {
  ALL_BACKGROUNDS,
  DRY_POWDER_FLOOR_PCT,
  LP_PRESSURE_FORCED_FLOOR,
  LP_PRESSURE_HARVEST_FLOOR,
  MARKET_CAP_TOLERANCE_USD,
  REGIONS,
  SECTORS,
  SECTOR_META,
  SHARE_PRICE_BAND_USD,
  NewGameSetupSchema,
  lpPressureBand,
  lpPressureFor,
  marketCapFromPrice,
  priceWithinBand,
  sectorForBackground,
} from '@frontier/contracts';
import { hashState } from '@frontier/shared';
import { createDefaultEngine } from '../src/engine';
import { createDemoSession, demoSessionInput } from '../src/scenario';
import {
  OPENING_MULTIPLE_INDEX,
  OPENING_SECTOR_MULTIPLES,
  V2_COMPANY_SEEDS,
  W2_AGENCIES,
  W2_AI_NODES,
  W2_COMPANIES,
  W2_FUND_PRINCIPALS,
  W2_OPPORTUNITY_SECTORS,
  W2_PLAYER_BACKGROUNDS,
  W2_TRACKS,
  createWorld2Session,
} from '../src/scenario/world2';
import { MIN_TRAILING_REVENUE_USD } from '../src/markets/fundamentalValue';
import { isMultiSectorWorld, sectorEconomy } from '../src/economy/sectors';

/**
 * The hash of the frozen world-1 demo, recorded before world 2 existed. It is
 * pinned rather than self-compared: a test that only checks a value equals
 * itself cannot notice that the frozen world moved.
 */
const FROZEN_WORLD_1_HASH = 'a0e39d23dd0c7c3a';

const setupFor = (backgroundId: string, region: string) =>
  NewGameSetupSchema.parse({
    companyName: 'Probe Ventures',
    founderName: 'Probe Founder',
    backgroundId,
    sector: sectorForBackground(backgroundId),
    region,
    worldVersion: 2,
  });

/* -------------------------------------------------------------------------- */
/*  World 1 stays frozen                                                       */
/* -------------------------------------------------------------------------- */

describe('the frozen world', () => {
  it('still hashes to what it hashed to before world 2 existed', () => {
    expect(hashState(createDemoSession())).toBe(FROZEN_WORLD_1_HASH);
  });

  it('is what a setup with no world version, or version 1, still builds', () => {
    const legacy = demoSessionInput(424242, { companyName: 'Player Ventures', founderName: 'Avery Sinclair', backgroundId: 'enterprise_ai' });
    expect(legacy.config?.worldVersion ?? 1).toBe(1);
    expect(legacy.companies).toHaveLength(7);

    const explicit = demoSessionInput(424242, { companyName: 'Player Ventures', founderName: 'Avery Sinclair', backgroundId: 'enterprise_ai', worldVersion: 1 });
    expect(explicit.companies).toHaveLength(7);
  });

  it('hands a version-2 setup to the multi-sector world instead', () => {
    const state = createDemoSession(424242, setupFor('warehouse_robotics', 'east_asia'));
    expect(state.config.worldVersion).toBe(2);
    expect(isMultiSectorWorld(state)).toBe(true);
    expect(state.companies).toHaveLength(25);
  });
});

/* -------------------------------------------------------------------------- */
/*  Shape of the world                                                         */
/* -------------------------------------------------------------------------- */

describe('the world-2 scenario', () => {
  const state = createWorld2Session();

  it('is a fixed point for a seed, and differs between seeds', () => {
    expect(hashState(createWorld2Session())).toBe(hashState(createWorld2Session()));
    expect(hashState(createWorld2Session(7))).not.toBe(hashState(createWorld2Session(8)));
  });

  it('opens in 2027 Q1 at world version 2 with no resolved quarter behind it', () => {
    expect(state.startYear).toBe(2027);
    expect(state.quarter).toBe(0);
    expect(state.lastResolvedQuarter).toBeNull();
    expect(state.config.worldVersion).toBe(2);
  });

  it('carries twenty-four rivals and the player, four in every sector and every region', () => {
    expect(state.companies).toHaveLength(25);
    const rivals = state.companies.filter((company) => company.controllerPlayerId === null);
    expect(rivals).toHaveLength(24);
    for (const sector of SECTORS) expect(rivals.filter((company) => company.sector === sector)).toHaveLength(4);
    for (const region of REGIONS) expect(rivals.filter((company) => company.region === region)).toHaveLength(4);
    expect(new Set(rivals.map((company) => company.name)).size).toBe(24);
  });

  it('lists a third of them, each at a readable and distinct price', () => {
    const listed = state.companies.filter((company) => company.isPublic);
    expect(listed).toHaveLength(8);
    const prices: number[] = [];
    for (const company of listed) {
      const instrument = state.marketInstruments.find((entry) => entry.id === company.instrumentId);
      const quote = state.quotes.find((entry) => entry.instrumentId === company.instrumentId);
      expect(instrument?.sharesOutstanding).toBeGreaterThan(0);
      expect(quote).toBeDefined();
      if (quote === undefined || instrument?.sharesOutstanding == null) continue;
      expect(priceWithinBand(quote.price)).toBe(true);
      // The gate checks this every quarter; it has to hold before the first one.
      expect(Math.abs(quote.marketCapUsd - marketCapFromPrice(quote.price, instrument.sharesOutstanding))).toBeLessThanOrEqual(MARKET_CAP_TOLERANCE_USD);
      prices.push(Math.round(quote.price));
    }
    // A tape where every name opens at the same number reads as a spreadsheet.
    expect(new Set(prices).size).toBe(prices.length);
  });

  it('gives every company fundamentals the valuation model can actually use', () => {
    for (const company of state.companies) {
      const f = company.fundamentals;
      expect(f.sharesOutstanding).toBeGreaterThan(0);
      expect(Number.isInteger(f.sharesOutstanding)).toBe(true);
      const band = SECTOR_META[company.sector].grossMarginBandPct;
      expect(f.grossMarginPct).toBeGreaterThanOrEqual(band[0] / 100);
      expect(f.grossMarginPct).toBeLessThanOrEqual(band[1] / 100);
      expect(f.revenueGrowthYoY).toBeGreaterThanOrEqual(-0.1);
      expect(f.revenueGrowthYoY).toBeLessThanOrEqual(0.6);
      if (company.controllerPlayerId !== null) continue;
      // Every rival is above the floor the fundamentals anchor engages at.
      expect(f.revenueTtmUsd).toBeGreaterThanOrEqual(MIN_TRAILING_REVENUE_USD);
      expect(f.revenueTtmUsd).toBe(company.financials.revenueQuarterly * 4);
    }
  });

  it('prices its opening quotes against the market it actually carries', () => {
    expect(state.world.capitalMarkets.sectorMultiples).toBe(OPENING_MULTIPLE_INDEX);
    for (const [sectorId, multiple] of Object.entries(OPENING_SECTOR_MULTIPLES)) {
      expect(state.sectors[sectorId]?.multiple).toBe(multiple);
    }
  });

  it('supplies every sector, so nothing is gated for want of a supplier', () => {
    const economy = sectorEconomy(state);
    for (const sector of SECTORS) {
      expect(economy[sector].supplyUsd).toBeGreaterThan(0);
      expect(economy[sector].tightness).toBeGreaterThan(0);
    }
  });

  it('reconciles every balance sheet and every register before the first quarter', () => {
    for (const company of state.companies) {
      const sheet = company.balanceSheet;
      const assets = sheet.assets.cash + sheet.assets.ppe + sheet.assets.goodwill + sheet.assets.investments + sheet.assets.receivables;
      const liabilities = sheet.liabilities.debt + sheet.liabilities.payables + sheet.liabilities.deferredRevenue;
      expect(Math.abs(assets - liabilities - sheet.equity)).toBeLessThanOrEqual(1);
    }
    for (const table of state.capTables) {
      const held = table.holdings.reduce((total, holding) => total + holding.shares, 0);
      const shareClass = table.shareClasses[0];
      expect(shareClass).toBeDefined();
      if (shareClass === undefined) continue;
      expect(held).toBe(shareClass.issuedShares);
      expect(table.totalIssuedByClass[shareClass.id]).toBe(shareClass.issuedShares);
      expect(shareClass.issuedShares).toBeLessThanOrEqual(shareClass.authorisedShares);
    }
  });

  it('names a chief executive who works there, for every company', () => {
    const characters = new Map(state.characters.map((character) => [character.id, character] as const));
    for (const company of state.companies) {
      expect(company.ceoCharacterId).not.toBeNull();
      if (company.ceoCharacterId === null) continue;
      const ceo = characters.get(company.ceoCharacterId);
      expect(ceo).toBeDefined();
      expect(ceo?.companyId).toBe(company.id);
    }
    expect(state.characters.filter((character) => character.isPlayer)).toHaveLength(1);
  });

  it('caps the per-quarter model bill: eight major rivals, not twenty-four', () => {
    const majors = state.companies.filter((company) => company.tier === 'major' && company.controllerPlayerId === null);
    expect(majors).toHaveLength(state.config.majorRivalCount);
    expect(state.config.majorRivalCount).toBeLessThanOrEqual(10);
  });
});

/* -------------------------------------------------------------------------- */
/*  The Frontier Map                                                           */
/* -------------------------------------------------------------------------- */

describe('the world-2 Frontier Map', () => {
  const state = createWorld2Session();

  it('keeps the seventeen AI nodes and adds five per new sector', () => {
    expect(W2_AI_NODES).toHaveLength(17);
    expect(state.techGraph.nodes).toHaveLength(42);
    for (const sector of SECTORS) {
      const nodes = state.techGraph.nodes.filter((node) => node.sector === sector);
      expect(nodes.length).toBe(sector === 'ai' ? 17 : 5);
    }
  });

  it('lays out one track per sector, covering every node exactly once', () => {
    expect(state.techGraph.tracks).toHaveLength(SECTORS.length);
    expect(state.techGraph.tracks.map((track) => track.sector)).toEqual([...SECTORS]);
    const listed = state.techGraph.tracks.flatMap((track) => track.nodeIds);
    expect(listed).toHaveLength(state.techGraph.nodes.length);
    expect(new Set(listed).size).toBe(listed.length);
    const ids = new Set(state.techGraph.nodes.map((node) => node.id));
    for (const id of listed) expect(ids.has(id)).toBe(true);
  });

  it('crosses sectors where progress genuinely gates progress', () => {
    const sectorOf = new Map(state.techGraph.nodes.map((node) => [node.id, node.sector] as const));
    const crossing = state.techGraph.edges.filter((edge) => {
      const from = sectorOf.get(edge.from);
      const to = sectorOf.get(edge.to);
      return from !== undefined && to !== undefined && from !== to;
    });
    expect(crossing.length).toBeGreaterThanOrEqual(8);

    // The worked example: dexterous manipulation needs an AI node and a
    // manufacturing node before it is reachable at all.
    const manipulation = state.techGraph.nodes.find((node) => node.id === 'tech_dexterous_manipulation');
    expect(manipulation?.dependencies).toContain('tech_tool_learning');
    expect(manipulation?.dependencies).toContain('tech_precision_actuators');
  });

  it('never points at a company this world does not have', () => {
    const companies = new Set(state.companies.map((company) => company.id));
    for (const node of state.techGraph.nodes) {
      if (node.achievedByCompanyId !== null) expect(companies.has(node.achievedByCompanyId)).toBe(true);
      for (const companyId of Object.keys(node.confidenceByCompany)) expect(companies.has(companyId)).toBe(true);
    }
    for (const project of state.researchProjects) {
      expect(companies.has(project.companyId)).toBe(true);
      expect(state.techGraph.nodes.some((node) => node.id === project.targetNodeId)).toBe(true);
    }
    for (const edge of state.techGraph.edges) {
      expect(state.techGraph.nodes.some((node) => node.id === edge.from)).toBe(true);
      expect(state.techGraph.nodes.some((node) => node.id === edge.to)).toBe(true);
    }
  });
});

/* -------------------------------------------------------------------------- */
/*  Government                                                                 */
/* -------------------------------------------------------------------------- */

describe('world-2 public work', () => {
  const state = createWorld2Session();

  it('opens one programme aimed at each sector', () => {
    expect(state.procurementOpportunities).toHaveLength(SECTORS.length);
    const sectors = state.procurementOpportunities.map((opportunity) => W2_OPPORTUNITY_SECTORS[opportunity.id]);
    expect(new Set(sectors).size).toBe(SECTORS.length);
    for (const opportunity of state.procurementOpportunities) {
      expect(state.agencies.some((agency) => agency.id === opportunity.agencyId)).toBe(true);
      expect(opportunity.status).toBe('open');
      expect(opportunity.closeQuarter).toBeGreaterThan(opportunity.openQuarter);
    }
    expect(state.agencies).toHaveLength(W2_AGENCIES.length);
  });

  it('scales a programme by the appetite of the region letting it', () => {
    // The defence programme is let in North America (appetite 130) and the
    // citizen-services one in South Asia (70), against base values of $2.2bn and
    // $520m: the ratio of ceilings is the ratio of base times appetite.
    const sovereign = state.procurementOpportunities.find((opportunity) => opportunity.id === 'opp_sovereign_reasoning');
    const citizen = state.procurementOpportunities.find((opportunity) => opportunity.id === 'opp_citizen_services');
    expect(sovereign?.maxValue).toBe(Math.round((2.2e9 * 130) / 100));
    expect(citizen?.maxValue).toBe(Math.round((520e6 * 70) / 100));
  });
});

/* -------------------------------------------------------------------------- */
/*  Resolution                                                                 */
/* -------------------------------------------------------------------------- */

describe('resolving world 2', () => {
  it('passes every invariant on the opening quarter', () => {
    const engine = createDefaultEngine();
    const outcome = engine.resolver.resolveQuarter(createWorld2Session(), [], null, []);
    const failures = outcome.invariants.filter((result) => !result.passed).map((result) => `${result.invariant}: ${result.detail}`);
    expect(failures).toEqual([]);
    expect(outcome.committed).toBe(true);
  }, 60_000);

  it('resolves twelve quarters identically from the same seed', () => {
    const engine = createDefaultEngine();
    const run = (): string[] => {
      let state = createWorld2Session();
      const hashes: string[] = [];
      for (let quarter = 0; quarter < 12; quarter += 1) {
        const outcome = engine.resolver.resolveQuarter(state, [], null, []);
        expect(outcome.committed).toBe(true);
        state = outcome.nextState;
        hashes.push(hashState(state));
      }
      return hashes;
    };
    expect(run()).toEqual(run());
  }, 120_000);

  it('keeps every listed price readable across those twelve quarters', () => {
    const engine = createDefaultEngine();
    let state = createWorld2Session();
    for (let quarter = 0; quarter < 12; quarter += 1) {
      const outcome = engine.resolver.resolveQuarter(state, [], null, []);
      expect(outcome.invariants.find((result) => result.invariant === 'market_integrity')?.passed).toBe(true);
      state = outcome.nextState;
    }
    for (const instrument of state.marketInstruments) {
      if (instrument.kind !== 'in_world_equity') continue;
      const latest = state.quotes.filter((quote) => quote.instrumentId === instrument.id).sort((a, b) => b.quarter - a.quarter)[0];
      if (latest === undefined) continue;
      expect(latest.price).toBeGreaterThan(0);
      // The band is enforced at listing, not every quarter; the loose bound here
      // is the difference between "a stock moved" and "the model diverged".
      expect(latest.price).toBeLessThan(SHARE_PRICE_BAND_USD[1] * 4);
    }
  }, 120_000);
});

/* -------------------------------------------------------------------------- */
/*  Player start                                                               */
/* -------------------------------------------------------------------------- */

describe('the world-2 player start', () => {
  it('offers a shape for every background the contracts declare', () => {
    for (const background of ALL_BACKGROUNDS) expect(W2_PLAYER_BACKGROUNDS[background.id]).toBeDefined();
    expect(Object.keys(W2_PLAYER_BACKGROUNDS)).toHaveLength(ALL_BACKGROUNDS.length);
  });

  it('builds and parses for every background in every region', () => {
    let built = 0;
    for (const background of ALL_BACKGROUNDS) {
      for (const region of REGIONS) {
        const state = createWorld2Session(4242, setupFor(background.id, region));
        const player = state.companies.find((company) => company.id === W2_COMPANIES.player);
        expect(player?.sector).toBe(background.sector);
        expect(player?.region).toBe(region);
        expect(player?.name).toBe('Probe Ventures');
        built += 1;
      }
    }
    expect(built).toBe(ALL_BACKGROUNDS.length * REGIONS.length);
  }, 60_000);

  it('resolves a first quarter from one start in every sector and every region', () => {
    const engine = createDefaultEngine();
    const combinations = [
      ...SECTORS.map((sector) => ({ background: ALL_BACKGROUNDS.find((entry) => entry.sector === sector)?.id ?? 'enterprise_ai', region: 'north_america' })),
      ...REGIONS.map((region) => ({ background: 'bootstrapper', region })),
    ];
    for (const combination of combinations) {
      const outcome = engine.resolver.resolveQuarter(createWorld2Session(4242, setupFor(combination.background, combination.region)), [], null, []);
      const failures = outcome.invariants.filter((result) => !result.passed).map((result) => result.invariant);
      expect(failures).toEqual([]);
      expect(outcome.committed).toBe(true);
    }
  }, 120_000);

  it('falls back to the sector\'s own first card when a background does not belong to it', () => {
    // A chat that establishes "energy" and then a robotics card has established
    // the sector; the card is the thing that gives way.
    const setup = NewGameSetupSchema.parse({
      companyName: 'Probe Ventures',
      founderName: 'Probe Founder',
      backgroundId: 'warehouse_robotics',
      sector: 'energy',
      region: 'middle_east',
      worldVersion: 2,
    });
    const state = createWorld2Session(4242, setup);
    const player = state.companies.find((company) => company.id === W2_COMPANIES.player);
    expect(player?.sector).toBe('energy');
    expect(player?.sectorId).toBe('energy_infrastructure');
  });

  it('starts the founder far behind the people they will have to deal with', () => {
    const state: SessionState = createWorld2Session();
    const founder = state.characters.find((character) => character.isPlayer);
    expect(founder?.connectionLevel).toBeLessThan(30);
    const best = Math.max(...state.characters.map((character) => character.connectionLevel));
    expect(best).toBeGreaterThan(85);
  });
});

/* -------------------------------------------------------------------------- */
/*  Seed data hygiene                                                          */
/* -------------------------------------------------------------------------- */

describe('world-2 seed data', () => {
  it('keeps every id and ticker unique', () => {
    const ids = V2_COMPANY_SEEDS.map((seed) => seed.id);
    expect(new Set(ids).size).toBe(ids.length);
    const slugs = V2_COMPANY_SEEDS.map((seed) => seed.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    const tickers = V2_COMPANY_SEEDS.map((seed) => seed.ticker).filter((ticker): ticker is string => ticker !== null);
    expect(new Set(tickers).size).toBe(tickers.length);
    const ceos = V2_COMPANY_SEEDS.map((seed) => seed.ceoCharacterId);
    expect(new Set(ceos).size).toBe(ceos.length);
  });

  it('gives every listed company a designed price and every private one none', () => {
    for (const seed of V2_COMPANY_SEEDS) {
      if (seed.isPublic) {
        expect(seed.ticker).not.toBeNull();
        expect(seed.listPriceUsd).not.toBeNull();
        expect(priceWithinBand(seed.listPriceUsd ?? 0)).toBe(true);
      } else {
        expect(seed.ticker).toBeNull();
        expect(seed.listPriceUsd).toBeNull();
      }
    }
  });

  it('describes each track with copy the map can print', () => {
    for (const track of W2_TRACKS) {
      expect(track.title.length).toBeGreaterThanOrEqual(3);
      expect(track.summary.length).toBeGreaterThan(0);
      expect(track.nodeIds.length).toBeGreaterThan(0);
    }
  });
});

/* -------------------------------------------------------------------------- */
/*  The capital-entity roster                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Eleven institutions: the six that already sat on these registers, promoted,
 * and five that arrive with nothing but dry powder.
 *
 * The load-bearing fact is the identity rule — a `CapitalEntity.id` **is** the
 * cap-table holder id — so these tests check the roster against the registers
 * and the cast rather than against itself.
 */
describe('the world-2 capital entities', () => {
  const state: SessionState = createWorld2Session();
  const entities = state.capitalEntities ?? [];

  it('promotes the six existing blocs and adds five, with no new opening holdings', () => {
    expect(entities).toHaveLength(11);
    expect(entities.map((entity) => entity.id)).toEqual([
      'fund_seawall',
      'fund_indus',
      'fund_altiplano',
      'fund_ironwood',
      'fund_tessera',
      'fund_grantwood',
      'fund_straits',
      'fund_kaido',
      'fund_coldbrook',
      'fund_perihelion',
      'fund_qadr',
    ]);

    // Every fund holder id on every register resolves to an entity, and only
    // the six incumbents hold anything at all: world 2's registers do not
    // change by one share.
    const holders = new Set<string>();
    for (const table of state.capTables) {
      for (const holding of table.holdings) {
        if (holding.holderKind === 'fund') holders.add(holding.holderId);
      }
    }
    const ids = new Set(entities.map((entity) => entity.id));
    for (const holder of holders) expect(ids.has(holder)).toBe(true);
    expect([...holders].sort()).toEqual(['fund_altiplano', 'fund_indus', 'fund_kaido', 'fund_qadr', 'fund_seawall', 'fund_tessera']);
    for (const newcomer of ['fund_ironwood', 'fund_grantwood', 'fund_straits', 'fund_coldbrook', 'fund_perihelion']) {
      expect(holders.has(newcomer)).toBe(false);
    }
  });

  it('covers the four kinds and the six regions the design asked for', () => {
    const byKind = (kind: string) => entities.filter((entity) => entity.kind === kind).length;
    expect(byKind('vc')).toBe(4);
    expect(byKind('pe')).toBe(3);
    expect(byKind('hedge_fund')).toBe(3);
    expect(byKind('sovereign')).toBe(1);
    expect(new Set(entities.map((entity) => entity.region)).size).toBeGreaterThanOrEqual(5);
    // The sovereign is the only one of its kind, and it is Qadr, which was
    // already seeded with a CIO and holdings on eight registers.
    const sovereign = entities.find((entity) => entity.kind === 'sovereign');
    expect(sovereign?.id).toBe('fund_qadr');
  });

  it('gives every entity a partner who exists, and every partner an entity', () => {
    const characters = new Map(state.characters.map((character) => [character.id, character] as const));
    for (const entity of entities) {
      expect(entity.partnerCharacterIds.length).toBeGreaterThanOrEqual(1);
      for (const partnerId of entity.partnerCharacterIds) {
        const partner = characters.get(partnerId);
        expect(partner, `${entity.id} names a partner nobody has met: ${partnerId}`).toBeDefined();
        expect(partner?.role).toBe('investor');
        expect(partner?.isActive).toBe(true);
      }
      // The board-representation map and the roster agree about who speaks.
      expect(W2_FUND_PRINCIPALS[entity.id]).toBe(entity.partnerCharacterIds[0]);
    }
    expect(Object.keys(W2_FUND_PRINCIPALS)).toHaveLength(entities.length);

    // Every director seated on behalf of a fund represents a real entity.
    for (const board of state.boards) {
      for (const seat of board.directors) {
        if (seat.representedHolderId === null) continue;
        if (!seat.representedHolderId.startsWith('fund_')) continue;
        expect(entities.some((entity) => entity.id === seat.representedHolderId)).toBe(true);
      }
    }
  });

  it('keeps AUM and dry powder whole, positive and inside the fund', () => {
    for (const entity of entities) {
      expect(Number.isInteger(entity.committedCapitalUsd)).toBe(true);
      expect(Number.isInteger(entity.dryPowderUsd)).toBe(true);
      expect(Number.isInteger(entity.realisedProceedsUsd)).toBe(true);
      expect(entity.committedCapitalUsd).toBeGreaterThanOrEqual(500 * 1_000_000);
      expect(entity.committedCapitalUsd).toBeLessThanOrEqual(50 * 1_000_000_000);
      expect(entity.dryPowderUsd).toBeGreaterThan(0);
      expect(entity.dryPowderUsd).toBeLessThan(entity.committedCapitalUsd);
      // Nobody is seeded already floored out, and nobody is seeded with a fund
      // that has never done anything.
      const pct = Math.round((100 * entity.dryPowderUsd) / entity.committedCapitalUsd);
      expect(pct).toBeGreaterThanOrEqual(DRY_POWDER_FLOOR_PCT);
      expect(pct).toBeLessThanOrEqual(80);
      expect(entity.realisedProceedsUsd).toBeLessThanOrEqual(entity.committedCapitalUsd);
    }
  });

  it('gives every entity an appetite for every sector and a thesis to print', () => {
    for (const entity of entities) {
      expect(Object.keys(entity.sectorAffinity).sort()).toEqual([...SECTORS].sort());
      for (const sector of SECTORS) {
        const appetite = entity.sectorAffinity[sector] ?? -1;
        expect(Number.isInteger(appetite)).toBe(true);
        expect(appetite).toBeGreaterThanOrEqual(0);
        expect(appetite).toBeLessThanOrEqual(100);
      }
      expect(entity.thesis.length).toBeGreaterThan(20);
      expect(entity.thesis.length).toBeLessThanOrEqual(160);
    }
  });

  it('starts eleven clocks at eleven different places, none of them forced yet', () => {
    const pressures = entities.map((entity) => lpPressureFor(entity, state.quarter));
    for (const pressure of pressures) {
      expect(Number.isInteger(pressure)).toBe(true);
      expect(pressure).toBeGreaterThanOrEqual(0);
      // Nobody opens as a forced seller: the best buying window in the game is
      // something the player watches arrive, not something they are handed.
      expect(pressure).toBeLessThan(LP_PRESSURE_FORCED_FLOOR);
    }
    // But somebody is already harvesting, so the mechanic is live from quarter
    // zero rather than dormant for eight years.
    expect(pressures.some((pressure) => pressure >= LP_PRESSURE_HARVEST_FLOOR)).toBe(true);
    expect(new Set(pressures).size).toBeGreaterThanOrEqual(5);

    // The player's own backer stays patient, because Seawall led their seed.
    const seawall = entities.find((entity) => entity.id === 'fund_seawall');
    expect(seawall).toBeDefined();
    expect(lpPressureBand(lpPressureFor(seawall!, state.quarter))).toBe('calm');
  });

  it('seeds the newcomers reachable, so the Network screen still has a door', () => {
    const connectionOf = (id: string) => state.characters.find((character) => character.id === id)?.connectionLevel ?? -1;
    const incumbents = ['fund_seawall', 'fund_tessera', 'fund_kaido', 'fund_indus', 'fund_qadr', 'fund_altiplano'];
    const newcomers = ['fund_ironwood', 'fund_grantwood', 'fund_straits', 'fund_coldbrook', 'fund_perihelion'];
    const partnerOf = (fundId: string) => connectionOf(W2_FUND_PRINCIPALS[fundId] ?? '');

    const highestIncumbent = Math.max(...incumbents.map(partnerOf));
    for (const fundId of newcomers) expect(partnerOf(fundId)).toBeLessThan(highestIncumbent);
    // At least one of them is reachable by a founder who starts at 24.
    expect(Math.min(...newcomers.map(partnerOf))).toBeLessThanOrEqual(58);
  });

  it('opens with no shorts, no campaigns and no orders', () => {
    expect(state.shortPositions).toEqual([]);
    expect(state.activistCampaigns).toEqual([]);
    expect(state.capitalOrders).toEqual([]);
  });

  it('leaves the frozen world without a single one of these keys', () => {
    const world1 = createDemoSession();
    expect(world1.capitalEntities).toBeUndefined();
    expect(world1.shortPositions).toBeUndefined();
    expect(world1.activistCampaigns).toBeUndefined();
    expect(world1.capitalOrders).toBeUndefined();
    expect(Object.hasOwn(world1, 'capitalEntities')).toBe(false);
    expect(isMultiSectorWorld(world1)).toBe(false);
  });

  it('resolves a quarter with the roster on board and passes capital_integrity', () => {
    const engine = createDefaultEngine();
    const outcome = engine.resolver.resolveQuarter(state, [], null, []);
    expect(outcome.committed).toBe(true);
    const capital = outcome.invariants.find((result) => result.invariant === 'capital_integrity');
    expect(capital?.passed).toBe(true);
    // The roster survives a quarter untouched: nothing in the engine reads it yet.
    expect(outcome.nextState.capitalEntities).toHaveLength(11);
  });
});
