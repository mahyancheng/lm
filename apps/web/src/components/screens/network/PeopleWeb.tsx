'use client';

/**
 * The people web.
 *
 * A directory tells you who exists. This tells you where you stand: you are in
 * the middle, everybody else sits on the ring their *access state* puts them on,
 * and the line between you and them is as thick as the relationship actually is.
 * Nothing is decorative — the picture is `checkAccess` and the relationship
 * edges incident to the player, drawn.
 *
 * The dashed line into the middle ring is the whole point of the screen: it runs
 * from somebody you can reach to somebody you cannot, which is the route the
 * validator will accept for `request_introduction`. Tapping either end opens
 * their card, where that request is one control away.
 *
 * Two boundaries are kept, exactly as on the rest of the screen: connection
 * level is public, so everybody is on the web; relationships are private and
 * directional, so only edges incident to the player are drawn — how two other
 * people feel about each other is not on this picture.
 */

import { useMemo } from 'react';
import type { Character } from '@frontier/contracts';
import { formatScore } from '@frontier/shared';
import { Tag } from '@/components/ui';
import { Portrait, moodFromScore } from '@/components/scenes/people';
import type { DirectoryEntry } from './directory';
import { RING_GEOMETRY, RING_LABEL, RING_ORDER, RING_TONE, layoutRings, type Ring, type WebNode } from './rings';

export interface PeopleWebProps {
  readonly entries: readonly DirectoryEntry[];
  readonly founder: Character;
  readonly selectedId: string | null;
  readonly onSelect: (characterId: string) => void;
}

/** The tone a node's ring and its edge are drawn in. */
function edgeColour(node: WebNode): string {
  if (node.hostile) return 'var(--color-loss)';
  if (node.strength > 0) return 'var(--color-brand)';
  return 'var(--color-hair-strong)';
}

export function PeopleWeb({ entries, founder, selectedId, onSelect }: PeopleWebProps): React.JSX.Element {
  const nodes = useMemo(() => layoutRings(entries), [entries]);
  const positions = useMemo(() => new Map(nodes.map((node) => [node.entry.character.id, node])), [nodes]);

  const counts = useMemo(() => {
    const map = new Map<Ring, number>(RING_ORDER.map((ring) => [ring, 0]));
    for (const node of nodes) map.set(node.ring, (map.get(node.ring) ?? 0) + 1);
    return map;
  }, [nodes]);

  return (
    <div className="flex flex-col gap-3">
      <div className="scene-frame border border-hair bg-base">
        <div className="scroll-x">
          <div className="relative min-w-[640px]" style={{ aspectRatio: '4 / 3' }}>
            {/* The rings and the edges. `preserveAspectRatio="none"` makes the
                viewBox percent-space so the geometry here and the buttons
                positioned on top of it are the same coordinates; every stroke is
                non-scaling so the distortion never reaches a line width. */}
            <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="absolute inset-0 size-full" role="presentation" aria-hidden="true">
              {RING_ORDER.map((ring) => (
                <ellipse
                  key={ring}
                  cx="50"
                  cy="50"
                  rx={RING_GEOMETRY[ring].rx}
                  ry={RING_GEOMETRY[ring].ry}
                  fill="none"
                  stroke="var(--color-hair)"
                  strokeWidth="1"
                  strokeDasharray="3 4"
                  vectorEffect="non-scaling-stroke"
                />
              ))}

              {/* You to everybody you can reach. Thickness is the relationship. */}
              {nodes
                .filter((node) => node.ring === 'inner')
                .map((node) => (
                  <line
                    key={`edge-${node.entry.character.id}`}
                    x1="50"
                    y1="50"
                    x2={node.xPct}
                    y2={node.yPct}
                    className="fc-edge"
                    stroke={edgeColour(node)}
                    strokeWidth={(0.9 + node.strength * 3.4).toFixed(2)}
                    strokeOpacity={node.strength > 0 ? 0.85 : 0.5}
                    vectorEffect="non-scaling-stroke"
                  />
                ))}

              {/* The route in: broker to target, for everybody one introduction away. */}
              {nodes
                .filter((node) => node.ring === 'middle')
                .map((node) => {
                  const broker = positions.get(node.entry.brokerIds[0] ?? '');
                  if (broker === undefined) return null;
                  return (
                    <line
                      key={`route-${node.entry.character.id}`}
                      x1={broker.xPct}
                      y1={broker.yPct}
                      x2={node.xPct}
                      y2={node.yPct}
                      className="fc-edge"
                      stroke="var(--color-info)"
                      strokeWidth="1.3"
                      strokeDasharray="4 3"
                      strokeOpacity="0.7"
                      vectorEffect="non-scaling-stroke"
                    />
                  );
                })}
            </svg>

            {/* --- you ------------------------------------------------------ */}
            <div
              className="fc-seat w-[104px]"
              data-self="true"
              style={{ left: '50%', top: '50%', transform: 'translate(-50%, -50%)', cursor: 'default' }}
            >
              <Portrait characterId={founder.id} role={founder.role} size="xl" idle decorative isPlayer />
              <span className="w-full truncate text-[11px] font-semibold text-ink">{founder.name}</span>
              <span className="figure text-[10px] text-brand">connection {formatScore(founder.connectionLevel)}</span>
            </div>

            {/* --- everybody else ------------------------------------------- */}
            {nodes.map((node, index) => {
              const character = node.entry.character;
              const tone = RING_TONE[node.ring];
              return (
                <button
                  key={character.id}
                  type="button"
                  className="fc-seat animate-pop-in w-[76px]"
                  style={{
                    left: `${node.xPct}%`,
                    top: `${node.yPct}%`,
                    transform: 'translate(-50%, -50%)',
                    animationDelay: `${Math.min(index, 8) * 40}ms`,
                  }}
                  data-selected={character.id === selectedId}
                  data-reach={node.entry.state === 'blocked' ? 'blocked' : 'open'}
                  onClick={() => onSelect(character.id)}
                  title={`${character.name} — ${character.title}`}
                  aria-label={`${character.name}, ${character.title}. ${RING_LABEL[node.ring]}, connection ${formatScore(
                    character.connectionLevel,
                  )}. Open their card.`}
                >
                  <Portrait
                    characterId={character.id}
                    role={character.role}
                    size="md"
                    decorative
                    ring={node.hostile ? 'loss' : node.ring === 'inner' ? 'gain' : node.ring === 'middle' ? 'info' : undefined}
                    mood={node.entry.inbound === null ? 'content' : moodFromScore(node.entry.inbound.trust - node.entry.inbound.hostility / 2)}
                  />
                  <span className="w-full truncate text-[10px] font-semibold text-ink">{character.name.split(' ')[0]}</span>
                  <span className={`figure text-[9px] tone-${tone}`}>{formatScore(character.connectionLevel)}</span>
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* --- what the picture means ----------------------------------------- */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        {RING_ORDER.map((ring) => (
          <Tag key={ring} tone={RING_TONE[ring]} dot>
            {RING_LABEL[ring]} · {counts.get(ring) ?? 0}
          </Tag>
        ))}
        <span className="text-[10px] text-ink-faint">
          Line thickness is how much you and they have actually dealt with each other; a dashed line is the introduction that would open a
          channel. Red is hostility, in either direction.
        </span>
      </div>
    </div>
  );
}
