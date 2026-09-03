'use client';

/**
 * The icon set.
 *
 * Thirty-six hand-drawn flat marks on a 24×24 grid, in the same drawing
 * language as the people and the places: **solid rounded shapes, no outlines,
 * no strokes, no emoji, no letter monograms**. Every mark is built from the
 * primitives the art direction already uses — rounded rects, circles, ellipses
 * and short filled paths — so an icon beside a portrait or a building looks
 * like it was drawn by the same hand.
 *
 * Two colours, always:
 *
 * - the **base** is `currentColor`, so an icon takes the colour of the text it
 *   sits with — including white on a `-strong` fill;
 * - the **accent** is one detail per mark (a needle, a roof, a liquid, a
 *   clasp), painted with `var(--fc-icon-accent)`, which the `accent` prop sets
 *   from the tone tokens and which defaults to `brand`.
 *
 * That is the whole system. There is no third colour and no hex literal.
 *
 * ```tsx
 * <Icon name="flask" size={18} />                 // brand accent, inherits ink
 * <Icon name="gauge" accent="current" />          // monochrome, e.g. on a filled chip
 * <Icon name="trophy" label="Leaderboard" />      // announced instead of hidden
 * ```
 */

import type { CSSProperties } from 'react';
import { TONE_CHIP, TONE_SOLID, TONE_VAR, cx, type Tone } from './tokens';

/* -------------------------------------------------------------------------- */
/*  Names                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Every mark, in one list.
 *
 * The order is the order of the interface: the eighteen screens, then the five
 * nav groups, then the utility marks. `nav.ts` names icons from this list, and
 * `components/shell/nav.test.ts` checks that every id it names exists here.
 */
export const ICON_NAMES = [
  // screens
  'gauge',
  'building',
  'box',
  'people',
  'ledger',
  'flask',
  'capitol',
  'handshake',
  'chart',
  'coins',
  'boardTable',
  'globe',
  'chat',
  'network',
  'trophy',
  'briefcase',
  'portfolio',
  'stamp',
  'newspaper',
  // groups
  'desk',
  'compass',
  'vault',
  'playMark',
  // utility
  'settings',
  'bell',
  'live',
  'close',
  'chevronRight',
  'chevronDown',
  'check',
  'warning',
  'search',
  'plus',
  'save',
  'export',
  'import',
  'back',
  'menu',
  'logo',
] as const;

export type IconName = (typeof ICON_NAMES)[number];

const NAME_SET: ReadonlySet<string> = new Set<string>(ICON_NAMES);

/**
 * Is this value a name from the set?
 *
 * The primitives that take an `icon` slot accept either a node or a name, so
 * `icon="flask"` draws the flask instead of printing the word.
 */
export function isIconName(value: unknown): value is IconName {
  return typeof value === 'string' && NAME_SET.has(value);
}

/**
 * How the one accent detail is painted.
 *
 * - a `Tone` — the usual case, a second flat colour on a plain surface;
 * - `current` — folded into the base, for marks whose silhouette says enough;
 * - `inherit` — read `--fc-icon-accent` from an ancestor. This is how a mark
 *   sits on a *filled* surface: set that property to the fill colour and the
 *   detail becomes a knockout instead of a second colour that would vanish.
 */
export type IconAccent = Tone | 'current' | 'inherit';

/* -------------------------------------------------------------------------- */
/*  Drawings                                                                   */
/* -------------------------------------------------------------------------- */

/** Base fill: whatever colour the icon inherits. */
const B = 'currentColor';
/** Accent fill: the one detail that carries the tone. */
const A = 'var(--fc-icon-accent)';

/**
 * The mark itself — children of the `<svg>`, so one shared element serves every
 * size and every accent. Nothing here knows its own colour: the base inherits
 * and the accent reads a custom property set on the `<svg>`.
 */
const SHAPES: Readonly<Record<IconName, React.JSX.Element>> = {
  /* --- screens ---------------------------------------------------------- */

  /** Command Centre: a dial with a needle sitting a little past the middle. */
  gauge: (
    <>
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M2.4 18.8a9.6 9.6 0 0 1 19.2 0 1.3 1.3 0 0 1-1.3 1.3h-2.6a1.3 1.3 0 0 1-1.3-1.3 6 6 0 0 0-12 0 1.3 1.3 0 0 1-1.3 1.3H3.7a1.3 1.3 0 0 1-1.3-1.3Z"
        fill={B}
      />
      <circle cx="12" cy="18.8" r="2.6" fill={B} />
      <rect x="10.8" y="9.4" width="2.4" height="9.4" rx="1.2" fill={A} transform="rotate(40 12 18.8)" />
    </>
  ),

  /** Company: two volumes, the tall one wearing the windows. */
  building: (
    <>
      <rect x="2.8" y="9.2" width="7.6" height="11.8" rx="1.8" fill={B} />
      <rect x="11.4" y="3" width="9.8" height="18" rx="2" fill={B} />
      <g fill={A}>
        <rect x="13.6" y="5.8" width="2.6" height="2.6" rx="0.8" />
        <rect x="16.8" y="5.8" width="2.6" height="2.6" rx="0.8" />
        <rect x="13.6" y="10" width="2.6" height="2.6" rx="0.8" />
        <rect x="16.8" y="10" width="2.6" height="2.6" rx="0.8" />
        <rect x="4.8" y="12.4" width="3.6" height="2.6" rx="0.8" />
      </g>
    </>
  ),

  /** Products: a parcel with its tape running over the lid. */
  box: (
    <>
      <rect x="3.2" y="7.6" width="17.6" height="13.4" rx="2.4" fill={B} />
      <rect x="2" y="3.4" width="20" height="4.8" rx="1.6" fill={B} />
      <rect x="10.2" y="3.4" width="3.6" height="17.6" rx="0.6" fill={A} />
    </>
  ),

  /** People: two round-headed figures, the nearer one overlapping the other. */
  people: (
    <>
      <circle cx="8.2" cy="7.4" r="3.5" fill={B} />
      <path d="M1.8 20.4c.4-3.5 3-5.9 6.4-5.9s6 2.4 6.4 5.9H1.8Z" fill={B} />
      <circle cx="16.4" cy="8.8" r="3" fill={A} />
      <path d="M11 20.4c.4-2.9 2.5-4.8 5.4-4.8s5 1.9 5.4 4.8H11Z" fill={A} />
    </>
  ),

  /** Financials: the ledger page, ruled. */
  ledger: (
    <>
      <rect x="4" y="2.6" width="16" height="18.8" rx="2.6" fill={B} />
      <g fill={A}>
        <rect x="6.8" y="6.4" width="10.4" height="2.1" rx="1.05" />
        <rect x="6.8" y="10.9" width="7.2" height="2.1" rx="1.05" />
        <rect x="6.8" y="15.4" width="9" height="2.1" rx="1.05" />
      </g>
    </>
  ),

  /** Research: a flask with something in it. */
  flask: (
    <>
      <path
        d="M9.4 2.6h5.2a1.3 1.3 0 0 1 0 2.6h-.4v3.9l4.9 8.5c1 1.8-.3 4-2.3 4H7.2c-2 0-3.3-2.2-2.3-4l4.9-8.5V5.2h-.4a1.3 1.3 0 0 1 0-2.6Z"
        fill={B}
      />
      <path d="M6.6 14.6h10.8l1.7 3c1 1.8-.3 4-2.3 4H7.2c-2 0-3.3-2.2-2.3-4Z" fill={A} />
    </>
  ),

  /** Government: the dome, the colonnade, the steps. */
  capitol: (
    <>
      <path d="M12 2.4a5 5 0 0 0-5 5h10a5 5 0 0 0-5-5Z" fill={B} />
      <rect x="2.8" y="7.6" width="18.4" height="2.6" rx="1.3" fill={A} />
      <g fill={B}>
        <rect x="5.2" y="10.6" width="2.2" height="7.4" rx="1.1" />
        <rect x="9.1" y="10.6" width="2.2" height="7.4" rx="1.1" />
        <rect x="13" y="10.6" width="2.2" height="7.4" rx="1.1" />
        <rect x="16.9" y="10.6" width="2.2" height="7.4" rx="1.1" />
      </g>
      <rect x="2.2" y="18.4" width="19.6" height="2.8" rx="1.4" fill={B} />
    </>
  ),

  /** Deal Room: two arms and the grip between them. */
  handshake: (
    <>
      <g fill={B}>
        <rect x="1" y="11.4" width="10.4" height="4.6" rx="2.3" transform="rotate(-16 6.2 13.7)" />
        <rect x="12.6" y="11.4" width="10.4" height="4.6" rx="2.3" transform="rotate(16 17.8 13.7)" />
        <rect x="8.3" y="7.4" width="7.4" height="8.4" rx="2.8" />
      </g>
      {/* the seam where the two hands meet */}
      <rect x="11.2" y="8.4" width="1.6" height="6.4" rx="0.8" fill={A} />
    </>
  ),

  /** Markets: three bars, the last one leading. */
  chart: (
    <>
      <g fill={B}>
        <rect x="2.8" y="12.6" width="4.8" height="8.4" rx="1.6" />
        <rect x="9.6" y="8.4" width="4.8" height="12.6" rx="1.6" />
        <rect x="16.4" y="3.6" width="4.8" height="17.4" rx="1.6" />
      </g>
      {/* the trend, cutting across all three */}
      <rect x="1.4" y="9.6" width="21.2" height="2.4" rx="1.2" fill={A} transform="rotate(-27 12 10.8)" />
    </>
  ),

  /** Capital: a stack of coins, the top one fresh. */
  coins: (
    <>
      <g fill={B}>
        <ellipse cx="12" cy="17.6" rx="8.6" ry="3.4" />
        <ellipse cx="12" cy="13.2" rx="8.6" ry="3.4" />
        <ellipse cx="12" cy="8.8" rx="8.6" ry="3.4" />
        <ellipse cx="12" cy="5.4" rx="8.6" ry="3.4" />
      </g>
      <ellipse cx="12" cy="5.4" rx="4.4" ry="1.6" fill={A} />
    </>
  ),

  /** Boardroom: the table and the seats around it. */
  boardTable: (
    <>
      <g fill={B}>
        <rect x="2.6" y="8.6" width="18.8" height="6.8" rx="2.6" />
        <circle cx="6.4" cy="4.8" r="2.2" />
        <circle cx="12" cy="4.4" r="2.4" />
        <circle cx="17.6" cy="4.8" r="2.2" />
        <circle cx="6.4" cy="19.2" r="2.2" />
        <circle cx="12" cy="19.6" r="2.4" />
        <circle cx="17.6" cy="19.2" r="2.2" />
      </g>
      {/* the papers on the table */}
      <rect x="8.6" y="10.4" width="6.8" height="3.2" rx="1.1" fill={A} />
    </>
  ),

  /** World: the globe, with its meridians. */
  globe: (
    <>
      <circle cx="12" cy="12" r="9.4" fill={B} />
      <g fill={A}>
        <ellipse cx="12" cy="12" rx="9.4" ry="2.1" />
        <ellipse cx="12" cy="12" rx="3.5" ry="9.4" />
      </g>
    </>
  ),

  /** Social: someone said something, someone answered. */
  chat: (
    <>
      <rect x="2" y="3.6" width="14.6" height="10.6" rx="3.2" fill={B} />
      <path d="M5.4 13.4h4.4l-4.6 4.4a.9.9 0 0 1-1.5-.7v-3.7Z" fill={B} />
      <g fill={A}>
        <rect x="11.4" y="11.4" width="10.6" height="7.8" rx="2.8" />
        <path d="M18.6 18.4v3.4l-3.8-3.4Z" />
      </g>
    </>
  ),

  /** Network: who is connected to whom. */
  network: (
    <>
      <g fill={B}>
        <rect x="11.1" y="10.4" width="1.8" height="8.4" rx="0.9" />
        <rect x="11.1" y="5.6" width="1.8" height="8.4" rx="0.9" transform="rotate(48 12 9.8)" />
        <rect x="11.1" y="5.6" width="1.8" height="8.4" rx="0.9" transform="rotate(-48 12 9.8)" />
        <circle cx="4.4" cy="6" r="2.9" />
        <circle cx="19.6" cy="6" r="2.9" />
        <circle cx="12" cy="20" r="2.9" />
      </g>
      <circle cx="12" cy="11.2" r="3.6" fill={A} />
    </>
  ),

  /** Leaderboard: the cup. */
  trophy: (
    <>
      <path d="M6.8 4.6h10.4v4.2a5.2 5.2 0 0 1-10.4 0V4.6Z" fill={B} />
      <g fill={B}>
        <rect x="2.6" y="4.6" width="3.4" height="5.4" rx="1.7" />
        <rect x="18" y="4.6" width="3.4" height="5.4" rx="1.7" />
        <rect x="10.4" y="13" width="3.2" height="4" rx="1" />
        <rect x="6.4" y="17" width="11.2" height="3.4" rx="1.7" />
        <rect x="6.2" y="2.6" width="11.6" height="2.8" rx="1.4" />
      </g>
      <rect x="8.2" y="6.6" width="7.6" height="2.2" rx="1.1" fill={A} />
    </>
  ),

  /** Chief of Staff: someone with the brief. */
  briefcase: (
    <>
      <circle cx="12" cy="4" r="2.9" fill={B} />
      <path d="M6.4 10.4c.7-2.6 2.9-4.2 5.6-4.2s4.9 1.6 5.6 4.2H6.4Z" fill={B} />
      <rect x="2.4" y="9.8" width="19.2" height="11.2" rx="2.6" fill={B} />
      <rect x="9.6" y="13.2" width="4.8" height="3.8" rx="1.4" fill={A} />
    </>
  ),

  /** Portfolio: what is owned outside the company, one slice at a time. */
  portfolio: (
    <>
      <circle cx="12" cy="12" r="9.4" fill={B} />
      {/* the one holding that is bigger than the rest */}
      <path d="M12 2.6A9.4 9.4 0 0 1 21.4 12H12Z" fill={A} />
      <circle cx="12" cy="12" r="3" fill={A} />
    </>
  ),

  /** End Quarter: press it and the quarter is sealed. */
  stamp: (
    <>
      <rect x="9.2" y="2.4" width="5.6" height="5.4" rx="2.5" fill={B} />
      <path d="M6.2 12.6c0-2.2 1.7-3.6 3.4-4.4h4.8c1.7.8 3.4 2.2 3.4 4.4v1.4H6.2v-1.4Z" fill={B} />
      <rect x="3.2" y="14.6" width="17.6" height="3.2" rx="1.6" fill={B} />
      <rect x="4.6" y="18.8" width="14.8" height="2.6" rx="1.3" fill={B} />
      <rect x="5.6" y="15.4" width="12.8" height="1.6" rx="0.8" fill={A} />
    </>
  ),

  /** Quarter Resolution: what the world printed about it. */
  newspaper: (
    <>
      <rect x="2.2" y="4.6" width="19.6" height="14.8" rx="2.4" fill={B} />
      <rect x="4.6" y="7" width="8.4" height="5.6" rx="1.3" fill={A} />
      <g fill={A}>
        <rect x="14.6" y="7" width="4.8" height="1.8" rx="0.9" />
        <rect x="14.6" y="10.8" width="4.8" height="1.8" rx="0.9" />
        <rect x="4.6" y="14.6" width="14.8" height="1.8" rx="0.9" />
      </g>
    </>
  ),

  /* --- nav groups ------------------------------------------------------- */

  /** Operate: the desk you run the company from. */
  desk: (
    <>
      <rect x="7.2" y="3" width="9.6" height="7" rx="2" fill={B} />
      <rect x="9.2" y="4.8" width="5.6" height="3.4" rx="1" fill={A} />
      <rect x="11.2" y="9.4" width="1.6" height="1.6" fill={B} />
      <rect x="2.2" y="10.8" width="19.6" height="2.8" rx="1.4" fill={B} />
      <g fill={B}>
        <rect x="3.8" y="13.4" width="2.6" height="7.2" rx="1.3" />
        <rect x="17.6" y="13.4" width="2.6" height="7.2" rx="1.3" />
        <rect x="8.4" y="13.4" width="7.2" height="7.2" rx="1.8" />
      </g>
    </>
  ),

  /** Frontier: where you are pointing. */
  compass: (
    <>
      <circle cx="12" cy="12" r="9.4" fill={B} />
      <path d="M17.2 6.8 13.6 13.6 6.8 17.2l3.6-6.8Z" fill={A} />
    </>
  ),

  /** Capital: what is behind the door. */
  vault: (
    <>
      <rect x="2.4" y="3.2" width="19.2" height="17.6" rx="3.2" fill={B} />
      <g fill={A}>
        <circle cx="12" cy="12" r="5.4" />
        <rect x="11.2" y="4.6" width="1.6" height="3" rx="0.8" />
        <rect x="11.2" y="16.4" width="1.6" height="3" rx="0.8" />
        <rect x="4.4" y="11.2" width="3" height="1.6" rx="0.8" />
        <rect x="16.6" y="11.2" width="3" height="1.6" rx="0.8" />
      </g>
      <circle cx="12" cy="12" r="1.9" fill={B} />
    </>
  ),

  /** Play: run the turn. */
  playMark: (
    <>
      <rect x="2.6" y="2.6" width="18.8" height="18.8" rx="5.4" fill={B} />
      <path d="M9.8 8 16.6 12l-6.8 4Z" fill={A} />
    </>
  ),

  /* --- utility ---------------------------------------------------------- */

  /** Settings: two rounded squares crossed, which is a gear at 20px. */
  settings: (
    <>
      <g fill={B}>
        <rect x="3" y="3" width="18" height="18" rx="4.2" />
        <rect x="3" y="3" width="18" height="18" rx="4.2" transform="rotate(45 12 12)" />
      </g>
      <circle cx="12" cy="12" r="4" fill={A} />
    </>
  ),

  /** Alerts. */
  bell: (
    <>
      <path
        d="M12 2.2a1.7 1.7 0 0 1 1.7 1.7v.5a6.6 6.6 0 0 1 4.9 6.4v3.1l1.5 2.3a1 1 0 0 1-.9 1.6H4.8a1 1 0 0 1-.9-1.6l1.5-2.3v-3.1a6.6 6.6 0 0 1 4.9-6.4v-.5A1.7 1.7 0 0 1 12 2.2Z"
        fill={B}
      />
      <path d="M9.2 19.2h5.6a2.8 2.8 0 0 1-5.6 0Z" fill={A} />
    </>
  ),

  /** Live: a broadcast dot. */
  live: (
    <>
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M12 2.6a9.4 9.4 0 1 0 0 18.8 9.4 9.4 0 0 0 0-18.8Zm0 3.2a6.2 6.2 0 1 1 0 12.4 6.2 6.2 0 0 1 0-12.4Z"
        fill={B}
      />
      <circle cx="12" cy="12" r="3.9" fill={A} />
    </>
  ),

  close: (
    <g fill={B}>
      <rect x="3.4" y="10.6" width="17.2" height="2.8" rx="1.4" transform="rotate(45 12 12)" />
      <rect x="3.4" y="10.6" width="17.2" height="2.8" rx="1.4" transform="rotate(-45 12 12)" />
    </g>
  ),

  chevronRight: (
    <g fill={B}>
      <rect x="8.2" y="8" width="8" height="2.6" rx="1.3" transform="rotate(45 12.2 9.3)" />
      <rect x="8.2" y="13.4" width="8" height="2.6" rx="1.3" transform="rotate(-45 12.2 14.7)" />
    </g>
  ),

  chevronDown: (
    <g fill={B} transform="rotate(90 12 12)">
      <rect x="8.2" y="8" width="8" height="2.6" rx="1.3" transform="rotate(45 12.2 9.3)" />
      <rect x="8.2" y="13.4" width="8" height="2.6" rx="1.3" transform="rotate(-45 12.2 14.7)" />
    </g>
  ),

  check: (
    <g fill={B}>
      <rect x="4.4" y="13.5" width="6.6" height="2.6" rx="1.3" transform="rotate(45 7.7 14.8)" />
      <rect x="7.8" y="11" width="13" height="2.6" rx="1.3" transform="rotate(-48 14.3 12.3)" />
    </g>
  ),

  warning: (
    <>
      <path d="M10.3 3.5 1.9 18.1a2 2 0 0 0 1.7 3h16.8a2 2 0 0 0 1.7-3L13.7 3.5a2 2 0 0 0-3.4 0Z" fill={B} />
      <g fill={A}>
        <rect x="10.8" y="8.2" width="2.4" height="6" rx="1.2" />
        <circle cx="12" cy="17.2" r="1.5" />
      </g>
    </>
  ),

  search: (
    <>
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M10.4 2.4a7.9 7.9 0 1 0 0 15.8 7.9 7.9 0 0 0 0-15.8Zm0 3.1a4.8 4.8 0 1 1 0 9.6 4.8 4.8 0 0 1 0-9.6Z"
        fill={B}
      />
      <rect x="14.4" y="16.2" width="7.6" height="2.8" rx="1.4" fill={B} transform="rotate(45 18.2 17.6)" />
    </>
  ),

  plus: (
    <g fill={B}>
      <rect x="10.6" y="3.4" width="2.8" height="17.2" rx="1.4" />
      <rect x="3.4" y="10.6" width="17.2" height="2.8" rx="1.4" />
    </g>
  ),

  save: (
    <>
      <rect x="2.8" y="2.8" width="18.4" height="18.4" rx="2.8" fill={B} />
      <rect x="7.6" y="2.8" width="8.8" height="5.8" rx="1.2" fill={A} />
      <rect x="6.2" y="12.4" width="11.6" height="8.8" rx="1.4" fill={A} />
    </>
  ),

  export: (
    <>
      <rect x="2.6" y="16.6" width="18.8" height="4.6" rx="1.9" fill={A} />
      <g fill={B}>
        <rect x="10.5" y="6" width="3" height="9.4" rx="1.5" />
        <path d="M12 2.2 17.4 8.6H6.6Z" />
      </g>
    </>
  ),

  import: (
    <>
      <rect x="2.6" y="16.6" width="18.8" height="4.6" rx="1.9" fill={A} />
      <g fill={B}>
        <rect x="10.5" y="2.2" width="3" height="9.4" rx="1.5" />
        <path d="M12 15 6.6 8.6h10.8Z" />
      </g>
    </>
  ),

  back: (
    <g fill={B}>
      <rect x="8.4" y="10.6" width="13" height="2.8" rx="1.4" />
      <path d="M2.4 12 10 6.2v11.6Z" />
    </g>
  ),

  menu: (
    <g fill={B}>
      <rect x="3" y="5" width="18" height="2.8" rx="1.4" />
      <rect x="3" y="10.6" width="18" height="2.8" rx="1.4" />
      <rect x="3" y="16.2" width="18" height="2.8" rx="1.4" />
    </g>
  ),

  /** The wordmark's companion: a frontier under a sun. */
  logo: (
    <>
      <path d="M1.8 20.4 8 9.8a1.7 1.7 0 0 1 2.9 0l2.2 3.7 1.6-2.7a1.7 1.7 0 0 1 2.9 0l4 9.6H1.8Z" fill={B} />
      <circle cx="17.6" cy="5.4" r="3" fill={A} />
    </>
  ),
};

/* -------------------------------------------------------------------------- */
/*  Component                                                                  */
/* -------------------------------------------------------------------------- */

export interface IconProps {
  readonly name: IconName;
  /** Rendered edge length in CSS px. 20 suits body text; 18 a nav row; 24 a tab. */
  readonly size?: number;
  /** The tone of the one accent detail. `current` folds it into the base colour. */
  readonly accent?: IconAccent;
  readonly className?: string;
  /**
   * An accessible name. Omit it — the usual case — and the mark is hidden from
   * assistive technology, because an icon beside its own label is decoration.
   */
  readonly label?: string;
}

/**
 * One flat mark.
 *
 * The base is `currentColor`, so put the icon inside the element that already
 * carries the right text colour and it will match. Pair it with a visible label
 * wherever the meaning is not obvious; give it a `label` only when it stands
 * alone.
 */
export function Icon({ name, size = 20, accent = 'brand', className, label }: IconProps): React.JSX.Element {
  const accentValue = accent === 'inherit' ? undefined : accent === 'current' ? 'currentColor' : TONE_VAR[accent];
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      className={cx('block shrink-0', className)}
      style={accentValue === undefined ? undefined : ({ ['--fc-icon-accent' as string]: accentValue } as CSSProperties)}
      role={label === undefined ? 'presentation' : 'img'}
      aria-hidden={label === undefined ? true : undefined}
      aria-label={label}
      focusable="false"
    >
      {SHAPES[name]}
    </svg>
  );
}

/* -------------------------------------------------------------------------- */
/*  Icon chip                                                                  */
/* -------------------------------------------------------------------------- */

export interface IconChipProps {
  readonly name: IconName;
  /** Tint of the rounded square. The mark takes the chip's text colour. */
  readonly tone?: Tone;
  /** `wash` is the pale tinted square; `solid` is the filled one carrying a white mark. */
  readonly variant?: 'wash' | 'solid';
  readonly size?: 'sm' | 'md' | 'lg';
  readonly className?: string;
  readonly label?: string;
}

const CHIP_BOX: Readonly<Record<'sm' | 'md' | 'lg', string>> = {
  sm: 'size-6',
  md: 'size-7',
  lg: 'size-9',
};

const CHIP_ICON: Readonly<Record<'sm' | 'md' | 'lg', number>> = { sm: 14, md: 16, lg: 20 };

/** The surface colour behind the mark, per tone — the value a knockout needs. */
const WASH_VAR: Readonly<Record<Tone, string>> = {
  neutral: 'var(--color-raised)',
  gain: 'var(--color-gain-wash)',
  loss: 'var(--color-loss-wash)',
  warn: 'var(--color-warn-wash)',
  info: 'var(--color-info-wash)',
  brand: 'var(--color-brand-wash)',
};

const SOLID_VAR: Readonly<Record<Tone, string>> = {
  neutral: 'var(--color-ink)',
  gain: 'var(--color-gain-strong)',
  loss: 'var(--color-loss-strong)',
  warn: 'var(--color-warn-strong)',
  info: 'var(--color-info-strong)',
  brand: 'var(--color-brand-strong)',
};

/**
 * An icon in a tinted rounded square — the shape `Panel` and `StatCard` put
 * beside a heading, and the shape the nav puts beside a screen name.
 *
 * The chip already carries the tone, so a second *colour* inside a 24px square
 * would be noise. Instead the accent detail is knocked out in the chip's own
 * background, which keeps the needle, the dial and the tape readable at 14px
 * without introducing a third colour anywhere.
 */
export function IconChip({
  name,
  tone = 'neutral',
  variant = 'wash',
  size = 'md',
  className,
  label,
}: IconChipProps): React.JSX.Element {
  return (
    <span
      className={cx(
        'flex shrink-0 items-center justify-center rounded-chip border',
        CHIP_BOX[size],
        variant === 'solid' ? cx(TONE_SOLID[tone], 'border-transparent') : TONE_CHIP[tone],
        className,
      )}
      style={{ ['--fc-icon-accent' as string]: variant === 'solid' ? SOLID_VAR[tone] : WASH_VAR[tone] } as CSSProperties}
    >
      <Icon name={name} size={CHIP_ICON[size]} accent="inherit" label={label} />
    </span>
  );
}
