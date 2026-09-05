/**
 * @frontier/simulation — scenario/world2
 *
 * The world-version-2 world: **2027 Q1**, six sectors, six regions,
 * twenty-four rival companies and the founder the player is.
 *
 * Where world 1 was one industry seen from inside a single laboratory, this is
 * an economy. Energy prices reach the frontier through datacentre load;
 * manufacturing yield reaches robotics through the parts it is built from;
 * logistics carries the demand that consumer and manufacturing generate. A
 * company's region sets what its engineers and its electricity cost, and its
 * sector sets the margin band and the multiple its shares are struck against.
 *
 * ## Determinism
 *
 * Every number below is a constant or is derived from one by a pure function.
 * The seed enters through `SessionState.seed` and the session id, exactly as it
 * does in the frozen world, so the same seed and the same setup produce a
 * byte-identical opening state.
 *
 * ## Quarter zero
 *
 * `quarter` is 0 and `lastResolvedQuarter` is null: no snapshot exists yet, and
 * the resolver writes the first one.
 */

import type { NewGameSetup, SessionState, SessionStateInput } from '@frontier/contracts';
import { NewGameSetupSchema, SessionStateSchema, makeId } from '@frontier/contracts';
import type { WorldVersion } from '@frontier/contracts';

/**
 * World 2 pins its own version rather than reading `CURRENT_WORLD_VERSION`.
 * When world 3 became what a new game is created at, a session built here would
 * otherwise have started declaring itself world 3 and taken world-3 branches it
 * was never built for — and its pinned opening hash would have moved.
 */
const WORLD_2_VERSION: WorldVersion = 2;
import { DEMO_PLAYER_ID } from '../demo';
import {
  INS,
  OPENING_MULTIPLE_INDEX,
  OPENING_SECTOR_MULTIPLES,
  SEC,
  SHC,
  V2_COMPANY_SEEDS,
  W2_COMPANIES,
  buildV2Anchor,
  buildV2CapTable,
  buildV2Company,
  buildV2Instrument,
  buildV2Metrics,
  buildV2Quote,
  deriveCompany,
} from './seeds';
import type { V2CompanySeed } from './seeds';
import { W2_PLAYER_CHARACTER_ID, playerSeedFor } from './player';
import {
  W2_BOARDS,
  W2_CHARACTERS,
  W2_MEMORIES,
  W2_RELATIONSHIPS,
  buildV2AccessOverrides,
  buildV2CapitalEntities,
  buildV2Characters,
  buildV2SocialAccounts,
} from './people';
import { W2_EDGES, W2_NODES, W2_RESEARCH_PROJECTS, W2_TRACKS } from './frontier';
import { W2_AGENCIES, buildV2Opportunities } from './government';

export * from './seeds';
export * from './player';
export * from './people';
export * from './frontier';
export * from './government';

const M = 1_000_000;

/** The seed the world-2 demo opens on, matching the frozen world's. */
export const W2_SEED = 424242;

/**
 * What a new game defaults to when the chat has established nothing: an
 * enterprise AI company in North America, which is the shape world 1 opened on.
 */
export const W2_DEFAULT_SETUP: NewGameSetup = NewGameSetupSchema.parse({
  companyName: 'Player Ventures',
  founderName: 'Avery Sinclair',
  backgroundId: 'enterprise_ai',
  sector: 'ai',
  region: 'north_america',
  worldVersion: WORLD_2_VERSION,
});

/**
 * The quarter the tape arrived on. Constants, not draws: this is what the last
 * quarter did before the player opened the screen, and it is the same on every
 * machine.
 */
const OPENING_RETURNS: Readonly<Record<string, number>> = {
  aletheia: 0.0714,
  basalt: 0.0231,
  ironvale: 0.0468,
  sentinel: -0.0192,
  tessellate: 0.0836,
  qanat: 0.0117,
  harbourline: -0.0344,
  lumen: -0.0621,
};

/* -------------------------------------------------------------------------- */
/*  Assembly                                                                   */
/* -------------------------------------------------------------------------- */

/** The world-2 session, parsed and ready for the resolver. */
export function createWorld2Session(seed: number = W2_SEED, setup?: NewGameSetup): SessionState {
  return SessionStateSchema.parse(world2SessionInput(seed, setup));
}

/** The unparsed input, for fixtures that want to vary one field before parsing. */
export function world2SessionInput(seed: number = W2_SEED, setupInput?: NewGameSetup): SessionStateInput {
  const setup = setupInput ?? W2_DEFAULT_SETUP;
  const sessionId = makeId('sess', 'world2', String(seed));

  const player = playerSeedFor(setup);
  const seeds: readonly V2CompanySeed[] = [...V2_COMPANY_SEEDS, player];
  const playerDerived = deriveCompany(player);

  const instruments = seeds.map(buildV2Instrument).filter((instrument): instrument is NonNullable<typeof instrument> => instrument !== null);
  const quotes = seeds
    .map((entry) => buildV2Quote(entry, OPENING_RETURNS[entry.slug] ?? 0))
    .filter((quote): quote is NonNullable<typeof quote> => quote !== null);

  return {
    sessionId,
    seed: String(seed),
    quarter: 0,
    startYear: 2027,
    status: 'active',
    config: {
      playerCount: 1,
      difficulty: 'standard',
      majorRivalCount: 8,
      significantCompanyCount: 16,
      backgroundCompanyCount: 0,
      scenarioId: 'frontier_multisector_2027',
      worldVersion: WORLD_2_VERSION,
      startYear: 2027,
      quarterLimit: null,
      enableReferenceMarket: false,
      allowPlayerInnovation: true,
      autoExecuteRoutineDefault: false,
    },
    ledgerSequence: 0,
    lastResolvedQuarter: null,

    world: {
      macro: { gdpGrowth: 0.026, inflation: 0.029, policyRate: 0.0350, unemployment: 0.045, creditSpreads: 0.019, fxVolatility: 0.29, consumerDemand: 0.58 },
      // `sectorMultiples` is the same figure `OPENING_MULTIPLE_INDEX` prices the
      // opening quotes against; the tests assert the two agree.
      capitalMarkets: { riskAppetite: 0.6, ipoWindow: 0.46, ventureLiquidity: 0.55, sectorMultiples: OPENING_MULTIPLE_INDEX, volatility: 0.32, debtAvailability: 0.63 },
      compute: { acceleratorSupply: 0.44, cloudCapacity: 0.49, spotPrice: 1.54, reservedPrice: 1.19, fabCapacity: 0.41, energyDemand: 0.71 },
      energy: { electricityPrice: 1.31, datacentreAccess: 0.42, renewableCapacity: 0.44, gridConstraint: 0.61 },
      aiFrontier: { frontierCapability: 0.69, inferenceCost: 0.58, trainingEfficiency: 0.51, openSourceGap: 0.31, benchmarkSaturation: 0.66 },
      talent: { researcherSupply: 0.34, engineerSupply: 0.53, salaryPressure: 1.29, immigrationAccess: 0.49 },
      dataDomain: { dataAvailability: 0.46, licensingCost: 1.48, privacyRestriction: 0.54, syntheticDataMaturity: 0.49 },
      society: { aiTrust: 0.46, automationAnxiety: 0.64, consumerSentiment: 0.55, developerSentiment: 0.57 },
      regulation: { modelRules: 0.44, privacy: 0.56, antitrust: 0.5, copyright: 0.52, safetyObligations: 0.47, exportControls: 0.59 },
      government: { procurementBudget: 0.66, defenceUrgency: 0.69, digitalModernisation: 0.56, grantFunding: 0.44 },
      geopolitics: { tradeFriction: 0.57, conflictRisk: 0.39, sanctions: 0.48, techCompetition: 0.76 },
      media: { attentionLevel: 0.74, institutionalTrust: 0.43, controversyIntensity: 0.46, dominantNarrative: 'geopolitical_race' },
    },
    sectors: {
      semiconductors: { sectorId: 'semiconductors', sentiment: 0.38, multiple: OPENING_SECTOR_MULTIPLES.semiconductors ?? 1, demand: 0.8, volatility: 0.41 },
      cloud_infrastructure: { sectorId: 'cloud_infrastructure', sentiment: 0.31, multiple: OPENING_SECTOR_MULTIPLES.cloud_infrastructure ?? 1, demand: 0.74, volatility: 0.29 },
      frontier_models: { sectorId: 'frontier_models', sentiment: 0.47, multiple: OPENING_SECTOR_MULTIPLES.frontier_models ?? 1, demand: 0.7, volatility: 0.53 },
      enterprise_software: { sectorId: 'enterprise_software', sentiment: 0.14, multiple: OPENING_SECTOR_MULTIPLES.enterprise_software ?? 1, demand: 0.63, volatility: 0.27 },
      consumer_ai: { sectorId: 'consumer_ai', sentiment: -0.06, multiple: OPENING_SECTOR_MULTIPLES.consumer_ai ?? 1, demand: 0.49, volatility: 0.35 },
      data_services: { sectorId: 'data_services', sentiment: 0.04, multiple: OPENING_SECTOR_MULTIPLES.data_services ?? 1, demand: 0.54, volatility: 0.31 },
      defence_tech: { sectorId: 'defence_tech', sentiment: 0.36, multiple: OPENING_SECTOR_MULTIPLES.defence_tech ?? 1, demand: 0.68, volatility: 0.3 },
      energy_infrastructure: { sectorId: 'energy_infrastructure', sentiment: 0.22, multiple: OPENING_SECTOR_MULTIPLES.energy_infrastructure ?? 1, demand: 0.78, volatility: 0.26 },
    },
    activeModifiers: [],
    activeEvents: [],
    // Left empty on purpose: the economy subsystem seeds hazard state for every
    // family it knows about on the first quarter it resolves.
    eventHazards: {},

    companies: seeds.map(buildV2Company),
    companyMetrics: seeds.map(buildV2Metrics),
    capTables: seeds.map(buildV2CapTable),
    securities: seeds.map((entry) => ({
      id: SEC(entry.slug),
      companyId: entry.id,
      shareClassId: SHC(entry.slug),
      symbol: entry.ticker,
      isTradable: entry.isPublic,
      instrumentId: entry.isPublic ? INS(entry.slug) : null,
      parValueUsd: 0.0001,
    })),
    fundingRounds: [
      {
        id: 'rnd_player_ventures_seed',
        companyId: W2_COMPANIES.player,
        stage: 'seed',
        // The round that put the cash on the balance sheet, priced off the same
        // opening valuation everything else in this world is priced off.
        amount: Math.round(player.cash * 0.6),
        preMoney: playerDerived.valueUsd,
        postMoney: playerDerived.valueUsd + Math.round(player.cash * 0.6),
        dilution: Math.round(player.cash * 0.6) / (playerDerived.valueUsd + Math.round(player.cash * 0.6)),
        pricePerShareUsd: Math.max(0.01, Math.round((playerDerived.valueUsd / Math.max(1, playerDerived.shares)) * 100) / 100),
        shareClassId: SHC('player_ventures'),
        leadInvestorCharacterId: W2_CHARACTERS.helena,
        participantHolderIds: ['fund_seawall'],
        boardSeatsGranted: 1,
        closedQuarter: 0,
        status: 'closed',
      },
    ],

    marketInstruments: [
      ...instruments,
      {
        id: 'ins_fcw',
        kind: 'in_world_index',
        symbol: 'FCW',
        name: 'Frontier Capital World 100',
        companyId: null,
        securityId: null,
        sectorId: null,
        isReference: false,
        currency: 'USD',
        sharesOutstanding: null,
        listedQuarter: 0,
        beta: 1,
      },
      {
        id: 'ins_fcin',
        kind: 'in_world_index',
        symbol: 'FCIN',
        name: 'Frontier Industrial and Energy Index',
        companyId: null,
        securityId: null,
        sectorId: 'energy_infrastructure',
        isReference: false,
        currency: 'USD',
        sharesOutstanding: null,
        listedQuarter: 0,
        beta: 0.86,
      },
    ],
    quotes: [
      ...quotes,
      { instrumentId: 'ins_fcw', quarter: 0, price: 1000, return: 0.0284, volume: 0, marketCapUsd: 0 },
      { instrumentId: 'ins_fcin', quarter: 0, price: 1000, return: 0.0412, volume: 0, marketCapUsd: 0 },
    ],
    quoteHistoryQuarters: 24,
    valuationAnchors: seeds.map(buildV2Anchor),

    beliefs: [
      {
        id: 'blf_aletheia_model_schedule',
        subjectId: W2_COMPANIES.aletheia,
        subjectKind: 'company',
        topic: 'model_delay',
        probability: 0.36,
        priorProbability: 0.31,
        lastUpdatedQuarter: 0,
        evidenceDisclosureIds: ['dsc_aletheia_guidance_q1'],
      },
      {
        id: 'blf_cinder_fundraise',
        subjectId: W2_COMPANIES.cinder,
        subjectKind: 'company',
        topic: 'fundraise_needed',
        probability: 0.68,
        priorProbability: 0.54,
        lastUpdatedQuarter: 0,
        evidenceDisclosureIds: ['dsc_cinder_analyst_note'],
      },
      {
        id: 'blf_tessellate_export_controls',
        subjectId: W2_COMPANIES.tessellate,
        subjectKind: 'company',
        topic: 'regulatory_action',
        probability: 0.44,
        priorProbability: 0.4,
        lastUpdatedQuarter: 0,
        evidenceDisclosureIds: [],
      },
      {
        id: 'blf_qanat_contract',
        subjectId: W2_COMPANIES.qanat,
        subjectKind: 'company',
        topic: 'contract_win',
        probability: 0.57,
        priorProbability: 0.49,
        lastUpdatedQuarter: 0,
        evidenceDisclosureIds: [],
      },
    ],
    disclosures: [
      {
        id: 'dsc_aletheia_guidance_q1',
        companyId: W2_COMPANIES.aletheia,
        quarter: 0,
        kind: 'guidance',
        headline: 'Aletheia Labs guides revenue for quarter 1',
        body: 'Aletheia told investors to expect $1.6bn of revenue in quarter 1 and reiterated that its next model generation remains on schedule.',
        metrics: { revenue: 1600 * M, targetQuarter: 1 },
        credibility: 0.7,
        sourceCharacterId: W2_CHARACTERS.aletheia,
        // INTERNAL ONLY: a programme nobody outside the company knows about says
        // the schedule will not hold.
        isTruthful: false,
        beliefTopic: 'revenue_beat',
      },
      {
        id: 'dsc_cinder_analyst_note',
        companyId: W2_COMPANIES.cinder,
        quarter: 0,
        kind: 'analyst_note',
        headline: 'Cinder is building two lines on one balance sheet',
        body: 'At $180m of quarterly capital expenditure against $340m of cash and $1.4bn of debt, Cinder raises again within four quarters on any reasonable projection of cell prices.',
        metrics: { runwayQuarters: 4.1, netDebtToEquity: 1.8 },
        credibility: 0.61,
        sourceCharacterId: W2_CHARACTERS.gabriel,
        isTruthful: true,
        beliefTopic: 'fundraise_needed',
      },
      {
        id: 'dsc_qanat_load_growth',
        companyId: W2_COMPANIES.qanat,
        quarter: 0,
        kind: 'guidance',
        headline: 'Qanat books three years of datacentre load',
        body: 'Qanat said contracted industrial and datacentre load now runs to $5.6bn of backlog, and that connection dates rather than price are the binding constraint.',
        metrics: { backlog: 5600 * M },
        credibility: 0.78,
        sourceCharacterId: W2_CHARACTERS.qanat,
        isTruthful: true,
        beliefTopic: 'contract_win',
      },
    ],

    techGraph: {
      version: 1,
      sessionId,
      nodes: W2_NODES.map((node) => ({ ...node })),
      edges: W2_EDGES.map((edge) => ({ ...edge })),
      tracks: W2_TRACKS.map((track) => ({ ...track, nodeIds: [...track.nodeIds] })),
      updatedQuarter: 0,
    },
    researchProjects: W2_RESEARCH_PROJECTS.map((project) => ({ ...project })),

    characters: buildV2Characters(setup.founderName, setup.companyName),
    relationships: W2_RELATIONSHIPS.map((relationship) => ({ ...relationship })),
    memories: W2_MEMORIES.map((memory) => ({ ...memory })),
    accessOverrides: buildV2AccessOverrides(),
    conversations: [],

    boards: W2_BOARDS.map((board) => ({ ...board, directors: board.directors.map((seat) => ({ ...seat })) })),
    boardProposals: [],
    commitments: [],

    agencies: W2_AGENCIES.map((agency) => ({ ...agency, priorities: [...agency.priorities], contactCharacterIds: [...agency.contactCharacterIds] })),
    procurementOpportunities: buildV2Opportunities(),
    governmentBids: [],
    governmentContracts: [],
    contractorReputations: [
      reputationRow(W2_COMPANIES.sentinel, 78, 0.93, 0.05, 0, 5),
      reputationRow(W2_COMPANIES.qanat, 72, 0.88, 0.09, 1, 4),
      reputationRow(W2_COMPANIES.harbourline, 64, 0.84, 0.12, 1, 3),
      reputationRow(W2_COMPANIES.basalt, 66, 0.9, 0.07, 0, 3),
      reputationRow(W2_COMPANIES.rasan, 56, 0.79, 0.16, 2, 2),
    ],

    socialAccounts: buildV2SocialAccounts(`@${setup.founderName.toLowerCase().replace(/[^a-z0-9]+/g, '')}`),
    socialPosts: [],
    mediaStories: [],

    deals: [],

    // The eleven institutions that were always at the other end of the
    // `holderKind: 'fund'` holdings above. Six of them already sit on these
    // registers and in these boardrooms; the five new ones own nothing yet, so
    // not one register changes by a share. World 1 grows none of these keys.
    capitalEntities: buildV2CapitalEntities(),
    shortPositions: [],
    activistCampaigns: [],
    capitalOrders: [],

    players: [
      {
        playerId: DEMO_PLAYER_ID,
        characterId: W2_PLAYER_CHARACTER_ID,
        companyId: W2_COMPANIES.player,
        isHuman: true,
        displayName: setup.founderName,
        joinedQuarter: 0,
        autoExecuteRoutine: false,
        hasSubmittedThisQuarter: false,
        isActive: true,
      },
    ],
    pendingActions: [],

    leaderboards: [],
    objectives: [
      {
        id: 'obj_player_profitability',
        playerId: DEMO_PLAYER_ID,
        label: 'Reach quarterly operating profit',
        description: `Get ${setup.companyName} to a positive operating income in any quarter, without selling the company to do it.`,
        metric: 'operating_income',
        targetValue: 1,
        currentValue: playerDerived.burn,
        progress: 0,
        completedQuarter: null,
        weight: 0.4,
      },
      {
        id: 'obj_player_first_contract',
        playerId: DEMO_PLAYER_ID,
        label: 'Win public work',
        description: 'Hold at least $50m of awarded government contract value.',
        metric: 'government_contract_value',
        targetValue: 50 * M,
        currentValue: 0,
        progress: 0,
        completedQuarter: null,
        weight: 0.3,
      },
      {
        id: 'obj_player_network',
        playerId: DEMO_PLAYER_ID,
        label: 'Become someone worth calling',
        description: 'Reach a connection level of 60, which is roughly where a sovereign fund returns your messages.',
        metric: 'connection_level',
        targetValue: 60,
        currentValue: 24,
        progress: 0.4,
        completedQuarter: null,
        weight: 0.3,
      },
    ],
  };
}

function reputationRow(companyId: string, score: number, onTime: number, overrun: number, incidents: number, won: number) {
  return {
    companyId,
    agencyId: null,
    pastPerformanceScore: score,
    onTimeDeliveryPct: onTime,
    costOverrunPct: overrun,
    securityIncidents: incidents,
    contractsWon: won,
    contractsLost: Math.max(0, 6 - won),
    terminationsForDefault: 0,
    lastUpdatedQuarter: 0,
  };
}
