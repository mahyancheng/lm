/**
 * @frontier/simulation — social/reach.ts
 *
 * Marketing as an information network rather than a single modifier.
 *
 * The division of labour is strict: **an LLM writes the post, the engine decides
 * what it does.** Reach is credibility multiplied by the follower graph,
 * relevance and novelty. Sentiment shifts are computed from the typed intent and
 * the account's audience mix, never asserted by a model. A model cannot declare
 * that developer sentiment rose twelve points; it can only write something the
 * engine then propagates.
 *
 * The second rule this file enforces is the information boundary. A post never
 * touches canonical truth and never touches `beliefs`. What it can do is create
 * a `PublicDisclosure` — a press release, a rumour, a leak — carrying a
 * credibility figure. The market phase reads disclosures and moves beliefs.
 * That is the only path from something somebody said to something a price knows.
 */

import type {
  Audience,
  EngagementResult,
  NetworkArchetype,
  PostIntent,
  PublicDisclosure,
  ResolverContext,
  SeededRng,
  SentimentShift,
  SessionState,
  SocialAccount,
  SocialPost,
  SubmittedAction,
} from '@frontier/contracts';
import { makeId } from '@frontier/contracts';
import { rememberEvent, ceoOf } from '../relationships/relations';
import { characterById, clamp, companyById, emitEvent, line, ratio, reachLabel, round, score100, unit } from './util';

/* -------------------------------------------------------------------------- */
/*  Networks                                                                   */
/* -------------------------------------------------------------------------- */

export interface NetworkProfile {
  /** People reachable on this network at neutral attention. */
  readonly baseAudience: number;
  /** Follower composition of a typical account here. Shares sum to about 1. */
  readonly audienceMix: Readonly<Record<Audience, number>>;
  /** How readily material is reshared here. */
  readonly virality: number;
  /** How closely the press watches this network. */
  readonly pressAffinity: number;
  /** Share of a person's total following that lives here. */
  readonly followerShare: number;
}

export const NETWORK_PROFILES: Record<NetworkArchetype, NetworkProfile> = {
  fast_feed: {
    baseAudience: 40_000_000,
    audienceMix: { developers: 0.15, enterprise: 0.06, consumers: 0.3, investors: 0.15, regulators: 0.04, media: 0.18, talent: 0.12 },
    virality: 1.4,
    pressAffinity: 0.35,
    followerShare: 0.45,
  },
  professional: {
    baseAudience: 18_000_000,
    audienceMix: { developers: 0.12, enterprise: 0.3, consumers: 0.0, investors: 0.15, regulators: 0.08, media: 0.1, talent: 0.25 },
    virality: 0.8,
    pressAffinity: 0.2,
    followerShare: 0.2,
  },
  technical_forum: {
    baseAudience: 6_000_000,
    audienceMix: { developers: 0.55, enterprise: 0.1, consumers: 0.0, investors: 0.05, regulators: 0.03, media: 0.07, talent: 0.2 },
    virality: 0.9,
    pressAffinity: 0.15,
    followerShare: 0.12,
  },
  community: {
    baseAudience: 12_000_000,
    audienceMix: { developers: 0.2, enterprise: 0.07, consumers: 0.45, investors: 0.0, regulators: 0.04, media: 0.12, talent: 0.12 },
    virality: 1.1,
    pressAffinity: 0.18,
    followerShare: 0.1,
  },
  video: {
    baseAudience: 60_000_000,
    audienceMix: { developers: 0.1, enterprise: 0.02, consumers: 0.6, investors: 0.04, regulators: 0.02, media: 0.12, talent: 0.1 },
    virality: 1.6,
    pressAffinity: 0.22,
    followerShare: 0.08,
  },
  finance: {
    baseAudience: 9_000_000,
    audienceMix: { developers: 0.0, enterprise: 0.15, consumers: 0.07, investors: 0.5, regulators: 0.08, media: 0.2, talent: 0.0 },
    virality: 1.0,
    pressAffinity: 0.3,
    followerShare: 0.05,
  },
};

/* -------------------------------------------------------------------------- */
/*  Intents                                                                    */
/* -------------------------------------------------------------------------- */

export interface IntentProfile {
  /** Point movement per audience at the reference reach. */
  readonly audienceEffects: Partial<Record<Audience, number>>;
  /** How relevant this intent is on each network, 0..1. */
  readonly networkFit: Partial<Record<NetworkArchetype, number>>;
  readonly virality: number;
  readonly pressBias: number;
  /** How much this intent heats the controversy cycle at reference reach. */
  readonly controversy: number;
  /** Hostility the targeted company's leadership takes on, at reference reach. */
  readonly hostility: number;
}

/**
 * The engine reads intent, not prose. "attack" raises competitor hostility and
 * press pickup; "apologise" partially recovers public sentiment at a cost to
 * investor confidence; "leak" travels furthest and costs the most.
 */
export const INTENT_PROFILES: Record<PostIntent, IntentProfile> = {
  announce: {
    audienceEffects: { developers: 2, enterprise: 1.5, investors: 1, media: 0.5, consumers: 0.5 },
    networkFit: { fast_feed: 0.8, professional: 0.9, technical_forum: 0.85, community: 0.6, video: 0.6, finance: 0.7 },
    virality: 1,
    pressBias: 0.15,
    controversy: 0,
    hostility: 0,
  },
  attack: {
    // The press pays attention (see pressBias); the audiences that matter do
    // not reward it. Attention is not approval.
    audienceEffects: { media: 0.5, investors: -0.5, developers: -1, consumers: -1, talent: -0.5 },
    networkFit: { fast_feed: 1, professional: 0.4, technical_forum: 0.5, community: 0.7, video: 0.8, finance: 0.6 },
    virality: 1.5,
    pressBias: 0.35,
    controversy: 0.03,
    hostility: 8,
  },
  defend: {
    audienceEffects: { investors: 0.5, enterprise: 0.5, consumers: 0.3, media: -0.5 },
    networkFit: { fast_feed: 0.8, professional: 0.8, technical_forum: 0.6, community: 0.7, video: 0.6, finance: 0.8 },
    virality: 0.9,
    pressBias: 0.2,
    controversy: 0.01,
    hostility: 1,
  },
  recruit: {
    audienceEffects: { talent: 3, developers: 1, enterprise: 0.2 },
    networkFit: { fast_feed: 0.5, professional: 1, technical_forum: 0.9, community: 0.5, video: 0.4, finance: 0.2 },
    virality: 0.8,
    pressBias: 0.05,
    controversy: 0,
    hostility: 0,
  },
  hype: {
    audienceEffects: { consumers: 2, investors: 1.5, media: 1, developers: -1, regulators: -0.5 },
    networkFit: { fast_feed: 1, professional: 0.5, technical_forum: 0.3, community: 0.8, video: 0.9, finance: 0.9 },
    virality: 1.3,
    pressBias: 0.2,
    controversy: 0.01,
    hostility: 1,
  },
  apologise: {
    audienceEffects: { consumers: 1.5, regulators: 2, media: 0.5, talent: 0.5, investors: -2 },
    networkFit: { fast_feed: 0.9, professional: 0.8, technical_forum: 0.5, community: 0.8, video: 0.7, finance: 0.7 },
    virality: 1.2,
    pressBias: 0.4,
    controversy: 0.02,
    hostility: -2,
  },
  leak: {
    audienceEffects: { media: 0.5, developers: 0.5, enterprise: -1.5, investors: -1, regulators: -2 },
    networkFit: { fast_feed: 1, professional: 0.5, technical_forum: 0.7, community: 0.6, video: 0.5, finance: 0.9 },
    virality: 1.8,
    pressBias: 0.5,
    controversy: 0.04,
    hostility: 10,
  },
};

/* -------------------------------------------------------------------------- */
/*  Balancing constants                                                        */
/* -------------------------------------------------------------------------- */

/** Reach at which an intent's audience effects apply at face value. */
export const REFERENCE_REACH = 2_000_000;

/** How much of the addressable audience an author can pull in beyond followers. */
export const AUDIENCE_CAPTURE = 0.012;

/** How quickly repeated posting stops working. */
export const POST_FATIGUE = 0.6;

/** Largest movement one post may make to one reputation score. */
export const MAX_REPUTATION_MOVE = 6;

/** Largest amount the quarter's posts together may heat the controversy cycle. */
export const MAX_CONTROVERSY_CONTRIBUTION = 0.1;

const AUDIENCES: readonly Audience[] = ['developers', 'enterprise', 'consumers', 'investors', 'regulators', 'media', 'talent'];

/** Which company reputation each audience moves, and by how much of the shift. */
const AUDIENCE_REPUTATION: Record<Audience, readonly { field: keyof SessionState['companies'][number]['reputation']; weight: number }[]> = {
  developers: [{ field: 'developer', weight: 1 }],
  enterprise: [{ field: 'enterprise', weight: 1 }],
  consumers: [{ field: 'public', weight: 1 }],
  investors: [{ field: 'investor', weight: 1 }],
  regulators: [{ field: 'government', weight: 1 }],
  media: [{ field: 'public', weight: 0.5 }],
  talent: [
    { field: 'developer', weight: 0.4 },
    { field: 'public', weight: 0.2 },
  ],
};

/* -------------------------------------------------------------------------- */
/*  Accounts and ingestion                                                     */
/* -------------------------------------------------------------------------- */

/** Find the character's account on a network, creating a plausible one if absent. */
export function ensureAccount(draft: SessionState, characterId: string, network: NetworkArchetype): SocialAccount | null {
  const existing = draft.socialAccounts.find((a) => a.ownerCharacterId === characterId && a.network === network);
  if (existing !== undefined) return existing;
  const character = characterById(draft, characterId);
  if (character === null) return null;

  const profile = NETWORK_PROFILES[network];
  const company = character.companyId === null ? null : companyById(draft, character.companyId);
  const credibility = unit(
    0.25 + 0.35 * ((company?.reputation.public ?? 50) / 100) + 0.25 * (character.connectionLevel / 100) + 0.15 * ((company?.reputation.investor ?? 50) / 100),
  );
  const account: SocialAccount = {
    id: makeId('soc', characterId, network),
    network,
    handle: `@${character.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 30)}`,
    ownerCharacterId: characterId,
    ownerCompanyId: character.companyId,
    followers: Math.max(0, Math.round(character.publicFollowing * profile.followerShare)),
    credibility: round(credibility, 4),
    verified: character.connectionLevel >= 60,
    audienceMix: { ...profile.audienceMix },
    isActive: true,
  };
  draft.socialAccounts.push(account);
  return account;
}

/**
 * Turn this quarter's `social_post` actions into published posts. The engine
 * assigns the id, the account and the AI-generated label; the model supplied
 * only the typed draft.
 */
export function ingestPostActions(draft: SessionState, ctx: ResolverContext): SocialPost[] {
  const actions: SubmittedAction[] = draft.pendingActions
    .filter((a) => a.quarter === ctx.quarter && a.intent.type === 'social_post')
    .sort((a, b) => a.sequence - b.sequence);

  const created: SocialPost[] = [];
  for (const action of actions) {
    if (action.intent.type !== 'social_post') continue;
    const post = action.intent.draft;
    const author = characterById(draft, post.authorCharacterId);
    if (author === null || !author.isActive) continue;
    const account = ensureAccount(draft, author.id, post.network);
    if (account === null) continue;

    const id = makeId('pst', draft.sessionId, ctx.quarter, action.actionId);
    if (draft.socialPosts.some((p) => p.id === id)) continue;

    const stored: SocialPost = {
      ...post,
      id,
      accountId: account.id,
      quarter: ctx.quarter,
      engagement: null,
      // NPC characters must be visibly labelled wherever their posts appear.
      isAiGenerated: !author.isPlayer,
      reportedCount: 0,
    };
    draft.socialPosts.push(stored);
    created.push(stored);
  }
  return created;
}

/* -------------------------------------------------------------------------- */
/*  Reach and engagement                                                       */
/* -------------------------------------------------------------------------- */

export interface ReachInputs {
  readonly followerReach: number;
  readonly audienceReach: number;
  readonly relevance: number;
  readonly novelty: number;
  readonly virality: number;
  readonly reach: number;
}

/** How many posts this author has already made in the recent window. */
function recentPostCount(draft: SessionState, post: SocialPost): number {
  return draft.socialPosts.filter(
    (p) => p.authorCharacterId === post.authorCharacterId && p.id !== post.id && p.quarter >= post.quarter - 1 && p.quarter <= post.quarter,
  ).length;
}

/**
 * Reach: credibility times the follower graph, times relevance, times novelty,
 * times whatever resharing does to it. Never asserted by a model.
 */
export function computeReach(draft: SessionState, post: SocialPost, account: SocialAccount, rng: SeededRng): ReachInputs {
  const profile = NETWORK_PROFILES[post.network];
  const intent = INTENT_PROFILES[post.intent];
  const author = characterById(draft, post.authorCharacterId);
  const attention = draft.world.media.attentionLevel;
  const controversy = draft.world.media.controversyIntensity;

  const followerReach = account.followers * (0.15 + 0.5 * account.credibility);
  const addressable = profile.baseAudience * (0.5 + 0.5 * attention);
  const authorFactor = (0.2 + 0.8 * account.credibility) * (0.25 + 0.75 * ((author?.connectionLevel ?? 30) / 100));
  const relevance = unit((intent.networkFit[post.network] ?? 0.5) * (post.targetCompanyId === null ? 1 : 1.1));
  const novelty = unit(1 / (1 + POST_FATIGUE * recentPostCount(draft, post)));
  const virality = clamp(profile.virality * intent.virality * (0.6 + 0.8 * attention * (0.5 + 0.5 * controversy)) * rng.range(0.75, 1.35), 0, 10);

  const audienceReach = addressable * authorFactor * relevance * AUDIENCE_CAPTURE;
  const reach = Math.max(0, (followerReach + audienceReach) * novelty * virality);

  return {
    followerReach: round(followerReach, 2),
    audienceReach: round(audienceReach, 2),
    relevance: round(relevance, 4),
    novelty: round(novelty, 4),
    virality: round(virality, 4),
    reach: round(reach, 2),
  };
}

/** Per-audience sentiment consequences, bounded by the schema's -20..20. */
export function computeSentimentShifts(post: SocialPost, account: SocialAccount, reach: number): SentimentShift[] {
  const intent = INTENT_PROFILES[post.intent];
  const reachFactor = clamp(ratio(reach, REFERENCE_REACH, 0), 0.2, 2.5);
  const shifts: SentimentShift[] = [];

  for (const audience of AUDIENCES) {
    const base = intent.audienceEffects[audience];
    if (base === undefined || base === 0) continue;
    const share = clamp(account.audienceMix[audience] ?? 0, 0, 1);
    // An audience that does not follow this account barely hears it, but the
    // press carries a fraction of everything to everyone.
    const exposure = 0.3 + 0.7 * Math.min(1, share * 3);
    const delta = clamp(base * reachFactor * exposure, -20, 20);
    if (Math.abs(delta) < 0.05) continue;
    shifts.push({ audience, delta: round(delta, 3) });
  }
  return shifts;
}

/** Apply a post's sentiment shifts to its author's company reputations. */
export function applySentimentShifts(draft: SessionState, companyId: string | null, shifts: readonly SentimentShift[]): Record<string, number> {
  const applied: Record<string, number> = {};
  const company = companyId === null ? null : companyById(draft, companyId);
  if (company === null) return applied;

  for (const shift of shifts) {
    for (const mapping of AUDIENCE_REPUTATION[shift.audience]) {
      const delta = clamp(shift.delta * mapping.weight, -MAX_REPUTATION_MOVE, MAX_REPUTATION_MOVE);
      const before = company.reputation[mapping.field];
      company.reputation[mapping.field] = score100(before + delta);
      applied[mapping.field] = round((applied[mapping.field] ?? 0) + (company.reputation[mapping.field] - before), 3);
    }
  }
  return applied;
}

/* -------------------------------------------------------------------------- */
/*  Public information                                                         */
/* -------------------------------------------------------------------------- */

const DISCLOSURE_KIND: Record<PostIntent, PublicDisclosure['kind'] | null> = {
  announce: 'press_release',
  hype: 'press_release',
  defend: 'press_release',
  apologise: 'press_release',
  attack: 'rumour',
  leak: 'leak',
  recruit: null,
};

const DISCLOSURE_TOPIC: Record<PostIntent, PublicDisclosure['beliefTopic']> = {
  announce: 'model_success',
  hype: 'revenue_beat',
  defend: null,
  apologise: 'safety_incident',
  attack: 'margin_pressure',
  leak: 'model_delay',
  recruit: null,
};

const DISCLOSURE_CREDIBILITY_FACTOR: Record<string, number> = { press_release: 0.9, rumour: 0.45, leak: 0.55 };

/**
 * Whether the claim happened to match canonical reality when it was made.
 *
 * INTERNAL ONLY. It is written to state so the disclosure phase can punish a
 * misleading statement two quarters later, and it is never put in a ledger
 * payload, never sent to a client and never read by the market directly.
 */
function evaluateTruth(draft: SessionState, post: SocialPost, subjectCompanyId: string | null, topic: PublicDisclosure['beliefTopic']): boolean {
  if (subjectCompanyId === null || topic === null) return true;
  const company = companyById(draft, subjectCompanyId);
  if (company === null) return false;
  const metrics = draft.companyMetrics.find((m) => m.companyId === subjectCompanyId);
  switch (topic) {
    case 'model_success':
      return company.techCapabilities.reasoning !== undefined && company.techCapabilities.reasoning >= draft.world.aiFrontier.frontierCapability * 0.9;
    case 'revenue_beat':
      return (metrics?.revenueGrowthYoY ?? 0) > 0;
    case 'margin_pressure':
      return (metrics?.operatingMarginPct ?? 0) < 0;
    case 'model_delay':
      return draft.researchProjects.some((p) => p.companyId === subjectCompanyId && p.internalConfidence < 0.5);
    case 'safety_incident':
      return draft.activeEvents.some((e) => e.type === 'safety_incident' && e.affectedCompanyIds.includes(subjectCompanyId));
    default:
      return false;
  }
}

/**
 * Publish the public-information consequence of a post, if it has one.
 *
 * This is the only bridge from social to the market, and it carries a
 * credibility figure rather than a fact: the market phase moves beliefs, and
 * beliefs are stored separately from truth on purpose.
 */
export function publishDisclosure(
  draft: SessionState,
  ctx: ResolverContext,
  post: SocialPost,
  account: SocialAccount,
  reach: number,
): PublicDisclosure | null {
  const kind = DISCLOSURE_KIND[post.intent];
  if (kind === null) return null;
  const topic = DISCLOSURE_TOPIC[post.intent];
  const author = characterById(draft, post.authorCharacterId);
  const subjectCompanyId = post.targetCompanyId ?? author?.companyId ?? null;

  const credibility = unit(
    account.credibility *
      (account.verified ? 1 : 0.8) *
      (0.5 + 0.5 * draft.world.media.institutionalTrust) *
      (DISCLOSURE_CREDIBILITY_FACTOR[kind] ?? 0.6) *
      (0.7 + 0.3 * clamp(ratio(reach, REFERENCE_REACH, 0), 0, 2)),
  );

  const disclosure: PublicDisclosure = {
    id: makeId('dsc', draft.sessionId, ctx.quarter, post.id),
    companyId: subjectCompanyId,
    quarter: ctx.quarter,
    kind,
    headline: `${author?.name ?? 'An account'} on ${post.network.replace(/_/g, ' ')}: ${post.intent}`.slice(0, 160),
    body: post.text.slice(0, 1500),
    metrics: { reach: round(reach, 0), engagementCredibility: round(credibility, 4) },
    credibility: round(credibility, 4),
    sourceCharacterId: post.intent === 'leak' ? null : post.authorCharacterId,
    isTruthful: evaluateTruth(draft, post, subjectCompanyId, topic),
    beliefTopic: topic,
  };
  draft.disclosures.push(disclosure);

  // Note the deliberate omission: `isTruthful` is never in the payload.
  emitEvent(
    draft,
    ctx,
    kind === 'press_release' ? 'disclosure_published' : 'rumour_spread',
    post.authorCharacterId,
    subjectCompanyId,
    {
      disclosureId: disclosure.id,
      postId: post.id,
      kind,
      beliefTopic: topic,
      credibility: disclosure.credibility,
      reach: round(reach, 0),
      anonymous: disclosure.sourceCharacterId === null,
    },
    'public',
  );
  return disclosure;
}

/* -------------------------------------------------------------------------- */
/*  Propagation                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Compute reach, engagement and every sentiment consequence for the quarter's
 * posts. The text was written by a model; every number here is engine output.
 */
export function propagatePosts(draft: SessionState, ctx: ResolverContext): EngagementResult[] {
  ingestPostActions(draft, ctx);
  const rng = ctx.rng.fork(`social_posts_q${ctx.quarter}`);
  const results: EngagementResult[] = [];
  let controversyAdded = 0;

  const posts = draft.socialPosts
    .filter((p) => p.quarter === ctx.quarter && p.engagement === null)
    .sort((a, b) => a.id.localeCompare(b.id));

  for (const post of posts) {
    const account = draft.socialAccounts.find((a) => a.id === post.accountId);
    if (account === undefined) continue;
    const author = characterById(draft, post.authorCharacterId);
    const authorCompanyId = author?.companyId ?? account.ownerCompanyId;
    const intent = INTENT_PROFILES[post.intent];

    const reachInputs = computeReach(draft, post, account, rng);
    const reachFactor = clamp(ratio(reachInputs.reach, REFERENCE_REACH, 0), 0.2, 2.5);
    const engagementScore = unit(
      0.12 + 0.3 * reachInputs.relevance + 0.2 * reachInputs.novelty + 0.2 * account.credibility + 0.1 * rng.next(),
    );

    const pressProbability = clamp(
      NETWORK_PROFILES[post.network].pressAffinity * 0.5 +
        intent.pressBias * 0.5 +
        0.25 * draft.world.media.attentionLevel +
        0.25 * draft.world.media.controversyIntensity +
        0.2 * account.credibility +
        0.15 * reachFactor -
        0.2,
      0,
      0.95,
    );
    const pressPickup = rng.next() < pressProbability;

    const sentimentShifts = computeSentimentShifts(post, account, reachInputs.reach);
    const applied = applySentimentShifts(draft, authorCompanyId, sentimentShifts);

    const competitorHostilityDelta = post.targetCompanyId === null ? 0 : clamp(intent.hostility * reachFactor, -20, 20);

    const engagement: EngagementResult = {
      postId: post.id,
      quarter: ctx.quarter,
      reach: reachInputs.reach,
      engagementScore: round(engagementScore, 4),
      sentimentShifts,
      pressPickup,
      viralityFactor: reachInputs.virality,
      competitorHostilityDelta: round(competitorHostilityDelta, 3),
    };
    post.engagement = engagement;
    results.push(engagement);

    const postEventId = emitEvent(
      draft,
      ctx,
      'social_post_published',
      post.authorCharacterId,
      post.targetCompanyId,
      {
        postId: post.id,
        network: post.network,
        intent: post.intent,
        isAiGenerated: post.isAiGenerated,
        reach: engagement.reach,
        engagementScore: engagement.engagementScore,
        viralityFactor: engagement.viralityFactor,
        pressPickup,
        relevance: reachInputs.relevance,
        novelty: reachInputs.novelty,
      },
      'public',
    );

    if (sentimentShifts.length > 0) {
      const sentimentEventId = emitEvent(
        draft,
        ctx,
        'sentiment_shifted',
        post.authorCharacterId,
        authorCompanyId,
        { postId: post.id, shifts: sentimentShifts, reputationApplied: applied },
        'public',
      );
      const biggest = [...sentimentShifts].sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))[0];
      if (biggest !== undefined) {
        ctx.log({
          phase: 'social_resolution',
          text: line(
            `${author?.name ?? 'An account'} posted to ${post.network.replace(/_/g, ' ')} (${post.intent}); ${biggest.audience} sentiment moved ${biggest.delta >= 0 ? '+' : ''}${round(biggest.delta, 1)}.`,
          ),
          deltaLabel: reachLabel(engagement.reach),
          refEventIds: [sentimentEventId, postEventId],
          tone: biggest.delta >= 0 ? 'positive' : 'negative',
          subjectId: authorCompanyId,
        });
      }
    }

    // The targeted company's leadership takes it personally.
    if (post.targetCompanyId !== null && competitorHostilityDelta !== 0) {
      const targetCeo = ceoOf(draft, post.targetCompanyId);
      if (targetCeo !== null && targetCeo !== post.authorCharacterId) {
        const hostile = competitorHostilityDelta > 0;
        rememberEvent(draft, ctx, {
          ownerCharacterId: targetCeo,
          aboutId: post.authorCharacterId,
          kind: hostile ? 'public_attack' : 'public_support',
          summary: hostile
            ? `They went after us in public on ${post.network.replace(/_/g, ' ')}.`
            : `They spoke up for us in public on ${post.network.replace(/_/g, ' ')}.`,
          sentiment: clamp(hostile ? -(0.4 + 0.3 * reachFactor) : 0.4 + 0.2 * reachFactor, -1, 1),
        });
      }
    }

    // Controversial intents heat the cycle, within a per-quarter ceiling.
    if (intent.controversy > 0 && controversyAdded < MAX_CONTROVERSY_CONTRIBUTION) {
      const addition = Math.min(intent.controversy * reachFactor, MAX_CONTROVERSY_CONTRIBUTION - controversyAdded);
      if (addition > 0) {
        controversyAdded += addition;
        draft.world.media.controversyIntensity = unit(draft.world.media.controversyIntensity + addition);
      }
    }

    publishDisclosure(draft, ctx, post, account, reachInputs.reach);
  }

  return results;
}
