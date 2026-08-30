'use client';

/**
 * Industry Power — who is connected to whom, and how.
 *
 * Trusted SVG over typed data, laid out deterministically: companies on an
 * inner ring ordered by id, holders and directors on an outer ring ordered by
 * the company they attach to. No physics loop, no animation frame, no random
 * seed — the same state always draws the same graph, so spatial memory
 * survives a reload.
 *
 * The information boundary decides what can be drawn. Disclosed holdings are
 * public by definition; board seats are drawn only for the board this player
 * sits on; deals are drawn only for deals this player is party to. Nothing
 * undisclosed appears.
 */

import { useMemo, useState } from 'react';
import type { PlayerView, SessionState } from '@frontier/contracts';
import { formatPct } from '@frontier/shared';
import { EmptyState, Icon, Tag, TONE_VAR, type IconName } from '@/components/ui';
import { holderLabel, humanise, issuedSharesOf } from '../reporting/util';

type EdgeKind = 'holding' | 'board' | 'deal';

interface GraphNode {
  readonly id: string;
  readonly label: string;
  /** The ticker, where one is public. A node without one carries its mark alone. */
  readonly badge: string | null;
  /** The drawn mark inside the node: a building, a person, a stack of coins. */
  readonly mark: IconName;
  readonly kind: 'company' | 'holder';
  readonly own: boolean;
  readonly x: number;
  readonly y: number;
}

/**
 * A mark placed inside the graph.
 *
 * `Icon` draws on a 24×24 grid, so it is nested as its own `<svg>` at the
 * requested size and translated into place — the same mark the rest of the
 * interface uses, at graph scale. The accent is folded into the base: a second
 * colour inside a 26px node would fight the node's own tone.
 */
function GraphMark({
  name,
  x,
  y,
  size,
  colour,
}: {
  readonly name: IconName;
  readonly x: number;
  readonly y: number;
  readonly size: number;
  readonly colour: string;
}): React.JSX.Element {
  return (
    <g transform={`translate(${x - size / 2}, ${y - size / 2})`} style={{ color: colour }}>
      <Icon name={name} size={size} accent="current" />
    </g>
  );
}

interface GraphEdge {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly kind: EdgeKind;
  readonly weight: number;
  readonly title: string;
}

const WIDTH = 720;
const HEIGHT = 520;
const CX = WIDTH / 2;
const CY = HEIGHT / 2;
const R_INNER = 132;
const R_OUTER = 218;

const EDGE_TONE: Readonly<Record<EdgeKind, string>> = {
  holding: TONE_VAR.brand,
  board: TONE_VAR.warn,
  deal: TONE_VAR.info,
};

/** The disclosure threshold: a position at or above this is public knowledge. */
const DISCLOSURE_PCT = 0.05;

export interface PowerGraphProps {
  readonly session: SessionState;
  readonly view: PlayerView;
}

export function PowerGraph({ session, view }: PowerGraphProps): React.JSX.Element {
  const [hovered, setHovered] = useState<string | null>(null);

  const { nodes, edges, counts } = useMemo(() => {
    const companyIds: string[] = [view.ownCompany.id, ...view.visibleCompanies.map((entry) => entry.id ?? '').filter(Boolean)]
      .filter((id, index, all) => all.indexOf(id) === index)
      .sort((a, b) => a.localeCompare(b));

    const companyLabel = (id: string): string =>
      id === view.ownCompany.id ? view.ownCompany.name : view.visibleCompanies.find((entry) => entry.id === id)?.name ?? id;
    /** The ticker when the company has published one; otherwise nothing at all. */
    const companyBadge = (id: string): string | null =>
      (id === view.ownCompany.id ? view.ownCompany.ticker : view.visibleCompanies.find((entry) => entry.id === id)?.ticker ?? null) ?? null;

    const rawEdges: GraphEdge[] = [];
    const holderIds = new Set<string>();

    /* --- disclosed holdings ------------------------------------------------ */
    for (const table of session.capTables) {
      if (!companyIds.includes(table.companyId)) continue;
      const issued = issuedSharesOf(table);
      if (issued <= 0) continue;
      for (const holding of table.holdings) {
        if (holding.holderKind === 'public_float') continue;
        const pct = holding.shares / issued;
        if (pct < DISCLOSURE_PCT || !holding.isDisclosed) continue;
        holderIds.add(holding.holderId);
        rawEdges.push({
          id: `hold_${holding.id}`,
          from: holding.holderId,
          to: table.companyId,
          kind: 'holding',
          weight: pct,
          title: `${holderLabel(session, holding.holderId, holding.holderKind)} holds ${formatPct(pct, 1)} of ${companyLabel(table.companyId)}`,
        });
      }
    }

    /* --- board seats on the board this player sits on ---------------------- */
    if (view.board !== null) {
      for (const director of view.board.directors) {
        holderIds.add(director.characterId);
        rawEdges.push({
          id: `seat_${view.board.id}_${director.characterId}`,
          from: director.characterId,
          to: view.board.companyId,
          kind: 'board',
          weight: 0.5,
          title: `${holderLabel(session, director.characterId, 'character')} holds the ${humanise(director.seat).toLowerCase()} seat${
            director.isChair ? ' and chairs the board' : ''
          }`,
        });
      }
    }

    /* --- deals this player is party to -------------------------------------- */
    for (const deal of view.deals) {
      if (!companyIds.includes(deal.proposerId) || !companyIds.includes(deal.counterpartyId)) continue;
      rawEdges.push({
        id: `deal_${deal.id}`,
        from: deal.proposerId,
        to: deal.counterpartyId,
        kind: 'deal',
        weight: 0.4,
        title: `${deal.summary.slice(0, 90)} — ${deal.status}`,
      });
    }

    /* --- deterministic layout ----------------------------------------------- */
    const companyIndex = new Map(companyIds.map((id, index) => [id, index]));
    const holders = [...holderIds].sort((a, b) => {
      const anchorA = rawEdges.find((edge) => edge.from === a)?.to ?? '';
      const anchorB = rawEdges.find((edge) => edge.from === b)?.to ?? '';
      const orderA = companyIndex.get(anchorA) ?? 999;
      const orderB = companyIndex.get(anchorB) ?? 999;
      return orderA !== orderB ? orderA - orderB : a.localeCompare(b);
    });

    const placed: GraphNode[] = [];
    companyIds.forEach((id, index) => {
      const angle = (index / Math.max(1, companyIds.length)) * Math.PI * 2 - Math.PI / 2;
      placed.push({
        id,
        label: companyLabel(id),
        badge: companyBadge(id),
        mark: 'building',
        kind: 'company',
        own: id === view.ownCompany.id,
        x: CX + Math.cos(angle) * R_INNER,
        y: CY + Math.sin(angle) * R_INNER,
      });
    });
    holders.forEach((id, index) => {
      const angle = (index / Math.max(1, holders.length)) * Math.PI * 2 - Math.PI / 2 + Math.PI / Math.max(2, holders.length);
      const character = session.characters.find((entry) => entry.id === id) ?? null;
      placed.push({
        id,
        label: holderLabel(session, id, character === null ? 'fund' : 'character'),
        badge: null,
        // A person is drawn as a person and a fund as money. Neither is ever a
        // pair of initials.
        mark: character === null ? 'coins' : 'people',
        kind: 'holder',
        own: character?.isPlayer === true,
        x: CX + Math.cos(angle) * R_OUTER,
        y: CY + Math.sin(angle) * R_OUTER,
      });
    });

    const known = new Set(placed.map((node) => node.id));
    const usable = rawEdges.filter((edge) => known.has(edge.from) && known.has(edge.to));

    return {
      nodes: placed,
      edges: usable,
      counts: {
        holding: usable.filter((edge) => edge.kind === 'holding').length,
        board: usable.filter((edge) => edge.kind === 'board').length,
        deal: usable.filter((edge) => edge.kind === 'deal').length,
      },
    };
  }, [session, view]);

  const positions = new Map(nodes.map((node) => [node.id, node]));

  if (nodes.length === 0) {
    return <EmptyState title="No visible power structure" message="Disclosed stakes, board seats and deals draw this graph." />;
  }

  return (
    <div className="flex flex-col gap-3">
      {/* The graph pans inside its own frame; the page body never moves. */}
      <div className="scene-frame border border-hair bg-base">
        <div className="scroll-x">
          <svg
            viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
            width="100%"
            role="img"
            aria-label="Industry power graph: disclosed holdings, board seats and deals"
            className="min-w-[560px]"
          >
          {edges.map((edge) => {
            const from = positions.get(edge.from);
            const to = positions.get(edge.to);
            if (from === undefined || to === undefined) return null;
            const active = hovered === null || hovered === edge.from || hovered === edge.to;
            return (
              <line
                key={edge.id}
                x1={from.x}
                y1={from.y}
                x2={to.x}
                y2={to.y}
                stroke={EDGE_TONE[edge.kind]}
                strokeWidth={1 + edge.weight * 4}
                strokeLinecap="round"
                strokeOpacity={active ? 0.7 : 0.14}
                strokeDasharray={edge.kind === 'deal' ? '5 4' : edge.kind === 'board' ? '2 3' : undefined}
              >
                <title>{edge.title}</title>
              </line>
            );
          })}

          {nodes.map((node) => {
            const active = hovered === null || hovered === node.id || edges.some((edge) => (edge.from === node.id || edge.to === node.id) && (edge.from === hovered || edge.to === hovered));
            const opacity = active ? 1 : 0.28;
            if (node.kind === 'company') {
              return (
                <g
                  key={node.id}
                  opacity={opacity}
                  onMouseEnter={() => setHovered(node.id)}
                  onMouseLeave={() => setHovered(null)}
                  style={{ cursor: 'default' }}
                >
                  <rect
                    x={node.x - 34}
                    y={node.y - 14}
                    width={68}
                    height={28}
                    rx={10}
                    fill={node.own ? 'var(--color-brand-wash)' : 'var(--color-raised)'}
                    stroke={node.own ? TONE_VAR.brand : 'var(--color-hair-strong)'}
                    strokeWidth={node.own ? 2 : 1.2}
                  />
                  <GraphMark
                    name={node.mark}
                    x={node.badge === null ? node.x : node.x - 20}
                    y={node.y}
                    size={16}
                    colour={node.own ? TONE_VAR.brand : 'var(--color-ink-dim)'}
                  />
                  {node.badge === null ? null : (
                    <text
                      x={node.x + 22}
                      y={node.y + 4}
                      textAnchor="end"
                      fontSize="11"
                      fontFamily="var(--font-mono)"
                      fill={node.own ? TONE_VAR.brand : 'var(--color-ink)'}
                    >
                      {node.badge}
                    </text>
                  )}
                  <text x={node.x} y={node.y + 27} textAnchor="middle" fontSize="9.5" fill="var(--color-ink-faint)">
                    {node.label.length > 20 ? `${node.label.slice(0, 19)}…` : node.label}
                  </text>
                  <title>{node.label}</title>
                </g>
              );
            }
            return (
              <g
                key={node.id}
                opacity={opacity}
                onMouseEnter={() => setHovered(node.id)}
                onMouseLeave={() => setHovered(null)}
                style={{ cursor: 'default' }}
              >
                <circle
                  cx={node.x}
                  cy={node.y}
                  r={14}
                  fill={node.own ? 'var(--color-brand-wash)' : 'var(--color-raised)'}
                  stroke={node.own ? TONE_VAR.brand : 'var(--color-hair-strong)'}
                  strokeWidth={node.own ? 2 : 1.2}
                />
                <GraphMark
                  name={node.mark}
                  x={node.x}
                  y={node.y}
                  size={15}
                  colour={node.own ? TONE_VAR.brand : 'var(--color-ink-dim)'}
                />
                <text x={node.x} y={node.y + 27} textAnchor="middle" fontSize="9.5" fill="var(--color-ink-faint)">
                  {node.label.length > 18 ? `${node.label.slice(0, 17)}…` : node.label}
                </text>
                <title>{node.label}</title>
              </g>
            );
          })}
          </svg>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
        <span className="flex items-center gap-1.5 text-[11px] text-ink-dim">
          <span className="inline-block h-[3px] w-5 rounded-pill" style={{ backgroundColor: EDGE_TONE.holding }} />
          Disclosed holding ≥5% <span className="figure text-ink-faint">{counts.holding}</span>
        </span>
        <span className="flex items-center gap-1.5 text-[11px] text-ink-dim">
          <span className="inline-block h-[3px] w-5 rounded-pill" style={{ backgroundColor: EDGE_TONE.board }} />
          Board seat <span className="figure text-ink-faint">{counts.board}</span>
        </span>
        <span className="flex items-center gap-1.5 text-[11px] text-ink-dim">
          <span className="inline-block h-[3px] w-5 rounded-pill" style={{ backgroundColor: EDGE_TONE.deal }} />
          Deal <span className="figure text-ink-faint">{counts.deal}</span>
        </span>
        <Tag tone="neutral">{nodes.length} nodes</Tag>
      </div>

      <p className="text-[10px] text-ink-faint">
        Undisclosed accumulation does not appear here — that is the point of it. Board seats are drawn only for the board you sit
        on, and deals only for those you are party to.
      </p>
    </div>
  );
}
