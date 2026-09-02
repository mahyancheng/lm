/**
 * The strings a save wears in the interface.
 *
 * Two invariants matter here. The classic-world fallbacks must match the
 * scenario's names byte for byte, because "Continue Player Ventures" is a
 * promise about which company loads. And every formatter must be total over
 * the fields a stored file can actually lack — a v1–v3 file has no timestamp,
 * a hand-edited one may have nothing but a version — without ever throwing on
 * a menu render.
 *
 * Relative imports throughout: the `@/` alias is wired up in vitest.config.mts
 * only so the modules under test can resolve their own imports; test files
 * keep to relative paths.
 */

import { describe, expect, it } from 'vitest';
import { NewGameSetupSchema } from '@frontier/contracts';
import type { SlotSummary } from './persistence';
import {
  DEFAULT_COMPANY_NAME,
  DEFAULT_FOUNDER_NAME,
  continueLabel,
  savedCompanyName,
  savedFounderName,
  shortSavedAt,
  slotDetailLine,
  slotOverwriteLabel,
} from './saveDisplay';

/** A fixed "today", so the year-elision branch does not depend on the wall clock. */
const NOW = (): Date => new Date('2027-06-15T12:00:00.000Z');

function summary(partial: Partial<SlotSummary>): SlotSummary {
  return {
    slot: 1,
    status: 'ok',
    version: 4,
    savedQuarter: 5,
    seed: 424242,
    difficulty: 'standard',
    companyName: 'Northwind AI',
    founderName: 'Rae Fontaine',
    worldVersion: 1,
    savedAtIso: '2027-03-02T09:30:00.000Z',
    ...partial,
  };
}

describe('classic-world fallbacks', () => {
  it('uses the setup names when a save has them', () => {
    const setup = { companyName: 'Northwind AI', founderName: 'Rae Fontaine' };
    expect(savedCompanyName(setup)).toBe('Northwind AI');
    expect(savedFounderName(setup)).toBe('Rae Fontaine');
  });

  it('falls back to Player Ventures and Avery Sinclair for a null setup', () => {
    expect(savedCompanyName(null)).toBe(DEFAULT_COMPANY_NAME);
    expect(savedFounderName(null)).toBe(DEFAULT_FOUNDER_NAME);
    expect(DEFAULT_COMPANY_NAME).toBe('Player Ventures');
    expect(DEFAULT_FOUNDER_NAME).toBe('Avery Sinclair');
  });
});

describe('continueLabel', () => {
  it('names the company and the quarter it stands at', () => {
    expect(
      continueLabel({ setup: NewGameSetupSchema.parse({ companyName: 'Northwind AI', founderName: 'Rae Fontaine', backgroundId: 'enterprise_ai' }), savedQuarter: 5 }),
    ).toBe('Continue Northwind AI — 2028 Q2');
  });

  it('labels a classic-world save without inventing a name', () => {
    expect(continueLabel({ setup: null, savedQuarter: 0 })).toBe('Continue Player Ventures — 2027 Q1');
  });
});

describe('shortSavedAt', () => {
  it('elides the current year and keeps any other', () => {
    expect(shortSavedAt('2027-03-02T09:30:00.000Z', NOW)).toBe('2 Mar');
    expect(shortSavedAt('2026-11-20T09:30:00.000Z', NOW)).toBe('20 Nov 2026');
  });

  it('returns null for the stamp a v1–v3 file lacks, and for garbage', () => {
    expect(shortSavedAt(null, NOW)).toBeNull();
    expect(shortSavedAt('not a date', NOW)).toBeNull();
  });
});

describe('slotDetailLine', () => {
  it('joins quarter, difficulty and the advisory date', () => {
    expect(slotDetailLine(summary({}), NOW)).toBe('2028 Q2 · standard · saved 2 Mar');
  });

  it('renders only the parts a sparse file actually has', () => {
    expect(slotDetailLine(summary({ difficulty: null, savedAtIso: null }), NOW)).toBe('2028 Q2');
    expect(slotDetailLine(summary({ savedQuarter: null, difficulty: null, savedAtIso: null }), NOW)).toBe('');
  });
});

describe('slotOverwriteLabel', () => {
  it('names the occupant an ok slot would lose', () => {
    expect(slotOverwriteLabel(summary({}))).toBe('Slot 1 — overwrites Northwind AI · 2028 Q2');
    expect(slotOverwriteLabel(summary({ companyName: null, savedQuarter: null }))).toBe('Slot 1 — overwrites Player Ventures');
  });

  it('tells the truth about the other three statuses', () => {
    expect(slotOverwriteLabel(summary({ slot: 2, status: 'absent' }))).toBe('Slot 2 — empty');
    expect(slotOverwriteLabel(summary({ slot: 3, status: 'unsupported' }))).toBe('Slot 3 — newer build, preserved');
    expect(slotOverwriteLabel(summary({ status: 'unreadable' }))).toBe('Slot 1 — overwrites an unreadable file');
  });
});
