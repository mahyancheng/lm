/**
 * @frontier/simulation — social
 *
 * Phase 14, `social_resolution`. It runs *after* the market prices, on purpose:
 * a post affects next quarter's belief, not this quarter's close.
 *
 * ```text
 * propagatePosts      reach, engagement, per-audience sentiment, disclosures
 * updateMediaStories  press pickup, story lifecycle, narrative drift
 * ```
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
  ensureAccount,
  computeReach,
  computeSentimentShifts,
  applySentimentShifts,
  publishDisclosure,
  NETWORK_PROFILES,
  INTENT_PROFILES,
  REFERENCE_REACH,
  AUDIENCE_CAPTURE,
  POST_FATIGUE,
  MAX_REPUTATION_MOVE,
  MAX_CONTROVERSY_CONTRIBUTION,
} from './reach';
export type { NetworkProfile, IntentProfile, ReachInputs } from './reach';
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
