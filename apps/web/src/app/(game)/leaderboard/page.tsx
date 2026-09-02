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
import type { LeaderboardBoard, LeaderboardEntry, Sector } from '@frontier/contracts';
import { LEADERBOARD_BOARDS, SECTOR_META, quarterLabel } from '@frontier/contracts';
import { formatDelta, formatMoney, formatRankMove, formatScore } from '@frontier/shared';
import {
  CompanyChip,
  DataTable,
  EmptyState,
  Icon,
  PageHeader,
  Panel,
  PersonChip,
  ProgressBar,
  SectorBadge,
  SectorFilter,
  StatCard,
  Tag,
  cx,
  sectorOf,
  sectorsPresent,
  type Column,
  type IconName,
} from '@/components/ui';
import { usePlayerCharacter, usePlayerCompany, usePlayerView, useSession } from '@/lib/game';
import { FounderIndexPanel } from '@/components/screens/leaderboard/FounderIndexPanel';
import { PowerGraph } from '@/components/screens/leaderboard/PowerGraph';
import { IconTabs } from '@/components/screens/world/IconTabs';
import { allVisibleCompanies, humanise } from '@/components/screens/reporting/util';

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

/**
 * The mark for each board.
 *
 * Ten boards are ten similar phrases in a strip; they are ten distinct shapes
 * with a mark in front. Each one is what the board measures — a building for
 * enterprise value, coins for personal wealth, a capitol for government
 * standing — never a letter pair.
 */
const BOARD_ICON: Readonly<Record<LeaderboardBoard, IconName>> = {
  company_value: 'building',
  founder_wealth: 'coins',
  revenue: 'ledger',
  profit: 'chart',
  innovation: 'flask',
  market_influence: 'network',
  network: 'people',
  government: 'capitol',
  reputation: 'newspaper',
  founder_index: 'trophy',
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
  if (units === 'index') return formatScore(value * 100);
  return formatScore(value);
}

function formatValueDelta(units: Units, value: number): string {
  if (units === 'money') return formatDelta(value, 'money');
  if (units === 'index') return formatDelta(value * 100, 'number');
  return formatDelta(value, 'number');
}

export default function LeaderboardPage(): React.JSX.Element {
  const session = useSession();
  const view = usePlayerView();
  const company = usePlayerCompany();
  const founder = usePlayerCharacter();
  const [board, setBoard] = useState<LeaderboardBoard>('founder_index');
  const [sector, setSector] = useState<Sector | null>(null);

  const boards = session.leaderboards;
  const active = boards.find((entry) => entry.board === board) ?? null;
  const units = BOARD_UNITS[board];

  const mine = useMemo(() => new Set([company.id, founder.id, view.playerId]), [company.id, founder.id, view.playerId]);

  /* --- which sector a row belongs to ---------------------------------------
      A board ranks companies on some tabs and founders on others, so the map is
      keyed by both: a company's id, and the id of whoever runs it. A row whose
      subject is neither — an institution, a fund — has no sector and is only
      ever shown unfiltered. */
  const sectorBySubject = useMemo(() => {
    const map = new Map<string, Sector>();
    for (const entry of allVisibleCompanies(view)) {
      if (entry.id === undefined) continue;
      const value = sectorOf(entry);
      map.set(entry.id, value);
      if (entry.ceoCharacterId !== null && entry.ceoCharacterId !== undefined) map.set(entry.ceoCharacterId, value);
    }
    return map;
  }, [view]);

  const presentSectors = useMemo(() => sectorsPresent(allVisibleCompanies(view)), [view]);
  const multiSector = presentSectors.length > 1;

  const entries = active?.entries ?? [];
  const counts = useMemo(() => {
    const out: Partial<Record<Sector, number>> = {};
    for (const row of entries) {
      const value = sectorBySubject.get(row.subjectId);
      if (value === undefined) continue;
      out[value] = (out[value] ?? 0) + 1;
    }
    return out;
  }, [entries, sectorBySubject]);

  const filtered = useMemo(
    () => (sector === null ? entries : entries.filter((row) => sectorBySubject.get(row.subjectId) === sector)),
    [entries, sector, sectorBySubject],
  );

  /**
   * Who leads each sector on the board in view.
   *
   * Ranks are computed across the whole world, so this is not a second
   * ranking — it is the best-placed row from each sector, which is what "who is
   * winning robotics" actually means.
   */
  const sectorLeaders = useMemo(
    () =>
      presentSectors
        .map((entry) => {
          const here = entries
            .filter((row) => sectorBySubject.get(row.subjectId) === entry)
            .sort((a, b) => a.rank - b.rank);
          return { sector: entry, leader: here[0] ?? null, count: here.length };
        })
        .filter((entry) => entry.leader !== null),
    [presentSectors, entries, sectorBySubject],
  );

  const headline = useMemo(() => {
    const composite = boards.find((entry) => entry.board === 'founder_index')?.entries.find((row) => row.subjectId === founder.id) ?? null;
    const value = boards.find((entry) => entry.board === 'company_value')?.entries.find((row) => row.subjectId === company.id) ?? null;
    const wealth = boards.find((entry) => entry.board === 'founder_wealth')?.entries.find((row) => row.subjectId === founder.id) ?? null;
    const network = boards.find((entry) => entry.board === 'network')?.entries.find((row) => row.subjectId === founder.id) ?? null;
    return { composite, value, wealth, network };
  }, [boards, company.id, founder.id]);

  const allColumns: readonly Column<LeaderboardEntry>[] = [
    {
      key: 'rank',
      header: '#',
      cardLabel: 'Rank',
      width: '52px',
      align: 'right',
      render: (row) => <span className={cx('figure', mine.has(row.subjectId) ? 'text-brand' : 'text-ink')}>{row.rank}</span>,
      sortable: true,
      sortValue: (row) => row.rank,
    },
    {
      key: 'move',
      header: 'Move',
      cardLabel: 'Since last quarter',
      width: '84px',
      render: (row) => {
        const move = formatRankMove(row.previousRank, row.rank);
        if (move === null) return <span className="text-[10px] text-ink-faint">held</span>;
        if (move === 'new') return <Tag tone="info">new</Tag>;
        const improved = row.previousRank !== null && row.previousRank > row.rank;
        return (
          <span className={cx('inline-flex items-center gap-1', improved ? 'tone-gain' : 'tone-loss')}>
            {/* One chevron, turned over for a climb: a drawn mark, not a glyph. */}
            <Icon name="chevronDown" size={12} accent="current" className={improved ? 'rotate-180' : undefined} />
            <span className="figure text-[11px]">{move}</span>
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
          <CompanyChip
            size="sm"
            own={row.subjectId === company.id}
            company={{ id: row.subjectId, name: row.label, sector: sectorBySubject.get(row.subjectId) }}
            badges={multiSector && sectorBySubject.has(row.subjectId) ? 'sector' : 'none'}
          />
        ),
      sortable: true,
      sortValue: (row) => row.label,
    },
    {
      key: 'sector',
      header: 'Sector',
      width: '112px',
      mono: false,
      hideOnMobile: true,
      cardHidden: true,
      render: (row) => {
        const value = sectorBySubject.get(row.subjectId);
        return value === undefined ? <span className="text-[10px] text-ink-faint">—</span> : <SectorBadge sector={value} />;
      },
      sortable: true,
      sortValue: (row) => sectorBySubject.get(row.subjectId) ?? 'zz',
    },
    {
      key: 'value',
      header: 'Value',
      cardLabel: BOARD_LABEL[board],
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
          <span className="figure text-[10px] text-ink-faint">{formatScore(row.percentile * 100)}</span>
        </span>
      ),
      sortable: true,
      sortValue: (row) => row.percentile,
    },
  ];

  // One sector in the session means the sector column is the same sticker on
  // every row, so it is dropped rather than shown empty.
  const columns = multiSector ? allColumns : allColumns.filter((entry) => entry.key !== 'sector');

  return (
    <>
      <PageHeader
        title="Leaderboard"
        eyebrow={`${quarterLabel(session.startYear, session.quarter)} · ${boards.length} of ${LEADERBOARD_BOARDS.length} boards computed`}
        subtitle="Ten independent rankings and the composite that sits on top of them. Every figure is recomputed server-side from the ledger."
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          iconName="trophy"
          label="Founder Index"
          value={headline.composite === null ? '—' : formatScore(headline.composite.value * 100)}
          hint={headline.composite === null ? 'Computed at the first resolution' : `Rank #${headline.composite.rank} of ${boards.find((entry) => entry.board === 'founder_index')?.entries.length ?? 0}`}
          delta={headline.composite === null || headline.composite.delta === 0 ? undefined : headline.composite.delta * 100}
          deltaFormat="number"
        />
        <StatCard
          iconName="building"
          label="Company value"
          value={headline.value === null ? '—' : formatMoney(headline.value.value)}
          hint={headline.value === null ? 'Computed at the first resolution' : `Rank #${headline.value.rank}`}
          delta={headline.value === null || headline.value.delta === 0 ? undefined : headline.value.delta}
          deltaFormat="money"
        />
        <StatCard
          iconName="coins"
          label="Your wealth"
          value={headline.wealth === null ? '—' : formatMoney(headline.wealth.value)}
          hint={headline.wealth === null ? 'Computed at the first resolution' : `Rank #${headline.wealth.rank}`}
          delta={headline.wealth === null || headline.wealth.delta === 0 ? undefined : headline.wealth.delta}
          deltaFormat="money"
        />
        <StatCard
          iconName="people"
          label="Network"
          value={headline.network === null ? '—' : formatScore(headline.network.value)}
          hint={headline.network === null ? 'Computed at the first resolution' : `Rank #${headline.network.rank}`}
          delta={headline.network === null || headline.network.delta === 0 ? undefined : headline.network.delta}
          deltaFormat="number"
          href="/network"
        />
      </div>

      <IconTabs
        ariaLabel="Leaderboards"
        tabs={LEADERBOARD_BOARDS.map((entry) => ({
          id: entry,
          label: BOARD_LABEL[entry],
          icon: BOARD_ICON[entry],
          badge: boards.find((item) => item.board === entry)?.entries.length,
        }))}
        value={board}
        onChange={(id) => setBoard(id as LeaderboardBoard)}
      />

      <Panel
        iconName={BOARD_ICON[board]}
        iconTone="brand"
        title={BOARD_LABEL[board]}
        subtitle={BOARD_BLURB[board]}
        flush
        actions={
          active === null ? undefined : (
            <>
              {sector === null ? null : (
                <Tag tone="info">
                  {filtered.length} in {SECTOR_META[sector].label}
                </Tag>
              )}
              <Tag tone="neutral">{quarterLabel(session.startYear, active.quarter)}</Tag>
            </>
          )
        }
      >
        {/* The rank on a filtered row is still its rank in the whole world:
            narrowing to one sector never renumbers anybody. */}
        {active === null || !multiSector ? null : (
          <div className="border-b border-hair px-3 pt-3 pb-2">
            <SectorFilter sectors={presentSectors} value={sector} onChange={setSector} counts={counts} />
          </div>
        )}
        {active === null ? (
          <EmptyState
            icon="trophy"
            title="Rankings are computed when a quarter resolves"
            message="Leaderboards are rebuilt from state in the sixteenth phase of every resolution, and the client can never submit a score. Queue your instructions and end the quarter."
          />
        ) : (
          <DataTable
            columns={columns}
            rows={filtered}
            rowKey={(row) => `${board}_${row.subjectId}`}
            isHighlighted={(row) => mine.has(row.subjectId)}
            dense
            cardMode="auto"
            cardTitleKey="subject"
            initialSort={{ key: 'rank', direction: 'asc' }}
            empty={
              <div className="p-4">
                <EmptyState
                  compact
                  icon="trophy"
                  title="Nobody from this sector is ranked here"
                  message="This board ranks subjects that have a figure to rank. Clear the filter to see the whole field."
                />
              </div>
            }
          />
        )}
      </Panel>

      {/* --- who leads each sector --------------------------------------------
          Not a second ranking: each row is the best-placed subject from that
          sector on the board above, at its world rank. */}
      {!multiSector || sectorLeaders.length === 0 ? null : (
        <Panel
          iconName="globe"
          iconTone="info"
          title={`${BOARD_LABEL[board]} by sector`}
          subtitle="The best-placed name in each sector, at its rank across the whole world."
        >
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {sectorLeaders.map((entry) => {
              const leader = entry.leader;
              if (leader === null) return null;
              return (
                <button
                  key={entry.sector}
                  type="button"
                  onClick={() => setSector((current) => (current === entry.sector ? null : entry.sector))}
                  className={cx(
                    'raised-surface tap-target flex w-full items-center justify-between gap-2 px-3 py-2 text-left transition-colors hover:border-hair-strong',
                    sector === entry.sector ? 'border-brand/30 bg-brand-wash' : '',
                  )}
                >
                  <span className="flex min-w-0 flex-1 flex-col gap-1">
                    <SectorBadge sector={entry.sector} className="self-start" />
                    <span className={cx('truncate text-[12.5px]', mine.has(leader.subjectId) ? 'font-semibold text-brand' : 'text-ink')}>
                      {leader.label}
                    </span>
                  </span>
                  <span className="flex shrink-0 flex-col items-end gap-0.5">
                    <span className="figure text-[12px] text-ink">{formatValue(units, leader.value)}</span>
                    <span className="figure text-[10px] text-ink-faint">
                      #{leader.rank} of {entry.count}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </Panel>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel
          iconName="trophy"
          title="Founder Index decomposition"
          subtitle="Eight weighted percentiles, and the arithmetic that produced the composite."
        >
          <FounderIndexPanel session={session} view={view} founderId={founder.id} founderName={founder.name} companyId={company.id} />
        </Panel>

        <Panel iconName="ledger" title="Board summary" subtitle="Where you stand on every board at once.">
          {boards.length === 0 ? (
            <EmptyState compact icon="trophy" title="No boards yet" message="They appear together after the first resolution." />
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
                      'tap-target flex w-full items-center justify-between gap-3 rounded-chip border-b border-hair px-2 py-2 text-left transition-colors hover:bg-raised',
                      board === name ? 'icon-knockout-raised bg-raised' : 'icon-knockout-panel',
                    )}
                  >
                    <span className="flex min-w-0 items-center gap-2.5">
                      <Icon name={BOARD_ICON[name]} size={16} accent="inherit" />
                      <span className="block min-w-0 truncate text-[12.5px] text-ink">{BOARD_LABEL[name]}</span>
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
        iconName="network"
        title="Industry power"
        subtitle="Disclosed stakes, board seats and deals. Deterministic layout: the same state always draws the same graph."
      >
        <PowerGraph session={session} view={view} />
      </Panel>
    </>
  );
}
