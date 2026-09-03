/**
 * STAGE 5 — `controlledCompanyRows`: the switcher and Group screen's shared
 * selector over `controlledCompaniesOf`.
 */

import { describe, expect, it } from 'vitest';
import { NewGameSetupSchema } from '@frontier/contracts';
import { controlledCompanyRows, hasGroup } from './group';
import { PLAYER_ID, createSession, playerCompanyOf } from './engine';

const SEED = 424242;

const WORLD2_SETUP = NewGameSetupSchema.parse({
  companyName: 'Kestrel Dynamics',
  founderName: 'Rae Fontaine',
  backgroundId: 'humanoid_lab',
  sector: 'robotics',
  region: 'east_asia',
  worldVersion: 2,
});

describe('controlledCompanyRows', () => {
  it('is just the founding company, at full control, with no engine subsidiary concept', () => {
    const session = createSession({ seed: SEED });
    const rows = controlledCompanyRows(session, PLAYER_ID);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.company.id).toBe(playerCompanyOf(session).id);
    expect(rows[0]?.isFounding).toBe(true);
    expect(rows[0]?.controlPct).toBe(1);
    expect(hasGroup(session, PLAYER_ID)).toBe(false);
  });

  it('lists a controlled subsidiary after the founding company, in controlledCompaniesOf order', () => {
    const session = createSession({ seed: SEED, setup: WORLD2_SETUP });
    const foundingId = playerCompanyOf(session).id;
    const subsidiary = session.companies.find(
      (company) => company.isActive && company.id !== foundingId && company.controllerPlayerId === null,
    );
    if (subsidiary === undefined) throw new Error('world 2 seed carries no other active company to make a subsidiary of.');
    subsidiary.controllerPlayerId = PLAYER_ID;

    const rows = controlledCompanyRows(session, PLAYER_ID);
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows[0]?.company.id).toBe(foundingId);
    expect(rows[0]?.isFounding).toBe(true);
    expect(rows.some((row) => row.company.id === subsidiary.id && !row.isFounding)).toBe(true);
    expect(hasGroup(session, PLAYER_ID)).toBe(true);

    // Every row's headcount matches the sum on the company itself — no invented arithmetic.
    for (const row of rows) {
      const staff = row.company.employees;
      expect(row.headcount).toBe(staff.engineers + staff.researchers + staff.sales + staff.ops + staff.execs);
      expect(row.negativeCashQuarters).toBeGreaterThanOrEqual(0);
    }
  });
});
