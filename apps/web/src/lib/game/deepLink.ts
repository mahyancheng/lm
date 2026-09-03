/**
 * Cross-screen handoff for two links stage 3 asks for: a locked launch line
 * pointing at the Frontier Map node that unlocks it, and a tech node pointing
 * back at the launch flow for a line it unlocks. Both cross a route boundary
 * inside the same SPA session, so there is no React state to carry the intent
 * across it — `sessionStorage` is the one-shot mailbox: the writer sets a key
 * right before navigating, the reader takes (reads then deletes) it once on
 * mount. try/catch throughout: a private window or blocked storage must never
 * crash the navigation it only decorates.
 */

const LAUNCH_CATEGORY_KEY = 'frontier:launchCategoryId';
const RESEARCH_NODE_KEY = 'frontier:openNodeId';

function setKey(key: string, value: string): void {
  try {
    sessionStorage.setItem(key, value);
  } catch {
    // Storage unavailable — the navigation still happens, just without the prefill.
  }
}

function takeKey(key: string): string | null {
  try {
    const value = sessionStorage.getItem(key);
    if (value !== null) sessionStorage.removeItem(key);
    return value;
  } catch {
    return null;
  }
}

/** Call right before navigating to Products, to have the Launch modal open pre-filtered to this category. */
export const setPendingLaunchCategory = (categoryId: string): void => setKey(LAUNCH_CATEGORY_KEY, categoryId);
/** Read once on the Products screen's mount. Consumes the pending value. */
export const takePendingLaunchCategory = (): string | null => takeKey(LAUNCH_CATEGORY_KEY);

/** Call right before navigating to Research, to have that node's drawer open. */
export const setPendingResearchNode = (nodeId: string): void => setKey(RESEARCH_NODE_KEY, nodeId);
/** Read once on the Research screen's mount. Consumes the pending value. */
export const takePendingResearchNode = (): string | null => takeKey(RESEARCH_NODE_KEY);
