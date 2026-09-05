/**
 * The Command Centre's "asking for an answer" lines link to the screen that
 * resolves them. The world lines resolve on the newspaper — and the paper keeps
 * its section in the URL, so a world event opens the World section (the event
 * and the map) and the press narrative opens Press, not the front page.
 */

import { describe, expect, it } from 'vitest';
import type { WorldEvent } from '@frontier/contracts';
import { W2_DEFAULT_SETUP } from '@frontier/simulation';
import { createSession } from '../../../lib/game/engine';
import { projectPlayerView } from '../../../lib/game/playerView';
import { buildFeed } from './feed';

function eventOf(overrides: Partial<WorldEvent>): WorldEvent {
  return {
    id: 'wev_feed_test',
    familyId: 'fam_test',
    type: 'compute_supply_shock',
    titleKey: 'test_event',
    title: 'A shock the founder must answer',
    description: 'Something happened in the world, and it is long enough to satisfy the schema minimum.',
    severity: 0.7,
    visibility: 'public',
    durationQuarters: 2,
    causalParentId: null,
    quarter: 0,
    affectedSectorIds: [],
    affectedCompanyIds: [],
    ...overrides,
  };
}

describe('world lines on the Command Centre', () => {
  it('lead to the paper open on the section that carries them', () => {
    const session = createSession({ setup: W2_DEFAULT_SETUP });
    session.activeEvents = [...session.activeEvents, eventOf({}), eventOf({ id: 'wev_minor', severity: 0.2, title: 'Too small to list' })];
    session.world = { ...session.world, media: { ...session.world.media, dominantNarrative: 'bubble_concern' } };
    const view = projectPlayerView(session);
    const feed = buildFeed(session, view, null, 0);

    const event = feed.find((line) => line.id === 'evt_wev_feed_test');
    expect(event).toBeDefined();
    expect(event?.href).toBe('/news?section=world');
    // A shock under the listing floor is not a line at all.
    expect(feed.some((line) => line.id === 'evt_wev_minor')).toBe(false);

    const narrative = feed.find((line) => line.id === 'narrative');
    expect(narrative?.href).toBe('/news?section=press');
    // No world line opens the front page and leaves the reader to find the section.
    for (const line of feed.filter((entry) => entry.group === 'world')) expect(line.href).not.toBe('/news');
  });
});
