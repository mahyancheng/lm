/**
 * What the Network screen can actually offer, checked against the engine.
 *
 * The bug these tests were written for: the screen and the validator held two
 * different reachability oracles. `buildDirectory` asked `checkAccess`, which
 * honours the *structural* overrides — a shared board, a common investor on two
 * cap tables, a consortium, a live deal — and the validator asked `canReach`,
 * which restated the gap rule and read only the stored overrides. In the world
 * that actually ships, world 2, that disagreement was total:
 *
 * - 0 of 42 people were inside the connection gap,
 * - 31 were reachable *only* through a structural override, and the drawer
 *   offered them nothing at all because the introduction form is drawn for
 *   blocked people,
 * - the remaining 11 were blocked with a broker — and every broker was one of
 *   those 31, so `request_introduction` was rejected `target_not_reachable`
 *   before it left the browser.
 *
 * Zero queueable actions on the whole screen. So the assertions here are not
 * "the helper returns a list": they run the real validator over the real
 * world-2 session and insist that what the screen puts in front of a founder is
 * something the engine says yes to.
 */

import { describe, expect, it } from 'vitest';
import type { ActionIntent } from '@frontier/contracts';
import { W2_DEFAULT_SETUP, checkAccess } from '@frontier/simulation';
import { PLAYER_ID, createSession, getEngine, playerCharacterOf, playerCompanyOf } from '../../../lib/game/engine';
import { projectPlayerView } from '../../../lib/game/playerView';
import { buildDirectory, type DirectoryEntry } from './directory';
import { groupByRing, layoutRings, ringOf } from './rings';
import { CONNECTION_LEVERS, bestVia, offersFor, offlineReply, openingDealDraft, viaOptions, type OfferContext } from './actions';

/* -------------------------------------------------------------------------- */
/*  The world that ships                                                       */
/* -------------------------------------------------------------------------- */

function world2() {
  const session = createSession({ setup: W2_DEFAULT_SETUP });
  const view = projectPlayerView(session);
  const founder = playerCharacterOf(session);
  const company = playerCompanyOf(session);
  const directory = buildDirectory(session, view, founder.id);
  return { session, view, founder, company, directory };
}

const { session, founder, company, directory } = world2();
const validator = getEngine().validator;

function validate(intent: ActionIntent) {
  return validator.validate(session, intent, PLAYER_ID);
}

const reachable = directory.filter((entry) => entry.decision.allowed);
const blocked = directory.filter((entry) => !entry.decision.allowed);
const routed = blocked.filter((entry) => entry.brokerIds.length > 0);
const stranded = blocked.filter((entry) => entry.brokerIds.length === 0);

const context: OfferContext = {
  selfId: founder.id,
  ownCompanyId: company.id,
  ownBoardDirectorIds: new Set(
    (session.boards.find((board) => board.id === company.boardId)?.directors ?? []).map((director) => director.characterId),
  ),
  hasOpenBoardMatter: session.boardProposals.some(
    (proposal) => proposal.companyId === company.id && (proposal.status === 'tabled' || proposal.status === 'draft'),
  ),
};

/* -------------------------------------------------------------------------- */
/*  The reproduction                                                           */
/* -------------------------------------------------------------------------- */

describe('the world-2 opening position, as the screen computes it', () => {
  it('is the multi-sector world with a founder on the bottom rung', () => {
    expect(session.config.worldVersion).toBe(2);
    expect(founder.id).toBe('chr_avery_sinclair');
    expect(Math.round(founder.connectionLevel)).toBe(24);
    expect(directory).toHaveLength(42);
  });

  it('has nobody inside the connection gap and thirty-one reachable only through a structural override', () => {
    const direct = directory.filter((entry) => entry.state === 'open');
    const override = directory.filter((entry) => entry.state === 'override');
    expect(direct).toHaveLength(0);
    expect(override).toHaveLength(31);
    expect(blocked).toHaveLength(11);
    expect(routed).toHaveLength(11);
    expect(stranded).toHaveLength(0);
  });

  it('reaches twenty-seven of them on an override nothing has stored', () => {
    // The bug lived here. Four of the thirty-one are the founder's own board,
    // which world 2 does store; the other twenty-seven are `shared_investor`,
    // derived from two cap tables at read time. `canReach` looked only in
    // `accessOverrides`, so those twenty-seven were invisible to it — a badge
    // saying "reachable" over an engine saying "sixty points above you".
    const stored = reachable.filter((entry) =>
      session.accessOverrides.some((override) => override.fromId === founder.id && override.toId === entry.character.id),
    );
    expect(stored).toHaveLength(4);
    expect(reachable.length - stored.length).toBe(27);
    for (const entry of reachable) expect(entry.decision.overrideId).not.toBeNull();
  });

  it('gives the validator the same verdict as the badge for every person on the screen', () => {
    // The invariant the whole screen rests on, probed through the one rule that
    // asks about a third party: an introduction names an intermediary, and the
    // validator refuses on the first leg when it cannot be reached. Whether the
    // *second* leg holds is beside the point here; the first leg is the badge.
    for (const entry of directory) {
      const target = blocked.find((row) => row.character.id !== entry.character.id);
      expect(target).toBeDefined();
      const result = validate({
        type: 'request_introduction',
        viaCharacterId: entry.character.id,
        targetCharacterId: target?.character.id ?? '',
        purpose: 'Reachability probe with a purpose long enough to pass the vagueness rule.',
      });
      const firstLegRefused = result.reasons.some((reason) => reason.startsWith('You cannot reach'));
      expect(firstLegRefused).toBe(!entry.decision.allowed);
      expect(checkAccess(session, founder.id, entry.character.id).allowed).toBe(entry.decision.allowed);
    }
  });
});

describe('every person on the screen carries a move the engine accepts', () => {
  it('accepts an introduction to all eleven blocked people, through the via the screen picks', () => {
    expect(routed.length).toBeGreaterThan(0);
    for (const entry of routed) {
      const via = bestVia(directory, entry);
      expect(via).not.toBeNull();
      const result = validate({
        type: 'request_introduction',
        viaCharacterId: via?.id ?? '',
        targetCharacterId: entry.character.id,
        purpose: 'Compute supply for a two-quarter training run, on terms they would actually sign.',
      });
      expect(result.status).toBe('accepted');
    }
  });

  it('accepts an opening offer to every reachable person', () => {
    expect(reachable.length).toBeGreaterThan(0);
    for (const entry of reachable) {
      const result = validate({
        type: 'propose_deal',
        proposal: openingDealDraft(entry.character, session.quarter, 'An opening conversation about supply on terms we could both sign.'),
      });
      expect(result.status).toBe('accepted');
    }
  });

  it('accepts a private approach to a reachable rival, and refuses one to somebody out of reach', () => {
    const rival = reachable.find((entry) => entry.character.role === 'founder_ceo' && entry.character.companyId !== company.id);
    expect(rival).toBeDefined();
    expect(
      validate({ type: 'poach_executive', targetCharacterId: rival?.character.id ?? '', compPremiumPct: 0.4, approach: 'private' }).status,
    ).toBe('accepted');

    const far = blocked[0];
    expect(far).toBeDefined();
    expect(
      validate({ type: 'poach_executive', targetCharacterId: far?.character.id ?? '', compPremiumPct: 0.4, approach: 'private' }).codes,
    ).toContain('target_not_reachable');
  });

  it('leaves nobody on the screen with an empty drawer', () => {
    for (const entry of directory) {
      expect(offersFor(entry, context).length).toBeGreaterThan(0);
    }
  });

  it('offers seventy-two queueable moves where the screen used to offer none that worked', () => {
    const byKind = new Map<string, number>();
    for (const entry of directory) {
      for (const offer of offersFor(entry, context)) byKind.set(offer.kind, (byKind.get(offer.kind) ?? 0) + 1);
    }
    expect(byKind.get('talk')).toBe(31);
    expect(byKind.get('propose_deal')).toBe(31);
    expect(byKind.get('poach_executive')).toBe(24);
    expect(byKind.get('request_introduction')).toBe(11);
    expect(byKind.get('lobby_director')).toBe(4);
    expect(byKind.get('meet_regulator')).toBe(2);
    const queueable = [...byKind.entries()].reduce((total, [kind, count]) => total + (kind === 'talk' ? 0 : count), 0);
    expect(queueable).toBe(72);
  });
});

/* -------------------------------------------------------------------------- */
/*  The path finder                                                            */
/* -------------------------------------------------------------------------- */

describe('the route in is deterministic', () => {
  it('picks the same intermediary for the same session, twice', () => {
    const again = world2();
    for (const entry of routed) {
      const mirror = again.directory.find((row) => row.character.id === entry.character.id);
      expect(mirror).toBeDefined();
      expect(bestVia(again.directory, mirror as DirectoryEntry)?.id).toBe(bestVia(directory, entry)?.id);
    }
  });

  it('picks the reachable broker with the most standing to spend', () => {
    for (const entry of routed) {
      const via = bestVia(directory, entry);
      const best = Math.max(...viaOptions(directory, entry).map((person) => person.connectionLevel));
      expect(via?.connectionLevel).toBe(best);
    }
  });

  it('breaks a tie on id, so two renders never disagree', () => {
    const tied = directory
      .filter((entry) => !entry.decision.allowed)
      .map((entry) => ({ entry, options: viaOptions(directory, entry) }))
      .find(({ options }) => options.length > 1 && options[0]?.connectionLevel === options[1]?.connectionLevel);
    if (tied !== undefined) {
      expect((tied.options[0]?.id ?? '') < (tied.options[1]?.id ?? '')).toBe(true);
    }
    // Whether or not this world contains a tie, the ordering is total.
    for (const entry of routed) {
      const ids = viaOptions(directory, entry).map((person) => person.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it('offers no route at all when nobody can reach the target', () => {
    const nowhere: DirectoryEntry = { ...(routed[0] as DirectoryEntry), brokerIds: [] };
    expect(bestVia(directory, nowhere)).toBeNull();
    expect(viaOptions(directory, nowhere)).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/*  What each role is offered                                                  */
/* -------------------------------------------------------------------------- */

describe('the moves offered match the person', () => {
  const kinds = (entry: DirectoryEntry, over: Partial<OfferContext> = {}) =>
    offersFor(entry, { ...context, ...over }).map((offer) => offer.kind);

  it('opens a reachable person with a conversation and a blocked one with the route in', () => {
    const near = reachable[0] as DirectoryEntry;
    const far = routed[0] as DirectoryEntry;
    expect(kinds(near)[0]).toBe('talk');
    expect(kinds(far)[0]).toBe('request_introduction');
    expect(kinds(near)).not.toContain('request_introduction');
  });

  it('offers a regulator a meeting and never a poaching approach', () => {
    const official = directory.filter((entry) => entry.character.role === 'regulator' || entry.character.role === 'official');
    expect(official.length).toBeGreaterThan(0);
    for (const entry of official) {
      expect(kinds(entry)).toContain('meet_regulator');
      expect(kinds(entry)).not.toContain('poach_executive');
    }
  });

  it('offers lobbying only to the player\'s own directors', () => {
    const seated = directory.filter((entry) => context.ownBoardDirectorIds.has(entry.character.id));
    expect(seated.length).toBeGreaterThan(0);
    for (const entry of seated) expect(kinds(entry)).toContain('lobby_director');
    for (const entry of directory.filter((row) => !context.ownBoardDirectorIds.has(row.character.id))) {
      expect(kinds(entry)).not.toContain('lobby_director');
    }
  });

  it('never offers to poach somebody who already works for you, or somebody with no employer', () => {
    for (const entry of directory) {
      if (!kinds(entry).includes('poach_executive')) continue;
      expect(entry.character.companyId).not.toBeNull();
      expect(entry.character.companyId).not.toBe(company.id);
    }
  });

  it('never offers terms to a person the access rule refuses', () => {
    for (const entry of blocked) expect(kinds(entry)).not.toContain('propose_deal');
  });

  it('does not hide a role action behind the board having nothing tabled', () => {
    const director = directory.find((entry) => context.ownBoardDirectorIds.has(entry.character.id)) as DirectoryEntry;
    // The offer stands either way; only its explanation changes, because a
    // control that vanishes teaches a player nothing about why.
    expect(kinds(director, { hasOpenBoardMatter: false })).toContain('lobby_director');
    expect(kinds(director, { hasOpenBoardMatter: true })).toContain('lobby_director');
  });
});

/* -------------------------------------------------------------------------- */
/*  Rings and directory, on the world that ships                               */
/* -------------------------------------------------------------------------- */

describe('rings and directory on world 2', () => {
  it('places every one of the forty-two people exactly once', () => {
    const nodes = layoutRings(directory);
    expect(nodes).toHaveLength(42);
    expect(new Set(nodes.map((node) => node.entry.character.id)).size).toBe(42);
  });

  it('puts the thirty-one reachable people in the inner ring and the eleven routed in the middle', () => {
    const groups = groupByRing(directory);
    expect(groups.find((group) => group.ring === 'inner')?.entries).toHaveLength(31);
    expect(groups.find((group) => group.ring === 'middle')?.entries).toHaveLength(11);
    expect(groups.find((group) => group.ring === 'outer')?.entries).toHaveLength(0);
  });

  it('agrees with the access state for every person', () => {
    for (const entry of directory) {
      expect(ringOf(entry)).toBe(entry.state === 'blocked' ? (entry.brokerIds.length > 0 ? 'middle' : 'outer') : 'inner');
    }
  });

  it('lists the same people the picture draws, in the same order, so the phone reads the web', () => {
    const nodes = layoutRings(directory);
    for (const group of groupByRing(directory)) {
      const drawn = nodes.filter((node) => node.ring === group.ring).map((node) => node.entry.character.id);
      expect(group.entries.map((entry) => entry.character.id)).toEqual(drawn);
    }
  });
});

/* -------------------------------------------------------------------------- */
/*  The dead end, and the way out of it                                        */
/* -------------------------------------------------------------------------- */

describe('what the screen says when there is no route at all', () => {
  it('names all ten inputs of the connection hierarchy, heaviest first', () => {
    expect(CONNECTION_LEVERS).toHaveLength(10);
    const weights = CONNECTION_LEVERS.map((lever) => lever.weightPct);
    expect(weights).toEqual([...weights].sort((a, b) => b - a));
    expect(weights.reduce((total, weight) => total + weight, 0)).toBe(100);
  });

  it('gives every input a whole-number weight and a screen to go to', () => {
    for (const lever of CONNECTION_LEVERS) {
      expect(Number.isInteger(lever.weightPct)).toBe(true);
      expect(lever.href.startsWith('/')).toBe(true);
      expect(lever.icon.length).toBeGreaterThan(0);
    }
  });

  it('puts public following last, because this is not follower count', () => {
    expect(CONNECTION_LEVERS[CONNECTION_LEVERS.length - 1]?.label).toBe('Public following');
  });
});

/* -------------------------------------------------------------------------- */
/*  Dialogue without a model                                                   */
/* -------------------------------------------------------------------------- */

describe('a conversation survives the model being unavailable', () => {
  const someone = (directory[0] as DirectoryEntry).character;

  it('answers deterministically, in register, with no invented number', () => {
    const first = offlineReply(someone, null, null, 'compute supply');
    expect(first).toBe(offlineReply(someone, null, null, 'compute supply'));
    expect(first).toContain('compute supply');
    expect(first).toContain('We have not worked together before');
  });

  it('changes register with the relationship rather than with the words', () => {
    expect(offlineReply(someone, 80, 0, 'terms')).toContain('Good to hear from you');
    expect(offlineReply(someone, 20, 70, 'terms')).toContain('I will be short about this');
  });
});
