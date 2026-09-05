'use client';

/**
 * Products — the portfolio, its unit economics and the tickets that change it.
 *
 * One row per product line, priced, counted and margined exactly as the engine
 * holds it. Serving-capacity headroom sits at the top of the screen because
 * selling past capacity is a failure mode a player has to see coming: the
 * shortfall becomes churn in the product phase, not a warning afterwards.
 *
 * Everything here is the player's own company. Rival pricing is not visible to
 * anyone in this world, so no rival product appears on this screen at all.
 */

import { useEffect, useMemo, useState } from 'react';
import type { Product } from '@frontier/contracts';
import { quarterLabel } from '@frontier/contracts';
import { isMultiSectorWorld, isNodeEconomyWorld, servingComputeUnits } from '@frontier/simulation';
import { formatCount, formatDelta, formatMoney, formatPct } from '@frontier/shared';
import {
  DataTable,
  DeltaBadge,
  EmptyState,
  Icon,
  Meter,
  PageHeader,
  Panel,
  ProgressBar,
  SectorBadge,
  Sparkline,
  StatCard,
  Tag,
  type Column,
} from '@/components/ui';
import { LaunchModal } from '@/components/screens/products/LaunchModal';
import { MarketingPanel } from '@/components/screens/products/MarketingPanel';
import { ProductDrawer } from '@/components/screens/products/ProductDrawer';
import {
  SEGMENT_LABEL,
  productGrossProfit,
  productRevenue,
  productServingUnits,
  productsByIndustryLine,
  projectCustomers,
} from '@/components/screens/products/labels';
import { NodeChainScreen } from '@/components/screens/products/NodeChainScreen';
import { takePendingLaunchCategory, useActiveCompany, usePlayerView, useQueuedActions, useSession } from '@/lib/game';

export default function ProductsPage(): React.JSX.Element {
  const session = useSession();
  // World 3 is a different economy, so it is a different screen rather than a
  // set of branches inside this one: `NodeChainScreen` is the canvas, and this
  // component stays exactly the screen worlds 1 and 2 have always had.
  if (isNodeEconomyWorld(session)) return <NodeChainScreen />;
  return <LegacyProductsPage />;
}

function LegacyProductsPage(): React.JSX.Element {
  const session = useSession();
  const view = usePlayerView();
  const company = useActiveCompany();
  const queuedEntries = useQueuedActions();
  const [openProductId, setOpenProductId] = useState<string | null>(null);
  const [launchOpen, setLaunchOpen] = useState(false);
  // A Frontier Map node's "launch this line" link hands the category id off
  // through sessionStorage rather than a query param — see deepLink.ts —
  // taken once on mount so a later remount does not reopen the modal.
  const [launchCategoryId, setLaunchCategoryId] = useState<string | null>(null);
  useEffect(() => {
    const pending = takePendingLaunchCategory();
    if (pending === null) return;
    setLaunchCategoryId(pending);
    setLaunchOpen(true);
  }, []);

  function openLaunch(): void {
    setLaunchCategoryId(null);
    setLaunchOpen(true);
  }

  const queued = useMemo(() => queuedEntries.map((entry) => entry.action), [queuedEntries]);

  const active = useMemo(() => company.products.filter((product) => product.isActive), [company.products]);
  const sunset = useMemo(() => company.products.filter((product) => !product.isActive), [company.products]);

  // Grouped by industry line only in world 2, where `categoryOf` resolves a
  // real catalogue entry — world 1's products have no such line to group by,
  // so it keeps its original single flat table. A company selling into only
  // one line still gets the plain table too; grouping earns its place only
  // once there is more than one group to tell apart.
  const industryGroups = useMemo(
    () => (isMultiSectorWorld(session) ? productsByIndustryLine(company, active) : []),
    [session, company, active],
  );
  const grouped = industryGroups.length > 1;

  const revenue = active.reduce((total, product) => total + productRevenue(product), 0);
  const grossProfit = active.reduce((total, product) => total + productGrossProfit(product), 0);
  const customers = active.reduce((total, product) => total + product.activeCustomers, 0);
  const blendedChurn = customers === 0 ? 0 : active.reduce((total, p) => total + p.churnQuarterly * p.activeCustomers, 0) / customers;
  const blendedMargin = revenue === 0 ? 0 : grossProfit / revenue;

  const servingCapacity = servingComputeUnits(session, company);
  const servingDemand = active.reduce((total, product) => total + productServingUnits(session, product), 0);
  const headroom = servingCapacity - servingDemand;

  const openProduct = openProductId === null ? null : (company.products.find((product) => product.id === openProductId) ?? null);

  // Names for the price ladder's dots. Every id on it came out of the projected
  // report, so every name it needs is on the register the projection carries.
  const companyNames = useMemo(() => {
    const names = new Map<string, string>([[company.id, company.name]]);
    for (const rival of view.visibleCompanies) {
      if (rival.id !== undefined && rival.name !== undefined) names.set(rival.id, rival.name);
    }
    return names;
  }, [company.id, company.name, view.visibleCompanies]);

  const columns: readonly Column<Product>[] = [
    {
      key: 'name',
      header: 'Product',
      width: '22%',
      render: (row) => (
        <div className="min-w-0">
          <div className="truncate text-[12.5px] font-medium text-ink">{row.name}</div>
          <div className="text-[10.5px] text-ink-faint">{SEGMENT_LABEL[row.segment]}</div>
        </div>
      ),
      sortable: true,
      sortValue: (row) => row.name,
    },
    {
      // The shape of the line, on the card and in the table: four quarters of
      // seats at exactly today's gross additions and churn. A projection, and
      // labelled as one — the drawer says so at length.
      key: 'trend',
      header: 'Seats',
      cardLabel: 'Seat projection, 4q',
      align: 'center',
      width: '84px',
      render: (row) => (
        <Sparkline
          values={projectCustomers(row, 4)}
          width={64}
          height={20}
          className="inline-block align-middle"
          ariaLabel={`${row.name} seat projection at today's rates`}
        />
      ),
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
      key: 'customers',
      header: 'Customers',
      align: 'right',
      render: (row) => row.activeCustomers,
      sortable: true,
      sortValue: (row) => row.activeCustomers,
    },
    {
      key: 'revenue',
      header: 'Revenue',
      align: 'right',
      render: (row) => formatMoney(productRevenue(row)),
      sortable: true,
      sortValue: (row) => productRevenue(row),
    },
    {
      key: 'growth',
      header: 'Growth',
      align: 'right',
      render: (row) => <DeltaBadge value={row.growthQuarterly} format="percent" bare />,
      sortable: true,
      sortValue: (row) => row.growthQuarterly,
    },
    {
      key: 'churn',
      header: 'Churn',
      align: 'right',
      render: (row) => <DeltaBadge value={row.churnQuarterly} format="percent" invert bare arrow={false} />,
      sortable: true,
      sortValue: (row) => row.churnQuarterly,
    },
    {
      key: 'margin',
      header: 'Gross margin',
      align: 'right',
      hideOnMobile: true,
      render: (row) => formatPct(row.grossMarginPct),
      sortable: true,
      sortValue: (row) => row.grossMarginPct,
    },
    {
      key: 'quality',
      header: 'Quality',
      align: 'right',
      hideOnMobile: true,
      render: (row) => formatPct(row.qualityScore),
      sortable: true,
      sortValue: (row) => row.qualityScore,
    },
    {
      key: 'intensity',
      header: 'Compute',
      align: 'right',
      hideOnMobile: true,
      render: (row) => `${formatPct(row.computeIntensity)} · ${formatCount(productServingUnits(session, row))}u`,
      sortable: true,
      sortValue: (row) => productServingUnits(session, row),
    },
  ];

  return (
    <>
      <PageHeader
        title="Products"
        eyebrow={`${quarterLabel(session.startYear, session.quarter)} · ${company.name}`}
        subtitle="Pricing, customers and unit economics. Every ticket on this screen is an intent: the engine validates, clamps and resolves."
        actions={
          <button type="button" className="btn btn-primary tap-target w-full gap-1.5 sm:w-auto" onClick={openLaunch}>
            <Icon name="plus" size={16} accent="current" />
            Launch product
          </button>
        }
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label="Revenue"
          iconName="coins"
          value={formatMoney(revenue)}
          hint={`${active.length} active line${active.length === 1 ? '' : 's'}`}
          href="/financials"
        />
        <StatCard label="Gross profit" iconName="ledger" value={formatMoney(grossProfit)} hint={`Blended margin ${formatPct(blendedMargin)}`} tone="gain" />
        <StatCard label="Customers" iconName="people" value={customers.toString()} unit="seats" hint={`Blended churn ${formatPct(blendedChurn)}`} />
        <StatCard
          label="Headroom"
          iconName="box"
          value={formatDelta(headroom, 'number')}
          unit="units"
          tone={headroom < 0 ? 'loss' : headroom < servingCapacity * 0.1 ? 'warn' : 'gain'}
          hint={`${formatCount(servingDemand)} demanded of ${formatCount(servingCapacity)} served`}
          href="/company"
        />
      </div>

      <Panel
        title="Serving capacity"
        iconName="gauge"
        iconTone={headroom < 0 ? 'loss' : 'neutral'}
        subtitle="Selling past capacity is a churn event, not a warning"
        actions={
          headroom < 0 ? (
            <Tag tone="loss" dot>
              Over capacity
            </Tag>
          ) : (
            <Tag tone="gain" dot>
              Within capacity
            </Tag>
          )
        }
      >
        <ProgressBar
          value={Math.min(servingDemand, Math.max(servingCapacity, servingDemand, 1))}
          max={Math.max(servingCapacity, servingDemand, 1)}
          ghostValue={servingCapacity}
          tone={headroom < 0 ? 'loss' : 'gain'}
          height={10}
          label="Demand vs capacity"
          valueLabel={`${formatCount(servingDemand)} / ${formatCount(servingCapacity)}u`}
        />
        <p className="mt-2 text-[11px] text-ink-faint">
          Capacity is held compute times the serving share of the training split. Change the split on Research, or buy capacity from the compute
          controls, before a launch pushes demand past it.
        </p>
      </Panel>

      {grouped ? (
        <>
          {industryGroups.map((group) => (
            <Panel
              key={group.industryLine}
              title={group.industryLine}
              iconName="box"
              subtitle={`${group.products.length} line${group.products.length === 1 ? '' : 's'} · select one to open its economics`}
              actions={<SectorBadge sector={group.sector} />}
              flush
            >
              <DataTable
                columns={columns}
                rows={group.products}
                rowKey={(row) => row.id}
                onRowClick={(row) => setOpenProductId(row.id)}
                initialSort={{ key: 'revenue', direction: 'desc' }}
                cardMode="auto"
                cardTitleKey="name"
                dense
              />
            </Panel>
          ))}
          <div className="-mt-1">
            <button type="button" className="btn btn-primary tap-target w-full gap-1.5 sm:w-auto" onClick={openLaunch}>
              <Icon name="plus" size={16} accent="current" />
              Launch another product
            </button>
          </div>
        </>
      ) : (
        <Panel title="Product lines" iconName="box" subtitle="Select a line to open its economics, reprice it or sunset it" flush>
          <DataTable
            columns={columns}
            rows={active}
            rowKey={(row) => row.id}
            onRowClick={(row) => setOpenProductId(row.id)}
            initialSort={{ key: 'revenue', direction: 'desc' }}
            cardMode="auto"
            cardTitleKey="name"
            empty={
              <div className="p-4">
                <EmptyState
                  icon="box"
                  title="No active products"
                  message="Nothing is being sold. A company with no product line books no revenue and churns nobody."
                  action={
                    <button type="button" className="btn btn-primary tap-target gap-1.5" onClick={openLaunch}>
                      <Icon name="plus" size={16} accent="current" />
                      Launch the first product
                    </button>
                  }
                />
              </div>
            }
          />
          {active.length === 0 ? null : (
            // The ticket sits under the thing it acts on, where a thumb already
            // is, rather than only in the page header a scroll away.
            <div className="border-t border-hair p-3">
              <button type="button" className="btn btn-primary tap-target w-full gap-1.5 sm:w-auto" onClick={openLaunch}>
                <Icon name="plus" size={16} accent="current" />
                Launch another product
              </button>
            </div>
          )}
        </Panel>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <MarketingPanel company={company} queued={queued} />

        <Panel title="Portfolio quality" iconName="trophy" subtitle="Where each line sits against the market frontier">
          {active.length === 0 ? (
            <EmptyState compact icon="trophy" title="Nothing to compare" message="Quality is measured against the segment frontier once a product is live." />
          ) : (
            <div className="space-y-3.5">
              {active.map((product) => (
                <div key={product.id}>
                  <Meter value={product.qualityScore * 100} label={`${product.name} — ${SEGMENT_LABEL[product.segment]}`} />
                  <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-ink-faint">
                    <span>
                      Revenue per customer{' '}
                      <span className="figure text-ink-dim">
                        {formatMoney(product.activeCustomers === 0 ? 0 : productRevenue(product) / product.activeCustomers, 'full')}
                      </span>
                    </span>
                    <span>
                      Gross profit <span className="figure text-ink-dim">{formatMoney(productGrossProfit(product))}</span>
                    </span>
                    <span>
                      Serving <span className="figure text-ink-dim">{formatCount(productServingUnits(session, product))}u</span>
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Panel>
      </div>

      {sunset.length === 0 ? null : (
        <Panel title="Sunset lines" iconName="ledger" subtitle="Kept for financial comparatives" flush>
          <DataTable
            columns={columns}
            rows={sunset}
            rowKey={(row) => row.id}
            onRowClick={(row) => setOpenProductId(row.id)}
            cardMode="auto"
            cardTitleKey="name"
            dense
          />
        </Panel>
      )}

      <ProductDrawer
        session={session}
        product={openProduct}
        onClose={() => setOpenProductId(null)}
        report={view.economyReport}
        companyId={company.id}
        companyNames={companyNames}
      />
      <LaunchModal open={launchOpen} onClose={() => setLaunchOpen(false)} initialCategoryId={launchCategoryId} />
    </>
  );
}
