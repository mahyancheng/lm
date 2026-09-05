/**
 * @frontier/simulation — social
 *
 * Phase 14, `social_resolution`. It runs *after* the market prices, on purpose:
 * a post affects next quarter's belief, not this quarter's close.
 *
 * ```text
 * propagatePosts      NPC authorship, reach, engagement, sentiment, replies
 * updateMediaStories  press pickup, story lifecycle, narrative drift
 * ```
 *
 * `propagatePosts` also publishes the quarter's engine-authored posts and the
 * replies they draw (`npcPosts.ts`), so that a world with one human in it still
 * has a feed. Those posts are templated, typed and bounded, and they go through
 * exactly the same propagation as a player's own: the engine decides what a post
 * does whoever wrote the words.
 *
 * The rule the whole module exists to enforce: an LLM writes the post, the
 * engine decides what it does. A model cannot declare that developer sentiment
 * rose twelve points — it can only write something the engine then propagates.
 * And nothing here writes a market belief: posts create `PublicDisclosure` rows
 * carrying a credibility figure, and the market phase decides what to make of
 * them. Truth and belief stay separate.
 */

import type { SocialSubsystem, ResolverContext, SessionState } from '@frontier/contracts';
import { propagatePosts } from './reach';
import { updateMediaStories } from './press';

export {
  propagatePosts,
  ingestPostActions,
  computeReach,
  computeSentimentShifts,
  applySentimentShifts,
  publishDisclosure,
  INTENT_PROFILES,
  REFERENCE_REACH,
  AUDIENCE_CAPTURE,
  POST_FATIGUE,
  MAX_REPUTATION_MOVE,
  MAX_CONTROVERSY_CONTRIBUTION,
} from './reach';
export type { IntentProfile, ReachInputs } from './reach';
export { NETWORK_PROFILES, ensureAccount } from './accounts';
export type { NetworkProfile } from './accounts';
export {
  collectNpcPostCandidates,
  generateNpcPosts,
  generateNpcReplies,
  npcPostBudget,
  npcPostingEnabled,
  renderNpcText,
  selectNpcPostCandidates,
  spokespersonFor,
  voiceOf,
  AGGRESSION_ATTACK_THRESHOLD,
  APOLOGY_SEVERITY,
  ATTACK_COOLDOWN_QUARTERS,
  HOSTILITY_ATTACK_THRESHOLD,
  MAX_NPC_POSTS_PER_QUARTER,
  MAX_NPC_REPLIES_PER_QUARTER,
  MIN_NPC_POSTS_PER_QUARTER,
  PRICE_MOVE_THRESHOLD,
  SECTOR_REACTIONS_PER_EVENT,
} from './npcPosts';
export type { NpcPostCandidate, NpcTemplateKey, Voice } from './npcPosts';
export { applySocialTextOverrides, selectPostsForAuthoring, MAX_POST_TEXT_LENGTH, MAX_SOCIAL_TEXT_OVERRIDES } from './overrides';
export {
  updateMediaStories,
  driftNarrative,
  ageStories,
  STORY_DECAY,
  STORY_FLOOR,
  MAX_STORIES,
  PRESS_REACH_MULTIPLIER,
  EVENT_PICKUP_SEVERITY,
  NARRATIVE_SHIFT_MASS,
  NARRATIVE_SHIFT_LEAD,
  POST_HISTORY_QUARTERS,
} from './press';

/**
 * Build the social subsystem. Stateless: everything it needs comes from the
 * draft and the resolver context.
 */
export function createSocialSubsystem(): SocialSubsystem {
  return {
    propagatePosts,
    updateMediaStories(draft: SessionState, ctx: ResolverContext): void {
      updateMediaStories(draft, ctx);
    },
  };
}
