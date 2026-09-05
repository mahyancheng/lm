/**
 * The people web is a picture of `checkAccess`, and these are the rules that
 * keep it one.
 *
 * The layout is checked against the real demo directory rather than fixtures,
 * because the thing that would actually break the screen is a ring rule that
 * disagrees with the engine's own reachability answer — and only the real
 * session has that answer in it.
 */

import { describe, expect, it } from 'vitest';
import { createSession } from '../../../lib/game/engine';
import { projectPlayerView } from '../../../lib/game/playerView';
import { buildDirectory } from './directory';
import { RING_GEOMETRY, RING_ORDER, edgeStrength, groupByRing, isHostile, layoutRings, ringOf } from './rings';

const session = createSession();
const view = projectPlayerView(session);
const founder = session.characters.find((character) => character.isPlayer);
const directory = buildDirectory(session, view, founder?.id ?? '');

describe('the ring a person sits in is their access state', () => {
  it('places everybody exactly once', () => {
    const nodes = layoutRings(directory);
    expect(nodes).toHaveLength(directory.length);
    expect(new Set(nodes.map((node) => node.entry.character.id)).size).toBe(directory.length);
  });

  it('never puts a reachable person outside the inner ring', () => {
    for (const entry of directory) {
      if (entry.state !== 'blocked') expect(ringOf(entry)).toBe('inner');
      else expect(ringOf(entry)).toBe(entry.brokerIds.length > 0 ? 'middle' : 'outer');
    }
  });

  it('gives everybody in the middle ring a route that is actually drawable', () => {
    const nodes = layoutRings(directory);
    const placed = new Set(nodes.map((node) => node.entry.character.id));
    for (const node of nodes.filter((entry) => entry.ring === 'middle')) {
      const broker = node.entry.brokerIds[0];
      expect(broker).toBeDefined();
      expect(placed.has(broker ?? '')).toBe(true);
    }
  });
});

describe('the layout is deterministic and contained', () => {
  it('places everybody in the same spot twice', () => {
    expect(layoutRings(directory)).toEqual(layoutRings(directory));
  });

  it('does not move a person because somebody else was filtered out', () => {
    const full = layoutRings(directory);
    const trimmed = layoutRings(directory.filter((entry) => entry.character.role !== 'journalist'));
    const first = full.find((node) => node.ring === 'inner');
    const same = trimmed.find((node) => node.entry.character.id === first?.entry.character.id);
    // Ring membership is state, not order: a filtered web may respace a ring,
    // but nobody changes ring because somebody else left the picture.
    expect(same?.ring).toBe(first?.ring);
  });

  it('keeps every node inside the stage', () => {
    for (const node of layoutRings(directory)) {
      expect(node.xPct).toBeGreaterThan(4);
      expect(node.xPct).toBeLessThan(96);
      expect(node.yPct).toBeGreaterThan(4);
      expect(node.yPct).toBeLessThan(96);
    }
  });

  it('keeps the rings in order, inner to outer', () => {
    expect(RING_GEOMETRY.inner.rx).toBeLessThan(RING_GEOMETRY.middle.rx);
    expect(RING_GEOMETRY.middle.rx).toBeLessThan(RING_GEOMETRY.outer.rx);
    expect(RING_GEOMETRY.inner.ry).toBeLessThan(RING_GEOMETRY.middle.ry);
    expect(RING_GEOMETRY.middle.ry).toBeLessThan(RING_GEOMETRY.outer.ry);
  });
});

describe('the phone reads the same rings as a list', () => {
  it('keeps every ring, in order, even when one is empty', () => {
    const groups = groupByRing(directory);
    expect(groups.map((group) => group.ring)).toEqual([...RING_ORDER]);
  });

  it('lists everybody exactly once, in the ring the picture would place them', () => {
    const groups = groupByRing(directory);
    expect(groups.reduce((total, group) => total + group.entries.length, 0)).toBe(directory.length);
    for (const group of groups) {
      for (const entry of group.entries) expect(ringOf(entry)).toBe(group.ring);
    }
  });

  it('orders a ring the way the picture sweeps it, so switching view never reshuffles anybody', () => {
    const nodes = layoutRings(directory);
    for (const group of groupByRing(directory)) {
      const drawn = nodes.filter((node) => node.ring === group.ring).map((node) => node.entry.character.id);
      expect(group.entries.map((entry) => entry.character.id)).toEqual(drawn);
    }
  });
});

describe('edge thickness is the relationship, and nothing else', () => {
  it('is zero when the two have never dealt with each other', () => {
    const stranger = directory.find((entry) => entry.outbound === null && entry.inbound === null);
    if (stranger !== undefined) expect(edgeStrength(stranger)).toBe(0);
  });

  it('stays inside 0..1 for everybody in the session', () => {
    for (const entry of directory) {
      const strength = edgeStrength(entry);
      expect(strength).toBeGreaterThanOrEqual(0);
      expect(strength).toBeLessThanOrEqual(1);
      expect(typeof isHostile(entry)).toBe('boolean');
    }
  });
});
