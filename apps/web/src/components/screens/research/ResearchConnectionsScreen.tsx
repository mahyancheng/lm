'use client';

/**
 * Research, world 3: **the same picture as Products, asked of technology**.
 *
 * Three columns. On the left what this company already holds, grouped by
 * sector, solid where it runs a line on it and dashed where it merely owns it.
 * In the middle the company. On the right what one programme would reach, with
 * the cost and the quarters on the pill and, nested under each on a bracket,
 * what holding it would let the company sell. Beneath the picture, the nodes
 * one requirement short and the three ways in.
 *
 * The old Frontier Map drew the whole ninety-row table and asked a founder to
 * find themselves in it. This asks the smaller question a founder actually has
 * — *from where I stand, what is one programme away, and what does it get me* —
 * and every figure on it is the engine's: `researchMapFor` calls `effortPlan`,
 * `programmeForecast` and `runningForecast` with the same standard preset the
 * drawer would queue, so a forecast here and the programme it becomes cannot
 * disagree.
 *
 * The drawing is the Connections screen's own — `layoutConnections`,
 * `ConnectionsDiagram`, `ConnectionPill`, the same constants and the same
 * wires — so the two pictures are one picture asked two questions, and a
 * change to a pill lands on both. What is local is the *model*: this file
 * turns `researchDiagram`'s pills into the renderer's `PillModel`s, and its
 * five taps — open the node drawer, open a line on Products, open the launch
 * flow, expand a sector, show every option — are five members of the shared
 * `PillAction` union rather than a vocabulary of their own.
 *
 * The company is `useActiveCompany`, never the founding company: directing a
 * subsidiary must show the subsidiary's own holdings and its own programmes.
 */

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Sector } from '@frontier/contracts';
import { researchMapFor, researchProjectsForCompany } from '@frontier/simulation';
import { EmptyState, Panel, Tag, cx } from '@/components/ui';
import { setPendingLine, useActiveCompany, useSession } from '@/lib/game';
import { NodeLaunchModal } from '@/components/screens/products/NodeLaunchModal';
import { layoutConnections, type LayoutGroup, type LayoutPill } from '@/components/screens/connections/layout';
import { ConnectionsDiagram } from '@/components/screens/connections/ConnectionsDiagram';
import type { ConnectionsModel, PillAction, PillGroup, PillModel } from '@/components/screens/connections/model';
import { useContainerWidth } from '@/components/screens/connections/useContainerWidth';
import { lockedRow, researchDiagram, type ResearchDiagramModel, type ResearchGroup, type ResearchPill } from './researchModel';
import { sheetHref } from '@/lib/sheets';

/* -------------------------------------------------------------------------- */
/*  Model → layout                                                             */
/* -------------------------------------------------------------------------- */

/**
 * The picture's pills as the shared layout wants them: nested unlocks flattened
 * after their parent, which is how `layoutConnections` reads a bracket.
 */
export function layoutGroupsOf(groups: readonly ResearchGroup[]): readonly LayoutGroup[] {
  return groups.map((group) => {
    const pills: LayoutPill[] = [];
    for (const pill of group.pills) {
      pills.push({ key: pill.key, state: pill.state });
      for (const child of pill.children) pills.push({ key: child.key, state: child.state, nested: true, parentKey: pill.key });
    }
    // No recipe line here: a research group is "Under way" or a sector, and
    // neither has a quantity per unit to print under it.
    return { key: group.key, header: group.header, subheader: null, pills };
  });
}

/**
 * One research pill as the shared renderer wants it.
 *
 * The quarters take the wire edge, where the Products picture puts a price:
 * both are the one number that decides whether to tap, and both are read off
 * the same tag in the same place on both screens. The rest of the line — the
 * cost range, what a programme is short of, what a held node is — is the
 * `detail` beside it, written to the same fourteen characters.
 */
function pillModelOf(pill: ResearchPill): PillModel {
  return {
    key: pill.key,
    state: pill.state,
    glyph: pill.sector === null ? { kind: 'icon', name: 'compass' } : { kind: 'sector', sector: pill.sector },
    name: pill.label,
    figure: pill.figure === '' ? null : pill.figure,
    detail: pill.data === '' ? null : pill.data,
    ringPct: pill.ringPct,
    action: pill.action,
    ariaLabel: ariaLabelOf(pill),
  };
}

/** A group and its nested unlocks, flattened the same way the layout flattens them. */
function pillGroupOf(group: ResearchGroup): PillGroup {
  const pills: PillModel[] = [];
  for (const pill of group.pills) {
    pills.push(pillModelOf(pill));
    for (const child of pill.children) pills.push({ ...pillModelOf(child), nested: true, parentKey: pill.key });
  }
  return { key: group.key, header: group.header, subheader: null, required: false, moreLabel: null, pills };
}

/**
 * The whole picture as `ConnectionsDiagram` reads it.
 *
 * The hub is the company itself: its name on the disc, its counts beneath, no
 * margin badge (research has no margin) and no tap — the sentence that reads
 * the picture is the Panel's subtitle, because a 104-point label box holds a
 * name and not a sentence.
 */
export function connectionsModelOf(model: ResearchDiagramModel, hubName: string, hubArchetype: string | null): ConnectionsModel {
  return {
    left: model.left.map(pillGroupOf),
    right: model.right.map(pillGroupOf),
    hub: {
      name: hubName,
      nodeLabel: hubName,
      figures: model.hub.figureParts,
      marginPct: null,
      showOutput: model.right.length > 0,
      companyId: '',
      companyName: hubName,
      archetype: hubArchetype,
      own: true,
      action: null,
      ariaLabel: hubName,
    },
  };
}

/* -------------------------------------------------------------------------- */
/*  The screen                                                                 */
/* -------------------------------------------------------------------------- */

export interface ResearchConnectionsScreenProps {
  /** Open the node drawer — where a programme is started. */
  readonly onOpenNode: (nodeId: string) => void;
  /** Node ids the drawer can actually open, so no pill is a dead tap. */
  readonly openableNodeIds: ReadonlySet<string>;
}

export function ResearchConnectionsScreen({ onOpenNode, openableNodeIds }: ResearchConnectionsScreenProps): React.JSX.Element {
  const session = useSession();
  const company = useActiveCompany();
  const router = useRouter();
  const { ref, width } = useContainerWidth();

  const [expanded, setExpanded] = useState<ReadonlySet<Sector>>(() => new Set<Sector>());
  const [showAll, setShowAll] = useState(false);
  const [launchNodeId, setLaunchNodeId] = useState<string | null>(null);

  // A subsidiary's own programmes: `researchProjectsForCompany` gives this
  // company's work plus everybody's published work, and `researchMapFor`
  // re-filters to this company, so a rival's public programme is never drawn
  // as mine.
  const view = useMemo(() => researchMapFor(session, company, researchProjectsForCompany(session, company.id)), [session, company]);
  const model = useMemo(() => researchDiagram(view, { expandedSectors: expanded, showAllOptions: showAll }), [view, expanded, showAll]);
  const layout = useMemo(
    () =>
      layoutConnections({
        width,
        left: layoutGroupsOf(model.left),
        right: layoutGroupsOf(model.right),
        hub: { showOutput: model.right.length > 0 },
      }),
    [width, model],
  );
  const picture = useMemo(() => connectionsModelOf(model, company.name, company.archetype), [model, company]);
  const locked = useMemo(() => view.locked.map(lockedRow), [view.locked]);

  /**
   * A pill's tap. The model says which; this does it. The vocabulary is shared
   * with the Products picture, so the kinds that belong to that screen fall
   * through rather than being asserted impossible.
   */
  function act(action: PillAction): void {
    if (action.kind === 'node') {
      // An unlock the reader's own graph never projected opens the programme
      // that would reach it, so no pill is a dead tap.
      onOpenNode(openableNodeIds.has(action.nodeId) ? action.nodeId : action.fallbackNodeId);
      return;
    }
    if (action.kind === 'launch') {
      setLaunchNodeId(action.nodeId);
      return;
    }
    if (action.kind === 'products') {
      // The Connections screen takes the pending line on mount, so tapping a
      // node I already sell opens Products on *that* line rather than on
      // whichever one it happened to be showing.
      setPendingLine(action.productId);
      router.push(sheetHref('products'));
      return;
    }
    if (action.kind === 'expand') {
      // A toggle, not a ratchet: the same pill opens the sector and closes it
      // again, so a tap that grows the column by ten rows can be taken back.
      const sector = action.sector;
      setExpanded((current) => {
        const next = new Set(current);
        if (next.has(sector)) next.delete(sector);
        else next.add(sector);
        return next;
      });
      return;
    }
    if (action.kind === 'showAll') setShowAll((current) => !current);
  }

  const empty = model.left.length === 0 && model.right.length === 0;

  return (
    <>
      <Panel
        iconName="network"
        iconTone="brand"
        title="Your research"
        subtitle={model.hub.label}
        actions={
          <>
            <Tag tone="brand">{model.hub.figures}</Tag>
            {model.hiddenOptionCount === 0 ? null : <Tag tone="info">{model.hiddenOptionCount} more open</Tag>}
          </>
        }
        flush
      >
        {/* Four points of horizontal padding, not sixteen: the picture's whole
            arithmetic is the width of this box, and each point of padding is
            half a point off every pill's name. */}
        <div ref={ref} className="min-w-0 overflow-hidden px-1 py-3">
          {empty ? (
            <EmptyState
              icon="flask"
              title="Nothing to draw yet"
              message="This company holds no nodes and has nothing open to research. Buy or licence a node and both columns fill in."
            />
          ) : (
            <ConnectionsDiagram model={picture} layout={layout} onAct={act} />
          )}
        </div>
      </Panel>

      {locked.length === 0 ? null : (
        <Panel
          iconName="compass"
          iconTone="warn"
          title="Locked — one step away"
          subtitle="One requirement short. Research it, licence it, or buy the thing itself."
        >
          <div className="space-y-2">
            {locked.map((row) => (
              <div key={row.nodeId} className="raised-surface px-3 py-2.5">
                <div className="text-[12.5px] leading-tight font-semibold text-ink">
                  {row.label} <span className="font-normal text-ink-faint">— {row.needs}</span>
                </div>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {row.routes.map((route) => {
                    const target = route.nodeId;
                    if (route.available && target !== null) {
                      return (
                        <button
                          key={route.kind}
                          type="button"
                          onClick={() => onOpenNode(target)}
                          className="tap-target inline-flex items-center rounded-pill border border-hair bg-panel px-3 text-[11px] font-semibold text-ink transition-colors hover:bg-raised sm:min-h-0 sm:py-1"
                        >
                          {route.text}
                        </button>
                      );
                    }
                    return (
                      <span
                        key={route.kind}
                        className={cx(
                          'inline-flex items-center rounded-pill border border-hair px-3 py-1 text-[11px] font-semibold',
                          route.available ? 'bg-panel text-ink-dim' : 'bg-raised text-ink-faint',
                        )}
                      >
                        {route.text}
                      </span>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </Panel>
      )}

      <NodeLaunchModal open={launchNodeId !== null} onClose={() => setLaunchNodeId(null)} initialNodeId={launchNodeId} />
    </>
  );
}

/**
 * What tapping this pill does, said out loud for a screen reader.
 *
 * The pill's own text is written to fourteen characters; this is not, so it is
 * where a saturating forecast gets said in words rather than as a bound.
 */
export function ariaLabelOf(pill: ResearchPill): string {
  const action = pill.action;
  if (action.kind === 'products') return `${pill.label} — open this line on Products`;
  if (action.kind === 'launch') return `${pill.label} — open a line on it`;
  if (action.kind === 'expand') return `${pill.label} — show or hide the rest of this sector`;
  if (action.kind === 'showAll') return pill.label;
  const forecast = pill.figure.startsWith('>')
    ? `more than ${pill.figure.slice(1)} at standard effort — not on this resourcing`
    : pill.figure === ''
      ? ''
      : pill.figure;
  const parts = [forecast, pill.data].filter((part) => part !== '');
  return parts.length === 0 ? `${pill.label} — open it` : `${pill.label} — ${parts.join(' · ')}`;
}
