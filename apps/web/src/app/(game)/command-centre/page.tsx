'use client';

/**
 * Command Centre — the screen a returning founder reads first.
 *
 * Quarter, company, the eight figures that decide whether anything else
 * matters, the world you are exposed to, and everything currently asking for an
 * answer. Every number is committed state or documented arithmetic over it;
 * every alert links to the screen that resolves it.
 */

import Link from 'next/link';
import { useMemo } from 'react';
import type { ObjectiveMetric } from '@frontier/contracts';
import { quarterLabel } from '@frontier/contracts';
import { formatMoney, formatPct, formatQuarterCount, formatScore } from '@frontier/shared';
import {
  EmptyState,
  PageHeader,
  Panel,
  ProgressBar,
  StatCard,
  Tag,
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
import { AlertFeed } from '@/components/screens/command-centre/AlertFeed';
import { TapeStrip } from '@/components/screens/command-centre/TapeStrip';
import { WorldStrip } from '@/components/screens/command-centre/WorldStrip';
import { buildFeed } from '@/components/screens/command-centre/feed';
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

const QUICK_LINKS = [
  { href: '/financials', label: 'Financials', blurb: 'P&L, balance sheet, cash flow' },
  { href: '/markets', label: 'Markets', blurb: 'Tape, anchors, return decomposition' },
  { href: '/capital', label: 'Capital', blurb: 'Cap table, rounds, treasury' },
  { href: '/leaderboard', label: 'Leaderboard', blurb: 'Ten boards and the power graph' },
  { href: '/news', label: 'News', blurb: 'The public record' },
  { href: '/end-quarter', label: 'End Quarter', blurb: 'Review and lock the submission' },
] as const;

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

  const blocked = queued.filter((entry) => entry.blocked).length;
  const feed = useMemo(() => buildFeed(session, view, lastOutcome, blocked), [session, view, lastOutcome, blocked]);

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
            <Link href="/chief-of-staff" className="btn btn-sm">
              Chief of Staff
            </Link>
            <Link href="/end-quarter" className="btn btn-sm btn-primary">
              End quarter{queued.length > 0 ? ` (${queued.length})` : ''}
            </Link>
          </>
        }
      />

      {/* --- the eight figures ------------------------------------------------ */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Market cap"
          value={formatMoney(marketCap)}
          delta={listed && lastQuote !== null ? lastQuote.return : undefined}
          spark={listed ? ownQuotes.map((quote) => quote.price) : undefined}
          hint={listed ? 'Last traded close' : 'Private — fundamental anchor'}
          href="/markets"
        />
        <StatCard
          label="Revenue"
          value={formatMoney(company.financials.revenueQuarterly)}
          delta={metrics === null ? undefined : metrics.revenueGrowthYoY}
          hint={metrics === null ? 'This quarter' : `Year on year · ${formatMoney(metrics.revenueTtm)} trailing`}
          href="/financials"
        />
        <StatCard
          label="Cash"
          value={formatMoney(company.financials.cash)}
          delta={cashDelta ?? undefined}
          tone={company.financials.cash <= 0 ? 'loss' : undefined}
          hint={`Quarterly movement ${formatMoney(company.financials.quarterlyBurn)}`}
          href="/capital"
        />
        <StatCard
          label="Runway"
          value={runway === null ? '—' : formatQuarterCount(runway)}
          tone={runway === null ? undefined : runway < 3 ? 'loss' : runway < 6 ? 'warn' : undefined}
          hint={runway === null ? 'Computed at the first resolution' : 'At the current burn'}
          href="/capital"
        />

        <StatCard
          label="Employees"
          value={formatScore(headcount)}
          hint={`${company.employees.openRoles} open roles · morale ${Math.round(company.employees.morale)}`}
          href="/people"
        />
        <StatCard
          label="Connection"
          value={formatScore(connection)}
          tone={connection >= 70 ? 'gain' : connection < 30 ? 'warn' : undefined}
          hint={`${founder.name} · ${founder.boardSeatCount} board seat${founder.boardSeatCount === 1 ? '' : 's'}`}
          href="/network"
        />
        <StatCard
          label="Gov. rating"
          value={formatScore(company.governmentPastPerformance)}
          hint="Procurement past performance, 0–100"
          href="/government"
        />
        <StatCard
          label="Gross margin"
          value={metrics === null ? '—' : formatPct(metrics.grossMarginPct)}
          hint={metrics === null ? 'Computed at the first resolution' : `Operating margin ${formatPct(metrics.operatingMarginPct)}`}
          href="/financials"
        />
      </div>

      {/* --- feed, world, tape ------------------------------------------------ */}
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="flex min-w-0 flex-col gap-4 lg:col-span-2">
          <Panel
            title="Today"
            subtitle="Everything in committed state that is currently asking for an answer."
            actions={<Tag tone={blocked > 0 ? 'warn' : 'neutral'}>{feed.length === 1 ? '1 line' : `${feed.length} lines`}</Tag>}
          >
            <AlertFeed items={feed} />
          </Panel>

          <Panel title="Tape" subtitle="Your company and the largest listed names." actions={<Link href="/markets" className="btn btn-ghost btn-sm">Open markets</Link>}>
            <TapeStrip session={session} view={view} />
          </Panel>
        </div>

        <div className="flex min-w-0 flex-col gap-4">
          <Panel title="World" subtitle="The readings this company is exposed to.">
            <WorldStrip world={view.world} previous={previousWorld} />
          </Panel>

          <Panel title="Quarter clock">
            <dl className="flex flex-col gap-1.5">
              <div className="flex items-baseline justify-between gap-3">
                <dt className="label-caps-faint">Open quarter</dt>
                <dd className="figure text-[12px] text-ink">{quarterLabel(session.startYear, session.quarter)}</dd>
              </div>
              <div className="flex items-baseline justify-between gap-3">
                <dt className="label-caps-faint">Last resolved</dt>
                <dd className="figure text-[12px] text-ink-dim">
                  {session.lastResolvedQuarter === null ? 'None yet' : quarterLabel(session.startYear, session.lastResolvedQuarter)}
                </dd>
              </div>
              <div className="flex items-baseline justify-between gap-3">
                <dt className="label-caps-faint">Session</dt>
                <dd className="text-[12px] text-ink-dim">
                  <Tag tone={session.status === 'active' ? 'gain' : 'warn'} dot>
                    {session.status}
                  </Tag>
                </dd>
              </div>
              <div className="flex items-baseline justify-between gap-3">
                <dt className="label-caps-faint">Submission</dt>
                <dd className="text-[12px]">
                  <Tag tone={seat?.hasSubmittedThisQuarter === true ? 'gain' : 'neutral'} dot>
                    {seat?.hasSubmittedThisQuarter === true ? 'Locked' : 'Open for planning'}
                  </Tag>
                </dd>
              </div>
              <div className="flex items-baseline justify-between gap-3">
                <dt className="label-caps-faint">Queued</dt>
                <dd className="figure text-[12px] text-ink">
                  {queued.length}
                  {blocked > 0 ? <span className="tone-warn"> · {blocked} unconfirmed</span> : null}
                </dd>
              </div>
            </dl>
          </Panel>
        </div>
      </div>

      {/* --- objectives and quick links --------------------------------------- */}
      <div className="grid gap-4 lg:grid-cols-3">
        <Panel title="Objectives" className="lg:col-span-2" subtitle="Explicit goals. There is no fixed victory screen.">
          {view.objectives.length === 0 ? (
            <EmptyState compact title="No objectives set" message="This session was created without explicit objectives." />
          ) : (
            <div className="flex flex-col gap-3">
              {view.objectives.map((objective) => (
                <div key={objective.id}>
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="text-[12px] font-medium text-ink">{objective.label}</span>
                    <span className="figure text-[11px] text-ink-dim">{objectiveReading(objective.metric, objective.currentValue, objective.targetValue)}</span>
                  </div>
                  <p className="mt-0.5 text-[11px] text-ink-faint">{objective.description}</p>
                  <ProgressBar
                    className="mt-1.5"
                    value={objective.progress}
                    tone={objective.completedQuarter !== null ? 'gain' : 'brand'}
                    valueLabel={formatPct(objective.progress, 0)}
                  />
                </div>
              ))}
            </div>
          )}
        </Panel>

        <Panel title="Go to">
          <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2 lg:grid-cols-1">
            {QUICK_LINKS.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className="raised-surface flex items-center justify-between gap-2 px-2.5 py-1.5 transition-colors hover:border-hair-strong"
              >
                <span className="min-w-0">
                  <span className="block truncate text-[12px] text-ink">{link.label}</span>
                  <span className="block truncate text-[10px] text-ink-faint">{link.blurb}</span>
                </span>
                <span className="shrink-0 text-[11px] text-ink-faint">→</span>
              </Link>
            ))}
          </div>
        </Panel>
      </div>
    </>
  );
}
