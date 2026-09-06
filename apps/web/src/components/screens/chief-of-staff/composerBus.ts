/**
 * One way to put a question to the Chief of Staff from anywhere.
 *
 * The dock is a sibling of every screen rather than an ancestor, so a card
 * cannot reach its state. The alternative to a small event bus is lifting the
 * drawer's open flag and its composer text into the game store, which would put
 * transient interface chrome into the object that holds the session — the wrong
 * place for it by some distance. `settingsBus` solves the same problem the same
 * way for the settings sheet.
 *
 * There is exactly one message and it carries two things: the sentence, and
 * whether to send it or leave it in the composer for the founder to edit.
 * "Ask" is used by the Play tab's quick prompts, which are questions; "fill" by
 * the eleven instructions only the Chief of Staff can queue, where the founder
 * is about to commit to something and must be able to change the words first.
 */

export const CHIEF_COMPOSE_EVENT = 'frontier:ask-chief-of-staff';

export interface ComposeRequest {
  /** The message, written as the founder would type it. */
  readonly text: string;
  /** True to send it immediately; false to open the dock with it in the composer. */
  readonly send: boolean;
}

/** Open the dock with `text` in the composer, unsent. A no-op on the server. */
export function composeToChief(text: string): void {
  dispatch({ text, send: false });
}

/** Open the dock and put `text` to the model at once. A no-op on the server. */
export function askChief(text: string): void {
  dispatch({ text, send: true });
}

function dispatch(detail: ComposeRequest): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<ComposeRequest>(CHIEF_COMPOSE_EVENT, { detail }));
}

/** Listen for the request. Returns the unsubscribe, for an effect's cleanup. */
export function onComposeToChief(handler: (request: ComposeRequest) => void): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const listener = (event: Event): void => {
    const detail = (event as CustomEvent<ComposeRequest>).detail;
    if (detail === undefined || detail === null) return;
    handler(detail);
  };
  window.addEventListener(CHIEF_COMPOSE_EVENT, listener);
  return () => window.removeEventListener(CHIEF_COMPOSE_EVENT, listener);
}
