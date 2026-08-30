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
 * public figure. No rival's private conviction reaches this file, so the second
 * confidence bar on a node is always the viewer's own.
 */

import { useId, useMemo } from 'react';
import type { TechGraph, TechNode } from '@frontier/contracts';
import { TONE_VAR, cx } from '@/components/ui';
import {
  EDGE_STYLE,
  STATE_STYLE,
  fillOpacityOf,
  layoutGraph,
  wrapTitle,
} from './graphLayout';

export interface FrontierMapProps {
  readonly graph: TechGraph;
  /** The viewing company, whose own confidence is drawn as the second bar. */
  readonly companyId: string;
  readonly selectedNodeId: string | null;
  readonly onSelect: (nodeId: string) => void;
  /** Nodes whose public confidence moved when the last quarter resolved. */
  readonly changedNodeIds: ReadonlySet<string>;
  /** Node ids to keep at full strength; everything else dims. Null shows all. */
  readonly highlightIds: ReadonlySet<string> | null;
}

export function FrontierMap({
  graph,
  companyId,
  selectedNodeId,
  onSelect,
  changedNodeIds,
  highlightIds,
}: FrontierMapProps): React.JSX.Element {
  const markerId = useId().replace(/:/g, '');
  const layout = useMemo(() => layoutGraph(graph), [graph]);

  return (
    <div className="scroll-x">
      <svg
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        width={layout.width}
        height={layout.height}
        role="img"
        aria-label={`Frontier Map, version ${graph.version}: ${graph.nodes.length} technologies in ${layout.layerCount} dependency layers.`}
        style={{ minWidth: layout.width, maxWidth: '100%', height: 'auto' }}
      >
        <defs>
          <marker id={`${markerId}-arrow`} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M 0 1 L 7 4 L 0 7 z" fill="var(--color-ink-faint)" />
          </marker>
        </defs>

        {/* --- edges under nodes, always ------------------------------------ */}
        <g>
          {layout.edges.map((laid, index) => {
            const style = EDGE_STYLE[laid.edge.kind];
            const dimmed =
              highlightIds !== null && !(highlightIds.has(laid.edge.from) && highlightIds.has(laid.edge.to));
            return (
              <path
                key={`${laid.edge.from}-${laid.edge.to}-${laid.edge.kind}-${index}`}
                d={laid.path}
                fill="none"
                // A hairline is invisible on an off-white ground: dependency
                // edges take the faint ink tier so the graph still reads.
                stroke="var(--color-ink-faint)"
                strokeWidth={0.8 + laid.edge.strength * 1.4}
                strokeDasharray={style.dash}
                opacity={dimmed ? style.opacity * 0.25 : style.opacity}
                markerEnd={style.arrow ? `url(#${markerId}-arrow)` : undefined}
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
              selected={laid.node.id === selectedNodeId}
              changed={changedNodeIds.has(laid.node.id)}
              dimmed={highlightIds !== null && !highlightIds.has(laid.node.id)}
              onSelect={onSelect}
            />
          ))}
        </g>
      </svg>
    </div>
  );
}

interface MapNodeProps {
  readonly laid: ReturnType<typeof layoutGraph>['nodes'][number];
  readonly companyId: string;
  readonly selected: boolean;
  readonly changed: boolean;
  readonly dimmed: boolean;
  readonly onSelect: (nodeId: string) => void;
}

function MapNode({ laid, companyId, selected, changed, dimmed, onSelect }: MapNodeProps): React.JSX.Element {
  const node: TechNode = laid.node;
  const style = STATE_STYLE[node.status];
  const colour = TONE_VAR[style.tone];
  const own = node.confidenceByCompany[companyId];
  const lines = wrapTitle(node.title);
  const barY = laid.y + laid.height - 13;
  const barWidth = laid.width - 20;

  return (
    <g
      className={cx('cursor-pointer', dimmed ? 'opacity-30' : '')}
      onClick={() => onSelect(node.id)}
      role="button"
      tabIndex={0}
      aria-label={`${node.title} — ${style.label}, public confidence ${Math.round(node.publicConfidence * 100)} percent`}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onSelect(node.id);
        }
      }}
    >
      <rect
        x={laid.x}
        y={laid.y}
        width={laid.width}
        height={laid.height}
        rx={10}
        fill={colour}
        fillOpacity={fillOpacityOf(node)}
        stroke={selected ? 'var(--color-ink)' : colour}
        strokeWidth={selected ? 2.5 : 1.4}
        strokeDasharray={style.dashed ? '4 3' : undefined}
      />

      {lines.map((line, index) => (
        <text
          key={index}
          x={laid.x + 10}
          y={laid.y + 17 + index * 12}
          fontSize="10.5"
          fill="var(--color-ink)"
          fontWeight={600}
        >
          {line}
        </text>
      ))}

      {style.struck ? (
        <line
          x1={laid.x + 8}
          y1={laid.y + laid.height / 2}
          x2={laid.x + laid.width - 8}
          y2={laid.y + laid.height / 2}
          stroke={colour}
          strokeWidth="1"
          opacity="0.8"
        />
      ) : null}

      {/* public confidence, then this company's own when it has one */}
      <rect x={laid.x + 10} y={barY} width={barWidth} height={2.5} rx={1.25} fill="var(--color-hair-strong)" />
      <rect
        x={laid.x + 10}
        y={barY}
        width={barWidth * Math.max(0, Math.min(1, node.publicConfidence))}
        height={2.5}
        rx={1.25}
        fill={colour}
      />
      {own === undefined ? null : (
        <>
          <rect x={laid.x + 10} y={barY + 4.5} width={barWidth} height={2.5} rx={1.25} fill="var(--color-hair-strong)" />
          <rect
            x={laid.x + 10}
            y={barY + 4.5}
            width={barWidth * Math.max(0, Math.min(1, own))}
            height={2.5}
            rx={1.25}
            fill="var(--color-brand)"
          />
        </>
      )}

      {/* badges: achieved, invented here, secret, moved this quarter */}
      <g>
        {node.achievedByCompanyId !== null ? (
          <text x={laid.x + laid.width - 10} y={laid.y + 15} fontSize="10" textAnchor="end" fill="var(--color-gain)">
            ✓
          </text>
        ) : null}
        {node.originalProposerId !== null ? (
          <text x={laid.x + laid.width - 24} y={laid.y + 15} fontSize="10" textAnchor="end" fill="var(--color-brand)">
            ★
          </text>
        ) : null}
        {style.locked ? (
          <text x={laid.x + laid.width - 10} y={laid.y + laid.height - 18} fontSize="9" textAnchor="end" fill="var(--color-warn)">
            ▣
          </text>
        ) : null}
        {changed ? (
          <>
            <circle cx={laid.x + laid.width - 6} cy={laid.y + laid.height - 6} r="5.5" fill="var(--color-info)" />
            <text x={laid.x + laid.width - 6} y={laid.y + laid.height - 2.5} fontSize="7.5" textAnchor="middle" fill="var(--color-panel)" fontWeight={700}>
              Δ
            </text>
          </>
        ) : null}
      </g>
    </g>
  );
}
