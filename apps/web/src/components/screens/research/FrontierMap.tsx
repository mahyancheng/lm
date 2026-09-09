'use client';

/**
 * The Frontier Map.
 *
 * The most visibly generative surface in the game, and therefore the one where
 * the safety rule matters most: **no generated code executes here**. The model
 * produces a typed `TechGraph`; this component draws it with trusted React and
 * SVG, and nothing on the page is ever `dangerouslySetInnerHTML`.
 *
 * The graph handed in is already `PlayerView.techGraph` — public nodes plus the
 * player's own, with `confidenceByCompany` cut to the player's entry and the
 * public figure. No rival's private conviction reaches this file, so the
 * conviction tick on a node is always the viewer's own.
 *
 * **The drawing rule.** A node is a calm white card carrying **one state and
 * one line**: Locked (and what is missing), Available, In progress (how far and
 * how long is left) or Done (and by whom). That state rides a 4px left accent
 * bar and the line along the bottom, and nothing else on the card carries a
 * colour or a number — the epistemic state, the confidence figures, the novelty
 * and the arrival window moved into the card's Details, because none of them
 * told a founder what to do next. Edges live at a low opacity and are told
 * apart by form, not colour. The one moment the map uses colour loudly is the
 * moment you point at something: the node under the pointer, its direct
 * neighbours and the edges between them come up to full strength and everything
 * else recedes.
 */

import { useId, useMemo, useState } from 'react';
import type { TechGraph, TechNode } from '@frontier/contracts';
import { SECTOR_META } from '@frontier/contracts';
import { SECTOR_TINT, TONE_VAR, type Tone } from '@/components/ui';
import { EDGE_STYLE, STATE_STYLE, layoutGraph, wrapTitle, type LaidOutNode } from './graphLayout';
import { NODE_STATE_TONE, type NodeState } from './nodeState';

export interface FrontierMapProps {
  readonly graph: TechGraph;
  readonly selectedNodeId: string | null;
  readonly onSelect: (nodeId: string) => void;
  /** Nodes whose public confidence moved when the last quarter resolved. */
  readonly changedNodeIds: ReadonlySet<string>;
  /** Node ids to keep at full strength; everything else dims. Null shows all. */
  readonly highlightIds: ReadonlySet<string> | null;
  /**
   * Draw the sector stripe along the top of every card.
   *
   * Off for a world-version-1 graph, where every node is AI and a stripe would
   * be the same colour forty-two times. The stripe is deliberately a different
   * shape and a different edge from the epistemic accent bar — the left edge
   * and the state dot still carry the state, and nothing else does.
   */
  readonly showSectors?: boolean;
  /**
   * The four-state reading of every node, keyed by node id.
   *
   * Computed once by the screen from the engine's own functions
   * (`unmetDependencies`, `runningForecast`) and handed down, so the map draws
   * a state it was given rather than deriving one of its own.
   */
  readonly states: ReadonlyMap<string, NodeState>;
}

/** The pale tint of a tone. Only `achieved` ever uses one. */
const TONE_WASH_VAR: Readonly<Record<Tone, string>> = {
  neutral: 'var(--color-raised)',
  gain: 'var(--color-gain-wash)',
  loss: 'var(--color-loss-wash)',
  warn: 'var(--color-warn-wash)',
  info: 'var(--color-info-wash)',
  brand: 'var(--color-brand-wash)',
};

/** Transform/opacity/stroke only, and the global reduced-motion rule kills it. */
const EASE = 'opacity 160ms ease-out, stroke 160ms ease-out, stroke-width 160ms ease-out';

/** Mean advance of the title face at 10.5px semibold, measured in-browser. */
const TITLE_CHAR_WIDTH = 6.7;

export function FrontierMap({
  graph,
  selectedNodeId,
  onSelect,
  changedNodeIds,
  highlightIds,
  showSectors = false,
  states,
}: FrontierMapProps): React.JSX.Element {
  const markerId = useId().replace(/:/g, '');
  const layout = useMemo(() => layoutGraph(graph), [graph]);
  const [focusId, setFocusId] = useState<string | null>(null);

  /** The node under the pointer or under keyboard focus, plus its 1-hop world. */
  const focus = useMemo(() => {
    if (focusId === null) return null;
    const nodes = new Set<string>([focusId]);
    const edges = new Set<string>();
    for (const laid of layout.edges) {
      if (laid.edge.from !== focusId && laid.edge.to !== focusId) continue;
      edges.add(laid.key);
      nodes.add(laid.edge.from);
      nodes.add(laid.edge.to);
    }
    return { nodes, edges };
  }, [focusId, layout.edges]);

  // Lit edges paint last so a highlighted dependency runs over its quiet peers.
  const drawOrder = useMemo(() => {
    const lit = focus;
    if (lit === null) return layout.edges;
    return [...layout.edges].sort((a, b) => Number(lit.edges.has(a.key)) - Number(lit.edges.has(b.key)));
  }, [layout.edges, focus]);

  return (
    <div className="scroll-x">
      <svg
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        width={layout.width}
        height={layout.height}
        role="img"
        aria-label={`Frontier Map, version ${graph.version}: ${graph.nodes.length} technologies in ${layout.layerCount} dependency layers, drawn left to right.`}
        style={{ minWidth: layout.width, maxWidth: '100%', height: 'auto' }}
      >
        <defs>
          <marker id={`${markerId}-arrow`} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M 0 1 L 7 4 L 0 7 z" fill="var(--color-ink-faint)" />
          </marker>
          <marker id={`${markerId}-arrow-lit`} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M 0 1 L 7 4 L 0 7 z" fill="var(--color-brand-strong)" />
          </marker>
        </defs>

        {/* --- edges under nodes, always ------------------------------------ */}
        <g fill="none" strokeLinecap="round">
          {drawOrder.map((laid) => {
            const style = EDGE_STYLE[laid.edge.kind];
            const lit = focus !== null && focus.edges.has(laid.key);
            const filtered =
              highlightIds !== null && !(highlightIds.has(laid.edge.from) && highlightIds.has(laid.edge.to));
            const hushed = focus !== null && !lit;
            const opacity = lit ? 1 : style.opacity * (hushed ? 0.16 : filtered ? 0.25 : 1);
            return (
              <path
                key={laid.key}
                d={laid.path}
                stroke={lit ? 'var(--color-brand-strong)' : 'var(--color-ink-faint)'}
                strokeWidth={(lit ? 1.6 : 1) + laid.edge.strength * 0.7}
                strokeDasharray={style.dash}
                opacity={opacity}
                markerEnd={style.arrow ? `url(#${markerId}-arrow${lit ? '-lit' : ''})` : undefined}
                style={{ transition: EASE }}
              />
            );
          })}
        </g>

        {/* --- nodes -------------------------------------------------------- */}
        <g>
          {layout.nodes.map((laid) => (
            <MapNode
              key={laid.node.id}
              laid={laid}
              state={states.get(laid.node.id) ?? { kind: 'available', line: 'Available', progress: null }}
              showSector={showSectors}
              selected={laid.node.id === selectedNodeId}
              changed={changedNodeIds.has(laid.node.id)}
              lit={focus !== null && focus.nodes.has(laid.node.id)}
              // Two strengths of recession: a filter still wants its excluded
              // nodes legible as context, a focus wants them out of the way.
              dim={
                focus !== null && !focus.nodes.has(laid.node.id)
                  ? 0.2
                  : highlightIds !== null && !highlightIds.has(laid.node.id)
                    ? 0.3
                    : 1
              }
              onSelect={onSelect}
              onFocus={setFocusId}
              onRelease={(nodeId) => setFocusId((current) => (current === nodeId ? null : current))}
            />
          ))}
        </g>
      </svg>
    </div>
  );
}

interface MapNodeProps {
  readonly laid: LaidOutNode;
  /** Which of the four states this node is in, and the line that says so. */
  readonly state: NodeState;
  /** Draw the sector stripe along the card's top edge. */
  readonly showSector: boolean;
  readonly selected: boolean;
  readonly changed: boolean;
  /** In the focused node's one-hop neighbourhood. */
  readonly lit: boolean;
  /** Group opacity: 1 at full strength, lower when filtered or hushed. */
  readonly dim: number;
  readonly onSelect: (nodeId: string) => void;
  readonly onFocus: (nodeId: string) => void;
  readonly onRelease: (nodeId: string) => void;
}

/** Mean advance of the state line at 8.5px, measured in-browser. */
const LINE_CHAR_WIDTH = 4.9;

/** Cut a line to what the card can actually hold, with an ellipsis when it bites. */
export function fitLine(text: string, availablePx: number): string {
  const max = Math.max(4, Math.floor(availablePx / LINE_CHAR_WIDTH));
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function MapNode({ laid, state, showSector, selected, changed, lit, dim, onSelect, onFocus, onRelease }: MapNodeProps): React.JSX.Element {
  const node: TechNode = laid.node;
  const style = STATE_STYLE[node.status];
  const colour = TONE_VAR[NODE_STATE_TONE[state.kind]];
  const lines = wrapTitle(node.title);
  const { x, y, width, height } = laid;

  const badges: readonly { readonly glyph: string; readonly fill: string; readonly key: string }[] = [
    ...(node.originalProposerId !== null ? [{ glyph: '★', fill: 'var(--color-brand)', key: 'proposed' }] : []),
    ...(style.locked ? [{ glyph: '▣', fill: 'var(--color-warn)', key: 'secret' }] : []),
    ...(changed ? [{ glyph: 'Δ', fill: 'var(--color-info)', key: 'moved' }] : []),
  ];

  const barX = x + 13;
  const barY = y + height - 16;
  const barWidth = Math.max(40, width - 26 - badges.length * 11);
  // A bar only where a bar means something: a programme's progress. Nothing
  // else on the card is a quantity.
  const runningPct = state.kind === 'running' ? state.progress : null;

  const border = selected ? 'var(--color-brand-strong)' : lit ? 'var(--color-brand)' : 'var(--color-hair)';

  const sectorLabel = showSector ? `, ${SECTOR_META[node.sector].label} track` : '';

  return (
    <g
      className="cursor-pointer"
      opacity={dim}
      style={{ transition: EASE }}
      onClick={() => onSelect(node.id)}
      // Pointer events rather than mouse events, filtered to a real mouse: on a
      // touch screen a tap synthesises a hover it can never take back, and a tap
      // is meant to open the drawer, not leave the map half dimmed behind it.
      // Keyboard focus goes through onFocus/onBlur and is unaffected.
      onPointerEnter={(event) => {
        if (event.pointerType === 'mouse') onFocus(node.id);
      }}
      onPointerLeave={(event) => {
        if (event.pointerType === 'mouse') onRelease(node.id);
      }}
      onFocus={() => onFocus(node.id)}
      onBlur={() => onRelease(node.id)}
      role="button"
      tabIndex={0}
      aria-label={`${node.title}${sectorLabel} — ${state.line}`}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onSelect(node.id);
        }
      }}
    >
      {/* the card: white, hairline, and nothing else */}
      <rect
        x={x}
        y={y}
        width={width}
        height={height}
        rx={10}
        fill={state.kind === 'done' ? TONE_WASH_VAR[NODE_STATE_TONE.done] : 'var(--color-panel)'}
        stroke={border}
        strokeWidth={selected ? 2 : lit ? 1.5 : 1}
        style={{ transition: EASE }}
      />

      {/* the one place a colour lives: an accent bar in the state's tone */}
      <rect x={x} y={y + 8} width={4} height={height - 16} rx={2} fill={colour} />

      {/* The sector, as a stripe along the top edge. A different edge and a
          different shape from the state accent, so the two never read as one
          encoding — and absent entirely in a single-sector world. */}
      {showSector ? <rect x={x + 10} y={y + 1.5} width={width - 20} height={2.5} rx={1.25} fill={SECTOR_TINT[node.sector]} /> : null}

      {lines.map((line, index) => (
        <text key={index} x={x + 13} y={y + 16.5 + index * 11} fontSize="10.5" fill="var(--color-ink)" fontWeight={600}>
          {line}
        </text>
      ))}

      {/* A dead end is struck through, line by line. It is the one thing outside
          the four states that a card still says, because it prevents a real
          mistake: a dead end is "available" and pointless. One rule across the
          whole card would read as a divider rather than as a deletion, and the
          width is estimated from the character count because SVG cannot measure
          text before it paints. */}
      {style.struck
        ? lines.map((line, index) => (
            <line
              key={`strike-${index}`}
              x1={x + 11}
              y1={y + 13 + index * 11}
              x2={Math.min(x + 12 + line.length * TITLE_CHAR_WIDTH, x + width - 20)}
              y2={y + 13 + index * 11}
              stroke="var(--color-loss)"
              strokeWidth="1.1"
              opacity="0.9"
            />
          ))
        : null}

      {/* one bar, and only for a programme that is actually running */}
      {runningPct === null ? null : (
        <>
          <rect x={barX} y={barY} width={barWidth} height={3} rx={1.5} fill="var(--color-hair)" />
          <rect x={barX} y={barY} width={barWidth * runningPct} height={3} rx={1.5} fill={colour} />
        </>
      )}

      {/* the one line: which of the four states this is, and what that means */}
      <text x={x + 13} y={y + height - 6.5} fontSize="8.5" fill={colour} fontWeight={500}>
        {fitLine(state.line, barWidth)}
      </text>

      {badges.map((badge, index) => (
        <text
          key={badge.key}
          x={x + width - 13 - index * 11}
          y={y + height - 6.5}
          fontSize="9.5"
          textAnchor="end"
          fill={badge.fill}
        >
          {badge.glyph}
        </text>
      ))}
    </g>
  );
}
