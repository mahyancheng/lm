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

import type { Sector } from '@frontier/contracts';
import { SECTOR_TINT } from '@/components/ui';
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

/**
 * The floor a room is painted on, with the back wall above it. Drawn first,
 * under everything.
 *
 * The wall is a path rather than a second rounded rect: a rect with the floor's
 * corner radius would round its *bottom* corners too and cut two notches out of
 * the skirting.
 */
export function Floor({ width, height }: { readonly width: number; readonly height: number }): React.JSX.Element {
  const wall = Math.min(14, height / 3);
  const radius = Math.min(10, wall);
  return (
    <g>
      <rect x="0" y="0" width={width} height={height} rx="10" fill="var(--fc-floor)" />
      <path
        d={`M0 ${wall}V${radius}A${radius} ${radius} 0 0 1 ${radius} 0H${width - radius}A${radius} ${radius} 0 0 1 ${width} ${radius}V${wall}Z`}
        fill="var(--fc-wall)"
      />
      <rect x="0" y={wall - 2} width={width} height="2" fill="var(--fc-wall-shade)" opacity="0.7" />
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
  const role = ROLE_FIGURE[zone.id];
  const used = zone.seats.length;

  // Columns come from the room's width; the block of desks is then centred in
  // what is left below the shelf, so a three-person function reads as a small
  // team in a room rather than a row of desks pushed against the back wall.
  const columns = Math.max(1, Math.min(used || 1, Math.floor((width - 8) / DESK_CELL.width)));
  const rows = Math.max(1, Math.ceil(used / columns));
  const gridWidth = columns * DESK_CELL.width;
  const gridHeight = rows * DESK_CELL.height;
  const originX = Math.max(4, (width - gridWidth) / 2);
  const originY = shelfHeight + Math.max(0, (height - shelfHeight - gridHeight) / 2);

  // Corner planting, but only where there is floor left over for it.
  const slack = height - shelfHeight - gridHeight;
  const planted = slack >= 70 && width >= 160;

  if (used === 0) return <EmptyRoom width={width} height={height} />;

  return (
    <g>
      {children}
      {planted ? (
        <>
          <g transform={`translate(6 ${height - 28})`}>
            <Plant />
          </g>
          <g transform={`translate(${width - 26} ${height - 28})`}>
            <Plant />
          </g>
        </>
      ) : null}
      {zone.seats.map((seat, index) => {
        const column = index % columns;
        const row = Math.floor(index / columns);
        const x = originX + column * DESK_CELL.width;
        const y = originY + row * DESK_CELL.height;
        if (y + DESK_CELL.height > height + 10) return null;
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

/**
 * A function with nobody in it.
 *
 * An empty room is information — a company with no operations staff is one
 * supply shock from a bad quarter — so it is drawn as an explicit vacancy
 * rather than left as blank floor.
 */
export function EmptyRoom({ width, height }: { readonly width: number; readonly height: number }): React.JSX.Element {
  const boxWidth = Math.min(190, Math.max(120, width - 40));
  const x = (width - boxWidth) / 2;
  const y = Math.max(20, height / 2 - 26);
  return (
    <g>
      <rect
        x={x}
        y={y}
        width={boxWidth}
        height="52"
        rx="10"
        fill="var(--color-panel)"
        stroke="var(--color-hair-strong)"
        strokeWidth="1.2"
        strokeDasharray="5 4"
      />
      <circle cx={x + 26} cy={y + 26} r="11" fill="var(--color-brand-wash)" />
      <path d={`M${x + 26} ${y + 20}v12M${x + 20} ${y + 26}h12`} stroke="var(--color-brand)" strokeWidth="1.8" strokeLinecap="round" />
      <text x={x + 46} y={y + 30} fontSize="11" fontWeight="600" fill="var(--color-ink-faint)">
        Nobody here yet
      </text>
    </g>
  );
}

/** The whiteboard strip along the back of the research room, one per programme. */
export function BoardShelf({ count, width }: { readonly count: number; readonly width: number }): React.JSX.Element {
  const drawn = Math.max(0, Math.min(count, Math.floor((width - 12) / 46)));
  const originX = Math.max(6, (width - drawn * 46 + 6) / 2);
  return (
    <g>
      {Array.from({ length: drawn }, (_, index) => (
        <g key={index} transform={`translate(${originX + index * 46} 2)`}>
          <Whiteboard index={index} />
        </g>
      ))}
    </g>
  );
}

/** The crate stack along the back of the sales room, one per live product. */
export function CrateShelf({ count, width }: { readonly count: number; readonly width: number }): React.JSX.Element {
  const drawn = Math.max(0, Math.min(count, Math.floor((width - 12) / 26)));
  const originX = Math.max(6, (width - drawn * 26 + 6) / 2);
  return (
    <g>
      {Array.from({ length: drawn }, (_, index) => (
        <g key={index} transform={`translate(${originX + index * 26} 6)`}>
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
  sector,
}: {
  readonly companyId: string;
  readonly band: MoraleBand;
  readonly width: number;
  readonly height: number;
  /** The industry this company is in. Paints the sign over reception. */
  readonly sector: Sector;
}): React.JSX.Element {
  const receptionist = seatLook(`${companyId}/lobby/0`);
  const visitor = seatLook(`${companyId}/lobby/1`);
  const glass = Math.max(60, width - 96);
  const mullions = Math.max(2, Math.round(glass / 42));
  const deskY = height - 44;
  return (
    <g>
      {/* glazed frontage */}
      <rect x="8" y="18" width={glass} height="30" rx="4" fill="var(--fc-glass)" opacity="0.85" />
      {Array.from({ length: mullions - 1 }, (_, index) => (
        <path
          key={index}
          d={`M${8 + ((index + 1) * glass) / mullions} 18v30`}
          stroke="var(--color-panel)"
          strokeWidth="1.6"
          opacity="0.75"
        />
      ))}
      <path d={`M8 33h${glass}`} stroke="var(--color-panel)" strokeWidth="1.6" opacity="0.75" />

      {/* The sign over reception, in the company's own industry colour. It is
          the one place in the office that says what the company does — the
          rooms say how big it is and how it feels, which is a different fact. */}
      <rect x="8" y="54" width={Math.max(28, Math.min(74, width - 120))} height="9" rx="4.5" fill={SECTOR_TINT[sector]} opacity="0.85" />

      <g transform={`translate(${Math.max(10, width - 30)} ${height - 30})`}>
        <Plant />
      </g>

      <g transform={`translate(${Math.max(6, (width - 84) / 2 - 22)} ${deskY})`}>
        <g transform="translate(14 -30)">
          <Worker look={receptionist} role="ops" band={band} />
        </g>
        <Reception />
      </g>

      <g transform={`translate(${Math.max(8, width - 64)} ${height - 44})`}>
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
        <g transform={`translate(${EXEC_CELL.width / 2 - 4} 0)`}>
          <path d="M0 7 2 3l2 3 2-3 2 4v2H0z" fill="var(--color-pop-4)" stroke="var(--color-panel)" strokeWidth="0.7" />
        </g>
      ) : null}
    </g>
  );
}

/**
 * The back wall of the executive row: a boardroom table and its chairs.
 *
 * Pure decoration, drawn above where the desks sit, so the room reads as a
 * suite whether one executive occupies it or five. It carries no figure and
 * makes no claim.
 */
export function ExecutiveBackdrop({ width }: { readonly width: number }): React.JSX.Element {
  const tableWidth = Math.max(76, Math.min(200, width * 0.34));
  const x = (width - tableWidth) / 2;
  const seats = 4;
  const seatX = (index: number): number => x + ((index + 0.5) * tableWidth) / seats;
  return (
    <g>
      {Array.from({ length: seats }, (_, index) => (
        <circle key={`back-${index}`} cx={seatX(index)} cy="6" r="3.6" fill="var(--fc-chair)" />
      ))}
      <rect x={x} y="11" width={tableWidth} height="13" rx="6.5" fill="var(--fc-desk)" />
      <rect x={x} y="11" width={tableWidth} height="5" rx="2.5" fill="var(--fc-desk-top)" />
      {Array.from({ length: seats }, (_, index) => (
        <circle key={`front-${index}`} cx={seatX(index)} cy="29" r="3.6" fill="var(--fc-chair)" />
      ))}
      <g transform={`translate(${Math.max(4, x - 34)} 2)`}>
        <Plant />
      </g>
      <g transform={`translate(${Math.min(width - 24, x + tableWidth + 14)} 2)`}>
        <Plant />
      </g>
    </g>
  );
}

/**
 * A desk on the executive row that the payroll says exists but no character in
 * this session occupies. Drawn, because `EmployeeBase.execs` is committed
 * state; anonymous, because there is nobody behind it to open.
 */
export function AnonymousExecutiveDesk({
  seatId: id,
  band,
}: {
  readonly seatId: string;
  readonly band: MoraleBand;
}): React.JSX.Element {
  return (
    <g opacity="0.72">
      <g transform={`translate(${(EXEC_CELL.width - 24) / 2} 6)`}>
        <Worker look={seatLook(id)} role="exe" band={band} />
      </g>
      <g transform={`translate(${(EXEC_CELL.width - 54) / 2} 0)`}>
        <Desk />
      </g>
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
  const rows = Math.max(1, Math.floor(height / RACK_CELL.height));
  const owned = Math.min(server.racks, columns * rows);
  const rented = Math.max(0, Math.min(server.cloudRacks, columns * rows - owned));
  const drawn = owned + rented;
  const gridWidth = Math.min(Math.max(drawn, 1), columns) * RACK_CELL.width;
  const originX = Math.max(4, (width - gridWidth) / 2);

  // Utilisation drives how many of the six bays in a rack are lit, and the
  // colour: a rack running flat out is warm, an idle one is quiet.
  const litBays = Math.max(0, Math.min(6, Math.round(server.utilisation * 6)));
  const tone = server.utilisation >= 0.9 ? 'var(--color-warn)' : server.utilisation >= 0.35 ? 'var(--color-gain)' : 'var(--color-info)';

  if (drawn === 0) {
    return (
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
    );
  }

  return (
    <g>
      {Array.from({ length: drawn }, (_, index) => {
        const column = index % columns;
        const row = Math.floor(index / columns);
        return (
          <g key={index} transform={`translate(${originX + column * RACK_CELL.width} ${row * RACK_CELL.height})`}>
            <Rack lit={litBays} tone={tone} delayMs={index * 140} rented={index >= owned} />
          </g>
        );
      })}
    </g>
  );
}
