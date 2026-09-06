/**
 * The Products sheet body around the picture: the figures, the tables, and the
 * one row that lets a founder walk up somebody else's chain.
 *
 * Three things the owner asked for after driving the Connections screens as
 * sheets, each checked the way `apps/web` checks screens without a DOM — pure
 * components through `renderToStaticMarkup`, and the screen's own mounting
 * read off its source.
 *
 * 1. **Product stats are back.** Four `StatCard`s above the picture and the
 *    Lines / Closed lines tables below it, on the reader's own view only. A
 *    rival's picture is public relationships; their revenue is not public.
 * 2. **The chain can be walked from a slot.** An opening with no named buyer
 *    (Enterprise AI) had no pill leading anywhere, because supplier pills open
 *    the slot sheet. A slot filled by a named seller now carries one row that
 *    walks the stack to them; a make or open-market fill names nobody and gets
 *    no row.
 * 3. **The recipe multiplies.** "40 × 1M tokens per unit", not "40 1M tokens".
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Company, Product, SessionState } from '@frontier/contracts';
import { createWorld3Session, slotOptions } from '@frontier/simulation';
import { formatCount, formatMoney } from '@frontier/shared';
import { LineStatCards, lineColumns, lineFigures, unitsOf } from '../products/lineStats';
import { SlotCandidateSheet, namedSellerOf } from '../products/SlotCandidateSheet';
import { choiceOfRoute } from '../products/nodeLaunch';
import type { Column } from '@/components/ui';
import { firstSegmentOf, sheetHref } from '../../../lib/sheets';

const DIR = fileURLToPath(new URL('.', import.meta.url));
const SCREEN = readFileSync(`${DIR}ConnectionsScreen.tsx`, 'utf8');
const TABLES = readFileSync(`${DIR}../products/lineStats.tsx`, 'utf8');

/** One table row, drawn through the column definitions rather than the table. */
function Row({ columns, line }: { readonly columns: readonly Column<Product>[]; readonly line: Product }): React.JSX.Element {
  return (
    <div>
      {columns.map((column) => (
        <span key={column.key}>{column.render === undefined ? null : column.render(line, 0)}</span>
      ))}
    </div>
  );
}

const PLAYER = 'cmp_player_ventures';

function world(): { readonly state: SessionState; readonly company: Company } {
  const state = createWorld3Session();
  const company = state.companies.find((entry) => entry.id === PLAYER);
  if (company === undefined) throw new Error('the seeded world has no player company');
  return { state, company };
}

/* -------------------------------------------------------------------------- */
/*  1. The figures and the tables                                              */
/* -------------------------------------------------------------------------- */

/** The four labels the chain screen carried and the owner asked back for. */
const STAT_LABELS = ['Revenue', 'Cost of goods', 'Gross profit', 'Blocked inputs'] as const;

describe('the Products sheet states what the lines booked', () => {
  it('draws the four figures over the reader\'s own picture, on the engine\'s own numbers', () => {
    const { state, company } = world();
    const active = company.products.filter((product) => product.isActive);
    expect(active.length).toBeGreaterThan(0);

    const figures = lineFigures(state, company, active);
    // The roll-up, exactly: price × units and unit cost × units, per line.
    expect(figures.revenueUsd).toBe(active.reduce((total, line) => total + line.pricePerSeat * unitsOf(line), 0));
    expect(figures.cogsUsd).toBe(active.reduce((total, line) => total + (line.unitCostUsd ?? 0) * unitsOf(line), 0));
    expect(figures.grossProfitUsd).toBe(figures.revenueUsd - figures.cogsUsd);
    expect(figures.activeCount).toBe(active.length);

    const markup = renderToStaticMarkup(<LineStatCards figures={figures} />);
    for (const label of STAT_LABELS) expect(markup).toContain(label);
    expect(markup).toContain(formatMoney(figures.revenueUsd));
    // Revenue is the one card that leads anywhere, and it leads to the books —
    // as a sheet over the Company tab, never as the old `/financials` route.
    const hrefs = [...markup.matchAll(/href="([^"]*)"/g)].map((match) => (match[1] ?? '').replace(/&amp;/g, '&'));
    expect(hrefs).toEqual([sheetHref('financials')]);
    for (const href of hrefs) expect(firstSegmentOf(href)).toBe('/company');
  });

  it('lists one row per active line, and keeps the closed ones for comparatives', () => {
    const { state, company } = world();
    const active = company.products.filter((product) => product.isActive);
    const closed = company.products.filter((product) => !product.isActive);
    expect(active.length).toBeGreaterThan(0);

    // `DataTable` reaches for the app router, which no server render has, so
    // the rows are drawn through the column definitions the table is handed —
    // which is where every figure on a row actually comes from.
    const columns = lineColumns(state);
    expect(columns.map((column) => column.header)).toEqual(['Line', 'Price', 'Unit cost', 'Units', 'Margin', 'Market']);

    const rows = active.map((line) => renderToStaticMarkup(<Row columns={columns} line={line} />));
    expect(rows.length).toBe(active.length);
    for (const [index, line] of active.entries()) {
      const row = rows[index] ?? '';
      expect(row, `${line.name} is not on its row`).toContain(line.name);
      expect(row).toContain(formatMoney(line.pricePerSeat, 'full'));
      expect(row).toContain(formatCount(unitsOf(line)));
    }

    // Both tables are mounted, and the closed one only when there is one.
    expect(TABLES).toContain('title="Lines"');
    expect(TABLES).toContain('title="Closed lines"');
    expect(TABLES).toContain('{sunset.length === 0 ? null : (');
    expect(closed.every((line) => !line.isActive)).toBe(true);
  });

  it('draws neither on a rival\'s picture: the screen mounts both behind its own `isOwn`', () => {
    // Both mounts are guarded, and `isOwn` is the walk-aware flag the screen
    // already uses — a rival's picture carries no revenue of theirs.
    expect(SCREEN).toContain('{!isOwn ? null : <LineStatCards figures={figures} />}');
    expect(SCREEN).toMatch(/\{!isOwn \? null : \(\s*<LineTables/);
    // …and the picture itself is still there, above and below.
    expect(SCREEN.indexOf('<LineStatCards')).toBeLessThan(SCREEN.indexOf('<ConnectionsDiagram'));
    expect(SCREEN.indexOf('<LineTables')).toBeGreaterThan(SCREEN.indexOf('<ConnectionsDiagram'));
  });

  it('opens a row\'s own line: the switcher for a live one, the drawer for either', () => {
    // A closed line cannot be selected in the switcher — `connectionsOf` only
    // carries active lines — so the table's pick overrides the picture's.
    expect(SCREEN).toContain('const drawerProductId = tableProductId ?? connections.productId;');
    expect(SCREEN).toContain('if (line !== null && line.isActive) setProductId(productId);');
    expect(SCREEN).toContain('onOpenLine={openFromTable}');
  });
});

/* -------------------------------------------------------------------------- */
/*  2. Walking the chain from a slot                                           */
/* -------------------------------------------------------------------------- */

/** The first slot in the world with a route that buys from a named seller. */
function slotWithSeller(state: SessionState, company: Company): {
  readonly slot: ReturnType<typeof slotOptions>[number];
  readonly choice: ReturnType<typeof choiceOfRoute>;
  readonly sellerName: string;
} {
  for (const product of company.products) {
    const nodeId = product.nodeId ?? null;
    if (nodeId === null) continue;
    for (const slot of slotOptions(state, company, nodeId, product.id)) {
      for (const candidate of slot.candidates) {
        const buy = candidate.routes.find((route) => route.kind === 'buy' && route.supplierCompanyId !== company.id);
        if (buy === undefined) continue;
        return { slot, choice: choiceOfRoute(candidate.nodeId, buy), sellerName: buy.label };
      }
    }
  }
  throw new Error('no slot in the seeded world is filled by a named seller');
}

describe('a slot filled by somebody else leads to them', () => {
  it('names the seller, and names nobody on a make or an open-market fill', () => {
    const { state, company } = world();
    const { slot, choice, sellerName } = slotWithSeller(state, company);

    const seller = namedSellerOf(slot, company.id, choice);
    expect(seller).not.toBeNull();
    expect(seller?.name).toBe(sellerName);
    expect(seller?.companyId).not.toBe(company.id);

    // The open market names nobody…
    const market = { nodeId: choice.nodeId, supplierCompanyId: null, supplierProductId: null };
    expect(namedSellerOf(slot, company.id, market)).toBeNull();
    // …and neither does making it yourself.
    const own = { nodeId: choice.nodeId, supplierCompanyId: company.id, supplierProductId: 'prd_own' };
    expect(namedSellerOf(slot, company.id, own)).toBeNull();
  });

  it('draws the row only when the host has a stack to walk', () => {
    const { state, company } = world();
    const { slot, choice, sellerName } = slotWithSeller(state, company);

    const withWalk = renderToStaticMarkup(
      <SlotCandidateSheet
        slot={slot}
        companyId={company.id}
        choice={choice}
        onChoose={() => undefined}
        onBack={() => undefined}
        onSeeConnections={() => undefined}
      />,
    );
    expect(withWalk).toContain('slot-see-connections');
    expect(withWalk).toContain(`See ${sellerName}`);

    // The launch flow has no in-screen stack, so it passes no callback.
    const withoutWalk = renderToStaticMarkup(
      <SlotCandidateSheet slot={slot} companyId={company.id} choice={choice} onChoose={() => undefined} onBack={() => undefined} />,
    );
    expect(withoutWalk).not.toContain('slot-see-connections');
  });

  it('is wired to the screen\'s own walk, and closes the drawer on the way', () => {
    expect(SCREEN).toMatch(/onSeeConnections=\{\(companyId\) => \{\s*closeDrawer\(\);\s*walkTo\(companyId\);/);
  });
});

/* -------------------------------------------------------------------------- */
/*  3. The recipe line                                                         */
/* -------------------------------------------------------------------------- */

describe('the slot header', () => {
  it('multiplies the quantity by the unit rather than running the two together', () => {
    const { state, company } = world();
    const { slot, choice } = slotWithSeller(state, company);
    const markup = renderToStaticMarkup(
      <SlotCandidateSheet slot={slot} companyId={company.id} choice={choice} onChoose={() => undefined} onBack={() => undefined} />,
    );
    // Either the unit was dropped as a repeat of the slot's own name, or the
    // quantity is multiplied by it.
    const bare = new RegExp(`${escape(String(slot.qtyPerUnit))} per unit`);
    expect(markup.includes(`× ${slot.unitLabel} per unit`) || bare.test(markup)).toBe(true);
    expect(markup).not.toContain(`${slot.qtyPerUnit} ${slot.unitLabel} per unit`);
  });
});

/** A literal for a regular expression. */
function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
