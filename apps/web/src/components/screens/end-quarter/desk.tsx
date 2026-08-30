'use client';

/**
 * The signing desk.
 *
 * End Quarter is the one screen where a player commits: presentation here is
 * paper, not chrome. A queued instruction is a **document** — a white sheet with
 * a folded corner and a stamp; a warning is a **sticky note** pressed onto the
 * desk; and the submission is a **seal**, a big round stamp you press.
 *
 * Everything in this file is presentation. The seal is an ordinary `<button>`
 * that does exactly what the old text button did — it opens the confirmation
 * dialog and nothing else. The double confirmation, the typed word and the
 * blocked-action gate all still live on the screen, where they belong.
 */

import type { ReactNode } from 'react';
import { cx, type Tone } from '@/components/ui';

/* -------------------------------------------------------------------------- */
/*  Paper                                                                      */
/* -------------------------------------------------------------------------- */

export interface PaperSheetProps {
  readonly children: ReactNode;
  /** A coloured spine down the left edge: the document's verdict. */
  readonly tone?: Tone;
  readonly className?: string;
  readonly style?: React.CSSProperties;
}

/**
 * One document on the desk: a white sheet, a hairline, a folded top corner and
 * a tinted spine carrying the validator's verdict.
 */
export function PaperSheet({ children, tone = 'neutral', className, style }: PaperSheetProps): React.JSX.Element {
  return (
    <div
      className={cx(
        'animate-pop-in hover-lift relative overflow-hidden rounded-card border bg-panel shadow-card',
        tone === 'loss' ? 'border-loss/35' : tone === 'warn' ? 'border-warn/35' : tone === 'gain' ? 'border-gain/30' : 'border-hair',
        className,
      )}
      style={style}
    >
      <span
        aria-hidden="true"
        className={cx(
          'absolute inset-y-0 left-0 w-1',
          tone === 'loss' ? 'bg-loss' : tone === 'warn' ? 'bg-warn' : tone === 'gain' ? 'bg-gain' : 'bg-hair-strong',
        )}
      />
      <CornerFold />
      <div className="pl-3">{children}</div>
    </div>
  );
}

function CornerFold(): React.JSX.Element {
  return (
    <svg viewBox="0 0 20 20" className="pointer-events-none absolute top-0 right-0 size-5" aria-hidden="true">
      <path d="M20 0 0 0l20 20Z" fill="var(--color-raised)" />
      <path d="M20 20 0 0" stroke="var(--color-hair-strong)" strokeWidth="1" />
    </svg>
  );
}

/* -------------------------------------------------------------------------- */
/*  Sticky notes                                                               */
/* -------------------------------------------------------------------------- */

export interface StickyNoteProps {
  readonly children: ReactNode;
  readonly tone?: Extract<Tone, 'warn' | 'loss' | 'info' | 'brand'>;
  /** Alternate the lean so a stack of notes does not look printed. */
  readonly lean?: 'left' | 'right';
  readonly title?: string;
}

/** A note pressed onto the desk. Square-ish, tinted, very slightly askew. */
export function StickyNote({ children, tone = 'warn', lean = 'left', title }: StickyNoteProps): React.JSX.Element {
  return (
    <div
      className={cx(
        'relative rounded-card border px-3 py-2.5 shadow-card',
        lean === 'left' ? 'rotate-[-0.7deg]' : 'rotate-[0.6deg]',
        tone === 'loss'
          ? 'border-loss/30 bg-loss-wash'
          : tone === 'warn'
            ? 'border-warn/30 bg-warn-wash'
            : tone === 'info'
              ? 'border-info/30 bg-info-wash'
              : 'border-brand/30 bg-brand-wash',
      )}
    >
      <span
        aria-hidden="true"
        className={cx(
          'absolute -top-1 left-1/2 h-2 w-9 -translate-x-1/2 rounded-pill opacity-70',
          tone === 'loss' ? 'bg-loss/40' : tone === 'warn' ? 'bg-warn/40' : tone === 'info' ? 'bg-info/40' : 'bg-brand/40',
        )}
      />
      {title === undefined ? null : (
        <div
          className={cx(
            'label-caps mb-1',
            tone === 'loss' ? 'text-loss' : tone === 'warn' ? 'text-warn' : tone === 'info' ? 'text-info' : 'text-brand',
          )}
        >
          {title}
        </div>
      )}
      <div className="text-[11px] leading-relaxed text-ink-dim">{children}</div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  The seal                                                                   */
/* -------------------------------------------------------------------------- */

export interface SealStampProps {
  /** Word stamped across the middle, e.g. the quarter label. */
  readonly quarter: string;
  readonly disabled: boolean;
  readonly busy: boolean;
  readonly onPress: () => void;
  /** The accessible description of what pressing it does. */
  readonly ariaLabel: string;
}

/**
 * The commitment: a big round seal you press.
 *
 * It is a plain `<button>` — focusable, Enter/Space operable, 132px across, far
 * past the 44px floor — and pressing it opens the confirmation dialog exactly
 * as the old text button did. Nothing about the gate lives in here.
 */
export function SealStamp({ quarter, disabled, busy, onPress, ariaLabel }: SealStampProps): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onPress}
      disabled={disabled}
      aria-label={ariaLabel}
      className={cx(
        'press-pop group relative flex size-[132px] shrink-0 items-center justify-center rounded-pill transition-[box-shadow,opacity] focus-visible:outline-2',
        disabled ? 'cursor-not-allowed opacity-45' : 'cursor-pointer hover:shadow-float',
      )}
    >
      <svg viewBox="0 0 132 132" className="absolute inset-0 size-full" aria-hidden="true">
        <circle cx="66" cy="66" r="64" fill="var(--color-brand-wash)" />
        <circle cx="66" cy="66" r="58" fill="var(--color-brand-strong)" />
        <circle cx="66" cy="66" r="50" fill="none" stroke="var(--color-panel)" strokeWidth="1.6" strokeOpacity="0.55" />
        <circle cx="66" cy="66" r="46" fill="none" stroke="var(--color-panel)" strokeWidth="1" strokeOpacity="0.35" strokeDasharray="2 5" />
        {NOTCHES.map((angle) => (
          <rect
            key={angle}
            x="65"
            y="1"
            width="2"
            height="6"
            rx="1"
            fill="var(--color-brand-strong)"
            transform={`rotate(${angle} 66 66)`}
          />
        ))}
      </svg>
      <span className="relative flex flex-col items-center gap-0.5 text-center">
        <span className="text-[10px] font-bold tracking-[0.22em] text-white uppercase">Resolve</span>
        <span className="figure text-[15px] leading-none font-bold text-white">{quarter}</span>
        <span className="text-[9px] font-semibold tracking-[0.16em] text-white/85 uppercase">{busy ? 'Working' : 'Press to seal'}</span>
      </span>
    </button>
  );
}

/** Twenty-four evenly spaced notches around the seal's rim. Fixed, not random. */
const NOTCHES: readonly number[] = Array.from({ length: 24 }, (_, index) => index * 15);

/* -------------------------------------------------------------------------- */
/*  Desk furniture                                                             */
/* -------------------------------------------------------------------------- */

/** A flat vector desk: the vignette above the seal. */
export function DeskScene({ className }: { readonly className?: string }): React.JSX.Element {
  return (
    <svg viewBox="0 0 120 64" className={className} role="img" aria-label="A signing desk with documents, a pen and an ink pad">
      <rect x="0" y="40" width="120" height="10" rx="5" fill="var(--color-build-side)" />
      <rect x="10" y="50" width="6" height="12" rx="3" fill="var(--color-build-roof)" />
      <rect x="104" y="50" width="6" height="12" rx="3" fill="var(--color-build-roof)" />
      <g className="animate-bob-slow">
        <rect x="20" y="12" width="34" height="26" rx="5" fill="var(--color-panel)" stroke="var(--color-hair-strong)" strokeWidth="1.4" />
        <rect x="26" y="18" width="22" height="2.4" rx="1.2" fill="var(--color-hair)" />
        <rect x="26" y="24" width="18" height="2.4" rx="1.2" fill="var(--color-hair)" />
        <rect x="26" y="30" width="13" height="2.4" rx="1.2" fill="var(--color-hair)" />
      </g>
      <rect x="58" y="18" width="30" height="20" rx="5" fill="var(--color-panel)" stroke="var(--color-hair)" strokeWidth="1.2" />
      <circle cx="94" cy="28" r="9" fill="var(--color-brand-wash)" stroke="var(--color-brand)" strokeWidth="2" />
      <circle cx="94" cy="28" r="3.4" fill="var(--color-brand)" />
      <path d="M6 36 16 16l4 2.4-10 20-5 2.6Z" fill="var(--color-ink)" opacity="0.7" />
    </svg>
  );
}

/** A small flat glyph for a document group. */
export function FolderGlyph(): React.JSX.Element {
  return (
    <svg viewBox="0 0 20 20" className="size-4" role="img" aria-label="A folder of documents">
      <path d="M2.5 5.5A1.6 1.6 0 0 1 4.1 4h3.5l1.6 1.9h6.7a1.6 1.6 0 0 1 1.6 1.6v7A1.6 1.6 0 0 1 15.9 16H4.1a1.6 1.6 0 0 1-1.6-1.6Z" fill="currentColor" />
      <rect x="5.5" y="8.4" width="9" height="1.6" rx="0.8" fill="var(--color-panel)" />
      <rect x="5.5" y="11.4" width="6" height="1.6" rx="0.8" fill="var(--color-panel)" />
    </svg>
  );
}

/** A small flat glyph for the cash column. */
export function CoinGlyph(): React.JSX.Element {
  return (
    <svg viewBox="0 0 20 20" className="size-4" role="img" aria-label="A stack of coins">
      <ellipse cx="10" cy="6" rx="6.5" ry="2.8" fill="currentColor" />
      <path d="M3.5 6v4c0 1.55 2.91 2.8 6.5 2.8s6.5-1.25 6.5-2.8V6" fill="currentColor" opacity="0.55" />
      <path d="M3.5 10.5V14c0 1.55 2.91 2.8 6.5 2.8s6.5-1.25 6.5-2.8v-3.5" fill="currentColor" opacity="0.32" />
    </svg>
  );
}

/** A small flat glyph for the pipeline column. */
export function PipelineGlyph(): React.JSX.Element {
  return (
    <svg viewBox="0 0 20 20" className="size-4" role="img" aria-label="A pipeline of stages">
      <circle cx="4" cy="10" r="2.6" fill="currentColor" />
      <circle cx="10" cy="10" r="2.6" fill="currentColor" opacity="0.6" />
      <circle cx="16" cy="10" r="2.6" fill="currentColor" opacity="0.32" />
    </svg>
  );
}

/** A small flat glyph for the board column. */
export function GavelGlyph(): React.JSX.Element {
  return (
    <svg viewBox="0 0 20 20" className="size-4" role="img" aria-label="A gavel">
      <rect x="2.5" y="14.5" width="15" height="2.6" rx="1.3" fill="currentColor" />
      <rect x="8.4" y="3" width="3.2" height="10" rx="1.6" fill="currentColor" transform="rotate(-35 10 8)" />
      <rect x="10.5" y="2.4" width="7" height="4.6" rx="2.3" fill="currentColor" transform="rotate(-35 14 4.7)" />
    </svg>
  );
}
