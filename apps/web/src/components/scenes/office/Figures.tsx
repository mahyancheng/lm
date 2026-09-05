'use client';

/**
 * The office's flat-vector vocabulary: one person, one desk, one rack, one
 * plant, one whiteboard, one crate.
 *
 * Everything is drawn in its own small coordinate box and positioned by the
 * caller with a `translate`, so a room is a loop over cells rather than a
 * hand-placed illustration. No shape here reads state directly: a figure is a
 * `SeatLook` (derived from `fnv1a64` of a seat id) plus a role and a morale
 * band, and that is the whole input. Two renders of the same seat are identical
 * forever.
 *
 * Colour rule: every fill is `var(--fc-*)`, aliased in `styles.ts` onto the
 * illustration tokens in `globals.css`. There is no hex in this file.
 */

import type { CSSProperties } from 'react';
import type { MoraleBand } from './model';
import type { SeatLook } from './seats';

/* -------------------------------------------------------------------------- */
/*  Geometry constants the rooms lay out against                               */
/* -------------------------------------------------------------------------- */

/** One desk and the person behind it. */
export const DESK_CELL = { width: 54, height: 62 } as const;
/** One executive desk, which is wider and carries a name plate. */
export const EXEC_CELL = { width: 82, height: 62 } as const;
/** One server rack. */
export const RACK_CELL = { width: 26, height: 68 } as const;
/** The figure's own box: feet sit on y = 36. */
export const FIGURE = { width: 24, height: 36 } as const;

/* -------------------------------------------------------------------------- */
/*  Role colourways                                                            */
/* -------------------------------------------------------------------------- */

export type FigureRole = 'eng' | 'res' | 'sal' | 'ops' | 'exe';

/** Outfit variable for a role and an outfit index (0-2). */
function clothVar(role: FigureRole, outfit: number): string {
  return `var(--fc-${role}-${outfit % 3})`;
}

function skinVar(look: SeatLook): string {
  return `var(--fc-skin-${look.skin})`;
}

function hairVar(look: SeatLook): string {
  return `var(--fc-hair-${look.hairColour})`;
}

/**
 * Custom properties that drive the CSS idle animations.
 *
 * They are plain CSS variables rather than inline `animation` shorthands so the
 * `prefers-reduced-motion` block in the stylesheet can switch every one of them
 * off with a single rule.
 */
export function motionVars(durationMs: number, delayMs: number): CSSProperties {
  return { '--fc-dur': `${durationMs}ms`, '--fc-delay': `${delayMs}ms` } as unknown as CSSProperties;
}

/* -------------------------------------------------------------------------- */
/*  The person                                                                 */
/* -------------------------------------------------------------------------- */

/** Hair, in six flat shapes. Drawn over the head circle. */
function Hair({ look }: { readonly look: SeatLook }): React.JSX.Element {
  const fill = hairVar(look);
  switch (look.hairStyle) {
    case 1:
      return (
        <g fill={fill}>
          <path d="M5.24 7.6A7 7 0 0 1 18.76 7.6Z" />
          <rect x="4.5" y="6.4" width="2.7" height="7.4" rx="1.35" />
          <rect x="16.8" y="6.4" width="2.7" height="7.4" rx="1.35" />
        </g>
      );
    case 2:
      return (
        <g fill={fill}>
          <path d="M5.24 7.6A7 7 0 0 1 18.76 7.6Z" />
          <circle cx="7.6" cy="5.4" r="2.4" />
          <circle cx="12" cy="3.8" r="2.6" />
          <circle cx="16.4" cy="5.4" r="2.4" />
        </g>
      );
    case 3:
      return (
        <g fill={fill}>
          <path d="M5.24 7.6A7 7 0 0 1 18.76 7.6Z" />
          <circle cx="12" cy="2.6" r="2.5" />
        </g>
      );
    case 4:
      return (
        <g fill={fill}>
          <path d="M5.24 7.6A7 7 0 0 1 18.76 7.6Z" />
          <ellipse cx="19.5" cy="11.6" rx="1.8" ry="3.6" />
        </g>
      );
    case 5:
      return <path d="M6 5.8A7 7 0 0 1 18 5.8Z" fill={fill} />;
    default:
      return <path d="M5.24 7.6A7 7 0 0 1 18.76 7.6Z" fill={fill} />;
  }
}

/** The mouth carries morale. Four shapes, one per band. */
function Mouth({ band }: { readonly band: MoraleBand }): React.JSX.Element {
  const stroke = 'var(--color-ink)';
  const shared = { fill: 'none', stroke, strokeWidth: 0.9, strokeLinecap: 'round' as const };
  switch (band) {
    case 'thriving':
      return <path d="M9.6 12.1q2.4 2.4 4.8 0" {...shared} />;
    case 'steady':
      return <path d="M10.1 12.6q1.9 1.1 3.8 0" {...shared} />;
    case 'strained':
      return <path d="M10.1 12.9h3.8" {...shared} />;
    default:
      return <path d="M10.1 13.3q1.9-1.5 3.8 0" {...shared} />;
  }
}

/** The torso, decorated by role: hoodie, lab coat, blazer, polo, suit. */
function Torso({ role, look }: { readonly role: FigureRole; readonly look: SeatLook }): React.JSX.Element {
  const cloth = clothVar(role, look.outfit);
  const body = 'M12 16.2c-4.4 0-7.4 2.5-7.9 6.2L3.4 33.4c-.1.9.6 1.6 1.5 1.6h14.2c.9 0 1.6-.7 1.5-1.6l-.7-11c-.5-3.7-3.5-6.2-7.9-6.2z';
  const accent = `var(--color-pop-${(look.outfit % 4) + 1})`;

  switch (role) {
    case 'eng':
      return (
        <g>
          <path d={body} fill={cloth} />
          {/* hood, then drawstrings */}
          <path d="M5.6 18.6q6.4-3.6 12.8 0v2.6q-6.4-3-12.8 0z" fill="var(--fc-shadow)" />
          <path d="M10.6 21.4v4M13.4 21.4v4" stroke="var(--color-cloth-lab)" strokeWidth="0.7" strokeLinecap="round" />
        </g>
      );
    case 'res':
      return (
        <g>
          <path d={body} fill={cloth} />
          <path d="M12 16.4 8.8 18.6l1.4 4.2h3.6l1.4-4.2z" fill={accent} />
          <path d="M12 22.8v11.2" stroke="var(--color-build-side)" strokeWidth="0.7" />
          <rect x="14.6" y="25.4" width="4" height="3.4" rx="0.8" fill="var(--color-build-side)" />
        </g>
      );
    case 'sal':
      return (
        <g>
          <path d={body} fill={cloth} />
          <path d="M12 16.4 9 18.4l3 3.2 3-3.2z" fill="var(--color-cloth-lab)" />
          <path d="M12 20.4l1.3 1.4-1.3 5.6-1.3-5.6z" fill={accent} />
        </g>
      );
    case 'exe':
      return (
        <g>
          <path d={body} fill={cloth} />
          <path d="M12 16.4 8.9 18.4l3.1 3.4 3.1-3.4z" fill="var(--color-cloth-lab)" />
          <path d="M12 20.6l1.35 1.5-1.35 6.2-1.35-6.2z" fill="var(--color-brand)" />
        </g>
      );
    default:
      return (
        <g>
          <path d={body} fill={cloth} />
          <path d="M8.8 17.2q3.2 2.6 6.4 0l-1 2.4q-2.2 1.4-4.4 0z" fill="var(--fc-shadow)" />
        </g>
      );
  }
}

export interface WorkerProps {
  readonly look: SeatLook;
  readonly role: FigureRole;
  readonly band: MoraleBand;
  /** Rooms with keyboards animate the wrists; the lobby and the exec row do not. */
  readonly atKeyboard?: boolean;
}

/**
 * One round-headed flat-vector worker, feet on y = 36.
 *
 * The idle bob is a CSS animation on a `<g>`; its period and phase come from
 * the seat's own hash, so a room breathes out of step with itself rather than
 * in unison.
 */
export function Worker({ look, role, band, atKeyboard = false }: WorkerProps): React.JSX.Element {
  const skin = skinVar(look);
  const cloth = clothVar(role, look.outfit);
  const typing = atKeyboard && look.typing;

  return (
    <g>
      <ellipse cx="12" cy="35.2" rx="8.4" ry="2.1" fill="var(--fc-shadow-soft)" />
      <g className="fc-office-figure" style={motionVars(look.bobDurationMs, look.bobDelayMs)}>
        <Torso role={role} look={look} />

        {/* arms — the pair alternates, so a keyboard reads as a keyboard */}
        <g
          className={typing ? 'fc-office-hand' : undefined}
          style={typing ? motionVars(1200 + (look.bobDelayMs % 400), look.bobDelayMs) : undefined}
        >
          <rect x="2.8" y="20.8" width="3.3" height="8.6" rx="1.65" fill={cloth} />
          <circle cx="4.45" cy="29.4" r="1.7" fill={skin} />
        </g>
        <g
          className={typing ? 'fc-office-hand' : undefined}
          style={typing ? motionVars(1200 + (look.bobDelayMs % 400), look.bobDelayMs + 320) : undefined}
        >
          <rect x="17.9" y="20.8" width="3.3" height="8.6" rx="1.65" fill={cloth} />
          <circle cx="19.55" cy="29.4" r="1.7" fill={skin} />
        </g>

        {/* head */}
        <g transform={`translate(${look.lean * 0.6} 0)`}>
          <circle cx="12" cy="9.4" r="7" fill={skin} />
          <Hair look={look} />
          <circle cx="9.5" cy="9.7" r="0.95" fill="var(--color-ink)" />
          <circle cx="14.5" cy="9.7" r="0.95" fill="var(--color-ink)" />
          <Mouth band={band} />
        </g>
      </g>
    </g>
  );
}

/* -------------------------------------------------------------------------- */
/*  Furniture                                                                  */
/* -------------------------------------------------------------------------- */

/** A desk with a monitor. Drawn *after* its worker, so the worker sits behind it. */
export function Desk({ lit = true }: { readonly lit?: boolean }): React.JSX.Element {
  return (
    <g>
      <rect x="19" y="30.5" width="16" height="11.5" rx="2" fill="var(--fc-screen-off)" />
      <rect x="20.4" y="31.8" width="13.2" height="7.6" rx="1.2" fill={lit ? 'var(--fc-screen-on)' : 'var(--fc-vacant)'} />
      <rect x="25.6" y="42" width="2.8" height="2.4" fill="var(--fc-chair)" />
      <ellipse cx="27" cy="53.4" rx="20" ry="2.6" fill="var(--fc-shadow-soft)" />
      <rect x="6" y="43" width="42" height="9.5" rx="3" fill="var(--fc-desk)" />
      <rect x="6" y="43" width="42" height="4" rx="2" fill="var(--fc-desk-top)" />
    </g>
  );
}

/**
 * An empty desk: the seat an open role has not filled yet.
 *
 * The desk is drawn first and the hiring badge above it, so the badge is not
 * hidden behind the monitor the way a person would be.
 */
export function VacantDesk(): React.JSX.Element {
  return (
    <g>
      <Desk lit={false} />
      <rect
        x="19.5"
        y="12"
        width="15"
        height="15"
        rx="5"
        fill="var(--color-brand-wash)"
        stroke="var(--color-brand)"
        strokeWidth="1"
        strokeDasharray="3 2.4"
      />
      <path d="M27 16.5v6M24 19.5h6" stroke="var(--color-brand)" strokeWidth="1.4" strokeLinecap="round" />
    </g>
  );
}

/**
 * A server rack. `lit` LEDs of `rows` glow; the rest are dark.
 *
 * `rented` draws the rack hollow: capacity the company pays for by the quarter
 * rather than owns, which is a materially different thing to be standing on.
 */
export function Rack({
  rows = 6,
  lit,
  tone,
  delayMs,
  rented = false,
}: {
  readonly rows?: number;
  readonly lit: number;
  readonly tone: string;
  readonly delayMs: number;
  readonly rented?: boolean;
}): React.JSX.Element {
  const bays = Array.from({ length: rows }, (_, index) => index);
  return (
    <g>
      <ellipse cx="13" cy="65" rx="11" ry="2.4" fill="var(--fc-shadow-soft)" opacity={rented ? 0.5 : 1} />
      {rented ? (
        <>
          <rect x="1" y="4" width="24" height="60" rx="4" fill="var(--fc-rack-face)" opacity="0.55" />
          <rect
            x="1"
            y="4"
            width="24"
            height="60"
            rx="4"
            fill="none"
            stroke="var(--fc-rack)"
            strokeWidth="1.2"
            strokeDasharray="4 3"
          />
        </>
      ) : (
        <>
          <rect x="1" y="4" width="24" height="60" rx="4" fill="var(--fc-rack)" />
          <rect x="3.4" y="6.4" width="19.2" height="55.2" rx="3" fill="var(--fc-rack-face)" />
        </>
      )}
      {bays.map((bay) => {
        const y = 9 + bay * 8.6;
        const on = bay < lit;
        return (
          <g key={bay}>
            <rect x="5.4" y={y} width="15.2" height="5.4" rx="1.4" fill="var(--fc-screen-off)" />
            <circle
              cx="18"
              cy={y + 2.7}
              r="1.25"
              fill={on ? tone : 'var(--fc-vacant)'}
              className={on ? 'fc-office-led' : undefined}
              style={on ? motionVars(2000 + bay * 170, delayMs + bay * 120) : undefined}
            />
            <path d={`M7.2 ${y + 2.7}h7`} stroke="var(--fc-rack)" strokeWidth="1" strokeLinecap="round" opacity="0.5" />
          </g>
        );
      })}
    </g>
  );
}

/** A potted plant, 20 x 26. The office's only ornament. */
export function Plant(): React.JSX.Element {
  return (
    <g>
      <ellipse cx="10" cy="25.4" rx="7" ry="1.7" fill="var(--fc-shadow-soft)" />
      <path d="M10 16c0-5.2 3.2-8.4 6.4-8.4 0 4.4-2.6 7.4-6.4 8.4z" fill="var(--fc-plant)" />
      <path d="M10 16c0-5.2-3.2-8.4-6.4-8.4 0 4.4 2.6 7.4 6.4 8.4z" fill="var(--fc-plant)" opacity="0.75" />
      <rect x="9.4" y="10" width="1.2" height="6.6" rx="0.6" fill="var(--fc-plant)" />
      <path d="M4.6 16h10.8l-1.3 8.2a1.7 1.7 0 0 1-1.7 1.4H7.6a1.7 1.7 0 0 1-1.7-1.4z" fill="var(--fc-plant-pot)" />
    </g>
  );
}

/** A whiteboard, 40 x 28. One per running research programme. */
export function Whiteboard({ index }: { readonly index: number }): React.JSX.Element {
  return (
    <g>
      <rect x="0" y="0" width="40" height="27" rx="3" fill="var(--fc-board)" stroke="var(--color-hair-strong)" strokeWidth="1" />
      <path
        d={index % 2 === 0 ? 'M5 8h16M5 13h24M5 18h11' : 'M5 8h22M5 13h13M5 18h19'}
        stroke="var(--color-info)"
        strokeWidth="1.6"
        strokeLinecap="round"
        opacity="0.7"
      />
      <rect x="0" y="27" width="40" height="2.4" rx="1.2" fill="var(--fc-desk)" />
    </g>
  );
}

/** A product crate, 20 x 16. One per live product line. */
export function Crate({ index }: { readonly index: number }): React.JSX.Element {
  return (
    <g>
      <rect x="0" y="0" width="20" height="16" rx="3" fill={`var(--color-pop-${(index % 8) + 1})`} />
      <rect x="0" y="0" width="20" height="5" rx="2.5" fill="var(--color-cloth-lab)" opacity="0.45" />
      <path d="M10 0v16" stroke="var(--color-cloth-lab)" strokeWidth="1.2" opacity="0.6" />
    </g>
  );
}

/** The reception counter in the lobby, 84 x 30. */
export function Reception(): React.JSX.Element {
  return (
    <g>
      <ellipse cx="42" cy="31" rx="40" ry="2.6" fill="var(--fc-shadow-soft)" />
      <rect x="0" y="6" width="84" height="24" rx="4" fill="var(--fc-desk)" />
      <rect x="0" y="6" width="84" height="7" rx="3.5" fill="var(--fc-desk-top)" />
      <rect x="8" y="16" width="20" height="9" rx="2" fill="var(--fc-screen-on)" opacity="0.85" />
    </g>
  );
}
