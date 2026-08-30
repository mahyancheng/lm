'use client';

import type { ReactNode } from 'react';
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
 * A person, avatarless.
 *
 * The social and network surfaces are warm where the financial surfaces are
 * cool, but nobody has a photograph: initials, a name, a role, and whatever
 * standing the calling screen chooses to put on the right.
 */
export function PersonChip({ character, subtitle, right, onClick, size = 'md', className }: PersonChipProps): React.JSX.Element {
  const line = subtitle ?? character.title ?? character.role?.replace(/_/g, ' ') ?? null;
  const inner = (
    <>
      <span
        className={cx(
          'flex shrink-0 items-center justify-center rounded-full border font-semibold',
          character.isPlayer === true ? 'border-brand/40 bg-brand-wash text-brand' : 'border-hair bg-raised text-ink-dim',
          size === 'sm' ? 'size-6 text-[9px]' : 'size-8 text-[10px]',
        )}
      >
        {initialsOf(character.name)}
      </span>
      <span className="min-w-0 flex-1">
        <span className={cx('block truncate font-medium text-ink', size === 'sm' ? 'text-[11px]' : 'text-[12px]')}>{character.name}</span>
        {line !== null ? <span className="block truncate text-[10px] text-ink-faint">{line}</span> : null}
      </span>
      {right !== undefined ? <span className="shrink-0">{right}</span> : null}
    </>
  );

  const classes = cx('flex w-full min-w-0 items-center gap-2.5 text-left', className);
  if (onClick !== undefined) {
    return (
      <button type="button" onClick={onClick} className={cx(classes, 'rounded-[4px] px-1 py-1 transition-colors hover:bg-raised')}>
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

/** A company: ticker badge, name, and its sector or archetype. */
export function CompanyChip({ company, subtitle, right, onClick, own = false, size = 'md', className }: CompanyChipProps): React.JSX.Element {
  const badge = company.ticker ?? (company.name === undefined ? '??' : initialsOf(company.name));
  const line = subtitle ?? (company.sectorId ?? company.archetype)?.replace(/_/g, ' ') ?? null;

  const inner = (
    <>
      <span
        className={cx(
          'figure flex shrink-0 items-center justify-center rounded-[3px] border px-1',
          own ? 'border-brand/40 bg-brand-wash text-brand' : 'border-hair bg-raised text-ink-dim',
          size === 'sm' ? 'h-5 min-w-9 text-[9px]' : 'h-6 min-w-11 text-[10px]',
        )}
      >
        {badge}
      </span>
      <span className="min-w-0 flex-1">
        <span className={cx('block truncate font-medium text-ink', size === 'sm' ? 'text-[11px]' : 'text-[12px]')}>
          {company.name ?? 'Undisclosed'}
        </span>
        {line !== null ? <span className="block truncate text-[10px] text-ink-faint">{line}</span> : null}
      </span>
      {right !== undefined ? <span className="shrink-0">{right}</span> : null}
    </>
  );

  const classes = cx('flex w-full min-w-0 items-center gap-2.5 text-left', className);
  if (onClick !== undefined) {
    return (
      <button type="button" onClick={onClick} className={cx(classes, 'rounded-[4px] px-1 py-1 transition-colors hover:bg-raised')}>
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
      <span className="inline-block size-1.5 rounded-full bg-current" />
      {label}
    </span>
  );
}
