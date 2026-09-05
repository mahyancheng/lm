/**
 * @frontier/simulation — the public record, written like a newspaper.
 *
 * What is under test is the *writing* of the projection, not its redaction
 * (which `socialFeed.test.ts` covers): every item carries a real headline, a
 * deck of engine figures or none, the body in full and a kicker that says what
 * kind of thing it is. The ledger is attached through an index that must agree,
 * row for row, with the scan it replaced. Everything here is deterministic
 * because the projection is, and a fixture parses through the contract so a
 * test can never drift from what the engine actually emits.
 */

import { describe, expect, it } from 'vitest';
import type { MediaStory, PublicDisclosure, PublicRecordItem, SessionState, SimEvent, SocialPostDraft, WorldEvent } from '@frontier/contracts';
import { PUBLIC_RECORD_DECK_MAX, PUBLIC_RECORD_HEADLINE_MAX, PublicRecordItemSchema } from '@frontier/contracts';
import { createDefaultEngine } from '../src/engine';
import { createWorld2Session } from '../src/scenario/world2/index';
import { propagatePosts } from '../src/social/index';
import {
  DISCLOSURE_ATTENTION,
  DISCLOSURE_KICKER,
  buildLedgerIndex,
  clipHeadline,
  headlineFromText,
  ledgerIdsFor,
  peopleLabel,
  planFolds,
  projectEditionIndex,
  projectPublicRecord,
  quartersToRun,
  severityLabel,
} from '../src/resolver/publicRecord';
import { makeAction, makeContext, makeState } from './_institutionsHarness';

/* -------------------------------------------------------------------------- */
/*  Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

const PLAYER_ID = 'ply_01';

function liveState(): SessionState {
  const state = makeState();
  state.config = { ...state.config, worldVersion: 2 };
  return state;
}

const LONG_DESCRIPTION = (
  'The federation extended export controls to the current generation of training accelerators, with immediate effect for allied resale. ' +
  'Distributors were given thirty days to unwind existing orders and every shipment above a threshold now requires an individual licence. ' +
  'Three of the largest buyers said they would seek exemptions; none had been granted by the time the rule took effect. '
).repeat(3);

const EXPORT_CONTROL: WorldEvent = {
  id: 'wev_export_control',
  familyId: 'fam_export_control',
  type: 'export_control',
  titleKey: 'accelerator_export_restriction',
  title: 'Advanced accelerator exports restricted',
  description: LONG_DESCRIPTION.slice(0, 1190),
  severity: 0.72,
  visibility: 'public',
  durationQuarters: 4,
  causalParentId: null,
  quarter: 1,
  affectedSectorIds: ['semiconductors', 'frontier_ai'],
  affectedCompanyIds: ['cmp_aurora'],
};

const STORY: MediaStory = {
  id: 'sty_orbit_scrutiny',
  quarter: 1,
  headline: 'Orbit under scrutiny after enterprise deployment withdrawn without notice',
  body: 'Three enterprise customers received unsafe outputs before the deployment was pulled. Orbit has yet to say when it knew.',
  angle: 'safety_concern',
  prominence: 0.66,
  subjectCompanyIds: ['cmp_orbit'],
  subjectCharacterIds: [],
  sourcePostIds: [],
  sourceEventId: null,
  credibility: 0.62,
  sentiment: -0.4,
  reach: 4_200_000,
  authorCharacterId: null,
};

function disclosure(kind: PublicDisclosure['kind'], id: string): PublicDisclosure {
  return {
    id,
    companyId: 'cmp_orbit',
    quarter: 1,
    kind,
    headline: 'Orbit Dynamics guides to a wider loss as it re-platforms its agent stack',
    body: 'The company now expects a full-year operating loss roughly twice the consensus figure, citing a re-platforming it says will finish within two quarters.',
    metrics: { guidedRevenue: 2_800_000_000 },
    credibility: 0.71,
    sourceCharacterId: null,
    isTruthful: true,
    beliefTopic: null,
  };
}

const ATTACK_ON_ORBIT: SocialPostDraft = {
  authorCharacterId: 'chr_maya_chen',
  network: 'fast_feed',
  text: 'Orbit sells deployment speed because it has nothing else to sell. Ask them what their model actually scores.',
  intent: 'attack',
  targetCompanyId: 'cmp_orbit',
};

function postAction(draft: SocialPostDraft, sequence = 0) {
  return makeAction({ type: 'social_post', draft }, {
    sequence,
    actorCompanyId: 'cmp_nexus',
    actorCharacterId: draft.authorCharacterId,
    actionId: `act_post_${sequence}`,
  });
}

function recorded(): SessionState {
  const state = liveState();
  state.activeEvents = [EXPORT_CONTROL];
  state.mediaStories = [...state.mediaStories, STORY];
  state.disclosures = [
    ...state.disclosures,
    disclosure('press_release', 'dsc_release'),
    disclosure('rumour', 'dsc_rumour'),
    disclosure('leak', 'dsc_leak'),
    disclosure('regulatory_filing', 'dsc_filing'),
    disclosure('earnings', 'dsc_earnings'),
  ];
  state.pendingActions = [postAction(ATTACK_ON_ORBIT)];
  propagatePosts(state, makeContext(1).ctx);
  return state;
}

function byId(items: readonly PublicRecordItem[], id: string): PublicRecordItem {
  const item = items.find((entry) => entry.id === id);
  if (item === undefined) throw new Error(`missing ${id}`);
  return item;
}

/* -------------------------------------------------------------------------- */
/*  Headlines                                                                  */
/* -------------------------------------------------------------------------- */

describe('a post headline is the post\'s own words', () => {
  it('takes the first sentence and drops its full stop', () => {
    expect(headlineFromText('Orbit sells deployment speed because it has nothing else to sell. Ask them what their model scores.')).toBe(
      'Orbit sells deployment speed because it has nothing else to sell',
    );
  });

  it('keeps a question mark or an exclamation', () => {
    expect(headlineFromText('Who signed off on this? Nobody is saying.')).toBe('Who signed off on this?');
    expect(headlineFromText('We shipped! Details below.')).toBe('We shipped!');
  });

  it('does not end a sentence inside a figure', () => {
    expect(headlineFromText('We raised $2.5B at a $40B valuation. More soon.')).toBe('We raised $2.5B at a $40B valuation');
  });

  it('falls back to the first clause when the sentence runs long', () => {
    const text =
      'Every one of our enterprise customers was told within the hour, and the deployment was withdrawn before a single further output reached a production system anywhere.';
    expect(headlineFromText(text)).toBe('Every one of our enterprise customers was told within the hour');
  });

  it('cuts at a word boundary with an ellipsis when there is no clause to take', () => {
    const text = 'Word '.repeat(40).trim();
    const headline = headlineFromText(text);
    expect(headline.length).toBeLessThanOrEqual(80);
    expect(headline.endsWith('…')).toBe(true);
    // The cut lands between two whole words of the original.
    const kept = headline.slice(0, -1);
    expect(text.startsWith(kept)).toBe(true);
    expect(text.charAt(kept.length)).toBe(' ');
  });

  it('collapses whitespace and never returns an empty headline', () => {
    expect(headlineFromText('  Two   spaces\n and a newline.  ')).toBe('Two spaces and a newline');
    expect(headlineFromText('   ')).toBe('Untitled');
  });

  it('is what the projection prints for a post, with no deck and the whole body', () => {
    const state = recorded();
    const record = projectPublicRecord(state, PLAYER_ID);
    const post = record.find((item) => item.kind === 'post' && item.who.characterId === 'chr_maya_chen');
    expect(post).toBeDefined();
    expect(post?.headline).toBe('Orbit sells deployment speed because it has nothing else to sell');
    expect(post?.headline).not.toMatch(/posted on|went after|fast feed/i);
    expect(post?.deck).toBeNull();
    expect(post?.body).toBe(ATTACK_ON_ORBIT.text);
    expect(post?.kicker.word).toBe('Broadside');
    expect(post?.kicker.company).toBe('Nexus Intelligence');
    expect(typeof post?.pressPickup).toBe('boolean');
  });
});

describe('clipHeadline', () => {
  it('leaves a short headline alone and cuts a long one at a word', () => {
    expect(clipHeadline('Short', 90)).toBe('Short');
    const long = 'A very long headline that keeps going well past the ninety character ceiling a phone can carry on three lines';
    const cut = clipHeadline(long, PUBLIC_RECORD_HEADLINE_MAX);
    expect(cut.length).toBeLessThanOrEqual(PUBLIC_RECORD_HEADLINE_MAX);
    expect(cut.endsWith('…')).toBe(true);
    const kept = cut.slice(0, -1);
    expect(long.startsWith(kept)).toBe(true);
    expect(long.charAt(kept.length)).toBe(' ');
  });

  it('does not leave a dangling comma before the ellipsis', () => {
    const cut = clipHeadline('One thing, another thing, and a third thing that is quite long indeed, and then some more words here to pass ninety', 60);
    expect(cut).not.toMatch(/,…$/);
  });
});

/* -------------------------------------------------------------------------- */
/*  Kickers and decks                                                          */
/* -------------------------------------------------------------------------- */

describe('kickers', () => {
  it('distinguish a press release, a rumour, a leak and a filing', () => {
    const record = projectPublicRecord(recorded(), PLAYER_ID);
    expect(byId(record, 'dsc_release').kicker.word).toBe('Press release');
    expect(byId(record, 'dsc_rumour').kicker.word).toBe('Rumour');
    expect(byId(record, 'dsc_leak').kicker.word).toBe('Leak');
    expect(byId(record, 'dsc_filing').kicker.word).toBe('Filing');
    // No article before a mass noun: "Earnings from", never "A earnings from".
    expect(byId(record, 'dsc_earnings').deck).toBe('Earnings from Orbit Dynamics, believed at 71%');
    expect(new Set(Object.values(DISCLOSURE_KICKER)).size).toBe(Object.keys(DISCLOSURE_KICKER).length);
  });

  it('carry the story angle, the event type and the company', () => {
    const record = projectPublicRecord(recorded(), PLAYER_ID);
    const story = byId(record, STORY.id);
    expect(story.kicker.word).toBe('Safety');
    expect(story.kicker.company).toBe('Orbit Dynamics');
    const event = byId(record, EXPORT_CONTROL.id);
    expect(event.kicker.word).toBe('Export control');
    expect(event.kicker.company).toBe('Aurora Compute');
  });

  it('never print a raw enum token', () => {
    const record = projectPublicRecord(recorded(), PLAYER_ID);
    for (const item of record) {
      expect(item.kicker.word).not.toMatch(/_/);
      expect(item.headline).not.toMatch(/\b[a-z]+_[a-z_]+\b/);
    }
  });
});

describe('decks', () => {
  it('give a world event its severity, its quarters to run and its modifier count', () => {
    const state = recorded();
    state.quarter = 2;
    state.activeModifiers = [
      {
        id: 'mod_a',
        source: 'event',
        target: 'world.compute.spotPrice',
        operation: 'multiply',
        value: 1.1,
        decay: 'linear',
        durationQuarters: 2,
        remainingQuarters: 2,
        appliedAtQuarter: 1,
        originEventId: EXPORT_CONTROL.id,
        reason: 'Export controls tightened accelerator supply.',
        elapsedQuarters: 0,
        effectiveValue: 1.1,
        lastAppliedQuarter: 1,
        exhausted: false,
      },
      {
        id: 'mod_b',
        source: 'event',
        target: 'sector.semiconductors.sentiment',
        operation: 'add',
        value: -0.1,
        decay: 'linear',
        durationQuarters: 2,
        remainingQuarters: 2,
        appliedAtQuarter: 1,
        originEventId: EXPORT_CONTROL.id,
        reason: 'The sector re-rated.',
        elapsedQuarters: 0,
        effectiveValue: -0.1,
        lastAppliedQuarter: 1,
        exhausted: false,
      },
    ];
    const event = byId(projectPublicRecord(state, PLAYER_ID), EXPORT_CONTROL.id);
    expect(event.deck).toBe('A major shock · 3 quarters to run · carries 2 modifiers');
    expect(severityLabel(0.1)).toBe('A footnote');
    expect(severityLabel(0.95)).toBe('Reshapes the session');
    expect(quartersToRun({ quarter: 1, durationQuarters: 4 }, 5)).toBe(0);
  });

  it('give a story its tone, credibility and readership, and a disclosure its kind and credibility', () => {
    const record = projectPublicRecord(recorded(), PLAYER_ID);
    expect(byId(record, STORY.id).deck).toBe('Hostile coverage the market believes at 62%, read by 4M');
    expect(byId(record, 'dsc_rumour').deck).toBe('A rumour from Orbit Dynamics, believed at 71%');
    expect(byId(record, 'dsc_release').deck).toBe('A press release from Orbit Dynamics, believed at 71%');
    expect(byId(record, 'dsc_filing').deck).toBe('A filing from Orbit Dynamics, believed at 71%');
    expect(peopleLabel(740)).toBe('740');
    expect(peopleLabel(18_400)).toBe('18k');
  });

  it('never truncate the body and always fit the headline and deck ceilings', () => {
    const record = projectPublicRecord(recorded(), PLAYER_ID);
    const event = byId(record, EXPORT_CONTROL.id);
    expect(event.body).toBe(EXPORT_CONTROL.description);
    expect(event.body.length).toBeGreaterThan(1000);
    for (const item of record) {
      expect(item.headline.length).toBeLessThanOrEqual(PUBLIC_RECORD_HEADLINE_MAX);
      if (item.deck !== null) expect(item.deck.length).toBeLessThanOrEqual(PUBLIC_RECORD_DECK_MAX);
      expect(PublicRecordItemSchema.safeParse(item).success).toBe(true);
      // Only a post has a press-pickup reading.
      expect(item.pressPickup === null).toBe(item.kind !== 'post' && item.kind !== 'reply');
    }
  });
});

/* -------------------------------------------------------------------------- */
/*  The ledger index                                                           */
/* -------------------------------------------------------------------------- */

/** The scan the index replaced, kept here as the oracle. */
function ledgerForByScan(ledger: readonly SimEvent[], subjectId: string, payloadKeys: readonly string[]): string[] {
  const ids: string[] = [];
  for (const row of ledger) {
    const payload = row.payload;
    const matched = row.targetId === subjectId || payloadKeys.some((key) => typeof payload[key] === 'string' && payload[key] === subjectId);
    if (matched) ids.push(row.eventId);
  }
  return ids;
}

describe('the ledger index', () => {
  it('returns exactly what the scan returned, for every item of a resolved quarter', () => {
    const engine = createDefaultEngine();
    const outcome = engine.resolver.resolveQuarter(createWorld2Session(), [], null, []);
    expect(outcome.committed).toBe(true);
    const ledger = outcome.events;
    const index = buildLedgerIndex(ledger);

    const subjects: readonly (readonly [string, readonly ('eventId' | 'originEventId' | 'sourceEventId' | 'storyId' | 'disclosureId' | 'postId')[]])[] = [
      ...outcome.nextState.activeEvents.map((event) => [event.id, ['eventId', 'originEventId', 'sourceEventId'] as const] as const),
      ...outcome.nextState.mediaStories.map((story) => [story.id, ['storyId'] as const] as const),
      ...outcome.nextState.disclosures.map((entry) => [entry.id, ['disclosureId'] as const] as const),
      ...outcome.nextState.socialPosts.map((post) => [post.id, ['postId'] as const] as const),
    ];
    expect(subjects.length).toBeGreaterThan(0);
    let cited = 0;
    for (const [subjectId, keys] of subjects) {
      const viaIndex = ledgerIdsFor(index, subjectId, keys);
      expect(viaIndex).toEqual(ledgerForByScan(ledger, subjectId, keys));
      cited += viaIndex.length;
    }
    expect(cited).toBeGreaterThan(0);
  });

  it('keeps ledger order and cites a row once when it names the subject twice', () => {
    const rows = [
      { eventId: 'evt_1', targetId: 'wev_x', payload: { originEventId: 'wev_x' } },
      { eventId: 'evt_2', targetId: null, payload: { storyId: 'sty_1', sourceEventId: 'wev_x' } },
      { eventId: 'evt_3', targetId: 'wev_x', payload: {} },
    ] as unknown as SimEvent[];
    const index = buildLedgerIndex(rows);
    expect(ledgerIdsFor(index, 'wev_x', ['eventId', 'originEventId', 'sourceEventId'])).toEqual(['evt_1', 'evt_2', 'evt_3']);
    // A key the caller did not ask for does not cite.
    expect(ledgerIdsFor(index, 'wev_x', ['eventId'])).toEqual(['evt_1', 'evt_3']);
    expect(ledgerIdsFor(index, 'sty_1', ['storyId'])).toEqual(['evt_2']);
    expect(ledgerIdsFor(index, 'nobody', ['storyId'])).toEqual([]);
  });

  it('is what the projection attaches', () => {
    const engine = createDefaultEngine();
    const outcome = engine.resolver.resolveQuarter(createWorld2Session(), [], null, []);
    const playerId = outcome.nextState.players[0]?.playerId ?? '';
    const record = projectPublicRecord(outcome.nextState, playerId, { ledger: outcome.events });
    expect(record.some((item) => item.ledgerEventIds.length > 0)).toBe(true);
    for (const item of record) {
      const keys =
        item.kind === 'event'
          ? ['eventId', 'originEventId', 'sourceEventId']
          : item.kind === 'story'
            ? ['storyId']
            : item.kind === 'disclosure'
              ? ['disclosureId']
              : ['postId'];
      // Rows this seat may not read were dropped before indexing, so the oracle
      // is the scan over the same visible subset the projection was handed.
      expect(item.ledgerEventIds.every((id) => ledgerForByScan(outcome.events, item.id, keys).includes(id))).toBe(true);
    }
  });
});

/* -------------------------------------------------------------------------- */
/*  Determinism, windows and editions                                          */
/* -------------------------------------------------------------------------- */

describe('determinism and windows', () => {
  it('projects the same list twice, writing included', () => {
    const state = recorded();
    expect(projectPublicRecord(state, PLAYER_ID)).toEqual(projectPublicRecord(state, PLAYER_ID));
    expect(projectEditionIndex(state, PLAYER_ID)).toEqual(projectEditionIndex(state, PLAYER_ID));
  });

  it('honours sinceQuarter without reordering', () => {
    const engine = createDefaultEngine();
    let state = createWorld2Session();
    for (let index = 0; index < 3; index += 1) {
      const outcome = engine.resolver.resolveQuarter(state, [], null, []);
      expect(outcome.committed).toBe(true);
      state = outcome.nextState;
    }
    const playerId = state.players[0]?.playerId ?? '';
    const whole = projectPublicRecord(state, playerId, { limit: Number.POSITIVE_INFINITY });
    const newest = whole[0]?.quarter ?? 0;
    const window = projectPublicRecord(state, playerId, { sinceQuarter: newest, limit: Number.POSITIVE_INFINITY });
    expect(window.length).toBeGreaterThan(0);
    expect(window.every((item) => item.quarter === newest)).toBe(true);
    expect(window.map((item) => item.id)).toEqual(whole.filter((item) => item.quarter === newest).map((item) => item.id));
  });

  it('indexes editions exactly as the full projection groups them', () => {
    const engine = createDefaultEngine();
    let state = createWorld2Session();
    for (let index = 0; index < 3; index += 1) {
      state = engine.resolver.resolveQuarter(state, [], null, []).nextState;
    }
    const playerId = state.players[0]?.playerId ?? '';
    const whole = projectPublicRecord(state, playerId, { limit: Number.POSITIVE_INFINITY });
    const editions = projectEditionIndex(state, playerId);

    const quarters = [...new Set(whole.map((item) => item.quarter))].sort((a, b) => b - a);
    expect(editions.map((edition) => edition.quarter)).toEqual(quarters);
    for (const edition of editions) {
      const ofQuarter = whole.filter((item) => item.quarter === edition.quarter);
      expect(edition.count).toBe(ofQuarter.length);
      expect(edition.leadId).toBe(ofQuarter[0]?.id ?? null);
      expect(edition.leadHeadline).toBe(ofQuarter[0]?.headline ?? null);
    }
  });
});

/* -------------------------------------------------------------------------- */
/*  One utterance, printed once                                                */
/* -------------------------------------------------------------------------- */

describe('a post the market heard as a disclosure', () => {
  it('is one item — the post — carrying how it was heard, both sets of rows and the heavier weight', () => {
    const state = liveState();
    state.activeEvents = [EXPORT_CONTROL];
    state.pendingActions = [postAction(ATTACK_ON_ORBIT)];
    const harness = makeContext(1);
    propagatePosts(state, harness.ctx);

    // The engine stored the attack twice: as the post and as the rumour it became.
    const post = state.socialPosts.find((entry) => entry.text === ATTACK_ON_ORBIT.text);
    const rumour = state.disclosures.find((entry) => entry.body === ATTACK_ON_ORBIT.text);
    expect(post).toBeDefined();
    expect(rumour?.kind).toBe('rumour');

    const folds = planFolds(state, Number.NEGATIVE_INFINITY);
    expect(folds.postOf.get(rumour?.id ?? '')?.id).toBe(post?.id);
    expect(folds.disclosureOf.get(post?.id ?? '')?.id).toBe(rumour?.id);

    const record = projectPublicRecord(state, PLAYER_ID, { ledger: (harness.events as unknown as SimEvent[]) });
    expect(record.filter((item) => item.body === ATTACK_ON_ORBIT.text)).toHaveLength(1);
    expect(record.some((item) => item.id === rumour?.id)).toBe(false);

    const printed = byId(record, post?.id ?? '');
    expect(printed.kind).toBe('post');
    expect(printed.kicker.word).toBe('Broadside');
    expect(printed.heard).toEqual({ kind: 'rumour', credibility: rumour?.credibility });
    expect(printed.weight).toBeGreaterThanOrEqual((rumour?.credibility ?? 0) * DISCLOSURE_ATTENTION.rumour - 1e-9);
    // The rumour's ledger row is cited on the post.
    const rumourRows = (harness.events as unknown as SimEvent[]).filter((row) => row.targetId === rumour?.id || row.payload['disclosureId'] === rumour?.id);
    expect(rumourRows.length).toBeGreaterThan(0);
    for (const row of rumourRows) expect(printed.ledgerEventIds).toContain(row.eventId);
    // No headline is printed twice under two bylines.
    const seen = new Set<string>();
    for (const item of record) {
      const key = `${item.who.name}\u0000${item.headline}`;
      expect(seen.has(key), key).toBe(false);
      seen.add(key);
    }
  });

  it('leaves a filing a company wrote itself as its own item, and keeps the editions in step', () => {
    const state = recorded();
    const record = projectPublicRecord(state, PLAYER_ID, { limit: Number.POSITIVE_INFINITY });
    for (const id of ['dsc_release', 'dsc_rumour', 'dsc_leak', 'dsc_filing', 'dsc_earnings']) expect(record.some((item) => item.id === id)).toBe(true);
    const editions = projectEditionIndex(state, PLAYER_ID);
    const ofQuarter = record.filter((item) => item.quarter === 1);
    expect(editions.find((edition) => edition.quarter === 1)?.count).toBe(ofQuarter.length);
    expect(editions.find((edition) => edition.quarter === 1)?.leadId).toBe(ofQuarter[0]?.id);
  });

  it('holds over a resolved world: every printed utterance appears once per speaker', () => {
    const engine = createDefaultEngine();
    let state = createWorld2Session();
    for (let index = 0; index < 2; index += 1) state = engine.resolver.resolveQuarter(state, [], null, []).nextState;
    const playerId = state.players[0]?.playerId ?? '';
    const record = projectPublicRecord(state, playerId, { limit: Number.POSITIVE_INFINITY });
    const folds = planFolds(state, Number.NEGATIVE_INFINITY);
    expect(folds.postOf.size).toBeGreaterThan(0);
    for (const disclosureId of folds.postOf.keys()) expect(record.some((item) => item.id === disclosureId)).toBe(false);
    const seen = new Set<string>();
    for (const item of record) {
      const key = `${item.quarter}\u0000${item.who.characterId ?? item.who.name}\u0000${item.body}`;
      expect(seen.has(key), item.headline).toBe(false);
      seen.add(key);
    }
  });
});

/* -------------------------------------------------------------------------- */
/*  Who said it                                                                */
/* -------------------------------------------------------------------------- */

describe('a disclosure\'s byline', () => {
  const rivalRumour = (): PublicDisclosure => ({
    id: 'dsc_rival_rumour',
    companyId: 'cmp_nexus',
    quarter: 1,
    kind: 'rumour',
    headline: 'Nexus has this wrong',
    body: 'Nexus has this wrong. Ask them what changed.',
    metrics: { reach: 120_000 },
    credibility: 0.3,
    // Tomas works for Vector; the rumour is about Nexus, the player\'s company.
    sourceCharacterId: 'chr_tomas_lindqvist',
    isTruthful: false,
    beliefTopic: 'margin_pressure',
  });

  it('is the source and the company the source works for, never the subject', () => {
    const state = liveState();
    state.disclosures = [...state.disclosures, rivalRumour()];
    const item = byId(projectPublicRecord(state, PLAYER_ID), 'dsc_rival_rumour');
    const tomas = state.characters.find((entry) => entry.id === 'chr_tomas_lindqvist');
    expect(tomas?.companyId).toBe('cmp_vector');
    expect(item.who.characterId).toBe('chr_tomas_lindqvist');
    expect(item.who.companyId).toBe('cmp_vector');
    expect(item.who.companyId).not.toBe('cmp_nexus');
    // The subject stays where a reader looks for it: the kicker and the company list.
    expect(item.companyIds).toEqual(['cmp_nexus']);
    expect(item.kicker.company).toBe('Nexus Intelligence');
    expect(item.deck).toBe('A rumour about Nexus Intelligence from Tomas Lindqvist, believed at 30%');
    // And it still says what it did to the reader, because it is about them.
    expect(item.whyItMatters).toMatch(/^about you: rumour/);
  });

  it('is the company when a company files in its own name, and nobody when a leak names nobody', () => {
    const state = liveState();
    state.disclosures = [
      ...state.disclosures,
      disclosure('earnings', 'dsc_own_results'),
      { ...disclosure('leak', 'dsc_anon_leak'), headline: 'Orbit is behind on its agent stack', body: 'Orbit is behind on its agent stack.' },
    ];
    const record = projectPublicRecord(state, PLAYER_ID);
    const results = byId(record, 'dsc_own_results');
    expect(results.who.companyId).toBe('cmp_orbit');
    expect(results.who.name).toBe('Orbit Dynamics');
    const leak = byId(record, 'dsc_anon_leak');
    expect(leak.who.companyId).toBeNull();
    expect(leak.who.name).toBe('An unattributed source');
    expect(leak.companyIds).toEqual(['cmp_orbit']);
  });
});

/* -------------------------------------------------------------------------- */
/*  What leads                                                                 */
/* -------------------------------------------------------------------------- */

describe('attention', () => {
  it('ranks a routine set of results below a minor shock and a middling story', () => {
    const state = liveState();
    state.activeEvents = [{ ...EXPORT_CONTROL, severity: 0.4 }];
    state.mediaStories = [...state.mediaStories, { ...STORY, prominence: 0.45 }];
    state.disclosures = [
      ...state.disclosures,
      {
        ...disclosure('earnings', 'dsc_big_results'),
        credibility: 0.9,
        metrics: { revenue: 2_388_974_800, grossMargin: 0.699, operatingIncome: 650_500_000, cash: 7_000_000_000, debt: 0 },
      },
      { ...disclosure('guidance', 'dsc_guide'), credibility: 0.95 },
    ];
    const record = projectPublicRecord(state, PLAYER_ID);
    const order = record.map((item) => item.id);
    expect(order.indexOf(EXPORT_CONTROL.id)).toBeLessThan(order.indexOf('dsc_big_results'));
    expect(order.indexOf(STORY.id)).toBeLessThan(order.indexOf('dsc_big_results'));
    expect(order.indexOf(STORY.id)).toBeLessThan(order.indexOf('dsc_guide'));
    expect(byId(record, 'dsc_big_results').weight).toBeCloseTo(0.9 * DISCLOSURE_ATTENTION.earnings, 6);
    // A believed rumour or thesis still commands attention.
    expect(DISCLOSURE_ATTENTION.rumour).toBeGreaterThan(DISCLOSURE_ATTENTION.press_release);
    expect(DISCLOSURE_ATTENTION.press_release).toBeGreaterThan(DISCLOSURE_ATTENTION.earnings);
  });

  it('writes an earnings deck from the figures rather than restating the byline', () => {
    const state = liveState();
    state.disclosures = [
      ...state.disclosures,
      {
        ...disclosure('earnings', 'dsc_big_results'),
        credibility: 0.84,
        metrics: { revenue: 2_388_974_800, grossMargin: 0.699, operatingIncome: 650_500_000, cash: 7_000_000_000, debt: 0 },
      },
      { ...disclosure('earnings', 'dsc_loss'), credibility: 0.6, metrics: { revenue: 1_000_000, grossMargin: 0.2, operatingIncome: -40_000_000, cash: 12_000_000, debt: 0 } },
    ];
    const record = projectPublicRecord(state, PLAYER_ID);
    expect(byId(record, 'dsc_big_results').deck).toBe('70% gross margin · $651M operating income · $7B cash; believed at 84%');
    expect(byId(record, 'dsc_loss').deck).toBe('20% gross margin · $40M operating loss · $12M cash; believed at 60%');
    expect(byId(record, 'dsc_big_results').deck).not.toContain('Orbit');
  });
});
