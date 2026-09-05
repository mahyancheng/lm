/**
 * The node canvas, as geometry.
 *
 * Everything a card is made of is a pure function of a box and a count, so the
 * whole picture can be asserted in a test that never mounts a component: where
 * the input tab sits, where the output circle sits, where each sub-port lands
 * along the bottom edge, where its supplier hangs below it, and what the dashed
 * wire between them looks like.
 *
 * The shape comes from the reference the owner sent — n8n's node editor — and
 * it is copied deliberately rather than approximated, because the whole point
 * of the reference is that a founder who has seen one dataflow editor already
 * knows how to read this one:
 *
 *   • a rounded card with an icon in it, and the NAME BELOW the card with a
 *     small subtitle under that;
 *   • an input port as a small tab on the left edge;
 *   • an output port as a small circle on the right edge;
 *   • slot ports along the bottom edge, one per slot the node declares, each
 *     with a text label and a red asterisk when the slot is required;
 *   • a small round node hanging under each slot port on a dashed wire — the
 *     node in the slot, with its supplier's name beneath — or a `+` when the
 *     slot is empty;
 *   • solid wires for the main left-to-right flow, dotted grid behind.
 *
 * Two constraints from the house rules are structural here rather than
 * decorative. Every interactive target is at least `TAP` across — a slot-port
 * dot is 9px and its hit area is 44px, which is why hit boxes are their own
 * functions. And the canvas has to be legible at 390 x 844: the card is sized
 * so a phone shows a card, its name and its slot ports without zooming, and the
 * focus control exists so that it can. A card with more than three slots wraps
 * its hanging nodes into rows of three (`SUPPLIER_ROW_SIZE`), because six
 * across at a 78px pitch is wider than a phone.
 */

/* -------------------------------------------------------------------------- */
/*  The card                                                                   */
/* -------------------------------------------------------------------------- */

/** The rounded card itself: an icon, and nothing else inside it. */
export const CARD_W = 112;
export const CARD_H = 72;
export const CARD_RADIUS = 14;

/** The name and subtitle, below the card, centred on it. */
export const NAME_GAP = 7;
export const NAME_H = 15;
export const SUBTITLE_H = 13;

/** The target line a viewer's own line carries under its subtitle: "→ Logistics · enterprise". */
export const TARGET_H = 12;

/** Everything above the slot-port labels: card, gap, name, subtitle. The target line fits inside `SUPPLIER_DROP`. */
export const HEAD_H = CARD_H + NAME_GAP + NAME_H + SUBTITLE_H;

/** The hanging row: how far below the card a hanging node sits, and how big it is. */
export const SUPPLIER_DROP = 58;
export const SUPPLIER_R = 13;
/** Horizontal pitch between two hanging nodes. Wider than the card, so the wires fan clear of the name; wider than `TAP`, so two targets never overlap. */
export const SUPPLIER_PITCH = 78;
/** The label under a hanging node. */
export const SUPPLIER_LABEL_H = 24;
/** Hanging nodes per row before the next row starts. Three at the pitch above is 156px: a phone-width card block. */
export const SUPPLIER_ROW_SIZE = 3;
/** Vertical pitch between two rows of hanging nodes. Above `TAP`, so a target in one row never overlaps one in the next. */
export const SUPPLIER_ROW_GAP = 48;

/** The smallest a target may be and still be hit reliably with a thumb. */
export const TAP = 44;

/** Port glyphs. The input is a tab, the output a circle — the reference's asymmetry. */
export const PORT_TAB_W = 5;
export const PORT_TAB_H = 18;
export const PORT_DOT_R = 5;
export const SUB_PORT_R = 4.5;

/** Column and row spacing for the laid-out graph. Generous: a card carries a name and a subtitle under it. */
export const CANVAS_COLUMN_GAP = 96;

/** How many rows `count` hanging nodes wrap into. Zero for none. */
export function supplierRowsOf(count: number): number {
  return count <= 0 ? 0 : Math.ceil(count / SUPPLIER_ROW_SIZE);
}

/**
 * The full height one node occupies: the card and its name block, the target
 * line when it carries one, and every row of hanging nodes with the label under
 * the last of them. What the layout spaces rows by, so a card's hanging nodes
 * never run into the card below it.
 */
export function nodeBlockHeight(hangingCount: number, hasTarget = false): number {
  const head = HEAD_H + (hasTarget ? TARGET_H : 0);
  const rows = supplierRowsOf(hangingCount);
  if (rows === 0) return head;
  return Math.max(head, CARD_H + SUPPLIER_DROP + (rows - 1) * SUPPLIER_ROW_GAP + SUPPLIER_R + SUPPLIER_LABEL_H);
}

/* -------------------------------------------------------------------------- */
/*  Points                                                                     */
/* -------------------------------------------------------------------------- */

export interface Point {
  readonly x: number;
  readonly y: number;
}

/** A laid-out card's box. Only the card, never the name block under it. */
export interface CardBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** A square hit area of at least `TAP`, centred on a point. */
export interface HitBox {
  readonly x: number;
  readonly y: number;
  readonly size: number;
}

/** The 44px square a thumb is allowed to be imprecise inside. */
export function hitBoxAt(point: Point, size: number = TAP): HitBox {
  return { x: point.x - size / 2, y: point.y - size / 2, size };
}

/** The input tab, on the left edge at the card's vertical centre. */
export function inputPortOf(box: CardBox): Point {
  return { x: box.x, y: box.y + box.height / 2 };
}

/** The output circle, on the right edge at the card's vertical centre. */
export function outputPortOf(box: CardBox): Point {
  return { x: box.x + box.width, y: box.y + box.height / 2 };
}

/**
 * Sub-ports along the bottom edge, evenly spread and inset from the corners.
 *
 * One port is centred rather than pushed to an edge, because a card with a
 * single input reads as a card with one thing under it, not as a card that has
 * lost something on the left.
 */
export function subPortsOf(box: CardBox, count: number): readonly Point[] {
  if (count <= 0) return [];
  const y = box.y + box.height;
  if (count === 1) return [{ x: box.x + box.width / 2, y }];
  const inset = 16;
  const span = box.width - inset * 2;
  return Array.from({ length: count }, (_, index) => ({
    x: box.x + inset + (span * index) / (count - 1),
    y,
  }));
}

/**
 * Where the node hanging off slot port `index` sits.
 *
 * Spread on a pitch wider than the card, centred under it, so the dashed wires
 * fan outwards around the name block instead of straight through it. Past
 * `SUPPLIER_ROW_SIZE` the nodes wrap into a second row `SUPPLIER_ROW_GAP`
 * lower, each row centred on the card in its own right, so a six-slot robot
 * reads as two rows of three rather than a 400px shelf.
 */
export function supplierSlotsOf(box: CardBox, count: number): readonly Point[] {
  if (count <= 0) return [];
  const centreX = box.x + box.width / 2;
  const baseY = box.y + box.height + SUPPLIER_DROP;
  return Array.from({ length: count }, (_, index) => {
    const row = Math.floor(index / SUPPLIER_ROW_SIZE);
    const inRow = index % SUPPLIER_ROW_SIZE;
    const rowCount = Math.min(SUPPLIER_ROW_SIZE, count - row * SUPPLIER_ROW_SIZE);
    const span = SUPPLIER_PITCH * (rowCount - 1);
    return {
      x: centreX - span / 2 + SUPPLIER_PITCH * inRow,
      y: baseY + row * SUPPLIER_ROW_GAP,
    };
  });
}

/* -------------------------------------------------------------------------- */
/*  Wires                                                                      */
/* -------------------------------------------------------------------------- */

/** Two decimals: enough for a crisp path, few enough for a stable string. */
function r(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * The main flow wire: a cubic with horizontal tangents, out of an output circle
 * and into an input tab. x(t) is monotone and y(t) never leaves the interval
 * between the two ends, which is what keeps a wire inside its own channel.
 */
export function flowWire(from: Point, to: Point): string {
  const dx = Math.max(24, (to.x - from.x) * 0.5);
  return `M ${r(from.x)} ${r(from.y)} C ${r(from.x + dx)} ${r(from.y)}, ${r(to.x - dx)} ${r(to.y)}, ${r(to.x)} ${r(to.y)}`;
}

/**
 * The supplier wire: down out of a slot port and across to the hanging node,
 * with vertical tangents so it leaves the card downwards and arrives from
 * above. Drawn dashed by the renderer — a fill is a choice, not structure.
 */
export function supplierWire(from: Point, to: Point): string {
  const dy = Math.max(18, (to.y - from.y) * 0.55);
  return `M ${r(from.x)} ${r(from.y)} C ${r(from.x)} ${r(from.y + dy)}, ${r(to.x)} ${r(to.y - dy)}, ${r(to.x)} ${r(to.y)}`;
}

/**
 * The same path, every y moved by `dy`.
 *
 * The layout spaces rows by a node's whole block — card, name and hanging
 * rows — and puts a wire's ends at the block's vertical centre; the card sits
 * at the top of its block, so its ports are higher by half the difference.
 * Every point on the path shifts by the same amount, dummy-slot bends
 * included, because every block on the grid is the same height.
 */
export function shiftPathY(path: string, dy: number): string {
  if (dy === 0) return path;
  return path.replace(/(-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)/g, (_match, x: string, y: string) => `${x} ${r(Number(y) + dy)}`);
}

/* -------------------------------------------------------------------------- */
/*  Viewport                                                                   */
/* -------------------------------------------------------------------------- */

/** Pan and zoom, as three numbers. The canvas holds exactly this and nothing else. */
export interface Viewport {
  readonly x: number;
  readonly y: number;
  readonly scale: number;
}

export const MIN_SCALE = 0.3;
export const MAX_SCALE = 2.2;

export function clampScale(scale: number): number {
  if (!Number.isFinite(scale)) return 1;
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

/** The bounding box of a set of boxes, padded. Empty input gives a unit box rather than infinities. */
export function boundsOf(boxes: readonly CardBox[], pad = 40): CardBox {
  if (boxes.length === 0) return { x: 0, y: 0, width: 1, height: 1 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const box of boxes) {
    minX = Math.min(minX, box.x);
    minY = Math.min(minY, box.y);
    maxX = Math.max(maxX, box.x + box.width);
    maxY = Math.max(maxY, box.y + box.height);
  }
  return { x: minX - pad, y: minY - pad, width: maxX - minX + pad * 2, height: maxY - minY + pad * 2 };
}

/**
 * The viewport that fits `bounds` into a `width` x `height` window.
 *
 * Scale is clamped, so a two-node chain opens at a readable size rather than
 * filling the screen with one enormous card, and a ninety-node map opens at the
 * floor rather than at something unreadable.
 */
export function fitViewport(bounds: CardBox, width: number, height: number): Viewport {
  if (width <= 0 || height <= 0 || bounds.width <= 0 || bounds.height <= 0) return { x: 0, y: 0, scale: 1 };
  const scale = clampScale(Math.min(width / bounds.width, height / bounds.height));
  return {
    x: width / 2 - (bounds.x + bounds.width / 2) * scale,
    y: height / 2 - (bounds.y + bounds.height / 2) * scale,
    scale,
  };
}

/** Zoom about a fixed screen point, so a pinch keeps what is under the fingers under the fingers. */
export function zoomAbout(viewport: Viewport, point: Point, nextScale: number): Viewport {
  const scale = clampScale(nextScale);
  const ratio = scale / viewport.scale;
  return {
    x: point.x - (point.x - viewport.x) * ratio,
    y: point.y - (point.y - viewport.y) * ratio,
    scale,
  };
}

/** The transform attribute a viewport is applied with. */
export function viewportTransform(viewport: Viewport): string {
  return `translate(${r(viewport.x)} ${r(viewport.y)}) scale(${r(viewport.scale)})`;
}
