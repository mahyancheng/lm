/**
 * @frontier/simulation — scenario/world3/highlights.ts
 *
 * What the New Game picker says a world-3 company opens with.
 *
 * ## Why this is here and not in the contracts package
 *
 * `NEW_GAME_BACKGROUNDS` and `SECTOR_BACKGROUNDS` in `@frontier/contracts` carry
 * a hand-written `highlights` array per card — "Cash: $22M", "Revenue:
 * Pre-revenue". Those numbers were true of world 2 and several of them are now
 * false: world 3 prices every line off the node roll-up (`w3LineAsks`), scales
 * the opening run rate to what the talent market charges (`w3LineRunRates`) and
 * funds a pre-revenue bank to twenty quarters of runway (`w3RunwayTopUps`), so
 * a humanoid laboratory that world 2 opened with $22M and no line now opens
 * with as much as $58M and a pilot selling robots at $70K each.
 *
 * The numbers cannot be computed inside `session.ts` — contracts is the base
 * layer and may not import the engine — so they live here, beside the scenario
 * that produces them, and the picker asks for them by world version. Worlds 1
 * and 2 keep the static cards byte for byte: a player finishing a world-2 game
 * sees exactly what they saw when they started it.
 *
 * ## The table is checked, never trusted
 *
 * `W3_BACKGROUND_OPENINGS` is a flat table of three numbers per background per
 * region, read off `createWorld3Session` at seed `W3_SEED`.
 * `world3BackgroundCards.test.ts` rebuilds all ninety of those sessions and
 * asserts every stored number and every rendered string against the company the
 * scenario actually creates. A card that drifts from the world fails the suite,
 * which is the only reason it is safe to keep the numbers here at all.
 *
 * It is a table rather than a live derivation because this runs in the picker,
 * on a phone, before the game exists: `createWorld3Session` parses three full
 * sessions of twenty-five companies, which is not something to do five times
 * while somebody is choosing a card.
 *
 * ## Region matters
 *
 * The conversation asks for a sector, then a region, then a background, so the
 * region is known by the time these cards are drawn — and it moves them. Talent
 * is priced regionally, the opening run rate is sized against the wage bill and
 * the runway top-up fills what the line cannot cover, so the same background
 * opens in South Asia on $22M and in North America on $58M. One number per
 * background would be wrong five times out of six.
 *
 * ## What the four say, and why those four
 *
 * `Cash` · `Revenue` · `Price` · then `Debt` when the company carries any and
 * its `Posture` when it does not.
 *
 * `Price` earns its slot because of the two pre-revenue laboratories. "Revenue:
 * None yet" on its own is the sentence the owner objected to: it reads as "this
 * company has no income", when what is actually true is that nothing is booked
 * YET and the pilot line sells frontier model licences at $39M each. Stating
 * the price beside it is what makes the pair honest.
 *
 * ## Determinism
 *
 * Pure functions of the table, the node table and the world-2 player seeds. No
 * RNG, no clock, no `Intl`, no module-level cache: the same background and
 * region produce the same four strings on any machine, forever.
 */

import type { BackgroundId, NewGameBackground, NewGameBackgroundHighlight, Region, Sector } from '@frontier/contracts';
import { ECONOMIC_NODES_BY_ID, backgroundsForSector, startingLineNodeFor } from '@frontier/contracts';
import { W2_PLAYER_BACKGROUNDS } from '../world2';

/* -------------------------------------------------------------------------- */
/*  The measured table                                                         */
/* -------------------------------------------------------------------------- */

/**
 * What one background's company holds the moment the world is built, before a
 * single quarter has resolved — which is the state the founder is looking at
 * when they land on the Command Centre.
 *
 * Three numbers, because three are what the card shows that move with the
 * region. Debt, posture and the unit a line is sold in are derived rather than
 * stored: the first two off the world-2 player seed the world-3 company is
 * built from, the third off the node table.
 */
export interface W3OpeningFacts {
  /** `financials.cash` at quarter zero, in dollars. */
  readonly cashUsd: number;
  /** `financials.revenueQuarterly` at quarter zero. Zero for a line that has not sold yet. */
  readonly revenueUsd: number;
  /** `products[0].pricePerSeat` — what one unit of the opening line is asked for. */
  readonly unitPriceUsd: number;
}

/**
 * Every background's opening, in every region, at `W3_SEED`.
 *
 * Read off `createWorld3Session` and pinned by `world3BackgroundCards.test.ts`,
 * which reports the correct figure by name when one of these goes stale. To
 * regenerate after a scenario change, run that test and take the numbers from
 * the failures: they are the world telling you what it now opens with.
 */
export const W3_BACKGROUND_OPENINGS: Readonly<Record<BackgroundId, Readonly<Record<Region, W3OpeningFacts>>>> = {
  frontier_lab: {
    north_america: { cashUsd: 15_000_000, revenueUsd: 0, unitPriceUsd: 39131918.22 },
    europe: { cashUsd: 15_000_000, revenueUsd: 0, unitPriceUsd: 39131918.22 },
    east_asia: { cashUsd: 15_000_000, revenueUsd: 0, unitPriceUsd: 39131918.22 },
    south_asia: { cashUsd: 15_000_000, revenueUsd: 0, unitPriceUsd: 39131918.22 },
    middle_east: { cashUsd: 15_000_000, revenueUsd: 0, unitPriceUsd: 39131918.22 },
    latin_america: { cashUsd: 15_000_000, revenueUsd: 0, unitPriceUsd: 39131918.22 },
  },
  enterprise_ai: {
    north_america: { cashUsd: 5_562_003, revenueUsd: 3_834_000, unitPriceUsd: 1_500 },
    europe: { cashUsd: 4_000_000, revenueUsd: 3_736_500, unitPriceUsd: 1_500 },
    east_asia: { cashUsd: 4_000_000, revenueUsd: 3_024_000, unitPriceUsd: 1_500 },
    south_asia: { cashUsd: 4_000_000, revenueUsd: 1_957_500, unitPriceUsd: 1_500 },
    middle_east: { cashUsd: 4_000_000, revenueUsd: 3_381_000, unitPriceUsd: 1_500 },
    latin_america: { cashUsd: 4_000_000, revenueUsd: 2_313_000, unitPriceUsd: 1_500 },
  },
  consumer_ai: {
    north_america: { cashUsd: 5_000_000, revenueUsd: 6_000_000, unitPriceUsd: 16 },
    europe: { cashUsd: 5_000_000, revenueUsd: 6_000_000, unitPriceUsd: 16 },
    east_asia: { cashUsd: 5_000_000, revenueUsd: 6_000_000, unitPriceUsd: 16 },
    south_asia: { cashUsd: 5_000_000, revenueUsd: 6_000_000, unitPriceUsd: 16 },
    middle_east: { cashUsd: 5_000_000, revenueUsd: 6_000_000, unitPriceUsd: 16 },
    latin_america: { cashUsd: 5_000_000, revenueUsd: 6_000_000, unitPriceUsd: 16 },
  },
  infrastructure: {
    north_america: { cashUsd: 6_000_000, revenueUsd: 16113507.08, unitPriceUsd: 366216.07 },
    europe: { cashUsd: 6_000_000, revenueUsd: 13123868.45, unitPriceUsd: 374967.67 },
    east_asia: { cashUsd: 6_000_000, revenueUsd: 12550531.18, unitPriceUsd: 369133.27 },
    south_asia: { cashUsd: 6_000_000, revenueUsd: 12401753.98, unitPriceUsd: 364757.47 },
    middle_east: { cashUsd: 6_000_000, revenueUsd: 12409154.45, unitPriceUsd: 354547.27 },
    latin_america: { cashUsd: 6_000_000, revenueUsd: 12352161.58, unitPriceUsd: 363298.87 },
  },
  bootstrapper: {
    north_america: { cashUsd: 1_864_144, revenueUsd: 1_944_000, unitPriceUsd: 900 },
    europe: { cashUsd: 1_200_000, revenueUsd: 1_781_100, unitPriceUsd: 900 },
    east_asia: { cashUsd: 1_200_000, revenueUsd: 1_441_800, unitPriceUsd: 900 },
    south_asia: { cashUsd: 1_200_000, revenueUsd: 933_300, unitPriceUsd: 900 },
    middle_east: { cashUsd: 1_200_000, revenueUsd: 1_611_900, unitPriceUsd: 900 },
    latin_america: { cashUsd: 1_200_000, revenueUsd: 1_102_500, unitPriceUsd: 900 },
  },
  warehouse_robotics: {
    north_america: { cashUsd: 7_000_000, revenueUsd: 8_792_000, unitPriceUsd: 28_000 },
    europe: { cashUsd: 7_000_000, revenueUsd: 7_112_000, unitPriceUsd: 28_000 },
    east_asia: { cashUsd: 7_000_000, revenueUsd: 5_740_000, unitPriceUsd: 28_000 },
    south_asia: { cashUsd: 7_000_000, revenueUsd: 3_724_000, unitPriceUsd: 28_000 },
    middle_east: { cashUsd: 7_000_000, revenueUsd: 6_412_000, unitPriceUsd: 28_000 },
    latin_america: { cashUsd: 7_000_000, revenueUsd: 4_396_000, unitPriceUsd: 28_000 },
  },
  humanoid_lab: {
    north_america: { cashUsd: 58_233_550, revenueUsd: 0, unitPriceUsd: 70_432 },
    europe: { cashUsd: 46_059_388, revenueUsd: 0, unitPriceUsd: 70434.65 },
    east_asia: { cashUsd: 36_320_336, revenueUsd: 0, unitPriceUsd: 70432.89 },
    south_asia: { cashUsd: 22_000_000, revenueUsd: 0, unitPriceUsd: 70431.56 },
    middle_east: { cashUsd: 41_190_243, revenueUsd: 0, unitPriceUsd: 70428.47 },
    latin_america: { cashUsd: 26_581_286, revenueUsd: 0, unitPriceUsd: 70431.12 },
  },
  contract_manufacturer: {
    north_america: { cashUsd: 9_000_000, revenueUsd: 14_004_000, unitPriceUsd: 9_000 },
    europe: { cashUsd: 9_000_000, revenueUsd: 14_004_000, unitPriceUsd: 9_000 },
    east_asia: { cashUsd: 9_000_000, revenueUsd: 14_004_000, unitPriceUsd: 9_000 },
    south_asia: { cashUsd: 9_000_000, revenueUsd: 14_004_000, unitPriceUsd: 9_000 },
    middle_east: { cashUsd: 9_000_000, revenueUsd: 14_004_000, unitPriceUsd: 9_000 },
    latin_america: { cashUsd: 9_000_000, revenueUsd: 14_004_000, unitPriceUsd: 9_000 },
  },
  precision_components: {
    north_america: { cashUsd: 5_000_000, revenueUsd: 3_071_900, unitPriceUsd: 850 },
    europe: { cashUsd: 5_000_000, revenueUsd: 2_999_650, unitPriceUsd: 850 },
    east_asia: { cashUsd: 5_000_000, revenueUsd: 2_999_650, unitPriceUsd: 850 },
    south_asia: { cashUsd: 5_000_000, revenueUsd: 2_999_650, unitPriceUsd: 850 },
    middle_east: { cashUsd: 5_000_000, revenueUsd: 2_999_650, unitPriceUsd: 850 },
    latin_america: { cashUsd: 5_000_000, revenueUsd: 2_999_650, unitPriceUsd: 850 },
  },
  grid_developer: {
    north_america: { cashUsd: 12_000_000, revenueUsd: 3_658_000, unitPriceUsd: 118_000 },
    europe: { cashUsd: 12_000_000, revenueUsd: 2_950_000, unitPriceUsd: 118_000 },
    east_asia: { cashUsd: 12_000_000, revenueUsd: 2_360_000, unitPriceUsd: 118_000 },
    south_asia: { cashUsd: 12_000_000, revenueUsd: 2_360_000, unitPriceUsd: 118_000 },
    middle_east: { cashUsd: 12_000_000, revenueUsd: 2_596_000, unitPriceUsd: 118_000 },
    latin_america: { cashUsd: 12_000_000, revenueUsd: 2_360_000, unitPriceUsd: 118_000 },
  },
  renewables_operator: {
    north_america: { cashUsd: 8_000_000, revenueUsd: 6_000_000, unitPriceUsd: 600_000 },
    europe: { cashUsd: 8_000_000, revenueUsd: 6_000_000, unitPriceUsd: 600_000 },
    east_asia: { cashUsd: 8_000_000, revenueUsd: 6_000_000, unitPriceUsd: 600_000 },
    south_asia: { cashUsd: 8_000_000, revenueUsd: 6_000_000, unitPriceUsd: 600_000 },
    middle_east: { cashUsd: 8_000_000, revenueUsd: 6_000_000, unitPriceUsd: 600_000 },
    latin_america: { cashUsd: 8_000_000, revenueUsd: 6_000_000, unitPriceUsd: 600_000 },
  },
  freight_network: {
    north_america: { cashUsd: 6_000_000, revenueUsd: 10999999.85, unitPriceUsd: 2.35 },
    europe: { cashUsd: 6_000_000, revenueUsd: 10999999.85, unitPriceUsd: 2.35 },
    east_asia: { cashUsd: 6_000_000, revenueUsd: 10999999.85, unitPriceUsd: 2.35 },
    south_asia: { cashUsd: 6_000_000, revenueUsd: 10999999.85, unitPriceUsd: 2.35 },
    middle_east: { cashUsd: 6_000_000, revenueUsd: 10999999.85, unitPriceUsd: 2.35 },
    latin_america: { cashUsd: 6_000_000, revenueUsd: 10999999.85, unitPriceUsd: 2.35 },
  },
  last_mile: {
    north_america: { cashUsd: 4_000_000, revenueUsd: 3_200_001, unitPriceUsd: 10.5 },
    europe: { cashUsd: 4_000_000, revenueUsd: 3_200_001, unitPriceUsd: 10.5 },
    east_asia: { cashUsd: 4_000_000, revenueUsd: 3_200_001, unitPriceUsd: 10.5 },
    south_asia: { cashUsd: 4_000_000, revenueUsd: 3_200_001, unitPriceUsd: 10.5 },
    middle_east: { cashUsd: 4_000_000, revenueUsd: 3_200_001, unitPriceUsd: 10.5 },
    latin_america: { cashUsd: 4_000_000, revenueUsd: 3_200_001, unitPriceUsd: 10.5 },
  },
  direct_brand: {
    north_america: { cashUsd: 5_000_000, revenueUsd: 4434482.43, unitPriceUsd: 499.21 },
    europe: { cashUsd: 5_000_000, revenueUsd: 4000179.37, unitPriceUsd: 500.21 },
    east_asia: { cashUsd: 5_000_000, revenueUsd: 3999816.78, unitPriceUsd: 499.54 },
    south_asia: { cashUsd: 5_000_000, revenueUsd: 3999805.6, unitPriceUsd: 499.04 },
    middle_east: { cashUsd: 5_000_000, revenueUsd: 3999887.58, unitPriceUsd: 497.87 },
    latin_america: { cashUsd: 5_000_000, revenueUsd: 3999939.66, unitPriceUsd: 498.87 },
  },
  retail_platform: {
    north_america: { cashUsd: 10_000_000, revenueUsd: 3_069_891, unitPriceUsd: 9 },
    europe: { cashUsd: 10_000_000, revenueUsd: 2_600_001, unitPriceUsd: 9 },
    east_asia: { cashUsd: 10_000_000, revenueUsd: 2_600_001, unitPriceUsd: 9 },
    south_asia: { cashUsd: 10_000_000, revenueUsd: 2_600_001, unitPriceUsd: 9 },
    middle_east: { cashUsd: 10_000_000, revenueUsd: 2_600_001, unitPriceUsd: 9 },
    latin_america: { cashUsd: 10_000_000, revenueUsd: 2_600_001, unitPriceUsd: 9 },
  },
};

/** What one background opens with in one region. Total over both. */
export function w3OpeningFactsFor(background: BackgroundId, region: Region): W3OpeningFacts {
  return W3_BACKGROUND_OPENINGS[background][region];
}

/* -------------------------------------------------------------------------- */
/*  The card voice                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Money in the picker's own voice: `$58M`, `$5.6M`, `$0.93M`.
 *
 * Deliberately not `formatMoney` from `@frontier/shared`, which is the voice of
 * the rest of the game — it renders anything under ten million in full
 * (`$5,562,003`) because a player reading a financial statement wants the
 * dollars. A card on a 390px phone wants three characters and a magnitude, and
 * the fifteen static cards this replaces have always been written that way
 * (`$1.2M`, `$0.32M/qtr`). Same rounding rule as those: whole millions from ten
 * up, one decimal above one million, two below.
 */
export function w3CardMoney(usd: number): string {
  if (!Number.isFinite(usd)) return '—';
  const sign = usd < 0 ? '-' : '';
  const millions = Math.abs(usd) / 1e6;
  const decimals = millions >= 10 ? 0 : millions >= 1 ? 1 : 2;
  return `${sign}$${trimZeros(millions.toFixed(decimals))}M`;
}

/**
 * What one unit of a line is asked for, with the unit it is sold in:
 * `$1,500/seat`, `$39.1M/licence`, `$2.35/loaded mile`.
 *
 * Four bands, each chosen to stay inside a pill on a phone: millions in the
 * card voice above, whole thousands from ten thousand up, grouped dollars in
 * between, and cents below a hundred — a freight line sells a loaded mile for
 * $2.35, and rounding that to `$2` would understate the price of the whole
 * business by fifteen percent.
 */
export function w3CardPrice(usd: number, unitLabel: string): string {
  return `${priceFigure(usd)}/${unitLabel}`;
}

/** The money half of `w3CardPrice`, without the unit. */
function priceFigure(usd: number): string {
  if (!Number.isFinite(usd)) return '—';
  const sign = usd < 0 ? '-' : '';
  const abs = Math.abs(usd);
  if (abs >= 1e6) return w3CardMoney(usd);
  if (abs >= 10_000) return `${sign}$${groupDigits(Math.round(abs / 1000))}K`;
  if (abs >= 100 || Number.isInteger(abs)) return `${sign}$${groupDigits(Math.round(abs))}`;
  return `${sign}$${abs.toFixed(2)}`;
}

/** `"5.60"` reads as `"5.6"`, `"4.0"` as `"4"`. Trailing zeros are noise on a card. */
function trimZeros(fixed: string): string {
  return fixed.includes('.') ? fixed.replace(/0+$/, '').replace(/\.$/, '') : fixed;
}

/** Thousands separators, ASCII commas, no locale involved — the same rule `@frontier/shared` uses. */
function groupDigits(value: number): string {
  const digits = String(Math.abs(Math.round(value)));
  let out = '';
  for (let i = 0; i < digits.length; i += 1) {
    const fromEnd = digits.length - i;
    out += digits[i] ?? '';
    if (fromEnd > 1 && (fromEnd - 1) % 3 === 0) out += ',';
  }
  return out;
}

/** `aggressive_growth` reads as `Aggressive growth`. Derived, so a new posture needs no table. */
function postureLabel(posture: string): string {
  const words = posture.split('_').join(' ');
  return words.length === 0 ? words : `${words[0]?.toUpperCase() ?? ''}${words.slice(1)}`;
}

/* -------------------------------------------------------------------------- */
/*  The card                                                                   */
/* -------------------------------------------------------------------------- */

/** What a line with nothing booked yet says where a revenue figure would go. */
export const W3_NO_REVENUE_VALUE = 'None yet';

/**
 * The four stats on one world-3 background card.
 *
 * Cash, then what the line billed last quarter, then what one unit of it sells
 * for, then the leverage — or the posture when there is no debt to state, which
 * is the more useful fourth fact for the six backgrounds that open unlevered.
 */
export function world3BackgroundHighlights(background: BackgroundId, region: Region): readonly NewGameBackgroundHighlight[] {
  const facts = w3OpeningFactsFor(background, region);
  const seed = W2_PLAYER_BACKGROUNDS[background];
  const unitLabel = ECONOMIC_NODES_BY_ID[startingLineNodeFor(background)]?.unitLabel ?? 'unit';
  return [
    { label: 'Cash', value: w3CardMoney(facts.cashUsd) },
    { label: 'Revenue', value: facts.revenueUsd > 0 ? `${w3CardMoney(facts.revenueUsd)}/qtr` : W3_NO_REVENUE_VALUE },
    { label: 'Price', value: w3CardPrice(facts.unitPriceUsd, unitLabel) },
    seed.debt > 0
      ? { label: 'Debt', value: w3CardMoney(seed.debt) }
      : { label: 'Posture', value: postureLabel(seed.posture) },
  ];
}

/**
 * One background card as world 3 opens it: the contracts card's own copy —
 * icon, label, tagline, blurb, all unchanged — carrying the stats this world
 * actually produces.
 */
export function world3Background(background: NewGameBackground, region: Region): NewGameBackground {
  return { ...background, highlights: world3BackgroundHighlights(background.id, region) };
}

/** The cards for one sector, in pick order, told in world-3 numbers. */
export function world3BackgroundsForSector(sector: Sector, region: Region): readonly NewGameBackground[] {
  return backgroundsForSector(sector).map((background) => world3Background(background, region));
}

