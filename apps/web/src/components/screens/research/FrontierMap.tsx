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
 * **The drawing rule.** A node is a calm white card. Exactly one thing on it
 * carries the epistemic-state colour — a 4px left accent bar and a matching
 * dot — and exactly one thing carries a number: the public-confidence bar
 * along the bottom, with your own conviction as a tick under it. Edges live at
 * a low opacity and are told apart by form, not colour. The one moment the map
 * uses colour loudly is the moment you point at something: the node under the
 * pointer, its direct neighbours and the edges between them come up to full
 * strength and everything else recedes.
 */

import { useId, useMemo, useState } from 'react';
import type { TechGraph, TechNode } from '@frontier/contracts';
import { SECTOR_META } from '@frontier/contracts';
import { SECTOR_TINT, TONE_VAR, type Tone } from '@/components/ui';
import { EDGE_STYLE, STATE_STYLE, layoutGraph, wrapTitle, type LaidOutNode } from './graphLayout';

export interface FrontierMapProps {
  readonly graph: TechGraph;
  /** The viewing company, whose own conviction is drawn as the bar's tick. */
  readonly companyId: string;
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
  companyId,
  selectedNodeId,
  onSelect,
  changedNodeIds,
  highlightIds,
  showSectors = false,
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
              companyId={companyId}
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
  readonly companyId: string;
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

function MapNode({ laid, companyId, showSector, selected, changed, lit, dim, onSelect, onFocus, onRelease }: MapNodeProps): React.JSX.Element {
  const node: TechNode = laid.node;
  const style = STATE_STYLE[node.status];
  const colour = TONE_VAR[style.tone];
  const own = node.confidenceByCompany[companyId];
  const lines = wrapTitle(node.title);
  const { x, y, width, height } = laid;

  const badges: readonly { readonly glyph: string; readonly fill: string; readonly key: string }[] = [
    ...(node.achievedByCompanyId !== null ? [{ glyph: '✓', fill: 'var(--color-gain)', key: 'achieved' }] : []),
    ...(node.originalProposerId !== null ? [{ glyph: '★', fill: 'var(--color-brand)', key: 'proposed' }] : []),
    ...(style.locked ? [{ glyph: '▣', fill: 'var(--color-warn)', key: 'secret' }] : []),
    ...(changed ? [{ glyph: 'Δ', fill: 'var(--color-info)', key: 'moved' }] : []),
  ];

  const barX = x + 13;
  const barY = y + height - 11;
  const barWidth = Math.max(40, width - 26 - badges.length * 11);
  const publicPct = Math.max(0, Math.min(1, node.publicConfidence));

  const border = selected
    ? 'var(--color-brand-strong)'
    : lit
      ? 'var(--color-brand)'
      : style.dashed
        ? 'var(--color-hair-strong)'
        : 'var(--color-hair)';

  const ownLabel = own === undefined ? '' : `, your conviction ${Math.round(own * 100)} percent`;
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
      aria-label={`${node.title}${sectorLabel} — ${style.label}, public confidence ${Math.round(node.publicConfidence * 100)} percent${ownLabel}`}
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
        fill={style.wash ? TONE_WASH_VAR[style.tone] : 'var(--color-panel)'}
        stroke={border}
        strokeWidth={selected ? 2 : lit ? 1.5 : 1}
        strokeDasharray={style.dashed ? '3.5 2.5' : undefined}
        style={{ transition: EASE }}
      />

      {/* the one place the epistemic colour lives: an accent bar and a dot */}
      <rect x={x} y={y + 8} width={4} height={height - 16} rx={2} fill={colour} />
      <circle cx={x + width - 11} cy={y + 12.5} r={3.5} fill={colour} />

      {/* The sector, as a stripe along the top edge. A different edge and a
          different shape from the state accent, so the two never read as one
          encoding — and absent entirely in a single-sector world. */}
      {showSector ? <rect x={x + 10} y={y + 1.5} width={width - 20} height={2.5} rx={1.25} fill={SECTOR_TINT[node.sector]} /> : null}

      {lines.map((line, index) => (
        <text key={index} x={x + 13} y={y + 16.5 + index * 11} fontSize="10.5" fill="var(--color-ink)" fontWeight={600}>
          {line}
        </text>
      ))}

      {/* A dead end is struck through, line by line — one rule across the whole
          card would read as a divider rather than as a deletion. The width is
          estimated from the character count because SVG cannot measure text
          before it paints, and it is clamped to the card either way. */}
      {style.struck
        ? lines.map((line, index) => (
            <line
              key={`strike-${index}`}
              x1={x + 11}
              y1={y + 13 + index * 11}
              x2={Math.min(x + 12 + line.length * TITLE_CHAR_WIDTH, x + width - 20)}
              y2={y + 13 + index * 11}
              stroke={colour}
              strokeWidth="1.1"
              opacity="0.9"
            />
          ))
        : null}

      {/* one bar: what the world believes, with your own conviction ticked under it */}
      <rect x={barX} y={barY} width={barWidth} height={3} rx={1.5} fill="var(--color-hair)" />
      <rect x={barX} y={barY} width={barWidth * publicPct} height={3} rx={1.5} fill={colour} />
      {own === undefined ? null : (
        <path
          d={`M ${barX + barWidth * Math.max(0, Math.min(1, own))} ${barY + 3.4} l 3.1 4 l -6.2 0 z`}
          fill="var(--color-brand)"
        />
      )}

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
