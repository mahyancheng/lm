'use client';

/**
 * Research — the Frontier Map.
 *
 * Not a technology tree. A tree would claim the designers already know the
 * future; this is what the inhabitants of *this* world currently believe the
 * future might look like, held with a confidence that differs between the
 * public and each company, and rearranged by events.
 *
 * The information boundary is load-bearing here and is enforced twice. The map
 * renders `usePlayerView().techGraph` — public nodes plus the player's own, with
 * `confidenceByCompany` already cut to the player's entry and the public figure
 * — and the programme tables read `visibleResearchProjects`, where a rival's
 * secret programme is *absent* rather than redacted. `session.techGraph` and
 * `session.researchProjects` are never touched by this screen.
 */

import { useMemo, useState } from 'react';
import type { ResearchProject, Sector, TechNode } from '@frontier/contracts';
import { SECTORS, quarterLabel } from '@frontier/contracts';
import { heldComputeUnits, researchEnvelopeUsd } from '@frontier/simulation';
import { formatMoney, formatPct } from '@frontier/shared';
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
  SectorFilter,
  SliderField,
  StatCard,
  TabBar,
  Tag,
  ValidationBanner,
  roundStep,
  type Column,
} from '@/components/ui';
import { FrontierMap } from '@/components/screens/research/FrontierMap';
import { InnovationPanel } from '@/components/screens/research/InnovationPanel';
import { NodeDrawer } from '@/components/screens/research/NodeDrawer';
import { EDGE_STYLE, STATE_STYLE } from '@/components/screens/research/graphLayout';
import { nodeIdsInSector, tracksOf } from '@/components/screens/research/tracks';
import {
  useGameActions,
  useOutcome,
  usePlayerCompany,
  usePlayerView,
  useQueuedActions,
  useSession,
  visibleResearchProjects,
} from '@/lib/game';

type MapFilter = 'all' | 'edge' | 'mine' | 'moved';

interface ConfidenceMove {
  readonly nodeId: string;
  readonly title: string;
  readonly previous: number;
  readonly next: number;
  readonly previousStatus: string;
  readonly nextStatus: string;
  readonly windowShiftYears: number;
}

function numberFrom(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export default function ResearchPage(): React.JSX.Element {
  const session = useSession();
  const view = usePlayerView();
  const company = usePlayerCompany();
  const outcome = useOutcome();
  const queuedEntries = useQueuedActions();
  const { queueAction, validateIntent } = useGameActions();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filter, setFilter] = useState<MapFilter>('all');
  const [trackSector, setTrackSector] = useState<Sector | null>(null);
  const [budgetText, setBudgetText] = useState('');
  const [budgetResult, setBudgetResult] = useState<ReturnType<typeof validateIntent> | null>(null);
  const [trainingSplit, setTrainingSplit] = useState(company.compute.trainingAllocation);
  const [splitResult, setSplitResult] = useState<ReturnType<typeof validateIntent> | null>(null);

  const graph = view.techGraph;
  const queued = useMemo(() => queuedEntries.map((entry) => entry.action), [queuedEntries]);

  const ownProjects = view.ownResearchProjects;
  const rivalProjects = useMemo(
    () => visibleResearchProjects(session).filter((project) => project.companyId !== company.id),
    [session, company.id],
  );

  const rivalNames = useMemo(() => {
    const names = new Map<string, string>();
    for (const rival of view.visibleCompanies) {
      if (rival.id !== undefined && rival.name !== undefined) names.set(rival.id, rival.name);
    }
    return names;
  }, [view.visibleCompanies]);

  const nodeTitles = useMemo(() => new Map(graph.nodes.map((node) => [node.id, node.title])), [graph.nodes]);
  const nodeSectors = useMemo(() => new Map(graph.nodes.map((node) => [node.id, node.sector])), [graph.nodes]);

  /* --- what moved when the last quarter resolved -------------------------- */
  const moves = useMemo<ConfidenceMove[]>(() => {
    if (outcome === null) return [];
    const out: ConfidenceMove[] = [];
    for (const event of outcome.events) {
      if (event.type !== 'tech_confidence_shifted') continue;
      const nodeId = typeof event.payload['nodeId'] === 'string' ? event.payload['nodeId'] : null;
      if (nodeId === null || !nodeTitles.has(nodeId)) continue;
      const previous = numberFrom(event.payload['previousConfidence']);
      const next = numberFrom(event.payload['newConfidence']);
      if (previous === null || next === null) continue;
      out.push({
        nodeId,
        title: nodeTitles.get(nodeId) ?? nodeId,
        previous,
        next,
        previousStatus: typeof event.payload['previousStatus'] === 'string' ? event.payload['previousStatus'] : '',
        nextStatus: typeof event.payload['newStatus'] === 'string' ? event.payload['newStatus'] : '',
        windowShiftYears: numberFrom(event.payload['windowShiftYears']) ?? 0,
      });
    }
    return out.sort((a, b) => Math.abs(b.next - b.previous) - Math.abs(a.next - a.previous));
  }, [outcome, nodeTitles]);

  const changedNodeIds = useMemo(() => new Set(moves.map((move) => move.nodeId)), [moves]);

  /* --- filters ------------------------------------------------------------ */
  const edgeNodes = useMemo(
    () =>
      graph.nodes.filter((node) => {
        const own = node.confidenceByCompany[company.id];
        return own !== undefined && Math.abs(own - node.publicConfidence) >= 0.05;
      }),
    [graph.nodes, company.id],
  );

  /* --- sector tracks ------------------------------------------------------
      Declared in world 2, derived from the nodes in world 1. Two lanes or more
      is what turns the sector controls on; a single-lane graph gets the map it
      has always had. */
  const tracks = useMemo(() => tracksOf(graph), [graph]);
  // Distinct and in presentation order: two lanes may share a sector, and the
  // filter offers a sector once however many lanes carry it.
  const trackSectors = useMemo(() => SECTORS.filter((entry) => tracks.some((track) => track.sector === entry)), [tracks]);
  const multiTrack = trackSectors.length > 1;
  const trackCounts = useMemo(() => {
    const out: Partial<Record<Sector, number>> = {};
    for (const track of tracks) out[track.sector] = (out[track.sector] ?? 0) + track.nodes.length;
    return out;
  }, [tracks]);

  const highlightIds = useMemo<ReadonlySet<string> | null>(() => {
    // The sector filter composes with the map filter: pick "your programmes" in
    // energy and you get the intersection, not the last one you touched.
    const bySector = trackSector === null ? null : nodeIdsInSector(tracks, trackSector);
    const byFilter =
      filter === 'all'
        ? null
        : filter === 'edge'
          ? new Set(edgeNodes.map((node) => node.id))
          : filter === 'moved'
            ? changedNodeIds
            : new Set(ownProjects.map((project) => project.targetNodeId));
    if (bySector === null) return byFilter;
    if (byFilter === null) return bySector;
    return new Set([...bySector].filter((id) => byFilter.has(id)));
  }, [filter, edgeNodes, changedNodeIds, ownProjects, trackSector, tracks]);

  const selectedNode: TechNode | null = selectedId === null ? null : (graph.nodes.find((node) => node.id === selectedId) ?? null);

  /* --- budgets ------------------------------------------------------------ */
  const envelope = researchEnvelopeUsd(company, queued);
  const held = heldComputeUnits(session, company);
  const committedCompute = ownProjects
    .filter((project) => project.status === 'active' || project.status === 'paused')
    .reduce((total, project) => total + project.computeAllocated, 0);
  const committedResearchers = ownProjects
    .filter((project) => project.status === 'active' || project.status === 'paused')
    .reduce((total, project) => total + project.talentAllocated, 0);

  const parsedBudget = Number.parseFloat(budgetText);
  const budgetValue = Number.isFinite(parsedBudget) && parsedBudget >= 0 ? parsedBudget : Math.round(envelope);
  const budgetMax = Math.max(company.financials.cash, envelope, budgetValue, 1_000_000);

  function applyBudget(): void {
    const value = Number.parseFloat(budgetText);
    if (!Number.isFinite(value) || value < 0) return;
    const entry = queueAction({ type: 'set_research_budget', budgetUsd: value });
    setBudgetResult(entry.validation);
  }

  function applySplit(): void {
    const entry = queueAction({ type: 'allocate_compute', trainingFraction: trainingSplit });
    setSplitResult(entry.validation);
  }

  const ownColumns: readonly Column<ResearchProject>[] = [
    {
      key: 'target',
      header: 'Programme',
      render: (row) => (
        <div className="min-w-0">
          <div className="truncate text-[12px] font-medium text-ink">{nodeTitles.get(row.targetNodeId) ?? row.targetNodeId}</div>
          <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[10px] text-ink-faint">
            {!multiTrack || nodeSectors.get(row.targetNodeId) === undefined ? null : (
              <SectorBadge sector={nodeSectors.get(row.targetNodeId) ?? 'ai'} />
            )}
            {row.isSecret ? <Tag tone="warn" size="sm">secret</Tag> : <Tag size="sm">published</Tag>}
            <span>{row.status}</span>
          </div>
        </div>
      ),
      sortable: true,
      sortValue: (row) => nodeTitles.get(row.targetNodeId) ?? row.targetNodeId,
    },
    {
      key: 'progress',
      header: 'Progress',
      width: '20%',
      render: (row) => (
        <ProgressBar value={row.progress} tone={row.setbacks > 0 ? 'warn' : 'brand'} valueLabel={formatPct(row.progress)} />
      ),
      sortable: true,
      sortValue: (row) => row.progress,
    },
    {
      key: 'confidence',
      header: 'Internal confidence',
      align: 'right',
      render: (row) => formatPct(row.internalConfidence),
      sortable: true,
      sortValue: (row) => row.internalConfidence,
    },
    {
      key: 'budget',
      header: 'Budget',
      align: 'right',
      hideOnMobile: true,
      render: (row) => formatMoney(row.budgetQuarterly),
      sortable: true,
      sortValue: (row) => row.budgetQuarterly,
    },
    {
      key: 'compute',
      header: 'Compute',
      align: 'right',
      hideOnMobile: true,
      render: (row) => row.computeAllocated,
      sortable: true,
      sortValue: (row) => row.computeAllocated,
    },
    {
      key: 'people',
      header: 'Researchers',
      align: 'right',
      hideOnMobile: true,
      render: (row) => row.talentAllocated,
      sortable: true,
      sortValue: (row) => row.talentAllocated,
    },
    {
      key: 'clock',
      header: 'Quarters',
      align: 'right',
      render: (row) => `${row.quartersElapsed}/${row.expectedQuarters}`,
      sortable: true,
      sortValue: (row) => row.expectedQuarters - row.quartersElapsed,
    },
  ];

  const rivalColumns: readonly Column<ResearchProject>[] = [
    {
      key: 'company',
      header: 'Company',
      render: (row) => <span className="text-ink">{rivalNames.get(row.companyId) ?? row.companyId}</span>,
      sortable: true,
      sortValue: (row) => rivalNames.get(row.companyId) ?? row.companyId,
    },
    {
      key: 'target',
      header: 'Pursuing',
      render: (row) => nodeTitles.get(row.targetNodeId) ?? row.targetNodeId,
      sortable: true,
      sortValue: (row) => nodeTitles.get(row.targetNodeId) ?? row.targetNodeId,
    },
    {
      key: 'progress',
      header: 'Progress',
      width: '22%',
      render: (row) => <ProgressBar value={row.progress} tone="info" valueLabel={formatPct(row.progress)} />,
      sortable: true,
      sortValue: (row) => row.progress,
    },
    {
      key: 'status',
      header: 'Status',
      align: 'right',
      render: (row) => row.status,
      sortable: true,
      sortValue: (row) => row.status,
    },
    {
      key: 'started',
      header: 'Started',
      align: 'right',
      hideOnMobile: true,
      render: (row) => quarterLabel(session.startYear, row.startedQuarter),
      sortable: true,
      sortValue: (row) => row.startedQuarter,
    },
  ];

  return (
    <>
      <PageHeader
        title="Frontier Map"
        eyebrow={`${quarterLabel(session.startYear, session.quarter)} · graph v${graph.version}`}
        subtitle="What this world currently believes the technological future might look like. Every node carries an epistemic state and a confidence, not a boolean."
        actions={
          <>
            <Tag tone="brand">{graph.nodes.length} technologies</Tag>
            {moves.length === 0 ? null : (
              <Tag tone="info" dot>
                {moves.length} moved last quarter
              </Tag>
            )}
          </>
        }
      />

      <div className="grid grid-cols-2 gap-2.5 sm:gap-3 lg:grid-cols-4">
        <StatCard iconName="flask" label="Programmes" value={ownProjects.filter((p) => p.status === 'active').length} unit="active" hint={`${ownProjects.length} of yours on the books`} />
        <StatCard
          iconName="coins"
          label="Envelope"
          value={formatMoney(envelope)}
          hint={queued.some((action) => action.intent.type === 'set_research_budget') ? 'Stated by a queued action' : 'Archetype policy share of revenue'}
        />
        <StatCard
          iconName="people"
          label="Researchers"
          value={`${committedResearchers} / ${company.employees.researchers}`}
          tone={committedResearchers > company.employees.researchers ? 'loss' : undefined}
          hint="The binding constraint, more often than money"
          href="/people"
        />
        <StatCard
          iconName="compass"
          label="Your edge"
          value={edgeNodes.length}
          unit="nodes"
          hint="Where your confidence differs from the market's"
          onClick={() => setFilter('edge')}
        />
      </div>

      <Panel
        iconName="network"
        iconTone="brand"
        title="The map"
        subtitle="Layered by dependency depth and ordered to minimise crossings, so it reads left to right. The same graph always lays out the same way. Point at a node to light its dependencies."
        actions={
          <TabBar
            className="[&>button]:min-h-11 sm:[&>button]:min-h-0"
            variant="segmented"
            ariaLabel="Map filter"
            value={filter}
            onChange={(id) => setFilter(id as MapFilter)}
            tabs={[
              { id: 'all', label: 'All' },
              { id: 'edge', label: 'Your edge', badge: edgeNodes.length },
              { id: 'mine', label: 'Your programmes', badge: ownProjects.length },
              { id: 'moved', label: 'Moved', badge: moves.length, disabled: moves.length === 0 },
            ]}
          />
        }
      >
        {!multiTrack ? null : (
          <div className="mb-3">
            <SectorFilter
              sectors={trackSectors}
              value={trackSector}
              onChange={setTrackSector}
              counts={trackCounts}
              totalLabel="Every track"
            />
          </div>
        )}

        {graph.nodes.length === 0 ? (
          <EmptyState icon="network" title="The map is empty" message="No technology is visible to this company yet." />
        ) : (
          <FrontierMap
            graph={graph}
            companyId={company.id}
            selectedNodeId={selectedId}
            onSelect={setSelectedId}
            changedNodeIds={changedNodeIds}
            highlightIds={highlightIds}
            showSectors={multiTrack}
          />
        )}

        {/* The map is 900px of graph in a frame that a phone can only show a
            slice of, so say so once rather than leaving the pan to be
            discovered. */}
        <p className="mt-2 flex items-center gap-1.5 text-[11px] text-ink-faint sm:hidden">
          <Icon name="back" size={13} accent="current" />
          Drag the map to explore it. Tap a technology for its card.
        </p>

        {!multiTrack ? null : (
          <div className="mt-3 border-t border-hair pt-3">
            <div className="label-caps mb-2">Tracks</div>
            <div className="flex flex-wrap gap-1.5">
              {tracks.map((track) => (
                <SectorBadge key={`${track.sector}_${track.title}`} sector={track.sector} />
              ))}
            </div>
            <p className="mt-1.5 text-[11px] leading-relaxed text-ink-faint">
              The stripe along the top of a card is its track. Dependencies cross tracks freely — energy is upstream of
              almost everything, so its lane reaches into all of them.
            </p>
          </div>
        )}

        <div className="mt-3 border-t border-hair pt-3">
          <div className="label-caps mb-2">Epistemic state</div>
          <div className="flex flex-wrap gap-1.5">
            {Object.entries(STATE_STYLE).map(([state, style]) => (
              <Tag key={state} tone={style.tone} dot title={style.blurb}>
                {style.label}
              </Tag>
            ))}
          </div>
          <div className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1 text-[11px] leading-relaxed text-ink-faint sm:text-[10px]">
            {Object.entries(EDGE_STYLE).map(([kind, style]) => (
              <span key={kind}>
                <span className="text-ink-dim">{style.label}</span> — {style.blurb}
              </span>
            ))}
            <span>
              <span className="text-ink-dim">Accent bar and dot</span> — epistemic state. <span className="text-ink-dim">Bar</span> — public
              confidence, with <span className="text-ink-dim">▲</span> your own conviction. <span className="text-ink-dim">Size</span> — compute
              intensity. <span className="text-ink-dim">✓</span> demonstrated, <span className="text-ink-dim">★</span> invented in session,{' '}
              <span className="text-ink-dim">▣</span> secret, <span className="text-ink-dim">Δ</span> moved last quarter.
            </span>
          </div>
        </div>
      </Panel>

      {moves.length === 0 ? null : (
        <Panel iconName="gauge" iconTone="info" title="Belief moved" subtitle="What the last resolved quarter did to the map">
          <div className="space-y-1.5">
            {moves.map((move) => (
              <button
                key={move.nodeId}
                type="button"
                onClick={() => setSelectedId(move.nodeId)}
                className="raised-surface flex w-full flex-wrap items-center justify-between gap-2 px-3 py-2 text-left transition-colors hover:border-hair-strong"
              >
                <span className="min-w-0 flex-1 truncate text-[13px] text-ink sm:text-[12px]">{move.title}</span>
                <span className="figure text-[11px] text-ink-dim">
                  {formatPct(move.previous)} <span className="text-ink-faint">→</span> {formatPct(move.next)}
                </span>
                <DeltaBadge value={move.next - move.previous} format="points" />
                {move.previousStatus === move.nextStatus ? null : (
                  <Tag tone="info">
                    {move.previousStatus.replace(/_/g, ' ')} → {move.nextStatus.replace(/_/g, ' ')}
                  </Tag>
                )}
                {move.windowShiftYears === 0 ? null : (
                  <Tag tone={move.windowShiftYears < 0 ? 'gain' : 'warn'}>
                    window {move.windowShiftYears > 0 ? '+' : ''}
                    {move.windowShiftYears}y
                  </Tag>
                )}
              </button>
            ))}
          </div>
        </Panel>
      )}

      {/* --- what each sector is reaching for ---------------------------------
          One lane per sector, with the count of nodes on it and how many the
          world already believes in. Absent in a single-track world, where the
          lane and the map are the same thing. */}
      {!multiTrack ? null : (
        <Panel
          iconName="compass"
          iconTone="info"
          title="Sector tracks"
          subtitle="What each part of the economy is currently trying to reach. Selecting a track lights its nodes on the map."
        >
          <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
            {tracks.map((track) => {
              const demonstrated = track.nodes.filter((node) => node.achievedByCompanyId !== null).length;
              const active = trackSector === track.sector;
              return (
                <button
                  key={`${track.sector}_${track.title}`}
                  type="button"
                  onClick={() => setTrackSector(active ? null : track.sector)}
                  className={`raised-surface tap-target flex w-full flex-col items-start gap-1.5 px-3 py-2.5 text-left transition-colors hover:border-hair-strong ${
                    active ? 'border-brand/30 bg-brand-wash' : ''
                  }`}
                >
                  <span className="flex w-full flex-wrap items-center justify-between gap-1.5">
                    <SectorBadge sector={track.sector} />
                    <span className="figure text-[10px] text-ink-faint">
                      {demonstrated}/{track.nodes.length} demonstrated
                    </span>
                  </span>
                  <span className="text-[12.5px] font-semibold text-ink">{track.title}</span>
                  <span className="text-[11px] leading-relaxed text-ink-faint">{track.summary}</span>
                </button>
              );
            })}
          </div>
        </Panel>
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        <Panel iconName="flask" title="Research programmes" subtitle="Yours, secret ones included" className="lg:col-span-2" flush>
          <DataTable
            columns={ownColumns}
            rows={ownProjects}
            rowKey={(row) => row.id}
            onRowClick={(row) => setSelectedId(row.targetNodeId)}
            initialSort={{ key: 'progress', direction: 'desc' }}
            dense
            cardMode="auto"
            cardTitleKey="target"
            empty={
              <div className="p-4">
                <EmptyState
                  icon="flask"
                  title="No programme is running"
                  message="Open a node on the map and start one. Researchers are usually the binding constraint, not money."
                />
              </div>
            }
          />
        </Panel>

        <Panel iconName="gauge" title="Allocation" subtitle="What research can draw on this quarter">
          <div className="space-y-3">
            <ProgressBar
              label="Compute committed"
              value={Math.min(committedCompute, Math.max(held, committedCompute, 1))}
              max={Math.max(held, committedCompute, 1)}
              tone={committedCompute > held * company.compute.trainingAllocation ? 'warn' : 'brand'}
              valueLabel={`${Math.round(committedCompute)} / ${Math.round(held)} held`}
            />
            <Meter value={company.employees.researchers === 0 ? 0 : (committedResearchers / company.employees.researchers) * 100} label="Researchers assigned" tone="info" />
          </div>

          <div className="mt-4 border-t border-hair pt-3">
            {/* The validator clamps the envelope to uncommitted cash, so cash
                is the slider's honest ceiling; the untouched slider shows the
                current envelope and Set stays disabled until it moves. */}
            <SliderField
              label="Research budget this quarter"
              value={budgetValue}
              onChange={(next) => setBudgetText(String(next))}
              min={0}
              max={budgetMax}
              step={roundStep(budgetMax)}
              format={formatMoney}
              chips
            />
            <div className="mt-2 flex justify-end">
              <button
                type="button"
                className="btn btn-primary btn-sm tap-target w-full px-4 sm:w-auto sm:min-h-0"
                disabled={budgetText === ''}
                onClick={applyBudget}
              >
                Set
              </button>
            </div>
            <p className="mt-1.5 text-[11px] leading-relaxed text-ink-faint">
              Currently {formatMoney(envelope)}. Individual programmes draw from this envelope in priority order.
            </p>
            {budgetResult === null ? null : (
              <div className="mt-2">
                <ValidationBanner result={budgetResult} compact />
              </div>
            )}
          </div>

          <div className="mt-4 border-t border-hair pt-3">
            <SliderField
              label="Training share of compute"
              value={trainingSplit}
              onChange={setTrainingSplit}
              min={0}
              max={1}
              step={0.05}
              format={formatPct}
              exact={false}
            />
            <p className="mt-1.5 text-[11px] leading-relaxed text-ink-faint">
              Serving takes the remainder. Currently {formatPct(company.compute.trainingAllocation)} — pivoting compute out of training into
              inference is how a company survives a shortage.
            </p>
            <div className="mt-2 flex justify-end">
              <button type="button" className="btn btn-sm tap-target w-full sm:w-auto sm:min-h-0" onClick={applySplit}>
                Queue reallocation
              </button>
            </div>
            {splitResult === null ? null : (
              <div className="mt-2">
                <ValidationBanner result={splitResult} compact />
              </div>
            )}
          </div>
        </Panel>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel iconName="globe" title="Published rival programmes" subtitle="A secret programme is absent here, not redacted" flush>
          <DataTable
            columns={rivalColumns}
            rows={rivalProjects}
            rowKey={(row) => row.id}
            onRowClick={(row) => setSelectedId(row.targetNodeId)}
            initialSort={{ key: 'progress', direction: 'desc' }}
            dense
            cardMode="auto"
            cardTitleKey="company"
            empty={
              <div className="p-4">
                <EmptyState
                  icon="globe"
                  title="Nobody has published a programme"
                  message="Rivals may still be running work you cannot see. Secret programmes do not appear on this list at all — that is the point of keeping one."
                />
              </div>
            }
          />
        </Panel>

        <InnovationPanel session={session} company={company} graph={graph} researchEnvelopeUsd={envelope} computeUnits={Math.round(held)} />
      </div>

      <NodeDrawer
        session={session}
        graph={graph}
        company={company}
        node={selectedNode}
        projects={ownProjects}
        onClose={() => setSelectedId(null)}
        onSelect={setSelectedId}
      />
    </>
  );
}
