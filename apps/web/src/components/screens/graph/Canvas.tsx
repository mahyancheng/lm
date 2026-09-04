'use client';

/**
 * The node canvas.
 *
 * One SVG, one transform, and pointer events. No new dependency: pan is a
 * pointer drag on the surface, pinch is two pointers, and the wheel zooms about
 * the cursor. Everything geometric it does comes out of `geometry.ts`, so the
 * picture can be asserted without mounting anything.
 *
 * What is drawn, from the back forward: a dotted grid, the solid flow wires,
 * the dashed supplier wires with their hanging nodes, then the cards. Cards
 * last, so a wire never draws over the thing it connects.
 *
 * Accessibility and the phone come first in two concrete ways. Every card, port
 * and hanging supplier has an invisible 44px hit rectangle over its glyph, so a
 * 9px sub-port dot is still a thumb-sized target. And the canvas takes a
 * `focusNodeIds` and refits whenever it changes, which is how a 390px screen
 * always has something readable on it rather than a wall of cards at 30%.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { formatMoney } from '@frontier/shared';
import { Icon, TONE_VAR, cx } from '@/components/ui';
import {
  CARD_RADIUS,
  MAX_SCALE,
  MIN_SCALE,
  NAME_GAP,
  NAME_H,
  PORT_DOT_R,
  PORT_TAB_H,
  PORT_TAB_W,
  SUBTITLE_H,
  SUB_PORT_R,
  SUPPLIER_R,
  TAP,
  type Point,
  type Viewport,
  boundsOf,
  clampScale,
  fitViewport,
  flowWire,
  inputPortOf,
  outputPortOf,
  subPortsOf,
  supplierSlotsOf,
  supplierWire,
  viewportTransform,
  zoomAbout,
} from './geometry';
import { STANDING_TONE, focusBoxes, type CanvasModel, type CanvasNode, type CanvasSubPort } from './model';

export interface CanvasProps {
  readonly model: CanvasModel;
  /** Nodes the view opens fitted to. Null fits everything. */
  readonly focusNodeIds: readonly string[] | null;
  readonly selectedNodeId: string | null;
  readonly onSelectNode: (nodeId: string) => void;
  /** Tapping a sub-port opens the wiring for that input. */
  readonly onSelectInput?: (nodeId: string, inputNodeId: string) => void;
  /** Canvas height in CSS pixels. The width is whatever the column gives it. */
  readonly height?: number;
  readonly className?: string;
}

/** How far a pointer may move and still count as a tap rather than a pan. */
const TAP_SLOP = 6;

export function Canvas({
  model,
  focusNodeIds,
  selectedNodeId,
  onSelectNode,
  onSelectInput,
  height = 420,
  className,
}: CanvasProps): React.JSX.Element {
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState<{ width: number; height: number }>({ width: 360, height });
  const [viewport, setViewport] = useState<Viewport>({ x: 0, y: 0, scale: 1 });

  // Pointer bookkeeping. A map rather than a pair, so a second finger is a
  // pinch and a lifted finger leaves the first one panning.
  const pointers = useRef(new Map<number, Point>());
  const dragged = useRef(0);
  const pinchStart = useRef<{ distance: number; scale: number } | null>(null);

  /* --- sizing ------------------------------------------------------------- */
  useEffect(() => {
    const element = surfaceRef.current;
    if (element === null) return;
    const measure = (): void => {
      setSize({ width: Math.max(1, element.clientWidth), height: Math.max(1, element.clientHeight) });
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  /* --- fit ---------------------------------------------------------------- */
  const focusKey = focusNodeIds === null ? '*' : [...focusNodeIds].join(',');
  const bounds = useMemo(() => boundsOf(focusBoxes(model, focusNodeIds)), [model, focusKey]);
  useEffect(() => {
    setViewport(fitViewport(bounds, size.width, size.height));
  }, [bounds, size.width, size.height]);

  const refit = useCallback(() => {
    setViewport(fitViewport(bounds, size.width, size.height));
  }, [bounds, size.width, size.height]);

  /* --- pointers ----------------------------------------------------------- */
  const onPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    dragged.current = 0;
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      if (a !== undefined && b !== undefined) {
        pinchStart.current = { distance: Math.hypot(a.x - b.x, a.y - b.y), scale: viewport.scale };
      }
    }
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }, [viewport.scale]);

  const onPointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const previous = pointers.current.get(event.pointerId);
    if (previous === undefined) return;
    const next = { x: event.clientX, y: event.clientY };
    pointers.current.set(event.pointerId, next);
    dragged.current += Math.hypot(next.x - previous.x, next.y - previous.y);

    if (pointers.current.size >= 2) {
      const [a, b] = [...pointers.current.values()];
      const start = pinchStart.current;
      if (a === undefined || b === undefined || start === null || start.distance <= 0) return;
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      const rect = surfaceRef.current?.getBoundingClientRect();
      const centre = { x: (a.x + b.x) / 2 - (rect?.left ?? 0), y: (a.y + b.y) / 2 - (rect?.top ?? 0) };
      setViewport((current) => zoomAbout(current, centre, start.scale * (distance / start.distance)));
      return;
    }

    setViewport((current) => ({ ...current, x: current.x + (next.x - previous.x), y: current.y + (next.y - previous.y) }));
  }, []);

  const onPointerUp = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    pointers.current.delete(event.pointerId);
    if (pointers.current.size < 2) pinchStart.current = null;
  }, []);

  const onWheel = useCallback((event: React.WheelEvent<HTMLDivElement>) => {
    const rect = surfaceRef.current?.getBoundingClientRect();
    const point = { x: event.clientX - (rect?.left ?? 0), y: event.clientY - (rect?.top ?? 0) };
    setViewport((current) => zoomAbout(current, point, current.scale * (event.deltaY > 0 ? 0.9 : 1.1)));
  }, []);

  /** A tap is a pointer that barely moved; anything further was a pan. */
  const tapped = (action: () => void) => (): void => {
    if (dragged.current <= TAP_SLOP) action();
  };

  const zoomBy = (factor: number): void => {
    const centre = { x: size.width / 2, y: size.height / 2 };
    setViewport((current) => zoomAbout(current, centre, current.scale * factor));
  };

  return (
    <div className={cx('relative overflow-hidden rounded-card border border-hairline bg-surface', className)} style={{ height }}>
      <div
        ref={surfaceRef}
        className="size-full touch-none select-none"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onWheel={onWheel}
      >
        <svg width="100%" height="100%" role="presentation">
          <defs>
            {/* The dotted grid, in canvas space so it pans and zooms with the
                cards — a grid that stayed still would read as a backdrop
                rather than as the surface the cards sit on. */}
            <pattern
              id="fc-canvas-dots"
              width={24}
              height={24}
              patternUnits="userSpaceOnUse"
              patternTransform={viewportTransform(viewport)}
            >
              <circle cx={1.2} cy={1.2} r={1.2} fill="var(--fc-ink-faint)" opacity={0.32} />
            </pattern>
          </defs>
          <rect width="100%" height="100%" fill="url(#fc-canvas-dots)" />

          <g transform={viewportTransform(viewport)}>
            {model.wires.map((wire) => (
              <path
                key={wire.key}
                d={wire.path}
                fill="none"
                stroke="var(--fc-ink-faint)"
                strokeWidth={wire.kind === 'requires' ? 1 : 1.6}
                strokeDasharray={wire.kind === 'requires' ? '3 4' : undefined}
                opacity={wire.kind === 'requires' ? 0.36 : 0.55}
              />
            ))}

            {model.nodes.map((node) => (
              <NodeCard
                key={node.nodeId}
                node={node}
                selected={node.nodeId === selectedNodeId}
                onSelect={tapped(() => onSelectNode(node.nodeId))}
                onSelectInput={onSelectInput}
                tapped={tapped}
              />
            ))}
          </g>
        </svg>
      </div>

      {/* Controls. Each is a 44px target and each says what it does. */}
      <div className="absolute right-2 bottom-2 flex flex-col gap-1.5">
        <CanvasButton label="Zoom in" onClick={() => zoomBy(1.25)} disabled={viewport.scale >= MAX_SCALE}>
          <Icon name="plus" size={16} accent="current" />
        </CanvasButton>
        <CanvasButton label="Zoom out" onClick={() => zoomBy(0.8)} disabled={viewport.scale <= MIN_SCALE}>
          <span aria-hidden="true" className="text-[16px] leading-none font-semibold">
            −
          </span>
        </CanvasButton>
        <CanvasButton label="Fit to view" onClick={refit}>
          <Icon name="compass" size={16} accent="current" />
        </CanvasButton>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  One card                                                                   */
/* -------------------------------------------------------------------------- */

interface NodeCardProps {
  readonly node: CanvasNode;
  readonly selected: boolean;
  readonly onSelect: () => void;
  readonly onSelectInput?: (nodeId: string, inputNodeId: string) => void;
  readonly tapped: (action: () => void) => () => void;
}

/**
 * The card, its name below it, its ports and its hanging suppliers.
 *
 * The name is deliberately *outside* the card — that is the reference's
 * arrangement and it is the right one, because it leaves the card itself for
 * one icon and one state colour, and a card that carries one encoding can be
 * read at any zoom.
 */
function NodeCard({ node, selected, onSelect, onSelectInput, tapped }: NodeCardProps): React.JSX.Element {
  const { box } = node;
  const tone = TONE_VAR[STANDING_TONE[node.standing]];
  const input = inputPortOf(box);
  const output = outputPortOf(box);
  const ports = subPortsOf(box, node.subPorts.length);
  const slots = supplierSlotsOf(box, node.subPorts.length);

  return (
    <g>
      {/* Hanging suppliers first: behind the card, so a wire that leaves the
          bottom edge is covered by the card rather than crossing it. */}
      {node.subPorts.map((port, index) => {
        const from = ports[index];
        const to = slots[index];
        if (from === undefined || to === undefined) return null;
        return (
          <SubPortBranch
            key={port.inputNodeId}
            port={port}
            from={from}
            to={to}
            onSelect={onSelectInput === undefined ? undefined : tapped(() => onSelectInput(node.nodeId, port.inputNodeId))}
          />
        );
      })}

      {/* The input tab, on the left edge. */}
      <rect
        x={input.x - PORT_TAB_W}
        y={input.y - PORT_TAB_H / 2}
        width={PORT_TAB_W}
        height={PORT_TAB_H}
        rx={2}
        fill={tone}
        opacity={0.85}
      />
      {/* The output circle, on the right edge. */}
      <circle cx={output.x} cy={output.y} r={PORT_DOT_R} fill="var(--fc-surface)" stroke={tone} strokeWidth={1.8} />

      <rect
        x={box.x}
        y={box.y}
        width={box.width}
        height={box.height}
        rx={CARD_RADIUS}
        fill="var(--fc-surface)"
        stroke={selected ? tone : 'var(--fc-hairline)'}
        strokeWidth={selected ? 2.2 : 1.2}
      />
      {/* The one encoding a card carries: a state bar down its left edge. */}
      <rect x={box.x} y={box.y + 10} width={3} height={box.height - 20} rx={1.5} fill={tone} />

      <g transform={`translate(${box.x + box.width / 2 - 11} ${box.y + box.height / 2 - 18})`}>
        <foreignObject width={22} height={22}>
          <Icon name={node.icon} size={22} accent="brand" />
        </foreignObject>
      </g>
      <text
        x={box.x + box.width / 2}
        y={box.y + box.height - 14}
        textAnchor="middle"
        className="figure"
        fontSize={10}
        fill="var(--fc-ink-dim)"
      >
        {formatMoney(node.marketPriceUsd)}
      </text>

      {/* The name, below the card. */}
      <text
        x={box.x + box.width / 2}
        y={box.y + box.height + NAME_GAP + NAME_H - 4}
        textAnchor="middle"
        fontSize={11.5}
        fontWeight={600}
        fill="var(--fc-ink)"
      >
        {clip(node.label, 22)}
      </text>
      <text
        x={box.x + box.width / 2}
        y={box.y + box.height + NAME_GAP + NAME_H + SUBTITLE_H - 5}
        textAnchor="middle"
        fontSize={9.5}
        fill="var(--fc-ink-faint)"
      >
        {clip(node.subtitle, 30)}
      </text>

      {/* The card's own 44px target, over everything it owns. */}
      <rect
        x={box.x}
        y={box.y}
        width={box.width}
        height={Math.max(TAP, box.height)}
        fill="transparent"
        style={{ cursor: 'pointer' }}
        onPointerUp={onSelect}
      >
        <title>{`${node.label} — ${node.subtitle}`}</title>
      </rect>
    </g>
  );
}

/** One sub-port, its dashed wire, and whatever hangs on the end of it. */
function SubPortBranch({
  port,
  from,
  to,
  onSelect,
}: {
  readonly port: CanvasSubPort;
  readonly from: Point;
  readonly to: Point;
  readonly onSelect?: () => void;
}): React.JSX.Element {
  const tone = port.blocked ? TONE_VAR.loss : port.madeInHouse ? TONE_VAR.brand : port.supplier === null ? 'var(--fc-ink-faint)' : TONE_VAR.info;

  return (
    <g>
      <path d={supplierWire(from, to)} fill="none" stroke={tone} strokeWidth={1.2} strokeDasharray="4 4" opacity={0.7} />
      <circle cx={from.x} cy={from.y} r={SUB_PORT_R} fill="var(--fc-surface)" stroke={tone} strokeWidth={1.6} />
      {/* A red asterisk on a required input — the reference's own mark, and the
          one that says "this line ships nothing without it". */}
      {port.required ? (
        <text x={from.x + 6} y={from.y - 4} fontSize={11} fontWeight={700} fill={TONE_VAR.loss}>
          *
        </text>
      ) : null}

      <circle
        cx={to.x}
        cy={to.y}
        r={SUPPLIER_R}
        fill="var(--fc-surface)"
        stroke={tone}
        strokeWidth={1.6}
        strokeDasharray={port.supplier === null ? '3 3' : undefined}
      />
      {port.supplier === null ? (
        <text x={to.x} y={to.y + 4} textAnchor="middle" fontSize={13} fontWeight={600} fill="var(--fc-ink-faint)">
          +
        </text>
      ) : (
        <text x={to.x} y={to.y + 4} textAnchor="middle" fontSize={9} fontWeight={700} fill={tone}>
          {initials(port.supplier.name)}
        </text>
      )}

      <text x={to.x} y={to.y + SUPPLIER_R + 12} textAnchor="middle" fontSize={9} fill="var(--fc-ink-dim)">
        {clip(port.label, 16)}
      </text>
      <text x={to.x} y={to.y + SUPPLIER_R + 22} textAnchor="middle" fontSize={8.5} fill="var(--fc-ink-faint)">
        {port.blocked ? 'nobody makes it' : (port.supplier?.name ?? 'open market')}
      </text>

      {onSelect === undefined ? null : (
        <rect
          x={to.x - TAP / 2}
          y={to.y - TAP / 2}
          width={TAP}
          height={TAP}
          fill="transparent"
          style={{ cursor: 'pointer' }}
          onPointerUp={onSelect}
        >
          <title>{`${port.label}${port.required ? ' (required)' : ''}`}</title>
        </rect>
      )}
    </g>
  );
}

/* -------------------------------------------------------------------------- */
/*  Small parts                                                                */
/* -------------------------------------------------------------------------- */

function CanvasButton({
  label,
  onClick,
  disabled = false,
  children,
}: {
  readonly label: string;
  readonly onClick: () => void;
  readonly disabled?: boolean;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      className="flex size-11 items-center justify-center rounded-card border border-hairline bg-surface text-ink-dim shadow-card disabled:opacity-40"
    >
      {children}
    </button>
  );
}

/** Two letters, for a supplier too small to carry a name. */
export function initials(name: string): string {
  const words = name.split(/\s+/).filter(Boolean);
  const first = words[0]?.[0] ?? '?';
  const second = words[1]?.[0] ?? words[0]?.[1] ?? '';
  return `${first}${second}`.toUpperCase();
}

/** Truncate with an ellipsis rather than letting a label overrun its card. */
export function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(1, max - 1))}…`;
}

export { clampScale };
