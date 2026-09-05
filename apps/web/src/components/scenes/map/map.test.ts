/**
 * The world map is a picture of the *public* record, so its whole model is a
 * pure function and every claim it makes is testable without a DOM.
 *
 * What this file pins:
 *
 * 1. **Determinism.** The same projection builds the same map, forever. Nothing
 *    is placed by a random draw, and nothing moves because a rival got bigger.
 * 2. **The information boundary.** Only companies in the projection reach the
 *    map; a private rival is sized from its tier and never from a valuation;
 *    only `visibility === 'public'` events get a marker.
 * 3. **Honest geometry.** Every building stands on a plot declared for its
 *    kind, no two buildings share one, and every plot is inside its own
 *    district and inside the stage.
 * 4. **Total coverage.** Every world event type has a home district, so a new
 *    event family can never land nowhere.
 */

import { describe, expect, it } from 'vitest';
import type { PlayerView, SessionState, WorldEvent } from '@frontier/contracts';
import { WORLD_EVENT_TYPES } from '@frontier/contracts';
import { createDefaultEngine, createDemoSession } from '@frontier/simulation';
import { marketCapOf, projectPlayerView } from '../../../lib/game/playerView';
import { DISTRICTS, DISTRICT_BY_ID, DISTRICT_LANDMARKS, MAP_STAGE, type DistrictId } from './geography';
import {
  buildOverlays,
  buildWorldMapModel,
  computeTightnessOf,
  districtForEvent,
  districtReadings,
  formatReading,
  initialsOfName,
  pickIndex,
  tensionOf,
  towerHeight,
  towerWidth,
} from './model';

/* -------------------------------------------------------------------------- */
/*  Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

function resolved(quarters: number): SessionState {
  const engine = createDefaultEngine();
  let state = createDemoSession();
  for (let index = 0; index < quarters; index += 1) {
    const outcome = engine.resolver.resolveQuarter(state, [], null, []);
    expect(outcome.committed).toBe(true);
    state = outcome.nextState;
  }
  return state;
}

function inputFor(state: SessionState) {
  const view = projectPlayerView(state);
  return { view, agencies: state.agencies, playerMarketCap: marketCapOf(state, view.ownCompany.id) };
}

function eventOf(overrides: Partial<WorldEvent>): WorldEvent {
  return {
    id: 'wev_test',
    familyId: 'fam_test',
    type: 'compute_supply_shock',
    titleKey: 'test_event',
    title: 'A test happening',
    description: 'Something happened in the world, and it is long enough to satisfy the schema minimum.',
    severity: 0.5,
    visibility: 'public',
    durationQuarters: 2,
    causalParentId: null,
    quarter: 0,
    affectedSectorIds: [],
    affectedCompanyIds: [],
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/*  Geometry                                                                   */
/* -------------------------------------------------------------------------- */

describe('world map geography: fixed, contained and unambiguous', () => {
  it('keeps every district inside the stage', () => {
    for (const district of DISTRICTS) {
      expect(district.parcel.x).toBeGreaterThanOrEqual(0);
      expect(district.parcel.y).toBeGreaterThanOrEqual(0);
      expect(district.parcel.x + district.parcel.w).toBeLessThanOrEqual(MAP_STAGE.width);
      expect(district.parcel.y + district.parcel.h).toBeLessThanOrEqual(MAP_STAGE.height);
    }
  });

  it('keeps every plot inside its own district', () => {
    for (const district of DISTRICTS) {
      for (const spot of district.plots) {
        expect(spot.x, `${district.id} plot x`).toBeGreaterThan(district.parcel.x);
        expect(spot.x, `${district.id} plot x`).toBeLessThan(district.parcel.x + district.parcel.w);
        expect(spot.y, `${district.id} plot y`).toBeGreaterThan(district.parcel.y);
        expect(spot.y, `${district.id} plot y`).toBeLessThanOrEqual(district.parcel.y + district.parcel.h);
      }
    }
  });

  it('never overlaps two district parcels', () => {
    for (let a = 0; a < DISTRICTS.length; a += 1) {
      for (let b = a + 1; b < DISTRICTS.length; b += 1) {
        const one = DISTRICTS[a]?.parcel;
        const two = DISTRICTS[b]?.parcel;
        if (one === undefined || two === undefined) continue;
        const apart =
          one.x + one.w <= two.x || two.x + two.w <= one.x || one.y + one.h <= two.y || two.y + two.h <= one.y;
        expect(apart, `${DISTRICTS[a]?.id} overlaps ${DISTRICTS[b]?.id}`).toBe(true);
      }
    }
  });

  it('gives every plot a unique position', () => {
    const seen = new Set<string>();
    for (const district of DISTRICTS) {
      for (const spot of district.plots) {
        const key = `${spot.x}:${spot.y}`;
        expect(seen.has(key), `duplicate plot at ${key}`).toBe(false);
        seen.add(key);
      }
    }
  });

  it('has a district for every world event type', () => {
    for (const type of WORLD_EVENT_TYPES) {
      const districtId = districtForEvent(eventOf({ type }));
      expect(DISTRICT_BY_ID.get(districtId), `no district for ${type}`).toBeDefined();
    }
  });
});

/* -------------------------------------------------------------------------- */
/*  Sizing                                                                     */
/* -------------------------------------------------------------------------- */

describe('world map sizing: a silhouette is a figure, drawn', () => {
  it('is monotonic in market capitalisation and bounded at both ends', () => {
    const small = towerHeight(50_000_000, 'major');
    const mid = towerHeight(20_000_000_000, 'major');
    const large = towerHeight(2_000_000_000_000, 'major');
    const absurd = towerHeight(500_000_000_000_000, 'major');
    expect(small).toBeLessThan(mid);
    expect(mid).toBeLessThan(large);
    expect(absurd).toBe(88);
    expect(small).toBeGreaterThanOrEqual(40);
    expect(towerWidth(small)).toBeGreaterThanOrEqual(34);
  });

  it('falls back to the tier baseline when there is no public valuation', () => {
    expect(towerHeight(null, 'major')).toBe(62);
    expect(towerHeight(null, 'significant')).toBe(50);
    expect(towerHeight(null, 'background')).toBe(42);
    expect(towerHeight(0, 'significant')).toBe(50);
    expect(towerHeight(Number.NaN, 'background')).toBe(42);
  });

  it('derives per-entity variation from the id and nothing else', () => {
    expect(pickIndex('cmp_nexus', 'livery', 8)).toBe(pickIndex('cmp_nexus', 'livery', 8));
    expect(pickIndex('cmp_nexus', 'livery', 8)).toBeGreaterThanOrEqual(0);
    expect(pickIndex('cmp_nexus', 'livery', 8)).toBeLessThan(8);
    // Salting matters: hair must not move with the outfit.
    expect(pickIndex('cmp_nexus', 'livery', 64)).not.toBe(pickIndex('cmp_nexus', 'hair', 64));
  });

  it('reads a flag from a name when there is no ticker', () => {
    expect(initialsOfName('Player Ventures')).toBe('PV');
    expect(initialsOfName('Nexus')).toBe('NEX');
    expect(initialsOfName('')).toBe('??');
  });
});

/* -------------------------------------------------------------------------- */
/*  Placement                                                                  */
/* -------------------------------------------------------------------------- */

describe('world map placement: everything stands on a declared plot', () => {
  const model = buildWorldMapModel(inputFor(createDemoSession()));

  it('places every building on a plot of the right kind', () => {
    for (const building of model.buildings) {
      const district = DISTRICT_BY_ID.get(building.districtId);
      expect(district, building.key).toBeDefined();
      const spot = district?.plots.find((entry) => entry.x === building.x && entry.y === building.baseY);
      expect(spot, `${building.key} is not on a plot`).toBeDefined();
      expect(spot?.use).toBe(building.kind === 'company' ? 'company' : 'landmark');
    }
  });

  it('keeps every silhouette inside its own parcel', () => {
    for (const building of model.buildings) {
      const district = DISTRICT_BY_ID.get(building.districtId);
      if (district === undefined) throw new Error(`no district for ${building.key}`);
      const { parcel } = district;
      expect(building.x - building.width / 2, `${building.key} left`).toBeGreaterThanOrEqual(parcel.x);
      expect(building.x + building.width / 2, `${building.key} right`).toBeLessThanOrEqual(parcel.x + parcel.w);
      expect(building.baseY - building.height, `${building.key} top`).toBeGreaterThanOrEqual(parcel.y);
      expect(building.baseY, `${building.key} base`).toBeLessThanOrEqual(parcel.y + parcel.h);
    }
  });

  it('leaves room on every company plot for the tallest tower there can be', () => {
    // The silhouette scales with market capitalisation, so a plot has to hold
    // the ceiling case or a trillion-dollar rival would grow out of its district.
    const tallest = towerHeight(Number.MAX_SAFE_INTEGER, 'major');
    const widest = towerWidth(tallest);
    for (const district of DISTRICTS) {
      for (const spot of district.plots) {
        if (spot.use !== 'company') continue;
        expect(spot.x - widest / 2, `${district.id} plot left`).toBeGreaterThanOrEqual(district.parcel.x);
        expect(spot.x + widest / 2, `${district.id} plot right`).toBeLessThanOrEqual(district.parcel.x + district.parcel.w);
        expect(spot.y - tallest, `${district.id} plot headroom`).toBeGreaterThanOrEqual(district.parcel.y);
      }
    }
  });

  it('gives every fixed landmark a plot it fits on', () => {
    for (const district of DISTRICTS) {
      const plots = district.plots.filter((entry) => entry.use === 'landmark');
      const seeds = DISTRICT_LANDMARKS[district.id];
      expect(seeds.length, `${district.id} has more landmarks than plots`).toBeLessThanOrEqual(plots.length);
      seeds.forEach((seed, index) => {
        const spot = plots[index];
        if (spot === undefined) throw new Error(`${district.id}: no plot for ${seed.id}`);
        expect(spot.x - seed.width / 2, `${seed.id} left`).toBeGreaterThanOrEqual(district.parcel.x);
        expect(spot.x + seed.width / 2, `${seed.id} right`).toBeLessThanOrEqual(district.parcel.x + district.parcel.w);
        expect(spot.y - seed.height, `${seed.id} headroom`).toBeGreaterThanOrEqual(district.parcel.y);
      });
    }
  });

  it('never puts two buildings on one plot', () => {
    const seen = new Set<string>();
    for (const building of model.buildings) {
      const key = `${building.x}:${building.baseY}`;
      expect(seen.has(key), `two buildings at ${key}`).toBe(false);
      seen.add(key);
    }
  });

  it('gives the player exactly one head office, and it is theirs', () => {
    const own = model.buildings.filter((entry) => entry.isPlayer);
    expect(own).toHaveLength(1);
    expect(own[0]?.kind).toBe('company');
  });

  it('puts every agency in the Federal Quarter as a civic building', () => {
    const state = createDemoSession();
    const agencies = model.buildings.filter((entry) => entry.kind === 'agency');
    expect(agencies.length).toBe(state.agencies.length);
    for (const agency of agencies) {
      expect(agency.districtId).toBe<DistrictId>('capitol');
      expect(agency.glyph).toBe('civic');
      expect(agency.target).toEqual({ kind: 'agency', agencyId: agency.key });
    }
  });

  it('builds the same map twice, and again three quarters later', () => {
    const input = inputFor(createDemoSession());
    expect(buildWorldMapModel(input)).toEqual(buildWorldMapModel(input));

    const later = inputFor(resolved(3));
    expect(buildWorldMapModel(later)).toEqual(buildWorldMapModel(later));
  });
});

/* -------------------------------------------------------------------------- */
/*  The information boundary                                                   */
/* -------------------------------------------------------------------------- */

describe('world map: public information only', () => {
  const state = createDemoSession();
  const base = inputFor(state);

  it('draws only companies that are in the projection', () => {
    const model = buildWorldMapModel(base);
    const allowed = new Set<string>([base.view.ownCompany.id]);
    for (const rival of base.view.visibleCompanies) if (rival.id !== undefined) allowed.add(rival.id);
    for (const building of model.buildings) {
      if (building.kind !== 'company') continue;
      expect(allowed.has(building.key), `${building.key} is not in the projection`).toBe(true);
    }
  });

  it('sizes a private rival from its tier, never from a valuation', () => {
    const rival = base.view.visibleCompanies.find((entry) => entry.id !== undefined && entry.isPublic === true);
    expect(rival).toBeDefined();
    if (rival === undefined) return;

    const taken: PlayerView = {
      ...base.view,
      visibleCompanies: base.view.visibleCompanies.map((entry) =>
        entry.id === rival.id ? { ...entry, isPublic: false, instrumentId: null } : entry,
      ),
    };
    const model = buildWorldMapModel({ ...base, view: taken });
    const drawn = model.buildings.find((entry) => entry.key === rival.id);
    expect(drawn).toBeDefined();
    expect(drawn?.height).toBe(towerHeight(null, rival.tier ?? 'background'));
  });

  it('marks public events and nothing else', () => {
    const view: PlayerView = {
      ...base.view,
      activeEvents: [
        eventOf({ id: 'wev_public', visibility: 'public' }),
        eventOf({ id: 'wev_sector', visibility: 'sector' }),
        eventOf({ id: 'wev_private', visibility: 'private' }),
      ],
    };
    const model = buildWorldMapModel({ ...base, view });
    expect(model.markers.map((marker) => marker.eventId)).toEqual(['wev_public']);
    expect(model.events.map((entry) => entry.id)).toEqual(['wev_public']);
  });

  it('stacks several events in one district without collision', () => {
    const view: PlayerView = {
      ...base.view,
      activeEvents: [
        eventOf({ id: 'wev_a', type: 'compute_supply_shock', severity: 0.9 }),
        eventOf({ id: 'wev_b', type: 'compute_demand_shock', severity: 0.8 }),
        eventOf({ id: 'wev_c', type: 'fab_disruption', severity: 0.7 }),
      ],
    };
    const model = buildWorldMapModel({ ...base, view });
    expect(model.markers).toHaveLength(3);
    for (const marker of model.markers) expect(marker.districtId).toBe<DistrictId>('datacentre');
    const positions = new Set(model.markers.map((marker) => `${marker.x}:${marker.y}`));
    expect(positions.size).toBe(3);
  });

  it('plants a marker on the roof of the one company an event names', () => {
    const target = base.view.visibleCompanies.find((entry) => entry.id !== undefined);
    expect(target).toBeDefined();
    if (target?.id === undefined) return;

    const view: PlayerView = {
      ...base.view,
      activeEvents: [eventOf({ id: 'wev_named', type: 'corporate_scandal', affectedCompanyIds: [target.id] })],
    };
    const model = buildWorldMapModel({ ...base, view });
    const host = model.buildings.find((entry) => entry.key === target.id);
    const marker = model.markers[0];
    expect(host).toBeDefined();
    expect(marker?.x).toBe(host?.x);
    expect(marker?.y).toBe((host?.baseY ?? 0) - (host?.height ?? 0) - 20);
  });
});

/* -------------------------------------------------------------------------- */
/*  Overlays and readings                                                      */
/* -------------------------------------------------------------------------- */

describe('world map overlays: the world state, read not invented', () => {
  const state = createDemoSession();

  it('reads compute tightness as the inverse of supply', () => {
    const tight = computeTightnessOf({
      ...state.world,
      compute: { ...state.world.compute, acceleratorSupply: 0, cloudCapacity: 0 },
    });
    const loose = computeTightnessOf({
      ...state.world,
      compute: { ...state.world.compute, acceleratorSupply: 1, cloudCapacity: 1 },
    });
    expect(tight).toBe(1);
    expect(loose).toBe(0);
    expect(computeTightnessOf(state.world)).toBeGreaterThan(0);
    expect(computeTightnessOf(state.world)).toBeLessThan(1);
  });

  it('averages the four geopolitical variables into one storm', () => {
    const calm = tensionOf({
      ...state.world,
      geopolitics: { tradeFriction: 0, conflictRisk: 0, sanctions: 0, techCompetition: 0 },
    });
    const rupture = tensionOf({
      ...state.world,
      geopolitics: { tradeFriction: 1, conflictRisk: 1, sanctions: 1, techCompetition: 1 },
    });
    expect(calm).toBe(0);
    expect(rupture).toBe(1);
  });

  it('bands and labels the overlays without inventing a value', () => {
    const overlays = buildOverlays(state.world);
    expect(overlays.banner.attention).toBe(state.world.media.attentionLevel);
    expect(overlays.banner.controversy).toBe(state.world.media.controversyIntensity);
    expect(overlays.banner.narrative).toBe(state.world.media.dominantNarrative);
    expect(overlays.banner.label.length).toBeGreaterThan(0);
    expect(overlays.computeBand.length).toBeGreaterThan(0);
    expect(overlays.tensionBand.length).toBeGreaterThan(0);
  });

  it('gives every district a reading drawn straight from the world', () => {
    for (const district of DISTRICTS) {
      const readings = districtReadings(state.world, district.id);
      expect(readings.length, district.id).toBeGreaterThanOrEqual(5);
      for (const reading of readings) {
        expect(Number.isFinite(reading.value), `${district.id} ${reading.label}`).toBe(true);
        expect(formatReading(reading).length).toBeGreaterThan(0);
        expect(reading.hint.length).toBeGreaterThan(0);
      }
    }
  });

  it('renders an index as a multiple and a share as a percentage', () => {
    // Whole-figure house style: near-parity indices read as deviation, never "1.618".
    expect(formatReading({ label: 'x', value: 1.618, unit: 'index', hint: 'h', meter: null })).toBe('+62%');
    expect(formatReading({ label: 'x', value: 2.4, unit: 'index', hint: 'h', meter: null })).toBe('2x');
    expect(formatReading({ label: 'x', value: 0.5, unit: 'share', hint: 'h', meter: 50 })).toContain('%');
  });
});
