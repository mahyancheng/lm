'use client';

/**
 * Leaderboard — ten boards and the power network.
 *
 * Success in this game is plural, and this screen is where that is made
 * legible: a technically brilliant company can lose financially, a rich founder
 * can lose control, and a small company can become indispensable to
 * governments. Rank movement is shown against last quarter, percentile beside
 * raw value, and the composite is broken into the eight weighted inputs so a
 * player can see which dimension is holding them back.
 */

import { useMemo, useState } from 'react';
import type { LeaderboardBoard, LeaderboardEntry } from '@frontier/contracts';
import { LEADERBOARD_BOARDS, quarterLabel } from '@frontier/contracts';
import { formatDelta, formatMoney, formatRankMove, formatScore } from '@frontier/shared';
import {
  CompanyChip,
  DataTable,
  EmptyState,
  PageHeader,
  Panel,
  PersonChip,
  ProgressBar,
  StatCard,
  TabBar,
  Tag,
  cx,
  type Column,
} from '@/components/ui';
import { usePlayerCharacter, usePlayerCompany, usePlayerView, useSession } from '@/lib/game';
import { FounderIndexPanel } from '@/components/screens/leaderboard/FounderIndexPanel';
import { PowerGraph } from '@/components/screens/leaderboard/PowerGraph';
import { humanise } from '@/components/screens/reporting/util';

type Units = 'money' | 'score' | 'index';

const BOARD_LABEL: Readonly<Record<LeaderboardBoard, string>> = {
  company_value: 'Company value',
  founder_wealth: 'Founder wealth',
  revenue: 'Revenue',
  profit: 'Profit',
  innovation: 'Innovation',
  market_influence: 'Market influence',
  network: 'Network',
  government: 'Government',
  reputation: 'Reputation',
  founder_index: 'Founder Index',
};

const BOARD_UNITS: Readonly<Record<LeaderboardBoard, Units>> = {
  company_value: 'money',
  founder_wealth: 'money',
  revenue: 'money',
  profit: 'money',
  innovation: 'score',
  market_influence: 'money',
  network: 'score',
  government: 'score',
  reputation: 'score',
  founder_index: 'index',
};

const BOARD_BLURB: Readonly<Record<LeaderboardBoard, string>> = {
  company_value: 'Controlled enterprise value, as the engine estimates it.',
  founder_wealth: 'Personal net worth: cash plus the marked value of every holding.',
  revenue: 'Trailing revenue, annualised where a company has less than a year of history.',
  profit: 'Operating result for the quarter: revenue less cost of revenue and operating expense.',
  innovation: 'Frontier nodes demonstrated, capability breadth and live programmes.',
  market_influence: 'Half your own value plus the full value of every stake you hold in someone else.',
  network: 'Connection level: institutional and social power, not follower count.',
  government: 'Formal past performance plus what is actually on contract.',
  reputation: 'The plain mean of the five audience reputations.',
  founder_index: 'The composite. Eight percentiles, weighted; never raw dollars.',
};

function formatValue(units: Units, value: number): string {
  if (units === 'money') return formatMoney(value);
  if (units === 'index') return formatScore(value * 100, 1);
  return formatScore(value, 1);
}

function formatValueDelta(units: Units, value: number): string {
  if (units === 'money') return formatDelta(value, 'money');
  if (units === 'index') return formatDelta(value * 100, 'number', 1);
  return formatDelta(value, 'number', 1);
}

export default function LeaderboardPage(): React.JSX.Element {
  const session = useSession();
  const view = usePlayerView();
  const company = usePlayerCompany();
  const founder = usePlayerCharacter();
  const [board, setBoard] = useState<LeaderboardBoard>('founder_index');

  const boards = session.leaderboards;
  const active = boards.find((entry) => entry.board === board) ?? null;
  const units = BOARD_UNITS[board];

  const mine = useMemo(() => new Set([company.id, founder.id, view.playerId]), [company.id, founder.id, view.playerId]);

  const headline = useMemo(() => {
    const composite = boards.find((entry) => entry.board === 'founder_index')?.entries.find((row) => row.subjectId === founder.id) ?? null;
    const value = boards.find((entry) => entry.board === 'company_value')?.entries.find((row) => row.subjectId === company.id) ?? null;
    const wealth = boards.find((entry) => entry.board === 'founder_wealth')?.entries.find((row) => row.subjectId === founder.id) ?? null;
    const network = boards.find((entry) => entry.board === 'network')?.entries.find((row) => row.subjectId === founder.id) ?? null;
    return { composite, value, wealth, network };
  }, [boards, company.id, founder.id]);

  const columns: readonly Column<LeaderboardEntry>[] = [
    {
      key: 'rank',
      header: '#',
      width: '52px',
      align: 'right',
      render: (row) => <span className={cx('figure', mine.has(row.subjectId) ? 'text-brand' : 'text-ink')}>{row.rank}</span>,
      sortable: true,
      sortValue: (row) => row.rank,
    },
    {
      key: 'move',
      header: 'Move',
      width: '84px',
      render: (row) => {
        const move = formatRankMove(row.previousRank, row.rank);
        if (move === null) return <span className="text-[10px] text-ink-faint">held</span>;
        if (move === 'new') return <Tag tone="info">new</Tag>;
        const improved = row.previousRank !== null && row.previousRank > row.rank;
        return (
          <span className={cx('figure text-[11px]', improved ? 'tone-gain' : 'tone-loss')}>
            {improved ? '▲' : '▼'} {move}
          </span>
        );
      },
      hideOnMobile: true,
    },
    {
      key: 'subject',
      header: 'Subject',
      render: (row) =>
        row.subjectKind === 'character' ? (
          <PersonChip
            size="sm"
            character={{ id: row.subjectId, name: row.label, isPlayer: row.subjectId === founder.id }}
            subtitle={row.subjectId === founder.id ? 'You' : undefined}
          />
        ) : (
          <CompanyChip size="sm" own={row.subjectId === company.id} company={{ id: row.subjectId, name: row.label }} />
        ),
      sortable: true,
      sortValue: (row) => row.label,
    },
    {
      key: 'value',
      header: 'Value',
      align: 'right',
      render: (row) => formatValue(units, row.value),
      sortable: true,
      sortValue: (row) => row.value,
    },
    {
      key: 'delta',
      header: 'Change',
      align: 'right',
      render: (row) => (
        <span className={cx('figure text-[11px]', row.delta > 0 ? 'tone-gain' : row.delta < 0 ? 'tone-loss' : 'text-ink-faint')}>
          {row.delta === 0 ? '—' : formatValueDelta(units, row.delta)}
        </span>
      ),
      sortable: true,
      sortValue: (row) => row.delta,
      hideOnMobile: true,
    },
    {
      key: 'percentile',
      header: 'Percentile',
      width: '140px',
      render: (row) => (
        <span className="flex items-center gap-2">
          <ProgressBar className="w-16" value={row.percentile} tone={row.percentile >= 0.66 ? 'gain' : row.percentile >= 0.33 ? 'info' : 'warn'} height={4} />
          <span className="figure text-[10px] text-ink-faint">{formatScore(row.percentile * 100, 0)}</span>
        </span>
      ),
      sortable: true,
      sortValue: (row) => row.percentile,
    },
  ];

  return (
    <>
      <PageHeader
        title="Leaderboard"
        eyebrow={`${quarterLabel(session.startYear, session.quarter)} · ${boards.length} of ${LEADERBOARD_BOARDS.length} boards computed`}
        subtitle="Ten independent rankings and the composite that sits on top of them. Every figure is recomputed server-side from the ledger."
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Founder Index"
          value={headline.composite === null ? '—' : formatScore(headline.composite.value * 100, 1)}
          hint={headline.composite === null ? 'Computed at the first resolution' : `Rank #${headline.composite.rank} of ${boards.find((entry) => entry.board === 'founder_index')?.entries.length ?? 0}`}
          delta={headline.composite === null ? undefined : headline.composite.delta * 100}
          deltaFormat="number"
        />
        <StatCard
          label="Company value"
          value={headline.value === null ? '—' : formatMoney(headline.value.value)}
          hint={headline.value === null ? 'Computed at the first resolution' : `Rank #${headline.value.rank}`}
          delta={headline.value === null ? undefined : headline.value.delta}
          deltaFormat="money"
        />
        <StatCard
          label="Founder wealth"
          value={headline.wealth === null ? '—' : formatMoney(headline.wealth.value)}
          hint={headline.wealth === null ? 'Computed at the first resolution' : `Rank #${headline.wealth.rank}`}
          delta={headline.wealth === null ? undefined : headline.wealth.delta}
          deltaFormat="money"
        />
        <StatCard
          label="Network"
          value={headline.network === null ? '—' : formatScore(headline.network.value, 0)}
          hint={headline.network === null ? 'Computed at the first resolution' : `Rank #${headline.network.rank}`}
          delta={headline.network === null ? undefined : headline.network.delta}
          deltaFormat="number"
          href="/network"
        />
      </div>

      <TabBar
        ariaLabel="Leaderboards"
        tabs={LEADERBOARD_BOARDS.map((entry) => ({
          id: entry,
          label: BOARD_LABEL[entry],
          badge: boards.find((item) => item.board === entry)?.entries.length,
        }))}
        value={board}
        onChange={(id) => setBoard(id as LeaderboardBoard)}
      />

      <Panel
        title={BOARD_LABEL[board]}
        subtitle={BOARD_BLURB[board]}
        flush
        actions={active === null ? undefined : <Tag tone="neutral">{quarterLabel(session.startYear, active.quarter)}</Tag>}
      >
        {active === null ? (
          <EmptyState
            glyph="LB"
            title="Rankings are computed when a quarter resolves"
            message="Leaderboards are rebuilt from state in the sixteenth phase of every resolution, and the client can never submit a score. Queue your instructions and end the quarter."
          />
        ) : (
          <DataTable
            columns={columns}
            rows={active.entries}
            rowKey={(row) => `${board}_${row.subjectId}`}
            isHighlighted={(row) => mine.has(row.subjectId)}
            dense
            initialSort={{ key: 'rank', direction: 'asc' }}
          />
        )}
      </Panel>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Founder Index decomposition" subtitle="Eight weighted percentiles, and the arithmetic that produced the composite.">
          <FounderIndexPanel session={session} view={view} founderId={founder.id} founderName={founder.name} companyId={company.id} />
        </Panel>

        <Panel title="Board summary" subtitle="Where you stand on every board at once.">
          {boards.length === 0 ? (
            <EmptyState compact title="No boards yet" message="They appear together after the first resolution." />
          ) : (
            <div className="flex flex-col gap-2">
              {LEADERBOARD_BOARDS.map((name) => {
                const item = boards.find((entry) => entry.board === name) ?? null;
                const row =
                  item === null ? null : item.entries.find((entry) => mine.has(entry.subjectId)) ?? null;
                return (
                  <button
                    key={name}
                    type="button"
                    onClick={() => setBoard(name)}
                    className={cx(
                      'flex w-full items-center justify-between gap-3 rounded-chip border-b border-hair px-2 py-2 text-left transition-colors hover:bg-raised',
                      board === name ? 'bg-raised' : '',
                    )}
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-[12px] text-ink">{BOARD_LABEL[name]}</span>
                      <span className="block truncate text-[10px] text-ink-faint">{humanise(name)}</span>
                    </span>
                    <span className="flex shrink-0 items-center gap-3">
                      <span className="figure text-[11px] text-ink-dim">
                        {row === null ? '—' : formatValue(BOARD_UNITS[name], row.value)}
                      </span>
                      <span className={cx('figure w-10 text-right text-[12px]', row === null ? 'text-ink-faint' : 'text-ink')}>
                        {row === null ? '—' : `#${row.rank}`}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </Panel>
      </div>

      <Panel
        title="Industry power"
        subtitle="Disclosed stakes, board seats and deals. Deterministic layout: the same state always draws the same graph."
      >
        <PowerGraph session={session} view={view} />
      </Panel>
    </>
  );
}
