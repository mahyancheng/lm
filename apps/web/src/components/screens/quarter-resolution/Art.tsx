/**
 * Marks and illustration for the quarter-resolution sections.
 *
 * The **marks** are no longer drawn here: every heading takes a name from
 * `components/ui/icons.tsx`, so a section's mark is the same drawing the nav,
 * the empty states and the stat cards use, and there is exactly one place a
 * mark can change. What stays is `PodiumFigure` — a character, not an icon.
 */

import type { SectionId } from './sections';
import type { IconName, Tone } from '@/components/ui';

const INK = 'var(--color-ink-dim)';

export interface GlyphProps {
  readonly className?: string;
}

/** The tinted chip each section's mark sits in. */
export const SECTION_TONE: Readonly<Record<SectionId, Tone>> = {
  world: 'info',
  competition: 'warn',
  company: 'brand',
  markets: 'gain',
  rank: 'brand',
  ledger: 'neutral',
};

/**
 * The mark for each section of the report.
 *
 * Six sections, six different silhouettes, so the cards are told apart at a
 * glance while they pop in — the globe for the world, the network for the
 * rivals, your building, the tape, the trophy and the ledger page.
 */
export const SECTION_ICON: Readonly<Record<SectionId, IconName>> = {
  world: 'globe',
  competition: 'network',
  company: 'building',
  markets: 'chart',
  rank: 'trophy',
  ledger: 'ledger',
};

/** What each section's mark shows, for anything that needs to say it aloud. */
export const SECTION_ART: Readonly<Record<SectionId, string>> = {
  world: 'A globe',
  competition: 'A network of rivals',
  company: 'Your office building',
  markets: 'A rising price line',
  rank: 'A trophy',
  ledger: 'A stamped page',
};

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
