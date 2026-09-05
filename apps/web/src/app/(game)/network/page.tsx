'use client';

/**
 * Network — the people graph, drawn.
 *
 * The design claim: **networking is gameplay, not a number to grind.** A
 * first-quarter founder on connection 24 cannot open a channel to a sovereign
 * fund on 93, and the screen says so in those words, with the gap on the row.
 * What it also does is show the way through: who you *can* reach, which of them
 * can reach the person you want, and — in the drawer behind every face — the
 * typed actions that person's role admits, each carrying the validator's own
 * live verdict. Reachability here is `checkAccess`, which is the function the
 * validator's `canReach` now *is* rather than restates; when those two drifted
 * apart the whole screen went quiet, because every route it offered ran through
 * somebody the engine said could not be reached.
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

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { CONNECTION_GAP_RULE, quarterLabel } from '@frontier/contracts';
import { formatDelta, formatScore } from '@frontier/shared';
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
import { CONNECTION_LEVERS } from '@/components/screens/network/actions';
import { buildDirectory, characterName, overridesFor, type DirectoryEntry } from '@/components/screens/network/directory';
import { CAPITAL_KIND_LABEL, STANCE_LABEL, STANCE_TONE, streetCards, type StanceContext } from '@/components/screens/street';
import { IconTabs } from '@/components/screens/world/IconTabs';
import { takePendingNetworkCharacter, useLeaderboards, usePlayerCharacter, usePlayerView, useSession } from '@/lib/game';

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

  // Arriving from a News byline: that person's card opens on mount, if the
  // directory has them. Consumed on read, so the next visit opens plain.
  useEffect(() => {
    const pending = takePendingNetworkCharacter();
    if (pending !== null && directory.some((entry) => entry.character.id === pending)) setSelected(pending);
    // Mount only: the directory identity changes every render of a live session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
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
  /** No channel open and no channel obtainable: the one state with no move on it. */
  const stranded = open.length === 0 && viaOverride.length === 0 && routed.length === 0;
  const selectedEntry = selected === null ? null : (directory.find((entry) => entry.character.id === selected) ?? null);

  /**
   * The institutions, matched to their partners.
   *
   * The stance is the same derivation The Street uses, on the same committed
   * rows, so a partner never reads as a backer on one screen and an adversary
   * on the other. Every field below is state: a relationship edge, a connection
   * level, an access decision the validator would take.
   */
  const partners = useMemo(() => {
    const report = view.economyReport;
    if (report === null) return [];
    const context: StanceContext = {
      ownCompanyIds: new Set([view.ownCompany.id]),
      trustByPartnerId: new Map(
        session.relationships.filter((edge) => edge.toId === founder.id).map((edge) => [edge.fromId, edge.trust] as const),
      ),
      hostilityByPartnerId: new Map(
        session.relationships.filter((edge) => edge.toId === founder.id).map((edge) => [edge.fromId, edge.hostility] as const),
      ),
      approachEntityIds: new Set<string>(),
      campaignEntityIds: new Set(
        (session.activistCampaigns ?? [])
          .filter((campaign) => campaign.outcome === null && campaign.targetCompanyId === view.ownCompany.id)
          .map((campaign) => campaign.entityId),
      ),
      proxyFightEntityIds: new Set<string>(),
      shortEntityIds: new Set(
        report.shortInterest
          .filter((short) => short.companyId === view.ownCompany.id)
          .flatMap((short) => short.disclosedEntityIds),
      ),
    };
    const byCharacter = new Map(directory.map((entry) => [entry.character.id, entry] as const));
    return streetCards(report, context).flatMap((card) => {
      const partnerId = card.row.partnerCharacterId;
      if (partnerId === null) return [];
      const entry = byCharacter.get(partnerId);
      if (entry === undefined) return [];
      return [
        {
          entityId: card.row.entityId,
          entityName: card.row.name,
          kind: card.row.kind,
          stance: card.stance,
          character: entry.character,
          reach: entry.state,
          trust: entry.inbound?.trust ?? null,
        },
      ];
    });
  }, [view, session.relationships, session.activistCampaigns, founder.id, directory]);

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
          // A structural bypass is a channel that is open *today*, so it reads
          // as a gain: these are the people a founder can act on this quarter.
          tone={viaOverride.length > 0 ? 'gain' : undefined}
          hint="A board, a deal, a shared investor"
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

      {/* --- the dead screen -------------------------------------------------
          Nobody reachable and nobody who can pass a message along. A founder
          landing here has no move on this page, so the page stops showing them
          a web of faces they cannot touch and shows them the ten things that
          actually move standing, each one a tap away. */}
      {stranded ? (
        <Panel
          iconName="warning"
          iconTone="warn"
          title="Nobody is in reach yet"
          subtitle={`Every one of the ${directory.length} people here sits more than ${CONNECTION_GAP_RULE.symmetricGap} points above you, and none of them can be reached through anybody else either.`}
        >
          <p className="text-[12.5px] leading-relaxed text-ink-dim">
            Connection level is not a number to grind: it is recomputed every quarter from ten inputs, each a percentile within this session.
            These are the ten, largest first, and the screen where each one is played.
          </p>
          <div className="mt-3">
            <ConnectionLevers />
          </div>
        </Panel>
      ) : null}

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

      {/* --- the institutions ------------------------------------------------
          The eleven partners are ordinary characters with ordinary
          relationships, so they are already in the directory above. This panel
          is the one thing the directory cannot say: which institution stands
          behind each of them, and how far away that person is. Absent in a
          session with no institutional layer. */}
      {partners.length === 0 ? null : (
        <Panel
          iconName="briefcase"
          iconTone="brand"
          title="Capital partners"
          subtitle="Every institution speaks through a person. This is who, and how close you are to them."
        >
          <ul className="grid gap-2 sm:grid-cols-2">
            {partners.map((partner) => (
              <li key={partner.entityId} className="raised-surface px-2.5 py-2">
                <PersonChip
                  character={partner.character}
                  size="sm"
                  className="tap-target"
                  onClick={() => setSelected(partner.character.id)}
                  subtitle={`${partner.entityName} · ${CAPITAL_KIND_LABEL[partner.kind]}`}
                  right={<span className="figure text-[11px] text-ink-dim">{formatScore(partner.character.connectionLevel)}</span>}
                />
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                  <Tag tone={STANCE_TONE[partner.stance]} dot>
                    {STANCE_LABEL[partner.stance]}
                  </Tag>
                  <Tag tone={partner.reach === 'blocked' ? 'warn' : 'neutral'}>
                    {partner.reach === 'blocked' ? 'Needs an introduction' : 'Reachable'}
                  </Tag>
                  {partner.trust === null ? (
                    <span className="text-[10.5px] text-ink-faint">You have never dealt with each other</span>
                  ) : (
                    <span className="figure text-[10.5px] text-ink-faint">trust {formatScore(partner.trust)}</span>
                  )}
                </div>
              </li>
            ))}
          </ul>
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
          {stranded ? null : (
            <div className="mt-4">
              <SectionHeading rule>Where each one is played</SectionHeading>
              <div className="mt-2">
                <ConnectionLevers />
              </div>
            </div>
          )}
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
                render: (row) => <span className="text-[11px] text-ink-dim">{row.delta === 0 ? '—' : formatDelta(row.delta, 'number')}</span>,
              },
            ]}
          />
        )}
      </Panel>

      <PersonDrawer
        entry={selectedEntry}
        directory={directory}
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

/**
 * The ten inputs of the connection hierarchy, as places to go.
 *
 * The weights are the engine's own, so the order is the real order of leverage
 * rather than a list of encouraging suggestions — and `publicFollowing` sits
 * last at five percent, because this game is emphatically not follower count.
 */
function ConnectionLevers(): React.JSX.Element {
  return (
    <ul className="grid gap-1.5 sm:grid-cols-2">
      {CONNECTION_LEVERS.map((lever) => (
        <li key={lever.label}>
          <Link href={lever.href} className="tap-target flex w-full items-center gap-2.5 rounded-chip px-2 py-1.5 transition-colors hover:bg-raised">
            <span className="shrink-0">
              <Icon name={lever.icon} size={17} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[12px] font-semibold text-ink">{lever.label}</span>
              <span className="block text-[10.5px] leading-relaxed text-ink-faint">{lever.how}</span>
            </span>
            <span className="figure shrink-0 text-[11px] text-ink-dim">{lever.weightPct}%</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
