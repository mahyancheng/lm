'use client';

/**
 * The Products sheet's figures: four cards above the picture, two tables below.
 *
 * The Connections picture answers *how is this line wired*; it does not answer
 * *what did my lines book*. That question used to be the top of the chain
 * screen and went with it, and the owner asked for it back — so the same four
 * `StatCard`s and the same two tables, with the same columns and the same
 * engine readings, sit around the picture rather than instead of it.
 *
 * Everything here is the engine's own arithmetic on the company's own lines:
 * `pricePerSeat` as the engine holds it, the filed `unitCostUsd` or — before the
 * production phase has stamped one — the same live roll-up the picture draws
 * (`lineUnitCostUsd`), `unitCostOf` for whether an input is blocked, and
 * `nodeMarketPriceUsd` for the market column.
 * Nothing computes an economic figure of its own, and nothing is drawn for a
 * company that is not the reader's — a rival's picture is public relationships
 * only, and their revenue is not public.
 */

import type { Company, NodeCostCache, Product, SessionState } from '@frontier/contracts';
import { economicNodeById, nodeMarketPriceUsd } from '@frontier/contracts';
import { createNodeCostCache, lineNodeIdOf, unitCostOf, unitCostOfProduct } from '@frontier/simulation';
import { formatCount, formatMoney, formatPct } from '@frontier/shared';
import { DataTable, EmptyState, Icon, Panel, StatCard, type Column } from '@/components/ui';
import { sheetHref } from '@/lib/sheets';

/** Units a line sold last quarter. `activeCustomers` equals it on every world-3 line by construction. */
export function unitsOf(product: Product): number {
  return product.unitsSoldQuarterly ?? product.activeCustomers;
}

export interface LineFigures {
  readonly revenueUsd: number;
  readonly cogsUsd: number;
  readonly grossProfitUsd: number;
  readonly blendedMarginPct: number;
  readonly activeCount: number;
  readonly blockedLines: number;
}

/**
 * What one unit of a line costs to make, right now.
 *
 * `unitCostUsd` is stamped on the product by the production phase, so before a
 * company's first resolution it is zero on every line — and a roll-up of zeros
 * is what printed "Cost of goods $0 · Blended margin 100%" over a picture whose
 * own hub said "Cost $868" and whose margin disc said 65%. The engine's live
 * roll-up is the same arithmetic the production phase will stamp, and it is
 * exactly what the Connections picture already draws, so the sheet reads the
 * roll-up whenever the stamp is not there yet. Nothing is invented here: both
 * numbers come from `cost.ts`.
 */
export function lineUnitCostUsd(session: SessionState, company: Company, product: Product, cache?: NodeCostCache): number {
  const stamped = product.unitCostUsd ?? 0;
  if (stamped > 0) return stamped;
  const nodeId = lineNodeIdOf(product);
  const rolled = unitCostOfProduct(session, company, product, cache) ?? (nodeId === null ? null : unitCostOf(session, company, nodeId, cache));
  return rolled?.unitCostUsd ?? 0;
}

/** The four figures, worked out the way the chain screen worked them out. */
export function lineFigures(session: SessionState, company: Company, active: readonly Product[]): LineFigures {
  const cache = createNodeCostCache(session);
  const revenueUsd = active.reduce((total, product) => total + product.pricePerSeat * unitsOf(product), 0);
  const cogsUsd = active.reduce((total, product) => total + lineUnitCostUsd(session, company, product, cache) * unitsOf(product), 0);
  const grossProfitUsd = revenueUsd - cogsUsd;
  const blockedLines = active.filter((product) => {
    const nodeId = lineNodeIdOf(product);
    return nodeId !== null && unitCostOf(session, company, nodeId, cache).blockedInputNodeIds.length > 0;
  }).length;
  return {
    revenueUsd,
    cogsUsd,
    grossProfitUsd,
    blendedMarginPct: revenueUsd === 0 ? 0 : grossProfitUsd / revenueUsd,
    activeCount: active.length,
    blockedLines,
  };
}

/** Two up on a phone, four across from `lg` — the grid the chain screen used. */
export function LineStatCards({ figures }: { readonly figures: LineFigures }): React.JSX.Element {
  const { revenueUsd, cogsUsd, grossProfitUsd, blendedMarginPct, activeCount, blockedLines } = figures;
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <StatCard
        label="Revenue"
        iconName="coins"
        value={formatMoney(revenueUsd)}
        hint={`${activeCount} line${activeCount === 1 ? '' : 's'}`}
        href={sheetHref('financials')}
      />
      <StatCard label="Cost of goods" iconName="ledger" value={formatMoney(cogsUsd)} hint="the roll-up, exactly" />
      <StatCard
        label="Gross profit"
        iconName="chart"
        value={formatMoney(grossProfitUsd)}
        tone={grossProfitUsd >= 0 ? 'gain' : 'loss'}
        hint={`Blended margin ${formatPct(blendedMarginPct)}`}
      />
      <StatCard
        label="Blocked inputs"
        iconName="warning"
        value={blockedLines.toString()}
        unit={blockedLines === 1 ? 'line' : 'lines'}
        tone={blockedLines > 0 ? 'loss' : 'gain'}
        hint={blockedLines > 0 ? 'nobody in the world makes it' : 'every input has a source'}
      />
    </div>
  );
}

/**
 * The columns, exactly as the chain screen defined them.
 *
 * Status is the line's own state rather than a seventh column: a table on a
 * 390-point phone is in card mode, and the closed table's own heading already
 * says what its rows are.
 */
export function lineColumns(session: SessionState, company: Company): readonly Column<Product>[] {
  // One roll-up cache for the whole table: the unit-cost column asks per row.
  const cache = createNodeCostCache(session);
  return [
    {
      key: 'name',
      header: 'Line',
      width: '32%',
      render: (row) => {
        const node = economicNodeById(lineNodeIdOf(row) ?? '');
        return (
          <div className="min-w-0">
            <div className="truncate text-[12.5px] font-medium text-ink">{row.name}</div>
            <div className="truncate text-[10.5px] text-ink-faint">{node === undefined ? '—' : `${node.label} · per ${node.unitLabel}`}</div>
          </div>
        );
      },
      sortable: true,
    },
    {
      key: 'price',
      header: 'Price',
      align: 'right',
      render: (row) => formatMoney(row.pricePerSeat, 'full'),
      sortable: true,
      sortValue: (row) => row.pricePerSeat,
    },
    {
      key: 'cost',
      header: 'Unit cost',
      align: 'right',
      render: (row) => formatMoney(lineUnitCostUsd(session, company, row, cache), 'full'),
      sortable: true,
      sortValue: (row) => lineUnitCostUsd(session, company, row, cache),
    },
    {
      key: 'units',
      header: 'Units',
      align: 'right',
      render: (row) => formatCount(unitsOf(row)),
      sortable: true,
      sortValue: unitsOf,
    },
    {
      key: 'margin',
      header: 'Margin',
      align: 'right',
      render: (row) => formatPct(row.grossMarginPct),
      sortable: true,
      sortValue: (row) => row.grossMarginPct,
    },
    {
      key: 'market',
      header: 'Market',
      align: 'right',
      hideOnMobile: true,
      render: (row) => formatMoney(nodeMarketPriceUsd(session, lineNodeIdOf(row) ?? ''), 'full'),
      sortable: true,
      sortValue: (row) => nodeMarketPriceUsd(session, lineNodeIdOf(row) ?? ''),
    },
  ];
}

export interface LineTablesProps {
  readonly session: SessionState;
  /** Whose lines these are: the unit-cost column rolls up on this company. */
  readonly company: Company;
  readonly active: readonly Product[];
  readonly sunset: readonly Product[];
  /** Selects the row's line in the switcher above and opens its drawer. */
  readonly onOpenLine: (productId: string) => void;
  /** The empty table's own call to action; omitted where the host has no launch flow. */
  readonly onLaunch?: () => void;
}

export function LineTables({ session, company, active, sunset, onOpenLine, onLaunch }: LineTablesProps): React.JSX.Element {
  const columns = lineColumns(session, company);
  return (
    <>
      <Panel title="Lines" iconName="box" subtitle="Priced, costed and counted exactly as the engine holds them" flush>
        <DataTable
          columns={columns}
          rows={active}
          rowKey={(row) => row.id}
          onRowClick={(row) => onOpenLine(row.id)}
          initialSort={{ key: 'units', direction: 'desc' }}
          cardMode="auto"
          cardTitleKey="name"
          empty={
            <div className="p-4">
              <EmptyState
                icon="box"
                title="No active lines"
                message="A company with no line on any node makes nothing and books no revenue."
                action={
                  onLaunch === undefined ? undefined : (
                    <button type="button" className="btn btn-primary tap-target gap-1.5" onClick={onLaunch}>
                      <Icon name="plus" size={16} accent="current" />
                      Open the first line
                    </button>
                  )
                }
              />
            </div>
          }
        />
      </Panel>

      {sunset.length === 0 ? null : (
        <Panel title="Closed lines" iconName="ledger" subtitle="Kept for financial comparatives" flush>
          <DataTable
            columns={columns}
            rows={sunset}
            rowKey={(row) => row.id}
            onRowClick={(row) => onOpenLine(row.id)}
            cardMode="auto"
            cardTitleKey="name"
            dense
          />
        </Panel>
      )}
    </>
  );
}
