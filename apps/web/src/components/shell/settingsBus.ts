/**
 * One way in to the settings sheet, from anywhere.
 *
 * The sheet is owned by the status bar, which is a sibling of every screen
 * rather than an ancestor, so a screen cannot reach its state. The alternative
 * to a small event bus is lifting the drawer's open flag into the game store,
 * which would put a piece of transient interface chrome into the object that
 * holds the session — the wrong place for it by some distance.
 *
 * There is exactly one message and it carries exactly one thing: which section
 * to land on. Everything that explains offline mode sends it, so "Offline" is
 * never a dead end.
 */

export const SETTINGS_OPEN_EVENT = 'frontier:open-settings';

/** The sections a caller may ask the sheet to open at. */
export type SettingsSection = 'ai';

/** Ask the settings sheet to open, scrolled to `section`. A no-op on the server. */
export function openSettings(section: SettingsSection = 'ai'): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<SettingsSection>(SETTINGS_OPEN_EVENT, { detail: section }));
}

/** Listen for the request. Returns the unsubscribe, for an effect's cleanup. */
export function onOpenSettings(handler: (section: SettingsSection) => void): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const listener = (event: Event): void => {
    handler((event as CustomEvent<SettingsSection>).detail ?? 'ai');
  };
  window.addEventListener(SETTINGS_OPEN_EVENT, listener);
  return () => window.removeEventListener(SETTINGS_OPEN_EVENT, listener);
}
