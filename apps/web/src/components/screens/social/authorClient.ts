/**
 * The one fetch the Social screen makes.
 *
 * `@frontier/llm` and the Claude Agent SDK are server-only, so the screen's
 * whole knowledge of the model is this POST. It resolves to `null` whenever no
 * transport is configured or anything at all goes wrong, and the caller's
 * deterministic path is to publish the player's own words unchanged — which is
 * better than a model putting words in a founder's mouth.
 */

import type { SocialAuthorInput, SocialPostDraft } from '@frontier/contracts';

/** Milliseconds before an interactive draft is abandoned. */
const AUTHOR_TIMEOUT_MS = 30_000;

interface RoleResponse {
  readonly output: SocialPostDraft | null;
  readonly fallback: boolean;
  readonly reason?: string;
}

/**
 * Ask the social author to write the post.
 *
 * `Date.now` is not involved and nothing here is gameplay-visible: the returned
 * draft is a *proposal* the player reads before it is queued, and the engine
 * computes every consequence from the typed object afterwards.
 */
export async function requestSocialDraft(
  input: SocialAuthorInput,
  scope: { readonly sessionId: string; readonly quarter: number },
): Promise<SocialPostDraft | null> {
  if (typeof window === 'undefined') return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AUTHOR_TIMEOUT_MS);
  try {
    const response = await fetch('/api/llm/social-author', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input, sessionId: scope.sessionId, quarter: scope.quarter }),
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const parsed = (await response.json()) as RoleResponse;
    return parsed.output ?? null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
