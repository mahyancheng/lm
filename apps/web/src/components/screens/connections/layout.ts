/**
 * The Connections picture, as geometry.
 *
 * Three columns on a phone: what feeds this line, the line itself, and who
 * takes it. Everything about where a pill sits, where a wire starts and where
 * it ends is a pure function of a container width and two lists of groups, so
 * the whole picture is assertable without mounting a component — the same
 * arrangement `graph/geometry.ts` had, kept because it is the only way to
 * prove a 390px phone never scrolls sideways.
 *
 * The reference (Plutocracy's Connections screen) puts prices floating in the
 * wire gaps. The panel this is drawn into is 356 points wide on a 390-point
 * phone, so the channel either side of the hub is 28 points and a floating
 * price would sit on top of a name. Instead the wire runs into the pill and the
 * price rides as a compact tag on the pill's wire edge. That is the one
 * deliberate departure; everything else — inputs left, me centre, outputs
 * right, solid for live and dashed for possible — is the reference's own shape.
 *
 * Two constraints are structural rather than decorative.
 *
 *  • **Nothing leaves the container.** `pillWidth` is derived from the width
 *    rather than chosen, so `x >= 0` and `x + width <= W` hold for every pill,
 *    every header and the hub at any width the phone can produce.
 *  • **Every pill is a thumb target.** `PILL_H` is 48 and `NESTED_H` is 44,
 *    both at or above the 44-point floor, on a pitch that leaves a gap between
 *    two of them so a thumb never lands between two rows.
 *
 * Deterministic: every number out of here is an integer, and the same input
 * gives the same output. No clock, no random, no measurement.
 */

/* -------------------------------------------------------------------------- */
/*  Constants                                                                  */
/* -------------------------------------------------------------------------- */

/** The hub disc: the line itself, in the middle. */
export const HUB = 40;
/**
 * The channel either side of the hub that the wires cross.
 *
 * 28 rather than 32 for two reasons that pull the same way: every point taken
 * out of the channel is half a point onto each pill's text, and the margin disc
 * sits on the output trunk at `GAP / 2` with a radius of 11, so the channel has
 * to be at least 26 for the disc to clear the hub's own ring.
 */
export const GAP = 28;
/**
 * A pill, and the pitch two of them sit on. The 4-point difference is the gap.
 *
 * Tight on purpose: a supplier column of three slots at three routes each is
 * nine pills, and four points a pill is 36 points of a phone's one screen.
 */
export const PILL_H = 48;
export const PILL_PITCH = 52;
/** A pill nested under another one — an unlock under a research option. */
export const NESTED_H = 44;
export const NESTED_INDENT = 16;
/** A small-caps group header. */
export const HEADER_H = 18;
/**
 * The second line of a header, when the group has one.
 *
 * "MODEL" and "40 1M tokens per unit" do not fit on one 130-point row at any
 * size a thumb can read, and the quantity is the whole recipe — how much of the
 * input one unit of the line consumes — so it gets its own line rather than
 * being truncated onto the end of the slot's name.
 */
export const SUBHEADER_H = 10;
/** Between one group and the next. */
export const GROUP_GAP = 10;
/** The shortest the picture may be: the hub, its name and its figures need this much. */
export const MIN_HUB_STACK = 150;
/** A pill stops widening here; past it the wire channels grow instead. */
export const MAX_PILL_W = 180;
/**
 * The margin badge's radius. Geometry, so it lives here rather than in the
 * component: `GAP / 2 - MARGIN_R` is the clearance between the badge and both
 * the hub's ring and the right column, and the layout test asserts it.
 */
export const MARGIN_R = 11;

/** The gap between the hub and the text above and below it. */
const HUB_TEXT_GAP = 6;
/** The line name above the hub: two lines at 12 points. */
const LABEL_H = 26;
/** Cost, price and ask below it. */
const FIGURES_H = 40;

/**
 * How wide one pill is at container width `W`.
 *
 * The hub and its two channels are fixed, so the two columns split whatever is
 * left: 130 at 356 (the panel's own width on a 390-point phone), 115 at 326 (on
 * a 360-point one), 180 from 456 up.
 */
export function pillWidth(width: number): number {
  return Math.min(MAX_PILL_W, Math.floor((width - HUB - GAP * 2) / 2));
}

/* -------------------------------------------------------------------------- */
/*  Input                                                                      */
/* -------------------------------------------------------------------------- */

/** Live is solid, possible and empty are dashed, blocked is the loss tone. */
export type PillState = 'live' | 'possible' | 'blocked' | 'empty';

export interface LayoutPill {
  readonly key: string;
  readonly state: PillState;
  /** Indented under `parentKey`, on a bracket wire instead of a flow wire. */
  readonly nested?: boolean;
  readonly parentKey?: string | null;
}

export interface LayoutGroup {
  readonly key: string;
  /** Null for a group that carries no header row. */
  readonly header: string | null;
  /** A second header line — the slot's recipe. Null on a group that needs none. */
  readonly subheader?: string | null;
  readonly pills: readonly LayoutPill[];
}

export interface LayoutInput {
  readonly width: number;
  readonly left: readonly LayoutGroup[];
  readonly right: readonly LayoutGroup[];
  readonly hub: { readonly showOutput: boolean };
}

/* -------------------------------------------------------------------------- */
/*  Output                                                                     */
/* -------------------------------------------------------------------------- */

export type Side = 'left' | 'right';

export interface LaidPill {
  readonly key: string;
  readonly side: Side;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly state: PillState;
  readonly nested: boolean;
  readonly parentKey: string | null;
}

export interface LaidHeader {
  readonly key: string;
  readonly side: Side;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly text: string;
  /** The second line, when the group has one. */
  readonly subtext: string | null;
}

/** `input` feeds the hub, `trunk` leaves it, `output` fans out, `bracket` nests. */
export type WireKind = 'input' | 'trunk' | 'output' | 'bracket';

/**
 * How a wire is painted.
 *
 * `own` is the trunk out of my own hub; `live` a relationship that exists;
 * `possible` a route nobody has taken; `blocked` an input nobody in the world
 * makes. Only `possible` is dashed — a blocked wire is solid in the loss tone,
 * because dashing it too would say "you could have this", which is the
 * opposite of what blocked means.
 */
export type WireTone = 'own' | 'live' | 'possible' | 'blocked';

export interface LaidWire {
  readonly key: string;
  readonly path: string;
  readonly dashed: boolean;
  readonly tone: WireTone;
  readonly kind: WireKind;
}

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface LaidHub {
  readonly x: number;
  readonly y: number;
  readonly size: number;
  readonly inputAnchor: Point;
  readonly outputAnchor: Point;
  /** Where the trunk ends and the output wires fan from. */
  readonly junction: Point;
  /**
   * Where the margin disc sits: on the trunk, clear of the hub.
   *
   * The reference puts the percentage badge out along the output wire rather
   * than on the company itself, and a disc centred halfway between the hub's
   * edge and the junction overlaps the hub's own ring at this channel width.
   * The junction is the one point on the trunk that is `GAP / 2` clear of both
   * the hub and the right column, so the badge rides there.
   */
  readonly marginAnchor: Point;
  readonly labelBox: Box;
  readonly figuresBox: Box;
}

export interface ConnectionsLayout {
  readonly width: number;
  readonly height: number;
  readonly pillWidth: number;
  readonly pills: readonly LaidPill[];
  readonly headers: readonly LaidHeader[];
  readonly wires: readonly LaidWire[];
  readonly hub: LaidHub;
}

/* -------------------------------------------------------------------------- */
/*  Wires                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * A flow wire: a cubic with horizontal tangents, from a pill's wire edge to an
 * anchor. Both control points sit on the midpoint x, so the curve leaves and
 * arrives horizontally and never wanders outside the two ends' y interval.
 */
export function flowWire(from: Point, to: Point): string {
  const mid = Math.round((from.x + to.x) / 2);
  return `M ${from.x} ${from.y} C ${mid} ${from.y}, ${mid} ${to.y}, ${to.x} ${to.y}`;
}

/** The trunk: hub to junction, straight, because it carries the margin disc. */
function trunkWire(from: Point, to: Point): string {
  return `M ${from.x} ${from.y} L ${to.x} ${to.y}`;
}

/**
 * A bracket: down the parent's inner edge, then across into the nested pill.
 *
 * Square rather than curved, because a bracket says "belongs to the one above"
 * and a curve would read as another flow.
 */
function bracketWire(parent: LaidPill, child: LaidPill): string {
  const y = child.y + Math.round(child.height / 2);
  if (child.side === 'right') {
    const x = parent.x + 10;
    return `M ${x} ${parent.y + parent.height} L ${x} ${y} L ${child.x} ${y}`;
  }
  const x = parent.x + parent.width - 10;
  return `M ${x} ${parent.y + parent.height} L ${x} ${y} L ${child.x + child.width} ${y}`;
}

/* -------------------------------------------------------------------------- */
/*  The stack                                                                  */
/* -------------------------------------------------------------------------- */

/** One header row: one line, or two when the group carries a recipe. */
function headerHeight(group: LayoutGroup): number {
  if (group.header === null) return 0;
  return HEADER_H + ((group.subheader ?? null) === null ? 0 : SUBHEADER_H);
}

/** How tall one side's stack is, trailing pitch gap included. */
function stackHeight(groups: readonly LayoutGroup[]): number {
  let total = 0;
  groups.forEach((group, index) => {
    if (index > 0) total += GROUP_GAP;
    total += headerHeight(group);
    total += group.pills.length * PILL_PITCH;
  });
  return total;
}

/** Place one side's groups top-down from `startY`. */
function stackSide(
  groups: readonly LayoutGroup[],
  side: Side,
  columnX: number,
  columnWidth: number,
  startY: number,
): { readonly pills: LaidPill[]; readonly headers: LaidHeader[] } {
  const pills: LaidPill[] = [];
  const headers: LaidHeader[] = [];
  let y = startY;

  groups.forEach((group, index) => {
    if (index > 0) y += GROUP_GAP;
    if (group.header !== null) {
      const height = headerHeight(group);
      headers.push({
        key: group.key,
        side,
        x: columnX,
        y,
        width: columnWidth,
        height,
        text: group.header,
        subtext: group.subheader ?? null,
      });
      y += height;
    }
    for (const pill of group.pills) {
      const nested = pill.nested === true;
      const height = nested ? NESTED_H : PILL_H;
      // A nested pill is indented into the column from the side its bracket
      // comes from: right-hand nests move right, left-hand nests move left.
      const x = !nested ? columnX : side === 'right' ? columnX + NESTED_INDENT : columnX;
      pills.push({
        key: pill.key,
        side,
        x,
        y,
        width: nested ? columnWidth - NESTED_INDENT : columnWidth,
        height,
        state: pill.state,
        nested,
        parentKey: pill.parentKey ?? null,
      });
      y += PILL_PITCH;
    }
  });

  return { pills, headers };
}

/* -------------------------------------------------------------------------- */
/*  The picture                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Lay out one Connections picture.
 *
 * Both stacks are centred on the hub rather than hung from the top, so a line
 * with one supplier and six customers still reads as one thing pointing right
 * instead of two lists that happen to share a page.
 */
export function layoutConnections(input: LayoutInput): ConnectionsLayout {
  const width = Math.max(1, Math.round(input.width));
  const column = Math.max(0, pillWidth(width));
  const leftX = 0;
  const rightX = width - column;

  const leftHeight = stackHeight(input.left);
  const rightHeight = stackHeight(input.right);
  const height = Math.max(leftHeight, rightHeight, MIN_HUB_STACK);

  const left = stackSide(input.left, 'left', leftX, column, Math.round((height - leftHeight) / 2));
  const right = stackSide(input.right, 'right', rightX, column, Math.round((height - rightHeight) / 2));
  const pills = [...left.pills, ...right.pills];

  const hubX = Math.round((width - HUB) / 2);
  const hubY = Math.round((height - HUB) / 2);
  const midY = hubY + Math.round(HUB / 2);
  const hub: LaidHub = {
    x: hubX,
    y: hubY,
    size: HUB,
    inputAnchor: { x: hubX, y: midY },
    outputAnchor: { x: hubX + HUB, y: midY },
    junction: { x: hubX + HUB + Math.round(GAP / 2), y: midY },
    marginAnchor: { x: hubX + HUB + Math.round(GAP / 2), y: midY },
    labelBox: { x: hubX - GAP, y: hubY - HUB_TEXT_GAP - LABEL_H, width: HUB + GAP * 2, height: LABEL_H },
    figuresBox: { x: hubX - GAP, y: hubY + HUB + HUB_TEXT_GAP, width: HUB + GAP * 2, height: FIGURES_H },
  };

  /* --- wires -------------------------------------------------------------- */
  const byKey = new Map(pills.map((pill) => [pill.key, pill]));
  const wires: LaidWire[] = [];

  for (const pill of pills) {
    const tone: WireTone = pill.state === 'blocked' ? 'blocked' : pill.state === 'live' ? 'live' : 'possible';
    // Dashed exactly for the two states that mean "not yet": a route nobody
    // has taken, and a slot nobody has filled.
    const dashed = pill.state === 'possible' || pill.state === 'empty';
    const parent = pill.parentKey === null ? undefined : byKey.get(pill.parentKey);

    if (pill.nested && parent !== undefined) {
      wires.push({ key: `w:${pill.key}`, path: bracketWire(parent, pill), dashed, tone, kind: 'bracket' });
      continue;
    }
    const centre = pill.y + Math.round(pill.height / 2);
    if (pill.side === 'left') {
      wires.push({ key: `w:${pill.key}`, path: flowWire({ x: pill.x + pill.width, y: centre }, hub.inputAnchor), dashed, tone, kind: 'input' });
    } else {
      wires.push({ key: `w:${pill.key}`, path: flowWire({ x: pill.x, y: centre }, hub.junction), dashed, tone, kind: 'output' });
    }
  }

  // The trunk is the line's own output leaving the hub, so it exists only when
  // there is an output and something on the right for it to fan into.
  if (input.hub.showOutput && right.pills.length > 0) {
    wires.unshift({ key: 'w:trunk', path: trunkWire(hub.outputAnchor, hub.junction), dashed: false, tone: 'own', kind: 'trunk' });
  }

  return { width, height, pillWidth: column, pills, headers: [...left.headers, ...right.headers], wires, hub };
}
