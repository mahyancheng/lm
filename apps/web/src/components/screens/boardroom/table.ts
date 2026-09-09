/**
 * Where everybody sits.
 *
 * The board table is drawn, not listed, so the screen needs a rule for turning
 * `board.directors` into seats. The rule is deliberately boring and entirely
 * deterministic — the same board seats the same people in the same chairs every
 * time you open the screen, because a room whose furniture moves between visits
 * is a room you never learn:
 *
 * - the **chair** of the board sits first, nearest the head of the table;
 * - the rest keep the order the engine holds them in;
 * - seats alternate right flank, left flank, right flank — so a board of three
 *   is not all bunched down one side;
 * - within a flank they are spread evenly along an arc of the table's ellipse.
 *
 * Coordinates are percentages of the stage box, which is also the SVG's own
 * `viewBox` space (`0 0 100 100`, `preserveAspectRatio="none"`), so the table
 * drawn underneath and the seats positioned on top cannot drift apart.
 *
 * Nothing here reads game state or invents a number: ids in, coordinates out.
 */

/** The table's ellipse, in stage percent. The seats ring sits outside it. */
export const TABLE = { cx: 50, cy: 51, rx: 26, ry: 18.5 } as const;

/** The seat ring: wider and taller than the table, so people sit *around* it. */
const SEAT_RX = 34;
const SEAT_RY = 26;
/**
 * The arc one flank spans, in degrees clockwise from the table's waist.
 *
 * It is deliberately asymmetric. The top of the range stops short of the head,
 * which belongs to the matter under discussion, and the bottom stops short of
 * the foot, which belongs to the chief executive — so neither the proposal card
 * nor the player's own seat is ever sat on.
 */
const FLANK_START = -55;
const FLANK_END = 60;

export type Flank = 'left' | 'right';

export interface TableSeat {
  readonly characterId: string;
  /** Percent of stage width, for the centre of the seat. */
  readonly xPct: number;
  /** Percent of stage height. */
  readonly yPct: number;
  readonly flank: Flank;
}

/**
 * Pull the chair to the front, keeping everybody else in engine order.
 *
 * Two directors are never reordered relative to each other by anything but the
 * chair rule, so adding a seat does not reshuffle the room. `exclude` is the
 * player's own character: a founder usually holds a seat on their own board, and
 * they are drawn at the foot of the table rather than twice.
 */
export function seatOrder(
  directors: readonly { readonly characterId: string; readonly isChair: boolean }[],
  exclude?: string,
): string[] {
  const seated = directors.filter((seat) => seat.characterId !== exclude);
  const chairs = seated.filter((seat) => seat.isChair).map((seat) => seat.characterId);
  const rest = seated.filter((seat) => !seat.isChair).map((seat) => seat.characterId);
  return [...chairs, ...rest];
}

/** Place an ordered list of directors around the table. */
export function seatDirectors(orderedIds: readonly string[]): TableSeat[] {
  const right = orderedIds.filter((_, index) => index % 2 === 0);
  const left = orderedIds.filter((_, index) => index % 2 === 1);

  const place = (ids: readonly string[], flank: Flank): TableSeat[] =>
    ids.map((characterId, index) => {
      const t = ids.length <= 1 ? 0.5 : index / (ids.length - 1);
      const degrees = FLANK_START + (FLANK_END - FLANK_START) * t;
      const radians = (degrees * Math.PI) / 180;
      const dx = SEAT_RX * Math.cos(radians);
      const dy = SEAT_RY * Math.sin(radians);
      return {
        characterId,
        xPct: flank === 'right' ? TABLE.cx + dx : TABLE.cx - dx,
        yPct: TABLE.cy + dy,
        flank,
      };
    });

  // Interleave back into the original order so the caller can zip seats against
  // whip lines without re-sorting.
  const placed = new Map<string, TableSeat>();
  for (const seat of [...place(right, 'right'), ...place(left, 'left')]) placed.set(seat.characterId, seat);
  return orderedIds.map((id) => placed.get(id)).filter((seat): seat is TableSeat => seat !== undefined);
}

/* -------------------------------------------------------------------------- */
/*  Stance                                                                     */
/* -------------------------------------------------------------------------- */

/** What a badge beside a seat says, and in which tone. */
export type SeatStance = 'for' | 'against' | 'undecided' | 'recused' | 'unknown';

export const STANCE_LABEL: Readonly<Record<SeatStance, string>> = {
  for: 'For',
  against: 'Against',
  undecided: 'Undecided',
  recused: 'Recused',
  unknown: 'No matter',
};

export const STANCE_TONE: Readonly<Record<SeatStance, 'gain' | 'loss' | 'neutral' | 'warn' | 'info'>> = {
  for: 'gain',
  against: 'loss',
  undecided: 'neutral',
  recused: 'warn',
  unknown: 'neutral',
};

/**
 * The badge for one whip line.
 *
 * `recused` outranks the stance because a recused director does not have one:
 * the engine removes them from the matter, and the room should say so rather
 * than show an opinion that will not be counted.
 */
export function stanceOf(line: { readonly stance: 'support' | 'oppose' | 'abstain'; readonly recused: boolean } | null): SeatStance {
  if (line === null) return 'unknown';
  if (line.recused) return 'recused';
  if (line.stance === 'support') return 'for';
  if (line.stance === 'oppose') return 'against';
  return 'undecided';
}
