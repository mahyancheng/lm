/**
 * The findings cards.
 *
 * One card per lookup, one figure per card, and the figure is the one a founder
 * asked about. The rule under test is that **nothing here computes**: every
 * number on a card is a number the engine put on the result, formatted.
 */

import { describe, expect, it } from 'vitest';
import type { LookupResult } from '@frontier/contracts';
import { FINDING_TITLE, cardFor, sourcingLabel } from './findings';

const computeMarket: LookupResult = {
  kind: 'compute_market',
  summary: 'x',
  units: 500,
  ownedUnits: 1_200,
  reservedUnits: 400,
  cloudUnits: 90,
  heldUnits: 1_690,
  ownedQuarterlyCostUsd: 1_400_000,
  reservedQuarterlyCostUsd: 1_300_000,
  cloudQuarterlyCostUsd: 1_900_000,
  purchaseCostUsd: 21_000_000,
  cashUsd: 4_000_000,
  cashAfterPurchaseUsd: -17_000_000,
  solvencyLine: '1 more quarter below zero and the company is wound up.',
  sellers: [
    {
      companyId: 'cmp_tessellate',
      name: 'Tessellate Fabrication',
      offering: 'accelerators',
      sectorId: 'semiconductors',
      region: 'east_asia',
      unitPriceUsd: 42_000,
      sellableUnits: 8_000,
      quarterlyCostPerUnitUsd: 2_310,
      energyFactorPct: 96,
      utilisationPct: 71,
      intent: { type: 'buy_accelerators', units: 500, maxPricePerUnitUsd: 46_200, sellerCompanyId: 'cmp_tessellate' },
    },
  ],
};

const ownPosition: LookupResult = {
  kind: 'own_position',
  summary: 'x',
  cashUsd: 4_000_000,
  quarterlyBurnUsd: -900_000,
  runwayQuarters: 4,
  negativeCashQuarters: 1,
  solvencyQuartersAllowed: 2,
  statements: [{ quarter: 6, revenueUsd: 12_000_000, netIncomeUsd: -800_000, cashUsd: 4_000_000, headcount: 240 }],
};

describe('the findings cards', () => {
  it('leads a compute finding with the price of one accelerator', () => {
    const card = cardFor(computeMarket);
    expect(card.title).toBe(FINDING_TITLE.compute_market);
    expect(card.figure).toBe('$42,000');
    expect(card.caption).toContain('Tessellate Fabrication');
    expect(card.caption).toContain('$21M');
  });

  it('warns on a negative landing and carries the solvency line verbatim', () => {
    const card = cardFor(computeMarket);
    const cash = card.lines.find((line) => line.label === 'Cash after buying them');
    expect(cash?.value).toBe('-$17M');
    expect(cash?.warn).toBe(true);
    expect(card.lines.find((line) => line.label === 'Solvency')?.value).toBe(
      computeMarket.kind === 'compute_market' ? computeMarket.solvencyLine : '',
    );
  });

  it('puts the engine\'s own intent on a seller row rather than composing one', () => {
    const card = cardFor(computeMarket);
    const row = card.lines.find((line) => line.counterparty === 'Tessellate Fabrication');
    expect(row?.intent).toEqual(computeMarket.kind === 'compute_market' ? computeMarket.sellers[0]?.intent : null);
  });

  it('leads our own position with cash and flags the solvency clock', () => {
    const card = cardFor(ownPosition);
    expect(card.figure).toBe('$4,000,000');
    expect(card.caption).toContain('4 quarters');
    expect(card.lines.find((line) => line.label === 'Quarters closed below zero')).toEqual({
      label: 'Quarters closed below zero',
      value: '1 of 2',
      warn: true,
    });
  });

  it('names what is being sourced in a sentence a founder can read', () => {
    expect(sourcingLabel(['compute_market'])).toBe('The compute market');
    expect(sourcingLabel(['compute_market', 'own_position'])).toBe('The compute market and Our own position');
    expect(sourcingLabel([])).toBe('the market');
  });

  it('shows at most three rows of a long result', () => {
    const many: LookupResult = {
      ...computeMarket,
      sellers: Array.from({ length: 12 }, (_, index) => ({
        ...(computeMarket.kind === 'compute_market' ? computeMarket.sellers[0]! : ({} as never)),
        companyId: `cmp_${index}`,
      })),
    };
    // Two fixed lines (cash, solvency) plus three seller rows.
    expect(cardFor(many).lines.length).toBe(5);
  });
});
