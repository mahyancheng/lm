/**
 * Text measurement for the newspaper, wrapped once.
 *
 * `@chenglou/pretext` measures multi-line text with canvas `measureText` as its
 * ground truth: `prepare(text, font)` segments and measures the words once, and
 * `layout(prepared, width, lineHeight)` is then pure arithmetic. This module is
 * the only place the app imports it, for three reasons:
 *
 * 1. **It needs a canvas and `Intl.Segmenter`.** Neither exists on the server
 *    or in a unit test, and the measurer arrives in the browser only after
 *    mount, so `canvasMeasurer()` returns null until then and every helper
 *    takes a `Measurer | null`: with none, the callers render an unmeasured
 *    fallback (the display size, CSS `text-wrap: balance`, a line clamp) and
 *    re-lay out once the measurer is there. The fallback is sized so the second
 *    pass moves as little as possible. (The News route itself is client-
 *    rendered — `useSearchParams` bails the static prerender out — so in the
 *    app the fallback covers the first client render, not a server page.)
 * 2. **Tests need a fake.** `fakeMeasurer` implements the same interface with
 *    a fixed advance per character, so a layout rule can be asserted without a
 *    browser.
 * 3. **Only what is used is imported.** The shipped ESM entry is `layout.js`
 *    (24 kB) plus the segmenting and line-break tables it pulls in; the rich
 *    inline entry is not imported.
 *
 * What the helpers decide, and nothing else:
 *
 * - `fitHeadline`: the largest size in a ladder at which a headline fits in the
 *   allotted lines, and the width that balances those lines (no orphan word).
 * - `cutAtLines`: the longest prefix of a paragraph that ends at a line
 *   boundary within N lines, so "Continued" never lands mid-word.
 * - `columnsFor`: one column, or two when both would be wide enough and carry
 *   at least six lines.
 * - `heightOf`: a real height for a block, for deciding what sits beside what.
 */

import { layout, layoutWithLines, prepareWithSegments } from '@chenglou/pretext';

/* -------------------------------------------------------------------------- */
/*  The interface                                                              */
/* -------------------------------------------------------------------------- */

export interface Font {
  /** The CSS family stack. */
  readonly family: string;
  readonly weight: number;
  readonly sizePx: number;
  /** Line height as a multiple of the size. */
  readonly leading: number;
}

export interface MeasuredLines {
  readonly lines: readonly string[];
  readonly lineCount: number;
  readonly heightPx: number;
}

/** What a measurer must answer. Pretext answers it in the browser; a fake answers it in tests. */
export interface Measurer {
  /** Lay `text` out at `maxWidthPx` in `font`, returning the lines as the browser would break them. */
  lines(text: string, font: Font, maxWidthPx: number): MeasuredLines;
  /** Line count and height only — cheaper than materialising lines. */
  extent(text: string, font: Font, maxWidthPx: number): { readonly lineCount: number; readonly heightPx: number };
}

/** The CSS font shorthand pretext keys its cache on. */
export function fontString(font: Font): string {
  return `${font.weight} ${font.sizePx}px ${font.family}`;
}

export function lineHeightPx(font: Font): number {
  return Math.round(font.sizePx * font.leading);
}

/* -------------------------------------------------------------------------- */
/*  The canvas measurer                                                        */
/* -------------------------------------------------------------------------- */

/** True where pretext can run: a document, a 2D canvas and a segmenter. */
export function canMeasure(): boolean {
  if (typeof document === 'undefined' || typeof window === 'undefined') return false;
  if (typeof Intl === 'undefined' || typeof (Intl as { Segmenter?: unknown }).Segmenter !== 'function') return false;
  try {
    const canvas = document.createElement('canvas');
    return typeof canvas.getContext === 'function' && canvas.getContext('2d') !== null;
  } catch {
    return false;
  }
}

let cached: Measurer | null | undefined;

/**
 * The pretext-backed measurer, or null where it cannot run (the server, the
 * static prerender, a browser without a canvas). Built once.
 */
export function canvasMeasurer(): Measurer | null {
  if (cached !== undefined) return cached;
  if (!canMeasure()) {
    cached = null;
    return cached;
  }
  cached = {
    lines(text, font, maxWidthPx) {
      const prepared = prepareWithSegments(text, fontString(font));
      const result = layoutWithLines(prepared, Math.max(1, maxWidthPx), lineHeightPx(font));
      return { lines: result.lines.map((line) => line.text.trim()), lineCount: result.lineCount, heightPx: result.height };
    },
    extent(text, font, maxWidthPx) {
      const prepared = prepareWithSegments(text, fontString(font));
      const result = layout(prepared, Math.max(1, maxWidthPx), lineHeightPx(font));
      return { lineCount: result.lineCount, heightPx: result.height };
    },
  };
  return cached;
}

/* -------------------------------------------------------------------------- */
/*  A fake, for tests and for reasoning                                        */
/* -------------------------------------------------------------------------- */

/**
 * A measurer in which every character is `advance × size` wide and breaks fall
 * at spaces, greedily — the same algorithm a browser uses, with an invented
 * font. Deterministic, DOM-free.
 */
export function fakeMeasurer(advance = 0.5): Measurer {
  const widthOf = (text: string, font: Font): number => text.length * font.sizePx * advance;
  const breakLines = (text: string, font: Font, maxWidthPx: number): string[] => {
    const words = text.split(/\s+/).filter((word) => word.length > 0);
    const lines: string[] = [];
    let current = '';
    for (const word of words) {
      const candidate = current.length === 0 ? word : `${current} ${word}`;
      if (current.length > 0 && widthOf(candidate, font) > maxWidthPx) {
        lines.push(current);
        current = word;
      } else {
        current = candidate;
      }
    }
    if (current.length > 0) lines.push(current);
    return lines;
  };
  return {
    lines(text, font, maxWidthPx) {
      const lines = breakLines(text, font, maxWidthPx);
      return { lines, lineCount: lines.length, heightPx: lines.length * lineHeightPx(font) };
    },
    extent(text, font, maxWidthPx) {
      const lines = breakLines(text, font, maxWidthPx);
      return { lineCount: lines.length, heightPx: lines.length * lineHeightPx(font) };
    },
  };
}

/* -------------------------------------------------------------------------- */
/*  Headlines                                                                  */
/* -------------------------------------------------------------------------- */

export interface FitHeadlineOptions {
  readonly family: string;
  readonly weight: number;
  readonly leading: number;
  /** Sizes to try, largest first. */
  readonly sizes: readonly number[];
  readonly maxLines: number;
  readonly maxWidthPx: number;
}

export interface FittedHeadline {
  readonly sizePx: number;
  /** The width at which the lines balance: the block's `max-width`. */
  readonly widthPx: number;
  readonly lines: readonly string[];
  /** True when even the smallest size needs more than `maxLines`. */
  readonly overflow: boolean;
}

/**
 * The display size a headline can carry, and the width that balances it.
 *
 * Tries each size in the ladder, largest first, and keeps the first at which
 * the headline fits in `maxLines`. Then narrows the block until one more line
 * would be needed: that width is the one at which the lines come out most
 * even, which is what removes the orphan word CSS would otherwise leave on the
 * last line. Without a measurer, returns the largest size at the full width —
 * the fallback the browser balances itself with `text-wrap: balance`.
 */
export function fitHeadline(text: string, options: FitHeadlineOptions, measurer: Measurer | null): FittedHeadline {
  const largest = options.sizes[0] ?? 24;
  if (measurer === null || text.length === 0) {
    return { sizePx: largest, widthPx: options.maxWidthPx, lines: [text], overflow: false };
  }

  let chosen: { sizePx: number; measured: MeasuredLines } | null = null;
  for (const sizePx of options.sizes) {
    const measured = measurer.lines(text, { family: options.family, weight: options.weight, sizePx, leading: options.leading }, options.maxWidthPx);
    if (measured.lineCount <= options.maxLines) {
      chosen = { sizePx, measured };
      break;
    }
  }
  const overflow = chosen === null;
  if (chosen === null) {
    const sizePx = options.sizes[options.sizes.length - 1] ?? largest;
    chosen = { sizePx, measured: measurer.lines(text, { family: options.family, weight: options.weight, sizePx, leading: options.leading }, options.maxWidthPx) };
  }

  const font: Font = { family: options.family, weight: options.weight, sizePx: chosen.sizePx, leading: options.leading };
  const widthPx = balancedWidth(text, font, options.maxWidthPx, chosen.measured.lineCount, measurer);
  const lines = widthPx === options.maxWidthPx ? chosen.measured.lines : measurer.lines(text, font, widthPx).lines;
  return { sizePx: chosen.sizePx, widthPx, lines, overflow };
}

/**
 * The narrowest width at which `text` still takes `lineCount` lines.
 *
 * A single line is already balanced. Otherwise a binary search over the width
 * — the line count is monotone in it — to the pixel, so the last line is as
 * full as the others can make it.
 */
export function balancedWidth(text: string, font: Font, maxWidthPx: number, lineCount: number, measurer: Measurer): number {
  if (lineCount <= 1) return maxWidthPx;
  let low = Math.ceil(maxWidthPx / 2);
  let high = maxWidthPx;
  // Narrower than half would need more lines than we have, so the answer is in
  // [low, high]; if even `low` still fits, the search settles there.
  if (measurer.extent(text, font, low).lineCount > lineCount) {
    while (high - low > 1) {
      const mid = Math.floor((low + high) / 2);
      if (measurer.extent(text, font, mid).lineCount > lineCount) low = mid;
      else high = mid;
    }
    return high;
  }
  return low;
}

/* -------------------------------------------------------------------------- */
/*  Paragraph cuts                                                             */
/* -------------------------------------------------------------------------- */

export interface ParagraphCut {
  /** The text that fits: whole words, ending exactly where a line ends. */
  readonly shown: string;
  /** What follows it, or the empty string when everything fit. */
  readonly rest: string;
  readonly cut: boolean;
  readonly lineCount: number;
}

/**
 * The longest prefix of `text` that fits in `maxLines` and ends at a line
 * boundary. The browser, given the same font and width, breaks the prefix in
 * the same places, so the last line ends where the measurer said it would and
 * a "Continued" link follows a whole word.
 *
 * Without a measurer the cut is by characters at a word boundary — the
 * fallback a line clamp then tidies visually.
 */
export function cutAtLines(text: string, font: Font, maxWidthPx: number, maxLines: number, measurer: Measurer | null): ParagraphCut {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length === 0) return { shown: '', rest: '', cut: false, lineCount: 0 };

  if (measurer === null) {
    // Roughly `maxLines` lines of an average serif at this size.
    const perLine = Math.max(8, Math.floor(maxWidthPx / (font.sizePx * 0.48)));
    const budget = perLine * maxLines;
    if (flat.length <= budget) return { shown: flat, rest: '', cut: false, lineCount: Math.ceil(flat.length / perLine) };
    const space = flat.lastIndexOf(' ', budget);
    const at = space > 0 ? space : budget;
    return { shown: flat.slice(0, at).trim(), rest: flat.slice(at).trim(), cut: true, lineCount: maxLines };
  }

  const measured = measurer.lines(flat, font, maxWidthPx);
  if (measured.lineCount <= maxLines) return { shown: flat, rest: '', cut: false, lineCount: measured.lineCount };

  // Rebuild the prefix from the measured lines by walking the original text,
  // so no character is lost to trimming between lines.
  let consumed = 0;
  for (let index = 0; index < maxLines; index += 1) {
    const line = measured.lines[index] ?? '';
    const at = flat.indexOf(line, consumed);
    consumed = at === -1 ? consumed : at + line.length;
  }
  const shown = flat.slice(0, consumed).trim();
  const rest = flat.slice(consumed).trim();
  return { shown, rest, cut: rest.length > 0, lineCount: maxLines };
}

/* -------------------------------------------------------------------------- */
/*  Columns and heights                                                        */
/* -------------------------------------------------------------------------- */

/** Fewer lines than this in either column and a story reads better in one. */
export const MIN_COLUMN_LINES = 6;

/**
 * The narrowest a column may be, in ems of the body size: about thirty
 * characters of serif, the floor below which a line carries three words and a
 * paragraph reads as a list. At 16px that is 240px, so two columns never appear
 * inside a 350px phone sheet and do appear in a 600px side pane.
 */
export const MIN_COLUMN_EM = 15;

/**
 * One column or two. Two only when each column would be at least
 * `MIN_COLUMN_EM` wide and the text, set at that width, would give each column
 * at least `MIN_COLUMN_LINES` lines — a two-line second column, or two columns
 * three words wide, is a typographic accident, not a layout.
 */
export function columnsFor(text: string, font: Font, totalWidthPx: number, gapPx: number, measurer: Measurer | null): 1 | 2 {
  if (measurer === null) return 1;
  const columnWidth = Math.floor((totalWidthPx - gapPx) / 2);
  if (columnWidth < font.sizePx * MIN_COLUMN_EM) return 1;
  const { lineCount } = measurer.extent(text, font, columnWidth);
  return lineCount >= MIN_COLUMN_LINES * 2 ? 2 : 1;
}

/** The height a block of text takes at a width, or null without a measurer. */
export function heightOf(text: string, font: Font, maxWidthPx: number, measurer: Measurer | null): number | null {
  if (measurer === null || text.length === 0) return null;
  return measurer.extent(text, font, maxWidthPx).heightPx;
}
