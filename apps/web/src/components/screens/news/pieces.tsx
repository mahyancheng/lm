'use client';

/**
 * The small type the whole paper is set in: the kicker above a headline, the
 * byline under it, the rule between sections. One rendering of each, so the
 * lead, the second tier, the briefs and the full article agree on every detail.
 */

import { memo } from 'react';
import type { PublicRecordItem, PublicRecordKind, Sector } from '@frontier/contracts';
import { AiLabel, Icon, IconChip, cx, sectorLabel, type IconName, type PersonLike, type Tone } from '@/components/ui';
import { Portrait } from '@/components/scenes/people/Portrait';

/* -------------------------------------------------------------------------- */
/*  Context                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * What every piece of the paper shares — built once per screen from the same
 * state the projection came from, the way `FeedContext` is for the feed.
 */
export interface NewsContext {
  readonly startYear: number;
  readonly characters: ReadonlyMap<string, PersonLike>;
  readonly companyNames: ReadonlyMap<string, string>;
  /** Draw the sector in a kicker at all. False in a one-sector world. */
  readonly multiSector: boolean;
  readonly playerCharacterId: string;
  readonly playerCompanyId: string;
  /** Headlines by id — this edition's and every other's — so "Follows:" reads as a sentence. */
  readonly headlineOf: (id: string) => string | null;
  /** Open an item in full. */
  readonly onOpen: (item: PublicRecordItem) => void;
}

/** Is this the reader's own line? The one distinction the paper draws, and it is a kicker, not a section. */
export function isOwn(item: PublicRecordItem, context: Pick<NewsContext, 'playerCharacterId' | 'playerCompanyId'>): boolean {
  if (item.who.characterId !== null && item.who.characterId === context.playerCharacterId) return true;
  return item.who.companyId !== null && item.who.companyId === context.playerCompanyId;
}

/* -------------------------------------------------------------------------- */
/*  Kinds                                                                      */
/* -------------------------------------------------------------------------- */

/** The mark for an item with no face: a shock, a story, a filing, a voice, an answer. */
export const KIND_ICON: Readonly<Record<PublicRecordKind, IconName>> = {
  event: 'warning',
  story: 'newspaper',
  disclosure: 'stamp',
  post: 'chat',
  reply: 'chat',
};

export const KIND_TONE: Readonly<Record<PublicRecordKind, Tone>> = {
  event: 'warn',
  story: 'info',
  disclosure: 'neutral',
  post: 'brand',
  reply: 'brand',
};

/* -------------------------------------------------------------------------- */
/*  Kicker                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The words above a headline: "LOGISTICS · HARBOURLINE · EARNINGS", or
 * "YOU · PRESS RELEASE" on the reader's own. `compact` drops the company —
 * for a half-width column, where a long name would wrap the kicker to three
 * lines and the byline names the company anyway.
 */
export function kickerParts(
  item: PublicRecordItem,
  context: Pick<NewsContext, 'multiSector' | 'playerCharacterId' | 'playerCompanyId'>,
  compact = false,
): string[] {
  const parts: string[] = [];
  if (isOwn(item, context)) parts.push('You');
  if (context.multiSector && item.kicker.sector !== null) parts.push(kickerSectorLabel(item.kicker.sector));
  if (!compact && item.kicker.company !== null) parts.push(item.kicker.company);
  parts.push(item.kicker.word);
  return parts;
}

/**
 * The sector word in a kicker. The app's short label for the AI sector is
 * "AI", which sits twenty pixels from the blue "AI" pill that marks a
 * model-written line and means something else; the kicker spells it out.
 */
export function kickerSectorLabel(sector: Sector): string {
  return sector === 'ai' ? 'AI models' : sectorLabel(sector);
}

export const Kicker = memo(function Kicker({
  item,
  context,
  compact = false,
  className,
}: {
  readonly item: PublicRecordItem;
  readonly context: NewsContext;
  readonly compact?: boolean;
  readonly className?: string;
}): React.JSX.Element {
  const own = isOwn(item, context);
  return (
    <p className={cx('np-kicker flex min-w-0 flex-wrap items-center gap-x-1.5', own && 'text-brand', className)}>
      {kickerParts(item, context, compact).map((part, index) => (
        <span key={`${part}-${index}`} className="inline-flex items-center gap-1.5">
          {index === 0 ? null : <span aria-hidden="true">·</span>}
          <span className={cx(index === 0 && own ? 'text-brand' : '')}>{part}</span>
        </span>
      ))}
    </p>
  );
});

/* -------------------------------------------------------------------------- */
/*  Byline                                                                     */
/* -------------------------------------------------------------------------- */

export const Byline = memo(function Byline({
  item,
  context,
  size = 'sm',
  className,
}: {
  readonly item: PublicRecordItem;
  readonly context: NewsContext;
  readonly size?: 'sm' | 'md';
  readonly className?: string;
}): React.JSX.Element {
  const character = item.who.characterId === null ? null : (context.characters.get(item.who.characterId) ?? null);
  const companyName = item.who.companyId === null ? null : (context.companyNames.get(item.who.companyId) ?? null);
  // A person's byline: the face and the name. The wire, the world or a company
  // speaking for itself: the kind's mark and the name the projection chose.
  return (
    <div className={cx('flex min-w-0 items-center gap-2', className)} data-testid="byline">
      {character === null ? (
        <IconChip name={KIND_ICON[item.kind]} tone={KIND_TONE[item.kind]} size={size === 'md' ? 'md' : 'sm'} />
      ) : (
        <Portrait characterId={character.id} role={character.role} size="sm" isPlayer={character.isPlayer === true} decorative />
      )}
      <p className="min-w-0 flex-1 truncate text-[11.5px] leading-tight text-ink-dim">
        <span className="font-semibold text-ink">{item.who.name}</span>
        {companyName !== null && companyName !== item.who.name ? <span> · {companyName}</span> : null}
        {item.kind === 'story' && item.who.characterId !== null ? <span> · The Frontier Ledger</span> : null}
      </p>
      {item.who.isAi ? <AiLabel /> : null}
    </div>
  );
});

/* -------------------------------------------------------------------------- */
/*  Rules and section heads                                                    */
/* -------------------------------------------------------------------------- */

/** A small-caps section head over a rule: "IN BRIEF", "EARLIER EDITIONS". */
export function SectionRule({ children, right, className }: { readonly children: React.ReactNode; readonly right?: React.ReactNode; readonly className?: string }): React.JSX.Element {
  return (
    <div className={cx('np-rule-heavy flex items-center justify-between gap-3 pt-1.5', className)}>
      <h2 className="np-kicker text-ink">{children}</h2>
      {right === undefined ? null : <div className="np-kicker">{right}</div>}
    </div>
  );
}

/** "For you: your demand -6% this quarter" — the whole-number consequence, when there is one. */
export function ForYou({ text, className }: { readonly text: string | null; readonly className?: string }): React.JSX.Element | null {
  if (text === null) return null;
  return (
    <p className={cx('flex items-start gap-1.5 text-[11.5px] leading-snug font-semibold text-brand', className)}>
      <Icon name="gauge" size={13} accent="current" />
      <span className="min-w-0">{text}</span>
    </p>
  );
}
