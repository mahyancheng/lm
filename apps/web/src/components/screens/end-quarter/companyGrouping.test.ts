/**
 * STAGE 5 — `groupQueueByCompany`: End Quarter's per-company commitment.
 */

import { describe, expect, it } from 'vitest';
import { NewGameSetupSchema } from '@frontier/contracts';
import { groupQueueByCompany } from './companyGrouping';
import { PLAYER_ID, buildSubmittedActionForCompany, createSession, playerCompanyOf, validateSubmittedAction } from '@/lib/game';
import type { QueuedActionEntry } from '@/lib/game';

const SEED = 424242;

const WORLD2_SETUP = NewGameSetupSchema.parse({
  companyName: 'Kestrel Dynamics',
  founderName: 'Rae Fontaine',
  backgroundId: 'humanoid_lab',
  sector: 'robotics',
  region: 'east_asia',
  worldVersion: 2,
});

function entryFor(session: ReturnType<typeof createSession>, companyId: string, budgetUsd: number, sequence: number): QueuedActionEntry {
  const action = buildSubmittedActionForCompany(session, { type: 'set_research_budget', budgetUsd }, sequence, companyId, {
    confirmedByHuman: true,
  });
  const validation = validateSubmittedAction(session, action);
  return { action, validation, needsConfirmation: false, blocked: false };
}

describe('groupQueueByCompany', () => {
  it('is empty for an empty queue', () => {
    const session = createSession({ seed: SEED });
    expect(groupQueueByCompany(session, [], PLAYER_ID)).toEqual([]);
  });

  it('puts everything under the founding company when nothing names a subsidiary', () => {
    const session = createSession({ seed: SEED });
    const foundingId = playerCompanyOf(session).id;
    const entry = entryFor(session, foundingId, 400_000, 0);
    const groups = groupQueueByCompany(session, [entry], PLAYER_ID);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.company.id).toBe(foundingId);
    expect(groups[0]?.entries).toHaveLength(1);
    expect(groups[0]?.outflowUsd).toBe(400_000);
  });

  it('splits the queue by acting company, founding company first, each with its own cash-after', () => {
    const session = createSession({ seed: SEED, setup: WORLD2_SETUP });
    const foundingId = playerCompanyOf(session).id;
    const subsidiary = session.companies.find(
      (company) => company.isActive && company.id !== foundingId && company.controllerPlayerId === null,
    );
    if (subsidiary === undefined) throw new Error('world 2 seed carries no other active company to make a subsidiary of.');
    subsidiary.controllerPlayerId = PLAYER_ID;

    const foundingEntry = entryFor(session, foundingId, 250_000, 0);
    const subsidiaryEntry = entryFor(session, subsidiary.id, 150_000, 1);
    const groups = groupQueueByCompany(session, [foundingEntry, subsidiaryEntry], PLAYER_ID);

    expect(groups.map((group) => group.company.id)).toEqual([foundingId, subsidiary.id]);

    const foundingGroup = groups[0];
    const subsidiaryGroup = groups[1];
    if (foundingGroup === undefined || subsidiaryGroup === undefined) throw new Error('expected two groups');

    expect(foundingGroup.entries).toHaveLength(1);
    expect(foundingGroup.outflowUsd).toBe(250_000);
    expect(foundingGroup.availableUsd).toBe(playerCompanyOf(session).financials.cash);
    expect(foundingGroup.afterUsd).toBe(foundingGroup.availableUsd - 250_000);

    expect(subsidiaryGroup.entries).toHaveLength(1);
    expect(subsidiaryGroup.outflowUsd).toBe(150_000);
    expect(subsidiaryGroup.availableUsd).toBe(subsidiary.financials.cash);
    expect(subsidiaryGroup.afterUsd).toBe(subsidiary.financials.cash - 150_000);

    // Never pooled: the subsidiary's commitment does not touch the founding
    // company's own available cash, and vice versa.
    expect(subsidiaryGroup.availableUsd).not.toBe(foundingGroup.availableUsd);
  });

  it('excludes a rejected entry from the cash total but keeps it in the row for the reason to be shown', () => {
    const session = createSession({ seed: SEED });
    const foundingId = playerCompanyOf(session).id;
    const good = entryFor(session, foundingId, 200_000, 0);
    // Doctored to a player with no seat: refused on its own terms, exactly
    // as `validateSubmittedAction` judges any stored action.
    const rejectedAction = buildSubmittedActionForCompany(session, { type: 'set_research_budget', budgetUsd: 900_000 }, 1, foundingId);
    const ghost: QueuedActionEntry = {
      action: { ...rejectedAction, actorPlayerId: 'player_ghost' },
      validation: validateSubmittedAction(session, { ...rejectedAction, actorPlayerId: 'player_ghost' }),
      needsConfirmation: false,
      blocked: false,
    };
    expect(ghost.validation.status).toBe('rejected');

    const groups = groupQueueByCompany(session, [good, ghost], PLAYER_ID);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.entries).toHaveLength(2);
    // Only the accepted entry's cost counts toward the commitment.
    expect(groups[0]?.outflowUsd).toBe(200_000);
  });
});
