/**
 * The Chief of Staff's context, re-keyed from routes onto sheets.
 *
 * The game used to be twenty-two routes and this table was keyed by pathname.
 * It is now five tabs with every drill-down addressed by `?sheet=`, so the key
 * is the *subject*: the open sheet, else the tab, else — for the one frame the
 * catch-all takes to redirect off an old address — the sheet that old route
 * became.
 *
 * That last fallback is the reason the dock never goes blank mid-redirect, and
 * it is why the older assertions in `chiefOfStaff.test.ts` still hold verbatim.
 *
 * Also pinned here: `hrefOfAction`, which is what the interpretation card now
 * reads instead of its own copy of the map. Four entries used to point at the
 * wrong screen, and the eleven with no by-hand surface used to point at one
 * anyway.
 *
 * Relative imports throughout: test files keep to them, per `vitest.config.mts`.
 */

import { describe, expect, it } from 'vitest';
import { ACTION_TYPES } from '@frontier/contracts';
import { CHIEF_ONLY_ACTIONS, SHEETS, allSheetIds, hrefOfAction, sheetHref } from '../../../lib/sheets';
import { TABS } from '../../../lib/nav';
import { contextKeyOf, quickPromptsFor, screenLabelFor } from './quickPrompts';

/* -------------------------------------------------------------------------- */
/*  Which subject a question is about                                          */
/* -------------------------------------------------------------------------- */

describe('contextKeyOf', () => {
  it('takes the open sheet over the tab it is open on', () => {
    expect(contextKeyOf('/company', 'financials')).toBe('financials');
    expect(contextKeyOf('/world', 'news')).toBe('news');
    // A sheet named over a tab that does not own it is still that sheet: the
    // host is already redirecting, and the founder is looking at the sheet.
    expect(contextKeyOf('/home', 'capital')).toBe('capital');
  });

  it('falls back to the tab when no sheet is open', () => {
    for (const tab of TABS) expect(contextKeyOf(tab.href, null)).toBe(tab.id);
  });

  it('reads an old address as the subject it became', () => {
    expect(contextKeyOf('/capital')).toBe('capital');
    expect(contextKeyOf('/markets')).toBe('exchange');
    expect(contextKeyOf('/deal-room')).toBe('deals');
    expect(contextKeyOf('/command-centre')).toBe('home');
    expect(contextKeyOf('/end-quarter')).toBe('play');
    expect(contextKeyOf('/financials/history')).toBe('financials');
  });

  it('is empty off the game entirely', () => {
    expect(contextKeyOf('/somewhere-nobody-built')).toBe('');
  });
});

/* -------------------------------------------------------------------------- */
/*  The prompts                                                                */
/* -------------------------------------------------------------------------- */

describe('quickPromptsFor', () => {
  it('returns the financials set for the financials sheet, whatever tab it is on', () => {
    const prompts = quickPromptsFor('/company', 'financials');
    expect(prompts).toHaveLength(4);
    expect(prompts[0]?.send).toContain('Financials screen');
    expect(prompts.map((prompt) => prompt.label)).toContain('How much runway?');
    expect(screenLabelFor('/company', 'financials')).toBe('Financials');
  });

  it('returns the World set for the bare World tab', () => {
    const prompts = quickPromptsFor('/world', null);
    expect(prompts).toHaveLength(4);
    expect(prompts[0]?.send).toContain('World screen');
    expect(prompts.map((prompt) => prompt.label)).toContain('What changed out there?');
    expect(screenLabelFor('/world', null)).toBe('World');
  });

  it('gives every one of the five tabs a set of its own', () => {
    const labels = TABS.map((tab) => quickPromptsFor(tab.href, null).map((prompt) => prompt.label).join('|'));
    expect(new Set(labels).size).toBe(TABS.length);
    for (const tab of TABS) expect(quickPromptsFor(tab.href, null)).toHaveLength(4);
  });

  it('falls back to the universal pair on a key nobody built', () => {
    const prompts = quickPromptsFor('/somewhere-nobody-built');
    expect(prompts).toHaveLength(4);
    expect(prompts.map((prompt) => prompt.label)).toEqual([
      'Explain these numbers',
      'What should I do here?',
      'How are we doing?',
      'What needs deciding?',
    ]);
    expect(screenLabelFor('/somewhere-nobody-built')).toBe('this');
  });

  it('names every sheet in the registry rather than calling one "this"', () => {
    // A sheet with no questions of its own still gets its own name on the two
    // universals — "the Portfolio screen", never "the this screen".
    for (const sheet of allSheetIds()) {
      expect(screenLabelFor('/home', sheet), sheet).not.toBe('this');
      const prompts = quickPromptsFor('/home', sheet);
      expect(prompts.length, sheet).toBeGreaterThanOrEqual(4);
      for (const prompt of prompts) {
        expect(prompt.label.length, sheet).toBeGreaterThan(0);
        expect(prompt.send.length, sheet).toBeGreaterThan(10);
        // Never a machine name in front of a founder.
        expect(prompt.send, sheet).not.toMatch(/_[a-z]+_/);
      }
    }
  });

  it('names the sheet the same way the registry does, where it has an entry of its own', () => {
    expect(screenLabelFor('/market', 'exchange')).toBe(SHEETS.exchange.title);
    expect(screenLabelFor('/market', 'portfolio')).toBe(SHEETS.portfolio.title);
  });
});

/* -------------------------------------------------------------------------- */
/*  Where an action is done by hand                                            */
/* -------------------------------------------------------------------------- */

describe('hrefOfAction', () => {
  it('sends the four that used to point at the wrong screen to the right one', () => {
    expect(hrefOfAction('set_marketing_budget')?.startsWith('/company?sheet=products')).toBe(true);
    expect(hrefOfAction('allocate_compute')).toBe(sheetHref('research'));
    expect(hrefOfAction('set_logistics_toll')).toBe(sheetHref('sector'));
    expect(hrefOfAction('transfer_between_group')).toBe(sheetHref('group'));
    expect(hrefOfAction('merge_subsidiary')).toBe(sheetHref('group'));
  });

  it('is null for exactly the eleven only the Chief of Staff can queue', () => {
    expect(hrefOfAction('ipo')).toBeNull();
    const nulls = ACTION_TYPES.filter((type) => hrefOfAction(type) === null);
    expect([...nulls].sort()).toEqual([...CHIEF_ONLY_ACTIONS].sort());
    expect(nulls).toHaveLength(11);
  });

  it('gives every other action an address on the tab that owns its sheet', () => {
    for (const type of ACTION_TYPES) {
      const href = hrefOfAction(type);
      if (href === null) continue;
      expect(href.startsWith('/'), type).toBe(true);
      expect(href, type).toContain('?sheet=');
    }
  });
});
