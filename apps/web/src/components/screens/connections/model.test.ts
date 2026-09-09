/**
 * The Connections model, against the seeded world 3 rather than a fixture.
 *
 * The engine decides what a seat may read; this file proves the model prints
 * exactly that and invents nothing. Four things it pins down.
 *
 * 1. **Order.** Slots in the node's own table order, the live fill first in
 *    each, at most two alternatives behind it. A founder scanning the column
 *    reads "what I run on" before "what else there is", every time.
 * 2. **The engine's own numbers.** Every price on a pill is `tagMoney`'s
 *    reading of a number that came out of `connectionsOf`, never a figure the
 *    model worked out for itself.
 * 3. **The right column is a decision.** The target cell first and ringed, the
 *    other cells dashed and carrying the aim that would move the line there.
 * 4. **A rival's picture carries no economics.** No cost, no price, no margin,
 *    no alternatives — and no aim button, because re-aiming their line is not
 *    a thing this seat can do.
 * 5. **Everything fits.** Every figure is at most `FIGURE_MAX_CH` characters
 *    and every detail at most `DETAIL_MAX_CH`, on every pill of every picture
 *    this world can produce. The layout proves the boxes fit the phone; this
 *    proves the words fit the boxes, which is the half a critic pass found
 *    missing — "67,320 × Inference API" in 42 points of a 390-point screen.
 */

import { describe, expect, it } from 'vitest';
import type { Company, EconomicNode, GovernmentContract, Product } from '@frontier/contracts';
import { economicNodeById } from '@frontier/contracts';
import { connectionsOf, createWorld3Session, unitCostOf } from '@frontier/simulation';
import { formatCount, formatMoney } from '@frontier/shared';
import {
  DETAIL_MAX_CH,
  FIGURE_MAX_CH,
  ROW_MAX_CH,
  MAX_AIM_CELLS,
  connectionsModel,
  layoutGroupsOf,
  qtyText,
  slotQty,
  slotRecipe,
  tagCount,
  tagMoney,
  totalUnitsOut,
  type PillGroup,
  type PillModel,
} from './model';
import { sheetHref } from '@/lib/sheets';

const PLAYER = 'cmp_player_ventures';
const APP_NODE = 'app_ai_software_suite';

type World = ReturnType<typeof createWorld3Session>;

function companyOf(state: World, id: string): Company {
  const company = state.companies.find((candidate) => candidate.id === id);
  if (company === undefined) throw new Error(`${id} is not in the seeded world`);
  return company;
}

function archetypesOf(state: World): Record<string, string> {
  const out: Record<string, string> = {};
  for (const company of state.companies) out[company.id] = company.archetype;
  return out;
}

function modelFor(state: World, subjectId: string, productId: string | null = null): ReturnType<typeof connectionsModel> {
  return connectionsModel(connectionsOf(state, PLAYER, subjectId, productId), { archetypes: archetypesOf(state) });
}

function pillsOf(groups: readonly PillGroup[]): readonly PillModel[] {
  return groups.flatMap((group) => group.pills);
}

/** Every string a pill or a hub puts in front of the player. */
function textOf(model: ReturnType<typeof connectionsModel>): string {
  const pills = [...pillsOf(model.left), ...pillsOf(model.right)];
  return [
    ...pills.flatMap((pill) => [pill.name, pill.figure ?? '', pill.detail ?? '', pill.ariaLabel]),
    ...[...model.left, ...model.right].flatMap((group) => [group.header ?? '', group.moreLabel ?? '']),
    ...(model.hub === null ? [] : [model.hub.name, model.hub.ariaLabel, ...model.hub.figures]),
  ].join(' ');
}

/* -------------------------------------------------------------------------- */

describe('the figure tags', () => {
  it('reads money in six characters or fewer, at every scale a company reaches', () => {
    expect(tagMoney(0)).toBe('$0');
    expect(tagMoney(11)).toBe('$11');
    expect(tagMoney(2_480)).toBe('$2.5K');
    expect(tagMoney(809_638)).toBe('$810K');
    expect(tagMoney(999_999)).toBe('$1.0M');
    expect(tagMoney(1_500_000)).toBe('$1.5M');
    expect(tagMoney(4_120_000)).toBe('$4.1M');
    expect(tagMoney(2_400_000_000)).toBe('$2.4B');
    expect(tagMoney(-809_638)).toBe('-$810K');
    expect(tagMoney(Number.NaN)).toBe('—');
    for (const value of [0, 1, 11.4, 999.6, 1_000, 809_638, 12_345_678, 4.4e11, -9.9e8]) {
      expect(tagMoney(value).length, `${value} printed ${tagMoney(value)}`).toBeLessThanOrEqual(FIGURE_MAX_CH);
    }
  });

  it('reads a unit count the same way, so a demand figure is never eight digits', () => {
    expect(tagCount(19)).toBe('19');
    expect(tagCount(280)).toBe('280');
    expect(tagCount(67_320)).toBe('67K');
    expect(tagCount(1_683)).toBe('1.7K');
    expect(tagCount(14_009_473)).toBe('14M');
    // The four dashed market pills the critic found: eight digits each, within
    // 16% of one another, and not one of them a decision.
    for (const demand of [14_009_473, 12_360_217, 12_247_727, 11_755_411]) {
      expect(tagCount(demand).length).toBeLessThanOrEqual(FIGURE_MAX_CH);
    }
  });
});

describe('the slot header', () => {
  it('keeps a quantity the table can actually carry, down to five in a billion', () => {
    expect(qtyText(40)).toBe('40');
    expect(qtyText(10_000)).toBe('10,000');
    expect(qtyText(0.02)).toBe('0.02');
    expect(qtyText(0.00135)).toBe('0.0014');
    expect(qtyText(5e-9)).toBe('0.000000005');
    expect(qtyText(0)).toBe('0');
    // `formatCount` alone would have said "0" of a slot that is genuinely consumed.
    expect(formatCount(0.02)).toBe('0');
    // The recipe is its own header line, so it no longer repeats the slot name.
    // The multiplication sign is what stops "40 1M tokens" reading as one
    // mangled quantity; it goes with the unit when the unit itself is dropped.
    expect(slotRecipe('Model', 40, '1M tokens')).toBe('40 \u00d7 1M tokens per unit');
    expect(slotRecipe('Device', 0.02, 'device')).toBe('0.02 per unit');
    expect(slotQty(40, '1M tokens')).toBe('40 \u00d7 1M tokens');
  });

  it('carries the sign onto every slot of every node this world can draw', () => {
    const state = createWorld3Session();
    const company = companyOf(state, PLAYER);
    const model = modelFor(state, PLAYER);
    expect(company.products.length).toBeGreaterThan(0);
    const recipes = model.left.map((group) => group.subheader).filter((text): text is string => text !== null);
    expect(recipes.length).toBeGreaterThan(0);
    for (const recipe of recipes) {
      expect(recipe.endsWith('per unit'), recipe).toBe(true);
      // Either the unit was dropped (bare quantity) or it is multiplied out.
      expect(/^[\d.,]+ (\u00d7 .+ )?per unit$/.test(recipe), recipe).toBe(true);
    }
  });
});

describe('the supplier column, on my own line', () => {
  it('runs one group per slot in table order, live first, at most two alternatives', () => {
    const state = createWorld3Session();
    const model = modelFor(state, PLAYER);
    const node = economicNodeById(APP_NODE) as EconomicNode;

    expect(model.left.map((group) => group.key)).toEqual(node.slots.map((slot) => `slot:${slot.id}`));
    for (const group of model.left) {
      expect(group.pills.length).toBeLessThanOrEqual(3);
      expect(group.pills[0]?.state === 'possible').toBe(false);
      for (const pill of group.pills.slice(1)) expect(pill.state).toBe('possible');
      for (const pill of group.pills) expect(pill.action).toEqual({ kind: 'slot', slotId: group.key.slice('slot:'.length) });
    }

    const required = node.slots.filter((slot) => slot.required).map((slot) => `slot:${slot.id}`);
    expect(model.left.filter((group) => group.required).map((group) => group.key)).toEqual(required);
  });

  it('names the live seller with the price the roll-up books, formatted by formatMoney', () => {
    const state = createWorld3Session();
    const view = connectionsOf(state, PLAYER, PLAYER, null);
    const model = connectionsModel(view, { archetypes: archetypesOf(state) });

    const slot = view.suppliers.find((entry) => entry.slotId === 'model');
    const live = slot?.options[0];
    expect(live?.supplierCompanyId).toBe('cmp_basalt');

    const pill = model.left.find((group) => group.key === 'slot:model')?.pills[0];
    expect(pill?.name).toBe('Basalt Compute');
    expect(pill?.figure).toBe(tagMoney(live?.unitPriceUsd ?? 0));
    // The order book rides on the wire I am standing on. The node it buys is in
    // the aria rather than on the data row: "67,320 × Inference API" needs 116
    // points of a 42-point row and printed as "67,32…".
    expect(live?.unitsDrawnLastQuarter).toBeGreaterThan(0);
    expect(pill?.detail).toBe(`×${tagCount(live?.unitsDrawnLastQuarter ?? 0)}`);
    expect(pill?.ariaLabel).toContain('Inference API');
    expect(pill?.glyph).toEqual({ kind: 'company', companyId: 'cmp_basalt', archetype: companyOf(state, 'cmp_basalt').archetype, own: false });
  });

  it('names the node the open market would buy, so two spot routes are not two identical pills', () => {
    const state = createWorld3Session();
    const view = connectionsOf(state, PLAYER, PLAYER, null);
    const model = connectionsModel(view, { archetypes: archetypesOf(state) });

    let spotPills = 0;
    for (const slot of view.suppliers) {
      const group = model.left.find((entry) => entry.key === `slot:${slot.slotId}`);
      // No two routes on one slot read as the same pill, whatever they are.
      expect(new Set(group?.pills.map((pill) => pill.name)).size).toBe(group?.pills.length);
      slot.options.forEach((option, index) => {
        if (option.kind !== 'market') return;
        spotPills += 1;
        const pill = group?.pills[index];
        // The *thing* names the pill: "Open market" twice at two prices is two
        // identical rows, and what you would be buying is the difference.
        expect(pill?.name).toBe(option.nodeLabel);
        // The premium is on the data row unless a quality gap outranks it;
        // either way the aria carries both, because aria has no character row.
        expect(pill?.detail).toMatch(/^([+]\d+% spot|qual \d+%)$/);
        expect(pill?.ariaLabel).toMatch(/open market at [+]\d+% spot/);
      });
    }
    expect(spotPills).toBeGreaterThan(1);
  });

  it('prints an alternative quality only when it would change the decision', () => {
    const state = createWorld3Session();
    const view = connectionsOf(state, PLAYER, PLAYER, null);
    const model = connectionsModel(view, { archetypes: archetypesOf(state) });
    for (const supplier of view.suppliers) {
      const liveQuality = supplier.options[0]?.qualityScore ?? null;
      const group = model.left.find((entry) => entry.key === `slot:${supplier.slotId}`);
      supplier.options.forEach((option, index) => {
        const detail = group?.pills[index]?.detail ?? '';
        const gap = option.qualityScore === null || liveQuality === null ? 0 : Math.abs(option.qualityScore - liveQuality) * 100;
        // "qual", not "quality": the row is a dozen characters at a 360-point
        // phone and the aria carries the word in full.
        expect(detail.startsWith('qual '), `${supplier.slotId}:${index}`).toBe(index > 0 && gap >= 5);
      });
    }
  });

  it('marks an empty optional slot with a plus and no price', () => {
    const state = createWorld3Session();
    const model = modelFor(state, PLAYER);
    const empty = pillsOf(model.left).find((pill) => pill.state === 'empty');
    expect(empty?.name).toMatch(/^Add /);
    expect(empty?.glyph).toEqual({ kind: 'icon', name: 'plus' });
    expect(empty?.figure).toBeNull();
  });
});

describe('the customer column', () => {
  it('puts the target cell first with its list price, its share and a ring, and the rest dashed with an aim', () => {
    const state = createWorld3Session();
    const view = connectionsOf(state, PLAYER, PLAYER, null);
    const model = connectionsModel(view, { archetypes: archetypesOf(state) });
    const markets = model.right.find((group) => group.key === 'markets');
    expect(markets).toBeDefined();

    const first = markets?.pills[0];
    const liveCell = view.cells.find((cell) => cell.live);
    expect(first?.state).toBe('live');
    expect(first?.figure).toBe(tagMoney(liveCell?.listPriceUsd ?? 0));
    // A line selling 1,683 seats into a cell of 12.4 million holds 0.014% of
    // it. "0% of demand" beside a live green pill reads as a broken screen.
    expect(liveCell?.sharePct).toBe(0);
    expect((liveCell?.myUnits ?? 0) > 0).toBe(true);
    expect(first?.detail).toBe('<1% share');
    // No ring on a market cell: the ring on this column compares one named
    // customer with another, and a share of demand is a different whole.
    expect(first?.ringPct).toBeNull();
    expect(first?.action).toEqual({ kind: 'aim', industry: liveCell?.industry, customer: liveCell?.customer });

    const dashed = markets?.pills.slice(1) ?? [];
    expect(dashed.length).toBeLessThanOrEqual(MAX_AIM_CELLS);
    for (const pill of dashed) {
      expect(pill.state).toBe('possible');
      // The count is the tag and the word survives beside it: the critic found
      // "14,009,473" with "wanted" clipped to nothing.
      expect(pill.detail).toBe('wanted');
      expect(pill.figure).not.toBeNull();
      expect((pill.figure ?? '').length).toBeLessThanOrEqual(FIGURE_MAX_CH);
      expect(pill.ringPct).toBeNull();
      expect(pill.action?.kind).toBe('aim');
    }
    const hidden = view.cells.filter((cell) => !cell.live).length - dashed.length;
    expect(markets?.moreLabel).toBe(hidden > 0 ? `+${hidden} more` : null);
  });

  it('says so plainly when nobody buys the line', () => {
    const state = createWorld3Session();
    const view = connectionsOf(state, PLAYER, PLAYER, null);
    // The one case a founder most needs told: a line with no buyer, no cell
    // asking for anything, and nothing company-wide to pad the column with.
    const bare = connectionsModel({ ...view, customers: [], cells: [], agencies: [], compute: [] });
    expect(bare.right.length).toBe(1);
    expect(bare.right[0]?.pills[0]?.name).toBe('Nobody buys this yet');
    expect(bare.right[0]?.pills[0]?.detail).toBe('publish it');
    expect(bare.right[0]?.pills[0]?.ariaLabel).toContain('publish it or aim it at a market with demand');
    expect(bare.right[0]?.pills[0]?.action).toEqual({ kind: 'line' });
  });

  it('rings a named buyer by its share of my output and walks to them', () => {
    const state = createWorld3Session();
    const player = companyOf(state, PLAYER);
    const app = player.products.find((product) => product.nodeId === APP_NODE) as Product;
    const api: Product = {
      ...app,
      id: 'prd_player_api',
      name: 'Ventures Inference',
      nodeId: 'svc_inference_api',
      slots: [],
      supplyTerms: { openToAll: true, pricePerUnitUsd: 12, exclusiveCustomerIds: [], blockedCustomerIds: [] },
      unitsSoldQuarterly: 2_000_000,
      activeCustomers: 2_000_000,
      pricePerSeat: 12,
    };
    (player.products as Product[]).push(api);
    const buyer = companyOf(state, 'cmp_lumen');
    const fill = (buyer.products.find((product) => product.nodeId === 'app_consumer_subscription') as Product).slots?.find(
      (slot) => slot.slotId === 'model',
    );
    if (fill === undefined) throw new Error('the consumer subscription has no model slot to point at me');
    fill.supplierCompanyId = player.id;
    fill.supplierProductId = api.id;
    fill.nodeId = 'svc_inference_api';

    const view = connectionsOf(state, PLAYER, PLAYER, api.id);
    const model = connectionsModel(view, { archetypes: archetypesOf(state) });
    const buyers = model.right.find((group) => group.key === 'buyers');
    expect(buyers?.header).toBe('Buyers');

    const row = view.customers.find((customer) => customer.buyerCompanyId === buyer.id);
    const pill = buyers?.pills.find((entry) => entry.name === buyer.name);
    expect(row?.unitsDrawnLastQuarter).not.toBeNull();
    // The money the reference puts on a customer wire, and it is mine to show:
    // the price they pay is my own published ask.
    expect(pill?.figure).toBe(tagMoney(row?.unitPriceUsd ?? 0));
    expect(pill?.detail).toBe(`×${tagCount(row?.unitsDrawnLastQuarter ?? 0)}`);
    expect(pill?.action).toEqual({ kind: 'company', companyId: buyer.id });

    // The ring is share of everything that leaves the line — named draws plus
    // the units sold into the cell — so the column's rings reconcile instead of
    // every one of them firing the 100% clamp.
    const total = totalUnitsOut(view);
    expect(total).toBe(view.customers.reduce((sum, entry) => sum + (entry.unitsDrawnLastQuarter ?? 0), 0) + 2_000_000);
    expect(pill?.ringPct).toBe(Math.round(((row?.unitsDrawnLastQuarter ?? 0) / total) * 100));
    expect(pill?.ringPct).toBeLessThan(100);

    // Named buyers wear the rings; the market cell does not, and what the
    // buyers do not take is what went to the market.
    const rings = [...pillsOf(model.right)].map((entry) => entry.ringPct).filter((value): value is number => value !== null);
    expect(rings.length).toBe(view.customers.length);
    expect(rings.reduce((sum, value) => sum + value, 0)).toBeLessThanOrEqual(100);
    expect(pillsOf(model.right).filter((entry) => entry.key.startsWith('cell:')).every((entry) => entry.ringPct === null)).toBe(true);
  });

  it('puts agencies under their own header, with the award value an award makes public', () => {
    const state = createWorld3Session();
    const agency = state.agencies[0];
    if (agency === undefined) throw new Error('the seeded world has no agencies');
    const contract: GovernmentContract = {
      id: 'gct_model_award',
      opportunityId: 'gop_model',
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

    const model = modelFor(state, PLAYER);
    const government = model.right.find((group) => group.key === 'government');
    expect(government?.header).toBe('Government');
    expect(government?.pills[0]?.name).toBe(agency.shortName);
    expect(government?.pills[0]?.figure).toBe('$4.0M');
    expect(government?.pills[0]?.detail).toBe('prime');
    expect(government?.pills[0]?.action).toEqual({ kind: 'href', href: sheetHref('government') });
    expect(government?.pills[0]?.glyph).toEqual({ kind: 'icon', name: 'capitol' });
  });
});

describe('the hub', () => {
  it('carries the name of the line, its cost, its price and its margin as whole percent', () => {
    const state = createWorld3Session();
    const player = companyOf(state, PLAYER);
    const app = player.products.find((product) => product.nodeId === APP_NODE) as Product;
    const model = modelFor(state, PLAYER);
    expect(model.hub?.name).toBe(app.name);
    expect(model.hub?.nodeLabel).toBe('AI software suite');
    expect(model.hub?.own).toBe(true);
    expect(model.hub?.marginPct).toBe(Math.round(app.grossMarginPct * 100));
    expect(model.hub?.figures).toEqual([
      `Cost ${tagMoney(unitCostOf(state, player, APP_NODE).unitCostUsd)}`,
      `Price ${tagMoney(app.pricePerSeat)}`,
    ]);
    // Never published, so there is no ask to print.
    expect(model.hub?.figures.some((figure) => figure.startsWith('Ask'))).toBe(false);
  });
});

describe('somebody elses picture', () => {
  it('carries no cost, no price, no margin, no alternatives and no aim button', () => {
    const state = createWorld3Session();
    const model = modelFor(state, 'cmp_basalt');

    expect(model.hub?.own).toBe(false);
    expect(model.hub?.figures).toEqual([]);
    expect(model.hub?.marginPct).toBeNull();
    expect(model.hub?.action).toBeNull();

    const text = textOf(model);
    for (const word of ['Cost ', 'Price ', 'Ask ', 'quality', 'of demand', '% spot']) {
      expect(text.includes(word), `"${word}" reached a rival picture`).toBe(false);
    }

    for (const group of model.left) {
      expect(group.pills.length).toBe(1);
      expect(group.moreLabel).toBeNull();
      expect(group.pills[0]?.state).toBe('live');
      expect(group.pills[0]?.figure).toBeNull();
      expect(group.pills[0]?.action?.kind).toBe('company');
    }
    for (const pill of pillsOf(model.right)) {
      expect(pill.ringPct).toBeNull();
      if (pill.key.startsWith('cell:')) expect(pill.action).toBeNull();
    }
  });
});

describe('every word fits the pill it is written on', () => {
  /**
   * The gap a critic pass found, closed as an assertion.
   *
   * Every layout test passed while the screen printed "MODEL · 40 1…",
   * "67,32…", "1…" and four market pills whose qualifying word "wanted" was
   * allotted zero points — because the layout proves the *boxes* fit the phone
   * and nothing proved the *words* fit the boxes. These are the numbers
   * `ConnectionPill` is built to: six characters of figure tag, fourteen of
   * detail, at the sizes it draws them in a 130-point pill.
   */
  function everyPill(state: World, subjectId: string, productId: string | null = null): readonly PillModel[] {
    const model = modelFor(state, subjectId, productId);
    return [...pillsOf(model.left), ...pillsOf(model.right)];
  }

  it('keeps every figure and every detail inside the pill, on my line and on a rival\'s', () => {
    const state = createWorld3Session();
    const player = companyOf(state, PLAYER);
    const pictures: readonly (readonly [string, readonly PillModel[]])[] = [
      ['mine', everyPill(state, PLAYER)],
      ...player.products.map((product) => [product.id, everyPill(state, PLAYER, product.id)] as const),
      ...state.companies.slice(0, 8).map((company) => [company.id, everyPill(state, company.id)] as const),
    ];
    let counted = 0;
    for (const [where, pills] of pictures) {
      for (const pill of pills) {
        counted += 1;
        if (pill.figure !== null) {
          expect(pill.figure.length, `${where}/${pill.key} figure "${pill.figure}"`).toBeLessThanOrEqual(FIGURE_MAX_CH);
        }
        if (pill.detail !== null) {
          expect(pill.detail.length, `${where}/${pill.key} detail "${pill.detail}"`).toBeLessThanOrEqual(DETAIL_MAX_CH);
          expect(
            (pill.figure ?? '').length + pill.detail.length,
            `${where}/${pill.key} row "${pill.figure ?? ''} ${pill.detail}"`,
          ).toBeLessThanOrEqual(ROW_MAX_CH);
          // A grouped thousands separator is the signature of the raw
          // `formatCount` that produced "14,009,473" on a 42-point row.
          expect(pill.detail, `${where}/${pill.key} detail carries a raw count`).not.toMatch(/\d,\d{3}/);
        }
      }
    }
    expect(counted).toBeGreaterThan(30);
  });

  it('keeps the slot name and its recipe on separate lines, each short enough to survive', () => {
    const state = createWorld3Session();
    const model = modelFor(state, PLAYER);
    const slots = model.left.filter((group) => group.key.startsWith('slot:'));
    expect(slots.length).toBeGreaterThan(0);
    for (const group of slots) {
      // "MODEL · 40 1M tokens/unit" was 25 characters on one 130-point row.
      expect((group.header ?? '').length, `${group.key} header`).toBeLessThanOrEqual(14);
      expect(group.subheader, `${group.key} has no recipe`).not.toBeNull();
      expect((group.subheader ?? '').length, `${group.key} recipe`).toBeLessThanOrEqual(24);
      expect((group.moreLabel ?? '').length, `${group.key} more`).toBeLessThanOrEqual(8);
    }
  });
});

describe('the layout input', () => {
  it('hands the layout one entry per group and one per pill, keys intact', () => {
    const state = createWorld3Session();
    const model = modelFor(state, PLAYER);
    const groups = layoutGroupsOf(model.left);
    expect(groups.map((group) => group.key)).toEqual(model.left.map((group) => group.key));
    // The recipe reaches the layout, which is what makes room for its line.
    expect(groups.map((group) => group.subheader)).toEqual(model.left.map((group) => group.subheader));
    expect(groups.flatMap((group) => group.pills.map((pill) => pill.key))).toEqual(pillsOf(model.left).map((pill) => pill.key));
    expect(new Set(groups.flatMap((group) => group.pills.map((pill) => pill.key))).size).toBe(pillsOf(model.left).length);
  });

  it('is the same model twice from the same world', () => {
    const state = createWorld3Session();
    expect(JSON.stringify(modelFor(state, PLAYER))).toBe(JSON.stringify(modelFor(state, PLAYER)));
    expect(JSON.stringify(modelFor(state, 'cmp_basalt'))).toBe(JSON.stringify(modelFor(state, 'cmp_basalt')));
  });
});
