'use client';

/**
 * Command Centre — the screen a returning founder reads first.
 *
 * Quarter, company, the eight figures that decide whether anything else
 * matters, the world you are exposed to, and everything currently asking for an
 * answer. Every number is committed state or documented arithmetic over it;
 * every alert links to the screen that resolves it.
 *
 * **Portrait first.** On a phone the screen reads straight down in the order a
 * player checks things: the floor, the eight figures two-up, what is asking for
 * an answer, the tape, the objectives, then the world and the jump-off cards.
 * From `lg` the same blocks fall into the two-thirds / one-third split the
 * desktop layout has always had.
 */

import Link from 'next/link';
import { useMemo, useState } from 'react';
import type { ObjectiveMetric } from '@frontier/contracts';
import { quarterLabel } from '@frontier/contracts';
import { formatMoney, formatPct, formatQuarterCount, formatScore } from '@frontier/shared';
import {
  EmptyState,
  Icon,
  PageHeader,
  Panel,
  ProgressBar,
  StatCard,
  Tag,
  type IconName,
} from '@/components/ui';
import {
  useCompanyMetrics,
  useConnection,
  useGame,
  useMarketCap,
  usePlayerCharacter,
  usePlayerCompany,
  usePlayerView,
  useQueuedActions,
  useQuotes,
  useSession,
} from '@/lib/game';
import { OfficeSceneCompact } from '@/components/scenes/office';
import { AlertFeed } from '@/components/screens/command-centre/AlertFeed';
import { TapeStrip } from '@/components/screens/command-centre/TapeStrip';
import { WorldStrip } from '@/components/screens/command-centre/WorldStrip';
import { buildFeed } from '@/components/screens/command-centre/feed';
import { answerableCount, buyoutOf, offerInbox, termSheetOf } from '@/components/screens/street';
import { headcountOf, humanise } from '@/components/screens/reporting/util';

/** Objective metrics measured in units rather than dollars. */
const COUNT_METRICS: readonly ObjectiveMetric[] = ['connection_level', 'board_seats', 'tech_nodes_achieved', 'survive_quarters'];

/** An objective's current standing against its target, in the metric's own units. */
function objectiveReading(metric: ObjectiveMetric, current: number, target: number): string {
  if (metric === 'ownership_of_rival') return `${formatPct(current)} of ${formatPct(target)}`;
  if (COUNT_METRICS.includes(metric)) return `${formatScore(current)} of ${formatScore(target)}`;
  if (Math.abs(target) < 1000) return `${formatMoney(current)} · target ${formatMoney(target)}`;
  return `${formatMoney(current)} of ${formatMoney(target)}`;
}

const QUICK_LINKS: readonly { href: string; label: string; blurb: string; icon: IconName }[] = [
  { href: '/financials', label: 'Financials', blurb: 'P&L, balance sheet, cash flow', icon: 'ledger' },
  { href: '/markets', label: 'Markets', blurb: 'Tape, anchors, return decomposition', icon: 'chart' },
  { href: '/capital', label: 'Capital', blurb: 'Cap table, rounds, treasury', icon: 'coins' },
  { href: '/street', label: 'The Street', blurb: 'Institutions, offers, short books', icon: 'briefcase' },
  { href: '/leaderboard', label: 'Leaderboard', blurb: 'Ten boards and the power graph', icon: 'trophy' },
  { href: '/news', label: 'News', blurb: 'The public record', icon: 'newspaper' },
  { href: '/end-quarter', label: 'End Quarter', blurb: 'Review and lock the submission', icon: 'stamp' },
];

export default function CommandCentrePage(): React.JSX.Element {
  const session = useSession();
  const view = usePlayerView();
  const company = usePlayerCompany();
  const founder = usePlayerCharacter();
  const metrics = useCompanyMetrics();
  const marketCap = useMarketCap();
  const connection = useConnection();
  const queued = useQueuedActions();
  const { previousWorld, lastOutcome } = useGame();
  // With no instrument id `useQuotes()` returns the whole tape, so a private
  // company is given an empty series rather than everyone else's prices.
  const tape = useQuotes(company.instrumentId ?? undefined);
  const ownQuotes = company.instrumentId === null ? [] : tape;

  // The world panel is ten readings deep. On a phone that is a screenful of
  // detail sitting between the tape and the jump-off cards, so it collapses to
  // its own heading until asked for. From `lg` it is simply open.
  const [worldOpen, setWorldOpen] = useState(false);

  const blocked = queued.filter((entry) => entry.blocked).length;
  const feed = useMemo(() => buildFeed(session, view, lastOutcome, blocked), [session, view, lastOutcome, blocked]);

  // Capital offered to this company, and approaches made for it. Read from the
  // same committed deals and campaigns The Street reads; the count is the one
  // number a returning founder needs before they open the screen.
  const offers = useMemo(
    () =>
      offerInbox({
        deals: view.deals,
        campaigns: session.activistCampaigns ?? [],
        companyIds: new Set([company.id]),
        quarter: session.quarter,
      }),
    [view.deals, session.activistCampaigns, session.quarter, company.id],
  );
  const offersToAnswer = answerableCount(offers);

  const listed = company.instrumentId !== null && ownQuotes.length > 0;
  const lastQuote = ownQuotes.length === 0 ? null : ownQuotes[ownQuotes.length - 1] ?? null;

  const openingCash = company.financials.cash - company.financials.quarterlyBurn;
  const cashDelta = openingCash > 0 ? company.financials.quarterlyBurn / openingCash : null;
  const runway = metrics?.runwayQuarters ?? null;
  const headcount = headcountOf(company);
  const seat = session.players.find((player) => player.playerId === view.playerId) ?? null;

  return (
    <>
      <PageHeader
        title="Command Centre"
        eyebrow={`${quarterLabel(session.startYear, session.quarter)} · ${company.name}`}
        subtitle={`${humanise(company.archetype)} · ${humanise(company.sectorId)} · ${company.headquartersCity} · posture ${humanise(company.posture).toLowerCase()}`}
        actions={
          <>
            <Link href="/chief-of-staff" className="btn tap-target flex-1 gap-1.5 sm:flex-none">
              <Icon name="briefcase" size={16} accent="current" />
              Chief of Staff
            </Link>
            <Link href="/end-quarter" className="btn btn-primary tap-target flex-1 gap-1.5 sm:flex-none">
              <Icon name="stamp" size={16} accent="current" />
              End quarter{queued.length > 0 ? ` (${queued.length})` : ''}
            </Link>
          </>
        }
      />

      {/* --- the office, then the eight figures --------------------------------
          The scene takes the hero slot above (phone) or beside (desktop) the
          stat cards: the company as a place — headcount, the mood on the floor,
          the glow off the racks — before the company as a set of numbers. It is
          a link, not a control surface; the Company screen is where the rooms
          are operable. The figures sit two-up on a phone: eight full-width
          cards is eight screenfuls of scrolling for eight numbers. */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Panel
          title="The floor"
          subtitle={`${company.name} · ${company.headquartersCity}`}
          iconName="building"
          iconTone="brand"
          className="col-span-2 lg:row-span-2"
          actions={
            <Link href="/company" className="btn btn-ghost tap-target gap-1.5 px-2">
              <Icon name="building" size={15} accent="current" />
              Open office
            </Link>
          }
        >
          <OfficeSceneCompact href="/company" />
        </Panel>

        <StatCard
          label="Market cap"
          iconName="chart"
          value={formatMoney(marketCap)}
          delta={listed && lastQuote !== null ? lastQuote.return : undefined}
          spark={listed ? ownQuotes.map((quote) => quote.price) : undefined}
          hint={listed ? 'Last traded close' : 'Private — fundamental anchor'}
          href="/markets"
        />
        <StatCard
          label="Revenue"
          iconName="coins"
          value={formatMoney(company.financials.revenueQuarterly)}
          delta={metrics === null ? undefined : metrics.revenueGrowthYoY}
          hint={metrics === null ? 'This quarter' : `Year on year · ${formatMoney(metrics.revenueTtm)} trailing`}
          href="/financials"
        />
        <StatCard
          label="Cash"
          iconName="vault"
          value={formatMoney(company.financials.cash)}
          delta={cashDelta ?? undefined}
          tone={company.financials.cash <= 0 ? 'loss' : undefined}
          hint={`Quarterly movement ${formatMoney(company.financials.quarterlyBurn)}`}
          href="/capital"
        />
        <StatCard
          label="Runway"
          iconName="gauge"
          value={runway === null ? '—' : formatQuarterCount(runway)}
          tone={runway === null ? undefined : runway < 3 ? 'loss' : runway < 6 ? 'warn' : undefined}
          hint={runway === null ? 'Computed at the first resolution' : 'At the current burn'}
          href="/capital"
        />

        <StatCard
          label="Employees"
          iconName="people"
          value={formatScore(headcount)}
          hint={`${company.employees.openRoles} open roles · morale ${Math.round(company.employees.morale)}`}
          href="/people"
        />
        <StatCard
          label="Connection"
          iconName="network"
          value={formatScore(connection)}
          tone={connection >= 70 ? 'gain' : connection < 30 ? 'warn' : undefined}
          hint={`${founder.name} · ${founder.boardSeatCount} board seat${founder.boardSeatCount === 1 ? '' : 's'}`}
          href="/network"
        />
        <StatCard
          label="Gov. rating"
          iconName="capitol"
          value={formatScore(company.governmentPastPerformance)}
          hint="Procurement past performance, 0–100"
          href="/government"
        />
        <StatCard
          label="Gross margin"
          iconName="ledger"
          value={metrics === null ? '—' : formatPct(metrics.grossMarginPct)}
          hint={metrics === null ? 'Computed at the first resolution' : `Operating margin ${formatPct(metrics.operatingMarginPct)}`}
          href="/financials"
        />
      </div>

      {/* --- what is asking for an answer, then the context --------------------
          DOM order is the phone's reading order: today, tape, objectives, then
          the world, the clock and the jump-off cards. From `lg` the first three
          take two thirds and the rest take the last third. */}
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="flex min-w-0 flex-col gap-4 lg:col-span-2">
          <Panel
            title="Today"
            iconName="bell"
            iconTone={blocked > 0 ? 'warn' : 'neutral'}
            subtitle="Everything in committed state that is currently asking for an answer."
            actions={<Tag tone={blocked > 0 ? 'warn' : 'neutral'}>{feed.length === 1 ? '1 line' : `${feed.length} lines`}</Tag>}
          >
            <AlertFeed items={feed} />
          </Panel>

          {/* --- the offers inbox ------------------------------------------
              A count and the top three, with the whole list one tap away. It
              is absent in a session with no institutional layer, and absent in
              a quarter with nothing on the table: an empty inbox panel would be
              a heading with nothing under it. */}
          {offers.length === 0 ? null : (
            <Panel
              title="Offers"
              iconName="briefcase"
              iconTone={offersToAnswer > 0 ? 'warn' : 'neutral'}
              subtitle="Capital offered to you, and approaches made for you. An offer made this quarter is answerable next."
              actions={
                <Link href="/street" className="btn btn-ghost tap-target gap-1.5 px-2">
                  <Icon name="briefcase" size={15} accent="current" />
                  Open The Street
                </Link>
              }
            >
              <ul className="flex flex-col gap-2">
                {offers.slice(0, 3).map((offer) => {
                  const sheet = offer.deal === null ? null : termSheetOf(offer.deal);
                  const buyout = offer.deal === null ? null : buyoutOf(offer.deal);
                  return (
                    <li key={offer.id} className="raised-surface flex flex-wrap items-baseline justify-between gap-2 px-2.5 py-2">
                      <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink">
                        {sheet === null
                          ? buyout === null
                            ? 'An activist campaign is open against you'
                            : `An approach at ${formatMoney(buyout.offerValueUsd)}, ${buyout.premiumPct}% over the mark`
                          : `${formatMoney(sheet.amountUsd)} at ${formatMoney(sheet.preMoneyUsd)} pre-money for ${sheet.dilutionPct}%`}
                      </span>
                      <Tag tone={offer.isAnswerable ? 'warn' : 'neutral'} dot>
                        {offer.isAnswerable ? 'answer now' : `from ${quarterLabel(session.startYear, offer.answerableFromQuarter)}`}
                      </Tag>
                    </li>
                  );
                })}
              </ul>
              {offers.length > 3 ? (
                <p className="mt-2 text-[11px] text-ink-faint">{offers.length - 3} more on The Street.</p>
              ) : null}
            </Panel>
          )}

          <Panel
            title="Tape"
            iconName="chart"
            subtitle="Your company and the largest listed names."
            actions={
              <Link href="/markets" className="btn btn-ghost tap-target gap-1.5 px-2">
                <Icon name="chart" size={15} accent="current" />
                Open markets
              </Link>
            }
            flush
          >
            <TapeStrip session={session} view={view} />
          </Panel>

          <Panel title="Objectives" iconName="trophy" subtitle="Explicit goals. There is no fixed victory screen.">
            {view.objectives.length === 0 ? (
              <EmptyState compact icon="trophy" title="No objectives set" message="This session was created without explicit objectives." />
            ) : (
              <div className="flex flex-col gap-3.5">
                {view.objectives.map((objective) => (
                  <div key={objective.id}>
                    <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5">
                      <span className="text-[13px] font-medium text-ink">{objective.label}</span>
                      <span className="figure text-[11.5px] text-ink-dim">
                        {objectiveReading(objective.metric, objective.currentValue, objective.targetValue)}
                      </span>
                    </div>
                    <p className="mt-0.5 text-[11.5px] text-ink-faint">{objective.description}</p>
                    <ProgressBar
                      className="mt-1.5"
                      value={objective.progress}
                      tone={objective.completedQuarter !== null ? 'gain' : 'brand'}
                      valueLabel={formatPct(objective.progress)}
                    />
                  </div>
                ))}
              </div>
            )}
          </Panel>
        </div>

        <div className="flex min-w-0 flex-col gap-4">
          <Panel
            title="World"
            iconName="globe"
            iconTone="info"
            subtitle="The readings this company is exposed to."
            actions={
              <button
                type="button"
                onClick={() => setWorldOpen((open) => !open)}
                aria-expanded={worldOpen}
                className="btn btn-ghost tap-target gap-1.5 px-2 lg:hidden"
              >
                {worldOpen ? 'Hide' : 'Show ten readings'}
                <span className={worldOpen ? 'rotate-180' : ''}>
                  <Icon name="chevronDown" size={14} accent="current" />
                </span>
              </button>
            }
          >
            <div className={worldOpen ? '' : 'hidden lg:block'}>
              <WorldStrip world={view.world} previous={previousWorld} />
            </div>
            {worldOpen ? null : (
              <p className="text-[12px] text-ink-faint lg:hidden">
                Rates, risk appetite, compute supply, regulation and the dominant narrative — ten readings that price this quarter.
              </p>
            )}
          </Panel>

          <Panel title="Quarter clock" iconName="stamp">
            <dl className="flex flex-col gap-2">
              <div className="flex items-baseline justify-between gap-3">
                <dt className="label-caps-faint">Open quarter</dt>
                <dd className="figure text-[12.5px] text-ink">{quarterLabel(session.startYear, session.quarter)}</dd>
              </div>
              <div className="flex items-baseline justify-between gap-3">
                <dt className="label-caps-faint">Last resolved</dt>
                <dd className="figure text-[12.5px] text-ink-dim">
                  {session.lastResolvedQuarter === null ? 'None yet' : quarterLabel(session.startYear, session.lastResolvedQuarter)}
                </dd>
              </div>
              <div className="flex items-baseline justify-between gap-3">
                <dt className="label-caps-faint">Session</dt>
                <dd className="text-[12.5px] text-ink-dim">
                  <Tag tone={session.status === 'active' ? 'gain' : 'warn'} dot>
                    {session.status}
                  </Tag>
                </dd>
              </div>
              <div className="flex items-baseline justify-between gap-3">
                <dt className="label-caps-faint">Submission</dt>
                <dd className="text-[12.5px]">
                  <Tag tone={seat?.hasSubmittedThisQuarter === true ? 'gain' : 'neutral'} dot>
                    {seat?.hasSubmittedThisQuarter === true ? 'Locked' : 'Open for planning'}
                  </Tag>
                </dd>
              </div>
              <div className="flex items-baseline justify-between gap-3">
                <dt className="label-caps-faint">Queued</dt>
                <dd className="figure text-[12.5px] text-ink">
                  {queued.length}
                  {blocked > 0 ? <span className="tone-warn"> · {blocked} unconfirmed</span> : null}
                </dd>
              </div>
            </dl>
          </Panel>
        </div>
      </div>

      {/* --- where to go next --------------------------------------------------
          Last on a phone because it is the thing you reach for after reading,
          and a full-width strip on a desktop because six cards across three
          columns balance the page better than six stacked in the last third. */}
      <Panel title="Go to" iconName="compass">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {QUICK_LINKS.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="raised-surface icon-knockout-raised press-pop tap-target flex items-center gap-2.5 px-3 py-2 transition-colors hover:border-hair-strong"
            >
              <span className="flex size-8 shrink-0 items-center justify-center rounded-chip bg-panel text-ink-dim shadow-card">
                <Icon name={link.icon} size={17} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-medium text-ink">{link.label}</span>
                <span className="block truncate text-[11px] text-ink-faint">{link.blurb}</span>
              </span>
              <span className="shrink-0 text-ink-faint">
                <Icon name="chevronRight" size={14} accent="current" />
              </span>
            </Link>
          ))}
        </div>
      </Panel>
    </>
  );
}
