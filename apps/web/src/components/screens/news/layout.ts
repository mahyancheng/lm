/**
 * The front page's arithmetic: sections, editions, the lead and the tiers.
 *
 * Plain functions over the projected record, so the newspaper's rules can be
 * tested without a DOM:
 *
 * - **Sections** are the five words on the strip and the kinds each keeps.
 * - **Editions** are quarters: the front page mounts one, and the list at the
 *   bottom names the rest.
 * - **The layout** is importance made visible. The heaviest item leads; the
 *   next few form the second tier; everything else is a brief. Weight is the
 *   engine's — nothing here re-sorts by anything the engine did not decide.
 * - **Params** are the screen's URL state, so a section survives navigation.
 */

import type { PublicRecordItem, PublicRecordKind, Sector } from '@frontier/contracts';
import { SECTORS } from '@frontier/contracts';
import type { Measurer } from '@/lib/text/measure';

/* -------------------------------------------------------------------------- */
/*  Sections                                                                   */
/* -------------------------------------------------------------------------- */

export const NEWS_SECTIONS = ['front', 'markets', 'press', 'street', 'world'] as const;
export type NewsSection = (typeof NEWS_SECTIONS)[number];

export const SECTION_LABEL: Readonly<Record<NewsSection, string>> = {
  front: 'Front page',
  markets: 'Markets',
  press: 'Press',
  street: 'The Street',
  world: 'World',
};

const SECTION_KINDS: Readonly<Record<NewsSection, readonly PublicRecordKind[] | null>> = {
  front: null,
  markets: ['disclosure'],
  press: ['story'],
  street: ['post', 'reply'],
  world: ['event'],
};

/** The kinds a section keeps, or null for the front page, which keeps every kind. */
export function kindsOfSection(section: NewsSection): readonly PublicRecordKind[] | null {
  return SECTION_KINDS[section];
}

export function isNewsSection(value: string | null | undefined): value is NewsSection {
  return value !== null && value !== undefined && (NEWS_SECTIONS as readonly string[]).includes(value);
}

/* -------------------------------------------------------------------------- */
/*  Params                                                                     */
/* -------------------------------------------------------------------------- */

export interface NewsParams {
  readonly section: NewsSection;
  /** Narrow to items about the reader. */
  readonly mine: boolean;
  readonly sector: Sector | null;
  readonly companyId: string | null;
  /** A past quarter to read, or null for the newest edition. */
  readonly edition: number | null;
}

export const DEFAULT_NEWS_PARAMS: NewsParams = { section: 'front', mine: false, sector: null, companyId: null, edition: null };

/** Read the screen's state off a query string. Anything malformed falls back to the default. */
export function parseNewsParams(search: URLSearchParams | string | null | undefined): NewsParams {
  const params = typeof search === 'string' ? new URLSearchParams(search) : (search ?? new URLSearchParams());
  const section = params.get('section');
  const sector = params.get('sector');
  const edition = params.get('edition');
  const parsedEdition = edition === null ? Number.NaN : Number.parseInt(edition, 10);
  return {
    section: isNewsSection(section) ? section : 'front',
    mine: params.get('mine') === '1',
    sector: sector !== null && (SECTORS as readonly string[]).includes(sector) ? (sector as Sector) : null,
    companyId: params.get('company'),
    edition: Number.isInteger(parsedEdition) && parsedEdition >= 0 ? parsedEdition : null,
  };
}

/** The query string for a state. Defaults are omitted, so the plain route stays plain. */
export function serialiseNewsParams(params: NewsParams): string {
  const out = new URLSearchParams();
  if (params.section !== 'front') out.set('section', params.section);
  if (params.mine) out.set('mine', '1');
  if (params.sector !== null) out.set('sector', params.sector);
  if (params.companyId !== null) out.set('company', params.companyId);
  if (params.edition !== null) out.set('edition', String(params.edition));
  const text = out.toString();
  return text.length === 0 ? '' : `?${text}`;
}

/* -------------------------------------------------------------------------- */
/*  Editions                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The quarter the front page opens on: the requested edition when it is one
 * the record has, else the newest quarter on the record, else null when the
 * record is empty.
 */
export function resolveEdition(requested: number | null, quartersOnRecord: readonly number[]): number | null {
  if (quartersOnRecord.length === 0) return null;
  if (requested !== null && quartersOnRecord.includes(requested)) return requested;
  return Math.max(...quartersOnRecord);
}

/* -------------------------------------------------------------------------- */
/*  The layout                                                                 */
/* -------------------------------------------------------------------------- */

export interface FrontPageLayout {
  readonly lead: PublicRecordItem | null;
  /** Rows of one or two items: two when both fit side by side, one when either would not. */
  readonly secondTier: readonly (readonly PublicRecordItem[])[];
  readonly briefs: readonly PublicRecordItem[];
}

/** How many items may follow the lead before the briefs begin. */
export const SECOND_TIER_MAX = 4;
/** With fewer than this many items after the lead, there is no second tier — a tier of one is a brief. */
export const SECOND_TIER_MIN = 2;

export interface TierMeasure {
  readonly measurer: Measurer | null;
  /** The width of the whole column, in px. */
  readonly widthPx: number;
  readonly gapPx: number;
  /** The headline face the second tier is set in. */
  readonly family: string;
  readonly weight: number;
  readonly sizePx: number;
  readonly leading: number;
  /** The most lines a paired headline may take at half width. */
  readonly maxPairedLines: number;
}

/**
 * Lay one quarter's items out as a front page.
 *
 * `items` arrive in engine order — heaviest first — and the layout keeps it:
 * the lead is the first, the second tier the next few that are not replies (a
 * reply belongs under the post it answers, which the briefs show), and the
 * briefs are everything else in the same order. Whether two second-tier items
 * sit side by side is decided by measuring both headlines at half width; with
 * no measurer, by their length.
 */
export function layoutFrontPage(items: readonly PublicRecordItem[], measure: TierMeasure | null): FrontPageLayout {
  if (items.length === 0) return { lead: null, secondTier: [], briefs: [] };
  const [lead, ...rest] = items;
  if (lead === undefined) return { lead: null, secondTier: [], briefs: [] };

  const candidates: PublicRecordItem[] = [];
  const briefs: PublicRecordItem[] = [];
  for (const item of rest) {
    if (candidates.length < SECOND_TIER_MAX && item.kind !== 'reply' && item.links.replyToPostId === null) candidates.push(item);
    else briefs.push(item);
  }
  if (candidates.length < SECOND_TIER_MIN) {
    // Too few for a tier: they read as the first briefs instead, in weight order.
    return { lead, secondTier: [], briefs: [...candidates, ...briefs].sort(byEngineOrder(items)) };
  }
  return { lead, secondTier: pairForColumns(candidates, measure), briefs };
}

/** Restore the engine's order after a partition, by original index. */
function byEngineOrder(items: readonly PublicRecordItem[]): (a: PublicRecordItem, b: PublicRecordItem) => number {
  const index = new Map(items.map((item, at) => [item.id, at]));
  return (a, b) => (index.get(a.id) ?? 0) - (index.get(b.id) ?? 0);
}

/**
 * Pair second-tier items into rows of two where both headlines fit at half
 * width in `maxPairedLines`, else rows of one. Greedy and in order: a pair is
 * two adjacent items, so importance still reads top to bottom.
 */
export function pairForColumns(items: readonly PublicRecordItem[], measure: TierMeasure | null): (readonly PublicRecordItem[])[] {
  const rows: (readonly PublicRecordItem[])[] = [];
  let index = 0;
  while (index < items.length) {
    const first = items[index];
    const second = items[index + 1];
    if (first === undefined) break;
    if (second !== undefined && fitsHalf(first, measure) && fitsHalf(second, measure)) {
      rows.push([first, second]);
      index += 2;
    } else {
      rows.push([first]);
      index += 1;
    }
  }
  return rows;
}

/** Whether a headline fits the half-width budget: measured when possible, by length otherwise. */
export function fitsHalf(item: PublicRecordItem, measure: TierMeasure | null): boolean {
  if (measure === null || measure.measurer === null) return item.headline.length <= HALF_WIDTH_FALLBACK_CHARS;
  const columnWidth = Math.floor((measure.widthPx - measure.gapPx) / 2);
  const { lineCount } = measure.measurer.extent(
    item.headline,
    { family: measure.family, weight: measure.weight, sizePx: measure.sizePx, leading: measure.leading },
    columnWidth,
  );
  return lineCount <= measure.maxPairedLines;
}

/** Without a measurer: about four lines of 17px serif in a 175px column. */
export const HALF_WIDTH_FALLBACK_CHARS = 64;

/* -------------------------------------------------------------------------- */
/*  Threads                                                                    */
/* -------------------------------------------------------------------------- */

/** The item a reply answers, when it is on the same page. */
export function parentOf(item: PublicRecordItem, byId: ReadonlyMap<string, PublicRecordItem>): PublicRecordItem | null {
  const parentId = item.links.replyToPostId ?? item.links.causalParentId ?? item.links.sourceEventId;
  return parentId === null ? null : (byId.get(parentId) ?? null);
}

/** The id an item follows from, in the order a reader cares: the post it answers, the event that made it likelier, the event it reports. */
export function followsId(item: PublicRecordItem): string | null {
  return item.links.replyToPostId ?? item.links.causalParentId ?? item.links.sourceEventId;
}
