/**
 * The picture, judged by what actually comes out of the renderer.
 *
 * `apps/web` has no jsdom, so the diagram is rendered to static markup — the
 * same technique `canvas.test.tsx` used — and the markup itself is searched.
 * That is deliberate: the markup is the last thing before the screen, so a
 * leak introduced anywhere upstream of it lands here.
 *
 * Four claims.
 *
 * 1. **It fits a phone.** At 356 points nothing is positioned past the right
 *    edge and every pill is at least 44 points tall.
 * 2. **A rival's economics never reach the client.** A rival is stamped with
 *    five values that collide with nothing else in the world, and none of them
 *    appears in the markup of my picture or of theirs — raw or formatted.
 * 3. **The order book is exactly mine.** The units on a wire I am standing on
 *    are printed; the units on a wire between two other companies are not, and
 *    the same wire prints them for a seat that is on it.
 * 4. **The drawing says what the states mean.** Dashed exactly for possible
 *    routes, a gain ring on the target cell, and the margin disc carrying the
 *    line's own rounded percent.
 */

import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Company, GovernmentContract, Product } from '@frontier/contracts';
import type { LineCustomer } from '@frontier/simulation';
import { connectionsOf, createWorld3Session } from '@frontier/simulation';
import { formatCount } from '@frontier/shared';
import { ConnectionsDiagram } from './ConnectionsDiagram';
import { NAME_SIZES, NESTED_NAME_SIZES, PILL_CHROME, ROW_CH, ROW_SIZES, TAG_CHROME, lineCount, nameSizePx, rowSizePx } from './ConnectionPill';
import { NESTED_INDENT, layoutConnections } from './layout';
import { connectionsModel, layoutGroupsOf, tagCount } from './model';

const PLAYER = 'cmp_player_ventures';
const WIDTH = 356;

/** The five numbers a rival owns, none of which collides with anything else in the world. */
const RIVAL_LIST_PRICE = 7_777_777;
const RIVAL_UNIT_COST = 6_666_666;
const RIVAL_MARGIN = 0.123_456;
const RIVAL_QUALITY = 0.987_654;
const RIVAL_ASK = 5_555_555;
const SECRETS = ['7777777', '7,777,777', '6666666', '6,666,666', '0.123456', '0.987654', '5555555', '5,555,555'] as const;

type World = ReturnType<typeof createWorld3Session>;

function companyOf(state: World, id: string): Company {
  const company = state.companies.find((candidate) => candidate.id === id);
  if (company === undefined) throw new Error(`${id} is not in the seeded world`);
  return company;
}

function productOn(company: Company, nodeId: string): Product {
  const product = company.products.find((candidate) => candidate.nodeId === nodeId);
  if (product === undefined) throw new Error(`${company.id} runs no line on ${nodeId}`);
  return product;
}

function archetypesOf(state: World): Record<string, string> {
  const out: Record<string, string> = {};
  for (const company of state.companies) out[company.id] = company.archetype;
  return out;
}

/** One picture, from `viewerId`'s seat, of `subjectId`, as markup. */
function render(state: World, viewerId: string, subjectId: string, productId: string | null = null, width = WIDTH): string {
  const model = connectionsModel(connectionsOf(state, viewerId, subjectId, productId), { archetypes: archetypesOf(state) });
  const layout = layoutConnections({
    width,
    left: layoutGroupsOf(model.left),
    right: layoutGroupsOf(model.right),
    hub: { showOutput: model.hub?.showOutput ?? false },
  });
  return renderToStaticMarkup(<ConnectionsDiagram model={model} layout={layout} />);
}

/** Every absolutely positioned box in the markup, from its inline style. */
interface Positioned {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
  readonly testId: string | null;
}

function positionsOf(markup: string): readonly Positioned[] {
  const out: Positioned[] = [];
  for (const match of markup.matchAll(/<[^>]*style="([^"]*)"[^>]*>/g)) {
    const tag = match[0];
    const style = match[1] ?? '';
    // React drops the unit on a zero, so a pill flush against the left edge
    // renders `left:0` — without this the whole left column would be skipped
    // by the very check that proves it fits.
    const read = (property: string): number | null => {
      const found = new RegExp(`(?:^|;)\\s*${property}:\\s*(-?[\\d.]+)(?:px)?(?:;|$)`).exec(style);
      return found === null ? null : Number(found[1]);
    };
    const left = read('left');
    const width = read('width');
    if (left === null || width === null) continue;
    const testId = /data-testid="([^"]*)"/.exec(tag)?.[1] ?? null;
    out.push({ left, top: read('top') ?? 0, width, height: read('height') ?? 0, testId });
  }
  return out;
}

/** Stamp a rival's line with the five numbers nobody else in the world owns. */
function stamp(line: Product): void {
  line.pricePerSeat = RIVAL_LIST_PRICE;
  line.unitCostUsd = RIVAL_UNIT_COST;
  line.grossMarginPct = RIVAL_MARGIN;
  line.qualityScore = RIVAL_QUALITY;
  line.supplyTerms = { openToAll: true, pricePerUnitUsd: RIVAL_ASK, exclusiveCustomerIds: [], blockedCustomerIds: [] };
}

/* -------------------------------------------------------------------------- */
/*  It fits the phone it is played on                                          */
/* -------------------------------------------------------------------------- */

describe('the picture fits a 390-point phone', () => {
  it('positions nothing past the right edge and draws no pill under 44 points', () => {
    const markup = render(createWorld3Session(), PLAYER, PLAYER);
    const boxes = positionsOf(markup);
    expect(boxes.length).toBeGreaterThan(5);
    for (const box of boxes) {
      expect(box.left, `an element starts at ${box.left}`).toBeGreaterThanOrEqual(0);
      expect(box.left + box.width, `${box.testId ?? 'an element'} runs to ${box.left + box.width}`).toBeLessThanOrEqual(WIDTH);
    }
    const pills = boxes.filter((box) => box.testId === 'conn-pill');
    expect(pills.length).toBeGreaterThan(3);
    for (const pill of pills) expect(pill.height).toBeGreaterThanOrEqual(44);
    // Both columns really were parsed: the left one sits at zero, which is the
    // edge a lazy parser silently drops and the edge a bad layout falls off.
    expect(pills.some((pill) => pill.left === 0)).toBe(true);
    expect(pills.some((pill) => pill.left > WIDTH / 2)).toBe(true);
  });

  it('draws a hub, a margin badge and a pill for every model pill, and nothing wider than the container', () => {
    const markup = render(createWorld3Session(), PLAYER, PLAYER);
    expect(markup).toContain('data-testid="connections"');
    expect(markup).toContain('data-testid="conn-hub"');
    expect(markup).toContain('data-side="left"');
    expect(markup).toContain('data-side="right"');
    // The SVG is exactly the container; nothing draws outside it.
    expect(markup).toContain(`width="${WIDTH}"`);
    for (const width of [320, 328, 390, 560]) {
      for (const box of positionsOf(render(createWorld3Session(), PLAYER, PLAYER, null, width))) {
        expect(box.left).toBeGreaterThanOrEqual(0);
        expect(box.left + box.width).toBeLessThanOrEqual(width);
      }
    }
  });
});

/* -------------------------------------------------------------------------- */
/*  Redaction, at the last point before the screen                             */
/* -------------------------------------------------------------------------- */

describe('a rival economics never reach the picture', () => {
  it('carries no rival list price, unit cost, margin, quality or ask, on my picture or on theirs', () => {
    const state = createWorld3Session();
    const basalt = companyOf(state, 'cmp_basalt');
    // The line my own model slot buys from, so their name is on my picture and
    // their numbers must not be.
    stamp(productOn(basalt, 'svc_inference_api'));
    stamp(productOn(basalt, 'svc_datacentre_capacity'));

    for (const markup of [render(state, PLAYER, PLAYER), render(state, PLAYER, basalt.id)]) {
      for (const secret of SECRETS) {
        expect(markup.includes(secret), `${secret} reached the client`).toBe(false);
      }
      expect(markup.length).toBeGreaterThan(1_000);
    }
  });

  it('gives a rival hub no figures at all, and their suppliers no prices', () => {
    const state = createWorld3Session();
    const markup = render(state, PLAYER, 'cmp_basalt');
    expect(markup).toContain('data-testid="conn-hub"');
    // The four figures the hub exists to show a founder about their OWN line.
    for (const word of ['Cost $', 'Price $', 'Ask $']) expect(markup.includes(word)).toBe(false);
    // No margin badge, and no tap target on somebody else's line.
    expect(markup.includes('data-testid="conn-margin"')).toBe(false);
    expect(markup.includes('data-testid="conn-hub-tap"')).toBe(false);
    // My own picture has all four.
    const mine = render(state, PLAYER, PLAYER);
    expect(mine).toContain('Cost $');
    expect(mine).toContain('Price $');
    expect(mine).toContain('data-testid="conn-margin"');
    expect(mine).toContain('data-testid="conn-hub-tap"');
  });
});

/* -------------------------------------------------------------------------- */
/*  The words are sized to the box they land in                                */
/* -------------------------------------------------------------------------- */

/**
 * The two functions that decide whether anything is legible, judged against the
 * two widths the app actually renders: 130-point pills on a 390-point phone,
 * 115 on a 360-point one, and 16 points narrower again when nested.
 *
 * A critic pass measured the failure these replace: "Manufacturing enterprises"
 * overflowing a 72-point box by 27 and hard-clipped mid-word, four nested pills
 * all reading "Lets you se…", and a data row of 42 points asked to carry 116.
 */
describe('a pill sizes its words to the box it was given', () => {
  const WIDE = 130;
  const NARROW = 115;

  /** Two lines, wrapped the way the pill's own model wraps them. */
  function fits(text: string, size: number, pillWidth: number): boolean {
    return lineCount(text, size, pillWidth - PILL_CHROME) <= 2;
  }

  it('steps a name down until its longest word and its whole self fit two lines', () => {
    // The seeded world's longest full-width names: market cells, companies and
    // the nodes a supplier column draws.
    for (const name of [
      'Manufacturing enterprises',
      'Logistics enterprises',
      'Kestrel Data Foundry',
      'Northgate Capacity Co',
      'Anode-grade graphite',
      'Vertical application',
      'Model evaluation',
      'Basalt Compute',
    ]) {
      for (const width of [WIDE, NARROW]) {
        const size = nameSizePx(name, width, false);
        expect(fits(name, size, width), `${name} at ${size}px in ${width}`).toBe(true);
        // And it is the *largest* such size: one step up would need three lines.
        const above = NAME_SIZES[NAME_SIZES.indexOf(size) - 1];
        if (above !== undefined) expect(fits(name, above, width), `${name} could have been ${above}px`).toBe(false);
      }
    }
    // A nested pill is 16 points narrower and only ever carries a node label,
    // which is what the research picture hangs under a programme.
    for (const name of ['Model evaluation', 'Agent platform', 'Frontier model', 'Training run', 'Inference API']) {
      for (const width of [WIDE - NESTED_INDENT, NARROW - NESTED_INDENT]) {
        const size = nameSizePx(name, width, true);
        expect(fits(name, size, width), `${name} at ${size}px in ${width}`).toBe(true);
        const above = NESTED_NAME_SIZES[NESTED_NAME_SIZES.indexOf(size) - 1];
        if (above !== undefined) expect(fits(name, above, width), `${name} could have been ${above}px`).toBe(false);
      }
    }
  });

  it('never draws a name larger than its ceiling or smaller than its floor, and never grows as the box narrows', () => {
    expect(nameSizePx('Basalt', 200, false)).toBe(NAME_SIZES[0]);
    expect(nameSizePx('Basalt', 200, true)).toBe(NESTED_NAME_SIZES[0]);
    expect(nameSizePx('Incomprehensibilities', 60, false)).toBe(NAME_SIZES[NAME_SIZES.length - 1]);
    for (const name of ['Manufacturing enterprises', 'Kestrel Data Foundry', 'Basalt Compute']) {
      expect(nameSizePx(name, NARROW, false)).toBeLessThanOrEqual(nameSizePx(name, WIDE, false));
      // Pure: the same string and width give the same size, twice.
      expect(nameSizePx(name, NARROW, false)).toBe(nameSizePx(name, NARROW, false));
    }
  });

  it('steps a data row down until the figure tag and the words beside it fit one line', () => {
    for (const [figure, detail] of [
      ['$2.5K', '<1% share'],
      ['$423', 'qual 100%'],
      ['>200q', '+compute'],
      ['$12', '×67K'],
      ['14M', 'wanted'],
      ['$4.0M', 'consortium'],
      [null, 'publish it'],
      [null, '1 step short'],
    ] as const) {
      for (const width of [WIDE, NARROW]) {
        const size = rowSizePx(figure, detail, width);
        const room = width - PILL_CHROME - (figure === null ? 0 : TAG_CHROME);
        const chars = (figure === null ? 0 : figure.length) + detail.length;
        expect(chars * ROW_CH * size, `"${figure ?? ''} ${detail}" at ${size}px in ${width}`).toBeLessThanOrEqual(room);
      }
    }
  });

  it('leaves a short row at full size and only shrinks the long ones', () => {
    expect(rowSizePx('14M', 'wanted', WIDE)).toBe(ROW_SIZES[0]);
    expect(rowSizePx('$12', '×67K', WIDE)).toBe(ROW_SIZES[0]);
    expect(rowSizePx(null, null, NARROW)).toBe(ROW_SIZES[0]);
    // The longest rows the model can produce are the ones that step down.
    expect(rowSizePx('$2.5K', '<1% share', NARROW)).toBeLessThan(ROW_SIZES[0] ?? 9);
  });
});

/* -------------------------------------------------------------------------- */
/*  The order book                                                             */
/* -------------------------------------------------------------------------- */

describe('the order book is exactly the wires I am standing on', () => {
  it('prints what I draw from my own supplier', () => {
    const state = createWorld3Session();
    const app = productOn(companyOf(state, PLAYER), 'app_ai_software_suite');
    app.unitsSoldQuarterly = 1_111;
    app.activeCustomers = 1_111;
    const view = connectionsOf(state, PLAYER, PLAYER, app.id);
    const units = view.suppliers.find((supplier) => supplier.slotId === 'model')?.options[0]?.unitsDrawnLastQuarter;
    expect(units).toBe(1_111 * 40);

    const markup = render(state, PLAYER, PLAYER, app.id);
    // The tag, not the raw count: "44,440" is six characters of a row that has
    // room for six *including* the word that says what they are.
    expect(markup).toContain(`×${tagCount(units ?? 0)}`);
    expect(markup).toContain(formatCount(units ?? 0));
  });

  it('prints nothing about a wire between two other companies, and everything about it from a seat that is on it', () => {
    const state = createWorld3Session();
    // Basalt buys its interconnect from Grimsby. I am on neither end of that.
    const capacity = productOn(companyOf(state, 'cmp_basalt'), 'svc_datacentre_capacity');
    capacity.unitsSoldQuarterly = 3_333_333;
    capacity.activeCustomers = 3_333_333;
    const distinctive = formatCount(3_333_333);
    const units = connectionsOf(state, 'cmp_grimsby', 'cmp_basalt', capacity.id).suppliers.find(
      (supplier) => supplier.options[0]?.supplierCompanyId === 'cmp_grimsby',
    )?.options[0]?.unitsDrawnLastQuarter;

    const theirs = render(state, PLAYER, 'cmp_basalt');
    expect(theirs.includes(distinctive), 'a wire between two other companies leaked its volume').toBe(false);
    expect(theirs.includes('3333333')).toBe(false);
    expect(theirs.includes(tagCount(3_333_333)), 'the compact reading leaked it instead').toBe(false);

    // Grimsby is the supplier on that very wire, and sees its own half of it.
    const fromGrimsby = render(state, 'cmp_grimsby', 'cmp_basalt');
    expect(fromGrimsby).toContain(tagCount(units ?? 0));
    expect(fromGrimsby).toContain(distinctive);
  });

  it('prints my own units on a rival wire that comes from me', () => {
    const state = createWorld3Session();
    const player = companyOf(state, PLAYER);
    const app = productOn(player, 'app_ai_software_suite');
    const api: Product = {
      ...app,
      id: 'prd_player_api',
      name: 'Ventures Inference',
      nodeId: 'svc_inference_api',
      slots: [],
      supplyTerms: { openToAll: true, pricePerUnitUsd: 12, exclusiveCustomerIds: [], blockedCustomerIds: [] },
      pricePerSeat: 12,
    };
    (player.products as Product[]).push(api);

    const buyer = companyOf(state, 'cmp_lumen');
    const buyerLine = productOn(buyer, 'app_consumer_subscription');
    buyerLine.unitsSoldQuarterly = 777;
    buyerLine.activeCustomers = 777;
    const fill = buyerLine.slots?.find((slot) => slot.slotId === 'model');
    if (fill === undefined) throw new Error('the consumer subscription has no model slot to point at me');
    fill.supplierCompanyId = player.id;
    fill.supplierProductId = api.id;
    fill.nodeId = 'svc_inference_api';

    const view = connectionsOf(state, PLAYER, buyer.id, buyerLine.id);
    const units = view.suppliers.find((supplier) => supplier.slotId === 'model')?.options[0]?.unitsDrawnLastQuarter;
    expect(units).toBeGreaterThan(0);
    const markup = render(state, PLAYER, buyer.id, buyerLine.id);
    expect(markup).toContain(`×${tagCount(units ?? 0)}`);
    expect(markup).toContain(formatCount(units ?? 0));
  });
});

/* -------------------------------------------------------------------------- */
/*  What the drawing says                                                      */
/* -------------------------------------------------------------------------- */

describe('the drawing says what the states mean', () => {
  it('dashes exactly the wires of the pills that are not live', () => {
    const state = createWorld3Session();
    const model = connectionsModel(connectionsOf(state, PLAYER, PLAYER, null), { archetypes: archetypesOf(state) });
    const dashable = [...model.left, ...model.right]
      .flatMap((group) => group.pills)
      .filter((pill) => pill.state === 'possible' || pill.state === 'empty').length;
    expect(dashable).toBeGreaterThan(0);

    const markup = render(state, PLAYER, PLAYER);
    expect(markup.match(/stroke-dasharray="4 4"/g)?.length ?? 0).toBe(dashable);
    expect(markup).toContain('data-state="possible"');
    expect(markup).toContain('data-state="live"');
  });

  it('prints the margin the line actually books, and its share of the cell it sells into', () => {
    const state = createWorld3Session();
    const app = productOn(companyOf(state, PLAYER), 'app_ai_software_suite');
    const view = connectionsOf(state, PLAYER, PLAYER, app.id);
    const live = view.cells.find((cell) => cell.live);
    expect(live?.sharePct).not.toBeNull();

    const markup = render(state, PLAYER, PLAYER, app.id);
    expect(markup).toContain('data-testid="conn-margin"');
    expect(markup).toContain('var(--color-gain-strong)');
    expect(markup).toContain(`${Math.round((view.hub?.grossMarginPct ?? 0) * 100)}%`);
    // A whole-percent share of a twelve-million-unit cell rounds to nothing, and
    // "0% of demand" beside a live green pill reads as a bug rather than as a
    // small share, so anything above nothing and below half a point says so.
    expect(live?.sharePct).toBe(0);
    expect((live?.myUnits ?? 0) > 0).toBe(true);
    expect(markup).toContain('&lt;1% share');
    expect(markup.includes('0% share')).toBe(false);
  });

  /**
   * The reference's signature: a green ring per customer showing their share.
   *
   * The numbers are the ones a critic pass measured on the seeded
   * AI-infrastructure opening — three buyers drawing 280, 108 and 60 units off a
   * line that also sold 20 into its own cell. Divided by the line's own market
   * sale every one of them was over 100% and every ring drew as the same closed
   * circle; divided by everything the line put out they are four different arcs
   * that add to the whole.
   */
  it('draws a different ring for a different share of the output', () => {
    const state = createWorld3Session();
    const app = productOn(companyOf(state, PLAYER), 'app_ai_software_suite');
    app.unitsSoldQuarterly = 20;
    app.activeCustomers = 20;
    const base = connectionsOf(state, PLAYER, PLAYER, app.id);
    const buyer = (companyId: string, units: number): LineCustomer => ({
      buyerCompanyId: companyId,
      buyerProductId: `prd_${companyId}`,
      buyerNodeId: 'app_consumer_subscription',
      slotId: 'model',
      internal: false,
      unitsDrawnLastQuarter: units,
      unitPriceUsd: 12,
      bookedByBuyerUsd: units * 12,
    });
    const view = { ...base, customers: [buyer('cmp_basalt', 280), buyer('cmp_lumen', 108), buyer('cmp_grimsby', 60)] };
    const model = connectionsModel(view, { archetypes: archetypesOf(state) });

    const rings = model.right.flatMap((group) => group.pills).map((pill) => pill.ringPct).filter((pct): pct is number => pct !== null);
    expect(rings).toEqual([60, 23, 13]);
    expect(new Set(rings).size).toBe(rings.length);
    // What the three named buyers do not take is what went to the market, which
    // wears no ring — the reference rings named companies only.
    expect(rings.reduce((sum, pct) => sum + pct, 0)).toBe(96);

    // And the arcs on the page are as many different lengths as the shares.
    const markup = renderToStaticMarkup(
      <ConnectionsDiagram
        model={model}
        layout={layoutConnections({
          width: WIDTH,
          left: layoutGroupsOf(model.left),
          right: layoutGroupsOf(model.right),
          hub: { showOutput: true },
        })}
      />,
    );
    const arcs = new Set(markup.match(/stroke-dasharray="[^"]+"/g) ?? []);
    expect(arcs.size).toBeGreaterThanOrEqual(3);
  });

  it('turns the margin badge to the loss tone when the line loses money on every unit', () => {
    const state = createWorld3Session();
    const app = productOn(companyOf(state, PLAYER), 'app_ai_software_suite');
    app.grossMarginPct = -0.42;
    const markup = render(state, PLAYER, PLAYER, app.id);
    expect(markup).toContain('var(--color-loss-strong)');
    expect(markup).toContain('-42%');
  });

  it('renders a government award as a link to the screen that holds it', () => {
    const state = createWorld3Session();
    const agency = state.agencies[0];
    if (agency === undefined) throw new Error('the seeded world has no agencies');
    const contract: GovernmentContract = {
      id: 'gct_diagram_award',
      opportunityId: 'gop_diagram',
      agencyId: agency.id,
      primeCompanyId: PLAYER,
      consortiumMemberIds: [],
      subcontractors: [],
      awardedQuarter: 0,
      contractForm: 'fixed_price',
      totalValueUsd: 4_000_000,
      recognisedToDateUsd: 0,
      milestones: [],
      performanceToDate: 50,
      penaltiesUsd: 0,
      complianceBurdenQuarterlyUsd: 0,
      status: 'active',
      exportRestricted: false,
      publicControversyLevel: 0,
    };
    state.governmentContracts.push(contract);

    const markup = render(state, PLAYER, PLAYER);
    expect(markup).toContain('href="/government"');
    expect(markup).toContain(agency.shortName);
    expect(markup).toContain('$4.0M');
  });

  it('names every pill with the action tapping it takes', () => {
    const state = createWorld3Session();
    const markup = render(state, PLAYER, PLAYER);
    expect(markup).toContain('Change what fills it.');
    expect(markup).toContain('Change the target market.');
    // Somebody else's picture offers exactly one verb: walk to them.
    const theirs = render(state, PLAYER, 'cmp_basalt');
    expect(theirs).toContain('Open their connections.');
    expect(theirs.includes('Change what fills it.')).toBe(false);
    expect(theirs.includes('Change the target market.')).toBe(false);
  });
});
