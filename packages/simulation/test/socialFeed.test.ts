/**
 * @frontier/simulation — the living feed.
 *
 * Two things are under test here and they are separable on purpose.
 *
 * **NPC posting.** The engine authors this quarter's posts from committed state,
 * inside the bounds it declares, in an order that does not depend on anything
 * but the state — and it does none of it in world version 1, which is frozen so
 * that a save made against it replays to the state its player actually saw.
 *
 * **The public record.** One reverse-chronological list merged from four tables,
 * redacted to one seat before it exists, with a whole-number consequence line
 * computed from what each item actually did. Nothing here asserts a number a
 * model supplied, because no model supplies one.
 */

import { describe, expect, it } from 'vitest';
import type { SessionState, SimEvent, SocialPost, SocialPostDraft, WorldEvent } from '@frontier/contracts';
import { createDefaultEngine } from '../src/engine';
import { createDemoSession } from '../src/scenario/demo';
import { createWorld2Session } from '../src/scenario/world2/index';
import {
  MAX_NPC_REPLIES_PER_QUARTER,
  MAX_SOCIAL_TEXT_OVERRIDES,
  applySocialTextOverrides,
  collectNpcPostCandidates,
  npcPostBudget,
  npcPostingEnabled,
  propagatePosts,
  renderNpcText,
  selectPostsForAuthoring,
  spokespersonFor,
  voiceOf,
} from '../src/social/index';
import { projectPublicRecord } from '../src/resolver/publicRecord';
import { cloneState, makeAction, makeContext, makeRng, makeState } from './_institutionsHarness';

/* -------------------------------------------------------------------------- */
/*  Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

const PLAYER_ID = 'ply_01';

/** The harness world, told it is the multi-sector one so the engine may speak. */
function liveState(): SessionState {
  const state = makeState();
  state.config = { ...state.config, worldVersion: 2 };
  return state;
}

const EXPORT_CONTROL: WorldEvent = {
  id: 'wev_export_control',
  familyId: 'fam_export_control',
  type: 'export_control',
  titleKey: 'accelerator_export_restriction',
  title: 'Advanced accelerator exports restricted',
  description: 'The federation extended export controls to the current generation of training accelerators, with immediate effect for allied resale.',
  severity: 0.72,
  visibility: 'public',
  durationQuarters: 4,
  causalParentId: null,
  quarter: 1,
  affectedSectorIds: ['semiconductors', 'frontier_ai'],
  affectedCompanyIds: ['cmp_aurora'],
};

const SAFETY_INCIDENT: WorldEvent = {
  ...EXPORT_CONTROL,
  id: 'wev_orbit_incident',
  familyId: 'fam_safety',
  type: 'safety_incident',
  titleKey: 'orbit_deployment_failure',
  title: 'Orbit deployment fails in production',
  description: 'An Orbit Dynamics agent deployment produced unsafe outputs for three enterprise customers before it was withdrawn, and the withdrawal was not announced.',
  severity: 0.66,
  affectedSectorIds: ['enterprise_software'],
  affectedCompanyIds: ['cmp_orbit'],
};

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

/** Resolve `count` quarters of a session with nobody submitting anything. */
function runQuarters(start: SessionState, count: number): { state: SessionState; events: SimEvent[] } {
  const engine = createDefaultEngine();
  let state = start;
  const events: SimEvent[] = [];
  for (let index = 0; index < count; index += 1) {
    const outcome = engine.resolver.resolveQuarter(state, [], null, []);
    expect(outcome.committed).toBe(true);
    state = outcome.nextState;
    events.push(...outcome.events);
  }
  return { state, events };
}

/* -------------------------------------------------------------------------- */
/*  The frozen world stays silent                                              */
/* -------------------------------------------------------------------------- */

describe('world version 1', () => {
  it('authors nothing, so a frozen save replays to the world its player saw', () => {
    const state = makeState();
    state.activeEvents = [EXPORT_CONTROL, SAFETY_INCIDENT];
    const accountsBefore = state.socialAccounts.length;

    expect(npcPostingEnabled(state)).toBe(false);
    propagatePosts(state, makeContext(1).ctx);

    expect(state.socialPosts).toEqual([]);
    // Not one account created either: `ensureAccount` is only reached by an
    // author, and in the frozen world there is never an engine author.
    expect(state.socialAccounts.length).toBe(accountsBefore);
  });

  it('resolves four quarters of the frozen demo with an empty feed', () => {
    const opening = createDemoSession();
    const { state } = runQuarters(opening, 4);
    expect(state.socialPosts.length).toBe(0);
    expect(state.socialAccounts.length).toBe(opening.socialAccounts.length);
  });
});

/* -------------------------------------------------------------------------- */
/*  The multi-sector world talks                                               */
/* -------------------------------------------------------------------------- */

describe('npc posting', () => {
  it('scales its budget with the size of the world', () => {
    expect(npcPostBudget(7)).toBe(6);
    expect(npcPostBudget(25)).toBe(15);
    // Bounded at both ends, whatever the economy does.
    expect(npcPostBudget(0)).toBe(6);
    expect(npcPostBudget(400)).toBe(15);
  });

  it('answers a public event in the voice of the company it names', () => {
    const state = liveState();
    state.activeEvents = [EXPORT_CONTROL, SAFETY_INCIDENT];
    propagatePosts(state, makeContext(1).ctx);

    expect(state.socialPosts.length).toBeGreaterThan(0);
    expect(state.socialPosts.length).toBeLessThanOrEqual(npcPostBudget(state.companies.length) + MAX_NPC_REPLIES_PER_QUARTER);

    // Orbit is named by a safety incident, so Orbit answers for it.
    const orbit = state.socialPosts.find((post) => post.authorCharacterId === 'chr_daniel_okonkwo');
    expect(orbit).toBeDefined();
    expect(['defend', 'apologise']).toContain(orbit?.intent);
    expect(orbit?.text.length ?? 0).toBeGreaterThan(0);
    expect(orbit?.text.length ?? 0).toBeLessThanOrEqual(560);

    for (const post of state.socialPosts) {
      // Everything the engine writes is labelled, and no player is ever made to
      // speak: the player's character is `chr_maya_chen`.
      expect(post.isAiGenerated).toBe(true);
      expect(post.authorCharacterId).not.toBe('chr_maya_chen');
      expect(post.engagement).not.toBeNull();
    }
  });

  it('gives one character one turn a quarter', () => {
    const state = liveState();
    state.activeEvents = [EXPORT_CONTROL, SAFETY_INCIDENT];
    propagatePosts(state, makeContext(1).ctx);

    const topLevel = state.socialPosts.filter((post) => post.replyToPostId === null);
    const authors = topLevel.map((post) => post.authorCharacterId);
    expect(new Set(authors).size).toBe(authors.length);
  });

  it('produces the same feed twice from the same state', () => {
    const first = liveState();
    first.activeEvents = [EXPORT_CONTROL, SAFETY_INCIDENT];
    const second = cloneState(first);

    propagatePosts(first, makeContext(1).ctx);
    propagatePosts(second, makeContext(1).ctx);

    expect(second.socialPosts.map((post) => post.id)).toEqual(first.socialPosts.map((post) => post.id));
    expect(second.socialPosts.map((post) => post.text)).toEqual(first.socialPosts.map((post) => post.text));
    expect(second.socialPosts.map((post) => post.engagement?.reach ?? 0)).toEqual(first.socialPosts.map((post) => post.engagement?.reach ?? 0));
  });

  it('draws its candidates from committed state alone', () => {
    const state = liveState();
    state.activeEvents = [EXPORT_CONTROL];
    const once = collectNpcPostCandidates(state, 1);
    const twice = collectNpcPostCandidates(state, 1);
    expect(twice).toEqual(once);
    // Reading the candidate set changes nothing.
    expect(state.socialPosts).toEqual([]);
  });

  it('stays inside its bounds across four quarters of the twenty-five-company world', () => {
    const { state } = runQuarters(createWorld2Session(), 4);
    const budget = npcPostBudget(state.companies.length);
    let spoke = 0;

    for (let quarter = 0; quarter < 4; quarter += 1) {
      const posts = state.socialPosts.filter((post) => post.quarter === quarter);
      const replies = posts.filter((post) => post.replyToPostId !== null);
      expect(posts.length - replies.length).toBeLessThanOrEqual(budget);
      expect(replies.length).toBeLessThanOrEqual(MAX_NPC_REPLIES_PER_QUARTER);
      spoke += posts.length;
    }
    // The point of the whole exercise: the networks are not empty.
    expect(spoke).toBeGreaterThan(10);
  });
});

/* -------------------------------------------------------------------------- */
/*  Templates                                                                  */
/* -------------------------------------------------------------------------- */

describe('templates', () => {
  const fields = { company: 'Nexus Intelligence', subject: 'Nexus Reasoning', rival: 'Orbit Dynamics', figure: '$40M' };

  it('renders the same line for the same author, stream and template', () => {
    const first = renderNpcText('product_launch', 'blunt', makeRng('seed'), fields);
    const second = renderNpcText('product_launch', 'blunt', makeRng('seed'), fields);
    expect(second).toBe(first);
    expect(first).toContain('Nexus Reasoning');
    expect(first.length).toBeLessThanOrEqual(560);
  });

  it('gives a different register to a different voice', () => {
    const blunt = renderNpcText('funding_round', 'blunt', makeRng('seed'), fields);
    const evangelical = renderNpcText('funding_round', 'evangelical', makeRng('seed'), fields);
    expect(blunt).not.toBe(evangelical);
    expect(blunt).toContain('$40M');
    expect(evangelical).toContain('$40M');
  });

  it('keys the voice on traits that never change', () => {
    const state = liveState();
    const maya = state.characters.find((character) => character.id === 'chr_maya_chen');
    const kenji = state.characters.find((character) => character.id === 'chr_kenji_watanabe');
    if (maya === undefined || kenji === undefined) throw new Error('missing character');
    // Maya is aggressive (83); Kenji is not (29) and is deeply technical.
    expect(voiceOf(maya)).toBe('blunt');
    expect(voiceOf(kenji)).toBe('measured');
  });
});

/* -------------------------------------------------------------------------- */
/*  Threads                                                                    */
/* -------------------------------------------------------------------------- */

describe('replies', () => {
  it('answers a post aimed at a company, in the same quarter and on the same network', () => {
    const state = liveState();
    state.pendingActions = [postAction(ATTACK_ON_ORBIT)];
    propagatePosts(state, makeContext(1).ctx);

    const attack = state.socialPosts.find((post) => post.intent === 'attack' && post.authorCharacterId === 'chr_maya_chen');
    expect(attack).toBeDefined();

    const reply = state.socialPosts.find((post) => post.replyToPostId === attack?.id);
    expect(reply).toBeDefined();
    expect(reply?.authorCharacterId).toBe('chr_daniel_okonkwo');
    expect(reply?.network).toBe(attack?.network);
    expect(reply?.quarter).toBe(1);
    expect(reply?.isAiGenerated).toBe(true);
    // The answer lands back on the company that made the claim.
    expect(reply?.targetCompanyId).toBe('cmp_nexus');
    // And it is a real post: the engine propagated it like any other.
    expect(reply?.engagement).not.toBeNull();
  });

  it('keeps a thread two deep', () => {
    const state = liveState();
    state.pendingActions = [postAction(ATTACK_ON_ORBIT)];
    propagatePosts(state, makeContext(1).ctx);

    const replies = state.socialPosts.filter((post) => post.replyToPostId !== null);
    for (const reply of replies) {
      expect(state.socialPosts.some((post) => post.replyToPostId === reply.id)).toBe(false);
    }
  });

  it('never puts words in a player character\'s mouth', () => {
    const state = liveState();
    // Aimed at the player's own company, whose only leader is the player.
    state.pendingActions = [
      postAction({
        authorCharacterId: 'chr_tomas_lindqvist',
        network: 'fast_feed',
        text: 'Nexus has been quietly repricing enterprise seats while telling customers nothing has changed.',
        intent: 'attack',
        targetCompanyId: 'cmp_nexus',
      }),
    ];
    propagatePosts(state, makeContext(1).ctx);

    expect(spokespersonFor(state, state.companies.find((company) => company.id === 'cmp_nexus')!)).toBeNull();
    for (const post of state.socialPosts) {
      const author = state.characters.find((character) => character.id === post.authorCharacterId);
      if (post.isAiGenerated) expect(author?.isPlayer ?? false).toBe(false);
    }
  });
});

/* -------------------------------------------------------------------------- */
/*  Model-written prose over engine-authored posts                             */
/* -------------------------------------------------------------------------- */

describe('social text overrides', () => {
  function withOnePost(): { state: SessionState; post: SocialPost } {
    const state = liveState();
    state.activeEvents = [SAFETY_INCIDENT];
    propagatePosts(state, makeContext(1).ctx);
    const post = state.socialPosts.find((entry) => entry.isAiGenerated);
    if (post === undefined) throw new Error('expected an engine-authored post');
    return { state, post };
  }

  it('replaces the words and nothing else', () => {
    const { state, post } = withOnePost();
    const next = applySocialTextOverrides(state, [{ postId: post.id, text: 'We withdrew it within the hour and every affected customer has been called.' }], 1);
    const written = next.socialPosts.find((entry) => entry.id === post.id);

    expect(written?.text).toBe('We withdrew it within the hour and every affected customer has been called.');
    expect(written?.intent).toBe(post.intent);
    expect(written?.targetCompanyId).toBe(post.targetCompanyId);
    expect(written?.engagement).toEqual(post.engagement);
    // Pure: the state handed in is untouched.
    expect(state.socialPosts.find((entry) => entry.id === post.id)?.text).toBe(post.text);
  });

  it('refuses a human\'s post, an unknown post, another quarter and an over-long line', () => {
    const { state, post } = withOnePost();
    const human = { ...post, id: 'pst_human', isAiGenerated: false };
    state.socialPosts.push(human);

    const unchanged = applySocialTextOverrides(
      state,
      [
        { postId: 'pst_human', text: 'Words the player never wrote.' },
        { postId: 'pst_nonexistent', text: 'Words about nothing.' },
        { postId: post.id, text: 'x'.repeat(561) },
      ],
      1,
    );
    expect(unchanged).toBe(state);

    const wrongQuarter = applySocialTextOverrides(state, [{ postId: post.id, text: 'Written a quarter too late.' }], 2);
    expect(wrongQuarter).toBe(state);
  });

  it('names at most three posts to write, loudest first', () => {
    const state = liveState();
    state.activeEvents = [EXPORT_CONTROL, SAFETY_INCIDENT];
    propagatePosts(state, makeContext(1).ctx);

    const chosen = selectPostsForAuthoring(state, 1);
    expect(chosen.length).toBeLessThanOrEqual(MAX_SOCIAL_TEXT_OVERRIDES);
    expect(chosen.every((post) => post.isAiGenerated)).toBe(true);
    for (let index = 1; index < chosen.length; index += 1) {
      expect(chosen[index - 1]!.engagement?.reach ?? 0).toBeGreaterThanOrEqual(chosen[index]!.engagement?.reach ?? 0);
    }
    // The same committed quarter always names the same posts.
    expect(selectPostsForAuthoring(state, 1).map((post) => post.id)).toEqual(chosen.map((post) => post.id));
  });
});

/* -------------------------------------------------------------------------- */
/*  The public record                                                          */
/* -------------------------------------------------------------------------- */

describe('public record', () => {
  function recorded(): SessionState {
    const state = liveState();
    state.activeEvents = [EXPORT_CONTROL, SAFETY_INCIDENT];
    state.pendingActions = [postAction(ATTACK_ON_ORBIT)];
    const harness = makeContext(1);
    propagatePosts(state, harness.ctx);
    return state;
  }

  it('returns the same list twice, newest and heaviest first', () => {
    const state = recorded();
    const first = projectPublicRecord(state, PLAYER_ID);
    const second = projectPublicRecord(state, PLAYER_ID);
    expect(second).toEqual(first);
    expect(first.length).toBeGreaterThan(0);

    for (let index = 1; index < first.length; index += 1) {
      const previous = first[index - 1]!;
      const current = first[index]!;
      if (previous.quarter !== current.quarter) {
        expect(previous.quarter).toBeGreaterThan(current.quarter);
        continue;
      }
      if (previous.weight !== current.weight) {
        expect(previous.weight).toBeGreaterThan(current.weight);
        continue;
      }
      expect(previous.id.localeCompare(current.id)).toBeLessThan(0);
    }
  });

  it('merges all four tables into one list', () => {
    const state = recorded();
    // Give the quarter a story and a disclosure to merge alongside the rest.
    const record = projectPublicRecord(state, PLAYER_ID);
    const kinds = new Set(record.map((item) => item.kind));
    expect(kinds.has('event')).toBe(true);
    expect(kinds.has('post')).toBe(true);
    expect(kinds.has('disclosure')).toBe(true);
    expect(record.some((item) => item.kind === 'reply')).toBe(true);
    // A reply carries the thread link the feed groups on.
    const reply = record.find((item) => item.kind === 'reply');
    expect(reply?.links.replyToPostId).not.toBeNull();
  });

  it('leaves out what this seat may not see, and never carries a private fact', () => {
    const state = recorded();
    state.activeEvents = [
      ...state.activeEvents,
      { ...SAFETY_INCIDENT, id: 'wev_secret_orbit', visibility: 'private', affectedCompanyIds: ['cmp_orbit'], affectedSectorIds: [] },
      { ...SAFETY_INCIDENT, id: 'wev_other_sector', visibility: 'sector', affectedCompanyIds: [], affectedSectorIds: ['industrial_energy'] },
    ];

    const record = projectPublicRecord(state, PLAYER_ID);
    const ids = record.map((item) => item.id);
    expect(ids).not.toContain('wev_secret_orbit');
    expect(ids).not.toContain('wev_other_sector');
    expect(ids).toContain('wev_export_control');

    // `isTruthful` is canonical reality about a rumour and never leaves the engine.
    expect(JSON.stringify(record)).not.toContain('isTruthful');
  });

  it('shows a private event that names one of your own companies', () => {
    const state = recorded();
    state.activeEvents = [...state.activeEvents, { ...SAFETY_INCIDENT, id: 'wev_secret_nexus', visibility: 'private', affectedCompanyIds: ['cmp_nexus'] }];
    const record = projectPublicRecord(state, PLAYER_ID);
    expect(record.map((item) => item.id)).toContain('wev_secret_nexus');
  });

  it('says what an item did to you, in whole numbers, or says nothing', () => {
    const state = recorded();
    // A rival aims a post at the player's company.
    state.pendingActions = [];
    state.socialPosts = state.socialPosts.filter((post) => post.quarter !== 2);
    state.pendingActions = [
      makeAction({
        type: 'social_post',
        draft: {
          authorCharacterId: 'chr_tomas_lindqvist',
          network: 'fast_feed',
          text: 'Nexus has been quietly repricing enterprise seats while telling customers nothing has changed.',
          intent: 'attack',
          targetCompanyId: 'cmp_nexus',
        },
      }, { sequence: 4, quarter: 2, actorCompanyId: 'cmp_vector', actorCharacterId: 'chr_tomas_lindqvist', actionId: 'act_post_4' }),
    ];
    propagatePosts(state, makeContext(2).ctx);

    const record = projectPublicRecord(state, PLAYER_ID);
    const aimed = record.find((item) => item.kind === 'post' && item.who.characterId === 'chr_tomas_lindqvist');
    expect(aimed?.whyItMatters).toMatch(/^aimed at you: hostility \+\d+$/);

    // An item about somebody else says nothing, rather than inventing a stake.
    const elsewhere = record.find((item) => item.kind === 'event' && item.id === 'wev_export_control');
    expect(elsewhere?.whyItMatters).toBeNull();
  });

  it('reads a world event\'s consequence off the modifiers it carries', () => {
    const state = recorded();
    state.activeModifiers = [
      {
        id: 'mod_demand',
        source: 'event',
        target: 'company.cmp_nexus.demandMultiplier',
        operation: 'multiply',
        value: 0.94,
        decay: 'linear',
        durationQuarters: 2,
        remainingQuarters: 2,
        appliedAtQuarter: 1,
        originEventId: 'wev_export_control',
        reason: 'Export controls raised the cost of serving enterprise demand.',
        elapsedQuarters: 0,
        effectiveValue: 0.94,
        lastAppliedQuarter: 1,
        exhausted: false,
      },
    ];

    const record = projectPublicRecord(state, PLAYER_ID);
    const event = record.find((item) => item.id === 'wev_export_control');
    expect(event?.whyItMatters).toBe('your demand multiplier -6% this quarter');
  });

  it('attaches the ledger rows that explain an item when it is given a ledger', () => {
    const engine = createDefaultEngine();
    const opening = createWorld2Session();
    const outcome = engine.resolver.resolveQuarter(opening, [], null, []);
    expect(outcome.committed).toBe(true);

    const playerId = outcome.nextState.players[0]?.playerId ?? '';
    const withLedger = projectPublicRecord(outcome.nextState, playerId, { ledger: outcome.events });
    const withoutLedger = projectPublicRecord(outcome.nextState, playerId);

    expect(withLedger.length).toBe(withoutLedger.length);
    expect(withoutLedger.every((item) => item.ledgerEventIds.length === 0)).toBe(true);
    expect(withLedger.some((item) => item.ledgerEventIds.length > 0)).toBe(true);
    // Supplying a ledger adds citations; it never adds an item.
    expect(withLedger.map((item) => item.id)).toEqual(withoutLedger.map((item) => item.id));
  });
});
