/**
 * The Company tab: seven cards, in one order, every address a sheet.
 *
 * `apps/web` has no jsdom, so the tab itself — which is nothing but hooks and
 * seven pure cards — is checked two ways, exactly as the Connections picture is:
 *
 * 1. **The cards are rendered.** Each is pure by construction, so it goes
 *    through `renderToStaticMarkup` with fixture figures, and the markup is read
 *    back for the figures it promised and the addresses it links to. No address
 *    on this tab may be one of the twenty-two old routes.
 * 2. **The order is read off the source.** DOM order is the phone's reading
 *    order and the plan fixes it, so the seven card tags must appear in the
 *    file in that order and nowhere else.
 *
 * The two derivations that decide what a card says — which lines are the top
 * three, and what a line books — are pure modules and are exercised against a
 * real world-3 company rather than a fixture.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Company, Product, SessionState } from '@frontier/contracts';
import { economicNodeById } from '@frontier/contracts';
import { createWorld3Session, lineNodeIdOf } from '@frontier/simulation';
import { TABS } from '../../../lib/nav';
import { LEGACY_ROUTES, firstSegmentOf, sheetHref } from '../../../lib/sheets';
import {
  FinancialsCard,
  FloorCard,
  floorFocusFor,
  GovernmentCard,
  GroupCard,
  LinesCard,
  PeopleCard,
  ResearchCard,
} from './cards/company-cards';
import { TOP_LINES, lineGrossProfitUsd, lineRevenueUsd, topLines } from './cards/lines';

const DIR = fileURLToPath(new URL('.', import.meta.url));
const SOURCE = readFileSync(`${DIR}CompanyTab.tsx`, 'utf8');

/** Every `href="…"` in a blob of static markup, in document order. */
function hrefsIn(markup: string): string[] {
  return [...markup.matchAll(/href="([^"]*)"/g)].map((match) => (match[1] ?? '').replace(/&amp;/g, '&'));
}

const TAB_PATHS = new Set(TABS.map((tab) => tab.href));

/**
 * An old address, as opposed to a tab.
 *
 * Four of the twenty-two old routes — `/company` among them — are also tab
 * paths now, so membership of `LEGACY_ROUTES` alone does not condemn an href.
 * What condemns it is naming a screen that is no longer a screen: `/products`,
 * `/people`, `/financials`.
 */
function isOldRoute(href: string): boolean {
  const segment = firstSegmentOf(href);
  if (TAB_PATHS.has(segment)) return false;
  return Object.prototype.hasOwnProperty.call(LEGACY_ROUTES, segment);
}

function line(id: string, name: string, price: number, margin: number): Product {
  return {
    id,
    name,
    pricePerSeat: price,
    grossMarginPct: margin,
    activeCustomers: 100,
    isActive: true,
  } as unknown as Product;
}

/* -------------------------------------------------------------------------- */
/*  The page                                                                   */
/* -------------------------------------------------------------------------- */

const CARDS = ['FloorCard', 'LinesCard', 'PeopleCard', 'ResearchCard', 'GovernmentCard', 'FinancialsCard', 'GroupCard'] as const;

const page = [
  renderToStaticMarkup(
    <FloorCard
      companyName="Player Ventures"
      summary="Applied lab · San Francisco"
      scene={null}
      headcount={41}
      morale={62}
      payrollUsd={4_200_000}
      runwayQuarters={7}
      focus={{ href: sheetHref('people', { hash: 'headcount' }), label: 'Set the hiring plan', detail: '3 roles open' }}
    />,
  ),
  renderToStaticMarkup(
    <LinesCard
      lineCount={4}
      revenueUsd={12_000_000}
      grossProfitUsd={5_000_000}
      headroomUnits={18}
      lines={topLines([line('p1', 'Inference API', 240, 0.55), line('p2', 'Agent Suite', 90, 0.31)])}
    />,
  ),
  renderToStaticMarkup(
    <PeopleCard
      headcount={41}
      openRoles={3}
      morale={62}
      attrition={0.048}
      avgCompUsd={210_000}
      marketCompUsd={230_000}
      roles={[
        { role: 'engineers', label: 'Engineers', count: 18 },
        { role: 'researchers', label: 'Researchers', count: 9 },
      ]}
      roleCount={6}
    />,
  ),
  renderToStaticMarkup(<ResearchCard programmes={2} envelopeUsd={9_000_000} researchers={9} readyToStart={5} />),
  renderToStaticMarkup(<GovernmentCard pastPerformance={58} openCompetitions={3} backlogUsd={80_000_000} complianceUsd={1_200_000} />),
  renderToStaticMarkup(
    <FinancialsCard
      revenueUsd={12_000_000}
      operatingIncomeUsd={-2_400_000}
      cashMovementUsd={-1_800_000}
      debtServiceUsd={900_000}
      serviceHeadroomUsd={14_000_000}
    />,
  ),
  renderToStaticMarkup(<GroupCard companies={3} revenueUsd={40_000_000} cashUsd={22_000_000} enterpriseValueUsd={310_000_000} headcount={120} />),
].join('\n');

describe('the Company tab is seven cards in the plan’s order', () => {
  it('renders them in that order and mounts each exactly once', () => {
    const positions = CARDS.map((name) => ({ name, at: SOURCE.indexOf(`<${name}`) }));
    for (const entry of positions) expect(entry.at, `${entry.name} is not mounted`).toBeGreaterThan(-1);
    for (let index = 1; index < positions.length; index += 1) {
      const previous = positions[index - 1];
      const current = positions[index];
      if (previous === undefined || current === undefined) throw new Error('card list is malformed');
      expect(current.at, `${current.name} must come after ${previous.name}`).toBeGreaterThan(previous.at);
    }
    for (const name of CARDS) expect(SOURCE.split(`<${name}`).length - 1, `${name} is mounted twice`).toBe(1);
  });

  it('shows Group only when the seat directs more than its founding company', () => {
    // The card is behind `hasGroup`, which is what the plan makes it conditional
    // on; a seat with one company must not see an empty consolidation.
    expect(SOURCE).toMatch(/hasGroup\(session, PLAYER_ID\)/);
    expect(SOURCE).toMatch(/groupStatement === null \? null : \(/);
  });
});

describe('every address on the Company tab', () => {
  const hrefs = hrefsIn(page);

  it('links somewhere, and never to one of the twenty-two old routes', () => {
    expect(hrefs.length).toBeGreaterThan(4);
    for (const href of hrefs) expect(isOldRoute(href), `${href} is still an old route`).toBe(false);
  });

  it('sends the source of the page through sheetHref, never a raw path', () => {
    // `/company`, `/products`, `/people` … as string literals would work — the
    // catch-all redirects them — but each one is a hop the phone pays for and a
    // place the registry can drift from.
    for (const route of Object.keys(LEGACY_ROUTES)) {
      if (TAB_PATHS.has(route)) continue;
      expect(SOURCE.includes(`'${route}'`), `${route} is written out in CompanyTab.tsx`).toBe(false);
      expect(SOURCE.includes(`"${route}"`), `${route} is written out in CompanyTab.tsx`).toBe(false);
    }
    expect(SOURCE).toContain('sheetHref(');
  });

  it('opens a line’s own drawer, and the headcount plan, by address', () => {
    expect(hrefs).toContain(sheetHref('products', { line: 'p1' }));
    expect(hrefs).toContain(sheetHref('people', { hash: 'headcount' }));
    expect(sheetHref('people', { hash: 'headcount' })).toBe('/company?sheet=people#headcount');
  });
});

describe('the Company floor leads with the actual operating pressure', () => {
  it('takes a capacity shortfall to the affected line before any lower-pressure concern', () => {
    const focus = floorFocusFor({ headroomUnits: -4, runwayQuarters: 2, openRoles: 5, featuredLineId: 'p1' });
    expect(focus.href).toBe(sheetHref('products', { line: 'p1' }));
    expect(focus.label).toContain('capacity shortfall');
  });

  it('takes short runway to Capital and open roles to the headcount control', () => {
    expect(floorFocusFor({ headroomUnits: 8, runwayQuarters: 4, openRoles: 2, featuredLineId: null }).href).toBe(sheetHref('capital'));
    expect(floorFocusFor({ headroomUnits: 8, runwayQuarters: 9, openRoles: 2, featuredLineId: null }).href).toBe(
      sheetHref('people', { hash: 'headcount' }),
    );
  });
});

describe('the Connections card', () => {
  it('lists at most three line rows, whatever the company runs', () => {
    const many = [
      line('p1', 'One', 100, 0.4),
      line('p2', 'Two', 200, 0.4),
      line('p3', 'Three', 300, 0.4),
      line('p4', 'Four', 400, 0.4),
      line('p5', 'Five', 500, 0.4),
    ];
    expect(TOP_LINES).toBe(3);
    expect(topLines(many)).toHaveLength(3);

    const markup = renderToStaticMarkup(
      <LinesCard lineCount={many.length} revenueUsd={0} grossProfitUsd={0} headroomUnits={0} lines={topLines(many)} />,
    );
    const rows = hrefsIn(markup).filter((href) => href.includes('sheet=products&line='));
    expect(rows).toHaveLength(3);
    // Largest first, and the card still says how many there really are.
    expect(rows[0]).toBe(sheetHref('products', { line: 'p5' }));
    expect(markup).toContain('5 lines');
  });

  it('says so rather than drawing an empty list when no line is open', () => {
    const markup = renderToStaticMarkup(<LinesCard lineCount={0} revenueUsd={0} grossProfitUsd={0} headroomUnits={0} lines={[]} />);
    expect(markup).toContain('No line open');
    expect(hrefsIn(markup).filter((href) => href.includes('line='))).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/*  The two derivations, against a real world-3 company                        */
/* -------------------------------------------------------------------------- */

function playerOf(state: SessionState): Company {
  return state.companies.find((company) => company.id === 'cmp_player_ventures') ?? (state.companies[0] as Company);
}

describe('what a line books', () => {
  const state = createWorld3Session();
  const company = playerOf(state);

  it('reads the node economy’s own units sold, not the installed base', () => {
    const active = company.products.filter((product) => product.isActive);
    expect(active.length).toBeGreaterThan(0);
    for (const product of active) {
      const units = product.unitsSoldQuarterly ?? product.activeCustomers;
      expect(lineRevenueUsd(product)).toBe(product.pricePerSeat * units);
      expect(lineGrossProfitUsd(product)).toBe(lineRevenueUsd(product) * product.grossMarginPct);
    }
  });

  it('quotes the node’s own unit on the row, not an assumed one', () => {
    const rows = topLines(company.products);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const product = company.products.find((entry) => entry.id === row.productId);
      if (product === undefined) throw new Error('row names a product the company does not run');
      const nodeId = lineNodeIdOf(product);
      // World 3 puts every line on a node; a null here means the row would have
      // fallen back to the world-2 word and quoted the wrong unit.
      expect(nodeId, `${row.name} sits on no node`).not.toBeNull();
      expect(row.unitLabel).toBe(economicNodeById(nodeId as string)?.unitLabel);
      expect(row.priceUsd).toBe(product.pricePerSeat);
      expect(row.marginPct).toBe(product.grossMarginPct);
    }
  });

  it('orders by revenue and breaks ties on the id, so the rows never wobble', () => {
    const tied = [line('pb', 'B', 100, 0.4), line('pa', 'A', 100, 0.4)];
    expect(topLines(tied).map((row) => row.productId)).toEqual(['pa', 'pb']);
  });
});
