'use client';

/**
 * One pill on the Connections picture: a supplier, a buyer, a market cell, an
 * agency, an empty slot.
 *
 * The whole pill is the target. The reference puts a small (i) button on each
 * pill for its details; at 130 points wide there is no room for a name, a
 * figure and a second control, so the (i) is dropped and tapping anywhere on
 * the pill does the one thing that pill is for — which is also the only thing
 * a thumb can do reliably at this size.
 *
 * Every point of the 130 is accounted for: 12 of padding, 20 of glyph and 4 of
 * gap (`PILL_CHROME`) leave about 94 for words, and 79 at a 360-point phone.
 * `model.ts` writes every figure and every detail to a character budget, and
 * this file spends what is left: `nameSizePx` and `rowSizePx` pick the largest
 * size at which the words this pill was actually handed fit the box this pill
 * actually has. Both are pure functions of a string and a width, so the server
 * and the browser pick the same size and a test can assert either without a
 * layout engine.
 *
 * `overflow-wrap: anywhere` is the backstop: a word that still does not fit
 * breaks with the clamp's ellipsis rather than running under the pill's edge.
 *
 * Absolutely positioned from the layout, so the SVG behind it and the pill in
 * front of it agree on where the wire lands to the point.
 */

import Link from 'next/link';
import { CompanyGlyph, Icon, SECTOR_TINT, companyTint, cx, sectorIcon } from '@/components/ui';
import type { LaidPill } from './layout';
import type { PillGlyph, PillModel } from './model';

export interface ConnectionPillProps {
  readonly pill: PillModel;
  readonly box: LaidPill;
  readonly onAct?: (action: NonNullable<PillModel['action']>) => void;
}

/** Border, ground and ink per state. Dashed says "not yet"; the loss tone says "not at all". */
const STATE_CLASS: Readonly<Record<LaidPill['state'], string>> = {
  live: 'border-solid border-hair-strong bg-panel text-ink',
  possible: 'border-dashed border-hair-strong bg-panel/70 text-ink-dim',
  // Solid, for the reason `layout.ts` gives the blocked *wire*: dashed means
  // "you could have this", which is the opposite of what blocked means. The
  // loss tone and the ground carry it instead.
  blocked: 'border-solid border-loss bg-loss-wash text-loss',
  empty: 'border-dashed border-hair-strong bg-raised text-ink-faint',
};

/* -------------------------------------------------------------------------- */
/*  How big the words are                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Padding, glyph, gap and border: what a pill spends before it draws a letter.
 *
 * Measured off the rendered pill, not derived from the classes: a 130-point
 * pill gives its words 92 points and a 115-point one gives 77.
 */
export const PILL_CHROME = 38;
/** The figure tag's own ground and the gap after it. */
export const TAG_CHROME = 10;
/**
 * One character as a fraction of the font size, measured off rendered pills.
 *
 * Names are semibold and mostly letters, so they run wider than a data row of
 * digits and short words. Both are upper bounds taken from the browser: at 10.5
 * points "Manufacturing" measured 92 of a 92-point box (0.674 a character) and
 * at 10 "evaluation" measured over 65 of a 65-point one (above 0.65), so 0.67
 * is the tightest value that is still true of both.
 */
export const NAME_CH = 0.67;
export const ROW_CH = 0.62;
/** Sizes a name may be drawn at, largest first; the last is the floor. */
export const NAME_SIZES: readonly number[] = [11.5, 10.5, 9.5, 8.5];
export const NESTED_NAME_SIZES: readonly number[] = [11, 10, 9, 8];
/** Sizes a data row may be drawn at. The last two are reached only at 360. */
export const ROW_SIZES: readonly number[] = [9, 8.5, 8, 7.5, 7];

/**
 * How many lines `text` takes at `size` in `width`, wrapped the way a browser
 * wraps it: greedily, word by word, breaking a word that cannot fit alone.
 *
 * Exact rather than a ratio, because the failure it replaces was a two-word
 * name whose *total* fitted two lines comfortably while its first word did not
 * fit one — "Manufacturing enterprises" in 77 points.
 */
export function lineCount(text: string, size: number, width: number): number {
  const ch = NAME_CH * size;
  let lines = 1;
  let used = 0;
  for (const word of text.split(/\s+/)) {
    if (word.length === 0) continue;
    const wide = word.length * ch;
    if (used === 0) used = wide;
    else if (used + ch + wide <= width) used += ch + wide;
    else {
      lines += 1;
      used = wide;
    }
    // A word wider than the whole line wraps inside itself, which costs a line
    // per overflowing width. `overflow-wrap: anywhere` is what makes it break
    // at all rather than run out under the pill's edge.
    if (used > width) {
      lines += Math.ceil(used / width) - 1;
      used = width;
    }
  }
  return lines;
}

/**
 * The largest size at which this name fits two lines of this pill.
 *
 * A name is cut two ways, and both are line-count failures: a word wider than
 * the box breaks mid-letter, and a string that needs three lines loses its last
 * word to the clamp — which is what turned "Kestrel Data Foundry" into
 * "Kestrel Data" and made four nested research pills all read "Lets you se…".
 *
 * The last size in the ladder is a floor, not a promise: a name longer than any
 * of them will fit falls back on `overflow-wrap: anywhere` and the clamp's own
 * ellipsis, which breaks it visibly rather than chopping it mid-letter.
 */
export function nameSizePx(name: string, pillWidth: number, nested: boolean): number {
  const width = Math.max(1, pillWidth - PILL_CHROME);
  const sizes = nested ? NESTED_NAME_SIZES : NAME_SIZES;
  for (const size of sizes) if (lineCount(name, size, width) <= 2) return size;
  return sizes[sizes.length - 1] ?? 8;
}

/** The largest size at which the figure tag and the words beside it fit one row. */
export function rowSizePx(figure: string | null, detail: string | null, pillWidth: number): number {
  const width = Math.max(1, pillWidth - PILL_CHROME) - (figure === null ? 0 : TAG_CHROME);
  const chars = (figure === null ? 0 : figure.length) + (detail === null ? 0 : detail.length);
  for (const size of ROW_SIZES) if (chars * ROW_CH * size <= width) return size;
  return ROW_SIZES[ROW_SIZES.length - 1] ?? 7;
}

/**
 * The ring's radius and stroke.
 *
 * 11 and 2 put its box at 26 points around a 20-point glyph, so it reaches 3
 * points either side — inside the pill's 6-point padding on one side and its
 * 4-point gap to the name on the other, which is what keeps a full ring off the
 * first letter of a company's name.
 */
const RING_R = 11;
const RING_STROKE = 2;
const RING_BOX = (RING_R + RING_STROKE) * 2;

/** Share of my output, drawn as an arc from the top. */
function Ring({ pct }: { readonly pct: number }): React.JSX.Element {
  const circumference = 2 * Math.PI * RING_R;
  const filled = (Math.min(100, Math.max(0, pct)) / 100) * circumference;
  return (
    <svg
      width={RING_BOX}
      height={RING_BOX}
      viewBox={`0 0 ${RING_BOX} ${RING_BOX}`}
      className="pointer-events-none absolute inset-0 m-auto"
      role="presentation"
      aria-hidden="true"
    >
      <circle cx={RING_BOX / 2} cy={RING_BOX / 2} r={RING_R} fill="none" stroke="var(--color-hair)" strokeWidth={RING_STROKE} />
      <circle
        cx={RING_BOX / 2}
        cy={RING_BOX / 2}
        r={RING_R}
        fill="none"
        stroke="var(--color-gain)"
        strokeWidth={RING_STROKE}
        strokeLinecap="round"
        strokeDasharray={`${filled} ${circumference}`}
        transform={`rotate(-90 ${RING_BOX / 2} ${RING_BOX / 2})`}
      />
    </svg>
  );
}

/** The 20-point mark: a company building, a sector disc, or a plain icon. */
function Glyph({ glyph }: { readonly glyph: PillGlyph }): React.JSX.Element {
  if (glyph.kind === 'company') return <CompanyGlyph tint={companyTint(glyph.archetype, glyph.own)} size="xs" />;
  if (glyph.kind === 'sector') {
    return (
      <span
        className="flex size-[20px] shrink-0 items-center justify-center rounded-pill"
        style={{ backgroundColor: `color-mix(in srgb, ${SECTOR_TINT[glyph.sector]} 18%, var(--color-panel))`, color: `color-mix(in srgb, ${SECTOR_TINT[glyph.sector]} 80%, var(--color-ink))` }}
      >
        <Icon name={sectorIcon(glyph.sector)} size={12} accent="current" />
      </span>
    );
  }
  return (
    <span className="flex size-[20px] shrink-0 items-center justify-center rounded-pill bg-raised text-ink-dim">
      <Icon name={glyph.name} size={12} accent="current" />
    </span>
  );
}

export function ConnectionPill({ pill, box, onAct }: ConnectionPillProps): React.JSX.Element {
  const rowSize = rowSizePx(pill.figure, pill.detail, box.width);
  const figure =
    pill.figure === null ? null : (
      <span className="figure shrink-0 rounded bg-raised px-[3px] leading-[13px] text-ink-dim">{pill.figure}</span>
    );
  const detail =
    pill.detail === null ? null : (
      <span data-testid="conn-pill-detail" className="min-w-0 flex-1 truncate">
        {pill.detail}
      </span>
    );

  const body = (
    <>
      <span className="relative flex size-[20px] shrink-0 items-center justify-center">
        <Glyph glyph={pill.glyph} />
        {pill.ringPct === null ? null : <Ring pct={pill.ringPct} />}
      </span>
      <span className="flex min-w-0 flex-1 flex-col justify-center gap-px">
        <span
          data-testid="conn-pill-name"
          className="line-clamp-2 font-semibold leading-[1.15] [overflow-wrap:anywhere]"
          style={{ fontSize: nameSizePx(pill.name, box.width, box.nested) }}
        >
          {pill.name}
        </span>
        {figure === null && detail === null ? null : (
          <span className="flex min-w-0 items-center gap-0.5 leading-tight text-ink-faint" style={{ fontSize: rowSize }}>
            {box.side === 'right' ? (
              <>
                {figure}
                {detail}
              </>
            ) : (
              <>
                {detail}
                {figure}
              </>
            )}
          </span>
        )}
      </span>
    </>
  );

  const style: React.CSSProperties = { left: box.x, top: box.y, width: box.width, height: box.height };
  const className = cx(
    'absolute flex items-center gap-1 overflow-hidden rounded-pill border px-1.5 text-left',
    STATE_CLASS[box.state],
    pill.action === null ? '' : 'transition-colors hover:bg-raised',
  );
  const data = {
    'data-testid': 'conn-pill',
    'data-side': box.side,
    'data-state': box.state,
    'data-key': pill.key,
  } as const;

  if (pill.action === null) {
    return (
      <div {...data} className={className} style={style} aria-label={pill.ariaLabel} role="img">
        {body}
      </div>
    );
  }

  if (pill.action.kind === 'href') {
    return (
      <Link {...data} href={pill.action.href} className={className} style={style} aria-label={pill.ariaLabel}>
        {body}
      </Link>
    );
  }

  const action = pill.action;
  return (
    <button {...data} type="button" className={className} style={style} aria-label={pill.ariaLabel} onClick={() => onAct?.(action)}>
      {body}
    </button>
  );
}
