/**
 * The world map with a whole economy standing on it.
 *
 * World version 2 opens with twenty-five companies where world 1 had seven, and
 * they do not distribute evenly across the seven districts — the research belt
 * alone wants more head offices than it has kerb. So placement runs two passes:
 * everyone takes a plot at home first, and whoever is left takes the first free
 * plot anywhere, scanning districts in map order.
 *
 * What this file pins:
 *
 * 1. **Nobody falls off the map.** Every company in the projection gets a
 *    building, and `unplaced` is empty.
 * 2. **The overflow is still honest geometry.** One building per plot, every
 *    plot the right kind, every silhouette inside its own parcel.
 * 3. **It is still deterministic.** Two builds of one quarter are identical,
 *    and the city does not rearrange itself when a quarter resolves.
 * 4. **World 1 is untouched.** The same seven companies stand in the same
 *    districts they always did — the second pass never runs there.
 */

import { describe, expect, it } from 'vitest';
import type { NewGameSetupInput, PlayerView, SessionState } from '@frontier/contracts';
import { CURRENT_WORLD_VERSION, SECTORS } from '@frontier/contracts';
import { createDefaultEngine, createDemoSession } from '@frontier/simulation';
import { marketCapOf, projectPlayerView } from '../../../lib/game/playerView';
import { DISTRICTS, DISTRICT_BY_ID, MAP_STAGE } from './geography';
import { buildWorldMapModel, towerHeight, towerWidth } from './model';

const MULTI_SECTOR_SETUP: NewGameSetupInput = {
  companyName: 'Player Ventures',
  founderName: 'Avery Sinclair',
  backgroundId: 'frontier_lab',
  worldVersion: CURRENT_WORLD_VERSION,
};

function multiSector(): SessionState {
  return createDemoSession(undefined, MULTI_SECTOR_SETUP);
}

function inputFor(state: SessionState): { view: PlayerView; agencies: SessionState['agencies']; playerMarketCap: number } {
  const view = projectPlayerView(state);
  return { view, agencies: state.agencies, playerMarketCap: marketCapOf(state, view.ownCompany.id) };
}

function resolved(state: SessionState, quarters: number): SessionState {
  const engine = createDefaultEngine();
  let next = state;
  for (let index = 0; index < quarters; index += 1) {
    const outcome = engine.resolver.resolveQuarter(next, [], null, []);
    expect(outcome.committed).toBe(true);
    next = outcome.nextState;
  }
  return next;
}

/** Total company kerb across the whole map. */
const COMPANY_PLOTS = DISTRICTS.reduce(
  (total, district) => total + district.plots.filter((entry) => entry.use === 'company').length,
  0,
);

describe('the map holds a whole economy', () => {
  const state = multiSector();
  const input = inputFor(state);
  const model = buildWorldMapModel(input);
  const active = state.companies.filter((company) => company.isActive);

  it('has more company plots than the world has companies', () => {
    expect(active.length).toBeGreaterThan(20);
    expect(COMPANY_PLOTS).toBeGreaterThanOrEqual(active.length);
  });

  it('draws every company and leaves nobody off the map', () => {
    const drawn = model.buildings.filter((entry) => entry.kind === 'company');
    expect(drawn).toHaveLength(active.length);
    expect(model.unplaced).toEqual([]);
    expect(new Set(drawn.map((entry) => entry.key)).size).toBe(drawn.length);
  });

  it('spreads them across every district rather than stacking one', () => {
    const drawn = model.buildings.filter((entry) => entry.kind === 'company');
    expect(new Set(drawn.map((entry) => entry.districtId)).size).toBeGreaterThanOrEqual(5);
  });

  it('never puts two buildings on one plot, overflow included', () => {
    const seen = new Set<string>();
    for (const building of model.buildings) {
      const key = `${building.x}:${building.baseY}`;
      expect(seen.has(key), `two buildings at ${key}`).toBe(false);
      seen.add(key);
    }
  });

  it('puts every building on a declared plot of the right kind', () => {
    for (const building of model.buildings) {
      const district = DISTRICT_BY_ID.get(building.districtId);
      expect(district, building.key).toBeDefined();
      const spot = district?.plots.find((entry) => entry.x === building.x && entry.y === building.baseY);
      expect(spot, `${building.key} is not on a plot`).toBeDefined();
      expect(spot?.use).toBe(building.kind === 'company' ? 'company' : 'landmark');
    }
  });

  it('keeps every silhouette inside its own parcel and inside the stage', () => {
    for (const building of model.buildings) {
      const district = DISTRICT_BY_ID.get(building.districtId);
      if (district === undefined) throw new Error(`no district for ${building.key}`);
      const { parcel } = district;
      expect(building.x - building.width / 2, `${building.key} left`).toBeGreaterThanOrEqual(parcel.x);
      expect(building.x + building.width / 2, `${building.key} right`).toBeLessThanOrEqual(parcel.x + parcel.w);
      expect(building.baseY - building.height, `${building.key} top`).toBeGreaterThanOrEqual(parcel.y);
      expect(building.baseY, `${building.key} base`).toBeLessThanOrEqual(parcel.y + parcel.h);
      expect(building.baseY).toBeLessThanOrEqual(MAP_STAGE.height);
    }
  });

  it('leaves headroom on every new plot for the tallest tower there can be', () => {
    const tallest = towerHeight(Number.MAX_SAFE_INTEGER, 'major');
    const widest = towerWidth(tallest);
    for (const district of DISTRICTS) {
      for (const spot of district.plots) {
        if (spot.use !== 'company') continue;
        expect(spot.x - widest / 2, `${district.id} plot left`).toBeGreaterThanOrEqual(district.parcel.x);
        expect(spot.x + widest / 2, `${district.id} plot right`).toBeLessThanOrEqual(district.parcel.x + district.parcel.w);
        expect(spot.y - tallest, `${district.id} plot headroom`).toBeGreaterThanOrEqual(district.parcel.y);
        expect(spot.y, `${district.id} plot base`).toBeLessThanOrEqual(district.parcel.y + district.parcel.h);
      }
    }
  });

  it('says what each head office does, and says nothing for a place', () => {
    for (const building of model.buildings) {
      if (building.kind === 'company') expect(SECTORS, building.key).toContain(building.sector);
      else expect(building.sector, building.key).toBeNull();
    }
    // Six sectors are actually standing on the map, not one repeated.
    const sectors = new Set(model.buildings.filter((entry) => entry.kind === 'company').map((entry) => entry.sector));
    expect(sectors.size).toBe(SECTORS.length);
  });

  it('builds the same city twice, and again three quarters later', () => {
    expect(buildWorldMapModel(input)).toEqual(buildWorldMapModel(input));
    const later = inputFor(resolved(state, 3));
    expect(buildWorldMapModel(later)).toEqual(buildWorldMapModel(later));
    expect(buildWorldMapModel(later).unplaced).toEqual([]);
  });
});

describe('world version 1 is placed exactly as it was', () => {
  const model = buildWorldMapModel(inputFor(createDemoSession()));

  it('places every company in its own district, so the overflow pass never runs', () => {
    for (const building of model.buildings) {
      if (building.kind !== 'company') continue;
      const district = DISTRICT_BY_ID.get(building.districtId);
      const slot = district?.plots.filter((entry) => entry.use === 'company').findIndex((entry) => entry.x === building.x);
      // Every world-1 company sits in one of the first three plots of its
      // district — the rows that existed before the front row was added.
      expect(slot ?? -1, building.key).toBeGreaterThanOrEqual(0);
      expect(slot ?? -1, building.key).toBeLessThan(3);
    }
  });

  it('leaves nobody off the map', () => {
    expect(model.unplaced).toEqual([]);
  });
});
