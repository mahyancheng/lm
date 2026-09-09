/**
 * @frontier/simulation — the executive, and the grudge, in the deterministic
 * fallback.
 *
 * Why this suite exists: only a handful of rivals get a live model call in a
 * quarter, so `companies/npc.ts` — not the strategist prompt — is where most
 * rival behaviour comes from most of the time. If personality lived only in the
 * prompt, twenty-four rivals would still behave like one.
 *
 * What these assert:
 *
 * - a median executive changes nothing, so `effectivePolicy` remains the single
 *   definition of what an archetype does;
 * - no combination of traits, at any extreme, produces a policy outside the
 *   bounds the archetype and posture tables already run through;
 * - two companies identical but for who runs them submit measurably different
 *   actions — different price, different hiring, different budgets;
 * - a real grudge, written by the engine from a real event, changes the
 *   aggrieved company's behaviour toward the company that caused it: it
 *   undercuts them, bids against them, refuses to licence to them, and — where
 *   the person in the chair is the sort — raids them and answers in public;
 * - all of it is a pure function of committed state: the same state and the same
 *   seed queue byte-identical actions.
 */

import { describe, expect, it } from 'vitest';
import type { ActionIntent, Company, SessionState, StableTraits, StrategistMemory } from '@frontier/contracts';
import { ECONOMIC_NODES, economicNodeById } from '@frontier/contracts';
import {
  COMP_BAND_LADDER,
  EXECUTIVE_FACTOR_BOUNDS,
  NEUTRAL_EXECUTIVE_DIALS,
  effectivePolicy,
  executiveDials,
  personalisedPolicy,
  traitLean,
} from '../src/companies/archetypes';
import {
  GRUDGE_ACTION_THRESHOLD,
  GRUDGE_POACH_THRESHOLD,
  GRUDGE_POST_THRESHOLD,
  NODE_PRICE_LEAN_BOUND,
  applyNpcDefaults,
  actionableGrudges,
  bidTarget,
} from '../src/companies/npc';
import { executiveDialsFor, policyMarketingUsd } from '../src/companies/policy';
import { NPC_LICENCE_GRUDGE_REFUSAL, npcLicenceVerdict } from '../src/graph/licensing';

import { createDefaultEngine } from '../src/engine';
import { DEMO_CHARACTERS, DEMO_COMPANIES, createDemoSession } from '../src/scenario';
import { cloneState, companyOf, makeContext, makeState, sovereignOpportunity, civilOpportunity, makeBid } from './_institutionsHarness';

/* -------------------------------------------------------------------------- */
/*  Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

const TRAIT_KEYS = ['riskTolerance', 'technicalOrientation', 'financialConservatism', 'aggressiveness', 'statusSensitivity'] as const;

const MEDIAN: StableTraits = { riskTolerance: 50, technicalOrientation: 50, financialConservatism: 50, aggressiveness: 50, statusSensitivity: 50 };

/** A hard-charging chief executive: high appetite, high aggression, low caution. */
const RAIDER: StableTraits = { riskTolerance: 92, technicalOrientation: 55, financialConservatism: 8, aggressiveness: 95, statusSensitivity: 90 };

/** Their opposite: counts the cash, keeps quiet, escalates nothing. */
const ACCOUNTANT: StableTraits = { riskTolerance: 10, technicalOrientation: 45, financialConservatism: 94, aggressiveness: 6, statusSensitivity: 8 };

/** Every corner of the five-dimensional trait cube, for the bounds proof. */
function extremeTraits(): StableTraits[] {
  const out: StableTraits[] = [];
  for (let mask = 0; mask < 32; mask += 1) {
    const traits = { ...MEDIAN };
    TRAIT_KEYS.forEach((key, index) => {
      traits[key] = (mask & (1 << index)) === 0 ? 0 : 100;
    });
    out.push(traits);
  }
  return out;
}

const ARCHETYPES: readonly Company['archetype'][] = [
  'frontier_lab',
  'enterprise_ai',
  'consumer_ai',
  'infrastructure',
  'chip_maker',
  'cloud',
  'data',
  'defence_ai',
];

const POSTURES: readonly Company['posture'][] = [
  'aggressive_growth',
  'balanced',
  'efficiency',
  'research_first',
  'land_grab',
  'consolidation',
  'defensive',
  'survival',
];

/** Give a character a set of traits, in place. */
function setTraits(state: SessionState, characterId: string, traits: StableTraits): void {
  const character = state.characters.find((candidate) => candidate.id === characterId);
  if (character === undefined) throw new Error(`no such character: ${characterId}`);
  character.stableTraits = { ...traits };
}

/** A memory carrying one grudge, as `updateStrategistMemory` would have written it. */
function memoryWithGrudge(againstId: string, intensity: number, quarter: number): StrategistMemory {
  return {
    standingStrategy: 'An enterprise software company growing without breaking the margin.',
    standingStrategyQuarter: quarter,
    grudges: [{ companyId: againstId, reason: 'They came for two of our researchers with a 40% package.', quarter, intensity }],
    attempts: [],
  };
}

/** Give a character a live account, so a public answer is a thing they could actually post. */
function addAccount(state: SessionState, characterId: string, companyId: string, id: string): void {
  const template = state.socialAccounts[0];
  if (template === undefined) throw new Error('the harness has no social accounts');
  state.socialAccounts.push({ ...template, id, handle: `@${id}`, ownerCharacterId: characterId, ownerCompanyId: companyId });
}

/** Give a company a senior person who is not its chief executive. */
function addLieutenant(state: SessionState, companyId: string, characterId: string): void {
  const template = state.characters.find((candidate) => candidate.companyId === companyId);
  if (template === undefined) throw new Error(`no character at ${companyId}`);
  state.characters.push({
    ...template,
    id: characterId,
    name: 'Second Chair',
    role: 'executive',
    title: `CTO — ${companyId}`,
    connectionLevel: Math.max(1, template.connectionLevel - 10),
    isPlayer: false,
  });
}

/**
 * The demo world with two rivals made directable: everything in the
 * institutions harness is major tier, and `applyNpcDefaults` deliberately skips
 * majors because a major is meant to have a strategist.
 */
function npcWorld(): SessionState {
  const state = makeState();
  for (const id of ['cmp_orbit', 'cmp_helix', 'cmp_vector', 'cmp_meridian', 'cmp_aurora']) {
    companyOf(state, id).tier = 'significant';
  }
  return state;
}

/** Every action the archetype fallback queued for one company this quarter. */
function queuedFor(state: SessionState, companyId: string): ActionIntent[] {
  return state.pendingActions.filter((action) => action.actorCompanyId === companyId && action.origin === 'npc_default').map((action) => action.intent);
}

function priceOf(intents: readonly ActionIntent[]): number | null {
  for (const intent of intents) if (intent.type === 'set_product_price') return intent.pricePerSeatUsd;
  return null;
}

/* -------------------------------------------------------------------------- */
/*  1. A median executive changes nothing                                      */
/* -------------------------------------------------------------------------- */

describe('the executive dials', () => {
  it('are neutral for a median executive, and for a company with nobody in the chair', () => {
    expect(executiveDials(MEDIAN)).toEqual(NEUTRAL_EXECUTIVE_DIALS);
    expect(executiveDials(null)).toEqual(NEUTRAL_EXECUTIVE_DIALS);
    expect(traitLean(50)).toBe(0);
  });

  it('leave every archetype and posture policy exactly as the tables write it', () => {
    for (const archetype of ARCHETYPES) {
      for (const posture of POSTURES) {
        const policy = effectivePolicy(archetype, posture);
        expect(personalisedPolicy(policy, NEUTRAL_EXECUTIVE_DIALS)).toEqual(policy);
      }
    }
  });

  it('stay inside the archetype tables\' own bounds at every corner of the trait cube', () => {
    for (const traits of extremeTraits()) {
      const dials = executiveDials(traits);
      for (const factor of [dials.marketingFactor, dials.rdFactor, dials.headcountFactor, dials.capacityCashFactor]) {
        expect(factor).toBeGreaterThanOrEqual(EXECUTIVE_FACTOR_BOUNDS.min);
        expect(factor).toBeLessThanOrEqual(EXECUTIVE_FACTOR_BOUNDS.max);
      }
      expect(Math.abs(dials.compBandSteps)).toBeLessThanOrEqual(1);

      for (const archetype of ARCHETYPES) {
        for (const posture of POSTURES) {
          const policy = personalisedPolicy(effectivePolicy(archetype, posture), dials);
          expect(policy.marketingRevenueShare).toBeGreaterThanOrEqual(0);
          expect(policy.rdRevenueShare).toBeGreaterThanOrEqual(0);
          expect(policy.trainingAllocation).toBeGreaterThanOrEqual(0);
          expect(policy.trainingAllocation).toBeLessThanOrEqual(1);
          expect(policy.governmentAppetite).toBeGreaterThanOrEqual(0);
          expect(policy.governmentAppetite).toBeLessThanOrEqual(1);
          expect(COMP_BAND_LADDER).toContain(policy.compBand);
          // A posture that is cutting still cuts, whoever is in the chair: the
          // executive scales the table's own number and never flips its sign.
          expect(Math.sign(policy.headcountGrowthPerQuarter)).toBe(Math.sign(effectivePolicy(archetype, posture).headcountGrowthPerQuarter));
        }
      }
    }
  });

  it('point each trait the way the coefficients say', () => {
    const raider = executiveDials(RAIDER);
    const accountant = executiveDials(ACCOUNTANT);

    // Aggression prices nearer the floor, hires ahead of demand and wants more
    // public work; caution does the opposite on every one of them.
    expect(raider.pricingNudge).toBeLessThan(accountant.pricingNudge);
    expect(raider.headcountFactor).toBeGreaterThan(accountant.headcountFactor);
    expect(raider.governmentAppetiteDelta).toBeGreaterThan(accountant.governmentAppetiteDelta);
    expect(raider.capacityCashFactor).toBeGreaterThan(accountant.capacityCashFactor);
    expect(raider.compBandSteps).toBeGreaterThan(accountant.compBandSteps);
    // An aggressive bidder leaves margin on the table to win; a cautious one
    // refuses to.
    expect(raider.bidPriceShareDelta).toBeLessThan(accountant.bidPriceShareDelta);

    // A technical executive funds research over marketing.
    const technical = executiveDials({ ...MEDIAN, technicalOrientation: 100 });
    expect(technical.rdFactor).toBeGreaterThan(1);
    expect(technical.marketingFactor).toBeLessThan(1);
    expect(technical.trainingAllocationDelta).toBeGreaterThan(0);

    // A status-sensitive one spends on being seen.
    expect(executiveDials({ ...MEDIAN, statusSensitivity: 100 }).marketingFactor).toBeGreaterThan(1);
  });

  it('are neutral for a company somebody is playing', () => {
    const state = npcWorld();
    setTraits(state, 'chr_maya_chen', RAIDER);
    // Nexus is the player's; Orbit is not.
    expect(executiveDialsFor(state, companyOf(state, 'cmp_nexus'))).toEqual(NEUTRAL_EXECUTIVE_DIALS);
    expect(executiveDialsFor(state, companyOf(state, 'cmp_orbit'))).not.toEqual(NEUTRAL_EXECUTIVE_DIALS);
  });

  it('move the derived budget a major with no strategist falls back to', () => {
    const state = npcWorld();
    const orbit = companyOf(state, 'cmp_orbit');
    const bold = policyMarketingUsd(orbit, executiveDials({ ...MEDIAN, statusSensitivity: 100 }));
    const thrifty = policyMarketingUsd(orbit, executiveDials({ ...MEDIAN, financialConservatism: 100 }));
    expect(bold).toBeGreaterThan(policyMarketingUsd(orbit));
    expect(thrifty).toBeLessThan(policyMarketingUsd(orbit));
  });
});

/* -------------------------------------------------------------------------- */
/*  2. Two rivals, opposite executives, different behaviour                    */
/* -------------------------------------------------------------------------- */

describe('the archetype fallback in the executive\'s hands', () => {
  it('diverges measurably between two identical companies with opposite executives', () => {
    const bold = npcWorld();
    const timid = cloneState(bold);
    setTraits(bold, 'chr_daniel_okonkwo', RAIDER);
    setTraits(timid, 'chr_daniel_okonkwo', ACCOUNTANT);

    applyNpcDefaults(bold, makeContext(1, '424242').ctx);
    applyNpcDefaults(timid, makeContext(1, '424242').ctx);

    const boldIntents = queuedFor(bold, 'cmp_orbit');
    const timidIntents = queuedFor(timid, 'cmp_orbit');

    const marketing = (intents: readonly ActionIntent[]): number => {
      for (const intent of intents) {
        if (intent.type === 'set_marketing_budget') return intent.allocations.reduce((sum, row) => sum + row.budgetUsd, 0);
      }
      return 0;
    };
    const hires = (intents: readonly ActionIntent[]): number => {
      for (const intent of intents) if (intent.type === 'hire') return intent.count;
      return 0;
    };

    // The company is the same company: same archetype, same posture, same books.
    expect(companyOf(bold, 'cmp_orbit').archetype).toBe(companyOf(timid, 'cmp_orbit').archetype);
    expect(marketing(boldIntents)).toBeGreaterThan(marketing(timidIntents));
    expect(hires(boldIntents)).toBeGreaterThan(hires(timidIntents));
    expect(priceOf(boldIntents) ?? Infinity).toBeLessThan(priceOf(timidIntents) ?? 0);
  });

  it('queues byte-identical actions for the same state and the same seed', () => {
    const a = npcWorld();
    const b = cloneState(a);
    setTraits(a, 'chr_daniel_okonkwo', RAIDER);
    setTraits(b, 'chr_daniel_okonkwo', RAIDER);
    applyNpcDefaults(a, makeContext(1, '424242').ctx);
    applyNpcDefaults(b, makeContext(1, '424242').ctx);
    expect(JSON.stringify(b.pendingActions)).toBe(JSON.stringify(a.pendingActions));
  });
});

/* -------------------------------------------------------------------------- */
/*  3. Grudges bite in the fallback                                            */
/* -------------------------------------------------------------------------- */

describe('a company carrying a grudge', () => {
  it('acts only on a grudge worth acting on', () => {
    const state = npcWorld();
    const orbit = companyOf(state, 'cmp_orbit');
    orbit.strategistMemory = memoryWithGrudge('cmp_helix', GRUDGE_ACTION_THRESHOLD - 1, 1);
    expect(actionableGrudges(orbit)).toHaveLength(0);
    orbit.strategistMemory = memoryWithGrudge('cmp_helix', GRUDGE_ACTION_THRESHOLD, 1);
    expect(actionableGrudges(orbit).map((grudge) => grudge.companyId)).toEqual(['cmp_helix']);
  });

  it('undercuts the company that wronged it, and only in the segment they share', () => {
    const plain = npcWorld();
    const aggrieved = cloneState(plain);
    // Both companies sell into `enterprise`, which is the harness default.
    companyOf(aggrieved, 'cmp_orbit').strategistMemory = memoryWithGrudge('cmp_helix', 80, 1);

    applyNpcDefaults(plain, makeContext(2, '424242').ctx);
    applyNpcDefaults(aggrieved, makeContext(2, '424242').ctx);

    const plainPrice = priceOf(queuedFor(plain, 'cmp_orbit'));
    const aggrievedPrice = priceOf(queuedFor(aggrieved, 'cmp_orbit'));
    expect(plainPrice).not.toBeNull();
    expect(aggrievedPrice ?? Infinity).toBeLessThan(plainPrice ?? 0);

    // Move the offender out of the segment and the cut goes with them: a
    // discount on a line they do not sell is a gift, not a reprisal.
    const elsewhere = cloneState(plain);
    companyOf(elsewhere, 'cmp_orbit').strategistMemory = memoryWithGrudge('cmp_helix', 80, 1);
    for (const product of companyOf(elsewhere, 'cmp_helix').products) product.segment = 'government';
    applyNpcDefaults(elsewhere, makeContext(2, '424242').ctx);
    expect(priceOf(queuedFor(elsewhere, 'cmp_orbit'))).toBe(plainPrice);
  });

  it('prefers the competition the offender is already bidding on', () => {
    const state = npcWorld();
    const orbit = companyOf(state, 'cmp_orbit');
    // The bigger programme, which the plain ranking would take.
    const big = sovereignOpportunity({ id: 'opp_big', maxValue: 900_000_000, closeQuarter: 8 });
    const small = civilOpportunity({ id: 'opp_small', maxValue: 100_000_000, closeQuarter: 8 });
    state.procurementOpportunities = [big, small];
    state.governmentBids = [makeBid({ id: 'bid_helix', bidderCompanyId: 'cmp_helix', opportunityId: 'opp_small' })];
    const ctx = makeContext(1, '424242').ctx;

    expect(bidTarget(state, ctx, orbit)?.id).toBe('opp_big');
    expect(bidTarget(state, ctx, orbit, new Set(['cmp_helix']))?.id).toBe('opp_small');
  });

  it('raids the offender\'s people when the injury is fresh and the executive is aggressive', () => {
    const state = npcWorld();
    setTraits(state, 'chr_daniel_okonkwo', RAIDER);
    addLieutenant(state, 'cmp_helix', 'chr_helix_cto');
    // Written in quarter 1's phase 16; this is quarter 2's phase 4.
    companyOf(state, 'cmp_orbit').strategistMemory = memoryWithGrudge('cmp_helix', GRUDGE_POACH_THRESHOLD, 1);
    applyNpcDefaults(state, makeContext(2, '424242').ctx);

    const raid = queuedFor(state, 'cmp_orbit').find((intent) => intent.type === 'poach_executive');
    expect(raid).toBeDefined();
    if (raid?.type === 'poach_executive') expect(raid.targetCharacterId).toBe('chr_helix_cto');

    // A cautious executive with the same grudge does not raid.
    const calm = npcWorld();
    setTraits(calm, 'chr_daniel_okonkwo', ACCOUNTANT);
    addLieutenant(calm, 'cmp_helix', 'chr_helix_cto');
    companyOf(calm, 'cmp_orbit').strategistMemory = memoryWithGrudge('cmp_helix', GRUDGE_POACH_THRESHOLD, 1);
    applyNpcDefaults(calm, makeContext(2, '424242').ctx);
    expect(queuedFor(calm, 'cmp_orbit').some((intent) => intent.type === 'poach_executive')).toBe(false);
  });

  it('says nothing in public when the executive has no account anywhere', () => {
    // Checked in the fallback rather than left to the validator: an approach
    // that could only ever be refused is not an approach.
    const state = npcWorld();
    setTraits(state, 'chr_daniel_okonkwo', RAIDER);
    companyOf(state, 'cmp_orbit').strategistMemory = memoryWithGrudge('cmp_helix', 100, 1);
    applyNpcDefaults(state, makeContext(2, '424242').ctx);
    expect(queuedFor(state, 'cmp_orbit').some((intent) => intent.type === 'social_post')).toBe(false);
  });

  it('never raids the other side\'s sitting chief executive', () => {
    // Nothing in the engine refills a background rival's empty chair, so a
    // successful decapitation would delete that company's personality for good.
    const state = npcWorld();
    setTraits(state, 'chr_daniel_okonkwo', RAIDER);
    companyOf(state, 'cmp_orbit').strategistMemory = memoryWithGrudge('cmp_helix', 100, 1);
    applyNpcDefaults(state, makeContext(2, '424242').ctx);
    expect(queuedFor(state, 'cmp_orbit').some((intent) => intent.type === 'poach_executive')).toBe(false);
  });

  it('answers a fresh slight in public when the executive is status-sensitive, once', () => {
    const state = npcWorld();
    setTraits(state, 'chr_daniel_okonkwo', RAIDER);
    addAccount(state, 'chr_daniel_okonkwo', 'cmp_orbit', 'soc_daniel_fastfeed');
    companyOf(state, 'cmp_orbit').strategistMemory = memoryWithGrudge('cmp_helix', GRUDGE_POST_THRESHOLD, 1);
    applyNpcDefaults(state, makeContext(2, '424242').ctx);

    const posts = queuedFor(state, 'cmp_orbit').filter((intent) => intent.type === 'social_post');
    expect(posts).toHaveLength(1);
    const post = posts[0];
    if (post?.type === 'social_post') {
      expect(post.draft.targetCompanyId).toBe('cmp_helix');
      expect(post.draft.intent).toBe('attack');
      expect(post.draft.authorCharacterId).toBe('chr_daniel_okonkwo');
      // The words are the engine's own record of what happened.
      expect(post.draft.text).toContain('40% package');
    }
  });

  it('does not relitigate a stale grudge with a raid or a post every quarter', () => {
    const state = npcWorld();
    setTraits(state, 'chr_daniel_okonkwo', RAIDER);
    addAccount(state, 'chr_daniel_okonkwo', 'cmp_orbit', 'soc_daniel_fastfeed');
    // Reinforced in quarter 1; this is quarter 6.
    companyOf(state, 'cmp_orbit').strategistMemory = memoryWithGrudge('cmp_helix', 90, 1);
    applyNpcDefaults(state, makeContext(6, '424242').ctx);

    const intents = queuedFor(state, 'cmp_orbit');
    expect(intents.some((intent) => intent.type === 'poach_executive')).toBe(false);
    expect(intents.some((intent) => intent.type === 'social_post')).toBe(false);
    // The standing consequences do not lapse: it still undercuts them.
    const plain = npcWorld();
    setTraits(plain, 'chr_daniel_okonkwo', RAIDER);
    applyNpcDefaults(plain, makeContext(6, '424242').ctx);
    expect(priceOf(intents) ?? Infinity).toBeLessThan(priceOf(queuedFor(plain, 'cmp_orbit')) ?? 0);
  });

  it('refuses to licence its technology to the company it holds the grudge against', () => {
    const state = npcWorld();
    const owner = companyOf(state, 'cmp_orbit');
    const licensee = companyOf(state, 'cmp_helix');
    const node = economicNodeById('res_silicon_feedstock') ?? ECONOMIC_NODES[0];
    expect(node).toBeDefined();
    if (node === undefined) return;

    // A royalty generous enough that the ordinary rules would take it.
    const generous = 40;
    expect(npcLicenceVerdict(owner, licensee, node, generous, 0).accepted).toBe(true);
    expect(npcLicenceVerdict(owner, licensee, node, generous, NPC_LICENCE_GRUDGE_REFUSAL - 1).accepted).toBe(true);
    const refused = npcLicenceVerdict(owner, licensee, node, generous, NPC_LICENCE_GRUDGE_REFUSAL);
    expect(refused.accepted).toBe(false);
    expect(refused.reason).toContain(licensee.name);
  });
});

/* -------------------------------------------------------------------------- */
/*  4. The node economy keeps its one anchor                                   */
/* -------------------------------------------------------------------------- */

describe('the node-economy price lean', () => {
  it('is bounded tightly enough that a line still converges on its node market', () => {
    // The whole point of the bound: a personality is a position against the
    // market a line's own inputs are rolled up at, never a replacement for it.
    expect(NODE_PRICE_LEAN_BOUND).toBeGreaterThan(0);
    expect(NODE_PRICE_LEAN_BOUND).toBeLessThan(0.1);
  });
});

/* -------------------------------------------------------------------------- */
/*  5. Two engine faults this behaviour exposed                                */
/* -------------------------------------------------------------------------- */

/**
 * Both of these were latent before an archetype default could poach or post:
 * they needed a company that does either without a player or a model asking.
 * They are tested here, next to the behaviour that exposed them, rather than
 * split across two suites that would each own half the story.
 */
describe('faults the archetype fallback exposed', () => {
  /** A demo session with one extra senior person at Helix, so a raid has a target who is not the chair. */
  function demoWithLieutenant(): SessionState {
    const state = createDemoSession();
    const priya = state.characters.find((candidate) => candidate.id === DEMO_CHARACTERS.priya)!;
    state.characters.push({ ...priya, id: 'chr_helix_second', name: 'Second Chair', role: 'executive', title: 'CTO — Helix Systems', isPlayer: false });
    return state;
  }

  function submitted(state: SessionState, intent: ActionIntent, companyId: string, characterId: string) {
    return [
      {
        actionId: `act_test_${intent.type}`,
        sessionId: state.sessionId,
        quarter: state.quarter,
        sequence: 0,
        actorPlayerId: null,
        actorCompanyId: companyId,
        actorCharacterId: characterId,
        origin: 'player_ui' as const,
        intent,
        confirmedByHuman: true,
      },
    ];
  }

  it('publishes one post per social_post action, not two', () => {
    // `ensureSocialPosts` (resolver/routing.ts) and `ingestPostActions`
    // (social/reach.ts) both run every quarter and both publish submitted
    // posts. They minted different ids for the same action, so neither saw the
    // other's row and every post was published — and its reach, sentiment and
    // controversy counted — twice.
    const state = createDemoSession();
    const text = 'A single post, published once.';
    const actions = submitted(
      state,
      {
        type: 'social_post',
        draft: { authorCharacterId: DEMO_CHARACTERS.maya, network: 'fast_feed', text, intent: 'announce', targetCompanyId: null },
      },
      DEMO_COMPANIES.nexus,
      DEMO_CHARACTERS.maya,
    );
    const next = createDefaultEngine().resolver.resolveQuarter(state, actions, null, []).nextState;
    expect(next.socialPosts.filter((post) => post.text === text)).toHaveLength(1);
  });

  it('lets an employer remember the raid that worked, not only the one that failed', () => {
    // `reactToPoach` reads the target's employer in phase 15, by which point a
    // successful raid has already moved them to the raider — so it saw the
    // raider as the employer and stored nothing at all. Its own comment says
    // the employer remembers it either way; the talent phase now writes the
    // half it could see and reactToPoach could not.
    const state = demoWithLieutenant();
    const actions = submitted(
      state,
      { type: 'poach_executive', targetCharacterId: 'chr_helix_second', compPremiumPct: 1.5, approach: 'public' },
      DEMO_COMPANIES.orbit,
      DEMO_CHARACTERS.daniel,
    );
    const next = createDefaultEngine().resolver.resolveQuarter(state, actions, null, []).nextState;

    const succeeded = next.characters.find((c) => c.id === 'chr_helix_second')?.companyId === DEMO_COMPANIES.orbit;
    const remembered = next.memories.filter(
      (memory) => memory.ownerCharacterId === DEMO_CHARACTERS.priya && memory.kind === 'poach' && memory.aboutId === DEMO_COMPANIES.orbit && memory.quarter === state.quarter,
    );
    // Either way, and exactly once: the two writers never both fire, because
    // reactToPoach's own guard excludes the case the talent phase handles.
    expect(remembered).toHaveLength(1);
    expect(remembered[0]!.sentiment).toBeLessThan(0);
    if (succeeded) expect(remembered[0]!.summary).toContain('took');
  });
});
