/**
 * @frontier/contracts — social.ts
 *
 * Marketing as an information network rather than a single modifier.
 *
 * The division of labour is strict: **an LLM writes the post, the engine decides
 * what it does.** Reach is credibility multiplied by the follower graph,
 * relevance and novelty. Sentiment shifts are computed, not asserted. A model
 * cannot declare that developer sentiment rose twelve points; it can only write
 * something that the engine then propagates.
 *
 * Social is also the public-information bridge to the market. A rumour moves a
 * price only to the extent investors believe it, and belief is stored separately
 * from truth in `markets.ts`.
 */

import { z } from 'zod';
import { QuarterIndexSchema, unitInterval } from './ids';

/* -------------------------------------------------------------------------- */
/*  Networks and audiences                                                     */
/* -------------------------------------------------------------------------- */

export const NETWORK_ARCHETYPES = ['fast_feed', 'professional', 'technical_forum', 'community', 'video', 'finance'] as const;

export const NetworkArchetypeSchema = z
  .enum(NETWORK_ARCHETYPES)
  .describe(
    'Which synthetic platform this concerns, and therefore which audiences are reached. fast_feed carries journalists, investors, founders and consumers. professional carries executives, enterprise buyers and employees. technical_forum carries engineers, researchers and developers. community carries enthusiasts, critics and customers. video carries mass consumers and creators. finance carries retail investors, analysts and traders.',
  );
export type NetworkArchetype = z.infer<typeof NetworkArchetypeSchema>;

export const AUDIENCES = ['developers', 'enterprise', 'consumers', 'investors', 'regulators', 'media', 'talent'] as const;

export const AudienceSchema = z
  .enum(AUDIENCES)
  .describe('A distinct constituency whose sentiment can move independently. The same post can delight developers and alarm regulators in the same quarter.');
export type Audience = z.infer<typeof AudienceSchema>;

/* -------------------------------------------------------------------------- */
/*  Accounts                                                                   */
/* -------------------------------------------------------------------------- */

export const SocialAccountSchema = z
  .object({
    id: z.string().min(1),
    network: NetworkArchetypeSchema,
    handle: z.string().min(1).max(40).describe('Display handle, e.g. "@maya_chen".'),
    ownerCharacterId: z.string().nullable().describe('Character who owns the account, or null for a corporate account.'),
    ownerCompanyId: z.string().nullable().describe('Company that owns the account, or null for a personal account.'),
    followers: z.number().min(0).describe('Follower count on this network.'),
    credibility: unitInterval('How much weight this account\'s statements carry. Built by being right in public and destroyed by denials that later prove false.'),
    verified: z.boolean().describe('Whether the account is verified. Unverified accounts carry a credibility penalty when they break news.'),
    audienceMix: z
      .record(z.string(), unitInterval('Share of this account\'s followers who belong to that audience.'))
      .describe('Follower composition keyed by audience (see AUDIENCES). Shares should sum to roughly 1. Determines who actually hears a post.'),
    isActive: z.boolean(),
  })
  .describe('One account on one synthetic network.');
export type SocialAccount = z.infer<typeof SocialAccountSchema>;

/* -------------------------------------------------------------------------- */
/*  Post drafts (LLM-facing)                                                   */
/* -------------------------------------------------------------------------- */

export const POST_INTENTS = ['announce', 'attack', 'defend', 'recruit', 'hype', 'apologise', 'leak'] as const;

export const PostIntentSchema = z
  .enum(POST_INTENTS)
  .describe(
    'What the post is trying to do. The engine reads intent, not the prose: "attack" raises competitor hostility and press pickup; "apologise" partially recovers public sentiment at a cost to investor confidence; "leak" carries a chance of being traced back to the author.',
  );
export type PostIntent = z.infer<typeof PostIntentSchema>;

export const SocialPostDraftSchema = z
  .object({
    authorCharacterId: z.string().min(1).describe('The character speaking. Their credibility and following determine reach; their traits should determine tone.'),
    network: NetworkArchetypeSchema,
    text: z
      .string()
      .min(1)
      .max(560)
      .describe('The post itself, at most 560 characters. Write it as this specific person would write it on this specific network. Do not state outcomes ("this will move our stock"); state positions.'),
    intent: PostIntentSchema,
    targetCompanyId: z.string().nullable().describe('Company the post is aimed at, or null when it is not about a specific rival.'),
  })
  .describe('A post an LLM has drafted. Reach, engagement and every sentiment consequence are computed by the engine from this typed object — the text alone changes nothing.');
export type SocialPostDraft = z.infer<typeof SocialPostDraftSchema>;

/* -------------------------------------------------------------------------- */
/*  Engagement                                                                 */
/* -------------------------------------------------------------------------- */

export const SentimentShiftSchema = z
  .object({
    audience: AudienceSchema,
    delta: z.number().min(-20).max(20).describe('Change in that audience\'s sentiment toward the author\'s company, -20..20 points on the 0-100 reputation scale.'),
  })
  .describe('One audience\'s reaction.');
export type SentimentShift = z.infer<typeof SentimentShiftSchema>;

export const EngagementResultSchema = z
  .object({
    postId: z.string().min(1),
    quarter: QuarterIndexSchema,
    reach: z.number().min(0).describe('People who saw it. Computed as credibility times follower graph times relevance times novelty — never asserted by a model.'),
    engagementScore: unitInterval('How strongly the audience responded relative to reach.'),
    sentimentShifts: z.array(SentimentShiftSchema).describe('Per-audience consequences. An open-weights announcement can raise developer sentiment sharply, raise investor margin concern, and raise competitor hostility, all at once.'),
    pressPickup: z.boolean().describe('Whether the press amplified it into a story, which multiplies reach and takes the message out of the author\'s control.'),
    viralityFactor: z.number().min(0).max(10).describe('Multiplier applied to base reach by resharing. 1.0 is normal; above 4 the post has escaped its original audience.'),
    competitorHostilityDelta: z.number().min(-20).max(20).describe('Change in the targeted company\'s hostility toward the author.'),
  })
  .describe('What a post actually did. Every number here is engine output.');
export type EngagementResult = z.infer<typeof EngagementResultSchema>;

/* -------------------------------------------------------------------------- */
/*  Stored posts                                                               */
/* -------------------------------------------------------------------------- */

export const SocialPostSchema = SocialPostDraftSchema.extend({
  id: z.string().min(1),
  accountId: z.string().min(1).describe('Account it was published from.'),
  quarter: QuarterIndexSchema,
  engagement: EngagementResultSchema.nullable().describe('Null until the social phase of the quarter has resolved.'),
  isAiGenerated: z.boolean().describe('True for NPC characters. Their posts must be visibly labelled as AI-generated wherever they appear.'),
  reportedCount: z.number().int().min(0).describe('Moderation reports received. Player content is account-bound, reportable and blockable.'),
  replyToPostId: z
    .string()
    .nullable()
    .default(null)
    .describe(
      'The post this one answers, or null for a top-level post. A reply and its parent form a thread; the engine only ever creates a reply on the same network as its parent, in the same quarter. Defaults to null so a save written before threads existed parses unchanged.',
    ),
}).describe('A published post in the session state.');
export type SocialPost = z.infer<typeof SocialPostSchema>;

/* -------------------------------------------------------------------------- */
/*  Model-written prose over engine-authored posts                             */
/* -------------------------------------------------------------------------- */

/**
 * One engine-authored post whose *words* a model wrote.
 *
 * The engine decides that a post happens, who makes it, on which network, with
 * which typed intent and aimed at whom, and it writes a template line so the
 * quarter reads the same with no model at all. When a model is configured, a
 * capped handful of those lines are rewritten in the author's voice — and
 * nothing else about the post may change, which is why this carries a post id
 * and a string and not a draft.
 *
 * It is recorded alongside the quarter's other agent inputs so a replay
 * reproduces the words as well as the numbers.
 */
export const SocialTextOverrideSchema = z
  .object({
    postId: z.string().min(1).describe('The engine-authored post whose text is being replaced. A post the engine did not author is never eligible.'),
    text: z.string().min(1).max(560).describe('The prose the model supplied, at most 560 characters. Replaces the template line and nothing else.'),
  })
  .describe('Model-written words over one engine-authored post. Never a new post, never a changed intent, never a number.');
export type SocialTextOverride = z.infer<typeof SocialTextOverrideSchema>;

/* -------------------------------------------------------------------------- */
/*  Media stories                                                              */
/* -------------------------------------------------------------------------- */

export const STORY_ANGLES = [
  'breakthrough',
  'scandal',
  'financial_analysis',
  'human_interest',
  'regulatory',
  'competitive',
  'safety_concern',
  'labour',
  'geopolitical',
  'profile',
] as const;

export const StoryAngleSchema = z.enum(STORY_ANGLES).describe('The frame a story takes. The world\'s dominant narrative biases which angle the press reaches for.');
export type StoryAngle = z.infer<typeof StoryAngleSchema>;

export const MediaStorySchema = z
  .object({
    id: z.string().min(1),
    quarter: QuarterIndexSchema,
    headline: z.string().min(5).max(160),
    body: z.string().max(1500).describe('The story as published.'),
    angle: StoryAngleSchema,
    prominence: unitInterval('How much attention the story commands. Scales with world.media.attentionLevel and the subject\'s significance.'),
    subjectCompanyIds: z.array(z.string()),
    subjectCharacterIds: z.array(z.string()),
    sourcePostIds: z.array(z.string()).describe('Posts that triggered the coverage, if any.'),
    sourceEventId: z.string().nullable().describe('World event that triggered the coverage, or null.'),
    credibility: unitInterval('How much the market believes the story. Feeds directly into belief updates and therefore into price.'),
    sentiment: z.number().min(-1).max(1).describe('Tone toward the subject, -1 (hostile) to +1 (favourable).'),
    reach: z.number().min(0).describe('Audience reached.'),
    authorCharacterId: z.string().nullable().describe('Journalist who wrote it, or null for wire coverage. Journalists remember how they were treated.'),
  })
  .describe('A press story. Stories are how a private matter becomes a public information event, and therefore how it reaches the share price.');
export type MediaStory = z.infer<typeof MediaStorySchema>;

/* -------------------------------------------------------------------------- */
/*  Structured campaigns                                                       */
/* -------------------------------------------------------------------------- */

export const CAMPAIGN_THEMES = ['brand', 'performance', 'developer_relations', 'thought_leadership', 'crisis_response', 'recruitment'] as const;

export const CampaignThemeSchema = z
  .enum(CAMPAIGN_THEMES)
  .describe(
    'The structured alternative to posting personally. brand builds slow public reputation; performance buys measurable demand; developer_relations builds the API ecosystem; thought_leadership targets enterprise and government; crisis_response defends after an incident; recruitment targets the talent audience.',
  );
export type CampaignTheme = z.infer<typeof CampaignThemeSchema>;

export const MarketingCampaignSchema = z
  .object({
    id: z.string().min(1),
    companyId: z.string().min(1),
    theme: CampaignThemeSchema,
    segment: z.enum(['consumer', 'enterprise', 'developer_api', 'government']).describe('Product segment the campaign supports.'),
    budgetUsd: z.number().min(0).describe('Total spend across the campaign.'),
    quarters: z.number().int().min(1).max(8).describe('How long it runs.'),
    startedQuarter: QuarterIndexSchema,
    reachedAudiences: z.array(AudienceSchema).describe('Audiences the campaign actually reached, computed by the engine.'),
    effectivenessScore: unitInterval('How well it landed, given competing attention, message fit and the dominant narrative.'),
  })
  .describe('A structured marketing campaign executed by the communications team, as opposed to the founder posting personally.');
export type MarketingCampaign = z.infer<typeof MarketingCampaignSchema>;
