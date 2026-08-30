/**
 * The rules the boardroom's furniture keeps.
 *
 * The scene is only trustworthy if the room is the same room every time you walk
 * into it, and if the head and the foot of the table stay free — the head
 * carries the matter under discussion and the foot carries the player, so a
 * director seated on either would be sitting on information.
 */

import { describe, expect, it } from 'vitest';
import { createSession, playerCharacterOf } from '../../../lib/game/engine';
import { STANCE_LABEL, STANCE_TONE, TABLE, seatDirectors, seatOrder, stanceOf } from './table';

const session = createSession();
const founder = playerCharacterOf(session);
const board = session.boards.find((entry) => entry.companyId === founder.companyId) ?? session.boards[0];
const directors = board?.directors ?? [];

describe('seating the board', () => {
  it('sits the chair first and leaves everybody else in engine order', () => {
    const order = seatOrder(directors);
    expect(order).toHaveLength(directors.length);
    const chair = directors.find((seat) => seat.isChair);
    if (chair !== undefined) expect(order[0]).toBe(chair.characterId);
    // The relative order of the non-chairs is untouched.
    const rest = directors.filter((seat) => !seat.isChair).map((seat) => seat.characterId);
    expect(order.slice(chair === undefined ? 0 : 1)).toEqual(rest);
  });

  it('never seats the player twice: they are drawn at the foot', () => {
    const order = seatOrder(directors, founder.id);
    expect(order).not.toContain(founder.id);
    expect(order).toHaveLength(directors.filter((seat) => seat.characterId !== founder.id).length);
  });

  it('places the same people in the same chairs every time', () => {
    const ids = seatOrder(directors, founder.id);
    expect(seatDirectors(ids)).toEqual(seatDirectors(ids));
  });

  it('keeps the seats in the order it was given, so a whip line zips straight on', () => {
    const ids = seatOrder(directors, founder.id);
    expect(seatDirectors(ids).map((seat) => seat.characterId)).toEqual(ids);
  });

  it('alternates flanks so a board of three is not all down one side', () => {
    const seats = seatDirectors(['a', 'b', 'c', 'd', 'e']);
    expect(seats.map((seat) => seat.flank)).toEqual(['right', 'left', 'right', 'left', 'right']);
  });

  it('leaves the head and the foot of the table free, at every board size', () => {
    for (let count = 1; count <= 14; count += 1) {
      const seats = seatDirectors(Array.from({ length: count }, (_, index) => `chr_${index}`));
      for (const seat of seats) {
        expect(seat.yPct, `a director sat at the head with ${count} on the board`).toBeGreaterThan(24);
        expect(seat.yPct, `a director sat at the foot with ${count} on the board`).toBeLessThan(80);
        expect(seat.xPct).toBeGreaterThan(10);
        expect(seat.xPct).toBeLessThan(90);
        // Nobody sits *on* the table.
        const dx = (seat.xPct - TABLE.cx) / TABLE.rx;
        const dy = (seat.yPct - TABLE.cy) / TABLE.ry;
        expect(dx * dx + dy * dy).toBeGreaterThan(1);
      }
    }
  });

  it('mirrors the two flanks', () => {
    const seats = seatDirectors(['a', 'b']);
    const [right, left] = seats;
    expect(right?.flank).toBe('right');
    expect(left?.flank).toBe('left');
    expect((right?.xPct ?? 0) + (left?.xPct ?? 0)).toBeCloseTo(TABLE.cx * 2, 6);
    expect(right?.yPct).toBeCloseTo(left?.yPct ?? 0, 6);
  });
});

describe('the badge by a seat', () => {
  it('says what the engine would count', () => {
    expect(stanceOf({ stance: 'support', recused: false })).toBe('for');
    expect(stanceOf({ stance: 'oppose', recused: false })).toBe('against');
    expect(stanceOf({ stance: 'abstain', recused: false })).toBe('undecided');
  });

  it('puts recusal above the stance, because a recused director has none', () => {
    expect(stanceOf({ stance: 'support', recused: true })).toBe('recused');
    expect(stanceOf({ stance: 'oppose', recused: true })).toBe('recused');
  });

  it('says so plainly when nothing is tabled', () => {
    expect(stanceOf(null)).toBe('unknown');
    expect(STANCE_LABEL.unknown).toBe('No matter');
    expect(STANCE_TONE.unknown).toBe('neutral');
  });

  it('colours for and against the way the rest of the game colours them', () => {
    expect(STANCE_TONE.for).toBe('gain');
    expect(STANCE_TONE.against).toBe('loss');
    expect(STANCE_TONE.recused).toBe('warn');
  });
});
