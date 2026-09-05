'use client';

/**
 * Research, world 3: **the map**.
 *
 * The Frontier Map in the node economy is not a separate graph of beliefs about
 * the future — it is the node table itself, projected. Every card is a thing
 * somebody could make, and researching one is how a company comes to own it.
 * That is why this is the same canvas the Products screen draws: one picture at
 * two zooms, so the chain a founder builds and the map they explore are visibly
 * the same object.
 *
 * The four filters answer the four questions a founder actually has: what do I
 * make, what could I make now, what would I have to research, and who else is
 * in this. `standingOf` decides each, per company — world 2's global
 * `status === "achieved"` is gone, and with it the state where a node was
 * locked for everybody including the incumbents already selling it.
 *
 * A rival's relationships are on this map because they are public. A rival's
 * prices, unit costs and margins are not on it, because `nodeMapFor` does not
 * carry them.
 */

import { useMemo, useState } from 'react';
import type { Sector } from '@frontier/contracts';
import { SECTORS } from '@frontier/contracts';
import { chainNodeIds, neighbourhoodNodeIds, nodeMapFor, type NodeMapView } from '@frontier/simulation';
import { EmptyState, Icon, Panel, SectorFilter, TabBar } from '@/components/ui';
import { Canvas, buildCanvas, standingOf, type NodeStanding } from '@/components/screens/graph';

export type MapLens = 'mine' | 'ready' | 'locked' | 'all';

const LENS_STANDING: Readonly<Record<Exclude<MapLens, 'all'>, NodeStanding>> = {
  mine: 'yours',
  ready: 'ready',
  locked: 'locked',
};

export interface NodeMapPanelProps {
  readonly session: Parameters<typeof nodeMapFor>[0];
  readonly companyId: string;
  readonly selectedNodeId: string | null;
  readonly onSelect: (nodeId: string) => void;
}

export function NodeMapPanel({ session, companyId, selectedNodeId, onSelect }: NodeMapPanelProps): React.JSX.Element {
  const [lens, setLens] = useState<MapLens>('all');
  const [sector, setSector] = useState<Sector | null>(null);
  const [focused, setFocused] = useState<string | null>(null);

  const view: NodeMapView = useMemo(() => nodeMapFor(session, companyId), [session, companyId]);

  const counts = useMemo(() => {
    const out = { mine: 0, ready: 0, locked: 0, all: view.nodes.length };
    for (const entry of view.nodes) {
      const standing = standingOf(entry);
      if (standing === 'yours') out.mine += 1;
      else if (standing === 'ready') out.ready += 1;
      else if (standing === 'locked') out.locked += 1;
    }
    return out;
  }, [view]);

  const sectorCounts = useMemo(() => {
    const out: Partial<Record<Sector, number>> = {};
    for (const entry of view.nodes) out[entry.sector] = (out[entry.sector] ?? 0) + 1;
    return out as Readonly<Record<Sector, number>>;
  }, [view]);

  // Which nodes are drawn. A lens filters, a sector filters, and the two
  // compose — but the viewer's own lines are always kept, because a map that
  // hid what a founder already makes would be answering somebody else's
  // question.
  const nodeIds = useMemo(() => {
    const mine = new Set(view.nodes.filter((entry) => entry.yourProductId !== null).map((entry) => entry.nodeId));
    return view.nodes
      .filter((entry) => {
        if (mine.has(entry.nodeId)) return true;
        if (sector !== null && entry.sector !== sector) return false;
        if (lens === 'all') return true;
        return standingOf(entry) === LENS_STANDING[lens];
      })
      .map((entry) => entry.nodeId);
  }, [view, lens, sector]);

  const model = useMemo(() => buildCanvas(view, { view: 'map', nodeIds }), [view, nodeIds]);

  const chain = useMemo(() => chainNodeIds(view), [view]);
  const focus = focused === null ? (chain.length > 0 ? chain : null) : neighbourhoodNodeIds(view, focused);

  function select(nodeId: string): void {
    setFocused(nodeId);
    onSelect(nodeId);
  }

  return (
    <Panel
      iconName="network"
      iconTone="brand"
      title="The map"
      subtitle="One graph. What you make, what you could make now, and what somebody else owns. Tap a card for its details."
      actions={
        <TabBar
          className="[&>button]:min-h-11 sm:[&>button]:min-h-0"
          variant="segmented"
          ariaLabel="Map filter"
          value={lens}
          onChange={(id) => setLens(id as MapLens)}
          tabs={[
            { id: 'all', label: 'All', badge: counts.all },
            { id: 'mine', label: 'Yours', badge: counts.mine },
            { id: 'ready', label: 'Ready', badge: counts.ready },
            { id: 'locked', label: 'To research', badge: counts.locked },
          ]}
        />
      }
    >
      <div className="mb-3">
        <SectorFilter sectors={SECTORS} value={sector} onChange={setSector} counts={sectorCounts} totalLabel="Every sector" />
      </div>

      {model.nodes.length === 0 ? (
        <EmptyState icon="network" title="Nothing here" message="No node matches this filter. Widen it, or clear the sector." />
      ) : (
        <Canvas
          model={model}
          focusNodeIds={focus}
          selectedNodeId={selectedNodeId}
          onSelectNode={select}
          height={440}
        />
      )}

      <p className="mt-2 flex items-center gap-1.5 text-[11px] text-ink-faint">
        <Icon name="back" size={13} accent="current" />
        Drag to pan, pinch or use the buttons to zoom. Tapping a card snaps the view to it and everything one wire away.
      </p>
      {focused === null ? null : (
        <button type="button" className="btn mt-2 min-h-11" onClick={() => setFocused(null)}>
          Back to your chain
        </button>
      )}
    </Panel>
  );
}
