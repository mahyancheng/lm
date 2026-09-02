/**
 * @frontier/simulation — resolver/publicRecord.ts
 *
 * One feed, projected to one seat.
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
 *   reach, never as a claim about what it will do next.
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
  MediaStory,
  PublicDisclosure,
  PublicRecordItem,
  SessionState,
  SimEvent,
  SocialPost,
  WorldEvent,
} from '@frontier/contracts';
import { comparePublicRecordItems } from '@frontier/contracts';
import { formatDelta, formatPct } from '@frontier/shared';
import { audienceFor, isEventVisibleTo, type PlayerAudience } from './projection';

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
  const ledger = (options.ledger ?? []).filter((row) => isEventVisibleTo(row, session, audience));

  const items: PublicRecordItem[] = [];

  for (const event of session.activeEvents) {
    if (event.quarter < since) continue;
    if (!worldEventVisibleTo(event, audience)) continue;
    items.push(fromWorldEvent(session, event, audience, ledger));
  }
  for (const story of session.mediaStories) {
    if (story.quarter < since) continue;
    items.push(fromStory(session, story, audience, ledger));
  }
  for (const disclosure of session.disclosures) {
    if (disclosure.quarter < since) continue;
    items.push(fromDisclosure(session, disclosure, audience, ledger));
  }
  for (const post of session.socialPosts) {
    if (post.quarter < since) continue;
    items.push(fromPost(session, post, audience, ledger));
  }

  return items.sort(comparePublicRecordItems).slice(0, Math.max(0, limit));
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
/*  Builders                                                                   */
/* -------------------------------------------------------------------------- */

function ledgerFor(ledger: readonly SimEvent[], subjectId: string, payloadKeys: readonly string[]): string[] {
  const ids: string[] = [];
  for (const row of ledger) {
    const payload = row.payload;
    const matched =
      row.targetId === subjectId ||
      payloadKeys.some((key) => typeof payload[key] === 'string' && payload[key] === subjectId);
    if (matched) ids.push(row.eventId);
  }
  return ids;
}

function nameOfCharacter(session: SessionState, characterId: string | null): string | null {
  if (characterId === null) return null;
  return session.characters.find((character) => character.id === characterId)?.name ?? null;
}

function nameOfCompany(session: SessionState, companyId: string | null): string | null {
  if (companyId === null) return null;
  return session.companies.find((company) => company.id === companyId)?.name ?? null;
}

function isAiCharacter(session: SessionState, characterId: string | null): boolean {
  if (characterId === null) return true;
  const character = session.characters.find((entry) => entry.id === characterId);
  return character === undefined ? true : !character.isPlayer;
}

function fromWorldEvent(session: SessionState, event: WorldEvent, audience: PlayerAudience, ledger: readonly SimEvent[]): PublicRecordItem {
  return {
    id: event.id,
    quarter: event.quarter,
    kind: 'event',
    who: { characterId: null, companyId: null, name: 'The world', isAi: true },
    sectorIds: [...event.affectedSectorIds],
    companyIds: [...event.affectedCompanyIds],
    headline: clip(event.title, 200),
    body: clip(event.description, 1500),
    // A world event's tone is its severity: nothing the engine draws is good news
    // by construction, and the copy that makes it good news is the story about it.
    tone: clampUnitSigned(-event.severity * 0.8),
    weight: clampUnit(event.severity),
    links: { causalParentId: event.causalParentId, sourceEventId: null, sourcePostIds: [], replyToPostId: null },
    ledgerEventIds: ledgerFor(ledger, event.id, ['eventId', 'originEventId', 'sourceEventId']),
    whyItMatters: eventConsequence(session, event, audience),
    network: null,
    intent: null,
    reach: null,
  };
}

function fromStory(session: SessionState, story: MediaStory, audience: PlayerAudience, ledger: readonly SimEvent[]): PublicRecordItem {
  const authorName = nameOfCharacter(session, story.authorCharacterId);
  return {
    id: story.id,
    quarter: story.quarter,
    kind: 'story',
    who: {
      characterId: story.authorCharacterId,
      companyId: null,
      name: authorName ?? 'The wire',
      isAi: isAiCharacter(session, story.authorCharacterId),
    },
    sectorIds: sectorsOf(session, story.subjectCompanyIds),
    companyIds: [...story.subjectCompanyIds],
    headline: clip(story.headline, 200),
    body: clip(story.body, 1500),
    tone: clampUnitSigned(story.sentiment),
    weight: clampUnit(story.prominence),
    links: { causalParentId: null, sourceEventId: story.sourceEventId, sourcePostIds: [...story.sourcePostIds], replyToPostId: null },
    ledgerEventIds: ledgerFor(ledger, story.id, ['storyId']),
    whyItMatters: storyConsequence(story, audience),
    network: null,
    intent: null,
    reach: story.reach,
  };
}

function fromDisclosure(session: SessionState, disclosure: PublicDisclosure, audience: PlayerAudience, ledger: readonly SimEvent[]): PublicRecordItem {
  const companyName = nameOfCompany(session, disclosure.companyId);
  const sourceName = nameOfCharacter(session, disclosure.sourceCharacterId);
  return {
    id: disclosure.id,
    quarter: disclosure.quarter,
    kind: 'disclosure',
    who: {
      characterId: disclosure.sourceCharacterId,
      companyId: disclosure.companyId,
      // An anonymous source is exactly that: the feed never resolves it, because
      // the engine deliberately dropped the attribution when the leak was made.
      name: sourceName ?? companyName ?? 'An unattributed source',
      isAi: isAiCharacter(session, disclosure.sourceCharacterId),
    },
    sectorIds: sectorsOf(session, disclosure.companyId === null ? [] : [disclosure.companyId]),
    companyIds: disclosure.companyId === null ? [] : [disclosure.companyId],
    headline: clip(disclosure.headline, 200),
    body: clip(disclosure.body, 1500),
    tone: disclosure.kind === 'press_release' ? 0.2 : -0.3,
    // A believed rumour commands more attention than a believed press release,
    // and neither should outrank the quarter's biggest story by default: a
    // routine set of results is credible without being interesting.
    weight: clampUnit(disclosure.credibility * (disclosure.kind === 'press_release' ? 0.7 : 0.9)),
    links: { causalParentId: null, sourceEventId: null, sourcePostIds: [], replyToPostId: null },
    ledgerEventIds: ledgerFor(ledger, disclosure.id, ['disclosureId']),
    whyItMatters: disclosureConsequence(disclosure, audience),
    network: null,
    intent: null,
    reach: typeof disclosure.metrics.reach === 'number' ? disclosure.metrics.reach : null,
  };
}

function fromPost(session: SessionState, post: SocialPost, audience: PlayerAudience, ledger: readonly SimEvent[]): PublicRecordItem {
  const author = session.characters.find((character) => character.id === post.authorCharacterId) ?? null;
  const account = session.socialAccounts.find((entry) => entry.id === post.accountId) ?? null;
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
    sectorIds: sectorsOf(session, companyIds),
    companyIds,
    headline: clip(headlineForPost(post, author?.name ?? account?.handle ?? 'An account'), 200),
    body: clip(post.text, 1500),
    tone: TONE_BY_INTENT[post.intent],
    // Reach is the attention a post commanded; the reference is the same two
    // million the engine balances sentiment against, so weight is comparable
    // with a story's prominence rather than being a raw follower count.
    weight: clampUnit((post.engagement?.reach ?? 0) / 4_000_000),
    links: { causalParentId: null, sourceEventId: null, sourcePostIds: [], replyToPostId: post.replyToPostId },
    ledgerEventIds: ledgerFor(ledger, post.id, ['postId']),
    whyItMatters: postConsequence(post, authorCompanyId, audience),
    network: post.network,
    intent: post.intent,
    reach: post.engagement?.reach ?? null,
  };
}

const TONE_BY_INTENT: Record<SocialPost['intent'], number> = {
  announce: 0.3,
  hype: 0.4,
  defend: 0,
  recruit: 0.2,
  attack: -0.6,
  apologise: -0.2,
  leak: -0.5,
};

function headlineForPost(post: SocialPost, authorName: string): string {
  const verb =
    post.replyToPostId !== null
      ? 'replied'
      : post.intent === 'attack'
        ? 'went after a rival'
        : post.intent === 'apologise'
          ? 'apologised'
          : post.intent === 'leak'
            ? 'passed something on'
            : post.intent === 'recruit'
              ? 'is hiring'
              : post.intent === 'defend'
                ? 'answered back'
                : 'posted';
  return `${authorName} ${verb} on ${post.network.replace(/_/g, ' ')}`;
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
function eventConsequence(session: SessionState, event: WorldEvent, audience: PlayerAudience): string | null {
  const carried = session.activeModifiers.filter((modifier) => modifier.originEventId === event.id);
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
function disclosureConsequence(disclosure: PublicDisclosure, audience: PlayerAudience): string | null {
  if (disclosure.companyId === null || !audience.companyIds.has(disclosure.companyId)) return null;

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

function sectorsOf(session: SessionState, companyIds: readonly string[]): string[] {
  const sectors: string[] = [];
  for (const id of companyIds) {
    const company = session.companies.find((entry) => entry.id === id);
    if (company === undefined) continue;
    if (!sectors.includes(company.sectorId)) sectors.push(company.sectorId);
  }
  return sectors;
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
