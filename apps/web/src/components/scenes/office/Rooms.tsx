'use client';

/**
 * The rooms.
 *
 * Each export here draws the *inside* of one zone into a fixed-size SVG box:
 * the floor, the furniture, and a grid of figures laid out from the zone's own
 * model. The zone frame — the border, the label, the badge, the hit area — is
 * `ZoneFrame` in `OfficeScene.tsx`; these functions only paint.
 *
 * Layout is a loop over cells (`DESK_CELL`, `RACK_CELL`, `EXEC_CELL`), so a
 * room grows and shrinks with real headcount without anyone hand-placing a
 * desk. Nothing in this file reads the store.
 */

import {
  Crate,
  DESK_CELL,
  Desk,
  EXEC_CELL,
  type FigureRole,
  Plant,
  RACK_CELL,
  Rack,
  Reception,
  VacantDesk,
  Whiteboard,
  Worker,
} from './Figures';
import type { MoraleBand, OfficeExecutive, OfficeServerRoom, OfficeWorkZone } from './model';
import { seatLook } from './seats';

/** Which colourway a working zone dresses its people in. */
export const ROLE_FIGURE: Readonly<Record<OfficeWorkZone['id'], FigureRole>> = {
  engineering: 'eng',
  research: 'res',
  sales: 'sal',
  operations: 'ops',
};

/** The floor a room is painted on. Drawn first, under everything. */
export function Floor({ width, height }: { readonly width: number; readonly height: number }): React.JSX.Element {
  return (
    <g>
      <rect x="0" y="0" width={width} height={height} rx="10" fill="var(--fc-floor)" />
      <rect x="0" y="0" width={width} height={Math.min(14, height / 3)} rx="10" fill="var(--fc-wall)" />
      <rect x="0" y={Math.min(14, height / 3) - 2} width={width} height="2" fill="var(--fc-wall-shade)" opacity="0.7" />
    </g>
  );
}

/**
 * A morale wash over the floor.
 *
 * The tint is the *company* morale metric — there is one morale figure in
 * state and the scene does not invent per-room variants — so every room shares
 * a colour and the expressions in every room share a mouth.
 */
export function MoraleWash({
  width,
  height,
  band,
}: {
  readonly width: number;
  readonly height: number;
  readonly band: MoraleBand;
}): React.JSX.Element | null {
  if (band === 'steady') return null;
  const fill =
    band === 'thriving' ? 'var(--color-gain)' : band === 'strained' ? 'var(--color-warn)' : 'var(--color-loss)';
  return <rect x="0" y="0" width={width} height={height} rx="10" fill={fill} opacity={band === 'thriving' ? 0.06 : 0.09} />;
}

/* -------------------------------------------------------------------------- */
/*  A working room                                                             */
/* -------------------------------------------------------------------------- */

export interface WorkRoomProps {
  readonly zone: OfficeWorkZone;
  readonly band: MoraleBand;
  readonly width: number;
  readonly height: number;
  /** Reserved strip at the top of the room for whiteboards or crates. */
  readonly shelfHeight?: number;
  readonly children?: React.ReactNode;
}

/**
 * Desks in a grid, people behind them, open roles as empty desks.
 *
 * Columns come from the room's own width, so the same component fills a narrow
 * research room and the full-width operations strip.
 */
export function WorkRoom({ zone, band, width, height, shelfHeight = 0, children }: WorkRoomProps): React.JSX.Element {
  const columns = Math.max(1, Math.floor((width - 8) / DESK_CELL.width));
  const gridWidth = columns * DESK_CELL.width;
  const originX = Math.max(4, (width - gridWidth) / 2);
  const role = ROLE_FIGURE[zone.id];

  return (
    <g>
      {children}
      {zone.seats.map((seat, index) => {
        const column = index % columns;
        const row = Math.floor(index / columns);
        const x = originX + column * DESK_CELL.width;
        const y = shelfHeight + row * DESK_CELL.height;
        if (y + DESK_CELL.height > height + 8) return null;
        const look = seatLook(seat.id);
        return (
          <g key={seat.id} transform={`translate(${x} ${y})`}>
            {seat.filled ? (
              <>
                <g transform={`translate(${(DESK_CELL.width - 24) / 2} 6)`}>
                  <Worker look={look} role={role} band={band} atKeyboard />
                </g>
                <Desk />
              </>
            ) : (
              <VacantDesk />
            )}
          </g>
        );
      })}
    </g>
  );
}

/** The whiteboard strip along the back of the research room. */
export function BoardShelf({ count, width }: { readonly count: number; readonly width: number }): React.JSX.Element {
  const drawn = Math.max(0, Math.min(count, Math.floor((width - 12) / 46)));
  return (
    <g>
      {Array.from({ length: drawn }, (_, index) => (
        <g key={index} transform={`translate(${8 + index * 46} 2)`}>
          <Whiteboard index={index} />
        </g>
      ))}
    </g>
  );
}

/** The crate stack along the back of the sales room. */
export function CrateShelf({ count, width }: { readonly count: number; readonly width: number }): React.JSX.Element {
  const drawn = Math.max(0, Math.min(count, Math.floor((width - 12) / 26)));
  return (
    <g>
      {Array.from({ length: drawn }, (_, index) => (
        <g key={index} transform={`translate(${8 + index * 26} 8)`}>
          <Crate index={index} />
        </g>
      ))}
    </g>
  );
}

/* -------------------------------------------------------------------------- */
/*  The lobby                                                                  */
/* -------------------------------------------------------------------------- */

export function LobbyRoom({
  companyId,
  band,
  width,
  height,
}: {
  readonly companyId: string;
  readonly band: MoraleBand;
  readonly width: number;
  readonly height: number;
}): React.JSX.Element {
  const receptionist = seatLook(`${companyId}/lobby/0`);
  const visitor = seatLook(`${companyId}/lobby/1`);
  return (
    <g>
      {/* glazed frontage */}
      <rect x="8" y="18" width={Math.max(40, width - 100)} height="26" rx="4" fill="var(--fc-glass)" opacity="0.85" />
      <path
        d={`M8 31h${Math.max(40, width - 100)}`}
        stroke="var(--color-panel)"
        strokeWidth="1.6"
        opacity="0.8"
      />

      <g transform={`translate(${Math.max(10, width - 96)} ${height - 30})`}>
        <Plant />
      </g>

      <g transform={`translate(${Math.max(8, (width - 84) / 2 - 26)} ${height - 42})`}>
        <g transform="translate(14 -22)">
          <Worker look={receptionist} role="ops" band={band} />
        </g>
        <Reception />
      </g>

      <g transform={`translate(${Math.max(8, width - 44)} ${height - 44})`}>
        <Worker look={visitor} role="sal" band={band} />
      </g>
    </g>
  );
}

/* -------------------------------------------------------------------------- */
/*  The executive row                                                          */
/* -------------------------------------------------------------------------- */

export function ExecutiveDesk({
  executive,
  band,
}: {
  readonly executive: OfficeExecutive;
  readonly band: MoraleBand;
}): React.JSX.Element {
  const look = seatLook(executive.seatId);
  return (
    <g>
      <g transform={`translate(${(EXEC_CELL.width - 24) / 2} 6)`}>
        <Worker look={look} role="exe" band={band} />
      </g>
      <g transform={`translate(${(EXEC_CELL.width - 54) / 2} 0)`}>
        <Desk />
      </g>
      {executive.isCeo ? (
        <g transform={`translate(${EXEC_CELL.width / 2 - 6} 0)`}>
          <path d="M0 7 2 3l2 3 2-3 2 4v2H0z" fill="var(--color-pop-4)" stroke="var(--color-panel)" strokeWidth="0.7" />
        </g>
      ) : null}
    </g>
  );
}

/* -------------------------------------------------------------------------- */
/*  The server room                                                            */
/* -------------------------------------------------------------------------- */

export function ServerRoom({
  server,
  width,
  height,
}: {
  readonly server: OfficeServerRoom;
  readonly width: number;
  readonly height: number;
}): React.JSX.Element {
  const columns = Math.max(1, Math.floor((width - 8) / RACK_CELL.width));
  const drawn = Math.min(server.racks, columns * Math.max(1, Math.floor(height / RACK_CELL.height)));
  const gridWidth = Math.min(drawn, columns) * RACK_CELL.width;
  const originX = Math.max(4, (width - gridWidth) / 2);

  // Utilisation drives how many of the six bays in a rack are lit, and the
  // colour: a rack running flat out is warm, an idle one is quiet.
  const litBays = Math.max(0, Math.min(6, Math.round(server.utilisation * 6)));
  const tone = server.utilisation >= 0.9 ? 'var(--color-warn)' : server.utilisation >= 0.35 ? 'var(--color-gain)' : 'var(--color-info)';

  if (drawn === 0) {
    return (
      <g>
        <rect
          x={width / 2 - 34}
          y={height / 2 - 24}
          width="68"
          height="48"
          rx="6"
          fill="var(--fc-vacant)"
          stroke="var(--color-hair-strong)"
          strokeWidth="1"
          strokeDasharray="4 3"
        />
      </g>
    );
  }

  return (
    <g>
      {Array.from({ length: drawn }, (_, index) => {
        const column = index % columns;
        const row = Math.floor(index / columns);
        return (
          <g key={index} transform={`translate(${originX + column * RACK_CELL.width} ${row * RACK_CELL.height})`}>
            <Rack lit={litBays} tone={tone} delayMs={index * 140} />
          </g>
        );
      })}
    </g>
  );
}
