/**
 * @frontier/simulation — social/press.ts
 *
 * The press layer: which posts and events become stories, how long a story
 * commands attention, and how the accumulated coverage bends the world's
 * dominant narrative.
 *
 * A story is how a private matter becomes a public information event, and
 * therefore how it reaches the share price — through `MediaStory.credibility`
 * and the disclosures social publishes, never by reading canonical state.
 *
 * The dominant narrative is the frame every new event is interpreted through:
 * the same product launch reads as visionary under `ai_optimism` and reckless
 * under `safety_alarm`. It moves only on weight of coverage, never on one
 * headline.
 */

import type { MediaStory, PostIntent, ResolverContext, SessionState, SocialPost, StoryAngle, WorldEvent, WorldEventType, DominantNarrative } from '@frontier/contracts';
import { makeId } from '@frontier/contracts';
import { bipolar, characterById, clamp, companyById, emitEvent, line, ratio, reachLabel, round, unit } from './util';
import { REFERENCE_REACH } from './reach';

/* -------------------------------------------------------------------------- */
/*  Balancing constants                                                        */
/* -------------------------------------------------------------------------- */

/** How much of a story's prominence survives into the next quarter. */
export const STORY_DECAY = 0.55;

/** Below this prominence a story is out of the cycle and leaves live state. */
export const STORY_FLOOR = 0.05;

/** Most stories held in live state; the ledger keeps the rest. */
export const MAX_STORIES = 40;

/** Quarters of published posts retained in live state, as the schema intends. */
export const POST_HISTORY_QUARTERS = 8;

/** How much further a story travels than the post that triggered it. */
export const PRESS_REACH_MULTIPLIER = 2.2;

/** Severity at which a public world event is picked up by the press. */
export const EVENT_PICKUP_SEVERITY = 0.45;

/** Coverage mass one angle needs before the dominant narrative moves. */
export const NARRATIVE_SHIFT_MASS = 1.2;

/** How far ahead of the runner-up that angle must be. */
export const NARRATIVE_SHIFT_LEAD = 1.6;

/* -------------------------------------------------------------------------- */
/*  Angles                                                                     */
/* -------------------------------------------------------------------------- */

const ANGLE_BY_INTENT: Record<PostIntent, StoryAngle> = {
  announce: 'breakthrough',
  hype: 'financial_analysis',
  attack: 'competitive',
  defend: 'profile',
  apologise: 'scandal',
  leak: 'scandal',
  recruit: 'labour',
};

const SENTIMENT_BY_INTENT: Record<PostIntent, number> = {
  announce: 0.4,
  hype: 0.2,
  attack: -0.5,
  defend: 0.1,
  apologise: -0.2,
  leak: -0.6,
  recruit: 0.2,
};

const ANGLE_BY_EVENT_TYPE: Partial<Record<WorldEventType, StoryAngle>> = {
  safety_incident: 'safety_concern',
  cyber_incident: 'safety_concern',
  regulatory_action: 'regulatory',
  antitrust_investigation: 'regulatory',
  copyright_ruling: 'regulatory',
  privacy_enforcement: 'regulatory',
  export_control: 'geopolitical',
  geopolitical_escalation: 'geopolitical',
  sanctions_change: 'geopolitical',
  trade_dispute: 'geopolitical',
  defence_mobilisation: 'geopolitical',
  model_breakthrough: 'breakthrough',
  open_source_release: 'breakthrough',
  benchmark_result: 'breakthrough',
  research_disappointment: 'financial_analysis',
  labour_action: 'labour',
  talent_shock: 'labour',
  immigration_change: 'labour',
  corporate_scandal: 'scandal',
  public_backlash: 'scandal',
  media_cycle: 'scandal',
  consolidation_wave: 'competitive',
  capital_market_shift: 'financial_analysis',
  credit_event: 'financial_analysis',
  fund_collapse: 'financial_analysis',
  ipo_window_change: 'financial_analysis',
  macro_shift: 'financial_analysis',
};

const NARRATIVE_BY_ANGLE: Record<StoryAngle, DominantNarrative | null> = {
  breakthrough: 'ai_optimism',
  scandal: 'scandal_cycle',
  financial_analysis: 'bubble_concern',
  human_interest: null,
  regulatory: 'safety_alarm',
  competitive: 'concentration_backlash',
  safety_concern: 'safety_alarm',
  labour: 'labour_disruption',
  geopolitical: 'geopolitical_race',
  profile: null,
};

/* -------------------------------------------------------------------------- */
/*  Story construction                                                         */
/* -------------------------------------------------------------------------- */

function headlineForPost(draft: SessionState, post: SocialPost): string {
  const author = characterById(draft, post.authorCharacterId);
  const authorName = author?.name ?? 'An industry figure';
  const target = post.targetCompanyId === null ? null : companyById(draft, post.targetCompanyId);
  const own = author?.companyId === null || author?.companyId === undefined ? null : companyById(draft, author.companyId);
  const subject = own?.name ?? authorName;

  switch (post.intent) {
    case 'attack':
      return `${authorName} attacks ${target?.name ?? 'a rival'} in public`;
    case 'leak':
      return `Unattributed claim circulates about ${target?.name ?? subject}`;
    case 'apologise':
      return `${subject} apologises publicly`;
    case 'defend':
      return `${subject} defends itself as pressure builds`;
    case 'recruit':
      return `${subject} takes its hiring campaign public`;
    case 'hype':
      return `${authorName} talks up ${subject}'s prospects`;
    case 'announce':
    default:
      return `${subject} goes public with an announcement`;
  }
}

/** Pick the journalist who writes a story, or null for wire coverage. */
function pickJournalist(draft: SessionState, index: number): string | null {
  const journalists = draft.characters.filter((c) => c.role === 'journalist' && c.isActive);
  if (journalists.length === 0) return null;
  const chosen = journalists[index % journalists.length];
  return chosen?.id ?? null;
}

/* -------------------------------------------------------------------------- */
/*  Lifecycle                                                                  */
/* -------------------------------------------------------------------------- */

/** Age the existing cycle: yesterday's story commands less attention today. */
export function ageStories(draft: SessionState, quarter: number): number {
  let dropped = 0;
  for (const story of draft.mediaStories) {
    if (story.quarter >= quarter) continue;
    story.prominence = unit(story.prominence * STORY_DECAY);
  }
  const kept = draft.mediaStories.filter((s) => s.prominence >= STORY_FLOOR);
  dropped = draft.mediaStories.length - kept.length;

  const ranked = [...kept].sort((a, b) => b.quarter - a.quarter || b.prominence - a.prominence).slice(0, MAX_STORIES);
  const survivors = new Set(ranked.map((s) => s.id));
  draft.mediaStories = kept.filter((s) => survivors.has(s.id));
  return dropped;
}

/* -------------------------------------------------------------------------- */
/*  Subsystem function                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Decide which posts and events the press picks up, create the resulting
 * stories, and drift the media domain of the world state accordingly.
 */
export function updateMediaStories(draft: SessionState, ctx: ResolverContext): MediaStory[] {
  const rng = ctx.rng.fork(`social_press_q${ctx.quarter}`);
  ageStories(draft, ctx.quarter);

  const attention = draft.world.media.attentionLevel;
  const trust = draft.world.media.institutionalTrust;
  const created: MediaStory[] = [];
  let journalistIndex = rng.int(0, 999);

  /* ----------------------------- from posts ------------------------------ */

  const pickedUp = draft.socialPosts
    .filter((p) => p.quarter === ctx.quarter && p.engagement !== null && p.engagement.pressPickup)
    .sort((a, b) => a.id.localeCompare(b.id));

  for (const post of pickedUp) {
    const engagement = post.engagement;
    if (engagement === null) continue;
    const id = makeId('sty', draft.sessionId, ctx.quarter, post.id);
    if (draft.mediaStories.some((s) => s.id === id)) continue;

    const account = draft.socialAccounts.find((a) => a.id === post.accountId);
    const author = characterById(draft, post.authorCharacterId);
    const subjectCompanyId = post.targetCompanyId ?? author?.companyId ?? null;
    const angle = ANGLE_BY_INTENT[post.intent];
    const reach = engagement.reach * PRESS_REACH_MULTIPLIER * (0.5 + 0.5 * attention);
    const prominence = unit(0.2 + 0.5 * clamp(ratio(reach, REFERENCE_REACH * 2, 0), 0, 1) + 0.3 * attention);
    const credibility = unit((account?.credibility ?? 0.4) * (0.55 + 0.45 * trust));

    journalistIndex += 1;
    const story: MediaStory = {
      id,
      quarter: ctx.quarter,
      headline: headlineForPost(draft, post).slice(0, 160),
      body: `${post.text}`.slice(0, 1500),
      angle,
      prominence: round(prominence, 4),
      subjectCompanyIds: subjectCompanyId === null ? [] : [subjectCompanyId],
      subjectCharacterIds: [post.authorCharacterId],
      sourcePostIds: [post.id],
      sourceEventId: null,
      credibility: round(credibility, 4),
      sentiment: bipolar(SENTIMENT_BY_INTENT[post.intent]),
      reach: round(reach, 0),
      authorCharacterId: pickJournalist(draft, journalistIndex),
    };
    draft.mediaStories.push(story);
    created.push(story);
  }

  /* ---------------------------- from events ------------------------------ */

  const newsworthy: WorldEvent[] = draft.activeEvents.filter(
    (e) => e.quarter === ctx.quarter && e.visibility === 'public' && e.severity >= EVENT_PICKUP_SEVERITY,
  );
  for (const event of newsworthy) {
    const id = makeId('sty', draft.sessionId, ctx.quarter, event.id);
    if (draft.mediaStories.some((s) => s.id === id)) continue;
    journalistIndex += 1;
    const story: MediaStory = {
      id,
      quarter: ctx.quarter,
      headline: event.title.slice(0, 160),
      body: event.description.slice(0, 1500),
      angle: ANGLE_BY_EVENT_TYPE[event.type] ?? 'financial_analysis',
      prominence: unit(0.35 + 0.5 * event.severity + 0.15 * attention),
      subjectCompanyIds: [...event.affectedCompanyIds],
      subjectCharacterIds: [],
      sourcePostIds: [],
      sourceEventId: event.id,
      credibility: unit(0.6 + 0.35 * trust),
      sentiment: bipolar(-event.severity * 0.6),
      reach: round(40_000_000 * (0.4 + 0.6 * attention) * (0.4 + 0.6 * event.severity), 0),
      authorCharacterId: pickJournalist(draft, journalistIndex),
    };
    draft.mediaStories.push(story);
    created.push(story);
  }

  /* ------------------------------ ledger --------------------------------- */

  for (const story of created) {
    const eventId = emitEvent(
      draft,
      ctx,
      'media_story_published',
      story.authorCharacterId,
      story.subjectCompanyIds[0] ?? null,
      {
        storyId: story.id,
        headline: story.headline,
        angle: story.angle,
        prominence: story.prominence,
        credibility: story.credibility,
        sentiment: story.sentiment,
        reach: story.reach,
        sourcePostIds: story.sourcePostIds,
        sourceEventId: story.sourceEventId,
      },
      'public',
    );
    if (story.prominence >= 0.4) {
      ctx.log({
        phase: 'social_resolution',
        text: line(`The press picked it up: "${story.headline}" (${story.angle.replace(/_/g, ' ')}, credibility ${round(story.credibility, 2)}).`),
        deltaLabel: reachLabel(story.reach),
        refEventIds: [eventId],
        tone: story.sentiment >= 0 ? 'positive' : 'negative',
        subjectId: story.subjectCompanyIds[0] ?? null,
      });
    }
  }

  // Posts are a rolling window in live state; the ledger keeps every one.
  draft.socialPosts = draft.socialPosts.filter((p) => p.quarter > ctx.quarter - POST_HISTORY_QUARTERS);

  driftNarrative(draft, ctx);
  return created;
}

/* -------------------------------------------------------------------------- */
/*  Narrative drift                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Move the media domain with the weight of coverage: attention follows the
 * cycle, the controversy cycle cools on its own, institutional trust erodes
 * under scandal, and the dominant narrative changes only when one angle clearly
 * owns the quarter.
 */
export function driftNarrative(draft: SessionState, ctx: ResolverContext): void {
  const media = draft.world.media;
  const recent = draft.mediaStories.filter((s) => s.quarter >= ctx.quarter - 1);

  const mass = recent.reduce((sum, s) => sum + s.prominence, 0);
  const attentionBefore = media.attentionLevel;
  media.attentionLevel = unit(media.attentionLevel * 0.85 + 0.15 * clamp(mass / 3, 0, 1));

  const controversyBefore = media.controversyIntensity;
  media.controversyIntensity = unit(media.controversyIntensity * 0.92);

  const scandalMass = recent.filter((s) => s.angle === 'scandal' || s.angle === 'safety_concern').reduce((sum, s) => sum + s.prominence, 0);
  const breakthroughMass = recent.filter((s) => s.angle === 'breakthrough').reduce((sum, s) => sum + s.prominence, 0);
  const trustBefore = media.institutionalTrust;
  media.institutionalTrust = unit(media.institutionalTrust - 0.02 * scandalMass + 0.01 * breakthroughMass);

  const byAngle = new Map<StoryAngle, number>();
  for (const story of recent) {
    byAngle.set(story.angle, (byAngle.get(story.angle) ?? 0) + story.prominence);
  }
  const ranked = [...byAngle.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const top = ranked[0];
  const second = ranked[1];
  const narrativeBefore = media.dominantNarrative;

  if (top !== undefined && top[1] >= NARRATIVE_SHIFT_MASS && (second === undefined || top[1] >= second[1] * NARRATIVE_SHIFT_LEAD)) {
    const candidate = NARRATIVE_BY_ANGLE[top[0]];
    if (candidate !== null && candidate !== narrativeBefore) {
      media.dominantNarrative = candidate;
    }
  }

  const moved =
    Math.abs(media.attentionLevel - attentionBefore) > 1e-6 ||
    Math.abs(media.controversyIntensity - controversyBefore) > 1e-6 ||
    Math.abs(media.institutionalTrust - trustBefore) > 1e-6 ||
    media.dominantNarrative !== narrativeBefore;
  if (!moved) return;

  const eventId = emitEvent(
    draft,
    ctx,
    'sentiment_shifted',
    null,
    'world',
    {
      kind: 'media_narrative',
      storyMass: round(mass, 4),
      attentionBefore: round(attentionBefore, 4),
      attentionAfter: round(media.attentionLevel, 4),
      controversyBefore: round(controversyBefore, 4),
      controversyAfter: round(media.controversyIntensity, 4),
      institutionalTrustBefore: round(trustBefore, 4),
      institutionalTrustAfter: round(media.institutionalTrust, 4),
      narrativeBefore,
      narrativeAfter: media.dominantNarrative,
    },
    'public',
  );

  if (media.dominantNarrative !== narrativeBefore) {
    ctx.log({
      phase: 'social_resolution',
      text: line(`The press narrative turned from ${narrativeBefore.replace(/_/g, ' ')} to ${media.dominantNarrative.replace(/_/g, ' ')} on the weight of this quarter's coverage.`),
      deltaLabel: `mass ${round(mass, 2)}`,
      refEventIds: [eventId],
      tone: media.dominantNarrative === 'ai_optimism' ? 'positive' : 'warning',
      subjectId: null,
    });
  }
}
