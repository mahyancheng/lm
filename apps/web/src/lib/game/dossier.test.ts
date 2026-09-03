/**
 * The Chief of Staff dossier: what the role is handed, and what it must never
 * be handed.
 *
 * The load-bearing claim under test is the available-actions list. It is built
 * by probing the engine's own validator, so every entry has to agree with what
 * the validator would actually say — a bound it would reject can never appear
 * as available, and the confirmation flags are the always-confirm set itself
 * rather than a second copy of it.
 */

import { describe, expect, it } from 'vitest';
import { CONFIRMATION_REQUIRED_ACTIONS, ChiefOfStaffDossierSchema, ChiefOfStaffInputSchema } from '@frontier/contracts';
import { createSession, playerCompanyOf } from './engine';
import { availabilityOf, availableActionsForSession, buildChiefOfStaffDossier } from './dossier';
import { buildChiefOfStaffInput } from './briefings';

describe('buildChiefOfStaffDossier', () => {
  const session = createSession();
  const dossier = buildChiefOfStaffDossier(session);

  it('parses against the contract', () => {
    const parsed = ChiefOfStaffDossierSchema.safeParse(dossier);
    expect(parsed.success).toBe(true);
  });

  it('is the player\'s own company, in full', () => {
    expect(dossier.companyName).toBe('Player Ventures');
    expect(dossier.finances.cashUsd).toBe(playerCompanyOf(session).financials.cash);
    expect(dossier.people.total).toBeGreaterThan(0);
    expect(dossier.products.lines.length).toBeGreaterThan(0);
  });

  it('withholds a private rival\'s financials rather than reporting them as zero', () => {
    const own = playerCompanyOf(session);
    const taken = session.companies.find((entry) => entry.id !== own.id && entry.isActive);
    expect(taken).toBeDefined();
    const withPrivateRival = {
      ...session,
      companies: session.companies.map((entry) => (entry.id === taken?.id ? { ...entry, isPublic: false, ticker: null } : entry)),
    };
    const rival = buildChiefOfStaffDossier(withPrivateRival).markets.rivals.find((entry) => entry.companyId === taken?.id);
    expect(rival?.isPublic).toBe(false);
    // Absent means withheld, never zero: a private company's revenue is not
    // nought, it is undisclosed, and a null is what says so.
    expect(rival?.revenueQuarterlyUsd).toBeNull();
    expect(rival?.marketCapUsd).toBeNull();
  });

  it('reports a public rival from the public record', () => {
    const listed = dossier.markets.rivals.find((rival) => rival.isPublic);
    expect(listed).toBeDefined();
    expect(typeof listed?.revenueQuarterlyUsd).toBe('number');
  });

  it('never names the player\'s own company as a rival', () => {
    expect(dossier.markets.rivals.map((rival) => rival.companyId)).not.toContain(playerCompanyOf(session).id);
  });

  it('reads "no filed quarters yet" as an empty history rather than a zero one', () => {
    // Before the first resolution nothing has been filed. An empty array says
    // that; a row of zeroes would say the company earned nothing.
    expect(dossier.finances.history).toEqual([]);
  });

  it('carries every action type with a verdict', () => {
    expect(dossier.availableActions.length).toBeGreaterThan(30);
    for (const action of dossier.availableActions) {
      if (action.available) expect(action.reason).toBeNull();
      else expect(action.reason).not.toBeNull();
    }
  });

  it('flags exactly the always-confirm set', () => {
    const flagged = dossier.availableActions.filter((action) => action.requiresConfirmation).map((action) => action.type);
    expect([...flagged].sort()).toEqual([...CONFIRMATION_REQUIRED_ACTIONS].sort());
  });

  it('never offers a cash bound above the cash the company holds', () => {
    const cash = dossier.finances.cashUsd;
    for (const action of dossier.availableActions) {
      if (!action.available || action.maxCashUsd === null) continue;
      expect(action.maxCashUsd).toBeLessThanOrEqual(cash + 1);
    }
  });

  it('is deterministic for a given session', () => {
    expect(buildChiefOfStaffDossier(session)).toEqual(dossier);
  });
});

describe('availableActionsForSession', () => {
  it('memoises on the session object and recomputes for a different one', () => {
    const session = createSession();
    expect(availableActionsForSession(session)).toBe(availableActionsForSession(session));
    const other = createSession({ seed: 7 });
    expect(availableActionsForSession(other)).not.toBe(availableActionsForSession(session));
  });

  it('answers for one type', () => {
    const session = createSession();
    expect(availabilityOf(session, 'set_research_budget')?.available).toBe(true);
    expect(availabilityOf(session, 'give_guidance')?.available).toBe(false);
    expect(availabilityOf(session, 'give_guidance')?.reason).toContain('private');
  });
});

describe('buildChiefOfStaffInput', () => {
  const session = createSession();

  it('carries the typed dossier and keeps the prose fields filled', () => {
    const input = buildChiefOfStaffInput(session, 'How are we doing?', []);
    expect(ChiefOfStaffInputSchema.safeParse(input).success).toBe(true);
    expect(input.dossier).toBeDefined();
    expect(input.companyBriefing.length).toBeGreaterThan(0);
    expect(input.worldBriefing.length).toBeGreaterThan(0);
    expect(input.currentBudgets.length).toBeGreaterThan(0);
  });

  it('records the screen the founder asked from, and omits it when they did not', () => {
    expect(buildChiefOfStaffInput(session, 'What is this?', [], { screen: '/capital' }).screen).toBe('/capital');
    expect(buildChiefOfStaffInput(session, 'What is this?', []).screen).toBeUndefined();
  });

  it('never sends a memory: the server owns that', () => {
    // A client-supplied memory would be a client-supplied prompt, and the whole
    // point of holding it server-side is that a request cannot rewrite the
    // founder's standing preferences.
    expect(buildChiefOfStaffInput(session, 'Remember this', []).memory).toBeUndefined();
  });
});
