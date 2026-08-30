'use client';

import type { ReactNode } from 'react';
import { Portrait } from '@/components/scenes/people/Portrait';
import type { PortraitMood } from '@/components/scenes/people/look';
import { cx, type Tone } from './tokens';

/* -------------------------------------------------------------------------- */
/*  People                                                                     */
/* -------------------------------------------------------------------------- */

/** The subset of `Character` a chip needs. A full `Character` satisfies it. */
export interface PersonLike {
  readonly id: string;
  readonly name: string;
  readonly title?: string | null;
  readonly role?: string;
  readonly connectionLevel?: number;
  readonly isPlayer?: boolean;
}

export interface PersonChipProps {
  readonly character: PersonLike;
  /** Overrides the character's own title line. */
  readonly subtitle?: ReactNode;
  /** Right-aligned slot: a connection level, a vote, an access badge. */
  readonly right?: ReactNode;
  readonly onClick?: () => void;
  readonly size?: 'sm' | 'md';
  /**
   * The expression, when the calling screen knows one — a relationship, a
   * morale score, a director's stance. Additive: a chip without it is a
   * pleasant, uncommitted face rather than a guess.
   */
  readonly mood?: PortraitMood;
  /** A coloured ring around the portrait: a stance, an access state. */
  readonly ring?: Tone;
  readonly className?: string;
}

/** Initials from a name: "Maya Chen" becomes "MC". Deterministic, no images. */
export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '??';
  if (parts.length === 1) return (parts[0] ?? '').slice(0, 2).toUpperCase();
  return `${(parts[0] ?? '').charAt(0)}${(parts[parts.length - 1] ?? '').charAt(0)}`.toUpperCase();
}

/**
 * A person, with their face.
 *
 * The portrait is derived from the character's id and role through
 * `fnv1a64` — the same derivation the boardroom and the people web draw at
 * larger sizes — so the person you tapped in a table is recognisably the person
 * sitting at the table two screens later. It is marked decorative here: the name
 * is right beside it, and a screen reader should not hear it twice.
 */
export function PersonChip({
  character,
  subtitle,
  right,
  onClick,
  size = 'md',
  mood,
  ring,
  className,
}: PersonChipProps): React.JSX.Element {
  const line = subtitle ?? character.title ?? character.role?.replace(/_/g, ' ') ?? null;
  const inner = (
    <>
      <Portrait
        characterId={character.id}
        role={character.role}
        size={size === 'sm' ? 'sm' : 'md'}
        mood={mood}
        ring={ring}
        isPlayer={character.isPlayer === true}
        decorative
      />
      <span className="min-w-0 flex-1">
        <span className={cx('block truncate font-semibold text-ink', size === 'sm' ? 'text-[11px]' : 'text-[12px]')}>{character.name}</span>
        {line !== null ? <span className="block truncate text-[10px] text-ink-faint">{line}</span> : null}
      </span>
      {right !== undefined ? <span className="shrink-0">{right}</span> : null}
    </>
  );

  const classes = cx('flex w-full min-w-0 items-center gap-2.5 text-left', className);
  if (onClick !== undefined) {
    return (
      <button type="button" onClick={onClick} className={cx(classes, 'rounded-chip px-1 py-1 transition-colors hover:bg-raised')}>
        {inner}
      </button>
    );
  }
  return <div className={classes}>{inner}</div>;
}

/* -------------------------------------------------------------------------- */
/*  Companies                                                                  */
/* -------------------------------------------------------------------------- */

/** The subset of `Company` a chip needs. A full or redacted `Company` satisfies it. */
export interface CompanyLike {
  readonly id?: string;
  readonly name?: string;
  readonly ticker?: string | null;
  readonly sectorId?: string;
  readonly archetype?: string;
  readonly isPublic?: boolean;
}

export interface CompanyChipProps {
  readonly company: CompanyLike;
  /** Overrides the derived second line. */
  readonly subtitle?: ReactNode;
  readonly right?: ReactNode;
  readonly onClick?: () => void;
  /** Mark this as the player's own company. */
  readonly own?: boolean;
  readonly size?: 'sm' | 'md';
  readonly className?: string;
}

/**
 * The tint for a company glyph, by archetype.
 *
 * The pastels mean *different from each other* and nothing more — a chip maker
 * is teal because a cloud is sky, not because teal means anything about silicon.
 * A company whose archetype is redacted draws in the neutral building roof.
 */
const ARCHETYPE_TINT: Readonly<Record<string, string>> = {
  frontier_lab: 'var(--color-pop-5)',
  enterprise_ai: 'var(--color-pop-1)',
  consumer_ai: 'var(--color-pop-3)',
  infrastructure: 'var(--color-pop-4)',
  chip_maker: 'var(--color-pop-2)',
  cloud: 'var(--color-pop-8)',
  data: 'var(--color-pop-6)',
  defence_ai: 'var(--color-pop-7)',
};

/**
 * A company, as a flat isometric-lite building.
 *
 * Two volumes, two tones, glass rectangles for windows — the same drawing
 * language as the world map and the office, at 24px. The tint carries the
 * archetype; the player's own company gets the brand.
 */
function CompanyGlyph({ tint, size }: { readonly tint: string; readonly size: 'sm' | 'md' }): React.JSX.Element {
  const px = size === 'sm' ? 22 : 28;
  return (
    <svg
      viewBox="0 0 32 32"
      width={px}
      height={px}
      className="block shrink-0"
      role="presentation"
      aria-hidden="true"
      style={{ '--fc-tint': tint } as React.CSSProperties}
    >
      <rect x="0" y="0" width="32" height="32" rx="9" fill="color-mix(in srgb, var(--fc-tint) 14%, var(--color-panel))" />
      {/* the short volume, behind */}
      <rect x="5" y="15" width="9" height="13" rx="2" fill="var(--color-build-side)" />
      <rect x="7.4" y="18" width="4.2" height="2.6" rx="0.8" fill="var(--color-build-glass)" />
      {/* the tall volume, tinted by archetype */}
      <rect x="14" y="7" width="13" height="21" rx="2.6" fill="var(--fc-tint)" />
      <rect x="14" y="7" width="13" height="3.4" rx="1.7" fill="color-mix(in srgb, var(--color-panel) 34%, var(--fc-tint))" />
      <g fill="var(--color-build-glass)">
        <rect x="16.6" y="13" width="3.4" height="2.6" rx="0.8" />
        <rect x="21.2" y="13" width="3.4" height="2.6" rx="0.8" />
        <rect x="16.6" y="18" width="3.4" height="2.6" rx="0.8" />
        <rect x="21.2" y="18" width="3.4" height="2.6" rx="0.8" />
      </g>
      <rect x="4" y="27.4" width="24" height="1.8" rx="0.9" fill="var(--color-ground)" />
    </svg>
  );
}

/** A company: a flat building glyph tinted by archetype, its name, its ticker. */
export function CompanyChip({ company, subtitle, right, onClick, own = false, size = 'md', className }: CompanyChipProps): React.JSX.Element {
  const tint = own ? 'var(--color-brand)' : (ARCHETYPE_TINT[company.archetype ?? ''] ?? 'var(--color-build-roof)');
  const line = subtitle ?? (company.sectorId ?? company.archetype)?.replace(/_/g, ' ') ?? null;

  const inner = (
    <>
      <CompanyGlyph tint={tint} size={size} />
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-baseline gap-1.5">
          <span className={cx('truncate font-semibold text-ink', size === 'sm' ? 'text-[11px]' : 'text-[12px]')}>
            {company.name ?? 'Undisclosed'}
          </span>
          {company.ticker === null || company.ticker === undefined ? null : (
            <span className={cx('figure shrink-0 text-[10px]', own ? 'text-brand' : 'text-ink-faint')}>{company.ticker}</span>
          )}
        </span>
        {line !== null ? <span className="block truncate text-[10px] text-ink-faint">{line}</span> : null}
      </span>
      {right !== undefined ? <span className="shrink-0">{right}</span> : null}
    </>
  );

  const classes = cx('flex w-full min-w-0 items-center gap-2.5 text-left', className);
  if (onClick !== undefined) {
    return (
      <button type="button" onClick={onClick} className={cx(classes, 'rounded-chip px-1 py-1 transition-colors hover:bg-raised')}>
        {inner}
      </button>
    );
  }
  return <div className={classes}>{inner}</div>;
}

/* -------------------------------------------------------------------------- */
/*  Access                                                                     */
/* -------------------------------------------------------------------------- */

export interface AccessBadgeProps {
  /** `open` reachable now, `override` reachable through an active override, `blocked` gap-blocked. */
  readonly state: 'open' | 'override' | 'blocked';
  /** The connection gap, shown when blocked. */
  readonly gap?: number;
  readonly className?: string;
}

/**
 * On any character surface: reachable, reachable via override, or gap-blocked
 * with the gap shown. Never hide the reason contact is refused — the gap is the
 * game.
 */
export function AccessBadge({ state, gap, className }: AccessBadgeProps): React.JSX.Element {
  const tone: Tone = state === 'open' ? 'gain' : state === 'override' ? 'info' : 'warn';
  const label = state === 'open' ? 'Reachable' : state === 'override' ? 'Via override' : gap === undefined ? 'Out of reach' : `Gap ${gap}`;
  return (
    <span className={cx('inline-flex items-center gap-1 text-[10px]', `tone-${tone}`, className)}>
      <span className="inline-block size-1.5 rounded-pill bg-current" />
      {label}
    </span>
  );
}
