'use client';

/**
 * Network — the people graph, drawn.
 *
 * The design claim: **networking is gameplay, not a number to grind.** A
 * first-quarter founder on connection 24 cannot open a channel to a sovereign
 * fund on 93, and the screen says so in those words, with the gap on the row.
 * What it also does is show the way through: who you *can* reach, which of them
 * can reach the person you want, and a `request_introduction` that runs the same
 * reachability check the validator will.
 *
 * The primary surface is a web of faces in rings around you — reachable inside,
 * one introduction away in the middle, out of reach outside — because "how far
 * away is this person" is a spatial question and a table answers it badly. The
 * directory is still here, one tab across, for every question a table answers
 * better: sorting, comparing, scanning.
 *
 * Two boundaries are kept here deliberately:
 *
 * - Connection levels are public — the engine emits the recompute as a `public`
 *   ledger row for exactly this reason — so the directory ranks everybody.
 * - Relationships and memory are private and directional. Only edges incident to
 *   the player are read, and only the player's own memories.
 */

import { useMemo, useState } from 'react';
import { quarterLabel } from '@frontier/contracts';
import { formatScore } from '@frontier/shared';
import { connectionInputs } from '@frontier/simulation';
import {
  AccessBadge,
  DataTable,
  EmptyState,
  Icon,
  Meter,
  PageHeader,
  Panel,
  PersonChip,
  SectionHeading,
  StatCard,
  Tag,
  cx,
  type Column,
} from '@/components/ui';
import { ConnectionBreakdown } from '@/components/screens/network/ConnectionBreakdown';
import { PeopleWeb } from '@/components/screens/network/PeopleWeb';
import { PersonDrawer } from '@/components/screens/network/PersonDrawer';
import { buildDirectory, characterName, overridesFor, type DirectoryEntry } from '@/components/screens/network/directory';
import { IconTabs } from '@/components/screens/world/IconTabs';
import { useLeaderboards, usePlayerCharacter, usePlayerView, useSession } from '@/lib/game';

const ROLE_FILTERS: readonly { readonly id: string; readonly label: string }[] = [
  { id: 'all', label: 'Everyone' },
  { id: 'founder_ceo', label: 'Founders' },
  { id: 'investor', label: 'Investors' },
  { id: 'director', label: 'Directors' },
  { id: 'regulator', label: 'Regulators' },
  { id: 'journalist', label: 'Press' },
];

export default function NetworkPage(): React.JSX.Element {
  const session = useSession();
  const view = usePlayerView();
  const founder = usePlayerCharacter();
  const powerBoard = useLeaderboards('network')[0] ?? null;

  const [surface, setSurface] = useState('web');
  const [role, setRole] = useState('all');
  const [reachOnly, setReachOnly] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);

  const directory = useMemo(() => buildDirectory(session, view, founder.id), [session, view, founder.id]);
  const inputs = useMemo(() => connectionInputs(session).find((entry) => entry.characterId === founder.id) ?? null, [session, founder.id]);
  const overrides = useMemo(() => overridesFor(session, founder.id), [session, founder.id]);

  const rows = useMemo(
    () =>
      directory.filter((entry) => {
        if (role !== 'all' && entry.character.role !== role) return false;
        if (reachOnly && entry.state === 'blocked') return false;
        return true;
      }),
    [directory, role, reachOnly],
  );

  const open = directory.filter((entry) => entry.state === 'open');
  const viaOverride = directory.filter((entry) => entry.state === 'override');
  const blocked = directory.filter((entry) => entry.state === 'blocked');
  const routed = blocked.filter((entry) => entry.brokerIds.length > 0);
  const selectedEntry = selected === null ? null : (directory.find((entry) => entry.character.id === selected) ?? null);

  const filters = (
    <div className="flex w-full min-w-0 items-center gap-1.5 sm:w-auto">
      <select
        className="field tap-target min-w-0 flex-1 sm:w-36 sm:flex-none"
        value={role}
        onChange={(event) => setRole(event.target.value)}
        aria-label="Filter by role"
      >
        {ROLE_FILTERS.map((filter) => (
          <option key={filter.id} value={filter.id}>
            {filter.label}
          </option>
        ))}
      </select>
      <button
        type="button"
        className={cx(
          'btn tap-target shrink-0',
          reachOnly ? 'icon-knockout-wash border-brand/30 bg-brand-wash text-brand' : 'icon-knockout-panel',
        )}
        aria-pressed={reachOnly}
        onClick={() => setReachOnly((value) => !value)}
      >
        {/* The tick is the state, so it appears only when the filter is on: a
            check drawn on an unchecked toggle would read as already applied. */}
        {reachOnly ? <Icon name="check" size={15} accent="inherit" /> : null}
        Reachable only
      </button>
    </div>
  );

  const columns: readonly Column<DirectoryEntry>[] = [
    {
      key: 'person',
      header: 'Person',
      width: '26%',
      render: (row) => <PersonChip character={row.character} size="sm" subtitle={row.character.title} />,
      sortable: true,
      sortValue: (row) => row.character.name,
    },
    {
      key: 'company',
      header: 'Company',
      hideOnMobile: true,
      render: (row) => <span className="text-[11px] text-ink-dim">{row.companyName ?? 'Independent'}</span>,
      sortable: true,
      sortValue: (row) => row.companyName ?? 'zzz',
    },
    {
      key: 'connection',
      header: 'Connection',
      cardLabel: 'Connection level',
      align: 'right',
      width: '92px',
      render: (row) => formatScore(row.character.connectionLevel),
      sortable: true,
      sortValue: (row) => row.character.connectionLevel,
    },
    {
      key: 'access',
      header: 'Access',
      width: '120px',
      render: (row) => <AccessBadge state={row.state} gap={Math.round(row.decision.gap)} />,
      sortable: true,
      sortValue: (row) => (row.state === 'open' ? 0 : row.state === 'override' ? 1 : 2),
    },
    {
      key: 'trust',
      header: 'Your trust',
      width: '110px',
      hideOnMobile: true,
      // Both directions of the relationship are read honestly in the drawer;
      // a bar with no number on a card would only be decoration.
      cardHidden: true,
      render: (row) =>
        row.outbound === null ? <span className="text-[10px] text-ink-faint">—</span> : <Meter value={row.outbound.trust} showValue={false} />,
      sortable: true,
      sortValue: (row) => row.outbound?.trust ?? -1,
    },
    {
      key: 'their-respect',
      header: 'Their respect',
      width: '110px',
      hideOnMobile: true,
      cardHidden: true,
      render: (row) =>
        row.inbound === null ? <span className="text-[10px] text-ink-faint">—</span> : <Meter value={row.inbound.respect} showValue={false} />,
      sortable: true,
      sortValue: (row) => row.inbound?.respect ?? -1,
    },
    {
      key: 'last',
      header: 'Last contact',
      align: 'right',
      hideOnMobile: true,
      render: (row) => {
        const edge = row.outbound ?? row.inbound;
        if (edge === null || edge.lastInteractionQuarter === null) return <span className="text-ink-faint">never</span>;
        return quarterLabel(session.startYear, edge.lastInteractionQuarter);
      },
      sortable: true,
      sortValue: (row) => (row.outbound ?? row.inbound)?.lastInteractionQuarter ?? -1,
    },
  ];

  return (
    <>
      <PageHeader
        title="Network"
        eyebrow={quarterLabel(session.startYear, session.quarter)}
        subtitle="Who you can reach, who you cannot, and what it would take. Connection level is public; how anyone feels about you is not."
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          iconName="network"
          label="Connection"
          value={formatScore(founder.connectionLevel)}
          hint={`${founder.name} · ${founder.boardSeatCount} seat${founder.boardSeatCount === 1 ? '' : 's'}`}
        />
        <StatCard
          iconName="check"
          label="Direct"
          value={String(open.length)}
          hint="Within ten points of you"
          tone={open.length > 0 ? 'gain' : undefined}
        />
        <StatCard
          iconName="handshake"
          label="Via override"
          value={String(viaOverride.length)}
          hint="A board, a deal, a favour"
        />
        <StatCard
          iconName="warning"
          label="Out of reach"
          value={String(blocked.length)}
          tone={blocked.length > 0 ? 'warn' : undefined}
          iconTone={blocked.length > 0 ? 'warn' : 'neutral'}
          hint={`${routed.length} have a route in`}
        />
      </div>

      <IconTabs
        ariaLabel="How to read the network"
        value={surface}
        onChange={setSurface}
        tabs={[
          { id: 'web', label: 'The web', icon: 'network' },
          { id: 'list', label: 'Directory', icon: 'people', badge: rows.length },
        ]}
      />

      {surface === 'web' ? (
        <Panel
          iconName="network"
          title="The people web"
          subtitle={`${rows.length} people, placed by how far away they are. Tap anyone for their card.`}
          actions={filters}
        >
          {rows.length === 0 ? (
            <EmptyState icon="people" title="Nobody matches that filter" message="Widen the role filter or show everyone." compact />
          ) : (
            <PeopleWeb entries={rows} founder={founder} selectedId={selected} onSelect={setSelected} />
          )}
        </Panel>
      ) : (
        <Panel iconName="people" title="Directory" subtitle={`${rows.length} of ${directory.length} people`} flush actions={filters}>
          <DataTable
            columns={columns}
            rows={rows}
            rowKey={(row) => row.character.id}
            onRowClick={(row) => setSelected(row.character.id)}
            initialSort={{ key: 'connection', direction: 'desc' }}
            dense
            cardMode="auto"
            cardTitleKey="person"
            empty={<EmptyState icon="people" title="Nobody matches that filter" message="Widen the role filter or show everyone." compact />}
          />
        </Panel>
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        <Panel
          iconName="chart"
          title="Connection level"
          subtitle="The ten inputs behind your standing, each a percentile within this session"
          className="lg:col-span-2"
        >
          <ConnectionBreakdown inputs={inputs} standingLevel={founder.connectionLevel} />
        </Panel>

        <Panel iconName="handshake" title="Access" subtitle="Who you can open a channel with this quarter">
          <div className="flex flex-col gap-3">
            <AccessGroup title="Reachable" tone="gain" entries={open} onSelect={setSelected} />
            <AccessGroup title="Through an override" tone="info" entries={viaOverride} onSelect={setSelected} />
            <div>
              <SectionHeading rule>Needs an introduction</SectionHeading>
              {blocked.length === 0 ? (
                <p className="mt-2 text-[11px] text-ink-faint">Nobody in this session is out of your reach.</p>
              ) : (
                <ul className="mt-2 flex flex-col gap-1.5">
                  {blocked.map((entry) => (
                    <li key={entry.character.id}>
                      <button
                        type="button"
                        onClick={() => setSelected(entry.character.id)}
                        className="tap-target flex w-full flex-col justify-center rounded-chip px-2 py-1 text-left transition-colors hover:bg-raised"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="truncate text-[12.5px] text-ink">{entry.character.name}</span>
                          <span className="figure shrink-0 text-[10px] text-warn">gap {Math.round(entry.decision.gap)}</span>
                        </div>
                        <div className="truncate text-[11px] text-ink-faint">
                          {entry.brokerIds.length === 0
                            ? 'No route yet'
                            : `via ${characterName(session, entry.brokerIds[0] ?? '')}${
                                entry.brokerIds.length > 1 ? ` +${entry.brokerIds.length - 1} others` : ''
                              }`}
                        </div>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div>
              <SectionHeading rule>Standing overrides</SectionHeading>
              {overrides.length === 0 ? (
                <p className="mt-2 text-[11px] text-ink-faint">
                  None granted. Structural bypasses — a shared board, a consortium, a live negotiation — are derived from your positions and
                  appear on the person themselves.
                </p>
              ) : (
                <ul className="mt-2 flex flex-col gap-1.5">
                  {overrides.map((override) => (
                    <li key={override.id} className="raised-surface px-2.5 py-1.5">
                      <div className="flex items-center justify-between gap-2">
                        <Tag tone="info">{override.kind.replace(/_/g, ' ')}</Tag>
                        <span className="figure text-[10px] text-ink-faint">
                          {override.isPermanent ? 'permanent' : `to ${quarterLabel(session.startYear, override.expiresQuarter ?? session.quarter)}`}
                        </span>
                      </div>
                      <p className="mt-1 text-[10px] text-ink-dim">{override.reason}</p>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </Panel>
      </div>

      <Panel iconName="trophy" title="Industry power" subtitle="The network board, recomputed from the ledger every quarter" flush>
        {powerBoard === null ? (
          <div className="p-3.5">
            <EmptyState
              icon="trophy"
              title="Rankings appear when the first quarter resolves"
              message="Leaderboards are recomputed server-side from committed events. At quarter zero nothing has been committed yet."
              compact
            />
          </div>
        ) : (
          <DataTable
            dense
            cardMode="auto"
            cardTitleKey="label"
            rows={powerBoard.entries}
            rowKey={(row) => `${row.subjectKind}:${row.subjectId}`}
            isHighlighted={(row) => row.subjectId === founder.id}
            columns={[
              { key: 'rank', header: '#', cardLabel: 'Rank', width: '48px', align: 'right', render: (row) => String(row.rank) },
              { key: 'label', header: 'Person', render: (row) => <span className="text-[12px] text-ink">{row.label}</span> },
              { key: 'value', header: 'Connection', align: 'right', render: (row) => formatScore(row.value) },
              {
                key: 'delta',
                header: 'Change',
                align: 'right',
                hideOnMobile: true,
                render: (row) => <span className="text-[11px] text-ink-dim">{row.delta === 0 ? '—' : row.delta.toFixed(1)}</span>,
              },
            ]}
          />
        )}
      </Panel>

      <PersonDrawer
        entry={selectedEntry}
        selfId={founder.id}
        selfName={founder.name}
        selfConnection={founder.connectionLevel}
        startYear={session.startYear}
        onClose={() => setSelected(null)}
      />
    </>
  );
}

/** A short list of people in one access state. */
function AccessGroup({
  title,
  tone,
  entries,
  onSelect,
}: {
  readonly title: string;
  readonly tone: 'gain' | 'info';
  readonly entries: readonly DirectoryEntry[];
  readonly onSelect: (id: string) => void;
}): React.JSX.Element {
  return (
    <div>
      <SectionHeading rule>{title}</SectionHeading>
      {entries.length === 0 ? (
        <p className="mt-2 text-[11px] text-ink-faint">Nobody yet.</p>
      ) : (
        <ul className="mt-2 flex flex-col gap-1">
          {entries.map((entry) => (
            <li key={entry.character.id}>
              <PersonChip
                character={entry.character}
                size="sm"
                className="tap-target"
                onClick={() => onSelect(entry.character.id)}
                right={<span className={`figure text-[11px] tone-${tone}`}>{formatScore(entry.character.connectionLevel)}</span>}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
