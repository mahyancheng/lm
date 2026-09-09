/**
 * @frontier/simulation — resolver/publicRecord.ts
 *
 * One feed, projected to one seat — and written like a newspaper.
 *
 * World events, press stories, public disclosures and social posts are four
 * tables because they behave differently inside the engine. To a reader they are
 * one thing: what became public, most recent first. `projectPublicRecord` is the
 * merge — and, like `projection.ts`, it is a **redaction, never a repair**. An
 * item this seat may not see is absent; nothing is blurred, summarised or
 * rewritten to be safe.
 *
 * What is redacted, and why:
 *
 * - A **world event** is public, sector-scoped or private, exactly as
 *   `EventVisibility` says. A private event reaches only the companies it names.
 * - A **story** and a **disclosure** are public by construction: publication is
 *   what they are. `PublicDisclosure.isTruthful` is canonical reality and is
 *   never projected — the whole point of a rumour is that the reader has to
 *   decide.
 * - A **post** is public. Its `engagement` is engine output and is summarised as
 *   reach and a press-pickup flag, never as a claim about what it will do next.
 *
 * What is *written*, and how:
 *
 * - The **headline** is a real headline, at most ninety characters. For an
 *   event, a story and a disclosure it is the row's own title. For a post it is
 *   the post's own first sentence or clause — never "so-and-so posted on the
 *   fast feed", which is a byline restated as a title.
 * - The **deck** is one sentence of engine figures under the headline: how
 *   severe an event is and how long it has to run, how believed and how widely
 *   read a story is, what kind of disclosure a filing is. A post has none; its
 *   body is the whole of it.
 * - The **kicker** is the small-caps line a paper sets above a headline: the
 *   kind word (press release, rumour, leak, the angle of a story, the type of a
 *   shock, the intent of a post), the sector and the company.
 * - The **body** is the row as published, in full. The projection never
 *   truncates it; every source table is already bounded by its own schema.
 *
 * What is *folded*, and why:
 *
 * - A post loud enough to move market belief is also stored as a
 *   `PublicDisclosure` — a press release, a rumour, a leak — with the same
 *   words. Two tables, one utterance. The record prints it **once**, as the
 *   post: the disclosure's kind and credibility ride along as `heard`, its
 *   ledger rows are cited beside the post's, and the item takes the heavier of
 *   the two weights. A paper that prints "16% off the quarter" twice, once as a
 *   Broadside and once as a Rumour, is not a paper.
 *
 * What is *attributed*, and to whom:
 *
 * - `who` is the speaker. For a disclosure that is the source character and
 *   the company *they* work for — never the company the disclosure is about,
 *   which is the subject and stays in `companyIds` and the kicker. A rival's
 *   attack on the reader is filed under the rival, not marked as the reader's
 *   own line.
 *
 * `whyItMatters` is the one line that makes the feed worth reading: a
 * whole-number consequence *for this seat*, computed from what the item actually
 * produced — the modifiers a world event carries, the hostility a post aimed at
 * you created, the reputation your own post moved. When an item did nothing to
 * this player it is null, because a feed in which everything matters says
 * nothing.
 */

import type {
  ActiveModifier,
  Character,
  Company,
  DisclosureKind,
  MediaStory,
  PostIntent,
  PublicDisclosure,
  PublicRecordItem,
  Sector,
  SessionState,
  SimEvent,
  SocialAccount,
  SocialPost,
  StoryAngle,
  WorldEvent,
  WorldEventType,
} from '@frontier/contracts';
import { PUBLIC_RECORD_DECK_MAX, PUBLIC_RECORD_HEADLINE_MAX, comparePublicRecordItems } from '@frontier/contracts';
import { formatDelta, formatMoney, formatPct } from '@frontier/shared';
import { POST_HEADLINE_MAX, clipHeadline, headlineFromText } from '../social/headline';
import { audienceFor, isEventVisibleTo, type PlayerAudience } from './projection';

// The headline rules are shared with the social engine, which titles a stored
// disclosure the same way; they are re-exported here so callers of the
// projection find them where the writing is.
export { POST_HEADLINE_MAX, clipHeadline, headlineFromText };

/* -------------------------------------------------------------------------- */
/*  Options                                                                    */
/* -------------------------------------------------------------------------- */

export interface PublicRecordOptions {
  /**
   * Committed ledger rows for the quarters on show, when the caller holds them.
   *
   * The ledger lives beside the session rather than in it, so the projection
   * works without one: `ledgerEventIds` is then empty, and `whyItMatters` is
   * computed from state alone. Rows the seat may not read are filtered out
   * before anything is attached, so supplying a ledger can never widen what the
   * feed shows.
   */
  readonly ledger?: readonly SimEvent[];
  /** Oldest quarter to include. Defaults to everything still in live state. */
  readonly sinceQuarter?: number;
  /** Hard ceiling on items returned, applied after ordering. Defaults to 200. */
  readonly limit?: number;
}

/** Default ceiling: eight quarters of a fifteen-post world plus its coverage. */
export const PUBLIC_RECORD_DEFAULT_LIMIT = 200;

/* -------------------------------------------------------------------------- */
/*  Projection                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Merge everything public into one reverse-chronological list for one seat.
 *
 * Pure: same session, same player, same ledger, same list — including the order,
 * which is quarter descending, then weight descending, then id.
 */
export function projectPublicRecord(session: SessionState, playerId: string, options: PublicRecordOptions = {}): PublicRecordItem[] {
  const audience = audienceFor(session, playerId);
  const since = options.sinceQuarter ?? Number.NEGATIVE_INFINITY;
  const limit = options.limit ?? PUBLIC_RECORD_DEFAULT_LIMIT;
  const ledger = buildLedgerIndex((options.ledger ?? []).filter((row) => isEventVisibleTo(row, session, audience)));
  const lookup = buildLookup(session);
  const folds = planFolds(session, since);

  const items: PublicRecordItem[] = [];

  for (const event of session.activeEvents) {
    if (event.quarter < since) continue;
    if (!worldEventVisibleTo(event, audience)) continue;
    items.push(fromWorldEvent(session, lookup, event, audience, ledger));
  }
  for (const story of session.mediaStories) {
    if (story.quarter < since) continue;
    items.push(fromStory(lookup, story, audience, ledger));
  }
  for (const disclosure of session.disclosures) {
    if (disclosure.quarter < since) continue;
    if (folds.postOf.has(disclosure.id)) continue;
    items.push(fromDisclosure(lookup, disclosure, audience, ledger));
  }
  for (const post of session.socialPosts) {
    if (post.quarter < since) continue;
    items.push(fromPost(lookup, post, folds.disclosureOf.get(post.id) ?? null, audience, ledger));
  }

  return items.sort(comparePublicRecordItems).slice(0, Math.max(0, limit));
}

/* -------------------------------------------------------------------------- */
/*  Editions                                                                   */
/* -------------------------------------------------------------------------- */

/** One past quarter of the record, as a line in an "earlier editions" list. */
export interface EditionSummary {
  readonly quarter: number;
  /** Items this seat may see for that quarter. */
  readonly count: number;
  /** The heaviest item's id and headline — the edition's lead — or null when the quarter was silent. */
  readonly leadId: string | null;
  readonly leadHeadline: string | null;
}

/**
 * Every quarter on the record, newest first, with its item count and lead.
 *
 * The same redaction, ordering and headline rules as `projectPublicRecord`,
 * computed without the consequence line or the ledger — the two expensive parts
 * — so a screen can list the editions without walking the whole history through
 * the full projection. Pure and deterministic for the same reason it is.
 */
export function projectEditionIndex(session: SessionState, playerId: string): EditionSummary[] {
  const audience = audienceFor(session, playerId);
  const lookup = buildLookup(session);
  const folds = planFolds(session, Number.NEGATIVE_INFINITY);
  const byQuarter = new Map<number, { count: number; lead: { id: string; weight: number; headline: string } | null }>();

  const note = (quarter: number, id: string, weight: number, headline: string): void => {
    const bucket = byQuarter.get(quarter) ?? { count: 0, lead: null };
    bucket.count += 1;
    // The same tie-break as `comparePublicRecordItems`: heavier first, then id.
    if (bucket.lead === null || weight > bucket.lead.weight || (weight === bucket.lead.weight && id.localeCompare(bucket.lead.id) < 0)) {
      bucket.lead = { id, weight, headline };
    }
    byQuarter.set(quarter, bucket);
  };

  for (const event of session.activeEvents) {
    if (!worldEventVisibleTo(event, audience)) continue;
    note(event.quarter, event.id, eventWeight(event), clipHeadline(event.title, PUBLIC_RECORD_HEADLINE_MAX));
  }
  for (const story of session.mediaStories) {
    note(story.quarter, story.id, storyWeight(story), clipHeadline(story.headline, PUBLIC_RECORD_HEADLINE_MAX));
  }
  for (const disclosure of session.disclosures) {
    if (folds.postOf.has(disclosure.id)) continue;
    note(disclosure.quarter, disclosure.id, disclosureWeight(disclosure), clipHeadline(disclosure.headline, PUBLIC_RECORD_HEADLINE_MAX));
  }
  for (const post of session.socialPosts) {
    note(post.quarter, post.id, postWeight(post, folds.disclosureOf.get(post.id) ?? null), postHeadline(post));
  }

  return [...byQuarter.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([quarter, bucket]) => ({
      quarter,
      count: bucket.count,
      leadId: bucket.lead?.id ?? null,
      leadHeadline: bucket.lead?.headline ?? null,
    }));
}

/* -------------------------------------------------------------------------- */
/*  Redaction                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Whether a world event reaches this seat.
 *
 * The same rule `EventVisibility` states: public is everyone's, sector reaches
 * companies in the affected sector, private reaches only the companies the event
 * names. An event that names one of your companies always reaches you, whatever
 * its visibility — you are living in it.
 */
export function worldEventVisibleTo(event: WorldEvent, audience: PlayerAudience): boolean {
  if (event.affectedCompanyIds.some((id) => audience.companyIds.has(id))) return true;
  if (event.visibility === 'public') return true;
  if (event.visibility === 'sector') return event.affectedSectorIds.some((id) => audience.sectorIds.has(id));
  return false;
}

/* -------------------------------------------------------------------------- */
/*  Folding                                                                    */
/* -------------------------------------------------------------------------- */

/** Which disclosure each post produced, and which post each such disclosure came from. */
export interface FoldPlan {
  readonly disclosureOf: ReadonlyMap<string, PublicDisclosure>;
  readonly postOf: ReadonlyMap<string, SocialPost>;
}

/**
 * Pair every disclosure the social engine published from a post with that
 * post, so the projection prints the utterance once.
 *
 * `publishDisclosure` stores the post's own text as the body and its author as
 * the source (dropped for a leak), and names the post in the disclosure id. A
 * match therefore needs the same quarter and the same body, and a source that
 * is either absent or the post's author; when two posts of a quarter carry the
 * same words — the engine's templates can — the id decides, and failing that
 * the first post in state order, so the plan is deterministic. A disclosure a
 * company wrote itself (earnings, guidance, a founding) matches nothing and
 * stays its own item.
 */
export function planFolds(session: SessionState, since: number): FoldPlan {
  const disclosureOf = new Map<string, PublicDisclosure>();
  const postOf = new Map<string, SocialPost>();
  const postsByBody = new Map<string, SocialPost[]>();
  for (const post of session.socialPosts) {
    if (post.quarter < since) continue;
    const key = foldKey(post.quarter, post.text.slice(0, 1500));
    const bucket = postsByBody.get(key);
    if (bucket === undefined) postsByBody.set(key, [post]);
    else bucket.push(post);
  }
  for (const disclosure of session.disclosures) {
    if (disclosure.quarter < since) continue;
    const candidates = postsByBody
      .get(foldKey(disclosure.quarter, disclosure.body))
      ?.filter((post) => !disclosureOf.has(post.id) && (disclosure.sourceCharacterId === null || disclosure.sourceCharacterId === post.authorCharacterId));
    if (candidates === undefined || candidates.length === 0) continue;
    const post = candidates.find((candidate) => disclosure.id.endsWith(candidate.id)) ?? candidates[0];
    if (post === undefined) continue;
    disclosureOf.set(post.id, disclosure);
    postOf.set(disclosure.id, post);
  }
  return { disclosureOf, postOf };
}

function foldKey(quarter: number, body: string): string {
  return `${quarter}\u0000${body}`;
}

/* -------------------------------------------------------------------------- */
/*  The ledger, indexed                                                        */
/* -------------------------------------------------------------------------- */

/**
 * The payload keys a row may name its subject under.
 *
 * A row explains an event when its target is the event or its payload names it
 * as the event, origin event or source event; a story, disclosure or post the
 * same way under its own key. These are the only keys ever consulted, so they
 * are the only ones indexed.
 */
export const LEDGER_SUBJECT_KEYS = ['eventId', 'originEventId', 'sourceEventId', 'storyId', 'disclosureId', 'postId'] as const;
export type LedgerSubjectKey = (typeof LEDGER_SUBJECT_KEYS)[number];

interface LedgerHit {
  readonly eventId: string;
  /** How the row named the subject: as its target, or under this payload key. */
  readonly via: 'target' | LedgerSubjectKey;
}

/** Every ledger row that names a subject, keyed by the subject's id, in ledger order. */
export interface LedgerIndex {
  readonly hits: ReadonlyMap<string, readonly LedgerHit[]>;
}

/** Index a ledger once, so attaching citations to an item is a lookup rather than a scan. */
export function buildLedgerIndex(ledger: readonly SimEvent[]): LedgerIndex {
  const hits = new Map<string, LedgerHit[]>();
  const add = (subjectId: string, hit: LedgerHit): void => {
    const bucket = hits.get(subjectId);
    if (bucket === undefined) hits.set(subjectId, [hit]);
    else bucket.push(hit);
  };
  for (const row of ledger) {
    if (row.targetId !== null) add(row.targetId, { eventId: row.eventId, via: 'target' });
    const payload = row.payload;
    for (const key of LEDGER_SUBJECT_KEYS) {
      const value = payload[key];
      if (typeof value === 'string') add(value, { eventId: row.eventId, via: key });
    }
  }
  return { hits };
}

/**
 * The rows behind one subject: those that target it, plus those that name it
 * under any of `payloadKeys`. Ledger order, each row once.
 */
export function ledgerIdsFor(index: LedgerIndex, subjectId: string, payloadKeys: readonly LedgerSubjectKey[]): string[] {
  const hits = index.hits.get(subjectId);
  if (hits === undefined) return [];
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const hit of hits) {
    if (hit.via !== 'target' && !payloadKeys.includes(hit.via)) continue;
    if (seen.has(hit.eventId)) continue;
    seen.add(hit.eventId);
    ids.push(hit.eventId);
  }
  return ids;
}

/* -------------------------------------------------------------------------- */
/*  Lookup                                                                     */
/* -------------------------------------------------------------------------- */

/** The session's tables keyed by id, built once per projection. */
interface Lookup {
  readonly characters: ReadonlyMap<string, Character>;
  readonly companies: ReadonlyMap<string, Company>;
  readonly accounts: ReadonlyMap<string, SocialAccount>;
  readonly modifiersByEvent: ReadonlyMap<string, readonly ActiveModifier[]>;
  /** The quarter open for planning: what "quarters to run" counts down to. */
  readonly quarter: number;
}

function buildLookup(session: SessionState): Lookup {
  const modifiersByEvent = new Map<string, ActiveModifier[]>();
  for (const modifier of session.activeModifiers) {
    if (modifier.originEventId === null) continue;
    const bucket = modifiersByEvent.get(modifier.originEventId);
    if (bucket === undefined) modifiersByEvent.set(modifier.originEventId, [modifier]);
    else bucket.push(modifier);
  }
  return {
    characters: new Map(session.characters.map((character) => [character.id, character])),
    companies: new Map(session.companies.map((company) => [company.id, company])),
    accounts: new Map(session.socialAccounts.map((account) => [account.id, account])),
    modifiersByEvent,
    quarter: session.quarter,
  };
}

function nameOfCharacter(lookup: Lookup, characterId: string | null): string | null {
  if (characterId === null) return null;
  return lookup.characters.get(characterId)?.name ?? null;
}

function nameOfCompany(lookup: Lookup, companyId: string | null): string | null {
  if (companyId === null) return null;
  return lookup.companies.get(companyId)?.name ?? null;
}

function isAiCharacter(lookup: Lookup, characterId: string | null): boolean {
  if (characterId === null) return true;
  const character = lookup.characters.get(characterId);
  return character === undefined ? true : !character.isPlayer;
}

/** The reader-facing sector of the first company an item names, or null. */
function readerSectorOf(lookup: Lookup, companyIds: readonly string[]): Sector | null {
  for (const id of companyIds) {
    const company = lookup.companies.get(id);
    if (company !== undefined) return company.sector;
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/*  Weights                                                                    */
/* -------------------------------------------------------------------------- */

function eventWeight(event: WorldEvent): number {
  return clampUnit(event.severity);
}

function storyWeight(story: MediaStory): number {
  return clampUnit(story.prominence);
}

/**
 * How much of a disclosure's credibility counts as attention, by kind.
 *
 * A set of results or a guidance line is credible without being interesting:
 * every public company files one every quarter, and a paper that leads with
 * eight of them is a stock table. A rumour, a leak or a fund's thesis is an
 * act, and a believed one commands attention; a press release sits between.
 * The factors are set so a routine filing at full credibility (0.9) still
 * ranks below a minor world shock (severity 0.4) and a middling story.
 */
export const DISCLOSURE_ATTENTION: Readonly<Record<DisclosureKind, number>> = {
  earnings: 0.4,
  guidance: 0.4,
  regulatory_filing: 0.6,
  press_release: 0.7,
  analyst_note: 0.9,
  rumour: 0.9,
  leak: 0.9,
};

function disclosureWeight(disclosure: PublicDisclosure): number {
  return clampUnit(disclosure.credibility * DISCLOSURE_ATTENTION[disclosure.kind]);
}

/**
 * Reach is the attention a post commanded; the reference is the same two
 * million the engine balances sentiment against, so weight is comparable with a
 * story's prominence rather than being a raw follower count. A post the market
 * heard as a disclosure takes the heavier of its own weight and the
 * disclosure's, so it sits where the louder of the two would have.
 */
function postWeight(post: SocialPost, heard: PublicDisclosure | null): number {
  const own = clampUnit((post.engagement?.reach ?? 0) / 4_000_000);
  return heard === null ? own : Math.max(own, disclosureWeight(heard));
}

/* -------------------------------------------------------------------------- */
/*  Builders                                                                   */
/* -------------------------------------------------------------------------- */

function fromWorldEvent(session: SessionState, lookup: Lookup, event: WorldEvent, audience: PlayerAudience, ledger: LedgerIndex): PublicRecordItem {
  const carried = lookup.modifiersByEvent.get(event.id) ?? [];
  return {
    id: event.id,
    quarter: event.quarter,
    kind: 'event',
    who: { characterId: null, companyId: null, name: 'The world', isAi: true },
    sectorIds: [...event.affectedSectorIds],
    companyIds: [...event.affectedCompanyIds],
    headline: clipHeadline(event.title, PUBLIC_RECORD_HEADLINE_MAX),
    deck: eventDeck(event, carried.length, lookup.quarter),
    body: event.description,
    kicker: {
      word: EVENT_KICKER[event.type] ?? humanise(event.type),
      sector: readerSectorOf(lookup, event.affectedCompanyIds),
      company: nameOfCompany(lookup, event.affectedCompanyIds[0] ?? null),
    },
    // A world event's tone is its severity: nothing the engine draws is good news
    // by construction, and the copy that makes it good news is the story about it.
    tone: clampUnitSigned(-event.severity * 0.8),
    weight: eventWeight(event),
    links: { causalParentId: event.causalParentId, sourceEventId: null, sourcePostIds: [], replyToPostId: null },
    ledgerEventIds: ledgerIdsFor(ledger, event.id, ['eventId', 'originEventId', 'sourceEventId']),
    whyItMatters: eventConsequence(carried, audience),
    network: null,
    intent: null,
    reach: null,
    pressPickup: null,
    heard: null,
  };
}

function fromStory(lookup: Lookup, story: MediaStory, audience: PlayerAudience, ledger: LedgerIndex): PublicRecordItem {
  const authorName = nameOfCharacter(lookup, story.authorCharacterId);
  return {
    id: story.id,
    quarter: story.quarter,
    kind: 'story',
    who: {
      characterId: story.authorCharacterId,
      companyId: null,
      name: authorName ?? 'The wire',
      isAi: isAiCharacter(lookup, story.authorCharacterId),
    },
    sectorIds: sectorsOf(lookup, story.subjectCompanyIds),
    companyIds: [...story.subjectCompanyIds],
    headline: clipHeadline(story.headline, PUBLIC_RECORD_HEADLINE_MAX),
    deck: storyDeck(story),
    body: story.body,
    kicker: {
      word: STORY_KICKER[story.angle],
      sector: readerSectorOf(lookup, story.subjectCompanyIds),
      company: nameOfCompany(lookup, story.subjectCompanyIds[0] ?? null),
    },
    tone: clampUnitSigned(story.sentiment),
    weight: storyWeight(story),
    links: { causalParentId: null, sourceEventId: story.sourceEventId, sourcePostIds: [...story.sourcePostIds], replyToPostId: null },
    ledgerEventIds: ledgerIdsFor(ledger, story.id, ['storyId']),
    whyItMatters: storyConsequence(story, audience),
    network: null,
    intent: null,
    reach: story.reach,
    pressPickup: null,
    heard: null,
  };
}

/**
 * The kinds a company publishes in its own name. With no source character on
 * the row, the company is the speaker; for any other kind an unnamed source is
 * exactly that, and the company is only the subject.
 */
const SELF_PUBLISHED: ReadonlySet<DisclosureKind> = new Set<DisclosureKind>(['earnings', 'guidance', 'press_release', 'regulatory_filing']);

function fromDisclosure(lookup: Lookup, disclosure: PublicDisclosure, audience: PlayerAudience, ledger: LedgerIndex): PublicRecordItem {
  const companyName = nameOfCompany(lookup, disclosure.companyId);
  const source = disclosure.sourceCharacterId === null ? null : (lookup.characters.get(disclosure.sourceCharacterId) ?? null);
  const selfPublished = source === null && SELF_PUBLISHED.has(disclosure.kind);
  // The speaker's affiliation — the source's own company, never the subject's.
  // A CEO's earnings line resolves to the same company either way; a rival's
  // rumour about you resolves to the rival.
  const speakerCompanyId = source !== null ? (source.companyId ?? (SELF_PUBLISHED.has(disclosure.kind) ? disclosure.companyId : null)) : selfPublished ? disclosure.companyId : null;
  const companyIds = disclosure.companyId === null ? [] : [disclosure.companyId];
  return {
    id: disclosure.id,
    quarter: disclosure.quarter,
    kind: 'disclosure',
    who: {
      characterId: disclosure.sourceCharacterId,
      companyId: speakerCompanyId,
      // An anonymous source is exactly that: the feed never resolves it, because
      // the engine deliberately dropped the attribution when the leak was made.
      // A company's own filing with no named officer is the company speaking.
      name: source?.name ?? (selfPublished ? companyName : null) ?? 'An unattributed source',
      isAi: isAiCharacter(lookup, disclosure.sourceCharacterId),
    },
    sectorIds: sectorsOf(lookup, companyIds),
    companyIds,
    headline: clipHeadline(disclosure.headline, PUBLIC_RECORD_HEADLINE_MAX),
    deck: disclosureDeck(disclosure, companyName, source?.name ?? null, speakerCompanyId === disclosure.companyId),
    body: disclosure.body,
    kicker: {
      word: DISCLOSURE_KICKER[disclosure.kind],
      sector: readerSectorOf(lookup, companyIds),
      company: companyName,
    },
    tone: disclosure.kind === 'press_release' ? 0.2 : -0.3,
    weight: disclosureWeight(disclosure),
    links: { causalParentId: null, sourceEventId: null, sourcePostIds: [], replyToPostId: null },
    ledgerEventIds: ledgerIdsFor(ledger, disclosure.id, ['disclosureId']),
    whyItMatters: disclosureConsequence(lookup, disclosure, audience),
    network: null,
    intent: null,
    reach: typeof disclosure.metrics.reach === 'number' ? disclosure.metrics.reach : null,
    pressPickup: null,
    heard: null,
  };
}

function fromPost(lookup: Lookup, post: SocialPost, heard: PublicDisclosure | null, audience: PlayerAudience, ledger: LedgerIndex): PublicRecordItem {
  const author = lookup.characters.get(post.authorCharacterId) ?? null;
  const account = lookup.accounts.get(post.accountId) ?? null;
  const authorCompanyId = author?.companyId ?? account?.ownerCompanyId ?? null;
  const companyIds = [authorCompanyId, post.targetCompanyId].filter((id): id is string => id !== null);

  return {
    id: post.id,
    quarter: post.quarter,
    kind: post.replyToPostId === null ? 'post' : 'reply',
    who: {
      characterId: post.authorCharacterId,
      companyId: authorCompanyId,
      name: author?.name ?? account?.handle ?? 'An account',
      isAi: post.isAiGenerated,
    },
    sectorIds: sectorsOf(lookup, companyIds),
    companyIds,
    headline: postHeadline(post),
    // A post is its own deck: the body is the whole of it.
    deck: null,
    body: post.text,
    kicker: {
      word: post.replyToPostId === null ? POST_KICKER[post.intent] : 'Reply',
      sector: readerSectorOf(lookup, companyIds),
      company: nameOfCompany(lookup, authorCompanyId),
    },
    tone: TONE_BY_INTENT[post.intent],
    weight: postWeight(post, heard),
    links: { causalParentId: null, sourceEventId: null, sourcePostIds: [], replyToPostId: post.replyToPostId },
    // The folded disclosure's rows are cited beside the post's own, each once.
    ledgerEventIds: heard === null ? ledgerIdsFor(ledger, post.id, ['postId']) : union(ledgerIdsFor(ledger, post.id, ['postId']), ledgerIdsFor(ledger, heard.id, ['disclosureId'])),
    whyItMatters: postConsequence(post, authorCompanyId, audience) ?? (heard === null ? null : disclosureConsequence(lookup, heard, audience)),
    network: post.network,
    intent: post.intent,
    reach: post.engagement?.reach ?? null,
    pressPickup: post.engagement?.pressPickup ?? false,
    heard: heard === null ? null : { kind: heard.kind, credibility: clampUnit(heard.credibility) },
  };
}

/** Both lists in order, the second's new ids after the first's. */
function union(first: readonly string[], second: readonly string[]): string[] {
  const out = [...first];
  for (const id of second) if (!out.includes(id)) out.push(id);
  return out;
}

const TONE_BY_INTENT: Record<PostIntent, number> = {
  announce: 0.3,
  hype: 0.4,
  defend: 0,
  recruit: 0.2,
  attack: -0.6,
  apologise: -0.2,
  leak: -0.5,
};

/* -------------------------------------------------------------------------- */
/*  Headlines                                                                  */
/* -------------------------------------------------------------------------- */

function postHeadline(post: SocialPost): string {
  return clipHeadline(headlineFromText(post.text), PUBLIC_RECORD_HEADLINE_MAX);
}

/* -------------------------------------------------------------------------- */
/*  Kickers                                                                    */
/* -------------------------------------------------------------------------- */

/** The kind word for a disclosure: what a paper prints above a filing. */
export const DISCLOSURE_KICKER: Readonly<Record<DisclosureKind, string>> = {
  guidance: 'Guidance',
  earnings: 'Earnings',
  leak: 'Leak',
  rumour: 'Rumour',
  press_release: 'Press release',
  regulatory_filing: 'Filing',
  analyst_note: 'Analyst note',
};

/** The kind word for a story: its angle, as a section word. */
export const STORY_KICKER: Readonly<Record<StoryAngle, string>> = {
  breakthrough: 'Breakthrough',
  scandal: 'Scandal',
  financial_analysis: 'Analysis',
  human_interest: 'Feature',
  regulatory: 'Regulation',
  competitive: 'Competition',
  safety_concern: 'Safety',
  labour: 'Labour',
  geopolitical: 'Geopolitics',
  profile: 'Profile',
};

/** The kind word for a post: what it set out to do. */
export const POST_KICKER: Readonly<Record<PostIntent, string>> = {
  announce: 'Announcement',
  hype: 'Promotion',
  defend: 'Rebuttal',
  recruit: 'Hiring',
  attack: 'Broadside',
  apologise: 'Apology',
  leak: 'Leak',
};

/** The kind word for a world event: its type, in a newspaper's words. */
export const EVENT_KICKER: Readonly<Record<WorldEventType, string>> = {
  compute_supply_shock: 'Compute',
  compute_demand_shock: 'Compute',
  energy_price_shock: 'Energy',
  grid_constraint: 'Energy',
  fab_disruption: 'Semiconductors',
  macro_shift: 'Economy',
  credit_event: 'Credit',
  capital_market_shift: 'Capital markets',
  fund_collapse: 'Capital markets',
  ipo_window_change: 'Capital markets',
  regulatory_action: 'Regulation',
  export_control: 'Export control',
  antitrust_investigation: 'Antitrust',
  copyright_ruling: 'Courts',
  safety_incident: 'Safety',
  model_breakthrough: 'Breakthrough',
  open_source_release: 'Open source',
  benchmark_result: 'Benchmarks',
  research_disappointment: 'Research',
  talent_shock: 'Talent',
  labour_action: 'Labour',
  immigration_change: 'Immigration',
  data_licensing_shift: 'Data',
  privacy_enforcement: 'Privacy',
  procurement_programme: 'Procurement',
  grant_programme: 'Grants',
  defence_mobilisation: 'Defence',
  geopolitical_escalation: 'Geopolitics',
  sanctions_change: 'Sanctions',
  trade_dispute: 'Trade',
  cyber_incident: 'Cyber',
  infrastructure_outage: 'Outage',
  supply_chain_disruption: 'Supply chain',
  media_cycle: 'Media',
  public_backlash: 'Backlash',
  litigation: 'Courts',
  standards_change: 'Standards',
  corporate_scandal: 'Scandal',
  consolidation_wave: 'Consolidation',
  other: 'World',
};

/* -------------------------------------------------------------------------- */
/*  Decks                                                                      */
/* -------------------------------------------------------------------------- */

/** "A footnote", "Reshapes the quarter", "Reshapes the session": the schema's own words for severity. */
export function severityLabel(severity: number): string {
  if (!Number.isFinite(severity) || severity < 0.2) return 'A footnote';
  if (severity < 0.4) return 'A minor shock';
  if (severity < 0.6) return 'Reshapes the quarter';
  if (severity < 0.8) return 'A major shock';
  return 'Reshapes the session';
}

/** How many quarters an event still has to run, counted from the quarter open for planning. */
export function quartersToRun(event: Pick<WorldEvent, 'quarter' | 'durationQuarters'>, currentQuarter: number): number {
  return Math.max(0, event.quarter + event.durationQuarters - currentQuarter);
}

function eventDeck(event: WorldEvent, modifierCount: number, currentQuarter: number): string {
  const remaining = quartersToRun(event, currentQuarter);
  const run = remaining === 0 ? 'in its last quarter' : `${remaining} quarter${remaining === 1 ? '' : 's'} to run`;
  const carries = modifierCount === 0 ? 'carries no modifiers' : `carries ${modifierCount} modifier${modifierCount === 1 ? '' : 's'}`;
  return clipDeck(`${severityLabel(event.severity)} · ${run} · ${carries}`);
}

function storyDeck(story: MediaStory): string {
  const tone = story.sentiment >= 0.15 ? 'Favourable' : story.sentiment <= -0.15 ? 'Hostile' : 'Neutral';
  return clipDeck(`${tone} coverage the market believes at ${formatPct(story.credibility)}, read by ${peopleLabel(story.reach)}`);
}

function disclosureDeck(disclosure: PublicDisclosure, companyName: string | null, sourceName: string | null, sourceSpeaksForCompany: boolean): string {
  const believed = `believed at ${formatPct(disclosure.credibility)}`;
  const seedCapital = disclosure.metrics['seedCapital'];
  if (typeof seedCapital === 'number') return clipDeck(`Founded on ${formatMoney(seedCapital)}; ${believed}`);
  const overvaluation = disclosure.metrics['overvaluationPct'];
  if (typeof overvaluation === 'number') return clipDeck(`A short thesis: ${Math.round(overvaluation)}% overvalued, ${believed}`);
  const stakePct = disclosure.metrics['stakePct'];
  if (typeof stakePct === 'number') return clipDeck(`An activist holding ${Math.round(stakePct)}% goes public with its demands, ${believed}`);

  // A set of results is written from its figures. The kicker, the headline and
  // the byline already name the company; the deck says what the numbers were.
  const figures = earningsFigures(disclosure);
  if (figures !== null) return clipDeck(`${figures}; ${believed}`);

  // Who said it, and about whom. "From X for Y" when X speaks for Y; "about Y
  // from X" when X works elsewhere — a rival's rumour is not the subject's line.
  const from =
    companyName !== null && sourceName !== null
      ? sourceSpeaksForCompany
        ? `from ${sourceName} for ${companyName}`
        : `about ${companyName} from ${sourceName}`
      : `from ${companyName ?? sourceName ?? 'an unattributed source'}`;
  return clipDeck(`${DISCLOSURE_PHRASE[disclosure.kind]} ${from}, ${believed}`);
}

/**
 * "69.9% gross margin · $650M operating income · $7B cash": the figures an
 * earnings row carries, or null when the row has none of them.
 */
function earningsFigures(disclosure: PublicDisclosure): string | null {
  if (disclosure.kind !== 'earnings') return null;
  const parts: string[] = [];
  const grossMargin = disclosure.metrics['grossMargin'];
  if (typeof grossMargin === 'number') parts.push(`${formatPct(grossMargin)} gross margin`);
  const operatingIncome = disclosure.metrics['operatingIncome'];
  if (typeof operatingIncome === 'number') parts.push(`${formatMoney(Math.abs(operatingIncome))} operating ${operatingIncome >= 0 ? 'income' : 'loss'}`);
  const cash = disclosure.metrics['cash'];
  if (typeof cash === 'number') parts.push(`${formatMoney(cash)} cash`);
  return parts.length === 0 ? null : parts.join(' · ');
}

/** The deck's opening phrase for each kind of disclosure: the article a sentence needs, or none. */
const DISCLOSURE_PHRASE: Readonly<Record<DisclosureKind, string>> = {
  guidance: 'Guidance',
  earnings: 'Earnings',
  leak: 'A leak',
  rumour: 'A rumour',
  press_release: 'A press release',
  regulatory_filing: 'A filing',
  analyst_note: 'An analyst note',
};

/** "4M", "18k", "740": people, in whole units. */
export function peopleLabel(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '0';
  if (value >= 1_000_000) return `${Math.round(value / 1_000_000)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return String(Math.round(value));
}

function clipDeck(text: string): string {
  return clipHeadline(text, PUBLIC_RECORD_DECK_MAX);
}

/* -------------------------------------------------------------------------- */
/*  Consequence                                                                */
/* -------------------------------------------------------------------------- */

/**
 * What a world event did to this seat, in one whole-number line.
 *
 * Read off the modifiers the event actually carries, in the order that matters
 * to a reader: something aimed at one of their companies first, then something
 * aimed at a sector they compete in, then the world at large. Null when the
 * event moved nothing they can feel.
 */
function eventConsequence(carried: readonly ActiveModifier[], audience: PlayerAudience): string | null {
  if (carried.length === 0) return null;

  const ranked = [...carried].sort((a, b) => modifierRank(a, audience) - modifierRank(b, audience) || a.id.localeCompare(b.id));
  const first = ranked[0];
  if (first === undefined) return null;
  const rank = modifierRank(first, audience);
  if (rank > 2) return null;

  const label = modifierLabel(first.target, rank);
  const move = modifierMove(first);
  if (move === null) return null;
  return clip(`${label} ${move} this quarter`, 160);
}

/** 0 = about one of your companies, 1 = about a sector you are in, 2 = the world, 3 = somebody else. */
function modifierRank(modifier: ActiveModifier, audience: PlayerAudience): number {
  const parts = modifier.target.split('.');
  if (parts[0] === 'company') return parts[1] !== undefined && audience.companyIds.has(parts[1]) ? 0 : 3;
  if (parts[0] === 'sector') return parts[1] !== undefined && audience.sectorIds.has(parts[1]) ? 1 : 3;
  return 2;
}

/** "your demand", "your sector's demand", "compute spot price". */
function modifierLabel(target: string, rank: number): string {
  const leaf = target.split('.').pop() ?? target;
  const words = leaf
    .replace(/^reputation/, 'reputation ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .trim()
    // "aiTrust" de-camels to "ai trust", and "Ai trust" is not a word anybody
    // in this world writes.
    .replace(/\bai\b/g, 'AI');
  if (rank === 0) return `your ${words}`;
  if (rank === 1) return `your sector's ${words}`;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** A modifier's effect this quarter, in whole numbers: "-6%", "+12pp", "set to 3". */
function modifierMove(modifier: ActiveModifier): string | null {
  const value = modifier.effectiveValue;
  if (!Number.isFinite(value)) return null;
  if (modifier.operation === 'multiply') {
    const move = value - 1;
    if (Math.abs(move) < 0.005) return null;
    return formatDelta(move, 'percent');
  }
  if (modifier.operation === 'add') {
    if (Math.abs(value) < 0.005) return null;
    return Math.abs(value) <= 1 ? formatDelta(value, 'points') : formatDelta(value, 'number');
  }
  return `set to ${formatDelta(value, 'number').replace(/^\+/, '')}`;
}

/** Coverage about you is worth a line; coverage about somebody else is not. */
function storyConsequence(story: MediaStory, audience: PlayerAudience): string | null {
  if (!story.subjectCompanyIds.some((id) => audience.companyIds.has(id))) return null;
  const tone = story.sentiment >= 0.15 ? 'favourable' : story.sentiment <= -0.15 ? 'hostile' : 'neutral';
  return clip(`about you: ${tone} coverage, ${formatPct(story.credibility)} believed`, 160);
}

/** A disclosure about you moves what the market believes, which moves the price. */
function disclosureConsequence(lookup: Lookup, disclosure: PublicDisclosure, audience: PlayerAudience): string | null {
  if (disclosure.companyId === null) return null;

  // A founding is the one disclosure about somebody else that can matter to this
  // seat, and only when the newcomer is actually next door: same sector, same
  // region. A new company on the other side of the world is not your problem, so
  // the line is null rather than a nudge that means nothing.
  const seedCapital = disclosure.metrics['seedCapital'];
  if (typeof seedCapital === 'number') {
    const entrant = lookup.companies.get(disclosure.companyId) ?? null;
    if (entrant === null) return null;
    const nextDoor = [...audience.companyIds].some((id) => {
      const own = lookup.companies.get(id);
      return own !== undefined && own.sector === entrant.sector && own.region === entrant.region;
    });
    return nextDoor
      ? clip(`a new ${entrant.sector.replace(/_/g, ' ')} rival in your region, founded on ${formatMoney(seedCapital)}`, 160)
      : null;
  }

  if (!audience.companyIds.has(disclosure.companyId)) return null;

  // A capital entity's disclosure is an act, not a report, so it gets a line
  // that names the act rather than the format. Read off the metrics the engine
  // put on the row — never recomputed here, and never rounded differently from
  // the card the same numbers render on.
  const overvaluation = disclosure.metrics['overvaluationPct'];
  if (typeof overvaluation === 'number') {
    return clip(`a fund is short you and says so: it argues you are ${Math.round(overvaluation)}% overvalued, at ${formatPct(disclosure.credibility)} credibility`, 160);
  }
  const stakePct = disclosure.metrics['stakePct'];
  if (typeof stakePct === 'number') {
    return clip(`an activist holding ${Math.round(stakePct)}% of you has gone public with its demands`, 160);
  }

  const kind = disclosure.kind.replace(/_/g, ' ');
  return clip(`about you: ${kind} the market gives ${formatPct(disclosure.credibility)} credibility`, 160);
}

/**
 * What a post did to this seat.
 *
 * Two cases matter and neither is an opinion: a post aimed at one of your
 * companies created hostility in your leadership, and your own company's post
 * moved one of your reputations. Everything else is somebody else's quarter.
 */
function postConsequence(post: SocialPost, authorCompanyId: string | null, audience: PlayerAudience): string | null {
  const engagement = post.engagement;
  if (engagement === null) return null;

  if (post.targetCompanyId !== null && audience.companyIds.has(post.targetCompanyId) && engagement.competitorHostilityDelta !== 0) {
    return clip(`aimed at you: hostility ${formatDelta(engagement.competitorHostilityDelta, 'number')}`, 160);
  }

  if (authorCompanyId !== null && audience.companyIds.has(authorCompanyId)) {
    const biggest = [...engagement.sentimentShifts].sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || a.audience.localeCompare(b.audience))[0];
    if (biggest === undefined || Math.abs(biggest.delta) < 0.5) return null;
    return clip(`your ${biggest.audience} sentiment ${formatDelta(biggest.delta, 'number')}`, 160);
  }

  return null;
}

/* -------------------------------------------------------------------------- */
/*  Local helpers                                                              */
/* -------------------------------------------------------------------------- */

function sectorsOf(lookup: Lookup, companyIds: readonly string[]): string[] {
  const sectors: string[] = [];
  for (const id of companyIds) {
    const company = lookup.companies.get(id);
    if (company === undefined) continue;
    if (!sectors.includes(company.sectorId)) sectors.push(company.sectorId);
  }
  return sectors;
}

function humanise(value: string): string {
  const spaced = value.replace(/_/g, ' ').trim();
  return spaced.length === 0 ? value : `${spaced.charAt(0).toUpperCase()}${spaced.slice(1)}`;
}

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function clampUnitSigned(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(-1, value));
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
