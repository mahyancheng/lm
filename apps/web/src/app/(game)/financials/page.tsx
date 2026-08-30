'use client';

/**
 * Financials — the quarter's accounts, with the working attached.
 *
 * Profit and loss, the balance sheet with its reconciliation shown as a passed
 * assertion rather than hidden, cash movement, product economics, filed
 * history, contracted backlog and the debt schedule. Every statement line opens
 * the ledger rows behind it.
 */

import Link from 'next/link';
import { useMemo, useState } from 'react';
import type { SimEventType } from '@frontier/contracts';
import { quarterLabel } from '@frontier/contracts';
import { formatMoney, formatPct, formatQuarterCount, formatScore } from '@frontier/shared';
import {
  DataTable,
  EmptyState,
  KeyValueGrid,
  PageHeader,
  Panel,
  ProgressBar,
  StatCard,
  Tag,
  type Column,
} from '@/components/ui';
import { useCompanyMetrics, useGame, usePlayerCompany, usePlayerView, useQuotes, useSession } from '@/lib/game';
import { LedgerDrawer } from '@/components/screens/reporting/LedgerDrawer';
import { StatementTable, type StatementRow } from '@/components/screens/reporting/StatementTable';
import { balanceSheetView, humanise, incomeStatementOf } from '@/components/screens/reporting/util';
import { HistoryPanel } from '@/components/screens/financials/HistoryPanel';

interface LedgerSelection {
  readonly title: string;
  readonly types: readonly SimEventType[];
}

const SELECTIONS = {
  revenue: { title: 'Revenue recognised', types: ['revenue_recognised', 'demand_resolved'] },
  cost: { title: 'Costs recognised', types: ['cost_recognised'] },
  cash: { title: 'Cash flow resolved', types: ['cash_flow_resolved'] },
  balance: { title: 'Balance sheet check', types: ['balance_sheet_checked'] },
  debt: { title: 'Debt and interest', types: ['debt_issued', 'cost_recognised'] },
  contracts: { title: 'Contract awards and milestones', types: ['contract_awarded', 'contract_milestone', 'contract_penalty'] },
} as const satisfies Record<string, LedgerSelection>;

type SelectionKey = keyof typeof SELECTIONS;

export default function FinancialsPage(): React.JSX.Element {
  const session = useSession();
  const view = usePlayerView();
  const company = usePlayerCompany();
  const metrics = useCompanyMetrics();
  const { lastOutcome } = useGame();
  // `useQuotes()` with no id returns the whole tape, so an unlisted company must
  // be given an empty series rather than every other company's prices.
  const tape = useQuotes(company.instrumentId ?? undefined);
  const quotes = company.instrumentId === null ? [] : tape;

  const [selection, setSelection] = useState<SelectionKey | null>(null);

  const pnl = useMemo(() => incomeStatementOf(company.financials), [company.financials]);
  const sheet = useMemo(() => balanceSheetView(company.balanceSheet), [company.balanceSheet]);

  const ledgerEvents = useMemo(() => {
    if (lastOutcome === null || selection === null) return [];
    const types = new Set<string>(SELECTIONS[selection].types);
    return lastOutcome.events.filter((event) => types.has(event.type) && (event.actorId === company.id || event.targetId === company.id));
  }, [lastOutcome, selection, company.id]);

  const openingCash = company.financials.cash - company.financials.quarterlyBurn;
  const impliedRate = company.financials.debt > 0 ? (company.financials.interestExpense * 4) / company.financials.debt : null;
  const coverage = company.financials.interestExpense > 0 ? pnl.operatingIncome / company.financials.interestExpense : null;

  const activeProducts = company.products.filter((product) => product.isActive);
  const totalCustomers = activeProducts.reduce((total, product) => total + product.activeCustomers, 0);

  /* --- statements --------------------------------------------------------- */

  const pnlRows: StatementRow[] = [
    { key: 'revenue', label: 'Revenue', value: formatMoney(pnl.revenue), emphasis: true, onClick: () => setSelection('revenue') },
    { key: 'cogs', label: 'Cost of revenue', value: formatMoney(-pnl.cogs), indent: true, tone: 'loss', onClick: () => setSelection('cost') },
    {
      key: 'gross',
      label: 'Gross profit',
      value: formatMoney(pnl.grossProfit),
      secondary: formatPct(pnl.grossMarginPct),
      emphasis: true,
      tone: pnl.grossProfit >= 0 ? 'gain' : 'loss',
    },
    { key: 'payroll', label: 'Payroll', value: formatMoney(-pnl.payroll), indent: true, onClick: () => setSelection('cost') },
    { key: 'marketing', label: 'Marketing', value: formatMoney(-pnl.marketing), indent: true, onClick: () => setSelection('cost') },
    { key: 'rd', label: 'Research and development', value: formatMoney(-pnl.rdSpend), indent: true, onClick: () => setSelection('cost') },
    { key: 'opex', label: 'Operating expenses', value: formatMoney(-pnl.operatingExpenses), emphasis: true },
    {
      key: 'ebit',
      label: 'Operating income (EBIT)',
      value: formatMoney(pnl.operatingIncome),
      secondary: formatPct(pnl.operatingMarginPct),
      emphasis: true,
      tone: pnl.operatingIncome >= 0 ? 'gain' : 'loss',
    },
    { key: 'interest', label: 'Interest expense', value: formatMoney(-pnl.interestExpense), indent: true, onClick: () => setSelection('debt') },
    {
      key: 'pretax',
      label: 'Result before tax',
      value: formatMoney(pnl.preTaxIncome),
      secondary: formatPct(pnl.preTaxMarginPct),
      emphasis: true,
      tone: pnl.preTaxIncome >= 0 ? 'gain' : 'loss',
      hint: 'The engine does not model corporate tax; this is the bottom line it computes.',
    },
  ];

  const balanceRows: StatementRow[] = [
    { key: 'cash', label: 'Cash and equivalents', value: formatMoney(company.balanceSheet.assets.cash), indent: true },
    { key: 'ppe', label: 'Property, plant and equipment', value: formatMoney(company.balanceSheet.assets.ppe), indent: true },
    { key: 'goodwill', label: 'Goodwill', value: formatMoney(company.balanceSheet.assets.goodwill), indent: true },
    { key: 'investments', label: 'Investments', value: formatMoney(company.balanceSheet.assets.investments), indent: true },
    { key: 'receivables', label: 'Receivables', value: formatMoney(company.balanceSheet.assets.receivables), indent: true },
    { key: 'assets', label: 'Total assets', value: formatMoney(sheet.totalAssets), emphasis: true },
    { key: 'debt', label: 'Interest-bearing debt', value: formatMoney(company.balanceSheet.liabilities.debt), indent: true, onClick: () => setSelection('debt') },
    { key: 'payables', label: 'Payables', value: formatMoney(company.balanceSheet.liabilities.payables), indent: true },
    { key: 'deferred', label: 'Deferred revenue', value: formatMoney(company.balanceSheet.liabilities.deferredRevenue), indent: true },
    { key: 'liabilities', label: 'Total liabilities', value: formatMoney(sheet.totalLiabilities), emphasis: true },
    {
      key: 'equity',
      label: 'Shareholders’ equity',
      value: formatMoney(sheet.equity),
      emphasis: true,
      tone: sheet.equity >= 0 ? 'gain' : 'loss',
      onClick: () => setSelection('balance'),
    },
  ];

  const cashRows: StatementRow[] = [
    { key: 'opening', label: 'Opening cash', value: formatMoney(openingCash), hint: 'Closing cash less the quarter’s net movement.' },
    {
      key: 'movement',
      label: 'Net cash movement',
      value: formatMoney(company.financials.quarterlyBurn),
      tone: company.financials.quarterlyBurn >= 0 ? 'gain' : 'loss',
      onClick: () => setSelection('cash'),
    },
    { key: 'capex', label: 'of which capital expenditure', value: formatMoney(-pnl.capex), indent: true },
    { key: 'interest-paid', label: 'of which interest paid', value: formatMoney(-pnl.interestExpense), indent: true },
    {
      key: 'closing',
      label: 'Closing cash',
      value: formatMoney(company.financials.cash),
      emphasis: true,
      tone: company.financials.cash > 0 ? undefined : 'loss',
      onClick: () => setSelection('cash'),
    },
  ];

  /* --- product table ------------------------------------------------------ */

  type ProductRow = (typeof company.products)[number];

  const productColumns: readonly Column<ProductRow>[] = [
    { key: 'name', header: 'Product', render: (row) => <span className="text-ink">{row.name}</span>, sortable: true, sortValue: (row) => row.name },
    { key: 'segment', header: 'Segment', render: (row) => <Tag>{humanise(row.segment)}</Tag>, hideOnMobile: true },
    { key: 'price', header: 'Price', align: 'right', render: (row) => formatMoney(row.pricePerSeat), sortable: true, sortValue: (row) => row.pricePerSeat },
    {
      key: 'customers',
      header: 'Customers',
      align: 'right',
      render: (row) => formatScore(row.activeCustomers),
      sortable: true,
      sortValue: (row) => row.activeCustomers,
    },
    {
      key: 'share',
      header: 'Share',
      align: 'right',
      render: (row) => (totalCustomers === 0 ? '—' : formatPct(row.activeCustomers / totalCustomers)),
      hideOnMobile: true,
    },
    { key: 'margin', header: 'Gross margin', align: 'right', render: (row) => formatPct(row.grossMarginPct), sortable: true, sortValue: (row) => row.grossMarginPct },
    { key: 'churn', header: 'Churn', align: 'right', render: (row) => formatPct(row.churnQuarterly), hideOnMobile: true },
    { key: 'growth', header: 'Growth', align: 'right', render: (row) => formatPct(row.growthQuarterly), hideOnMobile: true },
    { key: 'quality', header: 'Quality', align: 'right', render: (row) => formatPct(row.qualityScore), hideOnMobile: true },
  ];

  /* --- contracts ---------------------------------------------------------- */

  type ContractRow = (typeof view.contracts)[number];

  const contractColumns: readonly Column<ContractRow>[] = [
    { key: 'id', header: 'Contract', render: (row) => <span className="text-ink">{row.id}</span> },
    { key: 'agency', header: 'Agency', render: (row) => humanise(row.agencyId.replace(/^agy_/, '')), hideOnMobile: true },
    { key: 'form', header: 'Form', render: (row) => <Tag>{humanise(row.contractForm)}</Tag>, hideOnMobile: true },
    { key: 'value', header: 'Ceiling', align: 'right', render: (row) => formatMoney(row.totalValueUsd), sortable: true, sortValue: (row) => row.totalValueUsd },
    { key: 'recognised', header: 'Recognised', align: 'right', render: (row) => formatMoney(row.recognisedToDateUsd) },
    {
      key: 'remaining',
      header: 'Remaining',
      align: 'right',
      render: (row) => formatMoney(Math.max(0, row.totalValueUsd - row.recognisedToDateUsd)),
      sortable: true,
      sortValue: (row) => row.totalValueUsd - row.recognisedToDateUsd,
    },
    { key: 'performance', header: 'Performance', align: 'right', render: (row) => formatScore(row.performanceToDate), hideOnMobile: true },
    {
      key: 'status',
      header: 'Status',
      render: (row) => (
        <Tag tone={row.status === 'active' ? 'gain' : row.status === 'completed' ? 'neutral' : 'loss'} dot>
          {row.status}
        </Tag>
      ),
    },
  ];

  const contractedRemaining = view.contracts.reduce(
    (total, contract) => total + Math.max(0, contract.totalValueUsd - contract.recognisedToDateUsd),
    0,
  );

  return (
    <>
      <PageHeader
        title="Financials"
        eyebrow={`${quarterLabel(session.startYear, session.quarter)} · ${company.name}`}
        subtitle="Quarterly accounts as the engine committed them. Every line opens the ledger rows behind it."
        actions={
          <>
            <Tag tone={sheet.reconciles ? 'gain' : 'loss'} dot title="Assets less liabilities must equal equity within one dollar.">
              {sheet.reconciles ? 'Balance sheet reconciles' : 'Reconciliation failed'}
            </Tag>
            <Link href="/capital" className="btn btn-sm">
              Capital
            </Link>
          </>
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        <StatCard label="Revenue" value={formatMoney(pnl.revenue)} delta={metrics?.revenueGrowthYoY} hint="Recognised this quarter" />
        <StatCard
          label="Gross profit"
          value={formatMoney(pnl.grossProfit)}
          tone={pnl.grossProfit >= 0 ? undefined : 'loss'}
          hint={`Margin ${formatPct(pnl.grossMarginPct)}`}
        />
        <StatCard
          label="Operating income"
          value={formatMoney(pnl.operatingIncome)}
          tone={pnl.operatingIncome >= 0 ? 'gain' : 'loss'}
          hint={`Margin ${formatPct(pnl.operatingMarginPct)}`}
        />
        <StatCard
          label="Result before tax"
          value={formatMoney(pnl.preTaxIncome)}
          tone={pnl.preTaxIncome >= 0 ? 'gain' : 'loss'}
          hint="After interest"
        />
        <StatCard
          label="Cash movement"
          value={formatMoney(company.financials.quarterlyBurn)}
          tone={company.financials.quarterlyBurn >= 0 ? 'gain' : 'loss'}
          hint={`Closing cash ${formatMoney(company.financials.cash)}`}
        />
        <StatCard
          label="Runway"
          value={metrics === null ? '—' : formatQuarterCount(metrics.runwayQuarters)}
          tone={metrics === null ? undefined : metrics.runwayQuarters < 6 ? 'warn' : undefined}
          hint={metrics === null ? 'Computed at the first resolution' : 'At the current burn'}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Profit and loss" subtitle={`Quarter ${quarterLabel(session.startYear, session.quarter)} · figures in dollars`}>
          <StatementTable rows={pnlRows} valueHeader="Amount" secondaryHeader="Margin" />
        </Panel>

        <Panel
          title="Balance sheet"
          subtitle="Assets less liabilities must equal equity within one dollar, or the quarter does not commit."
          actions={
            <Tag tone={sheet.reconciles ? 'gain' : 'loss'} dot>
              {sheet.reconciles ? 'Passed' : `Off by ${formatMoney(sheet.discrepancy)}`}
            </Tag>
          }
        >
          <StatementTable rows={balanceRows} valueHeader="Amount" />
          <p className="mt-3 text-[10px] text-ink-faint">
            Residual assets − liabilities − equity: <span className="figure text-ink-dim">{formatMoney(sheet.discrepancy, 'full')}</span>
          </p>
        </Panel>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Panel title="Cash flow" subtitle="Movement over the quarter, as reported.">
          <StatementTable rows={cashRows} valueHeader="Amount" />
        </Panel>

        <Panel title="Debt schedule" className="lg:col-span-2" subtitle="Outstanding principal, its cost and how well it is covered.">
          {company.financials.debt <= 0 ? (
            <EmptyState
              compact
              glyph="DBT"
              title="No interest-bearing debt"
              message="Nothing is drawn. A debt issue can be attempted from the Capital screen; the rate clears against the world's credit spreads and debt availability."
              action={
                <Link href="/capital" className="btn btn-sm">
                  Open Capital
                </Link>
              }
            />
          ) : (
            <KeyValueGrid
              columns={3}
              items={[
                { label: 'Principal outstanding', value: formatMoney(company.financials.debt) },
                { label: 'Interest this quarter', value: formatMoney(company.financials.interestExpense) },
                {
                  label: 'Implied annual rate',
                  value: impliedRate === null ? '—' : formatPct(impliedRate, 2),
                  hint: 'Quarterly interest annualised over principal.',
                },
                {
                  label: 'Interest coverage',
                  value: coverage === null ? '—' : `${coverage.toFixed(2)}×`,
                  tone: coverage === null ? undefined : coverage >= 2 ? 'gain' : coverage >= 1 ? 'warn' : 'loss',
                  hint: 'Operating income over interest expense.',
                },
                { label: 'Debt on balance sheet', value: formatMoney(company.balanceSheet.liabilities.debt) },
                {
                  label: 'Net cash',
                  value: formatMoney(company.financials.cash - company.financials.debt),
                  tone: company.financials.cash - company.financials.debt >= 0 ? 'gain' : 'loss',
                },
                {
                  label: 'Credit spreads (world)',
                  value: formatPct(view.world.macro.creditSpreads, 2),
                  hint: 'Over the policy rate; widening spreads reprice every future issue.',
                },
                { label: 'Policy rate (world)', value: formatPct(view.world.macro.policyRate, 2) },
                {
                  label: 'Debt availability',
                  value: formatPct(view.world.capitalMarkets.debtAvailability),
                  hint: 'Lender willingness to extend credit to AI companies.',
                },
              ]}
            />
          )}
        </Panel>
      </div>

      <Panel
        title="Product lines"
        flush
        subtitle="Unit economics per line. Recognised revenue is reported at company level, so no line here restates it."
      >
        <DataTable
          columns={productColumns}
          rows={activeProducts}
          rowKey={(row) => row.id}
          rowHref={() => '/products'}
          dense
          empty={<EmptyState compact title="No active products" message="Launch a product from the Products screen." />}
        />
      </Panel>

      <div className="grid gap-4 lg:grid-cols-3">
        <Panel title="Contracted revenue" subtitle="What is billed but not earned, and what is won but not billed.">
          <KeyValueGrid
            columns={1}
            items={[
              {
                label: 'Deferred revenue',
                value: formatMoney(company.financials.deferredRevenue),
                hint: 'Collected for work not yet delivered.',
              },
              {
                label: 'Backlog',
                value: formatMoney(company.financials.backlogUsd),
                hint: 'Contracted future revenue not yet billed.',
              },
              {
                label: 'Awarded, not recognised',
                value: formatMoney(contractedRemaining),
                hint: 'Across every live government contract.',
              },
              {
                label: 'Government revenue share',
                value: metrics === null ? '—' : formatPct(metrics.governmentRevenueShare),
                hint: 'Stability and constraint arrive together.',
              },
            ]}
          />
          {company.financials.backlogUsd > 0 ? (
            <ProgressBar
              className="mt-3"
              label="Backlog against a quarter of revenue"
              value={company.financials.backlogUsd}
              max={Math.max(company.financials.backlogUsd, company.financials.revenueQuarterly * 4)}
              valueLabel={formatMoney(company.financials.backlogUsd)}
              tone="info"
            />
          ) : null}
        </Panel>

        <Panel
          title="Government contracts"
          className="lg:col-span-2"
          flush
          actions={
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setSelection('contracts')}>
              Ledger
            </button>
          }
        >
          <DataTable
            columns={contractColumns}
            rows={view.contracts}
            rowKey={(row) => row.id}
            rowHref={() => '/government'}
            dense
            empty={
              <EmptyState
                compact
                glyph="GOV"
                title="No contracts in flight"
                message="Awards create backlog before they create revenue. Open procurements are on the Government screen."
              />
            }
          />
        </Panel>
      </div>

      <Panel title="History" subtitle="Per-quarter series, from the public record and the tape.">
        <HistoryPanel view={view} companyId={company.id} startYear={session.startYear} quotes={quotes} />
      </Panel>

      <LedgerDrawer
        open={selection !== null}
        onClose={() => setSelection(null)}
        title={selection === null ? 'Ledger' : SELECTIONS[selection].title}
        subtitle={
          lastOutcome === null
            ? 'No quarter has resolved in this tab yet.'
            : `${quarterLabel(session.startYear, lastOutcome.report.quarter)} · ${ledgerEvents.length} committed row${ledgerEvents.length === 1 ? '' : 's'}`
        }
        events={ledgerEvents}
      />
    </>
  );
}
