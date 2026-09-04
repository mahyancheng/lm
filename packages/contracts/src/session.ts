/**
 * @frontier/contracts — session.ts
 *
 * `SessionState` is the canonical root aggregate: everything the deterministic
 * resolver needs to compute `S_{t+1} = F(S_t, actions, modifiers, seed)`.
 *
 * Rules that shape the shape:
 * - **Collections are arrays, not records**, except where a keyed lookup is the
 *   natural representation (`sectors`, `eventHazards`). Arrays iterate in a
 *   stable order, which matters for determinism and for state hashing.
 * - **Bounded history.** Quotes and disclosures are kept for a rolling window;
 *   the full history lives in the ledger and in snapshots, not in live state.
 * - **Truth and belief are separate.** `companies` and `researchProjects` hold
 *   canonical reality; `beliefs` and `disclosures` hold what the market thinks.
 *   Nothing crosses between them except through the disclosure phase.
 * - Collection fields carry `.default([])` so a partial fixture parses cleanly.
 *   The inferred `SessionState` type still has every field required.
 */

import { z } from 'zod';
import { QuarterIndexSchema, unitInterval } from './ids';
import { DEFAULT_REGION, DEFAULT_SECTOR, RegionSchema, SectorSchema, defaultRegionFor, type Sector } from './sectors';
import { SectorStateMapSchema, WorldStateSchema } from './world';
import { ActiveModifierSchema } from './modifiers';
import { EventHazardMapSchema, WorldEventSchema } from './events';
import { CompanySchema, CompanyQuarterMetricsSchema } from './company';
import { EconomyReportSchema, SECTOR_PRICE_BOUNDS, SECTOR_SHORTAGE_MAX, TOLL_MAX_PCT } from './economy';
import { NODE_PRICE_BOUNDS } from './nodes';
import { CapTableSchema, FundingRoundSchema, SecuritySchema } from './ownership';
import { MarketBeliefSchema, MarketInstrumentSchema, PublicDisclosureSchema, QuoteSchema, ValuationAnchorSchema } from './markets';
import { BoardProposalSchema, BoardSchema, StoredCommitmentSchema } from './governance';
import { AgencySchema, ContractorReputationSchema, GovernmentContractSchema, ProcurementOpportunitySchema, StoredGovernmentBidSchema } from './government';
import { ResearchProjectSchema, TechGraphSchema } from './tech';
import { AccessOverrideSchema, CharacterSchema, ConversationMetadataSchema, MemorySchema, RelationshipSchema } from './people';
import { MediaStorySchema, SocialAccountSchema, SocialPostSchema } from './social';
import { DealProposalSchema } from './deals';
import { ActivistCampaignSchema, CapitalEntitySchema, CapitalOrderSchema, MAX_CAPITAL_ENTITIES, ShortPositionSchema } from './capital';
import { SubmittedActionSchema } from './actions';
import { LeaderboardSchema, QuarterSnapshotSchema, SessionObjectiveSchema } from './sim';

/* -------------------------------------------------------------------------- */
/*  World versioning                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Which world a session was built from.
 *
 * **1** is the original single-sector AI scenario. It is frozen: its scenario
 * module, its opening numbers and its seed graph never change again, so a save
 * made against it replays to the same state forever.
 *
 * **2** is the multi-sector economy — six sectors, six regions, hundreds of
 * companies, fundamentals-anchored prices. It is not deleted and not migrated:
 * a game already in progress has to be able to finish, so world 2 keeps working
 * exactly as it always did and its opening state is pinned by a test.
 *
 * **3** is the node economy — one table of nodes, one market price per node,
 * unit cost rolled up through those prices, and ownership per company.
 *
 * The version is recorded rather than inferred, and it defaults to **1** so a
 * save written before this field existed parses as what it actually is. New
 * games are created at `CURRENT_WORLD_VERSION`.
 */
export const WORLD_VERSIONS = [1, 2, 3] as const;

export const WorldVersionSchema = z
  .union([z.literal(1), z.literal(2), z.literal(3)])
  .default(1)
  .describe('Which world scenario this session was built from. 1 is the frozen single-sector AI world; 2 is the multi-sector economy; 3 is the node economy. Absent means 1: the field postdates world 1 saves.');
export type WorldVersion = (typeof WORLD_VERSIONS)[number];

/** What a save without a recorded version is. Never change this. */
export const LEGACY_WORLD_VERSION: WorldVersion = 1;

/** What a new game is created at. */
export const CURRENT_WORLD_VERSION: WorldVersion = 3;

/**
 * The first world version whose economy is the one node table. Every world-3
 * branch in the engine gates on this and never on the multi-sector gate:
 * `isMultiSectorWorld` means "version 2 or later" and repurposing it would
 * silently drag world 2 into world-3 behaviour.
 */
export const NODE_ECONOMY_WORLD_VERSION: WorldVersion = 3;

/**
 * The oldest world version this build can open.
 *
 * Three, from the node economy on. World 3 rebuilt the economy from the ground
 * up — one node table, one price per node, ownership per company — and a world-2
 * save is a recording of decisions taken against rules that no longer exist:
 * replaying it would not reproduce that game, it would produce a different one
 * wearing its name. So it is REFUSED, in the plain words below, and never
 * migrated and never overwritten. The world-2 engine itself is not deleted —
 * every branch of it still runs and is still pinned by hash — but this build
 * starts new games in world 3 only.
 */
export const MINIMUM_SUPPORTED_WORLD_VERSION: WorldVersion = 3;

/** What a player is told when they open a save from a world this build retired. */
export const RETIRED_WORLD_SAVE_MESSAGE =
  'This save was made in world 2. World 3 rebuilt the economy from the ground up and cannot replay it. Start a new game.';

/** Whether a stored world version is one this build will open. */
export function worldVersionIsSupported(version: WorldVersion): boolean {
  return version >= MINIMUM_SUPPORTED_WORLD_VERSION;
}

/* -------------------------------------------------------------------------- */
/*  Configuration                                                              */
/* -------------------------------------------------------------------------- */

export const SESSION_DIFFICULTIES = ['sandbox', 'standard', 'hard', 'brutal'] as const;

export const SessionDifficultySchema = z
  .enum(SESSION_DIFFICULTIES)
  .describe('How volatile the world is and how sharply rivals play. Difficulty scales the impact budget and NPC aggression; it never gives rivals information they should not have.');
export type SessionDifficulty = z.infer<typeof SessionDifficultySchema>;

export const SessionConfigSchema = z
  .object({
    playerCount: z.number().int().min(1).max(8).describe('Human founders in the session. A solo session simply contains one human and more AI-controlled companies.'),
    difficulty: SessionDifficultySchema,
    majorRivalCount: z.number().int().min(0).max(10).describe('Companies on the "major" tier receiving full LLM strategic planning each quarter. Four to ten is the intended range.'),
    significantCompanyCount: z.number().int().min(0).max(60).describe('Companies on the "significant" tier running rule-based strategy with occasional LLM deliberation.'),
    backgroundCompanyCount: z.number().int().min(0).max(500).describe('Deterministic archetype companies. They are promoted to a higher tier only when they become strategically relevant.'),
    scenarioId: z.string().min(1).describe('Seed scenario, e.g. "compute_crunch_2031". Determines starting world values, seed companies and the initial Frontier Map.'),
    worldVersion: WorldVersionSchema.describe('Which world scenario built this session. Defaults to 1 so a save written before the field existed keeps replaying against the frozen world.'),
    startYear: z.number().int().min(2020).max(2100).describe('Calendar year quarter 0 falls in.'),
    quarterLimit: z.number().int().min(1).max(400).nullable().describe('Quarter at which the session ends, or null for an open-ended sandbox. There is no fixed victory screen either way.'),
    enableReferenceMarket: z.boolean().describe('Whether to display the live real-world reference tape alongside the in-world exchange. Reference instruments are read-only regardless.'),
    allowPlayerInnovation: z.boolean().describe('Whether players may propose new Frontier Map nodes.'),
    autoExecuteRoutineDefault: z.boolean().describe('Default for the per-player "execute routine instructions automatically" preference. Never applies to actions in CONFIRMATION_REQUIRED_ACTIONS.'),
  })
  .describe('Static configuration chosen when the session is created. Immutable once the session starts.');
export type SessionConfig = z.infer<typeof SessionConfigSchema>;

/* -------------------------------------------------------------------------- */
/*  New-game setup                                                             */
/* -------------------------------------------------------------------------- */

/**
 * The five starting backgrounds a founder chooses at New Game. Each one shapes
 * the player company's opening balance sheet, product, compute and posture; the
 * numeric shape lives in the scenario (`createDemoSession`), and the copy the
 * picker shows lives in `NEW_GAME_BACKGROUNDS` below.
 */
export const NEW_GAME_BACKGROUND_IDS = ['frontier_lab', 'enterprise_ai', 'consumer_ai', 'infrastructure', 'bootstrapper'] as const;

export const NewGameBackgroundIdSchema = z
  .enum(NEW_GAME_BACKGROUND_IDS)
  .describe('Which starting background the founder picked. Selects the player company\'s opening shape; everything else in the world is unchanged.');
export type NewGameBackgroundId = z.infer<typeof NewGameBackgroundIdSchema>;

/**
 * The starting backgrounds the other five sectors add in world version 2, two
 * per sector. Kept in a separate list from `NEW_GAME_BACKGROUND_IDS` on purpose:
 * that list is the world-version-1 set and must stay exactly five, so a v1 save
 * and the v1 picker both still see the world they were built for.
 */
export const SECTOR_BACKGROUND_IDS = [
  // robotics
  'warehouse_robotics',
  'humanoid_lab',
  // manufacturing
  'contract_manufacturer',
  'precision_components',
  // energy
  'grid_developer',
  'renewables_operator',
  // logistics
  'freight_network',
  'last_mile',
  // consumer
  'direct_brand',
  'retail_platform',
] as const;

export const SectorBackgroundIdSchema = z.enum(SECTOR_BACKGROUND_IDS).describe('A starting background belonging to one of the five non-AI sectors. World version 2 only.');
export type SectorBackgroundId = z.infer<typeof SectorBackgroundIdSchema>;

/** Every background id in the game: the five AI ones first, then the rest. */
export const ALL_BACKGROUND_IDS = [...NEW_GAME_BACKGROUND_IDS, ...SECTOR_BACKGROUND_IDS] as const;

export const BackgroundIdSchema = z
  .enum(ALL_BACKGROUND_IDS)
  .describe('Which starting background the founder picked, across every sector. Selects the player company\'s opening shape; everything else in the world is unchanged.');
export type BackgroundId = z.infer<typeof BackgroundIdSchema>;

export const NewGameSetupSchema = z
  .object({
    companyName: z.string().trim().min(1).max(40).describe('The player company\'s display name. Trimmed; one to forty characters.'),
    founderName: z.string().trim().min(1).max(40).describe('The founder character\'s display name. Trimmed; one to forty characters.'),
    backgroundId: BackgroundIdSchema,
    sector: SectorSchema.default(DEFAULT_SECTOR).describe('Which part of the economy the founder starts in. Defaults to "ai", which is the only sector world version 1 has.'),
    region: RegionSchema.default(DEFAULT_REGION).describe('Where the founder starts. Defaults to "north_america", which is where every world-version-1 company is.'),
    worldVersion: WorldVersionSchema.describe('Which world to build. Defaults to 1 so a setup recorded before this field existed still builds the frozen world.'),
  })
  .describe(
    'What a player chooses at New Game: company name, founder name, a starting background, and — from world version 2 — a sector and a region. Sector, region and world version all default, so a world-version-1 setup parses unchanged. Plain state, never handed to a model.',
  );
export type NewGameSetup = z.infer<typeof NewGameSetupSchema>;

/** The input type: sector, region and world version may be omitted. */
export type NewGameSetupInput = z.input<typeof NewGameSetupSchema>;

/** One player-facing headline stat on a background card, e.g. `{ label: "Cash", value: "$15M" }`. */
export interface NewGameBackgroundHighlight {
  readonly label: string;
  readonly value: string;
}

/** Everything the New Game picker needs to render one background card. */
export interface NewGameBackground {
  readonly id: BackgroundId;
  /** Which sector this background starts you in. */
  readonly sector: Sector;
  /** A short icon key (matches the app icon set), e.g. "flask". */
  readonly icon: string;
  readonly label: string;
  readonly tagline: string;
  readonly blurb: string;
  /**
   * Three or four opening stats to show on the card.
   *
   * The ones written into the tables below are **world 1 and world 2's**. They
   * are hand-written, and hand-written numbers go stale: world 3 reprices every
   * line off the node roll-up, so a card claiming "Cash: $22M, Pre-revenue"
   * describes a company that world no longer builds. From world 3 on, the
   * picker asks the SCENARIO what a background opens with —
   * `backgroundCardsFor` in `@frontier/simulation`, checked against
   * `createWorld3Session` by `world3BackgroundCards.test.ts`. Contracts is the
   * base layer and cannot compute them here.
   *
   * So: do not add a figure to a card below expecting a new world to honour it.
   * Worlds 1 and 2 are frozen and these strings are frozen with them.
   */
  readonly highlights: readonly NewGameBackgroundHighlight[];
}

/**
 * The copy and headline stats for the five backgrounds, in pick order.
 *
 * The numbers mirror the world-1 and world-2 scenarios' starting shape, and
 * they are frozen along with those worlds: a player finishing a world-2 game
 * has to keep seeing the cards it was described to them with. A world-3 picker
 * draws the same copy carrying figures read off `createWorld3Session` — see
 * `highlights` above. The scenario is the source of truth either way.
 */
export const NEW_GAME_BACKGROUNDS: readonly NewGameBackground[] = [
  {
    id: 'frontier_lab',
    sector: 'ai',
    icon: 'flask',
    label: 'Frontier Lab',
    tagline: 'Train ahead of revenue',
    blurb:
      'A research house chasing a forecast node on the Frontier Map. No product revenue yet, a lot of compute reserved, and a burn that only makes sense if the models land.',
    highlights: [
      { label: 'Cash', value: '$15M' },
      { label: 'Compute', value: '800 owned' },
      { label: 'Revenue', value: 'Pre-revenue' },
      { label: 'Posture', value: 'Aggressive growth' },
    ],
  },
  {
    id: 'enterprise_ai',
    sector: 'ai',
    icon: 'briefcase',
    label: 'Enterprise AI',
    tagline: 'Sell seats to businesses',
    blurb:
      'The classic start: a seat-based enterprise product with real customers, modest revenue and a sales motion. Steady, and the shape the rest of the game is balanced around.',
    highlights: [
      { label: 'Cash', value: '$4M' },
      { label: 'Customers', value: '1,600 seats' },
      { label: 'Revenue', value: '$0.32M/qtr' },
      { label: 'Posture', value: 'Aggressive growth' },
    ],
  },
  {
    id: 'consumer_ai',
    sector: 'ai',
    icon: 'people',
    label: 'Consumer App',
    tagline: 'Millions of small accounts',
    blurb:
      'A consumer product with a big, low-priced user base, thin margins and high churn. You live on hype and word of mouth, and the market watches your numbers in public.',
    highlights: [
      { label: 'Cash', value: '$5M' },
      { label: 'Customers', value: '750K users' },
      { label: 'Margin', value: 'Thin' },
      { label: 'Posture', value: 'Aggressive growth' },
    ],
  },
  {
    id: 'infrastructure',
    sector: 'ai',
    icon: 'network',
    label: 'AI Infrastructure',
    tagline: 'Own the capacity',
    blurb:
      'Capital-heavy from day one: datacentre, owned accelerators and some debt against them. Steadier margins and a government-and-enterprise reputation, but the balance sheet is leveraged.',
    highlights: [
      { label: 'Cash', value: '$6M' },
      { label: 'Compute', value: '4,000 owned' },
      { label: 'Debt', value: '$8M' },
      { label: 'Posture', value: 'Balanced' },
    ],
  },
  {
    id: 'bootstrapper',
    sector: 'ai',
    icon: 'compass',
    label: 'Lean Bootstrapper',
    tagline: 'Scrappy and short on cash',
    blurb:
      'A four-person shop with one product, no debt and not much runway. The hardest start: you have to build connections and revenue before the money runs out.',
    highlights: [
      { label: 'Cash', value: '$1.2M' },
      { label: 'Team', value: '4 people' },
      { label: 'Debt', value: 'None' },
      { label: 'Posture', value: 'Balanced' },
    ],
  },
];

/**
 * The world-version-2 backgrounds, two for each of the five non-AI sectors, in
 * `SECTORS` order. Same contract as the AI five: the copy lives here, the
 * numeric opening shape lives in the scenario, and the scenario is the source of
 * truth for what actually reaches the engine — which from world 3 on means the
 * picker takes its figures from `backgroundCardsFor` rather than from the
 * `highlights` written below.
 */
export const SECTOR_BACKGROUNDS: readonly NewGameBackground[] = [
  {
    id: 'warehouse_robotics',
    sector: 'robotics',
    icon: 'box',
    label: 'Warehouse Robotics',
    tagline: 'Pick, place, repeat',
    blurb:
      'Fleets already working inside other people\'s buildings. Real revenue, real service obligations, and a margin that lives or dies on how often a unit needs a human.',
    highlights: [
      { label: 'Cash', value: '$7M' },
      { label: 'Fleet', value: '1,200 units' },
      { label: 'Revenue', value: '$2M/qtr' },
      { label: 'Posture', value: 'Balanced' },
    ],
  },
  {
    id: 'humanoid_lab',
    sector: 'robotics',
    icon: 'flask',
    label: 'Humanoid Lab',
    tagline: 'Bet the company on legs',
    blurb:
      'Pre-revenue, capital-hungry and years from a useful product. If general-purpose machines arrive you own the category; if they do not you own a very expensive video.',
    highlights: [
      { label: 'Cash', value: '$22M' },
      { label: 'Revenue', value: 'Pre-revenue' },
      { label: 'Team', value: 'Research-led' },
      { label: 'Posture', value: 'Research first' },
    ],
  },
  {
    id: 'contract_manufacturer',
    sector: 'manufacturing',
    icon: 'building',
    label: 'Contract Manufacturer',
    tagline: 'Somebody else\'s name on the box',
    blurb:
      'Lines running at volume for customers who can leave. Thin margins, real cash flow and a balance sheet with a mortgage on it. Utilisation is the whole game.',
    highlights: [
      { label: 'Cash', value: '$9M' },
      { label: 'Revenue', value: '$14M/qtr' },
      { label: 'Debt', value: '$18M' },
      { label: 'Posture', value: 'Efficiency' },
    ],
  },
  {
    id: 'precision_components',
    sector: 'manufacturing',
    icon: 'settings',
    label: 'Precision Components',
    tagline: 'The part nobody else can make',
    blurb:
      'Small, specialised and quietly essential. High margins for as long as the tolerance stays hard to hit, and a customer list short enough to fit on one page.',
    highlights: [
      { label: 'Cash', value: '$5M' },
      { label: 'Revenue', value: '$3M/qtr' },
      { label: 'Margin', value: 'High' },
      { label: 'Posture', value: 'Balanced' },
    ],
  },
  {
    id: 'grid_developer',
    sector: 'energy',
    icon: 'live',
    label: 'Grid Developer',
    tagline: 'Build the substation, sell the connection',
    blurb:
      'Interconnection queues, permits and a backlog worth more than the company. Every quarter you spend capital now for revenue that arrives years later — if it arrives.',
    highlights: [
      { label: 'Cash', value: '$12M' },
      { label: 'Backlog', value: '$60M' },
      { label: 'Debt', value: '$25M' },
      { label: 'Posture', value: 'Aggressive growth' },
    ],
  },
  {
    id: 'renewables_operator',
    sector: 'energy',
    icon: 'globe',
    label: 'Renewables Operator',
    tagline: 'Cheap power, patient money',
    blurb:
      'Assets in the ground selling into a price you do not set. Steady contracted cash, heavy leverage, and a business that gets very interesting when everyone suddenly needs power.',
    highlights: [
      { label: 'Cash', value: '$8M' },
      { label: 'Revenue', value: '$6M/qtr' },
      { label: 'Debt', value: '$40M' },
      { label: 'Posture', value: 'Balanced' },
    ],
  },
  {
    id: 'freight_network',
    sector: 'logistics',
    icon: 'network',
    label: 'Freight Network',
    tagline: 'Move it cheaper than the last carrier',
    blurb:
      'Volume, density and a margin measured in single points. You feel every fuel price and every manufacturing slowdown before the companies causing them do.',
    highlights: [
      { label: 'Cash', value: '$6M' },
      { label: 'Revenue', value: '$11M/qtr' },
      { label: 'Margin', value: 'Thin' },
      { label: 'Posture', value: 'Efficiency' },
    ],
  },
  {
    id: 'last_mile',
    sector: 'logistics',
    icon: 'box',
    label: 'Last Mile',
    tagline: 'The final ten miles cost the most',
    blurb:
      'Fast-growing, cash-hungry delivery into consumer demand. Customers who churn on one late drop, and a cost curve that only works at density you do not have yet.',
    highlights: [
      { label: 'Cash', value: '$4M' },
      { label: 'Growth', value: 'Fast' },
      { label: 'Margin', value: 'Negative' },
      { label: 'Posture', value: 'Land grab' },
    ],
  },
  {
    id: 'direct_brand',
    sector: 'consumer',
    icon: 'people',
    label: 'Direct Brand',
    tagline: 'Sell straight to the public',
    blurb:
      'Good margins, no distributor and a marketing bill that never stops. You own the customer relationship right up until the day you stop paying for attention.',
    highlights: [
      { label: 'Cash', value: '$5M' },
      { label: 'Revenue', value: '$4M/qtr' },
      { label: 'Marketing', value: 'Heavy' },
      { label: 'Posture', value: 'Aggressive growth' },
    ],
  },
  {
    id: 'retail_platform',
    sector: 'consumer',
    icon: 'coins',
    label: 'Retail Platform',
    tagline: 'Take a cut of everyone else\'s sales',
    blurb:
      'A marketplace with sellers on one side and shoppers on the other. Capital-light and lovely when it works; two-sided and unforgiving while you are still building it.',
    highlights: [
      { label: 'Cash', value: '$10M' },
      { label: 'Take rate', value: '12%' },
      { label: 'Sellers', value: '3,400' },
      { label: 'Posture', value: 'Land grab' },
    ],
  },
];

/** Every background card in the game, AI five first. */
export const ALL_BACKGROUNDS: readonly NewGameBackground[] = [...NEW_GAME_BACKGROUNDS, ...SECTOR_BACKGROUNDS];

const BACKGROUND_BY_ID: ReadonlyMap<string, NewGameBackground> = new Map(ALL_BACKGROUNDS.map((background) => [background.id, background]));

/** One background card by id, or `undefined` for an id that is not in the set. */
export function backgroundById(id: string): NewGameBackground | undefined {
  return BACKGROUND_BY_ID.get(id);
}

/**
 * The backgrounds available in one sector, in presentation order. `"ai"` gives
 * the five world-version-1 backgrounds unchanged, which is what the frozen
 * world's picker still shows.
 */
export function backgroundsForSector(sector: Sector): readonly NewGameBackground[] {
  return ALL_BACKGROUNDS.filter((background) => background.sector === sector);
}

/**
 * The background a sector starts on when the player has not chosen one: the
 * first card in that sector. Total — every sector has at least two backgrounds
 * — and the final fallback exists only so the return type stays narrow.
 */
export function defaultBackgroundFor(sector: Sector): BackgroundId {
  return backgroundsForSector(sector)[0]?.id ?? 'enterprise_ai';
}

/** Which sector a background belongs to. Defaults to "ai" for an unknown id. */
export function sectorForBackground(id: string): Sector {
  return BACKGROUND_BY_ID.get(id)?.sector ?? DEFAULT_SECTOR;
}

/* -------------------------------------------------------------------------- */
/*  Chat-driven setup (LLM-facing)                                             */
/* -------------------------------------------------------------------------- */

/** The five things a new game needs before it can be built. */
export const SETUP_SLOTS = ['companyName', 'founderName', 'sector', 'region', 'backgroundId'] as const;
export const SetupSlotSchema = z.enum(SETUP_SLOTS).describe('One thing the new-game conversation still has to establish.');
export type SetupSlot = z.infer<typeof SetupSlotSchema>;

/**
 * What the new-game chat extracts from what the player just said.
 *
 * LLM-facing, so it follows the house rules for model output: every field
 * present, `.nullable()` rather than `.optional()` for "not established yet",
 * explicit enums, bounds in prose. It is a *proposal*: nothing here builds a
 * session until `newGameSetupFromProposal` has put it through
 * `NewGameSetupSchema` and the engine has accepted the result.
 *
 * The same schema also parses a purely deterministic extraction, which is the
 * fallback when the model is unavailable — the chat still works, it just asks
 * more direct questions.
 */
export const SetupProposalSchema = z
  .object({
    companyName: z.string().trim().max(40).nullable().default(null).describe('The company name the player gave, or null if they have not given one yet. One to forty characters.'),
    founderName: z.string().trim().max(40).nullable().default(null).describe('The founder name the player gave, or null if they have not given one yet. One to forty characters.'),
    sector: SectorSchema.nullable().default(null).describe('The sector the player wants, or null if it is still unclear. Do not guess from a vague preference; leave it null and list it in "missing".'),
    region: RegionSchema.nullable().default(null).describe('The region the player wants, or null if it is still unclear.'),
    backgroundId: BackgroundIdSchema.nullable().default(null).describe('The starting background the player chose, or null. Must belong to the chosen sector; a mismatch is rejected by the engine.'),
    confidence: unitInterval('How confident this reading of the conversation is. Below 0.4 the interface asks the player to confirm before building the world.'),
    missing: z.array(SetupSlotSchema).describe('Which slots are still unestablished, so the next question can ask for one of them. Must list exactly the fields left null.'),
  })
  .describe('A reading of the new-game conversation so far. A proposal, never a state write: the engine validates it and the player confirms before a world is built.');
export type SetupProposal = z.infer<typeof SetupProposalSchema>;

/** The slots a proposal has not established, derived rather than trusted. */
export function missingSetupSlots(proposal: SetupProposal): readonly SetupSlot[] {
  const missing: SetupSlot[] = [];
  if (!proposal.companyName) missing.push('companyName');
  if (!proposal.founderName) missing.push('founderName');
  if (proposal.sector === null) missing.push('sector');
  if (proposal.region === null) missing.push('region');
  if (proposal.backgroundId === null) missing.push('backgroundId');
  return missing;
}

/** Has the conversation established everything a world needs? */
export function setupProposalIsComplete(proposal: SetupProposal): boolean {
  return missingSetupSlots(proposal).length === 0;
}

/**
 * Turn a proposal into a real setup, or return null when it is not ready.
 *
 * Two things are repaired rather than trusted, because a model will get them
 * wrong: a background from the wrong sector is replaced with that sector's
 * default, and a missing region falls back to the sector's best fit. Everything
 * else must have been established, and the result is parsed by
 * `NewGameSetupSchema` before it is returned — so an over-long name or an
 * unknown id fails here rather than inside the scenario builder.
 */
export function newGameSetupFromProposal(proposal: SetupProposal, worldVersion: WorldVersion = CURRENT_WORLD_VERSION): NewGameSetup | null {
  if (!proposal.companyName || !proposal.founderName || proposal.sector === null) return null;
  const sector = proposal.sector;
  const chosen = proposal.backgroundId === null ? null : backgroundById(proposal.backgroundId);
  const backgroundId = chosen && chosen.sector === sector ? chosen.id : defaultBackgroundFor(sector);
  const parsed = NewGameSetupSchema.safeParse({
    companyName: proposal.companyName,
    founderName: proposal.founderName,
    backgroundId,
    sector,
    region: proposal.region ?? defaultRegionFor(sector),
    worldVersion,
  });
  return parsed.success ? parsed.data : null;
}

/* -------------------------------------------------------------------------- */
/*  Players                                                                    */
/* -------------------------------------------------------------------------- */

export const SessionPlayerSchema = z
  .object({
    playerId: z.string().min(1),
    characterId: z.string().min(1).describe('The founder character this participant controls. The player is the character, not the company.'),
    companyId: z.string().min(1).describe(
      'The FOUNDING company: set once, when the seat joins, and never reassigned. A player may come to direct other companies too — a subsidiary kept alive by an acquisition, or a majority stake built up without one — but those live on `Company.controllerPlayerId`, derived through `controlledCompaniesOf`, never here. This field is what elimination, `ownCompany` and every "own company" default read; it is deliberately stable so a player is never quietly moved off the company they started with.',
    ),
    isHuman: z.boolean().describe('False for AI-controlled founders occupying a player seat. Their messages must be labelled as AI-generated.'),
    displayName: z.string().min(1).max(60),
    joinedQuarter: QuarterIndexSchema,
    autoExecuteRoutine: z.boolean().describe('Whether low-risk interpreted instructions may execute without an explicit confirmation.'),
    hasSubmittedThisQuarter: z.boolean().describe('Whether they have locked their instructions for the current quarter. Resolution waits for every active player or for the planning window to close.'),
    isActive: z.boolean(),
    eliminatedQuarter: QuarterIndexSchema.nullable()
      .optional()
      .describe(
        'Quarter this seat\'s company went into administration, or absent/null while it is still playing. World version 2 only: the validator refuses every instruction from a seat that carries one, and the shell shows the verdict instead of the game. Optional so a world-1 save parses byte-identically.',
      ),
  })
  .describe('One seat at the table.');
export type SessionPlayer = z.infer<typeof SessionPlayerSchema>;

/* -------------------------------------------------------------------------- */
/*  Session status                                                             */
/* -------------------------------------------------------------------------- */

export const SESSION_STATUSES = ['lobby', 'active', 'resolving', 'completed', 'abandoned'] as const;

export const SessionStatusSchema = z
  .enum(SESSION_STATUSES)
  .describe('Lifecycle. "resolving" is a lock: a quarter cannot resolve twice, and no action may be submitted while the resolver runs.');
export type SessionStatus = z.infer<typeof SessionStatusSchema>;

/* -------------------------------------------------------------------------- */
/*  The root aggregate                                                         */
/* -------------------------------------------------------------------------- */

export const SessionStateSchema = z
  .object({
    // --- identity and clock ---
    sessionId: z.string().min(1),
    seed: z.string().min(1).describe('The session seed. Every stochastic decision in the engine derives from it through the seeded RNG. Same state plus same decisions plus same seed produces the same outcome, always.'),
    quarter: QuarterIndexSchema.describe('The quarter currently open for planning.'),
    startYear: z.number().int().min(2020).max(2100),
    status: SessionStatusSchema,
    config: SessionConfigSchema,
    ledgerSequence: z.number().int().min(0).default(0).describe('Next ledger sequence number to assign. Advances monotonically and never rewinds.'),
    lastResolvedQuarter: QuarterIndexSchema.nullable().default(null).describe('Last quarter that committed, or null before the first resolution. Guards idempotency.'),

    // --- world ---
    world: WorldStateSchema,
    sectors: SectorStateMapSchema.describe('Per-sector conditions, keyed by sector id.'),
    activeModifiers: z.array(ActiveModifierSchema).default([]).describe('Modifiers currently in force, with decay resolved for this quarter.'),
    activeEvents: z.array(WorldEventSchema).default([]).describe('World events still within their duration.'),
    eventHazards: EventHazardMapSchema.describe('Per-family hazard state, keyed by family id. This is where causal cascades live between quarters.'),

    // --- the priced economy (world version 2 and later) ---
    //
    // Optional rather than defaulted, and deliberately so: a defaulted map would
    // materialise as `{}` on every world-version-1 save the moment it parsed, and
    // the frozen world would stop hashing to the value it has always hashed to.
    // Absent is the neutral reading — index 100, no shortage, no toll — and the
    // accessors in `economy.ts` are the only sanctioned way to read them.
    sectorPrices: z
      .record(z.string(), z.number().int().min(SECTOR_PRICE_BOUNDS.min).max(SECTOR_PRICE_BOUNDS.max))
      .optional()
      .describe('Goods price index per sector, whole numbers around a baseline of 100. Computed from last quarter\'s supply and demand, so they are plannable.'),
    sectorShortages: z
      .record(z.string(), z.number().int().min(0).max(SECTOR_SHORTAGE_MAX))
      .optional()
      .describe('The stateful half of the price rule: a 0-60 counter per sector that deepens by ten when the price clamp saturates and heals by five when it does not.'),
    nodePrices: z
      .record(z.string(), z.number().int().min(NODE_PRICE_BOUNDS.min).max(NODE_PRICE_BOUNDS.max))
      .optional()
      .describe(
        'World version 3: the price index of every economic node, whole numbers around a baseline of 100, multiplied into that node\'s own basePriceUsd. One price per node per quarter, computed from last quarter\'s supply and demand and stored here rather than recomputed inside any loop. Absent in world versions 1 and 2, where the neutral reading is the baseline.',
      ),
    regionTolls: z
      .record(z.string(), z.number().int().min(0).max(TOLL_MAX_PCT))
      .optional()
      .describe('Logistics toll in force per region, whole percentage points of a rival\'s cash cost of goods. Zero unless somebody dominates that region\'s freight.'),
    economyReport: EconomyReportSchema.nullable()
      .optional()
      .describe(
        'One quarter of itemised economic attribution — price and cost stacks, sector ladders, exposure drivers, dividend previews, control thresholds. Derived state, rebuilt every quarter and never accumulated. Null or absent in world version 1.',
      ),

    // --- companies and ownership ---
    companies: z.array(CompanySchema).default([]),
    companyMetrics: z.array(CompanyQuarterMetricsSchema).default([]).describe('Derived metrics for the current quarter, one entry per active company.'),
    capTables: z.array(CapTableSchema).default([]),
    securities: z.array(SecuritySchema).default([]),
    fundingRounds: z.array(FundingRoundSchema).default([]),

    // --- markets and information ---
    marketInstruments: z.array(MarketInstrumentSchema).default([]),
    quotes: z.array(QuoteSchema).default([]).describe('Rolling price history, bounded by quoteHistoryQuarters. Older quotes live in snapshots and the ledger.'),
    quoteHistoryQuarters: z.number().int().min(1).max(80).default(24).describe('How many quarters of quotes to retain in live state.'),
    valuationAnchors: z.array(ValuationAnchorSchema).default([]).describe('Current fundamental anchors, one per company with a priced security.'),
    beliefs: z.array(MarketBeliefSchema).default([]).describe('What the market believes. The share price reflects this, not the canonical database.'),
    disclosures: z.array(PublicDisclosureSchema).default([]).describe('Public information released so far, bounded to a rolling window.'),

    // --- technology ---
    techGraph: TechGraphSchema,
    researchProjects: z.array(ResearchProjectSchema).default([]).describe('Canonical private reality of every research programme, secret ones included.'),

    // --- people ---
    characters: z.array(CharacterSchema).default([]),
    relationships: z.array(RelationshipSchema).default([]).describe('Directional feelings between characters.'),
    memories: z.array(MemorySchema).default([]).describe('What characters remember, with salience already decayed.'),
    accessOverrides: z.array(AccessOverrideSchema).default([]).describe('Active bypasses of the connection gap rule.'),
    conversations: z.array(ConversationMetadataSchema).default([]).describe('Conversation metadata only. Message bodies live in Supabase and stream over Realtime.'),

    // --- governance ---
    boards: z.array(BoardSchema).default([]),
    boardProposals: z.array(BoardProposalSchema).default([]),
    commitments: z.array(StoredCommitmentSchema).default([]).describe('Conditional commitments made in conversation and still live.'),

    // --- government ---
    agencies: z.array(AgencySchema).default([]),
    procurementOpportunities: z.array(ProcurementOpportunitySchema).default([]),
    governmentBids: z.array(StoredGovernmentBidSchema).default([]),
    governmentContracts: z.array(GovernmentContractSchema).default([]),
    contractorReputations: z.array(ContractorReputationSchema).default([]),

    // --- social ---
    socialAccounts: z.array(SocialAccountSchema).default([]),
    socialPosts: z.array(SocialPostSchema).default([]).describe('Published posts, bounded to a rolling window.'),
    mediaStories: z.array(MediaStorySchema).default([]),

    // --- deals ---
    deals: z.array(DealProposalSchema).default([]),

    // --- capital entities (world version 2 and later) ---
    //
    // Optional rather than defaulted, and for exactly the reason the price maps
    // above are: a defaulted array would materialise as `[]` on every frozen
    // world-1 save the moment it parsed, and that world would stop hashing to
    // the value it has always hashed to. A world-1 session grows none of these
    // keys and replays byte-identically. Absent is the neutral reading: no
    // institutions, no shorts, no campaigns, no orders.
    capitalEntities: z
      .array(CapitalEntitySchema)
      .max(MAX_CAPITAL_ENTITIES)
      .optional()
      .describe(
        'The institutions that allocate capital. Each id IS a cap-table holder id already on the registers, so an entity is not a new owner: it is the thing that was always at the other end of those `holderKind: "fund"` holdings. Durable.',
      ),
    shortPositions: z
      .array(ShortPositionSchema)
      .optional()
      .describe(
        'Open cash-settled short exposures. A separate ledger on purpose: a short is never a Holding, never votes and never counts toward an ownership percentage, so the cap-table invariant is untouched. Durable.',
      ),
    activistCampaigns: z
      .array(ActivistCampaignSchema)
      .optional()
      .describe('Open and recently closed activist campaigns. Durable; a closed campaign is pruned ACTIVIST_CAMPAIGN_PRUNE_QUARTERS after it closes, so this stays a phone-sized save.'),
    capitalOrders: z
      .array(CapitalOrderSchema)
      .optional()
      .describe('Orders the capital desks wrote for the open quarter and that have not yet settled. Cleared at ledger_commit, exactly like pendingActions.'),

    // --- participants and pending work ---
    players: z.array(SessionPlayerSchema).default([]),
    pendingActions: z.array(SubmittedActionSchema).default([]).describe('Actions submitted for the open quarter and not yet resolved. Cleared at ledger_commit.'),

    // --- competition ---
    leaderboards: z.array(LeaderboardSchema).default([]).describe('One entry per board, recomputed server-side every quarter from the ledger.'),
    objectives: z.array(SessionObjectiveSchema).default([]),
  })
  .describe(
    'The canonical root aggregate of a session. In production Supabase Postgres holds this; in demo mode the in-memory store does, with the same engine and the same invariants. The client is never authoritative over any part of it.',
  );
export type SessionState = z.infer<typeof SessionStateSchema>;

/**
 * The input type of `SessionStateSchema` — collections may be omitted and are
 * filled with empty arrays. Useful for fixtures and for scenario seed data.
 */
export type SessionStateInput = z.input<typeof SessionStateSchema>;

/* -------------------------------------------------------------------------- */
/*  Typed snapshot                                                             */
/* -------------------------------------------------------------------------- */

/** A quarter snapshot with the state field typed, for callers that need it. */
export const SessionSnapshotSchema = QuarterSnapshotSchema.extend({
  state: SessionStateSchema,
}).describe('A quarter snapshot carrying a fully typed SessionState.');
export type SessionSnapshot = z.infer<typeof SessionSnapshotSchema>;

/* -------------------------------------------------------------------------- */
/*  Read-model projections                                                     */
/* -------------------------------------------------------------------------- */

/**
 * What one player is allowed to see. The engine produces this from
 * `SessionState`; the client never receives the full aggregate, because the full
 * aggregate contains every rival's private research, internal confidence,
 * undisclosed holdings and secret programmes.
 */
/**
 * Full, undredacted detail for one company a seat directs — the founding
 * company or a subsidiary/majority stake reached through `controlledCompaniesOf`.
 *
 * `Company.financialHistory` already travels on `company` itself, so this adds
 * only what is not: the cap table and the research programmes, including
 * secret ones, exactly as `ownCapTable`/`ownResearchProjects` state them for
 * the founding company today.
 */
export const ControlledCompanyViewSchema = z
  .object({
    company: CompanySchema,
    capTable: CapTableSchema,
    researchProjects: z.array(ResearchProjectSchema).describe('Including secret programmes, which only this company can see.'),
  })
  .describe('One company this seat directs, in full.');
export type ControlledCompanyView = z.infer<typeof ControlledCompanyViewSchema>;

export const PlayerViewSchema = z
  .object({
    sessionId: z.string().min(1),
    quarter: QuarterIndexSchema,
    startYear: z.number().int(),
    playerId: z.string().min(1),
    world: WorldStateSchema.describe('The world is shared: every participant sees the same world state.'),
    sectors: SectorStateMapSchema,
    ownCompany: CompanySchema.describe('Full detail for the founding company — the one this seat was created with. Kept stable for compatibility; see controlledCompanies for the rest of the group.'),
    ownCapTable: CapTableSchema,
    ownResearchProjects: z.array(ResearchProjectSchema).describe('Including secret programmes, which only this company can see.'),
    controlledCompanies: z
      .array(ControlledCompanyViewSchema)
      .default([])
      .describe(
        'Every active company this seat directs — the founding company first (also mirrored as ownCompany/ownCapTable/ownResearchProjects for compatibility), then subsidiaries and majority-held companies, oldest acquisition first. Full, undredacted detail for each, because the seat directs them. In a single-sector world this holds exactly the founding company.',
      ),
    visibleCompanies: z
      .array(CompanySchema.partial())
      .describe('Rivals, redacted to what this player could reasonably know: public financials for listed companies, much less for private ones.'),
    techGraph: TechGraphSchema.describe('The Frontier Map with confidenceByCompany reduced to this player\'s own entry and the public figure.'),
    quotes: z.array(QuoteSchema),
    disclosures: z.array(PublicDisclosureSchema).describe('Public information only.'),
    activeEvents: z.array(WorldEventSchema).describe('Events whose visibility reaches this player.'),
    board: BoardSchema.nullable(),
    boardProposals: z.array(BoardProposalSchema),
    opportunities: z.array(ProcurementOpportunitySchema).describe('Opportunities this player can see, which depends on standing and invitations.'),
    contracts: z.array(GovernmentContractSchema),
    deals: z.array(DealProposalSchema).describe('Deals this player is party to.'),
    leaderboards: z.array(LeaderboardSchema),
    objectives: z.array(SessionObjectiveSchema),
    economyReport: EconomyReportSchema.nullable()
      .default(null)
      .describe('The quarter\'s itemised economic attribution, already redacted to this seat: sector ladders and tolls are public, stacks and exposure are the seat\'s own.'),
    alerts: z.array(z.string()).describe('Command Centre alert lines for the open quarter.'),
    eliminatedQuarter: QuarterIndexSchema.nullable()
      .default(null)
      .describe('Quarter this seat was wound up, or null while it is playing. The shell renders the verdict screen rather than the game when it is set.'),
  })
  .describe('The redacted projection sent to one client. Information boundaries are enforced here and again by row-level policy.');
export type PlayerView = z.infer<typeof PlayerViewSchema>;
