/**
 * @frontier/simulation — social/overrides.ts
 *
 * Letting a model write the words of a post the engine decided to make.
 *
 * The division of labour is the same one the whole social subsystem exists to
 * enforce, applied one step further back. The engine decides that a founder
 * speaks this quarter, who they are, which network they are on, what their typed
 * `intent` is and which company they are aimed at — and it writes a template
 * line, so the quarter is complete and playable with no model at all. A model
 * may then rewrite that line in the author's voice. It may not add a post,
 * remove one, change an intent, retarget one, or touch a single number: reach,
 * sentiment, press pickup and hostility were computed from the typed post before
 * these words existed, and are not recomputed after them.
 *
 * That is what makes this safe to apply *after* the quarter has committed. The
 * only state it reaches is `SocialPost.text` and the body of a story quoting
 * that post, neither of which any subsystem reads as a number. Everything else
 * the model touched — nothing — stays where it was.
 *
 * It is still a state change, so it is still bounded here rather than trusted:
 * the post must exist, must belong to the quarter being written, must be one the
 * engine authored, and the text must be a non-empty string within the schema's
 * 560 characters. Anything else is dropped and the template line stands.
 */

import type { MediaStory, SessionState, SocialPost, SocialTextOverride } from '@frontier/contracts';

/** How many posts of one quarter a model may be asked to write. */
export const MAX_SOCIAL_TEXT_OVERRIDES = 3;

/** The schema's ceiling, restated here because this module enforces it. */
export const MAX_POST_TEXT_LENGTH = 560;

/**
 * Which of a quarter's engine-authored posts are worth a model call.
 *
 * Salience is the reach the engine already computed: the loudest posts are the
 * ones a player will actually read, and the ones whose prose is worth paying a
 * model for. Ties break on id, so the same committed quarter always names the
 * same posts however many times it is asked — which is what makes the call list
 * reproducible on replay.
 */
export function selectPostsForAuthoring(state: SessionState, quarter: number, limit: number = MAX_SOCIAL_TEXT_OVERRIDES): SocialPost[] {
  return state.socialPosts
    .filter((post) => post.quarter === quarter && post.isAiGenerated)
    .sort((a, b) => (b.engagement?.reach ?? 0) - (a.engagement?.reach ?? 0) || a.id.localeCompare(b.id))
    .slice(0, Math.max(0, limit));
}

/**
 * Apply model-written words to a committed quarter's engine-authored posts.
 *
 * Pure: returns a new state, or the same one when nothing valid was supplied.
 * A story that quoted the post is updated with it, so a reader is never shown a
 * headline quoting one sentence and a post containing another.
 */
export function applySocialTextOverrides(
  state: SessionState,
  overrides: readonly SocialTextOverride[],
  quarter: number,
): SessionState {
  if (overrides.length === 0) return state;

  const accepted = new Map<string, string>();
  for (const override of overrides.slice(0, MAX_SOCIAL_TEXT_OVERRIDES)) {
    const text = override.text.trim();
    if (text.length === 0 || text.length > MAX_POST_TEXT_LENGTH) continue;
    const post = state.socialPosts.find((entry) => entry.id === override.postId);
    // Only a post the engine authored, and only in the quarter being written:
    // a model never rewrites a human's words, and never edits history.
    if (post === undefined || post.quarter !== quarter || !post.isAiGenerated) continue;
    if (post.text === text) continue;
    accepted.set(post.id, text);
  }
  if (accepted.size === 0) return state;

  const socialPosts: SocialPost[] = state.socialPosts.map((post) => {
    const text = accepted.get(post.id);
    return text === undefined ? post : { ...post, text };
  });

  const mediaStories: MediaStory[] = state.mediaStories.map((story) => {
    if (story.quarter !== quarter) return story;
    const quoted = story.sourcePostIds.find((id) => accepted.has(id));
    if (quoted === undefined) return story;
    const text = accepted.get(quoted);
    return text === undefined ? story : { ...story, body: text.slice(0, 1500) };
  });

  return { ...state, socialPosts, mediaStories };
}
