/**
 * The office scene is a picture of committed state, so its whole model is a
 * pure function and every claim it makes is testable without a DOM.
 *
 * What this file pins:
 *
 * 1. **Determinism.** The same seat id yields the same face forever, and the
 *    model built twice from the same state is deeply equal. This is the rule
 *    that stops the office flickering between a server render and its
 *    hydration, and it is the reason no component in the folder may reach for
 *    `Math.random`.
 * 2. **Honest scaling.** A crowd larger than the room is drawn at a stated
 *    ratio, never truncated silently; open roles are allocated, never invented;
 *    racks stand for a stated number of accelerators.
 * 3. **Agreement with the engine.** The zone headcounts are the engine's
 *    `EmployeeBase`, the accelerators are `ComputeHoldings`, and both still add
 *    up after three quarters have resolved.
 */

import { describe, expect, it } from 'vitest';
import { STAFF_ROLES } from '@frontier/contracts';
import type { SessionState } from '@frontier/contracts';
import { createDefaultEngine, createDemoSession } from '@frontier/simulation';
import { buildOfficeModel, moraleBand, rackPlan, RACK_CAP, WORK_ZONES } from './model';
import { allocate, crowd, seatId, seatLook } from './seats';

function playerCompany(state: SessionState) {
  const company = state.companies.find((entry) => entry.controllerPlayerId === 'player_1');
  if (company === undefined) throw new Error('no player company');
  return company;
}

function modelFor(state: SessionState) {
  const company = playerCompany(state);
  return buildOfficeModel({
    session: state,
    company,
    projects: state.researchProjects.filter((project) => project.companyId === company.id),
    characters: state.characters,
  });
}

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

/* -------------------------------------------------------------------------- */

describe('office seats: deterministic appearance', () => {
  it('the same seat id always yields the same look', () => {
    const id = seatId('cmp_player_ventures', 'engineering', 3);
    expect(seatLook(id)).toEqual(seatLook(id));
    expect(seatLook(id)).toEqual(seatLook('cmp_player_ventures/engineering/3'));
  });

  it('different seats differ, and every index stays inside its ramp', () => {
    const looks = Array.from({ length: 64 }, (_, index) => seatLook(seatId('cmp_a', 'engineering', index)));
    for (const look of looks) {
      expect(look.skin).toBeGreaterThanOrEqual(0);
      expect(look.skin).toBeLessThan(5);
      expect(look.hairStyle).toBeLessThan(6);
      expect(look.hairColour).toBeLessThan(6);
      expect(look.outfit).toBeLessThan(3);
      expect(look.bobDurationMs).toBeGreaterThan(0);
      expect(look.bobDelayMs).toBeGreaterThanOrEqual(0);
      expect([-1, 0, 1]).toContain(look.lean);
    }
    // Not everybody is a clone: the hash spreads the ramp.
    expect(new Set(looks.map((look) => `${look.skin}/${look.hairStyle}/${look.hairColour}`)).size).toBeGreaterThan(12);
  });

  it('scopes a seat by company, so two companies never share a face by accident', () => {
    expect(seatLook(seatId('cmp_a', 'engineering', 0))).not.toEqual(seatLook(seatId('cmp_b', 'engineering', 0)));
  });
});

describe('office crowd scaling', () => {
  it('draws everyone one-for-one under capacity', () => {
    expect(crowd(0, 12)).toEqual({ figures: 0, perFigure: 1 });
    expect(crowd(7, 12)).toEqual({ figures: 7, perFigure: 1 });
    expect(crowd(12, 12)).toEqual({ figures: 12, perFigure: 1 });
  });

  it('states the ratio once the room is over capacity, and never overfills it', () => {
    const big = crowd(400, 12);
    expect(big.figures).toBeLessThanOrEqual(12);
    expect(big.perFigure).toBe(Math.ceil(400 / 12));
    expect(big.figures * big.perFigure).toBeGreaterThanOrEqual(400 - big.perFigure);
  });
});

describe('open-role allocation', () => {
  it('gives out exactly the total, and nothing when there is nothing to give', () => {
    expect(allocate(0, [10, 5, 1])).toEqual([0, 0, 0]);
    expect(allocate(7, [0, 0, 0])).toEqual([0, 0, 0]);
    const split = allocate(7, [10, 5, 1]);
    expect(split.reduce((sum, value) => sum + value, 0)).toBe(7);
    expect(split.every((value) => value >= 0)).toBe(true);
  });

  it('is stable and proportional', () => {
    expect(allocate(10, [50, 30, 20])).toEqual([5, 3, 2]);
    expect(allocate(10, [50, 30, 20])).toEqual(allocate(10, [50, 30, 20]));
  });
});

describe('server room racks', () => {
  it('never draws more than the cap, and states what a rack stands for', () => {
    expect(rackPlan(0)).toEqual({ racks: 0, acceleratorsPerRack: 256 });
    for (const fleet of [1, 255, 256, 2000, 25_000, 4_000_000]) {
      const plan = rackPlan(fleet);
      expect(plan.racks).toBeLessThanOrEqual(RACK_CAP);
      expect(plan.racks).toBeGreaterThanOrEqual(1);
      expect(plan.racks * plan.acceleratorsPerRack).toBeGreaterThanOrEqual(fleet);
    }
  });
});

describe('morale bands', () => {
  it('band the way the Meter primitive bands, so the office and the meter agree', () => {
    expect(moraleBand(88)).toBe('thriving');
    expect(moraleBand(70)).toBe('thriving');
    expect(moraleBand(69)).toBe('steady');
    expect(moraleBand(45)).toBe('steady');
    expect(moraleBand(44)).toBe('strained');
    expect(moraleBand(25)).toBe('strained');
    expect(moraleBand(24)).toBe('unhappy');
  });
});

describe('office model: built from committed state only', () => {
  it('mirrors the engine at quarter 0', () => {
    const state = createDemoSession();
    const company = playerCompany(state);
    const model = modelFor(state);

    expect(model.companyId).toBe(company.id);
    expect(model.headcount).toBe(STAFF_ROLES.reduce((total, role) => total + company.employees[role], 0));
    expect(model.morale).toBe(company.employees.morale);
    expect(model.lobby.openRoles).toBe(company.employees.openRoles);
    expect(model.lobby.companyName).toBe(company.name);
    expect(model.lobby.sites).toBe(company.offices.length);
    expect(model.server.owned).toBe(company.compute.ownedAccelerators);
    expect(model.server.reserved).toBe(company.compute.reservedAccelerators);
    expect(model.server.utilisation).toBe(company.compute.computeUtilisation);
    expect(model.execHeadcount).toBe(company.employees.execs);
    expect(model.activeProducts).toBe(company.products.filter((product) => product.isActive).length);

    for (const zone of model.zones) {
      expect(zone.headcount).toBe(company.employees[zone.role]);
    }
    expect(model.zones.map((zone) => zone.id)).toEqual(WORK_ZONES.map((zone) => zone.id));
  });

  it('is deterministic: two builds of the same state are identical', () => {
    const state = createDemoSession();
    expect(modelFor(state)).toEqual(modelFor(state));
  });

  it('never draws more desks than a room holds, vacancies included', () => {
    const state = createDemoSession();
    const model = modelFor(state);
    model.zones.forEach((zone, index) => {
      const capacity = WORK_ZONES[index]?.capacity ?? 0;
      expect(zone.seats.length).toBeLessThanOrEqual(capacity);
      expect(zone.seats.filter((seat) => seat.filled).length).toBe(zone.crowd.figures);
      expect(zone.seats.filter((seat) => !seat.filled).length).toBe(zone.vacantDesks);
      expect(new Set(zone.seats.map((seat) => seat.id)).size).toBe(zone.seats.length);
    });
  });

  it('holds after three resolved quarters', () => {
    const state = resolved(3);
    const company = playerCompany(state);
    const model = modelFor(state);

    expect(state.quarter).toBe(3);
    expect(model.headcount).toBe(STAFF_ROLES.reduce((total, role) => total + company.employees[role], 0));
    expect(model.server.held).toBeGreaterThanOrEqual(0);
    expect(model.server.cloudUnits).toBeGreaterThanOrEqual(0);
    expect(model.server.racks).toBeLessThanOrEqual(RACK_CAP);
    expect(model.band).toBe(moraleBand(company.employees.morale));

    // The expiry warning is a reading of state, not a guess.
    const expiry = company.compute.reservationExpiryQuarter;
    expect(model.server.quartersToExpiry).toBe(expiry === null ? null : expiry - state.quarter);
    expect(model.server.expiryWarning).toBe(
      company.compute.reservedAccelerators > 0 && expiry !== null && expiry - state.quarter <= 2,
    );
  });

  it('only ever shows the player their own leadership', () => {
    const state = createDemoSession();
    const company = playerCompany(state);
    const model = modelFor(state);
    for (const executive of model.executives) {
      const character = state.characters.find((entry) => entry.id === executive.characterId);
      expect(character?.companyId).toBe(company.id);
      expect(character?.isActive).toBe(true);
    }
    expect(model.executives.length).toBeLessThanOrEqual(5);
  });
});
