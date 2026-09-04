/**
 * The New Game picker tells the truth about the world it is about to build.
 *
 * The cards a founder chooses from are the first screen of a new game and the
 * only description of a company they will spend a campaign inside. The numbers
 * on them used to be hand-written beside the world-2 scenario and went stale
 * the moment world 3 repriced every line: an enterprise card offering "$4M,
 * 1,600 seats, $0.32M/qtr" against a company that opens on $5.56M and $3.83M a
 * quarter, a humanoid laboratory sold as "$22M, pre-revenue" against one that
 * opens on as much as $58M with a pilot line selling robots at $70K each.
 *
 * So this file is the thing that stops that happening again. For all fifteen
 * backgrounds in all six regions it builds the REAL session the picker's button
 * would build — `createWorld3Session` at `W3_SEED`, the same three-pass
 * price/scale/fund construction the game uses — and holds every figure the card
 * displays against the company that session actually contains:
 *
 * - the stored table is exact, to the cent, against the built company;
 * - every rendered string parses back to the company's own figure inside the
 *   tolerance its own rounding implies, so a formatting change that lies fails
 *   here rather than on a phone;
 * - a card may say a line has no revenue only when the line has no revenue;
 * - worlds 1 and 2 are untouched — the same card objects, the same strings.
 *
 * Deterministic: `createWorld3Session` is a pure function of the seed and the
 * setup, so these ninety sessions are the same on every machine.
 */

import { describe, expect, it } from 'vitest';
import {
  ALL_BACKGROUNDS,
  ECONOMIC_NODES_BY_ID,
  NewGameSetupSchema,
  REGIONS,
  SECTORS,
  backgroundsForSector,
  defaultRegionFor,
  sectorForBackground,
  startingLineNodeFor,
  type BackgroundId,
  type Company,
  type NewGameBackground,
  type Region,
} from '@frontier/contracts';
import { backgroundCardsFor } from '../src/scenario';
import { W2_COMPANIES } from '../src/scenario/world2';
import {
  W3_BACKGROUND_OPENINGS,
  W3_NO_REVENUE_VALUE,
  W3_SEED,
  createWorld3Session,
  w3CardMoney,
  w3CardPrice,
  w3OpeningFactsFor,
  world3Background,
  world3BackgroundHighlights,
} from '../src/scenario/world3';

/* -------------------------------------------------------------------------- */
/*  The ninety worlds the picker is describing                                 */
/* -------------------------------------------------------------------------- */

const setupFor = (backgroundId: BackgroundId, region: Region) =>
  NewGameSetupSchema.parse({
    companyName: 'Probe Ventures',
    founderName: 'Probe Founder',
    backgroundId,
    sector: sectorForBackground(backgroundId),
    region,
    worldVersion: 3,
  });

/**
 * The player company each (background, region) pair actually opens with.
 *
 * Built once — ninety sessions is a couple of seconds, and every assertion
 * below reads from the same worlds, so a figure cannot be true of one pass and
 * false of the next.
 */
const OPENINGS: ReadonlyMap<string, Company> = (() => {
  const built = new Map<string, Company>();
  for (const background of ALL_BACKGROUNDS) {
    for (const region of REGIONS) {
      const state = createWorld3Session(W3_SEED, setupFor(background.id, region));
      const player = state.companies.find((company) => company.id === W2_COMPANIES.player);
      if (player !== undefined) built.set(`${background.id}|${region}`, player);
    }
  }
  return built;
})();

const openingOf = (background: BackgroundId, region: Region): Company => {
  const company = OPENINGS.get(`${background}|${region}`);
  if (company === undefined) throw new Error(`no world-3 opening built for ${background} in ${region}`);
  return company;
};

/* -------------------------------------------------------------------------- */
/*  Reading a card value back                                                  */
/* -------------------------------------------------------------------------- */

/**
 * What a displayed figure claims, and how wrong it is allowed to be.
 *
 * The card rounds — `$5.6M` for $5,562,003 — so the claim is not the exact
 * dollar but a band half a displayed digit wide. Anything outside that band is
 * a card saying something the world does not say. Handles every shape the
 * formatters emit: a millions or thousands suffix, grouping commas, cents, and
 * a trailing `/qtr` or `/seat` that is not part of the number.
 */
function claimOf(display: string): { readonly value: number; readonly tolerance: number } {
  const head = display.split('/')[0] ?? '';
  expect(head.startsWith('$'), `${display} is not a money figure`).toBe(true);
  const body = head.slice(1);
  const suffix = body.endsWith('M') ? 'M' : body.endsWith('K') ? 'K' : '';
  const scale = suffix === 'M' ? 1e6 : suffix === 'K' ? 1e3 : 1;
  const digits = (suffix === '' ? body : body.slice(0, -1)).replace(/,/g, '');
  expect(digits, `${display} carries no number`).toMatch(/^-?\d+(\.\d+)?$/);
  const decimals = digits.includes('.') ? (digits.split('.')[1]?.length ?? 0) : 0;
  return { value: Number(digits) * scale, tolerance: 0.5 * 10 ** -decimals * scale };
}

/** Assert a displayed figure is the world's own figure, to the card's own rounding. */
function expectClaim(display: string, actualUsd: number, what: string): void {
  const claim = claimOf(display);
  expect(
    Math.abs(claim.value - actualUsd) <= claim.tolerance,
    `${what}: card says ${display} (${claim.value} ± ${claim.tolerance}) but the world opens at ${actualUsd}`,
  ).toBe(true);
}

/** The four highlights of one card, keyed by label, so an assertion can name what it wants. */
function highlightsByLabel(card: NewGameBackground): ReadonlyMap<string, string> {
  return new Map(card.highlights.map((highlight) => [highlight.label, highlight.value] as const));
}

/* -------------------------------------------------------------------------- */
/*  The table is what the world does                                           */
/* -------------------------------------------------------------------------- */

describe('the world-3 opening table', () => {
  it('states, to the cent, what every background opens with in every region', () => {
    for (const background of ALL_BACKGROUNDS) {
      for (const region of REGIONS) {
        const company = openingOf(background.id, region);
        const facts = w3OpeningFactsFor(background.id, region);
        const where = `${background.id} in ${region}`;
        expect(facts.cashUsd, `${where}: stored cash is stale`).toBe(company.financials.cash);
        expect(facts.revenueUsd, `${where}: stored revenue is stale`).toBe(company.financials.revenueQuarterly);
        expect(facts.unitPriceUsd, `${where}: stored unit price is stale`).toBe(company.products[0]?.pricePerSeat);
      }
    }
  }, 120_000);

  it('covers every background and every region exactly once', () => {
    expect(Object.keys(W3_BACKGROUND_OPENINGS).sort()).toEqual(ALL_BACKGROUNDS.map((entry) => entry.id).sort());
    for (const background of ALL_BACKGROUNDS) {
      expect(Object.keys(W3_BACKGROUND_OPENINGS[background.id]).sort(), background.id).toEqual([...REGIONS].sort());
    }
  });
});

/* -------------------------------------------------------------------------- */
/*  Every displayed value is true                                              */
/* -------------------------------------------------------------------------- */

describe('what the world-3 picker displays', () => {
  it('shows four stats on every card, in every region', () => {
    for (const background of ALL_BACKGROUNDS) {
      for (const region of REGIONS) {
        const highlights = world3BackgroundHighlights(background.id, region);
        expect(highlights, `${background.id} in ${region}`).toHaveLength(4);
        for (const highlight of highlights) {
          expect(highlight.label.length, `${background.id}: empty label`).toBeGreaterThan(0);
          expect(highlight.value.length, `${background.id}: empty value`).toBeGreaterThan(0);
        }
      }
    }
  });

  it('states the cash the founder will actually be looking at', () => {
    for (const background of ALL_BACKGROUNDS) {
      for (const region of REGIONS) {
        const shown = highlightsByLabel(world3Background(background, region)).get('Cash') ?? '';
        expectClaim(shown, openingOf(background.id, region).financials.cash, `${background.id} in ${region} cash`);
      }
    }
  });

  it('states the revenue the opening line actually books, and claims none only when there is none', () => {
    for (const background of ALL_BACKGROUNDS) {
      for (const region of REGIONS) {
        const company = openingOf(background.id, region);
        const shown = highlightsByLabel(world3Background(background, region)).get('Revenue') ?? '';
        const where = `${background.id} in ${region}`;
        if (shown === W3_NO_REVENUE_VALUE) {
          // The defect this file exists for: a card telling a founder their
          // company is pre-revenue when the seeded line already bills.
          expect(company.financials.revenueQuarterly, `${where}: card says "${W3_NO_REVENUE_VALUE}" but the line has revenue`).toBe(0);
        } else {
          expect(company.financials.revenueQuarterly, `${where}: card states a revenue figure but the line has none`).toBeGreaterThan(0);
          expect(shown.endsWith('/qtr'), `${where}: a revenue figure has to say it is quarterly`).toBe(true);
          expectClaim(shown, company.financials.revenueQuarterly, `${where} revenue`);
        }
      }
    }
  });

  it('states what one unit of the opening line is asked for, in the unit the node is sold in', () => {
    for (const background of ALL_BACKGROUNDS) {
      for (const region of REGIONS) {
        const company = openingOf(background.id, region);
        const product = company.products[0];
        const nodeId = product?.nodeId ?? '';
        const node = ECONOMIC_NODES_BY_ID[nodeId];
        const shown = highlightsByLabel(world3Background(background, region)).get('Price') ?? '';
        const where = `${background.id} in ${region}`;
        expect(nodeId, `${where}: the opening line is not on a node`).toBe(startingLineNodeFor(background.id));
        expectClaim(shown, product?.pricePerSeat ?? 0, `${where} unit price`);
        expect(shown.slice(shown.indexOf('/') + 1), `${where}: the unit is not the node's own`).toBe(node?.unitLabel);
      }
    }
  });

  it('states the debt a levered company opens with, and its posture when it opens with none', () => {
    for (const background of ALL_BACKGROUNDS) {
      for (const region of REGIONS) {
        const company = openingOf(background.id, region);
        const shown = highlightsByLabel(world3Background(background, region));
        const where = `${background.id} in ${region}`;
        if (company.financials.debt > 0) {
          expect(shown.has('Posture'), `${where}: a levered company should be showing its debt`).toBe(false);
          expectClaim(shown.get('Debt') ?? '', company.financials.debt, `${where} debt`);
        } else {
          expect(shown.has('Debt'), `${where}: there is no debt to state`).toBe(false);
          const words = company.posture.split('_').join(' ');
          expect(shown.get('Posture'), `${where}: posture`).toBe(`${words[0]?.toUpperCase() ?? ''}${words.slice(1)}`);
        }
      }
    }
  });

  it('keeps every value short enough for a 390px card', () => {
    for (const background of ALL_BACKGROUNDS) {
      for (const region of REGIONS) {
        for (const highlight of world3BackgroundHighlights(background.id, region)) {
          expect(highlight.label.length, `${background.id}: label "${highlight.label}" is long`).toBeLessThanOrEqual(10);
          expect(highlight.value.length, `${background.id}: value "${highlight.value}" wraps`).toBeLessThanOrEqual(18);
        }
      }
    }
  });

  it('carries the contracts copy through untouched — only the numbers are the scenario\'s', () => {
    for (const background of ALL_BACKGROUNDS) {
      const card = world3Background(background, defaultRegionFor(background.sector));
      expect(card.id).toBe(background.id);
      expect(card.sector).toBe(background.sector);
      expect(card.icon).toBe(background.icon);
      expect(card.label).toBe(background.label);
      expect(card.tagline).toBe(background.tagline);
      expect(card.blurb).toBe(background.blurb);
    }
  });

  it('is a pure function of the background and the region', () => {
    for (const background of ALL_BACKGROUNDS) {
      const region = defaultRegionFor(background.sector);
      expect(world3BackgroundHighlights(background.id, region)).toEqual(world3BackgroundHighlights(background.id, region));
    }
  });
});

/* -------------------------------------------------------------------------- */
/*  The specific figures that were wrong                                       */
/* -------------------------------------------------------------------------- */

describe('the stale world-2 figures', () => {
  /**
   * Every value on a static card that the world-3 opening contradicts, from an
   * audit of all fifteen.
   *
   * Judged at each sector's DEFAULT region, which is the one the picker uses
   * when the founder has not chosen — several of these are true somewhere else
   * on the map, which is the whole reason the world-3 table is per region. The
   * other five backgrounds (contract manufacturer, precision components, grid
   * developer, renewables operator, direct brand) were stating the truth all
   * along; their figures are re-derived here rather than assumed, and they came
   * back the same.
   */
  const STALE: readonly { readonly id: BackgroundId; readonly claims: readonly string[] }[] = [
    // 172 accelerators, not 800; and a pilot line that bills $39M a licence.
    { id: 'frontier_lab', claims: ['800 owned', 'Pre-revenue'] },
    // $5.56M and $3.83M a quarter off 2,556 seats.
    { id: 'enterprise_ai', claims: ['$4M', '1,600 seats', '$0.32M/qtr'] },
    // 375,000 subscribers, and a line grossing 42% at the statement.
    { id: 'consumer_ai', claims: ['750K users', 'Thin'] },
    // 11,025 accelerators: the fleet is sized to what the line draws.
    { id: 'infrastructure', claims: ['4,000 owned'] },
    // The run rate covers the wage bill, so the bank opens at $1.86M.
    { id: 'bootstrapper', claims: ['$1.2M'] },
    // 205 robots and $5.74M a quarter.
    { id: 'warehouse_robotics', claims: ['1,200 units', '$2M/qtr'] },
    // The complaint in the brief: $36M in East Asia, and robots at $70K.
    { id: 'humanoid_lab', claims: ['$22M', 'Pre-revenue'] },
    // A parcel sells for $10.50 against a positive gross margin.
    { id: 'last_mile', claims: ['Negative'] },
    // World 3 has no take rate and no seller count: a marketplace sells
    // buyer-quarters at a node price like everything else.
    { id: 'retail_platform', claims: ['12%', '3,400'] },
  ];

  it('no longer appear on the card the world-3 picker draws', () => {
    for (const { id, claims } of STALE) {
      const sector = sectorForBackground(id);
      const shown = world3BackgroundHighlights(id, defaultRegionFor(sector)).map((highlight) => highlight.value);
      for (const claim of claims) expect(shown, `${id} still claims "${claim}"`).not.toContain(claim);
    }
  });

  it('leaves a humanoid laboratory described as what it is: funded, and selling robots', () => {
    // The complaint in so many words: "pre-revenue with $22M" against a company
    // that opens with tens of millions and a pilot line already producing.
    const card = highlightsByLabel(world3Background(ALL_BACKGROUNDS.find((entry) => entry.id === 'humanoid_lab')!, 'north_america'));
    const company = openingOf('humanoid_lab', 'north_america');
    expect(company.financials.cash).toBeGreaterThan(50_000_000);
    expectClaim(card.get('Cash') ?? '', company.financials.cash, 'humanoid cash');
    expect(card.get('Price')).toBe(w3CardPrice(company.products[0]?.pricePerSeat ?? 0, 'robot'));
  });
});

/* -------------------------------------------------------------------------- */
/*  The card voice                                                             */
/* -------------------------------------------------------------------------- */

describe('the card formatters', () => {
  it('writes money the way the picker has always written it', () => {
    expect(w3CardMoney(15_000_000)).toBe('$15M');
    expect(w3CardMoney(58_233_550)).toBe('$58M');
    expect(w3CardMoney(5_562_003)).toBe('$5.6M');
    expect(w3CardMoney(4_000_000)).toBe('$4M');
    expect(w3CardMoney(933_300)).toBe('$0.93M');
    expect(w3CardMoney(500_000)).toBe('$0.5M');
    expect(w3CardMoney(0)).toBe('$0M');
  });

  it('keeps the cents on a price small enough to need them', () => {
    expect(w3CardPrice(2.35, 'loaded mile')).toBe('$2.35/loaded mile');
    expect(w3CardPrice(10.5, 'parcel')).toBe('$10.50/parcel');
    expect(w3CardPrice(16, 'subscriber')).toBe('$16/subscriber');
    expect(w3CardPrice(1_500, 'seat')).toBe('$1,500/seat');
    expect(w3CardPrice(70_432, 'robot')).toBe('$70K/robot');
    expect(w3CardPrice(366_216.07, '1e24 FLOP')).toBe('$366K/1e24 FLOP');
    expect(w3CardPrice(39_131_918.22, 'licence')).toBe('$39M/licence');
  });
});

/* -------------------------------------------------------------------------- */
/*  Worlds 1 and 2 do not move                                                 */
/* -------------------------------------------------------------------------- */

describe('the picker dispatcher', () => {
  it('hands worlds 1 and 2 the static cards, unchanged and unwrapped', () => {
    for (const sector of SECTORS) {
      for (const region of REGIONS) {
        for (const version of [1, 2] as const) {
          const cards = backgroundCardsFor(sector, region, version);
          const statics = backgroundsForSector(sector);
          expect(cards).toHaveLength(statics.length);
          // The card OBJECTS themselves, not copies of them: a world-2 player
          // sees the contracts copy exactly as it has always been written.
          cards.forEach((card, index) => expect(card, `${sector} world ${version}`).toBe(statics[index]));
        }
      }
    }
  });

  it('hands world 3 the same cards in the same order, told in world-3 numbers', () => {
    for (const sector of SECTORS) {
      const region = defaultRegionFor(sector);
      const cards = backgroundCardsFor(sector, region, 3);
      expect(cards.map((card) => card.id)).toEqual(backgroundsForSector(sector).map((card) => card.id));
      for (const card of cards) expect(card.highlights).toEqual(world3BackgroundHighlights(card.id, region));
    }
  });

  it('defaults to the world a new game is actually created in', () => {
    for (const sector of SECTORS) {
      const region = defaultRegionFor(sector);
      expect(backgroundCardsFor(sector, region)).toEqual(backgroundCardsFor(sector, region, 3));
    }
  });
});
