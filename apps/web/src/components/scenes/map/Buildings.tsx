'use client';

/**
 * The flat-vector kit the world is drawn from.
 *
 * Every shape here is a rounded primitive with a solid token fill: two tones to
 * a volume, a roof band, glass rectangles for windows, and nothing else. There
 * are no gradients, no textures, no drop shadows inside a building — the only
 * shadow is the soft contact ellipse a volume casts on the ground, and it is
 * the ink token thinned out rather than a literal black.
 *
 * Nothing in this file reads state. A component takes a footprint, a size and a
 * **seed**, and the seed is always an entity id: `fnv1a64` picks the colourway,
 * the skin and the hair, so a company draws in the same livery forever and two
 * players see the same city.
 *
 * Every component draws upward from a ground line: `(x, baseY)` is the centre
 * of the footprint, and the art occupies `baseY - height` to `baseY`.
 */

import type { Tone } from '@/components/ui';
import { pickIndex, type MapBuilding } from './model';
import type { BuildingGlyph } from './geography';

/* -------------------------------------------------------------------------- */
/*  Shared pieces                                                              */
/* -------------------------------------------------------------------------- */

const COMPANY_COLOURWAYS = 8;
const SKIN_RAMP = 5;
const HAIR_RAMP = 6;

/** The eight flat pastels a company's tower can be painted in. */
export function colourwayOf(seed: string): string {
  return `var(--fc-map-brand-${pickIndex(seed, 'livery', COMPANY_COLOURWAYS)})`;
}

interface Anchored {
  readonly x: number;
  readonly baseY: number;
  readonly width: number;
  readonly height: number;
  readonly seed: string;
}

/** The soft contact ellipse every volume stands on. */
function Contact({ x, baseY, width }: { readonly x: number; readonly baseY: number; readonly width: number }): React.JSX.Element {
  return <ellipse cx={x} cy={baseY + 2.5} rx={width * 0.62} ry={4.5} fill="var(--fc-map-shadow)" />;
}

/**
 * The darker second tone of a volume: an ink wash down its right-hand third.
 * One token, applied over whatever colour the volume already is.
 */
function SideShade({
  x,
  baseY,
  width,
  height,
  radius = 6,
}: {
  readonly x: number;
  readonly baseY: number;
  readonly width: number;
  readonly height: number;
  readonly radius?: number;
}): React.JSX.Element {
  const w = width * 0.3;
  return <rect x={x + width / 2 - w} y={baseY - height} width={w} height={height} rx={radius} fill="var(--fc-map-shadow)" />;
}

/** A grid of glass rectangles. The window count follows the height, nothing else. */
function Windows({
  x,
  baseY,
  width,
  height,
  inset = 8,
}: {
  readonly x: number;
  readonly baseY: number;
  readonly width: number;
  readonly height: number;
  readonly inset?: number;
}): React.JSX.Element {
  const rows = Math.max(1, Math.floor((height - inset - 6) / 11));
  const cols = width >= 44 ? 3 : 2;
  const cellW = 7;
  const cellH = 6;
  const spanW = cols * cellW + (cols - 1) * 5;
  const left = x - spanW / 2;
  const panes: React.JSX.Element[] = [];
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      panes.push(
        <rect
          key={`${row}-${col}`}
          x={left + col * (cellW + 5)}
          y={baseY - height + inset + row * 11}
          width={cellW}
          height={cellH}
          rx={1.5}
          fill="var(--fc-map-glass)"
        />,
      );
    }
  }
  return <g>{panes}</g>;
}

/** The ticker flag on a roof: a small card on a pole, leaning in the wind. */
function Flag({
  x,
  topY,
  badge,
  own,
  delayMs,
}: {
  readonly x: number;
  readonly topY: number;
  readonly badge: string;
  readonly own: boolean;
  readonly delayMs: number;
}): React.JSX.Element {
  const text = badge.slice(0, 4);
  const cardW = Math.max(22, text.length * 7 + 8);
  return (
    <g>
      <rect x={x - 0.9} y={topY - 17} width={1.8} height={18} rx={0.9} fill="var(--fc-map-roof)" />
      <g className="fc-map-flag" style={{ ['--fc-delay' as string]: `${delayMs}ms` }}>
        <rect
          x={x + 1}
          y={topY - 19}
          width={cardW}
          height={13}
          rx={3}
          fill={own ? 'var(--color-brand-strong)' : 'var(--color-panel)'}
          stroke={own ? 'var(--color-brand-strong)' : 'var(--color-hair-strong)'}
          strokeWidth={1}
        />
        <text
          className="fc-map-label"
          x={x + 1 + cardW / 2}
          y={topY - 9.4}
          textAnchor="middle"
          fontSize={8.5}
          fill={own ? 'var(--color-panel)' : 'var(--color-ink)'}
        >
          {text}
        </text>
      </g>
    </g>
  );
}

/* -------------------------------------------------------------------------- */
/*  People                                                                     */
/* -------------------------------------------------------------------------- */

const OUTFITS = ['var(--fc-map-suit)', 'var(--fc-map-lab)', 'var(--fc-map-hoodie)', 'var(--fc-map-casual)'] as const;

export type CitizenRole = 'investor' | 'researcher' | 'engineer' | 'citizen';

const ROLE_OUTFIT: Readonly<Record<CitizenRole, number>> = { investor: 0, researcher: 1, engineer: 2, citizen: 3 };

/**
 * One round-headed person, about twenty pixels tall.
 *
 * A circle head, a flat hair shape over the top of it, two dot eyes and a
 * pill-shaped body in a role-coded garment. Skin and hair are picked from the
 * seed, so the same person is the same person next quarter.
 */
export function Citizen({
  x,
  baseY,
  seed,
  role,
  delayMs = 0,
}: {
  readonly x: number;
  readonly baseY: number;
  readonly seed: string;
  readonly role: CitizenRole;
  readonly delayMs?: number;
}): React.JSX.Element {
  const skin = `var(--fc-map-skin-${pickIndex(seed, 'skin', SKIN_RAMP)})`;
  const hair = `var(--fc-map-hair-${pickIndex(seed, 'hair', HAIR_RAMP)})`;
  const cloth = OUTFITS[ROLE_OUTFIT[role]] ?? OUTFITS[3];
  return (
    <g className="fc-map-bob" style={{ ['--fc-delay' as string]: `${delayMs}ms`, ['--fc-dur' as string]: '3.4s' }}>
      <ellipse cx={x} cy={baseY + 1} rx={4} ry={1.6} fill="var(--fc-map-shadow)" />
      <rect x={x - 3.4} y={baseY - 11} width={6.8} height={11} rx={2.6} fill={cloth} />
      <circle cx={x} cy={baseY - 14.6} r={4.2} fill={skin} />
      <path d={`M ${x - 4.2} ${baseY - 15.4} a 4.2 4.2 0 0 1 8.4 0 z`} fill={hair} />
      <circle cx={x - 1.5} cy={baseY - 14.2} r={0.75} fill="var(--color-ink)" />
      <circle cx={x + 1.5} cy={baseY - 14.2} r={0.75} fill="var(--color-ink)" />
    </g>
  );
}

/** A flat tree: one trunk, one rounded crown. */
export function Tree({ x, y, seed }: { readonly x: number; readonly y: number; readonly seed: string }): React.JSX.Element {
  const lean = pickIndex(seed, 'tree', 2) === 0 ? 1 : -1;
  return (
    <g>
      <rect x={x - 1.4} y={y - 8} width={2.8} height={8} rx={1.2} fill="var(--fc-map-roof)" />
      <circle cx={x + lean} cy={y - 12} r={7} fill="var(--fc-map-green)" />
      <circle cx={x - lean * 3} cy={y - 9} r={4.6} fill="var(--fc-map-green)" />
    </g>
  );
}

/* -------------------------------------------------------------------------- */
/*  Company head office                                                        */
/* -------------------------------------------------------------------------- */

function Tower({ x, baseY, width, height, seed, badge, own }: Anchored & { readonly badge: string; readonly own: boolean }): React.JSX.Element {
  const body = own ? 'var(--color-brand)' : colourwayOf(seed);
  const left = x - width / 2;
  const top = baseY - height;
  return (
    <g>
      <Contact x={x} baseY={baseY} width={width} />
      <rect x={left} y={top} width={width} height={height} rx={6} fill={body} />
      <SideShade x={x} baseY={baseY} width={width} height={height} />
      <rect x={left} y={top} width={width} height={5.5} rx={2.5} fill="var(--fc-map-roof)" />
      <Windows x={x} baseY={baseY} width={width} height={height} inset={12} />
      <rect x={left + 3} y={baseY - 9} width={width - 6} height={9} rx={2} fill="var(--fc-map-glass)" />
      <Flag x={x} topY={top} badge={badge} own={own} delayMs={pickIndex(seed, 'flag', 8) * 220} />
    </g>
  );
}

/* -------------------------------------------------------------------------- */
/*  Civic and institutional                                                    */
/* -------------------------------------------------------------------------- */

function Civic({ x, baseY, width, height, seed, badge }: Anchored & { readonly badge: string }): React.JSX.Element {
  const left = x - width / 2;
  const bodyH = height - 16;
  const columns = 4;
  const gap = (width - 16) / columns;
  return (
    <g>
      <Contact x={x} baseY={baseY} width={width} />
      <rect x={left} y={baseY - 6} width={width} height={6} rx={2} fill="var(--fc-map-side)" />
      <rect x={left + 5} y={baseY - bodyH - 6} width={width - 10} height={bodyH} rx={3} fill="var(--fc-map-face)" />
      {Array.from({ length: columns }, (_, index) => (
        <rect
          key={index}
          x={left + 10 + index * gap}
          y={baseY - bodyH - 2}
          width={gap * 0.42}
          height={bodyH - 6}
          rx={1.6}
          fill="var(--fc-map-parcel)"
        />
      ))}
      <path
        d={`M ${left + 2} ${baseY - bodyH - 6} L ${x} ${baseY - bodyH - 16} L ${left + width - 2} ${baseY - bodyH - 6} Z`}
        fill="var(--fc-map-roof)"
      />
      <circle cx={x} cy={baseY - bodyH - 18} r={5.5} fill="var(--fc-map-side)" />
      <rect x={x - 0.8} y={baseY - bodyH - 28} width={1.6} height={6} rx={0.8} fill="var(--fc-map-roof)" />
      <Flag x={x} topY={baseY - bodyH - 28} badge={badge} own={false} delayMs={pickIndex(seed, 'flag', 6) * 260} />
    </g>
  );
}

function Lab({ x, baseY, width, height, seed }: Anchored): React.JSX.Element {
  const left = x - width / 2;
  const top = baseY - height;
  return (
    <g>
      <Contact x={x} baseY={baseY} width={width} />
      <rect x={left} y={top} width={width} height={height} rx={7} fill="var(--fc-map-face)" />
      <SideShade x={x} baseY={baseY} width={width} height={height} radius={7} />
      <path
        d={`M ${left + 8} ${baseY} L ${left + 8} ${top + 14} a 10 10 0 0 1 20 0 L ${left + 28} ${baseY} Z`}
        fill="var(--fc-map-glass)"
      />
      <rect x={left + width - 22} y={top + 8} width={7} height={6} rx={1.5} fill="var(--fc-map-glass)" />
      <rect x={left + width - 12} y={top + 8} width={7} height={6} rx={1.5} fill="var(--fc-map-glass)" />
      <rect x={left} y={top} width={width} height={4.5} rx={2} fill="var(--fc-map-roof)" />
      <g className="fc-map-bob" style={{ ['--fc-delay' as string]: `${pickIndex(seed, 'dish', 5) * 180}ms` }}>
        <path d={`M ${left + width - 16} ${top - 2} a 7 7 0 0 1 12 -4`} fill="none" stroke="var(--fc-map-roof)" strokeWidth={2.2} strokeLinecap="round" />
      </g>
    </g>
  );
}

function Archive({ x, baseY, width, height }: Anchored): React.JSX.Element {
  const left = x - width / 2;
  const top = baseY - height;
  return (
    <g>
      <Contact x={x} baseY={baseY} width={width} />
      <rect x={left} y={top + 6} width={width} height={height - 6} rx={5} fill="var(--fc-map-face)" />
      <SideShade x={x} baseY={baseY} width={width} height={height - 6} radius={5} />
      <rect x={left - 3} y={top} width={width + 6} height={7} rx={3} fill="var(--fc-map-roof)" />
      <path d={`M ${x - 8} ${baseY} L ${x - 8} ${baseY - 16} a 8 8 0 0 1 16 0 L ${x + 8} ${baseY} Z`} fill="var(--fc-map-side)" />
      <rect x={left + 5} y={top + 14} width={4} height={12} rx={2} fill="var(--fc-map-glass)" />
      <rect x={left + width - 9} y={top + 14} width={4} height={12} rx={2} fill="var(--fc-map-glass)" />
    </g>
  );
}

function Exchange({ x, baseY, width, height, seed }: Anchored): React.JSX.Element {
  const left = x - width / 2;
  const bodyH = height - 18;
  const columns = 5;
  const gap = (width - 18) / columns;
  return (
    <g>
      <Contact x={x} baseY={baseY} width={width} />
      <rect x={left - 3} y={baseY - 7} width={width + 6} height={7} rx={2.5} fill="var(--fc-map-side)" />
      <rect x={left + 4} y={baseY - bodyH - 7} width={width - 8} height={bodyH} rx={3} fill="var(--fc-map-face)" />
      {Array.from({ length: columns }, (_, i) => (
        <rect key={i} x={left + 10 + i * gap} y={baseY - bodyH - 3} width={gap * 0.4} height={bodyH - 6} rx={1.5} fill="var(--fc-map-parcel)" />
      ))}
      <path d={`M ${left} ${baseY - bodyH - 7} L ${x} ${baseY - bodyH - 19} L ${left + width} ${baseY - bodyH - 7} Z`} fill="var(--fc-map-roof)" />
      <circle cx={x} cy={baseY - bodyH - 11} r={3.4} fill="var(--fc-map-glass)" />
      <Flag x={x} topY={baseY - bodyH - 19} badge="MKT" own={false} delayMs={pickIndex(seed, 'flag', 5) * 240} />
    </g>
  );
}

function Mast({ x, baseY, width, height }: Anchored): React.JSX.Element {
  const half = width / 2;
  const top = baseY - height;
  return (
    <g>
      <Contact x={x} baseY={baseY} width={width} />
      <rect x={x - half} y={baseY - 14} width={width} height={14} rx={4} fill="var(--fc-map-face)" />
      <rect x={x - half} y={baseY - 14} width={width} height={4} rx={2} fill="var(--fc-map-roof)" />
      <path d={`M ${x - 9} ${baseY - 14} L ${x - 2.5} ${top} L ${x + 2.5} ${top} L ${x + 9} ${baseY - 14} Z`} fill="var(--fc-map-side)" />
      <path d={`M ${x - 7} ${baseY - 26} L ${x + 7} ${baseY - 26}`} stroke="var(--fc-map-roof)" strokeWidth={1.6} strokeLinecap="round" />
      <path d={`M ${x - 5} ${baseY - 38} L ${x + 5} ${baseY - 38}`} stroke="var(--fc-map-roof)" strokeWidth={1.6} strokeLinecap="round" />
      {[0, 1, 2].map((ring) => (
        <circle
          key={ring}
          className="fc-map-wave"
          style={{ ['--fc-delay' as string]: `${ring * 900}ms` }}
          cx={x}
          cy={top + 2}
          r={9 + ring * 5}
          fill="none"
          stroke="var(--color-info)"
          strokeWidth={1.4}
        />
      ))}
    </g>
  );
}

/* -------------------------------------------------------------------------- */
/*  Industry                                                                   */
/* -------------------------------------------------------------------------- */

function Datacentre({ x, baseY, width, height, seed }: Anchored): React.JSX.Element {
  const left = x - width / 2;
  const top = baseY - height;
  return (
    <g>
      <Contact x={x} baseY={baseY} width={width} />
      <rect x={left} y={top} width={width} height={height} rx={5} fill="var(--fc-map-face)" />
      <SideShade x={x} baseY={baseY} width={width} height={height} radius={5} />
      <rect x={left} y={top} width={width} height={5} rx={2.5} fill="var(--fc-map-roof)" />
      {[0, 1, 2].map((unit) => (
        <rect key={unit} x={left + 8 + unit * ((width - 20) / 3)} y={top - 7} width={12} height={7} rx={2} fill="var(--fc-map-side)" />
      ))}
      {[0, 1, 2, 3, 4].map((led) => (
        <circle
          key={led}
          className="fc-map-led"
          style={{ ['--fc-delay' as string]: `${(pickIndex(seed, `led${led}`, 6) + led) * 220}ms` }}
          cx={left + 10 + led * ((width - 20) / 4)}
          cy={baseY - 9}
          r={2}
          fill="var(--color-info)"
        />
      ))}
      <rect x={left + 6} y={baseY - 24} width={width - 12} height={8} rx={2} fill="var(--fc-map-glass)" />
    </g>
  );
}

function Fab({ x, baseY, width, height }: Anchored): React.JSX.Element {
  const left = x - width / 2;
  const top = baseY - height;
  const teeth = 4;
  const toothW = (width - 8) / teeth;
  return (
    <g>
      <Contact x={x} baseY={baseY} width={width} />
      <rect x={left} y={top + 12} width={width} height={height - 12} rx={5} fill="var(--fc-map-face)" />
      <SideShade x={x} baseY={baseY} width={width} height={height - 12} radius={5} />
      {Array.from({ length: teeth }, (_, i) => (
        <path
          key={i}
          d={`M ${left + 4 + i * toothW} ${top + 12} L ${left + 4 + i * toothW} ${top + 3} L ${left + 4 + (i + 1) * toothW} ${top + 12} Z`}
          fill="var(--fc-map-roof)"
        />
      ))}
      <rect x={left + width - 14} y={top - 12} width={8} height={26} rx={2.5} fill="var(--fc-map-side)" />
      <circle className="fc-map-drift" cx={left + width - 10} cy={top - 18} r={5} fill="var(--fc-map-glass)" />
      <rect x={left + 8} y={baseY - 16} width={14} height={16} rx={2} fill="var(--fc-map-glass)" />
      <rect x={left + 28} y={baseY - 16} width={14} height={16} rx={2} fill="var(--fc-map-glass)" />
    </g>
  );
}

function Port({ x, baseY, width, height, seed }: Anchored): React.JSX.Element {
  const left = x - width / 2;
  const top = baseY - height;
  const boxes: React.JSX.Element[] = [];
  for (let i = 0; i < 6; i += 1) {
    const colour = `var(--fc-map-brand-${pickIndex(seed, `box${i}`, 8)})`;
    boxes.push(
      <rect key={i} x={left + 4 + (i % 3) * 16} y={baseY - 9 - Math.floor(i / 3) * 8} width={14} height={7} rx={1.5} fill={colour} />,
    );
  }
  return (
    <g>
      <Contact x={x} baseY={baseY} width={width} />
      <rect x={left - 2} y={baseY - 3} width={width + 4} height={4} rx={2} fill="var(--fc-map-side)" />
      {boxes}
      {[0, 1].map((crane) => {
        const cx = left + 14 + crane * (width - 30);
        return (
          <g key={crane}>
            <rect x={cx - 1.4} y={top} width={2.8} height={height - 4} rx={1.2} fill="var(--fc-map-roof)" />
            <rect x={cx - 16} y={top} width={32} height={3} rx={1.5} fill="var(--fc-map-roof)" />
            <rect x={cx + 9} y={top + 3} width={2} height={9} rx={1} fill="var(--fc-map-side)" />
          </g>
        );
      })}
    </g>
  );
}

function Grid({ x, baseY, width, height }: Anchored): React.JSX.Element {
  const left = x - width / 2;
  const pylonX = left + 14;
  const turbineX = left + width - 14;
  const top = baseY - height;
  return (
    <g>
      <Contact x={x} baseY={baseY} width={width} />
      <rect x={left - 2} y={baseY - 4} width={width + 4} height={5} rx={2} fill="var(--fc-map-side)" />
      <path
        d={`M ${pylonX - 9} ${baseY - 4} L ${pylonX - 3} ${baseY - 34} L ${pylonX + 3} ${baseY - 34} L ${pylonX + 9} ${baseY - 4}`}
        fill="none"
        stroke="var(--fc-map-roof)"
        strokeWidth={2.2}
        strokeLinejoin="round"
      />
      <path d={`M ${pylonX - 11} ${baseY - 28} L ${pylonX + 11} ${baseY - 28}`} stroke="var(--fc-map-roof)" strokeWidth={2} strokeLinecap="round" />
      <path d={`M ${pylonX - 8} ${baseY - 20} L ${pylonX + 8} ${baseY - 20}`} stroke="var(--fc-map-roof)" strokeWidth={2} strokeLinecap="round" />
      <rect x={turbineX - 1.4} y={top + 10} width={2.8} height={baseY - top - 14} rx={1.2} fill="var(--fc-map-side)" />
      <g className="fc-map-rotor">
        <circle cx={turbineX} cy={top + 12} r={2.4} fill="var(--fc-map-roof)" />
        {[0, 120, 240].map((angle) => (
          <rect
            key={angle}
            x={turbineX - 1.1}
            y={top - 3}
            width={2.2}
            height={15}
            rx={1.1}
            fill="var(--fc-map-roof)"
            transform={`rotate(${angle} ${turbineX} ${top + 12})`}
          />
        ))}
      </g>
    </g>
  );
}

function Border({ x, baseY, width, height, seed }: Anchored): React.JSX.Element {
  const left = x - width / 2;
  const top = baseY - height;
  return (
    <g>
      <Contact x={x} baseY={baseY} width={width} />
      <rect x={left} y={top + 8} width={width * 0.46} height={height - 8} rx={4} fill="var(--fc-map-face)" />
      <rect x={left} y={top + 8} width={width * 0.46} height={4} rx={2} fill="var(--fc-map-roof)" />
      <rect x={left + 5} y={top + 17} width={10} height={8} rx={1.5} fill="var(--fc-map-glass)" />
      <rect x={left + width * 0.56} y={baseY - 26} width={3} height={26} rx={1.4} fill="var(--fc-map-side)" />
      <rect
        x={left + width * 0.56}
        y={baseY - 26}
        width={width * 0.42}
        height={4}
        rx={2}
        fill="var(--color-loss)"
        transform={`rotate(-18 ${left + width * 0.56} ${baseY - 24})`}
      />
      <Citizen x={left + width * 0.3} baseY={baseY} seed={`${seed}:guard`} role="citizen" delayMs={300} />
    </g>
  );
}

function Terminal({ x, baseY, width, height }: Anchored): React.JSX.Element {
  const left = x - width / 2;
  const top = baseY - height;
  return (
    <g>
      <Contact x={x} baseY={baseY} width={width} />
      <rect x={left} y={top + 10} width={16} height={height - 10} rx={7} fill="var(--fc-map-face)" />
      <path d={`M ${left} ${top + 12} a 8 8 0 0 1 16 0 z`} fill="var(--fc-map-roof)" />
      <rect x={left + 20} y={top + 16} width={14} height={height - 16} rx={6} fill="var(--fc-map-face)" />
      <path d={`M ${left + 20} ${top + 18} a 7 7 0 0 1 14 0 z`} fill="var(--fc-map-roof)" />
      <rect x={left + 38} y={baseY - 18} width={width - 40} height={18} rx={3} fill="var(--fc-map-side)" />
      <rect x={left + 41} y={baseY - 13} width={6} height={6} rx={1.5} fill="var(--fc-map-glass)" />
    </g>
  );
}

/* -------------------------------------------------------------------------- */
/*  Dispatcher                                                                 */
/* -------------------------------------------------------------------------- */

const GLYPHS: Readonly<Record<BuildingGlyph, (props: Anchored & { readonly badge: string; readonly own: boolean }) => React.JSX.Element>> = {
  tower: Tower,
  civic: Civic,
  lab: Lab,
  archive: Archive,
  exchange: Exchange,
  mast: Mast,
  datacentre: Datacentre,
  fab: Fab,
  port: Port,
  grid: Grid,
  border: Border,
  terminal: Terminal,
};

/** Draw one placed building. Art only — the interactive wrapper is the scene's. */
export function SiteArt({ building }: { readonly building: MapBuilding }): React.JSX.Element {
  const Glyph = GLYPHS[building.glyph] ?? Tower;
  return (
    <Glyph
      x={building.x}
      baseY={building.baseY}
      width={building.width}
      height={building.height}
      seed={building.key}
      badge={building.badge}
      own={building.isPlayer}
    />
  );
}

/* -------------------------------------------------------------------------- */
/*  Event marker                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Solid marker fills. White sits on these, so every one is a `-strong` token:
 * the plain tones are tuned for text on a light ground, not the reverse.
 */
const MARKER_FILL: Readonly<Record<Tone, string>> = {
  neutral: 'var(--color-ink)',
  gain: 'var(--color-gain-strong)',
  loss: 'var(--color-loss-strong)',
  warn: 'var(--color-warn-strong)',
  info: 'var(--color-info-strong)',
  brand: 'var(--color-brand-strong)',
};

const MARKER_RING: Readonly<Record<Tone, string>> = {
  neutral: 'var(--color-ink-faint)',
  gain: 'var(--color-gain)',
  loss: 'var(--color-loss)',
  warn: 'var(--color-warn)',
  info: 'var(--color-info)',
  brand: 'var(--color-brand)',
};

/** The pulsing pin an active public event plants on its district. */
export function EventPin({
  x,
  y,
  tone,
  delayMs,
  selected,
}: {
  readonly x: number;
  readonly y: number;
  readonly tone: Tone;
  readonly delayMs: number;
  readonly selected: boolean;
}): React.JSX.Element {
  return (
    <g>
      <circle
        className="fc-map-pulse"
        style={{ ['--fc-delay' as string]: `${delayMs}ms` }}
        cx={x}
        cy={y}
        r={13}
        fill="none"
        stroke={MARKER_RING[tone]}
        strokeWidth={2}
      />
      <path d={`M ${x} ${y + 15} L ${x - 5} ${y + 6} L ${x + 5} ${y + 6} Z`} fill={MARKER_FILL[tone]} />
      <circle cx={x} cy={y} r={10} fill={MARKER_FILL[tone]} />
      <rect x={x - 1.2} y={y - 5.4} width={2.4} height={6} rx={1.2} fill="var(--color-panel)" />
      <circle cx={x} cy={y + 3.4} r={1.6} fill="var(--color-panel)" />
      {selected ? <circle cx={x} cy={y} r={14} fill="none" stroke={MARKER_FILL[tone]} strokeWidth={2} /> : null}
    </g>
  );
}
