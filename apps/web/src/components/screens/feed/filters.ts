/**
 * The feed's pure arithmetic: what is shown, in what order, under what.
 *
 * `projectPublicRecord` hands the client one list that is already redacted and
 * already sorted. Everything a screen does to it afterwards is here, as plain
 * functions over plain data, so it can be tested without a DOM:
 *
 * - **filtering** is a predicate over the item's own fields, never over the
 *   author. The feed is universal; a filter narrows a subject, never a side.
 * - **threading** attaches a reply to the post it answers when that post is in
 *   the same list, and leaves it in the stream as its own card when it is not.
 *   An orphan reply is still something somebody said.
 * - **grouping** buckets by quarter, preserving the order the engine chose.
 *
 * Nothing here re-sorts by anything the engine did not already decide, and
 * nothing invents a figure: `comparePublicRecordItems` is the one ordering.
 */

import type { NetworkArchetype, PublicRecordItem, PublicRecordKind, Sector } from '@frontier/contracts';
import { SECTORS, comparePublicRecordItems } from '@frontier/contracts';

/* -------------------------------------------------------------------------- */
/*  Kind groups                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The four words a reader filters by.
 *
 * Five kinds, four chips: a reply is a post that happens to answer another one,
 * and splitting them would hide half a conversation behind a filter.
 */
export const FEED_KIND_GROUPS = ['events', 'press', 'leaks', 'posts'] as const;
export type FeedKindGroup = (typeof FEED_KIND_GROUPS)[number];

const GROUP_KINDS: Readonly<Record<FeedKindGroup, readonly PublicRecordKind[]>> = {
  events: ['event'],
  press: ['story'],
  leaks: ['disclosure'],
  posts: ['post', 'reply'],
};

export function kindsOfGroup(group: FeedKindGroup): readonly PublicRecordKind[] {
  return GROUP_KINDS[group];
}

export function groupOfKind(kind: PublicRecordKind): FeedKindGroup {
  switch (kind) {
    case 'event':
      return 'events';
    case 'story':
      return 'press';
    case 'disclosure':
      return 'leaks';
    default:
      return 'posts';
  }
}

/* -------------------------------------------------------------------------- */
/*  The filter                                                                 */
/* -------------------------------------------------------------------------- */

export interface FeedFilter {
  /** Kinds to keep. Null means every kind — the default the feed opens on. */
  readonly kinds: readonly PublicRecordKind[] | null;
  /** A sector the item must touch. Null means every sector. */
  readonly sector: Sector | null;
  /** A company the item must name. Null means every company. */
  readonly companyId: string | null;
  /** Networks to keep, for the social view. Null means every network. */
  readonly networks: readonly NetworkArchetype[] | null;
}

/** The open filter: everything, in the order the engine returned it. */
export const FEED_FILTER_ALL: FeedFilter = { kinds: null, sector: null, companyId: null, networks: null };

/**
 * The sectors an item touches, in `SECTORS` order.
 *
 * `PublicRecordItem.sectorIds` carries the *market* sector keys the engine
 * prices with (`frontier_models`, `energy_infrastructure`), which is a different
 * axis from the six sectors a player reads the world by. So the reader's sector
 * is derived from the companies the item actually names, exactly as the old
 * chronicle derived its badges: nothing is attributed to a sector the item does
 * not touch, and an economy-wide item belongs to none of them.
 */
export function feedSectorsOf(item: PublicRecordItem, companySectors: ReadonlyMap<string, Sector>): Sector[] {
  const seen = new Set<Sector>();
  for (const id of item.companyIds) {
    const sector = companySectors.get(id);
    if (sector !== undefined) seen.add(sector);
  }
  return SECTORS.filter((sector) => seen.has(sector));
}

export function matchesFeedFilter(
  item: PublicRecordItem,
  filter: FeedFilter,
  companySectors: ReadonlyMap<string, Sector> = new Map(),
): boolean {
  if (filter.kinds !== null && !filter.kinds.includes(item.kind)) return false;
  // A sector filter narrows to a part of the economy, so an item that names
  // nobody in it — including one that names nobody at all — is out. The chip is
  // "show me energy", not "hide the rest of energy".
  if (filter.sector !== null && !feedSectorsOf(item, companySectors).includes(filter.sector)) return false;
  if (filter.companyId !== null && !item.companyIds.includes(filter.companyId)) return false;
  // A network filter is about posts. An item without a network — an event, a
  // story, a filing — is not "on no network", it is simply not of this axis, so
  // it fails a network filter rather than passing it by omission.
  if (filter.networks !== null && (item.network === null || !filter.networks.includes(item.network))) return false;
  return true;
}

/** Keep the items that match, in the order they arrived. */
export function filterFeed(
  items: readonly PublicRecordItem[],
  filter: FeedFilter,
  companySectors: ReadonlyMap<string, Sector> = new Map(),
): PublicRecordItem[] {
  return items.filter((item) => matchesFeedFilter(item, filter, companySectors));
}

/** How many items each chip would show, so a chip that shows nothing can say so. */
export function countByKindGroup(items: readonly PublicRecordItem[]): Readonly<Record<FeedKindGroup, number>> {
  const counts: Record<FeedKindGroup, number> = { events: 0, press: 0, leaks: 0, posts: 0 };
  for (const item of items) counts[groupOfKind(item.kind)] += 1;
  return counts;
}

/** How many items mention each network, keyed for the social view's chips. */
export function countByNetwork(items: readonly PublicRecordItem[]): ReadonlyMap<NetworkArchetype, number> {
  const counts = new Map<NetworkArchetype, number>();
  for (const item of items) {
    if (item.network === null) continue;
    counts.set(item.network, (counts.get(item.network) ?? 0) + 1);
  }
  return counts;
}

/**
 * Every sector the feed actually touches, in `SECTORS` order.
 *
 * Derived from the items rather than from the world, so a chip never offers a
 * filter that would empty the screen.
 */
export function sectorsInFeed(items: readonly PublicRecordItem[], companySectors: ReadonlyMap<string, Sector>): Sector[] {
  const seen = new Set<Sector>();
  for (const item of items) for (const sector of feedSectorsOf(item, companySectors)) seen.add(sector);
  return SECTORS.filter((sector) => seen.has(sector));
}

/** How many items each sector chip would show. */
export function countBySector(
  items: readonly PublicRecordItem[],
  companySectors: ReadonlyMap<string, Sector>,
): Readonly<Partial<Record<Sector, number>>> {
  const counts: Partial<Record<Sector, number>> = {};
  for (const item of items) {
    for (const sector of feedSectorsOf(item, companySectors)) counts[sector] = (counts[sector] ?? 0) + 1;
  }
  return counts;
}

/** Every company the feed names, most-mentioned first, then by id. */
export function companiesInFeed(items: readonly PublicRecordItem[]): { readonly id: string; readonly count: number }[] {
  const counts = new Map<string, number>();
  for (const item of items) for (const id of item.companyIds) counts.set(id, (counts.get(id) ?? 0) + 1);
  return [...counts.entries()]
    .map(([id, count]) => ({ id, count }))
    .sort((a, b) => (b.count !== a.count ? b.count - a.count : a.id.localeCompare(b.id)));
}

/* -------------------------------------------------------------------------- */
/*  Threads                                                                    */
/* -------------------------------------------------------------------------- */

export interface FeedThread {
  /** The card at the top level: a post, an event, anything. */
  readonly item: PublicRecordItem;
  /** Replies to it that are present in this same list. Heaviest first. */
  readonly replies: readonly PublicRecordItem[];
}

/**
 * Group replies under the post they answer.
 *
 * A reply whose parent is not in the list — filtered out, or older than the
 * window — stays at the top level rather than disappearing. Threads are two
 * deep by construction: a reply to a reply is attached to the reply, and the
 * engine never produces one.
 */
export function threadFeed(items: readonly PublicRecordItem[]): FeedThread[] {
  const present = new Set(items.map((item) => item.id));
  const replies = new Map<string, PublicRecordItem[]>();

  for (const item of items) {
    const parentId = item.links.replyToPostId;
    if (parentId === null || !present.has(parentId)) continue;
    const bucket = replies.get(parentId);
    if (bucket === undefined) replies.set(parentId, [item]);
    else bucket.push(item);
  }

  const threads: FeedThread[] = [];
  for (const item of items) {
    const parentId = item.links.replyToPostId;
    if (parentId !== null && present.has(parentId)) continue;
    const own = replies.get(item.id);
    threads.push({ item, replies: own === undefined ? [] : [...own].sort(comparePublicRecordItems) });
  }
  return threads;
}

/* -------------------------------------------------------------------------- */
/*  Quarters                                                                   */
/* -------------------------------------------------------------------------- */

export interface FeedQuarter {
  readonly quarter: number;
  readonly threads: readonly FeedThread[];
}

/**
 * Bucket threads by the quarter they landed in, newest first.
 *
 * The engine already ordered the list, so the buckets come out in order simply
 * by walking it; a quarter is opened the first time it is seen.
 */
export function groupByQuarter(threads: readonly FeedThread[]): FeedQuarter[] {
  const out: { quarter: number; threads: FeedThread[] }[] = [];
  for (const thread of threads) {
    const last = out[out.length - 1];
    if (last !== undefined && last.quarter === thread.item.quarter) last.threads.push(thread);
    else out.push({ quarter: thread.item.quarter, threads: [thread] });
  }
  return out;
}

/** Filter, thread and group in the one order the screens use. */
export function buildFeed(
  items: readonly PublicRecordItem[],
  filter: FeedFilter,
  companySectors: ReadonlyMap<string, Sector> = new Map(),
): FeedQuarter[] {
  return groupByQuarter(threadFeed(filterFeed(items, filter, companySectors)));
}

/* -------------------------------------------------------------------------- */
/*  Readings                                                                   */
/* -------------------------------------------------------------------------- */

/** The loudest posts by measured reach — the trending strip, and nothing more. */
export function topByReach(items: readonly PublicRecordItem[], count: number): PublicRecordItem[] {
  return items
    .filter((item) => item.reach !== null && item.reach > 0)
    .sort((a, b) => ((b.reach ?? 0) !== (a.reach ?? 0) ? (b.reach ?? 0) - (a.reach ?? 0) : a.id.localeCompare(b.id)))
    .slice(0, Math.max(0, count));
}

/**
 * Is this the player's own voice?
 *
 * The one distinction the feed still draws, and it is a chip, not a partition:
 * the player's items sit in the stream with everybody else's.
 */
export function isOwnItem(item: PublicRecordItem, playerCharacterId: string, playerCompanyId: string): boolean {
  if (item.who.characterId !== null && item.who.characterId === playerCharacterId) return true;
  return item.who.companyId !== null && item.who.companyId === playerCompanyId;
}
