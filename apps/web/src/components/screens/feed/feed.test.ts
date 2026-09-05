/**
 * The feed's arithmetic, checked against the rules the screen promises.
 *
 * Two kinds of evidence here, deliberately. The filtering and threading rules
 * are checked against fixtures parsed by `PublicRecordItemSchema`, so a fixture
 * can never drift from the contract the engine projects. The world-version-1
 * rendering path is checked against a **real session**, because the thing that
 * would actually break a frozen world is a helper that assumes six sectors.
 *
 * The one rule every test here exists to protect: the feed is universal. No
 * function in `filters.ts` may narrow by who wrote something.
 */

import { describe, expect, it } from 'vitest';
import type { PublicRecordItem, Sector } from '@frontier/contracts';
import { NEW_GAME_BACKGROUND_IDS, PublicRecordItemSchema } from '@frontier/contracts';
import { projectPublicRecord } from '@frontier/simulation';
import { PLAYER_ID, createSession } from '../../../lib/game/engine';
import { sectorOf, sectorsPresent } from '../../ui/sector';
import {
  FEED_FILTER_ALL,
  buildFeed,
  companiesInFeed,
  countByKindGroup,
  countByNetwork,
  countBySector,
  feedSectorsOf,
  filterFeed,
  groupByQuarter,
  groupOfKind,
  isOwnItem,
  kindsOfGroup,
  matchesFeedFilter,
  sectorsInFeed,
  threadFeed,
  topByReach,
} from './filters';

/* -------------------------------------------------------------------------- */
/*  Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

let counter = 0;

/** A contract-valid item. Every field the tests do not care about is a default. */
function makeItem(overrides: Partial<PublicRecordItem> = {}): PublicRecordItem {
  counter += 1;
  return PublicRecordItemSchema.parse({
    id: `itm_${String(counter).padStart(3, '0')}`,
    quarter: 0,
    kind: 'post',
    who: { characterId: 'chr_npc', companyId: 'cmp_rival', name: 'A Rival', isAi: true },
    sectorIds: [],
    companyIds: [],
    headline: 'A thing that happened',
    deck: null,
    body: '',
    kicker: { word: 'Announcement', sector: null, company: null },
    tone: 0,
    weight: 0.5,
    links: { causalParentId: null, sourceEventId: null, sourcePostIds: [], replyToPostId: null },
    ledgerEventIds: [],
    whyItMatters: null,
    network: 'fast_feed',
    intent: 'announce',
    reach: 1000,
    pressPickup: false,
    ...overrides,
  });
}

/** Company → sector, the map every screen builds from its own visible companies. */
const SECTORS_BY_COMPANY: ReadonlyMap<string, Sector> = new Map<string, Sector>([
  ['cmp_player', 'ai'],
  ['cmp_rival', 'ai'],
  ['cmp_grid', 'energy'],
  ['cmp_arm', 'robotics'],
]);

/* -------------------------------------------------------------------------- */
/*  Kinds                                                                      */
/* -------------------------------------------------------------------------- */

describe('the four chips cover the five kinds', () => {
  it('files a reply with posts, because half a conversation is not a filter', () => {
    expect(groupOfKind('reply')).toBe('posts');
    expect(kindsOfGroup('posts')).toEqual(['post', 'reply']);
  });

  it('counts every item under exactly one chip', () => {
    const items = [
      makeItem({ kind: 'event', network: null, intent: null, reach: null }),
      makeItem({ kind: 'story', network: null, intent: null, reach: 5 }),
      makeItem({ kind: 'disclosure', network: null, intent: null, reach: null }),
      makeItem({ kind: 'post' }),
      makeItem({ kind: 'reply' }),
    ];
    const counts = countByKindGroup(items);
    expect(counts).toEqual({ events: 1, press: 1, leaks: 1, posts: 2 });
    expect(counts.events + counts.press + counts.leaks + counts.posts).toBe(items.length);
  });

  it('keeps posts and replies together under the posts filter', () => {
    const items = [makeItem({ kind: 'post' }), makeItem({ kind: 'reply' }), makeItem({ kind: 'story', network: null, intent: null })];
    const kept = filterFeed(items, { ...FEED_FILTER_ALL, kinds: kindsOfGroup('posts') });
    expect(kept.map((item) => item.kind)).toEqual(['post', 'reply']);
  });
});

/* -------------------------------------------------------------------------- */
/*  Filtering                                                                  */
/* -------------------------------------------------------------------------- */

describe('a filter narrows a subject, never a side', () => {
  it('treats the player and an NPC identically', () => {
    const mine = makeItem({ who: { characterId: 'chr_me', companyId: 'cmp_player', name: 'You', isAi: false }, companyIds: ['cmp_player'] });
    const theirs = makeItem({ who: { characterId: 'chr_npc', companyId: 'cmp_rival', name: 'A Rival', isAi: true }, companyIds: ['cmp_player'] });
    const filter = { ...FEED_FILTER_ALL, companyId: 'cmp_player' };
    expect(matchesFeedFilter(mine, filter)).toBe(true);
    expect(matchesFeedFilter(theirs, filter)).toBe(true);
  });

  it('keeps the player in the stream under every filter', () => {
    const mine = makeItem({ who: { characterId: 'chr_me', companyId: 'cmp_player', name: 'You', isAi: false }, companyIds: ['cmp_grid'] });
    expect(matchesFeedFilter(mine, { ...FEED_FILTER_ALL, sector: 'energy' }, SECTORS_BY_COMPANY)).toBe(true);
    expect(isOwnItem(mine, 'chr_me', 'cmp_player')).toBe(true);
  });

  it('derives an item sector from the companies it names, not from its market keys', () => {
    // `sectorIds` on the wire is the market bucket the engine prices with; the
    // reader's six sectors come from the companies.
    const item = makeItem({ companyIds: ['cmp_grid'], sectorIds: ['energy_infrastructure'] });
    expect(feedSectorsOf(item, SECTORS_BY_COMPANY)).toEqual(['energy']);
    expect(matchesFeedFilter(item, { ...FEED_FILTER_ALL, sector: 'energy' }, SECTORS_BY_COMPANY)).toBe(true);
    expect(matchesFeedFilter(item, { ...FEED_FILTER_ALL, sector: 'ai' }, SECTORS_BY_COMPANY)).toBe(false);
  });

  it('orders an item sectors the way the contract does', () => {
    const item = makeItem({ companyIds: ['cmp_grid', 'cmp_arm', 'cmp_rival'] });
    expect(feedSectorsOf(item, SECTORS_BY_COMPANY)).toEqual(['ai', 'robotics', 'energy']);
  });

  it('drops an economy-wide item from a sector filter rather than passing it by omission', () => {
    const item = makeItem({ kind: 'event', companyIds: [], network: null, intent: null, reach: null });
    expect(matchesFeedFilter(item, { ...FEED_FILTER_ALL, sector: 'ai' }, SECTORS_BY_COMPANY)).toBe(false);
    expect(matchesFeedFilter(item, FEED_FILTER_ALL, SECTORS_BY_COMPANY)).toBe(true);
  });

  it('excludes an item with no network from a network filter', () => {
    const event = makeItem({ kind: 'event', network: null, intent: null, reach: null });
    const post = makeItem({ kind: 'post', network: 'finance' });
    const kept = filterFeed([event, post], { ...FEED_FILTER_ALL, networks: ['finance'] });
    expect(kept).toEqual([post]);
  });

  it('preserves the engine ordering through a filter', () => {
    const items = [makeItem({ quarter: 3 }), makeItem({ quarter: 3, weight: 0.2 }), makeItem({ quarter: 1 })];
    expect(filterFeed(items, FEED_FILTER_ALL).map((item) => item.id)).toEqual(items.map((item) => item.id));
  });

  it('offers only sectors and companies the feed actually names', () => {
    const items = [makeItem({ companyIds: ['cmp_grid'] }), makeItem({ companyIds: ['cmp_grid', 'cmp_rival'] })];
    expect(sectorsInFeed(items, SECTORS_BY_COMPANY)).toEqual(['ai', 'energy']);
    expect(countBySector(items, SECTORS_BY_COMPANY)).toEqual({ ai: 1, energy: 2 });
    expect(companiesInFeed(items)).toEqual([
      { id: 'cmp_grid', count: 2 },
      { id: 'cmp_rival', count: 1 },
    ]);
  });

  it('counts posts per network for the social chips', () => {
    const items = [makeItem({ network: 'finance' }), makeItem({ network: 'finance' }), makeItem({ network: 'video' })];
    const counts = countByNetwork(items);
    expect(counts.get('finance')).toBe(2);
    expect(counts.get('video')).toBe(1);
    expect(counts.get('community')).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- */
/*  Threads                                                                    */
/* -------------------------------------------------------------------------- */

describe('a reply hangs under the post it answers', () => {
  const parent = makeItem({ id: 'post_parent', kind: 'post', weight: 0.9 });
  const replyA = makeItem({
    id: 'post_reply_a',
    kind: 'reply',
    weight: 0.4,
    links: { causalParentId: null, sourceEventId: null, sourcePostIds: [], replyToPostId: 'post_parent' },
  });
  const replyB = makeItem({
    id: 'post_reply_b',
    kind: 'reply',
    weight: 0.7,
    links: { causalParentId: null, sourceEventId: null, sourcePostIds: [], replyToPostId: 'post_parent' },
  });
  const other = makeItem({ id: 'post_other', kind: 'post', weight: 0.8 });

  it('removes the reply from the top level and attaches it to its parent', () => {
    const threads = threadFeed([parent, other, replyB, replyA]);
    expect(threads.map((thread) => thread.item.id)).toEqual(['post_parent', 'post_other']);
    expect(threads[0]?.replies.map((reply) => reply.id)).toEqual(['post_reply_b', 'post_reply_a']);
    expect(threads[1]?.replies).toEqual([]);
  });

  it('orders replies the way the feed orders everything: heaviest first', () => {
    const threads = threadFeed([parent, replyA, replyB]);
    const weights = (threads[0]?.replies ?? []).map((reply) => reply.weight);
    expect(weights).toEqual([...weights].sort((a, b) => b - a));
  });

  it('keeps the parent where the engine put it', () => {
    const threads = threadFeed([other, parent, replyA]);
    expect(threads.map((thread) => thread.item.id)).toEqual(['post_other', 'post_parent']);
  });

  it('leaves an orphan reply in the stream as its own card', () => {
    // The parent is filtered out — by company, by network, by anything. What
    // somebody said is still on the record.
    const threads = threadFeed([replyA]);
    expect(threads).toHaveLength(1);
    expect(threads[0]?.item.id).toBe('post_reply_a');
    expect(threads[0]?.replies).toEqual([]);
  });

  it('counts every item exactly once across the threads', () => {
    const items = [parent, other, replyA, replyB];
    const threads = threadFeed(items);
    const total = threads.reduce((sum, thread) => sum + 1 + thread.replies.length, 0);
    expect(total).toBe(items.length);
  });
});

/* -------------------------------------------------------------------------- */
/*  Quarters                                                                   */
/* -------------------------------------------------------------------------- */

describe('quarters divide the stream without reordering it', () => {
  it('opens a group per run of a quarter, in the order given', () => {
    const items = [makeItem({ quarter: 4 }), makeItem({ quarter: 4 }), makeItem({ quarter: 2 })];
    const groups = groupByQuarter(threadFeed(items));
    expect(groups.map((group) => group.quarter)).toEqual([4, 2]);
    expect(groups[0]?.threads).toHaveLength(2);
    expect(groups[1]?.threads).toHaveLength(1);
  });

  it('puts a reply in its parent thread, never in a group of its own', () => {
    const parent = makeItem({ id: 'p1', quarter: 5 });
    const reply = makeItem({
      id: 'r1',
      kind: 'reply',
      quarter: 5,
      links: { causalParentId: null, sourceEventId: null, sourcePostIds: [], replyToPostId: 'p1' },
    });
    const groups = buildFeed([parent, reply], FEED_FILTER_ALL);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.threads).toHaveLength(1);
    expect(groups[0]?.threads[0]?.replies.map((entry) => entry.id)).toEqual(['r1']);
  });
});

/* -------------------------------------------------------------------------- */
/*  Readings                                                                   */
/* -------------------------------------------------------------------------- */

describe('the trending strip is measured reach and nothing else', () => {
  it('takes the loudest, breaking ties by id so two runs agree', () => {
    const quiet = makeItem({ id: 'a', reach: 10 });
    const loud = makeItem({ id: 'b', reach: 900 });
    const tie = makeItem({ id: 'c', reach: 900 });
    expect(topByReach([quiet, tie, loud], 2).map((item) => item.id)).toEqual(['b', 'c']);
  });

  it('ignores items with no measured audience', () => {
    const event = makeItem({ kind: 'event', network: null, intent: null, reach: null });
    expect(topByReach([event], 3)).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/*  The frozen world                                                           */
/* -------------------------------------------------------------------------- */

describe('a world-version-1 session still renders', () => {
  const session = createSession();
  const items = projectPublicRecord(session, PLAYER_ID, {});
  const companySectors = new Map(session.companies.map((company) => [company.id, sectorOf(company)]));

  it('is single-sector, so the screen draws no sector chips', () => {
    expect(session.config.worldVersion).toBe(1);
    // The multi-sector test is the shape of the world, never a version number.
    expect(sectorsPresent(session.companies).length).toBe(1);
    expect(sectorsInFeed(items, companySectors).length).toBeLessThan(2);
  });

  it('still builds a feed out of the record it does have', () => {
    expect(items.length).toBeGreaterThan(0);
    const groups = buildFeed(items, FEED_FILTER_ALL, companySectors);
    expect(groups.length).toBeGreaterThan(0);
    const rendered = groups.flatMap((group) => group.threads.map((thread) => thread.item));
    expect(rendered).toHaveLength(items.length);
    for (const item of rendered) expect(item.headline.length).toBeGreaterThan(0);
  });

  it('narrows by kind exactly as it does in a six-sector world', () => {
    const filings = filterFeed(items, { ...FEED_FILTER_ALL, kinds: kindsOfGroup('leaks') }, companySectors);
    expect(filings.length).toBe(countByKindGroup(items).leaks);
  });
});

describe('a world-version-2 session filters by the six sectors', () => {
  const session = createSession({
    setup: { companyName: 'Probe', founderName: 'P Tester', backgroundId: NEW_GAME_BACKGROUND_IDS[0], worldVersion: 2 },
  });
  const items = projectPublicRecord(session, PLAYER_ID, {});
  const companySectors = new Map(session.companies.map((company) => [company.id, sectorOf(company)]));

  it('offers only sectors the record names, and keeps only items that touch one', () => {
    expect(sectorsPresent(session.companies).length).toBeGreaterThan(1);
    const offered = sectorsInFeed(items, companySectors);
    expect(offered.length).toBeGreaterThan(0);
    for (const sector of offered) {
      const kept = filterFeed(items, { ...FEED_FILTER_ALL, sector }, companySectors);
      expect(kept.length).toBeGreaterThan(0);
      for (const item of kept) expect(feedSectorsOf(item, companySectors)).toContain(sector);
    }
  });
});
