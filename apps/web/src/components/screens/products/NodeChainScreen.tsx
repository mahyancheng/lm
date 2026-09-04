'use client';

/**
 * Products, world 3: **my chain**.
 *
 * The screen opens on the canvas fitted to the founder's own lines and what
 * feeds them, because that is the thing they came to look at. Each of their
 * lines is a card with an input port along the bottom for every input the node
 * declares; the wired supplier hangs under each port on a dashed wire, an
 * unwired port carries a `+`, and the output port on the right runs to the
 * market or to their own downstream line.
 *
 * Under the canvas is the same set of lines as a table, because a canvas is
 * good at structure and bad at columns of figures, and a founder wants both.
 * Tapping either opens the same drawer.
 *
 * Every number on this screen came from the engine: `unitCostOf` for cost,
 * `nodeMarketPriceUsd` for the market, `inputOptions` for the wires. Nothing
 * here computes an economic figure of its own.
 */

import { useEffect, useMemo, useState } from 'react';
import type { Product } from '@frontier/contracts';
import { economicNodeById, nodeMarketPriceUsd, quarterLabel } from '@frontier/contracts';
import {
  chainNodeIds,
  inputOptions,
  lineNodeIdOf,
  nodeMapFor,
  unitCostOf,
} from '@frontier/simulation';
import { formatCount, formatMoney, formatPct } from '@frontier/shared';
import { DataTable, EmptyState, Icon, PageHeader, Panel, StatCard, Tag, type Column } from '@/components/ui';
import { Canvas, buildCanvas } from '@/components/screens/graph';
import { takePendingLaunchCategory, useActiveCompany, usePlayerView, useSession } from '@/lib/game';
import { NodeLaunchModal } from './NodeLaunchModal';
import { NodeLineDrawer } from './NodeLineDrawer';

export function NodeChainScreen(): React.JSX.Element {
  const session = useSession();
  const view = usePlayerView();
  const company = useActiveCompany();

  const [openProductId, setOpenProductId] = useState<string | null>(null);
  const [launchOpen, setLaunchOpen] = useState(false);
  const [launchNodeId, setLaunchNodeId] = useState<string | null>(null);
  const [focusNodeId, setFocusNodeId] = useState<string | null>(null);

  // A canvas card's "open a line here" hands the node id off through
  // sessionStorage rather than a query param, and is taken once on mount.
  useEffect(() => {
    const pending = takePendingLaunchCategory();
    if (pending === null) return;
    setLaunchNodeId(pending);
    setLaunchOpen(true);
  }, []);

  const active = useMemo(() => company.products.filter((product) => product.isActive), [company.products]);
  const sunset = useMemo(() => company.products.filter((product) => !product.isActive), [company.products]);

  /* --- the projection, and the model built from it ------------------------ */
  const map = useMemo(() => nodeMapFor(session, company.id), [session, company.id]);
  const chain = useMemo(() => chainNodeIds(map), [map]);

  // Who is wired to what, and what cannot be filled at any price. Both come
  // from `inputOptions` on the company's own lines — the only lines whose
  // economics this seat is entitled to.
  const { wiring, blocked } = useMemo(() => {
    const wired = new Map<string, { companyId: string; name: string; madeInHouse: boolean }>();
    const dead = new Set<string>();
    for (const product of active) {
      const nodeId = lineNodeIdOf(product);
      if (nodeId === null) continue;
      for (const option of inputOptions(session, company, nodeId, product.id)) {
        const key = `${product.id}|${option.inputNodeId}`;
        if (option.blocked) dead.add(key);
        const chosen = option.chosen;
        if (chosen === null || chosen.kind === 'market' || chosen.supplierCompanyId === null) continue;
        wired.set(key, {
          companyId: chosen.supplierCompanyId,
          name: chosen.kind === 'make' ? company.name : (map.companyNames[chosen.supplierCompanyId] ?? chosen.label),
          madeInHouse: chosen.kind === 'make',
        });
      }
    }
    return { wiring: wired, blocked: dead };
  }, [session, company, active, map]);

  const model = useMemo(
    () => buildCanvas(map, { view: 'chain', nodeIds: chain.length > 0 ? chain : undefined, wiring, blocked }),
    [map, chain, wiring, blocked],
  );

  const focus = focusNodeId === null ? (chain.length > 0 ? chain : null) : [focusNodeId];

  /* --- the figures under the picture -------------------------------------- */
  const revenue = active.reduce((total, product) => total + product.pricePerSeat * unitsOf(product), 0);
  const cogs = active.reduce((total, product) => total + (product.unitCostUsd ?? 0) * unitsOf(product), 0);
  const grossProfit = revenue - cogs;
  const blendedMargin = revenue === 0 ? 0 : grossProfit / revenue;
  const blockedLines = active.filter((product) => {
    const nodeId = lineNodeIdOf(product);
    return nodeId !== null && unitCostOf(session, company, nodeId).blockedInputNodeIds.length > 0;
  }).length;

  const companyNames = useMemo(() => new Map(Object.entries(map.companyNames)), [map.companyNames]);
  const openProduct = openProductId === null ? null : (company.products.find((product) => product.id === openProductId) ?? null);

  function openCanvasNode(nodeId: string): void {
    setFocusNodeId(nodeId);
    const mine = active.find((product) => lineNodeIdOf(product) === nodeId);
    if (mine !== undefined) setOpenProductId(mine.id);
    else {
      setLaunchNodeId(nodeId);
      setLaunchOpen(true);
    }
  }

  const columns: readonly Column<Product>[] = [
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
      render: (row) => formatMoney(row.unitCostUsd ?? 0, 'full'),
      sortable: true,
      sortValue: (row) => row.unitCostUsd ?? 0,
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

  return (
    <>
      <PageHeader
        title="My chain"
        eyebrow={`${quarterLabel(session.startYear, session.quarter)} · ${company.name}`}
        subtitle="What you make, what it is made from, and who makes that. Tap a card to open its line; tap a hanging supplier to change it."
        actions={
          <button
            type="button"
            className="btn btn-primary tap-target w-full gap-1.5 sm:w-auto"
            onClick={() => {
              setLaunchNodeId(null);
              setLaunchOpen(true);
            }}
          >
            <Icon name="plus" size={16} accent="current" />
            Open a line
          </button>
        }
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Revenue" iconName="coins" value={formatMoney(revenue)} hint={`${active.length} line${active.length === 1 ? '' : 's'}`} href="/financials" />
        <StatCard label="Cost of goods" iconName="ledger" value={formatMoney(cogs)} hint="the roll-up, exactly" />
        <StatCard label="Gross profit" iconName="chart" value={formatMoney(grossProfit)} tone={grossProfit >= 0 ? 'gain' : 'loss'} hint={`Blended margin ${formatPct(blendedMargin)}`} />
        <StatCard
          label="Blocked inputs"
          iconName="warning"
          value={blockedLines.toString()}
          unit={blockedLines === 1 ? 'line' : 'lines'}
          tone={blockedLines > 0 ? 'loss' : 'gain'}
          hint={blockedLines > 0 ? 'nobody in the world makes it' : 'every input has a source'}
        />
      </div>

      <Panel
        title="The chain"
        iconName="network"
        subtitle="Your lines, their inputs, and who supplies them"
        actions={
          focusNodeId === null ? null : (
            <button type="button" className="btn min-h-11" onClick={() => setFocusNodeId(null)}>
              Show the whole chain
            </button>
          )
        }
        flush
      >
        {model.nodes.length === 0 ? (
          <div className="p-4">
            <EmptyState
              icon="network"
              title="Nothing on the chain yet"
              message="You own nodes but run no line on any of them. Open a line and the canvas fills in around it."
              action={
                <button type="button" className="btn btn-primary tap-target gap-1.5" onClick={() => setLaunchOpen(true)}>
                  <Icon name="plus" size={16} accent="current" />
                  Open the first line
                </button>
              }
            />
          </div>
        ) : (
          <Canvas
            model={model}
            focusNodeIds={focus}
            selectedNodeId={focusNodeId}
            onSelectNode={openCanvasNode}
            onSelectInput={(nodeId) => openCanvasNode(nodeId)}
            height={420}
          />
        )}
      </Panel>

      <Panel title="Lines" iconName="box" subtitle="Priced, costed and counted exactly as the engine holds them" flush>
        <DataTable
          columns={columns}
          rows={active}
          rowKey={(row) => row.id}
          onRowClick={(row) => setOpenProductId(row.id)}
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
                  <button type="button" className="btn btn-primary tap-target gap-1.5" onClick={() => setLaunchOpen(true)}>
                    <Icon name="plus" size={16} accent="current" />
                    Open the first line
                  </button>
                }
              />
            </div>
          }
        />
      </Panel>

      {sunset.length === 0 ? null : (
        <Panel title="Closed lines" iconName="ledger" subtitle="Kept for financial comparatives" flush>
          <DataTable columns={columns} rows={sunset} rowKey={(row) => row.id} onRowClick={(row) => setOpenProductId(row.id)} cardMode="auto" cardTitleKey="name" dense />
        </Panel>
      )}

      {blockedLines === 0 ? null : (
        <Tag tone="loss" dot>
          {blockedLines} line{blockedLines === 1 ? '' : 's'} blocked on an input nobody owns
        </Tag>
      )}

      <NodeLineDrawer
        session={session}
        product={openProduct}
        onClose={() => setOpenProductId(null)}
        report={view.economyReport}
        companyId={company.id}
        companyNames={companyNames}
      />
      <NodeLaunchModal open={launchOpen} onClose={() => setLaunchOpen(false)} initialNodeId={launchNodeId} />
    </>
  );
}

/** Units a line sold last quarter. `activeCustomers` equals it on every world-3 line by construction. */
function unitsOf(product: Product): number {
  return product.unitsSoldQuarterly ?? product.activeCustomers;
}
