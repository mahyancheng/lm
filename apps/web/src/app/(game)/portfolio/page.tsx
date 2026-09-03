'use client';

/**
 * Portfolio — everything owned outside the company itself.
 *
 * The outside assets used to be scattered: one number on the balance sheet, the
 * positions behind it on other companies' registers, an acquired company as an
 * inactive husk, a short on the hedge ledger, and the founder's own wealth
 * recomputed in the store. This screen is the single place they are all read,
 * and it reads exactly one thing — `portfolioOf` (or `founderPortfolioOf` on the
 * Founder toggle) — so it computes no economic number of its own.
 *
 * Four tabs because there are four kinds of thing to own, and one card per row
 * because eight columns is not a phone surface. The chart under the headline is
 * the carrying value the company actually filed each quarter, not a
 * reconstruction: a line drawn from today's positions at yesterday's prices
 * would look better and mean nothing.
 */

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { quarterLabel } from '@frontier/contracts';
import { formatMoney, formatQuarter } from '@frontier/shared';
import type { PortfolioAction } from '@frontier/simulation';
import { founderPortfolioOf, portfolioOf } from '@frontier/simulation';
import {
  DeltaBadge,
  EmptyState,
  Icon,
  LineChart,
  PageHeader,
  Panel,
  StatCard,
  TabBar,
  Tag,
} from '@/components/ui';
import { usePlayerCompany, usePlayerView, useSession } from '@/lib/game';
import { PLAYER_ID } from '@/lib/game/engine';
import {
  CompanyChips,
  FactTag,
  PORTFOLIO_TABS,
  PositionCard,
  PositionDrawer,
  TAB_ICON,
  TAB_LABEL,
  firstPopulatedTab,
  founderHoldingLine,
  fundLine,
  gainPct,
  lockupLine,
  ownershipLabel,
  pctLabel,
  reconciliationLine,
  shortLine,
  stakeLine,
  subsidiaryLine,
  tabCounts,
  type PortfolioTab,
  type PositionTarget,
} from '@/components/screens/portfolio';

export default function PortfolioPage(): React.JSX.Element {
  const session = useSession();
  const view = usePlayerView();
  const company = usePlayerCompany();

  const [seat, setSeat] = useState<'company' | 'founder'>('company');
  const [tab, setTab] = useState<PortfolioTab | null>(null);
  const [openRow, setOpenRow] = useState<PositionTarget | null>(null);
  const [openAction, setOpenAction] = useState<PortfolioAction | null>(null);

  const portfolio = useMemo(() => portfolioOf(session, company.id), [session, company.id]);
  const founder = useMemo(() => founderPortfolioOf(session, PLAYER_ID), [session]);

  const counts = tabCounts(portfolio);
  const active = tab ?? firstPopulatedTab(portfolio);

  const tabs = PORTFOLIO_TABS.map((id) => ({ id, label: TAB_LABEL[id], count: counts[id] }));

  const history = portfolio.history;
  const chart = useMemo(
    () => [{ id: 'carrying', label: 'Carrying value', values: history.map((point) => point.carryingUsd), tone: 'brand' as const }],
    [history],
  );

  function act(row: PositionTarget, action: PortfolioAction): void {
    setOpenRow(row);
    setOpenAction(action);
  }

  /* --- the founder view -------------------------------------------------- */

  if (seat === 'founder') {
    return (
      <>
        <PageHeader
          title="Portfolio"
          eyebrow={`${quarterLabel(session.startYear, session.quarter)} · ${founder.name}`}
          subtitle="What you own personally, your own company included. Valued the way the founder-wealth board values it, so this figure and your ranking are the same arithmetic."
          actions={<SeatToggle seat={seat} onChange={setSeat} />}
        />

        <div className="grid grid-cols-2 gap-2.5 sm:gap-3 lg:grid-cols-4">
          <StatCard iconName="portfolio" iconTone="brand" label="Net worth" value={formatMoney(founder.netWorthUsd)} hint="Personal cash plus every share you hold" />
          <StatCard iconName="coins" label="Cash and the rest" value={formatMoney(founder.cashUsd)} hint="Held outside any register" />
          <StatCard iconName="building" label="Shares" value={formatMoney(founder.holdingsValueUsd)} hint={`${founder.holdings.length} position${founder.holdings.length === 1 ? '' : 's'}`} />
          <StatCard iconName="vault" label="Funds you run" value={`${founder.funds.length}`} hint="Being a partner is the only fund position this world models" />
        </div>

        <Panel iconName="building" iconTone="brand" title="Your shares" subtitle="Every register you are on, your own company first if it is the largest.">
          {founder.holdings.length === 0 ? (
            <EmptyState compact icon="coins" title="You hold no shares" message="A founder normally holds their own company from the first quarter; if this is empty the register does not name you." />
          ) : (
            <div className="grid gap-2.5 sm:grid-cols-2">
              {founder.holdings.map((row) => (
                <PositionCard
                  key={row.holdingId}
                  name={row.name}
                  kindLabel={row.isOwnCompany ? 'Your company' : 'Personal holding'}
                  icon="building"
                  iconTone={row.isOwnCompany ? 'brand' : 'info'}
                  valueUsd={row.valueUsd}
                  costUsd={row.costUsd}
                  dividendsUsd={row.dividendsUsd}
                  chips={
                    <>
                      <CompanyChips sector={row.sector} region={row.region} />
                      {row.thresholdLabel === null ? null : <FactTag tone="info">{row.thresholdLabel.replace(/_/g, ' ')}</FactTag>}
                    </>
                  }
                  line={founderHoldingLine(row)}
                  footnote={lockupLine(row.lockupUntilQuarter, session.quarter)}
                  targetCompanyId={row.companyId}
                  href={row.isOwnCompany ? '/capital' : '/markets'}
                />
              ))}
            </div>
          )}
        </Panel>

        {founder.funds.length === 0 ? null : (
          <Panel iconName="vault" iconTone="info" title="Funds you run" subtitle="A partner's position in the institution itself, not a holding on anybody's register.">
            <div className="grid gap-2.5 sm:grid-cols-2">
              {founder.funds.map((row) => (
                <PositionCard
                  key={row.entityId}
                  name={row.name}
                  kindLabel="General partner"
                  icon="vault"
                  iconTone="info"
                  valueUsd={row.navUsd}
                  valueLabel="NAV"
                  costUsd={row.committedCapitalUsd}
                  dividendsUsd={null}
                  chips={<FactTag tone={row.returnPct >= 100 ? 'gain' : 'neutral'}>{row.returnPct}% of committed returned or marked</FactTag>}
                  line={fundLine(row)}
                  targetCompanyId={null}
                  href="/street"
                />
              ))}
            </div>
          </Panel>
        )}
      </>
    );
  }

  /* --- the company view --------------------------------------------------- */

  return (
    <>
      <PageHeader
        title="Portfolio"
        eyebrow={`${quarterLabel(session.startYear, session.quarter)} · ${company.name}`}
        subtitle="Subsidiaries, stakes, shorts and funds — everything the company owns that is not the company."
        actions={<SeatToggle seat={seat} onChange={setSeat} />}
      />

      <div className="grid grid-cols-2 gap-2.5 sm:gap-3 lg:grid-cols-4">
        <StatCard
          iconName="portfolio"
          iconTone="brand"
          label="Total value"
          value={formatMoney(portfolio.totals.valueUsd)}
          hint={
            portfolio.totals.carryingChangeUsd === null
              ? 'Marked to the tape where listed, to the fundamental anchor where not'
              : undefined
          }
        />
        <StatCard
          iconName="ledger"
          label="Carrying value"
          value={formatMoney(portfolio.totals.carryingUsd)}
          delta={portfolio.totals.carryingChangeUsd ?? undefined}
          deltaFormat="money"
          hint="The investments line on the balance sheet, at cost"
          href="/financials"
        />
        <StatCard
          iconName="chart"
          label="Unrealised"
          value={formatMoney(portfolio.totals.unrealisedUsd)}
          tone={portfolio.totals.unrealisedUsd > 0 ? 'gain' : portfolio.totals.unrealisedUsd < 0 ? 'loss' : undefined}
          hint={pctLabel(gainPct(portfolio.totals.costUsd, portfolio.totals.valueUsd)) + ' over what it cost'}
        />
        <StatCard
          iconName="coins"
          label="Realised and paid"
          value={portfolio.totals.realisedUsd === null ? formatMoney(portfolio.totals.dividendsUsd) : formatMoney(portfolio.totals.realisedUsd + portfolio.totals.dividendsUsd)}
          hint={
            portfolio.totals.realisedUsd === null
              ? 'Dividends received. This world records no realised gains.'
              : `${formatMoney(portfolio.totals.realisedUsd)} realised on sales, ${formatMoney(portfolio.totals.dividendsUsd)} in dividends`
          }
        />
      </div>

      {/* --- the carrying line over time -------------------------------------
          Two years of the figure the company filed. Absent rather than faked
          when the world files no statements. */}
      {history.length < 2 ? null : (
        <Panel
          iconName="chart"
          title="Carrying value, filed"
          subtitle="What the investments line held at the close of each quarter. Cost, not mark: the value above is what the market says today."
          actions={
            portfolio.totals.carryingChangeUsd === null ? null : (
              <DeltaBadge value={portfolio.totals.carryingChangeUsd} format="money" arrow />
            )
          }
        >
          <LineChart
            series={chart}
            xLabels={history.map((point) => formatQuarter(session.startYear, point.quarter))}
            formatValue={formatMoney}
            includeZero
            height={160}
          />
        </Panel>
      )}

      <Panel
        iconName="ledger"
        iconTone={portfolio.reconciliation.reconciles ? 'neutral' : 'loss'}
        title="Against the balance sheet"
        subtitle={reconciliationLine(portfolio)}
        dense
      >
        <div className="flex flex-wrap items-center gap-1.5">
          <Tag tone={portfolio.reconciliation.reconciles ? 'gain' : 'loss'} dot>
            {portfolio.reconciliation.reconciles ? 'Reconciles' : 'Does not reconcile'}
          </Tag>
          <Tag tone="neutral">carried at cost</Tag>
          <Link href="/financials" className="btn btn-ghost btn-sm tap-target gap-1.5 sm:min-h-0">
            <Icon name="chevronRight" size={13} accent="current" />
            The investments line
          </Link>
        </div>
      </Panel>

      <TabBar
        variant="underline"
        ariaLabel="Kinds of holding"
        value={active}
        onChange={(id) => setTab(id as PortfolioTab)}
        tabs={tabs.map((entry) => ({ id: entry.id, label: entry.label, count: entry.count }))}
      />

      {active === 'subsidiaries' ? (
        <Panel iconName={TAB_ICON.subsidiaries} iconTone="brand" title="Subsidiaries" subtitle="Companies you bought outright, and companies you control on the register.">
          {portfolio.subsidiaries.length === 0 ? (
            <EmptyState
              compact
              icon="building"
              title="You control no other company"
              message="Buying one outright starts in the Deal Room; taking one over starts with a stake."
              action={
                <Link href="/deal-room" className="btn btn-sm tap-target sm:min-h-0">
                  Open the Deal Room
                </Link>
              }
            />
          ) : (
            <div className="grid gap-2.5 sm:grid-cols-2">
              {portfolio.subsidiaries.map((row) => (
                <PositionCard
                  key={row.companyId}
                  name={row.name}
                  kindLabel={row.status === 'absorbed' ? 'Absorbed' : 'Controlled'}
                  icon="building"
                  iconTone={row.status === 'absorbed' ? 'neutral' : 'brand'}
                  valueUsd={row.valueUsd}
                  costUsd={row.costUsd}
                  dividendsUsd={row.status === 'absorbed' ? null : row.dividendsUsd}
                  chips={
                    <>
                      <CompanyChips sector={row.sector} region={row.region} />
                      <FactTag tone="info">{ownershipLabel(row.controlPct)} control</FactTag>
                      {row.acquiredQuarter === null ? null : (
                        <FactTag>acquired {formatQuarter(session.startYear, row.acquiredQuarter)}</FactTag>
                      )}
                    </>
                  }
                  line={subsidiaryLine(row)}
                  footnote={
                    row.status === 'controlled'
                      ? `Last filed quarter: ${formatMoney(row.lastRevenueUsd)} revenue, ${formatMoney(row.lastNetIncomeUsd)} to the bottom line.`
                      : row.goodwillUsd > 0
                        ? `${formatMoney(row.goodwillUsd)} of goodwill sits on your balance sheet from this purchase.`
                        : null
                  }
                  footnoteTone="neutral"
                  targetCompanyId={row.companyId}
                  actions={row.actions}
                  onAct={(action) => act(row, action)}
                  href={row.status === 'absorbed' ? '/company' : '/markets'}
                />
              ))}
            </div>
          )}
        </Panel>
      ) : null}

      {active === 'stakes' ? (
        <Panel iconName={TAB_ICON.stakes} iconTone="brand" title="Stakes" subtitle="Minority positions on other companies' registers. Crossing 5% makes one public.">
          {portfolio.stakes.length === 0 ? (
            <EmptyState
              compact
              icon="coins"
              title="You hold no shares in anyone else"
              message="Accumulating a position starts on the Markets register. Below 5% nobody is told."
              action={
                <Link href="/markets" className="btn btn-sm tap-target sm:min-h-0">
                  Open Markets
                </Link>
              }
            />
          ) : (
            <div className="grid gap-2.5 sm:grid-cols-2">
              {portfolio.stakes.map((row) => (
                <PositionCard
                  key={row.holdingId}
                  name={row.name}
                  kindLabel={`${ownershipLabel(row.ownershipPct)} of the register`}
                  icon="coins"
                  iconTone="brand"
                  valueUsd={row.valueUsd}
                  costUsd={row.costUsd}
                  dividendsUsd={row.dividendsUsd}
                  chips={
                    <>
                      <CompanyChips sector={row.sector} region={row.region} />
                      {row.thresholdLabel === null ? null : <FactTag tone="info">{row.thresholdLabel.replace(/_/g, ' ')}</FactTag>}
                      {row.isDisclosed ? null : <FactTag tone="warn">undisclosed</FactTag>}
                    </>
                  }
                  line={stakeLine(row)}
                  footnote={lockupLine(row.lockupUntilQuarter, session.quarter)}
                  targetCompanyId={row.companyId}
                  actions={row.actions}
                  onAct={(action) => act(row, action)}
                  href="/markets"
                />
              ))}
            </div>
          )}
        </Panel>
      ) : null}

      {active === 'shorts' ? (
        <Panel iconName={TAB_ICON.shorts} iconTone="warn" title="Shorts" subtitle="Cash-settled exposure. Never a holding, never a vote, never part of an ownership percentage.">
          {portfolio.shorts.length === 0 ? (
            <EmptyState
              compact
              icon="chart"
              title="You are short of nothing"
              message="Shorting is an institutional instrument in this world: the hedge desks carry the book, and companies do not."
            />
          ) : (
            <div className="grid gap-2.5 sm:grid-cols-2">
              {portfolio.shorts.map((row) => (
                <PositionCard
                  key={row.positionId}
                  name={row.name}
                  kindLabel="Short position"
                  icon="chart"
                  iconTone="warn"
                  valueUsd={row.unrealisedUsd}
                  valueLabel="Open profit"
                  costUsd={row.marginPostedUsd}
                  dividendsUsd={null}
                  chips={
                    <>
                      <FactTag tone={row.isDisclosed ? 'info' : 'neutral'}>{row.isDisclosed ? 'disclosed' : 'below the threshold'}</FactTag>
                      <FactTag>opened {formatQuarter(session.startYear, row.openedQuarter)}</FactTag>
                    </>
                  }
                  line={shortLine(row)}
                  targetCompanyId={row.companyId}
                  href="/markets"
                />
              ))}
            </div>
          )}
        </Panel>
      ) : null}

      {active === 'funds' ? (
        <Panel iconName={TAB_ICON.funds} iconTone="info" title="Funds" subtitle="A position in an institution rather than in a company.">
          <EmptyState
            compact
            icon="vault"
            title="A company is nobody's limited partner"
            message="This world models one fund position — being a partner who runs one — and that is a person's, not a company's. Switch to the Founder view to see any you hold."
            action={
              <Link href="/street" className="btn btn-sm tap-target sm:min-h-0">
                Open The Street
              </Link>
            }
          />
        </Panel>
      ) : null}

      <PositionDrawer
        open={openRow !== null && openAction !== null}
        onClose={() => {
          setOpenRow(null);
          setOpenAction(null);
        }}
        session={session}
        view={view}
        ownCompanyId={company.id}
        row={openRow}
        action={openAction}
        hasBoard={view.board !== null}
      />
    </>
  );
}

/** Company or founder: the same projection, two subjects. */
function SeatToggle({ seat, onChange }: { readonly seat: 'company' | 'founder'; readonly onChange: (next: 'company' | 'founder') => void }): React.JSX.Element {
  return (
    <TabBar
      variant="segmented"
      ariaLabel="Whose portfolio"
      value={seat}
      onChange={(id) => onChange(id as 'company' | 'founder')}
      tabs={[
        { id: 'company', label: 'Company' },
        { id: 'founder', label: 'Founder' },
      ]}
    />
  );
}
