/**
 * STAGE 5 — the pure company-attribution helpers `engine.ts` adds on top of
 * the founding-company defaults: choosing an acting company explicitly, and
 * reconciling a stored choice against a session that may have moved on.
 */

import { describe, expect, it } from 'vitest';
import { NewGameSetupSchema } from '@frontier/contracts';
import {
  PLAYER_ID,
  buildSubmittedActionForCompany,
  createSession,
  playerCompanyOf,
  resolveActiveCompanyId,
  validateIntentForCompany,
  validateSubmittedAction,
} from './engine';

const SEED = 424242;

const WORLD2_SETUP = NewGameSetupSchema.parse({
  companyName: 'Kestrel Dynamics',
  founderName: 'Rae Fontaine',
  backgroundId: 'humanoid_lab',
  sector: 'robotics',
  region: 'east_asia',
  worldVersion: 2,
});

/** A world-2 session where the seat also controls one NPC company, as a live subsidiary would leave it. */
function sessionWithSubsidiary() {
  const session = createSession({ seed: SEED, setup: WORLD2_SETUP });
  const foundingId = playerCompanyOf(session).id;
  const subsidiary = session.companies.find(
    (company) => company.isActive && company.id !== foundingId && company.controllerPlayerId === null,
  );
  if (subsidiary === undefined) throw new Error('world 2 seed carries no other active company to make a subsidiary of.');
  subsidiary.controllerPlayerId = PLAYER_ID;
  return { session, foundingId, subsidiaryId: subsidiary.id };
}

describe('resolveActiveCompanyId', () => {
  it('answers the founding company for a null candidate', () => {
    const session = createSession({ seed: SEED });
    expect(resolveActiveCompanyId(session, null)).toBe(playerCompanyOf(session).id);
  });

  it('keeps a candidate the seat still controls', () => {
    const { session, subsidiaryId } = sessionWithSubsidiary();
    expect(resolveActiveCompanyId(session, subsidiaryId)).toBe(subsidiaryId);
  });

  it('falls back to the founding company once the candidate is no longer controlled', () => {
    const { session, foundingId, subsidiaryId } = sessionWithSubsidiary();
    // Control lost — sold, wound up, or absorbed by someone else's move.
    const lost = session.companies.find((company) => company.id === subsidiaryId);
    if (lost === undefined) throw new Error('subsidiary vanished from the session');
    lost.controllerPlayerId = null;
    expect(resolveActiveCompanyId(session, subsidiaryId)).toBe(foundingId);
  });

  it('falls back to the founding company for an id that never existed in this session', () => {
    const session = createSession({ seed: SEED });
    expect(resolveActiveCompanyId(session, 'cmp_nonexistent')).toBe(playerCompanyOf(session).id);
  });
});

describe('buildSubmittedActionForCompany', () => {
  it('carries the explicit company, not the founding one', () => {
    const { session, subsidiaryId } = sessionWithSubsidiary();
    const submitted = buildSubmittedActionForCompany(session, { type: 'set_research_budget', budgetUsd: 100_000 }, 0, subsidiaryId);
    expect(submitted.actorCompanyId).toBe(subsidiaryId);
    expect(submitted.actorPlayerId).toBe(PLAYER_ID);
  });
});

describe('validateIntentForCompany', () => {
  it('validates a preview as the named company, not the founding one', () => {
    const { session, foundingId, subsidiaryId } = sessionWithSubsidiary();
    const intent = { type: 'set_research_budget' as const, budgetUsd: 100_000 };

    const asSubsidiary = validateIntentForCompany(session, intent, subsidiaryId);
    expect(asSubsidiary.status).not.toBe('rejected');

    // The same intent, previewed against a company this seat does not
    // control at all, is refused — the preview genuinely answers "as whom?"
    // rather than always answering for the founding company.
    const rival = session.companies.find((company) => company.isActive && company.controllerPlayerId !== PLAYER_ID && company.id !== foundingId);
    if (rival === undefined) throw new Error('no rival company in the world-2 seed');
    const asRival = validateIntentForCompany(session, intent, rival.id);
    expect(asRival.status).toBe('rejected');
    expect(asRival.codes).toContain('not_controller_of_company');
  });
});

describe('validateSubmittedAction', () => {
  it('judges a stored action exactly as it was recorded, not as the current seat', () => {
    const { session, subsidiaryId } = sessionWithSubsidiary();
    const submitted = buildSubmittedActionForCompany(
      session,
      { type: 'set_research_budget', budgetUsd: 100_000 },
      0,
      subsidiaryId,
      { confirmedByHuman: true },
    );
    expect(validateSubmittedAction(session, submitted).status).not.toBe('rejected');

    // Doctored to a player with no seat in this session: this is what a
    // corrupted or hand-edited save entry looks like, and it must still be
    // refused on its own terms.
    const ghost = { ...submitted, actorPlayerId: 'player_ghost' };
    expect(validateSubmittedAction(session, ghost).status).toBe('rejected');
  });
});
