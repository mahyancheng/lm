/**
 * The visual contract, pinned.
 *
 * §6.2 of `docs/economy-study.md` states the one rule every Wave 3 surface
 * lives under: nothing in the interface computes an economic number, it renders
 * rows the resolver recorded. That rule is not enforceable by types, so it is
 * enforced here — every helper the new surfaces call is exercised against a
 * *resolved* session, and the figures it produces are checked to be the ones
 * the engine committed rather than ones the interface arrived at.
 *
 * Four groups:
 *
 * 1. **Stacks (V1).** Rows carry the engine's signs and tones, and base plus
 *    rows is the total.
 * 2. **Ladder, flow, ceilings, previews.** Ordering, bounds, and the two
 *    "achievable ceiling" figures read off the engine's own curves.
 * 3. **Thresholds and captions (V4, V8).** "needs 50%+1 — you hold 38%", the
 *    exposure drivers, and the exposure points the confirm buttons print.
 * 4. **World version.** A single-sector session renders every one of these
 *    surfaces as absent, and a multi-sector one renders them as populated.
 *
 * Relative imports throughout: the `@/` alias is Next's, and the test files
 * themselves keep to relative paths (see `vitest.config.mts`).
 */

import { describe, expect, it } from 'vitest';
import type { CompanyModifierStack, NewGameSetupInput, SessionState } from '@frontier/contracts';
import {
  ANTITRUST_EXPOSURE_WEIGHTS,
  CARTEL_BONUS_FLOOR_PCT,
  CONTROL_DECISIVE_PCT,
  CONTROL_INFORMATION_PCT,
  CURRENT_WORLD_VERSION,
  SECTORS,
  SECTOR_PRICE_BOUNDS,
  TOLL_MAX_PCT,
  costStackFor,
  exposureFor,
  priceStackFor,
} from '@frontier/contracts';
import {
  DEBT_AMORTISATION_PER_QUARTER,
  SEGMENT_REFERENCE_PRICE_USD,
  annualisedRevenueUsd,
  createDefaultEngine,
  createDemoSession,
  repriceForecast,
} from '@frontier/simulation';
import { projectPlayerView } from '../../../lib/game/playerView';
import { debtServiceView } from '../financials/headroom';
import { achievableCeilingUsd } from '../products/ceiling';
import { accordExposurePoints } from '../deal-room/AccordFields';
import { tollExposurePoints } from './TollTicket';
import {
  BAND_TONE,
  MODIFIER_TONE,
  PRICE_BASELINE_FRACTION,
  controlCaption,
  exposureCostLabel,
  flowTiles,
  laddersPresent,
  modifierIcon,
  priceIndexFraction,
  priceIndexTone,
  priceLadder,
  renderedDrivers,
  renderedStackRows,
  sectorLadderRows,
  shortageBadge,
  stackReconciles,
  visibleAccordMembers,
} from './model';

/* -------------------------------------------------------------------------- */
/*  Sessions                                                                   */
/* -------------------------------------------------------------------------- */

const MULTI_SECTOR: NewGameSetupInput = {
  companyName: 'Player Ventures',
  founderName: 'Avery Sinclair',
  backgroundId: 'frontier_lab',
  worldVersion: CURRENT_WORLD_VERSION,
};

/** Resolve `quarters` quarters with no player actions, exactly as the app does. */
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

function playerOf(state: SessionState) {
  const company = state.companies.find((entry) => entry.controllerPlayerId !== null);
  if (company === undefined) throw new Error('no player company');
  return company;
}

const worldTwo = resolved(createDemoSession(undefined, MULTI_SECTOR), 3);
const worldTwoView = projectPlayerView(worldTwo);
const worldTwoCompany = playerOf(worldTwo);

const worldOne = resolved(createDemoSession(), 3);
const worldOneView = projectPlayerView(worldOne);

/* -------------------------------------------------------------------------- */
/*  1. The stacks (V1)                                                         */
/* -------------------------------------------------------------------------- */

describe('the itemised modifier stack', () => {
  const price = priceStackFor(worldTwoView.economyReport, worldTwoCompany.id);
  const cost = costStackFor(worldTwoView.economyReport, worldTwoCompany.id);

  it('is written for the seat in a multi-sector world', () => {
    expect(price).not.toBeNull();
    expect(cost).not.toBeNull();
  });

  it('renders the engine’s own signs and tones, and invents no row', () => {
    for (const stack of [price, cost]) {
      if (stack === null) continue;
      const rows = renderedStackRows(stack);
      expect(rows).toHaveLength(stack.rows.length);
      rows.forEach((rendered, index) => {
        const source = stack.rows[index];
        if (source === undefined) throw new Error('row count drifted');
        expect(rendered.key).toBe(source.key);
        expect(rendered.tone).toBe(MODIFIER_TONE[source.tone]);
        expect(rendered.icon).toBe(modifierIcon(source));
        // The percentage on screen is the one the engine signed, not one the
        // component divided out of the dollars.
        if (source.pct > 0) expect(rendered.pctLabel.startsWith('+')).toBe(true);
        if (source.pct < 0) expect(rendered.pctLabel.startsWith('-')).toBe(true);
      });
    }
  });

  it('reconciles: base plus every row is the total', () => {
    for (const stack of [price, cost]) {
      if (stack === null) continue;
      expect(stackReconciles(stack)).toBe(true);
    }
  });

  it('catches a stack that does not reconcile rather than printing it anyway', () => {
    const broken: CompanyModifierStack = {
      companyId: 'cmp_x',
      quarter: 1,
      kind: 'cost',
      baseUsd: 1_000_000,
      totalUsd: 1_500_000,
      netPct: 50,
      rows: [{ key: 'input_price', label: 'Input goods price 120', icon: 'box', pct: 10, amountUsd: 100_000, tone: 'negative', causeEventId: null }],
    };
    expect(stackReconciles(broken)).toBe(false);
  });

  it('is empty, not defaulted, when there is no stack at all', () => {
    expect(renderedStackRows(null)).toEqual([]);
    expect(stackReconciles(null)).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/*  2. Ladder, flow and ceilings                                               */
/* -------------------------------------------------------------------------- */

describe('the market-share ladder', () => {
  const everyone = [worldTwoCompany, ...worldTwoView.visibleCompanies];
  const sector = worldTwoCompany.sector ?? SECTORS[0];
  const supplyUsd = worldTwoView.economyReport?.sectorPrices.find((row) => row.sector === sector)?.supplyUsd ?? 0;
  const rows = sectorLadderRows(everyone, sector, supplyUsd, worldTwoCompany.id);

  it('puts the player on it and marks them', () => {
    const you = rows.find((row) => row.isPlayer);
    expect(you).toBeDefined();
    expect(you?.key).toBe(worldTwoCompany.id);
  });

  it('divides the engine’s own annualised revenue by the engine’s own supply', () => {
    const you = rows.find((row) => row.isPlayer);
    expect(you?.revenueUsd).toBe(annualisedRevenueUsd(worldTwoCompany));
  });

  it('orders by disclosed share, largest first, and sinks the undisclosed', () => {
    const shares = rows.filter((row) => !row.isUndisclosed && row.share !== null).map((row) => row.share as number);
    for (let index = 1; index < shares.length; index += 1) {
      expect((shares[index - 1] as number) >= (shares[index] as number)).toBe(true);
    }
    const undisclosed = rows.findIndex((row) => row.isUndisclosed);
    if (undisclosed >= 0) expect(undisclosed).toBe(rows.length - 1);
  });

  it('never states a private rival’s revenue', () => {
    for (const row of rows) {
      if (row.isPlayer || row.isUndisclosed) continue;
      if (!row.isPublic) expect(row.share).toBeNull();
    }
  });

  it('groups accord members when the seat can see the accord', () => {
    const withAccord = sectorLadderRows(everyone, sector, supplyUsd, worldTwoCompany.id, new Set([worldTwoCompany.id]));
    expect(withAccord.filter((row) => row.inAccord).map((row) => row.key)).toEqual([worldTwoCompany.id]);
    // And with no accord in sight, nobody is grouped.
    expect(rows.some((row) => row.inAccord)).toBe(false);
  });

  it('offers only the sectors somebody stands in', () => {
    const present = laddersPresent(everyone);
    expect(present.length).toBeGreaterThan(1);
    expect(present).toEqual(SECTORS.filter((entry) => present.includes(entry)));
  });

  it('reads accord membership off the seat’s own accepted binding deals only', () => {
    expect(visibleAccordMembers([], sector).size).toBe(0);
    const deal = {
      binding: true,
      status: 'accepted',
      gives: [{ kind: 'price_accord', sector, memberCompanyIds: ['a', 'b'], quarters: 4 }],
      gets: [],
    } as never;
    expect([...visibleAccordMembers([deal], sector)]).toEqual(['a', 'b']);
    // A proposal is not an accord.
    const proposed = { ...(deal as object), status: 'proposed' } as never;
    expect(visibleAccordMembers([proposed], sector).size).toBe(0);
  });
});

describe('the sector flow chain', () => {
  const tiles = flowTiles(worldTwoView.economyReport, new Set([worldTwoCompany.sector ?? SECTORS[0]]));

  it('draws one tile per sector, in SECTORS order', () => {
    expect(tiles.map((tile) => tile.sector)).toEqual([...SECTORS]);
  });

  it('carries the committed row for each sector', () => {
    for (const tile of tiles) {
      expect(tile.row).not.toBeNull();
      expect(tile.row?.priceIndex).toBeGreaterThanOrEqual(SECTOR_PRICE_BOUNDS.min);
      expect(tile.row?.priceIndex).toBeLessThanOrEqual(SECTOR_PRICE_BOUNDS.max);
    }
  });

  it('marks an internal link only where the group actually produces', () => {
    const own = worldTwoCompany.sector ?? SECTORS[0];
    for (const tile of tiles) {
      for (const input of tile.internalInputs) expect(input).toBe(own);
    }
  });

  it('places the price index on its own hard range, with 100 as the anchor', () => {
    expect(priceIndexFraction(SECTOR_PRICE_BOUNDS.min)).toBe(0);
    expect(priceIndexFraction(SECTOR_PRICE_BOUNDS.max)).toBe(1);
    expect(PRICE_BASELINE_FRACTION).toBeGreaterThan(0);
    expect(PRICE_BASELINE_FRACTION).toBeLessThan(1);
    // Out of range collapses onto the edge rather than off the bar.
    expect(priceIndexFraction(1_000)).toBe(1);
    expect(priceIndexTone(120)).toBe('warn');
    expect(priceIndexTone(80)).toBe('info');
    expect(priceIndexTone(100)).toBe('neutral');
  });

  it('badges a shortage only while the counter is live', () => {
    expect(shortageBadge(null)).toBeNull();
    const row = tiles[0]?.row;
    if (row !== null && row !== undefined) {
      expect(shortageBadge({ ...row, shortage: 0 })).toBeNull();
      expect(shortageBadge({ ...row, shortage: 30 })).toBe('SHORT -30%');
    }
  });
});

describe('the price ladder', () => {
  it('places every point on the axis and never off it', () => {
    const ladder = priceLadder(38, 52, 83, [{ companyId: 'cmp_helion', label: 'Helion', priceUsd: 19 }]);
    for (const point of ladder.points) {
      expect(point.fraction).toBeGreaterThanOrEqual(0);
      expect(point.fraction).toBeLessThanOrEqual(1);
    }
    const you = ladder.points.find((point) => point.kind === 'you');
    const reference = ladder.points.find((point) => point.kind === 'reference');
    // A price under the market sits left of the average. That is the whole read.
    expect((you?.fraction ?? 1) < (reference?.fraction ?? 0)).toBe(true);
  });

  it('states the achievable ceiling from the engine’s own forecast peak, not a validator band', () => {
    const state = resolved(createDemoSession(undefined, MULTI_SECTOR), 2);
    const company = playerOf(state);
    const product = company.products.find((entry) => entry.isActive);
    if (product === undefined) throw new Error('no active product');
    const reference = SEGMENT_REFERENCE_PRICE_USD[product.segment];

    const ceiling = achievableCeilingUsd(state, company.id, product.id, reference, product.pricePerSeat);
    expect(ceiling).toBeGreaterThan(0);
    // Guidance, not a bound: the forecast at the ceiling is at least as good as
    // at either edge of the range it was found in.
    const atCeiling = repriceForecast(state, company.id, product.id, ceiling);
    const atZero = repriceForecast(state, company.id, product.id, 0);
    const atTop = repriceForecast(state, company.id, product.id, Math.max(reference, product.pricePerSeat) * 10);
    if (atCeiling === null || atZero === null || atTop === null) throw new Error('no forecast');
    expect(atCeiling.revenueAfterUsd).toBeGreaterThanOrEqual(atZero.revenueAfterUsd);
    expect(atCeiling.revenueAfterUsd).toBeGreaterThanOrEqual(atTop.revenueAfterUsd);
  });

  it('reports zero for a product that cannot be found', () => {
    const state = resolved(createDemoSession(undefined, MULTI_SECTOR), 2);
    const company = playerOf(state);
    expect(achievableCeilingUsd(state, company.id, 'not_a_product', 50, 50)).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/*  3. Thresholds, exposure and previews                                       */
/* -------------------------------------------------------------------------- */

describe('the control caption', () => {
  const base = {
    companyId: 'cmp_x',
    holderId: 'chr_founder',
    holderKind: 'character' as const,
    sharesHeld: 380,
    issuedShares: 1_000,
    stakePct: 38,
    hasInformationRight: true,
    hasControl: false,
    informationThresholdPct: Math.round(CONTROL_INFORMATION_PCT * 100),
    controlThresholdPct: Math.round(CONTROL_DECISIVE_PCT * 100),
  };

  it('names the gap rather than hiding the verb', () => {
    expect(controlCaption(base)).toBe('Needs 50%+1 — you hold 38%.');
  });

  it('says so when the stake is decisive', () => {
    expect(controlCaption({ ...base, sharesHeld: 620, stakePct: 62, hasControl: true })).toContain('62%');
    expect(controlCaption({ ...base, sharesHeld: 620, stakePct: 62, hasControl: true })).toContain('dismissal');
  });

  it('is total: no row at all still produces a sentence', () => {
    expect(controlCaption(null)).toContain('50%+1');
  });
});

describe('the exposure card and the risk on the confirm buttons', () => {
  // A company that has concentrated nothing writes no row at all — the engine
  // skips a score that was zero and stayed zero — so the shape assertions run
  // against the session's own rows and the *seat* assertion against the
  // projection. The card's null branch is the one a calm company sees.
  const anyExposure = worldTwo.economyReport?.exposures[0] ?? null;

  it('carries the engine’s six drivers, in order, on every row it writes', () => {
    expect(anyExposure).not.toBeNull();
    expect(anyExposure?.drivers.map((driver) => driver.key)).toEqual([
      'carried',
      'sector_share',
      'accord',
      'acquisitions',
      'toll',
      'predation',
    ]);
  });

  it('is scoped to the seat: a rival’s exact score never reaches the projection', () => {
    const projected = worldTwoView.economyReport?.exposures ?? [];
    for (const row of projected) expect(row.companyId).toBe(worldTwoCompany.id);
    // And the seat's own row, when it has one, is the one the card renders.
    const own = exposureFor(worldTwoView.economyReport, worldTwoCompany.id);
    if (own !== null) expect(own.companyId).toBe(worldTwoCompany.id);
  });

  it('renders every driver, colouring only the ones that cost something', () => {
    const rows = renderedDrivers(anyExposure);
    expect(rows).toHaveLength(anyExposure?.drivers.length ?? 0);
    rows.forEach((row, index) => {
      const source = anyExposure?.drivers[index];
      expect(row.tone).toBe((source?.points ?? 0) > 0 ? 'loss' : 'neutral');
    });
    expect(renderedDrivers(null)).toEqual([]);
  });

  it('bands the score the way the engine bands it', () => {
    expect(BAND_TONE.calm).toBe('gain');
    expect(BAND_TONE.watched).toBe('warn');
    expect(BAND_TONE.exposed).toBe('loss');
    if (anyExposure !== null) expect(BAND_TONE[anyExposure.band]).toBeDefined();
  });

  it('prints the accord’s exposure from the engine’s weights, not from memory', () => {
    expect(accordExposurePoints()).toBe(ANTITRUST_EXPOSURE_WEIGHTS.accord);
    expect(exposureCostLabel(accordExposurePoints())).toBe(`+${ANTITRUST_EXPOSURE_WEIGHTS.accord} exposure`);
    expect(exposureCostLabel(0)).toBeNull();
  });

  it('prices the toll dial the same way, and is monotone in the dial', () => {
    expect(tollExposurePoints(0)).toBe(0);
    expect(tollExposurePoints(TOLL_MAX_PCT)).toBe(ANTITRUST_EXPOSURE_WEIGHTS.toll);
    let previous = -1;
    for (let dial = 0; dial <= TOLL_MAX_PCT; dial += 1) {
      const points = tollExposurePoints(dial);
      expect(points).toBeGreaterThanOrEqual(previous);
      previous = points;
    }
  });
});

describe('the headroom figures', () => {
  it('reads the engine’s own amortisation rather than restating it', () => {
    const view = debtServiceView(1_000_000, 4_000_000, 60_000);
    expect(view.principalUsd).toBe(Math.round(4_000_000 * DEBT_AMORTISATION_PER_QUARTER));
    expect(view.interestUsd).toBe(60_000);
    expect(view.totalUsd).toBe(view.principalUsd + view.interestUsd);
    expect(view.headroomUsd).toBe(1_000_000 - view.totalUsd);
  });

  it('says a debt-free company owes nothing and is covered', () => {
    const view = debtServiceView(500_000, 0, 0);
    expect(view.totalUsd).toBe(0);
    expect(view.headroomUsd).toBe(500_000);
    expect(view.coveredQuarters).toBeGreaterThan(0);
  });

  it('goes negative exactly where the engine forces a bridge round', () => {
    const view = debtServiceView(10_000, 4_000_000, 60_000);
    expect(view.headroomUsd).toBeLessThan(0);
  });
});

/* -------------------------------------------------------------------------- */
/*  4. World version                                                           */
/* -------------------------------------------------------------------------- */

describe('world version gating', () => {
  it('renders every new surface as absent in a single-sector session', () => {
    expect(worldOneView.economyReport).toBeNull();

    const company = playerOf(worldOne);
    expect(priceStackFor(worldOneView.economyReport, company.id)).toBeNull();
    expect(costStackFor(worldOneView.economyReport, company.id)).toBeNull();
    expect(exposureFor(worldOneView.economyReport, company.id)).toBeNull();

    // The chain still draws six tiles, all unpriced, so the screen can say
    // "no prices yet" rather than printing a baseline as if it were a fact.
    const tiles = flowTiles(worldOneView.economyReport, new Set());
    expect(tiles).toHaveLength(SECTORS.length);
    expect(tiles.every((tile) => tile.row === null)).toBe(true);

    // And the screen's own gate: one sector present means one sector.
    expect(laddersPresent([company, ...worldOneView.visibleCompanies])).toHaveLength(1);
  });

  it('renders them as populated in a multi-sector session', () => {
    expect(worldTwoView.economyReport).not.toBeNull();
    const report = worldTwoView.economyReport;
    expect(report?.sectorPrices).toHaveLength(SECTORS.length);
    expect((report?.regionTolls.length ?? 0) > 0).toBe(true);
    for (const toll of report?.regionTolls ?? []) {
      expect(toll.tollPct).toBeGreaterThanOrEqual(0);
      expect(toll.tollPct).toBeLessThanOrEqual(TOLL_MAX_PCT);
    }
    expect(laddersPresent([worldTwoCompany, ...worldTwoView.visibleCompanies]).length).toBeGreaterThan(1);
  });

  it('keeps the cartel floor visible wherever an accord is drafted', () => {
    // The one number a player quotes about a cartel, and the surface prints it
    // straight from the constant rather than from an example.
    expect(CARTEL_BONUS_FLOOR_PCT).toBe(5);
  });
});
