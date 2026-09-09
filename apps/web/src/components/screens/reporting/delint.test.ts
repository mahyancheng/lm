/**
 * Label coverage: every enum a resolution line or a feed card can embed
 * resolves to a plain-word label, and `delintText` is a backstop for whatever
 * is not in a table yet.
 *
 * These are unit tests over the pure label functions, not over a resolved
 * quarter — `sections.test.ts` covers a real report end to end. This file
 * pins the individual pieces: a phase id, a sim-event type, a leaderboard
 * board, a simulation invariant, a dominant narrative and every legal
 * modifier target path in the contract.
 */

import { describe, expect, it } from 'vitest';
import type { ActiveModifier, SessionState } from '@frontier/contracts';
import {
  DOMINANT_NARRATIVES,
  LEADERBOARD_BOARDS,
  PATTERN_TARGET_PATHS,
  RESOLUTION_PHASES,
  SECTOR_IDS,
  SIMULATION_INVARIANTS,
  SIM_EVENT_TYPES,
  WORLD_EVENT_TYPES,
  WORLD_TARGET_PATH_LIST,
} from '@frontier/contracts';
import { createWorld2Session } from '@frontier/simulation';
import { delintText, humanise, invariantLabel, narrativeLabel, phaseLabel, targetPathLabel, titleise, visibleActiveModifiers } from './util';

/** A lowercase identifier with at least one underscore. */
const SNAKE_TOKEN_RE = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/;

function session(): SessionState {
  return createWorld2Session();
}

describe('every resolution phase id has a plain label', () => {
  it.each(RESOLUTION_PHASES)('%s', (phase) => {
    const label = phaseLabel(phase);
    expect(label.length).toBeGreaterThan(0);
    expect(label).not.toMatch(SNAKE_TOKEN_RE);
    expect(label).not.toBe(phase);
  });

  it('gives the two labels the task names verbatim', () => {
    expect(phaseLabel('product_demand_resolution')).toBe('Product demand');
    expect(humanise('cost_recognised')).toBe('Cost recognised');
  });
});

describe('every simulation invariant has a plain label', () => {
  it.each(SIMULATION_INVARIANTS)('%s', (invariant) => {
    const label = invariantLabel(invariant);
    expect(label).not.toMatch(SNAKE_TOKEN_RE);
    expect(label).not.toBe(invariant);
  });

  it('never reads as the US benefits programme', () => {
    expect(invariantLabel('social_security')).not.toMatch(/\bsocial security\b/i);
  });
});

describe('every dominant narrative has a plain label', () => {
  it.each(DOMINANT_NARRATIVES)('%s', (value) => {
    expect(narrativeLabel(value)).not.toMatch(SNAKE_TOKEN_RE);
  });
});

describe('every sim-event type and world-event type humanises to a plain phrase', () => {
  it.each(SIM_EVENT_TYPES)('sim event: %s', (type) => {
    expect(humanise(type)).not.toMatch(SNAKE_TOKEN_RE);
  });
  it.each(WORLD_EVENT_TYPES)('world event: %s', (type) => {
    expect(humanise(type)).not.toMatch(SNAKE_TOKEN_RE);
  });
  it.each(LEADERBOARD_BOARDS)('leaderboard board: %s', (board) => {
    expect(humanise(board)).not.toMatch(SNAKE_TOKEN_RE);
  });
  it.each(SECTOR_IDS)('world sector id: %s', (id) => {
    expect(titleise(id)).not.toMatch(SNAKE_TOKEN_RE);
  });
});

describe('every legal modifier target path renders as a plain label', () => {
  const state = session();

  it.each(WORLD_TARGET_PATH_LIST)('%s', (path) => {
    const label = targetPathLabel(path, state);
    expect(label.length).toBeGreaterThan(0);
    expect(label).not.toMatch(SNAKE_TOKEN_RE);
  });

  it.each(PATTERN_TARGET_PATHS.map((spec) => spec.template))('pattern: %s', (template) => {
    // Concretise the pattern with a real id from the session, exactly as the
    // engine would when it names one company or one sector.
    const isCompany = template.startsWith('company.');
    const concreteId = isCompany ? (state.companies[0]?.id ?? 'cmp_unknown') : 'semiconductors';
    const path = template.replace(/\{[a-zA-Z]+\}/, concreteId);
    const label = targetPathLabel(path, state);
    expect(label.length).toBeGreaterThan(0);
    expect(label).not.toMatch(SNAKE_TOKEN_RE);
  });
});

describe('visibleActiveModifiers', () => {
  function modifier(target: string): ActiveModifier {
    return {
      id: `mod_${target}`,
      source: 'event',
      target,
      operation: 'add',
      value: 0.05,
      decay: 'none',
      durationQuarters: 4,
      remainingQuarters: 2,
      appliedAtQuarter: 1,
      originEventId: null,
      reason: 'test fixture',
      elapsedQuarters: 1,
      effectiveValue: 0.05,
      lastAppliedQuarter: 1,
      exhausted: false,
    };
  }

  it('keeps every world-wide and sector-wide modifier', () => {
    const modifiers = [modifier('world.compute.spotPrice'), modifier('sector.semiconductors.sentiment')];
    expect(visibleActiveModifiers(modifiers, new Set(['cmp_me']))).toHaveLength(2);
  });

  it('keeps a modifier that names this seat\'s own company', () => {
    const modifiers = [modifier('company.cmp_me.reputationPublic')];
    expect(visibleActiveModifiers(modifiers, new Set(['cmp_me']))).toEqual(modifiers);
  });

  it('withholds a modifier that privately names another company', () => {
    const modifiers = [modifier('company.cmp_rival.attritionRate')];
    expect(visibleActiveModifiers(modifiers, new Set(['cmp_me']))).toEqual([]);
  });

  it('is a straightforward filter: it never adds or duplicates', () => {
    const modifiers = [modifier('world.macro.gdpGrowth'), modifier('company.cmp_rival.costMultiplier'), modifier('company.cmp_me.demandMultiplier')];
    const visible = visibleActiveModifiers(modifiers, new Set(['cmp_me']));
    expect(visible.length).toBeLessThanOrEqual(modifiers.length);
    for (const entry of visible) expect(modifiers).toContain(entry);
  });
});

describe('delintText', () => {
  const state = session();

  it('replaces a company id embedded in prose with the company name', () => {
    const company = state.companies[0];
    if (company === undefined) throw new Error('world-2 session has no companies');
    const text = `${company.id}'s gross additions rose this quarter.`;
    const delinted = delintText(text, state);
    expect(delinted).toContain(company.name);
    expect(delinted).not.toContain(company.id);
  });

  it('replaces a known enum token embedded in prose with its label', () => {
    const text = 'The dominant press narrative shifted from ai_optimism to energy_backlash.';
    const delinted = delintText(text, state);
    expect(delinted).toBe('The dominant press narrative shifted from AI optimism to Energy backlash.');
    expect(delinted).not.toMatch(SNAKE_TOKEN_RE);
  });

  it('humanises an unknown snake_case token rather than leaving it raw', () => {
    const delinted = delintText('A totally_unmapped_token appeared.', state);
    expect(delinted).not.toMatch(SNAKE_TOKEN_RE);
    expect(delinted).toContain('Totally unmapped token');
  });

  it('leaves ordinary prose untouched', () => {
    const text = 'Revenue rose 12% this quarter, driven by enterprise demand.';
    expect(delintText(text, state)).toBe(text);
  });

  it('is pure: the same text and session delint the same way twice', () => {
    const text = `${state.companies[0]?.id ?? 'cmp_x'} shifted from bubble_concern to scandal_cycle.`;
    expect(delintText(text, state)).toBe(delintText(text, state));
  });
});
