/**
 * @frontier/simulation — companies/entrants.ts
 *
 * Market entry: who arrives when somebody dies.
 *
 * ## Why this exists
 *
 * World version 2's whole bankruptcy rule is the solvency clock — two
 * consecutive quarter-ends below zero and `enterAdministration` winds the
 * company up (`companies/solvency.ts`, `companies/distress.ts`). Administration
 * sunsets the products, releases the staff, surrenders the compute and leaves a
 * husk that can be bought. Nothing replaced the company in its sector, so a
 * forty-quarter world thinned out: twenty-five companies at the opening, fewer
 * every time one failed, and eventually a sector with nobody in it, which gates
 * everything downstream of it to `SUPPLY_GATE_FLOOR`.
 *
 * A real industry does the opposite. A failure is a gap, a gap is an
 * opportunity, and the money that was going to back the dead company backs
 * somebody else. That is what this module is: **for every company wound up this
 * quarter, one new company is founded into the gap it left.**
 *
 * ## The rule, in full
 *
 * - One entrant per wind-up, `ENTRANTS_PER_QUARTER` at most in any one quarter.
 * - Nothing at all once active non-husk companies reach `ACTIVE_COMPANY_CAP`.
 * - The entrant takes the **dead company's sector** — the gap is what it is for
 *   — and draws its region, its archetype, its name, its founder and its
 *   cheque from `ctx.rng` and from state. Nothing is hand-authored per company.
 * - The player's seat is not special. When the player's company is wound up an
 *   entrant spawns for their slot too, and the seat is closed
 *   (`SessionPlayer.eliminatedQuarter`).
 *
 * ## Determinism
 *
 * Every draw comes from one stream forked off the financial phase's own
 * (`ctx.rng.fork(ENTRY_STREAM)`), so adding an entrant cannot move a single
 * number the rest of the phase draws. Ids carry the quarter, so a replay of the
 * same seed mints the same ids in the same order. The name bank is consulted in
 * a fixed order and names already in use are skipped, so a session never has two
 * companies with the same name.
 *
 * ## Invariants
 *
 * An entrant is assembled by exactly the factories the scenario seeds are
 * assembled by — `buildV2Company`, `buildV2CapTable`, `buildV2Anchor`,
 * `buildV2Metrics` from `scenario/world2/seeds.ts` — so its shares reconcile to
 * its issued count, its balance sheet closes and its metrics row exists before
 * any gate reads it. The only thing rewritten afterwards is the register's
 * holders, because an entrant's cap table is its founder and (when one has the
 * dry powder) the fund that led the round, not the scenario's regional blocs.
 *
 * The fund's cheque moves `dryPowderUsd`, which `capital_integrity` reconstructs
 * from the ledger, so the founding writes a `funding_round_closed` row carrying
 * `entityId` and `dryPowderDeltaUsd` exactly as `closeSponsorRound` does.
 */

import type {
  CapitalEntity,
  Character,
  Company,
  FundingRound,
  PublicDisclosure,
  Region,
  ResolverContext,
  SessionState,
  Sector,
} from '@frontier/contracts';
import type { SeededRng } from '@frontier/contracts';
import { CAPITAL_ENTITY_MEMORY_LIMIT, REGIONS, SECTORS, defaultCategoryFor, makeId, regionMeta, regionSectorAffinity, startingNodesForRival } from '@frontier/contracts';
import { isMultiSectorWorld, isNodeEconomyWorld } from '../economy/sectors';
import { deployableUsd, moveDryPowder, remember } from '../capital/context';
import {
  SEC,
  SHC,
  buildV2Anchor,
  buildV2CapTable,
  buildV2Company,
  buildV2Metrics,
  deriveCompany,
} from '../scenario/world2/seeds';
import type { V2CompanySeed } from '../scenario/world2/seeds';
import { buildV2Character } from '../scenario/world2/people';
import { isWoundUp } from './distress';
import { emitEvent, money, usdLabel } from './util';

/* -------------------------------------------------------------------------- */
/*  Bounds                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Most companies founded in any one quarter, however many were wound up.
 *
 * Three failures in a quarter is a sector collapsing, and a sector that loses
 * three companies should feel thinner for a while rather than be restocked the
 * instant it empties.
 */
export const ENTRANTS_PER_QUARTER = 2;

/**
 * Active non-husk companies above which nothing is founded.
 *
 * The world opens with twenty-five. The cap is the point at which the industry
 * is crowded enough that a failure is absorbed by the incumbents rather than by
 * a newcomer, and it is what stops a long session growing without bound.
 */
export const ACTIVE_COMPANY_CAP = 40;

/** Quarters an entrant is still labelled new on the screens that list rivals. */
export const NEW_ENTRANT_QUARTERS = 4;

/** The forked stream every draw in this module comes from. */
const ENTRY_STREAM = 'market_entry';

/* -------------------------------------------------------------------------- */
/*  The name bank                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Sixty-six two-part company names, eleven per sector.
 *
 * Names are consumed in draw order and never reused inside a session: a name
 * already carried by any company — the husk included, because the husk is still
 * on the register — is skipped. Eleven per sector against a cap of forty
 * companies is deliberately more than a session can exhaust; the fallback below
 * exists anyway, because a bank that can run out and has no fallback is a crash
 * waiting for a long game.
 */
export const NAME_BANK: Readonly<Record<Sector, readonly string[]>> = {
  ai: [
    'Everline Research',
    'Quillon Systems',
    'Adamant Reason',
    'Northbank Intelligence',
    'Pellucid Labs',
    'Ostraya Cognition',
    'Foundry Nine',
    'Marrow Intelligence',
    'Solenne Research',
    'Thornbury Models',
    'Cadenza Labs',
  ],
  robotics: [
    'Ironbrook Robotics',
    'Kestrel Motion',
    'Wayland Actuation',
    'Sundial Machines',
    'Peregrine Works',
    'Calder Automation',
    'Bramblewood Robotics',
    'Ashgrove Motion',
    'Halberd Systems',
    'Tessera Machines',
    'Vantage Limbs',
  ],
  manufacturing: [
    'Redmarch Fabrication',
    'Coldwater Foundry',
    'Ardent Silicon',
    'Blackmoor Works',
    'Sableport Fabrication',
    'Highfield Silicon',
    'Nimbus Foundry',
    'Kettle Creek Works',
    'Orrery Fabrication',
    'Basildon Silicon',
    'Windrow Assembly',
  ],
  energy: [
    'Larkspur Power',
    'Fenmoor Energy',
    'Antares Grid',
    'Copperline Power',
    'Salt Marsh Energy',
    'Highwater Grid',
    'Meridian Turbine',
    'Auroch Power',
    'Bellwether Energy',
    'Stonecrop Grid',
    'Vellum Power',
  ],
  logistics: [
    'Wharfside Logistics',
    'Trellis Freight',
    'Corvid Transit',
    'Longacre Logistics',
    'Halyard Freight',
    'Brightpath Transit',
    'Mooring Lane',
    'Cantilever Freight',
    'Drayton Logistics',
    'Nettle Row Transit',
    'Selkirk Haulage',
  ],
  consumer: [
    'Marigold Studio',
    'Pocketwatch Apps',
    'Juniper Commons',
    'Fable & Co',
    'Hazelbrook Studio',
    'Loomwork Apps',
    'Camberwell Commons',
    'Tidewater Studio',
    'Plumcourt Apps',
    'Orchard Lane Commons',
    'Bellhouse Studio',
  ],
};

/**
 * Sixty-six founder names, drawn from the same bank so a founder is never a
 * generated string. Consumed by the same skip-what-is-taken rule as the company
 * names.
 */
export const FOUNDER_NAME_BANK: readonly string[] = [
  'Imogen Rask',
  'Tobias Ferrer',
  'Nadia Kellen',
  'Emeka Osaze',
  'Sylvie Aumont',
  'Hiroshi Tanabe',
  'Priya Rathore',
  'Marcus Ondaatje',
  'Ingrid Solberg',
  'Rafael Quintero',
  'Aisha Benali',
  'Callum Dorsey',
  'Yelena Petrova',
  'Mateus Almeida',
  'Fenella Crowe',
  'Omar Haddad',
  'Beatriz Salgado',
  'Jonas Vikram',
  'Cressida Lowe',
  'Dae-Ho Yun',
  'Marguerite Ives',
  'Salim Farouk',
  'Anouk Delacroix',
  'Bertrand Oyelaran',
  'Sanjay Deval',
  'Karolina Nowak',
  'Ephraim Blount',
  'Noor Rahimi',
  'Gideon Marsh',
  'Ximena Cortes',
  'Leif Andersen',
  'Rania Toure',
  'Vikram Chandra',
  'Ottoline Reeve',
  'Kenji Morrow',
  'Adaeze Nwosu',
  'Franz Hollander',
  'Marisol Vega',
  'Tomas Halloran',
  'Yuki Shimada',
  'Delphine Auber',
  'Nikolai Brandt',
  'Ayodele Sanni',
  'Clemency Ward',
  'Ravi Sundaram',
  'Elsa Lindqvist',
  'Hakim Zayed',
  'Paloma Duarte',
  'Cormac Tighe',
  'Sofia Brenner',
  'Amara Dike',
  'Julius Renwick',
  'Mira Kovac',
  'Idris Bello',
  'Constance Wren',
  'Pavel Dvorak',
  'Layla Mansour',
  'Ronan Fitzgerald',
  'Hana Ishikawa',
  'Ines Marchetti',
  'Absalom Frey',
  'Teodora Ilic',
  'Wole Adeyemi',
  'Greta Lindholm',
  'Arjun Bhandari',
  'Celeste Baumann',
];

/* -------------------------------------------------------------------------- */
/*  Sector shapes                                                              */
/* -------------------------------------------------------------------------- */

/** Which archetypes a sector's newcomers take. Drawn from, never assigned. */
const SECTOR_ARCHETYPES: Readonly<Record<Sector, readonly Company['archetype'][]>> = {
  ai: ['frontier_lab', 'enterprise_ai', 'data'],
  robotics: ['enterprise_ai', 'infrastructure', 'defence_ai'],
  manufacturing: ['chip_maker', 'infrastructure', 'enterprise_ai'],
  energy: ['infrastructure', 'cloud', 'chip_maker'],
  logistics: ['enterprise_ai', 'infrastructure', 'cloud'],
  consumer: ['consumer_ai', 'enterprise_ai', 'data'],
};

/** Market bucket an entrant's shares and sentiment are struck against. */
const SECTOR_BUCKET: Readonly<Record<Sector, string>> = {
  ai: 'frontier_models',
  robotics: 'enterprise_software',
  manufacturing: 'semiconductors',
  energy: 'energy_infrastructure',
  logistics: 'enterprise_software',
  consumer: 'consumer_ai',
};

/** The cheque a sector's founding round is sized around, before region and market. */
const SECTOR_SEED_CAPITAL_USD: Readonly<Record<Sector, number>> = {
  ai: 180_000_000,
  robotics: 120_000_000,
  manufacturing: 220_000_000,
  energy: 240_000_000,
  logistics: 90_000_000,
  consumer: 70_000_000,
};

/** Gross margin an entrant opens on, by sector. Inside the sector's own band. */
const SECTOR_OPENING_MARGIN: Readonly<Record<Sector, number>> = {
  ai: 0.58,
  robotics: 0.42,
  manufacturing: 0.36,
  energy: 0.34,
  logistics: 0.31,
  consumer: 0.47,
};

/** The founding product line, one per sector. */
const SECTOR_PRODUCT: Readonly<Record<Sector, { readonly suffix: string; readonly segment: V2CompanySeed['product']['segment']; readonly price: number; readonly intensity: number }>> = {
  ai: { suffix: 'Model API', segment: 'developer_api', price: 900, intensity: 0.72 },
  robotics: { suffix: 'Cell', segment: 'enterprise', price: 42_000, intensity: 0.4 },
  manufacturing: { suffix: 'Line', segment: 'enterprise', price: 120_000, intensity: 0.22 },
  energy: { suffix: 'Supply', segment: 'enterprise', price: 260_000, intensity: 0.12 },
  logistics: { suffix: 'Network', segment: 'enterprise', price: 34_000, intensity: 0.18 },
  consumer: { suffix: 'App', segment: 'consumer', price: 11, intensity: 0.3 },
};

/** Cities an entrant is headquartered in, one per region. */
const REGION_CITY: Readonly<Record<Region, string>> = {
  north_america: 'Cedar Point',
  europe: 'Ravensholm',
  east_asia: 'Kanto Bay',
  south_asia: 'Nilkanth',
  middle_east: 'Al Sirr',
  latin_america: 'Puerto Verde',
};

/* -------------------------------------------------------------------------- */
/*  What the phase hands over                                                  */
/* -------------------------------------------------------------------------- */

/**
 * One wind-up the quarter performed, as the row that recorded it.
 *
 * Collected as `enterAdministration` emits, rather than stored on the company:
 * "was this company wound up this quarter" is a fact about the quarter, and a
 * flag on `Company` would survive into the next one and have to be cleared.
 */
export interface AdministrationRow {
  readonly companyId: string;
  readonly eventId: string;
}

/** What one founding did, for the phase that called it. */
export interface MarketEntry {
  readonly company: Company;
  readonly founder: Character;
  readonly replacesCompanyId: string;
  readonly seedCapitalUsd: number;
  readonly leadInvestorId: string | null;
}

/* -------------------------------------------------------------------------- */
/*  Draws                                                                      */
/* -------------------------------------------------------------------------- */

/** Active companies that are still trading, i.e. everything but the husks. */
export function activeNonHuskCount(draft: SessionState): number {
  let total = 0;
  for (const company of draft.companies) {
    if (!company.isActive) continue;
    if (isWoundUp(company)) continue;
    total += 1;
  }
  return total;
}

/**
 * Where a company founded into this sector sets up.
 *
 * Weighted by how deep the local capital is and how well the region suits the
 * sector, multiplied rather than added: a region with no money and no fit is
 * nearly impossible, and a region strong on both is roughly twice as likely as
 * the average one. Both indices are around 100, so the product is around 10,000
 * and the weights need no normalising beyond the running total.
 */
export function regionWeightFor(region: Region, sector: Sector): number {
  return regionMeta(region).capitalDepth * regionSectorAffinity(region, sector);
}

function drawRegion(rng: SeededRng, sector: Sector): Region {
  const weights = REGIONS.map((region) => regionWeightFor(region, sector));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  let ticket = rng.range(0, total);
  for (let index = 0; index < REGIONS.length; index += 1) {
    const region = REGIONS[index];
    const weight = weights[index];
    if (region === undefined || weight === undefined) continue;
    ticket -= weight;
    if (ticket <= 0) return region;
  }
  return REGIONS[0] ?? 'north_america';
}

/** The first unused name in draw order, or a numbered fallback. */
function drawName(rng: SeededRng, sector: Sector, taken: ReadonlySet<string>): string {
  const pool = [...(NAME_BANK[sector] ?? []), ...SECTORS.flatMap((other) => (other === sector ? [] : (NAME_BANK[other] ?? [])))];
  const available = pool.filter((name) => !taken.has(name.toLowerCase()));
  if (available.length > 0) return rng.pick(available);
  // Unreachable at ACTIVE_COMPANY_CAP = 40 against a bank of 66, and here so
  // that a wider cap later is a balance change rather than a crash.
  for (let suffix = 2; suffix < 100; suffix += 1) {
    const candidate = `${pool[0] ?? 'New Venture'} ${suffix}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return `New Venture ${taken.size + 1}`;
}

function drawFounderName(rng: SeededRng, taken: ReadonlySet<string>): string {
  const available = FOUNDER_NAME_BANK.filter((name) => !taken.has(name.toLowerCase()));
  if (available.length > 0) return rng.pick(available);
  return `Founder ${taken.size + 1}`;
}

/**
 * The cheque that funds the founding, in whole dollars.
 *
 * Three things set it and all three are state: what the sector costs to start
 * in, how deep the region's capital is, and how open the venture market is this
 * quarter. The jitter is the only draw, and it is small — a founding is a
 * function of the world, not a lottery.
 */
export function seedCapitalUsd(draft: SessionState, sector: Sector, region: Region, jitter: number): number {
  const base = SECTOR_SEED_CAPITAL_USD[sector];
  const depth = regionMeta(region).capitalDepth / 100;
  const liquidity = 0.6 + 0.8 * draft.world.capitalMarkets.ventureLiquidity;
  return Math.max(1_000_000, Math.round(base * depth * liquidity * jitter));
}

/**
 * The fund that leads the round, or null when nobody has the money.
 *
 * Ranked on appetite for the sector and broken on id, so the same world always
 * picks the same lead. A fund must be able to write the whole cheque out of what
 * it may actually deploy — `deployableUsd`, not raw dry powder, so a founding
 * respects the same reserve every other desk keeps — because a part-funded
 * founding would leave the balance sheet short of the round the ledger row says
 * closed.
 */
export function leadInvestorFor(draft: SessionState, sector: Sector, chequeUsd: number): CapitalEntity | null {
  let best: CapitalEntity | null = null;
  let bestScore = -1;
  for (const entity of draft.capitalEntities ?? []) {
    if (!entity.isActive) continue;
    if (entity.kind !== 'vc') continue;
    if (deployableUsd(entity) < chequeUsd) continue;
    const score = entity.sectorAffinity[sector] ?? 0;
    if (score > bestScore || (score === bestScore && best !== null && entity.id < best.id)) {
      best = entity;
      bestScore = score;
    }
  }
  return best;
}

/* -------------------------------------------------------------------------- */
/*  The seed                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Build the runtime seed row for one entrant.
 *
 * Deliberately the same `V2CompanySeed` shape the scenario file declares, so the
 * entrant goes through `deriveCompany` and the four builders untouched. A
 * founding is a company with one product already in market — the team spun out
 * with something to sell — a small compute footprint, no debt and no goodwill.
 */
function seedFor(input: {
  readonly slug: string;
  readonly name: string;
  readonly sector: Sector;
  readonly region: Region;
  readonly archetype: Company['archetype'];
  readonly founderId: string;
  readonly cashUsd: number;
  readonly tier: Company['tier'];
  readonly rng: SeededRng;
}): V2CompanySeed {
  const { rng } = input;
  const product = SECTOR_PRODUCT[input.sector];
  const margin = SECTOR_OPENING_MARGIN[input.sector];
  const talentCost = regionMeta(input.region).talentCostIndex / 100;

  // Headcount first, then payroll from it: `deriveCompany` reads average
  // compensation off payroll divided by headcount, so choosing both
  // independently is how a scenario ends up paying forty people a billion.
  const engineers = rng.int(14, 30);
  const researchers = rng.int(3, 10);
  const sales = rng.int(2, 8);
  const ops = rng.int(4, 14);
  const execs = rng.int(2, 4);
  const headcount = engineers + researchers + sales + ops + execs;
  const annualComp = Math.round(165_000 * talentCost);
  const payroll = Math.round((headcount * annualComp) / 4);

  // A founding trades from day one at a fraction of the cheque, which is what
  // makes it a competitor next quarter rather than an empty row.
  const revenue = Math.round(input.cashUsd * rng.range(0.02, 0.05));
  const marketing = Math.round(revenue * 0.18);
  const rd = Math.round(payroll * rng.range(0.3, 0.6));
  const capex = Math.round(input.cashUsd * 0.03);
  const ppe = Math.round(input.cashUsd * 0.12);
  const receivables = Math.round(revenue * 0.4);
  const payables = Math.round(revenue * 0.25);

  return {
    id: makeId('cmp', input.slug),
    slug: input.slug,
    name: input.name,
    ticker: null,
    archetype: input.archetype,
    tier: input.tier,
    sector: input.sector,
    region: input.region,
    sectorId: SECTOR_BUCKET[input.sector],
    city: REGION_CITY[input.region],
    // Never listed at birth: an entrant is private, so it has no instrument, no
    // quote and nothing for `market_integrity` to price.
    isPublic: false,
    listPriceUsd: null,
    beta: 1.1,
    ceoCharacterId: input.founderId,
    boardId: null,
    posture: 'aggressive_growth',
    riskTolerance: rng.range(0.5, 0.8),
    standing: rng.int(18, 34),
    capabilityLevel: rng.range(0.28, 0.46),
    pastPerformance: 0,
    revenue,
    margin,
    growthYoY: rng.range(0.35, 0.9),
    payroll,
    marketing,
    rd,
    capex,
    interest: 0,
    cash: input.cashUsd,
    debt: 0,
    deferred: 0,
    backlog: 0,
    ppe,
    goodwill: 0,
    investments: 0,
    receivables,
    payables,
    staff: [engineers, researchers, sales, ops, execs],
    morale: rng.int(68, 84),
    attrition: 0.06,
    compute: [rng.int(40, 160), 0, Math.round(input.cashUsd * 0.004)],
    product: {
      name: `${input.name.split(' ')[0] ?? input.name} ${product.suffix}`,
      segment: product.segment,
      categoryId: defaultCategoryFor(input.sector, product.segment),
      price: product.price,
      churn: 0.07,
      growth: 0.14,
      quality: rng.range(0.5, 0.68),
      intensity: product.intensity,
    },
    anchorMethod: 'revenue_multiple',
  };
}

/* -------------------------------------------------------------------------- */
/*  Founding                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Found one company into the gap `dead` left, and put it on every per-company
 * table `SessionState` carries.
 *
 * Returns null only when the dead company cannot be found, which cannot happen
 * from the phase but keeps this callable from a test with a stale id.
 */
function foundCompany(draft: SessionState, ctx: ResolverContext, rng: SeededRng, deadCompanyId: string): MarketEntry | null {
  const dead = draft.companies.find((company) => company.id === deadCompanyId) ?? null;
  if (dead === null) return null;

  const takenCompanyNames = new Set(draft.companies.map((company) => company.name.toLowerCase()));
  const takenPersonNames = new Set(draft.characters.map((character) => character.name.toLowerCase()));

  const sector = dead.sector;
  const region = drawRegion(rng, sector);
  const archetype = rng.pick(SECTOR_ARCHETYPES[sector]);
  const name = drawName(rng, sector, takenCompanyNames);
  const founderName = drawFounderName(rng, takenPersonNames);
  const cheque = seedCapitalUsd(draft, sector, region, rng.range(0.85, 1.15));
  const lead = leadInvestorFor(draft, sector, cheque);

  // The quarter is in the slug, so a replay mints the same ids in the same
  // order and two entrants in one quarter never collide.
  const slug = `${slugOf(name)}_q${ctx.quarter}`;
  const founderId = makeId('chr', slugOf(founderName), `q${ctx.quarter}`);

  // A company dies and a serious company replaces it: a major or significant
  // failure leaves a gap worth backing, a background one does not.
  const tier: Company['tier'] = dead.tier === 'background' ? 'background' : 'significant';

  const seed = seedFor({ slug, name, sector, region, archetype, founderId, cashUsd: cheque, tier, rng });
  const derived = deriveCompany(seed);

  /* --- the founder ------------------------------------------------------- */
  const founder = buildV2Character(
    founderId,
    founderName,
    'founder_ceo',
    seed.id,
    `Founder and CEO — ${name}`,
    [rng.int(52, 80), rng.int(45, 78), rng.int(30, 60), rng.int(45, 75), rng.int(35, 65)],
    // Modest: nobody in this industry has heard of them yet.
    rng.int(8, 26),
    rng.int(2, 12) * 100_000,
    1,
    rng.int(400, 9_000),
    [{ topic: 'compute_scarcity', level: 'medium' }],
    false,
  );
  draft.characters = [...draft.characters, founder];

  /* --- the company and its books ----------------------------------------- */
  const company: Company = {
    ...buildV2Company(seed),
    foundedQuarter: ctx.quarter,
    controllerPlayerId: null,
  };
  company.products = company.products.map((product) => ({ ...product, launchedQuarter: ctx.quarter }));
  company.offices = company.offices.map((office) => ({ ...office, openedQuarter: ctx.quarter }));
  // World 3: an entrant owns what a seeded rival of its capability owns, so a
  // node whose only owner died is not unmakeable for the rest of the game.
  if (isNodeEconomyWorld(draft)) company.ownedNodes = [...startingNodesForRival(sector, seed.capabilityLevel)];
  draft.companies = [...draft.companies, company];

  draft.securities = [
    ...draft.securities,
    { id: SEC(slug), companyId: seed.id, shareClassId: SHC(slug), symbol: null, isTradable: false, instrumentId: null, parValueUsd: 0.0001 },
  ];

  // The scenario builder for the class arithmetic, then the register rewritten:
  // an entrant's holders are its founder and the fund that led the round, not
  // the regional blocs a seeded company opens with. The last holder takes the
  // residual so the positions sum to the issued count exactly.
  const table = buildV2CapTable(seed);
  // The lead takes what the cheque bought of the post-money, capped so the
  // founder keeps control of a company they have just founded. A position of no
  // shares is not a position, so a cheque too small to buy one leaves the
  // register to the founder alone rather than adding an empty row.
  const leadShares =
    lead === null ? 0 : Math.min(derived.shares - 1, Math.round(derived.shares * Math.min(0.45, cheque / Math.max(1, derived.valueUsd))));
  // A fund that bought no shares did not lead this round: below this line the
  // backer is whoever is actually on the register, so the cheque, the cap table
  // and the ledger row can never tell three different stories.
  const backer = leadShares > 0 ? lead : null;
  const holdings = [
    ...(backer === null
      ? []
      : [
          {
            id: makeId('hld', slug, 'lead'),
            holderId: backer.id,
            holderKind: 'fund' as const,
            securityId: SEC(slug),
            shares: leadShares,
            costBasisUsd: cheque,
            acquiredQuarter: ctx.quarter,
            lockupUntilQuarter: null,
            isDisclosed: true,
          },
        ]),
    {
      id: makeId('hld', slug, 'founder'),
      holderId: founderId,
      holderKind: 'character' as const,
      securityId: SEC(slug),
      shares: derived.shares - leadShares,
      costBasisUsd: 0,
      acquiredQuarter: ctx.quarter,
      lockupUntilQuarter: null,
      isDisclosed: true,
    },
  ];
  draft.capTables = [
    ...draft.capTables,
    {
      ...table,
      shareClasses: table.shareClasses.map((shareClass) => ({ ...shareClass, createdQuarter: ctx.quarter })),
      holdings,
      lastUpdatedQuarter: ctx.quarter,
    },
  ];

  draft.companyMetrics = [...draft.companyMetrics, { ...buildV2Metrics(seed), quarter: ctx.quarter }];
  draft.valuationAnchors = [...draft.valuationAnchors, { ...buildV2Anchor(seed), quarter: ctx.quarter }];

  /* --- the round --------------------------------------------------------- */
  let dryPowderDeltaUsd = 0;
  if (backer !== null) {
    dryPowderDeltaUsd = moveDryPowder(backer, -cheque);
    remember(
      backer,
      { companyId: seed.id, kind: 'term_sheet_offered', quarter: ctx.quarter, outcome: 'accepted', note: `Led the founding of ${name}.` },
      CAPITAL_ENTITY_MEMORY_LIMIT,
    );
  }
  const roundId = makeId('rnd', slug, 'seed');
  const round: FundingRound = {
    id: roundId,
    companyId: seed.id,
    stage: 'seed',
    amount: cheque,
    preMoney: Math.max(1, derived.valueUsd - cheque),
    postMoney: derived.valueUsd,
    dilution: derived.valueUsd > 0 ? Math.min(1, cheque / derived.valueUsd) : 0,
    pricePerShareUsd: derived.shares > 0 ? derived.valueUsd / derived.shares : 1,
    shareClassId: SHC(slug),
    leadInvestorCharacterId: backer?.partnerCharacterIds[0] ?? null,
    participantHolderIds: backer === null ? [founderId] : [backer.id],
    boardSeatsGranted: 0,
    closedQuarter: ctx.quarter,
    status: 'closed',
  };
  draft.fundingRounds = [...draft.fundingRounds, round];

  // The dry-powder half of the movement, on the row that caused it: this is the
  // only row `capital_integrity` reads, and a founding a fund paid for that did
  // not declare it would stop the quarter committing.
  emitEvent(
    draft,
    ctx,
    'funding_round_closed',
    seed.id,
    roundId,
    {
      stage: 'seed',
      amountUsd: cheque,
      preMoney: round.preMoney,
      postMoney: round.postMoney,
      dilution: Math.round(round.dilution * 10_000) / 10_000,
      pricePerShareUsd: Math.round(round.pricePerShareUsd * 1e6) / 1e6,
      newShares: leadShares,
      dealKind: 'founding',
      entityId: backer?.id ?? null,
      leadInvestorCharacterId: round.leadInvestorCharacterId,
      dryPowderDeltaUsd,
    },
    'public',
  );

  /* --- the record -------------------------------------------------------- */
  const eventId = emitEvent(
    draft,
    ctx,
    'information_revealed',
    seed.id,
    null,
    {
      kind: 'company_founded',
      companyId: seed.id,
      name,
      sector,
      region,
      founderCharacterId: founderId,
      seedCapitalUsd: money(cheque),
      leadInvestorId: backer?.id ?? null,
      replacesCompanyId: dead.id,
    },
    'public',
  );

  const fundedBy = backer === null ? `${founderName}'s own money` : `${backer.name}'s cheque`;
  const disclosure: PublicDisclosure = {
    id: makeId('dsc', slug, 'founded'),
    companyId: seed.id,
    quarter: ctx.quarter,
    kind: 'press_release',
    headline: `${name} is founded in ${regionMeta(region).label}`,
    body: `${founderName} has founded ${name} in ${REGION_CITY[region]} on ${usdLabel(cheque)} of ${fundedBy}, taking the ${sector.replace(/_/g, ' ')} share ${dead.name} left when it went into administration. The company is private and employs ${derived.headcount} people.`,
    metrics: { seedCapital: cheque, headcount: derived.headcount },
    credibility: 0.72,
    sourceCharacterId: founderId,
    isTruthful: true,
    beliefTopic: null,
  };
  draft.disclosures = [...draft.disclosures, disclosure];

  ctx.log({
    phase: 'financial_resolution',
    text: `${name} was founded in ${regionMeta(region).label} to take ${sector.replace(/_/g, ' ')} share left by ${dead.name}, on ${usdLabel(cheque)} from ${backer === null ? founderName : backer.name}.`,
    deltaLabel: usdLabel(cheque),
    refEventIds: [eventId],
    tone: 'positive',
    subjectId: seed.id,
  });

  return { company, founder, replacesCompanyId: dead.id, seedCapitalUsd: cheque, leadInvestorId: backer?.id ?? null };
}

/** Lowercase, underscore-joined, safe for an id segment. */
function slugOf(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/* -------------------------------------------------------------------------- */
/*  Phase entry                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Found one company for each wind-up the quarter recorded, bounded by
 * `ENTRANTS_PER_QUARTER` and by `ACTIVE_COMPANY_CAP`.
 *
 * World version 2 only: the frozen world has no market entry, so its state hash
 * is untouched. The wind-ups arrive in the order they were emitted, which is
 * company order inside the financial phase, so the entrants are deterministic
 * without sorting anything.
 */
export function resolveMarketEntry(draft: SessionState, ctx: ResolverContext, windUps: readonly AdministrationRow[]): MarketEntry[] {
  if (!isMultiSectorWorld(draft) || windUps.length === 0) return [];

  const rng = ctx.rng.fork(ENTRY_STREAM);
  const entries: MarketEntry[] = [];
  for (const row of windUps) {
    if (entries.length >= ENTRANTS_PER_QUARTER) break;
    if (activeNonHuskCount(draft) >= ACTIVE_COMPANY_CAP) break;
    const entry = foundCompany(draft, ctx, rng, row.companyId);
    if (entry !== null) entries.push(entry);
  }
  return entries;
}

/* -------------------------------------------------------------------------- */
/*  Elimination                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Close the seat of any player whose company was wound up this quarter.
 *
 * The administration row is already public and already says why; this adds the
 * one thing the ledger cannot infer, which is that a human is out of the game.
 * A seat is closed once and never reopened — `eliminatedQuarter` is set only
 * when it is absent — so a husk bought and rebuilt by somebody else does not
 * quietly hand the seat back.
 */
export function closeEliminatedSeats(draft: SessionState, ctx: ResolverContext, windUps: readonly AdministrationRow[]): string[] {
  if (!isMultiSectorWorld(draft) || windUps.length === 0) return [];
  const wound = new Set(windUps.map((row) => row.companyId));
  const closed: string[] = [];

  for (const player of draft.players) {
    if (!wound.has(player.companyId)) continue;
    if (player.eliminatedQuarter !== null && player.eliminatedQuarter !== undefined) continue;
    player.eliminatedQuarter = ctx.quarter;
    closed.push(player.playerId);

    const company = draft.companies.find((entry) => entry.id === player.companyId) ?? null;
    const row = windUps.find((entry) => entry.companyId === player.companyId);
    ctx.log({
      phase: 'financial_resolution',
      text: `${player.displayName} is out of the game: ${company?.name ?? player.companyId} went into administration and the seat is closed. What is left of the company can still be bought by somebody else.`,
      deltaLabel: 'eliminated',
      refEventIds: row === undefined ? [] : [row.eventId],
      tone: 'negative',
      subjectId: player.companyId,
    });
  }
  return closed;
}

/** Whether this seat is out of the game. Absent and null both mean playing. */
export function isEliminated(player: { readonly eliminatedQuarter?: number | null }): boolean {
  return player.eliminatedQuarter !== null && player.eliminatedQuarter !== undefined;
}

/**
 * Whether a company should still wear the "new" badge in the quarter `quarter`.
 *
 * World-2 only by construction: every world-1 company was founded in quarter 0
 * and the window has long since closed by the time anything is rendered.
 */
export function isNewEntrant(company: Pick<Company, 'foundedQuarter'>, quarter: number): boolean {
  return company.foundedQuarter > 0 && quarter - company.foundedQuarter < NEW_ENTRANT_QUARTERS;
}
