/**
 * @frontier/simulation — social subsystem tests.
 *
 * The rule under test is the one the module exists for: an LLM writes the post,
 * the engine decides what it does. Nothing here asserts a sentiment number that
 * a model supplied, because a model cannot supply one.
 *
 * What these assert:
 * - reach scales with the author's standing, not with the prose;
 * - every sentiment consequence is inside the schema's bounds and inside the
 *   engine's own per-post reputation ceiling;
 * - a rumour reaches the market as a `PublicDisclosure` carrying a credibility
 *   figure, and never as a fact: beliefs are untouched, canonical company state
 *   is untouched, and `isTruthful` never appears in a ledger payload;
 * - the press picks things up, stories decay, and the narrative moves only on
 *   the weight of coverage.
 */

import { describe, expect, it } from 'vitest';
import type { SessionState, SocialPostDraft, WorldEvent } from '@frontier/contracts';
import {
  MAX_REPUTATION_MOVE,
  STORY_FLOOR,
  ageStories,
  computeSentimentShifts,
  createSocialSubsystem,
  ensureAccount,
  propagatePosts,
  updateMediaStories,
} from '../src/social/index';
import { cloneState, companyOf, eventsOfType, makeAction, makeContext, makeState } from './_institutionsHarness';

/* -------------------------------------------------------------------------- */
/*  Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

function postAction(draft: SocialPostDraft, sequence = 0, actorCompanyId = 'cmp_nexus') {
  return makeAction({ type: 'social_post', draft }, {
    sequence,
    actorCompanyId,
    actorCharacterId: draft.authorCharacterId,
    actionId: `act_post_${sequence}`,
  });
}

const MAYA_ANNOUNCE: SocialPostDraft = {
  authorCharacterId: 'chr_maya_chen',
  network: 'fast_feed',
  text: 'Our next reasoning system trains on domestic infrastructure from day one. Evaluations first, launch second.',
  intent: 'announce',
  targetCompanyId: null,
};

const TOMAS_ANNOUNCE: SocialPostDraft = {
  authorCharacterId: 'chr_tomas_lindqvist',
  network: 'fast_feed',
  text: 'We shipped retrieval v4 to every enterprise customer this quarter. Quietly, on time, without a keynote.',
  intent: 'announce',
  targetCompanyId: null,
};

const MAYA_ATTACK: SocialPostDraft = {
  authorCharacterId: 'chr_maya_chen',
  network: 'fast_feed',
  text: 'Orbit sells deployment speed because it has nothing else to sell. Ask them what their model actually scores.',
  intent: 'attack',
  targetCompanyId: 'cmp_orbit',
};

const MAYA_LEAK: SocialPostDraft = {
  authorCharacterId: 'chr_maya_chen',
  network: 'fast_feed',
  text: 'Word going around is that the VectorWorks flagship slipped two quarters and the board has not been told.',
  intent: 'leak',
  targetCompanyId: 'cmp_vector',
};

function withPosts(drafts: readonly SocialPostDraft[]): SessionState {
  const state = makeState();
  state.pendingActions = drafts.map((draft, index) => postAction(draft, index, draft.authorCharacterId === 'chr_maya_chen' ? 'cmp_nexus' : 'cmp_vector'));
  return state;
}

/* -------------------------------------------------------------------------- */
/*  Reach                                                                      */
/* -------------------------------------------------------------------------- */

describe('post propagation', () => {
  it('scales reach with standing rather than with the prose', () => {
    const quiet = withPosts([TOMAS_ANNOUNCE]);
    const quietResult = propagatePosts(quiet, makeContext(1).ctx)[0];

    const loud = withPosts([MAYA_ANNOUNCE]);
    const loudResult = propagatePosts(loud, makeContext(1).ctx)[0];

    expect(quietResult).toBeDefined();
    expect(loudResult).toBeDefined();
    // Same network, same intent, same quarter: the difference is who said it.
    expect(loudResult?.reach ?? 0).toBeGreaterThan((quietResult?.reach ?? 0) * 5);

    // Connection level alone moves it: promote the same author and re-run.
    const promoted = withPosts([TOMAS_ANNOUNCE]);
    const tomas = promoted.characters.find((c) => c.id === 'chr_tomas_lindqvist');
    if (tomas === undefined) throw new Error('missing character');
    tomas.connectionLevel = 95;
    const promotedResult = propagatePosts(promoted, makeContext(1).ctx)[0];
    expect(promotedResult?.reach ?? 0).toBeGreaterThan(quietResult?.reach ?? 0);
  });

  it('loses reach to fatigue when the same person posts repeatedly', () => {
    const once = withPosts([MAYA_ANNOUNCE]);
    const first = propagatePosts(once, makeContext(1).ctx)[0];

    const thrice = withPosts([MAYA_ANNOUNCE, { ...MAYA_ANNOUNCE, text: 'A second thought on the same subject.' }, { ...MAYA_ANNOUNCE, text: 'And a third.' }]);
    const results = propagatePosts(thrice, makeContext(1).ctx);
    expect(results.length).toBe(3);
    const last = results[2];
    expect(last?.reach ?? 0).toBeLessThan(first?.reach ?? 0);
  });

  it('bounds every sentiment consequence and every reputation move', () => {
    const state = withPosts([MAYA_ANNOUNCE, MAYA_ATTACK, MAYA_LEAK]);
    const before = { ...companyOf(state, 'cmp_nexus').reputation };

    const harness = makeContext(1);
    const results = propagatePosts(state, harness.ctx);

    for (const result of results) {
      expect(result.reach).toBeGreaterThanOrEqual(0);
      expect(result.engagementScore).toBeGreaterThanOrEqual(0);
      expect(result.engagementScore).toBeLessThanOrEqual(1);
      expect(result.viralityFactor).toBeGreaterThanOrEqual(0);
      expect(result.viralityFactor).toBeLessThanOrEqual(10);
      expect(result.competitorHostilityDelta).toBeGreaterThanOrEqual(-20);
      expect(result.competitorHostilityDelta).toBeLessThanOrEqual(20);
      for (const shift of result.sentimentShifts) {
        expect(shift.delta).toBeGreaterThanOrEqual(-20);
        expect(shift.delta).toBeLessThanOrEqual(20);
      }
    }

    const after = companyOf(state, 'cmp_nexus').reputation;
    for (const field of ['public', 'developer', 'enterprise', 'government', 'investor'] as const) {
      expect(after[field]).toBeGreaterThanOrEqual(0);
      expect(after[field]).toBeLessThanOrEqual(100);
      // Three posts, each capped: no single quarter can rewrite a reputation.
      expect(Math.abs(after[field] - before[field])).toBeLessThanOrEqual(MAX_REPUTATION_MOVE * 3 + 1e-9);
    }

    const shifts = eventsOfType(harness, 'sentiment_shifted');
    expect(shifts.length).toBeGreaterThan(0);
    for (const line of harness.lines) expect(line.refEventIds?.length ?? 0).toBeGreaterThan(0);
  });

  it('exposes only the audiences an account actually reaches', () => {
    const state = makeState();
    const account = ensureAccount(state, 'chr_maya_chen', 'fast_feed');
    if (account === null) throw new Error('missing account');
    const post = {
      ...MAYA_ANNOUNCE,
      id: 'pst_x',
      accountId: account.id,
      quarter: 1,
      engagement: null,
      isAiGenerated: false,
      reportedCount: 0,
      replyToPostId: null,
    };
    const shifts = computeSentimentShifts(post, account, 2_000_000);
    expect(shifts.length).toBeGreaterThan(0);
    for (const shift of shifts) {
      expect(Math.abs(shift.delta)).toBeLessThanOrEqual(20);
    }
    // An announcement lifts developers, which is where the intent points.
    expect(shifts.find((s) => s.audience === 'developers')?.delta ?? 0).toBeGreaterThan(0);
  });

  it('makes an attack cost the relationship with the company attacked', () => {
    const state = withPosts([MAYA_ATTACK]);
    const harness = makeContext(1);
    const [result] = propagatePosts(state, harness.ctx);

    expect(result?.competitorHostilityDelta ?? 0).toBeGreaterThan(0);
    const memory = state.memories.find((m) => m.kind === 'public_attack');
    expect(memory).toBeDefined();
    expect(memory?.ownerCharacterId).toBe('chr_daniel_okonkwo');
    expect(memory?.aboutId).toBe('chr_maya_chen');
    expect(memory?.sentiment ?? 0).toBeLessThan(0);

    // The controversy cycle warms, within its ceiling.
    expect(state.world.media.controversyIntensity).toBeGreaterThan(makeState().world.media.controversyIntensity);
    expect(state.world.media.controversyIntensity).toBeLessThanOrEqual(1);
  });
});

/* -------------------------------------------------------------------------- */
/*  The information boundary                                                   */
/* -------------------------------------------------------------------------- */

describe('the public-information bridge', () => {
  it('turns a rumour into a credibility-weighted disclosure and never into a fact', () => {
    const state = withPosts([MAYA_LEAK]);
    const truthBefore = JSON.stringify(companyOf(state, 'cmp_vector'));
    const beliefsBefore = JSON.stringify(state.beliefs);

    const harness = makeContext(1);
    propagatePosts(state, harness.ctx);

    const disclosure = state.disclosures.find((d) => d.kind === 'leak');
    expect(disclosure).toBeDefined();
    expect(disclosure?.companyId).toBe('cmp_vector');
    expect(disclosure?.beliefTopic).toBe('model_delay');
    expect(disclosure?.credibility ?? 1).toBeGreaterThan(0);
    // A leak lands with far less weight than a company statement.
    expect(disclosure?.credibility ?? 1).toBeLessThan(0.6);
    expect(disclosure?.sourceCharacterId).toBeNull();

    // The market has not moved: that is the market phase's job, next.
    expect(JSON.stringify(state.beliefs)).toBe(beliefsBefore);
    // And canonical truth about the subject is exactly as it was.
    expect(JSON.stringify(companyOf(state, 'cmp_vector'))).toBe(truthBefore);

    const rumours = eventsOfType(harness, 'rumour_spread');
    expect(rumours.length).toBe(1);
    expect(rumours[0]?.visibility).toBe('public');
    // INTERNAL ONLY means internal: it is not in the ledger.
    for (const event of harness.events) {
      expect(Object.keys(event.payload)).not.toContain('isTruthful');
    }
  });

  it('publishes a company statement with the credibility of the account behind it', () => {
    const state = withPosts([MAYA_ANNOUNCE]);
    propagatePosts(state, makeContext(1).ctx);
    const disclosure = state.disclosures.find((d) => d.kind === 'press_release');
    expect(disclosure).toBeDefined();
    expect(disclosure?.sourceCharacterId).toBe('chr_maya_chen');
    expect(disclosure?.companyId).toBe('cmp_nexus');
    expect(disclosure?.credibility ?? 0).toBeGreaterThan(0.1);
  });

  it('writes no disclosure for a post that asserts nothing', () => {
    const state = withPosts([{ ...MAYA_ANNOUNCE, intent: 'recruit', text: 'We are hiring inference engineers. Bring your own opinions about kernels.' }]);
    propagatePosts(state, makeContext(1).ctx);
    expect(state.disclosures.length).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/*  The press                                                                  */
/* -------------------------------------------------------------------------- */

describe('media stories', () => {
  it('picks up a loud post and a severe public event', () => {
    const state = withPosts([MAYA_LEAK]);
    state.world.media.attentionLevel = 0.95;
    state.world.media.controversyIntensity = 0.9;
    const event: WorldEvent = {
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
      affectedSectorIds: ['semiconductors'],
      affectedCompanyIds: ['cmp_aurora'],
    };
    state.activeEvents = [event];

    const harness = makeContext(1);
    const social = createSocialSubsystem();
    social.propagatePosts(state, harness.ctx);
    social.updateMediaStories(state, harness.ctx);

    const fromEvent = state.mediaStories.find((s) => s.sourceEventId === 'wev_export_control');
    expect(fromEvent).toBeDefined();
    expect(fromEvent?.angle).toBe('geopolitical');
    expect(fromEvent?.subjectCompanyIds).toContain('cmp_aurora');

    const fromPost = state.mediaStories.find((s) => s.sourcePostIds.length > 0);
    expect(fromPost).toBeDefined();
    expect(fromPost?.angle).toBe('scandal');
    expect(fromPost?.credibility ?? 1).toBeLessThan(1);

    const published = eventsOfType(harness, 'media_story_published');
    expect(published.length).toBe(state.mediaStories.length);
    for (const story of state.mediaStories) {
      expect(story.headline.length).toBeGreaterThanOrEqual(5);
      expect(story.headline.length).toBeLessThanOrEqual(160);
      expect(story.prominence).toBeGreaterThanOrEqual(0);
      expect(story.prominence).toBeLessThanOrEqual(1);
    }
  });

  it('lets a story fall out of the cycle', () => {
    const state = makeState();
    state.mediaStories = [
      {
        id: 'sty_old',
        quarter: 0,
        headline: 'A story from last quarter',
        body: 'It mattered once.',
        angle: 'competitive',
        prominence: 0.08,
        subjectCompanyIds: ['cmp_nexus'],
        subjectCharacterIds: [],
        sourcePostIds: [],
        sourceEventId: null,
        credibility: 0.5,
        sentiment: 0,
        reach: 1_000_000,
        authorCharacterId: null,
      },
    ];
    ageStories(state, 1);
    expect(state.mediaStories.length).toBe(0);
    expect(STORY_FLOOR).toBeGreaterThan(0);
  });

  it('turns the narrative only on the weight of coverage', () => {
    const state = makeState();
    state.world.media.dominantNarrative = 'ai_optimism';
    state.mediaStories = Array.from({ length: 4 }, (_, i) => ({
      id: `sty_scandal_${i}`,
      quarter: 1,
      headline: `An unfolding scandal, part ${i + 1}`,
      body: 'The reporting continued.',
      angle: 'scandal' as const,
      prominence: 0.8,
      subjectCompanyIds: ['cmp_nexus'],
      subjectCharacterIds: [],
      sourcePostIds: [],
      sourceEventId: null,
      credibility: 0.7,
      sentiment: -0.6,
      reach: 8_000_000,
      authorCharacterId: 'chr_hana_kim',
    }));

    const harness = makeContext(1);
    updateMediaStories(state, harness.ctx);
    expect(state.world.media.dominantNarrative).toBe('scandal_cycle');
    expect(state.world.media.attentionLevel).toBeGreaterThan(makeState().world.media.attentionLevel);
    expect(state.world.media.institutionalTrust).toBeLessThan(makeState().world.media.institutionalTrust);

    const shifts = eventsOfType(harness, 'sentiment_shifted');
    expect(shifts.some((e) => e.payload.kind === 'media_narrative')).toBe(true);
    expect(harness.lines.some((l) => l.text.includes('narrative turned'))).toBe(true);
  });

  it('leaves a quiet quarter alone', () => {
    const state = makeState();
    const narrativeBefore = state.world.media.dominantNarrative;
    updateMediaStories(state, makeContext(1).ctx);
    expect(state.world.media.dominantNarrative).toBe(narrativeBefore);
    expect(state.mediaStories.length).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/*  Determinism                                                                */
/* -------------------------------------------------------------------------- */

describe('determinism', () => {
  it('resolves the phase identically from an identical state', () => {
    const build = (): SessionState => withPosts([MAYA_ANNOUNCE, MAYA_ATTACK, MAYA_LEAK]);
    const run = (state: SessionState) => {
      const harness = makeContext(1);
      const social = createSocialSubsystem();
      const results = social.propagatePosts(state, harness.ctx);
      social.updateMediaStories(state, harness.ctx);
      return { state, results, events: harness.events, lines: harness.lines };
    };

    const first = run(build());
    const second = run(cloneState(build()));
    expect(JSON.stringify(second.results)).toBe(JSON.stringify(first.results));
    expect(JSON.stringify(second.events)).toBe(JSON.stringify(first.events));
    expect(JSON.stringify(second.state.mediaStories)).toBe(JSON.stringify(first.state.mediaStories));
    expect(JSON.stringify(second.state.disclosures)).toBe(JSON.stringify(first.state.disclosures));
    expect(JSON.stringify(second.lines)).toBe(JSON.stringify(first.lines));
  });
});
