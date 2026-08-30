/**
 * Who is sitting at a desk, and what they look like.
 *
 * The office draws *seats*, not employees: the engine records `engineers: 84`,
 * not eighty-four people with names, so the scene synthesises a stable seat id
 * per drawn figure and derives every visual choice from `fnv1a64` of that id.
 *
 * That is the whole determinism story:
 *
 * - the same company at the same headcount draws the same faces forever;
 * - two renders in the same quarter are byte-identical;
 * - no `Math.random`, no `Date.now`, nothing that could differ between a
 *   server render and the hydration that follows it.
 *
 * Nothing in this file reads or invents a gameplay number. It turns an id into
 * a face and a crowd size into a drawable one.
 */

import { fnv1a64 } from '@frontier/shared';

/* -------------------------------------------------------------------------- */
/*  Seat identity                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The synthetic id of one drawn seat.
 *
 * Scoped by company so two companies never share a face, and by zone so moving
 * headcount between functions does not reshuffle the people who stayed put.
 */
export function seatId(companyId: string, zone: string, index: number): string {
  return `${companyId}/${zone}/${index}`;
}

/* -------------------------------------------------------------------------- */
/*  Appearance                                                                 */
/* -------------------------------------------------------------------------- */

/** How many variants exist of each feature. Mirrors the CSS custom properties. */
export const SKIN_TONE_COUNT = 5;
export const HAIR_STYLE_COUNT = 6;
export const HAIR_COLOUR_COUNT = 6;
/** Outfit variants *within* a role's own colourway. */
export const OUTFIT_COUNT = 3;

export interface SeatLook {
  /** Index into `--fc-skin-*`. */
  readonly skin: number;
  /** Which of the six flat hair shapes. */
  readonly hairStyle: number;
  /** Index into `--fc-hair-*`. */
  readonly hairColour: number;
  /** Which colourway inside the role's own palette. */
  readonly outfit: number;
  /** Idle-bob offset, so a room does not breathe in unison. */
  readonly bobDelayMs: number;
  /** Idle-bob period. */
  readonly bobDurationMs: number;
  /** Whether this figure types. Two in three do; the rest sit still. */
  readonly typing: boolean;
  /** -1, 0 or 1 — a couple of pixels of shoulder lean. */
  readonly lean: number;
}

/**
 * One independent lane per attribute, each from its own salted hash. Slicing
 * lanes out of a single fnv1a64(id) is NOT enough here: seat ids differ only
 * in a trailing index, and the un-salted hash moves those ids a fixed stride
 * apart in some lanes — a stride divisible by a palette size collapses the
 * palette (observed: 24 seats drawing 2 of the 5 skin tones). The salt on
 * both sides forces a full avalanche per attribute, matching the portrait
 * generator in scenes/people/look.ts.
 */
function lane(id: string, salt: string): number {
  const value = Number.parseInt(fnv1a64(`${salt}:${id}:${salt}`).slice(0, 8), 16);
  return Number.isNaN(value) ? 0 : value;
}

/**
 * The complete look of one seat. Pure: same id in, same face out, forever.
 */
export function seatLook(id: string): SeatLook {
  return {
    skin: lane(id, 'skin') % SKIN_TONE_COUNT,
    hairStyle: lane(id, 'hairStyle') % HAIR_STYLE_COUNT,
    hairColour: lane(id, 'hairColour') % HAIR_COLOUR_COUNT,
    outfit: lane(id, 'outfit') % OUTFIT_COUNT,
    bobDelayMs: (lane(id, 'bobDelay') * 9) % 2200,
    bobDurationMs: 2600 + ((lane(id, 'bobDuration') * 7) % 1500),
    typing: lane(id, 'typing') % 3 !== 0,
    lean: ((lane(id, 'lean') % 3) - 1),
  };
}

/* -------------------------------------------------------------------------- */
/*  Crowd scaling                                                              */
/* -------------------------------------------------------------------------- */

export interface Crowd {
  /** Figures actually drawn. */
  readonly figures: number;
  /** How many real heads one drawn figure stands for. 1 when everyone fits. */
  readonly perFigure: number;
}

/**
 * How to draw `headcount` people in a room that holds `capacity` desks.
 *
 * Under capacity everyone is drawn one-for-one. Over it, one figure stands for
 * `ceil(headcount / capacity)` heads and the zone badge carries the true
 * number — the picture is a scale model, the figure on it is the fact.
 */
export function crowd(headcount: number, capacity: number): Crowd {
  const heads = Math.max(0, Math.floor(headcount));
  const desks = Math.max(1, Math.floor(capacity));
  if (heads === 0) return { figures: 0, perFigure: 1 };
  if (heads <= desks) return { figures: heads, perFigure: 1 };
  const perFigure = Math.ceil(heads / desks);
  return { figures: Math.min(desks, Math.ceil(heads / perFigure)), perFigure };
}

/**
 * Split `total` across `weights` by largest remainder.
 *
 * Used for one thing only: `EmployeeBase.openRoles` is a company-wide figure,
 * so the empty desks that represent it are *allocated* across the zones in
 * proportion to their headcount rather than claimed as per-zone vacancies. The
 * only open-roles number the scene ever prints is the company-wide one.
 */
export function allocate(total: number, weights: readonly number[]): number[] {
  const target = Math.max(0, Math.floor(total));
  const totalWeight = weights.reduce((sum, weight) => sum + Math.max(0, weight), 0);
  if (target === 0 || totalWeight <= 0) return weights.map(() => 0);

  const exact = weights.map((weight) => (target * Math.max(0, weight)) / totalWeight);
  const out = exact.map((value) => Math.floor(value));
  let remaining = target - out.reduce((sum, value) => sum + value, 0);

  const order = exact
    .map((value, index) => ({ index, remainder: value - Math.floor(value) }))
    .sort((a, b) => b.remainder - a.remainder || a.index - b.index);

  for (const entry of order) {
    if (remaining <= 0) break;
    out[entry.index] = (out[entry.index] ?? 0) + 1;
    remaining -= 1;
  }
  return out;
}
