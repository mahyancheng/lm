/**
 * The Financials History tab, held to two rules.
 *
 * 1. **The screen computes no economic number.** Every series, bar and CSV cell
 *    is a figure the engine committed. The only arithmetic these helpers do is
 *    the quarter-on-quarter change between two committed figures and the
 *    whole-number tick ladder an axis is drawn against — both proved here.
 * 2. **The projection removes and never rewrites.** The player reads their own
 *    statements in full; a listed rival's arrive at filing grain; a private
 *    rival's are absent, not blurred.
 *
 * Relative imports throughout: the `@/` alias is Next's, and test files keep to
 * relative paths (see `vitest.config.mts`).
 */

import { describe, expect, it } from 'vitest';
import type { FinancialQuarter, NewGameSetupInput, SessionState } from '@frontier/contracts';
import { CURRENT_WORLD_VERSION, financialQuarterReconciles, quarterLabel } from '@frontier/contracts';
import { createDefaultEngine, createDemoSession } from '@frontier/simulation';
import { projectPlayerView } from '../../../lib/game/playerView';
import {
  HISTORY_CSV_COLUMNS,
  PRODUCT_LINES_CSV_COLUMNS,
  barsOf,
  financialHistoryFor,
  groupProductLines,
  historyCsv,
  latestOf,
  latestStatement,
  niceStep,
  productLinesCsv,
  qoqDeltaPct,
  quarterLabels,
  revenueStacks,
  seriesOf,
  statementAt,
  wholeNumberTicks,
} from './history';

/* -------------------------------------------------------------------------- */
/*  Sessions                                                                   */
/* -------------------------------------------------------------------------- */

const MULTI_SECTOR: NewGameSetupInput = {
  companyName: 'Player Ventures',
  founderName: 'Avery Sinclair',
  backgroundId: 'frontier_lab',
  worldVersion: CURRENT_WORLD_VERSION,
};

function resolved(state: SessionState, quarters: number): SessionState {
  const engine = createDefaultEngine();
  let current = state;
  for (let index = 0; index < quarters; index += 1) {
    const outcome = engine.resolver.resolveQuarter(current, [], null, []);
    expect(outcome.committed).toBe(true);
    current = outcome.nextState;
  }
  return current;
}

const worldTwo = resolved(createDemoSession(undefined, MULTI_SECTOR), 5);
const worldTwoView = projectPlayerView(worldTwo);
const worldOneView = projectPlayerView(resolved(createDemoSession(), 3));

const ownHistory = financialHistoryFor(worldTwoView, worldTwoView.ownCompany.id);

/* -------------------------------------------------------------------------- */
/*  Selection and the projection                                               */
/* -------------------------------------------------------------------------- */

describe('financialHistoryFor', () => {
  it('gives the player every statement the engine filed, in quarter order', () => {
    expect(ownHistory.length).toBeGreaterThan(1);
    const quarters = ownHistory.map((entry) => entry.quarter);
    expect([...quarters].sort((a, b) => a - b)).toEqual(quarters);
    for (const entry of ownHistory) expect(financialQuarterReconciles(entry)).toBe(true);
  });

  it('gives the player the internal detail nobody files', () => {
    const latest = latestStatement(ownHistory);
    expect(latest?.income.revenueBySource).toBeDefined();
    expect(latest?.income.opexByLine).toBeDefined();
    expect(latest?.productLines).toBeDefined();
  });

  it('gives a listed rival at filing grain: totals present, internal splits absent', () => {
    const listed = worldTwoView.visibleCompanies.find((rival) => rival.isPublic === true && rival.id !== undefined);
    expect(listed, 'the demo world has a listed rival').toBeDefined();
    if (listed?.id === undefined) return;

    const rivalHistory = financialHistoryFor(worldTwoView, listed.id);
    expect(rivalHistory.length).toBeGreaterThan(0);
    for (const entry of rivalHistory) {
      // Removed, not rewritten: the identities still hold on what survives.
      expect(entry.income.revenueBySource).toBeUndefined();
      expect(entry.income.opexByLine).toBeUndefined();
      expect(entry.productLines).toBeUndefined();
      expect(entry.income.revenueUsd).toBeGreaterThanOrEqual(0);
      expect(financialQuarterReconciles(entry)).toBe(true);
    }

    // The surviving figures are the engine's own, unchanged.
    const canonical = worldTwo.companies.find((company) => company.id === listed.id)?.financialHistory ?? [];
    for (const filed of rivalHistory) {
      const source = canonical.find((entry) => entry.quarter === filed.quarter);
      expect(source).toBeDefined();
      expect(filed.income.revenueUsd).toBe(source?.income.revenueUsd);
      expect(filed.income.netIncomeUsd).toBe(source?.income.netIncomeUsd);
      expect(filed.balance).toEqual(source?.balance);
      expect(filed.cashFlow).toEqual(source?.cashFlow);
    }
  });

  it('gives a private rival nothing at all — absent, not zeroed', () => {
    const priv = worldTwoView.visibleCompanies.find((rival) => rival.isPublic === false && rival.id !== undefined);
    if (priv?.id === undefined) return;
    expect(priv.financialHistory).toBeUndefined();
    expect(financialHistoryFor(worldTwoView, priv.id)).toEqual([]);
  });

  it('returns an empty series for a world that keeps no statements and for an unknown company', () => {
    expect(financialHistoryFor(worldOneView, worldOneView.ownCompany.id)).toEqual([]);
    expect(financialHistoryFor(worldTwoView, 'cmp_does_not_exist')).toEqual([]);
  });
});

describe('statementAt', () => {
  it('finds a filed quarter and returns null for anything else', () => {
    const first = ownHistory[0];
    expect(first).toBeDefined();
    if (first === undefined) return;
    expect(statementAt(ownHistory, first.quarter)?.quarter).toBe(first.quarter);
    expect(statementAt(ownHistory, null)).toBeNull();
    expect(statementAt(ownHistory, 9_999)).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/*  Series                                                                     */
/* -------------------------------------------------------------------------- */

describe('seriesOf and quarterLabels', () => {
  it('produces one point per filed quarter, in the same order as the labels', () => {
    const revenue = seriesOf(ownHistory, (entry) => entry.income.revenueUsd);
    const labels = quarterLabels(ownHistory, worldTwoView.startYear);
    expect(revenue).toHaveLength(ownHistory.length);
    expect(labels).toHaveLength(ownHistory.length);
    ownHistory.forEach((entry, index) => {
      expect(revenue[index]).toBe(entry.income.revenueUsd);
      expect(labels[index]).toBe(quarterLabel(worldTwoView.startYear, entry.quarter));
    });
  });

  it('reads a withheld figure as zero on a chart rather than dropping the point', () => {
    // A null share price is a real absence; a chart still needs a point at that
    // x, so the series carries zero and the card that draws it is only shown
    // when at least one quarter has a price.
    const prices = seriesOf(ownHistory, (entry) => entry.kpis.sharePriceUsd);
    expect(prices).toHaveLength(ownHistory.length);
    for (const value of prices) expect(Number.isFinite(value)).toBe(true);
  });

  it('is empty for an empty history', () => {
    expect(seriesOf([], (entry) => entry.income.revenueUsd)).toEqual([]);
    expect(latestOf([])).toBeNull();
    expect(latestStatement([])).toBeNull();
  });
});

describe('qoqDeltaPct', () => {
  it('is a whole percentage of the previous quarter', () => {
    expect(qoqDeltaPct([100, 125])).toBe(25);
    expect(qoqDeltaPct([200, 150])).toBe(-25);
    expect(qoqDeltaPct([100, 100])).toBe(0);
  });

  it('measures against the magnitude of the previous quarter, so a loss narrowing reads positive', () => {
    expect(qoqDeltaPct([-100, -50])).toBe(50);
    expect(qoqDeltaPct([-100, -150])).toBe(-50);
  });

  it('is null rather than infinite when there is nothing to compare against', () => {
    expect(qoqDeltaPct([])).toBeNull();
    expect(qoqDeltaPct([42])).toBeNull();
    expect(qoqDeltaPct([0, 500])).toBeNull();
  });

  it('reads the committed figures on a real series', () => {
    const revenue = seriesOf(ownHistory, (entry) => entry.income.revenueUsd);
    const delta = qoqDeltaPct(revenue);
    const last = revenue[revenue.length - 1] ?? 0;
    const previous = revenue[revenue.length - 2] ?? 0;
    if (previous === 0) {
      expect(delta).toBeNull();
    } else {
      expect(delta).toBe(Math.round(((last - previous) / Math.abs(previous)) * 100));
    }
  });
});

/* -------------------------------------------------------------------------- */
/*  Axes                                                                       */
/* -------------------------------------------------------------------------- */

describe('niceStep', () => {
  it('snaps to a 1/2/5 × 10ⁿ ladder', () => {
    expect(niceStep(1)).toBe(1);
    expect(niceStep(3)).toBe(5);
    expect(niceStep(7)).toBe(10);
    expect(niceStep(11)).toBe(20);
    expect(niceStep(230)).toBe(500);
    expect(niceStep(1_100_000)).toBe(2_000_000);
  });

  it('never returns less than one whole unit', () => {
    expect(niceStep(0)).toBe(1);
    expect(niceStep(0.004)).toBe(1);
    expect(niceStep(Number.NaN)).toBe(1);
  });
});

describe('wholeNumberTicks', () => {
  it('returns whole numbers only, ascending and unique', () => {
    const ticks = wholeNumberTicks(-4_000_000, 12_000_000);
    expect(ticks.length).toBeGreaterThan(1);
    for (const tick of ticks) expect(Number.isInteger(tick)).toBe(true);
    expect([...ticks].sort((a, b) => a - b)).toEqual(ticks);
    expect(new Set(ticks).size).toBe(ticks.length);
  });

  it('covers the range it was given', () => {
    const ticks = wholeNumberTicks(120, 980);
    expect(Math.min(...ticks)).toBeLessThanOrEqual(120);
    expect(Math.max(...ticks)).toBeGreaterThanOrEqual(980);
  });

  it('degrades to a single tick for a flat or unusable range', () => {
    expect(wholeNumberTicks(500, 500)).toEqual([500]);
    expect(wholeNumberTicks(Number.NaN, 5)).toEqual([0]);
  });
});

/* -------------------------------------------------------------------------- */
/*  Bars and stacks                                                            */
/* -------------------------------------------------------------------------- */

describe('barsOf', () => {
  it('carries the committed value and marks the losses', () => {
    const bars = barsOf(ownHistory, worldTwoView.startYear, (entry) => entry.income.netIncomeUsd);
    expect(bars).toHaveLength(ownHistory.length);
    bars.forEach((bar, index) => {
      const entry = ownHistory[index];
      expect(entry).toBeDefined();
      if (entry === undefined) return;
      expect(bar.value).toBe(entry.income.netIncomeUsd);
      expect(bar.quarter).toBe(entry.quarter);
      expect(bar.label).toBe(quarterLabel(worldTwoView.startYear, entry.quarter));
      expect(bar.negative).toBe(entry.income.netIncomeUsd < 0);
    });
  });
});

describe('revenueStacks', () => {
  it('splits each quarter into the three sources the engine recorded', () => {
    const stacks = revenueStacks(ownHistory, worldTwoView.startYear);
    expect(stacks).toHaveLength(ownHistory.length);
    stacks.forEach((stack, index) => {
      const entry = ownHistory[index];
      const split = entry?.income.revenueBySource;
      expect(split).toBeDefined();
      if (split === undefined) return;
      expect(stack.segments.map((segment) => segment.key)).toEqual(['products', 'contracts', 'other']);
      expect(stack.segments[0]?.value).toBe(split.productsUsd);
      expect(stack.segments[1]?.value).toBe(split.contractsUsd);
      expect(stack.segments[2]?.value).toBe(split.otherUsd);
      // The drawn height is the positive parts; a negative chain adjustment is
      // carried by the total, not drawn as a slice.
      expect(stack.total).toBe(stack.segments.reduce((sum, segment) => sum + Math.max(0, segment.value), 0));
    });
  });

  it('draws no stack at all for a quarter whose split was withheld', () => {
    const withheld: FinancialQuarter[] = ownHistory.map((entry) => ({
      ...entry,
      income: { ...entry.income, revenueBySource: undefined },
    }));
    expect(revenueStacks(withheld, worldTwoView.startYear)).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/*  Export                                                                     */
/* -------------------------------------------------------------------------- */

describe('historyCsv', () => {
  it('writes the fixed header and one row per quarter', () => {
    const csv = historyCsv(ownHistory, worldTwoView.startYear);
    const lines = csv.split('\n');
    expect(lines[0]).toBe(HISTORY_CSV_COLUMNS.join(','));
    expect(lines).toHaveLength(ownHistory.length + 1);
    for (const line of lines) expect(line.split(',')).toHaveLength(HISTORY_CSV_COLUMNS.length);
  });

  it('rounds to whole units and never rewrites a figure', () => {
    const csv = historyCsv(ownHistory, worldTwoView.startYear);
    const first = ownHistory[0];
    const row = csv.split('\n')[1]?.split(',') ?? [];
    expect(first).toBeDefined();
    if (first === undefined) return;
    expect(row[0]).toBe(quarterLabel(worldTwoView.startYear, first.quarter));
    expect(row[1]).toBe(String(Math.round(first.income.revenueUsd)));
    expect(row[HISTORY_CSV_COLUMNS.indexOf('net_income')]).toBe(String(Math.round(first.income.netIncomeUsd)));
    expect(row[HISTORY_CSV_COLUMNS.indexOf('gross_margin_pct')]).toBe(String(Math.round(first.kpis.grossMarginPct * 100)));
    for (const cell of row.slice(1)) expect(cell === '' || /^-?\d+$/.test(cell)).toBe(true);
  });

  it('leaves a withheld figure as an empty cell rather than a zero', () => {
    const filed: FinancialQuarter[] = ownHistory.slice(0, 1).map((entry) => ({
      ...entry,
      income: { ...entry.income, revenueBySource: undefined, opexByLine: undefined },
      kpis: { ...entry.kpis, marketCapUsd: null, sharePriceUsd: null },
    }));
    const row = historyCsv(filed, worldTwoView.startYear).split('\n')[1]?.split(',') ?? [];
    expect(row[HISTORY_CSV_COLUMNS.indexOf('revenue_products')]).toBe('');
    expect(row[HISTORY_CSV_COLUMNS.indexOf('opex_payroll')]).toBe('');
    expect(row[HISTORY_CSV_COLUMNS.indexOf('market_cap')]).toBe('');
    expect(row[HISTORY_CSV_COLUMNS.indexOf('share_price')]).toBe('');
    // The totals a listed company does file are still there.
    expect(row[HISTORY_CSV_COLUMNS.indexOf('revenue')]).not.toBe('');
    expect(row[HISTORY_CSV_COLUMNS.indexOf('opex')]).not.toBe('');
  });

  it('is a header alone for an empty history', () => {
    expect(historyCsv([], 2027)).toBe(HISTORY_CSV_COLUMNS.join(','));
  });
});

/* -------------------------------------------------------------------------- */
/*  Product lines, by industry                                                */
/* -------------------------------------------------------------------------- */

describe('groupProductLines', () => {
  it('places every line in a group and drops none', () => {
    const withLines = ownHistory.find((entry) => (entry.productLines ?? []).length > 0);
    if (withLines === undefined) return; // this fixture's five quarters happened to book no product line
    const groups = groupProductLines(withLines.productLines ?? []);
    const total = groups.reduce((sum, group) => sum + group.lines.length, 0);
    expect(total).toBe((withLines.productLines ?? []).length);
  });

  it('is sorted by label and is empty for no lines', () => {
    expect(groupProductLines([])).toEqual([]);
    const withLines = ownHistory.find((entry) => (entry.productLines ?? []).length > 0);
    if (withLines === undefined) return;
    const labels = groupProductLines(withLines.productLines ?? []).map((group) => group.label);
    expect(labels).toEqual([...labels].sort((a, b) => a.localeCompare(b)));
  });

  it('groups a line with no categoryId under a humanised segment name rather than dropping it', () => {
    const groups = groupProductLines([
      { productId: 'prd_x', name: 'Legacy Line', segment: 'developer_api', units: 10, priceUsd: 5, revenueUsd: 50, grossMarginPct: 0.4 },
    ]);
    expect(groups).toEqual([{ label: 'Developer api', lines: expect.any(Array) }]);
  });
});

describe('productLinesCsv', () => {
  it('carries categoryId and unit for every row that has them', () => {
    const withLines = ownHistory.find((entry) => (entry.productLines ?? []).length > 0);
    if (withLines === undefined) return;
    const csv = productLinesCsv([withLines], worldTwoView.startYear);
    const rows = csv.split('\n').slice(1);
    expect(rows.length).toBe((withLines.productLines ?? []).length);
    for (const row of rows) {
      const cells = row.split(',');
      expect(cells[PRODUCT_LINES_CSV_COLUMNS.indexOf('category_id')]).not.toBe('');
      expect(cells[PRODUCT_LINES_CSV_COLUMNS.indexOf('unit')]).not.toBe('');
    }
  });

  it('is a header alone for an empty history', () => {
    expect(productLinesCsv([], 2027)).toBe(PRODUCT_LINES_CSV_COLUMNS.join(','));
  });
});
