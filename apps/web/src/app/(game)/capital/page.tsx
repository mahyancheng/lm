'use client';

/**
 * Capital — who owns this company, what it owes, and what it can raise.
 *
 * Cap table by class with economic and voting percentages side by side, every
 * financing the company has closed or failed to close, the treasury with the
 * runway arithmetic shown rather than asserted, and the three financing tickets
 * — each of which is a board matter and says so.
 */

import Link from 'next/link';
import { useMemo } from 'react';
import { quarterLabel } from '@frontier/contracts';
import { formatMoney, formatPct, formatQuarterCount } from '@frontier/shared';
import {
  DataTable,
  EmptyState,
  KeyValueGrid,
  Meter,
  PageHeader,
  Panel,
  ProgressBar,
  StatCard,
  Tag,
  type Column,
} from '@/components/ui';
import {
  useCompanyMetrics,
  useMarketCap,
  usePlayerCharacter,
  usePlayerCompany,
  usePlayerView,
  useSession,
} from '@/lib/game';
import { CapTableVisual } from '@/components/screens/capital/CapTableVisual';
import { CapitalTickets } from '@/components/screens/capital/CapitalTickets';
import { DilutionCalculator } from '@/components/screens/capital/DilutionCalculator';
import {
  capTableRows,
  formatCount,
  humanise,
  incomeStatementOf,
  issuedSharesOf,
  perSharePrice,
  titleise,
} from '@/components/screens/reporting/util';

export default function CapitalPage(): React.JSX.Element {
  const session = useSession();
  const view = usePlayerView();
  const company = usePlayerCompany();
  const founder = usePlayerCharacter();
  const metrics = useCompanyMetrics();
  const marketCap = useMarketCap();

  const table = view.ownCapTable;
  const price = useMemo(() => perSharePrice(session, company.id), [session, company.id]);
  const rows = useMemo(() => capTableRows(session, table), [session, table]);
  const pnl = useMemo(() => incomeStatementOf(company.financials), [company.financials]);

  const issued = issuedSharesOf(table);
  const founderRow = rows.find((row) => row.holderId === founder.id) ?? null;
  const founderShares = founderRow?.shares ?? 0;

  const rounds = useMemo(
    () =>
      session.fundingRounds
        .filter((round) => round.companyId === company.id)
        .slice()
        .sort((a, b) => (b.closedQuarter !== a.closedQuarter ? b.closedQuarter - a.closedQuarter : a.id.localeCompare(b.id))),
    [session.fundingRounds, company.id],
  );
  const openRounds = rounds.filter((round) => round.status === 'open');

  const burn = Math.max(0, -company.financials.quarterlyBurn);
  const runwayFromCash = burn > 0 ? company.financials.cash / burn : null;

  type RoundRow = (typeof rounds)[number];

  const roundColumns: readonly Column<RoundRow>[] = [
    {
      key: 'stage',
      header: 'Stage',
      render: (row) => (
        <span className="min-w-0">
          <span className="block text-[12px] text-ink">{titleise(row.stage)}</span>
          <span className="block text-[10px] text-ink-faint">{quarterLabel(session.startYear, row.closedQuarter)}</span>
        </span>
      ),
      sortable: true,
      sortValue: (row) => row.closedQuarter,
    },
    { key: 'amount', header: 'Raised', align: 'right', render: (row) => formatMoney(row.amount), sortable: true, sortValue: (row) => row.amount },
    { key: 'pre', header: 'Pre-money', align: 'right', render: (row) => formatMoney(row.preMoney), hideOnMobile: true },
    { key: 'post', header: 'Post-money', align: 'right', render: (row) => formatMoney(row.postMoney), sortable: true, sortValue: (row) => row.postMoney },
    { key: 'dilution', header: 'Dilution', align: 'right', render: (row) => formatPct(row.dilution, 2), sortable: true, sortValue: (row) => row.dilution },
    { key: 'price', header: 'Per share', align: 'right', render: (row) => formatMoney(row.pricePerShareUsd), hideOnMobile: true },
    {
      key: 'lead',
      header: 'Lead',
      hideOnMobile: true,
      render: (row) => {
        if (row.leadInvestorCharacterId === null) return <span className="text-[10px] text-ink-faint">Unled</span>;
        const lead = session.characters.find((character) => character.id === row.leadInvestorCharacterId) ?? null;
        return <span className="text-[11px] text-ink-dim">{lead?.name ?? row.leadInvestorCharacterId}</span>;
      },
    },
    { key: 'seats', header: 'Seats', align: 'right', render: (row) => String(row.boardSeatsGranted), hideOnMobile: true },
    {
      key: 'status',
      header: 'Status',
      render: (row) => (
        <Tag tone={row.status === 'closed' ? 'gain' : row.status === 'open' ? 'warn' : 'loss'} dot>
          {row.status}
        </Tag>
      ),
    },
  ];

  const cumulativeDilution = rounds
    .filter((round) => round.status === 'closed')
    .reduce((total, round) => total + round.dilution, 0);

  return (
    <>
      <PageHeader
        title="Capital"
        eyebrow={`${quarterLabel(session.startYear, session.quarter)} · ${company.name}`}
        subtitle="Ownership, financing and treasury. Control is not percentage — economic and voting stakes are shown side by side."
        actions={
          <>
            <Link href="/financials" className="btn btn-sm">
              Financials
            </Link>
            <Link href="/boardroom" className="btn btn-sm">
              Boardroom
            </Link>
          </>
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        <StatCard label="Cash" value={formatMoney(company.financials.cash)} tone={company.financials.cash <= 0 ? 'loss' : undefined} hint="End of quarter" />
        <StatCard
          label="Quarterly burn"
          value={formatMoney(company.financials.quarterlyBurn)}
          tone={company.financials.quarterlyBurn >= 0 ? 'gain' : 'loss'}
          hint={company.financials.quarterlyBurn >= 0 ? 'Cash generative' : 'Net cash consumed'}
        />
        <StatCard
          label="Runway"
          value={runwayFromCash === null ? '∞' : formatQuarterCount(runwayFromCash)}
          tone={runwayFromCash === null ? 'gain' : runwayFromCash < 3 ? 'loss' : runwayFromCash < 6 ? 'warn' : undefined}
          hint={metrics === null ? 'Cash over burn' : `Engine metric ${formatQuarterCount(metrics.runwayQuarters)}`}
        />
        <StatCard label="Debt" value={formatMoney(company.financials.debt)} hint={`Interest ${formatMoney(company.financials.interestExpense)} this quarter`} />
        <StatCard
          label="Valuation"
          value={formatMoney(marketCap)}
          hint={company.instrumentId === null ? 'Fundamental anchor — unlisted' : 'Market capitalisation'}
          href="/markets"
        />
        <StatCard
          label="Your stake"
          value={issued === 0 ? '—' : formatPct(founderShares / issued, 2)}
          hint={`${formatCount(founderShares)} shares · ${formatPct(founderRow?.votingPct ?? 0, 2)} of votes`}
        />
      </div>

      <Panel
        title="Cap table"
        subtitle={`As at ${quarterLabel(session.startYear, table.lastUpdatedQuarter)} · ${table.shareClasses.length} class${table.shareClasses.length === 1 ? '' : 'es'}`}
        actions={
          <Tag tone={price.basis === 'quote' ? 'info' : 'neutral'}>
            {price.basis === 'quote' ? 'marked to market' : price.basis === 'anchor' ? 'marked to anchor' : 'unmarked'}
          </Tag>
        }
      >
        {table.holdings.length === 0 ? (
          <EmptyState compact title="No shares issued" message="This company has not issued equity yet." />
        ) : (
          <CapTableVisual session={session} table={table} pricePerShare={price.value} priceBasis={price.basis} />
        )}
      </Panel>

      <div className="grid gap-4 lg:grid-cols-3">
        <Panel title="Share classes" subtitle="Votes per share is the number that decides board fights.">
          {table.shareClasses.length === 0 ? (
            <EmptyState compact title="No classes" message="Classes are created when equity is first issued." />
          ) : (
            <div className="flex flex-col gap-3">
              {table.shareClasses.map((shareClass) => (
                <div key={shareClass.id} className="border-b border-hair/60 pb-2 last:border-b-0 last:pb-0">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-[12px] text-ink">{shareClass.label}</span>
                    <Tag tone={shareClass.kind === 'founder_super_voting' ? 'brand' : 'neutral'}>{humanise(shareClass.kind)}</Tag>
                  </div>
                  <KeyValueGrid
                    className="mt-1.5"
                    columns={2}
                    items={[
                      { label: 'Issued', value: formatCount(shareClass.issuedShares) },
                      { label: 'Authorised', value: formatCount(shareClass.authorisedShares) },
                      { label: 'Votes / share', value: shareClass.votesPerShare.toFixed(2) },
                      {
                        label: 'Liquidation pref.',
                        value: `${shareClass.liquidationPreferenceMultiple.toFixed(2)}×${shareClass.participating ? ' participating' : ''}`,
                      },
                    ]}
                  />
                  <ProgressBar
                    className="mt-1.5"
                    label="Authorised used"
                    value={shareClass.issuedShares}
                    max={Math.max(1, shareClass.authorisedShares)}
                    valueLabel={formatPct(shareClass.issuedShares / Math.max(1, shareClass.authorisedShares))}
                    tone="info"
                  />
                </div>
              ))}
            </div>
          )}
        </Panel>

        <Panel title="Treasury" className="lg:col-span-2" subtitle="The runway arithmetic, shown rather than asserted.">
          <KeyValueGrid
            columns={3}
            items={[
              { label: 'Cash', value: formatMoney(company.financials.cash) },
              { label: 'Debt', value: formatMoney(company.financials.debt) },
              {
                label: 'Net cash',
                value: formatMoney(company.financials.cash - company.financials.debt),
                tone: company.financials.cash - company.financials.debt >= 0 ? 'gain' : 'loss',
              },
              { label: 'Quarterly burn', value: formatMoney(company.financials.quarterlyBurn) },
              {
                label: 'Cash ÷ burn',
                value: runwayFromCash === null ? 'Cash generative' : formatQuarterCount(runwayFromCash),
                hint: 'Quarters at the current rate, before any financing.',
              },
              {
                label: 'Engine runway',
                value: metrics === null ? '—' : formatQuarterCount(metrics.runwayQuarters),
                hint: 'Capped at 200 quarters for a cash-generative company.',
              },
              { label: 'Operating income', value: formatMoney(pnl.operatingIncome), tone: pnl.operatingIncome >= 0 ? 'gain' : 'loss' },
              { label: 'Capital expenditure', value: formatMoney(pnl.capex) },
              { label: 'Deferred revenue', value: formatMoney(company.financials.deferredRevenue) },
            ]}
          />

          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            <Meter label="Venture liquidity" value={view.world.capitalMarkets.ventureLiquidity * 100} />
            <Meter label="Debt availability" value={view.world.capitalMarkets.debtAvailability * 100} />
            <Meter label="Listing window" value={view.world.capitalMarkets.ipoWindow * 100} />
          </div>
          <p className="mt-2 text-[10px] text-ink-faint">
            These three world readings decide whether a financing clears at all. They are shared by every participant.
          </p>
        </Panel>
      </div>

      <Panel
        title="Financing history"
        flush
        subtitle={
          rounds.length === 0
            ? 'No financings recorded.'
            : `${rounds.length} recorded · ${formatPct(cumulativeDilution, 1)} cumulative dilution across closed rounds`
        }
        actions={openRounds.length > 0 ? <Tag tone="warn">{openRounds.length} open</Tag> : undefined}
      >
        <DataTable
          columns={roundColumns}
          rows={rounds}
          rowKey={(row) => row.id}
          dense
          isHighlighted={(row) => row.status === 'open'}
          empty={
            <EmptyState
              compact
              glyph="RND"
              title="No financings yet"
              message="Rounds appear here once one closes, fails or is forced. A bridge round the engine forces on a cash shortfall shows as open."
            />
          }
        />
      </Panel>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Financing tickets" subtitle="Every one of these is a board matter and requires an explicit confirmation.">
          <CapitalTickets fullyDilutedShares={table.fullyDilutedShares} cash={company.financials.cash} pricePerShare={price.value} />
        </Panel>

        <Panel title="What a round would cost you" subtitle="Client-side arithmetic. Nothing is submitted.">
          <DilutionCalculator
            fullyDilutedShares={Math.max(1, table.fullyDilutedShares)}
            founderShares={founderShares}
            pricePerShare={price.value}
          />
        </Panel>
      </div>
    </>
  );
}
