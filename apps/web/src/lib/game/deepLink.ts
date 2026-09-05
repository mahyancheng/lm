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
const SECTOR_FOCUS_KEY = 'frontier:focusSector';
const NETWORK_CHARACTER_KEY = 'frontier:openCharacterId';
const NEWS_SEARCH_KEY = 'frontier:newsSearch';

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

/** Call right before navigating to Sector, to have that sector focused on arrival. */
export const setPendingSectorFocus = (sector: string): void => setKey(SECTOR_FOCUS_KEY, sector);
/** Read once on the Sector screen's mount. Consumes the pending value. */
export const takePendingSectorFocus = (): string | null => takeKey(SECTOR_FOCUS_KEY);

/** Call right before navigating to Network, to have that person's card open. */
export const setPendingNetworkCharacter = (characterId: string): void => setKey(NETWORK_CHARACTER_KEY, characterId);
/** Read once on the Network screen's mount. Consumes the pending value. */
export const takePendingNetworkCharacter = (): string | null => takeKey(NETWORK_CHARACTER_KEY);

/* -------------------------------------------------------------------------- */
/*  The paper's place                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The News screen keeps its section, its Mine toggle and its narrowing in the
 * URL, so browser Back restores them. Every in-app route to News — the World
 * tab, the sub-tab strip, a Command Centre line — is a plain `/news`, which
 * would open the front page again. So the paper also *remembers* where the
 * reader was, and the shell's News links carry that search back in.
 *
 * Unlike the mailboxes above this is not one-shot: it is read on every render
 * of a link and cleared only when the reader returns to the front page with
 * nothing on. An edition is deliberately not remembered — an earlier edition
 * is a one-off read, and coming back to the paper should mean today's.
 */

/** The current search (without a leading `?`), or empty to forget. Excludes `edition`. */
export function rememberNewsSearch(search: string): void {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  params.delete('edition');
  const kept = params.toString();
  try {
    if (kept.length === 0) sessionStorage.removeItem(NEWS_SEARCH_KEY);
    else sessionStorage.setItem(NEWS_SEARCH_KEY, kept);
  } catch {
    // Storage unavailable — the link falls back to the plain route.
  }
}

/** The remembered search, without a leading `?`, or empty. */
export function readNewsSearch(): string {
  try {
    return sessionStorage.getItem(NEWS_SEARCH_KEY) ?? '';
  } catch {
    return '';
  }
}

/** `/news` carrying the remembered search; any other href unchanged. */
export function newsHref(href: string, search: string): string {
  if (href !== '/news' || search.length === 0) return href;
  return `/news?${search}`;
}
