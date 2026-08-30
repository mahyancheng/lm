/**
 * @frontier/contracts — people.ts
 *
 * Characters, relationships, memory and the connection hierarchy.
 *
 * Two concepts are deliberately kept apart:
 *
 * - **Connection Level** — how socially and institutionally powerful a person
 *   is. It gates who may open a conversation with whom.
 * - **Relationship** — how one specific actor feels about another. It shapes how
 *   that conversation goes.
 *
 * A new founder on 17 cannot open a direct channel to a sovereign-fund chief on
 * 93. They can build a relationship with a partner who can, earn an
 * introduction, and convert a temporary access grant into a permanent
 * relationship. Networking is gameplay, not a number to grind.
 *
 * Bots use the same access model. A rival chief executive may decide the player
 * has become important enough to contact personally.
 */

import { z } from 'zod';
import { QuarterIndexSchema, bipolarUnit, score100, unitInterval, usd } from './ids';

/* -------------------------------------------------------------------------- */
/*  Characters                                                                 */
/* -------------------------------------------------------------------------- */

export const CHARACTER_ROLES = ['founder_ceo', 'investor', 'director', 'executive', 'regulator', 'journalist', 'researcher', 'official'] as const;

export const CharacterRoleSchema = z
  .enum(CHARACTER_ROLES)
  .describe(
    'What this person does. founder_ceo runs a company; investor allocates capital and takes board seats; director sits on boards; executive holds a C-suite post; regulator writes and enforces rules; journalist amplifies and investigates; researcher advances and evaluates the frontier; official buys on behalf of government.',
  );
export type CharacterRole = z.infer<typeof CharacterRoleSchema>;

export const StableTraitsSchema = z
  .object({
    riskTolerance: score100('Appetite for variance. High-tolerance characters take leveraged bets and forgive failure in others.'),
    technicalOrientation: score100('Depth of technical judgement. High values evaluate a claim on its merits rather than on who made it.'),
    financialConservatism: score100('Attention to cash, dilution and downside. High values resist expensive expansion.'),
    aggressiveness: score100('Willingness to attack, poach, litigate and escalate publicly.'),
    statusSensitivity: score100('How much perceived slights and public standing matter. High values remember being embarrassed for a long time.'),
  })
  .describe('Traits that do not change over a session. They are the personality behind every decision this character makes and every reply they give.');
export type StableTraits = z.infer<typeof StableTraitsSchema>;

export const BELIEF_TOPICS = [
  'compute_scarcity',
  'player_technical_ability',
  'player_trustworthiness',
  'ai_regulation_risk',
  'market_bubble',
  'open_source_threat',
  'safety_priority',
  'talent_war',
  'government_demand',
  'geopolitical_risk',
  'frontier_progress',
  'consolidation_inevitable',
] as const;

export const BeliefTopicSchema = z.enum(BELIEF_TOPICS).describe('A subject this character holds a view about. Views change with what they observe and what they are told.');
export type BeliefTopic = z.infer<typeof BeliefTopicSchema>;

export const BELIEF_LEVELS = ['low', 'medium', 'high'] as const;
export const BeliefLevelSchema = z.enum(BELIEF_LEVELS).describe('How strongly the character holds the belief. Deliberately coarse: characters hold opinions, not probabilities.');
export type BeliefLevel = z.infer<typeof BeliefLevelSchema>;

export const CharacterBeliefSchema = z
  .object({
    topic: BeliefTopicSchema,
    level: BeliefLevelSchema,
  })
  .describe('One belief held by a character.');
export type CharacterBelief = z.infer<typeof CharacterBeliefSchema>;

export const CharacterSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1).max(80).describe('Full name as everybody in the world knows them.'),
    role: CharacterRoleSchema,
    companyId: z.string().nullable().describe('Company they belong to, or null for regulators, journalists and independents.'),
    title: z.string().max(80).describe('Their stated job title, e.g. "CEO — Nexus Intelligence".'),
    stableTraits: StableTraitsSchema,
    beliefs: z.array(CharacterBeliefSchema).describe('Current views. Updated by what they witness and by what people they trust tell them.'),
    connectionLevel: score100(
      'How socially and institutionally powerful this person is. Computed from founder reputation, company significance, personal wealth, board seats, investor relationships, government credibility, media influence, prior exits, public following and the quality of their mutual relationships. It is emphatically not follower count.',
    ),
    isPlayer: z.boolean().describe('True when a session participant controls this character. NPC characters must be labelled as AI-generated wherever their messages appear.'),
    personalWealthUsd: usd('Personal net worth, driven principally by holdings. The Founder Wealth leaderboard reads this.'),
    boardSeatCount: z.number().int().min(0).max(20).describe('How many boards they sit on. A major input to connection level and to market influence.'),
    publicFollowing: z.number().min(0).describe('Aggregate social following across networks. Contributes to connection level but does not determine it.'),
    isActive: z.boolean().describe('False once they have left the industry.'),
  })
  .describe('A person in the world. Conversations with them emerge from this state, not from a generic persona prompt.');
export type Character = z.infer<typeof CharacterSchema>;

/* -------------------------------------------------------------------------- */
/*  Relationships                                                              */
/* -------------------------------------------------------------------------- */

export const RelationshipSchema = z
  .object({
    fromId: z.string().min(1).describe('The character holding the feeling. Relationships are directional: A can respect B while B is indifferent to A.'),
    toId: z.string().min(1).describe('The character the feeling is about.'),
    trust: score100('Belief that this person keeps their word. Broken commitments destroy it faster than kept ones build it.'),
    respect: score100('Regard for their competence and judgement. A rival can respect the player deeply while trusting them not at all.'),
    hostility: score100('Active antagonism. High hostility makes cooperation expensive but does not make it impossible.'),
    dependence: score100('How much they need this person: for capital, compute, distribution, or a vote.'),
    lastInteractionQuarter: QuarterIndexSchema.nullable().describe('Quarter of the last direct contact, or null if they have never spoken.'),
    interactionCount: z.number().int().min(0).describe('How many times they have dealt with each other.'),
  })
  .describe('How one character regards another. Four independent dimensions, because "likes you" is not one number.');
export type Relationship = z.infer<typeof RelationshipSchema>;

/* -------------------------------------------------------------------------- */
/*  Memory                                                                     */
/* -------------------------------------------------------------------------- */

export const MEMORY_KINDS = [
  'betrayal',
  'favour',
  'deal_kept',
  'deal_broken',
  'poach',
  'public_attack',
  'public_support',
  'negotiation',
  'meeting',
  'introduction',
  'investment',
  'board_vote',
  'contract_win',
  'contract_loss',
  'media_moment',
  'personal',
] as const;

export const MemoryKindSchema = z.enum(MEMORY_KINDS).describe('What sort of event is remembered. Betrayals and broken deals decay far more slowly than favours.');
export type MemoryKind = z.infer<typeof MemoryKindSchema>;

export const MemorySchema = z
  .object({
    id: z.string().min(1),
    ownerCharacterId: z.string().min(1).describe('Who remembers it.'),
    aboutId: z.string().min(1).describe('Who or what it is about: a character id or a company id.'),
    quarter: QuarterIndexSchema.describe('Quarter it happened.'),
    kind: MemoryKindSchema,
    summary: z.string().min(5).max(300).describe('One sentence in the rememberer\'s own framing, e.g. "Player poached two of my researchers during the compute shortage."'),
    sentiment: bipolarUnit('How the rememberer feels about it, -1 (bitter) to +1 (grateful).'),
    decayRate: unitInterval('How fast it fades per quarter. 0 never fades; 0.25 is largely forgotten within a year. Betrayals should be set near 0.'),
    strength: unitInterval('Current salience after decay. Once it falls below the recall threshold the memory stops being supplied to dialogue.'),
  })
  .describe('One thing a character remembers. Memories are what make an NPC say "you supported us in the regulatory hearing" three years later.');
export type Memory = z.infer<typeof MemorySchema>;

/** Below this salience a memory is no longer supplied to the dialogue agent. */
export const MEMORY_RECALL_THRESHOLD = 0.08;

/** Draft memory produced by a dialogue agent; the engine assigns id and decay. */
export const MemoryDraftSchema = z
  .object({
    kind: MemoryKindSchema,
    summary: z.string().min(5).max(300).describe('One sentence, written from the remembering character\'s point of view.'),
    sentiment: bipolarUnit('How they feel about it.'),
  })
  .describe('A memory a character wants to store after a conversation. LLM-facing.');
export type MemoryDraft = z.infer<typeof MemoryDraftSchema>;

/* -------------------------------------------------------------------------- */
/*  Connection hierarchy and access                                            */
/* -------------------------------------------------------------------------- */

/**
 * The access rule.
 *
 * `gap = |connectionA - connectionB|`. When `gap <= 10` either party may open a
 * conversation. When the gap is larger, only the higher-connection actor may
 * initiate, and only downward. Everything else requires an access override.
 */
export const CONNECTION_GAP_RULE = {
  symmetricGap: 10,
  statement:
    'When |connectionLevel(a) - connectionLevel(b)| <= 10, either party may initiate contact. Above that gap, only the higher-connection actor may initiate, downward. A lower-connection actor reaches upward only through an access override.',
  rationale:
    'This is what stops a first-quarter founder from opening a direct channel to the most influential investor in the economy, while leaving a real path: build a relationship with someone in between and earn an introduction.',
} as const;

/** Pure, deterministic access check. Does not consider overrides. */
export function canInitiateContact(initiatorConnection: number, targetConnection: number): boolean {
  const gap = Math.abs(initiatorConnection - targetConnection);
  if (gap <= CONNECTION_GAP_RULE.symmetricGap) return true;
  return initiatorConnection > targetConnection;
}

export const ACCESS_OVERRIDE_KINDS = [
  'shared_board',
  'shared_investor',
  'consortium',
  'introduction',
  'conference',
  'negotiation',
  'litigation',
  'media',
] as const;

export const AccessOverrideKindSchema = z
  .enum(ACCESS_OVERRIDE_KINDS)
  .describe(
    'Why the connection gap is being bypassed. shared_board and shared_investor are structural and last while the shared position does. consortium and negotiation last for the transaction. introduction is a favour someone did, and is the main way a low-status founder engineers a route upward. conference is a time-boxed window. litigation and media force contact whether either party wants it.',
  );
export type AccessOverrideKind = z.infer<typeof AccessOverrideKindSchema>;

export const AccessOverrideSchema = z
  .object({
    id: z.string().min(1),
    kind: AccessOverrideKindSchema,
    fromId: z.string().min(1).describe('Character granted the ability to initiate.'),
    toId: z.string().min(1).describe('Character who becomes reachable.'),
    grantedQuarter: QuarterIndexSchema,
    expiresQuarter: QuarterIndexSchema.nullable().describe('Quarter the override lapses, or null when permanent.'),
    isPermanent: z.boolean().describe('True once a good interaction has converted temporary access into a standing relationship.'),
    grantedByCharacterId: z.string().nullable().describe('Who made the introduction, or null for structural overrides. The introducer takes a reputational stake in how it goes.'),
    reason: z.string().max(240).describe('Player-readable explanation shown on the Network screen.'),
  })
  .describe('A temporary or permanent bypass of the connection gap rule.');
export type AccessOverride = z.infer<typeof AccessOverrideSchema>;

export const AccessDecisionSchema = z
  .object({
    allowed: z.boolean(),
    reason: z.string().describe('Why contact is or is not permitted, in player-readable language.'),
    overrideId: z.string().nullable().describe('Override that permitted it, or null when the gap rule allowed it directly.'),
    gap: z.number().min(0).max(100).describe('The absolute connection gap between the two characters.'),
  })
  .describe('The result of an access check between two characters.');
export type AccessDecision = z.infer<typeof AccessDecisionSchema>;

/* -------------------------------------------------------------------------- */
/*  Connection level inputs                                                    */
/* -------------------------------------------------------------------------- */

export const ConnectionLevelInputsSchema = z
  .object({
    characterId: z.string().min(1),
    founderReputation: unitInterval('Standing as an operator, normalised across the session.'),
    companySignificance: unitInterval('Significance of the company they run or represent.'),
    personalWealth: unitInterval('Personal wealth percentile within the session.'),
    boardPositions: unitInterval('Board seats held, normalised.'),
    investorRelationships: unitInterval('Depth and quality of investor relationships.'),
    governmentCredibility: unitInterval('Standing with public buyers and regulators.'),
    mediaInfluence: unitInterval('Ability to place and shape a story.'),
    priorExits: unitInterval('Track record of previous outcomes.'),
    publicFollowing: unitInterval('Audience size, normalised. Deliberately one input among ten.'),
    mutualRelationshipQuality: unitInterval('Quality of high-value mutual relationships. Knowing three powerful people well counts for more than knowing thirty slightly.'),
    computedLevel: score100('The resulting connection level.'),
  })
  .describe('The inputs behind a connection level, kept so the Network screen can explain why one founder outranks another.');
export type ConnectionLevelInputs = z.infer<typeof ConnectionLevelInputsSchema>;

/* -------------------------------------------------------------------------- */
/*  Conversations                                                              */
/* -------------------------------------------------------------------------- */

export const CONVERSATION_KINDS = ['direct_message', 'group', 'boardroom', 'negotiation', 'chief_of_staff', 'press', 'regulator_meeting'] as const;
export const ConversationKindSchema = z.enum(CONVERSATION_KINDS).describe('What sort of channel this is. Each has its own access rules and its own moderation posture.');
export type ConversationKind = z.infer<typeof ConversationKindSchema>;

export const ConversationMetadataSchema = z
  .object({
    id: z.string().min(1),
    sessionId: z.string().min(1),
    kind: ConversationKindSchema,
    participantCharacterIds: z.array(z.string()).min(1).describe('Everyone in the channel. Access is enforced server-side by row-level policy, not by hiding the UI.'),
    createdQuarter: QuarterIndexSchema,
    lastMessageQuarter: QuarterIndexSchema.nullable(),
    accessOverrideId: z.string().nullable().describe('Override that permitted this conversation to exist, or null.'),
    dealProposalIds: z.array(z.string()).describe('Structured deals that came out of this conversation. Free text never binds; only an accepted structured proposal does.'),
    isModerated: z.boolean().describe('All player-to-player channels are account-bound, reportable and blockable. NPC participants are labelled as AI-generated characters.'),
    messageCount: z.number().int().min(0),
  })
  .describe('Metadata for a conversation channel. Message bodies live in Supabase and stream over Realtime Broadcast; only this metadata belongs in session state.');
export type ConversationMetadata = z.infer<typeof ConversationMetadataSchema>;
