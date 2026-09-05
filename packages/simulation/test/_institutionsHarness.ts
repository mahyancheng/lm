/**
 * Test harness for the institutional subsystems: government, boards,
 * relationships and social.
 *
 * Deliberately self-contained: it implements its own `SeededRng` and its own
 * `ResolverContext` rather than importing them from a sibling module, so these
 * suites run against `@frontier/contracts` and the four institutional source
 * directories alone.
 *
 * The fixture mirrors `supabase/seed.sql`: session seed 424242, 2027 Q1, the six
 * seeded companies (Nexus Intelligence NXS, Orbit Dynamics ORB, Helix Systems
 * HLX, VectorWorks AI VWA, Aurora Compute ARC, Meridian Data MRD), fifteen
 * characters including Maya Chen with her seeded traits, the five-member Nexus
 * board, three government agencies and two open procurements.
 *
 * Not a test file itself — the leading underscore keeps it out of the suite glob.
 */

import type {
  Agency,
  BoardProposal,
  Company,
  ProcurementOpportunity,
  ResolutionLineDraft,
  ResolverContext,
  SeededRng,
  SessionState,
  SessionStateInput,
  SimEventDraft,
  StoredGovernmentBid,
  SubmittedAction,
  ActionIntent,
} from '@frontier/contracts';
import { DEFAULT_EVALUATION_WEIGHTS, DEFAULT_QUORUM_RULE, SessionStateSchema } from '@frontier/contracts';

/* -------------------------------------------------------------------------- */
/*  Deterministic RNG                                                          */
/* -------------------------------------------------------------------------- */

function hashString(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

class TestRng implements SeededRng {
  private state: number;

  constructor(private readonly label: string) {
    this.state = hashString(label) || 1;
  }

  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  int(min: number, max: number): number {
    if (max <= min) return min;
    return Math.min(max, min + Math.floor(this.next() * (max - min + 1)));
  }

  pick<T>(arr: readonly T[]): T {
    const first = arr[0];
    if (first === undefined) throw new Error('pick from an empty array');
    return arr[this.int(0, arr.length - 1)] ?? first;
  }

  shuffle<T>(arr: readonly T[]): T[] {
    const out = [...arr];
    for (let i = out.length - 1; i > 0; i -= 1) {
      const j = this.int(0, i);
      const a = out[i];
      const b = out[j];
      if (a === undefined || b === undefined) continue;
      out[i] = b;
      out[j] = a;
    }
    return out;
  }

  fork(label: string): SeededRng {
    return new TestRng(`${this.label}#${label}`);
  }
}

export const makeRng = (seed: string): SeededRng => new TestRng(seed);

/* -------------------------------------------------------------------------- */
/*  Resolver context                                                           */
/* -------------------------------------------------------------------------- */

export interface HarnessContext {
  readonly ctx: ResolverContext;
  readonly events: (SimEventDraft & { eventId: string })[];
  readonly lines: ResolutionLineDraft[];
}

export function makeContext(quarter = 1, seed = '424242'): HarnessContext {
  const events: (SimEventDraft & { eventId: string })[] = [];
  const lines: ResolutionLineDraft[] = [];
  const ctx: ResolverContext = {
    quarter,
    rng: makeRng(`${seed}_q${quarter}`),
    emit(draft: SimEventDraft): string {
      const eventId = `evt_${events.length}`;
      events.push({ ...draft, eventId });
      return eventId;
    },
    log(line: ResolutionLineDraft): void {
      lines.push(line);
    },
  };
  return { ctx, events, lines };
}

/** Every emitted event of one type. */
export const eventsOfType = (h: HarnessContext, type: string): (SimEventDraft & { eventId: string })[] =>
  h.events.filter((e) => e.type === type);

/* -------------------------------------------------------------------------- */
/*  Constants                                                                  */
/* -------------------------------------------------------------------------- */

export const SESSION_ID = 'sess_demo_world';
export const SEED = '424242';
export const START_YEAR = 2027;
export const DEMO_QUARTER = 1;

type CompanyInput = NonNullable<SessionStateInput['companies']>[number];
type CharacterInput = NonNullable<SessionStateInput['characters']>[number];

/* -------------------------------------------------------------------------- */
/*  Companies                                                                  */
/* -------------------------------------------------------------------------- */

export interface CompanySpec {
  readonly id: string;
  readonly name: string;
  readonly ticker: string;
  readonly archetype: Company['archetype'];
  readonly sectorId: string;
  readonly revenueQuarterly: number;
  readonly cash: number;
  readonly ppe: number;
  readonly pastPerformance: number;
  readonly capabilities: Record<string, number>;
  readonly ceoCharacterId: string;
  readonly engineers: number;
  readonly researchers: number;
  readonly ops: number;
  readonly ownedAccelerators: number;
  readonly reservedAccelerators: number;
}

export const DEMO_COMPANY_SPECS: readonly CompanySpec[] = [
  {
    id: 'cmp_nexus',
    name: 'Nexus Intelligence',
    ticker: 'NXS',
    archetype: 'frontier_lab',
    sectorId: 'frontier_models',
    revenueQuarterly: 1_400_000_000,
    cash: 8_100_000_000,
    ppe: 6_400_000_000,
    pastPerformance: 58,
    capabilities: {
      reasoning: 0.82,
      agents: 0.7,
      multimodal: 0.6,
      efficiency: 0.55,
      evaluation: 0.6,
      safety_alignment: 0.55,
      infrastructure: 0.7,
      training_systems: 0.75,
      security: 0.6,
      retrieval: 0.5,
    },
    ceoCharacterId: 'chr_maya_chen',
    engineers: 900,
    researchers: 240,
    ops: 180,
    ownedAccelerators: 40_000,
    reservedAccelerators: 60_000,
  },
  {
    id: 'cmp_orbit',
    name: 'Orbit Dynamics',
    ticker: 'ORB',
    archetype: 'enterprise_ai',
    sectorId: 'enterprise_software',
    revenueQuarterly: 900_000_000,
    cash: 2_400_000_000,
    ppe: 700_000_000,
    pastPerformance: 81,
    capabilities: {
      reasoning: 0.55,
      agents: 0.6,
      multimodal: 0.4,
      efficiency: 0.6,
      evaluation: 0.65,
      safety_alignment: 0.62,
      infrastructure: 0.62,
      training_systems: 0.45,
      security: 0.72,
      retrieval: 0.6,
    },
    ceoCharacterId: 'chr_daniel_okonkwo',
    engineers: 1_400,
    researchers: 120,
    ops: 420,
    ownedAccelerators: 12_000,
    reservedAccelerators: 20_000,
  },
  {
    id: 'cmp_helix',
    name: 'Helix Systems',
    ticker: 'HLX',
    archetype: 'infrastructure',
    sectorId: 'cloud_infrastructure',
    revenueQuarterly: 1_100_000_000,
    cash: 1_200_000_000,
    ppe: 14_000_000_000,
    pastPerformance: 74,
    capabilities: {
      reasoning: 0.35,
      agents: 0.3,
      multimodal: 0.25,
      efficiency: 0.72,
      evaluation: 0.4,
      safety_alignment: 0.4,
      infrastructure: 0.9,
      training_systems: 0.6,
      security: 0.68,
      retrieval: 0.3,
    },
    ceoCharacterId: 'chr_priya_raghavan',
    engineers: 1_100,
    researchers: 60,
    ops: 900,
    ownedAccelerators: 90_000,
    reservedAccelerators: 40_000,
  },
  {
    id: 'cmp_vector',
    name: 'VectorWorks AI',
    ticker: 'VWA',
    archetype: 'enterprise_ai',
    sectorId: 'enterprise_software',
    revenueQuarterly: 180_000_000,
    cash: 640_000_000,
    ppe: 120_000_000,
    pastPerformance: 40,
    capabilities: {
      reasoning: 0.45,
      agents: 0.4,
      multimodal: 0.3,
      efficiency: 0.5,
      evaluation: 0.35,
      safety_alignment: 0.3,
      infrastructure: 0.4,
      training_systems: 0.35,
      security: 0.4,
      retrieval: 0.55,
    },
    ceoCharacterId: 'chr_tomas_lindqvist',
    engineers: 320,
    researchers: 80,
    ops: 90,
    ownedAccelerators: 3_000,
    reservedAccelerators: 4_000,
  },
  {
    id: 'cmp_aurora',
    name: 'Aurora Compute',
    ticker: 'ARC',
    archetype: 'chip_maker',
    sectorId: 'semiconductors',
    revenueQuarterly: 2_600_000_000,
    cash: 3_900_000_000,
    ppe: 9_800_000_000,
    pastPerformance: 62,
    capabilities: {
      reasoning: 0.3,
      agents: 0.25,
      multimodal: 0.2,
      efficiency: 0.8,
      evaluation: 0.35,
      safety_alignment: 0.3,
      infrastructure: 0.85,
      training_systems: 0.5,
      security: 0.6,
      retrieval: 0.2,
      hardware_design: 0.9,
    },
    ceoCharacterId: 'chr_rebecca_aldana',
    engineers: 1_800,
    researchers: 200,
    ops: 700,
    ownedAccelerators: 120_000,
    reservedAccelerators: 0,
  },
  {
    id: 'cmp_meridian',
    name: 'Meridian Data',
    ticker: 'MRD',
    archetype: 'data',
    sectorId: 'data_services',
    revenueQuarterly: 140_000_000,
    cash: 380_000_000,
    ppe: 90_000_000,
    pastPerformance: 45,
    capabilities: {
      reasoning: 0.5,
      agents: 0.35,
      multimodal: 0.45,
      efficiency: 0.55,
      evaluation: 0.7,
      safety_alignment: 0.65,
      infrastructure: 0.4,
      training_systems: 0.4,
      security: 0.5,
      retrieval: 0.75,
      data_curation: 0.85,
    },
    ceoCharacterId: 'chr_kenji_watanabe',
    engineers: 260,
    researchers: 140,
    ops: 110,
    ownedAccelerators: 2_000,
    reservedAccelerators: 3_000,
  },
];

export function makeCompany(spec: CompanySpec): CompanyInput {
  const cogs = spec.revenueQuarterly * 0.4;
  const payroll = spec.revenueQuarterly * 0.3 + 5_000_000;
  return {
    id: spec.id,
    name: spec.name,
    ticker: spec.ticker,
    archetype: spec.archetype,
    tier: 'major',
    isPublic: true,
    controllerPlayerId: spec.id === 'cmp_nexus' ? 'ply_01' : null,
    sectorId: spec.sectorId,
    foundedQuarter: 0,
    headquartersCity: 'Bay Federal District',
    isActive: true,
    products: [
      {
        id: `prd_${spec.id}`,
        name: `${spec.name} Platform`,
        segment: 'enterprise',
        pricePerSeat: 4200,
        activeCustomers: 12_000,
        churnQuarterly: 0.05,
        growthQuarterly: 0.09,
        grossMarginPct: 0.62,
        computeIntensity: 0.5,
        qualityScore: 0.6,
        launchedQuarter: 0,
        isActive: true,
      },
    ],
    employees: {
      engineers: spec.engineers,
      researchers: spec.researchers,
      sales: 300,
      ops: spec.ops,
      execs: 20,
      avgComp: 310_000,
      morale: 68,
      attrition: 0.06,
      openRoles: 40,
    },
    compute: {
      ownedAccelerators: spec.ownedAccelerators,
      reservedAccelerators: spec.reservedAccelerators,
      reservationExpiryQuarter: 9,
      cloudSpendQuarterly: 90_000_000,
      computeUtilisation: 0.78,
      trainingAllocation: 0.55,
    },
    offices: [],
    financials: {
      revenueQuarterly: spec.revenueQuarterly,
      cogs,
      payroll,
      marketing: spec.revenueQuarterly * 0.08,
      rdSpend: spec.revenueQuarterly * 0.25,
      capex: 40_000_000,
      interestExpense: 6_000_000,
      cash: spec.cash,
      debt: 0,
      quarterlyBurn: -30_000_000,
      deferredRevenue: 0,
      backlogUsd: 0,
    },
    balanceSheet: {
      assets: { cash: spec.cash, ppe: spec.ppe, goodwill: 0, investments: 0, receivables: 0 },
      liabilities: { debt: 0, payables: 0, deferredRevenue: 0 },
      equity: spec.cash + spec.ppe,
    },
    posture: 'balanced',
    riskTolerance: 0.6,
    techCapabilities: spec.capabilities,
    governmentPastPerformance: spec.pastPerformance,
    reputation: { public: 60, developer: 58, enterprise: 64, government: 55, investor: 61 },
    boardId: spec.id === 'cmp_nexus' ? 'brd_nexus' : null,
    primarySecurityId: `sec_${spec.id}`,
    instrumentId: `ins_${spec.id}`,
    ceoCharacterId: spec.ceoCharacterId,
    parentCompanyId: null,
  };
}

/* -------------------------------------------------------------------------- */
/*  Characters                                                                 */
/* -------------------------------------------------------------------------- */

interface CharacterSpec {
  readonly id: string;
  readonly name: string;
  readonly role: CharacterInput['role'];
  readonly companyId: string | null;
  readonly title: string;
  readonly traits: [number, number, number, number, number];
  readonly connectionLevel: number;
  readonly wealth: number;
  readonly boardSeatCount: number;
  readonly following: number;
}

const CHARACTER_SPECS: readonly CharacterSpec[] = [
  { id: 'chr_maya_chen', name: 'Maya Chen', role: 'founder_ceo', companyId: 'cmp_nexus', title: 'CEO — Nexus Intelligence', traits: [89, 96, 27, 83, 66], connectionLevel: 86, wealth: 4_100_000_000, boardSeatCount: 2, following: 1_900_000 },
  { id: 'chr_daniel_okonkwo', name: 'Daniel Okonkwo', role: 'founder_ceo', companyId: 'cmp_orbit', title: 'CEO — Orbit Dynamics', traits: [48, 61, 66, 44, 39], connectionLevel: 74, wealth: 890_000_000, boardSeatCount: 1, following: 340_000 },
  { id: 'chr_priya_raghavan', name: 'Priya Raghavan', role: 'founder_ceo', companyId: 'cmp_helix', title: 'CEO — Helix Systems', traits: [62, 71, 58, 57, 41], connectionLevel: 79, wealth: 1_250_000_000, boardSeatCount: 1, following: 210_000 },
  { id: 'chr_tomas_lindqvist', name: 'Tomas Lindqvist', role: 'founder_ceo', companyId: 'cmp_vector', title: 'CEO — VectorWorks AI', traits: [55, 88, 41, 32, 48], connectionLevel: 51, wealth: 96_000_000, boardSeatCount: 0, following: 74_000 },
  { id: 'chr_rebecca_aldana', name: 'Rebecca Aldana', role: 'founder_ceo', companyId: 'cmp_aurora', title: 'CEO — Aurora Compute', traits: [71, 74, 52, 69, 58], connectionLevel: 84, wealth: 2_600_000_000, boardSeatCount: 2, following: 520_000 },
  { id: 'chr_kenji_watanabe', name: 'Kenji Watanabe', role: 'founder_ceo', companyId: 'cmp_meridian', title: 'CEO — Meridian Data', traits: [44, 92, 63, 29, 35], connectionLevel: 62, wealth: 210_000_000, boardSeatCount: 0, following: 430_000 },
  { id: 'chr_eleanor_vance', name: 'Eleanor Vance', role: 'investor', companyId: null, title: 'Managing Partner — Lattice Ventures', traits: [57, 62, 74, 51, 63], connectionLevel: 88, wealth: 780_000_000, boardSeatCount: 4, following: 96_000 },
  { id: 'chr_marcus_feld', name: 'Marcus Feld', role: 'investor', companyId: null, title: 'Partner — Halberd Growth Partners', traits: [71, 41, 33, 66, 55], connectionLevel: 76, wealth: 410_000_000, boardSeatCount: 4, following: 41_000 },
  { id: 'chr_nadia_okafor', name: 'Nadia Okafor', role: 'investor', companyId: null, title: 'CIO — Al-Bahr Sovereign Fund', traits: [46, 55, 81, 38, 44], connectionLevel: 93, wealth: 120_000_000, boardSeatCount: 1, following: 12_000 },
  { id: 'chr_sarah_zhou', name: 'Sarah Zhou', role: 'director', companyId: null, title: 'Independent Director', traits: [36, 61, 84, 42, 51], connectionLevel: 69, wealth: 145_000_000, boardSeatCount: 2, following: 33_000 },
  { id: 'chr_idris_bello', name: 'Idris Bello', role: 'director', companyId: null, title: 'Independent Director', traits: [44, 95, 55, 27, 38], connectionLevel: 64, wealth: 12_000_000, boardSeatCount: 1, following: 61_000 },
  { id: 'chr_grace_halloran', name: 'Grace Halloran', role: 'director', companyId: null, title: 'Independent Director', traits: [33, 48, 88, 51, 57], connectionLevel: 71, wealth: 88_000_000, boardSeatCount: 3, following: 18_000 },
  { id: 'chr_ana_ruiz', name: 'Ana Ruiz', role: 'regulator', companyId: null, title: 'Director — Federal AI Oversight Bureau', traits: [29, 68, 72, 45, 49], connectionLevel: 70, wealth: 2_400_000, boardSeatCount: 0, following: 27_000 },
  { id: 'chr_leo_park', name: 'Leo Park', role: 'journalist', companyId: null, title: 'Senior Correspondent', traits: [52, 57, 44, 61, 66], connectionLevel: 58, wealth: 1_100_000, boardSeatCount: 0, following: 380_000 },
  { id: 'chr_hana_kim', name: 'Hana Kim', role: 'journalist', companyId: null, title: 'Investigations Editor', traits: [48, 63, 47, 72, 59], connectionLevel: 55, wealth: 900_000, boardSeatCount: 0, following: 240_000 },
];

function makeCharacter(spec: CharacterSpec): CharacterInput {
  const [riskTolerance, technicalOrientation, financialConservatism, aggressiveness, statusSensitivity] = spec.traits;
  return {
    id: spec.id,
    name: spec.name,
    role: spec.role,
    companyId: spec.companyId,
    title: spec.title,
    stableTraits: { riskTolerance, technicalOrientation, financialConservatism, aggressiveness, statusSensitivity },
    beliefs: [],
    connectionLevel: spec.connectionLevel,
    isPlayer: spec.id === 'chr_maya_chen',
    personalWealthUsd: spec.wealth,
    boardSeatCount: spec.boardSeatCount,
    publicFollowing: spec.following,
    isActive: true,
  };
}

/* -------------------------------------------------------------------------- */
/*  Board, agencies, procurement                                               */
/* -------------------------------------------------------------------------- */

function nexusBoard(): NonNullable<SessionStateInput['boards']>[number] {
  return {
    id: 'brd_nexus',
    companyId: 'cmp_nexus',
    chairCharacterId: 'chr_maya_chen',
    nextMeetingQuarter: DEMO_QUARTER,
    seatsAuthorised: 5,
    quorumRule: { ...DEFAULT_QUORUM_RULE },
    directors: [
      {
        characterId: 'chr_maya_chen',
        seat: 'founder',
        independence: 5,
        riskTolerance: 89,
        growthPreference: 94,
        financialDiscipline: 27,
        techKnowledge: 96,
        safetyOrientation: 44,
        relationshipWithCeo: 100,
        mandate: 'founder_vision',
        votingWeight: 1,
        isChair: true,
        appointedQuarter: 0,
        representedHolderId: 'ply_01',
        committees: [],
      },
      {
        characterId: 'chr_eleanor_vance',
        seat: 'investor',
        independence: 22,
        riskTolerance: 57,
        growthPreference: 71,
        financialDiscipline: 74,
        techKnowledge: 62,
        safetyOrientation: 58,
        relationshipWithCeo: 40,
        mandate: 'investor_return',
        votingWeight: 1,
        isChair: false,
        appointedQuarter: 0,
        representedHolderId: 'inv_lattice',
        committees: ['compensation', 'nominating'],
      },
      {
        characterId: 'chr_marcus_feld',
        seat: 'investor',
        independence: 18,
        riskTolerance: 71,
        growthPreference: 83,
        financialDiscipline: 33,
        techKnowledge: 41,
        safetyOrientation: 24,
        relationshipWithCeo: 25,
        mandate: 'investor_return',
        votingWeight: 1,
        isChair: false,
        appointedQuarter: 0,
        representedHolderId: 'inv_halberd',
        committees: ['audit'],
      },
      {
        characterId: 'chr_idris_bello',
        seat: 'independent',
        independence: 92,
        riskTolerance: 44,
        growthPreference: 38,
        financialDiscipline: 55,
        techKnowledge: 95,
        safetyOrientation: 79,
        relationshipWithCeo: -10,
        mandate: 'public_interest',
        votingWeight: 1,
        isChair: false,
        appointedQuarter: 0,
        representedHolderId: null,
        committees: ['safety', 'risk'],
      },
      {
        characterId: 'chr_sarah_zhou',
        seat: 'independent',
        independence: 88,
        riskTolerance: 36,
        growthPreference: 46,
        financialDiscipline: 84,
        techKnowledge: 61,
        safetyOrientation: 52,
        relationshipWithCeo: 5,
        mandate: 'independent_oversight',
        votingWeight: 1,
        isChair: false,
        appointedQuarter: 0,
        representedHolderId: null,
        committees: ['audit', 'risk'],
      },
    ],
  };
}

export const DEMO_AGENCIES: readonly Agency[] = [
  {
    id: 'agy_defence',
    name: 'United Federation Department of Defence',
    shortName: 'UFDOD',
    jurisdiction: 'defence',
    mission: 'Sovereign capability, secure autonomy and assured access to frontier systems.',
    budgetQuarterlyUsd: 61_000_000_000,
    priorities: ['national_security', 'domestic_industry', 'data_sovereignty', 'speed_of_delivery'],
    contactCharacterIds: ['chr_ana_ruiz'],
    clearanceAuthority: true,
  },
  {
    id: 'agy_modernisation',
    name: 'Bureau of Digital Modernisation',
    shortName: 'UFBDM',
    jurisdiction: 'federal_civil',
    mission: 'Replace legacy citizen-service systems without losing public trust.',
    budgetQuarterlyUsd: 9_400_000_000,
    priorities: ['cost_efficiency', 'vendor_diversity', 'workforce_modernisation'],
    contactCharacterIds: ['chr_ana_ruiz'],
    clearanceAuthority: false,
  },
  {
    id: 'agy_oversight',
    name: 'Federal AI Oversight Bureau',
    shortName: 'FAIOB',
    jurisdiction: 'federal_civil',
    mission: 'Supervise frontier model deployment, incident reporting and concentration risk.',
    budgetQuarterlyUsd: 240_000_000,
    priorities: ['responsible_ai', 'cost_efficiency'],
    contactCharacterIds: ['chr_ana_ruiz'],
    clearanceAuthority: false,
  },
];

/** The $2.4bn sovereign platform from the seed, as a hand-built fixture. */
export function sovereignOpportunity(overrides: Partial<ProcurementOpportunity> = {}): ProcurementOpportunity {
  return {
    id: 'opp_sovereign_platform',
    agencyId: 'agy_defence',
    programme: 'Sovereign Intelligence Platform',
    description: 'A sovereign-controlled reasoning and analysis platform operated entirely on domestic infrastructure.',
    maxValue: 2_400_000_000,
    contractForm: 'cost_plus',
    durationQuarters: 20,
    evaluationWeights: { ...DEFAULT_EVALUATION_WEIGHTS },
    requirements: {
      clearanceLevel: 'level_iv',
      domesticInference: true,
      modelAudit: true,
      uptimePct: 99.99,
      dataSovereignty: true,
      minimumPastPerformance: 55,
    },
    openQuarter: 0,
    closeQuarter: 1,
    visibility: 'public',
    invitedCompanyIds: [],
    allowsConsortium: true,
    status: 'open',
    ...overrides,
  };
}

/** The civil modernisation programme from the seed. */
export function civilOpportunity(overrides: Partial<ProcurementOpportunity> = {}): ProcurementOpportunity {
  return {
    id: 'opp_civic_modernisation',
    agencyId: 'agy_modernisation',
    programme: 'National Civic Services Modernisation',
    description: 'Replace the legacy citizen benefits and licensing stack with an assisted-service platform.',
    maxValue: 780_000_000,
    contractForm: 'fixed_price',
    durationQuarters: 12,
    evaluationWeights: {
      technical: 0.25,
      security: 0.1,
      pastPerformance: 0.2,
      priceRealism: 0.3,
      schedule: 0.1,
      domesticSupply: 0.03,
      responsibleAi: 0.02,
    },
    requirements: {
      clearanceLevel: 'level_ii',
      domesticInference: false,
      modelAudit: false,
      uptimePct: 99.9,
      dataSovereignty: false,
      minimumPastPerformance: 40,
    },
    openQuarter: 0,
    closeQuarter: 1,
    visibility: 'public',
    invitedCompanyIds: [],
    allowsConsortium: true,
    status: 'open',
    ...overrides,
  };
}

/** A complete, requirement-satisfying bid, so a test only states what it cares about. */
export function makeBid(overrides: Partial<StoredGovernmentBid> & { id: string; bidderCompanyId: string }): StoredGovernmentBid {
  return {
    opportunityId: 'opp_sovereign_platform',
    price: 2_000_000_000,
    technicalScoreInputs: {
      modelCapability: 0.75,
      architectureQuality: 0.7,
      securityPosture: 0.7,
      reliabilityCommitment: 0.8,
      responsibleAiCommitment: 0.6,
    },
    computeCommitment: { acceleratorUnits: 1_800, quarters: 20 },
    staffCommitment: { engineers: 420, researchers: 180, clearedStaff: 120 },
    timeline: { deliveryQuarters: 14, milestoneCount: 5 },
    subcontractors: [],
    ipConcessions: 'government_use_rights',
    auditRights: 'annual',
    domesticSourcingPct: 0.9,
    consortiumMemberIds: [],
    narrative: 'A sovereign platform delivered on domestic infrastructure.',
    submittedQuarter: 1,
    status: 'submitted',
    disqualificationReason: null,
    ...overrides,
  };
}

/** A tabled board proposal with sensible defaults. */
export function makeProposal(overrides: Partial<BoardProposal> & { id: string; kind: BoardProposal['kind'] }): BoardProposal {
  return {
    companyId: 'cmp_nexus',
    boardId: 'brd_nexus',
    title: 'A matter for the board',
    summary: 'The case, including the numbers directors will argue about.',
    proposedByCharacterId: 'chr_maya_chen',
    quarterProposed: DEMO_QUARTER,
    decisionQuarter: DEMO_QUARTER,
    status: 'tabled',
    amountUsd: null,
    dilutionPct: null,
    stockComponentPct: null,
    targetCompanyId: null,
    linkedActionId: null,
    requiredThresholdFraction: 0.5,
    ...overrides,
  };
}

/** A submitted action wrapper, so tests can queue intents cheaply. */
export function makeAction(
  intent: ActionIntent,
  overrides: Partial<SubmittedAction> = {},
): SubmittedAction {
  return {
    actionId: `act_${intent.type}_${overrides.sequence ?? 0}`,
    sessionId: SESSION_ID,
    quarter: DEMO_QUARTER,
    sequence: 0,
    actorPlayerId: 'ply_01',
    actorCompanyId: 'cmp_nexus',
    actorCharacterId: 'chr_maya_chen',
    origin: 'player_ui',
    confirmedByHuman: true,
    intent,
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/*  World                                                                      */
/* -------------------------------------------------------------------------- */

export function demoWorld(): SessionStateInput['world'] {
  return {
    macro: { gdpGrowth: 0.024, inflation: 0.031, policyRate: 0.0425, unemployment: 0.042, creditSpreads: 0.017, fxVolatility: 0.28, consumerDemand: 0.55 },
    capitalMarkets: { riskAppetite: 0.52, ipoWindow: 0.48, ventureLiquidity: 0.61, sectorMultiples: 1.22, volatility: 0.31, debtAvailability: 0.64 },
    compute: { acceleratorSupply: 0.61, cloudCapacity: 0.58, spotPrice: 1.24, reservedPrice: 1.06, fabCapacity: 0.52, energyDemand: 0.49 },
    energy: { electricityPrice: 1.12, datacentreAccess: 0.47, renewableCapacity: 0.41, gridConstraint: 0.44 },
    aiFrontier: { frontierCapability: 0.58, inferenceCost: 0.86, trainingEfficiency: 0.44, openSourceGap: 0.37, benchmarkSaturation: 0.62 },
    talent: { researcherSupply: 0.38, engineerSupply: 0.52, salaryPressure: 1.28, immigrationAccess: 0.51 },
    dataDomain: { dataAvailability: 0.49, licensingCost: 1.31, privacyRestriction: 0.42, syntheticDataMaturity: 0.36 },
    society: { aiTrust: 0.46, automationAnxiety: 0.57, consumerSentiment: 0.51, developerSentiment: 0.62 },
    regulation: { modelRules: 0.34, privacy: 0.41, antitrust: 0.29, copyright: 0.38, safetyObligations: 0.36, exportControls: 0.44 },
    government: { procurementBudget: 0.55, defenceUrgency: 0.48, digitalModernisation: 0.52, grantFunding: 0.44 },
    geopolitics: { tradeFriction: 0.39, conflictRisk: 0.31, sanctions: 0.28, techCompetition: 0.47 },
    media: { attentionLevel: 0.58, institutionalTrust: 0.44, controversyIntensity: 0.36, dominantNarrative: 'ai_optimism' },
  };
}

const SECTORS: readonly { id: string; sentiment: number; multiple: number; demand: number; volatility: number }[] = [
  { id: 'semiconductors', sentiment: 0.24, multiple: 1.35, demand: 0.72, volatility: 0.38 },
  { id: 'cloud_infrastructure', sentiment: 0.12, multiple: 1.18, demand: 0.66, volatility: 0.26 },
  { id: 'frontier_models', sentiment: 0.31, multiple: 1.62, demand: 0.61, volatility: 0.44 },
  { id: 'enterprise_software', sentiment: 0.04, multiple: 1.05, demand: 0.58, volatility: 0.22 },
  { id: 'consumer_ai', sentiment: -0.08, multiple: 0.92, demand: 0.49, volatility: 0.31 },
  { id: 'data_services', sentiment: 0.06, multiple: 1.1, demand: 0.54, volatility: 0.24 },
  { id: 'defence_tech', sentiment: 0.18, multiple: 1.22, demand: 0.63, volatility: 0.27 },
  { id: 'energy_infrastructure', sentiment: 0.09, multiple: 1.04, demand: 0.6, volatility: 0.19 },
];

const SHARES: Record<string, number> = {
  cmp_nexus: 620_000_000,
  cmp_orbit: 540_000_000,
  cmp_helix: 410_000_000,
  cmp_vector: 300_000_000,
  cmp_aurora: 780_000_000,
  cmp_meridian: 260_000_000,
};

const ENTERPRISE_VALUE: Record<string, number> = {
  cmp_nexus: 51_584_000_000,
  cmp_orbit: 22_528_800_000,
  cmp_helix: 23_513_500_000,
  cmp_vector: 5_673_000_000,
  cmp_aurora: 100_932_000_000,
  cmp_meridian: 6_799_000_000,
};

/* -------------------------------------------------------------------------- */
/*  The fixture                                                                */
/* -------------------------------------------------------------------------- */

export function demoSessionInput(): SessionStateInput {
  const sectors: NonNullable<SessionStateInput['sectors']> = {};
  for (const sector of SECTORS) {
    sectors[sector.id] = { sectorId: sector.id as never, sentiment: sector.sentiment, multiple: sector.multiple, demand: sector.demand, volatility: sector.volatility };
  }

  return {
    sessionId: SESSION_ID,
    seed: SEED,
    quarter: DEMO_QUARTER,
    startYear: START_YEAR,
    status: 'active',
    config: {
      playerCount: 1,
      difficulty: 'standard',
      majorRivalCount: 6,
      significantCompanyCount: 24,
      backgroundCompanyCount: 180,
      scenarioId: 'demo_world_2027',
      startYear: START_YEAR,
      quarterLimit: null,
      enableReferenceMarket: false,
      allowPlayerInnovation: true,
      autoExecuteRoutineDefault: false,
    },
    world: demoWorld(),
    sectors,
    eventHazards: {},
    companies: DEMO_COMPANY_SPECS.map(makeCompany),
    companyMetrics: DEMO_COMPANY_SPECS.map((spec) => ({
      companyId: spec.id,
      quarter: DEMO_QUARTER,
      revenueTtm: spec.revenueQuarterly * 4,
      revenueGrowthYoY: 0.22,
      grossMarginPct: 0.6,
      operatingMarginPct: 0.08,
      headcount: spec.engineers + spec.researchers + spec.ops + 320,
      runwayQuarters: 14,
      enterpriseValueUsd: ENTERPRISE_VALUE[spec.id] ?? 1_000_000_000,
      marketCapUsd: ENTERPRISE_VALUE[spec.id] ?? 1_000_000_000,
      computeCostShare: 0.41,
      governmentRevenueShare: 0.12,
    })),
    capTables: DEMO_COMPANY_SPECS.map((spec) => {
      const issued = SHARES[spec.id] ?? 100_000_000;
      const playerShares = spec.id === 'cmp_nexus' ? Math.round(issued * 0.24) : 0;
      return {
        companyId: spec.id,
        shareClasses: [
          {
            id: `shc_${spec.id}`,
            companyId: spec.id,
            kind: 'common' as const,
            label: 'Common',
            votesPerShare: 1,
            liquidationPreferenceMultiple: 0,
            participating: false,
            authorisedShares: issued * 2,
            issuedShares: issued,
            createdQuarter: 0,
          },
        ],
        holdings:
          playerShares > 0
            ? [
                {
                  id: `hld_${spec.id}_player`,
                  holderId: 'ply_01',
                  holderKind: 'player' as const,
                  securityId: `sec_${spec.id}`,
                  shares: playerShares,
                  costBasisUsd: 100_000_000,
                  acquiredQuarter: 0,
                  lockupUntilQuarter: null,
                  isDisclosed: true,
                },
                {
                  id: `hld_${spec.id}_lattice`,
                  holderId: 'inv_lattice',
                  holderKind: 'fund' as const,
                  securityId: `sec_${spec.id}`,
                  shares: Math.round(issued * 0.18),
                  costBasisUsd: 60_000_000,
                  acquiredQuarter: 0,
                  lockupUntilQuarter: null,
                  isDisclosed: true,
                },
                {
                  id: `hld_${spec.id}_float`,
                  holderId: 'public_float',
                  holderKind: 'public_float' as const,
                  securityId: `sec_${spec.id}`,
                  shares: issued - playerShares - Math.round(issued * 0.18),
                  costBasisUsd: 0,
                  acquiredQuarter: 0,
                  lockupUntilQuarter: null,
                  isDisclosed: true,
                },
              ]
            : [
                {
                  id: `hld_${spec.id}_float`,
                  holderId: 'public_float',
                  holderKind: 'public_float' as const,
                  securityId: `sec_${spec.id}`,
                  shares: issued,
                  costBasisUsd: 0,
                  acquiredQuarter: 0,
                  lockupUntilQuarter: null,
                  isDisclosed: true,
                },
              ],
        totalIssuedByClass: { [`shc_${spec.id}`]: issued },
        fullyDilutedShares: issued,
        optionPoolShares: 0,
        lastUpdatedQuarter: DEMO_QUARTER,
      };
    }),
    securities: DEMO_COMPANY_SPECS.map((spec) => ({
      id: `sec_${spec.id}`,
      companyId: spec.id,
      shareClassId: `shc_${spec.id}`,
      symbol: spec.ticker,
      isTradable: true,
      instrumentId: `ins_${spec.id}`,
      parValueUsd: 0.001,
    })),
    techGraph: { version: 1, sessionId: SESSION_ID, nodes: [], edges: [], updatedQuarter: DEMO_QUARTER },
    characters: CHARACTER_SPECS.map(makeCharacter),
    relationships: [
      { fromId: 'chr_eleanor_vance', toId: 'chr_maya_chen', trust: 62, respect: 74, hostility: 12, dependence: 34, lastInteractionQuarter: 0, interactionCount: 9 },
      { fromId: 'chr_maya_chen', toId: 'chr_eleanor_vance', trust: 55, respect: 68, hostility: 18, dependence: 46, lastInteractionQuarter: 0, interactionCount: 9 },
      { fromId: 'chr_maya_chen', toId: 'chr_daniel_okonkwo', trust: 41, respect: 52, hostility: 24, dependence: 8, lastInteractionQuarter: 0, interactionCount: 3 },
      { fromId: 'chr_daniel_okonkwo', toId: 'chr_maya_chen', trust: 38, respect: 66, hostility: 30, dependence: 11, lastInteractionQuarter: 0, interactionCount: 3 },
      { fromId: 'chr_sarah_zhou', toId: 'chr_maya_chen', trust: 48, respect: 61, hostility: 14, dependence: 6, lastInteractionQuarter: 0, interactionCount: 5 },
      { fromId: 'chr_tomas_lindqvist', toId: 'chr_eleanor_vance', trust: 44, respect: 70, hostility: 4, dependence: 22, lastInteractionQuarter: 0, interactionCount: 2 },
      { fromId: 'chr_eleanor_vance', toId: 'chr_tomas_lindqvist', trust: 58, respect: 57, hostility: 5, dependence: 9, lastInteractionQuarter: 0, interactionCount: 2 },
      { fromId: 'chr_eleanor_vance', toId: 'chr_nadia_okafor', trust: 66, respect: 78, hostility: 3, dependence: 41, lastInteractionQuarter: 0, interactionCount: 7 },
      { fromId: 'chr_nadia_okafor', toId: 'chr_eleanor_vance', trust: 63, respect: 71, hostility: 2, dependence: 12, lastInteractionQuarter: 0, interactionCount: 7 },
    ],
    boards: [nexusBoard()],
    agencies: DEMO_AGENCIES.map((a) => ({ ...a, priorities: [...a.priorities], contactCharacterIds: [...a.contactCharacterIds] })),
    procurementOpportunities: [sovereignOpportunity(), civilOpportunity()],
    contractorReputations: [
      { companyId: 'cmp_nexus', agencyId: null, pastPerformanceScore: 58, onTimeDeliveryPct: 0.72, costOverrunPct: 0.19, securityIncidents: 2, contractsWon: 3, contractsLost: 4, terminationsForDefault: 0, lastUpdatedQuarter: DEMO_QUARTER },
      { companyId: 'cmp_orbit', agencyId: null, pastPerformanceScore: 81, onTimeDeliveryPct: 0.94, costOverrunPct: 0.04, securityIncidents: 0, contractsWon: 7, contractsLost: 2, terminationsForDefault: 0, lastUpdatedQuarter: DEMO_QUARTER },
      { companyId: 'cmp_helix', agencyId: null, pastPerformanceScore: 74, onTimeDeliveryPct: 0.89, costOverrunPct: 0.07, securityIncidents: 1, contractsWon: 5, contractsLost: 3, terminationsForDefault: 0, lastUpdatedQuarter: DEMO_QUARTER },
    ],
    socialAccounts: [
      {
        id: 'soc_maya_fastfeed',
        network: 'fast_feed',
        handle: '@maya_chen',
        ownerCharacterId: 'chr_maya_chen',
        ownerCompanyId: 'cmp_nexus',
        followers: 1_900_000,
        credibility: 0.72,
        verified: true,
        audienceMix: { developers: 0.18, enterprise: 0.08, consumers: 0.24, investors: 0.18, regulators: 0.04, media: 0.16, talent: 0.12 },
        isActive: true,
      },
      {
        id: 'soc_tomas_fastfeed',
        network: 'fast_feed',
        handle: '@tlindqvist',
        ownerCharacterId: 'chr_tomas_lindqvist',
        ownerCompanyId: 'cmp_vector',
        followers: 74_000,
        credibility: 0.38,
        verified: false,
        audienceMix: { developers: 0.3, enterprise: 0.1, consumers: 0.14, investors: 0.12, regulators: 0.04, media: 0.1, talent: 0.2 },
        isActive: true,
      },
    ],
    players: [
      {
        playerId: 'ply_01',
        characterId: 'chr_maya_chen',
        companyId: 'cmp_nexus',
        isHuman: true,
        displayName: 'Maya Chen',
        joinedQuarter: 0,
        autoExecuteRoutine: false,
        hasSubmittedThisQuarter: true,
        isActive: true,
      },
    ],
  };
}

/** Parse a fixture into canonical state, applying every schema default. */
export function makeState(overrides: Partial<SessionStateInput> = {}): SessionState {
  return SessionStateSchema.parse({ ...demoSessionInput(), ...overrides });
}

/** A deep structural clone, for "same input twice" determinism assertions. */
export function cloneState(state: SessionState): SessionState {
  return JSON.parse(JSON.stringify(state)) as SessionState;
}

/** Convenience accessor that throws rather than returning undefined. */
export function companyOf(state: SessionState, id: string): Company {
  const company = state.companies.find((c) => c.id === id);
  if (company === undefined) throw new Error(`no company ${id}`);
  return company;
}
