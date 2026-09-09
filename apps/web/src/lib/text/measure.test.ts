/**
 * The measurement helpers, checked with a fake measurer.
 *
 * Pretext needs a canvas; these rules do not. `fakeMeasurer` gives every
 * character the same advance and breaks greedily at spaces — the browser's
 * algorithm with an invented font — so shrink-to-fit, balancing, line-boundary
 * cuts and the column rule can be asserted exactly, in node.
 */

import { describe, expect, it } from 'vitest';
import {
  balancedWidth,
  canMeasure,
  canvasMeasurer,
  columnsFor,
  cutAtLines,
  fakeMeasurer,
  fitHeadline,
  fontString,
  heightOf,
  lineHeightPx,
  MIN_COLUMN_EM,
  MIN_COLUMN_LINES,
  type Font,
} from './measure';

const SERIF = 'Georgia, serif';
const measurer = fakeMeasurer(0.5); // every character is half the font size wide

function font(sizePx: number, leading = 1.1): Font {
  return { family: SERIF, weight: 700, sizePx, leading };
}

describe('the fake measurer', () => {
  it('breaks greedily at spaces, like a browser with a monospaced face', () => {
    // 20px font, 10px per character; 100px fits ten characters.
    const result = measurer.lines('aaaa bbbb cccc dddd', font(20), 100);
    expect(result.lines).toEqual(['aaaa bbbb', 'cccc dddd']);
    expect(result.lineCount).toBe(2);
    expect(result.heightPx).toBe(2 * lineHeightPx(font(20)));
  });

  it('never returns an empty line for a word wider than the column', () => {
    const result = measurer.lines('supercalifragilistic', font(20), 40);
    expect(result.lines).toEqual(['supercalifragilistic']);
  });
});

describe('fitHeadline', () => {
  const headline = 'Harbourline guides to a wider loss as it re-platforms its logistics stack';

  it('steps down the ladder until the headline fits the line budget', () => {
    // At 30px (15px/char) the 73-character headline needs ~1095px: 3 lines of 366 do not hold it.
    const fitted = fitHeadline(headline, { family: SERIF, weight: 700, leading: 1.1, sizes: [30, 28, 26, 24, 22], maxLines: 3, maxWidthPx: 366 }, measurer);
    expect(fitted.overflow).toBe(false);
    expect(fitted.lines.length).toBeLessThanOrEqual(3);
    expect([30, 28, 26, 24, 22]).toContain(fitted.sizePx);
    // A larger size would not have fit.
    const oneUp = [30, 28, 26, 24, 22][[30, 28, 26, 24, 22].indexOf(fitted.sizePx) - 1];
    if (oneUp !== undefined) {
      expect(measurer.lines(headline, font(oneUp), 366).lineCount).toBeGreaterThan(3);
    }
  });

  it('keeps the largest size when the headline already fits', () => {
    const fitted = fitHeadline('Exports restricted', { family: SERIF, weight: 700, leading: 1.1, sizes: [30, 28], maxLines: 3, maxWidthPx: 366 }, measurer);
    expect(fitted.sizePx).toBe(30);
    expect(fitted.lines).toEqual(['Exports restricted']);
    expect(fitted.widthPx).toBe(366);
  });

  it('balances the lines so the last one is not a short tail', () => {
    // Nine four-letter words at 20px: 10px a character, 36 chars wide per line
    // at 366px → greedy gives seven words on line one and a two-word tail.
    const text = 'aaaa bbbb cccc dddd eeee ffff gggg hhhh iiii';
    const greedy = measurer.lines(text, font(20), 366);
    expect(greedy.lines.length).toBe(2);
    expect(greedy.lines[1]).toBe('hhhh iiii');

    const fitted = fitHeadline(text, { family: SERIF, weight: 700, leading: 1.1, sizes: [20], maxLines: 3, maxWidthPx: 366 }, measurer);
    expect(fitted.lines.length).toBe(2);
    expect(fitted.widthPx).toBeLessThan(366);
    // Balanced: five words over four, at the narrowest width that still holds two lines.
    expect(fitted.lines).toEqual(['aaaa bbbb cccc dddd eeee', 'ffff gggg hhhh iiii']);
    expect(fitted.widthPx).toBe(240);
    // And the balanced width still holds the same number of lines.
    expect(measurer.lines(text, font(20), fitted.widthPx).lineCount).toBe(2);
    expect(balancedWidth(text, font(20), 366, 2, measurer)).toBe(fitted.widthPx);
  });

  it('flags overflow and uses the smallest size when nothing fits', () => {
    const text = 'word '.repeat(60).trim();
    const fitted = fitHeadline(text, { family: SERIF, weight: 700, leading: 1.1, sizes: [30, 22], maxLines: 2, maxWidthPx: 200 }, measurer);
    expect(fitted.overflow).toBe(true);
    expect(fitted.sizePx).toBe(22);
  });

  it('renders unmeasured at the largest size and the full width', () => {
    const fitted = fitHeadline(headline, { family: SERIF, weight: 700, leading: 1.1, sizes: [30, 22], maxLines: 3, maxWidthPx: 366 }, null);
    expect(fitted).toEqual({ sizePx: 30, widthPx: 366, lines: [headline], overflow: false });
  });
});

describe('cutAtLines', () => {
  const paragraph =
    'The federation extended export controls to the current generation of training accelerators. Distributors were given thirty days to unwind existing orders, and every shipment above a threshold now requires an individual licence. Three of the largest buyers said they would seek exemptions.';

  it('cuts at a line boundary, never mid-word, and loses no text', () => {
    const cut = cutAtLines(paragraph, font(15, 1.5), 366, 3, measurer);
    expect(cut.cut).toBe(true);
    expect(cut.lineCount).toBe(3);
    expect(`${cut.shown} ${cut.rest}`).toBe(paragraph);
    // The last shown line is exactly what the measurer says the third line is.
    const lines = measurer.lines(paragraph, font(15, 1.5), 366).lines;
    expect(cut.shown.endsWith(lines[2] ?? '')).toBe(true);
    expect(measurer.lines(cut.shown, font(15, 1.5), 366).lineCount).toBe(3);
  });

  it('shows everything when it fits', () => {
    const cut = cutAtLines('Short and sweet.', font(15, 1.5), 366, 3, measurer);
    expect(cut).toEqual({ shown: 'Short and sweet.', rest: '', cut: false, lineCount: 1 });
  });

  it('falls back to a word-boundary cut without a measurer', () => {
    const cut = cutAtLines(paragraph, font(15, 1.5), 366, 3, null);
    expect(cut.cut).toBe(true);
    expect(paragraph.startsWith(cut.shown)).toBe(true);
    expect(paragraph.charAt(cut.shown.length)).toBe(' ');
    expect(`${cut.shown} ${cut.rest}`).toBe(paragraph);
  });
});

describe('columnsFor', () => {
  const body = 'A sentence of about forty characters here. '.repeat(30).trim();

  it('is one column without a measurer or for a short text', () => {
    expect(columnsFor(body, font(16, 1.5), 350, 16, null)).toBe(1);
    expect(columnsFor('Two lines at most.', font(16, 1.5), 350, 16, measurer)).toBe(1);
  });

  it('is two columns only when both would carry at least six lines', () => {
    // A side pane: 600px less the gap leaves two 292px columns, above the floor.
    const columnWidth = Math.floor((600 - 16) / 2);
    expect(columnWidth).toBeGreaterThanOrEqual(16 * MIN_COLUMN_EM);
    const lines = measurer.extent(body, font(16, 1.5), columnWidth).lineCount;
    expect(lines).toBeGreaterThanOrEqual(MIN_COLUMN_LINES * 2);
    expect(columnsFor(body, font(16, 1.5), 600, 16, measurer)).toBe(2);
    // Eleven column-lines is one column short of two full ones.
    const eleven = 'x'.repeat(Math.floor(columnWidth / 8) - 1).concat(' ').repeat(11).trim();
    expect(measurer.extent(eleven, font(16, 1.5), columnWidth).lineCount).toBeLessThan(12);
    expect(columnsFor(eleven, font(16, 1.5), 600, 16, measurer)).toBe(1);
  });

  it('never splits a phone sheet: two 167px columns of 16px serif are three words a line', () => {
    // The 350px sheet a 390px phone gives a story, with a body long enough for
    // twelve column-lines — the case that used to come out as two columns.
    const columnWidth = Math.floor((350 - 16) / 2);
    expect(columnWidth).toBeLessThan(16 * MIN_COLUMN_EM);
    expect(measurer.extent(body, font(16, 1.5), columnWidth).lineCount).toBeGreaterThanOrEqual(MIN_COLUMN_LINES * 2);
    expect(columnsFor(body, font(16, 1.5), 350, 16, measurer)).toBe(1);
    // The floor is about thirty characters: 240px at the sheet's 16px.
    expect(16 * MIN_COLUMN_EM).toBe(240);
  });
});

describe('the server', () => {
  it('has no canvas, so the measurer is null and every helper still answers', () => {
    expect(canMeasure()).toBe(false);
    expect(canvasMeasurer()).toBeNull();
    expect(heightOf('anything', font(15), 366, null)).toBeNull();
    expect(fontString(font(20))).toBe('700 20px Georgia, serif');
  });
});
