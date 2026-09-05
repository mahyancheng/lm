/**
 * @frontier/contracts — ids.ts
 *
 * Identifier aliases and the shared scalar builders used by every other module
 * in this package.
 *
 * Design notes for parallel builders:
 * - Ids are plain `string` at the type level (no zod brands). This keeps them
 *   trivially interoperable across the engine, the LLM gateway, the Next.js app
 *   and Supabase rows. The *semantics* live in the schema description, not in
 *   the type system.
 * - Ids are always deterministic. Never generate one with `Math.random()` or a
 *   timestamp inside the simulation: build them from `makeId()` with stable
 *   inputs (session id, quarter, sequence, subject) so replays reproduce them.
 * - The scalar builders (`unitInterval`, `score100`, ...) exist so that every
 *   numeric field in the game carries an explicit, self-documenting range. The
 *   `.describe()` text is prompt material for the LLM roles, so it is written
 *   for a reader, not for a compiler.
 */

import { z } from 'zod';

/* -------------------------------------------------------------------------- */
/*  Scalar builders                                                            */
/* -------------------------------------------------------------------------- */

/** A normalised 0..1 quantity. The default representation for "how much / how likely". */
export const unitInterval = (description: string) =>
  z.number().min(0).max(1).describe(`${description} Normalised scale, 0..1 inclusive.`);

/** A 0..100 score. Used for reputations, morale, traits and connection levels. */
export const score100 = (description: string) =>
  z.number().min(0).max(100).describe(`${description} Score from 0 (lowest) to 100 (highest).`);

/** A -100..100 score. Used for directional relationships such as "relationship with CEO". */
export const signedScore100 = (description: string) =>
  z.number().min(-100).max(100).describe(`${description} Score from -100 (most negative) to +100 (most positive).`);

/** A -1..1 sentiment/valence value. */
export const bipolarUnit = (description: string) =>
  z.number().min(-1).max(1).describe(`${description} Signed scale, -1 (fully negative) to +1 (fully positive).`);

/** A non-negative United States dollar amount (nominal, not inflation adjusted). */
export const usd = (description: string) =>
  z.number().min(0).finite().describe(`${description} Amount in whole US dollars (not thousands, not millions). Must be >= 0.`);

/** A US dollar amount that may be negative (losses, net cash flow, equity). */
export const signedUsd = (description: string) =>
  z.number().finite().describe(`${description} Amount in whole US dollars (not thousands, not millions). May be negative.`);

/** A non-negative integer count (headcount, units, shares). */
export const intCount = (description: string) =>
  z.number().int().min(0).describe(`${description} Non-negative whole number.`);

/** A rate expressed as a fraction, e.g. 0.045 = 4.5%. Bounds are per-field. */
export const rateFraction = (description: string, min = -1, max = 1) =>
  z
    .number()
    .min(min)
    .max(max)
    .describe(`${description} Expressed as a fraction where 0.045 means 4.5%. Range: ${min}..${max}.`);

/** A percentage expressed 0..100 (used where a human-facing percent reads better). */
export const percent100 = (description: string) =>
  z.number().min(0).max(100).describe(`${description} Percentage from 0 to 100.`);

/* -------------------------------------------------------------------------- */
/*  Time                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The absolute quarter index of a session. Quarter 0 is the first playable
 * quarter of the session; it maps to `startYear Q1`. All simulation timing is
 * expressed in this integer — never in wall-clock time.
 */
export const QuarterIndexSchema = z
  .number()
  .int()
  .min(0)
  .max(4000)
  .describe(
    'Absolute quarter index within the session. 0 is the first quarter of the session (startYear Q1); 5 is the second quarter of the following year. Never a wall-clock date.',
  );
export type QuarterIndex = z.infer<typeof QuarterIndexSchema>;

/** A four-digit calendar year, used by the Frontier Map forecast windows. */
export const CalendarYearSchema = z
  .number()
  .int()
  .min(1900)
  .max(2200)
  .describe('A four-digit calendar year, e.g. 2031.');
export type CalendarYear = z.infer<typeof CalendarYearSchema>;

/** Human-readable quarter label, e.g. "2031 Q2". Deterministic and pure. */
export function quarterLabel(startYear: number, quarter: QuarterIndex): string {
  const year = startYear + Math.floor(quarter / 4);
  const q = (quarter % 4) + 1;
  return `${year} Q${q}`;
}

/** The calendar year a quarter index falls in. Deterministic and pure. */
export function quarterToYear(startYear: number, quarter: QuarterIndex): number {
  return startYear + Math.floor(quarter / 4);
}

/* -------------------------------------------------------------------------- */
/*  Identifier schemas                                                         */
/* -------------------------------------------------------------------------- */

const idSchema = (what: string, example: string) =>
  z
    .string()
    .min(1)
    .max(128)
    .describe(`${what} Opaque stable string identifier, e.g. "${example}".`);

/** A game session: one shared world, one seed, one ledger. */
export const SessionIdSchema = idSchema('Identifier of a game session (one shared world).', 'sess_001');
export type SessionId = z.infer<typeof SessionIdSchema>;

/** A company in the session economy (player-controlled or NPC). */
export const CompanyIdSchema = idSchema('Identifier of a company in the session economy.', 'cmp_nexus_ai');
export type CompanyId = z.infer<typeof CompanyIdSchema>;

/** A person: founder, investor, director, executive, regulator, journalist, researcher, official. */
export const CharacterIdSchema = idSchema('Identifier of a character (a person in the world).', 'chr_maya_chen');
export type CharacterId = z.infer<typeof CharacterIdSchema>;

/** A seat at the table: a human or AI participant that controls a founder character. */
export const PlayerIdSchema = idSchema('Identifier of a session participant (human or AI founder).', 'ply_01');
export type PlayerId = z.infer<typeof PlayerIdSchema>;

/** A specific issuable/tradable claim on a company (a share class instance). */
export const SecurityIdSchema = idSchema('Identifier of a security (a tradable claim on a company).', 'sec_nexus_common');
export type SecurityId = z.infer<typeof SecurityIdSchema>;

/** An awarded government contract. */
export const ContractIdSchema = idSchema('Identifier of an awarded government contract.', 'gct_sov_ai_14');
export type ContractId = z.infer<typeof ContractIdSchema>;

/** A node on the Frontier Map (the session technology graph). */
export const TechNodeIdSchema = idSchema('Identifier of a Frontier Map technology node.', 'tech_autonomous_research_v2');
export type TechNodeId = z.infer<typeof TechNodeIdSchema>;

/** A board proposal put to a vote. */
export const ProposalIdSchema = idSchema('Identifier of a board proposal.', 'prp_acq_vector');
export type ProposalId = z.infer<typeof ProposalIdSchema>;

/** A structured agreement between two actors. */
export const DealIdSchema = idSchema('Identifier of a structured deal between two actors.', 'deal_compute_for_retrieval');
export type DealId = z.infer<typeof DealIdSchema>;

/** A company board. */
export const BoardIdSchema = idSchema('Identifier of a company board.', 'brd_orbit');
export type BoardId = z.infer<typeof BoardIdSchema>;

/** A conversation channel (DM, group, board room, negotiation, Chief of Staff). */
export const ConversationIdSchema = idSchema('Identifier of a conversation channel.', 'cnv_0142');
export type ConversationId = z.infer<typeof ConversationIdSchema>;

/** A row in the append-only simulation ledger. */
export const SimEventIdSchema = idSchema('Identifier of a row in the append-only simulation event ledger.', 'evt_83a2');
export type SimEventId = z.infer<typeof SimEventIdSchema>;

/* --- Secondary ids (same rules, referenced by individual subsystems) ------- */

/** A commercial product sold by a company. */
export const ProductIdSchema = idSchema('Identifier of a company product.', 'prd_enterprise_agent');
export type ProductId = z.infer<typeof ProductIdSchema>;

/** A world event instance generated in a specific quarter. */
export const WorldEventIdSchema = idSchema('Identifier of a world event instance.', 'wev_pkg_disruption_q7');
export type WorldEventId = z.infer<typeof WorldEventIdSchema>;

/** A family/template of related world events (shares hazard, cooldown and cascades). */
export const EventFamilyIdSchema = idSchema('Identifier of a world event family.', 'fam_compute_supply');
export type EventFamilyId = z.infer<typeof EventFamilyIdSchema>;

/** A world modifier instance applied to a target path. */
export const ModifierIdSchema = idSchema('Identifier of a world modifier instance.', 'mod_q7_compute_supply_1');
export type ModifierId = z.infer<typeof ModifierIdSchema>;

/** A government agency. */
export const AgencyIdSchema = idSchema('Identifier of a government agency.', 'agy_defence');
export type AgencyId = z.infer<typeof AgencyIdSchema>;

/** An open procurement opportunity. */
export const OpportunityIdSchema = idSchema('Identifier of a procurement opportunity.', 'opp_sovereign_platform');
export type OpportunityId = z.infer<typeof OpportunityIdSchema>;

/** A submitted government bid. */
export const BidIdSchema = idSchema('Identifier of a submitted government bid.', 'bid_orbit_sov_01');
export type BidId = z.infer<typeof BidIdSchema>;

/** A milestone inside a government contract. */
export const MilestoneIdSchema = idSchema('Identifier of a government contract milestone.', 'mil_sov_ai_14_m2');
export type MilestoneId = z.infer<typeof MilestoneIdSchema>;

/** A quotable instrument on either market plane. */
export const InstrumentIdSchema = idSchema('Identifier of a market instrument.', 'ins_orbit_eq');
export type InstrumentId = z.infer<typeof InstrumentIdSchema>;

/** A share class within a company cap table. */
export const ShareClassIdSchema = idSchema('Identifier of a share class.', 'shc_orbit_common');
export type ShareClassId = z.infer<typeof ShareClassIdSchema>;

/** A single ownership position. */
export const HoldingIdSchema = idSchema('Identifier of an ownership holding.', 'hld_0091');
export type HoldingId = z.infer<typeof HoldingIdSchema>;

/** A closed or in-progress funding round. */
export const FundingRoundIdSchema = idSchema('Identifier of a funding round.', 'rnd_orbit_series_c');
export type FundingRoundId = z.infer<typeof FundingRoundIdSchema>;

/** An internal research programme. */
export const ResearchProjectIdSchema = idSchema('Identifier of a research project.', 'rsp_sparse_inference');
export type ResearchProjectId = z.infer<typeof ResearchProjectIdSchema>;

/** A stored character memory. */
export const MemoryIdSchema = idSchema('Identifier of a character memory.', 'mem_0455');
export type MemoryId = z.infer<typeof MemoryIdSchema>;

/** A social account on a synthetic network. */
export const SocialAccountIdSchema = idSchema('Identifier of a synthetic social network account.', 'soc_maya_fastfeed');
export type SocialAccountId = z.infer<typeof SocialAccountIdSchema>;

/** A published social post. */
export const SocialPostIdSchema = idSchema('Identifier of a published social post.', 'pst_1204');
export type SocialPostId = z.infer<typeof SocialPostIdSchema>;

/** A media story produced by the press layer. */
export const MediaStoryIdSchema = idSchema('Identifier of a media story.', 'sty_orbitleaks');
export type MediaStoryId = z.infer<typeof MediaStoryIdSchema>;

/** A submitted (queued) action awaiting or having completed validation. */
export const ActionIdSchema = idSchema('Identifier of a submitted action.', 'act_q7_0003');
export type ActionId = z.infer<typeof ActionIdSchema>;

/** A logged LLM invocation. */
export const AgentRunIdSchema = idSchema('Identifier of a logged LLM agent run.', 'run_q7_world_director');
export type AgentRunId = z.infer<typeof AgentRunIdSchema>;

/** An industry sector used for sector betas, sentiment and multiples. */
export const SectorIdSchema = idSchema('Identifier of an industry sector.', 'semiconductors');
export type SectorId = z.infer<typeof SectorIdSchema>;

/** A session objective (optional explicit goal). */
export const ObjectiveIdSchema = idSchema('Identifier of a session objective.', 'obj_reach_profitability');
export type ObjectiveId = z.infer<typeof ObjectiveIdSchema>;

/** A public disclosure (guidance, earnings, leak, rumour). */
export const DisclosureIdSchema = idSchema('Identifier of a public disclosure.', 'dsc_q7_guidance');
export type DisclosureId = z.infer<typeof DisclosureIdSchema>;

/** A market belief held about a subject. */
export const BeliefIdSchema = idSchema('Identifier of a market belief.', 'blf_orbit_model_delay');
export type BeliefId = z.infer<typeof BeliefIdSchema>;

/* -------------------------------------------------------------------------- */
/*  Id helpers (deterministic — safe inside the engine)                        */
/* -------------------------------------------------------------------------- */

/**
 * Canonical prefixes. Ids are conventionally `<prefix>_<slug parts>`.
 * The engine may use any scheme it likes as long as it is deterministic, but
 * consistency here keeps ledger dumps readable.
 */
export const ID_PREFIXES = {
  session: 'sess',
  company: 'cmp',
  character: 'chr',
  player: 'ply',
  security: 'sec',
  contract: 'gct',
  techNode: 'tech',
  proposal: 'prp',
  deal: 'deal',
  board: 'brd',
  conversation: 'cnv',
  simEvent: 'evt',
  product: 'prd',
  worldEvent: 'wev',
  eventFamily: 'fam',
  modifier: 'mod',
  agency: 'agy',
  opportunity: 'opp',
  bid: 'bid',
  milestone: 'mil',
  instrument: 'ins',
  shareClass: 'shc',
  holding: 'hld',
  fundingRound: 'rnd',
  researchProject: 'rsp',
  memory: 'mem',
  socialAccount: 'soc',
  socialPost: 'pst',
  mediaStory: 'sty',
  action: 'act',
  agentRun: 'run',
  objective: 'obj',
  disclosure: 'dsc',
  belief: 'blf',
} as const;

export type IdPrefixKey = keyof typeof ID_PREFIXES;
export type IdPrefix = (typeof ID_PREFIXES)[IdPrefixKey];

/** Lower-case, underscore-separated, ASCII-safe slug. Deterministic and pure. */
export function slugify(input: string): string {
  return input
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 96);
}

/**
 * Build a deterministic id from stable parts.
 *
 * `makeId('evt', 'sess_001', 17, 844)` → `"evt_sess_001_17_844"`.
 *
 * Never feed this `Date.now()`, `Math.random()` or any wall-clock value: the
 * ledger must reproduce byte-for-byte on replay.
 */
export function makeId(prefix: IdPrefix | string, ...parts: readonly (string | number)[]): string {
  const tail = parts.map((p) => (typeof p === 'number' ? String(p) : slugify(p))).filter((p) => p.length > 0);
  return [prefix, ...tail].join('_');
}

/** True when `value` carries the given prefix. */
export function hasIdPrefix(value: string, prefix: IdPrefix | string): boolean {
  return value.startsWith(`${prefix}_`);
}

/** The leading prefix segment of an id, or `null` when there is none. */
export function idPrefixOf(value: string): string | null {
  const i = value.indexOf('_');
  return i > 0 ? value.slice(0, i) : null;
}
