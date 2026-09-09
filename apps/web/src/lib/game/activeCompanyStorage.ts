/**
 * Where the switcher's choice lives.
 *
 * `activeCompanyId` — STAGE 5 — is client UI state, not engine state: which
 * company a screen is currently *looking at*, never an input to `F` and never
 * written to a `sim_event`. It still has to survive a refresh, so it is
 * persisted here, per session, in its own small `localStorage` entry — kept
 * out of the versioned `SaveFile` in `./saveFile` on purpose. That format's
 * `SAVE_VERSION` gates *replay*: every field in it either feeds
 * `createSession`/`resolveQuarter` or describes a quarter that already ran,
 * and a downgrade or an unsupported version refuses to touch the file at all
 * so a decision is never lost. A UI preference is neither of those things — it
 * has no bearing on what any quarter resolves to, an older build reading a
 * newer one's entry (or finding none) has nothing to lose beyond which tab
 * opens first, and gating it behind the same discipline would only risk the
 * save file's own integrity for no reason tied to what this actually is.
 *
 * Best-effort like every other `localStorage` read in this app: a private
 * window, blocked site data or a full quota all fail closed to "nothing
 * stored", never to a thrown error.
 */

const KEY_PREFIX = 'frontier-active-company:';

function storage(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** The company id last chosen for this session, or null if none is stored (or storage is unavailable). */
export function readStoredActiveCompanyId(sessionId: string): string | null {
  const store = storage();
  if (store === null) return null;
  try {
    return store.getItem(`${KEY_PREFIX}${sessionId}`);
  } catch {
    return null;
  }
}

/** Remember the switcher's choice for this session. Silently no-ops if storage refuses the write. */
export function writeStoredActiveCompanyId(sessionId: string, companyId: string): void {
  const store = storage();
  if (store === null) return;
  try {
    store.setItem(`${KEY_PREFIX}${sessionId}`, companyId);
  } catch {
    /* Best-effort: the tab still works, it just re-defaults on the next load. */
  }
}

/** Forget the stored choice for one session — used when a save is deleted or replaced. */
export function clearStoredActiveCompanyId(sessionId: string): void {
  const store = storage();
  if (store === null) return;
  try {
    store.removeItem(`${KEY_PREFIX}${sessionId}`);
  } catch {
    /* Nothing to do. */
  }
}
