/**
 * Display strings for saves and slots, shared by the landing page and the
 * settings sheet.
 *
 * A save file carries a `setup` only when the player named one — a v1–v3 file,
 * and any v4 file for the classic world, stores `setup: null` — so every
 * surface that labels a save would otherwise invent its own fallback names.
 * They live here once instead, spelled exactly as the scenario in
 * `@frontier/simulation` spells them, because "Continue Player Ventures" and
 * "Continue player ventures" are two different companies to a reader.
 */

import { quarterLabel, type NewGameSetup, type SessionDifficulty } from '@frontier/contracts';
import type { SaveFile, SlotSummary } from './persistence';

/** The classic world's names, byte for byte as `scenario/demo.ts` seeds them. */
export const DEFAULT_COMPANY_NAME = 'Player Ventures';
export const DEFAULT_FOUNDER_NAME = 'Avery Sinclair';

/** Every demo session opens in 2027; a save records quarter indices, not years. */
export const DEMO_START_YEAR = 2027;

/** The company a save belongs to, with the classic world as the fallback. */
export function savedCompanyName(setup: Pick<NewGameSetup, 'companyName'> | null): string {
  return setup?.companyName ?? DEFAULT_COMPANY_NAME;
}

/** The founder a save belongs to, with the classic world as the fallback. */
export function savedFounderName(setup: Pick<NewGameSetup, 'founderName'> | null): string {
  return setup?.founderName ?? DEFAULT_FOUNDER_NAME;
}

/**
 * The hero button in one line: whose company, and where it stands.
 *
 * A run that ended is offered for reading rather than for continuing, because
 * loading it shows the verdict and nothing else.
 */
export function continueLabel(file: Pick<SaveFile, 'setup' | 'savedQuarter'> & { readonly endedQuarter?: number | null }): string {
  const ended = file.endedQuarter ?? null;
  if (ended !== null) return `Review ${savedCompanyName(file.setup)} — ended ${quarterLabel(DEMO_START_YEAR, ended)}`;
  return `Continue ${savedCompanyName(file.setup)} — ${quarterLabel(DEMO_START_YEAR, file.savedQuarter)}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

/**
 * The advisory timestamp, short: "31 Aug", with the year only when it is not
 * the current one. UTC on both sides of the comparison: the stamp is
 * display-only metadata, and a label that renders identically everywhere is
 * worth more than one that is calendar-exact for a given timezone. A missing
 * or unparsable stamp — every v1–v3 file — is null, not a guess.
 */
export function shortSavedAt(iso: string | null, now: () => Date = () => new Date()): string | null {
  if (iso === null) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const day = `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}`;
  return date.getUTCFullYear() === now().getUTCFullYear() ? day : `${day} ${date.getUTCFullYear()}`;
}

/**
 * What a row can say about a save's position, from either side.
 *
 * The host's envelope carries the quarter and the stamp but not the difficulty
 * — it indexes a file, it does not re-describe one — so `difficulty` is
 * optional here rather than a null a server row has to invent.
 */
export interface SavePosition {
  readonly savedQuarter: number | null;
  readonly savedAtIso: string | null;
  readonly difficulty?: SessionDifficulty | null;
  /**
   * The quarter the run ended in, when the seat was wound up.
   *
   * Optional for the same reason `difficulty` is: the host's envelope indexes a
   * file rather than re-describing one, so a server row simply does not know.
   */
  readonly endedQuarter?: number | null;
}

/**
 * The second line of a filled save row: quarter, difficulty and the advisory
 * date, dot-joined from whichever parts are actually known. Only an `ok`
 * summary earns one; the other statuses carry fixed captions in the UI.
 */
export function saveDetailLine(summary: SavePosition, now?: () => Date): string {
  const parts: string[] = [];
  // An ended run leads with how it ended. The file still loads — the verdict is
  // worth reading — but where the save sits is no longer the interesting fact.
  const ended = summary.endedQuarter ?? null;
  if (ended !== null) {
    parts.push(`Ended · ${quarterLabel(DEMO_START_YEAR, ended)}`);
  } else if (summary.savedQuarter !== null) {
    parts.push(quarterLabel(DEMO_START_YEAR, summary.savedQuarter));
  }
  if (summary.difficulty !== null && summary.difficulty !== undefined) parts.push(summary.difficulty);
  const saved = shortSavedAt(summary.savedAtIso, now);
  if (saved !== null) parts.push(`saved ${saved}`);
  return parts.join(' · ');
}

/** The same line for a `localStorage` slot summary, which always knows its difficulty. */
export function slotDetailLine(summary: SlotSummary, now?: () => Date): string {
  return saveDetailLine(summary, now);
}

/**
 * What pressing "Save to slot" will replace, spelled out on the button itself:
 * overwriting without a confirm dialog is fine, overwriting blindly is not.
 * An `unsupported` slot is named but never overwritten — its button is
 * disabled, and `writeSlotFile` would refuse the write regardless.
 */
export function slotOverwriteLabel(summary: SlotSummary): string {
  switch (summary.status) {
    case 'ok': {
      const quarter = summary.savedQuarter === null ? '' : ` · ${quarterLabel(DEMO_START_YEAR, summary.savedQuarter)}`;
      return `Slot ${summary.slot} — overwrites ${summary.companyName ?? DEFAULT_COMPANY_NAME}${quarter}`;
    }
    case 'unsupported':
      return `Slot ${summary.slot} — newer build, preserved`;
    case 'unreadable':
      return `Slot ${summary.slot} — overwrites an unreadable file`;
    default:
      return `Slot ${summary.slot} — empty`;
  }
}
