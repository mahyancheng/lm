/**
 * The Chief of Staff's UI helpers: the screen-aware prompts the drawer offers,
 * the bound lines it prints under an action, and the transcript that both
 * surfaces share.
 *
 * Nothing here touches a model or a store; every function under test is pure.
 */

import { describe, expect, it } from 'vitest';
import type { ChiefOfStaffInterpretation } from '@frontier/contracts';
import { ChiefOfStaffInterpretationSchema } from '@frontier/contracts';
import { quickPromptsFor, routeKeyOf, screenLabelFor } from './quickPrompts';
import { boundLabel, limitsOf } from './InterpretationCard';
import { hasProposal } from './Exchange';
import { echoFallback, historyOf, type TranscriptEntry } from './transcript';

/* -------------------------------------------------------------------------- */
/*  Quick prompts                                                              */
/* -------------------------------------------------------------------------- */

describe('quickPromptsFor', () => {
  it('always offers the two universals, naming the screen', () => {
    const prompts = quickPromptsFor('/capital');
    expect(prompts).toHaveLength(4);
    expect(prompts[0]?.label).toBe('Explain these numbers');
    expect(prompts[0]?.send).toContain('Capital screen');
    expect(prompts[1]?.send).toContain('Capital screen');
  });

  it('adds the screen\'s own questions', () => {
    expect(quickPromptsFor('/capital').map((prompt) => prompt.label)).toContain('Should we raise?');
    expect(quickPromptsFor('/products').map((prompt) => prompt.label)).toContain('Best and worst line');
    expect(quickPromptsFor('/people').map((prompt) => prompt.label)).toContain('Can we afford to hire?');
  });

  it('falls back to the general set rather than offering nothing', () => {
    const prompts = quickPromptsFor('/somewhere-nobody-built');
    expect(prompts).toHaveLength(4);
    expect(prompts.map((prompt) => prompt.label)).toContain('How are we doing?');
  });

  it('reads a nested route as its screen', () => {
    expect(routeKeyOf('/financials/history')).toBe('/financials');
    expect(routeKeyOf('/financials/')).toBe('/financials');
    expect(screenLabelFor('/financials/history')).toBe('Financials');
    expect(screenLabelFor('/nothing-here')).toBe('this');
  });

  it('never offers an empty prompt', () => {
    for (const route of ['/capital', '/people', '/research', '/unknown']) {
      for (const prompt of quickPromptsFor(route)) {
        expect(prompt.label.length).toBeGreaterThan(0);
        expect(prompt.send.length).toBeGreaterThan(10);
      }
    }
  });
});

/* -------------------------------------------------------------------------- */
/*  Bounds                                                                     */
/* -------------------------------------------------------------------------- */

describe('boundLabel', () => {
  it('renders each unit in the founder\'s own terms, in whole figures', () => {
    expect(boundLabel({ field: 'budgetUsd', label: 'Research budget', min: 0, max: 4_000_000, unit: 'usd' })).toBe(
      'Research budget: $0 to $4,000,000',
    );
    expect(boundLabel({ field: 'count', label: 'Engineers', min: 1, max: 31, unit: 'count' })).toBe('Engineers: 1 to 31');
    expect(boundLabel({ field: 'floatPct', label: 'Fraction offered', min: 0.05, max: 0.5, unit: 'fraction' })).toBe(
      'Fraction offered: 5% to 50%',
    );
    expect(boundLabel({ field: 'payoutPct', label: 'Payout', min: 0, max: 80, unit: 'percent' })).toBe('Payout: 0% to 80%');
    expect(boundLabel({ field: 'quarters', label: 'Term', min: 1, max: 16, unit: 'quarters' })).toBe('Term: 1q to 16q');
  });

  it('says "no ceiling" rather than inventing one', () => {
    expect(boundLabel({ field: 'amountUsd', label: 'Principal', min: 1, max: null, unit: 'usd' })).toContain('no ceiling');
  });
});

describe('limitsOf', () => {
  it('puts the cash commitment first, then the bounds', () => {
    const lines = limitsOf({
      type: 'hire',
      available: true,
      reason: null,
      becomesBoardMatter: false,
      requiresConfirmation: false,
      bounds: [{ field: 'count', label: 'Engineers at market pay', min: 1, max: 31, unit: 'count' }],
      targets: [],
      maxCashUsd: 3_000_000,
    });
    expect(lines[0]).toBe('Commits up to $3,000,000');
    expect(lines[1]).toBe('Engineers at market pay: 1 to 31');
  });

  it('is empty when the engine had nothing to say about this type', () => {
    expect(limitsOf(null)).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/*  The thread                                                                 */
/* -------------------------------------------------------------------------- */

function interpretation(overrides: Partial<ChiefOfStaffInterpretation> = {}): ChiefOfStaffInterpretation {
  return {
    mode: 'answer',
    reply: 'Cash is $4,000,000 and that is seven quarters of runway.',
    interpretedInstructions: [],
    summary: 'Nothing was interpreted. No binding action has been submitted yet.',
    questions: [],
    requiresConfirmation: true,
    confidence: 0.9,
    unsupportedRequests: [],
    lookups: [],
    ...overrides,
  };
}

function entry(overrides: Partial<TranscriptEntry> = {}): TranscriptEntry {
  return { id: 'e1', quarter: 0, message: 'How are we doing?', interpretation: interpretation(), fallback: false, ...overrides };
}

describe('hasProposal', () => {
  it('is false for a pure answer, so words are not wrapped in an approve button', () => {
    expect(hasProposal(entry())).toBe(false);
  });

  it('is true as soon as there is something to approve, ask or admit', () => {
    expect(hasProposal(entry({ interpretation: interpretation({ interpretedInstructions: [{ type: 'set_research_budget', budgetUsd: 1 }] }) }))).toBe(true);
    expect(hasProposal(entry({ interpretation: interpretation({ questions: ['By how much?'] }) }))).toBe(true);
    expect(hasProposal(entry({ interpretation: interpretation({ unsupportedRequests: ['Fire the board.'] }) }))).toBe(true);
  });
});

describe('historyOf', () => {
  it('carries the reply, which is what the founder read', () => {
    const turns = historyOf([entry()]);
    expect(turns).toHaveLength(2);
    expect(turns[0]).toEqual({ role: 'player', text: 'How are we doing?' });
    expect(turns[1]?.text).toContain('seven quarters of runway');
  });

  it('is bounded, so a forty-quarter thread does not become the prompt', () => {
    const many = Array.from({ length: 40 }, (_, index) => entry({ id: `e${index}`, message: `m${index}` }));
    expect(historyOf(many)).toHaveLength(12);
  });
});

describe('echoFallback', () => {
  it('answers nothing, interprets nothing and parses', () => {
    const result = echoFallback('Cut marketing by half.');
    expect(ChiefOfStaffInterpretationSchema.safeParse(result).success).toBe(true);
    expect(result.mode).toBe('answer');
    expect(result.interpretedInstructions).toEqual([]);
    expect(result.requiresConfirmation).toBe(true);
    expect(result.confidence).toBe(0);
    expect(result.reply).toContain('Cut marketing by half.');
  });
});
