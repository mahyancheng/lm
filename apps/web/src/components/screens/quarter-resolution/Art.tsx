/**
 * Flat vector glyphs for the quarter-resolution sections.
 *
 * Solid fills, round caps, token colours only, 20×20 stages. They sit in the
 * tinted chip `Panel` draws left of its title, so they are decoration with a
 * job: telling the five sections apart at a glance while the cards pop in.
 */

import type { SectionId } from './sections';
import type { Tone } from '@/components/ui';

const INK = 'var(--color-ink-dim)';

export interface GlyphProps {
  readonly className?: string;
}

/** The tinted chip each section's glyph sits in. */
export const SECTION_TONE: Readonly<Record<SectionId, Tone>> = {
  world: 'info',
  competition: 'warn',
  company: 'brand',
  markets: 'gain',
  rank: 'brand',
  ledger: 'neutral',
};

export const SECTION_ART: Readonly<Record<SectionId, string>> = {
  world: 'A globe',
  competition: 'Two rival towers',
  company: 'Your office building',
  markets: 'A rising price line',
  rank: 'A podium',
  ledger: 'A stamped page',
};

/** The glyph for one section of the report. */
export function SectionGlyph({ id }: { readonly id: SectionId }): React.JSX.Element {
  switch (id) {
    case 'world':
      return <GlobeGlyph />;
    case 'competition':
      return <RivalsGlyph />;
    case 'company':
      return <OfficeGlyph />;
    case 'markets':
      return <TapeGlyph />;
    case 'rank':
      return <PodiumGlyph />;
    default:
      return <LedgerGlyph />;
  }
}

function Stage({ label, children }: { readonly label: string; readonly children: React.ReactNode }): React.JSX.Element {
  return (
    <svg viewBox="0 0 20 20" className="size-4" role="img" aria-label={label}>
      {children}
    </svg>
  );
}

export function GlobeGlyph(): React.JSX.Element {
  return (
    <Stage label="A globe">
      <circle cx="10" cy="10" r="7.2" fill="currentColor" opacity="0.18" />
      <circle cx="10" cy="10" r="7.2" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <path d="M2.8 10h14.4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <path d="M10 2.8c2.6 2 2.6 12.4 0 14.4-2.6-2-2.6-12.4 0-14.4Z" fill="none" stroke="currentColor" strokeWidth="1.4" />
    </Stage>
  );
}

export function RivalsGlyph(): React.JSX.Element {
  return (
    <Stage label="Two rival towers">
      <rect x="2.5" y="7" width="6" height="10.5" rx="2" fill="currentColor" opacity="0.35" />
      <rect x="11.5" y="3.5" width="6" height="14" rx="2" fill="currentColor" />
      <rect x="13" y="6" width="3" height="2" rx="1" fill="var(--color-panel)" />
      <rect x="13" y="10" width="3" height="2" rx="1" fill="var(--color-panel)" />
    </Stage>
  );
}

export function OfficeGlyph(): React.JSX.Element {
  return (
    <Stage label="Your office building">
      <rect x="3" y="5" width="14" height="12.5" rx="2.4" fill="currentColor" />
      <rect x="2" y="2.6" width="16" height="2.6" rx="1.3" fill="currentColor" opacity="0.55" />
      <g fill="var(--color-panel)">
        <rect x="5.5" y="8" width="3" height="2.4" rx="1" />
        <rect x="11.5" y="8" width="3" height="2.4" rx="1" />
        <rect x="5.5" y="12.4" width="3" height="2.4" rx="1" />
        <rect x="11.5" y="12.4" width="3" height="2.4" rx="1" />
      </g>
    </Stage>
  );
}

export function TapeGlyph(): React.JSX.Element {
  return (
    <Stage label="A rising price line">
      <path
        d="M3 14.5 7 10l3 2.6 4.5-6.6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M12.4 5.4h4.2v4.2" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </Stage>
  );
}

export function PodiumGlyph(): React.JSX.Element {
  return (
    <Stage label="A podium">
      <rect x="7.5" y="4.5" width="5" height="13" rx="1.6" fill="currentColor" />
      <rect x="1.5" y="9" width="5" height="8.5" rx="1.6" fill="currentColor" opacity="0.5" />
      <rect x="13.5" y="11.5" width="5" height="6" rx="1.6" fill="currentColor" opacity="0.32" />
    </Stage>
  );
}

export function LedgerGlyph(): React.JSX.Element {
  return (
    <Stage label="A stamped page">
      <rect x="4" y="2.5" width="12" height="15" rx="2.2" fill="currentColor" opacity="0.22" />
      <rect x="4" y="2.5" width="12" height="15" rx="2.2" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M6.8 7h6.4M6.8 10h4.6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <circle cx="12.6" cy="13.4" r="2.4" fill="none" stroke="currentColor" strokeWidth="1.4" />
    </Stage>
  );
}

/**
 * The little person who stands on the tallest podium step.
 *
 * Round head, flat hair, pill body — the house cartoon. Nothing about them
 * varies: there is exactly one of them, and they are the player.
 */
export function PodiumFigure({ className }: GlyphProps): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 30" className={className} role="img" aria-label="You, on the podium">
      <rect x="6" y="13" width="12" height="16" rx="5" fill="var(--color-cloth-suit)" />
      <circle cx="12" cy="8" r="6" fill="var(--color-skin-2)" />
      <path d="M6 7a6 6 0 0 1 12 0c-2-2.2-4-2.9-6-2.9S8 4.8 6 7Z" fill="var(--color-hair-2)" />
      <circle cx="9.8" cy="8.4" r="0.95" fill={INK} />
      <circle cx="14.2" cy="8.4" r="0.95" fill={INK} />
      <path d="M10 11.2c1.4 1.3 2.6 1.3 4 0" fill="none" stroke={INK} strokeWidth="1" strokeLinecap="round" />
    </svg>
  );
}
