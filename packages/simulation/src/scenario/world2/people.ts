/**
 * @frontier/simulation — scenario/world2/people.ts
 *
 * The cast of world version 2: a founder for each of the twenty-four rivals,
 * the six investment blocs that sit on their registers, three independent
 * directors, a regulator, a procurement official, two journalists, and the seat
 * a human sits in.
 *
 * Founders are declared against their company rather than repeating its name:
 * the title, the company id and the character's place in the world all derive
 * from `V2_COMPANY_SEEDS`, so a company cannot end up with a chief executive
 * who works somewhere else.
 */

import type { Board, CapitalEntity, CapitalEntityKind, Character, FundingStage, MemoryKind, Region, SocialAccount } from '@frontier/contracts';
import { CapitalEntitySchema, DEFAULT_QUORUM_RULE, dryPowderFromPct, fullSectorAffinity, makeId } from '@frontier/contracts';
import { V2_COMPANY_SEEDS, V2_FUNDS, W2_COMPANIES, W2_FOUNDERS } from './seeds';
import { W2_PLAYER_BOARD_ID, W2_PLAYER_CHARACTER_ID } from './player';

const M = 1_000_000;
const BN = 1_000_000_000;

/* -------------------------------------------------------------------------- */
/*  Supporting cast                                                            */
/* -------------------------------------------------------------------------- */

export const W2_CHARACTERS = {
  ...W2_FOUNDERS,
  helena: 'chr_helena_ward',
  stefan: 'chr_stefan_koll',
  meilan: 'chr_mei_lan_ho',
  asha: 'chr_asha_rege',
  tariq: 'chr_tariq_almuhairi',
  ricardo: 'chr_ricardo_salas',
  // The five partners who arrive with the capital-entity roster. Every one is
  // seeded at a connection level BELOW the incumbents, so a first-quarter
  // founder can actually reach one of them under the connection gap rule.
  // A roster sitting entirely at 90+ would make the offers inbox the only way
  // to meet anybody, which defeats the Network screen.
  britt: 'chr_britt_halvorsen',
  ellis: 'chr_ellis_maddox',
  ken: 'chr_ken_sarawan',
  dov: 'chr_dov_ferreira',
  nadia: 'chr_nadia_brandt',
  ingrid: 'chr_ingrid_solheim',
  paul: 'chr_paul_okoye',
  nan: 'chr_nan_zhao',
  martin: 'chr_martin_devlin',
  amara: 'chr_amara_diallo',
  esther: 'chr_esther_lim',
  gabriel: 'chr_gabriel_ross',
  player: W2_PLAYER_CHARACTER_ID,
} as const;

/**
 * Which investor character speaks for each fund, for board representation and
 * for every word a partner says. One entry per entity on the roster: a fund
 * without a partner has nobody to negotiate with, which the roster test pins.
 */
export const W2_FUND_PRINCIPALS: Readonly<Record<string, string>> = {
  [V2_FUNDS.seawall]: W2_CHARACTERS.helena,
  [V2_FUNDS.tessera]: W2_CHARACTERS.stefan,
  [V2_FUNDS.kaido]: W2_CHARACTERS.meilan,
  [V2_FUNDS.indus]: W2_CHARACTERS.asha,
  [V2_FUNDS.qadr]: W2_CHARACTERS.tariq,
  [V2_FUNDS.altiplano]: W2_CHARACTERS.ricardo,
  [V2_FUNDS.ironwood]: W2_CHARACTERS.britt,
  [V2_FUNDS.grantwood]: W2_CHARACTERS.ellis,
  [V2_FUNDS.straits]: W2_CHARACTERS.ken,
  [V2_FUNDS.coldbrook]: W2_CHARACTERS.dov,
  [V2_FUNDS.perihelion]: W2_CHARACTERS.nadia,
};

/* -------------------------------------------------------------------------- */
/*  Seeds                                                                      */
/* -------------------------------------------------------------------------- */

type Traits = readonly [number, number, number, number, number];

interface FounderSeed {
  readonly companyId: string;
  readonly name: string;
  /** risk, technical, financial conservatism, aggressiveness, status sensitivity. */
  readonly traits: Traits;
  readonly connection: number;
  readonly wealth: number;
  readonly boards: number;
  readonly following: number;
  readonly beliefs: Character['beliefs'];
}

/** One founder per rival, in company order. */
const FOUNDER_SEEDS: readonly FounderSeed[] = [
  {
    companyId: W2_COMPANIES.aletheia,
    name: 'Rhea Valdes',
    traits: [86, 94, 31, 78, 62],
    connection: 84,
    wealth: 3.4 * BN,
    boards: 2,
    following: 1_400_000,
    beliefs: [
      { topic: 'frontier_progress', level: 'high' },
      { topic: 'compute_scarcity', level: 'high' },
      { topic: 'ai_regulation_risk', level: 'medium' },
    ],
  },
  {
    companyId: W2_COMPANIES.sable,
    name: 'Johan Brecht',
    traits: [79, 92, 44, 33, 51],
    connection: 58,
    wealth: 180 * M,
    boards: 1,
    following: 120_000,
    beliefs: [
      { topic: 'safety_priority', level: 'high' },
      { topic: 'open_source_threat', level: 'medium' },
    ],
  },
  {
    companyId: W2_COMPANIES.basalt,
    name: 'Layla Hadid',
    traits: [52, 71, 74, 46, 44],
    connection: 81,
    wealth: 940 * M,
    boards: 3,
    following: 96_000,
    beliefs: [
      { topic: 'compute_scarcity', level: 'high' },
      { topic: 'geopolitical_risk', level: 'high' },
    ],
  },
  {
    companyId: W2_COMPANIES.kestrel,
    name: 'Arjun Menon',
    traits: [60, 88, 52, 29, 38],
    connection: 54,
    wealth: 74 * M,
    boards: 1,
    following: 210_000,
    beliefs: [
      { topic: 'open_source_threat', level: 'low' },
      { topic: 'talent_war', level: 'high' },
    ],
  },
  {
    companyId: W2_COMPANIES.ironvale,
    name: 'Hana Morioka',
    traits: [64, 81, 48, 71, 57],
    connection: 76,
    wealth: 1.1 * BN,
    boards: 2,
    following: 330_000,
    beliefs: [
      { topic: 'consolidation_inevitable', level: 'high' },
      { topic: 'talent_war', level: 'medium' },
    ],
  },
  {
    companyId: W2_COMPANIES.wrenford,
    name: 'Clara Wren',
    traits: [81, 90, 24, 44, 68],
    connection: 49,
    wealth: 42 * M,
    boards: 1,
    following: 480_000,
    beliefs: [
      { topic: 'frontier_progress', level: 'high' },
      { topic: 'market_bubble', level: 'low' },
    ],
  },
  {
    companyId: W2_COMPANIES.sentinel,
    name: 'Dominic Pryor',
    traits: [47, 66, 72, 58, 49],
    connection: 88,
    wealth: 620 * M,
    boards: 2,
    following: 44_000,
    beliefs: [
      { topic: 'government_demand', level: 'high' },
      { topic: 'geopolitical_risk', level: 'high' },
    ],
  },
  {
    companyId: W2_COMPANIES.palma,
    name: 'Sofia Marchena',
    traits: [55, 74, 61, 34, 41],
    connection: 46,
    wealth: 28 * M,
    boards: 1,
    following: 62_000,
    beliefs: [
      { topic: 'government_demand', level: 'medium' },
      { topic: 'talent_war', level: 'low' },
    ],
  },
  {
    companyId: W2_COMPANIES.tessellate,
    name: 'Wei Lam',
    traits: [58, 84, 66, 62, 53],
    connection: 87,
    wealth: 2.2 * BN,
    boards: 3,
    following: 260_000,
    beliefs: [
      { topic: 'geopolitical_risk', level: 'high' },
      { topic: 'compute_scarcity', level: 'high' },
    ],
  },
  {
    companyId: W2_COMPANIES.halcyon,
    name: 'Annika Stroh',
    traits: [44, 86, 78, 26, 34],
    connection: 57,
    wealth: 96 * M,
    boards: 1,
    following: 18_000,
    beliefs: [
      { topic: 'consolidation_inevitable', level: 'medium' },
      { topic: 'market_bubble', level: 'high' },
    ],
  },
  {
    companyId: W2_COMPANIES.cinder,
    name: 'Mateo Ruiz',
    traits: [68, 62, 36, 74, 58],
    connection: 52,
    wealth: 140 * M,
    boards: 1,
    following: 88_000,
    beliefs: [
      { topic: 'government_demand', level: 'high' },
      { topic: 'market_bubble', level: 'low' },
    ],
  },
  {
    companyId: W2_COMPANIES.rasan,
    name: 'Faisal Noury',
    traits: [40, 58, 82, 38, 46],
    connection: 71,
    wealth: 310 * M,
    boards: 2,
    following: 9_000,
    beliefs: [
      { topic: 'government_demand', level: 'high' },
      { topic: 'consolidation_inevitable', level: 'low' },
    ],
  },
  {
    companyId: W2_COMPANIES.qanat,
    name: 'Dana Al-Masri',
    traits: [44, 69, 76, 41, 55],
    connection: 90,
    wealth: 1.6 * BN,
    boards: 4,
    following: 130_000,
    beliefs: [
      { topic: 'government_demand', level: 'high' },
      { topic: 'compute_scarcity', level: 'medium' },
    ],
  },
  {
    companyId: W2_COMPANIES.volta,
    name: 'Camila Borges',
    traits: [42, 64, 80, 28, 33],
    connection: 55,
    wealth: 84 * M,
    boards: 1,
    following: 24_000,
    beliefs: [
      { topic: 'market_bubble', level: 'medium' },
      { topic: 'government_demand', level: 'medium' },
    ],
  },
  {
    companyId: W2_COMPANIES.grimsby,
    name: 'Owen Tallis',
    traits: [57, 61, 44, 66, 62],
    connection: 68,
    wealth: 110 * M,
    boards: 2,
    following: 41_000,
    beliefs: [
      { topic: 'compute_scarcity', level: 'high' },
      { topic: 'ai_regulation_risk', level: 'medium' },
    ],
  },
  {
    companyId: W2_COMPANIES.suryan,
    name: 'Meera Saxena',
    traits: [38, 72, 84, 31, 36],
    connection: 63,
    wealth: 190 * M,
    boards: 2,
    following: 52_000,
    beliefs: [
      { topic: 'government_demand', level: 'medium' },
      { topic: 'geopolitical_risk', level: 'low' },
    ],
  },
  {
    companyId: W2_COMPANIES.harbourline,
    name: 'Jun Park',
    traits: [36, 58, 79, 52, 44],
    connection: 79,
    wealth: 760 * M,
    boards: 3,
    following: 34_000,
    beliefs: [
      { topic: 'consolidation_inevitable', level: 'high' },
      { topic: 'talent_war', level: 'low' },
    ],
  },
  {
    companyId: W2_COMPANIES.overland,
    name: 'Bill Hargrove',
    traits: [31, 42, 88, 61, 66],
    connection: 61,
    wealth: 66 * M,
    boards: 1,
    following: 7_000,
    beliefs: [
      { topic: 'market_bubble', level: 'high' },
      { topic: 'consolidation_inevitable', level: 'high' },
    ],
  },
  {
    companyId: W2_COMPANIES.ganga,
    name: 'Ravi Khatri',
    traits: [60, 55, 46, 68, 48],
    connection: 50,
    wealth: 38 * M,
    boards: 1,
    following: 96_000,
    beliefs: [
      { topic: 'talent_war', level: 'medium' },
      { topic: 'government_demand', level: 'medium' },
    ],
  },
  {
    companyId: W2_COMPANIES.dune,
    name: 'Yusuf Barakat',
    traits: [66, 51, 34, 72, 59],
    connection: 44,
    wealth: 14 * M,
    boards: 1,
    following: 150_000,
    beliefs: [
      { topic: 'consolidation_inevitable', level: 'medium' },
      { topic: 'market_bubble', level: 'low' },
    ],
  },
  {
    companyId: W2_COMPANIES.lumen,
    name: 'Teresa Nunn',
    traits: [50, 54, 62, 57, 71],
    connection: 77,
    wealth: 520 * M,
    boards: 2,
    following: 890_000,
    beliefs: [
      { topic: 'ai_regulation_risk', level: 'high' },
      { topic: 'consolidation_inevitable', level: 'medium' },
    ],
  },
  {
    companyId: W2_COMPANIES.tanto,
    name: 'Akira Sonoda',
    traits: [34, 60, 84, 29, 38],
    connection: 59,
    wealth: 130 * M,
    boards: 1,
    following: 61_000,
    beliefs: [
      { topic: 'market_bubble', level: 'high' },
      { topic: 'consolidation_inevitable', level: 'medium' },
    ],
  },
  {
    companyId: W2_COMPANIES.copa,
    name: 'Lucia Prado',
    traits: [70, 49, 32, 66, 64],
    connection: 53,
    wealth: 46 * M,
    boards: 1,
    following: 420_000,
    beliefs: [
      { topic: 'talent_war', level: 'low' },
      { topic: 'ai_regulation_risk', level: 'low' },
    ],
  },
  {
    companyId: W2_COMPANIES.vasant,
    name: 'Neel Bhatia',
    traits: [62, 57, 41, 63, 52],
    connection: 47,
    wealth: 22 * M,
    boards: 1,
    following: 310_000,
    beliefs: [
      { topic: 'consolidation_inevitable', level: 'low' },
      { topic: 'talent_war', level: 'medium' },
    ],
  },
];

interface CastSeed {
  readonly id: string;
  readonly name: string;
  readonly role: Character['role'];
  readonly title: string;
  readonly traits: Traits;
  readonly connection: number;
  readonly wealth: number;
  readonly boards: number;
  readonly following: number;
  readonly beliefs: Character['beliefs'];
}

/** Everyone who is not running a company. */
const CAST_SEEDS: readonly CastSeed[] = [
  {
    id: W2_CHARACTERS.helena,
    name: 'Helena Ward',
    role: 'investor',
    title: 'Managing Partner — Seawall Capital',
    traits: [58, 64, 69, 47, 56],
    connection: 91,
    wealth: 840 * M,
    boards: 7,
    following: 110_000,
    beliefs: [
      { topic: 'consolidation_inevitable', level: 'high' },
      { topic: 'player_trustworthiness', level: 'medium' },
    ],
  },
  {
    id: W2_CHARACTERS.stefan,
    name: 'Stefan Koll',
    role: 'investor',
    title: 'Partner — Tessera Industrial',
    traits: [46, 71, 78, 38, 42],
    connection: 78,
    wealth: 290 * M,
    boards: 5,
    following: 21_000,
    beliefs: [
      { topic: 'market_bubble', level: 'high' },
      { topic: 'ai_regulation_risk', level: 'medium' },
    ],
  },
  {
    id: W2_CHARACTERS.meilan,
    name: 'Mei-Lan Ho',
    role: 'investor',
    title: 'Managing Director — Kaido Partners',
    traits: [62, 68, 58, 61, 49],
    connection: 84,
    wealth: 410 * M,
    boards: 6,
    following: 38_000,
    beliefs: [
      { topic: 'geopolitical_risk', level: 'high' },
      { topic: 'compute_scarcity', level: 'medium' },
    ],
  },
  {
    id: W2_CHARACTERS.asha,
    name: 'Asha Rege',
    role: 'investor',
    title: 'Partner — Indus Growth',
    traits: [66, 59, 52, 44, 45],
    connection: 72,
    wealth: 96 * M,
    boards: 4,
    following: 64_000,
    beliefs: [
      { topic: 'talent_war', level: 'high' },
      { topic: 'consolidation_inevitable', level: 'medium' },
    ],
  },
  {
    id: W2_CHARACTERS.tariq,
    name: 'Tariq Al-Muhairi',
    role: 'investor',
    title: 'Chief Investment Officer — Qadr Sovereign Fund',
    traits: [41, 62, 81, 33, 79],
    connection: 94,
    wealth: 0,
    boards: 3,
    following: 8_000,
    beliefs: [
      { topic: 'government_demand', level: 'high' },
      { topic: 'geopolitical_risk', level: 'high' },
    ],
  },
  {
    id: W2_CHARACTERS.ricardo,
    name: 'Ricardo Salas',
    role: 'investor',
    title: 'Partner — Altiplano Capital',
    traits: [69, 51, 47, 55, 43],
    connection: 66,
    wealth: 74 * M,
    boards: 3,
    following: 16_000,
    beliefs: [
      { topic: 'market_bubble', level: 'medium' },
      { topic: 'government_demand', level: 'low' },
    ],
  },
  // --- the five partners who arrive with the capital-entity roster ---------
  //
  // Connection levels descend deliberately: Ellis Maddox at 82 is a name a
  // successful founder eventually reaches, and Britt Halvorsen at 58 is the
  // door a first-quarter founder can actually walk through. Nobody here is
  // seeded above the incumbents.
  {
    id: W2_CHARACTERS.ellis,
    name: 'Ellis Maddox',
    role: 'investor',
    title: 'Managing Partner — Grantwood Partners',
    traits: [52, 46, 84, 81, 66],
    connection: 82,
    wealth: 620 * M,
    boards: 6,
    following: 9_400,
    beliefs: [
      { topic: 'consolidation_inevitable', level: 'high' },
      { topic: 'market_bubble', level: 'high' },
    ],
  },
  {
    id: W2_CHARACTERS.ken,
    name: 'Ken Sarawan',
    role: 'investor',
    title: 'Partner — Straits Industrial Partners',
    traits: [48, 58, 76, 62, 44],
    connection: 70,
    wealth: 210 * M,
    boards: 4,
    following: 5_100,
    beliefs: [
      { topic: 'consolidation_inevitable', level: 'high' },
      { topic: 'geopolitical_risk', level: 'medium' },
    ],
  },
  {
    id: W2_CHARACTERS.dov,
    name: 'Dov Ferreira',
    role: 'investor',
    title: 'Chief Investment Officer — Coldbrook Capital',
    traits: [71, 74, 61, 88, 58],
    connection: 68,
    // A large following for a small fund: a desk that publishes its arguments
    // is read far more widely than one that does not, and the credibility of
    // what it publishes is what its track record is spent on.
    wealth: 180 * M,
    boards: 1,
    following: 240_000,
    beliefs: [
      { topic: 'market_bubble', level: 'high' },
      { topic: 'frontier_progress', level: 'low' },
    ],
  },
  {
    id: W2_CHARACTERS.nadia,
    name: 'Nadia Brandt',
    role: 'investor',
    title: 'Partner — Perihelion Capital',
    traits: [66, 69, 58, 72, 47],
    connection: 64,
    wealth: 88 * M,
    boards: 1,
    following: 34_000,
    beliefs: [
      { topic: 'consolidation_inevitable', level: 'high' },
      { topic: 'ai_regulation_risk', level: 'medium' },
    ],
  },
  {
    id: W2_CHARACTERS.britt,
    name: 'Britt Halvorsen',
    role: 'investor',
    title: 'Founding Partner — Ironwood Ventures',
    traits: [78, 84, 42, 51, 34],
    connection: 58,
    wealth: 38 * M,
    boards: 2,
    following: 6_500,
    beliefs: [
      { topic: 'frontier_progress', level: 'high' },
      { topic: 'talent_war', level: 'medium' },
    ],
  },
  {
    id: W2_CHARACTERS.ingrid,
    name: 'Ingrid Solheim',
    role: 'director',
    title: 'Independent Director',
    traits: [42, 74, 86, 31, 39],
    connection: 73,
    wealth: 62 * M,
    boards: 4,
    following: 12_000,
    beliefs: [{ topic: 'safety_priority', level: 'high' }],
  },
  {
    id: W2_CHARACTERS.paul,
    name: 'Paul Okoye',
    role: 'director',
    title: 'Independent Director',
    traits: [51, 88, 61, 34, 36],
    connection: 69,
    wealth: 24 * M,
    boards: 3,
    following: 58_000,
    beliefs: [
      { topic: 'frontier_progress', level: 'medium' },
      { topic: 'safety_priority', level: 'medium' },
    ],
  },
  {
    id: W2_CHARACTERS.nan,
    name: 'Nan Zhao',
    role: 'director',
    title: 'Independent Director',
    traits: [33, 56, 94, 48, 44],
    connection: 74,
    wealth: 118 * M,
    boards: 5,
    following: 9_000,
    beliefs: [{ topic: 'market_bubble', level: 'high' }],
  },
  {
    id: W2_CHARACTERS.martin,
    name: 'Martin Devlin',
    role: 'regulator',
    title: 'Commissioner — Federal Technology Oversight',
    traits: [29, 61, 74, 52, 58],
    connection: 83,
    wealth: 0,
    boards: 0,
    following: 46_000,
    beliefs: [
      { topic: 'ai_regulation_risk', level: 'high' },
      { topic: 'consolidation_inevitable', level: 'high' },
    ],
  },
  {
    id: W2_CHARACTERS.amara,
    name: 'Amara Diallo',
    role: 'official',
    title: 'Director of Strategic Procurement',
    traits: [37, 58, 71, 42, 51],
    connection: 86,
    wealth: 0,
    boards: 0,
    following: 14_000,
    beliefs: [
      { topic: 'government_demand', level: 'high' },
      { topic: 'geopolitical_risk', level: 'medium' },
    ],
  },
  {
    id: W2_CHARACTERS.esther,
    name: 'Esther Lim',
    role: 'journalist',
    title: 'Senior Correspondent — The Frontier Ledger',
    traits: [54, 68, 49, 66, 47],
    connection: 75,
    wealth: 2 * M,
    boards: 0,
    following: 710_000,
    beliefs: [{ topic: 'safety_priority', level: 'high' }],
  },
  {
    id: W2_CHARACTERS.gabriel,
    name: 'Gabriel Ross',
    role: 'journalist',
    title: 'Markets Editor — Capital Wire',
    traits: [61, 44, 42, 59, 54],
    connection: 70,
    wealth: 1.4 * M,
    boards: 0,
    following: 520_000,
    beliefs: [{ topic: 'market_bubble', level: 'medium' }],
  },
];

/* -------------------------------------------------------------------------- */
/*  Builders                                                                   */
/* -------------------------------------------------------------------------- */

function character(
  id: string,
  name: string,
  role: Character['role'],
  companyId: string | null,
  title: string,
  traits: Traits,
  connection: number,
  wealth: number,
  boards: number,
  following: number,
  beliefs: Character['beliefs'],
  isPlayer: boolean,
): Character {
  const [riskTolerance, technicalOrientation, financialConservatism, aggressiveness, statusSensitivity] = traits;
  return {
    id,
    name,
    role,
    companyId,
    title,
    stableTraits: { riskTolerance, technicalOrientation, financialConservatism, aggressiveness, statusSensitivity },
    beliefs: beliefs.map((belief) => ({ ...belief })),
    connectionLevel: connection,
    isPlayer,
    personalWealthUsd: wealth,
    boardSeatCount: boards,
    publicFollowing: following,
    isActive: true,
  };
}

/**
 * The whole cast: founders (titled from their own company), the supporting
 * cast, and the founder the player is.
 */
export function buildV2Characters(playerName: string, playerCompanyName: string): Character[] {
  const companyById = new Map(V2_COMPANY_SEEDS.map((seed) => [seed.id, seed] as const));
  const founders = FOUNDER_SEEDS.map((seed) => {
    const company = companyById.get(seed.companyId);
    if (company === undefined) throw new Error(`world 2 founder seed names an unknown company: ${seed.companyId}`);
    return character(
      company.ceoCharacterId,
      seed.name,
      'founder_ceo',
      company.id,
      `CEO — ${company.name}`,
      seed.traits,
      seed.connection,
      seed.wealth,
      seed.boards,
      seed.following,
      seed.beliefs,
      false,
    );
  });

  const cast = CAST_SEEDS.map((seed) =>
    character(seed.id, seed.name, seed.role, null, seed.title, seed.traits, seed.connection, seed.wealth, seed.boards, seed.following, seed.beliefs, false),
  );

  const player = character(
    W2_PLAYER_CHARACTER_ID,
    playerName,
    'founder_ceo',
    W2_COMPANIES.player,
    `Founder and CEO — ${playerCompanyName}`,
    [66, 62, 48, 54, 50],
    24,
    850_000,
    1,
    4_200,
    [
      { topic: 'compute_scarcity', level: 'high' },
      { topic: 'talent_war', level: 'medium' },
    ],
    true,
  );

  return [...founders, ...cast, player];
}

/* -------------------------------------------------------------------------- */
/*  Boards                                                                     */
/* -------------------------------------------------------------------------- */

function director(
  characterId: string,
  seat: Board['directors'][number]['seat'],
  mandate: Board['directors'][number]['mandate'],
  scores: { independence: number; risk: number; growth: number; discipline: number; tech: number; safety: number; ceo: number },
  isChair = false,
  representedHolderId: string | null = null,
): Board['directors'][number] {
  return {
    characterId,
    seat,
    independence: scores.independence,
    riskTolerance: scores.risk,
    growthPreference: scores.growth,
    financialDiscipline: scores.discipline,
    techKnowledge: scores.tech,
    safetyOrientation: scores.safety,
    relationshipWithCeo: scores.ceo,
    mandate,
    votingWeight: 1,
    isChair,
    appointedQuarter: 0,
    representedHolderId,
    committees: seat === 'independent' ? ['audit', 'risk'] : [],
  };
}

/**
 * Four boards are modelled in full: the player's, and the three listed majors a
 * player is most likely to end up fighting over. Every other company's board
 * exists in the fiction but is not simulated, which is what `boardId: null` says.
 */
export const W2_BOARDS: readonly Board[] = [
  {
    id: 'brd_aletheia',
    companyId: W2_COMPANIES.aletheia,
    directors: [
      director(W2_FOUNDERS.aletheia, 'founder', 'founder_vision', { independence: 6, risk: 86, growth: 92, discipline: 31, tech: 94, safety: 46, ceo: 100 }, true),
      director(W2_CHARACTERS.helena, 'investor', 'investor_return', { independence: 21, risk: 58, growth: 74, discipline: 69, tech: 64, safety: 56, ceo: 38 }, false, V2_FUNDS.seawall),
      director(W2_CHARACTERS.stefan, 'investor', 'investor_return', { independence: 24, risk: 46, growth: 61, discipline: 78, tech: 71, safety: 62, ceo: 19 }, false, V2_FUNDS.tessera),
      director(W2_CHARACTERS.paul, 'independent', 'independent_oversight', { independence: 90, risk: 51, growth: 42, discipline: 61, tech: 88, safety: 74, ceo: -8 }),
      director(W2_CHARACTERS.ingrid, 'independent', 'independent_oversight', { independence: 93, risk: 42, growth: 38, discipline: 86, tech: 74, safety: 81, ceo: 4 }),
    ],
    quorumRule: DEFAULT_QUORUM_RULE,
    chairCharacterId: W2_FOUNDERS.aletheia,
    nextMeetingQuarter: 0,
    seatsAuthorised: 5,
  },
  {
    id: 'brd_ironvale',
    companyId: W2_COMPANIES.ironvale,
    directors: [
      director(W2_FOUNDERS.ironvale, 'founder', 'founder_vision', { independence: 12, risk: 64, growth: 86, discipline: 48, tech: 81, safety: 44, ceo: 100 }, true),
      director(W2_CHARACTERS.meilan, 'investor', 'investor_return', { independence: 26, risk: 62, growth: 78, discipline: 58, tech: 68, safety: 41, ceo: 44 }, false, V2_FUNDS.kaido),
      director(W2_CHARACTERS.helena, 'investor', 'investor_return', { independence: 22, risk: 58, growth: 71, discipline: 69, tech: 64, safety: 56, ceo: 26 }, false, V2_FUNDS.seawall),
      director(W2_CHARACTERS.nan, 'independent', 'independent_oversight', { independence: 88, risk: 33, growth: 41, discipline: 94, tech: 56, safety: 58, ceo: 11 }),
    ],
    quorumRule: DEFAULT_QUORUM_RULE,
    chairCharacterId: W2_FOUNDERS.ironvale,
    nextMeetingQuarter: 0,
    seatsAuthorised: 5,
  },
  {
    id: 'brd_qanat',
    companyId: W2_COMPANIES.qanat,
    directors: [
      director(W2_FOUNDERS.qanat, 'founder', 'founder_vision', { independence: 18, risk: 44, growth: 62, discipline: 76, tech: 69, safety: 61, ceo: 100 }, true),
      director(W2_CHARACTERS.tariq, 'investor', 'investor_return', { independence: 14, risk: 41, growth: 58, discipline: 81, tech: 62, safety: 66, ceo: 64 }, false, V2_FUNDS.qadr),
      director(W2_CHARACTERS.nan, 'independent', 'independent_oversight', { independence: 88, risk: 33, growth: 41, discipline: 94, tech: 56, safety: 58, ceo: 22 }),
      director(W2_CHARACTERS.ingrid, 'independent', 'independent_oversight', { independence: 93, risk: 42, growth: 38, discipline: 86, tech: 74, safety: 81, ceo: 16 }),
    ],
    quorumRule: DEFAULT_QUORUM_RULE,
    chairCharacterId: W2_FOUNDERS.qanat,
    nextMeetingQuarter: 0,
    seatsAuthorised: 5,
  },
  {
    id: W2_PLAYER_BOARD_ID,
    companyId: W2_COMPANIES.player,
    directors: [
      director(W2_PLAYER_CHARACTER_ID, 'founder', 'founder_vision', { independence: 8, risk: 66, growth: 88, discipline: 48, tech: 62, safety: 50, ceo: 100 }, true),
      director(W2_CHARACTERS.helena, 'investor', 'investor_return', { independence: 24, risk: 58, growth: 68, discipline: 69, tech: 64, safety: 56, ceo: 46 }, false, V2_FUNDS.seawall),
      director(W2_CHARACTERS.nan, 'independent', 'independent_oversight', { independence: 88, risk: 33, growth: 41, discipline: 94, tech: 56, safety: 58, ceo: 12 }),
      director(W2_CHARACTERS.paul, 'independent', 'independent_oversight', { independence: 90, risk: 51, growth: 42, discipline: 61, tech: 88, safety: 74, ceo: 20 }),
      director(W2_CHARACTERS.ingrid, 'independent', 'independent_oversight', { independence: 93, risk: 42, growth: 38, discipline: 86, tech: 74, safety: 81, ceo: 15 }),
    ],
    quorumRule: DEFAULT_QUORUM_RULE,
    chairCharacterId: W2_PLAYER_CHARACTER_ID,
    nextMeetingQuarter: 0,
    seatsAuthorised: 7,
  },
];

/* -------------------------------------------------------------------------- */
/*  Relationships and memory                                                   */
/* -------------------------------------------------------------------------- */

interface RelationshipRow {
  readonly fromId: string;
  readonly toId: string;
  readonly trust: number;
  readonly respect: number;
  readonly hostility: number;
  readonly dependence: number;
  readonly lastInteractionQuarter: number | null;
  readonly interactionCount: number;
}

/**
 * The edges that already exist when the session opens. Deliberately sparse and
 * asymmetric: a founder's view of an investor and that investor's view of them
 * are different rows, and the player has three edges against everyone else's ten.
 */
export const W2_RELATIONSHIPS: readonly RelationshipRow[] = [
  { fromId: W2_FOUNDERS.aletheia, toId: W2_CHARACTERS.helena, trust: 48, respect: 76, hostility: 31, dependence: 64, lastInteractionQuarter: 0, interactionCount: 38 },
  { fromId: W2_CHARACTERS.helena, toId: W2_FOUNDERS.aletheia, trust: 61, respect: 88, hostility: 14, dependence: 42, lastInteractionQuarter: 0, interactionCount: 38 },
  { fromId: W2_FOUNDERS.aletheia, toId: W2_FOUNDERS.tessellate, trust: 34, respect: 84, hostility: 46, dependence: 91, lastInteractionQuarter: 0, interactionCount: 22 },
  { fromId: W2_FOUNDERS.tessellate, toId: W2_FOUNDERS.aletheia, trust: 41, respect: 68, hostility: 38, dependence: 26, lastInteractionQuarter: 0, interactionCount: 22 },
  { fromId: W2_FOUNDERS.aletheia, toId: W2_FOUNDERS.basalt, trust: 44, respect: 62, hostility: 28, dependence: 78, lastInteractionQuarter: 0, interactionCount: 19 },
  { fromId: W2_FOUNDERS.basalt, toId: W2_CHARACTERS.tariq, trust: 72, respect: 81, hostility: 8, dependence: 66, lastInteractionQuarter: 0, interactionCount: 44 },
  { fromId: W2_FOUNDERS.qanat, toId: W2_CHARACTERS.tariq, trust: 68, respect: 79, hostility: 6, dependence: 71, lastInteractionQuarter: 0, interactionCount: 51 },
  { fromId: W2_FOUNDERS.qanat, toId: W2_FOUNDERS.basalt, trust: 58, respect: 66, hostility: 12, dependence: 34, lastInteractionQuarter: 0, interactionCount: 27 },
  { fromId: W2_FOUNDERS.ironvale, toId: W2_FOUNDERS.tessellate, trust: 51, respect: 79, hostility: 18, dependence: 82, lastInteractionQuarter: 0, interactionCount: 31 },
  { fromId: W2_FOUNDERS.ironvale, toId: W2_FOUNDERS.wrenford, trust: 22, respect: 58, hostility: 64, dependence: 9, lastInteractionQuarter: 0, interactionCount: 6 },
  { fromId: W2_FOUNDERS.wrenford, toId: W2_FOUNDERS.ironvale, trust: 18, respect: 71, hostility: 56, dependence: 21, lastInteractionQuarter: 0, interactionCount: 6 },
  { fromId: W2_FOUNDERS.harbourline, toId: W2_FOUNDERS.overland, trust: 39, respect: 44, hostility: 52, dependence: 11, lastInteractionQuarter: 0, interactionCount: 13 },
  { fromId: W2_FOUNDERS.overland, toId: W2_FOUNDERS.harbourline, trust: 26, respect: 68, hostility: 61, dependence: 47, lastInteractionQuarter: 0, interactionCount: 13 },
  { fromId: W2_FOUNDERS.lumen, toId: W2_CHARACTERS.esther, trust: 31, respect: 62, hostility: 44, dependence: 38, lastInteractionQuarter: 0, interactionCount: 17 },
  { fromId: W2_CHARACTERS.esther, toId: W2_FOUNDERS.lumen, trust: 28, respect: 51, hostility: 36, dependence: 8, lastInteractionQuarter: 0, interactionCount: 17 },
  { fromId: W2_FOUNDERS.sable, toId: W2_CHARACTERS.stefan, trust: 54, respect: 61, hostility: 22, dependence: 74, lastInteractionQuarter: 0, interactionCount: 16 },
  { fromId: W2_FOUNDERS.grimsby, toId: W2_FOUNDERS.qanat, trust: 36, respect: 74, hostility: 41, dependence: 58, lastInteractionQuarter: 0, interactionCount: 8 },
  { fromId: W2_FOUNDERS.copa, toId: W2_FOUNDERS.vasant, trust: 44, respect: 52, hostility: 34, dependence: 12, lastInteractionQuarter: 0, interactionCount: 5 },
  // The player's own edges: one backer, one rival who has not noticed them, one
  // introduction worth cultivating.
  { fromId: W2_PLAYER_CHARACTER_ID, toId: W2_CHARACTERS.helena, trust: 58, respect: 74, hostility: 4, dependence: 71, lastInteractionQuarter: 0, interactionCount: 9 },
  { fromId: W2_CHARACTERS.helena, toId: W2_PLAYER_CHARACTER_ID, trust: 51, respect: 44, hostility: 3, dependence: 6, lastInteractionQuarter: 0, interactionCount: 9 },
  { fromId: W2_PLAYER_CHARACTER_ID, toId: W2_FOUNDERS.aletheia, trust: 18, respect: 82, hostility: 12, dependence: 22, lastInteractionQuarter: null, interactionCount: 0 },
  { fromId: W2_PLAYER_CHARACTER_ID, toId: W2_CHARACTERS.nan, trust: 42, respect: 64, hostility: 2, dependence: 29, lastInteractionQuarter: 0, interactionCount: 4 },
  { fromId: W2_CHARACTERS.nan, toId: W2_PLAYER_CHARACTER_ID, trust: 36, respect: 33, hostility: 5, dependence: 2, lastInteractionQuarter: 0, interactionCount: 4 },
];

interface MemoryRow {
  readonly id: string;
  readonly ownerCharacterId: string;
  readonly aboutId: string;
  readonly quarter: number;
  readonly kind: MemoryKind;
  readonly summary: string;
  readonly sentiment: number;
  readonly decayRate: number;
  readonly strength: number;
}

export const W2_MEMORIES: readonly MemoryRow[] = [
  {
    id: 'mem_aletheia_wafer_allocation',
    ownerCharacterId: W2_FOUNDERS.aletheia,
    aboutId: W2_FOUNDERS.tessellate,
    quarter: 0,
    kind: 'negotiation',
    summary: 'Wei took our wafer allocation to the highest bidder the week after we shook hands on it, and called it discipline.',
    sentiment: -0.58,
    decayRate: 0.02,
    strength: 0.86,
  },
  {
    id: 'mem_wrenford_poach',
    ownerCharacterId: W2_FOUNDERS.wrenford,
    aboutId: W2_FOUNDERS.ironvale,
    quarter: 0,
    kind: 'poach',
    summary: 'Ironvale took four of my manipulation engineers in a fortnight and then filed on the work they did here.',
    sentiment: -0.81,
    decayRate: 0.01,
    strength: 0.93,
  },
  {
    id: 'mem_qanat_basalt_power',
    ownerCharacterId: W2_FOUNDERS.basalt,
    aboutId: W2_FOUNDERS.qanat,
    quarter: 0,
    kind: 'favour',
    summary: 'Dana held a firm supply contract open for two quarters while we were still raising. Nobody else would.',
    sentiment: 0.79,
    decayRate: 0.04,
    strength: 0.88,
  },
  {
    id: 'mem_overland_undercut',
    ownerCharacterId: W2_FOUNDERS.overland,
    aboutId: W2_FOUNDERS.harbourline,
    quarter: 0,
    kind: 'betrayal',
    summary: 'Harbourline priced our two biggest lanes below their own cost for three quarters until the customers moved.',
    sentiment: -0.74,
    decayRate: 0.015,
    strength: 0.9,
  },
  {
    id: 'mem_player_backed',
    ownerCharacterId: W2_PLAYER_CHARACTER_ID,
    aboutId: W2_CHARACTERS.helena,
    quarter: 0,
    kind: 'favour',
    summary: 'Helena wrote the first cheque when nobody else would take the meeting.',
    sentiment: 0.74,
    decayRate: 0.06,
    strength: 0.88,
  },
  // The new partners arrive with history, because a desk with no memory is a
  // function you call rather than somebody you deal with.
  {
    id: 'mem_ellis_wrenford_refusal',
    ownerCharacterId: W2_CHARACTERS.ellis,
    aboutId: W2_FOUNDERS.wrenford,
    quarter: 0,
    kind: 'negotiation',
    summary: 'Clara turned down our approach at a forty per cent premium and told the room she would rather run it badly herself.',
    sentiment: -0.42,
    decayRate: 0.02,
    strength: 0.81,
  },
  {
    id: 'mem_dov_lumen_report',
    ownerCharacterId: W2_CHARACTERS.dov,
    aboutId: W2_FOUNDERS.lumen,
    quarter: 0,
    kind: 'public_attack',
    summary: 'We published on their recall exposure two quarters before it broke, and the stock is still above where we wrote it.',
    sentiment: -0.51,
    decayRate: 0.03,
    strength: 0.77,
  },
  {
    id: 'mem_britt_ironvale_pass',
    ownerCharacterId: W2_CHARACTERS.britt,
    aboutId: W2_FOUNDERS.ironvale,
    quarter: 0,
    kind: 'investment',
    summary: 'I passed on their seed round because the manipulation stack was a demo. It was the most expensive judgement of my career.',
    sentiment: -0.34,
    decayRate: 0.01,
    strength: 0.88,
  },
  {
    id: 'mem_ken_harbourline_lanes',
    ownerCharacterId: W2_CHARACTERS.ken,
    aboutId: W2_FOUNDERS.harbourline,
    quarter: 0,
    kind: 'deal_kept',
    summary: 'They held the freight rate they promised us through two quarters of fuel spikes without asking for a renegotiation.',
    sentiment: 0.62,
    decayRate: 0.05,
    strength: 0.71,
  },
  {
    id: 'mem_nadia_qanat_award',
    ownerCharacterId: W2_CHARACTERS.nadia,
    aboutId: W2_FOUNDERS.qanat,
    quarter: 0,
    kind: 'contract_win',
    summary: 'Their backlog announcement moved the whole energy tape and we were positioned for it three days early. The record was public.',
    sentiment: 0.48,
    decayRate: 0.06,
    strength: 0.64,
  },
  {
    id: 'mem_lumen_media_moment',
    ownerCharacterId: W2_FOUNDERS.lumen,
    aboutId: W2_CHARACTERS.esther,
    quarter: 0,
    kind: 'media_moment',
    summary: 'Esther ran the recall story on the morning of our results and has never once printed the correction.',
    sentiment: -0.66,
    decayRate: 0.03,
    strength: 0.79,
  },
];

/* -------------------------------------------------------------------------- */
/*  Capital entities                                                           */
/* -------------------------------------------------------------------------- */

/**
 * The eleven institutions, in declared order. Order is load-bearing: every tie
 * in the capital desks breaks by this order and then by company id, which is
 * how eleven desks scoring twenty-five companies stays deterministic without
 * touching the RNG at all.
 *
 * Two rules the roster obeys and the tests pin:
 *
 * - **The six incumbents keep their ids and their names.** An entity id IS the
 *   cap-table holder id, so renaming one would rewrite every world-2 register
 *   and every director's `representedHolderId` for the sake of tidiness.
 * - **The five newcomers take no opening holdings.** World 2's registers do not
 *   change by one share, and they arrive as dry powder looking for a home.
 *
 * Vintages are negative because these funds existed before the session did.
 * They are spread across the clock on purpose: Ironwood is two quarters old and
 * hungry, Tessera and Altiplano are already harvesting, and Altiplano reaches
 * the forced band inside the first four years if it distributes nothing — which
 * is a buying window a player can see coming rather than one that is drawn.
 */
interface CapitalEntitySeed {
  readonly id: string;
  readonly name: string;
  readonly kind: CapitalEntityKind;
  readonly region: Region;
  readonly stageBand: readonly [FundingStage, FundingStage];
  readonly thesis: string;
  /** Committed capital in whole dollars. */
  readonly aum: number;
  /** Dry powder as a whole percentage of committed capital. */
  readonly dryPowderPct: number;
  /** Cumulative cash already returned to LPs, as a whole percentage of committed capital. */
  readonly realisedPct: number;
  /** Quarters before quarter zero that the fund was struck. */
  readonly ageQuarters: number;
  readonly exitHorizonQuarters: number;
  readonly riskAppetite: number;
  readonly trackRecord: number;
  /** Appetite per sector, 0..100, in SECTORS order: ai, robotics, manufacturing, energy, logistics, consumer. */
  readonly affinity: readonly [number, number, number, number, number, number];
  readonly partnerCharacterId: string;
}

const GROWTH_ONLY: readonly [FundingStage, FundingStage] = ['growth', 'growth'];

export const V2_CAPITAL_ENTITY_SEEDS: readonly CapitalEntitySeed[] = [
  {
    id: V2_FUNDS.seawall,
    name: 'Seawall Capital',
    kind: 'vc',
    region: 'north_america',
    stageBand: ['series_a', 'growth'],
    thesis: 'The biggest cheque in the game, from series A to growth. We back the company everyone will want in four years, and we take the board seat.',
    aum: 18 * BN,
    dryPowderPct: 55,
    realisedPct: 40,
    ageQuarters: 26,
    exitHorizonQuarters: 20,
    riskAppetite: 72,
    trackRecord: 82,
    affinity: [88, 72, 44, 38, 41, 63],
    partnerCharacterId: W2_CHARACTERS.helena,
  },
  {
    id: V2_FUNDS.indus,
    name: 'Indus Growth',
    kind: 'vc',
    region: 'south_asia',
    stageBand: ['series_c', 'growth'],
    thesis: 'Growth capital for businesses that already sell something. We price on revenue quality, and we have never once paid for a story.',
    aum: 2_400 * M,
    dryPowderPct: 60,
    realisedPct: 15,
    ageQuarters: 14,
    exitHorizonQuarters: 16,
    riskAppetite: 58,
    trackRecord: 61,
    affinity: [74, 46, 52, 44, 61, 70],
    partnerCharacterId: W2_CHARACTERS.asha,
  },
  {
    id: V2_FUNDS.altiplano,
    name: 'Altiplano Capital',
    kind: 'vc',
    region: 'latin_america',
    stageBand: ['seed', 'series_a'],
    thesis: 'Small cheques written early, in companies the crossover funds cannot find yet. Our LPs have been patient for eight years.',
    aum: 900 * M,
    dryPowderPct: 65,
    realisedPct: 30,
    ageQuarters: 34,
    exitHorizonQuarters: 20,
    riskAppetite: 76,
    trackRecord: 54,
    affinity: [66, 41, 48, 57, 62, 74],
    partnerCharacterId: W2_CHARACTERS.ricardo,
  },
  {
    id: V2_FUNDS.ironwood,
    name: 'Ironwood Ventures',
    kind: 'vc',
    region: 'europe',
    stageBand: ['seed', 'series_b'],
    thesis: 'Deep tech in Europe: robotics, and the factories that build them. We are new, we are patient, and the whole fund is still in the bank.',
    aum: 600 * M,
    dryPowderPct: 70,
    realisedPct: 0,
    ageQuarters: 2,
    exitHorizonQuarters: 24,
    riskAppetite: 81,
    trackRecord: 44,
    affinity: [58, 91, 84, 46, 39, 22],
    partnerCharacterId: W2_CHARACTERS.britt,
  },
  {
    id: V2_FUNDS.tessera,
    name: 'Tessera Industrial',
    kind: 'pe',
    region: 'europe',
    stageBand: GROWTH_ONLY,
    thesis: 'We buy control of industrial businesses, put them together, and run them properly. Growth is somebody else\'s word for hope.',
    aum: 9 * BN,
    dryPowderPct: 40,
    realisedPct: 25,
    ageQuarters: 30,
    exitHorizonQuarters: 20,
    riskAppetite: 44,
    trackRecord: 71,
    affinity: [31, 58, 92, 54, 86, 37],
    partnerCharacterId: W2_CHARACTERS.stefan,
  },
  {
    id: V2_FUNDS.grantwood,
    name: 'Grantwood Partners',
    kind: 'pe',
    region: 'north_america',
    stageBand: GROWTH_ONLY,
    thesis: 'Large-cap take-privates. If your shares trade below what your cash flows are worth, that is our opportunity, not your misfortune.',
    aum: 14 * BN,
    dryPowderPct: 45,
    realisedPct: 5,
    ageQuarters: 6,
    exitHorizonQuarters: 18,
    riskAppetite: 52,
    trackRecord: 78,
    affinity: [62, 51, 78, 66, 74, 69],
    partnerCharacterId: W2_CHARACTERS.ellis,
  },
  {
    id: V2_FUNDS.straits,
    name: 'Straits Industrial Partners',
    kind: 'pe',
    region: 'east_asia',
    stageBand: GROWTH_ONLY,
    thesis: 'Mid-market roll-ups across energy and freight. Five good companies in one sector beat one great company in five.',
    aum: 5 * BN,
    dryPowderPct: 50,
    realisedPct: 30,
    ageQuarters: 18,
    exitHorizonQuarters: 20,
    riskAppetite: 49,
    trackRecord: 58,
    affinity: [34, 55, 71, 88, 90, 41],
    partnerCharacterId: W2_CHARACTERS.ken,
  },
  {
    id: V2_FUNDS.kaido,
    name: 'Kaido Partners',
    kind: 'hedge_fund',
    region: 'east_asia',
    stageBand: GROWTH_ONLY,
    thesis: 'We take large minority stakes and then we take the seat. Boards improve when somebody in the room owns ten per cent of it.',
    aum: 6 * BN,
    dryPowderPct: 55,
    realisedPct: 40,
    ageQuarters: 24,
    exitHorizonQuarters: 8,
    riskAppetite: 68,
    trackRecord: 74,
    affinity: [76, 68, 63, 49, 57, 66],
    partnerCharacterId: W2_CHARACTERS.meilan,
  },
  {
    id: V2_FUNDS.coldbrook,
    name: 'Coldbrook Capital',
    kind: 'hedge_fund',
    region: 'north_america',
    stageBand: GROWTH_ONLY,
    thesis: 'Long the businesses that earn it, short the ones that do not, and we publish our reasons for both. Being wrong in public is the cost.',
    aum: 3_200 * M,
    dryPowderPct: 70,
    realisedPct: 20,
    ageQuarters: 10,
    exitHorizonQuarters: 6,
    riskAppetite: 74,
    trackRecord: 66,
    affinity: [84, 62, 47, 41, 44, 71],
    partnerCharacterId: W2_CHARACTERS.dov,
  },
  {
    id: V2_FUNDS.perihelion,
    name: 'Perihelion Capital',
    kind: 'hedge_fund',
    region: 'europe',
    stageBand: GROWTH_ONLY,
    thesis: 'We trade the public record. Every merger, award and remedy is a price somebody else has not finished adjusting to.',
    aum: 2 * BN,
    dryPowderPct: 75,
    realisedPct: 5,
    ageQuarters: 4,
    exitHorizonQuarters: 4,
    riskAppetite: 63,
    trackRecord: 57,
    affinity: [69, 58, 66, 63, 68, 58],
    partnerCharacterId: W2_CHARACTERS.nadia,
  },
  {
    id: V2_FUNDS.qadr,
    name: 'Qadr Sovereign Fund',
    kind: 'sovereign',
    region: 'middle_east',
    stageBand: GROWTH_ONLY,
    thesis: 'Forty years, no leverage, never above a quarter of anything. When everybody else is a forced seller, we are the bid.',
    aum: 40 * BN,
    dryPowderPct: 30,
    realisedPct: 30,
    ageQuarters: 34,
    exitHorizonQuarters: 60,
    riskAppetite: 24,
    trackRecord: 69,
    affinity: [44, 39, 68, 96, 81, 28],
    partnerCharacterId: W2_CHARACTERS.tariq,
  },
];

/**
 * The roster as parsed `CapitalEntity` rows. Every figure is a whole number
 * derived from a constant by a pure function; nothing here reads a clock or a
 * random stream, so the same setup builds a byte-identical roster every time.
 */
export function buildV2CapitalEntities(): CapitalEntity[] {
  return V2_CAPITAL_ENTITY_SEEDS.map((seed) => {
    const aum = Math.round(seed.aum);
    const [ai, robotics, manufacturing, energy, logistics, consumer] = seed.affinity;
    return CapitalEntitySchema.parse({
      id: seed.id,
      name: seed.name,
      kind: seed.kind,
      region: seed.region,
      sectorAffinity: fullSectorAffinity({ ai, robotics, manufacturing, energy, logistics, consumer }),
      stageBand: [seed.stageBand[0], seed.stageBand[1]],
      thesis: seed.thesis,
      committedCapitalUsd: aum,
      dryPowderUsd: dryPowderFromPct(aum, seed.dryPowderPct),
      realisedProceedsUsd: dryPowderFromPct(aum, seed.realisedPct),
      // Negative: the fund was struck before the session opened. This is what
      // gives eleven institutions eleven different positions on the LP clock at
      // quarter zero instead of eleven identical ones.
      vintageQuarter: -seed.ageQuarters,
      exitHorizonQuarters: seed.exitHorizonQuarters,
      riskAppetite: seed.riskAppetite,
      trackRecord: seed.trackRecord,
      partnerCharacterIds: [seed.partnerCharacterId],
    });
  });
}

/* -------------------------------------------------------------------------- */
/*  Social                                                                     */
/* -------------------------------------------------------------------------- */

function account(
  id: string,
  network: SocialAccount['network'],
  handle: string,
  ownerCharacterId: string | null,
  ownerCompanyId: string | null,
  followers: number,
  credibility: number,
): SocialAccount {
  const mix: Record<string, number> =
    network === 'technical_forum'
      ? { developers: 0.62, talent: 0.18, media: 0.1, investors: 0.1 }
      : network === 'finance'
        ? { investors: 0.68, media: 0.18, enterprise: 0.14 }
        : network === 'professional'
          ? { enterprise: 0.52, talent: 0.24, investors: 0.14, media: 0.1 }
          : { consumers: 0.34, developers: 0.22, media: 0.22, investors: 0.12, talent: 0.1 };
  return { id, network, handle, ownerCharacterId, ownerCompanyId, followers, credibility, verified: followers > 10_000, audienceMix: mix, isActive: true };
}

export function buildV2SocialAccounts(playerHandle: string): SocialAccount[] {
  return [
    account('soc_rhea_fastfeed', 'fast_feed', '@rheavaldes', W2_FOUNDERS.aletheia, null, 1_400_000, 0.71),
    account('soc_clara_forum', 'technical_forum', '@wrenlab', W2_FOUNDERS.wrenford, null, 480_000, 0.77),
    account('soc_teresa_fastfeed', 'fast_feed', '@teresanunn', W2_FOUNDERS.lumen, null, 890_000, 0.58),
    account('soc_esther_fastfeed', 'fast_feed', '@estherlim', W2_CHARACTERS.esther, null, 710_000, 0.89),
    account('soc_gabriel_finance', 'finance', '@gabrielross', W2_CHARACTERS.gabriel, null, 520_000, 0.66),
    account('soc_aletheia_corp', 'professional', '@aletheialabs', null, W2_COMPANIES.aletheia, 640_000, 0.68),
    account('soc_qanat_corp', 'professional', '@qanatpower', null, W2_COMPANIES.qanat, 210_000, 0.72),
    account('soc_player_fastfeed', 'fast_feed', playerHandle, W2_PLAYER_CHARACTER_ID, null, 4_200, 0.34),
    account('soc_player_corp', 'professional', '@playerventures', null, W2_COMPANIES.player, 1_100, 0.3),
  ];
}

/** Board seats grant mutual access, exactly as they do in the frozen world. */
export function buildV2AccessOverrides(): {
  id: string;
  kind: 'shared_board';
  fromId: string;
  toId: string;
  grantedQuarter: number;
  expiresQuarter: number | null;
  isPermanent: boolean;
  grantedByCharacterId: string | null;
  reason: string;
}[] {
  return W2_BOARDS.flatMap((board) => {
    const chair = board.chairCharacterId;
    if (chair === null) return [];
    return board.directors
      .filter((seat) => seat.characterId !== chair)
      .flatMap((seat) => [
        {
          id: makeId('ovr', board.id, chair, seat.characterId),
          kind: 'shared_board' as const,
          fromId: chair,
          toId: seat.characterId,
          grantedQuarter: 0,
          expiresQuarter: null,
          isPermanent: true,
          grantedByCharacterId: null,
          reason: 'They sit on the same board.',
        },
        {
          id: makeId('ovr', board.id, seat.characterId, chair),
          kind: 'shared_board' as const,
          fromId: seat.characterId,
          toId: chair,
          grantedQuarter: 0,
          expiresQuarter: null,
          isPermanent: true,
          grantedByCharacterId: null,
          reason: 'They sit on the same board.',
        },
      ]);
  });
}
